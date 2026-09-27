import { useEffect, useState } from 'react';
import type { CheckResult } from '../domain/scenarios';
import type { CheckWorkerRequest, CheckWorkerResponse } from '../workers/check.worker';

type CheckState =
  | { status: 'loading' }
  | { status: 'complete'; results: CheckResult[]; durationMs: number }
  | { status: 'error'; message: string };

export default function CheckPage() {
  const [run, setRun] = useState(0);
  const [state, setState] = useState<CheckState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopWorker = () => {
      if (!worker) return;
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      worker = null;
    };
    const fail = (message: string) => {
      if (!active) return;
      stopWorker();
      setState({ status: 'error', message });
    };

    // Give the loading view its first paint, then start the work off the UI thread.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        if (!active) return;
        try {
          worker = new Worker(new URL('../workers/check.worker.ts', import.meta.url), { type: 'module' });
          worker.onmessage = (event: MessageEvent<CheckWorkerResponse>) => {
            if (!active) return;
            const result = event.data;
            stopWorker();
            if (result.type === 'complete') {
              setState({ status: 'complete', results: result.results, durationMs: result.durationMs });
            } else {
              setState({ status: 'error', message: result.message });
            }
          };
          worker.onerror = (event) => {
            event.preventDefault();
            fail('검증을 불러오거나 실행하지 못했습니다. 다시 시도해 주세요.');
          };
          worker.onmessageerror = () => fail('검증 결과를 읽지 못했습니다. 다시 시도해 주세요.');
          worker.postMessage({ type: 'run' } satisfies CheckWorkerRequest);
        } catch {
          fail('이 브라우저에서 검증을 시작하지 못했습니다. 다시 시도해 주세요.');
        }
      }, 0);
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      stopWorker();
    };
  }, [run]);

  const rerun = () => {
    setState({ status: 'loading' });
    setRun((value) => value + 1);
  };
  const passed = state.status === 'complete' ? state.results.filter((result) => result.pass).length : 0;

  return (
    <div className="page check-page">
      <div className="page-head">
        <div>
          <h1>검증</h1>
          <p>가상 데이터로 배치·비용·버전 시나리오의 기대 결과와 실제 계산 결과를 대조합니다.</p>
        </div>
        <div className="row wrap check-status">
          {state.status === 'complete' && (
            <>
              <span className={`chip ${passed === state.results.length ? 'ok' : 'error'}`} style={{ height: 30, fontSize: 14 }} role="status">
                {passed} / {state.results.length} 통과
              </span>
              <button type="button" className="btn sm" onClick={rerun}>다시 검증</button>
            </>
          )}
          {state.status === 'loading' && <span className="chip" role="status">검증 중</span>}
        </div>
      </div>

      {state.status === 'loading' && (
        <section className="panel check-loading" role="status" aria-live="polite" aria-busy="true">
          <span className="check-loading-indicator" aria-hidden="true" />
          <h3>검증 결과를 준비하고 있습니다</h3>
          <p className="muted">배치·비용·버전 시나리오를 계산하고 있습니다. 다른 탭으로 이동할 수 있습니다.</p>
        </section>
      )}

      {state.status === 'error' && (
        <section className="panel check-error" role="alert">
          <h3>검증을 완료하지 못했습니다</h3>
          <p className="muted">{state.message}</p>
          <button type="button" className="btn" onClick={rerun}>다시 시도</button>
        </section>
      )}

      {state.status === 'complete' && (
        <section className="panel check-results">
          <div className="panel-head">
            <h3>시나리오별 검증 결과</h3>
            <span className="small muted">계산 {(state.durationMs / 1000).toFixed(2)}초</span>
          </div>
          <div className="table-wrap">
            <table className="table check-table">
              <thead>
                <tr>
                  <th>근거</th>
                  <th>시나리오</th>
                  <th>기대 결과</th>
                  <th>실제 결과</th>
                  <th>판정</th>
                </tr>
              </thead>
              <tbody>
                {state.results.map((result) => (
                  <tr key={result.id}>
                    <td>{result.id}</td>
                    <td style={{ fontWeight: 600 }}>{result.title}</td>
                    <td className="small">{result.expected}</td>
                    <td className="small">{result.actual}</td>
                    <td className={result.pass ? 'pass' : 'fail'}>{result.pass ? '통과' : '실패'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">근거 번호는 원본 브리프의 장·항목 번호입니다. 표의 결과는 가상 데이터로 실행한 이번 검증에 해당합니다.</p>
        </section>
      )}
    </div>
  );
}
