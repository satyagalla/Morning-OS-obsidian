INTELLIGENCE_SYSTEM = """You are a personal productivity assistant. You help a user with ADHD stay focused by selecting the most relevant rules and generating actionable suggestions. Be concise and direct. Do not be preachy or generic. Your picks must be specific to today's tasks."""

INTELLIGENCE_USER = """Here is my situation today:

## Today's Tasks
Red alert: {red_alert_tasks}
Regular: {regular_tasks}

## Carried Tasks (been putting off)
{carried_summary}

## All Tactical Rules (pick 3-5 most relevant for TODAY's specific tasks)
{tactical_rules}

## All Emotional/Identity Rules (pick exactly 3 as today's identity affirmations)
{emotional_rules}

## Goals (rephrase into actionable daily framing)
Short-term: {short_term_goals}
Long-term: {long_term_goals}

## Technical Tasks Backlog (pick 2-3 light/fun ones for guilt-free downtime)
{technical_tasks}

## Hobby Tasks
{hobby_tasks}

## Yesterday's Wins
{yesterday_wins}

Respond in this EXACT JSON format (no other text):
{{
  "tactical_rules": ["rule1", "rule2", "rule3"],
  "identity_rules": ["rule1", "rule2", "rule3"],
  "suggestions": [
    {{"text": "...", "source": "vault/path/to/note"}},
    {{"text": "...", "source": "vault/path/to/note"}},
    {{"text": "...", "source": "vault/path/to/note"}}
  ],
  "hobby_tasks": ["task1", "task2", "task3"],
  "goals": {{
    "short_term": ["goal1", "goal2"],
    "long_term": ["goal1", "goal2"]
  }}
}}

Rules for your response:
- tactical_rules: Pick 3-5 from the tactical list that are DIRECTLY relevant to today's tasks. Copy them VERBATIM — do not rephrase or generate new rules.
- identity_rules: Pick exactly 3 from the emotional rules list. Copy them VERBATIM — do not rephrase or generate new rules.
- suggestions: Generate exactly 3 short insights (1-2 sentences each). This is the ONLY field where you may generate new text. Each suggestion should point out a stale carried task, connect a goal to a task, or surface a pattern (e.g., avoidance). Source = the vault file path most relevant to the insight.
- hobby_tasks: Pick 2-3 items from the Hobby Tasks list provided. Copy them VERBATIM — do not generate new tasks. If both lists are empty, return [].
- goals: Copy the short_term and long_term goals VERBATIM — do not rephrase or generate new goals. Keep the same count as input."""

FALLBACK_SYSTEM = "You extract structured data from markdown files. Return valid JSON only, no explanation or markdown fencing."

FALLBACK_DAILY_NOTE = """Extract tasks from this daily note. Return JSON:
{{"red_alert": ["task1", "task2"], "regular": ["task1", "task2"], "wins": ["win1"]}}

Skip completed/struck-through tasks (wrapped in ~~). Only include unchecked items.

File content:
---
{content}
---"""

FALLBACK_GOALS = """Extract goals from this file. Return JSON:
{{"short_term": ["goal1", "goal2"], "long_term": ["goal1", "goal2"]}}

File content:
---
{content}
---"""

FALLBACK_BULLETS = """Extract all bullet items from this file as a flat list. Return JSON:
{{"items": ["item1", "item2"]}}

File content:
---
{content}
---"""
