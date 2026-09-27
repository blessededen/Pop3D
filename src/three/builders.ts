// 공간·집기 3D 모델 생성. 화면 보기, PDF용 이미지, GLB 내보내기가 모두 이 함수를 쓴다.
// 단위 m, Y-up. 평면 (x, y) → 3D (X, Z). 집기는 등록 치수(w×d×h) 안에만 그린다.
import * as THREE from 'three';
import { doorClearRect } from '../domain/geometry';
import { indexItems, placementNumbers } from '../domain/validate';
import type { CatalogItem, LayoutData, Space, Wall } from '../domain/types';

export type Highlight = 'selected' | 'error' | 'warning';

export interface RoomOptions {
  wallOpacity?: number;
  /** 낮게 잘라 보여줄 벽(카메라 쪽 벽) */
  cutaway?: Wall[];
  /** GLB 내보내기용: 보조선·라벨 없이 */
  forExport?: boolean;
}

const WALL_T = 0.1;

function mat(color: string, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extra });
}

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, name = '') {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 1e-3), Math.max(h, 1e-3), Math.max(d, 1e-3)), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (name) mesh.name = name;
  return mesh;
}

function floorRect(x: number, y: number, w: number, d: number, color: string, opacity: number, lift: number, name: string) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(x + w / 2, lift, y + d / 2);
  m.name = name;
  m.renderOrder = 1;
  return m;
}

function outline(x: number, y: number, w: number, d: number, color: string, lift: number) {
  const pts = [
    new THREE.Vector3(x, lift, y),
    new THREE.Vector3(x + w, lift, y),
    new THREE.Vector3(x + w, lift, y + d),
    new THREE.Vector3(x, lift, y + d),
    new THREE.Vector3(x, lift, y),
  ];
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
}

/** 벽 하나를 문 구간을 뺀 조각들로 */
function wallSegments(space: Space, wall: Wall): [number, number][] {
  const len = wall === 'top' || wall === 'bottom' ? space.width : space.depth;
  const cuts = space.doors
    .filter((d) => d.wall === wall)
    .map((d) => [Math.max(0, d.offset), Math.min(len, d.offset + d.width)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const segs: [number, number][] = [];
  let start = -WALL_T;
  for (const [a, b] of cuts) {
    if (a > start) segs.push([start, a]);
    start = Math.max(start, b);
  }
  if (len + WALL_T > start) segs.push([start, len + WALL_T]);
  return segs;
}

export function buildRoom(space: Space, opts: RoomOptions = {}): THREE.Group {
  const { width: W, depth: D, height: H } = space;
  const g = new THREE.Group();
  g.name = 'Space';

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat('#efece6', { roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, 0, D / 2);
  floor.receiveShadow = true;
  floor.name = 'Floor';
  g.add(floor);

  if (!opts.forExport) {
    const pts: THREE.Vector3[] = [];
    for (let x = 0; x <= W + 1e-6; x += 1) pts.push(new THREE.Vector3(x, 0.002, 0), new THREE.Vector3(x, 0.002, D));
    for (let z = 0; z <= D + 1e-6; z += 1) pts.push(new THREE.Vector3(0, 0.002, z), new THREE.Vector3(W, 0.002, z));
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: '#d5d1c8', transparent: true, opacity: 0.8 }),
    );
    grid.name = 'Grid';
    grid.userData.helper = true;
    g.add(grid);
  }

  const opacity = opts.wallOpacity ?? 1;
  const wallMat = mat('#fbfaf8', {
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
    side: THREE.DoubleSide,
  });
  const lowMat = mat('#e4e0d8');
  const walls: Wall[] = ['top', 'bottom', 'left', 'right'];
  for (const wall of walls) {
    const low = opts.cutaway?.includes(wall);
    const h = low ? 0.12 : H;
    wallSegments(space, wall).forEach(([a, b], i) => {
      const len = b - a;
      const mid = (a + b) / 2;
      const name = `Wall_${wall}_${i + 1}`;
      const m = low ? lowMat : wallMat;
      let mesh: THREE.Mesh;
      if (wall === 'top') mesh = box(len, h, WALL_T, m, mid, h / 2, -WALL_T / 2, name);
      else if (wall === 'bottom') mesh = box(len, h, WALL_T, m, mid, h / 2, D + WALL_T / 2, name);
      else if (wall === 'left') mesh = box(WALL_T, h, len, m, -WALL_T / 2, h / 2, mid, name);
      else mesh = box(WALL_T, h, len, m, W + WALL_T / 2, h / 2, mid, name);
      mesh.castShadow = false;
      mesh.userData = { type: 'wall', wall };
      g.add(mesh);
    });
  }

  const colMat = mat('#a3a8ae');
  for (const c of space.columns) {
    const m = box(c.w, H, c.d, colMat, c.x + c.w / 2, H / 2, c.y + c.d / 2, `Column_${c.id}`);
    m.userData = { type: 'column', label: c.label };
    g.add(m);
  }

  const fixMat = mat('#7d8288', { transparent: true, opacity: 0.55 });
  for (const f of space.fixtures) {
    const fh = Math.min(1.2, H);
    const m = box(f.w, fh, f.d, fixMat, f.x + f.w / 2, fh / 2, f.y + f.d / 2, `Fixture_${f.id}`);
    m.userData = { type: 'fixture', label: f.label, heightUnknown: true };
    g.add(m);
  }

  for (const z of space.zones) {
    const m = floorRect(z.x, z.y, z.w, z.d, '#e5484d', 0.28, 0.004, `NoGo_${z.id}`);
    m.userData = { type: 'no_go', label: z.label, reason: z.reason };
    g.add(m);
    if (!opts.forExport) g.add(outline(z.x, z.y, z.w, z.d, '#e5484d', 0.006));
  }

  for (const d of space.doors) {
    const r = doorClearRect(space, d);
    if (r) {
      const m = floorRect(r.x, r.y, r.w, r.d, '#f5a524', 0.22, 0.003, `DoorClear_${d.id}`);
      m.userData = { type: 'door_clearance', label: r.label };
      g.add(m);
    }
    // 문 위치 표시(바닥 띠)
    const t = 0.12;
    const strip =
      d.wall === 'top'
        ? floorRect(d.offset, 0, d.width, t, '#1d1d1f', 0.8, 0.005, `Door_${d.id}`)
        : d.wall === 'bottom'
          ? floorRect(d.offset, D - t, d.width, t, '#1d1d1f', 0.8, 0.005, `Door_${d.id}`)
          : d.wall === 'left'
            ? floorRect(0, d.offset, t, d.width, '#1d1d1f', 0.8, 0.005, `Door_${d.id}`)
            : floorRect(W - t, d.offset, t, d.width, '#1d1d1f', 0.8, 0.005, `Door_${d.id}`);
    strip.userData = { type: 'door', label: d.label };
    g.add(strip);
  }

  const pwMat = mat('#f2c230');
  for (const p of space.powerPoints) {
    const m = box(0.1, 0.08, 0.1, pwMat, Math.min(Math.max(p.x, 0.05), W - 0.05), 0.3, Math.min(Math.max(p.y, 0.05), D - 0.05), `Power_${p.id}`);
    m.userData = { type: 'power', label: p.label };
    g.add(m);
  }
  return g;
}

