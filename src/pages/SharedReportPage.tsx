import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import PlanView from '../components/PlanView';
import { snapshotData } from '../domain/version';
import type { VersionSnapshot } from '../domain/types';
import './SharedReportPage.css';

const ThreeView = lazy(() => import('../components/ThreeView'));
const EMPTY_HIGHLIGHT = new Map();

class LayoutBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p className="shared-report-hint">배치 화면을 표시하지 못했습니다. 위 버튼에서 PDF를 내려받아 확인할 수 있습니다.</p> : this.props.children; }
}

export default function SharedReportPage({ token }: { token: string }) {
  const [report, setReport] = useState<{ snapshot: VersionSnapshot; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'3d' | '2d'>('3d');
  useEffect(() => {
    const controller = new AbortController();
    setReport(null); setError('');
    void fetch(`/api/reports/${encodeURIComponent(token)}`, { credentials: 'omit', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 404 ? '링크가 만료되었거나 보고서를 찾을 수 없습니다. 작성자에게 새 보고서를 요청해 주세요.' : '보고서를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.');
        return response.json();
      }).then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); });
    return () => controller.abort();
  }, [token]);
  const snapshot = report?.snapshot;
  return <main className="shared-report">
    <header className="shared-report-header"><a className="account-wordmark" href="#/">pop3D<span>.</span></a><span>공유된 기획보고서</span></header>
    {error ? <section className="shared-report-empty" role="alert"><h1>보고서를 열 수 없습니다.</h1><p>{error}</p><a className="btn" href="#/">Pop3D 홈으로</a></section> : !snapshot ? <div className="route-loading" role="status"><span className="loading-ring" />기획보고서를 불러오는 중…</div> : <>
      <section className="shared-report-title"><div><span className="eyebrow">POPUP PLANNING REPORT · v{snapshot.version}</span><h1>{snapshot.event.title || snapshot.projectName}</h1><p>{snapshot.space.width} × {snapshot.space.depth}m · 높이 {snapshot.space.height}m · 집기 {snapshot.placements.filter(item => !item.noOrder).length}개</p></div>
        <a className="btn primary large" href={`/api/reports/${encodeURIComponent(token)}/pdf`} download>기획보고서 PDF 내려받기 ↓</a></section>
      <section className="shared-report-layout"><div className="shared-report-toolbar"><h2>공간 배치</h2><div role="group" aria-label="배치 보기"><button className={`btn sm ${mode === '3d' ? 'primary' : ''}`} aria-pressed={mode === '3d'} onClick={() => setMode('3d')}>3D</button><button className={`btn sm ${mode === '2d' ? 'primary' : ''}`} aria-pressed={mode === '2d'} onClick={() => setMode('2d')}>평면도</button></div></div>
        <div className="shared-report-canvas"><LayoutBoundary key={`${token}:${mode}`}>{mode === '3d' ? <Suspense fallback={<div className="route-loading" role="status">3D 배치를 불러오는 중…</div>}><ThreeView data={snapshotData(snapshot)} highlight={EMPTY_HIGHLIGHT} compact /></Suspense> : <PlanView data={snapshotData(snapshot)} issues={[]} editable={false} selectedId={null} />}</LayoutBoundary></div>
        <p className="shared-report-hint">{mode === '3d' ? '드래그해서 둘러보고 두 손가락 또는 마우스 휠로 확대하세요.' : '보낸 시점의 배치가 표시됩니다.'}</p></section>
      {snapshot.event.brief?.objective && <section className="shared-report-brief"><h2>기획 목적</h2><p>{snapshot.event.brief.objective}</p>{snapshot.event.brief.audience && <><h2>대상 고객</h2><p>{snapshot.event.brief.audience}</p></>}</section>}
      <footer className="shared-report-footer">보낸 시점의 v{snapshot.version} 보고서입니다. 링크는 {new Date(report!.expiresAt).toLocaleDateString('ko-KR')}까지 열 수 있습니다.</footer>
    </>}
  </main>;
}
