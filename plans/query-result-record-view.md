---
depends-on: [table-record-detail-view]
---

# Query Result Record View — Implementation Plan

## Overview

`QueryResultGrid` renders the results of an ad-hoc SQL query as a flat grid: one fresh, read-only `Table` over a `MemoryStore` per run, hosted as the Data tab of the query panel's result `TabPanel` ([`frontend/src/dock/QueryResultView.ts:55-72`](frontend/src/dock/QueryResultView.ts#L55-L72), hosted by [`frontend/src/dock/QueryPanel.ts:757-779`](frontend/src/dock/QueryPanel.ts#L757-L779)). A query that returns many columns has the same wide-row readability problem [`table-record-detail-view.md`](table-record-detail-view.md) fixes for a table's Data tab: reading one row means scrolling horizontally across the whole result width.

This plan adds the same toggle — flip to one record shown as field/value rows, with Previous/Next to step through the loaded rows — to `QueryResultGrid`. Like the sibling plan, this builds no new rendering: the library's `Table.setDisplayMode("rotated")` ([`Table.ts:388`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L388)) already owns the projection. What this plan builds is the chrome around it, scoped to `QueryResultGrid` alone.

The work touches only [`frontend/src/dock/QueryResultView.ts`](frontend/src/dock/QueryResultView.ts) (plus `README.md`/`TODO.md`). It reuses two pieces the sibling plan ships rather than re-deriving them: the `stepIndex` pure function ([`frontend/src/dock/recordNavigation.ts`](frontend/src/dock/recordNavigation.ts)) and the `glyphToggleButton` helper ([`frontend/src/dock/glyphButton.ts`](frontend/src/dock/glyphButton.ts)). Both must exist before this plan can be implemented — see the frontmatter `depends-on`.

---

## Architecture Decisions

### The record view is still the library's rotated `Table` mode, and still needs no new component

