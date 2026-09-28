import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { accountStore, type AccountStore, type AccountUser } from './accountStore.ts';
import { accountSessionHash, accountUser, validAccountMutation } from './accounts.ts';
import { readJsonBody } from './http.ts';
import { prepareReportShare } from './reportShare.ts';

export type KakaoEnv = Record<string, string | undefined>;
export class KakaoError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
type Tokens = { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number; scopes: string[]; app: string; subject: string };
type Connection = { body: string; config_id: string; version: number; refresh_lock: string; refresh_until: number | string };
type OAuthState = { user_id: string; session_hash: string; browser_hash: string; config_id: string; expires: number | string; return_to: string };
type SendResult = { ok: true; url: string; expiresAt: string };
type SendRow = { fingerprint: string; state: string; result: string; created: number | string };
const STATE_COOKIE = 'pop3d_kakao_oauth';
const CALLBACK = '/api/auth/kakao/callback';
const START = '/api/auth/kakao/start';
const TOKEN = 'https://kauth.kakao.com/oauth/token';
const SCOPES = 'https://kapi.kakao.com/v2/user/scopes';
const TOKEN_INFO = 'https://kapi.kakao.com/v1/user/access_token_info';
const USER = 'https://kapi.kakao.com/v2/user/me';
const SEND = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
const STATE_TTL = 10 * 60_000;
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(left: string, right: string) { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

function config(env: KakaoEnv) {
  const clientId = env.KAKAO_REST_API_KEY?.trim() || '', secret = env.KAKAO_CLIENT_SECRET?.trim() || '';
  const missing = [!clientId && 'KAKAO_REST_API_KEY', !secret && 'KAKAO_CLIENT_SECRET'].filter(Boolean) as string[];
  let redirect: URL | undefined;
  try {
    const fallback = env.VERCEL || env.NODE_ENV === 'production' ? '' : `http://127.0.0.1:5174${CALLBACK}`;
    const url = new URL(env.KAKAO_REDIRECT_URI?.trim() || fallback);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) && !url.username && !url.password && !url.search && !url.hash && url.pathname === CALLBACK) redirect = url;
  } catch { /* Never expose configuration values. */ }
  return { clientId, secret, redirect, missing, configured: !missing.length && !!redirect, id: digest(`${clientId}\0${secret}\0${redirect?.href || ''}`) };
}
type Config = ReturnType<typeof config>;
export function isPublicHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search && !isIP(host.replace(/^\[|\]$/g, '')) && host.includes('.') &&
      !/(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host) && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}
