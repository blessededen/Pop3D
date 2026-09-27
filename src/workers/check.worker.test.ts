import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBriefChecks } from '../domain/scenarios';
import type { CheckWorkerRequest, CheckWorkerResponse } from './check.worker';

vi.mock('../domain/scenarios', async (importOriginal) => {
  const original = await importOriginal<typeof import('../domain/scenarios')>();
  return { ...original, runBriefChecks: vi.fn(original.runBriefChecks) };
});

const messages: CheckWorkerResponse[] = [];
const scope: {
  onmessage: ((event: MessageEvent<CheckWorkerRequest>) => void) | null;
  postMessage: (message: CheckWorkerResponse) => void;
} = { onmessage: null, postMessage: (message) => messages.push(message) };

beforeAll(async () => {
  vi.stubGlobal('self', scope);
  await import('./check.worker');
});
beforeEach(() => { messages.length = 0; });
afterAll(() => { vi.unstubAllGlobals(); });

const run = () => scope.onmessage!({ data: { type: 'run' } } as MessageEvent<CheckWorkerRequest>);

describe('검증 Worker', () => {
  it('기존 9개 시나리오의 실제 계산 결과를 전달한다', () => {
    run();
    expect(messages).toHaveLength(1);
    const response = messages[0];
    expect(response.type).toBe('complete');
    if (response.type !== 'complete') throw new Error('검증 결과 누락');
    expect(response.results).toHaveLength(9);
    expect(response.results.every((result) => result.pass)).toBe(true);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('계산 실패를 오류 응답으로 전달하고 다음 실행을 허용한다', () => {
    vi.mocked(runBriefChecks).mockImplementationOnce(() => { throw new Error('test failure'); });
    run();
    expect(messages[0].type).toBe('error');
    run();
    expect(messages[1].type).toBe('complete');
  });
});
