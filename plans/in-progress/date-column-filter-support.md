---
depends-on: [table-local-filter]
touches-shared:
  - frontend/src/dock/tableWriteRules.ts
  - backend/app/sql/compiler.py
  - backend/app/wire.py
  - TODO.md
---

# Date & Datetime Column Filters — Implementation Plan

## Overview

Date and datetime columns — every column the backend types as `isoString`, which covers Postgres `timestamptz`, `timestamp`, `date`, and the `time` family ([`contract.py:24`](backend/app/contract.py#L24)) — get a working filter input in the data grid's header filter row. Today their filter cell renders blank: [`tableWriteRules.ts:31`](frontend/src/dock/tableWriteRules.ts#L31)'s `FILTERABLE_WIRE_TYPES` lists only `number`, `string`, and `boolean`.

Opening that gate is one word of app code. The work is in the backend: a comparison operand for a temporal column arrives as an ISO-8601 string, and asyncpg refuses a `str` for a `timestamptz`/`date`/`time` parameter. [`compiler.py:145`](backend/app/sql/compiler.py#L145)'s comparator branch binds the operand raw, so `eq`/`neq`/`gt`/`gte`/`lt`/`lte` would fail on every one of these columns. This plan converts the operand to the Python temporal type the column expects before binding, reusing the write path's own wire-to-Python mapping in [`wire.py`](backend/app/wire.py).

Two source files carry that conversion: [`backend/app/wire.py`](backend/app/wire.py) gains one function beside `from_wire_value`, and [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py)'s `FilterCompiler` calls it. Line numbers throughout are as of the `table-local-filter` plan being implemented — this plan builds directly on the `FilterCompiler` and `isFilterableColumn` that plan ships.

---

## Architecture Decisions

### `isoString` joins the filterable wire types

`FILTERABLE_WIRE_TYPES` at [`tableWriteRules.ts:31`](frontend/src/dock/tableWriteRules.ts#L31) gains `"isoString"`, so `isFilterableColumn` returns `true` for it and `buildColumnSpec` marks those columns `filterable`. `json`, `jsonArray`, and `base64` stay excluded.[^why-still-excluded]

No other frontend change is needed. `TableWorkPanel`'s `canFilter` is already `columns.some(isFilterableColumn)`, and the library derives a column's operator menu from the model field type, which [`buildModel.ts:14`](frontend/src/data/buildModel.ts#L14) already maps `isoString` to (`datetime`).

### A temporal filter operand is converted to a Python type before binding

`FilterCompiler` converts a comparison operand for an `isoString` column into the Python temporal value asyncpg binds for that column's Postgres type, then binds that. Non-temporal columns bind exactly what they bind today.

The conversion lives in [`wire.py`](backend/app/wire.py) as a new `from_wire_filter_operand`, beside the `from_wire_value` that [`insert_row.py:56`](backend/app/operations/insert_row.py#L56) and [`update_row.py:64`](backend/app/operations/update_row.py#L64) already use for the same job on the write path.[^why-wire-py] `wire.py` decides the Python type; `compiler.py` decides the SQL — the two meet only at the `date` row of the table below.

| Postgres type | Operand on the wire | Bound Python value | Compiled column expression |
|---|---|---|---|
| `timestamp with time zone` | `"2026-06-28T12:04:00.000Z"` | `datetime(2026, 6, 28, 12, 4, tzinfo=utc)` | `"created_at"` |
| `timestamp without time zone` | `"2026-06-28T12:04:00.000Z"` | `datetime(2026, 6, 28, 12, 4)` | `"logged_at"` |
| `date` | `"2026-06-28T00:00:00.000Z"` | `datetime(2026, 6, 28, 0, 0)` | `"day"::timestamp` |
| `time without time zone` | `"1970-01-01T09:30:00.000Z"` | `time(9, 30)` | `"opens_at"` |
| `time with time zone` | `"1970-01-01T09:30:00.000Z"` | `time(9, 30, tzinfo=utc)` | `"opens_at"` |
| `text` (unchanged) | `"ada"` | `"ada"` | `"name"::text` |

An operand that cannot be parsed raises `ValidationError`, which [`errors.py:38`](backend/app/errors.py#L38) turns into HTTP 422 — never an unhandled `ValueError` surfacing as a 500.

### A `date` column is compared as an instant, not truncated to a day

A `date` column's operand stays a `datetime` and the column is compared as `"day"::timestamp`. This is the one rule `wire.py` and `compiler.py` decide together, so each file's doc comment names the other.[^why-date-cast]

The header row builds "Equals" on a temporal column as a half-open range one minute wide, not a single `eq`. Truncating both ends of that range to a `date` would give the same day twice and match nothing:

| Header cell | Descriptor the library emits | Compiled |
|---|---|---|
| `day` Equals `2026-06-28` | `and(gte 2026-06-28T00:00:00Z, lt 2026-06-28T00:01:00Z)` | `("day"::timestamp >= $1 AND "day"::timestamp < $2)`, params `[datetime(2026,6,28,0,0), datetime(2026,6,28,0,1)]` |
| `day` At least `2026-06-28` | `gte 2026-06-28T00:00:00Z` | `"day"::timestamp >= $1`, params `[datetime(2026,6,28,0,0)]` |
| `created_at` Equals `2026-06-28 12:04` | `and(gte …T12:04:00Z, lt …T12:05:00Z)` | `("created_at" >= $1 AND "created_at" < $2)` |

The `::timestamp` cast is also what pins the bound parameter's type: without it Postgres resolves `"day" >= $1` to a `date` comparison and asyncpg expects a `datetime.date`.

### "Is empty" and "is not empty" need no temporal handling

The `in` branch at [`compiler.py:160`](backend/app/sql/compiler.py#L160) is left alone. It converts nothing, and that is correct for a temporal column.

"Is empty" compiles to `{type: "in", field, values: [null, undefined, ""]}`, which arrives as `[null, null, ""]`. The existing branch splits out the nulls and casts the column when every remaining value is a string, so a `timestamptz` column produces `("created_at"::text IS NULL OR "created_at"::text = ANY($1))` with `$1 = [""]`. A timestamp's text form is never the empty string, so the `IS NULL` half does all the work — which is exactly what "is empty" means for a column that has no empty-string value. "Is not empty" is that wrapped in `NOT`, giving the complement.

### The three text operators need no backend work

`contains`, `startsWith`, and `endsWith` on a temporal column already compile: the pattern branch at [`compiler.py:150`](backend/app/sql/compiler.py#L150) casts the column to `::text` unconditionally and binds a plain string, whatever the column's Postgres type. Nothing in this plan touches that branch.

Those three operators only *appear* for a temporal column once the parallel `typescript-ui` change adds them to the operator list for `date`/`time`/`datetime` columns ([`ColumnFilter.ts:69`](../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts#L69)'s `ORDERED_OPERATORS`). This plan neither requires nor blocks on that release — the six comparison operators plus the two emptiness operators work without it.

---

## Public API

Nothing is exported to a consumer. One new backend function, in `backend/app/wire.py`, beside `from_wire_value`:

```python
def from_wire_filter_operand(value: Any, column: ColumnMeta) -> Any:
    """
    Map one wire scalar to the Python value asyncpg binds for a FILTER
    comparison against ``column``.
    """
```

`isFilterableColumn` and `buildColumnSpec` in `frontend/src/dock/tableWriteRules.ts` keep their signatures; only the wire-type set behind them changes.

---

## Internal Structure

### `wire.py` — the new operand mapping

Two module constants join the existing `_DATE_TYPES` / `_TIME_TYPES` block at [`wire.py:47`](backend/app/wire.py#L47):

```python
# The two members of _TIME_TYPES that carry an offset. Checked BEFORE
# _TIME_TYPES, which contains them as well.
_TIMETZ_TYPES = frozenset({"time with time zone", "timetz"})
_TIMESTAMPTZ_TYPES = frozenset({"timestamp with time zone", "timestamptz"})
```

```python
def _to_utc(moment: datetime.datetime) -> datetime.datetime:
    """
    An aware datetime converted to UTC; a naive one returned unchanged (it
    carries no offset to convert).
    """
    return moment.astimezone(datetime.timezone.utc) if moment.tzinfo else moment


def from_wire_filter_operand(value: Any, column: ColumnMeta) -> Any:
    """
    Map one wire scalar to the Python value asyncpg binds for a FILTER
    comparison against ``column``.

    A temporal column's filter operand always arrives as a full ISO-8601
    instant: the grid's filter cell parses the typed text into a JS ``Date``,
    and ``JSON.stringify`` emits ``Date.toISOString()``. It is mapped to the
    Python type that keeps the comparison exact, which is NOT always the type
    ``from_wire_value`` binds for a write:

      * ``timestamp with time zone`` -> aware ``datetime`` (as for a write)
      * ``timestamp without time zone`` -> naive ``datetime``, the instant's
        UTC wall clock
      * ``date`` -> naive ``datetime``, NOT a ``date``: truncating would
        collapse the header row's minute-wide equality range to an empty one.
        ``FilterCompiler`` compares such a column as ``"col"::timestamp``.
      * ``time with time zone`` -> aware ``time``; the rest of the ``time``
        family -> naive ``time``

    Every non-temporal column returns ``value`` unchanged. Those operands are
    compared as text (``FilterCompiler._column`` casts the column), which is
    what lets a partial ``uuid`` or a plain-digit ``numeric`` operand match at
    all; ``from_wire_value``'s write-path coercion to ``UUID`` / ``Decimal``
    would reject or over-narrow it.

    Args:
        value: the wire scalar from the decoded ``filter=`` query param.
        column: the column the operand is compared against.

    Raises:
        ValueError: if the operand is not a parseable ISO-8601 instant.

    Returns:
        The Python value to bind for this comparison.
    """
    if column.wire_type is not WireType.ISO_STRING or not isinstance(value, str):
        return value

    moment = _to_utc(_parse_iso_datetime(value))
    data_type = column.data_type.lower()

    if data_type in _TIMETZ_TYPES:
        return moment.timetz()

    if data_type in _TIME_TYPES:
        return moment.replace(tzinfo=None).time()

    if data_type in _TIMESTAMPTZ_TYPES:
        return moment

    return moment.replace(tzinfo=None)
```

### `compiler.py` — `FilterCompiler`

`FilterCompiler` keeps the columns themselves, not just their names, so an operand can be mapped against its column's Postgres type. `OrderCompiler` is untouched.

```python
# A `date` column is compared against an instant rather than truncated to a
# day -- see `from_wire_filter_operand`. The cast also pins the bound
# parameter's type, which a bare `"day" >= $1` would infer as `date`.
_INSTANT_CAST_TYPES = frozenset({"date"})
```

```python
# In __init__, replacing self._allowed:
self._columns: dict[str, ColumnMeta] = {c.name: c for c in columns}
```

```python
def _meta(self, field: str) -> ColumnMeta:
    """
    Validate a field against the column set and return its metadata.

    Raises:
        ValidationError: if the field is not a known column.
    """
    column = self._columns.get(field)

    if column is None:
        raise ValidationError(f"Unknown filter column '{field}'")

    return column


def _ident(self, field: str) -> str:
    """
    Validate a field against the column set and return its quoted form.

    Raises:
        ValidationError: if the field is not a known column.
    """
    return quote_ident(self._meta(field).name)


def _operand(self, field: str, value: Any) -> Any:
    """
    The Python value to bind for a comparison against ``field``.

    Raises:
        ValidationError: if the field is unknown, or the operand cannot be
            mapped to the column's type.
    """
    column = self._meta(field)

    try:
        return from_wire_filter_operand(value, column)
    except (ValueError, TypeError) as e:
        raise ValidationError(f"Invalid filter value for column '{field}': {e}")


def _instant_cast(self, field: str) -> str:
    """
    The cast that makes a `date` column comparable to a filter operand's full
    instant, or '' for every other column.
    """
    return "::timestamp" if self._meta(field).data_type.lower() in _INSTANT_CAST_TYPES else ""
```

The comparator branch of `_node` ([`compiler.py:145`](backend/app/sql/compiler.py#L145)) converts first, so `_column` sees the converted value and its `::text` rule — "cast when every value is a `str`" — never fires for a temporal operand:

```python
if t in _COMPARATORS:
    field = f["field"]
    value = self._operand(field, f["value"])
    col = self._column(field, [value]) + self._instant_cast(field)

    return f"{col} {_COMPARATORS[t]} {self._bind(value)}"
```

---

## Ordered Implementation Steps

### Backend — the operand mapping

1. **`backend/tests/test_wire.py`**, test-first, after the existing `from_wire_value` tests (which end at [line 169](backend/tests/test_wire.py#L169)). Add a `from_wire_filter_operand` block covering every row of the operand table under _Architecture Decisions_, plus the pass-through and error cases listed in `## Expected Behaviour`. Import the new name from `app.wire`. Run `cd backend && poetry run python -m pytest tests/test_wire.py` — red (import error).

2. **`backend/app/wire.py`** — add `_TIMETZ_TYPES`, `_TIMESTAMPTZ_TYPES`, `_to_utc`, and `from_wire_filter_operand` per `## Internal Structure`. Put the two constants beside the existing `_DATE_TYPES` / `_TIME_TYPES` at [line 47](backend/app/wire.py#L47) and the two functions after `from_wire_value` ([line 159](backend/app/wire.py#L159)). Extend the module docstring's helper list to name the new function. Run the same pytest command — green. **Do not change `from_wire_value`**: the write path keeps truncating a `date` operand, which is right for a write.

### Backend — the filter compiler

3. **`backend/tests/test_compiler.py`**, test-first, in the `FilterCompiler` section. Add a temporal-column fixture list (`conftest.col` already takes `data_type=`) and cases for every row of both tables under _Architecture Decisions_, plus the emptiness, error, and regression cases in `## Expected Behaviour`. Run `cd backend && poetry run python -m pytest tests/test_compiler.py` — red.

4. **`backend/app/sql/compiler.py`** — add `_INSTANT_CAST_TYPES`, swap `self._allowed` for `self._columns` in `FilterCompiler.__init__` ([line 84](backend/app/sql/compiler.py#L84)), add `_meta`, rewrite `_ident` on top of it ([line 110](backend/app/sql/compiler.py#L110)), add `_operand` and `_instant_cast`, and replace the comparator branch ([line 145](backend/app/sql/compiler.py#L145)) — all per `## Internal Structure`. Import `from_wire_filter_operand` from `..wire`. Leave the pattern branch, the `in` branch, `_column`, and `OrderCompiler` untouched.

5. **Checkpoint.** `cd backend && poetry run python -m pytest` — the whole suite green. Then `grep -n "_allowed" backend/app/sql/compiler.py` — expect matches only inside `OrderCompiler`.

### Frontend — open the gate

6. **`frontend/src/dock/tableWriteRules.ts`** — add `"isoString"` to `FILTERABLE_WIRE_TYPES` ([line 31](frontend/src/dock/tableWriteRules.ts#L31)). Two doc comments name the filterable wire types today and must now name four instead of three: `isFilterableColumn`'s ([line 33](frontend/src/dock/tableWriteRules.ts#L33)) and the closing sentence of `buildColumnSpec`'s ([line 53](frontend/src/dock/tableWriteRules.ts#L53)).

7. **`frontend/tests/dock/tableWriteRules.test.ts`** — move `"isoString"` from the `isFilterableColumn` false list to the true list, and add a `buildColumnSpec` case asserting an `isoString` column carries `filterable: true`.

8. **Checkpoint.** `cd frontend && npm run typecheck && npm test`.

### Docs

9. **`TODO.md`** — add one backlog bullet under `### Data` per `## Documentation Impact`.

10. **Manual verification** — per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/wire.py` |
| Modify | `backend/tests/test_wire.py` |
| Modify | `backend/app/sql/compiler.py` |
| Modify | `backend/tests/test_compiler.py` |
| Modify | `frontend/src/dock/tableWriteRules.ts` |
| Modify | `frontend/tests/dock/tableWriteRules.test.ts` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `from_wire_filter_operand` (`backend/tests/test_wire.py`)

- Every row of the operand table under _Architecture Decisions_, built with `col(name, WireType.ISO_STRING, data_type=…)`.
- A `date` column's operand keeps its time of day: `"2026-06-28T12:04:59.110Z"` maps to `datetime(2026, 6, 28, 12, 4, 59, 110000)`, naive — **not** `date(2026, 6, 28)`, and **not** tz-aware.
- A `timestamp with time zone` column's operand stays aware and in UTC: `"2026-06-28T14:04:00+02:00"` maps to `datetime(2026, 6, 28, 12, 4, tzinfo=utc)`.
- A `time without time zone` column's operand becomes `time(9, 30)` from `"1970-01-01T09:30:00.000Z"`; a `time with time zone` column's becomes the same clock time with `tzinfo=utc`.
- Pass-through, one case each: a `number` column's `10`, a `boolean` column's `True`, a `text` column's `"ada"`, a `uuid` column's partial `"1234"`, a `numeric` column's `"10"` — every one returned unchanged and with its original Python type (the `uuid` and `numeric` cases are the regression guard against reusing `from_wire_value`).
- `None` on a temporal column returns `None`.
- A non-string operand on a temporal column (e.g. `10`) returns unchanged.
- Unparseable text on a temporal column (`"not-a-date"`) raises `ValueError`.

### Unit-testable — `FilterCompiler` (`backend/tests/test_compiler.py`)

- Every row of the descriptor table under _Architecture Decisions_, including the `and`-wrapped equality range on a `date` column and on a `timestamptz` column.
- `gt`/`gte`/`lt`/`lte`/`eq`/`neq` on a `timestamptz` column each compile to `"created_at" {op} $1` with one aware-datetime param and **no** `::text` cast.
- The same six on a `date` column each compile to `"day"::timestamp {op} $1` with one naive-datetime param.
- `contains` on a `timestamptz` column still compiles to `"created_at"::text ILIKE $1 ESCAPE '\'` with a `%…%` string param (the pattern branch is unchanged).
- `isEmpty` on a nullable `timestamptz` column compiles to `("created_at"::text IS NULL OR "created_at"::text = ANY($1))` with `params == [[""]]`; `isNotEmpty` is that wrapped in `NOT (…)`.
- An unparseable operand (`{"type": "eq", "field": "created_at", "value": "not-a-date"}`) raises `ValidationError`, not `ValueError`.
- An unknown column still raises `ValidationError` (the `_meta` refactor must not change that message or behaviour).
- Regression: every existing `FilterCompiler` case still passes byte-for-byte — in particular `eq` on a `numeric`-backed `string` column still binds the raw string and casts the column to `::text`.

### Unit-testable — `tableWriteRules.ts` (`frontend/tests/dock/tableWriteRules.test.ts`)

- `isFilterableColumn` returns `true` for `number`, `string`, `boolean`, and `isoString`; `false` for `json`, `jsonArray`, `base64`.
- `buildColumnSpec` sets `filterable: true` on an `isoString` column entry and `false` on a `json` one.

### Manual — the Data tab of an open table

The seed database has both temporal types this plan targets: `public.customers.created_at` is a `NOT NULL timestamptz`, and `wide.cols_10` carries a nullable `date` (`col_006_day`, seeded with `2026-07-02` onwards) beside a nullable `timestamptz` (`col_007_ts`).

1. **A temporal column has a filter cell.** With the filter row shown on `public.customers`, `created_at`'s header cell has a text input and an operator button (it was blank before).
2. **"At least" on a `timestamptz` column.** Pick "At least" on `created_at` and type a date the grid shows; the returned rows are the ones on or after it, and no 422/500 appears in the network panel.
3. **"Equals" on a `timestamptz` column matches the displayed minute.** Type the date and time exactly as a row displays it (to the minute): that row comes back, and rows in other minutes do not.
4. **"Equals" on a `date` column.** On `wide.cols_10`, pick "Equals" on `col_006_day` and type `2026-07-02`: that row comes back — a non-empty result is the point of this case.
5. **The four remaining comparisons.** "Not equals", "Greater than", "Less than", and "At most" on `created_at` each return a sensible complement/subset, with no error response.
6. **"Is empty" / "Is not empty" on a nullable `date` column.** Every seeded `col_006_day` has a value, so first clear one row's `col_006_day` cell in the grid and Save. Then "Is empty" returns exactly that row, and "Is not empty" returns exactly the others.
7. **Unparseable text is inert.** Type `hello` into `created_at`'s filter input: the grid does not change and no request 422s (the library drops an operand that fails to parse).
8. **Clearing.** Emptying the input, and toggling the filter row off, both restore the unfiltered page.
9. **Text operators, only if the installed library build offers them.** If `created_at`'s operator menu lists "Contains", pick it and type the year and month a row displays, e.g. `2026-08`: matching rows come back. Typing a re-formatted date such as `28/08/2026` correctly matches nothing — the match is against Postgres's own text rendering, not the grid's display format.
10. **No 500s.** Nothing in the backend log across every case above.

---

## Verification

- `cd backend && poetry run python -m pytest` — clean, including the new `from_wire_filter_operand` and `FilterCompiler` cases.
- `cd frontend && npm run typecheck && npm test` — clean.
- `grep -n "_allowed" backend/app/sql/compiler.py` — matches only inside `OrderCompiler`.
- `grep -n "from_wire_value" backend/app/sql/compiler.py` — zero matches (the compiler uses `from_wire_filter_operand`, never the write-path mapping).
- `grep -n 'new Set(' frontend/src/dock/tableWriteRules.ts` — the one `FILTERABLE_WIRE_TYPES` literal, now listing four wire types.
- Manual: the 10 cases above, driven through the running app (see the `verify` skill). Entry point: navigator → `public.customers` → Data tab for cases 1-3, 5, 7-10; `wide.cols_10` for cases 4 and 6.

---

## Documentation Impact

- **`README.md`** — no change. The "Data grid" highlight describes the header filter row without enumerating which column types it covers.
- **`TODO.md`** — add one bullet under `### Data`: `date` and `time` columns are modelled as the library's `datetime` field type ([`buildModel.ts:14`](frontend/src/data/buildModel.ts#L14)), so a `date` cell renders a time of day it does not have, and west of UTC it renders the previous day. Mapping those two Postgres types to the library's `date` / `time` field types would fix the display and the editor together; it is a separate change with a grid-wide blast radius.
- **`LIBRARY_NOTES.md`** — nothing to log. No library defect is expected here; add an entry only if manual verification surfaces one, following the file's existing 🐞🔎 format.
- **`CHANGELOG.md`** — no entry; written at release time, not in feature work.

---

## Potential Challenges

- **A `date` column displays as a datetime, and west of UTC as the previous day.** The wire value `"2026-06-28"` parses to UTC midnight, which the grid renders in local time. Filtering follows the instant, so a user west of UTC must type the stored day rather than the displayed one. Out of scope; backlogged in `TODO.md` (see `## Documentation Impact`).
- **`timestamp without time zone` and `time` columns are shifted by the client's UTC offset.** Their wire value carries no offset, so the browser reads it as local time and sends back the corresponding UTC instant, which the backend cannot shift back. Neither type exists in the seed database, so no manual case covers them; the mapping is still unit-tested so the operand binds without a 500.
- **"Equals" on a `timestamptz` column is a minute, not an instant.** The library builds equality as the span of instants that renders identically, and the grid does not show seconds. Manual case 3 pins the intended behaviour so it is not mistaken for a bug.
- **This plan is unimplementable before `table-local-filter` lands.** It edits a `FilterCompiler` and an `isFilterableColumn` that plan introduces. The frontmatter declares the dependency; if `plans/implemented/table-local-filter.md` does not exist, stop and say so.

---

## Critical Files

| File | Why |
|---|---|
| [`backend/app/wire.py`](backend/app/wire.py) | `from_wire_value` (:159) and `_parse_iso_datetime` (:146) — the write-path precedent the new operand mapping sits beside and reuses, and the `_DATE_TYPES` / `_TIME_TYPES` constants it extends. |
| [`backend/app/operations/insert_row.py`](backend/app/operations/insert_row.py) | The `{c.name: c}` lookup plus `from_wire_value` call at :47-56 — the shape `FilterCompiler`'s `_columns` map and `_operand` mirror. |
| [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) | The compiler being changed: `_column`'s `::text` rule (:122), the comparator branch (:145), the pattern branch (:150), and the `in` branch (:160), the last two of which must stay untouched. |
| [`backend/app/contract.py`](backend/app/contract.py) | `WireType.ISO_STRING` (:24) and `ColumnMeta.data_type` (:89) — the two fields the whole mapping keys on. |
| [`backend/tests/conftest.py`](backend/tests/conftest.py) | The `col(...)` fixture helper, including its `data_type=` keyword, used by both new test blocks. |
| [`plans/implemented/table-local-filter.md`](plans/implemented/table-local-filter.md) | Where the header filter row, `isFilterableColumn`, `_column`, and the null-bearing `in` compilation came from — and, in footnote `[^why-filterable-subset]`, why `isoString` was left out. |
| [`frontend/src/data/buildModel.ts`](frontend/src/data/buildModel.ts) | The `wireType` → `FieldType` map (:10) that sends every `isoString` column to `datetime`, deciding which operators the filter cell offers. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts` (`ORDERED_OPERATORS` 69, `columnFilterOperators` 115, `parseOperand` 241, `displayBucket` 296, `buildClauseFilter` 380) | The exact descriptors a temporal filter cell emits — the input contract for every backend change here, including the minute-wide equality range. |

---

## Non-Goals

- **Mapping `date` / `time` Postgres columns to the library's `date` / `time` field types.** That mapping would change cell rendering and the inline editor across the Data tab, query results, and the record view. Backlogged in `TODO.md`.
- **Correcting the client-offset shift on `timestamp without time zone` and `time` columns.** The wire contract emits those without an offset; fixing it means changing what `to_wire_value` sends and how the frontend parses it.
- **A date picker in the filter cell.** The header row's cell is a text input; the library owns its content.
- **Filtering `json`, `jsonArray`, or `base64` columns.** Their operands still have no useful SQL form, unchanged from `table-local-filter`.[^why-still-excluded]
- **Any change to `from_wire_value` or the write path.** Insert and update keep binding a `date` column's value as a `datetime.date`, which is right for a write.
- **Any `typescript-ui` change.** Adding `contains` / `startsWith` / `endsWith` to a temporal column's operator menu is a separate plan in that repo; this plan works with or without it.

---

## Notes

[^why-still-excluded]: `json` / `jsonArray` map to the library's `auto` field type, which offers the string operators — Postgres has no `ILIKE` for `jsonb`, and equality against a rendered JSON string is meaningless. `base64` maps to `string` and would compile, but substring-matching a `bytea` blob is not a feature anyone wants. `isoString` was excluded for a different and now-solved reason: `plans/implemented/table-local-filter.md`'s `[^why-filterable-subset]` records that its operators parse typed text into a JS `Date`, which crosses the wire as an ISO string that asyncpg refuses for a `timestamptz`/`date`/`time` parameter. Converting the operand before binding — this plan's whole subject — removes that objection; the other two stand.

[^why-wire-py]: Three options were weighed. **(1) Reuse `from_wire_value` directly.** Rejected: it is the *write* mapping, and applying it to every operand would coerce a `numeric` column's `"10"` to `Decimal` and a `uuid` column's partial `"1234"` to `uuid.UUID` — the latter raising `ValueError` on any text that is not a complete UUID, turning a half-typed filter into an error response. It also truncates a `date` operand to a `datetime.date`, which is exactly the collapse described in _A `date` column is compared as an instant_. **(2) Parse inline in `compiler.py`.** Rejected: it would duplicate `_parse_iso_datetime` and the Postgres-type-name sets that already live in `wire.py`, leaving two places to keep in step with each other. **(3) A sibling function in `wire.py`** — chosen. `wire.py`'s module docstring already frames the file as "Postgres/asyncpg -> wire-contract mapping" with pure, database-free helpers, which is precisely what the new function is, and `insert_row.py` / `update_row.py` establish the calling shape: build `{c.name: c}`, look the column up, map the value, bind it.

[^why-date-cast]: A `date` column's stored value is a whole day, but the operand is a moment, so one of the two has to be promoted. Promoting the column (`"day"::timestamp`, i.e. that day at midnight) keeps the comparison exact and needs no case analysis per operator; demoting the operand (truncating to a `date`) needs a different rounding rule for each of the six comparators and still returns nothing for equality. `::timestamp` rather than `::timestamptz` because `date -> timestamptz` is evaluated in the session time zone, which this app never sets — `date -> timestamp` is pure calendar arithmetic and identical on every server. The bound value is the operand's UTC wall clock with the offset dropped, which pairs with that: the frontend built the operand by round-tripping the instant it parsed from `"2026-06-28"`, i.e. UTC midnight, so `"day"::timestamp` and the bound naive datetime land on the same clock reading in every browser time zone. The choice also survives the deferred `buildModel` change described in `## Documentation Impact`: if a `date` column later maps to the library's `date` field type, its equality range widens from one minute to one whole local day and `"day"::timestamp` still falls inside it.
