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
  tacticalRulesCount: number;
  identityRulesCount: number;
  suggestionCount: number;
  hobbyTasksCount: number;
}

export function formatUserPrompt(data: UserPromptData): string {
  return `Here is my situation today:

## Today's Tasks
Red alert: ${data.redAlertTasks}
Regular: ${data.regularTasks}

## Carried Tasks (been putting off)
${data.carriedSummary}

## All Tactical Rules (pick ${data.tacticalRulesCount} most relevant for TODAY's specific tasks)
${data.tacticalRules}

## All Emotional/Identity Rules (pick exactly ${data.identityRulesCount} as today's identity affirmations)
${data.emotionalRules}

## Goals (rephrase into actionable daily framing)
Short-term: ${data.shortTermGoals}
Long-term: ${data.longTermGoals}

## Technical Tasks Backlog (pick 2-3 light/fun ones for guilt-free downtime)
${data.technicalTasks}

## Hobby Tasks
${data.hobbyTasks}

## Yesterday's Wins
${data.yesterdayWins}

Respond in this EXACT JSON format (no other text):
{
  "tactical_rules": ["rule1", "rule2"],
  "identity_rules": ["rule1", "rule2"],
  "suggestions": [{"text": "...", "source": "vault/path/to/note"}],
  "hobby_tasks": ["task1", "task2"],
  "goals": {
    "short_term": ["goal1", "goal2"],
    "long_term": ["goal1", "goal2"]
  }
}

Rules for your response:
- tactical_rules: Pick ${data.tacticalRulesCount} from the tactical list that are DIRECTLY relevant to today's tasks. Copy them VERBATIM — do not rephrase or generate new rules.
- identity_rules: Pick exactly ${data.identityRulesCount} from the emotional rules list. Copy them VERBATIM — do not rephrase or generate new rules.
- suggestions: Generate exactly ${data.suggestionCount} short insights (1-2 sentences each). This is the ONLY field where you may generate new text. Each suggestion should point out a stale carried task, connect a goal to a task, or surface a pattern (e.g., avoidance). Source = the vault file path most relevant to the insight.
- hobby_tasks: Pick ${data.hobbyTasksCount} items from the Hobby Tasks list provided. Copy them VERBATIM — do not generate new tasks. If the list is empty, return [].
- goals: Copy the short_term and long_term goals VERBATIM — do not rephrase or generate new goals. Keep the same count as input.`;
}
