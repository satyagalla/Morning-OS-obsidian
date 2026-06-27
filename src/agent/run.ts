import { App, Notice } from "obsidian";
import type { MorningOSSettings } from "../settings";
import type { DailyBrief } from "../types";
import { parseYesterdayWins, parseBulletFile, parseGoals } from "./vault-reader";
import { loadRegistry, clearNextDayTasks } from "../task-registry";
import { detectCarries } from "./carry-detector";
import { computeFeedback } from "./feedback";
import { callLLM } from "./llm";
import { assembleBrief, LLMOutput } from "./assembler";
import { INTELLIGENCE_SYSTEM, formatUserPrompt } from "./prompts";
import { todayStr } from "../utils";

type ReminderEntry = { text: string; source_date: string; remind_date: string; dismissed: boolean };

/**
 * Loads reminders.json, with two fallback layers:
 *  1. reminders.backup.json (mirrors the last successful write)
 *  2. Seed from recent brief JSONs (all dismissed:false) + Notice to user
 *
 * Returns the loaded array and a flag indicating whether a write is safe.
 * If the file was unreadable AND no backup/seed was available, write is still
 * safe — we just start fresh rather than silently dropping data.
 */
async function loadReminders(
  remindersPath: string,
  app: App,
  settings: MorningOSSettings,
  dateStr: string
): Promise<{ reminders: ReminderEntry[]; writeOk: boolean }> {
  const backupPath = remindersPath.replace(/\.json$/, ".backup.json");

  // Happy path: reminders.json exists and is valid
  const exists = await app.vault.adapter.exists(remindersPath);
  if (exists) {
    try {
      const raw = await app.vault.adapter.read(remindersPath);
      const parsed = JSON.parse(raw) as ReminderEntry[];
      // Treat an empty array as valid — no recovery needed
      return { reminders: parsed, writeOk: true };
    } catch {
      console.error("Morning OS: reminders.json is corrupt — attempting recovery");
    }
  }

  // Fallback 1: backup file
  const backupExists = await app.vault.adapter.exists(backupPath);
  if (backupExists) {
    try {
      const raw = await app.vault.adapter.read(backupPath);
      const parsed = JSON.parse(raw) as ReminderEntry[];
      if (parsed.length > 0) {
        new Notice("Morning OS: reminders.json was missing or corrupt — restored from backup. Check your reminders and re-dismiss any that no longer apply.");
        console.warn("Morning OS: reminders recovered from backup");
        return { reminders: parsed, writeOk: true };
      }
    } catch {
      console.error("Morning OS: reminders backup is also corrupt — falling back to brief seed");
    }
  }

  // Fallback 2: seed from recent brief JSONs
  const seeded: ReminderEntry[] = [];
  const d = new Date(dateStr + "T12:00:00");
  for (let i = 1; i <= settings.carryLookbackDays; i++) {
    d.setDate(d.getDate() - 1);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const briefPath = `${settings.briefsDir}/${ds}.json`;
    if (!(await app.vault.adapter.exists(briefPath))) continue;
    try {
      const brief = JSON.parse(await app.vault.adapter.read(briefPath)) as DailyBrief;
      if (!brief.reminders?.length) continue;
      for (const r of brief.reminders) {
        const alreadyPresent = seeded.some(s => s.text === r.text && s.remind_date === r.remind_date);
        if (!alreadyPresent) {
          seeded.push({ text: r.text, source_date: r.source_date, remind_date: r.remind_date, dismissed: false });
        }
      }
    } catch { continue; }
  }

  if (seeded.length > 0) {
    new Notice("Morning OS: reminders.json was missing — restored from recent briefs. All reminders are shown as active; re-dismiss any you have already handled.");
    console.warn(`Morning OS: reminders seeded from brief history (${seeded.length} entries)`);
  } else if (exists) {
    // File existed but was corrupt and no recovery source found — start fresh rather than block writes
    console.warn("Morning OS: reminders.json corrupt and no recovery source — starting fresh");
  }

  return { reminders: seeded, writeOk: true };
}

/**
 * Writes reminders.json and mirrors it to reminders.backup.json atomically
 * (backup written only after primary succeeds).
 */
