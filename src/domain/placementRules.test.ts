import { describe, expect, it } from 'vitest';
import { bounds, polysOverlap, rectPoly } from './geometry';
import { FRONT_ACCESS_DEPTH, frontAccessPoly, nearestPowerDistance, validPowerPoints } from './placementRules';
import { chooseComposition, placeUnits, proposePlan } from './planner';
import { demoProject, demoSpace, demoVendor } from './seed';
import { hasBlockingIssues, indexItems, placementPoly, validateLayout } from './validate';
import { draftData } from './version';
import type { LayoutData, Placement, Rect } from './types';

function fixture(sku = 'TEST-R01'): LayoutData {
  const space = demoSpace();
  Object.assign(space, { width: 5, depth: 5, doors: [], columns: [], zones: [], fixtures: [], powerPoints: [] });
  space.rules.minAisle = null;
  const vendor = demoVendor();
  const project = demoProject(space, vendor);
  project.budget.amount = null;
  project.fees = [];
  project.requirements = [{ category: vendor.items.find((item) => item.sku === sku)!.category, sku, required: true, desiredQty: 1, minQty: 1, priority: 1 }];
  project.placements = [{ id: 'item', sku, x: 2.5, y: 2.5, rot: 0, noOrder: false }];
  return draftData(project, space, vendor);
}

function obstructionInFront(data: LayoutData, rot: number): Rect {
  const placement = { ...data.placements[0], rot };
  const access = frontAccessPoly(placement, data.vendor.items.find((item) => item.sku === placement.sku)!)!;
  const box = bounds(access);
  return { id: 'obstruction', label: '앞 기둥', x: (box.minX + box.maxX) / 2 - 0.1, y: (box.minY + box.maxY) / 2 - 0.1, w: 0.2, d: 0.2 };
}

describe('정면 사용 여유와 회전', () => {
  it.each([0, 90, 180, 270])('%s도 행거 몸체와 겹치지 않아도 앞 기둥을 감지한다', (rot) => {
    const data = fixture();
    data.placements[0].rot = rot;
    data.space.columns = [obstructionInFront(data, rot)];
    const item = data.vendor.items.find((candidate) => candidate.sku === data.placements[0].sku)!;
    expect(polysOverlap(placementPoly(data.placements[0], item), rectPoly(data.space.columns[0]))).toBe(false);
    expect(validateLayout(data)).toContainEqual(expect.objectContaining({ code: 'ACCESS_BLOCKED', severity: 'error', placementIds: ['item'] }));
  });

  it.each(['TEST-R01', 'TEST-C01', 'TEST-S01'])('%s 앞 고정 시설·금지 구역도 같은 기준으로 검사한다', (sku) => {
    const data = fixture(sku);
    const blocker = obstructionInFront(data, 0);
    data.space.fixtures = [blocker];
    expect(validateLayout(data).some((issue) => issue.code === 'ACCESS_BLOCKED')).toBe(true);
    data.space.fixtures = [];
    data.space.zones = [{ ...blocker, reason: '접근 금지' }];
    expect(validateLayout(data).some((issue) => issue.code === 'ACCESS_BLOCKED')).toBe(true);
  });

  it('사용 여유의 끝에 닿거나 옆에 있는 기둥은 막힘으로 처리하지 않는다', () => {
    const data = fixture();
    const item = data.vendor.items.find((candidate) => candidate.sku === 'TEST-R01')!;
    data.space.columns = [{ id: 'column', label: '기둥', x: 2.4, y: 2.5 + item.d / 2 + FRONT_ACCESS_DEPTH, w: 0.2, d: 0.2 }];
    expect(validateLayout(data).some((issue) => issue.code === 'ACCESS_BLOCKED')).toBe(false);
    data.space.columns[0] = { ...data.space.columns[0], x: 2.5 + item.w / 2, y: 2.8 };
    expect(validateLayout(data).some((issue) => issue.code === 'ACCESS_BLOCKED')).toBe(false);
  });

  it('다른 집기가 이미 놓인 집기의 정면을 막지 않는다', () => {
    const data = fixture();
    data.placements[0] = { ...data.placements[0], x: 2.5, y: 0.25 };
    const newItem = data.vendor.items.find((item) => item.sku === 'TEST-T01')!;
    const inFront: Placement = { id: 'table', sku: newItem.sku, x: 2.5, y: 0.85, rot: 0, noOrder: false };
    expect(validateLayout({ ...data, placements: [...data.placements, inFront] }).some((issue) => issue.code === 'ACCESS_BLOCKED')).toBe(true);
    const result = placeUnits(data.space, indexItems(data.vendor.items), [newItem.sku], data.placements);
    expect(result.placements).toHaveLength(1);
    expect(hasBlockingIssues(validateLayout({ ...data, placements: [...data.placements, ...result.placements] }))).toBe(false);
  });

  it('벽을 향한 수동 배치는 사용 여유 부족으로 표시한다', () => {
    const data = fixture();
    data.placements[0] = { ...data.placements[0], x: 2.5, y: 0.25, rot: 180 };
    expect(validateLayout(data).some((issue) => issue.code === 'ACCESS_BLOCKED' && issue.message.includes('경계'))).toBe(true);
  });

  it('입구의 빈 여유 공간과 정면 사용 공간은 함께 쓸 수 있다', () => {
    const data = fixture();
    data.placements[0] = { ...data.placements[0], x: 2.5, y: 3.5 };
    data.space.doors = [{ id: 'entry', label: '입구', wall: 'bottom', offset: 2, width: 1, clearance: 1 }];
    expect(hasBlockingIssues(validateLayout(data))).toBe(false);
  });

  it('자동 배치는 기둥을 향한 자리를 피하고 수동 검사도 통과한다', () => {
    const data = fixture();
    data.space.columns = [{ id: 'column', label: '앞 기둥', x: 2, y: 0.7, w: 1, d: 0.6 }];
    data.requirements[0].desiredQty = 4;
    const result = proposePlan(data, { preserveQuantities: true });
    expect(result.ok).toBe(true);
    expect(result.placements).toHaveLength(4);
    expect(hasBlockingIssues(validateLayout({ ...data, placements: result.placements }))).toBe(false);
  });

  it('정면 여유를 확보할 공간이 없으면 억지 배치를 반환하지 않는다', () => {
    const data = fixture();
    Object.assign(data.space, { width: 1, depth: 0.7 });
    const result = proposePlan(data, { preserveQuantities: true });
    expect(result.ok).toBe(false);
    expect(result.placements).toEqual([]);
    expect(result.unplaced).toContainEqual(expect.objectContaining({ sku: 'TEST-R01', count: 1 }));
  });
});

