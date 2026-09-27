import { footprint, type Poly } from './geometry';
import type { CatalogItem, Category, Placement, PowerPoint, Space } from './types';

/** 배치 계획용 기본 여유. 법정 통로 폭이나 현장 설치 적합성을 뜻하지 않는다. */
export const FRONT_ACCESS_DEPTH = 0.6;
export const HEIGHT_CLEARANCE_NOTICE = 0.3;

/** 공간 단계에서 입력한 수직 규격을 모든 선택·배치·보고서에 공통 적용한다. */
export function fixtureHeightStatus(space: Pick<Space, 'height'>, item: Pick<CatalogItem, 'h'>) {
  const clearance = space.height - item.h;
  const blocked = !Number.isFinite(clearance) || !Number.isFinite(item.h) || item.h <= 0 || space.height <= 0 || clearance <= 1e-6;
  return { blocked, clearance, warning: !blocked && clearance < HEIGHT_CLEARANCE_NOTICE - 1e-6 };
}
const FRONT_ACCESS_CATEGORIES = new Set<Category>(['hanger', 'shelf', 'counter', 'mirror', 'photozone']);

/** rot=0의 정면은 +y. 자동 배치와 수동 배치 검사가 같은 사용 영역을 쓴다. */
export function frontAccessPoly(
  placement: Pick<Placement, 'x' | 'y' | 'rot'>,
  item: Pick<CatalogItem, 'w' | 'd' | 'category'>,
  depth = FRONT_ACCESS_DEPTH,
): Poly | null {
  if (!FRONT_ACCESS_CATEGORIES.has(item.category)) return null;
  const angle = placement.rot * Math.PI / 180;
  const offset = (item.d + depth) / 2;
  return footprint(
    placement.x - Math.sin(angle) * offset,
    placement.y + Math.cos(angle) * offset,
    item.w,
    depth,
    placement.rot,
  );
}

export function validPowerPoints(space: Pick<Space, 'width' | 'depth' | 'powerPoints'>): PowerPoint[] {
  return space.powerPoints.filter((point) =>
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.y >= 0 && point.x <= space.width && point.y <= space.depth,
  );
}

/** 집기 중심과 등록된 전원점의 평면 직선 거리. 배선 경로나 전기 용량은 계산하지 않는다. */
export function nearestPowerDistance(position: Pick<Placement, 'x' | 'y'>, points: readonly PowerPoint[]): number {
  let nearest = Infinity;
  for (const point of points) nearest = Math.min(nearest, Math.hypot(position.x - point.x, position.y - point.y));
  return nearest;
}
