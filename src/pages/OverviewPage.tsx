import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useCurrent, useStore } from '../store';
import { draftData, isDirty, latestVersion, layoutHash, snapshotData } from '../domain/version';
import { computeCost, won } from '../domain/cost';
import { buildDecisionSummary } from '../domain/planning';
import { proposePlan, type PlanResult } from '../domain/planner';
import { validateLayout } from '../domain/validate';
import { CATEGORY_LABEL, type LayoutData, type PlanningBrief } from '../domain/types';
import { Field, NumInput, TextInput } from '../components/ui';
import { exportPdf } from '../lib/exporters';
import { canShareFiles } from '../lib/browser';
import PlanView from '../components/PlanView';
import NewProjectDialog from '../components/NewProjectDialog';
const ThreeView = lazy(() => import('../components/ThreeView'));
const EMPTY_HIGHLIGHT = new Map();
type Section = 'brief' | 'compare' | 'report';
type Alternative = { label: string; ratio: number; budget: number; result: PlanResult; data: LayoutData; hash: string };

export default function OverviewPage() {
  const { project, space, vendor } = useCurrent();
  if (!space || !vendor) return <div className="page note error">공간 또는 카탈로그를 확인해 주세요. <a href="#/spaces">공간 자료 열기</a></div>;
  return <Overview key={project.id} data={draftData(project, space, vendor)} />;
}

