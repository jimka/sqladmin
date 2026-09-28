---
depends-on: [row-write-changed-fields]
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
  - ../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/component/input/TimeField.ts
  - ../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts
  - ../typescript-ui/packages/lib/docs/reference/changelog/next.md
  - ../typescript-ui/packages/lib/docs/reference/migration/next.md
---

# Date & Time Column Field Types — Implementation Plan

## Overview

Every Postgres `date`, `time` and `timestamp` column reaches the frontend as one wire type, `isoString` ([`contract.py:24`](backend/app/contract.py#L24)), which [`buildModel.ts:14`](frontend/src/data/buildModel.ts#L14) maps to the library's `datetime` field type. That causes these visible bugs:

- A `date` cell shows a time of day it does not have, and west of UTC it shows the previous day.
- A `time` cell is always blank. The library's `Field` converts the value with `new Date("09:30:00")`, which is an Invalid Date, so the field stores `undefined`. This is a library defect.
- Typing a bare `2026-09-01` into a `date` cell reverts silently. This is an app mapping bug: the column gets the date-time cell editor, which needs a time as well (`YYYY-MM-DD H:MM`). Mapping `date` to the library's `date` field type gives it the date editor.
- The header filter row on a `timestamp` or `date` column misses rows in a browser outside UTC. The filter sends a UTC instant, and the backend compares its UTC wall clock or UTC day with a local one.

This plan gives `date` and `time` their own wire types and field types, and makes every temporal value cross the wire in both directions without losing its day or its wall-clock time. It builds on [`row-write-changed-fields`](plans/row-write-changed-fields.md), which already sends only changed fields on an update, binds a naive `datetime` for a `timestamp` column, and reads `interval`/`timetz` as text. It spans three places:

- **typescript-ui** (sibling repo, lands first, released as **0.11.0**): `Field` reads a bare date and a time of day as local values; `JsonWriter` writes a `Date` by field type; `AjaxProxy` writes filter `Date`s with their local offset; the filter row reads a typed date as a local day; `TimeField` anchors its values on 1 January 1970.
- **backend**: the wire contract, the read/write/filter mappings in [`wire.py`](backend/app/wire.py), and the `date` filter comparison in [`compiler.py`](backend/app/sql/compiler.py).
- **frontend**: the wire-type union, the field-type map, `SqlAdminWriter` rebased onto `JsonWriter`, the filterable set, and the chart's time axis.

It replaces the backlog bullet in [`TODO.md:20`](TODO.md#L20). It changes two decisions of the shipped [`date-column-filter-support`](plans/implemented/date-column-filter-support.md) plan and replaces two pieces of `row-write-changed-fields` (its `timestamp` write rule and its app-side writer); each is called out below. It is **not** part of SQLAdmin 0.10.0.

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

### The library reads a bare date or time of day as a local value

`Field.convertByType` ([`Field.ts:190`](../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts#L190)) converts every temporal value with `new Date(raw)`. That reads `2026-06-28` as UTC midnight and cannot read `09:30:00` at all. The library's own `DateField` and date cell editor already read `YYYY-MM-DD` as local midnight, and 0.10.0 stopped the date-time cell editor from reading a date with no time as UTC midnight ([changelog 0.10.0](../typescript-ui/packages/lib/docs/reference/changelog/0.10.0.md#L1554)). The data layer is the one place still reading it as UTC. This is a library defect, fixed in the library.[^fix-in-library]

| Field type | Raw value | Before | After |
|---|---|---|---|
| `date` | `"2026-06-28"` | UTC midnight (27 June, 17:00 in Los Angeles) | 28 June, 00:00 local |
| `datetime` | `"2026-06-28"` | UTC midnight | 28 June, 00:00 local |
| `time` | `"09:30:15.250000"` | `undefined` | 1 January 1970, 09:30:15.250 local |
| `time` | `"09:30"` | `undefined` | 1 January 1970, 09:30:00.000 local |
| `date` | `"2026-06-28T12:04:00Z"` | that instant | that instant (fallback, unchanged) |
| `datetime` | `"2026-06-28T12:04:59.5"` | local 12:04:59.500 | unchanged |

### Every time-of-day value sits on 1 January 1970, local

The time cell editor ([`Time.ts:219`](../typescript-ui/packages/lib/src/typescript/lib/component/table/cell/editor/Time.ts#L219)), the filter row ([`ColumnFilter.ts:279`](../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts#L279)) and the demos already build `new Date(1970, 0, 1, h, m, s)`. `TimeField` is the one component that puts a time on **today's** date ([`TimeField.ts:139`](../typescript-ui/packages/lib/src/typescript/lib/component/input/TimeField.ts#L139) and [`:172`](../typescript-ui/packages/lib/src/typescript/lib/component/input/TimeField.ts#L172)). This round moves `TimeField` onto 1970 as well, and `Field` reads a `time` value onto the same date.[^one-anchor]

| `TimeField` input | Before | After |
|---|---|---|
| typed `09:30` on 28 June 2026 | 28 June 2026, 09:30 local | 1 January 1970, 09:30 local |
| picked 14:45 from the dropdown | today, 14:45 | 1 January 1970, 14:45 |
| typed `+30mi` at 23:50 on 28 June 2026 | 29 June 2026, 00:20 | 1 January 1970, 00:20 |

### `JsonWriter` writes a `Date` by its field type

`JsonWriter` looks up each top-level value's field in the record's model and writes a valid `Date` in the form that field type is read back in. The read side and the write side then agree for every temporal type.[^write-form]

| Field type | `Date` (local) | Before (`toISOString`) | After |
|---|---|---|---|
| `date` | 28 June 2026, 00:00 in Tokyo | `2026-06-27T15:00:00.000Z` | `2026-06-28` |
| `time` | 1 January 1970, 09:30:15.250 in Kolkata | `1970-01-01T04:00:15.250Z` | `09:30:15.250` |
| `datetime` | 28 June 2026, 12:04:59.123 in Los Angeles | `2026-06-28T19:04:59.123Z` | `2026-06-28T12:04:59.123-07:00` |
| `datetime` | same, host at UTC | `2026-06-28T12:04:59.123Z` | `2026-06-28T12:04:59.123+00:00` |
| any other type, or a name with no field | as `datetime` | as before | as `datetime` |

An Invalid `Date` is written as `null`, as `JSON.stringify` does today. A `Date` nested inside an object or array value keeps `JSON.stringify`'s own `toISOString()` form; only top-level field values have a field type to go by.

### `AjaxProxy`'s `filter=` writes every `Date` with its local offset

A filter descriptor has no field types, so `AjaxProxy` writes every `Date` in it, at any depth, as local ISO-8601 plus the local UTC offset: the `datetime` row of the table above. It is the same instant as before, so any ISO parser reads it as before, and it also carries the calendar day and wall-clock time the user saw.[^local-offset]

| Browser zone | Filter `Date` (local) | Before | After |
|---|---|---|---|
| `America/Los_Angeles` | 28 June 2026, 00:00 | `2026-06-28T07:00:00.000Z` | `2026-06-28T00:00:00.000-07:00` |
| `Asia/Tokyo` | 28 June 2026, 00:00 | `2026-06-27T15:00:00.000Z` | `2026-06-28T00:00:00.000+09:00` |
| `Asia/Kolkata` | 1 January 1970, 09:30 | `1970-01-01T04:00:00.000Z` | `1970-01-01T09:30:00.000+05:30` |

### Years outside 0000–9999 use ISO 8601's expanded form

`toLocalIsoString` and the `date` write form write a year of 0 to 9999 as four digits, zero-padded. Any other year is written as a sign plus six digits, the form `Date.toISOString()` uses, so no year is ever cut short.[^extended-year]

| Year | Written |
|---|---|
| 2026 | `2026-06-28…` |
| 999 | `0999-01-01…` |
| 0 | `0000-01-01…` |
| 10000 | `+010000-01-01…` |
| -1 | `-000001-01-01…` |

### The backend reads a zone-less column from the wall clock and `timestamptz` from the instant

For `date`, `time` and `timestamp without time zone`, the backend takes the date and time written in the string and drops any offset **without converting**. For `timestamptz` it keeps the instant. The rule applies to row writes (`from_wire_value`) and filter operands (`from_wire_filter_operand`) alike.[^wall-clock]

This replaces two earlier rules, which both converted an offset to UTC before dropping it: `row-write-changed-fields`'s rule for a written `timestamp`, and `date-column-filter-support`'s rule for zone-less filter operands. The two cases below show where the results differ.

Writes (`from_wire_value`):

| Column | Value sent | Bound |
|---|---|---|
| `timestamptz` | `2026-06-28T12:04:00.000-07:00` | `datetime(2026,6,28,12,4,tzinfo=-07:00)` (= 19:04 UTC) |
| `timestamp` | `2026-06-28T12:04:00.000-07:00` (the grid) | `datetime(2026,6,28,12,4)` |
| `timestamp` | `2026-06-28T14:04:00+02:00` | `datetime(2026,6,28,14,4)` (was 12:04) |
| `timestamp` | `2026-06-28T08:00:00.000` (a `row-write-changed-fields` build) | `datetime(2026,6,28,8,0)` |
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

The filter row builds "Equals" on a `date` column as one whole local day:

| Header cell (Los Angeles) | Descriptor sent | Compiled |
|---|---|---|
| `day` Equals `2026-06-28` | `and(gte 2026-06-28T00:00:00.000-07:00, lt 2026-06-29T00:00:00.000-07:00)` | `("day" >= $1 AND "day" < $2)`, params `[date(2026,6,28), date(2026,6,29)]` |
| `day` At least `2026-06-28` | `gte 2026-06-28T00:00:00.000-07:00` | `"day" >= $1`, params `[date(2026,6,28)]` |

### The filter row reads a typed `YYYY-MM-DD` as a local day

`parseOperand` in [`ColumnFilter.ts:319`](../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts#L319) tries `parseIsoDate` first for both `date` and `datetime` columns, and only then falls back to `new Date(text)`. Without it, `2026-06-28` typed into either column's filter becomes UTC midnight, and `displayBucket` then builds the bucket around 27 June west of UTC. This is the same library defect as `Field`'s, in a second place.

| Column type | Typed | Operand before | Operand after |
|---|---|---|---|
| `date` | `2026-06-28` | UTC midnight | 28 June, 00:00 local |
| `datetime` | `2026-06-28` | UTC midnight | 28 June, 00:00 local |
| `datetime` | `2026-06-28 12:04` | 12:04 local (`new Date`) | unchanged |

### `SqlAdminWriter` extends `JsonWriter` in `'dirty'` mode

`JsonWriter.dataFor` becomes `protected`. `SqlAdminWriter` then extends `JsonWriter` with `mode: 'dirty'` and overrides `dataFor` to strip generated columns from `super.dataFor(…)`. It drops its own copy of the dirty-mode rule and its zone-less-timestamp formatting from `row-write-changed-fields`, because `JsonWriter` now writes a `datetime` value with its local wall clock and the backend drops the offset for a zone-less column.[^rebase-writer]

### Charts plot `isoDate` on the time axis at local midnight, and never offer `isoTime`

[`chartConfig.ts`](frontend/src/data/chartConfig.ts) accepts `isoString` and `isoDate` as time-axis columns. It parses an `isoDate` value as local midnight, so the point sits on the day the grid shows. An `isoTime` column is not an x-axis candidate.[^chart-time]

### The library ships these changes as typescript-ui 0.11.0, after SQLAdmin has verified them

typescript-ui 0.10.0 is released (tag `v0.10.0`, on npm). The library changes land on `feature/date-time-wire-values` in `/home/jika/typescript/typescript-ui`, branched from **local** `master`. Several of them change observable behaviour, so the next version is a minor, **0.11.0**, with a migration note.[^minor]

SQLAdmin verifies the branch through a symlinked, locally built library before 0.11.0 is released. `frontend/package.json` is not touched here: it names `^0.9.0` until `typescript-ui-0-10-0-upgrade`'s manual dependency swap, and moves to `^0.11.0` only in the post-release swap after this plan.[^no-bump] The library-first step order mirrors [`plans/implemented/diagram-depth-limit-and-expand-indicator.md`](plans/implemented/diagram-depth-limit-and-expand-indicator.md).

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

/** `new Date(1970, 0, 1, hours, minutes, seconds, ms)`: the date every time-of-day value sits on. */
export function timeOfDay(hours: number, minutes: number, seconds: number, ms?: number): Date;

/** `HH:MM[:SS[.fraction]]` as timeOfDay(…), millisecond precision; null otherwise. */
export function parseIsoTimeOfDay(raw: string): Date | null;

/** The local-value reading `Field` applies before its `new Date(raw)` fallback. */
export function parseLocalTemporal(type: TemporalFieldType, raw: string): Date | null;

/** `YYYY-MM-DDTHH:MM:SS.sss±HH:MM` in the host's local zone. */
export function toLocalIsoString(date: Date): string;

/** A valid `Date` in the write form for `type` (see the JsonWriter table); `null` for an Invalid Date. */
export function formatWireTemporal(type: FieldType | undefined, date: Date): string | null;

/** `JSON.stringify(value)`, except every `Date`, at any depth, becomes `formatWireTemporal(undefined, date)`. */
export function stringifyWithLocalDates(value: unknown): string;
```

`FieldType` and `TemporalFieldType` are imported with `import type` (from `~/data/Field.js` and `~/data/temporalText.js`), so `Field.ts` importing `temporalValue.ts` creates no runtime cycle.

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

`parseIsoTimeOfDay` rejects hours ≥ 24, minutes ≥ 60 and seconds ≥ 60, then returns `timeOfDay(h, m, s, ms)`. `ms` is the fraction right-padded with zeros and cut to three digits. Name the three range bounds and the millisecond digit count as constants with a one-line reason each, per the magic-number rule.

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
        case 'datetime':
            return parseIsoDate(raw);

        case 'time':
            return parseIsoTimeOfDay(raw);
    }
}
```

`parseIsoDate` accepts only a complete `YYYY-MM-DD`, so a `datetime` string with a time still returns `null` here and goes through `new Date(raw)` as before.

`toLocalIsoString` builds the text from the local getters (`getFullYear` … `getMilliseconds`) and `getTimezoneOffset()`. The offset sign is inverted: `getTimezoneOffset()` is positive west of UTC. An offset of zero prints `+00:00`, never `Z`, so every value has the same shape. The year follows the expanded-year table under _Architecture Decisions_; a private `formatWireYear(year)` does that for both `toLocalIsoString` and the `date` form.

`formatWireTemporal`:

```ts
export function formatWireTemporal(type: FieldType | undefined, date: Date): string | null {
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    switch (type) {
        case 'date':
            return formatWireDate(date);        // `${formatWireYear(y)}-MM-DD`, local

        case 'time':
            return formatWireTime(date);        // `HH:MM:SS.sss`, local

        default:
            return toLocalIsoString(date);
    }
}
```

`stringifyWithLocalDates` needs the replacer's `this`, because `JSON.stringify` calls `Date.prototype.toJSON` before the replacer sees the value. It is therefore a `function` expression, not an arrow; say so in a comment:

```ts
export function stringifyWithLocalDates(value: unknown): string {
    return JSON.stringify(value, function (this: Record<string, unknown>, key: string, serialized: unknown): unknown {
        const raw = this[key];

        return raw instanceof Date ? formatWireTemporal(undefined, raw) : serialized;
    });
}
```

### Library — `JsonWriter`

```ts
writeRecord(record: ModelRecord, operation?: WriteOperation): string {
    return JSON.stringify(this.toWireValues(record, this.dataFor(record, operation)));
}

writeRecords(records: ModelRecord[], operation?: WriteOperation): string {
    return JSON.stringify(records.map(record => this.toWireValues(record, this.dataFor(record, operation))));
}

// private: every top-level Date through formatWireTemporal, typed by
// record.getModel().getField(name)?.getType(); every other value unchanged.
private toWireValues(record: ModelRecord, data: Record<string, any>): Record<string, any>;
```

`toWireValues` runs on `dataFor`'s result, so a subclass's `dataFor` override (such as `SqlAdminWriter`'s strip) sees `Date`s and its output is still written by field type.

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

### Library — `TimeField`

- `parseRaw` ([`TimeField.ts:123`](../typescript-ui/packages/lib/src/typescript/lib/component/input/TimeField.ts#L123)): the absolute branch returns `timeOfDay(time.hours, time.minutes, time.seconds)` instead of setting hours on `new Date()`. The relative branch still resolves against `new Date()` (so `+30mi` means "30 minutes from now"), then returns `timeOfDay(r.getHours(), r.getMinutes(), r.getSeconds())` of the result.
- `onTimeSelected` ([`TimeField.ts:171`](../typescript-ui/packages/lib/src/typescript/lib/component/input/TimeField.ts#L171)): `this.onDropdownSelected(timeOfDay(hours, minutes, seconds))`.
- Update both JSDoc blocks and the class JSDoc at line 43, which say "today's date".

### Backend — `wire.py` constants

Replace `_DATETIME_TYPES` ([`wire.py:33`](backend/app/wire.py#L33)) and the `_DATE_TYPES` / `_TIME_TYPES` block after it with:

```python
_TIMESTAMP_TYPES = frozenset(
    {"timestamp with time zone", "timestamp without time zone", "timestamp", "timestamptz"}
)
_TIMESTAMPTZ_TYPES = frozenset({"timestamp with time zone", "timestamptz"})
_DATE_TYPES = frozenset({"date"})
_TIME_TYPES = frozenset({"time", "time without time zone"})
_TEMPORAL_WIRE_TYPES = frozenset({WireType.ISO_STRING, WireType.ISO_DATE, WireType.ISO_TIME})
```

`_POSTGRES_TEXT_TYPES` (added by `row-write-changed-fields`) stays as it is.

### Backend — `wire.py` functions

```python
def _wall_clock(text: str) -> datetime.datetime:
    """
    The naive date-time an ISO string names: its offset, if any, is dropped
    without converting, so "12:04-07:00" stays 12:04.
    """
    return _parse_iso_datetime(text).replace(tzinfo=None)
```

`pg_type_to_wire` — replace the single `_DATETIME_TYPES` check with three, before the existing `_POSTGRES_TEXT_TYPES` check:

```python
if dt in _TIMESTAMP_TYPES:
    return WireType.ISO_STRING

if dt in _DATE_TYPES:
    return WireType.ISO_DATE

if dt in _TIME_TYPES:
    return WireType.ISO_TIME
```

`to_wire_value`: `if wire_type in _TEMPORAL_WIRE_TYPES: return value.isoformat()`.

`from_wire_value` — replace the whole `ISO_STRING` branch (as `row-write-changed-fields` left it) with:

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

    return moment if data_type in _TIMESTAMPTZ_TYPES else moment.replace(tzinfo=None)
```

Rewrite the comment `row-write-changed-fields` put above the zone-less return to state the new rule (offset dropped without converting), and the docstring sentence to match.

`from_import_scalar`: the `ISO_STRING` test becomes `wire_type in _TEMPORAL_WIRE_TYPES`; the message is unchanged.

`from_wire_filter_operand` — new body; rewrite the docstring's bullet list to match the operand table under _Architecture Decisions_:

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

### Library — `/home/jika/typescript/typescript-ui` (first; the app typechecks against the built output)

1. **Branch and link.** In `/home/jika/typescript/typescript-ui`, create `feature/date-time-wire-values` from **local** `master` (local `master` can be ahead of `origin`). Then check the app's link: `readlink -e /home/jika/typescript/sqladmin/frontend/node_modules/@jimka/typescript-ui` must print `/home/jika/typescript/typescript-ui/packages/lib`. If it prints nothing (the path is a real directory, because the 0.10.0 post-release swap has run), re-create the symlink with the commands in `.claude/skills/verify/SKILL.md` → _Library changes_.

2. **`packages/lib/tests/unit/data/temporalValue.test.ts`** (new) — cases from _Expected Behaviour → Library_ for `timeOfDay`, `parseIsoTimeOfDay`, `parseLocalTemporal`, `toLocalIsoString`, `formatWireTemporal` and `stringifyWithLocalDates`. Red (module missing).

3. **`packages/lib/src/typescript/lib/data/temporalValue.ts`** (new) — move `ISO_DATE` ([`dateMath.ts:152`](../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts#L152)) and `parseIsoDate` ([`dateMath.ts:208`](../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts#L208)) here verbatim with their comments, then add the new functions per _Internal Structure_. Mark every export `@internal — not re-exported from the package barrel.`, as `dateMath.ts` does.

4. **`packages/lib/src/typescript/lib/component/input/dateMath.ts`** — delete the moved `ISO_DATE` and `parseIsoDate`. Add `import { parseIsoDate } from "~/data/temporalValue.js";` and `export { parseIsoDate };` — a bare `export … from` would leave `parseIsoDateTime` (its call at [line 296](../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts#L296)) with no local binding. Fix the comment at [line 167](../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts#L167) ("ISO_DATE above reads back exactly four") to name `parseIsoDate` in `data/temporalValue.ts`. Run `npm test` — step 2 green, and the `DateField` / `DateTimeField` / cell-editor suites still green.

5. **`packages/lib/tests/unit/data/Field.test.ts`** — replace the case at [line 43](../typescript-ui/packages/lib/tests/unit/data/Field.test.ts#L43), which pins UTC midnight, with the `Field` cases from _Expected Behaviour_. Then change `convertByType` in **`data/Field.ts`** per _Internal Structure_. Green.

6. **`packages/lib/tests/unit/data/proxy/Writer.test.ts`** and **`AjaxProxy.test.ts`** — add the serialization cases from _Expected Behaviour_. Then in **`data/proxy/Writer.ts`**: `writeRecord` ([line 105](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts#L105)) and `writeRecords` ([line 117](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts#L117)) go through `toWireValues` per _Internal Structure_; `dataFor` ([line 131](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts#L131)) becomes `protected`. Rewrite the class JSDoc at [line 73](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts#L73) ("Default writer producing `JSON.stringify(record.getData())`…") to say a `Date` is written in its field type's form, and that a subclass can override `dataFor`. In **`data/proxy/AjaxProxy.ts`**, the `filter` parameter ([line 188](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts#L188)) uses `stringifyWithLocalDates`; leave `sort` ([line 184](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts#L184)) alone, since sorters carry no values. Green.

7. **`packages/lib/tests/component/table/ColumnFilter.test.ts`** — add the filter-row cases from _Expected Behaviour_. Then in **`component/table/ColumnFilter.ts`**, the shared `'date' | 'datetime'` case of `parseOperand` ([line 319](../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts#L319)) returns `parseIsoDate(text)` when that is non-null, and otherwise keeps the existing `new Date(text)` logic. Import `parseIsoDate` from `~/data/temporalValue.js`. Green.

8. **`packages/lib/tests/component/input/TimeField.test.ts`** — case 20 ([line 100](../typescript-ui/packages/lib/tests/component/input/TimeField.test.ts#L100)) pins the pinned clock's date (`getFullYear` 2026, `getMonth` 0, `getDate` 31); change those three assertions to 1970, 0, 1. Retitle the case at [line 72](../typescript-ui/packages/lib/tests/component/input/TimeField.test.ts#L72) ("date portion is today by contract"): `setValue` keeps the `Date` it is given, so its date portion is the one set. Add the `TimeField` cases from _Expected Behaviour_. Then change **`component/input/TimeField.ts`** per _Internal Structure_, importing `timeOfDay` from `~/data/temporalValue.js`. Green.

9. **Docs** — per _Documentation Impact → Library_.

10. **Checkpoint.** From `/home/jika/typescript/typescript-ui`: `npm test`; `TZ=America/Los_Angeles npm test`; `TZ=Asia/Kolkata npm test`; `npm run lint`; `npm run docs:api` (zero warnings — the new module is `@internal`, so public JSDoc must not `{@link}` it); `npm run docs:llms:check` (run `npm run docs:llms` if it reports drift); then **`npm run build:lib`** (not `npm run build`). The app cannot typecheck against `JsonWriter.dataFor` until `build:lib` succeeds.

### Backend — `sqladmin/backend` (test-first; `poetry run python -m pytest` from the worktree)

11. **`backend/tests/test_wire.py`** — update and add cases per _Expected Behaviour → Backend_:
    - the `test_pg_type_to_wire` table ([line 27](backend/tests/test_wire.py#L27)): `date` → `ISO_DATE`, and add the `time` rows;
    - `test_from_wire_date_and_time` and `test_from_wire_date_accepts_full_datetime_string` move to `ISO_DATE` / `ISO_TIME` columns;
    - in `row-write-changed-fields`'s `test_from_wire_timestamp_without_tz_binds_naive`, the `+02:00` row now expects `datetime(2026,6,28,14,4)`;
    - the filter-operand block: the `date` and `time` rows move to the new wire types and the new results; the `timestamp without time zone` row keeps its `Z` operand and result;
    - delete `test_from_wire_filter_operand_date_keeps_time_of_day` (its premise is reversed: a `date` operand is now truncated).

    Red.

12. **`backend/app/contract.py`** — add `ISO_DATE` / `ISO_TIME` and reword the `ISO_STRING` comment ([line 24](backend/app/contract.py#L24)) per _Public API_.

13. **`backend/app/wire.py`** — constants, `_wall_clock`, `pg_type_to_wire`, `to_wire_value`, `from_wire_value`, `from_import_scalar` and `from_wire_filter_operand` per _Internal Structure_. Delete `_DATETIME_TYPES`. Update the module docstring's `from_wire_filter_operand` bullet ([line 10](backend/app/wire.py#L10)) so it no longer says the mapping differs from the write path for "a temporal column" in general. Run `tests/test_wire.py` — green.

14. **`backend/tests/test_compiler.py`** — `TEMPORAL_COLS` ([line 18](backend/tests/test_compiler.py#L18)) gives `day` `WireType.ISO_DATE`. Rewrite the three `date` tests (`test_filter_comparators_on_date_column_cast_to_timestamp` at [line 315](backend/tests/test_compiler.py#L315), `test_filter_equals_range_on_date_column`, `test_filter_at_least_on_date_column`) to the uncast form and `date` params in the `date`-filter table. Rename the first to `test_filter_comparators_on_date_column_bind_a_date`. Add `col("logged_at", WireType.ISO_STRING, data_type="timestamp without time zone")` to `TEMPORAL_COLS` and its offset case. Red.

15. **`backend/app/sql/compiler.py`** — delete `_INSTANT_CAST_TYPES` and its comment ([lines 20-23](backend/app/sql/compiler.py#L20)) and `_instant_cast` ([line 153](backend/app/sql/compiler.py#L153)). The comparator line ([line 186](backend/app/sql/compiler.py#L186)) becomes `col = self._column(field, [value])`. Green. `grep -n "_instant_cast\|::timestamp" backend/app/sql/compiler.py` — zero matches.

16. **`backend/tests/test_run_query.py`** — beside `test_short_name_type_mapping` ([line 123](backend/tests/test_run_query.py#L123)), add a case whose attributes are `date`, `time`, `timestamp`, expecting `isoDate`, `isoTime`, `isoString`. No source change: `_query_columns` already goes through `pg_type_to_wire`.

17. **`backend/app/export_format.py`** — the comment at [line 106](backend/app/export_format.py#L106) lists `isoString`; make it `isoString / isoDate / isoTime`. No logic change.

18. **Checkpoint.** `cd backend && poetry run python -m pytest` — whole suite green. `grep -rn "_DATETIME_TYPES" backend/app` — zero matches.

### Frontend — `sqladmin/frontend` (needs step 10's `build:lib`)

19. **Worktree prerequisite.** If `frontend/node_modules` is missing in the worktree, symlink it: `ln -s /home/jika/typescript/sqladmin/frontend/node_modules frontend/node_modules`. Never commit the link.

20. **`frontend/src/contract.ts`** — add `"isoDate"` and `"isoTime"` to `WireType` ([line 32](frontend/src/contract.ts#L32)), each with a one-line comment naming its Postgres type.

21. **`frontend/tests/data/buildModel.test.ts`** — add `isoDate` → `date` and `isoTime` → `time` columns to both existing cases. Then **`frontend/src/data/buildModel.ts`** — add `isoDate: "date"` and `isoTime: "time"` to `WIRE_TO_FIELD` ([line 10](frontend/src/data/buildModel.ts#L10)). `Record<WireType, FieldType>` makes a missed entry a type error.

22. **`frontend/tests/data/SqlAdminWriter.test.ts`** — keep the four original cases and `row-write-changed-fields`'s update/create/generated/`null` cases. Delete its zone-less-timestamp, `formatWallClock` and "aware timestamp untouched" (`…Z`) cases, since a `datetime` value is now written with its local offset, and construct every writer with one argument. Add the `date`/`datetime` write-form cases from _Expected Behaviour_. Then rewrite **`frontend/src/data/SqlAdminWriter.ts`** per _Public API_: it extends `JsonWriter`, calls `super({ mode: "dirty" })`, and overrides `dataFor` to return the existing strip applied to `super.dataFor(record, operation)`. Delete its own `writeRecord`/`writeRecords`, `formatWallClock` and its constants, and the `zonelessTimestampColumns` parameter. Rewrite the file header: generated columns are stripped; an update sends only the changed fields plus the primary key (the library's dirty mode); `JsonWriter` writes each `Date` in its field type's form.

23. **`frontend/src/data/stores.ts`** — delete `ZONELESS_TIMESTAMP_TYPE` and the `zoneless` set; the writer is `new SqlAdminWriter(generated)` again.

24. **`frontend/tests/dock/tableWriteRules.test.ts`** — add `"isoDate"` and `"isoTime"` to the `isFilterableColumn` true list ([line 111](frontend/tests/dock/tableWriteRules.test.ts#L111)). Then **`frontend/src/dock/tableWriteRules.ts`** — add both to `FILTERABLE_WIRE_TYPES` ([line 31](frontend/src/dock/tableWriteRules.ts#L31)), and update the two doc comments that list the filterable wire types ([line 33](frontend/src/dock/tableWriteRules.ts#L33) and [line 53](frontend/src/dock/tableWriteRules.ts#L53)).

25. **`frontend/tests/data/chartConfig.test.ts`** — add the chart cases from _Expected Behaviour_. Then in **`frontend/src/data/chartConfig.ts`**:
    - add a module constant `TIME_AXIS_WIRE_TYPES: ReadonlySet<WireType> = new Set(["isoString", "isoDate"])`;
    - replace the three `wireType === "isoString"` tests ([lines 37, 55, 70](frontend/src/data/chartConfig.ts#L37)) with `TIME_AXIS_WIRE_TYPES.has(c.wireType)`;
    - replace the `Date.parse` in `toX` ([line 96](frontend/src/data/chartConfig.ts#L96)) with a module-private `toEpochMs(value, wireType)`. It parses an `isoDate` value as `` `${value}T00:00:00` `` (local midnight) and anything else as-is.

    Update the header comment and `xCandidates`' comment to say "date and datetime columns". Import `WireType` from `../contract`.

26. **`frontend/src/data/serialize.ts`** — the comments at [line 67](frontend/src/data/serialize.ts#L67) and [line 138](frontend/src/data/serialize.ts#L138) list `isoString`; make each `isoString / isoDate / isoTime`. No logic change.

27. **Checkpoint.** `cd frontend && npm run typecheck && npm test`, then `TZ=America/Los_Angeles npm test` and `TZ=Asia/Tokyo npm test`. `grep -rn '"isoString"' frontend/src` — only `contract.ts`, `tableWriteRules.ts` and `chartConfig.ts` (`buildModel.ts` spells the key unquoted). `grep -rn "formatWallClock\|ZONELESS" frontend/src` — zero matches.

### Bookkeeping and manual verification

28. **`TODO.md`** — delete the `date`/`time` bullet ([lines 20-25](TODO.md#L20)). Leave the `ColumnMeta.dataType` known-issue entry as is; it is still accurate.

29. **`LIBRARY_NOTES.md`** — per _Documentation Impact → App_.

30. **Manual verification** — every case under _Expected Behaviour → Manual_, driven through the running app (see `.claude/skills/verify/SKILL.md`), in both browser time zones.

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
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/input/TimeField.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/input/TimeField.test.ts` |
| Modify | `../typescript-ui/packages/lib/docs/data/model.md` |
| Modify | `../typescript-ui/packages/lib/docs/data/proxy.md` |
| Modify | `../typescript-ui/packages/lib/docs/components/TimeField.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog/next.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/migration/next.md` |
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

Frontend and library unit tests must pass in any host time zone. Build expected `Date`s with the local constructor (`new Date(2026, 5, 28)`), never from an ISO string without an offset, and derive expected offsets from `getTimezoneOffset()`. For a year below 100, build the `Date` and then call `setFullYear`, because the constructor maps years 0-99 to 1900-1999. The `TZ=` runs in steps 10 and 27 prove it.

### Library — unit-testable

`temporalValue.test.ts`:

- `timeOfDay(9, 30, 15, 250)` equals `new Date(1970, 0, 1, 9, 30, 15, 250)`; `ms` defaults to 0.
- `parseIsoTimeOfDay`: every row of the time-of-day table under _Internal Structure_.
- `parseLocalTemporal('date', "2026-06-28")` and `('datetime', "2026-06-28")` both equal `new Date(2026, 5, 28)`; `('date', "2026-02-30")` is `null`; `('date', "2026-06-28T00:00:00Z")` and `('datetime', "2026-06-28T12:04")` are `null`.
- `toLocalIsoString(new Date(2026, 5, 28, 12, 4, 59, 123))` starts with `2026-06-28T12:04:59.123` and ends with the offset computed from `getTimezoneOffset()` as `±HH:MM`. A host at UTC gives `+00:00`, never `Z`.
- `toLocalIsoString` over every row of the expanded-year table under _Architecture Decisions_.
- `formatWireTemporal`: `('date', new Date(2026, 5, 28))` → `"2026-06-28"`; `('time', new Date(1970, 0, 1, 9, 30, 15, 250))` → `"09:30:15.250"`; `('datetime', d)` and `(undefined, d)` → `toLocalIsoString(d)`; an Invalid `Date` → `null` for every type.
- `stringifyWithLocalDates({ d: new Date(2026, 5, 28), n: 1, s: "x", nil: null })` parses back to `{ d: toLocalIsoString(…), n: 1, s: "x", nil: null }`. A nested array of `Date`s is converted too. An Invalid `Date` becomes `null`. A top-level `Date` becomes a JSON string.

`Field.test.ts`:

- A `date` field converts `"2026-06-28"` to a `Date` equal to `new Date(2026, 5, 28)`.
- A `datetime` field converts `"2026-06-28"` to `new Date(2026, 5, 28)`.
- A `time` field converts `"09:30:15.250000"` to `new Date(1970, 0, 1, 9, 30, 15, 250)`.
- A `date` field still converts `"2026-06-28T12:04:00Z"` through `new Date(...)`, and still maps `"not-a-date"` to `undefined`.
- A `datetime` field converts `"2026-06-28T12:04:00"` to `new Date(2026, 5, 28, 12, 4)` (offset-less means local, unchanged).
- A `Date` passes through by reference for all three types.

`Writer.test.ts` / `AjaxProxy.test.ts`:

- For a model with fields `d: date`, `t: time`, `dt: datetime`, `a: auto`, `new JsonWriter().writeRecord(record)` writes `d` as `"2026-06-28"`, `t` as `"09:30:15.250"`, and `dt` and `a` as `toLocalIsoString(value)`.
- A `Date` inside an object value of an `auto` field is written as `toISOString()`.
- In `'dirty'` mode an update with only `d` changed writes `{ d: "2026-06-28", <pk>: … }`.
- A subclass overriding `dataFor` sees its result written, `Date`s by field type (compile-time proof that `dataFor` is `protected`).
- Every existing `Writer.test.ts` case still passes unchanged; none of them holds a `Date`.
- `AjaxProxy`'s built URL for a filter `{ type: "gte", field: "d", value: new Date(2026, 5, 28) }` carries `filter=` whose decoded JSON value is `toLocalIsoString(thatDate)`.

`ColumnFilter.test.ts`:

- The filter for a `date` column, operator `eq`, text `2026-06-28` is `and(gte new Date(2026,5,28), lt new Date(2026,5,29))`, compared by `getTime()`.
- For a `datetime` column, operator `gte`, text `2026-06-28`, the operand equals `new Date(2026, 5, 28)`.

`TimeField.test.ts`:

- Typing `09:30` and committing gives `new Date(1970, 0, 1, 9, 30)`.
- A dropdown pick of 14:45 gives `new Date(1970, 0, 1, 14, 45)`.
- With the system time at 28 June 2026 23:50, typing `+30mi` gives `new Date(1970, 0, 1, 0, 20)`.
- `setValue(new Date(2025, 5, 15, 9, 30))` still displays `09:30`.

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

`test_run_query.py`: the short-name mapping listed in step 16.

### Frontend — unit-testable (`npm test`)

- `buildModel` / `buildQueryModel`: `isoDate` → `date`, `isoTime` → `time`, `isoString` → `datetime`.
- `SqlAdminWriter`:
  - every `row-write-changed-fields` case kept in step 22 still passes (update sends the diff plus the primary key, create sends the full row, generated columns stripped, `null` written as `null`);
  - a `date` field set to `new Date(2026, 5, 28)` is written as `"2026-06-28"`;
  - a `datetime` field set to `new Date(2026, 5, 28, 8, 0)` is written as `toLocalIsoString`-shaped text: starts with `2026-06-28T08:00:00.000` and ends in `±HH:MM`, never `Z`.
- `isFilterableColumn`: true for `isoDate` and `isoTime`.
- `chartConfig`:
  - `xCandidates` includes an `isoDate` column and excludes an `isoTime` one.
  - `isTimeX` is true for `isoDate` and false for `isoTime`.
  - `defaultChartConfig` picks an `isoDate` column as x when no `isoString` column precedes it.
  - `buildChartSeries` maps an `isoDate` value `"2026-06-28"` to `new Date(2026, 5, 28).getTime()`, and drops a `null` date.

### Manual — the running app, in two browser time zones

**Setup.** Link check per step 1, `build:lib` done, backend and frontend dev servers restarted. Log in (see the `verify` skill for the host). In a Query tab, run these two statements one at a time, then refresh the navigator:

```sql
CREATE TABLE public.tz_probe (
    id serial PRIMARY KEY,
    d date, t time, ts timestamp, tstz timestamptz, note text
);
INSERT INTO public.tz_probe (d, t, ts, tstz, note) VALUES
    ('2026-06-28', '09:30:15.25', '2026-06-28 12:04:59.5',
     '2026-06-28 12:04:59.123456+00', 'a');
```

**Time zones.** Run cases 1-9 twice: once with the browser in `America/Los_Angeles` (UTC-7) and once in `Asia/Tokyo` (UTC+9). Set the zone with DevTools → Sensors → Location → Timezone ID. **Reload the page after every change**: the library caches one date formatter per page. Confirm with `Intl.DateTimeFormat().resolvedOptions().timeZone` in the console.

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

- **Library** (`/home/jika/typescript/typescript-ui`): `npm test`, `TZ=America/Los_Angeles npm test`, `TZ=Asia/Kolkata npm test`, `npm run lint`, `npm run docs:api` (zero warnings), `npm run docs:llms:check`, `npm run build:lib`.
- **Backend**: `cd backend && poetry run python -m pytest`.
- **Frontend**: `cd frontend && npm run typecheck && npm test`, `TZ=America/Los_Angeles npm test`, `TZ=Asia/Tokyo npm test`.
- `grep -rn "_instant_cast\|_INSTANT_CAST_TYPES\|_DATETIME_TYPES" backend/app` — zero matches.
- `grep -n "JSON.stringify(this.dataFor" ../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts` — zero matches.
- `grep -n "new Date()" ../typescript-ui/packages/lib/src/typescript/lib/component/input/TimeField.ts` — only the relative-shorthand base in `parseRaw`.
- `grep -n "buildModel.ts:14" TODO.md` — zero matches (the backlog bullet is gone).
- Manual: the 12 cases above. Entry points: navigator → `public.tz_probe` / `wide.cols_10` → Data / Structure; the Query workspace for cases 8-9.

---

## Documentation Impact

### Library

- **`docs/data/model.md`** — in the field-type table ([line 55](../typescript-ui/packages/lib/docs/data/model.md#L55)):
  - `'date'` and `'datetime'` read a bare `YYYY-MM-DD` as local midnight;
  - `'time'` reads `HH:MM[:SS[.fraction]]` as that time on 1 January 1970, local, to the millisecond;
  - anything else still goes through `new Date(raw)`.

  Add one sentence to the coercion paragraph at [line 65](../typescript-ui/packages/lib/docs/data/model.md#L65) saying so.
- **`docs/data/proxy.md`** — the Remote sort & filter paragraph ([line 90](../typescript-ui/packages/lib/docs/data/proxy.md#L90)) says a filter `Date` is sent as local ISO-8601 with its UTC offset (`2026-06-28T00:00:00.000-07:00`). The Reader & Writer paragraph ([line 171](../typescript-ui/packages/lib/docs/data/proxy.md#L171)) no longer says `JSON.stringify(record.getData())`: it gives the three write forms (`date` `2026-06-28`, `time` `09:30:15.250`, anything else local ISO with offset), and says a custom writer can subclass `JsonWriter` and override `dataFor`.
- **`docs/components/TimeField.md`** — lines 5 and 52 say the value's date comes from the local clock. Both now say the value sits on 1 January 1970, local; a relative shorthand is resolved against now and then placed on that date.
- **`docs/reference/changelog/next.md`**:
  - _Changed → Data_: `JsonWriter` writes a `Date` by field type; `AjaxProxy`'s `filter=` writes local offsets; `date` and `datetime` fields read a bare date as local midnight; `TimeField` values sit on 1 January 1970.
  - _Added_: `JsonWriter.dataFor` is `protected`.
  - _Fixed_: a `time` field reads `HH:MM[:SS[.fraction]]` (store `time` columns were always empty); the filter row reads a typed `YYYY-MM-DD` as a local day.

  Each entry says why, in the page's existing voice, and links to the migration page.
- **`docs/reference/migration/next.md`** — three sections, each saying who must act and what to do, with a before/after pair from the tables under _Architecture Decisions_:
  - _A `Date` crosses the wire in local form._ A server that string-matches a trailing `Z`, or that takes the first ten characters of a `date` value and relied on the day being UTC's, must parse the value by type instead.
  - _A store reads a bare date or a time of day as a local value._ Code that relied on UTC midnight for a bare date, or on a `time` column being empty. State that the 0.10.0 note "a store `time` or `datetime` column reads with `new Date(...)`" ([migration/0.10.0.md:595](../typescript-ui/packages/lib/docs/reference/migration/0.10.0.md#L595)) no longer holds for `time`, nor for a bare-date `datetime` value. The 0.10.0 page itself stays as it was released.
  - _`TimeField` values sit on 1 January 1970._ Code that reads the date part of a `TimeField` value or compares it with today.
- **`packages/lib/llms.txt`** — regenerated by `npm run docs:llms` if `docs:llms:check` reports drift.
- No barrel change: `temporalValue.ts` is internal, and `JsonWriter` is already exported.

### App

- **`TODO.md`** — the `date`/`time` bullet under `### Data` is deleted (step 28).
- **`LIBRARY_NOTES.md`**:
  - new top entry `## 🐞✅ Temporal field values lost their day and time of day between the grid and the server (0.10.0, symlinked)`. It lists the library defects (the bare-date and `time` `Field` reading, the UTC `Date` wire form, the filter-row date parse), their fix on `feature/date-time-wire-values` for 0.11.0, and where the app adopts them (`buildModel.ts`, `SqlAdminWriter.ts`). Follow the existing entries' prose format.
  - the `row-write-changed-fields` entry `✂️🩹🔎 JsonWriter writes every Date as a UTC instant, and its dirty mode cannot be extended` becomes `✂️✅`, with one closing paragraph: fixed for 0.11.0, and the app-side workaround in `SqlAdminWriter.ts` removed.
- **`README.md`** — no change; it does not list column types.
- **`CHANGELOG.md`** — no entry; written at release time. See [Addendum: Release-note material](#addendum-release-note-material).

---

## Potential Challenges

- **The link may be a real directory.** Once `typescript-ui-0-10-0-upgrade`'s post-release swap has run, `frontend/node_modules/@jimka/typescript-ui` is the registry copy. Step 1 re-creates the symlink; without it the app silently runs 0.10.0 and every manual case fails.
- **Stale library build.** The app runs the library's built `dist/lib`. After every library edit run `npm run build:lib`, then reload with the cache bypassed; restart the Vite dev server if the page still shows the old behaviour.
- **A browser time-zone change needs a page reload.** The library's temporal formatters are built once per page and never follow a zone change.
- **`time '24:00:00'`** is legal in Postgres but has no local `Date`. `parseIsoTimeOfDay` rejects it, and the cell shows blank. It is not written back, because the writer only sends changed fields.
- **A naive `timestamp` inside a DST gap**, e.g. `2026-03-08 02:30` in Los Angeles, does not exist locally. The browser shows it one hour later. It is only rewritten if the user edits that cell.
- **Python 3.10's `fromisoformat`** (the local venv; the Docker image runs 3.12) only accepts a 3- or 6-digit fraction. Every value the grid or the export writes has one of those. A hand-written import file with `09:30:15.25` is rejected per row with the existing coercion error.

---

## Critical Files

| File | Why |
|---|---|
| [`plans/row-write-changed-fields.md`](plans/row-write-changed-fields.md) | What this plan builds on and partly replaces (the writer, the `timestamp` write rule). |
| [`backend/app/wire.py`](backend/app/wire.py) | Every backend mapping this plan changes; `_parse_iso_datetime` (:160) and `_to_utc` (:373) are reused. |
| [`backend/app/contract.py`](backend/app/contract.py) | `WireType` (:16): the seam the new members extend. |
| [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) | The comparator branch (:183) and the cast being removed. |
| [`frontend/src/data/buildModel.ts`](frontend/src/data/buildModel.ts) | `WIRE_TO_FIELD` (:10), the frontend half of the seam. |
| [`frontend/src/data/SqlAdminWriter.ts`](frontend/src/data/SqlAdminWriter.ts) | The writer being rebased onto `JsonWriter`. |
| [`plans/implemented/date-column-filter-support.md`](plans/implemented/date-column-filter-support.md) | The filter design this plan builds on and partly reverses (its `why-date-cast` footnote). |
| `../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts` (`convertByType` 174) | The read-side defect. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts` (`JsonWriter` 84, `dataFor` 131) | The dirty mode `SqlAdminWriter` adopts; the serializer being changed. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts` (`filter` 188) | The filter-param serializer. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/input/dateMath.ts` (`formatIsoDate` 185, `parseIsoDate` 208) | The local-midnight rule the data layer adopts, and the year padding the wire form extends. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnFilter.ts` (`parseTimeOfDay` 279, `parseOperand` 290, `displayBucket` 345, the temporal `eq` branch 462) | What a temporal filter cell sends. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/cell/editor/Time.ts` (219) | The 1970-01-01 local convention `TimeField` moves to. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/input/TimeField.ts` (`parseRaw` 123, `onTimeSelected` 171) | The one component still anchored on today. |
| `../typescript-ui/release-steps.md` | How `next.md` becomes the 0.11.0 changelog and migration pages. |
| `.claude/skills/verify/SKILL.md` | The _Library changes_ section: symlink and rebuild mechanics. |

---

## Non-Goals

- **Renaming `isoString`.** It keeps its name and now means "timestamp".[^keep-isostring]
- **Anything `row-write-changed-fields` already did**: changed-fields updates, the `interval`/`timetz` text codecs, and the `timestamp` save failure.
- **Showing seconds in `time` / `datetime` cells.** The library default (`showSeconds: false`) stays, per the project's prefer-library-defaults rule.
- **`infinity` / `-infinity` and BC dates.** asyncpg's decoding of these is unchanged, and Python's `datetime` holds only years 1-9999.
- **Temporal primary keys.** A `Date` primary key goes into the row URL through `String(date)` today. This plan does not change that.
- **A matview column declared with a precision** (`time(3)`, `timestamp(3) with time zone`). It still falls through to `STRING`; that is the existing `TODO.md` known issue.
- **Plotting `time` columns** on a chart axis.[^chart-time]
- **Releasing typescript-ui 0.11.0, or bumping either project's version or dependency range.** That is release work, run by hand after this plan's verification.[^no-bump]

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
- Migrated to `@jimka/typescript-ui` 0.11.0, which sends each date, time and date-time value in its field type's own form.

---

## Notes

[^wire-seam]: `WireType` has not changed since Phase 0 (`git log -- backend/app/contract.py`), but it is the only place the backend tells the frontend what kind of value a column holds. `buildModel.ts`'s module comment names it as the source of every `FieldType`, and `contract.py`'s module docstring says the frontend mirrors the wire set and never Postgres. Keying the frontend on `ColumnMeta.dataType` was rejected for two reasons. No frontend code reads `dataType` for value handling once `SqlAdminWriter`'s zone-less set is gone, and a query result has no `dataType` at all.

[^keep-isostring]: Renaming `isoString` to something like `isoDateTime` would be more precise now that it covers only timestamps. But it would touch every test fixture, both contract files, `chartConfig.ts`, `serialize.ts` and the Structure tab's visible "Wire type" column, and change nothing a user sees. A naive and a zone-aware timestamp can share one wire type because the value tells them apart: only `timestamptz` carries an offset, and `new Date()` reads an offset-less date-time as local, which is how a naive timestamp should display.

[^fix-in-library]: The project rule (memory `fix-in-library-not-workaround`) is that a defect that starts in typescript-ui is fixed there, not worked around in the app. A per-field `convert` hook in `buildModel.ts` would have worked, but it would leave every other library consumer reading dates a day early west of UTC. It would also leave `Field` disagreeing with the library's own `DateField` and date editor, whose `parseIsoDate` already carries the comment "Local midnight, appended so the day is not shifted by the UTC parse `new Date("YYYY-MM-DD")` would otherwise perform". A `datetime` field gets the same bare-date reading because a bare date typed or stored in a date-time column means that local day too, which is how 0.10.0 already treats it in the date-time editor. `parseIsoDate` moves into `data/` because a data-layer module must not import from `component/`; no file under `data/` does today.

[^one-anchor]: A `time` value's date part carries no meaning, but it still takes part in every `getTime()` comparison: `ModelRecord`'s dirty check, the filter row's equality bucket, and sorting. With two anchors, a `TimeField` bound to a `time` field would mark an untouched value dirty, since today's 09:30 and 1970's 09:30 differ. 1970 is chosen because the store, the cell editor, the filter row and the demos (`MiscPanel.ts`) already use it; only `TimeField` moves. Europe/London was UTC+1 all through 1970, so a 1970 value's offset there is `+01:00`, but the backend reads a `time` operand by its wall clock, so that offset never matters.

[^write-form]: Once a `date` field holds local midnight, the old `toISOString()` form is wrong east of UTC. Tokyo's midnight on 28 June is `2026-06-27T15:00Z`, and a server that keeps the first ten characters stores the 27th. Fixing reads without fixing writes would turn a west-of-UTC display bug into an east-of-UTC data-corruption bug. Writing by field type gives each value the exact text a server stores for it: a bare date, a bare time, and for a date-time the local wall clock plus the offset that makes it an instant. Writing a `date` or `time` as a local-offset date-time instead would also work for SQLAdmin, but every server would then have to know to drop the time or the date again, and a `time` would carry the meaningless 1970 date. `WebStorageProxy` also stringifies records, but it reads them back through the same `Field` conversion in the same browser, so it is left alone.

[^local-offset]: A filter operand has the same day problem as a written value, in the other direction: from a UTC instant alone the server cannot tell which local day a `date` operand meant. `AjaxProxy` builds `filter=` from filter descriptors, which name a field but not its type, so the type-based form is not available there. A local-offset ISO string is one type-agnostic rule that is still the same instant for any ISO parser, and it is self-describing. A client-time-zone request header was rejected: it adds hidden state that changes the meaning of every value, and needs a zone database on the server.

[^extended-year]: ISO 8601's four-digit year covers 0000-9999; outside that range it requires an agreed expansion, and `Date.prototype.toISOString` uses a sign plus six digits (`+275760-09-13T…`). Using the same form keeps a year from ever being truncated or silently misread. The library's own `formatIsoDate` writes a negative year as a sign plus four digits (`-0001`); it is a display format for `DateField` and is left alone. SQLAdmin itself cannot store such values: the grid's date editors accept only four-digit years, and Python's `datetime` holds years 1-9999.

[^wall-clock]: For a zone-less Postgres type, what the user saw is the value. The frontend displays a naive timestamp, a date and a time of day as local wall-clock values, so the wall clock in the string is what the user meant. This is also Postgres's own rule: `'2026-06-28 12:04+02'::timestamp` ignores the offset and yields `12:04`. `row-write-changed-fields` converted an offset to UTC first, so that its write rule matched the filter-operand rule of the time. That was the right reading only while the frontend sent UTC (`…Z`) strings, where both rules agree. With local offsets, converting to UTC would give the UTC wall clock, which is right only for a browser at UTC; it is the "client-offset shift" `date-column-filter-support` listed as a non-goal. Both functions therefore switch together.

[^date-truncate]: `date-column-filter-support` compared a `date` column as `"day"::timestamp` because its operands came from a `datetime` field. "Equals" there was a one-minute range, which truncation would have collapsed to an empty one (its `why-date-cast` footnote). A `date` field's "Equals" is a whole local day, so both bounds truncate to distinct days and the collapse cannot happen. Truncation is also the only form that works in zones whose DST change happens at midnight, such as America/Santiago or America/Havana. There `new Date(y, m, d)` on the change day is 01:00. Under the cast, "At least 6 September" would bind `2026-09-06 01:00` and exclude 6 September itself. Truncated, it binds `date(2026,9,6)`. One behaviour differs, and it is accepted. If a user types a time into a `date` column's "At least" filter (`2026-06-28 15:00`), the truncated form includes the 28th while an exact comparison would not. The cell shows no time, so including the day the user typed is the reading that matches the screen.

[^rebase-writer]: `row-write-changed-fields` could not subclass `JsonWriter` because `dataFor` was `private`, so it implemented `Writer` and repeated the dirty-mode rule; it also formatted zone-less timestamps itself, because 0.10.0's `JsonWriter` could only write UTC. Both reasons go away here. Reusing `JsonWriter` is the precedent the library intends ("only the fields changed since the last commit, plus the primary key"), and it is the only way the app gets the type-based write form. Composition was rejected because `JsonWriter` serializes inside `writeRecord`, so a wrapper could not strip generated columns before serialization without re-implementing it. A generated column can never be dirty, since the grid marks it read-only; the strip is kept for creates and as a guard.

[^chart-time]: The chart library plots x as a number, and a time axis reads it as epoch milliseconds. A `date` value is a day, so local midnight of that day plots where the grid says it is. `Date.parse("2026-06-28")` would plot at UTC midnight, the previous evening west of UTC. A `time` value has no date. Plotting it on 1 January 1970 would label every tick with that date, and a real time-of-day axis is new chart work, not part of this change.

[^minor]: Pre-1.0, typescript-ui ships behaviour changes in a minor release with a migration page, as 0.10.0 did for its parsing changes (`migration/0.10.0.md`). A consumer whose server reads `toISOString()` text, or whose code reads the date part of a `TimeField` value, sees different results after upgrading, so this is not a patch. `release-steps.md` turns `changelog/next.md` and `migration/next.md` into the numbered pages at release time, so this plan writes only to `next.md`.

[^no-bump]: Per memory `library-release-gated-on-sqladmin`, a typescript-ui release waits until SQLAdmin has verified it against a symlinked local build, and an app plan never waits on the release. So 0.11.0 is released after this plan's manual verification, by hand. The app then runs `npm install @jimka/typescript-ui@^0.11.0` in `frontend/`, which drops the symlink, moves the range and rewrites the lockfile, and re-runs its checks against the registry copy, as `typescript-ui-0-10-0-upgrade`'s post-release swap addendum does for 0.10.0. Until then `package.json` naming an older range than `node_modules` holds is expected. Version bumps, tags and commits stay manual (memory `release-steps-manual`).
