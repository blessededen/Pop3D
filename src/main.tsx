import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AccountGate from './components/AccountGate';
import './styles.css';
import './studio.css';
import './usability.css';
import './kakao.css';
import './workflow.css';
import './dark.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AccountGate><App /></AccountGate>
  </StrictMode>,
);
