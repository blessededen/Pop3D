import { describe, expect, it } from 'vitest';
import { fixtureHeightStatus } from './placementRules';
import { demoProject, demoSpace, demoVendor } from './seed';
import { draftData } from './version';
import { chooseComposition, proposePlan } from './planner';
import { validateLayout } from './validate';
import { buildDecisionSummary } from './planning';
import { buildPackageFromData } from './quote';

function fixture(h = 2.71) {
  const space = demoSpace(), vendor = demoVendor(), project = demoProject(space, vendor);
  Object.assign(space, { height: 3, doors: [], columns: [], fixtures: [], zones: [], powerPoints: [] });
  space.rules.minAisle = null;
  const item = vendor.items.find(it => it.category === 'photozone')!;
  item.h = h;
  project.budget.amount = null;
  project.requirements = [{ category: item.category, sku: item.sku, desiredQty: 1, minQty: 1, required: true, priority: 1 }];
  project.placements = [{ id: 'height-test', sku: item.sku, x: 2.5, y: 2, rot: 0, noOrder: false }];
  return draftData(project, space, vendor);
}

describe('공간의 수직 규격과 반입 여유', () => {
  it.each([3, 3.01, 4])('공간 높이 이상의 집기 %sm는 자동 구성과 기존 배치에서 차단한다', h => {
    const data = fixture(h);
    expect(chooseComposition(data, { preserveQuantities: true }).feasible).toBe(false);
    expect(proposePlan(data, { preserveQuantities: true }).ok).toBe(false);
    expect(validateLayout(data)).toContainEqual(expect.objectContaining({ code: 'HEIGHT', severity: 'error' }));
  });
  it('29cm는 주의, 정확히 30cm는 주의 없음으로 판정한다', () => {
    const data = fixture();
    expect(fixtureHeightStatus(data.space, { h: 2.71 })).toMatchObject({ blocked: false, warning: true });
    expect(fixtureHeightStatus(data.space, { h: 2.7 })).toMatchObject({ blocked: false, warning: false });
    expect(validateLayout(data)).toContainEqual(expect.objectContaining({ code: 'HEIGHT_CLEARANCE', severity: 'warning', message: expect.stringContaining('29cm') }));
    const report = buildPackageFromData(data, { version: 1, hash: 'height-test', createdAt: '2026-09-27' });
    expect(report.questions.some(q => q.includes('30cm 미만'))).toBe(true);
  });
  it('공간 높이를 낮추면 이미 놓인 집기도 재검사하며 이전 숨은 높이 규칙은 적용하지 않는다', () => {
    const data = fixture(2.5);
    data.space.rules.maxItemHeight = 1;
    expect(chooseComposition(data).feasible).toBe(true);
    data.space.height = 2.5;
    expect(validateLayout(data).some(i => i.code === 'HEIGHT')).toBe(true);
  });
  it('행사 일정과 대여 기간을 분리하고 보고서 비용 기간은 집기에서 정한 값을 유지한다', () => {
    const data = fixture(2);
    Object.assign(data.event, { startDate: '2026-10-01', endDate: '2026-10-03', rentalDays: 7, moveIn: '9월 30일', teardown: '10월 4일' });
    expect(buildDecisionSummary(data).checklist.find(c => c.id === 'schedule')).toMatchObject({ status: 'ready', detail: expect.stringContaining('집기 대여 7일') });
    expect(buildPackageFromData(data, { version: 1, hash: 'rental-test', createdAt: '2026-09-27' }).questions[0]).toContain('집기 대여 7일');
  });
});
