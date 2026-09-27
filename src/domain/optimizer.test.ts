import { describe, expect, it } from 'vitest';
import { findSpot, optimizeLayout, proposePlan } from './planner';
import { nearestPowerDistance } from './placementRules';
import { bounds, polyDistance } from './geometry';
import { demoProject, demoSpace, demoVendor } from './seed';
import { hasBlockingIssues, indexItems, placementPoly, validateLayout } from './validate';
import { draftData } from './version';
import type { CatalogItem, LayoutData } from './types';

function fixture(width = 5, depth = 5): LayoutData {
  const space = demoSpace();
  Object.assign(space, { width, depth, doors: [], columns: [], zones: [], fixtures: [], powerPoints: [] });
  space.rules.minAisle = null;
  const vendor = demoVendor();
  const project = demoProject(space, vendor);
  project.requirements = [];
  project.placements = [];
  project.fees = [];
  project.budget.amount = null;
  return draftData(project, space, vendor);
}

function select(data: LayoutData, item: CatalogItem, quantity = 1, needsPower = false) {
  data.vendor.items.push(item);
  data.requirements.push({ sku: item.sku, category: item.category, desiredQty: quantity, minQty: 0, required: false, priority: 2, needsPower });
}

function assertValid(data: LayoutData, result: ReturnType<typeof proposePlan>) {
  expect(result.ok, result.reasons.join('\n')).toBe(true);
  expect(hasBlockingIssues(validateLayout({ ...data, placements: result.placements }))).toBe(false);
}

