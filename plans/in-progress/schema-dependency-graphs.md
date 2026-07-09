# Schema Dependency & Inheritance Graphs — Implementation Plan

## Overview

Two new introspection-backed graphs, each opening as its own `DiagramView` Dock tab, reusing the existing diagram infrastructure end-to-end:

1. **View / materialized-view dependency graph** — "what breaks if I drop/alter this table?". Nodes are relations (tables + views + matviews); a directed edge runs `view -> underlying relation it reads`. A NEW backend endpoint queries the PostgreSQL dependency catalogs (`pg_depend` -> `pg_rewrite` -> `pg_class`) and returns a plain edge list per schema. The client never parses view SQL.
2. **Table inheritance / partitioning graph** — parent -> child from `pg_inherits` (covers both classic inheritance and declarative partitioning). A NEW backend endpoint returns parent/child edges per schema. Rendered as a top-to-bottom tree tab.

Both graphs reduce to the same shape — *nodes = the union of edge endpoints, plus directed edges* — so they share **one pure builder** ([frontend/src/data/buildRelationGraph.ts], new) and **one panel** ([frontend/src/dock/RelationGraphPanel.ts], new). They differ only in the backend endpoint that supplies the edges and in the ELK layout direction. Node activation reuses [`SqlAdminController.openReferencedTable`](frontend/src/SqlAdminController.ts#L446) exactly as the FK diagrams do. Rooted-at-a-relation variants reuse the already-tested generic graph ops in [frontend/src/data/relationDiagram.ts](frontend/src/data/relationDiagram.ts) (`rootedDiagram`) with no new UI.

The backend endpoints mirror the existing schema-level introspection routes (`/objects`, `/schemas`) — three-phase CQRS operations ([backend/app/operations/base.py](backend/app/operations/base.py)) returning plain camelCase dict edge lists, exactly like [`ListObjectsQuery`](backend/app/operations/list_objects.py). The frontend fetch client mirrors [`getObjects`](frontend/src/data/api.ts#L70).

---

## Architecture Decisions

### One shared builder + one shared panel, two endpoints

A dependency edge (`view -> underlying`) and an inheritance edge (`parent -> child`) are both just directed edges between two schema-qualified relations. So a single pure `buildRelationGraph(edges, homeSchema, layoutOptions)` assembles `DiagramData` for both, and a single `RelationGraphPanel` renders both. The two graphs differ only in (a) which endpoint supplies the edges and (b) the ELK direction (`RIGHT` for dependency, `DOWN` for the inheritance tree). This avoids duplicating the node-dedup/glyph/activation logic twice.

### Node ids are schema-qualified (`schema.name`), unlike the FK diagram

The FK schema diagram uses the bare table name as the node id because it is single-schema. Dependency and inheritance edges can cross schemas (a view depends on a table in another schema; a partition child can live elsewhere), so node ids here are `${schema}.${name}` to stay globally unique. The node's `data` field carries `{ schema, name, kind }` (a `RelationNodeData`) so the panel can open the exact relation on activation. `relationNodeId(ref)` is exported for the controller to build a matching root id.

### Activation is kind-aware (opens a view as a view, a table as a table)

`SchemaDiagramPanel`/`RelationDiagramPanel` pass `node.id` (a table name) and the controller hardcodes `kind: "table"`. Here a node can be a view/matview, so `RelationGraphPanel`'s activation reads the node's `RelationNodeData` and hands the controller a full `{ schema, name, kind }`; the controller forwards it to `openReferencedTable`, which already accepts any `DbObjectRef` kind and routes a view/matview to the read-only `ViewWorkPanel`.

### Backend returns inline camelCase dicts — no new dataclass

The existing schema-level list queries (`ListObjectsQuery`, `ListIndexesQuery`, `ListForeignKeysQuery`) build their contract dicts inline in `get_result()`; only the reusable value objects (`ColumnMeta`, `RoleSummary`) are dataclasses in `contract.py`. These two edge-list queries follow the list-query precedent: `get_result()` returns `[{"source": {...}, "target": {...}}]` directly. No `contract.py` dataclass is added (it would be inconsistent with the sibling list queries and is unused elsewhere).

### `relkind` maps to the existing `DbObjectKind` — no new kind

`pg_class.relkind` can be `r`/`p`/`f`/`v`/`m`. The backend collapses these to the three contract kinds the glyph map already knows: `{ r,p,f -> "table", v -> "view", m -> "materializedView" }`. A partitioned table (`p`) and a foreign table (`f`) render with the table glyph. No new `DbObjectKind`, so `KIND_GLYPH` and the whole navigator stay untouched.

### Schema-scoped queries (cross-schema dependents in *other* schemas are out of scope)

Both endpoints filter on the *subject* schema (`dependent_ns.nspname = $1` for dependencies; `parent_ns.nspname = $1` for inheritance). A dependent view living in a *different* schema than the table it reads is therefore not discovered — matching the single-schema scope of the existing FK diagram. Database-level cross-schema graphs are a sibling plan (`database-level-schema-diagram`). Documented as a known limitation, not a bug.

### Rooted variants reuse `rootedDiagram`; no new interactive controls

Entry from a view/table roots the graph at that relation. Rather than build a second interactive WEST-panel (à la `RelationDiagramPanel`), the controller pre-roots the fetched whole-schema graph with `rootedDiagram(full, root, "both", ∞)` (the generic, already-tested op in `relationDiagram.ts`) and renders it with the *same* `RelationGraphPanel`, passing `rootId` so the root node is emphasized. Direction `"both"` + unbounded depth shows the relation's full connected component (dependency/inheritance chains are shallow). Interactive direction/depth controls are a possible future enhancement, out of scope.

### Distinct dashed edge style is a soft dependency on the FK-diagram sibling plan

A dashed "depends-on" edge style is desirable to distinguish dependency edges from FK edges. The `fk-diagram-cardinality-and-index-coverage` plan **owns** adding `DiagramEdgeStyle` (incl. `dashed`) to `DiagramEdgeData` + `DiagramEdgeLayer`. This plan ships with **plain edges** by default and does not touch the library. Once that capability exists, one optional edit (Step 12) sets `style: { dashed: true }` on the dependency builder's edges. Treated as a soft dependency, never a blocker.

---

## Public API

### Frontend — `frontend/src/contract.ts` (new interfaces)

```typescript
/** One relation in a dependency / inheritance graph, schema-qualified. `kind`
 *  is the collapsed contract kind (partitioned/foreign tables arrive as "table"). */
export interface RelationNodeRef {
    schema: string;
    name: string;
    kind: DbObjectKind;
}

/** One directed relation edge: dependency (view -> underlying) or inheritance
 *  (parent -> child). Orientation is fixed by the endpoint. */
export interface RelationEdge {
    source: RelationNodeRef;
    target: RelationNodeRef;
}
```

### Frontend — `frontend/src/data/api.ts` (new fetchers)

```typescript
/** View/matview dependency edges for a schema (view -> underlying relation). */
export function getDependencies(connectionId: string, database: string, schema: string): Promise<RelationEdge[]>;

/** Inheritance/partition edges for a schema (parent -> child). */
export function getInheritance(connectionId: string, database: string, schema: string): Promise<RelationEdge[]>;
```

### Frontend — `frontend/src/data/buildRelationGraph.ts` (new, pure)

```typescript
import type { DiagramData } from "@jimka/typescript-ui/component/diagram";
import type { DbObjectKind, RelationEdge, RelationNodeRef } from "../contract";

/** Metadata stashed on each node's `data` so the panel can open the relation. */
export interface RelationNodeData {
    schema: string;
    name: string;
    kind: DbObjectKind;
}

/** The schema-qualified node id (`schema.name`). Exported so the controller can
 *  build a root id that matches a graph node. */
export function relationNodeId(ref: RelationNodeRef): string;

/** Assemble DiagramData from a directed relation edge list. Nodes are the union
 *  of edge endpoints (deduped by id); each carries its kind glyph and a
 *  RelationNodeData on `data`. A node in `homeSchema` is labelled by its bare
 *  name; a foreign-schema node by `schema.name`. Edges keep the input
 *  orientation; duplicate (source,target) pairs are deduped by edge id.
 *  Pure — type-only diagram imports, no UI-bundle runtime import. */
export function buildRelationGraph(
    edges: RelationEdge[],
    homeSchema: string,
    layoutOptions: Record<string, string>,
): DiagramData;
```

### Frontend — `frontend/src/dock/RelationGraphPanel.ts` (new)

```typescript
import type { Component } from "@jimka/typescript-ui/core";
import type { DiagramData } from "@jimka/typescript-ui/component/diagram";
import type { RelationNodeData } from "../data/buildRelationGraph";

/** A read-only relation-graph tab. Double-clicking a node invokes `onSelect`
 *  with that node's RelationNodeData. When `rootId` is given, that node is
 *  emphasized with an accent border. */
export function RelationGraphPanel(
    data: DiagramData,
    onSelect: (node: RelationNodeData) => void,
    rootId?: string,
): Component;
```

### Frontend — `SqlAdminController` (new public methods)

```typescript
async openSchemaDependencyGraph(ref: DbObjectRef, node?: TreeNode): Promise<void>;
async openRelationDependencyGraph(ref: DbObjectRef, node?: TreeNode): Promise<void>;
async openSchemaInheritanceGraph(ref: DbObjectRef, node?: TreeNode): Promise<void>;
async openRelationInheritanceGraph(ref: DbObjectRef, node?: TreeNode): Promise<void>;
```

### Backend — `backend/app/operations/` (new operations)

```python
class ListDependenciesQuery(Query):
    """View/matview dependency edges for a schema (pg_depend/pg_rewrite/pg_class)."""
    def __init__(self, conn: asyncpg.Connection, schema: str) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> list[dict]: ...   # [{"source": {...}, "target": {...}}]

class ListInheritanceQuery(Query):
    """Parent -> child edges for a schema (pg_inherits/pg_class)."""
    def __init__(self, conn: asyncpg.Connection, schema: str) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> list[dict]: ...   # [{"source": {...}, "target": {...}}]
```

---

## Internal Structure

### `buildRelationGraph` (pure)

```typescript
// keep in sync with KIND_GLYPH (navigator/objectGlyphs.ts); NOT imported — that
// module runs DOM side effects on import and would crash the node vitest env.
// Same discipline as buildSchemaDiagram.ts's TABLE_GLYPH.
const KIND_GLYPH: Record<DbObjectKind, string> = {
    database: "database", schema: "folder", table: "table",
    view: "eye", materializedView: "layer-group",
};
```

- Iterate `edges`; for each endpoint add a node keyed by `relationNodeId(ref)` (Map, first wins). Node: `{ id, label, glyph: KIND_GLYPH[kind], data: { schema, name, kind } }`. `label = ref.schema === homeSchema ? ref.name : relationNodeId(ref)`.
- Edge: `{ id: `${srcId}->${tgtId}`, source: srcId, target: tgtId }`. Dedup by edge id (a Map). No `data`/`style` in the default build.
- Return `{ nodes: [...map.values()], edges: [...map.values()], layoutOptions }`.

### Layout-option constants (in the controller)

```typescript
// Dependency graph reads left-to-right as a dependency flow (view -> underlying),
// matching the FK schema diagram's RIGHT layered layout.
const DEPENDENCY_LAYOUT = { "elk.algorithm": "layered", "elk.direction": "RIGHT" };
// Inheritance reads top-to-bottom as a containment tree (parent above children).
const INHERITANCE_LAYOUT = { "elk.algorithm": "layered", "elk.direction": "DOWN" };
```

### `RelationGraphPanel`

Mirror `SchemaDiagramPanel` plus optional root emphasis (the `ROOT_BORDER` idiom from `RelationDiagramPanel.ts:34`, `63-71`):

```typescript
const ROOT_BORDER = "2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))";

const nodeRenderer = (n: DiagramNodeData): Component => {
    const node = DiagramNode({ label: n.label, glyph: n.glyph });
    if (rootId !== undefined && n.id === rootId) { node.setBorder(ROOT_BORDER); }
    return node;
};

const view = DiagramView({ data, nodeRenderer });
view.on("activate", (n: DiagramNodeData) => onSelect(n.data as RelationNodeData));
return view;
```

### Controller open methods (all four follow this shape)

```typescript
async openSchemaDependencyGraph(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
    const id = this.dependencyPanelId(ref);          // schema-scoped id
    if (this.dock.focusPanel(id)) { return; }

    const data = await this.fetchDependencyGraph(ref); // null on failure (already reported)
    if (!data) { return; }

    this.dock.addPanel({
        id, title: `${ref.schema} (dependencies)`, glyph: "diagram-project",
        content: RelationGraphPanel(data, nd => this.openReferencedTable({
            connectionId: ref.connectionId, database: ref.database,
            schema: nd.schema, name: nd.name, kind: nd.kind,
        })),
    });
    this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}: dependencies (${data.nodes.length} relations)`);
}
```

Rooted variant differs only in: id from `relationDependencyPanelId(ref)`; build `root: DiagramNodeData = { id: relationNodeId(ref as RelationNodeRef), label: ref.name!, glyph: KIND_GLYPH[ref.kind], data: { schema: ref.schema!, name: ref.name!, kind: ref.kind } }`; `data = rootedDiagram(full, root, "both", Number.POSITIVE_INFINITY)`; pass `root.id` as the panel's `rootId`; title `${ref.name} (dependencies)`.

Shared fetch helper (mirrors `buildSchemaGraphData`):

```typescript
private async fetchDependencyGraph(ref: DbObjectRef): Promise<DiagramData | null> {
    try {
        const edges = await getDependencies(ref.connectionId, ref.database!, ref.schema!);
        return buildRelationGraph(edges, ref.schema!, DEPENDENCY_LAYOUT);
    } catch (err) { this.notifyError(err, ref); return null; }
}
```

`fetchInheritanceGraph` is identical with `getInheritance` + `INHERITANCE_LAYOUT`.

### Backend SQL

`ListDependenciesQuery._SQL` (schema + `$1` bound, never interpolated — same discipline as `table_structure.py`):

```sql
SELECT DISTINCT
    dn.nspname       AS dependent_schema,
    dc.relname       AS dependent_name,
    dc.relkind::text AS dependent_kind,
    sn.nspname       AS source_schema,
    sc.relname       AS source_name,
    sc.relkind::text AS source_kind
