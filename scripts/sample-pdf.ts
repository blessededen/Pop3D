// 9장 가상 검증 예시로 견적 요청서 PDF·카탈로그 CSV 샘플을 만든다: npm run samples
// (Node에는 WebGL이 없어 3D 참고 이미지는 빠진다. 웹에서 내보내면 포함된다.)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exportCatalogCsv } from '../src/domain/csv';
import { proposePlan } from '../src/domain/planner';
import { buildQuotePackage } from '../src/domain/quote';
import { demoProject, demoSpace, demoVendor } from '../src/domain/seed';
import { draftData, makeSnapshot } from '../src/domain/version';
import { createQuotePdf } from '../src/pdf/quotePdf';

const root = resolve(import.meta.dirname ?? '.', '..');
const font = (f: string) => readFileSync(resolve(root, 'public/fonts', f)).toString('base64');
const assets = { regular: font('NotoSansKR-Regular.ttf'), bold: font('NotoSansKR-Bold.ttf') };

const space = demoSpace();
const vendor = demoVendor();
const project = demoProject(space, vendor);
const outDir = resolve(root, 'samples');
mkdirSync(outDir, { recursive: true });

for (const [budget, label] of [
  [1200000, 'v1_예산120만'],
  [900000, 'v2_예산90만'],
] as const) {
  project.budget = { amount: budget, scope: 'fixtures' };
  const plan = proposePlan(draftData(project, space, vendor));
  if (!plan.ok) throw new Error(plan.reasons.join('\n'));
  project.placements = plan.placements;
  const snap = makeSnapshot(project, space, vendor);
  project.versions.push(snap);
  const pkg = buildQuotePackage(snap);
  const doc = createQuotePdf(pkg, assets);
  const file = resolve(outDir, `견적요청서_${label}.pdf`);
  writeFileSync(file, Buffer.from(doc.output('arraybuffer')));
  console.log(`${file}  합계 ${pkg.cost.knownTotal.toLocaleString('ko-KR')}원  페이지 ${doc.getNumberOfPages()}`);
}

const csv = resolve(outDir, '카탈로그_가상검증예시.csv');
writeFileSync(csv, exportCatalogCsv(vendor.items));
console.log(csv);
