import { computeCost, specText, won, type CostSummary } from './cost';
import { josa } from './josa';
import { fixtureHeightStatus } from './placementRules';
import { indexItems, placementNumbers, validateLayout, type Issue } from './validate';
import { snapshotData } from './version';
import { type CatalogItem, type LayoutData, type Placement, type VersionSnapshot } from './types';

export interface PlacedRow {
  no: number;
  placement: Placement;
  item: CatalogItem | undefined;
}

export interface QuotePackage {
  version: number;
  createdAt: string;
  hash: string;
  data: LayoutData;
  rows: PlacedRow[];
  cost: CostSummary;
  issues: Issue[];
  stamps: string[];
  questions: string[];
  included: string[];
  excluded: string[];
  documentId: string;
}

export const EXCLUDED_DEFAULT = ['공간 임차료', '현장 운영 인건비', '홍보·마케팅비', '전기·인테리어 시공', '상품(판매 재고) 비용'];

/** 화면 표·PDF가 모두 이 함수 결과를 쓴다. 같은 버전이면 같은 번호·수량·금액이 나온다. */
export function buildQuotePackage(snap: VersionSnapshot): QuotePackage {
  const data = snapshotData(snap);
  return buildPackageFromData(data, { version: snap.version, createdAt: snap.createdAt, hash: snap.hash });
}

export function buildPackageFromData(
  data: LayoutData,
  meta: { version: number; createdAt: string; hash: string },
): QuotePackage {
  const items = indexItems(data.vendor.items);
  const nums = placementNumbers(data.placements);
  const rows: PlacedRow[] = data.placements.map((p) => ({ no: nums.get(p.id)!, placement: p, item: items.get(p.sku) }));
  const cost = computeCost(data);
  const issues = validateLayout(data);

  const stamps: string[] = ['예상 비용 · 공식 견적 아님'];
  if (data.space.isVirtual) stamps.push('가상 검증 공간');
  if (data.vendor.isVirtual) stamps.push('가상 카탈로그');
  if (!data.space.status.scaleConfirmed) stamps.push('축척 미확인 · 참고용');
  if (!cost.finalDetermined) stamps.push(cost.unknownLines.length ? '최종 총액 미확정' : '추정 금액 포함');

  const q: string[] = [];
  const period =
    data.event.startDate && data.event.endDate
      ? `행사 ${data.event.startDate} ~ ${data.event.endDate}, 집기 대여 ${data.event.rentalDays}일`
      : `대여 ${data.event.rentalDays}일`;
  q.push(`${period} 기준으로 품목·수량표의 모든 품목을 공급할 수 있는지 확인 부탁드립니다.`);
  for (const l of cost.unknownLines) {
    if (l.kind === 'item') q.push(`${l.label}(${l.sku}) ${l.note || '단가'} — 대여 조건과 금액을 알려주세요.`);
    else q.push(`${l.label} 금액을 알려주세요.`);
  }
  for (const l of cost.estimatedLines) {
    q.push(`${josa(`${l.label}${l.sku ? `(${l.sku})` : ''}`, '은/는')} 추정 금액 ${won(l.amount)}으로 계산했습니다. 확정 금액을 알려주세요.`);
  }
  if (cost.lines.some((l) => l.kind === 'fee' && /운송|설치/.test(l.label))) {
    q.push('운송·설치비가 수량이나 거리에 따라 달라지는지 확인 부탁드립니다.');
  }
  if (cost.depositUnknownCount > 0) q.push('보증금(예치금)이 있는지, 있다면 금액과 반환 조건을 알려주세요.');
  if (cost.lines.some((l) => l.vatIncluded == null)) q.push('표기 금액의 부가세 포함 여부를 알려주세요.');
  if (!data.event.moveIn || !data.event.teardown) {
    q.push('반입·설치 및 철거 가능 시간은 공간 운영자와 확인 중입니다. 업체 측 필요 시간을 알려주세요.');
  } else {
    q.push(`반입·설치 ${data.event.moveIn}, 철거 ${data.event.teardown} 일정에 인력 배정이 가능한지 확인 부탁드립니다.`);
  }
  if (!data.space.status.scaleConfirmed) q.push('첨부 평면도는 축척이 확인되지 않은 자료입니다. 설치 전 현장 치수 확인이 필요합니다.');
  else if (!data.space.status.fieldMeasured) q.push('평면도 치수는 도면 기준이며 현장 실측 대조 전입니다.');
  const tall = rows.filter((r) => r.item && fixtureHeightStatus(data.space, r.item).warning);
  if (tall.length) q.push(`${tall.map((r) => `${r.no}번`).join(', ')} 집기의 상부 여유가 30cm 미만입니다. 반입·설치 가능 여부를 확인 부탁드립니다.`);

  const included = cost.lines.filter((l) => l.kind === 'fee').map((l) => l.label);
  included.unshift('집기 대여·구매료(품목·수량표 기재 품목)');

  return {
    version: meta.version,
    createdAt: meta.createdAt,
    hash: meta.hash,
    data,
    rows,
    cost,
    issues,
    stamps,
    questions: q,
    included,
    excluded: EXCLUDED_DEFAULT,
    documentId: `POP-${meta.hash.slice(0, 8)}-v${meta.version}`,
  };
}

export function rowSpec(r: PlacedRow): string {
  return r.item ? specText(r.item) : '-';
}