FROM pg_depend d
JOIN pg_rewrite r    ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
JOIN pg_class dc     ON dc.oid = r.ev_class
JOIN pg_namespace dn ON dn.oid = dc.relnamespace
JOIN pg_class sc     ON sc.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
JOIN pg_namespace sn ON sn.oid = sc.relnamespace
WHERE dn.nspname = $1
  AND dc.oid <> sc.oid                       -- drop the view's self-dependency
  AND dc.relkind IN ('v', 'm')               -- only views/matviews have rewrite rules
  AND sc.relkind IN ('r', 'v', 'm', 'p', 'f')
ORDER BY dependent_name, source_name
```

`ListInheritanceQuery._SQL`:

```sql
SELECT
    pn.nspname AS parent_schema, p.relname AS parent_name, p.relkind::text AS parent_kind,
    cn.nspname AS child_schema,  c.relname  AS child_name,  c.relkind::text AS child_kind
FROM pg_inherits i
JOIN pg_class p      ON p.oid = i.inhparent
JOIN pg_class c      ON c.oid = i.inhrelid
JOIN pg_namespace pn ON pn.oid = p.relnamespace
JOIN pg_namespace cn ON cn.oid = c.relnamespace
WHERE pn.nspname = $1
ORDER BY parent_name, child_name
```

Both `get_result()` map `relkind` via a module constant (catalog-fixed, not tunable):

```python
# pg_class.relkind -> the contract DbObjectKind. Partitioned ('p') and foreign
# ('f') tables collapse to "table"; fixed by the catalog format.
_RELKIND_KIND = {"r": "table", "p": "table", "f": "table", "v": "view", "m": "materializedView"}
```

`ListDependenciesQuery.get_result()` (source = dependent view, target = underlying):

```python
return [
    {
        "source": {"schema": r["dependent_schema"], "name": r["dependent_name"],
                   "kind": _RELKIND_KIND[r["dependent_kind"]]},
        "target": {"schema": r["source_schema"], "name": r["source_name"],
                   "kind": _RELKIND_KIND[r["source_kind"]]},
    }
    for r in self._raw
]
```

`ListInheritanceQuery.get_result()` maps `parent_*` -> `source`, `child_*` -> `target` the same way. Both raise `RuntimeError` when `_raw is None` (mirror `table_structure.py`).

---

## Ordered Implementation Steps

Backend first (endpoints + contract), then the frontend fetch/builder/panel/controller/navigator.

1. **`backend/app/operations/list_dependencies.py`** (new) — `ListDependenciesQuery` per _Internal Structure_: `__init__(conn, schema)` capturing `self._conn`/`self._schema`/`self._raw = None`; `apply()` = `self._raw = await self._conn.fetch(self._SQL, self._schema)`; `get_result()` mapping `relkind` and nesting `source`/`target`, raising `RuntimeError` before `apply()`. Module `_RELKIND_KIND` constant.
2. **`backend/app/operations/list_inheritance.py`** (new) — `ListInheritanceQuery`, same shape, parent->child.
3. **`backend/app/operations/__init__.py`** — import both classes and add to `__all__`.
4. **`backend/app/main.py`** — import both from `.operations`; add two schema-level routes mirroring `objects` (acquire -> op -> `apply` -> `get_result`):
   - `GET /api/{connection_id}/{database}/{schema}/dependencies` -> `ListDependenciesQuery(c, schema)`
   - `GET /api/{connection_id}/{database}/{schema}/inheritance` -> `ListInheritanceQuery(c, schema)`
5. **`backend/tests/test_list_dependencies.py`** + **`test_list_inheritance.py`** (new) — set `_raw` by hand (import `NO_CONN` from `tests.conftest`), assert the mapped/nested `get_result()` output and the before-`apply` `RuntimeError`, per _Expected Behaviour_.
6. **Checkpoint (backend):** `cd backend && poetry run pytest tests/test_list_dependencies.py tests/test_list_inheritance.py` green.
7. **`frontend/src/contract.ts`** — add `RelationNodeRef` and `RelationEdge` (see _Public API_).
8. **`frontend/src/data/api.ts`** — add `getDependencies` / `getInheritance` (mirror `getObjects`; import `RelationEdge`). URLs `/api/{conn}/{db}/{schema}/dependencies` and `/inheritance`.
9. **`frontend/src/data/buildRelationGraph.ts`** (new) + **`buildRelationGraph.test.ts`** (new) — the pure builder + `relationNodeId` + `RelationNodeData`, and its unit tests. Type-only diagram/contract imports; no UI-bundle runtime import (mirror the comment at [buildSchemaDiagram.ts:14-20](frontend/src/data/buildSchemaDiagram.ts#L14)).
10. **`frontend/src/dock/RelationGraphPanel.ts`** (new) — the panel per _Internal Structure_ (import `DiagramView`, `DiagramNode`, types; `RelationNodeData` from `../data/buildRelationGraph`).
11. **`frontend/src/SqlAdminController.ts`** — add imports (`buildRelationGraph`, `relationNodeId`, `RelationGraphPanel`, `getDependencies`, `getInheritance`, `RelationNodeRef`); the two `DEPENDENCY_LAYOUT`/`INHERITANCE_LAYOUT` constants; the two private `fetchDependencyGraph`/`fetchInheritanceGraph` helpers; the four public `open*Graph` methods; the four panel-id helpers (`dependencyPanelId`, `relationDependencyPanelId`, `inheritancePanelId`, `relationInheritancePanelId`) alongside the existing `diagramPanelId`/`relationDiagramPanelId`. Panel-id scheme: `${conn}/${db}/${schema}::dependencies`, `${panelId(ref)}::dependencies`, `${conn}/${db}/${schema}::inheritance`, `${panelId(ref)}::inheritance`.
12. **`frontend/src/navigator/NavigatorTree.ts`** — extend the context menus:
    - Schema menu (currently one item): add `{ text: "Open dependency graph", glyph: "diagram-project", action: () => void controller.openSchemaDependencyGraph(ref, node) }` and `{ text: "Open inheritance graph", glyph: "diagram-project", action: () => void controller.openSchemaInheritanceGraph(ref, node) }`.
    - Relation menu (`items` array, after "Show relations"): add `{ text: "Show dependencies", glyph: "diagram-project", action: () => void controller.openRelationDependencyGraph(ref, node) }` for every relation. Guarded by `ref.kind === "table"`, also push `{ text: "Show inheritance", glyph: "diagram-project", action: () => void controller.openRelationInheritanceGraph(ref, node) }` (views/matviews don't participate in inheritance).
13. **Checkpoint (frontend):** `cd frontend && npm run typecheck && npm test` (new `buildRelationGraph.test.ts` green; existing tests unchanged), then `npm run build`.
14. **(Optional, gated on `fk-diagram-cardinality-and-index-coverage` landing `DiagramEdgeStyle`)** — in `buildRelationGraph`, add an optional `dashed` param and set `style: { dashed: true }` on each edge for the dependency graph only (pass `true` from `fetchDependencyGraph`, `false`/omit from `fetchInheritanceGraph`). Do **not** attempt this before `DiagramEdgeData.style` exists in the library (typecheck would fail). Skip entirely if the capability is absent.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Create | **(backend)** `backend/app/operations/list_dependencies.py` |
| Create | **(backend)** `backend/app/operations/list_inheritance.py` |
| Modify | **(backend)** `backend/app/operations/__init__.py` (imports + `__all__`) |
| Modify | **(backend)** `backend/app/main.py` (two schema-level routes) |
| Create | **(backend)** `backend/tests/test_list_dependencies.py` |
| Create | **(backend)** `backend/tests/test_list_inheritance.py` |
| Modify | `frontend/src/contract.ts` (`RelationNodeRef`, `RelationEdge`) |
| Modify | `frontend/src/data/api.ts` (`getDependencies`, `getInheritance`) |
| Create | `frontend/src/data/buildRelationGraph.ts` |
| Create | `frontend/src/data/buildRelationGraph.test.ts` |
| Create | `frontend/src/dock/RelationGraphPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (4 open methods, 2 fetch helpers, 4 panel-id helpers, layout constants, imports) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (schema + relation menu items) |

