import type { CalendarHttp } from "./oauth-token";

/** Phase 0 spike: not connected to plugin lifecycle or account setup. */
export interface CalendarIntent {
  integrationId: string;
  itemId: string;
  /** Unique per committed calendar-relevant mutation, including cancellation. */
  mutationId: string;
  /** Captured with the authoritative mutation, never inferred from current metadata. */
  predecessorId: string | null;
  active: boolean;
  title: string;
  start: string;
  end: string;
  timeZone: string;
}

export type CalendarResult =
  | { status: "published" | "cancelled"; eventId: string; etag: string }
  | { status: "conflict" | "missed" | "pending"; reason: string };

/** Atomically consume a durable never-attempted creation permit before the POST.
 * Missing/lost evidence must return false. A synced mapping is not a permit.
 * Provisioning this guard is part of the still-pending production protocol.
 */
export type CalendarCreationGuard = (intent: Readonly<CalendarIntent>) => Promise<boolean>;

interface EventPayload {
  summary: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  transparency: "opaque" | "transparent";
  reminders: { useDefault: false; overrides: { method: "popup"; minutes: number }[] };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function digest(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function calendarEventId(integrationId: string, itemId: string): Promise<string> {
  if (!integrationId || !itemId) throw new Error("Calendar identity is required");
  // Hex is a subset of Google's base32hex alphabet. No raw vault/item names in IDs.
  return `mos${await digest(JSON.stringify([integrationId, itemId]))}`;
}

function validate(intent: CalendarIntent): void {
  for (const value of [intent.integrationId, intent.itemId, intent.mutationId, intent.timeZone]) {
    if (typeof value !== "string" || !value || value.length > 512) throw new Error("Invalid calendar intent identity");
  }
  if (intent.predecessorId !== null && (typeof intent.predecessorId !== "string" || !intent.predecessorId || intent.predecessorId === intent.mutationId)) {
    throw new Error("Invalid calendar predecessor");
  }
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  const validTime = (value: string) => {
    const match = timestamp.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
  };
  if (!validTime(intent.start) || !validTime(intent.end) || Date.parse(intent.end) <= Date.parse(intent.start)) throw new Error("Invalid calendar time range");
  if (typeof intent.title !== "string" || !intent.title.trim() || typeof intent.active !== "boolean") throw new Error("Invalid calendar payload");
  try { new Intl.DateTimeFormat("en", { timeZone: intent.timeZone }); }
  catch { throw new Error("Invalid calendar time zone"); }
}

function payload(intent: CalendarIntent): EventPayload {
  return {
    summary: intent.active ? intent.title : "Morning OS: reminder cleared",
    start: { dateTime: intent.start, timeZone: intent.timeZone },
    end: { dateTime: intent.end, timeZone: intent.timeZone },
    transparency: intent.active ? "opaque" : "transparent",
    reminders: { useDefault: false, overrides: intent.active ? [{ method: "popup", minutes: 0 }] : [] },
  };
}

/** Compare actual provider fields as well as markers; a marker alone cannot hide drift. */
function canonicalPayload(value: unknown): string | null {
  if (!record(value) || typeof value.summary !== "string" || !record(value.start) || !record(value.end) ||
      typeof value.start.dateTime !== "string" || typeof value.end.dateTime !== "string" ||
      typeof value.start.timeZone !== "string" || typeof value.end.timeZone !== "string" ||
      !record(value.reminders) || value.reminders.useDefault !== false ||
      (Array.isArray(value.attendees) && value.attendees.length > 0) || value.recurrence !== undefined || value.recurringEventId !== undefined) return null;
  const overrides = value.reminders.overrides ?? [];
  if (!Array.isArray(overrides) || overrides.some(entry => !record(entry) || entry.method !== "popup" || entry.minutes !== 0)) return null;
  const start = Date.parse(value.start.dateTime);
  const end = Date.parse(value.end.dateTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return JSON.stringify([value.summary, start, value.start.timeZone, end, value.end.timeZone,
    value.transparency ?? "opaque", overrides.map(entry => [entry.method, entry.minutes])]);
}

export class GoogleCalendarAdapter {
  constructor(
    private readonly calendarId: string,
    private readonly http: CalendarHttp,
    private readonly accessToken: () => Promise<string>,
    private readonly now: () => number = Date.now,
    private readonly creationGuard?: CalendarCreationGuard,
  ) {
    if (!calendarId || calendarId === "primary") throw new Error("Select a dedicated calendar ID");
  }

  async reconcile(intent: CalendarIntent): Promise<CalendarResult> {
    intent = { ...intent }; // A caller cannot mutate queued work during provider awaits.
    validate(intent);
    const eventId = await calendarEventId(intent.integrationId, intent.itemId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`;
    const desired = payload(intent);
    const fingerprint = await digest(canonicalPayload(desired)!);
    const properties = {
      mosProducer: "morning-os", mosVersion: "1", mosIntegration: intent.integrationId,
      mosItem: intent.itemId, mosMutation: intent.mutationId, mosFingerprint: fingerprint,
      mosActive: intent.active ? "1" : "0",
    };
    const request = async (method: string, endpoint: string, body?: unknown, etag?: string) => {
      const token = await this.accessToken();
      try {
        return await this.http({ url: endpoint, method, headers: {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}),
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      } catch { throw new Error("Calendar request failed; retry after checking connection"); }
    };
    const confirm = async (value: unknown): Promise<CalendarResult | null> => {
      if (!record(value) || value.id !== eventId || typeof value.etag !== "string" || !value.etag ||
          value.status === "cancelled" || !record(value.extendedProperties) || !record(value.extendedProperties.private)) return null;
      const remote = value.extendedProperties.private;
      for (const [key, expected] of Object.entries(properties)) if (remote[key] !== expected) return null;
      const actual = canonicalPayload(value);
      if (actual === null || await digest(actual) !== fingerprint) return null;
      return { status: intent.active ? "published" : "cancelled", eventId, etag: value.etag };
    };
    let remote = await request("GET", `${url}/${eventId}`);
    if (remote.status === 404) {
      if (intent.active && intent.predecessorId !== null) return { status: "conflict", reason: "Previous event is missing; publication paused" };
      if (intent.active && Date.parse(intent.start) <= this.now()) return { status: "missed", reason: "Received too late" };
      if (intent.active && !await this.creationGuard?.(intent)) return { status: "conflict", reason: "No durable first-publication permit; automatic creation paused" };
      // A clear may safely establish a non-alerting fence even when A was never sent.
      const created = await request("POST", url, { id: eventId, ...desired, extendedProperties: { private: properties } });
      if (created.status === 409) {
        remote = await request("GET", `${url}/${eventId}`);
        if (remote.status !== 200) return { status: "pending", reason: "Concurrent creation needs confirmation" };
        // Continue causal checks: clear C can cancel a concurrent A that won insert.
      } else {
        if (created.status !== 200 && created.status !== 201) throw new Error(`Calendar creation failed (${created.status})`);
        return await confirm(created.body) ?? { status: "pending", reason: "Provider confirmation differs; retry lookup" };
      }
    }
    if (remote.status === 410) return { status: "conflict", reason: "Remote event was deleted; publication paused" };
    if (remote.status !== 200) throw new Error(`Calendar lookup failed (${remote.status})`);
    const confirmed = await confirm(remote.body);
    if (confirmed) return confirmed; // No write: restarting or snoozing cannot re-arm.
    const value = remote.body;
    if (!record(value) || value.id !== eventId || value.status === "cancelled" || typeof value.etag !== "string" || !value.etag ||
        !record(value.extendedProperties) || !record(value.extendedProperties.private)) return { status: "conflict", reason: "Unrecognized or deleted remote event" };
    const owned = value.extendedProperties.private;
    if (owned.mosProducer !== "morning-os" || owned.mosVersion !== "1" || owned.mosIntegration !== intent.integrationId ||
        owned.mosItem !== intent.itemId) return { status: "conflict", reason: "Remote event ownership differs" };
    const actual = canonicalPayload(value);
    if (actual === null || await digest(actual) !== owned.mosFingerprint) return { status: "conflict", reason: "Remote schedule was edited outside Morning OS" };
    if (intent.predecessorId === null || owned.mosMutation !== intent.predecessorId) return { status: "conflict", reason: "Remote mutation differs from committed predecessor; sync or resolve conflict" };
    if (intent.active && Date.parse(intent.start) <= this.now()) return { status: "missed", reason: "Replacement received too late" };
    // Retain a non-alerting event on clear: deleting it would erase the stale-device fence.
    const updated = await request("PATCH", `${url}/${eventId}`, {
      ...desired, extendedProperties: { private: { ...owned, ...properties } },
    }, value.etag);
    if (updated.status === 412) return { status: "conflict", reason: "Remote event changed during publication" };
    if (updated.status === 404 || updated.status === 410) return { status: "conflict", reason: "Remote event disappeared during publication" };
    if (updated.status !== 200) throw new Error(`Calendar update failed (${updated.status})`);
    return await confirm(updated.body) ?? { status: "pending", reason: "Provider confirmation differs; retry lookup" };
  }
}
