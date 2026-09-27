import { useRef, useState } from 'react';
import CustomFixtureDialog, { FixtureThumbnail } from '../components/CustomFixtureDialog';
import { NumInput, StatusChip, TextInput } from '../components/ui';
import { exportCatalogCsv, importCatalogCsv, type CsvImportResult } from '../domain/csv';
import { type FixtureDialogMode } from '../domain/customFixture';
import { fixtureHeightStatus } from '../domain/placementRules';
import { CATEGORY_LABEL, type CatalogItem, type Category, type ServiceFee, type Vendor } from '../domain/types';
import { downloadBlob, safeFileName } from '../lib/browser';
import { useStore } from '../store';

const TEMPLATE_ITEM: CatalogItem = {
  sku: 'ABC-001', name: '행거 1.2m', category: 'hanger', w: 1.2, d: 0.5, h: 1.6,
  option: '블랙', trade: 'rent',
  price: { amount: 110000, basisDays: 7, vatIncluded: true, status: 'estimated', priceDate: '', source: '입력 예시', extraDayAmount: 10000 },
  deposit: 0, setComponents: '', modelUrl: '', modelLicense: '', color: '#8a8f98', note: '',
};

function newVendor(): Vendor {
  return { id: 'vendor-' + crypto.randomUUID(), name: '새 업체', contact: '', catalogDate: '', isVirtual: false, items: [], services: [] };
}

interface CatalogPageProps {
  embedded?: boolean;
  /** Called after the item has been added to the current layout. */
  onPick?: (sku: string) => void;
}

