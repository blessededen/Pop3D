import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleKakaoAccount, type KakaoAccountDependencies, type KakaoAccountState } from '../../server/kakaoAccount';

const ENV = { KAKAO_REST_API_KEY: 'synthetic-rest-key', KAKAO_CLIENT_SECRET: 'synthetic-client-secret' };
const ORIGIN = 'http://127.0.0.1:5174';
const START = '/api/account/kakao/start';
const CALLBACK = '/api/auth/kakao/callback';
const STATE_COOKIE = 'pop3d_account_oauth';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let pending: Map<string, KakaoAccountState>, fetchMock: ReturnType<typeof vi.fn>;
let signIn: ReturnType<typeof vi.fn<KakaoAccountDependencies['signIn']>>;
let now: number;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function dependencies(): KakaoAccountDependencies {
  return {
    saveState: async (key, value) => { pending.set(key, value); },
    takeState: async key => { const value = pending.get(key); pending.delete(key); return value; },
    signIn, fetch: fetchMock as typeof fetch, now: () => now,
  };
}
async function call(path: string, headers: Record<string, string> = {}, env: Record<string, string> = ENV, method = 'GET', override: Partial<KakaoAccountDependencies> = {}) {
  const out = { status: 200, headers: {} as Record<string, string | string[]>, body: '' };
  const req = { url: path, method, headers: { host: '127.0.0.1:5174', ...headers } } as IncomingMessage;
  const res = {
    get statusCode() { return out.status; }, set statusCode(value: number) { out.status = value; },
    setHeader(name: string, value: string | string[]) { out.headers[name.toLowerCase()] = value; },
    getHeader(name: string) { return out.headers[name.toLowerCase()]; },
    end(body?: string) { out.body = body || ''; },
  } as unknown as ServerResponse;
  const handled = await handleKakaoAccount(req, res, env, { ...dependencies(), ...override });
  return { ...out, handled, data: out.body ? JSON.parse(out.body) : null };
}
async function start(env: Record<string, string> = ENV, headers: Record<string, string> = {}) {
  const result = await call(START, headers, env);
  const target = new URL(String(result.headers.location));
  const cookies = result.headers['set-cookie'] as string[];
  const cookie = cookies.find(v => v.startsWith(`${STATE_COOKIE}=`))!.split(';')[0];
  return { ...result, target, cookie, state: target.searchParams.get('state')! };
}
function provider(user = 123456789, app = 4321) {
  fetchMock.mockResolvedValueOnce(response({ access_token: 'synthetic-access-token', token_type: 'bearer', expires_in: 3600 }))
    .mockResolvedValueOnce(response({ app_id: app, id: user, expires_in: 3599 }))
    .mockResolvedValueOnce(response({ id: user }));
}
const callback = (state: string, tail = 'code=synthetic-code') => `${CALLBACK}?state=${state}&${tail}`;
const errorLocation = (code: string) => `/#/?account_error=${code}`;

beforeEach(() => {
  pending = new Map(); now = 1_800_000_000_000; fetchMock = vi.fn(); signIn = vi.fn().mockResolvedValue(undefined);
});

