import { useState } from 'react';
import { computeCost, specText, unitPrice, won, type CostSummary } from '../domain/cost';
import type { Issue } from '../domain/validate';
import { CATEGORY_LABEL, type LayoutData, type Project, type VersionSnapshot } from '../domain/types';
import { snapshotData } from '../domain/version';
import { fixtureHeightStatus } from '../domain/placementRules';
import CustomFixtureDialog from './CustomFixtureDialog';
import { exportLayoutGlbFile, exportPdf } from '../lib/exporters';
import { canShareFiles } from '../lib/browser';
import { fmtDateTime } from '../pdf/format';
import { useStore } from '../store';
import { NumInput, StatusChip } from './ui';

// ---------------------------------------------------------------- 선택한 집기
export function Inspector({ data, issues, readOnly, compact = false }: { data: LayoutData; issues: Issue[]; readOnly: boolean; compact?: boolean }) {
  const selectedId = useStore((s) => s.selectedId);
  const s = useStore.getState();
  const p = data.placements.find((x) => x.id === selectedId);
  if (!p) {
    return (
      <section className="panel inspector-empty">
        <div className="inspector-glyph" aria-hidden="true">↖</div>
        <h3>집기를 선택해 살펴보세요</h3>
        <p className="hint">평면도나 3D에서 집기를 누르면 치수와 비용을 확인할 수 있습니다.</p>
        {!readOnly && (
          <div className="inspector-steps">
            <span><kbd>드래그</kbd> 위치 이동 · 5cm 단위</span>
            <span><kbd>R</kbd> 90° 회전</span>
            <span><kbd>Ctrl Z</kbd> 이전 배치로 복구</span>
          </div>
        )}
        {!readOnly && <AddItem data={data} />}
      </section>
    );
  }
  const it = data.vendor.items.find((i) => i.sku === p.sku);
  const no = data.placements.indexOf(p) + 1;
  const mine = issues.filter((i) => i.placementIds.includes(p.id));
  const specs = it ? data.vendor.items.filter((i) => i.category === it.category) : [];
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>
          {no}번 · {it?.name ?? p.sku}
        </h3>
        <button className="btn ghost sm" onClick={() => s.select(null)}>
          선택 해제
        </button>
      </div>
      <fieldset disabled={readOnly} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        {it && (
          <div className="small muted">
            {it.sku} · {CATEGORY_LABEL[it.category]} · {specText(it)}
            {it.setComponents ? ` · 세트: ${it.setComponents}` : ''}
          </div>
        )}
        {!readOnly && !compact && <CustomSizeAction data={data} sku={p.sku} onCreated={(sku) => s.swapSku(p.id, sku)} />}
        <details className="inspector-options" open={compact ? undefined : true}>
        <summary>다른 규격 · 정밀 설정</summary>
        <div className="stack">
        {!readOnly && compact && <CustomSizeAction data={data} sku={p.sku} onCreated={(sku) => s.swapSku(p.id, sku)} />}
        <label className="field">
          <span>다른 규격으로 교체</span>
          <select className="input" value={p.sku} onChange={(e) => s.swapSku(p.id, e.target.value)}>
            {specs.map((x) => {
              const u = unitPrice(x, data.event.rentalDays);
              return (
                <option key={x.sku} value={x.sku} disabled={fixtureHeightStatus(data.space, x).blocked}>
                  {x.sku} · {x.name} · {specText(x)} · {u.unit == null ? '단가 미확인' : won(u.unit)}
                  {fixtureHeightStatus(data.space, x).blocked ? ' · 반입 불가' : ''}
                </option>
              );
            })}
          </select>
        </label>
        <div className="grid2">
          <label className="field">
            <span>왼쪽 벽 → 중심 (m)</span>
            <NumInput value={p.x} onChange={(v) => v != null && (s.checkpoint(), s.movePlacement(p.id, v, p.y))} />
          </label>
          <label className="field">
            <span>위쪽 벽 → 중심 (m)</span>
            <NumInput value={p.y} onChange={(v) => v != null && (s.checkpoint(), s.movePlacement(p.id, p.x, v))} />
          </label>
        </div>
        <div className="row wrap">
          <span className="small muted">회전 {p.rot}°</span>
          <span className="grow" />
          <button className="btn sm" onClick={() => s.rotatePlacement(p.id, -90)}>
            ⟲ 90°
          </button>
          <button className="btn sm" onClick={() => s.rotatePlacement(p.id, -15)}>
            −15°
          </button>
          <button className="btn sm" onClick={() => s.rotatePlacement(p.id, 15)}>
            +15°
          </button>
          <button className="btn sm" onClick={() => s.rotatePlacement(p.id, 90)}>
            ⟳ 90°
          </button>
        </div>
        <label className="check small">
          <input type="checkbox" checked={p.noOrder} onChange={() => s.toggleNoOrder(p.id)} />
          참고용 객체(주문 수량에서 제외)
        </label>
        </div>
        </details>
        <div className="row wrap">
          {compact && <button className="btn sm" onClick={() => s.rotatePlacement(p.id, 90)}>↻ 90° 회전</button>}
          <button className="btn sm" disabled={!!it && fixtureHeightStatus(data.space, it).blocked} onClick={() => s.duplicatePlacement(p.id)}>
            복제
          </button>
          <button className="btn sm danger" onClick={() => s.removePlacement(p.id)}>
            삭제
          </button>
        </div>
        {mine.map((i, k) => (
          <div key={k} className={`note ${i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warn' : ''}`}>
            {i.message}
          </div>
        ))}
      </fieldset>
    </section>
  );
}