export default function CatalogPage({ embedded = false, onPick }: CatalogPageProps = {}) {
  const vendors = useStore((s) => s.vendors);
  const projects = useStore((s) => s.projects);
  const currentProjectId = useStore((s) => s.currentProjectId);
  const viewVersion = useStore((s) => s.viewVersion);
  const currentProject = projects.find((p) => p.id === currentProjectId);
  const currentSpace = useStore(s => s.spaces.find(space => space.id === currentProject?.spaceId));
  const upsert = useStore((s) => s.upsertVendor);
  const toast = useStore((s) => s.toast);
  const [selId, setSelId] = useState(vendors[0]?.id);
  const vendor = embedded ? vendors.find((v) => v.id === currentProject?.vendorId) : vendors.find((v) => v.id === selId) ?? vendors[0];
  const fileRef = useRef<HTMLInputElement>(null);
  const [imp, setImp] = useState<(CsvImportResult & { fileName: string }) | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [editing, setEditing] = useState<{ source?: CatalogItem; mode: FixtureDialogMode } | null>(null);
  const [addAfterCreate, setAddAfterCreate] = useState(true);

  if (!vendor && embedded) return <div className="note error">현재 프로젝트의 집기 카탈로그를 찾을 수 없습니다. 행사·공간·카탈로그 설정에서 업체를 확인해 주세요.</div>;
  if (!vendor) return <div className="page"><h1>집기 라이브러리</h1><button className="btn primary" onClick={() => { const next = newVendor(); upsert(next); setSelId(next.id); }}>첫 업체 추가</button></div>;
  const canPick = embedded && currentProject?.vendorId === vendor.id && viewVersion == null;
  const pick = (sku: string) => {
    const store = useStore.getState();
    const activeProject = store.projects.find((p) => p.id === store.currentProjectId);
    const activeVendor = store.vendors.find((v) => v.id === activeProject?.vendorId);
    if (!embedded || store.viewVersion != null || !activeProject || activeProject.id !== currentProject?.id || activeVendor?.id !== vendor.id || !activeVendor.items.some((item) => item.sku === sku)) {
      toast('현재 프로젝트의 카탈로그에서 집기를 선택해 주세요.', 'warn');
      return;
    }
    const room = store.spaces.find(space => space.id === activeProject.spaceId);
    const item = activeVendor.items.find(item => item.sku === sku)!;
    if (!room || fixtureHeightStatus(room, item).blocked) { toast('공간 높이 이상 · 반입 불가. 더 낮은 규격을 선택해 주세요.', 'warn'); return; }
    store.addItem(sku);
    toast(`${activeVendor.items.find((item) => item.sku === sku)!.name}을(를) 배치에 추가했습니다.`);
    onPick?.(sku);
  };
  const usedSkus = new Set(projects.filter((p) => p.vendorId === vendor.id).flatMap((p) => [...p.placements.map((x) => x.sku), ...p.requirements.map((r) => r.sku)]));
  const visible = vendor.items.filter((item) => (category === 'all' || item.category === category) && [item.name, item.sku, item.option, CATEGORY_LABEL[item.category]].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const categories = (Object.keys(CATEGORY_LABEL) as Category[]).filter((key) => vendor.items.some((item) => item.category === key));
  const set = (fn: (v: Vendor) => void) => {
    const next = structuredClone(useStore.getState().vendors.find((v) => v.id === vendor.id) ?? vendor);
    fn(next);
    upsert(next);
  };
  const applyImport = (mode: 'replace' | 'merge') => {
    if (!imp) return;
    set((v) => {
      if (mode === 'replace') {
        const missing = [...usedSkus].filter((sku) => !imp.items.some((item) => item.sku === sku));
        v.items = [...imp.items, ...v.items.filter((item) => missing.includes(item.sku))];
        if (missing.length) toast('프로젝트에서 쓰는 상품 ' + missing.length + '개는 남겨 두었습니다.', 'warn');
      } else {
        const map = new Map(v.items.map((item) => [item.sku, item]));
        for (const item of imp.items) map.set(item.sku, item);
        v.items = [...map.values()];
      }
      v.isVirtual = false;
    });
    toast(imp.items.length + '개 상품을 ' + (mode === 'replace' ? '교체' : '추가·갱신') + '했습니다.');
    setImp(null);
  };

  return (
    <div className={embedded ? 'catalog-page catalog-embedded simple-catalog' : 'page catalog-page'}>
      <div className="page-head">
        <div><span className="eyebrow">FIXTURE LIBRARY</span>{embedded ? <h2>집기 골라 담기</h2> : <h1>공간에 맞는 집기를 찾으세요</h1>}<p>{embedded ? '아래에서 고르면 현재 공간에 바로 추가됩니다.' : '규격을 비교하고, 없는 사이즈는 직접 추가하세요.'}</p></div>
        {!embedded && <button className="btn primary" onClick={() => setEditing({ mode: 'create' })}>+ 내 집기 추가</button>}
      </div>
      <div className="catalog-toolbar">
        <label className="catalog-search"><span className="sr-only">집기 검색</span><input type="search" className="input" placeholder="집기 이름, 옵션, 상품번호 검색" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        {embedded && <label className="simple-catalog-filter"><span className="sr-only">집기 종류</span><select className="input" value={category} onChange={event => setCategory(event.target.value as Category | 'all')}><option value="all">전체 집기</option>{categories.map(kind => <option value={kind} key={kind}>{CATEGORY_LABEL[kind]}</option>)}</select></label>}
        {embedded ? <div className="catalog-vendor catalog-locked-vendor"><strong>{vendor.name}</strong><span className="small muted">현재 프로젝트 · {vendor.items.length}개</span></div> : <label className="catalog-vendor"><span className="sr-only">카탈로그 업체</span><select className="input" value={vendor.id} onChange={(e) => { setSelId(e.target.value); setCategory('all'); setQuery(''); setImp(null); }}>{vendors.map((v) => <option value={v.id} key={v.id}>{v.name} · {v.items.length}개</option>)}</select></label>}
      </div>
      {!embedded && <div className="catalog-filters" role="group" aria-label="집기 종류 필터">
        <button className={'btn sm ' + (category === 'all' ? 'primary' : '')} aria-pressed={category === 'all'} onClick={() => setCategory('all')}>전체 {vendor.items.length}</button>
        {categories.map((key) => <button className={'btn sm ' + (category === key ? 'primary' : '')} key={key} aria-pressed={category === key} onClick={() => setCategory(key)}>{CATEGORY_LABEL[key]} {vendor.items.filter((item) => item.category === key).length}</button>)}
      </div>}
      <div className="catalog-results-line"><span className="small muted">{visible.length}개 집기 · 가로 × 깊이 × 높이 (cm)</span>{vendor.isVirtual && <span className="chip">예시 카탈로그</span>}</div>
      <section className="catalog-grid" aria-label="집기 목록">
        {visible.map((item) => <article className="catalog-item" key={item.sku}>
          <div className="catalog-item-visual"><span className="catalog-item-category">{CATEGORY_LABEL[item.category]}</span><FixtureThumbnail item={item} />{usedSkus.has(item.sku) && <span className="catalog-in-use">프로젝트에서 사용 중</span>}</div>
          <div className="catalog-item-body">
            <h3>{item.name}</h3><p className="catalog-item-dimensions">{[item.w, item.d, item.h].map((value) => Math.round(value * 1000) / 10).join(' × ')} <span>cm</span></p>
            <p className="catalog-item-price"><strong>{item.price.amount == null ? '가격 미입력' : item.price.amount.toLocaleString('ko-KR') + '원'}</strong><span className="small muted">{item.trade === 'buy' ? '구매' : (item.price.basisDays ?? '—') + '일 대여'}</span><StatusChip status={item.price.amount == null ? 'unknown' : item.price.status} /></p>
            {item.option && <p className="small muted">{item.option}</p>}
            {embedded && currentSpace && (fixtureHeightStatus(currentSpace, item).blocked || fixtureHeightStatus(currentSpace, item).warning) && <p className={`fixture-height-status ${fixtureHeightStatus(currentSpace, item).blocked ? 'is-blocked' : ''}`}>{fixtureHeightStatus(currentSpace, item).blocked ? '공간 높이 이상 · 반입 불가' : `천장 여유 ${Math.round(fixtureHeightStatus(currentSpace, item).clearance * 1000) / 10}cm · 설치 여유 확인`}</p>}
            <div className="catalog-item-actions">{embedded ? <button type="button" className="btn primary sm catalog-pick" disabled={!canPick || !currentSpace || fixtureHeightStatus(currentSpace, item).blocked} onClick={() => pick(item.sku)} aria-label={item.name + ' 배치에 추가'}>+ 추가</button> : <><button className="btn sm" onClick={() => setEditing({ source: item, mode: 'resize' })} aria-label={item.name + ' 다른 규격 추가'}>다른 규격 추가</button><button className="btn ghost sm" onClick={() => setEditing({ source: item, mode: 'edit' })} aria-label={item.name + ' 정보 수정'}>수정</button></>}</div>
            <details className={`catalog-item-meta ${embedded ? 'simple-card-options' : ''}`}><summary>{embedded ? '옵션' : '상품 상세'}</summary>{embedded && <div className="simple-card-options-actions"><button type="button" className="btn sm" disabled={!canPick} onClick={() => setEditing({ source: item, mode: 'resize' })}>다른 규격 추가</button><button type="button" className="btn ghost sm" disabled={!canPick} onClick={() => setEditing({ source: item, mode: 'edit' })}>정보 수정</button></div>}<p className="hint">상품번호: {item.sku}</p>{item.price.source && <p className="hint">가격 출처: {item.price.source}</p>}{item.note && <p className="hint">{item.note}</p>}<button className="btn ghost sm" disabled={usedSkus.has(item.sku)} title={usedSkus.has(item.sku) ? '프로젝트에서 사용하는 상품입니다.' : undefined} onClick={() => set((v) => { v.items = v.items.filter((it) => it.sku !== item.sku); })}>라이브러리에서 삭제</button></details>
          </div>
        </article>)}
      </section>
      {!visible.length && <div className="catalog-empty panel"><h3>{vendor.items.length ? '검색 결과가 없습니다' : '등록된 집기가 없습니다'}</h3><p className="muted">다른 이름으로 검색하거나 필요한 규격의 집기를 추가하세요.</p><button className="btn primary" onClick={() => setEditing({ mode: 'create' })}>+ 내 집기 추가</button></div>}
      <details className={`catalog-advanced panel ${embedded ? 'simple-catalog-management' : ''}`}>
        <summary>{embedded ? '직접 규격 입력 · 카탈로그 관리' : '업체 정보 · CSV 가져오기 · 부대 비용'}</summary>
        {embedded && <div className="simple-catalog-create"><button type="button" className="btn" disabled={!canPick} onClick={() => setEditing({ mode: 'create' })}>+ 내 집기 추가</button><label className="check catalog-create-option"><input type="checkbox" checked={addAfterCreate} disabled={!canPick} onChange={(event) => setAddAfterCreate(event.target.checked)} />새로 만든 규격을 저장 후 배치에도 추가</label></div>}
        <section>
          <div className="panel-head"><h3>업체 정보</h3>{!embedded && <button className="btn sm" onClick={() => { const next = newVendor(); upsert(next); setSelId(next.id); setCategory('all'); setQuery(''); setImp(null); }}>+ 새 업체</button>}</div>
          <div className="grid3">
            <label className="field"><span>업체명</span><TextInput value={vendor.name} onChange={(value) => set((v) => void (v.name = value))} /></label>
            <label className="field"><span>연락처</span><TextInput value={vendor.contact} onChange={(value) => set((v) => void (v.contact = value))} /></label>
            <label className="field"><span>카탈로그 기준일</span><TextInput type="date" value={vendor.catalogDate} onChange={(value) => set((v) => void (v.catalogDate = value))} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={vendor.isVirtual} onChange={(e) => set((v) => void (v.isVirtual = e.target.checked))} />예시 카탈로그로 표시</label>
        </section>
        <section>
          <h3>CSV 파일로 관리</h3><p className="hint">CSV의 치수는 m 단위입니다. 가져오기 전에 읽은 항목과 오류를 확인할 수 있습니다.</p>
          <div className="row wrap">
            <button className="btn sm" onClick={() => downloadBlob(new Blob([exportCatalogCsv([TEMPLATE_ITEM])], { type: 'text/csv' }), '카탈로그_템플릿.csv')}>템플릿 받기</button>
            <button className="btn sm" onClick={() => downloadBlob(new Blob([exportCatalogCsv(vendor.items)], { type: 'text/csv' }), '카탈로그_' + safeFileName(vendor.name) + '.csv')}>CSV 내보내기</button>
            <button className="btn sm" onClick={() => fileRef.current?.click()}>CSV 가져오기</button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setImp({ ...importCatalogCsv(await file.text()), fileName: file.name }); }} />
          </div>
          {imp && <div className="panel catalog-import"><div className="panel-head"><h3>{imp.fileName} · {imp.items.length}개 읽음</h3><button className="btn ghost sm" onClick={() => setImp(null)}>닫기</button></div>
            {!!imp.errors.length && <div className="note error"><strong>제외된 행 {imp.errors.length}건</strong>{imp.errors.slice(0, 12).map((error) => <div key={error}>{error}</div>)}</div>}
            {!!imp.warnings.length && <div className="note warn">{imp.warnings.slice(0, 12).map((warning) => <div key={warning}>{warning}</div>)}</div>}
            <div className="row wrap"><button className="btn primary sm" disabled={!imp.items.length} onClick={() => applyImport('merge')}>추가·갱신</button><button className="btn sm" disabled={!imp.items.length} onClick={() => applyImport('replace')}>전체 교체</button></div><p className="hint">추가·갱신은 같은 상품번호의 정보를 바꿉니다. 전체 교체 시에도 프로젝트에서 사용하는 누락 상품은 보존합니다.</p>
          </div>}
        </section>
        <ServicesPanel vendor={vendor} set={set} />
      </details>
      {editing && <CustomFixtureDialog key={vendor.id + '-' + editing.mode + '-' + (editing.source?.sku ?? 'new')} vendor={vendor} space={embedded ? currentSpace : undefined} source={editing.source} mode={editing.mode} onClose={() => setEditing(null)} onCreated={(sku) => { setCategory('all'); setQuery(''); if (embedded && addAfterCreate && editing.source?.sku !== sku) pick(sku); }} />}
    </div>
  );
}

