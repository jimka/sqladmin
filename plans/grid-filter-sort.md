---
touches-shared:
  - frontend/src/dock/TableWorkPanel.ts
  - frontend/src/data/stores.ts
  - backend/app/operations/list_rows.py
---

# Grid Filter & Sort — Implementation Plan

## Overview

Give the navigator-opened table data grids **column sort** and **filtering**, both driven **server-side** through the store's `remoteSort`/`remoteFilter` seams. The backend already applies sort and filter safely; the library already ships the header-click **sort UI**; the store already carries the `sort`/`filter` API. The genuinely new work is a small, discoverable **per-column filter UI** in the app that turns user input into `FilterDescriptor` objects and hands them to the store.

The scope is narrow because most of the pipeline is already built and verified:

- **Backend — done.** [`backend/app/operations/list_rows.py`](backend/app/operations/list_rows.py) accepts `sort`/`filter`, and [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) compiles both with **validated identifiers** (checked against the introspected column set) and **bound `$n` parameters**. The route [`main.py:265`](backend/app/main.py#L265) threads `sort=`/`filter=` from the query string through `_parse_json_array` into `ListRowsQuery`. Covered by [`backend/tests/test_compiler.py`](backend/tests/test_compiler.py) and [`backend/tests/test_list_rows.py`](backend/tests/test_list_rows.py). **No backend code change is required** — this plan verifies it and, if any gap surfaces, adds a test.
- **Store — done.** [`frontend/src/data/stores.ts:31`](frontend/src/data/stores.ts#L31) already builds the `AjaxStore` with `remoteSort: true, remoteFilter: true` and a page size, so `store.sort(...)` / `store.filterBy(...)` reset to page 1 and reload from the server, and the `AjaxProxy` emits `sort=`/`filter=` query params. **No store change is required.**
- **Sort UI — done in the library.** The library `Header` already wires header-cell clicks to cycle **asc → desc → none** (single click) and shift-click multi-sort, calling `store.sort()`/`store.clearSort()`, and paints sort arrows + a priority badge (`Header.handleSortClick`/`syncSortIndicators` in `@jimka/typescript-ui`). Because the store is `remoteSort`, this drives the backend `ORDER BY` **with no app code at all.** This plan **verifies** sort end-to-end and does **not** reinvent a header UI.
- **Filter UI — the actual work.** The library has **no** built-in filter row or filter dialog; it only exposes the store filter API (`store.filterBy(descriptor)`, `store.clearFilter()`, `store.getActiveFilters()`). The app must build a simple **filter dialog** (column, operator, value; AND-combined) and a toolbar affordance to open it, translating the form state into `FilterDescriptor[]` and applying them to the store.

The one new pure, testable unit is the **filter-state → `FilterDescriptor[]`** builder (and, symmetrically, back), factored out of the dialog so it can be pinned with vitest under sqladmin's node-only harness.

---

## Architecture Decisions

### Sort is not built — it already works through the library + `remoteSort`

The library `Header` (in `@jimka/typescript-ui/component/table`) already binds each header cell's `sortclick` to `handleSortClick`, which reads `store.getActiveSorters()` and cycles the clicked column asc → desc → none via `store.sort(field, dir)` / `store.clearSort()`, then repaints indicators. `AbstractStore.sort()` and `clearSort()`, when `remoteSort` (or a page size) is set, reset `_page = 1` and fire-and-forget `this.load()`, so the `AjaxProxy` re-reads with `sort=<JSON.stringify(SortDescriptor[])>`. The backend `OrderCompiler` validates each `field` against the column set and emits `ORDER BY "col" ASC|DESC`. Every link in that chain exists and is tested/shipped. **This plan adds no sort code** — it is a verification item only (see *Expected Behaviour* / *Verification*). Reinventing a header sort UI in the app would duplicate and fight the library's.

### The filter UI is a modal dialog, not a filter row

Two discoverable shapes were considered:

- **A per-column filter row** (an input strip under the header). Rejected for the first cut: the app's `Table` is virtualized and the header is library-owned; injecting an aligned input-per-column row would require reaching into the library's header/column geometry, which the library does not expose as an app seam. It is also more UI surface than "keep the first cut simple" wants.
- **A modal filter dialog** (chosen). A single "Filter" toolbar button opens a `Dialog` whose `contentComponent` is an app-built form: one row per condition — a **column** `ComboBox` (populated from `ColumnMeta`), an **operator** `ComboBox` (contains / equals / not-equals / `>` / `>=` / `<` / `<=` / starts-with), and a **value** `TextField`. Conditions are **AND-combined**. Confirm applies them via `store.clearFilter()` then one `store.filterBy(d)` per condition; an empty form clears the filter. This composes only public library pieces (`Dialog.show({ contentComponent })`, `ComboBox`, `TextField`), aligns with the existing modal patterns already in `TableWorkPanel` (`Dialog.show` is used for delete-confirm), and keeps identifier safety on the backend where it belongs. Richer boolean logic (OR groups, nesting, NOT) is a **Non-Goal** for now — the store algebra and backend compiler already support `and`/`or`/`not`, so a later dialog can grow into them without a backend change.

The dialog affordance lives in the panel toolbar next to the existing actions (a **filter** glyph button, plus a visible indicator/clear when a filter is active). The button's active state is driven off the store's `'filterchange'` event.

### The `FilterDescriptor` translation is a pure function, pinned by tests

The only app logic that can go wrong silently is turning the dialog's rows into `FilterDescriptor[]` (choosing the right descriptor `type`, coercing the value string to the column's wire type for `eq`/comparison, dropping incomplete rows). That is extracted into a **pure module** `frontend/src/dock/filterModel.ts` — `buildFilters(conditions, columns): FilterDescriptor[]` and a small `FilterCondition` type — with **no DOM**, so vitest (node-only) covers it directly. The dialog is a thin shell that collects `FilterCondition[]` from its inputs, calls `buildFilters`, and applies the result. Manual verification covers only the dialog wiring (input events, apply/clear), which the harness cannot exercise.

Value coercion mirrors the store's client-side filter semantics and the wire contract: for a `number`-wire column, a numeric operator (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`) parses the value with `Number(...)`; `boolean`-wire columns coerce `"true"`/`"false"`; everything else passes the string through. `contains`/`startsWith` always take the raw string (the library's `FilterDescriptor` types them as `string`). This keeps the emitted descriptor's `value` type matching what the backend binds as a `$n` parameter.

