import type { Task } from "../types";

/** A draft is compared with the item as it was when editing started, never with
 * a timestamp or revision.  This is deliberately a local-editor safeguard,
 * not a sync merge protocol. */
export type ItemDraft = Task;

export interface DraftConflict {
  field: keyof Task;
  key?: string;
  base: unknown;
  draft: unknown;
  external: unknown;
}

export type DraftConflictChoice = keyof Task | { field: "tags"; key: string };

export interface DraftReconciliation {
  patch: Partial<Task>;
  conflicts: DraftConflict[];
}

const NON_EDITABLE_FIELDS: ReadonlySet<keyof Task> = new Set([
  "_id", "date_created", "date_modified", "date_completed", "is_deleted",
  "deletion_batch_id", "deleted_member_ids", "reminder_occurrence",
]);

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function cloneItemDraft(item: Task): ItemDraft {
  return JSON.parse(JSON.stringify(item)) as ItemDraft;
}

export function reconcileItemDraft(base: ItemDraft, draft: ItemDraft, current: Task): DraftReconciliation {
  const patch: Partial<Task> = {};
  const conflicts: DraftConflict[] = [];
  for (const field of Object.keys(draft) as (keyof Task)[]) {
    if (NON_EDITABLE_FIELDS.has(field) || same(draft[field], base[field])) continue;
    if (field === "tags") {
      const baseTags = base.tags;
      const draftTags = draft.tags;
      const currentTags = current.tags;
      const mergedTags = cloneValue(currentTags);
      for (const key of new Set([...Object.keys(baseTags), ...Object.keys(draftTags)])) {
        if (same(draftTags[key], baseTags[key])) continue;
        if (!same(currentTags[key], baseTags[key]) && !same(currentTags[key], draftTags[key])) {
          conflicts.push({ field, key, base: { [key]: baseTags[key] }, draft: { [key]: draftTags[key] }, external: { [key]: currentTags[key] } });
          continue;
        }
        if (draftTags[key] === undefined) delete mergedTags[key];
        else mergedTags[key] = cloneValue(draftTags[key]);
      }
      patch.tags = mergedTags;
      continue;
    }
    if (!same(current[field], base[field]) && !same(current[field], draft[field])) {
      conflicts.push({ field, base: base[field], draft: draft[field], external: current[field] });
      continue;
    }
    patch[field] = cloneValue(draft[field]);
  }
  return { patch, conflicts };
}

export function forceDraftFields(base: ItemDraft, draft: ItemDraft, current: Task, fields: readonly DraftConflictChoice[]): Partial<Task> {
  const patch: Partial<Task> = {};
  let tags: Task["tags"] | null = null;
  for (const choice of fields) {
    const field = typeof choice === "object" ? choice.field : choice;
    if (NON_EDITABLE_FIELDS.has(field) || same(draft[field], base[field])) continue;
    if (field === "tags") {
      tags ??= cloneValue(current.tags);
      const keys = typeof choice === "object"
        ? new Set([choice.key])
        : new Set([...Object.keys(base.tags), ...Object.keys(draft.tags)]);
      for (const key of keys) {
        if (same(base.tags[key], draft.tags[key])) continue;
        if (draft.tags[key] === undefined) delete tags[key];
        else tags[key] = cloneValue(draft.tags[key]);
      }
      patch.tags = tags;
    } else {
      patch[field] = cloneValue(draft[field]);
    }
  }
  return patch;
}

/** All tag changes are known safe once reconciliation has established that every
 * conflict was explicitly authorized. Build them over the item read inside the
 * serialized write so independent external keys survive too. */
export function mergeDraftTags(base: ItemDraft, draft: ItemDraft, current: Task): Task["tags"] {
  const tags = cloneValue(current.tags);
  for (const key of new Set([...Object.keys(base.tags), ...Object.keys(draft.tags)])) {
    if (same(base.tags[key], draft.tags[key])) continue;
    if (draft.tags[key] === undefined) delete tags[key];
    else tags[key] = cloneValue(draft.tags[key]);
  }
  return tags;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
