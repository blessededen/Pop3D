import { useCallback, useEffect, useRef, useState } from 'react';
import { arrayBufferToBase64 } from './browser';

export interface KakaoStatus {
  configured: boolean;
  missing: string[];
  connected: boolean;
  csrfToken: string | null;
  messagePermission: boolean;
  canSend: boolean;
  publicUrlReady: boolean;
  reason?: string;
}

export interface KakaoReportReceipt { ok: true; url: string; expiresAt: string }
export interface KakaoReportRequest { projectId: string; version: number; pdfBase64: string; requestId: string }
export const MAX_REPORT_PDF_BYTES = 2_500_000;

const MESSAGES: Record<string, string> = {
  not_configured: '카카오톡 연결 설정을 확인해야 합니다.',
  invalid_redirect: '카카오 로그인 복귀 주소 설정을 확인해야 합니다.',
  state_invalid: '연결 요청이 만료되었습니다. 다시 연결해 주세요.',
  authorization_denied: '카카오톡 연결을 취소했습니다. 원할 때 다시 연결할 수 있습니다.',
  authorization_failed: '카카오톡 연결을 완료하지 못했습니다. 다시 연결해 주세요.',
  token_exchange_failed: '카카오톡 연결을 완료하지 못했습니다. 다시 연결해 주세요.',
  permission_check_failed: '카카오톡 전송 동의를 확인하지 못했습니다. 연결 상태를 다시 확인해 주세요.',
  temporarily_unavailable: '잠시 후 다시 시도해 주세요.',
  session_expired: '카카오톡 연결이 만료되었습니다. 다시 연결해 주세요.',
  reconnect_required: '카카오톡에 다시 연결해 주세요.',
  permission_required: '나와의 채팅으로 보내기 동의가 필요합니다. 다시 연결해 주세요.',
  not_connected: '카카오톡을 먼저 연결해 주세요.',
  login_required: 'Pop3D에 다시 로그인한 뒤 보내 주세요.',
  account_mismatch: '로그인 계정이 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.',
  account_changed: '로그인 계정이 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.',
  origin_invalid: '현재 페이지에서 요청할 수 없습니다. Pop3D 주소를 다시 열어 주세요.',
  csrf_invalid: '연결 상태가 바뀌었습니다. 상태를 다시 확인한 뒤 보내 주세요.',
  message_permission_required: '나와의 채팅으로 보내기 동의가 필요합니다. 다시 연결해 주세요.',
  different_kakao_account: 'Pop3D 로그인과 다른 카카오 계정입니다. 로그인한 카카오 계정으로 다시 연결해 주세요.',
  upstream_unavailable: '카카오톡에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  request_invalid: '보고서 전송 정보를 확인하지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.',
  request_conflict: '이전 전송 요청과 내용이 다릅니다. 새 요청으로 다시 보내 주세요.',
  send_in_progress: '이전 요청을 처리하고 있습니다. 잠시 후 전송 결과를 다시 확인해 주세요.',
  public_url_required: '카카오톡에서 열 수 있는 서비스 주소 설정이 필요합니다.',
  pdf_too_large: 'PDF 용량이 커서 카카오톡으로 보낼 수 없습니다. PDF 내려받기를 이용해 주세요.',
  project_not_found: '프로젝트를 찾지 못했습니다. 새로고침한 뒤 확인해 주세요.',
  version_not_found: '확정한 보고서를 서버에서 찾지 못했습니다. 저장 상태를 확인한 뒤 다시 시도해 주세요.',
  rate_limited: '요청이 많습니다. 잠시 후 다시 보내 주세요.',
  send_failed: '카카오톡 전송을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  connection_busy: '카카오톡 연결을 갱신하고 있습니다. 잠시 후 연결 상태를 다시 확인해 주세요.',
  message_configuration_required: '카카오 메시지 설정을 확인해야 합니다. 개발자센터의 제품 링크 웹 도메인과 메시지 전송 동의를 확인해 주세요.',
  invalid_report: '보고서 전송 정보를 확인해 주세요.',
  invalid_pdf: 'PDF를 준비하지 못했습니다. 새로고침한 뒤 다시 보내 주세요.',
  report_too_large: '보고서 자료가 커서 전송할 수 없습니다. PDF 내려받기를 이용해 주세요.',
  report_not_found: '저장된 보고서 버전을 찾지 못했습니다. 저장 상태를 확인한 뒤 다시 보내 주세요.',
  share_limit: '보관 중인 공유 보고서가 많습니다. 기존 링크를 이용하거나 만료 후 다시 보내 주세요.',
  message_send_failed: '카카오톡 전송을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  delivery_unconfirmed: '서버 응답을 받지 못했습니다. 같은 요청으로 전송 결과를 다시 확인해 주세요.',
  delivery_unknown: '이전 전송 결과를 확인할 수 없습니다. 카카오톡 나와의 채팅에서 보고서를 받았는지 확인해 주세요.',
};

