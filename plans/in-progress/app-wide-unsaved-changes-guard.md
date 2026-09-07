---
depends-on: [documentation-panel-toolbar-adoption]
touches-shared: [frontend/src/dock/DocumentationPanel.ts]
---

# App-Wide Unsaved-Changes Guard — Implementation Plan

## Overview

sqladmin has no `beforeunload` handler anywhere today, so a refresh, tab close, or
navigate-away silently drops a table's pending edits, an unsaved SQL definition, or
an unwritten note. There is also no per-tab prompt: closing one dirty Dock tab is as
silent as closing a clean one.

The sibling library, `@jimka/typescript-ui`, now ships two features that make both
guards possible with almost no app code: `Component.isDirty()`
([`Component.ts:2340`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2340))
folds every registered descendant's dirty state into its own automatically, at any
nesting depth, through the same `wireChild`/`unwireChild` machinery every
`addComponent` call already goes through
([`Component.ts:6463-6511`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L6463)).
`Tab` gained a `"beforetabclose"` event
([`Tab.ts:1130-1149`](../../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1130)),
firing on every user close path (the ✕, the context menu's *Close*, and every
bulk-close row) with a vetoable `TabCloseController`.

This plan adds two independent guards, both reading `isDirty()` live at the moment
they fire — no snapshot, no cache:

1. **`beforeunload`**, installed once from
   [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts), the
   app's mount root, checking `controller.dock.isDirty()`.
