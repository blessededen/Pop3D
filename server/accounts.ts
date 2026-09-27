import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Env } from './ai.ts';
import { accountStore, type AccountStore, type AccountUser } from './accountStore.ts';
import { readJsonBody } from './http.ts';
import type { KakaoAccountState } from './kakaoAccount.ts';
export { closeAccountDatabase } from './accountStore.ts';

const COOKIE = 'pop3d_account';
const TTL = 7 * 24 * 60 * 60 * 1000;
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function token(req: IncomingMessage) {
  return (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
}

async function userFor(req: IncomingMessage, db: AccountStore): Promise<AccountUser | undefined> {
  const value = token(req);
  if (!/^[a-f0-9]{64}$/.test(value)) return;
  return db.userForSession(hashToken(value), Date.now());
}

/** Server routes resolve ownership from the normal account session. */
export async function accountUser(req: IncomingMessage, env: Env) {
  if (!accountSessionHash(req)) return;
  return userFor(req, accountStore(env));
}

export function accountSessionHash(req: IncomingMessage): string | undefined {
  const value = token(req);
  return /^[a-f0-9]{64}$/.test(value) ? hashToken(value) : undefined;
}

export function validAccountMutation(req: IncomingMessage, env: Env, user: AccountUser): boolean {
  return sameOrigin(req, env) && req.headers['x-pop3d-account'] === user.id;
}

function secure(req: IncomingMessage, env: Env) {
  return !!env.VERCEL || env.POP3D_PUBLIC_URL?.startsWith('https://') || ('encrypted' in req.socket && req.socket.encrypted);
}

function cookie(req: IncomingMessage, res: ServerResponse, env: Env, value: string, seconds: number) {
  const previous = res.getHeader('Set-Cookie');
  const cookies = previous == null ? [] : Array.isArray(previous) ? previous : [String(previous)];
  res.setHeader('Set-Cookie', [...cookies, `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure(req, env) ? '; Secure' : ''}`]);
}

async function issueSession(req: IncomingMessage, res: ServerResponse, env: Env, db: AccountStore, user: AccountUser) {
  const value = randomBytes(32).toString('hex');
  await db.issueSession(hashToken(token(req)), hashToken(value), user.id, Date.now() + TTL);
  cookie(req, res, env, value, TTL / 1000);
}

async function body(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const value = await readJsonBody(req, max);
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw Object.assign(new Error('요청 형식을 확인해 주세요.'), { status: 400 });
}

const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
async function passwordHash(password: string) { const salt = randomBytes(16).toString('hex'); return `${salt}:${(await derive(password, salt)).toString('hex')}`; }
async function passwordMatches(password: string, stored: string) {
  const valid = /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored);
  const [salt, expected] = (valid ? stored : `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const actual = await derive(password, salt);
  const wanted = Buffer.from(expected, 'hex');
  return valid && actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function sameOrigin(req: IncomingMessage, env: Env) {
  if (req.headers['x-pop3d-client'] !== 'web') return false;
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  const local = `${secure(req, env) ? 'https' : 'http'}://${req.headers.host}`;
  return origin === local || (!!env.POP3D_PUBLIC_URL && origin === new URL(env.POP3D_PUBLIC_URL).origin);
}

function validWorkspace(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const w = value as { spaces?: unknown; vendors?: unknown; projects?: unknown; currentProjectId?: unknown };
  if (!Array.isArray(w.spaces) || !Array.isArray(w.vendors) || !Array.isArray(w.projects) || typeof w.currentProjectId !== 'string') return false;
  if (w.projects.length > 200 || w.spaces.length > 500 || w.vendors.length > 100) return false;
  const records = [...w.spaces, ...w.vendors, ...w.projects];
  if (!records.every(v => v && typeof v === 'object' && typeof v.id === 'string')) return false;
  const idsUnique = (items: Array<{ id: string }>) => new Set(items.map(v => v.id)).size === items.length;
  if (![w.spaces, w.vendors, w.projects].every(idsUnique)) return false;
  const { spaces, vendors, projects } = w;
  return projects.every(p => spaces.some(s => s.id === p.spaceId) && vendors.some(v => v.id === p.vendorId) && Array.isArray(p.placements) && Array.isArray(p.requirements) && Array.isArray(p.versions)) && (!projects.length ? w.currentProjectId === '' : projects.some(p => p.id === w.currentProjectId));
}

/** Account identity is always taken from the HttpOnly session, never the request body. */
export async function handleAccounts(req: IncomingMessage, res: ServerResponse, env: Env): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://local').pathname;
  if (!path.startsWith('/api/account/')) return false;
  try {
    if (req.method !== 'GET' && !sameOrigin(req, env)) { send(res, 403, { message: '같은 사이트에서 다시 요청해 주세요.' }); return true; }
    const db = accountStore(env);
    if (path === '/api/account/session' && req.method === 'GET') { send(res, 200, { user: await userFor(req, db) ?? null }); return true; }
    if ((path === '/api/account/register' || path === '/api/account/login') && req.method === 'POST') {
      const input = await body(req, 8192);
      const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username) || password.length < 10 || password.length > 128) { send(res, 400, { message: '아이디는 영문·숫자 3~40자, 비밀번호는 10~128자로 입력해 주세요.' }); return true; }
      // Vercel replaces this header at its trusted proxy; local servers use the socket address.
      const address = env.VERCEL ? String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim() : req.socket.remoteAddress || 'local';
      if (!await db.allowAttempt(hashToken(`ip:${address}`), Date.now(), 100) || !await db.allowAttempt(hashToken(`user:${username}`))) { send(res, 429, { message: '시도가 많습니다. 15분 뒤 다시 시도해 주세요.' }); return true; }
      if (path.endsWith('/register')) {
        if (await db.userByName(username)) { send(res, 409, { message: '사용할 수 없는 아이디입니다.' }); return true; }
        const passwordRecord = await passwordHash(password);
        const id = randomBytes(16).toString('hex');
        if (!await db.createUser(id, username, passwordRecord)) { send(res, 409, { message: '사용할 수 없는 아이디입니다.' }); return true; }
        await issueSession(req, res, env, db, { id, username });
        send(res, 201, { user: { id, username } });
      } else {
        const user = await db.userByName(username);
        const fallback = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
        const matches = await passwordMatches(password, user?.password || fallback);
        if (!user || !matches) { send(res, 401, { message: '아이디 또는 비밀번호를 확인해 주세요.' }); return true; }
        await issueSession(req, res, env, db, user);
        send(res, 200, { user: { id: user.id, username: user.username } });
      }
      return true;
    }
    const user = await userFor(req, db);
    if (!user) { send(res, 401, { message: '로그인이 필요합니다.' }); return true; }
    if (req.headers['x-pop3d-account'] !== user.id) {
      send(res, 409, { message: '다른 창에서 로그인 계정이 바뀌었습니다. 현재 작업을 백업한 뒤 새로고침해 주세요.' }); return true;
    }
    if (path === '/api/account/logout' && req.method === 'POST') {
      await db.deleteSession(hashToken(token(req)));
      cookie(req, res, env, '', 0); send(res, 200, { ok: true }); return true;
    }
    if (path === '/api/account/workspace' && req.method === 'GET') {
      const row = await db.workspace(user.id);
      send(res, 200, { revision: row?.revision ?? 0, workspace: row ? JSON.parse(row.body) : null }); return true;
    }
    if (path === '/api/account/workspace' && req.method === 'PUT') {
      const input = await body(req, 4_000_000);
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0 || !validWorkspace(input.workspace)) { send(res, 400, { message: '프로젝트 저장 형식을 확인해 주세요.' }); return true; }
      const revision = input.revision as number;
      const serialized = JSON.stringify(input.workspace);
      const changed = await db.saveWorkspace(user.id, revision, serialized);
      if (!changed) { send(res, 409, { message: '다른 창에서 저장한 내용이 있습니다. 현재 작업을 백업한 뒤 새로고침해 주세요.' }); return true; }
      send(res, 200, { revision: revision + 1 }); return true;
    }
    send(res, 404, { message: '찾을 수 없는 요청입니다.' });
  } catch (error) {
    send(res, (error as { status?: number }).status || 500, { message: (error as { status?: number }).status ? (error as Error).message : '계정 저장소에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
  return true;
}

export function kakaoAccountDependencies(env: Env) {
  return {
    saveState: (key: string, value: KakaoAccountState) => accountStore(env).saveState(key, value),
    takeState: (key: string) => accountStore(env).takeState(key),
    signIn: async (app: string, subject: string, req: IncomingMessage, res: ServerResponse) => {
      const db = accountStore(env);
      const user = await db.kakaoUser(app, subject);
      await issueSession(req, res, env, db, user);
    },
  };
}
