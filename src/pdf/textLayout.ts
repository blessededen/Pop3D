import type { jsPDF } from 'jspdf';

/** Keep explicit line breaks and constrain even a word without spaces by its
 * embedded-font width. AutoTable receives finished lines rather than guessing
 * the width again with a different font or cell padding. */
export function wrapPdfText(doc: Pick<jsPDF, 'getTextWidth' | 'splitTextToSize'>, text: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) throw new Error('PDF 텍스트 영역의 너비가 유효하지 않습니다.');
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    const wrapped = doc.splitTextToSize(paragraph, width) as string[];
    for (const line of wrapped) {
      let remaining = Array.from(line);
      // Recheck using the same font measurement used when printing. Some font
      // metrics and long unbroken tokens can exceed splitTextToSize's estimate.
      while (remaining.length > 1 && doc.getTextWidth(remaining.join('')) > width + 1e-7) {
        let low = 1;
        let high = remaining.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (doc.getTextWidth(remaining.slice(0, middle).join('')) <= width + 1e-7) low = middle;
          else high = middle - 1;
        }
        lines.push(remaining.slice(0, low).join(''));
        remaining = remaining.slice(low);
      }
      lines.push(remaining.join(''));
    }
  }
  return lines;
}
