// 확정 버전 → PDF / GLB 파일. 무거운 모듈(jsPDF·폰트)은 누를 때만 불러온다.
import { buildQuotePackage } from '../domain/quote';
import { snapshotData } from '../domain/version';
import type { Space, VersionSnapshot } from '../domain/types';
import { arrayBufferToBase64, downloadBlob, safeFileName, shareFile } from './browser';

let fontCache: Promise<{ regular: string; bold: string }> | null = null;

function loadFonts() {
  fontCache ??= Promise.all(
    ['NotoSansKR-Regular.ttf', 'NotoSansKR-Bold.ttf'].map(async (f) => {
      const res = await fetch(`${import.meta.env.BASE_URL}fonts/${f}`);
      if (!res.ok) throw new Error(`폰트를 불러오지 못했습니다(${f})`);
      return arrayBufferToBase64(await res.arrayBuffer());
    }),
  )
    .then(([regular, bold]) => ({ regular, bold }))
    .catch((e) => {
      fontCache = null;
      throw e;
    });
  return fontCache;
}

export function pdfFileName(snap: VersionSnapshot): string {
  return `기획보고서_${safeFileName(snap.projectName)}_v${snap.version}.pdf`;
}

export async function buildPdfBlob(snap: VersionSnapshot): Promise<Blob> {
  const [{ createQuotePdf }, { renderLayoutImage }, fonts] = await Promise.all([
    import('../pdf/quotePdf'),
    import('../three/render'),
    loadFonts(),
  ]);
  const pkg = buildQuotePackage(snap);
  const image3d = renderLayoutImage(snapshotData(snap), 1600, 1000);
  const doc = createQuotePdf(pkg, { ...fonts, image3d });
  return doc.output('blob');
}

/** mode=share: 모바일 공유 시트(카카오톡 등). 지원하지 않으면 내려받기로 대신한다. */
export async function exportPdf(snap: VersionSnapshot, mode: 'download' | 'share' = 'download'): Promise<'shared' | 'downloaded'> {
  const blob = await buildPdfBlob(snap);
  const name = pdfFileName(snap);
  if (mode === 'share' && (await shareFile(blob, name, `${snap.projectName} 기획보고서 v${snap.version}`))) return 'shared';
  downloadBlob(blob, name);
  return 'downloaded';
}

export async function exportLayoutGlbFile(snap: VersionSnapshot): Promise<void> {
  const { exportLayoutGlb } = await import('../three/glb');
  const blob = await exportLayoutGlb(snapshotData(snap), snap.version);
  downloadBlob(blob, `배치_${safeFileName(snap.projectName)}_v${snap.version}.glb`);
}

export async function exportSpaceGlbFile(space: Space): Promise<void> {
  const { exportSpaceGlb } = await import('../three/glb');
  const blob = await exportSpaceGlb(space);
  downloadBlob(blob, `공간_${safeFileName(space.name)}.glb`);
}
