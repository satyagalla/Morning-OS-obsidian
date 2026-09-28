import type { App } from "obsidian";
import { getStateStore } from "../../data/state-store";
import type { CalendarReminderMutation, Task } from "../../types";
import { CalendarPublishError, type CalendarClock, type CalendarPublisherStatus, type CalendarRuntimeDependencies } from "./contracts";
import { GoogleCalendarAdapter, type CalendarIntent } from "./google-adapter";
import { authenticatedCalendarHttp } from "./google-transport";
import { markProviderAttempt, recordCalendarDelivery } from "./calendar-state";
import { resolveReminderWindow } from "./time-policy";
import { RelayAuthError } from "./relay-auth";

const HIGH_WATER_KEY = "morning-os-calendar-high-water-v1";
const MAX_RETRY_MS = 60 * 60 * 1000;

interface HighWaterItem {
  mutationIds: string[];
  providerAttempted: boolean;
}

interface HighWaterJournal {
  version: 1;
  integrationId: string;
  calendarId: string;
  items: Record<string, HighWaterItem>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHighWater(value: unknown): HighWaterJournal | null {
  if (!record(value) || value.version !== 1 || typeof value.integrationId !== "string" ||
    typeof value.calendarId !== "string" || !record(value.items)) return null;
  const items: Record<string, HighWaterItem> = {};
  for (const [id, entry] of Object.entries(value.items)) {
    if (!record(entry) || typeof entry.providerAttempted !== "boolean" ||
      !Array.isArray(entry.mutationIds) || !entry.mutationIds.every(mutationId => typeof mutationId === "string" && mutationId)) return null;
    items[id] = { providerAttempted: entry.providerAttempted, mutationIds: [...entry.mutationIds] as string[] };
  }
  return { version: 1, integrationId: value.integrationId, calendarId: value.calendarId, items };
}

function defaultClock(): CalendarClock {
  return {
    now: Date.now,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: id => window.clearTimeout(id),
  };
}

function priorSchedule(mutations: readonly CalendarReminderMutation[], index: number): CalendarReminderMutation | null {
  for (let cursor = index; cursor >= 0; cursor--) if (mutations[cursor].date) return mutations[cursor];
  return null;
}

function retryDelay(attempts: number, random: () => number, explicit?: number): number {
  if (explicit !== undefined) return Math.min(MAX_RETRY_MS, Math.max(1000, explicit));
  const base = Math.min(MAX_RETRY_MS, 1000 * (2 ** Math.min(attempts, 10)));
  return Math.round(base * (0.75 + random() * 0.5));
}

export class CalendarPublisher {
  private readonly clock: CalendarClock;
  private readonly random: () => number;
  private queued = false;
  private running = false;
  private stopped = false;
  private timer: number | null = null;
  private generation = 0;
  private statusValue: CalendarPublisherStatus = { state: "disabled", message: "Experimental calendar publishing is disabled.", updatedAt: 0 };
  private readonly listeners = new Set<(status: CalendarPublisherStatus) => void>();

  constructor(private readonly app: App, private readonly deviceId: string, private readonly dependencies: CalendarRuntimeDependencies) {
    this.clock = dependencies.clock ?? defaultClock();
    this.random = dependencies.random ?? Math.random;
  }

  status(): CalendarPublisherStatus {
    return { ...this.statusValue };
  }

