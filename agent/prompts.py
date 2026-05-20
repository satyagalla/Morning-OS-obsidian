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
  "suggestion": {{"text": "...", "source": "vault/path/to/note"}} or null,
  "hobby_tasks": ["task1", "task2", "task3"],
  "goals": {{
    "short_term": ["actionable goal 1", "actionable goal 2"],
    "long_term": ["framed goal 1", "framed goal 2"]
  }}
}}

Rules for your response:
- tactical_rules: Pick 3-5 from the tactical list that are DIRECTLY relevant to today's tasks. Copy them verbatim.
- identity_rules: Pick exactly 3 from the emotional rules that resonate with today's situation. Copy verbatim.
- suggestion: Point out a stale carried task with a specific actionable idea to lower activation energy, OR connect a goal to a task, OR surface a pattern (e.g., avoidance). Keep to 1-2 sentences. Source = vault file path that inspired it. Null if nothing insightful.
- hobby_tasks: Pick 2-3 items from technical/hobby backlog that feel light, exploratory, fun. Good for evening downtime.
- goals: Rephrase the raw goals into today-relevant actionable framing. Keep the same count as input."""

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