`QueryResultGrid`'s grid gets `setDisplayMode("rotated")` / `setDisplayMode("normal")` exactly as `TableWorkPanel`'s does. This is the same library feature, the same fallback rules (adopt the current selection, else the first loaded record, else nothing), and the same `getSelectedRecord()`/`getSelectedRecords()` contract — none of that is specific to how a table's data arrived, so nothing here diverges from [`table-record-detail-view.md`'s "record view is the library's rotated Table mode" decision](table-record-detail-view.md#L15-L21).

### Read-only is a non-issue here — the grid was already read-only

The sibling plan spends a `## Architecture Decisions` subsection (["The record view is read-only"](table-record-detail-view.md#L23-L33)) establishing that rotated mode forces `rowReadOnly: () => true` on the projection, and reasoning through what that means for `TableWorkPanel`'s editable grid. `QueryResultGrid` needs none of that reasoning: its grid is built `rowReadOnly: () => true` already ([`QueryResultView.ts:68`](frontend/src/dock/QueryResultView.ts#L68)), because a query result has no primary key and is never written back. Rotated mode's own read-only rule changes nothing observable — the grid was already read-only in both display modes. No `## Non-Goals` entry is needed for "editing in record view" beyond the one already covering ordinary grid editing.

### Placement: a local toolbar inside `QueryResultGrid.content`, not the shared `QueryPanel` toolbar

The toggle and Previous/Next buttons go on a new `NORTH` `ToolBar` that `QueryResultGrid` adds above its own grid — `content` changes from a bare `Table` to a small `Container` (`BorderLayout`, `NORTH` = toolbar, `CENTER` = grid). This mirrors two existing precedents for the exact same toolbar-over-grid shape: `TableWorkPanel`'s own `BorderLayout` frame ([`TableWorkPanel.ts:110-122`](frontend/src/dock/TableWorkPanel.ts#L110-L122), once the sibling plan adds its record-view buttons there) and the library's own demo for this mode, [`RotatedRecordPanel.ts:101-104`](../typescript-ui/packages/lib/src/typescript/RotatedRecordPanel.ts#L101-L104), which needs no `Fit` wrapper around the table — this plan follows that simpler shape rather than `TableWorkPanel`'s extra `Panel({layoutManager: Fit})` wrapper.[^why-not-shared-toolbar]

Unlike `TableWorkPanel`, `QueryResultGrid` had no toolbar of its own before this plan — its `content` was the bare `Table` ([`QueryResultView.ts:70`](frontend/src/dock/QueryResultView.ts#L70)). `QueryPanel.ts` does have a toolbar, but it sits above all three result tabs (Data/Chart/Explain) and is shared infrastructure ([`QueryPanel.ts:269-271`](frontend/src/dock/QueryPanel.ts#L269-L271)) — the new toggle does not belong there.

### Handlers are local functions closing over constructor locals, not arrow-function fields

`QueryResultGrid` is a **composition wrapper** (it owns `content` alone; it does not `extends` a library base) — [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) section (f) calls this out explicitly and names `QueryResultGrid` as one of its worked examples. That section is also explicit that a composition wrapper's closures "stay ordinary local functions/lets inside the constructor... not hoisted to fields or methods." So `toggleRecordView`, `stepRecord`, and `syncStepEnabled` are plain functions declared inside the constructor, closing over the constructor's own `store`/`grid`/button locals — not `private` arrow-function fields.

This is a deliberate divergence from [`table-record-detail-view.md`'s "Internal Structure"](table-record-detail-view.md#L108-L145): that plan's arrow-field style exists because `TableWorkPanel` `extends Container` and registers handlers by reference off `this` (convention (c) — a plain method would drop `this`). `QueryResultGrid` has no `this` at all; there is nothing for an arrow field to bind. `QueryPanel.ts` — the codebase's other composition wrapper with real event wiring — already establishes the local-function style this plan follows (e.g. `run`, `save`, `showRowsResult` at [`QueryPanel.ts:629-810`](frontend/src/dock/QueryPanel.ts#L629-L810), all plain functions closing over constructor locals).

### No pagination and no store-churn wiring — a real simplification over the sibling plan

Two things the sibling plan handles carefully don't apply here, and neither needs a workaround — they're just absent:

- **No page boundary.** `QueryResultGrid`'s `MemoryStore` never calls `setPageSize`, so `_pageSize` stays `undefined` and `getRecords()` ([`AbstractStore.ts:622`](../typescript-ui/packages/lib/src/typescript/lib/data/AbstractStore.ts#L622)) returns every loaded row, not a page-bounded subset. `stepIndex`'s `count` argument is simply the full result set's length; Next reaches the true last row of whatever the backend returned (`result.rowCount`, capped and flagged by `result.truncated` — see [`QueryPanel.ts:728-730`](frontend/src/dock/QueryPanel.ts#L728-L730)). There is no "stops at the loaded page" rule to state, because there is no further page to turn — [`table-record-detail-view.md`'s "Navigation stops at the loaded page"](table-record-detail-view.md#L34-L38) decision doesn't apply.
- **No store-churn listeners.** The grid is read-only and the store is never mutated after its one `autoLoad` (`MemoryStore({ ..., autoLoad: true })`, [`QueryResultView.ts:64`](frontend/src/dock/QueryResultView.ts#L64)) — no `add`, `remove`, or edit ever reaches it. `TableWorkPanel`'s sibling wires `store.on("datachange", this.syncStepEnabled)` because its `AjaxStore` changes constantly; `QueryResultGrid` only needs `grid.on("selection", syncStepEnabled)`. Wiring a `datachange`/`load`/`add`/`remove` listener here would never fire a second time and adds nothing.

### No Add button exists here, so "only Add changes meaning" doesn't apply

`QueryResultGrid` has no Add, Delete, or Save button at all — a query result has no primary key and no write-back path ([`buildQueryModel`](frontend/src/data/buildModel.ts#L40-L42) builds its `Model` with no `primaryKey`). [`table-record-detail-view.md`'s "Only Add changes meaning between the two views"](table-record-detail-view.md#L53-L64) decision, and its whole button-gating table, has nothing to carry over — the new toolbar has exactly three buttons (toggle, Previous, Next), none of which need mode-dependent gating beyond Previous/Next's own reach.

### Selection semantics: same rule as the sibling plan; the no-selection case is the common path here

The grid's selection is still the current record, using the same library fallback [`table-record-detail-view.md`'s "grid's selection is the current record"](table-record-detail-view.md#L40-L51) decision describes — entering rotated mode adopts the current selection, falling back to the first loaded record, falling back to nothing. No query-result-specific rule is invented; the existing library behavior is reused as-is.

What's different in this context is how often the fallback fires: `QueryResultGrid` is built fresh every run with nothing selected ([`QueryPanel.ts:758`](frontend/src/dock/QueryPanel.ts#L758), and `Table` selects no row on load — confirmed against `Table.ts`, which has no auto-select-first-row path). So **every** first click of the toggle on a fresh result goes through the "nothing selected → first loaded record" fallback, not just an edge case. The toggle button stays enabled regardless — including for a zero-row result, where toggling in shows no field/value rows and both steppers stay disabled (`stepIndex` returns `null` for `count === 0`) — matching the sibling plan's own choice not to disable the toggle for an empty table.

### One `QueryResultGrid` instance per run — no state to carry across runs

Every query run replaces the Data tab's content with a brand-new `QueryResultGrid` ([`QueryPanel.ts:757-779`](frontend/src/dock/QueryPanel.ts#L757-L779)); the old instance's tab is closed and disposed. The toggle's state (`recordToggle.isSelected()`) lives only on that instance's own button, so a re-run always opens fresh in grid view — there is nothing to reset and nothing to persist. This needs no code beyond building the toolbar inside the constructor, same as every other per-instance field this class already has.

### Column type resolution: no gap between a query result's columns and a table's

Both `buildModel` (tables) and `buildQueryModel` (query results) map their columns through the same `WIRE_TO_FIELD` table ([`frontend/src/data/buildModel.ts:10-18`](frontend/src/data/buildModel.ts#L10-L18)) — there is exactly one mapping from the backend's closed `WireType` set to the library's `FieldType`, shared by both. On the backend, every query result column — including a computed or aggregate expression — gets a real `WireType` from `pg_type_to_wire(attr.type.name)` applied to asyncpg's own reported result-attribute type ([`backend/app/operations/run_query.py:65`](backend/app/operations/run_query.py#L65)); there is no "unknown type" column. Neither `buildColumnSpec` (tables, [`frontend/src/dock/tableWriteRules.ts:42-51`](frontend/src/dock/tableWriteRules.ts#L42-L51)) nor `QueryResultGrid`'s own spec (`columns: []`, [`QueryResultView.ts:68`](frontend/src/dock/QueryResultView.ts#L68)) declares per-column `cellType`/`cellValues`/`values` overrides, so rotated mode's per-field cell-variant resolution — which falls back to the field's own declared type when no such override exists ([`Table.ts:1055-1074`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L1055-L1074)) — behaves identically in both contexts. No divergence, no gap.

---

## Internal Structure

`QueryResultGrid`'s rewritten constructor. `toggleRecordView`, `stepRecord`, and `syncStepEnabled` are plain functions (not arrow-field methods — see _Architecture Decisions_), matching the local-function style already used elsewhere in this file family (`QueryPanel.ts`'s `run`/`save`/`showRowsResult`, etc.).

```ts
export class QueryResultGrid {
    readonly content: Component;

    constructor(result: QueryRowsResult) {
        const store = new MemoryStore({ model: buildQueryModel(result.columns), data: result.rows, autoLoad: true });
        const grid  = Table(store, { columns: [], autoSizeColumns: true, rowReadOnly: () => true });

        const recordToggle = glyphToggleButton("table-list", PRIMARY_COLOR, "Record view (one record as field/value rows)", false);
        const prevButton   = glyphButton("angle-left",  PRIMARY_COLOR, "Previous record", () => stepRecord(-1));
        const nextButton   = glyphButton("angle-right", PRIMARY_COLOR, "Next record",     () => stepRecord(1));

        const toolbar = new ToolBar({ components: [recordToggle, prevButton, nextButton] });

        const content = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
        content.addComponent(toolbar, { placement: Placement.NORTH });
        content.addComponent(grid,    { placement: Placement.CENTER });

        recordToggle.on("action", toggleRecordView);
        grid.on("selection", syncStepEnabled);
        syncStepEnabled();

        /** Flip the grid's display mode and re-seed/re-sync the steppers. */
        function toggleRecordView(): void {
            const record = grid.getSelectedRecord();

            if (recordToggle.isSelected()) {
                grid.setDisplayMode("rotated");
            } else {
                grid.setDisplayMode("normal");
                // setDisplayMode re-selects the displayed record but does not reveal
                // it; selectRecord's normal-mode path scrolls the row back into view.
                grid.selectRecord(record);
            }

            syncStepEnabled();
        }

        /** Step the displayed record by `delta`, clamped to the loaded rows. */
        function stepRecord(delta: number): void {
            const records = store.getRecords();
            const current = grid.getSelectedRecord();
            const target  = stepIndex(current ? records.indexOf(current) : -1, delta, records.length);

            if (target !== null) {
                grid.selectRecord(records[target]);
            }
        }

        /** Enable Previous/Next only in record view, and only where a neighbour exists. */
        function syncStepEnabled(): void {
            const rotated = grid.getDisplayMode() === "rotated";
            const records = store.getRecords();
            const current = grid.getSelectedRecord();
            const index   = current ? records.indexOf(current) : -1;

            prevButton.setEnabled(rotated && stepIndex(index, -1, records.length) !== null);
            nextButton.setEnabled(rotated && stepIndex(index,  1, records.length) !== null);
        }

        this.content = content;
    }
}
```

`stepRecord` is a small, file-local convenience wrapper around `stepIndex` — it is not added to `recordNavigation.ts` because it touches `Table`, a DOM-backed library class, which disqualifies it from that module for the same reason `TableWorkPanel.ts`'s own (separately declared, non-exported) `stepRecord` isn't there either: `recordNavigation.ts` exists specifically for pure, DOM-free logic ([`recordNavigation.ts`'s header comment](frontend/src/dock/recordNavigation.ts), once the sibling plan creates it).

---

## Ordered Implementation Steps

1. **Verify the dependency landed.** Confirm `frontend/src/dock/recordNavigation.ts` exports `stepIndex` and `frontend/src/dock/glyphButton.ts` exports `glyphToggleButton` (both ship with `table-record-detail-view.md`). If either is missing, stop — this plan is not implementable until that plan has been implemented.

2. **`frontend/src/dock/QueryResultView.ts` — imports.** Add `glyphButton, glyphToggleButton` from `./glyphButton`; `stepIndex` from `./recordNavigation`; `PRIMARY_COLOR` from `../theme`; and the three glyph modules `table_list`, `angle_left`, `angle_right` from `@jimka/typescript-ui/glyphs/solid/table_list`, `.../angle_left`, `.../angle_right`. Extend the existing `Glyph.register(chart_line, chart_column);` call at [line 44](frontend/src/dock/QueryResultView.ts#L44) to `Glyph.register(chart_line, chart_column, table_list, angle_left, angle_right);` — registering the same glyph name from more than one module is already normal in this codebase (e.g. `plus`/`minus` are registered independently in five different `dock/` files), so no coordination with `TableWorkPanel.ts`'s own registration of the same three glyphs is needed.

3. **`QueryResultView.ts` — rewrite `QueryResultGrid`'s constructor** per _Internal Structure_: build `recordToggle`/`prevButton`/`nextButton`, wrap `grid` in a `Container` (`BorderLayout({ spacing: 0 })`, `NORTH` = the new `ToolBar`, `CENTER` = `grid`) exactly as `QueryResultChart`'s own `content` is built two class bodies below ([`QueryResultView.ts:98-100`](frontend/src/dock/QueryResultView.ts#L98-L100)), add `toggleRecordView`, `stepRecord`, `syncStepEnabled` as local functions, wire `recordToggle.on("action", toggleRecordView)` and `grid.on("selection", syncStepEnabled)`, and call `syncStepEnabled()` once before `this.content = content;`.

4. **`QueryResultView.ts` — update `QueryResultGrid`'s class JSDoc** ([lines 50-54](frontend/src/dock/QueryResultView.ts#L50-L54)): it currently says the instance owns "`content` (the grid) alone"; rewrite to describe the toolbar-over-grid shape and name the record-view toggle.

5. **Checkpoint** — `cd frontend && npm run typecheck && npm test`. The existing `recordNavigation` suite (from the dependency) must still pass; this plan adds no new test file since it introduces no new pure logic.

6. **`README.md`** — extend the "SQL workspace" highlight ([line 30](README.md#L30)) to mention the record view for query results, alongside the existing `EXPLAIN`/save-query/export mentions.

7. **`TODO.md`** — the "Row-detail viewer" bullet ([line 14](TODO.md#L14)) will already have been rewritten by `table-record-detail-view.md`'s own implementation to describe the table-only, read-only record view plus what's still unshipped (editing, full JSON/large-text reading). Re-read that bullet as it stands and broaden its scope to say the read-only record view now covers query results too, keeping the same unshipped items visible — don't duplicate the bullet. Check with `grep -c 'Row-detail' TODO.md` that exactly one bullet still matches.

8. **Manual verification** — per _Verification_.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/QueryResultView.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

Nothing in this plan is unit-testable: it introduces no new pure logic (`stepIndex` is reused as-is, already pinned by the sibling plan's `recordNavigation.test.ts`), and everything it adds is display-mode/toolbar state inside DOM-backed library components — the same category the sibling plan's own manual cases cover. All of the following are manual checks.

### Manual — the Data tab of a query result

Run a `SELECT` returning at least 15-20 columns (e.g. `SELECT * FROM information_schema.columns LIMIT 30`) unless stated otherwise.

1. **Toggle in with no selection.** Run the query, then click the record-view toggle without clicking any row first: the grid is replaced by field/value rows for the **first** returned row (the common case here — a fresh result never has anything selected). The toggle reads as pressed.
2. **Toggle in with a selection.** Click the 5th row, then toggle in: the values shown are that row's. Toggle out: the 5th row is selected **and visible** without scrolling.
3. **Stepping.** Next advances one record; Previous goes back. On the first row Previous is disabled; on the last row of the **entire returned result** (not a page — there is no paging here) Next is disabled.
4. **Stepper is inert in grid view.** Both stepper buttons are disabled whenever the toggle is off.
5. **Read-only.** Double-clicking any value cell does not open an editor (true in both display modes — the grid was already read-only before this plan).
6. **Empty result.** Run a `SELECT` that returns zero rows: the toggle stays enabled; toggling in shows no field/value rows; both steppers stay disabled.
7. **Truncated result.** Run a query whose result the backend truncates (`result.truncated`): Next reaches the last of the returned (truncated) rows and then disables — there is no further row to step to, and the status line's truncation notice is unaffected by display mode.
8. **Per-run reset.** Toggle into record view, then re-run the query (or run a different one): the new Data tab opens in ordinary grid view, with the toggle unpressed — the previous run's record-view state does not carry over.
9. **Export unaffected.** With the Data tab in record view, use the toolbar's Export button (CSV or JSON): the export covers the full original result set exactly as it would from grid view — `exportQueryResult` reads the captured `QueryRowsResult`, not the grid's current display mode.
10. **Chart/Explain tabs untouched.** Switch to a Chart or Explain tab while the Data tab is in record view, then switch back to Data: the Data tab is still in record view, on the same record. Nothing about switching tabs flips the Data tab's own toggle.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — the dependency's `recordNavigation` suite still passes; this plan adds no new suite.
- `grep -n 'setDisplayMode' frontend/src/dock/QueryResultView.ts` — exactly two matches, both inside `toggleRecordView`.
- `grep -c 'Row-detail' TODO.md` — exactly `1`.
- Manual: the 10 cases above, driven through the running app (see the `verify` skill). Entry point: open a Query tab, run a wide/multi-column `SELECT`.

---

## Documentation Impact

- **`README.md`** — the "SQL workspace" highlight lists what the query workspace can do; add the record view to it.
- **`TODO.md`** — broaden the already-rewritten "Row-detail viewer" bullet to cover query results, not just tables; keep its remaining unshipped items (editing, full JSON/large-text reading) visible. See step 7.
- **`CHANGELOG.md`** — no entry. SQLAdmin's changelog is written at release time, not in feature work — same precedent `table-record-detail-view.md` cites (`plans/implemented/content-derived-column-sizing.md`, `plans/implemented/elkjs-0-12-upgrade.md`).
- **`LIBRARY_NOTES.md`** — no entry. This plan consumes an already-documented library feature the same way the sibling plan does.
- **`frontend/COMPONENT_CONVENTIONS.md`** — unaffected. `QueryResultGrid` stays a composition wrapper under section (f); this plan's local-function handler style is the pattern that section already documents, not a new one.

---

## Potential Challenges

- **The `value` column reads generic for computed columns.** A query column with no natural label beyond its expression text (e.g. `count(*)`) still renders correctly typed (see the "Column type resolution" decision) — the challenge is cosmetic only: the field name shown is whatever alias-or-expression text the backend returned as the column name, unchanged from how the ordinary grid already labels that column today. No app-side fix; not a regression this plan introduces.
- **A wide `json`/`jsonArray` result column is clipped at 360px in record view**, same as the sibling plan's table case — the library caps the projection's `value` column and it is read-only, so there is no way to expand it. If manual case 1 or 2 turns up a case where this is unreadable, log it in `LIBRARY_NOTES.md` as a papercut against the library, exactly as the sibling plan's own _Potential Challenges_ directs — don't work around it in the app.
- **`selectRecord` fires `"selection"` on the way out of record view**, re-running `syncStepEnabled` once more than strictly necessary. Idempotent, harmless — same observation the sibling plan makes for `TableWorkPanel`.

---

## Critical Files

| File | Why |
|---|---|
| [`frontend/src/dock/QueryResultView.ts`](frontend/src/dock/QueryResultView.ts) | The file being changed; `QueryResultChart`'s existing `Container`/`BorderLayout` construction in the same file is the closest in-file precedent for `QueryResultGrid`'s new `content` shape. |
| [`plans/table-record-detail-view.md`](plans/table-record-detail-view.md) | The primary precedent. Every _Architecture Decisions_ subsection above states which of its decisions this plan follows as-is versus diverges from, and why. |
| [`frontend/src/dock/recordNavigation.ts`](frontend/src/dock/recordNavigation.ts) | Ships `stepIndex`, reused unchanged — a dependency of this plan, not something it modifies. |
| [`frontend/src/dock/glyphButton.ts`](frontend/src/dock/glyphButton.ts) | Ships `glyphToggleButton` (plus the existing `glyphButton`), reused unchanged. |
| [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) | The host; confirms `addTab` accepts any `Component` (so wrapping the grid in a `Container` needs no change here) and shows why the shared toolbar is the wrong home for this toggle (see the placement decision). |
| [`../typescript-ui/packages/lib/src/typescript/RotatedRecordPanel.ts`](../typescript-ui/packages/lib/src/typescript/RotatedRecordPanel.ts) | The mode's own demo: toggle + Previous/Next over `setDisplayMode` and `selectRecord`, with the simpler (no `Fit` wrapper) toolbar-over-table shape this plan follows. |
| [`../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts:388`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L388) | `setDisplayMode`, `selectRecord`, `getSelectedRecord(s)` — the exact semantics every _Expected Behaviour_ case rests on. |
| [`../typescript-ui/packages/lib/docs/components/Table.md`](../typescript-ui/packages/lib/docs/components/Table.md) | The "Rotated record view" section — confirms export always covers the source table regardless of display mode, which case 9 above relies on. |
| [`frontend/src/data/buildModel.ts`](frontend/src/data/buildModel.ts) | `buildQueryModel`/`WIRE_TO_FIELD` — the basis for the "no column type-resolution gap" decision. |
| [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) | Section (f), the composition-wrapper fallback — load-bearing for the local-function handler style, and names `QueryResultGrid` as one of its own worked examples. |

---

## Non-Goals

- **Editing in record view.** The grid was already read-only before this plan; rotated mode changes nothing observable here.
- **Paging from the record view.** `QueryResultGrid`'s `MemoryStore` has no page size at all — every loaded row is always reachable, so there is nothing to add.
- **Keyboard shortcuts for Previous/Next.** Same reasoning and the same missing mechanism as `table-record-detail-view.md`'s equivalent Non-Goal.
- **Remembering the display mode across runs.** Confirmed as a non-issue above — every run is a fresh instance.
- **Adding the toggle to `QueryResultChart` or the Explain tab.** Only `QueryResultGrid`'s Data tab gets rotated mode; charts and EXPLAIN plans have no analogous "one wide row" problem.
- **Any change to `frontend/src/dock/recordNavigation.ts` or `frontend/src/dock/glyphButton.ts`.** Both are consumed as shipped by the dependency, unchanged.
- **A `CHANGELOG.md` entry or a version bump.** Both belong to the release step.
- **Any library change.** `setDisplayMode` is already present in the app's released `@jimka/typescript-ui` dependency.

---

## Notes

[^why-not-shared-toolbar]: `QueryPanel.ts`'s shared toolbar already hosts one Data-scoped button that works regardless of which tab is active — `chartButton`, enabled by `syncChartButton` whenever `dataSlot !== null && isChartable(dataSlot.result)` ([`QueryPanel.ts:514-516`](frontend/src/dock/QueryPanel.ts#L514-L516)) — so "a Data-scoped action in the shared bar" isn't unprecedented in the abstract. But `chartButton`'s action (open/refresh the Chart tab and switch to it) makes sense with the Data tab off-screen: its result is what gets charted, not what's currently displayed. A record-view toggle is the opposite — it visibly flips the Data grid in place, and Previous/Next visibly step through it. Firing that from the shared bar while the user is looking at Chart or Explain would silently change an off-screen tab with no visible feedback, and no button in `QueryPanel.ts` is gated on "the Data tab is the active one" (Export instead *adapts its menu* per active tab via `syncExportToActiveTab`, a different mechanism). A toolbar that only exists while the Data tab itself is on screen sidesteps the question entirely, which is simpler than inventing that gating.