### Operator set matches the shared `FilterDescriptor`/`FilterCompiler` algebra

The dialog offers exactly the operators both ends already support for a single field: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `startsWith`. These map 1:1 onto the library `FilterDescriptor` union (`@jimka/typescript-ui/data`) and the backend `FilterCompiler._node` cases (`_COMPARATORS`, the `contains`/`startsWith` ILIKE/LIKE branch). `in` is omitted from the first-cut UI (no multi-value input); `and`/`or`/`not` are the implicit top-level AND only. No new operator is introduced on either side, so nothing needs to be added to the compiler or the store algebra.

### Backend is verified, not extended

`ListRowsQuery` + `FilterCompiler`/`OrderCompiler` already: bind values as `$n` (never interpolated), validate every `field` against `columns` (raising `ValidationError` → 422 on an unknown identifier), `quote_ident` as defense-in-depth, escape LIKE wildcards, and cap page size. The route parses `sort`/`filter` as JSON arrays (bad JSON → 422). This is exactly the master plan's mandate. The plan's backend task is therefore a **read-through + test audit**: confirm the existing tests cover the injection-safety cases the master plan is emphatic about (unknown column, quote-escaping, wildcard-escaping, bound values), and add any missing case. No production Python changes are expected.

---

## Public API

No **library** API changes. No exported app API — all new symbols are app-internal.

New app module (`frontend/src/dock/filterModel.ts`):

```typescript
import type { FilterDescriptor } from "@jimka/typescript-ui/data";
import type { ColumnMeta }       from "../contract";

/** One condition row in the filter dialog. */
export interface FilterCondition {
    field:    string;                                  // a column name
    operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "startsWith";
    value:    string;                                  // raw text from the value field
}

/**
 * Translate the dialog's conditions into an AND-combined FilterDescriptor list.
 * Incomplete rows (no field, or an empty value) are dropped. Values are coerced
 * to the column's wire type for eq/neq/comparison; contains/startsWith keep the
 * raw string.
 */
export function buildFilters(conditions: FilterCondition[], columns: ColumnMeta[]): FilterDescriptor[];
```

