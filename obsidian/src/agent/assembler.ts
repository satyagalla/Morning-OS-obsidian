import type { MorningOSSettings } from "../settings";
import type { DailyBrief } from "../types";
import type { CarriedTasks } from "./carry-detector";
import type { ParsedGoals } from "./vault-reader";

export interface LLMOutput {
  tactical_rules?: string[];
  identity_rules?: string[];
  suggestions?: { text: string; source: string }[];
  hobby_tasks?: string[];
  goals?: { short_term?: string[]; long_term?: string[] };
}

export function assembleBrief(
  dateStr: string,
  carriedTasks: CarriedTasks,
  parsedGoals: ParsedGoals,
  allTacticalRules: string[],
  allEmotionalRules: string[],
  allHobbyTasks: string[],
  allTechnicalTasks: string[],
  yesterdayWins: string[],
  llmOutput: LLMOutput | null,
  settings: MorningOSSettings
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

  const technicalTasks = allTechnicalTasks.slice(0, settings.technicalTasksCount);

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
    tasks: carriedTasks,
    tactical_rules: tacticalRules,
    technical_tasks: technicalTasks,
    hobby_tasks: hobbyTasks,
    suggestions,
    wins: yesterdayWins,
  };
}
