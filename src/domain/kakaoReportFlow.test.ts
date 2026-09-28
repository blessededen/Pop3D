import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApi } from '../../server/api';
import { accountStore, closeAccountDatabase, type AccountStore } from '../../server/accountStore';
import type { Env } from '../../server/ai';
import { demoProject, demoSpace, demoVendor } from './seed';
import { makeSnapshot } from './version';
import type { VersionSnapshot } from './types';

// Only the provider boundary is fake; account cookies, HTTP routing, SQLite,
// report publishing, capability reads, and duplicate-send storage are real.
const httpFetch = globalThis.fetch;
const PUBLIC_ORIGIN = 'https://pop3d-report-flow.example.com';
const PDF = Buffer.from('%PDF-1.7\n% Synthetic integration fixture\n%%EOF\n');
const cookieFor = (owner: 'a' | 'b') => `pop3d_account=${owner.repeat(64)}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let directory: string, dbPath: string, origin: string, server: Server, env: Env, db: AccountStore;
let workspace: ReturnType<typeof fixture>;
let sentTemplates: Array<{ text: string; link: { web_url: string; mobile_web_url: string } }>;

function fixture() {
  const space = demoSpace(), vendor = demoVendor(), project = demoProject(space, vendor);
  project.id = 'report-flow-project'; project.name = 'Frozen report version one';
  project.placements = [{ id: 'placed-one', sku: vendor.items[0].sku, x: 2, y: 3, rot: 0, noOrder: false }];
  project.versions = [makeSnapshot(project, space, vendor)];
  return { spaces: [space], vendors: [vendor], projects: [project], currentProjectId: project.id };
}

function http(path: string, init: RequestInit = {}) {
  const target = new URL(path, origin);
  if (target.origin !== origin) throw new Error('Integration requests must remain on the temporary localhost server.');
  return httpFetch(target, { ...init, redirect: 'manual' });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'pop3d-report-flow-'));
  dbPath = join(directory, 'accounts.sqlite');
  env = { POP3D_ACCOUNT_DB: dbPath, KAKAO_REST_API_KEY: 'synthetic-client-id', KAKAO_CLIENT_SECRET: 'synthetic-client-secret', POP3D_PUBLIC_URL: PUBLIC_ORIGIN };
  db = accountStore(env);
  for (const owner of ['a', 'b'] as const) {
    await db.createUser(`owner-${owner}`, `fixture-${owner}`, 'synthetic-unused-password');
    await db.issueSession('', hash(owner.repeat(64)), `owner-${owner}`, Date.now() + 3_600_000);
  }
  workspace = fixture();
  expect(await db.saveWorkspace('owner-a', 0, JSON.stringify(workspace))).toBe(true);
  sentTemplates = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (target.origin === 'https://kauth.kakao.com' && target.pathname === '/oauth/token') return json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600, refresh_token_expires_in: 5184000 });
    if (target.origin !== 'https://kapi.kakao.com') throw new Error('Unexpected provider URL; no network request was made.');
    if (target.pathname === '/v1/user/access_token_info') return json({ app_id: 10001, id: 20001, expires_in: 3600 });
    if (target.pathname === '/v2/user/me') return json({ id: 20001, has_signed_up: true });
    if (target.pathname === '/v2/user/scopes') return json({ scopes: [{ id: 'talk_message', agreed: true, using: true }] });
    if (target.pathname === '/v2/api/talk/memo/default/send') {
      expect(init?.method).toBe('POST');
      const body = new URLSearchParams(String(init?.body));
      sentTemplates.push(JSON.parse(body.get('template_object')!));
      return json({ result_code: 0 });
    }
    throw new Error('Unexpected Kakao endpoint; no network request was made.');
  }));
  server = createServer((req, res) => { void handleApi(req, res, env); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Temporary HTTP port not available');
  origin = `http://127.0.0.1:${address.port}`;
  env.KAKAO_REDIRECT_URI = `${origin}/api/auth/kakao/callback`;
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  vi.unstubAllGlobals();
  if (dbPath) closeAccountDatabase(dbPath);
  if (directory) {
    // Delete only the unique fixture directory created by this test.
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('pop3d-report-flow-')) throw new Error('Unexpected cleanup target');
    rmSync(target, { recursive: true, force: true });
  }
});

