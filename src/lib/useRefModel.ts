import { useEffect, useMemo, useState } from 'react';
import type { RefModelMeta, Space } from '../domain/types';
import { getBlob } from './browser';

/** 공간에 연결된 참고 스캔 GLB를 IndexedDB에서 읽어 온다. */
export function useRefModel(space: Space, enabled = true): { buffer: ArrayBuffer; meta: RefModelMeta } | null {
  const [buf, setBuf] = useState<ArrayBuffer | null>(null);
  const key = space.refModel ? `${space.id}:${space.refModel.fileName}` : '';
  useEffect(() => {
    let alive = true;
    setBuf(null);
    if (!key) return;
    getBlob(`ref:${space.id}`).then(async (b) => {
      if (alive && b) setBuf(await b.arrayBuffer());
    });
    return () => {
      alive = false;
    };
  }, [key, space.id]);
  return useMemo(() => (enabled && buf && space.refModel ? { buffer: buf, meta: space.refModel } : null), [enabled, buf, space.refModel]);
}
