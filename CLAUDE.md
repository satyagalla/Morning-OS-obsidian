# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vision
A multi-agent system that organizes an Obsidian vault automatically and delivers a daily briefing through a clean Obsidian plugin UI. User captures messy thoughts; the system organizes, connects, and reports back.

## Commands

All plugin commands run from `plugin/`:

```bash
npm run dev        # watch mode with inline sourcemaps
npm run build      # type-check + production bundle (minified, no sourcemaps)
```

Build output is `plugin/main.js`. After building, copy `main.js`, `manifest.json`, and `styles/styles.css` to the installed vault plugin directory: `D:\Productivity\OS\.obsidian\plugins\morning-os\`.

Run the briefing agent from the repo root:

```bash
cd agent && agent\.venv\Scripts\activate
python -m agent
```

Or via the batch script: `agent\run.bat` (used by Windows Task Scheduler for daily automation).

There are no tests.

## Architecture

```
OBSIDIAN VAULT (Dropbox sync)
  │
  ├── Briefing Agent (Claude Sonnet on AWS Bedrock) ← COMPLETE
  │     • Reads daily note, state-of-mind files, pending task lists
  │     • LLM picks relevant rules, generates suggestions, detects carried tasks
  │     • Writes _generated/briefs/YYYY-MM-DD.json
  │
  ├── Ingest Agent (Local LLM - Ollama/Qwen 2.5 7B) ← PLANNED
  │     • Tags, extracts, categorizes new/changed notes
  │     • Writes to _generated/wiki/
  │
  └── Connection Agent (Local LLM) ← PLANNED
        • Builds wiki links, cross-references, surfaces stale content
        • Updates _generated/index.json

Plugin reads _generated/briefs/YYYY-MM-DD.json and renders UI.
All agents write to _generated/ — never modify raw notes.
Plugin writes back only to daily note markdown (task completion, wins).
```

## LLM Layer (swappable per-agent)

Two LLM slots configured in `agent/vault_config.yaml`:
- **intelligence** — used for the main briefing prompt (Bedrock/Claude Sonnet)
- **fallback** — used when markdown parsing yields nothing (Ollama/Qwen local)

Supported providers: `bedrock`, `ollama`, `openai`, `gemini`, `groq`. Swap by changing `llm.intelligence.provider` in the config.

Hardware: RTX 3060 6GB — runs Qwen 2.5 7B Q4 comfortably.

## Agent Source Structure (`agent/`)

- `main.py` — entry point; orchestrates the full pipeline: read vault → detect carries → call LLM → assemble → write JSON
- `vault_reader.py` — parses daily notes, goal files, bullet files from markdown
- `carry_detector.py` — fuzzy-matches today's tasks against yesterday's brief to find carried-over items and their original date
- `assembler.py` — combines raw parsed data with LLM output into the final brief dict; all field counts come from `vault_config.yaml`
- `feedback.py` — runs at agent start; compares yesterday's brief against today's tasks to record what was resolved, still open, and user reactions
- `llm.py` — `LLMClient` with two slots (`intelligence`, `fallback`); dynamically loads provider by name
- `providers/` — one file per provider (`bedrock.py`, `ollama.py`, `openai_provider.py`, `gemini.py`, `groq.py`), all implement `LLMProvider.generate(system, user) -> str`
- `prompts.py` — all prompt strings; counts injected at runtime from config (no hardcoded numbers)
- `config.py` — loads `vault_config.yaml` + `.env`
- `vault_config.yaml` — single source of truth for all paths, LLM config, field modes, and counts

## Plugin Source Structure (`plugin/`)

- `plugin/src/main.ts` — registers `MorningView`, ribbon icon, and command
- `plugin/src/view.ts` — `MorningView extends ItemView`; reads today's JSON, renders all sections; writes back to daily note on task completion and win entry; writes reaction JSON on thumbs up/down
- `plugin/src/types.ts` — `DailyBrief` TypeScript interface (canonical schema definition)
- `plugin/styles/styles.css` — all styling via Obsidian CSS vars; no external dependencies

### UI Layout (60/40 two-column body)

```
Date header (full-width)
Identity strip — identity.rules as pills (full-width)
Goals — collapsed bar, hover to reveal short_term / long_term columns (full-width)
─────────────────────────────────────────
Left (60%)              │ Right (40%)
Red alert tasks         │ Rules for today (tactical_rules)
Regular tasks           │ Suggestions (3 cards with 👍/👎)
─────────────────────────────────────────
Pending tasks — collapsed bar, hover to reveal full technical_tasks list with count
Hobby tasks — full-width pill strip
Wins — full-width, inline add field writes back to daily note
```

### Plugin Writebacks
The plugin is mostly read-only but writes back to the vault in three cases:
- **Task checkbox** → flips `- [ ]` ↔ `- [x]` in `Essential/Daily/YYYY-MM-DD.md`
- **Win added** → appends `- text` under `## Wins` in the same daily note
- **Suggestion reaction** → writes `_generated/feedback/reactions/YYYY-MM-DD.json` with `suggestion_reactions: ["up"|"down"|null, ...]`

