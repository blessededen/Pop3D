// 브리프 9·10장 기대 결과를 코드로 확인하는 시나리오. 앱의 '검증' 화면과 vitest가 같이 쓴다.
import { computeCost, unitPrice, won } from './cost';
import { proposePlan } from './planner';
import { buildQuotePackage } from './quote';
import { demoProject, demoSpace, demoVendor } from './seed';
import { hasBlockingIssues, indexItems, validateLayout } from './validate';
import { draftData, isDirty, makeSnapshot } from './version';
import type { Project } from './types';

export interface CheckResult {
  id: string;
  title: string;
  expected: string;
  actual: string;
  pass: boolean;
}

function qtyText(p: Project, skus: string[]): string {
  return skus.map((s) => `${s}×${p.placements.filter((x) => x.sku === s && !x.noOrder).length}`).join(', ');
}

function planned(budget: number | null) {
  const space = demoSpace();
  const vendor = demoVendor();
  const project = demoProject(space, vendor, new Date('2026-09-25T00:00:00Z'));
  project.budget = { amount: budget, scope: 'fixtures' };
  const plan = proposePlan(draftData(project, space, vendor));
  if (plan.ok) project.placements = plan.placements;
  return { space, vendor, project, plan };
}

export function runBriefChecks(): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (id: string, title: string, expected: string, actual: string, pass: boolean) =>
    out.push({ id, title, expected, actual, pass });
  const SKUS = ['TEST-R01', 'TEST-C01', 'TEST-P01'];

  // 1. 예산 120만 원
  const a = planned(1200000);
  const costA = computeCost(draftData(a.project, a.space, a.vendor));
  const errA = validateLayout(draftData(a.project, a.space, a.vendor)).filter((i) => i.severity === 'error');
  add(
    '9-1',
    '예산 120만 원 배치안',
    'TEST-R01×4, TEST-C01×1, TEST-P01×1 / 합계 1,050,000원 / 차액 150,000원 / 배치 오류 0',
    `${qtyText(a.project, SKUS)} / 합계 ${won(costA.knownTotal)} / 차액 ${won(costA.budgetDiff)} / 배치 오류 ${errA.length}`,
    a.plan.ok &&
      qtyText(a.project, SKUS) === 'TEST-R01×4, TEST-C01×1, TEST-P01×1' &&
      costA.knownTotal === 1050000 &&
      costA.budgetDiff === 150000 &&
      costA.finalDetermined &&
      errA.length === 0,
  );

  // 2. 예산 90만 원 → 행거 2개
  const b = planned(900000);
  const costB = computeCost(draftData(b.project, b.space, b.vendor));
  const errB = validateLayout(draftData(b.project, b.space, b.vendor)).filter((i) => i.severity === 'error');
  add(
    '9-2',
    '예산 90만 원으로 낮춤',
    'TEST-R01×2 (필수 유지) / 합계 850,000원 / 차액 50,000원 / 배치 오류 0',
    `${qtyText(b.project, SKUS)} / 합계 ${won(costB.knownTotal)} / 차액 ${won(costB.budgetDiff)} / 배치 오류 ${errB.length}`,
    b.plan.ok &&
      qtyText(b.project, SKUS) === 'TEST-R01×2, TEST-C01×1, TEST-P01×1' &&
      costB.knownTotal === 850000 &&
      costB.budgetDiff === 50000 &&
      errB.length === 0,
  );

  // 3. 버전 확정 → 화면·수량표·PDF 데이터 일치, 이전 버전 보존
  const v1 = makeSnapshot(a.project, a.space, a.vendor, new Date('2026-09-25T01:00:00Z'));
  a.project.versions.push(v1);
  const cleanAfterConfirm = !isDirty(a.project, a.space, a.vendor);
  a.project.budget = { amount: 900000, scope: 'fixtures' };
  const replan = proposePlan(draftData(a.project, a.space, a.vendor));
  a.project.placements = replan.placements;
  const dirtyAfterEdit = isDirty(a.project, a.space, a.vendor);
  const v2 = makeSnapshot(a.project, a.space, a.vendor, new Date('2026-09-25T02:00:00Z'));
  a.project.versions.push(v2);
  const pkg1 = buildQuotePackage(v1);
  const pkg2 = buildQuotePackage(v2);
  const screen2 = computeCost(draftData(a.project, a.space, a.vendor));
  const pkgQty = (p: typeof pkg2) => p.cost.lines.filter((l) => l.kind === 'item').map((l) => `${l.sku}×${l.qty}`).join(',');
  const screenQty = screen2.lines.filter((l) => l.kind === 'item').map((l) => `${l.sku}×${l.qty}`).join(',');
  add(
    '9-3',
    '버전 확정과 산출물 일치',
    'v2 화면 = v2 패키지(수량·금액), v1 패키지는 1,050,000원 유지, 확정 직후 수정본 없음 → 수정 시 재확정 필요',
    `v2 화면 ${screenQty} ${won(screen2.knownTotal)} / v2 패키지 ${pkgQty(pkg2)} ${won(pkg2.cost.knownTotal)} / v1 패키지 ${won(pkg1.cost.knownTotal)} / 확정 직후 ${cleanAfterConfirm ? '일치' : '불일치'} / 수정 후 ${dirtyAfterEdit ? '재확정 필요' : '표시 안 됨'}`,
    screenQty === pkgQty(pkg2) &&
      screen2.knownTotal === pkg2.cost.knownTotal &&
      pkg2.cost.knownTotal === 850000 &&
      pkg1.cost.knownTotal === 1050000 &&
      pkg2.version === 2 &&
      cleanAfterConfirm &&
      dirtyAfterEdit,
  );

  // 4. 철거비 미확인
  const c = planned(900000);
  c.project.fees = c.project.fees.map((f) => (f.kind === 'dismantle' ? { ...f, amount: null, status: 'unknown' } : f));
  const cSnap = makeSnapshot(c.project, c.space, c.vendor);
  const pkgC = buildQuotePackage(cSnap);
  add(
    '9-4',
    '철거비 미확인',
    "'철거비 미확인', '최종 총액 미확정' 표시 / 미확인 금액을 0원으로 더하지 않음(확인 합계 750,000원 + 미확인 1건)",
    `미확인: ${pkgC.cost.unknownLines.map((l) => l.label).join(', ') || '없음'} / 표시: ${pkgC.stamps.filter((s) => s.includes('미확정')).join(', ') || '없음'} / 확인 합계 ${won(pkgC.cost.knownTotal)}`,
    pkgC.cost.unknownLines.length === 1 &&
      pkgC.cost.unknownLines[0].label === '철거비' &&
      pkgC.cost.unknownLines[0].amount === null &&
      !pkgC.cost.finalDetermined &&
      pkgC.stamps.includes('최종 총액 미확정') &&
      pkgC.cost.knownTotal === 750000,
  );

  // 5. 예산 부족
  const d = planned(500000);
  add(
    '9-5',
    '필수 조건을 유지할 수 없는 예산(50만 원)',
    '배치안 반환 안 함 + 이유(필수·최소 구성 650,000원) + 변경 후보',
    `${d.plan.ok ? '배치안 반환' : '반환 안 함'} / ${d.plan.reasons[0] ?? '-'} / 후보 ${d.plan.suggestions.length}개`,
    !d.plan.ok && d.plan.placements.length === 0 && d.plan.reasons.some((r) => r.includes('650,000원')) && d.plan.suggestions.length > 0,
  );

  // 6. 금지 구역으로 이동
  const e = planned(1200000);
  const hanger = e.project.placements.find((p) => p.sku === 'TEST-R01')!;
  hanger.x = 0.4;
  hanger.y = 6.5;
  hanger.rot = 270;
  const issuesE = validateLayout(draftData(e.project, e.space, e.vendor));
  add(
    '10-4',
    '집기를 금지 구역으로 옮김',
    'NO_GO_ZONE 오류 → 버전 확정 제한',
    `${issuesE.filter((i) => i.severity === 'error').map((i) => i.code).join(', ') || '오류 없음'} / 확정 ${hasBlockingIssues(issuesE) ? '제한' : '가능'}`,
    issuesE.some((i) => i.code === 'NO_GO_ZONE') && hasBlockingIssues(issuesE),
  );

  // 7. 겹침·경계 밖
  const f = planned(1200000);
  const [p1, p2] = f.project.placements;
  p2.x = p1.x;
  p2.y = p1.y;
  const p3 = f.project.placements[2];
  p3.x = -0.2;
  const issuesF = validateLayout(draftData(f.project, f.space, f.vendor));
  add(
    '7-1',
    '겹침·공간 경계 검사',
    'OVERLAP, OUT_OF_BOUNDS 오류',
    issuesF.filter((i) => i.severity === 'error').map((i) => i.code).join(', ') || '오류 없음',
    issuesF.some((i) => i.code === 'OVERLAP') && issuesF.some((i) => i.code === 'OUT_OF_BOUNDS'),
  );

  // 8. 공간 부족
  const g = planned(null);
  g.project.requirements = g.project.requirements.map((r) => (r.category === 'hanger' ? { ...r, desiredQty: 40 } : r));
  const planG = proposePlan(draftData(g.project, g.space, g.vendor));
  add(
    '7-2',
    '공간 부족(행거 40개 요청)',
    '억지 배치 없이 실패 + 놓을 수 있는 수량 안내',
    `${planG.ok ? '배치안 반환' : '반환 안 함'} / ${planG.reasons[0] ?? '-'}`,
    !planG.ok && planG.placements.length === 0 && planG.unplaced.length > 0,
  );

  // 9. 대여 기간 연장
  const items = indexItems(demoVendor().items);
  const r01 = unitPrice(items.get('TEST-R01')!, 10);
  const c01 = unitPrice(items.get('TEST-C01')!, 10);
  add(
    '7-3',
    '대여 10일(기준 7일 초과)',
    'TEST-R01 136,000원(연장 3일×12,000원) / TEST-C01 연장 방식 미확인 → 미확인',
    `TEST-R01 ${won(r01.unit)} / TEST-C01 ${c01.unit == null ? `미확인(${c01.note})` : won(c01.unit)}`,
    r01.unit === 136000 && c01.unit === null && c01.status === 'unknown',
  );

  return out;
}
