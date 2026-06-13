import { App } from "obsidian";
import type { MorningOSSettings } from "../settings";
import type { DailyBrief } from "../types";

export async function findMostRecentBrief(
  beforeDate: string,
  app: App,
  settings: MorningOSSettings
): Promise<{ date: string; brief: DailyBrief } | null> {
  const d = new Date(beforeDate + "T12:00:00");
  for (let i = 1; i <= settings.carryLookbackDays; i++) {
    d.setDate(d.getDate() - 1);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const path = `${settings.briefsDir}/${dateStr}.json`;
    if (await app.vault.adapter.exists(path)) {
      try {
        const raw = await app.vault.adapter.read(path);
        return { date: dateStr, brief: JSON.parse(raw) as DailyBrief };
      } catch { continue; }
    }
  }
  return null;
}
