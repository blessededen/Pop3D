import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KakaoEnv } from '../../server/kakao';

const ENV: KakaoEnv = { KAKAO_REST_API_KEY: 'test-rest-key', KAKAO_CLIENT_SECRET: 'test-client-secret' };
const ORIGIN = 'http://127.0.0.1:5174';
const TOKENS = { access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600, refresh_token_expires_in: 5184000 };
let api: typeof import('../../server/kakao');
let fetchMock = vi.fn();
let now: number;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const scopes = (agreed = true) => response({ scopes: [{ id: 'talk_message', agreed, using: true }] });

function request(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return { url: path, method, headers: { host: '127.0.0.1:5174', ...headers } } as IncomingMessage;
}
async function call(path: string, headers: Record<string, string> = {}, env = ENV, method = 'GET') {
  const out = { status: 200, headers: {} as Record<string, string | string[]>, body: '' };
  const res = {
    get statusCode() { return out.status; },
    set statusCode(value: number) { out.status = value; },
    setHeader(name: string, value: string | string[]) { out.headers[name] = value; },
    getHeader(name: string) { return out.headers[name]; },
    end(body?: string) { out.body = body ?? ''; },
  } as unknown as ServerResponse;
  const handled = await api.handleKakao(request(path, headers, method), res, env);
  return { ...out, handled, data: out.body ? JSON.parse(out.body) as Record<string, unknown> : {} };
}
function cookie(headers: Record<string, string | string[]>, name: string): string {
  const values = headers['set-cookie'];
  if (!Array.isArray(values)) throw new Error('Expected cookies');
  const value = values.find((item) => item.startsWith(`${name}=`));
  if (!value) throw new Error('Expected cookie');
  return value.split(';')[0];
}
async function start(env = ENV) {
  const result = await call('/api/auth/kakao/start', {}, env);
  const target = new URL(String(result.headers.location));
  return { ...result, target, state: target.searchParams.get('state')!, cookie: cookie(result.headers, 'pop3d_kakao_oauth') };
}
async function connect(env = ENV, agreed = true) {
  const flow = await start(env);
  fetchMock.mockResolvedValueOnce(response(TOKENS)).mockResolvedValueOnce(scopes(agreed));
  const result = await call(`/api/auth/kakao/callback?state=${flow.state}&code=test-authorization-code`, { cookie: flow.cookie }, env);
  expect(result.headers.location).toBe('/#/kakao?kakao=connected');
  return { ...result, cookie: cookie(result.headers, 'pop3d_kakao_session'), flow };
}

