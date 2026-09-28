import { useEffect, useRef, useState } from 'react';
import AutoDemoStage from '../components/AutoDemoStage';
import AutoDemoStart from '../components/AutoDemoStart';
import { createAutoDemoWorkspace } from '../domain/autoDemo';
import { draftData, latestVersion } from '../domain/version';
import type { LayoutData, Placement, VersionSnapshot } from '../domain/types';
import type { PlanResult } from '../domain/planner';
import { useStore } from '../store';
import { flushAccount, useAccount } from '../lib/account';
import { assertDemoOwner, checkDemoActive, clearDemoSession, readDemoSession, runDemoTimeline, writeDemoSession, type DemoSession, type DemoStage } from '../lib/autoDemo';
import { getKakaoStatus, KakaoReportError, postKakaoReport, reportPdfBase64, type KakaoReportReceipt } from '../lib/kakaoReport';
import { buildPdfBlob, pdfFileName } from '../lib/exporters';
import { downloadBlob } from '../lib/browser';

function calculate(data: LayoutData, signal: AbortSignal): Promise<PlanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { worker.terminate(); clearTimeout(timeout); signal.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(new DOMException('시연 중지', 'AbortError')); };
    const timeout = setTimeout(() => { finish(); reject(new Error('배치 계산이 지연되고 있습니다. 시연을 다시 시작해 주세요.')); }, 30_000);
    worker.onmessage = (event: MessageEvent<{ result?: PlanResult; error?: string }>) => {
      finish(); event.data.result ? resolve(event.data.result) : reject(new Error(event.data.error || '배치를 계산하지 못했습니다.'));
    };
    worker.onerror = () => { finish(); reject(new Error('배치를 계산하지 못했습니다. 시연을 다시 시작해 주세요.')); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    worker.postMessage({ data, repair: false });
  });
}

