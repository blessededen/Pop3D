import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LayoutData } from '../domain/types';
import type { Issue } from '../domain/validate';
import { DEMO_SPACE_DURATION_MS, demoDragControl, demoSpaceFrame, type DemoPoint, type DemoSpaceSources } from '../domain/demoSpaceAnimation';
import PlanView from './PlanView';
import './AutoDemoSpaceAnimation.css';

interface Props { data: LayoutData; active: boolean; paused?: boolean; elapsedMs?: number }
interface Geometry {
  width: number; height: number;
  a: number; b: number; c: number; d: number; e: number; f: number;
  sources: DemoSpaceSources;
}
const NO_ISSUES: Issue[] = [];
const FALLBACK_SOURCES: DemoSpaceSources = { column: { x: 0, y: 0 }, power: { x: 0, y: 0 } };
const pixel = (point: DemoPoint, geometry: Geometry): DemoPoint => ({
  x: geometry.a * point.x + geometry.c * point.y + geometry.e,
  y: geometry.b * point.x + geometry.d * point.y + geometry.f,
});

function PowerSymbol({ x = 0, y = 0, size = 18 }: { x?: number; y?: number; size?: number }) {
  return <svg x={x - size / 2} y={y - size / 2} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 5 13h6l-1 9 9-12h-6l.5-8Z" fill="currentColor" stroke="currentColor" strokeWidth=".8" strokeLinejoin="round" /></svg>;
}