beforeEach(async () => {
  vi.resetModules();
  api = await import('../../server/kakao');
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  fetchMock = vi.fn().mockImplementation(async () => scopes());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Kakao local OAuth configuration', () => {
  it('reports only missing variable names and does not request upstream without configuration', async () => {
    const result = await call('/api/kakao/status', {}, { KAKAO_CLIENT_SECRET: 'private-fixture' });
    expect(result.data).toMatchObject({ configured: false, missing: ['KAKAO_REST_API_KEY'], connected: false, csrfToken: null, canSend: false });
    expect(result.body).not.toContain('private-fixture');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await call('/api/auth/kakao/start', {}, {})).headers.location).toBe('/#/kakao?error=not_configured');
  });
  it('refuses non-local plain HTTP callback configuration', async () => {
    const result = await call('/api/kakao/status', {}, { ...ENV, KAKAO_REDIRECT_URI: 'http://evil.example.com/api/auth/kakao/callback' });
    expect(result.data).toMatchObject({ configured: false, reason: 'invalid_redirect' });
  });
  it('canonicalizes local host aliases using only the configured origin', async () => {
    const result = await call('/api/auth/kakao/start', { host: 'attacker.example.com', 'x-forwarded-host': 'evil.example.com' });
    expect(result.headers.location).toBe(`${ORIGIN}/api/auth/kakao/start`);
    expect(result.headers['set-cookie']).toBeUndefined();
  });
  it('authorizes only with the fixed Kakao host, required scope, and browser-bound cookie', async () => {
    const flow = await start();
    expect(flow.target.origin).toBe('https://kauth.kakao.com');
    expect(flow.target.pathname).toBe('/oauth/authorize');
    expect(flow.target.searchParams.get('scope')).toBe('talk_message');
    expect(flow.target.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/kakao/callback`);
    expect(flow.state).toHaveLength(43);
    expect(flow.cookie).not.toContain(flow.state);
    expect(flow.headers['set-cookie']).toEqual([expect.stringContaining('HttpOnly; SameSite=Lax; Max-Age=600')]);
    expect(flow.headers.location).not.toContain('test-client-secret');
  });
  it('sets Secure on HTTPS cookies and never a Domain attribute', async () => {
    const result = await connect({ ...ENV, KAKAO_REDIRECT_URI: 'https://pop3d.example.com/api/auth/kakao/callback' });
    for (const value of result.headers['set-cookie'] as string[]) {
      expect(value).toContain('; Secure');
      expect(value).not.toContain('Domain=');
    }
  });
  it.each(['http://pop3d.example.com', 'https://localhost', 'https://dev.local', 'https://192.168.1.7', 'https://127.1', 'https://2130706433', 'https://[::1]', 'https://[fd00::1]', 'https://user:password@pop3d.example.com', 'https://pop3d.example.com/#x'])('rejects unsafe public URL %s', (value) => {
    expect(api.isPublicHttpsUrl(value)).toBe(false);
  });
  it('accepts a public HTTPS domain while keeping message sending disabled', async () => {
    const result = await call('/api/kakao/status', {}, { ...ENV, POP3D_PUBLIC_URL: 'https://pop3d.example.com' });
    expect(result.data).toMatchObject({ publicUrlReady: true, canSend: false });
  });
});

describe('OAuth state and callback protection', () => {
  it('rejects mismatching state without exchanging a token', async () => {
    const flow = await start();
    const result = await call('/api/auth/kakao/callback?state=wrong&code=private-code', { cookie: flow.cookie });
    expect(result.headers.location).toBe('/#/kakao?error=state_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects another browser and consumes a challenged state', async () => {
    const flow = await start(), other = await start();
    const path = `/api/auth/kakao/callback?state=${flow.state}&code=private-code`;
    expect((await call(path, { cookie: other.cookie })).headers.location).toBe('/#/kakao?error=state_invalid');
    expect((await call(path, { cookie: flow.cookie })).headers.location).toBe('/#/kakao?error=state_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('expires state after ten minutes', async () => {
    const flow = await start();
    now += 10 * 60_000;
    expect((await call(`/api/auth/kakao/callback?state=${flow.state}&code=x`, { cookie: flow.cookie })).headers.location).toBe('/#/kakao?error=state_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects replay even after a successful exchange', async () => {
    const result = await connect();
    fetchMock.mockClear();
    const replay = await call(`/api/auth/kakao/callback?state=${result.flow.state}&code=x`, { cookie: result.flow.cookie });
    expect(replay.headers.location).toBe('/#/kakao?error=state_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('returns a static denial error without echoing provider parameters', async () => {
    const flow = await start();
    const result = await call(`/api/auth/kakao/callback?state=${flow.state}&error=secret-provider-error&error_description=private`, { cookie: flow.cookie });
    expect(result.headers.location).toBe('/#/kakao?error=authorization_denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sanitizes failed token exchanges and bounds upstream requests', async () => {
    const flow = await start();
    fetchMock.mockRejectedValueOnce(new Error('private token and authorization-code'));
    const result = await call(`/api/auth/kakao/callback?state=${flow.state}&code=x`, { cookie: flow.cookie });
    expect(result.headers.location).toBe('/#/kakao?error=token_exchange_failed');
    expect(JSON.stringify(result)).not.toContain('private token');
    expect(fetchMock.mock.calls[0][0]).toBe('https://kauth.kakao.com/oauth/token');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });
});

describe('Server-only sessions and explicit disconnect', () => {
  it('exposes connection and permission only, with no token or OAuth code', async () => {
    const result = await connect();
    const status = await call('/api/kakao/status', { cookie: result.cookie });
    expect(status.data).toMatchObject({ configured: true, connected: true, messagePermission: true, publicUrlReady: false, canSend: false, reason: 'public_url_required' });
    expect(status.data.csrfToken).toEqual(expect.any(String));
    for (const secret of ['test-access-token', 'test-refresh-token', 'test-client-secret', 'test-authorization-code']) {
      expect(JSON.stringify({ result, status })).not.toContain(secret);
    }
    expect(status.headers['cache-control']).toBe('no-store');
  });
  it('detects revoked message permission on the next status check', async () => {
    const result = await connect();
    fetchMock.mockResolvedValueOnce(scopes(false));
    expect((await call('/api/kakao/status', { cookie: result.cookie })).data).toMatchObject({ connected: true, messagePermission: false, reason: 'message_permission_required' });
  });
  it('does not claim permission when scope verification fails', async () => {
    const result = await connect();
    fetchMock.mockResolvedValueOnce(response({ error: 'private-upstream-error' }, 500));
    expect((await call('/api/kakao/status', { cookie: result.cookie })).data).toMatchObject({ connected: true, messagePermission: false, reason: 'permission_check_failed' });
  });
  it('requires reconnection when the provider has revoked the access token', async () => {
    const result = await connect();
    fetchMock.mockResolvedValueOnce(response({ code: -401, msg: 'private-token-details' }, 401));
    expect((await call('/api/kakao/status', { cookie: result.cookie })).data).toMatchObject({ connected: false, messagePermission: false, reason: 'reconnect_required' });
  });
  it('requires both configured same-origin and CSRF to disconnect', async () => {
    const result = await connect();
    const status = await call('/api/kakao/status', { cookie: result.cookie });
    const headers = { cookie: result.cookie, 'x-csrf-token': String(status.data.csrfToken) };
    expect((await call('/api/kakao/disconnect', headers, ENV, 'POST')).status).toBe(403);
    expect((await call('/api/kakao/disconnect', { ...headers, origin: 'https://evil.example.com' }, ENV, 'POST')).data.error).toBe('origin_invalid');
    expect((await call('/api/kakao/disconnect', { cookie: result.cookie, origin: ORIGIN }, ENV, 'POST')).data.error).toBe('csrf_invalid');
    const done = await call('/api/kakao/disconnect', { ...headers, origin: ORIGIN }, ENV, 'POST');
    expect(done.status).toBe(200);
    expect(done.data).toEqual({ connected: false });
    fetchMock.mockClear();
    expect((await call('/api/kakao/status', { cookie: result.cookie })).data.connected).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('expires old sessions and requests reconnection without upstream access', async () => {
    const result = await connect();
    now += 30 * 24 * 60 * 60_000;
    fetchMock.mockClear();
    expect((await call('/api/kakao/status', { cookie: result.cookie })).data).toMatchObject({ connected: false, reason: 'session_expired', csrfToken: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('invalidates sessions when the application configuration changes', async () => {
    const result = await connect();
    expect((await call('/api/kakao/status', { cookie: result.cookie }, { ...ENV, KAKAO_REST_API_KEY: 'another-app' })).data.connected).toBe(false);
  });
  it('refreshes once across simultaneous status checks and keeps tokens server-side', async () => {
    const result = await connect();
    now += 3_590_000;
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(response({ access_token: 'rotated-private-token', expires_in: 3600 })).mockResolvedValueOnce(scopes());
    const statuses = await Promise.all([call('/api/kakao/status', { cookie: result.cookie }), call('/api/kakao/status', { cookie: result.cookie })]);
    expect(statuses.every((entry) => entry.data.connected && entry.data.messagePermission)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1].body as URLSearchParams).get('grant_type')).toBe('refresh_token');
    expect(JSON.stringify(statuses)).not.toContain('rotated-private-token');
  });
  it('drops the session after a failed refresh', async () => {
    const result = await connect();
    now += 3_590_000;
    fetchMock.mockResolvedValueOnce(response({ error: 'private-token-error' }, 400));
    expect((await call('/api/kakao/status', { cookie: result.cookie })).data).toMatchObject({ connected: false, reason: 'reconnect_required', csrfToken: null });
  });
  it('passes unrelated routes through and rejects incorrect methods', async () => {
    expect((await call('/api/health')).handled).toBe(false);
    expect((await call('/api/kakao/disconnect')).status).toBe(405);
  });
});