function publicOrigin(env: KakaoEnv, cfg: Config) {
  if (env.POP3D_PUBLIC_URL?.trim()) return isPublicHttpsUrl(env.POP3D_PUBLIC_URL.trim()) ? new URL(env.POP3D_PUBLIC_URL.trim()).origin : undefined;
  return isPublicHttpsUrl(cfg.redirect?.origin) ? cfg.redirect!.origin : undefined;
}
function encryptionKey(cfg: Config) { return Buffer.from(hkdfSync('sha256', cfg.secret, 'pop3d-kakao-token-storage-v1', cfg.clientId, 32)); }
function encrypt(tokens: Tokens, userId: string, cfg: Config): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(cfg), iv);
  cipher.setAAD(Buffer.from(`${userId}\0${cfg.id}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
function decrypt(row: Connection, userId: string, cfg: Config): Tokens {
  try {
    if (row.config_id !== cfg.id) throw new Error();
    const [version, iv, tag, body, extra] = row.body.split('.');
    if (version !== 'v1' || extra || !iv || !tag || !body) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(cfg), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${userId}\0${cfg.id}`)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')) as Tokens;
    if (!value.accessToken || !value.refreshToken || !Number.isFinite(value.accessExpiresAt) || !Number.isFinite(value.refreshExpiresAt) || !Array.isArray(value.scopes)) throw new Error();
    return value;
  } catch { throw new KakaoError(401, 'reconnect_required'); }
}
function cookie(req: IncomingMessage) {
  const values = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${STATE_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(STATE_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
function setCookie(res: ServerResponse, value: string, seconds: number, cfg: Config) {
  const previous = res.getHeader('set-cookie'), cookies = previous == null ? [] : Array.isArray(previous) ? previous.map(String) : [String(previous)];
  res.setHeader('set-cookie', [...cookies, `${STATE_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${seconds}${cfg.redirect?.protocol === 'https:' ? '; Secure' : ''}`]);
}
function headers(res: ServerResponse) { res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); }
function json(res: ServerResponse, status: number, body: unknown) { headers(res); res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }
function redirect(res: ServerResponse, location: string, status = 303) { headers(res); res.statusCode = status; res.setHeader('location', location); res.end(); }
function returnTarget(value: string | null | undefined) { return value === 'demo' || value === 'report' ? value : 'kakao'; }
function returnResult(res: ServerResponse, target: string, code: string, success = false) {
  const route = returnTarget(target);
  redirect(res, success && route === 'demo' ? '/#/demo' : `/#/${route}?${success ? 'kakao' : 'error'}=${encodeURIComponent(code)}`);
}
function csrf(user: AccountUser, session: string, cfg: Config) { return createHmac('sha256', encryptionKey(cfg)).update(`csrf\0${user.id}\0${session}`).digest('base64url'); }
function requireMutation(req: IncomingMessage, env: KakaoEnv, user: AccountUser, session: string, cfg: Config) {
  if (req.headers['x-pop3d-account'] !== user.id) throw new KakaoError(409, 'account_changed');
  if (!validAccountMutation(req, env, user)) throw new KakaoError(403, 'origin_invalid');
  const value = req.headers['x-csrf-token'];
  if (typeof value !== 'string' || !equal(value, csrf(user, session, cfg))) throw new KakaoError(403, 'csrf_invalid');
}
function seconds(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function identifier(value: unknown) { const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value; return typeof text === 'string' && /^[1-9]\d{0,18}$/.test(text) && BigInt(text) <= 9223372036854775807n ? text : undefined; }
async function provider(url: string, init: RequestInit, errorCode: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    const raw = await response.text(); if (raw.length > 65536) throw new Error();
    const value = JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => /^\d{16,}$/.test(token) ? JSON.stringify(token) : token)) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    if (!response.ok) {
      if (response.status === 401 || value.code === -401 || value.error === 'invalid_grant') throw new KakaoError(401, 'reconnect_required');
      if (value.code === -402 || value.code === -3) throw new KakaoError(403, 'message_permission_required');
      if (response.status === 429) throw new KakaoError(429, 'rate_limited');
      if (url === SEND && response.status >= 400 && response.status < 500 && response.status !== 408) throw new KakaoError(502, 'message_configuration_required');
      throw new KakaoError(errorCode === 'delivery_unknown' ? 409 : 502, errorCode);
    }
    return value;
  } catch (error) { if (error instanceof KakaoError) throw error; throw new KakaoError(errorCode === 'delivery_unknown' ? 409 : 502, errorCode); }
}
async function readScopes(accessToken: string) {
  const data = await provider(SCOPES, { headers: { Authorization: `Bearer ${accessToken}` } }, 'permission_check_failed');
  if (!Array.isArray(data.scopes)) throw new KakaoError(502, 'permission_check_failed');
  return data.scopes.filter(value => value && typeof value === 'object' && value.agreed === true && value.using !== false && typeof value.id === 'string').map(value => value.id as string);
}
async function identity(accessToken: string) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const info = await provider(TOKEN_INFO, { headers }, 'identity_check_failed');
  const profile = await provider(`${USER}?property_keys=${encodeURIComponent('["has_signed_up"]')}`, { headers }, 'identity_check_failed');
  const app = identifier(info.app_id), subject = identifier(info.id);
  if (!app || !subject || !seconds(info.expires_in) || identifier(profile.id) !== subject || profile.has_signed_up === false) throw new KakaoError(502, 'identity_check_failed');
  return { app, subject };
}
async function connection(db: AccountStore, userId: string) { return (await db.query<Connection>('SELECT body, config_id, version, refresh_lock, refresh_until FROM kakao_connections WHERE user_id = ?', [userId]))[0]; }
async function tokensFor(db: AccountStore, userId: string, cfg: Config): Promise<Tokens> {
  const row = await connection(db, userId); if (!row) throw new KakaoError(401, 'not_connected');
  const tokens = decrypt(row, userId, cfg);
  if (tokens.refreshExpiresAt <= Date.now()) throw new KakaoError(401, 'reconnect_required');
  if (tokens.accessExpiresAt > Date.now() + 30_000) return tokens;
  const lock = random();
  const locked = await db.query('UPDATE kakao_connections SET refresh_lock = ?, refresh_until = ? WHERE user_id = ? AND version = ? AND refresh_until <= ? RETURNING user_id', [lock, Date.now() + 20_000, userId, row.version, Date.now()]);
  if (!locked.length) throw new KakaoError(409, 'connection_busy');
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.secret, refresh_token: tokens.refreshToken });
    const data = await provider(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body }, 'upstream_unavailable');
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192 || !seconds(data.expires_in)) throw new KakaoError(502, 'upstream_unavailable');
    tokens.accessToken = data.access_token; tokens.accessExpiresAt = Date.now() + data.expires_in * 1000;
    if (typeof data.refresh_token === 'string' && data.refresh_token) {
      if (!seconds(data.refresh_token_expires_in)) throw new KakaoError(502, 'upstream_unavailable');
      tokens.refreshToken = data.refresh_token; tokens.refreshExpiresAt = Date.now() + data.refresh_token_expires_in * 1000;
    }
    tokens.scopes = await readScopes(tokens.accessToken);
    const saved = await db.query("UPDATE kakao_connections SET body = ?, version = version + 1, refresh_lock = '', refresh_until = 0 WHERE user_id = ? AND version = ? AND refresh_lock = ? RETURNING user_id", [encrypt(tokens, userId, cfg), userId, row.version, lock]);
    if (!saved.length) throw new KakaoError(401, 'reconnect_required');
    return tokens;
  } catch (error) {
    if (error instanceof KakaoError && error.code === 'reconnect_required') await db.query('DELETE FROM kakao_connections WHERE user_id = ? AND version = ? AND refresh_lock = ?', [userId, row.version, lock]);
    throw error;
  } finally { await db.query("UPDATE kakao_connections SET refresh_lock = '', refresh_until = 0 WHERE user_id = ? AND version = ? AND refresh_lock = ?", [userId, row.version, lock]); }
}

