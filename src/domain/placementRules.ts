import { footprint, type Poly } from './geometry';
import type { CatalogItem, Category, Placement, PowerPoint, Space } from './types';

/** 배치 계획용 기본 여유. 법정 통로 폭이나 현장 설치 적합성을 뜻하지 않는다. */
export const FRONT_ACCESS_DEPTH = 0.6;
const FRONT_ACCESS_CATEGORIES = new Set<Category>(['hanger', 'shelf', 'counter', 'mirror', 'photozone']);

/** rot=0의 정면은 +y. 자동 배치와 수동 배치 검사가 같은 사용 영역을 쓴다. */
export function frontAccessPoly(
  placement: Pick<Placement, 'x' | 'y' | 'rot'>,
  item: Pick<CatalogItem, 'w' | 'd' | 'category'>,
): Poly | null {
  if (!FRONT_ACCESS_CATEGORIES.has(item.category)) return null;
  const angle = placement.rot * Math.PI / 180;
  const offset = (item.d + FRONT_ACCESS_DEPTH) / 2;
  return footprint(
    placement.x - Math.sin(angle) * offset,
    placement.y + Math.cos(angle) * offset,
    item.w,
    FRONT_ACCESS_DEPTH,
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
