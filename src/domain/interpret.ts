// 요청 문장 해석. 서버 AI가 없거나 실패하면 이 규칙 기반 해석을 '예시 모드'로 쓴다.
import type { Budget, CatalogItem, Category, Requirement } from './types';
import { CATEGORY_LABEL } from './types';

export interface InterpretResult {
  budget: number | null;
  budgetScope: 'fixtures' | 'event_total' | null;
  rentalDays: number | null;
  items: { sku: string; required: boolean; desiredQty: number; minQty: number }[];
  unmatched: string[];
  note: string;
}

const KEYWORDS: Record<Category, string[]> = {
  hanger: ['행거', '옷걸이'],
  counter: ['카운터', '계산대'],
  photozone: ['포토존', '포토 존', '포토월'],
  table: ['테이블', '탁자'],
  shelf: ['선반'],
  mirror: ['거울'],
  display: ['좌대', '진열대', '디스플레이'],
  light: ['조명', '라이트'],
  other: [],
};

const UNIT: Record<string, number> = { 억: 1e8, 천만: 1e7, 백만: 1e6, 만: 1e4, 천: 1e3 };

function parseMoney(text: string): number | null {
  const near = /예산[^\d]{0,12}(\d+(?:[.,]\d+)?)\s*(억|천만|백만|만|천)?\s*원?/.exec(text);
  const any = /(\d+(?:[.,]\d+)?)\s*(억|천만|백만|만|천)?\s*원/.exec(text);
  const m = near ?? any;
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? UNIT[m[2]] : 1));
}

function parseDays(text: string): number | null {
  if (/일주일|1주일|한\s*주/.test(text)) return 7;
  const w = /(\d+)\s*주\s*(간|동안|대여)?/.exec(text);
  if (w && !/주소/.test(text.slice(w.index, w.index + 4))) return Number(w[1]) * 7;
  // '10월 15일' 같은 날짜는 빼고 '10일', '7일간', '대여 5일'만 읽는다
  const d = /(?<!월\s{0,2})(?<![\d./-])(\d{1,3})\s*일(?!\s*(?:부터|까지|자|째|~))/.exec(text);
  return d ? Number(d[1]) : null;
}

export function ruleInterpret(text: string, catalog: CatalogItem[], current: Requirement[] = []): InterpretResult {
  const hits: { cat: Category; idx: number; kw: string }[] = [];
  for (const [cat, kws] of Object.entries(KEYWORDS) as [Category, string[]][]) {
    for (const kw of kws) {
      let i = text.indexOf(kw);
      while (i >= 0) {
        hits.push({ cat, idx: i, kw });
        i = text.indexOf(kw, i + kw.length);
      }
    }
  }
  hits.sort((a, b) => a.idx - b.idx);

  const items: InterpretResult['items'] = [];
  const seen = new Set<Category>();
  const unmatched: string[] = [];
  hits.forEach((h, n) => {
    if (seen.has(h.cat)) return;
    seen.add(h.cat);
    const start = h.idx + h.kw.length;
    // 1.5m 같은 소수점은 문장 끝이 아니다
    const delim = text.slice(start).search(/[,\n;]|\.(?!\d)/);
    const clauseEnd = delim < 0 ? text.length : start + delim;
    const next = hits.slice(n + 1).find((x) => x.idx >= start)?.idx ?? text.length;
    const qtyWin = text.slice(start, Math.min(clauseEnd, next));
    const reqWin = text.slice(start, clauseEnd);

    const candidates = catalog.filter((c) => c.category === h.cat);
    if (candidates.length === 0) {
      unmatched.push(h.kw);
      return;
    }
    const size = /(\d+(?:\.\d+)?)\s*(m|미터|M)/.exec(qtyWin);
    const cur = current.find((r) => r.category === h.cat);
    const pick =
      (size && candidates.find((c) => Math.abs(c.w - Number(size[1])) < 1e-6)) ||
      candidates.find((c) => c.sku === cur?.sku) ||
      candidates[0];

    const range = /(\d+)\s*[~\-]\s*(\d+)\s*(개|대|세트)/.exec(qtyWin);
    const single = /(?:최대\s*)?(\d+)\s*(개|대|세트)/.exec(qtyWin);
    const required = /꼭|필수|반드시|무조건/.test(reqWin);
    let desiredQty = 1;
    let minQty = 0;
    if (range) {
      minQty = Number(range[1]);
      desiredQty = Number(range[2]);
    } else if (single) {
      desiredQty = Number(single[1]);
    }
    if (required) minQty = Math.max(1, minQty || (range ? minQty : desiredQty));
    items.push({ sku: pick.sku, required, desiredQty, minQty: Math.min(minQty, desiredQty) });
  });

  let budgetScope: InterpretResult['budgetScope'] = null;
  if (/전체\s*행사|행사비\s*전체|임차료|대관료|인건비\s*포함/.test(text)) budgetScope = 'event_total';
  else if (/집기/.test(text) && /예산/.test(text)) budgetScope = 'fixtures';

  return {
    budget: parseMoney(text),
    budgetScope,
    rentalDays: parseDays(text),
    items,
    unmatched,
    note: '규칙 기반으로 해석했습니다(예시 모드). 결과를 확인한 뒤 적용하세요.',
  };
}

export interface InterpretApply {
  requirements: Requirement[];
  budget: Budget;
  rentalDays: number | null;
  changes: string[];
}

export function applyInterpretation(
  result: InterpretResult,
  catalog: CatalogItem[],
  current: Requirement[],
  budget: Budget,
): InterpretApply {
  const bySku = new Map(catalog.map((c) => [c.sku, c]));
  const changes: string[] = [];
  const reqs = current.map((r) => ({ ...r }));
  for (const i of result.items) {
    const it = bySku.get(i.sku);
    if (!it) continue;
    const next: Requirement = {
      category: it.category,
      sku: it.sku,
      required: i.required,
      minQty: i.required ? Math.max(1, i.minQty) : i.minQty,
      desiredQty: Math.max(i.desiredQty, i.required ? 1 : 0),
      priority: i.required ? 1 : 2,
    };
    const idx = reqs.findIndex((r) => r.category === it.category);
    if (idx >= 0) reqs[idx] = { ...next, priority: reqs[idx].priority };
    else reqs.push(next);
    changes.push(
      `${CATEGORY_LABEL[it.category]}: ${it.name}(${it.sku}) ${next.desiredQty}개${next.required ? ` · 필수(최소 ${next.minQty}개)` : next.minQty ? ` · 최소 ${next.minQty}개` : ' · 조정 가능'}`,
    );
  }
  const nextBudget: Budget = {
    amount: result.budget ?? budget.amount,
    scope: result.budgetScope ?? budget.scope,
  };
  if (result.budget != null) changes.push(`예산: ${result.budget.toLocaleString('ko-KR')}원`);
  if (result.budgetScope) changes.push(`예산 범위: ${result.budgetScope === 'fixtures' ? '집기·운송·설치·철거' : '전체 행사비'}`);
  if (result.rentalDays != null) changes.push(`대여 일수: ${result.rentalDays}일`);
  return { requirements: reqs, budget: nextBudget, rentalDays: result.rentalDays, changes };
}
