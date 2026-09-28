import type { App } from "obsidian";
import { getStateStore } from "../../data/state-store";
import type { CalendarDeliveryStatus, CalendarIntegrationState, CalendarMutationDelivery, CalendarReminderMutation, Task } from "../../types";

const MAX_HISTORY = 256;

function randomHex(bytes = 16): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return Boolean(value);
  } catch {
    return false;
  }
}

function active(item: Task): boolean {
  return !item.is_deleted && item.date_remind !== null && item.status_completion === "open" &&
    (item.kind !== "note" || item.status_note === "active");
}

function appendPolicyMutation(item: Task, time: string, timeZone: string): void {
  const history = item.calendar_reminder;
  if (!history || history.mutations.length >= MAX_HISTORY) return;
  const previous = history.mutations[history.mutations.length - 1];
  const next: CalendarReminderMutation = {
    id: randomHex(),
    predecessorId: previous.id,
    active: active(item),
    title: item.text,
    date: active(item) ? item.date_remind : null,
    time,
    timeZone,
  };
  if (previous.active === next.active && previous.title === next.title && previous.date === next.date &&
    previous.time === next.time && previous.timeZone === next.timeZone) return;
  history.mutations.push(next);
}

export function newCalendarIntegration(deviceId: string, defaultTime: string, timeZone: string): CalendarIntegrationState {
  if (!deviceId || !validTime(defaultTime) || !validTimeZone(timeZone)) throw new Error("Invalid calendar setup policy");
  return {
    version: 1,
    protocolVersion: 1,
    provider: "google",
    integrationId: randomHex(),
    ownershipToken: randomHex(),
    publisherDeviceId: deviceId,
    enabled: false,
    defaultTime,
    timeZone,
    calendar: { status: "unconfigured", confirmed: false },
  };
}

export async function initializeCalendarIntegration(app: App, deviceId: string, defaultTime: string, timeZone: string): Promise<void> {
  await getStateStore(app).update(state => {
    if (state.calendar) return;
    state.calendar = newCalendarIntegration(deviceId, defaultTime, timeZone);
  }, "initialize-calendar-integration");
}

export async function selectCalendarPublisher(app: App, deviceId: string): Promise<void> {
  await getStateStore(app).update(state => {
    if (!state.calendar) throw new Error("Calendar integration is not initialized");
    state.calendar.enabled = false;
    state.calendar.publisherDeviceId = deviceId;
  }, "select-calendar-publisher");
}

export async function setCalendarEnabled(app: App, enabled: boolean): Promise<void> {
  await getStateStore(app).update(state => {
    if (!state.calendar) throw new Error("Calendar integration is not initialized");
    if (enabled && (state.calendar.calendar.status !== "ready" || !state.calendar.calendar.confirmed)) {
      throw new Error("Confirm the dedicated test calendar before enabling publishing");
    }
    state.calendar.enabled = enabled;
  }, enabled ? "enable-calendar-publishing" : "disable-calendar-publishing");
}

export async function updateCalendarDefaults(app: App, defaultTime: string, timeZone: string): Promise<void> {
  if (!validTime(defaultTime) || !validTimeZone(timeZone)) throw new Error("Invalid calendar time policy");
  await getStateStore(app).update(state => {
    const integration = state.calendar;
    if (!integration) throw new Error("Calendar integration is not initialized");
    if (integration.defaultTime === defaultTime && integration.timeZone === timeZone) return;
    integration.defaultTime = defaultTime;
    integration.timeZone = timeZone;
    for (const item of state.items) {
      if (!item.calendar_reminder) continue;
      const latest = item.calendar_reminder.mutations[item.calendar_reminder.mutations.length - 1];
      const time = item.reminder_time ?? defaultTime;
      const zone = item.reminder_time_zone ?? timeZone;
      if (latest.time !== time || latest.timeZone !== zone) appendPolicyMutation(item, time, zone);
    }
  }, "update-calendar-time-policy");
}

export async function enrollExistingCalendarReminders(app: App): Promise<number> {
  let enrolled = 0;
  await getStateStore(app).update(state => {
    const integration = state.calendar;
    if (!integration) throw new Error("Calendar integration is not initialized");
    for (const item of state.items) {
      if (item.calendar_reminder || !active(item)) continue;
      const mutation: CalendarReminderMutation = {
        id: `legacy-${item._id}-${item.reminder_occurrence?.token ?? item.date_remind ?? "none"}`,
        predecessorId: null,
        active: true,
        title: item.text,
        date: item.date_remind,
        time: item.reminder_time ?? integration.defaultTime,
        timeZone: item.reminder_time_zone ?? integration.timeZone,
      };
      item.calendar_reminder = { version: 1, providerAttempted: false, mutations: [mutation] };
      enrolled++;
    }
  }, "enroll-existing-calendar-reminders");
  return enrolled;
}

