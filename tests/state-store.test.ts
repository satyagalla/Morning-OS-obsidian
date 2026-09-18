import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import { STATE_PATH, StateStore } from "../src/data/state-store";
import { StateValidationError, validateState } from "../src/data/schemas";
import type { Task } from "../src/types";
import { changeItemKind, createChildItem, setNoteStatus, setTaskStatus, cloneItemDraft, promoteDueReminders, saveItemDraft, updateTask } from "../src/task-registry";
import { deleteTask, restoreTask } from "../src/task-registry";
import { reconcileItemDraft } from "../src/data/draft-reconciliation";
import { beginEditingSession } from "../src/editing-session";

const LEGACY_PATH = "_generated/tasks.json";

class MemoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  beforeWrite?: (path: string) => void | Promise<void>;
  onWrite?: (path: string) => void | Promise<void>;
  beforeRead?: (path: string) => void | Promise<void>;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter(file => file.startsWith(prefix)),
      folders: [...this.directories].filter(directory => directory.startsWith(prefix)),
    };
  }

  async read(path: string): Promise<string> {
    await this.beforeRead?.(path);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`missing path: ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    await this.beforeWrite?.(path);
    this.files.set(path, value);
    await this.onWrite?.(path);
  }
}

function createApp(adapter: MemoryAdapter) {
  return {
    vault: {
      adapter,
      getAbstractFileByPath: (path: string) => adapter.files.has(path) ? new TFile(path) : null,
    },
    fileManager: { trashFile: async (file: TFile) => { adapter.files.delete(file.path); } },
  };
}

function task(id: string, text = id): Task {
  return {
    _id: id,
    text,
    notes: "",
    areas: [],
    tags: {},
    status_completion: "open",
    status_priority: "regular",
    status_urgency: "none",
    is_today: false,
    is_deleted: false,
    date_created: "2026-09-16",
    date_modified: "2026-09-16",
    date_completed: null,
    date_remind: null,
    parent_id: null,
    kind: "task",
  };
}

function state(items: Task[], revision = 0): string {
  return JSON.stringify({ schemaVersion: 1, revision, writtenAt: "2026-09-16T10:00:00", items });
}

function snapshotBytes(raw: string, reason: "automatic" | "manual" | "pre-migration" | "pre-restore", sourcePath = STATE_PATH, createdAt = "2026-09-16T10:00:00.000"): string {
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return JSON.stringify({ version: 1, reason, createdAt, sourcePath, checksum: (hash >>> 0).toString(16).padStart(8, "0"), itemCount: JSON.parse(raw).items?.length ?? JSON.parse(raw).length ?? 0, raw });
}

test("schema validation rejects unsupported versions, malformed records, and cycles", () => {
  assert.throws(
    () => validateState({ schemaVersion: 99, revision: 0, writtenAt: "x", items: [] }),
    StateValidationError,
  );

  const malformed = task("one");
  malformed.kind = "note";
  assert.throws(
    () => validateState({ schemaVersion: 1, revision: 0, writtenAt: "x", items: [malformed] }),
    /no lifecycle/,
  );

  const first = task("first");
  const second = task("second");
  first.parent_id = "second";
  second.parent_id = "first";
  assert.throws(
    () => validateState({ schemaVersion: 1, revision: 0, writtenAt: "x", items: [first, second] }),
    StateValidationError,
  );
});

test("an absent registry reads as empty without activating state", async () => {
  const adapter = new MemoryAdapter();
  const store = new StateStore(createApp(adapter) as never);

  const result = await store.read();

  assert.equal(result.revision, 0);
  assert.deepEqual(result.items, []);
  assert.equal(adapter.files.size, 0);
});

test("legacy migration preserves legacy bytes in a verified pre-migration snapshot", async () => {
  const adapter = new MemoryAdapter();
  const legacyBytes = JSON.stringify([{ ...task("legacy"), id: "legacy", _id: undefined }]);
  adapter.files.set(LEGACY_PATH, legacyBytes);
  const store = new StateStore(createApp(adapter) as never);

  const result = await store.initialize();
  const migrated = JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[]; migration?: { source: string } };
  const snapshotBytes = [...adapter.files.entries()]
    .filter(([path]) => path.startsWith("_generated/snapshots/"))
    .map(([, bytes]) => JSON.parse(bytes) as { reason: string; raw: string });

  assert.deepEqual(result, { migrated: true, itemCount: 1 });
  assert.equal(await adapter.read(LEGACY_PATH), legacyBytes);
  assert.equal(migrated.migration?.source, "legacy-tasks");
  assert.equal(migrated.items[0]._id, "legacy");
  assert.ok(snapshotBytes.some(snapshot => snapshot.reason === "pre-migration" && snapshot.raw === legacyBytes));
});

test("legacy migration preserves IDs, content, metadata, groups, lifecycle, Today, and reminders", async () => {
  const adapter = new MemoryAdapter();
  const parent = task("parent", "Parent content");
  parent.notes = "Parent details";
  parent.details = "Parent details";
  parent.areas = ["career"];
  parent.tags = { career: "applications", nested: { owner: "Ada", flags: ["follow-up"] } };
  parent.status_completion = "done";
  parent.date_completed = "2026-09-15";
  parent.is_today = true;
  parent.status_priority = "red";
  parent.date_remind = "2026-09-20";
  parent.reminder_occurrence = { token: "occurrence", handledToken: "occurrence" };
  (parent as Task & { unknown_legacy_value: string }).unknown_legacy_value = "retain me";
  const child = task("child", "Child content");
  child.parent_id = parent._id;
  child.areas = ["career"];
  child.tags = { career: "applications", stage: "Applied" };
  const legacy = JSON.stringify([parent, child]);
  adapter.files.set(LEGACY_PATH, legacy);
  const store = new StateStore(createApp(adapter) as never);

  await store.initialize();
  const migrated = JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] };
  assert.equal(await adapter.read(LEGACY_PATH), legacy);
  assert.deepEqual(migrated.items.map(item => item._id), ["parent", "child"]);
  assert.deepEqual(migrated.items[0].tags, parent.tags);
  assert.equal(migrated.items[0].text, "Parent content");
  assert.equal(migrated.items[0].details, "Parent details");
  assert.equal(migrated.items[0].status_completion, "done");
  assert.equal(migrated.items[0].is_today, true);
  assert.equal(migrated.items[0].status_priority, "red");
  assert.deepEqual(migrated.items[0].reminder_occurrence, parent.reminder_occurrence);
  assert.equal(migrated.items[1].parent_id, "parent");
  assert.equal((migrated.items[0] as Task & { unknown_legacy_value: string }).unknown_legacy_value, "retain me");
});

test("malformed active state blocks all mutations instead of replacing it", async () => {
  const adapter = new MemoryAdapter();
  const malformed = "{ not valid json";
  adapter.files.set(STATE_PATH, malformed);
  const store = new StateStore(createApp(adapter) as never);

  await assert.rejects(() => store.update(candidate => { candidate.items.push(task("new")); }), StateValidationError);

  assert.equal(await adapter.read(STATE_PATH), malformed);
  assert.equal([...adapter.files.keys()].filter(path => path.includes(".pending-")).length, 0);
});

test("updates serialize, increment revisions, and take only one automatic snapshot per day", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("initial")]));
  const store = new StateStore(createApp(adapter) as never);

  await Promise.all([
    store.update(candidate => { candidate.items.push(task("first")); }, "first"),
    store.update(candidate => { candidate.items.push(task("second")); }, "second"),
  ]);

  const current = JSON.parse(await adapter.read(STATE_PATH)) as { revision: number; items: Task[] };
  const automaticSnapshots = [...adapter.files.entries()]
    .filter(([path, bytes]) => path.startsWith("_generated/snapshots/") && JSON.parse(bytes).reason === "automatic");
  assert.equal(current.revision, 2);
  assert.deepEqual(current.items.map(item => item._id), ["initial", "first", "second"]);
  assert.equal(automaticSnapshots.length, 1);
  assert.equal([...adapter.files.keys()].filter(path => path.includes(".pending-") || path.includes(".journal-")).length, 0);
});

test("successful commits clean up only their own transaction artifacts and preserve older ones", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("initial")]));
  adapter.files.set("_generated/data/.pending-old.json", "older recovery material");
  adapter.files.set("_generated/data/.journal-old.json", "older recovery material");
  const store = new StateStore(createApp(adapter) as never);

  await store.update(candidate => { candidate.items.push(task("first")); });
  await store.update(candidate => { candidate.items.push(task("second")); });

  assert.equal(adapter.files.has("_generated/data/.pending-old.json"), true);
  assert.equal(adapter.files.has("_generated/data/.journal-old.json"), true);
  assert.equal([...adapter.files.keys()].filter(path => path.includes(".pending-") && !path.endsWith("old.json")).length, 0);
  assert.equal([...adapter.files.keys()].filter(path => path.includes(".journal-") && !path.endsWith("old.json")).length, 0);
});

test("artifact cleanup warnings do not turn a verified commit into a failed save", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("initial")]));
  const app = createApp(adapter) as never as { fileManager: { trashFile: () => Promise<void> } } & ReturnType<typeof createApp>;
  app.fileManager.trashFile = async () => { throw new Error("trash unavailable"); };
  const store = new StateStore(app as never);

  await store.update(candidate => { candidate.items[0].text = "Committed"; });

  assert.equal((JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0].text, "Committed");
  assert.equal([...adapter.files.keys()].filter(path => path.includes(".pending-")).length, 1);
  assert.equal([...adapter.files.keys()].filter(path => path.includes(".journal-")).length, 1);
});

test("manual snapshots can be restored and always receive a new state revision", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("original", "Original")]));
  const store = new StateStore(createApp(adapter) as never);

  const snapshotPath = await store.backupNow();
  await store.update(candidate => { candidate.items[0].text = "Changed"; }, "change-text");
  await store.restoreSnapshot(snapshotPath);

  const restored = JSON.parse(await adapter.read(STATE_PATH)) as { revision: number; items: Task[] };
  assert.equal(restored.revision, 2);
  assert.equal(restored.items[0].text, "Original");
  assert.equal((await store.listSnapshots()).find(snapshot => snapshot.path === snapshotPath)?.valid, true);
});

test("corrupt snapshots are surfaced as invalid rather than accepted as recovery data", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("original")]));
  const store = new StateStore(createApp(adapter) as never);

  const snapshotPath = await store.backupNow();
  adapter.files.set(snapshotPath, JSON.stringify({ version: 1, raw: "tampered" }));

  const snapshot = (await store.listSnapshots()).find(entry => entry.path === snapshotPath);
  assert.equal(snapshot?.valid, false);
  assert.match(snapshot?.error ?? "", /invalid snapshot/);
});

test("an external state change during staging blocks activation and retains recovery data", async () => {
  const adapter = new MemoryAdapter();
  const external = state([task("external")], 7);
  adapter.files.set(STATE_PATH, state([task("original")]));
  adapter.onWrite = path => {
    if (path.includes(".journal-")) adapter.files.set(STATE_PATH, external);
  };
  const store = new StateStore(createApp(adapter) as never);

  await assert.rejects(
    () => store.update(candidate => { candidate.items.push(task("new")); }),
    /state changed while preparing a write/,
  );

  assert.equal(await adapter.read(STATE_PATH), external);
  assert.equal([...adapter.files.keys()].filter(path => path.includes(".pending-")).length, 1);
  assert.equal([...adapter.files.keys()].filter(path => path.includes(".journal-")).length, 1);
});

test("migration aborts when its legacy source changes during staging", async () => {
  const adapter = new MemoryAdapter();
  const original = JSON.stringify([task("legacy", "Original")]);
  const changed = JSON.stringify([task("legacy", "Changed elsewhere")]);
  adapter.files.set(LEGACY_PATH, original);
  adapter.onWrite = path => {
    if (path.startsWith("_generated/snapshots/")) adapter.files.set(LEGACY_PATH, changed);
  };
  const store = new StateStore(createApp(adapter) as never);

  await assert.rejects(() => store.initialize(), /legacy registry changed while preparing migration/);
  assert.equal(await adapter.read(LEGACY_PATH), changed);
  assert.equal(adapter.files.has(STATE_PATH), false);
  assert.ok([...adapter.files.keys()].some(path => path.startsWith("_generated/snapshots/")));
});

test("a verified interrupted activation blocks empty initialization", async () => {
  const adapter = new MemoryAdapter();
  adapter.beforeWrite = path => {
    if (path === STATE_PATH) throw new Error("simulated interruption");
  };
  const store = new StateStore(createApp(adapter) as never);
  await assert.rejects(() => store.update(candidate => { candidate.items.push(task("pending")); }), /simulated interruption/);
  adapter.beforeWrite = undefined;

  await assert.rejects(() => store.initialize(), /interrupted write/);
  assert.equal(adapter.files.has(STATE_PATH), false);
  assert.ok([...adapter.files.keys()].some(path => path.includes(".pending-")));
  assert.ok([...adapter.files.keys()].some(path => path.includes(".journal-")));
});

test("restore failure preserves the prior active state and its pre-restore snapshot", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("one", "Before restore")]));
  const store = new StateStore(createApp(adapter) as never);
  const snapshot = await store.backupNow();
  await store.update(candidate => { candidate.items[0].text = "Current"; });
  const current = await adapter.read(STATE_PATH);
  adapter.beforeWrite = path => {
    if (path === STATE_PATH) throw new Error("restore activation failed");
  };

  await assert.rejects(() => store.restoreSnapshot(snapshot), /restore activation failed/);
  assert.equal(await adapter.read(STATE_PATH), current);
  assert.ok([...adapter.files.values()].some(bytes => JSON.parse(bytes).reason === "pre-restore"));
});

test("restore accepts a healthy backup over malformed active bytes and preserves those exact bytes separately", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("original", "Original")]));
  const store = new StateStore(createApp(adapter) as never);
  const backup = await store.backupNow();
  const damaged = "{ damaged state bytes\n";
  adapter.files.set(STATE_PATH, damaged);

  const result = await store.restoreSnapshot(backup);

  assert.equal(result.currentState, "damaged");
  assert.ok(result.recoveryPath);
  assert.equal(await adapter.read(result.recoveryPath!), damaged);
  assert.equal((JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0].text, "Original");
  assert.equal([...adapter.files.keys()].filter(path => path.startsWith("_generated/snapshots/")).some(path => adapter.files.get(path) === damaged), false);
});

test("restore handles a missing active file explicitly without initializing an empty state", async () => {
  const adapter = new MemoryAdapter();
  const raw = state([task("backup", "Backup")], 6);
  const path = "_generated/snapshots/manual.json";
  adapter.files.set(path, snapshotBytes(raw, "manual"));
  const store = new StateStore(createApp(adapter) as never);

  const result = await store.restoreSnapshot(path);

  assert.equal(result.currentState, "missing");
  assert.equal(result.recoveryPath, undefined);
  const restored = JSON.parse(await adapter.read(STATE_PATH)) as { revision: number; items: Task[] };
  assert.equal(restored.revision, 7);
  assert.equal(restored.items[0].text, "Backup");
});

test("a failed damaged-state preservation write leaves active bytes untouched", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("original")]));
  const store = new StateStore(createApp(adapter) as never);
  const backup = await store.backupNow();
  const damaged = "not valid JSON";
  adapter.files.set(STATE_PATH, damaged);
  adapter.beforeWrite = path => {
    if (path.startsWith("_generated/recovery/")) throw new Error("recovery disk full");
  };

  await assert.rejects(() => store.restoreSnapshot(backup), /recovery disk full/);
  assert.equal(await adapter.read(STATE_PATH), damaged);
});

test("restore waits for queued edits, rejects repeats and blocks edits requested during restore", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("one", "Original")]));
  const store = new StateStore(createApp(adapter) as never);
  const backup = await store.backupNow();
  let unblockWrite: (() => void) | undefined;
  const firstWrite = new Promise<void>(resolve => { unblockWrite = resolve; });
  let blockNextStateWrite = true;
  adapter.beforeWrite = async path => {
    if (path === STATE_PATH && blockNextStateWrite) {
      blockNextStateWrite = false;
      await firstWrite;
    }
  };
  const queuedEdit = store.update(candidate => { candidate.items[0].text = "Queued edit"; });
  const restoring = store.restoreSnapshot(backup);
  await assert.rejects(() => store.restoreSnapshot(backup), /already in progress/);
  await assert.rejects(() => store.update(candidate => { candidate.items.push(task("blocked")); }), /restore is in progress/);
  unblockWrite!();
  await queuedEdit;
  await restoring;
  assert.equal((JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0].text, "Original");
});

test("restore aborts if the active file is created or deleted during preparation", async () => {
  const created = new MemoryAdapter();
  const raw = state([task("backup")]);
  const path = "_generated/snapshots/manual.json";
  created.files.set(path, snapshotBytes(raw, "manual"));
  created.onWrite = writePath => {
    if (writePath.includes(".pending-")) created.files.set(STATE_PATH, state([task("external")], 9));
  };
  await assert.rejects(() => new StateStore(createApp(created) as never).restoreSnapshot(path), /state changed while preparing a write/);
  assert.equal((JSON.parse(await created.read(STATE_PATH)) as { items: Task[] }).items[0].text, "external");

  const deleted = new MemoryAdapter();
  deleted.files.set(STATE_PATH, state([task("current")]));
  deleted.files.set(path, snapshotBytes(raw, "manual"));
  deleted.onWrite = writePath => {
    if (writePath.startsWith("_generated/snapshots/")) deleted.files.delete(STATE_PATH);
  };
  await assert.rejects(() => new StateStore(createApp(deleted) as never).restoreSnapshot(path), /state changed while preparing a write/);
  assert.equal(deleted.files.has(STATE_PATH), false);
});

test("activation read-back failures preserve the recovery artifacts without promising rollback", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("original", "Original")]));
  const store = new StateStore(createApp(adapter) as never);
  const backup = await store.backupNow();
  adapter.files.set(STATE_PATH, "damaged bytes");
  let failReadBack = false;
  adapter.onWrite = path => { if (path === STATE_PATH) failReadBack = true; };
  adapter.beforeRead = path => {
    if (path === STATE_PATH && failReadBack) throw new Error("activation read-back failed");
  };

  await assert.rejects(() => store.restoreSnapshot(backup), /activation read-back failed/);
  assert.ok([...adapter.files.keys()].some(path => path.startsWith("_generated/recovery/damaged-state-")));
  assert.ok([...adapter.files.keys()].some(path => path.includes(".pending-")));
});

test("legacy snapshots restore through migration while unsupported and corrupt snapshots remain rejected", async () => {
  const adapter = new MemoryAdapter();
  adapter.directories.add("_generated/snapshots");
  const legacyRaw = JSON.stringify([task("legacy", "Legacy item")]);
  const legacyPath = "_generated/snapshots/legacy.json";
  adapter.files.set(legacyPath, snapshotBytes(legacyRaw, "pre-migration", LEGACY_PATH));
  const store = new StateStore(createApp(adapter) as never);

  const listed = await store.listSnapshots();
  assert.equal(listed[0].status, "legacy");
  const result = await store.restoreSnapshot(legacyPath);
  assert.equal(result.legacySnapshot, true);
  assert.equal((JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0].text, "Legacy item");
  assert.equal(adapter.files.get(legacyPath), snapshotBytes(legacyRaw, "pre-migration", LEGACY_PATH));

  const unsupported = "_generated/snapshots/unsupported.json";
  adapter.files.set(unsupported, snapshotBytes(JSON.stringify({ schemaVersion: 99, revision: 0, writtenAt: "x", items: [] }), "manual"));
  const corrupt = "_generated/snapshots/corrupt.json";
  adapter.files.set(corrupt, "not json");
  const rejected = await store.listSnapshots();
  assert.equal(rejected.find(snapshot => snapshot.path === unsupported)?.status, "invalid");
  assert.equal(rejected.find(snapshot => snapshot.path === corrupt)?.status, "invalid");
  await assert.rejects(() => store.restoreSnapshot(unsupported), /unsupported state schema/);
});

test("retention keeps the 20 newest automatic snapshots by creation time and protects other backup types", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("active")]));
  const raw = state([task("saved")]);
  for (let index = 0; index < 22; index++) {
    const createdAt = `2026-09-16T10:${String(index).padStart(2, "0")}:00.000`;
    adapter.files.set(`_generated/snapshots/automatic-${String(99 - index).padStart(2, "0")}.json`, snapshotBytes(raw, "automatic", STATE_PATH, createdAt));
  }
  adapter.files.set("_generated/snapshots/manual-protected.json", snapshotBytes(raw, "manual"));
  adapter.files.set("_generated/snapshots/pre-restore-protected.json", snapshotBytes(raw, "pre-restore"));
  adapter.files.set("_generated/snapshots/invalid-protected.json", "broken");
  const store = new StateStore(createApp(adapter) as never);

  await store.backupNow();

  const automatic = (await store.listSnapshots()).filter(snapshot => snapshot.valid && snapshot.reason === "automatic");
  assert.equal(automatic.length, 20);
  assert.equal(automatic[0].createdAt, "2026-09-16T10:21:00.000");
  assert.equal(adapter.files.has("_generated/snapshots/automatic-99.json"), false);
  assert.equal(adapter.files.has("_generated/snapshots/automatic-98.json"), false);
  assert.equal(adapter.files.has("_generated/snapshots/manual-protected.json"), true);
  assert.equal(adapter.files.has("_generated/snapshots/pre-restore-protected.json"), true);
  assert.equal(adapter.files.has("_generated/snapshots/invalid-protected.json"), true);
});

test("the automatic snapshot marker is not listed or counted while malformed backups remain visible", async () => {
  const adapter = new MemoryAdapter();
  adapter.directories.add("_generated/snapshots");
  adapter.files.set(STATE_PATH, state([task("active")]));
  const raw = state([task("saved")]);
  adapter.files.set("_generated/snapshots/.last-automatic.json", JSON.stringify({ date: "2026-09-16" }));
  adapter.files.set("_generated/snapshots/malformed.json", "not a snapshot");
  adapter.files.set("_generated/snapshots/legacy.json", snapshotBytes(JSON.stringify([task("legacy")]), "pre-migration", LEGACY_PATH));
  adapter.files.set("_generated/snapshots/automatic.json", snapshotBytes(raw, "automatic"));
  const snapshots = await new StateStore(createApp(adapter) as never).listSnapshots();

  assert.equal(snapshots.some(snapshot => snapshot.path.endsWith(".last-automatic.json")), false);
  assert.equal(snapshots.filter(snapshot => snapshot.valid && snapshot.reason === "automatic").length, 1);
  assert.equal(snapshots.find(snapshot => snapshot.path.endsWith("malformed.json"))?.status, "invalid");
  assert.equal(snapshots.find(snapshot => snapshot.path.endsWith("legacy.json"))?.status, "legacy");
});

test("an active draft blocks restore without being discarded", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(STATE_PATH, state([task("original", "Original")]));
  const store = new StateStore(createApp(adapter) as never);
  const backup = await store.backupNow();
  await store.update(candidate => { candidate.items[0].text = "Current"; });
  const finishEditing = beginEditingSession();

  await assert.rejects(() => store.restoreSnapshot(backup), /save or discard the active item draft/);
  assert.equal((JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0].text, "Current");
  finishEditing();
  await store.restoreSnapshot(backup);
  assert.equal((JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0].text, "Original");
});

test("draft reconciliation preserves unrelated external fields and requires a choice for same-field changes", () => {
  const base = task("draft", "Original");
  base.notes = "Details";
  const draft = { ...base, text: "My draft" };
  const unrelatedExternal = { ...base, notes: "External details" };
  const safe = reconcileItemDraft(base, draft, unrelatedExternal);
  assert.deepEqual(safe.patch, { text: "My draft" });
  assert.equal(safe.conflicts.length, 0);

  const sameFieldExternal = { ...base, text: "External text" };
  const conflict = reconcileItemDraft(base, draft, sameFieldExternal);
  assert.equal(conflict.patch.text, undefined);
  assert.deepEqual(conflict.conflicts[0], { field: "text", base: "Original", draft: "My draft", external: "External text" });

  const tagBase = { ...base, tags: { stage: "Research", contact: "Ada" } };
  const tagDraft = { ...tagBase, tags: { ...tagBase.tags, stage: "Applied" } };
  const tagExternal = { ...tagBase, tags: { ...tagBase.tags, contact: "Grace" } };
  const tagSafe = reconcileItemDraft(tagBase, tagDraft, tagExternal);
  assert.deepEqual(tagSafe.patch.tags, { stage: "Applied", contact: "Grace" });
  assert.equal(tagSafe.conflicts.length, 0);
});

test("a draft for an externally deleted item is retained as a rejected save, never resurrected", async () => {
  const adapter = new MemoryAdapter();
  const original = task("deleted-draft", "Keep this text");
  adapter.files.set(STATE_PATH, state([original]));
  const app = createApp(adapter) as never;
  const draft = cloneItemDraft(original);
  draft.text = "Unsaved recovery text";
  await deleteTask(app, original._id);

  const result = await saveItemDraft(app, original, draft);
  assert.deepEqual(result, { status: "deleted" });
  const stored = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0];
  assert.equal(stored.is_deleted, true);
  assert.equal(stored.text, "Keep this text");
});

test("partial conflict authorization never commits a partial draft", async () => {
  const adapter = new MemoryAdapter();
  const original = task("partial", "Original");
  original.notes = "Original details";
  adapter.files.set(STATE_PATH, state([original]));
  const app = createApp(adapter) as never;
  const draft = cloneItemDraft(original);
  draft.text = "My text";
  draft.notes = "My details";
  await updateTask(app, original._id, { text: "External text", notes: "External details" });

  const rejected = await saveItemDraft(app, original, draft, ["text"]);
  assert.equal(rejected.status, "conflict");
  assert.deepEqual((JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0].text, "External text");
  assert.deepEqual((JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0].notes, "External details");

  const saved = await saveItemDraft(app, original, draft, ["text", "notes"]);
  assert.deepEqual(saved, { status: "saved" });
  const current = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0];
  assert.equal(current.text, "My text");
  assert.equal(current.notes, "My details");
});

test("draft retries surface new conflicts and authorize tag keys independently", async () => {
  const adapter = new MemoryAdapter();
  const original = task("tags");
  original.tags = { stage: "Research", contact: "Ada" };
  adapter.files.set(STATE_PATH, state([original]));
  const app = createApp(adapter) as never;
  const draft = cloneItemDraft(original);
  draft.text = "My text";
  draft.tags.stage = "Applied";
  await updateTask(app, original._id, { text: "External text", tags: { stage: "External stage", contact: "Grace" } });

  const first = await saveItemDraft(app, original, draft, ["text"]);
  assert.equal(first.status, "conflict");
  assert.equal(first.status === "conflict" ? first.conflicts[0].key : undefined, "stage");
  const saved = await saveItemDraft(app, original, draft, ["text", { field: "tags", key: "stage" }]);
  assert.deepEqual(saved, { status: "saved" });
  const current = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0];
  assert.equal(current.text, "My text");
  assert.deepEqual(current.tags, { stage: "Applied", contact: "Grace" });
});

test("tag conflict choices merge all draft keys, external keys, and deletions in one latest-state patch", async () => {
  const adapter = new MemoryAdapter();
  const original = task("tag-merge");
  original.tags = { stage: "Research", contact: "Ada", remove: "Old" };
  adapter.files.set(STATE_PATH, state([original]));
  const app = createApp(adapter) as never;
  const draft = cloneItemDraft(original);
  draft.tags.stage = "Applied";
  draft.tags.contact = "Grace";
  draft.tags.portfolio = "https://example.test";
  delete draft.tags.remove;
  await updateTask(app, original._id, {
    tags: { stage: "External stage", contact: "External contact", remove: "Old", external: "Keep me" },
  });

  const rejected = await saveItemDraft(app, original, draft, [{ field: "tags", key: "stage" }]);
  assert.equal(rejected.status, "conflict");
  let stored = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0];
  assert.deepEqual(stored.tags, { stage: "External stage", contact: "External contact", remove: "Old", external: "Keep me" });

  const saved = await saveItemDraft(app, original, draft, [
    { field: "tags", key: "stage" }, { field: "tags", key: "contact" },
  ]);
  assert.deepEqual(saved, { status: "saved" });
  stored = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0];
  assert.deepEqual(stored.tags, { stage: "Applied", contact: "Grace", portfolio: "https://example.test", external: "Keep me" });
});

test("draft reminder changes reset only changed occurrences and promote once", async () => {
  const adapter = new MemoryAdapter();
  const original = task("reminder");
  original.date_remind = "2026-09-16";
  original.reminder_occurrence = { token: "old", handledToken: "old", dismissedToken: "old" };
  adapter.files.set(STATE_PATH, state([original]));
  const app = createApp(adapter) as never;
  const draft = cloneItemDraft(original);
  draft.date_remind = "2026-09-15";
  assert.deepEqual(await saveItemDraft(app, original, draft), { status: "saved" });
  let current = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0];
  assert.equal(current.reminder_occurrence?.handledToken, undefined);
  assert.equal(current.reminder_occurrence?.dismissedToken, undefined);
  assert.equal(await promoteDueReminders(app), 1);
  assert.equal(await promoteDueReminders(app), 0);

  const unrelated = cloneItemDraft(current);
  unrelated.notes = "Unrelated";
  await saveItemDraft(app, current, unrelated);
  current = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0];
  assert.equal(current.reminder_occurrence?.handledToken, current.reminder_occurrence?.token);
  const clear = cloneItemDraft(current);
  clear.date_remind = null;
  await saveItemDraft(app, current, clear);
  current = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items[0];
  assert.equal(current.reminder_occurrence, null);
});

test("group restore keeps an independently deleted child deleted", async () => {
  const adapter = new MemoryAdapter();
  const root = task("group-root");
  const live = task("group-live");
  live.parent_id = root._id;
  const independentlyDeleted = task("group-earlier-delete");
  independentlyDeleted.parent_id = root._id;
  adapter.files.set(STATE_PATH, state([root, live, independentlyDeleted]));
  const app = createApp(adapter) as never;

  await deleteTask(app, independentlyDeleted._id);
  await deleteTask(app, root._id);
  await restoreTask(app, root._id);
  const afterRestore = (JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] }).items;
  assert.equal(afterRestore.find(item => item._id === root._id)?.is_deleted, false);
  assert.equal(afterRestore.find(item => item._id === live._id)?.is_deleted, false);
  assert.equal(afterRestore.find(item => item._id === independentlyDeleted._id)?.is_deleted, true);

});

test("a new child copies parent placement/custom metadata without sharing later edits", () => {
  const parent = task("parent");
  parent.areas = ["work"];
  parent.tags = {
    work: "projects",
    contact: { name: "Ada", channels: ["email"] },
  };

  const child = createChildItem("Follow up", parent);
  assert.equal(child.parent_id, parent._id);
  assert.deepEqual(child.areas, ["work"]);
  assert.deepEqual(child.tags, parent.tags);
  assert.notEqual(child.areas, parent.areas);
  assert.notEqual(child.tags, parent.tags);
  assert.notEqual(child.tags.contact, parent.tags.contact);

  child.areas.push("personal");
  (child.tags.contact as { name: string; channels: string[] }).channels.push("phone");
  parent.areas[0] = "changed";
  (parent.tags.contact as { name: string; channels: string[] }).name = "Grace";

  assert.deepEqual(child.areas, ["work", "personal"]);
  assert.deepEqual(child.tags.contact, { name: "Ada", channels: ["email", "phone"] });
  assert.deepEqual(parent.tags.contact, { name: "Grace", channels: ["email"] });
  assert.equal(child.is_today, false);
  assert.equal(child.status_priority, "regular");
  assert.equal(child.date_remind, null);
});

test("note lifecycle and task completion stay separate while conversion preserves item data", async () => {
  const adapter = new MemoryAdapter();
  const original = task("convert", "Preserve me");
  original.notes = "Details";
  original.details = "Details";
  original.areas = ["work"];
  original.tags = { work: "projects", nested: { value: "kept" } };
  original.is_today = true;
  original.date_remind = "2026-09-20";
  original.parent_id = "parent";
  adapter.files.set(STATE_PATH, state([task("parent"), original]));
  const app = createApp(adapter) as never;

  await changeItemKind(app, original._id, "note");
  let current = JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] };
  let item = current.items.find(candidate => candidate._id === original._id)!;
  assert.equal(item.kind, "note");
  assert.equal(item.status_note, "active");
  assert.equal(item.text, original.text);
  assert.equal(item.details, "Details");
  assert.deepEqual(item.tags, original.tags);
  assert.equal(item.parent_id, "parent");
  assert.equal(item.is_today, true);
  assert.equal(item.date_remind, "2026-09-20");

  await setTaskStatus(app, item._id, "done");
  current = JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] };
  assert.equal(current.items.find(candidate => candidate._id === item._id)?.status_note, "active");

  await setNoteStatus(app, item._id, "archived");
  current = JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] };
  item = current.items.find(candidate => candidate._id === item._id)!;
  assert.equal(item.status_note, "archived");
  assert.equal(item.status_completion, "done");

  await changeItemKind(app, item._id, "task");
  current = JSON.parse(await adapter.read(STATE_PATH)) as { items: Task[] };
  item = current.items.find(candidate => candidate._id === original._id)!;
  assert.equal(item.kind, "task");
  assert.equal(item.status_completion, "done");
  assert.equal(item.status_note, undefined);
  assert.deepEqual(item.tags, original.tags);
});
