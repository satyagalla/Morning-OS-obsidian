import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { TaskRegistry } from "../types";
import { todayStr } from "../utils";
import { hasActiveEditingSession } from "../editing-session";
import { cloneState, MorningState, STATE_SCHEMA_VERSION, StateValidationError, validateState } from "./schemas";

export const STATE_PATH = "_generated/data/state.json";
export const LEGACY_REGISTRY_PATH = "_generated/tasks.json";
const DATA_DIR = "_generated/data";
const SNAPSHOT_DIR = "_generated/snapshots";
const RECOVERY_DIR = "_generated/recovery";
const EXPORT_DIR = "_generated/exports";
const SNAPSHOT_RETENTION = 20;

export interface StateSnapshot {
  path: string;
  reason: "automatic" | "manual" | "pre-migration" | "pre-restore";
  createdAt: string;
  sourcePath: string;
  itemCount: number;
  valid: boolean;
  status: "valid" | "legacy" | "invalid";
  error?: string;
}

export interface RestoreResult {
  currentState: "valid" | "damaged" | "missing";
  itemCount: number;
  legacySnapshot: boolean;
  recoveryPath?: string;
}

export type StateCommitListener = (before: MorningState, after: MorningState) => void;

interface StoredSnapshot extends Omit<StateSnapshot, "path" | "valid" | "status" | "error"> {
  version: 1;
  checksum: string;
  raw: string;
}

interface StagedWrite {
  transactionId: string;
  checksum: string;
  state: MorningState;
}

interface ActiveBytes {
  exists: boolean;
  raw: string | null;
}

function checksum(value: string): string {
  // A deterministic corruption guard, not a cryptographic signature.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function timestamp(): string {
  const now = new Date();
  return `${todayStr()}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
}

function snapshotCreationTime(snapshot: StateSnapshot): number {
  const value = Date.parse(snapshot.createdAt);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

function transactionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureDirectory(app: App, path: string): Promise<void> {
  if (!(await app.vault.adapter.exists(path))) await app.vault.adapter.mkdir(path);
}

async function readText(app: App, path: string): Promise<string> {
  try {
    return await app.vault.adapter.read(path);
  } catch (error) {
    throw new StateValidationError(`could not read ${path}: ${(error as Error).message}`);
  }
}

function parseState(raw: string, path: string): MorningState {
  try {
    const parsed: unknown = JSON.parse(raw);
    validateState(parsed);
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new StateValidationError(`invalid ${path}: ${detail}`);
  }
}

function migratePersistedState(raw: string, path: string): MorningState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    return null;
  }
  const candidate = JSON.parse(JSON.stringify(parsed)) as MorningState;
  candidate.schemaVersion = STATE_SCHEMA_VERSION;
  if (Array.isArray(candidate.items)) {
    for (const item of candidate.items) {
      if (typeof item === "object" && item !== null && "calendar_reminder" in item) {
        // Version 1 never wrote this field. Reject an impossible mixed-version
        // state instead of guessing an ordering history.
        throw new StateValidationError(`invalid ${path}: calendar reminder history requires schema version 2`);
      }
    }
  }
  validateState(candidate);
  return candidate;
}

function normalizeLegacyTask(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateValidationError("legacy registry contains a non-object item");
  }
  const task = { ...(value as Record<string, unknown>) };
  if (typeof task._id !== "string" && typeof task.id === "string") task._id = task.id;
  if (typeof task.notes !== "string") task.notes = typeof task.details === "string" ? task.details : "";
  if (!Array.isArray(task.areas) && Array.isArray(task.pillars)) task.areas = task.pillars;
  if (!Array.isArray(task.areas)) task.areas = [];
  if (typeof task.tags !== "object" || task.tags === null || Array.isArray(task.tags)) task.tags = {};
  if (typeof task.status_completion !== "string") task.status_completion = task.done === true ? "done" : "open";
  if (typeof task.status_priority !== "string") task.status_priority = task.priority === "red" ? "red" : "regular";
  if (typeof task.status_urgency !== "string") task.status_urgency = task.urgency ?? "none";
  if (typeof task.is_today !== "boolean") task.is_today = task.in_today === true;
  if (typeof task.is_deleted !== "boolean") task.is_deleted = task.deleted === true;
  if (typeof task.parent_id !== "string") task.parent_id = null;
  if (typeof task.date_created !== "string") task.date_created = task.created ?? todayStr();
  if (typeof task.date_modified !== "string") task.date_modified = task.modified ?? task.date_created;
  if (typeof task.date_completed !== "string") task.date_completed = task.completed ?? null;
  if (typeof task.date_remind !== "string") task.date_remind = task.remind_date ?? null;
  if (task.kind === undefined) task.kind = "task";
  if (task.kind === "note") {
    const archived = task.status_note === "archived" || task.status_completion !== "open";
    task.status_note = archived ? "archived" : "active";
    task.status_completion = archived ? "done" : "open";
    if (archived && typeof task.date_completed !== "string") task.date_completed = task.date_modified;
  } else {
    delete task.status_note;
  }
  if (typeof task.details !== "string") task.details = task.notes;
  return task;
}

function stateFromLegacy(raw: string): MorningState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StateValidationError(`invalid ${LEGACY_REGISTRY_PATH}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new StateValidationError(`invalid ${LEGACY_REGISTRY_PATH}: expected an array`);
  const state: MorningState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    writtenAt: timestamp(),
    migration: { source: "legacy-tasks", migratedAt: timestamp(), legacyPath: LEGACY_REGISTRY_PATH },
    items: parsed.map(normalizeLegacyTask) as TaskRegistry,
  };
  validateState(state);
  return state;
}