async function callback(req: IncomingMessage, res: ServerResponse, url: URL, env: KakaoEnv, cfg: Config) {
  let target = 'kakao'; setCookie(res, '', 0, cfg);
  try {
    const state = url.searchParams.get('state') || '';
    if (!/^talk_[A-Za-z0-9_-]{43}$/.test(state) || url.searchParams.getAll('state').length !== 1) throw new KakaoError(400, 'state_invalid');
    const db = accountStore(env);
    const [saved] = await db.query<OAuthState>('DELETE FROM kakao_talk_oauth WHERE state = ? RETURNING user_id, session_hash, browser_hash, config_id, expires, return_to', [digest(state)]);
    target = returnTarget(saved?.return_to);
    const browser = cookie(req);
    if (!saved || !browser || !equal(saved.browser_hash, digest(browser)) || Number(saved.expires) <= Date.now() || saved.config_id !== cfg.id) throw new KakaoError(400, 'state_invalid');
    // Cross-site OAuth may omit the Strict account cookie. The single-use state
    // binds the Lax browser cookie to the initiating user's still-live session.
    const owner = await db.userForSession(saved.session_hash, Date.now());
    if (!owner || owner.id !== saved.user_id) throw new KakaoError(401, 'login_required');
    const current = accountSessionHash(req);
    if (current && current !== saved.session_hash) throw new KakaoError(409, 'account_changed');
    if (!cfg.configured || !cfg.redirect) throw new KakaoError(503, 'not_configured');
    if (url.searchParams.has('error')) throw new KakaoError(400, 'authorization_denied');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) throw new KakaoError(400, 'authorization_failed');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.clientId, client_secret: cfg.secret, redirect_uri: cfg.redirect.href, code });
    const data = await provider(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body }, 'token_exchange_failed');
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8192 || typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 8192 || !seconds(data.expires_in) || !seconds(data.refresh_token_expires_in)) throw new KakaoError(502, 'token_exchange_failed');
    const id = await identity(data.access_token);
    const [social] = await db.query<{ kakao_app: string | null; kakao_subject: string | null }>('SELECT kakao_app, kakao_subject FROM users WHERE id = ?', [owner.id]);
    if (social?.kakao_app && (social.kakao_app !== id.app || social.kakao_subject !== id.subject)) throw new KakaoError(409, 'different_kakao_account');
    const scopes = await readScopes(data.access_token);
    const tokens: Tokens = { accessToken: data.access_token, refreshToken: data.refresh_token, accessExpiresAt: Date.now() + data.expires_in * 1000, refreshExpiresAt: Date.now() + data.refresh_token_expires_in * 1000, scopes, ...id };
    if ((await db.userForSession(saved.session_hash, Date.now()))?.id !== owner.id) throw new KakaoError(401, 'login_required');
    await db.query("INSERT INTO kakao_connections (user_id, body, config_id, version, refresh_lock, refresh_until) VALUES (?, ?, ?, 1, '', 0) ON CONFLICT (user_id) DO UPDATE SET body = excluded.body, config_id = excluded.config_id, version = kakao_connections.version + 1, refresh_lock = '', refresh_until = 0", [owner.id, encrypt(tokens, owner.id, cfg), cfg.id]);
    returnResult(res, target, scopes.includes('talk_message') ? 'connected' : 'message_permission_required', scopes.includes('talk_message'));
  } catch (error) { returnResult(res, target, error instanceof KakaoError ? error.code : 'temporarily_unavailable'); }
}

