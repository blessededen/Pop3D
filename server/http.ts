import type { IncomingMessage } from 'node:http';

/** Vercel may provide an already parsed body; plain Node/Vite provides a stream. */
export async function readJsonBody(req: IncomingMessage, max: number): Promise<unknown> {
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
  let parsed: unknown;
  try { parsed = (req as IncomingMessage & { body?: unknown }).body; }
  catch { throw fail(400, '요청 형식을 확인해 주세요.'); }
  let raw: string;
  if (parsed !== undefined) {
    raw = Buffer.isBuffer(parsed) ? parsed.toString('utf8') : typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    if (Buffer.byteLength(raw, 'utf8') > max) throw fail(413, '저장 용량을 초과했습니다. 작업을 백업한 뒤 오래된 프로젝트나 버전을 정리해 주세요.');
  } else {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk); size += buffer.length;
      if (size > max) throw fail(413, '저장 용량을 초과했습니다. 작업을 백업한 뒤 오래된 프로젝트나 버전을 정리해 주세요.');
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw fail(400, '요청 형식을 확인해 주세요.'); }
}
