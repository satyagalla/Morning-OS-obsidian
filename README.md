# Morning OS

> Your Obsidian vault, processed every morning. Morning OS reads your goals, tasks, and rules — and generates a personalized briefing dashboard. Spend your morning focused, not reorganizing.

![Morning OS Dashboard](images/dashboard-dark.png)

---

## The problem

Your vault is full of goals, tasks, and rules you wrote for yourself. But every morning you still open Obsidian and spend ten minutes figuring out where to start — rereading the same files, rediscovering the same priorities.

Morning OS does that reading for you. Open the panel, your day is already laid out.

---

## What you get

![Dashboard Light Mode](images/dashboard-light.png)

| Section | What it does |
|---|---|
| **Identity strip** | Your own rules about who you're trying to be — before you see a single task |
| **Goals bar** | Top short and long-term goals, so the daily grind stays connected to the bigger picture |
| **Red alert tasks** | Urgent tasks from today's note, with a badge showing how many days each has been carried |
| **Regular tasks** | Normal tasks, same carry tracking — chronic avoidance becomes visible |
| **Rules for today** | The AI picks the rules from your rules file most relevant to today's tasks |
| **Suggestions** | A short nudge based on your patterns and what's been sitting undone |
| **Hobby tasks** | Non-work items in their own section so they don't get buried |
| **Wins** | A prompt at the end of the day — what you write here goes straight into your daily note |

The AI picks which of your items to surface. It never rewrites or edits your vault. The only new text it generates is the suggestion.

---

---

## Works on mobile

No terminal, no Python, no desktop-only dependencies. The plugin runs entirely inside Obsidian — tap the sun icon on your phone and your brief is ready.

The only requirement is that your vault syncs across devices.

> **Recommended:** [Remotely Save](https://github.com/remotely-save/remotely-save) with Dropbox. Make sure your sync settings include folders starting with `_` — that's where Morning OS writes its briefs.

![Mobile view](images/mobile.png)

---

## Setup

1. Install from **Settings → Community Plugins → Browse** and search "Morning OS"
2. Enable the plugin
3. Open **Settings → Morning OS** — pick an AI provider and enter your API key
4. Click the sun icon in the sidebar — Morning OS walks you through the rest

**Supported AI providers:** OpenAI · Google Gemini · Groq · AWS Bedrock

> **No API key?** Morning OS still works — it uses your vault data directly without AI curation. Add a key later when you're ready.

---

## FAQ

**Does it read my private notes?**
Only the files you point it to in settings — daily notes, rules, goals, and task files. It never reads your entire vault. All paths are configurable.

**Does my data leave my device?**
Only if you add an AI provider API key. Without one, everything stays local. With one, only the structured content from your configured files is sent — not your full vault.

**Does it work without an API key?**
Yes. Without a key, it renders your tasks, goals, and rules directly from your vault with no AI curation. You can add a key later.

**Does it work on mobile?**
Yes — iOS and Android, with no extra setup beyond vault sync.

**What if my daily note doesn't exist yet?**
Morning OS creates it automatically when you open the panel, carrying forward any incomplete tasks from your most recent note.

**How do I give feedback or report a bug?**
Use the feedback button inside the plugin dashboard — it takes 30 seconds and goes directly to the developer.

---

## Vault structure

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

Heading names are fully configurable.

---

<details>
<summary><strong>How it works under the hood</strong></summary>

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

- **Briefing agent** — carry lookback days, manual trigger
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

---

Built by [@satyagalla](https://github.com/satyagalla). [Share your feedback](https://github.com/satyagalla/Morning-OS-obsidian/issues) or use the feedback button inside the plugin.
