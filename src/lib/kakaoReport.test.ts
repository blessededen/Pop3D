import { afterEach, describe, expect, it, vi } from 'vitest';
import { callbackKakaoNotice, isUsableReportUrl, MAX_REPORT_PDF_BYTES, parseKakaoStatus, postKakaoReport, reportPdfBase64 } from './kakaoReport';

const request = { projectId: 'project-one', version: 3, pdfBase64: 'JVBERg==', requestId: 'request-one' };
const receipt = { ok: true, url: `https://pop3-d.vercel.app/#/shared/${'a'.repeat(43)}`, expiresAt: '2026-10-07T00:00:00.000Z' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe('Kakao report delivery client', () => {
  it('binds a confirmed report version to the current account and CSRF token', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(receipt)); vi.stubGlobal('fetch', fetcher);
    expect(await postKakaoReport(request, 'owner-one', 'csrf-one')).toEqual(receipt);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/api/kakao/send');
    expect(options.credentials).toBe('same-origin');
    expect(options.headers).toMatchObject({ 'X-Pop3D-Client': 'web', 'X-Pop3D-Account': 'owner-one', 'X-CSRF-Token': 'csrf-one' });
    expect(JSON.parse(options.body)).toEqual(request);
  });

  it('keeps the same request identifier on a retry, allowing server deduplication', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ error: 'send_in_progress' }, 409)).mockResolvedValueOnce(response(receipt)); vi.stubGlobal('fetch', fetcher);
    await expect(postKakaoReport(request, 'owner-one', 'csrf-one')).rejects.toMatchObject({ code: 'send_in_progress' });
    await expect(postKakaoReport(request, 'owner-one', 'csrf-two')).resolves.toEqual(receipt);
    expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).requestId)).toEqual(['request-one', 'request-one']);
  });

  it('reports an uncertain outcome after a lost response and never retries automatically', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network disconnected')); vi.stubGlobal('fetch', fetcher);
    await expect(postKakaoReport(request, 'owner-one', 'csrf-one')).rejects.toMatchObject({ code: 'delivery_unconfirmed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit delivery errors without displaying arbitrary server messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: 'message_permission_required', message: 'private upstream payload' }, 403)));
    await expect(postKakaoReport(request, 'owner-one', 'csrf-one')).rejects.toMatchObject({ code: 'message_permission_required', message: '나와의 채팅으로 보내기 동의가 필요합니다. 다시 연결해 주세요.' });
  });

  it.each([{ ok: false }, { ...receipt, expiresAt: 'invalid' }])('rejects a malformed success receipt: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
    await expect(postKakaoReport(request, 'owner-one', 'csrf-one')).rejects.toMatchObject({ code: 'delivery_unconfirmed' });
  });

  it.each(['http://127.0.0.1:5174', 'https://127.0.0.1', 'https://192.168.1.2', 'https://pop3d.local', 'https://user:password@pop3-d.vercel.app'])('rejects a local or credential-bearing receipt on the deployed site: %s', async origin => {
    vi.stubGlobal('window', { location: { origin: 'https://pop3-d.vercel.app' } });
    const fetcher = vi.fn().mockResolvedValue(response({ ...receipt, url: `${origin}/#/shared/${'a'.repeat(43)}` }));
    vi.stubGlobal('fetch', fetcher);
    await expect(postKakaoReport(request, 'owner-one', 'csrf-one')).rejects.toMatchObject({ code: 'report_link_invalid' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('only allows local preview links on the matching local origin, preserving the complete report route', () => {
    const local = `http://127.0.0.1:5175/#/shared/${'a'.repeat(43)}`;
    expect(isUsableReportUrl(local, 'http://127.0.0.1:5175')).toBe(true);
    expect(isUsableReportUrl(local, 'http://127.0.0.1:5174')).toBe(false);
    expect(isUsableReportUrl('https://pop3-d.vercel.app/')).toBe(false);
    expect(isUsableReportUrl('javascript:alert(1)')).toBe(false);
    expect(isUsableReportUrl(receipt.url.replace('#/shared/', '?next=#/shared/'))).toBe(false);
    expect(isUsableReportUrl(receipt.url)).toBe(true);
  });

  it('handles a provider HTML size error without claiming success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Payload too large', { status: 413 })));
    await expect(postKakaoReport(request, 'owner-one', 'csrf-one')).rejects.toMatchObject({ code: 'pdf_too_large' });
  });

  it('rejects an oversized PDF before encoding or uploading', async () => {
    const blob = new Blob([new Uint8Array(MAX_REPORT_PDF_BYTES + 1)], { type: 'application/pdf' });
    await expect(reportPdfBase64(blob)).rejects.toMatchObject({ code: 'pdf_too_large' });
    expect(await reportPdfBase64(new Blob(['%PDF']))).toBe('JVBERg==');
  });

  it('does not send anything when parsing an OAuth return or connection status', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('window', { location: { hash: '#/report?kakao=connected' } });
    expect(callbackKakaoNotice()).toContain('보내기 버튼');
    expect(parseKakaoStatus({ configured: true, missing: [], connected: true, csrfToken: 'token', messagePermission: true, canSend: true, publicUrlReady: true }).canSend).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
