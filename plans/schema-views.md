---
touches-shared:
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/dock/StructurePanel.ts
  - frontend/src/SqlAdminController.ts
  - backend/app/operations/list_objects.py
---

# Views & Materialized Views — Implementation Plan

## Overview

Add first-class browsing of **views** and **materialized views** to tsuiSQLAdmin, mirroring how tables work today: they appear in the navigator, open in a Dock work panel showing their **rows as a read-only grid** and their **`pg_get_viewdef` definition** on a toggle, and feed the Properties inspector and the Structure tab exactly as tables do.

The feature spans both halves. **Backend:** the object list ([`backend/app/operations/list_objects.py:20`](backend/app/operations/list_objects.py#L20)) must additionally surface **materialized views** (which `information_schema.tables` omits), a new `ViewDefinitionQuery` returns `pg_get_viewdef(oid, true)` for a regular or materialized view, and column introspection ([`backend/app/operations/list_columns.py:26`](backend/app/operations/list_columns.py#L26)) must cover materialized views (also absent from `information_schema.columns`). **Frontend:** the navigator groups objects under **Tables / Views / Materialized Views** ([`frontend/src/navigator/NavigatorTree.ts:104`](frontend/src/navigator/NavigatorTree.ts#L104)); the controller routes a view/matview to a new read-only `ViewWorkPanel` (grid + Definition Card toggle) instead of the editable `TableWorkPanel` ([`frontend/src/SqlAdminController.ts:89`](frontend/src/SqlAdminController.ts#L89)); the Structure tab is reused unchanged.

The library needs **no** change: view rows read through the existing paginated `AjaxStore`/`AjaxProxy` path ([`frontend/src/data/stores.ts:16`](frontend/src/data/stores.ts#L16)), the grid is a `Table` with `rowReadOnly` ([`frontend/src/dock/StructurePanel.ts:34`](frontend/src/dock/StructurePanel.ts#L34)), the Definition is a read-only `TextArea` (`readOnly` is an existing `TextInput` option), and the Data|Definition toggle is a `Card` ([`layout/Card.ts:176`](../../typescript-ui/src/typescript/lib/layout/Card.ts#L176)).

---

## Architecture Decisions

### `DbObjectKind` gains `"materializedView"` — a distinct kind from `"view"`

The contract's `DbObjectKind` ([`frontend/src/contract.ts:4`](frontend/src/contract.ts#L4)) is `"database" | "schema" | "table" | "view"`. A materialized view is a genuinely distinct object (it holds stored data, supports `REFRESH`, and is introspected from different catalog tables), so it gets its own kind: `"database" | "schema" | "table" | "view" | "materializedView"`. Regular and materialized views share the read-only work-panel treatment but differ in kind so the navigator can group them separately and the definition query can pick the right catalog source. The backend's `ListObjectsQuery.get_result()` already emits a free-form `kind` string, so the wire value is just `"materializedView"` for the new group.

### Materialized views are introspected from `pg_catalog`, not `information_schema`

`information_schema.tables` and `information_schema.columns` **exclude materialized views** (SQL-standard `information_schema` has no concept of them). So:

- **Object listing** ([`list_objects.py`](backend/app/operations/list_objects.py)) keeps its `information_schema.tables` query for tables + regular views, and `UNION ALL`s a `pg_catalog` query for materialized views (`pg_class.relkind = 'm'`, joined to `pg_namespace` on the schema). This keeps the single-round-trip shape (`{name, kind}` rows) while covering all three kinds.
- **Column listing** ([`list_columns.py`](backend/app/operations/list_columns.py)) currently reads `information_schema.columns` + `key_column_usage` for the PK. That query returns **zero rows** for a materialized view, which `_columns_for` ([`main.py:115`](backend/app/main.py#L115)) then treats as `NotFound`. The fix: derive columns from `pg_attribute`/`pg_type` for any relation (works for tables, views, and matviews uniformly), or branch to a `pg_catalog` column query when the relation is a matview. A view/matview has no primary key, so `is_primary_key`/`is_generated` are `false` and `has_default` is `false` — the grid is read-only regardless, so PK detection is not load-bearing for them.

Regular views **are** in `information_schema.columns`, so the existing column query already covers them; only matviews need the catalog fallback.

### View rows read through the existing paginated `AjaxStore` path — never a bulk `MemoryStore`

Per the agreed row-cap decision, a view/matview grid reads rows through the **same paginated `AjaxStore`/`AjaxProxy`/`JsonReader` path tables use** ([`stores.ts:16`](frontend/src/data/stores.ts#L16)), not a bulk in-memory `MemoryStore`. The backend's `ListRowsQuery` ([`list_rows.py:69`](backend/app/operations/list_rows.py#L69)) issues `SELECT *, count(*) OVER() FROM <relation> … LIMIT/OFFSET`, and a view or materialized view is a selectable relation, so the query, pagination, sort, and filter all work verbatim against the existing `/rows` route. This is strictly preferable to a `MemoryStore`:

- It never loads the whole relation into memory, sidestepping the library's **large-`loadData` zero-render bug** (`LIBRARY_NOTES.md`; a view over a big table can be arbitrarily large).
- It reuses `buildStore`/`buildModel`/the `/rows` endpoint with zero new data-path code — the store is identical to a table's read path.

The **only** difference from a table store is that views/matviews are **read-only**: no INSERT/UPDATE/DELETE. So the view panel omits the write toolbar entirely (Add/Delete/Save), and the store's writer/CRUD methods are simply never invoked. `remoteSort`/`remoteFilter` and `pageSize` stay on so the proxy emits the paginated envelope the `JsonReader` requires (an unpaginated read would fail — see `LIBRARY_NOTES.md` "Remote `AjaxStore` silently needs a page size"). No defensive row cap is needed because no in-memory store is used.

Backend safety: the row route's `_columns_for` gate and `ListRowsQuery` were written for tables, but they only `SELECT` — no write path is reachable for a view. A view/matview reaching the `POST`/`PUT`/`DELETE` routes would fail at the DB (Postgres rejects DML on a view without an `INSTEAD OF` trigger / on a matview outright); since the frontend never issues those for a read-only panel, this is defense-in-depth only, not a new guard.

### The view work panel: a read-only grid + a Definition tab, toggled by a `Card`

`ViewWorkPanel` mirrors the shape the master plan described for `TableWorkPanel` (a `Card` switching Data vs. a second view — [`tsui-sql-admin.md:493`](plans/implemented/tsui-sql-admin.md#L493)), but with **Data | Definition** instead of Data | Structure, and **no write actions**:

```
ViewWorkPanel (Panel, Border layout)
├─ NORTH : ToolBar — [Data] [Definition] segmented toggle, Spacer.flex(), Refresh
└─ CENTER: Card
            ├─ id "data"      : Table(store, { rowReadOnly: () => true })  — paginated view rows
            └─ id "definition": TextArea(defn, { readOnly: true })          — pg_get_viewdef SQL
```

- The **Data page** is `Table(store, buildViewColumnSpec(columns))` where the spec sets `rowReadOnly: () => true` — the same read-only lock `StructurePanel` ([`StructurePanel.ts:34`](frontend/src/dock/StructurePanel.ts#L34)) and `RoleGrantsPanel` ([`RoleGrantsPanel.ts:44`](frontend/src/dock/RoleGrantsPanel.ts#L44)) use. The store is the paginated `AjaxStore` from `buildStore`.
- The **Definition page** is a read-only `TextArea` seeded with the `pg_get_viewdef` SQL. `TextInput` already supports `readOnly` via its options bag and `setReadOnly` ([`TextInput.ts:146`](../../typescript-ui/src/typescript/lib/component/input/TextInput.ts#L146)) — so the text is selectable/scrollable but not editable. The definition is fetched once (lazily, on first switch to the tab, or eagerly with the panel — see *Definition fetch timing*).
- The toggle is a `Card` selected by `setVisibleComponentId("data" | "definition")` ([`Card.ts:176`](../../typescript-ui/src/typescript/lib/layout/Card.ts#L176)), driven by two toolbar buttons (a segmented Data|Definition pair mirroring the QueryPanel toolbar idiom, [`QueryPanel.ts:226`](frontend/src/dock/QueryPanel.ts#L226)). Refresh reloads the store (`store.reject()` is unnecessary — no pending edits — so just `store.load()`).

**Why not reuse `TableWorkPanel` with the toolbar hidden:** `TableWorkPanel` ([`TableWorkPanel.ts:39`](frontend/src/dock/TableWorkPanel.ts#L39)) hard-wires Add/Delete/Save to the store's mutation methods and a required-fields validator; a view has none of that. A separate `ViewWorkPanel` is clearer than threading a `readOnly` flag through every toolbar branch of `TableWorkPanel`, and keeps each panel single-responsibility (the same reasoning that keeps `StructurePanel`/`RoleGrantsPanel` separate).

### The controller routes view/matview to `ViewWorkPanel`, keeping table open unchanged

`SqlAdminController.openTable` ([`SqlAdminController.ts:89`](frontend/src/SqlAdminController.ts#L89)) is the single open path; the navigator already calls it for both `"table"` and `"view"` ([`NavigatorTree.ts:36`](frontend/src/navigator/NavigatorTree.ts#L36)). The routing decision moves into the controller: for a `"view"`/`"materializedView"` ref it builds the read-only `ViewWorkPanel` (fetching the definition alongside the columns), for a `"table"` it builds `TableWorkPanel` as today. The store construction (`getColumns` → `buildModel` → `buildStore` → `store.load()`), dedup by `panelId`, error wiring, and lazy-panel add are shared — only the panel factory differs. The navigator's `openTable` call is renamed conceptually to "open object" but the method name and signature stay to minimise churn; the `kind` is already on `ref`.

`openStructure` ([`SqlAdminController.ts:131`](frontend/src/SqlAdminController.ts#L131)) and the right-click "Open structure"/"Open as query" menu ([`NavigatorTree.ts:45`](frontend/src/navigator/NavigatorTree.ts#L45)) already accept views and need **no change** — the Structure tab (`StructurePanel`) and the generated-`SELECT` query panel both work for views/matviews as-is (columns introspect, `SELECT * FROM view` runs). This plan reuses them.

### `REFRESH MATERIALIZED VIEW` is a Non-Goal (DDL-adjacent)

A materialized view holds a stored snapshot and can be refreshed with `REFRESH MATERIALIZED VIEW`. That is a **mutating, DDL-adjacent** operation, and the app's DDL (create/alter/drop, `GRANT`/`REVOKE`) is deferred consistently ([`tsui-sql-admin.md:706`](plans/implemented/tsui-sql-admin.md#L706), phase-2 Non-Goals). Adding it would need a write `Command`, a confirmation affordance, and a data-staleness story — out of scope here. The matview panel is read-only like a view; `REFRESH` is noted as future, not built. (The seam is trivial when wanted: one `RefreshMatViewCommand` + one toolbar button gated on `kind === "materializedView"`.)

### Definition fetch timing — lazy on first Definition switch

The `pg_get_viewdef` fetch is a separate introspection call (`getViewDefinition` in `api.ts`). Fetch it **lazily on the first switch to the Definition tab**, not eagerly on open: most view interactions are with the data grid, and a lazy fetch keeps the panel open latency identical to a table's. A monotonic/once guard caches the result so re-toggling doesn't refetch; a fetch error routes to the panel's `notify`/`onError` (the controller's `notifyError`), leaving the Definition pane showing a short error rather than blank. (Eager fetch is a reasonable alternative — the definition is small — but lazy avoids a wasted round-trip for the common data-only session.)

---

## Public API

### Contract — `frontend/src/contract.ts` (mirror `backend/app/contract.py` where typed)

```ts
// DbObjectKind gains materializedView (a distinct read-only, refreshable object)
export type DbObjectKind = "database" | "schema" | "table" | "view" | "materializedView";

// pg_get_viewdef payload for a (materialized) view
export interface ViewDefinition {
    definition: string;   // the reconstructed SELECT (pg_get_viewdef(oid, true))
}
```

`ColumnMeta` is unchanged — a view/matview's columns fill the same shape (PK/generated/default all `false`).

### Frontend data path — `frontend/src/data/api.ts`

```ts
/** Fetch a (materialized) view's definition SQL (pg_get_viewdef). */
export function getViewDefinition(ref: DbObjectRef): Promise<ViewDefinition>;
```

Uses the existing `getJson<T>` client ([`api.ts:30`](frontend/src/data/api.ts#L30)) against `GET /api/{conn}/{db}/{schema}/{name}/definition`.

### Frontend component — `frontend/src/dock/ViewWorkPanel.ts`

```ts
/** Read-only work panel for a view/matview: paginated data grid + Definition toggle. */
export function ViewWorkPanel(
    store: AjaxStore,
    columns: ColumnMeta[],
    loadDefinition: () => Promise<string>,   // lazy pg_get_viewdef fetch (controller-bound)
    onError: (error: unknown) => void,
): Panel;
```

Mirrors the `TableWorkPanel(store, columns, notify): Panel` factory signature ([`TableWorkPanel.ts:39`](frontend/src/dock/TableWorkPanel.ts#L39)).

### Backend operation — `backend/app/operations/view_definition.py`

```python
class ViewDefinitionQuery(Query):   # pg_get_viewdef by relation oid (view or matview)
    def __init__(self, conn, table: TableRef) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> dict:   # {"definition": str}; raises NotFound if the relation is absent
```

`ListObjectsQuery` ([`list_objects.py`](backend/app/operations/list_objects.py)) is modified (adds the matview `UNION`); `ListColumnsQuery` ([`list_columns.py`](backend/app/operations/list_columns.py)) is modified (covers matviews). Both keep their existing `get_result()` contract shapes.

### Route — `backend/app/main.py`

```
GET /api/{connection_id}/{database}/{schema}/{name}/definition  ->  {"definition": str}
```

Thin: acquire → `ViewDefinitionQuery(c, TableRef(...))` → apply → get_result, mapping `NotFound` → 404 via the existing handler.

---

## Internal Structure

### `ListObjectsQuery` — add the materialized-view UNION

The current query ([`list_objects.py:20`](backend/app/operations/list_objects.py#L20)) reads `information_schema.tables`. Extend to `UNION ALL` a `pg_catalog` matview query, still parameterised on `$1 = schema`:

```sql
SELECT table_name AS name,
       CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind
FROM information_schema.tables
WHERE table_schema = $1
UNION ALL
SELECT c.relname AS name, 'materializedView' AS kind
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'm' AND n.nspname = $1
ORDER BY name
```

`get_result()` is unchanged (`{name, kind}` per row); the wire `kind` is now one of `"table" | "view" | "materializedView"`.

### `ListColumnsQuery` — cover materialized views

`information_schema.columns` omits matviews, so column introspection must fall back to `pg_catalog` for relations it doesn't cover. The simplest correct change: derive columns from `pg_attribute` + `pg_type` for **any** relation kind (`relkind IN ('r','v','m','p','f')`), which returns name/type/nullable uniformly, and left-join the PK from `pg_index`/`pg_constraint` (empty for views/matviews). Alternatively, keep the existing `information_schema` query for tables/views and add a `pg_catalog` branch selected when the relation is a matview. Either way, for a view/matview `is_primary_key`, `is_generated`, and `has_default` are `false`, and `data_type` comes from `format_type(atttypid, atttypmod)` (mapped through `pg_type_to_wire` as today, [`list_columns.py:88`](backend/app/operations/list_columns.py#L88)). The `_columns_for` `NotFound` gate ([`main.py:129`](backend/app/main.py#L129)) then no longer misfires on a matview.

### `ViewDefinitionQuery` — pg_get_viewdef by oid

```python
_SQL = (
    "SELECT pg_get_viewdef(c.oid, true) AS definition "
    "FROM pg_catalog.pg_class c "
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
    "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')"
)
```

`pg_get_viewdef(oid, true)` returns the pretty-printed reconstructed `SELECT` for both regular (`relkind='v'`) and materialized (`relkind='m'`) views. `apply()` fetches (zero or one row); `get_result()` returns `{"definition": row["definition"]}` or raises `NotFound` when absent (the route maps it to 404). Identifiers are bound as `$1`/`$2` params, never interpolated — no `quote_ident` needed.

### Navigator grouping — Tables / Views / Materialized Views

`loadObjects` ([`NavigatorTree.ts:104`](frontend/src/navigator/NavigatorTree.ts#L104)) currently maps every object to a flat leaf node. Group them under three synthetic, non-selectable **category nodes** between the schema and the leaves:

```
schema
├─ Tables               (category node: hasChildren, no data/ref, children = the table leaves)
├─ Views                (category node; children = the view leaves)
└─ Materialized Views   (category node; children = the matview leaves)
```

- Each category node has `hasChildren: true` and its `children` pre-populated (the objects are already fetched in one `getObjects` call, so no extra round-trip and no `loadChildren`); it carries **no `data`** so selecting it is a no-op in the `"selection"` handler (`ref` is undefined → early return, [`NavigatorTree.ts:30`](frontend/src/navigator/NavigatorTree.ts#L30)). Empty categories are omitted (no "Views" node when a schema has no views), matching the navigator's "show what's there" style.
- The leaf nodes are unchanged except that a matview leaf gets `kind: "materializedView"`; a glyph per category (e.g. `table`, `eye`/`table`, `layer-group`) is optional polish.
- The right-click `contextmenu` handler ([`NavigatorTree.ts:45`](frontend/src/navigator/NavigatorTree.ts#L45)) currently gates on `kind === "table" || kind === "view"`; extend it to include `"materializedView"` so a matview also offers Open structure / Open as query.

### Controller routing — `openTable` picks the panel by kind

In `openTable` ([`SqlAdminController.ts:115`](frontend/src/SqlAdminController.ts#L115)), branch the `content` factory on `ref.kind`:

```ts
const isReadOnly = ref.kind === "view" || ref.kind === "materializedView";
this.dock.addLazyPanel({
    id, title: ref.name ?? id, tooltip: this.panelTooltip(ref),
    content: isReadOnly
        ? () => ViewWorkPanel(store, columns, () => this.loadViewDefinition(ref), err => this.notifyError(err, ref))
        : () => TableWorkPanel(store, columns, notify),
});
```

`loadViewDefinition(ref)` calls `getViewDefinition(ref)` and returns `.definition`. The store/dedup/error wiring above the branch is untouched. `store.on("sync", …)` (write feedback) is still attached but never fires for a read-only panel — harmless; optionally skip attaching it for read-only refs.

---

## Ordered Implementation Steps

1. **Contract kinds (both sides).** In [`frontend/src/contract.ts`](frontend/src/contract.ts), add `"materializedView"` to `DbObjectKind` and add the `ViewDefinition` interface. No Python `DbObjectKind` enum exists (the backend emits a free string), so no `contract.py` type change — only the SQL emits the new value.
2. **`ListObjectsQuery` — matview UNION.** In [`backend/app/operations/list_objects.py`](backend/app/operations/list_objects.py), add the `pg_catalog.pg_class relkind='m'` `UNION ALL` (per *Internal Structure*). `get_result()` unchanged. Verify: unit test set `_raw` to include a `{"name","kind":"materializedView"}` row → passes through.
3. **`ListColumnsQuery` — cover matviews.** In [`backend/app/operations/list_columns.py`](backend/app/operations/list_columns.py), make the column query return rows for materialized views (pg_catalog fallback or a unified `pg_attribute` query). Keep `get_columns_result()`/`get_result()` shapes. Verify with a live matview that `/columns` returns its columns (offline: the `get_result()` mapping test is unchanged since it feeds `_raw` directly).
4. **`ViewDefinitionQuery`.** New [`backend/app/operations/view_definition.py`](backend/app/operations/view_definition.py) with the `pg_get_viewdef` query and `get_result()` → `{"definition": str}` / `NotFound` on empty. Export it from [`backend/app/operations/__init__.py`](backend/app/operations/__init__.py) (`__all__` + import).
5. **Definition route.** In [`backend/app/main.py`](backend/app/main.py), add `GET /api/{connection_id}/{database}/{schema}/{name}/definition` (acquire → `ViewDefinitionQuery` → apply → get_result). Place it near the `/columns` route; ordering is not load-bearing (distinct literal suffix). Import the op.
6. **Backend tests.** Add [`backend/tests/test_view_definition.py`](backend/tests/test_view_definition.py) (set `op._raw` by hand: a row → `{"definition": …}`; empty → `NotFound`; `get_result()` before `apply()` → `RuntimeError`), mirroring [`test_list_objects.py`](backend/tests/test_list_objects.py). Extend [`test_list_objects.py`](backend/tests/test_list_objects.py) with a matview row in `_raw`.
7. **Frontend data path.** In [`frontend/src/data/api.ts`](frontend/src/data/api.ts), add `getViewDefinition(ref)` using `getJson<ViewDefinition>` against the `/definition` route. Add a unit test to [`api.test.ts`](frontend/src/data/api.test.ts) (mock fetch → URL + parsed shape), matching the existing `getColumns` test pattern.
8. **`ViewWorkPanel`.** New [`frontend/src/dock/ViewWorkPanel.ts`](frontend/src/dock/ViewWorkPanel.ts): a `Border` panel with a NORTH toolbar (Data|Definition toggle + `Spacer.flex()` + Refresh) over a `Card` with a read-only data `Table` and a read-only `TextArea` definition page; lazy definition fetch on first Definition switch, cached, errors to `onError`. Register the `refresh` glyph (already imported by `TableWorkPanel`).
9. **Navigator grouping.** In [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts), rewrite `loadObjects` to build the three category nodes (Tables / Views / Materialized Views) with pre-populated children, omitting empty categories; category nodes carry no `data`. Extend the `contextmenu` kind gate to include `"materializedView"`.
10. **Controller routing.** In [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts), branch `openTable`'s `content` factory on `ref.kind` (table → `TableWorkPanel`, view/matview → `ViewWorkPanel`); add a private `loadViewDefinition(ref)` calling `getViewDefinition`. Leave `openStructure`/`showProperties` unchanged (they already handle views).
11. **Regression checkpoints.**
    - `grep -rn '"materializedView"' frontend/src backend/app` — the kind appears in contract, navigator, controller, and the objects SQL.
    - `grep -rn 'ViewWorkPanel' frontend/src` — imported by the controller, defined once.
    - Backend `pytest`; frontend `npm run build` (or `tsc --noEmit`) clean; frontend `vitest run` green.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `backend/app/operations/view_definition.py` — `ViewDefinitionQuery` (pg_get_viewdef) |
| Create | `backend/tests/test_view_definition.py` — `get_result()` + temporal-guard tests |
| Create | `frontend/src/dock/ViewWorkPanel.ts` — read-only grid + Definition `Card` toggle |
| Modify | `backend/app/operations/list_objects.py` — matview `UNION ALL` (**touches-shared**) |
| Modify | `backend/app/operations/list_columns.py` — cover materialized-view columns |
| Modify | `backend/app/operations/__init__.py` — export `ViewDefinitionQuery` |
| Modify | `backend/app/main.py` — `/definition` route |
| Modify | `backend/tests/test_list_objects.py` — a matview row case |
| Modify | `frontend/src/contract.ts` — `"materializedView"` kind + `ViewDefinition` |
| Modify | `frontend/src/data/api.ts` — `getViewDefinition` |
| Modify | `frontend/src/data/api.test.ts` — `getViewDefinition` test |
| Modify | `frontend/src/navigator/NavigatorTree.ts` — Tables/Views/Matviews grouping (**touches-shared**) |
| Modify | `frontend/src/SqlAdminController.ts` — route view/matview to `ViewWorkPanel` (**touches-shared**) |

`frontend/src/dock/StructurePanel.ts` is listed as **touches-shared** with the structure-detail plan but is **not modified** here — this plan reuses it unchanged for view/matview structure tabs. No files are deleted.

---

## Expected Behaviour

### Backend `ViewDefinitionQuery.get_result()` — offline unit-testable (pure, set `_raw`)

- A single row `[{"definition": "SELECT ..."}]` → `{"definition": "SELECT ..."}`.
- Empty `_raw` (no such view/matview) → raises `NotFound` (route maps to 404).
- `get_result()` before `apply()` → `RuntimeError`.

### Backend `ListObjectsQuery.get_result()` — offline unit-testable

- `_raw` mixing table/view/materializedView rows → each passed through as `{name, kind}` with `kind` preserved verbatim, including `"materializedView"`.

### Backend `ListColumnsQuery` / integration — live-verify (needs a real matview)

- `GET …/{matview}/columns` returns its columns (name/dataType/nullable, all flags `false`) instead of an empty list / 404.
- `GET …/{matview}/rows?page=1&pageSize=100` returns `{rows, totalCount}` — a matview is a selectable relation.
- `GET …/{view}/rows` likewise paginates a regular view.
- `GET …/{view or matview}/definition` returns the reconstructed `SELECT`.

### Frontend `getViewDefinition` — offline unit-testable (mock fetch)

- Calls `GET /api/{conn}/{db}/{schema}/{name}/definition` and returns the parsed `{definition}`; a non-OK response throws the backend `detail` (shared `getJson` behaviour).

### Navigator grouping — live-verify (DOM events + async expand)

- Expanding a schema shows up to three category nodes: **Tables**, **Views**, **Materialized Views** — only those with members; a schema with no views omits the Views node.
- Expanding a category shows its leaves; selecting a category node does nothing (no `data`).
- Selecting a view/matview leaf opens its read-only work panel; right-clicking it offers Open structure / Open as query.

### `ViewWorkPanel` — live-verify (Card toggle, layout, lazy fetch)

- Opening a view/matview shows the **Data** page: a paginated read-only grid; cells are not editable; there is **no** Add/Delete/Save toolbar.
- Switching to **Definition** shows the `pg_get_viewdef` SQL in a read-only, selectable text area; the fetch happens once (re-toggling does not refetch); a failed definition fetch surfaces via `notifyError`, not a blank pane.
- Refresh reloads the grid (a matview whose underlying data changed reflects it after `REFRESH` is run out-of-band; the panel itself does not refresh the matview — see Non-Goals).
- Sorting/filtering a column issues a paginated read against `/rows` (same as a table).

### Controller routing — live-verify

- A `"table"` ref still opens the editable `TableWorkPanel` (regression); a `"view"`/`"materializedView"` ref opens `ViewWorkPanel`. Re-opening either focuses the existing tab (dedup by `panelId`, unchanged).

---

## Verification

- **Backend:** `cd backend && pytest tests/test_view_definition.py tests/test_list_objects.py` green; full `pytest` for regressions.
- **Frontend:** `cd frontend && npm run build` (or `tsc --noEmit`) clean; `vitest run` — the `api.test.ts` `getViewDefinition` case passes.
- **Grep invariants:** `grep -rn '"materializedView"' frontend/src backend/app` — present in contract, navigator, controller, objects SQL; `grep -rn 'ViewWorkPanel' frontend/src` — defined once, imported by the controller; `grep -rn 'REFRESH MATERIALIZED' backend frontend` — zero (Non-Goal).
- **Manual smoke (chrome-devtools, `:5173` + backend `:8000` against a Postgres with a view and a materialized view):** navigator grouping (Tables/Views/Materialized Views, empties omitted); open a view → read-only grid + Definition toggle; open a matview likewise; Structure tab and Open-as-query still work for both; a table still opens the editable panel. Scope DevTools queries to the panel by its Dock panel id to avoid the coexisting table panels.

---

## Potential Challenges

- **Materialized views absent from `information_schema`.** Both `list_objects` (list) and `list_columns` (columns) miss matviews; mitigation is the `pg_catalog` (`pg_class`/`pg_attribute`) fallback in both — the single largest risk, called out in *Internal Structure*.
- **`_columns_for` `NotFound` on a matview.** ([`main.py:129`](backend/app/main.py#L129)) treats an empty column list as a missing table; once `list_columns` covers matviews this resolves, but the fix must land **before** matview rows/definition are exercised (the `/rows` and grid paths call `_columns_for`).
- **View has no primary key.** `buildModel` sets `primaryKey` from the PK column ([`buildModel.ts:22`](frontend/src/data/buildModel.ts#L22)); for a view it's `undefined`, so `record.getId()` is undefined — fine, because the read-only panel never issues `PUT`/`DELETE` (which build `…/rows/{id}`). No change needed, but do not add write actions to `ViewWorkPanel`.
- **Unpaginated read fails.** The `JsonReader` only parses the `{rows,totalCount}` envelope in paginated mode; `buildStore` already sets `pageSize`/`remoteSort`/`remoteFilter`, so reuse `buildStore` unchanged rather than hand-rolling a store (`LIBRARY_NOTES.md`).
- **`TextArea` read-only support.** Confirmed: `TextInput` honours a `readOnly` option and `setReadOnly` ([`TextInput.ts:146`](../../typescript-ui/src/typescript/lib/component/input/TextInput.ts#L146)). Use the option at construction; do not assume a bespoke read-only text component exists.
- **Category-node selection.** A category node with no `data` must be a no-op in the `"selection"` handler; the existing early-return on `!ref` ([`NavigatorTree.ts:30`](frontend/src/navigator/NavigatorTree.ts#L30)) already covers it — verify the category nodes really carry no `data`.
- **Definition of a view over another view.** `pg_get_viewdef` reconstructs the stored `SELECT` regardless of nesting; no special handling.

---

## Critical Files

- [`backend/app/operations/list_objects.py`](backend/app/operations/list_objects.py) — the object-list query to extend with the matview UNION.
- [`backend/app/operations/list_columns.py`](backend/app/operations/list_columns.py) — the column query to extend for matviews; `pg_type_to_wire` mapping.
- [`backend/app/operations/list_rows.py`](backend/app/operations/list_rows.py) — the paginated read reused verbatim for view/matview rows.
- [`backend/app/operations/role_detail.py`](backend/app/operations/role_detail.py), [`roles.py`](backend/app/operations/roles.py) — a `Query` taking a name param bound as `$1`; the shape `ViewDefinitionQuery` follows.
- [`backend/app/main.py`](backend/app/main.py) — the acquire→construct→apply→get_result route shape and `_columns_for` gate.
- [`backend/app/contract.py`](backend/app/contract.py), [`backend/app/wire.py`](backend/app/wire.py) — `TableRef`, `ColumnMeta`, `pg_type_to_wire`.
- [`backend/tests/test_list_objects.py`](backend/tests/test_list_objects.py), [`tests/conftest.py`](backend/tests/conftest.py) — the `NO_CONN` + set-`_raw` test pattern.
- [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) — the panel factory shape `ViewWorkPanel` mirrors (minus write actions).
- [`frontend/src/dock/StructurePanel.ts`](frontend/src/dock/StructurePanel.ts) — the `rowReadOnly` read-only `Table` pattern; reused unchanged for view structure tabs.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — the toolbar-button + body idiom (and the read-only result `Table`).
- [`frontend/src/dock/RoleGrantsPanel.ts`](frontend/src/dock/RoleGrantsPanel.ts) — a read-only grid built as a factory `Panel`.
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) — the lazy tree, `node.data` refs, selection/contextmenu handlers to extend for grouping.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — `openTable`/`openStructure` routing, dedup, error wiring.
- [`frontend/src/data/api.ts`](frontend/src/data/api.ts), [`stores.ts`](frontend/src/data/stores.ts), [`buildModel.ts`](frontend/src/data/buildModel.ts) — the introspection fetch client, the paginated `AjaxStore` builder (reused for view rows), the `Model` builder.
- [`layout/Card.ts`](../../typescript-ui/src/typescript/lib/layout/Card.ts), [`component/input/TextInput.ts`](../../typescript-ui/src/typescript/lib/component/input/TextInput.ts), [`component/table/ColumnConfig.ts`](../../typescript-ui/src/typescript/lib/component/table/ColumnConfig.ts) — the library `Card` toggle, `readOnly` text input, and `rowReadOnly` spec used by `ViewWorkPanel`.
- [`plans/implemented/tsui-sql-admin.md`](plans/implemented/tsui-sql-admin.md) (Data|Structure Card :493, DDL Non-Goal :706), [`phase-2-roles-browser.md`](plans/implemented/phase-2-roles-browser.md) (read-only Dock grid + paginated store pattern) — the governing patterns.

---

## Non-Goals

- **`REFRESH MATERIALIZED VIEW`** — a mutating, DDL-adjacent action, deferred with the app's other DDL. The matview panel is read-only; refresh is a future one-`Command`-plus-one-button seam.
- **Editing view/matview rows** — views/matviews are read-only; no INSERT/UPDATE/DELETE, no write toolbar. (Even an updatable view with `INSTEAD OF` triggers stays read-only here.)
- **CREATE / ALTER / DROP VIEW (DDL)** — out of scope, consistent with the app's deferred DDL.
- **A bulk in-memory (`MemoryStore`) view grid** — rejected in favour of the paginated `AjaxStore` read path (avoids the large-`loadData` render bug and unbounded memory).
- **View dependency / usage graph** (what a view depends on, what depends on it) — not shown; only the definition and columns.
- **Distinguishing updatable vs. non-updatable views, WITH CHECK OPTION, recursive/temporary views** — all treated uniformly as read-only relations.
- **A `Form` component for the Definition** — it is a plain read-only `TextArea`; no `Form`/`Binding` introduced.
