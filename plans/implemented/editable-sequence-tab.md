---
touches-shared: [backend/app/sql/ddl.py, frontend/src/SqlAdminController.ts, frontend/src/navigator/NavigatorTree.ts, frontend/src/contract.ts, frontend/src/dock/ddlSpecs.ts]
---

# Editable Sequence Info Tab — Implementation Plan

## Overview

Replace the modal "Alter sequence…" dialog with in-place editing of the sequence info tab. Today the tab is a read-only Property/Value grid ([`frontend/src/dock/SequenceInfoPanel.ts`](frontend/src/dock/SequenceInfoPanel.ts), rows from [`frontend/src/data/sequenceInfoRows.ts`](frontend/src/data/sequenceInfoRows.ts), opened by `openSequence` at [`frontend/src/SqlAdminController.ts:408`](frontend/src/SqlAdminController.ts#L408)). We make the **Value column editable**, add a **toolbar with a Save button** (plus a Cycle checkbox), and on Save diff edited-vs-original, generate `ALTER SEQUENCE` statement(s) for the changed cells, confirm the SQL in the shared preview dialog, execute once, and reload the tab.

Save reuses the existing preview/execute infrastructure: [`openSqlPreviewDialog`](frontend/src/dock/SqlPreviewDialog.ts) + `executeDdl` + `ExecuteDdlCommand`. Parameter changes emit one `ALTER SEQUENCE … <params>` statement (via the existing `SequenceAlterPreview` op); an Owner change emits a separate `ALTER SEQUENCE … OWNER TO` statement (via `SequenceOwnerPreview`). When both change, the two statements are `;`-joined into one execute — atomic through `ExecuteDdlCommand`'s transaction wrap ([`backend/app/operations/ddl.py:102`](backend/app/operations/ddl.py#L102)), the same mechanism the matview `replace_materialized_view` DROP;CREATE pair uses.

This lands on `feature/schema-sequence-ddl`. Several edited files (`ddl.py`, `SqlAdminController.ts`, `NavigatorTree.ts`, `contract.ts`, `ddlSpecs.ts`) are also touched by phase 5 (`feature/function-type-ddl`), which the parent rebases afterward — keep every edit to those files **minimal and additive** (new params/fields/functions, no reflow of neighbouring code). No routes and no operation exports change: the tab reuses the existing `/ddl/alter-sequence` and `/ddl/sequence-owner` preview routes and the `SequenceAlterPreview`/`SequenceOwnerPreview` ops (extended in place), so `backend/app/main.py`, `backend/app/operations/__init__.py`, and `frontend/src/data/api.ts` are **not** touched.

---

## Architecture Decisions

### Save = confirm generated SQL, reusing the preview dialog
The editable tab is effectively "the form"; Save opens `openSqlPreviewDialog`. That helper requires a `form: Component` shown above the SQL editor — we satisfy it with a **minimal read-only summary Panel** built from the diff (one line per changed property, e.g. `Increment: 10 → 25`). `generateSql` awaits the phase preview call(s) and returns their `;`-joined SQL; `execute` runs the (possibly edited) text via `executeDdl` (one call). The previewed text is authoritative at execute (the existing editable-preview trust model), so the summary is display-only.

### All rows editable, including Data type; Owner is a separate statement
Postgres's `ALTER SEQUENCE` parameter form and its `OWNER TO` form are distinct grammars that cannot combine in one statement. So a Save that changes both parameters and owner emits **two** statements: the parameter form (`SequenceAlterPreview` → `sequence_alter`) and `OWNER TO` (`SequenceOwnerPreview` → `sequence_set_owner`). `sequence_alter` gains `START WITH` (Start value) and `AS <type>` (Data type) support.

### bigint stays a STRING end-to-end (the subtlest constraint)
`SequenceDetail` serializes `startValue/minValue/maxValue/increment/cacheSize/lastValue` as **strings** (a default max of `9223372036854775807` exceeds `Number.MAX_SAFE_INTEGER`). The new tab-save path keeps them strings the whole way: cells are read as strings, the diff compares strings, and the spec carries **JSON strings** — never `Number()`/`parseInt`. On the backend, the existing `_int_opt` already does `int(value)`, which accepts an integer-valued string (`int("9223372036854775807")` → arbitrary-precision Python int) and rejects non-integers. **Coexistence with the CreateSequence dialog** (which still sends JS numbers): widen the shared `AlterSequenceSpec` numeric fields to `string | number`; the backend `_int_opt` already coerces both. `CreateSequenceSpec` and its dialog are left number-typed and unchanged. This is cleaner than a second string-only spec shape — one wire type, backend coerces, no duplication.

Do **not** reuse the old dialog's `parseOptionalInt` (returns a JS number) on this path. It stays only in `CreateSequenceForm`.

### Cycle is edited by a toolbar Checkbox, not an inline cell
The library's `Table` editor type is **column-level** (`ColumnConfig.values`/`renderer` apply to a whole column; there is no per-row editor type — confirmed in `ColumnConfig.d.ts`). The Value column holds numeric strings, so it can't also host a per-row boolean editor. Per the "not free text" requirement, Cycle is edited by a **`Checkbox` labelled "Cycle" in the toolbar**, seeded from `detail.cycle`. The Cycle *row* stays in the grid for completeness but its Value cell is **read-only** (`cellReadOnly` returns `true` for that row). The diff reads Cycle from the checkbox. (Library papercut worth a `LIBRARY_NOTES.md` entry — no per-cell editor type in a shared column — but out of scope to fix here.)

### Data type: builder-side allowlist
Postgres permits only `smallint`/`integer`/`bigint` for a sequence. Validate against a fixed allowlist in `sequence_alter` (mirroring `_REFERENTIAL_ACTIONS`/`_INDEX_METHODS`), raising `ValidationError` (clean 422) rather than passing raw text to a Postgres error. Allowlist (case-insensitive): `smallint, integer, bigint, int2, int4, int8`.

### Canonical clause order for the parameter form
Reorder `sequence_alter` to Postgres's canonical order: `AS <type>`, `INCREMENT BY`, `MINVALUE`, `MAXVALUE`, `START WITH`, `RESTART[/WITH]`, `CACHE`, `CYCLE`/`NO CYCLE`. The current builder emits `RESTART` first; moving it after `START WITH` and inserting `AS`/`START WITH` does not change any existing single-option or `MINVALUE/MAXVALUE/CACHE`-combo test output — only newly combined cases differ, so existing tests stay green (add one combined-order test).

### Diff → statement mapping (only CHANGED cells vs the original `SequenceDetail`)
- **Current value** → `RESTART WITH <n>` (`restart`). Original null shows `—`; leaving `—` unchanged emits nothing; a number restarts.
- **Start value** → `START WITH <n>` (new `start`).
- **Increment** → `INCREMENT BY`; **Min value** → `MINVALUE`; **Max value** → `MAXVALUE`; **Cache size** → `CACHE`.
- **Cycle** → `CYCLE`/`NO CYCLE` (checkbox boolean; included only when it differs from `detail.cycle`).
- **Data type** → `AS <type>` (new `dataType`).
- **Owner** → separate `SequenceOwnerSpec` → `OWNER TO <role>`.

If nothing changed, Save is disabled; a Save that diffs to no specs is a no-op with a status message. This structurally prevents the empty-`ALTER SEQUENCE` 422 (the parameter statement is only requested when ≥1 parameter changed).

### Remove the Alter dialog
Delete `openAlterSequenceDialog` + `AlterSequenceForm` (and its `MODE_*`/`CYCLE_*` constants and `readCycleTriState` helper) from `SequenceDdlForms.ts`; remove `controller.alterSequence`; remove the "Alter sequence…" navigator item. Keep "Show info" (now the editable tab) and "Drop sequence…". CREATE/DROP dialogs and `parseOptionalInt` are unchanged. `buildAlterSequenceSpec`/`buildSequenceOwnerSpec` are **reused** by the new diff (extend `buildAlterSequenceSpec`).

---

## Public API

### Backend — `backend/app/sql/ddl.py`
```python
# New module-level allowlist (mirrors _REFERENTIAL_ACTIONS / _INDEX_METHODS).
_SEQUENCE_TYPES: frozenset[str] = frozenset(
    {"smallint", "integer", "bigint", "int2", "int4", "int8"}
)

def sequence_alter(
    schema: str,
    name: str,
    *,
    data_type: str | None = None,       # NEW — emits `AS <type>`, allowlist-checked
    restart: int | _RestartDefaultType | None = None,
    increment: int | None = None,
    start: int | None = None,           # NEW — emits `START WITH <n>`
    min_value: int | None = None,
    max_value: int | None = None,
    cache: int | None = None,
    cycle: bool | None = None,
) -> str: ...
# Order: AS, INCREMENT BY, MINVALUE, MAXVALUE, START WITH, RESTART, CACHE, CYCLE.
# Raises ValidationError on blank name, on data_type not in _SEQUENCE_TYPES
# (case-insensitive), and on all-options-omitted (unchanged).
```

### Backend — `backend/app/operations/ddl_schema_sequence.py`
`SequenceAlterPreview.__init__` additionally reads `self._start = _int_opt(spec, "start")` and `self._data_type = spec.get("dataType") or None`; `build()` passes `start=self._start, data_type=self._data_type` to `ddl.sequence_alter`. Spec doc updated to `{schema, name, dataType?, restart?, restartDefault?, increment?, start?, minValue?, maxValue?, cache?, cycle?}`.

### Frontend — `frontend/src/contract.ts`
```ts
export interface AlterSequenceSpec {
    schema: string;
    name: string;
    dataType?: string;                              // NEW
    restart?: string | number;                      // widened
    restartDefault?: boolean;
    increment?: string | number;                    // widened
    start?: string | number;                        // NEW
    minValue?: string | number;                     // widened
    maxValue?: string | number;                     // widened
    cache?: string | number;                        // widened
    cycle?: boolean;
}
```
`CreateSequenceSpec` unchanged (still number-typed).

### Frontend — `frontend/src/dock/ddlSpecs.ts`
```ts
export interface AlterSequenceParamFields {
    dataType?: string;                              // NEW
    restart?: string | number;                      // widened
    restartDefault?: boolean;
    increment?: string | number;                    // widened
    start?: string | number;                        // NEW
    minValue?: string | number;
    maxValue?: string | number;
    cache?: string | number;
    cycle?: boolean;
}
export function buildAlterSequenceSpec(schema: string, name: string, fields: AlterSequenceParamFields): AlterSequenceSpec;
// Adds `...(fields.dataType !== undefined ? { dataType } : {})` and
// `...(fields.start !== undefined ? { start } : {})`; existing fields unchanged.

// NEW — DOM-free diff (the bigint-as-string + only-changed logic lives here).
export interface EditedSequenceValues {
    lastValue: string;   // Current value cell ("—" when unset)
    startValue: string;
    increment: string;
    minValue: string;
    maxValue: string;
    cacheSize: string;
    cycle: boolean;
    dataType: string;
    owner: string;
}
export interface SequenceEditSpecs { alter?: AlterSequenceSpec; owner?: SequenceOwnerSpec; }
export function diffSequenceSpecs(
    schema: string, name: string, original: SequenceDetail, edited: EditedSequenceValues,
): SequenceEditSpecs;
// Throws Error (surfaced via the dialog) if a CHANGED numeric cell is not an
// integer string. Never Number()s the values.
```

### Frontend — `frontend/src/dock/SequenceInfoPanel.ts`
```ts
export interface SequenceInfoPanelDeps {
    schema: string;
    name: string;
    previewAlter:  (spec: AlterSequenceSpec) => Promise<DdlPreview>;
    previewOwner:  (spec: SequenceOwnerSpec) => Promise<DdlPreview>;
    execute:       (sql: string) => Promise<QueryStatusResult>;
    reloadDetail:  () => Promise<SequenceDetail>;   // re-fetch after a successful Save
    onError:       (message: string) => void;
    onStatus:      (message: string) => void;
}
export class SequenceInfoPanel extends Container {          // was: extends Panel
    constructor(detail: SequenceDetail, deps: SequenceInfoPanelDeps);
}
```

### Frontend — `frontend/src/SqlAdminController.ts`
`openSequence` constructs `new SequenceInfoPanel(detail, deps)` wiring `deps` from `ref` + `previewAlterSequence`/`previewSequenceOwner`/`executeDdl`/`getSequenceDetail`/`notifyError`/`statusBar`. `alterSequence` is **removed**.

---

## Internal Structure

### `diffSequenceSpecs` (pure) — the load-bearing logic
```
requireIntString(text, label): trim; if not /^[+-]?\d+$/ throw Error(`'${label}' must be a whole number`); return trimmed  // stays a string
alterFields = {}
if edited.dataType.trim() !== original.dataType         -> alterFields.dataType  = edited.dataType.trim()
if edited.increment.trim() !== original.increment       -> alterFields.increment = requireIntString(edited.increment, "Increment")
if edited.startValue.trim() !== original.startValue     -> alterFields.start     = requireIntString(edited.startValue, "Start value")
if edited.minValue.trim() !== original.minValue         -> alterFields.minValue  = requireIntString(edited.minValue, "Min value")
if edited.maxValue.trim() !== original.maxValue         -> alterFields.maxValue  = requireIntString(edited.maxValue, "Max value")
if edited.cacheSize.trim() !== original.cacheSize       -> alterFields.cache     = requireIntString(edited.cacheSize, "Cache size")
if edited.cycle !== original.cycle                      -> alterFields.cycle     = edited.cycle
// Current value: original display is (original.lastValue ?? "—")
if edited.lastValue.trim() !== (original.lastValue ?? "—")
   and edited.lastValue.trim() !== "" and edited.lastValue.trim() !== "—"
                                                        -> alterFields.restart   = requireIntString(edited.lastValue, "Current value")
alter = (alterFields has any key) ? buildAlterSequenceSpec(schema, name, alterFields) : undefined
owner = (edited.owner.trim() !== original.owner) ? buildSequenceOwnerSpec(schema, name, edited.owner.trim()) : undefined
return { alter, owner }
```
Note: `cycle` is compared with `!==` (boolean), so `false` is preserved. `alterFields` keys are added only when changed, so `buildAlterSequenceSpec`'s existing `!== undefined` guards carry through.

### `SequenceInfoPanel` (DOM) — mirror `TableWorkPanel`
- `extends Container`, `Border` layout: `ToolBar` NORTH, `Table` CENTER (wrapped in a `Fit` Panel).
- Model: `{property:string, value:string}`; `MemoryStore(sequenceInfoRows(detail))`.
- Table `columns`: `{ field:"property", readOnly:true }`, `{ field:"value", cellReadOnly: r => r.get("property") === "Cycle" }`. (Value cells editable except the Cycle row.)
- Toolbar: `Checkbox({ label:"Cycle", selected: detail.cycle })` + `glyphButton("save", PRIMARY_COLOR, "Save", …)` (`Glyph.register(save)`; `import { save } from "@jimka/typescript-ui/glyphs/solid/save"`).
- Baseline `_detail` field (mutable) holds the current original for diffing.
- Save-enabled = `store.hasPendingChanges() || cycleBox.getValue() !== _detail.cycle`; recomputed on `store.on("datachange", …)` and `cycleBox.on("change", …)`.
- `readEdited()`: map store rows (property→value) into `EditedSequenceValues`, overriding `cycle` from the checkbox.
- Save handler: `specs = diffSequenceSpecs(...)` (may throw → notify via `onError`); if `!specs.alter && !specs.owner` → `onStatus("No changes")` and return; else `openSqlPreviewDialog({ title:"Alter sequence", form: summaryPanel(specs, _detail, edited), generateSql, execute: deps.execute, onSuccess, onError: deps.onError })`.
  - `generateSql`: push `(await previewAlter(specs.alter)).sql` and/or `(await previewOwner(specs.owner)).sql`; return `parts.join(";\n")`.
  - `onSuccess`: `const d = await deps.reloadDetail(); _detail = d; store.loadData(sequenceInfoRows(d)); cycleBox.setValue(d.cycle); syncSaveEnabled(); onStatus(\`${name}: altered\`)`.
- No `dispose` needed (MemoryStore has no transport; listeners GC with the panel — matches the current panel's documented no-dispose rationale).

---

## Ordered Implementation Steps

1. **`backend/app/sql/ddl.py`** — add `_SEQUENCE_TYPES` frozenset near `_INDEX_METHODS`. Extend `sequence_alter` with `data_type` and `start` kwargs; reorder clause emission to `AS, INCREMENT BY, MINVALUE, MAXVALUE, START WITH, RESTART, CACHE, CYCLE`; when `data_type is not None`, validate `data_type.lower() in _SEQUENCE_TYPES` (else `ValidationError`) and append `f"AS {data_type}"` first; append `f"START WITH {int(start)}"` when `start is not None`. Keep the all-omitted `ValidationError`. Update the docstring (Args + returned order).
2. **`backend/tests/test_ddl_schema_sequence_sql.py`** — add tests: `AS bigint` first, `START WITH`, combined canonical order (`data_type` + `increment` + `start` + `restart`), unsupported type raises, alias `int8` accepted. Confirm existing `sequence_alter` tests still pass unchanged.
3. **`backend/app/operations/ddl_schema_sequence.py`** — in `SequenceAlterPreview.__init__` read `self._start = _int_opt(spec, "start")` and `self._data_type = spec.get("dataType") or None`; pass both in `build()`. Update the class docstring's spec.
4. **`backend/tests/test_ddl_schema_sequence_ops.py`** — add `SequenceAlterPreview` tests: `start` as an integer string (`"1000"` → `START WITH 1000`), a 19-digit bigint string round-trips, `dataType:"bigint"` → `AS bigint`, `dataType:"nope"` raises.
5. **`frontend/src/contract.ts`** — widen `AlterSequenceSpec` numeric fields to `string | number`; add `dataType?: string` and `start?: string | number`. Leave `CreateSequenceSpec` untouched.
6. **`frontend/src/dock/ddlSpecs.ts`** — extend `AlterSequenceParamFields` (`dataType`, `start`, widened numerics); extend `buildAlterSequenceSpec` with the two new spread clauses. Add `EditedSequenceValues`, `SequenceEditSpecs`, a private `requireIntString`, and `diffSequenceSpecs` (import `SequenceDetail` from `../contract`). Keep `parseOptionalInt`.
7. **`frontend/tests/dock/ddlSpecs.test.ts`** — add `diffSequenceSpecs` cases (see Expected Behaviour) and `buildAlterSequenceSpec` cases for `dataType`/`start`.
8. **`frontend/src/dock/SequenceInfoPanel.ts`** — rewrite per Internal Structure: `SequenceInfoPanelDeps`, `SequenceInfoPanel extends Container` with toolbar (Cycle checkbox + Save) over the editable Table, dirty tracking, Save/diff/preview/execute/reload flow, `summaryPanel` helper. Imports: `Container` (core), `Border`/`Fit` (layout), `Placement` (primitive), `ToolBar` (component/menubar), `Checkbox` (component/input), `Table`/`MemoryStore`/`Model` (as today), `glyphButton`, `openSqlPreviewDialog`, `diffSequenceSpecs`, `sequenceInfoRows`, `Glyph` + `save` glyph, `PRIMARY_COLOR`.
9. **`frontend/src/SqlAdminController.ts`** — in `openSequence`, build `deps` and pass to `new SequenceInfoPanel(detail, deps)` (`reloadDetail: () => getSequenceDetail(ref)`, `onStatus: m => this.statusBar.setMessage(\`${this._connectionId} · ${m}\`)`, `onError: m => this.notifyError(new Error(m), ref)`). Delete the `alterSequence` method. Drop the `openAlterSequenceDialog` import; keep `previewAlterSequence`/`previewSequenceOwner` imports (now used by `openSequence`).
10. **`frontend/src/navigator/NavigatorTree.ts`** — remove the `{ text: "Alter sequence…", … }` menu item from the `ref.kind === "sequence"` branch. Keep "Show info" and "Drop sequence…".
11. **`frontend/src/dock/SequenceDdlForms.ts`** — delete `AlterSequenceDialogDeps`, `AlterSequenceForm`, `openAlterSequenceDialog`, `MODE_PARAMETERS`/`MODE_OWNER`/`CYCLE_*` constants, and `readCycleTriState`. Drop now-unused imports (`Card`, `ComboBox`, `buildAlterSequenceSpec`/`buildSequenceOwnerSpec` if no longer referenced here — confirm `parseOptionalInt`, `buildCreateSequenceSpec`, `buildDropSequenceSpec` remain). Create/Drop launchers unchanged.
12. **Regression checks** — `grep -rn "alterSequence\|openAlterSequenceDialog\|AlterSequenceForm" frontend/src` → expect zero matches. `grep -rn "Alter sequence…" frontend/src` → zero. Run typecheck + both test suites.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `backend/app/sql/ddl.py` (shared) |
| Modify | `backend/app/operations/ddl_schema_sequence.py` |
| Modify | `backend/tests/test_ddl_schema_sequence_sql.py` |
| Modify | `backend/tests/test_ddl_schema_sequence_ops.py` |
| Modify | `frontend/src/contract.ts` (shared) |
| Modify | `frontend/src/dock/ddlSpecs.ts` (shared) |
| Modify | `frontend/tests/dock/ddlSpecs.test.ts` |
| Modify | `frontend/src/dock/SequenceInfoPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (shared) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (shared) |
| Modify | `frontend/src/dock/SequenceDdlForms.ts` |

No files created or deleted. Not touched (confirmed): `backend/app/main.py`, `backend/app/operations/__init__.py`, `frontend/src/data/api.ts`, `frontend/src/properties/PropertiesPanel.ts`.

---

## Expected Behaviour

### Backend — unit-testable (`test_ddl_schema_sequence_sql.py`)
- `sequence_alter("public","s", data_type="bigint")` → `ALTER SEQUENCE "public"."s" AS bigint`.
- `sequence_alter("public","s", start=1000)` → `… START WITH 1000`.
- `sequence_alter("public","s", data_type="integer", increment=2, start=5, restart=9)` → `… AS integer INCREMENT BY 2 START WITH 5 RESTART WITH 9` (canonical order).
- `sequence_alter("public","s", data_type="nope")` → raises `ValidationError`.
- `sequence_alter("public","s", data_type="int8")` → `… AS int8` (alias accepted).
- Existing tests (restart-default, restart-with, increment, cycle true/false, `MINVALUE/MAXVALUE/CACHE` combo, no-options-raises, blank-name-raises) unchanged and green.

### Backend — unit-testable (`test_ddl_schema_sequence_ops.py`)
- `SequenceAlterPreview({schema,name,start:"1000"}).build()` → `… START WITH 1000` (string coerced).
- `SequenceAlterPreview({schema,name,maxValue:"9223372036854775807"}).build()` → `… MAXVALUE 9223372036854775807` (bigint string round-trips).
- `SequenceAlterPreview({schema,name,dataType:"bigint"}).build()` → `… AS bigint`.
- `SequenceAlterPreview({schema,name,dataType:"nope"}).build()` → raises `ValidationError`.

### Frontend `diffSequenceSpecs` — unit-testable (`ddlSpecs.test.ts`)
Given an `original` `SequenceDetail` (`startValue:"1"`, `increment:"1"`, `minValue:"1"`, `maxValue:"100"`, `cacheSize:"1"`, `cycle:false`, `dataType:"integer"`, `owner:"alice"`, `lastValue:null`):
- No edits → `{}` (both undefined).
- Only `increment` `"1"→"5"` → `{ alter: { schema, name, increment:"5" } }` (string, not `5`).
- `maxValue` `"100"→"9223372036854775807"` → `alter.maxValue === "9223372036854775807"` (string preserved, never `Number()`d).
- `cycle` `false→true` → `{ alter: { …, cycle:true } }`; `true→false` produces `cycle:false` (not dropped).
- `owner` `"alice"→"bob"` only → `{ owner: { schema, name, owner:"bob" } }`, `alter` undefined.
- `increment` and `owner` both change → both `alter` and `owner` set.
- `dataType` `"integer"→"bigint"` → `alter.dataType === "bigint"`.
- Current value: original `lastValue:null` (display `—`); edited `"—"` → nothing; edited `"42"` → `alter.restart === "42"`.
- Changed `increment` to `"1.5"` (or `"x"`) → throws `Error` mentioning `Increment`.
- Editing a value then reverting to the original string → that field absent (equality on strings).

### Frontend — manual-verify (DOM/UI)
- "Show info" opens the tab; Property column and the Cycle Value cell are read-only; other Value cells edit inline; a "Cycle" checkbox and a Save button sit in the toolbar.
- Save is disabled with no edits; enabling on any Value edit or Cycle toggle; disabling again after a reverting edit is acceptable-but-not-required (diff is the authority).
- Editing Increment + toggling Cycle + changing Owner, then Save → preview dialog shows `ALTER SEQUENCE … INCREMENT BY … CYCLE;\nALTER SEQUENCE … OWNER TO …`; Execute runs once, both apply atomically, the tab reloads with new values, status shows "altered".
- Editing Data type to `bigint` → `AS bigint` in the preview and applied.
- Data type to an unsupported value → clean error notification (422 from the builder), dialog stays open for a retry.
- The navigator sequence menu shows only "Show info" and "Drop sequence…".

---

## Verification

- `cd backend && poetry run python -m pytest tests/test_ddl_schema_sequence_sql.py tests/test_ddl_schema_sequence_ops.py` (worktree: `python -m pytest`, per the worktree-pytest memory).
- `cd frontend && npm run typecheck && npm test` (covers `ddlSpecs.test.ts`; `sequenceInfoRows.test.ts` still green).
- `grep -rn "alterSequence\|openAlterSequenceDialog\|AlterSequenceForm\|Alter sequence…" frontend/src` → zero matches.
- Manual smoke: log in (Host `sqladmin-db`), open a sequence's info tab, exercise the cases above. Frontend consumes the built `dist/lib`; no library edit here, so no `build:lib` needed.

---

## Potential Challenges

- **Multi-statement execute** — asyncpg's `execute` (simple protocol) runs `;`-joined statements; `ExecuteDdlCommand` wraps them in a transaction, so the two ALTERs are atomic (matches the matview DROP;CREATE precedent). No backend change needed; just `;\n`-join in `generateSql`.
- **Dirty vs. diff mismatch** — `store.hasPendingChanges()` may stay true after a revert-to-original edit; the Save handler re-runs `diffSequenceSpecs` and treats an empty result as a no-op, so no empty `ALTER SEQUENCE` is ever requested.
- **Shared-file rebase** — keep `ddl.py`/`contract.ts`/`ddlSpecs.ts`/`SqlAdminController.ts`/`NavigatorTree.ts` edits additive so phase 5's rebase stays clean.

---

## Critical Files

- [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) — the toolbar-over-editable-grid idiom to mirror (ToolBar NORTH, dirty tracking via `store.on("datachange", …)` + `hasPendingChanges()`, `glyphButton`).
- [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts) — the `openSqlPreviewDialog({ form, generateSql, execute, onSuccess, onError })` contract Save reuses.
- [`frontend/src/dock/ddlSpecs.ts`](frontend/src/dock/ddlSpecs.ts) — `buildAlterSequenceSpec`/`buildSequenceOwnerSpec` to reuse/extend; the DOM-free home for `diffSequenceSpecs`.
- `ColumnConfig.d.ts` (`…/@jimka/typescript-ui/dist/lib/types/component/table/`) — confirms `cellReadOnly` (per-cell) exists but editor type is column-level (drives the Cycle-checkbox decision).
- [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py) (`sequence_alter`, `_INDEX_METHODS` allowlist style, `RESTART_DEFAULT`) and [`backend/app/operations/ddl_schema_sequence.py`](backend/app/operations/ddl_schema_sequence.py) (`SequenceAlterPreview`, `_int_opt`).

---

## Non-Goals

- No CREATE/DROP sequence dialog changes; `parseOptionalInt` stays for the Create form.
- No new preview routes or op classes; the existing alter/owner ops are extended in place.
- No `RESTART` (reset-to-start) affordance — Current value edits map to `RESTART WITH n` only.
- No fix for the library's column-level-editor limitation (a `LIBRARY_NOTES.md` candidate, deferred).
- No `SequenceDetail`/`sequence_detail.py` read changes — the introspection already returns the needed string-typed fields.
