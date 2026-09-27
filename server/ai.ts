// AI 조건 해석. 사용자 문장 → 예산·대여 일수·집기 요구 조건(JSON).
// 가격·치수·재고는 만들지 않는다. 결과는 클라이언트가 카탈로그와 다시 대조한다.

export interface CatalogBrief {
  sku: string;
  name: string;
  category: string;
  w: number;
  d: number;
  h: number;
}

export interface InterpretResult {
  budget: number | null;
  budgetScope: 'fixtures' | 'event_total' | null;
  rentalDays: number | null;
  items: { sku: string; required: boolean; desiredQty: number; minQty: number }[];
  unmatched: string[];
  note: string;
}

export type Env = Record<string, string | undefined>;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['budget', 'budgetScope', 'rentalDays', 'items', 'unmatched', 'note'],
  properties: {
    budget: { type: ['integer', 'null'], description: '원 단위 예산. 문장에 없으면 null' },
    budgetScope: { type: ['string', 'null'], enum: ['fixtures', 'event_total', null] },
    rentalDays: { type: ['integer', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'required', 'desiredQty', 'minQty'],
        properties: {
          sku: { type: 'string' },
          required: { type: 'boolean' },
          desiredQty: { type: 'integer' },
          minQty: { type: 'integer' },
        },
      },
    },
    unmatched: { type: 'array', items: { type: 'string' } },
    note: { type: 'string', description: '해석하면서 가정한 내용. 없으면 빈 문자열' },
  },
} as const;

function systemPrompt(catalog: CatalogBrief[]): string {
  const lines = catalog.map((c) => `- ${c.sku} | ${c.name} | 종류 ${c.category} | ${c.w}×${c.d}×${c.h}m`).join('\n');
  return [
    '너는 팝업 매장 집기 견적 도구의 입력 해석기다.',
    '사용자 문장에서 예산(원), 예산 범위, 대여 일수, 필요한 집기를 뽑아 JSON으로만 답한다.',
    '- budgetScope: 집기·운송·설치·철거 예산이면 fixtures, 임차료·인건비까지 포함한 전체 행사비면 event_total, 알 수 없으면 null.',
    '- 집기는 아래 카탈로그의 sku만 쓴다. 같은 종류가 여러 규격이면 문장에 맞는 규격, 언급이 없으면 목록에서 먼저 나온 규격을 고른다.',
    '- "꼭", "필수", "반드시" 등은 required=true. 필수가 아니면 minQty=0.',
    '- 수량을 "최대 N개"나 범위로 말하면 desiredQty는 최대값, minQty는 최소값. 수량 언급이 없으면 desiredQty=1.',
    '- 카탈로그에 없는 요청은 unmatched에 원문 표현 그대로 넣는다.',
    '- 가격·치수·재고는 만들지 않는다. 문장에 없는 값은 null.',
    '',
    '카탈로그:',
    lines,
  ].join('\n');
}

function sanitize(raw: unknown, catalog: CatalogBrief[]): InterpretResult {
  const r = (raw ?? {}) as Partial<InterpretResult>;
  const skus = new Set(catalog.map((c) => c.sku));
  const int = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null;
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    budget: int(r.budget, 0, 10_000_000_000),
    budgetScope: r.budgetScope === 'fixtures' || r.budgetScope === 'event_total' ? r.budgetScope : null,
    rentalDays: int(r.rentalDays, 1, 365),
    items: items
      .filter((i) => i && typeof i.sku === 'string' && skus.has(i.sku))
      .map((i) => {
        const desiredQty = int(i.desiredQty, 0, 50) ?? 1;
        return {
          sku: i.sku,
          required: !!i.required,
          desiredQty,
          minQty: Math.min(desiredQty, int(i.minQty, 0, 50) ?? 0),
        };
      }),
    unmatched: Array.isArray(r.unmatched) ? r.unmatched.filter((s) => typeof s === 'string').slice(0, 20) : [],
    note: typeof r.note === 'string' ? r.note.slice(0, 500) : '',
  };
}

export function aiProvider(env: Env): 'anthropic' | 'openai' | null {
  const want = env.AI_PROVIDER?.trim().toLowerCase();
  if (want === 'openai' && env.OPENAI_API_KEY) return 'openai';
  if (want === 'anthropic' && env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return null;
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function interpret(
  text: string,
  catalog: CatalogBrief[],
  env: Env,
): Promise<{ provider: string; model: string; result: InterpretResult }> {
  const provider = aiProvider(env);
  if (!provider) throw Object.assign(new Error('AI 키가 설정되지 않았습니다.'), { code: 'no_key' });
  const system = systemPrompt(catalog);

  if (provider === 'anthropic') {
    const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5';
    const json = (await post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
      {
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: text }],
        tools: [{ name: 'set_conditions', description: '해석한 조건을 기록한다.', input_schema: SCHEMA }],
        tool_choice: { type: 'tool', name: 'set_conditions' },
      },
    )) as { content?: { type: string; input?: unknown }[] };
    const use = json.content?.find((c) => c.type === 'tool_use');
    if (!use) throw new Error('AI 응답에 구조화된 결과가 없습니다.');
    return { provider, model, result: sanitize(use.input, catalog) };
  }

  const model = env.OPENAI_MODEL || 'gpt-5-mini';
  const json = (await post(
    'https://api.openai.com/v1/chat/completions',
    { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'conditions', strict: true, schema: SCHEMA } },
    },
  )) as { choices?: { message?: { content?: string; refusal?: string } }[] };
  const msg = json.choices?.[0]?.message;
  if (!msg?.content) throw new Error(msg?.refusal || 'AI 응답이 비어 있습니다.');
  return { provider, model, result: sanitize(JSON.parse(msg.content), catalog) };
}
