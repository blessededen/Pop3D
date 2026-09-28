import { isUsableReportUrl, type KakaoReportReceipt } from './kakaoReport';

export type DemoStage = 'brief' | 'space' | 'fixtures' | 'layout' | 'three' | 'review' | 'pdf' | 'send' | 'done';
export const DEMO_STAGES: DemoStage[] = ['brief', 'space', 'fixtures', 'layout', 'three', 'review', 'pdf', 'send', 'done'];
export interface DemoSession {
  id: string;
  createdAt: number;
  owner: string | null;
  previousProjectId: string;
  projectId?: string;
  phase: 'setup' | 'authorizing' | 'running' | 'sending' | 'done' | 'stopped';
  receipt?: KakaoReportReceipt;
}
const KEY = 'pop3d:auto-demo:v1';
const MAX_AGE = 60 * 60 * 1000;

export function readDemoSession(): DemoSession | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(KEY) || 'null') as DemoSession | null;
    if (!value || !/^[a-f0-9-]{36}$/.test(value.id) || !Number.isFinite(value.createdAt) || Date.now() - value.createdAt > MAX_AGE
      || value.createdAt > Date.now() + 60_000 || !['setup', 'authorizing', 'running', 'sending', 'done', 'stopped'].includes(value.phase)
      || !(value.owner === null || typeof value.owner === 'string') || typeof value.previousProjectId !== 'string') return null;
    if (value.receipt && (typeof value.receipt.url !== 'string' || !isUsableReportUrl(value.receipt.url)
      || !Number.isFinite(Date.parse(value.receipt.expiresAt)))) return { ...value, phase: 'stopped', receipt: undefined };
    return value;
  } catch { return null; }
}
export function writeDemoSession(session: DemoSession) {
  // An OAuth redirect must not silently lose the user's explicit demo/send intent.
  try { window.sessionStorage.setItem(KEY, JSON.stringify(session)); }
  catch { throw new Error('시연 상태를 저장할 수 없습니다. 브라우저의 사이트 저장을 허용한 뒤 다시 시작해 주세요.'); }
}
export function clearDemoSession() { try { window.sessionStorage.removeItem(KEY); } catch { /* No persisted intent remains usable. */ } }
export function newDemoSession(owner: string | null, previousProjectId: string): DemoSession {
  return { id: crypto.randomUUID(), createdAt: Date.now(), owner, previousProjectId, phase: 'setup' };
}
export function assertDemoOwner(session: DemoSession, owner: string | null) {
  if (!owner || (session.owner && session.owner !== owner)) throw new Error('로그인 계정이 바뀌었습니다. 이 계정에서 시연을 새로 시작해 주세요.');
}
export function checkDemoActive(signal: AbortSignal) { if (signal.aborted) throw new DOMException('시연 중지', 'AbortError'); }
export function demoWait(ms: number, signal: AbortSignal): Promise<void> {
  checkDemoActive(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException('시연 중지', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, Math.max(0, ms));
    signal.addEventListener('abort', cancel, { once: true });
  });
}

interface Timeline {
  signal: AbortSignal;
  next: () => Promise<void>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  stage: (stage: DemoStage) => void;
  plan: () => Promise<number>;
  reveal: (count: number) => void;
  save: () => Promise<void>;
  buildPdf: () => Promise<void>;
  send: () => Promise<KakaoReportReceipt>;
  received: (receipt: KakaoReportReceipt) => void;
}
/** Scenes advance only by explicit clicks; within-scene animations may use timers. */
export async function runDemoTimeline(deps: Timeline): Promise<void> {
  const wait = deps.wait ?? demoWait;
  const active = () => checkDemoActive(deps.signal);
  const next = async (stage: DemoStage) => {
    active(); await deps.next(); active(); deps.stage(stage);
  };
  active(); deps.stage('brief');
  await next('space');
  await next('fixtures');
  await next('layout');
  const count = await deps.plan(); active();
  for (let i = 1; i <= count; i++) { deps.reveal(i); await wait(280, deps.signal); active(); }
  await deps.save(); active();
  await next('three');
  await next('review');
  await next('pdf');
  await deps.buildPdf(); active();
  // The PDF scene's advance button explicitly says it sends to Kakao.
  await next('send');
  const receipt = await deps.send(); active(); deps.received(receipt);
  deps.stage('done');
}
