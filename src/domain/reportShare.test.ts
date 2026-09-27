import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { accountStore, closeAccountDatabase } from '../../server/accountStore';
import { handleReportShare, prepareReportShare, publicReportOrigin, REPORT_PDF_LIMIT } from '../../server/reportShare';
import { demoProject, demoSpace, demoVendor } from './seed';
import { makeSnapshot } from './version';

let temp: string, path: string;
let env: Record<string, string>;
const pdf = Buffer.from('%PDF-1.7\nsynthetic test bytes\n%%EOF').toString('base64');
beforeEach(async () => {
  temp = mkdtempSync(join(tmpdir(), 'pop3d-report-share-')); path = join(temp, 'accounts.sqlite');
  env = { POP3D_ACCOUNT_DB: path, KAKAO_REDIRECT_URI: 'https://pop3-d.vercel.app/api/auth/kakao/callback' };
  const db = accountStore(env);
  await db.createUser('owner', 'report-owner', 'synthetic');
  await db.createUser('other', 'report-other', 'synthetic');
  const space = demoSpace(), vendor = demoVendor(), project = demoProject(space, vendor);
  project.name = '공유 테스트 기획안';
  project.versions = [makeSnapshot(project, space, vendor)];
  await db.saveWorkspace('owner', 0, JSON.stringify({ projects: [project] }));
});
afterEach(() => {
  vi.restoreAllMocks(); closeAccountDatabase(path);
  if (dirname(resolve(temp)) === resolve(tmpdir()) && basename(temp).startsWith('pop3d-report-share-')) rmSync(temp, { recursive: true });
});
const input = () => ({ projectId: 'project-demo', version: 1, pdfBase64: pdf });
async function read(route: string, method = 'GET') {
  const out = { status: 200, headers: {} as Record<string, string>, body: '' as string | Buffer };
  const res = { setHeader: (key: string, value: string) => { out.headers[key.toLowerCase()] = value; },
    get statusCode() { return out.status; }, set statusCode(v) { out.status = v; },
    end(value: string | Buffer) { out.body = value; } } as unknown as ServerResponse;
  const handled = await handleReportShare({ url: route, method } as IncomingMessage, res, env);
  return { ...out, handled, data: typeof out.body === 'string' && out.body ? JSON.parse(out.body) : null };
}

