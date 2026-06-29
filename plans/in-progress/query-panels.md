---
depends-on:
  - tsui-sql-admin
---

# tsuiSQLAdmin Phase 1.5 — Arbitrary-SQL Query Panels — Implementation Plan

## Overview

Phase 1.5 adds **arbitrary-SQL query panels** to tsuiSQLAdmin: a Dock work-panel in which the user types raw SQL into a plain multi-line text input, runs it, and sees the result rendered in a `Table` grid (for statements that return rows) or a status line with the affected row count (for statements that do not), with backend errors surfaced through the existing error sink. This is the "run SQL → arbitrary result grid" feature that the Phase 0/1 plan reserved only as a seam ([`plans/tsui-sql-admin.md:208`](./implemented/tsui-sql-admin.md#L208) — *Phase-1.5 query panels are a seam, not a feature*; Non-Goal at [`:699`](./implemented/tsui-sql-admin.md#L699)). There is **no** SQL syntax-highlighting / code editor — a plain `TextArea` is the explicit choice (the editor stays a deferred Non-Goal, [`:700`](./implemented/tsui-sql-admin.md#L700)).

**Where the code lands:** the standalone external app workspace `/home/jika/typescript/sqladmin` — frontend at `frontend/src/`, backend (Python/FastAPI + asyncpg) at `backend/app/`. This plan itself lives in the app repo (`sqladmin/plans/`, alongside the implemented Phase 0/1 plan under `plans/implemented/`). **It adds no changes to the `@jimka/typescript-ui` library repo.** The whole feature composes already-published library pieces — `TextArea` ([`src/typescript/lib/component/input/TextArea.ts:44`](../../typescript-ui/src/typescript/lib/component/input/TextArea.ts#L44), re-exported [`component/input/index.ts:32`](../../typescript-ui/src/typescript/lib/component/input/index.ts#L32), bucket `./component/input` present at [`package.json:32`](../../typescript-ui/package.json#L32)), `Table` + `MemoryStore`, `Dock.addPanel`/`addLazyPanel` ([`src/typescript/lib/overlay/Dock.ts:273`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L273), [`:316`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L316)), `Border`/`Split`/`Fit` layout, `Button`/`ToolBar` — all already imported by the existing app.

The feature mirrors the existing app's structure almost exactly: the panel is built like [`frontend/src/dock/TableWorkPanel.ts:39`](#) and [`frontend/src/dock/StructurePanel.ts:12`](#) (callable factory returning a `Panel`); the dock open/dedup/disposal discipline reuses [`frontend/src/SqlAdminController.ts`](#) (`focusPanel` dedup, the single `dock.on("close")` disposal subscription, `notifyError`); the backend endpoint is one more CQRS operation following [`backend/app/operations/list_rows.py:26`](#) and the thin **POST**-route shape of `insert_row` at [`backend/app/main.py:242`](#).

---

## Architecture Decisions

### No library changes — the seam already holds

`Dock.addPanel`/`addLazyPanel` take any `DockPanelSpec` whose `content` is an arbitrary `Component`/factory ([`Dock.ts:28`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L28), [`:273`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L273)), and the multi-line input the panel needs — `TextArea` — is already a published, exported component in the `./component/input` bucket ([`package.json:32`](../../typescript-ui/package.json#L32); barrel [`component/input/index.ts:32`](../../typescript-ui/src/typescript/lib/component/input/index.ts#L32)). The result grid is a `Table` over a `MemoryStore` ([`MemoryStore.ts:21`](../../typescript-ui/src/typescript/lib/data/MemoryStore.ts#L21)) whose columns are auto-appended from the model — the exact pattern `StructurePanel` already uses (`Table(store, { columns: [] })`, [`frontend/src/dock/StructurePanel.ts:34`](#)). **No library symbol is missing**, so this plan declares **no library-side prerequisite**. (If, at implementation time, a needed symbol turned out not to be re-exported from its bucket barrel, that would be a one-line library barrel addition to flag — but none is known.)

### Result shape: a one-shot fetch into a `MemoryStore`, not `AjaxStore`

An arbitrary-SQL result has no primary key, no stable collection URL, and no update/destroy semantics, so it does **not** fit the `AjaxStore`/`AjaxProxy` CRUD path the Phase 0/1 plan reserves for table rows (*Two explicitly-separate data paths*, [`tsui-sql-admin.md:205`](./implemented/tsui-sql-admin.md#L205)). It is a **one-shot fetch**, so it goes through the **introspection-style typed-fetch path** (`frontend/src/data/api.ts`, [`frontend/src/data/api.ts:23`](#)) — a new `runQuery(connectionId, sql)` POST that returns a typed envelope — and the returned rows load into a **`MemoryStore`** that backs the result `Table`. This keeps the existing decision intact (CRUD ⇒ `AjaxStore`; everything else ⇒ `api.ts` + `MemoryStore`) and reuses the *single error sink*: the POST's error body is read like every other `api.ts` call and funnelled to `SqlAdminController.notifyError`.

### Dynamic columns from the backend result description

Columns are unknown until the query runs. The backend's `Query` operation reads the **asyncpg statement result description** to emit column metadata (each column's `name` + inferred `WireType`) alongside the wire-mapped rows. The frontend builds a `Model` from that metadata (reusing the existing `WIRE_TO_FIELD` map in [`frontend/src/data/buildModel.ts:10`](#) via a new `buildQueryModel(columns)`), loads the rows into a `MemoryStore`, and renders `Table(store, { columns: [] })` so the grid auto-appends one column per model field, in order. Duplicate / unnamed result columns (e.g. `SELECT 1, 1` or `SELECT count(*)`) are disambiguated server-side to stable unique names (`column`, `column_2`, …) so the `Model`'s field names never collide.

### Backend execution: any single statement, classified by result presence; explicit transaction

Arbitrary SQL is intentionally powerful (DB-admin tool, single trusted `"default"` connection, no auth — per Non-Goals [`tsui-sql-admin.md:707`](./implemented/tsui-sql-admin.md#L707)), so a query panel runs **any single statement**, not only `SELECT`. **Exactly one statement per run** — multi-statement scripts are disallowed (see *Single statement only* below and Non-Goals). The new operation is a **`Command`** (it may write), and follows the CQRS contract ([`backend/app/operations/base.py:21`](#)): the constructor captures inputs (no compilation needed — the SQL is opaque, executed as a single text statement with **no parameter binding and no identifier validation**, which is acceptable precisely because arbitrary SQL is the point); `apply()` runs the statement inside an explicit transaction (`async with self._conn.transaction()`) and stores the raw result; `get_result()` purely classifies and transforms:

- **Statement returned rows** (asyncpg `fetch` produced records, or the result has a row description) → `{ "kind": "rows", "columns": [QueryColumnMeta], "rows": [...], "rowCount": N }`, rows wire-mapped via the existing `rows_to_wire` ([`backend/app/wire.py:209`](#)).
- **Statement returned no rows** (INSERT/UPDATE/DELETE/DDL) → `{ "kind": "status", "command": "INSERT 0 3", "rowCount": 3 }`, lifting the affected count from asyncpg's command-status tag (`conn.execute` returns e.g. `"INSERT 0 3"`, `"UPDATE 5"`, `"CREATE TABLE"`).

To get both the row description and the command tag from one call, `apply()` uses a **prepared statement**: `stmt = await conn.prepare(sql)`; `stmt.get_attributes()` yields the column description (empty for non-row statements); `await stmt.fetch()` yields the rows; the command tag is read from the connection's last status. A statement producing rows reports `kind: "rows"` even when empty (so an empty `SELECT` shows an empty grid with headers, not a status line). **Transaction handling:** each run is one statement inside one transaction — it commits on success or rolls back on error.

### Single statement only — enforced by the extended protocol

A run executes **exactly one** SQL statement. This is not an extra check the operation adds — it falls out of using `conn.prepare()`: asyncpg's prepared statements go over the PostgreSQL **extended query protocol**, which accepts only a single command, so a `;`-separated multi-statement script raises a `PostgresSyntaxError` (`cannot insert multiple commands into a prepared statement`). That error is an `asyncpg.PostgresError`, already mapped to `(400, {detail})` by the existing handler ([`backend/app/main.py:75`](#)) — so a multi-statement submission surfaces a clear backend error through the normal sink with **no new code**. We deliberately do **not** add `conn.execute()`-based simple-protocol fallback (which would accept multiple commands but yield no clean row description for the grid). A trailing semicolon on a single statement is fine — only *multiple* commands are rejected.

### Errors map to the existing `(status, {detail})` contract

A SQL syntax/semantic error is an `asyncpg.PostgresError`, already mapped to `(400 | 409, {detail})` by the existing handler ([`backend/app/main.py:75`](#)) — no new handler. The frontend's `runQuery` reads the `{detail}` body exactly like the other `api.ts` calls ([`frontend/src/data/api.ts:8`](#)) and the panel routes it to the controller's `notifyError`, whose `detailOf` already unwraps `{detail}` ([`frontend/src/SqlAdminController.ts:268`](#)). No new error taxonomy.

### Opening a query panel: a new `SqlAdminController.openQuery`, dedup by a monotonic counter

Query panels are **not** table-bound, so the table-identity `panelId` scheme ([`frontend/src/SqlAdminController.ts:205`](#)) does not apply: every "New Query" creates a **fresh** panel. The controller gets a `openQuery(seedSql?)` method that mints a **monotonic id** (`query-1`, `query-2`, …) from a private `_queryCounter`, so re-invoking "New Query" always opens a new panel rather than focusing an existing one (the natural behaviour for a scratch query).

### Query panels are NOT registered in `_openPanels`

The `_openPanels` registry exists to serve the table-panel lifecycle: dedup (`panelId` → `focusPanel`), focus-sync (`syncToPanel` selects the navigator node + shows Properties for the focused table), and status (`updateStatusFor` reads the store's row count). A query panel participates in **none** of these — it has no `DbObjectRef`, no `TreeNode`, no `ColumnMeta[]`, and no dedup. Registering one would also **violate the `OpenPanel` type contract** ([`frontend/src/SqlAdminController.ts:19`](#)), whose `ref`/`node`/`columns` fields are all required, and would **break `syncToPanel`** ([`:225`](#)): focusing a registered query panel would call `selectNode(panel.node)` / `showProperties(panel.ref)` on a non-table entry. So query panels are deliberately **kept out of `_openPanels`**, and neither the `OpenPanel` interface nor `syncToPanel` is touched — *no library and no controller-type change*.

This is safe because a query panel needs no controller-side disposal:
- **Focus** — `syncToPanel` ([`:225`–`230`](#)) already no-ops on an id absent from `_openPanels` (`if (!panel) return`). Focusing a query panel leaves the navigator/Properties untouched (correct — there is nothing to sync), and the status bar simply retains its last message.
- **Close** — `disposePanel` ([`:220`](#)) only `delete`s from `_openPanels`, so it harmlessly no-ops for an unregistered id. The Dock disposes the panel's component subtree itself, and the panel's `MemoryStore` plus its component listeners are unreferenced once the subtree is gone (the controller holds no back-reference to the panel — the injected `notify`/`runQuery` closures point panel→controller, not the reverse), so they are garbage-collected. Nothing leaks.

The only in-flight concern a table panel has — aborting a superseded `AjaxStore.load()` — does not apply: a query runs as one awaited `runQuery` call guarded by a per-panel run-sequence counter (see *Run trigger and run-state*), not a store with a cancellable proxy fetch.

### The "New Query" affordance reuses the already-present `Tools → Run SQL…` menu item

The shell's menubar **already declares** a disabled `Tools → "Run SQL…"` item ([`frontend/src/shell/SqlAdminShell.ts:58`](#)) — the documented seam. Phase 1.5 wires it: `buildMenuBar` takes an `onRunSql` callback (alongside the existing `onToggleSidebar`), the item becomes `{ text: "Run SQL…", action: onRunSql }`, and `SqlAdminShell` passes `() => controller.openQuery()`. No new toolbar/rail button is added — the menu item is the intended entry point.

### "Open as query" — the navigator reuses the query panel with a generated `SELECT`

A table in the navigator can be opened **as a query** in addition to the CRUD `TableWorkPanel`: a `SELECT * FROM "schema"."table" LIMIT n` is generated and dropped into a fresh query panel, the phpMyAdmin "edit the generated SQL" affordance. This is *additive reuse* — it never replaces `openTable`. The CRUD path stays the navigator's primary open (it is the only path with inline editing, server-side pagination, and remote sort/filter — none of which a one-shot `MemoryStore` query result has), so a query panel is the power-user "drop to SQL" complement, not a substitute. The decision to keep the two panels distinct mirrors the Phase 0/1 *two data paths* split (CRUD ⇒ `AjaxStore`; one-shot ⇒ `api.ts` + `MemoryStore`).

- **Generated SQL** is built by a small pure helper `buildSelectSql(ref, limit)` in `frontend/src/data/sql.ts`, quoting each identifier (wrap in `"`, double any embedded `"`) — the front-end mirror of the backend's `quote_ident`. A `LIMIT` (default **50**) is appended so "open as query" on a huge table does not pull the whole table into the `MemoryStore` (a query panel has no pagination — see Non-Goals); the user can raise, lower, or delete the `LIMIT` and re-run.
- **Affordance:** a new item on the navigator's existing right-click menu — the same `contextmenu` handler ([`frontend/src/navigator/NavigatorTree.ts:38`](#)) that already offers "Open structure" ([`:43`](#)), already gated to `kind === "table" | "view"` — labelled "Open as query". Selecting it calls `controller.openQueryFor(ref)`.
- **Controller:** `openQueryFor(ref)` builds the SQL via `buildSelectSql(ref)` and delegates to `openQuery(seedSql)`; the seeded SQL prefills the panel's `TextArea`. Whether the seeded query auto-runs on open vs. waits for the user to press Run is a small UX choice — the plan's default is **auto-run** (open-as-query implies "show me the rows"), with the run going through the panel's normal run path so errors/status behave identically to a typed query.

### Run trigger and run-state

The panel runs on a **Run** toolbar button (glyph-only, matching `TableWorkPanel`'s button style, [`frontend/src/dock/TableWorkPanel.ts:162`](#)) and on **Ctrl/Cmd+Enter** in the `TextArea`. While a run is in flight the Run button is disabled and the status line reads "Running…"; a monotonic run-sequence guard (mirroring `showProperties`'s `_propsSeq`, [`frontend/src/SqlAdminController.ts:153`](#)) discards a superseded run's result so a slow first run cannot clobber a faster second one. Empty/whitespace-only SQL is a no-op with a "Enter a SQL statement" status message (no round-trip).

---

## Public API

**No library API changes** — verified: `TextArea`, `Table`, `MemoryStore`, `Dock.addPanel`/`addLazyPanel`, `Button`, `ToolBar`, `Split`/`Border`/`Fit` are all already published and already imported by the app.

App-level additions (external workspace, not exported from any library barrel):

```typescript
// frontend/src/contract.ts — new: the query-result wire contract
/** One result column from an arbitrary query (name + inferred wire scalar). */
export interface QueryColumnMeta {
    name:     string;
    wireType: WireType;          // reuses the existing WireType union
}

/** A query that returned a result set (any SELECT / RETURNING). */
export interface QueryRowsResult {
    kind:     "rows";
    columns:  QueryColumnMeta[];
    rows:     Record<string, unknown>[];
    rowCount: number;
}

/** A query that returned no result set (INSERT/UPDATE/DDL). */
export interface QueryStatusResult {
    kind:     "status";
    command:  string;            // asyncpg command tag, e.g. "INSERT 0 3"
    rowCount: number;
}

export type QueryResult = QueryRowsResult | QueryStatusResult;
```

```typescript
// frontend/src/data/api.ts — new typed-fetch entry (one-shot, POST body = { sql })
export function runQuery(connectionId: string, sql: string): Promise<QueryResult>;
```

```typescript
// frontend/src/data/sql.ts — new pure helper: generate a browse query for a table/view
export function buildSelectSql(ref: DbObjectRef, limit?: number): string;
//   -> `SELECT * FROM "schema"."table" LIMIT 50`  (identifiers quoted; default limit 50)
```

```typescript
// frontend/src/SqlAdminController.ts — new methods + private counter
// (NOTE: query panels are NOT added to _openPanels — the OpenPanel interface is unchanged.)
class SqlAdminController {
    private _queryCounter: number;          // backing field, starts at 0
    openQuery(seedSql?: string): void;       // mint `query-${++n}`, addPanel a fresh QueryPanel (optionally seeded)
    openQueryFor(ref: DbObjectRef): void;    // buildSelectSql(ref) -> openQuery(seedSql); the "Open as query" path
}
```

```typescript
// frontend/src/dock/QueryPanel.ts — new callable factory (mirrors TableWorkPanel/StructurePanel)
export function QueryPanel(opts: {
    runQuery:    RunQuery;        // injected; = api.runQuery bound to the connection
    notify:      Notify;          // (message: string) => void — reuse the existing Notify type from TableWorkPanel
    onError:     (err: unknown) => void;   // = controller.notifyError; the panel's error path
    initialSql?: string;          // prefill the TextArea ("Open as query" seeds a generated SELECT)
    autoRun?:    boolean;         // run initialSql immediately on open (true for "Open as query")
}): Panel;
//   RunQuery = (sql: string) => Promise<QueryResult>
```

Backend (Python, external workspace):

```python
# backend/app/operations/run_query.py — new CQRS Command
class RunQueryCommand(Command):
    def __init__(self, conn: asyncpg.Connection, sql: str) -> None: ...
    async def apply(self) -> None: ...      # prepare + fetch in a transaction; store rows, attrs, status tag
    def get_result(self) -> dict: ...       # -> QueryRowsResult | QueryStatusResult dict (pure)
```

```python
# backend/app/main.py — new thin route
@app.post("/api/{connection_id}/query")
async def run_query(connection_id: str, body: dict = Body(...)) -> dict: ...  # body = {"sql": str}
```

```python
# backend/app/wire.py — reused: pg_type_to_wire(...) for column inference; rows_to_wire(...) for values
```

---

## Internal Structure

### `QueryPanel` (frontend) — editor over result, split vertically

```
QueryPanel (Panel, Border layout)
├─ NORTH  : ToolBar  (Run [glyph] — disabled while running)
└─ CENTER : Split (vertical)
            ├─ top    : TextArea            (the raw SQL input; Ctrl/Cmd+Enter runs)
            └─ bottom : Panel(Fit)          host swapped between:
                        ├─ Table(MemoryStore, { columns: [] })   when kind === "rows"
                        └─ (empty until first run / status shown on the StatusBar via notify)
```

- The editor is `new TextArea("", { ... })` ([`TextArea.ts:44`](../../typescript-ui/src/typescript/lib/component/input/TextArea.ts#L44)), prefilled with `opts.initialSql` when given; SQL text read via `editor.getValue()` ([`TextInput.ts:460`](../../typescript-ui/src/typescript/lib/component/input/TextInput.ts#L460)).
- Run handler: read SQL → if blank, `notify("Enter a SQL statement")` and return; else disable Run, `notify("Running…")`, `await runQuery(sql)`; on `kind:"rows"` build a fresh `MemoryStore` from `buildQueryModel(result.columns)` + `result.rows`, replace the result `Table` in the Fit host, and `notify(\`${result.rowCount} rows\`)`; on `kind:"status"` clear the result host and `notify(result.command)`; on throw, call the injected `onError(err)` (= `controller.notifyError`) — re-enable Run in a `finally`.
- **Seeded open:** when `opts.autoRun` is set (the "Open as query" path), the panel invokes the same run handler once after mount, so a generated `SELECT` shows its rows immediately with identical error/status behaviour to a typed run.
- The result `Table` is rebuilt per run (a fresh `MemoryStore` + fresh column set); the previous one is removed from the Fit host so columns never bleed across runs. This mirrors `StructurePanel`'s `Table(store, { columns: [] })` auto-append ([`frontend/src/dock/StructurePanel.ts:34`](#)).

### `buildSelectSql` (frontend `data/sql.ts`, new)

`buildSelectSql(ref, limit = 50)` returns `SELECT * FROM "<schema>"."<name>" LIMIT <limit>`, quoting each identifier with a tiny `quoteIdent(s) = '"' + s.replace(/"/g, '""') + '"'` (the front-end mirror of the backend's `quote_ident`). Pure and trivially unit-testable. It is the only "generate SQL" surface; the backend never round-trips a `DbObjectRef` for this — the SQL is produced client-side and submitted through the normal `runQuery` path.

### `buildQueryModel` (frontend `data/buildModel.ts`, new export)

Same body as `buildModel` ([`frontend/src/data/buildModel.ts:21`](#)) minus the PK (a query result has none): maps each `QueryColumnMeta.wireType` through the existing `WIRE_TO_FIELD` table and assigns `order: i`. No `primaryKey`.

### `RunQueryCommand` (backend) — prepare, fetch, classify

```python
class RunQueryCommand(Command):
    def __init__(self, conn, sql):
        if not sql or not sql.strip():
            raise ValidationError("Empty SQL statement")   # before any I/O
        self._conn, self._sql = conn, sql
        self._records = self._attrs = self._status = None

    async def apply(self):
        async with self._conn.transaction():
            stmt = await self._conn.prepare(self._sql)
            self._attrs = stmt.get_attributes()             # () for non-row statements
            self._records = await stmt.fetch()              # [] for non-row statements
            self._status = stmt.get_statusmsg()             # command tag, e.g. "UPDATE 5"

    def get_result(self):
        if self._attrs is None:
            raise RuntimeError("get_result() called before apply()")
        if self._attrs:                                     # had a row description -> rows result
            columns = _query_columns(self._attrs)           # unique names + pg_type_to_wire per attr
            rows = rows_to_wire([dict(r) for r in self._records], _as_colmeta(columns))
            return {"kind": "rows", "columns": columns,
                    "rows": rows, "rowCount": len(rows)}
        return {"kind": "status", "command": self._status or "",
                "rowCount": _affected(self._status)}        # parse trailing int off the tag
```

- `_query_columns(attrs)` turns each asyncpg `Attribute` into `{name, wireType}` using `pg_type_to_wire` ([`backend/app/wire.py:51`](#)) on **`attr.type.name`** — the pg_catalog *short* type name (e.g. `int4`, `int8`, `bool`, `timestamptz`, `bpchar`), which `pg_type_to_wire` already keys on (not the OID and not an `information_schema` long name) — deduplicating empty/repeated names to `column`, `column_2`, …. `pg_type_to_wire`'s unknown-type fallback to `STRING` keeps the contract well-formed for exotic result types. **Implementer note:** `pg_type_to_wire`'s docstring frames its input as an `information_schema` type name, but its frozensets ([`wire.py:24`](#)–`44`) contain the pg_catalog short aliases too, so feeding `attr.type.name` is correct despite the docstring — pin it with an explicit `int4`→`number` (and one date/bool) assertion in the step-4 test. **Emit the `WireType` *value* (the string), not the bare enum member** — i.e. `pg_type_to_wire(...).value`, matching the existing serialization in `ColumnMeta.to_contract()` ([`backend/app/contract.py:72`](#), `self.wire_type.value`); `WireType` is a `(str, Enum)` so a bare member would still serialize, but `.value` keeps this consistent with the rest of the backend.
- `_affected(status)` parses the trailing integer off the command tag (`"INSERT 0 3"` → 3, `"UPDATE 5"` → 5, `"CREATE TABLE"` → 0).
- `_as_colmeta(columns)` adapts the `{name, wireType}` dicts into the real `ColumnMeta` dataclass instances `rows_to_wire` expects ([`wire.py:213`](#) keys on `c.name`/`c.wire_type`). `ColumnMeta` is a **frozen 7-field dataclass** ([`backend/app/contract.py:49`](#)–`55`), so the adapter must supply every field — `name`, `data_type`, `nullable`, `is_primary_key`, `is_generated`, `default`, `wire_type` — using the query column's name + `WireType` and inert defaults for the introspection-only fields (a query result has no PK/nullability/default metadata). Only `name` and `wire_type` actually affect `rows_to_wire`'s value mapping.
- Registered in [`backend/app/operations/__init__.py`](#) (`RunQueryCommand` added to imports + `__all__`).

### Route (backend `main.py`)

```python
@app.post("/api/{connection_id}/query")
async def run_query(connection_id: str, body: dict = Body(...)) -> dict:
    async with get_pool(connection_id).acquire() as c:
        op = RunQueryCommand(c, body.get("sql", ""))
        await op.apply()
        return op.get_result()
```

Thin, matching the existing route shape ([`backend/app/main.py:242`](#)): acquire → construct (validates) → `apply` → `get_result`. Errors (empty SQL → 422 via `ValidationError`; SQL errors → 400/409 via the existing `asyncpg.PostgresError` handler, [`:75`](#)) need no new wiring.

---

## Ordered Implementation Steps

All steps are in the **external app workspace** (`/home/jika/typescript/sqladmin`); the `@jimka/typescript-ui` library repo is untouched.

**Backend**

1. `backend/app/operations/run_query.py`: add `RunQueryCommand` per *Internal Structure*. Verify: imports cleanly.
2. `backend/app/operations/__init__.py`: import `RunQueryCommand`, add to `__all__`. Verify: `python -c "from app.operations import RunQueryCommand"`.
3. `backend/app/main.py`: add the `POST /api/{connection_id}/query` route. Verify: route appears in the OpenAPI schema.
4. `backend/tests/test_run_query.py`: pure-logic tests for `get_result()` (rows/status classification, dedup of duplicate column names, `_affected` parsing, the temporal-coupling guard), the short-name type mapping (`_query_columns` over a fake `Attribute` with `type.name == "int4"` → `wireType: "number"`, plus one date/bool), and the constructor's empty-SQL `ValidationError`, following the offline `NO_CONN` style of [`backend/tests/test_list_rows.py:13`](#). Verify: `pytest tests/test_run_query.py` green.
5. Integration check (against a disposable Postgres): `curl -XPOST /api/default/query -d '{"sql":"select 1 as a, 1 as b"}'` returns a `kind:"rows"` envelope with disambiguated column names; an `UPDATE` returns `kind:"status"` with the affected count; a syntax error returns `(400, {detail})`; a `;`-separated multi-statement submission returns `(400, {detail})` (`cannot insert multiple commands into a prepared statement`).

**Frontend**

6. `frontend/src/contract.ts`: add `QueryColumnMeta`, `QueryRowsResult`, `QueryStatusResult`, `QueryResult`. Verify: `tsc` clean.
7. `frontend/src/data/api.ts`: add `runQuery(connectionId, sql)` — a **new POST** function (POST `/api/${connectionId}/query`, body `{ sql }`, parse JSON, reuse the existing `readDetail` error helper at [`frontend/src/data/api.ts:8`](#)). Note `getJson` ([`:23`](#)) is GET-only (`fetch(url)` with no method/body), so it cannot be reused — only `readDetail` is. Verify: `tsc` clean.
8. `frontend/src/data/buildModel.ts`: add `buildQueryModel(columns: QueryColumnMeta[]): Model` (no PK). Verify: unit test maps wire types to field types and assigns order.
9. `frontend/src/data/sql.ts`: add the pure `buildSelectSql(ref, limit = 50)` + `quoteIdent` helper. Verify: unit test covers quoting (embedded `"` doubled) and the default `LIMIT`.
10. `frontend/src/dock/QueryPanel.ts`: the callable factory per *Internal Structure* — `TextArea` (prefilled from `initialSql`) + Run toolbar + vertical `Split` + swappable result `Table`; Ctrl/Cmd+Enter run; run-state disable; `autoRun` seeded-run; `onError` wiring. `glyphButton` is **module-private** in `TableWorkPanel.ts` ([`:162`](#)) — copy/re-implement it here (it cannot be imported); reuse the `Notify` type by copying its one-line definition (also module-local). Verify: `tsc` clean.
11. `frontend/src/SqlAdminController.ts`: add `_queryCounter`, `openQuery(seedSql?)` and `openQueryFor(ref)`. `openQuery` mints `query-${++this._queryCounter}` and calls `dock.addPanel({ id, title: \`Query ${n}\`, content: QueryPanel({ runQuery: sql => runQuery(this._connectionId, sql), notify, onError: e => this.notifyError(e), initialSql: seedSql, autoRun: seedSql !== undefined }) })`. **Do NOT add the panel to `_openPanels`** — the `OpenPanel` interface and `syncToPanel`/`disposePanel` are untouched (see *Query panels are NOT registered in `_openPanels`*). `openQueryFor(ref)` = `this.openQuery(buildSelectSql(ref))`. Verify: `tsc` clean; `_openPanels` references unchanged.
12. `frontend/src/navigator/NavigatorTree.ts`: add an "Open as query" item to the existing `contextmenu` handler's item list ([`:38`](#)–`:43`), beside "Open structure", inside the same `kind === "table" | "view"` gate, calling `controller.openQueryFor(ref)`. Verify: `tsc` clean; item appears only for tables/views.
13. `frontend/src/shell/SqlAdminShell.ts`: thread an `onRunSql` callback into `buildMenuBar`, change the `Tools → "Run SQL…"` item from `{ enabled: false }` to `{ action: onRunSql }` ([`:58`](#)), and pass `() => controller.openQuery()` from `SqlAdminShell`. Verify: `tsc` clean.

**Regression**

14. `grep -rn "@jimka/typescript-ui/" frontend/src` — every library import is a published subpath; `component/input` (for `TextArea`) is among them; zero `~/` or `dist/lib/` deep imports.
15. `grep -n "_openPanels" frontend/src/SqlAdminController.ts` — confirm the only writers are still `openTable`/`openStructure` (query panels never register), and `OpenPanel`'s required `ref`/`node`/`columns` fields are unchanged.
16. App typecheck + backend pytest both green.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `/home/jika/typescript/sqladmin/plans/query-panels.md` (this plan) |
| Create | `/home/jika/typescript/sqladmin/backend/app/operations/run_query.py` — `RunQueryCommand` |
| Modify | `/home/jika/typescript/sqladmin/backend/app/operations/__init__.py` — export `RunQueryCommand` |
| Modify | `/home/jika/typescript/sqladmin/backend/app/main.py` — `POST /api/{connection_id}/query` route |
| Create | `/home/jika/typescript/sqladmin/backend/tests/test_run_query.py` — pure-logic tests |
| Modify | `/home/jika/typescript/sqladmin/frontend/src/contract.ts` — `QueryColumnMeta`/`QueryResult` types |
| Modify | `/home/jika/typescript/sqladmin/frontend/src/data/api.ts` — `runQuery` |
| Modify | `/home/jika/typescript/sqladmin/frontend/src/data/buildModel.ts` — `buildQueryModel` |
| Create | `/home/jika/typescript/sqladmin/frontend/src/data/sql.ts` — `buildSelectSql`/`quoteIdent` |
| Create | `/home/jika/typescript/sqladmin/frontend/src/dock/QueryPanel.ts` — the query panel |
| Modify | `/home/jika/typescript/sqladmin/frontend/src/SqlAdminController.ts` — `openQuery`/`openQueryFor` + `_queryCounter` |
| Modify | `/home/jika/typescript/sqladmin/frontend/src/navigator/NavigatorTree.ts` — "Open as query" context-menu item |
| Modify | `/home/jika/typescript/sqladmin/frontend/src/shell/SqlAdminShell.ts` — wire `Tools → Run SQL…` |

**No files under this library repo's `src/typescript/lib/` are created or modified.**

---

## Expected Behaviour

**Backend `RunQueryCommand.get_result()` / helpers — pure, unit-testable offline (no DB):**
- A statement with a row description (`self._attrs` non-empty) → `kind:"rows"` with one `QueryColumnMeta` per attribute, `rowCount === len(rows)`, values wire-mapped (`Decimal`→string, `datetime`→ISO, etc., via `rows_to_wire`).
- An empty result set **with** a row description → `kind:"rows"` with columns and `rows: []` (empty grid, not a status line).
- A statement with no row description → `kind:"status"`, `command` = the tag, `rowCount` = the parsed affected count (`"INSERT 0 3"`→3, `"UPDATE 5"`→5, `"CREATE TABLE"`→0).
- Duplicate/empty result column names are disambiguated to unique names (`SELECT 1, 1` → `column`, `column_2`).
- `get_result()` before `apply()` raises `RuntimeError` (temporal-coupling guard).
- Constructor with empty/whitespace SQL raises `ValidationError` before any I/O.

**Backend integration (verify with `pytest`/`curl` against a test DB):**
- A `SELECT` returns the rows envelope; an `INSERT`/`UPDATE`/`DELETE`/DDL returns the status envelope with the right count.
- A SQL syntax error returns `(400, {detail})`; the run is one statement in one transaction (a failing statement leaves no partial writes).
- A multi-statement (`;`-separated) submission returns `(400, {detail})` carrying the `cannot insert multiple commands into a prepared statement` message — rejected by the extended protocol, no partial execution.

**Frontend `buildQueryModel` — unit-testable offline:**
- Maps each `QueryColumnMeta.wireType` to the matching `FieldType` (reusing `WIRE_TO_FIELD`), assigns `order: i`, sets no primary key.

**Frontend `runQuery` — unit-testable offline (mocked `fetch`):**
- POSTs `{ sql }` to `/api/${connectionId}/query`; on non-OK throws the backend `{detail}` (reusing `readDetail`).

**Frontend `buildSelectSql` — unit-testable offline:**
- Returns `SELECT * FROM "schema"."name" LIMIT 50` for a table ref; embedded `"` in an identifier is doubled (`weird"col` → `"weird""col"`); a custom `limit` argument overrides the default.

**Query panel + dock wiring (needs live verification — DOM events, layout, focus):**
- `Tools → Run SQL…` opens a new, empty Query panel; invoking it again opens a *second* panel (monotonic id, no dedup).
- Typing a `SELECT` and pressing Run (or Ctrl/Cmd+Enter) renders the result rows in the grid with one column per result column, in order; the status line shows the row count.
- Running an `UPDATE`/DDL shows the command tag + affected count on the status line and clears the result grid.
- A second run replaces the grid's columns/rows (no column bleed from the prior run).
- A blank SQL run is a no-op with an "Enter a SQL statement" message (no request).
- A SQL error surfaces its `{detail}` via the controller's `notifyError` on the StatusBar; the Run button re-enables.
- **Open as query:** the navigator right-click menu shows "Open as query" only for a table/view; selecting it opens a query panel prefilled with `SELECT * FROM "schema"."table" LIMIT 50` and (auto-run) immediately renders its rows. Each invocation opens a fresh panel.
- **Focus:** focusing a query panel does **not** change the navigator selection or the Properties inspector (it is absent from `_openPanels`, so `syncToPanel` no-ops) — in contrast to focusing a table/structure panel, which still syncs both.
- **Close:** closing a query panel disposes its component subtree via the Dock; the `MemoryStore` is released by GC. `disposePanel` no-ops (the id was never in `_openPanels`), and `OpenPanel`/`syncToPanel` for table panels are unaffected.

---

## Verification

- **Backend:** `pytest backend/tests/test_run_query.py` (pure-logic, no DB) green; full `pytest` against a disposable Postgres for the integration cases above; `curl` the rows/status/error cases.
- **Frontend:** the app's `tsc`/`npm run typecheck` clean resolving `@jimka/typescript-ui/component/input` for `TextArea`; Vitest covers `buildQueryModel`, `buildSelectSql`, and `runQuery`.
- **Decoupling invariant:** `grep -rn "@jimka/typescript-ui/" frontend/src` — every import is a published subpath; zero `~/`/`dist/lib/` deep imports.
- **Registry invariant:** `grep -n "_openPanels" frontend/src/SqlAdminController.ts` — only `openTable`/`openStructure` write it; `OpenPanel` unchanged.
- **Manual smoke (DOM/async the harness can't exercise):** open via `Tools → Run SQL…`; run a `SELECT` (grid renders, columns in order), an `UPDATE` (status line + count), a syntax error (status-bar detail, Run re-enables), a blank run (no-op), Ctrl/Cmd+Enter, a second run (no column bleed), open two panels, close one; right-click a table → "Open as query" (seeded `SELECT … LIMIT 50`, auto-runs); focus a query panel (navigator selection + Properties unchanged).
- **Library repo:** unaffected — no source change in `/home/jika/typescript/typescript-ui`; the only artefact is this plan, which lives in the app repo (`sqladmin/plans/`).

---

## Documentation Impact

**None on the library.** This plan exposes no new `@jimka/typescript-ui` public symbol — every library component it uses (`TextArea`, `Table`, `MemoryStore`, `Dock`, `ToolBar`, `Button`, `Split`/`Border`/`Fit`) is already published and documented, so no library barrel, API-doc page, catalog, or sidebar entry changes. The new symbols (`QueryResult`/`QueryColumnMeta` in `contract.ts`, `runQuery` in `api.ts`, `buildQueryModel`, `buildSelectSql`, `QueryPanel`, `openQuery`/`openQueryFor`) are **app-internal** to the `sqladmin` workspace — not exported from any library bucket — and are documented in-place by their own doc-comments per the app's conventions. If the `sqladmin` app maintains a user-facing README/feature list, add "Run SQL / Open as query" there; no `typescript-ui` docs are touched.

---

## Critical Files

**Library (read for the composed components — do not modify):**
- [`src/typescript/lib/component/input/TextArea.ts`](../../typescript-ui/src/typescript/lib/component/input/TextArea.ts) — the multi-line SQL input (`new TextArea(text, options)`, [`:44`](../../typescript-ui/src/typescript/lib/component/input/TextArea.ts#L44)); value via `getValue`/`getText` ([`TextInput.ts:460`](../../typescript-ui/src/typescript/lib/component/input/TextInput.ts#L460)); bucket `./component/input` ([`package.json:32`](../../typescript-ui/package.json#L32)).
- [`src/typescript/lib/data/MemoryStore.ts`](../../typescript-ui/src/typescript/lib/data/MemoryStore.ts) — the one-shot result store (`new MemoryStore({ model, data, autoLoad })`, [`:21`](../../typescript-ui/src/typescript/lib/data/MemoryStore.ts#L21)).
- [`src/typescript/lib/overlay/Dock.ts`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts) — `DockPanelSpec` ([`:28`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L28)), `addPanel` ([`:273`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L273)), `addLazyPanel` ([`:316`](../../typescript-ui/src/typescript/lib/overlay/Dock.ts#L316)), `focusPanel`/`removePanel`, the `"close"` event.
- [`src/typescript/lib/component/table/Table.ts`](../../typescript-ui/src/typescript/lib/component/table/Table.ts) — auto-append columns via `Table(store, { columns: [] })`.

**External app (mirror these patterns):**
- `/home/jika/typescript/sqladmin/frontend/src/dock/StructurePanel.ts` — the `MemoryStore` + `Table(store, { columns: [] })` dynamic-grid pattern to copy.
- `/home/jika/typescript/sqladmin/frontend/src/dock/TableWorkPanel.ts` — callable-factory panel shape, `glyphButton` toolbar style, `Notify` type.
- `/home/jika/typescript/sqladmin/frontend/src/SqlAdminController.ts` — `openStructure`/`openTable` (the `dock.addPanel` shape `openQuery` follows), the `OpenPanel` interface + `_openPanels`/`syncToPanel`/`disposePanel` (which query panels deliberately do NOT touch), `_propsSeq` monotonic guard, `notifyError`/`detailOf`.
- `/home/jika/typescript/sqladmin/frontend/src/navigator/NavigatorTree.ts` — the existing right-click context menu the "Open as query" item is added to (gated to `kind === "table" | "view"`).
- `/home/jika/typescript/sqladmin/frontend/src/data/api.ts` — typed-fetch + `{detail}` error idiom for `runQuery`.
- `/home/jika/typescript/sqladmin/frontend/src/data/buildModel.ts` — `WIRE_TO_FIELD` map reused by `buildQueryModel`.
- `/home/jika/typescript/sqladmin/frontend/src/shell/SqlAdminShell.ts` — the `Tools → Run SQL…` seam ([`:58`]).
- `/home/jika/typescript/sqladmin/backend/app/operations/insert_row.py` — the `Command` + transaction shape for `RunQueryCommand`.
- `/home/jika/typescript/sqladmin/backend/app/operations/list_rows.py` — `get_result()` transform + `rows_to_wire` usage.
- `/home/jika/typescript/sqladmin/backend/app/wire.py` — `pg_type_to_wire` (column inference) + `rows_to_wire` (value mapping).
- `/home/jika/typescript/sqladmin/backend/app/main.py` — thin-route shape + the existing `asyncpg.PostgresError` handler.
- `/home/jika/typescript/sqladmin/backend/tests/test_list_rows.py` / `tests/conftest.py` — the offline `NO_CONN` test style.
- [`plans/tsui-sql-admin.md`](./implemented/tsui-sql-admin.md) — the Phase 0/1 architectural bible this plan extends.

---

## Non-Goals

- **SQL syntax highlighting / code editor** — a plain `TextArea` is the deliberate choice; no editor component (matches [`tsui-sql-admin.md:700`](./implemented/tsui-sql-admin.md#L700)).
- **Saved queries / query history / favourites** — each panel is a scratch buffer; no persistence.
- **Parameterized/identifier-validated query SQL** — the SQL is opaque and run verbatim (the feature *is* arbitrary SQL on a trusted single connection); the row-CRUD path's parameterization/identifier validation does not apply here.
- **Editing the result grid** — query results are read-only (no PK, no write-back path); the grid never enters CRUD.
- **Pagination / streaming of large result sets** — the whole result is fetched into a `MemoryStore` in one shot; capping/streaming large results is out of scope (acceptable for a demo, consistent with the Phase 0/1 `count(*) OVER()` stance).
- **Multi-statement scripts** — exactly one statement per run; a `;`-separated multi-statement submission is rejected by the extended query protocol (surfaced as a `(400, {detail})` error). The panel neither splits scripts nor runs them via the simple protocol.
- **Auth / per-statement permission checks** — none in Phase 0–1 ([`tsui-sql-admin.md:707`](./implemented/tsui-sql-admin.md#L707)); arbitrary SQL runs on the trusted `"default"` connection.
- **Library changes** — none; the feature composes already-published components.
