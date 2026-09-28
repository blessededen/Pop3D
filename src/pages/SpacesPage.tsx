import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import SpaceCanvas from '../components/SpaceCanvas';
import { Field, NumInput, TextInput } from '../components/ui';
import { checkSpaceData } from '../domain/validate';
import type { LayoutData, RefModelMeta, Space, Wall } from '../domain/types';
import { duplicateSpaceObject, fitSpaceObject, removeSpaceObject, spaceObject, SPACE_KINDS, SPACE_KIND_LABEL, WALL_LABEL, type SpaceSelection, type SpaceTool } from '../domain/spaceEdit';
import { deleteBlob, putBlob } from '../lib/browser';
import { exportSpaceGlbFile } from '../lib/exporters';
import { useRefModel } from '../lib/useRefModel';
import { useStore } from '../store';
import { useInlineDemo } from '../lib/inlineDemo';
import '../workflow-sizing.css';

const ThreeView = lazy(() => import('../components/ThreeView'));
const NO_HIGHLIGHT = new Map();
const TOOL_ICON: Record<SpaceTool, string> = { select: '↖', columns: '▣', zones: '▧', fixtures: '▰', doors: '↗', powerPoints: 'ϟ' };
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function blankSpace(): Space {
  return { id: `space-${crypto.randomUUID()}`, name: '새 공간', address: '', isVirtual: false, width: 6, depth: 8, height: 3,
    doors: [{ id: 'D1', wall: 'bottom', offset: 2.4, width: 1.2, clearance: null, label: '출입구 1' }], columns: [], zones: [], fixtures: [], powerPoints: [],
    rules: { minAisle: null, maxItemHeight: null, note: '' }, status: { scaleConfirmed: false, fieldMeasured: false, drawingDate: '', source: '', usageScope: '', note: '', checks: {} } };
}
export default function SpacesPage({ guided = false, onEditReport }: { guided?: boolean; onEditReport?: () => void }) {
  const spaces = useStore(s => s.spaces), projects = useStore(s => s.projects), currentProjectId = useStore(s => s.currentProjectId);
  const st = useStore.getState;
  const project = projects.find(item => item.id === currentProjectId);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => project?.spaceId ?? spaces[0]?.id);
  // Guided work always edits the current project's room, never a stale management-page selection.
  const space = guided ? spaces.find(item => item.id === project?.spaceId) : spaces.find(item => item.id === selectedId) ?? spaces[0];
  const users = projects.filter(item => item.spaceId === space?.id);
  const connectSpace = (id: string) => {
    if (!project || !spaces.some(item => item.id === id)) return;
    st().setViewVersion(null);
    st().updateProject(item => { item.spaceId = id; });
  };
  const Container = guided ? 'div' : 'main';
  const spaceOptions = spaces.map(item => <option key={item.id} value={item.id}>{item.name}{item.isVirtual ? ' · 가상 예시' : ''}</option>);
  return <Container className={guided ? 'spaces-workspace spaces-guided' : 'page spaces-workspace'}>
    {!guided && <>
      <header className="space-heading"><div><span className="eyebrow">SPACE DESIGNER</span><h1>우리 공간을 그려보세요.</h1><p>공간 크기를 입력하고, 기둥·출입구·시설을 도면으로 끌어 놓으세요. 세부 치수는 필요할 때만 조정하면 됩니다.</p></div><button className="btn primary" onClick={() => { const next = blankSpace(); st().upsertSpace(next); setSelectedId(next.id); }}>+ 새 공간</button></header>
      <div className="space-project-bar"><label className="field"><span>편집할 공간</span><select className="input" value={space?.id ?? ''} onChange={event => setSelectedId(event.target.value)}>{spaceOptions}</select></label><div className="space-project-context"><strong>{space ? `${Number((space.width * space.depth).toFixed(2))}m²` : ''}</strong><span className="small muted">{users.length ? `${users.length}개 프로젝트에서 사용 중 · 수정 내용 자동 저장` : '아직 프로젝트에 연결되지 않은 공간'}</span></div><button className="btn" disabled={!space} onClick={() => { if (!space) return; connectSpace(space.id); window.location.hash = '#/layout'; }}>이 공간으로 배치하기 →</button></div>
    </>}
    {guided && space && spaces.length > 1 && <details className="guided-space-switch"><summary>다른 저장 공간 사용</summary><Field label="이 프로젝트의 공간"><select className="input" value={space.id} onChange={event => connectSpace(event.target.value)}>{spaceOptions}</select></Field><p className="hint">선택하면 이 프로젝트의 공간이 바뀝니다. 배치가 새 공간에 맞는지 다음 단계에서 확인하세요.</p></details>}
    {space ? <SpaceEditor key={space.id} guided={guided} space={space} onEditReport={space.id === project?.spaceId ? onEditReport : undefined} onChange={st().upsertSpace} onDelete={guided ? undefined : () => { if (!window.confirm(`'${space.name}' 공간을 삭제할까요?`)) return; if (!st().deleteSpace(space.id)) st().toast('프로젝트에서 사용 중이거나 마지막 공간은 삭제할 수 없습니다.', 'warn'); else setSelectedId(undefined); }} /> : <section className="panel space-recovery" role="status"><h3>편집할 공간을 연결해주세요.</h3>{!project && guided ? <p>현재 프로젝트를 찾을 수 없습니다. 작업 상단에서 프로젝트를 선택하거나 새 프로젝트를 만들어주세요.</p> : spaces.length ? <><p>프로젝트에 연결된 공간을 찾을 수 없습니다. 저장된 공간을 선택하면 여기서 이어서 편집할 수 있습니다.</p><Field label="연결할 저장 공간"><select className="input" value="" onChange={event => guided ? connectSpace(event.target.value) : setSelectedId(event.target.value)}><option value="" disabled>공간 선택</option>{spaceOptions}</select></Field></> : <><p>저장된 공간이 없습니다. 기본 공간을 만든 뒤 실제 도면 치수로 조정하세요.</p><button className="btn" onClick={() => { const next = blankSpace(); st().upsertSpace(next); if (guided && project) { st().setViewVersion(null); st().updateProject(item => { item.spaceId = next.id; }); } else setSelectedId(next.id); }}>기본 공간 복구</button></>}</section>}
  </Container>;
}

