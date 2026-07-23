---
depends-on: [tab-lazy-layout-constraint]
---

# Tab-First Loading Sequence — Implementation Plan

## Overview

Every asynchronous "open" on the controller fetches its data **before** it creates a tab. `openStructure` awaits `getColumns` + `getStructure` and only then calls `dock.addPanel` ([frontend/src/SqlAdminController.ts:611](frontend/src/SqlAdminController.ts#L611)); `openDatabaseDiagram` awaits an `O(schemas × tables)` fan-out first ([SqlAdminController.ts:1538](frontend/src/SqlAdminController.ts#L1538)). Against a real company database that means the user clicks, nothing appears for seconds, and then a finished tab pops in. Even `openTable`, which already uses `dock.addLazyPanel`, awaits two network round trips first ([SqlAdminController.ts:406](frontend/src/SqlAdminController.ts#L406)) — the "lazy" there only defers building the grid, not fetching the data.

This plan inverts that order for all fourteen async opens. Each one registers its Dock tab **first**, handing the Dock an **async factory** that performs the fetch and returns the built panel. The library owns the whole pending window: it mounts a spinner when the tab is activated, holds it until the factory's promise settles, swaps the built panel in on success, and on failure tears the tab down and reports the error as an event. SQLAdmin writes no spinner, no placeholder component, and no in-flight bookkeeping.

**This plan cannot be implemented against the currently installed library.** It depends on the companion plan `tab-lazy-layout-constraint` in the typescript-ui repo, which is written but not implemented, and on three further `Dock` changes that plan does not yet cover (see `## Library Dependency and Sequencing`). SQLAdmin consumes `@jimka/typescript-ui` from the npm registry — there is no symlink and no workspace link — so the library work must be implemented, version-bumped, **and published** before any step here can begin.[^no-local-link]

---

## Library Dependency and Sequencing

`frontend/package.json` pins `"@jimka/typescript-ui": "^0.1.0"`, which currently resolves to the installed **0.1.1**. A caret range on a `0.x` version pins the minor, so `^0.1.0` will never pick up a `0.2.x` release. Four things must happen, in order, before step 1 of `## Ordered Implementation Steps`:

1. **The library plan `tab-lazy-layout-constraint` is implemented** in the typescript-ui repo — `ComponentFactory` widens to `() => Component | Promise<Component>`, `Tab` gains the `lazy` constraint and the `"exception"` event, and `closeEntry` learns to remove a live spinner.
2. **The three `Dock` gaps below are closed**, in the same library release. They are not in the library plan today and must be added to it.
3. **The library is version-bumped and published to npm** (expected `0.2.0` — the changes are additive, and a `0.x` line treats an additive change as a minor bump).
4. **`frontend/package.json` is changed** from `"@jimka/typescript-ui": "^0.1.0"` to `"@jimka/typescript-ui": "^0.2.0"` — matching whatever version step 3 actually published — and `npm install` is run so `frontend/package-lock.json` and `frontend/node_modules` carry it.

Until item 4 lands, `npm run typecheck` in `frontend/` rejects every async factory this plan writes, because the installed `DockPanelSpec.content` is typed `Component | (() => Component)` with no promise in it (`frontend/node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts:12`).

### The three `Dock` gaps to raise against the library plan

`Dock.addLazyPanel` **is** the right entry point: it registers the panel, docks its identity frame, and activates it immediately, which is what makes the tab and its spinner appear in the same tick. But it cannot carry an async factory or report a failure as things stand.[^dock-entry-point]

| # | Gap | What the library plan must add |
| --- | --- | --- |
| A | `DockPanelSpec.content` is `Component \| (() => Component)` and `Dock._lazyFactories` is `Map<string, () => Component>` (Dock.ts lines 45 and 195 in the library repo) | Widen both to `ComponentFactory`, and let `resolvePanel`'s eager branch pass the factory to `frame.addComponent` so the core promise guard applies instead of a second hand-written one |
| B | `Tab`'s `"exception"` fires on the frame-internal `Tab` created inside `resolvePanel` (Dock.ts:568), which no consumer can reach; and that `Tab`'s teardown closes only its own inner entry, leaving the identity frame docked as an empty tab | `Dock` subscribes to the frame `Tab`'s `"exception"`, calls its own `removePanel(id)`, then emits a Dock-level `"exception"` carrying `{ id, error }`. Needs a new `DockEvent` member, a payload interface, an `on`/`emit` overload, and a `listeners.exception` key on `DockOptions` |
| C | `Animation.materialize` checks `isStale` only on the success path; its `fail` path calls `onError` unconditionally | Check `isStale` in `fail` too, so a factory that rejects after the user already closed the tab reports nothing |

Gap C is what makes this plan's close-during-flight handling free on the app side; see the no-bookkeeping decision below.

---

## Architecture Decisions

### Each `open*` method hands `dock.addLazyPanel` an async factory

The controller registers the tab with its title, glyph and tooltip, and passes the fetch as the panel's `content` factory. The library runs that factory behind its own spinner and attaches the returned panel. No app-owned loading component exists.[^no-loading-panel]

This is the library's documented answer to "the content cannot be built until a fetch completes" — case 3 of the *Which loading affordance* table in the companion library plan. Following it is the whole point of this revision.

### One helper wraps the pattern: `openAsyncPanel`

All fourteen call sites go through a single private controller method that registers the tab, wraps the caller's `build` closure so a rejection carries the object being opened, and writes the loading line to the status bar. Each call site becomes one call with a spec object and an `async` closure.

The status-bar line mirrors `QueryPanel.showDiagram`'s `notify("Building the plan diagram…")` ([frontend/src/dock/QueryPanel.ts:518](frontend/src/dock/QueryPanel.ts#L518)) — the app's established channel for async progress.

### A failure reaches `notifyError` through the Dock's `"exception"` event

The library closes the failed tab and emits `"exception"`. SQLAdmin subscribes once, in the controller constructor beside the existing `dock.on("close", …)` handler ([SqlAdminController.ts:278](frontend/src/SqlAdminController.ts#L278)), and routes the error into the unchanged `notifyError` ([SqlAdminController.ts:2616](frontend/src/SqlAdminController.ts#L2616)). The user-visible end state is what it is today: an error notification, and no tab left behind.

The event payload is `{ id, error }` — it does not carry the `DbObjectRef` that `notifyError` uses to prefix the message with the object's name. So `openAsyncPanel` wraps a rejection in a `PanelLoadError` carrying that ref, and the handler unwraps it.[^why-wrapper-not-map]

### Eight of the fourteen already reported their error; `PanelLoadError.reported` says so

Six methods catch their own fetch failure and call `notifyError` directly; eight fetch through a helper (`buildSchemaGraphData`, `buildDatabaseGraphData`, `fetchDependencyGraph`, `fetchInheritanceGraph`, `fetchRoleDetail`) that already calls `notifyError` and returns `null`. Both shapes must end with the tab closed, and neither may report twice.

`PanelLoadError` carries a `reported` flag. The `"exception"` handler calls `notifyError` only when that flag is `false`.

| Current shape | Rows | What the factory does | Notifications |
| --- | --- | --- | --- |
| `try { … } catch (err) { this.notifyError(err, ref); return; }` | 1, 2, 4, 5, 13 | lets the error escape; `openAsyncPanel` wraps it with `reported: false` | 1, from the `"exception"` handler |
| `Promise.allSettled` + `if (rejected) { notifyError(reason); return; }` | 3 | `throw detailResult.reason` | 1, from the `"exception"` handler |
| `const d = await this.fetchX(); if (!d) { return; }` | 6–12, 14 | `throw new PanelLoadError(null, ref, true)` | 1, from the helper that already reported |

### `store.load()` is not awaited inside the factory

`openTable`'s factory returns its `TableWorkPanel` as soon as the panel exists, and starts `store.load()` without awaiting it. Awaiting it would hold the library spinner until the rows arrive, and would turn a row-load failure into a closed tab.[^store-load-not-awaited]

Once the panel exists, the *other* library loading affordance takes over: `TablePanel` overlays its own spinner off the store's `loadingchange` event, with no app wiring.

### No app-side in-flight bookkeeping

The controller keeps no map of pending tabs and no identity guard. There is nothing for the app to discard — the built panel is never handed to the app — and the library covers both halves of the close-during-flight race itself: `isStale` drops a resolved component whose entry is gone, and gap C above drops the report for a rejection whose entry is gone.[^guard-removed]

### Registering first also fixes a double-open race

Because the panel id is registered with the Dock before the first `await`, a second click during the load hits `this.dock.focusPanel(id)` and returns. Today both clicks pass the dedup check and both call `addPanel` with the same id.

| User action on a slow table | Today | After |
| --- | --- | --- |
| Click once | blank UI for the fetch, then a finished tab | tab + spinner at once, content swaps in |
| Click twice quickly | two fetches, two `addPanel` calls, same id | one fetch; the second click focuses the spinning tab |
| Click, then close the tab mid-fetch | tab appears anyway when the fetch lands | nothing reappears; nothing is reported |
| Fetch fails | error notification, no tab | tab + spinner, then error notification and the tab closes |

---

## Public API

```typescript
// frontend/src/SqlAdminController.ts — one new module-level class

/**
 * A panel-load failure, carrying the object being opened so the Dock's
 * "exception" handler can name it, and whether the error was already
 * surfaced by the fetch helper that produced it.
 */
class PanelLoadError extends Error {
    constructor(
        readonly reason: unknown,
        readonly ref?: DbObjectRef,
        readonly reported: boolean = false,
    );
}
```

```typescript
// frontend/src/SqlAdminController.ts — one new private member

/**
 * Register a work-area tab whose content is fetched: the tab appears at once
 * with the library's spinner, `build` runs behind it, and the built panel
 * replaces the spinner. A rejection closes the tab and reaches the Dock
 * "exception" handler, which reports it through notifyError.
 */
private openAsyncPanel(
    spec: { id: string; title: string; glyph: string; tooltip?: string; ref?: DbObjectRef },
    build: () => Promise<Component>,
): void;
```

The library surface this consumes, as the companion plan plus its gap list define it:

```typescript
// @jimka/typescript-ui/overlay — after the library release

export interface DockPanelSpec {
    content: Component | ComponentFactory;   // ComponentFactory = () => Component | Promise<Component>
}

export interface DockExceptionEvent {
    id:    string;
    error: unknown;
}

class Dock {
    addLazyPanel(spec: DockPanelSpec): this;
    on(event: "exception", listener: (event: DockExceptionEvent) => void): this;
}
```

---

## Internal Structure

`PanelLoadError` and the helper:

```typescript
class PanelLoadError extends Error {
    constructor(
        readonly reason: unknown,
        readonly ref?: DbObjectRef,
        readonly reported: boolean = false,
    ) {
        super("panel load failed");
    }
}

private openAsyncPanel(
    spec: { id: string; title: string; glyph: string; tooltip?: string; ref?: DbObjectRef },
    build: () => Promise<Component>,
): void {
    this.dock.addLazyPanel({
        id     : spec.id,
        title  : spec.title,
        glyph  : spec.glyph,
        tooltip: spec.tooltip,
        content: async () => {
            try {
                return await build();
            } catch (error) {
                // Already wrapped (a helper that reported and returned null):
                // pass it through so `reported` is not lost.
                if (error instanceof PanelLoadError) {
                    throw error;
                }

                // Re-thrown so the library tears the tab down; the wrapper
                // carries the ref so the "exception" handler can name it.
                throw new PanelLoadError(error, spec.ref);
            }
        },
    });

    this.statusBar.setMessage(`${this._statusScope} · ${spec.title}: loading…`);
}
```

The constructor subscription, placed directly after the existing `dock.on("close", …)` block:

```typescript
// A deferred panel whose fetch rejected: the Dock has already closed the tab,
// so all that is left is reporting. A PanelLoadError raised by a helper that
// already called notifyError is swallowed, to avoid a second notification.
this.dock.on("exception", (e: DockExceptionEvent) => {
    if (e.error instanceof PanelLoadError) {
        if (!e.error.reported) {
            this.notifyError(e.error.reason, e.error.ref);
        }

        return;
    }

    this.notifyError(e.error);
});
```

### The conversion shape

Every one of the fourteen methods becomes one `openAsyncPanel` call. Everything that used to run after the `await` — the `_openPanels.set`, the `syncToPanel`, the trailing `statusBar.setMessage` — moves **inside** the factory, after the data is in. `openStructure` before and after:

```typescript
// BEFORE (SqlAdminController.ts:611)
async openStructure(ref: DbObjectRef, node?: TreeNode): Promise<void> {
    const id = this.structurePanelId(ref);
    if (this.dock.focusPanel(id)) { return; }

    let columns: ColumnMeta[];
    let structure: TableStructure;

    try {
        [columns, structure] = await Promise.all([getColumns(ref), getStructure(ref)]);
    } catch (err) {
        this.notifyError(err, ref);
        return;
    }

    this._openPanels.set(id, { ref, node: node ?? null, columns, detail: "structure" });
    this.dock.addPanel({ id, title: `${ref.name ?? id} (structure)`, glyph: "table-columns",
                         tooltip: this.panelTooltip(ref), content: new StructurePanel(/* … */) });
    this.syncToPanel(id);
}
```

```typescript
// AFTER
async openStructure(ref: DbObjectRef, node?: TreeNode): Promise<void> {
    const id = this.structurePanelId(ref);
    if (this.dock.focusPanel(id)) { return; }

    this.openAsyncPanel({
        id,
        title  : `${ref.name ?? id} (structure)`,
        glyph  : "table-columns",
        tooltip: this.panelTooltip(ref),
        ref,
    }, async () => {
        // The fetch now runs behind the library's spinner. A throw here closes
        // the tab and reaches the "exception" handler — so no local catch.
        const [columns, structure] = await Promise.all([getColumns(ref), getStructure(ref)]);

        this._openPanels.set(id, { ref, node: node ?? null, columns, detail: "structure" });
        this.syncToPanel(id);

        return new StructurePanel(/* … unchanged … */);
    });
}
```

Each converted method keeps its `async` signature and its `Promise<void>` return, so no caller changes, even though the method itself no longer awaits anything.

### The fourteen call sites

Each row is one edit of the shape above. `title`, `glyph` and `tooltip` are lifted verbatim from that method's current `addPanel` call — do not reword them. `ref` is the method's own `ref` parameter, except rows 13 and 14, which have none (they take a role `name`; omit the spec's `ref` field there).

| # | Method (line) | `id` from | `title` | `glyph` | `tooltip` | Failure shape today | Factory failure line |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `openTable` (357) | `panelId` | `ref.name ?? id` | `KIND_GLYPH[ref.kind]` | `panelTooltip(ref)` | local `catch` | let it throw |
| 2 | `openDefinition` (440) | `definitionPanelId` | `` `${ref.name ?? id} (definition)` `` | `"file-code"` | `panelTooltip(ref)` | local `catch` | let it throw |
| 3 | `openSequence` (561) | `sequenceInfoPanelId` | `ref.name ?? id` | `"arrow-up-1-9"` | `panelTooltip(ref)` | `detailResult.status === "rejected"` | `throw detailResult.reason` |
| 4 | `openStructure` (611) | `structurePanelId` | `` `${ref.name ?? id} (structure)` `` | `"table-columns"` | `panelTooltip(ref)` | local `catch` | let it throw |
| 5 | `openFunctionDefinition` (1143) | `functionDefinitionPanelId` | `` `${ref.name ?? id}(${signature}) (definition)` `` | `"file-code"` | `panelTooltip(ref)` | local `catch` | let it throw |
| 6 | `openSchemaDiagram` (1456) | `diagramPanelId` | `` `${ref.schema} (diagram)` `` | `"diagram-project"` | — | `!data` | `throw new PanelLoadError(null, ref, true)` |
| 7 | `openDatabaseDiagram` (1538) | `databaseDiagramPanelId` | `` `${ref.database} (diagram)` `` | `"diagram-project"` | — | `!schemas` | `throw new PanelLoadError(null, ref, true)` |
| 8 | `openRelationDiagram` (1611) | `relationDiagramPanelId` | `` `${ref.name} (relations)` `` | `"diagram-project"` | `panelTooltip(ref)` | `!full` | `throw new PanelLoadError(null, ref, true)` |
| 9 | `openSchemaDependencyGraph` (1696) | `dependencyPanelId` | `` `${ref.schema} (dependencies)` `` | `"diagram-project"` | — | `!data` | `throw new PanelLoadError(null, ref, true)` |
| 10 | `openRelationDependencyGraph` (1734) | `relationDependencyPanelId` | `` `${ref.name} (dependencies)` `` | `"diagram-project"` | `panelTooltip(ref)` | `!full` | `throw new PanelLoadError(null, ref, true)` |
| 11 | `openSchemaInheritanceGraph` (1780) | `inheritancePanelId` | `` `${ref.schema} (inheritance)` `` | `"diagram-project"` | — | `!data` | `throw new PanelLoadError(null, ref, true)` |
| 12 | `openRelationInheritanceGraph` (1819) | `relationInheritancePanelId` | `` `${ref.name} (inheritance)` `` | `"diagram-project"` | `panelTooltip(ref)` | `!full` | `throw new PanelLoadError(null, ref, true)` |
| 13 | `openRoleMembershipDiagram` (2480) | `roleMembershipDiagramPanelId` | `` `${name} (membership)` `` | `"diagram-project"` | — | local `catch` | let it throw |
| 14 | `openRoleGrantsDiagram` (2517) | `roleGrantsDiagramPanelId` | `` `${name} (grants graph)` `` | `"diagram-project"` | — | `!detail` | `throw new PanelLoadError(null, undefined, true)` |

Rows 6–12 and 14 fetch through helpers that already call `notifyError` and return `null`. Their factory must **not** call `notifyError` again — it throws a `PanelLoadError` with `reported: true`, which the `"exception"` handler swallows:

```typescript
const data = await this.fetchDependencyGraph(ref);

if (!data) {
    // The helper already reported. Throwing closes the tab without a second toast.
    throw new PanelLoadError(null, ref, true);
}
```

Row 1, `openTable`, has three extras:

- Its view/materialized-view early return (which delegates to `openQuery`) stays above the `openAsyncPanel` call and is untouched.
- Its two `store.on(…)` wirings, its `_openPanels.set`, its `rememberTable(ref, node)` call and its `notify` closure all move inside the factory, before the `TableWorkPanel` is constructed.
- Its trailing `await store.load()` becomes a non-awaited call inside the factory, after the panel is constructed and before the `return`:

```typescript
// Not awaited: the panel already exists, so TablePanel's own store-driven
// spinner covers the row load, and load()'s rejection is already surfaced by
// the "exception" listener wired above.
void store.load().then(() => this.syncToPanel(id)).catch(() => {});

return panel;
```

---

## Ordered Implementation Steps

**Do not start until all four items in `## Library Dependency and Sequencing` are done.** Step 1 is the check that they are.

1. **Confirm the library release is in place.** `grep -n '"@jimka/typescript-ui"' frontend/package.json` shows the new range, and `grep -n "content" frontend/node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts` shows `content: Component | ComponentFactory;`. If either check fails, stop — nothing below can compile.
   - Check: `grep -n "exception" frontend/node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts` — the Dock `"exception"` event is present.

2. **`frontend/src/SqlAdminController.ts`** — add the module-level `PanelLoadError` class from `## Internal Structure`, placed below the file's other module-level declarations and above the controller class. Give it the JSDoc from `## Public API`.

3. **`frontend/src/SqlAdminController.ts`** — import `DockExceptionEvent` from `@jimka/typescript-ui/overlay`, alongside the existing `DockPanelEvent` import, matching the file's right-aligned `from` column.

4. **`frontend/src/SqlAdminController.ts`** — add the `dock.on("exception", …)` subscription from `## Internal Structure` in the constructor, directly after the existing `dock.on("close", …)` block ([line 278](frontend/src/SqlAdminController.ts#L278)).

5. **`frontend/src/SqlAdminController.ts`** — add `openAsyncPanel` exactly as in `## Internal Structure`, placed next to `disposePanel` ([line 2727](frontend/src/SqlAdminController.ts#L2727)). Give it the JSDoc from `## Public API`.

6. **`frontend/src/SqlAdminController.ts`** — convert `openTable` ([line 357](frontend/src/SqlAdminController.ts#L357)) per row 1 of the call-site table plus the three extras listed under it. Its existing `dock.addLazyPanel` call is replaced by the `openAsyncPanel` call.

7. **`frontend/src/SqlAdminController.ts`** — convert rows 2–5 (`openDefinition`, `openSequence`, `openStructure`, `openFunctionDefinition`). In each, the `content:` expression currently inside `addPanel` becomes the factory's `return` value, unchanged.

8. **`frontend/src/SqlAdminController.ts`** — convert rows 6–12 (the schema/database/relation diagram and graph opens). Their failure branch is the `PanelLoadError(null, ref, true)` throw — **do not add a `notifyError` call**. Their trailing `statusBar.setMessage(...)` line moves inside the factory, before the `return`.

9. **`frontend/src/SqlAdminController.ts`** — convert rows 13–14 (`openRoleMembershipDiagram`, `openRoleGrantsDiagram`). Neither has a `ref`; omit that spec field.
   - Check: `grep -c "this.dock.addPanel" frontend/src/SqlAdminController.ts` — expect **3**: the opens that stay synchronous (`openDocumentation`, `openRoleGrants`, `openQuery`). It is **16** before this plan.
   - Check: `grep -c "this.openAsyncPanel({" frontend/src/SqlAdminController.ts` — expect **14**, one per converted method.
   - Check: `grep -c "this.dock.addLazyPanel" frontend/src/SqlAdminController.ts` — expect **1**, the one inside `openAsyncPanel`.

10. **Update the doc comments** on each converted method to say the tab opens first and the content follows, and that a failed fetch closes the tab it opened. The existing sentences "A failed fetch surfaces through notifyError and no tab opens" on `openDefinition`, `openSequence` and `openFunctionDefinition` are now wrong — rewrite them.
    - Check: `grep -n "no tab opens" frontend/src/SqlAdminController.ts` — expect zero matches.

11. **`LIBRARY_NOTES.md`** — add a `✅` entry at the top recording that the deferred-content papercut was closed in the library: there was no way to register a Dock tab whose content arrives later, so a consumer that fetches before it can build had to hand-roll a placeholder panel; the library's async `ComponentFactory` plus the Dock `"exception"` event now cover it, and this app adopted them. Follow the file's existing entry shape (status legend, symptom, resolution).

12. **Run the verification pass** in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `frontend/package.json` (dependency range — see `## Library Dependency and Sequencing`) |
| Modify | `frontend/package-lock.json` (regenerated by `npm install`, never hand-edited) |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

**The SQLAdmin frontend has no test harness that can exercise any of this.** `frontend/vitest.config.ts` runs vitest with `environment: "node"` and states in its own header comment that "component/DOM behaviour is verified live, not here"; every file under `frontend/tests/` covers pure data helpers. `Dock` and all fourteen controller methods are DOM-bound, so **every case below is manual**, verified in a browser against a real database. No new test file is added — adding a jsdom environment purely for this change is out of scope (see `## Non-Goals`).

Cases 1–8 need a *slow* source. Use the database diagram on a wide database (case 3), which is the slowest open in the app. The three cases this design turns on are 1–2 (the fetch succeeds), 7–8 (the fetch fails) and 5 (the user closes the tab while the fetch is still in flight).

1. **Tab first.** Clicking a table in the navigator makes its tab appear in the work area within one frame, showing the library's centred spinner. The tab's title, glyph, and hover tooltip are already correct while the spinner shows.
2. **Content swaps in.** When the fetch completes the spinner is replaced by the finished panel in the same tab — the tab does not close and reopen, does not move position in the strip, and does not lose focus.
3. **The slowest open behaves the same.** Navigator → database → right-click → "Database diagram": tab + spinner immediately, diagram later.
4. **Status bar.** While loading, the status bar reads `<database> · <tab title>: loading…`. After the content lands it shows that method's existing message (row count for a data tab, `"… : dependencies (N relations)"` for a graph, and so on).
5. **Close mid-load.** Open a slow tab and click its ✕ while the spinner shows. Nothing reappears when the fetch finishes, the work area stays as the user left it, no error notification appears, and a window resize afterwards produces no phantom tab.
6. **Double click.** Double-click a slow table in the navigator. Exactly one tab opens and exactly one spinner shows.
7. **Failure of a directly-caught fetch.** Open a table, then stop the backend and open a *different* table (rows 1–5, 13). The tab appears with a spinner, then closes; exactly **one** error notification appears, prefixed with the object name, and the status bar shows the error. No empty tab is left behind, and the browser console shows no unhandled promise rejection.
8. **Failure of a `null`-returning fetch.** Same as case 7 via a diagram open (rows 6–12, 14 — e.g. the `fetchDependencyGraph` path): the tab closes and exactly **one** error notification appears, the one the helper already raised, not two.
9. **A row-load failure does not close the tab.** Open a table successfully, then break the backend and hit the grid's refresh. The tab stays open with its own store spinner and an error notification; it does not close.
10. **Every converted open still works.** Walk all fourteen: table data, view definition, sequence info, structure, function definition, schema diagram, database diagram, relation diagram, schema and relation dependency graphs, schema and relation inheritance graphs, role membership diagram, role grants diagram. Each ends in the same panel it produces today.
11. **Structure rebuild.** With a structure tab open, add a constraint (which calls `refreshStructure` → `dock.removePanel` then `openStructure`). The tab is replaced and ends up showing the refreshed structure, not a stuck spinner.
12. **Start page deck.** From an empty workspace, opening a slow tab hides the start page immediately (not after the fetch). If that load then fails, the start page comes back.
13. **Re-open dedup.** Closing a fully-loaded tab and opening the same object again produces a fresh spinner and a fresh load.

---

## Verification

- `cd frontend && npm run typecheck` — clean. This is the load-bearing check that the published library actually carries the widened `DockPanelSpec.content` and the Dock `"exception"` event.
- `cd frontend && npm run test` — the existing suite is untouched and still passes.
- `cd frontend && npm run build` — clean (`tsc --noEmit && vite build`).
- `grep -c "this.dock.addPanel" frontend/src/SqlAdminController.ts` — exactly 3.
- `grep -c "this.dock.addLazyPanel" frontend/src/SqlAdminController.ts` — exactly 1.
- `grep -c "this.openAsyncPanel({" frontend/src/SqlAdminController.ts` — exactly 14.
- `grep -n "no tab opens" frontend/src/SqlAdminController.ts` — zero matches.
- **Manual, against a real database.** `docker compose up`, sign in, then walk `## Expected Behaviour` cases 1–13. Cases 3, 5, 6, 7 and 8 are the ones that can only be judged live.

---

## Potential Challenges

- **The library release must land first.** Every step here fails to compile against 0.1.1. Step 1 exists to catch that before any editing starts.
- **The spinner freezes during a heavy panel build.** The factory constructs the panel synchronously after its fetch, so a very wide `TableWorkPanel` or a large diagram stops the spinner's animation while it constructs. That is the same stall today's code has after its fetch; it is not a regression. Leave it.
- **A fast load flashes the spinner.** On a local database some opens complete in well under a frame, so the spinner may appear for one paint. Accepted — a delay-before-showing timer is a `## Non-Goals`.
- **Two error notifications.** Rows 6–12 and 14 call fetch helpers that already reported the failure. Their factory must throw `PanelLoadError(…, reported: true)` and never call `notifyError`.
- **A `PanelLoadError` must not be double-wrapped.** `openAsyncPanel`'s `catch` re-throws an existing `PanelLoadError` unchanged; without that guard the `reported` flag is lost and rows 6–12 and 14 double-report.
- **`_openPanels` is now populated inside the factory, not before the tab exists.** During the load the Dock's `"focus"` event fires for a panel id that `syncToPanel` cannot find, so `syncToPanel` returns early — which is why each converted factory must call `this.syncToPanel(id)` itself, after its `_openPanels.set`.
- **Do not `await store.load()` in `openTable`'s factory.** Awaiting it holds the library spinner until the rows arrive and turns a row-load failure into a closed tab.
- **The `"exception"` handler must not close anything.** The Dock has already removed the panel by the time the event fires; calling `removePanel` again from the handler is redundant, and wrong if a fast re-open has re-used the id.

---

## Critical Files

- [frontend/src/SqlAdminController.ts:357–651, 1143–1215, 1456–1854, 2480–2539](frontend/src/SqlAdminController.ts#L357) — the fourteen methods being converted.
- [frontend/src/SqlAdminController.ts:275–294](frontend/src/SqlAdminController.ts#L275) — the Dock `"close"` and `"focus"` handlers, and where the `"exception"` subscription joins them.
- [frontend/src/SqlAdminController.ts:2610–2625](frontend/src/SqlAdminController.ts#L2610) — `notifyError`, unchanged, and the only error-reporting path this plan uses.
- [frontend/src/SqlAdminController.ts:406–419](frontend/src/SqlAdminController.ts#L406) — `openTable`'s existing `addLazyPanel` call and its trailing `store.load()`, the two pieces row 1 rearranges.
- `../typescript-ui/plans/tab-lazy-layout-constraint.md` — the companion library plan this one consumes. Read its `## Architecture Decisions` for the `"lazy" → "building" → "ready"` entry state machine and the `"exception"` contract.
- [frontend/src/dock/QueryPanel.ts:507–546](frontend/src/dock/QueryPanel.ts#L507) — `showDiagram` / `setBusy`: the app's established async-work status-bar pattern that `openAsyncPanel`'s loading line mirrors.
- [frontend/vitest.config.ts](frontend/vitest.config.ts) — the node-only, DOM-less test setup that makes this change manual-verify.
- [frontend/package.json](frontend/package.json) — the `^0.1.0` range that must be widened before anything here compiles.
- `frontend/node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts` — the installed Dock surface; check it after the library upgrade to confirm the widened `content` and the `"exception"` event arrived.

---

## Non-Goals

- **Implementing the library changes.** The companion plan `tab-lazy-layout-constraint`, plus the three Dock gaps listed above, are typescript-ui work. This plan consumes them and does not carry them.
- **An app-owned loading or placeholder component.** The library owns the spinner. SQLAdmin builds no loading shell of its own.
- **An in-tab error state with a Retry button.** A failed load closes its tab, exactly as today. Re-clicking the navigator node retries.[^no-error-state]
- **A delay before the spinner appears.** No debounce timer; a fast load may flash the spinner for a frame.
- **App-side in-flight bookkeeping.** No pending-tab map, no sequence counter, no identity guard — the library owns the close-during-flight race.
- **Deferring the content *build* as well as the fetch.** The factory constructs the panel synchronously once its data is in.
- **Changing the five `null`-returning fetch helpers to throw.** `fetchRoleDetail` also feeds the roles inspector ([SqlAdminController.ts:2450](frontend/src/SqlAdminController.ts#L2450)), so changing its contract is a separate change. The `reported` flag bridges the two shapes instead.
- **`openRoleGrants`.** It is already synchronous. Its perceived delay comes from `showRole`'s `fetchRoleDetail`, which also feeds the roles inspector — restructuring that is a separate change.
- **`openQuery` and `openDocumentation`.** Both build synchronously and already open instantly.
- **Adding a jsdom/browser test environment to `frontend/`.** A real change with its own design questions; it should not ride along here.
- **Fixing tab closing.** Checked and already correct: SQLAdmin never calls `removeComponent` on a `Tab`-managed container. `dock.removePanel` delegates to `Tab.closeTab` in the library, and `QueryPanel`'s result tabs call `tab.closeTab` directly ([QueryPanel.ts:272–277](frontend/src/dock/QueryPanel.ts#L272)). The other `removeComponent` calls in the app target form grid panels and a `Dialog`'s content area — none of them a `Tab`-managed container.

---

## Notes

[^no-local-link]: SQLAdmin consumes `@jimka/typescript-ui` from the npm registry. `frontend/node_modules/@jimka/typescript-ui` is an installed tarball, not a symlink to the typescript-ui checkout, and no npm workspace joins the two repos. So a library change built locally is invisible here: `npm run typecheck` reads the installed `dist/lib/types/**/*.d.ts`, which only changes when a new version is published and installed. An earlier draft of this plan claimed the whole change landed against the published 0.1.1 with no library dependency at all. That was true of the design it described — an app-owned spinner shell — and is false of this one, which is the point of the revision: the app stops hand-rolling a loading affordance and consumes the library's instead.

[^dock-entry-point]: Three routes from an `open*` method to `Tab`'s deferred path were checked against the library source, not assumed. **`dock.addPanel` with a factory** does not defer at all: the panel-resolution path runs the factory immediately and adds the result to a `Fit`-managed identity frame (Dock.ts:576–580), so an async factory would produce a promise where a `Component` is required. **Reaching the frame's `Tab` directly** is not possible: the resolution method is private, the frame `Tab` is a local variable, and `Dock` exposes no accessor for it. **`dock.addLazyPanel`** is the one that already routes to `Tab.addLazyTab` (Dock.ts:572) and already activates the panel on add so the spinner shows at once (Dock.ts:476) — which is why it is the entry point, and why the two type widenings and the event forwarding (gaps A and B) are the only things missing. All three line references are to the library repo's `packages/lib/src/typescript/lib/overlay/Dock.ts` as of this writing.

[^no-loading-panel]: An earlier draft of this plan introduced an app-owned loading panel — a `Container` holding a centred spinner, with a `setContent` that swapped in the finished panel — described as copying the library's own spinner-wrap recipe. It was rejected in review and is recorded here only so it is not re-proposed. It was a third copy of a recipe the library already owned twice, and it put a loading affordance inside an app; the library's own plan names that shape as the thing it exists to remove. The library plan was revised to close the gap instead, which is what this plan now consumes. The cost is the dependency described in `## Library Dependency and Sequencing`; the benefit is that SQLAdmin ships no spinner code, no placeholder component, and no swap logic.

[^why-wrapper-not-map]: `notifyError(error, ref)` prefixes its status line and its toast with `ref.name`, so the handler needs the `DbObjectRef` the failing `open*` method had. The Dock `"exception"` payload carries the panel id and the error, not a ref. Two ways to bridge that were weighed. **A controller map from panel id to ref**, populated at open time, was rejected on ordering: the library removes the panel *before* it emits `"exception"` (so a listener inspecting the strip sees the final state), which means the existing `dock.on("close", …)` handler runs first and would have to leave the map entry behind — turning the map into a structure that leaks one row per successfully-opened panel, since nothing signals a successful materialization. **Wrapping the error** has no such ordering coupling and no lifetime at all: the ref rides on the thrown value, which exists only while the rejection is in flight. It also carries the `reported` flag the eight helper-based rows need, which the map would have needed a parallel structure for.

[^store-load-not-awaited]: `openTable`'s factory has two waits, and only the first belongs to the tab. `getColumns` + `getTablePrivileges` must finish before a `TableWorkPanel` can be constructed at all — that is the pending window the library spinner covers. `store.load()` fetches the *rows*, which the panel displays and does not need in order to exist. Awaiting it would hold the tab spinner for the whole row fetch, and a row-load failure — a query timeout on a huge table, say — would reject the factory and close a tab whose grid was perfectly capable of showing an empty state plus an error toast. Not awaiting it hands the row wait to the affordance built for it: `TablePanel` overlays its own spinner off the store's `loadingchange` event, with no app wiring. The rejection is not dropped silently — the `store.on("exception", …)` listener wired a few lines above already routes it to `notifyError`; the trailing `.catch(() => {})` only stops `load()`'s re-throw from becoming an unhandled rejection.

[^guard-removed]: An earlier draft kept a `_loadingTabs` map from panel id to the pending shell, plus an identity check that discarded a result whose tab had been closed mid-flight. All of it is now redundant, for three separate reasons. The app never receives the built component — the factory returns it to the library — so there is nothing for the app to discard. The library's `isStale` check drops a resolved component whose entry is gone, and its `closeEntry` now removes a live spinner, so the phantom-tab failure the guard insured against is fixed at the source. And gap C above extends the same staleness check to the rejection path, which is the only remaining way a closed tab could still produce a user-visible effect. Keeping the map "belt and braces" would mean the app maintaining bookkeeping whose only reader is a condition that can no longer be true — and it would re-introduce the id-keyed lifetime problem described in the wrapper footnote. Nothing of it survives.

[^no-error-state]: An error surface inside the tab, carrying the message and a Retry button, is better UX and was considered. It is out of scope twice over: the library ships no error UI and no retry contract by design, so the app would be building the whole affordance itself; and it needs a decision about whether the in-tab error also notifies (double-reporting) or replaces the notification (losing the history entry that `notifyError`'s toast provides). Closing the tab keeps the observable end state identical to today's, so the change stays confined to the ordering and the loading state — the two things that were actually asked for.

---

## Implementation Notes

**Deviation from `## Library Dependency and Sequencing`, pre-cleared with the user before this run started.**

The plan calls for a strict four-step sequence before any code here could be
written: (1) implement the companion library plan `tab-lazy-layout-constraint`
in the typescript-ui repo, (2) close the three additional `Dock` gaps (A/B/C)
that plan didn't originally cover, (3) version-bump and **publish** the
library to npm (expected `0.2.0`), and (4) bump `frontend/package.json` to
`^0.2.0` and run `npm install` so `package-lock.json` and `node_modules`
carry the published release.

What actually happened:

- Steps 1–2 were done: `tab-lazy-layout-constraint` is implemented on
  typescript-ui's local `master` (`packages/lib/package.json` at `0.2.0`),
  and its built `dist/lib` carries the widened
  `DockPanelSpec.content: Component | ComponentFactory` and the Dock
  `"exception"` event — confirmed directly against
  `frontend/node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts`.
- Step 3 (**publish to npm**) was explicitly **not done**. `npm view
  @jimka/typescript-ui version` still returns `0.1.1` on the real registry.
  Publishing was intentionally skipped for this run — it is a real,
  user-visible, hard-to-reverse action (a released package version), and
  the user chose not to take it just to unblock this plan.
- Step 4 was done differently than written: `frontend/package.json`'s
  `"@jimka/typescript-ui"` range was hand-edited from `"^0.1.0"` to
  `"^0.2.0"` to reflect what the converted code actually requires, but
  **`npm install`/`npm ci` was deliberately not run**, and
  `frontend/package-lock.json` was left completely untouched. A real
  install would either fail outright (the registry has no `0.2.0` to
  satisfy the new range) or silently disturb the pre-existing local dev
  symlink at `frontend/node_modules/@jimka/typescript-ui` (which points at
  `/home/jika/typescript/typescript-ui/packages/lib`, not an npm-resolved
  install, and predates this run). `frontend/package-lock.json` is
  therefore **not** a modified file for this plan, contrary to the
  `## Files to Create / Modify / Delete` table below.

Why: the user was asked, before implementation began, to choose between (a)
actually publishing typescript-ui to npm first, (b) skipping this plan
entirely until a real publish happens, or (c) proceeding on the pre-existing
local dev symlink alone, without publishing. The user chose (c). Step 1 of
`## Ordered Implementation Steps` (confirm the library release is in place)
was re-run and treated as satisfied by the symlinked local build rather than
a registry-resolved install — the three `grep` checks against
`frontend/package.json` and the installed `.d.ts` all pass because the
symlink already exposes the `0.2.0` surface.

**Consequence for anyone building this branch:** because npm has not
actually published `0.2.0`, `frontend/node_modules/@jimka/typescript-ui`
only resolves to the widened Dock surface this code needs because of the
pre-existing local symlink to `/home/jika/typescript/typescript-ui/packages/lib`
on this machine. This branch is only buildable/typecheckable on a machine
that has that same local dev symlink in place (or after typescript-ui
0.2.0 is genuinely published and `frontend/package.json`/`package-lock.json`
are regenerated against it with a real `npm install`). A fresh `npm ci`/
`npm install` against the public registry, as it stands today, would fail
to resolve `^0.2.0`.
