---
depends-on: [store-temporal-local-values]
touches-shared:
  - backend/app/contract.py
  - backend/app/wire.py
  - backend/app/sql/compiler.py
  - backend/tests/test_wire.py
  - frontend/src/contract.ts
  - frontend/src/data/buildModel.ts
  - frontend/src/data/SqlAdminWriter.ts
  - frontend/src/data/stores.ts
  - frontend/src/dock/tableWriteRules.ts
  - TODO.md
  - LIBRARY_NOTES.md
---

# Date & Time Column Field Types — Implementation Plan

## Overview

Every Postgres `date`, `time` and `timestamp` column reaches the frontend as one wire type, `isoString` ([`contract.py:24`](backend/app/contract.py#L24)), which [`buildModel.ts:14`](frontend/src/data/buildModel.ts#L14) maps to the library's `datetime` field type. That causes these visible bugs:

- A `date` cell shows a time of day it does not have, and west of UTC it shows the previous day.
- A `time` cell is always blank. The library's `Field` converts the value with `new Date("09:30:00")`, which is an Invalid Date, so the field stores `undefined`.
- Typing a bare `2026-09-01` into a `date` cell reverts silently. The column gets the date-time cell editor, which needs a time as well (`YYYY-MM-DD H:MM`). Mapping `date` to the library's `date` field type gives it the date editor.
- The header filter row on a `timestamp` or `date` column misses rows in a browser outside UTC. The filter sends a UTC instant, and the backend compares its UTC wall clock or UTC day with a local one.

This plan gives `date` and `time` their own wire types and field types, and makes every temporal value cross the wire in both directions without losing its day or its wall-clock time. It spans two parts of SQLAdmin:

- **backend**: the wire contract, the read/write/filter mappings in [`wire.py`](backend/app/wire.py), and the `date` filter comparison in [`compiler.py`](backend/app/sql/compiler.py).
- **frontend**: the wire-type union, the field-type map, `SqlAdminWriter` rebased onto the library's `JsonWriter`, the filterable set, and the chart's time axis.

The library half — `Field` reading a bare date and a time of day as local values, `JsonWriter` writing each `Date` by field type, `AjaxProxy` writing filter `Date`s with their local offset, the filter row reading a typed date as a local day, `TimeField` on 1 January 1970, and a `protected` `JsonWriter.dataFor` — is the typescript-ui plan **`store-temporal-local-values`**, in the typescript-ui repo (`/home/jika/typescript/typescript-ui/plans/store-temporal-local-values.md`). This plan starts once that plan is implemented on its branch. It runs against a symlinked build of that branch, before the library is released.

SQLAdmin 0.10.0 is released on typescript-ui 0.10.0, installed from the registry ([`frontend/package.json:20`](frontend/package.json#L20) names `^0.10.0`). This plan lands in the next SQLAdmin release. It builds on the shipped [`row-write-changed-fields`](plans/implemented/row-write-changed-fields.md), which sends only changed fields on an update, binds a naive `datetime` for a `timestamp` column, and reads `interval`/`timetz` as text. It replaces two of that plan's pieces (its `timestamp` write rule and `SqlAdminWriter`'s local wall-clock workaround) and changes two decisions of the shipped [`date-column-filter-support`](plans/implemented/date-column-filter-support.md); each is called out below. It also replaces the backlog bullet at [`TODO.md:22`](TODO.md#L22).

---

## Architecture Decisions

### Temporal columns get three wire types, one per library field type

The wire contract is the seam: the backend's `WireType` picks it, and the frontend's `WIRE_TO_FIELD` turns it into a `FieldType`. Adding members there is how every column kind already reaches its field type.[^wire-seam] `isoString` keeps its name and narrows to the two timestamp types.[^keep-isostring]

| Postgres type | Wire type | Wire value (read) | Library field type |
|---|---|---|---|
| `timestamp with time zone` | `isoString` | `2026-06-28T12:04:59.123456+00:00` | `datetime` |
| `timestamp without time zone` | `isoString` | `2026-06-28T12:04:59.500000` | `datetime` |
| `date` | `isoDate` (new) | `2026-06-28` | `date` |
| `time without time zone` | `isoTime` (new) | `09:30:15.250000` | `time` |
| `time with time zone`, `interval` | `string` (since `row-write-changed-fields`) | `09:30:00+02` | `string` |

A query result carries only `{name, wireType}` per column, never the Postgres type, so this split has to live in the wire type rather than in `ColumnMeta.dataType`.

### The app relies on the library plan's wire forms

`store-temporal-local-values` fixes the library defects behind the read and filter bugs in the library, not with app-side workarounds.[^fix-in-library] Once it is in the running build, the frontend sends and reads these forms, and the backend below is written against them:

| Direction | Field type | Form | Example (browser in Los Angeles) |
|---|---|---|---|
| read | `date` | bare date, local midnight | `2026-06-28` → 28 June, 00:00 local |
| read | `time` | `HH:MM[:SS[.fraction]]` on 1 January 1970, local | `09:30:15.250000` → 09:30:15.250 |
| write | `date` | bare date | `2026-06-28` |
| write | `time` | `HH:MM:SS.sss` | `09:30:15.250` |
| write | `datetime` | local ISO-8601 plus offset | `2026-06-28T12:04:59.123-07:00` |
| `filter=` | any `Date` | local ISO-8601 plus offset | `2026-06-28T00:00:00.000-07:00` |

### The backend reads a zone-less column from the wall clock and `timestamptz` from the instant

For `date`, `time` and `timestamp without time zone`, the backend takes the date and time written in the string and drops any offset **without converting**. For `timestamptz` it keeps the instant. The rule applies to row writes (`from_wire_value`) and filter operands (`from_wire_filter_operand`) alike.[^wall-clock]

This replaces two earlier rules, which both converted an offset to UTC before dropping it: `row-write-changed-fields`'s rule for a written `timestamp` ([`wire.py:211-215`](backend/app/wire.py#L211)), and `date-column-filter-support`'s rule for zone-less filter operands. The rows marked "was" show where the results differ.

Writes (`from_wire_value`):

| Column | Value sent | Bound |
|---|---|---|
| `timestamptz` | `2026-06-28T12:04:00.000-07:00` | `datetime(2026,6,28,12,4,tzinfo=-07:00)` (= 19:04 UTC) |
| `timestamp` | `2026-06-28T12:04:00.000-07:00` (the grid) | `datetime(2026,6,28,12,4)` |
| `timestamp` | `2026-06-28T14:04:00+02:00` | `datetime(2026,6,28,14,4)` (was 12:04) |
| `timestamp` | `2026-06-28T08:00:00.000` (a 0.10.0 client, and export files) | `datetime(2026,6,28,8,0)` |
| `timestamp` | `2026-06-28T12:04:00.000Z` | `datetime(2026,6,28,12,4)` |
| `date` | `2026-06-28` (the grid, and import files) | `date(2026,6,28)` |
| `date` | `2026-06-28T00:00:00.000+09:00` | `date(2026,6,28)` |
| `time` | `09:30:15.250` (the grid) | `time(9,30,15,250000)` |
| `time` | `09:30:15.250000` (import file) | `time(9,30,15,250000)` |
| `time` | `1970-01-01T09:30:00.000-08:00` | `time(9,30)` |

Filter operands (`from_wire_filter_operand`), browser in `America/Los_Angeles`:

| Column | Operand sent | Bound |
|---|---|---|
| `timestamptz` | `2026-06-28T12:04:00.000-07:00` | `datetime(2026,6,28,19,4,tzinfo=utc)` |
| `timestamp` | `2026-06-28T12:04:00.000-07:00` | `datetime(2026,6,28,12,4)` (was 19:04) |
| `date` | `2026-06-28T00:00:00.000-07:00` | `date(2026,6,28)` |
| `time` | `1970-01-01T09:30:00.000-08:00` | `time(9,30)` |

### A `date` filter operand is truncated to its day

This reverses `date-column-filter-support`'s _A `date` column is compared as an instant_. `from_wire_filter_operand` returns a `datetime.date` for an `isoDate` column, and `FilterCompiler` drops its `::timestamp` cast, so `"day" >= $1` binds a `date`.[^date-truncate]

The library's filter row builds "Equals" on a `date` column as one whole local day:

| Header cell (Los Angeles) | Descriptor sent | Compiled |
|---|---|---|
| `day` Equals `2026-06-28` | `and(gte 2026-06-28T00:00:00.000-07:00, lt 2026-06-29T00:00:00.000-07:00)` | `("day" >= $1 AND "day" < $2)`, params `[date(2026,6,28), date(2026,6,29)]` |
| `day` At least `2026-06-28` | `gte 2026-06-28T00:00:00.000-07:00` | `"day" >= $1`, params `[date(2026,6,28)]` |

### `SqlAdminWriter` extends `JsonWriter` in `'dirty'` mode, and its workaround goes

With the library plan, `JsonWriter.dataFor` is `protected`. `SqlAdminWriter` then extends `JsonWriter` with `mode: 'dirty'` and overrides `dataFor` to strip generated columns from `super.dataFor(…)`. It drops its own copy of the dirty-mode rule and its zone-less-timestamp wall-clock formatting (`formatWallClock`, [`SqlAdminWriter.ts:26`](frontend/src/data/SqlAdminWriter.ts#L26)), because `JsonWriter` now writes a `datetime` value with its local wall clock and offset, and the backend drops the offset for a zone-less column.[^rebase-writer] The `LIBRARY_NOTES.md` entry that records the workaround as 🩹 flips to ✅.

### Charts plot `isoDate` on the time axis at local midnight, and never offer `isoTime`

[`chartConfig.ts`](frontend/src/data/chartConfig.ts) accepts `isoString` and `isoDate` as time-axis columns. It parses an `isoDate` value as local midnight, so the point sits on the day the grid shows. An `isoTime` column is not an x-axis candidate.[^chart-time]

### The app is verified against a symlinked build of the library branch

The library plan lands on its own branch in typescript-ui, branched from **local** `master`, and is not released yet. SQLAdmin runs against that branch's `build:lib` through a symlink that must target the branch's worktree, not the main checkout. `frontend/package.json` stays at `^0.10.0` for the whole plan.[^no-bump]

---

## Public API

### Backend — `backend/app/contract.py`

```python
class WireType(str, Enum):
    ...
    ISO_STRING = "isoString"   # timestamptz/timestamp -> ISO-8601 date-time (offset only for timestamptz)
    ISO_DATE = "isoDate"       # date -> "YYYY-MM-DD"
    ISO_TIME = "isoTime"       # time (without time zone) -> "HH:MM:SS[.ffffff]"
    ...
```

### Frontend — `frontend/src/contract.ts`

```ts
export type WireType =
    | "number" | "string" | "boolean"
    | "isoString" | "isoDate" | "isoTime"
    | "json" | "base64" | "jsonArray";
```

### Frontend — `frontend/src/data/SqlAdminWriter.ts`

```ts
export class SqlAdminWriter extends JsonWriter {
    constructor(private readonly generatedColumns: ReadonlySet<string>);   // calls super({ mode: "dirty" })
    protected override dataFor(record: ModelRecord, operation?: WriteOperation): Record<string, any>;
}
```

`JsonWriter`, `ModelRecord` and `WriteOperation` come from `@jimka/typescript-ui/data`; `JsonWriter` as a value import, the other two with `import type`.

---

## Internal Structure

### Backend — `wire.py` constants

Delete `_DATETIME_TYPES` ([`wire.py:33-43`](backend/app/wire.py#L33)). In the block at [lines 53-57](backend/app/wire.py#L53), rewrite the comment and add the two new sets, so the block reads:

```python
# The temporal families pg_type_to_wire splits into ISO_STRING / ISO_DATE /
# ISO_TIME, and the subset of timestamps that carry a zone.
_TIMESTAMP_TYPES = frozenset(
    {"timestamp with time zone", "timestamp without time zone", "timestamp", "timestamptz"}
)
_TIMESTAMPTZ_TYPES = frozenset({"timestamp with time zone", "timestamptz"})
_DATE_TYPES = frozenset({"date"})
_TIME_TYPES = frozenset({"time", "time without time zone"})
_TEMPORAL_WIRE_TYPES = frozenset({WireType.ISO_STRING, WireType.ISO_DATE, WireType.ISO_TIME})
```

`_DATE_TYPES`, `_TIME_TYPES` and `_TIMESTAMPTZ_TYPES` already exist with these values; they stay. `_POSTGRES_TEXT_TYPES` ([line 60](backend/app/wire.py#L60)) stays as it is.

### Backend — `wire.py` functions

```python
def _wall_clock(text: str) -> datetime.datetime:
    """
    The naive date-time an ISO string names: its offset, if any, is dropped
    without converting, so "12:04-07:00" stays 12:04.
    """
    return _parse_iso_datetime(text).replace(tzinfo=None)
```

`pg_type_to_wire` — replace the single `_DATETIME_TYPES` check ([line 83](backend/app/wire.py#L83)) with three, before the existing `_POSTGRES_TEXT_TYPES` check:

```python
if dt in _TIMESTAMP_TYPES:
    return WireType.ISO_STRING

if dt in _DATE_TYPES:
    return WireType.ISO_DATE

if dt in _TIME_TYPES:
    return WireType.ISO_TIME
```

`to_wire_value` ([line 145](backend/app/wire.py#L145)): `if wire_type in _TEMPORAL_WIRE_TYPES: return value.isoformat()`.

`from_wire_value` — replace the whole `ISO_STRING` branch ([lines 199-215](backend/app/wire.py#L199)) with:

```python
if wire_type is WireType.ISO_DATE:
    # The first ten characters are the calendar day in every form that
    # arrives: "YYYY-MM-DD" (the grid, import files) and a local-offset
    # date-time (an older client).
    return datetime.date.fromisoformat(value[:10])

if wire_type is WireType.ISO_TIME:
    return _wall_clock(value).time() if "T" in value else datetime.time.fromisoformat(value)

if wire_type is WireType.ISO_STRING:
    moment = _parse_iso_datetime(value)

    # A zone-less timestamp: asyncpg rejects an aware datetime for it, and the
    # wall clock in the string is what the user saw, so any offset is dropped
    # without converting.
    return moment if data_type in _TIMESTAMPTZ_TYPES else moment.replace(tzinfo=None)
```

Change the docstring's last sentence to: "A `timestamp without time zone` value always binds as a naive `datetime` holding the wall clock written in the string."

`from_import_scalar` ([line 331](backend/app/wire.py#L331)): the `ISO_STRING` test becomes `wire_type in _TEMPORAL_WIRE_TYPES`; the message is unchanged.

`from_wire_filter_operand` ([line 393](backend/app/wire.py#L393)) — new body; rewrite the docstring's bullet list to match the operand table under _Architecture Decisions_, and its opening paragraph to say the operand arrives as local ISO-8601 with the browser's offset:

```python
if column.wire_type not in _TEMPORAL_WIRE_TYPES or not isinstance(value, str):
    return value

moment = _parse_iso_datetime(value)

if column.wire_type is WireType.ISO_DATE:
    return moment.replace(tzinfo=None).date()

if column.wire_type is WireType.ISO_TIME:
    return moment.replace(tzinfo=None).time()

if column.data_type.lower() in _TIMESTAMPTZ_TYPES:
    return _to_utc(moment)

return moment.replace(tzinfo=None)
```

---

## Ordered Implementation Steps

### Setup — link the library branch

1. **Library branch ready.** In `/home/jika/typescript/typescript-ui`, `store-temporal-local-values` must be implemented. Run `git -C /home/jika/typescript/typescript-ui worktree list` and find the worktree on `feature/store-temporal-local-values`. Call its path `$LIB` (for example `/home/jika/typescript/typescript-ui/.worktrees/store-temporal-local-values`). If the branch is already merged into local `master` and has no worktree, `$LIB` is `/home/jika/typescript/typescript-ui`. If neither holds, stop: the dependency is not implemented. Run `npm run build:lib` in `$LIB` (not `npm run build`).

2. **Symlink the app to `$LIB`.** The installed package is a real directory (the 0.10.0 registry copy), so remove it first; `ln -s` against a directory creates the link inside it. Use absolute paths, since a relative target resolves differently from a worktree:

    ```bash
    rm -rf /home/jika/typescript/sqladmin/frontend/node_modules/@jimka/typescript-ui
    ln -s "$LIB/packages/lib" /home/jika/typescript/sqladmin/frontend/node_modules/@jimka/typescript-ui
    readlink -e /home/jika/typescript/sqladmin/frontend/node_modules/@jimka/typescript-ui   # must print $LIB/packages/lib
    rm -rf /home/jika/typescript/sqladmin/frontend/node_modules/.vite
    ```

    Then `grep -l "stringifyWithLocalDates\|toLocalIsoString" "$LIB/packages/lib/dist/lib/"*.js | head -1` must print a file; if it prints nothing, the build is stale and step 1's `build:lib` must be rerun. `frontend/package.json` and `package-lock.json` are not touched.

3. **Worktree prerequisites.** In a SQLAdmin worktree, if `frontend/node_modules` is missing, symlink it: `ln -s /home/jika/typescript/sqladmin/frontend/node_modules frontend/node_modules`. Never commit the link. Run backend tests as `poetry run python -m pytest` from the worktree's `backend/`, so the worktree's `app` is imported.

### Backend — `sqladmin/backend` (test-first)

4. **`backend/tests/test_wire.py`** — update and add cases per _Expected Behaviour → Backend_:
    - the `test_pg_type_to_wire` table ([line 27](backend/tests/test_wire.py#L27)): `date` → `ISO_DATE`, and add the `time` rows;
    - `test_from_wire_date_and_time` ([line 182](backend/tests/test_wire.py#L182)) and `test_from_wire_date_accepts_full_datetime_string` ([line 191](backend/tests/test_wire.py#L191)) move to `ISO_DATE` / `ISO_TIME` columns;
    - in `test_from_wire_timestamp_without_tz_binds_naive` ([line 156](backend/tests/test_wire.py#L156)), the `+02:00` row now expects `datetime(2026,6,28,14,4)`; rewrite the test's comment to say an offset is dropped without converting, and add the `-07:00` grid row from the write table;
    - the filter-operand table ([line 212](backend/tests/test_wire.py#L212)): the `date` and `time` rows move to the new wire types and the new results; the `timestamp without time zone` row keeps its `Z` operand and result;
    - delete `test_from_wire_filter_operand_date_keeps_time_of_day` ([line 227](backend/tests/test_wire.py#L227)); its premise is reversed, since a `date` operand is now truncated.

    Red.

5. **`backend/app/contract.py`** — add `ISO_DATE` / `ISO_TIME` and reword the `ISO_STRING` comment ([line 24](backend/app/contract.py#L24)) per _Public API_.

6. **`backend/app/wire.py`** — constants, `_wall_clock`, `pg_type_to_wire`, `to_wire_value`, `from_wire_value`, `from_import_scalar` and `from_wire_filter_operand` per _Internal Structure_. Update the module docstring's `from_wire_filter_operand` bullet ([lines 10-12](backend/app/wire.py#L10)) so it no longer says the mapping differs from the write path for "a temporal column" in general: it differs only for a `timestamptz` operand, which is converted to UTC. Run `tests/test_wire.py` — green.

7. **`backend/tests/test_compiler.py`** — `TEMPORAL_COLS` ([line 18](backend/tests/test_compiler.py#L18)) gives `day` `WireType.ISO_DATE`. Rewrite the three `date` tests to the uncast form with `date` params, per the `date`-filter table: `test_filter_comparators_on_date_column_cast_to_timestamp` ([line 315](backend/tests/test_compiler.py#L315)), renamed `test_filter_comparators_on_date_column_bind_a_date`; `test_filter_equals_range_on_date_column` ([line 324](backend/tests/test_compiler.py#L324)); `test_filter_at_least_on_date_column` ([line 365](backend/tests/test_compiler.py#L365)). Add `col("logged_at", WireType.ISO_STRING, data_type="timestamp without time zone")` to `TEMPORAL_COLS` and its offset case. Red.

8. **`backend/app/sql/compiler.py`** — delete `_INSTANT_CAST_TYPES` and its comment ([lines 20-23](backend/app/sql/compiler.py#L20)) and `_instant_cast` ([line 153](backend/app/sql/compiler.py#L153)). The comparator line ([line 186](backend/app/sql/compiler.py#L186)) becomes `col = self._column(field, [value])`. Green. `grep -n "_instant_cast\|::timestamp" backend/app/sql/compiler.py` — zero matches.

9. **`backend/tests/test_run_query.py`** — beside `test_short_name_type_mapping` ([line 163](backend/tests/test_run_query.py#L163)), add a case whose attributes are `date`, `time`, `timestamp`, expecting `isoDate`, `isoTime`, `isoString`. No source change: `_query_columns` already goes through `pg_type_to_wire`.

10. **`backend/app/export_format.py`** — the comment at [line 106](backend/app/export_format.py#L106) lists `isoString`; make it `isoString / isoDate / isoTime`. No logic change.

11. **Checkpoint.** `cd backend && poetry run python -m pytest` — whole suite green. `grep -rn "_DATETIME_TYPES" backend/app` — zero matches.

### Frontend — `sqladmin/frontend` (needs steps 1-2)

12. **`frontend/src/contract.ts`** — add `"isoDate"` and `"isoTime"` to `WireType` ([line 39](frontend/src/contract.ts#L39)), each with a one-line comment naming its Postgres type.

13. **`frontend/tests/data/buildModel.test.ts`** — add `isoDate` → `date` and `isoTime` → `time` columns to the `buildQueryModel` case ([line 21](frontend/tests/data/buildModel.test.ts#L21)) and the `buildModel` case ([line 43](frontend/tests/data/buildModel.test.ts#L43)). Then **`frontend/src/data/buildModel.ts`** — add `isoDate: "date"` and `isoTime: "time"` to `WIRE_TO_FIELD` ([line 10](frontend/src/data/buildModel.ts#L10)). `Record<WireType, FieldType>` makes a missed entry a type error.

14. **`frontend/tests/data/SqlAdminWriter.test.ts`** —
    - keep the `SqlAdminWriter` block ([line 7](frontend/tests/data/SqlAdminWriter.test.ts#L7)) and the `operation-aware bodies` block ([line 56](frontend/tests/data/SqlAdminWriter.test.ts#L56)) unchanged;
    - in the `zone-less timestamp columns` block ([line 107](frontend/tests/data/SqlAdminWriter.test.ts#L107)), delete the two wall-clock cases, "leaves a zone-aware timestamp as its UTC instant" and the `it.each` wall-clock table. Keep "writes null in a zone-less column as null", constructed with one argument, and rename the block `SqlAdminWriter temporal write forms`;
    - add a `d` field with `type: "date"` to `temporalModel` ([line 46](frontend/tests/data/SqlAdminWriter.test.ts#L46)) and `d: null` to `temporalRecord`, then add the `date` / `datetime` cases under _Expected Behaviour → Frontend_;
    - update the comment above `temporalModel` so it no longer mentions `Date.UTC` or `toISOString`;
    - `grep -n "new SqlAdminWriter(new Set([^)]*), " frontend/tests` — zero matches (every writer takes one argument).

    Red: the new `date` / `datetime` cases fail, because today's `SqlAdminWriter` still serializes with `JSON.stringify`, which writes `toISOString()`.

15. **`frontend/src/data/SqlAdminWriter.ts`** — rewrite per _Public API_: it extends `JsonWriter`, calls `super({ mode: "dirty" })`, and overrides `dataFor` to return `super.dataFor(record, operation)` with every key in `generatedColumns` removed. Delete `writeRecord`/`writeRecords`, `toBody`, the private `dataFor`, `formatWallClock` and its three constants, and the `zonelessTimestampColumns` parameter. Rewrite the file header comment: generated columns are stripped from every body; an update sends only the changed fields plus the primary key (the library's `'dirty'` mode); `JsonWriter` writes each `Date` in its field type's form. Step 14 green.

16. **`frontend/src/data/stores.ts`** — delete the `ZONELESS_TIMESTAMP_TYPE` comment and constant ([lines 18-21](frontend/src/data/stores.ts#L18)) and the `zoneless` set ([lines 27-29](frontend/src/data/stores.ts#L27)); the writer is `new SqlAdminWriter(generated)` ([line 40](frontend/src/data/stores.ts#L40)).

17. **`frontend/tests/dock/tableWriteRules.test.ts`** — add `"isoDate"` and `"isoTime"` to the `isFilterableColumn` true list ([line 111](frontend/tests/dock/tableWriteRules.test.ts#L111)). Then **`frontend/src/dock/tableWriteRules.ts`** — add both to `FILTERABLE_WIRE_TYPES` ([line 29](frontend/src/dock/tableWriteRules.ts#L29)), and update the two doc comments that list the filterable wire types ([line 34](frontend/src/dock/tableWriteRules.ts#L34) and [line 51](frontend/src/dock/tableWriteRules.ts#L51)).

18. **`frontend/tests/data/chartConfig.test.ts`** — add the chart cases from _Expected Behaviour_. Then in **`frontend/src/data/chartConfig.ts`**:
    - add a module constant `TIME_AXIS_WIRE_TYPES: ReadonlySet<WireType> = new Set(["isoString", "isoDate"])`;
    - replace the three `wireType === "isoString"` tests ([lines 37, 55, 70](frontend/src/data/chartConfig.ts#L37)) with `TIME_AXIS_WIRE_TYPES.has(c.wireType)`;
    - in `toX` ([line 96](frontend/src/data/chartConfig.ts#L96)), the condition becomes `xCol !== undefined && TIME_AXIS_WIRE_TYPES.has(xCol.wireType)` (the set takes no `undefined`), and replace `Date.parse(String(row[config.xField]))` with a module-private `toEpochMs(String(row[config.xField]), xCol.wireType)`. `toEpochMs` parses an `isoDate` value as `` `${value}T00:00:00` `` (local midnight) and anything else with `Date.parse` as-is.

    Update the header comment and `xCandidates`' comment to say "date and datetime columns". Import `WireType` from `../contract`.

19. **`frontend/src/data/serialize.ts`** — the comments at [line 67](frontend/src/data/serialize.ts#L67) and [line 138](frontend/src/data/serialize.ts#L138) list `isoString`; make each `isoString / isoDate / isoTime`. No logic change.

20. **Checkpoint.** `cd frontend && npm run typecheck && npm test`, then `TZ=America/Los_Angeles npm test` and `TZ=Asia/Tokyo npm test`. `grep -rn '"isoString"' frontend/src` — only `contract.ts`, `tableWriteRules.ts` and `chartConfig.ts` (`buildModel.ts` spells the key unquoted). `grep -rn "formatWallClock\|ZONELESS\|zoneless" frontend/src` — zero matches.

### Bookkeeping and manual verification

21. **`TODO.md`** — delete the `date`/`time` bullet under `### Data` ([lines 22-27](TODO.md#L22)). Leave the `ColumnMeta.dataType` known-issue entry as is; it is still accurate.

22. **`LIBRARY_NOTES.md`** — per _Documentation Impact_.

23. **Manual verification** — every case under _Expected Behaviour → Manual_, driven through the running app (see `.claude/skills/verify/SKILL.md` for login and driving), in both browser time zones.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/contract.py` |
| Modify | `backend/app/wire.py` |
| Modify | `backend/tests/test_wire.py` |
| Modify | `backend/app/sql/compiler.py` |
| Modify | `backend/tests/test_compiler.py` |
| Modify | `backend/tests/test_run_query.py` |
| Modify | `backend/app/export_format.py` |
| Modify | `frontend/src/contract.ts` |
| Modify | `frontend/src/data/buildModel.ts` |
| Modify | `frontend/tests/data/buildModel.test.ts` |
| Modify | `frontend/src/data/SqlAdminWriter.ts` |
| Modify | `frontend/tests/data/SqlAdminWriter.test.ts` |
| Modify | `frontend/src/data/stores.ts` |
| Modify | `frontend/src/dock/tableWriteRules.ts` |
| Modify | `frontend/tests/dock/tableWriteRules.test.ts` |
| Modify | `frontend/src/data/chartConfig.ts` |
| Modify | `frontend/tests/data/chartConfig.test.ts` |
| Modify | `frontend/src/data/serialize.ts` |
| Modify | `TODO.md` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

Frontend unit tests must pass in any host time zone. Build expected `Date`s with the local constructor (`new Date(2026, 5, 28)`), never from an ISO string without an offset, and derive expected offsets from `getTimezoneOffset()`. The `TZ=` runs in step 20 prove it.

### Backend — unit-testable (`poetry run python -m pytest`)

`test_wire.py`:

- `pg_type_to_wire`: `timestamp with time zone`, `timestamp without time zone`, `timestamptz`, `timestamp` → `ISO_STRING`; `date` → `ISO_DATE`; `time`, `time without time zone` → `ISO_TIME`; `time with time zone`, `timetz`, `interval` → `STRING` (unchanged since `row-write-changed-fields`).
- `to_wire_value(date(2026,6,28), ISO_DATE) == "2026-06-28"`; `to_wire_value(time(9,30,15,250000), ISO_TIME) == "09:30:15.250000"`.
- `from_wire_value`: every row of the write table under _Architecture Decisions_. A `timestamp` column never returns an aware value.
- `from_wire_filter_operand`: every row of the operand table under _Architecture Decisions_, plus:
  - an `ISO_DATE` operand `"2026-06-28T00:00:00.000+09:00"` → `date(2026,6,28)`;
  - a `Z` operand on `ISO_DATE` → the UTC day;
  - an `ISO_TIME` operand `"1970-01-01T09:30:00.000Z"` → `time(9,30)`;
  - a `timestamptz` operand `"2026-06-28T14:04:00+02:00"` → `datetime(2026,6,28,12,4,tzinfo=utc)`;
  - the existing pass-through, `None`, non-string and unparseable cases keep passing, retargeted to `ISO_DATE`.
- `from_import_scalar`: an `ISO_DATE` / `ISO_TIME` string passes through; a non-string on either raises `ValueError`, as `ISO_STRING` does.

`test_compiler.py`:

- `gt`/`gte`/`lt`/`lte`/`eq`/`neq` on `day` with operand `"2026-06-28T00:00:00.000-07:00"` compile to `"day" {op} $1` with params `[date(2026,6,28)]`, and no `::timestamp` or `::text`.
- Every row of the `date`-filter table under _Architecture Decisions_.
- `gte` on a `timestamp without time zone` column with `"2026-06-28T12:04:00.000-07:00"` compiles to `"logged_at" >= $1` with `[datetime(2026,6,28,12,4)]`.
- The `timestamptz` comparator, contains, is-empty, unparseable and unknown-column cases pass unchanged.

`test_run_query.py`: the short-name mapping listed in step 9.

### Frontend — unit-testable (`npm test`)

- `buildModel` / `buildQueryModel`: `isoDate` → `date`, `isoTime` → `time`, `isoString` → `datetime`.
- `SqlAdminWriter`:
  - every case kept in step 14 still passes: an update sends the diff plus the primary key, a create sends the full row, generated columns are stripped (including an edited one), and `null` is written as `null`;
  - a `date` field set to `new Date(2026, 5, 28)` is written as `"2026-06-28"`, on update and on create;
  - a `datetime` field set to `new Date(2026, 5, 28, 8, 0)` is written as local ISO-8601 with an offset: it starts with `2026-06-28T08:00:00.000` and ends in `±HH:MM` matching `getTimezoneOffset()`, never `Z`.
- `isFilterableColumn`: true for `isoDate` and `isoTime`.
- `chartConfig`:
  - `xCandidates` includes an `isoDate` column and excludes an `isoTime` one;
  - `isTimeX` is true for `isoDate` and false for `isoTime`;
  - `defaultChartConfig` picks an `isoDate` column as x when no `isoString` column precedes it;
  - `buildChartSeries` maps an `isoDate` value `"2026-06-28"` to `new Date(2026, 5, 28).getTime()`, and drops a `null` date.

### Manual — the running app, in two browser time zones

**Setup.** Steps 1-2 done, backend and frontend dev servers restarted after the symlink (a reload is not enough). Log in (see the `verify` skill for the host). Before any case, prove the page runs the branch build: in the console, `performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('typescript-ui'))` must list chunks whose hashed file names exist in `$LIB/packages/lib/dist/lib/`, not in the main checkout's `dist/lib` (when `$LIB` is a worktree). In a Query tab, run these two statements one at a time, then refresh the navigator:

```sql
CREATE TABLE public.tz_probe (
    id serial PRIMARY KEY,
    d date, t time, ts timestamp, tstz timestamptz, note text
);
INSERT INTO public.tz_probe (d, t, ts, tstz, note) VALUES
    ('2026-06-28', '09:30:15.25', '2026-06-28 12:04:59.5',
     '2026-06-28 12:04:59.123456+00', 'a');
```

**Time zones.** Run cases 1-9 twice: once with the browser in `America/Los_Angeles` (UTC-7) and once in `Asia/Tokyo` (UTC+9). Set the zone with DevTools → Sensors → Location → Timezone ID. **Reload the page after every change**: the library caches its date formatters per page. Confirm with `Intl.DateTimeFormat().resolvedOptions().timeZone` in the console.

1. **Display.** Open `public.tz_probe` → Data. In both zones: `d` shows 28 June with no time; `t` shows `09:30`; `ts` shows 28 June 2026, `12:04`; `tstz` shows `05:04` in Los Angeles and `21:04` in Tokyo. No cell is blank.
2. **Edit a date.** Type `2026-09-01` into `d`, commit, Save. The cell keeps `2026-09-01`, with no revert. The PUT body carries `"d": "2026-09-01"`. `SELECT d FROM public.tz_probe` returns `2026-09-01`.
3. **Edit a time.** Set `t` to `14:45` via the picker or by typing, then Save. The PUT body carries `"t": "14:45:00.000"`. The query returns `14:45:00`.
4. **Edit a naive timestamp.** Set `ts` to `2026-06-28 08:00`, then Save. The PUT body carries `"ts": "2026-06-28T08:00:00.000-07:00"` (Los Angeles) or `…+09:00` (Tokyo). The query returns `2026-06-28 08:00:00`, and after a reload the cell shows `08:00`.
5. **Insert.** Add a row with `d` = `2026-12-31` and `t` = `23:59`, then Save. The query returns `2026-12-31` and `23:59:00`.
6. **Date filter.** On `wide.cols_10`, pick "Equals" on `col_006_day` and type `2026-07-02`: that row comes back. "At least" `2026-07-02` returns it and later days, and never 1 July.
7. **Time and naive-timestamp filters.** On `tz_probe`, "Equals" with the exact text `t` currently displays (`HH:MM`) returns the row; so does "Equals" with the date and time `ts` currently displays.
8. **Query results.** Run `SELECT d, t, ts, tstz FROM public.tz_probe`. The result grid and its record view show the same values as case 1. Export CSV: `d` is `2026-06-28`-shaped and `t` is `HH:MM:SS`-shaped, with no time zone.
9. **Chart.** Run `SELECT d, 1 AS n FROM public.tz_probe`. The Chart tab defaults to a line chart with `d` on a time axis, and the point sits on the day `d` shows. Run `SELECT t, 1 AS n FROM public.tz_probe`: `t` is not offered as x.
10. **Import round trip** (either zone). Export `public.tz_probe` as CSV from the Data tab, `DELETE FROM public.tz_probe`, then import the file. Every column reads back identically.
11. **Structure tab.** `public.tz_probe` → Structure. The Wire type column reads `isoDate`, `isoTime`, `isoString`, `isoString` for `d`, `t`, `ts`, `tstz`.
12. **Clean up.** `DROP TABLE public.tz_probe;`

---

## Verification

- **Link**: `readlink -e frontend/node_modules/@jimka/typescript-ui` prints `$LIB/packages/lib`, and the browser's loaded chunk hashes match `$LIB`'s `dist/lib` (Setup under _Manual_).
- **Backend**: `cd backend && poetry run python -m pytest`.
- **Frontend**: `cd frontend && npm run typecheck && npm test`, `TZ=America/Los_Angeles npm test`, `TZ=Asia/Tokyo npm test`.
- `grep -rn "_instant_cast\|_INSTANT_CAST_TYPES\|_DATETIME_TYPES" backend/app` — zero matches.
- `grep -rn "formatWallClock\|ZONELESS\|zoneless" frontend/src` — zero matches.
- `grep -n "buildModel.ts:14" TODO.md` — zero matches (the backlog bullet is gone).
- `git diff --stat -- frontend/package.json frontend/package-lock.json` — empty.
- Manual: the 12 cases above. Entry points: navigator → `public.tz_probe` / `wide.cols_10` → Data / Structure; the Query workspace for cases 8-9.

---

## Documentation Impact

- **`TODO.md`** — the `date`/`time` bullet under `### Data` is deleted (step 21).
- **`LIBRARY_NOTES.md`**:
  - new top entry `## 🐞✅ Store date and time values lost their day and time of day between the grid and the server (0.10.0, symlinked)`. It lists the library defects (the bare-date and `time` `Field` reading, the UTC `Date` wire form, the filter-row date parse), their fix in the typescript-ui plan `store-temporal-local-values` for the next minor, and where the app adopts them (`buildModel.ts`, `SqlAdminWriter.ts`). Follow the existing entries' prose format.
  - the entry `## ✂️🩹🔎 JsonWriter writes every Date as a UTC instant, and its dirty mode cannot be extended (0.10.0)` ([line 94](LIBRARY_NOTES.md#L94)) becomes `## ✂️✅ …`, keeping its title text. Its last paragraph, which says the library fix "is planned in `plans/date-time-column-field-types.md`", is replaced by one saying: fixed by `store-temporal-local-values` (verified symlinked, ships in the next typescript-ui minor); `SqlAdminWriter` now extends `JsonWriter` in `'dirty'` mode and its wall-clock workaround is removed.
- **`README.md`** — no change; it does not list column types.
- **`CHANGELOG.md`** — no entry; written at release time. See [Addendum: Release-note material](#addendum-release-note-material).

---

## Potential Challenges

- **The link targets the wrong tree.** A symlink to the main typescript-ui checkout serves `master`'s build, not the branch's, and every manual case then fails or passes for the wrong reason. Steps 1-2 target `$LIB` and the Setup's chunk-hash check proves it.
- **Stale library build or Vite cache.** The app runs the library's built `dist/lib`. After any library edit, run `npm run build:lib` in `$LIB`, clear `frontend/node_modules/.vite` and restart the Vite dev server.
- **A browser time-zone change needs a page reload.** The library's temporal formatters are built once per page and never follow a zone change.
- **`time '24:00:00'`** is legal in Postgres but has no local `Date`. The library reads it as empty, and the cell shows blank. It is not written back, because the writer only sends changed fields.
- **A naive `timestamp` inside a DST gap**, e.g. `2026-03-08 02:30` in Los Angeles, does not exist locally. The browser shows it one hour later. It is only rewritten if the user edits that cell.
- **Python 3.10's `fromisoformat`** (the local venv; the Docker image runs 3.12) accepts only a 3- or 6-digit fraction. Every value the grid or the export writes has one of those. A hand-written import file with `09:30:15.25` is rejected per row with the existing coercion error.
- **Undoing the link.** `cd frontend && npm install` puts the 0.10.0 registry copy back. Do not run it before the manual cases are done.

---

## Critical Files

| File | Why |
|---|---|
| `/home/jika/typescript/typescript-ui/plans/store-temporal-local-values.md` | The library half this plan depends on; its _Architecture Decisions_ tables are the wire forms the backend is written against. |
| [`plans/implemented/row-write-changed-fields.md`](plans/implemented/row-write-changed-fields.md) | What this plan builds on and partly replaces (the writer, the `timestamp` write rule). |
| [`plans/implemented/date-column-filter-support.md`](plans/implemented/date-column-filter-support.md) | The filter design this plan builds on and partly reverses (its `why-date-cast` footnote). |
| [`backend/app/wire.py`](backend/app/wire.py) | Every backend mapping this plan changes; `_parse_iso_datetime` (161) and `_to_utc` (385) are reused. |
| [`backend/app/contract.py`](backend/app/contract.py) | `WireType` (14): the seam the new members extend. |
| [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) | The comparator branch (183) and the cast being removed. |
| [`frontend/src/data/buildModel.ts`](frontend/src/data/buildModel.ts) | `WIRE_TO_FIELD` (10), the frontend half of the seam. |
| [`frontend/src/data/SqlAdminWriter.ts`](frontend/src/data/SqlAdminWriter.ts) | The writer being rebased onto `JsonWriter`. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts` (in `$LIB`) | `JsonWriter` and its `protected dataFor`, which `SqlAdminWriter` extends. |
| [`.claude/skills/verify/SKILL.md`](.claude/skills/verify/SKILL.md) | Login and driving the app; its _Library changes_ section shows the symlink mechanics (steps 1-2 point the link at `$LIB` instead of the main checkout). |

---

## Non-Goals

- **Any library change.** It is all in `store-temporal-local-values`; a library defect found here goes back to that plan's branch, not into an app workaround.
- **Renaming `isoString`.** It keeps its name and now means "timestamp".[^keep-isostring]
- **Anything `row-write-changed-fields` already did**: changed-fields updates, the `interval`/`timetz` text codecs, and the `timestamp` save failure.
- **Showing seconds in `time` / `datetime` cells.** The library default (`showSeconds: false`) stays, per the project's prefer-library-defaults rule.
- **`infinity` / `-infinity` and BC dates.** asyncpg's decoding of these is unchanged, and Python's `datetime` holds only years 1-9999.
- **Temporal primary keys.** A `Date` primary key goes into the row URL through `String(date)` today. This plan does not change that.
- **A matview column declared with a precision** (`time(3)`, `timestamp(3) with time zone`). It still falls through to `STRING`; that is the existing `TODO.md` known issue.
- **Plotting `time` columns** on a chart axis.[^chart-time]
- **Releasing typescript-ui, or bumping either project's version or dependency range.** `frontend/package.json` stays `^0.10.0`; that is release work, run by hand after this plan's verification.[^no-bump]

---

## Addendum: Release-note material

For SQLAdmin's release-time `CHANGELOG.md` pass, in the release after 0.10.0. Place these under that release's headings, in the file's bold-lead-sentence style.

`### Fixed`
- **`date` cells show the stored day, in every time zone.** A `date` cell showed a time of day, and west of UTC it showed the previous day. Typing a date such as `2026-09-01` into it now sticks instead of reverting.
- **`time` cells show their value.** They were always blank.
- **Filtering a `date` or `timestamp` column works outside UTC.** "Equals" on a `date` column matches the whole day typed, and a `timestamp` filter compares the time you see.

`### Changed`
- **Query results chart a `date` column on a time axis**, with each point on the day the grid shows. A `time` column is not offered as the x axis.

`### Internal`
- Migrated to the next `@jimka/typescript-ui` minor (0.11.0), which sends each date, time and date-time value in its field type's own form.

---

## Notes

[^wire-seam]: `WireType` has not changed since Phase 0 (`git log -- backend/app/contract.py`), but it is the only place the backend tells the frontend what kind of value a column holds. `buildModel.ts`'s module comment names it as the source of every `FieldType`, and `contract.py`'s module docstring says the frontend mirrors the wire set and never Postgres. Keying the frontend on `ColumnMeta.dataType` was rejected for two reasons. No frontend code reads `dataType` for value handling once `SqlAdminWriter`'s zone-less set is gone, and a query result has no `dataType` at all.

[^keep-isostring]: Renaming `isoString` to something like `isoDateTime` would be more precise now that it covers only timestamps. But it would touch every test fixture, both contract files, `chartConfig.ts`, `serialize.ts` and the Structure tab's visible "Wire type" column, and change nothing a user sees. A naive and a zone-aware timestamp can share one wire type because the value tells them apart: only `timestamptz` carries an offset, and `new Date()` reads an offset-less date-time as local, which is how a naive timestamp should display.

[^fix-in-library]: The project rule (memory `fix-in-library-not-workaround`) is that a defect that starts in typescript-ui is fixed there, not worked around in the app. A per-field `convert` hook in `buildModel.ts` would have worked for the read side, but it would leave every other library consumer reading dates a day early west of UTC, and `SqlAdminWriter`'s `formatWallClock` is exactly the kind of app-side workaround the rule retires. The library work was first drafted inside this plan and then split out, so each repo's half can be implemented and committed on its own branch.

[^wall-clock]: For a zone-less Postgres type, what the user saw is the value. The frontend displays a naive timestamp, a date and a time of day as local wall-clock values, so the wall clock in the string is what the user meant. This is also Postgres's own rule: `'2026-06-28 12:04+02'::timestamp` ignores the offset and yields `12:04`. `row-write-changed-fields` converted an offset to UTC first, so that its write rule matched the filter-operand rule of the time. That was the right reading only while the frontend sent UTC (`…Z`) strings or offset-less wall clocks, where both rules agree. With local offsets, converting to UTC would give the UTC wall clock, which is right only for a browser at UTC; it is the "client-offset shift" `date-column-filter-support` listed as a non-goal. Both functions therefore switch together.

[^date-truncate]: `date-column-filter-support` compared a `date` column as `"day"::timestamp` because its operands came from a `datetime` field. "Equals" there was a one-minute range, which truncation would have collapsed to an empty one (its `why-date-cast` footnote). A `date` field's "Equals" is a whole local day, so both bounds truncate to distinct days and the collapse cannot happen. Truncation is also the only form that works in zones whose DST change happens at midnight, such as America/Santiago or America/Havana. There `new Date(y, m, d)` on the change day is 01:00. Under the cast, "At least 6 September" would bind `2026-09-06 01:00` and exclude 6 September itself. Truncated, it binds `date(2026,9,6)`. One behaviour differs, and it is accepted. If a user types a time into a `date` column's "At least" filter (`2026-06-28 15:00`), the truncated form includes the 28th while an exact comparison would not. The cell shows no time, so including the day the user typed is the reading that matches the screen.

[^rebase-writer]: `row-write-changed-fields` could not subclass `JsonWriter` because `dataFor` was `private` in 0.10.0, so `SqlAdminWriter` implemented `Writer` and repeated the dirty-mode rule. It also formatted zone-less timestamps itself, because 0.10.0's `JsonWriter` could only write UTC; `LIBRARY_NOTES.md` logs both as the 🩹 entry this plan flips. Both reasons go away with the library plan. Reusing `JsonWriter` is the precedent the library intends ("only the fields changed since the last commit, plus the primary key"), and it is the only way the app gets the type-based write form. Composition was rejected because `JsonWriter` serializes inside `writeRecord`, so a wrapper could not strip generated columns before serialization without re-implementing it. A generated column can never be dirty, since the grid marks it read-only; the strip is kept for creates and as a guard.

[^chart-time]: The chart library plots x as a number, and a time axis reads it as epoch milliseconds. A `date` value is a day, so local midnight of that day plots where the grid says it is. `Date.parse("2026-06-28")` would plot at UTC midnight, the previous evening west of UTC. A `time` value has no date. Plotting it on 1 January 1970 would label every tick with that date, and a real time-of-day axis is new chart work, not part of this change.

[^no-bump]: Per memory `library-release-gated-on-sqladmin`, a typescript-ui release waits until SQLAdmin has verified it against a symlinked local build, and an app plan never waits on the release. So the library minor is released after this plan's manual verification, by hand. The app then runs `npm install @jimka/typescript-ui@^0.11.0` in `frontend/`, which drops the symlink, moves the range and rewrites the lockfile, and re-runs its checks against the registry copy, as `typescript-ui-0-10-0-upgrade`'s post-release swap addendum did for 0.10.0. Until then `package.json` naming `^0.10.0` while `node_modules` holds the branch build is expected. Per memory `verify-symlink-must-target-worktree`, a link to the main checkout silently serves `master`'s build when the branch lives in a worktree, so the link targets the branch's own tree and the loaded chunk hash is the proof. Version bumps, tags and commits stay manual (memory `release-steps-manual`).

---

## Implementation Notes

- **Library linkage.** No setup step was run: `frontend/node_modules/@jimka/typescript-ui` in the main tree was already a symlink to `/home/jika/typescript/typescript-ui/.worktrees/dialog-escape-releases-tab-owner/packages/lib`, the tip of the unreleased library stack (`4aed63df`), which contains every `store-temporal-local-values` commit (`8caead02` … `be5216ee`). Its `dist/lib` carries `stringifyWithLocalDates` / `toLocalIsoString`. The worktree's `frontend/node_modules` is an untracked symlink to the main tree's. `frontend/package.json` and the lockfile are untouched.
- **Built on what shipped.** The library shipped as the plan assumed: `protected dataFor`, `toWireValues` running on `dataFor`'s result, `+00:00` never `Z`, and `AjaxProxy` writing filter `Date`s with the local offset. No library defect was found.
- **`SqlAdminWriter.dataFor` builds a new object.** It filters `super.dataFor(…)`'s entries with `Object.fromEntries` rather than deleting keys from the returned object, so it does not depend on `getData()` / `getChangedData()` returning copies (they do today).
- **Extra unit cases.** Beyond the plan's list: `test_wire.py` also checks that a `timestamptz` write keeps its `-07:00` instant, the `timestamptz` / `timestamp` `-07:00` filter rows, and that `from_import_scalar` passes and rejects values for all three temporal wire types; `test_run_query.py`'s new case also checks the three values' wire text. `SqlAdminWriter.test.ts` derives the expected `±HH:MM` from `getTimezoneOffset()` via a local `localOffset` helper.
- **Checks.** Backend: `poetry run python -m pytest` 814 passed; `poetry run pyright` 0 errors. Frontend: `npm run typecheck` clean; `npm test` 1131 passed under the host zone (Europe/Stockholm), `TZ=America/Los_Angeles` and `TZ=Asia/Tokyo`. The plan's greps give the expected results (`"isoString"` only in `contract.ts`, `tableWriteRules.ts`, `chartConfig.ts`).
- **How the manual cases were driven.** Backend (`uvicorn`, native, `SQLADMIN_ALLOWED_HOSTS=localhost:5432`) and Vite both ran from this worktree, after clearing `frontend/node_modules/.vite`. Every case was driven by a Puppeteer script against headless `/snap/bin/chromium` with `page.emulateTimezone(…)` — once as `America/Los_Angeles`, once as `Asia/Tokyo`, each a fresh browser, with `Intl.DateTimeFormat().resolvedOptions().timeZone` logged — using real CDP mouse and keyboard input: logging in through the form, double-clicking cells and typing into the cell editors, the toolbar's Add row / Save / Export / Import buttons, the header's right-click *Filter* toggle and each filter cell's operator menu and input, the navigator's right-click *Show ▸ Structure*, and New Query (Alt+N) with Ctrl+Enter in the editor. No store, writer or API was called from the page. Request bodies and filter URLs were read from the page's network events, and database state with `psql` in the `sqladmin-db` container. In every run all of the page's `typescript-ui` resources (127-128) were served from `/@fs/…/.worktrees/dialog-escape-releases-tab-owner/packages/lib/dist/lib/`.
- **Fixture.** `public.tz_probe` was created and, before each zone's run, reset to the plan's single row with `psql`, not through a Query tab; case 10's `DELETE` did go through a Query tab. The table was dropped at the end (case 12).
- **Results, both zones.** 1: `d` `6/28/2026`, `t` `09:30 AM` (the headless browser's `en-US` locale uses a 12-hour clock), `ts` `06/28/2026, 12:04 PM`, `tstz` `05:04 AM` in Los Angeles and `09:04 PM` in Tokyo; no blank cell. 2: the cell kept `9/1/2026`; PUT `{"d":"2026-09-01"}`; the database holds `2026-09-01`. 3: PUT `{"t":"14:45:00.000"}`; `14:45:00`. 4: PUT `{"ts":"2026-06-28T08:00:00.000-07:00"}` (Los Angeles) / `…+09:00` (Tokyo); `2026-06-28 08:00:00`; after a reload the cell shows `08:00 AM`. 5: POST `{"d":"2026-12-31","t":"23:59:00.000"}`; `2026-12-31`, `23:59:00`. 6: on `wide.cols_10`, "Equals" `2026-07-02` sent `gte …T00:00:00.000-07:00` / `lt 2026-07-03T00:00:00.000-07:00` (`+09:00` in Tokyo) and returned the 5 rows of 2 July; "At least" returned 116 rows, the database's count for `>= 2026-07-02`, none earlier. 7: "Equals" with the displayed `02:45 PM` sent the `1970-01-01T14:45…`–`14:46` range and returned row 1 only; "Equals" with the displayed `06/28/2026, 08:00 AM` likewise. 8: the result grid and its record view showed case 1's values; the exported CSV row is `2026-06-28,09:30:15.250000,2026-06-28T12:04:59.500000,2026-06-28T12:04:59.123456+00:00`. 9: the Chart tab defaulted to a line chart with x `d`, its point exactly on the `Jun 28` tick; an extra two-day query (`… UNION ALL SELECT DATE '2026-06-30', 2`) put both points exactly on the `Jun 28` and `Tue 30` midnight ticks; for `SELECT t, 1 AS n` the x options were only `n` and `Row #`. 10 (Los Angeles): Data-tab CSV export, `DELETE` via a Query tab, import of the file; every `d`/`t`/`ts`/`tstz`/`note` value read back identically. `id` came back as 3 and 4, because the import preview drops the serial key column, as it does for every table. 11: Wire type `isoDate`, `isoTime`, `isoString`, `isoString`.
- **Deviation: a `time` filter operand binds as an interval, not a `time`.** The plan's operand table maps an `isoTime` operand to `time(9,30)`. The audit found that this makes "Equals 23:59" on a `time` column match nothing: the library's filter row builds that bucket as `[23:59, next midnight)`, and the upper bound `1970-01-02T00:00…` truncated to `time(0,0)`, so the SQL read `"t" >= 23:59 AND "t" < 00:00`, and "Not equals 23:59" matched every row. The plan's `[^date-truncate]` argument that the two truncated bounds stay distinct holds for `date` only. `from_wire_filter_operand` now returns the wall clock's `timedelta` since 1 January 1970, 00:00, the day the library puts every time-of-day value on (`_TIME_OF_DAY_ANCHOR` in `wire.py`). `FilterCompiler._column` compares the column as `"t"::interval` when every operand is an interval, following its existing `::text` rule, which is also keyed on the operand's type. So the bound becomes `24:00:00`. Unit tests pin the 23:59 bucket in `test_wire.py` and `test_compiler.py`. It was verified live through the header filter row in `America/Los_Angeles` and in `Asia/Tokyo`, on a table holding `09:30:15.25` and `23:59:00`. "Equals" with the displayed `11:59 PM` returned only the 23:59 row, "Not equals" returned only the other row, and "Equals" with `09:30 AM` returned only the 09:30 row.
- **Chart tab refresh.** A re-run leaves the Chart tab on its previous result until the *Chart the results* button is pressed again (`QueryPanel.showChart`, by design); case 9's re-runs press it.
- **Headless downloads.** Snap Chromium cannot write into `/tmp` (the snap has its own `/tmp`), so the export downloads went to `~/snap/chromium/common/`, and were deleted afterwards.
