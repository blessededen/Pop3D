import { checkDemoActive, demoWait } from './autoDemo';

/** Presentation time excludes hands-on editing; network work still checks cancellation. */
export function createDemoPlayback(signal: AbortSignal, now = () => performance.now()) {
  const start = now();
  let pausedAt: number | null = null, excluded = 0;
  const time = () => (pausedAt ?? now()) - start - excluded;
  const ready = async () => {
    checkDemoActive(signal);
    while (pausedAt !== null) await demoWait(80, signal);
    checkDemoActive(signal);
  };
  return {
    time, ready,
    pause() { if (pausedAt === null) pausedAt = now(); },
    resume() { if (pausedAt !== null) { excluded += now() - pausedAt; pausedAt = null; } },
    async wait(ms: number) {
      const end = time() + ms;
      do { await ready(); if (time() >= end) break; await demoWait(Math.min(80, end - time()), signal); } while (true);
    },
  };
}
