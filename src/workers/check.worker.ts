import { runBriefChecks, type CheckResult } from '../domain/scenarios';

export interface CheckWorkerRequest {
  type: 'run';
}

export type CheckWorkerResponse =
  | { type: 'complete'; results: CheckResult[]; durationMs: number }
  | { type: 'error'; message: string };

// A narrow worker interface avoids adding DOM/WebWorker duplicate global declarations.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<CheckWorkerRequest>) => void) | null;
  postMessage: (message: CheckWorkerResponse) => void;
};

scope.onmessage = (event) => {
  if (event.data.type !== 'run') return;
  const startedAt = performance.now();
  try {
    const results = runBriefChecks();
    scope.postMessage({ type: 'complete', results, durationMs: Math.round(performance.now() - startedAt) });
  } catch {
    scope.postMessage({ type: 'error', message: '검증 계산을 마치지 못했습니다. 다시 실행해 주세요.' });
  }
};
