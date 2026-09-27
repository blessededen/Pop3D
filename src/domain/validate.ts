import { doorClearRect, footprint, polyDistance, polyInside, polysOverlap, rectPoly, type Poly } from './geometry';
import { josa } from './josa';
import { FRONT_ACCESS_DEPTH, fixtureHeightStatus, frontAccessPoly, nearestPowerDistance, validPowerPoints } from './placementRules';
import { CATEGORY_LABEL, type CatalogItem, type LayoutData, type Placement, type Space } from './types';

export type IssueCode =
  | 'SPACE_DATA'
  | 'INVALID_GEOMETRY'
  | 'OUT_OF_BOUNDS'
  | 'OVERLAP'
  | 'COLUMN'
  | 'NO_GO_ZONE'
  | 'FIXTURE'
  | 'DOOR_CLEARANCE'
  | 'ACCESS_BLOCKED'
  | 'POWER_POINT_MISSING'
  | 'POWER_DISTANCE'
  | 'HEIGHT'
  | 'HEIGHT_CLEARANCE'
  | 'UNKNOWN_SKU'
  | 'REQUIRED_MISSING'
  | 'AISLE'
  | 'DOOR_RULE_MISSING'
  | 'AISLE_RULE_MISSING'
  | 'SCALE_UNCONFIRMED'
  | 'NOT_FIELD_MEASURED'
  | 'VIRTUAL_SPACE';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  code: IssueCode;
  severity: Severity;
  message: string;
  placementIds: string[];
}

export type ItemIndex = Map<string, CatalogItem>;

export function indexItems(items: CatalogItem[]): ItemIndex {
  return new Map(items.map((i) => [i.sku, i]));
}

/** 배치 번호: 배열 순서대로 1부터. 화면·수량표·PDF가 같은 번호를 쓴다. */
export function placementNumbers(placements: Placement[]): Map<string, number> {
  return new Map(placements.map((p, i) => [p.id, i + 1]));
}

export function hasValidItemGeometry(item: Pick<CatalogItem, 'w' | 'd' | 'h'>): boolean {
  return [item.w, item.d, item.h].every((value) => Number.isFinite(value) && value > 0);
}

export function placementPoly(p: Placement, item: CatalogItem): Poly {
  return footprint(p.x, p.y, item.w, item.d, p.rot);
}

export interface Obstacle {
  id: string;
  label: string;
  kind: 'column' | 'zone' | 'fixture' | 'door';
  poly: Poly;
}

export function spaceObstacles(space: Space): Obstacle[] {
  const out: Obstacle[] = [];
  for (const c of space.columns) out.push({ id: c.id, label: c.label, kind: 'column', poly: rectPoly(c) });
  for (const z of space.zones) out.push({ id: z.id, label: z.label, kind: 'zone', poly: rectPoly(z) });
  for (const f of space.fixtures) out.push({ id: f.id, label: f.label, kind: 'fixture', poly: rectPoly(f) });
  for (const d of space.doors) {
    const r = doorClearRect(space, d);
    if (r) out.push({ id: r.id, label: r.label, kind: 'door', poly: rectPoly(r) });
  }
  return out;
}

const KIND_CODE: Record<Obstacle['kind'], IssueCode> = {
  column: 'COLUMN',
  zone: 'NO_GO_ZONE',
  fixture: 'FIXTURE',
  door: 'DOOR_CLEARANCE',
};

const KIND_TEXT: Record<Obstacle['kind'], string> = {
  column: '기둥',
  zone: '배치 금지 구역',
  fixture: '고정 시설',
  door: '출입구 앞 여유 구역',
};

const FLUSH_GAP = 0.02;

