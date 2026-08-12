---
touches-shared:
  - frontend/src/dock/TableWorkPanel.ts
  - frontend/src/dock/tableWriteRules.ts
  - backend/app/sql/compiler.py
  - README.md
---

# Table Quick Search & Column Filters — Implementation Plan

## Overview

The Data tab's grid gets two new ways to narrow what it shows, and loses one old one.

**Quick search** is new app code: a plain text field in the panel toolbar that hides rows already loaded in the browser, live, with no network request. It is built on the library's `Table.setRowVisible(predicate)`, a display-only row filter that never touches the store.

**Column filters** are a library feature this plan switches on: a header filter row with one text input plus an operator picker per column, hidden until the user asks for it. Each committed keystroke writes a `FilterDescriptor` into the store, which — because every store in this app is paginated — **reloads page 1 from the server**. Column filters are therefore a *remote* mechanism, mechanically the same kind of thing as the Filter button this app ships today.

Because both write into the same store filter state, they cannot both stay. The toolbar's Filter button and its modal [`FilterDialog.ts`](frontend/src/dock/FilterDialog.ts) are **replaced** by the header filter row, and the Filter glyph becomes a toggle that shows and hides that row (see _Architecture Decisions_). Quick search is unaffected by the swap — it is local, and composes with whatever the remote filter has fetched.

