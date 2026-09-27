// 브리프 9장의 가상 검증 데이터. 실제 매장·상품·시장 가격이 아니다.
import type { CatalogItem, Price, Project, Requirement, ServiceFee, Space, Vendor } from './types';

const SRC = '가상 검증 데이터(브리프 9장)';
const DATE = '2026-09-25';

export function demoSpace(): Space {
  return {
    id: 'space-virtual-a',
    name: '가상 검증 공간 A',
    address: '',
    isVirtual: true,
    width: 5,
    depth: 10,
    height: 3,
    doors: [{ id: 'D1', wall: 'bottom', offset: 1.75, width: 1.5, clearance: 1.2, label: '주 출입구' }],
    columns: [{ id: 'C1', x: 4.6, y: 4.8, w: 0.4, d: 0.4, label: '기둥 C1' }],
    zones: [{ id: 'Z1', x: 0, y: 6, w: 0.8, d: 1, label: '분전반 앞', reason: '분전반 점검 공간(가상 입력)' }],
    fixtures: [{ id: 'F1', x: 4.7, y: 8.2, w: 0.3, d: 0.6, label: '소화전함' }],
    powerPoints: [
      { id: 'E1', x: 0, y: 2.5, label: '콘센트' },
      { id: 'E2', x: 5, y: 7.5, label: '콘센트' },
    ],
    rules: { minAisle: 1.0, maxItemHeight: null, note: '통로 폭·출입구 여유는 검증용으로 정한 가상 입력값' },
    status: {
      scaleConfirmed: true,
      fieldMeasured: false,
      drawingDate: DATE,
      source: '작성자가 정한 가상 치수(실제 매장 아님)',
      usageScope: '팀 내부 검증용',
      note: '',
    },
  };
}

type ItemInput = Omit<Partial<CatalogItem>, 'price'> &
  Pick<CatalogItem, 'sku' | 'name' | 'category' | 'w' | 'd' | 'h'> & { price?: Partial<Price> };

function item(p: ItemInput): CatalogItem {
  return {
    option: '',
    trade: 'rent',
    deposit: null,
    setComponents: '',
    modelUrl: '',
    modelLicense: '',
    color: '',
    note: '',
    ...p,
    price: {
      amount: null,
      basisDays: 7,
      vatIncluded: true,
      status: 'confirmed',
      priceDate: DATE,
      source: SRC,
      extraDayAmount: null,
      ...p.price,
    },
  };
}

export function demoVendor(): Vendor {
  return {
    id: 'vendor-virtual',
    name: '가상 집기 업체(검증용)',
    contact: '',
    catalogDate: DATE,
    isVirtual: true,
    items: [
      item({ sku: 'TEST-R01', name: '행거', category: 'hanger', w: 1.0, d: 0.5, h: 1.6, deposit: 0, color: '#8a8f98', price: { amount: 100000, extraDayAmount: 12000 } }),
      item({ sku: 'TEST-R02', name: '행거 1.5m', category: 'hanger', w: 1.5, d: 0.5, h: 1.6, deposit: 0, color: '#8a8f98', price: { amount: 130000 } }),
      item({ sku: 'TEST-C01', name: '카운터', category: 'counter', w: 1.2, d: 0.6, h: 0.9, deposit: 0, color: '#e9e4da', price: { amount: 150000 } }),
      item({ sku: 'TEST-C02', name: '카운터 1.8m', category: 'counter', w: 1.8, d: 0.6, h: 0.9, deposit: 0, color: '#e9e4da', price: { amount: 210000 } }),
      item({
        sku: 'TEST-P01',
        name: '포토존 모듈',
        category: 'photozone',
        w: 2.0,
        d: 0.4,
        h: 2.0,
        deposit: 0,
        setComponents: '배경 패널 2 · 지지대 2 · 바닥 받침 1',
        color: '#ff5a1f',
        price: { amount: 250000 },
      }),
      item({ sku: 'TEST-P02', name: '포토존 아치', category: 'photozone', w: 2.4, d: 0.6, h: 2.4, color: '#ff5a1f', price: { amount: 380000, status: 'estimated' } }),
      item({ sku: 'TEST-T01', name: '진열 테이블', category: 'table', w: 1.2, d: 0.6, h: 0.75, color: '#c9a77c', price: { amount: 80000 } }),
      item({ sku: 'TEST-D01', name: '원형 좌대 3단 세트', category: 'display', w: 0.9, d: 0.9, h: 0.9, setComponents: '좌대 3개(높이 0.9/0.6/0.3m)', color: '#f2f2f2', price: { amount: 90000, status: 'estimated' } }),
      item({ sku: 'TEST-S01', name: '벽 선반', category: 'shelf', w: 1.0, d: 0.4, h: 1.8, color: '#b98b5e', price: { amount: 90000 } }),
      item({ sku: 'TEST-M01', name: '전신 거울', category: 'mirror', w: 0.6, d: 0.3, h: 1.8, color: '#cfd8dc', price: { amount: 40000 } }),
      item({ sku: 'TEST-L01', name: '스탠드 조명', category: 'light', w: 0.5, d: 0.5, h: 1.8, color: '#333333', price: { amount: null, status: 'unknown' } }),
    ],
    services: [
      { id: 'fee-install', kind: 'transport_install', label: '운송·설치비', amount: 150000, status: 'confirmed', basis: '정액 가정', source: SRC, vatIncluded: true },
      { id: 'fee-dismantle', kind: 'dismantle', label: '철거비', amount: 100000, status: 'confirmed', basis: '정액 가정', source: SRC, vatIncluded: true },
    ],
  };
}

export function demoRequirements(): Requirement[] {
  return [
    { category: 'counter', sku: 'TEST-C01', required: true, minQty: 1, desiredQty: 1, priority: 1 },
    { category: 'photozone', sku: 'TEST-P01', required: true, minQty: 1, desiredQty: 1, priority: 1 },
    { category: 'hanger', sku: 'TEST-R01', required: false, minQty: 0, desiredQty: 4, priority: 2 },
  ];
}

export function cloneFees(fees: ServiceFee[]): ServiceFee[] {
  return fees.map((f) => ({ ...f }));
}

export function demoProject(space: Space = demoSpace(), vendor: Vendor = demoVendor(), now = new Date()): Project {
  const ts = now.toISOString();
  return {
    id: 'project-demo',
    name: '가상 의류 팝업(9장 검증 예시)',
    spaceId: space.id,
    vendorId: vendor.id,
    event: {
      title: '가상 의류 팝업',
      brand: '(가상) 브랜드',
      contact: '',
      startDate: '2026-10-15',
      endDate: '2026-10-21',
      rentalDays: 7,
      moveIn: '',
      teardown: '',
      conditions: '',
    },
    budget: { amount: 1200000, scope: 'fixtures' },
    requirements: demoRequirements(),
    placements: [],
    fees: cloneFees(vendor.services),
    memo: '',
    versions: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

export function daysInclusive(start: string, end: string): number | null {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 86400000) + 1;
}
