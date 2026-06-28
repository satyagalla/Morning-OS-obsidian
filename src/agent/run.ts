import { App, Notice } from "obsidian";
import type { MorningOSSettings } from "../settings";
import type { DailyBrief, Task, TaskRegistry } from "../types";
import { parseYesterdayWins, parseBulletFile, parseGoals } from "./vault-reader";
import { loadRegistry, clearNextDayTasks } from "../task-registry";
import { detectCarries } from "./carry-detector";
import { computeFeedback } from "./feedback";
import { callLLM } from "./llm";
import { assembleBrief, LLMOutput } from "./assembler";
import { INTELLIGENCE_SYSTEM, formatUserPrompt } from "./prompts";
import { todayStr } from "../utils";

export interface AgentResult {
  mode: "llm" | "direct" | "direct-no-keys";
}

function hasCredentials(settings: MorningOSSettings): boolean {
  switch (settings.intelligenceProvider) {
    case "bedrock": return !!(settings.awsAccessKeyId && settings.awsSecretAccessKey);
    case "openai":  return !!settings.openaiApiKey;
    case "gemini":  return !!settings.geminiApiKey;
    case "groq":    return !!settings.groqApiKey;
    default:        return false;
  }
}

function parseLLMResponse(raw: string): LLMOutput {
  let text = raw.trim();
  const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (match) text = match[1];
  return JSON.parse(text) as LLMOutput;
}

function getTodayTasksForPrompt(registry: TaskRegistry) {
  return {
    red_alert: registry.filter(t => t.is_today && t.status_priority === "red" && t.status_completion !== "done"),
    regular:   registry.filter(t => t.is_today && t.status_priority === "regular" && t.status_completion !== "done"),
  };
}

export async function runAgent(app: App, settings: MorningOSSettings): Promise<AgentResult> {
  const dateStr = todayStr();

  // Writes yesterday's history snapshot and clears done tasks from is_today
  await clearNextDayTasks(app);
  const registry = await loadRegistry(app);

  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yesterdayCompleted = registry
    .filter(t => t.status_completion === "done" && t.date_completed === yesterdayStr)
    .map(t => t.text);

  const [tacticalRules, emotionalRules, technicalTasks, hobbyTasksRaw, goals, yesterdayWins] =
    await Promise.all([
      parseBulletFile(settings.sourceTacticalRules, app),
      parseBulletFile(settings.sourceEmotionalRules, app),
      parseBulletFile(settings.sourceTechnicalTasks, app),
      parseBulletFile(settings.sourceHobbyTasks, app),
      parseGoals(app, settings),
      parseYesterdayWins(dateStr, app, settings),
    ]);

  const todayForCarry = getTodayTasksForPrompt(registry);
  const carriedTasks = await detectCarries(todayForCarry, dateStr, app, settings);

  await computeFeedback(todayForCarry, dateStr, app, settings);

  const needsLLM =
    settings.modeTacticalRules || settings.modeIdentityRules || settings.modeGoals ||
    settings.modeHobbyTasks || settings.modeSuggestion || settings.modeTechnicalTasks ||
    settings.modeWins;

  let llmOutput: LLMOutput | null = null;
  let resultMode: AgentResult["mode"] = "direct";

  if (needsLLM && !hasCredentials(settings)) {
    resultMode = "direct-no-keys";
    const briefPath = `${settings.briefsDir}/${dateStr}.json`;
    if (await app.vault.adapter.exists(briefPath)) {
      try {
        const existing = JSON.parse(await app.vault.adapter.read(briefPath)) as DailyBrief;
        if (existing.suggestions?.length) llmOutput = { suggestions: existing.suggestions };
      } catch { /* intentional */ }
    }
  } else if (needsLLM) {
    const carried = [...carriedTasks.red_alert, ...carriedTasks.regular]
      .filter(t => t.carried_from)
      .map(t => `- ${t.text} (carried since ${t.carried_from})`);

    const userPrompt = formatUserPrompt({
      redAlertTasks:   carriedTasks.red_alert.map(t => `- ${t.text}`).join("\n") || "None",
      regularTasks:    carriedTasks.regular.map(t => `- ${t.text}`).join("\n") || "None",
      carriedSummary:  carried.length ? carried.join("\n") : "None",
      tacticalRules:   tacticalRules.map(r => `- ${r}`).join("\n") || "None",
      emotionalRules:  emotionalRules.map(r => `- ${r}`).join("\n") || "None",
      shortTermGoals:  goals.short_term.map(g => `- ${g}`).join("\n") || "None",
      longTermGoals:   goals.long_term.map(g => `- ${g}`).join("\n") || "None",
      technicalTasks:  technicalTasks.map(t => `- ${t}`).join("\n") || "None",
      hobbyTasks:      hobbyTasksRaw.map(t => `- ${t}`).join("\n") || "None",
      yesterdayWins:   yesterdayWins.map(w => `- ${w}`).join("\n") || "None",
      yesterdayCompleted: yesterdayCompleted.map(t => `- ${t}`).join("\n") || "None",
      tacticalRulesCount:   settings.tacticalRulesCount,
      identityRulesCount:   settings.identityRulesCount,
      suggestionCount:      settings.suggestionCount,
      hobbyTasksCount:      settings.hobbyTasksCount,
      technicalTasksCount:  settings.technicalTasksCount,
      modeTacticalRules:    settings.modeTacticalRules,
      modeIdentityRules:    settings.modeIdentityRules,
      modeGoals:            settings.modeGoals,
      modeHobbyTasks:       settings.modeHobbyTasks,
      modeSuggestion:       settings.modeSuggestion,
      modeTechnicalTasks:   settings.modeTechnicalTasks,
      modeTasks:            settings.modeTasks,
      modeWins:             settings.modeWins,
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
        throw new Error(`LLM_FAILED: ${(err2 as Error).message || "Unknown error"}`);
      }
    }
  }

  const brief = assembleBrief(
    dateStr, goals, tacticalRules, emotionalRules,
    hobbyTasksRaw, technicalTasks, yesterdayWins, llmOutput, settings
  );
  await app.vault.adapter.mkdir(settings.briefsDir);
  await app.vault.adapter.write(`${settings.briefsDir}/${dateStr}.json`, JSON.stringify(brief, null, 2));

  return { mode: resultMode };
}

