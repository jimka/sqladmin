---
depends-on: [dialog-subclass-foundation]
touches-shared: [frontend/src/dock/TableWorkPanel.ts, frontend/src/dock/QueryResultView.ts, frontend/src/dock/QueryPanel.ts, frontend/src/dock/RoleGrantsPanel.ts, frontend/src/dock/DocumentationPanel.ts, frontend/src/dock/DefinitionPanel.ts]
---

# Query Workspace Toolbar Deduplication — Implementation Plan

## Overview

Three pieces of the data-table / query-workspace UI are written more than once,
and each set has already drifted.

A new `RecordViewControls` (`frontend/src/dock/recordViewControls.ts`) owns the
record-view toggle, its Previous / Next steppers, the quick-search field, and
all the grid wiring behind them. Today
[`TableWorkPanel.ts:177-391,465-491`](frontend/src/dock/TableWorkPanel.ts#L177)
and [`QueryResultView.ts:97-182`](frontend/src/dock/QueryResultView.ts#L97)
build that group and its `toggleRecordView` / `applyQuickSearch` /
`stepRecord` / `syncStepEnabled` quartet separately.
[`recordNavigation.ts`](frontend/src/dock/recordNavigation.ts) and
[`gridQuickSearch.ts`](frontend/src/dock/gridQuickSearch.ts) already own the
pure inner logic and stay exactly where they are; only the wiring around them
moves. While the two grids are being touched, both also adopt
[`columnsGrid.ts:122`](frontend/src/dock/columnsGrid.ts#L122)'s `readOnlyTable`
helper, which they and
[`RoleGrantsPanel.ts:50`](frontend/src/dock/RoleGrantsPanel.ts#L50) currently
bypass by re-typing its spec.

In `QueryPanel.ts`, two constructor-local helpers replace eight near-identical
bodies. `swapTab` owns the add-a-tab-then-remove-its-predecessor sequence that
[`showDiagramTab`](frontend/src/dock/QueryPanel.ts#L766),
[`refreshExistingDataTab`](frontend/src/dock/QueryPanel.ts#L1063),
[`showChart`](frontend/src/dock/QueryPanel.ts#L1111) and
[`showPlan`](frontend/src/dock/QueryPanel.ts#L1166) each run for themselves —
including the `refreshingTabs` flag they all raise around it, which stops the
momentarily-empty tab strip from hiding the result pane mid-swap.
`removeTab` owns the guard-remove-null that
[`QueryPanel.ts:381-412`](frontend/src/dock/QueryPanel.ts#L381)'s four
`remove*Tab` functions each repeat.

Four stale comments are corrected in passing:
[`QueryPanel.ts:5-25`](frontend/src/dock/QueryPanel.ts#L5) documents three
result tabs where four exist;
[`DocumentationPanel.ts:3-4`](frontend/src/dock/DocumentationPanel.ts#L3) calls
`DefinitionPanel`'s editor read-only, and it is editable; and
[`exportExplainResult.ts:7-9`](frontend/src/dock/exportExplainResult.ts#L7) and
[`exportQueryResult.ts:6-7`](frontend/src/dock/exportQueryResult.ts#L6) both
claim their module can only be checked by hand, while
[`tests/dock/exportExplainResult.test.ts`](frontend/tests/dock/exportExplainResult.test.ts)
already unit-tests that exact shape by mocking the one DOM call. Rather than
just deleting the last claim, this plan writes the tests it says are
impossible — for `exportQueryResult.ts` and for `exportRoleGrants.ts`, which
shares the shape and is likewise untested.

This plan runs after `dialog-subclass-foundation`, which rewrites a different
part of `QueryPanel.ts` — its error banner.[^after-banner]

---

## Architecture Decisions

### `RecordViewControls` is a plain helper class, not a component

The shared class does not extend a library base and owns no single mountable
subtree. It exposes its widgets as `readonly` fields and the host places them
in its own toolbar. `DefinitionEditor`
([`frontend/src/dock/definitionEditor.ts:33`](frontend/src/dock/definitionEditor.ts#L33))
is the in-repo precedent: the same shape, extracted from two panels for the
same reason, exposing `editor` and `toolbar` for the host to lay out.[^controls-shape]

The file is named `recordViewControls.ts`, lower-case, matching
`definitionEditor.ts`, `glyphButton.ts` and `columnsGrid.ts`. It is not wrapped
in `callable()`.[^lowercase]

### The controls own the wiring; the pure helpers stay put

`recordNavigation.ts` and `gridQuickSearch.ts` keep their current exports and
their current shape. `RecordViewControls` imports them, exactly as the two
hosts do today. Nothing pure moves into the new class, and nothing DOM-bound
moves into the two pure modules.[^seam]

### Hosts extend the controls through two callbacks

`RecordViewControlsOptions` carries `onRotate` and `onQuery`. Each runs after
the controls have finished their own work for that event.
`TableWorkPanel` passes both; `QueryResultGrid` passes neither.[^hooks]

| Host | `searchPlaceholder` | `onRotate` | `onQuery` | Also wires |
|---|---|---|---|---|
| `TableWorkPanel` | `"Quick search (loaded rows)"` | `syncAddEnabled` | `syncQuickSearchStatus` | `store.on("datachange", controls.syncStepEnabled)` |
| `QueryResultGrid` | `"Quick search"` | — | — | — |

### `swapTab` owns the `refreshingTabs` dance and nothing else

`swapTab(content, title, options, removeOutgoing)` raises `refreshingTabs`,
adds the new tab, removes the outgoing one, and lowers the flag in a `finally`.
It does not show the result pane and does not select the new tab — each caller
keeps its own `ensureResultPaneShown()` and its own `setActiveContent`, because
the Data-refresh path deliberately has neither in that position.[^swap-scope]

`QueryPanel.ts`'s own `removeTabSilently`
([`QueryPanel.ts:371`](frontend/src/dock/QueryPanel.ts#L371)) is the precedent:
a small constructor-local function whose whole job is to own one guard-flag
dance (`suppressCloseHandler`) so its callers never repeat it. `swapTab` is the
same thing for `refreshingTabs`.

| Caller | `content` | `title` | `options` | `removeOutgoing` |
|---|---|---|---|---|
| `showDiagramTab` | `nextDiagram` | `"Diagram"` | `{ closeable: true, glyph: "sitemap" }` | `removeDiagramTab` |
| `refreshExistingDataTab` | `grid.content` | `"Data"` | `{ glyph: "table" }` | `removeDataTab` |
| `showChart` | `nextChart.content` | `"Chart"` | `{ closeable: true, glyph: "chart-simple" }` | `removeChartTab` |
| `showPlan` | `editor` | `"Explain"` | `{ closeable: true, glyph: "diagram-project" }` | `removeExplainTab` |

`refreshDataTab`'s first-run lazy-factory `addTab`
([`QueryPanel.ts:952`](frontend/src/dock/QueryPanel.ts#L952)) is **not** a
`swapTab` call: it adds a factory and removes nothing, so there is no interim
strip drain to guard against.

### `removeTab` takes the content plus a slot-clearing callback

`removeTab(content, clearSlot)` returns early when `content` is undefined,
otherwise calls `removeTabSilently(content)` and then `clearSlot()`. The four
`remove*Tab` functions stay, each shrinking to one call — they are referenced
by name from `clear()` and from all four `swapTab` call sites, and
`removeExplainTab` carries a `syncDiagramButton()` that the others do not.[^remove-shape]

### `readOnlyTable` widens its parameter to `AbstractStore`

`RoleGrantsPanel` builds its grid over a `Store`, not a `MemoryStore`, so the
shared helper's parameter type widens to their common base. `Table`'s own
constructor already takes `AbstractStore`.[^widen]

---

## Public API

### `frontend/src/dock/recordViewControls.ts` (new)

```ts
import { TextField }        from "@jimka/typescript-ui/component/input";
import { Table }            from "@jimka/typescript-ui/component/table";
import type { Component }   from "@jimka/typescript-ui/core";
import type { ModelRecord } from "@jimka/typescript-ui/data";

/** Construction inputs for {@link RecordViewControls}. */
export interface RecordViewControlsOptions {
    /**
     * The grid these controls drive. Must still be in the `"normal"` display
     * mode: the constructor captures the quick-search field scope from it.
     */
    grid: Table;
    /** The quick-search field's placeholder text. */
    searchPlaceholder: string;
    /** Run after every display-mode flip, once the steppers have re-synced. */
    onRotate?: () => void;
    /** Run after every quick-search change, once the steppers have re-synced. */
    onQuery?: () => void;
}

export class RecordViewControls {
    /** The record-view toggle, Previous and Next, in toolbar order. */
    readonly buttons: Component[];

    /** The quick-search field, placed separately in each host's toolbar. */
    readonly searchField: TextField;

    constructor(options: RecordViewControlsOptions);

    /** The trimmed quick-search text currently in the field. */
    getQuery(): string;

    /** Whether the grid is in the rotated (record) display mode. */
    isRotated(): boolean;

    /** The loaded records matching the live quick-search query, in store order. */
    matchingRecords(): ModelRecord[];

    /** Flip the grid's display mode, the toggle, and the steppers, then run `onRotate`. */
    setRotated: (rotated: boolean) => void;

    /** Re-derive Previous/Next enablement. Safe to register by reference. */
    syncStepEnabled: () => void;
}
```

`setRotated` and `syncStepEnabled` are arrow-function fields per
`COMPONENT_CONVENTIONS.md` section (c) — `syncStepEnabled` is registered by
reference on both the grid's `"selection"` and the table store's
`"datachange"`. `getQuery`, `isRotated` and `matchingRecords` are plain
methods; nothing hands them off by reference.

### `readOnlyTable` (changed, `frontend/src/dock/columnsGrid.ts`)

```ts
export function readOnlyTable(store: AbstractStore): Table;
```

`readOnlyTable`'s body is unchanged. Only the parameter type widens, from
`MemoryStore` to its base `AbstractStore`.

---

## Internal Structure

### `RecordViewControls`

```ts
Glyph.register(table_list, angle_left, angle_right);

export class RecordViewControls {
    readonly buttons    : Component[];
    readonly searchField: TextField;

    private readonly _grid    : Table;
    private readonly _fields  : string[];
    private readonly _toggle  : ToggleButton;
    private readonly _prev    : Button;
    private readonly _next    : Button;
    private readonly _onRotate: (() => void) | undefined;
    private readonly _onQuery : (() => void) | undefined;

    constructor(options: RecordViewControlsOptions) {
        this._grid     = options.grid;
        this._fields   = quickSearchFields(options.grid);
        this._onRotate = options.onRotate;
        this._onQuery  = options.onQuery;

        this._toggle = glyphToggleButton("table-list", PRIMARY_COLOR,
            "Record view (one record as field/value rows)", false);
        this._prev   = glyphButton("angle-left",  PRIMARY_COLOR, "Previous record", () => this.stepRecord(-1));
        this._next   = glyphButton("angle-right", PRIMARY_COLOR, "Next record",     () => this.stepRecord(1));

        this.searchField = new TextField({ placeholder: options.searchPlaceholder });
        this.buttons     = [this._toggle, this._prev, this._next];

        this._toggle.on("action", () => this.setRotated(this._toggle.isSelected()));
        this.searchField.on("change", this.applyQuickSearch);
        options.grid.on("selection", this.syncStepEnabled);

        this.syncStepEnabled();
    }

    getQuery(): string {
        return this.searchField.getValue().trim();
    }

    isRotated(): boolean {
        return this._grid.getDisplayMode() === "rotated";
    }

    matchingRecords(): ModelRecord[] {
        const needle = this.getQuery().toLowerCase();

        return visibleRecords(this._grid.getStore().getRecords(),
            (r: ModelRecord) => matchesQuery(this._grid, this._fields, r, needle));
    }

    setRotated = (rotated: boolean): void => {
        const record = this._grid.getSelectedRecord();

        this._toggle.setSelected(rotated);

        if (rotated) {
            this._grid.setDisplayMode("rotated");
        } else {
            this._grid.setDisplayMode("normal");
            // setDisplayMode re-selects the displayed record but does not reveal
            // it; selectRecord's normal-mode path scrolls the row back into view.
            this._grid.selectRecord(record);
        }

        this.syncStepEnabled();
        this._onRotate?.();
    };

    syncStepEnabled = (): void => {
        const rotated = this.isRotated();
        const records = this.matchingRecords();
        const current = this._grid.getSelectedRecord();
        const index   = current ? records.indexOf(current) : -1;

        this._prev.setEnabled(rotated && stepIndex(index, -1, records.length) !== null);
        this._next.setEnabled(rotated && stepIndex(index,  1, records.length) !== null);
    };

    private applyQuickSearch = (): void => {
        this._grid.setQuickSearch(this.getQuery());
        this.syncStepEnabled();
        this._onQuery?.();
    };

    private stepRecord(delta: number): void {
        const records = this.matchingRecords();
        const current = this._grid.getSelectedRecord();
        const target  = stepIndex(current ? records.indexOf(current) : -1, delta, records.length);

        if (target !== null) {
            this._grid.selectRecord(records[target]);
        }
    }
}
```

`setSelected` does not emit `"action"`, so `setRotated`'s own
`this._toggle.setSelected(rotated)` cannot re-enter through the toggle's
listener.[^no-loop]

### `swapTab` and `removeTab` (`frontend/src/dock/QueryPanel.ts`)

Both are constructor-local function declarations placed immediately after
`removeTabSilently`, before the four `remove*Tab` functions.

```ts
/**
 * Mount `content` as the result pane's `title` tab, replacing the tab of the
 * same kind.
 *
 * The replacement is added BEFORE the outgoing tab is removed, and both run
 * under `refreshingTabs`. A newly added tab only lands in the Tab manager's
 * content list on the next scheduled layout, so removing the old one first —
 * or removing it outside the guard — can momentarily drain the strip to zero
 * and fire "empty", which would hide the very pane the replacement is about to
 * land in. Adding first also means a re-run never shows two tabs of the same
 * kind, not even for one frame.
 *
 * The caller must already have shown the result pane: `ensureResultPaneShown()`
 * for a tab built from scratch, or, on the Data-refresh path, the
 * `refreshDataTab` call that started the run.
 *
 * @param content - The freshly built tab content to mount.
 * @param title - The tab strip's label.
 * @param options - Tab options, passed straight to `TabPanel.addTab`.
 * @param removeOutgoing - Removes the outgoing tab of this kind and clears its
 *   slot (one of the four `remove*Tab` functions). A no-op when none is open.
 */
function swapTab(
    content: Component,
    title: string,
    options: { closeable?: boolean; glyph?: string },
    removeOutgoing: () => void,
): void {
    refreshingTabs = true;

    try {
        resultHost.addTab(content, title, options);
        removeOutgoing();
    } finally {
        refreshingTabs = false;
    }
}

/**
 * Remove one result tab and clear its slot, if that tab is present.
 * `removeTabSilently`'s `tab.closeTab` disposes the removed content.
 *
 * @param content - The slot's mounted content, or undefined when the slot is empty.
 * @param clearSlot - Nulls the slot, plus any re-sync that hangs off it.
 */
function removeTab(content: Component | undefined, clearSlot: () => void): void {
    if (!content) {
        return;
    }

    removeTabSilently(content);
    clearSlot();
}
```

The four wrappers become:

```ts
function removeDataTab(): void {
    removeTab(dataSlot?.content, () => { dataSlot = null; });
}

function removeChartTab(): void {
    removeTab(chartSlot?.content, () => { chartSlot = null; });
}

function removeExplainTab(): void {
    removeTab(explainSlot?.editor, () => {
        explainSlot = null;
        syncDiagramButton();
    });
}

function removeDiagramTab(): void {
    removeTab(diagramSlot?.content, () => { diagramSlot = null; });
}
```

---

## Ordered Implementation Steps

Line numbers below are as of this plan's writing, before
`dialog-subclass-foundation` lands. That plan deletes lines from `QueryPanel.ts`
between 117 and 676, so everything it cites past line 676 shifts up by roughly
50 lines. Locate every `QueryPanel.ts` edit by symbol name, not by number.

1. **Create `frontend/src/dock/recordViewControls.ts`.** The
   `RecordViewControlsOptions` interface from `## Public API` and the class body
   from `## Internal Structure`. Imports, matching `TableWorkPanel.ts`'s own
   style (plain value imports for library classes used only as field types,
   `import type` for the rest): `Button`, `ToggleButton` from
   `@jimka/typescript-ui/component/button`; `TextField` from
   `@jimka/typescript-ui/component/input`; `Table` from
   `@jimka/typescript-ui/component/table`; `Glyph` from
   `@jimka/typescript-ui/component/display`; `type Component` from
   `@jimka/typescript-ui/core`; `type ModelRecord` from
   `@jimka/typescript-ui/data`; `table_list`, `angle_left`, `angle_right` from
   their glyph modules; `glyphButton`, `glyphToggleButton` from
   `./glyphButton`; `stepIndex`, `visibleRecords` from `./recordNavigation`;
   `quickSearchFields`, `matchesQuery` from `./gridQuickSearch`;
   `PRIMARY_COLOR` from `../theme`. Add the module header: one owner for the
   record-view toggle, its Previous/Next steppers and the quick-search field,
   so the table grid and the query-result grid cannot drift apart; a
   composition helper, not a component (the host lays out `buttons` and
   `searchField` itself, the way `definitionEditor.ts` hands over `editor` and
   `toolbar`); the grid must still be `"normal"` at construction, because
   `quickSearchFields` is captured once there.
   Check: `npm --prefix frontend run typecheck`.

2. **Widen `readOnlyTable` in `frontend/src/dock/columnsGrid.ts`.** Change the
   parameter type at line 122 from `MemoryStore` to `AbstractStore` and add
   `AbstractStore` to the existing `import type { FieldOptions, ModelRecord }`
   line. In its doc comment (lines 111-121), extend the "Shared by relation
   Columns (views/matviews), Indexes and Constraints" sentence to also name the
   query-result grid and the role-grants grid, and say the parameter is the
   `AbstractStore` base so a `Store`-backed grid (role grants) fits alongside
   the `MemoryStore`-backed ones.
   Check: `npm --prefix frontend run typecheck`.

3. **Adopt `readOnlyTable` in `frontend/src/dock/RoleGrantsPanel.ts`.** Replace
   line 50's `Table(store, { columns: [], autoSizeColumns: true, rowReadOnly: () => true })`
   with `readOnlyTable(store)`. Drop the now-unused
   `import { Table } from "@jimka/typescript-ui/component/table";` and add
   `import { readOnlyTable } from "./columnsGrid";`.
   Check: `npm --prefix frontend run typecheck`.

4. **Rewrite `QueryResultGrid` in `frontend/src/dock/QueryResultView.ts`.**
   The constructor body (lines 92-184) becomes: the `MemoryStore` construction
   unchanged; `const grid = readOnlyTable(store);`; a
   `const controls = new RecordViewControls({ grid, searchPlaceholder: "Quick search" });`;
   the `ToolBar` with `components: [...controls.buttons, Spacer.flex(), controls.searchField]`;
   the `content` container and its two `addComponent` calls unchanged; and
   `this.content = content;`. Delete `searchFields`, `recordToggle`,
   `prevButton`, `nextButton`, `quickSearchField`, the three `on(...)`
   registrations, the initial `syncStepEnabled()` call, and the five inner
   functions (`toggleRecordView`, `applyQuickSearch`, `matchingRecords`,
   `stepRecord`, `syncStepEnabled`). Keep `controls` a local `const`, not a
   field — an unused private field fails `noUnusedLocals`, and the wiring the
   controls registered keeps them reachable for as long as the grid lives.
   Fold line 94-96's column-sizing comment into a sentence above the
   `readOnlyTable(store)` call saying that a query result has no PK and is
   never written back, and that its columns are sized from the returned rows.
   Rewrite the class doc comment (lines 73-83): the toolbar group is the shared
   `RecordViewControls`, and the sentence naming `toggleRecordView`,
   `applyQuickSearch`, `stepRecord` and `syncStepEnabled` as plain inner
   functions goes — no inner function is left. Keep the sentence saying the
   instance owns `content` alone and needs no teardown of its own.
   Remove the now-unused imports: `Table`, `TextField` (keep `Text` and
   `ComboBox`), `type ModelRecord`, the whole `glyphButton, glyphToggleButton`
   line, the whole `stepIndex, visibleRecords` line, the whole
   `quickSearchFields, matchesQuery` line, the whole `PRIMARY_COLOR` line, and
   `table_list`, `angle_left`, `angle_right` (from both their import lines and
   the `Glyph.register` call at line 67, which keeps `chart_line, chart_column`).
   Add `import { readOnlyTable } from "./columnsGrid";` and
   `import { RecordViewControls } from "./recordViewControls";`.
   Check: `npm --prefix frontend run typecheck`.

5. **Update `QueryResultView.ts`'s module header (lines 1-34).** In the
   `QueryResultGrid` bullet (lines 4-10), say the toggle/steppers/quick-search
   group is the shared `RecordViewControls`, the same group `TableWorkPanel`
   mounts. Replace the quick-search paragraph (lines 19-27) with a shorter one:
   `RecordViewControls` owns the row-hiding and the stepper; unlike
   `TableWorkPanel`'s grid, a query result is never paginated (`MemoryStore`
   holds every returned row), so this grid shows no "N more on the server"
   status line — it passes no `onQuery` hook at all. Do **not** name
   `quickSearchFields` or `matchesQuery` in the replacement, so
   `## Verification`'s grep over those names stays meaningful. Leave the chart
   paragraphs (lines 29-34) alone.

6. **Rewrite `TableWorkPanel`'s constructor (`frontend/src/dock/TableWorkPanel.ts`).**
   After the `dataGrid` local, add:

   ```ts
   const controls = new RecordViewControls({
       grid:              dataGrid,
       searchPlaceholder: "Quick search (loaded rows)",
       onRotate:          () => this.syncAddEnabled(),
       onQuery:           () => this.syncQuickSearchStatus(),
   });
   ```

   Both arrows reference `this` before `super()`; that compiles and is safe,
   because neither runs until after construction.[^pre-super-this] Delete the
   `searchFields` local (line 145), the `quickSearchField` local (line 177),
   and the `recordToggle` / `prevButton` / `nextButton` locals (lines 183-185),
   along with their comments at 143-144, 174-176 and 179-182. In the `ToolBar`
   (lines 192-220), replace the leading `recordToggle, prevButton, nextButton`
   with `...controls.buttons` and replace `quickSearchField` with
   `controls.searchField`; keep every surrounding comment, separator and
   spacer. Replace the five deleted fields (`searchFields`, `recordToggle`,
   `prevButton`, `nextButton`, `quickSearchField`, lines 117-121 and 131-134)
   with one `private readonly controls: RecordViewControls;`, and their
   assignments (lines 229, 234-237) with `this.controls = controls;`. Trim the
   field block's comment (lines 123-130) to its `addButton` half — its
   `quickSearchField` sentence describes a widget this class no longer holds.
   Keep `store`, `dataGrid`, `privileges`, `canWrite`, `notify`, `addButton`,
   `deleteButton`, `saveButton` exactly as they are.
   Check: `npm --prefix frontend run typecheck` (expected to still fail here —
   step 7 removes the methods this step's deletions orphan).

7. **Rewrite `TableWorkPanel`'s handlers and post-`super()` wiring.** Delete
   `applyQuickSearch` (lines 309-322), `toggleRecordView` (lines 347-362),
   `syncStepEnabled` (lines 373-391) and the module-level `stepRecord` (lines
   465-491). Rewrite `syncQuickSearchStatus` to read through the controls:

   ```ts
   private syncQuickSearchStatus = (): void => {
       const query = this.controls.getQuery();

       if (query === "") {
           return;
       }

       const loaded  = this.store.getRecords();
       const matched = this.controls.matchingRecords().length;

       this.notify(quickSearchStatus(matched, loaded.length, this.store.getTotalCount()));
   };
   ```

   Change `syncAddEnabled`'s first line to
   `const rotated = this.controls.isRotated();`. In the constructor's wiring
   block (lines 243-292): delete `this.quickSearchField.on("change", this.applyQuickSearch);`
   and `this.recordToggle.on("action", this.toggleRecordView);` with their
   comments; change `this.syncStepEnabled();` plus
   `dataGrid.on("selection", this.syncStepEnabled);` plus
   `store.on("datachange", this.syncStepEnabled);` to the single line
   `store.on("datachange", this.controls.syncStepEnabled);` (the controls
   already made the initial call and registered the grid's `"selection"`),
   trimming that block's comment (lines 270-276) to the one sentence saying
   `"datachange"` covers add/remove while the `"selection"` the controls
   registered covers stepping, toggling and a reload's re-target; and
   replace the whole `if (view?.rotated === true) { … }` block with

   ```ts
   if (view?.rotated === true) {
       this.controls.setRotated(true);
   }
   ```

   — `setRotated` covers the display-mode change, the stepper re-sync and, via
   `onRotate`, `syncAddEnabled`. Keep `this.syncQuickSearchStatus();` and the
   two `store.on(…, this.syncQuickSearchStatus)` registrations, and keep the
   Save / Delete wiring untouched. Remove the now-unused imports:
   `ToggleButton` (keep `Button`), `TextField`, `glyphToggleButton` (keep
   `glyphButton`), `stepIndex` and `visibleRecords` (keep `findRecordByKey`),
   the whole `quickSearchFields, matchesQuery` line, and `table_list`,
   `angle_left`, `angle_right` from both their import lines and the
   `Glyph.register` call at line 86. Add
   `import { RecordViewControls } from "./recordViewControls";`.
   Check: `npm --prefix frontend run typecheck` — now clean.

8. **Update `TableWorkPanel.ts`'s module header (lines 1-56).** Replace the
   quick-search paragraph (13-28) and the record-view paragraph (30-40) with
   one shorter paragraph: both live in the shared `RecordViewControls`; this
   panel adds only the status line (`syncQuickSearchStatus`, through `notify`,
   which is why an empty query leaves the last message alone) and the Add
   gating that follows the display mode. Keep the sentence contrasting local
   quick search with the grid's own remote header filter row, and keep the
   pointer to `plans/implemented/table-local-filter.md`, and do **not** name
   `quickSearchFields`, `matchesQuery`, `stepIndex` or `visibleRecords` in the
   replacement, so `## Verification`'s greps over those names stay meaningful.
   In the route-seeding paragraph (42-47), change "the record toggle's initial
   state" to say the panel calls `controls.setRotated(true)` once wiring is
   done. In the class-first paragraph (49-56), drop `toggleRecordView`,
   `applyQuickSearch` and `stepRecord` from the two lists and keep
   `syncQuickSearchStatus` in the arrow-field list.

9. **Update the two shared modules' headers.** In
   `frontend/src/dock/recordNavigation.ts` (lines 11-19), change the composer
   from `TableWorkPanel.ts`'s `stepRecord`/`syncStepEnabled` to
   `recordViewControls.ts`'s, and change "The predicate itself lives in
   TableWorkPanel.ts" to `gridQuickSearch.ts`'s `matchesQuery`, which
   `recordViewControls.ts` supplies. In
   `frontend/src/dock/gridQuickSearch.ts` (lines 1-2), change the consumer list
   to the single `recordViewControls.ts`, noting it backs both
   `TableWorkPanel`'s data grid and `QueryResultView`'s `QueryResultGrid`; in
   `quickSearchFields`'s doc (line 33), change "every call site captures this
   immediately" to "its one call site captures this immediately". In
   `frontend/src/dock/quickSearchModel.ts` (lines 7-8), change "TableWorkPanel.ts
   delegates row-hiding" to `recordViewControls.ts`.
   Check: `grep -rl 'quickSearchFields\|matchesQuery\|stepIndex\|visibleRecords' frontend/src/`
   — expect exactly three files: `recordNavigation.ts`, `gridQuickSearch.ts`
   and `recordViewControls.ts`.

10. **Add `swapTab` and `removeTab` to `frontend/src/dock/QueryPanel.ts`.**
    Insert both function declarations from `## Internal Structure` immediately
    after `removeTabSilently` (currently ending line 379), then rewrite the four
    `remove*Tab` bodies (currently 381-412) to the one-call form shown there.
    Keep each wrapper's existing one-line doc comment, and move the "`tab.closeTab`
    disposes its content" half of it onto `removeTab` so it is stated once.
    Check: `npm --prefix frontend run typecheck`.

11. **Route the four tab swaps through `swapTab` in `frontend/src/dock/QueryPanel.ts`.**
    In each of `showDiagramTab`, `refreshExistingDataTab`, `showChart` and
    `showPlan`, replace the `refreshingTabs = true; try { … } finally { … }`
    block with the single `swapTab(...)` call from the table in
    `## Architecture Decisions`. Leave everything around each block exactly as
    it is — `ensureResultPaneShown()` before, the slot assignment and
    `tab.setActiveContent` after, `refreshExistingDataTab`'s
    `oldDataTabWasActive` capture and its conditional re-select, `showChart`'s
    and `showPlan`'s `setActiveExport`, and `showPlan`'s `syncDiagramButton()`
    and `notify(...)`. Delete the three per-site comments that only explained
    the dance (`showDiagramTab`'s "Mirrors showChart's
    add-then-remove-under-refreshingTabs dance…" sentence in its doc comment,
    `refreshExistingDataTab`'s "Add-then-remove in the same tick (mirroring
    showChart's dance)…" block at 1063-1065, and `showPlan`'s "Add the new plan
    tab, then remove the old one, under refreshingTabs…" block at 1166-1168) —
    `swapTab`'s own doc comment now carries that reasoning. Keep
    `refreshExistingDataTab`'s doc-comment sentence about never showing two
    Data tabs, which is about that path specifically.
    Check: `grep -c 'refreshingTabs = ' frontend/src/dock/QueryPanel.ts` — expect
    `3` (the `let` declaration plus `swapTab`'s two writes, and nothing else
    writing the flag).

12. **Fix `QueryPanel.ts`'s header (lines 5-38).** Change "up to three
    independently-refreshed tabs" to four and add a fourth bullet after Explain:
    *Diagram — the plan tree plus its ELK diagram, built from the shown Explain
    plan re-fetched as FORMAT JSON; opened and refreshed by the Explain-diagram
    toolbar button (enabled only while a plan is on screen) and closeable. See
    `ExplainDiagramPanel` / `showDiagram`.* In the paragraph at 27-38, extend
    "Run refreshes only Data, the Chart button only Chart, Explain only
    Explain" with "and the Explain-diagram button only Diagram", and extend
    "a re-run does not disturb an open Chart/Explain tab" to name Diagram too.
    Leave the error-banner sentence at 36-38 and the whole class-first
    paragraph at 46-56 alone — `dialog-subclass-foundation` owns those.

13. **Fix `frontend/src/dock/DocumentationPanel.ts`'s header (lines 3-4).**
    Replace "the editable counterpart to `DefinitionPanel`'s read-only
    CodeEditor" with a statement that this is the app's only Markdown editor;
    `DefinitionPanel`'s SQL editor is editable too (a `DefinitionEditor` with a
    dirty-gated Save button), and the genuinely read-only editors are
    `IndexInfoPanel`'s index definition
    ([`IndexInfoPanel.ts:94`](frontend/src/dock/IndexInfoPanel.ts#L94)) and
    `QueryPanel`'s Explain plan viewer
    ([`QueryPanel.ts:1162`](frontend/src/dock/QueryPanel.ts#L1162)). Leave the
    rest of the header and the whole class body alone.

14. **Create `frontend/tests/dock/exportQueryResult.test.ts`.** Mock
    `../../src/data/download` exactly as
    `tests/dock/exportExplainResult.test.ts:4` does, then assert cases 12-14 of
    `## Expected Behaviour`.
    Check: `npm --prefix frontend test`.

15. **Create `frontend/tests/dock/exportRoleGrants.test.ts`.** Same mock, then
    assert cases 15-17 of `## Expected Behaviour`.
    Check: `npm --prefix frontend test`.

16. **Drop the stale manual-verify claims.** In
    `frontend/src/dock/exportQueryResult.ts` (lines 6-7), replace "This is
    DOM-bound (it calls download()) and so manual-verify; its serialization core
    (serialize.ts) is unit-tested" with a note that the `download` call is
    mocked in `tests/dock/exportQueryResult.test.ts`, so the filename, MIME type
    and status message are unit-tested here while `serialize.ts` covers the
    serialization itself. In `frontend/src/dock/exportExplainResult.ts` (lines
    7-9), make the same correction, pointing at
    `tests/dock/exportExplainResult.test.ts`. Add the matching two-line note to
    `frontend/src/dock/exportRoleGrants.ts`'s header (after line 5), pointing at
    `tests/dock/exportRoleGrants.test.ts`. Leave
    `frontend/src/data/download.ts`'s own manual-verify note alone — that module
    really is unexercised by the suite.
    Check: `grep -rn 'manual-verify' frontend/src/dock/` — expect zero matches.

17. **Full check.** `npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build`,
    then the manual smoke tests in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/recordViewControls.ts` |
| Create | `frontend/tests/dock/exportQueryResult.test.ts` |
| Create | `frontend/tests/dock/exportRoleGrants.test.ts` |
| Modify | `frontend/src/dock/TableWorkPanel.ts` |
| Modify | `frontend/src/dock/QueryResultView.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/dock/RoleGrantsPanel.ts` |
| Modify | `frontend/src/dock/columnsGrid.ts` |
| Modify | `frontend/src/dock/recordNavigation.ts` |
| Modify | `frontend/src/dock/gridQuickSearch.ts` |
| Modify | `frontend/src/dock/quickSearchModel.ts` |
| Modify | `frontend/src/dock/DocumentationPanel.ts` |
| Modify | `frontend/src/dock/exportQueryResult.ts` |
| Modify | `frontend/src/dock/exportExplainResult.ts` |
| Modify | `frontend/src/dock/exportRoleGrants.ts` |

---

## Expected Behaviour

Cases 1-11 are **manual-verify**: `RecordViewControls` and `QueryPanel`'s tab
helpers both sit behind the library's DOM-backed component classes, which the
project's node-environment vitest cannot load. Cases 12-17 are unit tests.

**Record view and quick search — a table's Data tab**

1. Toggling the record button flips the grid to the rotated field/value view.
   Previous / Next become live (each enabled wherever a neighbouring record
   exists); Add disables with the tooltip "Switch to the grid view to add a
   row". Toggling back restores the grid, re-selects the record that was
   displayed and scrolls it into view; Add re-enables (given INSERT).
2. In record view with no query, Previous is disabled on the first loaded
   record and Next on the last; both are enabled in between. Outside record
   view both stay disabled regardless.
3. Typing a quick-search query hides the non-matching rows, and the status bar
   reads `N of M loaded rows` (plus the "more on the server not searched"
   clause when the table has more rows than are loaded). Clearing the query
   restores every row and leaves the last status message in place rather than
   emitting a new one.
4. With a query active and the grid rotated, Previous / Next skip the records
   the query does not match. A record already displayed when the query narrows
   past it stays displayed until the user steps away.
5. A formatted column matches the way it renders, not its stored value: a
   `timestamp` column holding `2026-08-29T14:03:00Z` and rendering
   `2026-08-29 14:03` matches the query `29 14:03`, which the raw ISO string
   does not contain.
6. Opening a table by a route that requests the record view (`?rotated=true`)
   lands rotated, with the toggle already lit, Add already disabled, and the
   steppers already enabled/disabled correctly — no extra click needed.
   Combining it with `?record=<pk>` focuses that record once the first page
   loads.
7. Add / Delete / Save / Refresh / Import / Export keep working exactly as
   before, and the toolbar's layout is unchanged: record group, separator,
   Add / Delete / Save, flexible gap, quick search, separator, Import /
   Export / Refresh.

**Record view and quick search — a query result's Data tab**

8. Running a `SELECT` and toggling the record button behaves as case 1, minus
   Add (that toolbar has none). Quick search behaves as case 3 minus the status
   line — a query result shows no match count anywhere.
9. Re-running the query rebuilds the grid: the new tab opens with the toggle
   off, an empty query and both steppers disabled.

**Query panel tab swaps**

10. Each of these replaces its own tab in place, leaves every other tab open,
    and never hides the result pane mid-swap: re-running a query with a Data
    tab already open; pressing Chart twice; running Explain twice; pressing the
    Explain-diagram button twice. In each case the replacement tab ends up
    selected, except a re-run while a *different* tab was active, which leaves
    that other tab active.
11. Removal still works everywhere it did: Clear empties the panel and hides the
    pane; a non-rows re-run drops only the Data tab; closing the last tab by
    hand hides the pane; closing the Explain tab disables the Explain-diagram
    button.

**`exportQueryResult` (unit)**

Fixture: `columns = [{ name: "id", wireType: "number" }, { name: "name", wireType: "string" }]`,
`rows = [{ id: 1, name: "ada" }, { id: 2, name: "b, c" }]`, `rowCount: 2`,
`truncated: false`.

| Call | `download` arguments | `notify` |
|---|---|---|
| `exportQueryResult(result, "csv", notify)` | `("id,name\r\n1,ada\r\n2,\"b, c\"\r\n", "query-result.csv", "text/csv")` | `"exported 2 row(s) as CSV"` |
| `exportQueryResult(result, "json", notify)` | `(JSON.stringify([{id:1,name:"ada"},{id:2,name:"b, c"}], null, 2), "query-result.json", "application/json")` | `"exported 2 row(s) as JSON"` |
| same with `rows: []`, `rowCount: 0` | `("id,name\r\n", "query-result.csv", "text/csv")` | `"exported 0 row(s) as CSV"` |

12. The CSV export downloads the header plus one CRLF-terminated line per row,
    as `query-result.csv` with `text/csv`, and reports the row count.
13. The JSON export downloads a 2-space-indented array of row objects, as
    `query-result.json` with `application/json`.
14. An empty result still downloads — a header-only CSV, or `[]` for JSON — and
    reports `0 row(s)`.

**`exportRoleGrants` (unit)**

Fixture: `role = "app_ro"`,
`privileges = [{ schema: "public", table: "t", privilege: "SELECT", grantable: false }]`.

| Call | `download` arguments |
|---|---|
| `exportRoleGrants(role, privileges, "csv")` | `("schema,table,privilege,grantable\r\npublic,t,SELECT,false\r\n", "app_ro.grants.csv", "text/csv")` |
| `exportRoleGrants(role, privileges, "json")` | `(JSON.stringify([{schema:"public",table:"t",privilege:"SELECT",grantable:false}], null, 2), "app_ro.grants.json", "application/json")` |
| same with `privileges: []` | `("schema,table,privilege,grantable\r\n", "app_ro.grants.csv", "text/csv")` |

15. The CSV export writes the fixed four-column header — `schema`, `table`,
    `privilege`, `grantable` — and renders `grantable` as `true`/`false`.
16. The filename is the role name followed by `.grants.` and the format, so a
    role named `app_ro` downloads `app_ro.grants.json`.
17. A role with no grants still downloads a header-only CSV (or `[]` for JSON).
    `exportRoleGrants` takes no `notify` parameter, so these tests assert the
    `download` call alone.

---

## Verification

- `npm --prefix frontend run typecheck` — the primary gate. `noUnusedLocals`
  and `noUnusedParameters` are on, so every import and field the rewrites orphan
  fails here.
- `npm --prefix frontend test` — the existing suite stays green and gains the
  two new files.
- `npm --prefix frontend run build`.
- Grep invariants:
  - `grep -rl 'rowReadOnly: () => true' frontend/src/` → exactly
    `frontend/src/dock/columnsGrid.ts` (which owns the spec),
    `frontend/src/dock/ImportRowsDialog.ts` (owned by another plan, see
    `## Non-Goals`), and `frontend/src/properties/PropertyValuePanel.ts` (a
    different spec).
  - `grep -rl 'quickSearchFields\|matchesQuery\|stepIndex\|visibleRecords' frontend/src/`
    → exactly `recordNavigation.ts`, `gridQuickSearch.ts`,
    `recordViewControls.ts`.
  - `grep -rl 'toggleRecordView\|applyQuickSearch\|stepRecord' frontend/src/`
    → exactly `recordViewControls.ts` and `recordNavigation.ts` (whose header
    names `stepRecord` as the composer it serves).
  - `grep -rn 'syncStepEnabled' frontend/src/` → `recordViewControls.ts`,
    `recordNavigation.ts`'s header, and the one
    `store.on("datachange", this.controls.syncStepEnabled)` in
    `TableWorkPanel.ts`.
  - `grep -c 'refreshingTabs = ' frontend/src/dock/QueryPanel.ts` → `3`: the
    `let` declaration and `swapTab`'s two writes. Nothing else writes the flag,
    and the only remaining read is the `tab.on("empty")` guard.
  - `grep -rn 'manual-verify' frontend/src/dock/` → zero matches.
- Manual smoke tests, driving the app per the `verify` skill: a table's Data tab
  for cases 1-7; a query tab running `SELECT * FROM …` for cases 8-9; the same
  query tab's Run / Chart / Explain / Explain-diagram / Clear buttons for cases
  10-11; the Roles view → a role's grants tab → Export for a visual check that
  the grid still renders read-only and paginated after step 3.

---

## Documentation Impact

No exported app API changes shape, and the repo has no generated docs for the
frontend, so the impact is confined to module headers: `TableWorkPanel.ts`,
`QueryResultView.ts`, `QueryPanel.ts`, `recordNavigation.ts`,
`gridQuickSearch.ts`, `quickSearchModel.ts`, `columnsGrid.ts`,
`DocumentationPanel.ts`, and the three export modules, each covered by its own
step above.

`CHANGELOG.md` is **not** touched. Per `release-steps.md`, changelog sections
are written at release time, not per feature branch. Nothing here is
user-visible anyway.

`frontend/COMPONENT_CONVENTIONS.md` is not touched — see `## Non-Goals`.

---

## Potential Challenges

- **`QueryPanel.ts` line numbers shift before this plan runs.**
  `dialog-subclass-foundation` deletes roughly 50 lines between 117 and 676.
  Locate every `QueryPanel.ts` edit by symbol name.
- **Steps 6 and 7 must land together.** Step 6 deletes the fields that step 7's
  deleted methods read, so `typecheck` fails between them. That is expected;
  do not "fix" it by leaving a field behind.
- **Listener order changes slightly in `TableWorkPanel`.** `RecordViewControls`
  registers `syncStepEnabled` on the grid's `"selection"` from its own
  constructor, before the panel registers `syncDeleteEnabled` on the same
  event; and a quick-search keystroke now re-syncs the steppers before the
  status line instead of after. The one handler that writes shared state is
  `applyQuickSearch`, and it still runs first — the hooks fire after it. The
  three sync handlers only read that state and write their own button, so no
  ordering among them is load-bearing.
- **`setRotated` must not be called from `RecordViewControls`'s own
  constructor.** `TableWorkPanel` passes an `onRotate` arrow that touches
  `this` before `super()` has run; calling it during construction would throw a
  `ReferenceError`. The constructor calls `syncStepEnabled()`, never
  `setRotated`.
- **`swapTab`'s add-before-remove order is load-bearing.** A newly added tab
  only lands in the Tab manager's content list on the next scheduled layout, so
  removing the outgoing tab first can drain the strip to zero and fire
  `"empty"`, hiding the result pane before the replacement arrives. Keep the
  two calls in the order shown, and keep the flag reset in a `finally`.
- **`getStore()` returns the source store in both display modes.**
  `RecordViewControls.matchingRecords` reads `grid.getStore().getRecords()`,
  which `Table.setDisplayMode` never repoints — the rotated field/value
  projection lives in a separate private store. That is why one expression can
  replace `TableWorkPanel`'s `this.store.getRecords()` and `QueryResultGrid`'s
  captured `store.getRecords()` alike.[^get-store]

---

## Critical Files

- `frontend/src/dock/definitionEditor.ts` — the precedent `RecordViewControls`
  mirrors: a shared, non-component helper class extracted from two panels,
  exposing its widgets as `readonly` fields for the host to lay out. Read its
  header and class doc before writing step 1.
- `frontend/COMPONENT_CONVENTIONS.md` — sections (b) the super-cascade trap,
  (c) arrow-function handler fields, (f) the composition fallback. They govern
  step 6's pre-`super()` construction and the controls' arrow fields.
- `frontend/src/dock/gridQuickSearch.ts` — `quickSearchFields`'s doc explains
  why the field scope must be captured while the grid is still `"normal"`. That
  rule moves into `RecordViewControls`'s constructor and its header.
- `frontend/src/dock/recordNavigation.ts` — `stepIndex` / `visibleRecords`, and
  the header explaining why they are deliberately separate and DOM-free.
- `frontend/src/dock/QueryPanel.ts:280-285,370-379,551-558` — the
  `refreshingTabs` declaration and its comment, `removeTabSilently` (the
  precedent `swapTab` follows), and the `tab.on("empty")` handler that reads the
  flag. Read all three before step 10.
- `frontend/src/dock/columnsGrid.ts:111-124` — `readOnlyTable` and the doc
  comment step 2 extends.
- `frontend/tests/dock/exportExplainResult.test.ts` — the `vi.mock` shape steps
  14 and 15 copy.
- `plans/dialog-subclass-foundation.md` — the plan this one depends on; its
  steps 8 and 9 are the only other edits to `QueryPanel.ts`.
- `plans/research/codebase-health-audit-2026-08-29.md` — Priority 2 #9, #10 and
  the `readOnlyTable` half of #4; the `QueryPanel` / `DocumentationPanel` /
  `exportExplainResult` bullets in Priority 4.

---

## Non-Goals

- **`frontend/src/dock/ImportRowsDialog.ts`'s `readOnlyTable` bypass
  (line 107).** That file is in both `dialog-subclass-foundation`'s and
  `ddl-forms-in-tab-editing`'s `touches-shared`, and the second of those
  reshapes it wholesale; its bypass converges there. `StructurePanel.ts` needs
  nothing at all — it already calls `readOnlyTable` at lines 594 and 611.
- **Anything in `QueryPanel.ts`'s error banner.** `dialog-subclass-foundation`
  owns the banner, its constant, its three functions and the two header
  sentences that describe it.
- **Documenting the composition-helper shape in
  `frontend/COMPONENT_CONVENTIONS.md`.** `definitionEditor.ts` established the
  shape and is undocumented there today; `RecordViewControls` is the second
  instance. Deciding whether two instances warrant a convention section is a
  separate call, and the dependency plan is already adding a section (g) to
  that file.
- **Giving `gridQuickSearch.ts` its own unit test.** The audit lists it as a
  coverage gap, but nothing in this plan changes its behaviour, and closing it
  needs a `Table` stand-in that the node test environment has no way to build.
- **Converging `QueryPanel`'s four result slots into one keyed record.** Their
  payloads differ (`{content, result}`, `{editor, result, sql}`, `{content}`),
  and rewriting all 57 slot references is a far larger change than the eight
  bodies this plan collapses.
- **Renaming `explainSlot.editor` to `content`.** It would make the four slots
  uniform, but `removeTab` takes the content as an argument either way, so the
  rename buys nothing this plan needs.
- **Making `RecordViewControls` a `Container` subclass.** Its three buttons and
  its search field land at different positions in each host's toolbar — a
  leading group, then a flexible gap, then the field — so a single mountable
  subtree cannot express either layout.

---

## Notes

[^after-banner]: `dialog-subclass-foundation` extracts a shared `ErrorBanner`
    and adopts it in `QueryPanel.ts`, deleting the `ERROR_BANNER_BG` constant
    (lines 117-123), the three banner locals (269-271), the
    `ensureErrorBanner` / `showErrorBanner` / `hideErrorBanner` trio (636-676),
    and rewriting `QueryPanelContent`'s constructor. None of those lines is
    touched here, and none of this plan's lines is touched there — the two
    plans meet only in the file's header comment, where that plan rewrites one
    phrase on line 53 and this one rewrites the tab list at 5-38. The relation
    is `depends-on` rather than a bare `touches-shared` overlap for two
    reasons: that plan's deletions move every `QueryPanel.ts` line this plan
    cites past 676, so running them concurrently would leave both sets of
    citations wrong; and two large concurrent edits to a 1,300-line file are a
    merge conflict waiting to happen even where the hunks do not overlap.

[^controls-shape]: Three shapes were considered. A `Container` subclass is ruled
    out by the split placement (see `## Non-Goals`). Extending
    `recordNavigation.ts` / `gridQuickSearch.ts` with the wiring is ruled out by
    what those modules exist for: both headers state they are split from
    `TableWorkPanel.ts` precisely so they can be unit-tested without the
    library's DOM-backed component classes, which touch `document` at
    module-load time (`vitest.config.ts` runs the suite in `node`). Importing
    `Table`, `TextField` and `ToggleButton` into either would break
    `recordNavigation.test.ts`. That leaves a plain helper class, which is what
    `DefinitionEditor` already is: extracted from `DefinitionPanel` and
    `FunctionDefinitionPanel`, holding widgets plus the fiddly state (its
    dirty-gating; this class's rotation and query state), and handing the
    widgets back for the host to place.

[^lowercase]: `frontend/src/dock/` names a file in PascalCase when its default
    subject is a mountable component (`TableWorkPanel.ts`, `IndexInfoPanel.ts`,
    and the `ErrorBanner.ts` the dependency plan adds) and in lower camel case
    otherwise (`definitionEditor.ts`, `glyphButton.ts`, `columnsGrid.ts`,
    `exportButton.ts`, `menuItems.ts`). `callable()` likewise wraps
    class-first *components* per `COMPONENT_CONVENTIONS.md` section (d), so
    that a call site can build one inline without `new`; `DefinitionEditor` is a
    plain `export class` for the same reason `RecordViewControls` is.

[^seam]: Verified rather than assumed. `gridQuickSearch.ts:1-11` names its
    consumers as "TableWorkPanel.ts and QueryResultView.ts's QueryResultGrid"
    and states that row-hiding itself is never reimplemented there — the module
    exists only for the match count and the stepper's "does this record match"
    test, because the grid exposes no query for either. `recordNavigation.ts:9-19`
    states that `visibleRecords` and `stepIndex` are deliberately separate and
    that the predicate belongs to the caller. Both are exactly the seam this
    plan builds on: the two hosts stop composing them and one shared class
    composes them instead.

[^hooks]: The alternative was to expose `recordToggle` and let each host add a
    second listener to the same event — which the library supports, and which
    `TableWorkPanel` already does four times over on `store`'s `"datachange"`.
    Callbacks win on two counts. They keep the widgets private, so no host can
    reach past the controls and re-implement part of the behaviour; and they
    make the ordering explicit, since the controls call the hook after their own
    work rather than relying on registration order. `DefinitionEditor`'s
    `onSave` / `onRefresh` and the dependency plan's `ErrorBanner.onChange` are
    the same shape.

[^swap-scope]: `refreshExistingDataTab` runs inside the fetch continuation, by
    which point `refreshDataTab` has already called `ensureResultPaneShown()`
    and a Data tab exists (that is the branch condition), so the pane is
    guaranteed shown. Folding the call into `swapTab` would add a redundant
    `body.doLayout()` plus `syncToolbarButtons()` on that path — invisible, but
    a behaviour change this plan has no reason to make. Selection is likewise
    left out: three callers select unconditionally after assigning their slot,
    while the Data path selects only when the outgoing tab was the active one,
    and follows it with an `afterNextLayout` focus reclaim. Two of four sites
    diverging is enough to leave both concerns at the call site.

[^remove-shape]: A variant returning "did it remove anything" was rejected: it
    forces every caller into `if (removeTab(dataSlot?.content)) { … }`, putting
    a call inside an `if` condition. Holding the four slots in one keyed record
    instead would let `removeTab(kind)` read and clear the slot itself, but it
    means rewriting all 57 `dataSlot` / `chartSlot` / `explainSlot` /
    `diagramSlot` references in the file, over payloads of three different
    shapes — see `## Non-Goals`. The chosen shape was compiled before this plan
    was written: a throwaway module holding `swapTab`, `removeTab` and two
    wrappers over `let` slots of the file's own shapes produced no diagnostics
    under the project's `tsconfig.json`, confirming that `dataSlot?.content`
    and `explainSlot?.editor` both satisfy `Component | undefined` and that the
    slot-clearing arrows type-check under `strict`. The probe was deleted.

[^widen]: `MemoryStore`, `Store` and `AjaxStore` all extend `AbstractStore`, and
    `Table`'s constructor is declared `constructor(store: AbstractStore, spec?:
    ColumnSpec, …)`, so `readOnlyTable`'s current `MemoryStore` parameter is
    narrower than anything its body needs. `RoleGrantsPanel` builds a `Store`
    over a `PagingMemoryProxy`, which is why the helper could not be adopted
    there without the widening.

[^no-loop]: Checked in the library source.
    `ToggleButton.setSelected` writes `_options.selected`, updates
    `aria-pressed` and the `.selected` style state, and returns — it fires
    nothing. Only `onAction`, reached from the DOM `"click"`, flips the state
    and then fires `"change"`, which is the event `ToggleButton.on("action", …)`
    subscribes to. So a click runs the listener once, and the listener's
    `setRotated` → `setSelected` is a silent no-op on that path.

[^pre-super-this]: A throwaway module carrying the full `RecordViewControls`
    body plus a `Container` subclass that builds it as a pre-`super()` local —
    passing `onRotate: () => this.syncAddEnabled()`, where `syncAddEnabled` is
    an arrow field on the subclass — compiled clean against the installed
    `@jimka/typescript-ui@0.8.0` with the project's own `tsconfig.json`
    (`strict`, `noUnusedLocals`, `verbatimModuleSyntax`). TypeScript rejects a
    bare `this` before `super()`, but not a `this` inside an arrow *body*, and
    the runtime rule matches: the arrow reads `this` when it is called, not
    when it is created, and class field initializers run the instant `super()`
    returns — well before any toolbar event can fire. The probe was deleted;
    nothing from it is committed.

[^get-store]: Checked in the library source. `Table.getStore()` returns
    `_store`, which is assigned only in the constructor and in `setStore`.
    `setDisplayMode("rotated")` builds a separate `_rotatedStore` and rebinds
    the *view* to it, leaving `_store` alone. `getCellText` likewise resolves
    through `_resolvedColumns`, which stays the source columns in both modes —
    only `getColumns()` switches to the field/value projection, which is exactly
    why `quickSearchFields` must be captured while the grid is `"normal"`.
