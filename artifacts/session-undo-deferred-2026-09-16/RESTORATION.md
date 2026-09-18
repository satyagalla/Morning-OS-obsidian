# Deferred session Undo

This is a narrowly scoped shelf of the removed, unfinished application-level
Undo feature. It is deliberately outside the runtime source tree and is not a
release-ready change.

`restore.patch` is a forward patch from the post-removal working tree to the
captured implementation. It includes the previously untracked
`src/undo-manager.ts`, along with only the related registry hooks, views,
command, styles, tests, test stub, and plan text.

Before considering restoration, review and update the patch against current
code. In particular, the shelved implementation has unresolved design work:

- History selection/removal can still race queued edits.
- Refresh behavior while a draft is active needs a complete editor-lifecycle
  solution.

Verify applicability without changing files with:

```powershell
git apply --check artifacts/session-undo-deferred-2026-09-16/restore.patch
```

Only after review, restore with:

```powershell
git apply artifacts/session-undo-deferred-2026-09-16/restore.patch
```

Then rerun the full test/typecheck/build suite and perform desktop/mobile
Obsidian verification. Do not interpret the presence of this shelf as approval
to re-enable Undo.
