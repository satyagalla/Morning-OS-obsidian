import { App } from "obsidian";
import type { AreaConfig, CalendarReminderHistory, CalendarReminderMutation, TabConfig, Task, TaskRegistry, CompletionStatus, TodayPriority, ItemKind, NoteStatus, MetadataValue } from "./types";
import { todayStr } from "./utils";
import { getStateStore, LEGACY_REGISTRY_PATH, STATE_PATH } from "./data/state-store";
import { cloneItemDraft, forceDraftFields, mergeDraftTags, reconcileItemDraft, type DraftConflict, type DraftConflictChoice, type ItemDraft } from "./data/draft-reconciliation";

const REGISTRY_PATH = STATE_PATH;
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

export type DraftSaveResult =
  | { status: "saved" }
  | { status: "conflict"; conflicts: DraftConflict[] }
  | { status: "deleted" };

async function stateUpdate(app: App, operation: string, mutator: (state: import("./data/schemas").MorningState) => void): Promise<void> {
  await getStateStore(app).update(mutator, operation);
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function loadRegistry(app: App): Promise<TaskRegistry> {
  const state = await getStateStore(app).read();
  return JSON.parse(JSON.stringify(state.items)) as TaskRegistry;
}

export async function initializeRegistryState(app: App): Promise<{ migrated: boolean; itemCount: number }> {
  return getStateStore(app).initialize();
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

  // The legacy file is immutable after a successful state migration.
  if (await app.vault.adapter.exists(STATE_PATH)) return result;
  if (!(await app.vault.adapter.exists(LEGACY_REGISTRY_PATH))) return result;

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
    tags:              (t.tags ?? {}) as Record<string, MetadataValue>,
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
    kind:               (t.kind === "note" ? "note" : "task") as ItemKind,
    status_note:        t.kind === "note" && t.status_note === "archived" ? "archived" : (t.kind === "note" ? "active" : undefined),
  };
}

function migrateCompletion(t: Record<string, unknown>): CompletionStatus {
  if (t.status_completion) return t.status_completion as CompletionStatus;
  if (t.done === true) return "done";
  return "open";
}

export async function saveRegistry(app: App, registry: TaskRegistry): Promise<void> {
  await getStateStore(app).replaceItems(registry);
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
    areas: opts.areas !== undefined ? [...opts.areas] : [...parsed.areas],
    tags: opts.tags !== undefined ? cloneMetadata(opts.tags) : parsed.tags,
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
    kind: "task",
  };
}

export function createNote(rawText: string, opts: Partial<Pick<Task, "areas" | "tags" | "is_today" | "parent_id">> = {}): Task {
  const item = createTask(rawText, opts);
  item.kind = "note";
  item.status_note = "active";
  return item;
}

/**
 * A child receives a snapshot of the parent's placement/custom metadata at
 * creation time. It never remains linked to those values afterwards.
 */
export function createChildItem(rawText: string, parent: Task, kind: ItemKind = "task"): Task {
  const options = {
    parent_id: parent._id,
    areas: cloneMetadata(parent.areas),
    tags: cloneMetadata(parent.tags),
  };
  return kind === "note" ? createNote(rawText, options) : createTask(rawText, options);
}

function cloneMetadata<T extends MetadataValue | MetadataValue[] | Record<string, MetadataValue>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function changeItemKind(app: App, id: string, kind: ItemKind): Promise<void> {
  await stateUpdate(app, kind === "note" ? "convert-to-note" : "convert-to-task", state => {
    const item = state.items.find(candidate => candidate._id === id);
    if (!item || item.kind === kind) return;
    if (kind === "note") {
      item.status_note = item.status_completion === "open" ? "active" : "archived";
    } else {
      item.status_completion = item.status_note === "active" ? "open" : "done";
      if (item.status_completion === "open") item.date_completed = null;
      item.status_note = undefined;
    }
    item.kind = kind;
    if (!calendarReminderActive(item)) appendCalendarMutation(item);
    item.date_modified = todayStr();
  });
}

