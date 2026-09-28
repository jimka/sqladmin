---
touches-shared:
  - backend/app/wire.py
  - backend/app/connections.py
  - backend/tests/test_wire.py
  - frontend/src/data/SqlAdminWriter.ts
  - frontend/src/data/stores.ts
  - LIBRARY_NOTES.md
---

# Row Writes Send Changed Fields — Implementation Plan

## Overview

Saving an edited row fails today on any table that has a `timestamp without time zone` column, whichever cell was edited. The data grid's writer, [`SqlAdminWriter`](frontend/src/data/SqlAdminWriter.ts#L8), sends every column of the row. `JSON.stringify` writes each `Date` in UTC form (`…Z`). [`from_wire_value`](backend/app/wire.py#L196) then parses that string into a timezone-aware `datetime`, and asyncpg refuses an aware value for a `timestamp` parameter (`DataError: can't subtract offset-naive and offset-aware datetimes`, reproduced against the dev database on 2026-09-28). The same full-row save also cuts every unedited `timestamptz` value down from microseconds to milliseconds. A row with an `interval` column cannot be saved either, because asyncpg cannot encode the interval text the grid sends back.

This plan fixes those save failures and the precision loss in SQLAdmin alone, against the already-released typescript-ui 0.10.0:

- **frontend** — `SqlAdminWriter` sends only the changed fields plus the primary key on an update, and writes a zone-less `timestamp` value as the wall-clock time the grid showed.
- **backend** — `from_wire_value` binds a naive `datetime` for a `timestamp` column. [`_init_connection`](backend/app/connections.py#L78) registers a Postgres-text codec for `interval` and `timetz`, and [`pg_type_to_wire`](backend/app/wire.py#L65) maps both to `STRING`.

The `date`/`time` field types, the local-offset wire form and the filter changes need library changes. They stay in [`date-time-column-field-types`](plans/date-time-column-field-types.md), which builds on this plan.

---

## Architecture Decisions

### An update sends only the changed fields plus the primary key

`SqlAdminWriter.writeRecord(record, operation)` uses `record.getChangedData()` when `operation` is `'update'`, and `record.getData()` otherwise. It still strips generated columns from both. This is the rule the library's own `JsonWriter` applies in `'dirty'` mode ([`Writer.ts:131`](../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts#L131)); `SqlAdminWriter` repeats it because `JsonWriter.dataFor` is `private` in 0.10.0.[^dirty-rule]

A column nobody edited is therefore never rewritten. That alone fixes two things for unedited cells: the microsecond loss on `timestamptz`/`timestamp` values, and the save failure caused by an unedited `timestamp` column.

The backend needs no change for partial bodies. `PUT …/rows/{row_id}` finds the row by the `row_id` path segment, and [`UpdateRowCommand`](backend/app/operations/update_row.py#L56) assigns only the keys the body carries and skips the primary key.[^pk-in-body]

| Row before | Edit | Body sent before | Body sent now |
|---|---|---|---|
| `{id: 1, name: "Ada", tstz: 12:04:59.123456Z, ts: 12:04:59.5}` | `name` → `"Grace"` | every column; `tstz` as `…12:04:59.123Z` | `{"name": "Grace", "id": 1}` |
| same | none (row not dirty) | nothing | nothing |
| new row | insert | full row minus generated columns | unchanged |

### A zone-less `timestamp` is written as the wall clock the grid showed

A `timestamp without time zone` value reaches the frontend with no offset (`2026-06-28T12:04:59.500000`). The library reads an offset-less date-time as local time, so the grid shows `12:04` in every browser time zone. `SqlAdminWriter` writes such a column's `Date` back the same way: the local date and time with no offset, `2026-06-28T08:00:00.000`. The backend binds that text as-is.[^wall-clock-write]

`SqlAdminWriter` learns which columns are zone-less from a second constructor argument. [`buildStore`](frontend/src/data/stores.ts#L19) computes it next to the existing `generated` set: columns whose `wireType` is `isoString` and whose `dataType` is `timestamp without time zone`.

Each temporal column is written in the form that undoes how it was read:

| Column | Read by the library as | Written as |
|---|---|---|
| `timestamptz` (`…12:04:59.123456+00:00`) | that instant | `Date.toISOString()` — the same instant (unchanged) |
| `timestamp` (`…12:04:59.500000`) | local wall clock | local wall clock, no offset (new) |
| `date` (`2026-06-28`) | UTC midnight | `Date.toISOString()`; the backend keeps the first ten characters (unchanged)[^date-left-alone] |

### The backend binds a naive `datetime` for a `timestamp` column

`from_wire_value` returns a naive `datetime` for every `ISO_STRING` column that is not `date`, `time` or `timestamptz`. An offset-less string keeps its wall clock. A string with an offset is converted to UTC and the offset is dropped: `_to_utc(moment).replace(tzinfo=None)`, the same reading [`from_wire_filter_operand`](backend/app/wire.py#L420) already gives a `timestamp` filter operand.[^naive-rule]

| Column | Value received | Bound |
|---|---|---|
| `timestamp` | `2026-06-28T08:00:00.000` (the grid) | `datetime(2026,6,28,8,0)` |
| `timestamp` | `2026-06-28T12:04:59.500000` (an exported file, re-imported) | `datetime(2026,6,28,12,4,59,500000)` |
| `timestamp` | `2026-06-28T12:04:00.000Z` | `datetime(2026,6,28,12,4)` |
| `timestamp` | `2026-06-28T14:04:00+02:00` | `datetime(2026,6,28,12,4)` |
| `timestamptz` | `2026-06-28T12:04:59.110Z` | `datetime(2026,6,28,12,4,59,110000,tzinfo=utc)` (unchanged) |

### `interval` and `timetz` are read and written as Postgres text

`_init_connection` registers a text codec for `interval` and `timetz` next to its `json`/`jsonb` codec ([`connections.py:85`](backend/app/connections.py#L85)). asyncpg then returns Postgres's own text for both and accepts text for writes. `pg_type_to_wire` maps both to `STRING`, so the grid shows and edits them as plain text and the filter row compares them as text.[^text-codec]

| Postgres value | Shown before | Shown now |
|---|---|---|
| `interval '1 mon 2 days 03:04:05'` | `32 days, 3:04:05` | `1 mon 2 days 03:04:05` |
| `timetz '09:30+02'` | blank cell | `09:30:00+02` |

Both changes are backend-only: `STRING` already maps to the library's `string` field type in [`buildModel.ts`](frontend/src/data/buildModel.ts#L10).

---

## Public API

### Frontend — `frontend/src/data/SqlAdminWriter.ts`

```ts
import type { ModelRecord, WriteOperation, Writer } from "@jimka/typescript-ui/data";