describe('전원 우선 배치', () => {
  it('카운터의 벽 선호보다 가까운 내부 전원점을 우선한다', () => {
    const data = fixture('TEST-C01');
    data.space.powerPoints = [{ id: 'power', label: '바닥 전원', x: 2.5, y: 2.5 }];
    const before = proposePlan(data);
    data.requirements[0].needsPower = true;
    const after = proposePlan(data);
    expect(before.ok && after.ok).toBe(true);
    expect(nearestPowerDistance(after.placements[0], data.space.powerPoints)).toBeCloseTo(0);
    expect(nearestPowerDistance(after.placements[0], data.space.powerPoints)).toBeLessThan(nearestPowerDistance(before.placements[0], data.space.powerPoints));
    expect(hasBlockingIssues(validateLayout({ ...data, placements: after.placements }))).toBe(false);
  });

  it('전원점 자리에 기둥이 있으면 가까운 다른 유효 후보를 고른다', () => {
    const data = fixture('TEST-C01');
    data.requirements[0].needsPower = true;
    data.space.powerPoints = [{ id: 'power', label: '기둥 전원', x: 2.5, y: 2.5 }];
    data.space.columns = [{ id: 'column', label: '기둥', x: 2.3, y: 2.3, w: 0.4, d: 0.4 }];
    const result = proposePlan(data);
    expect(result.ok).toBe(true);
    expect(nearestPowerDistance(result.placements[0], data.space.powerPoints)).toBeLessThan(1);
    expect(hasBlockingIssues(validateLayout({ ...data, placements: result.placements }))).toBe(false);
  });

  it('선택한 품목이 없거나 전원 조건을 끄면 불필요한 전원 경고를 만들지 않는다', () => {
    const data = fixture('TEST-C01');
    expect(proposePlan(data).notes.some((note) => note.includes('전원'))).toBe(false);
    expect(validateLayout(data).some((issue) => issue.code.startsWith('POWER_'))).toBe(false);
  });

  it('전원 미등록 시 배치 보장 대신 안내를 남긴다', () => {
    const data = fixture('TEST-C01');
    data.requirements[0].needsPower = true;
    const result = proposePlan(data);
    expect(result.ok).toBe(true);
    expect(result.notes).toContainEqual(expect.stringContaining('전원 거리가 반영되지 않았습니다'));
    expect(validateLayout({ ...data, placements: result.placements })).toContainEqual(expect.objectContaining({ code: 'POWER_POINT_MISSING', severity: 'warning' }));
  });

  it('수동 이동 후 거리를 다시 계산하고 잘못된 전원점은 사용하지 않는다', () => {
    const data = fixture('TEST-C01');
    data.requirements[0].needsPower = true;
    data.space.powerPoints = [{ id: 'power', label: '전원', x: 0, y: 0 }, { id: 'invalid', label: '잘못된 전원', x: NaN, y: 0 }];
    expect(validPowerPoints(data.space)).toHaveLength(1);
    data.space.powerPoints.pop();
    data.placements[0] = { ...data.placements[0], x: 3, y: 4, rot: 180 };
    expect(validateLayout(data).find((issue) => issue.code === 'POWER_DISTANCE')?.message).toContain('5.00m');
  });
});

describe('사용자가 정한 수량 유지', () => {
  it('예산이 부족해도 선택한 수량을 줄이지 않고 초과 금액을 안내한다', () => {
    const data = fixture();
    data.requirements[0].desiredQty = 3;
    data.budget.amount = 150000;
    const normal = chooseComposition(data);
    const preserved = chooseComposition(data, { preserveQuantities: true });
    expect(normal.entries[0].qty).toBe(1);
    expect(preserved.feasible).toBe(true);
    expect(preserved.entries[0].qty).toBe(3);
    expect(preserved.adjustments).toEqual([]);
    expect(preserved.notes).toContainEqual(expect.stringContaining('150,000원'));
    const result = proposePlan(data, { preserveQuantities: true });
    expect(result.ok).toBe(true);
    expect(result.placements).toHaveLength(3);
  });

  it('최소 구성보다 예산이 작아도 수량 유지 모드에서는 배치를 계산한다', () => {
    const data = fixture();
    data.budget.amount = 1;
    expect(chooseComposition(data).feasible).toBe(false);
    expect(proposePlan(data, { preserveQuantities: true }).ok).toBe(true);
  });
});