export async function setNoteStatus(app: App, id: string, status: NoteStatus): Promise<void> {
  await stateUpdate(app, status === "archived" ? "archive-note" : "unarchive-note", state => {
    const item = state.items.find(candidate => candidate._id === id);
    if (!item || item.kind !== "note" || item.status_note === status) return;
    item.status_note = status;
    // Keep the legacy status field coherent for existing projections and exports.
    item.status_completion = status === "archived" ? "done" : "open";
    item.date_completed = status === "archived" ? todayStr() : null;
    if (status === "archived") appendCalendarMutation(item);
    item.date_modified = todayStr();
  });
}

export function getChildren(registry: TaskRegistry, parentId: string): Task[] {
  return registry.filter(t => t.parent_id === parentId && !t.is_deleted);
}

export function hasOpenChildren(registry: TaskRegistry, parentId: string): boolean {
  return getChildren(registry, parentId).some(t => t.kind === "note" ? t.status_note !== "archived" : t.status_completion === "open");
}

/** Attach an ungrouped item to a root parent. One nesting level is enforced here,
 * rather than relying on callers to manipulate parent_id safely. */
export async function attachItemToParent(app: App, childId: string, parentId: string): Promise<void> {
  await stateUpdate(app, "group-item", state => {
    const child = state.items.find(item => item._id === childId);
    const parent = state.items.find(item => item._id === parentId);
    if (!child || !parent) throw new Error("item or parent was not found");
    if (child.parent_id === parentId) return;
    if (child._id === parent._id) throw new Error("an item cannot be its own parent");
    if (child.parent_id !== null) throw new Error("only root items can be attached");
    if (parent.parent_id !== null) throw new Error("a child cannot have children");
    if (child.is_deleted || parent.is_deleted) throw new Error("deleted items cannot be grouped");
    child.parent_id = parentId;
    child.date_modified = todayStr();
  });
}

/** Detaching retains all materialized values already stored on the child. */
export async function detachItemFromParent(app: App, id: string): Promise<void> {
  await stateUpdate(app, "ungroup-item", state => {
    const item = state.items.find(candidate => candidate._id === id);
    if (!item || item.parent_id === null) return;
    item.parent_id = null;
    item.date_modified = todayStr();
  });
}


function applyReminderDateChange(item: Task, patch: Partial<Task>): void {
  if (!("date_remind" in patch) || item.date_remind === patch.date_remind) return;
  item.date_remind = patch.date_remind ?? null;
  item.reminder_occurrence = item.date_remind ? { token: generateId() } : null;
}

function calendarReminderActive(item: Task): boolean {
  return !item.is_deleted && item.date_remind !== null && item.status_completion === "open" &&
    (item.kind !== "note" || item.status_note === "active");
}

function appendCalendarMutation(item: Task): void {
  const history = item.calendar_reminder;
  if (!history) return;
  const previous = history.mutations[history.mutations.length - 1];
  const active = calendarReminderActive(item);
  const next: CalendarReminderMutation = {
    id: generateId(),
    predecessorId: previous?.id ?? null,
    active,
    title: item.text,
    date: active ? item.date_remind : null,
    time: previous.time,
    timeZone: previous.timeZone,
  };
  if (previous && previous.active === next.active && previous.title === next.title && previous.date === next.date &&
    previous.time === next.time && previous.timeZone === next.timeZone) return;
  history.mutations.push(next);
}

/** Enroll an existing item only after explicit calendar setup. Legacy reminders
 * receive one durable starting identity; no notification acknowledgement is changed. */
export async function enrollCalendarReminder(app: App, id: string, time: string, timeZone: string): Promise<void> {
  await stateUpdate(app, "enroll-calendar-reminder", state => {
    const item = state.items.find(candidate => candidate._id === id);
    if (!item || item.calendar_reminder) return;
    const active = calendarReminderActive(item);
    const mutation: CalendarReminderMutation = {
      id: `legacy-${item._id}-${item.reminder_occurrence?.token ?? item.date_remind ?? "none"}`,
      predecessorId: null,
      active,
      title: item.text,
      date: active ? item.date_remind : null,
      time,
      timeZone,
    };
    const history: CalendarReminderHistory = { version: 1, mutations: [mutation] };
    item.calendar_reminder = history;
    item.date_modified = todayStr();
  });
}