The dialog itself (`frontend/src/dock/FilterDialog.ts`, or a function on `TableWorkPanel`) exposes one entry point:

```typescript
/** Open the filter dialog for a store; on confirm, apply the built filters. */
export function openFilterDialog(store: AjaxStore, columns: ColumnMeta[]): void;
```

---

## Internal Structure

### `filterModel.ts` — the pure translation

```typescript
const NUMERIC_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte"]);

export function buildFilters(conditions: FilterCondition[], columns: ColumnMeta[]): FilterDescriptor[] {
    const byName = new Map(columns.map(c => [c.name, c]));

    return conditions
        .filter(c => c.field && c.value !== "")
        .map(c => {
            const col = byName.get(c.field);

            if (c.operator === "contains" || c.operator === "startsWith") {
                return { type: c.operator, field: c.field, value: c.value };
            }
            return { type: c.operator, field: c.field, value: coerce(c.value, col) };
        });
}

// number-wire -> Number(); boolean-wire -> true/false; else the raw string.
function coerce(value: string, col: ColumnMeta | undefined): number | boolean | string { … }
```

### Filter toolbar affordance (in `TableWorkPanel.buildToolBar`)

- A **filter** glyph button that calls `openFilterDialog(store, columns)`.
- Its foreground/tooltip reflect whether a filter is active: subscribe to `store.on("filterchange", …)` and read `store.getActiveFilters().length`; when non-zero, tint the button and offer a quick "clear filter" (either a second small button or a Cancel/Clear button inside the dialog). Keep this minimal — a single filter button whose active tint signals "a filter is on" is enough for the first cut.

### `FilterDialog` — the modal shell

`Dialog.show({ title: "Filter rows", contentComponent: form, buttons: [Cancel, Clear, Apply] })` where `form` is a `Panel` (VBox) of condition rows. On **Apply**: `const filters = buildFilters(collect(), columns); await store.clearFilter(); for (const f of filters) await store.filterBy(f);`. On **Clear**: `await store.clearFilter();`. First cut may ship a **single** condition row (simplest discoverable filter) with an add-row affordance deferred, or a small fixed set of rows — decide during implementation, but keep the AND-combine and the pure `buildFilters` regardless of row count.

Note: `store.filterBy` **appends** to the active filters, so always `clearFilter()` first to avoid stacking on re-apply.

---

## Ordered Implementation Steps

1. **Backend audit (no code expected).** Read [`backend/tests/test_compiler.py`](backend/tests/test_compiler.py) and [`backend/tests/test_list_rows.py`](backend/tests/test_list_rows.py). Confirm coverage of: unknown sort column → `ValidationError`; unknown filter column → `ValidationError`; value bound as `$n` (not interpolated); `quote_ident` escaping an embedded `"`; `_escape_like` escaping `%`/`_`/`\`; `contains` vs `startsWith` pattern + `ILIKE`/`LIKE` by `caseSensitive`; empty sort/filter → empty clause. Add a test only for any gap. Run `cd backend && pytest`.
2. **Add the pure translation** `frontend/src/dock/filterModel.ts` with `FilterCondition` + `buildFilters` (+ `coerce`). Import `FilterDescriptor` from `@jimka/typescript-ui/data` and `ColumnMeta` from `../contract`.
3. **Write `frontend/src/dock/filterModel.test.ts`** (vitest, node-only) pinning `buildFilters` — see *Expected Behaviour*.
4. **Build the filter dialog** (`openFilterDialog` — either a new `frontend/src/dock/FilterDialog.ts` or a function inside `TableWorkPanel.ts`): column `ComboBox` from `columns`, operator `ComboBox`, value `TextField`; Cancel / Clear / Apply. Apply does `clearFilter()` then `filterBy` per built descriptor; Clear does `clearFilter()`. Import `ComboBox`/`TextField` from `@jimka/typescript-ui/component/input`; ensure `./component/input` is in the package `exports` (it is — `package.json:32`).
5. **Wire the toolbar affordance** in [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) `buildToolBar`: add a filter glyph button opening the dialog, and a `store.on("filterchange", …)` handler that tints it when `getActiveFilters().length > 0`. Register any new glyph via `Glyph.register(...)` alongside the existing `refresh/plus/minus/save` (e.g. a `filter` glyph from `@jimka/typescript-ui/glyphs/solid/filter` if present; otherwise reuse an existing glyph rather than blocking).
6. **Verify sort end-to-end manually** (no code): open a table, click a header → asc → desc → none, confirm the network request carries `sort=[{"field":…,"dir":…}]` and the grid reorders; shift-click a second column → multi-sort + priority badge.
7. **Verify filter end-to-end manually:** open the dialog, add a `contains`/`eq`/comparison condition, Apply → confirm the request carries `filter=[…]`, the grid narrows, and the button tints; Clear → filter removed and request has no `filter=`.
8. **Regression checks:** `cd frontend && npx tsc --noEmit && npx vitest run`; `cd backend && pytest`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/filterModel.ts` — pure `FilterCondition` → `FilterDescriptor[]` |
| Create | `frontend/src/dock/filterModel.test.ts` — vitest for `buildFilters` |
| Create | `frontend/src/dock/FilterDialog.ts` — the modal filter UI (or fold into `TableWorkPanel.ts`) |
| Modify | `frontend/src/dock/TableWorkPanel.ts` — filter toolbar button + active-tint wiring (**touches-shared**) |
| Verify (no change expected) | `frontend/src/data/stores.ts` — `remoteSort`/`remoteFilter` already set (**touches-shared**) |
| Verify / test-audit (no code expected) | `backend/app/operations/list_rows.py`, `backend/app/sql/compiler.py`, `backend/tests/test_compiler.py`, `backend/tests/test_list_rows.py` (**touches-shared**) |