export class SqlAdminWriter implements Writer {
    constructor(
        private readonly generatedColumns: ReadonlySet<string>,
        private readonly zonelessTimestampColumns: ReadonlySet<string> = new Set(),
    );
    writeRecord(record: ModelRecord, operation?: WriteOperation): string;
    writeRecords(records: ModelRecord[], operation?: WriteOperation): string;
}
```

`WriteOperation` is exported from `@jimka/typescript-ui/data` in both 0.9.0 and 0.10.0, so the app's `^0.9.0` range does not matter here.

---

## Implementation

### Frontend — `SqlAdminWriter.ts`

```ts
// ISO 8601 writes a calendar year as four digits, the month, day, hour, minute
// and second as two, and milliseconds as three. A JS Date holds nothing finer.
const ISO_YEAR_DIGITS   = 4;
const ISO_FIELD_DIGITS  = 2;
const ISO_MILLIS_DIGITS = 3;
```

`formatWallClock(date: Date): string` is module-private. It builds `YYYY-MM-DDTHH:MM:SS.sss` from the local getters (`getFullYear` … `getMilliseconds`), zero-padded to the widths above, with no offset. `getMonth()` is zero-based, so add 1 and say so in a comment. No sign handling is needed: the grid's date-time editor accepts only four-digit years, and the backend reads only years 1-9999.

| Local `Date` | `formatWallClock` |
|---|---|
| `new Date(2026, 5, 28, 8, 0)` | `2026-06-28T08:00:00.000` |
| `new Date(2026, 11, 31, 23, 59, 59, 500)` | `2026-12-31T23:59:59.500` |
| `new Date(999, 0, 1, 9, 5, 7, 45)` | `0999-01-01T09:05:07.045` |

The private `strip` becomes `toBody`:

```ts
private toBody(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
        if (this.generatedColumns.has(key)) {
            continue;
        }

        out[key] = value instanceof Date && this.zonelessTimestampColumns.has(key) ? formatWallClock(value) : value;
    }

    return out;
}

