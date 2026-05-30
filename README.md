# Morning OS

You write everything down. Tasks, goals, rules, wins — it's all in your vault. But every morning you still open Obsidian and spend ten minutes figuring out where to start.

Morning OS reads your vault and builds a focused dashboard before you touch anything else. One screen. Everything that matters today.

---

## What you see

| Section | What it does |
|---|---|
| **Identity strip** | Your own rules about who you're trying to be — before you see a single task |
| **Goals bar** | Top short and long-term goals, so the daily grind stays connected to the bigger picture |
| **Red alert tasks** | Urgent tasks from today's note, with a badge showing how many days each has been carried |
| **Regular tasks** | Normal tasks, same carry tracking — chronic avoidance becomes visible |
| **Rules for today** | The AI picks the rules from your rules file most relevant to today's tasks |
| **Suggestions** | The one thing the AI writes: a short nudge based on your patterns and what's been sitting undone |
| **Pending backlog** | Your technical task backlog with a count — you see if it's growing without reading the whole list |
| **Hobby tasks** | Non-work items in their own section so they don't get buried |
| **Wins** | A prompt at the bottom. What you write here goes straight into your daily note |

The AI picks which of your items to surface — it never rewrites or edits your vault. The only new text it generates is the suggestion.

---

## Works on mobile

No terminal, no Python, no desktop-only dependencies. The plugin runs entirely inside Obsidian — tap the sun icon on your phone, your note is scaffolded and your brief is generated.

The only requirement is that your vault is in sync across devices. 

> **Recommended:** [Remotely Save](https://github.com/remotely-save/remotely-save) with Dropbox. Make sure your sync settings include folders with underscores — some tools exclude them by default, and Morning OS writes its briefs and feedback to `_generated/`.

With sync in place, you can review your brief and check off tasks from anywhere. The daily note and brief JSON stay consistent across all your devices.

---

## Setup

1. Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/morning-os/`
2. Enable in **Settings → Community Plugins**
3. **Settings → Morning OS** — pick a provider, enter your API key
4. Click **Run agent now**
5. Open the Morning OS panel from the sidebar (sun icon)

Runs automatically at your configured time after the first run.

**Supported AI providers:** OpenAI · Google Gemini · Groq · AWS Bedrock

---

<details>
<summary><strong>Vault structure</strong></summary>

The plugin reads files you already maintain. All paths are configurable in settings.

```
Essential/
  Daily/YYYY-MM-DD.md              ← daily note
  State of Mind/
    Tactical Rules.md
    Emotional Rules.md
    Long-term and Short-term.md
  Pending Tasks/
    Technical Tasks.md
    Hobby Tasks.md
_generated/                        ← plugin writes here
  briefs/
  feedback/
```

Daily note format:

```markdown
## Red alert
- [ ] urgent task

## Regular
- [ ] normal task

## Wins
- something good
```

Heading names are configurable.

</details>

<details>
<summary><strong>How it works</strong></summary>

1. Reads today's daily note and your source files
2. Fuzzy-matches incomplete tasks against previous briefs to detect carries (looks back up to 7 days across skipped days)
3. Single LLM call picks relevant rules, goals, hobby tasks, and writes a suggestion
4. Brief saved to `_generated/briefs/YYYY-MM-DD.json`
5. Dashboard renders from the brief

Suggestion reactions (👍/👎) are stored per-day and feed into the next run.

</details>

<details>
<summary><strong>Configuration</strong></summary>

**Settings → Morning OS:**

- **Briefing agent** — run time, carry lookback days, manual trigger
- **AI provider** — provider, model, credentials
- **Vault paths** — all source and output paths
- **Section headings** — heading names in your daily note and goals file
- **How many items to show** — per-field counts
- **AI vs direct mode** — per-field toggle; "direct" = verbatim from vault, "AI" = LLM picks

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
npm install
npm run dev      # watch + copy to vault on save
npm run build    # production build
npm run deploy   # build + copy to vault
```

Set `OBSIDIAN_PLUGIN_DIR` to your vault's plugin folder path.

</details>
