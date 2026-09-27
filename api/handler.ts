import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from '../server/api.ts';

/** Vercel supplies the original URL or the rewritten function URL. Both retain
 * OAuth query parameters; the internal routing parameter is never forwarded. */
export function apiUrl(input: string) {
  const url = new URL(input, 'http://local');
  if (url.pathname === '/api/handler') {
    const path = url.searchParams.get('_pop3d_path');
    if (!path || path.length > 128 || !/^[a-zA-Z0-9/_-]+$/.test(path)) return undefined;
    url.pathname = `/api/${path}`;
  }
  url.searchParams.delete('_pop3d_path');
  return `${url.pathname}${url.search}`;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = apiUrl(req.url || '/');
  if (!url) { res.statusCode = 404; res.end(); return; }
  req.url = url;
  await handleApi(req, res, process.env);
}
