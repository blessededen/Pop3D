import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { bounds, doorClearRect, footprint } from '../domain/geometry';
import { indexItems, placementNumbers, type Issue } from '../domain/validate';
import { FRONT_ACCESS_DEPTH, frontAccessPoly } from '../domain/placementRules';
import type { LayoutData, Space, Wall } from '../domain/types';
import './PlanView.css';

interface Props {
  data: LayoutData;
  issues: Issue[];
  selectedId: string | null;
  editable: boolean;
  onSelect?: (id: string | null) => void;
  onMoveStart?: () => void;
  onMove?: (id: string, x: number, y: number) => void;
  onMoveEnd?: () => void;
  showItems?: boolean;
  className?: string;
}

const SNAP = 0.05;
const WALL_MAGNET = 0.12;

function wallSegs(space: Space, wall: Wall): [number, number][] {
  const len = wall === 'top' || wall === 'bottom' ? space.width : space.depth;
  const cuts = space.doors
    .filter((d) => d.wall === wall)
    .map((d) => [d.offset, d.offset + d.width] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let s = 0;
  for (const [a, b] of cuts) {
    if (a > s) out.push([s, a]);
    s = Math.max(s, b);
  }
  if (len > s) out.push([s, len]);
  return out;
}

function lighten(hex: string, t: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xb9bcc2;
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * t));
  return `rgb(${c.join(',')})`;
}

