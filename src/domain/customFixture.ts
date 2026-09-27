import type { CatalogItem, Category, PriceStatus } from './types';

export type FixtureDialogMode = 'create' | 'edit' | 'resize';

export interface FixtureDraft {
  needsPower: boolean;
  name: string;
  category: Category;
  widthCm: number;
  depthCm: number;
  heightCm: number;
  option: string;
  trade: 'rent' | 'buy';
  amount: number | null;
  /** Set only when the user types a price for the current dimensions. */
  priceEntered: boolean;
  priceCopiedFromSource: boolean;
  basisDays: number | null;
  extraDayAmount: number | null;
  vatIncluded: boolean | null;
  priceStatus: PriceStatus;
  priceDate: string;
  priceSource: string;
  deposit: number | null;
  setComponents: string;
  color: string;
  note: string;
}

export function fixtureDraft(source?: CatalogItem, mode: FixtureDialogMode = 'create'): FixtureDraft {
  const copyPrice = source && mode === 'edit';
  return {
    needsPower: source?.needsPower ?? false,
    name: source ? (mode === 'resize' ? `${source.name} · 맞춤` : source.name) : '',
    category: source?.category ?? 'display',
    widthCm: Math.round((source?.w ?? 1.2) * 1000) / 10,
    depthCm: Math.round((source?.d ?? 0.5) * 1000) / 10,
    heightCm: Math.round((source?.h ?? 1.5) * 1000) / 10,
    option: source?.option ?? '',
    trade: source?.trade ?? 'rent',
    amount: copyPrice ? source.price.amount : null,
    priceEntered: false,
    priceCopiedFromSource: !!copyPrice,
    basisDays: source?.price.basisDays ?? 7,
    extraDayAmount: copyPrice ? source.price.extraDayAmount : null,
    vatIncluded: copyPrice ? source.price.vatIncluded : null,
    priceStatus: copyPrice ? source.price.status : 'estimated',
    priceDate: copyPrice ? source.price.priceDate : '',
    priceSource: copyPrice ? source.price.source : '',
    deposit: copyPrice ? source.deposit : null,
    setComponents: source?.setComponents ?? '',
    color: source?.color || '#727d70',
    note: source?.note ?? '',
  };
}

export function fixtureSizeChanged(draft: FixtureDraft, source?: CatalogItem): boolean {
  return !!source && (Math.abs(draft.widthCm / 100 - source.w) > 0.000001 || Math.abs(draft.depthCm / 100 - source.d) > 0.000001 || Math.abs(draft.heightCm / 100 - source.h) > 0.000001);
}

export function validateFixtureDraft(draft: FixtureDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('집기 이름을 입력해 주세요.');
  for (const [label, value] of [['가로', draft.widthCm], ['깊이', draft.depthCm], ['높이', draft.heightCm]] as const) {
    if (!Number.isFinite(value) || value < 1 || value > 2000) errors.push(`${label}는 1~2,000 cm 사이로 입력해 주세요.`);
  }
  for (const [label, value] of [['단가', draft.amount], ['연장 1일 금액', draft.extraDayAmount], ['보증금', draft.deposit]] as const) {
    if (value != null && (!Number.isFinite(value) || value < 0)) errors.push(`${label}은 0 이상의 금액으로 입력해 주세요.`);
  }
  if (draft.trade === 'rent' && draft.basisDays != null && (!Number.isInteger(draft.basisDays) || draft.basisDays < 1)) errors.push('대여 기준은 1일 이상의 정수로 입력해 주세요.');
  return errors;
}

/** New dimensions are a new article: original catalog prices and references stay intact. */
export function makeFixtureItem(draft: FixtureDraft, existingSkus: string[], source?: CatalogItem, mode: FixtureDialogMode = 'create', id: string = crypto.randomUUID()): CatalogItem {
  const errors = validateFixtureDraft(draft);
  if (errors.length) throw new Error(errors.join(' '));
  const resized = fixtureSizeChanged(draft, source);
  const replace = source && mode === 'edit' && !resized;
  const keepPrice = replace || !draft.priceCopiedFromSource || draft.priceEntered;
  let sku = replace ? source.sku : `CUSTOM-${id.slice(0, 8).toUpperCase()}`;
  let suffix = 2;
  while (!replace && existingSkus.includes(sku)) sku = `CUSTOM-${id.slice(0, 8).toUpperCase()}-${suffix++}`;
  return {
    sku,
    needsPower: draft.needsPower,
    name: draft.name.trim(), category: draft.category,
    w: draft.widthCm / 100, d: draft.depthCm / 100, h: draft.heightCm / 100,
    option: draft.option.trim(), trade: draft.trade,
    price: {
      amount: keepPrice ? draft.amount : null,
      basisDays: draft.trade === 'rent' ? draft.basisDays : null,
      extraDayAmount: draft.trade === 'rent' && keepPrice ? draft.extraDayAmount : null,
      vatIncluded: keepPrice ? draft.vatIncluded : null,
      status: !keepPrice || draft.amount == null ? 'unknown' : replace ? draft.priceStatus : 'estimated',
      priceDate: keepPrice ? draft.priceDate : '', source: keepPrice ? draft.priceSource.trim() : '',
    },
    deposit: keepPrice ? draft.deposit : null, setComponents: draft.setComponents.trim(), color: draft.color, note: draft.note.trim(),
    modelUrl: replace ? source.modelUrl : '', modelLicense: replace ? source.modelLicense : '',
  };
}
