// 견적 요청서 PDF. 확정 버전 하나(QuotePackage)만 입력으로 받는다 → 화면 표와 같은 번호·수량·금액.
import { jsPDF } from 'jspdf';
import { autoTable, type RowInput } from 'jspdf-autotable';
import { won, type CostLine } from '../domain/cost';
import { buildDecisionSummary, PLANNING_BRIEF_FIELDS } from '../domain/planning';
import { doorClearRect, footprint } from '../domain/geometry';
import type { QuotePackage } from '../domain/quote';
import { fmtDateTime } from './format';
import { wrapPdfText } from './textLayout';
import { type Space, type Wall } from '../domain/types';

export interface PdfAssets {
  regular: string;
  bold: string;
  image3d?: { dataUrl: string; width: number; height: number } | null;
}

type RGB = [number, number, number];
const INK: RGB = [24, 43, 41];
const MUTED: RGB = [110, 110, 115];
const LINE: RGB = [222, 219, 212];
const ACCENT: RGB = [49, 118, 95];
const PAGE_W = 210;
const PAGE_H = 297;
const ML = 14;
const CONTENT_W = PAGE_W - ML * 2;
const TOP = 22;
const BOTTOM = PAGE_H - 18;
const FONT = 'NotoKR';


function hexToRgb(hex: string, mixWhite = 0): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xb9bcc2;
  const c: RGB = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return c.map((v) => Math.round(v + (255 - v) * mixWhite)) as RGB;
}

function m2(n: number): string {
  return (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);
}

const money = (amount: number | null | undefined) => amount == null ? '별도 견적' : won(amount);