---

## Expected Behaviour

### `buildFilters(conditions, columns)` — unit-testable (vitest, node-only)

- **Empty input → `[]`.** No conditions yields no descriptors (dialog Apply with nothing then clears the filter).
- **Drops incomplete rows.** A condition with an empty `field` or an empty `value` is omitted; the remaining valid ones still produce descriptors.
- **`contains`/`startsWith` keep the raw string.** `{field:"name", operator:"contains", value:"AbC"}` → `{type:"contains", field:"name", value:"AbC"}` (no numeric coercion, case preserved — the backend decides case via `caseSensitive`, defaulting to `ILIKE`).
- **Numeric-wire coercion for equality/comparison.** For a column whose `wireType` is `"number"`, `{operator:"eq", value:"42"}` → `value: 42` (number), and `gt`/`gte`/`lt`/`lte` likewise. A non-numeric string on a numeric column produces `NaN` — decide and pin the behaviour (either drop the row or pass `NaN`; prefer **drop** so a typo doesn't send a nonsense bind).
- **Boolean-wire coercion.** For a `"boolean"`-wire column, `value:"true"`→`true`, `value:"false"`→`false`.
- **String/other wire passes through.** A `"string"`/`"isoString"` column with `eq` keeps the string value.
- **Preserves order and AND semantics.** Multiple conditions map to multiple descriptors in input order; the caller AND-combines them by applying each via `filterBy` (the store's top-level list is an implicit AND, matching the backend's `WHERE … AND …`).

### Backend (already implemented — re-pinned, unit-testable via pytest)

- Unknown sort/filter column → `ValidationError` (HTTP 422), raised in the operation constructor **before any I/O**.
- Filter values are bound as `$n`; identifiers are `quote_ident`-quoted with embedded `"` doubled.
- `contains`/`startsWith` escape `%`/`_`/`\` and select `ILIKE` (default) or `LIKE` (`caseSensitive`).
- Empty `sort`/`filter` → empty `ORDER BY`/`WHERE` clause.

### Sort & filter dialog wiring — manual verification only

- Header click cycles asc → desc → none and the request's `sort=` param updates; shift-click adds a second sort key with a priority badge (library behaviour, verified in the real app).
- Applying a filter narrows the grid and the request carries `filter=`; the toolbar button tints while a filter is active; Clear removes it and the next request has no `filter=`.
- (These involve pointer events, focus, network, and library-owned geometry — not exercisable by the node-only harness.)

---

## Verification

- **Typecheck:** `cd frontend && npx tsc --noEmit` — clean.
- **Frontend unit:** `cd frontend && npx vitest run` — `filterModel.test.ts` green (the `## Expected Behaviour` cases for `buildFilters`).
- **Backend unit:** `cd backend && pytest` — `test_compiler.py` / `test_list_rows.py` green, including any injection-safety case added in step 1.
- **Manual (real app):** launch the app (Vite dev + FastAPI backend), open a navigator table into its Dock grid. (a) Click a header through asc/desc/none; watch DevTools Network for the `sort=` param and confirm the grid reorders. (b) Open the filter dialog, apply a `contains` and an `eq`/comparison condition; confirm the `filter=` param, the narrowed grid, and the button's active tint; Clear and confirm the filter drops. Scope DevTools inspection to the active panel's grid.

---

## Potential Challenges

- **`filterBy` appends.** Re-applying without `clearFilter()` first stacks filters — always `clearFilter()` then re-add on Apply.
- **Value coercion vs. the wire contract.** A numeric column filtered with a comparison must send a `number`, not a string, or the backend binds a text `$n` against a numeric column (Postgres may error or mis-compare). The `coerce` step handles this; the `NaN` case must be decided (prefer dropping the row).
- **Glyph availability.** If no `filter` glyph exists in `@jimka/typescript-ui/glyphs/solid`, reuse an existing registered glyph rather than blocking; confirm the subpath resolves before importing (per the library-notes barrel-resolution papercut).
- **`ComboBox` construction idiom.** Follow the callable + options-bag idiom used elsewhere in the app; `ComboBox` is a non-batch input — verify option population (`ComboOption[]` from `columns`) works with a static list.
- **Reload race.** `sort()`/`filterBy()` fire-and-forget `load()`; the proxy aborts a superseded read via `params.signal`, so rapid header clicks or applies are safe — but confirm no stale-render if the app adds its own load calls (it should not).

---

## Critical Files

- [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) — the grid + toolbar the filter button joins; mirror its `Dialog.show`, glyph-button, and store-event patterns.
- [`frontend/src/data/stores.ts`](frontend/src/data/stores.ts) — confirms `remoteSort`/`remoteFilter`/`pageSize` are already set (the seam that makes sort/filter server-side).
- [`frontend/src/contract.ts`](frontend/src/contract.ts) — `ColumnMeta` (`name`, `wireType`) drives the column list and value coercion.
- [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) — `FilterCompiler`/`OrderCompiler`: the safe identifier-validated, param-bound SQL the descriptors must match.
- [`backend/app/operations/list_rows.py`](backend/app/operations/list_rows.py) + [`backend/app/main.py:265`](backend/app/main.py#L265) — the `list_rows` op and route the `sort=`/`filter=` params flow through.
- Library (read-only, in `@jimka/typescript-ui`): `component/table/Header.ts` (`handleSortClick`/`syncSortIndicators` — the sort UI), `data/AbstractStore.ts` (`sort`/`clearSort`/`filterBy`/`clearFilter`/`getActiveFilters` + `'filterchange'`), `data/FilterDescriptor.ts` (the descriptor union), `overlay/Dialog.ts` (`contentComponent`), `component/input` (`ComboBox`, `TextField`).

---

## Non-Goals

- **Sort UI code.** The library provides header-click sort already; the app writes none — sort is a verification item, not a build item.
- **Rich boolean logic in the filter dialog.** OR-groups, nesting, NOT, and `in` (multi-value) are out for the first cut. The store algebra and backend `FilterCompiler` already support `and`/`or`/`not`/`in`, so a later dialog can grow into them with no backend change — but this plan ships single-field conditions AND-combined only.
- **A per-column inline filter row.** Deferred in favor of the modal dialog (library header/column geometry is not an app seam).
- **Ad-hoc query-panel results.** `QueryPanel` runs arbitrary SQL and is not `remoteFilter`-driven; it is explicitly out of scope.
- **Backend production changes.** `list_rows`/`FilterCompiler`/`OrderCompiler` are complete; this plan only audits/extends their tests.
- **Schema-view grids.** If the schema-views work lands and its view grids read through the same paginated `AjaxStore`/`list_rows` path, they inherit this sort/filter for free — noted as reuse, **not** depended on here.
