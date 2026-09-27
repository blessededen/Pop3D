// GLB 내보내기(도면 치수로 만든 빈 매장 / 배치 포함)와 참고용 GLB 불러오기.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LayoutData, RefModelMeta, Space } from '../domain/types';
import { buildLayout, buildRoom, disposeObject } from './builders';

function stripHelpers(o: THREE.Object3D) {
  const helpers: THREE.Object3D[] = [];
  o.traverse((c) => {
    if (c.userData?.helper) helpers.push(c);
  });
  for (const h of helpers) h.parent?.remove(h);
}

function spaceMeta(space: Space) {
  return {
    generator: 'Pop-3D',
    units: 'meter',
    upAxis: '+Y',
    origin: '평면도 왼쪽 위 모서리 = (0, 0, 0). +X = 오른쪽, +Z = 평면도 아래쪽(출입구 쪽)',
    space: {
      name: space.name,
      isVirtual: space.isVirtual,
      width: space.width,
      depth: space.depth,
      height: space.height,
      scaleConfirmed: space.status.scaleConfirmed,
      fieldMeasured: space.status.fieldMeasured,
      source: space.status.source,
      drawingDate: space.status.drawingDate,
    },
    note: '벽·기둥·출입구·금지 구역은 등록된 치수로 만든 단순 모델이다. 현장 실측을 대신하지 않는다.',
  };
}

async function toGlb(root: THREE.Object3D): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  const out = await exporter.parseAsync(root, { binary: true, onlyVisible: true });
  return out as ArrayBuffer;
}

/** 경로 A: 등록 치수로 바닥·벽·기둥·출입구만 있는 빈 매장 GLB */
export async function exportSpaceGlb(space: Space): Promise<Blob> {
  const scene = new THREE.Scene();
  const room = buildRoom(space, { forExport: true, wallOpacity: 1 });
  stripHelpers(room);
  scene.add(room);
  scene.userData = spaceMeta(space);
  try {
    return new Blob([await toGlb(scene)], { type: 'model/gltf-binary' });
  } finally {
    disposeObject(scene);
  }
}

/** 확정 버전의 배치까지 포함한 GLB. 집기 노드 이름 = 번호_상품번호, extras에 상품 정보 */
export async function exportLayoutGlb(data: LayoutData, version: number): Promise<Blob> {
  const scene = new THREE.Scene();
  const { root } = buildLayout(data, { forExport: true, wallOpacity: 1 });
  stripHelpers(root);
  scene.add(root);
  scene.userData = { ...spaceMeta(data.space), project: data.projectName, version };
  try {
    return new Blob([await toGlb(scene)], { type: 'model/gltf-binary' });
  } finally {
    disposeObject(scene);
  }
}

export interface LoadedRef {
  object: THREE.Object3D;
  /** 원본 바운딩 박스 크기(m) */
  size: { w: number; d: number; h: number };
}

/** 참고용 GLB 로드. 원점 정렬은 applyRefTransform에서 한다. */
export async function loadRefGlb(buffer: ArrayBuffer): Promise<LoadedRef> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buffer, '');
  const object = gltf.scene;
  const box = new THREE.Box3().setFromObject(object);
  const s = box.getSize(new THREE.Vector3());
  return { object, size: { w: s.x, d: s.z, h: s.y } };
}

/** 회전·배율을 적용한 뒤 바운딩 박스 최소점을 (offsetX, 0, offsetZ)에 맞춘다 */
export function applyRefTransform(inner: THREE.Object3D, meta: RefModelMeta): THREE.Group {
  const holder = new THREE.Group();
  holder.name = 'ReferenceScan';
  const pivot = new THREE.Group();
  pivot.add(inner);
  pivot.rotation.y = (-meta.rotY * Math.PI) / 180;
  pivot.scale.setScalar(meta.scale);
  holder.add(pivot);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pivot);
  pivot.position.set(meta.offsetX - box.min.x, -box.min.y, meta.offsetZ - box.min.z);
  return holder;
}
