import { describe, expect, it } from 'vitest';
import { plannerSearchSettings, proposePlan } from './planner';
import { demoProject, demoSpace, demoVendor } from './seed';
import { checkSpaceData, hasBlockingIssues, validateLayout } from './validate';
import { draftData } from './version';
import type { LayoutData } from './types';

function fixture(): LayoutData {
  const space = demoSpace();
  const vendor = demoVendor();
  const project = demoProject(space, vendor);
  project.requirements = [{ category: 'counter', sku: 'TEST-C01', required: true, minQty: 1, desiredQty: 1, priority: 1 }];
  project.placements = [{ id: 'counter', sku: 'TEST-C01', x: 2.5, y: 3, rot: 0, noOrder: false }];
  return draftData(project, space, vendor);
}

describe('공간·집기 데이터가 잘못된 경우 확정 차단', () => {
  it('벽 밖의 문과 공간 밖의 기둥을 배치 오류로 전달한다', () => {
    const data = fixture();
    data.space.doors[0].offset = data.space.width;
    data.space.columns[0].x = data.space.width + 1;
    const issues = validateLayout(data);
    expect(issues.filter((issue) => issue.code === 'SPACE_DATA')).toHaveLength(2);
    expect(hasBlockingIssues(issues)).toBe(true);
    expect(proposePlan(data).ok).toBe(false);
  });

  it.each([0, -1, NaN, Infinity])('유효하지 않은 집기 치수 %s를 거부한다', (value) => {
    const data = fixture();
    data.vendor.items.find((item) => item.sku === 'TEST-C01')!.h = value;
    expect(validateLayout(data).some((issue) => issue.code === 'INVALID_GEOMETRY' && issue.severity === 'error')).toBe(true);
    expect(proposePlan(data).ok).toBe(false);
  });

  it.each(['x', 'y', 'rot'] as const)('숫자가 아닌 집기 %s를 거부한다', (key) => {
    const data = fixture();
    data.placements[0][key] = NaN;
    expect(validateLayout(data).some((issue) => issue.code === 'INVALID_GEOMETRY')).toBe(true);
  });

  it('비유한 공간 좌표·규칙을 공통 오류로 전달한다', () => {
    const data = fixture();
    data.space.columns[0].y = Infinity;
    data.space.rules.minAisle = NaN;
    expect(checkSpaceData(data.space)).toHaveLength(2);
    expect(hasBlockingIssues(validateLayout(data))).toBe(true);
  });

  it('종류가 같아도 필요한 두 규격을 한 규격으로 충족하지 않는다', () => {
    const data = fixture();
    data.requirements.push({ ...data.requirements[0], sku: 'TEST-C02' });
    data.placements.push({ ...data.placements[0], id: 'second-counter', x: 2.5, y: 5 });
    expect(validateLayout(data).filter((issue) => issue.code === 'REQUIRED_MISSING').map((issue) => issue.message)).toEqual([expect.stringContaining('TEST-C02')]);
    data.placements[1].sku = 'TEST-C02';
    expect(validateLayout(data).some((issue) => issue.code === 'REQUIRED_MISSING')).toBe(false);
  });

  it('같은 규격의 중복 필수 조건은 필요한 수량을 합친다', () => {
    const data = fixture();
    data.requirements.push({ ...data.requirements[0] });
    expect(validateLayout(data).find((issue) => issue.code === 'REQUIRED_MISSING')?.message).toContain('2개');
  });
});

describe('크기에 맞춘 제한된 후보 탐색', () => {
  it('기존 예시 크기의 세밀한 탐색 간격은 유지한다', () => {
    expect(plannerSearchSettings(demoSpace())).toMatchObject({ interiorStep: 0.1, wallStep: 0.05 });
  });

  it('200m 공간의 내부·벽 후보 수를 제한하고 유효한 배치를 만든다', () => {
    const data = fixture();
    data.space = { ...data.space, width: 200, depth: 200, doors: [], columns: [], zones: [], fixtures: [], powerPoints: [] };
    data.requirements = [{ category: 'table', sku: 'TEST-T01', required: true, minQty: 1, desiredQty: 1, priority: 1 }];
    const config = plannerSearchSettings(data.space);
    const innerBound = 2 * (Math.ceil(data.space.width / config.interiorStep) - 1) * (Math.ceil(data.space.depth / config.interiorStep) - 1);
    const wallBound = 2 * (Math.floor(data.space.width / config.wallStep) + 2) + 2 * (Math.floor(data.space.depth / config.wallStep) + 2);
    expect(innerBound).toBeLessThanOrEqual(config.maxInteriorCandidates);
    expect(wallBound).toBeLessThanOrEqual(config.maxWallCandidates);
    const result = proposePlan(data);
    expect(result.ok).toBe(true);
    expect(result.placements).toHaveLength(1);
    expect(hasBlockingIssues(validateLayout({ ...data, placements: result.placements }))).toBe(false);
    expect(result.notes.some((note) => note.includes('후보 간격'))).toBe(true);
  });

  it('밀리미터 치수도 벽에 맞춘 좌표를 반올림해 경계를 침범하지 않는다', () => {
    const data = fixture();
    data.space = { ...data.space, doors: [], columns: [], zones: [], fixtures: [], powerPoints: [] };
    data.vendor.items.find((item) => item.sku === 'TEST-C01')!.d = 0.601;
    const result = proposePlan(data);
    expect(result.ok).toBe(true);
    expect(hasBlockingIssues(validateLayout({ ...data, placements: result.placements }))).toBe(false);
  });
});
