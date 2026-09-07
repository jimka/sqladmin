---
depends-on: [sql-editor-live-linting]
touches-shared: [frontend/src/dock/definitionEditor.ts]
---

# Definition Editor Dirty-State Adoption — Implementation Plan

## Overview

[`frontend/src/dock/definitionEditor.ts`](frontend/src/dock/definitionEditor.ts)'s `DefinitionEditor` class hand-rolls its own dirty tracking for the shared SQL editor behind `DefinitionPanel` and `FunctionDefinitionPanel`: a private `_baseline` field holding the last-saved text, and a `syncDirty()` method that compares the editor's current text against it on every keystroke. The symlinked `@jimka/typescript-ui` checkout this app's frontend builds against — now tagged and published as v0.9.0[^symlink-is-0-9-0] — gives `CodeEditor` this exact tracking for free, through the inherited `Component.isDirty()` and a new `markClean()` method. This plan deletes `_baseline` and its string comparison, and reads `CodeEditor.isDirty()` directly.

This plan lands on top of [plans/sql-editor-live-linting.md](plans/sql-editor-live-linting.md), a sibling plan not yet implemented that gives `DefinitionEditor`'s constructor a fourth parameter (`options: DefinitionEditorOptions = {}`) and changes its `CodeEditor` construction line to pass `lint: options.lint ?? false`. This plan's steps are written against that post-lint shape and touch a different concern of the same file — the dirty-tracking fields and methods, not the options bag or the `CodeEditor` construction call, which stay exactly as that plan leaves them.

Nothing about `DefinitionPanel`, `FunctionDefinitionPanel`, or the controller that calls them changes. Both panels already call `DefinitionEditor.reload(definition)` and read only `editor`/`toolbar` off it; neither reads `_baseline` or any other dirty-related field, so this plan's edits are confined to `definitionEditor.ts`.

---

## Architecture Decisions

### `DefinitionEditor` reads `CodeEditor.isDirty()` instead of comparing strings itself

`_baseline: string` and the `getValue() !== this._baseline` check in `syncDirty()` are deleted. `CodeEditor` already tracks the same fact internally, comparing its live document against a private clean point on every edit and exposing the result through `isDirty()`.[^cleanvalue-semantics] `_baseline` and that internal clean point were always kept in lockstep by construction — both were set from the same `definition` string in the constructor and reassigned from the same `definition` argument in `reload()` — so reading `isDirty()` instead of the string comparison changes no observable outcome.

This is the app's first use of `Component.isDirty()` / `onDirtyChange()` / `markClean()`; no other sqladmin file reads them yet.[^no-prior-adoption] The pattern this plan does follow is the app's established one for adopting a new library primitive against the symlinked build: decide per call site, verify under the symlink, leave the version pin alone. [plans/implemented/align-with-library-post-0.4.1.md](plans/implemented/align-with-library-post-0.4.1.md) set this precedent for `CodeEditor.autoHeightMaxRows`, and the sibling lint plan repeats it for `CodeEditor.lint`.

`SequenceInfoPanel.ts` has its own field named `_baseline` and its own `isSequenceFormDirty` comparison, guarding a multi-field form rather than a single `CodeEditor`. That mechanism is unrelated and untouched — see Non-Goals.

### Subscribe to `onDirtyChange()`, not `"change"`

The constructor's `this.editor.on("change", () => this.syncDirty())` becomes `this.editor.onDirtyChange(() => this.syncDirty())`. `onDirtyChange` fires only when `isDirty()`'s return value actually flips, never on a keystroke that leaves the document just as dirty as it already was.[^ondirtychange-fires-on-flip] `"change"` fires on every keystroke unconditionally, which is what forced the old `syncDirty()` to redo its string comparison on every keystroke too. The new wiring runs `syncDirty()` only on a real dirty/clean transition.

### `reload()` sets the value before marking clean

`reload(definition)`'s body becomes, in this order:

```ts
this.editor.setValue(definition);
this.editor.markClean();
this.syncDirty();
```

`markClean()` takes no argument — it snapshots `this.editor.getValue()` at the moment it runs.[^markclean-no-arg] Calling it before `setValue()` would snapshot the *old* text as the new clean point, leaving the freshly loaded definition reported dirty until the next keystroke. `setValue()` must run first.

