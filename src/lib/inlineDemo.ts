import { create } from 'zustand';
import type { Space } from '../domain/types';
import type { WorkflowStep } from '../domain/workflow';
import type { DemoSession, DemoStage } from './autoDemo';
import type { KakaoReportReceipt } from './kakaoReport';

export type InlineDemoPhase = 'idle' | 'setup' | 'running' | 'sending' | 'done' | 'stopped';
export interface InlineDemoState {
  runId: string | null;
  projectId: string | null;
  stage: DemoStage;
  elapsed: number;
  phase: InlineDemoPhase;
  paused: boolean;
  pause: (() => void) | null;
  resume: (() => void) | null;
  working: string;
  error: string;
  targetSpace: Space | null;
  pdfUrl: string;
  receipt: KakaoReportReceipt | null;
  stop: (() => void) | null;
  dismiss: (() => void) | null;
  download: (() => void) | null;
  reconnect: (() => void) | null;
}
export const emptyInlineDemo = (): InlineDemoState => ({
  runId: null, projectId: null, stage: 'brief', elapsed: 0, phase: 'idle', paused: false, pause: null, resume: null, working: '', error: '',
  targetSpace: null, pdfUrl: '', receipt: null, stop: null, dismiss: null, download: null, reconnect: null,
});
// Presentation is deliberately not persisted. Reload never restarts a send.
export const useInlineDemo = create<InlineDemoState>()(() => emptyInlineDemo());
export const isInlineDemoLocked = (phase: InlineDemoPhase) => ['setup', 'running', 'sending'].includes(phase);
export const restoreInlineDemoSession = (session: DemoSession | null, projectId: string): boolean =>
  !!session?.projectId && session.projectId === projectId && ['running', 'sending', 'done'].includes(session.phase);
export function inlineDemoStageToStep(stage: DemoStage): WorkflowStep {
  if (stage === 'brief' || stage === 'space') return 'space';
  if (stage === 'fixtures' || stage === 'layout' || stage === 'three') return 'layout';
  return stage === 'review' ? 'review' : 'report';
}
export function inlineDemoRoute(stage: DemoStage): string {
  const step = inlineDemoStageToStep(stage);
  return step === 'space' ? '#/spaces' : step === 'report' ? '#/report' : '#/layout';
}
