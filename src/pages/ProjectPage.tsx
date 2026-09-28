import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import ConditionsPanel from '../components/ConditionsPanel';
import GuidedLayoutWorkspace from '../components/GuidedLayoutWorkspace';
import PlanView from '../components/PlanView';
import { CostPanel, Inspector, IssuesPanel, VersionsPanel } from '../components/SidePanels';
import { computeCost, won } from '../domain/cost';
import { validateLayout } from '../domain/validate';
import { draftData, isDirty, latestVersion, snapshotData } from '../domain/version';
import type { Highlight } from '../three/builders';

const ThreeView = lazy(() => import('../components/ThreeView'));
const CatalogPage = lazy(() => import('./CatalogPage'));
import { canShareFiles, downloadBlob, safeGet, safeSet } from '../lib/browser';
import { useRefModel } from '../lib/useRefModel';
import { exportPdf } from '../lib/exporters';
import { exportBackup, importBackup, useCurrent, useStore } from '../store';
import { useInlineDemo } from '../lib/inlineDemo';

type ViewMode = 'split' | 'plan' | '3d';

interface ProjectPageProps {
  guided?: boolean;
  onEditSpace?: () => void;
  initialCatalogOpen?: boolean;
  onConfiguringChange?: (value: boolean) => void;
}

export default function ProjectPage({ guided = false, onEditSpace, initialCatalogOpen = false, onConfiguringChange }: ProjectPageProps = {}) {
  const { space, vendor } = useCurrent();
  if (!space || !vendor) {
    return (
      <div className="page">
        <div className="note error">
          이 프로젝트의 {space ? '업체 카탈로그' : '공간'}를 찾을 수 없습니다. {guided ? <button type="button" className="btn sm" onClick={onEditSpace}>공간 설정 확인</button> : <><a href="#/spaces">공간 자료</a>나 <a href="#/catalog">카탈로그</a>를 확인하세요.</>}
        </div>
      </div>
    );
  }
  if (guided) return <GuidedLayoutWorkspace initialCatalogOpen={initialCatalogOpen} onEditSpace={onEditSpace} onConfiguringChange={onConfiguringChange} />;
  return <ProjectWorkspace />;
}

