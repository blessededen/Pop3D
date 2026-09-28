import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KakaoEnv } from './kakao.ts';

export interface KakaoAccountState { browserHash: string; expiresAt: number; configId: string; returnTo?: 'demo' }
export interface KakaoAccountDependencies {
  saveState(stateHash: string, state: KakaoAccountState): Promise<void>;
  /** Atomically remove and return one state, shared by every server instance. */
  takeState(stateHash: string): Promise<KakaoAccountState | undefined>;
  /** Resolve the provider identity and issue the normal Pop3D account session. */
  signIn(appId: string, kakaoUserId: string, req: IncomingMessage, res: ServerResponse): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}

const CALLBACK = '/api/auth/kakao/callback';
const START = '/api/account/kakao/start';
const STATUS = '/api/account/kakao/status';
const COOKIE = 'pop3d_account_oauth';
const PREFIX = 'account_';
const TTL = 10 * 60_000;
const TOKEN = 'https://kauth.kakao.com/oauth/token';
const TOKEN_INFO = 'https://kapi.kakao.com/v1/user/access_token_info';
const USER = 'https://kapi.kakao.com/v2/user/me';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');

function config(env: KakaoEnv) {
  const clientId = env.KAKAO_REST_API_KEY?.trim() || '';
  const clientSecret = env.KAKAO_CLIENT_SECRET?.trim() || '';
  let redirect: URL | undefined;
  try {
    const fallback = env.VERCEL || env.NODE_ENV === 'production' ? '' : `http://127.0.0.1:5174${CALLBACK}`;
    const candidate = new URL(env.KAKAO_REDIRECT_URI?.trim() || fallback);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname);
    if ((candidate.protocol === 'https:' || (candidate.protocol === 'http:' && local)) &&
      !candidate.username && !candidate.password && !candidate.search && !candidate.hash && candidate.pathname === CALLBACK) redirect = candidate;
  } catch { /* Configuration values are never returned to the browser. */ }
  const reason = !clientId || !clientSecret ? 'not_configured' : !redirect ? 'invalid_redirect' : undefined;
  return { clientId, clientSecret, redirect, configured: !reason, reason,
    id: digest(`${clientId}\0${clientSecret}\0${redirect?.href || ''}`) };
}

