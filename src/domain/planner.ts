import { unitPrice, won } from './cost';
import { boundedAStar } from './astar';
import { bounds, doorCenter, footprint, polyDistance, polyInside, polysOverlap, round, type Poly } from './geometry';
import { josa } from './josa';
import { FRONT_ACCESS_DEPTH, fixtureHeightStatus, frontAccessPoly, nearestPowerDistance, validPowerPoints } from './placementRules';
import { checkSpaceData, hasValidItemGeometry, indexItems, spaceObstacles, type ItemIndex, type Obstacle } from './validate';
import { CATEGORY_LABEL, type Category, type CatalogItem, type LayoutData, type Placement, type PowerPoint, type Space } from './types';

export interface CompositionEntry {
  category: Category;
  sku: string;
  name: string;
  qty: number;
  initialQty: number;
  floor: number;
  required: boolean;
  priority: number;
  unit: number | null;
}

export interface CompositionResult {
  feasible: boolean;
  entries: CompositionEntry[];
  /** 예산에 넣은 금액(확인·추정 단가 × 수량 + 금액이 있는 부대비용) */
  plannedCost: number;
  adjustments: string[];
  reasons: string[];
  suggestions: string[];
  notes: string[];
}

export interface PlanResult {
  ok: boolean;
  placements: Placement[];
  composition: CompositionResult;
  unplaced: { sku: string; name: string; count: number; total: number }[];
  reasons: string[];
  suggestions: string[];
  notes: string[];
  summary: string;
}