function ProjectWorkspace({ guided = false, onEditSpace, initialCatalogOpen = false }: ProjectPageProps) {
  const { project, space: sp, vendor: vd } = useCurrent();
  const space = sp!;
  const vendor = vd!;
  const viewVersion = useStore((s) => s.viewVersion);
  const selectedId = useStore((s) => s.selectedId);
  const lastPlan = useStore((s) => s.lastPlan);
  const st = useStore.getState;
  const [showCatalog, setShowCatalog] = useState(initialCatalogOpen || (guided && project.placements.length === 0));
  useEffect(() => { if (initialCatalogOpen) setShowCatalog(true); }, [initialCatalogOpen]);

  const viewing = viewVersion != null ? project.versions.find((v) => v.version === viewVersion) : undefined;
  const readOnly = !!viewing;
  const data = useMemo(() => (viewing ? snapshotData(viewing) : draftData(project, space, vendor)), [viewing, project, space, vendor]);
  const issues = useMemo(() => validateLayout(data), [data]);
  const cost = useMemo(() => computeCost(data), [data]);
  const dirty = useMemo(() => isDirty(project, space, vendor), [project, space, vendor]);
  const latest = latestVersion(project);
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const hasSelection = data.placements.some((placement) => placement.id === selectedId);
  const displayProject = viewing ? {
    ...project,
    name: viewing.projectName,
    spaceId: viewing.space.id,
    vendorId: viewing.vendor.id,
    event: viewing.event,
    budget: viewing.budget,
    requirements: viewing.requirements,
    placements: viewing.placements,
    fees: viewing.fees,
    memo: viewing.memo,
  } : project;
  const displayVendor = viewing ? { ...viewing.vendor, services: viewing.fees } : vendor;
  const pdfDisabled = data.placements.length === 0 || (!readOnly && errorCount > 0);
  const pdfLabel = viewing ? `v${viewing.version} 기획보고서 PDF` : dirty ? '확정 + 기획보고서 PDF' : `v${latest?.version ?? 1} 기획보고서 PDF`;
  const pdfHelp = data.placements.length === 0
    ? '집기를 배치하면 기획보고서를 만들 수 있습니다.'
    : !readOnly && errorCount > 0
      ? `배치 오류 ${errorCount}건을 해결하면 현재 수정본의 PDF를 만들 수 있습니다.`
      : viewing ? '지금 보고 있는 확정 버전으로 PDF를 만듭니다.' : '현재 배치·비용·검토 사항을 하나의 보고서로 저장합니다.';

  const highlight = useMemo(() => {
    const m = new Map<string, Highlight>();
    for (const i of issues) {
      for (const id of i.placementIds) {
        if (i.severity === 'error') m.set(id, 'error');
        else if (i.severity === 'warning' && !m.has(id)) m.set(id, 'warning');
      }
    }
    if (selectedId) m.set(selectedId, 'selected');
    return m;
  }, [issues, selectedId]);

  const [mode, setMode] = useState<ViewMode>(() => (safeGet('pop3d:view') as ViewMode) || (window.innerWidth > 1500 ? 'split' : 'plan'));
  const visibleMode = guided && mode === 'split' ? 'plan' : mode;
  useEffect(() => {
    safeSet('pop3d:view', mode);
  }, [mode]);

  const refModel = useRefModel(data.space, !readOnly);

  // 단축키
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const demo = useInlineDemo.getState();
      if (demo.projectId === st().currentProjectId && ['running', 'sending'].includes(demo.phase)) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, button, a, summary, dialog, [contenteditable], .inline-catalog')) return;
      const s = st();
      if (s.viewVersion != null) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        s.undo();
        return;
      }
      const id = s.selectedId;
      if (!id) return;
      const p = s.projects.find((x) => x.id === s.currentProjectId)?.placements.find((x) => x.id === id);
      if (!p) return;
      const step = e.shiftKey ? 0.5 : 0.05;
      const move = (dx: number, dy: number) => {
        e.preventDefault();
        s.checkpoint();
        s.movePlacement(id, p.x + dx, p.y + dy);
      };
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          s.removePlacement(id);
          break;
        case 'r':
        case 'R':
          s.rotatePlacement(id, e.shiftKey ? -90 : 90);
          break;
        case 'q':
          s.rotatePlacement(id, -15);
          break;
        case 'e':
          s.rotatePlacement(id, 15);
          break;
        case 'ArrowLeft':
          move(-step, 0);
          break;
        case 'ArrowRight':
          move(step, 0);
          break;
        case 'ArrowUp':
          move(0, -step);
          break;
        case 'ArrowDown':
          move(0, step);
          break;
        case 'Escape':
          s.select(null);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [st]);

  const [busy, setBusy] = useState(false);
  const confirm = () => {
    const r = st().confirmVersion();
    st().toast(r.message, r.ok ? 'ok' : 'warn');
    return r.ok;
  };
  const confirmAndPdf = async () => {
    if (busy || pdfDisabled) return;
    let v = viewing;
    if (!v) {
      if ((dirty || !latest) && !confirm()) return;
      const cur = st().projects.find((p) => p.id === project.id);
      v = cur ? latestVersion(cur) : undefined;
    }
    if (!v) return;
    setBusy(true);
    try {
      const how = await exportPdf(v, canShareFiles() ? 'share' : 'download');
      st().toast(how === 'shared' ? `v${v.version} 기획보고서를 공유했습니다.` : `v${v.version} 기획보고서를 내려받았습니다.`);
    } catch (e) {
      st().toast(`PDF 생성 실패: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const versionBadge = viewing ? (
    <span className="chip blue">v{viewing.version} 읽기 전용</span>
  ) : !latest ? (
    <span className="chip">확정 전 초안</span>
  ) : dirty ? (
    <span className="chip warn">v{latest.version} 이후 수정됨</span>
  ) : (
    <span className="chip ok">v{latest.version} 확정</span>
  );

  return (
    <>
    {guided && <section className="guided-layout-tools">
      <div className="row wrap between"><div><strong>집기를 골라 공간에 놓으세요</strong><p className="hint">카탈로그에서 바로 추가하거나 조건을 정해 배치안을 제안받을 수 있습니다.</p></div><div className="row wrap">{onEditSpace && <button type="button" className="btn" onClick={onEditSpace}>공간 수정</button>}<button type="button" className="btn primary" disabled={readOnly} aria-expanded={showCatalog} aria-controls="layout-inline-catalog" onClick={() => setShowCatalog(open => !open)}>{showCatalog ? '카탈로그 접기' : '집기 골라 담기'}</button></div></div>
      {showCatalog && !readOnly && <div className="inline-catalog" id="layout-inline-catalog"><Suspense fallback={<div className="route-loading" role="status"><span className="loading-ring" />집기 카탈로그를 불러오는 중…</div>}><CatalogPage key={`${project.id}-${vendor.id}`} embedded /></Suspense><div className="catalog-selection-summary row wrap between"><span role="status">현재 배치에 집기 <strong>{project.placements.length}개</strong></span><button type="button" className="btn primary" onClick={() => { setShowCatalog(false); requestAnimationFrame(() => document.getElementById('layout-result')?.scrollIntoView({ block: 'start' })); }}>선택 완료 · 배치 보기</button></div></div>}
    </section>}
    <div className={`proj ${guided ? `guided-proj simple-layout ${hasSelection ? 'has-selection' : ''}` : ''}`}>
      <div className="col side left" id="layout-conditions">
        <ConditionsPanel project={displayProject} space={data.space} vendor={displayVendor} readOnly={readOnly} guided={guided} onEditSpace={onEditSpace} />
      </div>

      <div className="col center" id="layout-result">
        {!guided && <ProjectBar
          projectName={data.projectName}
          readOnly={readOnly}
          versionBadge={versionBadge}
          busy={busy}
          canConfirm={dirty && errorCount === 0 && project.placements.length > 0 && !readOnly}
          pdfLabel={pdfLabel}
          pdfDisabled={pdfDisabled}
          onConfirm={confirm}
          onPdf={confirmAndPdf}
        />}
        <button type="button" className="btn mobile-conditions-link" onClick={() => document.getElementById('layout-conditions')?.scrollIntoView({ block: 'start' })}>{readOnly ? '예산·집기 조건 보기 ↓' : '예산·집기 조건 수정 ↓'}</button>
        {!guided && <p className={`export-help small ${pdfDisabled ? 'muted' : ''}`} role="status">{pdfHelp}</p>}

        {viewing && (
          <div className="readonly-banner">
            <span>v{viewing.version} 보기 중 · 읽기 전용</span>
            <span className="grow" />
            <button className="btn sm" onClick={() => st().setViewVersion(null)}>
              수정본으로 돌아가기
            </button>
            <button
              className="btn sm"
              onClick={() => {
                const v = structuredClone(viewing);
                st().setViewVersion(null);
                st().updateProject((p) => {
                  p.placements = v.placements;
                  p.requirements = v.requirements;
                  p.budget = v.budget;
                  p.fees = v.fees;
                  p.event = v.event;
                  p.memo = v.memo;
                });
                st().toast(`v${v.version}의 배치·조건을 수정본으로 가져왔습니다(공간·카탈로그는 현재 값).`);
              }}
            >
              이 버전으로 되돌리기
            </button>
          </div>
        )}

        {lastPlan && !readOnly && (
          <div className={`note plan-msg ${lastPlan.ok ? 'ok' : 'error'}`}>
            <div className="row between">
              <strong>{lastPlan.summary}</strong>
              <button className="btn ghost sm" onClick={() => st().clearPlanMessage()} aria-label="닫기">
                ✕
              </button>
            </div>
            {lastPlan.ok && (
              <div className="small">
                예산 판단 금액 {won(lastPlan.composition.plannedCost)}
                {lastPlan.composition.adjustments.length ? ` · 조정: ${lastPlan.composition.adjustments.join(', ')}` : ''}
              </div>
            )}
            {lastPlan.reasons.length > 0 && (
              <ul>
                {lastPlan.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {lastPlan.suggestions.length > 0 && (
              <>
                <div className="small" style={{ marginTop: 6, fontWeight: 700 }}>
                  바꿔 볼 수 있는 조건
                </div>
                <ul>
                  {lastPlan.suggestions.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {lastPlan.notes.length > 0 && (
              <ul className="small" style={{ opacity: 0.8 }}>
                {lastPlan.notes.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="viewer-toolbar">
          <div className="seg" role="group" aria-label="보기">
            {(
              [
                ['split', '나란히'],
                ['plan', '평면도'],
                ['3d', '3D'],
              ] as [ViewMode, string][]
            ).filter(([key]) => !guided || key !== 'split').map(([k, l]) => (
              <button key={k} className={visibleMode === k ? 'on' : ''} onClick={() => setMode(k)}>
                {l}
              </button>
            ))}
          </div>
          <span className="small muted">
            {data.space.name} · {data.space.width}×{data.space.depth}×{data.space.height}m · 집기 {data.placements.length}개
          </span>
          <span className="grow" />
          {!readOnly && (
            <button className="btn sm ghost" onClick={() => st().undo()} title="Ctrl+Z">
              되돌리기
            </button>
          )}
        </div>

        <div className={`views ${visibleMode === 'split' ? 'split' : ''}`}>
          {visibleMode !== '3d' && (
            <div className="viewbox">
              <PlanView
                data={data}
                issues={issues}
                selectedId={selectedId}
                editable={!readOnly}
                onSelect={(id) => st().select(id)}
                onMoveStart={() => st().checkpoint()}
                onMove={(id, x, y) => st().movePlacement(id, x, y)}
              />
            </div>
          )}
          {visibleMode !== 'plan' && (
            <Suspense fallback={<div className="viewbox" />}>
              <ThreeView data={data} highlight={highlight} onSelect={(id) => st().select(id)} refModel={refModel} />
            </Suspense>
          )}
        </div>
        {!readOnly && (guided ? <details className="simple-shortcuts"><summary>조작 방법</summary><p className="hint">끌어서 이동 · R 회전 90° · Q/E 15° · 방향키 5cm(Shift 50cm) · Delete 삭제 · Ctrl+Z 되돌리기</p></details> : (
          <p className="hint" style={{ marginTop: 8 }}>
            끌어서 이동 · R 회전 90° · Q/E 15° · 방향키 5cm(Shift 50cm) · Delete 삭제 · Ctrl+Z 되돌리기
          </p>
        ))}
        {guided && <details className="panel simple-issues">
          <summary><strong>배치 확인</strong><span className={errorCount ? 'chip error' : 'chip ok'}>{errorCount ? `오류 ${errorCount}` : '오류 없음'}</span>{warningCount > 0 && <span className="chip warn">주의 {warningCount}</span>}<span className="small muted">자세히 보기</span></summary>
          <div className="simple-issue-list">{issues.filter(issue => issue.severity !== 'info').map((issue, index) => <div className={`simple-issue ${issue.severity}`} key={`${issue.code}-${index}`}><p>{issue.message}</p>{issue.placementIds.length > 0 ? <button type="button" className="btn sm" onClick={() => { st().select(issue.placementIds[0]); requestAnimationFrame(() => document.getElementById('layout-inspector')?.scrollIntoView({ block: 'nearest' })); }}>해당 집기 수정</button> : issue.code === 'REQUIRED_MISSING' ? <button type="button" className="btn sm" onClick={() => document.getElementById('layout-conditions')?.scrollIntoView({ block: 'start' })}>집기 수량 보기</button> : onEditSpace ? <button type="button" className="btn sm" onClick={onEditSpace}>공간 조건 확인</button> : null}</div>)}</div>
          {!errorCount && !warningCount && <p className="hint">등록한 조건에서 배치 오류가 없습니다.</p>}
          {issues.some(issue => issue.severity === 'info') && <details className="simple-issue-notes"><summary>검사에 사용한 조건</summary>{issues.filter(issue => issue.severity === 'info').map((issue, index) => <p className="hint" key={`${issue.code}-${index}`}>{issue.message}</p>)}</details>}
        </details>}
      </div>

      {(!guided || hasSelection) && <div className="col side right" id="layout-inspector">
        <Inspector data={data} issues={issues} readOnly={readOnly} compact={guided} />
        {!guided && <IssuesPanel issues={issues} />}
        {!guided && <><CostPanel cost={cost} /><VersionsPanel project={project} dirty={dirty} /></>}
      </div>}

      {!guided && <div className="mobile-bar">
        <div className="grow">
          <div className="small muted">{cost.unknownLines.length ? '확인+추정 · 미확정 있음' : '확인+추정 합계'}</div>
          <div className="num" style={{ fontWeight: 800, fontSize: 17 }}>
            {won(cost.knownTotal)}
          </div>
        </div>
        {errorCount > 0 && <span className="chip error">오류 {errorCount}</span>}
        <button className="btn accent" disabled={busy || pdfDisabled} onClick={confirmAndPdf} title={pdfHelp}>
          {busy ? '만드는 중…' : viewing ? `v${viewing.version} PDF` : dirty ? '확정·PDF' : '기획보고서 PDF'}
        </button>
      </div>}
    </div>
    </>
  );
}

function ProjectBar(props: {
  projectName: string;
  readOnly: boolean;
  versionBadge: ReactNode;
  busy: boolean;
  canConfirm: boolean;
  pdfLabel: string;
  pdfDisabled: boolean;
  onConfirm: () => void;
  onPdf: () => void;
}) {
  const { project } = useCurrent();
  const projects = useStore((s) => s.projects);
  const spaces = useStore((s) => s.spaces);
  const vendors = useStore((s) => s.vendors);
  const st = useStore.getState;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? '');
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? '');

  return (
    <>
      <div className="projbar">
        <select
          className="input sm"
          style={{ width: 'auto', maxWidth: 200 }}
          value={project.id}
          aria-label="프로젝트 선택"
          onChange={(e) => st().switchProject(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          key={`${project.id}:${props.readOnly ? props.projectName : 'draft'}`}
          className="title-input"
          defaultValue={props.projectName}
          readOnly={props.readOnly}
          aria-label="프로젝트 이름"
          onBlur={(e) =>
            !props.readOnly &&
            e.target.value.trim() &&
            e.target.value !== project.name &&
            st().updateProject((p) => {
              p.name = e.target.value.trim();
            })
          }
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {props.versionBadge}
        <button className="btn" disabled={!props.canConfirm} onClick={props.onConfirm} title="검사 오류가 없을 때 현재 수정본을 새 버전으로 고정">
          버전 확정
        </button>
        <button className="btn primary" disabled={props.busy || props.pdfDisabled} onClick={props.onPdf}>
          {props.busy ? 'PDF 만드는 중…' : props.pdfLabel}
        </button>
        <details style={{ position: 'relative' }}>
          <summary className="btn ghost sm" style={{ listStyle: 'none' }} aria-label="프로젝트 메뉴">
            ⋯
          </summary>
          <div className="panel stack" style={{ position: 'absolute', right: 0, top: 36, zIndex: 20, width: 200, padding: 8, boxShadow: '0 8px 30px rgba(0,0,0,.12)' }}>
            <button className="btn sm ghost" style={{ justifyContent: 'flex-start' }} onClick={() => setCreating(true)}>
              새 프로젝트
            </button>
            <button className="btn sm ghost" style={{ justifyContent: 'flex-start' }} disabled={props.readOnly} onClick={() => st().duplicateProject(project.id)}>
              이 프로젝트 복제
            </button>
            <button
              className="btn sm ghost danger"
              style={{ justifyContent: 'flex-start' }}
              disabled={props.readOnly}
              onClick={() => window.confirm(`'${project.name}'을(를) 삭제할까요? 확정 버전도 함께 사라집니다.`) && st().deleteProject(project.id)}
            >
              프로젝트 삭제
            </button>
            <button
              className="btn sm ghost"
              style={{ justifyContent: 'flex-start' }}
              onClick={() => downloadBlob(new Blob([exportBackup()], { type: 'application/json' }), `pop3d-백업-${new Date().toISOString().slice(0, 10)}.json`)}
            >
              데이터 백업(JSON)
            </button>
            <label className="btn sm ghost" style={{ justifyContent: 'flex-start' }}>
              백업 불러오기
              <input
                type="file"
                disabled={props.readOnly}
                accept=".json,application/json"
                className="sr-only"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  if (!window.confirm('지금 브라우저의 모든 프로젝트·공간·카탈로그를 백업 파일 내용으로 바꿀까요?')) return;
                  const ok = importBackup(await f.text());
                  st().toast(ok ? '백업을 불러왔습니다.' : '백업 파일 형식이 맞지 않습니다.', ok ? 'ok' : 'error');
                }}
              />
            </label>
            <button
              className="btn sm ghost danger"
              style={{ justifyContent: 'flex-start' }}
              disabled={props.readOnly}
              onClick={() => window.confirm('모든 프로젝트·공간·카탈로그를 지우고 9장 가상 검증 예시로 되돌릴까요?') && st().resetAll()}
            >
              전체 초기화(예시 데이터)
            </button>
          </div>
        </details>
      </div>
      {creating && (
        <div className="panel" style={{ marginBottom: 10 }}>
          <div className="grid3">
            <label className="field">
              <span>프로젝트 이름</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 성수 팝업 11월" />
            </label>
            <label className="field">
              <span>공간</span>
              <select className="input" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>업체 카탈로그</span>
              <select className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn primary sm"
              disabled={!name.trim()}
              onClick={() => {
                st().createProject(name.trim(), spaceId, vendorId);
                setCreating(false);
                setName('');
              }}
            >
              만들기
            </button>
            <button className="btn ghost sm" onClick={() => setCreating(false)}>
              취소
            </button>
          </div>
        </div>
      )}
    </>
  );
}
