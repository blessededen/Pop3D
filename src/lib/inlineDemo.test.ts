import { describe, expect, it } from 'vitest';
import type { DemoSession } from './autoDemo';
import { isInlineDemoLocked, restoreInlineDemoSession } from './inlineDemo';

const session: DemoSession = {
  id: 'demo-run', createdAt: 0, owner: 'owner-one', previousProjectId: 'previous-project',
  projectId: 'demo-project', phase: 'sending',
};

describe('inline demo reload recovery', () => {
  it.each(['running', 'sending', 'done'] as const)('restores %s presentation for its current project without changing persisted intent', (phase) => {
    const saved = Object.freeze({ ...session, phase });
    expect(restoreInlineDemoSession(saved, 'demo-project')).toBe(true);
    expect(saved.phase).toBe(phase);
  });

  it.each(['setup', 'authorizing', 'stopped'] as const)('does not start a %s session just by visiting the ordinary workflow', (phase) => {
    expect(restoreInlineDemoSession({ ...session, phase }, 'demo-project')).toBe(false);
  });

  it('does not take over another project or infer a missing project from the previous one', () => {
    expect(restoreInlineDemoSession(session, 'other-project')).toBe(false);
    expect(restoreInlineDemoSession(session, 'previous-project')).toBe(false);
    expect(restoreInlineDemoSession(session, '')).toBe(false);
    expect(restoreInlineDemoSession({ ...session, projectId: undefined }, 'previous-project')).toBe(false);
    expect(restoreInlineDemoSession({ ...session, projectId: '' }, '')).toBe(false);
    expect(restoreInlineDemoSession(null, 'demo-project')).toBe(false);
  });

  it('keeps edits locked during delivery but releases them after stopping or completion', () => {
    expect(isInlineDemoLocked('sending')).toBe(true);
    expect(isInlineDemoLocked('stopped')).toBe(false);
    expect(isInlineDemoLocked('done')).toBe(false);
  });
});