private dataFor(record: ModelRecord, operation?: WriteOperation): Record<string, unknown> {
    return operation === "update" ? record.getChangedData() : record.getData();
}
```

`writeRecord` returns `JSON.stringify(this.toBody(this.dataFor(record, operation)))`; `writeRecords` maps the same over every record.

### Frontend — `stores.ts`

```ts
// The Postgres type name information_schema reports for a zone-less timestamp.
// Mirrors backend/app/wire.py: that column arrives as offset-less ISO text, so
// SqlAdminWriter writes it back the same way (see SqlAdminWriter.ts).
const ZONELESS_TIMESTAMP_TYPE = "timestamp without time zone";
```

In `buildStore`, after `generated`:

```ts
const zoneless = new Set(
    columns.filter(c => c.wireType === "isoString" && c.dataType === ZONELESS_TIMESTAMP_TYPE).map(c => c.name),
);
```

and pass `new SqlAdminWriter(generated, zoneless)`. A table or view's `dataType` comes from `information_schema.columns.data_type`, which never carries a precision, so an exact match is enough.[^matview-precision]

### Backend — `wire.py`

Constants ([`wire.py:33-62`](backend/app/wire.py#L33)):

- remove `"time with time zone"` and `"timetz"` from `_DATETIME_TYPES` and from `_TIME_TYPES`;
- delete `_TIMETZ_TYPES` and its comment;
- add, after `_TIMESTAMPTZ_TYPES`:

```python
# Read and written as Postgres's own text: connections._init_connection
# registers a text codec for each (by its pg_catalog name, interval / timetz).
_POSTGRES_TEXT_TYPES = frozenset({"interval", "time with time zone", "timetz"})
```

`pg_type_to_wire` — after the `_DATETIME_TYPES` check ([line 85](backend/app/wire.py#L85)):

```python
if dt in _POSTGRES_TEXT_TYPES:
    return WireType.STRING
```

`from_wire_value` — the `ISO_STRING` branch ([lines 196-203](backend/app/wire.py#L196)) ends:

```python
moment = _parse_iso_datetime(value)

if data_type in _TIMESTAMPTZ_TYPES:
    return moment

# A zone-less timestamp: asyncpg rejects an aware datetime for it. An
# offset-less string (what SqlAdminWriter and the export write) keeps its wall
# clock; one with an offset keeps its UTC wall clock, as
# from_wire_filter_operand reads the same column.
return _to_utc(moment).replace(tzinfo=None)
```

Add one sentence to the docstring: a `timestamp without time zone` value always binds as a naive `datetime`.

`from_wire_filter_operand` ([line 381](backend/app/wire.py#L381)): delete the `_TIMETZ_TYPES` branch (lines 423-424) and the docstring bullet about `time with time zone`. A `timetz` column is now `STRING`, so its operand passes through unchanged as text, like every other non-temporal column.

### Backend — `connections.py`

```python
# asyncpg decodes these to Python values that lose information or have no
# frontend field type: `interval` becomes a timedelta (a month becomes 30 days,
# and str() of it is text Postgres cannot parse back), `timetz` a time whose
# offset nothing in the grid can show or edit. Both are read and written as
# Postgres's own text instead; wire.pg_type_to_wire maps them to
# WireType.STRING to match.
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

### Backend — test-first (`cd backend && poetry run python -m pytest` in the worktree)

