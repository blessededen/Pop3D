import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

export type KakaoEnv = Record<string, string | undefined>;
export interface KakaoSession {
  id: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  expiresAt: number;
  scope: Set<string>;
  csrfToken: string;
  configId: string;
}
export class KakaoError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Single-process memory only: restart loses connections. Multi-instance/serverless
// deployments need a shared session store before using this flow. Never serialize
// these maps or log tokens, authorization codes, or upstream response bodies.
const pending = new Map<string, { browser: string; expiresAt: number; configId: string }>();
const sessions = new Map<string, KakaoSession>();
const refreshes = new Map<string, Promise<void>>();
const STATE_TTL = 10 * 60_000;
const SESSION_TTL = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 1000;
const STATE_COOKIE = 'pop3d_kakao_oauth';
const SESSION_COOKIE = 'pop3d_kakao_session';
const DEFAULT_REDIRECT = 'http://127.0.0.1:5174/api/auth/kakao/callback';
const AUTHORIZE = 'https://kauth.kakao.com/oauth/authorize';
const TOKEN = 'https://kauth.kakao.com/oauth/token';
const SCOPES = 'https://kapi.kakao.com/v2/user/scopes';
const random = () => randomBytes(32).toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const matches = (req.headers.cookie ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
function setCookie(res: ServerResponse, name: string, value: string, maxAge: number, secure: boolean) {
  const previous = res.getHeader('set-cookie');
  const cookies = Array.isArray(previous) ? previous.map(String) : previous ? [String(previous)] : [];
  cookies.push(`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  res.setHeader('set-cookie', cookies);
}
function config(env: KakaoEnv) {
  const clientId = env.KAKAO_REST_API_KEY?.trim() ?? '';
  const clientSecret = env.KAKAO_CLIENT_SECRET?.trim() ?? '';
  const missing = [!clientId && 'KAKAO_REST_API_KEY', !clientSecret && 'KAKAO_CLIENT_SECRET'].filter(Boolean) as string[];
  let redirect: URL | undefined;
  try {
    const candidate = new URL(env.KAKAO_REDIRECT_URI?.trim() || DEFAULT_REDIRECT);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname);
    if ((candidate.protocol === 'https:' || (candidate.protocol === 'http:' && local)) &&
      !candidate.username && !candidate.password && !candidate.search && !candidate.hash &&
      candidate.pathname === '/api/auth/kakao/callback') redirect = candidate;
  } catch { /* Only report fixed codes, never echo configuration. */ }
  const id = createHash('sha256').update(`${clientId}\0${clientSecret}\0${redirect?.href ?? ''}`).digest('hex');
  return { clientId, clientSecret, missing, redirect, id, configured: missing.length === 0 && !!redirect };
}

// Syntax/readiness only, not proof of DNS resolution or external reachability.
// Literal IPs are conservatively excluded; production sharing should use DNS.
export function isPublicHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search &&
      !isIP(host.replace(/^\[|\]$/g, '')) && host.includes('.') &&
      !/(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host) &&
      host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}
function prune() {
  for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
  for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key);
}
export function getKakaoSession(req: IncomingMessage, env: KakaoEnv): KakaoSession | undefined {
  const id = cookieValue(req, SESSION_COOKIE);
  const session = id ? sessions.get(id) : undefined;
  if (!session) return undefined;
  const cfg = config(env);
  if (!cfg.configured || session.configId !== cfg.id || session.expiresAt <= Date.now()) {
    sessions.delete(session.id);
    return undefined;
  }
  return session;
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(JSON.stringify(body));
}
function redirectResult(res: ServerResponse, result: string, success = false) {
  res.statusCode = 303;
  res.setHeader('location', `/#/kakao?${success ? 'kakao' : 'error'}=${encodeURIComponent(result)}`);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end();
}
async function providerJson(url: string, init: RequestInit, code: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (url === SCOPES && response.status === 401) throw new KakaoError(401, 'reconnect_required');
    if (!response.ok) throw new Error();
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof KakaoError) throw error;
    // Upstream errors may contain credentials/codes. Never pass them through.
    throw new KakaoError(502, code);
  }
}
function validSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
async function readScopes(accessToken: string): Promise<Set<string>> {
  const data = await providerJson(SCOPES, { headers: { Authorization: `Bearer ${accessToken}` } }, 'permission_check_failed');
  if (!Array.isArray(data.scopes)) throw new KakaoError(502, 'permission_check_failed');
  const scopes = new Set<string>();
  for (const entry of data.scopes) {
    if (entry && typeof entry === 'object' && entry.agreed === true && typeof entry.id === 'string') scopes.add(entry.id);
  }
  return scopes;
}
async function refreshSession(session: KakaoSession, env: KakaoEnv): Promise<boolean> {
  if (session.accessExpiresAt > Date.now() + 30_000) return false;
  const inFlight = refreshes.get(session.id);
  if (inFlight) { await inFlight; return true; }
  const promise = (async () => {
    const cfg = config(env);
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.clientId,
      client_secret: cfg.clientSecret, refresh_token: session.refreshToken });
    const data = await providerJson(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }, 'reconnect_required');
    if (typeof data.access_token !== 'string' || !data.access_token || !validSeconds(data.expires_in)) throw new KakaoError(401, 'reconnect_required');
    const scope = await readScopes(data.access_token);
    if (sessions.get(session.id) !== session) throw new KakaoError(401, 'reconnect_required');
    session.accessToken = data.access_token;
    session.accessExpiresAt = Date.now() + data.expires_in * 1000;
    session.scope = scope;
    if (typeof data.refresh_token === 'string' && data.refresh_token) session.refreshToken = data.refresh_token;
    if (validSeconds(data.refresh_token_expires_in)) session.expiresAt = Math.min(session.expiresAt, Date.now() + data.refresh_token_expires_in * 1000);
  })();
  refreshes.set(session.id, promise);
  try { await promise; return true; }
  catch { sessions.delete(session.id); throw new KakaoError(401, 'reconnect_required'); }
  finally { refreshes.delete(session.id); }
}
function requireSameOrigin(req: IncomingMessage, env: KakaoEnv) {
  const expected = config(env).redirect?.origin;
  if (!expected || req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') throw new KakaoError(403, 'origin_invalid');
}
function requireCsrf(req: IncomingMessage, session: KakaoSession) {
  const value = req.headers['x-csrf-token'];
  if (typeof value !== 'string' || !safeEqual(value, session.csrfToken)) throw new KakaoError(403, 'csrf_invalid');
}

/** Local connection/permission verification only: this module never sends messages. */
export async function handleKakao(req: IncomingMessage, res: ServerResponse, env: KakaoEnv): Promise<boolean> {
  let url: URL;
  try { url = new URL(req.url ?? '/', 'http://local'); } catch { return false; }
  const known = ['/api/kakao/status', '/api/auth/kakao/start', '/api/auth/kakao/callback', '/api/kakao/disconnect'];
  if (!known.includes(url.pathname)) return false;
  const expectedMethod = url.pathname === '/api/kakao/disconnect' ? 'POST' : 'GET';
  if (req.method !== expectedMethod) {
    res.setHeader('allow', expectedMethod);
    json(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  const cfg = config(env);
  const secure = cfg.redirect?.protocol === 'https:';
  if (url.pathname === '/api/kakao/status') {
    const cookie = cookieValue(req, SESSION_COOKIE);
    const stored = cookie ? sessions.get(cookie) : undefined;
    let reason = !cfg.configured ? (cfg.missing.length ? 'not_configured' : 'invalid_redirect') :
      stored && stored.expiresAt <= Date.now() ? 'session_expired' : cookie ? 'reconnect_required' : 'not_connected';
    let session = getKakaoSession(req, env);
    if (session) {
      const current = session;
      try {
        const refreshed = await refreshSession(current, env);
        if (!refreshed) current.scope = await readScopes(current.accessToken);
        if (sessions.get(current.id) !== current) { session = undefined; reason = 'reconnect_required'; }
      } catch (error) {
        if (error instanceof KakaoError && error.code === 'permission_check_failed') {
          current.scope.clear(); reason = 'permission_check_failed';
        } else { sessions.delete(current.id); session = undefined; reason = 'reconnect_required'; }
      }
    }
    const publicUrlReady = isPublicHttpsUrl(env.POP3D_PUBLIC_URL);
    const messagePermission = !!session?.scope.has('talk_message');
    if (session && reason !== 'permission_check_failed') reason = !messagePermission ? 'message_permission_required' : !publicUrlReady ? 'public_url_required' : '';
    if (cookie && !session) setCookie(res, SESSION_COOKIE, '', 0, secure);
    json(res, 200, { configured: cfg.configured, missing: cfg.missing, connected: !!session,
      csrfToken: session?.csrfToken ?? null, messagePermission, canSend: false, publicUrlReady, ...(reason ? { reason } : {}) });
    return true;
  }
  if (url.pathname === '/api/auth/kakao/start') {
    if (!cfg.configured || !cfg.redirect) {
      redirectResult(res, cfg.missing.length ? 'not_configured' : 'invalid_redirect');
      return true;
    }
    // Canonicalize local aliases before setting a host-only cookie. The target
    // comes only from trusted configuration, never from Host/forwarded headers.
    if (cfg.redirect.protocol === 'http:' && req.headers.host !== cfg.redirect.host) {
      res.statusCode = 302;
      res.setHeader('location', `${cfg.redirect.origin}/api/auth/kakao/start`);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('referrer-policy', 'no-referrer');
      res.end();
      return true;
    }
    prune();
    if (pending.size >= MAX_ENTRIES) { redirectResult(res, 'temporarily_unavailable'); return true; }
    const previous = cookieValue(req, STATE_COOKIE);
    for (const [key, entry] of pending) if (previous && safeEqual(entry.browser, previous)) pending.delete(key);
    const state = random(), browser = random();
    pending.set(state, { browser, expiresAt: Date.now() + STATE_TTL, configId: cfg.id });
    setCookie(res, STATE_COOKIE, browser, STATE_TTL / 1000, secure);
    const target = new URL(AUTHORIZE);
    target.search = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirect.href, scope: 'talk_message', state }).toString();
    res.statusCode = 302;
    res.setHeader('location', target.href);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.end();
    return true;
  }
  if (url.pathname === '/api/auth/kakao/callback') {
    const state = url.searchParams.get('state') ?? '';
    const browser = cookieValue(req, STATE_COOKIE), entry = pending.get(state);
    // Consume before any await: racing callbacks cannot exchange a code twice.
    pending.delete(state);
    setCookie(res, STATE_COOKIE, '', 0, secure);
    if (!entry || !browser || !safeEqual(entry.browser, browser) || entry.expiresAt <= Date.now() || entry.configId !== cfg.id) {
      redirectResult(res, 'state_invalid'); return true;
    }
    if (!cfg.configured || !cfg.redirect) { redirectResult(res, 'not_configured'); return true; }
    if (url.searchParams.has('error')) { redirectResult(res, 'authorization_denied'); return true; }
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) { redirectResult(res, 'authorization_failed'); return true; }
    try {
      const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.clientId,
        client_secret: cfg.clientSecret, redirect_uri: cfg.redirect.href, code });
      const data = await providerJson(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }, 'token_exchange_failed');
      if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' ||
        !data.refresh_token || !validSeconds(data.expires_in) || !validSeconds(data.refresh_token_expires_in)) throw new KakaoError(502, 'token_exchange_failed');
      const scope = await readScopes(data.access_token);
      prune();
      if (sessions.size >= MAX_ENTRIES) throw new KakaoError(503, 'temporarily_unavailable');
      const old = cookieValue(req, SESSION_COOKIE);
      if (old) sessions.delete(old);
      const session: KakaoSession = { id: random(), csrfToken: random(), configId: cfg.id,
        accessToken: data.access_token, refreshToken: data.refresh_token, scope,
        accessExpiresAt: Date.now() + data.expires_in * 1000,
        expiresAt: Date.now() + Math.min(SESSION_TTL, data.refresh_token_expires_in * 1000) };
      sessions.set(session.id, session);
      setCookie(res, SESSION_COOKIE, session.id, Math.floor((session.expiresAt - Date.now()) / 1000), secure);
      redirectResult(res, 'connected', true);
    } catch (error) {
      redirectResult(res, error instanceof KakaoError ? (error.code === 'reconnect_required' ? 'permission_check_failed' : error.code) : 'authorization_failed');
    }
    return true;
  }
  try {
    requireSameOrigin(req, env);
    const session = getKakaoSession(req, env);
    if (session) { requireCsrf(req, session); sessions.delete(session.id); }
    const browser = cookieValue(req, STATE_COOKIE);
    for (const [key, entry] of pending) if (browser && safeEqual(entry.browser, browser)) pending.delete(key);
    // Local disconnect only; Kakao account consent itself is not revoked.
    setCookie(res, STATE_COOKIE, '', 0, secure);
    setCookie(res, SESSION_COOKIE, '', 0, secure);
    json(res, 200, { connected: false });
  } catch (error) {
    const safe = error instanceof KakaoError ? error : new KakaoError(400, 'bad_request');
    json(res, safe.status, { error: safe.code });
  }
  return true;
}
