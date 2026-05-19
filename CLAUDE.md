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

There are no tests.

## Architecture

```
OBSIDIAN VAULT (Dropbox sync)
  │
  ├── Ingest Agent (Local LLM - Ollama/Qwen 2.5 7B)
  │     • Tags, extracts, categorizes new/changed notes
  │
  ├── Connection Agent (Local LLM)
  │     • Builds wiki links, cross-references, surfaces stale content
  │
  └── Briefing Agent (Claude Sonnet on AWS Bedrock)
        • Generates morning brief with identity, rules, tasks, surfaced notes
        • Picks tactical rules relevant to today's tasks
        • Detects carried-over tasks and flags stale ones

All agents write to _generated/ — never modify raw notes.
Plugin reads _generated/briefs/YYYY-MM-DD.json and renders UI.
```

## LLM Layer (swappable per-agent)

```json
{
  "agents": {
    "ingest": { "provider": "ollama", "model": "qwen2.5:7b" },
    "connections": { "provider": "ollama", "model": "qwen2.5:7b" },
    "briefing": { "provider": "bedrock", "model": "claude-sonnet-4-6-20250514" }
  }
}
```

Hardware: RTX 3060 6GB — runs Qwen 2.5 7B Q4 comfortably.

## Plugin Source Structure

- `plugin/src/main.ts` — registers `MorningView`, ribbon icon, and command
- `plugin/src/view.ts` — `MorningView extends ItemView`; reads today's JSON from `_generated/briefs/YYYY-MM-DD.json` and renders all sections using Obsidian's DOM API (no React/HTML strings)
- `plugin/src/types.ts` — `DailyBrief` TypeScript interface (canonical schema definition)
- `plugin/styles/styles.css` — all styling via Obsidian CSS vars; no external dependencies
- `mock-data/_generated/briefs/2026-05-19.json` — reference mock brief matching current schema

### UI Layout (60/40 two-column body)

```
Date header (full-width)
Identity strip — identity.rules as pills (full-width)
Goals — collapsed bar, hover to reveal short_term / long_term columns (full-width)
─────────────────────────────────────────
Left (60%)              │ Right (40%)
Red alert tasks         │ Rules for today (tactical_rules)
Regular tasks           │ Suggestion box (suggestion.text + source)
─────────────────────────────────────────
Hobby tasks — full-width pill strip
Wins — full-width, fill before sleep
```

## Brief Schema (`_generated/briefs/YYYY-MM-DD.json`)

Canonical definition is `plugin/src/types.ts`. Summary:

```json
{
  "date": "2026-05-19",
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
  "hobby_tasks": ["string"],
  "suggestion": { "text": "string", "source": "folder/note-name" } ,
  "wins": ["string"]
}
```

`suggestion` is nullable. `tactical_rules` count is variable (agent picks what's relevant, not always 3).

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
  Pending Tasks/   ← Important Future Tasks.md, Hobby Tasks.md
  State of Mind/   ← Tactical Rules.md, Emotional Rules.md, Long-term and Short-term.md
Meetings/          ← freeform interview/meeting notes
Private/           ← journals, personal
Shower thoughts/   ← ideas
Tutorial/          ← learning journeys
_generated/        ← agents write here (briefs/, wiki/, index.json)
inbox.md           ← quick capture target
```

## Build Order

### Phase 1 — UI Plugin (COMPLETE)
Installed at `D:\Productivity\OS\.obsidian\plugins\morning-os\`.

### Phase 2 — Briefing Agent (NEXT)
- Python script, runs daily via Task Scheduler
- Reads vault, applies State of Mind rules, generates brief JSON
- Detects carried tasks by comparing with previous day's brief
- Uses Claude Sonnet on Bedrock

### Phase 3 — Ingest Agent
- Watches for file changes (or scheduled)
- Processes new/modified notes: extract tags, tasks, key points
- Writes to `_generated/wiki/`
- Uses local LLM (Ollama)

### Phase 4 — Connection Agent
- Runs after ingest; builds cross-references, finds orphaned content
- Updates `_generated/index.json`

### Future — Agent Learning
- Store user corrections in `_generated/feedback/`
- Agent adjusts behavior based on correction history

## Key Decisions
- Agents write to `_generated/`, never modify raw notes
- Plugin is read-only — displays what agents prepared
- Local LLM handles bulk work; cloud (Bedrock) handles judgment calls
- Dropbox syncs `_generated/` so mobile works without changes