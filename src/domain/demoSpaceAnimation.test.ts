import { describe, expect, it } from 'vitest';
import { demoSpace } from './seed';
import { DEMO_SPACE_DURATION_MS, DEMO_SPACE_LEAD_MS, DEMO_SPACE_DROP_AT, demoDragPoint, demoSpaceFrame, demoSpaceOperations } from './demoSpaceAnimation';

const sources = { column: { x: -2, y: 1 }, power: { x: -2, y: 2 } };
const slot = (DEMO_SPACE_DURATION_MS - DEMO_SPACE_LEAD_MS - 650) / 3;

describe('demo space drag geometry and timing', () => {
  it('starts with no columns or power points, then visibly presses the palette before dragging', () => {
    const space = demoSpace();
    expect(demoSpaceFrame(space, 0, sources)).toMatchObject({ phase: 'waiting', columnCount: 0, powerCount: 0 });
    expect(demoSpaceFrame(space, DEMO_SPACE_LEAD_MS + slot * 0.24, sources)).toMatchObject({ phase: 'press', cursor: sources.column, columnCount: 0, powerCount: 0 });
    const travel = demoSpaceFrame(space, DEMO_SPACE_LEAD_MS + slot * 0.58, sources);
    expect(travel.phase).toBe('drag');
    expect(travel.cursor).not.toEqual(sources.column);
    expect(travel.cursor).not.toEqual(demoSpaceOperations(space)[0].destination);
    expect(travel.columnCount).toBe(0);
  });

  it('drops the real column and two outlets in order at their exact input coordinates', () => {
    const space = demoSpace(), operations = demoSpaceOperations(space);
    const one = demoSpaceFrame(space, DEMO_SPACE_LEAD_MS + slot * 0.9, sources);
    expect(one).toMatchObject({ phase: 'drop', columnCount: 1, powerCount: 0, cursor: { x: 4.8, y: 5 } });
    expect(one.operation?.width).toBe(space.columns[0].w);
    const two = demoSpaceFrame(space, DEMO_SPACE_LEAD_MS + slot * 1.9, sources);
    expect(two).toMatchObject({ phase: 'drop', columnCount: 1, powerCount: 1, cursor: operations[1].destination });
    const three = demoSpaceFrame(space, DEMO_SPACE_LEAD_MS + slot * 2.9, sources);
    expect(three).toMatchObject({ phase: 'drop', columnCount: 1, powerCount: 2, cursor: operations[2].destination });
    expect(demoSpaceFrame(space, DEMO_SPACE_LEAD_MS + slot * DEMO_SPACE_DROP_AT - 1, sources).columnCount).toBe(0);
  });

  it('finishes within eight seconds without changing the source geometry or inventing objects', () => {
    const space = demoSpace(), before = structuredClone(space);
    expect(demoSpaceFrame(space, 8000, sources)).toMatchObject({ phase: 'complete', columnCount: space.columns.length, powerCount: space.powerPoints.length, cursor: null });
    expect(demoSpaceFrame(space, 12000, sources)).toEqual(demoSpaceFrame(space, 8000, sources));
    expect(space).toEqual(before);
    expect(demoSpaceFrame({ ...space, columns: [], powerPoints: [] }, 0, sources)).toMatchObject({ phase: 'complete', columnCount: 0, powerCount: 0 });
  });

  it('resizing the palette changes the travel origin but never the destination or final geometry', () => {
    const space = demoSpace(), resized = { column: { x: -0.8, y: 0.4 }, power: { x: -0.8, y: 1.2 } };
    const during = DEMO_SPACE_LEAD_MS + slot * 0.6;
    expect(demoSpaceFrame(space, during, sources).cursor).not.toEqual(demoSpaceFrame(space, during, resized).cursor);
    const drop = DEMO_SPACE_LEAD_MS + slot * 0.9;
    expect(demoSpaceFrame(space, drop, sources).cursor).toEqual(demoSpaceFrame(space, drop, resized).cursor);
    expect(demoDragPoint(sources.column, { x: 4.81234, y: 5.01234 }, 1)).toEqual({ x: 4.81234, y: 5.01234 });
  });

  it('shows final geometry immediately for reduced motion and bounds invalid timing', () => {
    const space = demoSpace();
    expect(demoSpaceFrame(space, 0, sources, true)).toEqual(demoSpaceFrame(space, 8000, sources));
    expect(demoSpaceFrame(space, -100, sources)).toEqual(demoSpaceFrame(space, 0, sources));
    expect(demoSpaceFrame(space, NaN, sources)).toEqual(demoSpaceFrame(space, 0, sources));
  });
});
