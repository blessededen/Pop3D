import { unitPrice, won } from './cost';
import { bounds, doorCenter, footprint, polyDistance, polyInside, polysOverlap, round, type Poly } from './geometry';
import { josa } from './josa';
import { FRONT_ACCESS_DEPTH, frontAccessPoly, nearestPowerDistance, validPowerPoints } from './placementRules';
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
    if (it.h > Math.min(data.space.height, data.space.rules.maxItemHeight ?? Infinity) + 1e-6) {
      reasons.push(`${it.name}(${it.sku}) 높이가 공간의 설치 허용 높이를 넘습니다.`);
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

function prepare(c: Candidate, it: CatalogItem, points: readonly PowerPoint[]): PreparedCandidate {
  const access = frontAccessPoly(c, it);
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

function score(space: Space, it: CatalogItem, c: PreparedCandidate, placed: PlacedPoly[]): number {
  const door = space.doors[0] ? doorCenter(space, space.doors[0]) : { x: space.width / 2, y: space.depth };
  const maxD = Math.hypot(space.width, space.depth);
  const toDoor = Math.hypot(c.x - door.x, c.y - door.y) / maxD;
  const nearest = (cats: Category[]) => {
    let best = Infinity;
    for (const p of placed) if (cats.includes(p.category)) best = Math.min(best, distance(c.body, p.body));
    return best;
  };
  let s = 0;
  if (WALL_FIRST.has(it.category) && !c.wall) s += 20;
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
      const n = nearest([it.category]);
      s += n === Infinity ? Math.abs(toDoor - 0.45) * 10 : n * 3;
      break;
    }
    case 'mirror': {
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
      const n = nearest(['photozone']);
      s += n === Infinity ? 0 : n;
      break;
    }
    default:
      s += toDoor * 2;
  }
  return s;
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
  const powerPoints = validPowerPoints(space);
  const fixed: PlacedPoly[] = [];
  for (const p of existing) {
    const it = items.get(p.sku);
    if (!it || !hasValidItemGeometry(it) || ![p.x, p.y, p.rot].every(Number.isFinite)) continue;
    const prepared = prepare({ ...p, wall: false }, it, []);
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
      const valid = hasValidItemGeometry(item) && item.h <= Math.min(space.height, space.rules.maxItemHeight ?? Infinity) + 1e-6;
      pools.set(sku, valid ? candidates.map((c) => prepare(c, item, points)).filter((c) => fitsStatic(space, c, obstacles)) : []);
    }
    const preferred = preferredBySku.get(sku)?.shift();
    return [{ item, preferred, index }];
  });
  type Unit = typeof units[number];
  const poweredFirst = (a: Unit, b: Unit) => Number(options.powerSkus?.has(b.item.sku) ?? false) - Number(options.powerSkus?.has(a.item.sku) ?? false);
  const defaultOrder = (a: Unit, b: Unit) => poweredFirst(a, b) || ORDER.indexOf(a.item.category) - ORDER.indexOf(b.item.category) ||
    b.item.w * b.item.d - a.item.w * a.item.d || a.index - b.index;
  const area = (u: Unit) => u.item.w * (u.item.d + (frontAccessPoly({ x: 0, y: 0, rot: 0 }, u.item) ? FRONT_ACCESS_DEPTH : 0));
  const orders = [
    [...units].sort(defaultOrder),
    [...units].sort((a, b) => (pools.get(a.item.sku)!.length - pools.get(b.item.sku)!.length) || area(b) - area(a) || defaultOrder(a, b)),
    [...units].sort((a, b) => area(b) - area(a) || defaultOrder(a, b)),
    [...units].sort((a, b) => poweredFirst(a, b) || Math.max(b.item.w, b.item.d) - Math.max(a.item.w, a.item.d) || defaultOrder(a, b)),
    [...units].sort(defaultOrder).reverse(),
    [...units].sort((a, b) => area(b) - area(a) || defaultOrder(a, b)),
  ];
  // Bound complete passes as well as per-item candidates. Large selections do
  // fewer passes; a worker caller can keep the UI responsive during the search.
  const maxPasses = units.length > 60 ? 3 : units.length > 30 ? 4 : 6;
  let best: { placements: Placement[]; unplaced: Map<string, number>; quality: number[] } | undefined;
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return a[i] < b[i];
    return false;
  };
  const normalizer = Math.max(1, Math.hypot(space.width, space.depth));
  let remainingCandidateChecks = 4_000_000;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (remainingCandidateChecks <= 0) break;
    const placed = [...fixed];
    const out: Placement[] = [];
    const missing = new Map(unplaced);
    let movement = 0;
    let powerDistance = 0;
    let designScore = 0;
    for (const [position, unit] of orders[pass].entries()) {
      const { item, preferred } = unit;
      if (remainingCandidateChecks <= 0) {
        for (const rest of orders[pass].slice(position)) missing.set(rest.item.sku, (missing.get(rest.item.sku) ?? 0) + 1);
        break;
      }
      if (missing.has(item.sku)) { missing.set(item.sku, missing.get(item.sku)! + 1); continue; }
      let choice: PreparedCandidate | undefined;
      let choiceQuality = [Infinity, Infinity, Infinity];
      let choiceMovement = 0;
      let choiceDesign = 0;
      for (const candidate of pools.get(item.sku)!) {
        if (remainingCandidateChecks-- <= 0) break;
        // A current manual coordinate may have a non-cardinal rotation. It is
        // still checked by the polygon path and never rounded to a right angle.
        const move = preferred ? Math.hypot(candidate.x - preferred.x, candidate.y - preferred.y) +
          Math.min(Math.abs(candidate.rot - preferred.rot) % 360, 360 - Math.abs(candidate.rot - preferred.rot) % 360) / 180 * 0.1 : 0;
        const quickQuality = [move, candidate.powerDistance];
        if (quickQuality[0] > choiceQuality[0] + 1e-6 ||
            Math.abs(quickQuality[0] - choiceQuality[0]) <= 1e-6 && quickQuality[1] > choiceQuality[1] + 1e-6) continue;
        if (!fitsPlaced(space, candidate, placed)) continue;
        const design = score(space, item, candidate, placed);
        // Extra passes try opposite packing directions, not only a different
        // item order. This escapes a first placement consuming a unique slot.
        const bias = pass === 4 ? (candidate.x + candidate.y) / normalizer * 12 :
          pass === 5 ? (space.width - candidate.x + space.depth - candidate.y) / normalizer * 12 : 0;
        const quality = [move, candidate.powerDistance, design + bias];
        if (better(quality, choiceQuality)) {
          choice = candidate; choiceQuality = quality; choiceMovement = move; choiceDesign = design;
        }
      }
      if (!choice) { missing.set(item.sku, (missing.get(item.sku) ?? 0) + 1); continue; }
      out.push({ id: preferred?.id ?? `search-${unit.index}`, sku: item.sku, x: round(choice.x, 0.0001), y: round(choice.y, 0.0001), rot: choice.rot, noOrder: preferred?.noOrder ?? false });
      placed.push({ category: item.category, body: choice.body, access: choice.access });
      movement += choiceMovement; powerDistance += choice.powerDistance; designScore += choiceDesign;
    }
    const quality = [skus.length - out.length, movement, powerDistance, designScore];
    if (!best || better(quality, best.quality)) best = { placements: out, unplaced: missing, quality };
    // A valid unchanged manual layout already minimizes the repair objective.
    if ((options.preferred?.length === skus.length && quality[0] === 0 && movement < 1e-6) || units.length <= 1) break;
  }
  const preferredIds = new Set(options.preferred?.map((p) => p.id));
  return { placements: (best?.placements ?? []).map((p) => ({ ...p, id: preferredIds.has(p.id) ? p.id : newPlacementId() })), unplaced: best?.unplaced ?? unplaced };
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
      ? '전원이 필요한 품목은 등록한 전원점과 가까운 자리를 우선했습니다. 거리는 집기 중심 기준이며 배선 경로·전기 용량은 계산하지 않습니다.'
      : '전원이 필요한 품목이 있지만 등록된 전원점이 없습니다. 공간에 전원점을 추가한 뒤 다시 배치해 주세요. 현재 배치에는 전원 거리가 반영되지 않았습니다.');
  }
  if (composition.entries.some((entry) => frontAccessPoly({ x: 0, y: 0, rot: 0 }, items.get(entry.sku)!) != null)) {
    composition.notes.push(`행거·선반·카운터·거울·포토존 정면에 ${FRONT_ACCESS_DEPTH}m의 사용 여유를 확보하는 조건으로 배치합니다. 앱의 계획 기본값이며 법정 통로 기준은 아닙니다.`);
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
