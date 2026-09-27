import { useRef, useState } from 'react';
import { flushAccount, useAccount } from '../lib/account';
import { callbackKakaoNotice, KakaoReportError, useKakaoStatus } from '../lib/kakaoReport';

export default function KakaoPage({ embedded = false }: { embedded?: boolean }) {
  const Container = embedded ? 'section' : 'main';
  const { status, loading, error: statusError, refresh } = useKakaoStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(callbackKakaoNotice);
  const lock = useRef(false);
  const ready = !!status?.connected && !!status.messagePermission;
  const retryStatus = !!status && ['connection_busy', 'permission_check_failed', 'temporarily_unavailable', 'upstream_unavailable'].includes(status.reason ?? '');
  const configured = !!status?.configured && status.reason !== 'invalid_redirect';

  const connect = async () => {
    if (lock.current || loading || !configured) return;
    lock.current = true;
    setBusy(true); setError('');
    try {
      const owner = useAccount.getState().user?.id;
      if (!owner) throw new KakaoReportError('login_required');
      await flushAccount();
      if (useAccount.getState().user?.id !== owner) throw new KakaoReportError('account_changed');
      window.location.assign('/api/auth/kakao/start?returnTo=report');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '작업을 저장하지 못했습니다.'); }
    finally { lock.current = false; setBusy(false); }
  };

  const disconnect = async () => {
    if (lock.current || loading || !status?.csrfToken) return;
    const owner = useAccount.getState().user?.id;
    if (!owner) { setError(new KakaoReportError('login_required').message); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/kakao/disconnect', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'X-Pop3D-Client': 'web', 'X-Pop3D-Account': owner, 'X-CSRF-Token': status.csrfToken },
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new KakaoReportError(result?.error ?? 'temporarily_unavailable');
      }
      setNotice('카카오톡 전송 연결을 해제했습니다. Pop3D 로그인과 저장한 프로젝트는 유지됩니다.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '연결 해제를 완료하지 못했습니다.'); }
    finally { lock.current = false; setBusy(false); }
  };

  return <Container className="kakao-page">
    <header className="kakao-heading"><div><span className="eyebrow">KAKAO TALK</span><h1>기획안을 나와의 채팅으로.</h1><p>카카오톡 전송을 연결한 뒤 기획보고서 단계에서 보내세요.</p></div>{!embedded && <a className="btn" href="#/report">기획보고서로 돌아가기 →</a>}</header>
    {notice && <div className="kakao-notice" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(null)} aria-label="안내 닫기">×</button></div>}
    {(error || statusError) && <div className="kakao-notice failure" role="alert"><span>{error || statusError}</span></div>}
    <div className="kakao-grid">
      <section className="kakao-connection" aria-labelledby="kakao-connection-heading" aria-busy={busy || loading}>
        <div className="kakao-card-heading"><h2 id="kakao-connection-heading">카카오톡 연결</h2><span className={`kakao-state ${ready ? 'ready' : ''}`}>{loading ? '확인 중' : ready ? '연결됨' : status?.connected ? '전송 동의 필요' : '연결 전'}</span></div>
        <div className="kakao-steps"><p style={{ padding: '22px 0' }}>{loading ? '연결 상태를 확인하고 있습니다.' : !status ? '연결 상태를 다시 확인해 주세요.' : !configured ? '카카오톡 서버 연결 설정을 확인해야 합니다.' : ready ? '카카오톡 연결과 메시지 전송 동의가 완료되었습니다.' : '카카오톡 메시지 전송에 동의하면 보고서 링크를 나와의 채팅으로 받을 수 있습니다.'}</p>
          {!loading && configured && !ready && !retryStatus && <button type="button" className="kakao-login-button" disabled={busy} onClick={() => void connect()}>카카오톡 연결하기</button>}
          {retryStatus && <p role="status">{new KakaoReportError(status!.reason!).message}</p>}
          {ready && <a className="btn" href="#/report">보고서에서 보내기 →</a>}
          {status && !status.publicUrlReady && <p>휴대폰에서 보고서를 열 수 있는 서비스 주소 설정이 필요합니다.</p>}
        </div>
        <div className="kakao-connection-footer" style={{ marginTop: 22 }}><button type="button" className="btn" disabled={busy || loading} onClick={() => void refresh()}>연결 상태 다시 확인</button>{status?.connected && <button type="button" className="kakao-disconnect" disabled={busy || loading || !status.csrfToken} onClick={() => void disconnect()}>카카오톡 전송 연결 해제</button>}</div>
      </section>
      <aside className="kakao-next"><span className="eyebrow">보고서 공유</span><h2>평면·3D 배치와 PDF를<br />휴대폰에서 확인하세요.</h2><p>보고서에서 보내기 버튼을 누를 때만 메시지를 전송합니다. 연결하거나 이 화면을 새로고침하는 동안에는 보내지 않습니다.</p><div className="kakao-progress-summary"><span>받는 곳</span><strong>연결한 계정의 나와의 채팅</strong><span>공유 방식</span><strong>7일간 유효한 보고서 링크</strong></div><div className="kakao-privacy-note"><p>PDF 파일 첨부가 아닌 링크를 보냅니다. <b>링크를 가진 사람은 보고서를 열 수 있습니다.</b></p></div></aside>
    </div>
  </Container>;
}
