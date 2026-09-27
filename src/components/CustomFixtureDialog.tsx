import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { fixtureDraft, fixtureSizeChanged, makeFixtureItem, validateFixtureDraft, type FixtureDialogMode, type FixtureDraft } from '../domain/customFixture';
import { CATEGORY_LABEL, type CatalogItem, type Category, type Space, type Vendor } from '../domain/types';
import { fixtureHeightStatus } from '../domain/placementRules';
import { useStore } from '../store';
import '../workflow-sizing.css';

export function FixtureThumbnail({ item }: { item: Pick<CatalogItem, 'category' | 'w' | 'd' | 'h' | 'color'> }) {
  const wide = Math.max(32, Math.min(124, item.w / Math.max(item.w, item.h, 0.01) * 124));
  const tall = Math.max(28, Math.min(92, item.h / Math.max(item.w, item.h, 0.01) * 92));
  const left = 100 - wide / 2;
  const top = 118 - tall;
  const color = item.color || '#727d70';
  return (
    <svg className="fixture-thumbnail" viewBox="0 0 200 164" aria-hidden="true">
      <ellipse cx="100" cy="122" rx="66" ry="9" fill="currentColor" opacity=".045" />
      <g fill="none" stroke="#59695f" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
        {item.category === 'hanger' ? <>
          <path d={`M${left},118 V${top} H${left + wide} V118 M${left - 8},118 h16 M${left + wide - 8},118 h16`} />
          <path d={`M85,${top + 2} v13 l-13,10 h26 l-13,-10 M118,${top + 2} v13 l-13,10 h26 l-13,-10`} strokeWidth="1.5" />
        </> : item.category === 'light' ? <>
          <path d="M100,118 V45 M84,118 H116" />
          <path d="M78,46 L87,28 H113 L122,46 Z" fill={color} fillOpacity=".18" />
        </> : <>
          <rect x={left} y={top} width={wide} height={tall} rx={item.category === 'mirror' ? 12 : 3} fill={color} fillOpacity=".12" />
          {item.category === 'shelf' || item.category === 'display' ? [1, 2].map((n) => <path key={n} d={`M${left},${top + tall * n / 3} H${left + wide}`} />) : null}
          {item.category === 'table' ? <path d={`M${left},${top + 10} H${left + wide} M${left + 7},${top + 10} V118 M${left + wide - 7},${top + 10} V118`} /> : null}
          {item.category === 'photozone' ? <circle cx="100" cy={top + tall / 2} r={Math.min(20, tall / 4)} strokeDasharray="3 4" /> : null}
        </>}
      </g>
      <g stroke="currentColor" strokeWidth="1" opacity=".35"><path d={`M${left},137 H${left + wide} M${left},133 v8 M${left + wide},133 v8`} /></g>
      <text x="100" y="155" textAnchor="middle" fill="currentColor" fontSize="10" opacity=".65">{Math.round(item.w * 1000) / 10} cm</text>
    </svg>
  );
}

interface Props {
  vendor: Vendor;
  space?: Space;
  source?: CatalogItem;
  mode?: FixtureDialogMode;
  onClose: () => void;
  onCreated: (sku: string) => void;
}

