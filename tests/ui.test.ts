import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { Window } from "happy-dom";
import { App, Component, TFile, WorkspaceLeaf } from "obsidian";
import { applyFilters, AreaView, DumpView, getChildOnlySearchMatches, MorningView, renderFilterSelects, renderTaskRowShared, sortItemsByStatus, attachInlineTextEdit, TaskEditModal } from "../src/view";
import { beginEditingSession, disposeEditorsIn, hasActiveEditingSession, registerEditorCleanup } from "../src/editing-session";
import type { Task } from "../src/types";
import { DEFAULT_SETTINGS, MorningOSSettingTab } from "../src/settings";
import { STATE_PATH, StateStore } from "../src/data/state-store";
import type { StateSnapshot } from "../src/data/state-store";
import { todayStr } from "../src/utils";

type CreateOptions = { cls?: string; text?: string; type?: string; value?: string; placeholder?: string; attr?: Record<string, string> };

function installDom(width = 1024): Window {
  const window = new Window({ url: "https://morning-os.test", width });
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node });
  const proto = window.HTMLElement.prototype as unknown as {
    createEl: (tag: string, options?: CreateOptions) => HTMLElement;
    createDiv: (options?: CreateOptions) => HTMLDivElement;
    createSpan: (options?: CreateOptions) => HTMLSpanElement;
    addClass: (name: string) => void;
    removeClass: (name: string) => void;
    toggleClass: (name: string, value: boolean) => void;
    setText: (text: string) => void;
    appendText: (text: string) => void;
    setCssStyles: (styles: Record<string, string>) => void;
    empty: () => void;
  };
  const create = function(this: HTMLElement, tag: string, options: CreateOptions = {}): HTMLElement {
    const element = window.document.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.type) element.setAttribute("type", options.type);
    if (options.value !== undefined) element.setAttribute("value", options.value);
    if (options.placeholder) element.setAttribute("placeholder", options.placeholder);
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
    this.appendChild(element);
    return element;
  };
  proto.createEl = create;
  proto.createDiv = function(options?: CreateOptions) { return create.call(this, "div", options) as HTMLDivElement; };
  proto.createSpan = function(options?: CreateOptions) { return create.call(this, "span", options) as HTMLSpanElement; };
  proto.addClass = function(name: string) { this.classList.add(name); };
  proto.removeClass = function(name: string) { this.classList.remove(name); };
  proto.toggleClass = function(name: string, value: boolean) { this.classList.toggle(name, value); };
  proto.setText = function(text: string) { this.textContent = text; };
  proto.appendText = function(text: string) { this.append(text); };
  proto.setCssStyles = function(styles: Record<string, string>) { Object.assign(this.style, styles); };
  proto.empty = function() { this.replaceChildren(); };
  (globalThis as unknown as { createEl: (tag: string) => HTMLElement }).createEl = tag => window.document.createElement(tag);
  applyStyles(window);
  return window;
}

function closeDom(t: TestContext, window: Window): void {
  t.after(async () => {
    await window.happyDOM.abort();
    await window.happyDOM.close();
  });
}

function applyStyles(window: Window): void {
  window.document.querySelector("style[data-morning-os-test]")?.remove();
  const style = window.document.createElement("style");
  style.setAttribute("data-morning-os-test", "");
  style.textContent = readFileSync("styles/styles.css", "utf8");
  window.document.head.appendChild(style);
}

function item(id: string, kind: "task" | "note" = "task"): Task {
  return {
    _id: id,
    text: id,
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
    kind,
    status_note: kind === "note" ? "active" : undefined,
  };
}

function openViewOptions(root: HTMLElement): HTMLElement {
  root.querySelector<HTMLButtonElement>(".mos-view-options-button")!.click();
  return root.querySelector<HTMLElement>(".mos-view-options-panel")!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function viewPlugin(settings: Record<string, unknown>) {
  return {
    settings,
    activateView: () => undefined, activateAllItems: () => undefined, activateDump: () => undefined,
    activateTrash: () => undefined, activateArea: () => undefined, regenerateBriefing: async () => undefined,
    refreshView: () => undefined, autoRefreshBrief: async () => undefined,
  };
}

function stateBytes(tasks: Task[], revision = 1): string {
  return JSON.stringify({ schemaVersion: 1, revision, writtenAt: "2026-09-17T10:00:00", items: tasks });
}

function pendingWriteAdapter(initial: Task[]) {
  const files = new Map([[STATE_PATH, stateBytes(initial)]]);
  const pendingStarted = deferred<void>();
  const releasePending = deferred<void>();
  const pendingSettled = deferred<void>();
  const stateWritten = deferred<void>();
  let pendingWrites = 0;
  const adapter = {
    exists: async (path: string) => files.has(path) || path.startsWith("_generated"),
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => {
      if (/\/\.pending-[^/]+\.json$/.test(path)) {
        pendingWrites++;
        pendingStarted.resolve();
        try { await releasePending.promise; }
        finally { pendingSettled.resolve(); }
      }
      files.set(path, value);
      if (path === STATE_PATH) stateWritten.resolve();
    },
    mkdir: async () => undefined,
    list: async () => ({ files: [], folders: [] as string[] }),
  };
  const app = Object.assign(new App(), {
    vault: { adapter, getAbstractFileByPath: (path: string) => new TFile(path) },
    fileManager: { trashFile: async (file: TFile) => { files.delete(file.path); } },
  }) as never;
  return { app, files, pendingStarted, releasePending, pendingSettled, stateWritten, getPendingWrites: () => pendingWrites };
}

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  });
}

