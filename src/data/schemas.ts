import type { CalendarIntegrationState, CalendarReminderHistory, CalendarReminderMutation, Task, TaskRegistry } from "../types";

export const STATE_SCHEMA_VERSION = 3;

export interface StateMigrationProvenance {
  source: "legacy-tasks" | "state";
  migratedAt: string;
  legacyPath?: string;
}

export interface MorningState {
  schemaVersion: number;
  revision: number;
  writtenAt: string;
  migration?: StateMigrationProvenance;
  items: TaskRegistry;
  /** Structural configuration is introduced gradually; unknown data remains intact. */
  definitions?: Record<string, unknown>;
  /** Syncable protocol policy/evidence only. Credentials remain device-local. */
  calendar?: CalendarIntegrationState;
}

export class StateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(year, month - 1, day);
  return candidate.getFullYear() === year && candidate.getMonth() === month - 1 && candidate.getDate() === day;
}

function isMetadataValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isMetadataValue);
  return isRecord(value) && Object.values(value).every(isMetadataValue);
}

function isTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour <= 23 && minute <= 59;
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validateCalendarReminder(value: unknown, taskId: string): asserts value is CalendarReminderHistory {
  if (value === null || value === undefined) return;
  if (!isRecord(value) || value.version !== 1 || typeof value.providerAttempted !== "boolean" ||
    !Array.isArray(value.mutations) || value.mutations.length === 0) {
    throw new StateValidationError(`item ${taskId} has invalid calendar reminder history`);
  }
  const mutations = value.mutations as CalendarReminderMutation[];
  const ids = new Set<string>();
  let predecessor: string | null = null;
  for (const mutation of mutations) {
    if (!isRecord(mutation) || typeof mutation.id !== "string" || !mutation.id || ids.has(mutation.id) ||
      mutation.predecessorId !== predecessor || typeof mutation.active !== "boolean" ||
      typeof mutation.title !== "string" || !mutation.title.trim() ||
      (mutation.date !== null && !isDate(mutation.date)) || !isTime(mutation.time) || !isTimeZone(mutation.timeZone)) {
      throw new StateValidationError(`item ${taskId} has invalid calendar reminder mutation`);
    }
    if (mutation.delivery !== undefined) {
      const delivery = mutation.delivery;
      const statuses = ["dispatching", "confirmed", "conflict", "missed", "retryable", "unknown", "auth-required", "permission-denied"];
      if (!isRecord(delivery) || !statuses.includes(delivery.status as string) ||
        !Number.isInteger(delivery.attempts) || (delivery.attempts as number) < 1 ||
        typeof delivery.updatedAt !== "string" || !delivery.updatedAt ||
        (delivery.reason !== undefined && typeof delivery.reason !== "string") ||
        (delivery.eventId !== undefined && typeof delivery.eventId !== "string") ||
        (delivery.etag !== undefined && typeof delivery.etag !== "string") ||
        (delivery.retryAt !== undefined && typeof delivery.retryAt !== "string")) {
        throw new StateValidationError(`item ${taskId} has invalid calendar delivery evidence`);
      }
    }
    if (mutation.active !== (mutation.date !== null)) {
      throw new StateValidationError(`item ${taskId} has calendar reminder activity/date mismatch`);
    }
    ids.add(mutation.id);
    predecessor = mutation.id;
  }
}

function validateCalendarIntegration(value: unknown): asserts value is CalendarIntegrationState {
  if (value === undefined) return;
  if (!isRecord(value) || value.version !== 1 || value.protocolVersion !== 1 || value.provider !== "google" ||
    typeof value.integrationId !== "string" || !value.integrationId ||
    typeof value.ownershipToken !== "string" || !value.ownershipToken ||
    typeof value.publisherDeviceId !== "string" || !value.publisherDeviceId ||
    typeof value.enabled !== "boolean" || !isTime(value.defaultTime) || !isTimeZone(value.timeZone) ||
    !isRecord(value.calendar)) {
    throw new StateValidationError("state has invalid calendar integration policy");
  }
  const calendar = value.calendar;
  if (!["unconfigured", "creating", "unknown", "ready", "conflict"].includes(calendar.status as string) ||
    typeof calendar.confirmed !== "boolean" ||
    (calendar.attemptId !== undefined && typeof calendar.attemptId !== "string") ||
    (calendar.id !== undefined && typeof calendar.id !== "string") ||
    (calendar.summary !== undefined && typeof calendar.summary !== "string") ||
    (calendar.reason !== undefined && typeof calendar.reason !== "string")) {
    throw new StateValidationError("state has invalid calendar enrollment evidence");
  }
  if (calendar.status === "ready" && (!calendar.confirmed || !calendar.id || calendar.id === "primary")) {
    throw new StateValidationError("state calendar is not a confirmed dedicated calendar");
  }
  if (calendar.confirmed && calendar.status !== "ready") {
    throw new StateValidationError("state calendar confirmation is inconsistent");
  }
}

