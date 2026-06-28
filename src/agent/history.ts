import { App } from "obsidian";

const HISTORY_DIR = "_generated/history";

export interface SnapshotTask {
  _id: string;
  text: string;
  status_priority: "red" | "regular";
  status_completion: "open" | "done" | "dismissed";
  date_completed: string | null;
  carried_from: string | null;
}

export interface DaySnapshot {
  date: string;
  tasks: {
    red_alert: SnapshotTask[];
    regular: SnapshotTask[];
    completed_red_alert: SnapshotTask[];
    completed_regular: SnapshotTask[];
  };
}

export async function writeHistorySnapshot(
  app: App,
  dateStr: string,
  registry: { _id: string; text: string; status_priority: "red" | "regular"; status_completion: string; date_completed: string | null; is_today: boolean }[],
  carryMap: Record<string, string | null> = {}
): Promise<void> {
  const path = `${HISTORY_DIR}/${dateStr}.json`;
  if (await app.vault.adapter.exists(path)) return;

  await app.vault.adapter.mkdir(HISTORY_DIR);

  const toSnap = (t: typeof registry[0]): SnapshotTask => ({
    _id: t._id,
    text: t.text,
    status_priority: t.status_priority,
    status_completion: t.status_completion as SnapshotTask["status_completion"],
    date_completed: t.date_completed,
    carried_from: carryMap[t._id] ?? null,
  });

  const todayItems = registry.filter(t => t.is_today);

  const snapshot: DaySnapshot = {
    date: dateStr,
    tasks: {
      red_alert: todayItems.filter(t => t.status_priority === "red" && t.status_completion !== "done").map(toSnap),
      regular: todayItems.filter(t => t.status_priority === "regular" && t.status_completion !== "done").map(toSnap),
      completed_red_alert: todayItems.filter(t => t.status_priority === "red" && t.status_completion === "done").map(toSnap),
      completed_regular: todayItems.filter(t => t.status_priority === "regular" && t.status_completion === "done").map(toSnap),
    },
  };

  await app.vault.adapter.write(path, JSON.stringify(snapshot, null, 2));
}

export async function readHistorySnapshot(app: App, dateStr: string): Promise<DaySnapshot | null> {
  const path = `${HISTORY_DIR}/${dateStr}.json`;
  if (!(await app.vault.adapter.exists(path))) return null;
  try {
    return JSON.parse(await app.vault.adapter.read(path)) as DaySnapshot;
  } catch {
    return null;
  }
}

export async function findMostRecentHistory(
  beforeDate: string,
  app: App,
  lookbackDays: number
): Promise<{ date: string; snapshot: DaySnapshot } | null> {
  const d = new Date(beforeDate + "T12:00:00");
  for (let i = 1; i <= lookbackDays; i++) {
    d.setDate(d.getDate() - 1);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const snapshot = await readHistorySnapshot(app, dateStr);
    if (snapshot) return { date: dateStr, snapshot };
  }
  return null;
}