function ServicesPanel({ vendor, set }: { vendor: Vendor; set: (fn: (v: Vendor) => void) => void }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>기본 부대 비용(새 프로젝트에 복사)</h3>
        <button
          className="btn sm"
          onClick={() =>
            set((v) =>
              void v.services.push({ id: `fee-${Date.now().toString(36)}`, kind: 'other', label: '기타 비용', amount: null, status: 'unknown', basis: '', source: '', vatIncluded: null }),
            )
          }
        >
          + 항목
        </button>
      </div>
      <table className="table edit">
        <thead>
          <tr>
            <th>항목</th>
            <th>금액</th>
            <th>상태</th>
            <th>기준</th>
            <th>출처</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {vendor.services.map((f: ServiceFee, i) => (
            <tr key={f.id}>
              <td>
                <TextInput value={f.label} onChange={(val) => set((v) => void (v.services[i].label = val))} />
              </td>
              <td style={{ width: 110 }}>
                <NumInput money allowNull min={0} placeholder="미확인" value={f.amount} onChange={(val) => set((v) => void ((v.services[i].amount = val), val == null && (v.services[i].status = 'unknown')))} />
              </td>
              <td>
                <StatusChip status={f.amount == null ? 'unknown' : f.status} />
              </td>
              <td>
                <TextInput value={f.basis} placeholder="예: 정액, 수량 무관" onChange={(val) => set((v) => void (v.services[i].basis = val))} />
              </td>
              <td>
                <TextInput value={f.source} onChange={(val) => set((v) => void (v.services[i].source = val))} />
              </td>
              <td>
                <button className="btn ghost sm icon-btn" aria-label="삭제" onClick={() => set((v) => void v.services.splice(i, 1))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