async function sendReport(req: IncomingMessage, res: ServerResponse, env: KakaoEnv, cfg: Config, user: AccountUser, db: AccountStore) {
  let input: Record<string, unknown>;
  try { input = await readJsonBody(req, 3_800_000) as Record<string, unknown>; }
  catch (error) { throw new KakaoError((error as { status?: number })?.status === 413 ? 413 : 400, (error as { status?: number })?.status === 413 ? 'pdf_too_large' : 'request_invalid'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['projectId', 'version', 'pdfBase64', 'requestId'].includes(key)) ||
    typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.requestId) || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 200 ||
    !Number.isSafeInteger(input.version) || Number(input.version) < 1 || typeof input.pdfBase64 !== 'string' || input.pdfBase64.length > 3_500_000) throw new KakaoError(400, 'request_invalid');
  const requestId = input.requestId, fingerprint = digest(JSON.stringify([input.projectId, input.version, input.pdfBase64]));
  const [previous] = await db.query<SendRow>('SELECT fingerprint, state, result, created FROM kakao_sends WHERE user_id = ? AND request_id = ?', [user.id, requestId]);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new KakaoError(409, 'request_conflict');
    if (previous.state === 'sent') { json(res, 200, JSON.parse(previous.result) as SendResult); return; }
    throw new KakaoError(409, ['preparing', 'sending'].includes(previous.state) && Date.now() - Number(previous.created) < 30_000 ? 'send_in_progress' : 'delivery_unknown');
  }
  if (!publicOrigin(env, cfg)) throw new KakaoError(503, 'public_url_required');
  const tokens = await tokensFor(db, user.id, cfg);
  tokens.scopes = await readScopes(tokens.accessToken);
  if (!tokens.scopes.includes('talk_message')) throw new KakaoError(403, 'message_permission_required');
  if (!await db.allowAttempt(digest(`kakao-send:${user.id}`), Date.now(), 20)) throw new KakaoError(429, 'rate_limited');
  const claimed = await db.query("INSERT INTO kakao_sends (user_id, request_id, fingerprint, state, result, created) VALUES (?, ?, ?, 'preparing', '', ?) ON CONFLICT (user_id, request_id) DO NOTHING RETURNING user_id", [user.id, requestId, fingerprint, Date.now()]);
  if (!claimed.length) throw new KakaoError(409, 'send_in_progress');
  let dispatching = false;
  try {
    const share = await prepareReportShare(env, user.id, input);
    if (new URL(share.url).origin !== publicOrigin(env, cfg)) throw new KakaoError(503, 'public_url_required');
    const latest = await connection(db, user.id);
    if (!latest || latest.config_id !== cfg.id) throw new KakaoError(401, 'not_connected');
    const currentTokens = decrypt(latest, user.id, cfg);
    if (currentTokens.app !== tokens.app || currentTokens.subject !== tokens.subject) throw new KakaoError(409, 'account_changed');
    if ((await accountUser(req, env))?.id !== user.id) throw new KakaoError(401, 'login_required');
    const result: SendResult = { ok: true, url: share.url, expiresAt: share.expiresAt };
    const template = { object_type: 'text', text: Array.from(`${share.title}\n팝업 기획보고서 v${share.version}\n배치도와 PDF를 확인하세요.`).slice(0, 200).join(''), link: { web_url: share.url, mobile_web_url: share.url }, button_title: '기획보고서 보기' };
    await db.query("UPDATE kakao_sends SET state = 'sending', result = ?, created = ? WHERE user_id = ? AND request_id = ?", [JSON.stringify(result), Date.now(), user.id, requestId]);
    dispatching = true;
    const response = await provider(SEND, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams({ template_object: JSON.stringify(template) }) }, 'delivery_unknown');
    if (typeof response.result_code !== 'number') throw new KakaoError(409, 'delivery_unknown');
    if (response.result_code !== 0) throw new KakaoError(502, 'message_send_failed');
    await db.query("UPDATE kakao_sends SET state = 'sent' WHERE user_id = ? AND request_id = ?", [user.id, requestId]);
    json(res, 200, result);
  } catch (error) {
    if (!dispatching) await db.query("DELETE FROM kakao_sends WHERE user_id = ? AND request_id = ? AND state = 'preparing'", [user.id, requestId]);
    else if (error instanceof KakaoError && ['reconnect_required', 'message_permission_required', 'rate_limited', 'message_send_failed', 'message_configuration_required'].includes(error.code)) await db.query('DELETE FROM kakao_sends WHERE user_id = ? AND request_id = ?', [user.id, requestId]);
    else await db.query("UPDATE kakao_sends SET state = 'unknown' WHERE user_id = ? AND request_id = ?", [user.id, requestId]);
    if (error instanceof KakaoError) throw error;
    const safeCodes = new Set(['invalid_report', 'invalid_pdf', 'pdf_too_large', 'report_too_large', 'report_not_found', 'public_url_required', 'share_limit']);
    const code = (error as { code?: string })?.code;
    const status = (error as { status?: number })?.status;
    throw new KakaoError(dispatching ? 409 : code && safeCodes.has(code) && status && status >= 400 && status < 600 ? status : 503, dispatching ? 'delivery_unknown' : code && safeCodes.has(code) ? code : 'temporarily_unavailable');
  }
}