1. **`backend/tests/test_wire.py`** — per _Expected Behaviour → Backend_:
   - add `("time with time zone", WireType.STRING)`, `("timetz", WireType.STRING)`, `("interval", WireType.STRING)` and `("timestamp without time zone", WireType.ISO_STRING)` to the `test_pg_type_to_wire` table ([line 27](backend/tests/test_wire.py#L27));
   - add `test_from_wire_timestamp_without_tz_binds_naive` (parametrized over the four `timestamp` rows of the write table under _Architecture Decisions_; assert equality **and** `tzinfo is None`);
   - delete the `"time with time zone"` row of `test_from_wire_filter_operand_temporal_types` ([line 189](backend/tests/test_wire.py#L189)) and `test_from_wire_filter_operand_time_with_tz_is_aware` ([line 225](backend/tests/test_wire.py#L225));
   - add `test_from_wire_text_decoded_types_pass_through`: `from_wire_value` on a `STRING` column of data type `interval` (`"1 mon"`) and `time with time zone` (`"09:30+02"`) returns the string unchanged;
   - add `(WireType.STRING, "time with time zone", "09:30")` and `(WireType.STRING, "interval", "1 day")` to `test_from_wire_filter_operand_passes_non_temporal_columns_through`'s parameter table ([line 233](backend/tests/test_wire.py#L233)).

   Run `tests/test_wire.py` — red.

2. **`backend/app/wire.py`** — constants, `pg_type_to_wire`, `from_wire_value` and `from_wire_filter_operand` per _Implementation_. Green. `grep -n "_TIMETZ_TYPES" backend/app/wire.py` — zero matches.

3. **`backend/tests/test_update_row.py`** — add `test_partial_payload_assigns_only_its_columns`: `UpdateRowCommand(NO_CONN, TABLE, 1, {"name": "Grace", "id": 1}, ROW_COLS)` has `_assign == ["name"]` and `_values == ["Grace"]`. Add `test_timestamp_value_binds_naive`: with `ROW_COLS + [col("logged_at", WireType.ISO_STRING, data_type="timestamp without time zone")]` and body `{"logged_at": "2026-06-28T12:04:00.000Z", "id": 1}`, `_values == [datetime.datetime(2026, 6, 28, 12, 4)]` and its `tzinfo is None`. Both pass with step 2 in place; no source change in `update_row.py`.

4. **`backend/tests/test_connections.py`** — add `test_init_connection_registers_json_and_text_codecs`. A small recording fake with an `async def set_type_codec(self, typename, **kwargs)` appends `(typename, kwargs)`. Assert `json`/`jsonb` are registered with `encoder=json.dumps, decoder=json.loads, schema="pg_catalog"`, and `interval`/`timetz` with `encoder=str, decoder=str, schema="pg_catalog", format="text"`. Red.

5. **`backend/app/connections.py`** — `_TEXT_DECODED_TYPES` and the loop per _Implementation_. Extend `_init_connection`'s docstring by one sentence naming the text codecs. Green.

6. **`backend/tests/test_run_query.py`** — beside `test_short_name_type_mapping` ([line 123](backend/tests/test_run_query.py#L123)), add `test_short_name_text_decoded_types`: attributes `interval` and `timetz` with row `("1 mon", "09:30:00+02")` map to `"string"` and keep their text. No source change: `_query_columns` already goes through `pg_type_to_wire`.

7. **Checkpoint.** `cd backend && poetry run python -m pytest` — whole suite green.

### Frontend (`cd frontend`)

8. **Worktree prerequisite.** If `frontend/node_modules` is missing in the worktree, symlink it: `ln -s /home/jika/typescript/sqladmin/frontend/node_modules frontend/node_modules`. Never commit the link.

9. **`frontend/tests/data/SqlAdminWriter.test.ts`** — keep the four existing cases unchanged (they pass no operation, so they still get the full record). Add the cases from _Expected Behaviour → Frontend_. Red.

10. **`frontend/src/data/SqlAdminWriter.ts`** — per _Public API_ and _Implementation_: the second constructor argument, `writeRecord`/`writeRecords` taking `operation`, `dataFor`, `toBody` (replacing `strip`), `formatWallClock` and its constants. Rewrite the file header: generated columns are stripped; an update sends only the changed fields plus the primary key; a zone-less `timestamp` value is written as its local wall clock. Green.

11. **`frontend/src/data/stores.ts`** — `ZONELESS_TIMESTAMP_TYPE` and the `zoneless` set per _Implementation_; pass it as the writer's second argument ([line 31](frontend/src/data/stores.ts#L31)).

12. **Checkpoint.** `npm run typecheck && npm test`, then `TZ=America/Los_Angeles npm test` and `TZ=Asia/Tokyo npm test`.

### Bookkeeping and manual verification

13. **`LIBRARY_NOTES.md`** — add the entry described under _Documentation Impact_ at the top, above the first `##` entry.

14. **Manual verification** — every case under _Expected Behaviour → Manual_, through the running app (see [`.claude/skills/verify/SKILL.md`](.claude/skills/verify/SKILL.md)), in both browser time zones.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/wire.py` |
| Modify | `backend/tests/test_wire.py` |
| Modify | `backend/tests/test_update_row.py` |
| Modify | `backend/app/connections.py` |
| Modify | `backend/tests/test_connections.py` |
| Modify | `backend/tests/test_run_query.py` |
| Modify | `frontend/src/data/SqlAdminWriter.ts` |
| Modify | `frontend/tests/data/SqlAdminWriter.test.ts` |
| Modify | `frontend/src/data/stores.ts` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

Frontend unit tests must pass in any host time zone. Build `Date`s with the local constructor (`new Date(2026, 5, 28, 8, 0)`), never from an ISO string without an offset, and compare `toISOString()` output only for a `Date` built with `Date.UTC`.

### Backend — unit-testable

- `pg_type_to_wire`: `time with time zone`, `timetz`, `interval` → `STRING`; `timestamp without time zone`, `timestamp with time zone`, `date`, `time without time zone` → `ISO_STRING` (unchanged).
- `from_wire_value` on a `timestamp without time zone` column: every `timestamp` row of the write table under _Architecture Decisions_; the result is never aware. The existing `timestamptz` `Z` case, the existing offset-less `timestamp` case, and the `date`/`time` cases keep passing unchanged.
- `from_wire_value` on a `STRING` column with data type `interval` or `time with time zone`: the string passes through unchanged.
- `from_wire_filter_operand`: a `STRING` column of data type `time with time zone` or `interval` returns its operand unchanged, type `str`. Every other existing case keeps passing.
- `UpdateRowCommand`: a partial body assigns only its keys; the primary key in the body is skipped; `{"id": 1}` alone still raises `ValidationError` (existing `test_only_pk_supplied_raises`).
- `_init_connection`: the four codec registrations of step 4.
- `RunQueryCommand`: `interval` and `timetz` result columns report `wireType: "string"`.

### Frontend — unit-testable (`npm test`)

Model for these cases: `new Model([{ name: "id" }, { name: "name" }, { name: "created_at" }, { name: "ts", type: "datetime" }, { name: "tstz", type: "datetime" }], "id")`.

- **Update sends the diff.** Record `{id: 1, name: "Ada", created_at: "2026-01-01", ts: null, tstz: null}`; `record.set("name", "Grace")`; `writeRecord(record, "update")` parses to exactly `{name: "Grace", id: 1}`.
- **Clean update.** On an unedited record, `writeRecord(record, "update")` parses to `{id: 1}`.
- **Create sends the full row.** `writeRecord(record, "create")` on the record above, with `created_at` generated, parses to every field except `created_at`.
- **Generated column stays stripped on update.** With `created_at` generated, `record.set("created_at", "2027-01-01")` then `writeRecord(record, "update")` omits `created_at`.
- **Zone-less timestamp.** With `ts` in the zone-less set, `record.set("ts", new Date(2026, 5, 28, 8, 0))` then `writeRecord(record, "update")` gives `ts: "2026-06-28T08:00:00.000"`.
- **Zone-less timestamp on create.** The same `ts` on `writeRecord(record, "create")` is also `"2026-06-28T08:00:00.000"`.
- **Aware timestamp untouched.** `tstz` (not in the set) set to `new Date(Date.UTC(2026, 5, 28, 12, 4))` is written as `"2026-06-28T12:04:00.000Z"`.
- **Every row of the `formatWallClock` table** under _Implementation_, observed through `writeRecord` on a zone-less column.
- **`null` in a zone-less column** is written as `null`.
- **`writeRecords(records, "update")`** applies the same diff to each record.

### Manual — the running app, in two browser time zones

**Setup.** Backend and frontend dev servers running from the worktree. Log in per the `verify` skill. In a Query tab, run these two statements one at a time, then refresh the navigator:

```sql
CREATE TABLE public.tz_probe (
    id serial PRIMARY KEY,
    ts timestamp, tstz timestamptz, d date, ttz timetz, iv interval, note text
);
INSERT INTO public.tz_probe (ts, tstz, d, ttz, iv, note) VALUES
    ('2026-06-28 12:04:59.5', '2026-06-28 12:04:59.123456+00', '2026-06-28',
     '09:30:00+02', '1 mon 2 days 03:04:05', 'a');
```

No seed schema has a `timestamp`, `timetz` or `interval` column, so this table is the fixture.

**Time zones.** Run cases 1-7 twice: once with the browser in `America/Los_Angeles` and once in `Asia/Tokyo`. Set the zone with DevTools → Sensors → Location → Timezone ID. **Reload the page after every change**: the library builds its date formatters once per page. Confirm with `Intl.DateTimeFormat().resolvedOptions().timeZone` in the console.

1. **Unedited values survive a save.** Open `public.tz_probe` → Data. Edit only `note`, then Save. The PUT body in the network panel is `{"note": …, "id": 1}` and nothing else. `SELECT ts, tstz FROM public.tz_probe` returns `2026-06-28 12:04:59.5` and `2026-06-28 12:04:59.123456+00`. (Before this plan: the save failed with a `DataError` banner.)
2. **Edit a zone-less timestamp.** `ts` shows 28 June 2026 `12:04` in both zones. Set it to `2026-06-28 08:00`, then Save. The PUT body carries `"ts": "2026-06-28T08:00:00.000"`. The query returns `2026-06-28 08:00:00`, and after a reload the cell shows `08:00`, in both zones.
3. **Edit an aware timestamp.** Set `tstz` to the displayed date at `10:00`, then Save. The query returns 10:00 local converted to UTC (`17:00+00` in Los Angeles, `01:00+00` in Tokyo), as before this plan.
4. **Interval and timetz as text.** `iv` shows `1 mon 2 days 03:04:05`; `ttz` shows `09:30:00+02`. Set `iv` to `3 days` and Save; the query returns `3 days`. Set `ttz` to `10:00+05:30` and Save; the query returns `10:00:00+05:30`. Set `iv` to `garbage` and Save: an error banner appears, the row stays dirty, and the server answers 400, not 500.
5. **Insert.** Add a row with `ts` = `2026-12-31 23:59` and `note` = `b`, then Save. The query returns `2026-12-31 23:59:00`.
6. **Text filters.** In the header filter row, `iv` "Contains" `mon` returns the first row; `ttz` "Contains" `+02` returns it too.
7. **Import round trip.** Export the table as CSV from the Data tab, `DELETE FROM public.tz_probe`, then import the file. Every column reads back as exported, `ts`, `iv` and `ttz` included.
8. **Query results and Structure** (either zone). `SELECT iv, ttz FROM public.tz_probe` shows both as text. `public.tz_probe` → Structure shows wire type `string` for `ttz` and `iv`, `isoString` for `ts` and `tstz`.
9. **Clean up.** `DROP TABLE public.tz_probe;`

---

## Verification

- **Backend**: `cd backend && poetry run python -m pytest`.
- **Frontend**: `cd frontend && npm run typecheck && npm test`, `TZ=America/Los_Angeles npm test`, `TZ=Asia/Tokyo npm test`.
- `grep -rn "_TIMETZ_TYPES" backend/app` — zero matches.
- `grep -n "getChangedData" frontend/src/data/SqlAdminWriter.ts` — one match.
- Manual: the nine cases above. Entry points: navigator → `public.tz_probe` → Data / Structure; the Query workspace for setup, checks and case 8.

---

## Documentation Impact

- **`LIBRARY_NOTES.md`** — new top entry `## ✂️🩹🔎 JsonWriter writes every Date as a UTC instant, and its dirty mode cannot be extended (0.10.0)`. In the file's prose style, say:
  - `JsonWriter` serializes a `Date` with `toISOString()`, which loses the wall clock of a zone-less value the library itself read as local time;
  - `JsonWriter.dataFor` is `private`, so an app that must also strip columns cannot reuse `'dirty'` mode and re-implements its one-line rule;
  - the app works around both in `frontend/src/data/SqlAdminWriter.ts` (the `🩹`);
  - the library fix is planned in `plans/date-time-column-field-types.md`.
- **`TODO.md`** — no change. Its `date`/`time` bullet belongs to `date-time-column-field-types`.
- **`README.md`** — no change; it does not list column types.
- **`CHANGELOG.md`** — no entry; it is written at release time. Ready-to-paste bullets are in [Addendum: Release-note material](#addendum-release-note-material).[^changelog-at-release]

---

## Potential Challenges

- **A browser zone change needs a page reload.** The library builds each date formatter once per page; without a reload the second zone's run shows the first zone's text.
- **A `timestamp` in a DST gap** (e.g. `2026-03-08 02:30` in Los Angeles) does not exist locally, so the grid shows `03:30`. It is written back only if the user edits that cell.
- **Sub-millisecond precision is still lost on an edited cell.** The editors write whole seconds, so this matches what the user typed.
- **Python 3.10's `fromisoformat`** (the local venv; the Docker image runs 3.12) accepts only a 3- or 6-digit fraction. `formatWallClock` always writes three digits.

---

## Critical Files

| File | Why |
|---|---|
| [`frontend/src/data/SqlAdminWriter.ts`](frontend/src/data/SqlAdminWriter.ts) | The writer being changed. |
| [`frontend/src/data/stores.ts`](frontend/src/data/stores.ts) | `buildStore` (:19) builds the writer; `batch: false` (:34) means every save is a single `writeRecord(record, 'update')`. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/Writer.ts` (`WriteOperation` :12, `JsonWriter.dataFor` :131) | The dirty-mode rule `SqlAdminWriter` mirrors. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/proxy/AjaxProxy.ts` (`update` :244) | Passes `'update'` and puts the id in the URL. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/ModelRecord.ts` (`getChangedData` :505) | Changed fields plus the primary key; `Date`s compare by `getTime()`. |
| [`backend/app/wire.py`](backend/app/wire.py) | `from_wire_value` (:173), `_to_utc` (:373) and `from_wire_filter_operand` (:381). |
| [`backend/app/operations/update_row.py`](backend/app/operations/update_row.py) | Assigns only the body's keys (:56). |
| [`backend/app/endpoints/rows.py`](backend/app/endpoints/rows.py) | `update_row` (:121) finds the row by the path's `row_id`. |
| [`backend/app/connections.py`](backend/app/connections.py) | `_init_connection` (:78): the json codec precedent the text codecs mirror. |
| [`plans/typescript-ui-0-10-0-upgrade.md`](plans/typescript-ui-0-10-0-upgrade.md) | The release-note addendum format copied below. |

---

## Non-Goals

- **`date` and `time` columns.** Their field types, their day shift west of UTC, and blank `time` cells need library changes; they are [`date-time-column-field-types`](plans/date-time-column-field-types.md).
- **Filtering a `timestamp` column in a browser outside UTC.** The filter row sends a UTC instant, and the backend compares its UTC wall clock with a local wall clock. That fix needs the library's filter serialization and is also in `date-time-column-field-types`.
- **Editing a primary-key value.** The row URL uses the edited key, so the update finds no row, before and after this plan.
- **A duration or zone-aware time field type.** The library has none; text is lossless.
- **Bumping `@jimka/typescript-ui` or SQLAdmin's version.** That is release work.

---

## Addendum: Release-note material

For the release-time `CHANGELOG.md` pass. Place these under the next release's headings, in the file's bold-lead-sentence style.

`### Fixed`
- **Rows of a table with a `timestamp` column can be saved again.** Saving any edit to such a row failed with "can't subtract offset-naive and offset-aware datetimes". An edited `timestamp` value is now stored as the date and time shown in the grid, in any browser time zone.
- **Saving a row no longer rewrites the cells you did not edit.** An update now sends only the changed cells, so an unedited `timestamp` or `timestamptz` value keeps its microseconds.
- **`interval` and `time with time zone` columns show and save their real values.** An interval showed as a day count (`1 mon` read as `30 days`) and any save that included one failed; a `time with time zone` cell was blank. Both are now shown and edited as Postgres text.

`### Changed`
- **`time with time zone` columns are text columns.** Their header filter compares text, and query results no longer offer them as a chart's time axis.

---

## Notes

[^dirty-rule]: `JsonWriter({ mode: 'dirty' })` is the library's own "changed fields plus primary key" writer, and `ModelRecord.getChangedData()` (`ModelRecord.ts:505`) is public. `SqlAdminWriter` cannot subclass `JsonWriter` to add its column stripping: `dataFor` is `private` and `writeRecord` serializes in the same call, so a subclass only ever sees the finished string. Wrapping a `JsonWriter` fails for the same reason. So the app keeps implementing `Writer` itself, as it does today, and calls `getChangedData()` directly. The follow-up plan makes `dataFor` `protected`, after which `SqlAdminWriter` can extend `JsonWriter` instead. `AjaxProxy.update` (`AjaxProxy.ts:248`) passes `'update'`, and `stores.ts` sets `batch: false`, so every save goes through `writeRecord(record, 'update')`. `ModelRecord` compares `Date` values by `getTime()` (`ModelRecord.ts:396`), so re-committing the same date-time does not mark a cell changed.

[^pk-in-body]: `getChangedData()` always adds the primary key, for batch updates that carry no id in the URL. SQLAdmin's update route takes the id from the path and `UpdateRowCommand` skips the key in the body (`if k == self._pk: continue`), so the extra key is harmless. A body with nothing but the key raises `ValidationError("No updatable columns supplied")`. That can only happen when the key itself was the one edit, which the _Non-Goals_ entry on primary-key edits covers.

[^wall-clock-write]: The library's `Field` converts `2026-06-28T12:04:59.500000` with `new Date(raw)`, which ECMAScript reads as local time when the string has a time but no offset. The grid formats with the host's default zone (`data/temporalText.ts`, `Intl.DateTimeFormat(undefined, …)`). So the user sees and edits the stored wall clock. Writing the edited `Date` with `toISOString()` would send the UTC time instead, and no backend rule can recover the local wall clock from it. In Los Angeles, a user who types `08:00` would send `15:00Z` and store `15:00`. Writing the local wall clock with no offset is the exact inverse of the read, so any value round-trips in any zone. The library cannot make this choice today because its `datetime` field type does not know whether a column has a zone. The follow-up plan moves `Date` serialization into the library as a local-offset form; the backend then drops that offset for a zone-less column, and this app-side formatting is deleted.

[^date-left-alone]: The library reads a bare `2026-06-28` as UTC midnight, so the grid shows the wrong day west of UTC. `toISOString()` gives back UTC midnight of the same day and the backend keeps `value[:10]`, so an edit round-trips consistently with that (wrong) display. Writing a `date` column as its local date would break that pairing: in Los Angeles an edited time on the shown `27 June 17:00` would store the 27th. The `date` read and write are fixed together in the follow-up plan, because the read fix is in the library.

[^naive-rule]: Only two writers can send an offset for a zone-less column after this plan: a hand-made import file, and an app build older than this plan. For a `Z` string both rules one could pick agree: dropping the offset gives the same wall clock as converting to UTC first. They differ only for a non-`Z` offset. Converting to UTC matches what `from_wire_filter_operand` already does for the same column type, so a written value and a filter operand on that column mean the same thing. Postgres's own cast (`'12:04+02'::timestamp` = `12:04`) instead drops the offset without converting. The follow-up plan switches both functions to that rule together, once the frontend sends local offsets. Until then both functions share one reading.

[^text-codec]: `interval` has no lossless Python type in asyncpg: `timedelta` has no months, so `'1 mon'` decodes as `30 days`. `str(timedelta)` prints `30 days, 0:00:00`, which asyncpg's `interval` encoder then refuses (`'str' object has no attribute 'days'`), so any save that included an interval failed. `timetz` decodes fine, but no library field type can show or edit an offset-carrying time of day. Postgres's documentation also advises against `timetz`. The codecs were checked against the dev database on 2026-09-28: `'1 mon 2 days 03:04:05'::interval` reads back as that text, `'09:30+02'::timetz` as `09:30:00+02`, `array['1 day'::interval]` as `['1 day']`, text binds for both types, and `'garbage'` raises `InvalidDatetimeFormatError`. That error is an `asyncpg.PostgresError`, which `main.py`'s handler already turns into a 400. This mirrors the `json`/`jsonb` codec in the same function.

[^matview-precision]: A materialized view's `dataType` comes from `format_type` and can carry a precision (`timestamp(3) without time zone`). Such a column already falls through `pg_type_to_wire` to `STRING` (the `ColumnMeta.dataType` known issue in `TODO.md`), so its value is never a `Date` and the exact match misses nothing.

[^changelog-at-release]: `release-steps.md` writes `CHANGELOG.md` at release time as a dated `## [X.Y.Z]` section, and the file has no "Unreleased" section. `plans/typescript-ui-0-10-0-upgrade.md` carries its bullets in an addendum for the same reason. The release-time pass reads `plans/implemented/*.md`, so it will find these.

---

## Implementation Notes

- **Two code commits, not one.** The `timestamp` save fix (writer diff, wall-clock write, naive binding) and the `interval`/`timetz` text codec are independent fixes that would each stand on their own branch, so they are separate code commits per the commit skill's one-functionality rule.
- **An update body on a `serial`-keyed table carries no primary key.** Manual case 1 expected `{"note": …, "id": 1}`; the app sends `{"note": "a1"}`. `getChangedData()` does add the key, but a `serial`/identity key is `isGenerated`, so `toBody` strips it with the other generated columns. This is harmless — the update route takes the row id from the URL — and the unit tests (which use a non-generated `id`) still pin the "plus the primary key" behaviour.
- **How the manual cases were driven.** DevTools' timezone override is not reachable from the browser-automation tool, so the two-zone runs used a headless Chromium launched with `TZ=America/Los_Angeles` and `TZ=Asia/Tokyo` over CDP (the Europe/Stockholm desktop browser covered a third zone). Edits went through the app's real `buildStore`/`SqlAdminWriter`/`AjaxProxy` path (imported from the Vite dev server in the page) rather than by typing into grid cells; the grid's rendered text was read before and after. Case 6 was checked against the rows endpoint's `filter=` parameter, and case 7 through the export endpoint plus the JSON import route (the CSV parser is frontend-only and untouched here). Every case matched: `ts` stored as `08:00` in all zones, `tstz` at `17:00+00` (Los Angeles) and `01:00+00` (Tokyo), `interval`/`timetz` as text, `garbage` answered 400 with the row left dirty, and an unedited `ts`/`tstz` kept `12:04:59.5` / `12:04:59.123456+00`.
