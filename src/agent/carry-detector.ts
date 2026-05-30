import { App } from "obsidian";
import type { MorningOSSettings } from "../settings";
import type { TaskItem } from "./vault-reader";
import { findMostRecentBrief } from "./find-recent-brief";

export interface TaskWithCarry {
  text: string;
  carried_from: string | null;
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
  todayTasks: { red_alert: TaskItem[]; regular: TaskItem[] },
  todayStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<CarriedTasks> {
  const found = await findMostRecentBrief(todayStr, app, settings);
  const prevStr = found?.date ?? null;
  let yesterdayTasks: TaskWithCarry[] = [];

  if (found) {
    yesterdayTasks = [
      ...(found.brief?.tasks?.red_alert ?? []),
      ...(found.brief?.tasks?.regular ?? []),
    ];
  }

  const result: CarriedTasks = { red_alert: [], regular: [] };

  for (const category of ["red_alert", "regular"] as const) {
    for (const task of todayTasks[category]) {
      if (task.done) continue;
      let carriedFrom: string | null = null;
      for (const prev of yesterdayTasks) {
        if (fuzzyMatch(task.text, prev.text)) {
          carriedFrom = prev.carried_from ?? prevStr;
          break;
        }
      }
      result[category].push({ text: task.text, carried_from: carriedFrom });
    }
  }

  return result;
}
