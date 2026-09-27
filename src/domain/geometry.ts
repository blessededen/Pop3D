import type { Door, Rect, Space } from './types';

export interface Vec {
  x: number;
  y: number;
}
export type Poly = Vec[];

const EPS = 1e-6;

/** 중심 (x, y), 가로 w, 깊이 d, 회전 rot(도)인 사각형의 네 꼭짓점 */
export function footprint(x: number, y: number, w: number, d: number, rot: number): Poly {
  const r = (rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const hw = w / 2;
  const hd = d / 2;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(([lx, ly]) => ({ x: x + lx * c - ly * s, y: y + lx * s + ly * c }));
}

export function rectPoly(r: { x: number; y: number; w: number; d: number }): Poly {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.d },
    { x: r.x, y: r.y + r.d },
  ];
}

function axes(p: Poly): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    out.push({ x: -ey / len, y: ex / len });
  }
  return out;
}

function project(p: Poly, ax: Vec): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of p) {
    const t = v.x * ax.x + v.y * ax.y;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return [min, max];
}

/** 두 볼록 다각형이 면적을 가지고 겹치는지(맞닿기만 한 경우는 겹침 아님) */
export function polysOverlap(a: Poly, b: Poly, eps = 1e-4): boolean {
  for (const ax of [...axes(a), ...axes(b)]) {
    const [aMin, aMax] = project(a, ax);
    const [bMin, bMax] = project(b, ax);
    if (Math.min(aMax, bMax) - Math.max(aMin, bMin) <= eps) return false;
  }
  return true;
}

export function polyInside(p: Poly, width: number, depth: number, eps = 1e-4): boolean {
  return p.every((v) => v.x >= -eps && v.y >= -eps && v.x <= width + eps && v.y <= depth + eps);
}

function pointSegDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 < EPS ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 두 볼록 다각형 사이 최단 거리. 겹치면 0 */
export function polyDistance(a: Poly, b: Poly): number {
  if (polysOverlap(a, b, 0)) return 0;
  let best = Infinity;
  for (const [p, q] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const v of p) {
      for (let i = 0; i < q.length; i++) {
        best = Math.min(best, pointSegDist(v, q[i], q[(i + 1) % q.length]));
      }
    }
  }
  return best;
}

export function bounds(p: Poly) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of p) {
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
  }
  return { minX, minY, maxX, maxY };
}

/** 문이 난 구간(벽 위의 선분)을 평면 좌표로 */
export function doorSegment(space: Space, door: Door): [Vec, Vec] {
  const { width: W, depth: D } = space;
  switch (door.wall) {
    case 'top':
      return [
        { x: door.offset, y: 0 },
        { x: door.offset + door.width, y: 0 },
      ];
    case 'bottom':
      return [
        { x: door.offset, y: D },
        { x: door.offset + door.width, y: D },
      ];
    case 'left':
      return [
        { x: 0, y: door.offset },
        { x: 0, y: door.offset + door.width },
      ];
    case 'right':
      return [
        { x: W, y: door.offset },
        { x: W, y: door.offset + door.width },
      ];
  }
}

export function doorCenter(space: Space, door: Door): Vec {
  const [a, b] = doorSegment(space, door);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** 문 앞 여유 구역. clearance가 미확인이면 null */
export function doorClearRect(space: Space, door: Door): Rect | null {
  if (door.clearance == null || door.clearance <= 0) return null;
  const c = door.clearance;
  const { width: W, depth: D } = space;
  const id = `${door.id}-clear`;
  const label = `${door.label} 앞 여유`;
  switch (door.wall) {
    case 'top':
      return { id, label, x: door.offset, y: 0, w: door.width, d: c };
    case 'bottom':
      return { id, label, x: door.offset, y: D - c, w: door.width, d: c };
    case 'left':
      return { id, label, x: 0, y: door.offset, w: c, d: door.width };
    case 'right':
      return { id, label, x: W - c, y: door.offset, w: c, d: door.width };
  }
}

export function round(n: number, step = 0.01): number {
  return Number((Math.round(n / step) * step).toFixed(4));
}

export function normRot(rot: number): number {
  return ((Math.round(rot) % 360) + 360) % 360;
}
