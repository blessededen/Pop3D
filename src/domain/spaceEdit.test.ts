import { describe, expect, it } from 'vitest';
import { demoSpace } from './seed';
import type { Space } from './types';
import { addSpaceObject, doorPoint, duplicateSpaceObject, fitSpaceObject, moveSpaceObject, placeSpaceObjectCenter, resizeDoorEdge, removeSpaceObject, spaceObject } from './spaceEdit';

const room = (): Space => ({ ...demoSpace(), width: 6, depth: 8, columns: [], zones: [], fixtures: [], doors: [], powerPoints: [] });
describe('visual space editing', () => {
  it('adds a column centered on a click, snaps it and keeps it inside the room', () => {
    const s = room();
    const selection = addSpaceObject(s, 'columns', 5.99, 7.99);
    expect(spaceObject(s, selection)).toMatchObject({ x: 5.5, y: 7.5, w: 0.5, d: 0.5 });
    moveSpaceObject(s, selection, -5, 2.123);
    expect(spaceObject(s, selection)).toMatchObject({ x: 0, y: 2.1 });
  });
  it('preserves centimeter-specific dimensions and freely entered coordinates', () => {
    const s = room(), selection = addSpaceObject(s, 'columns', 2, 2);
    const obj = spaceObject(s, selection)!;
    if (!('w' in obj)) throw new Error('expected rectangle');
    obj.w = 0.43; obj.d = 0.67; obj.x = 1.23; obj.y = 2.34;
    fitSpaceObject(s, selection);
    expect(spaceObject(s, selection)).toMatchObject({ w: 0.43, d: 0.67, x: 1.23, y: 2.34 });
  });
  it('moves an entrance between walls and clamps its full width at a corner', () => {
    const s = room(), selection = addSpaceObject(s, 'doors', 5.99, 3);
    expect(spaceObject(s, selection)).toMatchObject({ wall: 'right', width: 1.2, offset: 2.4 });
    moveSpaceObject(s, selection, 5.9, 0);
    expect(spaceObject(s, selection)).toMatchObject({ wall: 'top', offset: 4.8 });
    expect(doorPoint(s, s.doors[0]).x).toBeCloseTo(5.4);
  });
  it('keeps an existing entrance width when dragged toward a shorter wall', () => {
    const s = room(); s.width = 2; s.depth = 8;
    const selection = addSpaceObject(s, 'doors', 0, 3);
    s.doors[0].width = 3;
    moveSpaceObject(s, selection, 1, 0);
    expect(s.doors[0].width).toBe(3);
    expect(['left', 'right']).toContain(s.doors[0].wall);
  });
  it('duplicates without changing the source and deletes only the selected object', () => {
    const s = room(), first = addSpaceObject(s, 'zones', 2, 2);
    s.zones[0].reason = '비상 통로';
    const before = structuredClone(s.zones[0]), second = duplicateSpaceObject(s, first)!;
    expect(s.zones[0]).toEqual(before);
    expect(spaceObject(s, second)).toMatchObject({ reason: '비상 통로', x: before.x + 0.25 });
    expect(second.id).not.toBe(first.id);
    removeSpaceObject(s, second);
    expect(s.zones).toEqual([before]);
  });
  it('fits a resized fixture and clamps a power point to the boundary', () => {
    const s = room(), selection = addSpaceObject(s, 'fixtures', 5, 7);
    const obj = spaceObject(s, selection)!;
    if (!('w' in obj)) throw new Error('expected rectangle');
    obj.w = 9; obj.d = 10; fitSpaceObject(s, selection);
    expect(obj).toMatchObject({ x: 0, y: 0, w: 6, d: 8 });
    const power = addSpaceObject(s, 'powerPoints', 20, -3);
    expect(spaceObject(s, power)).toMatchObject({ x: 6, y: 0 });
  });
});
describe('drag placement and door handles', () => {
  it.each(['columns', 'zones', 'fixtures'] as const)('places %s around the drop point without changing measured size', kind => {
    const s = room(), selection = addSpaceObject(s, kind, 0, 0);
    const item = spaceObject(s, selection)!;
    if (!('w' in item)) throw new Error('expected rectangle');
    item.w = 0.43; item.d = 0.67;
    placeSpaceObjectCenter(s, selection, 3, 4, false);
    expect(item.x + item.w / 2).toBeCloseTo(3);
    expect(item.y + item.d / 2).toBeCloseTo(4);
    expect(item.w).toBe(0.43); expect(item.d).toBe(0.67);
    placeSpaceObjectCenter(s, selection, 100, -100);
    expect(item.x).toBeCloseTo(s.width - item.w); expect(item.y).toBe(0);
  });
  it('places a power point directly at the drop position and an entrance at its center', () => {
    const s = room(), power = addSpaceObject(s, 'powerPoints', 0, 0), door = addSpaceObject(s, 'doors', 0, 2);
    placeSpaceObjectCenter(s, power, 2.13, 3.47);
    expect(spaceObject(s, power)).toMatchObject({ x: 2.15, y: 3.45 });
    placeSpaceObjectCenter(s, door, 6, 4);
    expect(s.doors[0]).toMatchObject({ wall: 'right', offset: 3.4, width: 1.2 });
  });
  it.each(['top', 'right', 'bottom', 'left'] as const)('resizes both door ends on the %s wall without moving the other end', wall => {
    const s = room();
    s.doors.push({ id: 'door', wall, offset: 1, width: 1.2, clearance: 0.7, label: '입구' });
    resizeDoorEdge(s, 'door', 'end', 3.13);
    expect(s.doors[0]).toMatchObject({ wall, offset: 1, width: 2.15, clearance: 0.7 });
    resizeDoorEdge(s, 'door', 'start', 0.5);
    expect(s.doors[0].offset + s.doors[0].width).toBeCloseTo(3.15);
    expect(s.doors[0].offset).toBe(0.5);
    resizeDoorEdge(s, 'door', 'end', 100);
    expect(s.doors[0].offset + s.doors[0].width).toBeCloseTo(wall === 'top' || wall === 'bottom' ? s.width : s.depth);
    resizeDoorEdge(s, 'door', 'start', -5);
    expect(s.doors[0].offset).toBe(0);
  });
  it('does not let handles cross or collapse the opening to zero', () => {
    const s = room(); s.doors.push({ id: 'door', wall: 'top', offset: 1, width: 1.2, clearance: null, label: '입구' });
    resizeDoorEdge(s, 'door', 'start', 10);
    expect(s.doors[0].width).toBeCloseTo(0.05);
    resizeDoorEdge(s, 'door', 'end', -1);
    expect(s.doors[0].width).toBeCloseTo(0.05);
    expect(s.doors[0].offset).toBeCloseTo(2.15);
  });
});
