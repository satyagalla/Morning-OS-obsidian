import { App } from "obsidian";
import type { AreaConfig, TabConfig, Task, TaskRegistry, CompletionStatus } from "./types";
import { writeHistorySnapshot } from "./agent/history";
import { todayStr } from "./utils";

const REGISTRY_PATH = "_generated/tasks.json";
const AREAS_RECOVERY_BACKUP_PATH = "_generated/backups/tasks-before-areas-recovery.json";

export interface AreasRecoveryResult {
  changed: boolean;
  settingsChanged: boolean;
  tasksRecovered: number;
  legacyTasksMigrated: number;
  areasCreated: number;
  tabsCreated: number;
  backupCreated: boolean;
  error?: string;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function loadRegistry(app: App): Promise<TaskRegistry> {
  const exists = await app.vault.adapter.exists(REGISTRY_PATH);
  if (!exists) return [];
  try {
    const raw = await app.vault.adapter.read(REGISTRY_PATH);
    const tasks = JSON.parse(raw) as Record<string, unknown>[];
    // Migrate old field names on read
    return tasks.map(migrateTask);
  } catch {
    return [];
  }
}

/**
 * Repairs persisted task area metadata before normal registry reads can discard
 * legacy fields. This is intentionally safe to call on every plugin launch:
 * completed records already have `areas`, settings entries are de-duplicated,
 * and no files are written when there is nothing left to repair.
 */
export async function recoverRegistryAreas(app: App, configuredAreas: AreaConfig[]): Promise<AreasRecoveryResult> {
  const result: AreasRecoveryResult = {
    changed: false,
    settingsChanged: false,
    tasksRecovered: 0,
    legacyTasksMigrated: 0,
    areasCreated: 0,
    tabsCreated: 0,
    backupCreated: false,
  };

  if (!(await app.vault.adapter.exists(REGISTRY_PATH))) return result;

  let raw: string;
  let tasks: Record<string, unknown>[];
  try {
    raw = await app.vault.adapter.read(REGISTRY_PATH);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
      throw new Error("registry is not an array of task records");
    }
    tasks = parsed;
  } catch (err) {
    return { ...result, error: `Could not read ${REGISTRY_PATH}: ${(err as Error).message}` };
  }

  const recoveredAreaConfigs = JSON.parse(JSON.stringify(configuredAreas)) as AreaConfig[];

  // Only configured area keys can be inferred from tags alone. Tags also hold
  // arbitrary custom fields, so treating every tag key as an area would corrupt
  // the user's settings (for example, "status" or "company").
  const inferableAreaKeys = new Set(recoveredAreaConfigs.map(area => area.key));

  for (const task of tasks) {
    const currentAreas = readStringArray(task.areas);
    const legacyAreas = readStringArray(task.pillars);
    const tags = readStringRecord(task.tags);
    let recoveredAreas = currentAreas;

    if (currentAreas.length === 0 && legacyAreas.length > 0) {
      recoveredAreas = legacyAreas;
      task.areas = recoveredAreas;
      result.changed = true;
      result.tasksRecovered++;
      result.legacyTasksMigrated++;
    } else if (currentAreas.length === 0) {
      const inferredAreas = Object.keys(tags).filter(key => inferableAreaKeys.has(key));
      if (inferredAreas.length > 0) {
        recoveredAreas = inferredAreas;
        task.areas = recoveredAreas;
        result.changed = true;
        result.tasksRecovered++;
      }
    }

    // A valid `areas` value wins over legacy data, but the old field must not
    // survive a rewrite because normal runtime code only understands `areas`.
    if (Object.prototype.hasOwnProperty.call(task, "pillars")) {
      delete task.pillars;
      result.changed = true;
    }

    for (const areaKey of recoveredAreas) {
      // An existing `areas` value or a legacy `pillars` value is authoritative.
      // Once seen, it may also safely establish this key for later tag recovery.
      inferableAreaKeys.add(areaKey);
      const area = ensureArea(recoveredAreaConfigs, areaKey);
      if (area.created) {
        result.settingsChanged = true;
        result.areasCreated++;
      }

      const tabKey = tags[areaKey];
      if (tabKey && ensureTab(area.area, tabKey)) {
        result.settingsChanged = true;
        result.tabsCreated++;
      }
    }
  }

