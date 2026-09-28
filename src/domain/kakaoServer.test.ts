import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { handleKakao, isPublicHttpsUrl, type KakaoEnv } from '../../server/kakao';
import { accountStore, closeAccountDatabase } from '../../server/accountStore';
import { prepareReportShare } from '../../server/reportShare';

vi.mock('../../server/reportShare', () => ({ prepareReportShare: vi.fn() }));
const shareMock = vi.mocked(prepareReportShare);
const ORIGIN = 'http://127.0.0.1:5174', PUBLIC = 'https://pop3d.example.com';
const CALLBACK = '/api/auth/kakao/callback', SEND = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
const A = `pop3d_account=${'a'.repeat(64)}`, B = `pop3d_account=${'b'.repeat(64)}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const TOKENS = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, refresh_token_expires_in: 5184000 };
const INPUT = { projectId: 'project-a', version: 1, pdfBase64: Buffer.from('%PDF-1.7\nsynthetic\n%%EOF').toString('base64'), requestId: 'synthetic-request-01' };
const SHARE = { id: 'share-id', token: 'x'.repeat(43), url: `${PUBLIC}/#/shared/${'x'.repeat(43)}`, title: '팝업 기획', version: 1, expiresAt: '2027-01-22T08:00:00.000Z' };
let env: KakaoEnv, temp: string, path: string, now: number, agreed: boolean, using: boolean, subject: string;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let fetchMock = vi.fn();
type Options = { headers?: Record<string, string>; cookie?: string; method?: string; body?: unknown; env?: KakaoEnv };
async function call(endpoint: string, options: Options = {}) {
  const settings = options.env || env;
  const out = { status: 200, headers: {} as Record<string, string | string[]>, body: '' };
  const res = {
    get statusCode() { return out.status; }, set statusCode(value: number) { out.status = value; },
    setHeader(name: string, value: string | string[]) { out.headers[name.toLowerCase()] = value; },
    getHeader(name: string) { return out.headers[name.toLowerCase()]; }, end(body?: string) { out.body = body ?? ''; },
  } as unknown as ServerResponse;
  const req = { url: endpoint, method: options.method || 'GET', socket: {}, body: options.body ?? {},
    headers: { host: new URL(settings.KAKAO_REDIRECT_URI || `${ORIGIN}${CALLBACK}`).host, cookie: options.cookie ?? A, ...options.headers } } as unknown as IncomingMessage;
  const handled = await handleKakao(req, res, settings);
  return { ...out, handled, data: out.body ? JSON.parse(out.body) as Record<string, unknown> : {} };
}
async function start(options: Options = {}, target = 'report') {
  const out = await call(`/api/auth/kakao/start?returnTo=${encodeURIComponent(target)}`, options), authorize = new URL(String(out.headers.location));
  return { ...out, authorize, state: authorize.searchParams.get('state')!, cookie: (out.headers['set-cookie'] as string[]).find(c => c.startsWith('pop3d_kakao_oauth='))!.split(';')[0] };
}
async function connect(options: Options = {}) {
  const flow = await start(options), result = await call(`${CALLBACK}?state=${flow.state}&code=synthetic-code`, { ...options, cookie: flow.cookie });
  expect(result.headers.location).toBe(`/#/report?${agreed && using ? 'kakao=connected' : 'error=message_permission_required'}`);
  return { flow, result };
}
async function mutationHeaders(cookie = A, owner = 'owner-a') {
  const status = await call('/api/kakao/status', { cookie });
  return { 'x-pop3d-client': 'web', 'x-pop3d-account': owner, 'x-csrf-token': String(status.data.csrfToken), 'sec-fetch-site': 'same-origin' };
}
async function send(options: Options = {}) { return call('/api/kakao/send', { method: 'POST', body: INPUT, headers: await mutationHeaders(), ...options }); }
const sentCalls = () => fetchMock.mock.calls.filter(([url]) => url === SEND);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(async () => {
  now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  temp = mkdtempSync(join(tmpdir(), 'pop3d-kakao-talk-test-')); path = join(temp, 'accounts.sqlite');
  env = { POP3D_ACCOUNT_DB: path, KAKAO_REST_API_KEY: 'synthetic-rest-key', KAKAO_CLIENT_SECRET: 'synthetic-secret', KAKAO_REDIRECT_URI: `${ORIGIN}${CALLBACK}`, POP3D_PUBLIC_URL: PUBLIC };
  for (const [id, value] of [['owner-a', 'a'], ['owner-b', 'b']]) {
    await accountStore(env).createUser(id, id, 'unused-password'); await accountStore(env).issueSession('', sha(value.repeat(64)), id, now + 7 * 24 * 3600_000);
  }
  agreed = true; using = true; subject = '1285016924429472463';
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input === 'https://kauth.kakao.com/oauth/token') return response(String(init?.body).includes('grant_type=refresh_token') ? { access_token: 'synthetic-refreshed', expires_in: 3600 } : TOKENS);
    if (input === 'https://kapi.kakao.com/v1/user/access_token_info') return new Response(`{"id":${subject},"app_id":4321,"expires_in":3600}`);
    if (input.startsWith('https://kapi.kakao.com/v2/user/me?')) return new Response(`{"id":${subject},"has_signed_up":true}`);
    if (input === 'https://kapi.kakao.com/v2/user/scopes') return response({ scopes: [{ id: 'talk_message', agreed, using }] });
    if (input === SEND) return response({ result_code: 0 }); throw new Error('Unexpected external request blocked by test');
  });
  vi.stubGlobal('fetch', fetchMock); shareMock.mockReset().mockResolvedValue(SHARE);
});
afterEach(() => {
  closeAccountDatabase(path); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (dirname(resolve(temp)) === resolve(tmpdir()) && basename(temp).startsWith('pop3d-kakao-talk-test-')) rmSync(temp, { recursive: true });
});

