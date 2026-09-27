import { create } from 'zustand';
import { addFixtureIntent, removeFixtureIntent, replaceFixtureIntent } from './domain/requirements';
import { normRot, round } from './domain/geometry';
import { findSpot, newPlacementId, proposePlan, type PlanResult } from './domain/planner';
import { josa } from './domain/josa';
import { fixtureHeightStatus } from './domain/placementRules';
import { cloneFees, demoProject, demoSpace, demoVendor } from './domain/seed';
import { hasBlockingIssues, indexItems, validateLayout } from './domain/validate';
import { draftData, makeSnapshot, layoutHash } from './domain/version';
import type { Placement, Project, Space, Vendor } from './domain/types';
import { safeGet, safeRemove, safeSet } from './lib/browser';

const KEY = 'pop3d:v1';
let workspaceLocked = false;
export function lockWorkspace(value: boolean) { workspaceLocked = value; }

export interface Persisted {
  spaces: Space[];
  vendors: Vendor[];
  projects: Project[];
  currentProjectId: string;
}

type DraftPart = Pick<Project, 'name' | 'event' | 'budget' | 'requirements' | 'placements' | 'fees' | 'memo' | 'spaceId' | 'vendorId' | 'layoutNeedsUpdate'>;

interface UndoEntry {
  projectId: string;
  draft: DraftPart;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'warn' | 'error';
}

interface State extends Persisted {
  selectedId: string | null;
  viewVersion: number | null;
  lastPlan: PlanResult | null;
  undoStack: UndoEntry[];
  toasts: Toast[];
  storageOk: boolean;

  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  select: (id: string | null) => void;
  setViewVersion: (v: number | null) => void;
  checkpoint: () => void;
  undo: () => void;
  updateProject: (fn: (p: Project) => void, opts?: { undo?: boolean }) => void;
  movePlacement: (id: string, x: number, y: number) => void;
  rotatePlacement: (id: string, delta: number) => void;
  removePlacement: (id: string) => void;
  duplicatePlacement: (id: string) => void;
  swapSku: (id: string, sku: string) => void;
  toggleNoOrder: (id: string) => void;
  addItem: (sku: string) => void;
  setItemQuantity: (sku: string, quantity: number) => void;
  setItemPower: (sku: string, needsPower: boolean) => void;
  runPlan: (options?: { preserveQuantities?: boolean }) => PlanResult | null;
  applyPlan: (projectId: string, inputHash: string, plan: PlanResult, undo?: boolean) => boolean;
  clearPlanMessage: () => void;
  confirmVersion: () => { ok: boolean; message: string };
  createProject: (name: string, spaceId: string, vendorId: string) => void;
  duplicateProject: (id: string) => void;
  deleteProject: (id: string) => void;
  switchProject: (id: string) => void;
  upsertSpace: (s: Space) => void;
  deleteSpace: (id: string) => boolean;
  upsertVendor: (v: Vendor) => void;
  resetAll: () => void;
}

function seed(populate = true): Persisted {
  const space = demoSpace();
  const vendor = demoVendor();
  const project = demoProject(space, vendor);
  if (populate) {
    const plan = proposePlan(draftData(project, space, vendor));
    if (plan.ok) project.placements = plan.placements;
  }
  return { spaces: [space], vendors: [vendor], projects: [project], currentProjectId: project.id };
}

function parsePersisted(raw: string): Persisted | null {
  try {
    const p = JSON.parse(raw) as Persisted;
    if (!Array.isArray(p.spaces) || !Array.isArray(p.vendors) || !Array.isArray(p.projects)) return null;
    if (!p.projects.every((x) => p.spaces.some((s) => s.id === x.spaceId) && p.vendors.some((v) => v.id === x.vendorId))) return null;
    if (!p.projects.some((x) => x.id === p.currentProjectId)) p.currentProjectId = p.projects[0]?.id ?? '';
    return p;
  } catch {
    return null;
  }
}

function load(): Persisted {
  const raw = safeGet(KEY);
  return (raw && parsePersisted(raw)) || seed(false);
}

