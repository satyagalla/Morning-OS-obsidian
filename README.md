# Morning OS

A daily briefing dashboard for Obsidian. A Python agent reads your vault each morning, applies your personal rules, and writes a structured JSON brief. The Obsidian plugin renders it as a clean dashboard — tasks, goals, tactical rules, AI-generated suggestions, and a wins tracker.

---

## Architecture

```
OBSIDIAN VAULT (Dropbox sync)
  │
  ├── Briefing Agent (Claude Sonnet on AWS Bedrock)
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

---

## Prerequisites

- Python 3.11+
- Node.js 18+
- Obsidian 1.0+
- One LLM provider (see [LLM Providers](#llm-providers) below)

---

## Agent Setup

```bash
git clone https://github.com/satyagalla/Morning-OS
cd Morning-OS/agent

python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt
```

Copy and fill in credentials:

```bash
cp .env.example .env
# Edit .env — add your provider's API key
```

Edit `agent/vault_config.yaml` — set `vault_path` to the absolute path of your Obsidian vault root.

Test it:

```bash
python -m agent
```

This writes `_generated/briefs/YYYY-MM-DD.json` inside your vault.

---

## Plugin Setup

```bash
cd Morning-OS/obsidian
npm install
npm run build
```

Copy the output files to your vault's plugin directory:

```
.obsidian/plugins/morning-os/main.js
.obsidian/plugins/morning-os/manifest.json
.obsidian/plugins/morning-os/styles.css
```

Then in Obsidian:
1. Settings → Community plugins → enable **Morning OS**
2. Settings → Morning OS — configure each path to match your vault structure
3. Click the sun icon in the ribbon or run **Open Morning Dashboard** from the command palette

---

## Automating the Agent (Windows)

Point Windows Task Scheduler at `agent\run.bat` with a daily trigger at your preferred time. The script activates the virtualenv and runs the agent relative to its own location, so it works from any install path.

---

## Vault Structure

The agent expects this folder layout (configurable in `vault_config.yaml`):

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

Daily note format (`Essential/Daily/YYYY-MM-DD.md`):

```markdown
## I am someone who
(3 identity statements)

## Red alert
- [ ] task

## Regular
- [ ] task

## Thoughts
(unstructured captures)

## Top 3 pending
1. item

## Wins
(filled before sleep)
```

---

## LLM Providers

| Provider | Config value | Required env var |
|---|---|---|
| AWS Bedrock | `bedrock` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| Ollama (local) | `ollama` | none — requires Ollama running at `localhost:11434` |

Switch providers by editing `llm.intelligence.provider` in `agent/vault_config.yaml`.

---

## Configuration

All agent behavior (paths, LLM provider, field counts) is controlled from `agent/vault_config.yaml`.

All plugin paths (briefs dir, daily note dir, reactions dir, wins header) are configurable from the plugin's Settings tab in Obsidian.
