import { App } from "obsidian";
import type { MorningOSSettings } from "../settings";
import type { DailyBrief, TaskRegistry } from "../types";
import { parseAllAreaSections, parseWinsFromLog } from "./vault-reader";
import { loadRegistry } from "../task-registry";
import { callLLM } from "./llm";
import { assembleBrief, LLMOutput } from "./assembler";
import { INTELLIGENCE_SYSTEM, formatUserPrompt } from "./prompts";
import { todayStr } from "../utils";

const TECHNICAL_CONTEXT_LIMIT = 15;

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

function mayIncludeItemInAIContext(item: TaskRegistry[number], settings: MorningOSSettings): boolean {
  if (!item.areas.length) return false;
  return item.areas.every(areaKey => settings.areas.find(area => area.key === areaKey)?.feedToLLM === true);
}

async function readMappedAreaSections(
  app: App,
  settings: MorningOSSettings,
  onlyFeedToLLM = false
) {
  const mappings = settings.llmSectionMappings ?? [];
  const getMappingHeading = (target: string) => mappings.find(m => m.target === target && m.enabled)?.heading;
  const readSection = (target: string) => {
    const heading = getMappingHeading(target);
    return heading
      ? parseAllAreaSections(app, settings, heading, onlyFeedToLLM)
      : Promise.resolve([] as string[]);
  };

  const [tacticalRules, emotionalRules, goalsShort, goalsLong] = await Promise.all([
    readSection("tactical_rules"),
    readSection("emotional_rules"),
    readSection("goals_short"),
    readSection("goals_long"),
  ]);

  return { tacticalRules, emotionalRules, goalsShort, goalsLong };
}

export async function runAgent(app: App, settings: MorningOSSettings): Promise<AgentResult> {
  const dateStr = todayStr();

  const registry = await loadRegistry(app);

  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const yesterdayCompleted = registry
    .filter(t => t.status_completion === "done" && t.date_completed === yesterdayStr)
    .map(t => t.text);

  // Direct briefing fields read all areas. Feed to LLM is applied separately
  // when an AI prompt is built, never while collecting direct content.
  const [directSections, yesterdayWins] = await Promise.all([
    readMappedAreaSections(app, settings),
    parseWinsFromLog(dateStr, app, settings),
  ]);
  const goals = { short_term: directSections.goalsShort, long_term: directSections.goalsLong };

  const permittedRegistry = registry.filter(item => mayIncludeItemInAIContext(item, settings));
  const technicalTasks = permittedRegistry
    .filter(t => !t.is_deleted && !t.is_today && t.areas.includes("career") && t.status_completion === "open")
    .slice(0, TECHNICAL_CONTEXT_LIMIT)
    .map(t => t.text);

  const todayTasks = getTodayTasksForPrompt(permittedRegistry);

  const needsLLM = settings.aiEnabled && (
    settings.modeTacticalRules || settings.modeIdentityRules || settings.modeGoals ||
    settings.modeSuggestion || settings.modeWins
  );

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
    const llmSections = await readMappedAreaSections(app, settings, true);
    const userPrompt = formatUserPrompt({
      redAlertTasks:   todayTasks.red_alert.map(t => `- ${t.text}`).join("\n") || "None",
      regularTasks:    todayTasks.regular.map(t => `- ${t.text}`).join("\n") || "None",
      tacticalRules:   llmSections.tacticalRules.map(r => `- ${r}`).join("\n") || "None",
      emotionalRules:  llmSections.emotionalRules.map(r => `- ${r}`).join("\n") || "None",
      shortTermGoals:  llmSections.goalsShort.map(g => `- ${g}`).join("\n") || "None",
      longTermGoals:   llmSections.goalsLong.map(g => `- ${g}`).join("\n") || "None",
      technicalTasks:  technicalTasks.map(t => `- ${t}`).join("\n") || "None",
      yesterdayWins:   yesterdayWins.map(w => `- ${w}`).join("\n") || "None",
      yesterdayCompleted: yesterdayCompleted.map(t => `- ${t}`).join("\n") || "None",
      tacticalRulesCount:   settings.tacticalRulesCount,
      identityRulesCount:   settings.identityRulesCount,
      suggestionCount:      settings.suggestionCount,
      modeTacticalRules:    settings.modeTacticalRules,
      modeIdentityRules:    settings.modeIdentityRules,
      modeGoals:            settings.modeGoals,
      modeSuggestion:       settings.modeSuggestion,
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
    dateStr, goals, directSections.tacticalRules, directSections.emotionalRules,
    yesterdayWins, llmOutput, settings
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
  if (settings.aiEnabled && settings.modeTacticalRules) cachedLLM.tactical_rules = existingBrief.tactical_rules;
  if (settings.aiEnabled && settings.modeIdentityRules) cachedLLM.identity_rules = existingBrief.identity?.rules;
  if (settings.aiEnabled && settings.modeSuggestion) cachedLLM.suggestions = existingBrief.suggestions;
  if (settings.aiEnabled && settings.modeGoals) cachedLLM.goals = existingBrief.goals;
  if (settings.aiEnabled && settings.modeWins) cachedLLM.wins = existingBrief.wins;

  const [directSections, yesterdayWins] = await Promise.all([
    readMappedAreaSections(app, settings),
    parseWinsFromLog(dateStr, app, settings),
  ]);
  const goals = { short_term: directSections.goalsShort, long_term: directSections.goalsLong };

  const brief = assembleBrief(
    dateStr, goals, directSections.tacticalRules, directSections.emotionalRules,
    yesterdayWins, cachedLLM, settings
  );
  await app.vault.adapter.write(briefPath, JSON.stringify(brief, null, 2));
}
