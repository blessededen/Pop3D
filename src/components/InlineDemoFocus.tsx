import { useEffect } from 'react';
import { useInlineDemo } from '../lib/inlineDemo';
import type { DemoStage } from '../lib/autoDemo';

const TARGET: Record<DemoStage, string> = {
  brief: '.space-design-grid', space: '.space-canvas-shell', fixtures: '.layout-setup',
  layout: '.layout-result-toolbar', three: '.layout-result-toolbar', review: '.flow-review-grid',
  pdf: '.inline-demo-report', send: '.kakao-report-send', done: '.kakao-report-send',
};

/** Follow the existing editor once per step, including lazy-loaded sections. */
export default function InlineDemoFocus() {
  const runId = useInlineDemo(s => s.runId);
  const stage = useInlineDemo(s => s.stage);
  const playing = useInlineDemo(s => s.phase === 'running' || s.phase === 'sending');
  useEffect(() => {
    if (!runId || !playing) return;
    let frame = 0, stopped = false, followed = false;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = document.querySelector<HTMLElement>(TARGET[stage]);
        if (stopped || followed || !target || !target.getBoundingClientRect().height) return;
        const header = document.querySelector<HTMLElement>('.topbar')?.offsetHeight ?? 0;
        const bar = document.querySelector<HTMLElement>('.inline-demo-bar')?.offsetHeight ?? 0;
        window.scrollTo({ top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - header - bar - 18), behavior: 'instant' });
        followed = true; observer.disconnect();
      });
    };
    const observer = new MutationObserver(follow);
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
    follow();
    return () => { stopped = true; cancelAnimationFrame(frame); observer.disconnect(); };
  }, [runId, stage, playing]);
  return null;
}