function AddItem({ data }: { data: LayoutData }) {
  const addItem = useStore((s) => s.addItem);
  const [sku, setSku] = useState('');
  return (
    <div className="row wrap" style={{ marginTop: 10 }}>
      <select className="input sm grow" value={sku} onChange={(e) => setSku(e.target.value)} aria-label="추가할 집기">
        <option value="">집기 직접 추가…</option>
        {data.vendor.items.map((i) => (
          <option key={i.sku} value={i.sku} disabled={fixtureHeightStatus(data.space, i).blocked}>
            {i.sku} · {i.name} ({specText(i)})
            {fixtureHeightStatus(data.space, i).blocked ? ' · 반입 불가' : ''}
          </option>
        ))}
      </select>
      <button
        className="btn sm"
        disabled={!sku || data.vendor.items.some(item => item.sku === sku && fixtureHeightStatus(data.space, item).blocked)}
        onClick={() => {
          addItem(sku);
          setSku('');
        }}
      >
        추가
      </button>
      <CustomSizeAction data={data} onCreated={addItem} />
    </div>
  );
}

function CustomSizeAction({ data, sku, onCreated }: { data: LayoutData; sku?: string; onCreated: (sku: string) => void }) {
  const [open, setOpen] = useState(false);
  const vendor = useStore(s => s.vendors.find(v => v.id === data.vendor.id));
  if (!vendor) return null;
  const source = sku ? vendor.items.find(i => i.sku === sku) : undefined;
  return <><button type="button" className="btn sm custom-size-action" onClick={() => setOpen(true)}>{source ? '내 치수로 새 규격 만들기' : '+ 직접 집기 등록'}</button>{open && <CustomFixtureDialog vendor={vendor} space={data.space} source={source} mode={source ? 'resize' : 'create'} onClose={() => setOpen(false)} onCreated={newSku => { setOpen(false); const state = useStore.getState(); const item = state.vendors.find(v => v.id === vendor.id)?.items.find(i => i.sku === newSku); if (!item || fixtureHeightStatus(data.space, item).blocked) { state.toast('공간 높이 이상이어서 카탈로그에만 저장했습니다.', 'warn'); return; } onCreated(newSku); }} />}</>;
}

// ---------------------------------------------------------------- 검사 결과
export function IssuesPanel({ issues }: { issues: Issue[] }) {
  const select = useStore((s) => s.select);
  const errors = issues.filter((i) => i.severity === 'error');
  const warns = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>배치 검사</h3>
        <div className="row">
          {errors.length ? <span className="chip error">오류 {errors.length}</span> : <span className="chip ok">오류 없음</span>}
          {warns.length > 0 && <span className="chip warn">주의 {warns.length}</span>}
        </div>
      </div>
      {[...errors, ...warns].map((i, k) => (
        <div key={k} className={`issue ${i.severity} ${i.placementIds.length ? 'click' : ''}`} onClick={() => i.placementIds[0] && select(i.placementIds[0])}>
          <span className="dot" />
          <span>{i.message}</span>
        </div>
      ))}
      {infos.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            참고 {infos.length}건
          </summary>
          {infos.map((i, k) => (
            <div key={k} className="issue info">
              <span className="dot" />
              <span>{i.message}</span>
            </div>
          ))}
        </details>
      )}
      <p className="hint" style={{ marginTop: 6 }}>
        등록된 벽·기둥·금지 구역·출입구 여유·통로 기준으로만 검사합니다. 안전·소방·전기 규정 적합성 확인이 아닙니다.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- 비용·수량
