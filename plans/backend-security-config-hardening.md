---
touches-shared: [backend/app/config.py, backend/app/auth.py, backend/app/connections.py, backend/app/contract.py, backend/app/main.py]
---

# Backend Security & Config Hardening — Implementation Plan

## Overview

Four independent backend defects, all in the session/auth/config layer, fixed as one pass because they share the same files and the same three test modules.

**One.** Two boolean environment-variable parsers disagree. [`config.py:30`](backend/app/config.py#L30)'s `_FALSEY` set does not recognize `"off"`, and it backs only `allow_user_presets()`; [`config.py:36-37`](backend/app/config.py#L36)'s `_TRUE_VALUES`/`_FALSE_VALUES` pair does recognize `"off"`, and it backs `parse_bool()` — which in turn backs `enable_docs()` and [`auth.py:108`](backend/app/auth.py#L108)'s `cookie_secure`. So `SQLADMIN_ENABLE_DOCS=off` is off, but `ALLOW_USER_PRESETS=off` silently stays **on**, contradicting [`README.md:210`](README.md#L210) and [`backend/README.md:33-34`](backend/README.md#L33).

**Two.** [`auth.py:249-259`](backend/app/auth.py#L249) catches five named exception types with no trailing catch-all, and [`auth.py:260-262`](backend/app/auth.py#L260) records a failed attempt only for `DomainError`. Four real `asyncpg.PostgresError` subclasses fall outside those tuples — `InsufficientPrivilegeError` (no `CONNECT` grant), `TooManyConnectionsError`, `ClientCannotConnectError`, `ProtocolViolationError`. Each reaches the generic driver handler at [`main.py:177-185`](backend/app/main.py#L177), returns **400 with Postgres's own message verbatim**, and never counts toward the 10-attempt lockout.

**Three and four** are both in the export route. [`main.py:1609`](backend/app/main.py#L1609) interpolates the URL-derived `{schema}`/`{table}` straight into the `Content-Disposition` filename, though a Postgres identifier may contain `"`, a CR/LF, or any Unicode character. And [`export_rows.py:28`](backend/app/operations/export_rows.py#L28)'s `_VALID_FORMATS` and [`main.py:1554`](backend/app/main.py#L1554)'s `_EXPORT_MEDIA` independently name the same format set, with the route indexing the second unguarded after the first has already gated the request.

Alongside these, the plan adds `backend/tests/test_connections.py` (the session/pool-lifetime core has no dedicated test module today), removes the dead `Session.host` field, and corrects two module docstrings that describe a superseded earlier phase of the app.

`backend/app/main.py` changes are confined to one import line, the deletion of the module-level `_EXPORT_MEDIA` constant, and three lines inside the existing `export_rows` route (two statements plus its docstring's `Returns:`). No route is registered, moved, or renamed, so the later route-registration restructure carries these edits into its new file layout unchanged.

---

## Architecture Decisions

### One boolean parser for every flag

`allow_user_presets()` is rewritten as `parse_bool(os.environ.get(_ALLOW_USER_PRESETS_ENV)) is not False`, and `_FALSEY` is deleted. The `is not False` comparison preserves the flag's "on unless explicitly disabled" default: `parse_bool` returns `None` for both unset and unrecognized input, and only a recognized false spelling returns `False`.[^one-parser]

| `ALLOW_USER_PRESETS` | `parse_bool` | `allow_user_presets()` |
|---|---|---|
| unset | `None` | `True` |
| `on` / `1` / `true` / `yes` | `True` | `True` |
| `off` / `0` / `false` / `no` | `False` | `False` — **`off` is the fix** |
| `OFF` (any case) | `False` | `False` |
| `anything` | `None` | `True` (unrecognized falls back to the default) |

No warning is logged for an unrecognized value.[^no-warning]

### The login route gets an `asyncpg.PostgresError` catch-all

A fifth `except` clause is appended after the three existing ones, catching `asyncpg.PostgresError`. It logs the driver text server-side and raises `Unauthorized("Login failed")`, which the enclosing `except DomainError` already routes through `record_login_failure`. `PostgresError` is the right width: it covers every server-side rejection, present and future, while a bug in SQLAdmin's own code (a `TypeError`, a `KeyError`) still surfaces as a 500 instead of being disguised as a failed login.[^catch-all-width]

Clause order matters: `asyncpg.CannotConnectNowError` is itself a `PostgresError`, so the existing "Cannot reach database" clause must stay above the catch-all.

| Failure at `create_session` | Response | Counts toward the lockout |
|---|---|---|
| `InvalidPasswordError` | 401 `Invalid credentials` | yes (already) |
| `InvalidCatalogNameError` | 401 `Cannot open target database` | yes (already) |
| `OSError` / `CannotConnectNowError` | 401 `Cannot reach database` | yes (already) |
| `InsufficientPrivilegeError` | 401 `Login failed` | yes — **new** |
| `TooManyConnectionsError` | 401 `Login failed` | yes — **new** |
| `ClientCannotConnectError` | 401 `Login failed` | yes — **new** |
| `ProtocolViolationError` | 401 `Login failed` | yes — **new** |

### `EXPORT_MEDIA` is the single format registry, and lives in `export_format.py`

The `{format: (media type, extension)}` map moves out of `main.py` into [`backend/app/export_format.py`](backend/app/export_format.py#L1) as a public `EXPORT_MEDIA`. `ExportRowsQuery` derives its accepted set from it (`_VALID_FORMATS = frozenset(EXPORT_MEDIA)`), and the route reads media type and extension from the same map. Adding a format becomes a one-line edit in one place.[^media-home]

### `Content-Disposition` is built by a pure function, in both RFC 6266 forms

`export_format.py` gains `content_disposition(schema, table, ext)`. It emits a sanitized ASCII `filename` fallback (every character outside `A-Za-z0-9._-` replaced with `_`) **and** a percent-encoded `filename*=UTF-8''…` carrying the exact name. This mirrors [`sql/compiler.py:26-30`](backend/app/sql/compiler.py#L26)'s `quote_ident`: a one-purpose pure escaper for a hostile-input context, living in its layer's pure module with a dedicated test file.[^both-forms]

| `schema` | `table` | `ext` | Header value |
|---|---|---|---|
| `public` | `customers` | `csv` | `attachment; filename="public.customers.csv"; filename*=UTF-8''public.customers.csv` |
| `public` | `say "hi"\r\nX-Evil: 1` | `csv` | `attachment; filename="public.say__hi___X-Evil__1.csv"; filename*=UTF-8''public.say%20%22hi%22%0D%0AX-Evil%3A%201.csv` |
| `public` | `naïve` | `json` | `attachment; filename="public.na_ve.json"; filename*=UTF-8''public.na%C3%AFve.json` |

The fallback can never be empty: `ext` comes from `EXPORT_MEDIA` and is always `csv` or `json`.

### `test_connections.py` fakes the pool rather than dialing Postgres

The new test module follows [`backend/tests/test_rate_limit.py`](backend/tests/test_rate_limit.py#L27): stand-in objects exposing only what the code under test reads, direct assertions against the module-global registry, and a "pure logic" / "route" split. `asyncpg.create_pool` is patched per test through `monkeypatch`, the same seam [`test_auth.py:192`](backend/tests/test_auth.py#L192) already uses for `create_session`. A module-local autouse fixture clears `connections._sessions` before and after each test, copying the shape of `conftest.py`'s `_reset_login_rate_limit`.[^module-local-fixture]

---

## Public API

`backend/app/export_format.py` (new exports):

```python
# {format: (media type, file extension)} — the one registry of supported formats.
EXPORT_MEDIA: dict[str, tuple[str, str]]

def content_disposition(schema: str, table: str, ext: str) -> str:
    """Build the export's Content-Disposition header value from unsanitized identifiers."""
```

`backend/app/connections.py` (field removed):

```python
# `host: str` is deleted — written once by create_session, read nowhere.
@dataclass
class Session:
    id: str
    connection_id: str
    csrf_token: str
    pool: asyncpg.Pool
    username: str
    database: str
    last_seen: float
```

`backend/app/config.py` — `allow_user_presets() -> bool` keeps its signature; only its parsing changes. `_FALSEY` is deleted.

`backend/app/main.py` — `_EXPORT_MEDIA` is deleted (replaced by the imported `EXPORT_MEDIA`).

---

## Internal Structure

### `backend/app/export_format.py` additions

New imports at the top of the module: `import re` and `from urllib.parse import quote`.

```python
# The media type and file extension per supported export format. The single
# source of truth for what "supported" means: ExportRowsQuery derives its
# accepted-format set from these keys, so the validation and the route's
# media/extension lookup can never name different sets.
EXPORT_MEDIA: dict[str, tuple[str, str]] = {
    "csv": ("text/csv", "csv"),
    "json": ("application/json", "json"),
}

# Characters kept verbatim in the ASCII fallback filename; every other character
# — a double quote, a CR/LF, a non-ASCII letter — becomes "_". Deliberately
# narrow: the fallback only has to be a legal HTTP quoted-string, and the
# filename* form carries the exact name for every browser in current use.
_FILENAME_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")


def content_disposition(schema: str, table: str, ext: str) -> str:
    """
    Build the export response's ``Content-Disposition`` header value.

    Schema and table names are Postgres identifiers, so they may hold a double
    quote, a CR/LF, or any Unicode character — none of which may reach a header
    verbatim. The value therefore carries both forms RFC 6266 allows: a
    sanitized ASCII ``filename`` fallback, and a percent-encoded ``filename*``
    preserving the exact name.

    Args:
        schema: the relation's schema name, unsanitized.
        table: the relation's name, unsanitized.
        ext: the file extension for the chosen format (an ``EXPORT_MEDIA`` value).

    Returns:
        The full header value, e.g. ``attachment; filename="public.customers.csv";
        filename*=UTF-8''public.customers.csv``.
    """
    name = f"{schema}.{table}.{ext}"
    ascii_name = _FILENAME_UNSAFE.sub("_", name)
    encoded = quote(name, safe="")
    fallback = f'filename="{ascii_name}"'
    exact = f"filename*=UTF-8''{encoded}"

    return f"attachment; {fallback}; {exact}"
```

### `backend/app/operations/export_rows.py`

```python
from ..export_format import EXPORT_MEDIA, csv_header, csv_row, json_close, json_open, json_row

# The export formats this operation supports, derived from the media registry so
# the two can never name different sets; anything else is a client error.
_VALID_FORMATS = frozenset(EXPORT_MEDIA)
```

The constructor's error message stops hardcoding the format names:

```python
        if fmt not in _VALID_FORMATS:
            expected = " or ".join(sorted(_VALID_FORMATS))

            raise ValidationError(f"Unsupported export format: {fmt!r} (expected {expected})")
```

### `backend/app/main.py` export route

Delete the `_EXPORT_MEDIA` definition and its comment ([`main.py:1553-1554`](backend/app/main.py#L1553)), add one import beside the existing `.config` import, and change two lines in the route body:

```python
from .export_format import EXPORT_MEDIA, content_disposition
```

```python
    # Safe to index unguarded: ExportRowsQuery's constructor (above) validates
    # `format` against the keys of this very map.
    media, ext = EXPORT_MEDIA[format]
```

```python
        headers={"Content-Disposition": content_disposition(schema, table, ext)},
```

### `backend/app/auth.py` login route

The new clause goes last, after the `OSError`/`CannotConnectNowError` clause and before `except DomainError`:

```python
        except asyncpg.PostgresError as err:
            # Catch-all for every other server-side rejection: no CONNECT grant,
            # max_connections reached, a protocol violation. Without it these
            # reach main.py's generic driver handler as a 400 carrying Postgres's
            # own message, and never count toward the login rate limit.
            _logger.warning("Login rejected by Postgres: %s", err)

            raise Unauthorized("Login failed") from err
```

### `backend/tests/test_connections.py` fakes

```python
class _FakeConn:
    """A stand-in connection recording the probe statement ``create_session`` runs."""

    def __init__(self, fail: BaseException | None = None) -> None:
        self.fail: BaseException | None = fail
        self.executed: list[str] = []

    async def execute(self, sql: str) -> None:
        self.executed.append(sql)

        if self.fail is not None:
            raise self.fail


class _FakeAcquire:
    """The async context manager ``pool.acquire()`` returns."""

    def __init__(self, conn: _FakeConn) -> None:
        self._conn: _FakeConn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, *exc: object) -> bool:
        return False


class _FakePool:
    """A stand-in ``asyncpg.Pool`` recording its close and the args it was built with."""

    def __init__(self, conn: _FakeConn | None = None) -> None:
        self.conn: _FakeConn = conn or _FakeConn()
        self.closed: bool = False
        self.kwargs: dict[str, object] = {}

    def acquire(self) -> _FakeAcquire:
        return _FakeAcquire(self.conn)

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_sessions():
    """
    Empty the session registry before and after every test in this module, so a
    leaked session cannot reach ``close_all_sessions`` in a later test.
    """
    connections._sessions.clear()

    yield

    connections._sessions.clear()


def _patch_create_pool(monkeypatch, pool: _FakePool) -> _FakePool:
    """
    Make ``create_session`` hand back ``pool`` instead of dialing Postgres.
    """
    async def _create_pool(**kwargs: object) -> _FakePool:
        pool.kwargs = kwargs

        return pool

    monkeypatch.setattr("app.connections.asyncpg.create_pool", _create_pool)

    return pool
```

---

## Ordered Implementation Steps

1. **`backend/tests/test_export_format.py`** — extend the existing `from app.export_format import (...)` list with `EXPORT_MEDIA` and `content_disposition`, and add a `# --- download header ---` section holding: three `content_disposition` cases asserting the exact header strings from the _Architecture Decisions_ table (plain, quote+CRLF, non-ASCII), one asserting no `\r`/`\n` and exactly two `"` in the quote+CRLF result, and one pinning `EXPORT_MEDIA`'s shape (Expected Behaviour 25). Add a sentence to the module docstring naming the new coverage. Run `cd backend && poetry run python -m pytest tests/test_export_format.py` — expect an `ImportError`.
2. **`backend/app/export_format.py`** — add `import re`, `from urllib.parse import quote`, `EXPORT_MEDIA`, `_FILENAME_UNSAFE`, and `content_disposition` exactly as in _Internal Structure_. Extend the module docstring's opening paragraph to say it also owns the format registry and the download-header builder. Re-run the same test file — green.
3. **`backend/tests/test_export_rows.py`** — replace `test_accepts_csv_and_json` with `test_accepts_every_format_in_the_media_map`, parametrized over `sorted(EXPORT_MEDIA)` (importing `EXPORT_MEDIA` from `app.export_format`).
4. **`backend/app/operations/export_rows.py`** — add `EXPORT_MEDIA` to the existing `..export_format` import, replace the literal `_VALID_FORMATS` with `frozenset(EXPORT_MEDIA)`, and derive the constructor's error message from `_VALID_FORMATS`. Run `poetry run python -m pytest tests/test_export_rows.py` — green.
5. **`backend/app/main.py`** — delete the `_EXPORT_MEDIA` definition and its comment; add `from .export_format import EXPORT_MEDIA, content_disposition` next to the existing `from .config import ...` line; change the `media, ext = ...` line and the `Content-Disposition` header line per _Internal Structure_; extend the route docstring's `Returns:` to note that identifiers are sanitized before reaching the header. Check `grep -n '_EXPORT_MEDIA' backend/app/main.py` — expect zero matches.
6. **`backend/tests/test_config.py`** — extend `test_allow_user_presets_falsey`'s parameters with `"off"` and `"OFF"`; narrow `test_allow_user_presets_truthy`'s parameters to `["1", "true", "yes", "on"]`; add `test_allow_user_presets_unrecognized_defaults_true` covering `"anything"`; add `test_every_boolean_flag_reads_the_same_false_spellings`, parametrized over `["0", "false", "no", "off"]`, asserting `allow_user_presets()`, `enable_docs()`, and `parse_bool(value)` all read the value as false. Run — the `off` cases fail.
7. **`backend/app/config.py`** — delete `_FALSEY` and its comment ([`config.py:28-30`](backend/app/config.py#L28)); rewrite `allow_user_presets()`'s body as `return parse_bool(os.environ.get(_ALLOW_USER_PRESETS_ENV)) is not False` and update its docstring to name the four false spellings and state that an unrecognized value stays on; update the `_TRUE_VALUES`/`_FALSE_VALUES` comment to say the spellings are shared by every boolean env var. Leave the module's function order alone. Run `poetry run python -m pytest tests/test_config.py` — green. Check `grep -rn '_FALSEY' backend/app backend/tests` — expect zero matches.
8. **`backend/tests/test_auth.py`** — import `LOGIN_FAILURE_LIMIT` from `app.rate_limit`; add a module-level list of the four `asyncpg` classes from the _Architecture Decisions_ table and a parametrized `test_login_other_pg_error_is_generic_401` (patching `app.auth.create_session` with a coroutine that raises the class, asserting 401, `detail == "Login failed"`, no `"permission denied"` in the body, no password in the body, no `set-cookie`); add `test_login_other_pg_error_counts_toward_the_rate_limit` (same patch, `LOGIN_FAILURE_LIMIT` attempts each 401, the next one 429). Run — both fail with 400.
9. **`backend/app/auth.py`** — add the `except asyncpg.PostgresError` clause per _Internal Structure_, positioned after the `OSError` clause and before `except DomainError`. Rewrite the `login` docstring's `Unauthorized:` line to: *"if the dial fails for any reason — rejected credentials, a missing database, an unreachable host, or any other server-side rejection (401). The detail is always one of a fixed set of generic messages; neither the password nor raw driver text is echoed."* Add a sentence to the docstring's description, directly under the `Route:` line: *"Every failure raised after the rate-limit check counts toward this client's failed-attempt budget."* Run `poetry run python -m pytest tests/test_auth.py tests/test_rate_limit.py` — green.
10. **Remove the dead `Session.host` in one edit** — delete `host: str` from the `Session` dataclass ([`connections.py:70`](backend/app/connections.py#L70)) and `host=parts.host,` from the `Session(...)` construction ([`connections.py:135`](backend/app/connections.py#L135)), then delete the `host="h",` argument from both `Session(...)` calls in `backend/tests/test_auth.py` ([`:57`](backend/tests/test_auth.py#L57) and [`:166`](backend/tests/test_auth.py#L166)). Check `grep -rn 'host=parts.host\|session\.host\|host="h"' backend/app backend/tests` — expect one match only, `connections.py`'s `create_pool(host=parts.host, ...)` call. Run the full suite.
11. **Fix the two stale docstrings** — in [`connections.py:11-13`](backend/app/connections.py#L11) replace the `DATABASE_URL` paragraph with: *"The app boots with **zero** pools; a pool exists only for the lifetime of a logged-in session, and is closed on logout, on idle eviction (``sweep_idle_sessions``), and on shutdown (``close_all_sessions``)."* In [`contract.py:33-34`](backend/app/contract.py#L33) replace the `Phase 0-1` sentence with: *"``database`` is carried for the multi-DB seam; nothing reads it today — every query runs against the session's own connected database."*
12. **Create `backend/tests/test_connections.py`** — module docstring, the fakes and fixture from _Internal Structure_, and one test per `## Expected Behaviour` case 12–19. Run `poetry run python -m pytest tests/test_connections.py`.
13. **`README.md` and `backend/README.md`** — per `## Documentation Impact`.
14. **Full verification** — the `## Verification` list.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/config.py` |
| Modify | `backend/app/auth.py` |
| Modify | `backend/app/connections.py` |
| Modify | `backend/app/contract.py` |
| Modify | `backend/app/main.py` |
| Modify | `backend/app/export_format.py` |
| Modify | `backend/app/operations/export_rows.py` |
| Modify | `backend/tests/test_config.py` |
| Modify | `backend/tests/test_auth.py` |
| Modify | `backend/tests/test_export_format.py` |
| Modify | `backend/tests/test_export_rows.py` |
| Create | `backend/tests/test_connections.py` |
| Modify | `README.md` |
| Modify | `backend/README.md` |

---

## Expected Behaviour

Every case below is unit-testable except case 20, which is the plan's one manual check.

**Boolean env vars** (`tests/test_config.py`)

1. `ALLOW_USER_PRESETS=off` → `allow_user_presets()` is `False`. Same for `OFF`, `Off`, `  off  `.
2. `ALLOW_USER_PRESETS` in `{0, false, no}` (any case) → `False`, unchanged from today.
3. `ALLOW_USER_PRESETS` in `{1, true, yes, on}` (any case) → `True`.
4. `ALLOW_USER_PRESETS` unset → `True`.
5. `ALLOW_USER_PRESETS=anything` → `True` (unrecognized falls back to the on-by-default).
6. For each of `0`, `false`, `no`, `off`: `allow_user_presets()`, `enable_docs()`, and `parse_bool(value)` all read it as false.

**Login error handling** (`tests/test_auth.py`)

7. `create_session` raising `InsufficientPrivilegeError`, `TooManyConnectionsError`, `ClientCannotConnectError`, or `ProtocolViolationError` → HTTP 401 with body `{"detail": "Login failed"}`.
8. That response contains neither the driver's message text nor the submitted password, and sets no cookie.
9. Ten such attempts followed by an eleventh → the eleventh is 429 with `Retry-After`.
10. The three existing mappings are unchanged: `InvalidPasswordError` → `Invalid credentials`, `InvalidCatalogNameError` → `Cannot open target database`, `OSError` → `Cannot reach database`, all 401.
11. An exception that is not a `PostgresError` and not in the earlier tuples (say a `KeyError` from SQLAdmin's own code) is **not** converted to a 401 — it propagates.

**Session store** (`tests/test_connections.py`)

12. `create_session` returns a `Session` registered in `connections._sessions` under its own `id`, whose `connection_id`, `username`, and `database` echo the supplied `ConnParts`.
13. `create_session` runs exactly one probe statement, `SELECT 1`, on a connection from the new pool.
14. `session.id` and `session.csrf_token` are distinct, and neither equals any supplied field.
15. The plaintext password appears nowhere on the returned `Session` — `"hunter2" not in repr(session)`, and `Session` has no `password` attribute.
16. When the probe raises, `create_session` re-raises that exception, the pool's `close()` has been awaited, and `connections._sessions` is empty.
17. `get_session(token)` returns the registered session; `get_session(None)` and `get_session("nope")` each raise `Unauthorized`.
18. `close_session(token)` closes the pool and removes the entry; `close_session(None)` and `close_session("nope")` are no-ops that raise nothing.
19. `close_all_sessions()` awaits `close()` on every registered pool and leaves `connections._sessions` empty.

**Export header and format registry** (`tests/test_export_format.py`, `tests/test_export_rows.py`)

20. *(manual)* Exporting `public.customers` as CSV from a running app downloads a file named `public.customers.csv`.
21. `content_disposition` produces the three exact header strings in the _Architecture Decisions_ table.
22. For the quote-and-CRLF case above, the returned header contains no `\r`, no `\n`, and exactly two `"` characters.
23. `ExportRowsQuery` constructs successfully for every key of `EXPORT_MEDIA` and raises `ValidationError` for `"xlsx"`.
24. That `ValidationError`'s message names the supported formats derived from `_VALID_FORMATS`, i.e. `"(expected csv or json)"`.
25. `EXPORT_MEDIA` has keys `{"csv", "json"}`, and every value is a 2-tuple of non-empty strings.

---

## Verification

1. `cd backend && poetry run python -m pytest` — full suite green, including the new `tests/test_connections.py`.
2. `cd backend && poetry run pyright` (`typeCheckingMode = "standard"` per [`pyproject.toml:39`](backend/pyproject.toml#L39)) — no new errors.
3. `grep -rn '_FALSEY\|_EXPORT_MEDIA' backend/app backend/tests` — zero matches.
4. `grep -rn 'session\.host\|host="h"' backend/app backend/tests` — zero matches.
5. `grep -rn 'DATABASE_URL\|Phase 0-1' backend/app` — zero matches.
6. `grep -n 'filename=' backend/app/main.py` — zero matches (the header is built only in `export_format.py`).
7. Manual case 20: start the backend against the seeded database (`docker compose up -d db`, then `SQLADMIN_ALLOWED_HOSTS=localhost:5432 poetry run uvicorn app.main:app --port 8000`), log in, open a table's Data tab, and use the export action. Confirm the downloaded file is named `public.customers.csv` and opens as valid CSV.

---

## Documentation Impact

No public frontend API changes, so no frontend doc work. Two README edits, which must stay consistent with each other:

- [`README.md:187`](README.md#L187) — add one sentence to the Configuration section's lead-in, before the bullet list: *"Boolean flags accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`, case-insensitively; an unrecognized value falls back to the flag's documented default."* Then rewrite the `ALLOW_USER_PRESETS` bullet ([`README.md:210-211`](README.md#L210)) to: *"`ALLOW_USER_PRESETS` — on by default; set `false`/`0`/`no`/`off` to hide the "save your own preset" UI and suppress browser-local presets."*
- [`backend/README.md:33-34`](backend/README.md#L33) — rewrite to: *"`ALLOW_USER_PRESETS` — on by default; `false`/`0`/`no`/`off` hides the "save your own preset" UI and suppresses browser-local presets. See the root [`README.md`](../README.md#configuration) for the flag spellings every boolean variable accepts."*

`CHANGELOG.md` gains no entry — changelog text is written at release time, not in feature work (per [`release-steps.md`](release-steps.md)).

---

## Potential Challenges

- **`asyncpg.CannotConnectNowError` is a `PostgresError`.** Putting the catch-all above the existing "Cannot reach database" clause would silently reclassify that case as "Login failed". Step 9 names the position explicitly; the `test_auth.py` case in Expected Behaviour 10 guards it.
- **The four `asyncpg` classes must be constructible in tests.** They are: `asyncpg.InsufficientPrivilegeError('permission denied for database "d"')` works and is an instance of `asyncpg.PostgresError` (verified against the installed asyncpg 0.30.0).
- **Patching `asyncpg.create_pool` reaches the real module object.** `monkeypatch.setattr("app.connections.asyncpg.create_pool", ...)` mutates the shared `asyncpg` module, not a per-module copy. `monkeypatch` restores it at teardown, so this is safe — but the patch must always go through `monkeypatch`, never a bare assignment.
- **Removing `host` shifts every field after it for a positional `Session(...)` call.** Both existing call sites use keyword arguments; step 10's grep confirms no third site exists.
- **The test transport does not reject a malformed header.** httpx's `ASGITransport` has no HTTP framing layer, so a CR/LF in a header value passes through in tests where uvicorn would reject it. That is why Expected Behaviour 21–22 test `content_disposition` directly rather than through the route.

---

## Critical Files

- [`backend/app/config.py`](backend/app/config.py#L28) — `_FALSEY`, `parse_bool`, `enable_docs`; the shape every env-var reader in this codebase follows.
- [`backend/app/auth.py`](backend/app/auth.py#L220) — the `login` handler, its exception ladder, and the `except DomainError` wrapper that drives `record_login_failure`.
- [`backend/app/rate_limit.py`](backend/app/rate_limit.py#L78) — `record_login_failure` / `clear_login_failures`, so the implementer can see exactly what the catch-all now feeds.
- [`backend/tests/test_rate_limit.py`](backend/tests/test_rate_limit.py#L27) — **the precedent for `test_connections.py`**: minimal stand-in objects, direct module-global assertions, pure-logic/route split.
- [`backend/tests/conftest.py`](backend/tests/conftest.py#L55) — `_reset_login_rate_limit`, the autouse-fixture shape `test_connections.py`'s `_reset_sessions` copies.
- [`backend/app/sql/compiler.py:26-30`](backend/app/sql/compiler.py#L26) — `quote_ident`, the precedent for `content_disposition`: a pure one-purpose escaper for a hostile-input context.
- [`backend/app/export_format.py`](backend/app/export_format.py#L1) — the module gaining `EXPORT_MEDIA` and `content_disposition`.
- [`backend/app/main.py:1550-1610`](backend/app/main.py#L1550) — the export route; the only part of `main.py` this plan touches.
- [`plans/implemented/harden-for-publication.md`](plans/implemented/harden-for-publication.md) — introduced `parse_bool` and deliberately left `_FALSEY` alone; its `keep-falsey` footnote is the decision this plan reverses.

---

## Non-Goals

- **Restructuring `main.py`'s route registration.** A separate later plan relocates these routes into per-resource files; this plan touches two lines inside one route body and adds one import.
- **A settings framework.** Bare `os.environ` plus module-level `_…_ENV` constants stays, per `config.py`'s established shape.
- **Changing what `allow_user_presets()` defaults to.** It stays on when unset and on for an unrecognized value; only the recognized false spellings change.
- **Removing the other dead code the audit lists** (`errors.ConflictError`, `sql.ddl.rename_view`, the `operations/__init__.py` base re-exports). Unrelated to the session/auth/config layer.
- **Fixing the remaining stale docstrings from the audit's Priority 4 list.** Only `connections.py:11` and `contract.py:33-34` are in scope, because they sit in files this plan already edits.
- **`CHANGELOG.md` and a version bump.** Written at release time.

---

## Notes

[^one-parser]: The earlier [`plans/implemented/harden-for-publication.md`](plans/implemented/harden-for-publication.md) explicitly left `_FALSEY` in place, arguing that "`parse_bool` cannot express that, because it returns `None` for unrecognized input" and that "six tests in `test_config.py:75-92` pin the current semantics". Both premises hold; the conclusion does not. `parse_bool(...) is not False` expresses "true unless explicitly disabled" in one line, exactly as short as the `not in _FALSEY` it replaces — `None` and `True` both fall on the true side, which is the wanted behaviour. And of the six tests, five keep passing unchanged; the sixth (`"anything"` → `True`) also keeps passing, it just moves into a test named for what it actually pins. The one behaviour that changes is `off`, which is the defect. Keeping two parsers has no upside once the wrapper is a single line.

[^no-warning]: `cookie_secure` warns on an unrecognized value because its variable is three-state (`auto`/true/false), so an unrecognized value is genuinely ambiguous between "the operator meant `auto`" and "the operator meant a boolean". `ALLOW_USER_PRESETS` and `SQLADMIN_ENABLE_DOCS` are two-state, and `enable_docs()` already falls back silently. Adding a warning to one of the two and not the other would introduce a fresh inconsistency in the same pass that removes one; adding it to both widens a bug-fix into a behaviour change. The README sentence added in `## Documentation Impact` is where the spellings get documented.

[^catch-all-width]: Three widths were considered. Enumerating the four named classes was rejected: the audit found those four by inspection, and asyncpg defines dozens of `PostgresError` subclasses — the enumeration would go stale the same way the current five-type list did. Catching bare `Exception` was rejected: it would convert a `TypeError` or `KeyError` in SQLAdmin's own login path into a 401 "Login failed", hiding a real bug behind a plausible-looking auth failure and making it un-diagnosable from the outside. `asyncpg.PostgresError` is exactly the set of "the server said no", which is what a generic 401 honestly reports. Non-`PostgresError` driver problems (`asyncpg.InterfaceError` and friends) stay uncaught: they indicate SQLAdmin passed the driver something malformed, which is a 500, not a rejected login. The server-side `_logger.warning` keeps the operator's diagnostic path open — Postgres connection-rejection messages name the database, host, user, and `pg_hba.conf` rule, never the password.

[^media-home]: Three homes were possible. Leaving `EXPORT_MEDIA` in `main.py` and importing it from `export_rows.py` would make an operation module depend on the app module — a dependency that runs backwards through the layering and would break the later route-registration restructure. Putting it in `operations/export_rows.py` and re-exporting through the `operations` barrel works, but it puts a route-facing constant behind a barrel of operation classes and adds a `main.py` → `operations` coupling for a plain dict. `export_format.py` is already the pure, dependency-free module both sides import (`export_rows.py` imports its formatters today; `main.py` imports nothing from it yet, so this adds exactly one import line that the later restructure carries into the new route file unchanged).

[^both-forms]: Emitting only the sanitized ASCII `filename` would be simpler but lossy: a table named `naïve` would download as `public.na_ve.csv` with no way to recover the real name. Emitting only `filename*` would be correct per RFC 6266 but leaves no fallback for a client that ignores it. Both forms together is what the RFC recommends and what every major server framework does. `urllib.parse.quote(name, safe="")` is safe as an RFC 8187 `ext-value` without further filtering: its unreserved set is `A-Za-z0-9_.-~`, all of which are `attr-char`, and it percent-encodes everything else as UTF-8 bytes.

[^module-local-fixture]: `connections._sessions` needs clearing for the same reason `conftest.py` clears `rate_limit._failures` — both are module-global registries that leak across tests. The fixture is scoped to `test_connections.py` rather than added to `conftest.py` because only this module creates sessions; making it autouse across all forty test modules would change the setup of tests that have nothing to do with sessions, for no benefit. `test_auth.py`'s sweep test already handles its own cleanup with an explicit `finally` and is left alone.
