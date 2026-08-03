---
depends-on: [typescript-ui-0-4-0-upgrade]
touches-shared: [TODO.md, LIBRARY_NOTES.md]
---

# Content-Derived Column Sizing — Implementation Plan

## Overview

`@jimka/typescript-ui` 0.4.0 adds `ColumnSpec.autoSizeColumns`, which sizes a table's `string` and `auto` columns from a bounded sample of the data instead of leaving them to share the leftover width equally. SQLAdmin builds every one of its grids from a live database schema and declares no widths anywhere, so it is the case the flag exists for. This plan turns it on at six of the app's nine `Table(...)` construction sites, gives the sidebar's Property/Value inspector one explicit column width instead, and replaces the schema diagram's estimated node width with a real batched measurement.

Three pieces of work, in one pass over the grid code:

- **Six grids opt in** to content-derived sizing: the main data grid's spec in [`frontend/src/dock/tableWriteRules.ts:39`](frontend/src/dock/tableWriteRules.ts#L39), the shared read-only grid at [`frontend/src/dock/columnsGrid.ts:65`](frontend/src/dock/columnsGrid.ts#L65), the linked Columns grid at [`frontend/src/dock/columnsGrid.ts:98`](frontend/src/dock/columnsGrid.ts#L98), the foreign-keys grid at [`frontend/src/dock/StructurePanel.ts:406`](frontend/src/dock/StructurePanel.ts#L406), the query-result grid at [`frontend/src/dock/QueryResultView.ts:62`](frontend/src/dock/QueryResultView.ts#L62), and the role-grants grid at [`frontend/src/dock/RoleGrantsPanel.ts:50`](frontend/src/dock/RoleGrantsPanel.ts#L50). Three do not: the Property/Value inspector and the Explain panel's two tables.
- **One explicit width.** [`frontend/src/properties/PropertyValuePanel.ts:55`](frontend/src/properties/PropertyValuePanel.ts#L55) declares a fixed width on its Property column and leaves Value flexible, which is a name/value split the app knows by hand and sampling would get wrong.
- **A measured diagram node width.** [`frontend/src/data/uniformNodeWidth.ts`](frontend/src/data/uniformNodeWidth.ts) estimates a node's width from label length so it can stay free of DOM code. It gains an optional measurer parameter, threaded through [`frontend/src/data/buildSchemaDiagram.ts:105`](frontend/src/data/buildSchemaDiagram.ts#L105) from [`frontend/src/SqlAdminController.ts:1575`](frontend/src/SqlAdminController.ts#L1575), which passes the library's new `Util.measureTextWidths`.

This plan lands after [`plans/typescript-ui-0-4-0-upgrade.md`](plans/typescript-ui-0-4-0-upgrade.md), which performs the dependency bump and walks every grid to record how 0.4.0's per-type width policy leaves it. That walk is the before picture; the sweep in [Verification](#verification) replaces it for the six grids this plan changes.

---

## Architecture Decisions

### Six grids opt in, three do not

`autoSizeColumns: true` is added per site, not to a shared wrapper the app does not have. The judgement at each site is the same question asked twice: are the values short enough that measuring them beats an equal share, and is the host wide enough to hold the result?

| # | Site | Flag | Why |
|---|---|---|---|
| 1 | `dock/tableWriteRules.ts:39` — `buildColumnSpec`, the main data grid | **on** | Arbitrary user tables, up to 60 columns. An equal share gives each column 25px on `wide.cols_60`; measured widths overflow the viewport and scroll instead.[^cap] |
| 2 | `dock/columnsGrid.ts:65` — `readOnlyTable`, shared by Columns (views/matviews), Indexes and Constraints | **on** | Type names and identifiers are short and known; index and constraint definitions are long and are capped.[^cap] All three of its grids gain, so the shared helper flips once.[^shared-helper] |
| 3 | `dock/columnsGrid.ts:98` — `linkedColumnsTable`, the Columns grid with a Sequence link | **on** | Same content as #2 plus a link column, which the library never samples and so leaves flexible to soak up the leftover width.[^renderer-columns] |
| 4 | `dock/StructurePanel.ts:406` — Foreign keys | **on** | Seven columns of identifiers and comma-joined column lists; `refTable` is a link column and stays flexible.[^renderer-columns] |
| 5 | `dock/QueryResultView.ts:62` — Query result | **on** | Result sets are as wide as the query makes them. A free-text column is capped at 400px, which is a better answer than 60 columns squeezed into the viewport.[^cap] |
| 6 | `dock/RoleGrantsPanel.ts:50` — Role grants | **on** | Three short string columns plus a `Grantable` checkbox that takes a quarter of the panel today. |
| 7 | `properties/PropertyValuePanel.ts:55` — Property/Value | **off** | A 240px sidebar host, and the store is reseeded on every selection while the library derives widths only once. See the next decision. |
| 8 | `dock/ExplainDiagramPanel.ts:287` — Explain summary | **off** | Two label columns, four rows, in a 320px pane. An equal share is already right; nothing to change. |
| 9 | `dock/ExplainDiagramPanel.ts:308` — Explain steps | **off** | In the same 320px pane. 0.4.0 already sizes `Cost` from its type and leaves `Action` the rest, which fits; measuring `Action` would push it past the pane.[^explain-steps] |

### The Property/Value inspector declares a width instead of sampling

[`PropertyValuePanel.ts`](frontend/src/properties/PropertyValuePanel.ts) lists its two columns explicitly and gives `property` a fixed `PROPERTY_COLUMN_WIDTH`; `value` is left with no width and takes the remaining space. `autoSizeColumns` stays off.

The library derives widths once per store and does not re-derive when `loadData` replaces the rows. The inspector reseeds its store on every sidebar selection, so under sampling the *first* object the user clicks would fix both column widths for the rest of the session.[^derive-once] A declared width is stable by construction, and the split it produces — a label column wide enough for the longest label the two inspectors emit, and everything else to the value — is the split the panel wants at every selection.

### StructurePanel's boolean columns get no explicit width

0.4.0 sizes a `boolean` column from the checkbox glyph and its own header text, whether or not `autoSizeColumns` is set. `Nullable`, `PK`, `Generated`, `Unique` and `Primary` therefore come out at their header width — which is what a hand-set width would have to be anyway. No configuration is added.[^booleans]

### No `maxContentLength` is wired from the column's declared type

`ColumnConfig.maxContentLength` is not set anywhere. The declared Postgres type is not reachable from the app's contract, and where it *is* reachable it would make widths worse rather than better.

`ColumnMeta.dataType` comes from `information_schema.columns.data_type` ([`backend/app/operations/list_columns.py:40`](backend/app/operations/list_columns.py#L40)), which is the SQL-standard type *name* with no modifier. Only the materialized-view branch ([`list_columns.py:117`](backend/app/operations/list_columns.py#L117)) uses `format_type`, and matviews never reach `buildColumnSpec`.[^matview-inconsistency] Separately, `numeric` and `decimal` map to `WireType.STRING` ([`backend/app/wire.py:26`](backend/app/wire.py#L26)), so a `numeric(10,2)` column is a **string** column in the grid, not a `number` one — the asymmetry that makes a declared digit budget outrank the sample never applies to it.

What a budget would actually be worth, per type, against a live table:

| Column type | `ColumnMeta.dataType` holds | Grid field type | A budget would give | Verdict |
|---|---|---|---|---|
| `character varying(60)` | `character varying` | `string` | nothing — no modifier to read | unreachable |
| `numeric(10,2)` | `numeric` | `string` | nothing — no modifier to read | unreachable |
| `text` | `text` | `string` | nothing — unbounded by definition | no budget exists |
| `integer` | `integer` | `number` | 11 digits ≈ 94px, over a sampled 3 digits ≈ 60px | wider, not better |
| `bigint` | `bigint` | `number` | 20 digits ≈ 166px on an id column holding 1–500 | clearly worse |

For a `string` column the budget is only a fallback used when sampling finds nothing, so on any table with rows it is dead weight; on an empty table the column stays flexible, exactly as it does today. For a `number` column the budget outranks the sample — and the only budget available is the type's storage range, which is a worse answer than the data.[^no-budget]

### The diagram's measurer is a parameter, defaulting to today's estimate

`uniformNodeWidth(labels, measureWidths?)` takes an optional measuring function. Without one it keeps the per-character fit it uses today, so the module stays free of DOM code and its existing tests keep running unchanged. `buildSchemaDiagram` takes the same optional parameter and passes it down; [`SqlAdminController.ts:1575`](frontend/src/SqlAdminController.ts#L1575) supplies `Util.measureTextWidths`.

The seam has to sit at both functions because the only production caller of `uniformNodeWidth` is `buildSchemaDiagram`, and the only production caller of *that* is `buildSchemaGraphData` in the controller. Both intermediate modules are pure builders under node-vitest test, so the measurer has to be threaded from the controller — the first module in the chain that is allowed to touch the DOM.[^seam]

The rule the two paths follow:

| `labels` | `measureWidths` | Result |
|---|---|---|
| `["orders"]` | omitted | `ceil(6 × 6.8 + 46 + 16)` = **103** |
| `["orders"]` | a stub returning `10 × length` | `max(96, ceil(60 + 46))` = **106** |
| `["a"]` | either | **96** — the floor wins |
| `[]` | either | **96** — the floor, and the measurer is not called |

### Measuring drops the slack; the floor stays

On the measured path `LABEL_WIDTH_MARGIN` (16px) is not applied. It exists only to cover the residual of the character-count fit, and a real measurement has no residual.[^slack] `NODE_CHROME_WIDTH` (46px) and `MIN_NODE_WIDTH` (96px) apply on both paths: the chrome is the glyph, its gap, and the node's padding and border, none of which the label measurement covers, and the floor keeps a two-character label a clickable node and gives an empty graph an answer.

### The startup font hold is not a hazard on this path

0.4.0 holds the first layout flush until the bundled Manrope face activates, because text measured before then is measured against a fallback font. Every measurement this plan adds happens well after that hold releases: a diagram is built inside `buildSchemaGraphData`, which awaits a network round trip started by a user action, and the grids are all inside dock panels, which are only ever created by a user action.[^font-hold] No code in this plan needs to wait for or check the hold.

---

## Public API

Only two app-internal signatures change. Both gain a trailing optional parameter, so every existing call site and test compiles unchanged.

```ts
// frontend/src/data/uniformNodeWidth.ts

/**
 * Measures many strings under one font, returning one width per input.
 * `Util.measureTextWidths` satisfies it; the diagram builders take it as a
 * parameter so they never import DOM-backed library code themselves.
 */
export type MeasureWidths = (texts: string[]) => number[];

export function uniformNodeWidth(labels: string[], measureWidths?: MeasureWidths): number;
```

```ts
// frontend/src/data/buildSchemaDiagram.ts

export function buildSchemaDiagram(
    tables: string[],
    structures: TableStructure[],
    columnsByTable?: Map<string, ColumnMeta[]>,
    measureWidths?: MeasureWidths,
): DiagramData;
```

The library API this plan consumes, for reference:

```ts
// @jimka/typescript-ui/component/table
interface ColumnSpec  { autoSizeColumns?: boolean; /* … */ }
interface ColumnConfig { width?: number; /* … */ }

// @jimka/typescript-ui/core
namespace Util { function measureTextWidths(texts: string[], options?: TextMeasureOptions): number[]; }
```

---

## Ordered Implementation Steps

### Part A — the six grid opt-ins

1. **`frontend/src/dock/tableWriteRules.ts`** — in `buildColumnSpec`, add `autoSizeColumns: true` to the returned object, above the `columns` key. Extend the function's doc comment with one sentence: the data grid is generated from a live schema and declares no widths, so its `string`/`auto` columns size themselves from the loaded page rather than sharing the viewport equally.

2. **`frontend/tests/dock/tableWriteRules.test.ts`** — add one case to the `buildColumnSpec` block asserting `buildColumnSpec([column()], true).autoSizeColumns` is `true`. Follow the file's existing `column()` helper.

3. **`frontend/src/dock/columnsGrid.ts:65`** — `readOnlyTable` becomes `Table(store, { columns: [], autoSizeColumns: true, rowReadOnly: () => true })`. Extend its doc comment to name the three grids it serves (relation Columns, Indexes, Constraints) and say the flag applies to all three.

4. **`frontend/src/dock/columnsGrid.ts:98`** — add `autoSizeColumns: true` to `linkedColumnsTable`'s spec, beside `appendUnlisted: false`. Add a sentence to the function's doc comment: the `sequence` column carries a renderer, so the library never samples it and it stays flexible, absorbing the width the other six do not use.

5. **`frontend/src/dock/StructurePanel.ts:406`** — add `autoSizeColumns: true` to the foreign-keys grid spec, beside `appendUnlisted: false`. Extend the comment block immediately above the `Table(...)` call with the same note about `refTable`'s renderer.

6. **`frontend/src/dock/QueryResultView.ts:62`** — `Table(store, { columns: [], autoSizeColumns: true, rowReadOnly: () => true })`. Add a comment line: a result set's shape is unknown until it arrives, so its columns are sized from the returned rows; a free-text column is capped by the library at 400px.

7. **`frontend/src/dock/RoleGrantsPanel.ts:50`** — `Table(store, { columns: [], autoSizeColumns: true, rowReadOnly: () => true })`.

8. **Checkpoint.** `cd frontend && npm run typecheck && npm test`. Then `grep -rn 'autoSizeColumns: true' src/` — expect exactly **six** matches, at the six sites above. Zero matches in `src/properties/` or `src/dock/ExplainDiagramPanel.ts`.

### Part B — the Property/Value inspector's declared width

9. **`frontend/src/properties/PropertyValuePanel.ts`** — add a module constant beside `PANEL_HEIGHT`:

    ```ts
    // Width (px) of the Property column. Wide enough for the longest label either
    // inspector emits — "Connection limit" (roles/roleBaseInfoRows.ts) at 16
    // characters — plus the cell's own padding, leaving the larger half of the
    // 240px sidebar deck (ActivityBar's DECK_WIDTH) to the Value column. Declared
    // rather than sampled because the store is reseeded on every selection and the
    // library derives widths only once per store, so a sampled width would be
    // frozen at whatever the first selected object happened to hold.
    const PROPERTY_COLUMN_WIDTH = 120;
    ```

    Then replace `columns: []` in the `Table(...)` call with:

    ```ts
    columns: [
        { field: "property", width: PROPERTY_COLUMN_WIDTH },
        { field: "value" },
    ],
    ```

    Leave `rowReadOnly: () => true` in place and do **not** add `autoSizeColumns`.

10. **Checkpoint.** `cd frontend && npm run typecheck && npm test`.

### Part C — the measured diagram node width

11. **`frontend/src/data/uniformNodeWidth.ts`** — export the `MeasureWidths` type ([Public API](#public-api)) and add the optional second parameter. The body becomes: return `MIN_NODE_WIDTH` when `labels` is empty; otherwise take the widest label width — from `Math.max(...measureWidths(labels))` when a measurer was given, or `longestLength * LABEL_CHAR_WIDTH + LABEL_WIDTH_MARGIN` when it was not — add `NODE_CHROME_WIDTH`, `Math.ceil`, and floor at `MIN_NODE_WIDTH`. Keep the four constants and their comments; extend `LABEL_WIDTH_MARGIN`'s comment to say it applies only on the estimating path, and update the module header so it no longer claims the width is always estimated. Split the two width paths into a named helper if the function passes ~15 lines.

12. **`frontend/src/data/buildSchemaDiagram.ts`** — import `MeasureWidths` as a type from `./uniformNodeWidth`, add the fourth optional parameter to `buildSchemaDiagram` ([Public API](#public-api)), and pass it through at line 117: `uniformNodeWidth(tables, measureWidths)`. Document the parameter in the JSDoc: omitting it keeps the estimated width, which is what the builder's own tests do; the app supplies `Util.measureTextWidths`. Update the `nodeWidth` comment block above line 117 accordingly.

13. **`frontend/src/SqlAdminController.ts`** — add `Util` to the existing `@jimka/typescript-ui/core` import on line 7, and change the call at line 1575 to pass `Util.measureTextWidths` as the fourth argument to `buildSchemaDiagram`. Add a short comment saying the measurer is injected here because this is the first module in the chain allowed to touch the DOM.

14. **`frontend/tests/data/uniformNodeWidth.test.ts`** — keep all seven existing cases unchanged and add the three measured cases from [Expected Behaviour](#unit-testable). Use a stub measurer, never a real one; the test runner has no DOM.

15. **Checkpoint.** `cd frontend && npm run typecheck && npm test && npm run build`. Then `grep -rn 'measureTextWidths' src/` — expect exactly **one** match, in `SqlAdminController.ts`.

### Part D — record what the adoption surfaced

16. **`LIBRARY_NOTES.md`** — add a `## ✂️🔎` entry at the top of the file (newest first), following the shape of the existing entries: what was hit, why, and what the library fix would look like. The finding: a table over a paged remote store derives its column widths from the first page only. The library re-derives once after the first load that finds records and then never again for that store, so the main data grid and the role-grants grid size themselves from the first 50 of page 1's 100 rows and keep those widths through every page, sort and filter that follows. Note the trade the library is making — stable widths while paging — and that the consumer has no way to ask for a re-derive short of `setStore`.

17. **`TODO.md`** — add one bullet under `## Known issues / loose ends`: `ColumnMeta.dataType` is inconsistent between relation kinds. Tables and views take it from `information_schema.columns.data_type` (a type name with no modifier); materialized views take it from `format_type`, which includes one. `pg_type_to_wire` matches type names exactly, so a matview column declared `timestamp(3) with time zone` falls through to `STRING` instead of `ISO_STRING`. Narrow — it needs an explicit precision on a matview column — and no fix is planned here.

### Part E — the verification sweep

18. **Bring the stack up and log in** per [`.claude/skills/verify/SKILL.md`](.claude/skills/verify/SKILL.md) — Postgres, backend, `npm run dev`, Host `sqladmin-db`. Then walk every row of [Expected Behaviour › grids](#manual-verify--grids) at a viewport of 1500×800.

19. **Walk the diagram cases** in [Expected Behaviour › diagram](#manual-verify--the-diagram-node-width).

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `frontend/src/dock/tableWriteRules.ts` (`autoSizeColumns` in `buildColumnSpec`) |
| Modify | `frontend/src/dock/columnsGrid.ts` (both table builders) |
| Modify | `frontend/src/dock/StructurePanel.ts` (foreign-keys grid) |
| Modify | `frontend/src/dock/QueryResultView.ts` (query-result grid) |
| Modify | `frontend/src/dock/RoleGrantsPanel.ts` (role-grants grid) |
| Modify | `frontend/src/properties/PropertyValuePanel.ts` (`PROPERTY_COLUMN_WIDTH`, explicit columns) |
| Modify | `frontend/src/data/uniformNodeWidth.ts` (`MeasureWidths`, optional measurer) |
| Modify | `frontend/src/data/buildSchemaDiagram.ts` (thread the measurer) |
| Modify | `frontend/src/SqlAdminController.ts` (`Util` import; pass the measurer) |
| Modify | `frontend/tests/dock/tableWriteRules.test.ts` (one case) |
| Modify | `frontend/tests/data/uniformNodeWidth.test.ts` (three cases) |
| Modify | `LIBRARY_NOTES.md` (first-page-only derivation) |
| Modify | `TODO.md` (matview `dataType` inconsistency) |

No files are created or deleted. Nothing in `frontend/src/dock/ExplainDiagramPanel.ts` changes.

---

## Expected Behaviour

### Unit-testable

`frontend/tests/dock/tableWriteRules.test.ts`, one added case:

| Case | Assertion |
|---|---|
| the data grid opts into content sizing | `buildColumnSpec([column()], true).autoSizeColumns` is `true` |

`frontend/tests/data/uniformNodeWidth.test.ts`, three added cases on top of the seven existing ones (which must all still pass unchanged, since they call with no measurer):

| Case | Assertion |
|---|---|
| an injected measurer decides the width | with a stub returning `text.length * 10`, `uniformNodeWidth(["orders"], stub)` is `106` — `6 × 10` plus 46px of chrome, above the 96px floor |
| the widest measured label wins, not the longest one | with a stub returning `200` for `"WW"` and `50` for `"aaaaaaaa"`, `uniformNodeWidth(["WW", "aaaaaaaa"], stub)` is `246` — the `200` plus chrome, not the `50` the longer string measured |
| an empty graph does not call the measurer | `uniformNodeWidth([], stub)` is `96` and the stub records zero calls |

The three cases above pin the rule table in [Architecture Decisions](#the-diagrams-measurer-is-a-parameter-defaulting-to-todays-estimate). Nothing else in this plan is unit-testable: column widths are rendered geometry, and the project's test runner has no DOM.

### Manual-verify — grids

Every row is a live check. "Correct" is judged against the description, not against memory of the previous build — wider columns and a new horizontal scrollbar are the intended outcome, not a regression.

| Grid | How to open | Correct looks like |
|---|---|---|
| Main data grid | Navigator → `sales` → `invoices` → Data | Each column about as wide as its widest value; `numeric` money columns narrow; no column stretched to a viewport share it does not need. |
| Main data grid, wide | Navigator → `wide` → `cols_60` → Data | The grid is wider than the viewport and scrolls horizontally. Every header is readable. Nothing collapses to a sliver. |
| Main data grid, empty | Create an empty table, open its Data tab | Columns share the width equally, as before — an empty store yields no sample, so `string` columns stay flexible. No blank or zero-width column. |
| Columns (with Sequence link) | Any table → Structure → Columns | `Column`, `Type` and `Wire type` sized to their values; the three boolean columns narrow; the `Sequence` link column takes the remaining width and its links are not clipped. |
| Columns (read-only) | A view → Definition → Columns | As above, without the link column. |
| Indexes | Any table → Structure → Indexes | `Definition` is the wide column, at most 400px; `Name` fits its values; `Unique` and `Primary` are checkbox-narrow, not a quarter of the panel each. |
| Constraints | Any table → Structure → Constraints | Same shape as Indexes. |
| Foreign keys | `sales` → `order_items` → Structure → Foreign keys | Identifier columns sized to their values; the `Ref table` link column takes the remainder and stays readable. |
| Query result | Run `select * from wide.cols_60` | 60 columns, horizontal scroll, headers intact. |
| Query result, free text | Run `select definition from pg_views limit 20` | The single column is capped at 400px and then grows to fill the panel; the panel does not scroll horizontally for one column. |
| Role grants | Roles → any role → Grants | Four columns fit the panel with no horizontal scrollbar; `Grantable` is checkbox-narrow. |
| **Property/Value** | Click a database, then a schema, then a function in the navigator | The Property column holds `Connection limit` and `Primary key` without clipping, at the **same width for all three selections**. Value takes the rest. |
| **Explain summary** | Run any query → Explain → the diagram panel | Unchanged from before this plan: two equal columns in the 320px pane. |
| **Explain steps** | Same panel | `Cost` is digit-narrow, `Action` takes the rest, and the pane does not scroll horizontally. Revealing a hidden column from the header context menu still lands sensibly. |

The last three rows are the controls — they must **not** change.

### Manual-verify — the diagram node width

| Case | How to open | Correct looks like |
|---|---|---|
| Node width fits the label | Navigator → `mesh` → Show ▸ Schema diagram | Every node is the same width, and no label is clipped or ellipsised — check the longest table name in the schema specifically. |
| Nodes are no wider than they need | Same diagram | Nodes are visibly *tighter* than before this plan: the trailing whitespace after the longest label is a few pixels, not a character's worth. |
| A deep schema still lays out | Navigator → `hub` → Show ▸ Schema diagram | The diagram renders; the extra batched measurement adds no perceptible delay to opening it. |
| Card mode is untouched | Right-click a table → Show ▸ Relations | Cards are still `CARD_WIDTH`; the measurer changes nothing here. |

---

## Verification

| # | Where | Command / action | Expect |
|---|---|---|---|
| 1 | `frontend` | `npm run typecheck` | clean |
| 2 | `frontend` | `npm test` | green — the existing suites plus the four added cases |
| 3 | `frontend` | `npm run build` | succeeds |
| 4 | `frontend` | `grep -rn 'autoSizeColumns: true' src/` | exactly 6 matches, all in the six sites named in Part A |
| 5 | `frontend` | `grep -rn 'autoSizeColumns' src/properties/ src/dock/ExplainDiagramPanel.ts` | zero matches |
| 6 | `frontend` | `grep -rn 'maxContentLength' src/` | zero matches |
| 7 | `frontend` | `grep -rn 'measureTextWidths' src/` | exactly 1 match, in `SqlAdminController.ts` |
| 8 | repo root | `grep -c '^## ' LIBRARY_NOTES.md` | one more than before step 16 |
| 9 | browser | [Expected Behaviour › grids](#manual-verify--grids) | every row walked, including the three controls |
| 10 | browser | [Expected Behaviour › diagram](#manual-verify--the-diagram-node-width) | every row walked |

Rows 1–8 prove the wiring. Rows 9–10 are the substantive check: this plan changes how every grid in the app is proportioned, and nothing automated in this repo can see rendered geometry.

---

## Documentation Impact

No public app API changes, and the repo publishes no API reference. The documentation work is the two records in Part D — the `LIBRARY_NOTES.md` entry and the `TODO.md` bullet. The app's own `CHANGELOG.md` entry for this change belongs to the release step the user performs by hand, not to this plan.

---

## Potential Challenges

- **Wider grids mean more horizontal scrolling, and horizontal scrolling is under investigation.** Plan 1's Part E measures a reported sluggishness there. This plan increases how often a user scrolls horizontally, so it makes any such cost more visible — it does not cause it. If scrolling feels worse after this plan, check plan 1's recorded measurement before assuming a new defect.
- **A column can still be too narrow for a value it does not hold yet.** Widths come from the first page's first 50 rows and are not re-derived. A later page holding a longer value gets an ellipsis. This is the library behaviour recorded in step 16; the user can drag the column.
- **`PROPERTY_COLUMN_WIDTH` is a hand-measured number tied to one label string.** If a future inspector row carries a longer label than `Connection limit`, the label clips. The constant's comment names the file the longest label lives in, so the pairing is discoverable.
- **The 46px node chrome was fitted jointly with the per-character slope**, so re-using it beside a real measurement is an approximation, not an identity. The diagram checks are what confirm it: a clipped label means the chrome is too small, and visible trailing whitespace means it is too large.
- **`uniformNodeWidth` is called for card-mode diagrams too**, where `applyCardMode` immediately overwrites the width with `CARD_WIDTH`. The measurement is wasted there but costs one batched call; leave it rather than adding a branch.

---

## Critical Files

- [`plans/typescript-ui-0-4-0-upgrade.md`](plans/typescript-ui-0-4-0-upgrade.md) — the plan this one depends on. Its grid walk is the before picture for the sites here.
- [`plans/implemented/table-required-cell-adoption.md`](plans/implemented/table-required-cell-adoption.md) — the precedent this plan follows: a library table capability adopted through `buildColumnSpec`, with the per-site interactions reasoned out in `## Architecture Decisions` and the pure logic kept in `tableWriteRules.ts` so vitest can reach it.
- [`plans/implemented/menubutton-adoption.md`](plans/implemented/menubutton-adoption.md) — the precedent for the per-site decision table: a library capability adopted at several call sites at once, with the form chosen per site and stated in one table.
- `../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts` — `getIntrinsicColumnWidths`, `columnWidthPolicy`, `resolveContentCandidates`, `samplesRecordText` and `maybeResampleColumnWidths`. The width constants at the top of the file (`AUTO_WIDTH_CAP_PX`, `SAMPLE_ROWS`, `MIN_STRING_CHARS`) are the numbers every judgement in this plan rests on.
- `../typescript-ui/packages/lib/src/typescript/lib/layout/Table.ts` — `initializeWidths` and `absorbSlackIntoGreedy`, which decide what happens to width left over once the derived widths are in.
- `../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnConfig.ts` — the doc comments for `width`, `maxContentLength` and `autoSizeColumns`.
- [`frontend/src/data/buildSchemaDiagram.ts:47-55`](frontend/src/data/buildSchemaDiagram.ts#L47) — the purity rule the diagram builders follow, and why a measurer has to be passed in rather than imported.
- [`.claude/skills/verify/SKILL.md`](.claude/skills/verify/SKILL.md) — stack startup, the `sqladmin-db` login host, and the browser-driving gotchas the sweep depends on.
- [`LIBRARY_NOTES.md`](LIBRARY_NOTES.md) — the status legend and entry shape step 16 must follow.

---

## Non-Goals

- **Setting `ColumnConfig.maxContentLength` anywhere**, and any backend change that would make a declared type budget reachable — a new contract field, or switching `list_columns.py` to `format_type`. The budget is worth less than the change costs; see the decision above.
- **Fixing the matview `dataType` inconsistency.** Step 17 records it; a fix touches `wire.py`'s type matching and belongs to its own plan.
- **Changing the library's re-derive behaviour, or working around it in the app.** Step 16 files the finding upstream. Nothing here calls `setStore` to force a re-derive.
- **`Table.isAutoSizeColumns()`, `getColumnMinWidth()` and `getIntrinsicColumnWidths()`.** They exist for a custom table layout. SQLAdmin writes none, so none is called.
- **Uniform node widths for the other flat diagrams** — database, dependency, inheritance, role membership, role grants, Explain. Only `buildSchemaDiagram` sets a node width today, and giving the others one is a separate design question about whether their nodes should align at all.
- **Anything in `dock/ExplainDiagramPanel.ts`.** Both of its tables are correct under 0.4.0's type policy alone.
- **Re-deriving the pre-adoption column-width baseline.** Plan 1 records it; this plan's sweep supersedes it for the six grids that change.

---

## Notes

[^cap]: The library caps a content-derived width at `AUTO_WIDTH_CAP_PX` (400px) whenever the column declares no `maxWidth` of its own (`Table.clampColumnWidth`), and it measures at most the three longest of at most 50 sampled values (`WIDEST_CANDIDATES`, `SAMPLE_ROWS`). So the unbounded-free-text worry — a `text` column holding a 4,000-character document — resolves itself: that column comes out at 400px, not 4,000. The cap is also why a 60-column grid stays navigable rather than becoming arbitrarily wide. Leftover width is not wasted either: `absorbSlackIntoGreedy` in the table layout hands any surplus to the `string`/`auto` columns that declare no `maxWidth`, so a grid whose derived widths total less than its host still fills it.

[^shared-helper]: `readOnlyTable` is called from three places — `buildColumnsGrid` (relation Columns, for views and matviews), `StructurePanel.ts:337` (Indexes) and `StructurePanel.ts:360` (Constraints). Splitting it into flagged and unflagged variants was rejected: all three grids hold short identifiers plus one long definition-style column, which is exactly the shape content sizing handles well, and a second helper would leave the two indistinguishable at the call site. The helper keeps one owner and one behaviour.

[^renderer-columns]: The library never samples a column that declares a `renderer` (`Table.samplesRecordText` returns `false` for one), because the rendered text is not derived from the raw value. With no sample, no `values` list and no `maxContentLength`, `resolveContentCandidates` returns `null` and the column stays flexible. Both link columns in this app — `sequence` in `linkedColumnsTable` and `refTable` in the foreign-keys grid — therefore keep sharing the leftover width while their neighbours size to content. That is the outcome we want at both sites: one flexible column absorbing the surplus reads better than a grid that stops short of its host's right edge.

[^derive-once]: `Table.maybeResampleColumnWidths` re-derives once, on the first `'load'`/`'add'`/`'remove'`/`'datachange'` that finds records, and then sets a guard that only `Table.setStore` clears. `PropertyValuePanel.setRows` calls `store.loadData(rows)` on a store that already holds the previous selection's rows, so every selection after the first would keep the first one's widths. Concretely: click a database first (three rows, longest label `Connection`) and a role's `Connection limit` clips for the rest of the session; click a role first and every database's Value column is needlessly narrow. The library's guard is deliberate — it keeps widths stable while paging — which is why this is a reason to declare a width here rather than a bug to work around.

[^booleans]: The library's boolean policy is `min = CHECKBOX_WIDTH_PX (16) + CELL_CHROME_PX (6)` and `preferred = max(min, headerPx)`, where `headerPx` is the measured bold header text plus `HEADER_CHROME_PX` (21). For `Nullable` that lands near 76px — the header is the binding constraint, not the checkbox. A hand-set width would have to be the same number, derived the same way, and would then rot if the header text or theme font changed. Declaring nothing gets the right answer and keeps getting it.

[^explain-steps]: The steps table shows `Action` (string) and `Cost` (number) inside a 320px accordion pane (`LEFT_WIDTH`), with seven further columns the user can reveal. Under 0.4.0's type policy alone, `Cost` is sized from its sampled digit count — roughly 60–80px — and `Action` stays flexible and takes the rest, which fits the pane. With `autoSizeColumns` on, `Action` would be measured against values like `Seq Scan on order_items`, land near 200px, and push the pair past 320px into a horizontal scroll inside a narrow pane. The type policy alone is already an improvement over today's equal share; content sizing would undo it.

[^no-budget]: The digit widths quoted in the type table use the library's own arithmetic: `preferred = digitPx * digits + CELL_CHROME_PX`, with `digitPx` the widest digit glyph at the theme body font (≈8px at 14px Manrope). `bigint`'s 20-digit storage range therefore asks for ≈166px, against ≈60px for an id column whose sampled values are three digits long and whose header is `id`. Because `maxContentLength` *outranks* the sample on a `number` column, supplying the storage range would replace a truthful measurement with a pessimistic one at every integer column in the app — and integers are the most common column type in the demo data by a wide margin (2,995 of 6,510 columns). A census of the demo schemas found only `character varying` carrying a length modifier at all (262 columns, lengths 16–32), and those are `string` columns whose sample already sizes them exactly. The one case a budget would improve is a `string` column on a table with zero rows, where the column stays flexible today and would stay flexible after; that is not worth a backend contract change.

[^matview-inconsistency]: `ListColumnsQuery._SQL` reads `c.data_type` from `information_schema.columns`, which by SQL-standard definition carries no type modifier — confirmed against the running demo database, where a `numeric(12,2)` column reports `data_type = 'numeric'` with the precision and scale in separate columns. `_MATVIEW_SQL` cannot use `information_schema.columns`, which omits materialized views, so it reads `format_type(a.atttypid, a.atttypmod)` instead — and that *does* include the modifier. The two branches therefore produce different strings for the same underlying type. `pg_type_to_wire` matches against exact type names, so a matview column declared with an explicit precision misses its set and falls through to the `STRING` default. For character and numeric types the fall-through happens to land on the right answer; for a temporal type it does not. Step 17 records this; fixing it is another plan's work.

[^seam]: The call chain was traced rather than assumed. `uniformNodeWidth` has exactly one production caller, `buildSchemaDiagram` at line 117 (plus four calls from two test files). `buildSchemaDiagram` has exactly one production caller, `SqlAdminController.buildSchemaGraphData` at line 1575. Both `uniformNodeWidth.ts` and `buildSchemaDiagram.ts` live in `frontend/src/data/`, are unit-tested under the node-environment runner, and carry an explicit header rule against importing UI-bundle code — importing `Util` into either would break their tests at module load. `SqlAdminController.ts` already imports from `@jimka/typescript-ui/core`, so it is the natural injection point. Two alternatives were rejected: having the controller call `uniformNodeWidth` itself and pass a plain `nodeWidth` number to `buildSchemaDiagram` moves the "which labels get measured" knowledge into the controller and duplicates it; and a module-level `setLabelMeasurer()` registered at startup introduces global mutable state that every test would have to reset.

[^slack]: `LABEL_WIDTH_MARGIN` covers the residual of a least-squares fit of width against *character count*: a proportional font makes `WWWW` render far wider than the per-character average predicts, and the fit's residual reached 14.2px on real table names. A measurement of the actual string has no such error, so applying the margin on top of it would add 16px of whitespace to every node in the graph for nothing. `MIN_NODE_WIDTH` is kept on both paths for a different reason — it is about clickability and about giving an empty graph an answer, neither of which measurement addresses.

[^font-hold]: 0.4.0 holds the first layout flush until the font set reports the load settled, bounded at 50 ms of idle time after startup. Text measured inside that window would be measured against the browser's fallback face. Nothing in this plan can land inside it: `buildSchemaGraphData` awaits `getSchemaGraph(ref)`, a network round trip that a user has to trigger by opening a diagram, and `data/layoutStore.ts` persists only splitter positions and accordion open state — never open dock tabs — so every panel holding a grid is created by a user action after load. The grids do not measure anything themselves in any case; the library measures on their behalf, from its own layout pass, which the hold already covers.
