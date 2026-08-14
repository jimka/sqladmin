---
touches-shared:
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/navigator/objectMenu.ts
  - frontend/src/navigator/objectKinds.ts
  - frontend/src/navigator/objectGlyphs.ts
  - frontend/src/contract.ts
  - frontend/src/data/api.ts
  - frontend/src/SqlAdminController.ts
  - frontend/src/properties/PropertiesPanel.ts
  - backend/app/main.py
  - backend/app/operations/__init__.py
  - backend/app/operations/table_structure.py
  - backend/app/operations/graph.py
---

# Navigator Indexes Category — Implementation Plan

## Overview

Add a schema-level "Indexes" category to the Database navigator, alongside Tables/Views/Materialized Views/Sequences/Functions/Types. It is a flat list of every index in the schema, spanning every table — not nested under each table's own node — because indexes aren't scoped to one category the way a table row is. Each leaf shows which table it belongs to (`idx_name (on orders)`). Double-clicking a leaf (or its context menu's "Show info") opens a read-only info tab: the index's name, its full `CREATE INDEX` text, its unique/primary flags, and a link to its owning table.

The kind is threaded through the same registry every existing kind uses: [`frontend/src/navigator/objectKinds.ts`](frontend/src/navigator/objectKinds.ts)'s `OBJECT_KINDS` (glyph + category label + `isRelation`), [`objectGlyphs.ts`](frontend/src/navigator/objectGlyphs.ts)'s glyph registration, [`NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts)'s `loadObjects`/`objectLeaf`/`leafLabel`, [`objectMenu.ts`](frontend/src/navigator/objectMenu.ts)'s per-kind menu, and a new controller open-method + Dock panel. On the backend, the navigator list is served by **reusing** the schema-wide `SchemaIndexesQuery` that already exists in [`backend/app/operations/graph.py:203`](backend/app/operations/graph.py#L203) — no new Python `Query` class is needed for the list. A small new `IndexDetailQuery` (mirroring `SequenceDetailQuery`) backs the info tab's per-index fetch.

---

## Architecture Decisions

### The schema-wide list reuses `SchemaIndexesQuery`; no new list query

The new `GET /api/{connection_id}/{database}/{schema}/indexes` route calls the existing `SchemaIndexesQuery` ([graph.py:203](backend/app/operations/graph.py#L203)) and flattens its rows with one new pure helper, `flatten_schema_indexes` — no new list `Query` class is written.[^reuse-schema-indexes]

### A dedicated `IndexDetailQuery` backs the info tab

The info tab fetches its own detail fresh on open through a new `IndexDetailQuery` ([table_structure.py](backend/app/operations/table_structure.py), beside `ListIndexesQuery`), mirroring `SequenceDetailQuery`'s single-row-or-`NotFound` shape and constructor exactly, located by schema + index name alone.[^detail-fetch-choice] Its route, `GET /api/{connection_id}/{database}/{schema}/{name}/index`, reuses the same generic per-object path segment `/sequence` already established ([main.py:560](backend/app/main.py#L560): "the per-object route namespace is generic").

### `DbObjectRef` gains exactly one new field: `table`

Mirrors how a function leaf's ref carries `signature`/`isProcedure` — short identity/disambiguation fields, not the routine's full body. An index leaf's ref carries only `table` (the owning table's name), for the tree label and the "open table" action; the full `CREATE INDEX` text is fetched into the tab, never stored on the ref.

### Read-only display, not the `DefinitionEditor`/Save composition

The definition text renders in a bare, read-only, SQL-highlighted `CodeEditor` — the pattern `QueryPanel.showPlan` already uses for the EXPLAIN plan pane ([QueryPanel.ts:1108-1114](frontend/src/dock/QueryPanel.ts#L1108)) — above a small read-only `LabeledFieldSet` (Table link, Unique, Primary) mirroring `SequenceInfoPanel`'s field-set shape ([SequenceInfoPanel.ts:162-167](frontend/src/dock/SequenceInfoPanel.ts#L162)).[^readonly-panel] Unlike a sequence's nullable `ownedBy`, the Table link is unconditional — an index always belongs to exactly one table.

### "Open table" jumps to the table's Structure tab, not its data tab

Both the info tab's Table link and the context menu's "Open table" item call `openReferencedStructure` — the same method `SequenceInfoPanel`'s "Owned by column" link uses ([SqlAdminController.ts:658](frontend/src/SqlAdminController.ts#L658)) — not `openReferencedTable`, the different link `StructurePanel`'s foreign-key grid uses to open a referenced row's data.[^open-table-target]

### Glyph: `magnifying-glass`

Not yet registered anywhere in this app (checked `objectGlyphs.ts` and grepped the rest of `frontend/src`). Evokes a lookup structure, matching every other kind's one-glyph-per-kind convention.

---

## Public API

### Backend — `flatten_schema_indexes` (`backend/app/operations/graph.py`, appended near `assemble_schema_graph`/`assemble_database_graph`)

```python
def flatten_schema_indexes(rows: list[dict]) -> list[dict]:
    """SchemaIndexesQuery's {schema, table, payload} rows -> the flat
    per-index wire shape [{name, definition, unique, primary, table}],
    preserving input order (SchemaIndexesQuery orders by schema, table, name)."""
```

### Backend — `IndexDetailQuery` (`backend/app/operations/table_structure.py`, appended after `ListIndexesQuery`)

```python
class IndexDetailQuery(Query):
    """One index's definition, flags, and owning table, by schema + index name."""
    def __init__(self, conn: asyncpg.Connection, index: TableRef) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> dict:
        # {"name": str, "definition": str, "unique": bool, "primary": bool, "table": str}
        # Raises RuntimeError before apply(); raises NotFound when no row matches.
```

### Backend — routes (`backend/app/main.py`)

```python
@app.get("/api/{connection_id}/{database}/{schema}/indexes")
async def indexes(connection_id: str, database: str, schema: str,
                   session: Session = Depends(require_session)) -> list[dict]: ...
    # SchemaIndexesQuery(c, schema) -> flatten_schema_indexes(...)
    # Returns: [{name, definition, unique, primary, table}]

@app.get("/api/{connection_id}/{database}/{schema}/{name}/index")
async def index_detail(connection_id: str, database: str, schema: str, name: str,
                        session: Session = Depends(require_session)) -> dict: ...
    # IndexDetailQuery(c, TableRef(database, schema, name)).get_result()
    # Returns: {name, definition, unique, primary, table}; 404 (NotFound) if absent.
```

### Contract — `frontend/src/contract.ts`

```ts
// Extend the union (append; do not rewrite):
export type DbObjectKind =
    | "database" | "schema" | "table" | "view" | "materializedView" | "sequence"
    | "function" | "type" | "index";

// Extend DbObjectRef (append field; existing optional fields unchanged):
export interface DbObjectRef {
    // ...existing fields...
    /** The owning table's name, set only on an index leaf (kind: "index"). */
    table?: string;
}

/** One index's full detail — used by both the schema-wide Indexes list and
 *  the info tab's per-index fetch on open (IndexDetailQuery). */
export interface IndexDetail {
    name: string;
    definition: string;
    unique: boolean;
    primary: boolean;
    table: string;
}
```

### API client — `frontend/src/data/api.ts`

```ts
/** The navigator's Indexes category level — every index across every table in the schema. */
export function getIndexes(connectionId: string, database: string, schema: string): Promise<IndexDetail[]>;
// GET /api/${connectionId}/${database}/${schema}/indexes

/** Fetch one index's full definition, flags, and owning table (IndexDetailQuery). */
export function getIndexDetail(ref: DbObjectRef): Promise<IndexDetail>;
// GET /api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/index
```

### Panel — `frontend/src/dock/IndexInfoPanel.ts` (new)

```ts
export interface IndexInfoPanelDeps {
    schema: string;
    onOpenTable: (schema: string, table: string) => void;
}

export class IndexInfoPanel extends Container {
    constructor(detail: IndexDetail, deps: IndexInfoPanelDeps);
}
```

### Controller — `frontend/src/SqlAdminController.ts`

```ts
async openIndex(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void>;
private indexInfoPanelId(ref: DbObjectRef): string; // `${this.panelId(ref)}::index`
```

---

## Internal Structure

### `IndexDetailQuery._SQL`

Same catalog join as `ListIndexesQuery`, but keyed by index name instead of table name, and with the owning table name added to the SELECT list:

```sql
SELECT
    i.indexname     AS name,
    i.indexdef      AS definition,
    ix.indisunique  AS unique,
    ix.indisprimary AS primary,
    i.tablename     AS table_name
FROM pg_indexes i
JOIN pg_class ic     ON ic.relname = i.indexname
JOIN pg_namespace n  ON n.oid = ic.relnamespace
JOIN pg_index ix     ON ix.indexrelid = ic.oid
WHERE i.schemaname = $1 AND i.indexname = $2 AND n.nspname = $1
```

`get_result()` raises `RuntimeError` before `apply()`; raises `NotFound` when the fetch returned zero rows; otherwise returns `{"name": ..., "definition": ..., "unique": bool(...), "primary": bool(...), "table": r["table_name"]}` (the raw SQL alias is `table_name` — `table` is reserved for the *wire* key only, since `TABLE` is a SQL keyword).

### `IndexInfoPanel` layout

`Border({spacing: 0})`: NORTH = a `LabeledFieldSet` legend `${schema}.${name}`, rows `Table` (a `Link` wired to `deps.onOpenTable`), `Unique` (`Text`, "Yes"/"No"), `Primary` (`Text`, "Yes"/"No"); CENTER = `new CodeEditor(detail.definition, { language: "sql", readOnly: true })`. No toolbar, no Save button, no `dispose()` (every child is a registered descendant; the Dock's teardown on tab close reaches each one, same as `SequenceInfoPanel`).

### `NavigatorTree.ts` merge (mirrors the function/type merge exactly)

```ts
const [objects, functions, types, indexes] = await Promise.all([
    getObjects(conn, database, schema),
    getFunctions(conn, database, schema),
    getTypes(conn, database, schema),
    getIndexes(conn, database, schema),
]);

const combined: DbObject[] = [
    ...objects,
    ...functions.map(f => ({ name: f.name, kind: "function" as const, signature: f.signature, isProcedure: f.isProcedure })),
    ...types.map(t => ({ name: t.name, kind: "type" as const })),
    ...indexes.map(i => ({ name: i.name, kind: "index" as const, table: i.table })),
];
```

`leafLabel` gains one branch, alongside the existing function-signature branch:

| `o.kind` | Label |
|---|---|
| `"function"` | `${o.name}(${o.signature ?? ""})` |
| `"index"` | `${o.name} (on ${o.table ?? "?"})` |
| anything else | `o.name` |

---

## Ordered Implementation Steps

1. **`backend/app/operations/table_structure.py`** — add `from ..errors import NotFound` to the imports. Append `IndexDetailQuery` after `ListIndexesQuery` (Internal Structure above). Follow the file's existing docstring/structure style.

2. **`backend/app/operations/graph.py`** — append `flatten_schema_indexes` (Public API above) after `assemble_database_graph`, at the end of the file.

3. **`backend/app/operations/__init__.py`** — add `IndexDetailQuery` to the `from .table_structure import (...)` block (alphabetically first: before `ListConstraintsQuery`). Add `flatten_schema_indexes` to the `from .graph import (...)` block (alphabetically last: after `assemble_schema_graph`). Add `"IndexDetailQuery"` to `__all__` (grouped beside `"ListIndexesQuery"`) and `"flatten_schema_indexes"` to `__all__` (grouped beside `"assemble_database_graph"`). Additive only — do not reorder existing entries.

4. **`backend/app/main.py`** — add `IndexDetailQuery` to the `from .operations import (...)` block (alphabetically, after `FunctionDefinitionQuery`, before `InsertRowCommand`). Add `flatten_schema_indexes` to the same block (alphabetically last, after `assemble_schema_graph`). Add the `indexes` route (Public API above) in the `# --- Schema introspection ---` block, right after the `types` route ([main.py:326](backend/app/main.py#L326), before `dependencies`). Add the `index_detail` route right after the `sequence_detail` route ([main.py:575](backend/app/main.py#L575), before the `# --- Role introspection ---` section header). Both follow the existing thin-route shape (`session_pool_for(...).acquire()` -> construct op -> `apply()` -> `get_result()`).

5. **`backend/tests/test_table_structure.py`** — add `IndexDetailQuery` tests, mirroring `test_sequence_detail.py`'s style: a full raw row (including `table_name`) -> the mapped dict; an empty `_raw` -> `NotFound`; add `IndexDetailQuery(NO_CONN, TABLE)` to the existing `test_get_result_before_apply_raises` loop ([test_table_structure.py:157](backend/tests/test_table_structure.py#L157)).

6. **`backend/tests/test_graph.py`** — add `flatten_schema_indexes` tests: `SchemaIndexesQuery`-shaped rows -> the flattened `{name, definition, unique, primary, table}` list; `[] -> []`.

7. **`frontend/src/contract.ts`** — append `"index"` to `DbObjectKind`. Append the `table?: string` field to `DbObjectRef` (after `isProcedure`). Add the `IndexDetail` interface, placed after `IndexMeta` ([contract.ts:480](frontend/src/contract.ts#L480)).

8. **`frontend/src/data/api.ts`** — add `IndexDetail` to the `import type { ... } from "../contract"` list (near `IndexSpec`). Add `getIndexes` after `getTypes` ([api.ts:201](frontend/src/data/api.ts#L201)). Add `getIndexDetail` after `getSequenceDetail` ([api.ts:264](frontend/src/data/api.ts#L264)).

9. **`frontend/src/navigator/objectKinds.ts`** — append one entry to `OBJECT_KINDS` (after the `type` entry): `{ kind: "index", glyph: "magnifying-glass", categoryLabel: "Indexes", isRelation: false }`, with a one-line comment matching the file's existing per-phase comments.

10. **`frontend/src/navigator/objectGlyphs.ts`** — import `magnifying_glass` from `@jimka/typescript-ui/glyphs/solid/magnifying_glass`; add it to the `Glyph.register(...)` call. No other change (`KIND_GLYPH` derives from `OBJECT_KINDS`).

11. **`frontend/src/navigator/NavigatorTree.ts`** —
    - Import `getIndexes` alongside the existing `data/api` import ([NavigatorTree.ts:27](frontend/src/navigator/NavigatorTree.ts#L27)).
    - Add `table?: string;` to the `DbObject` interface ([NavigatorTree.ts:53](frontend/src/navigator/NavigatorTree.ts#L53)).
    - Update `loadObjects` per Internal Structure above (4-way `Promise.all`, `indexes` merged into `combined`).
    - In `objectLeaf`, spread `table` onto the ref when present, alongside the existing `signature`/`isProcedure` spreads ([NavigatorTree.ts:285](frontend/src/navigator/NavigatorTree.ts#L285)).
    - Add the `"index"` branch to `leafLabel` (Internal Structure table above).
    - In the `dblclick` handler, add an `index` branch before the generic `isRelation` check, mirroring the existing `sequence`/`function` branches ([NavigatorTree.ts:145-159](frontend/src/navigator/NavigatorTree.ts#L145)):
      ```ts
      if (ref && ref.kind === "index") {
          void this.controller.openIndex(ref, node);
          return;
      }
      ```

12. **`frontend/src/navigator/objectMenu.ts`** —
    - Add `"openIndex" | "openReferencedStructure"` to the `ObjectMenuActions` Pick type ([objectMenu.ts:30-41](frontend/src/navigator/objectMenu.ts#L30)).
    - Add `indexMenuItems`, mirroring `sequenceMenuItems` ([objectMenu.ts:73](frontend/src/navigator/objectMenu.ts#L73)):
      ```ts
      function indexMenuItems(ref: DbObjectRef, actions: ObjectMenuActions, node?: TreeNode): MenuItemConfig[] {
          return [
              { text: "Show info", glyph: "magnifying-glass", action: () => void actions.openIndex(ref, node) },
              { text: "Open table", glyph: "table-columns", action: () => actions.openReferencedStructure({
                  connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name: ref.table, kind: "table",
              }) },
          ];
      }
      ```
    - Add the dispatch branch in `buildObjectMenuItems`, after the `"type"` branch and before the `isRelationKind` fallback ([objectMenu.ts:211-217](frontend/src/navigator/objectMenu.ts#L211)): `if (ref.kind === "index") { return indexMenuItems(ref, actions, node); }`.

13. **`frontend/src/dock/IndexInfoPanel.ts`** — new file. Class-first `extends Container` (Public API / Internal Structure above), exported via `callable()` per [COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) (d).

14. **`frontend/src/SqlAdminController.ts`** —
    - Add `import { getIndexDetail } from "./data/api";` as its own line, mirroring [line 28](frontend/src/SqlAdminController.ts#L28)'s `getSequenceDetail` import (additive; do not touch the large grouped import on line 27).
    - Add `import { IndexInfoPanel } from "./dock/IndexInfoPanel";` after the `SequenceInfoPanel` import ([SqlAdminController.ts:64](frontend/src/SqlAdminController.ts#L64)).
    - Add `openIndex` right after `openSequence` ([SqlAdminController.ts:667](frontend/src/SqlAdminController.ts#L667)), before `openStructure`:
      ```ts
      async openIndex(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void> {
          const id = this.indexInfoPanelId(ref);

          if (this.dock.focusPanel(id)) {
              return;
          }

          this.openAsyncPanel({
              id,
              title  : ref.name ?? id,
              glyph  : "magnifying-glass",
              tooltip: this.panelTooltip(ref),
              ref,
          }, async () => {
              const [detail, resolvedNode] = await Promise.all([getIndexDetail(ref), Promise.resolve(node)]);

              this._openPanels.set(id, { ref, node: resolvedNode ?? null, detail: "info" });
              this.syncToPanel(id);

              return IndexInfoPanel(detail, {
                  schema: ref.schema!,
                  onOpenTable: (schema, table) => this.openReferencedStructure({
                      connectionId: ref.connectionId,
                      database    : ref.database,
                      schema,
                      name        : table,
                      kind        : "table",
                  }),
              });
          });
      }
      ```
    - Add `indexInfoPanelId` beside the other `*PanelId` helpers ([SqlAdminController.ts:2852-2854](frontend/src/SqlAdminController.ts#L2852), right after `sequenceInfoPanelId`): `private indexInfoPanelId(ref: DbObjectRef): string { return \`${this.panelId(ref)}::index\`; }`.

15. **`frontend/src/properties/PropertiesPanel.ts`** — add `case "index": return indexRows(ref);` to `propertyRows`'s switch ([PropertiesPanel.ts:29-53](frontend/src/properties/PropertiesPanel.ts#L29)), after `case "type"`. Add `indexRows`, mirroring `functionRows`:
    ```ts
    function indexRows(ref: DbObjectRef): PropertyValueRow[] {
        return [
            { property: "Name", value: ref.name ?? "—" },
            { property: "Schema", value: ref.schema ?? "—" },
            { property: "Database", value: ref.database ?? "—" },
            { property: "Type", value: "Index" },
            { property: "Table", value: ref.table ?? "—" },
        ];
    }
    ```
    Add an `"index"` case to `relationTypeLabel`, after the `"sequence"` case ([PropertiesPanel.ts:117-119](frontend/src/properties/PropertiesPanel.ts#L117)): `if (kind === "index") { return "Index"; }`.

16. **`frontend/tests/navigator/objectKinds.test.ts`** — update the four assertions that enumerate kinds: the `OBJECT_KINDS` order list, the categoryLabel loop, `isRelationKind`'s false-list, and `objectCategories()`'s expected array — each gains `"index"` (`{ label: "Indexes", kind: "index" }` for the last one), appended at the end.

17. **`frontend/tests/navigator/objectMenu.test.ts`** — add `openIndex: vi.fn(), openReferencedStructure: vi.fn(),` to `stubActions()`. Add an `indexRef()` helper (`{ connectionId: CONN, database: DB, schema: SCHEMA, name: "idx1", kind: "index", table: "t1" }`). Add a test: `buildObjectMenuItems(indexRef(), stubActions())` -> `["Show info", "Open table"]`.

18. **Checkpoints:**
    - `cd backend && poetry run python -m pytest` (worktree: `python -m pytest`, not bare `pytest`) — green, including the new `IndexDetailQuery`/`flatten_schema_indexes` tests.
    - `cd frontend && npm run typecheck && npm test` — green, including the updated `objectKinds.test.ts`/`objectMenu.test.ts`.
    - `grep -rn '"index"' frontend/src/navigator/objectKinds.ts frontend/src/contract.ts` — the new kind is registered in both.
    - `grep -rn "/indexes\|/index\b" backend/app/main.py frontend/src/data/api.ts` — both routes and both clients exist.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `backend/app/operations/table_structure.py` (`IndexDetailQuery`, `NotFound` import) |
| Modify | `backend/app/operations/graph.py` (`flatten_schema_indexes`) |
| Modify | `backend/app/operations/__init__.py` (export both) |
| Modify | `backend/app/main.py` (`/indexes`, `/{name}/index` routes) |
| Modify | `backend/tests/test_table_structure.py` (`IndexDetailQuery` tests) |
| Modify | `backend/tests/test_graph.py` (`flatten_schema_indexes` tests) |
| Modify | `frontend/src/contract.ts` (`DbObjectKind`, `DbObjectRef.table`, `IndexDetail`) |
| Modify | `frontend/src/data/api.ts` (`getIndexes`, `getIndexDetail`) |
| Modify | `frontend/src/navigator/objectKinds.ts` (`index` registry entry) |
| Modify | `frontend/src/navigator/objectGlyphs.ts` (`magnifying-glass` registration) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (`DbObject.table`, `loadObjects`, `objectLeaf`, `leafLabel`, `dblclick`) |
| Modify | `frontend/src/navigator/objectMenu.ts` (`indexMenuItems`, dispatch, `ObjectMenuActions`) |
| Create | `frontend/src/dock/IndexInfoPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (`openIndex`, `indexInfoPanelId`, imports) |
| Modify | `frontend/src/properties/PropertiesPanel.ts` (`indexRows`, `relationTypeLabel` case) |
| Modify | `frontend/tests/navigator/objectKinds.test.ts` (kind-list assertions) |
| Modify | `frontend/tests/navigator/objectMenu.test.ts` (index menu test) |

---

## Expected Behaviour

**Backend, unit-testable:**

- `IndexDetailQuery.get_result()` with a full raw row `{"name": "customers_pkey", "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)", "unique": True, "primary": True, "table_name": "customers"}` -> `{"name": "customers_pkey", "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)", "unique": True, "primary": True, "table": "customers"}`.
- `IndexDetailQuery.get_result()` with `_raw = []` -> raises `NotFound`.
- `IndexDetailQuery.get_result()` before `apply()` -> raises `RuntimeError`.
- `flatten_schema_indexes([{"schema": "public", "table": "customers", "payload": {"name": "customers_pkey", "definition": "...", "unique": True, "primary": True}}])` -> `[{"name": "customers_pkey", "definition": "...", "unique": True, "primary": True, "table": "customers"}]`.
- `flatten_schema_indexes([])` -> `[]`.

**Frontend, unit-testable:**

- `OBJECT_KINDS` has an `index` entry with `categoryLabel: "Indexes"` and `isRelation: false`; `objectCategories()`'s last entry is `{ label: "Indexes", kind: "index" }`; `isRelationKind("index")` is `false`.
- `buildObjectMenuItems(indexRef(), stubActions())` -> item texts `["Show info", "Open table"]`; invoking "Show info"'s action calls `actions.openIndex(ref, undefined)`; invoking "Open table"'s action calls `actions.openReferencedStructure` with `name` set to the ref's `table` and `kind: "table"`.

**Manual-verify (live navigator/Dock; the harness can't drive tree events or CodeEditor rendering — smoke via `npm run dev`):**

- A schema with indexes shows an "Indexes" category (magnifying-glass glyph); each leaf reads `<index name> (on <table name>)`, e.g. `products_pkey (on products)`.
- A schema with zero indexes shows no "Indexes" category (matches the existing empty-category-omitted behaviour of every other category).
- Double-clicking an index leaf opens a tab titled with the bare index name, showing: a "Table" row that is a clickable link, "Unique"/"Primary" rows reading Yes/No, and the full `CREATE INDEX` text in a read-only, selectable, SQL-highlighted editor.
- Right-clicking an index leaf shows exactly two items: "Show info" and "Open table" (no DDL actions).
- Clicking the Table link, or the context menu's "Open table", opens (or focuses) that table's **Structure** tab and reveals/selects the table in the navigator — landing on the same Indexes section that lists this exact index.
- Re-opening an already-open index tab (double-click again, or "Show info" again) focuses the existing tab rather than opening a duplicate.
- Single-clicking (selecting) an index leaf shows Name/Schema/Database/Type: Index/Table in the Properties sidebar.
- Regression: double-clicking a table/view/sequence/function still behaves as before; the sequence/function/type context menus are unchanged.

---

## Verification

- `cd backend && poetry run python -m pytest` — new `IndexDetailQuery`/`flatten_schema_indexes` tests green; full suite green.
- `cd frontend && npm run typecheck` — clean (new contract fields/types, client functions, panel, controller method all resolve).
- `cd frontend && npm test` — updated `objectKinds.test.ts`/`objectMenu.test.ts` green.
- Manual smoke per Expected Behaviour, entry point: the navigator tree (WEST sidebar) against a schema with at least one indexed table (e.g. the seed `sales.products` primary key).

---

## Critical Files

- [backend/app/operations/graph.py](backend/app/operations/graph.py) — `SchemaIndexesQuery` (reused verbatim) and the `assemble_schema_graph`/`assemble_database_graph` pure-helper pattern `flatten_schema_indexes` follows.
- [backend/app/operations/table_structure.py](backend/app/operations/table_structure.py) — `ListIndexesQuery`, the SQL/shape `IndexDetailQuery` is derived from.
- [backend/app/main.py:552](backend/app/main.py#L552) — the `sequence_detail` route, the generic per-object-segment precedent `index_detail` mirrors.
- [frontend/src/dock/SequenceInfoPanel.ts](frontend/src/dock/SequenceInfoPanel.ts) — `onOpenOwner`/the Table-link pattern `IndexInfoPanel` mirrors, and `SqlAdminController.openSequence` — the dedupe/`openAsyncPanel` idiom `openIndex` copies.
- [frontend/src/dock/QueryPanel.ts:1108](frontend/src/dock/QueryPanel.ts#L1108) — the read-only `CodeEditor` precedent for showing SQL text with no edit affordance.
- [frontend/src/dock/StructurePanel.ts](frontend/src/dock/StructurePanel.ts) — `buildIndexesGrid` (unchanged; the table-scoped Indexes section this info tab's "Open table" jumps to) and the `onOpenReferenced` link precedent this plan deliberately does *not* use (see Architecture Decisions).
- [frontend/src/navigator/objectKinds.ts](frontend/src/navigator/objectKinds.ts) — the registry extension pattern (file-header comment) every new kind, including this one, follows.
- [plans/implemented/sequence-info-tab.md](plans/implemented/sequence-info-tab.md) and [plans/implemented/function-type-ddl.md](plans/implemented/function-type-ddl.md) — the two prior "add a new listed, non-relation kind" phases this plan follows.

---

## Non-Goals

- **No CREATE/DROP INDEX from the new menu or tab** — those already exist on `StructurePanel`'s Indexes section (`onCreateIndex`/`onDropIndex`); duplicating them here is out of scope.
- **No live refresh/polling in the info tab** — a point-in-time read on open, matching every other detail tab.
- **No nesting under each table's own node** — the category is a flat, schema-wide list by explicit design decision.
- **No change to `/structure`'s `IndexMeta` shape or `StructurePanel.buildIndexesGrid`** — the per-table Structure tab is untouched.
- **No change to `ListObjectsQuery`/`/objects`** — indexes get their own route, following the same precedent functions/types already set.

---

## Notes

[^reuse-schema-indexes]: A naive design would drop `ListIndexesQuery`'s `tablename` filter into a new schema-wide `Query` class. Investigation found `SchemaIndexesQuery` already does exactly this — it was built for the `/graph` endpoints as the schema-wide generalization of `ListIndexesQuery`, already returns each row tagged with its table, and is already called with a concrete (non-`None`) schema by the `schema_graph` route. Writing a second, near-duplicate query would contradict the codebase's own "generalize the per-table query to a schema scope" pattern that `SchemaTablesQuery`/`SchemaColumnsQuery`/`SchemaIndexesQuery`/etc. already establish.

[^detail-fetch-choice]: Fetching fresh on open (rather than trusting the navigator leaf's cached list data) matches every other info tab — `openSequence`, `openFunctionDefinition`, and `openStructure` all re-fetch their own detail rather than reusing whatever populated the tree. `IndexDetailQuery` needs no table parameter because index names are unique within a schema (every `pg_class`-backed object — table, view, sequence, index — shares one name namespace per schema), so schema + index name alone locates exactly one row; its constructor takes a `TableRef` used purely as a schema+name identity carrier, exactly as `SequenceDetailQuery` already reuses `TableRef.name` to hold a *sequence's* name rather than a table's. Three alternatives were considered for the info tab's data source: (a) carry the full `definition`/`unique`/`primary` on `DbObjectRef` itself, sourced from the one `/indexes` list fetch, and skip a second round trip; (b) re-fetch the same schema-wide `/indexes` list on open and filter client-side by name; (c) reuse the existing `/structure` route (`getStructure`) via a synthetic table ref, since `ListIndexesQuery`'s output is already embedded in it. (a) was rejected because it breaks the "always fetch fresh detail on open" shape and bloats `DbObjectRef` with a potentially large SQL string carried for the node's whole lifetime. (b) was rejected as wasteful — fetching every index in the schema to display one. (c) was rejected because `/structure` also fetches unrelated constraints/foreign keys, and mixing two different query paths (schema list for the tree, per-table structure for the tab) for one feature adds indirection without benefit. The chosen design — a dedicated `IndexDetailQuery`, scoped to exactly one index by name — costs one small new query class but keeps every info-tab open method the same shape and fetches only what the tab shows.

[^readonly-panel]: `DefinitionPanel`/`FunctionDefinitionPanel` both wrap `DefinitionEditor`, which always ships a dirty-gated Save toolbar — wrong here, since CREATE/DROP INDEX already live on `StructurePanel`'s `onCreateIndex`/`onDropIndex` and duplicating them is out of scope (see Non-Goals). `QueryPanel.showPlan`'s own comment states the read-only `CodeEditor`'s rationale: "Read-only (not disabled) keeps the plan selectable and copyable while blocking edits" — the same property wanted here, so the same construction (`{ language: "sql", readOnly: true }`, no toolbar) is reused directly rather than composing a new read-only wrapper.

[^open-table-target]: `StructurePanel`'s foreign-key grid link exists because an FK's referenced *row* lives in that table's data — `openReferencedTable` is the right target there. An index has no comparable "its own row" in the owning table; its relevant context is structural — the table's own Indexes section (`StructurePanel.buildIndexesGrid`, [StructurePanel.ts:324](frontend/src/dock/StructurePanel.ts#L324)) already lists this exact index — so the sequence's "Owned by column" precedent (which also jumps to Structure, for the same reason: the related fact lives in that table's structural metadata, not its rows) is the closer analogy.