export class KakaoReportError extends Error {
  code: string;
  constructor(code: string) { super(MESSAGES[code] ?? '요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'); this.code = code; }
}

export function callbackKakaoNotice(): string | null {
  const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
  if (query.get('kakao') === 'connected') return '카카오톡에서 돌아왔습니다. 연결 상태를 확인한 뒤 보내기 버튼을 눌러 주세요.';
  const error = query.get('error');
  return error ? new KakaoReportError(error).message : null;
}

export function parseKakaoStatus(value: unknown): KakaoStatus {
  if (!value || typeof value !== 'object') throw new Error('invalid_status');
  const status = value as Partial<KakaoStatus>;
  if (['configured', 'connected', 'messagePermission', 'canSend', 'publicUrlReady'].some(key => typeof status[key as keyof KakaoStatus] !== 'boolean')
    || !Array.isArray(status.missing) || !status.missing.every(item => typeof item === 'string')
    || !(status.csrfToken === null || typeof status.csrfToken === 'string')) throw new Error('invalid_status');
  return status as KakaoStatus;
}

export async function getKakaoStatus(signal?: AbortSignal): Promise<KakaoStatus> {
  const response = await fetch('/api/kakao/status', { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new Error('연결 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.');
  return parseKakaoStatus(await response.json());
}

export function useKakaoStatus() {
  const [status, setStatus] = useState<KakaoStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const timeout = window.setTimeout(() => controller.abort('timeout'), 12000);
    setLoading(true); setError('');
    try {
      const value = await getKakaoStatus(controller.signal);
      if (!controller.signal.aborted) { setStatus(value); return value; }
    } catch {
      if (pending.current === controller && (!controller.signal.aborted || controller.signal.reason === 'timeout')) {
        setStatus(null); setError('카카오톡 연결 상태를 확인하지 못했습니다. 다시 확인해 주세요.');
      }
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) setLoading(false);
    }
    return null;
  }, []);
  useEffect(() => { void refresh(); return () => pending.current?.abort(); }, [refresh]);
  return { status, loading, error, refresh };
}

export async function reportPdfBase64(blob: Blob): Promise<string> {
  if (blob.size > MAX_REPORT_PDF_BYTES) throw new KakaoReportError('pdf_too_large');
  return arrayBufferToBase64(await blob.arrayBuffer());
}

export async function postKakaoReport(request: KakaoReportRequest, accountId: string, csrfToken: string): Promise<KakaoReportReceipt> {
  let response: Response;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 45000);
  try {
    response = await fetch('/api/kakao/send', {
      method: 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Pop3D-Client': 'web', 'X-Pop3D-Account': accountId, 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(request),
    });
  } catch { throw new KakaoReportError('delivery_unconfirmed'); }
  finally { globalThis.clearTimeout(timeout); }
  let body: unknown;
  try { body = await response.json(); } catch { throw new KakaoReportError(response.status === 413 ? 'pdf_too_large' : 'delivery_unconfirmed'); }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'send_failed';
    throw new KakaoReportError(response.status === 413 ? 'pdf_too_large' : code);
  }
  if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true || !('url' in body) || typeof body.url !== 'string'
    || !('expiresAt' in body) || typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) throw new KakaoReportError('delivery_unconfirmed');
  let url: URL;
  try { url = new URL(body.url); } catch { throw new KakaoReportError('delivery_unconfirmed'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new KakaoReportError('delivery_unconfirmed');
  return { ok: true, url: url.href, expiresAt: body.expiresAt };
}