export default function AutoDemoPage() {
  const { user, leaving } = useAccount();
  const [stage, setStage] = useState<DemoStage>('brief');
  const [elapsed, setElapsed] = useState(0);
  const [data, setData] = useState<LayoutData | null>(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [receipt, setReceipt] = useState<KakaoReportReceipt>();
  const [error, setError] = useState('');
  const [working, setWorking] = useState('카카오톡 연결을 확인하고 있습니다.');
  const [setup, setSetup] = useState(true);
  const [connectRequired, setConnectRequired] = useState(false);
  const [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const pdf = useRef<{ blob: Blob; snapshot: VersionSnapshot } | null>(null);
  const objectUrl = useRef('');
  const sessionRef = useRef<DemoSession | null>(null);
  const stop = () => {
    controller.current?.abort();
    const session = sessionRef.current;
    const wasSending = session?.phase === 'sending';
    if (session && session.phase !== 'done' && !wasSending) { session.phase = 'stopped'; writeDemoSession(session); }
    setWorking(''); setError(wasSending ? '시연을 중지했습니다. 이미 요청한 메시지는 카카오톡에 도착할 수 있습니다.' : '시연을 중지했습니다. 생성한 예시 프로젝트는 내 작업에 보관됩니다.');
  };
  const openProject = () => {
    controller.current?.abort();
    const session = sessionRef.current;
    if (session?.projectId && useStore.getState().projects.some(project => project.id === session.projectId)) useStore.getState().switchProject(session.projectId);
    const project = useStore.getState().projects.find(item => item.id === session?.projectId);
    clearDemoSession(); window.location.hash = project ? (project.versions.length ? '#/report' : '#/layout') : '#/';
  };
  const download = () => { if (pdf.current) downloadBlob(pdf.current.blob, pdfFileName(pdf.current.snapshot)); };
  useEffect(() => {
    if (!user || leaving) return;
    const abort = new AbortController(); controller.current = abort;
    let ticker: ReturnType<typeof setInterval> | undefined;
    const active = () => { checkDemoActive(abort.signal); assertDemoOwner(sessionRef.current!, useAccount.getState().user?.id ?? null); };
    // Deferring once avoids a duplicate launch during React StrictMode's mount probe.
    const kickoff = setTimeout(() => { void (async () => {
      const session = readDemoSession(); sessionRef.current = session;
      if (!session) { setWorking(''); setError(''); return; }
      try {
        assertDemoOwner(session, user.id);
        session.owner = user.id;
        const persist = () => { if (readDemoSession()?.id === session.id) writeDemoSession(session); };
        const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
        const callbackError = query.get('error') || query.get('account_error');
        if (callbackError) { session.phase = 'stopped'; persist(); throw new KakaoReportError(callbackError); }
        if (session.phase === 'done' && session.receipt) {
          setReceipt(session.receipt); setStage('done'); setElapsed(60); setSetup(false); setWorking('');
          const store = useStore.getState(), project = store.projects.find(item => item.id === session.projectId);
          const space = store.spaces.find(item => item.id === project?.spaceId), vendor = store.vendors.find(item => item.id === project?.vendorId);
          if (project && space && vendor) setData(draftData(project, space, vendor));
          return;
        }
        if (!['setup', 'authorizing'].includes(session.phase)) {
          setWorking(''); setError(session.phase === 'sending' ? '전송 도중 화면이 다시 열렸습니다. 중복 전송을 막기 위해 멈췄습니다. 카카오톡 나와의 채팅을 먼저 확인해 주세요.' : '중단된 시연입니다. 생성한 프로젝트에서 이어서 작업하거나 새 시연을 시작할 수 있습니다.'); return;
        }
        setWorking('카카오톡 연결을 확인하고 있습니다.');
        const status = await getKakaoStatus(AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)])); active();
        if (!status.canSend) {
          if (!status.configured || !status.publicUrlReady || ['invalid_redirect', 'permission_check_failed', 'connection_busy', 'temporarily_unavailable'].includes(status.reason || '')) throw new KakaoReportError(status.reason || 'not_configured');
          if (session.phase === 'authorizing') { setConnectRequired(true); setWorking(''); setError('나와의 채팅 전송 동의를 마치면 자동 시연이 시작됩니다.'); return; }
          await flushAccount(); active(); session.phase = 'authorizing'; persist();
          window.location.assign('/api/auth/kakao/start?returnTo=demo'); return;
        }
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/demo`);
        const sample = createAutoDemoWorkspace(session.id, new Date(session.createdAt));
        active();
        if (useStore.getState().projects.some(project => project.id === sample.project.id)) throw new Error('이미 생성된 시연 프로젝트가 있습니다. 프로젝트에서 이어서 작업해 주세요.');
        session.projectId = sample.project.id; session.phase = 'running'; persist();
        useStore.setState(store => ({ spaces: [...store.spaces, sample.space], vendors: [...store.vendors, sample.vendor], projects: [...store.projects, sample.project], currentProjectId: sample.project.id, selectedId: null, viewVersion: null, lastPlan: null, undoStack: [] }));
        let layout = draftData(sample.project, sample.space, sample.vendor), placements: Placement[] = [], snapshot: VersionSnapshot | undefined;
        setData(layout); setSetup(false); setError(''); setWorking(''); setConnectRequired(false);
        const start = performance.now(); ticker = setInterval(() => setElapsed((performance.now() - start) / 1000), 200);
        await runDemoTimeline({
          signal: abort.signal,
          stage: next => { active(); setStage(next); setWorking(next === 'layout' ? '출입구·기둥·통로·전원 조건을 반영해 배치하고 있습니다.' : next === 'pdf' ? '평면도와 3D를 기획보고서로 만들고 있습니다.' : next === 'send' ? '나와의 채팅으로 실제 보고서 링크를 보내고 있습니다.' : ''); },
          plan: async () => {
            const result = await calculate(layout, abort.signal); active();
            if (!result.ok || result.unplaced.length) throw new Error(result.reasons[0] || '선택한 집기를 모두 배치하지 못했습니다.');
            placements = result.placements; return placements.length;
          },
          reveal: count => { active(); setData({ ...layout, placements: placements.slice(0, count) }); },
          save: async () => {
            active();
            const store = useStore.getState();
            if (store.currentProjectId !== sample.project.id) throw new Error('작업 중인 프로젝트가 바뀌어 시연을 중지했습니다.');
            store.updateProject(project => { project.placements = placements; project.layoutNeedsUpdate = false; });
            const result = useStore.getState().confirmVersion(); if (!result.ok) throw new Error(result.message);
            snapshot = latestVersion(useStore.getState().projects.find(project => project.id === sample.project.id)!);
            layout = { ...layout, placements }; setData(layout);
            await flushAccount(); active();
          },
          buildPdf: async () => {
            active(); if (!snapshot) throw new Error('보고서 버전을 저장하지 못했습니다.');
            const blob = await buildPdfBlob(snapshot); active();
            pdf.current = { blob, snapshot }; objectUrl.current = URL.createObjectURL(blob); setPdfUrl(objectUrl.current);
          },
          send: async () => {
            active(); if (!pdf.current || !snapshot) throw new Error('PDF를 준비하지 못했습니다.');
            const pdfBase64 = await reportPdfBase64(pdf.current.blob); active();
            const fresh = await getKakaoStatus(AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)])); active();
            if (!fresh.canSend || !fresh.csrfToken) throw new KakaoReportError(fresh.reason || 'reconnect_required');
            session.phase = 'sending'; persist();
            const sent = await postKakaoReport({ projectId: sample.project.id, version: snapshot.version, pdfBase64, requestId: session.id }, user.id, fresh.csrfToken);
            // Keep a genuine server receipt even if the user leaves while the request is in flight.
            session.phase = 'done'; session.receipt = sent; persist(); return sent;
          },
          received: sent => { setReceipt(sent); setWorking('카카오톡 전송 완료 · 휴대폰의 나와의 채팅을 확인하세요.'); },
        });
        setElapsed(Math.max(60, (performance.now() - start) / 1000)); setWorking('');
      } catch (failure) {
        if (!abort.signal.aborted) {
          if (session.phase !== 'sending' && session.phase !== 'done') { session.phase = 'stopped'; writeDemoSession(session); }
          setError(failure instanceof Error ? failure.message : '시연을 완료하지 못했습니다.'); setWorking('');
        }
      } finally { clearInterval(ticker); }
    })(); }, 0);
    return () => { clearTimeout(kickoff); clearInterval(ticker); abort.abort(); if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; } };
  }, [user?.id, leaving, retry]);
  if (setup) return <main className="demo-setup"><span className="eyebrow">POP3D · AUTO DEMO</span><h1>1분 뒤, 기획서를 내 카톡으로.</h1><p>카카오 로그인·전송 동의를 마치면 기획부터 PDF까지 자동으로 이어집니다.</p>{working && <p role="status">{working}</p>}{error && <p role="alert">{error}</p>}{!working && !readDemoSession() && <AutoDemoStart />}
    <div className="demo-setup-actions">{connectRequired && <button className="btn primary" onClick={() => { window.location.assign('/api/auth/kakao/start?returnTo=demo'); }}>카카오톡 전송 동의하고 시작</button>}{error && !connectRequired && <AutoDemoStart compact />}<button className="btn" onClick={openProject}>내 작업으로</button>{working && <button className="btn" onClick={stop}>시연 중지</button>}{!error && !working && readDemoSession()?.phase === 'setup' && <button className="btn primary" onClick={() => setRetry(value => value + 1)}>연결 다시 확인</button>}</div></main>;
  return <><AutoDemoStage stage={stage} elapsed={elapsed} data={data} pdfUrl={pdfUrl || undefined} receipt={receipt} error={error} working={working} onCancel={stop} onDownload={download} onOpenProject={openProject} />{stage === 'done' && !pdf.current && receipt && <div className="demo-setup-actions"><a className="btn" href={receipt.url}>보낸 보고서에서 PDF 받기</a></div>}</>;
}
