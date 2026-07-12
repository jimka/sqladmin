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

# View & Materialized-View DDL — Implementation Plan

## Overview

Phase 3 of the DDL feature set: structured **CREATE / edit / DROP** for regular
views and materialized views, plus **REFRESH** for matviews. It builds entirely
on the shared seams from [`ddl-infrastructure.md`](ddl-infrastructure.md): the
pure SQL builder module [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py) (its
`qualify`/`quote_ident` seam), the `DdlPreview` base op + shared
`ExecuteDdlCommand` and its `POST /api/{connection_id}/ddl/execute` route, the
reusable `SqlPreviewDialog` (form + editable SQL preview + Cancel/Execute), the
`executeDdl` client, and the navigator context-menu + `NavigatorTree.refresh()`
seams. **Read the phase-1 plan first** — this plan references, never redefines,
those pieces.

New builder functions go in `backend/app/sql/ddl.py`; new pure preview ops in
`backend/app/operations/ddl.py` (the module phase-1 creates); six per-phase
preview routes in [`main.py`](backend/app/main.py); per-phase preview clients in
[`api.ts`](frontend/src/data/api.ts); the object-specific forms as new
components under `frontend/src/dock/`. Editing an existing view/matview prefills
the `SELECT` from the existing definition via the **already-shipped**
`ViewDefinitionQuery` / `GET …/definition`
([`view_definition.py`](backend/app/operations/view_definition.py),
[`getViewDefinition`](frontend/src/data/api.ts#L187)). The object kinds already
exist in the navigator: `ListObjectsQuery` returns `kind: "view" |
"materializedView"` ([`list_objects.py`](backend/app/operations/list_objects.py#L29)).

---

## Architecture Decisions

### Matview edit strategy — DROP + CREATE, run atomically as one previewed statement

A regular view supports `CREATE OR REPLACE VIEW`, so **editing a view's
definition is `CREATE OR REPLACE VIEW`** — in place, preserving grants and
dependents. A **materialized view cannot be `CREATE OR REPLACE`d**, so editing a
matview's body is **`DROP MATERIALIZED VIEW … ; CREATE MATERIALIZED VIEW … AS
… WITH DATA`** — the two statements semicolon-joined into a single previewed SQL
string and run through the shared `ExecuteDdlCommand`.

This is atomic **because** `ExecuteDdlCommand.apply()` runs `await
self._conn.execute(self._sql)` inside `async with self._conn.transaction()`
(phase-1 _Internal Structure_). asyncpg's `Connection.execute(sql)` with **no
bind args** uses the *simple* query protocol, which accepts multiple
`;`-separated statements in one call — unlike `RunQueryCommand`, which uses
`prepare()` (extended protocol) and so rejects `;`-scripts. The transaction wrap
makes the DROP+CREATE all-or-nothing: a failure in the CREATE rolls the DROP
back, so a bad edit never leaves the matview dropped.

**Deviation flagged:** phase-1's _Non-Goals_ lists "no multi-statement DDL
scripts," but that non-goal is premised on the *prepare*-based query path; the
execute-based DDL path does not share that limitation, and a matview body edit
genuinely requires two statements. This is the one place this phase relies on
`execute()`'s multi-statement capability, and only for the matview-replace
preview — every other builder emits exactly one statement.

**Cascade / data-loss risk:** the DROP drops the matview's stored data and (with
CASCADE) its dependents; the CREATE … WITH DATA rebuilds the data but dependents
that were dropped are **not** recreated. The matview-edit dialog surfaces this in
its form (a CASCADE toggle, default off, and a caption noting the rebuild), and
the user confirms the exact `DROP;CREATE` text in the editable preview before it
runs. Rename-only is offered separately (see below) as the safe, single-statement
alternative when only the name changes.

### Rename as a distinct, single-statement primitive

`ALTER MATERIALIZED VIEW … RENAME TO …` (and `ALTER VIEW … RENAME TO …`) is a
single, cheap, non-destructive statement. It is **not** part of the "Edit
definition" flow (which is about the SELECT body); the builder `rename_view` /
`rename_materialized_view` is provided and wired to a lightweight "Rename…"
context item, so a pure rename never pays the DROP+CREATE data-rebuild cost.

### Structural fields in the form, SELECT body authored in the editable preview

The `SqlPreviewDialog` (phase-1) is a top **form** over a bottom **editable SQL
preview**. For views/matviews the split is: **schema, name, column aliases, and
the flags** (OR REPLACE / WITH DATA / CASCADE / CONCURRENTLY / WITH NO DATA) live
in the top form and are quoted server-side; **the `SELECT` body is authored and
edited directly in the bottom preview editor.** `generateSql()` composes the
form's structural fields around the body into the full statement and seeds the
preview **once** on open (phase-1: seed-once + explicit "Regenerate SQL"; the
form does not auto-regenerate, so a later field change never clobbers a
hand-written SELECT). On **edit**, the seed's body is prefilled from
`getViewDefinition(ref)`. At Execute the **previewed string runs verbatim**
(phase-1's editable-preview-is-authoritative decision) — so the builders only
have to produce a correct initial seed; identifier quoting is single-sourced in
the builder, and the raw SELECT is passed through per phase-1's trust model.

This means the preview ops are **pure** (`DdlPreview` subclasses with no `apply()`
I/O): the definition prefill happens on the frontend via the existing
`/definition` endpoint, not inside a preview op.

### Drop / refresh reuse the same preview+confirm dialog — no bespoke confirm modal

A DROP or a REFRESH has no SELECT body; its dialog is just the flag toggles over
the editable preview. The `SqlPreviewDialog` **is** the confirm gate (the user
sees `DROP MATERIALIZED VIEW "s"."n" CASCADE` and presses Execute), so no
separate confirm `Dialog` is built — consistent with phase-1 routing every DDL
through the one dialog, and honoring the _Prefer library defaults_ memory.

### Coarse navigator refresh after success

On a successful create/drop/rename the object list changes, so `onSuccess` calls
`NavigatorTree.refresh()` (phase-1's accepted coarse full reload; there is no
per-branch `Tree` reload API). A successful **refresh-matview** does not change
the object list, so it only sets a status message. A drop/rename should also
close any open data/definition tab for the vanished/renamed object; this plan
recommends closing the matching panel by id but treats it as a nicety layered on
the coarse refresh, not a blocker (see _Potential Challenges_).

---

## Public API

### Backend — `backend/app/sql/ddl.py` (extend the phase-1 module)

Import `qualify` and `quote_ident` from the phase-1 seam (already in this
module); do not re-quote by hand. The `select` argument is the raw user SQL
fragment, inserted as-is (phase-1 trust model). Every function is pure.

```python
def create_view(schema: str, name: str, select: str, *,
                or_replace: bool = False, columns: list[str] | None = None) -> str:
    """CREATE [OR REPLACE] VIEW "schema"."name" [("c1", "c2")] AS\n<select>"""

def drop_view(schema: str, name: str, *, cascade: bool = False) -> str:
    """DROP VIEW "schema"."name" [CASCADE]"""

def rename_view(schema: str, name: str, new_name: str) -> str:
    """ALTER VIEW "schema"."name" RENAME TO "new_name" """

def create_materialized_view(schema: str, name: str, select: str, *,
                             with_data: bool = True) -> str:
    """CREATE MATERIALIZED VIEW "schema"."name" AS\n<select>\nWITH [NO] DATA"""

def drop_materialized_view(schema: str, name: str, *, cascade: bool = False) -> str:
    """DROP MATERIALIZED VIEW "schema"."name" [CASCADE]"""

def rename_materialized_view(schema: str, name: str, new_name: str) -> str:
    """ALTER MATERIALIZED VIEW "schema"."name" RENAME TO "new_name" """

def refresh_materialized_view(schema: str, name: str, *,
                              concurrently: bool = False, with_no_data: bool = False) -> str:
    """REFRESH MATERIALIZED VIEW [CONCURRENTLY] "schema"."name" [WITH NO DATA]"""

def replace_materialized_view(schema: str, name: str, select: str, *,
                              cascade: bool = False, with_data: bool = True) -> str:
    """drop_materialized_view(...) + ';\n' + create_materialized_view(...) — the
    single ;-joined statement the matview-edit flow runs (see Architecture
    Decisions). Reuses the two builders above; adds no new quoting."""
```

Emitted-SQL notes:
- Column aliases are each `quote_ident`-quoted and comma-joined inside `(...)`; `columns=None` or `[]` omits the clause.
- `refresh_materialized_view`: `CONCURRENTLY` goes **before** the qualified name; `WITH NO DATA` goes after. The builder does **not** guard the `concurrently && with_no_data` combination (Postgres rejects it) — the form guards it and Postgres is authoritative (see _Potential Challenges_).
- `replace_materialized_view` is the only builder emitting two statements.

### Backend — `backend/app/operations/ddl.py` (extend the phase-1 module)

Six pure `DdlPreview` subclasses. Each validates its spec in `__init__` (raise
`ValidationError` on a blank `schema`/`name`, and on a blank `select` for the
create/replace previews — matching phase-1's `ExecuteDdlCommand` empty-guard),
implements `build()` to set `self._sql` from the matching builder, and inherits
the base pure `apply()` (build-only, no I/O) and `get_result()` (`{"sql": …}`).

```python
class CreateViewPreview(DdlPreview):
    def __init__(self, spec: dict) -> None: ...   # {schema, name, select, orReplace, columns}
class DropViewPreview(DdlPreview):
    def __init__(self, spec: dict) -> None: ...   # {schema, name, cascade}
class CreateMaterializedViewPreview(DdlPreview):
    def __init__(self, spec: dict) -> None: ...   # {schema, name, select, withData}
class DropMaterializedViewPreview(DdlPreview):
    def __init__(self, spec: dict) -> None: ...   # {schema, name, cascade}
class RefreshMaterializedViewPreview(DdlPreview):
    def __init__(self, spec: dict) -> None: ...   # {schema, name, concurrently, withNoData}
class ReplaceMaterializedViewPreview(DdlPreview):
    def __init__(self, spec: dict) -> None: ...   # {schema, name, select, cascade, withData}
```

All six exported from
[`operations/__init__.py`](backend/app/operations/__init__.py) and added to
`__all__`.

### Backend — routes in `backend/app/main.py`

Six per-phase **preview** routes (one per preview op, per phase-1's documented
pattern), each `Depends(require_csrf)`, body a JSON spec, returning `{"sql":
str}`. Add them in a new `# --- View / matview DDL ---` section. Execute uses
phase-1's shared `POST /api/{connection_id}/ddl/execute` — **no new execute
route.**

```
POST /api/{connection_id}/{database}/ddl/create-view      body {schema,name,select,orReplace,columns} -> {sql}
POST /api/{connection_id}/{database}/ddl/drop-view         body {schema,name,cascade}                  -> {sql}
POST /api/{connection_id}/{database}/ddl/create-matview    body {schema,name,select,withData}          -> {sql}
POST /api/{connection_id}/{database}/ddl/drop-matview      body {schema,name,cascade}                  -> {sql}
POST /api/{connection_id}/{database}/ddl/refresh-matview   body {schema,name,concurrently,withNoData}  -> {sql}
POST /api/{connection_id}/{database}/ddl/replace-matview   body {schema,name,select,cascade,withData}  -> {sql}
```

Each body handler: `op = XPreview(body); await op.apply(); return op.get_result()`
inside `async with session_pool_for(session, connection_id).acquire() as c:` —
though the preview ops are pure and never touch `c`, keep the pool-acquire for
route symmetry with the phase-1 execute route and existing routes. (The `rename`
builders are exercised through `create-*`/dedicated items only if a rename item
is added; see Non-Goals — rename ships a builder but its own preview route is
optional and omitted here unless the "Rename…" item is wired.)

### Frontend — `frontend/src/contract.ts`

Reuse phase-1's `DdlPreview` (`{ sql: string }`) and `QueryStatusResult`. Add the
spec interfaces:

```ts
export interface CreateViewSpec { schema: string; name: string; select: string; orReplace: boolean; columns?: string[]; }
export interface DropSpec { schema: string; name: string; cascade: boolean; }
export interface CreateMatviewSpec { schema: string; name: string; select: string; withData: boolean; }
export interface RefreshMatviewSpec { schema: string; name: string; concurrently: boolean; withNoData: boolean; }
export interface ReplaceMatviewSpec { schema: string; name: string; select: string; cascade: boolean; withData: boolean; }
```

### Frontend — `frontend/src/data/api.ts`

Per-phase preview clients (reusing the module-private `postJson`), plus phase-1's
`executeDdl` (already added by infra). `ref` supplies the URL base
(`connectionId`, `database`); the spec is the POST body.

```ts
export function previewCreateView(ref: DbObjectRef, spec: CreateViewSpec): Promise<DdlPreview>;
export function previewDropView(ref: DbObjectRef, spec: DropSpec): Promise<DdlPreview>;
export function previewCreateMatview(ref: DbObjectRef, spec: CreateMatviewSpec): Promise<DdlPreview>;
export function previewDropMatview(ref: DbObjectRef, spec: DropSpec): Promise<DdlPreview>;
export function previewRefreshMatview(ref: DbObjectRef, spec: RefreshMatviewSpec): Promise<DdlPreview>;
export function previewReplaceMatview(ref: DbObjectRef, spec: ReplaceMatviewSpec): Promise<DdlPreview>;
// each: postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/<op>`, spec)
```

### Frontend — form components under `frontend/src/dock/`

Three new modules, each a builder that assembles a structural form (top area) and
opens phase-1's `openSqlPreviewDialog` with the right `generateSql`/`execute`/
`onSuccess`. Follow the _Prefer library defaults_ memory (no pinned heights;
lean on `Dialog`/`resizeToContent`) and the phase-1 Dialog-behavior notes.

```ts
// frontend/src/dock/ViewFormDialog.ts
export interface ViewDialogDeps {
    ref: DbObjectRef;                        // schema node (create) or view node (edit)
    schemas: string[];                       // for the schema ComboBox on create
    preview: (spec: CreateViewSpec) => Promise<DdlPreview>;
    execute: (sql: string) => Promise<QueryStatusResult>;
    onSuccess: (r: QueryStatusResult) => void;
    onError: (message: string) => void;
    initialSelect?: string;                  // prefill on edit (from getViewDefinition)
    mode: "create" | "edit";
}
export function openViewDialog(deps: ViewDialogDeps): void;

// frontend/src/dock/MaterializedViewFormDialog.ts
export interface MatviewDialogDeps { /* like ViewDialogDeps, but preview uses
    CreateMatviewSpec on create and ReplaceMatviewSpec on edit; adds withData */ }
export function openMaterializedViewDialog(deps: MatviewDialogDeps): void;

// frontend/src/dock/RelationDdlActions.ts  (drop + refresh — form is just toggles)
export function openDropRelationDialog(deps: DropDialogDeps): void;      // view or matview, CASCADE toggle
export function openRefreshMatviewDialog(deps: RefreshDialogDeps): void; // CONCURRENTLY + WITH NO DATA toggles
```

Form widgets: schema via `ComboBox` (create; read-only label on edit — schema is
fixed by the node), name via `TextField`, column aliases via a `TextField`
(comma-separated → split/trim → `columns[]`), flags via `Checkbox`
(`Checkbox({ value: false })`, as `DatabaseDiagramPanel` uses). The SELECT body is
**not** a form field — it is authored in the dialog's editable preview editor,
seeded once by `generateSql()` (per Architecture Decisions).

### Frontend — `frontend/src/dock/DefinitionPanel.ts`

Extend to host an optional "Edit definition" action. Add an optional
`onEdit?: () => void` constructor param; when present, wrap the read-only
`CodeEditor` in a `Border` frame with a `ToolBar` (NORTH) carrying a single
"Edit definition" `glyphButton` (glyph `file-code`, calling `onEdit`). When
absent, keep the current bare `Fit`-container shape unchanged. This keeps
`DefinitionPanel` composition-style (owns `content` + `dispose`).

### Frontend — `frontend/src/SqlAdminController.ts`

New methods invoked by the navigator items and the DefinitionPanel button:

```ts
async createView(schemaRef: DbObjectRef): Promise<void>;              // open create-view dialog
async createMaterializedView(schemaRef: DbObjectRef): Promise<void>;  // open create-matview dialog
async editViewDefinition(ref: DbObjectRef): Promise<void>;           // fetch definition, open edit dialog
                                                                     //   (CREATE OR REPLACE for view; DROP+CREATE for matview)
dropRelation(ref: DbObjectRef): void;                                // open drop dialog (view or matview)
refreshMaterializedView(ref: DbObjectRef): void;                     // open refresh dialog
```

`editViewDefinition` branches on `ref.kind`: `"view"` → `openViewDialog(mode:
"edit")` (preview = `previewCreateView` with `orReplace: true`); `"materializedView"`
→ `openMaterializedViewDialog(mode: "edit")` (preview = `previewReplaceMatview`).
Both prefill `initialSelect` from `(await getViewDefinition(ref)).definition`.
`onSuccess` for create/drop → `this._navigator?.refresh()` + status; for refresh →
status only. Pass `this.definitionPanelId(ref)` when opening the edit dialog **from
DefinitionPanel** is not needed — the dialog is modal and independent of the tab.

---

## Internal Structure

### `generateSql` composition (per dialog)

- **Create view:** read `orReplace=false`, `schema`/`name`/`columns` from the
  form, `select` = the current preview editor text stripped of any prior
  `CREATE … AS` prefix — simplest is to keep the whole statement in the editor and
  seed once: on open, `generateSql()` calls `previewCreateView(ref, { schema,
  name, select: "", orReplace: false, columns })`, seeding `CREATE VIEW "s"."n"
  AS\nSELECT`. Thereafter the user edits the preview; a form-field change requires
  the explicit "Regenerate SQL" (phase-1) to recompose (discarding body edits).
- **Edit view:** seed with `previewCreateView(ref, { …, select: initialSelect,
  orReplace: true })` → `CREATE OR REPLACE VIEW "s"."n" AS\n<definition>`.
- **Create matview:** `previewCreateMatview` → `CREATE MATERIALIZED VIEW … AS
  \nSELECT\nWITH DATA`.
- **Edit matview:** `previewReplaceMatview(ref, { …, select: initialSelect,
  withData: true, cascade })` → `DROP MATERIALIZED VIEW "s"."n";\nCREATE
  MATERIALIZED VIEW "s"."n" AS\n<definition>\nWITH DATA`.
- **Drop:** `previewDrop{View,Matview}` → the single DROP statement; the CASCADE
  checkbox toggles the suffix (re-preview on toggle is cheap and has no body to
  clobber).
- **Refresh:** `previewRefreshMatview` → `REFRESH MATERIALIZED VIEW
  [CONCURRENTLY] "s"."n" [WITH NO DATA]`; the two checkboxes drive the flags.

### Refresh form checkbox mutual-exclusion

`CONCURRENTLY` and `WITH NO DATA` cannot combine. The refresh form disables the
`WITH NO DATA` checkbox while `CONCURRENTLY` is checked and vice versa (a cheap
client guard); Postgres remains authoritative if the preview is hand-edited into
the illegal combination.

### `SqlPreviewDialog` embedding

Each builder passes `{ title, form, generateSql, execute, onSuccess, onError }`
to `openSqlPreviewDialog` (phase-1). `execute` = `sql => executeDdl(connectionId,
sql)`. Keyboard scope inside the editor is phase-1's concern; if a form widget
needs subtree keydown handling use `Event.addSubtreeListener` (memory _tsui event
subtree listener_), not `addListener`.

---

## Ordered Implementation Steps

1. **`backend/app/sql/ddl.py`** — add the eight builder functions per _Public
   API_, each with a docstring per the repo Python doc convention. Reuse
   `qualify`/`quote_ident`; pure, no DB. `replace_materialized_view` composes the
   drop + create builders with a `;\n` separator.

2. **`backend/tests/test_view_matview_ddl_sql.py`** — new, pure-function style
   (`test_compiler.py`). Cover each builder's exact output incl. quoting, column
   aliases, CASCADE, WITH [NO] DATA, CONCURRENTLY, and the `;`-joined replace.

3. **`backend/app/operations/ddl.py`** — add the six `DdlPreview` subclasses per
   _Public API_. `__init__` validates the spec (blank schema/name → `ValidationError`;
   blank select for create/replace → `ValidationError`), `build()` sets `self._sql`
   from the matching builder.

4. **`backend/app/operations/__init__.py`** — import and add the six preview
   classes to `__all__` (below the phase-1 `DdlPreview`/`ExecuteDdlCommand`).

5. **`backend/tests/test_view_matview_ddl_ops.py`** — new, `NO_CONN` style
   (`conftest.py`): each preview raises `ValidationError` on blank name/select;
   `build()` (via `apply()`) then `get_result()` returns `{"sql": …}` with the
   expected text; pre-build `get_result()` raises `RuntimeError`.

6. **`backend/app/main.py`** — add the six preview routes in a new `# --- View /
   matview DDL ---` section, `Depends(require_csrf)`, body `dict = Body(...)`.
   Import the six preview ops in the operations import group.

7. **`frontend/src/contract.ts`** — add the five spec interfaces (reuse phase-1's
   `DdlPreview`).

8. **`frontend/src/data/api.ts`** — add the six `preview*` clients per _Public
   API_; import the new spec types from `../contract`.

9. **`frontend/src/dock/ViewFormDialog.ts`** — new. `openViewDialog(deps)` builds
   the structural form and calls `openSqlPreviewDialog` with the create/edit
   `generateSql` seed logic (_Internal Structure_).

10. **`frontend/src/dock/MaterializedViewFormDialog.ts`** — new.
    `openMaterializedViewDialog(deps)`, incl. the `withData` toggle and the
    edit-mode `previewReplaceMatview` (DROP+CREATE) seed.

11. **`frontend/src/dock/RelationDdlActions.ts`** — new. `openDropRelationDialog`
    (CASCADE toggle, kind-aware DROP) and `openRefreshMatviewDialog`
    (CONCURRENTLY + WITH NO DATA toggles with mutual-exclusion disabling).

12. **`frontend/src/dock/DefinitionPanel.ts`** — add the optional `onEdit`
    param + toolbar button (leave the no-`onEdit` shape unchanged).

13. **`frontend/src/SqlAdminController.ts`** — add `createView`,
    `createMaterializedView`, `editViewDefinition`, `dropRelation`,
    `refreshMaterializedView`. Wire `openDefinition` to pass `onEdit: () =>
    void this.editViewDefinition(ref)` into `new DefinitionPanel(...)`. `onSuccess`
    → `this._navigator?.refresh()` (create/drop) + status; refresh → status only.
    Fetch `getSchemas` for the create dialogs' schema ComboBox.

14. **`frontend/src/navigator/NavigatorTree.ts`** — extend the `contextmenu`
    handler:
    - schema branch (the `ref.kind === "schema"` block): append `{ text: "Create
      view…", glyph: "plus", action: () => void controller.createView(ref) }` and
      `{ text: "Create materialized view…", glyph: "plus", action: () => void
      controller.createMaterializedView(ref) }`.
    - relation branch: for `ref.kind === "view"` add "Edit definition…"
      (glyph `file-code`), "Drop view…" (glyph `trash`); for `ref.kind ===
      "materializedView"` add "Edit definition…", "Refresh…" (glyph
      `arrows-rotate`), "Drop materialized view…" (glyph `trash`). Register any
      new glyph (`trash`, `arrows-rotate`) via `Glyph.register` where the file
      registers glyphs.

15. **Regression checkpoints:**
    - `cd backend && poetry run pytest tests/test_view_matview_ddl_sql.py tests/test_view_matview_ddl_ops.py` — green.
    - `grep -rn "create-view\|drop-view\|create-matview\|drop-matview\|refresh-matview\|replace-matview" backend/app/main.py frontend/src/data/api.ts` — 6 routes + 6 clients.
    - `grep -rn "CreateViewPreview\|ReplaceMaterializedViewPreview" backend/app/operations/__init__.py` — exported.
    - `cd frontend && npm run typecheck && npm test` — clean.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `backend/app/sql/ddl.py` (add 8 builders) |
| Modify | `backend/app/operations/ddl.py` (add 6 preview ops) |
| Modify | `backend/app/operations/__init__.py` (export the 6 previews) |
| Modify | `backend/app/main.py` (add 6 preview routes) |
| Create | `backend/tests/test_view_matview_ddl_sql.py` |
| Create | `backend/tests/test_view_matview_ddl_ops.py` |
| Modify | `frontend/src/contract.ts` (add 5 spec interfaces) |
| Modify | `frontend/src/data/api.ts` (add 6 preview clients) |
| Create | `frontend/src/dock/ViewFormDialog.ts` |
| Create | `frontend/src/dock/MaterializedViewFormDialog.ts` |
| Create | `frontend/src/dock/RelationDdlActions.ts` |
| Modify | `frontend/src/dock/DefinitionPanel.ts` (optional Edit toolbar) |
| Modify | `frontend/src/SqlAdminController.ts` (5 new methods + openDefinition wiring) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (schema + relation menu items) |

---

## Expected Behaviour

Backend SQL builders — **unit-testable** (pure). Given `schema="public"`:

- `create_view("public", "active", "SELECT id FROM c WHERE ok")` →
  `CREATE VIEW "public"."active" AS\nSELECT id FROM c WHERE ok`.
- `create_view(..., or_replace=True)` → `CREATE OR REPLACE VIEW "public"."active" AS\n…`.
- `create_view("public", "v", "SELECT 1, 2", columns=["a", "b"])` →
  `CREATE VIEW "public"."v" ("a", "b") AS\nSELECT 1, 2`.
- `drop_view("public", "v")` → `DROP VIEW "public"."v"`; `cascade=True` → `… CASCADE`.
- `create_materialized_view("public", "mv", "SELECT 1", with_data=False)` →
  `CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH NO DATA`; default → `WITH DATA`.
- `drop_materialized_view("public", "mv", cascade=True)` → `DROP MATERIALIZED VIEW "public"."mv" CASCADE`.
- `refresh_materialized_view("public", "mv", concurrently=True)` →
  `REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."mv"`.
- `refresh_materialized_view("public", "mv", with_no_data=True)` →
  `REFRESH MATERIALIZED VIEW "public"."mv" WITH NO DATA`.
- `replace_materialized_view("public", "mv", "SELECT 1")` →
  `DROP MATERIALIZED VIEW "public"."mv";\nCREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH DATA`.
- Quoting: `create_view('s"x', 't', 'SELECT 1')` → `CREATE VIEW "s""x"."t" AS\nSELECT 1`.

Backend preview ops — **unit-testable** (`NO_CONN`):

- `CreateViewPreview({"schema":"", …})` and a blank-`select` spec raise `ValidationError`.
- `CreateViewPreview({...}).get_result()` before `apply()` raises `RuntimeError`; after
  `apply()` → `{"sql": "CREATE VIEW …"}`.
- `ReplaceMaterializedViewPreview` → `{"sql": "DROP MATERIALIZED VIEW …;\nCREATE …"}`.

Backend integration — **manual/DB** (via `POST …/ddl/execute`, phase-1 route):

- Preview a create-view then execute → 200 `{"kind":"status","command":"CREATE VIEW","rowCount":0}`.
- Execute a matview replace (`DROP…;CREATE…`) → 200 with the CREATE tag; a forced
  failure in the CREATE half leaves the matview intact (transaction rollback).
- `REFRESH MATERIALIZED VIEW CONCURRENTLY` on a matview **without** a unique index
  → 400 with the Postgres detail (surfaced by `_pg_error_handler`), dialog stays open.
- `DROP VIEW` of a view with dependents, no CASCADE → 400 dependency error; with
  CASCADE → succeeds.

Frontend — **manual-verify** (the node harness can't drive `CodeEditor`, the
modal, focus, or the network):

- Right-click a schema → "Create view…"/"Create materialized view…" open the
  dialog seeded with a skeleton statement; Execute creates the object and the
  navigator refreshes to show it.
- Right-click a view → "Edit definition…" opens the preview prefilled with
  `CREATE OR REPLACE VIEW … AS <existing definition>`; editing the SELECT and
  Execute replaces it in place.
- Right-click a matview → "Edit definition…" opens prefilled with the
  `DROP…;CREATE…` pair; "Refresh…" opens the refresh dialog (CONCURRENTLY
  disables WITH NO DATA and vice versa); "Drop materialized view…" opens the
  CASCADE-toggle drop preview.
- The read-only DefinitionPanel's "Edit definition" toolbar button opens the same
  edit dialog for the tab's object.
- Cancel / Escape / backdrop / title-bar close dismiss without executing (phase-1
  dialog semantics); a failed Execute keeps the dialog open with the SQL intact.

The `preview*`/`executeDdl` clients are thin `postJson` wrappers — covered by the
existing api-layer conventions; add fetch-shape unit tests only if the api suite
already tests `api.ts` (phase-1 step 10 makes the same call).

---

## Verification

- **Backend unit:** `cd backend && poetry run pytest tests/test_view_matview_ddl_sql.py tests/test_view_matview_ddl_ops.py`, then full `poetry run pytest` for no regressions.
- **Backend integration (manual, DB up):** `docker compose up -d db`, app running; exercise the create/edit/drop/refresh cases above against the seed's view + materialized view (README notes the seed ships both).
- **Frontend:** `cd frontend && npm run typecheck && npm test`; then the manual dialog flows above in the running app (`npm run dev`) — create/edit/drop a throwaway view and matview, and a REFRESH (incl. the CONCURRENTLY-without-unique-index error path).
- **Grep invariants** per step 15.

---

## Potential Challenges

- **REFRESH … CONCURRENTLY needs a unique index** on the matview, or Postgres
  errors. Mitigation: let the error surface via `_pg_error_handler` (400 → dialog
  stays open) — the tool's "your grants / Postgres is authoritative" posture
  (phase-1); the form does not pre-check for a unique index.
- **CONCURRENTLY + WITH NO DATA is illegal.** Mitigation: the refresh form
  mutually disables the two checkboxes; Postgres still guards a hand-edited preview.
- **Matview edit is destructive** (DROP drops data + CASCADE dependents; CREATE
  rebuilds data but not dependents). Mitigation: the DROP+CREATE text is shown in
  the editable preview for explicit confirmation, the CASCADE toggle defaults off,
  and the form caption warns of the rebuild — plus the transaction wrap makes it
  atomic so a failed CREATE never loses the matview.
- **Reliance on `execute()`'s multi-statement path** for the matview replace.
  Mitigation: documented in _Architecture Decisions_; every other builder is a
  single statement, so only the replace preview depends on it, and it is covered
  by the manual integration case.
- **Regenerate-clobbers-body race** (phase-1): a structural-field change after the
  user hand-writes the SELECT would, on Regenerate, discard the body. Mitigation:
  seed-once + explicit "Regenerate SQL" (phase-1 default); documented, not hidden.
- **Stale tab after drop/rename:** the coarse `refresh()` reloads the tree but a
  dropped object's open data/definition tab lingers. Mitigation: recommend the
  controller close the panel by id on a successful drop/rename; treated as a
  layered nicety, not a blocker.

---

## Critical Files

- [`plans/ddl-infrastructure.md`](plans/ddl-infrastructure.md) — the shared seams (`DdlPreview`, `ExecuteDdlCommand`, `/ddl/execute`, `SqlPreviewDialog`, `executeDdl`, the `qualify`/`quote_ident` seam) this phase extends.
- [`backend/app/sql/ddl.py`](backend/app/sql/ddl.py) + [`sql/compiler.py`](backend/app/sql/compiler.py) — `qualify`/`quote_ident` reused by the builders.
- [`backend/app/operations/base.py`](backend/app/operations/base.py) — the three-phase op contract the preview ops implement.
- [`backend/app/operations/view_definition.py`](backend/app/operations/view_definition.py) + [`main.py`'s `/definition` route](backend/app/main.py#L335) — the existing prefill source (`getViewDefinition`), unchanged.
- [`backend/app/operations/run_query.py`](backend/app/operations/run_query.py) — the `execute()`/status-envelope precedent (why the matview `;`-join is atomic through `ExecuteDdlCommand`, not `RunQueryCommand`).
- [`backend/tests/conftest.py`](backend/tests/conftest.py) + [`test_view_definition.py`](backend/tests/test_view_definition.py) — the `NO_CONN` pure-op test style.
- [`frontend/src/dock/FilterDialog.ts`](frontend/src/dock/FilterDialog.ts) + [`shell/LoginDialog.ts`](frontend/src/shell/LoginDialog.ts) — the `Dialog` result-code + show/retry idiom `SqlPreviewDialog` mirrors; `ComboBox`/`Checkbox` form patterns.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — `CodeEditor` construction/disposal + `Event.addSubtreeListener` reference.
- [`frontend/src/dock/DefinitionPanel.ts`](frontend/src/dock/DefinitionPanel.ts) + [`ViewWorkPanel.ts`](frontend/src/dock/ViewWorkPanel.ts) — the read-only hosts for the "Edit definition" action.
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) + [`objectGlyphs.ts`](frontend/src/navigator/objectGlyphs.ts) — the context-menu launch seam + kind glyphs.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — `openDefinition`/`showProperties`/`refresh` seams the new methods sit beside.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — class-first / composition pattern for the new components.

---

## Non-Goals

- **No tables, schemas, sequences, functions, or types.** CREATE/ALTER/DROP for
  those are the other DDL phases (`table-ddl.md`, `schema-sequence-ddl.md`,
  `function-type-ddl.md`).
- **No view/matview column-level ALTER** (rename column, set/drop default,
  `ALTER MATERIALIZED VIEW … ALTER COLUMN …`, storage options, `WITH (…)`
  reloptions). Body edits go through CREATE OR REPLACE / DROP+CREATE; column-level
  tweaks are out of scope.
- **No `CREATE RECURSIVE VIEW`, `WITH CHECK OPTION`, or `TABLESPACE`/`USING`
  clauses** — the common case (name, schema, aliases, body, WITH [NO] DATA) only;
  a power user can hand-edit the preview to add such clauses before Execute.
- **No pre-flight privilege or unique-index checks.** Postgres enforces; errors
  surface via `_pg_error_handler` (phase-1 posture).
- **No new execute op/route.** Reuse phase-1's `ExecuteDdlCommand` +
  `/ddl/execute`.
- **No standalone rename UI beyond the optional item.** `rename_*` builders ship,
  but a dedicated rename dialog/route is only wired if a "Rename…" item is added;
  the plan's edit flow covers body changes, not renames.