export default function AutoDemoSpaceAnimation({ data, active, paused = false, elapsedMs }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const columnChip = useRef<HTMLDivElement>(null);
  const powerChip = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  useEffect(() => { elapsedRef.current = 0; setElapsed(0); }, [active, data.space.id]);
  useEffect(() => {
    if (!active || paused || reducedMotion || elapsedMs !== undefined) return;
    let request = 0, previous = performance.now();
    const tick = (now: number) => {
      elapsedRef.current = Math.min(DEMO_SPACE_DURATION_MS, elapsedRef.current + now - previous);
      previous = now;
      setElapsed(elapsedRef.current);
      if (elapsedRef.current < DEMO_SPACE_DURATION_MS) request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [active, data.space.id, paused, reducedMotion, elapsedMs]);

  useLayoutEffect(() => {
    const container = host.current, column = columnChip.current, power = powerChip.current;
    const plan = container?.querySelector<SVGSVGElement>('.plan-svg');
    if (!container || !plan || !column || !power) return;
    const measure = () => {
      const matrix = plan.getScreenCTM(), rect = container.getBoundingClientRect();
      if (!matrix || !rect.width || !rect.height || Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-8) return;
      const source = (element: HTMLElement): DemoPoint => {
        const bounds = element.getBoundingClientRect();
        const point = new DOMPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2).matrixTransform(matrix.inverse());
        return { x: point.x, y: point.y };
      };
      setGeometry({ width: rect.width, height: rect.height, a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d,
        e: matrix.e - rect.left, f: matrix.f - rect.top, sources: { column: source(column), power: source(power) } });
    };
    measure();
    const observer = new ResizeObserver(measure);
    [container, plan, column, power].forEach(element => observer.observe(element));
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [data.space.id, data.space.width, data.space.depth]);

  const frame = demoSpaceFrame(data.space, active ? elapsedMs ?? elapsed : 0, geometry?.sources ?? FALLBACK_SOURCES, reducedMotion);
  const visibleData = useMemo<LayoutData>(() => ({ ...data, space: { ...data.space,
    columns: data.space.columns.slice(0, frame.columnCount), powerPoints: data.space.powerPoints.slice(0, frame.powerCount),
  } }), [data, frame.columnCount, frame.powerCount]);
  const plan = useMemo(() => <PlanView data={visibleData} issues={NO_ISSUES} selectedId={null} editable={false} showItems={false} />, [visibleData]);
  const operation = frame.operation;
  const cursor = geometry && frame.cursor ? pixel(frame.cursor, geometry) : null;
  const destination = geometry && operation ? pixel(operation.destination, geometry) : null;
  const source = geometry && frame.source ? pixel(frame.source, geometry) : null;
  const control = geometry && frame.source && operation ? pixel(demoDragControl(frame.source, operation.destination), geometry) : null;
  const drawing = active && !paused && !reducedMotion && geometry && cursor && operation;
  const dragging = frame.phase === 'drag';
  const dropping = frame.phase === 'drop';
  const pressing = frame.phase === 'press';
  const columnWidth = geometry && operation?.width ? operation.width * Math.hypot(geometry.a, geometry.b) : 0;
  const columnDepth = geometry && operation?.depth ? operation.depth * Math.hypot(geometry.c, geometry.d) : 0;
  const action = frame.phase === 'complete' ? '공간 조건 배치 완료' : dropping ? '위치에 놓기' : dragging ? '끌어서 배치' : pressing ? '눌러서 선택' : '배치할 항목 선택';

  return <div ref={host} className="auto-demo-space-animation" data-active={active}>
    {plan}
    <div className="auto-demo-space-palette" aria-label="시연에 사용하는 공간 요소">
      <span className="auto-demo-space-palette-label">공간 요소</span>
      <div ref={columnChip} className="auto-demo-space-chip" data-selected={active && operation?.kind === 'column' && (pressing || dragging)}>
        <span className="auto-demo-space-column-icon" aria-hidden="true" /><span>기둥</span><small>{frame.columnCount}/{data.space.columns.length}</small>
      </div>
      <div ref={powerChip} className="auto-demo-space-chip" data-selected={active && operation?.kind === 'power' && (pressing || dragging)}>
        <svg width="16" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2 5 13h6l-1 9 9-12h-6l.5-8Z" fill="currentColor" /></svg><span>전원</span><small>{frame.powerCount}/{data.space.powerPoints.length}</small>
      </div>
      <span className="auto-demo-space-palette-hint">선택 → 드래그</span>
    </div>
    {drawing && <svg className="auto-demo-space-overlay" viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none" aria-hidden="true">
      {dragging && source && control && destination && <>
        <path className="auto-demo-space-path" d={`M ${source.x} ${source.y} Q ${control.x} ${control.y} ${destination.x} ${destination.y}`} />
        <path className="auto-demo-space-target" d={`M ${destination.x - 9} ${destination.y - 4} v -5 h 5 M ${destination.x + 4} ${destination.y - 9} h 5 v 5 M ${destination.x + 9} ${destination.y + 4} v 5 h -5 M ${destination.x - 4} ${destination.y + 9} h -5 v -5`} />
      </>}
      {dragging && (operation.kind === 'column'
        ? <rect className="auto-demo-space-ghost-column" x={cursor.x - columnWidth / 2} y={cursor.y - columnDepth / 2} width={columnWidth} height={columnDepth} rx="1" />
        : <g className="auto-demo-space-ghost-power"><PowerSymbol x={cursor.x} y={cursor.y} size={22} /></g>)}
      {(pressing || dropping) && <circle className="auto-demo-space-drop-ring" cx={cursor.x} cy={cursor.y} r={pressing ? 5 + frame.phaseProgress * 8 : 9 + frame.phaseProgress * 19} opacity={1 - frame.phaseProgress * 0.85} />}
      <g className="auto-demo-space-cursor" transform={`translate(${cursor.x - 2} ${cursor.y - 2}) scale(${pressing ? 1 - Math.sin(frame.phaseProgress * Math.PI) * 0.12 : 1})`}>
        <path d="M 1 1 L 1 23 L 6.7 17 L 11.3 27 L 15.3 25 L 10.7 15.7 L 19 15 Z" />
      </g>
    </svg>}
    {active && <div className="auto-demo-space-action" role="status" aria-live="polite" aria-atomic="true">
      <span className="auto-demo-space-action-dot" aria-hidden="true" />
      <div><strong>{action}</strong><span>{frame.phase === 'complete' ? `기둥 ${frame.columnCount}개 · 전원 ${frame.powerCount}곳` : operation?.label}</span></div>
    </div>}
  </div>;
}
