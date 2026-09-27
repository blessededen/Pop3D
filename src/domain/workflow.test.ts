import { describe, expect, it } from 'vitest';
import { computeCost } from './cost';
import { demoProject, demoSpace, demoVendor } from './seed';
import { draftData } from './version';
import { getWorkflowReadiness } from './workflow';

function fixture() {
  const space = demoSpace();
  const vendor = demoVendor();
  const project = demoProject(space, vendor);
  project.requirements = [];
  project.placements = [{ id: 'placed-hanger', sku: 'TEST-R01', x: 1, y: 1, rot: 0, noOrder: false }];
  return draftData(project, space, vendor);
}

describe('작업 단계 진행 조건', () => {
  it('유효한 공간과 배치로 검토·보고 단계에 진입할 수 있다', () => {
    const result = getWorkflowReadiness(fixture());
    expect(result).toEqual({ spaceReady: true, layoutReady: true, canReport: true, spaceProblems: [], layoutProblems: [] });
  });

  it('요구 집기가 없어도 빈 배치는 보고 단계에 진입하지 못한다', () => {
    const data = fixture();
    data.placements = [];
    const result = getWorkflowReadiness(data);
    expect(result.spaceReady).toBe(true);
    expect(result.layoutReady).toBe(false);
    expect(result.canReport).toBe(false);
    expect(result.layoutProblems).toContain('집기를 먼저 배치해 주세요.');
  });

  it('벽 밖 출입구는 공간 단계에서 막고 이후 단계에도 문제를 전달한다', () => {
    const data = fixture();
    data.space.doors[0].offset = data.space.width;
    const result = getWorkflowReadiness(data);
    expect(result.spaceReady).toBe(false);
    expect(result.layoutReady).toBe(false);
    expect(result.canReport).toBe(false);
    expect(result.spaceProblems.some((message) => message.includes('벽 길이'))).toBe(true);
    expect(result.layoutProblems).toEqual(expect.arrayContaining(result.spaceProblems));
  });

  it('출입구를 입력하지 않은 열린 공간에 새 필수 조건을 추가하지 않는다', () => {
    const data = fixture();
    data.space.doors = [];
    expect(getWorkflowReadiness(data).spaceReady).toBe(true);
  });

  it('배치 객체가 기둥을 침범하면 공간 입력은 유지하고 배치·보고를 막는다', () => {
    const data = fixture();
    data.space.columns = [{ id: 'blocking-column', label: '기둥', x: 0.5, y: 0.75, w: 1, d: 0.5 }];
    const result = getWorkflowReadiness(data);
    expect(result.spaceReady).toBe(true);
    expect(result.layoutReady).toBe(false);
    expect(result.canReport).toBe(false);
    expect(result.layoutProblems.some((message) => message.includes('기둥'))).toBe(true);
  });

  it('참고용 집기는 필수 주문 집기 수량을 충족하지 않는다', () => {
    const data = fixture();
    data.requirements = [{ category: 'hanger', sku: 'TEST-R01', required: true, minQty: 1, desiredQty: 1, priority: 1 }];
    data.placements[0].noOrder = true;
    const result = getWorkflowReadiness(data);
    expect(result.canReport).toBe(false);
    expect(result.layoutProblems.some((message) => message.includes('0개만 배치'))).toBe(true);
  });

  it('같은 종류의 다른 규격으로 필수 집기를 대체하지 않는다', () => {
    const data = fixture();
    data.requirements = [{ category: 'hanger', sku: 'TEST-R02', required: true, minQty: 1, desiredQty: 1, priority: 1 }];
    const result = getWorkflowReadiness(data);
    expect(result.canReport).toBe(false);
    expect(result.layoutProblems.some((message) => message.includes('TEST-R02'))).toBe(true);
  });

  it('미확인 가격과 예산 초과는 검토 항목으로 남기고 보고를 차단하지 않는다', () => {
    const data = fixture();
    data.vendor.items.find((item) => item.sku === 'TEST-R01')!.price = {
      amount: null, status: 'unknown', basisDays: null, vatIncluded: null,
      priceDate: '', source: '', extraDayAmount: null,
    };
    data.budget = { amount: 1, scope: 'fixtures' };
    const cost = computeCost(data);
    expect(cost.unknownLines).toHaveLength(1);
    expect(cost.budgetDiff).toBeLessThan(0);
    expect(getWorkflowReadiness(data).canReport).toBe(true);
  });

  it('축척·실측 미확인 자료도 참고 상태로 보고할 수 있다', () => {
    const data = fixture();
    data.space.status.scaleConfirmed = false;
    data.space.status.fieldMeasured = false;
    data.space.rules.minAisle = null;
    data.space.doors[0].clearance = null;
    expect(getWorkflowReadiness(data).canReport).toBe(true);
  });

  it('필수 주문 조건이 없는 참고 배치는 주문 수량을 만들지 않고 보고 가능하다', () => {
    const data = fixture();
    data.placements[0].noOrder = true;
    expect(computeCost(data).lines.filter((line) => line.kind === 'item')).toHaveLength(0);
    expect(getWorkflowReadiness(data).canReport).toBe(true);
  });
});
