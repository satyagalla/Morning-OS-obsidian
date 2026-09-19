import type { Task } from "../types";
import { sortItems } from "../item-order";
import type { WidgetSelection, WidgetSelectionInput, WidgetSource, WidgetTaskEntry } from "./types";

function isOpenTask(item: Task): boolean {
  return item.kind === "task" && !item.is_deleted && item.status_completion === "open";
}

function limitEntries(entries: WidgetTaskEntry[], limit: number): WidgetTaskEntry[] {
  return entries.slice(0, Math.max(0, limit));
}

function selectedLines(input: WidgetSelectionInput): WidgetSelection {
  const lines = input.source === "identity"
    ? input.identityLines ?? input.brief?.identity?.rules ?? []
    : input.source === "goals-short"
      ? input.brief?.goals?.short_term ?? []
      : input.brief?.goals?.long_term ?? [];
  return {
    source: input.source,
    lines: lines.slice(0, Math.max(0, input.limit)),
    tasks: [],
    unavailable: !input.brief && input.source !== "identity" && !input.identityLines,
  };
}

function todayTasks(input: WidgetSelectionInput): WidgetTaskEntry[] {
  const byId = new Map(input.registry.map(item => [item._id, item]));
  const selectedRoots = input.registry.filter(item =>
    item.parent_id === null && item.is_today && isOpenTask(item)
  );
  const selectedRootIds = new Set(selectedRoots.map(item => item._id));
  const entries: WidgetTaskEntry[] = [];
  const emitted = new Set<string>();
  const emit = (task: Task, parentContext?: Task | null): void => {
    if (!isOpenTask(task) || emitted.has(task._id)) return;
    emitted.add(task._id);
    entries.push(parentContext === undefined ? { task } : { task, parentContext });
  };

  for (const root of selectedRoots) {
    emit(root);
    for (const child of input.registry) {
      if (child.parent_id === root._id) emit(child);
    }
  }
  for (const child of input.registry) {
    if (!child.is_today || !child.parent_id || selectedRootIds.has(child.parent_id)) continue;
    emit(child, byId.get(child.parent_id) ?? null);
  }
  return entries;
}

function rootsWithOpenChildren(input: WidgetSelectionInput, source: "inbox-tasks" | "all-tasks"): WidgetTaskEntry[] {
  const openChildrenByParent = new Map<string, Task[]>();
  for (const item of input.registry) {
    if (item.parent_id && isOpenTask(item)) {
      const children = openChildrenByParent.get(item.parent_id) ?? [];
      children.push(item);
      openChildrenByParent.set(item.parent_id, children);
    }
  }
  const entries: WidgetTaskEntry[] = [];
  const emitted = new Set<string>();
  const roots = sortItems(input.registry.filter(root =>
    root.parent_id === null && root.kind === "task" && !root.is_deleted
  ), "date_created", "desc");
  for (const root of roots) {
    const children = openChildrenByParent.get(root._id) ?? [];
    const include = source === "all-tasks"
      ? root.status_completion === "open" || children.length > 0
      : root.areas.length === 0 && (root.status_completion === "open" || children.length > 0);
    if (!include) continue;
    if (isOpenTask(root)) {
      entries.push({ task: root });
      emitted.add(root._id);
    }
    for (const child of sortItems(children, "date_created", "desc")) {
      if (!emitted.has(child._id)) {
        entries.push(root.status_completion === "open" ? { task: child } : { task: child, parentContext: root });
        emitted.add(child._id);
      }
    }
  }
  return entries;
}

export function selectWidgetContent(input: WidgetSelectionInput): WidgetSelection {
  if (input.source === "identity" || input.source === "goals-short" || input.source === "goals-long") {
    return selectedLines(input);
  }
  const tasks = input.source === "today-tasks"
    ? todayTasks(input)
    : rootsWithOpenChildren(input, input.source as "inbox-tasks" | "all-tasks");
  return { source: input.source, lines: [], tasks: limitEntries(tasks, input.limit), unavailable: false };
}

export function widgetSourceTitle(source: WidgetSource): string {
  const titles: Record<WidgetSource, string> = {
    "identity": "Identity",
    "goals-short": "Short-term goals",
    "goals-long": "Long-term goals",
    "today-tasks": "Today",
    "inbox-tasks": "Inbox",
    "all-tasks": "All tasks",
  };
  return titles[source];
}
