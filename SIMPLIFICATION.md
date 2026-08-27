# Simplification roadmap

Morning OS should have a small, dependable core: tasks and wins, with identity and briefing context available when a user wants them. Retaining information in the vault does not require promoting it onto Home every morning.

This document records the product changes discussed during the simplification review. It separates committed work from ideas that still need a product decision.

## Product principles

- Keep storage broad and daily attention narrow.
- Make the default workflow understandable without configuration.
- Put specialist controls behind an explicit Advanced boundary.
- Remove obsolete controls from the interface instead of displaying them as Legacy.
- Preserve compatibility internally only where existing vaults require it.
- Require every Home section to justify its place in the daily workflow.

## Current implementation

- [x] Remove Pending Tasks from Home and from the briefing output.
- [x] Make Goals independently optional on Home.
- [x] Make Rules for Today independently optional on Home.
- [x] Divide settings into General and Advanced. General contains the provider and credentials, basic Areas, basic task behaviour, and Home visibility. Paths, output counts, field-level AI modes, migration details, and specialist controls belong in Advanced.
- [x] Remove obsolete settings from the visible interface. Keep old persisted values only when they are still needed for compatibility or migration.
- [x] Hide custom Area fields and table view until the user enables Advanced area features. Reconsider whether these features should remain after observing real use.
- [x] Keep capture prompts plain. The default placeholder is `Capture a task...`; metadata syntax remains supported for power users without being advertised in the primary interface.

## Next candidates

- [x] Make the Identity Anchor optional on Home.
- [ ] Replace the separate Refresh brief and Run agent actions with one user-facing action: Regenerate briefing. Morning OS should decide internally whether an AI call is required.
- [ ] Make new Areas opt-in. Start with Inbox and Today, then let users create Areas or explicitly choose a few generic examples.
- [ ] Remove creator-specific Areas, labels, and assumptions from defaults.
- [ ] Rewrite onboarding and documentation around one canonical workflow: review what matters, choose today's tasks, act, and record wins.
- [ ] Decide whether Rules for Today remains a collection of selected rules or becomes one synthesized Briefing Insight, then use the corresponding label consistently.

## Content model to refine outside the interface

- [ ] Clean up accumulated rules into Active, Reference, and Retired states.
- [ ] Keep cross-cutting identity statements and principles in a quiet source such as a Personal Manual or Compass rather than forcing them into an arbitrary Area.
- [ ] Keep Area-specific rules with the Area in which they are useful.
- [ ] Treat temporary practices as tasks, reminders, or experiments rather than permanent rules.

## Deferred: customizable AI briefing

Do not include this in the current simplification release. The direction is to make the briefing programmable without making the entire application undefined:

- Keep tasks and wins deterministic.
- Allow an advanced user to define briefing instructions, source Markdown or linked sections, and the desired Markdown output headings.
- Ship one strong default briefing rather than presenting a blank prompt as the primary experience.
- Render generated Markdown as a single briefing surface instead of encoding every possible concept as a permanent application field.
- Keep generation read-only apart from its generated output; it must not autonomously rewrite notes, complete tasks, or reorganize Areas.
- Provide reset-to-default and preserve the last successful briefing after failures.

This direction could eventually replace rigid briefing concepts such as goals, rule categories, suggestions, output counts, and per-section AI switches. It requires a separate design pass before implementation.

## Deliberately rejected for now

- Do not create a generic Context drawer merely to hold every secondary feature. It could become another accumulation point.
- Do not delete retained principles simply because they are no longer shown daily. Archive or demote them instead.
- Do not preserve visible options only because they may be useful someday.
