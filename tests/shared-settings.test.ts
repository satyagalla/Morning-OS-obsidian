import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/settings";
import { cloneSettings, SharedSettingsStore, SHARED_SETTINGS_PATH, sharedSettings, validateSharedSettings } from "../src/data/shared-settings";
import MorningOSPlugin from "../src/main";
import { beginEditingSession } from "../src/editing-session";
import { VIEW_TYPE_AREA } from "../src/view";

class MemoryHost {
  files = new Map<string, string>();
  local = new Map<string, unknown>();
  writes = 0;
  adapter = {
    exists: async (path: string) => this.files.has(path),
    read: async (path: string) => { const value = this.files.get(path); if (value === undefined) throw new Error("missing"); return value; },
    write: async (path: string, value: string) => { this.writes++; this.files.set(path, value); },
    mkdir: async (path: string) => { this.files.set(path, ""); },
  };
  loadLocal = (key: string) => this.local.get(key);
  saveLocal = (key: string, value: unknown) => { this.local.set(key, cloneSettings(value)); };
}
function fixture(host = new MemoryHost()) {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.openaiApiKey = "private-test-key";
  return { host, settings, store: new SharedSettingsStore(host, settings, DEFAULT_SETTINGS) };
}
function remote(host: MemoryHost, patch: object, version = 1): void {
  const previous = JSON.parse(host.files.get(SHARED_SETTINGS_PATH) ?? "{}") as { settings?: object };
  host.files.set(SHARED_SETTINGS_PATH, JSON.stringify({ schemaVersion: version, settings: { ...previous.settings, ...patch } }));
}
test("initialization is explicit, verified, backed up and excludes credentials/runtime/widgets", async () => {
  const { host, store, settings } = fixture();
  await store.reconcile(); assert.equal(host.files.size, 0);
  await store.update({ showGoals: false }); assert.equal(host.files.size, 0);
  await store.initialize();
  const bytes = host.files.get(SHARED_SETTINGS_PATH)!;
  assert(!bytes.includes("private-test-key"));
  const saved = JSON.parse(bytes).settings;
  for (const key of ["openaiApiKey", "awsSecretAccessKey", "widgetNotes", "onboarded", "agentLastRunDate", "settingsChangedSinceRun"]) assert(!(key in saved));
  assert.equal(saved.showGoals, false); assert.equal(settings.openaiApiKey, "private-test-key");
  assert([...host.files.keys()].some(path => path.startsWith("_generated/recovery/settings-before-sharing-")));
  await assert.rejects(store.initialize(), /already initialized/);
});
test("existing files are adopted without overwriting or replacing settings object", async () => {
  const { host, settings, store } = fixture();
  host.files.set(SHARED_SETTINGS_PATH, JSON.stringify({ schemaVersion: 1, settings: { ...sharedSettings(settings), showGoals: false } }));
  await assert.rejects(store.initialize(), /already initialized/);
  assert.equal(await store.reconcile(), true);
  assert.equal(settings.showGoals, false); assert.equal(settings.openaiApiKey, "private-test-key");
  assert.equal((host.local.get("morning-os-settings-before-adoption-v1") as { showGoals: boolean }).showGoals, true);
  assert.equal(await store.reconcile(), false); assert.equal(host.writes, 0);
});
test("nested keys/privacy/types/unknown fields and future schemas block adoption and writes", async () => {
  const { host, settings, store } = fixture(); await store.initialize();
  const original = host.files.get(SHARED_SETTINGS_PATH)!;
  const variants: unknown[] = [
    { ...sharedSettings(settings), areas: [{ ...settings.areas[0], feedToLLM: "yes" }] },
    { ...sharedSettings(settings), areas: [settings.areas[0], settings.areas[0]] },
    { ...sharedSettings(settings), areas: [{ ...settings.areas[0], tabs: [{ ...settings.areas[0].tabs[0], fields: [{ key: "f", label: "f", type: "number" }] }] }] },
    { ...sharedSettings(settings), openaiApiKey: "should-never-export" },
    { ...sharedSettings(settings), llmSectionMappings: [{ heading: "x", target: "bad", enabled: true }] },
  ];
  for (const value of variants) assert.throws(() => validateSharedSettings(value, DEFAULT_SETTINGS));
  for (const bytes of ["broken", JSON.stringify({ schemaVersion: 2, settings: sharedSettings(settings) })]) {
    host.files.set(SHARED_SETTINGS_PATH, bytes);
    await assert.rejects(store.reconcile());
    await assert.rejects(store.update({ showGoals: false }));
    assert.equal(settings.showGoals, true); assert.equal(host.files.get(SHARED_SETTINGS_PATH), bytes);
    await store.update({ openaiApiKey: "local-change" });
    assert.equal(host.files.get(SHARED_SETTINGS_PATH), bytes);
  }
  host.files.set(SHARED_SETTINGS_PATH, original); await store.reconcile(); assert.equal(store.error, "");
});
test("last-good cache survives restart and missing file blocks writes without recreating it", async () => {
  const { host, store } = fixture(); await store.initialize(); await store.update({ showGoals: false });
  host.files.delete(SHARED_SETTINGS_PATH);
  const restarted = fixture(host);
  assert.equal(restarted.settings.showGoals, false); assert.equal(restarted.store.isAdopted(), true);
  await assert.rejects(restarted.store.reconcile(), /missing/);
  await assert.rejects(restarted.store.update({ showIdentity: true }), /missing/);
  await assert.rejects(restarted.store.initialize(), /already initialized/);
  assert(!host.files.has(SHARED_SETTINGS_PATH));
});
test("intended patch preserves unrelated remote settings and rejects stale same-field edit", async () => {
  const { host, store, settings } = fixture(); await store.initialize(); const base = store.snapshot();
  remote(host, { showGoals: false });
  await store.update({ showIdentity: true }, base);
  assert.equal(settings.showGoals, false); assert.equal(settings.showIdentity, true);
  remote(host, { areas: [{ ...settings.areas[0], label: "Remote label" }] });
  const before = host.files.get(SHARED_SETTINGS_PATH);
  await assert.rejects(store.update({ areas: [{ ...base.areas[0], label: "Local label" }] }, base), /conflict in areas/);
  assert.equal(host.files.get(SHARED_SETTINGS_PATH), before);
  await store.reconcile(); assert.equal(settings.areas[0].label, "Remote label");
});
test("serialized independent edits converge and semantic no-op preserves bytes", async () => {
  const { host, store, settings } = fixture(); await store.initialize();
  await Promise.all([store.update({ showGoals: false }), store.update({ showIdentity: true })]);
  assert.equal(settings.showGoals, false); assert.equal(settings.showIdentity, true);
  const compact = JSON.stringify(JSON.parse(host.files.get(SHARED_SETTINGS_PATH)!));
  host.files.set(SHARED_SETTINGS_PATH, compact); const writes = host.writes;
  await store.update({ showGoals: false }); assert.equal(host.writes, writes); assert.equal(host.files.get(SHARED_SETTINGS_PATH), compact);
});