export function createQuotePdf(pkg: QuotePackage, assets: PdfAssets): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  doc.addFileToVFS('NotoKR-Regular.ttf', assets.regular);
  doc.addFont('NotoKR-Regular.ttf', FONT, 'normal');
  doc.addFileToVFS('NotoKR-Bold.ttf', assets.bold);
  doc.addFont('NotoKR-Bold.ttf', FONT, 'bold');
  doc.setProperties({
    title: `팝업 기획보고서 - ${pkg.data.projectName} v${pkg.version}`,
    subject: '팝업 기획 의도·공간 배치·품목과 예상 비용',
    creator: 'Pop-3D',
  });

  const { data, cost } = pkg;
  const totalAmount = cost.lines.some(line => line.amount != null) ? cost.knownTotal : cost.unknownLines.length ? null : 0;
  const font = (size: number, bold = false, color: RGB = INK) => {
    doc.setFont(FONT, bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };
  const baseTable = {
    styles: { font: FONT, fontSize: 8.4, cellPadding: 1.6, textColor: INK, lineColor: LINE, lineWidth: 0.15, valign: 'middle' as const },
    headStyles: { font: FONT, fontStyle: 'bold' as const, fillColor: INK, textColor: [255, 255, 255] as RGB, lineWidth: 0 },
    margin: { left: ML, right: ML, top: TOP, bottom: PAGE_H - BOTTOM },
    theme: 'grid' as const,
  };
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;
  const sectionTitle = (text: string, y: number, sub?: string) => {
    font(13, true);
    const titleLines = doc.splitTextToSize(text, CONTENT_W) as string[];
    font(8, false, MUTED);
    const subLines = sub ? doc.splitTextToSize(sub, CONTENT_W) as string[] : [];
    y = ensure(y, titleLines.length * 5.5 + subLines.length * 3.8 + 14);
    font(13, true);
    doc.text(titleLines, ML, y);
    y += titleLines.length * 5.5;
    if (subLines.length) {
      font(8, false, MUTED);
      doc.text(subLines, ML, y);
      y += subLines.length * 3.8;
    }
    return y;
  };
  const ensure = (y: number, need: number) => {
    if (y + need > BOTTOM) {
      doc.addPage();
      return TOP + 4;
    }
    return y;
  };
  const paragraph = (text: string, startY: number, size = 8.5, color: RGB = MUTED) => {
    font(size, false, color);
    const lines = wrapPdfText(doc, text, CONTENT_W);
    const lineH = size * 0.3528 * 1.4;
    let py = startY;
    for (const line of lines) {
      py = ensure(py, lineH);
      font(size, false, color);
      doc.text(line, ML, py);
      py += lineH;
    }
    return py + 2;
  };
  const budgetComparison = totalAmount == null ? '집기 및 부대 비용 별도 견적'
    : cost.budget.scope !== 'fixtures'
    ? '전체 행사비 기준 - 집기 비용과 직접 비교하지 않음'
    : cost.budgetDiff == null
      ? '집기 예산 미입력'
      : cost.budgetDiff < 0
        ? `예상 비용이 집기 예산보다 ${won(-cost.budgetDiff)} 초과${cost.unknownLines.length ? ' · 별도 견적 항목 제외' : ''}`
        : cost.unknownLines.length
          ? `현재 비용 기준 차액 ${won(cost.budgetDiff)} · 별도 견적 항목 제외`
          : `집기 예산 대비 ${won(cost.budgetDiff)} 여유`;

  // Only generated price notes are rewritten. User-authored options,
  // set components and project notes are passed through without text filtering.
  const itemNote = (line: CostLine) => {
    const item = data.vendor.items.find(value => value.sku === line.sku);
    if (!item) return '';
    let priceNote = '';
    if (line.unit != null && item.trade === 'rent' && item.price.basisDays != null) {
      if (data.event.rentalDays < item.price.basisDays) priceNote = `대여 ${data.event.rentalDays}일 · ${item.price.basisDays}일 단가 적용`;
      else if (data.event.rentalDays > item.price.basisDays && item.price.extraDayAmount != null) priceNote = `기준 ${item.price.basisDays}일 + 연장 ${data.event.rentalDays - item.price.basisDays}일 × ${won(item.price.extraDayAmount)}`;
    }
    return [priceNote, item.setComponents ? `세트 구성: ${item.setComponents}` : ''].filter(Boolean).join('\n');
  };

  // ------------------------------------------------------------------ 1. 사내 의사결정용 기획 요약
  const decision = buildDecisionSummary(data);
  let y = TOP + 5;
  font(8, true, ACCENT);
  doc.text('POP3D / PLANNING REPORT', ML, y);
  font(26, true);
  doc.text('팝업 기획보고서', ML, y + 13);
  autoTable(doc, {
    ...baseTable, startY: y + 18, theme: 'plain',
    body: [[data.projectName || '프로젝트명 미작성']],
    styles: { ...baseTable.styles, fontSize: 14, fontStyle: 'bold', cellPadding: 0, lineWidth: 0 },
  });
  y = lastY() + 6;
  y = paragraph(`v${pkg.version} · ${fmtDateTime(pkg.createdAt)} · ${pkg.documentId}`, y, 8);
  y = ensure(y + 3, 33);
  const metrics = [
    { label: '예상 비용', value: money(totalAmount), note: cost.unknownLines.length ? `별도 견적 ${cost.unknownLines.length}건 합계 제외` : '집기 및 부대 비용' },
    { label: '사용 공간', value: `${m2(decision.areaM2)} m²`, note: `높이 ${m2(data.space.height)} m` },
    { label: '주문 집기', value: `${decision.orderQty}개`, note: `대여 ${data.event.rentalDays}일${decision.referenceQty ? ` · 주문 제외 ${decision.referenceQty}개` : ''}` },
  ];
  const gap = 3;
  const cardW = (CONTENT_W - gap * 2) / 3;
  metrics.forEach((metric, index) => {
    const x = ML + index * (cardW + gap);
    doc.setFillColor(...(index === 0 ? INK : [246, 245, 241] as RGB));
    doc.roundedRect(x, y, cardW, 29, 2, 2, 'F');
    font(8, false, index === 0 ? [208, 208, 212] : MUTED);
    doc.text(metric.label, x + 4, y + 6);
    font(15, true, index === 0 ? [255, 255, 255] : INK);
    const valueWidth = doc.getTextWidth(metric.value);
    if (valueWidth > cardW - 8) font(Math.max(9, 15 * (cardW - 8) / valueWidth), true, index === 0 ? [255, 255, 255] : INK);
    doc.text(metric.value, x + 4, y + 15);
    font(7, false, index === 0 ? [208, 208, 212] : MUTED);
    doc.text(metric.note, x + 4, y + 23);
  });
  y += 36;
  autoTable(doc, {
    ...baseTable, startY: y, theme: 'plain',
    body: [
      ['예산 판단', `${cost.budget.amount == null ? '미입력' : won(cost.budget.amount)} · ${budgetComparison}`],
      ['공간·일정', `${m2(decision.areaM2)} m² · ${data.event.startDate || '시작일 미작성'} ~ ${data.event.endDate || '종료일 미작성'} · 대여 ${data.event.rentalDays}일`],
    ],
    styles: { ...baseTable.styles, cellPadding: 1.5, lineWidth: 0 },
    columnStyles: { 0: { cellWidth: 24, textColor: MUTED } },
  });
  y = sectionTitle('기획 방향', lastY() + 9);
  const briefLabelWidth = 27;
  const briefPadding = 2.2;
  const previousLineHeight = doc.getLineHeightFactor();
  doc.setLineHeightFactor(1.3);
  font(baseTable.styles.fontSize);
  const briefRows: RowInput[] = PLANNING_BRIEF_FIELDS.map(({ key, label }) => [
    label,
    // AutoTable stringifies a cell array with commas; use explicit newlines.
    wrapPdfText(doc, decision.brief[key] || '미작성', CONTENT_W - briefLabelWidth - briefPadding * 2).join('\n'),
  ]);
  autoTable(doc, {
    ...baseTable, startY: y, theme: 'plain',
    body: briefRows,
    rowPageBreak: 'auto',
    styles: { ...baseTable.styles, cellPadding: briefPadding, lineWidth: 0, valign: 'top', overflow: 'visible' },
    alternateRowStyles: { fillColor: [247, 246, 243] },
    columnStyles: {
      0: { cellWidth: briefLabelWidth, textColor: MUTED, fontStyle: 'bold' },
      1: { cellWidth: CONTENT_W - briefLabelWidth },
    },
  });
  doc.setLineHeightFactor(previousLineHeight);
  // ------------------------------------------------------------------ 2. 프로젝트 개요
  doc.addPage();
  y = TOP + 10;
  font(22, true);
  doc.text('프로젝트 개요', ML, y);
  autoTable(doc, {
    ...baseTable, startY: y + 5, theme: 'plain',
    body: [[data.projectName]],
    styles: { ...baseTable.styles, fontSize: 11, textColor: MUTED, cellPadding: 0, lineWidth: 0 },
  });
  y = ensure(lastY() + 10, 30);

  const sp = data.space;
  const info: RowInput[] = [
    ['문서 번호', `${pkg.documentId}  (v${pkg.version} · ${fmtDateTime(pkg.createdAt)})`],
    ['브랜드 / 담당', `${data.event.brand || '-'} / ${data.event.contact || '-'}`],
    ['행사', data.event.title || '-'],
    [
      '행사·대여 기간',
      `${data.event.startDate && data.event.endDate ? `${data.event.startDate} ~ ${data.event.endDate}` : '날짜 미정'} (대여 ${data.event.rentalDays}일)`,
    ],
    ['반입·설치 / 철거', `${data.event.moveIn || '-'} / ${data.event.teardown || '-'}`],
    ['공간', `${sp.name}${sp.address ? ` (${sp.address})` : ''} · ${m2(sp.width)} × ${m2(sp.depth)} m, 천장 ${m2(sp.height)} m`],
    ...(!data.vendor.isVirtual ? [['집기 업체', `${data.vendor.name} · 카탈로그 기준일 ${data.vendor.catalogDate || '-'}`]] : []),
  ];
  autoTable(doc, {
    ...baseTable,
    startY: y,
    body: info,
    styles: { ...baseTable.styles, cellPadding: 1.8 },
    columnStyles: { 0: { cellWidth: 34, textColor: MUTED, fillColor: [247, 246, 243] }, 1: { cellWidth: CONTENT_W - 34 } },
  });
  y = lastY() + 10;

  y = sectionTitle('공간 구성', y);
  const wallKo: Record<Wall, string> = { top: '위쪽 벽', bottom: '아래쪽 벽', left: '왼쪽 벽', right: '오른쪽 벽' };
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    body: [
      ['출입구', sp.doors.map(door => `${door.label}: ${wallKo[door.wall]}, 폭 ${m2(door.width)} m${door.clearance == null ? '' : `, 앞 여유 ${m2(door.clearance)} m`}`).join('\n') || '-'],
      ['기둥', sp.columns.map(column => `${column.label} ${m2(column.w)}×${m2(column.d)} m`).join(', ') || '없음'],
      ['배치 금지 구역', sp.zones.map(zone => `${zone.label}${zone.reason ? `: ${zone.reason}` : ''}`).join('\n') || '없음'],
      ['고정 시설', sp.fixtures.map(fixture => fixture.label).join(', ') || '없음'],
      ['전원 위치', sp.powerPoints.map(point => `${point.label} (${m2(point.x)}, ${m2(point.y)}) m`).join(', ') || '-'],
      ['통로 최소 너비', sp.rules.minAisle == null ? '-' : `${m2(sp.rules.minAisle)} m`],
    ],
    columnStyles: { 0: { cellWidth: 34, fillColor: [247, 246, 243] } },
  });
  if (data.event.conditions || data.memo) {
    y = sectionTitle('운영 메모', lastY() + 9);
    autoTable(doc, {
      ...baseTable, startY: y + 1,
      body: [
        ...(data.event.conditions ? [['현장 운영 조건', data.event.conditions]] : []),
        ...(data.memo ? [['전달 메모', data.memo]] : []),
      ],
      columnStyles: { 0: { cellWidth: 34, fillColor: [247, 246, 243] } },
    });
  }

  // ------------------------------------------------------------------ 2. 평면 배치도
  doc.addPage();
  y = sectionTitle('평면 배치도', TOP + 6, '단위 m · 원점 = 왼쪽 위 모서리 · 번호는 품목·수량표와 같습니다.');
  const planBottom = drawPlan(doc, pkg, y + 2, 150);
  const posRows: RowInput[] = pkg.rows.map((r) => {
    const it = r.item;
    if (!it) return [r.no, '-', r.placement.sku, '-', '-', '-', '카탈로그에 없음'];
    const poly = footprint(r.placement.x, r.placement.y, it.w, it.d, r.placement.rot);
    const minX = Math.min(...poly.map((p) => p.x));
    const minY = Math.min(...poly.map((p) => p.y));
    return [
      r.no,
      it.name,
      it.sku,
      `${it.w}×${it.d}×${it.h}`,
      `${r.placement.rot}°`,
      `왼쪽 벽에서 ${m2(minX)} / 위쪽 벽에서 ${m2(minY)}`,
      r.placement.noOrder ? '주문 제외' : '',
    ];
  });
  autoTable(doc, {
    ...baseTable,
    startY: planBottom + 4,
    head: [['번호', '품목', '상품번호', '규격 W×D×H(m)', '회전', '위치(집기 바깥 모서리 기준, m)', '비고']],
    body: posRows,
    columnStyles: { 0: { cellWidth: 11, halign: 'center' }, 4: { cellWidth: 12, halign: 'center' } },
  });

  // ------------------------------------------------------------------ 3. 3D 배치도
  if (assets.image3d) {
    doc.addPage();
    y = sectionTitle('3D 배치도', TOP + 6, `공간 ${m2(sp.width)} × ${m2(sp.depth)} m · 높이 ${m2(sp.height)} m`);
    const img = assets.image3d;
    const w = CONTENT_W;
    const h = Math.min((w * img.height) / img.width, BOTTOM - y - 6);
    const ww = (h * img.width) / img.height;
    doc.addImage(img.dataUrl, 'PNG', ML + (CONTENT_W - ww) / 2, y + 2, ww, h, undefined, 'FAST');
    doc.setDrawColor(...LINE);
    doc.rect(ML + (CONTENT_W - ww) / 2, y + 2, ww, h, 'S');
  }

  // ------------------------------------------------------------------ 4. 품목·수량표, 비용표
  doc.addPage();
  y = sectionTitle('품목·예상 비용', TOP + 6, `집기 대여 ${data.event.rentalDays}일 · 배치도와 동일한 번호를 사용합니다.`);
  const itemLines = cost.lines.filter((l) => l.kind === 'item');
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    head: [['배치 번호', '상품번호', '품목·규격', '구분', '수량', '단가', '금액']],
    body: itemLines.map((l) => [
      l.placementNos.join(', '),
      l.sku,
      `${l.label}\n${l.spec}${itemNote(l) ? `\n${itemNote(l)}` : ''}`,
      l.basis,
      { content: String(l.qty), styles: { halign: 'right' } },
      { content: money(l.unit), styles: { halign: 'right' } },
      { content: money(l.amount), styles: { halign: 'right' } },
    ]),
    columnStyles: { 0: { cellWidth: 16 }, 1: { cellWidth: 22 }, 3: { cellWidth: 24 }, 4: { cellWidth: 11 }, 5: { cellWidth: 25 }, 6: { cellWidth: 26 } },
  });
  y = lastY() + 5;
  y = ensure(y, 30);
  font(9, true);
  doc.text('가격 기준', ML, y + 2);
  autoTable(doc, {
    ...baseTable,
    startY: y + 4,
    head: [['상품번호', '부가세', '가격 기준일', '보증금']],
    body: itemLines.map((l) => [
      l.sku,
      l.vatIncluded == null ? '-' : l.vatIncluded ? '포함' : '별도',
      l.priceDate || '-',
      money(l.deposit),
    ]),
    styles: { ...baseTable.styles, fontSize: 7.8 },
    headStyles: { ...baseTable.headStyles, fillColor: [90, 90, 95] as RGB },
  });

  y = sectionTitle('비용 합계', lastY() + 10);
  const itemSubtotal = itemLines.some(line => line.amount != null) ? itemLines.reduce((sum, line) => sum + (line.amount ?? 0), 0) : itemLines.length ? null : 0;
  const costBody: RowInput[] = [
    ['집기 소계', `${decision.orderQty}개`, { content: money(itemSubtotal), styles: { halign: 'right' } }],
    ...cost.lines.filter(line => line.kind === 'fee').map(line => [line.label, line.basis || '-', { content: money(line.amount), styles: { halign: 'right' as const } }]),
  ];
  const foot: RowInput[] = [
    [
      { content: '예상 비용 합계', styles: { fontStyle: 'bold' } },
      cost.unknownLines.length ? `별도 견적 ${cost.unknownLines.length}건 합계 제외` : '',
      { content: money(totalAmount), styles: { halign: 'right', fontStyle: 'bold' } },
    ],
  ];
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    head: [['항목', '기준', '금액']],
    body: costBody,
    foot,
    footStyles: { font: FONT, fillColor: [247, 246, 243], textColor: INK, fontStyle: 'normal', lineWidth: 0.15, lineColor: LINE },
    columnStyles: { 2: { cellWidth: 34 } },
  });
  y = lastY() + 5;
  if (cost.unknownLines.length) y = paragraph(`별도 견적: ${cost.unknownLines.map(line => line.label).join(', ')}. 해당 항목은 위 합계에 포함하지 않았습니다.`, y, 8);
  const depositAmount = itemLines.some(line => line.deposit != null) ? cost.depositTotal : cost.depositUnknownCount ? null : 0;
  y = paragraph(`보증금 ${money(depositAmount)} · 비용 합계와 별도${cost.depositUnknownCount && depositAmount != null ? ` · ${cost.depositUnknownCount}건 별도 견적` : ''}`, y, 8);
  if (cost.vatMixed || cost.lines.some(line => line.vatIncluded == null)) y = paragraph('합계는 표기된 금액의 합산입니다. 부가세 기준은 품목별 가격 기준표를 따릅니다.', y, 8);
  y = ensure(y + 3, 25);
  autoTable(doc, {
    ...baseTable, startY: y,
    head: [['포함 항목', '포함하지 않은 비용']],
    body: [[pkg.included.map((text) => `· ${text}`).join('\n'), pkg.excluded.map((text) => `· ${text}`).join('\n')]],
    columnStyles: { 0: { cellWidth: CONTENT_W / 2 }, 1: { cellWidth: CONTENT_W / 2 } },
  });

  // ------------------------------------------------------------------ 머리글·바닥글
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    font(7.5, false, MUTED);
    doc.text('Pop-3D · 팝업 기획보고서', ML, 12);
    doc.text(`${pkg.documentId} · v${pkg.version} · ${fmtDateTime(pkg.createdAt)}`, PAGE_W - ML, 12, { align: 'right' });
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.2);
    doc.line(ML, 14, PAGE_W - ML, 14);
    doc.line(ML, PAGE_H - 12, PAGE_W - ML, PAGE_H - 12);
    doc.text('팝업 운영 계획 · 배치 및 예상 비용', ML, PAGE_H - 7.5);
    doc.text(`${i} / ${total}`, PAGE_W - ML, PAGE_H - 7.5, { align: 'right' });
  }
  return doc;
}

