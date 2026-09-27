import { computeCost, won, type CostSummary } from './cost';
import { daysInclusive } from './seed';
import type { LayoutData, PlanningBrief } from './types';
import { validateLayout, type Issue } from './validate';

export const PLANNING_BRIEF_FIELDS: { key: keyof PlanningBrief; label: string }[] = [
  { key: 'objective', label: '기획 목적' },
  { key: 'audience', label: '대상 고객' },
  { key: 'experience', label: '핵심 경험' },
  { key: 'approval', label: '승인 요청' },
];

export interface ReviewCheck {
  id: string;
  label: string;
  detail: string;
  status: 'ready' | 'review' | 'missing';
}

export interface DecisionSummary {
  cost: CostSummary;
  issues: Issue[];
  brief: PlanningBrief;
  missingBrief: string[];
  orderQty: number;
  referenceQty: number;
  areaM2: number;
  checklist: ReviewCheck[];
  /** 입력·확인·검토가 남은 체크 항목 수. 고객 검증이나 승인 여부를 의미하지 않는다. */
  reviewCount: number;
  blockingCount: number;
}

/** 화면과 보고서가 같은 입력 상태와 검토 항목을 사용한다. */
export function buildDecisionSummary(data: LayoutData): DecisionSummary {
  const cost = computeCost(data);
  const issues = validateLayout(data);
  const brief: PlanningBrief = {
    objective: data.event.brief?.objective?.trim() || '',
    audience: data.event.brief?.audience?.trim() || '',
    experience: data.event.brief?.experience?.trim() || '',
    approval: data.event.brief?.approval?.trim() || '',
  };
  const missingBrief = PLANNING_BRIEF_FIELDS.filter(({ key }) => !brief[key]).map(({ label }) => label);
  const orderQty = data.placements.filter((p) => !p.noOrder).length;
  const blockingCount = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning');
  const dayCount = daysInclusive(data.event.startDate, data.event.endDate);
  const hasSchedule = dayCount != null && !!data.event.moveIn.trim() && !!data.event.teardown.trim();
  const hasMeasured = data.space.status.scaleConfirmed && data.space.status.fieldMeasured;
  const taxUnknown = cost.lines.some((line) => line.vatIncluded == null);
  const taxExcluded = cost.lines.some((line) => line.vatIncluded === false);
  const checklist: ReviewCheck[] = [
    {
      id: 'brief', label: '기획 의도', status: missingBrief.length ? 'missing' : 'ready',
      detail: missingBrief.length ? `${missingBrief.join(' · ')} 작성 필요` : '기획 목적·대상 고객·핵심 경험·승인 요청 입력됨',
    },
    {
      id: 'layout', label: '배치 검토', status: !orderQty || blockingCount ? 'missing' : warnings.length ? 'review' : 'ready',
      detail: !orderQty ? '주문할 집기를 배치해 주세요.' : blockingCount ? `배치 오류 ${blockingCount}건 수정 필요` : warnings.length ? `배치 주의 ${warnings.length}건 검토 필요` : '등록된 배치 조건에서 오류·주의 없음. 현장 적합성은 별도 확인 필요',
    },
    {
      id: 'cost', label: '비용 근거', status: !orderQty || cost.unknownLines.length ? 'missing' : cost.estimatedLines.length ? 'review' : 'ready',
      detail: !orderQty ? '집기 구성 후 비용을 검토해 주세요.' : cost.unknownLines.length ? `미확인 ${cost.unknownLines.length}건은 ${won(cost.knownTotal)} 합계에 미포함` : cost.estimatedLines.length ? `추정 금액 ${cost.estimatedLines.length}건 업체 확인 필요` : '입력된 품목·서비스 금액이 모두 확인 상태',
    },
    {
      id: 'budget', label: '예산 범위',
      status: data.budget.amount == null ? 'missing' : data.budget.scope !== 'fixtures' || (cost.budgetDiff != null && cost.budgetDiff < 0) || !cost.finalDetermined ? 'review' : 'ready',
      detail: data.budget.amount == null ? '집기에 사용할 예산 입력 필요' : data.budget.scope !== 'fixtures' ? '전체 행사비와 집기 비용은 직접 비교할 수 없습니다.' : cost.budgetDiff != null && cost.budgetDiff < 0 ? `등록 금액이 집기 예산보다 ${won(-cost.budgetDiff)} 많습니다.` : !cost.finalDetermined ? '미확인·추정 금액을 확인한 뒤 예산 재검토 필요' : '등록된 집기 비용이 입력한 집기 예산 이내',
    },
    {
      id: 'vat', label: '부가세·보증금', status: taxUnknown || taxExcluded || cost.vatMixed || cost.depositUnknownCount ? 'review' : 'ready',
      detail: [taxUnknown ? '부가세 기준 미확인' : '', taxExcluded ? '부가세 별도 금액 있음' : '', cost.vatMixed ? '부가세 기준 혼재' : '', cost.depositUnknownCount ? `보증금 미확인 ${cost.depositUnknownCount}건` : ''].filter(Boolean).join(' · ') || '입력된 금액은 부가세 포함, 보증금은 합계와 별도',
    },
    {
      id: 'space', label: '공간 실측', status: hasMeasured ? 'ready' : 'review',
      detail: hasMeasured ? '축척 확인·현장 실측 대조 상태로 입력됨' : [!data.space.status.scaleConfirmed ? '도면 축척 확인 필요' : '', !data.space.status.fieldMeasured ? '현장 실측 대조 필요' : ''].filter(Boolean).join(' · '),
    },
    {
      id: 'schedule', label: '행사·반입 일정', status: hasSchedule ? 'ready' : 'missing',
      detail: hasSchedule ? `행사 ${dayCount}일 · 집기 대여 ${data.event.rentalDays}일. 반입·철거 일정 입력됨` : '유효한 행사 날짜와 반입·철거 일정 입력 필요',
    },
    {
      id: 'source', label: '실제 자료 여부', status: data.space.isVirtual || data.vendor.isVirtual ? 'review' : 'ready',
      detail: data.space.isVirtual || data.vendor.isVirtual ? '가상 공간 또는 카탈로그 포함. 실제 자료로 교체 후 재검토 필요' : '실제 공간·카탈로그로 입력됨. 공급 가능 여부는 업체 확인 필요',
    },
  ];
  return {
    cost, issues, brief, missingBrief, orderQty,
    referenceQty: data.placements.length - orderQty,
    areaM2: data.space.width * data.space.depth,
    checklist, reviewCount: checklist.filter((item) => item.status !== 'ready').length, blockingCount,
  };
}
