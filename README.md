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

Edit `agent/vault_config.yaml` — set `vault_path` to the absolute path of your Obsidian vault root. This is the only file you ever edit outside Obsidian.

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
2. Settings → Morning OS → **Briefing agent** — set the repo path and your preferred daily run time
3. Settings → Morning OS → **AI provider** — choose your provider and enter your API key
4. Click the sun icon in the ribbon or run **Open Morning Dashboard** from the command palette

The plugin runs the agent automatically at the configured time each day. Use **Run agent now** in Settings or the command palette to trigger it on demand.

---

## Vault Structure

The agent expects this folder layout (all paths configurable in Obsidian Settings → Morning OS):

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

| Provider | Config value | Credential |
|---|---|---|
| AWS Bedrock | `bedrock` | Access Key ID + Secret Key (set in Obsidian Settings) |
| OpenAI | `openai` | API key (set in Obsidian Settings) |
| Google Gemini | `gemini` | API key (set in Obsidian Settings) |
| Groq | `groq` | API key (set in Obsidian Settings) |
| Ollama (local) | `ollama` | none — requires Ollama running at `localhost:11434` |

---

## Configuration

Everything is configured from **Obsidian Settings → Morning OS**:

- **Briefing agent** — repo path, daily run time, manual run button
- **AI provider / Fallback AI** — provider, model, credentials
- **Vault paths** — all source file and output folder paths
- **Section headings** — heading names used in your daily note and goals file
- **How many items to show** — counts for each field
- **AI vs direct mode** — per-field toggle between AI-picked and verbatim-from-vault