export class StateStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private restoreRequested = false;
  private readonly commitListeners = new Set<StateCommitListener>();

  constructor(private readonly app: App) {}

  async initialize(): Promise<{ migrated: boolean; itemCount: number }> {
    if (await this.app.vault.adapter.exists(STATE_PATH)) {
      const raw = await readText(this.app, STATE_PATH);
      const migrated = migratePersistedState(raw, STATE_PATH);
      if (migrated) {
        await this.writeSnapshot(raw, "pre-migration", STATE_PATH, migrated.items.length);
        if (await readText(this.app, STATE_PATH) !== raw) {
          throw new StateValidationError("state changed while preparing migration; source and snapshot were preserved");
        }
        await this.commit(migrated, "schema-migration");
        return { migrated: true, itemCount: migrated.items.length };
      }
      const state = parseState(raw, STATE_PATH);
      return { migrated: false, itemCount: state.items.length };
    }
    await this.assertNoInterruptedActivation();
    if (!(await this.app.vault.adapter.exists(LEGACY_REGISTRY_PATH))) return { migrated: false, itemCount: 0 };

    const raw = await readText(this.app, LEGACY_REGISTRY_PATH);
    const candidate = stateFromLegacy(raw);
    await this.writeSnapshot(raw, "pre-migration", LEGACY_REGISTRY_PATH, candidate.items.length);
    // A migration is staged from exact source bytes. Do not activate a candidate
    // if a sync/provider changed that source while it was being prepared.
    if (await readText(this.app, LEGACY_REGISTRY_PATH) !== raw) {
      throw new StateValidationError("legacy registry changed while preparing migration; source and snapshot were preserved");
    }
    await this.commit(candidate, "migration");
    return { migrated: true, itemCount: candidate.items.length };
  }

  async read(): Promise<MorningState> {
    if (!(await this.app.vault.adapter.exists(STATE_PATH))) {
      await this.assertNoInterruptedActivation();
      if (!(await this.app.vault.adapter.exists(LEGACY_REGISTRY_PATH))) {
        return { schemaVersion: STATE_SCHEMA_VERSION, revision: 0, writtenAt: timestamp(), items: [] };
      }
      // Compatibility reads are in-memory only. They never activate a migration.
      return stateFromLegacy(await readText(this.app, LEGACY_REGISTRY_PATH));
    }
    const raw = await readText(this.app, STATE_PATH);
    return migratePersistedState(raw, STATE_PATH) ?? parseState(raw, STATE_PATH);
  }

  async update(mutator: (candidate: MorningState) => void, reason = "update"): Promise<MorningState> {
    return (await this.updateWithStates(mutator, reason)).after;
  }

  async updateWithStates(mutator: (candidate: MorningState) => void, reason = "update"): Promise<{ before: MorningState; after: MorningState }> {
    if (this.restoreRequested) {
      throw new StateValidationError("a restore is in progress; item edits are temporarily blocked");
    }
    return this.enqueue(async () => {
      const expectedActive = await this.readActiveBytes();
      const current = await this.read();
      const candidate = cloneState(current);
      mutator(candidate);
      candidate.revision = current.revision + 1;
      candidate.writtenAt = timestamp();
      validateState(candidate);
      if (JSON.stringify(current.items) === JSON.stringify(candidate.items) && JSON.stringify(current.definitions) === JSON.stringify(candidate.definitions)) {
        return { before: current, after: current };
      }
      await this.maybeAutomaticSnapshot(current);
      await this.commit(candidate, reason, expectedActive);
      this.notifyCommitted(current, candidate);
      return { before: current, after: candidate };
    });
  }

  onCommitted(listener: StateCommitListener): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  private notifyCommitted(before: MorningState, after: MorningState): void {
    for (const listener of this.commitListeners) {
      try {
        listener(before, after);
      } catch (error) {
        console.error("Morning OS state commit listener failed:", error);
      }
    }
  }

  async replaceItems(items: TaskRegistry, reason = "replace-items"): Promise<void> {
    await this.update(state => { state.items = JSON.parse(JSON.stringify(items)) as TaskRegistry; }, reason);
  }

  async backupNow(): Promise<string> {
    const state = await this.read();
    const raw = JSON.stringify(state, null, 2);
    return this.writeSnapshot(raw, "manual", STATE_PATH, state.items.length);
  }

  async listSnapshots(): Promise<StateSnapshot[]> {
    if (!(await this.app.vault.adapter.exists(SNAPSHOT_DIR))) return [];
    const paths = (await this.app.vault.adapter.list(SNAPSHOT_DIR)).files
      // The marker controls automatic snapshot cadence; it is not a backup.
      // Do not hide any other malformed JSON file from the recovery list.
      .filter(path => path.endsWith(".json") && path !== `${SNAPSHOT_DIR}/.last-automatic.json`);
    const snapshots: StateSnapshot[] = [];
    for (const path of paths) {
      try {
        const parsed = this.parseSnapshot(await readText(this.app, path), path);
        snapshots.push({
          path,
          reason: parsed.reason,
          createdAt: parsed.createdAt,
          sourcePath: parsed.sourcePath,
          itemCount: parsed.itemCount,
          valid: true,
          status: parsed.sourcePath === LEGACY_REGISTRY_PATH ? "legacy" : "valid",
        });
      } catch (error) {
        snapshots.push({
          path,
          reason: "manual",
          createdAt: "unknown",
          sourcePath: "unknown",
          itemCount: 0,
          valid: false,
          status: "invalid",
          error: (error as Error).message,
        });
      }
    }
    return snapshots.sort((a, b) => snapshotCreationTime(b) - snapshotCreationTime(a) || b.path.localeCompare(a.path));
  }

  async restoreSnapshot(path: string): Promise<RestoreResult> {
    if (hasActiveEditingSession()) {
      throw new StateValidationError("save or discard the active item draft before restoring a backup");
    }
    if (this.restoreRequested) throw new StateValidationError("a restore is already in progress");
    this.restoreRequested = true;
    try {
      return await this.enqueue(() => this.restoreSnapshotInQueue(path));
    } finally {
      this.restoreRequested = false;
    }
  }

  private async restoreSnapshotInQueue(path: string): Promise<RestoreResult> {
    if (!path.startsWith(`${SNAPSHOT_DIR}/`) || !path.endsWith(".json")) {
      throw new StateValidationError("snapshot path is outside the snapshot directory");
    }
    const snapshot = this.parseSnapshot(await readText(this.app, path), path);
    const legacySnapshot = snapshot.sourcePath === LEGACY_REGISTRY_PATH;
    const restored = legacySnapshot ? stateFromLegacy(snapshot.raw) : (migratePersistedState(snapshot.raw, path) ?? parseState(snapshot.raw, path));
    const activeBefore = await this.readActiveBytes();
    let currentState: RestoreResult["currentState"] = "missing";
    let recoveryPath: string | undefined;
    let currentRevision = -1;

    if (activeBefore.exists) {
      try {
        const current = migratePersistedState(activeBefore.raw!, STATE_PATH) ?? parseState(activeBefore.raw!, STATE_PATH);
        currentState = "valid";
        currentRevision = current.revision;
        await this.writeSnapshot(activeBefore.raw!, "pre-restore", STATE_PATH, current.items.length);
      } catch {
        currentState = "damaged";
        recoveryPath = await this.writeRawRecoveryCopy(activeBefore.raw!);
      }
    }

    // A damaged or absent active file cannot supply a revision. The selected,
    // already validated backup is the only input used in that case.
    restored.revision = Math.max(currentRevision, restored.revision) + 1;
    restored.writtenAt = timestamp();
    validateState(restored);
    await this.commit(restored, "restore-snapshot", activeBefore);
    return { currentState, itemCount: restored.items.length, legacySnapshot, recoveryPath };
  }

  async exportState(): Promise<string> {
    const state = await this.read();
    await ensureDirectory(this.app, "_generated");
    await ensureDirectory(this.app, EXPORT_DIR);
    const path = `${EXPORT_DIR}/morning-os-state-${todayStr()}-${transactionId()}.json`;
    const bytes = JSON.stringify(state, null, 2);
    await this.app.vault.adapter.write(path, bytes);
    if (await readText(this.app, path) !== bytes) throw new StateValidationError("state export verification failed");
    return path;
  }

  private async maybeAutomaticSnapshot(state: MorningState): Promise<void> {
    const markerPath = `${SNAPSHOT_DIR}/.last-automatic.json`;
    if (await this.app.vault.adapter.exists(markerPath)) {
      try {
        const marker = JSON.parse(await readText(this.app, markerPath)) as { date?: unknown };
        if (marker.date === todayStr()) return;
      } catch {
        // A damaged marker never authorizes deleting data; simply make a new snapshot.
      }
    }
    const path = await this.writeSnapshot(JSON.stringify(state, null, 2), "automatic", STATE_PATH, state.items.length);
    await this.app.vault.adapter.write(markerPath, JSON.stringify({ date: todayStr(), path }));
  }

  private parseSnapshot(raw: string, path: string): StoredSnapshot {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(raw);
    } catch (error) {
      throw new StateValidationError(`invalid snapshot ${path}: ${(error as Error).message}`);
    }
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new StateValidationError(`invalid snapshot ${path}: expected an object`);
    }
    const value = snapshot as Record<string, unknown>;
    if (value.version !== 1 || typeof value.raw !== "string" || typeof value.checksum !== "string" ||
      typeof value.createdAt !== "string" || typeof value.sourcePath !== "string" ||
      !Number.isInteger(value.itemCount) || !["automatic", "manual", "pre-migration", "pre-restore"].includes(value.reason as string)) {
      throw new StateValidationError(`invalid snapshot ${path}: unsupported snapshot fields`);
    }
    if (checksum(value.raw) !== value.checksum) throw new StateValidationError(`invalid snapshot ${path}: checksum mismatch`);
    if (value.sourcePath === STATE_PATH) migratePersistedState(value.raw, path) ?? parseState(value.raw, path);
    else if (value.sourcePath === LEGACY_REGISTRY_PATH) stateFromLegacy(value.raw);
    else throw new StateValidationError(`invalid snapshot ${path}: unsupported backup source ${value.sourcePath}`);
    return {
      version: 1,
      reason: value.reason as StateSnapshot["reason"],
      createdAt: value.createdAt,
      sourcePath: value.sourcePath,
      checksum: value.checksum,
      itemCount: value.itemCount as number,
      raw: value.raw,
    };
  }

  private async writeSnapshot(raw: string, reason: StateSnapshot["reason"], sourcePath: string, itemCount: number): Promise<string> {
    await ensureDirectory(this.app, "_generated");
    await ensureDirectory(this.app, SNAPSHOT_DIR);
    const id = transactionId();
    const path = `${SNAPSHOT_DIR}/${todayStr()}-${id}.json`;
    const snapshot: StoredSnapshot = { version: 1, reason, createdAt: timestamp(), sourcePath, checksum: checksum(raw), itemCount, raw };
    const bytes = JSON.stringify(snapshot, null, 2);
    await this.app.vault.adapter.write(path, bytes);
    const verified = await readText(this.app, path);
    if (verified !== bytes) throw new StateValidationError(`snapshot verification failed: ${path}`);
    this.parseSnapshot(verified, path);
    await this.pruneSnapshots();
    return path;
  }

  private async pruneSnapshots(): Promise<void> {
    // Manual, migration, pre-restore, invalid, and raw recovery material is
    // deliberately protected. These files may accumulate for investigation.
    const snapshots = (await this.listSnapshots()).filter(snapshot => snapshot.valid && snapshot.reason === "automatic");
    for (const snapshot of snapshots.slice(SNAPSHOT_RETENTION)) {
      const file = this.app.vault.getAbstractFileByPath(snapshot.path);
      if (!(file instanceof TFile)) continue;
      try {
        await this.app.fileManager.trashFile(file);
      } catch (error) {
        console.warn(`Morning OS could not prune snapshot ${snapshot.path}:`, error);
      }
    }
  }

  private async commit(candidate: MorningState, reason: string, expectedActive?: ActiveBytes): Promise<void> {
    validateState(candidate);
    await ensureDirectory(this.app, "_generated");
    await ensureDirectory(this.app, DATA_DIR);
    const activeBefore = expectedActive ?? await this.readActiveBytes();
    const bytes = JSON.stringify(candidate, null, 2);
    const staged: StagedWrite = { transactionId: transactionId(), checksum: checksum(bytes), state: candidate };
    const pendingPath = `${DATA_DIR}/.pending-${staged.transactionId}.json`;
    const journalPath = `${DATA_DIR}/.journal-${staged.transactionId}.json`;
    const stagedBytes = JSON.stringify(staged, null, 2);
    await this.app.vault.adapter.write(pendingPath, stagedBytes);
    if (await readText(this.app, pendingPath) !== stagedBytes) throw new StateValidationError("staged state verification failed");
    await this.app.vault.adapter.write(journalPath, JSON.stringify({ transactionId: staged.transactionId, checksum: staged.checksum, reason, statePath: STATE_PATH }));
    const activeNow = await this.readActiveBytes();
    if (activeNow.exists !== activeBefore.exists || activeNow.raw !== activeBefore.raw) {
      throw new StateValidationError("state changed while preparing a write; staged recovery data was preserved");
    }
    // Obsidian adapters do not expose one portable atomic replace primitive. Recovery
    // material stays in place until this exact active-state verification succeeds.
    await this.app.vault.adapter.write(STATE_PATH, bytes);
    const activeBytes = await readText(this.app, STATE_PATH);
    if (activeBytes !== bytes || checksum(activeBytes) !== staged.checksum) {
      throw new StateValidationError("active state verification failed; pending recovery data was preserved");
    }
    validateState(JSON.parse(activeBytes) as unknown);
    await this.cleanupCommittedArtifacts(pendingPath, journalPath);
  }

  /** Uses Obsidian's configured trash behavior. A configured trash may retain the
   * removed files; these artifacts are neither device-local storage nor a sync guarantee. */
  private async cleanupCommittedArtifacts(pendingPath: string, journalPath: string): Promise<void> {
    for (const path of [pendingPath, journalPath]) {
      try {
        // A just-written adapter path may not have been indexed into a TFile yet.
        // In that case preserve it rather than reaching for adapter-level deletion.
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          console.warn(`Morning OS committed state but could not clean up transaction artifact ${path}: file was not indexed`);
          continue;
        }
        await this.app.fileManager.trashFile(file);
      } catch (error) {
        // Saving already succeeded. This warning must never turn it into a failed
        // edit or invite a duplicate retry.
        console.warn(`Morning OS committed state but could not clean up transaction artifact ${path}:`, error);
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.writeQueue.then(operation, operation);
    this.writeQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private async readActiveBytes(): Promise<ActiveBytes> {
    if (!(await this.app.vault.adapter.exists(STATE_PATH))) return { exists: false, raw: null };
    return { exists: true, raw: await readText(this.app, STATE_PATH) };
  }

  private async writeRawRecoveryCopy(raw: string): Promise<string> {
    await ensureDirectory(this.app, "_generated");
    await ensureDirectory(this.app, RECOVERY_DIR);
    const path = `${RECOVERY_DIR}/damaged-state-${todayStr()}-${transactionId()}.raw`;
    await this.app.vault.adapter.write(path, raw);
    if (await readText(this.app, path) !== raw) {
      throw new StateValidationError(`damaged-state recovery copy verification failed: ${path}`);
    }
    return path;
  }

  /** Pending files are not shared authority. They can only block an unsafe
   * empty initialization when they form a locally-shaped, verified pair. A
   * recovery UI/manual export must decide activation; unrelated transient files
   * are never used as a state source. */
  private async assertNoInterruptedActivation(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(DATA_DIR))) return;
    const files = (await this.app.vault.adapter.list(DATA_DIR)).files;
    const pending = files.filter(path => /\/\.pending-[^/]+\.json$/.test(path));
    const journals = new Set(files.filter(path => /\/\.journal-[^/]+\.json$/.test(path)));
    for (const pendingPath of pending) {
      const id = pendingPath.match(/\.pending-([^/]+)\.json$/)?.[1];
      if (!id || !journals.has(`${DATA_DIR}/.journal-${id}.json`)) continue;
      try {
        const staged = JSON.parse(await readText(this.app, pendingPath)) as Partial<StagedWrite>;
        const journal = JSON.parse(await readText(this.app, `${DATA_DIR}/.journal-${id}.json`)) as Record<string, unknown>;
        if (staged.transactionId !== id || typeof staged.checksum !== "string" || !staged.state ||
          journal.transactionId !== id || journal.checksum !== staged.checksum || journal.statePath !== STATE_PATH) continue;
        validateState(staged.state);
        if (checksum(JSON.stringify(staged.state, null, 2)) !== staged.checksum) continue;
        throw new StateValidationError("authoritative state is missing after an interrupted write; verified recovery material was preserved and must be recovered explicitly");
      } catch (error) {
        if (error instanceof StateValidationError && error.message.includes("interrupted write")) throw error;
        // Invalid or foreign transient material is preserved but never trusted.
      }
    }
  }
}

const stores = new WeakMap<App, StateStore>();

export function getStateStore(app: App): StateStore {
  let store = stores.get(app);
  if (!store) {
    store = new StateStore(app);
    stores.set(app, store);
  }
  return store;
}
