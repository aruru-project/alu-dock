import type { CatalogInstanceRecord } from "../core/catalog.js";

/** Follow the original local parent links through eligible records, regardless of file order.
 * A child of Main on a SubHost is a root here, not a child of any local Work with a similar ID. */
export function catalogBranches(roots: CatalogInstanceRecord[], eligible: readonly CatalogInstanceRecord[]): CatalogInstanceRecord[] {
  const children = new Map<string, CatalogInstanceRecord[]>();
  for (const record of eligible) {
    if (record.parentId === undefined || record.childGrant?.mainParent) continue;
    const family = children.get(record.parentId) ?? [];
    family.push(record);
    children.set(record.parentId, family);
  }
  const branch = [...roots];
  for (const parent of branch) {
    const below = children.get(parent.id);
    if (below) { children.delete(parent.id); branch.push(...below); }
  }
  return branch;
}
