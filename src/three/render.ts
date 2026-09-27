// 확정 버전 데이터로 3D 참고 이미지를 따로 렌더링한다(화면의 수정본과 섞이지 않게).
import * as THREE from 'three';
import { indexItems, placementNumbers } from '../domain/validate';
import type { LayoutData } from '../domain/types';
import { buildLayout, buildLights, disposeObject } from './builders';

export interface RenderedImage {
  dataUrl: string;
  width: number;
  height: number;
}

export function cameraFor(data: LayoutData, aspect: number, fov = 35, fit = 0.95) {
  const { width: W, depth: D, height: H } = data.space;
  const center = new THREE.Vector3(W / 2, H * 0.25, D / 2);
  const radius = Math.hypot(W, D, H) / 2;
  const vHalf = ((fov / 2) * Math.PI) / 180;
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  // 바운딩 구가 세로·가로 시야 모두에 들어가는 거리. 구는 넉넉한 근사라 조금 당긴다.
  const dist = (radius / Math.sin(Math.min(vHalf, hHalf))) * fit;
  const dir = new THREE.Vector3(0.55, 0.95, 1.0).normalize();
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.05, 500);
  cam.position.copy(center).addScaledVector(dir, dist);
  cam.lookAt(center);
  return { cam, center };
}

export function renderLayoutImage(data: LayoutData, width = 1600, height = 1000): RenderedImage | null {
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  try {
    const canvas = document.createElement('canvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene.background = new THREE.Color('#ffffff');
    scene.add(buildLights(data.space));
    const { root } = buildLayout(data, { cutaway: ['bottom', 'right'], wallOpacity: 1 });
    scene.add(root);
    const { cam } = cameraFor(data, width / height, 35, 0.74);
    renderer.render(scene, cam);

    // 번호 라벨을 2D로 덧그린다
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0);
    const items = indexItems(data.vendor.items);
    const nums = placementNumbers(data.placements);
    for (const p of data.placements) {
      const it = items.get(p.sku);
      if (!it) continue;
      const v = new THREE.Vector3(p.x, it.h + 0.25, p.y).project(cam);
      const sx = ((v.x + 1) / 2) * width;
      const sy = ((1 - v.y) / 2) * height;
      const r = Math.round(width / 70);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = p.noOrder ? '#8a8f98' : '#1d1d1f';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(r * 1.05)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(nums.get(p.id)), sx, sy + 1);
    }
    return { dataUrl: out.toDataURL('image/png'), width, height };
  } catch {
    return null;
  } finally {
    disposeObject(scene);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