function Overview({ data }: { data: LayoutData }) {
  const { project, space, vendor } = useCurrent();
  const projects = useStore(s => s.projects);
  const st = useStore.getState;
  useEffect(() => { st().setViewVersion(null); }, [st, project.id]);
  const [creating, setCreating] = useState(false);
  const [section, setSection] = useState<Section>('brief');
  const [preview, setPreview] = useState<'3d' | 'plan'>('3d');
  const [busy, setBusy] = useState(false);
  const [alternatives, setAlternatives] = useState<Alternative[]>([]);
  const [selectedAlternative, setSelectedAlternative] = useState<number | null>(null);
  const summary = useMemo(() => buildDecisionSummary(data), [data]);
  const cost = summary.cost;
  const latest = latestVersion(project);
  const dirty = isDirty(project, space!, vendor!);
  const currentHash = layoutHash(data);
  const canExport = summary.blockingCount === 0 && data.placements.length > 0;
  const shareSupported = canShareFiles();
  const candidateSelection = selectedAlternative == null ? undefined : alternatives[selectedAlternative];
  const selection = section === 'compare' && candidateSelection?.hash === currentHash ? candidateSelection : undefined;
  const displayData = selection?.result.ok ? selection.data : data;
  const updateBrief = (key: keyof PlanningBrief, value: string) => st().updateProject(p => {
    p.event.brief = { objective: '', audience: '', experience: '', approval: '', ...p.event.brief, [key]: value };
  });
  const openStudio = () => { st().setViewVersion(null); window.location.hash = '#/layout'; };
  const generate = () => {
    if (data.budget.amount == null || data.budget.scope !== 'fixtures') return;
    const result = [{ label: '비용 집중안', ratio: 0.75 }, { label: '기준 예산안', ratio: 1 }, { label: '여유 예산안', ratio: 1.2 }].map(({ label, ratio }) => {
      const budget = Math.round(data.budget.amount! * ratio);
      const candidate = { ...structuredClone(data), budget: { amount: budget, scope: 'fixtures' as const } };
      const result = proposePlan(candidate);
      return { label, ratio, budget, result, data: { ...candidate, placements: result.placements }, hash: currentHash };
    });
    setAlternatives(result); setSelectedAlternative(null);
  };
  const apply = (alt: Alternative) => {
    if (!alt.result.ok || alt.hash !== currentHash) return;
    st().setViewVersion(null);
    st().updateProject(p => { p.budget.amount = alt.budget; p.placements = structuredClone(alt.result.placements); });
    setAlternatives([]); setSelectedAlternative(null);
    st().toast(`${alt.label}을 적용했습니다. 배치 스튜디오에서 세부 위치를 조정할 수 있습니다.`);
  };
  const download = async (mode: 'download' | 'share') => {
    if (!canExport || busy) return;
    setBusy(true);
    try {
      st().setViewVersion(null);
      if (dirty) {
        const result = st().confirmVersion();
        if (!result.ok) { st().toast(result.message, 'warn'); return; }
      }
      const current = st().projects.find(p => p.id === project.id)!;
      const snap = latestVersion(current);
      if (!snap) return;
      const how = await exportPdf(snap, mode);
      st().toast(how === 'shared' ? `v${snap.version} 기획보고서 공유창을 열었습니다.` : `v${snap.version} 기획보고서를 내려받았습니다.`);
    } catch (e) { st().toast(`PDF 생성 실패: ${(e as Error).message}`, 'error'); }
    finally { setBusy(false); }
  };

  return <main className="overview">
    <div className="overview-topline"><span className="eyebrow">WORKSPACE / POP-UP PLANNING</span><label className="project-switch"><span>프로젝트</span><select aria-label="대시보드 프로젝트 선택" value={project.id} onChange={e => { st().switchProject(e.target.value); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
    <header className="overview-heading"><div><div className="row wrap"><span className="status-dot" /> <span className="small muted">{latest ? dirty ? `v${latest.version} 이후 수정 중` : `v${latest.version} 저장됨` : '첫 번째 기획안 · 초안'}</span></div><h1>내 팝업 공간,<br className="mobile-break" /> 직접 그리고 비교하세요.</h1><p>공간을 그리고, 집기를 골라 배치하면 기획보고서까지 이어집니다.</p></div><div className="overview-actions"><button className="btn" onClick={openStudio}>이어서 배치하기 ↗</button><button className="btn primary large" onClick={() => setCreating(true)}>+ 새 팝업 만들기</button></div></header>

    <div className="workspace-steps" aria-label="기획 작업 순서"><button onClick={() => { window.location.hash = '#/spaces'; }}><b>01</b><span>공간 그리기<small>크기를 정하고 기둥을 놓으세요</small></span></button><button onClick={openStudio}><b>02</b><span>집기 배치<small>규격을 고르고 끌어놓으세요</small></span></button><button className={section === 'report' ? 'active' : ''} onClick={() => setSection('report')}><b>03</b><span>검토 · 보고<small>같은 버전의 PDF로 공유하세요</small></span></button></div>

    <div className="overview-main-grid"><section className="preview-card"><div className="preview-heading"><div><span className="eyebrow">SPACE PREVIEW</span><h2>{selection ? selection.label + ' 미리보기' : data.event.title || project.name}</h2></div><div className="seg" aria-label="대시보드 미리보기"><button className={preview === '3d' ? 'on' : ''} onClick={() => setPreview('3d')}>3D</button><button className={preview === 'plan' ? 'on' : ''} onClick={() => setPreview('plan')}>평면도</button></div></div><div className="dashboard-scene">{preview === '3d' ? <Suspense fallback={<div className="scene-loading">공간을 불러오는 중…</div>}><ThreeView data={displayData} highlight={EMPTY_HIGHLIGHT} /></Suspense> : <PlanView data={displayData} issues={validateLayout(displayData)} selectedId={null} editable={false} onSelect={() => {}} onMoveStart={() => {}} onMove={() => {}} />}</div><div className="preview-footer"><span>{data.space.name} <span className="muted">/ {data.space.width} × {data.space.depth} m</span></span><button className="text-button" onClick={openStudio}>배치 편집 <span aria-hidden>→</span></button></div></section>
    <aside className="decision-card"><span className="eyebrow">PROJECT AT A GLANCE</span><h2>한눈에 보는 기획안</h2><div className="budget-hero"><span>집기·부대 비용 <small>확인 + 추정</small></span><strong>{cost.knownTotal.toLocaleString('ko-KR')}<small>원</small></strong><span className={cost.unknownLines.length ? 'cost-caution' : 'muted'}>{cost.unknownLines.length ? `미확인 ${cost.unknownLines.length}건 제외 · 총액 미확정` : '등록된 비용 기준 · 공식 견적 아님'}</span></div><div className="budget-track" aria-hidden><div style={{ width: `${cost.budgetDiff == null || !data.budget.amount ? 0 : Math.min(100, cost.knownTotal / data.budget.amount * 100)}%` }} /></div><div className="budget-caption"><span>{data.budget.scope === 'event_total' ? '전체 행사 예산' : '설정 예산'}</span><b>{won(data.budget.amount)}</b></div><div className="summary-mini-grid"><div><span>공간 면적</span><strong>{summary.areaM2.toLocaleString('ko-KR')} <small>m²</small></strong></div><div><span>주문 집기</span><strong>{summary.orderQty} <small>개</small></strong></div><div><span>대여 기간</span><strong>{data.event.rentalDays} <small>일</small></strong></div><div><span>검토할 항목</span><strong>{summary.reviewCount} <small>건</small></strong></div></div><button className="btn decision-cta" onClick={() => setSection('report')}>보고 전 확인사항 보기 <span aria-hidden>→</span></button></aside></div>

    {(data.space.isVirtual || data.vendor.isVirtual) && <div className="demo-notice"><span className="demo-tag">DEMO DATA</span><span>현재 공간·가격은 가상 예시입니다. 실제 기획에는 보유한 공간 자료와 업체 카탈로그를 등록하세요.</span><a href="#/spaces">자료 관리 ↗</a></div>}

    <div className="dashboard-tabs" role="tablist" aria-label="기획 관리"><button id="brief-tab" role="tab" aria-selected={section === 'brief'} aria-controls="dashboard-content" onClick={() => setSection('brief')}>기획 브리프</button><button id="compare-tab" role="tab" aria-selected={section === 'compare'} aria-controls="dashboard-content" onClick={() => setSection('compare')}>예산 대안 비교</button><button id="report-tab" role="tab" aria-selected={section === 'report'} aria-controls="dashboard-content" onClick={() => setSection('report')}>보고 준비 <span>{summary.reviewCount}</span></button></div>
    <section id="dashboard-content" role="tabpanel" aria-labelledby={`${section}-tab`}>
    {section === 'brief' && <div className="brief-grid"><div className="brief-editor surface"><div className="section-heading"><div><span className="eyebrow">THE BRIEF</span><h2>이번 팝업의 이유를 담아주세요.</h2><p>입력한 내용은 확정 버전과 기획보고서에 함께 담깁니다.</p></div><span className="quiet-label">입력 후 자동 저장</span></div><div className="brief-fields">{([{ key: 'objective', label: '01  기획 목적', placeholder: '예: 신제품을 직접 체험할 수 있는 접점 만들기' }, { key: 'audience', label: '02  대상 고객', placeholder: '누가 이 공간을 방문하나요?' }, { key: 'experience', label: '03  핵심 경험', placeholder: '고객이 무엇을 보고, 해보고, 기억하길 바라나요?' }, { key: 'approval', label: '04  이번 승인 요청', placeholder: '예: 배치안과 집기 예산 검토, 업체 견적 진행 승인' }] as const).map(f => <Field key={f.key} label={f.label}><TextInput multiline value={summary.brief[f.key]} placeholder={f.placeholder} onChange={v => updateBrief(f.key, v)} /></Field>)}</div></div><aside className="brief-guide"><span className="eyebrow">YOUR NEXT MOVE</span><h2>기획의 근거를<br />한곳에 모으세요.</h2><p>공간의 모습만큼, 왜 이 구성이 필요한지 설명하는 것이 중요합니다.</p><ol><li><b>기획 의도</b><span>목적과 고객, 핵심 경험을 연결합니다.</span></li><li><b>실행 근거</b><span>집기 수량과 비용, 공간 제약을 확인합니다.</span></li><li><b>검토 요청</b><span>확정할 내용과 더 확인할 내용을 구분합니다.</span></li></ol><button className="text-button" onClick={() => setSection('compare')}>예산에 따른 대안 살펴보기 →</button></aside></div>}

    {section === 'compare' && <div className="surface compare-section"><div className="section-heading"><div><span className="eyebrow">BUDGET EXPLORER</span><h2>예산이 달라지면, 구성은 어떻게 달라질까요?</h2><p>현재 희망 수량과 필수 집기를 기준으로 75% · 100% · 120% 예산의 배치안을 계산합니다.</p></div><button className="btn primary" disabled={data.budget.amount == null || data.budget.amount <= 0 || data.budget.scope !== 'fixtures'} onClick={generate}>대안 3개 계산</button></div><div className="compare-budget"><Field label={data.budget.scope === 'fixtures' ? '비교 기준 집기 예산' : '전체 행사 예산 (비교 불가)'}><NumInput money allowNull min={0} disabled={data.budget.scope !== 'fixtures'} value={data.budget.amount} onChange={v => st().updateProject(p => { p.budget.amount = v; })} /></Field><span>집기 · 운송 · 설치 · 철거 비용 기준입니다. 예산을 늘려도 희망 수량을 초과해 추가하지 않습니다.</span></div>{data.budget.scope !== 'fixtures' && <div className="note warn">전체 행사비에는 임차료 등 별도 비용이 포함됩니다. 배치 스튜디오에서 집기 예산을 따로 설정한 뒤 비교하세요.</div>}{!alternatives.length ? <div className="compare-empty"><span aria-hidden>⇄</span><h3>선택하기 전에 비교해보세요.</h3><p>계산 결과를 미리 보고, 선택한 안만 현재 프로젝트에 적용합니다.</p></div> : <div className="alternative-grid">{alternatives.map((alt, i) => { const c = computeCost(alt.data); const stale = alt.hash !== currentHash; return <article className={`alternative ${selectedAlternative === i ? 'selected' : ''}`} key={alt.label}><div className="row between"><span className="eyebrow">OPTION 0{i + 1}</span><span className="chip">예산 {Math.round(alt.ratio * 100)}%</span></div><h3>{alt.label}</h3><span className="muted small">설정 예산 {won(alt.budget)}</span><strong className="option-cost">{alt.result.ok ? won(c.knownTotal) : '배치 조건 미충족'}</strong>{alt.result.ok ? <><p>주문 집기 {alt.data.placements.filter(p => !p.noOrder).length}개 · 미확인 비용 {c.unknownLines.length}건</p><ul className="option-items">{alt.result.composition.entries.filter(e => e.qty > 0).map(e => <li key={e.sku}><span>{CATEGORY_LABEL[e.category]}</span><b>{e.qty}개</b></li>)}</ul><p className="small muted">{alt.result.composition.adjustments.join(' · ') || '희망 수량을 유지한 구성입니다.'}</p><p className="small muted">{c.unknownLines.length ? '미확인 금액은 제외되어 예산 충족을 보장하지 않습니다.' : '확인·추정 금액 기준이며 실제 견적은 달라질 수 있습니다.'}</p></> : <p className="small cost-caution">{alt.result.reasons.join(' ')}</p>}{stale && <p className="small cost-caution">조건이 바뀌었습니다. 대안을 다시 계산하세요.</p>}<div className="option-actions"><button className="btn" disabled={!alt.result.ok || stale} onClick={() => { setSelectedAlternative(i); window.scrollTo({ top: 120, behavior: 'smooth' }); }}>배치 미리보기</button><button className="btn primary" disabled={!alt.result.ok || stale} onClick={() => apply(alt)}>이 안 적용</button></div></article>; })}</div>}</div>}

    {section === 'report' && <div className="report-grid"><div className="surface"><div className="section-heading"><div><span className="eyebrow">REVIEW CHECKLIST</span><h2>보고하기 전에 확인해주세요.</h2><p>아직 확인하지 않은 항목도 보고서에 그대로 표시됩니다.</p></div></div><div className="review-checklist">{summary.checklist.map(c => <div className="review-item" key={c.id}><span className={`review-icon ${c.status}`} aria-hidden>{c.status === 'ready' ? '✓' : '!'}</span><div><strong>{c.label}</strong><p>{c.detail}</p></div><span className={`chip ${c.status === 'ready' ? '' : 'warn'}`}>{c.status === 'ready' ? '입력됨' : '확인 필요'}</span></div>)}</div><div className="version-comparison"><h3>이전 확정안과 비교</h3>{latest ? <><div className="comparison-row"><span>v{latest.version} → 현재 수정본</span><b>{dirty ? '변경 내용 있음' : '같은 내용'}</b></div><div className="comparison-row"><span>확인 + 추정 비용</span><b>{won(computeCost(snapshotData(latest)).knownTotal)} → {won(cost.knownTotal)}</b></div><div className="comparison-row"><span>주문 집기 수량</span><b>{latest.placements.filter(p => !p.noOrder).length}개 → {summary.orderQty}개</b></div><p className="small muted">미확인 비용이나 산정 조건이 다를 수 있어 금액 차이를 절감액으로 판정하지 않습니다.</p><button className="text-button" onClick={() => { st().setViewVersion(latest.version); window.location.hash = '#/layout'; }}>v{latest.version} 자세히 보기 →</button></> : <p className="muted">아직 확정한 버전이 없습니다. 첫 보고서를 만들면 비교 기준이 저장됩니다.</p>}</div></div><aside className="report-export"><span className="eyebrow">READY TO PRESENT</span><div className="report-cover" aria-hidden><span>POP / 3D</span><small>POP-UP PLANNING REPORT</small><strong>팝업 기획<br />보고서</strong><div className="cover-line" /><span>{data.event.title || project.name}</span><small>기획 요약 · 배치도 · 예상 비용</small></div><h2>회의에 가져갈 한 파일.</h2><p>기획 요약, 평면도와 3D, 품목별 비용, 확인 요청을 같은 버전으로 묶습니다.</p><button className="btn primary large" disabled={!canExport || busy} onClick={() => download('download')}>{busy ? '보고서 만드는 중…' : dirty ? '버전 확정 · PDF 내려받기' : `v${latest?.version} PDF 내려받기`}</button>{shareSupported && <button className="btn large" disabled={!canExport || busy} onClick={() => download('share')}>PDF 공유</button>}{!canExport && <p className="cost-caution small">{data.placements.length === 0 ? '집기를 먼저 배치해주세요.' : `배치 오류 ${summary.blockingCount}건을 먼저 수정해주세요.`}</p>}<span className="small muted">현재 브라우저에 저장 · 공식 견적이나 발주서가 아닙니다.</span></aside></div>}
    </section><footer className="workspace-footer"><span>Pop3D — Plan with clarity.</span><span>데이터는 이 브라우저에 저장됩니다. 백업은 배치 스튜디오의 프로젝트 메뉴에서 가능합니다.</span></footer>
    {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
  </main>;
}