The trailing `syncDirty()` call is kept even though `markClean()`'s own `setDirty(false)` already triggers `onDirtyChange` (and so `syncDirty()`) whenever the editor was dirty beforehand. It is a no-cost safety net for the one case where `setValue()` alone would not: before the editor's first layout, `setValue()` only caches the text and never dispatches a change, so nothing flips the dirty flag on its own.[^premount-edge-case] `reload()` is only ever called well after its tab is mounted in practice, but the explicit call matches the belt-and-suspenders style the original code already used for the same reason.

### `syncDirty()` collapses to one expression

```ts
private syncDirty(): void {
    this._saveButton.setEnabled(!this._saving && this.editor.isDirty());
}
```

`_saving` keeps its existing job unchanged: while a save is in flight, Save stays disabled regardless of `isDirty()`, so neither a double-click nor a mid-save edit can fire a second overlapping save. The old `if (this._saving) { return; }` early return is no longer needed — the whole enabled state is now one boolean expression, so there is nothing left to guard by returning early from.

---

## Internal Structure

Current shape (the parts this plan touches; unrelated constructor lines — `handleSave`, the toolbar, the `CodeEditor` construction line — are omitted as `// ...` and are left exactly as the sibling lint plan leaves them):

```ts
private _baseline: string;
private _saving = false;

constructor(definition, onSave, onRefresh, options = {}) {
    this.editor = new CodeEditor(definition, { language: "sql", lint: options.lint ?? false });
    this._baseline = definition;
    // ... handleSave, toolbar ...
    this.editor.on("change", () => this.syncDirty());
    this.syncDirty();
}

reload(definition: string): void {
    this._baseline = definition;
    this.editor.setValue(definition);
    this.syncDirty();
}

private syncDirty(): void {
    if (this._saving) {
        return;
    }
    this._saveButton.setEnabled(this.editor.getValue() !== this._baseline);
}
```

Target shape:

```ts
private _saving = false;   // _baseline deleted — CodeEditor tracks this itself

constructor(definition, onSave, onRefresh, options = {}) {
    this.editor = new CodeEditor(definition, { language: "sql", lint: options.lint ?? false });
    // ... handleSave, toolbar (unchanged) ...
    this.editor.onDirtyChange(() => this.syncDirty());
    this.syncDirty();
}

reload(definition: string): void {
    this.editor.setValue(definition);
    this.editor.markClean();
    this.syncDirty();
}

private syncDirty(): void {
    this._saveButton.setEnabled(!this._saving && this.editor.isDirty());
}
```

---

## Ordered Implementation Steps

Line numbers in `definitionEditor.ts` shift once the sibling lint plan lands (its Step 1 inserts an options interface above the class). Locate every target below by the exact text quoted, via `grep -n` if needed, rather than by an assumed line number.

1. **Confirm the precondition.** Run `grep -n "options: DefinitionEditorOptions = {}" frontend/src/dock/definitionEditor.ts`. It must find the constructor signature — this plan's steps assume `plans/sql-editor-live-linting.md` has already landed (`depends-on`). If it finds nothing, implement that plan first.
2. **Delete the `_baseline` field.** Remove `private _baseline: string;` and its doc comment (`/** The last-saved text; Save enables only when the editor differs from it. */`) from the class body.
3. **Delete the baseline seed in the constructor.** Remove the line `this._baseline = definition;` that follows the `this.editor = new CodeEditor(...)` line.
4. **Switch the dirty-change listener.** Change `this.editor.on("change", () => this.syncDirty());` to `this.editor.onDirtyChange(() => this.syncDirty());`. Leave the following `this.syncDirty();` call (the initial seed) as is.
5. **Rewrite `reload()`.** Replace:
   ```ts
   reload(definition: string): void {
       this._baseline = definition;
       this.editor.setValue(definition);
       this.syncDirty();
   }
   ```
   with:
   ```ts
   reload(definition: string): void {
       this.editor.setValue(definition);
       this.editor.markClean();
       this.syncDirty();
   }
   ```
   Keep `setValue()` before `markClean()` — see Architecture Decisions.
