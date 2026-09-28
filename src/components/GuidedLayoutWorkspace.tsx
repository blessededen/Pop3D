import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useCurrent, useStore } from '../store';
import { draftData, layoutHash } from '../domain/version';
import type { PlanResult } from '../domain/planner';
import { validateLayout } from '../domain/validate';
import { unitPrice, won } from '../domain/cost';
import { fixtureHeightStatus, validPowerPoints } from '../domain/placementRules';
import type { Highlight } from '../three/builders';
import { useRefModel } from '../lib/useRefModel';
import PlanView from './PlanView';
import FixturePicker from './FixturePicker';
import { Inspector } from './SidePanels';
import { NumInput } from './ui';
import AislePreflightDialog from './AislePreflightDialog';
import { useInlineDemo } from '../lib/inlineDemo';

const ThreeView = lazy(() => import('./ThreeView'));

export default function GuidedLayoutWorkspace({ initialCatalogOpen, onEditSpace, onConfiguringChange }: { initialCatalogOpen?: boolean; onEditSpace?: () => void; onConfiguringChange?: (value: boolean) => void }) {
  const { project, space, vendor } = useCurrent();
  const demoStage = useInlineDemo(s => s.projectId === project.id && ['running', 'sending'].includes(s.phase) ? s.stage : null);
  const selectedId = useStore(s => s.selectedId);
  const lastPlan = useStore(s => s.lastPlan);
  const canUndo = useStore(s => s.undoStack.some(entry => entry.projectId === project.id));
  const [choosing, setChoosing] = useState(initialCatalogOpen || !project.placements.length || project.layoutNeedsUpdate !== false);
  const [mode, setMode] = useState<'plan' | '3d'>('plan');
  const [generating, setGenerating] = useState(false);
  const [preflight, setPreflight] = useState<{ repair: boolean } | null>(null);
  const worker = useRef<Worker | null>(null);
  const working = useRef(false);
  const dragging = useRef(false);
  const lastRepair = useRef('');
  const beforeMove = useRef(project.placements);
  const st = useStore.getState;
  const configuring = demoStage ? demoStage === 'fixtures' : choosing || !!project.layoutNeedsUpdate;
  const visibleMode = demoStage ? demoStage === 'three' ? '3d' : 'plan' : mode;
  const data = useMemo(() => draftData(project, space!, vendor!), [project, space, vendor]);
  const issues = useMemo(() => configuring || demoStage === 'layout' ? [] : validateLayout(data), [data, configuring, demoStage]);
  const highlight = useMemo(() => {
    const result = new Map<string, Highlight>();
    for (const issue of issues) if (issue.severity !== 'info') for (const id of issue.placementIds) if (result.get(id) !== 'error') result.set(id, issue.severity);
    if (selectedId && !result.has(selectedId)) result.set(selectedId, 'selected');
    return result;
  }, [issues, selectedId]);
  const refModel = useRefModel(space!, visibleMode === '3d' && !configuring);
  const selected = data.placements.some(item => item.id === selectedId);
  const qty = project.requirements.reduce((sum, r) => sum + r.desiredQty, 0);
  const poweredQty = project.requirements.filter(r => r.needsPower).reduce((sum, r) => sum + r.desiredQty, 0);
  const selectedPrice = project.requirements.reduce((sum, r) => sum + (vendor!.items.find(item => item.sku === r.sku) ? (unitPrice(vendor!.items.find(item => item.sku === r.sku)!, project.event.rentalDays).unit ?? 0) * r.desiredQty : 0), 0);
  const unknownPrices = project.requirements.filter(r => r.desiredQty > 0 && (!vendor!.items.find(item => item.sku === r.sku) || unitPrice(vendor!.items.find(item => item.sku === r.sku)!, project.event.rentalDays).unit == null)).length;
  const errors = issues.filter(issue => issue.severity === 'error');
  const warnings = issues.filter(issue => issue.severity === 'warning');
  const blockedItems = project.requirements.filter(requirement => requirement.desiredQty > 0 && vendor!.items.some(item => item.sku === requirement.sku && fixtureHeightStatus(space!, item).blocked));

  useEffect(() => { onConfiguringChange?.(configuring); }, [configuring, onConfiguringChange]);
  useEffect(() => {
    if (!demoStage) return;
    worker.current?.terminate();
    worker.current = null;
    working.current = false;
    setGenerating(false);
    setChoosing(demoStage === 'fixtures');
    setMode(demoStage === 'three' ? '3d' : 'plan');
    setPreflight(null);
  }, [demoStage]);
  useEffect(() => () => { worker.current?.terminate(); }, []);
  useEffect(() => {
    if (demoStage || configuring || generating || preflight || dragging.current || !errors.length) return;
    const timer = setTimeout(() => { void arrange(true, true); }, 250);
    return () => clearTimeout(timer);
  }, [data, configuring, generating, preflight, demoStage]);
  useEffect(() => {
    if (demoStage || configuring || visibleMode !== 'plan') return;
    const handleKey = (event: KeyboardEvent) => {
      const demo = useInlineDemo.getState();
      if (demo.projectId === st().currentProjectId && ['running', 'sending'].includes(demo.phase)) return;
      if ((event.target as HTMLElement).closest('input, textarea, select, button, summary, [contenteditable="true"], [role="dialog"]')) return;
      const s = st();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); s.undo(); return; }
      if (event.key === 'Escape') { s.select(null); return; }
      const p = s.projects.find(item => item.id === s.currentProjectId)?.placements.find(item => item.id === s.selectedId);
      if (!p) return;
      const distance = event.shiftKey ? .5 : .05;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-distance, 0], ArrowRight: [distance, 0], ArrowUp: [0, -distance], ArrowDown: [0, distance] };
      if (moves[event.key]) { event.preventDefault(); s.checkpoint(); s.movePlacement(p.id, p.x + moves[event.key][0], p.y + moves[event.key][1]); }
      else if (event.key.toLowerCase() === 'r') s.rotatePlacement(p.id, event.shiftKey ? -90 : 90);
      else if (event.key.toLowerCase() === 'q') s.rotatePlacement(p.id, -15);
      else if (event.key.toLowerCase() === 'e') s.rotatePlacement(p.id, 15);
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); s.removePlacement(p.id); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [configuring, visibleMode, st, demoStage]);

  const arrange = async (repair = false, automatic = false) => {
    const demo = useInlineDemo.getState();
    if (demo.projectId === project.id && ['running', 'sending'].includes(demo.phase)) return;
    if (working.current || (!repair && !qty)) return;
    const state = st();
    const activeProject = state.projects.find(p => p.id === project.id);
    const activeSpace = state.spaces.find(s => s.id === activeProject?.spaceId);
    const activeVendor = state.vendors.find(v => v.id === activeProject?.vendorId);
    if (!activeProject || !activeSpace || !activeVendor) return;
    const input = draftData(activeProject, activeSpace, activeVendor);
    const hash = layoutHash(input);
    if (automatic && (lastRepair.current === hash || !validateLayout(input).some(issue => issue.severity === 'error'))) return;
    if (repair) lastRepair.current = hash;
    working.current = true;
    setGenerating(true);
    try {
      const result = await new Promise<PlanResult>((resolve, reject) => {
        const next = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), { type: 'module' });
        worker.current = next;
        next.onmessage = (event: MessageEvent<{ result?: PlanResult; error?: string }>) => { next.terminate(); worker.current = null; event.data.result ? resolve(event.data.result) : reject(new Error(event.data.error)); };
        next.onerror = () => { next.terminate(); worker.current = null; reject(new Error('배치 계산을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.')); };
        next.postMessage({ data: input, repair });
      });
      const currentDemo = useInlineDemo.getState();
      if (currentDemo.projectId === project.id && ['running', 'sending'].includes(currentDemo.phase)) return;
      if (!st().applyPlan(project.id, hash, result, !automatic)) return;
      if (result.ok) { setChoosing(false); setMode('plan'); }
      else if (automatic) {
        const previous = { ...input, placements: beforeMove.current };
        const identity = (items: typeof input.placements) => items.map(p => `${p.id}:${p.sku}:${p.noOrder}`).sort().join('|');
        if (beforeMove.current.length && !validateLayout(previous).some(issue => issue.severity === 'error') && identity(beforeMove.current) === identity(input.placements)) {
          st().updateProject(p => { p.placements = structuredClone(beforeMove.current); }, { undo: false });
          st().toast('그 위치에 놓을 공간이 없어 이전 배치로 돌렸습니다.', 'warn');
        } else st().toast('선택한 수량을 모두 놓는 배치를 찾지 못했습니다. 공간이나 규격을 확인해 주세요.', 'warn');
      }
    } catch (error) { st().toast(`자동 배치 실패: ${(error as Error).message}`, 'error'); }
    finally { working.current = false; setGenerating(false); }
  };

  return <div className="guided-layout">
    {configuring ? <section className="layout-setup panel">
      <div className="layout-setup-heading"><div><span className="eyebrow">01 · 사용할 집기</span><h2>필요한 만큼만 고르세요.</h2><p>수량 0은 사용하지 않음 · 선택한 수량 그대로 배치합니다.</p></div>{project.placements.length > 0 && !project.layoutNeedsUpdate && <button className="text-button" onClick={() => setChoosing(false)}>현재 배치 보기 →</button>}</div>
      <fieldset disabled={generating} className="layout-setup-fields">
        <FixturePicker />
        <details className="layout-budget"><summary>예산 <span>{project.budget.amount != null ? won(project.budget.amount) : '선택 입력'}</span></summary><label className="field"><span>{project.budget.scope === 'fixtures' ? '집기·운송·설치 예산 (원)' : '전체 행사 예산 (원)'}</span><NumInput money allowNull value={project.budget.amount} min={0} placeholder="선택 입력" onChange={value => st().updateProject(p => { p.budget.amount = value; p.layoutNeedsUpdate = true; })} /></label></details>
      </fieldset>
      <div className="layout-power-note"><span>{poweredQty > 0 ? validPowerPoints(space!).length ? `전기 필요 ${poweredQty}개는 전원 거리와 뒤쪽 빈 공간을 함께 고려합니다.` : '전기 필요 품목을 선택했습니다. 공간 설정에서 전원 위치를 찍어 주세요.' : '전기 필요를 체크하면 전원 거리와 뒤쪽 빈 공간을 함께 고려합니다.'}</span><button className="text-button" disabled={generating} onClick={onEditSpace}>전원 위치 설정 →</button></div>
      {lastPlan && !lastPlan.ok && <div className="note error" role="alert"><strong>선택한 수량을 모두 배치하지 못했습니다.</strong>{lastPlan.reasons.map((reason, index) => <p key={index}>{reason}</p>)}{lastPlan.suggestions.length > 0 && <p>{lastPlan.suggestions.join(' ')}</p>}</div>}
      {blockedItems.length > 0 && <p className="note error fixture-height-summary" role="alert">공간 높이 이상의 집기 {blockedItems.length}종을 사용 중입니다. 더 낮은 규격으로 바꾸거나 사용을 취소해 주세요.</p>}
      <div className="layout-arrange-bar"><div><strong>{qty}개 선택</strong><span>집기 금액 {won(selectedPrice)}{unknownPrices ? ` · 미확인 ${unknownPrices}종 제외` : ''}</span><small>운송·설치 등 부대 비용은 다음 단계에서 확인합니다.</small></div><button className="btn primary large" disabled={generating || !qty || blockedItems.length > 0} onClick={() => setPreflight({ repair: false })}>{generating ? '공간에 맞춰 배치하는 중…' : `선택한 ${qty}개 자동 배치 →`}</button></div>
    </section> : <>
      <div className="layout-result-toolbar"><div><span className="eyebrow">02 · 배치 확인</span><p>{demoStage === 'layout' ? '선택한 집기를 계산한 위치에 하나씩 놓고 있습니다.' : visibleMode === 'plan' ? `최소 통로 ${space!.rules.minAisle == null ? '미설정' : `${Math.round(space!.rules.minAisle * 100)}cm`} · 놓을 수 없는 위치는 자동 정리합니다.` : '드래그로 둘러보기 · 위치 수정은 평면도에서'}</p></div><div className="row"><button className="btn sm" disabled={generating} onClick={() => { st().select(null); st().clearPlanMessage(); setChoosing(true); }}>집기·수량 변경</button><button className="btn sm" disabled={generating} onClick={() => setPreflight({ repair: true })}>{generating ? '정리 중…' : '통로 설정 · 자동 정리'}</button><div className="seg" role="group" aria-label="배치 보기"><button aria-pressed={visibleMode === 'plan'} className={visibleMode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>평면도</button><button aria-pressed={visibleMode === '3d'} className={visibleMode === '3d' ? 'on' : ''} onClick={() => setMode('3d')}>3D</button></div></div></div>
      <div className="layout-result-grid"><div className={`layout-result-canvas ${generating ? 'is-arranging' : ''}`} aria-busy={generating}>{generating && <div className="layout-arranging-overlay" role="status">충돌 없는 자리를 비교하는 중…</div>}<div className="views">{visibleMode === 'plan' ? <div className="viewbox"><PlanView data={data} issues={issues} selectedId={selectedId} editable={!generating && !demoStage} onSelect={st().select} onMoveStart={() => { beforeMove.current = structuredClone(project.placements); dragging.current = true; st().checkpoint(); }} onMove={st().movePlacement} onMoveEnd={() => { dragging.current = false; void arrange(true, true); }} /></div> : <Suspense fallback={<div className="viewbox flow-loading" role="status">3D를 불러오는 중…</div>}><ThreeView data={data} highlight={highlight} onSelect={st().select} refModel={refModel} compact /></Suspense>}</div><div className="layout-canvas-footer"><span>{visibleMode === 'plan' ? '끌어서 이동 · R 회전 · Ctrl+Z 되돌리기' : '드래그로 둘러보기 · 휠로 확대'}</span><button className="btn ghost sm" disabled={!canUndo || generating} onClick={st().undo}>↶ 되돌리기</button></div></div><aside className="layout-selection">{selected ? <Inspector data={data} issues={issues} readOnly={generating || !!demoStage} compact /> : <div className="panel layout-selection-empty"><span className="eyebrow">직접 조정</span><h3>집기를 눌러 수정하세요.</h3><p>위치는 도면에서 드래그하고,<br />방향과 규격은 여기서 바꿀 수 있어요.</p></div>}</aside></div>
      <details className="panel layout-validation"><summary><strong>배치 확인</strong><span className={`chip ${errors.length ? 'error' : 'ok'}`}>{demoStage === 'layout' ? '배치 진행 중' : generating ? '자동 정리 중' : errors.length ? `배치 조건 ${errors.length}건` : '충돌 없음'}</span>{warnings.length > 0 && <span className="small muted">참고 {warnings.length}건</span>}</summary><div>{issues.map((issue, index) => <div className={`simple-issue ${issue.severity}`} key={`${issue.code}-${index}`}><p>{issue.message}</p>{issue.placementIds.length > 0 && <button className="text-button" onClick={() => { st().select(issue.placementIds[0]); setMode('plan'); }}>해당 집기 보기 →</button>}</div>)}</div></details>
    </>}
    {preflight && <AislePreflightDialog space={space!} onClose={() => setPreflight(null)} onConfirm={width => { const repair = preflight.repair; const current = st().spaces.find(item => item.id === space!.id); if (!current) return; st().upsertSpace({ ...current, rules: { ...current.rules, minAisle: width } }); setPreflight(null); void arrange(repair); }} />}
  </div>;
}
