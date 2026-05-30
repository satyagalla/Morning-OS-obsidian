import { App, Notice } from "obsidian";
import type { MorningOSSettings } from "../settings";
import type { DailyBrief } from "../types";
import { parseDailyNote, parseYesterdayWins, parseCompletedTasks, parseBulletFile, parseGoals } from "./vault-reader";
import { detectCarries } from "./carry-detector";
import { computeFeedback } from "./feedback";
import { callLLM } from "./llm";
import { assembleBrief, LLMOutput } from "./assembler";
import { INTELLIGENCE_SYSTEM, formatUserPrompt } from "./prompts";

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

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseLLMResponse(raw: string): LLMOutput {
  let text = raw.trim();
  const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (match) text = match[1];
  return JSON.parse(text);
}

export async function runAgent(app: App, settings: MorningOSSettings): Promise<AgentResult> {
  const dateStr = todayStr();

  const dailyData = await parseDailyNote(dateStr, app, settings);
  if (dailyData === null) {
    throw new Error(`No daily note found for ${dateStr}. Create ${settings.dailyNoteDir}/${dateStr}.md first.`);
  }

  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const [tacticalRules, emotionalRules, technicalTasks, hobbyTasksRaw, goals, yesterdayWins, yesterdayCompleted] =
    await Promise.all([
      parseBulletFile(settings.sourceTacticalRules, app),
      parseBulletFile(settings.sourceEmotionalRules, app),
      parseBulletFile(settings.sourceTechnicalTasks, app),
      parseBulletFile(settings.sourceHobbyTasks, app),
      parseGoals(app, settings),
      parseYesterdayWins(dateStr, app, settings),
      parseCompletedTasks(yesterdayStr, app, settings),
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
  let allReminders: Array<{ text: string; source_date: string; remind_date: string; dismissed: boolean }> = [];
  const remindersExist = await app.vault.adapter.exists(remindersPath);
  if (remindersExist) {
    try {
      allReminders = JSON.parse(await app.vault.adapter.read(remindersPath));
    } catch {}
  }

  for (const nr of newReminders) {
    const exists = allReminders.some(
      r => r.text === nr.text && r.remind_date === nr.remind_date
    );
    if (!exists) allReminders.push(nr);
  }

  await app.vault.adapter.mkdir(settings.briefsDir);
  await app.vault.adapter.write(remindersPath, JSON.stringify(allReminders, null, 2));

  const activeReminders = allReminders
    .filter(r => !r.dismissed && r.remind_date <= dateStr)
    .map(r => ({ text: r.text, source_date: r.source_date, remind_date: r.remind_date }));

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
        const existing = JSON.parse(await app.vault.adapter.read(briefPath));
        if (existing.suggestions?.length) {
          llmOutput = { suggestions: existing.suggestions };
        }
      } catch {}
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
    } catch (err) {
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

  const existingBrief: DailyBrief = JSON.parse(await app.vault.adapter.read(briefPath));

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

  const dailyData = await parseDailyNote(dateStr, app, settings);
  if (dailyData === null) {
    throw new Error(`No daily note found for ${dateStr}. Create ${settings.dailyNoteDir}/${dateStr}.md first.`);
  }

  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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
  let allReminders: Array<{ text: string; source_date: string; remind_date: string; dismissed: boolean }> = [];
  const remindersExist = await app.vault.adapter.exists(remindersPath);
  if (remindersExist) {
    try {
      allReminders = JSON.parse(await app.vault.adapter.read(remindersPath));
    } catch {}
  }

  for (const nr of newReminders) {
    const existsAlready = allReminders.some(
      r => r.text === nr.text && r.remind_date === nr.remind_date && r.source_date === nr.source_date
    );
    if (!existsAlready) allReminders.push(nr);
  }

  await app.vault.adapter.mkdir(settings.briefsDir);
  await app.vault.adapter.write(remindersPath, JSON.stringify(allReminders, null, 2));

  const activeReminders = allReminders
    .filter(r => !r.dismissed && r.remind_date <= dateStr)
    .map(r => ({ text: r.text, source_date: r.source_date, remind_date: r.remind_date }));

  const carriedTasks = await detectCarries(
    { red_alert: dailyData.red_alert, regular: dailyData.regular },
    dateStr,
    app,
    settings
  );

  const brief = assembleBrief(
    dateStr,
    carriedTasks,
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
