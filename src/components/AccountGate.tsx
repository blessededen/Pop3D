import { useEffect, useState, type ReactNode } from 'react';
import { initializeAccount, signIn, useAccount } from '../lib/account';

const kakaoErrors: Record<string, string> = {
  not_configured: '카카오 로그인 설정을 준비하고 있습니다. 아이디로 로그인할 수 있습니다.',
  invalid_redirect: '카카오 로그인 주소 설정을 확인해 주세요.',
  state_invalid: '로그인 요청이 만료되었습니다. 카카오 로그인을 다시 눌러 주세요.',
  authorization_denied: '카카오 로그인을 취소했습니다. 원할 때 다시 시작할 수 있습니다.',
  authorization_failed: '카카오 인증을 완료하지 못했습니다. 다시 시도해 주세요.',
  token_exchange_failed: '카카오 인증을 완료하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  identity_check_failed: '카카오 계정을 확인하지 못했습니다. 다시 시도해 주세요.',
  temporarily_unavailable: '계정 저장소에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  account_unavailable: '내 작업 공간에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};

export default function AccountGate({ children }: { children: ReactNode }) {
  const { user, loading, leaving, error: connectionError } = useAccount();
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [kakao, setKakao] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [kakaoBusy, setKakaoBusy] = useState(false);
  useEffect(() => {
    void initializeAccount();
    const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const code = query.get('account_error');
    if (code) {
      setError(kakaoErrors[code] || '카카오 로그인에 실패했습니다. 다시 시도해 주세요.');
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
    }
    const controller = new AbortController();
    void fetch('/api/account/kakao/status', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<{ configured: boolean }>; })
      .then(status => setKakao(status.configured ? 'ready' : 'unavailable'))
      .catch(() => { if (!controller.signal.aborted) setKakao('unavailable'); });
    const reset = () => setKakaoBusy(false);
    window.addEventListener('pageshow', reset);
    return () => { controller.abort(); window.removeEventListener('pageshow', reset); };
  }, []);
  if (loading) return <div className="account-screen"><p role="status">내 작업 공간을 불러오는 중…</p></div>;
  if (user) return <><div inert={leaving} aria-busy={leaving}>{children}</div>{leaving && <div className="account-transition" role="status">작업을 저장하고 로그아웃하는 중…</div>}</>;
  return <main className="account-screen"><section className="account-card">
    <a className="account-wordmark" href="#/">pop3D<span>.</span></a><span className="eyebrow">나만의 팝업 작업 공간</span>
    <h1>{register ? '기획을 시작하세요.' : '이어서 만들어 볼까요?'}</h1><p>로그인하면 내 프로젝트를 저장하고<br />다음에 이어서 작업할 수 있습니다.</p>
    <form onSubmit={async e => {
      e.preventDefault(); if (busy) return;
      if (register && password !== confirm) { setError('비밀번호가 일치하지 않습니다.'); return; }
      setBusy(true); setError('');
      try { await signIn(username, password, register); setPassword(''); setConfirm(''); }
      catch (failure) { setError((failure as Error).message); }
      finally { setBusy(false); }
    }}>
      <fieldset disabled={busy || kakaoBusy}><label className="field"><span>아이디</span><input className="input" required autoComplete="username" value={username} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,39}" minLength={3} maxLength={40} placeholder="영문·숫자 3~40자" onChange={e => setUsername(e.target.value)} /></label>
      <label className="field"><span>비밀번호</span><input type="password" className="input" required minLength={10} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} value={password} placeholder="10자 이상" onChange={e => setPassword(e.target.value)} /></label>
      {register && <label className="field"><span>비밀번호 확인</span><input type="password" className="input" required minLength={10} maxLength={128} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>}
      {(error || connectionError) && <p className="note error" role="alert">{error || connectionError}</p>}
      <button type="submit" className="btn primary large">{busy ? '연결하는 중…' : register ? '회원가입하고 시작' : '로그인'}</button></fieldset>
    </form>
    <div className="account-divider"><span>또는</span></div>
    <button type="button" className="account-kakao" disabled={busy || kakaoBusy || kakao !== 'ready'} onClick={() => { setKakaoBusy(true); setError(''); window.location.assign('/api/account/kakao/start'); }}>
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3C6.5 3 2 6.5 2 10.8c0 2.8 1.9 5.2 4.7 6.6l-1 3.7c-.1.3.2.5.5.3l4.4-2.9 1.4.1c5.5 0 10-3.5 10-7.8S17.5 3 12 3Z" /></svg>
      {kakaoBusy ? '카카오로 이동하는 중…' : kakao === 'loading' ? '카카오 로그인 확인 중…' : '카카오로 시작하기'}
    </button>
    <p className="account-social-hint">{kakao === 'unavailable' ? '카카오 로그인에 연결할 수 없습니다. 아이디로 로그인해 주세요.' : '처음이라면 카카오 계정으로 바로 가입됩니다.'}<br />프로젝트는 로그인한 계정별로 보관됩니다.</p>
    <button className="text-button account-switch" disabled={busy || kakaoBusy} onClick={() => { setRegister(v => !v); setError(''); setPassword(''); setConfirm(''); }}>{register ? '이미 계정이 있어요 · 로그인' : '처음 오셨나요? · 회원가입'}</button>
  </section></main>;
}
