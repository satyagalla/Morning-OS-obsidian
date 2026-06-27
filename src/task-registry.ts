import { App } from "obsidian";
import type { Task, TaskRegistry } from "./types";
import { todayStr } from "./utils";

const REGISTRY_PATH = "_generated/tasks.json";

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function loadRegistry(app: App): Promise<TaskRegistry> {
  const exists = await app.vault.adapter.exists(REGISTRY_PATH);
  if (!exists) return [];
  try {
    const raw = await app.vault.adapter.read(REGISTRY_PATH);
    return JSON.parse(raw) as TaskRegistry;
  } catch {
    return [];
  }
}

export async function saveRegistry(app: App, registry: TaskRegistry): Promise<void> {
  await app.vault.adapter.mkdir("_generated");
  await app.vault.adapter.write(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function parseTagsFromText(text: string): { cleanText: string; pillars: string[]; tags: Record<string, string>; remind_date: string | null } {
  const pillars: string[] = [];
  const tags: Record<string, string> = {};
  let remind_date: string | null = null;

  // #p/pillar → pillars array
  const pillarMatches = text.matchAll(/#p\/([\w-]+)/g);
  for (const m of pillarMatches) pillars.push(m[1]);

  // #t/subtab — stored against most recently seen pillar
  const subtabMatches = text.matchAll(/#t\/([\w-]+)/g);
  const subtabList: string[] = [];
  for (const m of subtabMatches) subtabList.push(m[1]);
  if (subtabList.length > 0 && pillars.length > 0) {
    tags[pillars[pillars.length - 1]] = subtabList[0];
  }

  // @remind(YYYY-MM-DD)
  const remindMatch = text.match(/@remind\((\d{4}-\d{2}-\d{2})\)/);
  if (remindMatch) remind_date = remindMatch[1];

  const cleanText = text
    .replace(/#p\/[\w-]+/g, "")
    .replace(/#t\/[\w-]+/g, "")
    .replace(/@remind\([^)]*\)/g, "")
    .trim();

  return { cleanText, pillars, tags, remind_date };
}

export function createTask(
  rawText: string,
  opts: Partial<Pick<Task, "priority" | "urgency" | "pillars" | "tags" | "in_today" | "remind_date">> = {}
): Task {
  const today = todayStr();
  const parsed = parseTagsFromText(rawText);
  // opts overrides parsed tags if explicitly provided
  const pillars = opts.pillars !== undefined ? opts.pillars : parsed.pillars;
  const tags = opts.tags !== undefined ? opts.tags : parsed.tags;
  const remind_date = opts.remind_date !== undefined ? opts.remind_date : parsed.remind_date;
  return {
    id: generateId(),
    text: parsed.cleanText,
    done: false,
    created: today,
    modified: today,
    completed: null,
    priority: opts.priority ?? "regular",
    urgency: opts.urgency ?? "none",
    pillars,
    tags,
    in_today: opts.in_today ?? false,
    remind_date,
    deleted_from: [],
    deleted: false,
  };
}

export async function addTask(app: App, task: Task): Promise<void> {
  const registry = await loadRegistry(app);
  registry.push(task);
  await saveRegistry(app, registry);
}

export async function updateTask(app: App, id: string, patch: Partial<Task>): Promise<void> {
  const registry = await loadRegistry(app);
  const idx = registry.findIndex(t => t.id === id);
  if (idx === -1) return;
  registry[idx] = { ...registry[idx], ...patch, modified: todayStr() };
  await saveRegistry(app, registry);
}

export async function toggleTaskDone(app: App, id: string, done: boolean): Promise<void> {
  const today = todayStr();
  await updateTask(app, id, {
    done,
    completed: done ? today : null,
    modified: today,
  });
}

export async function moveTaskToToday(app: App, id: string, priority: "red" | "regular"): Promise<void> {
  await updateTask(app, id, { in_today: true, priority });
}

export async function clearTaskFromView(app: App, id: string, view: string): Promise<void> {
  const registry = await loadRegistry(app);
  const idx = registry.findIndex(t => t.id === id);
  if (idx === -1) return;
  const task = registry[idx];
  if (!task.deleted_from.includes(view)) {
    task.deleted_from.push(view);
    task.modified = todayStr();
  }
  await saveRegistry(app, registry);
}

export function getTodayTasks(registry: TaskRegistry): { red: Task[]; regular: Task[] } {
  const today = todayStr();
  return {
    red: registry.filter(t => !t.deleted && t.in_today && t.priority === "red" && !t.deleted_from.includes("home") && !(t.done && t.completed !== today)),
    regular: registry.filter(t => !t.deleted && t.in_today && t.priority === "regular" && !t.deleted_from.includes("home") && !(t.done && t.completed !== today)),
  };
}

export function getPillarTasks(registry: TaskRegistry, pillar: string, tab?: string): Task[] {
  return registry.filter(t =>
    !t.deleted &&
    t.pillars.includes(pillar) &&
    !t.deleted_from.includes(pillar) &&
    (tab === undefined || t.tags[pillar] === tab)
  );
}

export function getDumpTasks(registry: TaskRegistry): Task[] {
  return registry.filter(t => !t.deleted && !t.deleted_from.includes("inbox") && !t.deleted_from.includes("dump"));
}

export async function deleteTask(app: App, id: string): Promise<void> {
  await updateTask(app, id, { deleted: true, in_today: false });
}

export async function restoreTask(app: App, id: string): Promise<void> {
  await updateTask(app, id, { deleted: false });
}

export async function clearNextDayTasks(app: App): Promise<void> {
  const today = todayStr();
  const registry = await loadRegistry(app);
  for (const task of registry) {
    if (task.in_today && task.done && task.completed !== today) {
      task.in_today = false;
      task.modified = today;
    }
  }
  await saveRegistry(app, registry);
}

export { generateId, REGISTRY_PATH };
