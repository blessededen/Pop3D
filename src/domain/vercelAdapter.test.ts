import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { apiUrl } from '../../api/handler';
import { readJsonBody } from '../../server/http';

const request = (text = '') => Readable.from([Buffer.from(text)]) as unknown as IncomingMessage & { body?: unknown };

describe('Vercel and local API compatibility', () => {
  it('preserves callback state and authorization query for original and rewritten URLs', () => {
    const original = '/api/auth/kakao/callback?state=account_synthetic&code=synthetic%2Bcode';
    expect(apiUrl(original)).toBe(original);
    expect(apiUrl('/api/handler?_pop3d_path=auth/kakao/callback&state=account_synthetic&code=synthetic%2Bcode')).toBe(original);
    expect(apiUrl('/api/handler?_pop3d_path=account/workspace')).toBe('/api/account/workspace');
  });
  it('does not treat arbitrary URLs or traversal as internal API routes', () => {
    expect(apiUrl('/api/handler')).toBeUndefined();
    expect(apiUrl('/api/handler?_pop3d_path=https%3A%2F%2Fexample.invalid')).toBeUndefined();
    expect(apiUrl('/api/handler?_pop3d_path=..%2Fsecrets')).toBeUndefined();
  });
  it('reads plain Node streams and Vercel parsed objects, strings and buffers', async () => {
    const data = { text: '팝업 공간' };
    const raw = JSON.stringify(data);
    expect(await readJsonBody(request(raw), 100)).toEqual(data);
    for (const parsed of [data, raw, Buffer.from(raw)]) {
      const req = request(); req.body = parsed;
      expect(await readJsonBody(req, 100)).toEqual(data);
    }
  });
  it('counts UTF-8 bytes for both request forms before accepting oversized workspaces', async () => {
    const raw = JSON.stringify({ text: '한'.repeat(50) });
    const stream = request(raw), parsed = request(); parsed.body = JSON.parse(raw);
    await expect(readJsonBody(stream, 100)).rejects.toMatchObject({ status: 413 });
    await expect(readJsonBody(parsed, 100)).rejects.toMatchObject({ status: 413 });
  });
  it('turns malformed JSON and a throwing Vercel body getter into safe 400 responses', async () => {
    await expect(readJsonBody(request('{broken'), 100)).rejects.toMatchObject({ status: 400 });
    const req = request(); Object.defineProperty(req, 'body', { get() { throw new Error('untrusted-body'); } });
    await expect(readJsonBody(req, 100)).rejects.toMatchObject({ status: 400, message: '요청 형식을 확인해 주세요.' });
  });
});