export async function cancelOwnedCalendarReminders(app: App): Promise<number> {
  let cancelled = 0;
  await getStateStore(app).update(state => {
    for (const item of state.items) {
      const history = item.calendar_reminder;
      if (!history) continue;
      const previous = history.mutations[history.mutations.length - 1];
      if (!previous.active || history.mutations.length >= MAX_HISTORY) continue;
      history.mutations.push({
        id: randomHex(),
        predecessorId: previous.id,
        active: false,
        title: item.text,
        date: null,
        time: previous.time,
        timeZone: previous.timeZone,
      });
      cancelled++;
    }
  }, "cancel-owned-calendar-reminders");
  return cancelled;
}

export async function beginCalendarCreation(app: App): Promise<{ attemptId: string; integration: CalendarIntegrationState }> {
  let result: { attemptId: string; integration: CalendarIntegrationState } | null = null;
  const state = await getStateStore(app).update(candidate => {
    const integration = candidate.calendar;
    if (!integration) throw new Error("Calendar integration is not initialized");
    if (integration.calendar.status === "ready") throw new Error("A dedicated calendar is already configured");
    if (integration.calendar.status === "creating" || integration.calendar.status === "unknown") {
      throw new Error("Calendar creation needs recovery; do not create another calendar");
    }
    const attemptId = randomHex();
    integration.calendar = { status: "creating", attemptId, confirmed: false };
    result = { attemptId, integration: JSON.parse(JSON.stringify(integration)) as CalendarIntegrationState };
  }, "begin-calendar-creation");
  if (!result) throw new Error(`Calendar creation was not persisted at revision ${state.revision}`);
  return result;
}

export async function recordCalendarCreationUnknown(app: App, attemptId: string, reason: string): Promise<void> {
  await getStateStore(app).update(state => {
    const calendar = state.calendar?.calendar;
    if (!calendar || calendar.status !== "creating" || calendar.attemptId !== attemptId) return;
    calendar.status = "unknown";
    calendar.reason = reason;
  }, "calendar-creation-unknown");
}

export async function confirmDedicatedCalendar(app: App, attemptId: string, id: string, summary: string): Promise<void> {
  if (!id || id === "primary") throw new Error("A dedicated calendar ID is required");
  await getStateStore(app).update(state => {
    const calendar = state.calendar?.calendar;
    if (!calendar || calendar.attemptId !== attemptId || (calendar.status !== "creating" && calendar.status !== "unknown")) {
      throw new Error("Calendar creation evidence no longer matches");
    }
    state.calendar!.calendar = { status: "ready", attemptId, id, summary, confirmed: true };
  }, "confirm-dedicated-calendar");
}

export async function markProviderAttempt(app: App, deviceId: string, itemId: string, mutationId: string,
  expectedHeadId: string): Promise<boolean> {
  let permitted = false;
  await getStateStore(app).update(state => {
    const integration = state.calendar;
    const item = state.items.find(candidate => candidate._id === itemId);
    const history = item?.calendar_reminder;
    const latest = history?.mutations[history.mutations.length - 1];
    if (!integration?.enabled || integration.publisherDeviceId !== deviceId || integration.calendar.status !== "ready" ||
      !history || latest?.id !== expectedHeadId || !history.mutations.some(mutation => mutation.id === mutationId) ||
      history.providerAttempted) return;
    history.providerAttempted = true;
    permitted = true;
  }, "calendar-provider-attempt");
  return permitted;
}

export async function recordCalendarDelivery(app: App, deviceId: string, itemId: string, mutationId: string,
  status: CalendarDeliveryStatus, attempts: number, detail: Omit<CalendarMutationDelivery, "status" | "attempts" | "updatedAt"> = {}): Promise<boolean> {
  let recorded = false;
  await getStateStore(app).update(state => {
    if (state.calendar?.publisherDeviceId !== deviceId) return;
    const mutation = state.items.find(item => item._id === itemId)?.calendar_reminder?.mutations.find(entry => entry.id === mutationId);
    if (!mutation) return;
    mutation.delivery = { status, attempts, updatedAt: String(Date.now()), ...detail };
    recorded = true;
  }, "calendar-delivery-evidence");
  return recorded;
}

export async function markCalendarConflict(app: App, reason: string): Promise<void> {
  await getStateStore(app).update(state => {
    if (!state.calendar) return;
    state.calendar.enabled = false;
    state.calendar.calendar.status = "conflict";
    state.calendar.calendar.confirmed = false;
    state.calendar.calendar.reason = reason;
  }, "calendar-integration-conflict");
}