export async function updateTask(app: App, id: string, patch: Partial<Task>): Promise<void> {
  await stateUpdate(app, "edit-item", state => {
    const item = state.items.find(task => task._id === id);
    if (!item) return;
    const changed = Object.keys(patch).some(field => {
      const key = field as keyof Task;
      return JSON.stringify(item[key]) !== JSON.stringify(patch[key]);
    });
    if (!changed) return;
    const { date_remind: _dateRemind, ...otherPatch } = patch;
    Object.assign(item, otherPatch);
    applyReminderDateChange(item, patch);
    if ("text" in patch || "date_remind" in patch || "status_completion" in patch || "status_note" in patch || "is_deleted" in patch) {
      appendCalendarMutation(item);
    }
    item.date_modified = todayStr();
  });
}

/** Applies only fields changed by an editor since it opened. Unrelated external
 * changes remain in place; conflicting fields require an explicit UI choice. */
export async function saveItemDraft(app: App, base: ItemDraft, draft: ItemDraft, forceFields: readonly DraftConflictChoice[] = []): Promise<DraftSaveResult> {
  let outcome: DraftSaveResult = { status: "saved" };
  await getStateStore(app).update(state => {
    const item = state.items.find(candidate => candidate._id === base._id);
    if (!item || item.is_deleted) {
      outcome = { status: "deleted" };
      return;
    }
    const reconciliation = reconcileItemDraft(base, draft, item);
    const authorized = reconciliation.conflicts.filter(conflict => forceFields.some(choice =>
      typeof choice === "object"
        ? choice.field === conflict.field && choice.key === conflict.key
        : choice === conflict.field && (choice !== "tags" || conflict.key === undefined),
    ));
    const unresolved = reconciliation.conflicts.filter(conflict => !authorized.includes(conflict));
    if (unresolved.length) {
      outcome = { status: "conflict", conflicts: unresolved };
      return;
    }
    const forced = forceFields.length ? forceDraftFields(base, draft, item, forceFields) : {};
    const patch = { ...reconciliation.patch, ...forced };
    // Do this only after rejecting every unresolved conflict.  A single merge
    // avoids later conflict choices replacing independently edited tag keys.
    if ("tags" in reconciliation.patch || "tags" in forced) {
      patch.tags = mergeDraftTags(base, draft, item);
    }
    if (Object.keys(patch).length === 0) return;
    const { date_remind: _dateRemind, ...otherPatch } = patch;
    Object.assign(item, otherPatch);
    applyReminderDateChange(item, patch);
    if ("text" in patch || "date_remind" in patch || "status_completion" in patch || "status_note" in patch || "is_deleted" in patch) {
      appendCalendarMutation(item);
    }
    item.date_modified = todayStr();
  }, "edit item");
  return outcome;
}

export { cloneItemDraft };

export async function setTaskStatus(app: App, id: string, status: CompletionStatus): Promise<void> {
  await stateUpdate(app, status === "done" ? "complete-task" : "reopen-task", state => {
    const item = state.items.find(candidate => candidate._id === id);
    if (!item || item.kind === "note" || item.status_completion === status) return;
    item.status_completion = status;
    item.date_completed = status === "done" ? todayStr() : null;
    if (status !== "open") appendCalendarMutation(item);
    item.date_modified = todayStr();
  });
}

export async function moveTaskToToday(app: App, id: string, priority: TodayPriority): Promise<void> {
  await stateUpdate(app, "add-to-today", state => {
    const item = state.items.find(candidate => candidate._id === id);
    if (!item || (item.is_today && item.status_priority === priority)) return;
    item.is_today = true;
    item.status_priority = priority;
    item.date_modified = todayStr();
  });
}

export async function changeTodayPriority(app: App, id: string, priority: TodayPriority): Promise<void> {
  await stateUpdate(app, "change-today-priority", state => {
    const item = state.items.find(candidate => candidate._id === id);
    if (!item || !item.is_today || item.status_priority === priority) return;
    item.status_priority = priority;
    item.date_modified = todayStr();
  });
}