async function saveReminders(
  remindersPath: string,
  reminders: ReminderEntry[],
  app: App
): Promise<void> {
  const dir = remindersPath.substring(0, remindersPath.lastIndexOf("/"));
  await app.vault.adapter.mkdir(dir);
  const json = JSON.stringify(reminders, null, 2);
  await app.vault.adapter.write(remindersPath, json);
  const backupPath = remindersPath.replace(/\.json$/, ".backup.json");
  await app.vault.adapter.write(backupPath, json);
}

export interface AgentResult {
  mode: "llm" | "direct" | "direct-no-keys";
}

function hasCredentials(settings: MorningOSSettings): boolean {
  switch (settings.intelligenceProvider) {
    case "bedrock":
      return !!(settings.awsAccessKeyId && settings.awsSecretAccessKey);
    case "openai":
      return !!settings.openaiApiKey;
    case "gemini":
      return !!settings.geminiApiKey;
    case "groq":
      return !!settings.groqApiKey;
    default:
      return false;
  }
}

function parseLLMResponse(raw: string): LLMOutput {
  let text = raw.trim();
  const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (match) text = match[1];
  return JSON.parse(text) as LLMOutput;
}

export async function runAgent(app: App, settings: MorningOSSettings): Promise<AgentResult> {
  const dateStr = todayStr();

  // Clear previous-day completed tasks from today view
  await clearNextDayTasks(app);

  const registry = await loadRegistry(app);

  const redItems = registry.filter(t => t.in_today && t.priority === "red");
  const regularItems = registry.filter(t => t.in_today && t.priority === "regular");
  const dailyData = {
    red_alert: redItems.map(t => ({ id: t.id, text: t.text, done: t.done, remind_date: t.remind_date })),
    regular: regularItems.map(t => ({ id: t.id, text: t.text, done: t.done, remind_date: t.remind_date })),
    wins: [] as { text: string; done: boolean; remind_date?: string | null }[],
    reminders: [] as string[],
  };

  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yesterdayCompleted = registry.filter(t => t.done && t.completed === yesterdayStr).map(t => t.text);

  const [tacticalRules, emotionalRules, technicalTasks, hobbyTasksRaw, goals, yesterdayWins] =
    await Promise.all([
      parseBulletFile(settings.sourceTacticalRules, app),
      parseBulletFile(settings.sourceEmotionalRules, app),
      parseBulletFile(settings.sourceTechnicalTasks, app),
      parseBulletFile(settings.sourceHobbyTasks, app),
      parseGoals(app, settings),
      parseYesterdayWins(dateStr, app, settings),
    ]);

  const allTaskItems = [...dailyData.red_alert, ...dailyData.regular, ...dailyData.wins];
  const newReminders = allTaskItems
    .filter(t => t.remind_date)
    .map(t => ({
      text: t.text,
      source_date: dateStr,
      remind_date: t.remind_date!,
      dismissed: false,
    }));

  const remindersPath = `${settings.briefsDir}/reminders.json`;
  await app.vault.adapter.mkdir(settings.briefsDir);
  const { reminders: allReminders, writeOk: remindersWriteOk } = await loadReminders(remindersPath, app, settings, dateStr);

  if (remindersWriteOk) {
    for (const nr of newReminders) {
      const exists = allReminders.some(
        r => r.text === nr.text && r.remind_date === nr.remind_date
      );
      if (!exists) allReminders.push(nr);
    }
    await saveReminders(remindersPath, allReminders, app);
  }

  const activeReminders = allReminders
    .filter(r => !r.dismissed && r.remind_date <= dateStr)
    .map(r => ({ text: r.text, source_date: r.source_date, remind_date: r.remind_date }));

  const completedTasks = {
    red_alert: registry.filter(t => t.done && t.completed === dateStr && t.priority === "red").map(t => t.text),
    regular: registry.filter(t => t.done && t.completed === dateStr && t.priority === "regular").map(t => t.text),
  };

  const carriedTasks = await detectCarries(
    { red_alert: dailyData.red_alert, regular: dailyData.regular },
    dateStr,
    app,
    settings
  );

  await computeFeedback(
    { red_alert: dailyData.red_alert, regular: dailyData.regular },
    dateStr,
    app,
    settings
  );

  const needsLLM =
    settings.modeTacticalRules ||
    settings.modeIdentityRules ||
    settings.modeGoals ||
    settings.modeHobbyTasks ||
    settings.modeSuggestion ||
    settings.modeTechnicalTasks ||
    settings.modeTasks ||
    settings.modeWins;

  let llmOutput: LLMOutput | null = null;
  let resultMode: AgentResult["mode"] = "direct";

  if (needsLLM && !hasCredentials(settings)) {
    resultMode = "direct-no-keys";
    const briefPath = `${settings.briefsDir}/${dateStr}.json`;
    if (await app.vault.adapter.exists(briefPath)) {
      try {
        const existing = JSON.parse(await app.vault.adapter.read(briefPath)) as DailyBrief;
        if (existing.suggestions?.length) {
          llmOutput = { suggestions: existing.suggestions };
        }
      } catch { /* intentional — stale brief JSON is not critical */ }
    }
  } else if (needsLLM) {
    const carried = [
      ...carriedTasks.red_alert,
      ...carriedTasks.regular,
    ]
      .filter(t => t.carried_from)
      .map(t => `- ${t.text} (carried since ${t.carried_from})`);

    const userPrompt = formatUserPrompt({
      redAlertTasks: carriedTasks.red_alert.map(t => `- ${t.text}`).join("\n") || "None",
      regularTasks: carriedTasks.regular.map(t => `- ${t.text}`).join("\n") || "None",
      carriedSummary: carried.length ? carried.join("\n") : "None",
      tacticalRules: tacticalRules.map(r => `- ${r}`).join("\n") || "None",
      emotionalRules: emotionalRules.map(r => `- ${r}`).join("\n") || "None",
      shortTermGoals: goals.short_term.map(g => `- ${g}`).join("\n") || "None",
      longTermGoals: goals.long_term.map(g => `- ${g}`).join("\n") || "None",
      technicalTasks: technicalTasks.map(t => `- ${t}`).join("\n") || "None",
      hobbyTasks: hobbyTasksRaw.map(t => `- ${t}`).join("\n") || "None",
      yesterdayWins: yesterdayWins.map(w => `- ${w}`).join("\n") || "None",
      yesterdayCompleted: yesterdayCompleted.map(t => `- ${t}`).join("\n") || "None",
      tacticalRulesCount: settings.tacticalRulesCount,
      identityRulesCount: settings.identityRulesCount,
      suggestionCount: settings.suggestionCount,
      hobbyTasksCount: settings.hobbyTasksCount,
      technicalTasksCount: settings.technicalTasksCount,
      modeTacticalRules: settings.modeTacticalRules,
      modeIdentityRules: settings.modeIdentityRules,
      modeGoals: settings.modeGoals,
      modeHobbyTasks: settings.modeHobbyTasks,
      modeSuggestion: settings.modeSuggestion,
      modeTechnicalTasks: settings.modeTechnicalTasks,
      modeTasks: settings.modeTasks,
      modeWins: settings.modeWins,
    });

    try {
      const raw = await callLLM(INTELLIGENCE_SYSTEM, userPrompt, settings);
      llmOutput = parseLLMResponse(raw);
      resultMode = "llm";
    } catch {
      try {
        const raw = await callLLM(INTELLIGENCE_SYSTEM, userPrompt, settings);
        llmOutput = parseLLMResponse(raw);
        resultMode = "llm";
      } catch (err2) {
        const msg = (err2 as Error).message || "Unknown error";
        throw new Error(`LLM_FAILED: ${msg}`);
      }
    }
  }

  const brief = assembleBrief(
    dateStr,
    carriedTasks,
    completedTasks,
    goals,
    tacticalRules,
    emotionalRules,
    hobbyTasksRaw,
    technicalTasks,
    yesterdayWins,
    llmOutput,
    settings,
    activeReminders
  );
  await app.vault.adapter.write(
    `${settings.briefsDir}/${dateStr}.json`,
    JSON.stringify(brief, null, 2)
  );

  return { mode: resultMode };
}