---

## Expected Behaviour

### Unit-testable — backend `get_result()` (pytest, set `_raw` by hand)

`ListDependenciesQuery` (`test_list_dependencies.py`):
- A row `dependent_kind:"v", source_kind:"r"` -> `{"source": {kind:"view", ...}, "target": {kind:"table", ...}}` with schemas/names carried through, source = dependent view, target = underlying.
- `dependent_kind:"m"` -> `source.kind == "materializedView"`; `source_kind:"m"` -> `target.kind == "materializedView"`.
- `source_kind:"p"` (partitioned) and `source_kind:"f"` (foreign) both map `target.kind == "table"`.
- Cross-schema row (`dependent_schema:"a"`, `source_schema:"b"`) preserves both schemas.
- Empty `_raw` -> `[]`.
- `get_result()` before `apply()` -> `RuntimeError`.

`ListInheritanceQuery` (`test_list_inheritance.py`):
- `parent_kind:"p", child_kind:"r"` (declarative partitioning) -> `{"source": {kind:"table"}, "target": {kind:"table"}}`, source = parent, target = child.
- `parent_kind:"r", child_kind:"r"` (classic inheritance) -> both `"table"`.
- Empty `_raw` -> `[]`; before `apply()` -> `RuntimeError`.

### Unit-testable — `buildRelationGraph` (node vitest, `buildRelationGraph.test.ts`)