function browserCookie(req: IncomingMessage) {
  const values = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
function setCookie(res: ServerResponse, value: string, maxAge: number, secure: boolean) {
  const previous = res.getHeader('set-cookie');
  const values = Array.isArray(previous) ? previous.map(String) : previous ? [String(previous)] : [];
  values.push(`${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  res.setHeader('set-cookie', values);
}
function equal(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function responseHeaders(res: ServerResponse) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
}
function redirect(res: ServerResponse, location: string, status = 303) {
  responseHeaders(res);
  res.statusCode = status;
  res.setHeader('location', location);
  res.end();
}
function returnPath(target?: string) { return target === 'demo' ? '/#/demo' : '/#/'; }
function failure(res: ServerResponse, code: string, target?: string) { redirect(res, `${returnPath(target)}?account_error=${code}`); }
function json(res: ServerResponse, status: number, body: unknown) {
  responseHeaders(res);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Preserve Kakao's 64-bit Long IDs before JSON.parse can round them. Quoted
 * strings are consumed whole so their contents are never rewritten. */
function providerData(text: string): Record<string, unknown> {
  if (text.length > 65_536) throw new Error();
  const lossless = text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
    /^\d{16,}$/.test(token) ? JSON.stringify(token) : token);
  const data: unknown = JSON.parse(lossless);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  return data as Record<string, unknown>;
}
class ProviderError extends Error {
  readonly code: 'token_exchange_failed' | 'identity_check_failed';
  constructor(code: 'token_exchange_failed' | 'identity_check_failed') { super(code); this.code = code; }
}
async function providerJson(fetcher: typeof fetch, url: string, init: RequestInit, code: ProviderError['code']) {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    return providerData(await response.text());
  } catch { throw new ProviderError(code); }
}
function identifier(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 9223372036854775807n) return undefined;
  return text;
}
function expires(value: unknown) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }

/** Login and optional Talk linking use different state/cookies. Run this handler
 * before handleKakao; callbacks without the account prefix belong to Talk. */
export async function handleKakaoAccount(req: IncomingMessage, res: ServerResponse, env: KakaoEnv, deps: KakaoAccountDependencies): Promise<boolean> {
  let url: URL;
  try { url = new URL(req.url || '/', 'http://local'); } catch { return false; }
  const state = url.searchParams.get('state') || '';
  const isCallback = url.pathname === CALLBACK && state.startsWith(PREFIX);
  if (url.pathname !== START && url.pathname !== STATUS && !isCallback) return false;
  if (req.method !== 'GET') { res.setHeader('allow', 'GET'); json(res, 405, { error: 'method_not_allowed' }); return true; }
  const cfg = config(env), secure = cfg.redirect?.protocol === 'https:';
  if (url.pathname === STATUS) {
    json(res, 200, { configured: cfg.configured, ...(cfg.reason ? { reason: cfg.reason } : {}) });
    return true;
  }
  const now = deps.now || Date.now;
  if (url.pathname === START) {
    const returnTo = url.searchParams.getAll('returnTo').length === 1 && url.searchParams.get('returnTo') === 'demo' ? 'demo' : undefined;
    if (!cfg.configured || !cfg.redirect) { failure(res, cfg.reason || 'not_configured', returnTo); return true; }
    // A cookie created on localhost/preview cannot return on 127.0.0.1/production.
    // Canonicalize using trusted configuration, never forwarded request headers.
    if (req.headers.host?.toLowerCase() !== cfg.redirect.host.toLowerCase()) {
      redirect(res, `${cfg.redirect.origin}${START}${returnTo ? '?returnTo=demo' : ''}`, 302); return true;
    }
    const stateValue = `${PREFIX}${random()}`, browser = random();
    try {
      await deps.saveState(digest(stateValue), { browserHash: digest(browser), configId: cfg.id, expiresAt: now() + TTL, ...(returnTo ? { returnTo } : {}) });
    } catch { failure(res, 'temporarily_unavailable', returnTo); return true; }
    setCookie(res, browser, TTL / 1000, secure);
    const target = new URL('https://kauth.kakao.com/oauth/authorize');
    // No additional consent scopes: basic app-scoped identity is enough to log in.
    target.search = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId,
      redirect_uri: cfg.redirect.href, state: stateValue }).toString();
    redirect(res, target.href, 302);
    return true;
  }
  setCookie(res, '', 0, secure);
  if (!/^account_[A-Za-z0-9_-]{43}$/.test(state) || url.searchParams.getAll('state').length !== 1) {
    failure(res, 'state_invalid'); return true;
  }
  let saved: KakaoAccountState | undefined;
  try { saved = await deps.takeState(digest(state)); }
  catch { failure(res, 'temporarily_unavailable'); return true; }
  // Only the single-use server state controls the callback destination.
  const returnTo = saved?.returnTo === 'demo' ? 'demo' : undefined;
  const browser = browserCookie(req);
  if (!saved || !browser || !equal(saved.browserHash, digest(browser)) || saved.expiresAt <= now() || saved.configId !== cfg.id) {
    failure(res, 'state_invalid', returnTo); return true;
  }
  if (!cfg.configured || !cfg.redirect) { failure(res, cfg.reason || 'not_configured', returnTo); return true; }
  if (url.searchParams.has('error')) { failure(res, 'authorization_denied', returnTo); return true; }
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) { failure(res, 'authorization_failed', returnTo); return true; }
  try {
    const fetcher = deps.fetch || fetch;
    const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.clientId,
      client_secret: cfg.clientSecret, redirect_uri: cfg.redirect.href, code });
    const tokens = await providerJson(fetcher, TOKEN, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: form }, 'token_exchange_failed');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 8192 || !expires(tokens.expires_in)) throw new ProviderError('token_exchange_failed');
    const headers = { Authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' };
    const info = await providerJson(fetcher, TOKEN_INFO, { headers }, 'identity_check_failed');
    const appId = identifier(info.app_id), tokenUserId = identifier(info.id);
    if (!appId || !tokenUserId || !expires(info.expires_in)) throw new ProviderError('identity_check_failed');
    const profile = await providerJson(fetcher, `${USER}?property_keys=${encodeURIComponent('["has_signed_up"]')}`, { headers }, 'identity_check_failed');
    const userId = identifier(profile.id);
    if (!userId || userId !== tokenUserId || profile.has_signed_up === false) throw new ProviderError('identity_check_failed');
    // Tokens/profile are intentionally not saved or returned. Email/nickname are
    // never identity keys and cannot link this account to a password account.
    await deps.signIn(appId, userId, req, res);
    redirect(res, returnPath(returnTo));
  } catch (error) {
    failure(res, error instanceof ProviderError ? error.code : 'account_unavailable', returnTo);
  }
  return true;
}
