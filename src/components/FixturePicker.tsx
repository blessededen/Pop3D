import { useState } from 'react';
import { CATEGORY_LABEL, type CatalogItem, type Category } from '../domain/types';
import { unitPrice, won } from '../domain/cost';
import { useCurrent, useStore } from '../store';
import CustomFixtureDialog, { FixtureThumbnail } from './CustomFixtureDialog';

export default function FixturePicker() {
  const { project, vendor } = useCurrent();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [editing, setEditing] = useState<{ source?: CatalogItem } | null>(null);
  const st = useStore.getState;
  if (!vendor) return null;
  const visible = vendor.items.filter(item => (category === 'all' || item.category === category) && `${item.name} ${item.option} ${item.sku}`.toLowerCase().includes(query.toLowerCase().trim()));
  const used = new Set(st().projects.filter(p => p.vendorId === vendor.id).flatMap(p => [...p.placements.map(pl => pl.sku), ...p.requirements.filter(r => p.id !== project.id || r.desiredQty > 0).map(r => r.sku)]));
  return <section className="fixture-picker" aria-label="사용할 집기와 수량">
    <div className="fixture-picker-toolbar">
      <input className="input" type="search" aria-label="집기 검색" placeholder="집기 이름 검색" value={query} onChange={e => setQuery(e.target.value)} />
      <select className="input" aria-label="집기 종류" value={category} onChange={e => setCategory(e.target.value as Category | 'all')}><option value="all">전체 집기</option>{(Object.keys(CATEGORY_LABEL) as Category[]).filter(key => vendor.items.some(item => item.category === key)).map(key => <option value={key} key={key}>{CATEGORY_LABEL[key]}</option>)}</select>
      <button className="btn ghost sm" onClick={() => setEditing({})}>+ 직접 규격 등록</button>
    </div>
    <div className="fixture-picker-labels"><span>품목 · 가로 × 깊이 × 높이</span><span>사용 수량</span></div>
    <div className="fixture-picker-list">
      {visible.map(item => {
        const requirement = project.requirements.find(r => r.sku === item.sku);
        const qty = requirement?.desiredQty ?? 0;
        const price = unitPrice(item, project.event.rentalDays);
        return <article className={`fixture-choice ${qty ? 'is-used' : ''}`} key={item.sku}>
          <div className="fixture-choice-image" aria-hidden><FixtureThumbnail item={item} /></div>
          <div className="fixture-choice-copy"><h3>{item.name}</h3><p>{[item.w, item.d, item.h].map(value => Math.round(value * 1000) / 10).join(' × ')} cm <span>· {price.unit == null ? '금액 미확인' : `${won(price.unit)} / 개`}</span></p>
            <div className="fixture-choice-options"><details><summary>규격 · 삭제</summary><div className="fixture-option-menu"><button className="text-button" onClick={() => setEditing({ source: { ...item, needsPower: requirement?.needsPower ?? item.needsPower } })}>다른 치수 만들기</button><button className="text-button danger" disabled={used.has(item.sku)} title={used.has(item.sku) ? '사용 중인 품목입니다. 사용 취소 후 다시 배치하면 삭제할 수 있습니다.' : undefined} onClick={() => {
              if (!window.confirm(`‘${item.name}’ 규격을 카탈로그에서 삭제할까요?`)) return;
              const latest = st().vendors.find(v => v.id === vendor.id);
              if (latest) st().upsertVendor({ ...latest, items: latest.items.filter(i => i.sku !== item.sku) });
              st().updateProject(p => { p.requirements = p.requirements.filter(r => r.sku !== item.sku); });
            }}>카탈로그에서 삭제</button></div></details><label className="check"><input type="checkbox" checked={requirement?.needsPower ?? item.needsPower ?? false} onChange={e => st().setItemPower(item.sku, e.target.checked)} />전기 필요</label><button className="text-button fixture-remove" disabled={!qty} onClick={() => st().setItemQuantity(item.sku, 0)}>사용 취소</button></div>
          </div>
          <label className="fixture-quantity"><span className="sr-only">{item.name} 사용 수량</span><input className="input num" aria-label={`${item.name} 사용 수량`} type="number" inputMode="numeric" value={qty} min={0} max={50} step={1} onChange={event => st().setItemQuantity(item.sku, event.target.value === '' ? 0 : Number(event.target.value))} /><span>개</span></label>
        </article>;
      })}
      {!visible.length && <p className="fixture-picker-empty">찾는 집기가 없으면 직접 규격을 등록해 주세요.</p>}
    </div>
    {editing && <CustomFixtureDialog vendor={vendor} source={editing.source} mode={editing.source ? 'resize' : 'create'} onClose={() => setEditing(null)} onCreated={sku => { st().setItemQuantity(sku, 1); setQuery(''); setCategory('all'); setEditing(null); }} />}
  </section>;
}
