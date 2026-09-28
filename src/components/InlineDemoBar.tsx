import { isInlineDemoLocked, useInlineDemo } from '../lib/inlineDemo';
import type { DemoStage } from '../lib/autoDemo';
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
  const seconds = Math.floor(Math.max(0, demo.elapsed));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const progress = demo.phase === 'done' ? 100 : Math.min(99, Math.max(0, demo.elapsed / 60 * 100));
  const title = demo.paused ? '직접 조작 중' : demo.phase === 'setup' ? '시연 준비' : demo.phase === 'done' ? '전송 완료' : demo.phase === 'stopped' ? '시연 중지됨' : LABEL[demo.stage];
  return <section className="inline-demo-bar" aria-label="자동 시연 진행" data-phase={demo.phase}>
    <div className="inline-demo-bar-main">
      <span className="inline-demo-badge"><span aria-hidden="true" />1분 자동 시연</span>
      <div className="inline-demo-bar-state"><strong role="status">{title}</strong><span>{demo.paused ? '수정 후 시연 이어가기를 누르세요.' : active ? '직접 조작할 수 있어요 · 조작하면 시연만 잠시 멈춥니다.' : demo.phase === 'done' ? '이 프로젝트에서 바로 편집을 이어가세요.' : '만든 프로젝트는 내 작업에 남아 있어요.'}</span></div>
      <span className="inline-demo-bar-time" aria-label={`시연 경과 ${seconds}초`}>{clock}</span>
      <div className="inline-demo-bar-actions">
        {demo.paused && demo.resume && <button type="button" className="btn primary sm" onClick={demo.resume}>시연 이어가기</button>}
        {demo.reconnect && <button type="button" className="btn primary sm" onClick={demo.reconnect}>카카오톡 연결</button>}
        {active && demo.stop && <button type="button" className="btn sm" onClick={demo.stop}>시연 중지</button>}
        {!active && demo.download && <button type="button" className="btn sm" onClick={demo.download}>PDF 받기</button>}
        {!active && demo.dismiss && <button type="button" className="btn primary sm" onClick={demo.dismiss}>계속 편집하기</button>}
      </div>
    </div>
    <progress max={100} value={progress} aria-label="자동 시연 진행률" />
    {(demo.error || demo.working) && <p className={demo.error ? 'inline-demo-bar-error' : 'inline-demo-bar-note'} role={demo.error ? 'alert' : 'status'}>{demo.error || demo.working}</p>}
  </section>;
}