describe('frozen report shares', () => {
  it('stores one owner version and serves both snapshot and exact PDF without account login', async () => {
    const share = await prepareReportShare(env, 'owner', input());
    expect(share.url).toBe(`https://pop3-d.vercel.app/#/shared/${share.token}`);
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const json = await read(`/api/reports/${share.token}`);
    expect(json.status).toBe(200);
    expect(json.data.snapshot.projectName).toBe('공유 테스트 기획안');
    expect(json.body).not.toContain('report-owner');
    expect(json.headers['cache-control']).toContain('no-store');
    const file = await read(`/api/reports/${share.token}/pdf`);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toContain('attachment;');
    expect(file.body).toEqual(Buffer.from(pdf, 'base64'));
  });
  it('never publishes a project owned by another account or an unsaved version', async () => {
    await expect(prepareReportShare(env, 'other', input())).rejects.toMatchObject({ code: 'report_not_found' });
    await expect(prepareReportShare(env, 'owner', { ...input(), version: 999 })).rejects.toMatchObject({ code: 'report_not_found' });
  });
  it('ignores caller-supplied snapshots and keeps the sent version after workspace edits and DB reopen', async () => {
    const share = await prepareReportShare(env, 'owner', { ...input(), snapshot: { projectName: 'forged' } });
    await accountStore(env).saveWorkspace('owner', 1, JSON.stringify({ projects: [] }));
    closeAccountDatabase(path);
    expect((await read(`/api/reports/${share.token}`)).data.snapshot.projectName).toBe('공유 테스트 기획안');
    const [stored] = await accountStore(env).query<{ token_hash: string }>('SELECT token_hash FROM report_shares');
    expect(stored.token_hash).not.toBe(share.token);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('expires links and PDF together after seven days', async () => {
    const share = await prepareReportShare(env, 'owner', input());
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(share.expiresAt));
    expect((await read(`/api/reports/${share.token}`)).status).toBe(404);
    expect((await read(`/api/reports/${share.token}/pdf`)).status).toBe(404);
  });
  it('rejects missing, mutated and malformed capabilities without enumerating reports', async () => {
    const share = await prepareReportShare(env, 'owner', input());
    expect((await read(`/api/reports/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await read('/api/reports/../../account/workspace')).handled).toBe(false);
    expect((await read('/api/reports/owner')).status).toBe(404);
    expect((await read(`/api/reports/${share.token}`, 'POST')).status).toBe(405);
  });
  it.each(['not-base64', Buffer.from('<html>not a PDF</html>').toString('base64'), Buffer.from('%PDF-1.7\ntruncated').toString('base64')])('rejects invalid PDF content', async value => {
    await expect(prepareReportShare(env, 'owner', { ...input(), pdfBase64: value })).rejects.toMatchObject({ code: 'invalid_pdf' });
  });
  it('bounds PDF size before storage', async () => {
    const oversized = Buffer.alloc(REPORT_PDF_LIMIT + 1).toString('base64');
    await expect(prepareReportShare(env, 'owner', { ...input(), pdfBase64: oversized })).rejects.toMatchObject({ code: 'pdf_too_large' });
  });
  it('rejects invalid stored geometry before publishing it', async () => {
    const db = accountStore(env), saved = JSON.parse((await db.workspace('owner'))!.body);
    saved.projects[0].versions[0].space.width = -1;
    await db.saveWorkspace('owner', 1, JSON.stringify(saved));
    await expect(prepareReportShare(env, 'owner', input())).rejects.toMatchObject({ code: 'report_not_found' });
  });
  it.each(['title', 'brief'])('rejects invalid event %s values before rendering', async key => {
    const db = accountStore(env), saved = JSON.parse((await db.workspace('owner'))!.body);
    saved.projects[0].versions[0].event[key] = key === 'title' ? { bad: 1 } : { objective: { bad: 1 } };
    await db.saveWorkspace('owner', 1, JSON.stringify(saved));
    await expect(prepareReportShare(env, 'owner', input())).rejects.toMatchObject({ code: 'report_not_found' });
  });
  it('bounds procedural mesh work for oversized hanger layouts', async () => {
    const db = accountStore(env), saved = JSON.parse((await db.workspace('owner'))!.body);
    const snap = saved.projects[0].versions[0];
    snap.vendor.items[0].category = 'hanger'; snap.vendor.items[0].w = 200;
    snap.placements = [0, 1].map(id => ({ id: String(id), sku: snap.vendor.items[0].sku, x: 0, y: 0, rot: 0, noOrder: false }));
    await db.saveWorkspace('owner', 1, JSON.stringify(saved));
    await expect(prepareReportShare(env, 'owner', input())).rejects.toMatchObject({ code: 'report_not_found' });
  });
  it('downloads PDFs with emoji and malformed Unicode in long project names', async () => {
    const db = accountStore(env), saved = JSON.parse((await db.workspace('owner'))!.body);
    saved.projects[0].versions[0].projectName = `${'a'.repeat(79)}😀\ud800`;
    await db.saveWorkspace('owner', 1, JSON.stringify(saved));
    const share = await prepareReportShare(env, 'owner', input());
    expect((await read(`/api/reports/${share.token}/pdf`)).status).toBe(200);
  });
  it('uses configured canonical HTTPS only; does not infer a domain from request headers', () => {
    expect(publicReportOrigin(env)).toBe('https://pop3-d.vercel.app');
    for (const url of ['http://localhost:5174', 'https://127.0.0.1', 'https://host.internal', 'https://user:pass@example.com', 'https://example.com/?token=x']) {
      expect(publicReportOrigin({ POP3D_PUBLIC_URL: url })).toBeUndefined();
    }
  });
});