const GARMENTS = ['#2e3a59', '#c9b79c', '#8b3a3a', '#dfe3e8', '#4f6d5a', '#e8d8c4', '#1d1d1f', '#b5651d'];

export function buildItem(it: CatalogItem): THREE.Group {
  const { w, d, h } = it;
  const g = new THREE.Group();
  const color = it.color || '#b9bcc2';
  switch (it.category) {
    case 'hanger': {
      const metal = mat('#5f656d', { metalness: 0.6, roughness: 0.35 });
      const px = w / 2 - 0.03;
      for (const sx of [-1, 1]) {
        g.add(box(0.035, h, 0.035, metal, sx * px, h / 2, 0));
        g.add(box(0.045, 0.03, d, metal, sx * px, 0.015, 0));
      }
      g.add(box(w - 0.02, 0.03, 0.03, metal, 0, h - 0.015, 0));
      const n = Math.max(3, Math.floor((w - 0.14) / 0.085));
      for (let i = 0; i < n; i++) {
        const len = 0.72 + ((i * 37) % 5) * 0.05;
        const x = -px + 0.07 + ((2 * px - 0.14) * i) / Math.max(1, n - 1);
        g.add(box(0.04, len, d * 0.82, mat(GARMENTS[i % GARMENTS.length], { roughness: 0.9 }), x, h - 0.07 - len / 2, 0));
      }
      break;
    }
    case 'counter': {
      g.add(box(w - 0.04, 0.08, d - 0.08, mat('#4a4d52'), 0, 0.04, 0));
      g.add(box(w - 0.02, h - 0.12, d - 0.04, mat(color), 0, 0.08 + (h - 0.12) / 2, 0));
      g.add(box(w, 0.04, d, mat('#cbb592', { roughness: 0.6 }), 0, h - 0.02, 0));
      break;
    }
    case 'photozone': {
      g.add(box(w, 0.05, d, mat('#e2ded6'), 0, 0.025, 0));
      g.add(box(w, h - 0.05, 0.06, mat(color, { roughness: 0.55 }), 0, 0.05 + (h - 0.05) / 2, -d / 2 + 0.03));
      const r = Math.min(w, h) * 0.26;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 12, 48), mat('#ffffff', { roughness: 0.3 }));
      ring.position.set(0, 0.05 + (h - 0.05) * 0.55, -d / 2 + 0.1);
      ring.castShadow = true;
      g.add(ring);
      break;
    }
    case 'table': {
      g.add(box(w, 0.04, d, mat(color, { roughness: 0.6 }), 0, h - 0.02, 0));
      const leg = mat('#2f3134');
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.045, h - 0.04, 0.045, leg, sx * (w / 2 - 0.06), (h - 0.04) / 2, sz * (d / 2 - 0.06)));
      break;
    }
    case 'shelf': {
      const wood = mat(color, { roughness: 0.65 });
      for (const sx of [-1, 1]) g.add(box(0.03, h, d, wood, sx * (w / 2 - 0.015), h / 2, 0));
      g.add(box(w, h, 0.02, mat('#e9e2d6'), 0, h / 2, -d / 2 + 0.01));
      const levels = Math.max(3, Math.round(h / 0.4));
      for (let i = 0; i < levels; i++) g.add(box(w - 0.06, 0.025, d - 0.02, wood, 0, 0.06 + ((h - 0.1) * i) / (levels - 1), 0.01));
      break;
    }
    case 'mirror': {
      g.add(box(w * 0.85, 0.05, d, mat('#3a3d42'), 0, 0.025, 0));
      g.add(box(w, h - 0.05, 0.05, mat('#2f3134'), 0, 0.05 + (h - 0.05) / 2, 0));
      g.add(box(w - 0.07, h - 0.17, 0.01, mat(color || '#dfe7ea', { metalness: 1, roughness: 0.04 }), 0, 0.05 + (h - 0.05) / 2, 0.03));
      break;
    }
    case 'display': {
      const m = mat(color || '#f2f2f2', { roughness: 0.5 });
      const cw = w / 2 - 0.02;
      const cd = d / 2 - 0.02;
      const spots: [number, number, number][] = [
        [-w / 4, -d / 4, h],
        [w / 4, -d / 4, h * 0.66],
        [0, d / 4, h * 0.33],
      ];
      for (const [x, z, hh] of spots) g.add(box(cw, hh, cd, m, x, hh / 2, z));
      break;
    }
    case 'light': {
      const dark = mat('#2a2c30', { metalness: 0.4, roughness: 0.4 });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) * 0.3, Math.min(w, d) * 0.3, 0.03, 24), dark);
      base.position.y = 0.015;
      g.add(base);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, h - 0.2, 12), dark);
      pole.position.y = 0.03 + (h - 0.2) / 2;
      g.add(pole);
      const head = new THREE.Mesh(new THREE.ConeGeometry(Math.min(w, d) * 0.28, 0.18, 24, 1, true), dark);
      head.position.y = h - 0.09;
      head.rotation.x = Math.PI;
      g.add(head);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshStandardMaterial({ color: '#fff4cf', emissive: '#ffd98a', emissiveIntensity: 1.5 }));
      bulb.position.y = h - 0.14;
      g.add(bulb);
      break;
    }
    default:
      g.add(box(w, h, d, mat(color), 0, h / 2, 0));
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

