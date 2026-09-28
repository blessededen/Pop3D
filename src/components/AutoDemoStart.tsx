import { useEffect, useRef, useState } from 'react';
import { useAccount, flushAccount } from '../lib/account';
import { newDemoSession, writeDemoSession } from '../lib/autoDemo';
import { useStore } from '../store';
import './AutoDemoStart.css';

export default function AutoDemoStart({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { setOpen(false); return; }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? []);
      if (!buttons.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)!.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [open, busy]);
  const start = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const owner = useAccount.getState().user?.id ?? null;
      if (owner) await flushAccount();
      if ((useAccount.getState().user?.id ?? null) !== owner) throw new Error('계정이 바뀌었습니다. 다시 시작해 주세요.');
      const session = newDemoSession(owner, owner ? useStore.getState().currentProjectId : '');
      writeDemoSession(session);
      if (owner) { window.location.hash = `#/demo?run=${session.id}`; setOpen(false); }
      else window.location.assign('/api/account/kakao/start?returnTo=demo');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const details = <>
    <span className="eyebrow">STEP BY STEP DEMO</span>
    <h2>팝업 기획부터 내 카톡까지.</h2>
    <p>지금 사용하는 작업 화면에서 공간 설정 · 집기 선택 · 자동 배치 · 3D · PDF를 <b>다음을 누를 때마다 한 장면씩</b> 보여줍니다. 마지막에 카카오톡으로 보내기를 누르면 내 채팅에 보고서 링크가 도착합니다.</p>
    <small>발표 중 원하는 만큼 머물고 직접 수정할 수 있습니다. 시간이 지나도 다음 장면으로 넘어가지 않습니다. 기존 프로젝트는 보관되고 보고서 링크는 7일간 열 수 있습니다.</small>
    {error && <p role="alert" className="note error">{error}</p>}
    <button className="btn primary large" disabled={busy || disabled} onClick={() => void start()}>{busy ? '시연 준비 중…' : '▶ 단계별 시연 시작'}</button>
  </>;
  return compact ? <>
    <button type="button" className="btn sm demo-trigger" disabled={disabled} onClick={() => setOpen(true)}>▶ 단계별 시연</button>
    {open && <div className="demo-start-overlay"><section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="demo-start-title" className="demo-start-card"><h1 id="demo-start-title" className="sr-only">단계별 시연</h1><button autoFocus className="demo-start-close" aria-label="시연 안내 닫기" disabled={busy} onClick={() => setOpen(false)}>✕</button>{details}</section></div>}
  </> : <section className="demo-start-inline">{details}</section>;
}
