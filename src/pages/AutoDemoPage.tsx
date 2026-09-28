import { useEffect, useRef, useState } from 'react';
import { createAutoDemoWorkspace } from '../domain/autoDemo';
import { demoSpaceFrame } from '../domain/demoSpaceAnimation';
import { draftData, latestVersion } from '../domain/version';
import type { LayoutData, Placement, VersionSnapshot } from '../domain/types';
import type { PlanResult } from '../domain/planner';
import { useStore } from '../store';
import { flushAccount, useAccount } from '../lib/account';
import { assertDemoOwner, checkDemoActive, clearDemoSession, readDemoSession, runDemoTimeline, writeDemoSession, type DemoSession } from '../lib/autoDemo';
import { emptyInlineDemo, inlineDemoRoute, isInlineDemoLocked, restoreInlineDemoSession, useInlineDemo } from '../lib/inlineDemo';
import { getKakaoStatus, KakaoReportError, postKakaoReport, reportPdfBase64 } from '../lib/kakaoReport';
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

/** Owns the run across normal workflow routes; it never renders a separate demo page. */
export default function AutoDemoPage({ hash }: { hash: string }) {
  const { user, leaving } = useAccount();
  const [launchId, setLaunchId] = useState(() => {
    const session = readDemoSession();
    return hash.split('?')[0] === '#/demo' || restoreInlineDemoSession(session, useStore.getState().currentProjectId) ? session?.id ?? null : null;
  });
  const controller = useRef<AbortController | null>(null);
  const expectedRoute = useRef('');
  const pdf = useRef<{ blob: Blob; snapshot: VersionSnapshot } | null>(null);
  const objectUrl = useRef('');
  const navigate = (route: string) => {
    expectedRoute.current = route;
    if (window.location.hash === route) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${route}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  const revokePdf = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = ''; pdf.current = null;
  };

  useEffect(() => {
    const route = hash.split('?')[0], session = readDemoSession();
    if (route === '#/demo' && session && session.id !== launchId) {
      controller.current?.abort(); setLaunchId(session.id);
    } else if (route !== '#/demo' && expectedRoute.current && route !== expectedRoute.current && isInlineDemoLocked(useInlineDemo.getState().phase)) {
      useInlineDemo.getState().stop?.();
    }
  }, [hash, launchId]);

  useEffect(() => {
    if (!user || leaving || !launchId) return;
    const abort = new AbortController(); controller.current = abort;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let session: DemoSession | null = null;
    const owned = () => useInlineDemo.getState().runId === launchId;
    const persist = () => { if (session && readDemoSession()?.id === session.id) writeDemoSession(session); };
    const active = () => {
      checkDemoActive(abort.signal);
      assertDemoOwner(session!, useAccount.getState().user?.id ?? null);
      if (!owned() || (session?.projectId && useStore.getState().currentProjectId !== session.projectId)) throw new Error('작업 중인 프로젝트가 바뀌어 시연을 중지했습니다.');
    };
    const stop = () => {
      abort.abort(); clearInterval(ticker);
      const wasSending = session?.phase === 'sending';
      if (session && session.phase !== 'done' && !wasSending) { session.phase = 'stopped'; persist(); }
      if (owned()) useInlineDemo.setState({ phase: 'stopped', working: '', error: wasSending ? '시연을 중지했습니다. 이미 요청한 메시지는 카카오톡에 도착할 수 있습니다.' : '시연을 중지했습니다. 지금 화면에서 그대로 수정할 수 있습니다.' });
    };
    const dismiss = () => {
      abort.abort(); clearInterval(ticker);
      if (readDemoSession()?.id === launchId) clearDemoSession();
      revokePdf();
      if (owned()) useInlineDemo.setState(emptyInlineDemo());
      setLaunchId(null);
      if (window.location.hash.split('?')[0] === '#/demo') navigate('#/');
    };
    const download = () => { if (pdf.current) downloadBlob(pdf.current.blob, pdfFileName(pdf.current.snapshot)); };
    // Defer once so StrictMode's mount probe cannot start a second run.
    const kickoff = setTimeout(() => { void (async () => {
      session = readDemoSession();
      if (!session || session.id !== launchId) return;
      revokePdf();
      useInlineDemo.setState({ ...emptyInlineDemo(), runId: session.id, projectId: session.projectId ?? null, phase: 'setup', working: '카카오톡 연결을 확인하고 있습니다.', stop, dismiss });
      expectedRoute.current = window.location.hash.split('?')[0];
      try {
        assertDemoOwner(session, user.id); session.owner = user.id;
        const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
        const callbackError = query.get('error') || query.get('account_error');
        if (callbackError) throw new KakaoReportError(callbackError);
        if (session.phase === 'done' && session.receipt) {
          const project = useStore.getState().projects.find(item => item.id === session!.projectId);
          if (project) useStore.getState().switchProject(project.id);
          useInlineDemo.setState({ phase: 'done', stage: 'done', elapsed: 60, receipt: session.receipt, working: '', download: null });
          navigate('#/report'); return;
        }
        if (!['setup', 'authorizing'].includes(session.phase)) {
          const project = useStore.getState().projects.find(item => item.id === session!.projectId);
          if (project) useStore.getState().switchProject(project.id);
          throw new Error(session.phase === 'sending' ? '전송 중 화면이 다시 열렸습니다. 자동 재전송하지 않습니다. 나와의 채팅을 확인해 주세요.' : '중단된 시연입니다. 현재 프로젝트를 수정하거나 새 시연을 시작할 수 있습니다.');
        }
        const status = await getKakaoStatus(AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)])); active();
        if (!status.canSend) {
          if (!status.configured || !status.publicUrlReady || ['invalid_redirect', 'permission_check_failed', 'connection_busy', 'temporarily_unavailable'].includes(status.reason || '')) throw new KakaoReportError(status.reason || 'not_configured');
          const reconnect = () => { window.location.assign('/api/auth/kakao/start?returnTo=demo'); };
          if (session.phase === 'authorizing') {
            useInlineDemo.setState({ phase: 'stopped', working: '', error: '카카오톡 전송에 동의하면 기존 작업 화면에서 시연이 이어집니다.', reconnect }); return;
          }
          await flushAccount(); active(); session.phase = 'authorizing'; persist(); reconnect(); return;
        }
        const sample = createAutoDemoWorkspace(session.id, new Date(session.createdAt));
        active();
        if (useStore.getState().projects.some(project => project.id === sample.project.id)) throw new Error('이미 생성된 시연 프로젝트가 있습니다. 현재 작업에서 이어서 수정해 주세요.');
        session.projectId = sample.project.id; session.phase = 'running'; persist();
        const initialSpace = { ...sample.space, columns: [], powerPoints: [] };
        const initialProject = { ...sample.project, requirements: [] };
        useStore.setState(store => ({ spaces: [...store.spaces, initialSpace], vendors: [...store.vendors, sample.vendor], projects: [...store.projects, initialProject], currentProjectId: sample.project.id, selectedId: null, viewVersion: null, lastPlan: null, undoStack: [] }));
        const layout = draftData(sample.project, sample.space, sample.vendor);
        let placements: Placement[] = [], snapshot: VersionSnapshot | undefined;
        let shownColumns = 0, shownPower = 0, shownRequirements = 0;
        const syncSpace = (columnCount: number, powerCount: number) => {
          if (shownColumns === columnCount && shownPower === powerCount) return;
          shownColumns = columnCount; shownPower = powerCount;
          useStore.getState().upsertSpace({ ...sample.space, columns: sample.space.columns.slice(0, columnCount), powerPoints: sample.space.powerPoints.slice(0, powerCount) });
        };
        const syncRequirements = (count: number) => {
          if (shownRequirements === count) return;
          shownRequirements = count;
          useStore.getState().updateProject(project => { project.requirements = structuredClone(sample.project.requirements.slice(0, count)); }, { undo: false });
        };
        const showProgress = (seconds: number) => {
          const stage = useInlineDemo.getState().stage;
          if (stage === 'space') {
            const frame = demoSpaceFrame(sample.space, (seconds - 8) * 1000, { column: { x: 0, y: 0 }, power: { x: 0, y: 0 } }, window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            syncSpace(frame.columnCount, frame.powerCount);
          } else if (stage === 'fixtures') syncRequirements(Math.min(sample.project.requirements.length, Math.floor(Math.max(0, seconds - 16) / 0.9) + 1));
        };
        useInlineDemo.setState({ projectId: sample.project.id, phase: 'running', targetSpace: sample.space, error: '', working: '' });
        const start = performance.now();
        ticker = setInterval(() => {
          try { active(); const elapsed = (performance.now() - start) / 1000; useInlineDemo.setState({ elapsed }); showProgress(elapsed); }
          catch { stop(); }
        }, 200);
        await runDemoTimeline({
          signal: abort.signal,
          stage: next => {
            active();
            if (next === 'fixtures') syncSpace(sample.space.columns.length, sample.space.powerPoints.length);
            if (next === 'layout') syncRequirements(sample.project.requirements.length);
            useInlineDemo.setState({ stage: next, working: next === 'layout' ? '출입구·기둥·통로·전원 조건을 반영해 자동 배치합니다.' : next === 'pdf' ? '같은 작업의 기획보고서 PDF를 준비합니다.' : next === 'send' ? '나와의 채팅으로 보고서 링크를 보내고 있습니다.' : '' });
            showProgress((performance.now() - start) / 1000); navigate(inlineDemoRoute(next));
          },
          plan: async () => {
            const result = await calculate(layout, abort.signal); active();
            if (!result.ok || result.unplaced.length) throw new Error(result.reasons[0] || '선택한 집기를 모두 배치하지 못했습니다.');
            placements = result.placements; return placements.length;
          },
          reveal: count => { active(); useStore.getState().updateProject(project => { project.placements = placements.slice(0, count); }, { undo: false }); },
          save: async () => {
            active(); useStore.getState().updateProject(project => { project.placements = placements; project.layoutNeedsUpdate = false; }, { undo: false });
            const result = useStore.getState().confirmVersion(); if (!result.ok) throw new Error(result.message);
            snapshot = latestVersion(useStore.getState().projects.find(project => project.id === sample.project.id)!);
            await flushAccount(); active();
          },
          buildPdf: async () => {
            active(); if (!snapshot) throw new Error('보고서 버전을 저장하지 못했습니다.');
            const blob = await buildPdfBlob(snapshot); active();
            pdf.current = { blob, snapshot }; objectUrl.current = URL.createObjectURL(blob);
            useInlineDemo.setState({ pdfUrl: objectUrl.current, download });
          },
          send: async () => {
            active(); if (!pdf.current || !snapshot) throw new Error('PDF를 준비하지 못했습니다.');
            const pdfBase64 = await reportPdfBase64(pdf.current.blob); active();
            const fresh = await getKakaoStatus(AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)])); active();
            if (!fresh.canSend || !fresh.csrfToken) throw new KakaoReportError(fresh.reason || 'reconnect_required');
            session!.phase = 'sending'; persist(); useInlineDemo.setState({ phase: 'sending' });
            const sent = await postKakaoReport({ projectId: sample.project.id, version: snapshot.version, pdfBase64, requestId: session!.id }, user.id, fresh.csrfToken);
            // Preserve a real receipt after cancellation, without restarting or repeating delivery.
            session!.phase = 'done'; session!.receipt = sent; persist();
            if (owned() && useAccount.getState().user?.id === user.id) useInlineDemo.setState({ receipt: sent });
            return sent;
          },
          received: sent => { active(); useInlineDemo.setState({ receipt: sent, working: '카카오톡 전송 완료 · 나와의 채팅을 확인하세요.' }); },
        });
        active(); useInlineDemo.setState({ phase: 'done', elapsed: Math.max(60, (performance.now() - start) / 1000), working: '' });
      } catch (failure) {
        if (!abort.signal.aborted && owned()) {
          if (session.phase !== 'sending' && session.phase !== 'done') { session.phase = 'stopped'; persist(); }
          useInlineDemo.setState({ phase: 'stopped', error: failure instanceof Error ? failure.message : '시연을 완료하지 못했습니다.', working: '' });
        }
      } finally { clearInterval(ticker); }
    })(); }, 0);
    return () => {
      clearTimeout(kickoff); clearInterval(ticker); abort.abort(); revokePdf();
      if (owned()) useInlineDemo.setState(emptyInlineDemo());
    };
  }, [user?.id, leaving, launchId]);
  return null;
}
