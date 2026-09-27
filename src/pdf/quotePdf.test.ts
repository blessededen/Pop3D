import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { buildQuotePackage } from '../domain/quote';
import { demoProject, demoSpace, demoVendor } from '../domain/seed';
import { makeSnapshot } from '../domain/version';
import { createQuotePdf } from './quotePdf';
import { wrapPdfText } from './textLayout';

const font = (name: string) => readFileSync(resolve(process.cwd(), 'public/fonts', name)).toString('base64');
const assets = { regular: font('NotoSansKR-Regular.ttf'), bold: font('NotoSansKR-Bold.ttf') };
function textDoc() {
  const doc = new jsPDF({ unit: 'mm' });
  doc.addFileToVFS('NotoKR.ttf', assets.regular);
  doc.addFont('NotoKR.ttf', 'NotoKR', 'normal');
  doc.setFont('NotoKR');
  doc.setFontSize(8.4);
  return doc;
}

function captureReport(pkg: ReturnType<typeof buildQuotePackage>) {
  const rendered: string[] = [];
  const capture = ['initialized', function (this: jsPDF) {
    const drawText = this.text;
    this.text = function (...args: Parameters<jsPDF['text']>) {
      rendered.push(Array.isArray(args[0]) ? args[0].join('\n') : String(args[0]));
      return drawText.apply(this, args);
    };
  }];
  jsPDF.API.events.push(capture);
  try { return { doc: createQuotePdf(pkg, assets), text: rendered.join('\n') }; }
  finally { jsPDF.API.events.splice(jsPDF.API.events.indexOf(capture), 1); }
}

describe('외부 공유용 PDF 표현', () => {
  it('내부 검증 상태를 출력하지 않고 사용자 메모와 별도 견적을 보존한다', () => {
    const space = demoSpace(); space.name = '운영 공간'; space.isVirtual = true; space.status.scaleConfirmed = false;
    const vendor = demoVendor(); vendor.name = 'VIRTUAL_VENDOR_SENTINEL'; vendor.isVirtual = true;
    space.rules.note = 'INTERNAL_RULE_NOTE_SENTINEL';
    vendor.items[0].price.source = 'INTERNAL_PRICE_SOURCE_SENTINEL';
    vendor.items[0].price.amount = null;
    vendor.items[0].price.status = 'unknown';
    const project = demoProject(space, vendor);
    project.memo = '사용자 원문: 미검증 있음';
    project.event.conditions = '현장 조건 원문 유지';
    project.placements = [{ id: 'pdf-item', sku: vendor.items[0].sku, x: 2, y: 2, rot: 0, noOrder: false }];
    const pkg = buildQuotePackage(makeSnapshot(project, space, vendor));
    pkg.stamps.push('INTERNAL_STAMP_SENTINEL');
    pkg.questions.push('INTERNAL_QUESTION_SENTINEL');
    const { text } = captureReport(pkg);
    expect(text).toContain('프로젝트 개요');
    expect(text).toContain('별도 견적');
    expect(text).toContain(project.memo);
    expect(text).toContain(project.event.conditions);
    for (const phrase of ['공식 견적 아님', '축척 미확인', '공간 자료 상태', '보고 전 확인할 항목', '배치 검사 결과', '업체 확인 요청', 'INTERNAL_STAMP_SENTINEL', 'INTERNAL_QUESTION_SENTINEL', 'VIRTUAL_VENDOR_SENTINEL', 'INTERNAL_RULE_NOTE_SENTINEL', 'INTERNAL_PRICE_SOURCE_SENTINEL']) expect(text).not.toContain(phrase);
    expect(text).not.toMatch(/단가 미확인|연장 계산 방식 미확인/);
  });

  it('실제 업체 이름은 입력한 그대로 표시한다', () => {
    const space = demoSpace(); const vendor = demoVendor(); vendor.isVirtual = false; vendor.name = '정식 업체명';
    const project = demoProject(space, vendor);
    const { text } = captureReport(buildQuotePackage(makeSnapshot(project, space, vendor)));
    expect(text).toContain('집기 업체');
    expect(text).toContain('정식 업체명');
  });

  it('가격이 전부 비어 있으면 예상 비용을 0원으로 표시하지 않는다', () => {
    const space = demoSpace(); const vendor = demoVendor(); const project = demoProject(space, vendor);
    vendor.items[0].price.amount = null; vendor.items[0].price.status = 'unknown'; vendor.items[0].deposit = null;
    project.fees = [];
    project.placements = [{ id: 'pdf-item', sku: vendor.items[0].sku, x: 2, y: 2, rot: 0, noOrder: false }];
    const { text } = captureReport(buildQuotePackage(makeSnapshot(project, space, vendor)));
    expect(text).toContain('별도 견적');
    expect(text.split('\n')).not.toContain('0원');
  });
});

describe('장문 기획 내용의 PDF 줄바꿈과 페이지 넘김', () => {
  it.each([
    '띄어쓰기없는기획목적과대상고객'.repeat(100),
    'LongUnbrokenAudienceToken'.repeat(120),
  ])('공백이 없는 글도 실제 폰트 폭 안에 전부 담는다', (text) => {
    const doc = textDoc();
    const lines = wrapPdfText(doc, text, 150.6);
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.join('')).toBe(text);
    expect(lines.every((line) => doc.getTextWidth(line) <= 150.600001)).toBe(true);
  });

  it('사용자의 줄바꿈·빈 문단·Windows 줄바꿈을 유지한다', () => {
    expect(wrapPdfText(textDoc(), '기획 목적\r\n\r\n제품 체험\n대상 고객\r직접 방문', 150.6))
      .toEqual(['기획 목적', '', '제품 체험', '대상 고객', '직접 방문']);
  });

  it('기획 목적과 대상 고객이 여러 페이지여도 뒤의 표를 밀어내며 정상 PDF를 만든다', () => {
    const space = demoSpace();
    const vendor = demoVendor();
    const project = demoProject(space, vendor);
    const short = createQuotePdf(buildQuotePackage(makeSnapshot(project, space, vendor)), assets);
    project.event.brief = {
      objective: Array.from({ length: 70 }, (_, i) => `${i + 1}. 기획 목적\n제품을 직접 체험할 수 있도록 구성합니다.\n`).join('\n'),
      audience: '띄어쓰기없는대상고객'.repeat(240) + '\n\n' + 'LongUnbrokenAudienceToken'.repeat(140),
      experience: '체험\n\n설명과 상담\n촬영',
      approval: '집기와 예상 비용 검토 요청',
    };
    const long = createQuotePdf(buildQuotePackage(makeSnapshot(project, space, vendor)), assets);
    expect(long.getNumberOfPages()).toBeGreaterThan(short.getNumberOfPages() + 3);
    expect(long.output('arraybuffer').byteLength).toBeGreaterThan(10000);
    const finalTable = (long as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable;
    expect(finalTable.finalY).toBeLessThanOrEqual(279.001);
  });
});
