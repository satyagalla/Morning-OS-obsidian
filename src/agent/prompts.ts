export const INTELLIGENCE_SYSTEM = `You are a personal productivity assistant. You help a user with ADHD stay focused by selecting the most relevant rules and generating actionable suggestions. Be concise and direct. Do not be preachy or generic. Your picks must be specific to today's tasks.`;

export interface UserPromptData {
  redAlertTasks: string;
  regularTasks: string;
  carriedSummary: string;
  tacticalRules: string;
  emotionalRules: string;
  shortTermGoals: string;
  longTermGoals: string;
  technicalTasks: string;
  hobbyTasks: string;
  yesterdayWins: string;
  yesterdayCompleted: string;
  tacticalRulesCount: number;
  identityRulesCount: number;
  suggestionCount: number;
  hobbyTasksCount: number;
  technicalTasksCount: number;
  modeTacticalRules: boolean;
  modeIdentityRules: boolean;
  modeGoals: boolean;
  modeHobbyTasks: boolean;
  modeSuggestion: boolean;
  modeTechnicalTasks: boolean;
  modeTasks: boolean;
  modeWins: boolean;
}

export function formatUserPrompt(data: UserPromptData): string {
  let prompt = `Here is my situation today:

## Today's Tasks
Red alert: ${data.redAlertTasks}
Regular: ${data.regularTasks}

## Carried Tasks (been putting off)
${data.carriedSummary}

## Yesterday's Wins
${data.yesterdayWins}

## Yesterday's Completed Tasks
${data.yesterdayCompleted}`;

  if (data.modeTacticalRules) {
    prompt += `\n\n## All Tactical Rules (pick ${data.tacticalRulesCount} most relevant for TODAY's specific tasks)\n${data.tacticalRules}`;
  }

  if (data.modeIdentityRules) {
    prompt += `\n\n## All Emotional/Identity Rules (pick exactly ${data.identityRulesCount} as today's identity affirmations)\n${data.emotionalRules}`;
  }

  if (data.modeGoals) {
    prompt += `\n\n## Goals (rephrase into actionable daily framing)\nShort-term: ${data.shortTermGoals}\nLong-term: ${data.longTermGoals}`;
  }

  if (data.modeHobbyTasks) {
    prompt += `\n\n## Hobby Tasks (pick ${data.hobbyTasksCount} items)\n${data.hobbyTasks}`;
  }

  if (data.modeTechnicalTasks) {
    prompt += `\n\n## Technical Tasks Backlog (pick ${data.technicalTasksCount} most relevant to today's goals/tasks)\n${data.technicalTasks}`;
  } else if (data.modeSuggestion) {
    prompt += `\n\n## Technical Tasks Backlog (use for suggestions context)\n${data.technicalTasks}`;
  }

  // Build dynamic JSON schema and rules
  const schemaFields: string[] = [];
  const rules: string[] = [];

  if (data.modeTacticalRules) {
    schemaFields.push(`  "tactical_rules": ["rule1", "rule2"]`);
    rules.push(`- tactical_rules: Pick ${data.tacticalRulesCount} from the tactical list that are DIRECTLY relevant to today's tasks. Copy them VERBATIM — do not rephrase or generate new rules.`);
  }

  if (data.modeIdentityRules) {
    schemaFields.push(`  "identity_rules": ["rule1", "rule2"]`);
    rules.push(`- identity_rules: Pick exactly ${data.identityRulesCount} from the emotional rules list. Copy them VERBATIM — do not rephrase or generate new rules.`);
  }

  if (data.modeGoals) {
    schemaFields.push(`  "goals": {\n    "short_term": ["goal1", "goal2"],\n    "long_term": ["goal1", "goal2"]\n  }`);
    rules.push(`- goals: Copy the short_term and long_term goals VERBATIM — do not rephrase or generate new goals. Keep the same count as input.`);
  }

  if (data.modeHobbyTasks) {
    schemaFields.push(`  "hobby_tasks": ["task1", "task2"]`);
    rules.push(`- hobby_tasks: Pick ${data.hobbyTasksCount} items from the Hobby Tasks list. Copy them VERBATIM — do not generate new tasks. If the list is empty, return [].`);
  }

  if (data.modeSuggestion) {
    schemaFields.push(`  "suggestions": [{"text": "...", "source": "tasks|goals|technical_backlog|carried_tasks|wins"}]`);
    rules.push(`- suggestions: Generate exactly ${data.suggestionCount} short insights (1-2 sentences each). This is the ONLY field where you may generate new text. Use Yesterday's Wins and Yesterday's Completed Tasks to understand momentum — what went well, what got done. Suggest what to tackle next by drawing from the Technical Tasks Backlog in relation to today's tasks and goals. Also point out stale carried tasks or surface patterns (e.g., avoidance). source MUST be exactly one of: "tasks", "goals", "technical_backlog", "carried_tasks", "wins" — pick whichever section the insight primarily draws from. No other values are allowed.`);
  }

  if (data.modeTechnicalTasks) {
    schemaFields.push(`  "technical_tasks": ["task1", "task2"]`);
    rules.push(`- technical_tasks: Pick ${data.technicalTasksCount} from the Technical Tasks Backlog most relevant to today's goals/tasks. Copy them VERBATIM — do not rephrase or generate new tasks.`);
  }

  if (data.modeTasks) {
    schemaFields.push(`  "tasks": {\n    "red_alert": ["task1", "task2"],\n    "regular": ["task1", "task2"]\n  }`);
    rules.push(`- tasks: Reorder the red_alert and regular tasks by priority for today. Copy them VERBATIM — do not rephrase or drop any tasks. Return ALL tasks — just reordered.`);
  }

  if (data.modeWins) {
    schemaFields.push(`  "wins": ["win1", "win2"]`);
    rules.push(`- wins: Reorder yesterday's wins by significance. Copy them VERBATIM — do not rephrase or drop any wins. Return ALL wins — just reordered.`);
  }

  const schema = `{\n${schemaFields.join(",\n")}\n}`;
  prompt += `\n\nRespond in this EXACT JSON format (no other text):\n${schema}\n\nRules for your response:\n${rules.join("\n")}`;

  return prompt;
}
