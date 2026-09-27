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