/** Account-owned, persistent Talk connection and explicit My Chatroom sending. */
export async function handleKakao(req: IncomingMessage, res: ServerResponse, env: KakaoEnv): Promise<boolean> {
  let url: URL; try { url = new URL(req.url || '/', 'http://local'); } catch { return false; }
  if (!['/api/kakao/status', START, CALLBACK, '/api/kakao/disconnect', '/api/kakao/send'].includes(url.pathname) || (url.pathname === CALLBACK && (url.searchParams.get('state') || '').startsWith('account_'))) return false;
  const method = ['/api/kakao/disconnect', '/api/kakao/send'].includes(url.pathname) ? 'POST' : 'GET';
  if (req.method !== method) { res.setHeader('allow', method); json(res, 405, { error: 'method_not_allowed' }); return true; }
  const cfg = config(env);
  const startTarget = returnTarget(url.searchParams.getAll('returnTo').length === 1 ? url.searchParams.get('returnTo') : undefined);
  if (url.pathname === CALLBACK) { await callback(req, res, url, env, cfg); return true; }
  try {
    if (url.pathname === START && cfg.configured && cfg.redirect && req.headers.host?.toLowerCase() !== cfg.redirect.host.toLowerCase()) { redirect(res, `${cfg.redirect.origin}${START}${startTarget !== 'kakao' ? `?returnTo=${startTarget}` : ''}`, 302); return true; }
    const user = await accountUser(req, env), session = accountSessionHash(req);
    if (url.pathname === '/api/kakao/status') {
      let connected = false, permission = false;
      let reason = !cfg.configured ? cfg.missing.length ? 'not_configured' : 'invalid_redirect' : !user || !session ? 'login_required' : 'not_connected';
      if (cfg.configured && user && session) {
        try { const tokens = await tokensFor(accountStore(env), user.id, cfg); connected = true; permission = (await readScopes(tokens.accessToken)).includes('talk_message'); reason = permission ? '' : 'message_permission_required'; }
        catch (error) { reason = error instanceof KakaoError ? error.code : 'temporarily_unavailable'; }
      }
      const publicUrlReady = !!publicOrigin(env, cfg);
      if (connected && permission && !publicUrlReady) reason = 'public_url_required';
      json(res, 200, { configured: cfg.configured, missing: cfg.missing, connected, messagePermission: permission,
        csrfToken: cfg.configured && user && session ? csrf(user, session, cfg) : null,
        canSend: cfg.configured && connected && permission && publicUrlReady, publicUrlReady, ...(reason ? { reason } : {}) }); return true;
    }
    if (!cfg.configured || !cfg.redirect) throw new KakaoError(503, cfg.missing.length ? 'not_configured' : 'invalid_redirect');
    if (!user || !session) throw new KakaoError(401, 'login_required');
    const db = accountStore(env);
    if (url.pathname === START) {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new KakaoError(403, 'origin_invalid');
      await db.query('DELETE FROM kakao_talk_oauth WHERE expires <= ?', [Date.now()]);
      const state = `talk_${random()}`, browser = random(), target = startTarget;
      await db.query('INSERT INTO kakao_talk_oauth (state, user_id, session_hash, browser_hash, config_id, expires, return_to) VALUES (?, ?, ?, ?, ?, ?, ?)', [digest(state), user.id, session, digest(browser), cfg.id, Date.now() + STATE_TTL, target]);
      setCookie(res, browser, STATE_TTL / 1000, cfg);
      const authorize = new URL('https://kauth.kakao.com/oauth/authorize');
      authorize.search = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirect.href, scope: 'talk_message', state }).toString();
      redirect(res, authorize.href, 302); return true;
    }
    requireMutation(req, env, user, session, cfg);
    if (url.pathname === '/api/kakao/disconnect') {
      await db.query('DELETE FROM kakao_connections WHERE user_id = ?', [user.id]); await db.query('DELETE FROM kakao_talk_oauth WHERE user_id = ?', [user.id]);
      setCookie(res, '', 0, cfg); json(res, 200, { connected: false }); return true;
    }
    await sendReport(req, res, env, cfg, user, db);
  } catch (error) {
    const safe = error instanceof KakaoError ? error : new KakaoError(503, 'temporarily_unavailable');
    if (url.pathname === START) returnResult(res, startTarget, safe.code);
    else json(res, safe.status, { error: safe.code });
  }
  return true;
}
