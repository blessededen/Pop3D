import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDemoOwner, demoWait, newDemoSession, readDemoSession, runDemoTimeline, writeDemoSession, type DemoStage } from './autoDemo';

const receipt = { ok: true as const, url: 'https://pop3-d.vercel.app/#/shared/example', expiresAt: '2026-10-05T00:00:00.000Z' };
function timeline() {
  let time = 0;
  const controller = new AbortController();
  const stages: Array<[DemoStage, number]> = [];
  const calls: string[] = [];
  const deps = {
    signal: controller.signal,
    now: () => time,
    wait: async (ms: number) => { if (controller.signal.aborted) throw new DOMException('cancel', 'AbortError'); time += ms; },
    stage: (stage: DemoStage) => { stages.push([stage, time]); },
    plan: vi.fn(async () => { calls.push('plan'); return 9; }),
    reveal: vi.fn((count: number) => calls.push(`reveal:${count}`)),
    save: vi.fn(async () => { calls.push('save'); }),
    buildPdf: vi.fn(async () => { calls.push('pdf'); }),
    send: vi.fn(async () => { calls.push('send'); return receipt; }),
    received: vi.fn(() => { calls.push('received'); }),
  };
  return { deps, controller, stages, calls, advance: (ms: number) => { time += ms; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('one-minute live demo sequencing', () => {
  it('runs actual operations in order and completes the presentation at sixty seconds', async () => {
    const run = timeline(); await runDemoTimeline(run.deps);
    expect(run.stages).toEqual([['brief', 0], ['space', 8000], ['fixtures', 16000], ['layout', 24000], ['three', 33000], ['pdf', 43000], ['send', 54000], ['done', 60000]]);
    expect(run.calls).toEqual(['plan', ...Array.from({ length: 9 }, (_, i) => `reveal:${i + 1}`), 'save', 'pdf', 'send', 'received']);
    expect(run.deps.send).toHaveBeenCalledTimes(1); expect(run.deps.received).toHaveBeenCalledWith(receipt);
  });
  it('never sends or claims success if PDF generation fails', async () => {
    const run = timeline(); run.deps.buildPdf.mockRejectedValue(new Error('font unavailable'));
    await expect(runDemoTimeline(run.deps)).rejects.toThrow('font unavailable');
    expect(run.deps.send).not.toHaveBeenCalled(); expect(run.stages.some(([s]) => s === 'done')).toBe(false);
  });
  it('does not retry an uncertain send or fabricate completion', async () => {
    const run = timeline(); run.deps.send.mockRejectedValue(new Error('delivery_unknown'));
    await expect(runDemoTimeline(run.deps)).rejects.toThrow('delivery_unknown');
    expect(run.deps.send).toHaveBeenCalledTimes(1); expect(run.deps.received).not.toHaveBeenCalled();
    expect(run.stages.at(-1)?.[0]).toBe('send');
  });
  it('a stopped demo never enters a later send even if planning finishes', async () => {
    const run = timeline(); run.deps.plan.mockImplementation(async () => { run.controller.abort(); return 9; });
    await expect(runDemoTimeline(run.deps)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run.deps.save).not.toHaveBeenCalled(); expect(run.deps.send).not.toHaveBeenCalled();
  });
  it('waits for slow delivery beyond sixty seconds instead of displaying success early', async () => {
    const run = timeline(); run.deps.send.mockImplementation(async () => { run.advance(12000); return receipt; });
    await runDemoTimeline(run.deps); expect(run.stages.at(-1)).toEqual(['done', 66000]);
  });
  it('cancels a real timer immediately', async () => {
    vi.useFakeTimers(); const controller = new AbortController(); const waiting = demoWait(60000, controller.signal);
    controller.abort(); await expect(waiting).rejects.toMatchObject({ name: 'AbortError' }); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('demo consent intent survives only in this tab and for the same account', () => {
  function storage() { const values = new Map<string, string>(); vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value) } }); return values; }
  it('preserves a bounded run identifier through OAuth and does not infer intent from the route', () => {
    storage(); expect(readDemoSession()).toBeNull();
    const run = newDemoSession(null, ''); writeDemoSession(run); expect(readDemoSession()).toEqual(run);
    expect(() => assertDemoOwner(run, 'owner-one')).not.toThrow();
    run.owner = 'owner-one'; expect(() => assertDemoOwner(run, 'owner-two')).toThrow('계정'); expect(() => assertDemoOwner(run, null)).toThrow('계정');
  });
  it('rejects stale or malformed run intent', () => {
    storage(); const run = newDemoSession('owner-one', 'project-one');
    writeDemoSession({ ...run, createdAt: Date.now() - 3600001 }); expect(readDemoSession()).toBeNull();
    writeDemoSession({ ...run, id: 'invalid' }); expect(readDemoSession()).toBeNull();
  });
  it('blocks OAuth navigation when persistence is unavailable', () => {
    vi.stubGlobal('window', { sessionStorage: { setItem: () => { throw new Error('quota'); } } });
    expect(() => writeDemoSession(newDemoSession(null, ''))).toThrow('저장');
  });
});