- Two edges `a->b`, `a->c` (all in `homeSchema`) -> three nodes (`a` deduped), ids `home.a`/`home.b`/`home.c`, labels `a`/`b`/`c`.
- A foreign-schema endpoint (`schema` != `homeSchema`) -> that node's `label === "otherSchema.name"`, id `otherSchema.name`.
- Node glyphs: `view -> "eye"`, `table -> "table"`, `materializedView -> "layer-group"`.
- Each node's `data` equals `{ schema, name, kind }` (a `RelationNodeData`).
- Edge id is `${sourceId}->${targetId}`; `source`/`target` are the node ids; orientation matches the input edge (source stays source).
- Two identical `(source,target)` edges -> a single edge (deduped by id).
- Empty `edges` -> empty `nodes`/`edges`; `layoutOptions` returned verbatim.
- `relationNodeId({schema:"s", name:"t", kind:"table"}) === "s.t"`.

Rooting a built graph is covered by the existing `relationDiagram.test.ts` (the generic `rootedDiagram`/`subgraph`/`reachableNodeIds` are graph-shape-agnostic); no new rooting test needed here.

### Manual-verify (needs the real app + ELK + browser)

- Right-click a schema -> "Open dependency graph": a tab opens with views/matviews pointing at the relations they read, laid out left-to-right; double-clicking a view node opens the view read-only, a table node opens the table.
- Right-click a schema -> "Open inheritance graph": a partitioned parent sits above its partition children (top-to-bottom tree); a classic-inheritance parent above its children.
- Right-click a view/matview -> "Show dependencies": the graph rooted at that relation (its connected dependency component), the root emphasized with the accent border.
- Right-click a table -> "Show dependencies": views that read the table appear (upstream); "Show inheritance" is offered only for tables and shows its partition/inheritance tree rooted at the table.
- A relation that participates in nothing -> the rooted tab shows just its (injected) node without throwing.
- Re-invoking an entry focuses the existing tab (dedup by panel id) rather than opening a duplicate.
- (If the dashed-edge capability landed) dependency edges render dashed; inheritance edges plain.

