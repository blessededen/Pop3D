import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import type { Env } from './ai.ts';
import type { KakaoAccountState } from './kakaoAccount.ts';

export type AccountUser = { id: string; username: string };
type UserRow = AccountUser & { password: string };
type Query = <T extends object>(text: string, parameters?: (string | number)[]) => Promise<T[]>;
const stores = new Map<string, AccountStore>();
const databases = new Map<string, DatabaseSync>();
const schema = [
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, kakao_app TEXT, kakao_subject TEXT)',
  'CREATE UNIQUE INDEX IF NOT EXISTS users_kakao_identity ON users (kakao_app, kakao_subject)',
  'CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS workspaces (user_id TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL, body TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS account_oauth (state TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, expires BIGINT NOT NULL, config_id TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS account_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset BIGINT NOT NULL)',
];

/** Parameterized queries use ? internally; only fixed SQL statements enter this adapter. */
export class AccountStore {
  private query: Query;
  constructor(query: Query) { this.query = query; }
  async userForSession(token: string, now: number) {
    return (await this.query<AccountUser>('SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE token = ? AND expires > ?', [token, now]))[0];
  }
  async userByName(username: string) {
    return (await this.query<UserRow>('SELECT id, username, password FROM users WHERE username = ?', [username]))[0];
  }
  async createUser(id: string, username: string, password: string) {
    return !!(await this.query<AccountUser>('INSERT INTO users (id, username, password) VALUES (?, ?, ?) ON CONFLICT (username) DO NOTHING RETURNING id, username', [id, username, password]))[0];
  }
  async kakaoUser(app: string, subject: string) {
    const id = randomBytes(16).toString('hex');
    // The provider identity is unique; concurrent callbacks resolve to the same local owner.
    // Social accounts have no password credential and never auto-link to password accounts.
    const rows = await this.query<AccountUser>(`INSERT INTO users (id, username, password, kakao_app, kakao_subject) VALUES (?, ?, '', ?, ?)
      ON CONFLICT (kakao_app, kakao_subject) DO UPDATE SET kakao_subject = excluded.kakao_subject RETURNING id, username`, [id, `kakao_${id}`, app, subject]);
    return rows[0];
  }
  async issueSession(oldToken: string, token: string, userId: string, expires: number) {
    await this.query('DELETE FROM sessions WHERE expires <= ? OR token = ?', [Date.now(), oldToken]);
    await this.query('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)', [token, userId, expires]);
  }
  async deleteSession(token: string) { await this.query('DELETE FROM sessions WHERE token = ?', [token]); }
  async workspace(userId: string) {
    return (await this.query<{ revision: number; body: string }>('SELECT revision, body FROM workspaces WHERE user_id = ?', [userId]))[0];
  }
  async saveWorkspace(userId: string, revision: number, body: string) {
    const rows = revision === 0
      ? await this.query('INSERT INTO workspaces (user_id, revision, body) VALUES (?, 1, ?) ON CONFLICT (user_id) DO NOTHING RETURNING revision', [userId, body])
      : await this.query('UPDATE workspaces SET revision = revision + 1, body = ? WHERE user_id = ? AND revision = ? RETURNING revision', [body, userId, revision]);
    return rows.length > 0;
  }
  async allowAttempt(key: string, now = Date.now(), limit = 20) {
    await this.query('DELETE FROM account_attempts WHERE reset <= ?', [now]);
    const [row] = await this.query<{ count: number }>(`INSERT INTO account_attempts (key, count, reset) VALUES (?, 1, ?)
      ON CONFLICT (key) DO UPDATE SET count = account_attempts.count + 1 RETURNING count`, [key, now + 15 * 60_000]);
    return row.count <= limit;
  }
  async saveState(state: string, value: KakaoAccountState) {
    await this.query('DELETE FROM account_oauth WHERE expires <= ?', [Date.now()]);
    await this.query('INSERT INTO account_oauth (state, browser_hash, expires, config_id) VALUES (?, ?, ?, ?)', [state, value.browserHash, value.expiresAt, value.configId]);
  }
  async takeState(state: string): Promise<KakaoAccountState | undefined> {
    const [row] = await this.query<{ browser_hash: string; expires: number | string; config_id: string }>('DELETE FROM account_oauth WHERE state = ? RETURNING browser_hash, expires, config_id', [state]);
    return row ? { browserHash: row.browser_hash, expiresAt: Number(row.expires), configId: row.config_id } : undefined;
  }
}

export function accountStore(env: Env): AccountStore {
  const url = env.DATABASE_URL?.trim();
  if (!url && env.VERCEL) throw new Error('Persistent account database is not configured.');
  const path = resolve(env.POP3D_ACCOUNT_DB || '.data/accounts.sqlite');
  const key = url || path;
  const existing = stores.get(key);
  if (existing) return existing;
  let query: Query;
  if (url) {
    const sql = neon(url);
    let ready: Promise<unknown> | undefined;
    query = async <T extends object>(text: string, parameters: (string | number)[] = []) => {
      ready ??= sql.transaction([sql.query('SELECT pg_advisory_xact_lock(739216405)'), ...schema.map(statement => sql.query(statement))]).catch(error => { ready = undefined; throw error; });
      await ready;
      let index = 0;
      return await sql.query(text.replace(/\?/g, () => `$${++index}`), parameters) as T[];
    };
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec(schema[0]);
    const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    for (const column of ['kakao_app', 'kakao_subject']) if (!columns.some(value => value.name === column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
    for (const statement of schema.slice(1)) db.exec(statement);
    databases.set(path, db);
    query = async <T extends object>(text: string, parameters: (string | number)[] = []) => db.prepare(text).all(...parameters) as T[];
  }
  const store = new AccountStore(query);
  stores.set(key, store);
  return store;
}

export function closeAccountDatabase(path: string) {
  const key = resolve(path);
  databases.get(key)?.close(); databases.delete(key); stores.delete(key);
}