describe('Kakao account login entry points', () => {
  it('reports configuration without secrets, provider traffic or opening storage', async () => {
    const saveState = vi.fn(), takeState = vi.fn();
    const result = await call('/api/account/kakao/status', {}, { KAKAO_CLIENT_SECRET: 'private-value' }, 'GET', { saveState, takeState });
    expect(result.data).toEqual({ configured: false, reason: 'not_configured' });
    expect(result.body).not.toContain('private-value'); expect(fetchMock).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled(); expect(takeState).not.toHaveBeenCalled();
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('requires an explicit redirect in deployed environments and refuses unsafe callbacks', async () => {
    for (const env of [{ ...ENV, VERCEL: '1' }, { ...ENV, NODE_ENV: 'production' },
      { ...ENV, KAKAO_REDIRECT_URI: 'http://public.example.com/api/auth/kakao/callback' },
      { ...ENV, KAKAO_REDIRECT_URI: `${ORIGIN}/api/auth/kakao/callback?next=evil` }]) {
      expect((await call('/api/account/kakao/status', {}, env)).data).toEqual({ configured: false, reason: 'invalid_redirect' });
    }
  });
  it('uses the existing callback with no talk_message or email consent request', async () => {
    const flow = await start();
    expect(flow.target.origin).toBe('https://kauth.kakao.com');
    expect(flow.target.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${CALLBACK}`);
    expect(flow.target.searchParams.has('scope')).toBe(false);
    expect(flow.state).toMatch(/^account_[\w-]{43}$/);
    expect(flow.cookie).not.toContain(flow.state);
    expect(pending.has(sha(flow.state))).toBe(true);
    const record = pending.get(sha(flow.state))!;
    expect(record.browserHash).toBe(sha(flow.cookie.split('=')[1]));
    expect(record.expiresAt).toBe(now + 600_000);
    expect(flow.headers['set-cookie']).toEqual([expect.stringContaining('Path=/api; HttpOnly; SameSite=Lax; Max-Age=600')]);
    expect(flow.headers.location).not.toContain(ENV.KAKAO_CLIENT_SECRET);
  });
  it('canonicalizes aliases and previews before setting a host-only cookie', async () => {
    const env = { ...ENV, KAKAO_REDIRECT_URI: 'https://pop3d.example.com/api/auth/kakao/callback' };
    const result = await call(START, { host: 'preview.example.com', 'x-forwarded-host': 'attacker.example.com' }, env);
    expect(result.headers.location).toBe('https://pop3d.example.com/api/account/kakao/start');
    expect(result.headers['set-cookie']).toBeUndefined(); expect(pending.size).toBe(0);
    const flow = await start(env, { host: 'pop3d.example.com' });
    expect(flow.headers['set-cookie']).toEqual([expect.stringContaining('; Secure')]);
    expect(String(flow.headers['set-cookie'])).not.toContain('Domain=');
  });
  it('leaves Talk callbacks untouched and enforces GET on its own routes', async () => {
    expect((await call(`${CALLBACK}?state=old-talk-flow&code=code`)).handled).toBe(false);
    expect((await call('/api/auth/kakao/start')).handled).toBe(false);
    const result = await call(START, {}, ENV, 'POST');
    expect(result.status).toBe(405); expect(result.headers.allow).toBe('GET');
    expect(pending.size).toBe(0);
  });
  it('returns only fixed storage errors', async () => {
    const result = await call(START, {}, ENV, 'GET', { saveState: async () => { throw new Error('private-database-connection'); } });
    expect(result.headers.location).toBe(errorLocation('temporarily_unavailable'));
    expect(JSON.stringify(result)).not.toContain('private-database-connection');
  });
});

describe('single-use, browser-bound account OAuth state', () => {
  it('rejects another browser and consumes the challenged state', async () => {
    const one = await start(), two = await start();
    expect((await call(callback(one.state), { cookie: two.cookie })).headers.location).toBe(errorLocation('state_invalid'));
    expect((await call(callback(one.state), { cookie: one.cookie })).headers.location).toBe(errorLocation('state_invalid'));
    expect(fetchMock).not.toHaveBeenCalled(); expect(signIn).not.toHaveBeenCalled();
  });
  it('rejects missing/duplicate cookies and expired or changed-configuration state', async () => {
    const missing = await start();
    expect((await call(callback(missing.state))).headers.location).toBe(errorLocation('state_invalid'));
    const duplicate = await start();
    expect((await call(callback(duplicate.state), { cookie: `${duplicate.cookie}; ${duplicate.cookie}` })).headers.location).toBe(errorLocation('state_invalid'));
    const expired = await start(); now += 600_000;
    expect((await call(callback(expired.state), { cookie: expired.cookie })).headers.location).toBe(errorLocation('state_invalid'));
    const changed = await start();
    expect((await call(callback(changed.state), { cookie: changed.cookie }, { ...ENV, KAKAO_CLIENT_SECRET: 'changed-secret' })).headers.location).toBe(errorLocation('state_invalid'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects malformed or ambiguous state and duplicate authorization codes', async () => {
    const flow = await start();
    for (const path of [callback('account_invalid'), `${callback(flow.state)}&state=${flow.state}`]) {
      expect((await call(path, { cookie: flow.cookie })).headers.location).toBe(errorLocation('state_invalid'));
    }
    expect((await call(`${callback(flow.state)}&code=another`, { cookie: flow.cookie })).headers.location).toBe(errorLocation('authorization_failed'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('clears the browser cookie and returns a fixed error when consent is cancelled', async () => {
    const flow = await start();
    const result = await call(callback(flow.state, 'error=access_denied&error_description=private-upstream-description'), { cookie: flow.cookie });
    expect(result.headers.location).toBe(errorLocation('authorization_denied'));
    expect(result.headers['set-cookie']).toEqual([expect.stringContaining('Max-Age=0')]);
    expect(JSON.stringify(result)).not.toContain('private-upstream'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('atomically consumes state so racing callbacks cannot exchange a code twice', async () => {
    const flow = await start(); provider();
    const results = await Promise.all([call(callback(flow.state), { cookie: flow.cookie }), call(callback(flow.state), { cookie: flow.cookie })]);
    expect(results.map(v => v.headers.location).sort()).toEqual(['/#/', errorLocation('state_invalid')].sort());
    expect(signIn).toHaveBeenCalledTimes(1); expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('server-verified app-scoped account identity', () => {
  it('resolves the same identity after separate logins without retaining provider tokens', async () => {
    for (let i = 0; i < 2; i++) {
      const flow = await start(); provider();
      const result = await call(callback(flow.state), { cookie: flow.cookie });
      expect(result.headers.location).toBe('/#/');
      expect((await call(callback(flow.state), { cookie: flow.cookie })).headers.location).toBe(errorLocation('state_invalid'));
    }
    expect(signIn).toHaveBeenCalledTimes(2);
    for (const args of signIn.mock.calls) expect(args.slice(0, 2)).toEqual(['4321', '123456789']);
    expect(pending.size).toBe(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://kauth.kakao.com/oauth/token');
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    expect(init.body.get('client_secret')).toBe(ENV.KAKAO_CLIENT_SECRET);
    expect(fetchMock.mock.calls[1][0]).toBe('https://kapi.kakao.com/v1/user/access_token_info');
    expect(fetchMock.mock.calls[2][0]).toContain('https://kapi.kakao.com/v2/user/me?property_keys=');
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer synthetic-access-token');
  });
  it('preserves 64-bit IDs without collisions caused by JavaScript rounding', async () => {
    for (const id of ['1285016924429472463', '1285016924429472464']) {
      const flow = await start();
      fetchMock.mockResolvedValueOnce(response({ access_token: 'synthetic-access-token', expires_in: 3600 }))
        .mockResolvedValueOnce(new Response(`{"app_id":4321,"id":${id},"expires_in":3600}`))
        .mockResolvedValueOnce(new Response(`{"id":${id},"properties":{"ignored":"id: 1285016924429472463"}}`));
      expect((await call(callback(flow.state), { cookie: flow.cookie })).headers.location).toBe('/#/');
    }
    expect(signIn.mock.calls.map(args => args[1])).toEqual(['1285016924429472463', '1285016924429472464']);
  });
  it('ignores email/profile fields and never chooses an identity from them', async () => {
    const flow = await start();
    fetchMock.mockResolvedValueOnce(response({ access_token: 'synthetic-access-token', expires_in: 3600 }))
      .mockResolvedValueOnce(response({ app_id: 4321, id: 987, expires_in: 3600 }))
      .mockResolvedValueOnce(response({ id: 987, kakao_account: { email: 'existing@synthetic.invalid', profile: { nickname: 'existing-password-account' } } }));
    expect((await call(callback(flow.state), { cookie: flow.cookie })).headers.location).toBe('/#/');
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['4321', '987']);
  });
  it.each([
    { app_id: 0, id: 123, expires_in: 3600 },
    { app_id: 4321, id: -1, expires_in: 3600 },
    { app_id: 4321, id: 1.1, expires_in: 3600 },
    { app_id: 4321, id: '9223372036854775808', expires_in: 3600 },
    { app_id: 4321, id: 123, expires_in: 0 },
  ])('rejects invalid provider identity %j', async info => {
    const flow = await start();
    fetchMock.mockResolvedValueOnce(response({ access_token: 'synthetic-access-token', expires_in: 3600 })).mockResolvedValueOnce(response(info));
    expect((await call(callback(flow.state), { cookie: flow.cookie })).headers.location).toBe(errorLocation('identity_check_failed'));
    expect(signIn).not.toHaveBeenCalled();
  });
  it.each([{ id: 124 }, { id: 123, has_signed_up: false }])('rejects profile mismatch or unlinked account %j', async profile => {
    const flow = await start();
    fetchMock.mockResolvedValueOnce(response({ access_token: 'synthetic-access-token', expires_in: 3600 }))
      .mockResolvedValueOnce(response({ app_id: 4321, id: 123, expires_in: 3600 })).mockResolvedValueOnce(response(profile));
    expect((await call(callback(flow.state), { cookie: flow.cookie })).headers.location).toBe(errorLocation('identity_check_failed'));
    expect(signIn).not.toHaveBeenCalled();
  });
  it('does not expose upstream token errors or storage failures', async () => {
    const tokenFlow = await start();
    fetchMock.mockResolvedValueOnce(response({ error_description: 'private-code-and-secret' }, 400));
    const tokenResult = await call(callback(tokenFlow.state), { cookie: tokenFlow.cookie });
    expect(tokenResult.headers.location).toBe(errorLocation('token_exchange_failed'));
    expect(JSON.stringify(tokenResult)).not.toContain('private-code');
    const storageFlow = await start(); provider(); signIn.mockRejectedValueOnce(new Error('private-database-url'));
    const storageResult = await call(callback(storageFlow.state), { cookie: storageFlow.cookie });
    expect(storageResult.headers.location).toBe(errorLocation('account_unavailable'));
    expect(JSON.stringify(storageResult)).not.toContain('private-database-url');
  });
});
