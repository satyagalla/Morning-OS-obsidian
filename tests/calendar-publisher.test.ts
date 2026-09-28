import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import { CalendarPublisher } from "../src/integrations/calendar/publisher";
import { STATE_PATH } from "../src/data/state-store";
import type { CalendarHttpRequest, CalendarHttpResponse } from "../src/integrations/calendar/oauth-token";
import type { CalendarIntegrationState, Task } from "../src/types";

class MemoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.directories.has(path); }
  async mkdir(path: string): Promise<void> { this.directories.add(path); }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return { files: [...this.files.keys()].filter(file => file.startsWith(`${path}/`)), folders: [] };
  }
  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }
  async write(path: string, value: string): Promise<void> { this.files.set(path, value); }
}

class Provider {
  event: Record<string, unknown> | null = null;
  writes = 0;
  version = 0;
  async http(request: CalendarHttpRequest): Promise<CalendarHttpResponse> {
    if (request.method === "GET") return { status: this.event ? 200 : 404, body: this.event && structuredClone(this.event) };
    this.writes++;
    const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
    if (request.method === "POST") {
      if (this.event) return { status: 409, body: {} };
      this.event = { ...body, id: body.id, etag: `\"${++this.version}\"`, status: "confirmed" };
      return { status: 200, body: structuredClone(this.event) };
    }
    if (!this.event || request.headers?.["If-Match"] !== this.event.etag) return { status: 412, body: {} };
    this.event = { ...this.event, ...body, etag: `\"${++this.version}\"` };
    return { status: 200, body: structuredClone(this.event) };
  }
}

function integration(): CalendarIntegrationState {
  return {
    version: 1, protocolVersion: 1, provider: "google", integrationId: "integration", ownershipToken: "owner",
    publisherDeviceId: "device", enabled: true, defaultTime: "09:00", timeZone: "America/New_York",
    calendar: { status: "ready", id: "dedicated@example", summary: "Morning OS Test", confirmed: true },
  };
}

function task(providerAttempted = false): Task {
  return {
    _id: "item", text: "C", notes: "", areas: [], tags: {}, status_completion: "open", status_priority: "regular",
    status_urgency: "none", is_today: false, is_deleted: false, date_created: "2026-01-01", date_modified: "2026-01-01",
    date_completed: null, date_remind: "2030-01-02", parent_id: null, kind: "task",
    calendar_reminder: {
      version: 1, providerAttempted,
      mutations: [
        { id: "A", predecessorId: null, active: true, title: "A", date: "2030-01-01", time: "09:00", timeZone: "America/New_York" },
        { id: "B", predecessorId: "A", active: true, title: "B", date: "2030-01-02", time: "09:00", timeZone: "America/New_York" },
        { id: "C", predecessorId: "B", active: true, title: "C", date: "2030-01-02", time: "09:00", timeZone: "America/New_York" },
      ],
    },
  };
}

function app(adapter: MemoryAdapter): Record<string, unknown> & { local: Map<string, unknown> } {
  const local = new Map<string, unknown>();
  return {
    local,
    vault: { adapter, getAbstractFileByPath: (path: string) => adapter.files.has(path) ? new TFile(path) : null },
    fileManager: { trashFile: async (file: TFile) => { adapter.files.delete(file.path); } },
    loadLocalStorage: (key: string) => local.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => { local.set(key, value); },
  };
}

function writeState(adapter: MemoryAdapter, item: Task): void {
  adapter.files.set(STATE_PATH, JSON.stringify({ schemaVersion: 3, revision: 0, writtenAt: "2030-01-01", calendar: integration(), items: [item] }));
}

test("publisher replays A to B to C rather than coalescing from remote A directly to C", async () => {
  const adapter = new MemoryAdapter();
  writeState(adapter, task());
  const application = app(adapter);
  const provider = new Provider();
  const publisher = new CalendarPublisher(application as never, "device", {
    http: request => provider.http(request),
    tokenProvider: { accessToken: async () => "token", refreshAfterUnauthorized: async () => "token", disconnect: () => {} },
    clock: { now: () => Date.parse("2029-01-01T00:00:00Z"), setTimeout: () => 1, clearTimeout: () => {} },
  });

  await publisher.reconcileNow();
  assert.equal(provider.writes, 3);
  assert.equal(provider.event?.summary, "C");
  const state = JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] };
  assert.deepEqual(state.items[0].calendar_reminder?.mutations.map(mutation => mutation.delivery?.status), ["confirmed", "confirmed", "confirmed"]);
});

test("publisher pauses rather than recreating after losing its device journal", async () => {
  const adapter = new MemoryAdapter();
  writeState(adapter, task(true));
  const application = app(adapter);
  const provider = new Provider();
  const publisher = new CalendarPublisher(application as never, "device", {
    http: request => provider.http(request),
    tokenProvider: { accessToken: async () => "token", refreshAfterUnauthorized: async () => "token", disconnect: () => {} },
  });

  await publisher.reconcileNow();
  assert.equal(provider.writes, 0);
  assert.equal(publisher.status().state, "conflict");
  assert.match(publisher.status().message, /journal is missing/);
});