export function CostPanel({ cost, compact = false }: { cost: CostSummary; compact?: boolean }) {
  const itemLines = cost.lines.filter((l) => l.kind === 'item');
  const feeLines = cost.lines.filter((l) => l.kind === 'fee');
  const diff = cost.budgetDiff;
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>예상 비용</h3>
        {cost.finalDetermined ? (
          <span className="chip ok">모두 확인</span>
        ) : cost.unknownLines.length ? (
          <span className="chip unknown">최종 총액 미확정</span>
        ) : (
          <span className="chip estimated">추정 포함</span>
        )}
      </div>
      <div className="totals">
        <div className="line">
          <span className="muted">확인 + 추정 합계</span>
          <span className="big num">{won(cost.knownTotal)}</span>
        </div>
        {cost.budget.amount != null && (
          <div className="line small">
            <span className="muted">{cost.budget.scope === 'fixtures' ? '집기 예산' : '전체 행사비 예산'} {won(cost.budget.amount)}</span>
            <span className={`num ${diff != null && diff < 0 ? 'diff-minus' : 'diff-plus'}`} style={{ fontWeight: 700 }}>
              {diff == null ? (cost.budget.scope === 'event_total' ? '비교 범위 다름' : '') : diff >= 0 ? `${won(diff)} ${cost.finalDetermined ? '여유' : '잠정 잔액'}` : `${won(-diff)} ${cost.finalDetermined ? '초과' : '잠정 초과'}`}
            </span>
          </div>
        )}
        {diff != null && !cost.finalDetermined && <p className="hint">추정·미확인 비용에 따라 잔액이 달라집니다.</p>}
        <div className="line small">
          <span className="muted">확인 {won(cost.confirmedTotal)} · 추정 {won(cost.estimatedTotal)}</span>
          <span className="muted">보증금 별도 {won(cost.depositTotal)}{cost.depositUnknownCount ? `+미확인 ${cost.depositUnknownCount}` : ''}</span>
        </div>
        {cost.unknownLines.length > 0 && (
          <div className="note" style={{ background: 'var(--unk-soft)', color: 'var(--unk)' }}>
            미확인 {cost.unknownLines.length}건은 합계에 넣지 않았습니다: {cost.unknownLines.map((l) => l.label).join(', ')}
          </div>
        )}
        {cost.warnings.map((w) => (
          <div key={w} className="note warn">
            {w}
          </div>
        ))}
      </div>
      <details className="cost-line-details" open={compact ? undefined : true}>
      <summary>품목별 수량 · 비용 보기 <span className="muted">{cost.lines.length}개 항목</span></summary>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>번호</th>
              <th>품목</th>
              <th className="r">수량</th>
              <th className="r">금액</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {itemLines.map((l) => (
              <tr key={l.key} title={l.note}>
                <td className="small muted">{l.placementNos.join(',')}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{l.label}</div>
                  <div className="small muted">
                    {l.sku} · {l.unit == null ? '단가 미확인' : `${won(l.unit)}`}
                  </div>
                  {l.note && <div className="small" style={{ color: l.status === 'confirmed' ? 'var(--muted)' : 'var(--est)' }}>{l.note}</div>}
                </td>
                <td className="r num">{l.qty}</td>
                <td className="r num">{won(l.amount)}</td>
                <td>
                  <StatusChip status={l.status} />
                </td>
              </tr>
            ))}
            {feeLines.map((l) => (
              <tr key={l.key}>
                <td />
                <td>
                  <div style={{ fontWeight: 600 }}>{l.label}</div>
                  <div className="small muted">{l.basis || '기준 미기재'}</div>
                </td>
                <td className="r num">1</td>
                <td className="r num">{won(l.amount)}</td>
                <td>
                  <StatusChip status={l.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------- 버전
export function VersionsPanel({ project, dirty }: { project: Project; dirty: boolean }) {
  const viewVersion = useStore((s) => s.viewVersion);
  const setViewVersion = useStore((s) => s.setViewVersion);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const versions = [...project.versions].reverse();
  const share = canShareFiles();

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(`내보내기 실패: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>확정 버전</h3>
        {project.versions.length > 0 && (dirty ? <span className="chip warn">수정본 재확정 필요</span> : <span className="chip ok">최신과 일치</span>)}
      </div>
      {versions.length === 0 && <p className="hint">아직 확정한 버전이 없습니다. 검사 오류가 없으면 ‘버전 확정’으로 v1을 만들 수 있습니다.</p>}
      {versions.map((v: VersionSnapshot) => {
        const cost = computeCost(snapshotData(v));
        return (
          <div key={v.version} className="version-item">
            <span className={`vnum ${viewVersion === v.version ? 'on' : ''}`}>v{v.version}</span>
            <div className="grow">
              <div className="num" style={{ fontWeight: 700 }}>
                {won(cost.knownTotal)}
                {!cost.finalDetermined && <span className="small muted"> · {cost.unknownLines.length ? '미확정' : '추정 포함'}</span>}
              </div>
              <div className="small muted">
                {fmtDateTime(v.createdAt)} · 집기 {v.placements.length}개
              </div>
            </div>
            <button className="btn sm ghost" onClick={() => setViewVersion(viewVersion === v.version ? null : v.version)}>
              {viewVersion === v.version ? '닫기' : '보기'}
            </button>
            <button className="btn sm" disabled={!!busy} aria-label={`v${v.version} 기획보고서 PDF`} onClick={() => run(`pdf${v.version}`, () => exportPdf(v, share ? 'share' : 'download'))}>
              {busy === `pdf${v.version}` ? '만드는 중…' : share ? 'PDF 공유' : 'PDF'}
            </button>
            <button className="btn sm ghost" disabled={!!busy} title="배치 포함 GLB" onClick={() => run(`glb${v.version}`, () => exportLayoutGlbFile(v))}>
              GLB
            </button>
          </div>
        );
      })}
      {versions.length > 0 && <p className="hint">기획보고서 PDF는 확정 당시 데이터로 다시 만듭니다. 이미 내려받은 파일은 바뀌지 않으니 문서 번호·버전으로 최신 여부를 대조하세요.</p>}
    </section>
  );
}