async function connect(owner: 'a' | 'b' = 'a') {
  const start = await http('/api/auth/kakao/start?returnTo=report', { headers: { Cookie: cookieFor(owner) } });
  expect(start.status).toBe(302);
  const target = new URL(start.headers.get('location')!);
  expect(target.origin).toBe('https://kauth.kakao.com');
  expect(target.searchParams.get('scope')).toBe('talk_message');
  const stateCookie = start.headers.getSetCookie().find(value => value.startsWith('pop3d_kakao_oauth='))!;
  expect(stateCookie).toContain('SameSite=Lax');
  const callback = await http(`/api/auth/kakao/callback?state=${target.searchParams.get('state')}&code=synthetic-code`, {
    // A real cross-site return may omit the Strict account cookie.
    headers: { Cookie: stateCookie.split(';')[0] },
  });
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe('/#/report?kakao=connected');
  const status = await http('/api/kakao/status', { headers: { Cookie: cookieFor(owner) } });
  const connection = await status.json() as { canSend: boolean; csrfToken: string };
  expect(connection.canSend).toBe(true);
  expect(connection.csrfToken).toEqual(expect.any(String));
  return {
    Cookie: cookieFor(owner), Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json',
    'X-Pop3D-Client': 'web', 'X-Pop3D-Account': `owner-${owner}`, 'X-CSRF-Token': connection.csrfToken,
  };
}

const payload = () => ({ projectId: workspace.currentProjectId, version: 1, pdfBase64: PDF.toString('base64'), requestId: 'report-flow-request-001' });
async function send(headers: Record<string, string>) {
  return http('/api/kakao/send', { method: 'POST', headers, body: JSON.stringify(payload()) });
}
function reportPath(url: string) {
  const link = new URL(url);
  expect(link.origin).toBe(PUBLIC_ORIGIN);
  const token = /^#\/shared\/([A-Za-z0-9_-]{43})$/.exec(link.hash)?.[1];
  expect(token).toBeTruthy();
  return `/api/reports/${token}`;
}

describe('HTTP Kakao report publishing flow', () => {
  it('returns from OAuth without the Strict cookie, sends once, and serves the real saved snapshot and PDF anonymously', async () => {
    const headers = await connect();
    expect(sentTemplates).toHaveLength(0); // Consent and status never send.
    const first = await send(headers);
    expect(first.status).toBe(200);
    const receipt = await first.json() as { ok: boolean; url: string; expiresAt: string };
    expect(receipt.ok).toBe(true);
    expect(Date.parse(receipt.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60_000);
    const duplicate = await send(headers);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(receipt);
    expect(sentTemplates).toHaveLength(1);
    expect(sentTemplates[0].link).toEqual({ web_url: receipt.url, mobile_web_url: receipt.url });
    expect(sentTemplates[0].text.split('\n').at(-1)).toBe(receipt.url);
    expect(Array.from(sentTemplates[0].text).length).toBeLessThanOrEqual(200);

    const path = reportPath(receipt.url);
    const shared = await http(path); // No account or OAuth cookies.
    expect(shared.status).toBe(200);
    expect(shared.headers.get('referrer-policy')).toBe('no-referrer');
    const data = await shared.json() as { snapshot: VersionSnapshot; expiresAt: string };
    expect(data.snapshot).toEqual(workspace.projects[0].versions[0]);
    expect(data.expiresAt).toBe(receipt.expiresAt);
    const pdf = await http(`${path}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer())).toEqual(PDF);
    expect(await db.query('SELECT COUNT(*) AS count FROM report_shares')).toEqual([{ count: 1 }]);
  });

  it('keeps the delivered version frozen after the owner saves a changed draft and a new version', async () => {
    const headers = await connect();
    const published = await send(headers);
    expect(published.status).toBe(200);
    const receipt = await published.json() as { url: string };
    const original = structuredClone(workspace.projects[0].versions[0]);
    workspace.projects[0].name = 'Changed draft after delivery';
    workspace.projects[0].placements[0].x = 4;
    workspace.projects[0].versions.push(makeSnapshot(workspace.projects[0], workspace.spaces[0], workspace.vendors[0]));
    const saved = await http('/api/account/workspace', { method: 'PUT', headers, body: JSON.stringify({ revision: 1, workspace }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: 2 });
    const shared = await http(reportPath(receipt.url));
    expect((await shared.json() as { snapshot: VersionSnapshot }).snapshot).toEqual(original);
    expect(sentTemplates).toHaveLength(1);
  });

  it('rejects another account publishing the owner’s project or spoofing the owner header before any message is sent', async () => {
    const headers = await connect('b');
    const denied = await send(headers);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: 'report_not_found' });
    const spoofed = await send({ ...headers, 'X-Pop3D-Account': 'owner-a' });
    expect(spoofed.status).toBe(409);
    expect(await spoofed.json()).toEqual({ error: 'account_changed' });
    expect(sentTemplates).toHaveLength(0);
    expect(await db.query('SELECT COUNT(*) AS count FROM report_shares')).toEqual([{ count: 0 }]);
  });
});