Three files carry most of the work: a new pure module `frontend/src/dock/quickSearchModel.ts`, the panel [`TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts), and the backend's [`compiler.py`](backend/app/sql/compiler.py), which must learn the descriptor shapes the library's filter row emits and it cannot compile today.

---

## Architecture Decisions

### Quick search is local; column filters are remote

Quick search decides which of the **already-loaded** rows the grid renders. Column filters decide which rows the **server sends**. Both can be active at once: the visible rows are whatever the quick-search text matches among whatever the server returned. Clearing one never clears the other.

The store's own filter API cannot express a network-free filter. `AbstractStore.applyFilterChange()` reloads whenever `remoteFilter` **or** `pageSize` is set, and [`stores.ts:36`](frontend/src/data/stores.ts#L36)'s `buildStore` passes `pageSize: PAGE_SIZE` into every `AjaxStore` unconditionally.[^filter-always-reloads] So quick search goes through `Table.setRowVisible`, and column filters go through the store.

### The header filter row replaces the Filter dialog

The toolbar's Filter button stops opening [`FilterDialog.ts`](frontend/src/dock/FilterDialog.ts) and becomes a `ToggleButton` that calls `Table.setFilterRowVisible(...)`. `FilterDialog.ts`, [`filterModel.ts`](frontend/src/dock/filterModel.ts), and `frontend/tests/dock/filterModel.test.ts` are deleted.

Keeping both entry points is not possible with the library's public API.[^why-replace-dialog] `FilterDialog`'s Apply and Clear both call `store.clearFilter()`, which wipes every active filter — including the header row's own slots, each keyed by its column's field name — and there is no way to clear only the dialog's. And the header row deliberately never reconstructs its input text from a descriptor someone else wrote, so a dialog-set filter on a column would leave that column's input blank over filtered data.

The dialog's original justification has also expired. Its own header comment says it was "chosen over an inline per-column filter row because the library's header / column geometry is not an app seam", citing [`plans/implemented/grid-filter-sort.md`](plans/implemented/grid-filter-sort.md), whose Architecture Decisions rejected a filter row for exactly that reason. The library now exposes one.

### Only number, string, and boolean columns are filterable

[`buildColumnSpec`](frontend/src/dock/tableWriteRules.ts#L42) marks a column `filterable` when its `wireType` is `number`, `string`, or `boolean`. `isoString`, `json`, `jsonArray`, and `base64` columns get no filter input.[^why-filterable-subset]

The app cannot narrow *which operators* a filterable column offers — the library derives them from the model field's type alone (`ColumnFilter.ts`'s `columnFilterOperators`, line 83). Gating whole columns is the only lever this app has.

| `wireType` | Model `FieldType` ([`buildModel.ts:10`](frontend/src/data/buildModel.ts#L10)) | Filterable? | Operators the header then offers |
|---|---|---|---|
| `number` | `number` | yes | equals, not equals, `>`, `≥`, `<`, `≤`, is empty, is not empty |
| `string` | `string` | yes | contains, starts with, ends with, equals, not equals, is empty, is not empty |
| `boolean` | `boolean` | yes | equals, not equals, is empty, is not empty |
| `base64` | `string` | **no** | — |
| `isoString` | `datetime` | **no** | — |
| `json` / `jsonArray` | `auto` | **no** | — |

### The SQL compiler compares a column's text form when the operand is text

[`FilterCompiler._node`](backend/app/sql/compiler.py#L118) gains one rule: when the value bound for a comparison is a Python `str`, the column is compared as `"col"::text`; otherwise it is compared natively.[^why-text-cast]

| Descriptor | Compiled fragment |
|---|---|
| `{type: "eq", field: "name", value: "ada"}` | `"name"::text = $1` |
| `{type: "eq", field: "id", value: 42}` | `"id" = $1` |
| `{type: "eq", field: "active", value: true}` | `"active" = $1` |
| `{type: "contains", field: "id", value: "4"}` | `"id"::text ILIKE $1 ESCAPE '\'` |

Without the rule, a `contains` filter on a `uuid` or `numeric` column (both `wireType: "string"`, both offered `contains` by the header) fails in Postgres — there is no `ILIKE` operator for those types.

### The SQL compiler learns `endsWith` and null-bearing `in`

Two more descriptor shapes the header row emits and the compiler rejects today:

- **`endsWith`** joins the existing `contains` / `startsWith` branch with a `%value` pattern. Unhandled today, it raises `ValidationError` → HTTP 422.
- **`in` with nulls in `values`.** "Is empty" compiles to `{type: "in", field, values: [null, undefined, ""]}` (`undefined` arrives as `null` over JSON), and "is not empty" wraps that in `not`. `= ANY(...)` never matches `NULL`, so the current branch silently misses every null row.

| Field | `values` | Compiled fragment |
|---|---|---|
| `name` | `[null, null, ""]` | `("name"::text IS NULL OR "name"::text = ANY($1))`, `$1 = [""]` |
| `id` | `[1, 2, 3]` | `"id" = ANY($1)`, `$1 = [1, 2, 3]` |
| `name` | `[null]` | `"name" IS NULL` |
| `name` | `[]` | `FALSE` |

The `::text` decision above applies here too: the cast is used when every non-null value is a `str`.

### Quick search matches a case-insensitive substring across every loaded primitive field

For a non-empty query, a record matches if **any** field's value, lower-cased and stringified, contains the lower-cased query. Only `string`, `number`, and `boolean` values participate; `null`/`undefined` are skipped, and so is any value that is a JS object — after `Field.convertValue`'s ingestion-time coercion that means the `date`/`datetime`/`time` fields (real `Date` objects) and the `json`/`jsonArray` fields (parsed objects and arrays).[^why-skip-objects] A blank or whitespace-only query matches every row.

Worked example, table `customers(name string, email string, signup_count number, active boolean, created_at isoString, metadata json)`:

| Query | Column (wireType) | Stored value | Participates? | Result |
|---|---|---|---|---|
| `"smith"` | `name` (string) | `"John Smith"` | yes | **matches** (`"john smith"` contains `"smith"`) |
| `"smith"` | `email` (string) | `"js@corp.com"` | yes | no match |
| `"smith"` | `signup_count` (number) | `3` | yes, as `"3"` | no match |
| `"smith"` | `active` (boolean) | `true` | yes, as `"true"` | no match |
| `"smith"` | `created_at` (isoString → `Date`) | `Date` object | **no** (excluded) | — |
| `"smith"` | `metadata` (json) | `{"nickname":"Smith"}` | **no** (excluded) | — |
| `""` (empty) | — | — | — | every loaded row matches |

A record matches if it matches on **any** field — the `customers` row above matches `"smith"` on `name` alone.

### Quick search never force-loads the rest of the table

`AjaxStore` holds at most one page: `ingestRaw` replaces `_allRecords` wholesale on every `load()`, and `buildStore` sets `pageSize: 100` with no `PaginationBar` in this panel. Quick search searches exactly `store.getRecords()` and never triggers a bulk load.[^why-not-force-load] When the server holds more rows than are loaded, the status label says so rather than silently searching a partial set.

### Quick-search logic lives in a DOM-free module

`matchesQuickSearch` and `quickSearchStatus` go in a new `frontend/src/dock/quickSearchModel.ts`, mirroring [`tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts) — a pure module split out of `TableWorkPanel.ts` so vitest's node environment can cover it, because `TableWorkPanel.ts`'s top-level imports touch `document` at module-load time.

### The toolbar gains a text field, which no toolbar in this app has today

Every `ToolBar` in `frontend/src` currently holds only buttons, separators, and spacers.[^toolbar-input-precedent] The library documents non-button children as supported (`ToolBar.md`: "Children can be any `Component`"), so `quickSearchField` and its status label go straight into the existing bar rather than into a second strip.

Left-to-right order after this plan: record-view toggle, Previous, Next, separator, Add, Delete, Save, `Spacer.flex()`, **quick-search field, quick-search status**, filter-row toggle, Export, Refresh. The two new components are inserted immediately after `Spacer.flex()` at [`TableWorkPanel.ts:131`](frontend/src/dock/TableWorkPanel.ts#L131); `filterToggle` takes `filterButton`'s existing slot.

### One method owns every visual state of the filter toggle

`syncFilterActive` is the single writer for the filter toggle's selected state, enabled state, colour, and description. It runs at construction, on the store's `'filterchange'`, and at the end of `toggleRecordView`.

Giving the rotated-mode gating its own sync method — the shape `syncAddEnabled` uses for the Add button — would put two writers on one button's `setDescription`, and whichever ran last would win.

### Rotated mode neutralizes both mechanisms, and the library already does it

`Table.setRowVisible`'s predicate has no effect while `getDisplayMode() === "rotated"` — the projection's rows are one per source *field* of one record, not one per record. The filter row collapses in rotated mode too: the projection's columns are built from an internal spec that declares no `filterable`, so `Header.hasFilterRow()` returns `false` and the row drops to zero height. Both restore on return to grid view.

This plan therefore adds no coordination code. It does disable the filter toggle while rotated, mirroring how `syncAddEnabled` disables Add, so a control that cannot show its effect does not look broken.

### Neither mechanism needs an app-side debounce

Quick search filters at most `PAGE_SIZE` (100) loaded records over a handful of fields per keystroke — well under a millisecond, so no throttle is added.[^no-debounce] The header filter row already debounces its own keystrokes 200 ms before writing to the store (`Header.onFilterCellChange`), and applies immediately on an operator pick, Enter, or Escape. This app adds no debounce logic for either.

### Add, Delete, and Save are unaffected

`setRowVisible` is display-only: it never touches `store.getRecords()`, `getSelectedRecords()`, or `hasPendingChanges()`. A row hidden by quick search keeps its selection and its pending edit. `confirmDelete`, `save_`, `syncDeleteEnabled`, and `syncSaveEnabled` need no changes.

A column filter *does* reload the page, which discards loaded records — exactly as the filter dialog does today, and as Refresh does. That is unchanged behaviour, not something this plan introduces.

---

## Public API

Nothing here is exported to a consumer — every new symbol is app-internal. One new module, one new helper on an existing module, and one changed backend behaviour.

```ts
// frontend/src/dock/quickSearchModel.ts — new module

/** The subset of a ModelRecord's API this module reads. */
interface RecordLike {
    getData(): Record<string, unknown>;
}

/**
 * Whether `record` matches a quick-search query: case-insensitive substring,
 * across every primitive (string/number/boolean) field. An empty or
 * whitespace-only query matches every record.
 */
export function matchesQuickSearch(record: RecordLike, query: string): boolean;

/**
 * Format the quick-search status line: how many of the currently loaded rows
 * matched, and — when the server holds more rows than are loaded — a note
 * that those weren't searched.
 */
export function quickSearchStatus(matchedCount: number, loadedCount: number, totalCount: number | undefined): string;
```

`quickSearchStatus`'s worked cases:

| `matchedCount` | `loadedCount` | `totalCount` | Result |
|---|---|---|---|
| 3 | 100 | 100 | `"3 of 100 loaded rows"` |
| 0 | 100 | 4500 | `"0 of 100 loaded rows (4400 more on the server not searched)"` |
| 1 | 1 | 1 | `"1 of 1 loaded row"` |
| 0 | 0 | undefined | `"0 of 0 loaded rows"` |

`loadedCount === 1` uses `"row"`; otherwise `"rows"`. The "more on the server" clause appears only when `totalCount !== undefined && totalCount > loadedCount`, and its count is always `totalCount - loadedCount`.

```ts
// frontend/src/dock/tableWriteRules.ts — new export alongside isRequiredColumn

/**
 * Whether this column gets a filter input in the grid's header filter row.
 * True for the wire types the SQL filter compiler can bind: number, string,
 * and boolean.
 */
export function isFilterableColumn(column: ColumnMeta): boolean;
```

Library methods this plan calls, all already shipped:

```ts
// Table (packages/lib/src/typescript/lib/component/table/Table.ts)
setRowVisible(predicate: ((record: ModelRecord) => boolean) | null): this;   // :442
setFilterRowVisible(visible: boolean): this;                                  // :691
isFilterRowVisible(): boolean;                                                // :677
```

---

## Internal Structure

### `TableWorkPanel` — new and changed members

`filterButton: Button` becomes `filterToggle: ToggleButton`. Every new handler is an arrow-function field: each is registered by reference on a store, grid, or button event and would drop `this` as a plain method (convention (c) in [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md)).

```ts
// Fields, alongside the existing button block:
private readonly quickSearchField:      TextField;
private readonly quickSearchStatusText: Text;
private readonly filterToggle:          ToggleButton;   // replaces filterButton
private readonly canFilter:             boolean;        // any column filterable at all
```

```ts
// Pre-super() locals, built alongside the other toolbar controls:
const quickSearchField      = new TextField({ placeholder: "Quick search (loaded rows)" });
const quickSearchStatusText = new Text("");
const canFilter             = columns.some(isFilterableColumn);
const filterToggle          = glyphToggleButton("filter", PRIMARY_COLOR, "Filter row", false);
```

```ts
// Registered on quickSearchField ("change"), which TextInput fires on every
// keystroke from its native `input` listener. Installs a fresh predicate each
// call; null when the query is empty clears the filter entirely.
private applyQuickSearch = (): void => {
    const query = this.quickSearchField.getValue().trim();

    this.dataGrid.setRowVisible(query === "" ? null : (record) => matchesQuickSearch(record, query));
    this.syncQuickSearchStatus();
};

// Registered on `store` ("datachange", "load") and called directly from
// applyQuickSearch. Recomputes the label from the CURRENT query against
// whatever is loaded now; it never calls setRowVisible, because the installed
// predicate re-evaluates itself against fresh records on every render pass.
private syncQuickSearchStatus = (): void => {
    const query = this.quickSearchField.getValue().trim();

    if (query === "") {
        this.quickSearchStatusText.setText("");

        return;
    }

    const loaded  = this.store.getRecords();
    const matched = loaded.filter(r => matchesQuickSearch(r, query)).length;

    this.quickSearchStatusText.setText(quickSearchStatus(matched, loaded.length, this.store.getTotalCount()));
};

// Registered on filterToggle ("action"). ToggleButton has already flipped its
// own selected state by the time this runs, so it reads as the new intent.
private toggleFilterRow = (): void => {
    this.dataGrid.setFilterRowVisible(this.filterToggle.isSelected());
};
```

`syncFilterActive` replaces its current body — the single writer for every visual state of `filterToggle`:

```ts
// Registered on `store` ("filterchange"), and called from toggleRecordView.
private syncFilterActive = (): void => {
    const rotated = this.dataGrid.getDisplayMode() === "rotated";
    const active  = this.store.getActiveFilters().length > 0;

    this.filterToggle.setSelected(this.dataGrid.isFilterRowVisible());
    this.filterToggle.setEnabled(this.canFilter && !rotated);
    this.filterToggle.setForegroundColor(active ? FILTER_ACTIVE_COLOR : PRIMARY_COLOR);
    this.filterToggle.setDescription(
        !this.canFilter ? "Filter row (no filterable columns)"
        : rotated       ? "Switch to the grid view to use the filter row"
        : active        ? "Filter row (filters active)"
                        : "Filter row");
};
```

Post-`super()` wiring, replacing the existing filter-wiring block at [`TableWorkPanel.ts:160`](frontend/src/dock/TableWorkPanel.ts#L160):

```ts
this.syncFilterActive();
store.on("filterchange", this.syncFilterActive);
this.filterToggle.on("action", this.toggleFilterRow);

this.quickSearchField.on("change", this.applyQuickSearch);
this.syncQuickSearchStatus();
store.on("datachange", this.syncQuickSearchStatus);
store.on("load", this.syncQuickSearchStatus);
```

`store.on("load", …)` is needed in addition to `"datachange"`: `load()` — the path Refresh and every column-filter reload take — emits only `'load'`.

`toggleRecordView` gains one line, next to its existing `syncAddEnabled()` / `syncStepEnabled()` calls:

```ts
this.syncFilterActive();
```

### `compiler.py` — `FilterCompiler._node`

Three edits, all inside the existing method. `_column` is the one new helper, shared by every branch:

```python
def _column(self, field: str, values: list[Any]) -> str:
    """
    The column expression to compare against. A text operand can only have
    come from a string-typed model field, whose Postgres type may be text,
    varchar, char, uuid, or numeric — comparing the column's text form makes
    every one of those valid.
    """
    ident = self._ident(field)

    return ident + "::text" if values and all(isinstance(v, str) for v in values) else ident
```

- **Comparators** (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`): `f"{self._column(f['field'], [f['value']])} {_COMPARATORS[t]} {self._bind(f['value'])}"`.
- **Pattern match**: add `endsWith` to the `("contains", "startsWith")` tuple, with `pattern = "%" + pattern` for it. This branch always casts — `self._ident(field) + "::text"` — because a `LIKE`/`ILIKE` operand is a string by construction.
- **`in`**: split `values` into nulls and non-nulls, then emit per the table under _Architecture Decisions_.

```python
if t == "in":
    values   = list(f["values"])
    concrete = [v for v in values if v is not None]
    has_null = len(concrete) < len(values)
    col      = self._column(f["field"], concrete)

    if not concrete:
        return f"{col} IS NULL" if has_null else "FALSE"

    any_clause = f"{col} = ANY({self._bind(concrete)})"

    return f"({col} IS NULL OR {any_clause})" if has_null else any_clause
```

---

## Ordered Implementation Steps

### Gate

1. **Check the installed library build.** Run `grep -rl "setRowVisible\|setFilterRowVisible" frontend/node_modules/@jimka/typescript-ui/dist/lib/*.js`. If either symbol is missing, **stop and tell the user**: both shipped in the `typescript-ui` repo (commits `13e39f2d` and `6e5ce972`) but are not in the published `0.5.0` this app installs, so the app must be pointed at a local build (symlink override) or a later release first. Do not build an app-side substitute for either.

### Backend — the SQL compiler

2. **`backend/tests/test_compiler.py`**, test-first, in the existing `FilterCompiler` section. Add cases for: every row of the `::text` table and the `in` table under _Architecture Decisions_; `endsWith` producing `%value` with wildcards escaped; `not` wrapping a null-bearing `in`. Run `cd backend && poetry run python -m pytest tests/test_compiler.py` — red.

3. **`backend/app/sql/compiler.py`** — add the `_column` helper and apply the three `_node` edits per `## Internal Structure`. Run the same pytest command — green. Then `poetry run python -m pytest` — the whole suite still passes.

### Quick search

4. **Create `frontend/tests/dock/quickSearchModel.test.ts`**, test-first, mirroring [`frontend/tests/dock/tableWriteRules.test.ts`](frontend/tests/dock/tableWriteRules.test.ts)'s duck-typed-record-fixture style. Cover every row of both worked-example tables above, plus the extra cases listed in `## Expected Behaviour`. Run `cd frontend && npm test` — fails to import a module that does not exist yet.

5. **Create `frontend/src/dock/quickSearchModel.ts`** implementing `matchesQuickSearch` and `quickSearchStatus` per `## Public API`. Give the module a header comment stating why it is split out (pure, DOM-free, node-vitest — the same reason `tableWriteRules.ts` gives). Run `npm test` — green.

### Column filterability

6. **`frontend/src/dock/tableWriteRules.ts`** — add and export `isFilterableColumn` per `## Public API`, and set `filterable: isFilterableColumn(c)` on each entry `buildColumnSpec` maps at [line 45](frontend/src/dock/tableWriteRules.ts#L45). Extend `buildColumnSpec`'s doc comment with one sentence naming the filterable wire types.

7. **`frontend/tests/dock/tableWriteRules.test.ts`** — add cases for `isFilterableColumn` (one per wire type) and for `buildColumnSpec` carrying `filterable` through.

### Panel wiring

8. **`TableWorkPanel.ts` — imports.** Add `TextField, Text` from `@jimka/typescript-ui/component/input` (a new import line). Add `matchesQuickSearch, quickSearchStatus` from `./quickSearchModel`, and `isFilterableColumn` to the existing `./tableWriteRules` import at [line 49](frontend/src/dock/TableWorkPanel.ts#L49). Delete the `openFilterDialog` import at [line 47](frontend/src/dock/TableWorkPanel.ts#L47). `Button` stays imported (Add/Delete/Save still use it); `ToggleButton` is already imported.

9. **`TableWorkPanel.ts` — fields.** In the block at [lines 73-82](frontend/src/dock/TableWorkPanel.ts#L73), rename `filterButton: Button` to `filterToggle: ToggleButton` and add `quickSearchField`, `quickSearchStatusText`, and `canFilter` per `## Internal Structure`. Extend the block's leading comment to name them.

10. **`TableWorkPanel.ts` — pre-`super()` locals.** Replace the `filterButton` local at [line 102](frontend/src/dock/TableWorkPanel.ts#L102) with the four locals from `## Internal Structure`. `glyphToggleButton` is already imported.

11. **`TableWorkPanel.ts` — toolbar order.** In the `components` array, insert `quickSearchField, quickSearchStatusText` immediately after `Spacer.flex()` at [line 131](frontend/src/dock/TableWorkPanel.ts#L131), and replace `filterButton` at [line 132](frontend/src/dock/TableWorkPanel.ts#L132) with `filterToggle`.

12. **`TableWorkPanel.ts` — post-`super()` wiring.** Assign the new fields alongside the existing ones, then replace the filter-wiring block at [lines 160-164](frontend/src/dock/TableWorkPanel.ts#L160) with the block from `## Internal Structure`.

13. **`TableWorkPanel.ts` — handlers.** Replace `syncFilterActive`'s body ([lines 198-205](frontend/src/dock/TableWorkPanel.ts#L198)) with the version in `## Internal Structure`. Add `toggleFilterRow`, `applyQuickSearch`, and `syncQuickSearchStatus` as arrow-function fields after `syncDeleteEnabled` ([line 219](frontend/src/dock/TableWorkPanel.ts#L219)). Add the `this.syncFilterActive();` call to `toggleRecordView` beside its existing sync calls ([line 234](frontend/src/dock/TableWorkPanel.ts#L234)).

14. **`TableWorkPanel.ts` — header comment.** Update the opening block ([lines 1-25](frontend/src/dock/TableWorkPanel.ts#L1)): the toolbar now carries a quick-search field and a filter-row toggle instead of a Filter button; name the two new handlers the way it already names `syncFilterActive` / `syncSaveEnabled` / `syncDeleteEnabled`, and say in one sentence that quick search is local and the filter row is remote.

15. **Checkpoint.** `cd frontend && npm run typecheck && npm test`. A typecheck failure on `setRowVisible`/`setFilterRowVisible` means step 1's gate was mis-read — go back to it rather than working around the type error.

### Remove the filter dialog

16. **Delete** `frontend/src/dock/FilterDialog.ts`, `frontend/src/dock/filterModel.ts`, and `frontend/tests/dock/filterModel.test.ts`.

17. **Retarget the surviving comment references.** `grep -rn "FilterDialog\|filterModel" frontend/src frontend/tests` finds explanatory comments in [`LoginDialog.ts:4`](frontend/src/shell/LoginDialog.ts#L4), [`CreateTableForm.ts:2,24`](frontend/src/dock/CreateTableForm.ts#L2), and [`SqlPreviewDialog.ts:24,36,58,111,117`](frontend/src/dock/SqlPreviewDialog.ts#L24). Point each at a surviving example: `CreateTableForm` for the weighted-`Grid` row idiom, `SqlPreviewDialog` for the `await dialog.show()` idiom, the open/run split, and the `resizer` handle. Re-run the grep — expect zero matches.

18. **Checkpoint.** `cd frontend && npm run typecheck && npm test`.

### Docs

19. **`README.md`** — extend the "Data grid" highlight ([lines 27-31](README.md#L27)) to name the two new controls: a per-column header filter row (server-side) and a quick search over the loaded page (client-side).

20. **`LIBRARY_NOTES.md`** — add one entry only if step 21's manual case 12 fails; see `## Documentation Impact`.

21. **Manual verification** — per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/quickSearchModel.ts` |
| Create | `frontend/tests/dock/quickSearchModel.test.ts` |
| Modify | `frontend/src/dock/TableWorkPanel.ts` |
| Modify | `frontend/src/dock/tableWriteRules.ts` |
| Modify | `frontend/tests/dock/tableWriteRules.test.ts` |
| Modify | `frontend/src/shell/LoginDialog.ts` (comment only) |
| Modify | `frontend/src/dock/CreateTableForm.ts` (comments only) |
| Modify | `frontend/src/dock/SqlPreviewDialog.ts` (comments only) |
| Modify | `backend/app/sql/compiler.py` |
| Modify | `backend/tests/test_compiler.py` |
| Modify | `README.md` |
| Modify | `LIBRARY_NOTES.md` — **only if** manual case 12 fails (see `## Documentation Impact`) |
| Delete | `frontend/src/dock/FilterDialog.ts` |
| Delete | `frontend/src/dock/filterModel.ts` |
| Delete | `frontend/tests/dock/filterModel.test.ts` |

---

## Expected Behaviour

### Unit-testable — `quickSearchModel.ts` (`frontend/tests/dock/quickSearchModel.test.ts`)

- Every row of the `matchesQuickSearch` worked-example table under _Architecture Decisions_.
- Every row of the `quickSearchStatus` worked-cases table under `## Public API`.
- `matchesQuickSearch`: `"SMITH"` matches a record with `name: "John Smith"`; a whitespace-only query (`"   "`) matches every record, same as `""`; a record whose only matching field is `null` or `undefined` does not match a non-empty query; a record with no fields at all (`getData()` returns `{}`) matches only the empty query.
- `quickSearchStatus`: `loadedCount === 1` renders `"row"`, every other count renders `"rows"`; the "more on the server" clause is present exactly when `totalCount !== undefined && totalCount > loadedCount`.

### Unit-testable — `tableWriteRules.ts` (`frontend/tests/dock/tableWriteRules.test.ts`)

- `isFilterableColumn` returns `true` for `number`, `string`, `boolean`; `false` for `isoString`, `json`, `jsonArray`, `base64`.
- `buildColumnSpec` sets `filterable` on each column entry to that column's `isFilterableColumn` result.

### Unit-testable — `FilterCompiler` (`backend/tests/test_compiler.py`)

- Every row of the `::text` table and the `in` table under _Architecture Decisions_.
- `endsWith`: `{type: "endsWith", field: "name", value: "a%b"}` compiles to `"name"::text ILIKE $1 ESCAPE '\'` with `params == [r"%a\%b"]`.
- `not` wrapping a null-bearing `in` on `name` compiles to `NOT (("name"::text IS NULL OR "name"::text = ANY($1)))`.
- A string operand still binds as `$n` and is never interpolated (the existing injection-safety cases keep passing unchanged).

### Manual — the Data tab of an open table

Use a table with more than 100 server-side rows for the "more on the server" cases, and a small table for the rest.

1. **Quick search narrows live, with no network.** Typing in the quick-search field narrows the grid immediately; devtools' network panel shows no new request while typing.
2. **Clearing quick search restores everything.** Emptying the field re-shows every loaded row.
3. **Zero quick-search matches.** A query matching nothing empties the grid; the status label reads `"0 of {loaded} loaded rows"`, plus the "more on the server" clause on a big table.
4. **No "more on the server" clause when everything is loaded.** On a table with fewer than 100 rows the parenthetical never appears.
5. **Selection and pending edits survive hiding.** Select a row, edit a cell (Save enables), then type a query that hides it: Save stays enabled and the edit is intact. Clear the query — the row returns, still selected, still dirty.
6. **Filter-row toggle.** Pressing the toolbar's Filter glyph shows the header filter row; pressing it again hides the row and clears every filter it applied, and the grid reloads unfiltered.
7. **A column filter hits the server.** Typing in a column's filter input issues one request roughly 200 ms after the last keystroke, with a `filter=` query param; pressing Enter issues it at once. The toolbar's Filter glyph turns the active colour.
8. **"Ends with" works.** Pick "Ends with" on a text column and type a suffix: matching rows come back, with no 422 in the network panel.
9. **"Is empty" matches nulls.** On a nullable text column, "Is empty" returns the rows whose value is `NULL` as well as the empty-string ones; "Is not empty" returns exactly the complement.
10. **Contains on a non-text column.** Type into the filter input of a `uuid` or `numeric` column ("contains"): matching rows come back, with no 500.
11. **Non-filterable columns have no input.** A `timestamptz`, `json`, or `bytea` column's filter cell is blank — no text input, no operator button.
12. **Caret keys inside the quick-search field.** With text in the field, press ArrowLeft / ArrowRight mid-string: the caret must move. If focus jumps to a neighbouring toolbar button instead, the toolbar is eating the caret keys — that is a library defect, not something to patch here; see `## Potential Challenges`.
13. **Quick search composes with a column filter.** With a column filter narrowing the server result and a quick-search query also active, the grid shows rows matching both. Clearing the quick-search field restores every server-filtered row; clearing the column filter leaves the quick-search text and its narrowing in place.
14. **Refresh re-applies the quick-search query.** With a query active, press Refresh: the grid reloads and re-narrows to the same text against the fresh page; the status label updates.
15. **Record view.** With a quick-search query narrowing the grid, toggle into record view: the filter row collapses, the Filter glyph greys out, the full record is shown, and Previous/Next step through every loaded record — not only the matches. Toggle back: the filter row and the narrowed grid both return, and the Filter glyph re-enables.
16. **A table with no filterable columns.** Open a table whose columns are all `json` / `timestamptz` / `bytea` (create one in the test database if none exists): the Filter glyph is disabled and its tooltip says so. Quick search still works.

---

## Verification

- `cd backend && poetry run python -m pytest` — clean, including the new `FilterCompiler` cases.
- `cd frontend && npm run typecheck` — clean (needs step 1's library build).
- `cd frontend && npm test` — the new `quickSearchModel` suite and the extended `tableWriteRules` suite pass with the rest.
- `grep -rn "FilterDialog\|filterModel" frontend/src frontend/tests` — zero matches.
- `grep -rn "setRowVisible" frontend/src/` — exactly one call site, inside `applyQuickSearch`.
- `grep -rn "setFilterRowVisible" frontend/src/` — exactly one call site, inside `toggleFilterRow`.
- Manual: the 16 cases above, driven through the running app (see the `verify` skill). Entry point: navigator → a table's Data tab. Cases 3, 4, and 16 need specific tables (>100 rows, <100 rows, and an all-`json` / `timestamptz` / `bytea` table respectively); the rest run on any table with a mix of text, numeric, and nullable columns.

---

## Documentation Impact

- **`README.md`** — the "Data grid" highlight lists filter/sort/page; name the header filter row and the quick search (step 19).
- **`LIBRARY_NOTES.md`** — one entry **only if manual case 12 fails**: `ToolBar`'s roving-tabindex keydown handler calls `preventDefault()` on ArrowLeft/ArrowRight for any keydown in its subtree, which would steal caret movement from a text child. File it under the 🐞🔎 legend with the reproduction and the pointer to `ToolBar.ts`'s constructor. Nothing to log if the caret behaves.
- **`TODO.md`** — no existing backlog bullet describes either feature (grepped for "search" and "filter"), so nothing to rewrite.
- **`CHANGELOG.md`** — no entry; written at release time, not in feature work (established by `plans/implemented/content-derived-column-sizing.md` and `plans/implemented/elkjs-0-12-upgrade.md`).

---

## Potential Challenges

- **The library build gate can pass or fail depending on how the app is installed.** Neither `setRowVisible` nor `setFilterRowVisible` is in the published `0.5.0` in `frontend/node_modules` today; step 1 must be run against the build present at implementation time, not assumed.
- **`ToolBar` may eat the quick-search field's caret keys.** The bar registers a subtree `keydown` listener that `preventDefault()`s ArrowLeft/ArrowRight to move roving focus, and no library toolbar in this app has ever held a text child. Manual case 12 is the check; if it fails, the fix belongs in `typescript-ui` (skip the roving move when the keydown target is a text-entry control), logged per `## Documentation Impact`. Do not add an app-side `stopPropagation` workaround.
- **Casting a column to `::text` gives up index use for equality filters.** Accepted: `ILIKE` never used a plain btree index anyway, and `ListRowsQuery`'s `count(*) OVER()` already walks the whole matching set.
- **The filter toggle can disagree with the row once, after a right-click toggle.** The header's own context menu also toggles the filter row and emits no event, so toggling it there leaves the toolbar button showing the old state. One press of the button reconciles them (the library call is idempotent), and `syncFilterActive` re-reads `isFilterRowVisible()` on the next `'filterchange'`.
- **`ToolBar`'s default overflow is `"clip"`.** The bar now holds a text field and a status label as well as ten buttons, so a narrow window can clip it. No fix is scoped here — this matches every other toolbar in the app.

---

## Critical Files

| File | Why |
|---|---|
| [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) | The panel being changed; its arrow-field handler style and pre-`super()` local pattern must be followed exactly. |
| [`frontend/src/dock/FilterDialog.ts`](frontend/src/dock/FilterDialog.ts) / [`frontend/src/dock/filterModel.ts`](frontend/src/dock/filterModel.ts) | The mechanism being deleted — read `applyFilters` ([FilterDialog.ts:181](frontend/src/dock/FilterDialog.ts#L181)) to see the `clearFilter()`-then-`filterBy` shape that cannot coexist with the header row's keyed slots. |
| [`plans/implemented/grid-filter-sort.md`](plans/implemented/grid-filter-sort.md) | Where the dialog was chosen over a filter row, and why that reason no longer holds. |
| [`frontend/src/dock/tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts) / [`frontend/tests/dock/tableWriteRules.test.ts`](frontend/tests/dock/tableWriteRules.test.ts) | The DOM-free pure-module-plus-test convention `quickSearchModel.ts` follows, including the duck-typed `RecordLike` interface; also the home of `isFilterableColumn`. |
| [`frontend/src/data/buildModel.ts`](frontend/src/data/buildModel.ts) | The `wireType` → `FieldType` map that decides which operators each column's filter cell offers. |
| [`frontend/src/data/stores.ts`](frontend/src/data/stores.ts) | `PAGE_SIZE`, `remoteSort`, `remoteFilter` — every "loaded vs. total" and "does this reload" claim rests on these. |
| [`frontend/src/dock/glyphButton.ts`](frontend/src/dock/glyphButton.ts) | `glyphToggleButton`, the helper the filter toggle uses; `recordToggle` is the in-file precedent for wiring one. |
| [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) / [`backend/tests/test_compiler.py`](backend/tests/test_compiler.py) | The compiler being extended and its test conventions (`conftest.col` fixtures, `where`/`params` assertions). |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts` (`setRowVisible` 442, `isFilterRowVisible` 677, `setFilterRowVisible` 691, `setDisplayMode` 394, `showColumnMenu` 1274) | The two shipped entry points, the rotated-mode neutralization, and the context-menu route that can desync the toolbar toggle. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/Header.ts` (`hasFilterRow` 404, `setFilterRowVisible` 421, `clearFilterRowState` 444, `onFilterCellChange` 946, `applyPendingFilter` 987, `onStoreFilterChange` 1024) | The filter row's own debounce, its clear-on-hide rule, and its refusal to rebuild input text from an externally-set descriptor. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts` (`columnFilterOperators` 83, `buildColumnFilter` 189) | Which operators each field type offers, and the exact descriptors they produce — the input contract for the backend compiler changes. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/AbstractStore.ts` (`getActiveFilters` 1460, `filterBy` 1522, `setFilter` 1547, `applyFilterChange` 1577, `clearFilter` 1604) | Keyed vs. anonymous filter slots, the shared reload rule, and the absence of any way to clear only one kind. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/menubar/ToolBar.ts` (constructor keydown handler ~166-180) | The roving-tabindex arrow-key interception behind manual case 12. |

---

## Non-Goals

- **Keeping the modal filter dialog alongside the header row.** Rejected — see "The header filter row replaces the Filter dialog".
- **Two filter conditions on the same column** (e.g. `balance > 10 AND balance < 20`). The header row holds one filter per column, keyed by field name. The dialog could express it; nothing else in the app can, and no user has asked.
- **Filtering `isoString`, `json`, `jsonArray`, or `base64` columns.** Excluded from `filterable` — the operand the library would bind for them has no safe or useful SQL form. A date filter wants a picker, not a free-text cell; that is separate work.
- **Force-loading the whole table so quick search can reach rows beyond the current page.** Rejected — defeats server pagination, and no bulk-load API is wired into this panel's store.
- **Quick-search matching against `Date` or JSON column values.** Excluded by the matching rule; searching their *formatted* display text would need each column's own cell formatter.
- **Coordinating quick search or the filter row with the record/rotated view's Previous/Next reach.** Both are neutralized while rotated by the library itself; Previous/Next keep stepping the full loaded set.
- **Debouncing anything in this app.** The filter row debounces itself; quick search needs none.
- **A leading search glyph or a clear ("×") button on the quick-search field.** The library's `TextField` has no affix slot; a placeholder is enough.
- **Highlighting the matched substring inside grid cells.** The status label's match count is the only feedback this plan adds.
- **Any `typescript-ui` change.** Both library features are already shipped. If manual case 12 exposes the `ToolBar` caret-key defect, it is logged for a separate library fix, not patched here.

---

## Notes

[^filter-always-reloads]: `AbstractStore.applyFilterChange()` (`AbstractStore.ts:1577`) opens with `const reload = this._remoteFilter || this._pageSize != null;` and, when `reload` is true, sets `this._page = 1` and calls `void this.load()` after rebuilding the local view. `setFilter` (`:1547`), `filterBy` (`:1522`), `filter`, and `clearFilter` (`:1604`) all funnel through it, so they share identical reload behaviour. `buildStore` ([`stores.ts:36`](frontend/src/data/stores.ts#L36)) always passes `pageSize: PAGE_SIZE` (100, [line 16](frontend/src/data/stores.ts#L16)), so `reload` is unconditionally true for every store this panel uses — there is no way to call any of them without a page-1 server round trip.

[^why-replace-dialog]: Three findings, in order of weight. **(1)** `FilterDialog.applyFilters` ([`FilterDialog.ts:181`](frontend/src/dock/FilterDialog.ts#L181)) calls `store.clearFilter()` before re-applying, and Clear calls it alone. `clearFilter()` empties the whole `_activeFilters` map, keyed column-filter slots included, and `AbstractStore` exposes no way to clear only the anonymous `Symbol()`-keyed ones (`getActiveFilters()` returns descriptors, never their keys), so the dialog cannot be taught to leave the header row alone. **(2)** Even a dialog rewritten to write per-column keyed slots would desync: `Header.onStoreFilterChange` (`Header.ts:1024`) only ever *drops* a cached filter-cell state whose descriptor has disappeared, and its doc comment says it deliberately never reconstructs text from a descriptor (a temporal descriptor holds a `Date`, and formatting it back would rewrite what the user typed). A dialog-set filter would leave that column's input blank over filtered data. **(3)** The dialog silently loses filters it cannot represent: `conditionsFromFilters` maps only the eight descriptor types the dialog itself emits, so an `endsWith`, `isEmpty` (`in`), or `isNotEmpty` (`not`) column filter would be seeded into no row and then dropped by the `clearFilter()` on Apply. The alternative direction — keep the dialog and do not enable the filter row — was rejected because the row is the more capable and more discoverable of the two, and is what `plans/implemented/grid-filter-sort.md` wanted in the first place.

[^why-filterable-subset]: `isoString` maps to `FieldType "datetime"`, whose operators parse the typed text into a JS `Date`; that crosses the wire as an ISO string and asyncpg refuses a `str` for a `timestamptz`/`date`/`time` parameter. `json`/`jsonArray` map to `"auto"`, which offers the string operators — `ILIKE` has no `jsonb` overload, and an equality test against a rendered JSON string is meaningless. `base64` maps to `"string"` and would technically compile, but filtering a `bytea` blob by substring is not a feature anyone wants; it is excluded with the rest. Quick search's own exclusions differ slightly (it does search `base64` values, since they are already plain strings by then) — the two rules answer different questions and are deliberately not unified.

[^why-text-cast]: A string operand can only reach the compiler from a model field the frontend typed as `string`, which covers Postgres `text`, `varchar`, `char`, `uuid`, and `numeric` (see `WireType.STRING`'s comment in `backend/app/contract.py`). Of those, only the character types accept `ILIKE` at all, and `numeric` rejects a `str` bind for `=`. Casting the *column* rather than the parameter keeps the user's typed text as the literal being matched, which is what "contains" and "equals" mean to someone typing into a filter cell. The alternative — a table of Postgres type names that are LIKE-safe, consulted per column — was rejected: it needs `ColumnMeta.data_type` threaded into every branch and has to be kept in step with Postgres's type list, for a benefit (index use on `=` over a `text` column) that `count(*) OVER()` already spends.

[^why-skip-objects]: `AbstractModel.createRecord` runs every field through `field.convertValue(value, source)` before constructing the `ModelRecord`, so `ModelRecord.getData()` returns already-coerced values, not raw wire JSON. `Field.convertByType` coerces `date`/`datetime`/`time` to a real `Date`. Stringifying a `Date` produces a verbose, locale-dependent form the user never typed and would not think to search for; stringifying a parsed JSON object produces `"[object Object]"`. Both are worse than not matching, so one `typeof value === "object"` check excludes both rather than giving either a bespoke — and inevitably wrong — stringification.

[^why-not-force-load]: A "load every row, then search" mode would need either a new store method (`AbstractStore` has no load-all-pages operation) or a client-side `nextPage()` loop, which reintroduces the multi-request async complexity `plans/implemented/table-record-detail-view.md` already rejected for record-view stepping on this same store. It would also make a control called "quick search" silently expensive on a million-row table.

[^toolbar-input-precedent]: Checked every `ToolBar` construction in `frontend/src`: `TableWorkPanel`, `QueryPanel`, `QueryResultView`, `RoleGrantsPanel`, `SequenceInfoPanel`, `definitionEditor`, and `ActivityBar`. All hold only `Button`/`ToggleButton`/`MenuButton`, `ToolBarSeparator`, and `Spacer`. The app's other inputs (`diagramShell`'s combos and checkboxes) live in side panels, not bars. Per `pattern-conformance.md` this is a new pattern for the app, justified by the library documenting it rather than by an in-app example.

[^no-debounce]: Revisit only if a future change loads more than `PAGE_SIZE` rows into this panel at once (e.g. an eventual "load all" mode) — not the case today, and not proposed here.
