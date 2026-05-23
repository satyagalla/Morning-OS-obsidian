# Morning OS

A daily briefing dashboard for Obsidian. Reads your vault — tasks, goals, rules — and surfaces a focused dashboard with AI-picked insights each morning.

## Features

- **Daily brief** generated from your vault's daily notes, goals, and rules files
- **AI-powered** selection of relevant rules, identity affirmations, and suggestions
- **Carry detection** — tracks tasks that keep rolling over day after day
- **Feedback loop** — records what you resolved, what's still open, and your reactions
- **Multiple providers** — OpenAI, Gemini, Groq, AWS Bedrock
- **Works on mobile** — no Python, no terminal, no external dependencies

## Install

1. Copy `main.js`, `manifest.json`, and `styles/styles.css` to your vault at `.obsidian/plugins/morning-os/`
2. Enable the plugin in Settings → Community Plugins
3. Go to Settings → Morning OS → pick an AI provider and enter your API key
4. Click "Run agent now" or wait for the scheduled daily run

## How it works

The plugin reads your daily note and vault files (goals, rules, task lists), optionally calls an LLM to pick the most relevant items, then writes a JSON brief to `_generated/briefs/`. The dashboard renders that brief.

The AI only generates text in the **Suggestions** field. Everything else is copied verbatim from your vault — the LLM just picks which items to surface today.

## Vault structure

The plugin expects these files (all paths configurable in settings):

```
Essential/
  Daily/YYYY-MM-DD.md       ← daily notes with ## Red alert, ## Regular, ## Wins
  State of Mind/
    Tactical Rules.md       ← bullet list of rules
    Emotional Rules.md      ← identity affirmations
    Long-term and Short-term.md  ← goals with ## Short Term, ## Long Term
  Pending Tasks/
    Technical Tasks.md
    Hobby Tasks.md
_generated/                 ← plugin writes here (briefs, feedback)
```

Daily note format:

```markdown
## Red alert
- [ ] urgent task

## Regular
- [ ] normal task

## Wins
- something good that happened
```

## LLM Providers

| Provider | Credential needed |
|---|---|
| AWS Bedrock | Access Key ID + Secret Access Key |
| OpenAI | API key |
| Google Gemini | API key |
| Groq | API key |

Configure in Settings → Morning OS → AI provider.

## Configuration

Everything is configured from **Settings → Morning OS**:

- **AI provider** — provider, model, credentials
- **Vault paths** — all source file and output folder paths
- **Section headings** — heading names used in your daily note and goals file
- **How many items to show** — counts for each field
- **AI vs direct mode** — per-field toggle between AI-picked and verbatim-from-vault

## Development

```bash
npm install
npm run dev     # watch mode
npm run build   # production build
```