export default function PlanView({ data, issues, selectedId, editable, onSelect, onMoveStart, onMove, onMoveEnd, showItems = true, className }: Props) {
  const { space } = data;
  const W = space.width;
  const D = space.depth;
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean; pid: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [screenUnit, setScreenUnit] = useState(0.025);

  const items = useMemo(() => indexItems(data.vendor.items), [data.vendor.items]);
  const nums = useMemo(() => placementNumbers(data.placements), [data.placements]);
  const status = useMemo(() => {
    const m = new Map<string, 'error' | 'warning'>();
    for (const i of issues) {
      for (const id of i.placementIds) {
        if (i.severity === 'error') m.set(id, 'error');
        else if (i.severity === 'warning' && !m.has(id)) m.set(id, 'warning');
      }
    }
    return m;
  }, [issues]);

  const fs = Math.max(0.16, Math.min(0.45, Math.max(W, D) / 34));
  const pad = fs * 4.4;
  const vb = `${-pad} ${-pad} ${W + pad * 2} ${D + pad * 2}`;
  const wallW = Math.max(0.08, fs * 0.55);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const matrix = svg.getScreenCTM();
      const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 0;
      if (scale > 0) setScreenUnit(1 / scale);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [W, D, pad]);

  const numberFont = screenUnit * 10;
  const distanceFont = screenUnit * 11;
  const accessDepth = Math.max(FRONT_ACCESS_DEPTH, Number.isFinite(space.rules.minAisle) ? space.rules.minAisle ?? 0 : 0);

  const toLocal = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current!;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: pt.x, y: pt.y };
  };

  const onItemDown = (e: RPointerEvent, id: string) => {
    e.stopPropagation();
    onSelect?.(id);
    if (!editable) return;
    const p = data.placements.find((x) => x.id === id)!;
    const l = toLocal(e);
    drag.current = { id, sx: l.x, sy: l.y, ox: p.x, oy: p.y, moved: false, pid: e.pointerId };
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // 캡처를 못 해도 svg 안에서의 이동은 그대로 받는다
    }
  };

  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pid) return;
    const l = toLocal(e);
    const dx = l.x - d.sx;
    const dy = l.y - d.sy;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 0.03) return;
      d.moved = true;
      setDragId(d.id);
      onMoveStart?.();
    }
    let x = d.ox + dx;
    let y = d.oy + dy;
    if (!e.altKey) {
      x = Math.round(x / SNAP) * SNAP;
      y = Math.round(y / SNAP) * SNAP;
      const p = data.placements.find((q) => q.id === d.id);
      const it = p && items.get(p.sku);
      if (p && it) {
        const b = bounds(footprint(x, y, it.w, it.d, p.rot));
        if (Math.abs(b.minX) < WALL_MAGNET) x -= b.minX;
        else if (Math.abs(W - b.maxX) < WALL_MAGNET) x += W - b.maxX;
        if (Math.abs(b.minY) < WALL_MAGNET) y -= b.minY;
        else if (Math.abs(D - b.maxY) < WALL_MAGNET) y += D - b.maxY;
      }
    }
    onMove?.(d.id, x, y);
  };

  const endDrag = (e: RPointerEvent) => {
    if (drag.current && e.pointerId === drag.current.pid) {
      const moved = drag.current.moved;
      try {
        svgRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // 무시
      }
      drag.current = null;
      setDragId(null);
      if (moved) onMoveEnd?.();
    }
  };

  const sel = selectedId ? data.placements.find((p) => p.id === selectedId) : undefined;
  const selItem = sel ? items.get(sel.sku) : undefined;
  const selBounds = sel && selItem ? bounds(footprint(sel.x, sel.y, selItem.w, selItem.d, sel.rot)) : null;

  const grid: ReactNode[] = [];
  for (let x = 0.5; x < W - 1e-6; x += 0.5) {
    const major = Math.abs(x - Math.round(x)) < 1e-6;
    grid.push(<line key={`gx${x}`} x1={x} y1={0} x2={x} y2={D} stroke={major ? 'var(--plan-grid, #dcd8cf)' : 'var(--plan-grid, #ebe8e1)'} strokeWidth={major ? 0.018 : 0.01} />);
  }
  for (let y = 0.5; y < D - 1e-6; y += 0.5) {
    const major = Math.abs(y - Math.round(y)) < 1e-6;
    grid.push(<line key={`gy${y}`} x1={0} y1={y} x2={W} y2={y} stroke={major ? 'var(--plan-grid, #dcd8cf)' : 'var(--plan-grid, #ebe8e1)'} strokeWidth={major ? 0.018 : 0.01} />);
  }

  const dimOff = fs * 2.2;
  const tick = fs * 0.5;

  return (
    <svg
      ref={svgRef}
      className={`plan-svg ${className ?? ''}`}
      viewBox={vb}
      preserveAspectRatio="xMidYMid meet"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={() => onSelect?.(null)}
      role="img"
      aria-label={`${space.name} 평면 배치도`}
    >
      <defs>
        <pattern id="hatch-red" patternUnits="userSpaceOnUse" width="0.16" height="0.16" patternTransform="rotate(45)">
          <rect width="0.16" height="0.16" fill="var(--plan-zone-fill, #fde6e6)" />
          <line x1="0" y1="0" x2="0" y2="0.16" stroke="var(--plan-zone-stroke, #e5484d)" strokeWidth="0.035" />
        </pattern>
        <pattern id="hatch-gray" patternUnits="userSpaceOnUse" width="0.16" height="0.16" patternTransform="rotate(45)">
          <rect width="0.16" height="0.16" fill="var(--plan-fixture-fill, #e7e8ea)" />
          <line x1="0" y1="0" x2="0" y2="0.16" stroke="var(--plan-fixture-stroke, #8a8f98)" strokeWidth="0.03" />
        </pattern>
      </defs>

      <rect x={0} y={0} width={W} height={D} fill="var(--plan-floor, #faf9f6)" />
      {grid}

      {space.doors.map((d) => {
        const r = doorClearRect(space, d);
        return r ? (
          <rect key={r.id} x={r.x} y={r.y} width={r.w} height={r.d} fill="var(--plan-zone-fill, #fdf0d2)" stroke="var(--plan-zone-stroke, #e0a526)" strokeWidth={0.02} strokeDasharray="0.08 0.06" />
        ) : null;
      })}
      {space.zones.map((z) => (
        <g key={z.id}>
          <rect x={z.x} y={z.y} width={z.w} height={z.d} fill="url(#hatch-red)" stroke="var(--plan-zone-stroke, #e5484d)" strokeWidth={0.025} />
          <text x={z.x + z.w / 2} y={z.y + z.d / 2} fontSize={fs * 0.72} textAnchor="middle" dominantBaseline="middle" fill="var(--plan-zone-stroke, #b4232a)" fontWeight={700} paintOrder="stroke" stroke="var(--plan-floor, #fff)" strokeWidth={fs * 0.2}>
            {z.label}
          </text>
        </g>
      ))}
      {space.fixtures.map((f) => (
        <g key={f.id}>
          <rect x={f.x} y={f.y} width={f.w} height={f.d} fill="url(#hatch-gray)" stroke="var(--plan-fixture-stroke, #6e737b)" strokeWidth={0.02} />
          <text x={f.x + f.w / 2} y={f.y - fs * 0.35} fontSize={fs * 0.62} textAnchor="middle" fill="var(--plan-label, #55595f)">
            {f.label}
          </text>
        </g>
      ))}
      {space.columns.map((c) => (
        <rect key={c.id} x={c.x} y={c.y} width={c.w} height={c.d} fill="var(--plan-column-fill, #9aa0a6)" stroke="var(--plan-column-stroke, #6e737b)" strokeWidth={0.02} />
      ))}

      <g stroke="var(--plan-wall, #1d1d1f)" strokeWidth={wallW} strokeLinecap="square">
        {wallSegs(space, 'top').map(([a, b]) => <line key={`t${a}`} x1={a} y1={0} x2={b} y2={0} />)}
        {wallSegs(space, 'bottom').map(([a, b]) => <line key={`b${a}`} x1={a} y1={D} x2={b} y2={D} />)}
        {wallSegs(space, 'left').map(([a, b]) => <line key={`l${a}`} x1={0} y1={a} x2={0} y2={b} />)}
        {wallSegs(space, 'right').map(([a, b]) => <line key={`r${a}`} x1={W} y1={a} x2={W} y2={b} />)}
      </g>
      {space.doors.map((d) => {
        const mid = d.offset + d.width / 2;
        const off = fs * 1.1;
        const pos =
          d.wall === 'bottom' ? { x: mid, y: D + off } : d.wall === 'top' ? { x: mid, y: -off * 0.6 } : d.wall === 'left' ? { x: -off, y: mid } : { x: W + off, y: mid };
        return (
          <text key={d.id} x={pos.x} y={pos.y} fontSize={fs * 0.66} textAnchor="middle" dominantBaseline="middle" fill="var(--plan-label, #6e6e73)" fontWeight={600}>
            {d.label}
          </text>
        );
      })}
      {space.powerPoints.map((p) => (
        <circle key={p.id} cx={p.x} cy={p.y} r={fs * 0.28} fill="var(--plan-zone-stroke, #f2c230)" stroke="var(--plan-floor, #fff)" strokeWidth={fs * 0.08}>
          <title>{p.label}</title>
        </circle>
      ))}

      {/* 치수선 */}
      <g stroke="var(--plan-wall, #8a8a8f)" strokeWidth={0.015} fill="var(--plan-label, #3a3a3e)" fontSize={fs * 0.75}>
        <line x1={0} y1={-dimOff} x2={W} y2={-dimOff} />
        <line x1={0} y1={-dimOff - tick} x2={0} y2={-dimOff + tick} />
        <line x1={W} y1={-dimOff - tick} x2={W} y2={-dimOff + tick} />
        <text x={W / 2} y={-dimOff - fs * 0.45} textAnchor="middle" stroke="none" fontWeight={600}>
          {`${W.toFixed(2)} m`}
        </text>
        <line x1={-dimOff} y1={0} x2={-dimOff} y2={D} />
        <line x1={-dimOff - tick} y1={0} x2={-dimOff + tick} y2={0} />
        <line x1={-dimOff - tick} y1={D} x2={-dimOff + tick} y2={D} />
        <text x={-dimOff - fs * 0.45} y={D / 2} textAnchor="middle" stroke="none" fontWeight={600} transform={`rotate(-90 ${-dimOff - fs * 0.45} ${D / 2})`}>
          {`${D.toFixed(2)} m`}
        </text>
      </g>

      {showItems &&
        data.placements.map((p) => {
          const it = items.get(p.sku);
          if (!it) {
            return (
              <g key={p.id} transform={`translate(${p.x} ${p.y})`} onPointerDown={(e) => onItemDown(e, p.id)} className="item">
                <circle r={fs * 0.6} fill="var(--err-soft, #fdeaea)" stroke="var(--err, #d92d33)" strokeWidth={0.03} />
                <text fontSize={fs * 0.7} textAnchor="middle" dominantBaseline="central" fill="var(--err, #d92d33)">
                  ?
                </text>
              </g>
            );
          }
          const st = status.get(p.id);
          const isSel = p.id === selectedId;
          const access = editable && isSel ? frontAccessPoly(p, it, accessDepth) : null;
          const stroke = st === 'error' ? 'var(--err, #d92d33)' : isSel ? 'var(--plan-selection, #2f6bff)' : st === 'warning' ? 'var(--warn, #c27a00)' : 'var(--plan-fixture-stroke, #2a2a2e)';
          return (
            <g
              key={p.id}
              className={`item ${dragId === p.id ? 'dragging' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`${nums.get(p.id)}번 ${it.name}, ${Math.round(it.w * 100)} × ${Math.round(it.d * 100)}cm`}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(p.id); } }}
              onPointerDown={(e) => onItemDown(e, p.id)}
              style={{ cursor: editable ? undefined : 'pointer' }}
            >
              {access && <polygon points={access.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={stroke} strokeOpacity={0.45} strokeWidth={0.75} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" pointerEvents="none"><title>{`정면 사용 공간 ${Math.round(accessDepth * 100)}cm`}</title></polygon>}
              <g transform={`translate(${p.x} ${p.y}) rotate(${p.rot})`}>
                <rect
                  x={-it.w / 2}
                  y={-it.d / 2}
                  width={it.w}
                  height={it.d}
                  fill={st === 'error' ? 'var(--plan-fixture-error-fill, #fbd5d6)' : isSel || dragId === p.id ? 'var(--plan-fixture-selected-fill, #d7e7ef)' : `var(--plan-fixture-fill, ${lighten(it.color, 0.55)})`}
                  stroke={stroke}
                  strokeWidth={isSel ? 1.5 : 1}
                  vectorEffect="non-scaling-stroke"
                  strokeDasharray={p.noOrder ? '4 3' : undefined}
                  rx={0.02}
                />
                <line x1={-it.w / 2} y1={it.d / 2} x2={it.w / 2} y2={it.d / 2} stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                <rect className="plan-item-focus" x={-it.w / 2} y={-it.d / 2} width={it.w} height={it.d} rx={0.02} fill="none" stroke="var(--plan-selection, #2f6bff)" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
              </g>
              <g transform={`translate(${p.x} ${p.y})`} pointerEvents="none">
                <text fontSize={numberFont} textAnchor="middle" dominantBaseline="central" fill="var(--plan-object-label, #344054)" opacity={0.9} fontWeight={600}>
                  {nums.get(p.id)}
                </text>
              </g>
            </g>
          );
        })}

      {/* 선택한 집기에서 벽까지 거리 */}
      {selBounds && (
        <g className="plan-distance-guides" fill="var(--plan-selection, #2f6bff)" fontSize={distanceFont} pointerEvents="none">
          {(() => {
            const cy = (selBounds.minY + selBounds.maxY) / 2;
            const cx = (selBounds.minX + selBounds.maxX) / 2;
            const lines: ReactNode[] = [];
            const label = (x: number, y: number, v: number, k: string) => (
              <text key={k} x={x} y={y} textAnchor="middle" dominantBaseline="middle" stroke="none" fontWeight={500}>
                {v.toFixed(2)}
              </text>
            );
            if (selBounds.minX > 0.01) lines.push(<line key="l" x1={0} y1={cy} x2={selBounds.minX} y2={cy} />, label(selBounds.minX / 2, cy - screenUnit * 10, selBounds.minX, 'lt'));
            if (W - selBounds.maxX > 0.01) lines.push(<line key="r" x1={selBounds.maxX} y1={cy} x2={W} y2={cy} />, label((selBounds.maxX + W) / 2, cy - screenUnit * 10, W - selBounds.maxX, 'rt'));
            if (selBounds.minY > 0.01) lines.push(<line key="t" x1={cx} y1={0} x2={cx} y2={selBounds.minY} />, label(cx + screenUnit * 19, selBounds.minY / 2, selBounds.minY, 'tt'));
            if (D - selBounds.maxY > 0.01) lines.push(<line key="b" x1={cx} y1={selBounds.maxY} x2={cx} y2={D} />, label(cx + screenUnit * 19, (selBounds.maxY + D) / 2, D - selBounds.maxY, 'bt'));
            return lines;
          })()}
        </g>
      )}
    </svg>
  );
}
