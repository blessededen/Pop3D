import { describe, expect, it } from 'vitest';
import { boundedAStar } from './astar';

describe('bounded A*', () => {
  it('compares g + h and revisits another partial path when the cheap first move is a dead end', () => {
    const graph: Record<string, { state: string; cost: number }[]> = {
      start: [{ state: 'tempting', cost: 1 }, { state: 'detour', cost: 2 }],
      tempting: [{ state: 'goal', cost: 20 }],
      detour: [{ state: 'goal', cost: 2 }], goal: [],
    };
    const expanded: string[] = [];
    const result = boundedAStar({
      start: 'start', heuristic: (node) => node === 'detour' ? 2 : 0,
      isGoal: (node) => node === 'goal', expand: (node) => { expanded.push(node); return graph[node]; },
      maxExpansions: 20, maxFrontier: 20,
      incumbent: { state: 'goal', cost: 21 },
    });
    expect(expanded).toEqual(['start', 'tempting', 'detour']);
    expect(result.solution?.cost).toBe(4);
    expect(result.truncated).toBe(false);
  });

  it('keeps a feasible incumbent when an explicit expansion budget is reached', () => {
    const result = boundedAStar({
      start: 0, heuristic: () => 0, isGoal: (node) => node === 100,
      expand: (node) => [{ state: node + 1, cost: 1 }],
      maxExpansions: 3, maxFrontier: 10, incumbent: { state: 100, cost: 100 },
    });
    expect(result.expanded).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.solution).toEqual({ state: 100, cost: 100 });
  });

  it('uses the heuristic to expand the more promising path before a cheaper edge', () => {
    const expanded: string[] = [];
    const result = boundedAStar({
      start: 'start', heuristic: (node) => node === 'long' ? 10 : 0,
      isGoal: (node) => node === 'goal',
      expand: (node) => {
        expanded.push(node);
        return node === 'start' ? [{ state: 'long', cost: 1 }, { state: 'short', cost: 2 }] :
          [{ state: 'goal', cost: node === 'long' ? 10 : 1 }];
      },
      maxExpansions: 10, maxFrontier: 10,
    });
    expect(expanded).toEqual(['start', 'short']);
    expect(result.solution?.cost).toBe(3);
  });
});
