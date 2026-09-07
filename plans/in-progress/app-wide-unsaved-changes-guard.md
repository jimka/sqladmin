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
   ([lines 216-254](frontend/src/SqlAdminController.ts#L216)), onto every `Tab`
   region the Dock ever creates — including one a user creates by splitting or
   tearing off a tab — discovered lazily as panels attach or move.

Investigation found the automatic fold already works, with no app-side wiring,
for `TableWorkPanel`, `QueryPanel`, and `DdlFormPanel`. It found one real gap —
`DefinitionEditor.reload()` never accepts its reseeded text as the new clean
baseline — and one design choice needed for `DocumentationPanel`'s autosave. Both
are one-line fixes, covered below.

---

## Architecture Decisions

### `beforeunload` checks `controller.dock.isDirty()`, not the whole shell

The app's mount root is `SqlAdminShell`
([`SqlAdminApp.ts:47`](frontend/src/SqlAdminApp.ts#L47),
`Body.getInstance().addComponent(SqlAdminShell(controller))`), and folding through
it would also reach `controller.dock.isDirty()` automatically — `SqlAdminShell`'s
`workArea` adds the Dock as a descendant
([`SqlAdminShell.ts:312`](frontend/src/shell/SqlAdminShell.ts#L312)). The guard
checks the Dock directly instead of the shell.[^scope-to-dock]

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
([`SqlAdminShell.ts:438-445`](frontend/src/shell/SqlAdminShell.ts#L438)), removing a
saved query
([`queryWorkspace.ts:219-223`](frontend/src/controller/queryWorkspace.ts#L219)),
clearing saved connections
([`localStorageWindow.ts:177-182`](frontend/src/shell/localStorageWindow.ts#L177)) —
calls `Dialog.confirm(title, message)` and awaits the boolean. The close guard
follows the same shape: `await Dialog.confirm("Close tab", "This tab has unsaved
changes. Are you sure that you want to close it?")`.

### `DefinitionEditor.reload()` gets one added `markClean()` call — the only real wiring gap

`DefinitionEditor.editor` (a `CodeEditor`) is already a registered child of both
`DefinitionPanel.content` and `FunctionDefinitionPanel.content`
([`DefinitionPanel.ts:93,97`](frontend/src/dock/DefinitionPanel.ts#L93),
[`FunctionDefinitionPanel.ts:51`](frontend/src/dock/FunctionDefinitionPanel.ts#L51)),
so `editor.isDirty()` already bubbles up to `content.isDirty()` with zero wiring.
The gap is in the *value* the flag reports, not its registration:
`CodeEditor`'s dirty flag compares the live document against `_cleanValue`, which
only construction and `markClean()` ever update
([`CodeEditor.ts:597-629`](../../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L597)).
`DefinitionEditor.reload()`
([`definitionEditor.ts:101-105`](frontend/src/dock/definitionEditor.ts#L101)) calls
`setValue()` but never `markClean()`, so once a user edits and saves, the editor's
`isDirty()` would report `true` **forever** — a permanent false positive on every
`DefinitionPanel`/`FunctionDefinitionPanel` tab that has ever been saved. Add
`this.editor.markClean()` right after `setValue()`.[^future-plan-independent]

### `DocumentationPanel`'s autosaved edits also need a `markClean()` call

Notes persist synchronously to `localStorage` on every keystroke
([`notesStore.ts:45`](frontend/src/data/notesStore.ts#L45), no network round trip,
no pending state), so nothing is ever actually at risk of loss. But post-toolbar-
adoption, `DocumentationPanel extends MarkdownDocumentPanel` and never calls
`markClean()` either
([`documentation-panel-toolbar-adoption.md`](plans/documentation-panel-toolbar-adoption.md)'s
`## Internal Structure` and `## Non-Goals`, "`markClean()` … inherited but
unused") — so, unfixed, the Notes tab would read permanently dirty after the first
keystroke and trip both guards on every future session, for data that is never
actually unsaved. Add `this.markClean()` to the `"change"` handler, right after
`onChange(value)` — safe because `onChange` (`NotesStore.save`) is synchronous, so
the document is already durably persisted before `markClean()` runs.[^why-notes-fix-here]

### No change needed to `TableWorkPanel`, `QueryPanel`, or `DdlFormPanel`

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
  ([`QueryPanel.ts:240,303`](frontend/src/dock/QueryPanel.ts#L240)), and nothing
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
- Every read-only detail tab (`StructurePanel`, `IndexInfoPanel`,
  `SequenceInfoPanel`, `TypeInfoPanel`, `RoleGrantsPanel`, every diagram panel) has
  no editable component inside, so `isDirty()` is always `false` and the guard
  never fires for them — also with no wiring.

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
([`SqlAdminController.ts:245-254`](frontend/src/SqlAdminController.ts#L245)):

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
once from the constructor:

```ts
/**
 * Warns before a refresh, tab close, or navigate-away that would silently
 * drop unsynced work in an open Dock tab. Checks `controller.dock` alone,
 * not the whole shell, so an AbstractInput elsewhere in the shell (a
 * navigator search field, say) can never trigger it — see
 * plans/app-wide-unsaved-changes-guard.md's Architecture Decisions.
 *
 * @param controller - The mediator whose Dock's aggregate dirty state gates the prompt.
 */
function installUnloadGuard(controller: SqlAdminController): void {
    window.addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
        if (!controller.dock.isDirty()) {
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
   [line 254](frontend/src/SqlAdminController.ts#L254) and before the
   `this.statusBar.setMessage(...)` line that follows it.

7. **`frontend/src/shell/SqlAdminShell.ts` — `installUnloadGuard`.** Add the
   module-level function from `## Internal Structure` beside `installAccelerators`
   (after its closing brace, [around line 200](frontend/src/shell/SqlAdminShell.ts#L200)).
   Call `installUnloadGuard(controller);` right after the existing
   `installAccelerators(controller, sidebar);` call
   ([line 149](frontend/src/shell/SqlAdminShell.ts#L149)).

8. **Grep invariants**, from `frontend/`:
   - `grep -n "markClean" src/dock/definitionEditor.ts` — exactly one hit, inside `reload`.
   - `grep -n "this.markClean()" src/dock/DocumentationPanel.ts` — exactly one hit, inside the `"change"` handler.
   - `grep -n 'dock.on("attach"\|dock.on("move"' src/SqlAdminController.ts` — one hit each.
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
- [`plans/documentation-panel-toolbar-adoption.md`](plans/documentation-panel-toolbar-adoption.md) — the `depends-on` plan whose shape this plan's step 4 assumes.
- [`frontend/src/SqlAdminController.ts:180-254`](frontend/src/SqlAdminController.ts#L180) — the constructor and its existing `dock.on(...)` precedent this plan extends.
- [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts) — the mount root; `installAccelerators` (169-200) is the precedent `installUnloadGuard` mirrors.
- [`frontend/src/dock/TableWorkPanel.ts:102-235`](frontend/src/dock/TableWorkPanel.ts#L102), [`frontend/src/dock/QueryPanel.ts:230-310`](frontend/src/dock/QueryPanel.ts#L230), [`frontend/src/dock/DdlFormPanel.ts`](frontend/src/dock/DdlFormPanel.ts) — confirmed to need no change; read to verify, not to edit.
- [`../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts:2340-2404,6463-6511`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2340) — `isDirty`/`setDirty`/`onDirtyChange` and the `wireChild`/`unwireChild` fold.
- [`../../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts:1130-1245`](../../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1130) — `"beforetabclose"`'s emit site and `closeTab`'s unguarded programmatic path.
- [`../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts:140-231,447-474,680-771,1783-1797`](../../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L140) — `DockEvent`'s fixed event list, `addPanel`/`activeTabRegion`/`newTabRegion`, and `removePanel`.
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

---

## Notes

[^scope-to-dock]: `AbstractInput` subclasses also report `isDirty()` automatically
    (per the library's changelog), and nothing outside the Dock — a navigator
    search field, a properties-panel input — ever calls `markClean()` on them
    either. Checking the whole shell would make typing into any such field trip
    the "leave site?" prompt, for text the user never thought of as "unsaved
    work." Scoping to `controller.dock` avoids this for every field outside the
    Dock, present or future, without needing to enumerate them.

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
