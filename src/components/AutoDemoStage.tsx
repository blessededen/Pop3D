import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';
import type { LayoutData } from '../domain/types';
import { CATEGORY_LABEL } from '../domain/types';
import type { Issue } from '../domain/validate';
import type { Highlight } from '../three/builders';
import PlanView from './PlanView';
import AutoDemoSpaceAnimation from './AutoDemoSpaceAnimation';
import './AutoDemoStage.css';

export interface AutoDemoStageProps {
  stage: 'brief' | 'space' | 'fixtures' | 'layout' | 'three' | 'pdf' | 'send' | 'done';
  elapsed: number;
  data: LayoutData | null;
  pdfUrl?: string;
  receipt?: { url: string; expiresAt: string };
  error?: string;
  working?: string;
  onCancel: () => void;
  onDownload: () => void;
  onOpenProject: () => void;
}

type Stage = AutoDemoStageProps['stage'];
const ThreeView = lazy(() => import('./ThreeView'));
const AutoDemoPdfPreview = lazy(() => import('./AutoDemoPdfPreview'));
const NO_ISSUES: Issue[] = [];
const NO_HIGHLIGHT = new Map<string, Highlight>();
const STAGES: Array<{ id: Stage; label: string; title: string; description: string }> = [
  { id: 'brief', label: '기획', title: '하나의 기획에서 시작합니다.', description: '예시 프로젝트의 목적과 공간 조건을 살펴봅니다.' },
  { id: 'space', label: '공간', title: '끌어서, 공간을 정합니다.', description: '기둥과 전원을 선택하고 실제 공간의 위치에 놓습니다.' },
  { id: 'fixtures', label: '집기', title: '필요한 집기를 고르고.', description: '사용할 품목의 규격과 수량, 전원 필요 여부를 정합니다.' },
  { id: 'layout', label: '배치', title: '조건을 반영한 배치로.', description: '계산한 집기 위치를 평면도에 표시합니다.' },
  { id: 'three', label: '3D', title: '평면이 공간이 됩니다.', description: '실제 배치 좌표를 3D로 둘러보세요. 드래그로 시점을 바꿀 수 있습니다.' },
  { id: 'pdf', label: '보고서', title: '공유할 수 있는 기획안으로.', description: '배치도와 품목 정보를 묶어 기획보고서 PDF를 만듭니다.' },
  { id: 'send', label: '카카오톡', title: '기획안을 나와의 채팅으로.', description: '생성한 보고서의 공유 링크를 카카오톡으로 전달합니다.' },
  { id: 'done', label: '결과', title: '이제, 이 기획을 이어가세요.', description: '예시 프로젝트를 열어 나만의 조건과 집기로 수정할 수 있습니다.' },
];

const metric = (value: number) => Number.isFinite(value) ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value) : '—';
const time = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function StageLoader({ children, pending = true }: { children: string; pending?: boolean }) {
  return <div className="auto-demo-loading" role="status">{pending && <span aria-hidden="true" className="auto-demo-orbit" />}<span>{children}</span></div>;
}

function BrandMark() {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m16 3 12 7v13l-12 7-12-7V10L16 3Z" /><path d="m4 10 12 7 12-7M16 17v13M10 6.5l12 7V20" /></svg>;
}

