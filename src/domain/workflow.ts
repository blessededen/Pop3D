import type { LayoutData } from './types';
import { checkSpaceData, validateLayout } from './validate';

export const WORKFLOW_STEPS = ['space', 'layout', 'review', 'report'] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export interface WorkflowReadiness {
  spaceReady: boolean;
  layoutReady: boolean;
  canReport: boolean;
  spaceProblems: string[];
  layoutProblems: string[];
}

/**
 * 작업 단계의 진행 조건. 실측 확인이나 최종 가격 확정을 뜻하지 않는다.
 * 기존 배치/PDF 정책과 같이 공간 자료 모순·배치 오류·빈 배치만 차단한다.
 * 문 개수, 미확인 가격, 참고용 객체에 새 조건을 추가하지 않는다.
 */
export function getWorkflowReadiness(data: LayoutData): WorkflowReadiness {
  const spaceProblems = checkSpaceData(data.space);
  const layoutProblems = validateLayout(data)
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);
  if (data.placements.length === 0) layoutProblems.unshift('집기를 먼저 배치해 주세요.');
  const spaceReady = spaceProblems.length === 0;
  const layoutReady = spaceReady && layoutProblems.length === 0;
  return { spaceReady, layoutReady, canReport: layoutReady, spaceProblems, layoutProblems };
}
