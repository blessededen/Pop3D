import { useEffect, useState, type RefObject } from 'react';
import type { Space } from '../domain/types';
import { DEMO_SPACE_DURATION_MS, demoDragControl, demoSpaceFrame, type DemoPoint, type DemoSpaceSources } from '../domain/demoSpaceAnimation';
import './InlineSpaceDemoOverlay.css';

export interface InlineSpaceDemo { targetSpace: Space; elapsedMs: number; active: boolean }
interface Props extends InlineSpaceDemo {
  shellRef: RefObject<HTMLDivElement | null>;
  svgRef: RefObject<SVGSVGElement | null>;
}
interface Geometry {
  width: number; height: number; matrix: DOMMatrix; sources: DemoSpaceSources;
}
const pointAt = (point: DemoPoint, geometry: Geometry) => new DOMPoint(point.x, point.y).matrixTransform(geometry.matrix);

/** A pointer illustration over the real editor; it never changes the saved space. */
export default function InlineSpaceDemoOverlay({ targetSpace, elapsedMs, active, shellRef, svgRef }: Props) {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [clock, setClock] = useState(elapsedMs);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!active || reduced) return;
    const start = performance.now();
    let request = 0;
    const tick = (now: number) => {
      const next = Math.min(DEMO_SPACE_DURATION_MS, elapsedMs + now - start);
      setClock(next);
      if (next < DEMO_SPACE_DURATION_MS) request = requestAnimationFrame(tick);
    };
    setClock(elapsedMs);
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [elapsedMs, active, reduced]);
  // The shell belongs to our parent: its ref may still be null during a child's
  // layout effect. Passive effects run after the entire tree has attached refs.
  useEffect(() => {
    const shell = shellRef.current, svg = svgRef.current;
    const column = shell?.querySelector<HTMLElement>('[data-space-tool="columns"]');
    const power = shell?.querySelector<HTMLElement>('[data-space-tool="powerPoints"]');
    if (!shell || !svg || !column || !power) return;
    const measure = () => {
      const screen = svg.getScreenCTM(), bounds = shell.getBoundingClientRect();
      if (!screen || !bounds.width || !bounds.height || Math.abs(screen.a * screen.d - screen.b * screen.c) < 1e-8) return;
      const source = (element: HTMLElement): DemoPoint => {
        const rect = element.getBoundingClientRect();
        const point = new DOMPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).matrixTransform(screen.inverse());
        return { x: point.x, y: point.y };
      };
      setGeometry({ width: bounds.width, height: bounds.height,
        matrix: new DOMMatrix([screen.a, screen.b, screen.c, screen.d, screen.e - bounds.left, screen.f - bounds.top]),
        sources: { column: source(column), power: source(power) } });
    };
    measure();
    const observer = new ResizeObserver(measure);
    [shell, svg, column, power].forEach(element => observer.observe(element));
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [shellRef, svgRef, targetSpace.id, targetSpace.width, targetSpace.depth, active]);
  if (!active || reduced || !geometry) return null;
  const frame = demoSpaceFrame(targetSpace, clock, geometry.sources);
  if (!frame.cursor || !frame.operation || !frame.source) return null;
  const cursor = pointAt(frame.cursor, geometry), source = pointAt(frame.source, geometry);
  const destination = pointAt(frame.operation.destination, geometry);
  const control = pointAt(demoDragControl(frame.source, frame.operation.destination), geometry);
  const pressing = frame.phase === 'press', dropping = frame.phase === 'drop', dragging = frame.phase === 'drag';
  const width = (frame.operation.width ?? 0) * Math.hypot(geometry.matrix.a, geometry.matrix.b);
  const depth = (frame.operation.depth ?? 0) * Math.hypot(geometry.matrix.c, geometry.matrix.d);
  return <svg className="inline-space-demo-overlay" viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none" aria-hidden="true">
    {dragging && <>
      <path className="inline-space-demo-path" d={`M ${source.x} ${source.y} Q ${control.x} ${control.y} ${destination.x} ${destination.y}`} />
      <path className="inline-space-demo-target" d={`M ${destination.x - 9} ${destination.y - 4} v -5 h 5 M ${destination.x + 4} ${destination.y - 9} h 5 v 5 M ${destination.x + 9} ${destination.y + 4} v 5 h -5 M ${destination.x - 4} ${destination.y + 9} h -5 v -5`} />
      {frame.operation.kind === 'column' ? <rect className="inline-space-demo-column" x={cursor.x - width / 2} y={cursor.y - depth / 2} width={width} height={depth} rx="1" /> : <g className="inline-space-demo-power" transform={`translate(${cursor.x - 11} ${cursor.y - 11})`}><path d="M13.5 2 5 13h6l-1 9 9-12h-6l.5-8Z" /></g>}
    </>}
    {(pressing || dropping) && <circle className="inline-space-demo-ring" cx={cursor.x} cy={cursor.y} r={pressing ? 5 + frame.phaseProgress * 8 : 9 + frame.phaseProgress * 19} opacity={1 - frame.phaseProgress * .85} />}
    <g className="inline-space-demo-cursor" transform={`translate(${cursor.x - 2} ${cursor.y - 2}) scale(${pressing ? 1 - Math.sin(frame.phaseProgress * Math.PI) * .12 : 1})`}><path d="M 1 1 L 1 23 L 6.7 17 L 11.3 27 L 15.3 25 L 10.7 15.7 L 19 15 Z" /></g>
  </svg>;
}
