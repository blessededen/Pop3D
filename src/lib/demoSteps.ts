import { checkDemoActive } from './autoDemo';

/** One click releases one waiting scene. Clicks during work are never queued. */
export function createDemoSteps(signal: AbortSignal, changed: (waiting: boolean) => void, now = () => performance.now()) {
  let advance: (() => void) | null = null;
  let lastAdvance = -Infinity;
  return {
    next() {
      if (!advance || now() - lastAdvance < 350) return;
      lastAdvance = now(); advance();
    },
    wait() {
      checkDemoActive(signal);
      if (advance) throw new Error('A demo scene is already waiting.');
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => { advance = null; signal.removeEventListener('abort', cancel); changed(false); };
        const cancel = () => { cleanup(); reject(new DOMException('시연 중지', 'AbortError')); };
        advance = () => { cleanup(); resolve(); };
        signal.addEventListener('abort', cancel, { once: true });
        changed(true);
      });
    },
  };
}
