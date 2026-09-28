import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Door, Rect, Space } from '../domain/types';
import { addSpaceObject, doorPoint, fitSpaceObject, moveSpaceObject, placeSpaceObjectCenter, resizeDoorEdge, snapSpace, spaceObject, SPACE_KIND_LABEL, type SpaceSelection, type SpaceTool } from '../domain/spaceEdit';
import { demoSpaceFrame } from '../domain/demoSpaceAnimation';
import InlineSpaceDemoOverlay, { type InlineSpaceDemo } from './InlineSpaceDemoOverlay';

interface Props {
  space: Space;
  tool: SpaceTool;
  selected: SpaceSelection | null;
  onSelect: (selection: SpaceSelection | null) => void;
  onToolChange: (tool: SpaceTool) => void;
  onChange: (space: Space) => void;
  onDelete: () => void;
  onUndo: () => void;
  onDuplicate: () => void;
  demo?: InlineSpaceDemo;
}
type ResizeMode = false | 'rect' | 'door-start' | 'door-end';
type Drag = { pointerId: number; selection: SpaceSelection; before: Space; next: Space; start: { x: number; y: number }; anchor: { x: number; y: number }; resize: ResizeMode; moved: boolean; previousSelection: SpaceSelection | null };
type Creation = { pointerId: number; kind: Exclude<SpaceTool, 'select'>; before: Space; seed: Space | null; next: Space | null; selection: SpaceSelection | null; origin: { x: number; y: number }; moved: boolean; palette: boolean; previousTool: SpaceTool; captureTarget: Element };
const TOOL_ICON: Record<SpaceTool, string> = { select: '↖', columns: '▣', zones: '▧', fixtures: '▰', doors: '↗', powerPoints: 'ϟ' };
const COLORS = { columns: { fill: 'var(--plan-column-fill, #54675f)', stroke: 'var(--plan-column-stroke, #344b41)' }, zones: { fill: 'var(--plan-zone-fill, #f9e9dc)', stroke: 'var(--plan-zone-stroke, #c68b52)' }, fixtures: { fill: 'var(--plan-fixture-fill, #dce8df)', stroke: 'var(--plan-fixture-stroke, #829b8a)' } };