6. **Rewrite `syncDirty()`.** Replace its body (the `if (this._saving) { return; }` guard plus the string-comparison `setEnabled` call) with the single line `this._saveButton.setEnabled(!this._saving && this.editor.isDirty());`.
7. **Update `syncDirty()`'s doc comment.** It currently says it compares against "the last-saved baseline" and is "wired to the editor's `\"change\"` event". Rewrite it to say it reads `CodeEditor.isDirty()` and is wired to `onDirtyChange()`.
8. **Update the constructor's `definition` parameter doc.** It currently reads "the initial definition text (the editor's seed and the starting Save baseline — Save begins disabled)". Reword to drop "the starting Save baseline", since there is no longer an app-side baseline to name — e.g. "the initial definition text (the editor's seed text; Save begins disabled since a freshly constructed `CodeEditor` reports itself clean)".
9. **Update the file's top-of-file comment.** It currently says the class owns "the dirty-gating that keeps Save disabled until the text actually differs from the last-saved baseline". Reword to say the dirty flag itself comes from `CodeEditor.isDirty()`, and that the two remaining fiddly parts this class still owns are `_saving`'s gating during an in-flight save and `reload()`'s `setValue()`-then-`markClean()` order.
10. **Checkpoints.**
    - `grep -rn "_baseline" frontend/src/dock/definitionEditor.ts` → zero matches.
    - `grep -n '"change"' frontend/src/dock/definitionEditor.ts` → zero matches (confirms the listener switch; `SequenceInfoPanel.ts`'s own unrelated `_baseline` is a separate file and is not touched by this grep).
    - `grep -n "onDirtyChange\|markClean\|this.editor.isDirty()" frontend/src/dock/definitionEditor.ts` → exactly one match each.
    - `cd frontend && npm run typecheck` → clean. A `Property 'isDirty' does not exist on type 'CodeEditor'` (or `'markClean'` / `'onDirtyChange'`) error here means the symlink override is missing, not a plan error — see Potential Challenges.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | [frontend/src/dock/definitionEditor.ts](frontend/src/dock/definitionEditor.ts) |

---

## Expected Behaviour

Every row below is manual-verify only, for the same reason the sibling lint plan gives for this file: `CodeEditor` needs a mounted, real `EditorView` for a document change to run its update listener and flip the dirty flag,[^offline-limitation] and no test file in this app constructs a `DefinitionEditor`, `DefinitionPanel`, or `FunctionDefinitionPanel` today (`grep -rln "DefinitionEditor" frontend/tests` finds nothing). This is the same coverage gap the class had before this plan — not something this plan introduces or could unilaterally fix, since `CodeEditor` isn't injected and so can't be swapped for a test double.

The rule the Save button follows, and the cases that pin it:

| State / action | Save button | Why |
| --- | --- | --- |
| Fresh construction, no edits yet | disabled | a freshly constructed `CodeEditor` is clean; `isDirty()` is `false` |
| User types into the editor | enabled | `isDirty()` flips to `true`; `onDirtyChange` fires; `syncDirty()` enables it |
| User undoes back to the exact last-clean text | disabled | `isDirty()` flips back to `false` on its own — no app code re-checks anything |
| User edits while a save is in flight | stays disabled | `syncDirty()`'s `!this._saving` term is `false`, regardless of `isDirty()` |
| Save succeeds; the owning panel calls `reload(newText)` | disabled | `markClean()` re-baselines to `newText`; `isDirty()` is `false` |
| Save fails (`onSave` rejects); no `reload()` follows | enabled | `_saving` returns to `false` in `handleSave`'s `finally`; the unsaved edit still makes `isDirty()` `true` |
| User clicks Refresh; the owning panel calls `reload(freshText)` | disabled | same mechanism as the successful-save row — any unsaved edit is discarded with no confirmation, matching today's documented behaviour |

None of these rows differ from the class's behaviour before this plan — the point of this plan is that the same outcomes now come from `CodeEditor`'s own tracking instead of `_baseline`. The "undo back to clean" row is not a new capability either: the old string comparison already cleared on an exact-text undo, since it re-ran on every keystroke against a fixed baseline string.

`FunctionDefinitionPanel`'s SQL editor stays `lint: false` per the sibling plan; dirty tracking is independent of linting in `CodeEditor`'s implementation (`onDocChange` sets the dirty flag and `refreshLint()` reconfigures the linter compartment — two separate methods, neither called by the other), so this plan changes nothing about `FunctionDefinitionPanel`'s behaviour beyond what the table above already states for both panels equally.

---

## Verification

1. `cd frontend && npm run typecheck` — clean, against the symlinked v0.9.0 build.
2. `cd frontend && npm test` — stays green; nothing in the suite constructs `DefinitionEditor`.
3. The checkpoints listed in Step 10.
4. `ls -ld frontend/node_modules/@jimka/typescript-ui` shows a **symlink** before any manual run. Otherwise the app runs the published 0.8.0, which has none of `isDirty()` / `markClean()` / `onDirtyChange()` on `CodeEditor`, and step 1's typecheck would already have failed.
5. Manual verification of every row in the Expected Behaviour table, using the `verify` skill. Screens: a view's definition tab (`DefinitionPanel`) and a function's definition tab (`FunctionDefinitionPanel`). The failed-save row is covered by reading `handleSave`'s unchanged `finally` clause if a real save failure is inconvenient to trigger live.

---

## Potential Challenges

- **Typecheck fails with `Property 'isDirty' does not exist on type 'CodeEditor'`** (or `'markClean'` / `'onDirtyChange'`). The symlink override is missing or was clobbered by an `npm install`. Re-link per the `verify` skill. The checkout's `dist/lib` is already built past this API,[^symlink-is-0-9-0] so `npm run build:lib` should not be needed — run it anyway if the error persists after re-linking.
- **The release image build (`npm ci` in the Dockerfile's frontend stage) fails on this branch.** Same root cause as the sibling lint plan's own note: `frontend/package.json`'s `^0.8.0` pin excludes the now-published 0.9.0 that carries this API. Don't cut a release until the pin is bumped, per [release-steps.md](release-steps.md) — not a new caveat, and not part of this plan.

---

## Critical Files

- [frontend/src/dock/definitionEditor.ts](frontend/src/dock/definitionEditor.ts) — the file this plan edits.
- [plans/sql-editor-live-linting.md](plans/sql-editor-live-linting.md) — the dependency; establishes the four-parameter constructor and options-bag `CodeEditor` construction this plan's steps are written against.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts` — `_cleanValue` (line 483) and its constructor seed (line 532), `setValue` (597-607), `markClean` (609-629), `onDocChange` (1270-1286).
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/core/Component.ts` — the dirty-tracking private fields (`_ownDirty`, `_dirtyDescendantCount`, `_dirtyListeners`, `_handleChildDirtyChange`; 508-523) and `isDirty` / `onDirtyChange` / `offDirtyChange` / `setDirty` / `_fireDirtyChangeIfFlipped` (2331-2404).
- [plans/implemented/align-with-library-post-0.4.1.md](plans/implemented/align-with-library-post-0.4.1.md) — the precedent this plan's overall approach follows: adopt a new library primitive against the symlinked build, decide per call site, leave the version pin alone.
- [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md) — the symlink override and login-host rules for the manual verification pass.

---

## Non-Goals

- **Converting `SequenceInfoPanel.ts`'s own `_baseline` / `isSequenceFormDirty` dirty check** to `Component.isDirty()`. It guards a multi-field form, not a single `CodeEditor`, and is a differently-shaped problem this plan was not asked to touch.
- **Bumping `frontend/package.json`'s `@jimka/typescript-ui` pin** from `^0.8.0` to reach the now-published 0.9.0. A release step, per [release-steps.md](release-steps.md) — verification for this plan runs under the symlink, same as the sibling lint plan.
- **Designing or wiring the app-wide "unsaved changes" browser/tab-close guard** raised while scoping this plan. It is a separate, not-yet-drafted plan. Nothing here needs to anticipate it: `CodeEditor.isDirty()` is a property of the editor instance itself, independent of how this class's own Save-button logic reads it.
- **A `LIBRARY_NOTES.md` entry.** Unlike the sibling lint plan's generic-SQL grammar gap, nothing about `isDirty()` / `markClean()` / `onDirtyChange()` is a library defect or friction to log — the API behaves exactly as documented.
- **A `CHANGELOG.md` entry.** This is an internal refactor with no observable behaviour change for a user (see the Expected Behaviour table); it does not belong in a user-facing release note.

---

## Notes

[^symlink-is-0-9-0]: Verified 2026-09-07, not assumed. `frontend/node_modules/@jimka/typescript-ui` is a symlink to `/home/jika/typescript/typescript-ui/packages/lib` (`readlink -f` confirms it). That checkout's `git describe --tags` resolves to `v0.9.0`, and `npm view @jimka/typescript-ui version` returns `0.9.0` — the library has been tagged and published since this plan was scoped. `frontend/package.json` still pins `"@jimka/typescript-ui": "^0.8.0"`, and npm's caret range for a pre-1.0 package treats the minor version as the compatibility boundary, so `^0.8.0` resolves to `>=0.8.0 <0.9.0` and excludes 0.9.0. A fresh `npm ci` — CI, or the Dockerfile's frontend stage — still resolves to the old 0.8.0 build, which has no `isDirty()` / `markClean()` / `onDirtyChange()` on `CodeEditor` at all. This plan's edits compile and run only under the symlink override, the same situation the sibling lint plan describes for its own dependency — except the local checkout is now a tagged, published release rather than a moving unreleased target. The symlinked build's own type declarations confirm the API is present and current: `dist/lib/types/component/editor/CodeEditor.d.ts` declares `markClean(): this;` and `dist/lib/types/core/Component.d.ts` declares `isDirty(): boolean;`, `onDirtyChange(listener): this;`, and `offDirtyChange(listener): this;` — matching the source exactly, and `dist/lib`'s files carry a newer modification time than every source file they were built from, so no rebuild is pending.

[^cleanvalue-semantics]: Read from `CodeEditor.ts`, not the changelog. `_cleanValue` (`CodeEditor.ts:483`) starts as `this.getValue()` in the constructor (`:532`) — the same `definition` string `DefinitionEditor` was also copying into `_baseline`. Every dispatched document change runs `onDocChange` (`:1279-1286`), which sets `this._options.value = value`, then calls the inherited `setDirty(value !== this._cleanValue)` before emitting `"change"`. `setDirty` (`Component.ts:2380-2387`) is a no-op if the own-dirty flag isn't actually changing, and `isDirty()` (`Component.ts:2340-2342`) returns `this._ownDirty || this._dirtyDescendantCount > 0` — `CodeEditor` has no dirty-reporting descendants, so this is just `_ownDirty` in practice.

[^no-prior-adoption]: Checked via `grep -rn "isDirty\|markClean\|onDirtyChange\|offDirtyChange" frontend/src`. The only hit outside `definitionEditor.ts` is `frontend/src/dock/tableWriteRules.ts`'s `RecordLike.isDirty()`, which types a `ModelRecord`'s data-layer dirty flag (unsynced store changes bound to an `AjaxStore`) — a pre-existing, unrelated API, not `Component.isDirty()`.

[^ondirtychange-fires-on-flip]: `Component.ts:2352-2356` registers the listener; `:2380-2387`'s `setDirty` and `:2399-2404`'s `_fireDirtyChangeIfFlipped` both gate the fire on `after !== before`. A keystroke that leaves the document just as dirty as it already was (e.g. typing a second character after the first already made it dirty) recomputes the same `true` and fires nothing.

[^markclean-no-arg]: `CodeEditor.ts:624-629`: `markClean(): this { this._cleanValue = this.getValue(); this.setDirty(false); return this; }`. No parameter — it reads whatever `getValue()` currently returns.

[^premount-edge-case]: `setValue()` (`CodeEditor.ts:597-607`) only dispatches a document-change transaction — the thing that runs `onDocChange` and updates the dirty flag — once a view is mounted (`this._view` set, after the editor's first layout via `onFirstLayout(() => this.mount())`). Before that, `setValue()` only caches `_options.value`. `reload()` is called by the owning panel's controller well after the tab is shown and mounted, so this path is not exercised in practice today.

[^offline-limitation]: The app's vitest harness runs with no DOM-backed `EditorView` (`vitest.config.ts`'s node environment), so `CodeEditor` never mounts under it and its update listener — the thing that calls `onDocChange` and flips the dirty flag in response to a document change — never runs. `getValue()` / `setValue()` still work offline (they fall back to the cached `_options.value`), but a programmatic `setValue()` call made without a mounted view does not, by itself, update `isDirty()`. This mirrors the sibling lint plan's own statement that "`CodeEditor` mounts nothing under the framework's offline test seam", and does not change the testability of this file — it had no test coverage before this plan either.
