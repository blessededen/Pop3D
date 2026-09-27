// 견적 요청서 PDF. 확정 버전 하나(QuotePackage)만 입력으로 받는다 → 화면 표와 같은 번호·수량·금액.
import { jsPDF, GState } from 'jspdf';
import { autoTable, type CellHookData, type RowInput } from 'jspdf-autotable';
import { won } from '../domain/cost';
import { buildDecisionSummary, PLANNING_BRIEF_FIELDS } from '../domain/planning';
import { doorClearRect, footprint } from '../domain/geometry';
import type { QuotePackage } from '../domain/quote';
import { fmtDateTime } from './format';
import { wrapPdfText } from './textLayout';
import { josa } from '../domain/josa';
import { STATUS_LABEL, type PriceStatus, type Space, type Wall } from '../domain/types';

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
const STATUS_RGB: Record<PriceStatus, RGB> = {
  confirmed: [26, 127, 55],
  estimated: [178, 106, 0],
  unknown: [110, 86, 207],
};
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

export function createQuotePdf(pkg: QuotePackage, assets: PdfAssets): jsPDF {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  doc.addFileToVFS('NotoKR-Regular.ttf', assets.regular);
  doc.addFont('NotoKR-Regular.ttf', FONT, 'normal');
  doc.addFileToVFS('NotoKR-Bold.ttf', assets.bold);
  doc.addFont('NotoKR-Bold.ttf', FONT, 'bold');
  doc.setProperties({
    title: `팝업 기획보고서 - ${pkg.data.projectName} v${pkg.version}`,
    subject: '팝업 기획 의도·배치·예산 검토와 집기 견적 요청 자료',
    creator: 'Pop-3D',
  });

  const { data, cost } = pkg;
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
  const statusCell = (col: number) => (h: CellHookData) => {
    if (h.section !== 'body' || h.column.index !== col) return;
    const raw = String(h.cell.raw ?? '');
    const entry = (Object.entries(STATUS_LABEL) as [PriceStatus, string][]).find(([, v]) => v === raw);
    if (entry) {
      h.cell.styles.textColor = STATUS_RGB[entry[0]];
      h.cell.styles.fontStyle = 'bold';
    }
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
  const budgetComparison = cost.budget.scope !== 'fixtures'
    ? '전체 행사비 기준 - 집기 비용과 직접 비교하지 않음'
    : cost.budgetDiff == null
      ? '집기 예산 미입력'
      : cost.budgetDiff < 0
        ? `등록 금액이 집기 예산보다 ${won(-cost.budgetDiff)} 초과${cost.unknownLines.length ? ' · 미확인 비용 별도' : ''}`
        : cost.unknownLines.length
          ? `등록 금액 기준 차액 ${won(cost.budgetDiff)} · 미확인 비용 반영 전`
          : `집기 예산 대비 ${won(cost.budgetDiff)} 여유${cost.estimatedLines.length ? ' · 추정 금액 포함' : ''}`;

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
  y = paragraph(`검토 기준 v${pkg.version} · ${fmtDateTime(pkg.createdAt)} · ${pkg.documentId}`, y, 8);
  y = ensure(y + 3, 33);
  const metrics = [
    { label: '확인 + 추정 비용', value: won(cost.knownTotal), note: cost.unknownLines.length ? `미확인 ${cost.unknownLines.length}건 금액 미포함` : cost.estimatedLines.length ? '추정 금액 포함' : '등록 금액 기준' },
    { label: '주문 집기', value: `${decision.orderQty}개`, note: `참고용 ${decision.referenceQty}개 별도` },
    { label: '검토할 항목', value: `${decision.reviewCount}개`, note: `입력·확인·검토 필요 / ${decision.checklist.length}개 항목` },
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
  y = sectionTitle('기획 방향과 승인 요청', lastY() + 9);
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
  y = sectionTitle('보고 전 확인할 항목', lastY() + 9, '입력 상태를 바탕으로 정리한 검토 목록입니다. 승인·공급 가능 여부를 판정하지 않습니다.');
  const reviewItems = decision.checklist.filter((item) => item.status !== 'ready');
  autoTable(doc, {
    ...baseTable, startY: y,
    body: reviewItems.length
      ? reviewItems.map((item) => [item.status === 'missing' ? '입력 필요' : '검토 필요', item.label, item.detail])
      : [['입력 완료', '추가 확인', '입력 상태 기준 검토 대상 없음. 현장·업체 확인과 내부 승인은 별도로 진행하세요.']],
    styles: { ...baseTable.styles, fontSize: 8, cellPadding: 1.6 },
    columnStyles: { 0: { cellWidth: 19, textColor: ACCENT }, 1: { cellWidth: 27, fontStyle: 'bold' } },
  });
  y = lastY() + 6;
  paragraph(`후속 페이지: 집기 견적 요청 자료 · 평면 배치도${assets.image3d ? ' · 3D 참고 이미지' : ''} · 품목·비용표 · 현장·업체 확인 요청. 비용은 등록 자료 기준이며 공식 견적이 아닙니다.`, y, 8);

  // ------------------------------------------------------------------ 2. 업체 견적 요청용 상세 자료
  doc.addPage();
  y = TOP + 10;
  font(22, true);
  doc.text('집기 견적 요청 자료', ML, y);
  autoTable(doc, {
    ...baseTable, startY: y + 5, theme: 'plain',
    body: [[data.projectName]],
    styles: { ...baseTable.styles, fontSize: 11, textColor: MUTED, cellPadding: 0, lineWidth: 0 },
  });
  y = ensure(lastY() + 10, 30);

  let sx = ML;
  font(8, true);
  for (const s of pkg.stamps) {
    const w = doc.getTextWidth(s) + 6;
    if (sx + w > PAGE_W - ML) {
      sx = ML;
      y += 8;
    }
    const first = s === pkg.stamps[0];
    doc.setDrawColor(...(first ? ACCENT : MUTED));
    doc.setLineWidth(0.35);
    doc.roundedRect(sx, y - 4.2, w, 6.2, 1.2, 1.2, 'S');
    doc.setTextColor(...(first ? ACCENT : MUTED));
    doc.text(s, sx + 3, y);
    sx += w + 2.5;
  }
  y += 7;

  const sp = data.space;
  const st = sp.status;
  const spaceState = [
    sp.isVirtual ? '가상 검증 공간(실제 매장 아님)' : '실제 공간',
    st.scaleConfirmed ? '도면 축척 확인' : '도면 축척 미확인',
    st.fieldMeasured ? '현장 실측 대조 완료' : '현장 실측 대조 전',
  ].join(' · ');
  const info: RowInput[] = [
    ['문서 번호', `${pkg.documentId}  (확정 v${pkg.version} · ${fmtDateTime(pkg.createdAt)})`],
    ['브랜드 / 담당', `${data.event.brand || '-'} / ${data.event.contact || '-'}`],
    ['행사', data.event.title || '-'],
    [
      '행사·대여 기간',
      `${data.event.startDate && data.event.endDate ? `${data.event.startDate} ~ ${data.event.endDate}` : '날짜 미정'} (대여 ${data.event.rentalDays}일)`,
    ],
    ['반입·설치 / 철거', `${data.event.moveIn || '확인 중'} / ${data.event.teardown || '확인 중'}`],
    ['공간', `${sp.name}${sp.address ? ` (${sp.address})` : ''} · ${m2(sp.width)} × ${m2(sp.depth)} m, 천장 ${m2(sp.height)} m`],
    ['공간 자료 상태', `${spaceState}\n출처: ${st.source || '-'} · 도면 확인일: ${st.drawingDate || '-'}`],
    ['요청 업체', `${data.vendor.name}${data.vendor.isVirtual ? ' (가상 카탈로그)' : ''} · 카탈로그 기준일 ${data.vendor.catalogDate || '-'}`],
  ];
  autoTable(doc, {
    ...baseTable,
    startY: y,
    body: info,
    styles: { ...baseTable.styles, cellPadding: 1.8 },
    columnStyles: { 0: { cellWidth: 34, textColor: MUTED, fillColor: [247, 246, 243] }, 1: { cellWidth: CONTENT_W - 34 } },
  });
  y = lastY() + 10;

  y = sectionTitle('예상 비용 요약', y);
  const budget = cost.budget;
  const diffText = budgetComparison;
  const summary: RowInput[] = [
    ['확인 금액 합계', won(cost.confirmedTotal)],
    ['추정 금액 합계', `${won(cost.estimatedTotal)}${cost.estimatedLines.length ? ` (${cost.estimatedLines.length}건)` : ''}`],
    [
      '미확인 항목(금액 미포함)',
      cost.unknownLines.length ? `${cost.unknownLines.length}건 — ${cost.unknownLines.map((l) => l.label).join(', ')}` : '없음',
    ],
    [
      { content: '확인 + 추정 합계', styles: { fontStyle: 'bold' } },
      {
        content: `${won(cost.knownTotal)}${cost.unknownLines.length ? '  · 최종 총액 미확정' : cost.estimatedLines.length ? '  · 추정 포함' : ''}`,
        styles: { fontStyle: 'bold', fontSize: 11 },
      },
    ],
    [
      budget.scope === 'fixtures' ? '집기 예산(집기·운송·설치·철거)' : '예산(전체 행사비 기준)',
      `${won(budget.amount)} · ${diffText}`,
    ],
    ['보증금(합계와 별도)', `${won(cost.depositTotal)}${cost.depositUnknownCount ? ` · 미확인 ${cost.depositUnknownCount}건` : ''}`],
  ];
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    body: summary,
    columnStyles: { 0: { cellWidth: 58, fillColor: [247, 246, 243] }, 1: { halign: 'left' } },
  });
  y = lastY() + 6;
  y = paragraph('이 문서는 등록된 공간 자료와 업체 카탈로그로 계산한 배치안·수량·예상 비용을 담은 견적 요청 자료다. 공급 가능 여부, 납기, 운송·설치 조건과 최종 금액은 업체 확인 후 확정된다. 미확인 항목은 0원으로 계산하지 않았다.', y);
  for (const warning of cost.warnings) y = paragraph(`· ${warning}`, y);

  // ------------------------------------------------------------------ 2. 평면 배치도
  doc.addPage();
  y = sectionTitle('평면 배치도', TOP + 6, `단위 m · 원점 = 왼쪽 위 모서리 · 번호는 품목·수량표와 같다${pkg.data.space.isVirtual ? ' · 가상 검증 공간' : ''}`);
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
      r.placement.noOrder ? '참고용(주문 제외)' : '',
    ];
  });
  autoTable(doc, {
    ...baseTable,
    startY: planBottom + 4,
    head: [['번호', '품목', '상품번호', '규격 W×D×H(m)', '회전', '위치(집기 바깥 모서리 기준, m)', '비고']],
    body: posRows,
    columnStyles: { 0: { cellWidth: 11, halign: 'center' }, 4: { cellWidth: 12, halign: 'center' } },
  });

  // ------------------------------------------------------------------ 3. 3D 참고 이미지
  if (assets.image3d) {
    doc.addPage();
    y = sectionTitle('3D 참고 보기', TOP + 6, '같은 버전으로 만든 참고 이미지다. 설치 기준은 평면 배치도의 치수를 따른다.');
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
  y = sectionTitle('품목·수량표', TOP + 6, '업체 상품번호 기준. 공급 가능 여부는 행사 날짜 기준으로 업체 확인이 필요하다.');
  const itemLines = cost.lines.filter((l) => l.kind === 'item');
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    head: [['배치 번호', '상품번호', '품목·규격', '구분', '수량', '단가', '금액', '상태']],
    body: itemLines.map((l) => [
      l.placementNos.join(', '),
      l.sku,
      `${l.label}\n${l.spec}${l.note ? `\n${l.note}` : ''}`,
      l.basis,
      { content: String(l.qty), styles: { halign: 'right' } },
      { content: won(l.unit), styles: { halign: 'right' } },
      { content: won(l.amount), styles: { halign: 'right' } },
      STATUS_LABEL[l.status],
    ]),
    columnStyles: { 0: { cellWidth: 16 }, 1: { cellWidth: 22 }, 3: { cellWidth: 25 }, 4: { cellWidth: 11 }, 7: { cellWidth: 13 } },
    didParseCell: statusCell(7),
  });
  y = lastY() + 5;
  y = ensure(y, 30);
  font(9, true);
  doc.text('가격 기준', ML, y + 2);
  autoTable(doc, {
    ...baseTable,
    startY: y + 4,
    head: [['상품번호', '부가세', '가격 기준일', '출처', '보증금']],
    body: itemLines.map((l) => [
      l.sku,
      l.vatIncluded == null ? '미확인' : l.vatIncluded ? '포함' : '별도',
      l.priceDate || '-',
      l.source || '-',
      l.deposit == null ? '미확인' : won(l.deposit),
    ]),
    styles: { ...baseTable.styles, fontSize: 7.8 },
    headStyles: { ...baseTable.headStyles, fillColor: [90, 90, 95] as RGB },
  });

  y = ensure(lastY() + 10, 60);
  y = sectionTitle('예상 비용표', y);
  const costBody: RowInput[] = cost.lines.map((l) => [
    l.kind === 'item' ? `${l.label} × ${l.qty}` : l.label,
    l.kind === 'item' ? l.basis : l.basis || '-',
    { content: won(l.amount), styles: { halign: 'right' } },
    STATUS_LABEL[l.status],
  ]);
  const foot: RowInput[] = [
    ['확인 금액 합계', '', { content: won(cost.confirmedTotal), styles: { halign: 'right' } }, ''],
    ['추정 금액 합계', '', { content: won(cost.estimatedTotal), styles: { halign: 'right' } }, ''],
    [
      '미확인 항목',
      cost.unknownLines.map((l) => l.label).join(', ') || '없음',
      { content: cost.unknownLines.length ? '금액 미포함' : '-', styles: { halign: 'right' } },
      '',
    ],
    [
      { content: '확인 + 추정 합계', styles: { fontStyle: 'bold' } },
      cost.finalDetermined ? '' : cost.unknownLines.length ? '최종 총액 미확정' : '추정 포함',
      { content: won(cost.knownTotal), styles: { halign: 'right', fontStyle: 'bold' } },
      '',
    ],
  ];
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    head: [['항목', '기준', '금액', '상태']],
    body: costBody,
    foot,
    footStyles: { font: FONT, fillColor: [247, 246, 243], textColor: INK, fontStyle: 'normal', lineWidth: 0.15, lineColor: LINE },
    columnStyles: { 2: { cellWidth: 34 }, 3: { cellWidth: 16 } },
    didParseCell: statusCell(3),
  });
  y = ensure(lastY() + 7, 25);
  autoTable(doc, {
    ...baseTable, startY: y,
    head: [['포함 항목', '포함하지 않은 비용']],
    body: [[pkg.included.map((text) => `· ${text}`).join('\n'), pkg.excluded.map((text) => `· ${text}`).join('\n')]],
    columnStyles: { 0: { cellWidth: CONTENT_W / 2 }, 1: { cellWidth: CONTENT_W / 2 } },
  });

  // ------------------------------------------------------------------ 5. 조건과 확인 요청
  doc.addPage();
  y = sectionTitle('일정·설치 조건', TOP + 6);
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    body: [
      ['행사·대여 기간', `${data.event.startDate || '-'} ~ ${data.event.endDate || '-'} (대여 ${data.event.rentalDays}일)`],
      ['반입·설치', data.event.moveIn || '확인 중'],
      ['철거', data.event.teardown || '확인 중'],
      ['추가 조건', data.event.conditions || '-'],
      ['요청 메모', data.memo || '-'],
    ],
    columnStyles: { 0: { cellWidth: 34, fillColor: [247, 246, 243] } },
  });
  y = lastY() + 8;
  y = sectionTitle('공간 조건', y);
  const wallKo: Record<Wall, string> = { top: '위쪽 벽', bottom: '아래쪽 벽', left: '왼쪽 벽', right: '오른쪽 벽' };
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    body: [
      ['크기', `${m2(sp.width)} × ${m2(sp.depth)} m, 천장 높이 ${m2(sp.height)} m`],
      [
        '출입구',
        sp.doors.map((d) => `${d.label}: ${wallKo[d.wall]}, 폭 ${m2(d.width)} m, 앞 여유 ${d.clearance == null ? '미확인' : `${m2(d.clearance)} m`}`).join('\n') || '-',
      ],
      ['기둥', sp.columns.map((c) => `${c.label} ${m2(c.w)}×${m2(c.d)} m`).join(', ') || '없음'],
      ['배치 금지 구역', sp.zones.map((z) => `${z.label}${z.reason ? `: ${z.reason}` : ''}`).join('\n') || '없음'],
      ['고정 시설', sp.fixtures.map((f) => f.label).join(', ') || '없음'],
      ['전원 위치', sp.powerPoints.map((p) => `${p.label}(${m2(p.x)}, ${m2(p.y)})`).join(', ') || '미확인'],
      ['통로 폭 기준', sp.rules.minAisle == null ? '미확인(검사 안 함)' : `${m2(sp.rules.minAisle)} m (${sp.rules.note || '운영자 확인값'})`],
      ['자료 사용 범위', st.usageScope || '미확인'],
    ],
    columnStyles: { 0: { cellWidth: 34, fillColor: [247, 246, 243] } },
  });
  y = lastY() + 8;

  const shownIssues = pkg.issues.filter((i) => i.severity !== 'info' || i.code === 'VIRTUAL_SPACE' || i.code.endsWith('_MISSING'));
  if (shownIssues.length) {
    y = ensure(y, 25);
    y = sectionTitle('배치 검사 결과', y, '경계·겹침·금지 구역 등 등록 조건 검사 결과다. 안전·소방·전기 규정 적합성 확인이 아니다.');
    autoTable(doc, {
      ...baseTable,
      startY: y + 1,
      body: shownIssues.map((i) => [i.severity === 'error' ? '오류' : i.severity === 'warning' ? '주의' : '참고', i.message]),
      columnStyles: { 0: { cellWidth: 14, halign: 'center' } },
    });
    y = lastY() + 8;
  }

  y = ensure(y, 30);
  y = sectionTitle('업체 확인 요청', y, `회신 시 문서 번호 ${josa(pkg.documentId, '을/를')} 함께 적어 주세요.`);
  autoTable(doc, {
    ...baseTable,
    startY: y + 1,
    body: pkg.questions.map((q, i) => [String(i + 1), q]),
    columnStyles: { 0: { cellWidth: 9, halign: 'center' } },
  });

  // ------------------------------------------------------------------ 머리글·바닥글·워터마크
  const total = doc.getNumberOfPages();
  const virtual = data.space.isVirtual || data.vendor.isVirtual;
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    font(7.5, false, MUTED);
    doc.text('Pop-3D · 팝업 기획보고서', ML, 12);
    doc.text(`${pkg.documentId} · v${pkg.version} · ${fmtDateTime(pkg.createdAt)}`, PAGE_W - ML, 12, { align: 'right' });
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.2);
    doc.line(ML, 14, PAGE_W - ML, 14);
    doc.line(ML, PAGE_H - 12, PAGE_W - ML, PAGE_H - 12);
    doc.text(`예상 비용 포함 · 공식 견적 아님${virtual ? ' · 가상 검증 데이터' : ''}`, ML, PAGE_H - 7.5);
    doc.text(`${i} / ${total}`, PAGE_W - ML, PAGE_H - 7.5, { align: 'right' });
    if (virtual || !data.space.status.scaleConfirmed) {
      doc.saveGraphicsState();
      doc.setGState(new GState({ opacity: 0.07 }));
      font(44, true, INK);
      const mark = virtual ? '가상 검증 데이터' : '축척 미확인 · 참고용';
      const w = doc.getTextWidth(mark);
      const a = (28 * Math.PI) / 180;
      doc.text(mark, PAGE_W / 2 - (Math.cos(a) * w) / 2, PAGE_H / 2 + (Math.sin(a) * w) / 2, { angle: 28 });
      doc.restoreGraphicsState();
    }
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
    const hasErr = pkg.issues.some((i) => i.severity === 'error' && i.placementIds.includes(r.placement.id));
    doc.setFillColor(...hexToRgb(it.color || '#b9bcc2', 0.62));
    doc.setDrawColor(...(hasErr ? ([229, 72, 77] as RGB) : INK));
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
