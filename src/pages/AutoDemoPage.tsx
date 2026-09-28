import { useEffect, useRef, useState } from 'react';
import { createAutoDemoWorkspace } from '../domain/autoDemo';
import { demoSpaceFrame } from '../domain/demoSpaceAnimation';
import { draftData, latestVersion, layoutHash } from '../domain/version';
import type { LayoutData, Placement, VersionSnapshot } from '../domain/types';
import type { PlanResult } from '../domain/planner';
import { useStore } from '../store';
import { flushAccount, useAccount } from '../lib/account';
import { assertDemoOwner, checkDemoActive, clearDemoSession, readDemoSession, runDemoTimeline, writeDemoSession, type DemoSession } from '../lib/autoDemo';
import { emptyInlineDemo, inlineDemoRoute, isInlineDemoLocked, restoreInlineDemoSession, useInlineDemo } from '../lib/inlineDemo';
import { getKakaoStatus, KakaoReportError, postKakaoReport, reportPdfBase64 } from '../lib/kakaoReport';
import { buildPdfBlob, pdfFileName } from '../lib/exporters';
import { createDemoPlayback } from '../lib/demoPlayback';
import { validateLayout } from '../domain/validate';
import { downloadBlob } from '../lib/browser';

function calculate(data: LayoutData, signal: AbortSignal, repair = false): Promise<PlanResult> {
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
    worker.postMessage({ data, repair });
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
      useInlineDemo.getState().pause?.();
    }
  }, [hash, launchId]);

  useEffect(() => {
    if (!user || leaving || !launchId) return;
    const abort = new AbortController(); controller.current = abort;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let session: DemoSession | null = null;
    const playback = createDemoPlayback(abort.signal);
    const resume = () => { playback.resume(); useInlineDemo.setState({ paused: false, working: '', error: '' }); };
    const pause = (message = '') => {
      if (!owned() || useInlineDemo.getState().phase !== 'running') return;
      playback.pause(); useInlineDemo.setState({ paused: true, working: message });
    };
    const intervene = (event: Event) => {
      if (!(event.target instanceof Element) || event.target.closest('.inline-demo-bar')) return;
      pause();
    };
    document.addEventListener('pointerdown', intervene, true);
    document.addEventListener('keydown', intervene, true);
    document.addEventListener('input', intervene, true);
    const ready = async () => { await playback.ready(); active(); };
    const live = () => {
      active(); const store = useStore.getState();
      const project = store.projects.find(p => p.id === session?.projectId);
      const space = store.spaces.find(s => s.id === project?.spaceId);
      const vendor = store.vendors.find(v => v.id === project?.vendorId);
      if (!project || !space || !vendor) throw new Error('Project data is unavailable.');
      return draftData(project, space, vendor);
    };
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
      if (owned()) useInlineDemo.setState({ phase: 'stopped', paused: false, working: '', error: wasSending ? '시연을 중지했습니다. 이미 요청한 메시지는 카카오톡에 도착할 수 있습니다.' : '시연을 중지했습니다. 지금 화면에서 그대로 수정할 수 있습니다.' });
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
      useInlineDemo.setState({ ...emptyInlineDemo(), runId: session.id, projectId: session.projectId ?? null, phase: 'setup', working: '카카오톡 연결을 확인하고 있습니다.', stop, dismiss, pause, resume });
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
            useInlineDemo.setState({ phase: 'stopped', paused: false, working: '', error: '카카오톡 전송에 동의하면 기존 작업 화면에서 시연이 이어집니다.', reconnect }); return;
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
        let layout = live();
        let lastSpace = JSON.stringify(initialSpace), lastRequirements = JSON.stringify(initialProject.requirements);
        let customizedSpace = false, customizedRequirements = false;
        let plannedKey = '', revealed = 0;
        const planningKey = (data: LayoutData) => layoutHash({ ...data, placements: [] });
        let placements: Placement[] = [], snapshot: VersionSnapshot | undefined;
        let shownColumns = 0, shownPower = 0, shownRequirements = 0;
        const syncSpace = (columnCount: number, powerCount: number) => {
          if (shownColumns === columnCount && shownPower === powerCount) return;
          const current = live().space;
          customizedSpace ||= JSON.stringify(current) !== lastSpace;
          // Add only newly demonstrated objects; never restore a moved/deleted one.
          const columns = sample.space.columns.slice(shownColumns, columnCount).filter(p =>
            !current.columns.some(c => c.id === p.id) && p.x + p.w <= current.width && p.y + p.d <= current.depth);
          const powerPoints = sample.space.powerPoints.slice(shownPower, powerCount).filter(p =>
            !current.powerPoints.some(c => c.id === p.id) && p.x <= current.width && p.y <= current.depth);
          shownColumns = columnCount; shownPower = powerCount;
          if (customizedSpace) useInlineDemo.setState({ targetSpace: null });
          const next = { ...current, columns: [...current.columns, ...columns], powerPoints: [...current.powerPoints, ...powerPoints] };
          lastSpace = JSON.stringify(next); useStore.getState().upsertSpace(next);
        };
        const syncRequirements = (count: number) => {
          if (shownRequirements === count) return;
          customizedRequirements ||= JSON.stringify(live().requirements) !== lastRequirements;
          shownRequirements = count;
          if (customizedRequirements) return;
          const next = structuredClone(sample.project.requirements.slice(0, count));
          lastRequirements = JSON.stringify(next);
          useStore.getState().updateProject(project => { project.requirements = next; }, { undo: false });
        };
        const showProgress = (seconds: number) => {
          if (useInlineDemo.getState().paused) return;
          const stage = useInlineDemo.getState().stage;
          if (stage === 'space') {
            const frame = demoSpaceFrame(sample.space, (seconds - 8) * 1000, { column: { x: 0, y: 0 }, power: { x: 0, y: 0 } }, window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            syncSpace(frame.columnCount, frame.powerCount);
          } else if (stage === 'fixtures') syncRequirements(Math.min(sample.project.requirements.length, Math.floor(Math.max(0, seconds - 16) / 0.9) + 1));
        };
        const ensureSnapshot = async () => {
          while (true) {
            await ready(); const current = live();
            if (!current.placements.length || validateLayout(current).some(issue => issue.severity === 'error')) {
              const key = layoutHash(current);
              const result = await calculate(current, abort.signal, true); await ready();
              if (layoutHash(live()) !== key) continue;
              if (!result.ok || result.unplaced.length) { pause(result.reasons[0] || '공간이나 집기 수량을 조정한 뒤 시연 이어가기를 눌러주세요.'); continue; }
              useStore.getState().updateProject(p => { p.placements = result.placements; }, { undo: false });
            }
            useStore.getState().updateProject(p => { p.layoutNeedsUpdate = false; }, { undo: false });
            const project = useStore.getState().projects.find(p => p.id === sample.project.id)!;
            const existing = latestVersion(project);
            if (existing?.hash === layoutHash(live())) snapshot = existing;
            else {
              const result = useStore.getState().confirmVersion();
              if (!result.ok) { pause(result.message); continue; }
              snapshot = latestVersion(useStore.getState().projects.find(p => p.id === sample.project.id)!);
            }
            await flushAccount(); await ready();
            if (snapshot?.hash === layoutHash(live())) return;
          }
        };
        const ensurePdf = async () => {
          while (true) {
            await ensureSnapshot(); await ready();
            const current = snapshot!;
            if (pdf.current?.snapshot.hash === current.hash) return;
            const blob = await buildPdfBlob(current); await ready();
            if (layoutHash(live()) !== current.hash) continue;
            revokePdf(); pdf.current = { blob, snapshot: current }; objectUrl.current = URL.createObjectURL(blob);
            useInlineDemo.setState({ pdfUrl: objectUrl.current, download }); return;
          }
        };
        useInlineDemo.setState({ projectId: sample.project.id, phase: 'running', targetSpace: sample.space, error: '', working: '' });
        const start = playback.time();
        ticker = setInterval(() => {
          try { active(); const elapsed = (playback.time() - start) / 1000; useInlineDemo.setState({ elapsed }); showProgress(elapsed); }
          catch { stop(); }
        }, 200);
        await runDemoTimeline({
          signal: abort.signal, now: playback.time, wait: playback.wait,
          stage: next => {
            active();
            if (next === 'fixtures') syncSpace(sample.space.columns.length, sample.space.powerPoints.length);
            if (next === 'layout') syncRequirements(sample.project.requirements.length);
            useInlineDemo.setState({ stage: next, working: next === 'layout' ? '출입구·기둥·통로·전원 조건을 반영해 자동 배치합니다.' : next === 'pdf' ? '같은 작업의 기획보고서 PDF를 준비합니다.' : next === 'send' ? '나와의 채팅으로 보고서 링크를 보내고 있습니다.' : '' });
            showProgress((playback.time() - start) / 1000); navigate(inlineDemoRoute(next));
          },
          plan: async () => {
            while (true) {
              await ready(); layout = live(); const key = layoutHash(layout);
              const result = await calculate(layout, abort.signal, layout.placements.length > 0);
              await ready();
              if (layoutHash(live()) !== key) continue;
              if (!result.ok || result.unplaced.length) { pause(result.reasons[0] || '공간이나 집기 수량을 조정한 뒤 시연 이어가기를 눌러주세요.'); continue; }
              placements = result.placements; plannedKey = planningKey(layout); revealed = 0;
              useStore.getState().updateProject(p => { p.layoutNeedsUpdate = false; }, { undo: false });
              return placements.length;
            }
          },
          reveal: count => {
            active();
            const additions = placements.slice(revealed, count); revealed = count;
            if (planningKey(live()) !== plannedKey) return;
            useStore.getState().updateProject(project => {
              for (const item of additions) if (!project.placements.some(p => p.id === item.id)) project.placements.push(item);
            }, { undo: false });
          },
          save: async () => { await ensureSnapshot(); },
          buildPdf: async () => { await ensurePdf(); },
          send: async () => {
            while (true) {
              await ready(); await ensurePdf(); await ready();
              if (!pdf.current || !snapshot) throw new Error('PDF unavailable.');
              const sendingPdf = pdf.current;
              const pdfBase64 = await reportPdfBase64(sendingPdf.blob);
              const fresh = await getKakaoStatus(AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]));
              await ready();
              if (layoutHash(live()) !== sendingPdf.snapshot.hash) continue;
              if (!fresh.canSend || !fresh.csrfToken) throw new KakaoReportError(fresh.reason || 'reconnect_required');
              session!.phase = 'sending'; persist(); useInlineDemo.setState({ phase: 'sending', paused: false, working: `v${sendingPdf.snapshot.version} 보고서를 전송합니다. 지금부터 수정한 내용은 다음 보고서에 반영됩니다.` });
              const sent = await postKakaoReport({ projectId: sample.project.id, version: sendingPdf.snapshot.version, pdfBase64, requestId: session!.id }, user.id, fresh.csrfToken);
              session!.phase = 'done'; session!.receipt = sent; persist();
              if (owned() && useAccount.getState().user?.id === user.id) useInlineDemo.setState({ receipt: sent });
              return sent;
            }
          },
          received: sent => { active(); useInlineDemo.setState({ receipt: sent, working: '카카오톡 전송 완료 · 나와의 채팅을 확인하세요.' }); },
        });
        active(); useInlineDemo.setState({ phase: 'done', paused: false, elapsed: Math.max(60, (playback.time() - start) / 1000), working: '' });
      } catch (failure) {
        if (!abort.signal.aborted && owned()) {
          if (session.phase !== 'sending' && session.phase !== 'done') { session.phase = 'stopped'; persist(); }
          useInlineDemo.setState({ phase: 'stopped', paused: false, error: failure instanceof Error ? failure.message : '시연을 완료하지 못했습니다.', working: '' });
        }
      } finally { clearInterval(ticker); }
    })(); }, 0);
    return () => {
      document.removeEventListener('pointerdown', intervene, true);
      document.removeEventListener('keydown', intervene, true);
      document.removeEventListener('input', intervene, true);
      clearTimeout(kickoff); clearInterval(ticker); abort.abort(); revokePdf();
      if (owned()) useInlineDemo.setState(emptyInlineDemo());
    };
  }, [user?.id, leaving, launchId]);
  return null;
}
