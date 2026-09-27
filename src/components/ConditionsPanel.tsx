import { useState } from 'react';
import { unitPrice, won } from '../domain/cost';
import { applyInterpretation, type InterpretResult } from '../domain/interpret';
import { daysInclusive } from '../domain/seed';
import { CATEGORY_LABEL, type Category, type PriceStatus, type Project, type Space, type Vendor } from '../domain/types';
import { interpretText, type InterpretResponse } from '../lib/aiClient';
import { useStore } from '../store';
import { Field, NumInput, Stepper, TextInput, manwon } from './ui';
import CustomFixtureDialog from './CustomFixtureDialog';

interface Props {
  project: Project;
  space: Space;
  vendor: Vendor;
  readOnly: boolean;
  guided?: boolean;
  onEditSpace?: () => void;
}

export default function ConditionsPanel({ project, space, vendor, readOnly, guided = false }: Props) {
  const [customFor, setCustomFor] = useState<number | null>(null);
  const spaces = useStore((s) => s.spaces);
  const vendors = useStore((s) => s.vendors);
  const spaceOptions = readOnly ? [space] : spaces;
  const vendorOptions = readOnly ? [vendor] : vendors;
  const update = useStore((s) => s.updateProject);
  const runPlan = useStore((s) => s.runPlan);
  const toast = useStore((s) => s.toast);

  const cats = [...new Set(vendor.items.map((i) => i.category))] as Category[];
  const unusedCats = cats.filter(c => vendor.items.some(i => i.category === c && !project.requirements.some(r => r.sku === i.sku)));
  const ev = project.event;
  const autoDays = daysInclusive(ev.startDate, ev.endDate);

  const setEvent = (patch: Partial<Project['event']>) =>
    update((p) => {
      Object.assign(p.event, patch);
      const d = daysInclusive(p.event.startDate, p.event.endDate);
      if (d != null) p.event.rentalDays = d;
    });

  const basicSettings = (<>
      {!readOnly && <InterpretBox project={project} vendor={vendor} guided={guided} />}

      <details className="panel condition-group" open={!guided}>
        <summary>{guided ? '공간·카탈로그 변경' : '기본 조건'}</summary>
        <div className="stack condition-group-body">
          {!guided && <div className="grid2">
            <Field label="행사명">
              <TextInput value={ev.title} onChange={(v) => setEvent({ title: v })} />
            </Field>
            <Field label="브랜드">
              <TextInput value={ev.brand} onChange={(v) => setEvent({ brand: v })} />
            </Field>
          </div>}

          <Field label="등록 공간">
            <select
              className="input"
              value={project.spaceId}
              onChange={(e) =>
                update((p) => {
                  p.spaceId = e.target.value;
                })
              }
            >
              {spaceOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.width}×{s.depth}m){s.isVirtual ? ' · 가상' : ''}
                </option>
              ))}
            </select>
          </Field>
          {!guided && <div className="row wrap">
            {space.isVirtual && <span className="chip accent">가상 검증 공간</span>}
            <span className={`chip ${space.status.scaleConfirmed ? 'ok' : 'warn'}`}>{space.status.scaleConfirmed ? '축척 확인' : '축척 미확인'}</span>
            <span className={`chip ${space.status.fieldMeasured ? 'ok' : ''}`}>{space.status.fieldMeasured ? '실측 대조 완료' : '실측 대조 전'}</span>
          </div>}
          <Field label="집기 업체 카탈로그">
            <select
              className="input"
              value={project.vendorId}
              onChange={(e) =>
                update((p) => {
                  const v = vendors.find((x) => x.id === e.target.value)!;
                  p.vendorId = v.id;
                  p.fees = v.services.map((f) => ({ ...f }));
                })
              }
            >
              {vendorOptions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.items.length}개 품목
                </option>
              ))}
            </select>
          </Field>
        </div>
      </details>

  </>);
  const extraSettings = (<>
      <details className="panel condition-group">
        <summary>{guided ? '대여 기간' : '세부 일정'} <span className="small muted">· {ev.rentalDays}일 대여</span></summary>
        <div className="stack condition-group-body">
          <div className="grid2">
            <Field label="시작일">
              <TextInput type="date" value={ev.startDate} onChange={(v) => setEvent({ startDate: v })} />
            </Field>
            <Field label="종료일">
              <TextInput type="date" value={ev.endDate} onChange={(v) => setEvent({ endDate: v })} />
            </Field>
          </div>
          <div className="row">
            <Field label="대여 일수" className="grow">
              {autoDays != null ? (
                <div className="input num" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', background: 'var(--soft)' }}>
                  {autoDays}일 (날짜 기준)
                </div>
              ) : (
                <NumInput value={ev.rentalDays} min={1} max={365} onChange={(v) => setEvent({ rentalDays: v ?? 1 })} />
              )}
            </Field>
            {!guided && <Field label="담당 연락처" className="grow">
              <TextInput value={ev.contact} placeholder="선택" onChange={(v) => setEvent({ contact: v })} />
            </Field>}
          </div>
          {!guided && <div className="grid2">
            <Field label="반입·설치">
              <TextInput value={ev.moveIn} placeholder="예: 10/14 22시~" onChange={(v) => setEvent({ moveIn: v })} />
            </Field>
            <Field label="철거">
              <TextInput value={ev.teardown} placeholder="예: 10/21 21시~" onChange={(v) => setEvent({ teardown: v })} />
            </Field>
          </div>}
        </div>
      </details>

      {!guided && <FeesPanel project={project} />}

      {!guided && <details className="panel condition-group">
        <summary>요청 메모</summary>
        <div className="condition-group-body">
        <TextInput
          multiline
          value={project.memo}
          placeholder="사내 검토 또는 업체 협의 사항 (기획보고서에 포함)"
          onChange={(v) =>
            update((p) => {
              p.memo = v;
            })
          }
        />
        <div style={{ height: 8 }} />
        <TextInput
          multiline
          value={ev.conditions}
          placeholder="반입 동선, 엘리베이터, 주차 등 추가 조건"
          onChange={(v) => setEvent({ conditions: v })}
        />
        </div>
      </details>}
  </>);

  const budgetScopeSelector = (
          <div className="seg" role="radiogroup" aria-label="예산 범위">
            {(
              [
                ['fixtures', '집기·운송·설치·철거'],
                ['event_total', '전체 행사비'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={project.budget.scope === k}
                className={project.budget.scope === k ? 'on' : ''}
                onClick={() =>
                  update((p) => {
                    p.budget.scope = k;
                  })
                }
              >
                {l}
              </button>
            ))}
          </div>
  );

  return (
    <fieldset className={`conditions-panel ${guided ? 'simple-conditions' : ''}`} disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {!guided && basicSettings}

      <section className="panel">
        <h3>예산</h3>
        <div className="stack">
          <Field label={`금액 ${project.budget.amount != null ? `· ${manwon(project.budget.amount)}` : ''}`}>
            <NumInput
              money
              allowNull
              min={0}
              placeholder="미입력"
              value={project.budget.amount}
              onChange={(v) =>
                update((p) => {
                  p.budget.amount = v;
                })
              }
            />
          </Field>
          {guided ? <details className="simple-budget-options"><summary>예산 범위 · {project.budget.scope === 'fixtures' ? '집기 비용' : '전체 행사비'}</summary>{budgetScopeSelector}</details> : budgetScopeSelector}
          {project.budget.scope === 'event_total' && (
            <div className="note warn">전체 행사비(임차료·인건비 포함)는 집기 비용과 바로 비교할 수 없어 수량 자동 조정을 하지 않습니다. 집기에 쓸 금액을 따로 넣으세요.</div>
          )}
        </div>
      </section>

      <details className="panel condition-group" open>
        <summary>집기 구성 <span className="small muted">· {project.requirements.length}종</span></summary>
        <div className="condition-group-body">
        <div className="panel-head">
          <span className="small muted">{guided ? '필요한 수량을 정하세요' : '필수 품목과 수량을 정하세요'}</span>
          {!guided && unusedCats.length > 0 && (
            <select
              className="input sm"
              style={{ width: 'auto' }}
              value=""
              onChange={(e) => {
                const c = e.target.value as Category;
                const it = vendor.items.find(i => i.category === c && !project.requirements.some(r => r.sku === i.sku));
                if (!it) return;
                update((p) => {
                  p.requirements.push({ category: c, sku: it.sku, required: false, minQty: 0, desiredQty: 1, priority: 2 });
                });
              }}
            >
              <option value="">+ 종류 추가</option>
              {unusedCats.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          )}
        </div>
        {project.requirements.length === 0 && <p className="hint">필요한 집기 종류를 추가하세요.</p>}
        {project.requirements.map((r, idx) => {
          const specs = vendor.items.filter(i => i.category === r.category && (i.sku === r.sku || !project.requirements.some(other => other.sku === i.sku)));
          const it = vendor.items.find((i) => i.sku === r.sku);
          const u = it ? unitPrice(it, ev.rentalDays) : null;
          if (guided) return <div className="simple-requirement" key={`${r.sku}-${idx}`}>
            <div className="simple-requirement-main"><div><strong>{it?.name ?? CATEGORY_LABEL[r.category]}</strong><span className="small muted">{it ? `${Math.round(it.w * 100)} × ${Math.round(it.d * 100)} cm` : '규격 확인 필요'}{r.required ? ' · 필수' : ''}</span></div><Stepper ariaLabel={`${it?.name ?? CATEGORY_LABEL[r.category]} 수량`} value={r.desiredQty} min={r.required ? Math.max(1, r.minQty) : r.minQty} max={50} onChange={value => update(p => { p.requirements[idx].desiredQty = value; })} /></div>
            <details className="simple-item-options"><summary>규격·배치 옵션</summary><div className="stack">
              <Field label="규격"><select className="input sm" value={r.sku} onChange={event => update(p => { p.requirements[idx].sku = event.target.value; })}>{specs.map(spec => <option key={spec.sku} value={spec.sku}>{spec.name} · {Math.round(spec.w * 100)} × {Math.round(spec.d * 100)} × {Math.round(spec.h * 100)} cm</option>)}</select></Field>
              <button type="button" className="btn sm" onClick={() => setCustomFor(idx)}>다른 규격 직접 입력</button>
              <label className="check"><input type="checkbox" checked={r.required} onChange={event => update(p => { const q = p.requirements[idx]; q.required = event.target.checked; if (q.required) { q.minQty = Math.max(1, q.minQty); q.desiredQty = Math.max(q.desiredQty, q.minQty); q.priority = 1; } })} />반드시 포함할 집기</label>
              <div className="grid2"><Field label="최소 수량"><Stepper ariaLabel={`${it?.name ?? CATEGORY_LABEL[r.category]} 최소 수량`} value={r.minQty} min={r.required ? 1 : 0} max={r.desiredQty} onChange={value => update(p => { p.requirements[idx].minQty = value; })} /></Field><Field label="우선순위"><select className="input sm" value={r.priority} onChange={event => update(p => { p.requirements[idx].priority = Number(event.target.value); })}><option value={1}>높음</option><option value={2}>보통</option><option value={3}>낮음</option></select></Field></div>
              {u && <span className="small muted">{u.unit == null ? '단가 미확인' : `${won(u.unit)}/개`}</span>}
              <button type="button" className="btn ghost sm danger" onClick={() => update(p => { p.requirements.splice(idx, 1); })}>구성에서 제외</button>
            </div></details>
          </div>;
          return (
            <div className="req-row" key={`${r.sku}-${idx}`}>
              <div className="row">
                <strong>{CATEGORY_LABEL[r.category]}</strong>
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={r.required}
                    onChange={(e) =>
                      update((p) => {
                        const q = p.requirements[idx];
                        q.required = e.target.checked;
                        if (q.required) {
                          q.minQty = Math.max(1, q.minQty);
                          q.desiredQty = Math.max(q.desiredQty, q.minQty);
                          q.priority = 1;
                        }
                      })
                    }
                  />
                  필수
                </label>
                <span className="grow" />
                {u && <span className="small muted num">{u.unit == null ? '단가 미확인' : `${won(u.unit)}/개`}</span>}
              </div>
              <button
                type="button"
                className="btn ghost sm icon-btn"
                aria-label={`${CATEGORY_LABEL[r.category]} 삭제`}
                onClick={() =>
                  update((p) => {
                    p.requirements.splice(idx, 1);
                  })
                }
              >
                ✕
              </button>
              <select
                className="input sm"
                style={{ gridColumn: '1 / -1' }}
                value={r.sku}
                onChange={(e) =>
                  update((p) => {
                    p.requirements[idx].sku = e.target.value;
                  })
                }
              >
                {specs.map((s) => (
                  <option key={s.sku} value={s.sku}>
                    {s.name} · {Math.round(s.w * 100)} × {Math.round(s.d * 100)} × {Math.round(s.h * 100)} cm
                  </option>
                ))}
              </select>
              <button type="button" className="btn sm custom-size-action" style={{ gridColumn: '1 / -1' }} onClick={() => setCustomFor(idx)}>원하는 규격이 없나요? 직접 입력</button>
              <div className="req-grid">
                <Field label="수량">
                  <Stepper
                    value={r.desiredQty}
                    min={r.required ? Math.max(1, r.minQty) : r.minQty}
                    max={50}
                    onChange={(v) =>
                      update((p) => {
                        p.requirements[idx].desiredQty = v;
                      })
                    }
                  />
                </Field>
                <details className="requirement-advanced"><summary>최소 수량 · 우선순위</summary><div className="grid2">
                <Field label="최소 수량">
                  <Stepper
                    value={r.minQty}
                    min={r.required ? 1 : 0}
                    max={r.desiredQty}
                    onChange={(v) =>
                      update((p) => {
                        p.requirements[idx].minQty = v;
                      })
                    }
                  />
                </Field>
                <Field label="우선순위">
                  <select
                    className="input sm"
                    value={r.priority}
                    onChange={(e) =>
                      update((p) => {
                        p.requirements[idx].priority = Number(e.target.value);
                      })
                    }
                  >
                    <option value={1}>1 높음</option>
                    <option value={2}>2 보통</option>
                    <option value={3}>3 낮음</option>
                  </select>
                </Field>
                </div></details>
              </div>
            </div>
          );
        })}
        {!guided && <p className="hint" style={{ marginTop: 8 }}>
          예산을 넘으면 필수가 아닌 항목부터, 우선순위가 낮은 순서로 수량을 줄입니다. 필수 항목은 줄이거나 빼지 않습니다.
        </p>}
        </div>
      </details>
        <button
          type="button"
          className="btn accent block lg planner-action"
          style={{ marginTop: 10 }}
          onClick={() => {
            const r = runPlan();
            if (window.matchMedia('(max-width: 860px)').matches) requestAnimationFrame(() => document.getElementById('layout-result')?.scrollIntoView({ block: 'start' }));
            if (r && !r.ok) toast('조건을 만족하는 배치안을 만들지 못했습니다. 이유를 확인하세요.', 'warn');
          }}
        >
          {guided ? '자동 배치' : '배치안 제안'}
        </button>

      {guided ? <details className="panel simple-advanced"><summary>대여 기간·추가 설정</summary><div className="simple-advanced-body">{extraSettings}{basicSettings}</div></details> : extraSettings}
      {customFor != null && <CustomFixtureDialog vendor={vendor} source={vendor.items.find(i => i.sku === project.requirements[customFor]?.sku)} mode="resize" onClose={() => setCustomFor(null)} onCreated={sku => { const index = customFor; setCustomFor(null); update(p => { if (p.requirements[index]) p.requirements[index].sku = sku; }); toast(guided ? '새 규격을 선택했습니다. 자동 배치로 적용하세요.' : '새 규격을 선택했습니다. 배치안 제안으로 적용하세요.'); }} />}
    </fieldset>
  );
}

function FeesPanel({ project }: { project: Project }) {
  const update = useStore((s) => s.updateProject);
  return (
    <details className="panel condition-group">
      <summary>부대 비용 <span className="small muted">· {project.fees.length}항목</span></summary>
      <div className="condition-group-body">
      <div className="panel-head">
        <span className="small muted">운송·설치·철거</span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() =>
            update((p) => {
              p.fees.push({ id: `fee-${Date.now().toString(36)}`, kind: 'other', label: '기타 비용', amount: null, status: 'unknown', basis: '', source: '', vatIncluded: null });
            })
          }
        >
          + 항목
        </button>
      </div>
      <div className="stack">
        {project.fees.map((f, idx) => (
          <div key={f.id} className="req-row">
            <TextInput
              className="sm"
              value={f.label}
              ariaLabel="비용 항목명"
              onChange={(v) =>
                update((p) => {
                  p.fees[idx].label = v;
                })
              }
            />
            <button
              type="button"
              className="btn ghost sm icon-btn"
              aria-label="삭제"
              onClick={() =>
                update((p) => {
                  p.fees.splice(idx, 1);
                })
              }
            >
              ✕
            </button>
            <div className="req-grid" style={{ gridTemplateColumns: '1.3fr 1fr' }}>
              <NumInput
                money
                allowNull
                min={0}
                className="sm"
                placeholder="미확인"
                value={f.amount}
                ariaLabel={`${f.label} 금액`}
                onChange={(v) =>
                  update((p) => {
                    p.fees[idx].amount = v;
                    if (v == null) p.fees[idx].status = 'unknown';
                    else if (p.fees[idx].status === 'unknown') p.fees[idx].status = 'estimated';
                  })
                }
              />
              <select
                className="input sm"
                value={f.amount == null ? 'unknown' : f.status}
                aria-label={`${f.label} 상태`}
                onChange={(e) =>
                  update((p) => {
                    const st = e.target.value as PriceStatus;
                    p.fees[idx].status = st;
                    if (st === 'unknown') p.fees[idx].amount = null;
                  })
                }
              >
                <option value="confirmed">확인</option>
                <option value="estimated">추정</option>
                <option value="unknown">미확인</option>
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }} className="small muted">
              {f.basis || '기준 미기재'}
              {f.source ? ` · ${f.source}` : ''}
            </div>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        금액을 비우면 ‘미확인’으로 남고 합계에 0원으로 더하지 않습니다.
      </p>
      </div>
    </details>
  );
}

function InterpretBox({ project, vendor, guided = false }: { project: Project; vendor: Vendor; guided?: boolean }) {
  const update = useStore((s) => s.updateProject);
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<InterpretResponse | null>(null);

  const preview = res ? applyInterpretation(res.result as InterpretResult, vendor.items, project.requirements, project.budget) : null;

  const run = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setRes(null);
    try {
      setRes(await interpretText(text, vendor.items, project.requirements));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!preview) return;
    update((p) => {
      p.requirements = preview.requirements;
      p.budget = preview.budget;
      if (preview.rentalDays != null && !(p.event.startDate && p.event.endDate)) p.event.rentalDays = preview.rentalDays;
    });
    toast(`조건을 반영했습니다. ‘${guided ? '자동 배치' : '배치안 제안'}’를 눌러 배치를 다시 만드세요.`);
    setRes(null);
    setText('');
  };

  return (
    <details className="panel condition-group">
      <summary>문장으로 빠르게 시작</summary>
      <div className="stack">
        <textarea
          className="input"
          rows={3}
          value={text}
          placeholder="예: 의류 팝업 7일, 집기 예산 90만원. 카운터랑 포토존은 꼭, 행거는 최대 4개"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run();
          }}
        />
        <button type="button" className="btn" onClick={run} disabled={busy || !text.trim()}>
          {busy ? '해석 중…' : '해석하기'}
        </button>
        {res && preview && (
          <div className="stack">
            <div className="row wrap">
              {res.mode === 'ai' ? <span className="chip blue">AI 해석 · {res.model}</span> : <span className="chip warn">예시 모드(규칙 기반)</span>}
            </div>
            {res.fallbackReason && <div className="hint">{res.fallbackReason}</div>}
            {preview.changes.length ? (
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {preview.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <div className="note">문장에서 반영할 조건을 찾지 못했습니다.</div>
            )}
            {res.result.unmatched.length > 0 && <div className="note warn">카탈로그에 없는 요청: {res.result.unmatched.join(', ')}</div>}
            {res.result.note && <div className="hint">{res.result.note}</div>}
            <div className="row">
              <button type="button" className="btn primary sm" onClick={apply} disabled={!preview.changes.length}>
                조건에 적용
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setRes(null)}>
                취소
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
