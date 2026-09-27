// 업체 카탈로그 CSV 가져오기/내보내기. 치수는 m 단위만 받는다(단위를 추측하지 않는다).
import type { CatalogItem, Category, PriceStatus } from './types';
import { CATEGORY_LABEL } from './types';

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const COLUMNS: { key: string; ko: string }[] = [
  { key: 'sku', ko: '상품번호' },
  { key: 'name', ko: '상품명' },
  { key: 'category', ko: '종류' },
  { key: 'w', ko: '가로(m)' },
  { key: 'd', ko: '깊이(m)' },
  { key: 'h', ko: '높이(m)' },
  { key: 'option', ko: '옵션' },
  { key: 'trade', ko: '대여/구매' },
  { key: 'price', ko: '단가(원)' },
  { key: 'basis_days', ko: '가격 기준 기간(일)' },
  { key: 'extra_day', ko: '연장 1일 금액(원)' },
  { key: 'vat_included', ko: '부가세 포함' },
  { key: 'price_status', ko: '가격 상태' },
  { key: 'price_date', ko: '가격 기준일' },
  { key: 'source', ko: '가격 출처' },
  { key: 'deposit', ko: '보증금(원)' },
  { key: 'set_components', ko: '세트 구성품' },
  { key: 'model_url', ko: '3D 모델 URL' },
  { key: 'model_license', ko: '3D 모델 사용 조건' },
  { key: 'color', ko: '표시 색상' },
  { key: 'note', ko: '비고' },
];

const CAT_ALIAS: Record<string, Category> = Object.fromEntries([
  ...Object.keys(CATEGORY_LABEL).map((k) => [k, k]),
  ...Object.entries(CATEGORY_LABEL).map(([k, v]) => [v, k]),
  ['옷걸이', 'hanger'],
  ['계산대', 'counter'],
  ['포토월', 'photozone'],
  ['좌대', 'display'],
]) as Record<string, Category>;

const STATUS_ALIAS: Record<string, PriceStatus> = {
  confirmed: 'confirmed',
  확인: 'confirmed',
  estimated: 'estimated',
  추정: 'estimated',
  unknown: 'unknown',
  미확인: 'unknown',
};

function num(v: string): number | null {
  const s = v.replace(/[,\s원]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function yesNo(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (['y', 'yes', 'true', '포함', 'o', '예'].includes(s)) return true;
  if (['n', 'no', 'false', '별도', 'x', '아니오', '미포함'].includes(s)) return false;
  return null;
}

export interface CsvImportResult {
  items: CatalogItem[];
  errors: string[];
  warnings: string[];
}

export function importCatalogCsv(text: string): CsvImportResult {
  const rows = parseCsv(text);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (rows.length < 2) return { items: [], errors: ['헤더와 1개 이상의 상품 행이 필요합니다.'], warnings };
  const header = rows[0].map((h) => h.trim());
  const col = new Map<string, number>();
  header.forEach((h, i) => {
    const c = COLUMNS.find((x) => x.key === h || x.ko === h || x.ko.replace(/\(.*\)/, '') === h);
    if (c) col.set(c.key, i);
  });
  for (const k of ['sku', 'name', 'category', 'w', 'd', 'h']) {
    if (!col.has(k)) errors.push(`필수 열이 없습니다: ${COLUMNS.find((c) => c.key === k)!.ko}(${k})`);
  }
  if (errors.length) return { items: [], errors, warnings };

  const get = (r: string[], k: string) => (col.has(k) ? (r[col.get(k)!] ?? '').trim() : '');
  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const sku = get(r, 'sku');
    if (!sku) return errors.push(`${line}행: 상품번호가 비어 있습니다.`);
    if (seen.has(sku)) return errors.push(`${line}행: 상품번호 ${sku}가 중복됩니다.`);
    const category = CAT_ALIAS[get(r, 'category')];
    if (!category) return errors.push(`${line}행(${sku}): 종류 '${get(r, 'category')}'를 알 수 없습니다.`);
    const w = num(get(r, 'w'));
    const d = num(get(r, 'd'));
    const h = num(get(r, 'h'));
    if ([w, d, h].some((v) => v == null || Number.isNaN(v) || v! <= 0)) {
      return errors.push(`${line}행(${sku}): 가로·깊이·높이가 없거나 숫자가 아닙니다. 치수 없는 상품은 배치할 수 없습니다.`);
    }
    if ([w, d, h].some((v) => v! > 20)) {
      return errors.push(`${line}행(${sku}): 치수가 20m를 넘습니다. m 단위로 입력했는지 확인하세요(mm 값으로 보임).`);
    }
    const price = num(get(r, 'price'));
    if (Number.isNaN(price)) return errors.push(`${line}행(${sku}): 단가가 숫자가 아닙니다.`);
    const trade = /구매|buy/i.test(get(r, 'trade')) ? 'buy' : 'rent';
    const basis = num(get(r, 'basis_days'));
    const extra = num(get(r, 'extra_day'));
    const deposit = num(get(r, 'deposit'));
    let status = STATUS_ALIAS[get(r, 'price_status').toLowerCase()] ?? STATUS_ALIAS[get(r, 'price_status')];
    const priceDate = get(r, 'price_date');
    const source = get(r, 'source');
    if (price == null) status = 'unknown';
    else if (!status) {
      status = priceDate && source ? 'confirmed' : 'estimated';
      if (status === 'estimated') warnings.push(`${sku}: 가격 기준일·출처가 없어 '추정'으로 등록했습니다.`);
    }
    if (trade === 'rent' && price != null && basis == null) {
      warnings.push(`${sku}: 가격 기준 기간이 없어 대여 금액은 '미확인'으로 계산됩니다.`);
    }
    seen.add(sku);
    items.push({
      sku,
      name: get(r, 'name') || sku,
      category,
      w: w!,
      d: d!,
      h: h!,
      option: get(r, 'option'),
      trade,
      price: {
        amount: price,
        basisDays: trade === 'buy' ? null : Number.isNaN(basis) ? null : basis,
        vatIncluded: yesNo(get(r, 'vat_included')),
        status,
        priceDate,
        source,
        extraDayAmount: extra == null || Number.isNaN(extra) ? null : extra,
      },
      deposit: deposit == null || Number.isNaN(deposit) ? null : deposit,
      setComponents: get(r, 'set_components'),
      modelUrl: get(r, 'model_url'),
      modelLicense: get(r, 'model_license'),
      color: get(r, 'color'),
      note: get(r, 'note'),
    });
  });
  return { items, errors, warnings };
}

function esc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCatalogCsv(items: CatalogItem[]): string {
  const head = COLUMNS.map((c) => c.ko).join(',');
  const body = items.map((i) =>
    [
      i.sku,
      i.name,
      CATEGORY_LABEL[i.category],
      i.w,
      i.d,
      i.h,
      i.option,
      i.trade === 'buy' ? '구매' : '대여',
      i.price.amount,
      i.price.basisDays,
      i.price.extraDayAmount,
      i.price.vatIncluded == null ? '' : i.price.vatIncluded ? '포함' : '별도',
      { confirmed: '확인', estimated: '추정', unknown: '미확인' }[i.price.status],
      i.price.priceDate,
      i.price.source,
      i.deposit,
      i.setComponents,
      i.modelUrl,
      i.modelLicense,
      i.color,
      i.note,
    ]
      .map(esc)
      .join(','),
  );
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}
