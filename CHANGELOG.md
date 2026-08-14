# Changelog

## v0.2.0

### Personal

When I saw 53 people had downloaded Morning OS, I was genuinely happy. This started as my own morning app — knowing 53 of you use it made me sit down and fix every rough edge. Thank you.

### Changes

- New onboarding flow — setup is now guided and automatic
- Agent runs when you open the panel, not on a fixed schedule
- Carry detection survives skipped days
- Plugin works properly on mobile
- Reminders and backup system completely overhauled

---
---

## v0.2.2

### Personal

125 people now start their day with Morning OS. That number still surprises me every time I check.

This release is about feel. The plugin works - it has since v0.2.0 - but it felt like a settings panel. I wanted to open it every morning and actually enjoy looking at it. So I rebuilt the whole visual layer from scratch, added a way for you to tell me what's broken or what you want next, and made sure your reminders never silently disappear again.

If you're one of the 125 - thank you. Keep the feedback coming.

Next up: smarter agents, better personalization, and features I haven't told anyone about yet.

### Changes

- Completely overhauled UI — adapts to your Obsidian theme, amber accent for task signals
- Reminders now recover automatically from backup when the file is lost or corrupted
- Plugin re-runs the agent when today's brief is deleted and you reopen the panel
- What's New card — you're reading it right now
- Feedback button — tell me what's broken or what you want built next
- Goals collapse correctly on mobile, action buttons accessible via touch

---
---

## v0.3.0

### Personal

[TODO: write this one yourself — it's the biggest rebuild since v0.2.0 and deserves your own words, not mine.]

### Changes

- **New task system** — tasks now live in a proper registry instead of being scattered across daily notes, with stable IDs so carry-forward and history actually track the same task over time
- **Sub-tasks** — break any task into collapsible sub-tasks, with an optional setting to require them all done before the parent can complete
- **Notes on tasks** — attach freeform notes to any task, with a row indicator so you can see at a glance which ones have them
- **Quick-add and inline editing** — add and edit tasks directly from the row, no modal required
- **`[[link]]` and `#tag` autocomplete** in task text, with live markdown rendering
- **Pillars renamed to Areas** — same concept, clearer name, throughout the UI and settings
- **New views** — Inbox for quick capture, Trash for anything you've deleted, plus a table view and custom filters/sorting per Area
- **One-time vault migration** (Settings → Vault → Migrate) moves your existing rules, goals, technical/hobby tasks, and full wins history into the new structure — safe to re-run, only touches what hasn't already moved
- **Reminders** are now just part of a task instead of a separate file — nothing to lose track of
- Feedback button now goes to a real inbox instead of just sitting there

### Note for people upgrading from 0.2.x

Run the migration from Settings → Vault before you start using Areas/Inbox/Trash — it moves your old daily-note tasks and rules into the new task registry and archives your daily notes. It's idempotent, so it's safe to run more than once if you're not sure it fully finished.