/** 팀원 간 공유·백업용 JSON (참고 스캔 GLB 원본은 브라우저에만 있어 포함되지 않는다) */
export function exportBackup(): string {
  const { spaces, vendors, projects, currentProjectId } = useStore.getState();
  return JSON.stringify({ app: 'pop3d', savedAt: new Date().toISOString(), spaces, vendors, projects, currentProjectId }, null, 1);
}

export function importBackup(raw: string): boolean {
  const p = parsePersisted(raw);
  if (!p) return false;
  useStore.setState({
    spaces: p.spaces,
    vendors: p.vendors,
    projects: p.projects,
    currentProjectId: p.currentProjectId,
    selectedId: null,
    viewVersion: null,
    lastPlan: null,
    undoStack: [],
  });
  return true;
}

function draftOf(p: Project): DraftPart {
  return structuredClone({
    name: p.name,
    event: p.event,
    budget: p.budget,
    requirements: p.requirements,
    placements: p.placements,
    fees: p.fees,
    memo: p.memo,
    spaceId: p.spaceId,
    vendorId: p.vendorId,
    layoutNeedsUpdate: p.layoutNeedsUpdate,
  });
}

let toastSeq = 0;

export const useStore = create<State>()((set, get) => {
  const current = () => get().projects.find((p) => p.id === get().currentProjectId)!;
  const spaceOf = (p: Project) => get().spaces.find((s) => s.id === p.spaceId)!;
  const vendorOf = (p: Project) => get().vendors.find((v) => v.id === p.vendorId)!;

  const pushUndo = () => {
    const p = current();
    set((s) => ({ undoStack: [...s.undoStack.slice(-49), { projectId: p.id, draft: draftOf(p) }] }));
  };

  const mutate = (fn: (p: Project) => void, undo = true) => {
    if (workspaceLocked || get().viewVersion != null) return;
    if (undo) pushUndo();
    set((s) => ({
      lastPlan: null,
      projects: s.projects.map((p) => {
        if (p.id !== s.currentProjectId) return p;
        const next = structuredClone(p);
        fn(next);
        next.updatedAt = new Date().toISOString();
        return next;
      }),
    }));
  };

  const mutatePlacement = (id: string, fn: (pl: Placement) => void, undo = true) =>
    mutate((p) => {
      const pl = p.placements.find((x) => x.id === id);
      if (pl) fn(pl);
    }, undo);

  return {
    ...load(),
    selectedId: null,
    viewVersion: null,
    lastPlan: null,
    undoStack: [],
    toasts: [],
    storageOk: true,

    toast: (text, kind = 'ok') => {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3800);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    select: (id) => set({ selectedId: id }),
    setViewVersion: (v) => set({ viewVersion: v, selectedId: null }),
    checkpoint: () => pushUndo(),
    undo: () => {
      const { undoStack, currentProjectId } = get();
      const idx = [...undoStack].reverse().findIndex((u) => u.projectId === currentProjectId);
      if (idx < 0) return;
      const realIdx = undoStack.length - 1 - idx;
      const entry = undoStack[realIdx];
      set((s) => ({
        lastPlan: null,
        undoStack: s.undoStack.slice(0, realIdx),
        projects: s.projects.map((p) => (p.id === entry.projectId ? { ...p, ...entry.draft, updatedAt: new Date().toISOString() } : p)),
      }));
    },
    updateProject: (fn, opts) => mutate(fn, opts?.undo ?? true),

    movePlacement: (id, x, y) => mutatePlacement(id, (pl) => ((pl.x = round(x)), (pl.y = round(y))), false),
    rotatePlacement: (id, delta) => mutatePlacement(id, (pl) => (pl.rot = normRot(pl.rot + delta))),
    removePlacement: (id) => {
      mutate((p) => {
        const removed = p.placements.find(x => x.id === id);
        if (removed && !removed.noOrder) removeFixtureIntent(p, removed.sku, true);
        p.placements = p.placements.filter((x) => x.id !== id);
      });
      if (get().selectedId === id) set({ selectedId: null });
    },
    duplicatePlacement: (id) => {
      const p = current();
      const src = p.placements.find((x) => x.id === id);
      if (!src) return;
      const sourceItem = vendorOf(p).items.find(i => i.sku === src.sku);
      if (!sourceItem || fixtureHeightStatus(spaceOf(p), sourceItem).blocked) { get().toast('공간 높이 이상의 집기는 추가할 수 없습니다.', 'error'); return; }
      const spot = findSpot(spaceOf(p), indexItems(vendorOf(p).items), p.placements, src.sku, { powerSkus: new Set(p.requirements.filter(r => r.needsPower).map(r => r.sku)) });
      const next: Placement = spot ?? { ...src, id: newPlacementId(), x: round(src.x + 0.3), y: round(src.y + 0.3) };
      mutate((d) => {
        d.placements.push({ ...next, noOrder: src.noOrder });
        const item = vendorOf(p).items.find(i => i.sku === src.sku);
        if (item && !src.noOrder) addFixtureIntent(d, item);
      });
      set({ selectedId: next.id });
      if (!spot) get().toast('빈자리를 찾지 못해 겹친 위치에 복제했습니다. 옮겨서 정리하세요.', 'warn');
    },
    swapSku: (id, sku) => mutate(p => {
      const pl = p.placements.find(x => x.id === id);
      const item = vendorOf(p).items.find(i => i.sku === sku);
      if (!pl || !item || pl.sku === sku) return;
      if (fixtureHeightStatus(spaceOf(p), item).blocked) { get().toast('공간 높이 이상의 규격으로 바꿀 수 없습니다.', 'error'); return; }
      if (!pl.noOrder) replaceFixtureIntent(p, pl.sku, item, p.placements.filter(x => x.sku === pl.sku && !x.noOrder).length);
      pl.sku = sku;
    }),
    toggleNoOrder: (id) => mutate(p => {
      const pl = p.placements.find(x => x.id === id);
      const item = pl && vendorOf(p).items.find(i => i.sku === pl.sku);
      if (!pl || !item) return;
      if (pl.noOrder) addFixtureIntent(p, item); else removeFixtureIntent(p, pl.sku);
      pl.noOrder = !pl.noOrder;
    }),
    addItem: (sku) => {
      const p = current();
      const space = spaceOf(p);
      const candidateItem = vendorOf(p).items.find(i => i.sku === sku);
      if (!candidateItem || fixtureHeightStatus(space, candidateItem).blocked) { get().toast('공간 높이 이상의 집기는 반입 불가입니다. 공간 높이나 집기 규격을 확인해 주세요.', 'error'); return; }
      const spot = findSpot(space, indexItems(vendorOf(p).items), p.placements, sku, { powerSkus: new Set(p.requirements.filter(r => r.needsPower).map(r => r.sku)) });
      const next: Placement = spot ?? { id: newPlacementId(), sku, x: round(space.width / 2), y: round(space.depth / 2), rot: 0, noOrder: false };
      mutate((d) => {
        d.placements.push(next);
        const item = vendorOf(p).items.find(i => i.sku === sku);
        if (item) addFixtureIntent(d, item);
      });
      set({ selectedId: next.id });
      if (!spot) get().toast('놓을 빈자리가 없어 가운데에 두었습니다. 겹침 표시를 확인하세요.', 'warn');
    },

    setItemQuantity: (sku, quantity) => {
      if (!Number.isFinite(quantity)) return;
      const item = vendorOf(current()).items.find(i => i.sku === sku);
      if (!item) return;
      const qty = Math.max(0, Math.min(50, Math.floor(quantity)));
      const previousQty = current().requirements.find(r => r.sku === sku)?.desiredQty ?? 0;
      if (previousQty === qty) return;
      if (qty > previousQty && fixtureHeightStatus(spaceOf(current()), item).blocked) { get().toast('공간 높이 이상의 집기는 수량을 늘릴 수 없습니다.', 'error'); return; }
      mutate(p => {
        if (!qty) {
          const r = p.requirements.find(r => r.sku === sku);
          if (r?.needsPower != null) { r.desiredQty = 0; r.minQty = 0; r.required = false; }
          else p.requirements = p.requirements.filter(r => r.sku !== sku);
        }
        else {
          const requirement = p.requirements.find(r => r.sku === sku);
          if (requirement) { requirement.desiredQty = qty; requirement.minQty = Math.min(requirement.minQty, qty); }
          else p.requirements.push({ category: item.category, sku, required: false, minQty: 0, desiredQty: qty, priority: 2, needsPower: item.needsPower });
        }
        p.layoutNeedsUpdate = true;
      });
    },
    setItemPower: (sku, needsPower) => {
      if (get().viewVersion != null) return;
      const requirement = current().requirements.find(r => r.sku === sku);
      if (!requirement) {
        const item = vendorOf(current()).items.find(i => i.sku === sku);
        if (item) mutate(p => { p.requirements.push({ sku, category: item.category, required: false, minQty: 0, desiredQty: 0, priority: 2, needsPower }); });
        return;
      }
      if (!!requirement.needsPower === needsPower) return;
      mutate(p => { p.requirements.find(r => r.sku === sku)!.needsPower = needsPower; if (p.requirements.find(r => r.sku === sku)!.desiredQty > 0) p.layoutNeedsUpdate = true; });
    },
    runPlan: (options) => {
      if (get().viewVersion != null) return null;
      const p = current();
      const plan = proposePlan(draftData(p, spaceOf(p), vendorOf(p)), options);
      if (plan.ok) {
        mutate((d) => {
          d.placements = plan.placements;
          d.layoutNeedsUpdate = false;
        });
        set({ selectedId: null });
      }
      set({ lastPlan: plan });
      return plan;
    },
    applyPlan: (projectId, inputHash, plan, undo = true) => {
      if (workspaceLocked || get().viewVersion != null || get().currentProjectId !== projectId) return false;
      const p = current();
      if (layoutHash(draftData(p, spaceOf(p), vendorOf(p))) !== inputHash) return false;
      if (plan.ok) {
        mutate(d => { d.placements = plan.placements; d.layoutNeedsUpdate = false; }, undo);
        if (!plan.placements.some(pl => pl.id === get().selectedId)) set({ selectedId: null });
      }
      set({ lastPlan: plan });
      return true;
    },
    clearPlanMessage: () => set({ lastPlan: null }),

    confirmVersion: () => {
      const p = current();
      if (p.layoutNeedsUpdate) return { ok: false, message: '선택한 집기·수량·전원 조건을 자동 배치에 반영해 주세요.' };
      const space = spaceOf(p);
      const vendor = vendorOf(p);
      const issues = validateLayout(draftData(p, space, vendor));
      if (hasBlockingIssues(issues)) {
        return { ok: false, message: `배치 오류 ${issues.filter((i) => i.severity === 'error').length}건을 먼저 해결해야 확정할 수 있습니다.` };
      }
      if (p.placements.length === 0) return { ok: false, message: '배치된 집기가 없습니다.' };
      const snap = makeSnapshot(p, space, vendor);
      const last = p.versions[p.versions.length - 1];
      if (last && last.hash === snap.hash) return { ok: false, message: `${josa(`v${last.version}`, '과/와')} 내용이 같습니다.` };
      mutate((d) => d.versions.push(snap), false);
      return { ok: true, message: `${josa(`v${snap.version}`, '으로/로')} 확정했습니다.` };
    },

    createProject: (name, spaceId, vendorId) => {
      const vendor = get().vendors.find((v) => v.id === vendorId)!;
      const base = demoProject(get().spaces.find((s) => s.id === spaceId)!, vendor);
      const now = new Date().toISOString();
      const p: Project = {
        ...base,
        id: `project-${Date.now().toString(36)}`,
        name,
        spaceId,
        vendorId,
        event: { ...base.event, title: name, brand: '', startDate: '', endDate: '' },
        budget: { amount: null, scope: 'fixtures' },
        requirements: base.requirements.filter((r) => vendor.items.some((i) => i.sku === r.sku)),
        placements: [],
        fees: cloneFees(vendor.services),
        versions: [],
        createdAt: now,
        updatedAt: now,
      };
      set((s) => ({ projects: [...s.projects, p], currentProjectId: p.id, selectedId: null, viewVersion: null, lastPlan: null }));
    },
    duplicateProject: (id) => {
      const src = get().projects.find((p) => p.id === id);
      if (!src) return;
      const now = new Date().toISOString();
      const p: Project = { ...structuredClone(src), id: `project-${Date.now().toString(36)}`, name: `${src.name} 사본`, versions: [], createdAt: now, updatedAt: now };
      set((s) => ({ projects: [...s.projects, p], currentProjectId: p.id, selectedId: null, viewVersion: null, lastPlan: null }));
    },
    deleteProject: (id) => {
      const rest = get().projects.filter((p) => p.id !== id);
      set((s) => ({
        projects: rest,
        currentProjectId: s.currentProjectId === id ? rest[0]?.id ?? '' : s.currentProjectId,
        lastPlan: s.currentProjectId === id ? null : s.lastPlan,
        selectedId: null,
        viewVersion: null,
        undoStack: s.undoStack.filter(entry => entry.projectId !== id),
      }));
    },
    switchProject: (id) => set({ currentProjectId: id, selectedId: null, viewVersion: null, lastPlan: null }),

    upsertSpace: (sp) => {
      if (workspaceLocked) return;
      set((s) => ({
        spaces: s.spaces.some((x) => x.id === sp.id) ? s.spaces.map((x) => (x.id === sp.id ? sp : x)) : [...s.spaces, sp],
        lastPlan: s.projects.find((p) => p.id === s.currentProjectId)?.spaceId === sp.id ? null : s.lastPlan,
      }));
    },
    deleteSpace: (id) => {
      if (get().projects.some((p) => p.spaceId === id) || get().spaces.length <= 1) return false;
      set((s) => ({ spaces: s.spaces.filter((x) => x.id !== id) }));
      return true;
    },
    upsertVendor: (v) => {
      if (workspaceLocked) return;
      set((s) => ({
        vendors: s.vendors.some((x) => x.id === v.id) ? s.vendors.map((x) => (x.id === v.id ? v : x)) : [...s.vendors, v],
        lastPlan: s.projects.find((p) => p.id === s.currentProjectId)?.vendorId === v.id ? null : s.lastPlan,
      }));
    },
    resetAll: () => {
      safeRemove(KEY);
      set({ ...seed(), selectedId: null, viewVersion: null, lastPlan: null, undoStack: [] });
    },
  };
});