describe('A*로 중간 배치안을 비교하는 자동 배치', () => {
  it('작은 테이블을 먼저 가운데 놓으면 막히는 큰 커스텀 집기를 순서를 바꿔 모두 배치한다', () => {
    const data = fixture(3, 3);
    const base = data.vendor.items[0];
    const small = { ...base, sku: 'CUSTOM-SMALL', category: 'table' as const, w: 0.8, d: 0.8, h: 0.8 };
    const large = { ...base, sku: 'CUSTOM-LARGE', category: 'other' as const, w: 2.4, d: 1.8, h: 1 };
    select(data, small); select(data, large);
    const items = indexItems(data.vendor.items);
    const greedyFirst = findSpot(data.space, items, [], small.sku)!;
    expect(greedyFirst).not.toBeNull();
    expect(findSpot(data.space, items, [greedyFirst], large.sku)).toBeNull();
    const result = proposePlan(data, { preserveQuantities: true });
    assertValid(data, result);
    expect(result.placements.map((p) => p.sku).sort()).toEqual([large.sku, small.sku].sort());
  });

  it('기둥·고정 집기·입구와 정면 여유를 피하며 전기 품목의 수량을 유지한다', () => {
    const data = fixture(6, 6);
    data.space.columns = [{ id: 'column', label: '기둥', x: 2.5, y: 0.7, w: 1, d: 0.6 }];
    data.space.fixtures = [{ id: 'fixed', label: '고정 집기', x: 4.5, y: 4.5, w: 1, d: 1 }];
    data.space.doors = [{ id: 'entry', label: '입구', wall: 'bottom', offset: 2, width: 1.5, clearance: 1 }];
    data.space.powerPoints = [{ id: 'power', label: '전원', x: 1, y: 1 }];
    const base = data.vendor.items.find((item) => item.sku === 'TEST-C01')!;
    select(data, { ...base, sku: 'CUSTOM-POWER', w: 0.8, d: 0.5 }, 2, true);
    select(data, { ...data.vendor.items.find((item) => item.sku === 'TEST-R01')!, sku: 'CUSTOM-HANGER' }, 3);
    data.budget.amount = 1;
    const result = proposePlan(data, { preserveQuantities: true });
    assertValid(data, result);
    expect(result.placements).toHaveLength(5);
    expect(result.placements.filter((p) => p.sku === 'CUSTOM-POWER')).toHaveLength(2);
    expect(Math.min(...result.placements.filter((p) => p.sku === 'CUSTOM-POWER').map((p) => nearestPowerDistance(p, data.space.powerPoints)))).toBeCloseTo(0);
    expect(result.composition.adjustments).toEqual([]);
  });

  it('전원점에 중심을 맞추려고 포토존 뒤에 넓은 빈 공간을 남기지 않는다', () => {
    const data = fixture(5, 10);
    const item = { ...data.vendor.items.find((entry) => entry.sku === 'TEST-P01')!, sku: 'POWER-BACKDROP', w: 2, d: 0.4 };
    select(data, item, 1, true);
    data.space.powerPoints = [{ id: 'socket', label: '전원', x: 2.5, y: 1.5 }];
    const result = proposePlan(data, { preserveQuantities: true });
    assertValid(data, result);
    const placement = result.placements[0];
    expect(bounds(placementPoly(placement, item)).minY).toBeCloseTo(0, 4);
    expect(placement.rot).toBe(0);
    expect(nearestPowerDistance(placement, data.space.powerPoints)).toBeLessThanOrEqual(1.31);
    expect(result.notes).toContainEqual(expect.stringContaining('뒤쪽 빈 공간'));
  });

  it('포토존을 벽에 붙여도 기둥과 최소 통로 너비를 침범하지 않는다', () => {
    const data = fixture(6, 6);
    data.space.rules.minAisle = 0.9;
    data.space.columns = [{ id: 'column', label: '기둥', x: 2, y: 0.4, w: 1, d: 0.6 }];
    data.space.powerPoints = [{ id: 'socket', label: '전원', x: 2.5, y: 1.5 }];
    select(data, { ...data.vendor.items.find((entry) => entry.sku === 'TEST-P01')!, sku: 'POWER-BACKDROP', w: 2, d: 0.4 }, 1, true);
    select(data, { ...data.vendor.items[0], sku: 'CENTRE-TABLE', category: 'table', w: 1, d: 0.7, h: 0.7 }, 2);
    const result = proposePlan(data, { preserveQuantities: true });
    assertValid(data, result);
    const items = indexItems(data.vendor.items);
    for (let i = 0; i < result.placements.length; i++) {
      for (let j = i + 1; j < result.placements.length; j++) {
        const a = result.placements[i]; const b = result.placements[j];
        const gap = polyDistance(placementPoly(a, items.get(a.sku)!), placementPoly(b, items.get(b.sku)!));
        expect(gap <= 0.02 + 1e-6 || gap >= 0.9 - 1e-6).toBe(true);
      }
    }
  });

  it('최소 통로 너비는 앞 기둥과 벽까지의 사용 공간에도 적용한다', () => {
    const data = fixture(5, 5);
    data.space.rules.minAisle = 1;
    const item = { ...data.vendor.items.find((entry) => entry.sku === 'TEST-R01')!, sku: 'AISLE-HANGER', w: 1.2, d: 0.5 };
    select(data, item);
    data.space.columns = [{ id: 'column', label: '앞 기둥', x: 2.4, y: 1.2, w: 0.2, d: 0.2 }];
    data.placements = [{ id: 'too-close', sku: item.sku, x: 2.5, y: 0.25, rot: 0, noOrder: false }];
    const repaired = optimizeLayout(data);
    assertValid(data, repaired);
    expect(repaired.placements[0]).not.toEqual(data.placements[0]);
    data.space.columns = [];
    data.space.width = 1.3;
    data.space.depth = 1.3;
    expect(proposePlan(data, { preserveQuantities: true }).ok).toBe(false);
    data.space.rules.minAisle = 0.6;
    assertValid(data, proposePlan(data, { preserveQuantities: true }));
  });

  it('90cm 통로 조건에서 테이블 간격을 50cm로 옮기면 오류로 감지하고 자동 정리한다', () => {
    const data = fixture(5, 5);
    data.space.rules.minAisle = 0.9;
    const item = { ...data.vendor.items[0], sku: 'AISLE-TABLE', category: 'table' as const, w: 0.8, d: 0.8, h: 0.8 };
    select(data, item, 2);
    data.placements = [
      { id: 'table-a', sku: item.sku, x: 1, y: 2, rot: 0, noOrder: false },
      { id: 'table-b', sku: item.sku, x: 2.3, y: 2, rot: 0, noOrder: false },
    ];
    const issues = validateLayout(data);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'AISLE', severity: 'error', placementIds: ['table-a', 'table-b'] }));
    expect(hasBlockingIssues(issues)).toBe(true);
    assertValid(data, optimizeLayout(data));
  });

  it('유효한 수동 배치와 자유 회전·ID·참고 집기는 그대로 보존한다', () => {
    const data = fixture();
    const item = { ...data.vendor.items[0], sku: 'CUSTOM-SMALL', category: 'table' as const, w: 0.5, d: 0.5, h: 0.8 };
    select(data, item, 1);
    data.placements = [
      { id: 'kept', sku: item.sku, x: 1.3, y: 2.2, rot: 37, noOrder: false },
      { id: 'reference', sku: item.sku, x: 4.2, y: 4.1, rot: 13, noOrder: true },
    ];
    const result = optimizeLayout(data);
    assertValid(data, result);
    expect(result.placements).toEqual(data.placements);
  });

  it('기둥 안으로 끌어놓은 집기만 가까운 유효 자리로 복구한다', () => {
    const data = fixture();
    const item = { ...data.vendor.items[0], sku: 'CUSTOM-SMALL', category: 'table' as const, w: 0.5, d: 0.5, h: 0.8 };
    select(data, item, 2);
    data.space.columns = [{ id: 'column', label: '기둥', x: 2, y: 2, w: 1, d: 1 }];
    data.placements = [
      { id: 'keep', sku: item.sku, x: 0.5, y: 0.5, rot: 0, noOrder: false },
      { id: 'repair', sku: item.sku, x: 2.5, y: 2.5, rot: 0, noOrder: false },
    ];
    const result = optimizeLayout(data);
    assertValid(data, result);
    expect(result.placements.find((p) => p.id === 'keep')).toEqual(data.placements[0]);
    const repaired = result.placements.find((p) => p.id === 'repair')!;
    expect(Math.hypot(repaired.x - 2.5, repaired.y - 2.5)).toBeLessThan(1);
    expect(result.placements).toHaveLength(2);
  });

  it('주문 수량을 줄여도 같은 SKU의 참고 집기를 주문 집기로 바꾸지 않는다', () => {
    const data = fixture();
    const item = { ...data.vendor.items[0], sku: 'CUSTOM-SMALL', category: 'table' as const, w: 0.5, d: 0.5, h: 0.8 };
    select(data, item, 1);
    data.placements = [
      { id: 'keep-order', sku: item.sku, x: 1, y: 1, rot: 0, noOrder: false },
      { id: 'removed-order', sku: item.sku, x: 2, y: 1, rot: 0, noOrder: false },
      { id: 'keep-reference', sku: item.sku, x: 4, y: 4, rot: 0, noOrder: true },
    ];
    const result = optimizeLayout(data);
    assertValid(data, result);
    expect(result.placements.filter((p) => !p.noOrder)).toHaveLength(1);
    expect(result.placements.find((p) => p.id === 'keep-reference')).toEqual(data.placements[2]);
    expect(result.placements.some((p) => p.id === 'removed-order')).toBe(false);
  });

  it('40개 선택에서도 같은 SKU의 후보를 공유해 제한된 탐색을 마친다', () => {
    const data = fixture(10, 10);
    select(data, { ...data.vendor.items[0], sku: 'CUSTOM-BLOCK', category: 'display', w: 0.4, d: 0.4, h: 0.5 }, 40);
    const start = performance.now();
    const result = proposePlan(data, { preserveQuantities: true });
    assertValid(data, result);
    expect(result.placements).toHaveLength(40);
    expect(performance.now() - start).toBeLessThan(2500);
  });

  it('못 찾은 경우 수량을 몰래 줄이거나 충돌한 배치를 성공으로 반환하지 않는다', () => {
    const data = fixture(1, 1);
    select(data, { ...data.vendor.items[0], sku: 'CUSTOM-LARGE', category: 'table', w: 2, d: 2, h: 1 }, 2);
    const result = optimizeLayout(data);
    expect(result.ok).toBe(false);
    expect(result.placements).toEqual([]);
    expect(result.unplaced).toContainEqual(expect.objectContaining({ sku: 'CUSTOM-LARGE', count: 2, total: 2 }));
    expect(result.reasons[0]).toContain('제한된 후보 탐색');
  });
});
