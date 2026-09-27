import { indexItems, placementNumbers } from './validate';
import type { Budget, CatalogItem, LayoutData, Placement, PriceStatus, ServiceFee } from './types';

export interface UnitPrice {
  unit: number | null;
  status: PriceStatus;
  basis: string;
  note: string;
}

export interface CostLine {
  key: string;
  kind: 'item' | 'fee';
  sku: string;
  label: string;
  spec: string;
  qty: number;
  unit: number | null;
  amount: number | null;
  status: PriceStatus;
  basis: string;
  vatIncluded: boolean | null;
  source: string;
  priceDate: string;
  note: string;
  placementNos: number[];
  deposit: number | null;
}

export interface CostSummary {
  lines: CostLine[];
  /** 확인된 금액 합계 */
  confirmedTotal: number;
  /** 추정 금액 합계 */
  estimatedTotal: number;
  /** 확인 + 추정 (미확인 항목은 더하지 않는다) */
  knownTotal: number;
  unknownLines: CostLine[];
  estimatedLines: CostLine[];
  depositTotal: number;
  depositUnknownCount: number;
  /** 추정·미확인 없이 모든 금액이 확인된 상태 */
  finalDetermined: boolean;
  budget: Budget;
  /** 집기 예산 - 확인·추정 합계. 예산이 없거나 전체 행사비 기준이면 null */
  budgetDiff: number | null;
  vatMixed: boolean;
  warnings: string[];
}

export function specText(it: CatalogItem): string {
  return `${it.w}×${it.d}×${it.h}m`;
}

/** 대여 일수에 맞춘 1개 단가. 알 수 없는 값은 만들지 않고 미확인으로 돌려준다. */
export function unitPrice(item: CatalogItem, rentalDays: number): UnitPrice {
  const p = item.price;
  if (p.amount == null || p.status === 'unknown') {
    return { unit: null, status: 'unknown', basis: p.basisDays ? `${p.basisDays}일 기준` : '', note: '단가 미확인' };
  }
  if (item.trade === 'buy') {
    return { unit: p.amount, status: p.status, basis: '구매', note: '' };
  }
  if (p.basisDays == null) {
    return { unit: null, status: 'unknown', basis: '', note: '가격 기준 기간 미확인' };
  }
  const basis = `${p.basisDays}일 기준`;
  if (rentalDays === p.basisDays) {
    return { unit: p.amount, status: p.status, basis, note: '' };
  }
  if (rentalDays < p.basisDays) {
    return {
      unit: p.amount,
      status: 'estimated',
      basis,
      note: `대여 ${rentalDays}일에 ${p.basisDays}일 가격을 그대로 적용(단기 요금은 업체 확인)`,
    };
  }
  if (p.extraDayAmount == null) {
    return { unit: null, status: 'unknown', basis, note: `대여 ${rentalDays}일 — 연장 계산 방식 미확인` };
  }
  const extra = (rentalDays - p.basisDays) * p.extraDayAmount;
  return {
    unit: p.amount + extra,
    status: p.status,
    basis,
    note: `기준 ${p.basisDays}일 + 연장 ${rentalDays - p.basisDays}일 × ${p.extraDayAmount.toLocaleString('ko-KR')}원`,
  };
}

export function orderQuantities(placements: Placement[]): Map<string, number> {
  const q = new Map<string, number>();
  for (const p of placements) {
    if (p.noOrder) continue;
    q.set(p.sku, (q.get(p.sku) ?? 0) + 1);
  }
  return q;
}

function feeLine(f: ServiceFee): CostLine {
  const unknown = f.amount == null || f.status === 'unknown';
  return {
    key: `fee:${f.id}`,
    kind: 'fee',
    sku: '',
    label: f.label,
    spec: '',
    qty: 1,
    unit: unknown ? null : f.amount,
    amount: unknown ? null : f.amount,
    status: unknown ? 'unknown' : f.status,
    basis: f.basis,
    vatIncluded: f.vatIncluded,
    source: f.source,
    priceDate: '',
    note: unknown ? '금액 미확인' : '',
    placementNos: [],
    deposit: null,
  };
}

