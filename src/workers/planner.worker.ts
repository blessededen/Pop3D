import { optimizeLayout, proposePlan } from '../domain/planner';
import type { LayoutData } from '../domain/types';

const scope = self as unknown as { onmessage: ((event: MessageEvent<{ data: LayoutData; repair: boolean }>) => void) | null; postMessage: (message: unknown) => void };
scope.onmessage = event => {
  try { scope.postMessage({ result: event.data.repair ? optimizeLayout(event.data.data) : proposePlan(event.data.data, { preserveQuantities: true }) }); }
  catch { scope.postMessage({ error: '배치를 계산하지 못했습니다. 다시 시도해 주세요.' }); }
};
