import { App } from "obsidian";
import type { MorningOSSettings } from "../settings";
import type { TaskItem } from "./vault-reader";
import { fuzzyMatch } from "./carry-detector";

export async function computeFeedback(
  todayTasks: { red_alert: TaskItem[]; regular: TaskItem[] },
  todayStr: string,
  app: App,
  settings: MorningOSSettings
): Promise<void> {
  const d = new Date(todayStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const briefPath = `${settings.briefsDir}/${yesterdayStr}.json`;
  const exists = await app.vault.adapter.exists(briefPath);
  if (!exists) return;

  let yesterdayBrief: any;
  try {
    const raw = await app.vault.adapter.read(briefPath);
    yesterdayBrief = JSON.parse(raw);
  } catch {
    return;
  }

  const todayAllTexts: string[] = [
    ...todayTasks.red_alert.filter(t => !t.done).map(t => t.text),
    ...todayTasks.regular.filter(t => !t.done).map(t => t.text),
  ];

  const yesterdayAllTasks: { text: string; carried_from?: string | null }[] = [
    ...(yesterdayBrief?.tasks?.red_alert ?? []),
    ...(yesterdayBrief?.tasks?.regular ?? []),
  ];

  const resolved: string[] = [];
  const stillOpen: string[] = [];
  const daysCarried: Record<string, number> = {};

  const todayDate = new Date(todayStr + "T12:00:00");

  for (const task of yesterdayAllTasks) {
    const taskText = task.text;
    const stillPresent = todayAllTexts.some(t => fuzzyMatch(taskText, t));
    if (stillPresent) {
      stillOpen.push(taskText);
    } else {
      resolved.push(taskText);
      if (task.carried_from) {
        const carriedDate = new Date(task.carried_from + "T12:00:00");
        const days = Math.round((todayDate.getTime() - carriedDate.getTime()) / 86400000);
        daysCarried[taskText] = days;
      }
    }
  }

  const suggestions: { text: string; source: string }[] = yesterdayBrief?.suggestions ?? [];
  const suggestionsResolved: string[] = [];
  for (const s of suggestions) {
    if (s?.text) {
      const hit = resolved.some(r =>
        s.text.split(" ").some(word => word.length > 10 && fuzzyMatch(r, word))
      );
      if (hit) suggestionsResolved.push(s.text);
    }
  }

  const reactionsPath = `${settings.feedbackDir}/reactions/${yesterdayStr}.json`;
  let userReactions: unknown = null;
  const reactionsExist = await app.vault.adapter.exists(reactionsPath);
  if (reactionsExist) {
    try {
      const raw = await app.vault.adapter.read(reactionsPath);
      userReactions = JSON.parse(raw);
    } catch {
      // ignore
    }
  }

  const feedback = {
    date: yesterdayStr,
    picks: {
      tactical_rules_shown: yesterdayBrief?.tactical_rules ?? [],
      identity_rules_shown: yesterdayBrief?.identity?.rules ?? [],
      hobby_tasks_shown: yesterdayBrief?.hobby_tasks ?? [],
      suggestions,
    },
    outcomes: {
      suggestions_resolved: suggestionsResolved,
      carried_tasks_resolved: resolved,
      carried_tasks_still_open: stillOpen,
      days_carried_before_resolve: daysCarried,
      new_tasks_added: todayAllTexts.length - stillOpen.length,
    },
    user_reactions: userReactions,
  };

  await app.vault.adapter.mkdir(settings.feedbackDir);
  await app.vault.adapter.write(
    `${settings.feedbackDir}/${yesterdayStr}.json`,
    JSON.stringify(feedback, null, 2)
  );
}
