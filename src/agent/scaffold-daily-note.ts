import { App } from "obsidian";
import type { MorningOSSettings } from "../settings";
import { parseDailyNote } from "./vault-reader";

async function findMostRecentDailyNote(
  beforeDate: string,
  app: App,
  settings: MorningOSSettings
): Promise<{ date: string } | null> {
  const d = new Date(beforeDate + "T12:00:00");
  for (let i = 1; i <= settings.carryLookbackDays; i++) {
    d.setDate(d.getDate() - 1);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const path = `${settings.dailyNoteDir}/${dateStr}.md`;
    if (await app.vault.adapter.exists(path)) return { date: dateStr };
  }
  return null;
}

export async function scaffoldDailyNote(
  dateStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<void> {
  const notePath = `${settings.dailyNoteDir}/${dateStr}.md`;
  if (await app.vault.adapter.exists(notePath)) return;

  await app.vault.adapter.mkdir(settings.dailyNoteDir);

  const prev = await findMostRecentDailyNote(dateStr, app, settings);
  const redAlert: string[] = [];
  const regular: string[] = [];

  if (prev) {
    const parsed = await parseDailyNote(prev.date, app, settings);
    if (parsed) {
      redAlert.push(...parsed.red_alert.filter(t => !t.done).map(t => {
        const taskText = t.remind_date ? `${t.text} @remind(${t.remind_date})` : t.text;
        return `- [ ] ${taskText}`;
      }));
      regular.push(...parsed.regular.filter(t => !t.done).map(t => {
        const taskText = t.remind_date ? `${t.text} @remind(${t.remind_date})` : t.text;
        return `- [ ] ${taskText}`;
      }));
    }
  }

  const lines: string[] = [
    `## ${settings.sectionRedAlert}`,
    ...redAlert,
    ``,
    `## ${settings.sectionRegular}`,
    ...regular,
    ``,
    `## ${settings.sectionWins}`,
    ``,
  ];

  await app.vault.adapter.write(notePath, lines.join("\n"));
}