export default function SpaceCanvas({ space, tool, selected, onSelect, onToolChange, onChange, onDelete, onUndo, onDuplicate, demo }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const creation = useRef<Creation | null>(null);
  const suppressClick = useRef(false);
  const [creationKind, setCreationKind] = useState<Exclude<SpaceTool, 'select'> | null>(null);
  const [previewSelection, setPreviewSelection] = useState<SpaceSelection | null>(null);
  const [preview, setPreview] = useState<Space | null>(null);
  const patternId = useId().replace(/:/g, '');
  const shown = preview ?? space;
  const demoFrame = demo?.active ? demoSpaceFrame(demo.targetSpace, demo.elapsedMs, { column: { x: 0, y: 0 }, power: { x: 0, y: 0 } }) : null;
  const fs = Math.max(0.12, Math.max(shown.width, shown.depth) / 42);
  const pad = fs * 4;
  const activeSelection = previewSelection ?? selected;
  const selectedObject = spaceObject(shown, activeSelection);
  const active = (kind: string, id: string) => activeSelection?.kind === kind && activeSelection.id === id;
  const local = (event: { clientX: number; clientY: number }) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };
  const begin = (event: PointerEvent<SVGElement>, selection: SpaceSelection, resize: ResizeMode = false) => {
    if (tool !== 'select' || event.button !== 0 || drag.current || creation.current) return;
    event.stopPropagation(); event.preventDefault();
    svgRef.current?.focus(); onSelect(selection);
    const obj = spaceObject(space, selection);
    if (!obj) return;
    const anchor = 'wall' in obj ? doorPoint(space, obj) : { x: obj.x, y: obj.y };
    drag.current = { pointerId: event.pointerId, selection, before: structuredClone(space), next: space, start: local(event), anchor, resize, moved: false, previousSelection: selected };
    svgRef.current?.setPointerCapture(event.pointerId);
  };
  const release = (target: Element, pointerId: number) => {
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  };
  const insideRoom = (point: { x: number; y: number }, kind: SpaceTool) => {
    const margin = kind === 'doors' ? fs * 0.7 : 0;
    return point.x >= -margin && point.y >= -margin && point.x <= space.width + margin && point.y <= space.depth + margin;
  };
  const previewCreation = (event: { clientX: number; clientY: number; altKey: boolean }) => {
    const c = creation.current;
    if (!c) return;
    const point = local(event);
    if (!insideRoom(point, c.kind)) { c.next = null; setPreview(null); setPreviewSelection(null); return; }
    if (!c.seed) {
      c.seed = structuredClone(c.before);
      c.selection = addSpaceObject(c.seed, c.kind, point.x, point.y);
    }
    const next = structuredClone(c.seed);
    placeSpaceObjectCenter(next, c.selection!, point.x, point.y, !event.altKey);
    c.next = next; setPreview(next); setPreviewSelection(c.selection);
  };
  const startCreation = (event: PointerEvent<Element>, kind: Exclude<SpaceTool, 'select'>, palette: boolean) => {
    if (event.button !== 0 || drag.current || creation.current) return;
    event.preventDefault(); event.stopPropagation();
    shellRef.current?.focus({ preventScroll: true });
    creation.current = { pointerId: event.pointerId, kind, before: structuredClone(space), seed: null, next: null, selection: null, origin: { x: event.clientX, y: event.clientY }, moved: false, palette, previousTool: tool, captureTarget: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
    setCreationKind(kind); onToolChange(kind);
    if (!palette) previewCreation(event);
  };
  const cancelCreation = () => {
    const c = creation.current;
    if (!c) return;
    creation.current = null; setCreationKind(null); setPreview(null); setPreviewSelection(null);
    onToolChange(c.previousTool); suppressClick.current = true;
    release(c.captureTarget, c.pointerId);
  };
  const move = (event: PointerEvent<Element>) => {
    const c = creation.current;
    if (c && c.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - c.origin.x, event.clientY - c.origin.y) >= 5) c.moved = true;
      if (!c.palette || c.moved) previewCreation(event);
      return;
    }
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const point = local(event);
    const dx = point.x - d.start.x, dy = point.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 0.015) return;
    d.moved = true;
    const next = structuredClone(d.before);
    const obj = spaceObject(next, d.selection);
    if (d.resize === 'rect' && obj && 'w' in obj) {
      obj.w = Math.max(0.05, event.altKey ? obj.w + dx : snapSpace(obj.w + dx));
      obj.d = Math.max(0.05, event.altKey ? obj.d + dy : snapSpace(obj.d + dy));
      obj.w = Math.min(obj.w, next.width - obj.x);
      obj.d = Math.min(obj.d, next.depth - obj.y);
      fitSpaceObject(next, d.selection);
    } else if (d.resize && obj && 'wall' in obj) {
      const horizontal = obj.wall === 'top' || obj.wall === 'bottom';
      const coordinate = d.resize === 'door-start' ? obj.offset : obj.offset + obj.width;
      resizeDoorEdge(next, obj.id, d.resize === 'door-start' ? 'start' : 'end', coordinate + (horizontal ? dx : dy), !event.altKey);
    } else moveSpaceObject(next, d.selection, d.anchor.x + dx, d.anchor.y + dy, !event.altKey);
    d.next = next; setPreview(next);
  };
  const finish = (event: PointerEvent<Element>, cancelled = false) => {
    const c = creation.current;
    if (c && c.pointerId === event.pointerId) {
      if (cancelled) { cancelCreation(); return; }
      // Use the final pointer location, even if the browser skipped the last move event.
      if (Math.hypot(event.clientX - c.origin.x, event.clientY - c.origin.y) >= 5) c.moved = true;
      if (!c.palette || c.moved) previewCreation(event);
      creation.current = null; setCreationKind(null); setPreview(null); setPreviewSelection(null);
      suppressClick.current = true;
      release(c.captureTarget, c.pointerId);
      if (c.next && c.selection && (!c.palette || c.moved)) {
        onChange(c.next); onSelect(c.selection); onToolChange('select');
      } else onToolChange(c.moved ? c.previousTool : c.kind);
      return;
    }
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    if (!cancelled) move(event);
    drag.current = null; setPreview(null);
    if (!cancelled && d.moved) onChange(d.next);
    if (cancelled) onSelect(d.previousSelection);
    if (svgRef.current) release(svgRef.current, event.pointerId);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (demo) return;
    if (event.key === 'Escape' && creation.current) { event.preventDefault(); cancelCreation(); return; }
    if (creation.current) return;
    if (drag.current && event.key !== 'Escape') {
      if (['Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || ((event.ctrlKey || event.metaKey) && ['z', 'd'].includes(event.key.toLowerCase()))) event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); onUndo(); return; }
    if (event.key === 'Escape') { const d = drag.current; drag.current = null; setPreview(null); if (d && svgRef.current) release(svgRef.current, d.pointerId); onToolChange('select'); onSelect(d ? d.previousSelection : null); return; }
    if (!selected) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onDelete(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); onDuplicate(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const next = structuredClone(space), obj = spaceObject(next, selected);
    if (!obj) return;
    const step = event.shiftKey ? 0.5 : 0.05;
    if ('wall' in obj) {
      // Doors move along their wall; drag to transfer them to another wall.
      const length = obj.wall === 'top' || obj.wall === 'bottom' ? next.width : next.depth;
      const offset = obj.offset + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -step : step);
      obj.offset = Math.max(0, Math.min(Math.max(0, length - obj.width), offset));
    } else moveSpaceObject(next, selected, obj.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), obj.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
    onChange(next);
  };
  const renderRect = (rect: Rect, kind: 'columns' | 'zones' | 'fixtures') => {
    const isSelected = active(kind, rect.id), color = COLORS[kind];
    const handleHalf = Math.min(fs * 0.3, Math.min(rect.w, rect.d) * 0.15);
    return <g key={rect.id} role="button" tabIndex={0} aria-label={`${rect.label}, 가로 ${Math.round(rect.w * 100)}cm 세로 ${Math.round(rect.d * 100)}cm`} onFocus={() => onSelect({ kind, id: rect.id })} onPointerDown={event => begin(event, { kind, id: rect.id })} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind, id: rect.id }); } }} style={{ cursor: tool === 'select' ? 'grab' : 'crosshair' }}>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.d} rx={kind === 'columns' ? 0.015 : 0.04} fill={kind === 'zones' ? `url(#${patternId}-zone)` : color.fill} stroke={isSelected ? 'var(--plan-selection, #28745a)' : color.stroke} strokeWidth={isSelected ? 0.06 : 0.025} />
      {isSelected && <rect x={rect.x - 0.07} y={rect.y - 0.07} width={rect.w + 0.14} height={rect.d + 0.14} fill="none" stroke="var(--plan-selection, #28745a)" strokeWidth={0.018} strokeDasharray=".05 .04" pointerEvents="none" />}
      <text className="space-shape-label" x={rect.x + rect.w / 2} y={rect.y + rect.d / 2} fontSize={Math.min(fs * 0.75, rect.w / Math.max(3, rect.label.length) * 1.55)} fill={kind === 'columns' ? 'var(--plan-object-label, #fff)' : 'var(--plan-label, #344b41)'} textAnchor="middle" dominantBaseline="middle" pointerEvents="none">{rect.label}</text>
      {isSelected && <g onPointerDown={event => begin(event, { kind, id: rect.id }, 'rect')} style={{ cursor: 'nwse-resize' }} aria-label="크기 조절"><circle cx={rect.x + rect.w} cy={rect.y + rect.d} r={Math.min(fs * 1.5, Math.min(rect.w, rect.d) * 0.35)} fill="transparent" role="img" aria-label={`${rect.label} 크기 조절 핸들`}><title>드래그하거나 선택 패널에서 가로와 세로를 조정하세요.</title></circle><rect x={rect.x + rect.w - handleHalf} y={rect.y + rect.d - handleHalf} width={handleHalf * 2} height={handleHalf * 2} rx={0.02} fill="var(--plan-floor, #fff)" stroke="var(--plan-selection, #28745a)" strokeWidth={0.035} /></g>}
    </g>;
  };
  const renderDoor = (door: Door) => {
    const center = doorPoint(shown, door), horizontal = door.wall === 'top' || door.wall === 'bottom';
    const isSelected = active('doors', door.id);
    const x1 = horizontal ? door.offset : center.x, y1 = horizontal ? center.y : door.offset;
    const x2 = horizontal ? door.offset + door.width : center.x, y2 = horizontal ? center.y : door.offset + door.width;
    const depth = door.clearance ?? 0;
    return <g key={door.id} role="button" tabIndex={0} aria-label={`${door.label}, 폭 ${Math.round(door.width * 100)}cm`} onFocus={() => onSelect({ kind: 'doors', id: door.id })} onPointerDown={event => begin(event, { kind: 'doors', id: door.id })} style={{ cursor: tool === 'select' ? 'grab' : 'crosshair' }}>
      {depth > 0 && <rect x={horizontal ? door.offset : door.wall === 'left' ? 0 : shown.width - depth} y={horizontal ? door.wall === 'top' ? 0 : shown.depth - depth : door.offset} width={horizontal ? door.width : depth} height={horizontal ? depth : door.width} fill="var(--plan-fixture-fill, #e8f4f2)" fillOpacity={0.8} stroke="var(--plan-fixture-stroke, #9cbab3)" strokeWidth={0.015} strokeDasharray=".08 .06" pointerEvents="none" />}
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--plan-floor, #fff)" strokeWidth={0.14} />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={isSelected ? 'var(--plan-selection, #1f7459)' : 'var(--plan-fixture-stroke, #52a085)'} strokeWidth={isSelected ? 0.1 : 0.06} />
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={fs * 2.4} />
      {isSelected && (['start', 'end'] as const).map(edge => {
        const x = edge === 'start' ? x1 : x2, y = edge === 'start' ? y1 : y2;
        return <g key={edge} aria-label={`${door.label} ${edge === 'start' ? '시작' : '끝'} 폭 조절`} onPointerDown={event => begin(event, { kind: 'doors', id: door.id }, edge === 'start' ? 'door-start' : 'door-end')} style={{ cursor: horizontal ? 'ew-resize' : 'ns-resize' }}><circle cx={x} cy={y} r={Math.min(fs * 1.5, door.width * 0.22)} fill="transparent" /><circle cx={x} cy={y} r={Math.min(fs * 0.38, door.width * 0.12)} fill="var(--plan-floor, #fff)" stroke="var(--plan-selection, #28745a)" strokeWidth={0.035} /><title>출입구 끝점을 끌어 폭을 조절하세요.</title></g>;
      })}
      <text x={center.x + (horizontal ? 0 : door.wall === 'left' ? fs : -fs)} y={center.y + (horizontal ? door.wall === 'top' ? fs * 1.15 : -fs * 0.65 : 0)} textAnchor={horizontal ? 'middle' : door.wall === 'left' ? 'start' : 'end'} fontSize={fs * 0.72} fill="var(--plan-label, #30765e)" pointerEvents="none">{`${door.label} · ${Math.round(door.width * 100)}cm`}</text>
    </g>;
  };

  const renderTool = (kind: SpaceTool) => <button key={kind} type="button" data-space-tool={kind} className={`space-tool ${tool === kind ? 'active' : ''}`} aria-pressed={tool === kind} title={kind === 'select' ? '기존 요소를 선택해서 이동' : `${SPACE_KIND_LABEL[kind]}: 도면으로 끌기 또는 선택 후 도면 누르기`} onPointerDown={event => { suppressClick.current = false; if (kind !== 'select') startCreation(event, kind, true); }} onClick={event => {
      if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; }
      onToolChange(kind);
    }}><span aria-hidden="true">{TOOL_ICON[kind]}</span>{kind === 'select' ? '선택·이동' : SPACE_KIND_LABEL[kind]}{kind !== 'select' && <small aria-hidden="true">⠿</small>}</button>;

  return <div ref={shellRef} className="space-canvas-shell" data-inline-demo={!!demo} data-demo-tool={demoFrame && ['press', 'drag'].includes(demoFrame.phase) ? demoFrame.operation?.kind : undefined} tabIndex={-1} onKeyDown={keys} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => {
    if (creation.current?.pointerId === event.pointerId) cancelCreation();
    if (drag.current?.pointerId === event.pointerId) { const previous = drag.current.previousSelection; drag.current = null; setPreview(null); onSelect(previous); }
  }}>
    <div className="space-tools" role="toolbar" aria-label="공간 도구. 원하는 요소를 도면으로 끌어 놓으세요.">
      {(['select', 'columns', 'doors'] as SpaceTool[]).map(renderTool)}
      <details className="space-extra-tools" open={demo ? true : undefined}><summary onClick={event => { if (creation.current) event.preventDefault(); }}>추가 요소 <span aria-hidden="true">＋</span></summary><div className="space-extra-tools-list">{(['zones', 'fixtures', 'powerPoints'] as SpaceTool[]).map(renderTool)}</div></details>
    </div>
    <p className="space-drag-tip">도구를 도면으로 끌어 놓으세요. 터치 화면에서도 손가락으로 옮길 수 있습니다.</p>
    <div className={`space-canvas-wrap ${creationKind ? 'is-dropping' : ''}`}>
    <svg ref={svgRef} className="space-canvas" viewBox={`${-pad} ${-pad} ${shown.width + pad * 2} ${shown.depth + pad * 2}`} style={{ width: '100%', touchAction: 'none', userSelect: 'none', cursor: tool === 'select' ? 'default' : 'crosshair' }} tabIndex={0} aria-label="공간 편집 도면. 도구를 선택해 추가하거나 객체를 끌어 옮기세요. 방향키로 5cm 이동, Delete 삭제, Ctrl Z 되돌리기." onPointerDown={event => {
      if (event.button !== 0 || drag.current || creation.current) return;
      svgRef.current?.focus();
      if (tool === 'select') { onSelect(null); return; }
      if (!insideRoom(local(event), tool)) return;
      startCreation(event, tool, false);
    }}>
      <defs><pattern id={`${patternId}-grid`} width={1} height={1} patternUnits="userSpaceOnUse"><path d="M 1 0 H 0 V 1" fill="none" stroke="var(--plan-grid, #e1e8e2)" strokeWidth={0.015} /></pattern><pattern id={`${patternId}-zone`} width={0.18} height={0.18} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width={0.18} height={0.18} fill="var(--plan-zone-fill, #fcf0e6)" /><line x1={0} y1={0} x2={0} y2={0.18} stroke="var(--plan-zone-stroke, #e2b990)" strokeWidth={0.035} /></pattern></defs>
      <rect x={0} y={0} width={shown.width} height={shown.depth} fill="var(--plan-floor, #fdfdfb)" />
      <rect x={0} y={0} width={shown.width} height={shown.depth} fill={`url(#${patternId}-grid)`} stroke="var(--plan-wall, #64766b)" strokeWidth={0.07} />
      <g className="space-ruler" fill="var(--plan-label, #65776b)" stroke="var(--plan-wall, #b4c3b8)" strokeWidth={0.014} pointerEvents="none">
        <line x1={0} y1={-fs * 1.65} x2={shown.width} y2={-fs * 1.65} /><line x1={-fs * 1.65} y1={0} x2={-fs * 1.65} y2={shown.depth} />
        {[0, shown.width].map(x => <line key={`x${x}`} x1={x} y1={-fs * 2} x2={x} y2={-fs * 1.25} />)}
        {[0, shown.depth].map(y => <line key={`y${y}`} x1={-fs * 2} y1={y} x2={-fs * 1.25} y2={y} />)}
        <text x={shown.width / 2} y={-fs * 2.15} fontSize={fs * 0.92} textAnchor="middle" stroke="none">{`가로 ${shown.width} m`}</text>
        <text transform={`translate(${-fs * 2.35} ${shown.depth / 2}) rotate(-90)`} fontSize={fs * 0.92} textAnchor="middle" stroke="none">{`세로 ${shown.depth} m`}</text>
      </g>
      {shown.zones.map(rect => renderRect(rect, 'zones'))}
      {shown.fixtures.map(rect => renderRect(rect, 'fixtures'))}
      {shown.columns.map(rect => renderRect(rect, 'columns'))}
      {shown.doors.map(renderDoor)}
      {shown.powerPoints.map(point => <g key={point.id} role="button" tabIndex={0} aria-label={point.label} onFocus={() => onSelect({ kind: 'powerPoints', id: point.id })} onPointerDown={event => begin(event, { kind: 'powerPoints', id: point.id })} style={{ cursor: 'grab' }}><circle cx={point.x} cy={point.y} r={fs * 1.5} fill="transparent" /><circle cx={point.x} cy={point.y} r={fs * 0.64} fill={active('powerPoints', point.id) ? 'var(--plan-selection, #306e57)' : 'var(--plan-zone-fill, #fff6d8)'} stroke={active('powerPoints', point.id) ? 'var(--plan-selection, #214f3f)' : 'var(--plan-zone-stroke, #c9aa5b)'} strokeWidth={0.025} /><text x={point.x} y={point.y} dominantBaseline="middle" textAnchor="middle" fontSize={fs} fill={active('powerPoints', point.id) ? 'var(--plan-selection-text, #fff)' : 'var(--plan-zone-stroke, #a88738)'} pointerEvents="none">ϟ</text></g>)}
      {selectedObject && 'x' in selectedObject && <g pointerEvents="none" stroke="var(--plan-selection, #509275)" strokeWidth={0.014} strokeDasharray=".07 .05" fill="var(--plan-selection, #34755a)"><line x1={0} y1={selectedObject.y} x2={selectedObject.x} y2={selectedObject.y} /><line x1={selectedObject.x} y1={0} x2={selectedObject.x} y2={selectedObject.y} />{selectedObject.x > fs * 3 && <text x={selectedObject.x / 2} y={selectedObject.y - fs * 0.3} fontSize={fs * 0.67} textAnchor="middle" stroke="none">{`${Math.round(selectedObject.x * 100)}cm`}</text>}{selectedObject.y > fs * 3 && <text x={selectedObject.x + fs * 0.3} y={selectedObject.y / 2} fontSize={fs * 0.67} stroke="none">{`${Math.round(selectedObject.y * 100)}cm`}</text>}</g>}
      <text x={shown.width / 2} y={shown.depth + fs * 2.3} fontSize={fs * 0.76} fill="var(--plan-label, #8b9b91)" textAnchor="middle" pointerEvents="none">{`격자 1m · 전체 ${Number((shown.width * shown.depth).toFixed(2))}m²`}</text>
    </svg>
    <div className="space-canvas-status" role="status">{creationKind ? previewSelection ? `${SPACE_KIND_LABEL[creationKind]}를 이 위치에 놓습니다. 손을 떼면 저장됩니다.` : `${SPACE_KIND_LABEL[creationKind]}를 도면 안으로 끌어 놓으세요. 도면 밖에서는 추가되지 않습니다.` : tool !== 'select' ? `${SPACE_KIND_LABEL[tool]}를 도면에서 누른 채 원하는 위치로 끌어 놓으세요${tool === 'doors' ? ' · 가까운 벽에 붙습니다' : ''}.` : selectedObject ? `${selectedObject.label} 선택됨 · 몸통을 끌어 이동${'w' in selectedObject ? ', 오른쪽 아래 점으로 크기 조절' : 'wall' in selectedObject ? ', 양 끝점으로 출입구 폭 조절' : ''}` : '위 도구를 도면으로 끌어 놓으세요. 놓인 요소는 바로 끌어서 이동할 수 있습니다.'}</div>
    </div>
    {demo && <InlineSpaceDemoOverlay {...demo} shellRef={shellRef} svgRef={svgRef} />}
  </div>;
}
