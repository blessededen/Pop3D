import { describe, expect, it } from 'vitest';
import { computeCost } from './cost';
import { buildDecisionSummary } from './planning';
import { proposePlan } from './planner';
import { demoProject, demoSpace, demoVendor } from './seed';
import { draftData, isDirty, layoutHash, makeSnapshot, snapshotData } from './version';

function fixture() {
  const space = demoSpace();
  const vendor = demoVendor();
  const project = demoProject(space, vendor);
  const proposal = proposePlan(draftData(project, space, vendor));
  if (!proposal.ok) throw new Error('검증용 배치 생성 실패');
  project.placements = proposal.placements;
  return { space, vendor, project, data: () => draftData(project, space, vendor) };
}

describe('기획 보고 판단 근거', () => {
  it('전체 행사비를 집기 비용의 잔여 예산으로 표시하지 않는다', () => {
    const f = fixture();
    expect(computeCost(f.data()).budgetDiff).toBe(150000);
    f.project.budget.scope = 'event_total';
    const summary = buildDecisionSummary(f.data());
    expect(summary.cost.knownTotal).toBe(1050000);
    expect(summary.cost.budgetDiff).toBeNull();
    expect(summary.checklist.find((item) => item.id === 'budget')?.status).toBe('review');
  });

  it('미확인 금액은 합계에서 제외하고 검토할 항목으로 남긴다', () => {
    const f = fixture();
    f.project.fees.find((fee) => fee.kind === 'dismantle')!.amount = null;
    const summary = buildDecisionSummary(f.data());
    expect(summary.cost.knownTotal).toBe(950000);
    expect(summary.cost.finalDetermined).toBe(false);
    expect(summary.cost.unknownLines).toHaveLength(1);
    expect(summary.checklist.find((item) => item.id === 'cost')?.status).toBe('missing');
    expect(summary.checklist.find((item) => item.id === 'budget')?.status).toBe('review');
  });

  it('기획 내용이 바뀌면 새 버전이 필요하고 이전 보고 내용은 보존한다', () => {
    const f = fixture();
    f.project.event.brief = {
      objective: '신제품 체험 행사', audience: '브랜드 방문 고객',
      experience: '제품 체험 후 촬영', approval: '집기 구성과 예산 검토 요청',
    };
    const originalHash = layoutHash(f.data());
    const snapshot = makeSnapshot(f.project, f.space, f.vendor);
    f.project.versions.push(snapshot);
    expect(isDirty(f.project, f.space, f.vendor)).toBe(false);
    f.project.event.brief.approval = '축소 구성 검토 요청';
    expect(layoutHash(f.data())).not.toBe(originalHash);
    expect(isDirty(f.project, f.space, f.vendor)).toBe(true);
    expect(buildDecisionSummary(snapshotData(snapshot)).brief.approval).toBe('집기 구성과 예산 검토 요청');
    expect(buildDecisionSummary(f.data()).brief.approval).toBe('축소 구성 검토 요청');
  });

  it('기획 브리프가 없는 기존 프로젝트는 내용을 지어내지 않는다', () => {
    const f = fixture();
    const summary = buildDecisionSummary(f.data());
    expect(summary.brief).toEqual({ objective: '', audience: '', experience: '', approval: '' });
    expect(summary.missingBrief).toHaveLength(4);
    expect(summary.orderQty).toBe(6);
    expect(summary.areaM2).toBe(f.space.width * f.space.depth);
  });

  it('참고 집기는 주문 수량에서 제외하고 날짜·부가세 누락을 드러낸다', () => {
    const f = fixture();
    f.project.placements[0].noOrder = true;
    f.project.event.endDate = '2026-10-01';
    f.project.fees[0].vatIncluded = null;
    const summary = buildDecisionSummary(f.data());
    expect(summary.orderQty).toBe(5);
    expect(summary.referenceQty).toBe(1);
    expect(summary.checklist.find((item) => item.id === 'schedule')?.status).toBe('missing');
    expect(summary.checklist.find((item) => item.id === 'vat')?.status).toBe('review');
  });
});
