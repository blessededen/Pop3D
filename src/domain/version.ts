import type { LayoutData, Project, Space, Vendor, VendorSnapshot, VersionSnapshot } from './types';

/** 초안이 참조하는 품목만 담은 카탈로그 사본 */
export function vendorSnapshot(vendor: Vendor, skus: Iterable<string>): VendorSnapshot {
  const used = new Set(skus);
  return {
    id: vendor.id,
    name: vendor.name,
    contact: vendor.contact,
    catalogDate: vendor.catalogDate,
    isVirtual: vendor.isVirtual,
    items: vendor.items.filter((i) => used.has(i.sku)),
  };
}

function usedSkus(p: Pick<Project, 'placements' | 'requirements'>): string[] {
  return [...p.placements.map((x) => x.sku), ...p.requirements.map((r) => r.sku)];
}

/** 프로젝트 초안 → 계산 입력. 카탈로그 전체를 넘겨 규격 변경 후보도 쓸 수 있게 한다. */
export function draftData(project: Project, space: Space, vendor: Vendor): LayoutData {
  return {
    projectName: project.name,
    space,
    vendor: { ...vendorSnapshot(vendor, []), items: vendor.items },
    event: project.event,
    budget: project.budget,
    requirements: project.requirements,
    placements: project.placements,
    fees: project.fees,
    memo: project.memo,
  };
}

export function snapshotData(s: VersionSnapshot): LayoutData {
  return {
    projectName: s.projectName,
    space: s.space,
    vendor: s.vendor,
    event: s.event,
    budget: s.budget,
    requirements: s.requirements,
    placements: s.placements,
    fees: s.fees,
    memo: s.memo,
  };
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

/** FNV-1a 기반 짧은 해시. 보안 용도가 아니라 '같은 내용인가' 판별용 */
export function contentHash(v: unknown): string {
  const s = stable(v);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).toUpperCase();
}

/** 버전 비교에 쓰는 내용. 공간의 참고 모델 표시 여부처럼 결과물과 무관한 값은 뺀다. */
function hashInput(d: LayoutData) {
  const { refModel: _ref, ...rest } = d.space;
  // 자료 인수 체크 기록은 산출물 내용과 무관하다
  const space = { ...rest, status: { ...rest.status, checks: undefined } };
  const used = new Set(usedSkus(d));
  return {
    projectName: d.projectName,
    space,
    vendor: { ...d.vendor, items: d.vendor.items.filter((i) => used.has(i.sku)) },
    event: d.event,
    budget: d.budget,
    requirements: d.requirements,
    placements: d.placements,
    fees: d.fees,
    memo: d.memo,
  };
}

export function layoutHash(d: LayoutData): string {
  return contentHash(hashInput(d));
}

export function latestVersion(project: Project): VersionSnapshot | undefined {
  return project.versions[project.versions.length - 1];
}

/** 확정 이후 배치·가격·규격·공간 등 무엇이든 바뀌었으면 true */
export function isDirty(project: Project, space: Space, vendor: Vendor): boolean {
  const last = latestVersion(project);
  if (!last) return true;
  return last.hash !== layoutHash(draftData(project, space, vendor));
}

export function makeSnapshot(project: Project, space: Space, vendor: Vendor, now = new Date()): VersionSnapshot {
  const data = draftData(project, space, vendor);
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const { refModel: _ref, ...spaceNoRef } = space;
  return {
    version: (latestVersion(project)?.version ?? 0) + 1,
    createdAt: now.toISOString(),
    hash: layoutHash(data),
    projectName: project.name,
    space: clone(spaceNoRef),
    vendor: clone(vendorSnapshot(vendor, usedSkus(project))),
    event: clone(project.event),
    budget: clone(project.budget),
    requirements: clone(project.requirements),
    placements: clone(project.placements),
    fees: clone(project.fees),
    memo: project.memo,
  };
}
