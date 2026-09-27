import { create } from 'zustand';
import { disableBrowserPersistence, emptyAccountWorkspace, importBackup, lockWorkspace, useStore, type Persisted } from '../store';
import { safeGet, safeSet } from './browser';
import { contentHash } from '../domain/version';

export interface AccountUser { id: string; username: string }
type Sync = 'saved' | 'saving' | 'error';
interface AccountState { user: AccountUser | null; loading: boolean; leaving: boolean; sync: Sync; error: string; hasLegacy: boolean }
export const useAccount = create<AccountState>(() => ({ user: null, loading: true, leaving: false, sync: 'saved', error: '', hasLegacy: false }));
let revision = 0;
let saved = '';
let owner: string | null = null;
let stop: (() => void) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let flight: Promise<void> | undefined;
let initialized: Promise<void> | undefined;
let legacy = '';

async function request<T>(path: string, method = 'GET', data?: unknown, expectedOwner?: string): Promise<T> {
  const body = data == null ? undefined : JSON.stringify(data);
  if (body && new TextEncoder().encode(body).byteLength > 4_000_000) throw new Error('저장 용량을 초과했습니다. 작업을 백업한 뒤 오래된 프로젝트나 버전을 정리해 주세요.');
  const response = await fetch(`/api/account/${path}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Pop3D-Client': 'web', ...(expectedOwner ? { 'X-Pop3D-Account': expectedOwner } : {}) }, body });
  if (response.status === 413) throw new Error('저장 용량을 초과했습니다. 작업을 백업한 뒤 오래된 프로젝트나 버전을 정리해 주세요.');
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '서버에 연결하지 못했습니다.');
  return result as T;
}

function workspace(): Persisted {
  const { spaces, vendors, projects, currentProjectId } = useStore.getState();
  return { spaces, vendors, projects, currentProjectId };
}

export async function flushAccount(): Promise<void> {
  clearTimeout(timer);
  if (flight) { await flight; return flushAccount(); }
  if (!owner) return;
  const value = JSON.stringify(workspace());
  if (saved === value) return;
  const activeOwner = owner;
  useAccount.setState({ sync: 'saving', error: '' });
  flight = (async () => {
    try {
      const result = await request<{ revision: number }>('workspace', 'PUT', { revision, workspace: JSON.parse(value) }, activeOwner);
      if (activeOwner !== owner) return;
      revision = result.revision; saved = value;
      useAccount.setState({ sync: 'saved', error: '' });
    } catch (error) {
      useAccount.setState({ sync: 'error', error: (error as Error).message });
      throw error;
    } finally { flight = undefined; }
  })();
  await flight;
  if (activeOwner === owner && JSON.stringify(workspace()) !== saved) await flushAccount();
}

async function activate(user: AccountUser) {
  const result = await request<{ revision: number; workspace: Persisted | null }>('workspace', 'GET', undefined, user.id);
  stop?.(); clearTimeout(timer);
  disableBrowserPersistence();
  if (!importBackup(JSON.stringify(result.workspace ?? emptyAccountWorkspace()))) throw new Error('저장한 프로젝트를 읽지 못했습니다. 원본은 서버에 보관되어 있습니다.');
  owner = user.id; revision = result.revision; saved = JSON.stringify(workspace());
  useAccount.setState({ user, loading: false, sync: 'saved', error: '', hasLegacy: !!legacy && !safeGet(`pop3d:legacy-imported:${user.id}`) });
  stop = useStore.subscribe((next, prev) => {
    if (next.projects === prev.projects && next.spaces === prev.spaces && next.vendors === prev.vendors && next.currentProjectId === prev.currentProjectId) return;
    clearTimeout(timer);
    if (useAccount.getState().sync !== 'saving') useAccount.setState({ sync: 'saving' });
    timer = setTimeout(() => { void flushAccount().catch(() => {}); }, 600);
  });
}

export function initializeAccount() {
  if (!initialized) initialized = (async () => {
    disableBrowserPersistence();
    legacy = safeGet('pop3d:v1') || '';
    try {
      const { user } = await request<{ user: AccountUser | null }>('session');
      if (user) await activate(user);
      else useAccount.setState({ loading: false, user: null, error: '' });
    } catch (error) { useAccount.setState({ loading: false, error: (error as Error).message }); initialized = undefined; }
  })();
  return initialized;
}

export async function signIn(username: string, password: string, register = false) {
  const { user } = await request<{ user: AccountUser }>(register ? 'register' : 'login', 'POST', { username, password });
  await activate(user);
}

export async function signOut() {
  if (useAccount.getState().leaving) return;
  useAccount.setState({ leaving: true }); lockWorkspace(true);
  try {
    await flushAccount();
    await request('logout', 'POST', {}, owner ?? undefined);
    stop?.(); stop = undefined; owner = null; clearTimeout(timer); saved = ''; revision = 0;
    importBackup(JSON.stringify(emptyAccountWorkspace()));
    useStore.setState({ toasts: [] });
    useAccount.setState({ user: null, loading: false, error: '', sync: 'saved' });
    window.location.hash = '#/';
  } finally { lockWorkspace(false); useAccount.setState({ leaving: false }); }
}

export async function importLegacyWorkspace() {
  if (!owner || !legacy) return false;
  // Explicit import only: never attach the shared browser workspace at sign-up/login.
  const old = JSON.parse(legacy) as Persisted;
  const current = workspace();
  const suffix = `-legacy-${contentHash(legacy).slice(0, 12)}`;
  const moved: Persisted = {
    spaces: [...current.spaces, ...old.spaces.map(s => ({ ...s, id: s.id + suffix })).filter(s => !current.spaces.some(existing => existing.id === s.id))],
    vendors: [...current.vendors, ...old.vendors.map(v => ({ ...v, id: v.id + suffix })).filter(v => !current.vendors.some(existing => existing.id === v.id))],
    projects: [...current.projects, ...old.projects.map(p => ({ ...p, id: p.id + suffix, spaceId: p.spaceId + suffix, vendorId: p.vendorId + suffix })).filter(p => !current.projects.some(existing => existing.id === p.id))],
    currentProjectId: old.projects.length ? old.currentProjectId + suffix : current.currentProjectId,
  };
  const ok = importBackup(JSON.stringify(moved));
  if (ok) { await flushAccount(); safeSet(`pop3d:legacy-imported:${owner}`, '1'); useAccount.setState({ hasLegacy: false }); }
  return ok;
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (owner && saved !== JSON.stringify(workspace())) { event.preventDefault(); event.returnValue = ''; }
});
