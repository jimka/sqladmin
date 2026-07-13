# DDL Structural Editing — Shared Infrastructure — Implementation Plan

## Overview

This plan lays the **shared foundation** for DDL structural editing in SQLAdmin: creating, altering, and dropping database objects through structured dialogs whose generated SQL is shown in an editable preview before it runs. It builds **no object-specific forms** — those are four later phases (see _Downstream Phases_). What it delivers is the seams every phase reuses: a server-side DDL SQL-builder module, a preview operation base, a single shared execute operation + route, the wire contract, the reusable preview/confirm dialog, the `api.ts` client methods, and the navigator/refresh integration points.

The backend already executes arbitrary DDL via [`RunQueryCommand`](backend/app/operations/run_query.py#L118) behind [`POST /api/{connection_id}/query`](backend/app/main.py#L576), quotes identifiers with [`quote_ident`](backend/app/sql/compiler.py#L21), and qualifies tables with [`qualified`](backend/app/operations/common.py#L12). The CQRS `Operation`/`Query`/`Command` contract lives in [`base.py`](backend/app/operations/base.py). The frontend reaches introspection through the typed fetch client [`api.ts`](frontend/src/data/api.ts), routes object actions through [`SqlAdminController`](frontend/src/SqlAdminController.ts), and builds modal forms on `@jimka/typescript-ui`'s `Dialog` (see [`FilterDialog.ts`](frontend/src/dock/FilterDialog.ts), [`LoginDialog.ts`](frontend/src/shell/LoginDialog.ts)).

The whole DDL feature is delivered as a phased set of plans; this is the foundation the others cite by filename.

---

## Downstream Phases

Four later plans build on this one and reference it by filename. Each adds its object-specific SQL builders (in `backend/app/sql/ddl.py`), preview operations (subclasses of `DdlPreview`), preview routes, dialog forms (embedded in the shared `SqlPreviewDialog`), and navigator actions — all reusing the single execute op/route and dialog defined here:

- `table-ddl.md` — CREATE / ALTER / DROP TABLE, columns, constraints, indexes.
- `view-matview-ddl.md` — CREATE / ALTER / DROP VIEW and MATERIALIZED VIEW, REFRESH.
- `schema-sequence-ddl.md` — CREATE / DROP SCHEMA, CREATE / ALTER / DROP SEQUENCE.
- `function-type-ddl.md` — CREATE / DROP FUNCTION, CREATE / DROP TYPE / DOMAIN.

---

## Architecture Decisions

### Server-side SQL generation, editable preview is authoritative at execute

SQL is **generated server-side** — a pure builder layer (`backend/app/sql/ddl.py`) called by dedicated per-object **preview operations** that validate identifiers with `quote_ident` and return the SQL string. This single-sources correct quoting/validation on the server rather than duplicating a DDL string-builder in TypeScript.

The product decision fixes the flow as *form → editable SQL preview → confirm → execute*, and the preview is **editable**. That forces the resolution of the central design question: **execute runs the previewed SQL string, not a spec re-compiled at execute time.** Re-deriving SQL from the structured form at execute would silently discard the user's edits to the preview, contradicting "review/edit → confirm". So the previewed string is authoritative at execute, and generation is single-sourced in the *preview/build* step.

Consequently the execute path is **one shared operation** — `ExecuteDdlCommand(conn, sql)` — that wraps the final SQL in a `Command` transaction and returns a status envelope. Every phase reuses it; no phase writes its own execute op.

**Rejected alternative — a `preview: true` flag on a per-object execute op that rebuilds SQL from the spec.** It keeps generation single-sourced but *ignores the edited preview text* (execute rebuilds from the spec), breaking the editable-preview product decision. Rejected on that basis.

**Rejected alternative — reuse the existing `/query` route for execute** (the "compile-only endpoint, run through `/query`" option). Functionally it works — `RunQueryCommand` already runs DDL — but it conflates DDL execution with the free-form query panel: no dedicated seam for later gating/instrumentation, a rows-or-status classifier where DDL only ever wants status, and a route named `query` carrying structural mutations. A dedicated `ExecuteDdlCommand` + `/ddl/execute` route is a thin wrapper (it reuses `run_query._affected` for the status tag) that gives DDL its own namespaced, CSRF-guarded seam later phases hang off. Chosen.

### Preview operations may introspect; base carries the two-phase shape

Some previews are pure (build SQL from the spec alone); others need a read first (e.g. ALTER TABLE previews that must know a table's existing columns). So `DdlPreview` is a `Query` subclass honoring the standard three-phase contract ([base.py](backend/app/operations/base.py)): `__init__` validates the spec, `apply()` performs any read I/O the subclass needs and calls the subclass's `build()` to set `self._sql`, and `get_result()` returns `{"sql": self._sql}`. A pure preview simply does its `build()` with no I/O in `apply()`. This mirrors how the row ops separate validation from I/O and keeps previews unit-testable by hand-setting `_sql` (as `test_run_query.py` hand-sets `_attrs`).

### Trust model: identifiers quoted, expressions passed through, authz is your grants

SQLAdmin is a "log in as a Postgres role, authz = your grants" tool ([README](README.md#L5)) with no app user store. The DDL trust posture follows the existing [`RunQueryCommand` posture](backend/app/operations/run_query.py#L5): the connected role can already run arbitrary SQL through the query panel, so DDL grants it **no capability it lacks** — Postgres enforces object ownership and `CREATE`/`ALTER`/`DROP` privileges and raises on violation.

Given that, the validation seam is:
- **Identifiers** (schema/table/column/type *names* the form collects) are always double-quoted via `quote_ident` in the builder — never interpolated raw. This is correctness (spaces, keywords, mixed case) and defense-in-depth, exactly as the filter/order compilers already do.
- **Raw type strings, defaults, and check/SQL expressions** (`numeric(10,2)`, `now()`, `age > 0`) **cannot be parameterized or quoted as identifiers** — they are SQL fragments by nature. They are inserted into the generated SQL as the user typed them, then shown in the **editable preview the user must confirm**. The preview *is* the review gate: the user sees and approves the exact text before it runs. This is acceptable because the role can already execute any SQL; a malformed fragment fails at execute and surfaces through the existing error handler.
- **Object existence / column validity** is not pre-checked in the builder except where a preview naturally introspects (ALTER paths); otherwise Postgres raises (e.g. `DROP TABLE` of a missing table → 400 via [`_pg_error_handler`](backend/app/main.py#L133)).

### Privilege gating: rely on Postgres, surface the error — no pre-flight UI gate

Row CRUD gates its toolbar on [`TablePrivilegesQuery`](backend/app/operations/table_privileges.py) because it must grey out cell editing *before* the user acts. DDL privilege checks are far broader (ownership, `CREATE` on schema, `USAGE`, role membership) and Postgres's own answer is authoritative and already mapped: a denied DDL raises a `PostgresError` → 400 with its `{detail}` → the dialog surfaces it and stays open for a retry/edit. **Recommendation: do not pre-flight DDL privileges in the UI.** DDL launch actions are offered unconditionally on navigator nodes; a lacking privilege produces a clear server error on Execute. This is the simplest correct posture and matches the tool's "your grants are the authz" model. (Later phases may still hide obviously-inapplicable actions, e.g. no "Refresh" on a plain view — that is object-kind gating, not privilege gating.)

---

## Public API

### Backend — `backend/app/sql/ddl.py` (new, pure)

The shared DDL SQL-builder module. Infra ships only cross-object primitives; each phase adds its own builder functions here.

```python
def qualify(schema: str, name: str) -> str:
    """Schema-qualified, double-quoted object name: "schema"."name"."""
    # returns f'{quote_ident(schema)}.{quote_ident(name)}'

def quote_literal(value: str) -> str:
    """Single-quote a string literal for a DDL fragment (e.g. a COMMENT body),
    escaping embedded quotes. NOT for identifiers (use quote_ident) and NOT a
    substitute for a bound parameter — DDL cannot bind params."""
    # returns "'" + value.replace("'", "''") + "'"
```

`quote_ident` is re-exported from `sql.compiler` (import it in `ddl.py`; do not duplicate). `qualify` generalizes [`operations/common.qualified`](backend/app/operations/common.py#L12) (which is `TableRef`-specific) to any `(schema, name)` — the row ops keep using `common.qualified`; DDL uses `ddl.qualify`.

### Backend — `backend/app/operations/ddl.py` (new)

```python
class DdlPreview(Query):
    """Base for a DDL preview op: validate spec in __init__, optionally read in
    apply(), set self._sql via build(), return {"sql": ...} from get_result().
    Subclasses (added by later phases) implement build() and any apply() reads."""

    _sql: str | None  # set by build()

    async def apply(self) -> None:
        """Default: pure preview — just build(). A subclass that needs a read
        overrides apply() to fetch, then calls self.build()."""

    def build(self) -> None:
        """Set self._sql to the generated DDL. Subclass responsibility."""
        raise NotImplementedError

    def get_result(self) -> dict:
        """{"sql": self._sql}. Raises RuntimeError if called before apply()/build()."""


class ExecuteDdlCommand(Command):
    """Run one final (possibly user-edited) DDL statement and return a status
    envelope. The single shared execute op for every DDL phase."""

    def __init__(self, conn: asyncpg.Connection, sql: str) -> None:
        """Capture the SQL, raising ValidationError if empty/whitespace-only
        (mirrors RunQueryCommand.__init__)."""

    async def apply(self) -> None:
        """Execute the statement inside `async with self._conn.transaction()`,
        capturing the command status tag."""

    def get_result(self) -> dict:
        """{"kind": "status", "command": <tag>, "rowCount": <affected>} — the
        same status envelope RunQueryCommand emits, reusing run_query._affected."""
```

Both are exported from [`operations/__init__.py`](backend/app/operations/__init__.py) and added to `__all__`.

### Backend — routes in `backend/app/main.py`

```
POST /api/{connection_id}/ddl/execute      Depends(require_csrf)   body {"sql": str}
    -> {"kind": "status", "command": str, "rowCount": int}
```

The **shared execute route** — all phases use it. Preview routes are **per-phase** and follow this documented pattern (a phase adds one such route per preview op it introduces):

```
POST /api/{connection_id}/{database}/ddl/<object-op>[/…]   Depends(require_csrf)
    body: the phase's structured spec        -> {"sql": str}
```

`require_csrf` on both (preview is a POST that names structural intent; keep it session+CSRF-guarded for symmetry, even though it does not mutate). Namespacing keeps the `ddl/` segment right after `{connection_id}` (execute, connection-wide) or after `{database}` (preview, object-scoped), consistent with the existing `/api/{connection_id}/query` and `/api/{connection_id}/{database}/{schema}/…` shapes.

### Frontend — `frontend/src/data/api.ts`

```ts
/** Run a final (possibly edited) DDL statement; returns the status envelope. */
export function executeDdl(connectionId: string, sql: string): Promise<QueryStatusResult>;
```

Preview client methods are **per-phase** (their bodies differ per object) and follow this pattern, reusing the module-private `postJson`:

```ts
// A phase adds, e.g.:
export function previewCreateTable(ref: DbObjectRef, spec: CreateTableSpec): Promise<DdlPreview>;
//   -> postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/create-table`, spec)
```

### Frontend — `frontend/src/contract.ts`

```ts
/** The preview endpoints' response: the generated DDL SQL to show in the editor. */
export interface DdlPreview {
    sql: string;
}
```

Execute returns the existing [`QueryStatusResult`](frontend/src/contract.ts#L79) — reused, not redefined.

### Frontend — `frontend/src/dock/SqlPreviewDialog.ts` (new)

The reusable form + editable-SQL-preview + Cancel/Execute dialog every phase embeds its form into.

```ts
export interface SqlPreviewDialogOptions {
    title: string;                          // e.g. "Create table"
    form: Component;                        // the phase's structured form (top area)
    /** Generate the SQL for the form's current state (the phase's preview call).
     *  Rejections surface in the dialog; the editor is left as-is. */
    generateSql: () => Promise<string>;
    /** Execute the (possibly edited) SQL from the editor. Resolves the status. */
    execute: (sql: string) => Promise<QueryStatusResult>;
    /** Called after a successful execute so the caller can refresh + report. */
    onSuccess: (result: QueryStatusResult) => void;
    /** Report an execute/preview error (defaults to a Notification if omitted). */
    onError?: (message: string) => void;
    width?: number;
}

/** Open the shared DDL preview/confirm dialog. */
export function openSqlPreviewDialog(options: SqlPreviewDialogOptions): void;
```

---

## Internal Structure

### `SqlPreviewDialog` composition (library idioms)

- **Layout:** a `Panel` (`VBox`, `stretching: true`) stacking `options.form` over a `CodeEditor(sql, { language: "sql" })` (the editable SQL area — NOT `readOnly`, unlike the Explain plan editor). Import `CodeEditor` from `@jimka/typescript-ui/component/editor` (path confirmed in [QueryPanel.ts:49](frontend/src/dock/QueryPanel.ts#L49)).
- **Preview refresh:** the form fires a change signal → the dialog `await`s `generateSql()` and sets the editor text. Debounce/explicit trigger is the phase's choice; infra calls `generateSql()` once on open to seed the editor. A "Regenerate SQL" affordance re-runs it (discarding manual edits) — offered because manual edits and form edits both write the same editor.
- **Buttons:** `Dialog` exposes exactly three result codes `"confirm" | "cancel" | "close"`, and **every dismiss gesture (Escape, backdrop, the always-present title-bar close) resolves to `"close"`** (see [FilterDialog.ts:164](frontend/src/dock/FilterDialog.ts#L164) and memory _tsui Dialog always dismissable_). So: **Execute** = `{ result: "confirm", primary: true }`, **Cancel** = `{ result: "close" }` (shares the dismiss code, so dismissing == Cancel == do nothing). No third code is needed.
- **Execute is not a simple resolve-and-done:** a failed execute must keep the dialog open so the user can fix the SQL and retry. `Dialog.show()` resolves once, so model the retry as a loop (re-show after a failed execute) — the same shape [`showLoginDialog`](frontend/src/shell/LoginDialog.ts#L199) uses to re-prompt after a failed login. On `"confirm"`: call `execute(editor.getValue())`; on success → `onSuccess(result)` and stop; on failure → surface the error and re-show. On `"close"` → stop (no execution).
- **Disposal:** `CodeEditor` holds a CodeMirror view + ThemeManager subscription with no cascading dispose ([QueryPanel.ts:40](frontend/src/dock/QueryPanel.ts#L40)); the dialog must `editor.dispose()` (or the editor's documented disposer) when it finally closes, in a `finally`.
- **Keydown scope:** if the dialog wires any subtree keyboard handling around the editor, use `Event.addSubtreeListener` — plain `addListener` misses `CodeEditor` keydowns (memory _tsui event subtree listener_; see [refreshTool.ts:34](frontend/src/shell/refreshTool.ts#L34)). Infra needs none by default; noted for phases.
- **Sizing:** lean on `Dialog`/`resizeToContent` defaults (memory _Prefer library defaults_); do not pin fixed heights. Pass a sensible `width` default (mirror `FilterDialog`'s `DIALOG_WIDTH = 500` order of magnitude — document the constant).

### `ExecuteDdlCommand.apply()` shape (mirrors RunQueryCommand)

```python
async with self._conn.transaction():
    self._status = await self._conn.execute(self._sql)   # DDL returns a status tag
```

`get_result()` returns `{"kind": "status", "command": self._status or "", "rowCount": _affected(self._status)}`, importing `_affected` from `run_query` (do not re-implement the tag parser).

---

## Ordered Implementation Steps

1. **`backend/app/sql/ddl.py`** — new module. Re-import `quote_ident` from `.compiler`; add `qualify(schema, name)` and `quote_literal(value)` per _Public API_, each with a docstring per the repo's Python doc convention. Pure functions, no DB.

2. **`backend/tests/test_ddl_sql.py`** — new. Unit-test `qualify` (quoting, embedded quotes/dots), `quote_literal` (embedded single-quote doubling). Follow the `test_compiler.py` pure-function style.

3. **`backend/app/operations/ddl.py`** — new module. Add `DdlPreview(Query)` and `ExecuteDdlCommand(Command)` per _Public API_/_Internal Structure_. `ExecuteDdlCommand.__init__` raises `ValidationError("Empty DDL statement")` on blank SQL; `apply()` runs it in a transaction; `get_result()` returns the status envelope via `run_query._affected`. `DdlPreview.get_result()` raises `RuntimeError` if `_sql` is unset.

4. **`backend/app/operations/__init__.py`** — import and add `DdlPreview`, `ExecuteDdlCommand` to `__all__`.

5. **`backend/tests/test_execute_ddl.py`** — new. Following the `NO_CONN` pure-logic style ([conftest.py](backend/tests/conftest.py)): `ExecuteDdlCommand(NO_CONN, "   ")` raises `ValidationError`; `get_result()` before `apply()` raises `RuntimeError`; hand-set `_status = "CREATE TABLE"` → `{"kind": "status", "command": "CREATE TABLE", "rowCount": 0}`; `_status = "DROP TABLE"` likewise. Add a tiny in-test `DdlPreview` subclass whose `build()` sets `_sql`, asserting `get_result()` returns `{"sql": ...}` and that pre-build `get_result()` raises.

6. **`backend/app/main.py`** — add the shared execute route `POST /api/{connection_id}/ddl/execute` with `Depends(require_csrf)`, body `dict = Body(...)`, resolving the pool via `session_pool_for`, constructing `ExecuteDdlCommand(c, body.get("sql", ""))`, `await op.apply()`, `return op.get_result()`. Place it in a new `# --- DDL --------` section near the `# --- Arbitrary SQL ---` block. Import `ExecuteDdlCommand` in the operations import group.

7. **`frontend/src/contract.ts`** — add the `DdlPreview` interface (per _Public API_).

8. **`frontend/src/data/api.ts`** — add `executeDdl(connectionId, sql)` calling `postJson<QueryStatusResult>(\`/api/${connectionId}/ddl/execute\`, { sql })`. Import `QueryStatusResult` from `../contract` (extend the existing type import block). Document the per-phase preview method pattern in a comment above it (no preview method ships in infra).

9. **`frontend/src/dock/SqlPreviewDialog.ts`** — new. Implement `openSqlPreviewDialog(options)` per _Public API_/_Internal Structure_: build the `VBox` panel (form + editable `CodeEditor`), the `Dialog` (Execute `confirm` primary + Cancel `close`), seed the editor via `generateSql()`, run the show/execute/retry loop, dispose the editor in `finally`. Use `Dialog.error`/`Notification` for surfacing errors (as `LoginDialog` does).

10. **`frontend/src/data/api.test.ts` (or the co-located api unit test)** — add a `executeDdl` fetch-shape test if the suite covers `api.ts` (check for an existing `api` test first; if none, skip — `api.ts` is a thin fetch layer). The `SqlPreviewDialog`'s DOM behavior is manual-verify (the node harness can't drive `CodeEditor`/focus — see _Verification_).

11. **Navigator + refresh seam (documentation-only in infra; wiring lands per-phase).** No source change here beyond what phases add, but the seam is pinned in this plan so phases don't re-derive it:
    - **Launching DDL dialogs:** phases add items to the existing context menus in [`NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts#L107) (the `contextmenu` handler already branches by `ref.kind` — database/schema/relation), each item calling a new `SqlAdminController` method (e.g. `controller.createTable(ref)`) that builds the phase's form and calls `openSqlPreviewDialog`. Toolbar actions on work panels (e.g. [`TableWorkPanel`](frontend/src/dock/TableWorkPanel.ts)) follow the same call-into-controller shape.
    - **Refresh after success:** on `onSuccess`, the controller must invalidate the affected navigator branch and any open panels. The navigator reloads its top level via [`NavigatorTree.refresh()`](frontend/src/navigator/NavigatorTree.ts#L195); lazy schema/object levels reload on next expansion. There is **no per-branch cache-invalidation API today** — the `Tree` caches loaded children. So the pragmatic infra recommendation is: after a create/drop that changes a schema's object list, call the navigator's `refresh()` (full reload) — correct if coarse. A finer per-node reload is a `Tree` library gap to note, not to build here. Object-list reads in [`api.ts`](frontend/src/data/api.ts#L146) are un-cached (each call re-fetches), so no app-level cache needs busting — only the `Tree`'s in-memory node cache.

12. **Regression checkpoints:**
    - `grep -rn "ExecuteDdlCommand\|DdlPreview" backend/app/operations/__init__.py` — expect both exported.
    - `cd backend && poetry run pytest tests/test_ddl_sql.py tests/test_execute_ddl.py` — green.
    - `grep -rn "/ddl/execute" backend/app/main.py frontend/src/data/api.ts` — expect one route + one client.
    - `cd frontend && npm run typecheck` — clean.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Create | `backend/app/sql/ddl.py` |
| Create | `backend/app/operations/ddl.py` |
| Create | `backend/tests/test_ddl_sql.py` |
| Create | `backend/tests/test_execute_ddl.py` |
| Create | `frontend/src/dock/SqlPreviewDialog.ts` |
| Modify | `backend/app/operations/__init__.py` (export `DdlPreview`, `ExecuteDdlCommand`) |
| Modify | `backend/app/main.py` (add `POST /api/{connection_id}/ddl/execute`) |
| Modify | `frontend/src/contract.ts` (add `DdlPreview` interface) |
| Modify | `frontend/src/data/api.ts` (add `executeDdl`, document preview pattern) |

---

## Expected Behaviour

Backend (unit-testable via the `NO_CONN` pattern unless noted):

- `qualify("public", "my table")` → `"public"."my table"`; `qualify('s"x', "t")` → `"s""x"."t"`.
- `quote_literal("a'b")` → `'a''b'`.
- `ExecuteDdlCommand(NO_CONN, "")` and `(NO_CONN, "   ")` raise `ValidationError`.
- `ExecuteDdlCommand.get_result()` before `apply()` raises `RuntimeError`.
- With `_status = "CREATE TABLE"` → `{"kind": "status", "command": "CREATE TABLE", "rowCount": 0}`; with `_status = "DROP TABLE"` → `rowCount 0`, `command "DROP TABLE"`.
- A `DdlPreview` subclass whose `build()` sets `_sql = "CREATE …"`: `get_result()` → `{"sql": "CREATE …"}`; before build → `RuntimeError`.
- **(Integration, manual/DB)** `POST /api/default/ddl/execute` with `{"sql": "CREATE TABLE public.t_ddl_smoke (id int)"}` → 200 `{"kind":"status","command":"CREATE TABLE","rowCount":0}`; a follow-up `DROP TABLE` likewise. A denied statement (no privilege) → 400 with the Postgres `{detail}`; a syntactically bad statement → 400. Missing/invalid CSRF → 403.

Frontend (`SqlPreviewDialog` behavior is **manual-verify** — the node harness cannot drive `CodeEditor`, focus, or the modal):

- Opening seeds the editor with `generateSql()`'s SQL.
- Editing the SQL then pressing **Execute** sends the **edited** text to `execute` (not a regenerated string).
- **Execute success** calls `onSuccess(result)` and closes the dialog.
- **Execute failure** surfaces the error and leaves the dialog open with the SQL intact for a retry/edit.
- **Cancel**, Escape, backdrop click, and the title-bar close all dismiss without executing.
- The editor is disposed when the dialog finally closes.
- `executeDdl` (unit-testable if the api suite exists): POSTs `{ sql }` to `/api/{conn}/ddl/execute` with the CSRF header, and rejects with the backend `{detail}` on a non-OK response (inherits `postJson`'s behavior).

---

## Verification

- **Backend unit:** `cd backend && poetry run pytest tests/test_ddl_sql.py tests/test_execute_ddl.py` (and the full `poetry run pytest` for no regressions).
- **Backend integration (manual, DB up):** with `docker compose up -d db` and the app running, exercise `POST /api/default/ddl/execute` per the integration cases above (create then drop a throwaway table; a denied/bad statement; a missing-CSRF call).
- **Frontend:** `cd frontend && npm run typecheck && npm test`. The `SqlPreviewDialog` DOM flow is manual — since infra ships no form that opens it, verify it by a temporary throwaway caller or defer the live smoke test to the first consuming phase (`table-ddl.md`), noting the dialog is exercised there. State this explicitly so `/implement` doesn't expect an automated UI test.
- **Grep invariants** per step 12.

---

## Potential Challenges

- **Editable preview vs. regeneration race:** manual SQL edits and form-driven regeneration write the same editor; a form change after a manual edit overwrites it. Mitigation: infra seeds once and offers an explicit "Regenerate SQL"; phases decide whether their form auto-regenerates. Documented, not hidden.
- **`CodeEditor` disposal leak:** forgetting `editor.dispose()` leaks a CodeMirror view + ThemeManager subscription. Mitigation: dispose in the dialog's `finally` (pinned in _Internal Structure_).
- **Coarse navigator refresh:** a full `NavigatorTree.refresh()` after every DDL collapses the tree. Mitigation: acceptable for infra; a per-branch `Tree` reload is a noted library gap, not built here.
- **Dialog dismiss semantics:** wiring Cancel to a non-`close` code would let a dismiss gesture diverge from Cancel. Mitigation: Cancel carries `close` (matches `FilterDialog`), so all no-execute exits share one path.

---

## Critical Files

- [`backend/app/operations/base.py`](backend/app/operations/base.py) — the `Operation`/`Query`/`Command` three-phase contract the DDL ops implement.
- [`backend/app/operations/run_query.py`](backend/app/operations/run_query.py) — the status envelope + `_affected` tag parser `ExecuteDdlCommand` reuses; the DDL trust-model precedent.
- [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) — `quote_ident`, re-used by `ddl.py`.
- [`backend/app/operations/common.py`](backend/app/operations/common.py) — `qualified` (the `TableRef` analogue `qualify` generalizes).
- [`backend/app/main.py`](backend/app/main.py) — route namespacing, `require_csrf`, pool resolution, the `_pg_error_handler` DDL errors surface through.
- [`backend/tests/conftest.py`](backend/tests/conftest.py) + [`test_run_query.py`](backend/tests/test_run_query.py) — the `NO_CONN` pure-logic test style the new tests follow.
- [`frontend/src/dock/FilterDialog.ts`](frontend/src/dock/FilterDialog.ts) + [`frontend/src/shell/LoginDialog.ts`](frontend/src/shell/LoginDialog.ts) — the `Dialog` result-code idiom and the show/retry loop `SqlPreviewDialog` mirrors.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — `CodeEditor` construction/disposal reference.
- [`frontend/src/data/api.ts`](frontend/src/data/api.ts) — `postJson`/`csrfHeader` the `executeDdl` client reuses.
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) + [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — the context-menu launch seam and `refresh()` after-success seam.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — class-first component pattern for `SqlPreviewDialog`.

---

## Non-Goals

- **No object-specific DDL forms, specs, builders, preview ops, or routes.** CREATE/ALTER/DROP for tables, views/matviews, schemas/sequences, functions/types are the four downstream phases. Infra ships only the shared base op, the single execute op/route, the SQL-builder module skeleton, the reusable dialog, and the client/contract seam.
- **No per-branch navigator cache invalidation.** Infra recommends a full `refresh()` after a mutating DDL; a finer `Tree` reload API is a noted library gap, out of scope.
- **No UI privilege pre-flighting for DDL.** Actions launch unconditionally; Postgres enforces and the error surfaces (see _Architecture Decisions_).
- **No multi-statement DDL scripts.** Like `RunQueryCommand`, one statement per execute (the extended-query protocol rejects `;`-scripts); batched multi-object operations are out of scope for infra.
- **No change to the existing `/query` route or `RunQueryCommand`.** DDL gets its own dedicated seam; the query panel is untouched.