---

## Verification

- **Backend:** `cd backend && poetry run pytest tests/test_list_dependencies.py tests/test_list_inheritance.py` (and the full `poetry run pytest` to confirm no regressions).
- **Frontend typecheck:** `cd frontend && npm run typecheck`.
- **Frontend unit tests:** `cd frontend && npm test` — `buildRelationGraph.test.ts` covers every _unit-testable_ builder case; `buildSchemaDiagram.test.ts` / `relationDiagram.test.ts` stay green (untouched).
- **Build:** `cd frontend && npm run build`.
- **Manual smoke:** launch the app; exercise the four navigator entry points (schema dependency, schema inheritance, relation "Show dependencies", table "Show inheritance") and node activation, per _Manual-verify_. Entry points: `SqlAdminController.openSchemaDependencyGraph` / `openRelationDependencyGraph` / `openSchemaInheritanceGraph` / `openRelationInheritanceGraph`.
- **Regression grep:** `grep -rn "openReferencedTable" frontend/src` — confirm the graph panels route activation through it (kind-aware); `grep -rn "buildRelationGraph(" frontend/src` — only the two controller fetch helpers call it.

---

## Potential Challenges

- **`pg_depend` noise:** without the `classid = 'pg_rewrite'` / `refclassid = 'pg_class'` guards the join can pick up unrelated dependency rows; the guards + `DISTINCT` + the `dc.oid <> sc.oid` self-exclusion keep the result to genuine view->relation edges. Mitigation: guards are in the SQL above.
- **Cross-schema dependents in other schemas are invisible** (schema-scoped query). Mitigation: documented limitation; the database-level graph is a sibling plan.
- **Node-glyph literals drift from `KIND_GLYPH`:** the pure builder can't import `objectGlyphs` (DOM side effects break node vitest). Mitigation: the same "keep the literal in sync" comment as `buildSchemaDiagram.ts`; the glyphs (`table`/`eye`/`layer-group`) are actually registered by `objectGlyphs` at runtime via the navigator/controller import chain.
- **Foreign-schema node ambiguity:** two same-named relations in different schemas would collide on a bare label; mitigated by schema-qualified ids and foreign-schema labels (`schema.name`).
- **Dashed-edge soft dep ordering:** attempting Step 14 before the library ships `DiagramEdgeData.style` fails typecheck. Mitigation: Step 14 is explicitly gated and skippable; the default build uses plain edges.

