---
touches-shared:
  - frontend/src/dock/QueryPanel.ts        # result-export & query-explain plans also touch this
  - frontend/src/SqlAdminController.ts      # shared mediator
  - frontend/src/shell/SqlAdminShell.ts     # shared menubar / work-area host
---

# Query Workspace — Implementation Plan

## Overview

The **query workspace** bundles four user requests plus two defensive extras into one coherent feature set around the SQL query panel: (1) per-connection **query history** (localStorage ring buffer), (2) **named saved queries** (same store), surfaced together in a new **"Queries" activity-bar view**; (3) a **menu restructure** — remove the dead File/Tools menus and add a **Query** menu (Query first, then View); (4) an **empty-workspace start page** shown when no dock panels are open; (5) **Ctrl+↑ / Ctrl+↓ history browsing** inside the Run-SQL editor; and (6) a **defensive row cap** on query results so a large result set cannot hit the library's known zero-render `MemoryStore` bug.

Everything lands in the standalone app workspace `/home/jika/typescript/sqladmin` (frontend at `frontend/src/`); **no `@jimka/typescript-ui` source is modified.** The feature composes already-published library pieces — `TextArea` keydown, `Dock.addPanel`, the activity-bar `ToolBar`+`Card` seam, `MenuBar`. The two shared touch-points are the existing [`QueryPanel`](frontend/src/dock/QueryPanel.ts#L62) (which gains the history keybindings, the row cap, and a history-record callback) and the mediator [`SqlAdminController`](frontend/src/SqlAdminController.ts#L172) (`openQuery` records history and drives the start-page toggle).

The design centres on **three pure, node-testable modules** — a history ring buffer, a saved-query store, and a per-panel history-navigation cursor — each taking a `Storage` abstraction so the offline vitest (node-only, no DOM) can red-green them without a browser `localStorage`.

---

## Architecture Decisions

### Query history and saved queries share ONE localStorage module and ONE activity-bar view

Both history and saved queries are per-connection lists of SQL persisted to `localStorage`, so they share a single storage module ([`frontend/src/data/queryStore.ts`](#), new) and a single **"Queries" activity-bar view** (`QueriesView`, a new `Card` page + one rail button, following the documented ActivityBar seam — [`SqlAdminShell.buildSidebar`](frontend/src/shell/SqlAdminShell.ts#L154) already registers views as `{ id, label, glyph, component }`, and [`tsui-sql-admin.md`](plans/implemented/tsui-sql-admin.md) names "one more rail button + one more Card page" as the extension point). The view has two sections: **Saved** (named queries) and **Recent** (history). Clicking any entry opens it in a **new** query panel (`controller.openQuery(sql)` — scratch panels are never deduped, [`SqlAdminController.ts:172`](frontend/src/SqlAdminController.ts#L172)).

**Recommendation: the activity-bar view, not a toolbar dropdown.** Justification: (a) it reuses the existing, documented `ActivityBar` seam (`RolesExplorerView` is the precedent — a second view already ships), so it costs one rail button + one deck page and disturbs nothing; (b) history and saved queries are *cross-panel* concerns (every panel writes history; any panel can open a saved query), so they belong to the shell, not to one QueryPanel's toolbar; (c) a per-panel toolbar dropdown would duplicate the surface in every query panel and complicate the QueryPanel factory. A toolbar dropdown is explicitly **rejected** to keep the QueryPanel toolbar minimal (Run / Clear only) and the surface single-sourced. The **menu** (`Query → Query History…`, `Query → Open Saved…`) is the keyboard/menu entry point to the same view (it selects/expands the Queries view), so there is exactly one surface.

### The storage layer is three pure modules over a `Storage` abstraction

`localStorage` is a DOM global absent from the node vitest environment ([`frontend/vitest.config.ts`](frontend/vitest.config.ts#L9) is `environment: "node"`). To keep the ring-buffer/saved/cursor logic red-green testable offline, the three modules take a **`Storage`-like** dependency (`getItem`/`setItem`, the subset used) rather than reaching for the global. Production wiring passes `window.localStorage`; tests pass a trivial in-memory fake (an object with a `Map`). This mirrors how [`api.test.ts`](frontend/src/data/api.test.ts#L10) already injects behaviour with `vi.stubGlobal("fetch", …)` — but injection-by-parameter is cleaner than stubbing a global here, because the ring-buffer/cursor logic is pure data, not I/O.

The three modules:

- **`QueryHistoryStore`** — a capped ring buffer of `HistoryEntry { sql, timestamp, ok, rowCount }`, keyed per connection. `record(entry)` de-dupes a consecutive identical `sql` (updates the existing head's timestamp/ok/rowCount rather than appending a duplicate), caps at `MAX_HISTORY` (drop oldest), and persists. `list()` returns newest-first.
- **`SavedQueryStore`** — a per-connection map of `SavedQuery { name, sql, savedAt }`. `save(name, sql)` upserts by name; `remove(name)`; `list()` returns by name. Name collisions overwrite (a "save as" over an existing name replaces it).
- **`HistoryCursor`** — a **pure** per-panel navigation cursor over a snapshot of history `sql` strings plus the user's in-progress draft (bash-style). `older()` walks toward older entries, `newer()` toward newer, and the *bottom of the stack is the live draft* (preserved, restored when the user returns past the newest history entry). This is a value object with no storage — the panel constructs it from `historyStore.list()` at first navigation.

### History records every *manually run* query, from the controller's run seam — backend persistence is a FUTURE seam

History is recorded when a query actually runs. The natural single choke point is the **QueryPanel's run handler** ([`QueryPanel.run`](frontend/src/dock/QueryPanel.ts#L152)), which already knows the SQL, the ok/error outcome, and the row count. The panel gets an injected `onRun(entry: HistoryEntry)` callback (alongside the existing `runQuery`/`notify`/`onError`), which the controller wires to `historyStore.record(entry)`. This keeps the storage dependency **out** of the panel (the panel stays a pure view over injected callbacks, matching its current `notify`/`onError` shape) and keeps the controller the only component that touches the store.

**Only manually-run queries are recorded** — the `autoRun` "Open as query" seed is *not* separately recorded on open (it records on its actual run like any other, so an auto-run generated `SELECT` does land in history; that is acceptable and matches "every manually-run query" since the run is real). Empty/whitespace SQL is never recorded (the run handler already no-ops on blank input).

**Backend-persisted history is a FUTURE seam, not built.** The `HistoryEntry` shape and the `QueryHistoryStore.record`/`list` interface are the seam: a later plan can back the same interface with an `api.ts` call instead of `localStorage` without touching the panel or controller. This plan builds only the localStorage implementation. Noted as a Non-Goal.

### Per-connection keying

Every stored list is namespaced by `connectionId` (today always `"default"` — [`SqlAdminController`](frontend/src/SqlAdminController.ts#L57)), the same multi-DB seam the whole app already carries ([`tsui-sql-admin.md` "Multi-database seam"](plans/implemented/tsui-sql-admin.md)). The localStorage keys are `sqladmin.history.<connectionId>` and `sqladmin.saved.<connectionId>`. The stores take the `connectionId` at construction; the controller builds one of each for its connection.

### Menu restructure — remove File & Tools, add Query (Query first, then View)

[`SqlAdminShell.buildMenuBar`](frontend/src/shell/SqlAdminShell.ts#L138) currently declares three menus: `File` (all items disabled/dead — `Close Tab`, `Exit`), `View` (`Toggle Sidebar`), and `Tools` (`Run SQL…`, wired to `onRunSql`). The restructure:

- **Remove `File`** entirely (dead disabled items).
- **Remove `Tools`**; move its `Run SQL…` into a new **`Query`** menu, relabelled **`New Query`**.
- **Menubar order: `Query`, then `View`** (Query first).
- **`Query` menu items:** `New Query` (the moved run action, with an accelerator hint), `Open Saved…`, `Query History…`, and a **placeholder note** that `Export results…` will be added by the separate result-export plan (leave the seam — a code comment or a disabled item; see below). `View → Toggle Sidebar` is kept unchanged.

`buildMenuBar` grows two callbacks (`onOpenSaved`, `onQueryHistory`) beside the existing `onToggleSidebar`/`onRunSql`; the shell passes controller methods that select/expand the Queries activity-bar view.

### The menu shortcut label is display-only — the accelerator must be wired by the app

**Critical library finding:** `MenuItemConfig.shortcut` is documented as *"Keyboard shortcut hint displayed on the right"* ([`MenuItem.ts:47`](../../typescript-ui/src/typescript/lib/component/container/MenuItem.ts#L47)) — the library renders it as a label but does **not** bind the key. So setting `shortcut: "Alt+N"` on the `New Query` item shows the hint but does nothing on its own. To make the accelerator functional the app installs a **document-level keydown listener** in the shell/bootstrap that maps the chord to `controller.openQuery()`.

**Chosen accelerator: `Alt+N` for "New Query".** The only existing app accelerator is the editor's `Ctrl/Cmd+Enter` ([`QueryPanel.ts:203`](frontend/src/dock/QueryPanel.ts#L203)); this plan additionally adds editor-scoped `Ctrl+↑/↓`. A global "new query" wants a chord the browser does not own and the editor does not consume. `Ctrl/Cmd+N` is a **browser-reserved** new-window shortcut (frequently not interceptable) — **rejected**. `Alt+N` is free (verified against the app's accelerator set: only `Ctrl/Cmd+Enter` and the editor `Ctrl+↑/↓` exist) and the plan's default; `Ctrl/Cmd+Shift+N` is the fallback if `Alt+N` clashes with menu mnemonics in practice. The hint string on the menu item reflects the chosen chord. The global listener fires the chord regardless of focus (New Query is a global action) and does not swallow plain typing.

### Empty-workspace start page — an app-rendered overlay, NOT a library Dock API

**Library investigation (the Dock empty-content question), read from real source:**

- The Dock exposes **no `emptyContent` / placeholder hook.** Its only empty-state surface is the *internal* `_emptyDropOverlay` ([`Dock.ts:193`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L193)) — a drag-drop **blue highlight** shown only during a tab drag over an empty dock ([`wireEmptyDropTarget`, `Dock.ts:236`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L236)); it is not consumer content and cannot host arbitrary components.
- After the last tab closes, the Dock **keeps a valid empty root region** (a `Container` carrying a `Tab` manager) — `pruneRegion` bails when `parent === this` ([`Dock.ts:965`–`977`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L965)), the fix logged in `LIBRARY_NOTES.md` ("Dock: addPanel crashed after the last tab was closed"). So the empty root region is a live `Tab`-managed container — **not** a bare hook to render app content into. Rendering an app placeholder *into* that region would fight the `Tab` layout manager (it manages tabbed frames, not a free child).
- The Dock emits **no "became empty" event.** `DockEvent` is `"attach" | "detach" | "moved" | "focus" | "close"` ([`Dock.ts:96`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L96)); `"close"` fires **per panel** on destruction. There is **no public panel-count/`isEmpty` method** — `_panels` is private; `getRootRegion()`/`getComponents()` always return the single root region ([`Dock.ts:356`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L356)), so `getComponents().length` is not a usable emptiness signal for a consumer.

**Decision: render the start page as an app-owned sibling layered in the shell's CENTER, toggled by an app-tracked open-panel count — no library dependency.** The controller already observes every open (`openTable`/`openStructure`/`openQuery`/`openRoleGrants` all call `addPanel`) and every close (the single `dock.on("close", …)` subscription, [`SqlAdminController.ts:66`](frontend/src/SqlAdminController.ts#L66)). It maintains an `_openPanelCount` and shows the start page when the count reaches 0, hides it when the first panel opens. The shell places the start page in a **`Card` deck** at CENTER alongside the Dock (`card.setVisibleComponentId("dock" | "start")`), since only one is ever shown at a time; the shell injects a small `setStartVisible(boolean)` handle into the controller (mirroring how `ActivityBar` injects a `SidebarSizer`).

**Flag as a NON-GOAL / possible future library improvement (NOT built here):** a Dock `setEmptyContent(component)` / `emptyContent` option and/or an `isEmpty()`/panel-count accessor + an `"empty"`/`"populated"` event would let a consumer register a placeholder without the app tracking counts and layering its own deck. This is a **library dependency to flag** (a separate typescript-ui plan), consistent with the plan brief. The app-side deck+count approach works today with zero library change, so it is what this plan builds; the library API is recorded as the cleaner eventual seam.

**Start-page content:** quick actions (**New Query** → `openQuery()`; **recent tables** → the last N `DbObjectRef`s opened, each re-opening via `openTable`; **saved queries** → top saved, opening via `openQuery(sql)`), **connection info** (the `connectionId`), and a few **keyboard hints** (`Ctrl/Cmd+Enter` run, `Ctrl+↑/↓` history, the New-Query chord). It is a plain composed `Panel` (labels + buttons), no new library primitives.

### Ctrl+↑ / Ctrl+↓ history browsing inside the editor — wired on the TextArea keydown surface

**Library finding (the TextArea/keydown-surface question), read from real source:** `TextInput.on("keydown", listener)` is a published typed shorthand over the native `keydown` DOM event ([`TextInput.ts:184`,`194`](../../typescript-ui/src/typescript/lib/component/input/TextInput.ts#L184)) — the QueryPanel **already uses it** for `Ctrl/Cmd+Enter` ([`QueryPanel.ts:202`](frontend/src/dock/QueryPanel.ts#L202)). So the history browsing wires onto the **same** `editor.on("keydown", …)` handler, no library change. (`TextArea` extends `TextInput`; `getValue`/`setValue` read/write the editor text — [`QueryPanel.ts:153`,`137`](frontend/src/dock/QueryPanel.ts#L153).)

**Behaviour (bash-style, per-panel cursor over the shared history):** with **Ctrl held**, `ArrowUp` recalls the **previous (older)** history entry into the editor; `ArrowDown` moves toward **newer**; the user's in-progress **draft is preserved as the bottom of the stack** and restored when arrowing down past the newest history entry. The cursor is **per-panel** (each QueryPanel owns its own `HistoryCursor`) but reads a **snapshot** of the shared history list (taken lazily at first navigation in that panel, so a panel navigates a stable list even as other panels append). The keydown handler: on `Ctrl+ArrowUp`/`Ctrl+ArrowDown`, `preventDefault()`, capture the live draft into the cursor on first entry, call `cursor.older()`/`cursor.newer()`, and `editor.setValue(result)`. Plain arrows (no Ctrl) are untouched (normal caret movement).

To feed the cursor a snapshot, the QueryPanel needs read access to history `list()` — injected as a `getHistory: () => string[]` callback (the controller binds it to `historyStore.list().map(e => e.sql)`), keeping the storage dependency out of the panel.

### Defensive row cap on query results

**Library finding (the row-cap motivation):** `LIBRARY_NOTES.md` records a **known open bug** — a large `MemoryStore.loadData` (~1500+ rows) renders **zero rows** in a `Table`. The QueryPanel loads a full result set into a fresh `MemoryStore` ([`QueryPanel.ts:184`](frontend/src/dock/QueryPanel.ts#L184)) with no cap, so a big query silently shows an empty grid. Since this plan owns the QueryPanel result path, it adds a **defensive cap**: when `result.rows.length > MAX_RESULT_ROWS`, load only the first `MAX_RESULT_ROWS` into the store and surface a clear **"showing first N of M — results truncated"** affordance (on the status line via `notify`, and/or a small banner above the grid). `MAX_RESULT_ROWS` is set safely below the bug threshold (e.g. **1000**). Full pagination is a **Non-Goal** (backlog).

This is a *rendering* cap only — the backend already returns the whole result (the query panel has no server-side pagination, a Non-Goal in [`query-panels.md`](plans/implemented/query-panels.md)); the cap prevents the client-side zero-render and tells the user the grid is partial.

---

## Public API

All additions are **app-internal** (external `sqladmin` workspace, not exported from any library barrel). No `@jimka/typescript-ui` API changes.

```typescript
// frontend/src/data/queryStore.ts — new: the localStorage layer (pure, injectable Storage)

/** A Storage-like sink; production passes window.localStorage, tests an in-memory fake. */
export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** One recorded query run. */
export interface HistoryEntry {
    sql: string;
    timestamp: number;   // Date.now() at run
    ok: boolean;         // did the run succeed
    rowCount: number;    // rows returned (0 for status/DDL statements or errors)
}

/** One named, saved query. */
export interface SavedQuery {
    name: string;
    sql: string;
    savedAt: number;
}

/** Per-connection capped ring buffer of run history (newest-first). */
export class QueryHistoryStore {
    constructor(connectionId: string, storage: KeyValueStore, max?: number); // max defaults to MAX_HISTORY
    record(entry: HistoryEntry): void;   // dedupe consecutive identical sql; cap; persist
    list(): HistoryEntry[];              // newest-first
    clear(): void;
}

/** Per-connection named-query store (upsert by name). */
export class SavedQueryStore {
    constructor(connectionId: string, storage: KeyValueStore);
    save(name: string, sql: string): void;   // upsert by name
    remove(name: string): void;
    get(name: string): SavedQuery | undefined;
    list(): SavedQuery[];                     // by name
}
```

```typescript
// frontend/src/data/historyCursor.ts — new: pure per-panel navigation cursor

/**
 * Bash-style history navigation over a fixed snapshot of past SQL plus the live
 * draft at the bottom of the stack. Construct from a newest-first list; older()
 * walks back in time, newer() forward, and the draft is restored past the newest.
 */
export class HistoryCursor {
    constructor(history: string[]);          // newest-first snapshot (draft not included)
    /** Enter navigation from the current draft (call once when the user starts browsing). */
    begin(draft: string): void;
    older(): string;   // previous (older) entry, or the oldest if already there
    newer(): string;   // next (newer) entry, or the draft when past the newest
    get active(): boolean;   // whether the cursor is currently navigating
}
```

```typescript
// frontend/src/dock/QueryPanel.ts — QueryPanelOptions grows injected callbacks
export interface QueryPanelOptions {
    runQuery: RunQuery;
    notify: Notify;
    onError: (error: unknown) => void;
    initialSql?: string;
    autoRun?: boolean;
    onRun?: (entry: HistoryEntry) => void;   // NEW: record a run in history
    getHistory?: () => string[];             // NEW: newest-first SQL snapshot for Ctrl+↑/↓
}
```

```typescript
// frontend/src/SqlAdminController.ts — new state + methods (no OpenPanel change)
class SqlAdminController {
    private readonly _history: QueryHistoryStore;
    private readonly _saved: SavedQueryStore;
    private _openPanelCount: number;                 // drives the start-page toggle
    private readonly _recentTables: DbObjectRef[];   // for the start page's "recent tables"

    // openQuery(seedSql?) — unchanged signature; now injects onRun/getHistory into QueryPanel,
    // increments _openPanelCount, hides the start page.
    openSavedQuery(name: string): void;              // open a saved query in a new panel
    showQueriesView(): void;                          // select/expand the Queries activity-bar view (menu entry point)
    setStartVisible?: (visible: boolean) => void;    // shell-injected start-page toggle handle
    // (the start-page toggle is driven privately by open/close bookkeeping)
}
```

```typescript
// frontend/src/shell/QueriesView.ts — new: the "Queries" activity-bar deck page
export function QueriesView(controller: SqlAdminController, id: string): Component;

// frontend/src/shell/StartPage.ts — new: the empty-workspace welcome surface
export function StartPage(controller: SqlAdminController): Component;
```

`SqlAdminShell.buildMenuBar` gains `onOpenSaved`/`onQueryHistory` params; the shell/bootstrap installs the global "New Query" accelerator (see steps).

---

## Internal Structure

### `QueryHistoryStore` (dedupe + cap)

Serialized as a JSON array under `sqladmin.history.<connectionId>`. `record(entry)`:

1. Read current list (parse JSON, default `[]`).
2. If the newest entry's `sql === entry.sql` (consecutive dupe), replace it in place (update `timestamp`/`ok`/`rowCount`) instead of appending.
3. Else prepend `entry`.
4. Truncate to `max` (`MAX_HISTORY`, e.g. 100), dropping the oldest.
5. Persist JSON.

`list()` returns the parsed array newest-first (stored newest-first). Storage parse guards against malformed JSON (returns `[]`).

### `HistoryCursor` (bash-style, draft-preserving)

State: `_snapshot: string[]` (newest→oldest), `_draft: string`, `_index: number` (−1 = on the draft, 0 = newest history, up to `length−1` = oldest), `_active: boolean`.

- `begin(draft)`: if not `_active`, capture `_draft = draft`, `_index = -1`, `_active = true`.
- `older()`: `_index = min(_index + 1, length - 1)`; return `_snapshot[_index]` (or the draft if the snapshot is empty).
- `newer()`: `_index = _index - 1`; if `_index < 0` return `_draft` (back to the live draft); else `_snapshot[_index]`.

Pure — no storage, no DOM. Unit-testable directly.

### QueryPanel wiring (additions to the existing factory)

- On a completed run, after `notify`, call `onRun?.({ sql, timestamp: Date.now(), ok, rowCount })` (ok/rowCount from the `QueryResult` or the catch). Blank runs still no-op (no record). Guard with the existing `runSeq` monotonic check so a superseded run does not record.
- Row cap in `showResult`: when `result.kind === "rows"` and `result.rows.length > MAX_RESULT_ROWS`, slice to the cap, build the store from the slice, and `notify(\`showing first ${cap} of ${result.rowCount} — results truncated\`)`. A small banner Component above the grid is optional; the status line is the minimum. Factor the slice as a pure `capRows(rows, max)` helper so it is unit-testable.
- Ctrl+↑/↓ in the existing `editor.on("keydown", …)`: on `ctrl/meta + ArrowUp` → `cursor.begin(editor.getValue()); editor.setValue(cursor.older())`; `ArrowDown` → `editor.setValue(cursor.newer())`. The cursor is created lazily from `getHistory?.() ?? []` on first navigation (a fresh snapshot each time the user *starts* a browse; reset when the user runs a query, since running ends the browse).

### Start-page toggle (controller)

Every `addPanel`-issuing method increments `_openPanelCount` and calls `setStartVisible?.(false)`; the `dock.on("close")` handler decrements and, at 0, calls `setStartVisible?.(true)`. The shell injects `setStartVisible` after building the CENTER `Card` deck (mirroring `ActivityBar.setSizer` — [`ActivityBar.ts:180`](frontend/src/shell/ActivityBar.ts#L180)).

### Menu restructure (`buildMenuBar`)

```typescript
MenuBar({
    menus: [
        { label: "Query", items: [
            { text: "New Query", shortcut: "Alt+N", action: onRunSql },
            { separator: true },
            { text: "Open Saved…",    action: onOpenSaved },
            { text: "Query History…", action: onQueryHistory },
            // Seam: "Export results…" added by the result-export plan.
        ] },
        { label: "View", items: [{ text: "Toggle Sidebar", action: onToggleSidebar }] },
    ],
});
```

---

## Ordered Implementation Steps

1. **`frontend/src/data/queryStore.ts`** — `KeyValueStore`, `HistoryEntry`, `SavedQuery`, `QueryHistoryStore`, `SavedQueryStore`. Verify: `tsc` clean.
2. **`frontend/src/data/queryStore.test.ts`** — ring buffer: cap drops oldest; consecutive-dupe collapses (updates head, no append); non-consecutive dupe appends; `list()` newest-first; malformed JSON → `[]`. Saved: upsert by name; `remove`; `get`; per-connection key isolation (two connections don't cross-read). Use an in-memory `KeyValueStore` fake. Verify: `vitest run` green.
3. **`frontend/src/data/historyCursor.ts`** — the pure `HistoryCursor`. Verify: `tsc` clean.
4. **`frontend/src/data/historyCursor.test.ts`** — `begin` captures the draft; `older()` walks back and clamps at oldest; `newer()` walks forward and returns the draft past the newest; empty history stays on the draft. Verify: `vitest run` green.
5. **`frontend/src/dock/QueryPanel.ts`** — add `onRun`/`getHistory` options; record a run entry in the run handler (behind the `runSeq` guard); add the `capRows` cap + truncation `notify` in `showResult`; extend the existing keydown handler with Ctrl+↑/↓ over a lazily-built `HistoryCursor`. Verify: `tsc` clean; existing behaviour (Run, Clear, Ctrl+Enter) unchanged.
6. **`frontend/src/SqlAdminController.ts`** — construct `_history`/`_saved` (pass `window.localStorage`); inject `onRun`/`getHistory` into `openQuery`'s `QueryPanel({…})`; add `openSavedQuery`/`showQueriesView` + the `setStartVisible` handle; add `_openPanelCount` + `_recentTables`, increment on every `addPanel`-issuing method and record the ref in `openTable`, decrement in the `"close"` handler, toggling the start page at the 0/1 boundary. Verify: `tsc` clean; `_openPanels` writers unchanged (query panels still never register).
7. **`frontend/src/shell/QueriesView.ts`** — the activity-bar deck page: a Saved section (list of saved queries → `openSavedQuery`) and a Recent section (history list → `openQuery(sql)`), rebuilt from the stores when the view is shown. Verify: `tsc` clean.
8. **`frontend/src/shell/StartPage.ts`** — the welcome surface: New Query button, recent tables, saved queries, connection info, keyboard hints. Verify: `tsc` clean.
9. **`frontend/src/shell/SqlAdminShell.ts`** — register the Queries view in `buildSidebar`; restructure `buildMenuBar` (drop File/Tools, add Query first then View, wire `onOpenSaved`/`onQueryHistory`); layer the start page over the Dock in `buildWorkArea` (a `Card` deck: dock vs start) and inject `setStartVisible` into the controller; install the global `Alt+N` → `openQuery()` keydown listener (shell or `SqlAdminApp` bootstrap). Verify: `tsc` clean.
10. **Regression greps:** `grep -n "File\|Tools" frontend/src/shell/SqlAdminShell.ts` — no File/Tools menu; `grep -rn "localStorage" frontend/src` — only the controller's store construction (panel/pure modules never touch the global); `grep -n "_openPanels" frontend/src/SqlAdminController.ts` — query panels still never register.
11. **Full check:** `npm run typecheck` (or `tsc`) + `vitest run` green; manual smoke per Verification.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/data/queryStore.ts` — history ring buffer + saved-query store |
| Create | `frontend/src/data/queryStore.test.ts` — pure-logic tests |
| Create | `frontend/src/data/historyCursor.ts` — pure navigation cursor |
| Create | `frontend/src/data/historyCursor.test.ts` — pure-logic tests |
| Create | `frontend/src/shell/QueriesView.ts` — the "Queries" activity-bar view |
| Create | `frontend/src/shell/StartPage.ts` — the empty-workspace start page |
| Modify | `frontend/src/dock/QueryPanel.ts` — `onRun`/`getHistory` wiring, Ctrl+↑/↓, row cap |
| Modify | `frontend/src/SqlAdminController.ts` — stores, panel-count/start-page, `openSavedQuery`/`showQueriesView`, recent tables |
| Modify | `frontend/src/shell/SqlAdminShell.ts` — menubar restructure, Queries view, start-page deck, global accelerator |

**No `@jimka/typescript-ui` source is created or modified.**

---

## Expected Behaviour

**`QueryHistoryStore` — unit-testable offline (in-memory `KeyValueStore`):**
- `record` of a new `sql` prepends it; `list()` is newest-first.
- A **consecutive** identical `sql` does **not** append — it updates the existing head's `timestamp`/`ok`/`rowCount`.
- A non-consecutive repeat (a different query ran between) appends normally.
- The buffer caps at `max`, dropping the **oldest** on overflow.
- Malformed/absent stored JSON yields an empty list (no throw).
- Two connection ids keep separate lists (no cross-read).

**`SavedQueryStore` — unit-testable offline:**
- `save(name, sql)` upserts; re-saving the same name overwrites (one entry).
- `remove`/`get`/`list` behave; per-connection isolation holds.

**`HistoryCursor` — unit-testable offline:**
- `begin(draft)` captures the draft; before `begin`, the cursor is inactive.
- `older()` returns successively older entries and clamps at the oldest.
- `newer()` returns successively newer entries and, past the newest, **restores the exact draft**.
- Empty history: `older()`/`newer()` stay on the draft.

**Row cap (`capRows`) — unit-testable offline:**
- `rows.length ≤ max` returns the rows unchanged.
- `rows.length > max` returns exactly the first `max` rows (the QueryPanel then emits the "first N of M" message; the grid render itself is manual-verify).

**Menu wiring — MANUAL-VERIFY (node vitest is DOM-less):**
- The menubar shows **Query then View**; no File, no Tools.
- `Query → New Query` opens a fresh empty query panel; `Alt+N` does the same; the shortcut hint reads the chosen chord.
- `Query → Open Saved…` / `Query → Query History…` open/select the Queries activity-bar view.
- `View → Toggle Sidebar` still collapses/expands the sidebar.

**History recording + Ctrl+↑/↓ — MANUAL-VERIFY (DOM events, focus):**
- Running a query (Run button or Ctrl/Cmd+Enter) adds it to Recent; running the *same* query twice in a row leaves one Recent entry (deduped).
- In the editor, `Ctrl+ArrowUp` recalls the previous query; repeated presses walk older; `Ctrl+ArrowDown` walks newer and, past the newest, restores the in-progress draft.
- The cursor is per-panel: two open panels browse independently; a snapshot is taken when browsing starts.

**Queries view + start page — MANUAL-VERIFY (activity-bar UI, layout):**
- The Queries rail button shows a Saved section and a Recent section; clicking any entry opens it in a new panel.
- With **no** panels open, the start page shows (New Query, recent tables, saved queries, connection info, keyboard hints); opening any panel hides it; closing the last panel shows it again.

**Saved-query persistence — MANUAL-VERIFY (localStorage round-trip):**
- A saved query and recorded history survive a page reload (per-connection keys).

---

## Verification

- **Offline (`vitest run`):** `queryStore.test.ts`, `historyCursor.test.ts`, and the `capRows` test cover the ring buffer (cap/dedupe/serialize/per-connection), the saved store (upsert/remove/isolation), the cursor (older/newer/draft-preservation), and the row cap — the pure logic the plan factors out.
- **Typecheck:** `npm run typecheck` (or `tsc`) clean; every library import stays a published subpath (`grep -rn "@jimka/typescript-ui/" frontend/src` — no `~/`/`dist/lib/`).
- **Registry invariant:** `grep -n "_openPanels" frontend/src/SqlAdminController.ts` — query panels never register; `OpenPanel` unchanged.
- **Menu invariant:** `grep -n "File\|Tools" frontend/src/shell/SqlAdminShell.ts` — no File/Tools menu remains.
- **Manual smoke (`npm run dev`, exercise the shell):** the menubar order + New-Query accelerator; run a query and see it in Recent (dedupe on immediate repeat); Ctrl+↑/↓ recall + draft restore; the Queries view Saved/Recent sections open queries in new panels; the start page appears/disappears at the 0/1 panel boundary; a >`MAX_RESULT_ROWS` query shows the truncation message and a non-empty grid; reload persists saved + history.
- **Library repo:** untouched — no source change under `/home/jika/typescript/typescript-ui`.

---

## Potential Challenges

- **The menu shortcut is a label only** — the app must install the real accelerator; mitigate by wiring one document-level keydown listener in the shell/bootstrap and keeping the hint string in sync with it.
- **`Ctrl/Cmd+N` is browser-reserved** — using it risks a non-interceptable chord; mitigate by choosing `Alt+N` (verified non-colliding) and documenting the choice.
- **Large-result zero-render bug** is *worked around, not fixed* — the cap prevents the empty grid but truncates; mitigate with the explicit "showing first N of M" message so the user knows the grid is partial (full pagination is a Non-Goal).
- **Ctrl+↑/↓ vs. native caret movement** — plain arrows must stay untouched; mitigate by gating strictly on `ctrlKey || metaKey` and calling `preventDefault()` only on the chord.
- **Start-page deck vs. Dock layout** — layering must not perturb the Dock's sizing; mitigate by using a `Card` deck (one child shown at a time) so the Dock keeps the full CENTER when visible.
- **Snapshot staleness across panels** — a per-panel snapshot taken at browse-start means a panel won't see queries other panels ran mid-browse; this is intentional (bash-like stability) and documented.
- **The `TableWorkPanel`/QueryPanel touch-point is shared** — the result-export and query-explain plans also edit `QueryPanel.ts`; keep this plan's changes to the run handler / `showResult` / keydown surface so a later export button (a new toolbar action) merges cleanly.

---

## Critical Files

**Library (read for the composed surfaces — do NOT modify):**
- [`src/typescript/lib/overlay/Dock.ts`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts) — no `emptyContent` hook; kept empty root region ([`:965`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L965)); `DockEvent` union `"…|close"` ([`:96`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L96)); `addPanel`/`focusPanel`; no public panel-count.
- [`src/typescript/lib/component/input/TextInput.ts`](../../typescript-ui/src/typescript/lib/component/input/TextInput.ts) — the `on("keydown", …)` shorthand ([`:184`](../../typescript-ui/src/typescript/lib/component/input/TextInput.ts#L184)) the Ctrl+↑/↓ wiring uses.
- [`src/typescript/lib/component/container/MenuItem.ts`](../../typescript-ui/src/typescript/lib/component/container/MenuItem.ts) — `MenuItemConfig.shortcut` is a **display hint only** ([`:47`](../../typescript-ui/src/typescript/lib/component/container/MenuItem.ts#L47)); `MenuConfig`/`MenuItemConfig` shape.
- [`src/typescript/lib/component/menubar/MenuBar.ts`](../../typescript-ui/src/typescript/lib/component/menubar/MenuBar.ts) — `MenuBar({ menus })` / `setMenus`.

**App (mirror these patterns):**
- `frontend/src/dock/QueryPanel.ts` — the run handler, `MemoryStore` load, existing `on("keydown")` Ctrl+Enter, the injected-callback (`notify`/`onError`) shape the new callbacks follow.
- `frontend/src/SqlAdminController.ts` — `openQuery` ([`:172`](frontend/src/SqlAdminController.ts#L172)), the single `dock.on("close")` subscription ([`:66`](frontend/src/SqlAdminController.ts#L66)), `openTable` (recent-tables source), `notifyError`.
- `frontend/src/shell/SqlAdminShell.ts` — `buildMenuBar` ([`:138`](frontend/src/shell/SqlAdminShell.ts#L138)), `buildSidebar`'s view registration ([`:154`](frontend/src/shell/SqlAdminShell.ts#L154)), `buildWorkArea`'s CENTER Split ([`:67`](frontend/src/shell/SqlAdminShell.ts#L67)).
- `frontend/src/shell/ActivityBar.ts` — the `{ id, label, glyph, component }` view seam and the injected-`SidebarSizer` pattern ([`:180`](frontend/src/shell/ActivityBar.ts#L180)) the `setStartVisible` handle mirrors.
- `frontend/src/shell/RolesExplorerView.ts` — the precedent second activity-bar view to copy for `QueriesView`.
- `frontend/src/data/api.test.ts` — the dependency-injection test idiom the store/cursor tests follow.
- `frontend/vitest.config.ts` — node-only env (why the storage abstraction is injectable).
- [`plans/implemented/query-panels.md`](plans/implemented/query-panels.md) & [`plans/implemented/tsui-sql-admin.md`](plans/implemented/tsui-sql-admin.md) — the QueryPanel and shell/activity-bar architecture this plan extends.

---

## Non-Goals

- **Backend-persisted history** — history is localStorage-only; the `QueryHistoryStore` interface is the seam for a future backend-backed implementation, not built here.
- **A Dock `emptyContent`/placeholder API + `isEmpty()`/panel-count accessor + `"empty"` event** — the cleaner eventual library seam for the start page; **flagged as a separate typescript-ui plan (library dependency)**. This app plan renders the start page app-side (a `Card` deck toggled by an app-tracked panel count) with zero library change.
- **Full result pagination / streaming** — the row cap is a defensive render limit, not pagination; capping/streaming large results stays a backlog item (consistent with the query-panels plan's one-shot `MemoryStore` stance).
- **A per-QueryPanel toolbar history dropdown** — rejected in favour of the single Queries activity-bar view + menu; the panel toolbar stays Run/Clear only.
- **Rebinding / configurable accelerators** — one fixed chord (`Alt+N`) for New Query; no user keymap.
- **Export results** — the `Query` menu leaves a seam (a note/placeholder) for the separate result-export plan; export itself is out of scope here.
- **Fixing the library's large-`MemoryStore` zero-render bug** — worked around with the cap; the underlying library fix is out of scope (it stays a `LIBRARY_NOTES.md` open item).
