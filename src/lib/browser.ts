// 브라우저 저장소·파일 유틸. 저장소 접근이 막힌 환경(시크릿 창, 인앱 브라우저 제한)에서도 앱이 죽지 않게 감싼다.

export function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 무시
  }
}

// ---- IndexedDB: 공간 참고 GLB 원본 보관 -----------------------------------
const DB = 'pop3d';
const STORE = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getBlob(key: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    const out = await new Promise<Blob | null>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return out;
  } catch {
    return null;
  }
}

export async function deleteBlob(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // 무시
  }
}

// ---- 파일 내려받기·공유 ---------------------------------------------------
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function canShareFiles(): boolean {
  try {
    const probe = new File(['x'], 'x.pdf', { type: 'application/pdf' });
    return typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [probe] });
  } catch {
    return false;
  }
}

/** 모바일 공유 시트(카카오톡 등 설치된 앱 선택)로 파일 공유. 지원하지 않으면 false */
export async function shareFile(blob: Blob, fileName: string, title: string): Promise<boolean> {
  const file = new File([blob], fileName, { type: blob.type });
  if (!canShareFiles() || !navigator.canShare?.({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return true;
    return false;
  }
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}

export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 80);
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
