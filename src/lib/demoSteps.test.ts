import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoSteps } from './demoSteps';
import { runDemoTimeline, type DemoStage } from './autoDemo';
afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
describe('presenter-driven scenes', () => {
  it('stays on a scene indefinitely and never queues a double click', async () => {
    vi.useFakeTimers(); const abort = new AbortController(); const changes = vi.fn();
    const steps = createDemoSteps(abort.signal, changes);
    let complete = false; const pending = steps.wait().then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(600000); expect(complete).toBe(false);
    steps.next(); steps.next(); await pending;
    complete = false; const second = steps.wait().then(() => { complete = true; });
    await flush(); expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(400); steps.next(); await second; expect(changes.mock.calls.map(c => c[0])).toEqual([true, false, true, false]);
  });
  it('cancels a pending scene and ignores later clicks', async () => {
    const abort = new AbortController(); const steps = createDemoSteps(abort.signal, vi.fn());
    const pending = steps.wait(); const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort(); await failure; expect(() => steps.next()).not.toThrow();
  });
  it('requires a separate click after PDF preparation before sending exactly once', async () => {
    let now = 0;
    const abort = new AbortController(); const steps = createDemoSteps(abort.signal, vi.fn(), () => now);
    const stages: DemoStage[] = []; const send = vi.fn(async () => ({ ok: true as const, url: 'https://example.com/report', expiresAt: '2026-12-31T00:00:00Z' }));
    const run = runDemoTimeline({ signal: abort.signal, next: steps.wait, stage: s => stages.push(s),
      plan: async () => 0, reveal: vi.fn(), save: async () => {}, buildPdf: async () => {}, send, received: vi.fn() });
    await flush(); expect(stages).toEqual(['brief']);
    for (let i = 0; i < 6; i++) { now += 400; steps.next(); await flush(); }
    expect(stages.at(-1)).toBe('pdf'); expect(send).not.toHaveBeenCalled();
    now += 400; steps.next(); steps.next(); await run; steps.next();
    expect(send).toHaveBeenCalledTimes(1); expect(stages.at(-1)).toBe('done');
  });
});
