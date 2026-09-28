---
touches-shared:
  - backend/app/errors.py
  - backend/app/main.py
  - backend/app/operations/common.py
  - frontend/src/data/api.ts
  - frontend/src/contract.ts
  - frontend/src/dock/QueryPanel.ts
  - README.md
---

# Query Error Position Reveal — Implementation Plan

## Overview

When an ad-hoc statement fails in the query panel, jump the editor to the spot Postgres reported and highlight it, using typescript-ui 0.10.0's `CodeEditor.revealRange` ([CodeEditor.ts:1245](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L1245)). The error banner also gains a `(line X, column Y)` suffix, so the location stays readable after the highlight clears.

The backend already receives the location: every asyncpg `PostgresError` carries `position`, a 1-based character offset into the query string the server parsed. Today [`_pg_error_handler` (main.py:109)](backend/app/main.py#L109) keeps only `str(exc)`. This plan adds an optional `position` field to the error body, emitted only by the two routes whose SQL is the user's own text: `POST /query` ([RunQueryCommand](backend/app/operations/run_query.py#L123)) and `POST /explain` ([ExplainQueryCommand](backend/app/operations/explain_query.py#L108)). On the frontend, [api.ts](frontend/src/data/api.ts#L101) throws a typed `ApiError` carrying that position. A new pure module converts it to an editor line/column. [QueryPanel.ts](frontend/src/dock/QueryPanel.ts#L817) reveals it on a failed Run or Explain.

`revealRange` is new in typescript-ui 0.10.0, which is released. The main tree's `frontend/node_modules/@jimka/typescript-ui` is a symlink to the local library checkout, which serves the same 0.10.0 code, and the app typechecks against it unchanged. `package.json` still names `^0.9.0`. That mismatch is expected and is not touched here; the range moves in the manual dependency swap the user runs by hand (see `typescript-ui-0-10-0-upgrade.md`, Addendum: Post-release swap).

---

## Architecture Decisions

### Position is attached where client SQL runs, not in the global handler — mirrors `auth.py`

`RunQueryCommand.apply` and `ExplainQueryCommand.apply` wrap their SQL execution in a new context manager, `client_sql_errors(prefix_length)`, in [operations/common.py](backend/app/operations/common.py). It catches `asyncpg.PostgresError` and re-raises the typed `DomainError` (`from exc`), with `position` set. The global `_pg_error_handler` keeps handling every other route and never emits `position`.[^opt-in-position]

The precedent is [`login` in auth.py:258-276](backend/app/auth.py#L258). It catches asyncpg errors inside the operation and re-raises a typed `DomainError` `from err`, and the one `DomainError` handler renders it.

### The Conflict-vs-BadRequest choice moves into `errors.py`

A new `from_postgres_error(exc, position=None)` in [errors.py](backend/app/errors.py) holds the rule `_pg_error_handler` has today: an integrity violation becomes `ConflictError` (409), anything else becomes `BadRequest` (400). Both `_pg_error_handler` and `client_sql_errors` call it. That way an `INSERT` in the query panel that hits a unique violation still returns 409.[^translation-home]

### `position` rides on `DomainError`, like `headers` already does

`DomainError.__init__` gains a keyword-only `position: int | None = None`, stored as `self.position`. [`_domain_error_handler` (main.py:99)](backend/app/main.py#L99) adds `"position"` to the body **only when it is not `None`**. Every existing error body stays byte-for-byte `{"detail": ...}`.[^absent-not-null]

The precedent is `headers` ([errors.py:18](backend/app/errors.py#L18)). It is the one existing non-`detail` payload a `DomainError` carries, and the same handler renders it.

### Explain shifts the position past its own prefix

`ExplainQueryCommand` runs `f"EXPLAIN ({options}) {sql}"`, so Postgres counts from the start of that prefix. `client_sql_errors(len(prefix))` subtracts the prefix length. A position that lands inside the prefix (result `< 1`) is dropped, not clamped, because that text is not the user's.

| `prefix` | Postgres `position` | Emitted `position` |
|---|---|---|
| `"EXPLAIN (FORMAT TEXT) "` (22 chars) | `23` | `1` |
| same | `30` | `8` |
| same | `22` | *(omitted)* |
| `""` (Run) | `8` | `8` |

### Frontend errors become an `ApiError`, a subclass of `Error`

`getJson`, `postJson`, and `whoami` in [api.ts](frontend/src/data/api.ts#L116) throw `ApiError extends Error`. Its `message` is still the backend's `detail`, and it has a `readonly position?: number`. Every existing consumer (`error.message`, `errorMessage()`, `ErrorBanner.show`) keeps working unchanged.

The precedent is [`PanelLoadError extends Error` (panelHost.ts:67)](frontend/src/controller/panelHost.ts#L67): a typed `Error` subclass with readonly fields, told apart with `instanceof`.

### Offset → line/column conversion lives in a pure module, in UTF-16 columns

New [frontend/src/data/sqlErrorPosition.ts](frontend/src/data/sqlErrorPosition.ts) exports `locateSqlError(documentText, sentStart, position)`. It has no DOM and no library import, so it is unit-tested under the node vitest. This mirrors [historyCursor.ts](frontend/src/data/historyCursor.ts), QueryPanel's other pure helper.

Three conversions matter:

- **Characters vs. UTF-16.** Postgres counts characters (Unicode code points). JS strings and `revealRange` count UTF-16 code units, where a character above U+FFFF (an emoji) is two units. The module walks code points and advances 2 units for each one above `0xFFFF`.[^utf16-columns]
- **Trimming.** QueryPanel sends `editor.getValue().trim()`, not the raw editor text, so the sent SQL starts `sentStart` units into the document. QueryPanel passes `sentStart = text.length - text.trimStart().length`. Trailing trim needs no correction, because offsets count from the start.
- **Line breaks.** `CodeEditor.getValue()` returns CodeMirror's `doc.toString()`, which always joins lines with `"\n"`. So `"\n"` is the only line break the module counts.

Worked cases (these are also the unit tests):

| Editor text | Postgres `position` | Result `{line, column, length}` | Why |
|---|---|---|---|
| `SELEC 1` | 1 | `{1, 1, 5}` | `SELEC` is an identifier run |
| `\n  SELECT id\n  FROM nosuch_table` | 18 | `{3, 8, 12}` | `sentStart` = 3 (one `\n` + two spaces); position 18 counts from `SELECT` |
| `SELECT '😀', nosuch FROM t` | 13 | `{1, 14, 6}` | `😀` is 1 character for Postgres but 2 UTF-16 units; ignoring that gives column 13 (the space) |
| `SELECT (1` | 10 | `{1, 10, 0}` | "at end of input" points one past the text; zero length = caret, no highlight |
| `SELECT (1\n\n` | 10 | `{1, 10, 0}` | the offset lands on the trimmed trailing `\n`; a line break has zero token length |
| `SELECT 1` | 99 | `{1, 9, 0}` | out of range: clamped to the document end |

### Highlight length is the token at the position

Postgres reports a single point, not a range. `locateSqlError` computes `length` from the text at that offset. Most Postgres messages name that token ("at or near "FORM"", "relation "x" does not exist"), and a one-character highlight is easy to miss.

| Text starting at the offset | `length` | Rule |
|---|---|---|
| `FORM t` | 4 (`FORM`) | a run of identifier characters `[\p{L}\p{N}_$]` |
| `"Order Items" x` | 13 (`"Order Items"`) | from a `"` or `'` to the matching closing quote on the same line |
| `'it''s' ...` | 7 (`'it''s'`) | a doubled quote inside the quotes is escaped, not the end |
| `'abc` then `\n` | 4 (`'abc`) | an unterminated quote runs to the end of the line |
| `, 2)` | 1 (`,`) | any other character is one character (1 unit, or 2 for a surrogate pair) |
| end of text, or `\n` | 0 | nothing to highlight |

### Reveal only while the editor still holds the text that was sent

`run()` and `runExplainRun()` take one `const text = editor.getValue()` snapshot at submit. They compute the location against `text`. On failure they call `revealRange` only if `editor.getValue() === text`. If the user typed while the request was in flight, the banner still shows the `(line, column)` of what was sent, but the editor is not moved.[^stale-guard]

### `revealRange` options: default focus, `scrollAlign: "center"`, default highlight

The call is `editor.revealRange(location, { scrollAlign: "center" })`. Focus moves into the editor, which `run()` already does after every run via `Component.afterNextLayout(() => editor.focus())` ([QueryPanel.ts:997](frontend/src/dock/QueryPanel.ts#L997)). The range is selected, so typing replaces the offending token. `"center"` keeps the lines around the error visible in a long query.[^center]

Clearing the highlight needs no app code. The library clears it on any document change and on any user caret move ([CodeEditor.ts:386-420](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L386)). The error banner keeps its current lifetime: it stays until dismissed, a new Run starts, or Clear is pressed.

### Run shows banner + reveal; Explain reveals only

A failed Run shows the banner with the `(line X, column Y)` suffix and reveals. A failed Explain / Explain Analyze reveals but keeps today's toast-only reporting (no banner). The notification toast (`onError`) keeps the plain backend message on both paths.[^explain-scope]

---

## Public API

Backend — [backend/app/errors.py](backend/app/errors.py):

```python
class DomainError(Exception):
    status_code: int = 400

    def __init__(
        self, detail: str, headers: dict[str, str] | None = None, *, position: int | None = None
    ) -> None: ...
    # new attribute
    position: int | None   # 1-based character offset into the SQL the request body carried


def from_postgres_error(exc: asyncpg.PostgresError, position: int | None = None) -> DomainError: ...
```

Backend — [backend/app/operations/common.py](backend/app/operations/common.py):

```python
def client_sql_position(exc: asyncpg.PostgresError, prefix_length: int = 0) -> int | None: ...

@contextlib.contextmanager
def client_sql_errors(prefix_length: int = 0) -> Iterator[None]: ...
```

Frontend — [frontend/src/contract.ts](frontend/src/contract.ts):

```ts
/** The body of every non-OK response the app's own error handlers render. */
export interface ApiErrorBody {
    detail: string;
    /** 1-based character offset into the SQL the request sent; only from POST /query and /explain. */
    position?: number;
}
```

Frontend — [frontend/src/data/api.ts](frontend/src/data/api.ts):

```ts
export class ApiError extends Error {
    constructor(message: string, readonly position?: number);
}
```

Frontend — new [frontend/src/data/sqlErrorPosition.ts](frontend/src/data/sqlErrorPosition.ts):

```ts
export interface SqlErrorLocation {
    line: number;    // 1-based
    column: number;  // 1-based, UTF-16 code units (CodeEditor's convention)
    length: number;  // UTF-16 code units; 0 = caret only
}

export function locateSqlError(documentText: string, sentStart: number, position: number): SqlErrorLocation;
export function formatSqlErrorMessage(message: string, location: SqlErrorLocation): string;
```

`SqlErrorLocation` has the same shape as the library's `CodeEditorRevealTarget`, so it passes straight to `revealRange` with no conversion and no library type import.

---

## Implementation

### `client_sql_position` / `client_sql_errors` (operations/common.py)

```python
def client_sql_position(exc: asyncpg.PostgresError, prefix_length: int = 0) -> int | None:
    raw = getattr(exc, "position", None)   # asyncpg stores the protocol's 'P' field as a str

    if raw is None:
        return None

    try:
        shifted = int(raw) - prefix_length
    except (TypeError, ValueError):
        return None

    return shifted if shifted >= 1 else None


@contextlib.contextmanager
def client_sql_errors(prefix_length: int = 0) -> Iterator[None]:
    try:
        yield
    except asyncpg.PostgresError as exc:
        raise from_postgres_error(exc, client_sql_position(exc, prefix_length)) from exc
```

Place `with client_sql_errors(...)` **outside** the `async with self._conn.transaction():` block. That way the transaction sees the original driver error and rolls back first, and only then is the error translated. Only `PostgresError` is caught. `ValidationError`, `_ExplainDone`, and `RuntimeError` pass through untouched.

### `from_postgres_error` (errors.py)

```python
def from_postgres_error(exc: asyncpg.PostgresError, position: int | None = None) -> DomainError:
    if isinstance(exc, asyncpg.exceptions.IntegrityConstraintViolationError):
        return ConflictError(str(exc), position=position)

    return BadRequest(str(exc), position=position)
```

`_pg_error_handler` becomes `return await _domain_error_handler(request, from_postgres_error(exc))`.

### `_domain_error_handler` body

```python
content: dict = {"detail": exc.detail}

if exc.position is not None:
    content["position"] = exc.position

return JSONResponse(status_code=exc.status_code, content=content, headers=exc.headers)
```

### Explain wiring

```python
options = _explain_options(self._analyze, self._verbose, self._fmt)
prefix  = f"EXPLAIN ({options}) "
stmt    = prefix + self._sql

with client_sql_errors(len(prefix)):
    if self._analyze:
        ...   # existing try / async with transaction / _ExplainDone block, unchanged
    else:
        self._plan = await self._conn.fetch(stmt)

# existing FORMAT JSON decode stays after (outside) the with-block
```

### `readError` (api.ts) — replaces `readDetail`

```ts
async function readError(response: Response): Promise<ApiError> {
    try {
        const body = await response.json() as Partial<ApiErrorBody> | null;

        if (body && typeof body.detail === "string") {
            const position = isValidPosition(body.position) ? body.position : undefined;

            return new ApiError(body.detail, position);
        }
    } catch {
        // Body was not JSON; fall through to the status line.
    }

    return new ApiError(`${response.status} ${response.statusText}`);
}
```

`isValidPosition(value: unknown): value is number` returns `typeof value === "number" && Number.isInteger(value) && value >= 1`. It is a module-private helper in api.ts. The three throw sites (`getJson` line 121, `postJson` line 136, `whoami` line 183) become `throw await readError(response);`.

### `locateSqlError` (sqlErrorPosition.ts)

```ts
// The highest code point UTF-16 stores in one unit (the end of the Basic
// Multilingual Plane); anything above it is a surrogate pair — two units.
// Fixed by the UTF-16 encoding itself, not tunable.
const MAX_BMP_CODE_POINT = 0xFFFF;

// Characters that continue an identifier-like token for the highlight: letters,
// digits, underscore, and `$` (Postgres allows `$` inside identifiers).
const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

export function locateSqlError(documentText: string, sentStart: number, position: number): SqlErrorLocation {
    const offset = advanceCodePoints(documentText, sentStart, position - 1);
    const lines  = documentText.slice(0, offset).split("\n");

    return {
        line  : lines.length,
        column: lines[lines.length - 1].length + 1,
        length: tokenLength(documentText, offset),
    };
}
```

- `advanceCodePoints(text, start, count): number` steps `count` code points from `start`. Each step adds 2 if `text.codePointAt(index)! > MAX_BMP_CODE_POINT`, else 1. It stops at `text.length` and returns the UTF-16 index.
- `tokenLength(text, offset): number` applies the table in *Highlight length is the token at the position*. It is split into `identifierRunLength` and `quotedRunLength` helpers, and a code-point-width helper for the single-character case.
- `formatSqlErrorMessage(message, location)` returns `` `${message} (line ${location.line}, column ${location.column})` ``.
- The splits keep each function short, per the decomposition convention. All helpers except the two exports stay module-private.

### QueryPanel wiring (two local functions inside the constructor, next to `setBusy`)

```ts
/**
 * The editor location a failed run/explain's error points at, or null when
 * the backend reported no position (a runtime error, a network failure, an
 * error inside a called function).
 */
function failureLocation(error: unknown, text: string): SqlErrorLocation | null {
    if (!(error instanceof ApiError) || error.position === undefined) {
        return null;
    }

    // run()/runExplainRun() send text.trim(), so Postgres counts from the
    // first non-whitespace character of the editor text.
    const sentStart = text.length - text.trimStart().length;

    return locateSqlError(text, sentStart, error.position);
}

/** Select + highlight `location` — only while the editor still holds `text`, the text that was sent. */
function revealFailure(location: SqlErrorLocation, text: string): void {
    const unchanged = editor.getValue() === text;

    if (unchanged) {
        editor.revealRange(location, { scrollAlign: "center" });
    }
}
```

`run()` (currently [QueryPanel.ts:817-858](frontend/src/dock/QueryPanel.ts#L817)):

```ts
const text = editor.getValue();
const sql  = text.trim();
// ... unchanged ...
} catch (error) {
    if (seq === runSeq) {
        const location = failureLocation(error, text);
        const message  = error instanceof Error ? error.message : String(error);

        onError(error);
        errorBanner.show(location ? formatSqlErrorMessage(message, location) : error);

        if (location) {
            revealFailure(location, text);   // after the banner: its relayout resizes the editor first
        }

        onRun?.({ sql, timestamp: Date.now(), ok: false, rowCount: 0 });
    }
}
```

`runExplainRun()` (currently [QueryPanel.ts:867-912](frontend/src/dock/QueryPanel.ts#L867)) gets the same `text` / `sql` split. Its catch becomes:

```ts
if (seq === runSeq) {
    const location = failureLocation(error, text);

    onError(error);

    if (location) {
        revealFailure(location, text);
    }
}
```

---

## Ordered Implementation Steps

1. **Worktree prep.** In the implementing worktree, symlink `frontend/node_modules` to the main tree's (`ln -s /home/jika/typescript/sqladmin/frontend/node_modules <worktree>/frontend/node_modules`). Check: `readlink -f <worktree>/frontend/node_modules/@jimka/typescript-ui` ends in `typescript-ui/packages/lib`, and `grep '"version"'` in its `package.json` shows `0.10.0`.
2. **Backend tests first (red).** Add the backend cases from *Expected Behaviour* B1–B11. Put the helper tests in a new `backend/tests/test_client_sql_errors.py`. Add the handler cases to [tests/test_routes.py](backend/tests/test_routes.py#L302) beside the existing driver-error cases. Add the apply-wiring cases to `tests/test_run_query.py` and `tests/test_explain_query.py`, each with a small `_FailingConn` fake. Follow the `_FakeConn` style in [test_type_definition.py:19](backend/tests/test_type_definition.py#L19). The fake has `transaction()` returning `contextlib.nullcontext()`, and async `prepare`/`fetch` that record the SQL and raise the seeded error. Run `cd backend && poetry run python -m pytest` (never bare `pytest` in a worktree). Expect failures.
3. **`backend/app/errors.py`.** Add `import asyncpg`, the `position` keyword to `DomainError.__init__` (docstring `Args:` entry), and `from_postgres_error`. Update the module docstring's `(status, {"detail": ...})` sentence to mention the optional `position`.
4. **`backend/app/main.py`.** Make `_domain_error_handler` emit `position` when set. Make `_pg_error_handler` delegate to `from_postgres_error(exc)`, keeping its docstring's point that this route-agnostic path never carries a position. Update the module docstring's `(status, {detail})` phrase. Check: `grep -n "IntegrityConstraintViolationError" backend/app/main.py` → zero matches.
5. **`backend/app/operations/common.py`.** Add `import contextlib`, `import asyncpg`, `from typing import Iterator`, `from_postgres_error` to the `..errors` import, and the two helpers with Google-style docstrings. Update the module docstring to "Helpers shared across the operations" or similar, since it now covers error translation too.
6. **`backend/app/operations/run_query.py`.** Wrap the `async with self._conn.transaction():` block in `apply()` with `with client_sql_errors():`. Add to the `apply` docstring a `Raises:` entry for `BadRequest`/`ConflictError` carrying `position`. In the module docstring, change the multi-statement sentence's "(surfaced as 400 by the app's error handler)" to say it surfaces as a 400 with a position.
7. **`backend/app/operations/explain_query.py`.** Split `stmt` into `prefix` + SQL and wrap the execution block as shown in *Implementation → Explain wiring*. Add a one-line note to the module docstring that error positions are shifted past the prefix.
8. **`backend/app/endpoints/query.py`.** In the `run_query` and `explain_query` docstrings, note that a Postgres error returns `{"detail", "position"?}`, where `position` counts from the start of the submitted `sql`. `execute_ddl` is unchanged.
9. **Backend green.** `poetry run python -m pytest` passes in full. Check: the existing `test_syntax_error_becomes_400_bad_request` still asserts exactly `{"detail": "bad"}`.
10. **Frontend tests first (red).** Create `frontend/tests/data/sqlErrorPosition.test.ts` covering F1–F13. Extend [tests/data/api.test.ts](frontend/tests/data/api.test.ts#L348) with F14–F17 in the `runQuery` / `runExplain` describe blocks. `cd frontend && npm test` → the new cases fail.
11. **`frontend/src/contract.ts`.** Add `ApiErrorBody`, placed near the top after `DbObjectRef`.
12. **`frontend/src/data/api.ts`.** Import `ApiErrorBody`. Add `ApiError` and `isValidPosition`. Replace `readDetail` with `readError` and update the three throw sites. Update the file's header comment (it says the client "reads the backend's error body ({detail})") to mention `ApiError`/`position`. Check: `grep -n "readDetail\|new Error(" frontend/src/data/api.ts` → zero matches.
13. **`frontend/src/data/sqlErrorPosition.ts`.** Create it with a header comment in the style of `historyCursor.ts`: what it is, that it is pure and node-testable, and the three conversions (characters → UTF-16, trim offset, `\n`-only lines). Add JSDoc on every function. `npm test` → F1–F17 green.
14. **`frontend/src/dock/QueryPanel.ts`.** Import `ApiError` from `../data/api`, and `locateSqlError`, `formatSqlErrorMessage`, `type SqlErrorLocation` from `../data/sqlErrorPosition`. Add `failureLocation` and `revealFailure` as local functions right after `setBusy`. Change `run()` and `runExplainRun()` as shown. Extend the header comment's "Errors funnel to onError, a 3-second toast, and a durable in-panel error banner…" paragraph with one sentence: when the backend reports a position, the banner adds `(line X, column Y)` and Run/Explain select and highlight that spot, provided the editor text is unchanged. Extend the `RunQuery` type's JSDoc ([QueryPanel.ts:122](frontend/src/dock/QueryPanel.ts#L122)) to note that it rejects with an `ApiError` whose `position` may be set. Keep every other line of the file untouched.
15. **Frontend checks.** `cd frontend && npm run typecheck && npm test`. Check: `grep -n "revealRange" frontend/src/dock/QueryPanel.ts` → exactly one match (inside `revealFailure`).
16. **README.** Add one sentence to the "SQL workspace" Highlights bullet: a failed query or `EXPLAIN` jumps the editor to the position Postgres reported and highlights it.
17. **Manual verification** — M1–M10 below, against the linked 0.10.0 build (the `verify` skill drives the app).

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/errors.py` |
| Modify | `backend/app/main.py` |
| Modify | `backend/app/operations/common.py` |
| Modify | `backend/app/operations/run_query.py` |
| Modify | `backend/app/operations/explain_query.py` |
| Modify | `backend/app/endpoints/query.py` (docstrings only) |
| Create | `backend/tests/test_client_sql_errors.py` |
| Modify | `backend/tests/test_routes.py` |
| Modify | `backend/tests/test_run_query.py` |
| Modify | `backend/tests/test_explain_query.py` |
| Modify | `frontend/src/contract.ts` |
| Modify | `frontend/src/data/api.ts` |
| Create | `frontend/src/data/sqlErrorPosition.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Create | `frontend/tests/data/sqlErrorPosition.test.ts` |
| Modify | `frontend/tests/data/api.test.ts` |
| Modify | `README.md` |

---

## Expected Behaviour

### Backend (unit-testable, pytest, no database)

Build errors as `exc = asyncpg.PostgresSyntaxError("msg"); exc.position = "8"`. asyncpg stores the field as a string.

| # | Case | Expected |
|---|---|---|
| B1 | `client_sql_position(exc with position "8")` | `8` |
| B2 | `client_sql_position(exc with no position)` | `None` |
| B3 | `client_sql_position(exc "23", prefix_length=22)` | `1` |
| B4 | `client_sql_position(exc "22", prefix_length=22)` | `None` (points into the prefix) |
| B5 | `client_sql_position(exc "abc")` | `None` |
| B6 | `with client_sql_errors(): raise PostgresSyntaxError` (position "8") | raises `BadRequest`, `.detail == "msg"`, `.position == 8`, `__cause__` is the original |
| B7 | `with client_sql_errors(): raise UniqueViolationError` (no position) | raises `ConflictError`, `.position is None` |
| B8 | `with client_sql_errors(): raise ValidationError("x")` | the same `ValidationError` propagates untouched |
| B9 | `_domain_error_handler(BadRequest("bad", position=8))` | status 400, body `{"detail": "bad", "position": 8}` |
| B10 | existing `_pg_error_handler` tests | bodies still exactly `{"detail": ...}` — no `position` key even when the driver error has one (add a case: `PostgresSyntaxError` with position "8" → body `{"detail": "bad"}`) |
| B11 | `RunQueryCommand(conn, "SELEC 1").apply()` with `prepare` raising position "1" | raises `BadRequest` with `.position == 1`. `ExplainQueryCommand(conn, "SELEC 1", analyze=False, fmt="text").apply()` with `fetch` raising position "23" (prefix `"EXPLAIN (FORMAT TEXT) "`, 22 chars) → `.position == 1`. The same with `analyze=True` goes through `transaction()` and has prefix `"EXPLAIN (ANALYZE, FORMAT TEXT) "` (31 chars): `fetch` raising position "32" → `.position == 1`. In each case assert the fake recorded `prefix + sql` as the executed text. |

### Frontend pure module (unit-testable, vitest, node)

`locateSqlError(text, sentStart, position)`, where each test computes `sentStart` as `text.length - text.trimStart().length`, the same way QueryPanel does:

| # | `text` | `position` | Expected |
|---|---|---|---|
| F1 | `SELEC 1` | 1 | `{ line: 1, column: 1, length: 5 }` |
| F2 | `\n  SELECT id\n  FROM nosuch_table` | 18 | `{ line: 3, column: 8, length: 12 }` |
| F3 | `SELECT '😀', nosuch FROM t` | 13 | `{ line: 1, column: 14, length: 6 }` |
| F4 | `SELECT (1` | 10 | `{ line: 1, column: 10, length: 0 }` |
| F5 | `SELECT (1\n\n` | 10 | `{ line: 1, column: 10, length: 0 }` |
| F6 | `SELECT 1` | 99 | `{ line: 1, column: 9, length: 0 }` (clamped) |
| F7 | `SELECT * FROM "Order Items" x` | 15 | `length: 13` |
| F8 | `SELECT 'it''s' ,` | 8 | `length: 7` |
| F9 | `SELECT 'abc\nFROM t` | 8 | `length: 4` (unterminated quote stops at line end) |
| F10 | `SELECT 1, , 2` | 11 | `length: 1` |
| F11 | `SELECT 😀` | 8 | `length: 2` (one surrogate-pair character) |
| F12 | `SELECT 1 FROM t WHERE 😀x = 1` | 24 | `{ line: 1, column: 25, length: 1 }` — `x` is character 24 but UTF-16 index 24 (column 25), because `😀` before it counts as 2 units |

| # | Case | Expected |
|---|---|---|
| F13 | `formatSqlErrorMessage('syntax error at or near "FORM"', { line: 2, column: 1, length: 4 })` | `'syntax error at or near "FORM" (line 2, column 1)'` |
| F14 | `runQuery` non-OK with body `{ detail: "bad", position: 8 }` | rejects with an `ApiError` whose `message === "bad"` and `position === 8`, and `instanceof Error` |
| F15 | `runQuery` non-OK with body `{ detail: "bad" }` | `ApiError`, `position === undefined` |
| F16 | non-OK with `position: 0`, `-3`, `2.5`, or `"8"` | `position === undefined` (not a valid 1-based integer) |
| F17 | non-OK with a non-JSON body (status 502) | `ApiError` with message `"502 Bad Gateway"`, `position === undefined` |

### Manual verification (UI: focus, selection, highlight, scrolling — not unit-testable)

Run each in a fresh query tab of the running app:

| # | Steps | Expected |
|---|---|---|
| M1 | Type `SELEC 1`, click **Run** | Toast + banner `syntax error at or near "SELEC" (line 1, column 1)`. `SELEC` selected and highlighted with the accent flash. Focus in the editor (typing replaces `SELEC`). |
| M2 | Enter the F2 text (leading blank line, 2-space indent), Ctrl+Enter | Banner ends `(line 3, column 8)`. `nosuch_table` highlighted. |
| M3 | `SELECT '😀', nosuch FROM (SELECT 1) s`, Run | `nosuch` highlighted exactly (not the space before it). |
| M4 | `SELECT (1`, Run | Banner ends `(line 1, column 10)`. Caret at the end, no highlight. |
| M5 | `SELECT 1/0`, Run | Banner shows `division by zero` with no suffix. Editor caret/selection unchanged. |
| M6 | After M1, type one character | Highlight clears immediately. Banner stays. |
| M7 | After M1, click elsewhere in the editor | Highlight clears (caret move). |
| M8 | `SELEC 1`, Ctrl+E (Explain), then Ctrl+Shift+E on `SELECT nosuch FROM (SELECT 1) s` | Toast only (no banner), with the offending token highlighted each time. Positions are correct despite the server-side `EXPLAIN (…)` prefix. |
| M9 | A 40-line query with an error on line 35, editor scrolled to the top, Run | Editor scrolls so line 35 sits mid-viewport, highlighted. |
| M10 | DevTools → Network → throttle "Slow 3G". Run `SELEC 1` and type a character before the response arrives | Banner shows `(line 1, column 1)`. Editor **not** moved or highlighted (text changed since submit). |

Also check one other `api.ts` error surface for regressions: open any DDL preview (e.g. a table's Drop), edit the SQL to `DROP TABLEX foo`, and click Execute. The dialog's banner and the notification show the plain Postgres message exactly as before, with no suffix and no reveal.

---

## Verification

- `cd backend && poetry run python -m pytest` — full suite green, including B1–B11.
- `cd frontend && npm run typecheck && npm test` — green, including F1–F17.
- `grep -n "readDetail\|new Error(" frontend/src/data/api.ts` → no matches.
- `grep -rn "position" backend/app/main.py` → only inside `_domain_error_handler` and docstrings.
- `grep -n "client_sql_errors" backend/app/operations/*.py` → the definition in `common.py`, plus exactly one use each in `run_query.py` and `explain_query.py`.
- Manual M1–M10 in the running app against the symlinked 0.10.0 build.

---

## Documentation Impact

No library-facing or exported-API docs. In-repo only:

- `README.md` "SQL workspace" bullet — one sentence (step 16).
- Module/docstring updates in `errors.py`, `main.py`, `operations/common.py`, `run_query.py`, `explain_query.py`, `endpoints/query.py`, `api.ts`, and `QueryPanel.ts`'s header comment (steps 3–8, 12, 14).

---

## Potential Challenges

- **`revealRange` exists only in 0.10.0.** Against a registry `^0.9.0` install, typecheck fails on `editor.revealRange`. Confirm the symlink (step 1) before debugging anything else; do not bump `package.json`.
- **An `SQL_ASCII` database.** Postgres counts bytes, not characters, there, so a non-ASCII character before the error shifts the highlight right. `revealRange` clamps, so nothing throws. This is accepted, not fixed (see Non-Goals).
- **Stale highlight after a successful re-run without touching the editor.** For example: fix the schema in another tab, come back, click Run. The old highlight stays until the next caret move or edit, because the library has no "clear highlight" call that leaves the caret alone. If this bothers you during M-checks, log it as a `LIBRARY_NOTES.md` papercut rather than working around it in the app.
- **Two markers for one mistake.** The live lint underline (a separate decoration from `lint: true`) and the reveal highlight can point at different places. For `SELECT count(* FROM t`, lint marks the `;`/end while Postgres reports `FROM`. Both are expected. See [LIBRARY_NOTES.md](LIBRARY_NOTES.md)'s top entry on unclosed-paren diagnostics; do not try to merge them.
- **A fast failure before the first layout.** On a first Run, `refreshDataTab` selects a lazy Data tab whose focus move is deferred to the next layout. If the error arrives before that layout, the tab strip briefly takes focus, then `afterNextLayout(() => editor.focus())` returns it. Selection and highlight are unaffected, because focusing does not touch either.

---

## Critical Files

- [backend/app/auth.py:258-276](backend/app/auth.py#L258) — precedent: catch asyncpg errors in the operation, re-raise a typed `DomainError` `from err`.
- [backend/app/errors.py](backend/app/errors.py) — `DomainError`, and its `headers` precedent for extra payload.
- [backend/app/main.py:99-122](backend/app/main.py#L99) — both exception handlers.
- [backend/app/operations/run_query.py:123](backend/app/operations/run_query.py#L123), [backend/app/operations/explain_query.py:108](backend/app/operations/explain_query.py#L108) — the two `apply()` methods.
- [backend/tests/test_routes.py:302-320](backend/tests/test_routes.py#L302), [backend/tests/test_type_definition.py:19](backend/tests/test_type_definition.py#L19) — handler test style; `_FakeConn` style.
- [frontend/src/data/api.ts:101-137](frontend/src/data/api.ts#L101) — `readDetail`/`getJson`/`postJson`.
- [frontend/src/controller/panelHost.ts:67](frontend/src/controller/panelHost.ts#L67) — `PanelLoadError`, the `Error`-subclass precedent.
- [frontend/src/data/historyCursor.ts](frontend/src/data/historyCursor.ts) — pure-module header/test style.
- [frontend/src/dock/QueryPanel.ts:817-912](frontend/src/dock/QueryPanel.ts#L817) — `run()` / `runExplainRun()`.
- [typescript-ui CodeEditor.ts:100-160, 386-420, 1218-1277](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L100) — `CodeEditorRevealTarget`/`Options`, highlight-clearing rules, `revealRange` (note: `column`/`length` are UTF-16 units, clamped against the live doc).

---

## Non-Goals

- **`SqlPreviewDialog` and the definition editors.** No reveal there, and `/ddl/execute` emits no `position`.[^ddl-out]
- **`internal_position` / `internal_query`, `hint`, `detail`.** An internal position points into a function body or other server-side text, not the editor. Surfacing Postgres's `HINT`/`DETAIL` lines in the banner is a separate UI change.
- **An Explain error banner.** Explain keeps its toast-only error reporting.
- **Run-selection or statement splitting.** Neither exists today. `locateSqlError`'s `sentStart` parameter is the place a future run-selection feature passes the selection start.
- **Byte-counting `SQL_ASCII` databases.** Not corrected (see Potential Challenges).
- **Any library change or version bump.** `package.json` keeps `^0.9.0` until the manual dependency swap the user runs by hand (see `typescript-ui-0-10-0-upgrade.md`, Addendum: Post-release swap).
- **Emitting `position` from routes that run server-generated SQL.** Row CRUD, catalog reads, and DDL previews do not emit it; the position would point into text the client never saw.

---

## Notes

[^opt-in-position]: Emitting `position` from the global `_pg_error_handler` was rejected. That handler serves every route: row CRUD, catalog introspection, DDL previews. For those, `position` indexes SQL the backend generated and the client never saw, which is a misleading contract. It would also be wrong for `/explain`, whose position includes the server-added `EXPLAIN (…)` prefix. Only the operation knows whether its SQL is the client's text and how much prefix it added, so the operation opts in.

[^translation-home]: Putting the translation in `errors.py` keeps "which status does a driver error get" in one function shared by both paths. The alternative, a second `isinstance` ladder inside `client_sql_errors`, would let the two drift. `errors.py` gaining an `asyncpg` import is acceptable: it is still a leaf module, and main.py's docstring already describes `errors.py` as "the single place a status is chosen".

[^absent-not-null]: The success-contract precedent (`ColumnMeta.to_contract`'s `sequence`) always includes a key, as `null` when empty. That was not followed for the error body. Every error from every route would gain `"position": null`, which changes all existing error bodies and their exact-body tests (`test_integrity_violation_becomes_409_conflict`, `test_syntax_error_becomes_400_bad_request`) for no consumer benefit. The frontend treats a missing key and an invalid value the same way (`position === undefined`).

[^utf16-columns]: The PostgreSQL protocol docs define the `P` field as "an index into the original query string. The first character has index 1, and positions are measured in characters not bytes." `CodeEditorRevealTarget.column`/`length` are, per the implementation (`line.from + column - 1` on CodeMirror's UTF-16 document), UTF-16 units, matching `CodeEditorCursorPosition`'s documented convention. The banner's displayed column uses the same UTF-16 column, so it agrees with any future cursor readout built on `getCursorPosition()`. It differs from a character count only when an astral character (an emoji) precedes the error on the same line.

[^stale-guard]: `revealRange` clamps a stale position rather than throwing. But a clamped position in edited text highlights the wrong token, which is worse than no highlight. The request is short, so the guard rarely fires, but a slow network or a long-running statement makes it reachable. Comparing the whole string is cheap for query-sized text and needs no change tracking.

[^center]: `"nearest"` (the default) scrolls the minimum. For an error just off-screen, that leaves the error on the viewport's edge with no lines around it. The query editor is typically ~150px tall with a result pane showing, so context matters. Most ad-hoc queries fit on screen, where neither option scrolls at all. The horizontal side of `"center"` only acts on long lines, and CodeMirror clamps the scroll at the line start, so short lines are unaffected.

[^explain-scope]: Explain runs the same editor text through the same backend error path, and a typo caught by Ctrl+E is as common as one caught by Run. The backend already has to know its prefix length, and the frontend change is one call in the catch. Adding a banner to Explain would change its established error UX, which is out of this plan's scope.

[^ddl-out]: `SqlPreviewDialog` has an editable `CodeEditor` and an `ErrorBanner` too, so it is the natural follow-up. It is left out to keep this change inside the query panel. The dialog is also still function-based (see COMPONENT_CONVENTIONS.md (g)). The definition editors send SQL wrapped in generated `CREATE OR REPLACE …` text, so their positions would need a per-surface prefix mapping. Adding `/ddl/execute` later is one `with client_sql_errors():` in `ExecuteDdlCommand.apply` plus the same frontend helpers.
