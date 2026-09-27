import { beforeEach, describe, expect, it } from 'vitest';
import { demoProject, demoSpace, demoVendor } from './domain/seed';
import { importBackup, exportBackup, useStore } from './store';
import { validateLayout } from './domain/validate';
import { draftData, layoutHash } from './domain/version';
import { nearestPowerDistance } from './domain/placementRules';
import { replaceFixtureIntent } from './domain/requirements';
import { proposePlan } from './domain/planner';

const current = () => useStore.getState().projects.find(p => p.id === useStore.getState().currentProjectId)!;
const counterSku = () => useStore.getState().vendors[0].items.find(item => item.category === 'counter')!.sku;

beforeEach(() => {
  const space = demoSpace(), vendor = demoVendor(), project = demoProject(space, vendor);
  space.width = 8; space.depth = 8; space.columns = []; space.zones = []; space.fixtures = []; space.doors = [];
  space.powerPoints = [{ id: 'power', label: '전원', x: 4, y: 4 }];
  space.rules.minAisle = null;
  project.requirements = []; project.placements = []; project.versions = []; project.budget.amount = null;
  useStore.setState({ spaces: [space], vendors: [vendor], projects: [project], currentProjectId: project.id, selectedId: null, viewVersion: null, lastPlan: null, undoStack: [] });
});

