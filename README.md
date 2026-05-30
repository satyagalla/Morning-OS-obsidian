# Morning OS

> An Obsidian plugin that turns your vault into a daily briefing dashboard — no new system to maintain, no manual curation.

Every morning it reads what's already in your vault (tasks, goals, rules, wins), runs it through an LLM to surface what matters *today*, and renders a focused dashboard. You open Obsidian, you see your brief. That's it.

---

## What you get

Most mornings the friction isn't the work — it's deciding where to start. You open your vault and there are three open notes, a task list from yesterday, goals you haven't looked at in a week, and rules you wrote when you were in a better headspace. The brief replaces that cognitive overhead. It reads your vault, applies a single LLM pass to pick what's relevant today, and gives you one screen to look at before you touch anything else.

The AI's role is narrow: for most sections it picks which of your own items to show — nothing is rewritten or paraphrased. The one exception is Suggestions, where it generates new text. Everything else on the screen is verbatim from your vault.

---

**Identity strip** — before you see a single task, you see a short row of pill-shaped chips: your own words about who you're trying to be, pulled from `Emotional Rules.md`. The agent picks the rules most relevant to today's context. No interaction, no expand — just a read before you act. The point is that it runs ahead of your task list, not after it.

---

**Goals bar** — a collapsed bar showing your top short-term and long-term goals as small pills, with a "+N more" count if there are hidden ones. Click it to expand a full two-column panel with everything. Collapsed by default because you don't need to read the full list every day — you need to be reminded that the list exists and what the top items are. It prevents the daily grind from becoming completely disconnected from where you said you wanted to go. Source is `Long-term and Short-term.md`; the agent picks which goals to surface first based on what's in the brief today.

---

**Tasks — Red alert** — checkboxes pulled from the `## Red alert` section of today's daily note, with the heading rendered in red. These are yours; the plugin doesn't decide what's urgent, you do when you write the note. What it adds is a carry badge: if a task has been rolling over from a previous day, a grey "carried Nd" badge shows exactly how many days it's been open. A task that's been carried 4 days looks different from one you wrote this morning. Chronic avoidance becomes visible instead of invisible. Checking a box writes `- [x]` back to your daily note immediately.

---

**Tasks — Regular** — same structure as red alert, same carry badges, same checkbox writeback. The only difference is the source heading (`## Regular`) and the absence of red styling. Having the two lists separate lets you scan urgency at a glance without reading every line.

---

**Rules for today** — a bullet list of items from `Tactical Rules.md`. You maintain one file of behavioural rules ("don't open social media before noon", "reply in batches", "one meeting a day maximum"), and the agent picks the subset most relevant to today's tasks and context. No interaction, no expansion. You read them, then you start working. The selection keeps the list from becoming background noise — if you have 20 rules, you don't want all 20 every day.

---

**Suggestions** — the one section where the LLM writes new text rather than picking from your vault. Each card shows a short paragraph and a source label indicating what vault content prompted it — a pattern across recent days, a habit you haven't touched in a while, something unresolved. Cards have thumbs-up / thumbs-down buttons. Reactions are stored per-day in `_generated/feedback/reactions/YYYY-MM-DD.json` and restored when you reopen the panel, so you can come back to them. A thumbs reaction toggles: clicking it again clears it. The feedback feeds into future runs. If there are no suggestions the section is absent entirely.

---

**Pending tasks** — a collapsed accordion showing the count of items from `Pending Tasks/Technical Tasks.md`. The count is always visible even when collapsed. The point is that the count itself is information — you can see whether your backlog is growing or shrinking without reading the whole list. Expand when you need to scan for something specific. Always present even if empty (the count shows 0), because an empty backlog is also worth knowing.

---

**Hobby tasks** — items from `Pending Tasks/Hobby Tasks.md`, rendered as a simple bullet list. No accordion, no carry badges. Separate from technical tasks so non-work items don't get perpetually buried under professional work. Only renders if the list is non-empty.

---

**Wins today** — a free-form input at the bottom of the dashboard with a prompt that says "Fill this before sleep." When you add a win, it writes directly into your daily note under the configured wins heading — not into the brief JSON, into the actual note. On open it reads the live note, so wins you added directly in the editor appear here too. The daily note is the source of truth, and it persists after the brief is long archived. If the wins heading doesn't exist in your note yet, the plugin creates it.

---

## Setup

**Prerequisites:** An Obsidian vault with daily notes and an API key for one of the supported providers.

1. Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/morning-os/` in your vault
2. Enable in **Settings → Community Plugins**
3. Go to **Settings → Morning OS**, pick a provider, enter your API key
4. Click **Run agent now** — your first brief generates in a few seconds
5. Open the Morning OS view from the left sidebar (sun icon)

After the first run, the agent runs automatically at your configured time each day.

---

## Vault structure

The plugin reads from files you already maintain. All paths are configurable.

```
Essential/
  Daily/YYYY-MM-DD.md              ← daily note (tasks, wins, thoughts)
  State of Mind/
    Tactical Rules.md              ← your rules as a bullet list
    Emotional Rules.md             ← identity affirmations
    Long-term and Short-term.md    ← goals
  Pending Tasks/
    Technical Tasks.md
    Hobby Tasks.md
_generated/                        ← plugin writes here, don't edit manually
  briefs/
  feedback/
```

Daily note format — the plugin reads these headings:

```markdown
## Red alert
- [ ] something urgent

## Regular
- [ ] normal task

## Wins
- shipped the thing
```

Heading names are configurable in settings if yours differ.

---

## AI providers

| Provider | What you need |
|---|---|
| OpenAI | API key |
| Google Gemini | API key |
| Groq | API key |
| AWS Bedrock | Access Key ID + Secret Access Key |

Configure in **Settings → Morning OS → AI provider**. You can switch providers at any time.

---

## How it works

1. **Vault reader** — parses today's daily note and your source files
2. **Carry detector** — fuzzy-matches today's incomplete tasks against previous briefs to track how long each task has been open (looks back up to 7 days across skipped days)
3. **LLM call** — a single structured prompt picks relevant rules, goals, and hobby tasks, and writes a suggestion. Fields with AI mode off are taken verbatim.
4. **Brief written** — saved as JSON to `_generated/briefs/YYYY-MM-DD.json`
5. **Dashboard renders** — the view reads the brief and renders it

The feedback system records what you resolved, what's still open, and your suggestion reactions — giving the next run more context.

---

## Configuration

**Settings → Morning OS** exposes:

- **Briefing agent** — run time, manual trigger, carry lookback days
- **AI provider** — provider, model ID, credentials
- **Vault paths** — all source file and output folder paths
- **Section headings** — heading names in your daily note and goals file
- **How many items to show** — per-field item counts
- **AI vs direct mode** — per-field toggle; "direct" reads verbatim from your vault, "AI" lets the LLM pick

---

## Development

```bash
npm install
npm run dev      # watch + copy to vault on save
npm run build    # production build
npm run deploy   # build + copy to vault
```

Set `OBSIDIAN_PLUGIN_DIR` in your environment to point at your vault's plugin folder. The dev watch mode copies `main.js` and `manifest.json` there on every rebuild.