function validateTask(task: unknown, ids: Set<string>): asserts task is Task {
  if (!isRecord(task)) throw new StateValidationError("an item is not an object");
  if (typeof task._id !== "string" || !task._id) throw new StateValidationError("an item has no stable ID");
  if (ids.has(task._id)) throw new StateValidationError(`duplicate item ID: ${task._id}`);
  ids.add(task._id);
  if (typeof task.text !== "string" || typeof task.notes !== "string") throw new StateValidationError(`item ${task._id} has invalid text or details`);
  if (!Array.isArray(task.areas) || !task.areas.every(area => typeof area === "string")) throw new StateValidationError(`item ${task._id} has invalid areas`);
  if (!isRecord(task.tags) || !Object.values(task.tags).every(isMetadataValue)) throw new StateValidationError(`item ${task._id} has invalid custom fields`);
  if (!["open", "done", "dismissed"].includes(task.status_completion as string)) throw new StateValidationError(`item ${task._id} has invalid lifecycle`);
  if (!["red", "regular"].includes(task.status_priority as string)) throw new StateValidationError(`item ${task._id} has invalid Today priority`);
  if (typeof task.is_today !== "boolean" || typeof task.is_deleted !== "boolean") throw new StateValidationError(`item ${task._id} has invalid membership or deletion state`);
  if (!isDate(task.date_created) || !isDate(task.date_modified)) throw new StateValidationError(`item ${task._id} has invalid dates`);
  if (task.date_completed !== null && !isDate(task.date_completed)) throw new StateValidationError(`item ${task._id} has invalid completion date`);
  if (task.date_remind !== null && !isDate(task.date_remind)) throw new StateValidationError(`item ${task._id} has invalid reminder date`);
  if (task.reminder_time !== undefined && task.reminder_time !== null && !isTime(task.reminder_time)) {
    throw new StateValidationError(`item ${task._id} has invalid reminder time`);
  }
  if (task.reminder_time_zone !== undefined && task.reminder_time_zone !== null && !isTimeZone(task.reminder_time_zone)) {
    throw new StateValidationError(`item ${task._id} has invalid reminder time zone`);
  }
  if (task.parent_id !== null && typeof task.parent_id !== "string") throw new StateValidationError(`item ${task._id} has invalid parent`);
  if (task.kind !== "task" && task.kind !== "note") throw new StateValidationError(`item ${task._id} has invalid kind`);
  if (task.status_note !== undefined && task.status_note !== "active" && task.status_note !== "archived") throw new StateValidationError(`item ${task._id} has invalid note lifecycle`);
  if (task.kind === "note" && task.status_note === undefined) throw new StateValidationError(`note ${task._id} has no lifecycle`);
  if (task.kind === "task" && task.status_note !== undefined) throw new StateValidationError(`task ${task._id} has a note lifecycle`);
  if (task.kind === "note" && task.status_note === "active" && task.status_completion !== "open") {
    throw new StateValidationError(`active note ${task._id} has an inactive task lifecycle`);
  }
  if (task.kind === "note" && task.status_note === "archived" && task.status_completion !== "done") {
    throw new StateValidationError(`archived note ${task._id} has an active task lifecycle`);
  }
  if (task.reminder_occurrence !== undefined && task.reminder_occurrence !== null) {
    if (!isRecord(task.reminder_occurrence) || typeof task.reminder_occurrence.token !== "string" || !task.reminder_occurrence.token ||
      (task.reminder_occurrence.handledToken !== undefined && typeof task.reminder_occurrence.handledToken !== "string") ||
      (task.reminder_occurrence.dismissedToken !== undefined && typeof task.reminder_occurrence.dismissedToken !== "string")) {
      throw new StateValidationError(`item ${task._id} has invalid reminder occurrence`);
    }
  }
  validateCalendarReminder(task.calendar_reminder, task._id);
  if (task.calendar_reminder) {
    const latest = task.calendar_reminder.mutations[task.calendar_reminder.mutations.length - 1];
    const active = !task.is_deleted && task.date_remind !== null && task.status_completion === "open" &&
      (task.kind !== "note" || task.status_note === "active");
    if ((!active && latest.active) || latest.title !== task.text ||
      (latest.active && latest.date !== task.date_remind) || (!latest.active && latest.date !== null)) {
      throw new StateValidationError(`item ${task._id} calendar history does not match authoritative state`);
    }
  }
  if (task.deletion_batch_id !== undefined && task.deletion_batch_id !== null && typeof task.deletion_batch_id !== "string") {
    throw new StateValidationError(`item ${task._id} has invalid deletion batch`);
  }
  if (task.deleted_member_ids !== undefined && (!Array.isArray(task.deleted_member_ids) || !task.deleted_member_ids.every(member => typeof member === "string"))) {
    throw new StateValidationError(`item ${task._id} has invalid deleted-member list`);
  }
}

function validateRelationships(items: TaskRegistry): void {
  const byId = new Map(items.map(item => [item._id, item]));
  for (const item of items) {
    if (!item.parent_id) continue;
    if (item.parent_id === item._id) throw new StateValidationError(`item ${item._id} is its own parent`);
    const parent = byId.get(item.parent_id);
    // Orphaned legacy links are retained; new operations must never make them.
    if (!parent) continue;
    if (parent.parent_id) throw new StateValidationError(`item ${item._id} would create a grandchild`);
    const seen = new Set<string>([item._id]);
    let cursor: Task | undefined = parent;
    while (cursor?.parent_id) {
      if (seen.has(cursor._id)) throw new StateValidationError(`parent cycle at ${item._id}`);
      seen.add(cursor._id);
      cursor = byId.get(cursor.parent_id);
    }
  }
}

export function validateState(value: unknown): asserts value is MorningState {
  if (!isRecord(value)) throw new StateValidationError("state is not an object");
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new StateValidationError(`unsupported state schema version: ${String(value.schemaVersion)}`);
  }
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) throw new StateValidationError("state has invalid revision");
  if (typeof value.writtenAt !== "string" || !value.writtenAt) throw new StateValidationError("state has no write timestamp");
  if (!Array.isArray(value.items)) throw new StateValidationError("state items is not an array");
  if (value.definitions !== undefined && !isRecord(value.definitions)) throw new StateValidationError("state definitions are not an object");
  validateCalendarIntegration(value.calendar);
  const ids = new Set<string>();
  value.items.forEach(item => validateTask(item, ids));
  validateRelationships(value.items as TaskRegistry);
}

export function cloneState(state: MorningState): MorningState {
  return JSON.parse(JSON.stringify(state)) as MorningState;
}
