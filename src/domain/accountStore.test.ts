import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { accountStore, closeAccountDatabase } from '../../server/accountStore';

let temp: string, path: string;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), 'pop3d-account-store-test-')); path = join(temp, 'accounts.sqlite'); });
afterEach(() => {
  closeAccountDatabase(path);
  if (dirname(resolve(temp)) === resolve(tmpdir()) && basename(temp).startsWith('pop3d-account-store-test-')) rmSync(temp, { recursive: true });
});

describe('persistent account storage upgrades', () => {
  it('migrates the previous SQLite schema without replacing accounts, sessions or projects', async () => {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE workspaces (user_id TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL, body TEXT NOT NULL);`);
    const password = `${'a'.repeat(32)}:${'b'.repeat(128)}`;
    const original = JSON.stringify({ currentProjectId: 'previous-project', projects: [{ id: 'previous-project', name: '기존 기획안' }] });
    legacy.prepare('INSERT INTO users VALUES (?, ?, ?)').run('legacy-owner', 'legacy-user', password);
    legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash('legacy-session'), 'legacy-owner', Date.now() + 60_000);
    legacy.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('legacy-owner', 7, original);
    legacy.close();
    const store = accountStore({ POP3D_ACCOUNT_DB: path });
    expect(await store.userByName('legacy-user')).toEqual({ id: 'legacy-owner', username: 'legacy-user', password });
    expect(await store.workspace('legacy-owner')).toEqual({ revision: 7, body: original });
    expect(await store.userForSession(hash('legacy-session'), Date.now())).toEqual({ id: 'legacy-owner', username: 'legacy-user' });
    const social = await store.kakaoUser('app-identity', 'provider-identity');
    expect(social.id).not.toBe('legacy-owner');
    closeAccountDatabase(path);
    const reopened = accountStore({ POP3D_ACCOUNT_DB: path });
    expect(await reopened.workspace('legacy-owner')).toEqual({ revision: 7, body: original });
    expect((await reopened.kakaoUser('app-identity', 'provider-identity')).id).toBe(social.id);
  });
  it('resolves concurrent identical social identities to one owner while separating both app and subject', async () => {
    const store = accountStore({ POP3D_ACCOUNT_DB: path });
    const same = await Promise.all(Array.from({ length: 8 }, () => store.kakaoUser('4321', '1285016924429472463')));
    expect(new Set(same.map(value => value.id)).size).toBe(1);
    const otherApp = await store.kakaoUser('4322', '1285016924429472463');
    const otherSubject = await store.kakaoUser('4321', '1285016924429472464');
    expect(new Set([same[0].id, otherApp.id, otherSubject.id]).size).toBe(3);
    const row = await store.userByName(same[0].username);
    expect(row?.password).toBe('');
    expect(same[0].username).toMatch(/^kakao_[a-f0-9]{32}$/);
    expect(same[0].username).not.toContain('1285016924429472463');
    await store.saveWorkspace(same[0].id, 0, '{"project":"only this owner"}');
    expect(await store.workspace(otherApp.id)).toBeUndefined();
    expect(await store.workspace(otherSubject.id)).toBeUndefined();
  });
  it('preserves pending OAuth state over close/reopen and consumes it exactly once', async () => {
    const stateKey = hash('synthetic-state'), browserHash = hash('synthetic-browser');
    const value = { browserHash, configId: hash('synthetic-config'), expiresAt: Date.now() + 600_000 };
    await accountStore({ POP3D_ACCOUNT_DB: path }).saveState(stateKey, value);
    closeAccountDatabase(path);
    const store = accountStore({ POP3D_ACCOUNT_DB: path });
    const result = await Promise.all(Array.from({ length: 5 }, () => store.takeState(stateKey)));
    expect(result.filter(Boolean)).toEqual([value]);
    closeAccountDatabase(path);
    expect(await accountStore({ POP3D_ACCOUNT_DB: path }).takeState(stateKey)).toBeUndefined();
  });
  it('retains account sessions and compare-and-set project revisions across reopen', async () => {
    const store = accountStore({ POP3D_ACCOUNT_DB: path });
    const user = await store.kakaoUser('4321', '123');
    await store.issueSession('', hash('first-session'), user.id, Date.now() + 600_000);
    expect(await store.saveWorkspace(user.id, 0, '{"project":"first"}')).toBe(true);
    const writes = await Promise.all([store.saveWorkspace(user.id, 1, '{"project":"a"}'), store.saveWorkspace(user.id, 1, '{"project":"b"}')]);
    expect(writes.filter(Boolean)).toHaveLength(1);
    closeAccountDatabase(path);
    const reopened = accountStore({ POP3D_ACCOUNT_DB: path });
    expect((await reopened.userForSession(hash('first-session'), Date.now()))?.id).toBe(user.id);
    expect((await reopened.workspace(user.id))?.revision).toBe(2);
    await reopened.issueSession(hash('first-session'), hash('replacement-session'), user.id, Date.now() + 600_000);
    expect(await reopened.userForSession(hash('first-session'), Date.now())).toBeUndefined();
  });
  it('fails closed on Vercel without DATABASE_URL before creating a SQLite file', () => {
    const nested = join(temp, 'must-not-create', 'accounts.sqlite');
    expect(() => accountStore({ VERCEL: '1', POP3D_ACCOUNT_DB: nested })).toThrow('Persistent account database is not configured.');
    expect(existsSync(dirname(nested))).toBe(false);
    expect(existsSync(nested)).toBe(false);
  });
});