export async function refreshBrief(app: App, settings: MorningOSSettings): Promise<void> {
  const dateStr = todayStr();
  const briefPath = `${settings.briefsDir}/${dateStr}.json`;

  const exists = await app.vault.adapter.exists(briefPath);
  if (!exists) {
    throw new Error("No brief found for today. Run the agent first.");
  }

  const existingBrief = JSON.parse(await app.vault.adapter.read(briefPath)) as DailyBrief;

  const cachedLLM: LLMOutput = {};
  if (settings.modeTacticalRules) cachedLLM.tactical_rules = existingBrief.tactical_rules;
  if (settings.modeIdentityRules) cachedLLM.identity_rules = existingBrief.identity?.rules;
  if (settings.modeSuggestion) cachedLLM.suggestions = existingBrief.suggestions;
  if (settings.modeHobbyTasks) cachedLLM.hobby_tasks = existingBrief.hobby_tasks;
  if (settings.modeGoals) cachedLLM.goals = existingBrief.goals;
  if (settings.modeTechnicalTasks) cachedLLM.technical_tasks = existingBrief.technical_tasks;
  if (settings.modeTasks) {
    cachedLLM.tasks = {
      red_alert: existingBrief.tasks.red_alert.map(t => t.text),
      regular: existingBrief.tasks.regular.map(t => t.text),
    };
  }
  if (settings.modeWins) cachedLLM.wins = existingBrief.wins;

  const registry = await loadRegistry(app);

  const redItemsRefresh = registry.filter(t => t.in_today && t.priority === "red");
  const regularItemsRefresh = registry.filter(t => t.in_today && t.priority === "regular");
  const dailyData = {
    red_alert: redItemsRefresh.map(t => ({ id: t.id, text: t.text, done: t.done, remind_date: t.remind_date })),
    regular: regularItemsRefresh.map(t => ({ id: t.id, text: t.text, done: t.done, remind_date: t.remind_date })),
    wins: [] as { text: string; done: boolean; remind_date?: string | null }[],
    reminders: [] as string[],
  };

  const [tacticalRules, emotionalRules, technicalTasks, hobbyTasksRaw, goals, yesterdayWins] =
    await Promise.all([
      parseBulletFile(settings.sourceTacticalRules, app),
      parseBulletFile(settings.sourceEmotionalRules, app),
      parseBulletFile(settings.sourceTechnicalTasks, app),
      parseBulletFile(settings.sourceHobbyTasks, app),
      parseGoals(app, settings),
      parseYesterdayWins(dateStr, app, settings),
    ]);

  const allTaskItems = [...dailyData.red_alert, ...dailyData.regular, ...dailyData.wins];
  const newReminders = allTaskItems
    .filter(t => t.remind_date)
    .map(t => ({
      text: t.text,
      source_date: dateStr,
      remind_date: t.remind_date!,
      dismissed: false,
    }));

  const remindersPath = `${settings.briefsDir}/reminders.json`;
  await app.vault.adapter.mkdir(settings.briefsDir);
  const { reminders: allRemindersRefresh, writeOk: remindersWriteOkRefresh } = await loadReminders(remindersPath, app, settings, dateStr);

  if (remindersWriteOkRefresh) {
    for (const nr of newReminders) {
      const existsAlready = allRemindersRefresh.some(
        r => r.text === nr.text && r.remind_date === nr.remind_date
      );
      if (!existsAlready) allRemindersRefresh.push(nr);
    }
    await saveReminders(remindersPath, allRemindersRefresh, app);
  }

  const activeReminders = allRemindersRefresh
    .filter(r => !r.dismissed && r.remind_date <= dateStr)
    .map(r => ({ text: r.text, source_date: r.source_date, remind_date: r.remind_date }));

  const completedTasksRefresh = {
    red_alert: dailyData.red_alert.filter(t => t.done).map(t => t.text),
    regular: dailyData.regular.filter(t => t.done).map(t => t.text),
  };

  const carriedTasks = await detectCarries(
    { red_alert: dailyData.red_alert, regular: dailyData.regular },
    dateStr,
    app,
    settings
  );

  const brief = assembleBrief(
    dateStr,
    carriedTasks,
    completedTasksRefresh,
    goals,
    tacticalRules,
    emotionalRules,
    hobbyTasksRaw,
    technicalTasks,
    yesterdayWins,
    cachedLLM,
    settings,
    activeReminders
  );
  await app.vault.adapter.write(briefPath, JSON.stringify(brief, null, 2));
}
