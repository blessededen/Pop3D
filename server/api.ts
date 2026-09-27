import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleKakao } from './kakao.ts';
import { handleAccounts, kakaoAccountDependencies } from './accounts.ts';
import { handleKakaoAccount } from './kakaoAccount.ts';
import { readJsonBody } from './http.ts';
import { aiProvider, interpret, type CatalogBrief, type Env } from './ai.ts';

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, env: Env): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  try {
    if (await handleKakaoAccount(req, res, env, kakaoAccountDependencies(env))) return;
    if (await handleAccounts(req, res, env)) return;
    if (await handleKakao(req, res, env)) return;
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, ai: aiProvider(env) });
    }
    if (url.pathname === '/api/ai/interpret' && req.method === 'POST') {
      const body = (await readJsonBody(req, 200_000)) as { text?: unknown; catalog?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
      const catalog = Array.isArray(body.catalog) ? (body.catalog as CatalogBrief[]).slice(0, 300) : [];
      if (!text) return send(res, 400, { error: 'empty_text' });
      if (!aiProvider(env)) return send(res, 503, { error: 'no_key' });
      try {
        const out = await interpret(text, catalog, env);
        return send(res, 200, { mode: 'ai', ...out });
      } catch (e) {
        return send(res, 502, { error: 'upstream', detail: (e as Error).message });
      }
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return send(res, status, { error: 'bad_request', detail: (e as Error).message });
  }
}
