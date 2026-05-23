import { App, Notice } from "obsidian";
import type { MorningOSSettings } from "../settings";
import { parseDailyNote, parseYesterdayWins, parseBulletFile, parseGoals } from "./vault-reader";
import { detectCarries } from "./carry-detector";
import { computeFeedback } from "./feedback";
import { callLLM } from "./llm";
import { assembleBrief, LLMOutput } from "./assembler";
import { INTELLIGENCE_SYSTEM, formatUserPrompt } from "./prompts";

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

export async function runAgent(app: App, settings: MorningOSSettings): Promise<void> {
  const dateStr = todayStr();

  const dailyData = await parseDailyNote(dateStr, app, settings);
  if (dailyData === null) {
    throw new Error(`No daily note found for ${dateStr}. Create ${settings.dailyNoteDir}/${dateStr}.md first.`);
  }

  const [tacticalRules, emotionalRules, technicalTasks, hobbyTasksRaw, goals, yesterdayWins] =
    await Promise.all([
      parseBulletFile(settings.sourceTacticalRules, app),
      parseBulletFile(settings.sourceEmotionalRules, app),
      parseBulletFile(settings.sourceTechnicalTasks, app),
      parseBulletFile(settings.sourceHobbyTasks, app),
      parseGoals(app, settings),
      parseYesterdayWins(dateStr, app, settings),
    ]);

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
    settings.modeSuggestion;

  let llmOutput: LLMOutput | null = null;

  if (needsLLM) {
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
      technicalTasks: technicalTasks.slice(0, settings.technicalTasksCount).map(t => `- ${t}`).join("\n") || "None",
      hobbyTasks: hobbyTasksRaw.map(t => `- ${t}`).join("\n") || "None",
      yesterdayWins: yesterdayWins.map(w => `- ${w}`).join("\n") || "None",
      tacticalRulesCount: settings.tacticalRulesCount,
      identityRulesCount: settings.identityRulesCount,
      suggestionCount: settings.suggestionCount,
      hobbyTasksCount: settings.hobbyTasksCount,
    });

    try {
      const raw = await callLLM(INTELLIGENCE_SYSTEM, userPrompt, settings);
      llmOutput = parseLLMResponse(raw);
    } catch (err) {
      console.error("Morning OS LLM failed, retrying once:", err);
      try {
        const raw = await callLLM(INTELLIGENCE_SYSTEM, userPrompt, settings);
        llmOutput = parseLLMResponse(raw);
      } catch (err2) {
        console.error("Morning OS LLM retry failed, using direct mode:", err2);
        llmOutput = null;
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
    settings
  );

  await app.vault.adapter.mkdir(settings.briefsDir);
  await app.vault.adapter.write(
    `${settings.briefsDir}/${dateStr}.json`,
    JSON.stringify(brief, null, 2)
  );
}
