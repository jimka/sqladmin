---
depends-on: [table-ddl, editable-sequence-tab]
touches-shared:
  - backend/app/contract.py
  - backend/app/operations/list_columns.py
  - frontend/src/contract.ts
  - frontend/src/dock/ddlSpecs.ts
  - frontend/src/SqlAdminController.ts
---

# Editable Table Structure — Implementation Plan

## Overview

Make a table's **columns** editable in place, on the Structure tab's Columns
grid, and retire the three modal dialogs that edit them today. A user renames a
column, changes its type, toggles NOT NULL, sets or clears a default, adds a
row, or removes a row — all inline — then presses Save. Save diffs the grid
against the columns the tab loaded, generates the matching `ALTER TABLE`
statements, and shows them in the same editable SQL preview every other DDL
action in this app uses before executing.

The grid is [`frontend/src/dock/columnsGrid.ts:103`](frontend/src/dock/columnsGrid.ts#L103)'s
`linkedColumnsTable`, hosted by the Columns section of
[`frontend/src/dock/StructurePanel.ts:211`](frontend/src/dock/StructurePanel.ts#L211).
The Save flow mirrors [`frontend/src/dock/SequenceInfoPanel.ts:303`](frontend/src/dock/SequenceInfoPanel.ts#L303)'s
`handleSave`: diff → summary panel → `openSqlPreviewDialog` → one Execute. The
diff itself is a pure function in [`frontend/src/dock/ddlSpecs.ts`](frontend/src/dock/ddlSpecs.ts),
beside the `diffSequenceSpecs` it copies.

Two supporting changes come with it. The `/columns` payload gains the column's
**declared type with its modifier** and its **default expression** — an
editable Type or Default cell has to show the value it will be diffed against,
and today's payload carries neither. And the Columns grid gains a **filler
column**: a blank trailing column that absorbs leftover width, so Name and Type
render at the width their content needs instead of being stretched to share
whatever width the grid has left over.

Indexes, Constraints and Foreign Keys are untouched: they stay read-only grids
with their existing add/drop tools.

---

## Architecture Decisions

### Structure edits become inline cell edits — reversing table-ddl's "Read-only cells stay read-only"

The Columns grid's cells become editable and the Add/Alter/Drop-column dialogs
go away. [`plans/implemented/table-ddl.md:50`](plans/implemented/table-ddl.md)
decided the opposite, for two reasons; one was never load-bearing and the other
has since been superseded.[^reversal]

The precedent this follows is [`frontend/src/dock/SequenceInfoPanel.ts:303`](frontend/src/dock/SequenceInfoPanel.ts#L303):
an object's own tab holds the edits, Save diffs the widgets against the
originally-loaded detail, and the resulting statements are `;`-joined into one
`openSqlPreviewDialog`. This plan applies that same shape to a grid instead of
a field form.

### The Columns grid itself becomes editable — no separate edit mode

Editability is a property of the existing Columns section, not a mode the user
switches into. The section's header tools become **Add column / Drop column /
Save / Refresh**, replacing today's Add / Alter / Drop / Refresh.[^no-edit-mode]

Refresh is also the revert: it re-fetches the columns and reseeds the grid,
discarding pending edits — so no separate Revert tool is added.

### Only a table's Structure tab is editable

A view or materialized view can also open a Structure tab (`RELATION_VIEW_KINDS.structure`
lists all three relation kinds, [`frontend/src/shell/routeTargets.ts:70`](frontend/src/shell/routeTargets.ts#L70)).
The controller passes the column-editing dependencies only when
`ref.kind === "table"`; without them the Columns grid keeps `rowReadOnly: () => true`
and its header carries only Refresh. The Indexes/Constraints/Foreign Keys tools
are unaffected for every relation kind, so a materialized view keeps its
Create-index tool.[^view-gate]

### A generated column's Type, Nullable and Default cells are locked; its Name is not

Editability is gated per cell, following
[`frontend/src/dock/tableWriteRules.ts:60`](frontend/src/dock/tableWriteRules.ts#L60)'s
`readOnly: !canUpdate || c.isGenerated` — the data grid already treats a
generated column as not-editable, and `table-data-import`'s row coercion drops
generated columns for the same reason.

| Column kind | Column (name) | Type | Nullable | Default | PK / Generated / Wire type / Sequence | Removable |
|---|---|---|---|---|---|---|
| ordinary | editable | editable | editable | editable | read-only | yes |
| `isGenerated` | editable | read-only | read-only | read-only | read-only | yes |

`isGenerated` covers identity columns, `GENERATED ALWAYS AS (…) STORED`
columns, and `serial` columns.[^generated-gate]

### The primary-key toggle is not part of this change

The PK column stays read-only. Adding or removing a primary key is
`ADD CONSTRAINT … PRIMARY KEY` / `DROP CONSTRAINT`, which the Constraints
section's existing Add and Drop tools already own — putting a second,
divergent affordance on the Columns grid would give one operation two
launchers.[^pk]

### The diff produces a batch of statements, joined into one Execute

`diffColumnSpecs` returns an ordered `AlterTableSpec[]`. `generateSql` previews
each through the existing `previewAlterTable` client and `;\n`-joins the
results; `execute` runs the whole text once through `executeDdl`.
[`backend/app/operations/ddl.py:102`](backend/app/operations/ddl.py#L102) runs
it inside a transaction, so the batch applies atomically. No backend route, op,
or spec shape changes.[^batch]

### Statement order: drops, then alters, then renames, then adds

Statements run sequentially inside one transaction, so order decides what each
one can name. The rule: **drops first, then per-column alters keyed on the
column's original name, then renames, then adds.** Every clause before a rename
uses the name the database still has, and every added column is created after
the names it might reuse have been freed.

A user renames `note` to `memo`, retypes it, marks it NOT NULL, removes
`legacy`, and adds `issued_at`:

```sql
ALTER TABLE "sales"."invoices" DROP COLUMN "legacy";
ALTER TABLE "sales"."invoices" ALTER COLUMN "note" TYPE varchar(200);
ALTER TABLE "sales"."invoices" ALTER COLUMN "note" SET NOT NULL;
ALTER TABLE "sales"."invoices" RENAME COLUMN "note" TO "memo";
ALTER TABLE "sales"."invoices" ADD COLUMN "issued_at" timestamptz DEFAULT now()
```

### `/columns` gains the declared type and the default expression

`ColumnMeta.dataType` comes from `information_schema.columns.data_type`, which
is the SQL-standard type *name* with no modifier — a `varchar(200)` column
reports `character varying`. `ColumnMeta` carries `hasDefault` (a boolean) but
never the default expression. Neither is a truthful baseline for an editable
cell, so `ColumnMeta` gains two fields, `fullType` (from `format_type`) and
`defaultExpr`.[^payload]

`dataType` and `hasDefault` stay exactly as they are: `dataType` is what
`pg_type_to_wire` matches on and what the diagram card model reads
([`frontend/src/data/schemaCardModel.ts:88`](frontend/src/data/schemaCardModel.ts#L88)),
and `hasDefault` backs `isRequiredColumn`.

Both Columns grids — the Structure tab's and `DefinitionPanel`'s — switch their
Type column from `dataType` to `fullType`, so the two keep showing the same
thing.

### A blank filler column absorbs leftover width

The library has no flex/fill column knob. A column is a leftover-width absorber
exactly when its field type is not `boolean`/`number`/`date`, it does not
declare `preserveWidth`, and it declares **no `maxWidth`**; whatever leftover
width exists is split equally between all such columns
(`absorbSlackIntoGreedy`, `../typescript-ui/packages/lib/src/typescript/lib/layout/Table.ts:535`).
So a dedicated filler is built by making every other flexible column declare a
`maxWidth`, and adding one blank column that does not.[^filler]

| Grid column | Field type | Declares | Absorbs leftover width? |
|---|---|---|---|
| `name` | `string` | `maxWidth: CONTENT_WIDTH_CAP` | no — renders at its sampled content width |
| `fullType` | `string` | `maxWidth: CONTENT_WIDTH_CAP` | no — same |
| `defaultExpr` | `string` | `maxWidth: CONTENT_WIDTH_CAP` | no — same |
| `wireType` | `string` | `maxWidth: CONTENT_WIDTH_CAP` | no — same |
| `nullable`, `isPrimaryKey`, `isGenerated` | `boolean` | — | no — fixed by field type |
| `sequence` | `string` + `renderer` | `width: SEQUENCE_COLUMN_WIDTH`, `maxWidth: CONTENT_WIDTH_CAP` | no — declared width |
| `filler` | `string` | `minWidth: 0`, no `maxWidth` | **yes — the only one** |

`autoSizeColumns: true` stays on the grid, so Name and Type keep being sized
from their sampled content, per
[`plans/implemented/content-derived-column-sizing.md`](plans/implemented/content-derived-column-sizing.md).
`CONTENT_WIDTH_CAP` is 400 — the same number the library already clamps an
uncapped column to — so declaring `maxWidth` changes no column's content width;
the declaration only takes that column out of the leftover split.[^cap-restated]

The `sequence` column carries a `LinkCellRenderer`, and the library never
samples a column with a renderer, so it has no content width to cap. It gets a
declared `width` instead, the way
[`frontend/src/properties/PropertyValuePanel.ts:66`](frontend/src/properties/PropertyValuePanel.ts#L66)
declares one for its Property column.

---

## Public API

### Backend — `backend/app/contract.py`

```python
@dataclass(frozen=True)
class ColumnMeta:
    name: str
    data_type: str
    nullable: bool
    is_primary_key: bool
    is_generated: bool
    has_default: bool
    wire_type: WireType
    full_type: str = ""              # NEW — format_type(): the declared type WITH its modifier
    default_expr: str | None = None  # NEW — information_schema.columns.column_default
    sequence: SequenceRef | None = None
```

`to_contract()` gains `"fullType": self.full_type` and
`"defaultExpr": self.default_expr`. Both new fields are defaulted so the three
construction sites outside `list_columns.py`
(`operations/graph.py:184`, `operations/run_query.py:84`,
`tests/conftest.py:33`) compile unchanged.

### Frontend — `frontend/src/contract.ts`

```ts
export interface ColumnMeta {
    name: string;
    dataType: string;
    /** The declared type including any modifier, e.g. "character varying(60)". */
    fullType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    isGenerated: boolean;
    hasDefault: boolean;
    /** The column's DEFAULT expression, or null when it has none. */
    defaultExpr: string | null;
    wireType: WireType;
    sequence?: SequenceRef | null;
}
```

### Frontend — `frontend/src/dock/columnSequence.ts`

```ts
export interface ColumnRow {
    /** The column's name when the grid was seeded — the diff's identity anchor. */
    originalName: string;
    name: string;
    fullType: string;      // replaces `dataType`
    nullable: boolean;
    /** "" when the column has no default. */
    defaultExpr: string;
    isPrimaryKey: boolean;
    isGenerated: boolean;
    wireType: string;
    sequence: string;
    sequenceSchema: string;
    sequenceName: string;
}

export function toColumnRows(columns: ColumnMeta[]): ColumnRow[];
```

`filler` is a Model field with no `ColumnRow` counterpart — its cells bind
`undefined` and render blank.

### Frontend — `frontend/src/dock/columnsGrid.ts`

```ts
export function buildColumnsGrid(
    columns: ColumnMeta[],
    onOpenSequence?: OpenSequenceHandler,
    editable?: boolean,          // NEW — default false; honoured only with onOpenSequence
): ColumnsGrid;
```

### Frontend — `frontend/src/dock/ddlSpecs.ts`

```ts
/** One Columns-grid row, as the Save diff reads it. */
export interface EditedColumnRow {
    /** The row's column name when the grid was seeded; "" for a row added since. */
    originalName: string;
    name: string;
    type: string;
    nullable: boolean;
    /** "" means "no default". */
    default: string;
}

/**
 * Diff the edited Columns grid against the columns the tab loaded, returning
 * the ALTER TABLE specs in execution order (drops, alters, renames, adds).
 * Throws when a kept row's name or type is blank, or an added row has a name
 * but no type.
 */
export function diffColumnSpecs(
    schema: string,
    table: string,
    original: ColumnMeta[],
    edited: EditedColumnRow[],
): AlterTableSpec[];

/** One human summary line per spec, for the preview dialog's form panel. */
export function describeColumnSpecs(specs: AlterTableSpec[]): string[];
```

### Frontend — `frontend/src/dock/StructurePanel.ts`

```ts
/** Constraint and index launchers — the column launchers are gone. */
export interface StructureActions {
    onAddConstraint(kind: ConstraintKind): void;
    onDropConstraint(constraintName: string): void;
    onCreateIndex(): void;
    onDropIndex(indexName: string): void;
    /** Column editing; omitted (views/matviews) leaves the Columns grid read-only. */
    columnEdits?: ColumnEditActions;
}

/** What the Columns section's Save flow needs from the controller. */
export interface ColumnEditActions {
    schema: string;
    table: string;
    previewAlter(spec: AlterTableSpec): Promise<DdlPreview>;
    execute(sql: string): Promise<QueryStatusResult>;
    /** Re-fetch the structure, reseed every section, and close the stale data tab. */
    onSaved(): void;
    onError(message: string): void;
    onStatus(message: string): void;
}
```

The constructor's parameter list is unchanged (`columnEdits` rides inside
`actions`). `reloadColumns(columns)` additionally resets the Save baseline and
re-syncs the Save button.

---

## Internal Structure

### `diffColumnSpecs` — the load-bearing logic

```
byOriginal = Map(original, c => c.name -> c)
kept  = edited.filter(r => r.originalName !== "")
added = edited.filter(r => r.originalName === "" && r.name.trim() !== "")   // blank new rows dropped
keptNames = Set(kept.map(r => r.originalName))
specs = []

// 1. drops — original order
for (c of original) if (!keptNames.has(c.name)) specs.push(dropColumn { column: c.name })

// 2. alters — grid order, always naming base.name (the pre-rename name)
for (r of kept) {
    base = byOriginal.get(r.originalName); if (!base) continue
    if (r.name.trim() === "") throw `Column "${r.originalName}" cannot be renamed to an empty name`
    if (r.type.trim() === "") throw `Column "${r.originalName}" needs a type`
    if (r.type.trim() !== base.fullType) specs.push(changeType { column: base.name, newType: r.type.trim() })
    if (r.nullable !== base.nullable)    specs.push(r.nullable ? dropNotNull : setNotNull { column: base.name })
    d = r.default.trim(); was = (base.defaultExpr ?? "").trim()
    if (d !== was) specs.push(d === "" ? dropDefault { column: base.name }
                                       : setDefault  { column: base.name, default: d })
}

// 3. renames — grid order
for (r of kept) { base = byOriginal.get(r.originalName)
                  if (base && r.name.trim() !== base.name) specs.push(renameColumn { column: base.name, newName: r.name.trim() }) }

// 4. adds — grid order
for (r of added) {
    if (r.type.trim() === "") throw `New column "${r.name.trim()}" needs a type`
    specs.push(addColumn { columnDef: { name: r.name.trim(), type: r.type.trim(), nullable: r.nullable,
                                        default: r.default.trim() === "" ? null : r.default.trim(),
                                        primaryKey: false } })
}
return specs
```

Every `specs.push` goes through the existing
[`buildAlterTableSpec(schema, table, action, fields)`](frontend/src/dock/ddlSpecs.ts#L95)
— `diffColumnSpecs` assembles no spec object by hand.

Per-cell mapping, for the tests:

| Cell edited | Before | After | Clause |
|---|---|---|---|
| Column | `note` | `memo` | `RENAME COLUMN "note" TO "memo"` |
| Type | `text` | `varchar(200)` | `ALTER COLUMN "note" TYPE varchar(200)` |
| Nullable | checked | cleared | `ALTER COLUMN "note" SET NOT NULL` |
| Nullable | cleared | checked | `ALTER COLUMN "note" DROP NOT NULL` |
| Default | (blank) | `now()` | `ALTER COLUMN "note" SET DEFAULT now()` |
| Default | `now()` | (blank) | `ALTER COLUMN "note" DROP DEFAULT` |
| row removed | — | — | `DROP COLUMN "note"` |
| row added | — | `memo` / `text` | `ADD COLUMN "memo" text` |

### The Columns grid's spec

In `linkedColumnsTable(store, onOpenSequence, editable)`:

```ts
const generatedRow = (r: ModelRecord): boolean => r.get("isGenerated") === true;

const spec: ColumnSpec = {
    columns: [
        { field: "name",         maxWidth: CONTENT_WIDTH_CAP },
        { field: "fullType",     maxWidth: CONTENT_WIDTH_CAP, cellReadOnly: generatedRow },
        { field: "nullable",                                  cellReadOnly: generatedRow },
        { field: "defaultExpr",  maxWidth: CONTENT_WIDTH_CAP, cellReadOnly: generatedRow },
        { field: "isPrimaryKey", readOnly: true },
        { field: "isGenerated",  readOnly: true },
        { field: "wireType",     readOnly: true, maxWidth: CONTENT_WIDTH_CAP },
        { field: "sequence",     renderer: () => new LinkCellRenderer(),
                                 width: SEQUENCE_COLUMN_WIDTH, maxWidth: CONTENT_WIDTH_CAP },
        { field: "filler",       headerText: "", minWidth: 0, unhideable: true, readOnly: true },
    ],
    autoSizeColumns: true,
    appendUnlisted:  false,
    ...(editable ? {} : { rowReadOnly: () => true }),
};
```

`readOnly`, `rowReadOnly` and `cellReadOnly` are OR-ed by the library, so the
read-only path locks every cell regardless of the per-column entries.
`originalName`, `sequenceSchema` and `sequenceName` are Model fields that no
`columns` entry lists, so `appendUnlisted: false` keeps them hidden.

### The Save flow (`StructurePanel`)

```ts
private saveColumns(): void {
    const edits = this._columnEdits;

    if (!edits) { return; }                       // defensive: the tool only exists with edits

    let specs: AlterTableSpec[];

    try {
        specs = diffColumnSpecs(edits.schema, edits.table, this._columns,
                                readEditedColumnRows(this._columnsSection.store));
    } catch (err) {
        edits.onError(err instanceof Error ? err.message : String(err));

        return;
    }

    if (specs.length === 0) { edits.onStatus("No changes"); return; }

    openSqlPreviewDialog({
        title:       "Alter columns",
        form:        summaryPanel(describeColumnSpecs(specs)),
        generateSql: async () =>
            (await Promise.all(specs.map(s => edits.previewAlter(s)))).map(p => p.sql).join(";\n"),
        execute:     edits.execute,
        onSuccess:   () => edits.onSaved(),
        onError:     edits.onError,
    });
}
```

`readEditedColumnRows(store)` maps `store.getAll()` — the master list, in load
order, unaffected by a header sort — to `EditedColumnRow[]`, renaming the two
grid fields whose names differ from the diff's:

```ts
function readEditedColumnRows(store: MemoryStore): EditedColumnRow[] {
    return store.getAll().map((r: ModelRecord) => ({
        originalName: String(r.get("originalName") ?? ""),
        name:         String(r.get("name") ?? ""),
        type:         String(r.get("fullType") ?? ""),
        nullable:     r.get("nullable") === true,
        default:      String(r.get("defaultExpr") ?? ""),
    }));
}
```

`summaryPanel(lines)` builds a `VBox` of `Text` lines, exactly as
[`SequenceInfoPanel.ts:372`](frontend/src/dock/SequenceInfoPanel.ts#L372) does.

`specs` is captured when Save is pressed, so "Regenerate SQL" re-previews the
same diff; a grid edit made while the dialog is open is not picked up until the
next Save. This matches `SequenceInfoPanel`, which captures its specs the same
way.

### The Columns section's tools, and Save's enabled state

The Save button is built in the constructor after `super()` (so `this` is
available) and before the `AccordionPanel` (which is where `buildColumnsTools`
runs), kept as a field, and handed to the tool builder:

```ts
const columnsSaveButton = actions?.columnEdits
    ? glyphButton("save", PRIMARY_COLOR, "Save column changes", () => this.saveColumns())
    : undefined;

// buildColumnsTools(grid, onRefresh, saveButton?) returns
//   [Add column, Drop column, Save, Refresh]  when saveButton is given,
//   [Refresh]                                  otherwise.
```

```ts
private syncColumnsSave = (): void => {
    this._columnsSaveButton?.setEnabled(this._columnsSection.store.hasPendingChanges());
};
```

`syncColumnsSave` is registered by reference on the Columns store's
`"datachange"` event, so it is an arrow-function field per
[`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) (c).
`hasPendingChanges()` covers inline edits, added rows and removed rows.
`reloadColumns` calls it after reseeding.

---

## Ordered Implementation Steps

### Part A — the payload

1. **`backend/app/operations/list_columns.py`** — in `_SQL`, add
   `c.column_default AS default_expr` to the select list, add a `LEFT JOIN`
   subquery `att` selecting
   `a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS full_type`
   from `pg_attribute`/`pg_class`/`pg_namespace` filtered on `$1`/`$2` with
   `a.attnum > 0 AND NOT a.attisdropped`, joined `ON att.column_name = c.column_name`,
   and select `COALESCE(att.full_type, c.data_type) AS full_type`. In
   `_MATVIEW_SQL`, add `format_type(a.atttypid, a.atttypmod) AS full_type` and
   `NULL::text AS default_expr`. In `get_columns_result()`, pass
   `full_type=r["full_type"]` and `default_expr=r["default_expr"]`.

2. **`backend/app/contract.py`** — add `full_type: str = ""` and
   `default_expr: str | None = None` to `ColumnMeta`, after `wire_type` and
   before `sequence`; add `"fullType"` and `"defaultExpr"` to `to_contract()`
   and to its docstring's field list.

3. **`backend/tests/test_list_columns.py`** — add `full_type` and
   `default_expr` to the fixture `_raw` rows (e.g. `"integer"` /
   `"nextval('t_id_seq'::regclass)"` for the identity column, `"numeric(12,2)"`
   / `None` for the other) and assert both appear in `get_result()`'s dicts as
   `fullType` / `defaultExpr`.

4. **Checkpoint.** `cd backend && poetry run python -m pytest` — green.

5. **`frontend/src/contract.ts`** — add `fullType: string` and
   `defaultExpr: string | null` to `ColumnMeta`, with the doc comments from
   [Public API](#frontend--frontendsrccontractts).

### Part B — the pure logic

6. **`frontend/src/dock/columnSequence.ts`** — replace `ColumnRow.dataType`
   with `fullType`, add `defaultExpr: string` and `originalName: string`, and
   map them in `toColumnRows` (`fullType: column.fullType`,
   `defaultExpr: column.defaultExpr ?? ""`, `originalName: column.name`).
   Update the module header to say the row also carries the diff's identity
   anchor.

7. **`frontend/tests/dock/columnSequence.test.ts`** — update the `column()`
   helper for the two new `ColumnMeta` fields; change the "preserves every
   existing display field" case from `dataType` to `fullType`; add a case
   asserting `originalName` equals the column's name and `defaultExpr` is `""`
   for a column with a `null` default.

8. **`frontend/src/dock/ddlSpecs.ts`** — add `EditedColumnRow`,
   `diffColumnSpecs` and `describeColumnSpecs` per
   [Internal Structure](#diffcolumnspecs--the-load-bearing-logic). Import
   `ColumnMeta` from `../contract`. Keep every spec assembled through
   `buildAlterTableSpec`. Also drop `ColumnForm` and `AlterColumnForm` from the
   module header's list of the forms these helpers serve (line 5) — both are
   deleted in step 17.

9. **`frontend/tests/dock/ddlSpecs.test.ts`** — add `describe` blocks for both
   new functions, one case per row of
   [Expected Behaviour › diffColumnSpecs](#diffcolumnspecs--unit-testable).

10. **Checkpoint.** `cd frontend && npm run typecheck && npm test` — green.

### Part C — the grid

11. **`frontend/src/dock/columnsGrid.ts`** — rename `DISPLAY_FIELDS`' second
    entry from `dataType` to `fullType` (description stays `"Type"`); rename
    `SEQUENCE_FIELDS` to `STRUCTURE_FIELDS` and extend it with `defaultExpr`
    (description `"Default"`), `originalName` and `filler` (description `""`),
    keeping `order` values unique and ascending across both lists. Add the
    `CONTENT_WIDTH_CAP = 400` and `SEQUENCE_COLUMN_WIDTH = 220` module
    constants with the comments from
    [Architecture Decisions](#a-blank-filler-column-absorbs-leftover-width).
    Add the `editable` parameter to `buildColumnsGrid` and thread it into
    `linkedColumnsTable`, whose spec becomes the one in
    [Internal Structure](#the-columns-grids-spec). Import `ModelRecord` as a
    type from `@jimka/typescript-ui/data`. Leave `readOnlyTable` untouched.

12. **Checkpoint.** `cd frontend && npm run typecheck` — clean. Then
    `grep -n 'maxWidth: CONTENT_WIDTH_CAP' src/dock/columnsGrid.ts` — expect
    **five** matches (`name`, `fullType`, `defaultExpr`, `wireType`,
    `sequence`) and none on the `filler` entry.

### Part D — the panel

13. **`frontend/src/dock/StructurePanel.ts`** —
    - Replace `StructureActions`' three column callbacks with the optional
      `columnEdits?: ColumnEditActions`, and export `ColumnEditActions` per
      [Public API](#frontend--frontendsrcdockstructurepanelts).
    - Pass `actions?.columnEdits !== undefined` as `buildColumnsGrid`'s third
      argument at [`:185`](frontend/src/dock/StructurePanel.ts#L185).
    - Change `buildColumnsTools`'s signature to
      `buildColumnsTools(grid: Table, onRefresh: () => void, saveButton?: Button): Button[]`.
      With a `saveButton` it returns **Add column** (`plus`,
      `CONSTRUCTIVE_COLOR`, calling
      `grid.addRow({ originalName: "", name: "", fullType: "", nullable: true, defaultExpr: "", isPrimaryKey: false, isGenerated: false, wireType: "" })`),
      **Drop column** (`trash`, `DESTRUCTIVE_COLOR`, calling
      `grid.removeSelectedRow()`, gated by the existing `gateOnSelection`),
      that `saveButton`, then Refresh — in that order. Without one it returns
      `[refreshButton]`, as today. Delete `findColumn` and `selectedColumn`,
      now unused.
    - Add the private fields `_columnEdits` (assigned `actions?.columnEdits`
      after `super()`) and `_columnsSaveButton`, the `syncColumnsSave` arrow
      field, `saveColumns()`, and the module functions
      `readEditedColumnRows(store)` and `summaryPanel(lines)`.
    - Build the Save button after `super()` and before the `AccordionPanel`
      (per [Internal Structure](#the-columns-sections-tools-and-saves-enabled-state)),
      assign it to `_columnsSaveButton`, and pass it to `buildColumnsTools`.
    - At the end of the constructor, wire
      `columnsSection.store.on("datachange", this.syncColumnsSave)` and call
      `this.syncColumnsSave()` once for the initial disabled state.
    - In `reloadColumns`, call `this._columnsSection.store.reject()` before
      `reseed(...)` — `loadData` replaces the records but leaves pending
      removals queued
      ([`TableWorkPanel.ts:197`](frontend/src/dock/TableWorkPanel.ts#L197)) —
      then call `this.syncColumnsSave()`.
    - Imports: drop `pencil` and `buildAlterColumnItems`; add `save` from
      `@jimka/typescript-ui/glyphs/solid/save`, `Text` from
      `@jimka/typescript-ui/component/input`, `VBox` is already imported,
      `openSqlPreviewDialog` from `./SqlPreviewDialog`, `diffColumnSpecs` /
      `describeColumnSpecs` from `./ddlSpecs`, and the
      `AlterTableSpec` / `DdlPreview` / `QueryStatusResult` types from
      `../contract`. Update the `Glyph.register(...)` call accordingly.
    - Update the module header comment: the Columns grid is now inline-editable
      for a table, and the read-only-cells decision it cites is reversed by
      this plan.

14. **`frontend/src/dock/menuItems.ts`** — delete `ALTER_COLUMN_ACTIONS` and
    `buildAlterColumnItems`, and the now-unused `AlterColumnAction` /
    `ColumnMeta` type imports. Update the module header's list of what it
    builds.

15. **`frontend/tests/dock/menuItems.test.ts`** — delete the
    `buildAlterColumnItems` describe block, its import, and the `column`
    fixture; drop the three removed callbacks from `structureActions()`.

### Part E — the controller

16. **`frontend/src/SqlAdminController.ts`** —
    - In `openStructure`, add an `onColumnsSaved` closure that calls
      `this.dock.removePanel(this.panelId(ref))` (the data tab's Model is now
      stale) and then the existing whole-tab `refresh()` closure.
    - Change `structureActionsFor(ref)` to drop `onAddColumn`/`onAlterColumn`/
      `onDropColumn` and add `columnEdits`, built only when
      `ref.kind === "table"`:
      `{ schema: ref.schema!, table: ref.name!, previewAlter: spec => previewAlterTable(ref, spec), execute: sql => executeDdl(this._connectionId, sql), onSaved, onError: m => this.notifyError(new Error(m), ref), onStatus: m => this.statusBar.setMessage(`${this._statusScope} · ${m}`) }`.
      `structureActionsFor` therefore takes `onColumnsSaved` as a second
      parameter, supplied from `openStructure`.
    - Delete the `addColumn`, `alterColumn` and `dropColumn` methods
      ([`:1060`](frontend/src/SqlAdminController.ts#L1060)–[`:1119`](frontend/src/SqlAdminController.ts#L1119))
      and the `ColumnForm` / `AlterColumnForm` imports.

17. **`frontend/src/dock/ColumnForm.ts`, `frontend/src/dock/AlterColumnForm.ts`** — delete.

18. **Regression checkpoints.**
    - `grep -rn 'AlterColumnForm\|ColumnForm\|buildAlterColumnItems\|onAlterColumn\|onAddColumn\|onDropColumn' frontend/src frontend/tests`
      — expect zero matches (`CreateTableForm` will not match this pattern).
    - `grep -rn '\.dataType' frontend/src` — expect matches only in
      `data/schemaCardModel.ts`, `dock/sequenceFormState.ts`,
      `dock/SequenceInfoPanel.ts` and `dock/ddlSpecs.ts`'s sequence helpers;
      none in `dock/columnSequence.ts` or `dock/columnsGrid.ts`.
    - `cd frontend && npm run typecheck && npm test && npm run build`.
    - `cd backend && poetry run python -m pytest`.

### Part F — documentation and the live sweep

19. **`README.md`** — extend the "Structure & definitions" highlight bullet:
    a table's columns are editable in place on the Structure tab, and Save
    generates the `ALTER TABLE` statements for review before they run.

20. **Walk every row of [Expected Behaviour › manual-verify](#manual-verify).**
    Bring the stack up per README's Development section (`docker compose up -d db`,
    the backend under uvicorn, `npm run dev`) and log in against the demo
    database.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/operations/list_columns.py` (`full_type`, `default_expr`) |
| Modify | `backend/app/contract.py` (`ColumnMeta` fields + `to_contract`) |
| Modify | `backend/tests/test_list_columns.py` (fixture rows + assertions) |
| Modify | `frontend/src/contract.ts` (`ColumnMeta.fullType`, `.defaultExpr`) |
| Modify | `frontend/src/dock/columnSequence.ts` (`ColumnRow` fields, `toColumnRows`) |
| Modify | `frontend/tests/dock/columnSequence.test.ts` |
| Modify | `frontend/src/dock/columnsGrid.ts` (editable spec, filler, widths) |
| Modify | `frontend/src/dock/ddlSpecs.ts` (`diffColumnSpecs`, `describeColumnSpecs`) |
| Modify | `frontend/tests/dock/ddlSpecs.test.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` (editable Columns section + Save) |
| Modify | `frontend/src/dock/menuItems.ts` (drop the alter-column submenu) |
| Modify | `frontend/tests/dock/menuItems.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (wire `columnEdits`, drop three launchers) |
| Modify | `README.md` (Structure highlight) |
| Delete | `frontend/src/dock/ColumnForm.ts` |
| Delete | `frontend/src/dock/AlterColumnForm.ts` |

No new files. `backend/app/main.py`, `backend/app/operations/ddl_table.py`,
`backend/app/sql/ddl.py`, `frontend/src/data/api.ts` and
`frontend/src/dock/SqlPreviewDialog.ts` are **not** touched.

---

## Expected Behaviour

### `diffColumnSpecs` — unit-testable

Baseline for every case: `original = [note, legacy]`, where `note` is
`{ name: "note", fullType: "text", nullable: true, defaultExpr: null, isGenerated: false, … }`
and `legacy` is `{ name: "legacy", fullType: "integer", nullable: true, defaultExpr: null, … }`.

| Case | Result |
|---|---|
| no edits | `[]` |
| `note`'s name → `memo` | one spec: `{ action: "renameColumn", column: "note", newName: "memo" }` |
| `note`'s type → `varchar(200)` | one spec: `{ action: "changeType", column: "note", newType: "varchar(200)" }` |
| `note`'s nullable cleared | one spec: `{ action: "setNotNull", column: "note" }` |
| a NOT NULL column's nullable checked | one spec: `{ action: "dropNotNull", column: … }` |
| `note`'s default → `now()` | one spec: `{ action: "setDefault", column: "note", default: "now()" }` |
| a defaulted column's default cleared | one spec: `{ action: "dropDefault", column: … }` |
| `legacy`'s row removed | one spec: `{ action: "dropColumn", column: "legacy" }` |
| a new row `memo` / `text` added | one spec: `{ action: "addColumn", columnDef: { name: "memo", type: "text", nullable: true, default: null, primaryKey: false } }` |
| a new row with a blank name | `[]` — an in-progress row, dropped silently |
| a new row with a name and a blank type | throws, message names `memo` |
| `note`'s name cleared | throws, message names `note` |
| `note`'s type cleared | throws, message names `note` |
| `note` renamed **and** retyped | two specs, `changeType` (naming `"note"`) **before** `renameColumn` |
| the worked example (rename + retype + NOT NULL + drop + add) | five specs in exactly the order shown in [Architecture Decisions](#statement-order-drops-then-alters-then-renames-then-adds) |
| a cell edited then reverted to its original text | that field produces no spec (string equality) |
| a row's type edited to `"  text  "` when it was `text` | no spec — the edited text is trimmed before comparing |

### `describeColumnSpecs` — unit-testable

One line per spec, in spec order; each of the nine `AlterTableSpec` actions
produces a line, e.g. `renameColumn` → `Rename: "note" → "memo"`,
`dropColumn` → `Drop column: "legacy"`, `addColumn` → `Add column: "memo" text`.
An empty array in gives an empty array out.

### `toColumnRows` — unit-testable

- `fullType` carries `ColumnMeta.fullType`, not `dataType`.
- `defaultExpr` is `""` when `ColumnMeta.defaultExpr` is `null`, and the
  expression text otherwise.
- `originalName` equals the column's `name` for every row.
- The three sequence fields keep their existing behaviour.

### Backend `ListColumnsQuery.get_result()` — unit-testable

- A `_raw` row with `full_type = "numeric(12,2)"` and
  `default_expr = "now()"` yields `{"fullType": "numeric(12,2)", "defaultExpr": "now()", …}`.
- `default_expr = None` yields `"defaultExpr": None`.
- `dataType`, `hasDefault` and `wireType` are unchanged by this plan's fields.

### Manual-verify

Column widths, cell editing, dialogs and focus are rendered behaviour the
node-environment test runner cannot exercise.

| # | Action | Correct looks like |
|---|---|---|
| 1 | Table → Structure → Columns | Column, Type, Nullable, **Default**, PK, Generated, Wire type, Sequence, then a blank unlabelled column. Type shows `character varying(60)` on a `varchar(60)` column, not `character varying`. |
| 2 | Same grid, wide window | Name and Type sit at their content width; the blank trailing column takes all the leftover space. No column is stretched to a share it does not need. |
| 3 | Double-click a Name cell | An editor opens. Same for Type and Default; Nullable toggles its checkbox on click. |
| 4 | Double-click PK, Generated, Wire type, Sequence or the blank column | Nothing happens — every one is read-only. |
| 5 | On a `serial`/identity column, double-click Type, Nullable or Default | Nothing happens; its Name cell still edits. |
| 6 | Open the tab, touch nothing | Save is disabled. Add column and Refresh are enabled; Drop column is disabled until a row is selected. |
| 7 | Edit any editable cell | Save enables. |
| 8 | Press Add column | A blank row appears, selected and scrolled into view; Save enables. |
| 9 | Select a row, press Drop column | The row disappears; Save enables. |
| 10 | Press Refresh after editing | The grid reseeds from the database, edits are gone, Save disables. |
| 11 | Rename + retype + NOT NULL + drop one column + add one, then Save | The preview dialog lists one summary line per change and holds the five statements from the worked example, `;`-separated, in that order. |
| 12 | Execute that batch | Every change applies; the Structure tab reseeds in place; the table's Data tab (if open) closes; the status line reports the alter. |
| 13 | Make an edit, Save, then Cancel in the dialog | Nothing runs; the grid still holds the edits and Save is still enabled. |
| 14 | Save with a type Postgres cannot cast to | Execute fails, the dialog stays open with the SQL intact, and the error is reported — `SqlPreviewDialog`'s existing show/retry loop. Adding `USING …` by hand in the editor and re-executing succeeds. |
| 15 | Clear a Name cell and press Save | An error names the column; no dialog opens. |
| 16 | Press Save with no changes pending after a revert-by-hand | Status reads "No changes"; no dialog opens. |
| 17 | Open a **view**'s Structure tab (`/schema/<s>/view/<v>/structure`) | Every Columns cell is read-only; the Columns header carries only Refresh — a deliberate change, since its Add/Alter/Drop-column tools generated `ALTER TABLE` against a view. Indexes/Constraints/Foreign Keys keep their tools. |
| 18 | Materialized view → Structure → Indexes | Create index and Drop index are still present and still work. |
| 19 | Click a Sequence link on a `serial` column | The sequence tab opens, as before. |
| 20 | A view's Definition tab → Columns | Type shows the declared type with its modifier; the grid is otherwise unchanged (no Default column, no blank filler). |

---

## Verification

| # | Where | Command / action | Expect |
|---|---|---|---|
| 1 | `backend` | `poetry run python -m pytest` | green |
| 2 | `frontend` | `npm run typecheck` | clean |
| 3 | `frontend` | `npm test` | green — including the new `diffColumnSpecs` / `describeColumnSpecs` blocks |
| 4 | `frontend` | `npm run build` | succeeds |
| 5 | `frontend` | `grep -rn 'AlterColumnForm\|ColumnForm\|buildAlterColumnItems\|onAlterColumn\|onAddColumn\|onDropColumn' src tests` | zero matches |
| 6 | `frontend` | `grep -n 'maxWidth: CONTENT_WIDTH_CAP' src/dock/columnsGrid.ts` | 5 matches, none on the `filler` entry |
| 7 | `frontend` | `grep -n 'filler' src/dock/columnsGrid.ts` | 2 matches — the Model field and the column config |
| 8 | `frontend` | `grep -n 'fullType' src/contract.ts src/dock/columnSequence.ts src/dock/columnsGrid.ts` | present in all three |
| 9 | `backend` | `grep -n 'full_type\|default_expr' app/operations/list_columns.py app/contract.py` | present in both queries, the result mapping, the dataclass and `to_contract` |
| 10 | browser | every row of [Expected Behaviour › manual-verify](#manual-verify) | walked, including rows 17–20, which cover what must keep working outside a table's Structure tab |

Rows 1–9 prove the wiring. Row 10 is the substantive check: cell editability
and column widths are rendered behaviour nothing automated in this repo can
see.

---

## Documentation Impact

The repo publishes no API reference. The one user-facing doc change is step 19's
`README.md` highlight. `CHANGELOG.md` belongs to the release step the user runs
by hand, not to this plan.

`plans/implemented/table-ddl.md` records the decision this plan reverses. It is
a historical record of what was built then and is **not** edited; the reversal
lives in this plan's `## Architecture Decisions`.

---

## Potential Challenges

- **A rename that collides with an existing column** fails at Execute with a
  Postgres error. Mitigation: the dialog's retry loop leaves the SQL intact so
  the user can fix the name and re-execute; no client-side collision check is
  added.
- **A type change needing a `USING` cast** has no field in the grid, unlike
  today's `AlterColumnForm`. Mitigation: the previewed SQL is editable — the
  user appends `USING …` to the `ALTER COLUMN … TYPE` line before executing.
- **`DROP COLUMN` never emits `CASCADE`**, unlike today's `ConfirmCascadeForm`
  flow. Mitigation: a column another object depends on fails at Execute; the
  user appends `CASCADE` in the preview editor.
- **Column widths are derived once per store**, so a `loadData` reseed keeps
  the widths the first load produced (`LIBRARY_NOTES.md`, "A paged remote
  store's `autoSizeColumns` widths derive from page one only"). Mitigation:
  none needed — the Columns store always loads every row at once, so the first
  derivation already saw the whole set; a Refresh that widens a value leaves a
  column the user can drag.
- **A partly-applied batch is impossible but a wholly-failed one is not.**
  `ExecuteDdlCommand` wraps the joined statements in a transaction, so a
  failure rolls the whole batch back and the grid still holds the edits.
- **`store.remove` queues the record for a sync that never happens** on a
  `MemoryStore`. Mitigation: `reloadColumns` calls `store.reject()` before
  `loadData`, the same ordering `TableWorkPanel`'s Refresh uses, so a queued
  removal cannot survive into the next diff.

---

## Critical Files

- [`plans/implemented/table-ddl.md`](plans/implemented/table-ddl.md) — the
  "Read-only cells stay read-only" and "One statement per operation" decisions
  this plan reverses, and the `AlterTableSpec` / preview-op contract it keeps.
- [`plans/implemented/editable-sequence-tab.md`](plans/implemented/editable-sequence-tab.md)
  — the precedent: an object's tab becomes editable, Save diffs against the
  loaded detail, and several statements are `;`-joined into one Execute.
- [`frontend/src/dock/SequenceInfoPanel.ts`](frontend/src/dock/SequenceInfoPanel.ts)
  — the implemented Save flow (`handleSave`, `summaryPanel`, `reload`) this
  plan mirrors, and the deps-object shape `ColumnEditActions` copies.
- [`frontend/src/dock/ddlSpecs.ts`](frontend/src/dock/ddlSpecs.ts) —
  `buildAlterTableSpec` (every spec goes through it) and `diffSequenceSpecs`
  (the diff-and-throw shape `diffColumnSpecs` follows).
- [`frontend/src/dock/StructurePanel.ts`](frontend/src/dock/StructurePanel.ts)
  — the accordion, the section tools, `reloadColumns`, and the header comment
  stating the decision being reversed.
- [`frontend/src/dock/columnsGrid.ts`](frontend/src/dock/columnsGrid.ts) and
  [`frontend/src/dock/columnSequence.ts`](frontend/src/dock/columnSequence.ts)
  — the grid and its pure row mapping, shared with `DefinitionPanel`.
- [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts)
  — this app's existing inline-editable grid: dirty tracking off
  `store.on("datachange")` + `hasPendingChanges()`, and the reject-before-load
  Refresh ordering.
- [`frontend/src/dock/tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts)
  — `buildColumnSpec`'s `readOnly: !canUpdate || c.isGenerated`, the
  generated-column gate this plan extends to the structure grid.
- [`plans/implemented/content-derived-column-sizing.md`](plans/implemented/content-derived-column-sizing.md)
  — the `autoSizeColumns` adoption, the renderer-column behaviour, and the
  declared-width precedent; its Implementation Notes record the
  leftover-width split this plan's filler column redirects.
- [`frontend/src/properties/PropertyValuePanel.ts`](frontend/src/properties/PropertyValuePanel.ts)
  — the app's one declared column width, the precedent `SEQUENCE_COLUMN_WIDTH`
  follows.
- [`backend/app/operations/list_columns.py`](backend/app/operations/list_columns.py)
  and [`backend/app/contract.py`](backend/app/contract.py) — the two queries
  and the dataclass the new fields join.
- [`backend/app/operations/ddl.py`](backend/app/operations/ddl.py) —
  `ExecuteDdlCommand.apply`'s transaction wrap, which makes the batch atomic.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) —
  the class-first rules the panel edits follow, in particular (b) the
  super-cascade order and (c) arrow-function fields for listeners registered by
  reference.
- `../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnConfig.ts`
  — `ColumnSpec` and `ColumnConfig`'s full field list (`readOnly`,
  `cellReadOnly`, `width`, `maxWidth`, `minWidth`, `headerText`, `unhideable`,
  `renderer`).
- `../typescript-ui/packages/lib/src/typescript/lib/layout/Table.ts` —
  `absorbSlackIntoGreedy` and `isFixedColumn`, which decide what the filler
  column has to look like.
- `../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts` —
  `addRow`, `removeSelectedRow`, `samplesRecordText`, `clampColumnWidth`, and
  the rotated view's own filler column (the library's reference
  implementation of the same trick).

---

## Non-Goals

- **No editing of indexes, constraints or foreign keys.** Those three sections
  stay read-only grids with their existing add/drop dialogs.
- **No primary-key toggle on the Columns grid** — the Constraints section owns
  adding and dropping a primary key.
- **No `USING` field and no `CASCADE` checkbox** in the grid. Both are one
  clause the user types into the editable preview, which is where the app's
  trust model already puts raw SQL fragments.
- **No client-side validation of types, defaults or name collisions.** A bad
  fragment fails at Execute and surfaces through the dialog's retry loop, per
  `table-ddl`'s trust model. The only checks `diffColumnSpecs` makes are for
  blank names and blank types, which have no honest statement to generate.
- **No column reordering.** PostgreSQL has no `ALTER TABLE … SET ORDER`, so
  dragging rows would have nothing to generate.
- **No new backend route, preview op, or SQL builder.** The batch is assembled
  client-side from calls to the existing `POST …/ddl/table/alter`.
- **No change to `readOnlyTable`** — so none at all to the Indexes and
  Constraints grids, and none to the view-Definition Columns grid beyond its
  Type column's new source.
- **No change to `ColumnMeta.dataType` or `hasDefault`**, and no switch of
  `pg_type_to_wire`'s input to `format_type` — the matview inconsistency
  `content-derived-column-sizing` filed in `TODO.md` stays filed.
- **No re-derivation of column widths after a reseed**; the library exposes no
  call for it and the Columns store is never paged.

---

## Notes

[^reversal]: `table-ddl.md` gave two reasons, and this plan answers both.
    *Reason one* — "The library `Table` exposes only `selection` and
    `cellclick` events — no per-row context-menu event. So structure edits are
    **not** inline cell edits." The premise is still true today
    (`TableEvent = "selection" | "cellclick"`,
    `component/table/Table.ts:52`; a `"cellcontextmenu"` event exists on
    `Body` but carries only viewport coordinates, no record or field), but it
    never supported the conclusion: a context menu is a way to *launch a
    dialog*, not a prerequisite for editing a cell. A cell enters edit mode on
    double-click (`component/table/cell/Cell.ts:170`) or Enter/Space
    (`component/table/Body.ts:2491`), and editability is gated by
    `ColumnConfig.readOnly`, `ColumnConfig.cellReadOnly` and
    `ColumnSpec.rowReadOnly`, OR-ed in `Body.applyReadOnlyState`
    (`Body.ts:2183`). This app has shipped an inline-editable grid on exactly
    that seam since `TableWorkPanel` was written. *Reason two* — "Phase-1's
    execute path runs exactly one statement… So an 'edit column' gesture maps
    to **one** ALTER action, not a diff producing several." That was the real
    constraint, and `editable-sequence-tab` lifted it: `ExecuteDdlCommand`
    passes the text to asyncpg's no-argument `execute`, which accepts
    `;`-separated statements, inside a transaction, and `SequenceInfoPanel`
    has been joining two previews into one Execute ever since. With the
    one-statement rule gone, a diff producing several statements is the
    natural shape, and the per-action dialogs are the awkward one.

[^no-edit-mode]: A separate "Edit structure" view was rejected. It would
    duplicate the Columns grid, need its own load and refresh paths, and force
    the user to switch modes to do the thing the tab is already showing them.
    `SequenceInfoPanel` sets the precedent in the other direction: the info tab
    *is* the form. The cost of not having a mode is that a misclick can start
    an edit on a read-only-looking grid; Save being disabled until something
    actually changes, and Refresh discarding everything, keep that cheap.

[^view-gate]: This tightens today's behaviour: a view's Structure tab currently
    carries Add/Alter/Drop-column launchers that would generate `ALTER TABLE`
    against a view. Gating on `ref.kind` removes those without touching the
    Indexes/Constraints/Foreign Keys tools, which is why `columnEdits` is a
    member of `StructureActions` rather than the whole object being withheld.

[^generated-gate]: The three cases behave differently in Postgres but all
    argue for the same gate. `SET DEFAULT` on an identity column is an error;
    dropping the `nextval` default on a `serial` column silently stops it being
    a serial; and a `GENERATED ALWAYS AS (…) STORED` column's nullability and
    type are constrained by its expression. Renaming and dropping are
    unambiguously safe for all three, so those stay available — which also
    keeps a generated column droppable now that the Drop-column dialog is gone.

[^pk]: `ALTER TABLE … ADD COLUMN` does accept an inline `PRIMARY KEY`, so a PK
    checkbox on a *new* row would generate something valid — but the same
    checkbox on an existing row would have to generate an `ADD CONSTRAINT` or a
    `DROP CONSTRAINT`, and dropping needs the constraint's name, which the
    Columns payload does not carry. A checkbox that means "inline clause" on
    one row and "separate constraint statement" on another is worse than no
    checkbox. The Constraints section already covers both directions for every
    row.

[^batch]: Extending the backend to take a batch spec was rejected. It would
    need a new route, a new op, a new client function and a new wire shape, all
    to re-implement the `action` dispatch `PreviewAlterTable.build()` already
    has (`backend/app/operations/ddl_table.py:180`). Previewing N specs is N
    concurrent POSTs through `Promise.all`, which for a realistic edit is a
    handful; a structure edit is a deliberate, low-frequency action, not a
    keystroke path. `Promise.all` preserves input order, so the joined SQL
    keeps the order `diffColumnSpecs` chose.

[^payload]: The alternative — leaving `dataType` as the Type cell's value —
    was rejected because it turns a display shortcoming into a data-loss
    footgun. A `varchar(60)` column shows as `character varying`; a user who
    edits that cell and commits it back has just asked for an unbounded
    `character varying`. Switching `dataType` itself to `format_type` was also
    rejected: `pg_type_to_wire` matches exact type names, so a modifier would
    make `timestamp(3) with time zone` fall through to `STRING` — the same
    matview bug `content-derived-column-sizing` filed in `TODO.md`. A second
    field keeps the wire mapping exactly as it is. `_MATVIEW_SQL` already
    computes `format_type` for its `data_type`, so its `full_type` is the same
    expression under a second alias.

[^cap-restated]: `Table.clampColumnWidth` clamps a derived width to
    `[minWidth ?? policy.min, maxWidth ?? AUTO_WIDTH_CAP_PX]`, where
    `AUTO_WIDTH_CAP_PX` is 400. A column that declares `maxWidth: 400`
    therefore gets exactly the width it gets today — but
    `absorbSlackIntoGreedy` skips it, because that pass tests
    `col.getMaxWidth() === undefined`. So the declaration changes nothing about
    content sizing and everything about who gets the leftover space. This is
    the mechanism `content-derived-column-sizing`'s Implementation Notes
    recorded as inflating `definition` past 680px and `name` past 350px on the
    Indexes grid; this plan aims it at a blank column instead, for the Columns
    grid only.

[^filler]: The library ships this exact construct for its own rotated display
    mode — a `filler` field on `ROTATED_MODEL` with
    `{ field: 'filler', headerText: '', minWidth: 0, unhideable: true }` and a
    `maxWidth` on both real columns
    (`component/table/Table.ts`) — and its own plan notes that "there is no
    per-column flex/weight/preferred-width knob in `ColumnConfig`" and "no
    spacer/filler-column precedent exists in the codebase". So there is nothing
    cleaner to adopt; following the library's own recipe is the closest thing
    to an official API. The existing app trick — letting the renderer-bearing
    `sequence` column soak up the leftover width because the library never
    samples it — is what this replaces: it only works while that column exists,
    it splits the leftover with every other uncapped column rather than taking
    it all, and it makes the link column's width an accident of the grid's
    total width.
