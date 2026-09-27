// Local PDF layout QA: node node_modules/vite-node/dist/cli.mjs src/pdf/quotePdf.stress.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { proposePlan } from '../domain/planner';
import { buildQuotePackage } from '../domain/quote';
import { demoProject, demoSpace, demoVendor } from '../domain/seed';
import { draftData, makeSnapshot } from '../domain/version';
import { createQuotePdf } from './quotePdf';

const space = demoSpace();
const vendor = demoVendor();
const project = demoProject(space, vendor);
const plan = proposePlan(draftData(project, space, vendor));
if (!plan.ok) throw new Error(plan.summary);
project.placements = plan.placements;
project.event.brief = {
  objective: Array.from({ length: 42 }, (_, index) => `목적${String(index + 1).padStart(3, '0')} 신제품을 직접 체험하고 제품별 특징과 사용 과정을 이해할 수 있는 팝업스토어를 기획합니다.\n방문 고객이 원하는 제품을 편하게 살펴보도록 구성합니다.`).join('\n\n'),
  audience: '대상고객시작\n' + '브랜드를처음접하는고객과평소제품을사용하는재방문고객'.repeat(80) + '\n\n' + 'LongUnbrokenAudienceToken'.repeat(120) + '\n대상고객끝',
  experience: '제품 체험\n\n설명과 상담\n기념 촬영',
  approval: '선택한 구성과 예상 집기 비용 검토를 요청합니다.',
};
const root = process.cwd();
const font = (name: string) => readFileSync(resolve(root, 'public/fonts', name)).toString('base64');
const doc = createQuotePdf(buildQuotePackage(makeSnapshot(project, space, vendor)), {
  regular: font('NotoSansKR-Regular.ttf'), bold: font('NotoSansKR-Bold.ttf'),
});
const directory = resolve(root, 'tmp/pdfs');
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'long-brief.pdf'), Buffer.from(doc.output('arraybuffer')));
writeFileSync(resolve(directory, 'long-brief-expected.json'), JSON.stringify(project.event.brief, null, 2));
console.log(`PDF layout stress sample: ${doc.getNumberOfPages()} pages, ${resolve(directory, 'long-brief.pdf')}`);
