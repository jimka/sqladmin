---
depends-on: [ddl-forms-in-tab-editing]
touches-shared:
  - frontend/src/contract.ts
  - frontend/src/data/api.ts
  - frontend/src/dock/ddlSpecs.ts
  - frontend/src/dock/TypeInfoPanel.ts
  - frontend/src/dock/typeInfoRows.ts
  - frontend/src/dock/columnsGrid.ts
  - frontend/src/dock/StructurePanel.ts
  - frontend/src/dock/CompositeTypeForm.ts
  - frontend/src/dock/AddEnumValueForm.ts
  - frontend/src/controller/ddlLaunchers.ts
  - frontend/src/controller/objectPanels.ts
  - frontend/src/navigator/objectMenu.ts
  - frontend/COMPONENT_CONVENTIONS.md
  - backend/app/sql/ddl.py
  - backend/app/operations/ddl_function_type.py
  - backend/app/operations/__init__.py
  - backend/app/endpoints/ddl.py
  - backend/tests/test_routes.py
  - README.md
---

# Type Panel Inline Editing — Implementation Plan

## Overview

A standalone enum or composite type gets **one** dock tab that both shows and edits it. Today there are two surfaces: [`TypeInfoPanel`](frontend/src/dock/TypeInfoPanel.ts) is a read-only grid ([`TypeInfoPanel.ts:79`](frontend/src/dock/TypeInfoPanel.ts#L79) locks every cell) opened by double-click or "Show info", and a separate "Edit" menu item calls [`DdlLaunchers.editType`](frontend/src/controller/ddlLaunchers.ts#L198), which opens either an `AddEnumValueForm` dialog or a prefilled composite *recreate* draft tab. This plan folds the editing into the info tab and deletes the second surface.

The converted `TypeInfoPanel` follows [`StructurePanel`](frontend/src/dock/StructurePanel.ts)'s Columns section: an inline-editable grid, a toolbar with Add row / Delete row / Save / Refresh, Save diffing the grid against the loaded definition and opening [`openSqlPreviewDialog`](frontend/src/dock/SqlPreviewDialog.ts#L110) with the generated statements.[^grid-not-form]

PostgreSQL supports real incremental alteration of a composite type but not of an enum, and this asymmetry shapes the whole plan. Composite attributes get true in-place add/drop/retype/rename. Enum labels get in-place add and rename; **deleting** a label instead routes that Save through a recreate-and-migrate script, because Postgres has no `ALTER TYPE … DROP VALUE`.[^pg-probe] Supporting both branches means new statement builders in [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py), new preview ops in [`backend/app/operations/ddl_function_type.py`](backend/app/operations/ddl_function_type.py), and three new routes in [`backend/app/endpoints/ddl.py`](backend/app/endpoints/ddl.py#L59).

---

## Architecture Decisions

### One tab, converted from `TypeInfoPanel` — not a new panel

`TypeInfoPanel` keeps its identity, its panel id (`typeInfoPanelId`), and its opener (`ObjectPanels.openType`). Its body grid becomes editable and its toolbar gains Add / Delete / Save. `DdlLaunchers.editType`, the navigator's "Edit" menu item, and `AddEnumValueForm.ts` are deleted.[^retire-edit]

### The Save flow mirrors `StructurePanel.saveColumns`

Save reads the grid's rows off the store's master list, diffs them against the definition the tab loaded, and opens the shared preview dialog with one summary line per change — the shape of [`StructurePanel.saveColumns`](frontend/src/dock/StructurePanel.ts#L295) and [`SequenceInfoPanel.handleSave`](frontend/src/dock/SequenceInfoPanel.ts#L305). A diff error and a no-op diff are both reported through `onError`/`onStatus` without opening a dialog. The Save button is gated on `store.hasPendingChanges()`, re-synced on every `"datachange"`, exactly as [`syncColumnsSave`](frontend/src/dock/StructurePanel.ts#L332) does.

### Composite attributes: one statement per change, ordered like `diffColumnSpecs`

`diffCompositeAttributeSpecs` returns an ordered `AlterCompositeTypeSpec[]`; the panel previews each and joins the SQL with `";\n"`, exactly as `saveColumns` does for `AlterTableSpec[]`. The order is drops → type changes → renames → adds, for the same reasons [`diffColumnSpecs`](frontend/src/dock/ddlSpecs.ts#L156) uses it: every clause before a rename names the attribute the database still has, and an added attribute can reuse a name a drop or rename just freed.[^one-statement-each]

| Loaded attributes | Grid after edits | Emitted statements, in order |
|---|---|---|
| `street text`, `city text` | `city` row deleted; `street` renamed to `road`; `zip varchar(10)` added | `DROP ATTRIBUTE "city"` · `RENAME ATTRIBUTE "street" TO "road"` · `ADD ATTRIBUTE "zip" varchar(10)` |
| `a int` | `a` retyped to `bigint` | `ALTER ATTRIBUTE "a" TYPE bigint` |
| `a int` | `a` retyped to `bigint` **and** renamed to `b` | `ALTER ATTRIBUTE "a" TYPE bigint` · `RENAME ATTRIBUTE "a" TO "b"` |

### Enum labels: deleting a label routes the whole Save through a recreate

`diffEnumLabels` returns an `EnumEditPlan` — either a list of in-place `ADD VALUE` / `RENAME VALUE` statements, or a single recreate spec carrying the grid's full final label list. The recreate branch is chosen exactly when a **loaded** label is missing from the grid; deleting a row the user added in this same editing session is not a deletion of anything the database has, so it stays on the in-place branch.[^delete-routes-save]

| Loaded labels | Grid after edits | Plan |
|---|---|---|
| `sad, ok, happy` | `elated` added | `alter`: `ADD VALUE 'elated'` |
| `sad, ok, happy` | `ok` renamed to `fine` | `alter`: `RENAME VALUE 'ok' TO 'fine'` |
| `sad, ok, happy` | `ok` renamed to `fine`, `elated` added | `alter`: `RENAME VALUE 'ok' TO 'fine'` then `ADD VALUE 'elated'` |
| `sad, ok, happy` | `ok` row deleted | `recreate` with labels `sad, happy` |
| `sad, ok, happy` | `ok` row deleted, `elated` added | `recreate` with labels `sad, happy, elated` |
| `sad, ok, happy` | `elated` added, then that same new row deleted again | `none` |

Renames are emitted before adds so an added label may reuse a name a rename just freed, matching `diffColumnSpecs`' ordering rule.

### The recreate warning lives in the preview dialog's summary panel

When the plan is a recreate, the dialog's `form` is `summaryPanel(describeEnumPlan(plan))`, whose lines name the removed labels and state that the type is renamed aside, recreated, and that every table column using it is rewritten. The dialog's Cancel/Execute pair is the confirmation, and the generated migration SQL is right below the warning.[^no-checkbox]

### The backend resolves the enum's dependent columns; the frontend never sees them

The frontend sends only `{schema, name, labels}`. `RecreateEnumTypePreview` overrides `apply()` to read the columns whose type is the enum (or its array type) and their defaults, then builds the script. `DdlPreview`'s own docstring sanctions exactly this ("A subclass whose preview must introspect first … overrides this to fetch, then calls `self.build()`"); it is the first preview op to use it.[^preview-io]

### Composite attribute edits use one action-tagged route; the two new enum statements get one route each

`AlterCompositeTypePreview` dispatches on `spec["action"]` over `addAttribute` / `dropAttribute` / `changeAttributeType` / `renameAttribute`, mirroring [`PreviewAlterTable`](backend/app/operations/ddl_table.py#L132) — the same family of per-member column-like edits. The two new enum statements are unrelated statement kinds and get their own routes, matching the type family's existing one-route-per-statement layout (`create-enum-type`, `drop-type`, `alter-type-add-value`).

### `CASCADE` is not emitted, and not offered

None of the new builders take a `cascade` flag. Where Postgres demands one — a composite that is the declared type of a typed table (`CREATE TABLE … OF t`) — the statement fails, the preview dialog stays open with the error, and the reviewer can append `CASCADE` in the editable SQL before re-executing.[^cascade]

---

## Public API

### `frontend/src/contract.ts`

```ts
/** The spec one ALTER TYPE ... ATTRIBUTE preview call sends (action-tagged, like AlterTableSpec). */
export interface AlterCompositeTypeSpec {
    schema: string;
    name: string;
    action: "addAttribute" | "dropAttribute" | "changeAttributeType" | "renameAttribute";
    attribute?: string;                            // every action but addAttribute
    newName?: string;                              // renameAttribute
    newType?: string;                              // changeAttributeType
    attributeDef?: { name: string; type: string }; // addAttribute
}

/** The spec an ALTER TYPE ... RENAME VALUE preview call sends. */
export interface AlterTypeRenameValueSpec {
    schema: string;
    name: string;
    value: string;    // the label as the database has it
    newValue: string; // its new text
}

/** The spec the enum recreate-and-migrate preview call sends. */
export interface RecreateEnumTypeSpec {
    schema: string;
    name: string;
    labels: string[]; // the type's full label list after the edit, in order
}
```

### `frontend/src/data/api.ts`

```ts
export function previewAlterCompositeType(ref: DbObjectRef, spec: AlterCompositeTypeSpec): Promise<DdlPreview>;
export function previewAlterTypeRenameValue(ref: DbObjectRef, spec: AlterTypeRenameValueSpec): Promise<DdlPreview>;
export function previewRecreateEnumType(ref: DbObjectRef, spec: RecreateEnumTypeSpec): Promise<DdlPreview>;
```

Route suffixes: `ddl/alter-composite-type`, `ddl/alter-type-rename-value`, `ddl/recreate-enum-type`.

### `frontend/src/dock/ddlSpecs.ts`

```ts
/** One composite-attribute grid row, as the Save diff reads it. */
export interface EditedAttributeRow {
    originalName: string; // the row's attribute name when the grid was seeded; "" for a row added since
    name: string;
    type: string;
}

/** The fields a composite-attribute action may carry; which ones apply depends on `action`. */
export interface AlterCompositeTypeFields {
    attribute?: string;
    newName?: string;
    newType?: string;
    attributeDef?: { name: string; type: string };
}

export function buildAlterCompositeTypeSpec(
    schema: string,
    name: string,
    action: AlterCompositeTypeSpec["action"],
    fields: AlterCompositeTypeFields,
): AlterCompositeTypeSpec;

export function diffCompositeAttributeSpecs(
    schema: string,
    name: string,
    original: { name: string; type: string }[],
    edited: EditedAttributeRow[],
): AlterCompositeTypeSpec[];

export function describeCompositeSpecs(specs: AlterCompositeTypeSpec[]): string[];

/** One enum-label grid row, as the Save diff reads it. */
export interface EditedLabelRow {
    originalLabel: string; // the row's label when the grid was seeded; "" for a row added since
    label: string;
}

/** What a Save on an enum tab will run. `recreate` carries the labels the rebuilt type gets. */
export type EnumEditPlan =
    | { kind: "none" }
    | { kind: "alter"; adds: AlterTypeAddValueSpec[]; renames: AlterTypeRenameValueSpec[] }
    | { kind: "recreate"; spec: RecreateEnumTypeSpec; removed: string[] };

export function buildAlterTypeRenameValueSpec(
    schema: string, name: string, value: string, newValue: string,
): AlterTypeRenameValueSpec;

export function buildRecreateEnumTypeSpec(schema: string, name: string, labels: string[]): RecreateEnumTypeSpec;

export function diffEnumLabels(
    schema: string, name: string, original: string[], edited: EditedLabelRow[],
): EnumEditPlan;

export function describeEnumPlan(plan: EnumEditPlan): string[];
```

### `frontend/src/dock/typeInfoRows.ts`

```ts
/** One row of the enum body grid: catalog order, the (editable) label, and the diff's identity anchor. */
export interface EnumLabelRow {
    position: number;
    label: string;
    originalLabel: string;
}

/** One row of the composite body grid: the (editable) name/type pair plus the diff's identity anchor. */
export interface AttributeRow {
    name: string;
    type: string;
    originalName: string;
}

export function enumLabelRows(labels: string[]): EnumLabelRow[];
export function attributeRows(attributes: { name: string; type: string }[]): AttributeRow[];
export function categoryLabel(category: TypeDefinition["category"]): string; // unchanged
```

### `frontend/src/dock/columnsGrid.ts`

```ts
/** Enable `buttons` only while `grid` has a selected row; sets their initial (disabled) state immediately. */
export function gateOnSelection(grid: Table, buttons: Button[]): void;
```

Moved verbatim from [`StructurePanel.ts:396`](frontend/src/dock/StructurePanel.ts#L396), which now imports it.

### `frontend/src/dock/TypeInfoPanel.ts`

```ts
export interface TypeInfoPanelDeps {
    schema: string;
    name: string;
    previewAlterComposite:  (spec: AlterCompositeTypeSpec)  => Promise<DdlPreview>;
    previewAddEnumValue:    (spec: AlterTypeAddValueSpec)   => Promise<DdlPreview>;
    previewRenameEnumValue: (spec: AlterTypeRenameValueSpec) => Promise<DdlPreview>;
    previewRecreateEnum:    (spec: RecreateEnumTypeSpec)    => Promise<DdlPreview>;
    execute:      (sql: string) => Promise<QueryStatusResult>;
    reloadDetail: () => Promise<TypeDefinition>;
    onError:      (message: string) => void;
    onStatus:     (message: string) => void;
    onRefresh:    () => void;
}

class TypeInfoPanel extends Container {
    constructor(detail: TypeDefinition, deps: TypeInfoPanelDeps);
    reload(detail: TypeDefinition): void; // unchanged signature
}
```

All four preview callbacks are always wired; the panel calls only the ones its category needs.

### `backend/app/sql/ddl.py`

```python
@dataclass(frozen=True)
class EnumColumnDependency:
    """One table column whose type is an enum being recreated."""
    schema: str
    table: str
    column: str
    is_array: bool
    default_expr: str | None

def alter_type_add_attribute(schema: str, name: str, attr: CompositeAttr) -> str: ...
def alter_type_drop_attribute(schema: str, name: str, attribute: str) -> str: ...
def alter_type_alter_attribute_type(schema: str, name: str, attribute: str, new_type: str) -> str: ...
def alter_type_rename_attribute(schema: str, name: str, attribute: str, new_name: str) -> str: ...
def alter_type_rename_value(schema: str, name: str, value: str, new_value: str) -> str: ...
def recreate_enum_type(
    schema: str, name: str, labels: Sequence[str], dependents: Sequence[EnumColumnDependency]
) -> str: ...
```

Every new name is appended to `ddl.py`'s `__all__` ([`backend/app/sql/ddl.py:21`](backend/app/sql/ddl.py#L21)).

### `backend/app/operations/ddl_function_type.py`

```python
class AlterCompositeTypePreview(DdlPreview):  # dispatches on spec["action"], like PreviewAlterTable
class AlterTypeRenameValuePreview(DdlPreview): # pure
class RecreateEnumTypePreview(DdlPreview):     # overrides apply() to read dependent columns first
```

All three are re-exported from `backend/app/operations/__init__.py` and registered in `PREVIEW_OPS`.

---

## Implementation

### `recreate_enum_type`'s output

The whole script is `";\n"`-joined and runs inside `ExecuteDdlCommand`'s transaction, so a failure anywhere rolls the lot back — the same atomicity [`replace_materialized_view`](backend/app/sql/ddl.py#L846) relies on. For `schema="public"`, `name="mood"`, `labels=["sad", "happy"]`, and one dependent column `public.t.m` with default `'ok'::public.mood`:

```sql
ALTER TYPE "public"."mood" RENAME TO "mood__old";
CREATE TYPE "public"."mood" AS ENUM ('sad', 'happy');
ALTER TABLE "public"."t" ALTER COLUMN "m" DROP DEFAULT;
ALTER TABLE "public"."t" ALTER COLUMN "m" TYPE "public"."mood" USING "m"::text::"public"."mood";
ALTER TABLE "public"."t" ALTER COLUMN "m" SET DEFAULT 'ok'::public.mood;
DROP TYPE "public"."mood__old"
```

The `DROP DEFAULT` / `SET DEFAULT` pair is emitted only for a dependent with a `default_expr`; Postgres refuses `ALTER COLUMN … TYPE` while a default it cannot cast is still attached. An array-typed dependent (`is_array`) uses `TYPE "public"."mood"[] USING "m"::text[]::"public"."mood"[]` instead.

The temporary name is always `f"{name}__old"` (module constant `_ENUM_RECREATE_SUFFIX = "__old"`). No collision check: if such a type already exists the very first statement fails, nothing has run, and the reviewer can edit the previewed SQL.

Raises `ValidationError` when `schema`/`name` is blank (via `require_text`) or `labels` is empty.

### `RecreateEnumTypePreview`'s two catalog reads

```python
_TYPE_OID_SQL = (
    "SELECT t.oid, t.typarray FROM pg_catalog.pg_type t "
    "JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace "
    "WHERE n.nspname = $1 AND t.typname = $2 AND t.typtype = 'e'"
)
_DEPENDENTS_SQL = (
    "SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, "
    "(a.atttypid = $2) AS is_array, "
    "pg_get_expr(d.adbin, d.adrelid) AS default_expr "
    "FROM pg_catalog.pg_attribute a "
    "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid "
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
    "LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum "
    "WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p') "
    "AND a.atttypid IN ($1, $2) "
    "ORDER BY n.nspname, c.relname, a.attnum"
)
```

`$1` is the enum's oid, `$2` its array type's oid. `apply()` runs `_TYPE_OID_SQL` with `fetchrow`, raises `NotFound(f"Enum type '{schema}.{name}' not found")` on no row, then runs `_DEPENDENTS_SQL`, maps the rows to `EnumColumnDependency`, and calls `self.build()`. `_dependents` defaults to `[]` so `build()` is directly unit-testable with `NO_CONN`.

### The converted body grid

Model fields gain the diff's identity anchor, unrendered because `appendUnlisted: false` drops any field the `columns:` array does not list — the same trick `originalName` uses in [`columnsGrid.ts:87`](frontend/src/dock/columnsGrid.ts#L87):

```ts
const ENUM_FIELDS: FieldOptions[] = [
    { name: "position",      type: "number", description: "Order", order: 1 },
    { name: "label",         type: "string", description: "Label", order: 2 },
    { name: "originalLabel", type: "string", description: "Original label", order: 3 },
    { name: "filler",        type: "string", description: "",      order: 4 },
];

const ATTRIBUTE_FIELDS: FieldOptions[] = [
    { name: "name",         type: "string", description: "Attribute",     order: 1 },
    { name: "type",         type: "string", description: "Type",          order: 2 },
    { name: "originalName", type: "string", description: "Original name", order: 3 },
    { name: "filler",       type: "string", description: "",              order: 4 },
];
```

`bodyTable`'s spec drops `rowReadOnly: () => true` and marks only `position` read-only:

```ts
const spec: ColumnSpec = {
    columns: [
        ...realColumns.map(field => ({ field, maxWidth: CONTENT_WIDTH_CAP, readOnly: field === "position" })),
        FILLER_COLUMN,
    ],
    autoSizeColumns: true,
    appendUnlisted:  false,
};
```

### The panel's two Save paths

`_original: TypeDefinition` is a new mutable private field — the diff's baseline, reassigned by `reload`, exactly as `StructurePanel._columns` is. Two private readers pull the grid's rows off the store's master list (`getAll()`, so a header sort never changes the diff's row order), mirroring [`readEditedColumnRows`](frontend/src/dock/StructurePanel.ts#L481):

```ts
private readEditedLabelRows(): EditedLabelRow[];      // { originalLabel, label }
private readEditedAttributeRows(): EditedAttributeRow[]; // { originalName, name, type }
```

```ts
private saveComposite(): void {
    let specs: AlterCompositeTypeSpec[];

    try {
        specs = diffCompositeAttributeSpecs(
            this._deps.schema, this._deps.name, this._original.attributes, this.readEditedAttributeRows(),
        );
    } catch (err) {
        this._deps.onError(err instanceof Error ? err.message : String(err));

        return;
    }

    if (specs.length === 0) {
        this._deps.onStatus("No changes");

        return;
    }

    openSqlPreviewDialog({
        title:       "Alter composite type",
        form:        summaryPanel(describeCompositeSpecs(specs)),
        generateSql: async () =>
            (await Promise.all(specs.map(s => this._deps.previewAlterComposite(s)))).map(p => p.sql).join(";\n"),
        execute:     this._deps.execute,
        onSuccess:   () => void this.handleSuccess(),
        onError:     this._deps.onError,
    });
}
```

`saveEnum()` is the same skeleton over `diffEnumLabels(...)`: `{ kind: "none" }` reports `"No changes"`; a `recreate` plan's `generateSql` is one `previewRecreateEnum(plan.spec)` call; an `alter` plan's is `[...renames, ...adds]` previewed through `previewRenameEnumValue` / `previewAddEnumValue` and joined with `";\n"` — renames first (see the ordering rule above). Both branches use `summaryPanel(describeEnumPlan(plan))` as the dialog's `form` and the title `"Alter enum type"`.

### `describeEnumPlan`'s recreate warning

Exactly three lines, in this order, for `{ kind: "recreate", spec, removed }` on `public.mood` losing `ok`:

```
Removing label 'ok' needs the type recreated — PostgreSQL has no ALTER TYPE ... DROP VALUE.
"public"."mood" is renamed aside, recreated as ('sad', 'happy'), and every table column using it is rewritten.
This fails and rolls back if a stored row still holds a removed label, or a view depends on one of those columns.
```

Multiple removed labels are comma-joined in the first line (`Removing labels 'ok', 'sad' …`).

---

## Ordered Implementation Steps

Backend first, so the frontend has routes to call. Every automated test named below is written before the code it covers.

1. **`backend/tests/test_ddl_function_type_sql.py`** — add cases covering `## Expected Behaviour` §B1–B7 (the six new builders and their validation). Run `cd backend && poetry run python -m pytest tests/test_ddl_function_type_sql.py` — expect `AttributeError` on `ddl.alter_type_add_attribute`.

2. **`backend/app/sql/ddl.py`** — add `EnumColumnDependency`, the four composite-attribute builders, `alter_type_rename_value`, `_ENUM_RECREATE_SUFFIX`, and `recreate_enum_type`, all in the "Function/procedure & custom-type DDL" section after `alter_type_add_value` ([line 1465](backend/app/sql/ddl.py#L1465)). Each validates `schema`/`name` with `require_text` and quotes identifiers with `quote_ident`/`qualify`; attribute types and the recreate's `default_expr` are raw passthroughs (the section's stated trust model). Add all seven names to `__all__`. Re-run the test file — expect green.

3. **`backend/tests/test_ddl_function_type_ops.py`** — add cases for the three new ops (§B8–B10), in the file's existing `NO_CONN` style. Run the file — expect `ImportError`.

4. **`backend/app/operations/ddl_function_type.py`** — add `AlterCompositeTypePreview` (action dispatch; `ValidationError(f"Unknown composite ALTER action '{action}'")` on an unknown action), `AlterTypeRenameValuePreview`, and `RecreateEnumTypePreview` (the two SQL constants and the `apply()` override from `## Implementation`). Update the module docstring's statement list. Re-run the test file — expect green.

5. **`backend/app/operations/__init__.py`** — import and `__all__`-export the three new classes alongside `AlterTypeAddValuePreview`.

6. **`backend/tests/test_routes.py`** — add three `EXPECTED_ROUTES` rows: `("POST", f"{D}/ddl/alter-composite-type", "preview_alter_composite_type")`, `("POST", f"{D}/ddl/alter-type-rename-value", "preview_alter_type_rename_value")`, `("POST", f"{D}/ddl/recreate-enum-type", "preview_recreate_enum_type")`. Run `poetry run python -m pytest tests/test_routes.py` — expect a mismatch failure.

7. **`backend/app/endpoints/ddl.py`** — add the three `PREVIEW_OPS` entries under the "Function & type DDL" comment block and the three imports. Update the module docstring's "the 24 preview routes" to "the 27 preview routes". Re-run — expect green.

8. **Backend checkpoint** — `cd backend && poetry run python -m pytest`; the whole suite must be green.

9. **`frontend/src/contract.ts`** — add `AlterCompositeTypeSpec`, `AlterTypeRenameValueSpec`, `RecreateEnumTypeSpec` next to `AlterTypeAddValueSpec` ([line 419](frontend/src/contract.ts#L419)).

10. **`frontend/src/data/api.ts`** — add the three preview functions next to `previewAlterTypeAddValue` ([line 516](frontend/src/data/api.ts#L516)), each a one-line `postJson` following that function exactly.

11. **`frontend/tests/dock/ddlSpecs.test.ts`** — add cases for `## Expected Behaviour` §F1–F12. Run `cd frontend && npm test` — expect import failures.

12. **`frontend/src/dock/ddlSpecs.ts`** — add `EditedAttributeRow`, `AlterCompositeTypeFields`, `buildAlterCompositeTypeSpec`, `diffCompositeAttributeSpecs`, `describeCompositeSpecs`, `EditedLabelRow`, `EnumEditPlan`, `buildAlterTypeRenameValueSpec`, `buildRecreateEnumTypeSpec`, `diffEnumLabels`, `describeEnumPlan`. Place them after `buildAlterTypeAddValueSpec` ([line 955](frontend/src/dock/ddlSpecs.ts#L955)). Re-run — expect green.

13. **`frontend/tests/dock/typeInfoRows.test.ts`** — update `enumLabelRows` cases for the new `originalLabel` field and add `attributeRows` cases (§F13–F14).

14. **`frontend/src/dock/typeInfoRows.ts`** — add `originalLabel: label` to `enumLabelRows`' output and add `attributeRows`. Re-run — expect green.

15. **`frontend/src/dock/columnsGrid.ts`** — move `gateOnSelection` here verbatim from `StructurePanel.ts` and export it; extend the module header's first paragraph to say it also holds the small grid helpers every structure-style grid shares. Import `Button` from `@jimka/typescript-ui/component/button`.

16. **`frontend/src/dock/StructurePanel.ts`** — delete the local `gateOnSelection` and import it from `./columnsGrid`. Check: `grep -n 'function gateOnSelection' frontend/src/dock/StructurePanel.ts` — expect zero matches.

17. **`frontend/src/dock/TypeInfoPanel.ts`** — the conversion:
    - Extend `ENUM_FIELDS` / `ATTRIBUTE_FIELDS` and rewrite `bodyTable`'s spec per `## Implementation`.
    - `bodyRows` uses `attributeRows(detail.attributes)` for the composite branch.
    - Extend `TypeInfoPanelDeps` per `## Public API`.
    - Fields: replace `_schema`/`_name` with one `_deps: TypeInfoPanelDeps` (the name `_options` is unusable — `Container` already declares it, see `DdlFormPanel`'s header note), keep `_store` and `_category`, add `_original: TypeDefinition` (mutable, the diff's baseline) and `_saveButton`.
    - Build `saveButton`, `addButton`, `deleteButton` after `super()` returns (`this` is needed for the click handlers — see `COMPONENT_CONVENTIONS.md` (b), and `StructurePanel`'s identical post-`super()` `columnsSaveButton`); add them to the toolbar, which is therefore also assembled after `super()`. Toolbar order: `[addButton, deleteButton, saveButton, Spacer.flex(), refreshButton]`.
    - Button faces: `plus`/`CONSTRUCTIVE_COLOR` labelled `"Add label"` or `"Add attribute"`; `trash`/`DESTRUCTIVE_COLOR` labelled `"Delete label"` or `"Delete attribute"`; `save`/`PRIMARY_COLOR` labelled `"Save"`. Register the `plus`, `trash`, `save` glyphs alongside `refresh`.
    - `addButton` calls `grid.addRow({ label: "", originalLabel: "" })` (enum) or `grid.addRow({ name: "", type: "", originalName: "" })` (composite) — `position` is left out of the enum defaults so its cell renders blank until the next reload. `deleteButton` calls `grid.removeSelectedRow()` and is gated through `gateOnSelection(grid, [deleteButton])`.
    - `syncSaveEnabled` is a private arrow field reading `store.hasPendingChanges()` (convention (c)); register it on the store's `"datachange"` and call it once at the end of the constructor.
    - `handleSave()` dispatches on `this._category` to `saveComposite()` / `saveEnum()` (bodies sketched in `## Implementation`).
    - `reload(detail)` keeps its category-flip throw, then calls `this._store.reject()` before `loadData` (a queued removal otherwise survives the reseed — see `StructurePanel.reloadColumns`'s note), replaces `this._original` with the fresh detail, and calls `this.syncSaveEnabled()`.
    - `handleSuccess()` awaits `this._deps.reloadDetail()`, calls `this.reload(...)`, then `this._deps.onStatus(\`${this._deps.name}: altered\`)` — the shape of `SequenceInfoPanel.handleSuccess`.
    - Rewrite the module header: it is no longer read-only, and its "type creation/editing/dropping already live on the navigator's create/edit/drop DDL flows" sentence is now false.
    - `npm run typecheck` still fails after this step — `objectPanels.ts` has yet to pass the new deps. Step 18 clears it.

18. **`frontend/src/controller/objectPanels.ts`** — in `openType` ([line 485](frontend/src/controller/objectPanels.ts#L485)) wire the new deps, mirroring `openSequence` ([line 358](frontend/src/controller/objectPanels.ts#L358)):
    - `previewAlterComposite:  spec => previewAlterCompositeType(ref, spec)`
    - `previewAddEnumValue:    spec => previewAlterTypeAddValue(ref, spec)`
    - `previewRenameEnumValue: spec => previewAlterTypeRenameValue(ref, spec)`
    - `previewRecreateEnum:    spec => previewRecreateEnumType(ref, spec)`
    - `execute: sql => executeDdl(this.host.connectionId, sql)`, `reloadDetail: () => getTypeDefinition(ref)`, `onStatus: m => this.host.status(m)`, `onError: m => this.host.notifyError(new Error(m), ref)`, `onRefresh: refresh`

    Update `openType`'s doc comment: the tab is editable, and its "the same `getTypeDefinition` chain `DdlLaunchers.editType`'s prefill uses" clause ([line 478](frontend/src/controller/objectPanels.ts#L478)) names a method this plan deletes.

19. **`frontend/src/controller/ddlLaunchers.ts`** — delete `editType` ([line 198](frontend/src/controller/ddlLaunchers.ts#L198)) and the imports it alone used: `AddEnumValueForm`, `previewAlterTypeAddValue`, `getTypeDefinition`, and the `TypeDefinition` type. Leave `previewCreateCompositeType` (still used by `createType`). Check: `grep -rn 'editType' frontend/src/` — expect zero matches after step 21.

20. **`frontend/src/dock/AddEnumValueForm.ts`** — delete the file.

21. **`frontend/src/navigator/objectMenu.ts`** — drop `"editType"` from `DdlMenuActions` ([line 34](frontend/src/navigator/objectMenu.ts#L34)) and remove the `{ text: "Edit", … }` item from `typeMenuItems` ([line 119](frontend/src/navigator/objectMenu.ts#L119)); update that function's doc comment to "show its info, or drop it".

22. **`frontend/tests/navigator/objectMenu.test.ts`** — drop `editType` from the mock ([line 43](frontend/tests/navigator/objectMenu.test.ts#L43)) and change the type-leaf expectation ([line 165](frontend/tests/navigator/objectMenu.test.ts#L165)) to `["Show info", "Drop"]`.

23. **`frontend/src/dock/CompositeTypeForm.ts`** — remove the `prefill` option: the constructor takes `init: { schema: string }` and always seeds one empty row. Rewrite the header comment's "composite recreate" paragraph. Check: `grep -rn 'prefill' frontend/src/dock/CompositeTypeForm.ts` — expect zero matches.

24. **`frontend/COMPONENT_CONVENTIONS.md`** — in section (h) ([line 271](frontend/COMPONENT_CONVENTIONS.md#L271)) delete ", or the composite-type recreate/clone" from the first sentence, and add `TypeInfoPanel` to the list of edit-side precedents in the last sentence.

25. **`README.md`** — extend the "Structure & definitions" Highlights bullet (around [line 64](README.md#L64)) with one sentence: a type's info tab is editable in place the same way — add, rename, retype or remove a composite attribute, add or rename an enum label, with removing an enum label recreating the type and migrating every column that uses it.

26. **Frontend checkpoint** — `cd frontend && npm run typecheck && npm test`, then the manual verifications in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/sql/ddl.py` |
| Modify | `backend/app/operations/ddl_function_type.py` |
| Modify | `backend/app/operations/__init__.py` |
| Modify | `backend/app/endpoints/ddl.py` |
| Modify | `backend/tests/test_ddl_function_type_sql.py` |
| Modify | `backend/tests/test_ddl_function_type_ops.py` |
| Modify | `backend/tests/test_routes.py` |
| Modify | `frontend/src/contract.ts` |
| Modify | `frontend/src/data/api.ts` |
| Modify | `frontend/src/dock/ddlSpecs.ts` |
| Modify | `frontend/src/dock/typeInfoRows.ts` |
| Modify | `frontend/src/dock/TypeInfoPanel.ts` |
| Modify | `frontend/src/dock/columnsGrid.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` |
| Modify | `frontend/src/dock/CompositeTypeForm.ts` |
| Modify | `frontend/src/controller/objectPanels.ts` |
| Modify | `frontend/src/controller/ddlLaunchers.ts` |
| Modify | `frontend/src/navigator/objectMenu.ts` |
| Modify | `frontend/tests/dock/ddlSpecs.test.ts` |
| Modify | `frontend/tests/dock/typeInfoRows.test.ts` |
| Modify | `frontend/tests/navigator/objectMenu.test.ts` |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |
| Modify | `README.md` |
| Delete | `frontend/src/dock/AddEnumValueForm.ts` |

---

## Expected Behaviour

### B. Backend, unit-testable (pytest, no database)

1. `alter_type_add_attribute("public", "addr", CompositeAttr("zip", "varchar(10)"))` → `ALTER TYPE "public"."addr" ADD ATTRIBUTE "zip" varchar(10)`.
2. `alter_type_drop_attribute("public", "addr", "city")` → `ALTER TYPE "public"."addr" DROP ATTRIBUTE "city"`.
3. `alter_type_alter_attribute_type("public", "addr", "a", "bigint")` → `ALTER TYPE "public"."addr" ALTER ATTRIBUTE "a" TYPE bigint`.
4. `alter_type_rename_attribute("public", "addr", "street", "road")` → `ALTER TYPE "public"."addr" RENAME ATTRIBUTE "street" TO "road"`.
5. `alter_type_rename_value("public", "mood", "ok", "fine")` → `ALTER TYPE "public"."mood" RENAME VALUE 'ok' TO 'fine'` (both labels via `quote_literal`).
6. `recreate_enum_type` with no dependents → the rename / create / drop trio only. With the `public.t.m` dependent of `## Implementation`, exactly the six statements shown there. With `is_array=True` → the `[]`/`::text[]` variant. With `default_expr=None` → no `DROP DEFAULT` / `SET DEFAULT` pair.
7. Each builder raises `ValidationError` on a blank `schema` or `name`; `recreate_enum_type` also raises on an empty `labels`.
8. `AlterCompositeTypePreview` builds the matching statement for each of the four actions, and raises `ValidationError` for an unknown action, a missing `attribute`, a missing `newName`/`newType`, or a missing/blank `attributeDef.name`/`.type`.
9. `AlterTypeRenameValuePreview` raises `ValidationError` on a blank `schema`, `name`, `value`, or `newValue`.
10. `RecreateEnumTypePreview` constructed with `NO_CONN` and no dependents builds the rename/create/drop trio from `build()` alone.
11. Route resolution: the three new paths appear exactly once each in `app.routes` with the expected names, and no two routes sharing a method can match the same concrete URL (`test_routes.py`'s existing assertions cover this once the rows are added).

### F. Frontend, unit-testable (vitest, no DOM)

1. `buildAlterCompositeTypeSpec` carries only the fields its action needs: `dropAttribute` → `{schema, name, action, attribute}` with no `newName`/`newType`/`attributeDef`.
2. `diffCompositeAttributeSpecs` with an unchanged grid → `[]`.
3. The three-way edit in the first row of the composite table in `## Architecture Decisions` → exactly those three specs, in that order.
4. A retype **and** rename of one attribute → the `changeAttributeType` spec (keyed on the pre-rename name) before the `renameAttribute` spec.
5. A kept row with a blank name throws `Attribute "street" cannot be renamed to an empty name`; a kept row with a blank type throws `Attribute "street" needs a type`; an added row with a name but a blank type throws `New attribute "zip" needs a type`.
6. An added row whose name is blank is ignored entirely (no spec, no throw).
7. `describeCompositeSpecs` returns one line per spec: `Add attribute: "zip" varchar(10)`, `Drop attribute: "city"`, `Change type: "a" → bigint`, `Rename: "street" → "road"`.
8. `diffEnumLabels` reproduces every row of the enum table in `## Architecture Decisions`, including the last row (a row added and then deleted in the same session → `{ kind: "none" }`).
9. A recreate plan's `spec.labels` is the grid's full final label list in grid order, and its `removed` lists the loaded labels no longer present, in loaded order.
10. Deleting every row throws `Type "public"."mood" needs at least one label`.
11. A kept row renamed to blank throws `Label "ok" cannot be renamed to an empty name`; an added row with a blank label is ignored.
12. `describeEnumPlan` returns `[]` for `none`, one line per statement for `alter` (`Add label: 'elated'`, `Rename label: 'ok' → 'fine'`), and the three warning lines for `recreate` — the first naming every removed label.
13. `enumLabelRows(["sad","ok"])` → `[{position:1,label:"sad",originalLabel:"sad"},{position:2,label:"ok",originalLabel:"ok"}]`; `[]` → `[]`.
14. `attributeRows([{name:"a",type:"int"}])` → `[{name:"a",type:"int",originalName:"a"}]`; `[]` → `[]`.

### M. Manual verification (UI events, cell editing, live database)

Requires a running app against a Postgres holding: one composite type, one enum type, a column of table A typed with that enum, and a column of table B typed with that composite. Use two separate tables so the enum recreate never touches the table the composite cases read.

1. Double-clicking a type leaf opens **one** tab, showing Category, Owner and the payload grid. The navigator's type context menu offers only "Show info" and "Drop" — no "Edit".
2. On a fresh tab, Save is disabled and Delete is disabled; Delete enables as soon as a row is selected. Add is always enabled.
3. Editing a composite attribute's Name or Type cell enables Save. The `Order` column on an enum tab refuses to enter edit mode.
4. Composite Save with one rename, one retype, one drop and one add opens the preview dialog with four summary lines and four `";\n"`-joined `ALTER TYPE` statements, in the order of the table in `## Architecture Decisions`. Execute succeeds and the grid reseeds with the new attributes; Save goes back to disabled.
5. Retyping an attribute of a composite that some table column uses fails on Execute with `cannot alter type "…" because column "….…" uses it`; the dialog stays open with the error banner and the editor's text intact. Adding, dropping and renaming an attribute of that same composite all succeed.
6. Enum Save with only an added label runs a single `ALTER TYPE … ADD VALUE`; the new label appears at the end of the reseeded grid.
7. Enum Save with only a renamed label runs a single `ALTER TYPE … RENAME VALUE`; the dependent table's stored rows still read back correctly.
8. Enum Save after deleting a label opens the preview dialog whose summary block leads with the removal warning and whose SQL is the rename/create/migrate/drop script. Execute succeeds when no stored row holds the removed label; the tab reseeds without it.
9. Deleting a label that a stored row still holds fails on Execute with `invalid input value for enum …`, the transaction rolls back (the type still has all its original labels after a Refresh), and the dialog stays open.
10. A row added and then deleted again before Save leaves Save disabled and produces no statement.
11. Refresh (the toolbar button, or Alt+R) discards unsaved cell edits and re-reads the type; Save returns to disabled.
12. A table tab already open on a column whose enum was just recreated still shows correct data after its own Refresh — the type tab's Save does not refresh other tabs.

---

## Verification

- `cd backend && poetry run python -m pytest` — whole suite green, including the three new `test_routes.py` rows.
- `cd frontend && npm run typecheck && npm test` — green.
- `grep -rn 'editType\|AddEnumValueForm' frontend/src/ frontend/tests/` — expect zero matches.
- `grep -rn 'prefill' frontend/src/dock/CompositeTypeForm.ts` — expect zero matches.
- `grep -rn 'function gateOnSelection' frontend/src/dock/` — expect exactly one match, in `columnsGrid.ts`.
- `cd frontend && npm run build` — the production build succeeds.
- Manual: run the app (`docker compose up -d db` plus the backend/frontend dev servers, or the full Compose stack) and work through `## Expected Behaviour` §M. The entry point is the navigator's Types category under any schema; double-click a type leaf.
- Regression: creating a type still works from the schema context menu's **Create ▸ Composite type** and **Create ▸ Enum type** — the composite form now always opens with one empty row.

---

## Documentation Impact

- **`frontend/COMPONENT_CONVENTIONS.md` section (h)** — the composite-type recreate/clone flow it names no longer exists, and `TypeInfoPanel` joins `SequenceInfoPanel`/`StructurePanel` as an in-tab-edit precedent.
- **`README.md`** — the "Structure & definitions" Highlights bullet gains the type-tab editing sentence.
- **`backend/app/endpoints/ddl.py`** module docstring — "24 preview routes" becomes 27.
- **`backend/app/operations/ddl_function_type.py`** module docstring — its statement list gains the four composite-attribute actions, `RENAME VALUE`, and the enum recreate.
- **`backend/app/sql/ddl.py`** — the "Function/procedure & custom-type DDL" section comment ([line 1177](backend/app/sql/ddl.py#L1177)) gains the new statement kinds.
- **No `CHANGELOG.md` edit.** The 124 commits on this branch chain touch no changelog; release notes are written at release time by the maintainer.

---

## Potential Challenges

- **`ALTER ATTRIBUTE … TYPE` is refused whenever any table column has that composite type, and `CASCADE` does not lift it.** Verified against Postgres 16. The other three attribute actions are unaffected. Mitigation: the refusal surfaces as a plain execute error in the preview dialog with the editor intact, and §M5 pins the behaviour so it is not mistaken for a bug.
- **A typed table (`CREATE TABLE … OF t`) blocks every composite attribute action without `CASCADE`.** Mitigation: the reviewer appends `CASCADE` in the editable preview and re-executes; the dialog stays open after a failed Execute.
- **The enum recreate fails when a view or rule depends on a migrated column**, or when a non-table object (a domain, a matview) still references the old type at the final `DROP TYPE`. Mitigation: the whole script is one transaction, so a failure changes nothing; the warning block names the risk before Execute.
- **`store.loadData` leaves queued removals pending.** A Refresh or a post-Save reseed that skips `store.reject()` would carry a stale removal into the next diff. Mitigation: step 17 makes `reject()` part of `reload`, matching `StructurePanel.reloadColumns`.
- **The grid's `originalLabel`/`originalName` anchors must never be rendered.** They are omitted from the `columns:` array and `appendUnlisted: false` keeps them hidden; dropping that flag would surface two stray columns.

---

## Critical Files

- [`frontend/src/dock/StructurePanel.ts`](frontend/src/dock/StructurePanel.ts) — the precedent for the whole panel shape: `saveColumns` (line 295), `syncColumnsSave` (line 332), `buildColumnsTools` (line 451), `readEditedColumnRows` (line 481), `gateOnSelection` (line 396), and `reloadColumns`' `reject()`-before-reseed note (line 344).
- [`frontend/src/dock/ddlSpecs.ts`](frontend/src/dock/ddlSpecs.ts) — `diffColumnSpecs` (line 156) and `describeColumnSpecs` (line 277), the diff/describe pair the new type diffs copy.
- [`frontend/src/dock/SequenceInfoPanel.ts`](frontend/src/dock/SequenceInfoPanel.ts) — the deps-bag shape, `handleSave`/`handleSuccess`/`reload` (lines 305/344/357), and the Save-left/Refresh-right toolbar grouping.
- [`frontend/src/dock/TypeInfoPanel.ts`](frontend/src/dock/TypeInfoPanel.ts) — the panel being converted.
- [`frontend/src/dock/columnsGrid.ts`](frontend/src/dock/columnsGrid.ts) — `FILLER_COLUMN` (line 124) and `linkedColumnsTable` (line 185), the model for a partly-editable grid with a hidden identity field.
- [`frontend/src/controller/objectPanels.ts`](frontend/src/controller/objectPanels.ts) — `openSequence` (line 358) as the wiring template, `openType` (line 485) as the site to change.
- [`backend/app/operations/ddl_table.py`](backend/app/operations/ddl_table.py) — `PreviewAlterTable` (line 132), the action-dispatch preview op `AlterCompositeTypePreview` mirrors.
- [`backend/app/operations/ddl.py`](backend/app/operations/ddl.py) — `DdlPreview` (line 52), whose docstring sanctions an `apply()` override that introspects; `ExecuteDdlCommand.apply` (line 126) for the transaction wrap.
- [`backend/app/operations/type_definition.py`](backend/app/operations/type_definition.py) — the two-step catalog-read style `RecreateEnumTypePreview.apply()` follows, and the `typtype`-as-`"char"` caveat.
- [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py) — `create_composite_type` (line 1418), `alter_type_add_value` (line 1465), `replace_materialized_view` (line 846) for the `";\n"`-joined multi-statement precedent.

---

## Non-Goals

- **`BEFORE`/`AFTER` placement for a new enum label.** `Table.addRow` appends and the grid has no reorder affordance, so a new row is always last; placing a label mid-list is a reorder, which Postgres can only do by recreating the type. This is the one capability `AddEnumValueForm` had that the merged tab does not.
- **Reordering existing enum labels or composite attributes.** No drag affordance is added, so the relative order of loaded rows cannot change.
- **Editing a type's Category or Owner.** Category cannot change in place at all; `ALTER TYPE … OWNER TO` is a separate statement with no grid to hang it on. Both fieldset rows stay read-only display.
- **Renaming the type itself, or moving it to another schema.** The tab is keyed on `schema.name`; renaming would invalidate its own id.
- **A `CASCADE` checkbox on the type tab's Save.** See the `CASCADE` decision — the editable preview is the escape hatch.
- **Refreshing other open tabs after an enum recreate.** Each tab has its own Refresh; the navigator's object list is unchanged because the type keeps its name.
- **Creating a type.** `createType` and its two forms are untouched apart from `CompositeTypeForm` losing its now-unreachable `prefill`.

---

## Notes

[^grid-not-form]: `StructurePanel`'s Columns section, not `SequenceInfoPanel`'s field form, is the model, because a type's payload is a variable-length ordered list rather than a fixed field set — the same reason `TypeInfoPanel` was built as a grid in the first place (see its current header comment). `SequenceInfoPanel` still supplies the smaller patterns a grid does not: the deps bag, the Save/Refresh toolbar grouping, and the reload-after-Save flow.

[^pg-probe]: Confirmed empirically against the project's own `postgres:16-alpine` container, not from memory. Findings: `ADD ATTRIBUTE`, `DROP ATTRIBUTE`, `ALTER ATTRIBUTE … TYPE` and `RENAME ATTRIBUTE` all work on a composite type; several `ADD`/`DROP`/`ALTER ATTRIBUTE` actions may be comma-combined in one statement, but `RENAME ATTRIBUTE` may not (syntax error). When a plain table column has the composite type, `ADD`/`DROP`/`RENAME ATTRIBUTE` still work but `ALTER ATTRIBUTE … TYPE` fails with `cannot alter type "x" because column "t.c" uses it` — and appending `CASCADE` does not help. When the composite is the declared type of a typed table (`CREATE TABLE … OF t`), every attribute action is refused unless `CASCADE` is appended. For enums, `ALTER TYPE … RENAME VALUE` works, `ALTER TYPE … DROP VALUE` is a syntax error, and the rename/create/migrate/drop recipe of `## Implementation` runs correctly in one transaction — including the `DROP DEFAULT` step, without which Postgres reports `default for column "m" cannot be cast automatically`. The recipe fails, and rolls back cleanly, when a stored row still holds a removed label (`invalid input value for enum`) or when a view depends on a migrated column (`cannot alter type of a column used by a view or rule`).

[^retire-edit]: The two-surface split came from the `function-type-ddl` phase's "enum edits are append-only" decision and its matching "restructuring a composite in place is a Non-Goal", which `ddl-forms-in-tab-editing` carried forward by moving the composite branch into its own `DdlFormPanel` tab. Both premises are false for composites — Postgres has the four `ATTRIBUTE` statements — and only half true for enums. `CompositeTypeForm` survives because `createType(ref, "composite")` still needs it; only its `prefill` option, which existed solely for the recreate flow, goes.

[^one-statement-each]: Postgres does accept `ALTER TYPE t ADD ATTRIBUTE a int, DROP ATTRIBUTE b, ALTER ATTRIBUTE c TYPE text` as one statement, but `RENAME ATTRIBUTE` cannot join that list, so a combined form would still need a second statement whenever a rename is in the diff. One statement per change keeps the frontend diff structurally identical to `diffColumnSpecs`, keeps each preview round-trip one spec, and makes the previewed SQL easier to read and hand-edit. The whole `";\n"`-joined script runs inside `ExecuteDdlCommand`'s transaction either way, so there is no atomicity difference.

[^delete-routes-save]: The alternative — popping a confirmation the moment Delete is clicked — was rejected. It would make Delete the one toolbar action that mutates outside the Save diff, splitting the tab into two mutation paths and making a Save that combines a delete with a rename incoherent (the rename would run as `RENAME VALUE` against a type the recreate is about to replace). Routing at Save time keeps one mutation point, and the recreate's label list already carries every add and rename in the same edit, so the combined case collapses to a single correct script. The warning still reaches the user before anything runs, in the dialog that also shows the migration SQL.

[^no-checkbox]: `ConfirmCascadeForm` exists to *collect* a `CASCADE` flag that its caller then folds into the spec; the recreate warning collects nothing. A checkbox would also be inert here: `SqlPreviewDialog`'s Execute button owns its own `onClick` guard (`tryExecute`) and offers no hook for a form to veto the click, so gating on a checkbox would mean changing the shared dialog. `summaryPanel` — the same `form:` value `StructurePanel` and `SequenceInfoPanel` already pass on Save — carries the warning lines instead.

[^preview-io]: The dependent-column list cannot come from the frontend: the tab knows the type's own labels but nothing about which tables use it, and asking it to fetch that would add a client-side introspection query no other DDL flow has. Putting the read in the preview op keeps the wire spec minimal (`{schema, name, labels}`), keeps the introspection next to the SQL it feeds, and means the previewed script the user reviews is the script that runs. `build()` stays pure over `_dependents`, which defaults to `[]`, so it is unit-testable with the suite's `NO_CONN` stand-in.

[^cascade]: Three options were considered. Always emitting `CASCADE` was rejected: on a typed table it rewrites every row of that table, which is far too large a side effect to apply silently. A `CASCADE` checkbox on the tab was rejected as scope creep — it would need a place in the Save toolbar or the preview form for a case most types never hit, and the preview form cannot gate Execute (see the warning-panel note). Leaving it out entirely means the failure is loud, the error text carries Postgres's own `HINT: Use ALTER ... CASCADE`, and the fix is one word typed into an editor that is already open.
