import { App, Notice } from "obsidian";
import type { MorningOSSettings } from "../settings";
import { parseDailyNote, parseYesterdayWins, parseCompletedTasks, parseBulletFile, parseGoals } from "./vault-reader";
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
      r => r.text === nr.text && r.remind_date === nr.remind_date && r.source_date === nr.source_date
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

    // console.log("Morning OS — user prompt:\n", userPrompt);

    try {
      const raw = await callLLM(INTELLIGENCE_SYSTEM, userPrompt, settings);
      // console.log("Morning OS — raw LLM response:\n", raw);
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
    settings,
    activeReminders
  );
  await app.vault.adapter.write(
    `${settings.briefsDir}/${dateStr}.json`,
    JSON.stringify(brief, null, 2)
  );
}