export async function refreshBrief(app: App, settings: MorningOSSettings): Promise<void> {
  const dateStr = todayStr();
  const briefPath = `${settings.briefsDir}/${dateStr}.json`;

  const exists = await app.vault.adapter.exists(briefPath);
  if (!exists) throw new Error("No brief found for today. Run the agent first.");

  const existingBrief = JSON.parse(await app.vault.adapter.read(briefPath)) as DailyBrief;

  const cachedLLM: LLMOutput = {};
  if (settings.modeTacticalRules)  cachedLLM.tactical_rules  = existingBrief.tactical_rules;
  if (settings.modeIdentityRules)  cachedLLM.identity_rules   = existingBrief.identity?.rules;
  if (settings.modeSuggestion)     cachedLLM.suggestions      = existingBrief.suggestions;
  if (settings.modeHobbyTasks)     cachedLLM.hobby_tasks      = existingBrief.hobby_tasks;
  if (settings.modeGoals)          cachedLLM.goals            = existingBrief.goals;
  if (settings.modeTechnicalTasks) cachedLLM.technical_tasks  = existingBrief.technical_tasks;
  if (settings.modeWins)           cachedLLM.wins             = existingBrief.wins;

  const [tacticalRules, emotionalRules, technicalTasks, hobbyTasksRaw, goals, yesterdayWins] =
    await Promise.all([
      parseBulletFile(settings.sourceTacticalRules, app),
      parseBulletFile(settings.sourceEmotionalRules, app),
      parseBulletFile(settings.sourceTechnicalTasks, app),
      parseBulletFile(settings.sourceHobbyTasks, app),
      parseGoals(app, settings),
      parseYesterdayWins(dateStr, app, settings),
    ]);

  const brief = assembleBrief(
    dateStr, goals, tacticalRules, emotionalRules,
    hobbyTasksRaw, technicalTasks, yesterdayWins, cachedLLM, settings
  );
  await app.vault.adapter.write(briefPath, JSON.stringify(brief, null, 2));
}
