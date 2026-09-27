import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from './store';
import { exportBackup } from './store';
import { flushAccount, importLegacyWorkspace, signOut, useAccount } from './lib/account';
import { downloadBlob } from './lib/browser';
import NewProjectDialog from './components/NewProjectDialog';
const ProjectPage = lazy(() => import('./pages/ProjectPage'));
const OverviewPage = lazy(() => import('./pages/OverviewPage'));
const WorkflowPage = lazy(() => import('./pages/WorkflowPage'));
import './usability.css';
const SpacesPage = lazy(() => import('./pages/SpacesPage'));
const CatalogPage = lazy(() => import('./pages/CatalogPage'));
const CheckPage = lazy(() => import('./pages/CheckPage'));
const KakaoPage = lazy(() => import('./pages/KakaoPage'));

const ROUTES = [
  { path: '#/report', label: '기획보고서 · 추가 정보' },
  { path: '#/overview', label: '전체 요약 · 예산 비교' },
  { path: '#/tools/spaces', label: '저장한 공간 관리' },
  { path: '#/tools/catalog', label: '집기 카탈로그 관리' },
  { path: '#/studio', label: '버전 · 프로젝트 관리' },
  { path: '#/kakao', label: '카카오 연결' },
  { path: '#/check', label: '검증' },
];

function useHash() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#b9d586" />
      <path d="M8 21l8-4.5 8 4.5-8 4.5z" fill="#627948" />
      <path d="M8 14.5L16 10l8 4.5-8 4.5z" fill="#1a2418" />
    </svg>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button onClick={() => dismiss(t.id)} aria-label="닫기">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const hash = useHash();
  const hasProjects = useStore(s => s.projects.length > 0);
  const { user, sync, error, hasLegacy } = useAccount();
  const [accountBusy, setAccountBusy] = useState(false);
  const viewVersion = useStore((s) => s.viewVersion);
  const requestedRoute = hash.split('?')[0];
  const route = ['#/', '#/layout', '#/spaces', '#/catalog', ...ROUTES.map(item => item.path)].includes(requestedRoute) ? requestedRoute : '#/';
  const workflow = ['#/', '#/spaces', '#/catalog', '#/layout', '#/report'].includes(route) && !(route === '#/layout' && viewVersion != null);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [route]);
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <Logo />
          <span>pop<span style={{ fontWeight: 400 }}>3D</span><span style={{ color: 'var(--accent)' }}>.</span></span>
        </a>
        <nav className="flow-top-nav" aria-label="주 메뉴">
          <a href="#/" aria-current={workflow ? 'page' : undefined}>팝업 만들기</a>
          <details className="flow-tools-menu" onClick={event => { if ((event.target as HTMLElement).closest('a')) event.currentTarget.open = false; }}><summary>자료 · 도구</summary><nav aria-label="자료 및 도구">{ROUTES.map(item => <a key={item.path} href={item.path} aria-current={route === item.path ? 'page' : undefined}>{item.label}</a>)}</nav></details>
        </nav>
        <div className="spacer" />
        <span className="app-meta" role="status">{sync === 'saving' ? '저장 중…' : sync === 'error' ? '저장 확인 필요' : '계정에 저장됨'}</span>
        <details className="account-menu"><summary>{user?.username} ▾</summary><div><button className="btn ghost sm" disabled={accountBusy} onClick={async () => { setAccountBusy(true); try { await signOut(); } catch (e) { useStore.getState().toast(`로그아웃 전에 저장이 필요합니다: ${(e as Error).message}`, 'error'); } finally { setAccountBusy(false); } }}>로그아웃</button>{hasLegacy && <button className="btn ghost sm" disabled={accountBusy} onClick={async () => {
          if (!window.confirm('이 브라우저에 남아 있는 로그인 이전 작업을 내 계정으로 가져올까요? 기존 계정 프로젝트는 유지합니다.')) return;
          setAccountBusy(true);
          try { const ok = await importLegacyWorkspace(); useStore.getState().toast(ok ? '기존 작업을 가져와 계정에 저장했습니다.' : '가져올 수 없는 형식입니다.', ok ? 'ok' : 'error'); }
          catch (error) { useStore.getState().toast(`가져오기 확인 필요: ${(error as Error).message}`, 'error'); }
          finally { setAccountBusy(false); }
        }}>로그인 이전 작업 가져오기</button>}</div></details>
      </header>
      {sync === 'error' && <div className="account-save-error" role="alert"><span>{error} 현재 작업은 이 화면에 남아 있습니다.</span><button className="btn sm" onClick={() => void flushAccount().catch(() => {})}>저장 다시 시도</button><button className="btn sm" onClick={() => downloadBlob(new Blob([exportBackup()], { type: 'application/json' }), 'Pop3D-저장대기-백업.json')}>작업 백업</button></div>}
      {hasProjects && !workflow && <div className="flow-tools-banner"><a href="#/">← 이어서 팝업 만들기</a><span>자료를 수정한 뒤 작업하던 단계로 돌아갈 수 있습니다.</span></div>}
      <Suspense fallback={<div className="route-loading" role="status"><span className="loading-ring" />화면을 불러오는 중…</div>}>
      {!hasProjects ? <EmptyProjects /> : <>
      {workflow && <WorkflowPage key={route} initialStep={route === '#/report' ? 'report' : route === '#/spaces' ? 'space' : route === '#/layout' || route === '#/catalog' ? 'layout' : undefined} initialCatalogOpen={route === '#/catalog'} />}
      {route === '#/overview' && <OverviewPage />}
      {(route === '#/studio' || route === '#/layout' && !workflow) && <ProjectPage />}
      {route === '#/tools/spaces' && <SpacesPage onEditReport={() => { window.location.hash = '#/report'; }} />}
      {route === '#/tools/catalog' && <CatalogPage />}
      {route === '#/check' && <CheckPage />}
      {route === '#/kakao' && <KakaoPage />}
      </>}
      </Suspense>
      <Toasts />
    </div>
  );
}

function EmptyProjects() {
  const [creating, setCreating] = useState(false);
  const hasLegacy = useAccount(s => s.hasLegacy);
  return <main className="account-empty"><span className="eyebrow">MY PROJECTS</span><h1>첫 팝업을 만들어 보세요.</h1><p>공간을 그리고 집기를 고르면 배치부터 보고서까지 이어집니다.</p><button className="btn primary large" onClick={() => setCreating(true)}>+ 새 프로젝트</button>{hasLegacy && <p className="hint">로그인 이전 작업은 오른쪽 위 계정 메뉴에서 가져올 수 있습니다.</p>}{creating && <NewProjectDialog onClose={() => setCreating(false)} onCreated={() => { window.location.hash = '#/spaces'; }} />}</main>;
}
