import { describe, expect, it } from 'vitest';
import { fixtureDraft, makeFixtureItem, validateFixtureDraft } from './customFixture';
import { demoVendor } from './seed';

const sourceFixture = () => structuredClone(demoVendor().items[0]);

describe('다른 규격의 집기', () => {
  it('새 규격의 전원 조건을 저장하고 다른 치수에도 유지한다', () => {
    const draft = fixtureDraft(); draft.name = '전원 카운터'; draft.needsPower = true;
    const item = makeFixtureItem(draft, [], undefined, 'create', 'power000');
    expect(item.needsPower).toBe(true);
    const resized = fixtureDraft(item, 'resize'); resized.heightCm = 190;
    expect(makeFixtureItem(resized, [item.sku], item, 'resize', 'power001').needsPower).toBe(true);
  });
  it('cm 입력을 m로 바꾸고 원본과 독립적인 상품을 생성한다', () => {
    const source = sourceFixture();
    const original = structuredClone(source);
    const draft = fixtureDraft(source, 'resize');
    draft.widthCm = 90;
    draft.depthCm = 45;
    draft.heightCm = 170;
    const item = makeFixtureItem(draft, [source.sku], source, 'resize', 'abcdefgh');
    expect(item.sku).not.toBe(source.sku);
    expect([item.w, item.d, item.h]).toEqual([0.9, 0.45, 1.7]);
    expect(item.category).toBe(source.category);
    expect(item.price.amount).toBeNull();
    expect(item.price.status).toBe('unknown');
    expect(source).toEqual(original);
  });

  it('수정 중 치수가 바뀌면 기존 가격·보증금·3D 모델을 승계하지 않는다', () => {
    const source = sourceFixture();
    source.deposit = 10000;
    source.modelUrl = '/old-size.glb';
    const draft = fixtureDraft(source, 'edit');
    draft.widthCm += 10;
    const item = makeFixtureItem(draft, [source.sku], source, 'edit', 'abcdefgh');
    expect(item.sku).not.toBe(source.sku);
    expect(item.price).toMatchObject({ amount: null, status: 'unknown', extraDayAmount: null, vatIncluded: null, source: '', priceDate: '' });
    expect(item.deposit).toBeNull();
    expect(item.modelUrl).toBe('');
  });

  it('새 치수에 가격을 직접 입력하면 추정가로 저장한다', () => {
    const source = sourceFixture();
    const draft = fixtureDraft(source, 'resize');
    draft.widthCm = 95;
    draft.amount = 90000;
    draft.priceEntered = true;
    draft.priceStatus = 'confirmed';
    const item = makeFixtureItem(draft, [source.sku], source, 'resize', 'abcdefgh');
    expect(item.price.amount).toBe(90000);
    expect(item.price.status).toBe('estimated');
  });

  it('같은 치수의 일반 편집은 상품번호와 기존 확인 가격을 유지한다', () => {
    const source = sourceFixture();
    const draft = fixtureDraft(source, 'edit');
    draft.name = '이름 변경';
    const item = makeFixtureItem(draft, [source.sku], source, 'edit', 'abcdefgh');
    expect(item.sku).toBe(source.sku);
    expect(item.price).toEqual(source.price);
    expect(item.name).toBe('이름 변경');
    expect(source.name).not.toBe('이름 변경');
  });

  it('상품번호 충돌을 피하고 기존 규격과 함께 보존한다', () => {
    const source = sourceFixture();
    const draft = fixtureDraft(source, 'resize');
    const item = makeFixtureItem(draft, [source.sku, 'CUSTOM-ABCDEFGH', 'CUSTOM-ABCDEFGH-2'], source, 'resize', 'abcdefgh');
    expect(item.sku).toBe('CUSTOM-ABCDEFGH-3');
  });

  it('빈 이름·비정상 치수·음수 가격·소수 대여 일수를 거부한다', () => {
    const draft = fixtureDraft();
    draft.widthCm = NaN;
    draft.depthCm = 0;
    draft.heightCm = 2001;
    draft.amount = -1;
    draft.basisDays = 1.5;
    expect(validateFixtureDraft(draft)).toHaveLength(6);
    expect(() => makeFixtureItem(draft, [])).toThrow();
  });

  it('새 집기의 명시적인 0원과 미입력 가격을 구분한다', () => {
    const draft = fixtureDraft();
    draft.name = '자체 보유 집기';
    draft.amount = 0;
    draft.priceEntered = true;
    const item = makeFixtureItem(draft, [], undefined, 'create', 'abcdefgh');
    expect(item.price.amount).toBe(0);
    expect(item.price.status).toBe('estimated');
    draft.amount = null;
    expect(makeFixtureItem(draft, [], undefined, 'create', 'abcdefgh').price.status).toBe('unknown');
  });

  it('단가를 모르는 새 집기에도 직접 입력한 보증금은 보존한다', () => {
    const draft = fixtureDraft();
    draft.name = '별도 보증금 집기';
    draft.deposit = 50000;
    draft.extraDayAmount = 10000;
    const item = makeFixtureItem(draft, [], undefined, 'create', 'abcdefgh');
    expect(item.price.amount).toBeNull();
    expect(item.deposit).toBe(50000);
    expect(item.price.extraDayAmount).toBe(10000);
  });
});
