import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleAccounts, closeAccountDatabase } from '../../server/accounts';
import { demoProject, demoSpace, demoVendor } from './seed';

let server: Server, base: string, temp: string, dbPath: string;
const testPassword = 'synthetic-account-password-only';
const headers = { 'Content-Type': 'application/json', 'X-Pop3D-Client': 'web' };
const owners = new Map<string, string>();
async function call(path: string, method = 'GET', value?: unknown, cookie = '', extra: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/account/${path}`, { method, headers: { ...headers, Cookie: cookie, 'X-Pop3D-Account': owners.get(cookie) || '', ...extra }, body: value == null ? undefined : JSON.stringify(value) });
  const result = { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie') || '' };
  if (result.cookie && result.data.user) owners.set(result.cookie.split(';')[0], result.data.user.id);
  return result;
}
async function register(username: string) {
  const res = await call('register', 'POST', { username, password: testPassword });
  expect(res.status).toBe(201);
  return { ...res, cookie: res.cookie.split(';')[0] };
}
function workspace(name = '나의 프로젝트') {
  const space = demoSpace(), vendor = demoVendor(), project = demoProject(space, vendor);
  project.name = name;
  return { spaces: [space], vendors: [vendor], projects: [project], currentProjectId: project.id };
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'pop3d-auth-test-')); dbPath = join(temp, 'accounts.sqlite');
  server = createServer((req, res) => { void handleAccounts(req, res, { POP3D_ACCOUNT_DB: dbPath }).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeAccountDatabase(dbPath);
  if (dirname(resolve(temp)) === resolve(tmpdir()) && basename(temp).startsWith('pop3d-auth-test-')) rmSync(temp, { recursive: true });
});

describe('account-owned persistent workspaces over HTTP', () => {
  it('requires authentication to read or write any workspace', async () => {
    expect((await call('workspace')).status).toBe(401);
    expect((await call('workspace', 'PUT', { revision: 0, workspace: workspace() })).status).toBe(401);
    expect((await call('session')).data.user).toBeNull();
  });
  it('saves on the server and restores only the same user after a new login', async () => {
    const user = await register('restore-test');
    expect((await call('workspace', 'PUT', { revision: 0, workspace: workspace('저장한 작업') }, user.cookie)).status).toBe(200);
    const login = await call('login', 'POST', { username: 'restore-test', password: testPassword });
    expect(login.status).toBe(200);
    const read = await call('workspace', 'GET', undefined, login.cookie.split(';')[0]);
    expect(read.data.workspace.projects[0].name).toBe('저장한 작업');
    expect(read.data.revision).toBe(1);
    expect(login.cookie).toContain('HttpOnly'); expect(login.cookie).toContain('SameSite=Strict');
  });
  it('isolates identical project IDs and ignores a forged owner in the body', async () => {
    const a = await register('owner-a'), b = await register('owner-b');
    await call('workspace', 'PUT', { revision: 0, workspace: workspace('A private') }, a.cookie);
    expect((await call('workspace', 'GET', undefined, b.cookie)).data.workspace).toBeNull();
    await call('workspace', 'PUT', { revision: 0, userId: a.data.user.id, workspace: workspace('B private') }, b.cookie);
    expect((await call('workspace', 'GET', undefined, a.cookie)).data.workspace.projects[0].name).toBe('A private');
    expect((await call('workspace', 'GET', undefined, b.cookie)).data.workspace.projects[0].name).toBe('B private');
  });
  it('rejects stale writes rather than overwriting another tab', async () => {
    const user = await register('revision-test');
    await call('workspace', 'PUT', { revision: 0, workspace: workspace('first') }, user.cookie);
    expect((await call('workspace', 'PUT', { revision: 0, workspace: workspace('stale') }, user.cookie)).status).toBe(409);
    expect((await call('workspace', 'GET', undefined, user.cookie)).data.workspace.projects[0].name).toBe('first');
  });
  it('rejects reads, writes and logout from a tab whose account cookie changed elsewhere', async () => {
    const a = await register('switch-a'), b = await register('switch-b');
    await call('workspace', 'PUT', { revision: 0, workspace: workspace('B original') }, b.cookie);
    const staleHeader = { 'X-Pop3D-Account': a.data.user.id };
    expect((await call('workspace', 'PUT', { revision: 1, workspace: workspace('A private') }, b.cookie, staleHeader)).status).toBe(409);
    expect((await call('workspace', 'GET', undefined, b.cookie, staleHeader)).status).toBe(409);
    expect((await call('logout', 'POST', {}, b.cookie, staleHeader)).status).toBe(409);
    expect((await call('workspace', 'GET', undefined, b.cookie)).data.workspace.projects[0].name).toBe('B original');
  });
  it('persists deletion of the final project without bringing seed projects back', async () => {
    const user = await register('delete-test'); const data = workspace();
    await call('workspace', 'PUT', { revision: 0, workspace: data }, user.cookie);
    expect((await call('workspace', 'PUT', { revision: 1, workspace: { ...data, projects: [], currentProjectId: '' } }, user.cookie)).status).toBe(200);
    expect((await call('workspace', 'GET', undefined, user.cookie)).data.workspace.projects).toEqual([]);
  });
  it('rejects cross-origin writes, invalid passwords and malformed workspace data', async () => {
    const user = await register('security-test');
    expect((await call('workspace', 'PUT', { revision: 0, workspace: workspace() }, user.cookie, { Origin: 'https://untrusted.invalid' })).status).toBe(403);
    expect((await call('workspace', 'PUT', { revision: 0, workspace: workspace() }, user.cookie, { 'X-Pop3D-Client': '' })).status).toBe(403);
    expect((await call('workspace', 'PUT', { revision: 0, workspace: { projects: ['broken'] } }, user.cookie)).status).toBe(400);
    expect((await call('login', 'POST', { username: 'security-test', password: 'incorrect-password' })).status).toBe(401);
  });
  it('invalidates the session at logout and stores no plaintext password or session token', async () => {
    const user = await register('logout-test');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT password FROM users WHERE username = ?').get('logout-test') as { password: string };
    expect(row.password).not.toContain(testPassword);
    const token = user.cookie.split('=')[1];
    expect(db.prepare('SELECT token FROM sessions WHERE token = ?').get(token)).toBeUndefined(); db.close();
    expect((await call('logout', 'POST', {}, user.cookie)).status).toBe(200);
    expect((await call('session', 'GET', undefined, user.cookie)).data.user).toBeNull();
    expect((await call('workspace', 'GET', undefined, user.cookie)).status).toBe(401);
  });
  it('refuses an expired session even when the browser still has its cookie', async () => {
    const user = await register('expiry-test');
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE sessions SET expires = 1 WHERE user_id = ?').run(user.data.user.id); db.close();
    expect((await call('session', 'GET', undefined, user.cookie)).data.user).toBeNull();
    expect((await call('workspace', 'GET', undefined, user.cookie)).status).toBe(401);
  });
});
