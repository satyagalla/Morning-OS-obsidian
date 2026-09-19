import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import type { Task } from "../src/types";
import { renderWidgetNote, readWidgetOwnership, widgetNotesSemanticallyEqual } from "../src/widgets/render";
import { selectWidgetContent } from "../src/widgets/selection";
import { canonicalWidgetDestination, validateWidgetDestination, WidgetNoteWriter } from "../src/widgets/writer";
import type { WidgetNoteExport } from "../src/widgets/types";

function task(id: string): Task {
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
    date_created: "2026-09-18",
    date_modified: "2026-09-18",
    date_completed: null,
    date_remind: null,
    parent_id: null,
    kind: "task",
  };
}

const widgetExport: WidgetNoteExport = {
  id: "today",
  enabled: true,
  source: "today-tasks",
  destination: "Widgets/today.md",
  limit: 2,
};

test("Today selection keeps active children under selected roots and contextual parent labels out of the limit", () => {
  const root = task("today-root");
  root.is_today = true;
  const child = task("root-child");
  child.parent_id = root._id;
  const inactiveRoot = task("inactive-root");
  inactiveRoot.status_completion = "done";
  const contextual = task("contextual-child");
  contextual.parent_id = inactiveRoot._id;
  contextual.is_today = true;
  const closed = task("closed-child");
  closed.parent_id = root._id;
  closed.status_completion = "done";
  const selectedInactiveRoot = task("selected-inactive-root");
  selectedInactiveRoot.is_today = true;
  selectedInactiveRoot.status_completion = "done";

  const selected = selectWidgetContent({
    registry: [root, child, inactiveRoot, contextual, closed, selectedInactiveRoot],
    source: "today-tasks",
    limit: 3,
  });

  assert.deepEqual(selected.tasks.map(entry => entry.task._id), ["today-root", "root-child", "contextual-child"]);
  assert.equal(selected.tasks[2].parentContext?._id, "inactive-root");
  assert.equal(selected.tasks.some(entry => entry.task._id === "selected-inactive-root"), false);
});

test("Inbox accepts inactive unorganized roots with open children and excludes notes", () => {
  const inactiveRoot = task("inactive-root");
  inactiveRoot.status_completion = "done";
  const child = task("open-child");
  child.parent_id = inactiveRoot._id;
  const organized = task("organized");
  organized.areas = ["work"];
  const note = task("note");
  note.kind = "note";
  note.status_note = "active";
  const selected = selectWidgetContent({ registry: [inactiveRoot, child, organized, note], source: "inbox-tasks", limit: 10 });
  assert.deepEqual(selected.tasks.map(entry => entry.task._id), ["open-child"]);
  assert.equal(selected.tasks[0].parentContext?._id, "inactive-root");
});

test("All tasks retains an inactive root only as context for its open child", () => {
  const inactiveRoot = task("inactive-root");
  inactiveRoot.status_completion = "done";
  const child = task("open-child");
  child.parent_id = inactiveRoot._id;
  const selected = selectWidgetContent({ registry: [inactiveRoot, child], source: "all-tasks", limit: 10 });
  assert.deepEqual(selected.tasks.map(entry => entry.task._id), ["open-child"]);
  assert.equal(selected.tasks[0].parentContext?.text, "inactive-root");
});

test("renderer marks ownership and ignores only the updated timestamp in semantic comparison", () => {
  const selection = selectWidgetContent({ registry: [task("write report")], source: "all-tasks", limit: 10 });
  const first = renderWidgetNote({ export: widgetExport, selection, updatedAt: "September 18, 2026 08:00" });
  const later = renderWidgetNote({ export: widgetExport, selection, updatedAt: "September 18, 2026 09:00" });
  assert.deepEqual(readWidgetOwnership(first), { producer: "morning-os", version: 1, exportId: "today" });
  assert.match(first, /# Today/);
  assert.match(first, /Updated at:/);
  assert.equal(widgetNotesSemanticallyEqual(first, later), true);
  assert.equal(widgetNotesSemanticallyEqual(first, first.replace("write report", "send report")), false);
});

test("widget destinations reject protected, absolute, URI, and traversal paths", () => {
  assert.equal(validateWidgetDestination("Widgets/today.md"), "Widgets/today.md");
  assert.equal(canonicalWidgetDestination("Widgets/Today.md"), "widgets/today.md");
  for (const unsafe of ["../today.md", "/today.md", "C:/today.md", "https://example.test/today.md", ".obsidian/today.md", "_Generated/Data/today.md", "_generated/snapshots/today.md", "Widgets/today.txt"]) {
    assert.throws(() => validateWidgetDestination(unsafe));
  }
});

test("writer keeps unrelated notes intact and does not rewrite timestamp-only changes", async () => {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let modifications = 0;
  const vault = {
    getAbstractFileByPath(path: string): unknown {
      if (folders.has(path)) return {};
      return files.has(path) ? new TFile(path) : null;
    },
    read: async (file: TFile): Promise<string> => files.get(file.path) ?? "",
    modify: async (file: TFile, content: string): Promise<void> => {
      modifications++;
      files.set(file.path, content);
    },
    create: async (path: string, content: string): Promise<TFile> => {
      files.set(path, content);
      return new TFile(path);
    },
    createFolder: async (path: string): Promise<void> => { folders.add(path); },
  };
  const writer = new WidgetNoteWriter(vault);
  const first = renderWidgetNote({
    export: widgetExport,
    selection: selectWidgetContent({ registry: [task("write report")], source: "today-tasks", limit: 2 }),
    updatedAt: "September 18, 2026 08:00",
  });
  const later = first.replace("08:00", "09:00");

  assert.deepEqual(await writer.write(widgetExport, first), { changed: true });
  assert.deepEqual(await writer.write(widgetExport, later), { changed: false });
  assert.equal(modifications, 0);

  files.set("Widgets/unrelated.md", "# User note");
  await assert.rejects(() => writer.write({ ...widgetExport, destination: "Widgets/unrelated.md" }, first));
  assert.equal(files.get("Widgets/unrelated.md"), "# User note");
});
