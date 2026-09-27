import type { CatalogItem, Project, Requirement } from './types';

const floor = (r: Requirement) => r.required ? Math.max(1, r.minQty) : r.minQty;
function addIntent(project: Project, item: CatalogItem, minimum = 0, required = false, priority = 2) {
  let requirement = project.requirements.find(r => r.sku === item.sku);
  if (!requirement) {
    requirement = { category:item.category, sku:item.sku, required:false, minQty:0, desiredQty:0, priority, needsPower: item.needsPower };
    project.requirements.push(requirement);
  }
  requirement.minQty = floor(requirement) + minimum;
  requirement.required ||= required;
  requirement.desiredQty = Math.max(requirement.desiredQty + 1, floor(requirement));
  requirement.priority = Math.min(requirement.priority, priority);
}

/** Explicit manual additions also become inputs to the next generated plan. */
export function addFixtureIntent(project: Project, item: CatalogItem) { addIntent(project,item); }

/** Removing furniture lowers its desired count, but cannot silently remove a required minimum. */
export function removeFixtureIntent(project: Project, sku: string, explicit = false) {
  const requirement = project.requirements.find(r => r.sku === sku);
  if (!requirement) return;
  if (explicit) {
    requirement.desiredQty = Math.max(0, requirement.desiredQty - 1);
    requirement.minQty = Math.min(requirement.minQty, requirement.desiredQty);
    requirement.required = requirement.required && requirement.desiredQty > 0;
  } else requirement.desiredQty = Math.max(floor(requirement), requirement.desiredQty - 1);
  project.requirements = project.requirements.filter(r => r.desiredQty > 0 || floor(r) > 0);
}

/** Transfer one unit of planning intent, retaining other sizes of the same category. */
export function replaceFixtureIntent(project: Project, oldSku: string, item: CatalogItem, oldOrderCount: number) {
  if (oldSku === item.sku) return;
  const old = project.requirements.find(r => r.sku === oldSku);
  const minimum = old && oldOrderCount <= floor(old) ? Math.min(1, floor(old)) : 0;
  const required = !!old?.required && minimum > 0;
  const priority = old?.priority ?? 2;
  const needsPower = old?.needsPower;
  if (old) {
    old.minQty = Math.max(0, floor(old) - minimum);
    old.required = old.required && old.minQty > 0;
    old.desiredQty = Math.max(floor(old), old.desiredQty - 1);
    project.requirements = project.requirements.filter(r => r.desiredQty > 0 || floor(r) > 0);
  }
  addIntent(project,item,minimum,required,priority);
  if (needsPower) project.requirements.find(r => r.sku === item.sku)!.needsPower = true;
}
