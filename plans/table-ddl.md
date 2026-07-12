---
depends-on: [ddl-infrastructure]
touches-shared:
  - backend/app/operations/__init__.py
  - backend/app/main.py
  - frontend/src/data/api.ts
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/contract.ts
  - frontend/src/SqlAdminController.ts
---

# Table DDL — Structured CREATE / ALTER / DROP TABLE — Implementation Plan

## Overview

This phase adds structured **table** DDL editing on top of the shared infrastructure in [`plans/ddl-infrastructure.md`](plans/ddl-infrastructure.md): CREATE / DROP / rename TABLE, ALTER-column operations, and constraint/index add/drop. Every operation reuses phase-1's seams unchanged — the pure SQL-builder module [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py) (its `qualify`/`quote_literal`/re-exported `quote_ident` primitives), the `DdlPreview` preview base and the single `ExecuteDdlCommand` + [`POST /api/{connection_id}/ddl/execute`](backend/app/main.py) route, the reusable `openSqlPreviewDialog` (form + editable SQL preview + Execute/Cancel) in `frontend/src/dock/SqlPreviewDialog.ts`, the `executeDdl` client in [`frontend/src/data/api.ts:205`](frontend/src/data/api.ts#L205), and the navigator context-menu + `refresh()` seams. This phase does **not** redefine any of those; it adds table-specific builders, preview ops, preview routes, dialog forms, and launch actions.

Forms that edit an existing table **prefill from its current structure**: columns from [`ListColumnsQuery`](backend/app/operations/list_columns.py#L21) via [`getColumns`](frontend/src/data/api.ts#L173), and indexes/constraints/FKs from the combined [`/structure`](backend/app/main.py#L358) endpoint ([`ListIndexesQuery`/`ListConstraintsQuery`/`ListForeignKeysQuery`](backend/app/operations/table_structure.py#L40)) via [`getStructure`](frontend/src/data/api.ts#L194). The read-only [`StructurePanel`](frontend/src/dock/StructurePanel.ts#L41) is extended to host the edit actions (per-section toolbars) alongside navigator context-menu entries for create-table (schema node) and drop/rename-table (table node).

---

## Downstream note

Phase-1's `ddl.py` primitives (`qualify`, `quote_literal`, `quote_ident`) and the `DdlPreview`/`ExecuteDdlCommand` ops are assumed present (this plan's `depends-on`). If they are not yet on disk when implementing, they are defined in [`plans/ddl-infrastructure.md`](plans/ddl-infrastructure.md) §Public API — build that phase first.

---

## Architecture Decisions

### Table builders live in `ddl.py`, grouped under a `# --- Table DDL ---` section

Phase-1 prescribes that each phase adds its builder functions to `backend/app/sql/ddl.py` (§Public API: "each phase adds its own builder functions here"). This phase follows that seam — all table builders go in `ddl.py`, in one delimited section, importing nothing new beyond the module's own `quote_ident`/`qualify`/`quote_literal`. Rationale: keeping the builder surface single-sourced is the whole point of phase-1's module; a separate `ddl_table.py` for *pure builders* would fragment it. (Preview **operations** do get their own module — see next decision — because that mirrors the one-op-per-concern layout of `backend/app/operations/`.)

### Preview ops grouped by dialog, dispatched on an `action` discriminator

ALTER TABLE alone has nine sub-operations; one preview op + route + client method each would be ~20 near-identical endpoints. Instead, preview ops are grouped by **dialog/category**, each dispatching on an `action` field in its spec: `PreviewCreateTable`, `PreviewDropTable`, `PreviewAlterTable` (add/drop/rename column, change type, set/drop NOT NULL, set/drop default, rename table), `PreviewConstraint` (add PK/unique/check/FK, drop constraint), `PreviewIndex` (create/drop index). Each is a pure `DdlPreview` subclass: `__init__` validates the spec's required identifiers, `build()` dispatches on `action` to the matching pure builder and sets `self._sql`, and phase-1's default `apply()` (just calls `build()`) applies — **no op introspects**, because prefill happens on the frontend before the dialog opens. This keeps every op unit-testable with `NO_CONN` (set nothing, call `build()`/`get_result()`).

### Prefill on the client, not the server

