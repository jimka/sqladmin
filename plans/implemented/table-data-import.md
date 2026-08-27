# Table Data Import (CSV / JSON) — Implementation Plan

## Overview

Add "Import data from JSON / CSV into a table," the backlog item in the Data
section of [`TODO.md:13`](TODO.md#L13). A user opens an existing table's Data
tab, picks a CSV or JSON file, previews the parsed rows (with per-row
validation errors), and commits — the backend inserts every row through the
connected role's own Postgres privileges, exactly like every other write in
this app.

The feature adds two backend operations
([`backend/app/operations/import_rows.py`](backend/app/operations/import_rows.py),
new) that plug into the existing CQRS `Query`/`Command` pattern
([`backend/app/operations/base.py`](backend/app/operations/base.py)) and reuse
the row-write value mapping already in
[`backend/app/wire.py`](backend/app/wire.py). On the frontend it adds a file
parser ([`frontend/src/data/parseImport.ts`](frontend/src/data/parseImport.ts),
new), a preview dialog
([`frontend/src/dock/ImportRowsDialog.ts`](frontend/src/dock/ImportRowsDialog.ts),
new), and one new toolbar button in
[`frontend/src/dock/TableWorkPanel.ts:172`](frontend/src/dock/TableWorkPanel.ts#L172),
wired from
[`frontend/src/SqlAdminController.ts:534`](frontend/src/SqlAdminController.ts#L534)
the same way Export already is.

---

## Architecture Decisions

### Existing tables only — no table creation from the file's inferred schema

Every write operation in this app already requires a pre-existing object:
`InsertRowCommand`/`UpdateRowCommand`/`DeleteRowCommand` all take
`columns: list[ColumnMeta]` from `_columns_for`
([`backend/app/main.py:210`](backend/app/main.py#L210)), which 404s if the
table doesn't exist. Import follows the same rule — it targets a table the
user already opened.[^table-creation]

### Coercion is server-side, reusing `from_wire_value`; parsing is client-side

Two new pure functions carry the whole feature's logic:
`from_import_scalar` in `wire.py` (backend, new) normalizes one raw file value
into the shape `from_wire_value` already expects, and `parseImportFile` in
`parseImport.ts` (frontend, new) turns file text into
`Array<Record<string, unknown>>`. Nothing in between re-implements type
coercion — the same `from_wire_value` call `InsertRowCommand.__init__`
already makes ([`backend/app/operations/insert_row.py:56`](backend/app/operations/insert_row.py#L56))
is the one that runs for an imported row.[^why-not-client-coercion]

### Preview (Query, no I/O) then commit (Command, one transaction) — no file upload endpoint

The backend gets two new routes mirroring the DDL phases' existing
`previewX` → `executeDdl` shape
([`frontend/src/data/api.ts:356`](frontend/src/data/api.ts#L356) →
[`api.ts:351`](frontend/src/data/api.ts#L351)):
`POST .../rows/import/preview` (`PreviewImportRowsQuery`, a `Query` with no
`conn` parameter at all — mirrors `DdlPreview`
([`backend/app/operations/ddl.py:32`](backend/app/operations/ddl.py#L32)),
whose preview needs no I/O) and `POST .../rows/import`
(`ImportRowsCommand`, a `Command`). Both take `{"rows": [...]}` — plain
JSON, the same shape every other write route already accepts via
`data: dict = Body(...)`. No `UploadFile`/multipart handling exists anywhere
in this backend today (confirmed by search); adding one would be a new,
unjustified I/O shape when the client can read `File.text()` itself and POST
JSON like every other write already does.

### All-or-nothing commit, one transaction

`ImportRowsCommand.apply()` wraps every row's insert in one
`async with self._conn.transaction()`, matching every existing Command
(`InsertRowCommand.apply()`, `UpdateRowCommand.apply()`,
`ExecuteDdlCommand.apply()` — all single-transaction). No write path in this
app reports a partial multi-row result today; inventing one for import alone
would need a new response contract and a new piece of UI with no
precedent.[^partial-commit-rejected]

### Reuse `InsertRowCommand` itself for the commit, via nested transactions

`ImportRowsCommand.apply()` constructs one `InsertRowCommand` per
already-coerced row and calls `.apply()` on each, all inside its own outer
transaction. asyncpg's `Connection.transaction()` opened while already inside
a transaction becomes a `SAVEPOINT`; an exception from any row's nested
transaction re-raises out of `InsertRowCommand.apply()` uncaught, so it
propagates out of `ImportRowsCommand.apply()`'s loop and rolls back the outer
transaction too — the existing per-row Command needs no changes to be reused
this way, and no new SQL-building code is needed at all.

### Row cap: 1000, matching this app's existing per-request ceilings

`run_query.py`'s `MAX_RESULT_ROWS = 1000`
([`backend/app/operations/run_query.py:31`](backend/app/operations/run_query.py#L31))
and `list_rows.py`'s `_MAX_PAGE_SIZE = 1000`
([`backend/app/operations/list_rows.py:23`](backend/app/operations/list_rows.py#L23))
are this app's two existing answers to "how many rows can one request carry."
`MAX_IMPORT_ROWS = 1000` reuses the same figure. A file with more rows is
rejected up front (`ValidationError`, before any coercion) by both new
operations' constructors, mirroring `ExportRowsQuery`'s validate-before-I/O
contract.[^no-streaming]

### Preview grid shows a bounded sample, not the whole file

The dialog's grid displays only the first `PAGE_SIZE` (100 — the same
constant [`frontend/src/data/stores.ts:16`](frontend/src/data/stores.ts#L16)
already uses for every paginated grid) parsed rows, regardless of file size.
This sidesteps the library's ~1500-row `MemoryStore` zero-render bug
(`TODO.md`'s "Known issues" section) entirely instead of relying on staying
under a fuzzy threshold — the 1000-row import cap is comfortably under it
too, but the display cap doesn't depend on that margin holding. Validation
still runs over every row server-side, so the summary counts and the actual
commit are accurate regardless of what the grid shows.

### CSV/JSON dialect mirrors this app's own export dialect, inverted

`export_format.py`'s `_csv_field`
([`backend/app/export_format.py:33`](backend/app/export_format.py#L33)) and
its frontend mirror `serialize.ts`'s `csvCell`/`escapeField`
([`frontend/src/data/serialize.ts:53`](frontend/src/data/serialize.ts#L53))
already define this app's CSV dialect precisely: RFC 4180, comma delimiter,
CRLF records, and — the detail a naive `split(",")` parser would lose — **a
bare empty field is NULL, a quoted empty field (`""`) is the empty string**.
`parseImportFile`'s CSV branch is the structural inverse of those two
functions, preserving the same distinction, so a file this app exported
round-trips through import losslessly (aside from the generated PK, see
below). JSON export emits one JSON array of row objects
(`json_open`/`json_row`/`json_close`,
[`export_format.py:100`](backend/app/export_format.py#L100)); JSON import
requires the same shape.

### Generated columns in the file are dropped silently, not rejected

`SqlAdminWriter.strip()`
([`frontend/src/data/SqlAdminWriter.ts:24`](frontend/src/data/SqlAdminWriter.ts#L24))
already drops every `isGenerated` column from a manual write's body before it
reaches the backend. The shared row-coercion helper (`_coerce_row`, new, in
`import_rows.py`) applies the identical rule: a file column that names a real,
`isGenerated` table column is skipped, not reported as unknown — this is what
makes importing this app's own CSV/JSON export of the same table (which
includes the generated PK via `SELECT *`) work without the user hand-editing
the file first.

### Unknown column name: fail the whole import up front, not per-row

A CSV header or JSON key that matches no real column raises `ValidationError`
immediately — before any row is coerced — the same way
`InsertRowCommand.__init__` already raises
`ValidationError(f"Unknown column '{k}'")` for an unrecognized payload key
([`insert_row.py:52`](backend/app/operations/insert_row.py#L52)). This is a
structural problem shared by every row, not a per-row data problem, so it is
checked once and stops the whole import rather than appearing in the preview
grid 1000 times.

### Import button: `TableWorkPanel`'s toolbar, beside Add, gated on `privileges.insert` only

Mirrors `addButton`'s construction and privilege gating
([`TableWorkPanel.ts:147`](frontend/src/dock/TableWorkPanel.ts#L147)) exactly
— both are "create rows" actions. Unlike Add, Import does not also disable in
the rotated record view: that restriction exists because "only the grid can
fill in a new row" (`syncAddEnabled`'s own comment,
[`TableWorkPanel.ts:349`](frontend/src/dock/TableWorkPanel.ts#L349)), which
doesn't apply to a modal dialog flow. `privileges.insert` never changes after
the panel opens, so — unlike Add/Delete/Save — Import needs no `syncXEnabled`
listener, just a one-time `setEnabled` at construction.

---

## Internal Structure

### `from_import_scalar(raw, column)` — the coercion table

New function in `wire.py`, called before `from_wire_value` for every
non-`None` value. `raw` is whatever the client's JSON payload carries for one
cell: always `str | None` for a CSV-sourced row, any JSON-native scalar/object
for a JSON-sourced row (the function does not know or care which).

| `column.wire_type` | `raw` | Rule | Example |
|---|---|---|---|
| any | `None` | → `None` | `null` → `None` |
| `NUMBER` | `int`/`float` (not `bool`) | passthrough | `42` → `42` |
| `NUMBER` | `str` | `int(raw)` if integer text, else `float(raw)`; else raise | `"42"` → `42`; `"abc"` → error |
| `STRING`, numeric-as-string (`data_type` in `numeric`/`decimal`/`money`) | `str` | passthrough (validated later by `Decimal(value)`) | `"19.99"` → `"19.99"` |
| `STRING`, numeric-as-string | `int`/`float` | `str(raw)` | `19.99` → `"19.99"` |
| `STRING`, `uuid`/plain text | `str` | passthrough | `"hello"` → `"hello"` |
| `STRING`, plain text | `int`/`float`/`bool` | `str(raw)` (lenient) | `42` → `"42"` |
| `BOOLEAN` | `bool` | passthrough | `true` → `True` |
| `BOOLEAN` | `str` | case-insensitive: `{true,t,1,yes,y}` → `True`, `{false,f,0,no,n}` → `False`; else raise | `"Y"` → `True`; `"nope"` → error |
| `ISO_STRING` | `str` | passthrough (validated later by `from_wire_value`'s ISO parsing) | `"2026-01-01"` → `"2026-01-01"` |
| `ISO_STRING` | non-`str` | raise | `20260101` → error |
| `JSON`, `JSON_ARRAY` | `str` | `json.loads(raw)`; raise on parse failure | `'{"a":1}'` → `{"a": 1}` |
| `JSON`, `JSON_ARRAY` | `dict`/`list`/other JSON-native | passthrough | `{"a":1}` → `{"a":1}` |
| `BASE64` | `str` | passthrough (validated later by `base64.b64decode`) | `"aGVsbG8="` → `"aGVsbG8="` |
| `BASE64` | non-`str` | raise | |

`NUMBER`/`BOOLEAN` string matching strips leading/trailing whitespace first;
plain-text `STRING` values do not (leading/trailing space may be real data).

### `_coerce_row` — shared by preview and commit

New module-level function in `import_rows.py`:

```python
def _coerce_row(raw: dict, by_name: dict[str, ColumnMeta]) -> dict:
    """
    Map one raw import row to a wire-shaped dict InsertRowCommand accepts.

    Drops any key naming a generated column (mirrors SqlAdminWriter.strip()).

    Raises:
        ValidationError: an unknown key, or a value that fails to coerce —
            message names the offending column.

    Returns:
        The row's wire-shaped values, ready for InsertRowCommand.
    """
```

For each `k, v` in `raw`: if `k not in by_name`, raise `ValidationError`
("Unknown column"); if `by_name[k].is_generated`, skip the key entirely;
otherwise `wire_row[k] = from_import_scalar(v, by_name[k])`, catching
`ValueError`/`decimal.InvalidOperation`/`json.JSONDecodeError` and
re-raising as `ValidationError(f"{k}: {e}")`.

### `PreviewImportRowsQuery`

```python
class PreviewImportRowsQuery(Query):
    def __init__(self, table: TableRef, rows: list[dict], columns: list[ColumnMeta]) -> None: ...
    async def apply(self) -> None: ...   # no conn, no I/O — mirrors DdlPreview
    def get_result(self) -> dict: ...
```

`__init__` raises `ValidationError` if `len(rows) > MAX_IMPORT_ROWS`.
`apply()` loops `rows` with a 1-based `rowNumber`; for each, calls
`_coerce_row`, then also calls `from_wire_value` per value purely to validate
it doesn't raise (its native-Python return value is discarded — the
**wire**-shaped value from `_coerce_row` is what gets sent back, since it is
already JSON-safe), then checks `is_required_column` (new, `common.py`,
mirrors `isRequiredColumn` — [`tableWriteRules.ts:26`](frontend/src/dock/tableWriteRules.ts#L26))
against every column not present or coerced to `None`. Any failure at any of
these steps records `{"rowNumber": n, "ok": False, "error": str(e)}`; success
records `{"rowNumber": n, "ok": True, "values": wire_row}`.
`get_result()` returns `{"rows": [...], "totalRows": len(rows), "errorRows": n}`.

### `ImportRowsCommand`

```python
class ImportRowsCommand(Command):
    def __init__(self, conn: asyncpg.Connection, table: TableRef, rows: list[dict], columns: list[ColumnMeta]) -> None: ...
    async def apply(self) -> None: ...   # one outer transaction, N InsertRowCommand.apply() calls
    def get_result(self) -> dict: ...    # {"insertedCount": N}
```

`__init__` raises `ValidationError` if `len(rows) > MAX_IMPORT_ROWS`, then
calls `_coerce_row` on every row up front (so a bad value fails before any
INSERT runs, not mid-batch). `apply()` opens one
`async with self._conn.transaction():` and, inside it, builds and applies one
`InsertRowCommand(self._conn, self._table, wire_row, self._columns)` per row.

### `frontend/src/data/parseImport.ts`

```ts
export interface ParsedImport {
    headers: string[];
    rows: Array<Record<string, unknown>>;
}

export function parseImportFile(fileName: string, text: string): ParsedImport;
```

Dispatches on `fileName`'s extension (`.csv` / `.json`; anything else throws
`Error("Unsupported file type — expected .csv or .json")`, checked before any
network call).

**CSV branch** — a character-scanning state machine (not `split(",")`,
which cannot track quoting): tracks `inQuotes` and, per field, whether it was
ever inside a `"` pair. `"` doubled inside a quoted field is one literal `"`.
Records split on `\r\n` or bare `\n` (the app's own export always emits
`\r\n`; a bare `\n` is accepted leniently for files from other tools). A data
row with a different field count than the header throws immediately, naming
the row number — this is a structural error, rejected before any preview
round-trip.

| CSV field text | Parsed value | Why |
|---|---|---|
| *(empty, never quoted)* | `null` | bare empty = SQL NULL, per `_csv_field`'s own export rule |
| `""` | `""` | quoted empty = empty string, not NULL |
| `hello` | `"hello"` | plain field |
| `"a,b"` | `"a,b"` | comma only significant unquoted |
| `"say ""hi"""` | `say "hi"` | doubled quote inside a quoted field is one literal `"` |

**JSON branch** — `JSON.parse(text)`; throws if the top level is not an
array, or if any element is not a plain object (catches NDJSON and single-object
files with a message naming the expected shape — see Non-Goals).

### `frontend/src/dock/ImportRowsDialog.ts`

```ts
export interface ImportRowsDialogOptions {
    ref: DbObjectRef;
    columns: ColumnMeta[];
    onImported: (insertedCount: number) => void;
}

export function openImportRowsDialog(options: ImportRowsDialogOptions): void;
```

Content: a `FileDropZone` (`@jimka/typescript-ui/component/input`, `accept:
".csv,.json"`) → on `"change"`, `file.text()` → `parseImportFile` → catch a
parse error into a Notification and stop; otherwise call
`previewImportRows(ref, rows)` and populate a read-only `Table` over a
`MemoryStore`, built the same way `columnsGrid.ts`'s `readOnlyTable` builds
one ([`columnsGrid.ts:67`](frontend/src/dock/columnsGrid.ts#L67)): one field
per table column (via the same `WIRE_TO_FIELD` map `buildModel.ts` already
uses) plus a synthetic `error` string field, sliced to the first `PAGE_SIZE`
preview rows; a summary line above it reads `"{totalRows} row(s) parsed,
{errorRows} with errors"`. The dialog's primary "Import" button is disabled
whenever `errorRows > 0` or no file has been previewed yet — a row that
failed preview would fail commit identically, so there is nothing to gain
from letting the user try. On confirm, `executeImportRows(ref, rows)`; on
success, `options.onImported(insertedCount)` and close; on failure, report
the error (mirrors `SqlPreviewDialog.ts`'s `reportError`
[`SqlPreviewDialog.ts:284`](frontend/src/dock/SqlPreviewDialog.ts#L284)) and
leave the dialog open — the same already-parsed rows can be retried with one
click, useful for a transient failure.

---

## Public API

```python
# backend/app/wire.py
def from_import_scalar(raw: Any, column: ColumnMeta) -> Any: ...

# backend/app/operations/common.py
def is_required_column(column: ColumnMeta) -> bool: ...

# backend/app/operations/import_rows.py
MAX_IMPORT_ROWS: int = 1000

class PreviewImportRowsQuery(Query):
    def __init__(self, table: TableRef, rows: list[dict], columns: list[ColumnMeta]) -> None: ...

class ImportRowsCommand(Command):
    def __init__(self, conn: asyncpg.Connection, table: TableRef, rows: list[dict], columns: list[ColumnMeta]) -> None: ...
```

```ts
// frontend/src/contract.ts
export interface ImportRowResult {
    rowNumber: number;
    ok: boolean;
    values?: Record<string, unknown>; // present when ok
    error?: string;                   // present when !ok
}
export interface ImportPreviewResult {
    rows: ImportRowResult[];
    totalRows: number;
    errorRows: number;
}
export interface ImportCommitResult {
    insertedCount: number;
}

// frontend/src/data/api.ts
export function previewImportRows(ref: DbObjectRef, rows: Record<string, unknown>[]): Promise<ImportPreviewResult>;
export function executeImportRows(ref: DbObjectRef, rows: Record<string, unknown>[]): Promise<ImportCommitResult>;

// frontend/src/data/parseImport.ts
export interface ParsedImport { headers: string[]; rows: Array<Record<string, unknown>> }
export function parseImportFile(fileName: string, text: string): ParsedImport;

// frontend/src/dock/ImportRowsDialog.ts
export interface ImportRowsDialogOptions {
    ref: DbObjectRef;
    columns: ColumnMeta[];
    onImported: (insertedCount: number) => void;
}
export function openImportRowsDialog(options: ImportRowsDialogOptions): void;

// frontend/src/dock/TableWorkPanel.ts — new constructor parameter
export type ImportTable = () => void;
// constructor(store, columns, notify, onExport, onImport: ImportTable, privileges, view?)
```

---

## Ordered Implementation Steps

1. **`backend/app/wire.py`** — add `_TRUE_TEXT`/`_FALSE_TEXT` frozensets and
   `from_import_scalar`, per the coercion table above. Unit-test each row of
   the table.
2. **`backend/app/operations/common.py`** — add `is_required_column`,
   mirroring `isRequiredColumn`'s three-flag rule
   (`not nullable and not is_generated and not has_default`).
3. **`backend/app/operations/import_rows.py`** (new) — `MAX_IMPORT_ROWS`,
   `_coerce_row`, `PreviewImportRowsQuery`, `ImportRowsCommand`, per
   `## Internal Structure`.
4. **`backend/app/operations/__init__.py`** — export
   `PreviewImportRowsQuery`, `ImportRowsCommand`.
5. **`backend/app/main.py`** — add
   `POST /api/{connection_id}/{database}/{schema}/{table}/rows/import/preview`
   and `POST /api/{connection_id}/{database}/{schema}/{table}/rows/import`
   right after the existing `delete_row` route
   ([`main.py:783`](backend/app/main.py#L783)), both `Depends(require_csrf)`,
   both resolving `cols` via `_columns_for` exactly like `insert_row`
   ([`main.py:729`](backend/app/main.py#L729)).
6. **`backend/tests/test_wire.py`** — extend with `from_import_scalar` cases
   covering every row of the coercion table.
7. **`backend/tests/test_import_rows.py`** (new) — constructor validation
   (unknown column, oversized `rows`, generated-column drop, required-column
   miss), using `NO_CONN`/`ROW_COLS`/`TABLE`/`col()` from `conftest.py`
   ([`backend/tests/conftest.py:22`](backend/tests/conftest.py#L22)),
   mirroring `test_insert_row.py`'s shape.
8. **`frontend/src/contract.ts`** — add `ImportRowResult`,
   `ImportPreviewResult`, `ImportCommitResult`.
9. **`frontend/src/data/api.ts`** — add `previewImportRows`,
   `executeImportRows`, following `previewCreateTable`/`executeDdl`'s
   `postJson` shape exactly.
10. **`frontend/src/data/parseImport.ts`** (new) — `parseImportFile`, per
    `## Internal Structure`. Keep DOM-free (no `document`/`File` reference —
    it takes `text: string`, already read by the caller) so it is
    node-testable, matching `serialize.ts`'s own constraint.
11. **`frontend/tests/data/parseImport.test.ts`** (new) — CSV quoting/NULL
    table above, JSON shape rejections, mismatched-column-count row error.
12. **`frontend/src/dock/ImportRowsDialog.ts`** (new) — per
    `## Internal Structure`.
13. **`frontend/src/dock/TableWorkPanel.ts`** — import `file_import` glyph,
    register it alongside the existing `Glyph.register` call
    ([`TableWorkPanel.ts:85`](frontend/src/dock/TableWorkPanel.ts#L85)); add
    the `onImport: ImportTable` constructor parameter (positioned right
    after `onExport`); build `importButton` beside `addButton`
    ([`TableWorkPanel.ts:147`](frontend/src/dock/TableWorkPanel.ts#L147)),
    same glyph-button helper, `CONSTRUCTIVE_COLOR`, gated
    `privileges.insert`; insert it into the toolbar's `components` array
    right after `addButton`
    ([`TableWorkPanel.ts:181`](frontend/src/dock/TableWorkPanel.ts#L181)).
14. **`frontend/src/SqlAdminController.ts`** — add a private `importIntoTable`
    method mirroring `exportTable`
    ([`SqlAdminController.ts:2724`](frontend/src/SqlAdminController.ts#L2724)):
    calls `openImportRowsDialog` with `onImported` doing `store.reject();
    void store.load();` then `notify(...)`, matching the existing Refresh
    button's reload sequence
    ([`TableWorkPanel.ts:197`](frontend/src/dock/TableWorkPanel.ts#L197)).
    Wire it into the `TableWorkPanel` construction at
    [`SqlAdminController.ts:534`](frontend/src/SqlAdminController.ts#L534) as
    the new `onImport` argument.
15. **Regression check**: `grep -rn "new TableWorkPanel(" frontend/src` —
    expect exactly the one call site updated in step 14.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/wire.py` |
| Modify | `backend/app/operations/common.py` |
| Create | `backend/app/operations/import_rows.py` |
| Modify | `backend/app/operations/__init__.py` |
| Modify | `backend/app/main.py` |
| Modify | `backend/tests/test_wire.py` |
| Create | `backend/tests/test_import_rows.py` |
| Modify | `frontend/src/contract.ts` |
| Modify | `frontend/src/data/api.ts` |
| Create | `frontend/src/data/parseImport.ts` |
| Create | `frontend/tests/data/parseImport.test.ts` |
| Create | `frontend/src/dock/ImportRowsDialog.ts` |
| Modify | `frontend/src/dock/TableWorkPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |

---

## Expected Behaviour

1. **CSV NULL vs empty string.** A bare empty field on a nullable column
   coerces to `None`; a quoted `""` on the same column coerces to `""`.
   Unit-testable (`parseImportFile`).
2. **CSV round-trip.** A file produced by this app's own CSV export of table
   `T`, re-imported into `T`, produces the same non-generated column values
   (generated columns are dropped and reassigned). Unit-testable at the
   `_coerce_row`/`from_import_scalar` level with fixed input/output pairs.
3. **Required column left NULL.** A bare-empty (or absent) value on a column
   where `is_required_column` is true produces `{"ok": false, "error": ...}`
   in the preview naming that column; Import stays disabled. Unit-testable
   (`PreviewImportRowsQuery`).
4. **Bad value for a column's type.** E.g. `"abc"` for a `NUMBER` column
   produces a per-row error naming the column and the offending text; other
   rows in the same file still get their own independent ok/error result.
   Unit-testable.
5. **Unknown column name.** A CSV header or JSON key matching no table
   column fails the whole `PreviewImportRowsQuery`/`ImportRowsCommand`
   construction with one `ValidationError`, before any row is coerced — not
   a per-row entry. Unit-testable.
6. **Generated column in the file.** A file column naming a real,
   `isGenerated` table column is dropped silently; it never appears as
   "unknown" and is never written. Unit-testable.
7. **JSON shape rejection.** A top-level JSON value that is not an array, or
   an array element that is not a plain object, is rejected by
   `parseImportFile` before any network call, with a message naming the
   expected shape. Unit-testable.
8. **CSV column-count mismatch.** A data row with a different field count
   than the header is rejected by `parseImportFile` before any network call,
   naming the row. Unit-testable.
9. **Row cap.** A `rows` array longer than `MAX_IMPORT_ROWS` (1000) is
   rejected by both operations' constructors with `ValidationError`, before
   any coercion. Unit-testable.
10. **All-or-nothing commit.** A mid-batch Postgres error (e.g. a unique
    violation `PreviewImportRowsQuery` could not have caught, since preview
    never touches the database) rolls back the entire transaction — zero
    rows land — mapped to 409/400 by the existing `_pg_error_handler`
    ([`main.py:175`](backend/app/main.py#L175)), unchanged. Manual-verify
    (needs a real Postgres connection and a conflicting row).
11. **No INSERT privilege.** The first row's `INSERT` fails with Postgres's
    own permission-denied error, surfaced through the same generic
    `_pg_error_handler` → `notifyError`/Notification path every other write
    failure already uses — no import-specific error handling exists.
    Manual-verify (needs a role without INSERT).
12. **Preview grid display cap.** Regardless of file size, the dialog's grid
    never receives more than `PAGE_SIZE` (100) rows; the summary line's
    `totalRows`/`errorRows` always reflect the full file. Unit-testable for
    the slicing; the rendered grid itself is manual-verify.

---

## Verification

- `cd backend && poetry run pytest tests/test_wire.py tests/test_import_rows.py`
- `cd backend && poetry run pytest` (full suite — regression)
- `cd frontend && npm run typecheck`
- `cd frontend && npm test -- parseImport` and `npm test -- api`
- `grep -rn "new TableWorkPanel(" frontend/src` — expect one match, at the
  updated call site.
- Manual smoke test (Data tab of a table the connected role can INSERT on):
  1. Click Import, drop a valid CSV — preview grid populates, summary reads
     "N row(s) parsed, 0 with errors," Import button enables.
  2. Confirm — dialog closes, grid reloads showing the new rows, status bar
     reads "Imported N row(s)."
  3. Repeat with a CSV containing one bad value (e.g. text in a numeric
     column) — that row's Error cell explains it, Import stays disabled.
  4. Repeat with a JSON array-of-objects file — same preview/commit flow.
  5. Repeat while logged in as a role with SELECT but not INSERT on the
     table — Import stays hidden/disabled per `privileges.insert`, matching
     Add's existing gating.
  6. Export the same table to CSV, re-import it into itself (or a copy) —
     row count matches, no duplicate-PK failure (generated PK dropped).

---

## Potential Challenges

- **`from_wire_value` has no `JSON_ARRAY` case today** — it falls through to
  its catch-all `return value`, relying on the value already being a native
  Python list. Import intentionally does not exercise this path for CSV
  (see Non-Goals); confirm `from_import_scalar`'s `JSON_ARRAY` handling for
  JSON-sourced rows (passthrough) doesn't accidentally break this existing
  fallback for JSON columns.
- **Nested-transaction reuse of `InsertRowCommand`** depends on asyncpg's
  documented savepoint behavior for a `transaction()` opened inside another.
  Verify with an integration test (not just unit tests) that a failure on
  row 3 of 5 actually rolls back rows 1–2 as well, not just row 3's own
  savepoint.
- **CSV state-machine parser correctness** is the riskiest new code — get
  the quoted/unquoted-empty distinction and embedded-quote-doubling right
  first, backed by the round-trip test against `export_format.py`'s own
  `_csv_field` output.

---

## Critical Files

- [`backend/app/operations/base.py`](backend/app/operations/base.py) — the
  `Query`/`Command` contract every new operation must honor.
- [`backend/app/operations/insert_row.py`](backend/app/operations/insert_row.py) —
  reused directly by `ImportRowsCommand`; read before touching either.
- [`backend/app/wire.py`](backend/app/wire.py) — `from_wire_value` is the
  function `from_import_scalar` feeds; read its existing cases before adding
  new ones.
- [`backend/app/operations/ddl.py`](backend/app/operations/ddl.py) —
  `DdlPreview`'s no-I/O `apply()` is the precedent `PreviewImportRowsQuery`
  follows.
- [`backend/app/export_format.py`](backend/app/export_format.py) and
  [`frontend/src/data/serialize.ts`](frontend/src/data/serialize.ts) — the
  CSV/JSON dialect `parseImportFile` inverts.
- [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts)
  and
  [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) —
  the toolbar-button and panel-construction wiring Import extends.
- [`frontend/src/dock/columnsGrid.ts`](frontend/src/dock/columnsGrid.ts) —
  the read-only `Table`-over-`MemoryStore` pattern the preview grid follows.
- [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts) —
  the closest existing "async preview → confirm → execute, retry on failure"
  dialog shape, though its content (a `CodeEditor`) differs enough from a
  grid that `ImportRowsDialog` is a new dialog, not a subclass.
- [`backend/tests/conftest.py`](backend/tests/conftest.py) — the
  `NO_CONN`/`col()`/`ROW_COLS`/`TABLE` fixtures new backend tests reuse.

---

## Non-Goals

- **Table creation from the imported file's inferred schema.** Import
  targets an existing table only (see Architecture Decisions).
- **NDJSON.** v1 supports a single JSON array of objects, matching this
  app's own export shape; NDJSON is a straightforward but separate parser
  addition (detect a leading `[` vs. a bare `{`) left for a fast-follow.
- **Postgres array-typed (`JSON_ARRAY` wire type) columns.** `from_wire_value`
  has no `JSON_ARRAY` case today (see Potential Challenges) and there is no
  established CSV/JSON-cell convention in this app to invert. A file
  containing values for an array column either has that column dropped or
  fails validation with a clear message — no array-literal parsing is
  attempted.
- **Partial commit / per-row error report on write.** All-or-nothing only
  (see Architecture Decisions).
- **Streaming upload for very large files.** The whole parsed file lives in
  memory client- and server-side, capped at `MAX_IMPORT_ROWS`; a larger file
  must be split by the user. Matches every other write route's shape; only
  the export path in this app streams.
- **Column mapping UI** (renaming a file's header to a different table
  column at import time). v1 matches by exact, case-sensitive name only,
  same as every other write payload's key lookup.

---

## Notes

[^table-creation]: Table creation from an inferred schema is a materially
    different feature — type inference from string samples, primary-key and
    index decisions, and a DDL preview/execute round trip — that belongs
    with the app's existing "create table" DDL phase
    (`backend/app/operations/ddl_table.py`,
    `frontend/src/dock/SqlPreviewDialog.ts`) rather than being bolted onto a
    row-import command. It could reuse that phase's form as a fast-follow
    once schema-inference rules are designed, but scoping it into this plan
    would roughly double its surface for a capability the backlog item does
    not ask for.

[^why-not-client-coercion]: The frontend's manual-edit path never
    duplicates `wire.py`'s coercion rules in TypeScript — a typed cell editor
    component (e.g. a number field) parses its own input, and the resulting
    JS value is serialized straight to JSON with no separate "wire mapping"
    step on the client. There is no reusable, headless "parse this raw value
    for this column's type" function on the frontend to call for import
    either — only DOM-bound field-editor components, which cannot run
    outside a mounted `Table`. Writing a second, parallel coercion
    implementation in TypeScript to avoid a server round-trip would risk the
    two drifting apart on edge cases (a numeric column's exact locale/format
    rules, ISO parsing) with no test surface shared between them. A cheap,
    stateless preview request avoids that risk entirely by running the exact
    same Python code preview and commit both use.

[^partial-commit-rejected]: A partial-commit design was considered and
    rejected: it would need a new "some rows failed, here's which and why"
    response contract and a corresponding UI treatment (which rows landed,
    which didn't, and how to fix and resubmit just the failures) that no
    other write flow in this app has ever needed, since every other write is
    already single-row. The preview step already catches the coercion
    failures a partial commit exists to soften; what a transaction still has
    to guard against — a constraint violation discoverable only at INSERT
    time — is exactly the kind of failure where "some of your rows are in,
    some aren't, here's a per-row report" is a worse outcome for the user
    than "nothing happened, fix the conflict and retry the whole file."

[^no-streaming]: A streaming import (reading the file incrementally, both
    over HTTP and into Postgres) was considered and rejected for v1 as
    disproportionate: it would need a new multipart-upload code path on a
    backend that has none today, plus a batched/chunked commit strategy that
    reopens the "how much of a failed batch already committed" question this
    plan otherwise avoids by keeping commit all-or-nothing. Capping at 1000
    rows — already this app's established per-request ceiling — keeps the
    whole feature inside the existing "one JSON body in, one JSON body out"
    write shape every other route uses.

---

## Implementation Notes

- **Unknown-column check moved into `PreviewImportRowsQuery.__init__`, not
  left inside `apply()`'s per-row loop.** The Internal Structure section's
  prose for `apply()` ("any failure at any of these steps records
  `{ok: false, ...}`") read, taken literally, as if an unknown column would
  also become a per-row preview entry — but the Architecture Decision
  "Unknown column name: fail the whole import up front, not per-row" and
  Expected Behaviour item 5 both explicitly require it to fail the whole
  **construction**, exactly like `ImportRowsCommand`. Implemented per the
  more specific Architecture Decision/Expected Behaviour text: both
  operations' constructors now reject an unknown column immediately (a
  dedicated up-front key scan for `PreviewImportRowsQuery`, since unlike
  `ImportRowsCommand` its constructor does not otherwise coerce rows), and
  `_validate_row`'s per-row try/except only ever sees a *value* coercion
  failure or a missing-required-column failure — never an unknown-column one.

- **`ImportRowsDialog`'s "Import" action is a content-embedded `Button`, not
  one of the `Dialog` chrome's `buttons`.** The plan's Internal Structure
  describes "the dialog's primary Import button" as disabled/enabled by
  state, but `Dialog`'s `DialogButtonRow` builds its `Button` instances
  internally and never exposes them — there is no public API to `setEnabled`
  a chrome button after construction (confirmed by reading
  `overlay/Dialog.ts`; `SqlPreviewDialog`'s own Execute button is never
  disabled, so no existing app dialog needed this either). Instead, the
  dialog's chrome carries only Cancel, and "Import" is an ordinary `Button`
  in the content area, which supports `setEnabled()` like any other button in
  this app. This also simplifies the retry flow versus `SqlPreviewDialog`'s
  rebuild-on-failure dance: a chrome button always calls `hide()`
  unconditionally on click, which is why `SqlPreviewDialog` must tear down
  and rebuild the whole `Dialog` to retry after a failed Execute; the content
  button here decides for itself whether to call `dialog.hide()`, so a
  failed import simply leaves the same `Dialog` instance open, with the same
  previewed rows, for a one-click retry — no `RetainedContentDialog`
  machinery needed.

- **`backend/tests/conftest.py`'s `col()` gained a `nullable: bool = True`
  keyword parameter** (default preserves every existing call site). Not
  listed in the plan's Files table, but required to construct a NOT NULL
  test column for `test_import_rows.py`'s required-column-miss coverage
  (Expected Behaviour item 3) — `col()` had no way to build one before.

- **`from_import_scalar`'s `JSON`/`JSON_ARRAY` coercion table row ("str ->
  json.loads(raw); raise on parse failure") does not actually hold for every
  `str`, and the audit caught the resulting bug.** The plan's own docstring
  premise — `from_import_scalar` "does not know or care which file format
  produced `raw`" — cannot be honored for these two wire types specifically:
  a CSV cell's text for a JSON column is always the column's full
  `json.dumps()` rendering (so `json.loads` reliably succeeds), but a
  JSON-sourced row's jsonb column may carry a plain string value directly —
  e.g. `{"doc": "hello"}` — where `"hello"` is not itself valid JSON. Since
  the backend has no signal distinguishing a CSV-sourced string from a
  JSON-sourced one (by design — see the "why-not-client-coercion" footnote),
  `from_import_scalar` now falls back to the literal string on a
  `json.JSONDecodeError` instead of raising. Accepted trade-off: a malformed
  CSV JSON cell (unbalanced braces, a stray comma) is now stored as a literal
  jsonb string instead of rejected at preview time — not silent data loss
  (jsonb can hold any scalar), just more lenient than the plan's literal
  "raise on parse failure" wording for that one edge case.

- **`ImportRowsDialog`'s commit no longer resends `previewedRows`' coerced
  `values`.** As implemented before this fix, `handleImport` sent preview's
  already-coerced values back to `executeImportRows`, and
  `ImportRowsCommand.__init__` coerced them a *second* time. Coercion is not
  idempotent for `JSON`/`JSON_ARRAY` (a value `from_import_scalar` itself
  produced is not always valid input to `from_import_scalar` again — e.g. a
  coerced jsonb string that happens not to be valid JSON text on its own),
  so a row that passed preview could fail the whole all-or-nothing commit.
  The dialog now keeps the *original* parsed rows (`parsedRows`, aligned by
  index with `previewedRows`) and sends those — filtered to the ok ones —
  to commit, so each phase coerces every value exactly once from its true
  source text. This also matches `previewImportRows`/`executeImportRows`'s
  own public API, which both take the same `Record<string, unknown>[]` shape
  the plan defined — the coerced-values shortcut was an implementation
  error, not something the plan asked for.

- **`ImportRowsDialog.ts`'s preview-grid row building (PAGE_SIZE slicing +
  the per-row `values`/`error` projection) moved to a new pure module,
  `frontend/src/dock/importPreviewRows.ts`, with its own unit test.** Not
  listed in the plan's Files table, but required to make Expected Behaviour
  item 12's "unit-testable for the slicing" claim actually true:
  `ImportRowsDialog.ts` imports DOM-touching library components (`Dialog`,
  `FileDropZone`, `Table`, ...) at module scope, which have no stand-in
  under this project's node vitest — the same constraint documented on
  `tableWriteRules.ts`, whose own extraction from `TableWorkPanel.ts` this
  mirrors.

- **`from_import_scalar` no longer folds `JSON_ARRAY` into the same
  `json.loads`-on-string rule as `JSON`.** The plan's own Internal Structure
  coercion table lists `JSON, JSON_ARRAY` together with one rule, but its
  Non-Goals section explicitly rules out array-literal parsing for
  `JSON_ARRAY` ("no established CSV/JSON-cell convention... no array-literal
  parsing is attempted"), and its Potential Challenges section says the same
  ("`from_wire_value` has no `JSON_ARRAY` case today... Import intentionally
  does not exercise this path for CSV... confirm `from_import_scalar`'s
  `JSON_ARRAY` handling for JSON-sourced rows (passthrough) doesn't
  accidentally break this existing fallback"). The shipped code initially
  followed the table literally, which an audit round caught: it let a CSV
  cell's (or any string's) JSON-parseable text through as a native list for
  an array column — silently wrong for anything but the simplest element
  type, since neither this function nor `from_wire_value` does the
  per-element coercion a real Postgres array (`numeric[]`, `timestamp[]`,
  ...) would need. Fixed to match the Non-Goals/Potential-Challenges intent
  instead of the table: `JSON_ARRAY` now passes through only an already-native
  Python `list` (the JSON-sourced case the plan says must keep working) and
  raises for anything else, including CSV text that happens to be valid JSON
  array syntax.

- **`frontend/src/data/buildModel.ts`'s previously-private `toFields` helper
  is now exported** and reused by `ImportRowsDialog.ts` to build the preview
  grid's per-column fields — not listed in the plan's Files table, but a
  direct instance of the Internal Structure's own "via the same
  `WIRE_TO_FIELD` map `buildModel.ts` already uses" instruction: `toFields`
  *is* that map's field-building wrapper, so reusing it (rather than
  re-deriving the same name/type/order logic a second time) is the more
  precise reading of "the same map," not a new pattern.