  if (!result.changed) {
    if (result.settingsChanged) replaceAreaConfigs(configuredAreas, recoveredAreaConfigs);
    return result;
  }

  try {
    if (!(await app.vault.adapter.exists("_generated/backups"))) {
      await app.vault.adapter.mkdir("_generated/backups");
    }
    if (!(await app.vault.adapter.exists(AREAS_RECOVERY_BACKUP_PATH))) {
      await app.vault.adapter.write(AREAS_RECOVERY_BACKUP_PATH, raw);
      result.backupCreated = true;
    }
    await app.vault.adapter.write(REGISTRY_PATH, JSON.stringify(tasks, null, 2));
    if (result.settingsChanged) replaceAreaConfigs(configuredAreas, recoveredAreaConfigs);
    return result;
  } catch (err) {
    return { ...result, settingsChanged: false, error: `Could not write area recovery: ${(err as Error).message}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
  );
}

function ensureArea(areas: AreaConfig[], key: string): { area: AreaConfig; created: boolean } {
  const existing = areas.find(area => area.key === key);
  if (existing) return { area: existing, created: false };

  const area: AreaConfig = {
    key,
    label: labelFromKey(key),
    icon: "",
    feedToLLM: false,
    tabs: [],
  };
  areas.push(area);
  return { area, created: true };
}

function ensureTab(area: AreaConfig, key: string): boolean {
  if (area.tabs.some(tab => tab.key === key)) return false;
  const tab: TabConfig = {
    key,
    label: labelFromKey(key),
    fields: [],
    view_mode: "cards",
  };
  area.tabs.push(tab);
  return true;
}

function labelFromKey(key: string): string {
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || key;
}

function replaceAreaConfigs(target: AreaConfig[], source: AreaConfig[]): void {
  target.splice(0, target.length, ...source);
}

function migrateTask(t: Record<string, unknown>): Task {
  return {
    _id:               (t._id ?? t.id ?? generateId()) as string,
    text:              (t.text ?? "") as string,
    notes:             (t.notes ?? "") as string,
    areas:           (t.areas ?? []) as string[],
    tags:              (t.tags ?? {}) as Record<string, string>,
    status_completion: migrateCompletion(t),
    status_priority:   (t.status_priority ?? t.priority ?? "regular") as "red" | "regular",
    status_urgency:    (t.status_urgency ?? t.urgency ?? "none") as Task["status_urgency"],
    is_today:          (t.is_today ?? t.in_today ?? false) as boolean,
    is_deleted:        (t.is_deleted ?? t.deleted ?? false) as boolean,
    parent_id:         (t.parent_id ?? null) as string | null,
    date_created:      (t.date_created ?? t.created ?? todayStr()) as string,
    date_modified:     (t.date_modified ?? t.modified ?? todayStr()) as string,
    date_completed:    (t.date_completed ?? t.completed ?? null) as string | null,
    date_remind:       (t.date_remind ?? t.remind_date ?? null) as string | null,
  };
}

function migrateCompletion(t: Record<string, unknown>): CompletionStatus {
  if (t.status_completion) return t.status_completion as CompletionStatus;
  if (t.done === true) return "done";
  return "open";
}

export async function saveRegistry(app: App, registry: TaskRegistry): Promise<void> {
  await app.vault.adapter.mkdir("_generated");
  await app.vault.adapter.write(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

function parseTagsFromText(text: string): { cleanText: string; areas: string[]; tags: Record<string, string>; date_remind: string | null } {
  const areas: string[] = [];
  const tags: Record<string, string> = {};
  let date_remind: string | null = null;

  const areaMatches = text.matchAll(/#p\/([\w-]+)/g);
  for (const m of areaMatches) areas.push(m[1]);

  const subtabMatches = text.matchAll(/#t\/([\w-]+)/g);
  const subtabList: string[] = [];
  for (const m of subtabMatches) subtabList.push(m[1]);
  if (subtabList.length > 0 && areas.length > 0) {
    tags[areas[areas.length - 1]] = subtabList[0];
  }

  const remindMatch = text.match(/@remind\((\d{4}-\d{2}-\d{2})\)/);
  if (remindMatch) date_remind = remindMatch[1];

  const cleanText = text
    .replace(/#p\/[\w-]+/g, "")
    .replace(/#t\/[\w-]+/g, "")
    .replace(/@remind\([^)]*\)/g, "")
    .trim();

  return { cleanText, areas, tags, date_remind };
}

export function createTask(
  rawText: string,
  opts: Partial<Pick<Task, "status_priority" | "status_urgency" | "areas" | "tags" | "is_today" | "date_remind" | "parent_id">> = {}
): Task {
  const today = todayStr();
  const parsed = parseTagsFromText(rawText);
  return {
    _id: generateId(),
    text: parsed.cleanText,
    notes: "",
    areas: opts.areas !== undefined ? opts.areas : parsed.areas,
    tags: opts.tags !== undefined ? opts.tags : parsed.tags,
    status_completion: "open",
    status_priority: opts.status_priority ?? "regular",
    status_urgency: opts.status_urgency ?? "none",
    is_today: opts.is_today ?? false,
    is_deleted: false,
    parent_id: opts.parent_id ?? null,
    date_created: today,
    date_modified: today,
    date_completed: null,
    date_remind: opts.date_remind !== undefined ? opts.date_remind : parsed.date_remind,
  };
}

export function getChildren(registry: TaskRegistry, parentId: string): Task[] {
  return registry.filter(t => t.parent_id === parentId && !t.is_deleted);
}

export function hasOpenChildren(registry: TaskRegistry, parentId: string): boolean {
  return getChildren(registry, parentId).some(t => t.status_completion !== "done");
}


export async function updateTask(app: App, id: string, patch: Partial<Task>): Promise<void> {
  const registry = await loadRegistry(app);
  const idx = registry.findIndex(t => t._id === id);
  if (idx === -1) return;
  registry[idx] = { ...registry[idx], ...patch, date_modified: todayStr() };
  await saveRegistry(app, registry);
}

export async function setTaskStatus(app: App, id: string, status: CompletionStatus): Promise<void> {
  const today = todayStr();
  await updateTask(app, id, {
    status_completion: status,
    date_completed: status === "done" ? today : null,
  });
}

export async function moveTaskToToday(app: App, id: string, priority: "red" | "regular"): Promise<void> {
  await updateTask(app, id, { is_today: true, status_priority: priority });
}

export async function deleteTask(app: App, id: string): Promise<void> {
  const registry = await loadRegistry(app);
  const today = todayStr();
  for (const t of registry) {
    if (t._id === id || t.parent_id === id) {
      t.is_deleted = true;
      t.is_today = false;
      t.date_modified = today;
    }
  }
  await saveRegistry(app, registry);
}

export async function restoreTask(app: App, id: string): Promise<void> {
  await updateTask(app, id, { is_deleted: false });
}

export async function clearNextDayTasks(app: App): Promise<void> {
  const today = todayStr();
  const d = new Date(today + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const registry = await loadRegistry(app);

  // Snapshot yesterday's state before clearing
  await writeHistorySnapshot(app, yesterdayStr, registry);

  for (const task of registry) {
    if (task.is_today && task.status_completion === "done" && task.date_completed !== today) {
      task.is_today = false;
      task.date_modified = today;
    }
  }
  await saveRegistry(app, registry);
}

export function getActiveReminders(registry: TaskRegistry): Task[] {
  const today = todayStr();
  return registry.filter(t =>
    !t.is_deleted &&
    t.status_completion === "open" &&
    t.date_remind !== null &&
    t.date_remind <= today
  );
}

export { generateId, REGISTRY_PATH };