export function computeCost(data: Pick<LayoutData, 'vendor' | 'placements' | 'fees' | 'event' | 'budget'>): CostSummary {
  const items = indexItems(data.vendor.items);
  const nums = placementNumbers(data.placements);
  const qty = orderQuantities(data.placements);
  const lines: CostLine[] = [];
  const warnings: string[] = [];

  for (const [sku, n] of qty) {
    const it = items.get(sku);
    if (!it) {
      lines.push({
        key: `item:${sku}`,
        kind: 'item',
        sku,
        label: '카탈로그에 없는 상품',
        spec: '',
        qty: n,
        unit: null,
        amount: null,
        status: 'unknown',
        basis: '',
        vatIncluded: null,
        source: '',
        priceDate: '',
        note: '상품 정보 없음',
        placementNos: [],
        deposit: null,
      });
      continue;
    }
    const u = unitPrice(it, data.event.rentalDays);
    lines.push({
      key: `item:${sku}`,
      kind: 'item',
      sku,
      label: it.name,
      spec: specText(it) + (it.option ? ` · ${it.option}` : ''),
      qty: n,
      unit: u.unit,
      amount: u.unit == null ? null : u.unit * n,
      status: u.status,
      basis: it.trade === 'buy' ? '구매' : `대여 · ${u.basis}`,
      vatIncluded: it.price.vatIncluded,
      source: it.price.source,
      priceDate: it.price.priceDate,
      note: [u.note, it.setComponents ? `세트 구성: ${it.setComponents}` : ''].filter(Boolean).join(' / '),
      placementNos: data.placements.filter((p) => p.sku === sku && !p.noOrder).map((p) => nums.get(p.id)!),
      deposit: it.deposit == null ? null : it.deposit * n,
    });
  }
  lines.sort((a, b) => Math.min(...a.placementNos, 999) - Math.min(...b.placementNos, 999));
  for (const f of data.fees) lines.push(feeLine(f));

  let confirmedTotal = 0;
  let estimatedTotal = 0;
  for (const l of lines) {
    if (l.amount == null) continue;
    if (l.status === 'confirmed') confirmedTotal += l.amount;
    else if (l.status === 'estimated') estimatedTotal += l.amount;
  }
  const unknownLines = lines.filter((l) => l.amount == null || l.status === 'unknown');
  const estimatedLines = lines.filter((l) => l.status === 'estimated' && l.amount != null);
  const knownTotal = confirmedTotal + estimatedTotal;

  const itemLines = lines.filter((l) => l.kind === 'item');
  const depositTotal = itemLines.reduce((s, l) => s + (l.deposit ?? 0), 0);
  const depositUnknownCount = itemLines.filter((l) => l.deposit == null).length;

  const vatKinds = new Set(lines.map((l) => (l.vatIncluded == null ? 'unknown' : l.vatIncluded ? 'in' : 'ex')));
  const vatMixed = vatKinds.size > 1;
  if (vatMixed) warnings.push('부가세 포함 기준이 품목마다 다릅니다. 합계는 표기된 금액을 그대로 더한 값입니다.');
  if (vatKinds.has('unknown')) warnings.push('부가세 포함 여부가 확인되지 않은 항목이 있습니다.');
  if (data.budget.scope === 'event_total') {
    warnings.push('예산이 전체 행사비 기준입니다. 임차료·인건비 등이 빠진 집기 비용과 직접 비교할 수 없습니다.');
  }

  const budgetDiff = data.budget.amount == null || data.budget.scope !== 'fixtures' ? null : data.budget.amount - knownTotal;

  return {
    lines,
    confirmedTotal,
    estimatedTotal,
    knownTotal,
    unknownLines,
    estimatedLines,
    depositTotal,
    depositUnknownCount,
    finalDetermined: unknownLines.length === 0 && estimatedLines.length === 0,
    budget: data.budget,
    budgetDiff,
    vatMixed,
    warnings,
  };
}

export function won(n: number | null | undefined): string {
  if (n == null) return '미확인';
  return `${n.toLocaleString('ko-KR')}원`;
}