export const HIGHLIGHT_COLOR: Record<Highlight, string> = {
  selected: '#2f6bff',
  error: '#e5484d',
  warning: '#f5a524',
};

export interface LayoutOptions extends RoomOptions {
  highlight?: Map<string, Highlight>;
}

export function buildLayout(data: LayoutData, opts: LayoutOptions = {}) {
  const root = new THREE.Group();
  root.name = data.projectName || 'Layout';
  root.add(buildRoom(data.space, opts));
  const items = indexItems(data.vendor.items);
  const nums = placementNumbers(data.placements);
  const itemGroups = new Map<string, THREE.Group>();
  const furniture = new THREE.Group();
  furniture.name = 'Furniture';
  for (const p of data.placements) {
    const it = items.get(p.sku);
    if (!it) continue;
    const g = buildItem(it);
    const no = nums.get(p.id)!;
    g.name = `${String(no).padStart(2, '0')}_${p.sku}`;
    g.position.set(p.x, 0, p.y);
    g.rotation.y = (-p.rot * Math.PI) / 180;
    g.userData = { placementId: p.id, sku: p.sku, no, name: it.name, noOrder: p.noOrder };
    const hl = opts.highlight?.get(p.id);
    if (hl && !opts.forExport) {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(it.w + 0.02, it.h + 0.02, it.d + 0.02)),
        new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR[hl] }),
      );
      edges.position.y = it.h / 2;
      edges.userData.helper = true;
      g.add(edges);
    }
    furniture.add(g);
    itemGroups.set(p.id, g);
  }
  root.add(furniture);
  return { root, itemGroups };
}

export function disposeObject(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const x of mats) x.dispose();
  });
}

export function buildLights(space: Space): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Lights';
  g.add(new THREE.HemisphereLight('#ffffff', '#d8d2c6', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 2.2);
  const cx = space.width / 2;
  const cz = space.depth / 2;
  sun.position.set(cx + space.width * 0.6, space.height * 4, cz + space.depth * 0.8);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  const ext = Math.max(space.width, space.depth) * 0.8;
  sun.shadow.camera.left = -ext;
  sun.shadow.camera.right = ext;
  sun.shadow.camera.top = ext;
  sun.shadow.camera.bottom = -ext;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  g.add(sun, sun.target);
  return g;
}
