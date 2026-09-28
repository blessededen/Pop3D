import { proposePlan, type PlanResult } from './planner';
import { demoProject, demoSpace, demoVendor } from './seed';
import type { Project, Requirement, Space, Vendor } from './types';
import { draftData } from './version';

/** An isolated example workspace. The caller decides when to add it to the store. */
export function createAutoDemoWorkspace(runId: string, now = new Date()): { space: Space; vendor: Vendor; project: Project } {
  if (!runId.trim()) throw new Error('자동 시연 실행 ID가 필요합니다.');
  if (!Number.isFinite(now.getTime())) throw new Error('자동 시연 날짜가 올바르지 않습니다.');
  // Encoding rather than removing punctuation avoids collisions between run IDs.
  const prefix = `auto-demo-${encodeURIComponent(runId)}`;
  const id = (kind: string) => `${prefix}-${kind}`;
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dateAt = (offset: number) => new Date(day.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const startOffset = (6 - day.getUTCDay() + 7) % 7;
  const source = '자동 시연용 예시 금액 · 실제 업체 견적 아님';

  const space = structuredClone(demoSpace());
  Object.assign(space, {
    id: id('space'), name: 'MOSS · 50m² 팝업 공간 [시연]', address: '', isVirtual: true,
    width: 5, depth: 10, height: 3,
    doors: [{ id: id('entrance'), wall: 'bottom', offset: 1.75, width: 1.5, clearance: 1.2, label: '주 출입구' }],
    columns: [{ id: id('column'), x: 4.6, y: 4.8, w: 0.4, d: 0.4, label: '건물 기둥' }],
    zones: [], fixtures: [],
    powerPoints: [
      { id: id('power-photo'), x: 2.5, y: 0, label: '포토존 전원' },
      { id: id('power-counter'), x: 5, y: 7.5, label: '카운터 전원' },
    ],
    rules: { minAisle: 0.9, maxItemHeight: null, note: '자동 시연에 사용하는 최소 통로 폭 90cm' },
    status: {
      scaleConfirmed: true, fieldMeasured: false, drawingDate: dateAt(0),
      source: '자동 시연을 위해 만든 예시 공간', usageScope: '제품 기능 시연용', note: '',
    },
  } satisfies Partial<Space>);

  const vendor = structuredClone(demoVendor());
  const counts = new Map([
    ['TEST-P01', 1], ['TEST-C01', 1], ['TEST-R01', 3], ['TEST-T01', 1],
    ['TEST-D01', 1], ['TEST-S01', 1], ['TEST-M01', 1],
  ]);
  vendor.id = id('vendor');
  vendor.name = 'MOSS 시연용 집기 카탈로그';
  vendor.contact = '';
  vendor.catalogDate = dateAt(0);
  vendor.isVirtual = true;
  const requirements: Requirement[] = [];
  vendor.items = vendor.items.filter(item => counts.has(item.sku)).map(item => {
    const quantity = counts.get(item.sku)!;
    const powered = item.category === 'photozone' || item.category === 'counter';
    const sku = id(item.sku.toLowerCase());
    requirements.push({ category: item.category, sku, required: true, minQty: quantity, desiredQty: quantity, priority: 1, needsPower: powered });
    return {
      ...item, sku, needsPower: powered, deposit: 0, modelUrl: '', modelLicense: '',
      color: item.category === 'photozone' ? '#526b57' : item.color,
      note: '자동 시연용 예시 집기',
      price: { ...item.price, status: 'confirmed', basisDays: 7, source, priceDate: dateAt(0) },
    };
  });
  vendor.services = vendor.services.map(fee => ({ ...fee, id: id(fee.id), source, basis: '시연 예시 정액' }));

  const project = structuredClone(demoProject(space, vendor, now));
  project.id = id('project');
  project.name = 'MOSS · 주말 팝업 [시연]';
  project.event = {
    title: 'MOSS · 일상에 초록을 더하는 한 주', brand: 'MOSS [시연 브랜드]', contact: '',
    startDate: dateAt(startOffset), endDate: dateAt(startOffset + 6), rentalDays: 7,
    moveIn: `${dateAt(startOffset - 1)} 18:00`, teardown: `${dateAt(startOffset + 6)} 20:00`,
    conditions: '입구에서 컬렉션을 둘러보고, 제품 체험과 촬영을 거쳐 카운터로 이어지는 팝업입니다.',
    brief: {
      objective: '가벼운 산책과 일상을 위한 MOSS 컬렉션을 직접 보고 만져보는 브랜드 경험을 만듭니다.',
      audience: '주말에 새로운 브랜드와 편안한 옷을 발견하고 싶은 방문객',
      experience: '컬렉션 탐색 → 소재와 제품 체험 → 전신 거울과 포토존 촬영 → 카운터 상담',
      approval: '50m² 공간의 집기 9개 구성, 90cm 최소 통로, 7일 대여와 예상 비용을 함께 검토합니다.',
    },
  };
  project.budget = { amount: 1_500_000, scope: 'fixtures' };
  project.requirements = requirements;
  project.placements = [];
  project.versions = [];
  project.layoutNeedsUpdate = true;
  project.memo = '자동 시연으로 만든 예시 프로젝트입니다. 공간·브랜드·가격은 실제 행사나 업체 견적이 아닙니다.';
  return { space, vendor, project };
}

/** Use the same real A* planner as a normal project; never substitute mock coordinates. */
export function planAutoDemo(project: Project, space: Space, vendor: Vendor): PlanResult {
  return proposePlan(draftData(project, space, vendor), { preserveQuantities: true });
}
