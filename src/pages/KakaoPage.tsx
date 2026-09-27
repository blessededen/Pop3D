import { useCallback, useEffect, useRef, useState } from 'react';

type KakaoStatus = {
  configured: boolean;
  missing: string[];
  connected: boolean;
  csrfToken: string | null;
  messagePermission: boolean;
  canSend: boolean;
  publicUrlReady: boolean;
  reason?: string;
};

const CALLBACK_ERRORS: Record<string, string> = {
  not_configured: '카카오 연결 설정이 아직 준비되지 않았습니다. 서버 설정을 확인한 뒤 다시 시도해 주세요.',
  invalid_redirect: '카카오에 등록한 로그인 복귀 주소와 서버 설정을 확인해 주세요.',
  state_invalid: '로그인 요청이 만료되었거나 이 브라우저에서 시작한 요청이 아닙니다. 아래 버튼으로 다시 시작해 주세요.',
  authorization_denied: '카카오 로그인을 취소했습니다. 원할 때 다시 연결할 수 있습니다.',
  authorization_failed: '카카오 로그인을 완료하지 못했습니다. 다시 시도해 주세요.',
  token_exchange_failed: '로그인 연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  permission_check_failed: '카카오톡 전송 동의를 확인하지 못했습니다. 다시 연결해 주세요.',
  temporarily_unavailable: '지금은 로그인 요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.',
};

function callbackNotice(): { kind: 'success' | 'notice'; text: string } | null {
  const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
  if (query.get('kakao') === 'connected') return { kind: 'success', text: '카카오 로그인에서 돌아왔습니다. 아래에서 연결 상태를 확인하세요.' };
  const error = query.get('error');
  if (error) return { kind: 'notice', text: Object.hasOwn(CALLBACK_ERRORS, error) ? CALLBACK_ERRORS[error] : '카카오 연결을 완료하지 못했습니다. 아래에서 연결 상태를 확인하고 다시 시도해 주세요.' };
  return null;
}

function parseStatus(value: unknown): KakaoStatus {
  if (!value || typeof value !== 'object') throw new Error('invalid_status');
  const s = value as Partial<KakaoStatus>;
  if (['configured', 'connected', 'messagePermission', 'canSend', 'publicUrlReady'].some(key => typeof s[key as keyof KakaoStatus] !== 'boolean')
    || !Array.isArray(s.missing) || !s.missing.every(item => typeof item === 'string')
    || !(s.csrfToken === null || typeof s.csrfToken === 'string')) throw new Error('invalid_status');
  return s as KakaoStatus;
}

function TalkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3C6.48 3 2 6.46 2 10.72c0 2.78 1.91 5.22 4.78 6.57l-.98 3.58c-.09.32.28.57.55.38l4.2-2.81c.48.05.96.08 1.45.08 5.52 0 10-3.49 10-7.8S17.52 3 12 3Z" /></svg>;
}

