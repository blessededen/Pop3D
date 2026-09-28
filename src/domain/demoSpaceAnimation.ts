import type { Space } from './types';

export const DEMO_SPACE_DURATION_MS = 8000;
export const DEMO_SPACE_LEAD_MS = 450;
const END_HOLD_MS = 650;
export const DEMO_SPACE_PRESS_AT = 0.18;
export const DEMO_SPACE_DRAG_AT = 0.32;
export const DEMO_SPACE_DROP_AT = 0.84;

export interface DemoPoint { x: number; y: number }
export interface DemoSpaceSources { column: DemoPoint; power: DemoPoint }
export interface DemoSpaceOperation {
  kind: 'column' | 'power';
  id: string;
  label: string;
  destination: DemoPoint;
  width?: number;
  depth?: number;
}
export interface DemoSpaceFrame {
  phase: 'waiting' | 'approach' | 'press' | 'drag' | 'drop' | 'complete';
  operation: DemoSpaceOperation | null;
  cursor: DemoPoint | null;
  source: DemoPoint | null;
  columnCount: number;
  powerCount: number;
  phaseProgress: number;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => { const p = clamp(value); return p * p * (3 - 2 * p); };

export function demoSpaceOperations(space: Space): DemoSpaceOperation[] {
  return [
    ...space.columns.map(column => ({ kind: 'column' as const, id: column.id, label: column.label,
      destination: { x: column.x + column.w / 2, y: column.y + column.d / 2 }, width: column.w, depth: column.d })),
    ...space.powerPoints.map(power => ({ kind: 'power' as const, id: power.id, label: power.label, destination: { x: power.x, y: power.y } })),
  ];
}

/** Curve and coordinates remain in the same metre-based space as the plan. */
export function demoDragControl(from: DemoPoint, to: DemoPoint): DemoPoint {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const arc = Math.min(0.7, distance * 0.12);
  return { x: (from.x + to.x) / 2 + (distance ? -dy / distance * arc : 0), y: (from.y + to.y) / 2 + (distance ? dx / distance * arc : 0) };
}

export function demoDragPoint(from: DemoPoint, to: DemoPoint, progress: number): DemoPoint {
  if (progress <= 0) return { ...from };
  if (progress >= 1) return { ...to };
  const p = ease(progress), q = 1 - p, control = demoDragControl(from, to);
  return { x: q * q * from.x + 2 * q * p * control.x + p * p * to.x, y: q * q * from.y + 2 * q * p * control.y + p * p * to.y };
}

/** Presentation only: never mutates the real space or rounds its final geometry. */
export function demoSpaceFrame(space: Space, elapsedMs: number, sources: DemoSpaceSources, reducedMotion = false): DemoSpaceFrame {
  const operations = demoSpaceOperations(space);
  const t = reducedMotion || elapsedMs === Infinity ? DEMO_SPACE_DURATION_MS : Math.min(DEMO_SPACE_DURATION_MS, Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const slot = (DEMO_SPACE_DURATION_MS - DEMO_SPACE_LEAD_MS - END_HOLD_MS) / Math.max(1, operations.length);
  const dropped = operations.filter((_, index) => t >= DEMO_SPACE_LEAD_MS + (index + DEMO_SPACE_DROP_AT) * slot);
  const counts = { columnCount: dropped.filter(operation => operation.kind === 'column').length, powerCount: dropped.filter(operation => operation.kind === 'power').length };
  const base = { ...counts, operation: null, cursor: null, source: null, phaseProgress: 0 };
  if (!operations.length || t >= DEMO_SPACE_DURATION_MS - END_HOLD_MS) return { ...base, phase: 'complete' };
  const index = Math.max(0, Math.floor((t - DEMO_SPACE_LEAD_MS) / slot));
  const operation = operations[index], source = sources[operation.kind];
  const origin = index ? operations[index - 1].destination : { x: space.width * 0.28, y: space.depth * 0.15 };
  if (t < DEMO_SPACE_LEAD_MS) return { ...base, operation, source, cursor: origin, phase: 'waiting' };
  const fraction = clamp((t - DEMO_SPACE_LEAD_MS - index * slot) / slot);
  if (fraction < DEMO_SPACE_PRESS_AT) {
    const progress = fraction / DEMO_SPACE_PRESS_AT;
    return { ...counts, operation, source, cursor: demoDragPoint(origin, source, progress), phase: 'approach', phaseProgress: progress };
  }
  if (fraction < DEMO_SPACE_DRAG_AT) return { ...counts, operation, source, cursor: { ...source }, phase: 'press', phaseProgress: (fraction - DEMO_SPACE_PRESS_AT) / (DEMO_SPACE_DRAG_AT - DEMO_SPACE_PRESS_AT) };
  if (fraction < DEMO_SPACE_DROP_AT) {
    const progress = (fraction - DEMO_SPACE_DRAG_AT) / (DEMO_SPACE_DROP_AT - DEMO_SPACE_DRAG_AT);
    return { ...counts, operation, source, cursor: demoDragPoint(source, operation.destination, progress), phase: 'drag', phaseProgress: progress };
  }
  return { ...counts, operation, source, cursor: { ...operation.destination }, phase: 'drop', phaseProgress: (fraction - DEMO_SPACE_DROP_AT) / (1 - DEMO_SPACE_DROP_AT) };
}
