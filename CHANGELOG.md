# Changelog

## v0.2.0

When I saw 53 people had downloaded Morning OS, I was genuinely happy. This started as my own daily productivity app — something I built to solve a problem I had every single morning. Knowing that 53 of you found it and decided to give it a shot made me sit down and work through every bug and rough edge I'd been putting off. That's what this release is.

This is still my daily driver, which means I'm in it every day, finding things to improve. Expect refinements to keep coming — this won't go quiet between releases.

If something isn't working, something feels off, or you have an idea, please open an issue or start a discussion on GitHub. Contributions are very welcome too.

---

**Getting started is now easier, bugs that silently broke your data are fixed, and the plugin works properly on mobile.**

### New

**Onboarding flow** — first-time setup now walks you through the plugin inline. It creates your vault folder structure automatically so you don't have to set up files manually before running the agent.

**Daily note scaffolding** — when you open the Morning OS panel and today's note doesn't exist yet, the plugin creates it for you. Incomplete tasks from your most recent note are carried forward automatically. No more manual duplication every morning.

**Agent runs when you open the panel** — the plugin no longer runs on a fixed schedule. The agent runs when you open the Morning OS view, so briefs are never generated on days you're not working (vacations, sick days). Refreshing the panel on a new day also triggers scaffolding and a fresh brief automatically.

**Slide-out action buttons** — Refresh and Run Agent are now a hidden panel on the right edge. A thin accent-colored sliver is always visible; hover or tap to reveal the buttons. Stays fixed while you scroll.

### Fixed

**Carry detection now survives skipped days** — previously, skipping a day reset your entire carry history. Tasks carried for days would appear brand new the next time you ran the agent. The detector now searches back up to 7 days (configurable in settings) to find the most recent brief, preserving the full chain across gaps.

**LLM errors are now surfaced** — previously, if your API call failed the plugin silently fell back to direct mode with no indication anything went wrong. Errors now show a clear notice with the specific failure reason, so you know to check your API key or provider settings.

**Suggestions preserved in no-keys mode** — when no API key is configured, suggestions from the previous brief are now carried forward instead of disappearing on refresh.

**Duplicate reminders deduplicated correctly** — reminders were being duplicated across runs in some cases. They are now deduplicated by text and date.

### Mobile

The plugin has no desktop-only dependencies — it runs fully inside Obsidian on iOS and Android. To use it across devices, your vault needs to be in sync. [Remotely Save](https://github.com/remotely-save/remotely-save) with Dropbox is the recommended setup. Make sure your sync tool is configured to include folders starting with `_` — that's where briefs and feedback are stored.
