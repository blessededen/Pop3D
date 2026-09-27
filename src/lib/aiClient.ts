import { ruleInterpret, type InterpretResult } from '../domain/interpret';
import type { CatalogItem, Requirement } from '../domain/types';

export interface InterpretResponse {
  mode: 'ai' | 'rule';
  provider?: string;
  model?: string;
  result: InterpretResult;
  fallbackReason?: string;
}

let health: Promise<string | null> | null = null;

/** 서버에 설정된 AI 제공자. 서버가 없거나(정적 배포) 키가 없으면 null */
export function aiAvailable(): Promise<string | null> {
  health ??= fetch('/api/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.ai as string) ?? null)
    .catch(() => null);
  return health;
}

/** 서버 AI로 해석하고, 키가 없거나 실패하면 규칙 기반(예시 모드)으로 대신한다. */
export async function interpretText(text: string, catalog: CatalogItem[], current: Requirement[]): Promise<InterpretResponse> {
  const brief = catalog.map(({ sku, name, category, w, d, h }) => ({ sku, name, category, w, d, h }));
  if (!(await aiAvailable())) {
    return { mode: 'rule', result: ruleInterpret(text, catalog, current), fallbackReason: '서버에 AI 키가 없어 예시 모드(규칙 기반)로 해석했습니다.' };
  }
  let reason = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    const res = await fetch('/api/ai/interpret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, catalog: brief }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const json = await res.json().catch(() => null);
    if (res.ok && json?.mode === 'ai') {
      return { mode: 'ai', provider: json.provider, model: json.model, result: json.result };
    }
    reason =
      json?.error === 'no_key'
        ? '서버에 AI 키가 없어 예시 모드로 해석했습니다.'
        : `AI 응답 실패(${json?.detail ?? res.status}) — 예시 모드로 해석했습니다.`;
  } catch (e) {
    reason =
      (e as Error).name === 'AbortError'
        ? 'AI 응답이 늦어 예시 모드로 해석했습니다. 다시 시도할 수 있습니다.'
        : 'AI 서버에 연결하지 못해 예시 모드로 해석했습니다.';
  }
  return { mode: 'rule', result: ruleInterpret(text, catalog, current), fallbackReason: reason };
}
