import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoProject, demoSpace, demoVendor } from '../domain/seed';

function fixture(name: string) {
  const space = demoSpace(), vendor = demoVendor(), project = demoProject(space, vendor); project.name = name;
  return { spaces: [space], vendors: [vendor], projects: [project], currentProjectId: project.id };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let cache: Map<string, string>, fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  cache = new Map([['pop3d:v1', JSON.stringify(fixture('legacy private'))]]);
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) }, addEventListener: vi.fn(), location: { hash: '#/' } });
  fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function active() {
  fetchMock.mockResolvedValueOnce(json({ user: { id: 'account-a', username: 'alice' } })).mockResolvedValueOnce(json({ revision: 3, workspace: fixture('A server') }));
  const account = await import('./account'); const { useStore } = await import('../store');
  await account.initializeAccount();
  return { account, useStore };
}

describe('account save and session lifecycle', () => {
  it('loads server-owned projects without silently importing shared browser data', async () => {
    const { account, useStore } = await active();
    expect(useStore.getState().projects.map(p => p.name)).toEqual(['A server']);
    expect(account.useAccount.getState().hasLegacy).toBe(true);
    useStore.getState().updateProject(p => { p.name = 'A edited'; });
    fetchMock.mockResolvedValueOnce(json({ revision: 4 })); await account.flushAccount();
    const save = fetchMock.mock.calls.at(-1)!;
    expect(save[1].headers['X-Pop3D-Account']).toBe('account-a');
    expect(JSON.parse(save[1].body).revision).toBe(3);
    expect(JSON.parse(cache.get('pop3d:v1')!).projects[0].name).toBe('legacy private');
  });
  it('starts a new account empty even if this browser has another workspace', async () => {
    fetchMock.mockResolvedValueOnce(json({ user: { id: 'new-account', username: 'new' } })).mockResolvedValueOnce(json({ revision: 0, workspace: null }));
    const account = await import('./account'); const { useStore } = await import('../store');
    await account.initializeAccount();
    expect(useStore.getState().projects).toEqual([]);
  });
  it('keeps unsaved work and session visible if save or logout fails', async () => {
    const { account, useStore } = await active();
    useStore.getState().updateProject(p => { p.name = 'unsaved'; });
    fetchMock.mockResolvedValueOnce(json({ message: '다른 창에서 계정이 바뀌었습니다.' }, 409));
    await expect(account.signOut()).rejects.toThrow('다른 창');
    expect(account.useAccount.getState()).toMatchObject({ user: { id: 'account-a' }, leaving: false, sync: 'error' });
    expect(useStore.getState().projects[0].name).toBe('unsaved');
    expect(fetchMock.mock.calls.some(call => call[0].endsWith('/logout'))).toBe(false);
  });
  it('locks edits while logout waits, then clears the previous account from memory', async () => {
    const { account, useStore } = await active();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const exiting = account.signOut(); await Promise.resolve(); await Promise.resolve();
    expect(account.useAccount.getState().leaving).toBe(true);
    useStore.getState().updateProject(p => { p.name = 'late edit must not apply'; });
    expect(useStore.getState().projects[0].name).toBe('A server');
    finish(json({ ok: true })); await exiting;
    expect(account.useAccount.getState().user).toBeNull();
    expect(useStore.getState().projects).toEqual([]);
  });
  it('does not duplicate legacy projects when a failed import save is retried', async () => {
    const { account, useStore } = await active();
    fetchMock.mockResolvedValueOnce(json({ message: 'offline' }, 503));
    await expect(account.importLegacyWorkspace()).rejects.toThrow('offline');
    expect(useStore.getState().projects).toHaveLength(2);
    fetchMock.mockResolvedValueOnce(json({ revision: 4 }));
    expect(await account.importLegacyWorkspace()).toBe(true);
    expect(useStore.getState().projects).toHaveLength(2);
    expect(account.useAccount.getState().hasLegacy).toBe(false);
  });
});
