---
touches-shared:
  - frontend/src/dock/StructurePanel.ts
  - frontend/src/SqlAdminController.ts
  - frontend/src/navigator/NavigatorTree.ts
  - backend/app/operations/list_columns.py
---

# Richer table Structure — indexes, constraints, foreign keys (+ FK click-through) — Implementation Plan

## Overview

The Structure view ([`frontend/src/dock/StructurePanel.ts`](frontend/src/dock/StructurePanel.ts)) today renders **one** read-only grid of a table's introspected columns, opened as its own Dock tab from the navigator's right-click "Open structure" ([`SqlAdminController.openStructure`](frontend/src/SqlAdminController.ts#L131)). This plan enriches it to also present a table's **indexes**, **constraints** (primary key, unique, check + its expression), and **foreign keys**, and makes a foreign key **click through** to open the referenced table in the Dock (and, best-effort, reveal it in the navigator).

The feature spans both halves. **Backend:** a new CQRS `Query` per structure facet — `ListIndexesQuery` (`pg_index`/`pg_indexes`), `ListConstraintsQuery` (`pg_constraint`, PK/unique/check), `ListForeignKeysQuery` (`pg_constraint contype='f'` with the referenced schema/table/columns and update/delete actions) — behind **one** new route `GET …/{table}/structure` returning `{indexes, constraints, foreignKeys}` in a single round trip (mirroring `role_detail`'s combined endpoint, [`SqlAdminController`-consumed `/roles/{role}`](backend/app/main.py#L227)). **Frontend:** `StructurePanel` becomes a scrollable stack of four labelled read-only grids (Columns / Indexes / Constraints / Foreign Keys); the Foreign Keys grid's row selection routes an FK to `SqlAdminController.openTable` for the referenced table and calls the existing `Tree.selectNode` reveal seam.

The library needs **no** change: every grid is the existing read-only `Table` with `rowReadOnly: () => true` ([`StructurePanel.ts:34`](frontend/src/dock/StructurePanel.ts#L34)), the panel scrolls via a host `Panel` with `autoScroll` ([`layout/LayoutManager.ts:408`](../../typescript-ui/src/typescript/lib/layout/LayoutManager.ts#L408)), FK click-through rides the `Table` `"selectionchange"` event ([`component/table/Table.ts:180`](../../typescript-ui/src/typescript/lib/component/table/Table.ts#L180)) plus the merged `Tree.selectNode` ([`component/tree/Tree.ts:197`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts#L197)), and the referenced table opens through the unchanged `controller.openTable`.

DDL (create/drop index, add/drop constraint) is **out of scope**, consistent with the app's deferred DDL ([`tsui-sql-admin.md:706`](plans/implemented/tsui-sql-admin.md#L706)).

---

## Architecture Decisions

### Shared-file discipline — defer to schema-views on the panel's *tab* structure

[`schema-views.md`](plans/schema-views.md) owns adding a **Definition** view for views/matviews, and it does so in a **separate** `ViewWorkPanel`, explicitly reusing `StructurePanel` **unchanged** ([`schema-views.md:249`](plans/schema-views.md#L249): "`StructurePanel.ts` … is **not modified** here — this plan reuses it unchanged"). So there is no conflict: schema-views does not touch `StructurePanel`'s internals, and this plan does not touch `ViewWorkPanel` or the Definition tab. This plan owns the **interior enrichment** of `StructurePanel` (the four stacked grids + FK routing). On `SqlAdminController.ts` and `NavigatorTree.ts` both plans are `touches-shared`; the edits are additive and non-overlapping (schema-views adds view routing + navigator grouping; this plan adds the `openTable`-from-FK affordance and a `getStructure` fetch). `list_columns.py` is `touches-shared` because schema-views extends it for matview columns while this plan reads it only to source the FK-target column set for the "Open structure" reveal — no edit to `list_columns.py` is required by *this* plan (see *Non-Goals*), so the shared marker is a coordination flag, not an overlapping change.

### Stacked labelled grids, not sub-tabs

The four facets — Columns, Indexes, Constraints, Foreign Keys — are all *the structure of one object*, and a user reading structure routinely cross-references them (e.g. "is `customer_id` indexed, and what does its FK reference?"). Sub-tabs would hide three facets at a time and add a mode the user must toggle; a **vertical stack of labelled sections in one scrollable panel** keeps every facet co-visible and matches the read-only, scan-it inspector feel `StructurePanel` already has. Each section is a small caption `Label` + a read-only `Table` over a `MemoryStore` of that facet's rows (the exact idiom the current `StructurePanel` and `PropertiesPanel` already use — [`PropertiesPanel.ts:42`](frontend/src/properties/PropertiesPanel.ts#L42)). The panel's layout is a vertical stack (`VBox`) hosted in a `Panel` with `autoScroll: "auto"` so the whole structure scrolls when it overflows the tab. Empty facets render their section header with an empty/"none" grid rather than vanishing, so the structure's shape is legible at a glance (a table with no FKs still shows a "Foreign Keys — none" section); this is a small, honest deviation from the navigator's "omit empties" style and is justified because a fixed four-section layout is more scannable for a single object's structure than a variable one.

Rejected alternative — reusing the library `Accordion` for collapsible sections: `Accordion`'s `fillHeight`/`singleOpen` height apportionment ([`Accordion.ts:87`](../../typescript-ui/src/typescript/lib/layout/Accordion.ts#L96)) fights a "show everything, scroll if needed" inspector (its known friction, `LIBRARY_NOTES.md` "Accordion sections should be resizable" / "`fillHeight` only fills the bottommost"). A plain scrolling `VBox` of fixed-height grids is simpler and matches intent.

### One combined `/structure` endpoint, three `Query` operations

The three facets are always shown together, so fetching them in **one** route avoids three navigator round trips and mirrors the app's existing combined-detail precedent — `/roles/{role}` runs `RoleAttributesQuery` + `RoleMembershipsQuery` + `RolePrivilegesQuery` and returns a merged `RoleDetail` ([`role_detail.py`](backend/app/operations/role_detail.py), route [`main.py:227`](backend/app/main.py#L227)). New route `GET /api/{conn}/{db}/{schema}/{table}/structure` acquires one connection, runs the three queries, and returns `{indexes: [...], constraints: [...], foreignKeys: [...]}`. Each query is an independent, pure-`get_result` `Query` (constructor validates nothing beyond capturing the `TableRef`; the schema/table are bound as `$1`/`$2` parameters, never interpolated — no `quote_ident` needed, exactly like `role_detail`'s `$1` binding). Columns stay on the existing `/columns` endpoint and are fetched by the controller as today; `/structure` carries only the three *new* facets, keeping each endpoint single-responsibility and letting Properties/`ViewWorkPanel` keep calling `/columns` alone.

### Foreign keys are introspected from `pg_constraint`, joined to `pg_class`/`pg_attribute`

`pg_constraint` (`contype='f'`) carries the FK's local columns (`conkey`), the referenced relation (`confrelid`) and its columns (`confkey`), and the update/delete actions (`confupdtype`/`confdeltype`). Column numbers are resolved to names via `pg_attribute` (`unnest(conkey) WITH ORDINALITY` joined on `attnum`), and the referenced schema/table via `pg_class`/`pg_namespace` on `confrelid`. The action codes (`a`=no action, `r`=restrict, `c`=cascade, `n`=set null, `d`=set default) map to human strings in the pure `get_result()`. This is `pg_catalog`-only (works for tables regardless of `information_schema` visibility) and yields, per FK constraint, one row `{name, columns[], refSchema, refTable, refColumns[], onUpdate, onDelete}`.

### Constraints and indexes: catalog sources

- **Constraints** — `pg_constraint` for PK (`contype='p'`), unique (`contype='u'`), and check (`contype='c'`, with `pg_get_constraintdef(oid)` for the expression). Each row `{name, type: "primaryKey"|"unique"|"check", columns[], definition}` where `columns` is the constrained column list (empty for a table-level check) and `definition` is the reconstructed clause (`pg_get_constraintdef`) — the most faithful, injection-free way to show a check's expression. FK constraints are **excluded** here (`contype <> 'f'`) since they get their own richer Foreign Keys grid; showing them twice would be noise.
- **Indexes** — `pg_indexes` gives `indexname` + `indexdef` (the full `CREATE INDEX …` text) in one view, the simplest faithful source; `pg_index`/`pg_class` supply the `is_unique`/`is_primary` flags. Each row `{name, definition, unique, primary}`. The `indexdef` text carries the column list and method, so no separate column-name resolution is needed for the display grid.

### FK click-through rides the grid's `selectionchange`, not a cell click

The library `Table` exposes **no** cell-click / row-activate event and `ColumnConfig` has **no** custom `renderer` (verified: [`Table.ts:180`](../../typescript-ui/src/typescript/lib/component/table/Table.ts#L180) emits only `"selectionchange"`; [`ColumnConfig`](../../typescript-ui/src/typescript/lib/component/table/ColumnConfig.ts) has no renderer field). So a link-styled clickable cell is not available without a library change (out of scope). The interaction is therefore: **selecting a row in the Foreign Keys grid opens its referenced table**. On `foreignKeysGrid.on("selectionchange", records => …)`, the panel resolves the selected FK row's `{refSchema, refTable}` to a `DbObjectRef` (same `connectionId`/`database` as the current table) and invokes a controller callback `openReferencedTable(ref)`. This mirrors the navigator's own "select a leaf → open it" model ([`NavigatorTree.ts:36`](frontend/src/navigator/NavigatorTree.ts#L36)) and needs no library surface beyond what exists. To keep it a deliberate action rather than an accidental side effect of a stray click, the grid uses single-selection and the panel opens the table on the selection landing on an FK row (documented as manual-verify; selection semantics are DOM-driven).

### The referenced table opens via the existing `openTable`; navigator reveal is best-effort

Clicking through calls the controller's existing open path. `SqlAdminController.openTable(ref, node)` ([`SqlAdminController.ts:89`](frontend/src/SqlAdminController.ts#L89)) currently **requires a `TreeNode`** (it stores `node` in the registry for `syncToPanel` → `selectNode`). An FK target may not correspond to a currently-loaded navigator node (its schema may be unexpanded), so this plan adds a controller method `openReferencedTable(ref: DbObjectRef)` that opens the table **without** a node, then attempts a best-effort navigator reveal:

- **Open** always succeeds: build the store/columns and `addLazyPanel` exactly as `openTable` does, but tolerate a missing `node`. The cleanest change is to make `openTable`'s `node` optional (`node?: TreeNode`) and guard the two `node`-dependent sites (`_openPanels` entry keeps `node: node ?? null`; `syncToPanel` skips `selectNode` when `node` is null). `openReferencedTable` then delegates to `openTable(ref, revealedNode)` where `revealedNode` is whatever the navigator lookup found (possibly undefined).
- **Reveal** is best-effort because `Tree.selectNode` is a **no-op when the node is not in the currently-visible flattened set** — an ancestor collapsed or lazy children not yet loaded ([`Tree.ts:197`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts#L197) docstring: "No-op when the node is not in the currently visible (flattened) set"). The `Tree` has no public expand-to-node / find-by-ref API (`getNodes()` returns roots only; expansion is user-click-driven — [`Tree.ts:160`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts#L160)). So the reveal walks the *already-loaded* node tree from `tree.getNodes()` matching `node.data as DbObjectRef` against the target `{database, schema, name}`; if found and visible, `selectNode` highlights it; if the target lives under a collapsed/unloaded branch, the reveal silently no-ops and only the Dock tab opens. This is an honest, documented limitation, not a bug — a fuller reveal would need a library `Tree.revealByPredicate`/expand-path seam (noted as a `LIBRARY_NOTES.md` friction, not built here).

### No new `WireType` / contract-scalar work

The structure payload is pure metadata strings/booleans/string-arrays — it does not carry table *row* values, so the `WireType` `to_wire` machinery ([`wire.py`](backend/app/wire.py)) is not involved. The three `get_result()`s emit plain JSON dicts (the same style as `role_detail`'s), and the frontend mirrors them as flat interfaces in `contract.ts`.

---

## Public API

### Contract — `frontend/src/contract.ts` (mirror the backend `get_result` shapes)

```ts
/** One index on a table (from pg_indexes / pg_index). */
export interface IndexMeta {
    name: string;        // indexname
    definition: string;  // full CREATE INDEX … text (indexdef)
    unique: boolean;
    primary: boolean;    // backs the primary key
}

/** One non-FK constraint (PK / unique / check). */
export interface ConstraintMeta {
    name: string;
    type: "primaryKey" | "unique" | "check";
    columns: string[];   // constrained columns (empty for a table-level check)
    definition: string;  // pg_get_constraintdef(oid) — the reconstructed clause
}

/** One foreign key, with its referenced relation + actions. */
export interface ForeignKeyMeta {
    name: string;
    columns: string[];       // local FK columns, in key order
    refSchema: string;
    refTable: string;
    refColumns: string[];    // referenced columns, positionally paired with `columns`
    onUpdate: string;        // "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT"
    onDelete: string;        // same set
}

/** The combined structure payload the /structure route returns. */
export interface TableStructure {
    indexes: IndexMeta[];
    constraints: ConstraintMeta[];
    foreignKeys: ForeignKeyMeta[];
}
```

### Frontend data path — `frontend/src/data/api.ts`

```ts
/** Fetch a table's indexes, constraints, and foreign keys in one round trip. */
export function getStructure(ref: DbObjectRef): Promise<TableStructure>;
```

Uses the existing `getJson<T>` client ([`api.ts:30`](frontend/src/data/api.ts#L30)) against `GET /api/{conn}/{db}/{schema}/{name}/structure`.

### Frontend component — `frontend/src/dock/StructurePanel.ts`

```ts
/**
 * Read-only structure inspector: stacked Columns / Indexes / Constraints /
 * Foreign Keys grids. Selecting a Foreign Keys row opens its referenced table
 * via `onOpenReferenced`.
 */
export function StructurePanel(
    columns: ColumnMeta[],
    structure: TableStructure,
    onOpenReferenced: (ref: DbObjectRef) => void,
): Panel;
```

The current one-arg `StructurePanel(columns)` signature is widened; the only caller is `SqlAdminController.openStructure` (verified — `grep -rn 'StructurePanel(' frontend/src` returns the definition + the one controller call).

### Frontend controller — `frontend/src/SqlAdminController.ts`

```ts
/** Open the FK-referenced table in the Dock and best-effort reveal it in the navigator. */
openReferencedTable(ref: DbObjectRef): void;   // NEW — public, called by StructurePanel

async openTable(ref: DbObjectRef, node?: TreeNode): Promise<void>;   // `node` becomes optional
```

`OpenPanel.node` becomes `TreeNode | null`; `syncToPanel` guards the `selectNode` call.

### Backend operations — `backend/app/operations/table_structure.py` (new module)

```python
class ListIndexesQuery(Query):        # pg_indexes + pg_index flags
    def __init__(self, conn, table: TableRef) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> list[dict]:   # [{name, definition, unique, primary}]

class ListConstraintsQuery(Query):    # pg_constraint contype in ('p','u','c')
    def __init__(self, conn, table: TableRef) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> list[dict]:   # [{name, type, columns, definition}]

class ListForeignKeysQuery(Query):    # pg_constraint contype='f'
    def __init__(self, conn, table: TableRef) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> list[dict]:   # [{name, columns, refSchema, refTable, refColumns, onUpdate, onDelete}]
```

All three follow the `role_detail` shape: capture `conn` + `TableRef` in `__init__`, bind `schema`/`table` as `$1`/`$2`, `_raw = None` guard, `get_result` raises `RuntimeError` before `apply()`.

### Route — `backend/app/main.py`

```
GET /api/{connection_id}/{database}/{schema}/{table}/structure
    -> {"indexes": [...], "constraints": [...], "foreignKeys": [...]}
```

Thin: acquire → run the three queries (`apply` + `get_result` each) → assemble the dict. No `NotFound` gate needed (a table with no indexes/constraints/FKs legitimately returns empty lists; a non-existent table simply returns all-empty, matching the read-only inspector's tolerance — the existing `/columns` fetch is what surfaces a truly missing table).

---

## Internal Structure

### `ListForeignKeysQuery` — the load-bearing SQL

```sql
SELECT
    con.conname AS name,
    con.confupdtype AS on_update,
    con.confdeltype AS on_delete,
    nr.nspname AS ref_schema,
    cr.relname AS ref_table,
    ARRAY(
        SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
    ) AS columns,
    ARRAY(
        SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
        ORDER BY k.ord
    ) AS ref_columns
FROM pg_constraint con
JOIN pg_class c   ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class cr  ON cr.oid = con.confrelid
JOIN pg_namespace nr ON nr.oid = cr.relnamespace
WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
ORDER BY con.conname
```

`get_result()` maps `on_update`/`on_delete` single-char codes through a constant `_FK_ACTIONS = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}` and returns the contract dicts. asyncpg decodes `text[]` to a Python `list[str]`, so `columns`/`ref_columns` need no transform.

### `ListConstraintsQuery` and `ListIndexesQuery`

- Constraints: `SELECT con.conname AS name, con.contype, pg_get_constraintdef(con.oid) AS definition, ARRAY(... conkey → attname ...) AS columns FROM pg_constraint con JOIN pg_class/… WHERE con.contype IN ('p','u','c') AND n.nspname=$1 AND c.relname=$2 ORDER BY con.contype, con.conname`. `get_result` maps `contype` `p|u|c` → `"primaryKey"|"unique"|"check"`.
- Indexes: `SELECT i.indexname AS name, i.indexdef AS definition, ix.indisunique AS unique, ix.indisprimary AS primary FROM pg_indexes i JOIN pg_class ic ON ic.relname = i.indexname JOIN pg_index ix ON ix.indexrelid = ic.oid JOIN pg_namespace n ON n.oid = ic.relnamespace WHERE i.schemaname=$1 AND i.tablename=$2 AND n.nspname=$1 ORDER BY i.indexname`. (Joining `pg_class` on the index name within the schema keeps the `unique`/`primary` flags correct.)

### `StructurePanel` — the stacked layout

```
StructurePanel (Panel, autoScroll "auto", VBox layout)
├─ section "Columns"       : Label + Table(columnsStore,     rowReadOnly)   — the existing grid
├─ section "Indexes"       : Label + Table(indexesStore,     rowReadOnly)
├─ section "Constraints"   : Label + Table(constraintsStore, rowReadOnly)
└─ section "Foreign Keys"  : Label + Table(fkStore,          rowReadOnly)   — selectionchange → onOpenReferenced
```

- Each `*Store` is a `MemoryStore` over that facet's contract rows with a `Model` whose fields match the row keys (arrays render via a display column joining with `", "` — since there is no custom renderer, the panel pre-joins array fields into display strings when loading the store, e.g. `columns: fk.columns.join(", ")`, and keeps the raw `ForeignKeyMeta` addressable for the click-through by index). A per-row map from the grid's `ModelRecord` back to the source `ForeignKeyMeta` resolves the referenced ref on selection.
- The Foreign Keys grid wires `grid.on("selectionchange", records => { const fk = recordToFk.get(records[0]); if (fk) onOpenReferenced(refFor(fk)); })`, where `refFor(fk)` builds `{ connectionId, database, schema: fk.refSchema, name: fk.refTable, kind: "table" }` from the panel's own `DbObjectRef` context (the current table's `connectionId`/`database`). The panel therefore also needs the current table's `DbObjectRef` — pass it as an implicit part of `onOpenReferenced`'s closure in the controller (the controller already holds `ref` in `openStructure`), so `StructurePanel` only calls `onOpenReferenced(refFor(fk))` with a ref it assembles from `fk` + the connection/database the controller baked into the callback. **Simpler:** have the controller pass `onOpenReferenced: (refSchema, refTable) => this.openReferencedTable({ connectionId, database, schema: refSchema, name: refTable, kind: "table" })`, so the panel passes only the two FK fields and the controller owns ref assembly. Adopt this form — it keeps the panel free of connection/database plumbing.

Revised panel signature accordingly:

```ts
export function StructurePanel(
    columns: ColumnMeta[],
    structure: TableStructure,
    onOpenReferenced: (refSchema: string, refTable: string) => void,
): Panel;
```

### Controller wiring — `openStructure` and `openReferencedTable`

`openStructure` ([`SqlAdminController.ts:131`](frontend/src/SqlAdminController.ts#L131)) additionally fetches the structure and passes the callback:

```ts
let columns: ColumnMeta[];
let structure: TableStructure;
try {
    [columns, structure] = await Promise.all([getColumns(ref), getStructure(ref)]);
} catch (err) { this.notifyError(err, ref); return; }
...
content: StructurePanel(columns, structure,
    (refSchema, refTable) => this.openReferencedTable({
        connectionId: ref.connectionId, database: ref.database,
        schema: refSchema, name: refTable, kind: "table",
    })),
```

`openReferencedTable` opens the table and reveals best-effort:

```ts
openReferencedTable(ref: DbObjectRef): void {
    const node = this.findLoadedNode(ref);   // walk tree.getNodes() by node.data ref; may be undefined
    void this.openTable(ref, node ?? undefined);
}
```

`openTable`'s `node` param becomes optional; the `_openPanels` entry stores `node ?? null`, and `syncToPanel` calls `selectNode` only when `panel.node` is non-null. `findLoadedNode` is a small private helper doing a depth-first walk of the already-loaded `children` from `this._navigator?.getNodes()`, matching `node.data` `{database, schema, name}` — it never forces a lazy load.

---

## Ordered Implementation Steps

1. **Contract types (frontend).** In [`frontend/src/contract.ts`](frontend/src/contract.ts), add `IndexMeta`, `ConstraintMeta`, `ForeignKeyMeta`, `TableStructure`. No Python contract dataclasses are strictly required (the backend emits plain dicts like `list_objects`), but if the repo prefers typed contract objects, mirror them in `backend/app/contract.py` — otherwise keep the `get_result` dicts inline. Verify: `tsc --noEmit` clean.
2. **Backend `table_structure.py`.** Create [`backend/app/operations/table_structure.py`](backend/app/operations/table_structure.py) with `ListIndexesQuery`, `ListConstraintsQuery`, `ListForeignKeysQuery` (SQL + `_raw` guard + pure `get_result`, per *Internal Structure*). Add the `_FK_ACTIONS` and `contype`→type maps as module constants.
3. **Export the ops.** In [`backend/app/operations/__init__.py`](backend/app/operations/__init__.py), import + add to `__all__`.
4. **`/structure` route.** In [`backend/app/main.py`](backend/app/main.py), add `GET /api/{connection_id}/{database}/{schema}/{table}/structure` near `/columns`: acquire → run the three queries → return `{"indexes", "constraints", "foreignKeys"}`. Ordering vs. the `/rows` routes is not load-bearing (distinct literal suffix).
5. **Backend tests.** Create [`backend/tests/test_table_structure.py`](backend/tests/test_table_structure.py) mirroring [`test_role_detail.py`](backend/tests/test_role_detail.py)/[`test_list_columns.py`](backend/tests/test_list_columns.py): set each op's `_raw` by hand and assert `get_result()` shape (FK action-code mapping, `contype`→type mapping, array pass-through, empty `_raw` → `[]`, `get_result` before `apply` → `RuntimeError`).
6. **Frontend `getStructure`.** In [`frontend/src/data/api.ts`](frontend/src/data/api.ts), add `getStructure(ref)` via `getJson<TableStructure>` against `/structure`. Add a unit test to [`api.test.ts`](frontend/src/data/api.test.ts) (mock fetch → URL + parsed shape) matching the existing `getColumns` test.
7. **`StructurePanel` enrichment.** In [`frontend/src/dock/StructurePanel.ts`](frontend/src/dock/StructurePanel.ts), widen the signature to `(columns, structure, onOpenReferenced)`; build the four labelled read-only grids in a scrolling `VBox` panel; pre-join array fields to display strings; keep a `Map<ModelRecord, ForeignKeyMeta>` for the FK grid and wire `selectionchange` → `onOpenReferenced(fk.refSchema, fk.refTable)`. Keep the existing Columns model/grid intact.
8. **Controller wiring.** In [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts): (a) `getStructure` import; (b) `openStructure` fetches columns + structure (`Promise.all`) and passes the callback; (c) add public `openReferencedTable(ref)` + private `findLoadedNode(ref)`; (d) make `openTable`'s `node` optional and guard `syncToPanel`'s `selectNode`; (e) `OpenPanel.node` → `TreeNode | null`.
9. **Regression checkpoints.**
   - `grep -rn 'StructurePanel(' frontend/src` — one definition + one controller call, all three-arg.
   - `grep -rn 'openReferencedTable\|getStructure\|/structure' frontend/src backend/app` — present in controller, panel-callback path, api, and the route.
   - `grep -rn 'contype' backend/app` — only in `table_structure.py`.
   - Backend `pytest`; frontend `tsc --noEmit` + `vitest run` green.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `backend/app/operations/table_structure.py` — `ListIndexesQuery` / `ListConstraintsQuery` / `ListForeignKeysQuery` |
| Create | `backend/tests/test_table_structure.py` — `get_result()` + temporal-guard tests |
| Modify | `backend/app/operations/__init__.py` — export the three queries |
| Modify | `backend/app/main.py` — `/structure` route |
| Modify | `frontend/src/contract.ts` — `IndexMeta` / `ConstraintMeta` / `ForeignKeyMeta` / `TableStructure` |
| Modify | `frontend/src/data/api.ts` — `getStructure` |
| Modify | `frontend/src/data/api.test.ts` — `getStructure` test |
| Modify | `frontend/src/dock/StructurePanel.ts` — stacked four-grid layout + FK click-through (**touches-shared** with schema-views, which reuses it unchanged) |
| Modify | `frontend/src/SqlAdminController.ts` — `openStructure` fetch + `openReferencedTable`/`findLoadedNode`; `openTable` node optional (**touches-shared**) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` — none required by this plan; listed **touches-shared** only as a coordination flag (see *Non-Goals*) |

`backend/app/operations/list_columns.py` is **touches-shared** with schema-views but is **not modified** by this plan (it is read via the existing `/columns` fetch). No files are deleted.

---

## Expected Behaviour

### Backend `get_result()` — offline unit-testable (pure, set `_raw`)

- **`ListForeignKeysQuery`:** a `_raw` row with `on_update="c"`, `on_delete="a"`, `columns=["customer_id"]`, `ref_columns=["id"]`, `ref_schema="public"`, `ref_table="customers"` → `{name, columns:["customer_id"], refSchema:"public", refTable:"customers", refColumns:["id"], onUpdate:"CASCADE", onDelete:"NO ACTION"}`. Every action code (`a/r/c/n/d`) maps to its string. Empty `_raw` → `[]`. `get_result` before `apply` → `RuntimeError`.
- **`ListConstraintsQuery`:** `contype` `p`/`u`/`c` → `"primaryKey"`/`"unique"`/`"check"`; `definition` passed through from `pg_get_constraintdef`; `columns` array passed through; empty `_raw` → `[]`.
- **`ListIndexesQuery`:** `{name, definition, unique, primary}` passed through with booleans; empty `_raw` → `[]`.

### Frontend `getStructure` — offline unit-testable (mock fetch)

- Calls `GET /api/{conn}/{db}/{schema}/{name}/structure` and returns the parsed `{indexes, constraints, foreignKeys}`; a non-OK response throws the backend `detail` (shared `getJson` behaviour).

### `StructurePanel` — live-verify (layout, scroll, selection)

- Opening "Open structure" on a table shows four labelled sections (Columns / Indexes / Constraints / Foreign Keys); each grid is read-only (no cell editing); the panel scrolls when the combined sections overflow the tab.
- A table with no FKs still shows a "Foreign Keys" section (empty grid); same for empty Indexes/Constraints.
- Array columns (FK `columns`/`refColumns`, constraint `columns`) render as comma-joined strings.
- Selecting a row in the Foreign Keys grid opens the referenced table in the Dock (via `openReferencedTable`); if the referenced table's navigator node is already loaded and visible it is highlighted, otherwise only the tab opens (no error).

### Controller routing — live-verify

- `openReferencedTable` opens (or focuses, via the existing `focusPanel` dedup) the referenced table; re-selecting the same FK row re-focuses the already-open tab rather than duplicating it.
- A `"table"` opened normally from the navigator still reveals/highlights its node (regression: `openTable` with a real `node` still calls `selectNode`).

### Backend integration — live-verify (needs a real DB with FKs/indexes/checks)

- `GET …/{table}/structure` for a table with a PK, a unique index, a check constraint, and an FK returns all four in the right buckets; the FK carries the referenced schema/table/columns and the correct on-update/on-delete actions.

---

## Verification

- **Backend:** `cd backend && pytest tests/test_table_structure.py` green; full `pytest` for regressions.
- **Frontend:** `cd frontend && tsc --noEmit` (or `npm run build`) clean; `vitest run` — the `api.test.ts` `getStructure` case passes.
- **Grep invariants:** `grep -rn 'StructurePanel(' frontend/src` (three-arg, one call); `grep -rn 'openReferencedTable' frontend/src` (defined once, called from the `openStructure` callback); `grep -rn 'contype' backend/app` (only `table_structure.py`); `grep -rn 'CREATE INDEX\|ADD CONSTRAINT\|DROP INDEX' backend frontend` — zero DDL (Non-Goal).
- **Manual smoke (chrome-devtools, `:5173` + backend against a Postgres with FKs/indexes/checks):** right-click a table → Open structure → four sections visible + scroll; select an FK row → the referenced table opens (and highlights in the navigator if already expanded to); an empty-FK table still shows the section. Scope DevTools queries to the structure panel by its Dock panel id (`…::structure`) to avoid the coexisting data panels (`LIBRARY_NOTES.md` / MEMORY: scope by class/panel id).

---

## Potential Challenges

- **`Tree.selectNode` no-ops on an unloaded/collapsed target** — the FK reveal cannot force a lazy expand (no library expand-to-node API); mitigation is the documented best-effort reveal (walk loaded nodes; open the Dock tab regardless), with the fuller reveal noted as a library friction, not built.
- **No cell-click / row-activate event on `Table`** — FK click-through must ride `"selectionchange"`; mitigation is single-selection on the FK grid and resolving the selected record back to its `ForeignKeyMeta` via a per-row map. (A link-cell renderer would be cleaner but needs a library `ColumnConfig.renderer`, out of scope.)
- **Array fields have no array renderer** — pre-join `columns`/`refColumns` to comma-separated display strings when loading the `MemoryStore`; keep the raw FK object addressable for the click-through.
- **`StructurePanel` signature change ripples to schema-views** — schema-views reuses `StructurePanel` unchanged and does not construct it (it uses a separate `ViewWorkPanel` for Definition), so widening the constructor affects only the single `openStructure` caller; confirm with the grep invariant before/after.
- **Composite FK column pairing** — `columns[i]` pairs with `refColumns[i]`; the `unnest(... WITH ORDINALITY)` ORDER BY the key ordinal preserves pairing. Display shows both joined lists; a mis-order would only affect the (informational) display, never the click-through (which uses `refSchema`/`refTable`).
- **Index `unique`/`primary` flags** — `pg_indexes` alone lacks them; the `pg_index` join supplies them. Verify the join keys the index by `indexrelid` within the right schema so a same-named index in another schema can't leak flags.
- **Empty-section readability** — the fixed four-section layout intentionally shows empty grids (a deviation from the navigator's omit-empties style); confirm an empty grid renders its header cleanly rather than collapsing to zero height.

---

## Critical Files

- [`frontend/src/dock/StructurePanel.ts`](frontend/src/dock/StructurePanel.ts) — the panel to enrich (currently a single Columns grid); the read-only `Table` + `MemoryStore` idiom to replicate per section.
- [`frontend/src/dock/RoleGrantsPanel.ts`](frontend/src/dock/RoleGrantsPanel.ts), [`frontend/src/properties/PropertiesPanel.ts`](frontend/src/properties/PropertiesPanel.ts) — the read-only-grid-over-`MemoryStore` patterns the new sections mirror.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — `openStructure`/`openTable`/`syncToPanel`/`_openPanels`; where the FK-open callback and `openReferencedTable`/`findLoadedNode` land, and where `node` becomes optional.
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) — how nodes carry `node.data as DbObjectRef` (the shape `findLoadedNode` matches on) and how selection opens a table (the model the FK click-through mirrors).
- [`frontend/src/data/api.ts`](frontend/src/data/api.ts) — the `getJson<T>` client `getStructure` extends.
- [`backend/app/operations/role_detail.py`](backend/app/operations/role_detail.py) — the multi-query, `$1`-bound, array-returning `Query` shape the three structure queries follow.
- [`backend/app/operations/list_objects.py`](backend/app/operations/list_objects.py), [`backend/app/operations/list_columns.py`](backend/app/operations/list_columns.py) — the plain-dict `get_result` and the `information_schema`/`pg_catalog` introspection conventions.
- [`backend/app/main.py`](backend/app/main.py) — the acquire→construct→apply→get_result route shape (the combined `/roles/{role}` at [`:227`](backend/app/main.py#L227) is the closest precedent) and `_columns_for` gate.
- [`backend/app/operations/base.py`](backend/app/operations/base.py) — the `Query`/`Command` base contract.
- [`backend/tests/test_role_detail.py`](backend/tests/test_role_detail.py), [`backend/tests/conftest.py`](backend/tests/conftest.py) — the `NO_CONN` + set-`_raw` pure-test pattern.
- [`frontend/src/contract.ts`](frontend/src/contract.ts) — where the new metadata interfaces mirror the backend dicts.
- [`plans/schema-views.md`](plans/schema-views.md) — the sibling plan sharing `StructurePanel.ts`/`SqlAdminController.ts`/`NavigatorTree.ts`; defer to it on the Definition tab and view/matview routing.
- [`plans/implemented/tsui-sql-admin.md`](plans/implemented/tsui-sql-admin.md) — the architecture bible (CQRS `Query`, `connectionId` namespacing, identifier validation, `TreeNode.data`, `Tree.selectNode`, the Dock open path).
- Library (read-only reference): [`component/table/Table.ts`](../../typescript-ui/src/typescript/lib/component/table/Table.ts) (only `"selectionchange"`), [`component/table/ColumnConfig.ts`](../../typescript-ui/src/typescript/lib/component/table/ColumnConfig.ts) (no renderer), [`component/tree/Tree.ts`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts) (`selectNode` visibility no-op; `getNodes` roots only).

---

## Non-Goals

- **DDL** — no CREATE/DROP INDEX, ADD/DROP CONSTRAINT, or any structure mutation; the grids are read-only, consistent with the app's deferred DDL.
- **A clickable/link-styled FK cell** — the library `Table` has no cell-click event or `ColumnConfig.renderer`; FK click-through rides row selection instead. Adding a link cell is a future library seam, not built here.
- **Forced navigator expand-to-target on FK reveal** — `Tree` has no public expand-path/find-by-ref API and `selectNode` no-ops on unloaded nodes; reveal is best-effort over already-loaded nodes only. A `Tree.revealByPredicate` library seam is a future improvement (a `LIBRARY_NOTES.md` friction), not built here.
- **Indexes/FKs for views/matviews** — indexes and FKs are table concepts; views show only columns (and, per schema-views, their Definition). A materialized view *can* carry indexes, but surfacing them is deferred with the rest of matview-specific structure.
- **Modifying `StructurePanel`'s tab structure or adding a Definition view** — owned by [`schema-views.md`](plans/schema-views.md); this plan only enriches the interior grids.
- **Editing `list_columns.py`** — this plan reads `/columns` unchanged; matview-column coverage is schema-views' change.
- **Constraint/index column-level cross-linking** (e.g. clicking a check's referenced column) — only the FK referenced-table click-through is built; other facets are display-only.
- **Trigger / rule / partition introspection** — out of scope; only indexes, constraints (PK/unique/check), and FKs.