export default function CustomFixtureDialog({ vendor, space, source, mode = 'create', onClose, onCreated }: Props) {
  const [draft, setDraft] = useState(() => fixtureDraft(source, mode));
  const [errors, setErrors] = useState<string[]>([]);
  const [priceReset, setPriceReset] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const resized = fixtureSizeChanged(draft, source);
  const createsNew = mode !== 'edit' || resized;
  const height = space && Number.isFinite(draft.heightCm) ? fixtureHeightStatus(space, { h: draft.heightCm / 100 }) : null;
  const title = mode === 'resize' ? '다른 규격으로 추가' : mode === 'edit' ? '집기 정보 수정' : '내 집기 추가';
  useEffect(() => {
    dialog.current?.showModal();
    const node = dialog.current;
    return () => node?.close();
  }, []);
  const update = <K extends keyof FixtureDraft>(key: K, value: FixtureDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const changeSize = (key: 'widthCm' | 'depthCm' | 'heightCm', value: number) => {
    if (value === draft[key]) return;
    if (draft.amount != null) setPriceReset(true);
    setDraft((current) => ({ ...current, [key]: value, amount: null, priceEntered: false, priceCopiedFromSource: false, extraDayAmount: null, deposit: null, vatIncluded: null, priceStatus: 'estimated', priceDate: '', priceSource: '' }));
  };
  const number = (value: string) => value.trim() ? Number(value) : NaN;
  const save = (event: FormEvent) => {
    event.preventDefault();
    const invalid = validateFixtureDraft(draft);
    if (invalid.length) { setErrors(invalid); return; }
    const store = useStore.getState();
    const latest = store.vendors.find((v) => v.id === vendor.id);
    if (!latest) { setErrors(['업체를 찾을 수 없습니다. 창을 닫고 다시 시도해 주세요.']); return; }
    const item = makeFixtureItem(draft, latest.items.map((it) => it.sku), source, mode);
    const exists = latest.items.some((it) => it.sku === item.sku);
    store.upsertVendor({ ...latest, items: exists ? latest.items.map((it) => it.sku === item.sku ? item : it) : [...latest.items, item] });
    store.toast(exists ? '집기 정보를 저장했습니다.' : `${item.name}을(를) 별도 규격으로 추가했습니다.`);
    onCreated(item.sku);
    onClose();
  };
  return (
    <dialog ref={dialog} className="fixture-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="fixture-form" onSubmit={save} noValidate>
        <div className="panel-head"><div><span className="eyebrow">FIXTURE LIBRARY</span><h2 id={titleId}>{title}</h2></div><button type="button" className="btn ghost icon-btn" aria-label="집기 창 닫기" onClick={onClose}>×</button></div>
        <p className="muted" id={descriptionId}>{createsNew ? '실제 치수를 cm로 입력하세요. 새 규격은 원본과 별개의 집기로 저장됩니다.' : '가격·이름 등 정보를 수정합니다. 치수를 바꾸면 별도의 집기가 만들어집니다.'}</p>
        <div className="fixture-form-main">
          <div className="fixture-preview"><FixtureThumbnail item={{ category: draft.category, w: Number.isFinite(draft.widthCm) ? draft.widthCm / 100 : 1, d: Number.isFinite(draft.depthCm) ? draft.depthCm / 100 : 1, h: Number.isFinite(draft.heightCm) ? draft.heightCm / 100 : 1, color: draft.color }} /><span className="small muted">{CATEGORY_LABEL[draft.category]} · 규격 미리보기</span></div>
          <div className="fixture-fields">
            <label className="field"><span>집기 이름</span><input autoFocus className="input" value={draft.name} onChange={(e) => update('name', e.target.value)} placeholder="예: 낮은 90cm 행거" /></label>
            <div className="grid2">
              <label className="field"><span>종류</span><select className="input" value={draft.category} onChange={(e) => update('category', e.target.value as Category)}>{(Object.keys(CATEGORY_LABEL) as Category[]).map((category) => <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>)}</select></label>
              <label className="field"><span>색상</span><input type="color" className="input" value={draft.color} onChange={(e) => update('color', e.target.value)} /></label>
            </div>
            <div className="fixture-dimensions grid3">{(['widthCm', 'depthCm', 'heightCm'] as const).map((key, index) => <label className="field" key={key}><span>{['가로', '깊이', '높이'][index]} (cm)</span><input className="input" type="number" min="1" max="2000" step="0.1" inputMode="decimal" value={Number.isFinite(draft[key]) ? draft[key] : ''} onChange={(e) => changeSize(key, number(e.target.value))} /></label>)}</div>
            {space && height && <p className={`fixture-height-status ${height.blocked ? 'is-blocked' : ''}`} role="status">{height.blocked ? `공간 높이 ${space.height}m 이상 · 반입 불가. 카탈로그에만 저장됩니다.` : height.warning ? `천장 여유 ${Math.round(height.clearance * 1000) / 10}cm · 설치 여유를 확인해 주세요.` : `공간 높이 ${space.height}m · 천장 여유 ${Math.round(height.clearance * 1000) / 10}cm`}</p>}
            <label className="check fixture-power"><input type="checkbox" checked={draft.needsPower} onChange={e => update('needsPower', e.target.checked)} />전기 필요</label>
          </div>
        </div>
        {source && createsNew && <p className="hint">원본: {source.name} ({source.w * 100} × {source.d * 100} × {source.h * 100} cm). 원본 품목은 카탈로그에 보존됩니다.</p>}
        <div className="fixture-price-block">
          <div className="grid3">
            <label className="field"><span>사용 방식</span><select className="input" value={draft.trade} onChange={(e) => update('trade', e.target.value as 'rent' | 'buy')}><option value="rent">대여</option><option value="buy">구매</option></select></label>
            <label className="field"><span>단가 (원, 선택)</span><input className="input" type="number" min="0" inputMode="numeric" value={draft.amount ?? ''} placeholder="가격을 알 때 입력" onChange={(e) => setDraft((current) => ({ ...current, amount: e.target.value === '' ? null : Number(e.target.value), priceEntered: true, priceStatus: 'estimated' }))} /></label>
            {draft.trade === 'rent' && <label className="field"><span>대여 기준 (일)</span><input className="input" type="number" min="1" step="1" value={draft.basisDays ?? ''} onChange={(e) => update('basisDays', e.target.value === '' ? null : Number(e.target.value))} /></label>}
          </div>
          <p className="hint" role="status">{priceReset ? '치수가 바뀌어 기존 단가를 비웠습니다. 새 규격의 가격을 알고 있다면 입력해 주세요.' : createsNew ? '입력한 가격은 추정가로 저장합니다. 비워 두면 견적에서 가격 미확인으로 표시합니다.' : '변경한 가격은 추정가로 저장합니다.'}</p>
        </div>
        <details className="fixture-extra"><summary>상세 가격 · 옵션</summary><div className="grid2">
          <label className="field"><span>부가세</span><select className="input" value={draft.vatIncluded == null ? '' : String(draft.vatIncluded)} onChange={(e) => update('vatIncluded', e.target.value === '' ? null : e.target.value === 'true')}><option value="">미확인</option><option value="true">포함</option><option value="false">별도</option></select></label>
          {draft.trade === 'rent' && <label className="field"><span>연장 1일 (원)</span><input className="input" type="number" min="0" value={draft.extraDayAmount ?? ''} onChange={(e) => update('extraDayAmount', e.target.value === '' ? null : Number(e.target.value))} /></label>}
          <label className="field"><span>보증금 (원)</span><input className="input" type="number" min="0" value={draft.deposit ?? ''} onChange={(e) => update('deposit', e.target.value === '' ? null : Number(e.target.value))} /></label>
          <label className="field"><span>가격 기준일</span><input className="input" type="date" value={draft.priceDate} onChange={(e) => update('priceDate', e.target.value)} /></label>
          <label className="field"><span>가격 출처</span><input className="input" value={draft.priceSource} onChange={(e) => update('priceSource', e.target.value)} placeholder="예: 업체에서 받은 견적" /></label>
          <label className="field"><span>옵션</span><input className="input" value={draft.option} onChange={(e) => update('option', e.target.value)} placeholder="예: 바퀴 포함" /></label>
          <label className="field"><span>세트 구성</span><input className="input" value={draft.setComponents} onChange={(e) => update('setComponents', e.target.value)} /></label>
          <label className="field"><span>메모</span><input className="input" value={draft.note} onChange={(e) => update('note', e.target.value)} /></label>
        </div>{source && !createsNew && <p className="hint">상품번호 {source.sku}</p>}</details>
        {errors.length > 0 && <div className="note error" role="alert">{errors.map((error) => <p key={error}>{error}</p>)}</div>}
        <div className="fixture-dialog-actions"><button type="button" className="btn" onClick={onClose}>취소</button><button className="btn primary" type="submit">{createsNew ? '새 집기로 저장' : '변경 저장'}</button></div>
      </form>
    </dialog>
  );
}
