import type { Door, NoGoZone, PowerPoint, Rect, Space, Wall } from './types';

export type SpaceObjectKind = 'columns' | 'zones' | 'fixtures' | 'doors' | 'powerPoints';
export type SpaceSelection = { kind: SpaceObjectKind; id: string };
export type SpaceTool = 'select' | SpaceObjectKind;
export const SPACE_KIND_LABEL: Record<SpaceObjectKind, string> = { columns: '기둥', zones: '금지 구역', fixtures: '고정 시설', doors: '출입구', powerPoints: '전원' };
export const WALL_LABEL: Record<Wall, string> = { top: '위쪽 벽', right: '오른쪽 벽', bottom: '아래쪽 벽', left: '왼쪽 벽' };
export const SPACE_KINDS: SpaceObjectKind[] = ['columns', 'zones', 'fixtures', 'doors', 'powerPoints'];
const clamp = (v: number, max: number) => Math.max(0, Math.min(v, Math.max(0, max)));
export const snapSpace = (value: number, step = 0.05) => Number((Math.round(value / step) * step).toFixed(4));
export function spaceObject(space: Space, selection: SpaceSelection | null): Rect | NoGoZone | Door | PowerPoint | undefined {
  return selection ? space[selection.kind].find(item => item.id === selection.id) : undefined;
}
export function doorPoint(space: Space, door: Door) {
  const t = door.offset + door.width / 2;
  return { x: door.wall === 'left' ? 0 : door.wall === 'right' ? space.width : t, y: door.wall === 'top' ? 0 : door.wall === 'bottom' ? space.depth : t };
}
export function nearestWall(space: Space, x: number, y: number, minimumLength = 0): Wall {
  const walls = ([['top', Math.abs(y)], ['right', Math.abs(space.width - x)], ['bottom', Math.abs(space.depth - y)], ['left', Math.abs(x)]] as [Wall, number][]).sort((a, b) => a[1] - b[1]);
  return walls.find(([wall]) => (wall === 'top' || wall === 'bottom' ? space.width : space.depth) >= minimumLength)?.[0] ?? walls[0][0];
}
/** Coordinates are a rectangle's upper-left corner, a point, or the center of a door. */
export function moveSpaceObject(space: Space, selection: SpaceSelection, x: number, y: number, snap = true) {
  const obj = spaceObject(space, selection);
  if (!obj) return;
  const n = (v: number) => snap ? snapSpace(v) : Number(v.toFixed(4));
  if ('wall' in obj) {
    obj.wall = nearestWall(space, x, y, obj.width);
    const horizontal = obj.wall === 'top' || obj.wall === 'bottom';
    const length = horizontal ? space.width : space.depth;
    obj.offset = clamp(n((horizontal ? x : y) - obj.width / 2), length - obj.width);
  } else {
    obj.x = clamp(n(x), space.width - ('w' in obj ? obj.w : 0));
    obj.y = clamp(n(y), space.depth - ('d' in obj ? obj.d : 0));
  }
}
export function fitSpaceObject(space: Space, selection: SpaceSelection) {
  const obj = spaceObject(space, selection);
  if (!obj) return;
  if ('wall' in obj) {
    const length = obj.wall === 'top' || obj.wall === 'bottom' ? space.width : space.depth;
    obj.width = Math.max(0.01, Math.min(obj.width, length));
    obj.offset = clamp(obj.offset, length - obj.width);
  } else {
    if ('w' in obj) { obj.w = Math.max(0.01, Math.min(obj.w, space.width)); obj.d = Math.max(0.01, Math.min(obj.d, space.depth)); }
    moveSpaceObject(space, selection, obj.x, obj.y, false);
  }
}
export function addSpaceObject(space: Space, kind: SpaceObjectKind, x: number, y: number): SpaceSelection {
  const id = `${kind}-${crypto.randomUUID()}`;
  const label = `${SPACE_KIND_LABEL[kind]} ${space[kind].length + 1}`;
  if (kind === 'doors') space.doors.push({ id, label, wall: 'bottom', offset: 0, width: Math.min(1.2, space.width, space.depth), clearance: null });
  else if (kind === 'powerPoints') space.powerPoints.push({ id, label, x, y });
  else {
    const size = kind === 'columns' ? [0.5, 0.5] : kind === 'zones' ? [1.5, 1.5] : [1.2, 0.6];
    const rect = { id, label, x: 0, y: 0, w: Math.min(size[0], space.width), d: Math.min(size[1], space.depth) };
    if (kind === 'zones') space.zones.push({ ...rect, reason: '' }); else space[kind].push(rect);
    x -= rect.w / 2; y -= rect.d / 2;
  }
  const selection = { kind, id };
  moveSpaceObject(space, selection, x, y);
  return selection;
}
export function removeSpaceObject(space: Space, selection: SpaceSelection) {
  const index = space[selection.kind].findIndex(obj => obj.id === selection.id);
  if (index >= 0) space[selection.kind].splice(index, 1);
}
export function duplicateSpaceObject(space: Space, selection: SpaceSelection): SpaceSelection | null {
  const original = spaceObject(space, selection);
  if (!original) return null;
  const copy = { ...structuredClone(original), id: `${selection.kind}-${crypto.randomUUID()}`, label: `${original.label} 복사` };
  if (selection.kind === 'doors') space.doors.push(copy as Door);
  else if (selection.kind === 'zones') space.zones.push(copy as NoGoZone);
  else if (selection.kind === 'powerPoints') space.powerPoints.push(copy as PowerPoint);
  else space[selection.kind].push(copy as Rect);
  const next = { kind: selection.kind, id: copy.id };
  if ('wall' in copy) { copy.offset += copy.width + 0.2; fitSpaceObject(space, next); }
  else moveSpaceObject(space, next, copy.x + 0.25, copy.y + 0.25);
  return next;
}
/** Place a new palette object by its visual center, without changing its dimensions. */
export function placeSpaceObjectCenter(space: Space, selection: SpaceSelection, x: number, y: number, snap = true) {
  const obj = spaceObject(space, selection);
  if (!obj) return;
  moveSpaceObject(space, selection, x - ('w' in obj ? obj.w / 2 : 0), y - ('d' in obj ? obj.d / 2 : 0), snap);
}
/** Resize only the chosen door edge; the opposite edge and wall stay fixed. */
export function resizeDoorEdge(space: Space, id: string, edge: 'start' | 'end', coordinate: number, snap = true) {
  const door = space.doors.find(item => item.id === id);
  if (!door) return;
  const length = door.wall === 'top' || door.wall === 'bottom' ? space.width : space.depth;
  const value = snap ? snapSpace(coordinate) : Number(coordinate.toFixed(4));
  const start = door.offset, end = door.offset + door.width;
  if (edge === 'start') {
    const nextStart = Math.max(0, Math.min(value, end - 0.05));
    door.offset = nextStart;
    door.width = Number((end - nextStart).toFixed(4));
  } else door.width = Number((Math.max(start + 0.05, Math.min(length, value)) - start).toFixed(4));
}