export async function removeTaskFromToday(app: App, id: string): Promise<void> {
  await stateUpdate(app, "remove-from-today", state => {
    const task = state.items.find(item => item._id === id);
    if (!task || !task.is_today) return;
    task.is_today = false;
    const occurrence = task.reminder_occurrence;
    if (occurrence && occurrence.handledToken === occurrence.token) {
      occurrence.dismissedToken = occurrence.token;
    }
    task.date_modified = todayStr();
  });
}

export async function setTaskReminder(app: App, id: string, date: string | null): Promise<void> {
  await stateUpdate(app, date === null ? "clear-reminder" : "set-reminder", state => {
    const task = state.items.find(item => item._id === id);
    if (!task || task.date_remind === date) return;
    applyReminderDateChange(task, { date_remind: date });
    appendCalendarMutation(task);
    task.date_modified = todayStr();
  });
}

export async function deleteTask(app: App, id: string): Promise<void> {
  await stateUpdate(app, "delete-group", state => {
    const root = state.items.find(task => task._id === id);
    if (!root || root.is_deleted) return;
    const batch = generateId();
    const affected = state.items.filter(task => !task.is_deleted && (task._id === id || task.parent_id === id));
    for (const task of affected) {
      task.is_deleted = true;
      task.is_today = false;
      task.deletion_batch_id = batch;
      appendCalendarMutation(task);
      task.date_modified = todayStr();
    }
    root.deleted_member_ids = affected.map(task => task._id);
  });
}

export async function restoreTask(app: App, id: string): Promise<void> {
  await stateUpdate(app, "restore-group", state => {
    const root = state.items.find(task => task._id === id);
    if (!root || !root.is_deleted) return;
    const batch = root.deletion_batch_id;
    if (!batch) throw new Error("deleted item has no recovery batch");
    for (const task of state.items) {
      if (task.deletion_batch_id === batch && (task._id === id || task.parent_id === id)) {
        task.is_deleted = false;
        task.date_modified = todayStr();
      }
    }
  });
}

/** Permanently remove a root and its current direct children. Callers must show a
 * confirmation/preview before invoking this irreversible operation. */
export async function purgeTask(app: App, id: string): Promise<number> {
  let purged = 0;
  await getStateStore(app).update(state => {
    const root = state.items.find(item => item._id === id);
    if (!root) return;
    const ids = new Set([id]);
    if (root.parent_id === null) {
      for (const child of state.items) if (child.parent_id === id) ids.add(child._id);
    }
    purged = ids.size;
    state.items = state.items.filter(item => !ids.has(item._id));
  }, "purge-group");
  return purged;
}

export async function clearNextDayTasks(app: App): Promise<void> {
  // Kept as a compatibility no-op. Today membership is persistent, not a dated schedule.
  void app;
}

export function getActiveReminders(registry: TaskRegistry): Task[] {
  const today = todayStr();
  return registry.filter(t =>
    !t.is_deleted &&
    t.status_completion === "open" &&
    (t.kind !== "note" || t.status_note === "active") &&
    t.date_remind !== null &&
    t.date_remind <= today &&
    t.reminder_occurrence?.handledToken !== t.reminder_occurrence?.token
  );
}

export async function promoteDueReminders(app: App): Promise<number> {
  let promoted = 0;
  await getStateStore(app).update(state => {
    const today = todayStr();
    for (const task of state.items) {
      if (task.is_deleted || task.status_completion !== "open" || (task.kind === "note" && task.status_note !== "active") || !task.date_remind || task.date_remind > today) continue;
      const occurrence = task.reminder_occurrence ?? { token: `legacy-${task._id}-${task.date_remind}` };
      task.reminder_occurrence = occurrence;
      if (occurrence.handledToken === occurrence.token || occurrence.dismissedToken === occurrence.token) continue;
      if (task.is_today) {
        occurrence.handledToken = occurrence.token;
        continue;
      }
      task.is_today = true;
      occurrence.handledToken = occurrence.token;
      task.date_modified = today;
      promoted++;
    }
  }, "promote-reminders");
  return promoted;
}

export { generateId, LEGACY_REGISTRY_PATH, REGISTRY_PATH };
