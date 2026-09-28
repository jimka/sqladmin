---
depends-on: [date-column-filter-support]
touches-shared:
  - backend/app/contract.py
  - backend/app/wire.py
  - backend/app/connections.py
  - backend/app/sql/compiler.py
  - frontend/src/contract.ts
  - frontend/src/data/buildModel.ts
  - frontend/src/data/SqlAdminWriter.ts
  - frontend/src/dock/tableWriteRules.ts
  - TODO.md
  - LIBRARY_NOTES.md
  - ../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts
  - ../typescript-ui/packages/lib/docs/reference/changelog/next.md
  - ../typescript-ui/packages/lib/docs/reference/migration/next.md
---

# Date & Time Column Field Types — Implementation Plan

## Overview

Every Postgres temporal column reaches the frontend as one wire type, `isoString` ([`contract.py:24`](backend/app/contract.py#L24)), which [`buildModel.ts:14`](frontend/src/data/buildModel.ts#L14) maps to the library's `datetime` field type. That single mapping causes four visible bugs today:

- A `date` cell shows a time of day it does not have, and west of UTC it shows the previous day.
- A `time` cell is always blank: the library's `Field` parses the value with `new Date("09:30:00")`, which is an Invalid Date, so the field stores `undefined`.
- Typing a bare `2026-09-01` into a `date` cell reverts silently, because typescript-ui 0.10.0's date-time editor only accepts `YYYY-MM-DD H:MM`.
- Saving any edit on a row with a `timestamp without time zone` column fails. The grid sends every column back as a UTC instant, the backend binds it as a timezone-aware `datetime`, and asyncpg refuses an aware value for a `timestamp` parameter (probed against the dev database: `DataError … can't subtract offset-naive and offset-aware datetimes`).

The same full-row save also truncates a `timestamptz` value's microseconds to milliseconds on every edit of any other cell in the row, because a JS `Date` only holds milliseconds.

This plan gives `date` and `time` their own wire types and field types, sends `timetz` and `interval` as Postgres text, and makes the value cross the wire in both directions without losing its day, its wall-clock time, or precision nobody edited. It spans three places:

- **typescript-ui** (sibling repo, lands first): `Field` reads a bare date / time of day as a local value, `JsonWriter` and `AjaxProxy` send a `Date` with its local offset, and the filter row reads a typed date as a local day.
- **backend**: the wire contract, the read/write/filter mappings in [`wire.py`](backend/app/wire.py), two text codecs in [`connections.py`](backend/app/connections.py), and the `date` filter comparison in [`compiler.py`](backend/app/sql/compiler.py).
- **frontend**: the wire-type union, the field-type map, a changed-fields-only writer, the filterable set, and the chart's time axis.

It replaces the backlog bullet in [`TODO.md:20`](TODO.md#L20). It builds on the shipped [`date-column-filter-support`](plans/implemented/date-column-filter-support.md) plan and changes two of that plan's decisions; both are called out below.

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
| `time with time zone` | `string` | `09:30:00+02` | `string` |
| `interval` | `string` | `1 mon 2 days 03:04:05` | `string` |

A query result carries only `{name, wireType}` per column, never the Postgres type, so this split has to live in the wire type rather than in `ColumnMeta.dataType`.

### `timetz` and `interval` are read and written as Postgres text

`_init_connection` ([`connections.py:78`](backend/app/connections.py#L78)) registers a text codec for `interval` and `timetz`, the same way it already registers the `json`/`jsonb` codec. asyncpg then returns Postgres's own text for both, and accepts text for writes and filter operands. `pg_type_to_wire` maps both to `STRING`, so the grid shows and edits them as plain text.[^text-codec]

### The library reads a bare date or time of day as a local value

`Field` ([`Field.ts:190`](../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts#L190)) converts every temporal value with `new Date(raw)`. That reads `2026-06-28` as UTC midnight and cannot read `09:30:00` at all. The library's own `DateField` and date cell editor already read `YYYY-MM-DD` as local midnight, so the data layer disagrees with the components built on it. This is a library defect, fixed in the library.[^fix-in-library]

| Field type | Raw value | Before | After |
|---|---|---|---|
| `date` | `"2026-06-28"` | UTC midnight (27 June, 17:00 in Los Angeles) | 28 June, 00:00 local |
| `time` | `"09:30:15.250000"` | `undefined` | 1 January 1970, 09:30:15.250 local |
| `time` | `"09:30"` | `undefined` | 1 January 1970, 09:30:00.000 local |
| `date` | `"2026-06-28T12:04:00Z"` | that instant | that instant (unchanged fallback) |
| `datetime` | any string | `new Date(raw)` | unchanged |

`1970-01-01` is the date every `time` value already sits on: the library's time cell editor and filter row both build `new Date(1970, 0, 1, h, m, s)`.

### A `Date` crosses the wire as local ISO-8601 with its offset

`JsonWriter` and `AjaxProxy`'s `filter=` parameter serialize a `Date` as the local date and time plus the local UTC offset, instead of `Date.toISOString()`'s UTC form. It is the same instant, so any ISO parser reads it as before. It also carries the calendar day and wall-clock time the user saw, which a UTC string loses.[^local-offset]

| Browser zone | `Date` (local) | Before | After |
|---|---|---|---|
| `America/Los_Angeles` | 28 June 2026, 00:00 | `2026-06-28T07:00:00.000Z` | `2026-06-28T00:00:00.000-07:00` |
| `Asia/Tokyo` | 28 June 2026, 00:00 | `2026-06-27T15:00:00.000Z` | `2026-06-28T00:00:00.000+09:00` |
| `Asia/Kolkata` | 1 January 1970, 09:30 | `1970-01-01T04:00:00.000Z` | `1970-01-01T09:30:00.000+05:30` |
| `UTC` | 28 June 2026, 12:04:59.123 | `2026-06-28T12:04:59.123Z` | `2026-06-28T12:04:59.123+00:00` |

An Invalid `Date` still serializes as `null`, as `JSON.stringify` does today.

### The backend reads a zone-less column from the wall clock and `timestamptz` from the instant

For `date`, `time` and `timestamp without time zone`, the backend takes the date and time written in the string and drops the offset without converting. For `timestamptz` it keeps the instant. This rule applies to row writes (`from_wire_value`) and filter operands (`from_wire_filter_operand`) alike.[^wall-clock] For filter operands it replaces `date-column-filter-support`'s rule, which converted a zone-less operand to UTC before dropping the offset.

Writes (`from_wire_value`):

| Column | Value sent | Bound |
|---|---|---|
| `timestamptz` | `2026-06-28T12:04:00.000-07:00` | `datetime(2026,6,28,12,4,tzinfo=-07:00)` (= 19:04 UTC) |
| `timestamp` | `2026-06-28T12:04:00.000-07:00` | `datetime(2026,6,28,12,4)` |
| `timestamp` | `2026-06-28T12:04:59` (import file) | `datetime(2026,6,28,12,4,59)` |
| `timestamp` | `2026-06-28T12:04:00.000Z` (older client) | `datetime(2026,6,28,12,4)` |
| `date` | `2026-06-28T00:00:00.000+09:00` | `date(2026,6,28)` |
| `date` | `2026-06-28` (import file) | `date(2026,6,28)` |
| `time` | `1970-01-01T09:30:00.000-08:00` | `time(9,30)` |
| `time` | `09:30:15.250000` (import file) | `time(9,30,15,250000)` |
| `timetz` / `interval` | `09:30:00+02` / `1 mon 2 days` | the string, unchanged |

Filter operands (`from_wire_filter_operand`), browser in `America/Los_Angeles`:

| Column | Operand sent | Bound |
|---|---|---|
| `timestamptz` | `2026-06-28T12:04:00.000-07:00` | `datetime(2026,6,28,19,4,tzinfo=utc)` |
| `timestamp` | `2026-06-28T12:04:00.000-07:00` | `datetime(2026,6,28,12,4)` |
| `date` | `2026-06-28T00:00:00.000-07:00` | `date(2026,6,28)` |
| `time` | `1970-01-01T09:30:00.000-08:00` | `time(9,30)` |
| `timetz` / `interval` | `"09:30"` / `"1 day"` | the string, compared as text |

### A `date` filter operand is truncated to its day

This reverses `date-column-filter-support`'s _A `date` column is compared as an instant_. `from_wire_filter_operand` returns a `datetime.date` for an `isoDate` column, and `FilterCompiler` drops its `::timestamp` cast, so `"day" >= $1` binds a `date`.[^date-truncate]

The filter row now builds "Equals" on a `date` column as one whole local day:

| Header cell (Los Angeles) | Descriptor sent | Compiled |
|---|---|---|
| `day` Equals `2026-06-28` | `and(gte 2026-06-28T00:00:00.000-07:00, lt 2026-06-29T00:00:00.000-07:00)` | `("day" >= $1 AND "day" < $2)`, params `[date(2026,6,28), date(2026,6,29)]` |
| `day` At least `2026-06-28` | `gte 2026-06-28T00:00:00.000-07:00` | `"day" >= $1`, params `[date(2026,6,28)]` |

### The filter row reads a typed date as a local day

`parseOperand`'s `date` case in [`ColumnFilter.ts:319`](../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts#L319) tries `parseIsoDate` before `new Date(text)`. Without it, `2026-06-28` typed into a `date` column's filter becomes UTC midnight, and `displayBucket` then builds the bucket around 27 June west of UTC. This is the same library defect as `Field`'s, in a second place.

### `SqlAdminWriter` sends only the changed fields on an update

`SqlAdminWriter` extends the library's `JsonWriter` in `'dirty'` mode and keeps stripping generated columns. An update then carries the edited cells plus the primary key, so a column nobody edited is never rewritten.[^dirty-writer] The backend's `UpdateRowCommand` ([`update_row.py:56`](backend/app/operations/update_row.py#L56)) already assigns only the keys a payload carries. A create still sends the full record.

The library change this needs is small: `JsonWriter.dataFor` goes from `private` to `protected` so a subclass can post-process it.

### Charts plot `isoDate` on the time axis at local midnight, and never offer `isoTime`

[`chartConfig.ts`](frontend/src/data/chartConfig.ts) accepts `isoString` and `isoDate` as time-axis columns. It parses an `isoDate` value as local midnight so the point sits on the day the grid shows. An `isoTime` column is not an x-axis candidate.[^chart-time]

### Library work lands first, on a branch, with no version bump

The library changes go on `feature/date-time-wire-values` in `/home/jika/typescript/typescript-ui`, the checkout SQLAdmin's `node_modules/@jimka/typescript-ui` symlink already targets. `frontend/package.json`'s range is not touched.[^no-bump] This mirrors the library-first step order in [`plans/implemented/diagram-depth-limit-and-expand-indicator.md`](plans/implemented/diagram-depth-limit-and-expand-indicator.md).

---

## Public API

### Library — `packages/lib/src/typescript/lib/data/proxy/Writer.ts`

```ts
export class JsonWriter implements Writer {
    // was `private`; now overridable. Body unchanged.
    protected dataFor(record: ModelRecord, operation?: WriteOperation): Record<string, any>;
}
```

### Library — `packages/lib/src/typescript/lib/data/temporalValue.ts` (new, `@internal`, not in the barrel)

```ts
/** Moved verbatim from component/input/dateMath.ts, with its ISO_DATE regex. */
export function parseIsoDate(raw: string): Date | null;

/** `HH:MM[:SS[.fraction]]` at local 1970-01-01, millisecond precision; null otherwise. */
export function parseIsoTimeOfDay(raw: string): Date | null;

/** The local-value reading `Field` applies before its `new Date(raw)` fallback. */
export function parseLocalTemporal(type: TemporalFieldType, raw: string): Date | null;

/** `YYYY-MM-DDTHH:MM:SS.sss±HH:MM` in the host's local zone. */
export function toLocalIsoString(date: Date): string;

/** `JSON.stringify(value)`, except every valid `Date` becomes `toLocalIsoString(date)`. */
export function stringifyWithLocalDates(value: unknown): string;
```

`component/input/dateMath.ts` imports `parseIsoDate` from `~/data/temporalValue.js` and re-exports it. The import is needed as well as the export, because `parseIsoDateTime` in the same file still calls `parseIsoDate`. Its importers — `DateField` and the date cell editor — are unchanged.

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

---

## Internal Structure

### Library — `temporalValue.ts`

```ts
// `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.fraction` — the forms Postgres and
// Python's isoformat() write a time of day in. Two-digit parts only: this reads
// stored values, not typed text (typed text goes through dateMath's
// parseClockTime, which also accepts `9:5`).
const ISO_TIME_OF_DAY = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;
```

`parseIsoTimeOfDay` rejects hours ≥ 24, minutes ≥ 60 and seconds ≥ 60, then returns `new Date(1970, 0, 1, h, m, s, ms)`. `ms` is the fraction right-padded with zeros and cut to three digits. Name the three range bounds and the millisecond digit count as constants with a one-line reason each, per the magic-number rule.

| Raw | Result |
|---|---|
| `"09:30"` | 1970-01-01 09:30:00.000 local |
| `"09:30:15.25"` | 1970-01-01 09:30:15.250 local |
| `"09:30:15.123456"` | 1970-01-01 09:30:15.123 local |
| `"24:00:00"` | `null` |
| `"9:30"` | `null` |
| `"09:30:00+02"` | `null` |

```ts
export function parseLocalTemporal(type: TemporalFieldType, raw: string): Date | null {
    switch (type) {
        case 'date':
            return parseIsoDate(raw);

        case 'time':
            return parseIsoTimeOfDay(raw);

        case 'datetime':
            return null;
    }
}
```

`toLocalIsoString` builds the text from the local getters (`getFullYear` … `getMilliseconds`) and `getTimezoneOffset()`. The offset sign is inverted: `getTimezoneOffset()` is positive west of UTC. An offset of zero prints `+00:00`, never `Z`, so every value has the same shape.

`stringifyWithLocalDates` needs the replacer's `this`, because `JSON.stringify` calls `Date.prototype.toJSON` before the replacer sees the value. It is therefore a `function` expression, not an arrow; say so in a comment:

```ts
export function stringifyWithLocalDates(value: unknown): string {
    return JSON.stringify(value, function (this: Record<string, unknown>, key: string, serialized: unknown): unknown {
        const raw = this[key];

        return raw instanceof Date && !Number.isNaN(raw.getTime()) ? toLocalIsoString(raw) : serialized;
    });
}
```

### Library — `Field.convertByType`

Inside this case `this._type` is one of the three temporal types, so it can be passed to `parseLocalTemporal` as a `TemporalFieldType` (imported as a type from `~/data/temporalText.js`).

```ts
case 'date':
case 'datetime':
case 'time': {
    if (raw instanceof Date) {
        return raw;
    }

    const local = typeof raw === 'string' ? parseLocalTemporal(this._type, raw) : null;

    if (local) {
        return local;
    }

    const date = new Date(raw);

    return isNaN(date.getTime()) ? undefined : date;
}
```

### Backend — `wire.py` constants

Replace `_DATETIME_TYPES` ([`wire.py:33`](backend/app/wire.py#L33)) and the `_DATE_TYPES` / `_TIME_TYPES` / `_TIMETZ_TYPES` / `_TIMESTAMPTZ_TYPES` block ([`wire.py:55-62`](backend/app/wire.py#L55)) with:

```python
_TIMESTAMP_TYPES = frozenset(
    {"timestamp with time zone", "timestamp without time zone", "timestamp", "timestamptz"}
)
_TIMESTAMPTZ_TYPES = frozenset({"timestamp with time zone", "timestamptz"})
_DATE_TYPES = frozenset({"date"})
_TIME_TYPES = frozenset({"time", "time without time zone"})
# Read and written as Postgres's own text: connections._init_connection
# registers a text codec for each (by its pg_catalog name, `interval`/`timetz`).
_POSTGRES_TEXT_TYPES = frozenset({"interval", "time with time zone", "timetz"})
_TEMPORAL_WIRE_TYPES = frozenset({WireType.ISO_STRING, WireType.ISO_DATE, WireType.ISO_TIME})
```

### Backend — `wire.py` functions

```python
def _wall_clock(text: str) -> datetime.datetime:
    """
    The naive date-time an ISO string names: its offset, if any, is dropped
    without converting, so "12:04-07:00" stays 12:04.
    """
    return _parse_iso_datetime(text).replace(tzinfo=None)
```

`pg_type_to_wire` — replace the single `_DATETIME_TYPES` check ([`wire.py:85`](backend/app/wire.py#L85)) with four, in this order:

```python
if dt in _TIMESTAMP_TYPES:
    return WireType.ISO_STRING

if dt in _DATE_TYPES:
    return WireType.ISO_DATE

if dt in _TIME_TYPES:
    return WireType.ISO_TIME

if dt in _POSTGRES_TEXT_TYPES:
    return WireType.STRING
```

`to_wire_value` ([`wire.py:144`](backend/app/wire.py#L144)): `if wire_type in _TEMPORAL_WIRE_TYPES: return value.isoformat()`.

`from_wire_value` — replace the `ISO_STRING` branch ([`wire.py:196-203`](backend/app/wire.py#L196)):

```python
if wire_type is WireType.ISO_DATE:
    # The first ten characters are the calendar day in both forms that arrive:
    # a bare "YYYY-MM-DD" (import) and a local-offset date-time (the grid).
    return datetime.date.fromisoformat(value[:10])

if wire_type is WireType.ISO_TIME:
    return _wall_clock(value).time() if "T" in value else datetime.time.fromisoformat(value)

if wire_type is WireType.ISO_STRING:
    moment = _parse_iso_datetime(value)

    return moment if data_type in _TIMESTAMPTZ_TYPES else moment.replace(tzinfo=None)
```

`from_import_scalar` ([`wire.py:319`](backend/app/wire.py#L319)): the `ISO_STRING` test becomes `wire_type in _TEMPORAL_WIRE_TYPES`; the message is unchanged.

`from_wire_filter_operand` ([`wire.py:381`](backend/app/wire.py#L381)) — new body; rewrite the docstring's bullet list to match the operand table under _Architecture Decisions_:

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

### Backend — `connections.py`

```python
# asyncpg decodes these to Python values that lose information or have no
# frontend field type: `interval` becomes a timedelta (a month becomes 30 days),
# `timetz` a time whose offset nothing in the grid can show or edit. Both are
# read and written as Postgres's own text instead; wire.pg_type_to_wire maps
# them to WireType.STRING to match.
_TEXT_DECODED_TYPES = ("interval", "timetz")
```

In `_init_connection`, after the json loop:

```python
for typename in _TEXT_DECODED_TYPES:
    await conn.set_type_codec(
        typename, encoder=str, decoder=str, schema="pg_catalog", format="text"
    )
```

---

## Ordered Implementation Steps

### Library — `/home/jika/typescript/typescript-ui` (first; the app typechecks against the built output)

1. **Branch.** In `/home/jika/typescript/typescript-ui`, create `feature/date-time-wire-values` from **local** `master` (local `master` is ahead of `origin`). Confirm the app links this checkout: `readlink -e /home/jika/typescript/sqladmin/frontend/node_modules/@jimka/typescript-ui` must print `/home/jika/typescript/typescript-ui/packages/lib`.

2. **`packages/lib/tests/unit/data/temporalValue.test.ts`** (new) — cases from _Expected Behaviour → Library_ for `parseIsoTimeOfDay`, `parseLocalTemporal`, `toLocalIsoString`, and `stringifyWithLocalDates`. Red (module missing).

3. **`packages/lib/src/typescript/lib/data/temporalValue.ts`** (new) — move `ISO_DATE` ([`dateMath.ts:152`](../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts#L152)) and `parseIsoDate` ([`dateMath.ts:208`](../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts#L208)) here verbatim with their comments, then add the four new functions per _Internal Structure_. Mark every export `@internal — not re-exported from the package barrel.`, as `dateMath.ts` does.

4. **`packages/lib/src/typescript/lib/component/input/dateMath.ts`** — delete the moved `ISO_DATE` and `parseIsoDate`. Add `import { parseIsoDate } from "~/data/temporalValue.js";` and `export { parseIsoDate };` — a bare `export … from` would leave `parseIsoDateTime` ([line 296](../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts#L296)) with no local binding. Fix the comment at [line 167](../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts#L167) ("ISO_DATE above reads back exactly four") to name `parseIsoDate` in `data/temporalValue.ts`. Run `npm test` — step 2 green, and the `DateField` / `DateTimeField` / cell-editor suites still green.

5. **`packages/lib/tests/unit/data/Field.test.ts`** — replace the case at [line 43](../typescript-ui/packages/lib/tests/unit/data/Field.test.ts#L43), which pins UTC midnight, with the `Field` cases from _Expected Behaviour_. Then change `convertByType` in **`data/Field.ts`** ([line 190](../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts#L190)) per _Internal Structure_. Green.

6. **`packages/lib/tests/unit/data/proxy/Writer.test.ts`** and **`AjaxProxy.test.ts`** — add the `Date` serialization cases from _Expected Behaviour_. Then in **`data/proxy/Writer.ts`**: `writeRecord` ([line 106](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts#L106)) and `writeRecords` ([line 118](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts#L118)) call `stringifyWithLocalDates` instead of `JSON.stringify`; `dataFor` ([line 131](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts#L131)) becomes `protected`. Update the class JSDoc ("producing `JSON.stringify(record.getData())`") to say a `Date` is written with its local offset. In **`data/proxy/AjaxProxy.ts`**, the `filter` parameter ([line 188](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts#L188)) uses `stringifyWithLocalDates`; leave `sort` ([line 184](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts#L184)) alone, since sorters carry no values. Green.

7. **`packages/lib/tests/component/table/ColumnFilter.test.ts`** — add the filter-row case from _Expected Behaviour_. Then in **`component/table/ColumnFilter.ts`**, split `'date'` out of the shared `'date' | 'datetime'` case of `parseOperand` ([line 319](../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts#L319)). The new `'date'` case returns `parseIsoDate(text)` when that is non-null, and otherwise falls back to the existing `new Date(text)` logic. Import `parseIsoDate` from `~/data/temporalValue.js`. Green.

8. **Docs** — per _Documentation Impact → Library_: `docs/data/model.md`, `docs/data/proxy.md`, `docs/reference/changelog/next.md`, `docs/reference/migration/next.md`.

9. **Checkpoint.** From `/home/jika/typescript/typescript-ui`: `npm test`; `TZ=America/Los_Angeles npm test`; `TZ=Asia/Kolkata npm test`; `npm run lint`; `npm run docs:api` (zero warnings — the new module is `@internal`, so public JSDoc must not `{@link}` it); `npm run docs:llms:check` (run `npm run docs:llms` if it reports drift); then **`npm run build:lib`** (not `npm run build`). The app cannot typecheck against `JsonWriter.dataFor` until `build:lib` succeeds.

### Backend — `sqladmin/backend` (test-first; run as `poetry run python -m pytest` from the worktree)

10. **`backend/tests/test_wire.py`** — update and add cases per _Expected Behaviour → Backend_:
    - the `test_pg_type_to_wire` table ([line 27](backend/tests/test_wire.py#L27));
    - `test_from_wire_date_and_time` ([line 152](backend/tests/test_wire.py#L152)) and `test_from_wire_date_accepts_full_datetime_string` move to `ISO_DATE` / `ISO_TIME`;
    - the filter-operand block ([lines 182-265](backend/tests/test_wire.py#L182)): the `date` and `time` rows move to the new wire types and new results;
    - delete `test_from_wire_filter_operand_date_keeps_time_of_day` (its premise is reversed: a `date` operand is now truncated) and `test_from_wire_filter_operand_time_with_tz_is_aware` (a `timetz` column is now `STRING`); add the `STRING` pass-through case from _Expected Behaviour_ in their place.

    Red.

11. **`backend/app/contract.py`** — add `ISO_DATE` / `ISO_TIME` and reword the `ISO_STRING` comment ([line 24](backend/app/contract.py#L24)) per _Public API_.

12. **`backend/app/wire.py`** — constants, `_wall_clock`, `pg_type_to_wire`, `to_wire_value`, `from_wire_value`, `from_import_scalar`, and `from_wire_filter_operand` per _Internal Structure_. Delete `_DATETIME_TYPES` and `_TIMETZ_TYPES`. Update the module docstring's `from_wire_filter_operand` bullet ([line 10](backend/app/wire.py#L10)) so it no longer says the mapping differs from the write path only for "a temporal column". Run `tests/test_wire.py` — green.

13. **`backend/tests/test_compiler.py`** — `TEMPORAL_COLS` ([line 18](backend/tests/test_compiler.py#L18)) gives `day` `WireType.ISO_DATE`. Rewrite the three `date` tests (`test_filter_comparators_on_date_column_cast_to_timestamp`, `test_filter_equals_range_on_date_column`, `test_filter_at_least_on_date_column`) to the uncast form and `date` params in the `date`-filter table. Rename the first to `test_filter_comparators_on_date_column_bind_a_date`. Add `col("logged_at", WireType.ISO_STRING, data_type="timestamp without time zone")` to `TEMPORAL_COLS` and its offset case. Red.

14. **`backend/app/sql/compiler.py`** — delete `_INSTANT_CAST_TYPES` and its comment ([lines 20-23](backend/app/sql/compiler.py#L20)) and `_instant_cast` ([line 153](backend/app/sql/compiler.py#L153)). The comparator branch ([line 186](backend/app/sql/compiler.py#L186)) becomes `col = self._column(field, [value])`. Green. `grep -n "_instant_cast\|::timestamp" backend/app/sql/compiler.py` — zero matches.

15. **`backend/tests/test_connections.py`** — add one test: `_init_connection` with a recording fake connection registers `json`/`jsonb` with `json.dumps`/`json.loads`, and `interval`/`timetz` with `str`/`str` and `format="text"`, all under `schema="pg_catalog"`. Then edit **`backend/app/connections.py`** per _Internal Structure_, and extend `_init_connection`'s docstring by one sentence naming the text codecs. Green.

16. **`backend/tests/test_run_query.py`** — beside the case at [line 125](backend/tests/test_run_query.py#L125), add one whose attributes are `date`, `time`, `timetz`, `timestamp`, `interval`, expecting `isoDate`, `isoTime`, `string`, `isoString`, `string`. No source change: `_query_columns` already goes through `pg_type_to_wire`.

17. **`backend/app/export_format.py`** — the comment at [line 106](backend/app/export_format.py#L106) lists `isoString`; make it `isoString / isoDate / isoTime`. No logic change.

18. **Checkpoint.** `cd backend && poetry run python -m pytest` — whole suite green. `grep -rn "_DATETIME_TYPES\|_TIMETZ_TYPES" backend/app` — zero matches.

### Frontend — `sqladmin/frontend` (needs step 9's `build:lib`)

19. **Worktree prerequisite.** If `frontend/node_modules` is missing in the worktree, symlink it: `ln -s /home/jika/typescript/sqladmin/frontend/node_modules frontend/node_modules`. Never commit the link.

20. **`frontend/src/contract.ts`** — add `"isoDate"` and `"isoTime"` to `WireType` ([line 32](frontend/src/contract.ts#L32)), each with a one-line comment naming its Postgres type.

21. **`frontend/tests/data/buildModel.test.ts`** — add `isoDate` → `date` and `isoTime` → `time` columns to both existing cases. Then **`frontend/src/data/buildModel.ts`** — add `isoDate: "date"` and `isoTime: "time"` to `WIRE_TO_FIELD` ([line 10](frontend/src/data/buildModel.ts#L10)). `Record<WireType, FieldType>` makes a missed entry a type error.

22. **`frontend/tests/data/SqlAdminWriter.test.ts`** — keep the four existing cases, which call `writeRecord(record)` with no operation and so still get the full record. Add the update/create/`Date` cases from _Expected Behaviour_. Then rewrite **`frontend/src/data/SqlAdminWriter.ts`** per _Public API_: it extends `JsonWriter`, calls `super({ mode: "dirty" })`, overrides `dataFor` to run `super.dataFor(...)` through the existing `strip`, and drops its own `writeRecord`/`writeRecords`. Rewrite the file header: generated columns are still stripped, an update now sends only the changed fields plus the primary key, and a `Date` is written with its local offset by the base class. `stores.ts` ([line 31](frontend/src/data/stores.ts#L31)) is unchanged.

23. **`frontend/tests/dock/tableWriteRules.test.ts`** — add `"isoDate"` and `"isoTime"` to the `isFilterableColumn` true list ([line 111](frontend/tests/dock/tableWriteRules.test.ts#L111)). Then **`frontend/src/dock/tableWriteRules.ts`** — add both to `FILTERABLE_WIRE_TYPES` ([line 31](frontend/src/dock/tableWriteRules.ts#L31)), and update the two doc comments that list the filterable wire types ([line 33](frontend/src/dock/tableWriteRules.ts#L33) and [line 53](frontend/src/dock/tableWriteRules.ts#L53)).

24. **`frontend/tests/data/chartConfig.test.ts`** — add the chart cases from _Expected Behaviour_. Then in **`frontend/src/data/chartConfig.ts`**:
    - add a module constant `TIME_AXIS_WIRE_TYPES: ReadonlySet<WireType> = new Set(["isoString", "isoDate"])`;
    - replace the three `wireType === "isoString"` tests ([lines 37, 55, 70](frontend/src/data/chartConfig.ts#L37)) with `TIME_AXIS_WIRE_TYPES.has(c.wireType)`;
    - replace the `Date.parse` in `toX` ([line 96](frontend/src/data/chartConfig.ts#L96)) with a module-private `toEpochMs(value, wireType)`. It parses an `isoDate` value as `` `${value}T00:00:00` `` (local midnight) and anything else as-is.

    Update the header comment and `xCandidates`' comment to say "date and datetime columns". Import `WireType` from `../contract`.

25. **`frontend/src/data/serialize.ts`** — the comment at [line 67](frontend/src/data/serialize.ts#L67) lists `isoString`; make it `isoString / isoDate / isoTime`. No logic change.

26. **Checkpoint.** `cd frontend && npm run typecheck && npm test`, then `TZ=America/Los_Angeles npm test` and `TZ=Asia/Tokyo npm test`. `grep -rn '"isoString"' frontend/src` — only `contract.ts`, `tableWriteRules.ts` and `chartConfig.ts` (`buildModel.ts` spells the key unquoted).

### Docs and manual verification

27. **`TODO.md`** — delete the `date`/`time` bullet ([lines 20-25](TODO.md#L20)). Leave the `ColumnMeta.dataType` known-issue entry as is; it is still accurate.

28. **`LIBRARY_NOTES.md`** — add a `🐞✅` entry at the top, per _Documentation Impact_.

29. **Manual verification** — every case under _Expected Behaviour → Manual_, driven through the running app (see `.claude/skills/verify/SKILL.md`), in both browser time zones.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `../typescript-ui/packages/lib/src/typescript/lib/data/temporalValue.ts` |
| Create | `../typescript-ui/packages/lib/tests/unit/data/temporalValue.test.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts` |
| Modify | `../typescript-ui/packages/lib/tests/unit/data/Field.test.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts` |
| Modify | `../typescript-ui/packages/lib/tests/unit/data/proxy/Writer.test.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts` |
| Modify | `../typescript-ui/packages/lib/tests/unit/data/proxy/AjaxProxy.test.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/table/ColumnFilter.test.ts` |
| Modify | `../typescript-ui/packages/lib/docs/data/model.md` |
| Modify | `../typescript-ui/packages/lib/docs/data/proxy.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog/next.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/migration/next.md` |
| Modify | `backend/app/contract.py` |
| Modify | `backend/app/wire.py` |
| Modify | `backend/tests/test_wire.py` |
| Modify | `backend/app/sql/compiler.py` |
| Modify | `backend/tests/test_compiler.py` |
| Modify | `backend/app/connections.py` |
| Modify | `backend/tests/test_connections.py` |
| Modify | `backend/tests/test_run_query.py` |
| Modify | `backend/app/export_format.py` |
| Modify | `frontend/src/contract.ts` |
| Modify | `frontend/src/data/buildModel.ts` |
| Modify | `frontend/tests/data/buildModel.test.ts` |
| Modify | `frontend/src/data/SqlAdminWriter.ts` |
| Modify | `frontend/tests/data/SqlAdminWriter.test.ts` |
| Modify | `frontend/src/dock/tableWriteRules.ts` |
| Modify | `frontend/tests/dock/tableWriteRules.test.ts` |
| Modify | `frontend/src/data/chartConfig.ts` |
| Modify | `frontend/tests/data/chartConfig.test.ts` |
| Modify | `frontend/src/data/serialize.ts` |
| Modify | `TODO.md` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

Frontend and library unit tests must pass in any host time zone. Build expected `Date`s with the local constructor (`new Date(2026, 5, 28)`), never from an ISO string, and derive expected offsets from `getTimezoneOffset()`. The `TZ=` runs in steps 9 and 26 prove it.

### Library — unit-testable

`temporalValue.test.ts`:

- `parseIsoTimeOfDay`: every row of the time-of-day table under _Internal Structure_.
- `parseLocalTemporal('date', "2026-06-28")` equals `new Date(2026, 5, 28)`; `('date', "2026-02-30")` is `null`; `('date', "2026-06-28T00:00:00Z")` is `null`; `('datetime', "2026-06-28")` is `null`.
- `toLocalIsoString(new Date(2026, 5, 28, 12, 4, 59, 123))` starts with `2026-06-28T12:04:59.123` and ends with the offset computed from `getTimezoneOffset()` as `±HH:MM`. A host at UTC gives `+00:00`, never `Z`.
- `toLocalIsoString(new Date(999, 0, 1))` starts with `0999-01-01T00:00:00.000`.
- `stringifyWithLocalDates({ d: new Date(2026, 5, 28), n: 1, s: "x", nil: null })` parses back to `{ d: toLocalIsoString(…), n: 1, s: "x", nil: null }`. A nested array of `Date`s is converted too. An Invalid `Date` becomes `null`. A top-level `Date` becomes a JSON string.

`Field.test.ts`:

- A `date` field converts `"2026-06-28"` to a `Date` equal to `new Date(2026, 5, 28)`.
- A `time` field converts `"09:30:15.250000"` to `new Date(1970, 0, 1, 9, 30, 15, 250)`.
- A `date` field still converts `"2026-06-28T12:04:00Z"` through `new Date(...)`, and still maps `"not-a-date"` to `undefined`.
- A `datetime` field converts `"2026-06-28T12:04:00"` to `new Date(2026, 5, 28, 12, 4)` (offset-less means local, unchanged).
- A `Date` passes through by reference for all three types.

`Writer.test.ts` / `AjaxProxy.test.ts`:

- `new JsonWriter().writeRecord(record)` for a record holding `new Date(2026, 5, 28)` writes `toLocalIsoString(thatDate)`, not `toISOString()`.
- A subclass overriding `dataFor` sees its result serialized (compile-time proof that it is `protected`).
- Every existing `Writer.test.ts` case still passes unchanged; none of them holds a `Date`.
- `AjaxProxy`'s built URL for a filter `{ type: "gte", field: "d", value: new Date(2026, 5, 28) }` carries `filter=` whose decoded JSON value is `toLocalIsoString(thatDate)`.

`ColumnFilter.test.ts`:

- The filter for a `date` column, operator `eq`, text `2026-06-28` is `and(gte new Date(2026,5,28), lt new Date(2026,5,29))`, compared by `getTime()`.

### Backend — unit-testable (`poetry run python -m pytest`)

`test_wire.py`:

- `pg_type_to_wire`: `timestamp with time zone`, `timestamp without time zone`, `timestamptz`, `timestamp` → `ISO_STRING`; `date` → `ISO_DATE`; `time`, `time without time zone` → `ISO_TIME`; `time with time zone`, `timetz`, `interval` → `STRING`. Every existing row except `date` is unchanged.
- `to_wire_value(date(2026,6,28), ISO_DATE) == "2026-06-28"`; `to_wire_value(time(9,30,15,250000), ISO_TIME) == "09:30:15.250000"`.
- `from_wire_value`: every row of the write table under _Architecture Decisions_. The existing `timestamptz` `Z`-suffix case still passes. The existing `timestamp without time zone` case (`"2026-06-28T12:04:59"` → naive) still passes. A `timestamp` column never returns an aware value.
- `from_wire_filter_operand`: every row of the operand table under _Architecture Decisions_, plus:
  - an `ISO_DATE` operand `"2026-06-28T00:00:00.000+09:00"` → `date(2026,6,28)`;
  - a `Z` operand on `ISO_DATE` → the UTC day;
  - an `ISO_TIME` operand `"1970-01-01T09:30:00.000Z"` → `time(9,30)`;
  - a `timestamptz` operand `"2026-06-28T14:04:00+02:00"` → `datetime(2026,6,28,12,4,tzinfo=utc)`;
  - a `STRING` column with data type `time with time zone` and operand `"09:30"` → `"09:30"`, type `str`.
  - The existing pass-through, `None`, non-string and unparseable cases keep passing, retargeted to `ISO_DATE`.
- `from_import_scalar`: an `ISO_DATE` / `ISO_TIME` string passes through; a non-string on either raises `ValueError`, as `ISO_STRING` does.

`test_compiler.py`:

- `gt`/`gte`/`lt`/`lte`/`eq`/`neq` on `day` with operand `"2026-06-28T00:00:00.000-07:00"` compile to `"day" {op} $1` with params `[date(2026,6,28)]`, and no `::timestamp` or `::text`.
- Every row of the `date`-filter table under _Architecture Decisions_.
- `gte` on a `timestamp without time zone` column with `"2026-06-28T12:04:00.000-07:00"` compiles to `"logged_at" >= $1` with `[datetime(2026,6,28,12,4)]`.
- The `timestamptz` comparator, contains, is-empty, unparseable and unknown-column cases pass unchanged.

`test_connections.py`: the `_init_connection` codec registrations listed in step 15.

`test_run_query.py`: the short-name mapping listed in step 16.

### Frontend — unit-testable (`npm test`)

- `buildModel` / `buildQueryModel`: `isoDate` → `date`, `isoTime` → `time`, `isoString` → `datetime`.
- `SqlAdminWriter`:
  - `writeRecord(record, "update")` after `record.set("name", "Grace")` on `{id: 1, name: "Ada", created_at: "…"}` writes exactly `{name: "Grace", id: 1}`.
  - `writeRecord(record, "create")` writes the full record minus generated columns.
  - A generated column that was somehow changed is still stripped from an update.
  - A `Date` in the data is written as local ISO with offset (the `…+HH:MM`/`…-HH:MM` shape, not `…Z`).
- `isFilterableColumn`: true for `isoDate` and `isoTime`.
- `chartConfig`:
  - `xCandidates` includes an `isoDate` column and excludes an `isoTime` one.
  - `isTimeX` is true for `isoDate` and false for `isoTime`.
  - `defaultChartConfig` picks an `isoDate` column as x when no `isoString` column precedes it.
  - `buildChartSeries` maps an `isoDate` value `"2026-06-28"` to `new Date(2026, 5, 28).getTime()`, and drops a `null` date.

### Manual — the running app, in two browser time zones

**Setup.** Link check per step 1, `build:lib` done, backend and frontend dev servers restarted. Log in (see the `verify` skill for the host). In a Query tab, run these two statements one at a time:

```sql
CREATE TABLE public.tz_probe (
    id serial PRIMARY KEY,
    d date, t time, ttz timetz, ts timestamp, tstz timestamptz, iv interval, note text
);
INSERT INTO public.tz_probe (d, t, ttz, ts, tstz, iv, note) VALUES
    ('2026-06-28', '09:30:15.25', '09:30:00+02', '2026-06-28 12:04:59.5',
     '2026-06-28 12:04:59.123456+00', '1 mon 2 days 03:04:05', 'a');
```

Refresh the navigator.

**Time zones.** Run the cases below twice: once with the browser in `America/Los_Angeles` (UTC-7) and once in `Asia/Tokyo` (UTC+9). Set the zone with DevTools → Sensors → Location → Timezone ID, or launch the browser with `TZ=…`. **Reload the page after every change**: the library caches one date formatter per page. Confirm with `Intl.DateTimeFormat().resolvedOptions().timeZone` in the console.

1. **Display.** Open `public.tz_probe` → Data. In both zones:
   - `d` shows 28 June with no time;
   - `t` shows `09:30`;
   - `ts` shows 28 June 2026, `12:04`;
   - `ttz` shows `09:30:00+02` as text;
   - `iv` shows `1 mon 2 days 03:04:05`.

   `tstz` shows `05:04` in Los Angeles and `21:04` in Tokyo (a real instant). No cell is blank.
2. **Edit a date.** Type `2026-09-01` into `d`, commit, Save. The cell keeps `2026-09-01`, with no silent revert. `SELECT d FROM public.tz_probe` in a Query tab returns `2026-09-01` in both zones.
3. **Edit a time.** Set `t` to `14:45` via the picker or by typing, then Save. The query returns `14:45:00` in both zones.
4. **Edit a naive timestamp.** Set `ts` to `2026-06-28 08:00`, then Save. The query returns `2026-06-28 08:00:00`. There is no 400/422, and the backend log has no `DataError`.
5. **Unedited precision survives.** Edit only `note`, then Save. The request body in the network panel is `{"note": …, "id": …}` and nothing else. The query shows `tstz` still `…12:04:59.123456+00` and `t` still at its previous value.
6. **Text columns.** Set `iv` to `3 days`, then Save; the query returns `3 days`. Set `ttz` to `10:00+05:30`, then Save; the query returns `10:00:00+05:30`. Set `iv` to `garbage`, then Save; an error banner appears, the row stays dirty, and there is no 500.
7. **Insert.** Add a row with `d` = `2026-12-31` and `t` = `23:59`, then Save. The query returns `2026-12-31` and `23:59:00` in both zones.
8. **Date filter.** On `wide.cols_10`, pick "Equals" on `col_006_day` and type `2026-07-02`: that row comes back, in both zones. "At least" `2026-07-02` returns it and later days, and never 1 July.
9. **Time and naive-timestamp filters.** On `tz_probe`, "Equals" with the exact text `t` currently displays (`HH:MM`) returns the row; so does "Equals" with the date and time `ts` currently displays. Both work in both zones.
10. **Query results.** Run `SELECT d, t, ttz, ts, tstz, iv FROM public.tz_probe`. The result grid and its record view show the same values as case 1. Export CSV: `d` is `2026-06-28`, `t` is `09:30:15.250000`, `iv` is `1 mon 2 days 03:04:05`.
11. **Chart.** Run `SELECT d, 1 AS n FROM public.tz_probe`. The Chart tab defaults to a line chart with `d` on a time axis, and the point sits on 28 June in both zones. Run `SELECT t, 1 AS n FROM public.tz_probe`: `t` is not offered as x.
12. **Import round trip.** Export `public.tz_probe` as CSV from the Data tab, delete the rows, then import the file. Every column reads back identically, `iv` and `ttz` included.
13. **Structure tab.** `public.tz_probe` → Structure. The Wire type column reads `isoDate`, `isoTime`, `string`, `isoString`, `isoString`, `string`.
14. **Clean up.** `DROP TABLE public.tz_probe;`.

---

## Verification

- **Library** (`/home/jika/typescript/typescript-ui`): `npm test`, `TZ=America/Los_Angeles npm test`, `TZ=Asia/Kolkata npm test`, `npm run lint`, `npm run docs:api` (zero warnings), `npm run docs:llms:check`, `npm run build:lib`.
- **Backend**: `cd backend && poetry run python -m pytest`.
- **Frontend**: `cd frontend && npm run typecheck && npm test`, `TZ=America/Los_Angeles npm test`, `TZ=Asia/Tokyo npm test`.
- `grep -rn "_instant_cast\|_INSTANT_CAST_TYPES" backend/app` — zero matches.
- `grep -rn "_DATETIME_TYPES\|_TIMETZ_TYPES" backend/app` — zero matches.
- `grep -n "JSON.stringify" ../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts` — zero matches outside comments.
- `grep -n "buildModel.ts:14" TODO.md` — zero matches (the backlog bullet is gone).
- Manual: the 14 cases above, in both zones. Entry points: navigator → `public.tz_probe` / `wide.cols_10` → Data / Structure; the Query workspace for cases 10-11.

---

## Documentation Impact

### Library

- **`docs/data/model.md`** — in the field-type table ([line 55](../typescript-ui/packages/lib/docs/data/model.md#L55)):
  - `'date'` reads a bare `YYYY-MM-DD` as local midnight;
  - `'time'` reads `HH:MM[:SS[.fraction]]` as that time on 1 January 1970, local, to the millisecond;
  - anything else still goes through `new Date(raw)`.

  Add one sentence to the coercion paragraph at [line 65](../typescript-ui/packages/lib/docs/data/model.md#L65) saying so.
- **`docs/data/proxy.md`** — the Remote sort & filter paragraph ([line 90](../typescript-ui/packages/lib/docs/data/proxy.md#L90)) and the Reader & Writer paragraph ([line 171](../typescript-ui/packages/lib/docs/data/proxy.md#L171)) each say that a `Date` is sent as local ISO-8601 with its UTC offset (`2026-06-28T00:00:00.000-07:00`). The Reader & Writer paragraph also says that a custom writer can subclass `JsonWriter` and override `dataFor`.
- **`docs/reference/changelog/next.md`**:
  - _Breaking changes → Data_: `date` field string reading; `Date` wire form in `JsonWriter` and `filter=`.
  - _Added_: `time` field string reading; `JsonWriter.dataFor` is protected.
  - _Fixed_: the filter row reads a typed `YYYY-MM-DD` as a local day.

  Each entry says why, in the page's existing voice.
- **`docs/reference/migration/next.md`** — one section, _A `Date` crosses the wire with its local offset_. Say who must act: a server that string-matches a trailing `Z`, or that takes the first ten characters of a `date` value and relied on the day being UTC's. Say what to do: parse the value as ISO-8601. Include a before/after pair from the table under _Architecture Decisions_.
- No barrel change: `temporalValue.ts` is internal, and `JsonWriter` is already exported.

### App

- **`TODO.md`** — the `date`/`time` bullet under `### Data` is deleted (step 27).
- **`LIBRARY_NOTES.md`** — new top entry `## 🐞✅ Temporal field values lost their day and time of day between the grid and the server (0.10.0, symlinked)`. It lists the three library defects (the `date`/`time` `Field` reading, the UTC `Date` wire form, the filter-row date parse), their fix on `feature/date-time-wire-values`, and where the app adopts them (`buildModel.ts`, `SqlAdminWriter.ts`). Follow the existing entries' prose format.
- **`README.md`** — no change; it does not enumerate column types.
- **`CHANGELOG.md`** — no entry; written at release time.

---

## Potential Challenges

- **The main tree's `node_modules` is shared.** The worktree's `frontend/node_modules` is a symlink to the main tree's install, which links the library's main checkout. Do the library work in that checkout on the feature branch (step 1), so nothing has to be re-pointed. If the link turns out to point elsewhere, stop and fix it before step 9.
- **Stale library build.** The app runs the library's built `dist/lib`. After every library edit run `npm run build:lib`, restart the Vite dev server, and clear `frontend/node_modules/.vite` before manual checks.
- **A browser time-zone change needs a page reload.** The library's temporal formatters are built once per page and never follow a zone change.
- **`time '24:00:00'`** is legal in Postgres but has no local `Date`. `parseIsoTimeOfDay` rejects it, and the cell shows blank. It is not edited back, because the writer only sends changed fields.
- **A naive `timestamp` inside a DST gap**, e.g. `2026-03-08 02:30` in Los Angeles, does not exist locally. The browser shows it one hour later. It is only rewritten if the user edits that cell.
- **Sub-millisecond precision is still lost on an edited cell.** The editors write whole seconds, so this matches what the user typed.
- **Python 3.10's `fromisoformat`** (the local venv; the Docker image runs 3.12) only accepts a 3- or 6-digit fraction. Every value this app produces or exports has one of those. A hand-written import file with `09:30:15.25` is rejected per row with the existing coercion error, not a 500.

---

## Critical Files

| File | Why |
|---|---|
| [`backend/app/wire.py`](backend/app/wire.py) | Every backend mapping this plan changes; `_parse_iso_datetime` (:160) is reused. |
| [`backend/app/contract.py`](backend/app/contract.py) | `WireType` (:16): the seam the new members extend. |
| [`backend/app/connections.py`](backend/app/connections.py) | `_init_connection` (:78): the json codec precedent the text codecs mirror. |
| [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) | The comparator branch (:183) and the cast being removed. |
| [`backend/app/operations/update_row.py`](backend/app/operations/update_row.py) | Proves a partial update payload already works (:56). |
| [`frontend/src/data/buildModel.ts`](frontend/src/data/buildModel.ts) | `WIRE_TO_FIELD` (:10), the frontend half of the seam. |
| [`frontend/src/data/SqlAdminWriter.ts`](frontend/src/data/SqlAdminWriter.ts) | The writer being rebased onto `JsonWriter`. |
| [`plans/implemented/date-column-filter-support.md`](plans/implemented/date-column-filter-support.md) | The filter design this plan builds on and partly reverses (its `why-date-cast` footnote). |
| `../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts` (`convertByType` 174) | The read-side defect. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts` (`JsonWriter` 84, `dataFor` 131) | The dirty mode `SqlAdminWriter` adopts; the serializer being changed. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts` (`filter` 188) | The filter-param serializer. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts` (`parseIsoDate` 208) | The local-midnight rule the data layer adopts. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts` (`parseOperand` 290, `displayBucket` 345, the temporal `eq` branch 462) | What a temporal filter cell sends. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/cell/editor/Time.ts` | Confirms the 1970-01-01 local convention for `time` values. |
| `.claude/skills/verify/SKILL.md` | The *Library changes* section: symlink and rebuild mechanics. |

---

## Non-Goals

- **Renaming `isoString`.** It keeps its name and now means "timestamp".[^keep-isostring]
- **A timezone-aware field type for `timetz`.** The library has none; text is lossless.[^text-codec]
- **A duration field type for `interval`.** Same reason.
- **Showing seconds in `time` / `datetime` cells.** The library default (`showSeconds: false`) stays, per the project's prefer-library-defaults rule.
- **`infinity` / `-infinity` and BC dates.** asyncpg's decoding of these is unchanged by this plan.
- **Temporal primary keys.** A `Date` primary key goes into the row URL through `String(date)` today. This plan does not change that.
- **A matview column declared with a precision** (`time(3)`, `timestamp(3) with time zone`). It still falls through to `STRING`; that is the existing `TODO.md` known issue.
- **Plotting `time` columns** on a chart axis.[^chart-time]
- **Bumping `@jimka/typescript-ui` or SQLAdmin's version.** That is release work.[^no-bump]

---

## Notes

[^wire-seam]: `WireType` has not changed since Phase 0 (`git log -- backend/app/contract.py`), but it is the only place the backend tells the frontend what kind of value a column holds. `buildModel.ts`'s module comment names it as the source of every `FieldType`, and `contract.py`'s module docstring says the frontend mirrors the wire set and never Postgres. Keying the frontend on `ColumnMeta.dataType` was rejected for two reasons. No frontend code reads `dataType` for value handling, and a query result has no `dataType` at all.

[^keep-isostring]: Renaming `isoString` to something like `isoDateTime` would be more precise now that it covers only timestamps. But it would touch every test fixture, both contract files, `chartConfig.ts`, `serialize.ts` and the Structure tab's visible "Wire type" column, and change nothing a user sees. A naive and a zone-aware timestamp can share one wire type because the value tells them apart: only `timestamptz` carries an offset, and `new Date()` reads an offset-less date-time as local, which is exactly how a naive timestamp should display.

[^text-codec]: `interval` has no lossless Python type in asyncpg. `timedelta` has no months, so `'1 mon'` decodes as 30 days. `str(timedelta)` prints `1 day, 2:00:00`, which Postgres cannot parse back, so saving any row with an `interval` column already fails today (probed: asyncpg raises `'str' object has no attribute 'days'`). `timetz` decodes fine, but the library has no field type that can show or edit an offset-carrying time of day. Postgres's own docs also advise against `timetz`. A text codec gives both a lossless round trip for free, including inside arrays (probed: `array['1 day'::interval]` decodes to `['1 day']`). A bad value surfaces as Postgres's own `InvalidDatetimeFormatError`, which the existing `asyncpg.PostgresError` handler in `main.py` already turns into an error response. This is the `json`/`jsonb` codec precedent in the same function.

[^fix-in-library]: The project rule (memory `fix-in-library-not-workaround`) is that a defect that starts in typescript-ui is fixed there, not worked around in the app. A per-field `convert` hook in `buildModel.ts` would have worked, but it would leave every other library consumer reading dates a day early west of UTC. It would also leave `Field` disagreeing with the library's own `DateField` and `DateEditor`, whose `parseIsoDate` already carries the comment "Local midnight, appended so the day is not shifted by the UTC parse `new Date("YYYY-MM-DD")` would otherwise perform". `parseIsoDate` moves into `data/` because a data-layer module must not import from `component/`. No file under `data/` does today.

[^local-offset]: Once a `date` field holds local midnight, the old `toISOString()` form is wrong east of UTC. Tokyo's midnight on 28 June is `2026-06-27T15:00Z`, and the backend's `value[:10]` then stores the 27th. Fixing reads without fixing writes would turn a west-of-UTC display bug into an east-of-UTC data-corruption bug. Filters have the same problem in the other direction: from a UTC instant alone, the backend cannot tell which local day a `date` operand meant. Three designs were weighed.
    - **(1) Per-field-type serialization in `JsonWriter`** (a `date` as `YYYY-MM-DD`, a `time` as `HH:MM:SS`). This fixes writes only. `AjaxProxy` serializes filter descriptors without knowing field types.
    - **(2) A client-time-zone request header**, so the backend converts instants back to local. This adds hidden state that changes the meaning of every value, and needs a zone database on the server.
    - **(3) A local-offset ISO string for every `Date`** — chosen. It is one type-agnostic rule, applies to bodies and filters alike, is the same instant for any consumer that parses ISO, and is self-describing.

    `WebStorageProxy` also stringifies records, but it reads them back through the same `Field` conversion in the same browser, so it is left alone.

[^wall-clock]: For a zone-less Postgres type, what the user saw is the value. The frontend displayed a naive timestamp, a date and a time of day as local wall-clock values, so the wall clock in the string is what the user meant. This is also Postgres's own rule: `'2026-06-28 12:04+02'::timestamp` ignores the offset and yields `12:04`. It is also immune to historical offsets. Europe/London was UTC+1 all through 1970, so a `time` value's 1970-01-01 carrier date gets a `+01:00` offset there, but the wall clock `09:30` is unaffected. `timestamptz` alone is an instant, so its offset is honoured. Before this plan, `from_wire_filter_operand` converted zone-less operands to UTC first and took the UTC wall clock. That was only correct for a browser at UTC, and it is the "client-offset shift" `date-column-filter-support` listed as a non-goal.

[^date-truncate]: `date-column-filter-support` compared a `date` column as `"day"::timestamp` because its operands came from a `datetime` field. "Equals" there was a one-minute range, which truncation would have collapsed to an empty one (its `why-date-cast` footnote). A `date` field's "Equals" is a whole local day, so both bounds truncate to distinct days and the collapse cannot happen. Truncation is also the only form that works in zones whose DST change happens at midnight, such as America/Santiago or America/Havana. There `new Date(y, m, d)` on the change day is 01:00. Under the cast, "At least 6 September" would bind `2026-09-06 01:00` and exclude 6 September itself. Truncated, it binds `date(2026,9,6)`. One behaviour differs, and it is accepted. If a user types a time into a `date` column's "At least" filter (`2026-06-28 15:00`), the truncated form includes the 28th while an exact comparison would not. The cell shows no time, so including the day the user typed is the reading that matches the screen.

[^dirty-writer]: A JS `Date` holds milliseconds, and Postgres timestamps and times hold microseconds. `now()` defaults, such as every `created_at`/`changed_at` in the seed's `hub` schema, fill all six digits. The full-row writer re-sent every column on every save, so editing any cell truncated those columns to milliseconds. It also re-sent every naive timestamp, which is what made those rows unsaveable. The library already offers `JsonWriter({ mode: 'dirty' })` for exactly this: "only the fields changed since the last commit, plus the primary key". Reusing it is the precedent, rather than teaching `SqlAdminWriter` its own diff. Subclassing needs `dataFor` to be `protected`. Composition was rejected because `JsonWriter` serializes inside `writeRecord`, so a wrapper could not strip generated columns before serialization without re-implementing it. A generated column can never be dirty, since the grid marks it read-only. The strip is still kept for creates and as a guard.

[^chart-time]: The chart library plots x as a number, and a time axis reads it as epoch milliseconds. A `date` value is a day, so local midnight of that day plots where the grid says it is. `Date.parse("2026-06-28")` would plot at UTC midnight, the previous evening west of UTC. A `time` value has no date. Plotting it on 1 January 1970 would label every tick with that date, and a real time-of-day axis is new chart work, not part of this change.

[^no-bump]: Per memory `library-release-gated-on-sqladmin`, a typescript-ui release waits for SQLAdmin to have verified it against a symlinked build. An app plan must not wait on the release, and it does not move the dependency range; that happens in the release checklist (`release-steps.md`). SQLAdmin already builds against typescript-ui `master` (0.10.0, unreleased) through the symlink, while `package.json` still names `^0.9.0`. That mismatch is expected during this phase.
