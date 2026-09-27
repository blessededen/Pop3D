import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from '../../server/api';
import { accountStore, closeAccountDatabase } from '../../server/accountStore';
import type { Env } from '../../server/ai';

const networkFetch = fetch;
let server: Server, base: string, temp: string, path: string, env: Env;
let providerCalls: string[];
let subject = '1285016924429472463';
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
async function request(endpoint: string, cookie = '', method = 'GET', data?: unknown, owner?: string) {
  return networkFetch(`${base}${endpoint}`, { redirect: 'manual', method,
    headers: { Cookie: cookie, 'X-Pop3D-Client': 'web', 'X-Pop3D-Account': owner || '', 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data) });
}
async function begin() {
  const result = await request('/api/account/kakao/start');
  expect(result.status).toBe(302);
  const target = new URL(result.headers.get('location')!);
  expect(target.hostname).toBe('kauth.kakao.com');
  const state = target.searchParams.get('state')!;
  const cookie = result.headers.getSetCookie().find(value => value.startsWith('pop3d_account_oauth='))!.split(';')[0];
  return { state, cookie };
}
async function finish(flow: { state: string; cookie: string }) {
  const result = await request(`/api/auth/kakao/callback?state=${flow.state}&code=synthetic-code`, flow.cookie);
  expect(result.status).toBe(303); expect(result.headers.get('location')).toBe('/#/');
  const cookie = result.headers.getSetCookie().find(value => value.startsWith('pop3d_account='))!.split(';')[0];
  const session = await (await request('/api/account/session', cookie)).json();
  return { result, cookie, user: session.user as { id: string; username: string } };
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'pop3d-kakao-account-integration-')); path = join(temp, 'accounts.sqlite');
  providerCalls = [];
  env = { POP3D_ACCOUNT_DB: path, KAKAO_REST_API_KEY: 'synthetic-rest-key', KAKAO_CLIENT_SECRET: 'synthetic-secret' };
  server = createServer((req, res) => { void handleApi(req, res, env); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  env.KAKAO_REDIRECT_URI = `${base}/api/auth/kakao/callback`;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input); providerCalls.push(url);
    if (url === 'https://kauth.kakao.com/oauth/token') return response({ access_token: 'synthetic-provider-token', expires_in: 3600 });
    if (url === 'https://kapi.kakao.com/v1/user/access_token_info') return new Response(`{"id":${subject},"app_id":4321,"expires_in":3600}`);
    if (url.startsWith('https://kapi.kakao.com/v2/user/me?')) return new Response(`{"id":${subject}}`);
    throw new Error('Unexpected provider request blocked by test');
  }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeAccountDatabase(path);
  if (dirname(resolve(temp)) === resolve(tmpdir()) && basename(temp).startsWith('pop3d-kakao-account-integration-')) rmSync(temp, { recursive: true });
});

describe('Kakao sign-in through the shared API router and account store', () => {
  it('routes social readiness before account protection and retains existing Talk routes', async () => {
    const status = await request('/api/account/kakao/status');
    expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ configured: true });
    const talk = await request('/api/kakao/status');
    expect(talk.status).toBe(200); expect(await talk.json()).toMatchObject({ configured: true, connected: false });
  });
  it('finishes after a store reopen, appends the session cookie, and stores no provider token', async () => {
    const flow = await begin();
    closeAccountDatabase(path);
    const login = await finish(flow);
    expect(login.result.headers.getSetCookie()).toEqual(expect.arrayContaining([
      expect.stringContaining('pop3d_account_oauth=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0'),
      expect.stringContaining('pop3d_account='),
    ]));
    expect(login.user.id).toMatch(/^[a-f0-9]{32}$/);
    const same = await finish(await begin());
    expect(same.user.id).toBe(login.user.id);
    const callsBeforeReplay = providerCalls.length;
    const replay = await request(`/api/auth/kakao/callback?state=${flow.state}&code=replay`, flow.cookie);
    expect(replay.headers.get('location')).toBe('/#/?account_error=state_invalid');
    expect(providerCalls).toHaveLength(callsBeforeReplay);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = ['users', 'sessions', 'account_oauth'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
      expect(JSON.stringify(rows)).not.toContain('synthetic-provider-token');
      expect(JSON.stringify(rows)).not.toContain('synthetic-secret');
      expect(JSON.stringify(rows)).not.toContain(login.cookie.split('=')[1]);
    } finally { db.close(); }
  });
  it('restores only the Kakao owner workspace and cannot password-login to the social sentinel', async () => {
    const a = await finish(await begin());
    const workspace = { spaces: [], vendors: [], projects: [], currentProjectId: '' };
    const saved = await request('/api/account/workspace', a.cookie, 'PUT', { revision: 0, workspace }, a.user.id);
    expect(saved.status).toBe(200);
    subject = '1285016924429472464';
    const b = await finish(await begin());
    expect(b.user.id).not.toBe(a.user.id);
    const otherWorkspace = await request('/api/account/workspace', b.cookie, 'GET', undefined, b.user.id);
    expect((await otherWorkspace.json()).workspace).toBeNull();
    subject = '1285016924429472463';
    const same = await finish(await begin());
    const restored = await request('/api/account/workspace', same.cookie, 'GET', undefined, same.user.id);
    expect((await restored.json()).workspace).toEqual(workspace);
    const passwordLogin = await request('/api/account/login', '', 'POST', { username: a.user.username, password: 'synthetic-valid-length-password' });
    expect(passwordLogin.status).toBe(401); expect(passwordLogin.headers.getSetCookie()).toHaveLength(0);
    expect((await accountStore(env).userByName(a.user.username))?.password).toBe('');
  });
});