export default function AutoDemoStage({ stage, elapsed, data, pdfUrl, receipt, error, working, onCancel, onDownload, onOpenProject }: AutoDemoStageProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const position = STAGES.findIndex(item => item.id === stage);
  const current = STAGES[position];
  const seconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const limited = Math.min(60, seconds);
  const late = seconds >= 60 && stage !== 'done' && !error;
  const completed = stage === 'done';
  const showPdf = !!pdfUrl && (stage === 'pdf' || stage === 'send' || completed);
  const showThree = !showPdf && ['three', 'pdf', 'send', 'done'].includes(stage);
  const showPlacements = !['brief', 'space', 'fixtures'].includes(stage);
  const fixtures = useMemo(() => data?.requirements.filter(requirement => requirement.desiredQty > 0).map(requirement => ({
    requirement, item: data.vendor.items.find(item => item.sku === requirement.sku),
  })) ?? [], [data?.requirements, data?.vendor.items]);
  const wantedCount = fixtures.reduce((sum, entry) => sum + entry.requirement.desiredQty, 0);
  const placedCount = data?.placements.filter(placement => !placement.noOrder).length ?? 0;
  const expiry = receipt && Number.isFinite(Date.parse(receipt.expiresAt)) ? new Date(receipt.expiresAt).toLocaleDateString('ko-KR') : '';

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);

  return <main className="auto-demo-stage" data-stage={stage}>
    <div className="auto-demo-shell">
      <header className="auto-demo-topbar">
        <div className="auto-demo-brand"><BrandMark /><span>Pop<span>3D</span></span></div>
        <span className="auto-demo-identification">단계별 시연 <span aria-hidden="true">·</span> 예시 프로젝트</span>
        <button type="button" className="auto-demo-exit" onClick={completed || error ? onOpenProject : onCancel}>{completed || error ? '내 작업으로' : '시연 중지'} <span aria-hidden="true">↗</span></button>
      </header>

      <div className="auto-demo-intro">
        <div className="auto-demo-title" aria-live="polite" aria-atomic="true">
          <p className="auto-demo-eyebrow"><span aria-hidden="true" />{String(position + 1).padStart(2, '0')} / 08 <span className="auto-demo-divider" /> {error ? '확인이 필요합니다' : current.label}</p>
          <h1 ref={heading} tabIndex={-1}>{error ? '시연을 마치지 못했습니다.' : completed && receipt ? '기획안을 카카오톡으로 보냈습니다.' : current.title}</h1>
          <p>{error ? data ? pdfUrl ? '아래 내용을 확인해 주세요. 준비된 프로젝트와 PDF는 계속 열어볼 수 있습니다.' : '아래 내용을 확인해 주세요. 준비된 프로젝트를 열어 작업을 이어갈 수 있습니다.' : '아래 내용을 확인한 뒤 시연을 나가 다시 시작해 주세요.' : current.description}</p>
        </div>
        <div className="auto-demo-clock" role="timer" aria-live="off" aria-label={`경과 ${Math.floor(seconds)}초, 시연 목표 60초`}>
          <span>{completed ? '시연 경과 시간' : seconds >= 60 ? '목표 60초 경과' : '목표 시간까지'}</span>
          <strong>{time(completed ? seconds : seconds >= 60 ? 60 : Math.max(0, 60 - limited))}{!completed && seconds >= 60 && <small>+</small>}</strong>
          <progress max={60} value={limited} aria-label="60초 시연 타이머" />
          <small>{late ? '처리가 끝날 때까지 기다리고 있어요' : '예상 진행 시간 · 60초'}</small>
        </div>
      </div>

      <ol className="auto-demo-timeline" aria-label="단계별 시연 순서">
        {STAGES.map((item, index) => <li key={item.id} data-state={index === position ? 'current' : index < position ? 'past' : 'upcoming'} aria-current={index === position ? 'step' : undefined}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><b>{item.label}</b></li>)}
      </ol>

      <div className="auto-demo-workspace">
        <section className="auto-demo-scene" aria-label={showPdf ? '생성된 기획보고서' : showThree ? '현재 배치의 3D 보기' : '현재 공간의 평면도'}>
          <div className="auto-demo-scene-top"><div><span className="auto-demo-live-dot" data-working={!!working && !error} aria-hidden="true" /><span>{showPdf ? '기획보고서 PDF' : showThree ? '3D 공간 보기' : '평면 배치도'}</span></div><span>{data ? `${metric(data.space.width)} × ${metric(data.space.depth)} × ${metric(data.space.height)} m` : '공간 준비 중'}</span></div>
          <div className={`auto-demo-visual ${showPdf ? 'auto-demo-pdf' : ''}`}>
            {showPdf ? <Suspense fallback={<StageLoader>PDF 미리보기를 불러오고 있습니다.</StageLoader>}><AutoDemoPdfPreview url={pdfUrl!} /></Suspense> : data ? showThree ? <Suspense fallback={<StageLoader>3D 공간을 불러오고 있습니다.</StageLoader>}><ThreeView data={data} highlight={NO_HIGHLIGHT} compact /></Suspense> : stage === 'brief' || stage === 'space' ? <AutoDemoSpaceAnimation data={data} active={stage === 'space'} paused={!!error} /> : <PlanView data={data} issues={NO_ISSUES} selectedId={null} editable={false} showItems={showPlacements} /> : <StageLoader pending={!error}>{error ? '표시할 공간 자료가 아직 없습니다.' : '예시 프로젝트를 준비하고 있습니다.'}</StageLoader>}
            {data && !showPdf && stage === 'brief' && <span className="auto-demo-canvas-note">공간과 기획을 한 프로젝트에서</span>}
          </div>
          <div className="auto-demo-scene-bottom"><span>{showPdf ? '실제로 생성된 PDF입니다. 미리보기가 열리지 않으면 내려받아 확인하세요.' : showThree ? '드래그로 회전 · 휠로 확대' : stage === 'layout' ? '현재 계산 결과에 포함된 위치를 표시합니다.' : '입력한 치수와 고정 구조물 기준'}</span>{showPdf && <button type="button" onClick={onDownload}>PDF 내려받기 <span aria-hidden="true">↓</span></button>}</div>
          <dl className="auto-demo-stats"><div><dt>공간 면적</dt><dd>{data ? metric(data.space.width * data.space.depth) : '—'}<span>m²</span></dd></div><div><dt>선택한 집기</dt><dd>{data ? metric(wantedCount) : '—'}<span>개</span></dd></div><div><dt>현재 배치</dt><dd>{data ? metric(placedCount) : '—'}<span>개</span></dd></div></dl>
        </section>

        <aside className="auto-demo-brief" aria-label="예시 프로젝트 기획과 품목">
          <div className="auto-demo-brief-heading"><span className="auto-demo-eyebrow">PROJECT BRIEF</span><span>예시</span></div>
          <h2>{data?.event.title || data?.projectName || '프로젝트 준비 중'}</h2>
          <p className="auto-demo-purpose">{data?.event.brief?.objective || (data ? '기획 목적이 입력되지 않았습니다.' : '공간에서 보고서까지, 실제 작업 흐름을 보여드립니다.')}</p>
          {data?.event.brief?.audience && <div className="auto-demo-audience"><span>대상 고객</span><p>{data.event.brief.audience}</p></div>}
          <dl className="auto-demo-brief-facts"><div><dt>공간</dt><dd>{data?.space.name || '—'}</dd></div><div><dt>실내 높이</dt><dd>{data ? `${metric(data.space.height)} m` : '—'}</dd></div><div><dt>입력 예산</dt><dd>{data?.budget.amount != null ? `${metric(data.budget.amount)}원` : '미입력'}</dd></div></dl>
          <div className="auto-demo-fixtures"><h3>선택한 품목 <span>{fixtures.length}종</span></h3>{fixtures.length ? <ul>{fixtures.slice(0, 5).map(({ item, requirement }, index) => <li key={`${requirement.sku}-${index}`}><span className="auto-demo-fixture-symbol" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div><strong>{item?.name || CATEGORY_LABEL[requirement.category]}</strong><span>{item ? `${metric(item.w)} × ${metric(item.d)} × ${metric(item.h)} m` : '규격 미등록'}{(requirement.needsPower ?? item?.needsPower) ? ' · 전원 필요' : ''}</span></div><b>{requirement.desiredQty}<small>개</small></b></li>)}</ul> : <p>품목을 선택하면 이곳에 표시됩니다.</p>}{fixtures.length > 5 && <p className="auto-demo-more-fixtures">그 외 {fixtures.length - 5}종</p>}</div>
          {receipt && <div className="auto-demo-receipt" role="status"><span aria-hidden="true">↗</span><div><strong>나와의 채팅으로 보냈습니다.</strong><a href={receipt.url} target="_blank" rel="noopener noreferrer">보낸 보고서 열기</a>{expiry && <small>{expiry}까지 열 수 있어요.</small>}</div></div>}
          {['pdf', 'send', 'done'].includes(stage) && <p className="auto-demo-share-note">카카오톡에는 PDF 파일 대신 보고서 링크를 보냅니다. 링크는 7일간 유효하며, 가진 사람이 열 수 있습니다.</p>}
        </aside>
      </div>

      <footer className="auto-demo-footer">
        <div className={`auto-demo-status ${error ? 'has-error' : ''}`} role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}><span className="auto-demo-status-mark" data-working={!!working && !error} aria-hidden="true">{error ? '!' : receipt && completed ? '✓' : '·'}</span><div><strong>{error || working || (completed ? receipt ? '보고서 링크 전송이 완료되었습니다.' : pdfUrl ? '생성된 보고서를 확인하세요.' : '예시 프로젝트의 현재 상태를 확인하세요.' : current.description)}</strong>{late && <span>목표 시간을 넘겼습니다. 완료 여부는 실제 처리 결과로 표시합니다.</span>}</div></div>
        {(completed || !!error) && <div className="auto-demo-final-actions">{!!pdfUrl && <button type="button" className="auto-demo-secondary" onClick={onDownload}>PDF 내려받기</button>}<button type="button" className="auto-demo-primary" onClick={onOpenProject} disabled={!data}>이 프로젝트 편집하기 <span aria-hidden="true">→</span></button></div>}
      </footer>
    </div>
  </main>;
}