export function validateLayout(data: LayoutData): Issue[] {
  const { space, placements, requirements } = data;
  const items = indexItems(data.vendor.items);
  const nums = placementNumbers(placements);
  const spaceProblems = checkSpaceData(space);
  const issues: Issue[] = spaceProblems.map((message) => ({ code: 'SPACE_DATA', severity: 'error', message, placementIds: [] }));
  const tag = (p: Placement) => {
    const it = items.get(p.sku);
    return `${nums.get(p.id)}번 ${it ? it.name : p.sku}`;
  };

  // 공간 자료 상태
  if (space.isVirtual) {
    issues.push({
      code: 'VIRTUAL_SPACE',
      severity: 'info',
      message: '가상 검증 공간입니다. 실제 매장 치수가 아니므로 현장 설치 가능성을 보여주지 않습니다.',
      placementIds: [],
    });
  }
  if (!space.status.scaleConfirmed) {
    issues.push({
      code: 'SCALE_UNCONFIRMED',
      severity: 'warning',
      message: '도면 축척이 확인되지 않았습니다. 산출물은 참고용으로 표시됩니다.',
      placementIds: [],
    });
  } else if (!space.status.fieldMeasured) {
    issues.push({
      code: 'NOT_FIELD_MEASURED',
      severity: 'info',
      message: '도면 치수만 확인된 상태입니다. 현장 실측 대조는 아직 하지 않았습니다.',
      placementIds: [],
    });
  }
  if (space.doors.some((d) => d.clearance == null)) {
    issues.push({
      code: 'DOOR_RULE_MISSING',
      severity: 'info',
      message: '출입구 앞 여유 폭을 받지 못한 문이 있어 해당 문 앞은 검사하지 않았습니다.',
      placementIds: [],
    });
  }
  if (space.rules.minAisle == null) {
    issues.push({
      code: 'AISLE_RULE_MISSING',
      severity: 'info',
      message: '통로 폭 기준이 입력되지 않아 집기 사이 간격은 검사하지 않았습니다.',
      placementIds: [],
    });
  }

  const polys = new Map<string, Poly>();
  const accessPolys = new Map<string, Poly>();
  const accessDepth = Math.max(FRONT_ACCESS_DEPTH, Number.isFinite(space.rules.minAisle) ? space.rules.minAisle ?? 0 : 0);
  for (const p of placements) {
    const it = items.get(p.sku);
    if (!it) {
      issues.push({
        code: 'UNKNOWN_SKU',
        severity: 'error',
        message: `${nums.get(p.id)}번 집기의 상품번호 ${p.sku}가 카탈로그에 없습니다.`,
        placementIds: [p.id],
      });
      continue;
    }
    if (!hasValidItemGeometry(it) || ![p.x, p.y, p.rot].every(Number.isFinite)) {
      issues.push({ code: 'INVALID_GEOMETRY', severity: 'error', message: `${tag(p)}의 치수 또는 위치가 올바르지 않습니다. 가로·깊이·높이는 양수, 위치·회전은 유효한 숫자로 입력해 주세요.`, placementIds: [p.id] });
      continue;
    }
    const poly = placementPoly(p, it);
    polys.set(p.id, poly);
    const access = frontAccessPoly(p, it, accessDepth);
    if (access) accessPolys.set(p.id, access);

    if (!polyInside(poly, space.width, space.depth)) {
      issues.push({
        code: 'OUT_OF_BOUNDS',
        severity: 'error',
        message: `${josa(tag(p), '이/가')} 공간 경계를 벗어났습니다.`,
        placementIds: [p.id],
      });
    }
    const height = fixtureHeightStatus(space, it);
    if (height.blocked) {
      issues.push({
        code: 'HEIGHT',
        severity: 'error',
        message: `${tag(p)} 높이 ${it.h}m가 공간 높이 ${space.height}m 이상입니다. 입력한 수직 규격 기준 반입 불가입니다.`,
        placementIds: [p.id],
      });
    } else if (height.warning) {
      issues.push({ code: 'HEIGHT_CLEARANCE', severity: 'warning', message: `${tag(p)} 상부 여유가 ${Number((height.clearance * 100).toFixed(1))}cm로 30cm 미만입니다. 반입·설치 여유를 확인해 주세요.`, placementIds: [p.id] });
    }
  }

  const obstacles = spaceProblems.length ? [] : spaceObstacles(space);
  for (const p of placements) {
    const poly = polys.get(p.id);
    if (!poly) continue;
    const access = accessPolys.get(p.id);
    if (access && !polyInside(access, space.width, space.depth)) {
      issues.push({ code: 'ACCESS_BLOCKED', severity: 'error', message: `${tag(p)} 정면의 사용 여유 ${accessDepth}m가 공간 경계를 벗어납니다. 집기의 방향이나 위치를 바꿔 주세요.`, placementIds: [p.id] });
    }
    for (const o of obstacles) {
      if (polysOverlap(poly, o.poly)) {
        issues.push({
          code: KIND_CODE[o.kind],
          severity: 'error',
          message: `${josa(tag(p), '이/가')} ${KIND_TEXT[o.kind]}(${josa(o.label + ')', '을/를')} 침범합니다.`,
          placementIds: [p.id],
        });
      } else if (access && o.kind !== 'door' && polysOverlap(access, o.poly)) {
        issues.push({ code: 'ACCESS_BLOCKED', severity: 'error', message: `${tag(p)} 정면의 사용 여유 ${accessDepth}m를 ${KIND_TEXT[o.kind]}(${josa(o.label + ')', '이/가')} 막고 있습니다.`, placementIds: [p.id] });
      }
    }
  }

  const minAisle = space.rules.minAisle;
  for (let i = 0; i < placements.length; i++) {
    const a = placements[i];
    const pa = polys.get(a.id);
    if (!pa) continue;
    for (let j = i + 1; j < placements.length; j++) {
      const b = placements[j];
      const pb = polys.get(b.id);
      if (!pb) continue;
      if (polysOverlap(pa, pb)) {
        issues.push({
          code: 'OVERLAP',
          severity: 'error',
          message: `${josa(tag(a), '과/와')} ${josa(tag(b), '이/가')} 겹칩니다.`,
          placementIds: [a.id, b.id],
        });
        continue;
      }
      const accessA = accessPolys.get(a.id);
      const accessB = accessPolys.get(b.id);
      if (accessA && polysOverlap(accessA, pb)) {
        issues.push({ code: 'ACCESS_BLOCKED', severity: 'error', message: `${tag(a)} 정면의 사용 여유 ${accessDepth}m를 ${josa(tag(b), '이/가')} 막고 있습니다.`, placementIds: [a.id, b.id] });
      }
      if (accessB && polysOverlap(accessB, pa)) {
        issues.push({ code: 'ACCESS_BLOCKED', severity: 'error', message: `${tag(b)} 정면의 사용 여유 ${accessDepth}m를 ${josa(tag(a), '이/가')} 막고 있습니다.`, placementIds: [b.id, a.id] });
      }
      if (minAisle != null) {
        const gap = polyDistance(pa, pb);
        if (gap > FLUSH_GAP && gap < minAisle - 1e-6) {
          issues.push({
            code: 'AISLE',
            severity: 'error',
            message: `${josa(tag(a), '과/와')} ${tag(b)} 사이가 ${gap.toFixed(2)}m로, 입력된 통로 기준 ${minAisle}m보다 좁습니다.`,
            placementIds: [a.id, b.id],
          });
        }
      }
    }
  }

  const powerSkus = new Set(requirements.filter((requirement) => requirement.needsPower).map((requirement) => requirement.sku));
  const poweredPlacements = placements.filter((placement) => powerSkus.has(placement.sku) && polys.has(placement.id));
  const powerPoints = validPowerPoints(space);
  if (poweredPlacements.length && !powerPoints.length) {
    issues.push({ code: 'POWER_POINT_MISSING', severity: 'warning', message: '전원이 필요한 품목이 있지만 등록된 전원점이 없습니다. 공간에 전원점을 추가한 뒤 다시 배치해 주세요.', placementIds: poweredPlacements.map((placement) => placement.id) });
  } else {
    for (const placement of poweredPlacements) {
      const distance = nearestPowerDistance(placement, powerPoints);
      issues.push({ code: 'POWER_DISTANCE', severity: 'info', message: `${tag(placement)} 중심에서 가장 가까운 전원점까지 직선 ${distance.toFixed(2)}m입니다. 배선 경로와 전기 용량은 별도 확인이 필요합니다.`, placementIds: [placement.id] });
    }
  }

  // 같은 종류라도 규격별 요구 수량은 서로 대체하지 않는다.
  const required = new Map<string, { need: number; label: string }>();
  for (const r of requirements) {
    if (!r.required) continue;
    const previous = required.get(r.sku);
    required.set(r.sku, { need: (previous?.need ?? 0) + Math.max(1, r.minQty), label: items.get(r.sku)?.name || CATEGORY_LABEL[r.category] });
  }
  for (const [sku, { need, label }] of required) {
    const count = placements.filter((p) => !p.noOrder && p.sku === sku && polys.has(p.id)).length;
    if (count < need) {
      issues.push({
        code: 'REQUIRED_MISSING',
        severity: 'error',
        message: `필수 집기 ${label}(${sku}) ${need}개가 필요하지만 ${count}개만 배치되어 있습니다.`,
        placementIds: [],
      });
    }
  }

  return issues;
}

