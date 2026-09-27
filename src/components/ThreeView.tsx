import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { indexItems } from '../domain/validate';
import type { LayoutData, RefModelMeta, Wall } from '../domain/types';
import { buildLayout, buildLights, disposeObject, type Highlight } from '../three/builders';
import { applyRefTransform, loadRefGlb } from '../three/glb';
import { cameraFor } from '../three/render';

interface Props {
  data: LayoutData;
  highlight: Map<string, Highlight>;
  onSelect?: (id: string | null) => void;
  refModel?: { buffer: ArrayBuffer; meta: RefModelMeta } | null;
  compact?: boolean;
}

type WallMode = 'cut' | 'glass' | 'full';
type Preset = 'iso' | 'top' | 'front';

interface Ctx {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group | null;
  lights: THREE.Group | null;
  itemGroups: Map<string, THREE.Group>;
  refHolder: THREE.Group | null;
  refInner: THREE.Object3D | null;
}

const WALLS: Record<WallMode, { cutaway?: Wall[]; wallOpacity: number }> = {
  cut: { cutaway: ['bottom', 'right'], wallOpacity: 1 },
  glass: { wallOpacity: 0.28 },
  full: { wallOpacity: 1 },
};

export default function ThreeView({ data, highlight, onSelect, refModel, compact = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<Ctx | null>(null);
  const [wallMode, setWallMode] = useState<WallMode>('cut');
  const [failed, setFailed] = useState(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const dataRef = useRef(data);
  dataRef.current = data;

  // 초기화
  useEffect(() => {
    const host = hostRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    host.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#14181f');
    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 500);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;
    controls.minDistance = 1;
    controls.maxDistance = 80;

    ctx.current = { renderer, labels, scene, camera, controls, content: null, lights: null, itemGroups: new Map(), refHolder: null, refInner: null };

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
    });

    let down: { x: number; y: number } | null = null;
    const ray = new THREE.Raycaster();
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const c = ctx.current;
      if (!c?.content) return;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hits = ray.intersectObjects([...c.itemGroups.values()], true);
      let o: THREE.Object3D | null = hits[0]?.object ?? null;
      while (o && !o.userData.placementId) o = o.parent;
      onSelectRef.current?.(o ? (o.userData.placementId as string) : null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    return () => {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
      ctx.current = null;
    };
  }, []);

  const items = useMemo(() => indexItems(data.vendor.items), [data.vendor.items]);
  const structureKey = useMemo(
    () =>
      JSON.stringify([
        data.space,
        data.placements.map((p) => [p.id, p.sku, p.noOrder, items.get(p.sku) ?? null]),
        [...highlight.entries()],
        wallMode,
      ]),
    [data.space, data.placements, items, highlight, wallMode],
  );

  // 공간·집기 구성이 바뀌면 다시 만든다
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    if (c.content) {
      // 부모 그룹째 빼면 CSS2D 라벨 DOM이 남으므로 직접 지운다
      c.content.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
      c.scene.remove(c.content);
      disposeObject(c.content);
    }
    if (c.lights) c.scene.remove(c.lights);
    const d = dataRef.current;
    c.lights = buildLights(d.space);
    c.scene.add(c.lights);
    const { root, itemGroups } = buildLayout(d, { ...WALLS[wallMode], highlight });
    for (const [id, g] of itemGroups) {
      const it = items.get(g.userData.sku as string);
      const el = document.createElement('div');
      const hl = highlight.get(id);
      el.className = `tag3d ${hl ?? ''} ${g.userData.noOrder ? 'noorder' : ''}`;
      el.textContent = String(g.userData.no);
      const tag = new CSS2DObject(el);
      tag.position.set(0, (it?.h ?? 1) + 0.22, 0);
      g.add(tag);
    }
    c.content = root;
    c.itemGroups = itemGroups;
    c.scene.add(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // 위치·회전만 바뀐 경우(드래그 중)는 변환만 갱신
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    for (const p of data.placements) {
      const g = c.itemGroups.get(p.id);
      if (!g) continue;
      g.position.set(p.x, 0, p.y);
      g.rotation.y = (-p.rot * Math.PI) / 180;
    }
  }, [data.placements]);

  const applyPreset = (preset: Preset) => {
    const c = ctx.current;
    if (!c) return;
    const { width: W, depth: D } = dataRef.current.space;
    if (preset === 'iso') {
      const { cam, center } = cameraFor(dataRef.current, c.camera.aspect, c.camera.fov);
      c.camera.position.copy(cam.position);
      c.controls.target.copy(center);
    } else if (preset === 'top') {
      c.camera.position.set(W / 2, Math.max(W, D) * 1.7, D / 2 + 0.01);
      c.controls.target.set(W / 2, 0, D / 2);
    } else {
      c.camera.position.set(W / 2, 1.7, D + Math.max(2.5, D * 0.35));
      c.controls.target.set(W / 2, 1.0, D * 0.45);
    }
    c.controls.update();
  };

  // 공간 크기가 바뀌면 카메라를 다시 맞춘다
  const spaceKey = `${data.space.id}:${data.space.width}x${data.space.depth}x${data.space.height}`;
  useEffect(() => {
    applyPreset('iso');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceKey]);

  // 참고 스캔 GLB
  const loadedRef = useRef<{ buffer: ArrayBuffer; inner: THREE.Object3D } | null>(null);
  const [refError, setRefError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const c = ctx.current;
    if (!c) return;
    const detach = () => {
      if (c.refHolder) c.scene.remove(c.refHolder);
      c.refHolder = null;
    };
    if (!refModel) {
      detach();
      return;
    }
    const place = (inner: THREE.Object3D) => {
      detach();
      inner.parent?.remove(inner);
      const holder = applyRefTransform(inner, refModel.meta);
      holder.visible = refModel.meta.visible;
      c.refHolder = holder;
      c.scene.add(holder);
    };
    if (loadedRef.current?.buffer === refModel.buffer) {
      place(loadedRef.current.inner);
    } else {
      loadRefGlb(refModel.buffer.slice(0))
        .then((r) => {
          if (cancelled) return;
          loadedRef.current = { buffer: refModel.buffer, inner: r.object };
          setRefError('');
          place(r.object);
        })
        .catch((e) => !cancelled && setRefError(`참고 GLB를 열지 못했습니다: ${(e as Error).message}`));
    }
    return () => {
      cancelled = true;
    };
  }, [refModel]);

  return (
    <div className="viewbox" style={{ minHeight: 420 }}>
      <div ref={hostRef} className="three-host" />
      <div className="corner">
        {compact ? <select className="input sm" aria-label="3D 시점" defaultValue="iso" onChange={event => applyPreset(event.target.value as Preset)}><option value="iso">사선 시점</option><option value="top">위에서 보기</option><option value="front">입구에서 보기</option></select> :
        <div className="seg" role="group" aria-label="카메라">
          <button onClick={() => applyPreset('iso')}>사선</button>
          <button onClick={() => applyPreset('top')}>위</button>
          <button onClick={() => applyPreset('front')}>입구</button>
        </div>}
      </div>
      <div className="corner corner-r">
        {compact ? <select className="input sm" aria-label="3D 벽 표시" value={wallMode} onChange={event => setWallMode(event.target.value as WallMode)}><option value="cut">벽 잘라보기</option><option value="glass">반투명 벽</option><option value="full">전체 벽</option></select> :
        <div className="seg" role="group" aria-label="벽 표시">
          {(
            [
              ['cut', '벽 잘라보기'],
              ['glass', '반투명'],
              ['full', '전체'],
            ] as [WallMode, string][]
          ).map(([k, l]) => (
            <button key={k} className={wallMode === k ? 'on' : ''} onClick={() => setWallMode(k)}>
              {l}
            </button>
          ))}
        </div>}
      </div>
      {failed && (
        <div className="note warn" style={{ position: 'absolute', inset: 'auto 12px 12px 12px' }}>
          이 브라우저에서 3D(WebGL)를 켤 수 없습니다. 평면도와 PDF는 그대로 쓸 수 있습니다.
        </div>
      )}
      {refError && (
        <div className="note error" style={{ position: 'absolute', inset: 'auto 12px 12px 12px' }}>
          {refError}
        </div>
      )}
    </div>
  );
}
