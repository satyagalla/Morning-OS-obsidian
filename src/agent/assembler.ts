import type { MorningOSSettings } from "../settings";
import type { DailyBrief, SuggestionSource } from "../types";
import type { ParsedGoals } from "./vault-reader";

const VALID_SOURCES = new Set<string>(["tasks", "goals", "technical_backlog", "carried_tasks", "wins"]);

export interface LLMOutput {
  tactical_rules?: string[];
  identity_rules?: string[];
  suggestions?: { text: string; source: string }[];
  hobby_tasks?: string[];
  goals?: { short_term?: string[]; long_term?: string[] };
  technical_tasks?: string[];
  wins?: string[];
}

export function assembleBrief(
  dateStr: string,
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
      ? llmOutput.suggestions.slice(0, settings.suggestionCount).map(s => ({
          text: s.text,
          source: (VALID_SOURCES.has(s.source) ? s.source : "tasks") as SuggestionSource,
        }))
      : [];

  const technicalTasks =
    settings.modeTechnicalTasks && llmOutput?.technical_tasks
      ? llmOutput.technical_tasks.slice(0, settings.technicalTasksCount)
      : allTechnicalTasks.slice(0, settings.technicalTasksCount);

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
    tactical_rules: tacticalRules,
    technical_tasks: technicalTasks,
    hobby_tasks: hobbyTasks,
    suggestions,
    wins,
  };
}
