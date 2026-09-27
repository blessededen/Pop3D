import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useCurrent, useStore } from '../store';
import { draftData, isDirty, latestVersion } from '../domain/version';
import { getWorkflowReadiness, WORKFLOW_STEPS, type WorkflowStep } from '../domain/workflow';
import { buildDecisionSummary, PLANNING_BRIEF_FIELDS } from '../domain/planning';
import { won } from '../domain/cost';
import { Field, NumInput, TextInput } from '../components/ui';
import { CostPanel } from '../components/SidePanels';
import NewProjectDialog from '../components/NewProjectDialog';
import PlanView from '../components/PlanView';
import { canShareFiles, downloadBlob, safeGet, safeSet } from '../lib/browser';
import { exportBackup } from '../store';
import { exportPdf } from '../lib/exporters';
import DeleteProjectButton from '../components/DeleteProjectButton';

const SpacesPage = lazy(() => import('./SpacesPage'));
const ProjectPage = lazy(() => import('./ProjectPage'));
const KakaoPage = lazy(() => import('./KakaoPage'));
const SpaceReportFields = lazy(() => import('../components/SpaceReportFields'));
const ProjectReportFields = lazy(() => import('../components/ProjectReportFields'));
const STEP_INFO: Record<WorkflowStep, { title: string; detail: string; next: string }> = {
  space: { title: '공간부터 시작하세요.', detail: '크기를 입력하고 기둥과 출입구를 도면에 끌어 놓으세요.', next: '집기 배치하기' },
  layout: { title: '집기를 고르고, 배치하세요.', detail: '사용할 수량을 정하면 공간에 맞춰 배치해 드립니다.', next: '비용 확인하기' },
  review: { title: '예산 안에 들어오는지 확인하세요.', detail: '현재 배치한 수량 기준입니다. 미확인 금액은 합계에서 제외합니다.', next: '보고서 만들기' },
  report: { title: '기획안을 한 파일로.', detail: '기획 의도와 필요한 추가 정보를 정리한 뒤 PDF로 저장하세요.', next: 'PDF 내려받기' },
};
const STEP_LABEL: Record<WorkflowStep, string> = { space: '공간 설정', layout: '집기·배치', review: '비용 검토', report: '기획보고서' };
const progressKey = (id: string) => `pop3d:workflow:${id}`;
const validStep = (value: string | null): value is WorkflowStep => WORKFLOW_STEPS.some(step => step === value);
const Loading = () => <div className="flow-loading" role="status"><span className="loading-ring" />작업 화면을 불러오고 있습니다.</div>;

export default function WorkflowPage({ initialStep, initialCatalogOpen = false }: { initialStep?: WorkflowStep; initialCatalogOpen?: boolean }) {
  const { project, space, vendor } = useCurrent();
  // A legacy URL selects a step only for its entry project. Switching projects
  // resumes that project's own saved step instead of overwriting it.
  const entryProject = useRef<string | null>(project.id);
  useEffect(() => {
    if (entryProject.current !== project.id) entryProject.current = null;
  }, [project.id]);
  if (!space || !vendor) return <div className="page"><div className="panel space-recovery"><h1>프로젝트 자료를 연결해 주세요.</h1>{!space ? <SpacesPage guided /> : <p>집기 카탈로그가 없습니다. <a href="#/tools/catalog">카탈로그 관리</a>에서 자료를 복구해 주세요.</p>}</div></div>;
  return <Workflow key={project.id} initialStep={entryProject.current === project.id ? initialStep : undefined} initialCatalogOpen={entryProject.current === project.id && initialCatalogOpen} />;
}

