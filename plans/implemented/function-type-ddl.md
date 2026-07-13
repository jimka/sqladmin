---
depends-on: [ddl-infrastructure]
touches-shared:
  - backend/app/sql/ddl.py
  - backend/app/operations/__init__.py
  - backend/app/main.py
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/navigator/objectGlyphs.ts
  - frontend/src/navigator/objectKinds.ts
  - frontend/src/data/api.ts
  - frontend/src/contract.ts
  - frontend/src/SqlAdminController.ts
  - frontend/src/properties/PropertiesPanel.ts
---

# Function / Procedure & Custom Type DDL — Implementation Plan

## Overview

Phase 5 of the DDL feature set. It adds structured create/drop for **functions and procedures** (`CREATE [OR REPLACE] FUNCTION|PROCEDURE`, `DROP FUNCTION|PROCEDURE` with an overload-disambiguating signature) and for **custom types** (`CREATE TYPE … AS ENUM`, `CREATE TYPE … AS (…)` composites, `DROP TYPE`, `ALTER TYPE … ADD VALUE`), plus it surfaces functions and types in the navigator (they are not listed today). Editing an existing function prefills the editable preview from `pg_get_functiondef`; editing a type prefills from a catalog introspection query.

Everything hangs off the phase-1 shared seams — do **not** redefine them: the SQL-builder module [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py) (with `qualify`, `quote_literal`, re-exported `quote_ident`), the preview base and single execute op [`backend/app/operations/ddl.py`](backend/app/operations/ddl.py) (`DdlPreview`, `ExecuteDdlCommand`), the shared execute route `POST /api/{connection_id}/ddl/execute`, the reusable dialog [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts) (`openSqlPreviewDialog`), the `executeDdl` client, and the navigator context-menu + `refresh()` seams. This phase adds object-specific **builders**, **preview ops**, **preview routes**, **definition/list queries**, **navigator listing**, and **forms** — all reusing phase-1's execute op/route and dialog.

The definition-query pattern is mirrored from [`backend/app/operations/view_definition.py`](backend/app/operations/view_definition.py) (`ViewDefinitionQuery` → `pg_get_viewdef`); the display pattern from [`frontend/src/dock/DefinitionPanel.ts`](frontend/src/dock/DefinitionPanel.ts); the CodeEditor body-editing surface is phase-1's preview editor, constructed exactly as [`QueryPanel.ts:148`](frontend/src/dock/QueryPanel.ts#L148) builds its `CodeEditor`.

---

## Drift notes (as-built, found before implementation)

- **No `DropDdlForm.ts`.** Phase 4 established that drop-function/drop-type
  reuse the existing [`ConfirmCascadeForm`](frontend/src/dock/ConfirmCascadeForm.ts)
  (a summary line + CASCADE checkbox) exactly as drop-schema/drop-sequence/
  drop-table/drop-index already do — none of those surface `ifExists` in the
  UI either, even though the backend param exists. This phase follows that
  precedent instead of introducing a new form idiom; `ifExists` is sent as
  `false` from the drop dialogs.
- **`FunctionForm` has create/edit modes, mirroring `ViewFormDialog`'s split**
  (structural fields editable on create, fixed on edit) — but edit mode does
  **not** round-trip through `previewCreateFunction` at all: per this plan's
  own "prefer `CREATE OR REPLACE`" decision, `pg_get_functiondef` already
  returns a complete, executable `CREATE OR REPLACE FUNCTION …` statement, so
  `editFunction`'s dialog seeds the editor directly from that fetched text
  (`generateSql` resolves to the constant already-fetched string) and skips
  calling any preview endpoint. The form's create-mode fields (name/kind/
  language/args/returns/volatility) are simply absent in edit mode, replaced
  by a fixed "Editing …" label, matching `ViewForm`'s edit branch.
- **Spec-assembly helpers land in the existing `frontend/src/dock/ddlSpecs.ts`**
  (already a pure spec-assembly-helper module per `table-ddl`/`schema-sequence-ddl`),
  not a new file — this phase's own helpers (`buildCreateFunctionSpec`,
  `buildDropFunctionSpec`, `buildCreateEnumTypeSpec`,
  `buildCreateCompositeTypeSpec`, `buildDropTypeSpec`,
  `buildAlterTypeAddValueSpec`) are appended there.
- **DbObjectRef gained `isProcedure?: boolean` (not in the original sketch).**
  A "function"-kind navigator leaf covers both plain functions and stored
  procedures under one category/kind, but `CREATE`/`DROP` need the real
  `"function" | "procedure"` routine kind to emit the right keyword — so the
  leaf's ref carries `isProcedure` (set from `ListFunctionsQuery`) alongside
  `signature`, and `dropFunction`/`editFunction` read it.
- **Two real bugs found only by manually driving the routes against a live
  database** (`docker compose up -d db` + curl), neither catchable by the
  `NO_CONN` hand-set-`_raw` unit tests since both sit in the SQL/asyncpg
  boundary `apply()` exercises: (1) `FunctionDefinitionQuery`'s original
  `::regprocedure` cast rejected a named-argument identity signature (e.g.
  `"a integer, b integer"`, which `pg_get_function_identity_arguments`
  returns whenever the routine was created with named arguments) — fixed by
  matching schema+name+an identity-arguments string equality instead of
  parsing a reconstructed signature text; (2) `TypeDefinitionQuery` compared
  `pg_type.typtype` to the Python string `"e"`, but asyncpg decodes
  Postgres's internal `"char"` pseudo-type as raw `bytes`, so every enum
  silently fell through to the composite branch and was misreported as
  `NotFound` — fixed by casting `typtype::text` in SQL. See the corresponding
  backend commit for the full detail.
