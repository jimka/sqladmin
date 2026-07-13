---
depends-on: [ddl-infrastructure]
touches-shared:
  - backend/app/operations/list_objects.py
  - backend/app/operations/__init__.py
  - backend/app/main.py
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/navigator/objectGlyphs.ts
  - frontend/src/data/api.ts
  - frontend/src/contract.ts
  - frontend/src/properties/PropertiesPanel.ts
---

# Schema & Sequence DDL — Implementation Plan

## Overview

Phase 4 of the phased DDL feature set (foundation: [`plans/ddl-infrastructure.md`](plans/ddl-infrastructure.md)). It adds structured **CREATE / DROP / ALTER for schemas and sequences**, reusing every shared seam phase 1 built: the [`ddl.py`](backend/app/sql/ddl.py) SQL-builder module, the [`DdlPreview`](backend/app/operations/ddl.py) preview base and the single [`ExecuteDdlCommand`](backend/app/operations/ddl.py) + [`POST /api/{connection_id}/ddl/execute`](backend/app/main.py) route, the reusable [`openSqlPreviewDialog`](frontend/src/dock/SqlPreviewDialog.ts), the [`executeDdl`](frontend/src/data/api.ts) client, and the navigator context-menu + [`refresh()`](frontend/src/navigator/NavigatorTree.ts#L195) seams. This plan does **not** redefine any of those — it adds this phase's builder functions, preview-op subclasses, per-phase preview routes/clients, dialog forms, and navigator actions.

Sequences are **not listed anywhere today** — the navigator only surfaces tables/views/matviews via [`ListObjectsQuery`](backend/app/operations/list_objects.py) (a `TODO.md` backlog item, "More navigator object types"). So this plan also introduces a new **object kind** `"sequence"` end-to-end: the listing query gains a sequence fragment, the wire kind union gains `"sequence"`, and the navigator gains a Sequences category, a glyph, a Properties row-set, and a context menu. Because the phase-5 function/type plan adds *another* kind through the same files, this plan converts the hardcoded per-kind branches into a **kind registry** so a sibling phase adds one entry instead of editing the same lines (see _Architecture Decisions → Kind registry seam_).

Schemas are database-scoped (create on a database node; rename/drop on a schema node). Sequences are schema-scoped (create on a schema node; alter/drop on a sequence leaf).

---

## Drift notes (as-built, found before implementation)

- **No database-level navigator node exists.** `NavigatorTree`'s top level *is*
  the logged-in database's schemas directly (there is no database node to
  right-click) — see its own header comment and how "Show database diagram"
  is already offered from the **schema** node's context menu, synthesizing a
  database ref from the schema's own ref. "Create schema…" follows that exact
  precedent: it is added to the **schema** node's context menu (not a
  separate database node), synthesizing `{connectionId, database, kind:
  "database"}` the same way the existing diagram item does.
- **Spec interfaces live in `contract.ts`, not a new `dock/ddlSpecs.ts`.**
  Both `table-ddl` and `view-matview-ddl` put their `*Spec` wire interfaces
  directly in `frontend/src/contract.ts` (e.g. `CreateTableSpec`,
  `CreateViewSpec`). `frontend/src/dock/ddlSpecs.ts` already exists from
  `table-ddl` — but as a module of **pure spec-assembly helper functions**
  (form fields -> wire spec, e.g. `buildCreateTableSpec`), not type
  definitions. This plan follows the established split: the seven `*Spec`
  interfaces go in `contract.ts`; this phase's own assembly helpers
  (`buildCreateSchemaSpec`, `buildAlterSequenceSpec`, etc.) are **added to**
  the existing `ddlSpecs.ts` rather than a new file.
- **No fetch-shape tests are added for the seven `preview*` clients.** Neither
  `table-ddl` nor `view-matview-ddl` added such tests to
  `frontend/tests/data/api.test.ts` despite that suite already testing
  `api.ts` (only `executeDdl` and the pre-existing endpoints are covered) —
  they're thin `postJson` wrappers whose shape is already exercised by
  `executeDdl`'s test and the pure `ddlSpecs.test.ts` helpers. This phase
  follows that precedent instead of introducing new coverage there.
- **`PropertiesPanel`'s sequence rows are not built via `tableRows`/
  `relationTypeLabel`.** Those helpers are relation-only (their `Type` label
  logic only distinguishes table/view/materializedView) and a sequence is not
  a relation (`isRelation: false`). The `"sequence"` case returns its own
  small inline Name/Schema/Database/Type row-set instead of extending
  `relationTypeLabel`'s signature.
- **`SequenceOwnerPreview`/`previewSequenceOwner` ship with no dedicated
  navigator menu item.** Per _Architecture Decisions_' "parameter form and
  OWNER TO are separate statements", the Alter-sequence dialog offers a
  Parameters/Owner mode toggle rather than a second context-menu entry; it is
  implemented with the library's `Card` layout (one visible child by id) to
  swap the two field groups, driven by a `ComboBox`.
- **Drop-schema/drop-sequence reuse the existing `ConfirmCascadeForm`** (a
  summary line + CASCADE checkbox only) exactly as drop-table/drop-index
  already do — those dialogs never surface `ifExists` in the UI either, even
  though the backend param exists, so this phase doesn't introduce a new UI
  idiom for it.
- **`api.ts` preview-client signatures are `(ref: DbObjectRef, spec)`, not
  `(conn: string, db: string, spec)`** as originally drafted in _Public API_
  below — every pre-existing `preview*` client (`previewCreateView`, etc.)
  already takes a `DbObjectRef`, and the seven new clients match that real
  convention instead of the plan's inaccurate sketch.