// 저장: 변경 후 잠깐 기다렸다가 한 번에
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let browserPersistence = true;
/** Signed-in workspaces are saved through the authenticated server, never to the shared legacy key. */
export function disableBrowserPersistence() { browserPersistence = false; clearTimeout(saveTimer); }
export function emptyAccountWorkspace(): Persisted {
  return { spaces: [demoSpace()], vendors: [demoVendor()], projects: [], currentProjectId: '' };
}
useStore.subscribe((s, prev) => {
  if (!browserPersistence) return;
  if (s.spaces === prev.spaces && s.vendors === prev.vendors && s.projects === prev.projects && s.currentProjectId === prev.currentProjectId) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { spaces, vendors, projects, currentProjectId } = useStore.getState();
    const ok = safeSet(KEY, JSON.stringify({ spaces, vendors, projects, currentProjectId }));
    if (ok !== useStore.getState().storageOk) useStore.setState({ storageOk: ok });
  }, 300);
});

export function useCurrent() {
  const project = useStore((s) => s.projects.find((p) => p.id === s.currentProjectId)!);
  const space = useStore((s) => s.spaces.find((x) => x.id === project.spaceId));
  const vendor = useStore((s) => s.vendors.find((x) => x.id === project.vendorId));
  return { project, space, vendor };
}
