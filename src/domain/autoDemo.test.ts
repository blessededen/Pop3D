import { describe, expect, it } from 'vitest';
import { createAutoDemoWorkspace, planAutoDemo } from './autoDemo';
import { computeCost } from './cost';
import { fixtureHeightStatus, nearestPowerDistance } from './placementRules';
import { daysInclusive, demoProject, demoSpace, demoVendor } from './seed';
import { hasBlockingIssues, indexItems, validateLayout } from './validate';
import { draftData } from './version';

const now = new Date('2026-09-28T03:00:00Z');

describe('isolated automatic demonstration workspace', () => {
  it('starts with an empty, clearly identified seven-day sample and independent run IDs', () => {
    const a = createAutoDemoWorkspace('run-a', now);
    const b = createAutoDemoWorkspace('run-b', now);
    expect(a.project.name).toContain('[시연]');
    expect(a.project.memo).toContain('예시 프로젝트');
    expect(a.space).toMatchObject({ width: 5, depth: 10, height: 3, isVirtual: true });
    expect(a.project.spaceId).toBe(a.space.id);
    expect(a.project.vendorId).toBe(a.vendor.id);
    expect(a.project.placements).toEqual([]);
    expect(a.project.versions).toEqual([]);
    expect(a.project.layoutNeedsUpdate).toBe(true);
    expect(daysInclusive(a.project.event.startDate, a.project.event.endDate)).toBe(7);
    expect(a.project.event.rentalDays).toBe(7);
    expect(a.project.createdAt).toBe(now.toISOString());
    const ids = (workspace: typeof a) => [
      workspace.space.id, workspace.vendor.id, workspace.project.id,
      ...workspace.space.doors.map(item => item.id), ...workspace.space.columns.map(item => item.id),
      ...workspace.space.powerPoints.map(item => item.id), ...workspace.vendor.items.map(item => item.sku),
      ...workspace.vendor.services.map(item => item.id),
    ];
    expect(new Set(ids(a)).size).toBe(ids(a).length);
    expect(ids(a).every(id => !ids(b).includes(id))).toBe(true);
    expect(createAutoDemoWorkspace('run/a', now).project.id).not.toBe(createAutoDemoWorkspace('run-a', now).project.id);
  });

  it('places all nine selected fixtures with real collision, access, aisle, height and power checks', () => {
    const { space, vendor, project } = createAutoDemoWorkspace('real-planner', now);
    const before = structuredClone({ space, vendor, project });
    const plan = planAutoDemo(project, space, vendor);
    expect(plan.ok, plan.reasons.join('\n')).toBe(true);
    expect(plan.unplaced).toEqual([]);
    expect(plan.composition.adjustments).toEqual([]);
    expect(plan.placements).toHaveLength(9);
    for (const requirement of project.requirements) {
      expect(plan.placements.filter(item => item.sku === requirement.sku)).toHaveLength(requirement.desiredQty);
    }
    const data = { ...draftData(project, space, vendor), placements: plan.placements };
    const issues = validateLayout(data);
    expect(hasBlockingIssues(issues), issues.map(issue => issue.message).join('\n')).toBe(false);
    expect(issues.some(issue => ['HEIGHT', 'HEIGHT_CLEARANCE', 'POWER_POINT_MISSING', 'AISLE', 'ACCESS_BLOCKED'].includes(issue.code))).toBe(false);
    const items = indexItems(vendor.items);
    for (const placement of plan.placements) expect(fixtureHeightStatus(space, items.get(placement.sku)!)).toMatchObject({ blocked: false, warning: false });
    const powered = project.requirements.filter(requirement => requirement.needsPower);
    expect(powered.map(requirement => requirement.category).sort()).toEqual(['counter', 'photozone']);
    for (const requirement of powered) {
      const placement = plan.placements.find(item => item.sku === requirement.sku)!;
      expect(nearestPowerDistance(placement, space.powerPoints)).toBeLessThan(1);
    }
    const cost = computeCost(data);
    expect(cost.unknownLines).toEqual([]);
    expect(cost.knownTotal).toBe(1_250_000);
    expect(cost.budgetDiff).toBe(250_000);
    expect({ space, vendor, project }).toEqual(before);
  });

  it('never reduces selected quantities when the example budget is edited downward', () => {
    const { space, vendor, project } = createAutoDemoWorkspace('small-budget', now);
    project.budget.amount = 1;
    const plan = planAutoDemo(project, space, vendor);
    expect(plan.ok).toBe(true);
    expect(plan.placements).toHaveLength(9);
    expect(plan.composition.adjustments).toEqual([]);
    expect(plan.notes).toContainEqual(expect.stringContaining('선택한 수량을 유지했습니다'));
  });

  it('does not mutate seed data or share nested objects across runs', () => {
    const original = { space: demoSpace(), vendor: demoVendor(), project: demoProject(undefined, undefined, now) };
    const expected = structuredClone(original);
    const first = createAutoDemoWorkspace('first', now);
    const second = createAutoDemoWorkspace('second', now);
    const secondBefore = structuredClone(second);
    first.vendor.items[0].price.amount = 1;
    first.space.doors[0].width = 0.1;
    first.project.fees[0].amount = 1;
    first.project.requirements[0].desiredQty = 50;
    expect(second).toEqual(secondBefore);
    expect(original).toEqual(expected);
    expect({ space: demoSpace(), vendor: demoVendor(), project: demoProject(undefined, undefined, now) }).toEqual(expected);
    expect(first.vendor.services[0].amount).toBe(150_000);
  });
});
