import { useRef, useState } from 'react';
import { useStore } from '../store';
import { flushAccount, useAccount } from '../lib/account';
import { buildPdfBlob } from '../lib/exporters';
import { isDirty, latestVersion } from '../domain/version';
import { callbackKakaoNotice, KakaoReportError, postKakaoReport, reportPdfBase64, useKakaoStatus, type KakaoReportReceipt, type KakaoReportRequest } from '../lib/kakaoReport';
import './KakaoReportSend.css';

interface Props { projectId: string; disabled: boolean; onBusyChange: (busy: boolean) => void }
type Sent = KakaoReportReceipt & { version: number; hash: string };

export default function KakaoReportSend({ projectId, disabled, onBusyChange }: Props) {
  const { status, loading, error: statusError, refresh } = useKakaoStatus();
  const [notice] = useState(callbackKakaoNotice);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [phase, setPhase] = useState<'idle' | 'saving' | 'building' | 'sending' | 'connecting'>('idle');
  const [sent, setSent] = useState<Sent | null>(null);
  const lock = useRef(false);
  const pending = useRef<(KakaoReportRequest & { hash: string; owner: string }) | null>(null);
  const project = useStore(state => state.projects.find(item => item.id === projectId));
  const space = useStore(state => state.spaces.find(item => item.id === project?.spaceId));
  const vendor = useStore(state => state.vendors.find(item => item.id === project?.vendorId));
  const unchanged = !!(sent && project && space && vendor && !isDirty(project, space, vendor) && latestVersion(project)?.hash === sent.hash && latestVersion(project)?.version === sent.version);
  const busy = phase !== 'idle';
  const connectionReady = !!status?.configured && status.reason !== 'invalid_redirect';
  const retryStatus = !!status && ['connection_busy', 'permission_check_failed', 'temporarily_unavailable', 'upstream_unavailable'].includes(status.reason ?? '');
  const needsConnection = !!status && !retryStatus && (!status.connected || !status.messagePermission || ['session_expired', 'reconnect_required'].includes(status.reason ?? ''));
  const begin = () => { lock.current = true; setError(''); onBusyChange(true); };
  const finish = () => { lock.current = false; setPhase('idle'); onBusyChange(false); };

  const connect = async () => {
    if (lock.current || disabled || !connectionReady) return;
    begin(); setPhase('connecting');
    try {
      const owner = useAccount.getState().user?.id;
      if (!owner) throw new KakaoReportError('login_required');
      await flushAccount();
      if (useAccount.getState().user?.id !== owner) throw new KakaoReportError('account_mismatch');
      window.location.assign('/api/auth/kakao/start?returnTo=report');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '작업을 저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { finish(); }
  };

  const send = async () => {
    if (lock.current || disabled || !status?.canSend || unchanged) return;
    const newAttempt = errorCode === 'delivery_unknown' || errorCode === 'request_conflict';
    begin(); setPhase('saving');
    setErrorCode('');
    try {
      const owner = useAccount.getState().user?.id;
      if (!owner) throw new KakaoReportError('login_required');
      const store = useStore.getState();
      const current = store.projects.find(item => item.id === projectId);
      const currentSpace = store.spaces.find(item => item.id === current?.spaceId);
      const currentVendor = store.vendors.find(item => item.id === current?.vendorId);
      if (!current || !currentSpace || !currentVendor || store.currentProjectId !== projectId) throw new KakaoReportError('project_not_found');
      store.setViewVersion(null);
      if (isDirty(current, currentSpace, currentVendor)) {
        const result = store.confirmVersion();
        if (!result.ok) throw new Error(result.message);
      }
      const snapshot = latestVersion(useStore.getState().projects.find(item => item.id === projectId)!);
      if (!snapshot) throw new KakaoReportError('version_not_found');
      await flushAccount();
      if (useAccount.getState().user?.id !== owner) throw new KakaoReportError('account_mismatch');
      const freshStatus = await refresh();
      if (!freshStatus) throw new Error('카카오톡 연결 상태를 확인하지 못했습니다. 다시 확인해 주세요.');
      if (!freshStatus.canSend || !freshStatus.csrfToken) throw new KakaoReportError(freshStatus.reason ?? 'reconnect_required');
      if (!pending.current || pending.current.owner !== owner || pending.current.projectId !== projectId || pending.current.hash !== snapshot.hash || pending.current.version !== snapshot.version) {
        setPhase('building');
        const pdfBase64 = await reportPdfBase64(await buildPdfBlob(snapshot));
        pending.current = { projectId, version: snapshot.version, pdfBase64, requestId: crypto.randomUUID(), hash: snapshot.hash, owner };
      } else if (newAttempt) pending.current.requestId = crypto.randomUUID();
      if (useAccount.getState().user?.id !== owner) throw new KakaoReportError('account_mismatch');
      setPhase('sending');
      const { hash, owner: _owner, ...request } = pending.current;
      const receipt = await postKakaoReport(request, owner, freshStatus.csrfToken);
      setSent({ ...receipt, version: request.version, hash });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '전송을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      setErrorCode(cause instanceof KakaoReportError ? cause.code : '');
    } finally { finish(); }
  };

  const label = phase === 'connecting' ? '작업 저장 중…' : phase === 'saving' ? '보고서 저장 중…' : phase === 'building' ? 'PDF 만드는 중…' : phase === 'sending' ? '카카오톡 전송 중…' : unchanged ? '카카오톡 전송 완료' : errorCode === 'delivery_unknown' ? '카톡 미수신 확인 후 다시 보내기' : errorCode === 'request_conflict' ? '새 요청으로 다시 보내기' : ['send_in_progress', 'delivery_unconfirmed'].includes(errorCode) ? '전송 결과 다시 확인' : error && !needsConnection ? '다시 시도' : '나와의 채팅으로 보내기';
  return <section className="kakao-report-send" aria-labelledby="kakao-report-title" aria-busy={busy}>
    <div><h2 id="kakao-report-title">카카오톡으로 받기</h2><p>나와의 채팅으로 보고서 링크를 보냅니다. PDF 파일 첨부가 아닌 <b>7일간 열 수 있는 링크</b>이며, 링크를 가진 사람이 볼 수 있어요.</p></div>
    {notice && !sent && <p className="kakao-report-notice" role="status">{notice}</p>}
    {sent && <div className="kakao-report-receipt" role="status"><strong>v{sent.version} 보고서를 나와의 채팅으로 보냈습니다.</strong><span>{new Date(sent.expiresAt).toLocaleDateString('ko-KR')}까지 열 수 있어요.{!unchanged && ' 이후 수정한 내용은 다시 보내 주세요.'}</span><a href={sent.url} target="_blank" rel="noopener noreferrer">보낸 보고서 열기 ↗</a></div>}
    {(error || statusError) && <p className="kakao-report-error" role="alert">{error || statusError}</p>}
    {errorCode === 'delivery_unknown' && <p className="kakao-report-notice">이미 카카오톡에서 받았다면 다시 보내지 않아도 됩니다. 아래 버튼은 새 메시지를 전송합니다.</p>}
    <div className="kakao-report-actions">
      {needsConnection ? <button type="button" className="kakao-login-button" disabled={disabled || busy || loading || !connectionReady} onClick={() => void connect()}>{busy ? '작업 저장 중…' : '카카오톡 연결하고 돌아오기'}</button> : <button type="button" className="kakao-login-button" disabled={disabled || busy || loading || !status?.canSend || unchanged} onClick={() => void send()}>{loading && !busy ? '연결 확인 중…' : label}</button>}
      {(statusError || error || (status && !status.canSend && !needsConnection)) && <button type="button" className="text-button" disabled={busy || loading} onClick={() => void refresh()}>연결 상태 다시 확인</button>}
    </div>
    {!loading && status && !status.canSend && !statusError && (!connectionReady || !status.publicUrlReady || !needsConnection) && <p className="kakao-report-notice">{!connectionReady ? '카카오톡 서버 연결 설정을 확인해야 합니다.' : !status.publicUrlReady ? '휴대폰에서 보고서를 열 수 있는 서비스 주소 설정이 필요합니다.' : '연결 상태를 다시 확인해 주세요.'}</p>}
  </section>;
}