function pluginFixture() {
  const value = fixture(); const plugin = new MorningOSPlugin();
  plugin.settings = value.settings;
  let detaches = 0; let refreshes = 0;
  const leaves = new Map<string, { detach(): void }[]>();
  const app = {
    vault: { adapter: value.host.adapter },
    workspace: { getLeavesOfType: (key: string) => leaves.get(key) ?? [] },
    loadLocalStorage: value.host.loadLocal, saveLocalStorage: value.host.saveLocal,
  };
  Object.assign(plugin, { app, sharedSettingsStore: value.store });
  plugin.refreshView = async () => { refreshes++; };
  const data: unknown[] = [];
  plugin.saveData = async (saved: unknown) => { data.push(saved); };
  return { ...value, plugin, data, leaves, addLeaf: (key: string) => leaves.set(`${VIEW_TYPE_AREA}-${key}`, [{ detach: () => { detaches++; } }]), counts: () => ({ detaches, refreshes }) };
}
test("plugin local writes do not export or touch malformed/missing shared authority", async () => {
  const { plugin, host, store, data } = pluginFixture(); await store.initialize();
  for (const bytes of ["malformed", null]) {
    if (bytes === null) host.files.delete(SHARED_SETTINGS_PATH); else host.files.set(SHARED_SETTINGS_PATH, bytes);
    const writes = host.writes;
    await plugin.updateSettings({ openaiApiKey: "new-local-key", lastSeenVersion: "test" });
    const saved = data.at(-1) as Record<string, unknown>;
    assert.equal(saved.openaiApiKey, "new-local-key"); assert(!("areas" in saved)); assert(!("showGoals" in saved));
    assert.equal(host.writes, writes); assert.equal(host.files.get(SHARED_SETTINGS_PATH), bytes ?? undefined);
  }
});
test("plugin Area factories register once and removed leaves wait for active drafts", async () => {
  const { plugin, settings, addLeaf, counts } = pluginFixture();
  await plugin.reregisterAreaViews(); await plugin.reregisterAreaViews();
  addLeaf(settings.areas[0].key);
  const close = beginEditingSession();
  settings.areas = settings.areas.slice(1);
  await plugin.reregisterAreaViews(); assert.equal(counts().detaches, 0);
  close(); await plugin.reregisterAreaViews(); assert.equal(counts().detaches, 1);
  // Reintroducing a key reuses its public factory, never duplicate-registers.
  settings.areas = cloneSettings(DEFAULT_SETTINGS.areas); await plugin.reregisterAreaViews();
});

