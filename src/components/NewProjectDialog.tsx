import { useEffect, useRef, useState } from 'react';
import type { Category, Space } from '../domain/types';
import { CATEGORY_LABEL } from '../domain/types';
import { useStore } from '../store';

export default function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const spaces = useStore(s => s.spaces);
  const vendors = useStore(s => s.vendors);
  const [name, setName] = useState('');
  const [existing, setExisting] = useState(false);
  const [spaceId, setSpaceId] = useState(spaces[0]?.id || '');
  const [vendorId, setVendorId] = useState(vendors[0]?.id || '');
  const [width, setWidth] = useState('5');
  const [depth, setDepth] = useState('10');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const create = () => {
    const w = Number(width); const d = Number(depth); const amount = budget.trim() ? Number(budget.replaceAll(',', '')) : null;
    if (!name.trim()) { setError('프로젝트 이름을 입력해주세요.'); return; }
    if (!existing && (!Number.isFinite(w) || !Number.isFinite(d) || w < .5 || d < .5 || w > 200 || d > 200)) { setError('가로·세로를 0.5~200m 사이로 입력해주세요.'); return; }
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) { setError('예산을 0 이상의 숫자로 입력해주세요.'); return; }
    const store = useStore.getState(); const vendor = store.vendors.find(v => v.id === vendorId);
    if (!vendor || (existing && !store.spaces.some(s => s.id === spaceId))) { setError('사용할 공간과 카탈로그를 선택해주세요.'); return; }
    let id = spaceId;
    if (!existing) {
      id = `space-${crypto.randomUUID()}`;
      const space: Space = { id, name: `${name.trim()} 공간`, address: '', isVirtual: false, width:w, depth:d, height:3,
        doors:[], columns:[], zones:[], fixtures:[], powerPoints:[], rules:{minAisle:null,maxItemHeight:null,note:''},
        status:{scaleConfirmed:false,fieldMeasured:false,drawingDate:'',source:'사용자 입력',usageScope:'',note:'',checks:{}} };
      store.upsertSpace(space);
    }
    store.createProject(name.trim(),id,vendorId);
    const preferred: Category[] = ['counter','photozone','hanger'];
    store.updateProject(p => {
      p.budget={amount,scope:'fixtures'};
      p.event={...p.event,title:name.trim(),brand:'',contact:'',startDate:'',endDate:'',rentalDays:7,moveIn:'',teardown:'',conditions:'',brief:undefined};
      p.memo='';
      p.requirements=preferred.flatMap((category,i)=> { const item=vendor.items.find(it=>it.category===category); return item ? [{category,sku:item.sku,required:i<2,minQty:i<2?1:0,desiredQty:category==='hanger'?4:1,priority:i<2?1:2}] : []; });
    });
    store.toast('프로젝트를 만들었습니다. 도면에서 출입구와 기둥을 추가해주세요.');
    onClose();
    if (onCreated) onCreated();
    else window.location.hash = '#/spaces';
  };
  const vendor = vendors.find(v=>v.id===vendorId);
  return <dialog ref={dialog} className="quick-project-dialog" onCancel={e=>{e.preventDefault();onClose();}} aria-labelledby="new-project-title"><form onSubmit={e=>{e.preventDefault();create();}}>
    <div className="dialog-heading"><div><span className="eyebrow">A NEW POP-UP STARTS HERE</span><h2 id="new-project-title">어떤 팝업을 준비하시나요?</h2></div><button className="btn ghost" type="button" onClick={onClose} aria-label="새 프로젝트 닫기">✕</button></div>
    <p className="muted">기본 정보만 입력하면 시작할 수 있습니다. 기둥과 출입구는 다음 단계에서 도면으로 끌어 놓으세요.</p>
    <label className="field"><span>프로젝트 이름</span><input autoFocus className="input" placeholder="예: 가을 컬렉션 팝업" value={name} onChange={e=>setName(e.target.value)} maxLength={100} required /></label>
    <div className="quick-space-toggle seg"><button type="button" className={!existing?'on':''} onClick={()=>setExisting(false)}>새 공간 입력</button><button type="button" className={existing?'on':''} onClick={()=>setExisting(true)}>저장한 공간 사용</button></div>
    {existing ? <label className="field"><span>사용할 공간</span><select className="input" value={spaceId} onChange={e=>setSpaceId(e.target.value)}>{spaces.map(s=><option key={s.id} value={s.id}>{s.name} · {s.width} × {s.depth} m</option>)}</select></label> : <><div className="grid2"><label className="field"><span>가로 (m)</span><input className="input" type="number" min="0.5" max="200" step="0.01" value={width} onChange={e=>setWidth(e.target.value)} /></label><label className="field"><span>세로 (m)</span><input className="input" type="number" min="0.5" max="200" step="0.01" value={depth} onChange={e=>setDepth(e.target.value)} /></label></div><p className="size-hint">{Number(width)>0&&Number(depth)>0?`${(Number(width)*Number(depth)).toFixed(1)} m² · 약 ${(Number(width)*Number(depth)/3.3058).toFixed(1)}평`:''} · 예시 치수를 실제 도면에 맞게 바꿔주세요.</p></>}
    <div className="grid2"><label className="field"><span>집기·설치 예산 (원)</span><input className="input" inputMode="numeric" placeholder="미정이면 비워두세요" value={budget} onChange={e=>setBudget(e.target.value)} /></label><label className="field"><span>집기 카탈로그</span><select className="input" value={vendorId} onChange={e=>setVendorId(e.target.value)}>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label></div>
    <div className="quick-project-note"><span>시작 구성</span><p>{(['counter','photozone','hanger'] as Category[]).filter(c=>vendor?.items.some(i=>i.category===c)).map(c=>CATEGORY_LABEL[c]).join(' · ')||'집기 카탈로그에서 품목을 추가하세요.'} — 종류·규격·수량은 배치 화면에서 바꿀 수 있습니다.</p>{vendor?.isVirtual&&<p>선택한 카탈로그는 가상 예시입니다.</p>}</div>
    {error&&<p className="note error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>취소</button><button className="btn primary large" type="submit">공간 그리기 시작 →</button></div>
  </form></dialog>;
}