let idSeq = 0;
export function newPlacementId(): string {
  idSeq += 1;
  return `p${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export interface PlanOptions {
  /** 사용자가 고른 수량 유지. 예산 초과는 안내하고 자동으로 수량을 줄이지 않는다. */
  preserveQuantities?: boolean;
  /** 직접 옮긴 좌표·ID를 우선 보존하며 막힌 자리만 가까운 후보로 정리한다. */
  preferCurrent?: boolean;
}

export interface PlacementOptions {
  powerSkus?: ReadonlySet<string>;
  preferred?: readonly Placement[];
}

export function chooseComposition(data: LayoutData, options: PlanOptions = {}): CompositionResult {
  const items = indexItems(data.vendor.items);
  const reasons: string[] = checkSpaceData(data.space);
  const suggestions: string[] = [];
  const notes: string[] = [];
  const adjustments: string[] = [];
  const entries: CompositionEntry[] = [];

  for (const r of data.requirements) {
    const it = items.get(r.sku);
    if (!it) {
      if (r.required) reasons.push(`필수 집기 ${CATEGORY_LABEL[r.category]}의 규격 ${r.sku}가 카탈로그에 없습니다.`);
      continue;
    }
    if (![r.minQty, r.desiredQty].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      reasons.push(`${it.name}의 최소·희망 수량은 0 이상의 정수여야 합니다.`);
      continue;
    }
    const floor = r.required ? Math.max(1, r.minQty) : Math.max(0, r.minQty);
    const qty = Math.max(floor, r.desiredQty);
    if (qty === 0) continue;
    if (!hasValidItemGeometry(it)) {
      reasons.push(`${it.name}(${it.sku})의 치수는 0보다 큰 유효한 숫자여야 합니다.`);
      continue;
    }
    if (fixtureHeightStatus(data.space, it).blocked) {
      reasons.push(`${it.name}(${it.sku}) 높이가 공간 높이 이상이라 반입할 수 없습니다.`);
      continue;
    }
    const u = unitPrice(it, data.event.rentalDays);
    if (u.unit == null) notes.push(`${it.name}(${it.sku}) 단가가 미확인이라 예산 판단에서 빠졌습니다.`);
    entries.push({
      category: r.category,
      sku: r.sku,
      name: it.name,
      qty,
      initialQty: qty,
      floor,
      required: r.required,
      priority: r.priority,
      unit: u.unit,
    });
  }

  const feeKnown = data.fees.reduce((s, f) => s + (f.amount != null && f.status !== 'unknown' ? f.amount : 0), 0);
  for (const f of data.fees) {
    if (f.amount == null || f.status === 'unknown') notes.push(`${f.label} 금액이 미확인이라 예산 판단에서 빠졌습니다.`);
  }
  const costOf = (list: CompositionEntry[], useFloor = false) =>
    feeKnown + list.reduce((s, e) => s + (e.unit ?? 0) * (useFloor ? e.floor : e.qty), 0);

  let plannedCost = costOf(entries);
  const budget = data.budget;

  if (options.preserveQuantities && budget.amount != null && budget.scope === 'fixtures') {
    if (plannedCost > budget.amount) notes.push(`선택한 수량을 유지했습니다. 확인된 비용이 집기 예산보다 ${won(plannedCost - budget.amount)} 많습니다.`);
  } else if (budget.amount != null && budget.scope === 'fixtures') {
    while (plannedCost > budget.amount) {
      const cands = entries
        .filter((e) => e.qty > e.floor && e.unit != null && e.unit > 0)
        .sort((a, b) => b.priority - a.priority || (b.unit ?? 0) - (a.unit ?? 0));
      if (cands.length === 0) break;
      cands[0].qty -= 1;
      plannedCost -= cands[0].unit ?? 0;
    }
    for (const e of entries) {
      if (e.qty !== e.initialQty) adjustments.push(`${e.name} ${e.initialQty}개 → ${e.qty}개`);
    }
    if (plannedCost > budget.amount) {
      const minCost = costOf(entries, true);
      reasons.push(
        `필수·최소 구성만으로 ${won(minCost)}이 필요해 집기 예산 ${won(budget.amount)}보다 ${won(minCost - budget.amount)} 많습니다.`,
      );
      suggestions.push(`집기 예산을 ${won(minCost)} 이상으로 조정`);
      for (const e of entries) {
        if (e.floor === 0 || e.unit == null) continue;
        const cheaper = data.vendor.items
          .filter((i) => i.category === e.category && i.sku !== e.sku)
          .map((i) => ({ i, u: unitPrice(i, data.event.rentalDays) }))
          .filter((x) => x.u.unit != null && x.u.unit < e.unit!)
          .sort((a, b) => a.u.unit! - b.u.unit!)[0];
        if (cheaper) {
          suggestions.push(
            `${josa(e.name, '을/를')} ${josa(`${cheaper.i.name}(${cheaper.i.sku})`, '으로/로')} 바꾸면 개당 ${won(e.unit - cheaper.u.unit!)} 절감`,
          );
        }
        if (e.floor > 1) suggestions.push(`${e.name} 최소 수량 ${e.floor}개를 줄일 수 있는지 검토`);
        else if (e.required) suggestions.push(`${e.name}의 필수 여부 재검토`);
      }
      return { feasible: false, entries, plannedCost, adjustments, reasons, suggestions, notes };
    }
  } else if (budget.amount != null && budget.scope === 'event_total') {
    notes.push('예산이 전체 행사비 기준이라 집기 수량을 예산에 맞춰 자동 조정하지 않았습니다.');
  } else {
    notes.push('집기 예산이 입력되지 않아 희망 수량 그대로 구성했습니다.');
  }

  return { feasible: reasons.length === 0, entries, plannedCost, adjustments, reasons, suggestions, notes };
}

// ---------------------------------------------------------------------------
// 자동 배치
// ---------------------------------------------------------------------------

const ORDER: Category[] = ['photozone', 'counter', 'shelf', 'hanger', 'mirror', 'display', 'table', 'light', 'other'];
const WALL_FIRST = new Set<Category>(['photozone', 'counter', 'shelf', 'hanger', 'mirror', 'other']);
const FLUSH_GAP = 0.02;
const WALL_STEP = 0.05;
const GRID_STEP = 0.1;
const MAX_INTERIOR_CANDIDATES = 20000;
const MAX_WALL_CANDIDATES = 2000;

/** Large rooms use wider spacing; each item still has a strict candidate budget. */
export function plannerSearchSettings(space: Pick<Space, 'width' | 'depth'>) {
  const valid = [space.width, space.depth].every((value) => Number.isFinite(value) && value > 0);
  const width = valid ? space.width : 0;
  const depth = valid ? space.depth : 0;
  // Divide before multiplying so huge imported dimensions do not overflow the area.
  const interiorStep = Math.max(GRID_STEP, Math.sqrt(width / MAX_INTERIOR_CANDIDATES * depth * 4));
  const wallStep = Math.max(WALL_STEP, (width / (MAX_WALL_CANDIDATES - 8) + depth / (MAX_WALL_CANDIDATES - 8)) * 2);
  return {
    interiorStep, wallStep,
    maxInteriorCandidates: MAX_INTERIOR_CANDIDATES,
    maxWallCandidates: MAX_WALL_CANDIDATES,
  };
}

interface Candidate {
  x: number;
  y: number;
  rot: number;
  wall: boolean;
}

function wallCandidates(space: Space, it: CatalogItem): Candidate[] {
  const { width: W, depth: D } = space;
  const out: Candidate[] = [];
  const { wallStep, maxWallCandidates } = plannerSearchSettings(space);
  const slide = (len: number, size: number, f: (t: number) => Candidate) => {
    if (size > len + 1e-9) return;
    const n = Math.floor((len - size) / wallStep);
    for (let i = 0; i <= n && out.length < maxWallCandidates; i++) out.push(f(size / 2 + i * wallStep));
    if (out.length < maxWallCandidates) out.push(f(len - size / 2));
  };
  slide(W, it.w, (t) => ({ x: t, y: it.d / 2, rot: 0, wall: true }));
  slide(W, it.w, (t) => ({ x: t, y: D - it.d / 2, rot: 180, wall: true }));
  slide(D, it.w, (t) => ({ x: it.d / 2, y: t, rot: 270, wall: true }));
  slide(D, it.w, (t) => ({ x: W - it.d / 2, y: t, rot: 90, wall: true }));
  return out;
}

function interiorCandidates(space: Space): Candidate[] {
  const out: Candidate[] = [];
  const { interiorStep, maxInteriorCandidates } = plannerSearchSettings(space);
  for (let x = interiorStep; x < space.width; x += interiorStep) {
    for (let y = interiorStep; y < space.depth; y += interiorStep) {
      if (out.length + 4 > maxInteriorCandidates) return out;
      for (const rot of [0, 90, 180, 270]) out.push({ x, y, rot, wall: false });
    }
  }
  return out;
}

interface Region {
  poly: Poly;
  box: ReturnType<typeof bounds>;
  axisAligned: boolean;
}

interface PreparedCandidate extends Candidate {
  body: Region;
  access: Region | null;
  powerDistance: number;
}

interface PlacedPoly {
  category: Category;
  body: Region;
  access: Region | null;
}

function region(poly: Poly, rotation = 0): Region {
  return { poly, box: bounds(poly), axisAligned: Math.abs(rotation % 90) < 1e-7 };
}

function overlaps(a: Region, b: Region): boolean {
  if (Math.min(a.box.maxX, b.box.maxX) - Math.max(a.box.minX, b.box.minX) <= 1e-4 ||
      Math.min(a.box.maxY, b.box.maxY) - Math.max(a.box.minY, b.box.minY) <= 1e-4) return false;
  return a.axisAligned && b.axisAligned || polysOverlap(a.poly, b.poly);
}

function distance(a: Region, b: Region): number {
  if (a.axisAligned && b.axisAligned) {
    return Math.hypot(Math.max(0, a.box.minX - b.box.maxX, b.box.minX - a.box.maxX),
      Math.max(0, a.box.minY - b.box.maxY, b.box.minY - a.box.maxY));
  }
  return polyDistance(a.poly, b.poly);
}

function prepare(c: Candidate, it: CatalogItem, points: readonly PowerPoint[], accessDepth = FRONT_ACCESS_DEPTH): PreparedCandidate {
  const access = frontAccessPoly(c, it, accessDepth);
  return {
    ...c, body: region(footprint(c.x, c.y, it.w, it.d, c.rot), c.rot),
    access: access ? region(access, c.rot) : null,
    powerDistance: points.length ? nearestPowerDistance(c, points) : 0,
  };
}

function fitsStatic(space: Space, c: PreparedCandidate, obstacles: { kind: Obstacle['kind']; body: Region }[]): boolean {
  if (!polyInside(c.body.poly, space.width, space.depth) || c.access && !polyInside(c.access.poly, space.width, space.depth)) return false;
  return obstacles.every((o) => !overlaps(c.body, o.body) &&
    // 출입구 여유와 사람이 서는 정면 여유는 함께 쓸 수 있다.
    (!c.access || o.kind === 'door' || !overlaps(c.access, o.body)));
}

function fitsPlaced(space: Space, c: PreparedCandidate, placed: PlacedPoly[]): boolean {
  for (const p of placed) {
    if (overlaps(c.body, p.body) || c.access && overlaps(c.access, p.body) || p.access && overlaps(c.body, p.access)) return false;
    if (space.rules.minAisle != null) {
      const gap = distance(c.body, p.body);
      if (gap > FLUSH_GAP && gap < space.rules.minAisle - 1e-6) return false;
    }
  }
  return true;
}

function score(space: Space, it: CatalogItem, c: PreparedCandidate, placed: PlacedPoly[], relaxed = false): number {
  const door = space.doors[0] ? doorCenter(space, space.doors[0]) : { x: space.width / 2, y: space.depth };
  const maxD = Math.hypot(space.width, space.depth);
  const toDoor = Math.hypot(c.x - door.x, c.y - door.y) / maxD;
  const nearest = (cats: Category[]) => {
    let best = Infinity;
    for (const p of placed) if (cats.includes(p.category)) best = Math.min(best, distance(c.body, p.body));
    return best;
  };
  let s = 0;
  if (WALL_FIRST.has(it.category) && !c.wall) s += 3;
  if (!WALL_FIRST.has(it.category) && c.wall) s += 5;

  switch (it.category) {
    case 'photozone': {
      // 출입구 맞은편 벽 가운데(들어오자마자 정면으로 보이는 자리)
      const focal = { x: space.width - door.x, y: space.depth - door.y };
      s += (Math.hypot(c.x - focal.x, c.y - focal.y) / maxD) * 10;
      break;
    }
    case 'counter':
      s += toDoor * 10;
      break;
    case 'hanger':
    case 'shelf': {
      if (relaxed) break;
      const n = nearest([it.category]);
      s += n === Infinity ? Math.abs(toDoor - 0.45) * 10 : n * 3;
      break;
    }
    case 'mirror': {
      if (relaxed) break;
      const n = nearest(['hanger', 'shelf']);
      s += n === Infinity ? Math.abs(toDoor - 0.5) * 10 : n;
      break;
    }
    case 'table':
    case 'display': {
      const cx = space.width / 2;
      const cy = space.depth / 2;
      s += (Math.hypot(c.x - cx, c.y - cy) / maxD) * 10 + Math.abs(toDoor - 0.35) * 5;
      break;
    }
    case 'light': {
      if (relaxed) break;
      const n = nearest(['photozone']);
      s += n === Infinity ? 0 : n;
      break;
    }
    default:
      s += toDoor * 2;
  }
  return s;
}

/** Distance from the fixture's back edge to the room wall behind it. */
function rearWallGap(space: Space, item: CatalogItem, c: Candidate): number {
  const radians = c.rot * Math.PI / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const x = c.x + dx * item.d / 2;
  const y = c.y + dy * item.d / 2;
  const horizontal = dx > 1e-7 ? (space.width - x) / dx : dx < -1e-7 ? -x / dx : Infinity;
  const vertical = dy > 1e-7 ? (space.depth - y) / dy : dy < -1e-7 ? -y / dy : Infinity;
  return Math.max(0, Math.min(horizontal, vertical));
}

function designCost(space: Space, item: CatalogItem, c: PreparedCandidate, placed: PlacedPoly[], relaxed = false): number {
  // A backdrop/rack's unused rear strip costs floor area. Power remains a
  // preference, but placing its centre exactly on a socket is not the goal.
  const rearWeight = ['photozone', 'hanger', 'shelf', 'mirror'].includes(item.category) ? 12 : 1;
  const deadSpace = WALL_FIRST.has(item.category) ? rearWallGap(space, item, c) * item.w * rearWeight : 0;
  const raw = score(space, item, c, placed, relaxed) + c.powerDistance * 6 + deadSpace;
  // Each placed unit costs < 1, so skipping a unit can strictly dominate the
  // sum of every design improvement in a complete layout.
  return raw / (1 + raw);
}

export function placeUnits(
  space: Space,
  items: ItemIndex,
  skus: string[],
  existing: Placement[] = [],
  options: PlacementOptions = {},
): { placements: Placement[]; unplaced: Map<string, number> } {
  const unplaced = new Map<string, number>();
  if (checkSpaceData(space).length) {
    for (const sku of skus) unplaced.set(sku, (unplaced.get(sku) ?? 0) + 1);
    return { placements: [], unplaced };
  }
  const obstacles = spaceObstacles(space).map((obstacle) => ({ kind: obstacle.kind, body: region(obstacle.poly) }));
  const accessDepth = Math.max(FRONT_ACCESS_DEPTH, space.rules.minAisle ?? 0);
  const powerPoints = validPowerPoints(space);
  const fixed: PlacedPoly[] = [];
  for (const p of existing) {
    const it = items.get(p.sku);
    if (!it || !hasValidItemGeometry(it) || ![p.x, p.y, p.rot].every(Number.isFinite)) continue;
    const prepared = prepare({ ...p, wall: false }, it, [], accessDepth);
    fixed.push({ category: it.category, body: prepared.body, access: prepared.access });
  }
  // Geometry and static obstructions are calculated once per SKU and shared by
  // every retry. Cardinal rotations use exact rectangle checks in the hot loop.
  const pools = new Map<string, PreparedCandidate[]>();
  const allInterior = interiorCandidates(space);
  const interiorLimit = Math.max(1000, Math.floor(60000 / Math.max(1, new Set(skus).size)));
  const interior = allInterior.length <= interiorLimit ? allInterior :
    Array.from({ length: Math.floor(interiorLimit / 4) }, (_, index) => {
      const first = Math.floor(index * (allInterior.length / 4) / Math.floor(interiorLimit / 4)) * 4;
      return allInterior.slice(first, first + 4);
    }).flat();
  const preferredBySku = new Map<string, Placement[]>();
  for (const p of options.preferred ?? []) {
    const queue = preferredBySku.get(p.sku) ?? [];
    queue.push(p);
    preferredBySku.set(p.sku, queue);
  }
  const units = skus.flatMap((sku, index) => {
    const item = items.get(sku);
    if (!item) { unplaced.set(sku, (unplaced.get(sku) ?? 0) + 1); return []; }
    if (!pools.has(sku)) {
      const points = options.powerSkus?.has(sku) ? powerPoints : [];
      const candidates: Candidate[] = [
        ...(preferredBySku.get(sku) ?? []).filter((p) => [p.x, p.y, p.rot].every(Number.isFinite)).map((p) => ({ ...p, wall: false })),
        ...points.flatMap((point) => [0, 90, 180, 270].map((rot) => ({ x: point.x, y: point.y, rot, wall: false }))),
        ...wallCandidates(space, item), ...interior,
      ];
      const valid = hasValidItemGeometry(item) && !fixtureHeightStatus(space, item).blocked;
      pools.set(sku, valid ? candidates.map((c) => prepare(c, item, points, accessDepth)).filter((c) => fitsStatic(space, c, obstacles)) : []);
    }
    const preferred = preferredBySku.get(sku)?.shift();
    return [{ item, preferred, index }];
  });
  type Unit = typeof units[number];
  const poweredFirst = (a: Unit, b: Unit) => Number(options.powerSkus?.has(b.item.sku) ?? false) - Number(options.powerSkus?.has(a.item.sku) ?? false);
  const defaultOrder = (a: Unit, b: Unit) => poweredFirst(a, b) || ORDER.indexOf(a.item.category) - ORDER.indexOf(b.item.category) ||
    b.item.w * b.item.d - a.item.w * a.item.d || a.index - b.index;
  const area = (u: Unit) => u.item.w * (u.item.d + (frontAccessPoly({ x: 0, y: 0, rot: 0 }, u.item, accessDepth) ? accessDepth : 0));
  const ordered = [...units].sort((a, b) => (pools.get(a.item.sku)!.length - pools.get(b.item.sku)!.length) ||
    area(b) - area(a) || defaultOrder(a, b));
  const normalizer = Math.max(1, Math.hypot(space.width, space.depth));
  const moveWeight = options.preferred?.length ? Math.max(1, units.length) * 1000 : 0;
  const skipCost = (units.length + 1) * (moveWeight + 1);
  const movementCost = (unit: Unit, candidate: Candidate) => {
    if (!unit.preferred) return 0;
    const rotation = Math.abs(candidate.rot - unit.preferred.rot) % 360;
    const moved = Math.hypot(candidate.x - unit.preferred.x, candidate.y - unit.preferred.y) + Math.min(rotation, 360 - rotation) / 180 * 0.1;
    return Math.min(1, moved / (normalizer + 0.1)) * moveWeight;
  };
  type Ranked = { candidate: PreparedCandidate; lowerCost: number };
  const rankingCache = new Map<string, Ranked[][]>();
  const rankings = ordered.map((unit) => {
    const key = `${unit.item.sku}:${unit.preferred?.id ?? ''}`;
    const cached = rankingCache.get(key);
    if (cached) return cached;
    // Keep spatially different alternatives so A* can undo a cheap first
    // placement that would consume the only usable slot for another fixture.
    const groups = new Map<string, Ranked[]>();
    for (const candidate of pools.get(unit.item.sku)!) {
      const group = `${Math.min(2, Math.floor(candidate.x / space.width * 3))}:${Math.min(2, Math.floor(candidate.y / space.depth * 3))}:${candidate.rot}`;
      const bucket = groups.get(group) ?? [];
      bucket.push({ candidate, lowerCost: movementCost(unit, candidate) + designCost(space, unit.item, candidate, [], true) });
      groups.set(group, bucket);
    }
    const buckets = [...groups.values()].map((bucket) => bucket.sort((a, b) => a.lowerCost - b.lowerCost));
    buckets.sort((a, b) => a[0].lowerCost - b[0].lowerCost);
    rankingCache.set(key, buckets);
    return buckets;
  });
  // Admissible lower bound: minimum remaining per-unit costs with other
  // movable fixtures removed. No-candidate units already incur a skipped unit.
  const remainingLowerBound = new Array<number>(ordered.length + 1).fill(0);
  for (let i = ordered.length - 1; i >= 0; i--) {
    remainingLowerBound[i] = remainingLowerBound[i + 1] + (rankings[i][0]?.[0].lowerCost ?? skipCost);
  }
  interface SearchState {
    next: number;
    placements: Placement[];
    placed: PlacedPoly[];
    missing: Map<string, number>;
  }
  let remainingCandidateChecks = 2_000_000;
  const choices = (state: SearchState, count: number): { candidate: PreparedCandidate; cost: number }[] => {
    const unit = ordered[state.next];
    const candidates: { candidate: PreparedCandidate; cost: number }[] = [];
    for (const bucket of rankings[state.next]) {
      let accepted = 0;
      for (const ranked of bucket) {
        if (remainingCandidateChecks-- <= 0) break;
        if (!fitsPlaced(space, ranked.candidate, state.placed)) continue;
        candidates.push({ candidate: ranked.candidate, cost: movementCost(unit, ranked.candidate) + designCost(space, unit.item, ranked.candidate, state.placed) });
        // For each coarse region/rotation retain the best relaxed candidate
        // and one nearby alternative; the full pools remain available when
        // earlier coordinates are obstructed by a different partial layout.
        if (++accepted >= (count === 1 ? 1 : 2)) break;
      }
      if (remainingCandidateChecks <= 0) break;
    }
    candidates.sort((a, b) => a.cost - b.cost);
    if (count === 1) return candidates.slice(0, 1);
    const selected = candidates.slice(0, Math.floor(count / 2));
    for (const choice of candidates) {
      if (selected.length >= count) break;
      if (selected.includes(choice)) continue;
      if (selected.some((other) => other.candidate.rot === choice.candidate.rot &&
        Math.hypot(other.candidate.x - choice.candidate.x, other.candidate.y - choice.candidate.y) < 0.35)) continue;
      selected.push(choice);
    }
    return selected;
  };
  const advance = (state: SearchState, candidate?: PreparedCandidate): SearchState => {
    const unit = ordered[state.next];
    if (!candidate) {
      const missing = new Map(state.missing);
      missing.set(unit.item.sku, (missing.get(unit.item.sku) ?? 0) + 1);
      return { ...state, next: state.next + 1, missing };
    }
    const p: Placement = {
      id: unit.preferred?.id ?? `search-${unit.index}`, sku: unit.item.sku,
      x: round(candidate.x, 0.0001), y: round(candidate.y, 0.0001), rot: candidate.rot,
      noOrder: unit.preferred?.noOrder ?? false,
    };
    return {
      next: state.next + 1, missing: state.missing, placements: [...state.placements, p],
      placed: [...state.placed, { category: unit.item.category, body: candidate.body, access: candidate.access }],
    };
  };
  const start: SearchState = { next: 0, placements: [], placed: fixed, missing: unplaced };
  // One inexpensive feasible incumbent guarantees a complete result even if
  // search budgets expire. Unlike the former retry passes, A* retains and
  // revisits competing partial layouts instead of committing to each choice.
  let incumbent = start;
  let incumbentCost = 0;
  while (incumbent.next < ordered.length) {
    const choice = choices(incumbent, 1)[0];
    incumbent = advance(incumbent, choice?.candidate);
    incumbentCost += choice?.cost ?? skipCost;
  }
  const unchanged = options.preferred?.length === skus.length && incumbent.missing.size === 0 &&
    incumbent.placements.every((p) => options.preferred!.some((old) => old.id === p.id && old.x === p.x && old.y === p.y && old.rot === p.rot));
  const best = unchanged ? incumbent : boundedAStar({
    start,
    heuristic: (state) => remainingLowerBound[state.next],
    isGoal: (state) => state.next === ordered.length,
    expand: function* (state) {
      for (const choice of choices(state, units.length > 30 ? 12 : 24)) {
        yield { state: advance(state, choice.candidate), cost: choice.cost };
      }
      yield { state: advance(state), cost: skipCost };
    },
    maxExpansions: units.length > 60 ? 96 : units.length > 30 ? 192 : 640,
    maxFrontier: 768,
    incumbent: { state: incumbent, cost: incumbentCost },
    shouldStop: () => remainingCandidateChecks <= 0,
  }).solution!.state;
  const preferredIds = new Set(options.preferred?.map((p) => p.id));
  // Preserve the caller's unit order, including manual/reference identity.
  const orderOf = new Map(ordered.map((unit) => [unit.preferred?.id ?? `search-${unit.index}`, unit.index]));
  best.placements.sort((a, b) => orderOf.get(a.id)! - orderOf.get(b.id)!);
  return { placements: best.placements.map((p) => ({ ...p, id: preferredIds.has(p.id) ? p.id : newPlacementId() })), unplaced: best.missing };
}

/** 이미 놓인 집기를 피해서 새 집기 하나를 놓을 자리. 없으면 null */
export function findSpot(space: Space, items: ItemIndex, existing: Placement[], sku: string, options: PlacementOptions = {}): Placement | null {
  const { placements } = placeUnits(space, items, [sku], existing, options);
  return placements[0] ?? null;
}

export function proposePlan(data: LayoutData, options: PlanOptions = {}): PlanResult {
  const composition = chooseComposition(data, options);
  const search = plannerSearchSettings(data.space);
  if (search.interiorStep > GRID_STEP || search.wallStep > WALL_STEP) composition.notes.push('큰 공간은 후보 간격을 넓혀 빠르게 탐색합니다. 배치 후 세부 위치를 직접 조정할 수 있습니다.');
  composition.notes.push('A*로 여러 중간 배치안을 비교합니다. 수량 누락을 먼저 줄이고, 뒤쪽 빈 공간과 사용 여유를 함께 고려합니다. 후보 수와 탐색량을 제한하므로 전체 공간의 최적해를 보장하지는 않습니다.');
  const base = { composition, notes: composition.notes };
  if (!composition.feasible) {
    return {
      ...base,
      ok: false,
      placements: [],
      unplaced: [],
      reasons: composition.reasons,
      suggestions: composition.suggestions,
      summary: '조건을 모두 만족하는 구성을 찾지 못했습니다.',
    };
  }

  const items = indexItems(data.vendor.items);
  const references = options.preferCurrent ? data.placements.filter((p) => p.noOrder) : [];
  const skus = [...composition.entries.flatMap((e) => Array.from({ length: e.qty }, () => e.sku)), ...references.map((p) => p.sku)];
  const powerSkus = new Set(data.requirements.filter((r) => r.needsPower && skus.includes(r.sku)).map((r) => r.sku));
  if (powerSkus.size) {
    composition.notes.push(validPowerPoints(data.space).length
      ? '전원이 필요한 품목은 전원 거리와 뒤쪽 빈 공간을 함께 줄이는 자리를 비교했습니다. 거리는 집기 중심 기준이며 배선 경로·전기 용량은 계산하지 않습니다.'
      : '전원이 필요한 품목이 있지만 등록된 전원점이 없습니다. 공간에 전원점을 추가한 뒤 다시 배치해 주세요. 현재 배치에는 전원 거리가 반영되지 않았습니다.');
  }
  if (composition.entries.some((entry) => frontAccessPoly({ x: 0, y: 0, rot: 0 }, items.get(entry.sku)!) != null)) {
    composition.notes.push(`행거·선반·카운터·거울·포토존 정면에 ${Math.max(FRONT_ACCESS_DEPTH, data.space.rules.minAisle ?? 0)}m의 사용 여유를 확보하는 조건으로 배치합니다. 선택한 최소 통로 너비와 앱 기본 여유를 반영하며 법정 통로 기준은 아닙니다.`);
  }
  const currentQuota = new Map<string, number>();
  for (const entry of composition.entries) currentQuota.set(entry.sku, (currentQuota.get(entry.sku) ?? 0) + entry.qty);
  const currentOrdered = options.preferCurrent ? data.placements.filter((placement) => {
    const remaining = currentQuota.get(placement.sku) ?? 0;
    if (placement.noOrder || remaining <= 0) return false;
    currentQuota.set(placement.sku, remaining - 1);
    return true;
  }) : [];
  const { placements, unplaced } = placeUnits(data.space, items, skus, [], {
    powerSkus,
    preferred: options.preferCurrent ? [...currentOrdered, ...references] : undefined,
  });

  const unplacedList = [...unplaced].map(([sku, count]) => {
    const e = composition.entries.find((x) => x.sku === sku);
    return { sku, name: e?.name ?? items.get(sku)?.name ?? sku, count, total: skus.filter((value) => value === sku).length };
  });
  const reasons: string[] = [];
  const suggestions: string[] = [];
  for (const u of unplacedList) {
    const e = composition.entries.find((x) => x.sku === u.sku);
    const placedN = u.total - u.count;
    reasons.push(`${u.name} ${u.total}개 중 ${u.count}개의 자리를 제한된 후보 탐색에서 찾지 못했습니다.`);
    if (e && (!e.required || placedN >= e.floor)) suggestions.push(`${u.name} 수량을 ${placedN}개로 줄이기`);
    const it = items.get(u.sku);
    if (!it) continue;
    const smaller = data.vendor.items
      .filter((i) => i.category === it.category && i.sku !== it.sku && i.w * i.d < it.w * it.d)
      .sort((a, b) => a.w * a.d - b.w * b.d)[0];
    if (smaller) suggestions.push(`${josa(it.name, '을/를')} 더 작은 규격 ${smaller.name}(${smaller.sku}, ${smaller.w}×${smaller.d}m)으로 바꾸기`);
  }
  if (unplacedList.length) suggestions.push('기둥·금지 구역·출입구와 정면 사용 여유를 확보할 수 있도록 수량이나 집기 규격을 조정');

  // 공간 부족으로 필수 수량을 못 채우면 실패
  const requiredShort = composition.entries.some((e) => {
    const miss = unplaced.get(e.sku) ?? 0;
    return e.required && e.qty - miss < e.floor;
  });
  const ok = unplacedList.length === 0;

  const parts = composition.entries.map((e) => `${e.name} ${e.qty}개`).join(', ');
  const summary = ok
    ? `${parts} 배치안을 만들었습니다.${composition.adjustments.length ? ` 예산에 맞춰 ${composition.adjustments.join(', ')}로 조정했습니다.` : ''}`
    : requiredShort
      ? '선택한 필수 수량을 모두 만족하는 배치안을 아직 찾지 못했습니다.'
      : '선택한 수량을 모두 만족하는 배치안을 아직 찾지 못했습니다.';

  return { ...base, ok, placements: ok ? placements : [], unplaced: unplacedList, reasons, suggestions, summary };
}

/** 선택한 수량과 참고 집기를 유지하고, 현재 위치에서 이동량이 적은 유효 배치를 찾는다. */
export function optimizeLayout(data: LayoutData): PlanResult {
  return proposePlan(data, { preserveQuantities: true, preferCurrent: true });
}