test("runtime reconciliation adopts settings and item bytes without redundant refresh", async () => {
  const { plugin, host, store, settings, counts } = pluginFixture();
  await store.initialize();
  host.files.set("_generated/data/state.json", JSON.stringify({ schemaVersion: 3, revision: 1, writtenAt: "2026-09-27T12:00:00", items: [] }));
  Object.assign(plugin, { calendarPublisher: { queue: () => undefined } });
  plugin.refreshWidgetNotes = async () => undefined;
  const runtime = plugin as unknown as { reconcileExternalState(): Promise<void>; settleDeferredRefresh(): Promise<void> };
  await runtime.reconcileExternalState(); const before = counts().refreshes;
  remote(host, { showGoals: false });
  await Promise.all([runtime.reconcileExternalState(), runtime.reconcileExternalState()]);
  assert.equal(settings.showGoals, false); assert(counts().refreshes > before);
  const after = counts().refreshes;
  await runtime.reconcileExternalState(); assert.equal(counts().refreshes, after);
  const close = beginEditingSession();
  remote(host, { areas: [] }); await runtime.reconcileExternalState();
  assert.equal(settings.areas.length, 0); assert.equal(counts().refreshes, after);
  close(); await runtime.settleDeferredRefresh(); assert(counts().refreshes > after);
});

test("deferred item refresh completes after editing even when fingerprint is already adopted", async () => {
  const { plugin, host, store, counts } = pluginFixture(); await store.initialize();
  host.files.set("_generated/data/state.json", JSON.stringify({ schemaVersion: 3, revision: 1, writtenAt: "2026-09-27T12:00:00", items: [] }));
  Object.assign(plugin, { calendarPublisher: { queue: () => undefined } });
  plugin.refreshWidgetNotes = async () => undefined;
  const runtime = plugin as unknown as { reconcileExternalState(): Promise<void>; settleDeferredRefresh(): Promise<void> };
  const close = beginEditingSession(); await runtime.reconcileExternalState();
  assert.equal(counts().refreshes, 0); close(); await runtime.settleDeferredRefresh();
  assert.equal(counts().refreshes, 1);
  await runtime.reconcileExternalState(); assert.equal(counts().refreshes, 1);
});

test("rapid queued cumulative local edits follow own commits, not stale detached or remote changes", async () => {
  const { plugin, host, store, settings } = pluginFixture(); await store.initialize();
  const base = store.snapshot();
  await Promise.all([plugin.updateSettings({ intelligenceModel: "H" }, base), plugin.updateSettings({ intelligenceModel: "He" }, base), plugin.updateSettings({ intelligenceModel: "Hello" }, base)]);
  assert.equal(settings.intelligenceModel, "Hello");
  await assert.rejects(plugin.updateSettings({ intelligenceModel: "Old draft" }, base), /conflict/);
  const current = store.snapshot();
  remote(host, { intelligenceModel: "Remote" });
  await assert.rejects(plugin.updateSettings({ intelligenceModel: "Local" }, current), /conflict/);
  assert.equal(JSON.parse(host.files.get(SHARED_SETTINGS_PATH)!).settings.intelligenceModel, "Remote");
});