test("compact recovery list renders every backup with action states, confirmation, and refresh", async t => {
  const window = installDom(420);
  closeDom(t, window);
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const adapter = {
    exists: async (path: string) => files.has(path) || directories.has(path),
    mkdir: async (path: string) => { directories.add(path); },
    list: async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${path}/`)), folders: [] as string[] }),
    read: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    write: async (path: string, value: string) => { files.set(path, value); },
  };
  const current = item("backup-item");
  files.set(STATE_PATH, JSON.stringify({ schemaVersion: 1, revision: 0, writtenAt: "2026-09-16T10:00:00", items: [current] }));
  const app = {
    vault: { adapter, getAbstractFileByPath: (path: string) => new TFile(path) },
    fileManager: { trashFile: async (file: TFile) => { files.delete(file.path); } },
  };
  const store = new StateStore(app as never);
  const snapshotPath = await store.backupNow();
  const realSnapshot = (await store.listSnapshots())[0];
  const snapshots: StateSnapshot[] = Array.from({ length: 25 }, (_, index) => ({
    ...realSnapshot,
    path: index === 0 ? snapshotPath : `_generated/snapshots/very-long-backup-name-${index}.json`,
    createdAt: `2026-09-16T10:${String(index).padStart(2, "0")}:00.000`,
    reason: index % 3 === 0 ? "manual" : "automatic",
    itemCount: index + 1,
    valid: index % 5 !== 0,
    status: index % 5 === 0 ? "invalid" : index % 7 === 0 ? "legacy" : "valid",
    error: index % 5 === 0 ? "Checksum mismatch: preserved for investigation" : undefined,
  }));
  snapshots[0] = { ...realSnapshot, path: snapshotPath, status: "valid", valid: true };
  let refreshes = 0;
  const plugin = { settings: { ...DEFAULT_SETTINGS }, saveData: async () => undefined, refreshView: async () => { refreshes++; } };
  const tab = new MorningOSSettingTab(app as never, plugin as never);
  tab.containerEl = window.document.body;
  const privateTab = tab as unknown as { activeSettingsTab: string; recoverySnapshots: StateSnapshot[]; renderDataSafetySection: (parent: HTMLElement) => void };
  privateTab.activeSettingsTab = "advanced";
  privateTab.recoverySnapshots = snapshots;
  privateTab.renderDataSafetySection(window.document.body);

  const disclosure = window.document.querySelector<HTMLDetailsElement>(".mos-recovery-disclosure")!;
  assert.equal(disclosure.open, false);
  assert.match(disclosure.querySelector("summary")!.textContent ?? "", /Available backups \(25\)/);
  disclosure.open = true;
  disclosure.dispatchEvent(new window.Event("toggle"));
  assert.equal(window.document.querySelectorAll(".mos-recovery-row").length, 25);
  const invalid = window.document.querySelector<HTMLButtonElement>(".mos-recovery-status.is-invalid")!.parentElement!.parentElement!.querySelector<HTMLButtonElement>("button")!;
  assert.equal(invalid.disabled, true);
  assert.match(window.document.body.textContent ?? "", /Checksum mismatch/);
  let confirmation = "";
  window.confirm = message => { confirmation = message; return true; };
  window.document.querySelector<HTMLButtonElement>(".mos-recovery-restore-button")!.click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.match(confirmation, /replaces the whole Morning OS item state; it does not merge changes/);
  assert.equal(refreshes, 1);
  assert.ok(window.document.querySelector(".mos-recovery-list"));
  assert.equal((window.document.querySelector<HTMLDetailsElement>(".mos-recovery-disclosure")!).open, true);
});

test("continuous search preserves raw text, focus, selection, and child-match context", t => {
  const window = installDom();
  closeDom(t, window);
  const controls = window.document.body.createDiv();
  let receivedQuery = "";
  renderFilterSelects(controls, {}, () => assert.fail("query input must not rebuild controls"), false, undefined, filters => {
    receivedQuery = filters.query ?? "";
  });
  const search = controls.querySelector<HTMLInputElement>("input[type=search]")!;

  for (const value of ["child", "child match", "child match ", "child match  ", "child match ", "child match"]) {
    search.value = value;
    search.focus();
    search.setSelectionRange(2, value.length);
    search.dispatchEvent(new window.Event("input"));
    assert.equal(window.document.activeElement, search);
    assert.equal(search.value, value);
    assert.equal(search.selectionStart, 2);
    assert.equal(receivedQuery, value);
  }

  const parent = item("parent");
  const child = item("child");
  child.text = "Child match";
  child.parent_id = parent._id;
  assert.deepEqual(applyFilters([parent], { query: "child match" }, [parent, child]).map(value => value._id), ["parent"]);
  assert.deepEqual(applyFilters([parent], { query: "   " }, [parent, child]).map(value => value._id), ["parent"]);
});

test("editor cleanup is idempotent when a rendered region is replaced", t => {
  const window = installDom();
  closeDom(t, window);
  const region = window.document.body.createDiv();
  const scope = region.createDiv();
  const finish = beginEditingSession();
  let cleanups = 0;
  registerEditorCleanup(scope, () => { cleanups++; finish(); });
  assert.equal(hasActiveEditingSession(), true);
  disposeEditorsIn(region);
  disposeEditorsIn(region);
  assert.equal(cleanups, 1);
  assert.equal(hasActiveEditingSession(), false);
});

test("deleted Details save exposes each recovery value without recreating the item", async t => {
  const window = installDom();
  closeDom(t, window);
  const draft = item("deleted-modal");
  const files = new Map<string, string>();
  files.set(STATE_PATH, JSON.stringify({ schemaVersion: 1, revision: 1, writtenAt: "2026-09-16T10:00:00", items: [draft] }));
  const adapter = {
    exists: async (path: string) => files.has(path) || path.startsWith("_generated"),
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); },
    mkdir: async () => undefined,
    list: async () => ({ files: [], folders: [] }),
  };
  const app = { vault: { adapter, getAbstractFileByPath: (path: string) => new TFile(path) }, fileManager: { trashFile: async () => undefined } } as never;
  const modal = new TaskEditModal(app, draft, () => assert.fail("deleted draft must not refresh or recreate"));
  modal.contentEl = window.document.body.createDiv();
  modal.onOpen();
  const title = modal.contentEl.querySelector<HTMLInputElement>('input[type="text"]')!;
  title.value = "Changed title";
  title.dispatchEvent(new window.Event("input"));
  const details = modal.contentEl.querySelector<HTMLTextAreaElement>("textarea")!;
  details.value = "Changed Details";
  details.dispatchEvent(new window.Event("input"));
  const state = JSON.parse(files.get(STATE_PATH)!) as { items: Task[] };
  state.items[0].is_deleted = true;
  files.set(STATE_PATH, JSON.stringify(state));
  const mutable = modal as unknown as { task: Task; saveDraft: () => Promise<void> };
  mutable.task.kind = "note";
  mutable.task.status_note = "active";
  mutable.task.areas = ["work"];
  mutable.task.tags = { stage: "Applied" };
  mutable.task.date_remind = "2026-10-01";
  await mutable.saveDraft();
  assert.ok(modal.contentEl.querySelector(".mos-edit-conflict"), "saving a deleted draft must render recovery automatically");
  const recovery = [...modal.contentEl.querySelectorAll<HTMLTextAreaElement>("textarea")].at(-1)!;
  assert.equal(recovery.readOnly, true);
  const recovered = JSON.parse(recovery.value) as { title: string; details: string; kind: string; taskStatus: string; noteStatus: string; placement: { areas: string[]; parentId: string | null }; customFields: Record<string, string>; reminder: string; today: boolean; todayPriority: string; urgency: string };
  assert.equal(recovered.title, "Changed title");
  assert.equal(recovered.details, "Changed Details");
  assert.equal(recovered.kind, "note");
  assert.equal(recovered.taskStatus, "open");
  assert.equal(recovered.noteStatus, "active");
  assert.deepEqual(recovered.placement, { areas: ["work"], parentId: null });
  assert.deepEqual(recovered.customFields, { stage: "Applied" });
  assert.equal(recovered.reminder, "2026-10-01");
  assert.equal(recovered.today, false);
  assert.equal(recovered.todayPriority, "regular");
  assert.equal(recovered.urgency, "none");
  const afterSave = JSON.parse(files.get(STATE_PATH)!) as { items: Task[] };
  assert.equal(afterSave.items.length, 1);
  assert.equal(afterSave.items[0].is_deleted, true);
  modal.close();
  assert.equal(hasActiveEditingSession(), false);
});

test("closing inline editors during normal and forced saves leaves only the completed storage outcome", async t => {
  const window = installDom();
  closeDom(t, window);
  t.after(() => disposeEditorsIn(window.document.body));

  const exerciseNormal = async (reject: boolean) => {
    const original = item(`inline-normal-${reject ? "failure" : "success"}`);
    const controlled = pendingWriteAdapter([original]);
    const row = window.document.body.createDiv();
    const text = row.createSpan({ text: original.text });
    let saved = 0;
    const saveSettled = deferred<void>();
    attachInlineTextEdit(controlled.app, text, original, () => { saved++; }, undefined, () => saveSettled.resolve());
    text.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    const input = row.querySelector<HTMLInputElement>(".mos-inline-edit")!;
    input.value = "Saved after close";
    let focusAfterClose = 0;
    input.focus = () => { focusAfterClose++; };
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await controlled.pendingStarted.promise;
    assert.equal(controlled.getPendingWrites(), 1, "duplicate save gestures must share the in-flight operation");
    disposeEditorsIn(row);
    row.empty();
    assert.equal(hasActiveEditingSession(), false);
    if (reject) {
      controlled.releasePending.reject(new Error("write rejected"));
      await controlled.pendingSettled.promise;
    } else {
      controlled.releasePending.resolve();
      await controlled.stateWritten.promise;
    }
    await saveSettled.promise;
    assert.equal(saved, 0);
    assert.equal(focusAfterClose, 0);
    assert.equal(row.querySelector(".mos-edit-conflict"), null);
    const persisted = JSON.parse(controlled.files.get(STATE_PATH)!) as { items: Task[] };
    assert.equal(persisted.items[0].text, reject ? original.text : "Saved after close");
  };

  const exerciseForced = async (reject: boolean) => {
    const original = item(`inline-forced-${reject ? "failure" : "success"}`);
    const controlled = pendingWriteAdapter([original]);
    const row = window.document.body.createDiv();
    const text = row.createSpan({ text: original.text });
    let saved = 0;
    const saveSettled = deferred<void>();
    let settledSaves = 0;
    attachInlineTextEdit(controlled.app, text, original, () => { saved++; }, undefined, () => {
      settledSaves++;
      if (settledSaves === 2) saveSettled.resolve();
    });
    text.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    const input = row.querySelector<HTMLInputElement>(".mos-inline-edit")!;
    input.value = "My forced draft";
    const external = { ...original, text: "External text" };
    controlled.files.set(STATE_PATH, stateBytes([external], 2));
    const conflictRendered = new Promise<void>(resolve => {
      const observer = new window.MutationObserver(() => {
        if (row.querySelector(".mos-edit-conflict")) { observer.disconnect(); resolve(); }
      });
      observer.observe(row, { childList: true, subtree: true });
    });
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await conflictRendered;
    let focusAfterClose = 0;
    input.focus = () => { focusAfterClose++; };
    const useMine = row.querySelector<HTMLButtonElement>(".mos-edit-conflict .mos-btn-primary")!;
    useMine.click();
    useMine.click();
    await controlled.pendingStarted.promise;
    assert.equal(controlled.getPendingWrites(), 1, "Use my draft must not begin a duplicate forced save");
    disposeEditorsIn(row);
    row.empty();
    if (reject) {
      controlled.releasePending.reject(new Error("forced write rejected"));
      await controlled.pendingSettled.promise;
    } else {
      controlled.releasePending.resolve();
      await controlled.stateWritten.promise;
    }
    await saveSettled.promise;
    assert.equal(hasActiveEditingSession(), false);
    assert.equal(saved, 0);
    assert.equal(focusAfterClose, 0);
    assert.equal(row.querySelector(".mos-edit-conflict"), null);
    const persisted = JSON.parse(controlled.files.get(STATE_PATH)!) as { items: Task[] };
    assert.equal(persisted.items[0].text, reject ? "External text" : "My forced draft");
  };

  await exerciseNormal(false);
  await exerciseNormal(true);
  await exerciseForced(false);
  await exerciseForced(true);
});

test("closing Details saves during persistence neither refreshes nor changes failed state", async t => {
  const window = installDom();
  closeDom(t, window);
  t.after(() => disposeEditorsIn(window.document.body));
  for (const reject of [false, true]) {
    const original = item(`modal-${reject ? "failure" : "success"}`);
    const controlled = pendingWriteAdapter([original]);
    let saved = 0;
    const modal = new TaskEditModal(controlled.app, original, () => { saved++; });
    modal.contentEl = window.document.body.createDiv();
    modal.onOpen();
    const title = modal.contentEl.querySelector<HTMLInputElement>('input[type="text"]')!;
    title.value = "Modal saved after close";
    title.dispatchEvent(new window.Event("input"));
    const mutable = modal as unknown as { saveDraft: () => Promise<void> };
    const saveOperation = mutable.saveDraft();
    await controlled.pendingStarted.promise;
    assert.equal(controlled.getPendingWrites(), 1);
    modal.close();
    assert.equal(hasActiveEditingSession(), false);
    if (reject) {
      controlled.releasePending.reject(new Error("modal write rejected"));
      await controlled.pendingSettled.promise;
    } else {
      controlled.releasePending.resolve();
      await controlled.stateWritten.promise;
    }
    await saveOperation;
    assert.equal(saved, 0);
    assert.equal(modal.contentEl.childElementCount, 0);
    const persisted = JSON.parse(controlled.files.get(STATE_PATH)!) as { items: Task[] };
    assert.equal(persisted.items[0].text, reject ? original.text : "Modal saved after close");
  }
});

test("Area, Inbox, and All Items reject a stale opening registry after close and reopen", async t => {
  const window = installDom();
  closeDom(t, window);
  const exercise = async (makeView: (plugin: ReturnType<typeof viewPlugin>) => AreaView | DumpView, settings: Record<string, unknown>) => {
    const firstRead = deferred<string>();
    const secondRead = deferred<string>();
    let reads = 0;
    const adapter = {
      exists: async () => true,
      read: async (path: string) => path === STATE_PATH ? (++reads === 1 ? firstRead.promise : secondRead.promise) : "",
      write: async () => undefined,
      mkdir: async () => undefined,
      list: async () => ({ files: [], folders: [] }),
    };
    const plugin = viewPlugin(settings);
    const view = makeView(plugin);
    const internals = view as unknown as { app: App; containerEl: HTMLElement; registry: Task[]; render: () => void };
    internals.app = { vault: { adapter, getAbstractFileByPath: () => null }, fileManager: { trashFile: async () => undefined } } as never;
    const shell = window.document.body.createDiv(); shell.createDiv(); shell.createDiv();
    internals.containerEl = shell;
    const renders: string[] = [];
    internals.render = () => { renders.push(internals.registry[0]?.text ?? "empty"); };
    const openingA = view.onOpen();
    await Promise.resolve();
    await view.onClose();
    const openingB = view.onOpen();
    await Promise.resolve();
    const newer = item("newer"); newer.text = "newer";
    secondRead.resolve(JSON.stringify({ schemaVersion: 1, revision: 2, writtenAt: "2026-09-17T10:00:00", items: [newer] }));
    await openingB;
    const older = item("older"); older.text = "older";
    firstRead.resolve(JSON.stringify({ schemaVersion: 1, revision: 1, writtenAt: "2026-09-17T09:00:00", items: [older] }));
    await openingA;
    assert.deepEqual(renders, ["newer"]);
    assert.equal(internals.registry[0]?.text, "newer");
  };
  const area = { key: "race", label: "Race", icon: "R", tabs: [], feedToLLM: false };
  await exercise(plugin => new AreaView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, area.key), { areas: [area], advancedAreaFeatures: false, dailyNoteDir: "Daily", showNotesIndicator: true, requireSubtasksComplete: false });
  await exercise(plugin => new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never), { areas: [], showNotesIndicator: true, requireSubtasksComplete: false });
  await exercise(plugin => new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, true), { areas: [], showNotesIndicator: true, requireSubtasksComplete: false });
});

test("Area, Inbox, and All Items ignore an ordinary refresh read completed after close", async t => {
  const window = installDom();
  closeDom(t, window);
  const exercise = async (makeView: (plugin: ReturnType<typeof viewPlugin>) => AreaView | DumpView, settings: Record<string, unknown>) => {
    const first = item("visible");
    let current = first;
    const staleRead = deferred<string>();
    let pauseRefresh = false;
    const adapter = {
      exists: async () => true,
      read: async () => pauseRefresh ? staleRead.promise : stateBytes([current]),
      write: async () => undefined, mkdir: async () => undefined, list: async () => ({ files: [], folders: [] as string[] }),
    };
    const plugin = viewPlugin(settings);
    const view = makeView(plugin);
    const internals = view as unknown as { app: App; containerEl: HTMLElement; registry: Task[]; render: () => void };
    internals.app = Object.assign(new App(), { vault: { adapter, getAbstractFileByPath: () => null }, fileManager: { trashFile: async () => undefined } }) as never;
    const shell = window.document.body.createDiv(); shell.createDiv(); shell.createDiv(); internals.containerEl = shell;
    await view.onOpen();
    const rendered = shell.children[1]!.firstElementChild;
    let renders = 0;
    const render = internals.render.bind(view);
    internals.render = () => { renders++; render(); };
    pauseRefresh = true;
    const refresh = view.refresh();
    await Promise.resolve();
    await view.onClose();
    const newer = item("newer"); newer.text = "newer";
    current = newer;
    pauseRefresh = false;
    await view.onOpen();
    const reopened = shell.children[1]!.firstElementChild;
    const stale = item("stale"); stale.text = "stale";
    staleRead.resolve(stateBytes([stale], 2));
    await refresh;
    assert.equal(renders, 1, "only the current reopening may render");
    assert.equal(internals.registry[0]?.text, "newer");
    assert.notEqual(reopened, rendered);
    assert.equal(shell.children[1]!.firstElementChild, reopened, "the stale refresh must not recreate the reopened view");
  };
  const area = { key: "work", label: "Work", icon: "W", tabs: [], feedToLLM: false };
  await exercise(plugin => new AreaView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, area.key), { areas: [area], advancedAreaFeatures: false, dailyNoteDir: "Daily", showNotesIndicator: true, requireSubtasksComplete: false });
  await exercise(plugin => new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never), { areas: [], showNotesIndicator: true, requireSubtasksComplete: false });
  await exercise(plugin => new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, true), { areas: [], showNotesIndicator: true, requireSubtasksComplete: false });
});

test("a deferred Area layout refresh completes after a real inline save and retains the layout request", async t => {
  const window = installDom();
  closeDom(t, window);
  t.after(() => disposeEditorsIn(window.document.body));
  const task = item("deferred-layout"); task.areas = ["work"]; task.tags = { work: "tab", stage: "Applied" };
  const controlled = pendingWriteAdapter([task]);
  const area = { key: "work", label: "Work", icon: "W", feedToLLM: false, tabs: [{ key: "tab", label: "Tab", fields: [{ key: "stage", label: "Stage", type: "dropdown" as const, options: ["Applied"] }], view_mode: "cards" as const }] };
  const settings = { areas: [area], advancedAreaFeatures: true, dailyNoteDir: "Daily", showNotesIndicator: true, requireSubtasksComplete: false };
  const plugin = viewPlugin(settings);
  const view = new AreaView(new WorkspaceLeaf(), settings as never, plugin as never, area.key);
  const internals = view as unknown as { app: App; containerEl: HTMLElement };
  internals.app = controlled.app;
  const shell = window.document.body.createDiv(); shell.createDiv(); shell.createDiv(); internals.containerEl = shell;
  await view.onOpen();
  shell.querySelector<HTMLElement>(".morning-os-task-text")!.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  const input = shell.querySelector<HTMLInputElement>(".mos-inline-edit")!;
  input.value = "Preserved draft";
  await view.refresh(false);
  settings.advancedAreaFeatures = false;
  await view.refresh(true);
  await view.refresh(false);
  assert.equal(shell.querySelector<HTMLInputElement>(".mos-inline-edit"), input, "a deferred layout refresh must not replace an active editor");
  const layoutRendered = new Promise<void>(resolve => {
    const observer = new window.MutationObserver(() => {
      if (!shell.querySelector(".mos-inline-edit") && !shell.textContent?.includes("Stage")) { observer.disconnect(); resolve(); }
    });
    observer.observe(shell, { childList: true, subtree: true });
  });
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await controlled.pendingStarted.promise;
  controlled.releasePending.resolve();
  await controlled.stateWritten.promise;
  await layoutRendered;
  assert.equal(hasActiveEditingSession(), false);
  assert.equal(shell.querySelector("select[aria-label=\"Stage\"]"), null);
  const persisted = JSON.parse(controlled.files.get(STATE_PATH)!) as { items: Task[] };
  assert.equal(persisted.items[0].text, "Preserved draft");
});

test("deferred Area refresh is cancelled on close and layout wins over results", async t => {
  const window = installDom();
  closeDom(t, window);
  const task = item("deferred-area"); task.areas = ["work"]; task.tags = { work: "tab", stage: "Applied" };
  const files = new Map([[STATE_PATH, JSON.stringify({ schemaVersion: 1, revision: 1, writtenAt: "2026-09-17T10:00:00", items: [task] })]]);
  const adapter = { exists: async () => true, read: async () => files.get(STATE_PATH)!, write: async () => undefined, mkdir: async () => undefined, list: async () => ({ files: [], folders: [] }) };
  const area = { key: "work", label: "Work", icon: "W", feedToLLM: false, tabs: [{ key: "tab", label: "Tab", fields: [{ key: "stage", label: "Stage", type: "dropdown" as const, options: ["Applied"] }], view_mode: "cards" as const }] };
  const plugin = viewPlugin({ areas: [area], advancedAreaFeatures: true, showNotesIndicator: true, requireSubtasksComplete: false });
  const view = new AreaView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, area.key);
  const internals = view as unknown as { app: App; containerEl: HTMLElement; registry: Task[]; activeTab: string; filters: { custom?: Record<string, string> }; render: () => void; refreshQueued: string | null };
  internals.app = Object.assign(new App(), { vault: { adapter, getAbstractFileByPath: () => null }, fileManager: { trashFile: async () => undefined } }) as never;
  const shell = window.document.body.createDiv(); shell.createDiv(); shell.createDiv(); internals.containerEl = shell; internals.registry = [task]; internals.activeTab = "tab";
  let renders = 0; internals.render = () => { renders++; };
  const finish = beginEditingSession();
  await view.refresh(false);
  await view.refresh(true);
  assert.equal(internals.refreshQueued, "layout");
  await view.onClose();
  finish();
  await Promise.resolve();
  assert.equal(renders, 0, "a closed view must not render its deferred refresh");
  assert.equal(hasActiveEditingSession(), false);
});

test("layout refresh rebuilds Area custom controls and clears invalid custom filters without changing metadata", async t => {
  const window = installDom();
  closeDom(t, window);
  const task = item("custom-layout"); task.areas = ["work"]; task.tags = { work: "tab", stage: "Applied", preserved: "metadata" };
  const files = new Map([[STATE_PATH, JSON.stringify({ schemaVersion: 1, revision: 1, writtenAt: "2026-09-17T10:00:00", items: [task] })]]);
  const adapter = { exists: async () => true, read: async () => files.get(STATE_PATH)!, write: async () => undefined, mkdir: async () => undefined, list: async () => ({ files: [], folders: [] }) };
  const area = { key: "work", label: "Work", icon: "W", feedToLLM: false, tabs: [{ key: "tab", label: "Tab", fields: [{ key: "stage", label: "Stage", type: "dropdown" as const, options: ["Applied"] }], view_mode: "cards" as const }] };
  const settings = { areas: [area], advancedAreaFeatures: true, dailyNoteDir: "Daily", showNotesIndicator: true, requireSubtasksComplete: false };
  const plugin = viewPlugin(settings);
  const view = new AreaView(new WorkspaceLeaf(), settings as never, plugin as never, area.key);
  const internals = view as unknown as { app: App; containerEl: HTMLElement; registry: Task[]; activeTab: string; filters: { custom?: Record<string, string> }; render: () => void };
  internals.app = Object.assign(new App(), { vault: { adapter, getAbstractFileByPath: () => null }, fileManager: { trashFile: async () => undefined } }) as never;
  const shell = window.document.body.createDiv(); shell.createDiv(); shell.createDiv(); internals.containerEl = shell; internals.registry = [task]; internals.activeTab = "tab";
  internals.render = AreaView.prototype.render.bind(view);
  internals.render();
  internals.filters = { custom: { stage: "Applied" } };
  settings.advancedAreaFeatures = false;
  await view.refresh(true);
  assert.equal(shell.querySelector('[aria-label="Stage"]'), null);
  assert.equal(internals.filters.custom, undefined);
  assert.equal(task.tags.stage, "Applied");
  settings.advancedAreaFeatures = true;
  area.tabs[0].fields[0].options = ["Interview"];
  internals.filters = { custom: { stage: "Applied" } };
  await view.refresh(true);
  assert.equal(shell.querySelector<HTMLSelectElement>('[aria-label="Stage"]')?.querySelector('option[value="Interview"]')?.textContent, "Interview");
  assert.equal(internals.filters.custom, undefined);
  assert.equal(task.tags.stage, "Applied");
});

test("search ignores deleted children and renders only live child-only matches without changing collapse preference", t => {
  const window = installDom();
  closeDom(t, window);
  const parent = item("search-parent");
  parent.text = "Contextual parent";
  const matchingChild = item("search-match");
  matchingChild.text = "Live matching child";
  matchingChild.parent_id = parent._id;
  const unrelatedChild = item("search-other");
  unrelatedChild.text = "Unrelated sibling";
  unrelatedChild.parent_id = parent._id;
  const deletedChild = item("search-deleted");
  deletedChild.text = "Deleted matching child";
  deletedChild.parent_id = parent._id;
  deletedChild.is_deleted = true;
  const registry = [parent, matchingChild, unrelatedChild, deletedChild];

  assert.deepEqual(applyFilters([parent], { query: "deleted matching" }, registry), []);
  assert.deepEqual(applyFilters([parent], { query: "live matching" }, registry).map(value => value._id), [parent._id]);
  assert.deepEqual(getChildOnlySearchMatches(parent, { query: "live matching" }, registry)?.map(value => value._id), [matchingChild._id]);

  const normal = window.document.body.createDiv();
  renderTaskRowShared(normal, parent, new App(), new Component(), () => undefined, undefined, false, undefined, registry);
  normal.querySelector<HTMLButtonElement>(".mos-subtask-toggle")!.click();
  assert.ok(normal.querySelector(".mos-subtask-list.is-collapsed"));

  const searchResults = window.document.body.createDiv();
  renderTaskRowShared(searchResults, parent, new App(), new Component(), () => undefined, undefined, false, undefined, registry, false, getChildOnlySearchMatches(parent, { query: "live matching" }, registry));
  assert.match(searchResults.textContent ?? "", /Contextual parent/);
  assert.match(searchResults.textContent ?? "", /Live matching child/);
  assert.doesNotMatch(searchResults.textContent ?? "", /Unrelated sibling|Deleted matching child/);
  assert.equal(searchResults.querySelector(".mos-subtask-list")?.classList.contains("is-collapsed"), false);

  const clearedResults = window.document.body.createDiv();
  renderTaskRowShared(clearedResults, parent, new App(), new Component(), () => undefined, undefined, false, undefined, registry);
  assert.ok(clearedResults.querySelector(".mos-subtask-list.is-collapsed"));
});

test("filter controls merge dropdown and query changes against the latest state", t => {
  const window = installDom();
  closeDom(t, window);
  const controls = window.document.body.createDiv();
  let current: { query?: string; priority?: "red" | "regular"; status?: "open" | "done" | "dismissed" } = {};
  const set = (filters: typeof current) => { current = filters; };
  renderFilterSelects(controls, current, set, false, undefined, set, () => current);
  const search = controls.querySelector<HTMLInputElement>('input[type="search"]')!;
  const [priority, status] = [...controls.querySelectorAll<HTMLSelectElement>("select")];

  search.value = "  child query ";
  search.focus();
  search.setSelectionRange(2, 8);
  search.dispatchEvent(new window.Event("input"));
  priority.value = "red";
  priority.dispatchEvent(new window.Event("change"));
  assert.deepEqual(current, { query: "  child query ", priority: "red" });

  search.value = "  child query continued";
  search.setSelectionRange(2, 8);
  search.dispatchEvent(new window.Event("input"));
  assert.equal(window.document.activeElement, search);
  assert.deepEqual(current, { query: "  child query continued", priority: "red" });

  status.value = "open";
  status.dispatchEvent(new window.Event("change"));
  search.value = "";
  search.dispatchEvent(new window.Event("input"));
  assert.deepEqual(current, { query: "", priority: "red", status: "open" });
});

test("status grouping orders live groups and children without flattening them", () => {
  const inactiveFirst = item("inactive-first");
  inactiveFirst.date_created = "2026-09-01";
  inactiveFirst.status_completion = "dismissed";
  const activeThroughChild = item("active-through-child");
  activeThroughChild.date_created = "2026-09-02";
  activeThroughChild.status_completion = "done";
  const activeChild = item("active-child", "note");
  activeChild.parent_id = activeThroughChild._id;
  activeChild.date_created = "2026-09-04";
  const doneChild = item("done-child");
  doneChild.parent_id = activeThroughChild._id;
  doneChild.date_created = "2026-09-01";
  doneChild.status_completion = "done";
  const deletedChild = item("deleted-child");
  deletedChild.parent_id = inactiveFirst._id;
  deletedChild.is_deleted = true;
  const activeLast = item("active-last");
  activeLast.date_created = "2026-09-03";
  const archivedNote = item("archived-note", "note");
  archivedNote.date_created = "2026-09-05";
  archivedNote.status_note = "archived";
  const registry = [inactiveFirst, activeThroughChild, activeChild, doneChild, deletedChild, activeLast, archivedNote];

  assert.deepEqual(
    sortItemsByStatus([inactiveFirst, activeThroughChild, activeLast, archivedNote], registry, "date_created", "asc", true, true).map(item => item._id),
    [activeThroughChild._id, activeLast._id, inactiveFirst._id, archivedNote._id],
  );
  assert.deepEqual(
    sortItemsByStatus([inactiveFirst, activeThroughChild, activeLast, archivedNote], registry, "date_created", "asc", false, true).map(item => item._id),
    [inactiveFirst._id, activeThroughChild._id, activeLast._id, archivedNote._id],
  );
  assert.deepEqual(
    sortItemsByStatus([inactiveFirst, activeThroughChild, activeLast, archivedNote], registry, "date_created", "desc", false, true).map(item => item._id),
    [archivedNote._id, activeLast._id, activeThroughChild._id, inactiveFirst._id],
  );
  assert.deepEqual(
    sortItemsByStatus([activeChild, doneChild], registry, "date_created", "asc", true).map(item => item._id),
    [activeChild._id, doneChild._id],
  );
  assert.deepEqual(
    sortItemsByStatus([activeChild, doneChild], registry, "date_created", "desc", false).map(item => item._id),
    [activeChild._id, doneChild._id],
  );
});

test("Area, table, and All Items status toggles preserve view state and preferences", t => {
  const window = installDom();
  closeDom(t, window);
  const app = new App();
  const area = { key: "status-area", label: "Status Area", icon: "S", tabs: [], feedToLLM: false };
  const plugin = {
    settings: { areas: [area], advancedAreaFeatures: false, dailyNoteDir: "Daily", showNotesIndicator: true, requireSubtasksComplete: false },
    activateView: () => undefined, activateAllItems: () => undefined, activateDump: () => undefined,
    activateTrash: () => undefined, activateArea: () => undefined, regenerateBriefing: async () => undefined,
    refreshView: () => undefined, autoRefreshBrief: async () => undefined,
  };
  const inactive = item("area-inactive");
  inactive.text = "A inactive";
  inactive.areas = [area.key];
  inactive.date_created = "2026-09-04";
  inactive.status_completion = "dismissed";
  const parent = item("grouping-area-parent");
  parent.text = "B parent";
  parent.areas = [area.key];
  parent.date_created = "2026-09-02";
  parent.status_completion = "done";
  parent.status_priority = "red";
  const doneChild = item("grouping-area-done-child");
  doneChild.text = "A done child";
  doneChild.parent_id = parent._id;
  doneChild.date_created = "2026-09-01";
  doneChild.status_completion = "done";
  const activeChild = item("grouping-area-active-child", "note");
  activeChild.text = "Z active child";
  activeChild.parent_id = parent._id;
  activeChild.date_created = "2026-09-03";
  const shell = window.document.body.createDiv();
  shell.createDiv();
  shell.createDiv();
  const view = new AreaView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, area.key);
  const internals = view as unknown as { app: App; registry: Task[]; render: () => void; containerEl: HTMLElement };
  internals.app = app;
  internals.registry = [inactive, parent, doneChild, activeChild];
  internals.containerEl = shell;
  internals.render();

  let cards = shell.querySelectorAll<HTMLElement>(".mos-area-item-panel-tasks .morning-os-card");
  assert.match(cards[0].textContent ?? "", /B parent[\s\S]*A inactive/);
  const childList = shell.querySelector<HTMLElement>(".mos-area-item-panel-tasks .mos-subtask-list")!;
  assert.match(childList.textContent ?? "", /Z active child[\s\S]*A done child/);
  shell.querySelector<HTMLButtonElement>(".mos-area-item-panel-tasks .mos-subtask-toggle")!.click();
  assert.ok(childList.classList.contains("is-collapsed"));

  const viewOptions = openViewOptions(shell);
  const sort = viewOptions.querySelector<HTMLSelectElement>('select[aria-label="Sort field"]')!;
  sort.value = "name";
  sort.dispatchEvent(new window.Event("change"));
  const status = viewOptions.querySelector<HTMLSelectElement>('select[aria-label="Task status"]')!;
  status.value = "done";
  status.dispatchEvent(new window.Event("change"));
  const reminder = viewOptions.querySelector<HTMLSelectElement>('select[aria-label="Reminder"]')!;
  reminder.value = "has";
  reminder.dispatchEvent(new window.Event("change"));
  const viewOptionsButton = shell.querySelector<HTMLButtonElement>(".mos-view-options-button")!;
  assert.match(viewOptionsButton.textContent ?? "", /View options · 2/);
  assert.equal(shell.querySelectorAll(".mos-filter-chip").length, 2);
  shell.querySelector<HTMLButtonElement>(".mos-filter-chip")!.click();
  assert.match(viewOptionsButton.textContent ?? "", /View options · 1/);
  const search = shell.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "B parent";
  search.dispatchEvent(new window.Event("input"));
  const groupSwitch = viewOptions.querySelector<HTMLInputElement>('input[aria-label="Group items by active status"]')!;
  groupSwitch.checked = false;
  groupSwitch.dispatchEvent(new window.Event("change"));
  assert.equal(shell.querySelector<HTMLInputElement>('input[type="search"]')!.value, "B parent");
  shell.querySelector<HTMLButtonElement>(".mos-filter-clear")!.click();
  assert.equal(viewOptionsButton.textContent, "⚙ View options");
  assert.equal(shell.querySelector<HTMLInputElement>('input[type="search"]')!.value, "B parent");
  assert.equal(viewOptions.querySelector<HTMLSelectElement>('select[aria-label="Task status"]')!.value, "");
  assert.equal(viewOptions.querySelector<HTMLSelectElement>('select[aria-label="Sort field"]')!.value, "name");
  assert.ok(shell.querySelector(".mos-subtask-list.is-collapsed"));
  assert.equal(groupSwitch.checked, false);
  assert.equal(app.loadLocalStorage("mos-group-by-status-area-status-area"), false);

  const reopened = new AreaView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, area.key);
  const reopenedInternals = reopened as unknown as { app: App; registry: Task[]; render: () => void; containerEl: HTMLElement };
  reopenedInternals.app = app;
  reopenedInternals.registry = internals.registry;
  const reopenedShell = window.document.body.createDiv();
  reopenedShell.createDiv();
  reopenedShell.createDiv();
  reopenedInternals.containerEl = reopenedShell;
  reopenedInternals.render();
  assert.equal(openViewOptions(reopenedShell).querySelector<HTMLInputElement>('input[aria-label="Group items by active status"]')!.checked, false);

  const tableArea = {
    key: "status-table", label: "Status Table", icon: "T", feedToLLM: false,
    tabs: [{ key: "tracker", label: "Tracker", fields: [], view_mode: "table" as const }],
  };
  const tableActive = item("table-active");
  tableActive.text = "Z active table";
  tableActive.areas = [tableArea.key];
  tableActive.tags = { [tableArea.key]: "tracker" };
  tableActive.date_created = "2026-09-03";
  const tableInactive = item("table-inactive");
  tableInactive.text = "A inactive table";
  tableInactive.areas = [tableArea.key];
  tableInactive.tags = { [tableArea.key]: "tracker" };
  tableInactive.date_created = "2026-09-01";
  tableInactive.status_completion = "dismissed";
  const tablePlugin = { ...plugin, settings: { ...plugin.settings, areas: [tableArea], advancedAreaFeatures: true } };
  const tableView = new AreaView(new WorkspaceLeaf(), tablePlugin.settings as never, tablePlugin as never, tableArea.key);
  const tableInternals = tableView as unknown as { app: App; registry: Task[]; activeTab: string; render: () => void; containerEl: HTMLElement };
  tableInternals.app = app;
  tableInternals.registry = [tableInactive, tableActive];
  tableInternals.activeTab = "tracker";
  const tableShell = window.document.body.createDiv();
  tableShell.createDiv();
  tableShell.createDiv();
  tableInternals.containerEl = tableShell;
  tableInternals.render();
  assert.equal(openViewOptions(tableShell).querySelector<HTMLInputElement>('input[aria-label="Group items by active status"]')!.checked, true);
  assert.match(tableShell.querySelector("tbody")?.textContent ?? "", /Z active table[\s\S]*A inactive table/);
  const tableGroupSwitch = tableShell.querySelector<HTMLInputElement>('input[aria-label="Group items by active status"]')!;
  tableGroupSwitch.checked = false;
  tableGroupSwitch.dispatchEvent(new window.Event("change"));
  assert.match(tableShell.querySelector("tbody")?.textContent ?? "", /A inactive table[\s\S]*Z active table/);

  const allItemsView = new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, true);
  const allItemsInternals = allItemsView as unknown as { app: App; registry: Task[]; render: () => void; containerEl: HTMLElement };
  allItemsInternals.app = app;
  allItemsInternals.registry = [inactive, parent, doneChild, activeChild];
  const allItemsShell = window.document.body.createDiv();
  allItemsShell.createDiv();
  allItemsShell.createDiv();
  allItemsInternals.containerEl = allItemsShell;
  allItemsInternals.render();
  assert.equal(openViewOptions(allItemsShell).querySelector<HTMLInputElement>('input[aria-label="Group items by active status"]')!.checked, true);
  assert.match(allItemsShell.querySelector(".mos-filter-results")?.textContent ?? "", /B parent[\s\S]*A inactive/);
  const allGroupSwitch = allItemsShell.querySelector<HTMLInputElement>('input[aria-label="Group items by active status"]')!;
  allGroupSwitch.checked = false;
  allGroupSwitch.dispatchEvent(new window.Event("change"));
  assert.equal(app.loadLocalStorage("mos-group-by-status-all-items"), false);
  assert.match(allItemsShell.querySelector(".mos-filter-results")?.textContent ?? "", /A inactive[\s\S]*B parent/);
  assert.equal(app.loadLocalStorage("mos-group-by-status-area-status-area"), false);
  const reopenedAllItems = new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, true);
  const reopenedAllItemsInternals = reopenedAllItems as unknown as { app: App; registry: Task[]; render: () => void; containerEl: HTMLElement };
  reopenedAllItemsInternals.app = app;
  reopenedAllItemsInternals.registry = allItemsInternals.registry;
  const reopenedAllItemsShell = window.document.body.createDiv();
  reopenedAllItemsShell.createDiv();
  reopenedAllItemsShell.createDiv();
  reopenedAllItemsInternals.containerEl = reopenedAllItemsShell;
  reopenedAllItemsInternals.render();
  assert.equal(openViewOptions(reopenedAllItemsShell).querySelector<HTMLInputElement>('input[aria-label="Group items by active status"]')!.checked, false);
});

test("Area view keeps search state, reveals child-only results, and handles desktop/mobile panel controls", t => {
  const window = installDom(1024);
  closeDom(t, window);
  const app = new App();
  const area = { key: "work", label: "Work", icon: "W", tabs: [], feedToLLM: false };
  const plugin = {
    settings: { areas: [area], advancedAreaFeatures: false, dailyNoteDir: "Daily", showNotesIndicator: true, requireSubtasksComplete: false },
    activateView: () => undefined,
    activateAllItems: () => undefined,
    activateDump: () => undefined,
    activateTrash: () => undefined,
    activateArea: () => undefined,
    regenerateBriefing: async () => undefined,
    refreshView: () => undefined,
    autoRefreshBrief: async () => undefined,
  };
  const parent = item("area-parent");
  parent.text = "Area parent";
  parent.areas = [area.key];
  parent.status_priority = "red";
  const matchingChild = item("area-match");
  matchingChild.text = "Find this child";
  matchingChild.parent_id = parent._id;
  const unrelatedChild = item("area-other");
  unrelatedChild.text = "Do not show sibling";
  unrelatedChild.parent_id = parent._id;
  const note = item("area-note", "note");
  note.areas = [area.key];

  const view = new AreaView(new WorkspaceLeaf(), { ...plugin.settings } as never, plugin as never, area.key);
  const internals = view as unknown as { registry: Task[]; render: () => void; containerEl: HTMLElement };
  internals.registry = [parent, matchingChild, unrelatedChild, note];
  const shell = window.document.body.createDiv();
  shell.createDiv();
  shell.createDiv();
  internals.containerEl = shell;
  internals.render();

  shell.querySelector<HTMLButtonElement>(".mos-area-item-panel-tasks .mos-subtask-toggle")!.click();
  assert.ok(shell.querySelector(".mos-area-item-panel-tasks .mos-subtask-list.is-collapsed"));

  const search = shell.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "Find this child";
  search.focus();
  search.setSelectionRange(2, 8);
  search.dispatchEvent(new window.Event("input"));
  assert.equal(window.document.activeElement, search);
  assert.match(shell.textContent ?? "", /Area parent/);
  assert.match(shell.textContent ?? "", /Find this child/);
  assert.doesNotMatch(shell.textContent ?? "", /Do not show sibling/);
  assert.equal(shell.querySelector(".mos-area-item-panel-tasks .mos-subtask-list")?.classList.contains("is-collapsed"), false);

  const options = openViewOptions(shell);
  const status = options.querySelector<HTMLSelectElement>('select[aria-label="Task status"]')!;
  status.value = "open";
  status.dispatchEvent(new window.Event("change"));
  const continuedSearch = shell.querySelector<HTMLInputElement>('input[type="search"]')!;
  assert.equal(continuedSearch.value, "Find this child");
  continuedSearch.value = "Find this child ";
  continuedSearch.focus();
  continuedSearch.setSelectionRange(2, 8);
  continuedSearch.dispatchEvent(new window.Event("input"));
  assert.equal(window.document.activeElement, continuedSearch);
  assert.equal(continuedSearch.value, "Find this child ");

  continuedSearch.value = "";
  continuedSearch.dispatchEvent(new window.Event("input"));
  assert.ok(shell.querySelector(".mos-area-item-panel-tasks .mos-subtask-list.is-collapsed"));

  shell.querySelector<HTMLButtonElement>(".mos-area-item-panel-tasks .mos-area-panel-minimize")!.click();
  let panels = shell.querySelector<HTMLElement>(".mos-area-item-panels")!;
  assert.ok(panels.classList.contains("is-tasks-minimized"));
  assert.equal(window.getComputedStyle(panels).gridTemplateColumns, "minmax(0, 1fr)");
  assert.equal(window.getComputedStyle(shell.querySelector(".mos-area-item-panel-tasks")!).display, "none");

  window.happyDOM.setViewport({ width: 480 });
  applyStyles(window);
  panels = shell.querySelector<HTMLElement>(".mos-area-item-panels")!;
  assert.equal(window.getComputedStyle(panels).display, "block");
  assert.equal(window.getComputedStyle(shell.querySelector(".mos-area-item-panel-tasks")!).display, "block");
  shell.querySelector<HTMLButtonElement>(".mos-mobile-item-switch button:last-child")!.click();
  assert.ok(shell.querySelector(".mos-area-item-panel-tasks")?.classList.contains("is-mobile-hidden"));
  assert.equal(shell.querySelector(".mos-area-item-panel-notes")?.classList.contains("is-mobile-hidden"), false);

  window.happyDOM.setViewport({ width: 1024 });
  applyStyles(window);
  shell.querySelector<HTMLButtonElement>(".mos-area-panel-restore-button")!.click();
  panels = shell.querySelector<HTMLElement>(".mos-area-item-panels")!;
  assert.equal(panels.classList.contains("is-tasks-minimized"), false);
  assert.equal(window.getComputedStyle(panels).gridTemplateColumns, "minmax(0, 1fr) minmax(0, 1fr)");
});

test("All Items and Inbox expose only their applicable view options", t => {
  const window = installDom();
  closeDom(t, window);
  const app = new App();
  const plugin = {
    settings: { areas: [], showNotesIndicator: true, requireSubtasksComplete: false },
    activateView: () => undefined, activateAllItems: () => undefined, activateDump: () => undefined,
    activateTrash: () => undefined, activateArea: () => undefined, regenerateBriefing: async () => undefined,
    refreshView: () => undefined, autoRefreshBrief: async () => undefined,
  };
  const allItemsView = new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, true);
  const allInternals = allItemsView as unknown as { app: App; registry: Task[]; render: () => void; containerEl: HTMLElement };
  allInternals.app = app;
  allInternals.registry = [item("all-toolbar")];
  const allShell = window.document.body.createDiv();
  allShell.createDiv();
  allShell.createDiv();
  allInternals.containerEl = allShell;
  allInternals.render();
  const allOptions = openViewOptions(allShell);
  const allOptionsButton = allShell.querySelector<HTMLButtonElement>(".mos-view-options-button")!;
  assert.ok(allOptions.querySelector('input[aria-label="Group items by active status"]'));
  assert.equal(window.document.activeElement, allOptions.querySelector('select[aria-label="Sort field"]'));
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(allOptionsButton.getAttribute("aria-expanded"), "false");
  assert.equal(window.document.activeElement, allOptionsButton);
  openViewOptions(allShell);
  window.document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.equal(allOptionsButton.getAttribute("aria-expanded"), "false");

  const inboxView = new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never);
  const inboxInternals = inboxView as unknown as { app: App; registry: Task[]; render: () => void; containerEl: HTMLElement };
  inboxInternals.app = app;
  inboxInternals.registry = [item("inbox-toolbar")];
  const inboxShell = window.document.body.createDiv();
  inboxShell.createDiv();
  inboxShell.createDiv();
  inboxInternals.containerEl = inboxShell;
  inboxInternals.render();
  assert.equal(openViewOptions(inboxShell).querySelector('input[aria-label="Group items by active status"]'), null);
  assert.equal(inboxShell.textContent?.includes("Priority"), false);

  window.happyDOM.setViewport({ width: 480 });
  applyStyles(window);
  openViewOptions(allShell);
  assert.equal(window.getComputedStyle(allShell.querySelector<HTMLElement>(".mos-view-options-overlay")!).position, "fixed");
  allShell.querySelector<HTMLButtonElement>(".mos-view-options-close")!.click();
  assert.equal(allOptionsButton.getAttribute("aria-expanded"), "false");
});

test("Inbox mutation refresh keeps its toolbar, open options, and scroll container mounted", async t => {
  const window = installDom();
  closeDom(t, window);
  const first = item("mounted-first");
  const second = item("mounted-second");
  const files = new Map<string, string>();
  files.set(STATE_PATH, JSON.stringify({ schemaVersion: 1, revision: 1, writtenAt: "2026-09-16T10:00:00", items: [first] }));
  const adapter = {
    exists: async (path: string) => files.has(path) || path.startsWith("_generated"),
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); },
    mkdir: async () => undefined,
    list: async () => ({ files: [], folders: [] }),
  };
  const app = {
    vault: { adapter, getAbstractFileByPath: (path: string) => new TFile(path) },
    fileManager: { trashFile: async (file: TFile) => { files.delete(file.path); } },
    loadLocalStorage: () => undefined,
    saveLocalStorage: () => undefined,
  };
  const plugin = { settings: { areas: [], showNotesIndicator: true, requireSubtasksComplete: false }, refreshView: () => undefined };
  const view = new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never);
  const internals = view as unknown as { app: typeof app; registry: Task[]; render: () => void; refresh: () => Promise<void>; containerEl: HTMLElement };
  internals.app = app;
  internals.registry = [first];
  const shell = window.document.body.createDiv();
  shell.createDiv();
  shell.createDiv();
  internals.containerEl = shell;
  internals.render();
  const toolbar = shell.querySelector(".mos-view-toolbar")!;
  const scroll = shell.querySelector<HTMLElement>(".morning-os-scroll")!;
  const search = shell.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "mounted";
  search.dispatchEvent(new window.Event("input"));
  openViewOptions(shell);
  files.set(STATE_PATH, JSON.stringify({ schemaVersion: 1, revision: 2, writtenAt: "2026-09-16T10:01:00", items: [first, second] }));
  await internals.refresh();
  assert.equal(shell.querySelector(".mos-view-toolbar"), toolbar);
  assert.equal(shell.querySelector(".morning-os-scroll"), scroll);
  assert.equal(shell.querySelector<HTMLInputElement>('input[type="search"]')?.value, "mounted");
  assert.ok(shell.querySelector(".mos-view-options-panel"));
  // happy-dom has no layout/scroll metrics here; real clamping remains a manual check.
});

test("scroll-restoration logic retains and clamps Dump scroll across results and layout refreshes", async t => {
  const window = installDom();
  closeDom(t, window);
  const first = item("scroll-first");
  const second = item("scroll-second");
  const files = new Map([[STATE_PATH, stateBytes([first, second])]]);
  const adapter = {
    exists: async (path: string) => files.has(path) || path.startsWith("_generated"),
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); },
    mkdir: async () => undefined, list: async () => ({ files: [], folders: [] as string[] }),
  };
  const app = Object.assign(new App(), { vault: { adapter, getAbstractFileByPath: (path: string) => new TFile(path) }, fileManager: { trashFile: async () => undefined } });
  const plugin = viewPlugin({ areas: [], showNotesIndicator: true, requireSubtasksComplete: false });
  const view = new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, true);
  const internals = view as unknown as { app: App; containerEl: HTMLElement; scrollEl: HTMLElement; render: () => void };
  internals.app = app;
  const shell = window.document.body.createDiv(); shell.createDiv(); shell.createDiv(); internals.containerEl = shell;
  await view.onOpen();
  const toolbar = shell.querySelector(".mos-view-toolbar")!;
  const search = shell.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "scroll";
  search.dispatchEvent(new window.Event("input"));
  openViewOptions(shell);
  const scroll = internals.scrollEl;
  setScrollMetrics(scroll, 300, 100);
  scroll.scrollTop = 80;
  await view.refresh();
  assert.equal(internals.scrollEl, scroll);
  assert.equal(scroll.scrollTop, 80, "a still-valid results scroll position is retained");
  assert.equal(shell.querySelector(".mos-view-toolbar"), toolbar);
  assert.equal(shell.querySelector<HTMLInputElement>('input[type="search"]')?.value, "scroll");
  assert.ok(shell.querySelector(".mos-view-options-panel"));

  setScrollMetrics(scroll, 150, 100);
  scroll.scrollTop = 80;
  await view.refresh();
  assert.equal(scroll.scrollTop, 50, "shorter results clamp to their maximum scroll offset");
  setScrollMetrics(scroll, 80, 100);
  scroll.scrollTop = 50;
  await view.refresh();
  assert.equal(scroll.scrollTop, 0, "unscrollable results clamp to zero");

  setScrollMetrics(scroll, 300, 100);
  scroll.scrollTop = 80;
  const render = internals.render.bind(view);
  internals.render = () => { render(); setScrollMetrics(internals.scrollEl, 180, 100); };
  await view.refresh(true);
  assert.notEqual(internals.scrollEl, scroll);
  assert.equal(internals.scrollEl.scrollTop, 80, "layout refresh restores onto the replacement scroll container");
  await view.onClose();
});

test("Inbox, All Items, and application-table controls retain the latest query and filters", t => {
  const window = installDom();
  closeDom(t, window);
  const app = new App();
  const exerciseDump = (allItems: boolean): void => {
    const root = item(allItems ? "all-root" : "inbox-root");
    root.text = "Filter target";
    root.status_priority = "red";
    const plugin = {
      settings: { areas: [], showNotesIndicator: true, requireSubtasksComplete: false },
      activateView: () => undefined, activateAllItems: () => undefined, activateDump: () => undefined,
      activateTrash: () => undefined, activateArea: () => undefined, regenerateBriefing: async () => undefined,
      refreshView: () => undefined, autoRefreshBrief: async () => undefined,
    };
    const view = new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never, allItems);
    const internals = view as unknown as { registry: Task[]; render: () => void; containerEl: HTMLElement };
    internals.registry = [root];
    const shell = window.document.body.createDiv();
    shell.createDiv();
    shell.createDiv();
    internals.containerEl = shell;
    internals.render();
    const search = shell.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Filter target";
    search.dispatchEvent(new window.Event("input"));
    const options = openViewOptions(shell);
    const status = options.querySelector<HTMLSelectElement>('select[aria-label="Task status"]')!;
    status.value = "open";
    status.dispatchEvent(new window.Event("change"));
    const afterDropdown = shell.querySelector<HTMLInputElement>('input[type="search"]')!;
    assert.equal(afterDropdown.value, "Filter target");
    afterDropdown.value = "";
    afterDropdown.dispatchEvent(new window.Event("input"));
    assert.match(shell.textContent ?? "", /Filter target/);
  };
  exerciseDump(false);
  exerciseDump(true);

  const tableArea = {
    key: "applications",
    label: "Applications",
    icon: "A",
    feedToLLM: false,
    tabs: [{ key: "tracker", label: "Tracker", fields: [{ key: "stage", label: "Stage", type: "dropdown" as const, options: ["Research", "Applied"] }], view_mode: "table" as const }],
  };
  const tableRoot = item("application-root");
  tableRoot.text = "Application filter target";
  tableRoot.areas = [tableArea.key];
  tableRoot.tags = { [tableArea.key]: "tracker", stage: "Research" };
  tableRoot.status_priority = "red";
  const tableChild = item("application-child");
  tableChild.text = "Application child hit";
  tableChild.parent_id = tableRoot._id;
  const tablePlugin = {
    settings: { areas: [tableArea], advancedAreaFeatures: true, dailyNoteDir: "Daily", showNotesIndicator: true, requireSubtasksComplete: false },
    activateView: () => undefined, activateAllItems: () => undefined, activateDump: () => undefined,
    activateTrash: () => undefined, activateArea: () => undefined, regenerateBriefing: async () => undefined,
    refreshView: () => undefined, autoRefreshBrief: async () => undefined,
  };
  const tableView = new AreaView(new WorkspaceLeaf(), tablePlugin.settings as never, tablePlugin as never, tableArea.key);
  const tableInternals = tableView as unknown as { registry: Task[]; activeTab: string; render: () => void; containerEl: HTMLElement };
  tableInternals.registry = [tableRoot, tableChild];
  tableInternals.activeTab = "tracker";
  const tableShell = window.document.body.createDiv();
  tableShell.createDiv();
  tableShell.createDiv();
  tableInternals.containerEl = tableShell;
  tableInternals.render();
  const tableSearch = tableShell.querySelector<HTMLInputElement>('input[type="search"]')!;
  tableSearch.value = "Application child hit";
  tableSearch.dispatchEvent(new window.Event("input"));
  const tableOptions = openViewOptions(tableShell);
  tableOptions.querySelector<HTMLSelectElement>('select[aria-label="Task status"]')!.value = "open";
  tableOptions.querySelector<HTMLSelectElement>('select[aria-label="Task status"]')!.dispatchEvent(new window.Event("change"));
  const tableStage = tableOptions.querySelector<HTMLSelectElement>('select[aria-label="Stage"]')!;
  tableStage.value = "Research";
  tableStage.dispatchEvent(new window.Event("change"));
  assert.match(tableShell.querySelector(".mos-view-options-button")?.textContent ?? "", /View options · 2/);
  tableShell.querySelector<HTMLButtonElement>('[aria-label="Remove Stage: Research filter"]')!.click();
  assert.match(tableShell.querySelector(".mos-view-options-button")?.textContent ?? "", /View options · 1/);
  assert.equal(tableShell.querySelector<HTMLInputElement>('input[type="search"]')!.value, "Application child hit");
  assert.ok(tableShell.querySelector(".mos-table"));
  assert.match(tableShell.textContent ?? "", /Matching child.*Application child hit/s);
});

test("Inbox retains unfinished groups even when the parent is inactive", t => {
  const window = installDom();
  closeDom(t, window);
  const plugin = {
    settings: { areas: [], showNotesIndicator: true, requireSubtasksComplete: false },
    activateView: () => undefined, activateAllItems: () => undefined, activateDump: () => undefined,
    activateTrash: () => undefined, activateArea: () => undefined, regenerateBriefing: async () => undefined,
    refreshView: () => undefined, autoRefreshBrief: async () => undefined,
  };
  const view = new DumpView(new WorkspaceLeaf(), plugin.settings as never, plugin as never);
  const internals = view as unknown as { registry: Task[]; render: () => void; containerEl: HTMLElement };
  const shell = window.document.body.createDiv();
  shell.createDiv();
  shell.createDiv();
  internals.containerEl = shell;
  const parent = item("unfinished-group-parent");
  parent.status_completion = "done";
  const done = item("completed-child");
  done.parent_id = parent._id;
  done.status_completion = "done";
  const open = item("unfinished-child");
  open.parent_id = parent._id;
  internals.registry = [parent, done, open];
  const assertVisible = (visible: boolean): void => {
    internals.render();
    assert.equal(shell.textContent?.includes(parent.text), visible);
  };
  assertVisible(true);
  assert.match(shell.textContent ?? "", /unfinished-child/);
  open.status_completion = "done";
  assertVisible(false);
  open.status_completion = "open";
  open.is_deleted = true;
  assertVisible(false);
  open.is_deleted = false;
  parent.areas = ["work"];
  assertVisible(false);
  parent.areas = [];
  parent.is_deleted = true;
  assertVisible(false);
  parent.is_deleted = false;
  parent.kind = "note";
  parent.status_note = "archived";
  open.kind = "note";
  open.status_note = "active";
  assertVisible(true);
  open.status_note = "archived";
  assertVisible(false);
  parent.kind = "task";
  parent.status_completion = "open";
  assertVisible(true);
});

test("Today child context uses the Morning OS system color in dark and light themes", t => {
  const window = installDom();
  closeDom(t, window);
  const shell = window.document.body.createDiv({ cls: "morning-os" });
  const context = shell.createDiv({ cls: "mos-today-context-parent" });
  const reference = shell.createDiv();
  reference.style.borderLeft = "2px solid var(--mos-system)";
  for (const light of [false, true]) {
    window.document.body.classList.toggle("theme-light", light);
    applyStyles(window);
    assert.equal(window.getComputedStyle(context).borderLeftColor, window.getComputedStyle(reference).borderLeftColor);
    assert.equal(window.getComputedStyle(context).borderLeftWidth, "2px");
  }
});

test("Today renders selected-root children without assigning them Today state and groups selected-only siblings", t => {
  const window = installDom();
  closeDom(t, window);
  const root = item("root");
  root.is_today = true;
  root.details = "Parent details";
  const openChild = item("open-child");
  openChild.parent_id = root._id;
  const doneToday = item("done-today");
  doneToday.parent_id = root._id;
  doneToday.status_completion = "done";
  doneToday.date_completed = todayStr();
  const oldDone = item("old-done");
  oldDone.parent_id = root._id;
  oldDone.status_completion = "done";
  oldDone.date_completed = "2000-01-01";
  const note = item("supporting-note", "note");
  note.parent_id = root._id;
  const archived = item("archived-note", "note");
  archived.parent_id = root._id;
  archived.status_note = "archived";
  const selectedSibling = item("selected-sibling");
  selectedSibling.parent_id = root._id;
  selectedSibling.is_today = true;
  const missing = item("missing-child");
  missing.parent_id = "missing-parent";
  missing.is_today = true;
  const registry = [root, openChild, doneToday, oldDone, note, archived, selectedSibling, missing];
  const before = JSON.stringify(registry);
  const home = Object.create(MorningView.prototype) as unknown as {
    app: App; registry: Task[]; plugin: ReturnType<typeof viewPlugin>; renderTasks: (parent: HTMLElement) => void;
  };
  home.app = new App();
  home.registry = registry;
  home.plugin = viewPlugin({ showNotesIndicator: true });
  home.renderTasks(window.document.body.createDiv());
  const rendered = window.document.body;
  assert.equal(rendered.querySelectorAll(".mos-today-context-parent").length, 1, "only the missing selected child needs contextual parent UI");
  assert.match(rendered.textContent ?? "", /Missing or deleted parent/);
  assert.match(rendered.querySelector(".mos-today-supporting-notes summary")!.textContent ?? "", /Supporting notes \(1\)/);
  assert.equal(rendered.querySelector<HTMLDetailsElement>(".mos-today-supporting-notes")!.open, false);
  assert.ok(rendered.querySelector(".mos-today-parent-details"));
  assert.equal(JSON.stringify(registry), before, "Today projection must not mutate child state");
  assert.equal(rendered.querySelectorAll(".morning-os-task-row").length, 6, "root, eligible root children, one supporting note, and two selected contextual children render once each");
});

test("Today groups independently selected siblings by parent ID and priority", t => {
  const window = installDom();
  closeDom(t, window);
  const parent = item("inactive-parent");
  parent.text = "Same title";
  parent.status_completion = "done";
  parent.date_completed = "2026-09-16";
  const otherParent = item("other-parent");
  otherParent.text = "Same title";
  otherParent.status_completion = "done";
  otherParent.date_completed = "2026-09-16";
  const regularA = item("regular-a");
  regularA.parent_id = parent._id;
  regularA.is_today = true;
  const regularB = item("regular-b");
  regularB.parent_id = parent._id;
  regularB.is_today = true;
  const red = item("red-child");
  red.parent_id = parent._id;
  red.is_today = true;
  red.status_priority = "red";
  const sameTitleOther = item("same-title-other");
  sameTitleOther.parent_id = otherParent._id;
  sameTitleOther.is_today = true;
  const unselected = item("unselected-sibling");
  unselected.parent_id = parent._id;
  const home = Object.create(MorningView.prototype) as unknown as {
    app: App; registry: Task[]; plugin: ReturnType<typeof viewPlugin>; renderTasks: (parent: HTMLElement) => void;
  };
  home.app = new App();
  home.registry = [parent, otherParent, regularA, regularB, red, sameTitleOther, unselected];
  home.plugin = viewPlugin({ showNotesIndicator: true });
  home.renderTasks(window.document.body.createDiv());
  assert.equal(window.document.querySelectorAll(".mos-today-context-parent").length, 3);
  assert.equal(window.document.querySelectorAll(".morning-os-card-red .mos-today-context-parent").length, 1);
  assert.equal(window.document.querySelectorAll(".morning-os-card:not(.morning-os-card-red) .mos-today-context-parent").length, 2);
  assert.doesNotMatch(window.document.body.textContent ?? "", /unselected-sibling/);
});

test("Today child menus update only their selected child membership and priority", async t => {
  const window = installDom();
  closeDom(t, window);
  const root = item("today-root");
  root.is_today = true;
  const selectedUnderRoot = item("selected-under-root");
  selectedUnderRoot.parent_id = root._id;
  selectedUnderRoot.is_today = true;
  selectedUnderRoot.reminder_occurrence = { token: "promoted", handledToken: "promoted" };
  const supportingNote = item("supporting-note", "note");
  supportingNote.parent_id = root._id;
  const contextualParent = item("inactive-context-parent");
  contextualParent.status_completion = "done";
  contextualParent.date_completed = "2026-09-16";
  const regularChild = item("contextual-regular");
  regularChild.parent_id = contextualParent._id;
  regularChild.is_today = true;
  const redChild = item("contextual-red", "note");
  redChild.parent_id = contextualParent._id;
  redChild.is_today = true;
  redChild.status_priority = "red";
  const sibling = item("untouched-sibling");
  sibling.parent_id = root._id;
  const initial = [root, selectedUnderRoot, supportingNote, contextualParent, regularChild, redChild, sibling];
  const files = new Map([[STATE_PATH, stateBytes(initial)]]);
  const adapter = {
    exists: async (path: string) => files.has(path) || path.startsWith("_generated"),
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); },
    mkdir: async () => undefined,
    list: async () => ({ files: [], folders: [] as string[] }),
  };
  const app = Object.assign(new App(), {
    vault: { adapter, getAbstractFileByPath: (path: string) => new TFile(path) },
    fileManager: { trashFile: async (file: TFile) => { files.delete(file.path); } },
  }) as never as App;
  let settled = deferred<void>();
  const plugin = viewPlugin({ showNotesIndicator: true }) as ReturnType<typeof viewPlugin> & { refreshView: () => void };
  plugin.refreshView = () => settled.resolve();
  const home = Object.create(MorningView.prototype) as unknown as {
    app: App; registry: Task[]; plugin: typeof plugin; renderTasks: (parent: HTMLElement) => void;
  };
  home.app = app;
  home.registry = initial;
  home.plugin = plugin;
  const rendered = window.document.body.createDiv();
  home.renderTasks(rendered);
  const rowFor = (id: string): HTMLElement => [...rendered.querySelectorAll<HTMLElement>(".morning-os-task-row")]
    .find(row => row.querySelector(".morning-os-task-text")?.textContent === id)!;
  const choose = (id: string, label: RegExp): void => {
    rowFor(id).querySelector<HTMLButtonElement>('[title="More actions"]')!.click();
    const button = [...window.document.querySelectorAll<HTMLButtonElement>(".mos-ctx-item")]
      .find(candidate => label.test(candidate.textContent ?? ""));
    assert.ok(button, `expected Today action ${label}`);
    button.click();
  };
  const state = (): Task[] => (JSON.parse(files.get(STATE_PATH)!) as { items: Task[] }).items;
  const find = (id: string): Task => state().find(candidate => candidate._id === id)!;
  const unchanged = (id: string): Task => structuredClone(find(id));
  const rootBefore = unchanged(root._id);
  const siblingBefore = unchanged(sibling._id);

  choose(regularChild._id, /Move to Red alert/);
  await settled.promise;
  assert.equal(find(regularChild._id).status_priority, "red");
  assert.equal(find(regularChild._id).is_today, true);
  assert.deepEqual(find(root._id), rootBefore);
  assert.deepEqual(find(sibling._id), siblingBefore);

  settled = deferred<void>();
  choose(redChild._id, /Move to Regular/);
  await settled.promise;
  assert.equal(find(redChild._id).status_priority, "regular");
  assert.equal(find(redChild._id).is_today, true);
  assert.equal(rowFor(redChild._id).querySelector('input[type="checkbox"]'), null);
  assert.ok(rowFor(redChild._id).querySelector(".mos-note-kind-icon"));

  settled = deferred<void>();
  choose(selectedUnderRoot._id, /Remove from Today \(still shown under parent\)/);
  await settled.promise;
  assert.equal(find(selectedUnderRoot._id).is_today, false);
  assert.equal(find(selectedUnderRoot._id).status_completion, "open");
  assert.equal(find(selectedUnderRoot._id).parent_id, root._id);
  assert.equal(find(selectedUnderRoot._id).reminder_occurrence?.dismissedToken, "promoted");
  assert.deepEqual(find(root._id), rootBefore);
  assert.deepEqual(find(sibling._id), siblingBefore);

  const notes = rendered.querySelector<HTMLDetailsElement>(".mos-today-supporting-notes")!;
  notes.open = true;
  rowFor(supportingNote._id).querySelector<HTMLButtonElement>('[title="More actions"]')!.click();
  assert.equal(rowFor(supportingNote._id).querySelector('input[type="checkbox"]'), null);
  assert.ok(rowFor(supportingNote._id).querySelector(".mos-note-kind-icon"));
  assert.equal([...window.document.querySelectorAll(".mos-ctx-item")].some(button => /Remove from Today/.test(button.textContent ?? "")), false);
});

test("task and note rows render distinct lifecycle controls and direct menu actions", t => {
  const window = installDom();
  closeDom(t, window);
  const app = new App();
  const component = new Component();
  const plugin = { settings: { showNotesIndicator: true }, refreshView: () => undefined, autoRefreshBrief: async () => undefined };

  const taskParent = window.document.body.createDiv();
  renderTaskRowShared(taskParent, item("task"), app, component, () => undefined, plugin as never);
  assert.equal(taskParent.querySelectorAll('input[type="checkbox"]').length, 1);

  const note = item("note", "note");
  const noteParent = window.document.body.createDiv();
  renderTaskRowShared(noteParent, note, app, component, () => undefined, plugin as never);
  assert.equal(noteParent.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(noteParent.querySelectorAll(".mos-note-kind-icon").length, 1);
  noteParent.querySelector<HTMLButtonElement>('[title="More actions"]')!.click();
  assert.match(window.document.body.textContent ?? "", /Archive/);
  assert.match(window.document.body.textContent ?? "", /Convert to task/);

  window.document.querySelector(".mos-ctx-menu")?.remove();
  note.status_note = "archived";
  note.status_completion = "done";
  const archivedParent = window.document.body.createDiv();
  renderTaskRowShared(archivedParent, note, app, component, () => undefined, plugin as never);
  assert.equal(archivedParent.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(archivedParent.querySelectorAll(".mos-note-status").length, 1);
  assert.equal(archivedParent.querySelector(".morning-os-task-done"), null);
  archivedParent.querySelector<HTMLButtonElement>('[title="More actions"]')!.click();
  assert.match(window.document.body.textContent ?? "", /Unarchive/);
});

test("desktop minimized panels reclaim the grid while mobile restores both panels", t => {
  const desktop = installDom(1024);
  closeDom(t, desktop);
  const panels = desktop.document.body.createDiv({ cls: "mos-area-item-panels is-tasks-minimized" });
  panels.createDiv({ cls: "mos-area-item-panel is-collapsed" });
  panels.createDiv({ cls: "mos-area-item-panel" });
  assert.equal(desktop.getComputedStyle(panels).gridTemplateColumns, "minmax(0, 1fr)");
  assert.equal(desktop.getComputedStyle(panels.firstElementChild!).display, "none");

  const mobile = installDom(480);
  closeDom(t, mobile);
  const mobilePanels = mobile.document.body.createDiv({ cls: "mos-area-item-panels is-tasks-minimized" });
  mobilePanels.createDiv({ cls: "mos-area-item-panel is-collapsed" });
  mobilePanels.createDiv({ cls: "mos-area-item-panel" });
  assert.equal(mobile.getComputedStyle(mobilePanels).display, "block");
  assert.equal(mobile.getComputedStyle(mobilePanels.firstElementChild!).display, "block");
});

test("inline editing keeps the live draft through an external replacement and shows both text choices", async t => {
  const window = installDom();
  closeDom(t, window);
  const edited = item("external-inline");
  const files = new Map<string, string>();
  files.set("_generated/data/state.json", JSON.stringify({ schemaVersion: 1, revision: 1, writtenAt: "2026-09-16T10:00:00", items: [edited] }));
  const adapter = {
    exists: async (path: string) => files.has(path) || path === "_generated" || path === "_generated/data" || path === "_generated/snapshots",
    read: async (path: string) => files.get(path) ?? "",
    write: async (path: string, value: string) => { files.set(path, value); },
    mkdir: async () => undefined,
    list: async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(`${path}/`)), folders: [] }),
  };
  const app = {
    vault: { adapter, getAbstractFileByPath: (path: string) => new TFile(path) },
    fileManager: { trashFile: async (file: TFile) => { files.delete(file.path); } },
  } as never;
  const row = window.document.body.createDiv();
  const text = row.createSpan({ text: edited.text });
  let refreshed = 0;
  attachInlineTextEdit(app, text, edited, () => { refreshed++; });
  text.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  const input = row.querySelector<HTMLInputElement>("input")!;
  input.value = "My local draft";
  const external = { ...edited, text: "External replacement", notes: "Unrelated external details" };
  files.set("_generated/data/state.json", JSON.stringify({ schemaVersion: 1, revision: 2, writtenAt: "2026-09-16T10:01:00", items: [external] }));
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise(resolve => window.setTimeout(resolve, 0));

  assert.equal(row.querySelector<HTMLInputElement>("input")?.value, "My local draft");
  assert.match(row.textContent ?? "", /Text changed elsewhere/);
  const choices = [...row.querySelectorAll<HTMLTextAreaElement>("textarea")].map(area => area.value);
  assert.deepEqual(choices, ["External replacement", "My local draft"]);
  assert.equal(refreshed, 0);
  row.querySelector<HTMLButtonElement>(".mos-edit-conflict .mos-btn-primary")!.click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  const saved = JSON.parse(files.get("_generated/data/state.json")!) as { items: Task[] };
  assert.equal(saved.items[0].text, "My local draft");
  assert.equal(saved.items[0].notes, "Unrelated external details");
  assert.equal(refreshed, 1);
});