## Brief Schema (`_generated/briefs/YYYY-MM-DD.json`)

Canonical definition is `plugin/src/types.ts`. Summary:

```json
{
  "date": "2026-05-21",
  "identity": { "rules": ["string"] },
  "goals": {
    "short_term": ["string"],
    "long_term": ["string"]
  },
  "tasks": {
    "red_alert": [{ "text": "string", "carried_from": "YYYY-MM-DD | null" }],
    "regular":   [{ "text": "string", "carried_from": "YYYY-MM-DD | null" }]
  },
  "tactical_rules": ["string"],
  "technical_tasks": ["string"],
  "hobby_tasks": ["string"],
  "suggestions": [{ "text": "string", "source": "folder/note-name" }],
  "wins": ["string"]
}
```

All counts (tactical_rules, identity_rules, technical_tasks, hobby_tasks, suggestions) are controlled by `vault_config.yaml fields.*count`. The LLM only generates new text in `suggestions` — all other fields are verbatim copies from vault markdown.

## Vault File Schema

### Daily Notes (`Essential/Daily/YYYY-MM-DD.md`)

```markdown
## I am someone who
(3 identity statements)

## Red alert
- [ ] task

## Regular
- [ ] task

## Thoughts
(unstructured captures — agent processes into inbox/pending)

## Top 3 pending
1. item

## Wins
(filled before sleep)
```

### Folder Structure
```
Essential/
  Daily/           ← YYYY-MM-DD.md daily notes
  Pending Tasks/   ← Technical Tasks.md, Hobby Tasks.md
  State of Mind/   ← Tactical Rules.md, Emotional Rules.md, Long-term and Short-term.md
Meetings/          ← freeform interview/meeting notes
Private/           ← journals, personal
Shower thoughts/   ← ideas
Tutorial/          ← learning journeys
_generated/        ← agents write here (briefs/, feedback/)
inbox.md           ← quick capture target
```

## Build Order

### Phase 1 — UI Plugin (COMPLETE)
Installed at `D:\Productivity\OS\.obsidian\plugins\morning-os\`.

### Phase 2 — Briefing Agent (COMPLETE)
- Python script at `agent/`, runs daily via Windows Task Scheduler (`agent\run.bat`)
- Reads vault markdown, applies State of Mind rules, generates brief JSON
- Detects carried tasks by fuzzy-matching against previous day's brief
- Records feedback (resolved tasks, user reactions) in `_generated/feedback/`
- Uses Claude Sonnet on AWS Bedrock (us-east-2)

### Phase 3 — Ingest Agent
- Watches for file changes (or scheduled)
- Processes new/modified notes: extract tags, tasks, key points
- Writes to `_generated/wiki/`
- Uses local LLM (Ollama)

### Phase 4 — Connection Agent
- Runs after ingest; builds cross-references, finds orphaned content
- Updates `_generated/index.json`

### Future — Agent Learning
- Feedback loop is already wired: `_generated/feedback/YYYY-MM-DD.json` records what was resolved, still open, and user reactions to suggestions
- Agent can use this history to weight rule/suggestion picks over time

## Key Decisions
- Agents write to `_generated/`, never modify raw notes (plugin is the only exception: task completion + wins)
- All behavior controlled from `vault_config.yaml` — no hardcoded counts or paths in code
- LLM only generates new text in `suggestions`; all other fields are verbatim from vault
- Local LLM handles bulk parsing fallback; cloud (Bedrock) handles judgment calls
- Dropbox syncs `_generated/` so mobile works without changes
- `carried_from` always points to the first day a task appeared — chain-propagated through daily briefs