- **No fetch-shape tests added for the eight new `api.ts` clients** — neither
  `table-ddl`, `view-matview-ddl`, nor `schema-sequence-ddl` added such tests
  (see the schema-sequence-ddl plan's own drift note); this phase follows the
  same precedent.

---

## Architecture Decisions

### Reconciliation with the as-built phase-4 (`schema-sequence-ddl`) registry seam

**This section supersedes the two decisions originally drafted here** ("New
navigator kinds via separate list queries" and "Coordination with phase-4"),
written before phase 4 existed. Phase 4 has since shipped and built exactly
the kind-registry seam those two decisions anticipated needing to fold into:
[`frontend/src/navigator/objectKinds.ts`](frontend/src/navigator/objectKinds.ts)
exports `OBJECT_KINDS: readonly ObjectKindInfo[]` (`{kind, glyph,
categoryLabel?, isRelation}`) plus `isRelationKind()`/`kindGlyph()`/
`objectCategories()`; [`objectGlyphs.ts`](frontend/src/navigator/objectGlyphs.ts)'s
`KIND_GLYPH` and [`NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts)'s
`OBJECT_CATEGORIES`/`isRelation` now *derive* from that registry instead of
each hand-maintaining its own switch/Record. This phase **adopts that seam
verbatim** rather than rolling a competing one:

- **`frontend/src/navigator/objectKinds.ts`**: append two entries —
  `{ kind: "function", glyph: "code", categoryLabel: "Functions", isRelation: false }`
  and `{ kind: "type", glyph: "cube", categoryLabel: "Types", isRelation: false }`.
  This is genuinely the one-line-per-kind change the registry's own header
  comment promises; no derivation call-site (`KIND_GLYPH`, `OBJECT_CATEGORIES`,
  `isRelation`) needs editing.
- **`frontend/src/navigator/objectGlyphs.ts`**: import+register the `code`/
  `cube` glyphs (subpath imports, per [LIBRARY_NOTES](LIBRARY_NOTES.md#L858));
  `KIND_GLYPH` needs no other change — it is already `Object.fromEntries`-built
  from `OBJECT_KINDS`.
- **`frontend/src/properties/PropertiesPanel.ts`** — phase 4 added this file
  to the exhaustiveness set (`propertyRows`'s `switch (ref.kind)` has no
  `default`, so TypeScript itself demands a case per kind). Widening
  `DbObjectKind` breaks this build until `"function"`/`"type"` cases are
  added; consequently this file joins `touches-shared` (the plan's original
  frontmatter omitted it because it predates this switch's exhaustiveness
  dependency).

### Listing decision: dedicated `pg_proc`/`pg_type` queries, merged into the same category-node pipeline phase 4 established

Phase 4 made sequences appear by **extending `ListObjectsQuery`**: a third
`UNION ALL` fragment reading `pg_catalog.pg_class` (`relkind = 'S'`), because
a sequence's wire shape is the same flat `{name, kind}` every other listed
object already has. That extension pattern is *not* reused verbatim here:

- **Functions carry data `{name, kind}` cannot express.** An overloaded
  function must be opened/edited/dropped by its exact identity-argument
  signature (`pg_get_function_identity_arguments`), or the wrong overload is
  targeted. That signature has no home in `ListObjectsQuery`'s flat shape
  without widening every other object kind's row shape for one kind's sake.
- **Functions and types live in `pg_proc`/`pg_type`, not `pg_class`.**
  `ListObjectsQuery`'s three existing fragments all read `information_schema.tables`
  or `pg_catalog.pg_class` — a fourth/fifth fragment reading unrelated catalogs
  under a `UNION ALL` that already assumes a `pg_class`-shaped row set is a
  worse fit than two small, purpose-built queries.

So this phase adds **`ListFunctionsQuery`** (`pg_proc`, carrying `signature`)
and **`ListTypesQuery`** (`pg_type`) as separate ops/routes, and
**`list_objects.py` is not modified** (dropped from `touches-shared` — the
original draft's inclusion was speculative). This does **not** fork the
navigator's rendering pipeline, though: `NavigatorTree.ts`'s `loadObjects`
fans out `Promise.all([getObjects(...), getFunctions(...), getTypes(...)])`
and merges all three responses into one combined array before handing it to
the **same, unmodified** `categoryNode`/`objectLeaf` machinery phase 4's
sequences already flow through — `categoryNode` filters by `kind` and
`OBJECT_CATEGORIES` (registry-derived) already has one entry per kind
regardless of which endpoint supplied it, so a function/type leaf is
structurally indistinguishable from a sequence leaf by the time it reaches
`categoryNode`. Only the *fetch* is three-way instead of one-way; the
category-grouping, glyph-lookup, and `isRelation` gating are the identical
phase-4 code path. `DbObject`/`objectLeaf` widen with an optional
`signature` field (set only for function leaves, carried onto the leaf's
`DbObjectRef`), mirroring how phase 4 widened nothing (a sequence leaf needed
no extra field) but the mechanism — an optional per-kind field flowing
leaf-to-`DbObjectRef` — is the same shape `DbObjectRef.signature` uses.

### Editable preview is authoritative; builders are pure and server-side

Inherited verbatim from phase-1: SQL is generated server-side by pure builders in `sql/ddl.py`, surfaced by per-object `DdlPreview` subclasses, shown in the **editable** preview, and **execute runs the previewed string** (phase-1 `ExecuteDdlCommand`), never a re-compiled spec. Identifiers (schema/name/arg-name/attr-name) are `quote_ident`-quoted in the builder; **raw type strings, defaults, function bodies, enum labels, and expressions pass through** as the user typed them (a function body is inherently opaque SQL and cannot be parameterized) — the preview is the review gate. This matches phase-1's trust model: the connected role can already run arbitrary SQL, so a bad fragment fails at execute and surfaces via [`_pg_error_handler`](backend/app/main.py#L133).

### Functions: prefer `CREATE OR REPLACE`; drop-recreate is the user's manual escape hatch

Editing a function seeds the editor with `pg_get_functiondef` output, which is already a complete `CREATE OR REPLACE FUNCTION …` statement — the user edits the body in place and executes. This preserves grants/dependencies and is a single statement. `CREATE OR REPLACE` **cannot** change a function's return type or argument types; an edit that does so makes Postgres raise `cannot change return type of existing function` (or silently create a new overload if only arg *names*/*defaults* change). We do **not** auto-emit a `DROP … ; CREATE …` pair (phase-1's one-statement-per-execute rule). The user resolves a signature change by editing the preview (e.g. dropping first, or via the separate Drop action). Stated so the implementer doesn't try to build multi-statement drop-recreate.

### Types: enum edits are append-only (`ADD VALUE`); composite in-place `ALTER` is out of scope

Postgres has no `CREATE OR REPLACE TYPE`. So: editing an **enum** offers `ALTER TYPE … ADD VALUE` (append a label, optionally `BEFORE`/`AFTER` an existing one) — a single statement, prefilled with the existing labels for reference. Editing a **composite** prefills the composite create form for reference/clone, but restructuring an existing composite in place (`ADD`/`DROP`/`ALTER ATTRIBUTE`) is a **Non-Goal** (it is multi-statement and dependency-fraught); the only in-scope structured writes on an existing composite are `DROP TYPE` and a full recreate the user drives through the editable preview.

### `ADD VALUE` runs fine inside phase-1's transaction on PostgreSQL 16

`ExecuteDdlCommand.apply()` wraps the statement in `async with conn.transaction()`. `ALTER TYPE … ADD VALUE` could not run in a transaction block before PostgreSQL 12; the target is **PostgreSQL 16** ([README](README.md#L37)), where it is transaction-safe for a bare `ADD VALUE` (the new value is merely unusable until commit, which does not affect a standalone execute). No special-casing of the execute op is needed.

---

## Public API

### Backend — builders appended to `backend/app/sql/ddl.py` (pure)

```python
@dataclass(frozen=True)
class FunctionArg:
    """One CREATE FUNCTION/PROCEDURE argument."""
    type: str                      # raw type expr, e.g. "integer", "text[]", "numeric(10,2)"
    name: str | None = None        # arg name (quoted as ident when present)
    mode: str | None = None        # "IN" | "OUT" | "INOUT" | "VARIADIC" (case-insensitive)
    default: str | None = None     # raw default expr, e.g. "0", "now()"

@dataclass(frozen=True)
class CompositeAttr:
    """One composite-type attribute."""
    name: str                      # attr name (quoted as ident)
    type: str                      # raw type expr

@dataclass(frozen=True)
class CreateRoutineSpec:
    """A CREATE [OR REPLACE] FUNCTION|PROCEDURE request."""
    schema: str
    name: str
    kind: str                      # "function" | "procedure"
    args: list[FunctionArg]
    language: str                  # "sql" | "plpgsql" | …  (raw, lower-cased)
    body: str                      # raw body text (edited in the preview)
    returns: str | None = None     # function only; ignored for procedure
    volatility: str | None = None  # function only: "IMMUTABLE"|"STABLE"|"VOLATILE"|None
    replace: bool = False          # emit CREATE OR REPLACE

def render_function_arg(arg: FunctionArg) -> str:
    """One arg -> "[MODE ][\"name\" ]type[ DEFAULT expr]". Pure; unit-tested."""

def create_routine(spec: CreateRoutineSpec) -> str:
    """CREATE [OR REPLACE] FUNCTION|PROCEDURE "s"."n"(args) [RETURNS t]
    LANGUAGE l [volatility] AS <dollar-quoted body>. No trailing semicolon."""

def drop_routine(schema: str, name: str, kind: str, signature: str,
                 cascade: bool, if_exists: bool) -> str:
    """DROP FUNCTION|PROCEDURE [IF EXISTS] "s"."n"(signature) [CASCADE].
    `signature` is the raw identity-argument list from introspection (may be "")."""

def create_enum_type(schema: str, name: str, labels: list[str]) -> str:
    """CREATE TYPE "s"."n" AS ENUM ('l1', 'l2', …). Labels via quote_literal."""

def create_composite_type(schema: str, name: str, attrs: list[CompositeAttr]) -> str:
    """CREATE TYPE "s"."n" AS ( "a1" t1, "a2" t2, … )."""

def drop_type(schema: str, name: str, cascade: bool, if_exists: bool) -> str:
    """DROP TYPE [IF EXISTS] "s"."n" [CASCADE]."""

def alter_type_add_value(schema: str, name: str, value: str,
                         position: tuple[str, str] | None = None) -> str:
    """ALTER TYPE "s"."n" ADD VALUE 'value' [BEFORE|AFTER 'existing'].
    `position` is ("before"|"after", existing_label) or None. Both literals
    via quote_literal."""
```

Internal helper (module-private):

```python
def _dollar_quote(body: str) -> str:
    """Wrap body in a dollar-quote tag not present in it: try "$function$",
    then "$func_1$", "$func_2$"… Returns the wrapped literal (tag+body+tag)."""
```

### Backend — definition/introspection queries (mirror `ViewDefinitionQuery`)

`backend/app/operations/function_definition.py` (new):

```python
class FunctionDefinitionQuery(Query):
    """pg_get_functiondef + prefill metadata for one routine, located by its
    qualified identity signature (disambiguates overloads)."""
    def __init__(self, conn, schema: str, name: str, signature: str) -> None: ...
    async def apply(self) -> None: ...   # fetch by `"s"."n"(signature)"::regprocedure`
    def get_result(self) -> dict:
        # {"definition": str, "isProcedure": bool, "signature": str, "language": str}
        # NotFound if no such routine.
```

`backend/app/operations/type_definition.py` (new):

```python
class TypeDefinitionQuery(Query):
    """Introspect one enum or composite type for edit prefill."""
    def __init__(self, conn, schema: str, name: str) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> dict:
        # {"category": "enum"|"composite",
        #  "labels": [str, …],                    # enum only (ordered)
        #  "attributes": [{"name": str, "type": str}, …]}   # composite only (attnum order)
        # NotFound if no such type.
```

### Backend — list queries for the navigator (mirror `ListObjectsQuery`)

`backend/app/operations/list_functions.py` (new):

```python
class ListFunctionsQuery(Query):
    """Functions and procedures in a schema (pg_proc, prokind IN ('f','p'))."""
    def __init__(self, conn, schema: str) -> None: ...
    def get_result(self) -> list[dict]:
        # [{"name": str, "signature": str, "isProcedure": bool}], name/sig ordered.
        # signature = pg_get_function_identity_arguments(oid).
```

`backend/app/operations/list_types.py` (new):

```python
class ListTypesQuery(Query):
    """Standalone enum + composite types in a schema (pg_type). Excludes array
    types and table/view row-types (join pg_class on typrelid: relkind='c' only)."""
    def __init__(self, conn, schema: str) -> None: ...
    def get_result(self) -> list[dict]:
        # [{"name": str}], name-ordered.
```

### Backend — preview ops (`DdlPreview` subclasses)

`backend/app/operations/ddl_function_type.py` (new). Each parses its spec dict in `__init__` (raising `ValidationError` when a required **identifier** — `schema`/`name` — is empty), stores fields, and implements `build()` calling the matching pure builder; `apply()` inherits phase-1's pure default (just `build()`), so all six are pure and unit-testable by constructing with `NO_CONN`.

```python
class CreateFunctionPreview(DdlPreview):   # build() -> create_routine(spec)
class DropFunctionPreview(DdlPreview):     # build() -> drop_routine(...)
class CreateEnumTypePreview(DdlPreview):   # build() -> create_enum_type(...)
class CreateCompositeTypePreview(DdlPreview):  # build() -> create_composite_type(...)
class DropTypePreview(DdlPreview):         # build() -> drop_type(...)
class AlterTypeAddValuePreview(DdlPreview):  # build() -> alter_type_add_value(...)
```

All new ops (six previews + two definition queries + two list queries) are exported from [`operations/__init__.py`](backend/app/operations/__init__.py) and added to `__all__`.

### Backend — routes in `backend/app/main.py`

Navigator lists (GET, `require_session`, in the `# --- Schema introspection ---` block, mirroring `/objects`):

```
GET  /api/{connection_id}/{database}/{schema}/functions   -> [{name, signature, isProcedure}]
GET  /api/{connection_id}/{database}/{schema}/types       -> [{name}]
```

Edit-prefill reads and previews (POST, `require_csrf`, in a new `# --- DDL (function/type) ---` block, following phase-1's per-phase preview pattern — POST+CSRF for symmetry even though the two reads don't mutate; the signature/spec lives in the body):

```
POST /api/{connection_id}/{database}/ddl/function-definition   body {schema, name, signature}
     -> {definition, isProcedure, signature, language}
POST /api/{connection_id}/{database}/ddl/type-definition       body {schema, name}
     -> {category, labels, attributes}
POST /api/{connection_id}/{database}/ddl/create-function       body CreateFunctionSpec    -> {sql}
POST /api/{connection_id}/{database}/ddl/drop-function         body DropFunctionSpec      -> {sql}
POST /api/{connection_id}/{database}/ddl/create-enum-type      body CreateEnumTypeSpec    -> {sql}
POST /api/{connection_id}/{database}/ddl/create-composite-type body CreateCompositeTypeSpec -> {sql}
POST /api/{connection_id}/{database}/ddl/drop-type            body DropTypeSpec          -> {sql}
POST /api/{connection_id}/{database}/ddl/alter-type-add-value  body AlterTypeAddValueSpec -> {sql}
```

Execute reuses phase-1's `POST /api/{connection_id}/ddl/execute`. Each handler resolves the pool via `session_pool_for`, constructs the op, `await op.apply()`, `return op.get_result()` — the established thin-route shape.

### Frontend — `frontend/src/contract.ts`

```ts
// Extend the union (append; do not rewrite):
export type DbObjectKind =
    | "database" | "schema" | "table" | "view" | "materializedView"
    | "function" | "type";

// Extend DbObjectRef with the function identity signature (set only on function leaves):
export interface DbObjectRef {
    connectionId: string;
    database?: string;
    schema?: string;
    name?: string;
    kind: DbObjectKind;
    signature?: string;   // pg_get_function_identity_arguments — disambiguates overloads
}

export interface FunctionListItem { name: string; signature: string; isProcedure: boolean; }
export interface FunctionDefinition { definition: string; isProcedure: boolean; signature: string; language: string; }
export interface TypeDefinition {
    category: "enum" | "composite";
    labels: string[];
    attributes: { name: string; type: string }[];
}

// Preview specs (mirror the backend op inputs):
export interface FunctionArgSpec { type: string; name?: string; mode?: string; default?: string; }
export interface CreateFunctionSpec {
    schema: string; name: string; kind: "function" | "procedure";
    args: FunctionArgSpec[]; language: string; body: string;
    returns?: string; volatility?: string; replace: boolean;
}
export interface DropFunctionSpec { schema: string; name: string; kind: "function" | "procedure"; signature: string; cascade: boolean; ifExists: boolean; }
export interface CreateEnumTypeSpec { schema: string; name: string; labels: string[]; }
export interface CreateCompositeTypeSpec { schema: string; name: string; attributes: { name: string; type: string }[]; }
export interface DropTypeSpec { schema: string; name: string; cascade: boolean; ifExists: boolean; }
export interface AlterTypeAddValueSpec { schema: string; name: string; value: string; position?: { placement: "before" | "after"; label: string }; }
```

`DdlPreview` (`{ sql }`) and `QueryStatusResult` are phase-1 / existing — reused, not redefined.

### Frontend — `frontend/src/data/api.ts`

```ts
// Navigator lists:
export function getFunctions(connectionId, database, schema): Promise<FunctionListItem[]>;  // GET …/functions
export function getTypes(connectionId, database, schema): Promise<{ name: string }[]>;       // GET …/types

// Edit prefill:
export function getFunctionDefinition(ref: DbObjectRef, signature: string): Promise<FunctionDefinition>;  // POST …/ddl/function-definition
export function getTypeDefinition(ref: DbObjectRef): Promise<TypeDefinition>;                              // POST …/ddl/type-definition

// Previews (each -> DdlPreview.sql via the module-private postJson):
export function previewCreateFunction(ref, spec: CreateFunctionSpec): Promise<DdlPreview>;
export function previewDropFunction(ref, spec: DropFunctionSpec): Promise<DdlPreview>;
export function previewCreateEnumType(ref, spec: CreateEnumTypeSpec): Promise<DdlPreview>;
export function previewCreateCompositeType(ref, spec: CreateCompositeTypeSpec): Promise<DdlPreview>;
export function previewDropType(ref, spec: DropTypeSpec): Promise<DdlPreview>;
export function previewAlterTypeAddValue(ref, spec: AlterTypeAddValueSpec): Promise<DdlPreview>;
```

`executeDdl` (phase-1) is reused unchanged. The prefill POSTs and previews all send CSRF via the existing `csrfHeader()` inside `postJson`.

### Frontend — form components under `frontend/src/dock/` (class-first)

Each form is a mountable `Component`/`Container` ([`COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md)) passed as `openSqlPreviewDialog`'s `form`. It exposes a `getSpec()` returning the matching contract spec and (for auto-regenerate, optional) a change signal. **None embed a `CodeEditor`** — the function body and all SQL are edited in phase-1's preview editor, so the forms use only `TextField`/`ComboBox`/`Checkbox`/repeating-row inputs (no `Event.addSubtreeListener` needed; that memory applies only to embedded CodeEditor/MarkdownEditor keydowns). Lean on library defaults — no pinned sizes (memory _Prefer library defaults_).

```ts
// frontend/src/dock/FunctionForm.ts
export class FunctionForm extends Container {
    constructor(init: { schema: string; edit?: FunctionDefinition });
    getSpec(): CreateFunctionSpec;   // body is a language stub for create; edit seeds the preview from the definition
}
// frontend/src/dock/EnumTypeForm.ts
export class EnumTypeForm extends Container {   // repeating label rows
    constructor(init: { schema: string });
    getSpec(): CreateEnumTypeSpec;
}
// frontend/src/dock/CompositeTypeForm.ts
export class CompositeTypeForm extends Container {   // repeating (name, type) rows
    constructor(init: { schema: string; prefill?: { name: string; type: string }[] });
    getSpec(): CreateCompositeTypeSpec;
}
// frontend/src/dock/AddEnumValueForm.ts
export class AddEnumValueForm extends Container {
    constructor(init: { schema: string; name: string; existingLabels: string[] });
    getSpec(): AlterTypeAddValueSpec;
}
// frontend/src/dock/DropDdlForm.ts  — shared by drop-function and drop-type
export class DropDdlForm extends Container {   // CASCADE + IF EXISTS checkboxes + a read-only "what will be dropped" line
    constructor(init: { summary: string });
    getFlags(): { cascade: boolean; ifExists: boolean };
}
```

### Frontend — `frontend/src/SqlAdminController.ts` (new launch methods)

```ts
createFunction(ref: DbObjectRef): void;              // schema-node action
editFunction(ref: DbObjectRef): void;                // function-leaf action (prefill via pg_get_functiondef)
dropFunction(ref: DbObjectRef): void;                // function-leaf action
createType(ref: DbObjectRef, category: "enum" | "composite"): void;  // schema-node submenu
editType(ref: DbObjectRef): void;                    // type-leaf: introspect, route enum->add-value / composite->recreate
dropType(ref: DbObjectRef): void;                    // type-leaf action
```

Each builds the relevant form, calls `openSqlPreviewDialog({ title, form, generateSql, execute: sql => executeDdl(this.connectionId, sql), onSuccess, onError })`, and on success calls the navigator `refresh()` seam ([`NavigatorTree.refresh()`](frontend/src/navigator/NavigatorTree.ts#L195)) and reports via the status bar. Errors funnel to `notifyError`.

---

## Internal Structure

### `create_routine` assembly

Lines joined with `\n` (no trailing `;` — matches `pg_get_functiondef`/`pg_get_viewdef` and sidesteps the extended-protocol multi-statement rule):

```
CREATE [OR REPLACE] {FUNCTION|PROCEDURE} <qualify(schema,name)>(<", ".join(render_function_arg)>)
[RETURNS <returns>]          # function only, when returns is set
 LANGUAGE <language>
[<volatility>]               # function only, when set
AS <_dollar_quote(body)>
```

`render_function_arg(FunctionArg("integer", name="a", mode="IN", default="0"))` → `IN "a" integer DEFAULT 0`. Order is mode, then quoted name (omitted when `None`), then raw type, then `DEFAULT expr` (omitted when `None`). `mode` is upper-cased and validated against `{IN, OUT, INOUT, VARIADIC}` (else `ValidationError` — a mode is a keyword, not passthrough). Procedures ignore `returns`/`volatility`.

### `create_composite_type` / `create_enum_type` layout

Enum on one line; composite one attribute per indented line:

```
CREATE TYPE "public"."addr" AS (
    "street" text,
    "zip" varchar(10)
)
```

### Preview op shape (mirrors phase-1 `DdlPreview`)

```python
class CreateEnumTypePreview(DdlPreview):
    def __init__(self, conn, spec: dict) -> None:
        schema, name = spec.get("schema", ""), spec.get("name", "")
        if not schema or not name:
            raise ValidationError("schema and name are required")
        self._schema, self._name = schema, name
        self._labels = list(spec.get("labels", []))
        self._sql = None
    def build(self) -> None:
        self._sql = create_enum_type(self._schema, self._name, self._labels)
```

`AlterTypeAddValuePreview.__init__` additionally raises `ValidationError` when `value` is empty (an enum label may not be `''`). The other previews validate only the identifier fields; labels/attrs/body/signature pass through (Postgres is the final arbiter, per the trust model).

### `FunctionDefinitionQuery.apply()` (overload-safe lookup)

Build the qualified signature text `f"{qualify(schema, name)}({signature})"` in Python and bind it, casting to `regprocedure` to resolve the exact overload:

```sql
SELECT pg_get_functiondef(p.oid) AS definition,
       p.prokind = 'p'           AS is_procedure,
       pg_get_function_identity_arguments(p.oid) AS signature,
       l.lanname                 AS language
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_language l ON l.oid = p.prolang
WHERE p.oid = $1::regprocedure
```

`$1` = the qualified-signature text. `get_result` returns `NotFound` when the row is absent (mirrors `ViewDefinitionQuery`). (`pg_get_functiondef` supports both functions and procedures on PG 16.)

### Navigator wiring

- `OBJECT_CATEGORIES` gains `{ label: "Functions", kind: "function" }` and `{ label: "Types", kind: "type" }` (appended after Materialized Views).
- `loadObjects` fetches all three sources in parallel: `Promise.all([getObjects(...), getFunctions(...), getTypes(...)])`, then builds a combined `DbObject[]` where each function item carries `signature` (and the leaf's `DbObjectRef.signature`) and type items carry `kind: "type"`. `DbObject`/`objectLeaf` extend to carry the optional `signature`. `categoryNode` filters by kind unchanged.
- `isRelation` is **not** widened — functions/types don't open a data tab, so double-click stays a no-op and selection routes to `showProperties`, which already handles non-relation kinds by calling `properties.show(ref)` ([`SqlAdminController.showProperties`](frontend/src/SqlAdminController.ts#L1250)); no change there.
- The `contextmenu` handler gains two branches (after the schema branch, before the `isRelation` guard): a `kind === "function"` branch (`Edit function`, `Drop function`) and a `kind === "type"` branch (`Edit type`, `Drop type`). The existing **schema** branch gains `Create function` and a `Create type` submenu (`Enum`, `Composite`).

### `KIND_GLYPH` / glyph registration

Register `code` (functions) and `cube` (types) — both confirmed present in the library's `glyphs/solid` set — via per-glyph subpath imports (the barrel is banned, see [LIBRARY_NOTES](LIBRARY_NOTES.md#L858)): `import { code } from "@jimka/typescript-ui/glyphs/solid/code";` etc., add them to the `Glyph.register(...)` call, and add `function: "code"`, `type: "cube"` to `KIND_GLYPH`.

---

## Ordered Implementation Steps

1. **`backend/app/sql/ddl.py`** — append the dataclasses (`FunctionArg`, `CompositeAttr`, `CreateRoutineSpec`), `_dollar_quote`, `render_function_arg`, `create_routine`, `drop_routine`, `create_enum_type`, `create_composite_type`, `drop_type`, `alter_type_add_value` per _Public API_/_Internal Structure_. Reuse the module's existing `quote_ident`/`qualify`/`quote_literal`. Pure, no DB.

2. **`backend/tests/test_ddl_function_type_sql.py`** — new. Unit-test every builder and `render_function_arg`/`_dollar_quote` against the _Expected Behaviour_ cases (`test_compiler.py` pure style). Include the dollar-tag-collision case (body containing `$function$` → falls to `$func_1$`).

3. **`backend/app/operations/function_definition.py`** & **`type_definition.py`** — new `Query` subclasses per _Public API_, mirroring `view_definition.py` (`_raw` fetched in `apply`, `NotFound` on empty in `get_result`).

4. **`backend/app/operations/list_functions.py`** & **`list_types.py`** — new `Query` subclasses per _Public API_, mirroring `list_objects.py`.

5. **`backend/app/operations/ddl_function_type.py`** — new. The six `DdlPreview` subclasses per _Internal Structure_. Import `DdlPreview` from `.ddl` (phase-1) and the builders from `..sql.ddl`.

6. **`backend/app/operations/__init__.py`** — import and add to `__all__`: the six previews, `FunctionDefinitionQuery`, `TypeDefinitionQuery`, `ListFunctionsQuery`, `ListTypesQuery`. (Append — do not disturb phase-1's `DdlPreview`/`ExecuteDdlCommand` exports.)

7. **`backend/tests/test_ddl_function_type_ops.py`** — new. `NO_CONN` pure-logic style: each preview built with a valid spec → `get_result()` returns `{"sql": …}` matching the builder; each raises `ValidationError` on empty `schema`/`name`; `AlterTypeAddValuePreview` raises on empty `value`; `get_result()` before `build()` raises `RuntimeError`. Hand-set `_raw` on the definition/list queries and assert `get_result` shapes (+ `NotFound` on empty for the definition queries).

8. **`backend/app/main.py`** — import the new ops; add the two GET list routes in `# --- Schema introspection ---`; add a `# --- DDL (function/type) ---` section with the two prefill POSTs and six preview POSTs (`Depends(require_csrf)`, `body: dict = Body(...)`, resolve pool, construct op, `apply`, return `get_result`).

9. **`frontend/src/contract.ts`** — extend `DbObjectKind` and `DbObjectRef`; add the list/definition/spec interfaces per _Public API_.

10. **`frontend/src/data/api.ts`** — add `getFunctions`, `getTypes`, `getFunctionDefinition`, `getTypeDefinition`, and the six `preview*` methods; import the new contract types.

11. **`frontend/src/navigator/objectGlyphs.ts`** — import `code`/`cube` glyphs, add to `Glyph.register(...)`, add `function`/`type` to `KIND_GLYPH`.

12. **`frontend/src/dock/`** — add `FunctionForm.ts`, `EnumTypeForm.ts`, `CompositeTypeForm.ts`, `AddEnumValueForm.ts`, `DropDdlForm.ts` per _Public API_ (class-first; no CodeEditor; no pinned sizes).

13. **`frontend/src/SqlAdminController.ts`** — add the six launch methods per _Public API_, each embedding a form in `openSqlPreviewDialog` and refreshing the navigator on success. `editFunction`/`editType` fetch the definition first and seed the preview from it.

14. **`frontend/src/navigator/NavigatorTree.ts`** — append the two `OBJECT_CATEGORIES` entries; extend `DbObject`/`objectLeaf`/`loadObjects` to fetch + carry functions (with `signature`) and types; add the function/type context-menu branches and the schema-node `Create function`/`Create type` items, wired to the controller methods.

15. **Regression checkpoints:**
    - `cd backend && poetry run pytest tests/test_ddl_function_type_sql.py tests/test_ddl_function_type_ops.py` — green.
    - `grep -rn "ListFunctionsQuery\|ListTypesQuery\|CreateFunctionPreview" backend/app/operations/__init__.py` — exported.
    - `grep -rn "/ddl/create-function\|/functions\|/types" backend/app/main.py frontend/src/data/api.ts` — routes + clients present.
    - `grep -rn "\"function\"\|\"type\"" frontend/src/navigator/objectGlyphs.ts frontend/src/contract.ts` — kinds registered.
    - `cd frontend && npm run typecheck` — clean.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `backend/app/sql/ddl.py` (append function/type builders) |
| Create | `backend/app/operations/function_definition.py` |
| Create | `backend/app/operations/type_definition.py` |
| Create | `backend/app/operations/list_functions.py` |
| Create | `backend/app/operations/list_types.py` |
| Create | `backend/app/operations/ddl_function_type.py` |
| Modify | `backend/app/operations/__init__.py` (export new ops) |
| Modify | `backend/app/main.py` (10 new routes) |
| Create | `backend/tests/test_ddl_function_type_sql.py` |
| Create | `backend/tests/test_ddl_function_type_ops.py` (the six preview ops only) |
| Create (as-built) | `backend/tests/test_function_definition.py`, `test_type_definition.py`, `test_list_functions.py`, `test_list_types.py` — one file per op module, matching the codebase's existing `test_view_definition.py`/`test_list_objects.py` convention, rather than folding all four into `test_ddl_function_type_ops.py` as originally sketched |
| Modify | `frontend/src/contract.ts` (kinds, ref.signature, specs) |
| Modify | `frontend/src/data/api.ts` (list/prefill/preview clients) |
| Modify | `frontend/src/navigator/objectKinds.ts` (append `function`/`type` registry entries) |
| Modify | `frontend/src/navigator/objectGlyphs.ts` (glyphs) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (categories + menus + load) |
| Modify | `frontend/src/properties/PropertiesPanel.ts` (function/type rows — exhaustiveness) |
| Modify | `frontend/src/SqlAdminController.ts` (launch methods) |
| Modify | `frontend/src/dock/ddlSpecs.ts` (this phase's spec-assembly helpers — see Drift notes) |
| Create | `frontend/src/dock/FunctionForm.ts` |
| Create | `frontend/src/dock/EnumTypeForm.ts` |
| Create | `frontend/src/dock/CompositeTypeForm.ts` |
| Create | `frontend/src/dock/AddEnumValueForm.ts` |
| Not created (as-built) | `frontend/src/dock/DropDdlForm.ts` — drop-function/drop-type reuse the existing `ConfirmCascadeForm` instead; see Drift notes |

---

## Expected Behaviour

### Backend — unit-testable (pure builders / `NO_CONN` ops)

Builders (`test_ddl_function_type_sql.py`):

- **Create plpgsql function with args + return** — `create_routine(CreateRoutineSpec(schema="public", name="add", kind="function", args=[FunctionArg("integer", name="a", mode="IN"), FunctionArg("integer", name="b", mode="IN")], language="plpgsql", body="BEGIN\n  RETURN a + b;\nEND;", returns="integer", volatility="IMMUTABLE", replace=False))` →
  ```
  CREATE FUNCTION "public"."add"(IN "a" integer, IN "b" integer)
  RETURNS integer
   LANGUAGE plpgsql
  IMMUTABLE
  AS $function$
  BEGIN
    RETURN a + b;
  END;
  $function$
  ```
- **Create-or-replace (builder path)** — same spec with `replace=True` → identical output prefixed `CREATE OR REPLACE FUNCTION …`. (The *prefill-from-`pg_get_functiondef`* variant is manual-verify — it is a DB read seeded into the editor.)
- **Create procedure** — `kind="procedure"` → no `RETURNS`/volatility lines, `CREATE PROCEDURE …`.
- **Argument rendering** — `render_function_arg(FunctionArg("numeric(10,2)", name="amt", mode="INOUT", default="0"))` → `INOUT "amt" numeric(10,2) DEFAULT 0`; no name → `integer`; `VARIADIC "vals" integer[]`.
- **Dollar-tag collision** — body containing `$function$` → wrapped in `$func_1$`.
- **Drop function with signature + cascade** — `drop_routine("public", "add", "function", "integer, integer", cascade=True, if_exists=False)` → `DROP FUNCTION "public"."add"(integer, integer) CASCADE`; `if_exists=True` inserts `IF EXISTS`; `kind="procedure"` → `DROP PROCEDURE …`; empty signature → `…"add"() …`.
- **Create enum type** — `create_enum_type("public", "mood", ["sad", "ok", "happy"])` → `CREATE TYPE "public"."mood" AS ENUM ('sad', 'ok', 'happy')`; a label with a quote (`"o'k"`) → `'o''k'`.
- **Create composite type** — `create_composite_type("public", "addr", [CompositeAttr("street", "text"), CompositeAttr("zip", "varchar(10)")])` → the indented multi-line form above.
- **Drop type** — `drop_type("public", "mood", cascade=True, if_exists=True)` → `DROP TYPE IF EXISTS "public"."mood" CASCADE`.
- **Alter type add value** — `alter_type_add_value("public", "mood", "great", ("after", "happy"))` → `ALTER TYPE "public"."mood" ADD VALUE 'great' AFTER 'happy'`; `position=None` → no `BEFORE`/`AFTER`; `("before", "sad")` → `BEFORE 'sad'`.

Preview ops / queries (`test_ddl_function_type_ops.py`):

- Each preview built with a valid spec → `get_result()` == `{"sql": <builder output>}`.
- Empty `schema` or `name` in any create/drop spec → `ValidationError`; empty `value` in the add-value spec → `ValidationError`.
- `get_result()` before `apply()`/`build()` → `RuntimeError` (phase-1 base contract).
- `FunctionDefinitionQuery` with hand-set `_raw = [{...}]` → `{"definition", "isProcedure", "signature", "language"}`; `_raw = []` → `NotFound`.
- `TypeDefinitionQuery` with hand-set enum `_raw` → `{"category": "enum", "labels": [...], "attributes": []}`; composite → `{"category": "composite", "labels": [], "attributes": [...]}`; empty → `NotFound`.
- `ListFunctionsQuery`/`ListTypesQuery` with hand-set `_raw` → the documented list shapes.

### Backend — integration (manual, DB up)

- `POST /api/default/default/public/ddl/create-function` with a valid plpgsql spec → `{sql}`; `POST /api/default/ddl/execute` with it → `{"kind":"status","command":"CREATE FUNCTION","rowCount":0}`. Re-run the create with `replace=True` → `CREATE OR REPLACE` succeeds.
- `POST …/ddl/function-definition` for that function → its `pg_get_functiondef` text + `isProcedure:false`.
- `DROP FUNCTION … (integer, integer) CASCADE` via execute → `{"command":"DROP FUNCTION"}`; drop of a missing function without `IF EXISTS` → 400 with the Postgres detail.
- Create an enum then `ALTER TYPE … ADD VALUE 'great' AFTER 'happy'` via execute → succeeds (PG 16, transaction-safe). Create a composite; drop it with `CASCADE`.
- Missing/invalid CSRF on any preview/execute → 403.

### Frontend — manual-verify (node harness can't drive dialogs/editor/tree)

- The navigator shows **Functions** (glyph `code`) and **Types** (glyph `cube`) categories under a schema that has them; empty categories are omitted (existing `categoryNode` behaviour).
- Right-click a **schema** → `Create function` and `Create type ▸ Enum | Composite`; each opens the shared preview dialog with the scaffolded SQL seeded and an empty/stub body the user fills in the editor before Execute.
- Right-click a **function** leaf → `Edit function` seeds the editor with `pg_get_functiondef` (body editable in place); `Drop function` opens the drop form (CASCADE/IF EXISTS) with the function's signature shown.
- Right-click a **type** leaf → `Edit type` introspects and opens the enum add-value form (existing labels shown) or the composite recreate form (attributes prefilled); `Drop type` opens the drop form.
- Execute success refreshes the navigator (new/removed object appears/disappears) and reports on the status bar; a Postgres error (e.g. `cannot change return type`) keeps the dialog open with the SQL intact (phase-1 dialog behaviour).
- Editing the previewed SQL then Execute runs the **edited** text (phase-1 authoritative-preview behaviour).

---

## Verification

- **Backend unit:** `cd backend && poetry run pytest tests/test_ddl_function_type_sql.py tests/test_ddl_function_type_ops.py`, then full `poetry run pytest` for no regressions.
- **Backend integration (DB up):** `docker compose up -d db`, app running; exercise the integration cases above (create/replace/drop a function; create enum + add value; create/drop composite; a denied and a bad statement; a missing-CSRF call).
- **Frontend:** `cd frontend && npm run typecheck && npm test`. The forms/dialog/navigator flows are **manual** (drive the schema/function/type context menus in the running app per _Expected Behaviour_) — state this so `/implement` substitutes a documented manual smoke test for the UI, not an automated one.
- **Grep invariants** per step 15.

---

## Potential Challenges

- **Overloaded-function lookup** — resolving the wrong oid drops/edits the wrong overload. Mitigation: `FunctionDefinitionQuery` and every drop use the full identity signature via `::regprocedure`; the signature is carried on the navigator leaf's `DbObjectRef.signature` from `ListFunctionsQuery`, never re-derived.
- **Dollar-quote collision in a function body** — a body literally containing `$function$` would break naive wrapping. Mitigation: `_dollar_quote` scans and picks an unused tag; unit-tested.
- **Regenerate-vs-manual-body-edit race (create function)** — the create form seeds a stub body; a form `Regenerate SQL` after the user edited the body in the preview discards those body edits (phase-1's documented editable-preview-vs-regeneration tension). Mitigation: seed once; document the Regenerate caveat in the form; for **edit** the seed is the full `pg_get_functiondef`, so there is no stub to clobber.
- **Composite in-place restructure looks available but isn't** — a user editing a composite may expect attribute changes to apply. Mitigation: the composite edit path is recreate/clone only; the dialog SQL is a `CREATE TYPE` the user must reconcile with the existing type (or drop first). Called out as a Non-Goal.
- **Two extra round-trips per schema expansion** — `loadObjects` now fans out to `/objects`, `/functions`, `/types`. Mitigation: parallel `Promise.all`; acceptable, and errors surface via the existing `loaderror` → `notifyError`.
- **Coarse navigator refresh** — as in phase-1, a successful DDL calls the full `NavigatorTree.refresh()`; a per-branch reload remains a noted `Tree` library gap, not built here.

---

## Critical Files

- [`plans/ddl-infrastructure.md`](plans/ddl-infrastructure.md) — the shared seams this phase extends (read first).
- [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py) — phase-1 builder module (`qualify`, `quote_literal`, `quote_ident`); this phase appends to it.
- [`backend/app/operations/ddl.py`](backend/app/operations/ddl.py) — phase-1 `DdlPreview` base + `ExecuteDdlCommand` (the two-phase preview shape and the single execute op).
- [`backend/app/operations/view_definition.py`](backend/app/operations/view_definition.py) — the definition-query pattern the two new definition queries mirror.
- [`backend/app/operations/list_objects.py`](backend/app/operations/list_objects.py) — the list-query pattern (read but **not** modified; separate queries instead).
- [`backend/app/operations/run_query.py`](backend/app/operations/run_query.py) — the status-envelope/trust-model precedent; `_affected` (reused by phase-1's execute).
- [`backend/app/main.py`](backend/app/main.py) — thin-route shape, `require_session`/`require_csrf`, `session_pool_for`, `_pg_error_handler`.
- [`backend/tests/test_view_definition.py`](backend/tests/test_view_definition.py) + [`conftest.py`](backend/tests/conftest.py) — the `NO_CONN` / hand-set-`_raw` test style.
- [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts) — phase-1 `openSqlPreviewDialog` every form embeds into.
- [`frontend/src/dock/DefinitionPanel.ts`](frontend/src/dock/DefinitionPanel.ts) + [`QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — the `CodeEditor` construction/disposal pattern (the preview editor is the body-edit surface).
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) + [`objectGlyphs.ts`](frontend/src/navigator/objectGlyphs.ts) — the `OBJECT_CATEGORIES`/context-menu and glyph-registry seams (shared with phase-4).
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — `showProperties` (already handles non-relation kinds), `notifyError`, `refresh` seam, the launch-method home.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — class-first form components.

---

## Non-Goals

- **No tables / views / matviews / schemas / sequences** — those are the other four DDL phases. This phase adds only functions/procedures and enum/composite types.
- **No in-place composite-type restructuring** (`ALTER TYPE … ADD/DROP/ALTER ATTRIBUTE`) — multi-statement and dependency-fraught; composite edits are recreate/clone or drop only. Possible future work.
- **No multi-statement drop-recreate for signature-changing function edits** — `CREATE OR REPLACE` is single-statement; a rejected replace is resolved by the user in the editable preview or via the separate Drop action (phase-1's one-statement-per-execute rule).
- **No triggers, operators, aggregates, window functions, domains, ranges, or extensions** — out of scope; each is a distinct catalog/DDL surface and a possible future phase. (`prokind` filtering lists only plain functions `'f'` and procedures `'p'`, excluding aggregates/window functions.)
- **No UI privilege pre-flighting** — actions launch unconditionally; Postgres enforces ownership/`CREATE`/`USAGE` and the error surfaces on Execute (phase-1 posture).
- **No change to phase-1's execute op/route, `SqlPreviewDialog`, `RunQueryCommand`, or `/query`** — reused as-is.
- **No modification of `ListObjectsQuery`/`/objects`** — functions and types use dedicated queries/routes so the objects contract stays stable.
