# Align Two App-Side Workarounds With the Post-0.4.1 Library — Implementation Plan

## Overview

`@jimka/typescript-ui`'s current unreleased batch (past the `v0.4.1` tag, already present in the symlinked `dist/lib` this app builds against[^dist-verified]) adds two small pieces of API that let SQLAdmin delete an app-side workaround in favour of the library's own mechanism. Both changes are small, independent, and touch unrelated files.

**Change 1** — [`frontend/src/navigator/NavigatorTree.ts:195-211`](frontend/src/navigator/NavigatorTree.ts#L195)'s `refresh()` method expands a single-schema database's lone schema using a surrogate-match trick against `Tree.revealByPredicate`. `Tree` gained `expandNode(node)`, which does directly what the trick achieves indirectly. `loadSchemas()` already hands `refresh()` the schema's own `TreeNode`, so no search is needed.

**Change 2** — [`frontend/src/dock/SqlPreviewDialog.ts:105-125`](frontend/src/dock/SqlPreviewDialog.ts#L105)'s DDL preview editor is built with a fixed `preferredSize.height`. `CodeEditor` gained an opt-in `autoHeightMaxRows` option and a `"heightchange"` event, so the editor can grow to fit the generated SQL (up to a row cap) instead of showing a constant-height box that always defers to the dialog's outer scroll for anything longer.

Neither change touches the library, either call site's public surface, or any other `CodeEditor`/`Tree` consumer in the app.

---

## Architecture Decisions

### Change 1 — `NavigatorTree.refresh()` calls `expandNode` on the schema node it already has

Replace the `revealByPredicate(data => data === undefined)` call with `this.expandNode(nodes[0])`. `nodes[0]` — the array `loadSchemas()` just resolved — already **is** the schema's own `TreeNode` (built by `schemaNode()`, [`NavigatorTree.ts:220-227`](frontend/src/navigator/NavigatorTree.ts#L220)), carrying its `data` and lazy `loadChildren`. `expandNode` runs the same commit path as clicking the node's caret — including the lazy-load branch, confirmed by reading `Tree.ts`'s `_onToggle`/`_loadAndExpand`[^expandnode-mechanics] — so it correctly triggers the schema's `loadChildren()` fetch, exactly as `revealByPredicate`'s walk did.

The old comment explained a genuinely non-obvious trick (matching a *different* node to expand its *ancestor*); that reasoning no longer applies, since the new call names its actual target directly. Replace the five-line comment with a shorter one stating what `nodes[0]` is and why no search is needed — matching the file's existing comment density, not the old trick's.

`expandNode` returns `this` (the `Tree`), not a `Promise` — unlike the old `revealByPredicate`, which is `async` and was `void`-prefixed for that reason. The new call takes no `void` prefix.

One observable behaviour changes at an edge case: an **empty** single schema (no tables/views/sequences/functions/types) now expands to an empty parent instead of staying collapsed.[^empty-schema-behavior] This is documented in `_loadAndExpand`'s own remarks as the library's designed behaviour for a zero-length resolved children array, not a defect this plan introduces.

### Change 2 — `autoHeightMaxRows` takes over from `preferredSize` once real content is measured

Add `autoHeightMaxRows: SQL_PREVIEW_MAX_ROWS` to the editor's constructor options. **Do not simply add it alongside the existing `preferredSize` and leave `preferredSize` untouched** — the two fight each other. `Component.getPreferredSize()` returns an explicit `preferredSize` constraint verbatim whenever one is set, ahead of the component's own live size[^preferred-size-precedence]; `autoHeightMaxRows`'s growth, by contrast, is applied by calling `setHeight()` directly on the live component, which does not touch `_options.preferredSize`. So keeping the old fixed `preferredSize.height` would make every later relayout of the dialog (a browser resize, or any `resizeToContent()` call) silently snap the editor back down to the original fixed height, discarding whatever the user had grown it to.

The fix: keep passing an explicit `preferredSize` **only as a one-time bootstrap value**, then call `editor.clearPreferredSize()` the first time real content has been measured. Once cleared, `getPreferredSize()` falls back to the component's own live `getSize()`[^preferred-size-precedence], which `autoHeightMaxRows`'s internal `setHeight()` calls keep accurate from then on — so a later relayout reads the *current* auto-height, not a stale constant. The bootstrap value is still needed: before the editor has ever mounted, `getSize()` reports `NaN` (`Component`'s `_width`/`_height` fields default to `NaN`), and the `Dialog` constructor reads `contentComponent.getPreferredSize()` synchronously, before anything has been laid out — an unset `preferredSize` at that point would poison the dialog's initial height computation with `NaN`.

`width: 0` inside that bootstrap `preferredSize` is unaffected and stays as-is: the surrounding `VBox({ stretching: true, … })` already forces every child's cross-axis width to the container's width, regardless of what `getPreferredSize().width` reports, exactly as it does for the same `width: 0` idiom already used four other places in this codebase (`QueriesView.ts`, `PropertyValuePanel.ts`, `DefinitionPanel.ts`, `StartPage.ts`).

Rename `EDITOR_HEIGHT` to `EDITOR_SEED_HEIGHT` and rewrite its comment: its job changed from "the operative fixed height" to "the placeholder shown for one layout pass before the editor's own measured content takes over." Keep its value (180) — nothing about this change requires a different number for that narrow, barely-visible role.

### Change 2 — the dialog re-fits itself on `"heightchange"`, mirroring `FilterDialog`'s own re-fit hook

`Dialog.resizeToContent()` is not run automatically whenever a descendant's content changes — only once, from `open()`, right after the dialog's first layout (to settle width-dependent content like wrapped `Text`), and again on a viewport resize.[^resize-not-automatic] A later, in-place content change — here, the editor growing after "Regenerate SQL" or a manual edit — needs the app to call it explicitly. [`FilterDialog.ts:101-140`](frontend/src/dock/FilterDialog.ts#L101) already establishes this exact pattern for its own content-driven resizing: a mutable `resizer` object whose `.fit` function is rewired to the current `Dialog` instance, because the reactive content (there, condition rows; here, the editor) is built before any `Dialog` exists.

`SqlPreviewDialog`'s own retry loop ([`showExecuteRetryLoop`](frontend/src/dock/SqlPreviewDialog.ts#L154)) makes this sharper than `FilterDialog`'s case: `dialog` is rebuilt on every failed-execute retry, not just built once. So `resizer.fit` must be rewired every time `dialog` is reassigned, not only at the first build. Add the same `resizer` object, created once in `runSqlPreviewDialog` (before any `Dialog` exists, alongside the editor's own construction), and rewire `resizer.fit = () => dialog.resizeToContent();` both where `showExecuteRetryLoop` first builds `dialog` and where it rebuilds it after a failed execute.

The editor's `"heightchange"` listener does two things: `editor.clearPreferredSize()` (see the decision above) and `resizer.fit()`. Both are safe to run unconditionally on every event — `clearPreferredSize()` is already a no-op once the constraint is cleared, and `resizeToContent()` is a no-op once the dialog's height is already correct.

This editor is **editable** — the DDL preview form's whole point is that the user may hand-edit the generated SQL before executing.[^editable-distinction] That means `"heightchange"` can fire from ordinary typing (adding a line), not only from a programmatic `setValue()` after "Regenerate SQL", and each firing re-centres the dialog. This is accepted, not a defect: `FilterDialog`'s own `resizeToContent()` call already re-centres the dialog on every row add/remove — an even higher-frequency interaction than adding a line of SQL — and no complaint about that exists in this codebase.

### Row cap: `SQL_PREVIEW_MAX_ROWS = 24`

No existing `CodeEditor` call site in this app sizes by row count — the other four all fill a resizable host that absorbs whatever space is left over (a `Split` pane, or a `Border` layout's `CENTER`) instead of sitting in a fixed-row stack, so there is no in-app row-count precedent to follow (surveyed via `grep -rn "new CodeEditor(" frontend/src`[^codeeditor-survey]). The chosen value is instead anchored to this app's own DDL shape: [`backend/app/sql/ddl.py:160`](backend/app/sql/ddl.py#L160)'s `create_table` renders one line per column plus an opening and closing paren line,[^ddl-line-count] and the app's own stress-test fixture for "a table with a lot of columns" is `wide.cols_20`, referenced throughout `LIBRARY_NOTES.md`. Twenty columns is 22 lines; 24 leaves two lines of headroom (e.g. a trailing `PRIMARY KEY` clause) before the editor's own scrollbar engages, while still capping the more extreme `wide.cols_60` case (62 lines) well short of taking over the whole dialog.

---

## Public API

No exported signatures change. `ExplorerTree.refresh(): void` ([`NavigatorTree.ts:99`](frontend/src/navigator/NavigatorTree.ts#L99)) and `SqlPreviewDialogOptions` are both unchanged.

---

## Internal Structure

### Change 1 — `NavigatorTree.refresh()`

```ts
refresh = (): void => {
    void loadSchemas(this.conn, this.database)
        .then(nodes => {
            this.setNodes(nodes);

            // A single-schema database: expand that lone schema immediately so
            // its category folders show without an extra click. nodes[0] IS
            // that schema's own TreeNode (see schemaNode below); expandNode
            // loads its children via the node's loadChildren if not cached yet.
            if (nodes.length === 1) {
                this.expandNode(nodes[0]);
            }
        })
        .catch(error => this.controller.notifyError(error));
};
```

### Change 2 — `SqlPreviewDialog.ts`

```ts
// The editor's placeholder height for the one layout pass before it has
// mounted and measured its own content (see plans/align-with-library-post-0.4.1.md's
// "autoHeightMaxRows takes over from preferredSize" decision). Cleared via
// clearPreferredSize() on the editor's first "heightchange", after which the
// editor's own live height drives its preferred size instead — keeping this
// as a permanent preferredSize would fight autoHeightMaxRows on every later
// relayout, snapping the editor back to this fixed number.
const EDITOR_SEED_HEIGHT = 180;

// Row cap CodeEditor's autoHeightMaxRows grows the preview to before its own
// scrollbar takes over. Sized to this app's own "wide table" DDL shape: a
// generated CREATE TABLE is one line per column plus an opening/closing paren
// line (backend/app/sql/ddl.py's create_table), and wide.cols_20 (this app's
// standard many-column fixture, see LIBRARY_NOTES.md) is 22 such lines; 24
// leaves headroom for a trailing clause without immediately scrolling.
const SQL_PREVIEW_MAX_ROWS = 24;
```

```ts
async function runSqlPreviewDialog(options: SqlPreviewDialogOptions): Promise<void> {
    // Re-fit hook for the current Dialog. Wired to a real dialog only once
    // showExecuteRetryLoop builds one — mirrors FilterDialog's own `resizer`
    // object, needed here because the editor (and its "heightchange" listener)
    // is built before any Dialog exists, and showExecuteRetryLoop rebuilds
    // `dialog` again on every failed-execute retry.
    const resizer = { fit: () => {} };

    const editor = new CodeEditor("", {
        language:          "sql",
        autoHeightMaxRows: SQL_PREVIEW_MAX_ROWS,
        preferredSize:     { width: 0, height: EDITOR_SEED_HEIGHT },
    });

    // Once the editor has real measured content — first mount, and every
    // "Regenerate SQL"/manual edit that changes its row count after — drop the
    // seed preferredSize constraint (see EDITOR_SEED_HEIGHT's comment above)
    // and re-fit the current dialog to the new height (Dialog does not do
    // this on its own past its one-time post-open resizeToContent()).
    editor.on("heightchange", () => {
        editor.clearPreferredSize();
        resizer.fit();
    });

    // ...regenerateButton, content unchanged...

    try {
        await refreshPreview(editor, options);
        await showExecuteRetryLoop(content, editor, options, resizer);
    } finally {
        editor.dispose();
    }
}

async function showExecuteRetryLoop(
    content: Component,
    editor: CodeEditor,
    options: SqlPreviewDialogOptions,
    resizer: { fit: () => void },
): Promise<void> {
    let dialog = buildDialog(content, options);
    resizer.fit = () => dialog.resizeToContent();

    for (;;) {
        const result = await dialog.show();

        if (result !== "confirm") {
            return; // Cancel, or any dismiss gesture — do nothing.
        }

        try {
            const status = await options.execute(editor.getValue());

            options.onSuccess(status);

            return;
        } catch (err) {
            reportError(err, options.onError);

            // The dialog just shown is now destructed; detach the persistent
            // content from its (spent) content container before re-wrapping
            // it in a fresh dialog for the retry.
            dialog.getContentComponent().removeComponent(content);
            dialog = buildDialog(content, options);
            resizer.fit = () => dialog.resizeToContent();
        }
    }
}
```

---

## Ordered Implementation Steps

1. **`frontend/src/navigator/NavigatorTree.ts`** — in `refresh()` ([`NavigatorTree.ts:195-211`](frontend/src/navigator/NavigatorTree.ts#L195)), replace `void this.revealByPredicate(data => data === undefined);` with `this.expandNode(nodes[0]);` and replace the five-line comment above it with the shorter one in `## Internal Structure` above. Check: `grep -n "revealByPredicate" frontend/src/navigator/NavigatorTree.ts` returns no matches.

2. **`frontend/src/dock/SqlPreviewDialog.ts`** — rename `EDITOR_HEIGHT` to `EDITOR_SEED_HEIGHT` (its only two occurrences: the `const` declaration and the `preferredSize` usage) and rewrite its comment per `## Internal Structure`. Add `SQL_PREVIEW_MAX_ROWS = 24` beside it, with the comment above. Check: `grep -n "EDITOR_HEIGHT\b" frontend/src/dock/SqlPreviewDialog.ts` returns no matches (only `EDITOR_SEED_HEIGHT` remains).

3. **`frontend/src/dock/SqlPreviewDialog.ts`** — in `runSqlPreviewDialog`, add the `resizer` object, add `autoHeightMaxRows: SQL_PREVIEW_MAX_ROWS` to the editor's construction options, and add the `editor.on("heightchange", …)` listener, per `## Internal Structure`. Pass `resizer` as a fourth argument to `showExecuteRetryLoop`.

4. **`frontend/src/dock/SqlPreviewDialog.ts`** — update `showExecuteRetryLoop`'s signature to accept `resizer: { fit: () => void }`, add `resizer.fit = () => dialog.resizeToContent();` immediately after each of the two places `dialog` is assigned (the initial `let dialog = buildDialog(…)` and the retry-path reassignment inside the `catch` block). Update the function's JSDoc with a `@param resizer` line.

5. **Typecheck.** Run the frontend's typecheck script (e.g. `npm run typecheck` or the project's equivalent under `frontend/`) — both changes are typed against already-built `dist/lib` `.d.ts` files, so a mismatch here means the symlinked library build is stale, not a plan error.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) |
| Modify | [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts) |

---

## Expected Behaviour

### Change 1

- **Single-schema database, non-empty schema.** On initial load and on the refresh tool/shortcut, the lone schema is expanded and its category folders (Tables, Views, …) are visible without an extra click — the same outcome the old `revealByPredicate` call produced. Manual verify: log into a database whose only schema is `public`, confirm the tree opens with `public` expanded.
- **Single-schema database, empty schema** (no tables/views/sequences/functions/types). The schema now expands to an empty parent, where it previously stayed collapsed (see the Architecture Decisions footnote). Manual verify: same as above against a schema with no objects, if one exists among the app's test databases; otherwise note this as unverified rather than fabricating a result.
- **Multi-schema database.** No schema auto-expands — `nodes.length === 1` is false, so the `if` body never runs; this branch is untouched by the change. Manual verify: log into a multi-schema database, confirm every schema starts collapsed as before.
- **Refresh after the initial load** (the refresh tool / keyboard shortcut) behaves identically to initial load for both cases above, since `refresh()` is the same code path either way.

All three are manual-verify only: `NavigatorTree.ts` has no existing unit test file, and `Tree`'s lazy-load path depends on a live `loadChildren` fetch this app does not mock at the node level elsewhere either.

### Change 2

- **Opening the dialog.** The editor seeds at `EDITOR_SEED_HEIGHT`, then grows or shrinks to fit the generated SQL's real line count (up to `SQL_PREVIEW_MAX_ROWS`) once mounted, with no visible fixed-height box for previews shorter than the old 180px default and no premature outer-dialog scroll for previews a little longer than it. Manual verify: open a DDL dialog (e.g. Create Table) with a short generated preview and confirm the editor is not oversized, and with a wide-table preview (≥ `SQL_PREVIEW_MAX_ROWS` lines) and confirm the editor caps its height and shows its own internal scrollbar rather than growing unboundedly.
- **"Regenerate SQL" changes the line count.** The dialog re-fits (grows/shrinks/re-centres) to the new content height. Manual verify: change the form so the regenerated SQL is longer or shorter, click "Regenerate SQL", confirm the dialog visibly resizes.
- **Manually editing the SQL to add or remove lines.** Same re-fit behaviour as regenerating, since both go through the same `"heightchange"` event. Manual verify: type an extra newline into the editor, confirm the dialog grows.
- **A failed Execute, followed by retry.** The re-shown dialog (a fresh `Dialog` instance per `showExecuteRetryLoop`'s existing retry design) still re-fits correctly on a subsequent `"heightchange"`, because `resizer.fit` is rewired at the reassignment. Manual verify: trigger an execute failure (e.g. invalid SQL), confirm the retried dialog still resizes correctly if the SQL is edited again.
- **Every other `CodeEditor` call site is unaffected** — `autoHeightMaxRows` defaults to unset, and none of `localStorageWindow.ts`, `definitionEditor.ts`, or `QueryPanel.ts`'s two editors are touched by this plan. Verify: `grep -rn "autoHeightMaxRows" frontend/src` shows only `SqlPreviewDialog.ts`.

All of Change 2's behaviours are manual-verify only: `CodeEditor` mounts nothing under the framework's offline test sink (it wraps a foreign CodeMirror view, the same "live-only" category as `Canvas`), so no node-level unit test can exercise `autoHeightMaxRows` or `"heightchange"` through this app's own harness.

---

## Verification

1. `grep -n "revealByPredicate" frontend/src/navigator/NavigatorTree.ts` — no matches.
2. `grep -n "EDITOR_HEIGHT\b" frontend/src/dock/SqlPreviewDialog.ts` — no matches (only `EDITOR_SEED_HEIGHT`).
3. `grep -rn "autoHeightMaxRows" frontend/src` — only `SqlPreviewDialog.ts`.
4. Frontend typecheck passes against the symlinked library build.
5. Manual verification per every bullet in `## Expected Behaviour`, using the `run`/`verify` project skills to drive the live app.

---

## Documentation Impact

Neither change touches exported API or a documented public surface — `LIBRARY_NOTES.md` is the app's own log of library workarounds and fixes, not user-facing documentation, but both changes are exactly the kind of "app-side workaround retired by a library fix" it already tracks (see the `Dock` `emptychange`/`isEmpty()` entry and the `Split.setPaneSize` entry). Consider a short new entry once implemented, following that file's existing format — not required for this plan to be considered complete, since the file's own convention is to log defects/frictions and their resolutions rather than every clean adoption.

---

## Potential Challenges

- **Ordering assumption for the initial mount's `"heightchange"`.** The plan assumes the editor's first real `"heightchange"` (fired from `mount()`'s trailing `syncAutoHeight()` call) arrives after `showExecuteRetryLoop` has already built the first `Dialog` and wired `resizer.fit` — true because `CodeEditor` can only mount once it is laid out inside a connected `Dialog`, i.e. after `dialog.show()`. If manual verification ever shows an initial-open flash at the wrong height, re-check this ordering rather than assuming the row cap is wrong.
- **`clearPreferredSize()` also drops the width constraint**, not just height — confirmed harmless here because `VBox({ stretching: true })` already overrides cross-axis width unconditionally (see the "`width: 0`" paragraph under Architecture Decisions), but this would not hold in a non-stretching host.

---

## Critical Files

- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) — Change 1's only file.
- [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts) — Change 2's only file.
- [`frontend/src/dock/FilterDialog.ts:101-140`](frontend/src/dock/FilterDialog.ts#L101) — the `resizer`/`resizeToContent()` precedent Change 2 mirrors.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts` (`expandNode`, `_onToggle`, `_loadAndExpand`, around lines 645-739) — Change 1's library API.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts` (`autoHeightMaxRows`/`syncAutoHeight`/`"heightchange"`, around lines 54-68 and 788-990) and `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/core/Component.ts` (`getPreferredSize`/`setPreferredSize`/`clearPreferredSize`, lines 2739-2854) — Change 2's library API and the `preferredSize`-precedence mechanics the design decision depends on.
- `/home/jika/typescript/sqladmin/LIBRARY_NOTES.md` — the app's own precedent for "adopt new library API in place of a workaround" (`Dock` `emptychange`, `Split.setPaneSize`).

---

## Non-Goals

- Adopting `autoHeightMaxRows` at any other `CodeEditor` call site (`localStorageWindow.ts:225`, `definitionEditor.ts:51`, `QueryPanel.ts:183` and `:834`) — out of scope; none of the four need it (each already fills a resizable host).
- `roles/RolesTree.ts:117`'s own `revealByPredicate` call — a genuine predicate search for a named user row, not the surrogate-ancestor-match trick Change 1 removes. Unrelated, untouched.
- Any library-side (`typescript-ui` repo) change. Both `expandNode` and `autoHeightMaxRows` already exist in the symlinked `dist/lib` this app builds against.
- Revisiting the breaking-change items already confirmed clean this session (tab-close-disposes-content, component option-clobbering fixes, Drawer/Rail theme tokens, `flat: true` buttons, `Markdown` prose defaults).

---

## Notes

[^dist-verified]: Confirmed directly, not assumed from the changelog prose: `frontend/node_modules/@jimka/typescript-ui` is a symlink to `/home/jika/typescript/typescript-ui/packages/lib`, and `grep -rl "expandNode" frontend/node_modules/@jimka/typescript-ui/dist/lib/*.js` / the same for `autoHeightMaxRows` both find a match — the built `dist/lib` this app actually consumes already contains both APIs, ahead of any tag. `package.json`'s `"@jimka/typescript-ui": "^0.4.1"` range will accept a future release containing them without a `package.json` change.

[^expandnode-mechanics]: `Tree.expandNode(node)` ([`Tree.ts:655`](../../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L655)) is a two-line wrapper: `if (!this._expandedNodes.has(node)) { this._onToggle(node); }`. `_onToggle` ([`Tree.ts:673`](../../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L673)) checks `needsLoad = node.loadChildren !== undefined && !this._loadedNodes.has(node) && !(node.children && node.children.length)` — true for a freshly-built schema node, which has `loadChildren` but no `children` — and dispatches to `_loadAndExpand(node)` ([`Tree.ts:715`](../../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L715)), the same async load-then-expand path a caret click runs. So `expandNode` on the schema node genuinely fetches its objects and expands it, not merely a synchronous "mark expanded."

[^empty-schema-behavior]: `_loadAndExpand`'s own doc comment states this explicitly: "An empty resolved array is treated as success: the node renders as an expanded, empty parent." Under the old code, an empty schema has zero category nodes (`categoryNode` returns `null` for every category when `members.length === 0`, and `loadObjects` filters those out), so `revealByPredicate(data => data === undefined)` finds nothing to match inside that schema's subtree and resolves to `null` — the schema stays collapsed, silently. This is a real, if minor, behaviour improvement rather than a regression: the schema still gets its `loadChildren()` fetch run either way (the old code never skipped the fetch, only the *reveal*), so no extra network cost is introduced.

[^preferred-size-precedence]: `Component.getPreferredSize()` ([`Component.ts:2750`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2750)) checks `getPreferredSizeConstraint()` ([`Component.ts:2739`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2739)) first — the caller-supplied `preferredSize` option, if the key is present in `_options` at all — and returns it verbatim when set, without consulting the component's current size or layout manager. Only when no constraint is set does it fall through to `getSize()` (for a leaf component with no layout manager, which `CodeEditor` is). `VBox`'s own `layoutPreferredMode` ([`VBox.ts:417`](../../typescript-ui/packages/lib/src/typescript/lib/layout/VBox.ts#L417)) calls `component.getPreferredSize()` on every relayout — not just the first — to compute each child's placed height via `resolveChildHeight` ([`VBox.ts:599`](../../typescript-ui/packages/lib/src/typescript/lib/layout/VBox.ts#L599)), and commits that height back onto the child. So a stale, still-set `preferredSize` constraint is not inert once mounted — it is actively reasserted, in pixels, on every subsequent relayout the surrounding `Dialog` runs (a viewport resize, or any `resizeToContent()` call), which is precisely the scenario Change 2 needs to keep working correctly after the user grows the editor past its seed height. `clearPreferredSize()` ([`Component.ts:2848`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2848)) is the documented, public way to drop a previously-set constraint (as opposed to never having set one, which — per its own doc comment — a plain `preferredSize: undefined` option cannot express, since `applyOptions` skips `undefined` entries).

[^resize-not-automatic]: `Dialog`'s constructor ([`Dialog.ts:570`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L570)) computes an initial height once, synchronously, from `computeContentHeight(config)` ([`Dialog.ts:738`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L738)) — before the dialog or its content has ever been laid out. `open()` ([`Dialog.ts:797`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L797)) schedules exactly one correction, `Component.afterNextLayout(() => this.resizeToContent())`, to settle content whose real size depends on being laid out (per `computeContentHeight`'s own doc comment, written for wrapping `Text`). `resizeToContent()` ([`Dialog.ts:778`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L778)) is also called from the dialog's viewport-resize handler. Nothing in `Dialog` subscribes to a content descendant's own change events — a dialog does not know, on its own, that a `CodeEditor` three levels down just grew. `FilterDialog.ts` already solves the identical problem for its own add/remove-row resizing by having the app call `resizeToContent()` explicitly on every content change ([`FilterDialog.ts:277-280`](frontend/src/dock/FilterDialog.ts#L277)); Change 2 follows the same shape.

[^editable-distinction]: The app's five `CodeEditor` call sites, by mode: editable — `SqlPreviewDialog.ts` (this one), `definitionEditor.ts:51` (a Save-gated definition editor), `QueryPanel.ts:183` (the main query editor); read-only — `localStorageWindow.ts:225` (a storage-value inspector) and `QueryPanel.ts:834` (the Explain plan viewer). A read-only editor can never fire `"heightchange"` from user input at all — only from a caller's own `setValue()`/formatter call — so the "resize mid-interaction" consideration this decision raises would equally apply to `definitionEditor.ts` and `QueryPanel.ts:183` if they adopted `autoHeightMaxRows`, but neither does (see Non-Goals); only `SqlPreviewDialog.ts` is in scope here.

[^codeeditor-survey]: `grep -rn "new CodeEditor(" frontend/src` — five call sites, listed in the `editable-distinction` footnote above. None passes `autoHeightMaxRows` or sizes by row count today. Three build their own `Split` directly (`QueryPanel.ts`'s two editors, `localStorageWindow.ts`); `definitionEditor.ts` is a composition helper with no layout opinion of its own, and its two callers each give it the whole of a different resizable host — `DefinitionPanel.ts` puts it at `weight: 1` in a vertical `Split` beside a fixed-height columns grid, while `FunctionDefinitionPanel.ts` (no columns facet to share space with) places it at `Placement.CENTER` of a `Border` layout, which absorbs all space the toolbar doesn't take.

[^ddl-line-count]: [`backend/app/sql/ddl.py:160-200`](backend/app/sql/ddl.py#L160)'s `create_table` builds the column/constraint list via `",\n".join(f"{_CREATE_TABLE_INDENT}{line}" for line in lines)` and wraps it as `f"CREATE TABLE {exists_clause}{qualify(schema, name)} (\n{body}\n)"` — one line per column/constraint, plus one opening-paren line and one closing-paren line. `wide.cols_20` (20 columns, no listed extra constraints beyond its columns) therefore renders as 22 lines.
