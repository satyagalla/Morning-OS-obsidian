import type { Task } from "./types";

export type ItemSortField = "date_created" | "date_modified" | "date_completed" | "name";
export type ItemSortDirection = "asc" | "desc";

/** Shared default ordering for views and non-visual item projections. */
export function sortItems(tasks: Task[], field: ItemSortField, direction: ItemSortDirection): Task[] {
  return [...tasks].sort((a, b) => {
    const left = field === "name" ? a.text : (a[field] ?? "");
    const right = field === "name" ? b.text : (b[field] ?? "");
    if (left < right) return direction === "asc" ? -1 : 1;
    if (left > right) return direction === "asc" ? 1 : -1;
    return 0;
  });
}