---

## Critical Files

- [frontend/src/data/buildSchemaDiagram.ts](frontend/src/data/buildSchemaDiagram.ts) — the pure-builder + DOM-free-purity comment to mirror.
- [frontend/src/data/relationDiagram.ts](frontend/src/data/relationDiagram.ts) — `rootedDiagram` / `reachableNodeIds` / `subgraph` reused verbatim for rooted variants (graph-shape-agnostic).
- [frontend/src/dock/SchemaDiagramPanel.ts](frontend/src/dock/SchemaDiagramPanel.ts) and [RelationDiagramPanel.ts](frontend/src/dock/RelationDiagramPanel.ts) — the panel + `ROOT_BORDER`/`nodeRenderer` idioms `RelationGraphPanel` copies.
- [frontend/src/SqlAdminController.ts:339](frontend/src/SqlAdminController.ts#L339) `openSchemaDiagram`, [:377](frontend/src/SqlAdminController.ts#L377) `buildSchemaGraphData`, [:405](frontend/src/SqlAdminController.ts#L405) `openRelationDiagram`, [:446](frontend/src/SqlAdminController.ts#L446) `openReferencedTable`, [:1035](frontend/src/SqlAdminController.ts#L1035) panel-id helpers — the patterns the new methods mirror.
- [frontend/src/navigator/NavigatorTree.ts:103-146](frontend/src/navigator/NavigatorTree.ts#L103) — the `contextmenu` handler (schema branch + relation `items`).
- [frontend/src/data/api.ts:70](frontend/src/data/api.ts#L70) `getObjects` — the fetcher to mirror.
- [backend/app/operations/list_objects.py](backend/app/operations/list_objects.py) — the schema-level three-phase list query to mirror (inline dict `get_result`).
- [backend/app/operations/table_structure.py](backend/app/operations/table_structure.py) — the `pg_catalog` SQL + `$1`-binding discipline and relkind/action mapping style.
- [backend/app/main.py:178](backend/app/main.py#L178) `objects` route — the acquire/apply/get_result route shape.
- [backend/tests/test_table_structure.py](backend/tests/test_table_structure.py) + [backend/tests/conftest.py](backend/tests/conftest.py) — the offline `_raw`-by-hand `get_result` test style + `NO_CONN`.
- [frontend/src/navigator/objectGlyphs.ts](frontend/src/navigator/objectGlyphs.ts) — `KIND_GLYPH` (the literals the builder keeps in sync) and its `Glyph.register`.

---

## Non-Goals

- Crow's-foot cardinality / index-coverage overlays — sibling `fk-diagram-cardinality-and-index-coverage`.
- The dashed dependency-edge library capability itself — owned by the FK sibling plan; consumed here only if present (Step 14).
- Interactive direction/depth/legend controls on the rooted graphs — the FK `RelationDiagramPanel` has them; the new graphs ship control-less (rooted = the full connected component).
- Cross-schema (database-level) dependency/inheritance discovery — sibling `database-level-schema-diagram`.
- Role/privilege graph (`role-privilege-graph`); column-level / column-to-column port edges (`column-level-er-diagram`); trigger/function-dependency graph.
- A new `DbObjectKind` for partitioned/foreign tables — they collapse to `"table"`.
- Backend `contract.py` dataclasses for the edge shape — inline dicts, matching the sibling list queries.
- The deferred diagram UI/UX visual redesign.
