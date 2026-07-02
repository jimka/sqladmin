---
touches-shared:
  - frontend/src/dock/QueryPanel.ts
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/SqlAdminController.ts
  - backend/app/operations/__init__.py
  - backend/app/main.py
---

# Result Export (CSV / JSON) — Implementation Plan

## Overview

Add **export results as CSV or JSON** to tsuiSQLAdmin across **two surfaces**:

1. **Query-result export** — an Export action (CSV / JSON) in the QueryPanel results area, filling the "Export results…" seam the query-workspace plan left in the **Query** menu ([`query-workspace.md:267`](query-workspace.md#L267)). Query rows are already loaded in the grid (and capped by query-workspace's `RESULT_ROW_CAP`), so this is a **client-side** serialize-and-download of the *loaded* rows — no round-trip.
2. **Navigator table export** — right-click a table (or a view) in the navigator → **Export → CSV / JSON**. Table/view data is **paginated** through `AjaxStore`/`AjaxProxy` ([`stores.ts:16`](../frontend/src/data/stores.ts#L16)), so a *full*-table export cannot come from the loaded page. This ships a **backend streaming export endpoint** (`SELECT *` → streamed CSV/JSON, following the CQRS + identifier-validation conventions) so the full relation is exported without loading it into the browser.

Both surfaces share **one pure serialization core** (`frontend/src/data/serialize.ts`) that turns `(columns, rows)` of **wire scalars** into a CSV or JSON string. The frontend rows arriving from `runQuery` ([`api.ts:86`](../frontend/src/data/api.ts#L86)) and from the row endpoints are already **contract `WireType` scalars** (the backend's `to_wire_value` maps every native asyncpg value before it leaves — [`wire.py:114`](../backend/app/wire.py#L114)), so the serializer operates directly on those scalars and never re-formats through the grid's cell renderers. The backend export reuses the *same* dialect rules in Python so a full-table CSV is byte-compatible with a query-result CSV of the same data.

Everything lives in the standalone app workspace `/home/jika/typescript/sqladmin` (`frontend/src/`, `backend/app/`). It composes already-published `@jimka/typescript-ui` pieces — **no library source change**.

The serialization core (TS) and the backend export SQL/serializer (Python) are **pure** and unit-tested hard (node-only vitest — [`vitest.config.ts:9`](../frontend/vitest.config.ts#L9); pytest); the download trigger, the QueryPanel toolbar/menu action, and the navigator context-menu are **manual-verify** (DOM/anchor/right-click).

---

## Architecture Decisions

### One shared serialization core, hand-rolled — not the library's `TableExporter`

The library already exposes `Table.exportCSV`/`exportJSON` and a `TableExporter` ([`component/table/TableExporter.ts`](../../typescript-ui/src/typescript/lib/component/table/TableExporter.ts), re-exported from the `component/table` barrel — [`index.ts:11`](../../typescript-ui/src/typescript/lib/component/table/index.ts#L11)). It is **deliberately not reused** as the export core, for four reasons that a wire-typed SQL export cannot compromise on:

1. **It formats through cell renderers, not wire scalars.** `TableExporter.formatValue` runs `Date` values through `toLocaleDateString()`/`toLocaleTimeString()`/`toLocaleString()` ([`TableExporter.ts:97`](../../typescript-ui/src/typescript/lib/component/table/TableExporter.ts#L97)) — *locale-dependent* strings. A database export must be **stable and lossless** (ISO-8601 timestamps, precision-preserving numerics), not "what the cell happens to render in this browser's locale".
2. **It has no NULL discipline.** `escapeCSVField(value ?? '')` ([`TableExporter.ts:127`](../../typescript-ui/src/typescript/lib/component/table/TableExporter.ts#L127)) collapses `null` and `undefined` to the **empty string** — indistinguishable from an empty-string cell. A SQL export must round-trip NULL distinctly (see *CSV dialect*).
3. **It is `Table`/`Column`/`ModelRecord`-bound.** `exportCSV`/`exportJSON` read `this._store.getRecords()` ([`Table.ts:724`](../../typescript-ui/src/typescript/lib/component/table/Table.ts#L724)); the navigator full-table export has **no `Table` and no loaded store** — it streams from the backend. A `Table`-bound helper cannot serve surface 2 at all, so a shared core cannot live there.
4. **Its CSV newline is `\n`-only inside fields but `\r\n` between rows**; its quoting triggers on `,`/`"`/`\n` but not `\r` — adequate for its use, but this plan owns a documented dialect it must control end-to-end and mirror in Python.

So the app owns a small **pure** `serialize.ts` used by *both* frontend surfaces, and the backend owns a matching Python serializer. This is the "reusable mechanics in one place" exception to "no abstraction for single-use code" — the same serializer feeds the QueryPanel action and (in spirit) the streaming endpoint's format. The `MemoryStore`/`Table` the QueryPanel already builds is **untouched** for export — the serializer reads the `QueryResult.rows` the panel already holds, not the store, so no `ModelRecord` round-trip and no locale drift.

### The frontend serializer operates on wire scalars, keyed by column `wireType`

`serialize.ts` takes `(columns: ExportColumn[], rows: Record<string, unknown>[])` where `ExportColumn = { name: string; wireType: WireType }` — exactly the shape `QueryColumnMeta` ([`contract.ts:46`](../frontend/src/contract.ts#L46)) and a projection of `ColumnMeta` already provide. Each value is rendered by a **pure per-wire-type function** so the rendering is total and testable:

| `WireType` | CSV / JSON rendering of a non-null value |
|---|---|
| `number` | the number's JS string form (`String(v)`); JSON: the number itself |
| `string` | the string verbatim (numerics arrive here as precision-preserving strings — [`wire.py:28`](../backend/app/wire.py#L28)) |
| `boolean` | `"true"` / `"false"`; JSON: the boolean |
| `isoString` | the ISO-8601 string verbatim (already ISO from the backend — no locale) |
| `json` | `JSON.stringify(v)` (a nested object/array/scalar) in CSV; JSON: the value itself |
| `base64` | the base64 string verbatim (bytea) |
| `jsonArray` | `JSON.stringify(v)` in CSV; JSON: the array itself |

**NULL** is rendered distinctly (see next). The value is read straight from the row object by column name; a column absent from a row object is treated as NULL. Booleans/numbers/json/arrays keep their native JS type in the JSON output and become strings only in CSV.

### CSV dialect — RFC 4180, comma, CRLF, header row, explicit NULL

The CSV dialect is fixed and documented (the implementer must not deviate — the Python side mirrors it byte-for-byte):

- **Delimiter:** comma (`,`).
- **Record separator:** `\r\n` (RFC 4180).
- **Header row:** always emitted — the column names, each escaped by the same field rule.
- **Quoting:** a field is wrapped in double quotes **iff** it contains a comma, a double quote, a CR, or an LF; an embedded `"` is doubled (`"` → `""`). Fields without those characters are emitted bare. (This is stricter than the library's helper — it also triggers on `\r`.)
- **NULL vs empty string:** a SQL `NULL` is rendered as an **empty *unquoted*** field; an empty **string** value is rendered as a **quoted empty field** (`""`). This is the one dialect choice that keeps NULL distinguishable from `''` in CSV, matching how `psql \copy ... CSV` and most SQL tools disambiguate. (Documented as a dialect decision because a naive `value ?? ''` — what the library helper does — loses it.) A `notify`/tooltip near the export action states "NULL exports as an empty field; empty text as `\"\"`" so the convention is discoverable.
- **Booleans:** `true` / `false` (lowercase, SQL-style).
- **Numerics:** exactly the wire string — `number` via `String(v)`, `numeric`/`decimal`/`money` (which arrive as precision-preserving strings) verbatim, so no float rounding is introduced.
- **Timestamps / dates / times:** the ISO-8601 wire string verbatim.
- **bytea:** the base64 wire string verbatim.
- **json / jsonb / arrays:** the compact `JSON.stringify` of the value, then CSV-escaped (so it is a single quoted field containing the JSON text).

### JSON shape — a top-level array of row objects

The JSON export is a **top-level array of row objects**: `[{ "col1": value, "col2": value, … }, …]`, one object per row, keys in column order, values in their **native JSON type** (numbers as numbers, booleans as booleans, `json`/`jsonArray` as their parsed structures, NULL as JSON `null`, `isoString`/`string`/`base64` as strings). Pretty-printed with 2-space indentation (matching the library helper's `JSON.stringify(data, null, 2)` — [`TableExporter.ts:84`](../../typescript-ui/src/typescript/lib/component/table/TableExporter.ts#L84)) for human-readability, since these are downloads a user opens. An **empty result** exports `[]` (JSON) and a **header-only** CSV (the column row, no data rows) — never an empty file, so the columns are still recoverable.

### The download trigger — an app-local `download()` helper (Blob + anchor)

The app has **no** existing download helper (confirmed: `grep -rn "createObjectURL\|Blob\|download" frontend/src` → none) and cannot import the library's `TableExporter.download` (it is `private` — [`TableExporter.ts:144`](../../typescript-ui/src/typescript/lib/component/table/TableExporter.ts#L144)). So the app adds a tiny `download(content, filename, mimeType)` in `frontend/src/data/download.ts` using the standard `Blob` + object-URL + temporary `<a download>` pattern (create anchor, set `href`/`download`, click, remove, `revokeObjectURL`). This is **manual-verify** (DOM anchor; node vitest cannot exercise it) and is kept in its own module so `serialize.ts` stays pure and node-testable (the serializer returns a string; the caller downloads it).

For the **backend streaming** surface, the download is triggered differently and needs no `Blob`: the export endpoint sets `Content-Disposition: attachment; filename=…`, so **navigating the browser to the URL** (an `<a href>` the context-menu opens, or `window.location.assign(url)`) makes the browser download the streamed body directly — no in-memory buffering of the whole table. So the two surfaces use two download mechanisms: client Blob for the loaded query rows, a direct attachment URL for the streamed full table.

### Query-result export exports the *loaded* (capped) rows — a "full re-run" is a Non-Goal

The QueryPanel already caps its loaded rows at `RESULT_ROW_CAP` (query-workspace, default 1000, to dodge the large-`MemoryStore` render bug — [`query-workspace.md:78`](query-workspace.md#L78)). Query-result export serializes **exactly the rows the panel holds** — i.e. the capped set. When the last result was truncated, the export action's `notify` states the export covers only the shown rows ("exported first N of M rows — result was truncated; re-run without a LIMIT or use the table's Export for the full data"). A **"full" query export** (silently re-running the SQL without the cap) is **not** built: re-executing arbitrary user SQL a second time can have side effects (a `RETURNING` DML, a `SELECT` with a volatile function) and can be arbitrarily large — exporting what the user sees is the honest, side-effect-free behaviour. For a genuinely large export the user browses the table and uses the **navigator table export** (surface 2), which streams the whole relation server-side. This split is the deliberate reason surface 2 is a backend endpoint rather than a bigger client cap.

### Navigator table export is a backend streaming endpoint — not the loaded page, not a client bulk-load

A navigator "Export → CSV/JSON" on a table/view must export the **full** relation. Three options were weighed:

1. **Export the current page** — rejected: it exports ≤ `PAGE_SIZE` (100) rows, which is not a table export at all; a user would silently get a truncated file.
2. **Client bulk-load then serialize** — rejected: it would load the entire relation into the browser (`MemoryStore`), hitting the exact large-`loadData` zero-render / unbounded-memory bug the app already routes around (`LIBRARY_NOTES.md`), and duplicating a `SELECT *` the backend can stream.
3. **Backend streaming export endpoint** — **chosen.** A new CQRS `Query` streams `SELECT *` from the (validated) relation and formats it row-by-row into CSV or JSON, returned as a `StreamingResponse` with an `attachment` `Content-Disposition`. The full relation is exported without ever materializing it in the browser or in one server buffer.

The endpoint follows the app's conventions exactly: identifiers (schema/table) are **validated against the introspected column set / quoted with `quote_ident`** — never interpolated raw — and the same `to_wire_value` mapping ([`wire.py:114`](../backend/app/wire.py#L114)) renders every native value into the wire scalar the serializer expects, so a bytea streams as base64, a timestamp as ISO, a numeric as its precision string, identically to the row endpoint. Because it is a read that must not hold a transaction open across a long stream unnecessarily, it uses asyncpg's **server-side cursor** (`connection.cursor()` inside a transaction) to fetch in batches rather than `fetch()`-ing the whole relation into memory.

### The backend export operation streams; `get_result` cannot be the pure sink

The CQRS contract's `apply()`/`get_result()` split ([`base.py`](../backend/app/operations/base.py)) assumes `apply()` buffers a raw result and `get_result()` purely transforms it. A streaming export **breaks that assumption on purpose** — buffering the whole relation defeats streaming. So the export operation exposes a third shape instead of `apply()`+`get_result()`: an **`async def stream(self) -> AsyncIterator[str]`** that opens the server-side cursor and yields formatted chunks (header first, then one formatted record per iteration, batched). Its **format functions are the pure, unit-testable core** (a `serialize_row`/`serialize_header` pair mirroring the TS dialect); only the cursor iteration is I/O. The constructor still validates identifiers before any I/O, preserving the "validate in `__init__`" half of the contract. This deviation is called out here (per the plan skill's "flag architecture-doc departures") — it is confined to export, and the pure formatters keep the testability the CQRS split exists for.

### Reuse the existing introspection to validate the relation before streaming

The export endpoint reuses `_columns_for(conn, TableRef(...))` ([`main.py:115`](../backend/app/main.py#L115)) — the same introspection gate the row routes use — to (a) confirm the relation exists (its `NotFound` maps to 404 via the existing handler) and (b) obtain the `ColumnMeta[]` that both drive the `to_wire` mapping and provide the header/column order. This means a view exports identically to a table (a view has columns and is a selectable relation), so surface 2 covers **tables and views** with no per-kind branching, consistent with schema-views.md treating views as selectable relations.

### The two menu/context surfaces defer to their owners' structure

Per the ownership split, this plan **adds only the export leaves** and defers the surrounding structure:
- **Query menu:** query-workspace owns the Query menu and left a documented "Export results…" seam comment ([`query-workspace.md:267`](query-workspace.md#L267)). This plan fills that seam with an **Export submenu** (CSV / JSON) that acts on the **active** QueryPanel. Because the menu is app-global while the loaded rows live in a specific panel, the export needs the *active* panel's rows — see *Wiring the Query-menu export to the active panel*.
- **Navigator context menu:** schema-views/structure-detail own `NavigatorTree`'s object grouping and the existing context menu ([`NavigatorTree.ts:45`](../frontend/src/navigator/NavigatorTree.ts#L45), which today offers "Open structure" / "Open as query"). This plan **appends** an "Export" submenu (CSV / JSON) to that existing menu for `table`/`view` refs, matching the existing kind gate.

### Wiring the Query-menu export to the active panel — a QueryPanel toolbar action is the primary surface, the menu is a convenience

The loaded rows live inside a QueryPanel closure; the app-global Query menu has no direct handle to them. Two placements:

- **Primary — a QueryPanel results-area toolbar action.** The panel already has a NORTH `ToolBar` (Run / Clear — [`QueryPanel.ts:84`](../frontend/src/dock/QueryPanel.ts#L84)). Add an **Export** glyph button (a `download`/`file-export` glyph) to that toolbar, **enabled only when a rows result is shown** (disabled for an empty panel or a status-only result). Clicking it opens a tiny menu (CSV / JSON) — or two buttons — and serializes the panel's own held `QueryResult`. This is the natural, always-correct surface: the action is *in* the results area, acting on *that* panel's data. It is the direct analogue of query-workspace's panel-scoped "Save query…" button decision ([`query-workspace.md:44`](query-workspace.md#L44)).
- **Convenience — the Query-menu "Export results…" item** routes to the **active** panel. The controller tracks the active QueryPanel via the Dock `"focus"` event (it already subscribes — [`SqlAdminController.ts:70`](../frontend/src/SqlAdminController.ts#L70)); the menu item calls `controller.exportActiveQuery(format)`, which serializes the focused panel's last result, or `notify`s "No query result to export" when the active panel has none. This keeps the menu item honest without the menu reaching into panel internals.

The panel exposes its current result to the controller through an injected callback rather than the controller reading panel state: the QueryPanel calls an injected `onResult(result: QueryResult | null)` whenever `showResult`/`clear` changes what is displayed, and the controller stores the latest per active-panel id. This mirrors the existing injected-closure pattern (`notify`/`runQuery`/`onError`) and keeps the panel a pure view (the controller holds no back-reference to the panel object).

### No new library API

Every piece composes published components: the QueryPanel `ToolBar`/`Button`/`Glyph` ([`component/menubar`](../../typescript-ui/src/typescript/lib/component/menubar/index.ts), [`component/button`](../../typescript-ui/src/typescript/lib/component/button/index.ts)), the navigator `Menu` ([`overlay`](../../typescript-ui/src/typescript/lib/overlay/index.ts)), and the `MenuBar` submenu the Query menu already uses. The serializer, the download helper, and the backend endpoint are all app code. The library's `TableExporter` is *not* imported (see first decision).

---

## Public API

App-level additions (external workspace; nothing exported from a library barrel).

```typescript
// frontend/src/data/serialize.ts — new module (pure, DOM-free, node-testable)

import type { WireType } from "../contract";

/** A column to export: its name and the wire scalar its values arrive as. */
export interface ExportColumn {
    name:     string;
    wireType: WireType;
}

/** Serialize rows of wire scalars to an RFC-4180 CSV string (header + data). */
export function toCSV(columns: ExportColumn[], rows: Record<string, unknown>[]): string;

/** Serialize rows of wire scalars to a pretty-printed JSON array of objects. */
export function toJSON(columns: ExportColumn[], rows: Record<string, unknown>[]): string;
```

```typescript
// frontend/src/data/download.ts — new module (DOM; manual-verify)

/** Trigger a browser download of `content` as `filename` via a Blob + anchor. */
export function download(content: string, filename: string, mimeType: string): void;
```

```typescript
// frontend/src/dock/QueryPanel.ts — QueryPanelOptions gains one callback
export interface QueryPanelOptions {
    // …existing: runQuery, notify, onError, initialSql, autoRun,
    //            (query-workspace: getHistory, onSave, rowCap)…
    /** Called whenever the displayed result changes (rows result, or null on clear/status). */
    onResult?: (result: QueryRowsResult | null) => void;
}
// Internally the panel adds an Export toolbar button (CSV/JSON) over its held result,
// enabled only when a rows result is shown; it serializes via serialize.ts + download.ts.
```

```typescript
// frontend/src/SqlAdminController.ts — new members
class SqlAdminController {
    // Tracks the focused QueryPanel's latest rows result (set via the panel's onResult).
    private _activeQueryResult: Map<string, QueryRowsResult | null>;
    private _activePanelId: string | null;
    /** Export the active QueryPanel's loaded result; notifies if there is none. */
    exportActiveQuery(format: "csv" | "json"): void;
    /** Open the backend streaming export for a table/view (attachment download). */
    exportTable(ref: DbObjectRef, format: "csv" | "json"): void;
}
```

```typescript
// frontend/src/data/api.ts — new: build the streaming-export URL (no fetch; the
// browser navigates to it so the attachment downloads without buffering).
export function tableExportUrl(ref: DbObjectRef, format: "csv" | "json"): string;
```

```python
# backend/app/operations/export_rows.py — new streaming export operation
class ExportRowsQuery(Query):
    """Stream a relation's full contents as CSV or JSON (server-side cursor)."""
    def __init__(self, conn, table: TableRef, fmt: str, columns: list[ColumnMeta]) -> None: ...
    async def stream(self) -> AsyncIterator[str]:   # header first, then batched rows
        ...
    # get_result() is NOT used (streaming); the pure formatters below are the core:

# backend/app/export_format.py — new pure serializers (mirror the TS dialect)
def csv_header(columns: list[ColumnMeta]) -> str: ...
def csv_row(row: dict, columns: list[ColumnMeta]) -> str: ...     # one CRLF-terminated line
def json_open() -> str: ...                                        # "["
def json_row(row: dict, columns: list[ColumnMeta], first: bool) -> str: ...  # optional ",\n" + object
def json_close() -> str: ...                                       # "]"
```

```python
# backend/app/main.py — new route
# GET /api/{connection_id}/{database}/{schema}/{table}/export?format=csv|json
#   -> StreamingResponse, Content-Disposition: attachment; filename="<schema>.<table>.<ext>"
```

---

## Internal Structure

### `serialize.ts` — the pure dialect (frontend)

```typescript
const CSV_DELIM = ",";
const CSV_EOL   = "\r\n";

// Render one wire value to its CSV field text. NULL -> "" (bare, so a later
// caller emits it unquoted); everything else -> a string the field-escaper wraps.
function csvCell(value: unknown, wireType: WireType): { text: string; isNull: boolean } {
    if (value === null || value === undefined) return { text: "", isNull: true };
    switch (wireType) {
        case "boolean":   return { text: value ? "true" : "false", isNull: false };
        case "json":
        case "jsonArray": return { text: JSON.stringify(value), isNull: false };
        default:          return { text: String(value), isNull: false }; // number/string/isoString/base64
    }
}

// RFC-4180 field escape: quote iff it contains , " CR or LF; double embedded ".
// A NULL emits a BARE empty field; an empty string emits a QUOTED "" so the two
// stay distinguishable.
function escapeField(text: string, isNull: boolean): string {
    if (isNull) return "";
    if (text === "" || /[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}
```

`toJSON` builds `rows.map(r => Object.fromEntries(columns.map(c => [c.name, jsonCell(r[c.name], c.wireType)])))` where `jsonCell` returns the native value for `number`/`boolean`/`json`/`jsonArray`, `null` for NULL, and the string otherwise; then `JSON.stringify(data, null, 2)`.

### QueryPanel export button (extends the existing toolbar + result plumbing)

The panel keeps a `let currentResult: QueryRowsResult | null = null`. `showResult` sets it (and calls `onResult?.(result)`) on a `"rows"` result; `hideResultPane`/`clear`/a `"status"` result set it to `null` (and `onResult?.(null)`). An **Export** glyph button is added to the NORTH `ToolBar`, enabled from a `syncExportEnabled()` (`currentResult !== null`) called wherever `syncClearEnabled` is. Clicking it shows a two-item menu (or the button is split into CSV/JSON) that calls `exportResult("csv" | "json")`, which builds `ExportColumn[]` from `currentResult.columns` (already `{name, wireType}`), serializes, and `download`s with a filename `query-result.csv`/`.json`. When the last result was truncated (query-workspace's cap), `notify` states the export covers the shown rows only.

### Controller: active-panel tracking + the two export entry points

`openQuery` injects `onResult: r => this._setActiveQueryResult(id, r)`. The Dock `"focus"` handler ([`SqlAdminController.ts:70`](../frontend/src/SqlAdminController.ts#L70)) records `_activePanelId = e.id` (for any panel; query panels included). `exportActiveQuery(format)` reads `_activeQueryResult.get(_activePanelId)`; if null → `notify("No query result to export")`, else serialize + download. On the Dock `"close"` event it already handles ([`SqlAdminController.ts:66`](../frontend/src/SqlAdminController.ts#L66)), also `_activeQueryResult.delete(id)` so a closed panel's result is dropped. `exportTable(ref, format)` calls `download`-free: it navigates to `tableExportUrl(ref, format)` (`window.location.assign` or opening a hidden `<a>`), letting the attachment response drive the download.

### Backend `export_format.py` — the pure Python dialect (mirrors `serialize.ts`)

```python
_DELIM = ","
_EOL   = "\r\n"

def _csv_field(value, wire_type) -> str:
    if value is None:
        return ""                                   # NULL -> bare empty field
    if wire_type is WireType.BOOLEAN:
        text = "true" if value else "false"
    elif wire_type in (WireType.JSON, WireType.JSON_ARRAY):
        text = json.dumps(value, separators=(",", ":"))
    else:
        text = str(value)                           # number/string/isoString/base64
    if text == "" or any(ch in text for ch in ('"', ",", "\r", "\n")):
        return '"' + text.replace('"', '""') + '"'  # empty string -> quoted ""
    return text

def csv_header(columns): return _DELIM.join(_csv_field(c.name, WireType.STRING) for c in columns) + _EOL
def csv_row(row, columns): return _DELIM.join(_csv_field(row.get(c.name), c.wire_type) for c in columns) + _EOL
```

The values fed to `_csv_field` are already wire scalars — the operation runs each raw asyncpg row through `to_wire_value`/`rows_to_wire` ([`wire.py:114`](../backend/app/wire.py#L114)) before formatting, exactly as `ListRowsQuery.get_result` does ([`list_rows.py:99`](../backend/app/operations/list_rows.py#L99)), so a `numeric` is its precision string, a `timestamptz` is ISO, a `bytea` is base64 — identical to the frontend dialect. JSON uses `json.dumps(value)` for the whole `{col: wire_value}` object per row, streamed as `[` then comma-joined objects then `]`.

### Backend `ExportRowsQuery.stream` — server-side cursor

```python
async def stream(self):
    if self._fmt == "csv":
        yield csv_header(self._columns)
    else:
        yield "["
    first = True
    async with self._conn.transaction():
        cur = self._conn.cursor(f"SELECT * FROM {qualified(self._table)}")
        async for record in cur:
            row = to_wire_value_row(dict(record), self._columns)   # wire-map one row
            if self._fmt == "csv":
                yield csv_row(row, self._columns)
            else:
                yield ("" if first else ",\n") + json.dumps(row_object(row, self._columns))
                first = False
    if self._fmt == "json":
        yield "]"
```

`qualified(self._table)` reuses the existing `quote_ident`-based helper ([`common.py:12`](../backend/app/operations/common.py#L12)); the constructor validates `fmt in {"csv","json"}` (`ValidationError` → 422) and takes the already-introspected `columns` (so the relation is confirmed to exist before streaming). No user value is interpolated — the SQL is `SELECT *` over a validated, quoted relation with no WHERE (full export).

### Backend route

```python
@app.get("/api/{connection_id}/{database}/{schema}/{table}/export")
async def export_rows(connection_id, database, schema, table, format: str = "csv"):
    ref = TableRef(database, schema, table)
    pool = get_pool(connection_id)
    conn = await pool.acquire()                      # released when the stream is exhausted
    cols = await _columns_for(conn, ref)             # 404 if the relation is absent
    op = ExportRowsQuery(conn, ref, format, cols)    # validates format
    media, ext = ("text/csv", "csv") if format == "csv" else ("application/json", "json")
    async def body():
        try:
            async for chunk in op.stream():
                yield chunk
        finally:
            await pool.release(conn)
    return StreamingResponse(body(), media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{schema}.{table}.{ext}"'})
```

The connection is acquired for the streaming lifetime (a cursor needs its connection alive across the stream) and released in the generator's `finally`. This is the one place a connection outlives the `async with acquire()` sugar — noted in *Potential Challenges*.

---

## Ordered Implementation Steps

### Frontend

1. **`frontend/src/data/serialize.ts`** (new): `ExportColumn`, `toCSV`, `toJSON` per *Public API* + *Internal Structure*. Pure, no DOM. Verify: `tsc` clean.
2. **`frontend/src/data/serialize.test.ts`** (new): the whole dialect (see *Expected Behaviour* — quoting, embedded delimiter/quote/CR/LF, NULL vs empty string, number/boolean/isoString/base64/json/jsonArray rendering, header row, empty result, header-only). Red-green. Verify: `vitest run serialize` green.
3. **`frontend/src/data/download.ts`** (new): the Blob + anchor `download`. Verify: `tsc` clean (behaviour is manual-verify).
4. **`frontend/src/data/api.ts`**: add `tableExportUrl(ref, format)` returning `/api/{conn}/{db}/{schema}/{name}/export?format=…`. Verify: `tsc` clean; add a URL-shape unit test to `api.test.ts`.
5. **`frontend/src/dock/QueryPanel.ts`**: track `currentResult`; add the `onResult` option; add the Export toolbar button (CSV/JSON), enabled only on a rows result; wire `exportResult` via `serialize.ts` + `download.ts`; on a truncated result, `notify` the shown-rows caveat. Register the export glyph. Verify: `tsc` clean; existing Run/Clear/Ctrl+Enter unchanged.
6. **`frontend/src/SqlAdminController.ts`**: add `_activeQueryResult`/`_activePanelId`; set active id in the `"focus"` handler and drop the result in the `"close"` handler; inject `onResult` into `QueryPanel({...})` ([`SqlAdminController.ts:182`](../frontend/src/SqlAdminController.ts#L182)); add `exportActiveQuery(format)` and `exportTable(ref, format)`. Verify: `tsc` clean.
7. **`frontend/src/navigator/NavigatorTree.ts`**: append an **Export → CSV / JSON** submenu to the existing table/view context menu ([`NavigatorTree.ts:49`](../frontend/src/navigator/NavigatorTree.ts#L49)), each item calling `controller.exportTable(ref, "csv"|"json")`. Keep the existing kind gate (`table`/`view`). Verify: `tsc` clean. *(Defer to schema-views/structure-detail for the surrounding menu structure — append only.)*
8. **Query menu seam:** fill query-workspace's "Export results…" comment ([`query-workspace.md:267`](query-workspace.md#L267)) with an **Export results ▸ CSV / JSON** submenu whose items call `controller.exportActiveQuery("csv"|"json")`. This edits whatever file query-workspace put the Query menu in (`SqlAdminShell.ts` `buildMenuBar`); **coordinate ordering with query-workspace** — this plan only adds the two leaf items at the seam, not the menu. Verify: `tsc` clean.

### Backend

9. **`backend/app/export_format.py`** (new): `csv_header`, `csv_row`, `json` row/object formatters — the pure Python dialect mirroring `serialize.ts`. Verify: importable, no DB.
10. **`backend/tests/test_export_format.py`** (new): the same dialect cases as the TS test, in Python (quoting, NULL vs empty, each wire type, header). Red-green. Verify: `pytest tests/test_export_format.py` green.
11. **`backend/app/operations/export_rows.py`** (new): `ExportRowsQuery` with the `__init__` validation (format + columns), the `stream()` server-side cursor, using `export_format` + `to_wire`. Export from `operations/__init__.py` (`__all__` + import).
12. **`backend/app/main.py`**: add the `GET …/{table}/export` route (acquire → `_columns_for` (404 gate) → `ExportRowsQuery` → `StreamingResponse` with the `attachment` header), releasing the connection in the generator `finally`. Import the op.
13. **`backend/tests/test_export_rows.py`** (new): construct-time `ValidationError` on a bad `format`; the constructor validates before I/O (no DB needed for that path). The cursor streaming is integration/live-verify (needs a real relation).

### Regression

14. `grep -rn "TableExporter" frontend/src` — **zero** (the app owns its serializer, does not import the library's). `grep -rn "@jimka/typescript-ui/" frontend/src` — every import a published subpath. `grep -rn '"export"' frontend/src/navigator/NavigatorTree.ts` — the export items are present. App `tsc` + `vitest run` green; backend `pytest` green.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/data/serialize.ts` — pure CSV/JSON serializer (the shared core) |
| Create | `frontend/src/data/serialize.test.ts` — dialect tests |
| Create | `frontend/src/data/download.ts` — Blob + anchor download trigger |
| Create | `backend/app/export_format.py` — pure Python CSV/JSON formatters (mirror the TS dialect) |
| Create | `backend/tests/test_export_format.py` — Python dialect tests |
| Create | `backend/app/operations/export_rows.py` — `ExportRowsQuery` streaming export |
| Create | `backend/tests/test_export_rows.py` — construct-time validation test |
| Modify | `frontend/src/data/api.ts` — `tableExportUrl` |
| Modify | `frontend/src/data/api.test.ts` — `tableExportUrl` URL-shape test |
| Modify | `frontend/src/dock/QueryPanel.ts` — Export toolbar button + `onResult` (**touches-shared**) |
| Modify | `frontend/src/SqlAdminController.ts` — active-result tracking + `exportActiveQuery`/`exportTable` (**touches-shared**) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` — Export submenu on the context menu (**touches-shared**) |
| Modify | `frontend/src/shell/SqlAdminShell.ts` — Query-menu "Export results…" leaf items (query-workspace's seam) |
| Modify | `backend/app/operations/__init__.py` — export `ExportRowsQuery` (**touches-shared**) |
| Modify | `backend/app/main.py` — `/export` route |

**No `@jimka/typescript-ui` source is created or modified.**

---

## Expected Behaviour

### `serialize.toCSV` — unit-testable offline (pure)
- **Header row always first**, comma-joined, each column name field-escaped; rows follow separated by `\r\n`.
- A field containing a **comma**, a **double quote**, a **CR**, or an **LF** is wrapped in quotes; an embedded `"` is doubled. A field with none of those is emitted bare.
- **NULL** (missing key, `null`, or `undefined`) renders as a **bare empty** field (no quotes); an **empty string** renders as a **quoted `""`** — the two are distinguishable in the output.
- `boolean` → `true`/`false`; `number` → `String(v)`; `string`/`isoString`/`base64` → the value verbatim; `json`/`jsonArray` → compact `JSON.stringify`, then field-escaped (a single quoted field).
- A **numeric-as-string** value (precision string) is emitted verbatim — no float rounding.
- An **embedded newline inside a text value** stays inside one quoted field (does not split the record).
- **Empty result** (`rows: []`) → the header row only (columns still recoverable), no trailing data record.

### `serialize.toJSON` — unit-testable offline (pure)
- Top-level **array of objects**, one per row, keys in column order.
- `number`/`boolean` stay native JSON number/bool; `json`/`jsonArray` stay their parsed structure; NULL → JSON `null`; `string`/`isoString`/`base64` are strings.
- **Empty result** → `[]`.
- Pretty-printed (2-space) — a whitespace assertion is acceptable but the parse-round-trip (parse the output, deep-equal the expected value array) is the load-bearing check.

### Backend `export_format` — unit-testable offline (pure, Python)
- The same CSV/JSON cases as above, asserted in `pytest` against `csv_header`/`csv_row`/`json_row` — so a full-table CSV is byte-identical to a query CSV of the same wire data (NULL vs empty, quoting, each wire type, header).

### Backend `ExportRowsQuery` — construct-time unit-testable; streaming live-verify
- A `format` not in `{"csv","json"}` raises `ValidationError` in `__init__` (→ 422) before any I/O — unit-testable with no DB.
- Streaming (needs a real relation, **live-verify**): `GET …/{table}/export?format=csv` streams `<header>\r\n<row>\r\n…` with `Content-Disposition: attachment`; `format=json` streams a valid JSON array; a non-existent relation → 404 (the `_columns_for` gate); a **view** exports its full contents identically to a table.

### Frontend surfaces (manual-verify — DOM, anchor download, right-click, focus)
- **QueryPanel Export button** is disabled for an empty panel and for a status-only result; enabled once a rows result shows. Clicking CSV/JSON downloads a file of the loaded rows in the dialect above; a truncated result downloads the shown rows and `notify`s the caveat.
- **Query menu → Export results ▸ CSV/JSON** exports the **active** QueryPanel's result; with no active result it `notify`s "No query result to export".
- **Navigator right-click a table/view → Export ▸ CSV/JSON** triggers an **attachment download of the full relation** (streamed) — a large table exports without freezing the browser or blanking a grid.
- Filenames: `query-result.csv/.json` for the panel export; `<schema>.<table>.csv/.json` for the table export.

---

## Verification

- **Offline (`vitest run`):** `serialize` (CSV + JSON, every *unit-testable* Expected Behaviour) and the `api.test.ts` `tableExportUrl` case green.
- **Offline (`pytest`):** `test_export_format` (the Python dialect mirror) and `test_export_rows` (construct-time `ValidationError`) green; full `pytest` for regressions.
- **Typecheck:** app `tsc`/`npm run typecheck` clean; no `@jimka/typescript-ui/component/table` `TableExporter` import.
- **Grep invariants:** `grep -rn "TableExporter" frontend/src` → zero; `grep -rn "@jimka/typescript-ui/" frontend/src` → every import a published subpath; `grep -rn "StreamingResponse" backend/app/main.py` → present.
- **Manual smoke (browser at `:5173` + backend `:8000`, a Postgres with a NULL, a numeric, a timestamp, a bytea, a jsonb, and an array column):**
  - Run a `SELECT` that returns those types; Export ▸ CSV → open the file: NULL is a bare empty field, empty text is `""`, the timestamp is ISO, the numeric is exact, the jsonb is a quoted JSON field. Export ▸ JSON → the array-of-objects with native types.
  - Query menu Export results exports the focused panel; with no result it notifies.
  - Right-click a table → Export ▸ CSV downloads the **whole** table (row count matches `SELECT count(*)`), streamed; the same for a view.
  - A truncated (> cap) query result exports the shown rows with the caveat notify.
- **Library repo:** unaffected — no `/home/jika/typescript/typescript-ui` source change.

---

## Documentation Impact

**None on the library** — no `@jimka/typescript-ui` public symbol is added or changed. The new symbols (`toCSV`/`toJSON`, `download`, `tableExportUrl`, `ExportRowsQuery`, `export_format`, the controller/panel additions) are **app-internal** to the `sqladmin` workspace, documented in-place by doc-comments per the app's conventions. If sqladmin keeps a user-facing README/feature list, add "export results as CSV/JSON (query results + full-table streaming export)".

---

## Potential Challenges

- **The streaming operation breaks the `apply()`/`get_result()` CQRS contract** — mitigated by giving it a distinct `stream()` (documented in *Architecture Decisions*), keeping the pure formatters as the testable core and the `__init__` validation intact; the deviation is confined to export.
- **Connection lifetime across a stream** — the cursor needs its connection alive for the whole response, so the route acquires the connection outside the `async with` sugar and releases it in the generator's `finally`; a client that aborts the download mid-stream must still release (the generator's `finally` runs on GC/close). Verify a cancelled download does not leak a pool connection.
- **NULL-vs-empty-string CSV convention is a choice, not a standard** — RFC 4180 has no NULL; the "bare empty = NULL, quoted `\"\"` = empty string" rule is documented at the export action and mirrored exactly in Python so the two surfaces agree. A consumer importing the CSV must know the convention (stated in the notify/tooltip).
- **Query-menu export needs the *active* panel** — solved by the `onResult` callback + focus tracking; a subtle case is the menu firing while a float window is focused. The controller records `_activePanelId` from `"focus"`, which fires for floats too, so the active result stays correct; if no panel is focused (empty workspace) the menu notifies "no result".
- **`json`/`jsonArray` values arriving already-parsed vs. as strings** — the frontend receives them parsed (the backend passes json/jsonb through as Python objects → JSON — [`wire.py:133`](../backend/app/wire.py#L133)); the serializer `JSON.stringify`s them for CSV and passes them through for JSON. A value that is unexpectedly a string is still handled (String()/passthrough), so a type surprise degrades gracefully rather than throwing.
- **Large table export UX** — the streamed download shows the browser's own progress; no in-app spinner is added (the endpoint returns immediately and streams). A future in-app progress affordance is a Non-Goal.
- **Filename collisions / special chars** — `<schema>.<table>` may contain characters awkward in a filename; the header sets a reasonable default and the browser sanitizes. Not worth a bespoke encoding for a demo app.

---

## Critical Files

**App (read/modify — mirror existing patterns):**
- [`frontend/src/dock/QueryPanel.ts`](../frontend/src/dock/QueryPanel.ts) — the NORTH `ToolBar` ([`:84`](../frontend/src/dock/QueryPanel.ts#L84)), `showResult`/`hideResultPane`/`clear` ([`:182`,`:124`,`:135`](../frontend/src/dock/QueryPanel.ts#L182)), the `glyphButton` helper ([`:226`](../frontend/src/dock/QueryPanel.ts#L226)), the `syncClearEnabled` enable pattern ([`:143`](../frontend/src/dock/QueryPanel.ts#L143)), the held `QueryResult` shape.
- [`frontend/src/SqlAdminController.ts`](../frontend/src/SqlAdminController.ts) — `openQuery` injection ([`:172`](../frontend/src/SqlAdminController.ts#L172)), the `"focus"`/`"close"` Dock subscriptions ([`:66`,`:70`](../frontend/src/SqlAdminController.ts#L66)), `notifyError` ([`:305`](../frontend/src/SqlAdminController.ts#L305)).
- [`frontend/src/navigator/NavigatorTree.ts`](../frontend/src/navigator/NavigatorTree.ts) — the `contextmenu` handler + kind gate to extend ([`:45`](../frontend/src/navigator/NavigatorTree.ts#L45)).
- [`frontend/src/contract.ts`](../frontend/src/contract.ts) — `WireType` ([`:19`](../frontend/src/contract.ts#L19)), `QueryColumnMeta`/`QueryRowsResult`/`ColumnMeta` ([`:46`,`:52`,`:29`](../frontend/src/contract.ts#L46)) — the export input shapes.
- [`frontend/src/data/api.ts`](../frontend/src/data/api.ts) — the typed-fetch idiom + the URL patterns to mirror for `tableExportUrl` ([`:75`,`:86`](../frontend/src/data/api.ts#L75)).
- [`frontend/src/dock/TableWorkPanel.ts`](../frontend/src/dock/TableWorkPanel.ts) — the `ToolBar`/`glyphButton` idiom to mirror for the Export button.
- [`frontend/vitest.config.ts`](../frontend/vitest.config.ts) — node-only env ([`:9`](../frontend/vitest.config.ts#L9)); `*.test.ts` beside source (test-placement precedent).

**Backend (read/modify):**
- [`backend/app/wire.py`](../backend/app/wire.py) — `to_wire_value`/`rows_to_wire` ([`:114`,`:209`](../backend/app/wire.py#L114)) reused to wire-map streamed rows; the `WireType` cases the Python dialect keys on.
- [`backend/app/operations/list_rows.py`](../backend/app/operations/list_rows.py) — the `SELECT *` + `qualified()` + wire-map shape `ExportRowsQuery` mirrors (minus pagination) ([`:69`,`:99`](../backend/app/operations/list_rows.py#L69)).
- [`backend/app/operations/base.py`](../backend/app/operations/base.py) — the `Query`/`Command` contract the streaming op documents its deviation from.
- [`backend/app/operations/common.py`](../backend/app/operations/common.py) — `qualified()`/`quote_ident` ([`:12`](../backend/app/operations/common.py#L12)) for the validated, quoted relation name.
- [`backend/app/main.py`](../backend/app/main.py) — the acquire → `_columns_for` (404 gate) → construct → route shape ([`:115`,`:265`](../backend/app/main.py#L115)); the `DomainError`/`PostgresError` handlers the export inherits.
- [`backend/app/contract.py`](../backend/app/contract.py) — `TableRef`, `ColumnMeta`, `WireType` the operation and formatters use.
- [`backend/tests/test_list_objects.py`](../backend/tests/test_list_objects.py) — the set-`_raw` / `NO_CONN` unit-test pattern the export-format and construct-time tests follow.

**Library (read for the composed components — do not modify):**
- [`component/table/TableExporter.ts`](../../typescript-ui/src/typescript/lib/component/table/TableExporter.ts) — the existing exporter this plan **deliberately does not reuse** (locale formatting, NULL-collapsing, `Table`-bound, `private download`); read to confirm the reuse-vs-build reasoning.
- [`component/menubar/index.ts`](../../typescript-ui/src/typescript/lib/component/menubar/index.ts), [`component/button/index.ts`](../../typescript-ui/src/typescript/lib/component/button/index.ts), [`overlay/index.ts`](../../typescript-ui/src/typescript/lib/overlay/index.ts) — `ToolBar`/`Button`/`Menu`/`Glyph` for the export button and context submenu.

---

## Non-Goals

- **A "full" query-result export that silently re-runs the SQL without the cap** — rejected: re-executing arbitrary user SQL can have side effects and be unbounded; the query export covers the *loaded* (capped) rows, and the navigator table export streams the full relation server-side for the large case.
- **Reusing the library's `Table.exportCSV`/`exportJSON`/`TableExporter`** — rejected for locale formatting, NULL-collapsing, and `Table`-binding (see first Architecture Decision); the app owns a wire-typed serializer instead.
- **Additional export formats (XLSX, SQL `INSERT`s, Parquet, TSV)** — CSV + JSON only.
- **Export options UI (column selection, delimiter choice, quote-all, no-header)** — a fixed dialect ships; a future options dialog is out of scope.
- **In-app streaming progress / cancel affordance** — the browser's native download progress suffices for the demo; no in-app progress bar.
- **Compression / chunked-encoding tuning** — the endpoint streams plain text; no gzip negotiation.
- **Exporting query results *through* the backend** (a "run this SQL and stream the export") — the query export is client-side over loaded rows; only the navigator full-table export uses the backend, and it is `SELECT *`, not arbitrary SQL.
- **Modifying `NavigatorTree` grouping or the Query-menu structure** — owned by schema-views/structure-detail and query-workspace respectively; this plan only appends the export leaf items at their seams.
