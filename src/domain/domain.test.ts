import { describe, expect, it } from 'vitest';
import { footprint, polyDistance, polysOverlap, rectPoly } from './geometry';
import { exportCatalogCsv, importCatalogCsv } from './csv';
import { ruleInterpret } from './interpret';
import { josa } from './josa';
import { runBriefChecks } from './scenarios';
import { demoRequirements, demoVendor } from './seed';
import { contentHash } from './version';

describe('브리프 9·10장 기대 결과', () => {
  for (const c of runBriefChecks()) {
    it(`${c.id} ${c.title}`, () => {
      expect(c.pass, `기대: ${c.expected}\n실제: ${c.actual}`).toBe(true);
    });
  }
});

describe('geometry', () => {
  it('맞닿은 사각형은 겹침이 아니다', () => {
    const a = rectPoly({ x: 0, y: 0, w: 1, d: 1 });
    const b = rectPoly({ x: 1, y: 0, w: 1, d: 1 });
    expect(polysOverlap(a, b)).toBe(false);
    expect(polyDistance(a, b)).toBeCloseTo(0);
  });
  it('회전한 사각형 겹침', () => {
    const a = footprint(1, 1, 2, 0.2, 45);
    const b = rectPoly({ x: 0.9, y: 0.9, w: 0.2, d: 0.2 });
    expect(polysOverlap(a, b)).toBe(true);
  });
  it('90도 회전하면 가로·세로가 바뀐다', () => {
    const p = footprint(0, 0, 2, 1, 90);
    const xs = p.map((v) => v.x);
    const ys = p.map((v) => v.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2);
  });
  it('떨어진 거리', () => {
    const a = rectPoly({ x: 0, y: 0, w: 1, d: 1 });
    const b = rectPoly({ x: 1.5, y: 0, w: 1, d: 1 });
    expect(polyDistance(a, b)).toBeCloseTo(0.5);
  });
});

describe('기타', () => {
  it('조사', () => {
    expect(josa('행거', '이/가')).toBe('행거가');
    expect(josa('포토존', '을/를')).toBe('포토존을');
    expect(josa('3번 카운터', '과/와')).toBe('3번 카운터와');
    expect(josa('테이블', '으로/로')).toBe('테이블로');
    expect(josa('포토존 아치(TEST-P02)', '으로/로')).toBe('포토존 아치(TEST-P02)로');
    expect(josa('v1', '으로/로')).toBe('v1로');
    expect(josa('v3', '으로/로')).toBe('v3으로');
    expect(josa('v2', '과/와')).toBe('v2와');
  });
  it('해시는 키 순서와 무관', () => {
    expect(contentHash({ a: 1, b: [1, 2] })).toBe(contentHash({ b: [1, 2], a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe('규칙 기반 문장 해석(예시 모드)', () => {
  const items = demoVendor().items;
  it('예산·일수·필수·규격·범위 수량', () => {
    const r = ruleInterpret('의류 팝업 10일, 집기 예산 90만원. 카운터랑 포토존은 꼭, 행거 1.5m로 2~3개, 거울 1개', items, demoRequirements());
    expect(r.budget).toBe(900000);
    expect(r.budgetScope).toBe('fixtures');
    expect(r.rentalDays).toBe(10);
    expect(r.items).toContainEqual({ sku: 'TEST-C01', required: true, desiredQty: 1, minQty: 1 });
    expect(r.items).toContainEqual({ sku: 'TEST-P01', required: true, desiredQty: 1, minQty: 1 });
    expect(r.items).toContainEqual({ sku: 'TEST-R02', required: false, desiredQty: 3, minQty: 2 });
    expect(r.items).toContainEqual({ sku: 'TEST-M01', required: false, desiredQty: 1, minQty: 0 });
  });
  it('날짜는 대여 일수로 읽지 않는다', () => {
    expect(ruleInterpret('10월 15일부터 행사', items).rentalDays).toBeNull();
    expect(ruleInterpret('10월 15일 행사', items).rentalDays).toBeNull();
    expect(ruleInterpret('일주일 대여', items).rentalDays).toBe(7);
  });
});

describe('CSV 카탈로그', () => {
  it('mm로 보이는 치수는 거부, 빈 단가는 미확인', () => {
    const csv = [
      '상품번호,상품명,종류,가로(m),깊이(m),높이(m),단가(원),가격 기준 기간(일)',
      'A-1,행거,행거,1,0.5,1.6,"100,000",7',
      'A-2,선반,선반,1000,400,1800,90000,7',
      'A-3,조명,조명,0.5,0.5,1.8,,7',
    ].join('\n');
    const r = importCatalogCsv(csv);
    expect(r.items.map((i) => i.sku)).toEqual(['A-1', 'A-3']);
    expect(r.items[0].price.amount).toBe(100000);
    expect(r.items[1].price.status).toBe('unknown');
    expect(r.errors.some((e) => e.includes('A-2') && e.includes('mm'))).toBe(true);
  });
  it('내보낸 CSV를 다시 읽으면 같은 카탈로그', () => {
    const back = importCatalogCsv(exportCatalogCsv(demoVendor().items));
    expect(back.errors).toEqual([]);
    expect(back.items).toEqual(demoVendor().items);
  });
});
