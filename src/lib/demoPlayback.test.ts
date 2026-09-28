import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoPlayback } from './demoPlayback';

afterEach(() => vi.useRealTimers());
describe('hands-on demo playback', () => {
  it('freezes presentation time and resumes without skipping the remaining step', async () => {
    vi.useFakeTimers(); const abort = new AbortController();
    const clock = createDemoPlayback(abort.signal, () => Date.now());
    let complete = false;
    const waiting = clock.wait(1000).then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(400); clock.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(clock.time()).toBe(400); expect(complete).toBe(false);
    clock.resume(); await vi.advanceTimersByTimeAsync(600); await waiting;
    expect(clock.time()).toBe(1000); expect(complete).toBe(true);
  });
  it('holds completed asynchronous work until editing finishes', async () => {
    vi.useFakeTimers(); const clock = createDemoPlayback(new AbortController().signal, () => Date.now());
    clock.pause(); let applied = false;
    const ready = clock.ready().then(() => { applied = true; });
    await vi.advanceTimersByTimeAsync(2000); expect(applied).toBe(false);
    clock.resume(); await vi.advanceTimersByTimeAsync(80); await ready; expect(applied).toBe(true);
  });
  it('cancels a paused continuation without any later writes or delivery', async () => {
    vi.useFakeTimers(); const abort = new AbortController();
    const clock = createDemoPlayback(abort.signal, () => Date.now()); clock.pause();
    const pending = clock.wait(0); const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort(); await failure; expect(vi.getTimerCount()).toBe(0);
  });
});
