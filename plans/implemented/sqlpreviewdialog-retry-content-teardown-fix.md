---
depends-on: [align-with-library-post-0.4.1]
touches-shared:
  - frontend/src/dock/SqlPreviewDialog.ts
  - LIBRARY_NOTES.md
---

# SqlPreviewDialog Retry-Content Teardown Fix — Implementation Plan

## Overview

Every DDL phase's Execute-failure retry is broken. [`showExecuteRetryLoop`](frontend/src/dock/SqlPreviewDialog.ts#L185)'s catch block calls `dialog.getContentComponent().removeComponent(content)` ([SqlPreviewDialog.ts:213](frontend/src/dock/SqlPreviewDialog.ts#L213)) expecting to detach the dialog's persistent content (the phase's form, the "Regenerate SQL" button, and the SQL preview editor) so it can re-wrap it in a fresh `Dialog` for the retry. That content is already destroyed by the time this line runs: `Dialog.hide()`'s `finalize()` calls `this.destructor()` ([`Dialog.ts:1124`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L1124)) *before* resolving the promise `showExecuteRetryLoop` is `await`ing on `dialog.show()`, and `Component.destructor()`'s recursion ([`Component.ts:785`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L785)) has by then already destroyed every registered child, including `content`. The result is a crash — an unhandled rejection deep in `Component`'s attribute plumbing — that drops the dialog entirely instead of letting the user fix and retry, on every DDL phase in the app. Full repro, console trace, and root-cause citations are in [`LIBRARY_NOTES.md`'s `SqlPreviewDialog` entry](LIBRARY_NOTES.md#L11) (lines 11-68); this plan does not re-derive that finding, only verifies its line citations and designs the fix.

This is `Dialog` working as designed, not a library defect — the same owned-teardown contract `Tab.closeEntry` already carries for Dock tabs (`plans/implemented/adopt-dock-owned-teardown.md`). The fix is entirely inside [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts): a small `Dialog` subclass that rescues `content` from the base class's owned teardown by detaching it one step earlier, before the teardown recursion reaches it, instead of one step too late as the current code does. No caller of `openSqlPreviewDialog` — 27 call sites across 7 files — changes.

---

## Architecture Decisions

### Detach `content` inside a `Dialog` subclass's `destructor()` override, not after `show()` resolves

`RetainedContentDialog` (new, module-private) extends `Dialog` and overrides `protected destructor(): void` to call `this.getContentComponent().removeComponent(this._content)` before `super.destructor()` runs. `buildDialog` constructs this subclass instead of a bare `Dialog`. This runs the exact detach the current code already attempts, just early enough to matter — `Component.destructor()`'s own doc comment states the mechanism this relies on directly: `removeComponent` never calls `destructor()`, "so recursion here only reaches descendants still present in `_components` at close time."[^precedent]

### `content` is reused, never rebuilt — rebuilding it is not available as an option

`SqlPreviewDialogOptions.form` ([SqlPreviewDialog.ts:68](frontend/src/dock/SqlPreviewDialog.ts#L68)) is a single caller-supplied `Component` instance (e.g. `new CreateTableForm(ref.schema!)` in [`SqlAdminController.createTable`](frontend/src/SqlAdminController.ts#L728)), and `options.generateSql` is a closure permanently bound to that exact instance (`form.readSpec()`). There is no factory in the options contract that could produce a second `CreateTableForm` carrying the user's edits, so "rebuild fresh content on each retry" is not a smaller-vs-larger alternative here — it is unavailable without a contract change to `SqlPreviewDialogOptions` that would ripple into all 7 files that call it.[^rebuild-rejected]

### Every dismissal detaches `content` the same way; `runSqlPreviewDialog` disposes it exactly once, when the loop concludes

Whether a given `hide()` is going to need a retry is not knowable until after it has already started: the Execute button calls `hide('confirm')` synchronously on click, and only afterward does `execute()` run and possibly fail. So `RetainedContentDialog.destructor()` detaches `content` unconditionally, on every dismissal, not only failing ones — a Cancel, an Escape, a backdrop click, or a successful Execute all go through the identical detach. Detaching content from Dialog's owned teardown on every exit means nothing disposes it automatically anymore, on any path — so `runSqlPreviewDialog`'s existing `finally` block, which already runs on every path out of the loop, is where `content` is now disposed, instead of the narrower `editor.dispose()` it currently does. Disposing `content` cascades to `editor`, the "Regenerate SQL" button, and `options.form` in one call, since all three are still its registered children at that point.

| Exit path | What triggers `hide()` | Does `content` survive that `hide()`? | Disposed when |
|---|---|---|---|
| Cancel / Escape / backdrop / title-bar close | a dismiss gesture → `hide('close')` | yes — detached by `RetainedContentDialog.destructor()` | `runSqlPreviewDialog`'s `finally`, once the loop returns |
| Execute → succeeds | Execute button → `hide('confirm')`, then `execute()` resolves | yes — same detach, then `onSuccess()` runs and the loop returns | same `finally` |
| Execute → fails | Execute button → `hide('confirm')`, then `execute()` rejects | yes — same detach; `content` is re-wrapped in a fresh `RetainedContentDialog` | not yet — the loop continues |

### Rebuilding fresh content on retry (`LoginDialog`'s pattern) does not transfer to this dialog

`showLoginDialog` ([LoginDialog.ts:199](frontend/src/shell/LoginDialog.ts#L199)) is the retry loop `SqlPreviewDialog`'s own header comment already cites as its model, and it does not hit this bug: it constructs a brand-new `LoginDialog` (and a brand-new `LoginForm`) on every iteration, reseeded from a plain `LoginSeed` data object (`{ details }`) rather than reusing a live `Component`. That works there because `LoginForm`'s entire state round-trips through `getDetails()`/`setDetails()`. It does not work for `SqlPreviewDialog`, whose `form` is an arbitrary caller-supplied `Component` with no such generic serialize/reseed contract — see the previous decision.

---

## Internal Structure

`RetainedContentDialog` is declared directly above `buildDialog` (its only construction site), the same placement `QueryPanelContent` uses above `QueryPanel` in [`QueryPanel.ts:148`](frontend/src/dock/QueryPanel.ts#L148):

```typescript
/**
 * A Dialog that keeps `content` alive across the base class's owned-teardown
 * recursion, by detaching it in `destructor()` before `super.destructor()`
 * runs. Every dialog `buildDialog` constructs is one of these, so
 * `showExecuteRetryLoop` can pull `content` out of a spent dialog and
 * re-wrap it in a fresh one on a failed-execute retry, and the form's and
 * editor's own state survive. `content` is never disposed here — the loop
 * that owns it disposes it exactly once, when it actually concludes.
 */
class RetainedContentDialog extends Dialog {
    private readonly _content: Component;

    /**
     * @param content - The persistent form + editor content this dialog
     *     wraps; detached, not disposed, on teardown. Must be the same
     *     component passed as `config.contentComponent`.
     * @param config - The Dialog configuration.
     */
    constructor(content: Component, config: DialogConfig) {
        super(config);

        this._content = content;
    }

    protected destructor(): void {
        this.getContentComponent().removeComponent(this._content);

        super.destructor();
    }
}
```

---

## Ordered Implementation Steps

1. **`frontend/src/dock/SqlPreviewDialog.ts` — add the `DialogConfig` type import.** Line 32 currently reads `import type { DialogButtonConfig } from "@jimka/typescript-ui/overlay";`. Add `DialogConfig` to it: `import type { DialogButtonConfig, DialogConfig } from "@jimka/typescript-ui/overlay";`.

2. **Add the `RetainedContentDialog` class** from `## Internal Structure`, placed after `showExecuteRetryLoop` ends (line 218) and before `buildDialog`'s doc comment (line 220).

3. **Rewrite `buildDialog`** ([SqlPreviewDialog.ts:226-233](frontend/src/dock/SqlPreviewDialog.ts#L226)) to construct the subclass:

   ```typescript
   function buildDialog(content: Component, options: SqlPreviewDialogOptions): Dialog {
       return new RetainedContentDialog(content, {
           title:            options.title,
           contentComponent: content,
           buttons:          [CANCEL_BUTTON, EXECUTE_BUTTON],
           width:            options.width ?? DEFAULT_DIALOG_WIDTH,
       });
   }
   ```

   The return type stays `Dialog` — nothing outside this function needs the narrower type.

4. **Delete the now-redundant detach line in `showExecuteRetryLoop`'s catch block** ([SqlPreviewDialog.ts:207-216](frontend/src/dock/SqlPreviewDialog.ts#L207)). Remove `dialog.getContentComponent().removeComponent(content);` and its preceding three-line comment; replace with a short comment noting the detach already happened inside `RetainedContentDialog.destructor()`:

   ```typescript
       } catch (err) {
           reportError(err, options.onError);

           // RetainedContentDialog already detached `content` from the spent
           // dialog during its own teardown (see its class doc) — content
           // survived and is ready to re-wrap in a fresh dialog for the retry.
           dialog = buildDialog(content, options);
           resizer.fit = () => dialog.resizeToContent();
       }
   ```

5. **Update `showExecuteRetryLoop`'s doc comment** ([SqlPreviewDialog.ts:171-184](frontend/src/dock/SqlPreviewDialog.ts#L171)) to describe the new mechanism and the caller-disposes contract:

   ```typescript
   /**
    * Show the dialog and, on Execute, run it; a failed execute reports the
    * error and re-shows a fresh dialog wrapping the same, still-live content
    * — so the form and the SQL text survive the retry. Every dialog built
    * here is a RetainedContentDialog, which detaches `content` from itself
    * before its own teardown can reach it, so `content` is never disposed as
    * a side effect of hide() — the caller disposes it once this resolves.
    * Returns once the user cancels/dismisses or an execute succeeds.
    *
    * @param content - the persistent form + editor content, reused across
    *     retries and disposed by the caller once this resolves.
    * @param editor - the preview editor executed SQL is read from.
    * @param options - carries `execute`, `onSuccess`, and the error reporter.
    * @param resizer - rewired to the current Dialog on every build, so the
    *     editor's "heightchange" listener always re-fits the live dialog even
    *     after a failed-execute retry rebuilds it.
    */
   ```

6. **Change what `runSqlPreviewDialog`'s `finally` block disposes** ([SqlPreviewDialog.ts:147-152](frontend/src/dock/SqlPreviewDialog.ts#L147)): replace `editor.dispose();` with `content.dispose();`, and comment why:

   ```typescript
       try {
           await refreshPreview(editor, options);
           await showExecuteRetryLoop(content, editor, options, resizer);
       } finally {
           // RetainedContentDialog detaches `content` from every dialog it
           // wraps instead of letting the base class's owned teardown dispose
           // it (see showExecuteRetryLoop's doc comment), so this is the one
           // place that disposes it — exactly once, on every exit path.
           // Cascades to editor, the "Regenerate SQL" button, and
           // options.form, since all three are still its registered children.
           content.dispose();
       }
   ```

7. **Rewrite the file's header comment** ([SqlPreviewDialog.ts:1-24](frontend/src/dock/SqlPreviewDialog.ts#L1)). It currently states the now-false assumption LIBRARY_NOTES.md's entry quotes verbatim ("Dialog.hide() destructs the Dialog instance on every dismissal, so a retry cannot re-show the same instance — it detaches the persistent content... from the spent dialog's content container"). Replace the second paragraph (lines 10-18) with a description of the current mechanism: `Dialog` now owns its content's recursive teardown the same way `Dock` owns a tab's (cite `plans/implemented/adopt-dock-owned-teardown.md`); `hide()` destructs the instance before `show()`'s promise resolves; `RetainedContentDialog` rescues `content` from that teardown by detaching it one step earlier, mirroring `QueryPanelContent`'s `destructor()` override in `dock/QueryPanel.ts`; `showExecuteRetryLoop` disposes `content` itself, once, when the loop concludes.

8. **Regression checkpoint.** `grep -n "getContentComponent().removeComponent" frontend/src/dock/SqlPreviewDialog.ts` — expect zero matches (the only prior use was the deleted line). `grep -n "editor.dispose()" frontend/src/dock/SqlPreviewDialog.ts` — expect zero matches. `grep -n "content.dispose()" frontend/src/dock/SqlPreviewDialog.ts` — expect exactly one match, inside `runSqlPreviewDialog`'s `finally`.

9. **`cd frontend && npm run typecheck`** — clean. This is the check that `RetainedContentDialog extends Dialog` type-checks against the installed library build and that no caller of `buildDialog`/`showExecuteRetryLoop` needed a signature change.

10. **`LIBRARY_NOTES.md` — close out the bug entry.** See `## Documentation Impact`.

11. **Manual browser verification.** Run the full `## Verification` manual pass before considering this done — there is no automated coverage for any of it (see `## Expected Behaviour`).

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/SqlPreviewDialog.ts` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

The project's test runner is node-environment with no DOM ([`frontend/vitest.config.ts`](frontend/vitest.config.ts)) and cannot construct a `Dialog`, drive `hide()`'s animation, or exercise `destructor()` overrides — every case below is manual-verify only, following `FilterDialog.ts`'s own precedent comment for the same limitation. Drive the exact repro `LIBRARY_NOTES.md`'s entry used: "Create table" on schema `wide`, name it `cols_10` (already exists).

- **EB1 — a failed Execute re-shows the dialog instead of dropping it.** Execute on the conflicting name: the `relation "cols_10" already exists"` notification appears, the dialog re-shows with the same table name and column rows still filled in, and there is no console error (in particular, no unhandled rejection tracing through `Component.ts`'s attribute plumbing — the exact crash `LIBRARY_NOTES.md`'s entry traces to the old `SqlPreviewDialog.ts:213`).
- **EB2 — a hand-edited SQL preview survives the retry unchanged.** Before executing, edit the generated SQL directly in the preview editor (not via "Regenerate SQL") — e.g. add a trailing comment. Execute against the conflicting name, let it fail, and confirm the editor still shows the hand-edited text verbatim, not a freshly regenerated statement.
- **EB3 — state survives more than one retry.** Fail Execute twice in a row (leave the name conflicting both times) and confirm the form values and SQL text are still intact after the second failure.
- **EB4 — fixing the conflict and retrying succeeds.** After a failed Execute, change the table name to one that doesn't exist and Execute again: the table is created, `onSuccess` runs (the navigator refreshes), and the dialog closes.
- **EB5 — Cancel/dismiss on the first show still closes cleanly.** Open "Create table", then Cancel (and, separately, Escape and the title-bar close) without ever executing. The dialog closes with no console error.
- **EB6 — Cancel after at least one failed retry also closes cleanly.** Fail Execute once, then Cancel the retried dialog. No console error.
- **EB7 — "Regenerate SQL" is unaffected.** Before any retry, edit the form and click "Regenerate SQL": the preview updates from the current form state, exactly as before this change (this path never touches `hide()`/`destructor()`).
- **EB8 — no new leak from the caller now owning disposal.** Repeat "open Create Table, Cancel" four times and read `[...document.styleSheets].reduce((n, s) => n + s.cssRules.length, 0)` after each close settles (one frame). The count returns to the same baseline every cycle — confirming `content.dispose()` in `runSqlPreviewDialog`'s `finally` disposes `content`, `editor`, and `options.form`, rather than silently leaking them now that `Dialog`'s owned teardown no longer reaches them.
- **EB9 — at least one other DDL phase confirms the fix generalizes.** Repeat EB1 and EB4 against a second phase whose form differs in shape from `CreateTableForm` — e.g. "Drop table" (`ConfirmCascadeForm`) or "Rename schema" (`RenameSchemaForm`) — forcing a retryable failure (e.g. drop a table that has a dependent view without cascade, or rename a schema to a name that already exists).

---

## Verification

| Check | How |
|---|---|
| `cd frontend && npm run typecheck` | clean |
| `cd frontend && npm run test` | green, unaffected — no test imports `SqlPreviewDialog.ts` |
| `cd frontend && npm run build` | succeeds |
| Step 8's three greps | as specified |
| Manual pass **EB1**–**EB9** | run live against the app per `.claude/skills/verify/SKILL.md`; Host is `sqladmin-db` under Compose or `localhost` when the backend runs natively with `SQLADMIN_ALLOWED_HOSTS=localhost:5432` |

**Running the app.** `frontend/node_modules` is not created per worktree — symlink it to the main tree's before running any `npm` script from inside `.worktrees/…`. The main tree's `frontend/node_modules/@jimka/typescript-ui` is already a symlink to the sibling `typescript-ui` checkout (`^0.4.1`, per `align-with-library-post-0.4.1`), so no library build/symlink step is needed for this plan — it makes no library-side change.

---

## Documentation Impact

**`LIBRARY_NOTES.md`** — the entry titled `🐞🔎 SqlPreviewDialog's failed-execute retry crashes — Dialog now owns its content's teardown too` (line 11) flips to `🐞✅` (matching the convention the "Closing a table tab strands ~2288 per-instance stylesheet rules" entry, line 299, already set for a resolved bug entry) and gains a closing paragraph before the section's trailing `---` (line 70): the fix is app-side, in `frontend/src/dock/SqlPreviewDialog.ts` — a `RetainedContentDialog` subclass detaches `content` from the base class's owned teardown one step before the current code tried to (see `plans/sqlpreviewdialog-retry-content-teardown-fix.md`), and `runSqlPreviewDialog` now disposes `content` itself, once, since nothing else does after the detach. Leave the repro, root-cause analysis, and console trace already in the entry in place — they are the evidence for the fix and remain accurate history.

No other documentation covers this — `README.md` and `CHANGELOG.md` describe features, not internal dialog lifecycle, and no public API changes.

**Possible library improvement (not in scope here).** The fix in this plan relies on subclassing `Dialog` and overriding a `protected` method — a real, documented extension point (`Callable.ts`'s "still works... as the right-hand side of `extends`", and `Component.ts`'s own `destructor()` doc comment confirming `removeComponent`-before-teardown is the intended way to rescue a child), but not a lightweight one: it requires knowing that `protected destructor()` exists and is safe to override, and re-deriving this detach-before-teardown technique from source. A public `Dialog` method — e.g. `detachContent(): Component | null`, doing what `RetainedContentDialog.destructor()` does here, callable any time before or during `hide()` — would let a show/retry loop like this one (or `showLoginDialog`'s, structurally the same shape) keep persistent content alive without a subclass. Worth a `LIBRARY_NOTES.md` papercut entry if this pattern recurs elsewhere; not raised as its own entry here since this plan's scope is the app-side fix only, per the bug entry's own framing.

---

## Potential Challenges

- **`content` is now detached on every dismissal, not only retry-triggering ones**, so the app owns disposing it — a missed disposal path leaks it, `options.form`, and `editor` together. Mitigation: `runSqlPreviewDialog`'s `finally` is the single funnel every exit from `showExecuteRetryLoop` passes through (both its early `return` on a non-confirm result and its `return` after `onSuccess`), so there is exactly one disposal site, not one per return statement.
- **Subclassing `Dialog` is a new pattern for this app** — no existing call site does `extends Dialog` (`FilterDialog`, `LoginDialog`, `aboutDialog`, `shortcutsDialog` all construct it directly). Mitigation: the library explicitly documents `extends` support for its `callable()`-wrapped exports (`Callable.ts`), the built `.d.ts` confirms `Dialog`'s `protected destructor(): void` is present on the exported type, and `ActivityBar`/`TableWorkPanel` already prove the same `extends`-a-callable-base technique works in this app for `Container` (`COMPONENT_CONVENTIONS.md` section (a)).
- **`removeComponent` runs on a Dialog whose own element was already removed from the document** (`hide()`'s `finalize()` calls `this.removeElement()` before `this.destructor()`). Confirmed safe by reading the exact sequence in `Dialog.ts:1119-1137`: DOM operations on an already-detached (but still intact) subtree are ordinary, and this is the same operation the original, pre-bug code already performed successfully — only the timing changes here, not the operation.
- **A future third exit path added to `showExecuteRetryLoop`** would need to keep going through the same `finally`, not add its own disposal. Nothing in this plan's diff makes that likely, but it's worth a comment at the disposal site (already included in step 6) pointing back at this contract.

---

## Critical Files

- [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts) — the file this plan changes in full.
- [`LIBRARY_NOTES.md`](LIBRARY_NOTES.md) (lines 11-68) — the bug entry this plan's Overview verifies rather than re-derives.
- [`../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts) — `hide()` (1115), `finalize` (1119-1137), `destructor()` (1173-1205), `getContentComponent()` (1212). Read the exact order inside `finalize` before touching step 4/6/7.
- [`../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts) — `dispose()`/`destructor()` (730-788), whose comment on `removeComponent` never calling `destructor()` is the library-level guarantee this fix relies on.
- [`../../typescript-ui/packages/lib/src/typescript/lib/core/Callable.ts`](../../typescript-ui/packages/lib/src/typescript/lib/core/Callable.ts) — confirms `extends` is supported for `callable()`-wrapped exports like `Dialog`.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) (lines 148-169) — `QueryPanelContent`, the precedent this plan's `RetainedContentDialog` mirrors: a small subclass with a `protected destructor()` override for the one part of a subtree the ordinary recursion doesn't (there) or shouldn't (here) reach.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — section (a) for the `extends`-a-callable-base technique; section (f) for the composition-wrapper `destructor()`-override pattern `QueryPanelContent` established.
- [`frontend/src/shell/LoginDialog.ts`](frontend/src/shell/LoginDialog.ts) (lines 199-222) — `showLoginDialog`'s rebuild-fresh retry loop, the alternative this plan's Architecture Decisions rejects and explains why.
- [`plans/implemented/adopt-dock-owned-teardown.md`](plans/implemented/adopt-dock-owned-teardown.md) — the analogous fix for `Dock`/`Tab.closeEntry`'s owned teardown; its "Composition wrappers lose `dispose`; the one part recursion cannot reach gets a `destructor()`" decision is the same shape this plan applies to `Dialog`.
- [`plans/implemented/ddl-infrastructure.md`](plans/implemented/ddl-infrastructure.md) (lines 193, 227) — the plan that originally modeled `SqlPreviewDialog`'s retry loop on `showLoginDialog`'s shape, before `Dialog` owned recursive teardown.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) (lines 727-738) — `createTable`, the representative caller EB1-EB4 exercise.

---

## Non-Goals

- **Changing `SqlPreviewDialogOptions` or any of the 7 files that call `openSqlPreviewDialog`** (`SqlAdminController.ts`, `SchemaDdlForms.ts`, `SequenceDdlForms.ts`, `RelationDdlActions.ts`, `ViewFormDialog.ts`, `MaterializedViewFormDialog.ts`, `SequenceInfoPanel.ts` — 27 call sites between them). The fix is contained entirely inside `SqlPreviewDialog.ts`.
- **Any library-side (`typescript-ui` repo) change.** The bug entry frames this as app-side; the possible `Dialog.detachContent()` ergonomic improvement noted under `## Documentation Impact` is an aside, not part of this plan's diff.
- **The unrelated `CodeEditor.autoHeightMaxRows` shrink-to-zero bug** (`LIBRARY_NOTES.md` line 72) — a separate, library-internal defect found in the same verification pass that found this one.
- **Converting `SqlPreviewDialog.ts` from builder-first to class-first** (`COMPONENT_CONVENTIONS.md`'s ongoing migration). Unrelated to this bug; `RetainedContentDialog` itself is already class-first (it has to be, to override `destructor()`), but `openSqlPreviewDialog`/`runSqlPreviewDialog` stay factory functions.
- **Merging or releasing `feature/align-with-library-post-0.4.1`.** This plan depends on it being implemented first but does not perform that merge.

---

## Notes

[^precedent]: `Component.ts`'s `destructor()` doc comment (around line 781) states this as the reason `removeComponent` is safe mid-teardown: "Discard the subtree eagerly — a destroyed container destroys its children too. `removeComponent` never calls destructor (a removed child may be re-parented by a move), so recursion here only reaches descendants still present in `_components` at close time." This is exactly the guarantee `RetainedContentDialog.destructor()` depends on: by removing `content` from `_contentContainer`'s `_components` before calling `super.destructor()`, the recursion that runs inside `super.destructor()` never finds `content` there to destroy. It is the same technique `QueryPanelContent.destructor()` uses in the opposite direction — there, `hideResultPane` has already detached `_resultHost` before teardown, so the override adds an explicit `dispose()` to cover the case the recursion *won't* reach; here, the override adds an explicit `removeComponent()` to *stop* the recursion from reaching a child it otherwise would.

[^rebuild-rejected]: Checked directly, not assumed: every one of the 27 `openSqlPreviewDialog` call sites, across the 7 files that make them (`grep -rln "openSqlPreviewDialog(" frontend/src`), builds `form` as a `const form = new SomeForm(...)` immediately before the call and never references it anywhere else — `generateSql`/other option closures are the only readers, and they always close over that one instance (e.g. `form.readSpec()`, `form.cascade()`). None of these 11 distinct form types behind the 27 call sites (`CreateTableForm`, `ConfirmCascadeForm`, `RenameTableForm`, `CreateSchemaForm`, `RenameSchemaForm`, `CreateSequenceForm`, `DropRelationForm`, `RefreshMatviewForm`, `ViewForm`, `MatviewForm`, a `summaryPanel` built inline in `SequenceInfoPanel`) exposes a generic serialize/reseed pair the way `LoginForm.getDetails()`/`setDetails()` does — most read several typed fields directly (`form.schema()`, `form.name()`, `form.cascade()`) with no single "current state" object. Making rebuild-fresh work would mean adding a `createForm: (seed?: unknown) => Component` factory to `SqlPreviewDialogOptions` and a matching seed shape per phase — a caller-facing contract change this plan's scope (`SqlPreviewDialog.ts` only, per the task) rules out in favor of the option that needs none.
