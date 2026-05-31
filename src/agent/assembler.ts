import type { MorningOSSettings } from "../settings";
import type { DailyBrief, Reminder } from "../types";
import type { CarriedTasks, TaskWithCarry } from "./carry-detector";
import type { ParsedGoals } from "./vault-reader";

export interface LLMOutput {
  tactical_rules?: string[];
  identity_rules?: string[];
  suggestions?: { text: string; source: string }[];
  hobby_tasks?: string[];
  goals?: { short_term?: string[]; long_term?: string[] };
  technical_tasks?: string[];
  tasks?: { red_alert?: string[]; regular?: string[] };
  wins?: string[];
}

function reorderTasks(
  carried: TaskWithCarry[],
  llmOrder: string[]
): TaskWithCarry[] {
  const result: TaskWithCarry[] = [];
  const remaining = [...carried];

  for (const text of llmOrder) {
    const idx = remaining.findIndex(t => t.text === text);
    if (idx !== -1) {
      result.push(remaining.splice(idx, 1)[0]);
    }
  }
  // Append any tasks the LLM omitted (safety net)
  result.push(...remaining);
  return result;
}

export function assembleBrief(
  dateStr: string,
  carriedTasks: CarriedTasks,
  completedTasks: { red_alert: string[]; regular: string[] },
  parsedGoals: ParsedGoals,
  allTacticalRules: string[],
  allEmotionalRules: string[],
  allHobbyTasks: string[],
  allTechnicalTasks: string[],
  yesterdayWins: string[],
  llmOutput: LLMOutput | null,
  settings: MorningOSSettings,
  reminders: Reminder[] = []
): DailyBrief {
  const tacticalRules =
    settings.modeTacticalRules && llmOutput?.tactical_rules
      ? llmOutput.tactical_rules
      : allTacticalRules.slice(0, settings.tacticalRulesCount);

  const identityRules =
    settings.modeIdentityRules && llmOutput?.identity_rules
      ? llmOutput.identity_rules
      : allEmotionalRules.slice(0, settings.identityRulesCount);

  const goals =
    settings.modeGoals && llmOutput?.goals
      ? {
          short_term: llmOutput.goals.short_term ?? parsedGoals.short_term,
          long_term: llmOutput.goals.long_term ?? parsedGoals.long_term,
        }
      : parsedGoals;

  const hobbyTasks =
    settings.modeHobbyTasks && llmOutput?.hobby_tasks
      ? llmOutput.hobby_tasks
      : allHobbyTasks.slice(0, settings.hobbyTasksCount);

  const suggestions =
    settings.modeSuggestion && llmOutput?.suggestions
      ? llmOutput.suggestions.slice(0, settings.suggestionCount)
      : [];

  const technicalTasks =
    settings.modeTechnicalTasks && llmOutput?.technical_tasks
      ? llmOutput.technical_tasks.slice(0, settings.technicalTasksCount)
      : allTechnicalTasks.slice(0, settings.technicalTasksCount);

  const tasks: CarriedTasks =
    settings.modeTasks && llmOutput?.tasks
      ? {
          red_alert: reorderTasks(carriedTasks.red_alert, llmOutput.tasks.red_alert ?? []),
          regular: reorderTasks(carriedTasks.regular, llmOutput.tasks.regular ?? []),
        }
      : carriedTasks;

  const wins =
    settings.modeWins && llmOutput?.wins
      ? llmOutput.wins
      : yesterdayWins;

  return {
    date: dateStr,
    meta: {
      goals: {
        short_term_count: settings.goalsShortTermCount,
        long_term_count: settings.goalsLongTermCount,
      },
    },
    identity: { rules: identityRules },
    goals,
    tasks: {
      ...tasks,
      completed_red_alert: completedTasks.red_alert,
      completed_regular: completedTasks.regular,
    },
    tactical_rules: tacticalRules,
    technical_tasks: technicalTasks,
    hobby_tasks: hobbyTasks,
    suggestions,
    wins,
    reminders,
  };
}
