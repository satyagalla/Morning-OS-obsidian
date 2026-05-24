import { App } from "obsidian";
import type { MorningOSSettings } from "../settings";
import type { TaskItem } from "./vault-reader";

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
  const d = new Date(todayStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const briefPath = `${settings.briefsDir}/${yesterdayStr}.json`;
  let yesterdayTasks: TaskWithCarry[] = [];

  const exists = await app.vault.adapter.exists(briefPath);
  if (exists) {
    try {
      const raw = await app.vault.adapter.read(briefPath);
      const brief = JSON.parse(raw);
      yesterdayTasks = [
        ...(brief?.tasks?.red_alert ?? []),
        ...(brief?.tasks?.regular ?? []),
      ];
    } catch {
      // yesterday brief unreadable — treat as first run
    }
  }

  const result: CarriedTasks = { red_alert: [], regular: [] };

  for (const category of ["red_alert", "regular"] as const) {
    for (const task of todayTasks[category]) {
      if (task.done) continue;
      let carriedFrom: string | null = null;
      for (const prev of yesterdayTasks) {
        if (fuzzyMatch(task.text, prev.text)) {
          carriedFrom = prev.carried_from ?? yesterdayStr;
          break;
        }
      }
      result[category].push({ text: task.text, carried_from: carriedFrom });
    }
  }

  return result;
}