export default function KakaoPage({ embedded = false }: { embedded?: boolean }) {
  const Container = embedded ? 'section' : 'main';
  const [status, setStatus] = useState<KakaoStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(callbackNotice);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/kakao/status', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('status_unavailable');
      const nextStatus = parseStatus(await response.json());
      if (!controller.signal.aborted) setStatus(nextStatus);
    } catch {
      if (request.current === controller && (!controller.signal.aborted || timedOut)) {
        setStatus(null);
        setError(timedOut ? '연결 상태 확인이 지연되고 있습니다. 잠시 후 다시 확인해 주세요.' : '서버에 연결하지 못했습니다. 서버가 실행 중인지 확인한 뒤 다시 시도해 주세요.');
      }
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller && (!controller.signal.aborted || timedOut)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { request.current?.abort(); };
  }, [refresh]);

  const disconnect = async () => {
    if (!status?.csrfToken || disconnecting || loading) return;
    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    setDisconnecting(true);
    setError(null);
    try {
      const response = await fetch('/api/kakao/disconnect', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'X-CSRF-Token': status.csrfToken },
      });
      if (!response.ok) throw new Error('disconnect_failed');
      if (!controller.signal.aborted) {
        setNotice({ kind: 'notice', text: '이 브라우저의 카카오 연결을 해제했습니다. 카카오 계정의 앱 동의 설정은 유지됩니다.' });
        setStatus(null);
        await refresh();
      }
    } catch {
      if (!controller.signal.aborted || timedOut) {
        setStatus(null);
        setError('연결 해제를 완료하지 못했습니다. 상태를 다시 확인한 뒤 시도해 주세요.');
      }
    } finally {
      window.clearTimeout(timeout);
      if (!controller.signal.aborted || timedOut || request.current !== controller) setDisconnecting(false);
    }
  };

  const connected = !!status?.connected;
  const permissionReady = connected && !!status?.messagePermission;
  const permissionUnknown = status?.reason === 'permission_check_failed';
  const settingsReady = !!status?.configured && status.reason !== 'invalid_redirect';
  const busy = loading || disconnecting;
  const loginReady = settingsReady && !busy && !error;
  const sessionEnded = status?.reason === 'session_expired' || status?.reason === 'reconnect_required';

  return <Container className="kakao-page">
    <header className="kakao-heading">
      <div><span className="eyebrow">CONNECT YOUR WORKSPACE</span><h1>기획안을 카카오톡으로.</h1><p>먼저 카카오 계정을 연결하세요. 휴대폰으로 기획안을 받는 기능은 서비스 배포와 보고서 공유 기능을 연결한 뒤 사용할 수 있습니다.</p></div>
      <a className="btn" href="#/">내 팝업으로 돌아가기 <span aria-hidden="true">↗</span></a>
    </header>

    {notice && <div className={`kakao-notice ${notice.kind}`} role="status"><span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label="안내 닫기">×</button></div>}
    {error && <div className="kakao-notice failure" role="alert"><span>{error}</span><button type="button" className="btn" onClick={() => void refresh()} disabled={busy}>다시 확인</button></div>}

    <div className="kakao-grid">
      <section className="kakao-connection" aria-labelledby="kakao-connection-heading" aria-busy={busy}>
        <div className="kakao-card-heading"><div><span className="eyebrow">CONNECTION</span><h2 id="kakao-connection-heading">카카오톡 연결</h2></div><span className={`kakao-state ${permissionReady && !error ? 'ready' : ''}`}>{loading ? '확인 중' : error || permissionUnknown ? '확인 필요' : permissionReady ? '로그인 연결됨' : connected ? '동의 필요' : '연결 전'}</span></div>
        {!status ? <div className="kakao-initial-state" role="status">{loading ? <><span className="loading-ring" />연결 상태를 확인하고 있습니다.</> : <><span className="kakao-empty-icon" aria-hidden="true">↻</span><strong>연결 상태를 확인해 주세요.</strong><p>서버가 응답하면 로그인 버튼을 사용할 수 있습니다.</p></>}</div> : <>
          <ol className="kakao-steps">
            <li className={settingsReady ? 'complete' : 'current'}>
              <span className="kakao-step-number" aria-hidden="true">{settingsReady ? '✓' : '1'}</span>
              <div><div className="kakao-step-title"><h3>연결 준비</h3><span>{settingsReady ? '완료' : '설정 확인 필요'}</span></div><p>{settingsReady ? 'Pop3D 서버에서 카카오 로그인을 시작할 수 있습니다.' : status.reason === 'invalid_redirect' ? '로그인 복귀 주소를 확인해 주세요. 개발자센터와 서버에 같은 주소가 등록되어야 합니다.' : '서버의 카카오 환경 설정을 확인한 뒤, 서버를 다시 시작해 주세요.'}</p></div>
            </li>
            <li className={permissionReady ? 'complete' : settingsReady ? 'current' : ''}>
              <span className="kakao-step-number" aria-hidden="true">{permissionReady ? '✓' : '2'}</span>
              <div><div className="kakao-step-title"><h3>카카오 로그인 · 전송 동의</h3><span>{permissionReady ? '완료' : permissionUnknown ? '동의 상태 미확인' : connected ? '전송 동의 필요' : '로그인 필요'}</span></div><p>{permissionReady ? '카카오 로그인과 카카오톡 메시지 전송 동의를 확인했습니다.' : permissionUnknown ? '카카오에서 전송 동의 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.' : connected ? '로그인되었습니다. 나와의 채팅에 기획안 링크를 보내려면 전송 동의가 필요합니다.' : sessionEnded ? '연결이 만료되었습니다. 카카오로 다시 로그인해 주세요.' : '카카오에서 로그인하고, 나와의 채팅으로 메시지를 보낼 수 있도록 동의해 주세요.'}</p>
                {!permissionReady && (permissionUnknown ? <button type="button" className="btn" onClick={() => void refresh()} disabled={busy}>동의 상태 다시 확인</button> : loginReady ? <a className="kakao-login-button" href="/api/auth/kakao/start"><TalkIcon /><span>{connected ? '카카오톡 전송에 동의하기' : '카카오 로그인'}</span></a> : <button type="button" className="kakao-login-button" disabled><TalkIcon /><span>카카오 로그인</span></button>)}
                {permissionReady && <div className="kakao-login-success"><span className="status-dot" />로그인 연결과 메시지 전송 동의 확인 완료</div>}
                {!connected && <small className="kakao-step-help">이 창에서 로그인한 뒤 Pop3D로 돌아옵니다. 로그인은 언제든 취소할 수 있습니다.</small>}
              </div>
            </li>
            <li className={status.publicUrlReady ? 'complete' : ''}>
              <span className="kakao-step-number" aria-hidden="true">{status.publicUrlReady ? '✓' : '3'}</span>
              <div><div className="kakao-step-title"><h3>휴대폰에서 열 주소 연결</h3><span>{status.publicUrlReady ? '주소 설정됨' : '배포 후 연결'}</span></div><p>{status.publicUrlReady ? '공개 서비스 주소가 설정되어 있습니다. 배치안·PDF 보관과 공유 링크, 메시지 전송 기능을 연결하는 단계가 남아 있습니다.' : '현재는 이 PC에서 실행 중입니다. 서비스 배포 후 휴대폰에서도 열 수 있는 주소와 보고서 공유 기능을 연결합니다.'}</p><div className="kakao-delivery-pending">메시지 전송 · 배포 및 공유 기능 연결 예정</div></div>
            </li>
          </ol>
          <div className="kakao-connection-footer"><button type="button" className="btn" onClick={() => void refresh()} disabled={busy}>{loading ? '상태 확인 중…' : '연결 상태 새로고침'}</button>{connected && <button type="button" className="kakao-disconnect" onClick={() => void disconnect()} disabled={busy || !status.csrfToken}>{disconnecting ? '연결 해제 중…' : '이 브라우저 연결 해제'}</button>}</div>
        </>}
      </section>

      <aside className="kakao-next" aria-labelledby="kakao-next-heading">
        <span className="kakao-local-badge">현재 단계 · 로컬 연결</span>
        <h2 id="kakao-next-heading">지금은 로그인 연결까지<br />확인합니다.</h2>
        <p>배포 전에도 카카오 로그인과 전송 동의가 정상인지 확인할 수 있습니다.</p>
        <div className="kakao-progress-summary"><span>지금 확인할 것</span><strong>{error ? '연결 상태 재확인' : permissionReady ? '카카오 연결 완료' : '계정 연결 + 메시지 동의'}</strong><span>그다음 할 것</span><strong>서비스 배포 + 공유 링크 연결</strong></div>
        <div className="kakao-privacy-note"><TalkIcon /><p>메시지는 연결한 계정의 <b>나와의 채팅</b>으로 받게 됩니다. 이 화면에서 로그인하거나 새로고침해도 메시지를 보내지 않습니다.</p></div>
        {!embedded && <a className="text-button" href="#/">연결 설정 후 작업 계속하기 <span aria-hidden="true">→</span></a>}
      </aside>
    </div>
    <p className="kakao-page-footnote">연결은 현재 브라우저 세션에 적용됩니다. 서버를 다시 시작하거나 세션이 만료되면 다시 로그인해 주세요.</p>
  </Container>;
}