describe('quantity-first guided layout', () => {
  it('choosing a count leaves the existing layout intact until arrange is requested', () => {
    const s = useStore.getState(), sku = counterSku();
    s.addItem(sku);
    const before = structuredClone(current().placements);
    s.setItemQuantity(sku, 3);
    expect(current().placements).toEqual(before);
    expect(current().requirements.find(r => r.sku === sku)?.desiredQty).toBe(3);
    expect(current().layoutNeedsUpdate).toBe(true);
    expect(s.confirmVersion().ok).toBe(false);
    const result = s.runPlan({ preserveQuantities: true });
    expect(result?.ok).toBe(true);
    expect(current().placements.filter(p => p.sku === sku)).toHaveLength(3);
    expect(current().layoutNeedsUpdate).toBe(false);
    expect(s.confirmVersion().ok).toBe(true);
  });

  it('explicit zero deselects even a previously required fixture', () => {
    const s = useStore.getState(), sku = counterSku();
    s.updateProject(p => { p.requirements = [{ category: 'counter', sku, minQty: 1, desiredQty: 1, required: true, priority: 1 }]; });
    s.setItemQuantity(sku, 0);
    expect(current().requirements).toEqual([]);
    expect(current().placements).toEqual([]);
  });

  it('power choice persists and drives the next arrangement near a registered outlet', () => {
    const s = useStore.getState(), sku = counterSku();
    s.setItemQuantity(sku, 1);
    s.setItemPower(sku, true);
    const backup = exportBackup();
    expect(importBackup(backup)).toBe(true);
    expect(current().requirements[0].needsPower).toBe(true);
    expect(current().layoutNeedsUpdate).toBe(true);
    const result = s.runPlan({ preserveQuantities: true });
    expect(result?.ok).toBe(true);
    expect(nearestPowerDistance(current().placements[0], useStore.getState().spaces[0].powerPoints)).toBeLessThan(.2);
    const data = draftData(current(), useStore.getState().spaces[0], useStore.getState().vendors[0]);
    expect(validateLayout(data).some(issue => issue.severity === 'error')).toBe(false);
  });

  it('a failed arrangement preserves prior placements and the pending condition', () => {
    const s = useStore.getState(), sku = counterSku();
    s.setItemQuantity(sku, 1); s.runPlan({ preserveQuantities: true });
    const placements = structuredClone(current().placements);
    const space = structuredClone(s.spaces[0]); space.width = .5; space.depth = .5; space.powerPoints = [];
    s.upsertSpace(space); s.setItemQuantity(sku, 2);
    expect(s.runPlan({ preserveQuantities: true })?.ok).toBe(false);
    expect(current().placements).toEqual(placements);
    expect(current().layoutNeedsUpdate).toBe(true);
    expect(s.confirmVersion().ok).toBe(false);
  });

  it('undo restores both the chosen quantity and its pending state', () => {
    const s = useStore.getState(), sku = counterSku();
    s.setItemQuantity(sku, 1); s.runPlan({ preserveQuantities: true });
    const placements = structuredClone(current().placements);
    s.setItemQuantity(sku, 2); s.undo();
    expect(current().requirements[0].desiredQty).toBe(1);
    expect(current().layoutNeedsUpdate).toBe(false);
    expect(current().placements).toEqual(placements);
    s.setItemPower(sku, true); s.runPlan({ preserveQuantities: true }); s.undo();
    expect(current().layoutNeedsUpdate).toBe(true);
  });

  it('historical versions reject quantity and power edits', () => {
    const s = useStore.getState(), sku = counterSku();
    s.setItemQuantity(sku, 1); s.runPlan({ preserveQuantities: true }); s.confirmVersion(); s.setViewVersion(1);
    const before = structuredClone(current());
    s.setItemQuantity(sku, 3); s.setItemPower(sku, true);
    expect(s.runPlan({ preserveQuantities: true })).toBeNull();
    expect(current()).toEqual(before);
  });

  it('changing the physical specification retains the power requirement', () => {
    const s = useStore.getState(), sku = counterSku();
    s.setItemQuantity(sku, 2); s.setItemPower(sku, true);
    const item = { ...s.vendors[0].items.find(i => i.sku === sku)!, sku: 'CUSTOM-POWER', w: .9 };
    s.updateProject(p => replaceFixtureIntent(p, sku, item, 2));
    expect(current().requirements.find(r => r.sku === 'CUSTOM-POWER')).toMatchObject({ desiredQty: 1, needsPower: true });
    expect(current().requirements.find(r => r.sku === sku)).toMatchObject({ desiredQty: 1, needsPower: true });
  });
  it('power can be chosen at quantity zero and stays chosen when count changes', () => {
    const s = useStore.getState(), sku = counterSku();
    s.setItemPower(sku, true);
    expect(current().placements).toEqual([]);
    expect(current().requirements[0]).toMatchObject({ desiredQty: 0, needsPower: true });
    s.setItemQuantity(sku, 2); s.setItemQuantity(sku, 0); s.setItemQuantity(sku, 1);
    expect(current().requirements[0]).toMatchObject({ desiredQty: 1, needsPower: true });
  });
  it('explicit deletion also removes the required minimum for that removed unit', () => {
    const s = useStore.getState(), sku = counterSku();
    s.setItemQuantity(sku, 1); s.updateProject(p => { p.requirements[0].required = true; p.requirements[0].minQty = 1; });
    s.runPlan({ preserveQuantities: true }); s.removePlacement(current().placements[0].id);
    expect(current().placements).toEqual([]); expect(current().requirements).toEqual([]);
  });
  it('rejects a worker result after edits changed its input', () => {
    const s = useStore.getState(), sku = counterSku();
    s.setItemQuantity(sku, 1);
    const hash = layoutHash(draftData(current(), s.spaces[0], s.vendors[0]));
    const result = proposePlan(draftData(current(), s.spaces[0], s.vendors[0]), { preserveQuantities: true });
    s.setItemQuantity(sku, 2);
    expect(s.applyPlan(current().id, hash, result)).toBe(false);
    expect(current().requirements[0].desiredQty).toBe(2);
  });
  it('applies a completed worker result only to its matching project input', () => {
    const s = useStore.getState(); s.setItemQuantity(counterSku(), 1);
    const data = draftData(current(), s.spaces[0], s.vendors[0]);
    const result = proposePlan(data, { preserveQuantities: true });
    expect(s.applyPlan(current().id, layoutHash(data), result)).toBe(true);
    expect(current().placements).toHaveLength(1);
    expect(current().layoutNeedsUpdate).toBe(false);
  });
  it('allows final-project deletion and backup restoration of an empty account', () => {
    useStore.getState().deleteProject(current().id);
    expect(useStore.getState().projects).toEqual([]);
    expect(importBackup(exportBackup())).toBe(true);
    expect(useStore.getState().projects).toEqual([]);
    expect(useStore.getState().currentProjectId).toBe('');
  });
});
