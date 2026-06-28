import { App } from "obsidian";
import type { MorningOSSettings } from "../settings";
import { findMostRecentHistory } from "./history";
import type { SnapshotTask } from "./history";

export interface TaskWithCarry {
  text: string;
  carried_from: string | null;
  _id?: string;
}

export interface CarriedTasks {
  red_alert: TaskWithCarry[];
  regular: TaskWithCarry[];
}

const MATCH_THRESHOLD = 0.8;

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\.$/, "");
}

function bigrams(str: string): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    s.add(str.slice(i, i + 2));
  }
  return s;
}

export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let intersection = 0;
  for (const gram of ba) {
    if (bb.has(gram)) intersection++;
  }
  if (ba.size + bb.size === 0) return 0;
  return (2 * intersection) / (ba.size + bb.size);
}

export function fuzzyMatch(a: string, b: string): boolean {
  return similarity(a, b) >= MATCH_THRESHOLD;
}

export async function detectCarries(
  todayTasks: { red_alert: { _id?: string; id?: string; text: string; done?: boolean; status_completion?: string }[]; regular: { _id?: string; id?: string; text: string; done?: boolean; status_completion?: string }[] },
  todayStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<CarriedTasks> {
  const found = await findMostRecentHistory(todayStr, app, settings.carryLookbackDays);
  const prevStr = found?.date ?? null;
  const yesterdayTasks: SnapshotTask[] = found
    ? [
        ...(found.snapshot.tasks.red_alert ?? []),
        ...(found.snapshot.tasks.regular ?? []),
      ]
    : [];

  const result: CarriedTasks = { red_alert: [], regular: [] };

  for (const category of ["red_alert", "regular"] as const) {
    for (const task of todayTasks[category]) {
      const isDone = task.done === true || task.status_completion === "done";
      if (isDone) continue;

      const taskId = task._id ?? (task as { id?: string }).id;
      let carriedFrom: string | null = null;

      for (const prev of yesterdayTasks) {
        const matched = (taskId && taskId === prev._id) || fuzzyMatch(task.text, prev.text);
        if (matched) {
          carriedFrom = prev.carried_from ?? prevStr;
          break;
        }
      }
      result[category].push({ text: task.text, carried_from: carriedFrom, _id: taskId });
    }
  }

  return result;
}
