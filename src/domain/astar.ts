/** A bounded A* search. Dropping frontier entries or reaching a budget means
 * the returned incumbent is the best found, not a proof of global optimality. */
export interface AStarOptions<State> {
  start: State;
  heuristic: (state: State) => number;
  isGoal: (state: State) => boolean;
  expand: (state: State) => Iterable<{ state: State; cost: number }>;
  maxExpansions: number;
  maxFrontier: number;
  /** A feasible solution may seed an upper bound without changing f = g + h. */
  incumbent?: { state: State; cost: number };
  shouldStop?: () => boolean;
}

interface Node<State> { state: State; g: number; f: number; order: number }

export function boundedAStar<State>(options: AStarOptions<State>) {
  let sequence = 0;
  let expanded = 0;
  let truncated = false;
  let best = options.incumbent;
  const frontier: Node<State>[] = [];
  // At equal lower bounds, finish the deeper path first; insertion order makes
  // repeated runs deterministic. This is still ordered by f = g + h.
  const compare = (a: Node<State>, b: Node<State>) => a.f - b.f || b.g - a.g || a.order - b.order;
  const push = (node: Node<State>) => {
    let index = frontier.push(node) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compare(frontier[parent], node) <= 0) break;
      frontier[index] = frontier[parent]; index = parent;
    }
    frontier[index] = node;
  };
  const pop = (): Node<State> => {
    const first = frontier[0];
    const last = frontier.pop()!;
    if (frontier.length) {
      let index = 0;
      while (index * 2 + 1 < frontier.length) {
        let child = index * 2 + 1;
        if (child + 1 < frontier.length && compare(frontier[child + 1], frontier[child]) < 0) child++;
        if (compare(last, frontier[child]) <= 0) break;
        frontier[index] = frontier[child]; index = child;
      }
      frontier[index] = last;
    }
    return first;
  };
  push({ state: options.start, g: 0, f: options.heuristic(options.start), order: sequence++ });
  while (frontier.length) {
    if (expanded >= options.maxExpansions || options.shouldStop?.()) { truncated = true; break; }
    const current = pop();
    if (best && current.f >= best.cost - 1e-9) continue;
    if (options.isGoal(current.state)) { best = { state: current.state, cost: current.g }; continue; }
    expanded++;
    for (const next of options.expand(current.state)) {
      if (!Number.isFinite(next.cost) || next.cost < 0) throw new Error('A* edges must have finite nonnegative costs');
      const g = current.g + next.cost;
      const f = g + options.heuristic(next.state);
      if (best && f >= best.cost - 1e-9) continue;
      if (options.isGoal(next.state)) {
        if (!best || g < best.cost - 1e-9) best = { state: next.state, cost: g };
      } else push({ state: next.state, g, f, order: sequence++ });
    }
    if (frontier.length > options.maxFrontier) {
      // A sorted array is also a valid min heap.
      frontier.sort(compare);
      frontier.length = options.maxFrontier;
      truncated = true;
    }
  }
  return { solution: best, expanded, truncated };
}