- **`SchemaDdlForms.ts`/`SequenceDdlForms.ts` openers take one flattened
  `deps` object** (`preview`/`execute`/`onSuccess`/`onError` plus the target
  identifiers), not the plan's originally drafted `(ref, deps)` with a nested
  `deps: { connectionId, executeDdl, onSuccess, onError }` shape — this
  matches the pre-existing `RelationDdlActions.ts` idiom (`DropDialogDeps`/
  `RefreshDialogDeps`) exactly.

---

## Downstream / sibling coordination

Phase 5 (`function-type-ddl.md`) adds kinds `"function"`/`"type"` through the **same** `touches-shared` files. This plan establishes the registry seam that phase must append to; it is ordered after phase 1 and is independent of phases 2–3 (tables, views) except for the shared files, which `/implement` serializes.

---

## Architecture Decisions

### Extend `ListObjectsQuery` with a composed fragment list — not a new endpoint

Sequences are listed by **extending `ListObjectsQuery`** to `UNION ALL` a sequence fragment, tagging rows `kind: "sequence"`. Rationale: the navigator already fans one `/objects` call per schema into categories ([`loadObjects`](frontend/src/navigator/NavigatorTree.ts#L232)); a new kind rides that one round-trip and one code path with no new route, exactly as the existing matview fragment does. A separate `ListSequencesQuery`/endpoint would force `loadObjects` to merge two fetches and duplicate the category machinery for no benefit.

To keep this addition low-conflict with phase 5 (which unions functions the same way), the single `_SQL` string is refactored into a **tuple of per-kind SELECT fragments** joined by `UNION ALL` (see _Internal Structure_). Each phase appends one fragment element — a distinct, additive line rather than an edit to one shared string.

The sequence fragment mirrors the existing matview fragment exactly (both read `pg_catalog.pg_class` by `relkind`), so the pattern is already in the file: matviews are `relkind = 'm'`, sequences are `relkind = 'S'`. Using `pg_class` (not `information_schema.sequences`) matches the matview precedent and lists every sequence in the schema regardless of the `information_schema` privilege-visibility quirks.

### Kind registry seam — one entry per new kind, derived everywhere

Today the frontend hardcodes each `DbObjectKind` in four places: [`KIND_GLYPH`](frontend/src/navigator/objectGlyphs.ts#L20) (a `Record<DbObjectKind, string>`), [`OBJECT_CATEGORIES`](frontend/src/navigator/NavigatorTree.ts#L30), [`isRelation`](frontend/src/navigator/NavigatorTree.ts#L41), and the [`propertyRows` switch](frontend/src/properties/PropertiesPanel.ts#L27). Two phases each adding a kind would collide on those lines. This plan introduces **`frontend/src/navigator/objectKinds.ts`**, an ordered registry keyed by kind carrying `{ glyph, categoryLabel?, isRelation }`, and refactors `KIND_GLYPH`, `OBJECT_CATEGORIES`, and `isRelation` to *derive* from it. Adding a kind then means appending **one registry entry** (a distinct line) — phase 5 appends its own with no conflict.

`KIND_GLYPH` stays exported (its `Record<DbObjectKind, string>` shape is consumed across the controller and dock tabs) but is *built from* the registry, so it remains type-exhaustive automatically. The `propertyRows` switch is data-bearing (each kind renders different rows) and stays a switch, but adding `"sequence"` to the `DbObjectKind` union makes the switch non-exhaustive → **a typecheck error the implementer must resolve** by adding a `"sequence"` case (this is the compiler enforcing the seam — good).

### Server-generated SQL, editable preview authoritative at execute (inherited)

Unchanged from phase 1: each preview op validates identifiers via `quote_ident`/`qualify`, builds the SQL server-side, and returns `{ "sql": ... }`; the user reviews/edits it in `openSqlPreviewDialog`'s editor; **Execute runs the edited string** through the shared `ExecuteDdlCommand`. No spec is recompiled at execute. Identifiers are always quoted; numeric options are validated as integers before rendering (see next).

### Numeric options validated as integers, not passed through as expressions

Sequence numeric options (`increment`, `start`, `min`/`max`, `cache`, `restart`) are **not** free-form SQL fragments — they are integers. Each preview op **coerces every provided numeric to `int` in `__init__`, raising `ValidationError` on a non-integer**, and the builder renders `str(int(v))`. This is stricter than phase 1's "expressions pass through" posture and is correct: these grammar slots only accept integer literals, so validating them closes the fragment-injection surface entirely for sequences (there are no free-form expression slots here). Identifiers (schema/name/owner/owned-by column) go through `quote_ident`/`qualify` as always.

### `ALTER SEQUENCE`: parameter form and `OWNER TO` are separate statements

PostgreSQL's `ALTER SEQUENCE` parameter form (`RESTART`/`INCREMENT`/`MINVALUE`/`MAXVALUE`/`CACHE`/`CYCLE`/`OWNED BY`) and its `OWNER TO new_owner` form are **distinct grammar variants** that cannot be combined in one statement, and execute runs exactly one statement. So this plan ships **two builders** — `sequence_alter(...)` (parameter form) and `sequence_set_owner(...)` (`OWNER TO`) — and the Alter dialog offers a mode toggle that generates one or the other. This keeps every generated string a single valid statement and each builder independently unit-testable.

### DDL launch actions are unconditional; Postgres enforces privileges (inherited)

Per phase 1, no UI privilege pre-flight: "Create schema", "Drop sequence", etc. are offered unconditionally; a lacking `CREATE`/ownership privilege raises a `PostgresError` → 400 that the dialog surfaces, leaving it open to retry. Object-kind gating still applies (e.g. "Create sequence" appears on a schema node, not a table).

### Refresh after success (inherited)

On a successful create/drop/rename/alter, the controller calls the navigator's [`refresh()`](frontend/src/navigator/NavigatorTree.ts#L195) (full top-level reload; lazy levels reload on next expansion). Coarse but correct, exactly as phase 1 specified; a per-branch reload remains a noted `Tree` gap, out of scope.

---

## Public API

### Backend — `backend/app/sql/ddl.py` (extend the phase-1 module)

Add these pure builders (reusing the module's `quote_ident`, `qualify`, and importing `ValidationError` from `..errors`). Each raises `ValidationError` on a blank required identifier.

```python
# --- Schemas -------------------------------------------------------------

def schema_create(name: str, authorization: str | None = None) -> str:
    """CREATE SCHEMA "name" [ AUTHORIZATION "owner" ]."""

def schema_drop(name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """DROP SCHEMA [ IF EXISTS ] "name" [ CASCADE ]."""

def schema_rename(name: str, new_name: str) -> str:
    """ALTER SCHEMA "name" RENAME TO "new_name"."""

# --- Sequences -----------------------------------------------------------

def sequence_create(
    schema: str, name: str, *,
    increment: int | None = None,
    start: int | None = None,
    min_value: int | None = None,
    max_value: int | None = None,
    cache: int | None = None,
    cycle: bool = False,
    owned_by: tuple[str, str, str] | None = None,  # (schema, table, column)
) -> str:
    """CREATE SEQUENCE "schema"."name" with the provided options, in canonical
    grammar order: INCREMENT BY, MINVALUE, MAXVALUE, START WITH, CACHE, CYCLE,
    OWNED BY. Omitted options are omitted (Postgres defaults apply); CYCLE is
    emitted only when cycle is True. owned_by renders OWNED BY
    "schema"."table"."column"."""

def sequence_alter(
    schema: str, name: str, *,
    restart: int | None = None,      # RESTART [ WITH n ]; use RESTART_DEFAULT for bare RESTART
    increment: int | None = None,
    min_value: int | None = None,
    max_value: int | None = None,
    cache: int | None = None,
    cycle: bool | None = None,       # None omits; True -> CYCLE; False -> NO CYCLE
) -> str:
    """ALTER SEQUENCE "schema"."name" <parameter form>. Raises ValidationError
    if no option is provided (an empty ALTER is meaningless)."""

def sequence_set_owner(schema: str, name: str, owner: str) -> str:
    """ALTER SEQUENCE "schema"."name" OWNER TO "owner"."""

def sequence_drop(schema: str, name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """DROP SEQUENCE [ IF EXISTS ] "schema"."name" [ CASCADE ]."""
```

`RESTART` needs a sentinel to distinguish "RESTART to the sequence's start value" (bare `RESTART`) from "RESTART WITH n". Model it as: `restart is None` omits the clause; a provided `int` renders `RESTART WITH n`; a module constant `RESTART_DEFAULT` (a distinct sentinel object) renders bare `RESTART`. The Alter dialog uses `RESTART_DEFAULT` for its "restart to start" checkbox and an int for "restart with value".

### Backend — `backend/app/operations/ddl_schema_sequence.py` (new)

This phase's `DdlPreview` subclasses (phase 1's `ddl.py` stays untouched). Each is a **pure** preview: `apply()` inherits the default (just `build()`), `__init__` validates the spec, `build()` sets `self._sql` from a builder.

```python
class SchemaCreatePreview(DdlPreview):   # spec {"name": str, "authorization"?: str}
class SchemaDropPreview(DdlPreview):     # spec {"name": str, "cascade"?: bool, "ifExists"?: bool}
class SchemaRenamePreview(DdlPreview):   # spec {"name": str, "newName": str}
class SequenceCreatePreview(DdlPreview): # spec {"schema","name","increment"?,"start"?,"minValue"?,"maxValue"?,"cache"?,"cycle"?,"ownedBy"?:{schema,table,column}}
class SequenceAlterPreview(DdlPreview):  # spec {"schema","name","restart"?|"restartDefault"?,"increment"?,"minValue"?,"maxValue"?,"cache"?,"cycle"?}
class SequenceOwnerPreview(DdlPreview):  # spec {"schema","name","owner"}
class SequenceDropPreview(DdlPreview):   # spec {"schema","name","cascade"?,"ifExists"?}
```

Each `__init__` signature is `(self, conn, spec: dict)`; it reads/validates fields off `spec` (blank name → `ValidationError`; non-int numeric → `ValidationError`) and stores the parsed values. `conn` is captured but unused (pure previews). All are exported from `operations/__init__.py`.

### Backend — routes in `backend/app/main.py`

Per-phase **preview** routes (all `Depends(require_csrf)`, body `dict = Body(...)`, `-> {"sql": str}`), placed in a new `# --- DDL: schemas & sequences ---` section near the phase-1 `# --- DDL ---` block. They resolve the pool via `session_pool_for`, construct the preview op, `await op.apply()`, `return op.get_result()`:

```
POST /api/{connection_id}/{database}/ddl/create-schema     body {name, authorization?}
POST /api/{connection_id}/{database}/ddl/drop-schema       body {name, cascade?, ifExists?}
POST /api/{connection_id}/{database}/ddl/rename-schema      body {name, newName}
POST /api/{connection_id}/{database}/ddl/create-sequence    body {schema, name, increment?, start?, minValue?, maxValue?, cache?, cycle?, ownedBy?}
POST /api/{connection_id}/{database}/ddl/alter-sequence     body {schema, name, restart?, restartDefault?, increment?, minValue?, maxValue?, cache?, cycle?}
POST /api/{connection_id}/{database}/ddl/sequence-owner     body {schema, name, owner}
POST /api/{connection_id}/{database}/ddl/drop-sequence      body {schema, name, cascade?, ifExists?}
```

Execute reuses the phase-1 shared route `POST /api/{connection_id}/ddl/execute` — **no new execute route**.

### Frontend — `frontend/src/contract.ts`

Add `"sequence"` to the kind union:

```ts
export type DbObjectKind =
    | "database" | "schema" | "table" | "view" | "materializedView" | "sequence";
```

`DdlPreview` (`{ sql: string }`) is already defined by phase 1 — reused.

### Frontend — `frontend/src/navigator/objectKinds.ts` (new — the registry)

```ts
/** One object kind's navigator metadata. `categoryLabel` groups leaves under a
 *  Sequences/Tables/… category; `isRelation` marks kinds that open in the Dock. */
export interface ObjectKindInfo {
    kind: DbObjectKind;
    glyph: string;            // registered glyph name
    categoryLabel?: string;   // present for leaf kinds shown under a category
    isRelation: boolean;      // opens a data tab + relation context menu
}

/** Ordered registry; navigator category order follows this array. Containers
 *  (database/schema) carry a glyph but no category. A new object kind adds ONE
 *  entry here (and its glyph import/registration in objectGlyphs.ts). */
export const OBJECT_KINDS: readonly ObjectKindInfo[];
```

### Frontend — `frontend/src/navigator/objectGlyphs.ts` (extend)

Register a sequence glyph and add its `KIND_GLYPH` entry; rebuild `KIND_GLYPH` from `OBJECT_KINDS`:

```ts
import { arrow_up_1_9 } from "@jimka/typescript-ui/glyphs/solid/arrow_up_1_9";
// ...register it alongside the others...
export const KIND_GLYPH: Record<DbObjectKind, string>;  // built from OBJECT_KINDS
```

Sequence glyph: `arrow_up_1_9` (registered name `"arrow-up-1-9"`), an ascending numeric arrow. `hashtag` / `list_ol` are alternatives if the ascending arrow reads poorly at 16px.

### Frontend — `frontend/src/data/api.ts` (extend)

Per-phase preview clients (all `postJson<DdlPreview>` to the routes above), plus `getObjects`'s existing return type already widens with the `DbObjectKind` union (no signature change):

```ts
export function previewCreateSchema(conn: string, db: string, spec: CreateSchemaSpec): Promise<DdlPreview>;
export function previewDropSchema(conn: string, db: string, spec: DropSchemaSpec): Promise<DdlPreview>;
export function previewRenameSchema(conn: string, db: string, spec: RenameSchemaSpec): Promise<DdlPreview>;
export function previewCreateSequence(conn: string, db: string, spec: CreateSequenceSpec): Promise<DdlPreview>;
export function previewAlterSequence(conn: string, db: string, spec: AlterSequenceSpec): Promise<DdlPreview>;
export function previewSequenceOwner(conn: string, db: string, spec: SequenceOwnerSpec): Promise<DdlPreview>;
export function previewDropSequence(conn: string, db: string, spec: DropSequenceSpec): Promise<DdlPreview>;
```

The `*Spec` interfaces live in a new `frontend/src/dock/ddlSpecs.ts` (mirrors the body shapes above; shared by the api clients and the forms) — keeps `api.ts` and the forms in sync on one type.

### Frontend — dialog forms under `frontend/src/dock/`

Two new modules exposing form-builder functions the controller calls; each builds a `Component` form and hands it to `openSqlPreviewDialog` with a `generateSql` (the matching preview client) and `execute` (`executeDdl`):

- `frontend/src/dock/SchemaDdlForms.ts` — `openCreateSchemaDialog`, `openDropSchemaDialog`, `openRenameSchemaDialog`.
- `frontend/src/dock/SequenceDdlForms.ts` — `openCreateSequenceDialog`, `openAlterSequenceDialog`, `openDropSequenceDialog`.

Each opener takes `(ref, deps)` where `deps` carries `{ connectionId, executeDdl, onSuccess, onError }` supplied by the controller, so the forms stay controller-agnostic (mirroring how `FilterDialog` takes injected callbacks).

### Frontend — `frontend/src/SqlAdminController.ts` (extend)

```ts
createSchema(ref: DbObjectRef): void;    // ref.kind "database"
dropSchema(ref: DbObjectRef): void;      // ref.kind "schema"
renameSchema(ref: DbObjectRef): void;    // ref.kind "schema"
createSequence(ref: DbObjectRef): void;  // ref.kind "schema"
alterSequence(ref: DbObjectRef): void;   // ref.kind "sequence"
dropSequence(ref: DbObjectRef): void;    // ref.kind "sequence"
```

Each builds the `deps` (with `onSuccess: () => { this._navigator?.refresh(); this.statusBar.setMessage(...); }`, `onError: e => this.notifyError(e, ref)`) and calls the matching form opener.

---

## Internal Structure

### `ListObjectsQuery` fragment list (backend)

Replace the single `_SQL` string with a fragment tuple + a joined `_SQL`:

```python
_OBJECT_SELECTS = (
    # tables + regular views (information_schema)
    "SELECT table_name AS name, "
    "CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind "
    "FROM information_schema.tables WHERE table_schema = $1",
    # materialized views (pg_class relkind 'm')
    "SELECT c.relname AS name, 'materializedView' AS kind "
    "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
    "WHERE c.relkind = 'm' AND n.nspname = $1",
    # sequences (pg_class relkind 'S') — added by schema-sequence-ddl
    "SELECT c.relname AS name, 'sequence' AS kind "
    "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
    "WHERE c.relkind = 'S' AND n.nspname = $1",
)
_SQL = " UNION ALL ".join(_OBJECT_SELECTS) + " ORDER BY name"
```

`apply()`/`get_result()` are unchanged (`get_result` already passes `kind` through). Update the `get_result` docstring's kind list to include `"sequence"`.

### Builder clause assembly (backend `ddl.py`)

`sequence_create`/`sequence_alter` build a list of clause strings and space-join a non-empty subset — the same shape `FilterCompiler` uses. Example for create:

```python
parts = [f"CREATE SEQUENCE {qualify(schema, name)}"]
if increment  is not None: parts.append(f"INCREMENT BY {int(increment)}")
if min_value  is not None: parts.append(f"MINVALUE {int(min_value)}")
if max_value  is not None: parts.append(f"MAXVALUE {int(max_value)}")
if start      is not None: parts.append(f"START WITH {int(start)}")
if cache      is not None: parts.append(f"CACHE {int(cache)}")
if cycle:                  parts.append("CYCLE")
if owned_by:               parts.append(f"OWNED BY {qualify(*owned_by[:2])}.{quote_ident(owned_by[2])}")
return " ".join(parts)
```

`sequence_alter` mirrors this but with the `ALTER SEQUENCE …` prefix, a `RESTART`/`RESTART WITH n` branch on the `RESTART_DEFAULT` sentinel, a `NO CYCLE` branch (`cycle is False`), and a `ValidationError` when `len(parts) == 1` (no options).

### `openSqlPreviewDialog` embedding (frontend)

Each form is a `Panel(VBox)` of labelled inputs (library defaults for sizing — memory _Prefer library defaults_). The dialog seam is entirely phase 1's; forms only:
- build inputs (`TextField` for names/owner, `ComboBox`/checkboxes for booleans, `TextField` numeric for integers with a client-side integer guard mirroring the server),
- pass `generateSql: () => previewX(conn, db, readForm())`,
- pass `execute: sql => executeDdl(conn, sql)` and `onSuccess`/`onError` from the controller's `deps`.

Numeric fields read as `Number.parseInt`; a blank field omits the option (sends `undefined`), a non-integer is rejected before the preview call (surface via the dialog's error path). Booleans (`cascade`, `ifExists`, `cycle`) are checkboxes; `RESTART` is a two-mode control (checkbox "restart to start" → `restartDefault: true`; or a value field → `restart: n`).

### Navigator context-menu additions (frontend `NavigatorTree.ts`)

In the `contextmenu` handler:
- **database branch** ([L113](frontend/src/navigator/NavigatorTree.ts#L113)): append `{ text: "Create schema…", glyph: "plus", action: () => this.controller.createSchema(ref) }`.
- **schema branch** ([L124](frontend/src/navigator/NavigatorTree.ts#L124)): append `Create sequence…`, `Rename schema…`, `Drop schema…` items.
- **new sequence branch** (before the `isRelation` guard, like the schema branch): `if (ref && ref.kind === "sequence") { show [ "Alter sequence…", "Drop sequence…" ]; return; }`.

`isRelation` stays false for `"sequence"` (derived from the registry's `isRelation: false`), so a sequence leaf gets no data tab / double-click open — correct (a sequence has no rows grid). Selecting it still fires `"selection"` → `showProperties` (a Properties row-set, below).

Menu-item glyphs (`plus`, `pen`, `trash`, `arrow-up-1-9`) must be imported+registered; register any not already registered in the forms modules or `objectGlyphs.ts`.

### Properties rows for a sequence (frontend `PropertiesPanel.ts`)

Add a `case "sequence":` to `propertyRows` returning identity rows (Name, Schema, Database, Type "Sequence"). This resolves the exhaustiveness typecheck error the union widening triggers. Deep param introspection (current value, increment) is a **Non-Goal** — see below.

---

## Ordered Implementation Steps

1. **`backend/app/sql/ddl.py`** — add the six builders + `RESTART_DEFAULT` sentinel per _Public API_/_Internal Structure_. Import `ValidationError` from `..errors`; reuse the module's `quote_ident`/`qualify`. Blank required identifier → `ValidationError`; `sequence_alter` with no options → `ValidationError`.

2. **`backend/tests/test_ddl_schema_sequence_sql.py`** (new) — pure-function tests for every builder covering the _Expected Behaviour_ SQL cases (follow `test_compiler.py` style). Include quoting edge cases (embedded quote in a name) and the empty-`sequence_alter` raise.

3. **`backend/app/operations/ddl_schema_sequence.py`** (new) — the seven `DdlPreview` subclasses. `__init__(self, conn, spec)` validates: blank name → `ValidationError`; numeric fields coerced via a small `_int_opt(spec, key)` helper that raises `ValidationError` on a non-integer. `build()` calls the matching builder to set `self._sql`. Pure previews (no `apply()` override needed).

4. **`backend/app/operations/__init__.py`** — import the seven preview classes and add them to `__all__` (additive; the phase-1 `DdlPreview`/`ExecuteDdlCommand` and other kinds' ops stay).

5. **`backend/app/operations/list_objects.py`** — refactor `_SQL` into `_OBJECT_SELECTS` + joined `_SQL` and append the sequence fragment (per _Internal Structure_); update the `get_result` docstring's kind list.

6. **`backend/tests/test_list_objects.py`** — extend `test_get_result_shape` with a `{"name": "order_id_seq", "kind": "sequence"}` raw row asserting it passes through. (The SQL itself is exercised by the manual DB smoke; `get_result` is the pure surface.)

7. **`backend/tests/test_ddl_schema_sequence_ops.py`** (new) — for each preview op: valid spec → `get_result()` returns `{"sql": <expected>}`; blank name / non-int numeric → `ValidationError` at construction; `get_result()` before `apply()`/`build()` raises `RuntimeError` (inherited). Use the `NO_CONN` pattern.

8. **`backend/app/main.py`** — add the seven preview routes in a new `# --- DDL: schemas & sequences ---` section, each `Depends(require_csrf)`, resolving the pool, constructing the op, `await op.apply()`, returning `op.get_result()`. Import the seven ops in the operations import group.

9. **`frontend/src/contract.ts`** — add `"sequence"` to `DbObjectKind`.

10. **`frontend/src/navigator/objectKinds.ts`** (new) — the `OBJECT_KINDS` registry + `ObjectKindInfo`, with entries for every existing kind (database/schema containers; table/view/materializedView relations under their category labels) **and** the new `{ kind: "sequence", glyph: "arrow-up-1-9", categoryLabel: "Sequences", isRelation: false }`.

11. **`frontend/src/navigator/objectGlyphs.ts`** — import+register `arrow_up_1_9`; rebuild `KIND_GLYPH` as `Object.fromEntries(OBJECT_KINDS.map(k => [k.kind, k.glyph]))` typed `Record<DbObjectKind, string>`.

12. **`frontend/src/navigator/NavigatorTree.ts`** — derive `OBJECT_CATEGORIES` and `isRelation` from `OBJECT_KINDS` (`.filter(k => k.categoryLabel)` for categories in registry order; `isRelation` from the entry's flag). Add the database/schema menu items and the new sequence-leaf context-menu branch (per _Internal Structure_).

13. **`frontend/src/properties/PropertiesPanel.ts`** — add the `case "sequence":` row-set (resolves the exhaustiveness error).

14. **`frontend/src/dock/ddlSpecs.ts`** (new) — the `*Spec` request interfaces shared by the api clients and forms.

15. **`frontend/src/data/api.ts`** — add the seven `preview*` clients (per _Public API_), importing `DdlPreview` (phase 1) and the specs.

16. **`frontend/src/dock/SchemaDdlForms.ts`** + **`frontend/src/dock/SequenceDdlForms.ts`** (new) — the six dialog openers embedding `openSqlPreviewDialog` (per _Internal Structure_).

17. **`frontend/src/SqlAdminController.ts`** — add the six launcher methods wiring `deps` (refresh on success, `notifyError` on failure).

18. **`frontend/tests/data/api.test.ts`** — add fetch-shape tests for the seven `preview*` clients (URL, POST, `{ sql }`-parsing, CSRF header, `{detail}` on failure), mirroring the existing `getStructure`/`runQuery` tests.

19. **Regression checkpoints:**
    - `grep -rn "relkind = 'S'" backend/app/operations/list_objects.py` — sequence fragment present.
    - `cd backend && poetry run pytest tests/test_ddl_schema_sequence_sql.py tests/test_ddl_schema_sequence_ops.py tests/test_list_objects.py` — green.
    - `grep -rn "sequence" frontend/src/navigator/objectKinds.ts frontend/src/contract.ts` — kind wired.
    - `cd frontend && npm run typecheck && npm test` — clean (the exhaustiveness case must compile).

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `backend/app/sql/ddl.py` (six builders + `RESTART_DEFAULT`) |
| Create | `backend/app/operations/ddl_schema_sequence.py` (seven preview ops) |
| Create | `backend/tests/test_ddl_schema_sequence_sql.py` |
| Create | `backend/tests/test_ddl_schema_sequence_ops.py` |
| Modify | `backend/app/operations/__init__.py` (export the ops) — *shared* |
| Modify | `backend/app/operations/list_objects.py` (sequence fragment) — *shared* |
| Modify | `backend/tests/test_list_objects.py` (sequence row) |
| Modify | `backend/app/main.py` (seven preview routes) — *shared* |
| Modify | `frontend/src/contract.ts` (`"sequence"` kind) — *shared* |
| Create | `frontend/src/navigator/objectKinds.ts` (kind registry) |
| Modify | `frontend/src/navigator/objectGlyphs.ts` (glyph + build KIND_GLYPH) — *shared* |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (derive from registry, menus) — *shared* |
| Modify | `frontend/src/properties/PropertiesPanel.ts` (sequence rows) — *shared* |
| Modify | `frontend/src/dock/ddlSpecs.ts` (as-built: already exists from table-ddl as a pure spec-assembly-helper module — see Drift notes; this phase adds its own helpers, not the file) |
| Modify | `frontend/tests/dock/ddlSpecs.test.ts` (tests for the new helpers) |
| Modify | `frontend/src/data/api.ts` (seven preview clients) — *shared* |
| Create | `frontend/src/dock/SchemaDdlForms.ts` |
| Create | `frontend/src/dock/SequenceDdlForms.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (six launcher methods) |
| Not touched (as-built) | `frontend/tests/data/api.test.ts` — no preview-client fetch-shape tests were added here; see Drift notes for why (neither table-ddl nor view-matview-ddl added them either) |
| Modify | `frontend/src/data/buildRelationGraph.ts` (as-built, not anticipated by the original plan: its own hand-copied `KIND_GLYPH` literal also needed a `"sequence"` entry once `DbObjectKind` widened — rebuilt from `objectKinds.ts` instead of hand-editing) |
| Create | `frontend/tests/navigator/objectKinds.test.ts` (as-built, not anticipated by the original plan: registry-logic tests for `objectKinds.ts`) |

---

## Expected Behaviour

### Backend SQL builders (unit-testable, pure)

Schemas:
- `schema_create("analytics")` → `CREATE SCHEMA "analytics"`
- `schema_create("analytics", authorization="app_owner")` → `CREATE SCHEMA "analytics" AUTHORIZATION "app_owner"`
- `schema_create("")` → `ValidationError`
- `schema_drop("analytics")` → `DROP SCHEMA "analytics"`
- `schema_drop("analytics", cascade=True, if_exists=True)` → `DROP SCHEMA IF EXISTS "analytics" CASCADE`
- `schema_rename("analytics", "reporting")` → `ALTER SCHEMA "analytics" RENAME TO "reporting"`
- `schema_rename('a"b', "c")` → `ALTER SCHEMA "a""b" RENAME TO "c"` (embedded-quote escaping)

Sequences:
- `sequence_create("public", "order_id_seq", increment=1, start=1000, min_value=1, max_value=9999999, cache=1, cycle=False)` → `CREATE SEQUENCE "public"."order_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9999999 START WITH 1000 CACHE 1`
- same with `cycle=True` → trailing ` CYCLE`
- same with `owned_by=("public","orders","id")` → trailing ` OWNED BY "public"."orders"."id"`
- `sequence_create("public", "s")` (no options) → `CREATE SEQUENCE "public"."s"`
- `sequence_alter("public", "order_id_seq", restart=RESTART_DEFAULT)` → `ALTER SEQUENCE "public"."order_id_seq" RESTART`
- `sequence_alter("public", "order_id_seq", restart=1)` → `ALTER SEQUENCE "public"."order_id_seq" RESTART WITH 1`
- `sequence_alter("public", "order_id_seq", increment=2)` → `ALTER SEQUENCE "public"."order_id_seq" INCREMENT BY 2`
- `sequence_alter("public", "order_id_seq", cycle=False)` → `ALTER SEQUENCE "public"."order_id_seq" NO CYCLE`
- `sequence_alter("public", "order_id_seq")` (no options) → `ValidationError`
- `sequence_set_owner("public", "order_id_seq", "app_owner")` → `ALTER SEQUENCE "public"."order_id_seq" OWNER TO "app_owner"`
- `sequence_drop("public", "order_id_seq")` → `DROP SEQUENCE "public"."order_id_seq"`
- `sequence_drop("public", "order_id_seq", cascade=True, if_exists=True)` → `DROP SEQUENCE IF EXISTS "public"."order_id_seq" CASCADE`

### Backend preview ops (unit-testable via `NO_CONN`)

- `SchemaCreatePreview(NO_CONN, {"name": "analytics", "authorization": "app_owner"})`.`get_result()` → `{"sql": 'CREATE SCHEMA "analytics" AUTHORIZATION "app_owner"'}`.
- `SequenceCreatePreview(NO_CONN, {"schema": "public", "name": "s", "increment": "x"})` → `ValidationError` (non-integer numeric).
- `SchemaDropPreview(NO_CONN, {"name": ""})` → `ValidationError` (blank).
- Any preview `get_result()` before `apply()`/`build()` → `RuntimeError` (inherited from `DdlPreview`).

### Listing (unit-testable transform + manual DB)

- `ListObjectsQuery.get_result()` with a raw `{"name": "order_id_seq", "kind": "sequence"}` row → passes through unchanged (unit).
- **(Manual, DB)** `GET /api/default/sqladmin/public/objects` on a schema with a sequence returns it as `{"name": …, "kind": "sequence"}` ordered by name among the tables/views.

### Backend routes / integration (manual, DB up)

- `POST …/ddl/create-schema {"name": "t_ddl_smoke"}` → `{"sql": 'CREATE SCHEMA "t_ddl_smoke"'}`; feeding that to `POST /api/default/ddl/execute` → 200 `{"kind":"status","command":"CREATE SCHEMA","rowCount":0}`; a follow-up `drop-schema` + execute drops it.
- A denied create (no `CREATE` on database) → execute 400 with the Postgres `{detail}`. Missing CSRF on any route → 403.

### Frontend (manual-verify — the node harness can't drive dialogs/tree; api clients are unit-testable)

- **Navigator:** a schema with a sequence shows a **Sequences** category with the sequence leaf under the ascending-number glyph; selecting it shows Name/Schema/Database/Type "Sequence" in Properties; double-clicking it does nothing (not a relation).
- **Context menus:** database node offers "Create schema…"; schema node offers "Create sequence…", "Rename schema…", "Drop schema…"; sequence leaf offers "Alter sequence…", "Drop sequence…".
- **Dialogs:** each opener seeds the editor with the previewed SQL; editing then Execute sends the edited text; success refreshes the navigator (the new/renamed/dropped object appears/disappears) and sets a status message; failure surfaces the `{detail}` and leaves the dialog open; Cancel/Escape/backdrop dismiss without executing.
- **api clients (unit-testable):** `previewCreateSequence("default","sqladmin",spec)` POSTs `spec` to `/api/default/sqladmin/ddl/create-sequence` with the CSRF header and returns the parsed `{ sql }`; a non-OK response rejects with `{detail}`. Same shape for the other six.

---

## Verification

- **Backend unit:** `cd backend && poetry run pytest tests/test_ddl_schema_sequence_sql.py tests/test_ddl_schema_sequence_ops.py tests/test_list_objects.py` (then full `poetry run pytest` for no regressions).
- **Backend integration (manual, DB up):** with `docker compose up -d db` and the app running, exercise the create-schema → execute → drop-schema round-trip and a create-sequence/alter/drop round-trip per the integration cases; confirm a denied and a missing-CSRF call.
- **Frontend:** `cd frontend && npm run typecheck && npm test` (the `DbObjectKind` widening must typecheck — the `propertyRows` case and registry-built `KIND_GLYPH` are the exhaustiveness gates). The dialog/tree flows are manual: log in, expand a schema with a sequence, and drive each of the six actions per _Expected Behaviour_.
- **Grep invariants** per step 19.

---

## Potential Challenges

- **Union-line merge with phase 5:** both phases append to `_OBJECT_SELECTS` and `OBJECT_KINDS`. Mitigation: these are `touches-shared` and `/implement` serializes them; the registry/fragment-list shape makes each addition a distinct appended line, so a sequential merge is trivial.
- **Exhaustiveness fallout:** widening `DbObjectKind` breaks the `propertyRows` switch and any other `Record<DbObjectKind, …>` at compile time. Mitigation: that is intended — the typecheck error names exactly what to update (step 13); no runtime surprise.
- **`ALTER SEQUENCE` variant mixing:** combining `OWNER TO` with parameter changes yields invalid SQL. Mitigation: two builders + a dialog mode toggle (see _Architecture Decisions_).
- **Bare `RESTART` vs `RESTART WITH n`:** a naive `restart: int | None` can't express bare `RESTART`. Mitigation: the `RESTART_DEFAULT` sentinel.
- **Menu-item glyphs unregistered:** an unregistered glyph name renders blank. Mitigation: import+register every new menu glyph (`plus`/`pen`/`trash`/`arrow_up_1_9`) in the forms/glyphs modules.

---

## Critical Files

- [`plans/ddl-infrastructure.md`](plans/ddl-infrastructure.md) — the shared seams (builder module, `DdlPreview`/`ExecuteDdlCommand`, `/ddl/execute`, `openSqlPreviewDialog`, `executeDdl`) this plan extends; read its _Public API_ and _Internal Structure_ first.
- [`backend/app/operations/list_objects.py`](backend/app/operations/list_objects.py) — the fragment-list refactor + sequence UNION; the matview fragment is the pattern to mirror.
- [`backend/app/sql/compiler.py`](backend/app/sql/compiler.py) — `quote_ident`, reused by the builders.
- [`backend/app/operations/base.py`](backend/app/operations/base.py) — the three-phase op contract the preview ops follow.
- [`backend/app/operations/run_query.py`](backend/app/operations/run_query.py) — the trust posture and the status envelope `ExecuteDdlCommand` reuses (phase 1).
- [`backend/tests/conftest.py`](backend/tests/conftest.py) + [`test_list_objects.py`](backend/tests/test_list_objects.py) + [`test_compiler.py`](backend/tests/test_compiler.py) — the `NO_CONN` pure-logic + pure-function test styles the new tests follow.
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) — the category/`isRelation`/context-menu seam the registry drives.
- [`frontend/src/navigator/objectGlyphs.ts`](frontend/src/navigator/objectGlyphs.ts) — glyph registration + `KIND_GLYPH` (kept `Record<DbObjectKind,string>`).
- [`frontend/src/properties/PropertiesPanel.ts`](frontend/src/properties/PropertiesPanel.ts) — the `propertyRows` switch to extend.
- [`frontend/src/dock/FilterDialog.ts`](frontend/src/dock/FilterDialog.ts) — the injected-callbacks form idiom the DDL forms mirror.
- [`frontend/src/data/api.ts`](frontend/src/data/api.ts) — `postJson`/`csrfHeader` the preview clients reuse; `getObjects` widened by the union.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — the class-first component pattern for the forms.

---

## Non-Goals

- **No tables, views, materialized views, functions, or types.** Those are phases 2, 3, and 5. This plan ships only schema and sequence DDL and the `"sequence"` kind.
- **No deep sequence introspection.** The Properties panel shows identity only (Name/Schema/Database/Type). Current value, last value, increment, and ownership readouts (a `pg_sequences`/`pg_sequence` detail fetch) are deferred; the Alter dialog collects new values without pre-populating current ones. If added later, it is a separate read op, not part of this DDL plan.
- **No sequence `SET SCHEMA` / `AS type` / `RENAME`.** Out of the stated scope (create/alter-params/owner/drop). `RENAME SEQUENCE` and moving a sequence between schemas can follow the same builder pattern later.
- **No schema `ALTER … OWNER TO` beyond create-time AUTHORIZATION.** Schema owner changes are out of the stated schema scope (create with owner, drop, rename); add later if needed.
- **No new execute route or dialog.** The phase-1 `/ddl/execute` and `openSqlPreviewDialog` are reused verbatim.
- **No per-branch navigator refresh.** A full `refresh()` after a mutation, per phase 1; a finer `Tree` reload is a noted library gap.