type SetSpace = (fn: (space: Space) => void) => void;
function SpaceEditor({ space, onChange, onDelete, guided = false }: { space: Space; onChange: (space: Space) => void; onDelete?: () => void; guided?: boolean; onEditReport?: () => void }) {
  const projectId = useStore(s => s.currentProjectId);
  const demoStage = useInlineDemo(s => s.projectId === projectId && ['running', 'sending'].includes(s.phase) && s.targetSpace?.id === space.id ? s.stage : null);
  const targetSpace = useInlineDemo(s => s.targetSpace);
  const demoElapsed = useInlineDemo(s => demoStage === 'space' ? s.elapsed : 0);
  const demo = demoStage && targetSpace ? { targetSpace, active: demoStage === 'space', elapsedMs: Math.max(0, (demoElapsed - 8) * 1000) } : undefined;
  const [selected, setSelected] = useState<SpaceSelection | null>(null), [tool, setTool] = useState<SpaceTool>('select');
  const [view, setView] = useState<'plan' | '3d'>('plan');
  const visibleView = demo ? 'plan' : view;
  const history = useRef<Space[]>([]), current = useRef(space);
  current.current = space;
  const [undoCount, setUndoCount] = useState(0);
  const commit = (next: Space) => {
    if (JSON.stringify(next) === JSON.stringify(current.current)) return;
    history.current = [...history.current.slice(-39), structuredClone(current.current)];
    setUndoCount(history.current.length); current.current = next; onChange(next);
  };
  const set: SetSpace = fn => { const next = structuredClone(current.current); fn(next); commit(next); };
  const undo = () => { const previous = history.current.pop(); if (!previous) return; setUndoCount(history.current.length); current.current = previous; onChange(previous); if (!spaceObject(previous, selected)) setSelected(null); };
  const remove = () => { if (!selected) return; set(s => removeSpaceObject(s, selected)); setSelected(null); };
  const duplicate = () => { if (!selected) return; let nextSelection: SpaceSelection | null = null; set(s => { nextSelection = duplicateSpaceObject(s, selected); }); setSelected(nextSelection); };
  const updateSelected = (fn: (obj: NonNullable<ReturnType<typeof spaceObject>>) => void, normalize = true) => {
    if (!selected) return;
    set(s => { const obj = spaceObject(s, selected); if (!obj) return; fn(obj); if (normalize) fitSpaceObject(s, selected); });
  };
  const object = spaceObject(space, selected), problems = checkSpaceData(space);
  const preview: LayoutData = useMemo(() => ({ projectName: space.name, space, vendor: { id: '', name: '', contact: '', catalogDate: '', isVirtual: false, items: [] }, event: { title: '', brand: '', contact: '', startDate: '', endDate: '', rentalDays: 1, moveIn: '', teardown: '', conditions: '' }, budget: { amount: null, scope: 'fixtures' }, requirements: [], placements: [], fees: [], memo: '' }), [space]);
  const refModel = useRefModel(space);
  const chooseTool = (next: SpaceTool) => { setView('plan'); setTool(next); if (next !== 'select') setSelected(null); };
  return <>
    <div className="space-design-grid">
      <section className="space-stage panel">
        <div className="panel-head"><div><h2>공간 도면</h2><span className="small muted">도구를 끌어 추가 · 몸통을 끌어 이동 · 끝점을 끌어 크기 조절</span></div><div className="row"><button className="btn sm" disabled={!undoCount} onClick={undo} title="도면에서 Ctrl+Z">↶ 되돌리기</button><div className="seg" aria-label="공간 보기"><button className={visibleView === 'plan' ? 'on' : ''} onClick={() => setView('plan')}>도면 편집</button><button className={visibleView === '3d' ? 'on' : ''} onClick={() => setView('3d')}>3D 확인</button></div></div></div>
        {visibleView === 'plan' ? <SpaceCanvas space={space} selected={selected} tool={tool} onSelect={setSelected} onToolChange={setTool} onChange={commit} onDelete={remove} onUndo={undo} onDuplicate={duplicate} demo={demo} /> : <Suspense fallback={<div className="viewbox" />}><ThreeView data={preview} highlight={NO_HIGHLIGHT} refModel={refModel} /></Suspense>}
        {space.doors.length === 0 && <div className="space-door-empty"><span>출입구가 아직 없어요. 벽에서 드나드는 위치를 표시해주세요.</span><button className="btn sm" onClick={() => chooseTool('doors')}>+ 출입구 놓기</button></div>}<div className="space-canvas-hints"><span>도구 → 도면으로 끌어 추가</span><span>드래그 · 5cm 맞춤</span><span>방향키 · 5cm 이동</span><span>Shift · 50cm 이동</span><span>Alt · 자유 이동</span><span>Delete · 삭제</span></div>
        {problems.length > 0 && <div className="note error" role="status">{problems.map(problem => <div key={problem}>{problem}</div>)}</div>}
      </section>
      <aside className="space-side">
        <section className="panel space-dimensions">
          <div className="panel-head"><h3>공간 크기</h3><span className="small muted">미터 m</span></div>
          <div className="room-size-fields"><Field label="가로"><NumInput ariaLabel="공간 가로 m" value={space.width} min={0.5} max={200} onChange={value => { if (value != null) set(s => { s.width = value; }); }} /></Field><Field label="세로·깊이"><NumInput ariaLabel="공간 세로 깊이 m" value={space.depth} min={0.5} max={200} onChange={value => { if (value != null) set(s => { s.depth = value; }); }} /></Field><Field label="수직 높이"><NumInput ariaLabel="공간 수직 높이 m" value={space.height} min={1} max={30} onChange={value => { if (value != null) set(s => { s.height = value; }); }} /></Field></div>
          <p className="hint">바닥에서 천장까지 사용할 수 있는 높이입니다. 이 높이 이상의 집기는 선택할 수 없습니다.</p>
          <details className="space-room-more" open={!guided}><summary>공간 이름</summary><div className="stack"><Field label="공간 이름"><TextInput value={space.name} onChange={value => set(s => { s.name = value; })} /></Field><p className="hint">공간 크기를 바꿔도 기존 기둥·시설 위치는 유지됩니다.</p></div></details>
        </section>
        {!object ? <p className="space-inspector-hint">도면에서 요소를 선택하면 크기를 조정할 수 있습니다.</p> : <section className="panel space-inspector">
          <div className="panel-head"><h3>{selected ? SPACE_KIND_LABEL[selected.kind] : '선택한 항목'}</h3><span className="small muted">센티미터 cm</span></div>
          <div className="stack">
            {'w' in object && <div className="grid2"><Field label="가로 폭"><NumInput ariaLabel="선택 항목 가로 cm" value={Number((object.w * 100).toFixed(2))} min={1} max={space.width * 100} onChange={value => { if (value != null) updateSelected(obj => { if ('w' in obj) obj.w = value / 100; }); }} /></Field><Field label="세로 깊이"><NumInput ariaLabel="선택 항목 세로 cm" value={Number((object.d * 100).toFixed(2))} min={1} max={space.depth * 100} onChange={value => { if (value != null) updateSelected(obj => { if ('d' in obj) obj.d = value / 100; }); }} /></Field></div>}
            {'wall' in object && <Field label="출입구 폭"><NumInput ariaLabel="출입구 폭 cm" value={Number((object.width * 100).toFixed(2))} min={1} max={(object.wall === 'top' || object.wall === 'bottom' ? space.width : space.depth) * 100} onChange={value => { if (value != null) updateSelected(obj => { if ('wall' in obj) obj.width = value / 100; }); }} /></Field>}
            {'x' in object && !('w' in object) && <p className="hint">도면에서 끌어 원하는 위치에 놓으세요.</p>}
            <details className="space-selection-more" key={`${selected?.kind}-${selected?.id}`} open={!guided}><summary>이름 · 정밀 위치 · 추가 설정</summary><div className="stack">
              <Field label="이름"><TextInput value={object.label} onChange={value => updateSelected(obj => { obj.label = value; }, false)} /></Field>
              {selected?.kind === 'columns' && <div className="space-size-presets"><span className="small muted">기둥 크기 빠른 설정</span><div className="row wrap">{[30, 50, 70].map(size => <button className="btn sm" key={size} onClick={() => updateSelected(obj => { if ('w' in obj) { obj.w = size / 100; obj.d = size / 100; } })}>{size} × {size}</button>)}</div></div>}
              {'x' in object && <div className="grid2"><Field label="왼쪽 벽에서 (cm)"><NumInput ariaLabel="왼쪽 벽에서 cm" value={Number((object.x * 100).toFixed(2))} min={0} max={(space.width - ('w' in object ? object.w : 0)) * 100} onChange={value => { if (value != null) updateSelected(obj => { if ('x' in obj) obj.x = value / 100; }); }} /></Field><Field label="위쪽 벽에서 (cm)"><NumInput ariaLabel="위쪽 벽에서 cm" value={Number((object.y * 100).toFixed(2))} min={0} max={(space.depth - ('d' in object ? object.d : 0)) * 100} onChange={value => { if (value != null) updateSelected(obj => { if ('y' in obj) obj.y = value / 100; }); }} /></Field></div>}
              {'w' in object && <p className="hint">왼쪽 위 모서리 기준입니다. 도면의 점선으로 벽과의 거리를 확인하세요.</p>}
              {'wall' in object && <><Field label="붙어 있는 벽"><select className="input" value={object.wall} onChange={event => updateSelected(obj => { if ('wall' in obj) obj.wall = event.target.value as Wall; })}>{(Object.keys(WALL_LABEL) as Wall[]).map(wall => <option key={wall} value={wall}>{WALL_LABEL[wall]}</option>)}</select></Field><Field label={`${object.wall === 'top' || object.wall === 'bottom' ? '왼쪽' : '위쪽'} 끝에서 (cm)`}><NumInput ariaLabel="출입구 벽 시작점에서 cm" value={Number((object.offset * 100).toFixed(2))} min={0} onChange={value => { if (value != null) updateSelected(obj => { if ('wall' in obj) obj.offset = value / 100; }); }} /></Field><Field label="문 앞 비울 거리 (cm)"><NumInput ariaLabel="문 앞 비울 거리 cm" allowNull value={object.clearance == null ? null : object.clearance * 100} min={0} placeholder="운영자 확인 전" onChange={value => updateSelected(obj => { if ('wall' in obj) obj.clearance = value == null ? null : value / 100; })} /></Field><p className="hint">몸통을 끌면 폭을 유지한 채 가까운 벽에 붙습니다. 양 끝점으로 폭을 조정합니다. 문 앞 여유를 비우면 해당 구역은 배치 검사에 포함되지 않습니다.</p></>}
              {'reason' in object && <Field label="금지 사유"><TextInput value={object.reason} placeholder="예: 비상 통로, 설비 점검 구역" onChange={value => updateSelected(obj => { if ('reason' in obj) obj.reason = value; }, false)} /></Field>}
            </div></details>
            <div className="row"><button className="btn grow" onClick={duplicate}>복제</button><button className="btn danger grow" onClick={remove}>삭제</button></div>
          </div>
        </section>}
        <details className="panel space-object-list" open={!guided}><summary>등록된 항목 <span className="small muted">{SPACE_KINDS.reduce((sum, kind) => sum + space[kind].length, 0)}개</span></summary>{SPACE_KINDS.map(kind => space[kind].map(item => <button type="button" className={`space-object-row ${selected?.kind === kind && selected.id === item.id ? 'active' : ''}`} key={`${kind}-${item.id}`} onClick={() => { setSelected({ kind, id: item.id }); setTool('select'); setView('plan'); }}><span aria-hidden="true">{TOOL_ICON[kind]}</span><span>{item.label}</span><small>{'w' in item ? `${Math.round(item.w * 100)} × ${Math.round(item.d * 100)}cm` : 'wall' in item ? WALL_LABEL[item.wall] : SPACE_KIND_LABEL[kind]}</small></button>))}</details>
      </aside>
    </div>
    <div className="space-meta-grid">
      {!guided && onDelete && <details className="panel space-advanced"><summary>공간 관리</summary><button className="btn ghost danger" onClick={onDelete}>공간 삭제</button></details>}
      <details className="panel space-advanced"><summary>3D 파일 가져오기 · 내보내기</summary><GlbPanel space={space} set={fn => { const next = structuredClone(current.current); fn(next); history.current = []; setUndoCount(0); current.current = next; onChange(next); }} /></details>
    </div>
    <p className="hint">입력한 공간은 현재 브라우저에 저장됩니다. 공간을 수정해도 이미 확정한 버전과 PDF의 공간 자료는 유지됩니다.</p>
  </>;
}
function GlbPanel({ space, set }: { space: Space; set: SetSpace }) {
  const toast = useStore((s) => s.toast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const meta = space.refModel;

  const onFile = async (f: File) => {
    setBusy(true);
    try {
      const buf = await f.arrayBuffer();
      const { loadRefGlb } = await import('../three/glb');
      const r = await loadRefGlb(buf.slice(0));
      await putBlob(`ref:${space.id}`, new Blob([buf], { type: 'model/gltf-binary' }));
      set((s) => {
        s.refModel = { fileName: f.name, scale: 1, rotY: 0, offsetX: 0, offsetZ: 0, measured: r.size, visible: true };
        s.status.checks = { ...(s.status.checks ?? {}), 'in.fileOpened': today() };
      });
      toast(`${f.name}을 불러왔습니다. 크기 비교를 확인하세요.`);
    } catch (e) {
      toast(`GLB를 열지 못했습니다: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const setMeta = (patch: Partial<RefModelMeta>) => set((s) => void (s.refModel = { ...s.refModel!, ...patch }));
  const cmp = meta ? compare(space, meta) : null;

  return (
    <section className="panel">
      <h3>GLB</h3>
      <div className="stack">
        <div className="row wrap">
          <button className="btn" onClick={() => exportSpaceGlbFile(space).catch((e) => toast((e as Error).message, 'error'))}>
            빈 매장 GLB 내보내기
          </button>
          <span className="hint">등록 치수로 바닥·벽·기둥·출입구만 만든 모델(m, Y-up)</span>
        </div>
        <div className="divider" />
        <div className="small" style={{ fontWeight: 700 }}>
          참고 스캔 GLB(보기용)
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Polycam·RoomPlan 등으로 만든 GLB를 겹쳐 보는 용도입니다. 배치 검사는 위에 등록한 치수로만 하고, 파일 크기가 맞아도 실측을 대신하지 않습니다.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".glb,model/gltf-binary"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? '불러오는 중…' : meta ? '다른 GLB로 바꾸기' : 'GLB 불러오기'}
        </button>
        {meta && cmp && (
          <>
            <div className={`note ${cmp.ok ? 'ok' : 'warn'}`}>
              {meta.fileName}: {cmp.w.toFixed(2)} × {cmp.d.toFixed(2)} × {cmp.h.toFixed(2)} m (등록 {space.width} × {space.depth} × {space.height} m) —{' '}
              {cmp.ok ? '가로·세로 차이 3% 이내' : `최대 ${(cmp.worst * 100).toFixed(1)}% 차이. 축척·방향·기존 가구 포함 여부를 확인하세요.`}
            </div>
            <div className="grid2">
              <Field label="배율">
                <NumInput value={meta.scale} min={0.001} max={1000} onChange={(v) => v && setMeta({ scale: v })} />
              </Field>
              <Field label="회전">
                <select className="input" value={meta.rotY} onChange={(e) => setMeta({ rotY: Number(e.target.value) as RefModelMeta['rotY'] })}>
                  {[0, 90, 180, 270].map((r) => (
                    <option key={r} value={r}>
                      {r}°
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="X 이동(m)">
                <NumInput value={meta.offsetX} onChange={(v) => v != null && setMeta({ offsetX: v })} />
              </Field>
              <Field label="Z 이동(m)">
                <NumInput value={meta.offsetZ} onChange={(v) => v != null && setMeta({ offsetZ: v })} />
              </Field>
            </div>
            <div className="row wrap">
              <label className="check">
                <input type="checkbox" checked={meta.visible} onChange={(e) => setMeta({ visible: e.target.checked })} />
                3D에 표시
              </label>
              <span className="grow" />
              <button
                className="btn sm ghost"
                title="원본 축척이 틀린 것이 확실할 때만"
                onClick={() => {
                  const w = meta.rotY === 90 || meta.rotY === 270 ? meta.measured.d : meta.measured.w;
                  if (w > 0) setMeta({ scale: Number((space.width / w).toFixed(4)) });
                }}
              >
                가로 치수에 배율 맞추기
              </button>
              <button
                className="btn sm ghost danger"
                onClick={async () => {
                  await deleteBlob(`ref:${space.id}`);
                  set((s) => void delete s.refModel);
                }}
              >
                제거
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function compare(space: Space, meta: RefModelMeta) {
  const rot = meta.rotY === 90 || meta.rotY === 270;
  const w = (rot ? meta.measured.d : meta.measured.w) * meta.scale;
  const d = (rot ? meta.measured.w : meta.measured.d) * meta.scale;
  const h = meta.measured.h * meta.scale;
  const diff = (a: number, b: number) => (b === 0 ? 0 : Math.abs(a - b) / b);
  const worst = Math.max(diff(w, space.width), diff(d, space.depth));
  return { w, d, h, worst, ok: worst <= 0.03 };
}