// ---------------------------------------------------------------------------
// 평면도 벡터 드로잉
// ---------------------------------------------------------------------------

function clipSegment(x1: number, y1: number, x2: number, y2: number, r: { x: number; y: number; w: number; d: number }) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const tests: [number, number][] = [
    [-dx, x1 - r.x],
    [dx, r.x + r.w - x1],
    [-dy, y1 - r.y],
    [dy, r.y + r.d - y1],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

function wallSegs(space: Space, wall: Wall): [number, number][] {
  const len = wall === 'top' || wall === 'bottom' ? space.width : space.depth;
  const cuts = space.doors
    .filter((d) => d.wall === wall)
    .map((d) => [d.offset, d.offset + d.width] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let s = 0;
  for (const [a, b] of cuts) {
    if (a > s) out.push([s, a]);
    s = Math.max(s, b);
  }
  if (len > s) out.push([s, len]);
  return out;
}

function drawPlan(doc: jsPDF, pkg: QuotePackage, top: number, maxH: number): number {
  const sp = pkg.data.space;
  const dim = 11;
  const s = Math.min((CONTENT_W - dim * 2) / sp.width, (maxH - dim * 2) / sp.depth);
  const drawW = sp.width * s;
  const drawH = sp.depth * s;
  const ox = ML + (CONTENT_W - drawW) / 2;
  const oy = top + dim;
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy + y * s;

  doc.setFillColor(248, 247, 244);
  doc.rect(X(0), Y(0), drawW, drawH, 'F');
  doc.setDrawColor(232, 229, 223);
  doc.setLineWidth(0.1);
  for (let x = 1; x < sp.width; x++) doc.line(X(x), Y(0), X(x), Y(sp.depth));
  for (let y = 1; y < sp.depth; y++) doc.line(X(0), Y(y), X(sp.width), Y(y));

  const hatch = (r: { x: number; y: number; w: number; d: number }, rgb: RGB) => {
    const rr = { x: X(r.x), y: Y(r.y), w: r.w * s, d: r.d * s };
    doc.setDrawColor(...rgb);
    doc.setLineWidth(0.15);
    const step = 1.8;
    for (let k = -rr.d; k < rr.w; k += step) {
      const seg = clipSegment(rr.x + k, rr.y + rr.d, rr.x + k + rr.d, rr.y, rr);
      if (seg) doc.line(seg[0], seg[1], seg[2], seg[3]);
    }
    doc.rect(rr.x, rr.y, rr.w, rr.d, 'S');
  };

  for (const d of sp.doors) {
    const r = doorClearRect(sp, d);
    if (!r) continue;
    doc.setFillColor(254, 243, 215);
    doc.rect(X(r.x), Y(r.y), r.w * s, r.d * s, 'F');
    doc.setDrawColor(214, 150, 20);
    doc.setLineWidth(0.2);
    doc.setLineDashPattern([1, 0.8], 0);
    doc.rect(X(r.x), Y(r.y), r.w * s, r.d * s, 'S');
    doc.setLineDashPattern([], 0);
  }
  for (const z of sp.zones) {
    doc.setFillColor(253, 230, 230);
    doc.rect(X(z.x), Y(z.y), z.w * s, z.d * s, 'F');
    hatch(z, [229, 72, 77]);
  }
  for (const f of sp.fixtures) {
    doc.setFillColor(222, 224, 227);
    doc.rect(X(f.x), Y(f.y), f.w * s, f.d * s, 'F');
    hatch(f, [120, 124, 130]);
  }
  for (const c of sp.columns) {
    doc.setFillColor(150, 155, 160);
    doc.rect(X(c.x), Y(c.y), c.w * s, c.d * s, 'F');
  }

  // 벽(문 구간 제외)
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.9);
  for (const [a, b] of wallSegs(sp, 'top')) doc.line(X(a), Y(0), X(b), Y(0));
  for (const [a, b] of wallSegs(sp, 'bottom')) doc.line(X(a), Y(sp.depth), X(b), Y(sp.depth));
  for (const [a, b] of wallSegs(sp, 'left')) doc.line(X(0), Y(a), X(0), Y(b));
  for (const [a, b] of wallSegs(sp, 'right')) doc.line(X(sp.width), Y(a), X(sp.width), Y(b));

  doc.setFont(FONT, 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...MUTED);
  for (const d of sp.doors) {
    const mid = d.offset + d.width / 2;
    const label = `${d.label} ${m2(d.width)}`;
    if (d.wall === 'bottom') doc.text(label, X(mid), Y(sp.depth) + 4, { align: 'center' });
    else if (d.wall === 'top') doc.text(label, X(mid), Y(0) - 2, { align: 'center' });
    else if (d.wall === 'left') doc.text(label, X(0) - 1.5, Y(mid), { align: 'right' });
    else doc.text(label, X(sp.width) + 1.5, Y(mid));
  }
  for (const z of sp.zones) {
    const tw = doc.getTextWidth(z.label) + 1.6;
    doc.setFillColor(255, 255, 255);
    doc.rect(X(z.x + z.w / 2) - tw / 2, Y(z.y + z.d / 2) - 1.9, tw, 3.4, 'F');
    doc.setTextColor(200, 40, 45);
    doc.text(z.label, X(z.x + z.w / 2), Y(z.y + z.d / 2) + 0.7, { align: 'center' });
    doc.setTextColor(...MUTED);
  }
  for (const f of sp.fixtures) doc.text(f.label, X(f.x + f.w / 2), Y(f.y) - 1, { align: 'center' });
  for (const p of sp.powerPoints) {
    doc.setFillColor(242, 194, 48);
    doc.circle(X(p.x), Y(p.y), 0.9, 'F');
  }

  // 집기
  for (const r of pkg.rows) {
    const it = r.item;
    if (!it) continue;
    const poly = footprint(r.placement.x, r.placement.y, it.w, it.d, r.placement.rot).map((v) => [X(v.x), Y(v.y)] as [number, number]);
    doc.setFillColor(...hexToRgb(it.color || '#b9bcc2', 0.62));
    doc.setDrawColor(...INK);
    doc.setLineWidth(0.25);
    if (r.placement.noOrder) doc.setLineDashPattern([0.8, 0.6], 0);
    const segs = poly.slice(1).map((p, i) => [p[0] - poly[i][0], p[1] - poly[i][1]]);
    doc.lines(segs, poly[0][0], poly[0][1], [1, 1], 'FD', true);
    doc.setLineDashPattern([], 0);
    // 정면(로컬 +d) 쪽 가장자리를 굵게
    doc.setLineWidth(0.7);
    doc.line(poly[2][0], poly[2][1], poly[3][0], poly[3][1]);
    const cx = X(r.placement.x);
    const cy = Y(r.placement.y);
    doc.setFillColor(...INK);
    doc.circle(cx, cy, 2.1, 'F');
    doc.setFont(FONT, 'bold');
    doc.setFontSize(7);
    doc.setTextColor(255, 255, 255);
    doc.text(String(r.no), cx, cy + 0.9, { align: 'center' });
  }

  // 치수선
  doc.setDrawColor(...MUTED);
  doc.setTextColor(...INK);
  doc.setLineWidth(0.15);
  doc.setFont(FONT, 'normal');
  doc.setFontSize(7.5);
  const ty = Y(0) - 6;
  doc.line(X(0), ty, X(sp.width), ty);
  doc.line(X(0), ty - 1.2, X(0), ty + 1.2);
  doc.line(X(sp.width), ty - 1.2, X(sp.width), ty + 1.2);
  doc.text(`${m2(sp.width)} m`, X(sp.width / 2), ty - 1.2, { align: 'center' });
  const lx = X(0) - 6;
  doc.line(lx, Y(0), lx, Y(sp.depth));
  doc.line(lx - 1.2, Y(0), lx + 1.2, Y(0));
  doc.line(lx - 1.2, Y(sp.depth), lx + 1.2, Y(sp.depth));
  const depthText = `${m2(sp.depth)} m`;
  doc.text(depthText, lx - 1.3, Y(sp.depth / 2) + doc.getTextWidth(depthText) / 2, { angle: 90 });

  // 축척 막대
  const by = Y(sp.depth) + 8;
  doc.setFillColor(...INK);
  doc.rect(X(0), by, s, 1.2, 'F');
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...INK);
  doc.rect(X(0) + s, by, s, 1.2, 'FD');
  doc.setFontSize(6.5);
  doc.text('0', X(0), by + 4.2, { align: 'center' });
  doc.text('1', X(0) + s, by + 4.2, { align: 'center' });
  doc.text('2 m', X(0) + 2 * s, by + 4.2, { align: 'center' });
  doc.setTextColor(...MUTED);
  doc.text('굵은 선 = 집기 정면 · 빗금 = 배치 금지 구역/고정 시설 · 주황 점선 = 출입구 앞 여유 · 노란 점 = 전원', PAGE_W / 2, by + 10, {
    align: 'center',
  });
  return by + 12;
}