2. **`beforetabclose`**, wired from
   [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts), right
   after the controller's existing `dock.on(...)` subscriptions
   ([lines 215-270](frontend/src/SqlAdminController.ts#L215)), onto every `Tab`
   region the Dock ever creates — including one a user creates by splitting or
   tearing off a tab — discovered lazily as panels attach or move.

Investigation found the automatic fold already works, with no app-side wiring,
for `TableWorkPanel`, `QueryPanel`, and `DdlFormPanel`. It found one real gap —
`DefinitionEditor.reload()` never accepts its reseeded text as the new clean
baseline — and one design choice needed for `DocumentationPanel`'s autosave. Both
are one-line fixes, covered below.

---

## Architecture Decisions

### `beforeunload` checks `controller.hasUnsavedWork()`, not `controller.dock.isDirty()` or the whole shell

The app's mount root is `SqlAdminShell`
([`SqlAdminApp.ts:47`](frontend/src/SqlAdminApp.ts#L47),
`Body.getInstance().addComponent(SqlAdminShell(controller))`), and folding through
it would also reach `controller.dock.isDirty()` automatically — `SqlAdminShell`'s
`workArea` adds the Dock as a descendant
([`SqlAdminShell.ts:345`](frontend/src/shell/SqlAdminShell.ts#L345)). The guard
scopes to the controller's own open tabs instead of the whole shell.[^scope-to-dock]

It reads `controller.hasUnsavedWork()`, not `controller.dock.isDirty()` directly,
because the latter has a real blind spot: a tab torn into a floating window is
reparented into that window's own subtree, mounted through the library's
`LayerManager` rather than an `addComponent` call under `dock`, so the ordinary
`wireChild`/`unwireChild` ancestor-chain fold `isDirty()` relies on stops
reaching `dock` the moment a tab is torn off.[^float-fix] `hasUnsavedWork()`
instead tracks every open tab's content directly — tiled or floated — via the
same `"attach"`/`"close"` events the controller already subscribes to for its
own per-panel bookkeeping, and checks each one's own `isDirty()` (which folds
its own subtree correctly regardless of where that content is currently
mounted), covering both cases with one check.

### `beforetabclose` is wired per `Tab` region, discovered from Dock's own `"attach"`/`"move"` events

`Dock` can hold more than one `Tab` region — the user can split the workspace or
tear a tab into a floating window at any time, unconditionally
([`Dock.ts:199-204`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L199)) —
and `Dock`'s own public event surface (`DockEvent`,
[`Dock.ts:140`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L140))
does not include a `"beforetabclose"` relay; only `"tabclose"`/`"activate"`/`"detach"`/`"dock"`
are forwarded from each region's `Tab`
([`Dock.ts:1069-1072`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L1069),
[`:1299-1302`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L1299)).
So the controller wires `"beforetabclose"` onto each `Tab` region itself, the first
time that region is seen, rather than waiting on a relay the library doesn't
have.[^no-dock-relay]

A region is "seen" by listening to `Dock`'s existing public `"attach"` and `"move"`
events: `"attach"` fires the first time any panel enters a host (a fresh
`addPanel`/`addLazyPanel`, or a tear-off into a new float); `"move"` fires when a
panel relocates to a different region within the same host (a same-tree split
creates one). Together they are the only two events that can ever introduce a
`Tab` region this controller has not wired yet.[^attach-move-complete] A
`WeakSet<Tab>` local to the constructor dedupes so each region's `Tab` gets exactly
one `"beforetabclose"` listener.

### The close-guard reads `content.isDirty()` off the Dock's own frame, needing no per-panel-type code

`"beforetabclose"` hands the listener the tab's content `Component` directly — for
a Dock tab, this is the Dock-owned identity frame `resolvePanel` builds
([`Dock.ts:582-643`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L582)),
which carries the panel's id (`frame.getId()`) and already folds in whatever real
panel (`TableWorkPanel`, `DefinitionPanel`, a `QueryPanel`'s content, …) it wraps,
however that panel is nested inside it. So the listener needs no per-panel-type
branching and no lookup through `SqlAdminController`'s `_openPanels` registry
— `panelEntry`/`OpenPanel` — which several tab kinds (`QueryPanel`,
`DocumentationPanel`) are never even entered into.

### The veto is synchronous; the confirm dialog runs after

`Dialog.confirm` is asynchronous, but a `"beforetabclose"` listener must decide
whether to veto within the same synchronous dispatch
([`Tab.ts:1130-1149`](../../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1130)).
So a dirty tab is **always** vetoed synchronously via `controller.preventDefault()`,
and — only if the user then confirms — the tab is closed by calling
`dock.removePanel(id)` directly. `removePanel` uses `Tab.closeTab`, the
programmatic path `"beforetabclose"` never guards
([`Tab.ts:1235-1245`](../../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1235)),
so this cannot re-trigger the same prompt.

### The two guards need no synchronization

Both checks are live queries over the same automatic dirty fold; neither caches a
flag. Confirming a per-tab close destroys that tab's content, and `Container`'s
`unwireChild` decrements the ancestor `_dirtyDescendantCount` the moment the
content is removed
([`Component.ts:6490-6511`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L6490)) —
so `controller.dock.isDirty()` reflects the closed tab's absence immediately, with
no manual bookkeeping between the two guards.

### `Dialog.confirm` is the established confirmation UI

Every existing "are you sure" prompt in this codebase — signing out
([`SqlAdminShell.ts:472`](frontend/src/shell/SqlAdminShell.ts#L472)), removing a
saved query
([`queryWorkspace.ts:219-223`](frontend/src/controller/queryWorkspace.ts#L219)),
clearing saved connections
([`localStorageWindow.ts:177-182`](frontend/src/shell/localStorageWindow.ts#L177)) —
calls `Dialog.confirm(title, message)` and awaits the boolean. The close guard
follows the same shape: `await Dialog.confirm("Close tab", "This tab has unsaved
changes. Are you sure that you want to close it?")`.

### `DefinitionEditor.reload()` gets one added `markClean()` call

`DefinitionEditor.editor` (a `CodeEditor`) is already a registered child of both
`DefinitionPanel.content` and `FunctionDefinitionPanel.content`
([`DefinitionPanel.ts:93,97`](frontend/src/dock/DefinitionPanel.ts#L93),
[`FunctionDefinitionPanel.ts:55`](frontend/src/dock/FunctionDefinitionPanel.ts#L55)),
so `editor.isDirty()` already bubbles up to `content.isDirty()` with zero wiring.
The gap is in the *value* the flag reports, not its registration:
`CodeEditor`'s dirty flag compares the live document against `_cleanValue`, which
only construction and `markClean()` ever update
([`CodeEditor.ts:597-629`](../../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L597)).
`DefinitionEditor.reload()`
([`definitionEditor.ts:114-118`](frontend/src/dock/definitionEditor.ts#L114)) calls
`setValue()` but never `markClean()`, so once a user edits and saves, the editor's
`isDirty()` would report `true` **forever** — a permanent false positive on every
`DefinitionPanel`/`FunctionDefinitionPanel` tab that has ever been saved. Add
`this.editor.markClean()` right after `setValue()`.[^future-plan-independent] (The
cited line range already shows `markClean()` in place today — `reload()` moved to
114-118 and gained the call as part of the sibling plan `## Implementation Notes`
describes; this paragraph states the problem as this plan found it before that
landed.)

### `DocumentationPanel`'s autosaved edits also need a `markClean()` call

Notes persist synchronously to `localStorage` on every keystroke
([`notesStore.ts:45`](frontend/src/data/notesStore.ts#L45), no network round trip,
no pending state), so nothing is ever actually at risk of loss. But post-toolbar-
adoption, `DocumentationPanel extends MarkdownDocumentPanel` and never calls
`markClean()` either
([`documentation-panel-toolbar-adoption.md`](plans/implemented/documentation-panel-toolbar-adoption.md)'s
`## Internal Structure` and `## Non-Goals`, "`markClean()` … inherited but
unused") — so, unfixed, the Notes tab would read permanently dirty after the first
keystroke and trip both guards on every future session, for data that is never
actually unsaved. Add `this.markClean()` to the `"change"` handler, right after
`onChange(value)` — safe because `onChange` (`NotesStore.save`) is synchronous, so
the document is already durably persisted before `markClean()` runs.[^why-notes-fix-here]

### No change needed to `TableWorkPanel`, `QueryPanel`, or `DdlFormPanel` — beyond `RecordViewControls`[^searchfield-leak]

- `TableWorkPanel.dataGrid` (a `Table`) is added through a `Panel` that is itself a
  registered child of the panel
  ([`TableWorkPanel.ts:194-195`](frontend/src/dock/TableWorkPanel.ts#L194)). `Table`'s
  own `isDirty()` is driven directly off `store.hasPendingChanges()` and clears on
  sync or reject
  ([`Table.ts:1298-1308`](../../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L1298)) —
  the same signal `syncSaveEnabled` already uses, and the same two events
  (`store.sync()`, `store.reject()`) `TableWorkPanel`'s own Save/Refresh buttons
  already call. No baseline ever goes stale.
- `QueryPanel`'s SQL `CodeEditor` is a registered child of `content`
  ([`QueryPanel.ts:245,308`](frontend/src/dock/QueryPanel.ts#L245)), and nothing
  about a scratch query panel ever calls `markClean()` — correctly: a query tab has
  no server-side baseline to return to, so "dirty since the last edit, forever" is
  the truthful state for a buffer whose only copy is the tab itself. "Save…" writes
  a *copy* under a name in `SavedQueryStore`; it does not mark this tab clean.
- `DdlFormPanel` adds its whole form as a registered child
  ([`DdlFormPanel.ts:57,66-67`](frontend/src/dock/DdlFormPanel.ts#L57)), so any
  `AbstractInput` inside a DDL draft form (`CreateTableForm`, `EnumTypeForm`, …)
  folds up automatically. A successful execute closes the tab via
  `dock.removePanel(id)`
  ([`ddlLaunchers.ts:521-532`](frontend/src/controller/ddlLaunchers.ts#L521)), the
  unguarded programmatic path, so completing a draft never trips the prompt.
- `StructurePanel`, `TypeInfoPanel`, and `RoleGrantsPanel` need no change:
  `StructurePanel`/`TypeInfoPanel` edit through a `Table`-backed store that
  already calls `store.reject()` before every reseed (`StructurePanel.ts:351`,
  `TypeInfoPanel.ts:467`), the same `Table.isDirty()` mechanism
  `TableWorkPanel` uses above; `RoleGrantsPanel` holds no `AbstractInput` at
  all.[^diagram-and-sequence-leaks] `IndexInfoPanel` does need a change —
  found only in a later audit round; see [^indexinfo-reload-leak].
- `QueryResultView`'s chart config strip (`QueryResultChart`'s `xCombo`/
  `yCombo`) also needs a change, found in the same round; see
  [^chart-combo-leak].

---

## Internal Structure

**`frontend/src/dock/definitionEditor.ts`** — `reload()`, one line added:

```ts
reload(definition: string): void {
    this._baseline = definition;
    this.editor.setValue(definition);
    this.editor.markClean();
    this.syncDirty();
}
```

**`frontend/src/dock/DocumentationPanel.ts`** (post-toolbar-adoption shape) — the
`"change"` subscription, one line added:

```ts
this.on("change", ({ value }) => {
    onChange(value);
    this.markClean();
});
```

**`frontend/src/SqlAdminController.ts`** — new wiring in the constructor, placed
after the existing `dock.on("focus", …)` block
([`SqlAdminController.ts:261-270`](frontend/src/SqlAdminController.ts#L261) —
this line range shifted after the `hasUnsavedWork()`/`_openContents` wiring
in [^float-fix] landed ahead of it in the constructor):

```ts
// Dirty-tab close guard. Wired once per Tab region — the region a tab lives
// in when the Dock is split or a tab is torn into a float, not just the
// region present at construction. "attach" and "move" are the only two Dock
// events that can introduce a region this controller has not wired yet; a
// WeakSet dedupes so each Tab instance gets exactly one listener.
const wiredTabRegions = new WeakSet<Tab>();

const wireBeforeTabClose = (e: DockPanelEvent): void => {
    const region = e.content.getParentComponent();
    const tab    = region?.getLayoutManager();

    if (!(tab instanceof Tab) || wiredTabRegions.has(tab)) {
        return;
    }

    wiredTabRegions.add(tab);
    tab.on("beforetabclose", (content, closeController) => {
        if (!content.isDirty()) {
            return;
        }

        // The veto must happen synchronously; Dialog.confirm is async, so
        // veto now and close the tab ourselves once the user answers.
        // dock.removePanel is the programmatic path "beforetabclose" does
        // not guard, so this cannot re-trigger the same prompt.
        closeController.preventDefault();

        void Dialog.confirm(
            "Close tab",
            "This tab has unsaved changes. Are you sure that you want to close it?",
        ).then(confirmed => {
            if (confirmed) {
                this.dock.removePanel(content.getId());
            }
        });
    });
};

this.dock.on("attach", wireBeforeTabClose);
this.dock.on("move",   wireBeforeTabClose);
```

No explicit parameter types are needed on the inner `(content, closeController) =>`
— `tab`'s type is narrowed to `Tab` by the `instanceof` check, so TypeScript infers
both parameter types from `Tab.on`'s `"beforetabclose"` overload.

**`frontend/src/shell/SqlAdminShell.ts`** — a new module-level function, called
once from the constructor. Superseded once by [^float-fix] (checks
`hasUnsavedWork()`, not `controller.dock.isDirty()`) and again by the
sign-out-regression fix recorded in `## Implementation Notes` (the
`unloadGuardSuppressed` flag); the snippet below is the shape that actually
shipped, not the plan's original one-`if` draft:

```ts
// Set just before confirmSignOut's own window.location.reload() — a
// programmatic navigation fires "beforeunload" exactly like a manual one, so
// without this the browser's native prompt would fire a second time (after
// the user already answered "Sign out" above) and, if declined there, would
// leave the page up with a server-side session confirmSignOut already
// dropped. Session-scoped module state, mirroring buildWorkArea's `lastWidth`
// closure below.
let unloadGuardSuppressed = false;

/**
 * Warns before a refresh, tab close, or navigate-away that would silently
 * drop unsynced work in an open Dock tab — tiled or torn into a float; see
 * `SqlAdminController.hasUnsavedWork`'s doc comment for why that check, not
 * `controller.dock.isDirty()`, is the right one. Scoped to the controller's
 * own open tabs, not the whole shell, so an AbstractInput elsewhere in the
 * shell (a navigator search field, say) can never trigger it — see
 * plans/app-wide-unsaved-changes-guard.md's Architecture Decisions.
 *
 * @param controller - The mediator whose open tabs gate the prompt.
 */
function installUnloadGuard(controller: SqlAdminController): void {
    window.addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
        if (unloadGuardSuppressed || !controller.hasUnsavedWork()) {
            return;
        }

        event.preventDefault();
        event.returnValue = "";
    });
}
```

Called from the constructor's post-`super()` wiring, beside `installAccelerators`:

```ts
installAccelerators(controller, sidebar);
installUnloadGuard(controller);
```

---

## Ordered Implementation Steps

1. **Library freshness gate.** From `frontend/`:
   - `readlink -f node_modules/@jimka/typescript-ui` must print
     `/home/jika/typescript/typescript-ui/packages/lib`. If not, repoint it:
     `rm -rf node_modules/@jimka/typescript-ui && ln -s /home/jika/typescript/typescript-ui/packages/lib node_modules/@jimka/typescript-ui`.
   - In `/home/jika/typescript/typescript-ui`, run `npm run build:lib` (not `npm run build`).
   - `grep -n "isDirty(): boolean" node_modules/@jimka/typescript-ui/dist/lib/types/core/Component.d.ts` — one hit.
   - `grep -n 'beforetabclose' node_modules/@jimka/typescript-ui/dist/lib/types/layout/Tab.d.ts` — at least one hit.

2. **Precondition: confirm `documentation-panel-toolbar-adoption` has landed.**
   `grep -n "class DocumentationPanel extends MarkdownDocumentPanel" frontend/src/dock/DocumentationPanel.ts`
   — one hit. If it prints nothing, that plan has not run; `depends-on` should
   have ordered it first. Do not rewrite `DocumentationPanel.ts` yourself —
   only add the one line in step 4.

3. **`frontend/src/dock/definitionEditor.ts` — `reload()`.** Add
   `this.editor.markClean();` immediately after `this.editor.setValue(definition);`,
   per `## Internal Structure`. Leave `_baseline`/`syncDirty` untouched — this adds
   a second, independent dirty signal (the library's own `CodeEditor.isDirty()`)
   without changing the Save button's existing gating logic.

4. **`frontend/src/dock/DocumentationPanel.ts` — the `"change"` handler.** Change
   `this.on("change", ({ value }) => onChange(value));` to the two-statement
   version in `## Internal Structure` (call `this.markClean()` after `onChange(value)`).

5. **`frontend/src/SqlAdminController.ts` — imports.** Add `Dialog` to the
   existing `@jimka/typescript-ui/overlay` import
   ([line 11](frontend/src/SqlAdminController.ts#L11)) and `Tab` to the existing
   `@jimka/typescript-ui/layout` import
   ([line 14](frontend/src/SqlAdminController.ts#L14)).

6. **Same file — wiring.** Insert the `## Internal Structure` block (the
   `wiredTabRegions` WeakSet, `wireBeforeTabClose`, and the two `dock.on(...)`
   calls) immediately after the existing `dock.on("focus", …)` block, i.e. after
   [line 270](frontend/src/SqlAdminController.ts#L270) and before the
   `this.statusBar.setMessage(...)` line that follows it.

7. **`frontend/src/shell/SqlAdminShell.ts` — `installUnloadGuard`.** Add the
   module-level function from `## Internal Structure` beside `installAccelerators`
   (after its closing brace, [around line 200](frontend/src/shell/SqlAdminShell.ts#L200)).
   Call `installUnloadGuard(controller);` right after the existing
   `installAccelerators(controller, sidebar);` call
   ([line 149](frontend/src/shell/SqlAdminShell.ts#L149)).

8. **Grep invariants**, from `frontend/`:
   - `grep -n "markClean" src/dock/definitionEditor.ts` — two hits post-`definition-editor-dirty-state-adoption`
     (see `## Implementation Notes`): a class-header doc-comment mention ("`setValue()`-then-`markClean()`
     order") plus the real call inside `reload()`. At the time this plan started implementing, before that
     sibling plan had landed, this was exactly one hit, inside `reload()`.
   - `grep -n "this.markClean()" src/dock/DocumentationPanel.ts` — exactly one hit, inside the `"change"` handler.
   - `grep -n 'dock.on("attach"\|dock.on("move"' src/SqlAdminController.ts` — three hits total: two `"attach"`
     (the `_openContents` tracker [^float-fix] added, and the `beforetabclose` wiring below) and one `"move"`.
   - `grep -n "beforeunload" src/shell/SqlAdminShell.ts` — at least one hit.

9. **Typecheck and test.** `cd frontend && npm run typecheck && npm test` — both clean.

10. **Build.** `cd frontend && npm run build` — clean.

11. **Manual smoke.** Drive the app per `.claude/skills/verify/SKILL.md` and walk
    `## Expected Behaviour` below.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/definitionEditor.ts` |
| Modify | `frontend/src/dock/DocumentationPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Modify | `frontend/src/dock/recordViewControls.ts` — audit-discovered, [^searchfield-leak] |
| Modify | `frontend/src/dock/diagramShell.ts` — audit-discovered, [^diagram-and-sequence-leaks] |
| Modify | `frontend/src/dock/filteredDiagramShell.ts` — audit-discovered, [^diagram-and-sequence-leaks] |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` — audit-discovered, [^diagram-and-sequence-leaks] |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` — audit-discovered, [^diagram-and-sequence-leaks] |
| Modify | `frontend/src/dock/SequenceInfoPanel.ts` — audit-discovered, [^diagram-and-sequence-leaks] |
| Modify | `frontend/src/dock/IndexInfoPanel.ts` — audit-discovered, [^indexinfo-reload-leak] |
| Modify | `frontend/src/dock/QueryResultView.ts` — audit-discovered, [^chart-combo-leak] |

---

## Expected Behaviour

Every case is **manual** — the frontend's vitest runs DOM-less
(`frontend/vitest.config.ts`), and every behaviour here depends on live `Dock`/`Tab`
wiring, a browser `beforeunload` event, or a rendered `Dialog`.

1. **Table edit, close without saving** — edit a cell in an open table tab, click
   its tab's ✕. A "Close tab" confirm appears. Cancel leaves the tab and the edit
   in place; Confirm closes it and discards the edit.
2. **Table edit, then Save, then close** — edit a cell, click Save (Sync
   succeeds), then close the tab. No prompt — `Table.isDirty()` cleared on sync.
3. **View definition edit, then Save, then close** — edit a view's SQL
   definition, click Save, then close its tab. No prompt — this is the
   `DefinitionEditor.reload()` fix; without it, this case would wrongly prompt.
4. **View definition edit, no save, close** — edit the definition, close without
   saving. Prompts.
5. **Notes edit, close** — type in the Notes tab, then close it (or reopen and
   close again). Never prompts, at any point — Notes autosaves and marks itself
   clean on every keystroke.
6. **Scratch query, unsaved, close** — type SQL into a new Query tab (run it or
   not), close the tab without using "Save…". Prompts — a query tab's own SQL has
   no other copy.
7. **Scratch query, "Save…", then close** — type SQL, use the panel's Save to
   name and store it, then close the tab. Still prompts — saving under a name
   copies the SQL elsewhere; it does not clean this tab's own editor.
8. **DDL draft, close** — open "Create Table…", type a table name, close the
   draft tab without executing. Prompts.
9. **DDL draft, execute successfully** — fill and execute a DDL draft. The tab
   closes with no prompt (the programmatic `removePanel` path).
10. **Read-only tab, close** — open Structure / Index Info / a diagram, close it.
    Never prompts.
11. **`beforeunload`** — with any dirty tab open, refreshing or closing the
    browser tab shows the browser's native "leave site?" prompt. With every tab
    clean (or no tabs open), no prompt.
12. **Split / tear-off region** — drag a tab to split the workspace, or tear one
    into a floating window; make it dirty; close it from its new region. Still
    prompts — this exercises the `"attach"`/`"move"` region-discovery path, not
    just the region present at startup.
13. **Bulk close with several dirty tabs** — right-click a tab, "Close All" (or
    equivalent), with two dirty and one clean tab open. Three prompts appear in
    total (`Dialog` stacks by design), one per dirty tab; the clean tab closes
    with none. Confirming both leaves nothing open; cancelling one leaves that
    tab (and only that tab) open.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — the existing suite green.
- `cd frontend && npm run build` — clean.
- The four greps in step 8, plus the four library-freshness checks in step 1.
- Manual: the thirteen cases in `## Expected Behaviour`.

---

## Potential Challenges

- **Stale local library build.** If `isDirty()`/`"beforetabclose"` are missing at
  typecheck time, step 1's build was skipped or the symlink points elsewhere —
  re-run its four checks before writing any code.
- **A freshly opened tab's region wires on the next sweep, not instantly.**
  `"attach"` fires from `Dock`'s animation-frame sweep, not synchronously inside
  `addPanel` — the same latency every one of `Dock`'s own built-in relays
  (`"tabclose"`, `"activate"`, …) already has. Irrelevant in practice: a tab
  cannot be dirty before the user has had a chance to edit it, which is always
  well after one animation frame.
- **Stacked dialogs on a multi-tab bulk-close** are expected, not a bug — see
  case 13. Collapsing them into one "N tabs have unsaved changes" dialog would
  need `Tab` to batch `"beforetabclose"` per bulk operation, which it does not;
  out of scope (see `## Non-Goals`).

---

## Critical Files

- [`frontend/src/dock/definitionEditor.ts`](frontend/src/dock/definitionEditor.ts) — the one-line `reload()` fix.
- [`frontend/src/dock/DocumentationPanel.ts`](frontend/src/dock/DocumentationPanel.ts) — the one-line `"change"`-handler fix; read post-toolbar-adoption, not its current shape.
- [`frontend/src/dock/IndexInfoPanel.ts`](frontend/src/dock/IndexInfoPanel.ts) — the one-line `reload()` fix for the read-only `CodeEditor`'s own dirty tracking, found in a later audit round; see [^indexinfo-reload-leak].
- [`frontend/src/dock/QueryResultView.ts`](frontend/src/dock/QueryResultView.ts) — the chart config strip's `xCombo`/`yCombo` `markClean()` fix, found in the same round; see [^chart-combo-leak].
- [`plans/documentation-panel-toolbar-adoption.md`](plans/implemented/documentation-panel-toolbar-adoption.md) — the `depends-on` plan whose shape this plan's step 4 assumes (moved to `plans/implemented/` before this plan started; see `## Implementation Notes`).
- [`frontend/src/SqlAdminController.ts:173-270`](frontend/src/SqlAdminController.ts#L173) — the constructor and its existing `dock.on(...)` precedent this plan extends.
- [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts) — the mount root; `installAccelerators` (170-201) is the precedent `installUnloadGuard` mirrors.
- [`frontend/src/dock/TableWorkPanel.ts:102-235`](frontend/src/dock/TableWorkPanel.ts#L102), [`frontend/src/dock/QueryPanel.ts:230-310`](frontend/src/dock/QueryPanel.ts#L230), [`frontend/src/dock/DdlFormPanel.ts`](frontend/src/dock/DdlFormPanel.ts) — confirmed to need no change; read to verify, not to edit.
- [`../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts:2340-2404,6463-6511`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2340) — `isDirty`/`setDirty`/`onDirtyChange` and the `wireChild`/`unwireChild` fold.
- [`../../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts:1130-1245`](../../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1130) — `"beforetabclose"`'s emit site and `closeTab`'s unguarded programmatic path.
- [`../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts:140-231,447-474,680-771,1646-1656,1783-1797`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L140) — `DockEvent`'s fixed event list, `addPanel`/`activeTabRegion`/`newTabRegion`, `removePanel`, and `onFloatClosed` (the unguarded float title-bar-close handler; see `## Non-Goals` and [^float-fix]).
- [`../../typescript-ui/packages/lib/src/typescript/lib/overlay/AbstractWindow.ts:108,924-935`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/AbstractWindow.ts#L108) — `WindowEvent`'s fixed event list (no `"beforeclose"`) and `onExitAction`'s unconditional `emit("close")`, the evidence trail for the float title-bar-close gap (`## Non-Goals`, [^float-fix]).
- [`.claude/skills/verify/SKILL.md`](.claude/skills/verify/SKILL.md) — driving the manual smoke test.

---

## Non-Goals

- **A `"beforeclose"` relay on `Dock` itself**, forwarding every region's
  `"beforetabclose"` the way it already forwards `"tabclose"`. This would be a new
  typescript-ui feature, not something already in the library's source waiting on
  a build — out of scope for an app-side plan; the app-side `"attach"`/`"move"`
  discovery in this plan needs no library change at all.
- **Batching a bulk-close's several dirty-tab prompts into one dialog.** Each row
  fires its own `"beforetabclose"`; there is no signal that several are part of
  one gesture. See `## Potential Challenges`.
- **Guarding a dialog-hosted form.** Every editable form in this app
  (`CreateTableForm` and its siblings) is hosted in a `DdlFormPanel` Dock tab, not
  a plain `Dialog` — nothing today needs a third guard. If one ever does,
  `beforeunload`'s Dock-only scope (see Architecture Decisions) deliberately does
  not cover it.
- **Bumping `@jimka/typescript-ui` past `^0.8.0`** in `frontend/package.json` —
  release work, not feature work (`release-steps.md`).
- **Rewriting `DefinitionEditor`'s `_baseline`/`syncDirty` Save-button gating.**
  A separate, not-yet-drafted plan is expected to replace it with
  `CodeEditor.isDirty()`/`markClean()` outright; this plan adds only the one
  `markClean()` call `reload()` needs regardless of whether or when that lands.
- **A "don't ask me again" preference for either guard.**
- **Closing a torn-off floating window via its own title-bar close button.**
  This is a separate close path from the two this plan does cover
  (`beforeunload`, and the tab-strip close inside a region — the ✕, the
  context menu's *Close*, a bulk-close row, all firing `"beforetabclose"`,
  including from within a float's own tab strip). The floating window's own
  chrome ✕ runs `AbstractWindow.onExitAction()`, which unconditionally
  `emit("close")`s (`AbstractWindow.ts:927`) and tears the window down with
  no way to veto it: `WindowEvent` (`AbstractWindow.ts:108`) is the fixed
  union `"minimize" | "restore" | "close" | "activate"`, with no vetoable
  `"beforeclose"` today, and `Dock.onFloatClosed` (`Dock.ts:1646-1656`), the
  handler for that event, closes every frame the float held unconditionally
  too — it has nothing to veto against either. So a dirty tab living in a
  float can still be lost with no prompt if the user closes the whole float
  from its own title bar, rather than closing the tab from within the
  float's own tab strip. A known, out-of-scope gap, confirmed with the user
  after this plan's third audit round: fixing it would need a new vetoable
  close event on `AbstractWindow`/`Dock`, a library-level feature that does
  not exist today — not an app-side fix this plan can make. See
  `## Implementation Notes` and the corrected [^float-fix].

---

## Notes

[^scope-to-dock]: `AbstractInput` subclasses also report `isDirty()` automatically
    (per the library's changelog), and nothing outside the Dock — a navigator
    search field, a properties-panel input — ever calls `markClean()` on them
    either. Checking the whole shell would make typing into any such field trip
    the "leave site?" prompt, for text the user never thought of as "unsaved
    work." Scoping the check to the controller's own open Dock tabs — via
    `hasUnsavedWork()`/`_openContents`, not a literal `controller.dock.isDirty()`
    read; see [^float-fix] — avoids this for every field outside the Dock,
    present or future, without needing to enumerate them.

[^no-dock-relay]: Confirmed by reading `Dock.ts` directly, not inferred from the
    changelog: `DockEvent` (`Dock.ts:140`) is the fixed list
    `"attach" | "detach" | "move" | "focus" | "close" | "emptychange" | "exception"`,
    and both places a region's `Tab` gets wired
    (`Dock.ts:1069-1072`, `:1299-1302`) subscribe only to `"tabclose"`, `"activate"`,
    `"detach"`, and `"dock"` — never `"beforetabclose"`. Adding that relay would be
    a genuine new capability in the library, not an already-written one waiting on
    a version bump (contrast `MarkdownDocumentPanel`, which
    `documentation-panel-toolbar-adoption.md` found fully written in the library's
    source, just unbuilt). This plan does not propose it.

[^attach-move-complete]: Per `Dock.ts`'s own `DockEvent` doc comment (`:106-124`):
    `"attach"` fires on a panel's first appearance in any host or a host change
    (tear-off into a float, or a re-dock back into the tiled tree); `"move"` fires
    on a same-host relocation (a same-tree split creates one) and explicitly never
    accompanies a first appearance or a host change. Between the two, every path
    that can hand a panel to a `Tab` region for the first time is covered — there
    is no third path.

[^future-plan-independent]: A separate, not-yet-drafted plan ("DefinitionEditor
    dirty-state adoption") is expected to replace `_baseline`/`syncDirty` with
    `CodeEditor.isDirty()`/`markClean()` outright, for its own reasons (removing
    duplicate logic). This plan's one-line addition does not assume that plan has
    landed: `editor.isDirty()` already bubbles up to `content.isDirty()` today
    through ordinary `addComponent` registration, with or without that future
    rewrite, and `markClean()` is exactly the call that rewrite would also need in
    `reload()` — so this line is not lost work if that plan lands later, and this
    plan's guard is correct either way.

[^why-notes-fix-here]: `documentation-panel-toolbar-adoption.md`'s own
    `## Non-Goals` left `markClean()` "inherited but unused" because nothing in
    that plan's scope needed it — it did not anticipate a consumer of
    `isDirty()`. This plan is that consumer, so it is the right place to add the
    one line, not a reason to skip the fix: without it, the Notes tab would read
    permanently dirty after the first keystroke and trip both guards for the rest
    of every session, for data that `NotesStore.save`'s synchronous write already
    made safe.

[^searchfield-leak]: Found during this plan's audit, not anticipated by the
    text above: `RecordViewControls.searchField` (a `TextField`, hence an
    `AbstractInput`) is placed in `TableWorkPanel`'s toolbar
    (`TableWorkPanel.ts:167,194`) and `QueryResultView`'s
    (`QueryResultView.ts:85`), so it is a registered descendant of both and
    folds into their `isDirty()` the same automatic way every other
    `AbstractInput` does — nothing scopes the fold to "inputs that matter."
    Typing any non-empty quick-search term therefore made the whole panel
    read dirty forever (until the field was cleared back to `""`, its
    construction-time clean baseline — `TextInput.ts`'s constructor calls
    `markClean()`), tripping both guards for a tab with zero real pending
    edits. Fixed in `recordViewControls.ts`'s `applyQuickSearch` (the
    `"change"` handler already wired to `searchField`): `markClean()` right
    after the query is applied, the identical reasoning the plan already
    applies to `DocumentationPanel`'s autosave above — a quick-search term is
    transient view state the panel never persists, never actually at risk of
    loss. `recordViewControls.ts` was not in this plan's own "Files to
    Modify" table; it is added by this fix.

[^float-fix]: Found during this plan's first audit round, and initially
    (wrongly) recorded here as an accepted, unfixable limitation. A second
    audit round corrected that: tearing a Dock tab into a floating window
    (`Tab.ts`'s `detachTabToWindow` → `win.moveComponent(content)` for a bare
    window, `fillWindowWithStrip` for a strip one) does reparent the torn-off
    content into the `AbstractWindow`'s own Component subtree, whose root
    mounts via `LayerManager.mount()` rather than an `addComponent` call
    anywhere under `controller.dock` — so `wireChild`/`unwireChild`
    (`Component.ts:6463-6511`)'s ordinary parent-chain fold does stop reaching
    `dock` the moment content is torn off. But no *library* change is needed
    to work around that: `Dock`'s float/frame bookkeeping
    (`_panelHost`, `ownedFloatWindows`, `allTabRegions`, `_frames`, …) being
    entirely private (`Dock.d.ts`) only means the app cannot *enumerate*
    `Dock`'s floats after the fact — it does not mean the app cannot *track*
    them itself, and `SqlAdminController` already has everything needed to:
    `DockPanelEvent` (`Dock.d.ts:36-40`) hands every `"attach"`/`"close"`
    listener the `content: Component` directly, and the controller already
    subscribes to both for its own per-panel bookkeeping
    (`SqlAdminController.ts`'s existing `dock.on("close", …)` block, and the
    `"attach"` subscription this plan's `beforetabclose` wiring added). Adding
    one more `_openContents: Set<Component>` — populated on `"attach"`,
    pruned on `"close"` — gives `hasUnsavedWork()` a content list that is
    correct regardless of where each item is currently mounted, since each
    content's own `isDirty()` already folds its own subtree correctly on its
    own; `beforeunload` now reads that instead of `dock.isDirty()`.

    This fix covers `beforeunload` and the tab-strip close path — the ✕, the
    context menu's *Close*, a bulk-close row, all firing `"beforetabclose"`,
    including from within a float's own tab strip: that event is wired
    directly onto each `Tab` instance via `"attach"`/`"move"` discovery,
    independent of `dock`'s own fold, and a float's `Tab` region is
    discovered the same way any other is. **It does not cover the floating
    window's own title-bar ✕** — a third, separate close path a first
    version of this footnote wrongly folded into the same claim. That path is
    `AbstractWindow.onExitAction()`, which unconditionally `emit("close")`s
    (`AbstractWindow.ts:927`) and tears the window down with no veto:
    `WindowEvent` (`AbstractWindow.ts:108`) is the fixed union `"minimize" |
    "restore" | "close" | "activate"`, with no vetoable `"beforeclose"`
    today, and `Dock.onFloatClosed` (`Dock.ts:1646-1656`), the handler for
    that event, closes every frame the float held unconditionally too — it
    has nothing to veto against. A dirty tab living in a float can therefore
    still be lost with no prompt if the user closes the whole floating
    window from its own title bar, rather than closing the tab from within
    the float's own strip. See `## Non-Goals`: scoped out as a known,
    confirmed-with-the-user gap after this plan's third audit round, not
    fixed here — fixing it would need a new vetoable close event on
    `AbstractWindow`/`Dock`, a library-level feature that does not exist
    today.

[^indexinfo-reload-leak]: Found in a later audit round, after this plan's own
    text above (in the `### DefinitionEditor.reload()` heading's now-removed
    "the only real wiring gap" claim, and again in the bullet above
    certifying `IndexInfoPanel` as needing no change because it holds no
    `AbstractInput`) missed it twice. True as far as it goes — `CodeEditor`
    (`IndexInfoPanel.ts`'s read-only definition view) is not an
    `AbstractInput` — but it is not `AbstractInput`-free of dirty tracking
    either: it tracks its own `isDirty()` independently, comparing the live
    document against the `_cleanValue` only construction and `markClean()`
    ever update (`CodeEditor.ts`'s `markClean()` doc comment) — the identical
    trap `DefinitionEditor.reload()` above was fixed for. `IndexInfoPanel.reload()`
    called `setValue()` on every Refresh (and on reopening after a rename)
    but never `markClean()`, so a freshly reloaded, never-edited index tab
    read dirty forever, tripping both app-wide guards. Fixed the same way:
    `this._editor.markClean()` right after `setValue()` in `reload()`.

[^chart-combo-leak]: Found in the same later audit round as
    [^indexinfo-reload-leak]: `QueryResultChart`'s `xCombo`/`yCombo`
    (`QueryResultView.ts`'s chart config strip, both `ComboBox`, hence
    `AbstractInput`) fold into the chart tab's `isDirty()` on selection, with
    nothing ever calling `markClean()` — the same defect class as
    [^searchfield-leak] and [^diagram-and-sequence-leaks], recurring a third
    time, in a section of this plan (the chart tab) the original text never
    even certified one way or the other. Picking a chart axis column on a
    genuinely clean, unedited query-result tab falsely dirtied it forever.
    Fixed the same way: each combo's own `"change"` handler now calls its own
    `markClean()` at the end, mirroring `DiagramShell`'s Direction/Depth/prune
    controls.

[^diagram-and-sequence-leaks]: Found during this plan's second audit round:
    the same defect class as [^searchfield-leak] — an `AbstractInput`
    registered as a descendant, with nothing ever calling `markClean()` on it
    — recurs across every `DiagramShell`-family panel and in
    `SequenceInfoPanel`, both of which this plan's own text above had
    (wrongly) certified as needing no wiring. `DiagramShell`'s Direction,
    Depth, and prune controls (`diagramShell.ts:149,159,160`), its optional
    `Root …` selector (`:145`), `DatabaseDiagramPanel`'s Mode toggle
    (`DatabaseDiagramPanel.ts:88`), `RelationDiagramPanel`'s coverage-highlight
    checkbox (`RelationDiagramPanel.ts:92`), and every legend row's
    show/hide checkbox (`filteredDiagramShell.ts:49`,
    `DatabaseDiagramPanel.ts:252`) are all transient view configuration, not
    data at risk of loss — the identical reasoning `recordViewControls.ts`'s
    fix already applies to a quick-search term — so each now calls
    `markClean()` on itself at the end of its own `"change"` handler.
    `SequenceInfoPanel` is a different shape of the same underlying bug: it
    already had its own hand-rolled `_baseline`-diff dirty tracking (driving
    its Save button correctly, `SequenceInfoPanel.ts:301-303`) entirely
    independent of the library's per-widget `AbstractInput.isDirty()`, which
    nothing ever reset — so a `Checkbox`'s `setValue` (unlike a `ComboBox`'s)
    dirties it even when called programmatically, meaning
    `seedFields`'s `_cycleBox.setValue(detail.cycle)` alone left a
    CYCLE-enabled sequence's tab reading dirty from the moment it opened, with
    zero user interaction, and every other field stayed permanently dirty
    after any successful Save or Refresh reseed. Fixed with a
    `markFieldsClean()` sweep called once after the initial seed and once
    after every `reload()` reseed (`SequenceInfoPanel.ts`) — the same
    seed-then-`markClean()` order `DefinitionEditor.reload()` and this fix's
    sibling panels already use.

---

## Implementation Notes

- **Step 3 (`definitionEditor.ts`'s `reload()` `markClean()` call) needed no
  code change at all.** By the time this plan started, the batch's second
  plan, `definition-editor-dirty-state-adoption`, had already landed —
  `DefinitionEditor` no longer has `_baseline`/hand-rolled string-diff dirty
  tracking; `syncDirty` reads `CodeEditor.isDirty()` directly, and its
  rewritten `reload()` already calls `this.editor.markClean()` immediately
  after `setValue()`, exactly the line this plan's step 3 called for. This
  plan's own footnote ([^future-plan-independent]) anticipated exactly this
  outcome. Step 3's instruction to "leave `_baseline`/`syncDirty` untouched"
  is moot too — there is no `_baseline` left to touch.
- **Step 4 (`DocumentationPanel.ts`'s `"change"` handler) landed as planned**,
  adapted only to the post-`documentation-panel-toolbar-adoption` shape (the
  handler now lives inside `MarkdownDocumentPanel`'s subclass constructor as
  `this.on("change", ({ value }) => onChange(value));`, not the plan's
  now-superseded quoted snippet). The one-line `this.markClean()` addition
  itself is unchanged in substance from what the plan specified.
- **Step 1's library-freshness gate (the `readlink`/symlink-repoint/`build:lib`
  sequence) did not apply and was not run.** By the time this plan started,
  `frontend/package.json` already pinned `@jimka/typescript-ui` to `^0.9.0`
  (bumped by an earlier plan in this same batch) and `frontend/node_modules`
  was a plain symlink to the *main tree's* `frontend/node_modules` — a real,
  already-built `npm`-installed `0.9.0` package, not a checkout of the
  library's source needing `build:lib`. Verified directly instead: every API
  the plan cites (`Component.isDirty`/`markClean`, `Tab`'s `"beforetabclose"`,
  `Dock`'s `DockPanelEvent`/`"attach"`/`"move"`, `MarkdownDocumentPanel.markClean`)
  is present in `node_modules/@jimka/typescript-ui/dist/lib/types/`, matching
  the plan's citations exactly. This mirrors both sibling plans in this batch
  recording the identical drift (`plans/implemented/sql-editor-live-linting.md`
  and `plans/implemented/documentation-panel-toolbar-adoption.md`'s own
  Implementation Notes) — this plan's `## Non-Goals` "Bumping … past `^0.8.0`"
  entry is stale for the same reason (already at `^0.9.0`) and is left as
  historical record rather than edited.
- **A regression the audit found and this plan fixes, in two passes:
  `SqlAdminShell.ts`'s `confirmSignOut` now suppresses `installUnloadGuard`
  right before its own `window.location.reload()`.** A programmatic reload
  fires `"beforeunload"` exactly like a manual one; without the suppression,
  signing out with any dirty tab open would raise the browser's native "leave
  site?" prompt a second time — after the user had already answered "Sign
  out" — and declining it would leave the page up with a session `logout()`
  had already dropped server-side, 401-ing every subsequent request. Fixed
  with a small module-scoped `unloadGuardSuppressed` flag (mirroring
  `buildWorkArea`'s own `lastWidth` closure state in the same file). The
  first pass set the flag *before* `await logout()` rather than right before
  the reload it guards — a second audit round caught that a rejected
  `logout()` (a network failure) would then leave the flag permanently `true`
  for the rest of the session with no reload ever happening, silently
  disabling the guard entirely. Moved to set only after `logout()` settles,
  immediately before `window.location.reload()`.
- **Three findings from the `## Notes` footnotes, two fixed, one recorded
  as-is:** [^searchfield-leak] (fixed; noted here because the fix touches a
  file outside this plan's original "Files to Modify" table),
  [^diagram-and-sequence-leaks] (fixed; the same defect recurring across
  every `DiagramShell`-family panel and `SequenceInfoPanel`, both of which
  this plan's `## Architecture Decisions` had wrongly certified as needing no
  wiring — found only because a second audit round re-derived the claim
  instead of trusting the first round's), and [^float-fix] (partially fixed,
  on the second audit round — the first round had accepted the whole thing as
  an unfixable library limitation; the second round found the `beforeunload`
  blind spot was fixable with no library change, only tracking each open
  tab's content directly instead of relying on `dock.isDirty()`'s
  Component-tree fold, but — per a *third* audit round and the correction
  below — wrongly carried that same "fixed, no library change needed"
  verdict over to a second, distinct gap it had not actually examined: the
  floating window's own title-bar close button. That one is confirmed
  unfixable without a library change and is recorded as a deliberate,
  out-of-scope gap instead — see the entry below and `## Non-Goals`).
- **Manual verification**, driven live in a browser per
  `.claude/skills/verify/SKILL.md` (Postgres + native backend + `npm run dev`,
  logged in as `sqladmin`), across two rounds (the second after the audit's
  fixes). Cases confirmed passing: 1 (table cell edit, close → "Close tab"
  prompts; Cancel leaves the tab and edit in place), 2 (edit + Save + close →
  no prompt), 3 (view definition edit + Save + close → no prompt — confirms
  `definition-editor-dirty-state-adoption`'s already-landed `markClean()`
  fix), 4 (definition edit, no save, close → prompts), 5 (Notes edit, close →
  never prompts — confirms this plan's `DocumentationPanel` fix), 6 (unsaved
  scratch query, close → prompts), 10 (opened a Relation diagram — case 10's
  actual scenario, not driven in the first round — changed Depth then toggled
  "Hide with prune", closed the tab → no prompt, confirming
  [^diagram-and-sequence-leaks]'s diagram fix; a `reload, handleBeforeUnload:
  dismiss` with the same control changes proceeded with no native dialog too,
  confirming the fix reaches `hasUnsavedWork()` as well as the close guard),
  11 (dirty tab + `navigate_page reload, handleBeforeUnload: dismiss` → the
  tool reports "Dismissed a beforeunload dialog" and the page stays put with
  the edit intact; clean workspace + the same reload → proceeds with no
  dialog; re-run after [^float-fix] specifically to confirm
  `hasUnsavedWork()` still detects genuine dirty state, not just the false
  positives it now excludes), 12 (dragged "orders" onto "customers" to force
  a real `Tab`-region split via synthetic `mousedown`/`mousemove`/`mouseup` —
  the MCP `drag` tool's native HTML5 DnD does not trigger this library's
  mouse-threshold-based drag, so the split was driven by hand-dispatched
  `MouseEvent`s instead; edited the split-off `customers` tab and closed it
  from its new region → still prompts, confirming the `"attach"`/`"move"`
  region-discovery wiring), and the sign-out regression fix, re-verified
  after its ordering correction (Sign out with a dirty tab open → its own
  confirm dialog, Confirm → clean reload to the login page with no second,
  native "leave site?" prompt).

  The first round's own record conflated "10's quick-search variant" (a
  `TableWorkPanel` scenario, actually [^searchfield-leak]'s case) with case
  10 itself (a read-only detail tab or diagram) — corrected above; case 10's
  real scenario (a diagram) is what the second round actually drove, and it
  is also the scenario [^diagram-and-sequence-leaks] found broken.

  Not driven live, for time: case 7 (Save… on a scratch query still leaves it
  dirty), case 8 (a DDL draft prompts on close), case 9 (a successfully
  executed DDL draft closes via the unguarded `dock.removePanel` path, no
  prompt), and case 13 (a bulk-close stacks one prompt per dirty tab). Each
  reads the same `content.isDirty()` / `dock.removePanel` mechanism already
  exercised live above, with no code path specific to those cases left
  unverified by the ones that were driven. `SequenceInfoPanel`'s own fix
  ([^diagram-and-sequence-leaks]) was verified by reading its dirty-tracking
  code directly (the `Checkbox.setValue` semantics that caused it, confirmed
  against the library's source), not by opening a CYCLE-enabled sequence's
  tab live.
- **Two more leaks found on a third audit round, both fixed the same way as
  the ones above: `IndexInfoPanel.reload()` ([^indexinfo-reload-leak]) and
  `QueryResultChart`'s `xCombo`/`yCombo` ([^chart-combo-leak]).** Both are
  one-line-per-widget `markClean()` additions, following the established
  seed-then-`markClean()` shape `DefinitionEditor.reload()`,
  `DocumentationPanel`'s autosave, `recordViewControls.ts`'s quick search, and
  `DiagramShell`'s controls all already use — no new pattern introduced.
- **Deliberate scope narrowing, made after this third audit round and
  explicit user review: closing a torn-off floating window via its own
  title-bar close button is a known, out-of-scope gap, not a fix.** The
  third round re-examined [^float-fix]'s claim that "this does not affect the
  close-tab guard, which was never affected in the first place" and found it
  conflated two different close paths: the tab-strip close inside a float
  (still correctly covered by `"beforetabclose"`'s `"attach"`/`"move"`
  discovery) and the float's own window-chrome ✕ (not covered by anything —
  confirmed by reading `Dock.ts:1646-1656`'s `onFloatClosed`, which tears
  down every frame in the float unconditionally, and
  `AbstractWindow.ts:108,927`, which shows `WindowEvent` has no vetoable
  `"beforeclose"` for `onFloatClosed` to have hooked in the first place). The
  user reviewed this finding and directed that it be documented as an
  accepted gap rather than attempted as an app-side fix — fixing it needs a
  new vetoable close event on `AbstractWindow`/`Dock`, a library-level
  feature, not something an app-side plan can add. [^float-fix] is corrected
  above, and `## Non-Goals` now states the gap explicitly.