function Workflow({ initialStep, initialCatalogOpen }: { initialStep?: WorkflowStep; initialCatalogOpen: boolean }) {
  const { project, space, vendor } = useCurrent();
  const projects = useStore(state => state.projects);
  const st = useStore.getState;
  const data = useMemo(() => draftData(project, space!, vendor!), [project, space, vendor]);
  const summary = useMemo(() => buildDecisionSummary(data), [data]);
  const readiness = useMemo(() => {
    const result = getWorkflowReadiness(data);
    return project.layoutNeedsUpdate ? { ...result, layoutReady: false, canReport: false, layoutProblems: ['선택한 집기·수량·전원 조건을 자동 배치에 반영해 주세요.', ...result.layoutProblems] } : result;
  }, [data, project.layoutNeedsUpdate]);
  const [step, setStep] = useState<WorkflowStep>(() => {
    if (initialStep) return initialStep;
    const saved = safeGet(progressKey(project.id));
    return validStep(saved) ? saved : project.placements.length ? 'layout' : 'space';
  });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [layoutConfiguring, setLayoutConfiguring] = useState(initialCatalogOpen || !project.placements.length || project.layoutNeedsUpdate !== false);
  const [exported, setExported] = useState<{ version: number; mode: string } | null>(null);
  const [showKakao, setShowKakao] = useState(false);
  const [reportDetailsOpen, setReportDetailsOpen] = useState(initialStep === 'report');
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const movePending = useRef(false);
  const position = WORKFLOW_STEPS.indexOf(step);
  const latest = latestVersion(project);
  const dirty = isDirty(project, space!, vendor!);
  const blockers = step === 'space' ? readiness.spaceProblems : readiness.layoutProblems;
  const canContinue = step === 'space' ? readiness.spaceReady : step === 'layout' ? readiness.layoutReady && !layoutConfiguring : readiness.canReport;
  const shareSupported = canShareFiles();
  const info = STEP_INFO[step];
  const ruleProblems = summary.issues.some(issue => issue.code === 'HEIGHT' || issue.code === 'AISLE') || readiness.spaceProblems.some(problem => problem.includes('통로 폭 기준'));

  useEffect(() => { st().setViewVersion(null); }, [st, project.id]);
  useEffect(() => {
    safeSet(progressKey(project.id), step);
    if (movePending.current) {
      stepHeading.current?.focus({ preventScroll: true });
      stepHeading.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      movePending.current = false;
    }
  }, [project.id, step]);

  const go = (next: WorkflowStep) => {
    if (busy) return;
    st().setViewVersion(null);
    movePending.current = true;
    setStep(next);
  };
  const next = () => {
    if (!canContinue || position >= WORKFLOW_STEPS.length - 1) return;
    go(WORKFLOW_STEPS[position + 1]);
  };
  const openReportDetails = () => {
    setReportDetailsOpen(true);
    go('report');
  };
  const download = async (mode: 'download' | 'share' = 'download') => {
    if (busy || !readiness.canReport) return;
    setBusy(true);
    try {
      st().setViewVersion(null);
      if (dirty) {
        const result = st().confirmVersion();
        if (!result.ok) { st().toast(result.message, 'warn'); return; }
      }
      const current = st().projects.find(item => item.id === project.id);
      const snapshot = current && latestVersion(current);
      if (!snapshot) throw new Error('확정할 배치가 없습니다.');
      const how = await exportPdf(snapshot, mode);
      setExported({ version: snapshot.version, mode: how });
      st().toast(how === 'shared' ? `v${snapshot.version} PDF 공유창을 열었습니다.` : `v${snapshot.version} PDF 내려받기를 요청했습니다.`);
    } catch (error) {
      st().toast(`PDF 생성 실패: ${(error as Error).message}`, 'error');
    } finally { setBusy(false); }
  };

  return <main className={`flow-workspace flow-at-${step}`}>
    <header className="flow-project-header">
      <div><span className="eyebrow">작업 중인 팝업</span><label className="flow-project-select"><span className="sr-only">작업할 팝업</span><select value={project.id} disabled={busy} onChange={event => st().switchProject(event.target.value)}>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      <div className="flow-project-actions"><span className="flow-save-state">{latest ? dirty ? `v${latest.version} 이후 수정 중` : `v${latest.version} 확정됨` : '기획안 초안'}</span><details className="flow-project-menu" onClick={event => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.open = false; }}><summary>프로젝트 관리</summary><div><button className="btn sm" disabled={busy} onClick={() => setCreating(true)}>+ 새 팝업</button><button className="btn ghost sm" disabled={busy} onClick={() => downloadBlob(new Blob([exportBackup()], { type: 'application/json' }), 'Pop3D-프로젝트-백업.json')}>백업 파일 저장</button><DeleteProjectButton project={project} disabled={busy} /></div></details></div>
    </header>

    <ol className="flow-progress" aria-label="공간에서 보고서까지 작업 순서">{WORKFLOW_STEPS.map((item, index) => <li key={item} className={item === step ? 'current' : index < position ? 'previous' : ''} aria-current={item === step ? 'step' : undefined}><span className="flow-step-number">{index < position ? '✓' : index + 1}</span><span>{STEP_LABEL[item]}</span></li>)}</ol>

    <div className="flow-stage-heading"><div><h1 ref={stepHeading} tabIndex={-1}>{info.title}</h1><p>{info.detail}</p></div></div>
    {step !== 'space' && !(step === 'layout' && layoutConfiguring) && <div className="flow-context"><div><span>공간</span><b>{data.space.width} × {data.space.depth}m</b></div><div><span>현재 배치</span><b>{summary.orderQty}개{summary.referenceQty ? ` · 참고 ${summary.referenceQty}개` : ''}</b></div><div><span>확인 + 추정 비용</span><b>{won(summary.cost.knownTotal)}</b>{summary.cost.unknownLines.length > 0 && <small>미확인 {summary.cost.unknownLines.length}건 제외</small>}</div></div>}
    {(data.space.isVirtual || data.vendor.isVirtual) && <p className="flow-demo"><span>예시 자료 포함</span>실제 공간과 업체의 규격·가격에 맞게 수정해서 사용하세요.</p>}

    <div className="flow-stage-content" aria-busy={busy}>
      <Suspense fallback={<Loading />}>
        {step === 'space' && <SpacesPage guided onEditReport={openReportDetails} />}
        {step === 'layout' && <ProjectPage guided initialCatalogOpen={initialCatalogOpen} onEditSpace={() => go('space')} onConfiguringChange={setLayoutConfiguring} />}
        {step === 'review' && <div className="flow-review-grid">
          <div><CostPanel cost={summary.cost} compact /><details className="panel flow-fees"><summary>추가 비용 수정 <span className="muted">운송 · 설치 · 철거</span></summary><div className="flow-disclosure-body">{!project.fees.length && <p className="hint">아직 등록한 부대 비용이 없습니다.</p>}{project.fees.map(fee => <div className="flow-fee-row" key={fee.id}><Field label={fee.label}><NumInput money allowNull min={0} value={fee.amount} onChange={value => st().updateProject(p => { const item = p.fees.find(entry => entry.id === fee.id); if (item) { item.amount = value; item.status = value == null ? 'unknown' : 'estimated'; } })} /></Field><Field label="가격 상태"><select className="input" value={fee.amount == null ? 'unknown' : fee.status} disabled={fee.amount == null} onChange={event => st().updateProject(p => { const item = p.fees.find(entry => entry.id === fee.id); if (item) item.status = event.target.value as typeof item.status; })}><option value="unknown">미확인</option><option value="estimated">추정</option><option value="confirmed">확인</option></select></Field></div>)}<button className="btn sm" onClick={() => st().updateProject(p => { p.fees.push({ id: crypto.randomUUID(), kind: 'other', label: '추가 비용', amount: null, status: 'unknown', basis: '', source: '', vatIncluded: null }); })}>+ 비용 항목 추가</button></div></details></div>
          <aside className="flow-review-aside"><section className="panel"><h2>이 배치에서 확인할 것</h2><div className="flow-checklist">{summary.checklist.filter(item => !['brief', 'schedule'].includes(item.id)).map(item => <div key={item.id}><span className={item.status === 'ready' ? 'ready' : 'attention'} aria-hidden>{item.status === 'ready' ? '✓' : '!'}</span><div><strong>{item.label}</strong><p>{item.detail}</p></div></div>)}</div><button className="btn" onClick={() => go('layout')}>집기·배치·예산 수정</button></section><div className="flow-plan-preview"><PlanView data={data} issues={summary.issues} editable={false} selectedId={null} onSelect={() => {}} onMoveStart={() => {}} onMove={() => {}} /></div></aside>
        </div>}
        {step === 'report' && <>
          <div className="flow-report-grid"><section className="panel flow-brief"><div className="panel-head"><h2>보고서에 담을 기획 의도</h2><span className="small muted">선택 입력 · 자동 저장</span></div><p className="hint">목적과 대상을 적어두면 보고서를 읽는 사람이 기획을 이해하기 쉬워집니다.</p>{PLANNING_BRIEF_FIELDS.slice(0, 2).map(field => <Field key={field.key} label={field.label}><TextInput multiline value={project.event.brief?.[field.key] ?? ''} placeholder={`${field.label}을 간단히 적어주세요`} onChange={value => st().updateProject(p => { p.event.brief = { objective: '', audience: '', experience: '', approval: '', ...p.event.brief, [field.key]: value }; })} /></Field>)}<details className="flow-brief-more"><summary>기획 내용 더 적기 <span className="muted">선택</span></summary>{PLANNING_BRIEF_FIELDS.slice(2).map(field => <Field key={field.key} label={field.label}><TextInput multiline value={project.event.brief?.[field.key] ?? ''} placeholder={`${field.label}을 간단히 적어주세요`} onChange={value => st().updateProject(p => { p.event.brief = { objective: '', audience: '', experience: '', approval: '', ...p.event.brief, [field.key]: value }; })} /></Field>)}</details></section>
          <aside className="panel flow-report-summary"><span className="eyebrow">기획보고서 미리보기</span><h2>{data.event.title || project.name}</h2><div className="flow-report-thumb"><PlanView data={data} issues={summary.issues} editable={false} selectedId={null} onSelect={() => {}} onMoveStart={() => {}} onMove={() => {}} /></div><dl><div><dt>배치한 주문 집기</dt><dd>{summary.orderQty}개</dd></div><div><dt>확인 + 추정 비용</dt><dd>{won(summary.cost.knownTotal)}</dd></div><div><dt>미확인 금액</dt><dd>{summary.cost.unknownLines.length}건 · 합계 제외</dd></div></dl><p>기획 요약, 배치도, 3D 참고 이미지, 품목별 비용과 확인 사항을 같은 버전으로 묶습니다.</p>{shareSupported && <button className="btn" disabled={busy || !readiness.canReport} onClick={() => void download('share')}>PDF 공유</button>}<small>현재 등록한 자료 기준 · 공식 견적서 아님</small></aside></div>
          <details className="panel report-information" open={reportDetailsOpen} onToggle={event => setReportDetailsOpen(event.currentTarget.open)}>
            <summary><span>보고서 추가 정보</span><small>행사·일정 · 자료 상태 · 배치 규칙 · 운영자 확인 기록</small></summary>
            <div className="report-information-body">
              <p className="hint">필요한 항목만 입력하세요. 내용은 자동 저장되며, 입력하지 않은 정보는 미확인으로 남습니다.</p>
              <fieldset disabled={busy} className="report-information-fields">
                <Suspense fallback={<Loading />}>
                  <ProjectReportFields project={project} />
                  <SpaceReportFields space={space!} onChange={st().upsertSpace} />
                </Suspense>
              </fieldset>
              {ruleProblems && <div className="note warn">현재 배치가 입력한 통로·높이 조건에 맞는지 확인해 주세요. 조건을 수정하면 바로 다시 검사합니다. <button type="button" className="text-button" disabled={busy} onClick={() => go('layout')}>배치 수정하기 →</button></div>}
            </div>
          </details>
          {exported && <div className="flow-export-success" role="status"><strong>v{exported.version} {exported.mode === 'shared' ? 'PDF 공유창 열림' : 'PDF 내려받기 요청 완료'}</strong><span>{dirty ? '이후 입력이 바뀌었습니다. 최신 내용은 다시 PDF로 저장하세요.' : '다른 구성을 만들려면 집기·배치 단계로 돌아가 수정하세요.'}</span><button className="btn sm" onClick={() => go('layout')}>다른 배치 만들어보기</button></div>}
          <section className="flow-optional"><button className="flow-optional-toggle" aria-expanded={showKakao} onClick={() => setShowKakao(value => !value)}><span>카카오톡 연결 <small>선택 사항 · PDF 생성 후에도 연결할 수 있어요</small></span><span aria-hidden>{showKakao ? '−' : '+'}</span></button>{showKakao && <div className="flow-inline-kakao"><KakaoPage embedded /></div>}</section>
        </>}
      </Suspense>
    </div>

    {step === 'layout' && layoutConfiguring ? <div className="layout-back"><button className="text-button" onClick={() => go('space')}>← 공간 설정으로</button></div> : <div className="flow-next-area"><div className="flow-next-copy"><span>{step === 'report' ? '마지막 단계' : `다음 · ${STEP_LABEL[WORKFLOW_STEPS[position + 1]]}`}</span><strong>{busy ? '기획보고서를 만들고 있습니다…' : !canContinue ? '아래 내용을 먼저 확인해 주세요.' : step === 'report' ? '준비한 기획안을 PDF로 저장하세요.' : '완료했다면 다음 작업이 바로 이어집니다.'}</strong>{!canContinue && <ul>{blockers.slice(0, 3).map(problem => <li key={problem}>{problem}</li>)}</ul>}{!canContinue && step !== 'space' && step !== 'layout' && <button className="text-button" onClick={() => go(readiness.spaceReady ? 'layout' : 'space')}>수정할 단계로 돌아가기 →</button>}</div><div className="flow-next-buttons">{position > 0 && <button className="btn" disabled={busy} onClick={() => go(WORKFLOW_STEPS[position - 1])}>← 이전</button>}<button className="btn primary large" disabled={busy || !canContinue} onClick={() => step === 'report' ? void download() : next()}>{busy ? 'PDF 생성 중…' : step === 'report' && latest && !dirty ? `v${latest.version} PDF 내려받기` : info.next}{step !== 'report' && <span aria-hidden> →</span>}</button></div></div>}
    {creating && <NewProjectDialog onClose={() => setCreating(false)} onCreated={() => { safeSet(progressKey(st().currentProjectId), 'space'); setStep('space'); window.location.hash = '#/'; }} />}
  </main>;
}
