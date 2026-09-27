import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AccountGate from './components/AccountGate';
import './styles.css';
import './studio.css';
import './usability.css';
import './kakao.css';
import './workflow.css';
import './dark.css';

const SharedReportPage = lazy(() => import('./pages/SharedReportPage'));
function Entry() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const shared = /^#\/shared\/([A-Za-z0-9_-]{43})$/.exec(hash);
  return shared ? <Suspense fallback={<div className="route-loading" role="status">보고서를 불러오는 중…</div>}><SharedReportPage token={shared[1]} /></Suspense> : <AccountGate><App /></AccountGate>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Entry />
  </StrictMode>,
);