describe('Talk configuration', () => {
  it('exposes only configuration names; anonymous use cannot connect or send', async () => {
    const status = await call('/api/kakao/status', { cookie: '', env: { ...env, KAKAO_REST_API_KEY: undefined } });
    expect(status.data).toMatchObject({ configured: false, missing: ['KAKAO_REST_API_KEY'], connected: false, csrfToken: null }); expect(status.body).not.toContain('synthetic-secret');
    expect((await call('/api/auth/kakao/start?returnTo=report', { cookie: '' })).headers.location).toBe('/#/report?error=login_required');
    expect((await send({ cookie: '' })).data.error).toBe('login_required'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses the configured callback, talk scope and a secure Lax state cookie', async () => {
    const settings = { ...env, KAKAO_REDIRECT_URI: `${PUBLIC}${CALLBACK}`, POP3D_PUBLIC_URL: undefined }, flow = await start({ env: settings });
    expect(flow.state).toMatch(/^talk_[A-Za-z0-9_-]{43}$/); expect(flow.authorize.origin).toBe('https://kauth.kakao.com'); expect(flow.authorize.searchParams.get('scope')).toBe('talk_message');
    expect(flow.headers['set-cookie']).toEqual([expect.stringContaining('HttpOnly; SameSite=Lax; Max-Age=600; Secure')]); expect((await call('/api/kakao/status', { env: settings })).data.publicUrlReady).toBe(true);
    expect((await call('/api/auth/kakao/start?returnTo=report', { headers: { host: 'attacker.example.com' } })).headers.location).toBe(`${ORIGIN}/api/auth/kakao/start?returnTo=report`);
    expect((await call('/api/kakao/status', { env: { ...env, KAKAO_REDIRECT_URI: `http://pop3d.example.com${CALLBACK}` } })).data.reason).toBe('invalid_redirect');
  });
  it.each(['http://pop3d.example.com', 'https://localhost', 'https://dev.local', 'https://192.168.1.7', 'https://127.1', 'https://2130706433', 'https://[::1]', 'https://user:password@pop3d.example.com', 'https://pop3d.example.com/#x'])('rejects unsafe public URL %s', value => expect(isPublicHttpsUrl(value)).toBe(false));
  it('preserves account callback routing and rejects cross-site start or wrong method', async () => {
    expect((await call(`${CALLBACK}?state=account_synthetic&code=x`)).handled).toBe(false); expect((await call('/api/kakao/send')).status).toBe(405);
    expect((await call('/api/auth/kakao/start', { headers: { 'sec-fetch-site': 'cross-site' } })).headers.location).toBe('/#/kakao?error=origin_invalid'); expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('persistent OAuth and account isolation', () => {
  it('persists demo return over reopen, ignores callback returnTo and never auto-sends', async () => {
    const flow = await start({}, 'demo'); closeAccountDatabase(path);
    expect((await call(`${CALLBACK}?state=${flow.state}&code=x&returnTo=https://attacker.example.com`, { cookie: flow.cookie })).headers.location).toBe('/#/demo');
    expect((await call('/api/kakao/status')).data.connected).toBe(true); expect(sentCalls()).toHaveLength(0);
    const ordinary = await start();
    expect((await call(`${CALLBACK}?state=${ordinary.state}&code=x&returnTo=demo`, { cookie: ordinary.cookie })).headers.location).toBe('/#/report?kakao=connected');
  });
  it('preserves demo canonical redirects and failure paths without accepting arbitrary destinations', async () => {
    expect((await call('/api/auth/kakao/start?returnTo=demo', { headers: { host: 'preview.example.com' } })).headers.location).toBe(`${ORIGIN}/api/auth/kakao/start?returnTo=demo`);
    expect((await call('/api/auth/kakao/start?returnTo=demo', { cookie: '' })).headers.location).toBe('/#/demo?error=login_required');
    const denied = await start({}, 'demo');
    expect((await call(`${CALLBACK}?state=${denied.state}&error=denied`, { cookie: denied.cookie })).headers.location).toBe('/#/demo?error=authorization_denied');
    const expired = await start({}, 'demo'); now += 600_000;
    expect((await call(`${CALLBACK}?state=${expired.state}&code=x`, { cookie: expired.cookie })).headers.location).toBe('/#/demo?error=state_invalid');
    for (const target of ['https://attacker.example.com', '//attacker.example.com', '/demo']) {
      const flow = await start({}, target);
      expect((await call(`${CALLBACK}?state=${flow.state}&code=x`, { cookie: flow.cookie })).headers.location).toBe('/#/kakao?kakao=connected');
    }
    expect((await call('/api/auth/kakao/start?returnTo=demo&returnTo=report', { headers: { host: 'preview.example.com' } })).headers.location).toBe(`${ORIGIN}/api/auth/kakao/start`);
  });
  it('finishes after reopen without Strict account cookie, encrypts tokens, rejects replay and never auto-sends', async () => {
    const flow = await start(); closeAccountDatabase(path);
    expect((await call(`${CALLBACK}?state=${flow.state}&code=x`, { cookie: flow.cookie })).headers.location).toBe('/#/report?kakao=connected'); closeAccountDatabase(path);
    expect((await call('/api/kakao/status')).data).toMatchObject({ connected: true, canSend: true }); expect((await call('/api/kakao/status', { cookie: B })).data.reason).toBe('not_connected');
    const row = (await accountStore(env).query<{ body: string }>('SELECT body FROM kakao_connections WHERE user_id = ?', ['owner-a']))[0];
    expect(row.body).toMatch(/^v1\./); expect(row.body).not.toContain(TOKENS.access_token); expect(row.body).not.toContain(TOKENS.refresh_token);
    const count = fetchMock.mock.calls.length; expect((await call(`${CALLBACK}?state=${flow.state}&code=x`, { cookie: flow.cookie })).headers.location).toContain('state_invalid');
    expect(fetchMock).toHaveBeenCalledTimes(count); expect(sentCalls()).toHaveLength(0);
  });
  it('consumes browser-mismatched states and rejects duplicate cookies, expiry, logout or changed account', async () => {
    const flow = await start(), other = await start();
    for (const cookie of [other.cookie, flow.cookie]) expect((await call(`${CALLBACK}?state=${flow.state}&code=x`, { cookie })).headers.location).toContain('state_invalid');
    expect((await call(`${CALLBACK}?state=${other.state}&code=x`, { cookie: `${other.cookie}; ${other.cookie}` })).headers.location).toContain('state_invalid');
    const expired = await start(); now += 600_000; expect((await call(`${CALLBACK}?state=${expired.state}&code=x`, { cookie: expired.cookie })).headers.location).toContain('state_invalid');
    const switched = await start(); expect((await call(`${CALLBACK}?state=${switched.state}&code=x`, { cookie: `${switched.cookie}; ${B}` })).headers.location).toContain('account_changed');
    const loggedOut = await start(); await accountStore(env).deleteSession(sha('a'.repeat(64)));
    expect((await call(`${CALLBACK}?state=${loggedOut.state}&code=x`, { cookie: loggedOut.cookie })).headers.location).toContain('login_required'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects mismatched Kakao identity for social accounts and binds encrypted data to owner/config', async () => {
    const user = await accountStore(env).kakaoUser('4321', '1285016924429472464'); await accountStore(env).issueSession('', sha('c'.repeat(64)), user.id, now + 600_000);
    const flow = await start({ cookie: `pop3d_account=${'c'.repeat(64)}` }); expect((await call(`${CALLBACK}?state=${flow.state}&code=x`, { cookie: flow.cookie })).headers.location).toContain('different_kakao_account');
    await connect(); await accountStore(env).query('INSERT INTO kakao_connections (user_id, body, config_id, version) SELECT ?, body, config_id, version FROM kakao_connections WHERE user_id = ?', ['owner-b', 'owner-a']);
    expect((await call('/api/kakao/status', { cookie: B })).data.reason).toBe('reconnect_required'); expect((await call('/api/kakao/status', { env: { ...env, KAKAO_CLIENT_SECRET: 'different-secret' } })).data.reason).toBe('reconnect_required');
  });
  it('returns static provider errors without echoing private details', async () => {
    const denied = await start(); expect((await call(`${CALLBACK}?state=${denied.state}&error=private-code&error_description=secret`, { cookie: denied.cookie })).headers.location).toBe('/#/report?error=authorization_denied');
    const failed = await start(); fetchMock.mockRejectedValueOnce(new Error('secret token')); expect((await call(`${CALLBACK}?state=${failed.state}&code=x`, { cookie: failed.cookie })).headers.location).toBe('/#/report?error=token_exchange_failed');
  });
  it.each(['unagreed', 'disabled'])('does not allow sending for %s talk scope', async state => {
    agreed = state !== 'unagreed'; using = state !== 'disabled'; await connect(); expect((await call('/api/kakao/status')).data).toMatchObject({ connected: true, canSend: false, reason: 'message_permission_required' });
    expect((await send()).data.error).toBe('message_permission_required'); expect(sentCalls()).toHaveLength(0);
  });
});

describe('refresh, CSRF and disconnect', () => {
  it('persists refreshed access and retains refresh token when provider does not rotate it', async () => {
    await connect(); now += 3600_000; closeAccountDatabase(path); expect((await call('/api/kakao/status')).data.connected).toBe(true);
    now += 3600_000; closeAccountDatabase(path); expect((await call('/api/kakao/status')).data.connected).toBe(true);
    const calls = fetchMock.mock.calls.filter(([url, init]) => url === 'https://kauth.kakao.com/oauth/token' && String(init.body).includes('grant_type=refresh_token'));
    expect(calls).toHaveLength(2); for (const [, init] of calls) expect(new URLSearchParams(String(init.body)).get('refresh_token')).toBe(TOKENS.refresh_token);
    expect(JSON.stringify(await accountStore(env).query('SELECT * FROM kakao_connections'))).not.toContain('synthetic-refreshed');
  });
  it('serializes parallel refresh, preserves transient failures, removes revoked refresh tokens', async () => {
    await connect(); now += 3600_000; const entered = deferred<void>(), release = deferred<Response>();
    fetchMock.mockImplementationOnce(async () => { entered.resolve(); return release.promise; }); const first = call('/api/kakao/status'); await entered.promise;
    expect((await call('/api/kakao/status')).data.reason).toBe('connection_busy'); release.resolve(response({ access_token: 'fresh', expires_in: 3600 })); expect((await first).data.connected).toBe(true);
    now += 3600_000; fetchMock.mockRejectedValueOnce(new Error('private transient error')); expect((await call('/api/kakao/status')).data.reason).toBe('upstream_unavailable'); expect(await accountStore(env).query('SELECT user_id FROM kakao_connections')).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(response({ error: 'invalid_grant' }, 400)); expect((await call('/api/kakao/status')).data.reason).toBe('reconnect_required'); expect(await accountStore(env).query('SELECT user_id FROM kakao_connections')).toHaveLength(0);
  });
  it('checks owner/client/origin/session CSRF before any send or disconnect, and isolates the other owner', async () => {
    await connect(); await connect({ cookie: B }); const headers = await mutationHeaders();
    const cases: [Record<string, string>, string][] = [[{ 'x-pop3d-account': 'owner-b' }, 'account_changed'], [{ 'x-pop3d-client': '' }, 'origin_invalid'], [{ origin: 'https://attacker.example.com' }, 'origin_invalid'], [{ 'x-csrf-token': 'wrong' }, 'csrf_invalid']];
    for (const [override, code] of cases) { expect((await send({ headers: { ...headers, ...override } })).data.error).toBe(code); expect((await call('/api/kakao/disconnect', { method: 'POST', headers: { ...headers, ...override } })).data.error).toBe(code); }
    const bHeaders = await mutationHeaders(B, 'owner-b'); expect((await send({ cookie: B, headers: { ...bHeaders, 'x-csrf-token': headers['x-csrf-token'] } })).data.error).toBe('csrf_invalid');
    expect(shareMock).not.toHaveBeenCalled(); expect(sentCalls()).toHaveLength(0);
    expect((await call('/api/kakao/disconnect', { method: 'POST', headers })).data.connected).toBe(false); expect((await call('/api/kakao/status')).data.connected).toBe(false); expect((await call('/api/kakao/status', { cookie: B })).data.connected).toBe(true);
  });
});

describe('send confirmation and idempotency', () => {
  it('creates a server-only template and confirmed request survives reopen without sending twice', async () => {
    await connect(); shareMock.mockResolvedValue({ ...SHARE, title: '기획😀'.repeat(150) }); const result = await send(); expect(result.status).toBe(200); expect(result.data).toEqual({ ok: true, url: SHARE.url, expiresAt: SHARE.expiresAt });
    expect(shareMock).toHaveBeenCalledWith(env, 'owner-a', INPUT); const [, init] = sentCalls()[0], form = new URLSearchParams(String(init.body)), template = JSON.parse(form.get('template_object')!);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKENS.access_token}`); expect([...template.text]).toHaveLength(200); expect(template.link).toEqual({ web_url: SHARE.url, mobile_web_url: SHARE.url }); expect(form.has('receiver_uuids')).toBe(false);
    expect(template.text.split('\n').at(-1)).toBe(SHARE.url); expect(template.text).toContain('팝업 기획보고서 v1'); expect(template.text).not.toMatch(/[\uD800-\uDFFF]/u);
    closeAccountDatabase(path); expect((await send()).data).toEqual(result.data); expect(sentCalls()).toHaveLength(1); expect(shareMock).toHaveBeenCalledTimes(1); expect((await send({ body: { ...INPUT, version: 2 } })).data.error).toBe('request_conflict');
  });
  it.each([
    `http://127.0.0.1:5174/#/shared/${SHARE.token}`,
    `https://127.0.0.1/#/shared/${SHARE.token}`,
    `https://other.example.com/#/shared/${SHARE.token}`,
    `${PUBLIC}/#/report`, `${PUBLIC}/nested/#/shared/${SHARE.token}`,
    `${PUBLIC}/?redirect=local#/shared/${SHARE.token}`,
    `${PUBLIC}/#/shared/${SHARE.token.slice(1)}`,
    `https://user:pass@pop3d.example.com/#/shared/${SHARE.token}`,
  ])('rejects unsafe cached link %s without deleting the sent record or sending again', async url => {
    await connect(); expect((await send()).status).toBe(200);
    const stored = JSON.stringify({ ok: true, url, expiresAt: SHARE.expiresAt });
    await accountStore(env).query('UPDATE kakao_sends SET result = ? WHERE user_id = ? AND request_id = ?', [stored, 'owner-a', INPUT.requestId]);
    closeAccountDatabase(path);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await send(); expect(result.status).toBe(409); expect(result.data).toEqual({ error: 'report_link_invalid' }); expect(result.body).not.toContain(url);
    }
    expect(sentCalls()).toHaveLength(1); expect(shareMock).toHaveBeenCalledTimes(1);
    expect(await accountStore(env).query('SELECT state, result FROM kakao_sends WHERE user_id = ? AND request_id = ?', ['owner-a', INPUT.requestId])).toEqual([{ state: 'sent', result: stored }]);
  });
  it('rejects malformed cached receipts and links for the previous public origin without retransmission', async () => {
    await connect(); const receipt = await send(); expect(receipt.status).toBe(200);
    env.POP3D_PUBLIC_URL = 'https://new.example.com'; expect((await send()).data.error).toBe('report_link_invalid');
    env.POP3D_PUBLIC_URL = PUBLIC;
    await accountStore(env).query('UPDATE kakao_sends SET result = ? WHERE user_id = ? AND request_id = ?', ['{broken', 'owner-a', INPUT.requestId]);
    expect((await send()).data.error).toBe('report_link_invalid'); expect(sentCalls()).toHaveLength(1);
  });
  it('claims concurrent requests atomically and rechecks Talk identity before dispatch', async () => {
    await connect(); const headers = await mutationHeaders(), entered = deferred<void>(), release = deferred<typeof SHARE>(); shareMock.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const first = send({ headers }); await entered.promise; expect((await send({ headers })).data.error).toBe('send_in_progress'); subject = '1285016924429472464'; await connect();
    release.resolve(SHARE); expect((await first).data.error).toBe('account_changed'); expect(sentCalls()).toHaveLength(0);
  });
  it('validates input/body limits and preserves only safe report errors', async () => {
    await connect(); const headers = await mutationHeaders(); for (const body of ['{not-json', { ...INPUT, recipient: 'someone' }, { ...INPUT, requestId: 'short' }]) expect((await send({ headers, body })).data.error).toBe('request_invalid');
    expect((await send({ headers, body: { ...INPUT, pdfBase64: 'a'.repeat(3_800_000) } })).data.error).toBe('pdf_too_large');
    shareMock.mockRejectedValueOnce(Object.assign(new Error('private database detail'), { status: 404, code: 'report_not_found' })); const missing = await send({ headers }); expect(missing.status).toBe(404); expect(missing.data.error).toBe('report_not_found'); expect(missing.body).not.toContain('private');
    shareMock.mockRejectedValueOnce(new Error('private connection string')); expect((await send({ headers })).data.error).toBe('temporarily_unavailable'); expect(sentCalls()).toHaveLength(0);
  });
  it.each([[400, { code: -2, msg: 'private' }, 'message_configuration_required'], [403, { code: -402 }, 'message_permission_required'], [401, { code: -401 }, 'reconnect_required'], [429, { code: -10 }, 'rate_limited'], [200, { result_code: -1 }, 'message_send_failed']] as const)('does not claim success on definite provider failure %s', async (status, payload, code) => {
    await connect(); const headers = await mutationHeaders(), base = fetchMock.getMockImplementation()!; fetchMock.mockImplementation(async (url, init) => url === SEND ? response(payload, status) : base(url, init));
    const failed = await send({ headers }); expect(failed.data).toEqual({ error: code }); expect(failed.body).not.toContain('private'); expect(await accountStore(env).query('SELECT request_id FROM kakao_sends')).toHaveLength(0);
  });
  it.each(['network', 'missing-result', 'server-error'])('never silently repeats an ambiguous %s delivery', async mode => {
    await connect(); const headers = await mutationHeaders(), base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => { if (url !== SEND) return base(url, init); if (mode === 'network') throw new Error('private network detail'); return response({}, mode === 'server-error' ? 500 : 200); });
    expect((await send({ headers })).data.error).toBe('delivery_unknown'); expect((await send({ headers })).data.error).toBe('delivery_unknown'); expect(sentCalls()).toHaveLength(1);
  });
  it('limits sending attempts before making another report', async () => {
    await connect(); const headers = await mutationHeaders(); for (let i = 0; i < 20; i++) await accountStore(env).allowAttempt(sha('kakao-send:owner-a'), now, 20);
    expect((await send({ headers })).data.error).toBe('rate_limited'); expect(shareMock).not.toHaveBeenCalled(); expect(sentCalls()).toHaveLength(0);
  });
});