The "edit existing table" forms are seeded from data the frontend **already fetches** for the structure tab (`getColumns` + `getStructure`). The preview op receives a complete spec and never reads the catalog. This avoids a second round trip and keeps preview ops pure (the phase-1 base supports apply()-time reads, but table previews don't need them).

### One statement per operation; multi-field column edits are separate actions

Phase-1's execute path runs exactly one statement (the extended-query protocol rejects `;`-scripts). So an "edit column" gesture maps to **one** ALTER action, not a diff producing several. The StructurePanel Columns toolbar therefore offers discrete actions (Rename, Change type, Set/Drop NOT NULL, Set/Drop default, Drop column), each generating a single `ALTER TABLE … ALTER COLUMN …` statement. Changing both type and nullability is two sequential operations, by design.

### Identifiers quoted; type/default/check/USING expressions passed through raw (phase-1 trust model)

Per phase-1 §"Trust model": all *names* (schema, table, column, constraint, index) are `quote_ident`-quoted in the builders. Raw SQL fragments the form collects — column **type** strings (`numeric(10,2)`, `text[]`), **default** expressions (`now()`, `0`), **check** expressions (`balance >= 0`), and a type-change **USING** expression — cannot be parameterized or identifier-quoted; they are inserted verbatim and shown in the editable preview the user must confirm. Referential actions (`ON UPDATE`/`ON DELETE`) and index methods are **not** raw: they are validated against fixed allowlists (keywords), raising `ValidationError` on anything else.

### Read-only cells stay read-only; edits are toolbar actions on the selected row

The library `Table` exposes only `selection` and `cellclick` events ([Table.ts:24](frontend/node_modules/@jimka/typescript-ui/src/typescript/lib/component/table/Table.ts#L24)) — no per-row context-menu event. So structure edits are **not** inline cell edits (the grids keep `rowReadOnly: () => true`). Each editable section gets a small toolbar (Add buttons always enabled; Alter/Drop buttons enabled only when a row is selected, toggled off the grid's `selection` event via `getSelectedRecord()`). "Alter column" opens a `Menu` submenu (the [`NavigatorTree`](frontend/src/navigator/NavigatorTree.ts#L68) `Menu` idiom) of the per-column alter actions.

### Refresh scope: object-list changes refresh the navigator; structure changes rebuild the structure tab

Create/drop/rename **table** change a schema's object list → call [`NavigatorTree.refresh()`](frontend/src/navigator/NavigatorTree.ts#L195) (phase-1's coarse full reload; the finer per-branch reload is a noted `Tree` gap). Column/constraint/index changes do **not** change the object list but stale the open structure tab → the controller removes and re-opens it ([`Dock.removePanel`](frontend/node_modules/@jimka/typescript-ui/src/typescript/lib/overlay/Dock.ts#L1663) then `openStructure`). A column add/drop/rename/type-change also stales an open **data** grid's Model; that tab is closed on success (the user reopens it fresh) — see §Potential Challenges.

---

## Public API

### Backend — table builders added to `backend/app/sql/ddl.py`

All pure, no DB. Names are quoted via `quote_ident`; `qualify(schema, name)` returns `"schema"."name"`. A `ColumnDef` is a `Mapping[str, Any]` with keys `name: str`, `type: str` (raw), `nullable: bool`, `default: str | None` (raw expr), `primary_key: bool`. Referential actions and index methods are validated against module-level allowlists.

```python
# Fixed keyword allowlists (raise ValidationError on anything else).
_REFERENTIAL_ACTIONS: frozenset[str]  # {"NO ACTION","RESTRICT","CASCADE","SET NULL","SET DEFAULT"}
_INDEX_METHODS: frozenset[str]        # {"btree","hash","gin","gist","spgist","brin"}

def _column_clause(col: Mapping[str, Any]) -> str:
    """One column definition line: '"name" <type> [NOT NULL] [DEFAULT <expr>]'.
    type/default are raw; name is quoted. NOT NULL emitted when nullable is False;
    DEFAULT emitted when default is a non-empty string."""

def create_table(schema: str, name: str, columns: Sequence[Mapping[str, Any]],
                 *, if_not_exists: bool = False) -> str:
    """CREATE TABLE "schema"."name" ( <col lines>, [PRIMARY KEY (...)] ).
    Columns flagged primary_key=True collect into one table-level PRIMARY KEY
    clause (composite when several). Raises ValidationError if columns is empty."""

def drop_table(schema: str, name: str, *, cascade: bool = False,
               if_exists: bool = False) -> str:
    """DROP TABLE [IF EXISTS] "schema"."name" [CASCADE]. Omitting CASCADE leaves
    Postgres's default RESTRICT (the keyword is not emitted)."""

def rename_table(schema: str, name: str, new_name: str) -> str:
    """ALTER TABLE "schema"."name" RENAME TO "new_name" (new_name unqualified)."""

def add_column(schema: str, name: str, col: Mapping[str, Any]) -> str:
    """ALTER TABLE "s"."t" ADD COLUMN <_column_clause(col)>."""

def drop_column(schema: str, name: str, column: str, *, cascade: bool = False) -> str:
    """ALTER TABLE "s"."t" DROP COLUMN "column" [CASCADE]."""

def rename_column(schema: str, name: str, column: str, new_name: str) -> str:
    """ALTER TABLE "s"."t" RENAME COLUMN "column" TO "new_name"."""

def alter_column_type(schema: str, name: str, column: str, new_type: str,
                      *, using: str | None = None) -> str:
    """ALTER TABLE "s"."t" ALTER COLUMN "column" TYPE <new_type> [USING <using>].
    new_type and using are raw."""

def set_not_null(schema: str, name: str, column: str) -> str:
    """ALTER TABLE "s"."t" ALTER COLUMN "column" SET NOT NULL."""

def drop_not_null(schema: str, name: str, column: str) -> str:
    """ALTER TABLE "s"."t" ALTER COLUMN "column" DROP NOT NULL."""

def set_default(schema: str, name: str, column: str, default: str) -> str:
    """ALTER TABLE "s"."t" ALTER COLUMN "column" SET DEFAULT <default> (raw)."""

def drop_default(schema: str, name: str, column: str) -> str:
    """ALTER TABLE "s"."t" ALTER COLUMN "column" DROP DEFAULT."""

def add_primary_key(schema: str, name: str, columns: Sequence[str],
                    *, constraint_name: str | None = None) -> str:
    """ALTER TABLE "s"."t" ADD [CONSTRAINT "name"] PRIMARY KEY ("c1","c2").
    Raises ValidationError if columns is empty."""

def add_unique(schema: str, name: str, columns: Sequence[str],
               *, constraint_name: str | None = None) -> str:
    """ALTER TABLE "s"."t" ADD [CONSTRAINT "name"] UNIQUE ("c1","c2").
    Raises ValidationError if columns is empty."""

def add_check(schema: str, name: str, expression: str,
              *, constraint_name: str | None = None) -> str:
    """ALTER TABLE "s"."t" ADD [CONSTRAINT "name"] CHECK (<expression>) (raw).
    Raises ValidationError if expression is blank."""

def add_foreign_key(schema: str, name: str, columns: Sequence[str],
                    ref_schema: str, ref_table: str, ref_columns: Sequence[str],
                    *, constraint_name: str | None = None,
                    on_update: str | None = None, on_delete: str | None = None) -> str:
    """ALTER TABLE "s"."t" ADD [CONSTRAINT "name"] FOREIGN KEY ("c1")
    REFERENCES "rs"."rt" ("rc1") [ON UPDATE <a>] [ON DELETE <a>].
    Actions validated against _REFERENTIAL_ACTIONS. Raises ValidationError if
    columns/ref_columns empty or lengths differ, or an action is unknown."""

def drop_constraint(schema: str, name: str, constraint_name: str,
                    *, cascade: bool = False) -> str:
    """ALTER TABLE "s"."t" DROP CONSTRAINT "constraint_name" [CASCADE].
    Drops PK/unique/check/FK uniformly by name."""

def create_index(schema: str, table: str, columns: Sequence[str],
                 *, name: str | None = None, unique: bool = False,
                 method: str | None = None, if_not_exists: bool = False) -> str:
    """CREATE [UNIQUE] INDEX [IF NOT EXISTS] ["name"] ON "s"."t"
    [USING <method>] ("c1","c2"). method validated against _INDEX_METHODS.
    Raises ValidationError if columns empty. Omitting name lets Postgres auto-name."""

def drop_index(schema: str, index_name: str, *, cascade: bool = False,
               if_exists: bool = False) -> str:
    """DROP INDEX [IF EXISTS] "schema"."index_name" [CASCADE]. Indexes are
    schema-scoped objects — dropped by qualified index name, not table."""
```

### Backend — `backend/app/operations/ddl_table.py` (new)

Five `DdlPreview` subclasses. Each `__init__(self, conn, spec: Mapping[str, Any])` stores the spec and validates required identifiers (non-blank) via a shared `_require(spec, key)` helper raising `ValidationError`; each `build()` dispatches on `spec["action"]` (where applicable) to a `ddl.py` builder and sets `self._sql`. `apply()` is inherited from `DdlPreview` (pure — calls `build()`); `get_result()` is inherited (`{"sql": self._sql}`).

```python
class PreviewCreateTable(DdlPreview):
    """spec: {schema, name, columns: [{name,type,nullable,default,primaryKey}],
    ifNotExists?}. build() -> ddl.create_table(...)."""

class PreviewDropTable(DdlPreview):
    """spec: {schema, name, cascade?, ifExists?}. build() -> ddl.drop_table(...)."""

class PreviewAlterTable(DdlPreview):
    """spec: {schema, name, action, ...}. action in {addColumn, dropColumn,
    renameColumn, changeType, setNotNull, dropNotNull, setDefault, dropDefault,
    renameTable}; build() dispatches to the matching ddl.* builder.
    Raises ValidationError on an unknown action."""

class PreviewConstraint(DdlPreview):
    """spec: {schema, name, action, ...}. action in {addPrimaryKey, addUnique,
    addCheck, addForeignKey, drop}; build() dispatches to the matching builder."""

class PreviewIndex(DdlPreview):
    """spec: {schema, action, ...}. action in {create, drop}; 'create' also
    carries table. build() dispatches to ddl.create_index / ddl.drop_index."""
```

All five exported from [`operations/__init__.py`](backend/app/operations/__init__.py) and added to `__all__`.

### Backend — preview routes in `backend/app/main.py`

Five per-phase preview routes under the phase-1 `ddl/` namespace, each `Depends(require_csrf)`, body `dict = Body(...)`, resolving the pool via `session_pool_for`, constructing the op, `await op.apply()`, `return op.get_result()` (`{"sql": str}`). Grouped in a new `# --- Table DDL ------` section after `# --- Arbitrary SQL ---`.

```
POST /api/{connection_id}/{database}/ddl/table/create      body: PreviewCreateTable spec  -> {"sql": str}
POST /api/{connection_id}/{database}/ddl/table/drop        body: PreviewDropTable spec    -> {"sql": str}
POST /api/{connection_id}/{database}/ddl/table/alter       body: PreviewAlterTable spec   -> {"sql": str}
POST /api/{connection_id}/{database}/ddl/table/constraint  body: PreviewConstraint spec   -> {"sql": str}
POST /api/{connection_id}/{database}/ddl/table/index       body: PreviewIndex spec        -> {"sql": str}
```

Execute reuses phase-1's shared `POST /api/{connection_id}/ddl/execute` — no new execute route.

### Frontend — `frontend/src/contract.ts` (spec + reused types)

`DdlPreview` (`{sql}`) and `QueryStatusResult` come from phase-1 / existing contract. Add the table spec interfaces mirrored between form `readSpec()` and the client:

```ts
export interface ColumnSpec {
    name: string; type: string; nullable: boolean;
    default: string | null; primaryKey: boolean;
}
export interface CreateTableSpec { schema: string; name: string; columns: ColumnSpec[]; ifNotExists?: boolean; }
export interface DropTableSpec   { schema: string; name: string; cascade?: boolean; ifExists?: boolean; }

export type AlterColumnAction =
    | "renameColumn" | "changeType" | "setNotNull" | "dropNotNull"
    | "setDefault" | "dropDefault";
/** action-tagged ALTER TABLE spec; fields present depend on `action`. */
export interface AlterTableSpec {
    schema: string; name: string;
    action: AlterColumnAction | "addColumn" | "dropColumn" | "renameTable";
    column?: string; newName?: string; newType?: string; using?: string;
    default?: string; cascade?: boolean; columnDef?: ColumnSpec;
}
export type ConstraintKind = "primaryKey" | "unique" | "check" | "foreignKey";
export interface ConstraintSpec {
    schema: string; name: string;
    action: "addPrimaryKey" | "addUnique" | "addCheck" | "addForeignKey" | "drop";
    columns?: string[]; expression?: string; constraintName?: string;
    refSchema?: string; refTable?: string; refColumns?: string[];
    onUpdate?: string; onDelete?: string; cascade?: boolean;
}
export interface IndexSpec {
    schema: string; action: "create" | "drop";
    table?: string; name?: string; columns?: string[];
    unique?: boolean; method?: string; indexName?: string; cascade?: boolean;
}
```

### Frontend — `frontend/src/data/api.ts` (five preview clients)

Each reuses the module-private `postJson`, following phase-1's documented per-phase preview pattern:

```ts
export function previewCreateTable(ref: DbObjectRef, spec: CreateTableSpec): Promise<DdlPreview>;
export function previewDropTable(ref: DbObjectRef, spec: DropTableSpec): Promise<DdlPreview>;
export function previewAlterTable(ref: DbObjectRef, spec: AlterTableSpec): Promise<DdlPreview>;
export function previewConstraint(ref: DbObjectRef, spec: ConstraintSpec): Promise<DdlPreview>;
export function previewIndex(ref: DbObjectRef, spec: IndexSpec): Promise<DdlPreview>;
//   -> postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/table/<seg>`, spec)
```

`executeDdl` (phase-1) is reused unchanged for all Execute buttons.

### Frontend — new form components under `frontend/src/dock/`

Each is a class-first `Panel` (COMPONENT_CONVENTIONS §(a)/(d)) exposing a `readSpec()` (or `readColumn()`) reader; the controller embeds each into `openSqlPreviewDialog`. None owns its own Dialog — the shared dialog owns the SQL preview, buttons, and retry loop.

- `CreateTableForm.ts` — table-name `TextField` + a column **grid** (add/remove rows; each row: name `TextField`, type `TextField` (raw), nullable `Checkbox`, default `TextField`, PK `Checkbox`, remove `Button`). `readSpec(): CreateTableSpec`.
- `ColumnForm.ts` — a vertical single-column field group (name/type/nullable/default). `readColumn(): ColumnSpec`. Used by Add-Column.
- `AlterColumnForm.ts` — parameterized by `AlterColumnAction`, prefilled from a `ColumnMeta`; renders only the field(s) the action needs (rename → new-name field; changeType → new-type + optional USING; setDefault → default field; setNotNull/dropNotNull/dropDefault → a summary `Text`). `readSpec(): AlterTableSpec`.
- `RenameTableForm.ts` — new-name `TextField`. `readSpec(): AlterTableSpec` (action `renameTable`).
- `ConstraintForm.ts` — parameterized by `ConstraintKind`; PK/unique → a `ColumnChecklist`; check → expression `TextField` + optional name; FK → local `ColumnChecklist` + ref schema `ComboBox` + ref table `TextField` + ref columns `TextField`/checklist + on-update/on-delete `ComboBox` + optional name. `readSpec(): ConstraintSpec`.
- `IndexForm.ts` — name `TextField` (optional) + `ColumnChecklist` + unique `Checkbox` + method `ComboBox`. `readSpec(): IndexSpec` (action `create`).
- `ConfirmCascadeForm.ts` — a summary `Text` + optional `Checkbox` "CASCADE". Reused by drop-table, drop-column, drop-constraint, drop-index. `readSpec(): { cascade: boolean }`.
- `ColumnChecklist.ts` — a `VBox` of one `Checkbox` per column; `readSelected(): string[]` returns checked names **in table-column order**. Reused by `ConstraintForm` and `IndexForm`.

### Frontend — `frontend/src/dock/StructurePanel.ts` (host the edit actions)

Extend the constructor with an **optional** `actions?: StructureActions`. When present, each section gets a `ToolBar` in its `Border` NORTH region beside the caption; when absent, the panel stays exactly as today (read-only). Alter/Drop buttons are disabled until the section grid fires `selection` with a row.

```ts
export interface StructureActions {
    onAddColumn(): void;
    onAlterColumn(column: ColumnMeta, action: AlterColumnAction): void;
    onDropColumn(column: ColumnMeta): void;
    onAddConstraint(kind: ConstraintKind): void;
    onDropConstraint(constraintName: string): void;
    onCreateIndex(): void;
    onDropIndex(indexName: string): void;
}
```

### Frontend — `frontend/src/SqlAdminController.ts` (launchers + refresh)

One launcher per dialog, each building the form, opening the shared dialog, and refreshing on success:

```ts
createTable(ref: DbObjectRef): void;                 // schema node
dropTable(ref: DbObjectRef, node: TreeNode): void;   // table node
renameTable(ref: DbObjectRef, node: TreeNode): void; // table node
addColumn(ref: DbObjectRef): void;
alterColumn(ref: DbObjectRef, column: ColumnMeta, action: AlterColumnAction): void;
dropColumn(ref: DbObjectRef, column: ColumnMeta): void;
addConstraint(ref: DbObjectRef, kind: ConstraintKind): void;
dropConstraint(ref: DbObjectRef, constraintName: string): void;
createIndex(ref: DbObjectRef): void;
dropIndex(ref: DbObjectRef, indexName: string): void;
```

Plus a private `refreshStructure(ref, node)` (removePanel(structurePanelId) → `openStructure`) used by the structure-editing launchers' `onSuccess`, and `openStructure` extended to pass a `StructureActions` object wired to these launchers.

---

## Internal Structure

### Launcher shape (uniform)

```ts
createTable(ref: DbObjectRef): void {
    const form = new CreateTableForm(ref.schema!);
    openSqlPreviewDialog({
        title: "Create table",
        form,
        generateSql: async () => (await previewCreateTable(ref, form.readSpec())).sql,
        execute:     sql => executeDdl(this._connectionId, sql),
        onSuccess:   () => this._navigator?.refresh?.(),   // object list changed
        onError:     msg => this.notifyError(new Error(msg)),
    });
}
```

Structure-editing launchers set `onSuccess: () => this.refreshStructure(ref, node)` instead (object list unchanged). Drop/rename **table** set `onSuccess` to `navigator.refresh()` **and** `this.dock.removePanel(this.panelId(ref))` / structure/definition ids so stale tabs close.

### `PreviewAlterTable.build()` dispatch (representative)

```python
action = self._spec["action"]
s, t = self._spec["schema"], self._spec["name"]
if action == "addColumn":     self._sql = ddl.add_column(s, t, self._spec["columnDef"])
elif action == "dropColumn":  self._sql = ddl.drop_column(s, t, self._spec["column"], cascade=self._spec.get("cascade", False))
elif action == "renameColumn":self._sql = ddl.rename_column(s, t, self._spec["column"], self._spec["newName"])
elif action == "changeType":  self._sql = ddl.alter_column_type(s, t, self._spec["column"], self._spec["newType"], using=self._spec.get("using") or None)
elif action == "setNotNull":  self._sql = ddl.set_not_null(s, t, self._spec["column"])
elif action == "dropNotNull": self._sql = ddl.drop_not_null(s, t, self._spec["column"])
elif action == "setDefault":  self._sql = ddl.set_default(s, t, self._spec["column"], self._spec["default"])
elif action == "dropDefault": self._sql = ddl.drop_default(s, t, self._spec["column"])
elif action == "renameTable": self._sql = ddl.rename_table(s, t, self._spec["newName"])
else: raise ValidationError(f"Unknown ALTER action '{action}'")
```

### CreateTable column grid (library idiom)

Reuse the [`FilterDialog`](frontend/src/dock/FilterDialog.ts#L206) add/remove-row pattern: a `Grid` with weighted column tracks (name : type : default weighted; nullable/PK/remove content-sized), an "Add column" `Button` appending rows, each row's "−" removing it (down to one). `readSpec()` maps rows in order to `ColumnSpec[]`, dropping rows with a blank name. Lean on `Dialog.resizeToContent` (the shared dialog already re-fits) — do not pin heights (memory _Prefer library defaults_).

### Section toolbar wiring (StructurePanel)

`section(caption, grid, toolbar?)` puts an `HBox` of caption + optional `ToolBar` in NORTH. For each editable section, build the toolbar's Alter/Drop buttons disabled, then `grid.on("selection", recs => { const has = recs.length > 0; alterBtn.setEnabled(has); dropBtn.setEnabled(has); })`. Drop/Alter read `grid.getSelectedRecord()` for the target name/column. "Alter column" opens a `Menu` (as [`NavigatorTree`](frontend/src/navigator/NavigatorTree.ts#L114)) of the six alter actions, each calling `actions.onAlterColumn(colMeta, action)`.

---

## Ordered Implementation Steps

1. **`backend/app/sql/ddl.py`** — add the `# --- Table DDL ---` section: the two allowlists, `_column_clause`, and every builder in §Public API. Each a pure function with a docstring per the repo Python convention. Quote all names via `quote_ident`/`qualify`; insert type/default/check/USING raw; validate referential actions and index methods against the allowlists (`ValidationError` otherwise).

2. **`backend/tests/test_ddl_table_sql.py`** — new. Unit-test every builder's emitted SQL (see §Expected Behaviour), the quoting of names with spaces/quotes, composite PK, empty-columns/blank-expression `ValidationError`s, and unknown referential-action / index-method rejection. Follow [`test_ddl_sql.py`](backend/tests/test_ddl_sql.py) / [`test_compiler.py`](backend/tests/test_compiler.py) pure-function style.

3. **`backend/app/operations/ddl_table.py`** — new. The five `DdlPreview` subclasses per §Public API, the `_require` identifier guard, and the `build()` dispatchers. Import `ddl` builders and `DdlPreview` from phase-1.

4. **`backend/app/operations/__init__.py`** — import and add `PreviewCreateTable`, `PreviewDropTable`, `PreviewAlterTable`, `PreviewConstraint`, `PreviewIndex` to `__all__`.

5. **`backend/tests/test_ddl_table_preview.py`** — new. For each op: a `NO_CONN` construction with a spec, `build()`, assert `get_result()["sql"]` equals the expected string; assert a blank required identifier raises `ValidationError`; assert `PreviewAlterTable`/`PreviewConstraint`/`PreviewIndex` reject an unknown `action`. Mirror [`test_execute_ddl.py`](backend/tests/test_execute_ddl.py) / [`test_table_structure.py`](backend/tests/test_table_structure.py).

6. **`backend/app/main.py`** — add the five preview routes in a new `# --- Table DDL ------` section (§Public API), each `Depends(require_csrf)`, pool via `session_pool_for`, op → `apply()` → `get_result()`. Import the five ops in the operations import group.

7. **`frontend/src/contract.ts`** — add `ColumnSpec`, `CreateTableSpec`, `DropTableSpec`, `AlterColumnAction`, `AlterTableSpec`, `ConstraintKind`, `ConstraintSpec`, `IndexSpec` (§Public API).

8. **`frontend/src/data/api.ts`** — add the five `previewX` clients (§Public API), importing the new spec types and `DdlPreview` from `../contract`.

9. **`frontend/src/dock/ColumnChecklist.ts`** — new. `VBox` of `Checkbox` per column; `readSelected()` returns checked names in column order.

10. **`frontend/src/dock/CreateTableForm.ts`** — new. Table name + column grid (§Internal Structure); `readSpec()`.

11. **`frontend/src/dock/ColumnForm.ts`, `AlterColumnForm.ts`, `RenameTableForm.ts`, `ConstraintForm.ts`, `IndexForm.ts`, `ConfirmCascadeForm.ts`** — new, per §Public API. Each a class-first `Panel` with a `readSpec()`/`readColumn()`. Register any new glyphs at module scope (as [`FilterDialog`](frontend/src/dock/FilterDialog.ts#L44) does for `plus`/`minus`).

12. **Pure-logic unit tests for the readers** — put the spec-assembly logic (row → `ColumnSpec`, action + fields → `AlterTableSpec`, checklist → `string[]`) in **exported pure helpers** the form calls, and unit-test those under `frontend/tests/` (vitest), per memory _tsui DOM module side effects_ (the `Panel`s themselves touch `document` at import scope and are manual-verify). E.g. `frontend/tests/dock/ddlSpecs.test.ts` over a `frontend/src/dock/ddlSpecs.ts` module of pure `buildCreateTableSpec(rows)`, `buildAlterTableSpec(...)` functions.

13. **`frontend/src/dock/StructurePanel.ts`** — add the optional `actions?: StructureActions` param and the per-section toolbars (§Internal Structure). Preserve the read-only path when `actions` is undefined. Import `AlterColumnAction`/`ConstraintKind` types.

14. **`frontend/src/SqlAdminController.ts`** — add the ten launcher methods + `refreshStructure`, and extend `openStructure` to pass a `StructureActions` wired to them. Import `openSqlPreviewDialog`, the five `previewX` clients, `executeDdl`, and the form components. Reuse `notifyError` for `onError` and the status bar for success messaging.

15. **`frontend/src/navigator/NavigatorTree.ts`** — add context-menu items: on the **schema** branch ([:124](frontend/src/navigator/NavigatorTree.ts#L124)), append `{ text: "Create table…", action: () => this.controller.createTable(ref) }`; on the **relation** branch for `ref.kind === "table"` ([:138](frontend/src/navigator/NavigatorTree.ts#L138)), append `Rename table…` and `Drop table…` items calling `renameTable`/`dropTable`. Register any needed glyphs (reuse existing where possible).

16. **Regression checkpoints:**
    - `grep -rn "Preview\(CreateTable\|DropTable\|AlterTable\|Constraint\|Index\)" backend/app/operations/__init__.py` — expect all five exported.
    - `cd backend && poetry run pytest tests/test_ddl_table_sql.py tests/test_ddl_table_preview.py` — green (and full `poetry run pytest`).
    - `grep -rn "ddl/table/" backend/app/main.py frontend/src/data/api.ts` — five routes + five clients.
    - `cd frontend && npm run typecheck && npm test` — clean.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `backend/app/sql/ddl.py` (add table builders + allowlists) |
| Create | `backend/app/operations/ddl_table.py` |
| Create | `backend/tests/test_ddl_table_sql.py` |
| Create | `backend/tests/test_ddl_table_preview.py` |
| Modify | `backend/app/operations/__init__.py` (export five preview ops) |
| Modify | `backend/app/main.py` (five preview routes) |
| Modify | `frontend/src/contract.ts` (spec interfaces) |
| Modify | `frontend/src/data/api.ts` (five preview clients) |
| Create | `frontend/src/dock/ddlSpecs.ts` (pure spec-assembly helpers) |
| Create | `frontend/src/dock/CreateTableForm.ts` |
| Create | `frontend/src/dock/ColumnForm.ts` |
| Create | `frontend/src/dock/AlterColumnForm.ts` |
| Create | `frontend/src/dock/RenameTableForm.ts` |
| Create | `frontend/src/dock/ConstraintForm.ts` |
| Create | `frontend/src/dock/IndexForm.ts` |
| Create | `frontend/src/dock/ConfirmCascadeForm.ts` |
| Create | `frontend/src/dock/ColumnChecklist.ts` |
| Create | `frontend/tests/dock/ddlSpecs.test.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` (optional `actions` + toolbars) |
| Modify | `frontend/src/SqlAdminController.ts` (launchers + refreshStructure) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (schema/table context items) |

---

## Expected Behaviour

### Backend SQL builders — unit-testable (pure, `test_ddl_table_sql.py`)

CREATE TABLE:
- `create_table("public","t",[{name:"id",type:"bigint",nullable:False,default:None,primary_key:True},{name:"email",type:"text",nullable:False,default:None,primary_key:False},{name:"created",type:"timestamptz",nullable:True,default:"now()",primary_key:False}])` →
  ```
  CREATE TABLE "public"."t" (
      "id" bigint NOT NULL,
      "email" text NOT NULL,
      "created" timestamptz DEFAULT now(),
      PRIMARY KEY ("id")
  )
  ```
- Composite PK (two columns `primary_key:True`) → trailing `PRIMARY KEY ("a", "b")`.
- No PK column → no `PRIMARY KEY` clause.
- `if_not_exists=True` → `CREATE TABLE IF NOT EXISTS …`.
- Name with a quote: `create_table('s"x',"t",[…])` qualifies to `"s""x"."t"`.
- **Empty `columns`** → `ValidationError`.

DROP / rename TABLE:
- `drop_table("public","t")` → `DROP TABLE "public"."t"`.
- `drop_table("public","t", cascade=True, if_exists=True)` → `DROP TABLE IF EXISTS "public"."t" CASCADE`.
- `rename_table("public","t","t2")` → `ALTER TABLE "public"."t" RENAME TO "t2"`.

ALTER column:
- `add_column("public","t",{name:"note",type:"text",nullable:True,default:None,primary_key:False})` → `ALTER TABLE "public"."t" ADD COLUMN "note" text` (nullable, no default → no `NOT NULL`/`DEFAULT`).
- `add_column(...)` with `nullable:False, default:"''"` → `… ADD COLUMN "note" text NOT NULL DEFAULT ''`.
- `drop_column("public","t","note")` → `ALTER TABLE "public"."t" DROP COLUMN "note"`; with `cascade=True` → `… DROP COLUMN "note" CASCADE`.
- `rename_column("public","t","note","memo")` → `… RENAME COLUMN "note" TO "memo"`.
- `alter_column_type("public","t","amt","numeric(10,2)")` → `… ALTER COLUMN "amt" TYPE numeric(10,2)`; with `using="amt::numeric(10,2)"` → `… TYPE numeric(10,2) USING amt::numeric(10,2)`.
- `set_not_null` / `drop_not_null` / `drop_default` → the exact clauses in §Public API.
- `set_default("public","t","created","now()")` → `… ALTER COLUMN "created" SET DEFAULT now()`.

Constraints:
- `add_primary_key("public","t",["id"])` → `ALTER TABLE "public"."t" ADD PRIMARY KEY ("id")`; with `constraint_name="t_pkey"` → `… ADD CONSTRAINT "t_pkey" PRIMARY KEY ("id")`.
- `add_unique("public","t",["email"], constraint_name="t_email_key")` → `… ADD CONSTRAINT "t_email_key" UNIQUE ("email")`.
- `add_check("public","t","balance >= 0", constraint_name="t_bal_chk")` → `… ADD CONSTRAINT "t_bal_chk" CHECK (balance >= 0)` (expr raw).
- **FK across schemas:** `add_foreign_key("sales","order",["customer_id"],"public","customers",["id"], on_delete="CASCADE")` → `ALTER TABLE "sales"."order" ADD FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE CASCADE`.
- FK **columns/ref_columns length mismatch** → `ValidationError`; **unknown `on_delete`** (e.g. `"NUKE"`) → `ValidationError`.
- `drop_constraint("public","t","t_email_key")` → `ALTER TABLE "public"."t" DROP CONSTRAINT "t_email_key"`; `cascade=True` → `… DROP CONSTRAINT "t_email_key" CASCADE`.

Indexes:
- `create_index("public","t",["email"], name="t_email_idx", unique=True)` → `CREATE UNIQUE INDEX "t_email_idx" ON "public"."t" ("email")`.
- `create_index("public","t",["a","b"], method="btree")` → `CREATE INDEX ON "public"."t" USING btree ("a", "b")` (no name → auto).
- **Unknown `method`** → `ValidationError`; **empty `columns`** → `ValidationError`.
- `drop_index("public","t_email_idx", if_exists=True, cascade=True)` → `DROP INDEX IF EXISTS "public"."t_email_idx" CASCADE`.

### Backend preview ops — unit-testable (`test_ddl_table_preview.py`)

- Each op with a valid spec → `get_result()` returns `{"sql": <the builder's string>}`.
- A blank `schema`/`name`/`column` → `ValidationError` from `__init__`.
- `PreviewAlterTable`/`PreviewConstraint`/`PreviewIndex` with an unrecognized `action` → `ValidationError` from `build()`.
- **(Integration, manual/DB)** via `POST …/ddl/table/create` then the shared `…/ddl/execute`: create a throwaway table, add a column, add a FK to another schema's table, create an index, drop them; a bad type string → 400 from `_pg_error_handler`; missing CSRF → 403.

### Frontend spec assembly — unit-testable (`ddlSpecs.test.ts`, pure helpers)

- `buildCreateTableSpec(rows)` drops blank-name rows, maps nullable/default/PK correctly, and carries an empty `default` as `null`.
- `buildAlterTableSpec(action, column, fields)` produces the correct action-tagged spec (e.g. `changeType` → `{action:"changeType", column, newType, using?}`).
- `ColumnChecklist.readSelected()` logic returns checked names in **column order** (test the pure ordering helper).
- Constraint/index spec builders emit the right `action` and carry only the relevant fields.

### Frontend dialogs — manual-verify (node harness can't drive `Dialog`/`CodeEditor`/focus; memory _tsui DOM module side effects_)

- Create-table dialog: adding/removing column rows re-fits the dialog; Execute runs the previewed (possibly edited) SQL; success closes the dialog and the new table appears after `navigator.refresh()`.
- Drop-table: the CASCADE checkbox toggles `CASCADE` in the preview; success removes the table and closes any open data/structure tabs for it.
- StructurePanel toolbars: Alter/Drop buttons enable only with a selected row; each opens the shared preview dialog prefilled from the selected row; success rebuilds the structure tab (`refreshStructure`).
- Add-FK-across-schemas and composite-PK forms produce the SQL shown in the backend cases above.
- Preview/execute **errors** surface via `notifyError` / the dialog's retry loop and leave the dialog open with the SQL intact (phase-1 dialog behavior).

---

## Verification

- **Backend unit:** `cd backend && poetry run pytest tests/test_ddl_table_sql.py tests/test_ddl_table_preview.py` (plus full `poetry run pytest`).
- **Backend integration (manual, DB up):** `docker compose up -d db`; exercise the five preview routes + shared execute per the integration cases (create → alter → constraint → index → drop a throwaway table; a bad type → 400; missing CSRF → 403).
- **Frontend:** `cd frontend && npm run typecheck && npm test` (the `ddlSpecs` pure tests). Dialog DOM flows are manual — drive the app (`npm run dev`, log in), right-click a schema → Create table…; on a table's structure tab exercise each section toolbar; confirm generated SQL and post-success refresh.
- **Grep invariants** per step 16.

---

## Potential Challenges

- **Stale open data grid after a column change.** A column add/drop/rename/type-change invalidates an open `TableWorkPanel`'s Model. Mitigation: the column-editing launchers' `onSuccess` also `dock.removePanel(panelId(ref))` so the data tab closes; the user reopens it fresh. (A live Model-rebuild is out of scope — noted, not built.)
- **Composite-key column ordering.** PK/unique/FK/index column order is semantically significant. Mitigation: `ColumnChecklist.readSelected()` returns names in the table's introspected column order (a deterministic, testable helper), not click order.
- **Coarse navigator refresh.** Create/drop/rename table triggers a full `NavigatorTree.refresh()` (collapses the tree), the phase-1 accepted limitation. Mitigation: acceptable; per-branch reload remains the noted `Tree` gap.
- **Raw expression footguns.** A malformed type/default/check/USING fragment fails at Execute. Mitigation: the editable preview is the review gate (phase-1 trust model); the error surfaces via the dialog retry loop.
- **FK ref-column entry.** The referenced table's columns aren't pre-fetched in the FK form. Mitigation (first cut): a comma-separated ref-columns `TextField`; a follow-on could fetch `getColumns` of the referenced table to offer a checklist (not required here).

---

## Critical Files

- [`plans/ddl-infrastructure.md`](plans/ddl-infrastructure.md) — the seams this phase extends (builders in `ddl.py`, `DdlPreview`, `ExecuteDdlCommand`, `/ddl/execute`, `SqlPreviewDialog`, `executeDdl`, navigator/refresh).
- [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py) — where table builders go; `qualify`/`quote_literal`/`quote_ident`.
- [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py#L21) — `quote_ident` semantics (embedded-quote doubling).
- [`backend/app/operations/base.py`](backend/app/operations/base.py) — the three-phase op contract the preview ops honor.
- [`backend/app/operations/table_structure.py`](backend/app/operations/table_structure.py) / [`list_columns.py`](backend/app/operations/list_columns.py) — the prefill sources and the constraint/FK contract shapes the forms map back to DDL.
- [`backend/app/operations/insert_row.py`](backend/app/operations/insert_row.py) — the `Command`/quoting idiom the ops mirror.
- [`backend/app/main.py`](backend/app/main.py#L291) — route/pool/`require_csrf` idioms; `_pg_error_handler`.
- [`backend/tests/conftest.py`](backend/tests/conftest.py) + [`test_table_structure.py`](backend/tests/test_table_structure.py) — the `NO_CONN` pure-logic test style.
- [`frontend/src/dock/StructurePanel.ts`](frontend/src/dock/StructurePanel.ts) — the edit-action host (section/grid structure).
- [`frontend/src/dock/FilterDialog.ts`](frontend/src/dock/FilterDialog.ts) — the add/remove-row `Grid` form idiom and the `Dialog` result-code convention the forms follow.
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts#L107) — the context-menu branch-by-kind + `Menu` idiom, and `refresh()`.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts#L360) — `openStructure`, `panelId`/`structurePanelId`, `notifyError`, `dock.removePanel`.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — class-first pattern for the new form components.

---

## Non-Goals

- **No views/matviews, schemas/sequences, functions/types, or roles DDL** — those are the other downstream phases (`view-matview-ddl`, `schema-sequence-ddl`, `function-type-ddl`). This phase is tables + their columns/constraints/indexes only.
- **No data migration beyond what the DDL itself performs.** Adding a `NOT NULL` column without a default, or a type change that can't cast, fails at Execute and surfaces the Postgres error — this phase does not backfill, pre-validate castability, or generate `USING` casts automatically.
- **No multi-statement batching.** One statement per Execute (phase-1). A multi-field column edit is two sequential operations, not one combined ALTER.
- **No inline cell editing in the structure grids.** Structure edits are toolbar-launched dialogs; the grids stay read-only (the library `Table` has no per-row context-menu seam).
- **No UI privilege pre-flighting.** Actions launch unconditionally; a lacking `CREATE`/ownership privilege produces a Postgres error on Execute (phase-1 trust model).
- **No new per-branch navigator cache invalidation** — reuse phase-1's coarse `refresh()`.