export function hasBlockingIssues(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/** 공간 자료 자체의 모순(문이 벽 밖, 기둥이 공간 밖 등). 배치 검사 전에 공간 편집 화면에서 보여준다. */
export function checkSpaceData(space: Space): string[] {
  const out: string[] = [];
  const { width: W, depth: D, height: H } = space;
  if (![W, D, H].every((value) => Number.isFinite(value) && value > 0)) out.push('가로·세로·천장 높이는 0보다 큰 유효한 숫자여야 합니다.');
  const walls = ['top', 'bottom', 'left', 'right'] as const;
  const len = (wall: string) => (wall === 'top' || wall === 'bottom' ? W : D);
  for (const door of space.doors) {
    if (!walls.includes(door.wall)) out.push(`${door.label}: 문이 붙는 벽을 확인해 주세요.`);
    if (!Number.isFinite(door.width) || door.width <= 0) out.push(`${door.label}: 폭은 0보다 큰 유효한 숫자여야 합니다.`);
    if (!Number.isFinite(door.offset) || door.offset < 0 || door.offset + door.width > len(door.wall) + 1e-6) out.push(`${door.label}: 문이 벽 길이(${len(door.wall)}m)를 벗어나거나 위치가 올바르지 않습니다.`);
    if (door.clearance != null && (!Number.isFinite(door.clearance) || door.clearance < 0 || door.clearance > (door.wall === 'top' || door.wall === 'bottom' ? D : W))) out.push(`${door.label}: 출입구 앞 여유 깊이는 공간 안의 유효한 길이여야 합니다.`);
  }
  for (const wall of walls) {
    const doors = space.doors.filter((door) => door.wall === wall).sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < doors.length; i++) {
      if (doors[i].offset < doors[i - 1].offset + doors[i - 1].width - 1e-6) out.push(`${doors[i - 1].label}과 ${doors[i].label}이 겹칩니다.`);
    }
  }
  const rects = [
    ...space.columns.map((rect) => ['기둥', rect] as const),
    ...space.zones.map((rect) => ['금지 구역', rect] as const),
    ...space.fixtures.map((rect) => ['고정 시설', rect] as const),
  ];
  for (const [kind, rect] of rects) {
    if (![rect.w, rect.d].every((value) => Number.isFinite(value) && value > 0)) out.push(`${kind} ${rect.label}: 크기는 0보다 큰 유효한 숫자여야 합니다.`);
    if (![rect.x, rect.y].every(Number.isFinite) || rect.x < -1e-6 || rect.y < -1e-6 || rect.x + rect.w > W + 1e-6 || rect.y + rect.d > D + 1e-6) out.push(`${kind} ${rect.label}: 공간 밖이거나 위치가 올바르지 않습니다.`);
  }
  for (const point of space.powerPoints) {
    if (![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.x > W || point.y > D) out.push(`전원 ${point.label}: 공간 밖이거나 위치가 올바르지 않습니다.`);
  }
  if (space.rules.minAisle != null && (!Number.isFinite(space.rules.minAisle) || space.rules.minAisle < 0)) out.push('통로 폭 기준은 0 이상의 유효한 숫자여야 합니다.');
  return out;
}