  onStatus(listener: (status: CalendarPublisherStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  queue(): void {
    if (this.stopped) return;
    this.queued = true;
    if (!this.running) void this.drain();
  }

  resume(): void {
    this.queue();
  }

  /** Explicit/test reconciliation entry point; normal lifecycle uses queue(). */
  async reconcileNow(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      await this.reconcile(this.generation);
    } catch (error) {
      console.error("Morning OS calendar reconciliation paused:", error);
      this.setStatus("conflict", (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.dependencies.tokenProvider.disconnect();
  }

  private setStatus(state: CalendarPublisherStatus["state"], message: string): void {
    this.statusValue = { state, message, updatedAt: this.clock.now() };
    for (const listener of this.listeners) listener(this.status());
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const generation = this.generation;
    try {
      while (this.queued && !this.stopped && generation === this.generation) {
        this.queued = false;
        await this.reconcile(generation);
      }
    } catch (error) {
      console.error("Morning OS calendar reconciliation paused:", error);
      this.setStatus("conflict", (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private loadJournal(integrationId: string, calendarId: string, items: readonly Task[]): HighWaterJournal {
    const raw: unknown = this.app.loadLocalStorage(HIGH_WATER_KEY);
    const journal = parseHighWater(raw);
    const hasEvidence = items.some(item => item.calendar_reminder?.providerAttempted ||
      item.calendar_reminder?.mutations.some(mutation => mutation.delivery !== undefined));
    if (!journal) {
      if (raw !== null && raw !== undefined) throw new Error("Calendar device journal is malformed; publishing paused.");
      if (hasEvidence) throw new Error("Calendar device journal is missing; reconnect or explicitly adopt this publisher device.");
      return { version: 1, integrationId, calendarId, items: {} };
    }
    if (journal.integrationId !== integrationId || journal.calendarId !== calendarId) {
      throw new Error("Calendar device journal belongs to another integration or calendar.");
    }
    for (const item of items) {
      const history = item.calendar_reminder;
      const high = journal.items[item._id];
      if (!high) continue;
      const ids = history?.mutations.map(mutation => mutation.id) ?? [];
      if (high.mutationIds.some((id, index) => ids[index] !== id) || (high.providerAttempted && !history?.providerAttempted)) {
        throw new Error(`Calendar history rolled back for item ${item._id}; publishing paused.`);
      }
    }
    return journal;
  }

  private saveJournal(journal: HighWaterJournal, item: Task): void {
    const history = item.calendar_reminder;
    if (!history) return;
    journal.items[item._id] = {
      mutationIds: history.mutations.map(mutation => mutation.id),
      providerAttempted: history.providerAttempted,
    };
    this.app.saveLocalStorage(HIGH_WATER_KEY, journal);
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.queue();
    }, Math.min(MAX_RETRY_MS, Math.max(1000, delayMs)));
  }

  private async reconcile(generation: number): Promise<void> {
    const state = await getStateStore(this.app).read();
    const integration = state.calendar;
    if (!integration?.enabled) {
      this.setStatus("disabled", "Experimental calendar publishing is disabled.");
      return;
    }
    if (integration.publisherDeviceId !== this.deviceId) {
      this.setStatus("disabled", "This device is not the selected calendar publisher.");
      return;
    }
    const calendar = integration.calendar;
    if (calendar.status !== "ready" || !calendar.confirmed || !calendar.id || calendar.id === "primary") {
      this.setStatus("conflict", "A confirmed dedicated test calendar is required.");
      return;
    }
    const items = state.items.filter(item => item.calendar_reminder);
    const journal = this.loadJournal(integration.integrationId, calendar.id, items);
    // Establish the device binding before any provider attempt. A crash must
    // leave distinguishable journal evidence rather than look like a new clone.
    this.app.saveLocalStorage(HIGH_WATER_KEY, journal);
    this.setStatus("working", "Reconciling committed reminder changes…");
    let pending = 0;
    for (const item of items) {
      if (this.stopped || generation !== this.generation) return;
      const complete = await this.reconcileItem(item, integration.integrationId, calendar.id, generation);
      const latest = (await getStateStore(this.app).read()).items.find(candidate => candidate._id === item._id);
      if (latest) this.saveJournal(journal, latest);
      if (!complete) pending++;
    }
    if (pending) this.setStatus("pending", `${pending} reminder${pending === 1 ? "" : "s"} need attention or retry.`);
    else this.setStatus("idle", "All enrolled reminders are confirmed.");
  }

  private async reconcileItem(itemSnapshot: Task, integrationId: string, calendarId: string, generation: number): Promise<boolean> {
    const history = itemSnapshot.calendar_reminder!;
    const expectedHeadId = history.mutations[history.mutations.length - 1].id;
    let attempts = 0;
    for (let index = 0; index < history.mutations.length; index++) {
      const mutation = history.mutations[index];
      const delivery = mutation.delivery;
      if (delivery?.status === "confirmed") continue;
      if (delivery?.status === "missed" || delivery?.status === "conflict" || delivery?.status === "auth-required" ||
        delivery?.status === "permission-denied") return false;
      if (delivery?.status === "retryable" && delivery.retryAt) {
        const retryAt = Number(delivery.retryAt);
        if (Number.isFinite(retryAt) && retryAt > this.clock.now()) {
          this.schedule(retryAt - this.clock.now());
          return false;
        }
      }
      const schedule = mutation.date ? mutation : priorSchedule(history.mutations, index);
      if (!schedule?.date) {
        await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "conflict", 1,
          { reason: "Cancellation has no predecessor schedule" });
        return false;
      }
      let window;
      try {
        window = resolveReminderWindow(schedule.date, schedule.time, schedule.timeZone, this.clock.now());
      } catch (error) {
        await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "conflict", 1,
          { reason: (error as Error).message });
        return false;
      }
      if (mutation.active && window.missed) {
        await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "missed", (delivery?.attempts ?? 0) + 1,
          { reason: "Scheduled wall time elapsed before publication" });
        this.setStatus("missed", `Reminder missed for ${itemSnapshot.text}; it was not moved to the present.`);
        return false;
      }
      const current = await getStateStore(this.app).read();
      const currentItem = current.items.find(candidate => candidate._id === itemSnapshot._id);
      const currentHistory = currentItem?.calendar_reminder;
      if (!current.calendar?.enabled || current.calendar.integrationId !== integrationId ||
        current.calendar.publisherDeviceId !== this.deviceId ||
        currentHistory?.mutations[currentHistory.mutations.length - 1].id !== expectedHeadId ||
        currentHistory.mutations[index]?.id !== mutation.id) return false;
      attempts = (currentHistory.mutations[index].delivery?.attempts ?? 0) + 1;
      await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "dispatching", attempts);
      const intent: CalendarIntent = {
        integrationId,
        itemId: itemSnapshot._id,
        mutationId: mutation.id,
        predecessorId: mutation.predecessorId,
        active: mutation.active,
        title: mutation.title,
        start: window.start,
        end: window.end,
        timeZone: mutation.timeZone,
      };
      const transport = authenticatedCalendarHttp(this.dependencies.http, this.dependencies.tokenProvider, () => this.clock.now());
      const adapter = new GoogleCalendarAdapter(calendarId, transport, () => this.dependencies.tokenProvider.accessToken(),
        () => this.clock.now(), () => markProviderAttempt(this.app, this.deviceId, itemSnapshot._id, mutation.id, expectedHeadId));
      try {
        const result = await adapter.reconcile(intent);
        if (this.stopped || generation !== this.generation) return false;
        if (result.status === "published" || result.status === "cancelled") {
          await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "confirmed", attempts,
            { eventId: result.eventId, etag: result.etag });
          continue;
        }
        const reason = "reason" in result ? result.reason : "Calendar provider result was not confirmed";
        await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, result.status === "missed" ? "missed" :
          result.status === "pending" ? "unknown" : "conflict", attempts, { reason });
        return false;
      } catch (error) {
        const failure = error instanceof CalendarPublishError ? error
          : error instanceof RelayAuthError && error.code === "reconnect"
            ? new CalendarPublishError("auth", error.message)
            : error instanceof RelayAuthError && error.code === "transport"
              ? new CalendarPublishError("retryable", error.message)
              : new CalendarPublishError("unknown", "Calendar request outcome is unknown");
        if (failure.kind === "auth") {
          await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "auth-required", attempts, { reason: failure.message });
          this.setStatus("auth-required", failure.message);
          return false;
        }
        if (failure.kind === "permission") {
          await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "permission-denied", attempts, { reason: failure.message });
          this.setStatus("permission-denied", failure.message);
          return false;
        }
        if (failure.kind === "retryable") {
          const delay = retryDelay(attempts, this.random, failure.retryAfterMs);
          await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "retryable", attempts,
            { reason: failure.message, retryAt: String(this.clock.now() + delay) });
          this.schedule(delay);
          return false;
        }
        await recordCalendarDelivery(this.app, this.deviceId, itemSnapshot._id, mutation.id, "unknown", attempts,
          { reason: failure.message });
        this.schedule(retryDelay(attempts, this.random));
        return false;
      }
    }
    return true;
  }
}
