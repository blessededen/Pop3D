import { isInlineDemoLocked, useInlineDemo } from '../lib/inlineDemo';
import { DEMO_STAGES, type DemoStage } from '../lib/autoDemo';
import './InlineDemoBar.css';

const LABEL: Record<DemoStage, string> = {
  brief: '기획 조건', space: '공간 구성', fixtures: '집기 선택', layout: '자동 배치',
  three: '3D 살펴보기', review: '비용 검토', pdf: '보고서 만들기', send: '카카오톡 전송', done: '전송 완료',
};

/** Playback controls remain available while the real editor is interactive. */
export default function InlineDemoBar() {
  const demo = useInlineDemo();
  if (!demo.runId || demo.phase === 'idle') return null;
  const active = isInlineDemoLocked(demo.phase);
  const position = DEMO_STAGES.indexOf(demo.stage);
  const progress = demo.phase === 'done' ? 100 : position / (DEMO_STAGES.length - 1) * 100;
  const title = demo.paused ? '직접 조작 중' : demo.phase === 'setup' ? '시연 준비' : demo.phase === 'done' ? '전송 완료' : demo.phase === 'stopped' ? '시연 중지됨' : LABEL[demo.stage];
  return <section className="inline-demo-bar" aria-label="단계별 시연" data-phase={demo.phase} data-stage={demo.stage}>
    <div className="inline-demo-bar-main">
      <span className="inline-demo-badge"><span aria-hidden="true" />단계별 시연</span>
      <div className="inline-demo-bar-state"><strong role="status">{title}</strong><span>{active ? '직접 조작해 보세요. 다음을 누를 때만 장면이 바뀝니다.' : demo.phase === 'done' ? '이 프로젝트에서 바로 편집을 이어가세요.' : '만든 프로젝트는 내 작업에 남아 있어요.'}</span></div>
      <span className="inline-demo-bar-time" aria-label={`장면 ${position + 1} / ${DEMO_STAGES.length}`}>{position + 1} / {DEMO_STAGES.length}</span>
      <div className="inline-demo-bar-actions">
        {demo.phase === 'running' && demo.next && <button type="button" className="btn primary sm" data-testid="demo-next" disabled={!demo.canAdvance && !demo.paused} onClick={demo.canAdvance ? demo.next : demo.resume ?? undefined}>{demo.canAdvance ? demo.stage === 'pdf' ? '카카오톡으로 보내기 →' : '다음 장면 →' : demo.paused ? '수정 반영 · 다시 확인' : '장면 준비 중…'}</button>}
        {demo.reconnect && <button type="button" className="btn primary sm" onClick={demo.reconnect}>카카오톡 연결</button>}
        {active && demo.stop && <button type="button" className="btn sm" onClick={demo.stop}>시연 중지</button>}
        {!active && demo.download && <button type="button" className="btn sm" onClick={demo.download}>PDF 받기</button>}
        {!active && demo.dismiss && <button type="button" className="btn primary sm" onClick={demo.dismiss}>계속 편집하기</button>}
      </div>
    </div>
    <progress max={100} value={progress} aria-label="시연 진행률" />
    {(demo.error || demo.working) && <p className={demo.error ? 'inline-demo-bar-error' : 'inline-demo-bar-note'} role={demo.error ? 'alert' : 'status'}>{demo.error || demo.working}</p>}
  </section>;
}
