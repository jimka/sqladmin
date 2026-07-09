# Database-Level Schema Diagram — Implementation Plan

## Overview

Add a database-wide entity-relationship diagram spanning **all** schemas, opened from the database navigator node (today only a schema node offers "Open schema diagram"). Three coupled pieces:

1. **Schema-qualified node identity + cross-schema FK edges.** A new pure builder keys table nodes by `schema.table` (not bare name — two schemas can share a table name) and resolves each FK's target via `fk.refSchema` + `fk.refTable`, so cross-schema foreign keys are drawn. [buildSchemaDiagram.ts:52](frontend/src/data/buildSchemaDiagram.ts#L52) uses bare-name ids and [buildSchemaDiagram.ts:61-63](frontend/src/data/buildSchemaDiagram.ts#L61) matches only `fk.refTable` within one schema's set, dropping every cross-schema FK — correct for a single schema, wrong at database scope.

2. **Per-schema grouping via compound nodes.** Cluster each schema's tables inside a schema container box. This is a **library change** in `typescript-ui`: `DiagramNodeData` gains a `children` field ([DiagramModel.ts:29](../../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts#L29) has no compound support), `ElkLayoutEngine.buildElkGraph` maps it to ELK's hierarchical layout, `ElkLayoutEngine.mapElkResult` flattens ELK's parent-relative child coordinates back to absolute, and `DiagramView` renders container boxes behind the leaves. Additive — flat graphs are unaffected.

3. **Schema → schema overview graph (zoom-out).** A pure aggregated builder: nodes = schemas, each edge carries the count of cross-schema FKs between two schemas. It is the legible entry point that drills into the full table-level view.

Because a database-level table diagram without filtering is an unreadable hairball, the panel **reuses the rooted / direction / depth + show-hide-prune interaction** already implemented in [relationDiagram.ts](frontend/src/data/relationDiagram.ts) and mirrored by [RelationDiagramPanel.ts](frontend/src/dock/RelationDiagramPanel.ts). This is a hard dependency, stated explicitly below.

Pure builders live under `frontend/src/data/` (node-vitest-testable, type-only diagram-barrel imports, no UI-bundle runtime imports — the discipline documented at [buildSchemaDiagram.ts:16-21](frontend/src/data/buildSchemaDiagram.ts#L16)). The library is a separate repo consumed through the `file:../../typescript-ui` symlink ([frontend/package.json:14](frontend/package.json#L14)); after any library edit `npm run build:lib` must run in `typescript-ui` before the app typechecks against it.

---

## Architecture Decisions

### Node identity becomes schema-qualified for the database builder; the single-schema builder is untouched

`buildSchemaDiagram(tables, structures)` stays byte-for-byte as-is — its bare-name ids and intra-schema edge matching are correct for a single schema, and its tests stay green. The database builder is a **new** module (`buildDatabaseDiagram`) that keys nodes by a `qualifiedId(schema, table) = "${schema}.${table}"` helper and resolves each FK target with `qualifiedId(fk.refSchema, fk.refTable)`. Both sides call the same helper, so a node id and an edge-target id always agree — sidestepping any ambiguity from a `.`-in-name (the same `schema.table` join the app already uses in [SqlAdminController.panelId](frontend/src/SqlAdminController.ts#L1020)). Labels stay **bare** table names (the schema container box supplies the schema context); ids are globally unique.

### Filter the flat graph first, then group into containers

The rooted/prune operations in [relationDiagram.ts](frontend/src/data/relationDiagram.ts) (`reachableNodeIds`, `subgraph`, `rootedDiagram`, `applyHide`) operate over a **flat** `nodes`/`edges` graph and must not learn about compound nodes. So the database table view keeps two representations:

- **Flat graph** — leaf table nodes only (qualified ids), all cross-schema edges. Each leaf carries its schema on `node.data` (a typed `{ schema, table }` object — the opaque passthrough seam at [DiagramModel.ts:58](../../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts#L58)). This is what the rooted/direction/depth/prune traversal runs on, reusing `relationDiagram.ts` unchanged.
- **Grouped graph** — a new pure `groupBySchema(flat)` wraps the (already-filtered) flat leaves into one compound container node per schema, reading each leaf's `node.data.schema`. This is the final graph handed to `DiagramView.setData`.

So the compound library capability is exercised only by the final grouped graph; the filter layer never sees a container. Order per recompute: `rootedDiagram`/`applyHide` on the flat graph → `groupBySchema` → `setData`.

### Compound nodes are an additive, flatten-to-absolute library change

Rejected the fully-nested-DOM alternative (leaf components as DOM children of container components) — it would perturb `DiagramView`'s single-content-host model, the single SVG edge layer, `nodeIdAt` hit-testing, and the zoom transform. Instead:

- **Model:** `DiagramNodeData.children?: DiagramNodeData[]`. A node with a non-empty `children` is a *container*; ELK computes its size and position from its contents (the container carries no explicit `width`/`height`).
- **`buildElkGraph`** recurses: a container maps to an `ElkNode` with nested `children` (recursively mapped) plus container padding options; leaf mapping is unchanged. The root gains `elk.hierarchyHandling: "INCLUDE_CHILDREN"` so cross-container edges route through the hierarchy. Edges stay declared on the root, so their routed sections come back in root (= absolute) coordinates.
- **`mapElkResult`** flattens: ELK returns each child's `x`/`y` **relative to its parent**, so a recursive walk accumulates parent offsets and emits a **flat** node list (containers + leaves) with absolute coordinates and sizes. Edges are unchanged (root-relative = absolute).
- **`DiagramView`** keeps its flat content host and keeps every node (container + leaf) in the flat `_nodeComponents`/`_nodeData` maps keyed by id. `rebuildNodes` and `collectNodeSizes` recurse into `children`; containers are built via a new `groupRenderer` (default `DiagramGroupNode` — a titled, translucent box) so a leaf and a container render differently. Containers are flat siblings of the leaves (not DOM parents), so `nodeIdAt` still resolves correctly and clicks on a leaf hit the leaf. Paint order is fixed by **z-index** applied only when the graph has containers: containers below, edge layer in the middle, leaves on top. A graph with no `children` produces no containers, the recursion degenerates to today's behaviour, and no z-index is written — so **flat graphs are byte-for-byte unaffected**.

### The schema-overview graph is a pure aggregation, no compound needed

`buildSchemaOverviewDiagram(schemas)` returns a **flat** graph: one node per schema (id = schema name, label = schema), and one edge per ordered schema pair `(S → T)` where at least one FK in `S` references a table in `T ≠ S`, carrying the FK count as the edge label and on `edge.data`. Intra-schema FKs are not overview edges (they do not cross). Edge-styling by weight (stroke width) is **out of scope** — the sibling `fk-diagram-cardinality-and-index-coverage` plan owns edge styling; this plan only labels the count.

### Fetch spans all schemas; the rooted+filter layer mitigates on-screen size

A new controller method `buildDatabaseGraphData(ref)` mirrors and extends [buildSchemaGraphData](frontend/src/SqlAdminController.ts#L377): `getSchemas` → per-schema `getObjects` (filter `kind === "table"`) → per-table `getStructure`, then assemble via `buildDatabaseDiagram`. The fetch cost is `O(schemas × tables)` round trips — noted as a Potential Challenge. The on-screen size is bounded not by the fetch but by the rooted+prune+per-schema-hide filter layer, which is why that reuse is a hard dependency, not a nicety.

### Entry point: a database-node context item, and activation must pass the node's schema

A new "Open database diagram" item is added to the database node's context menu. [NavigatorTree.ts:103-146](frontend/src/navigator/NavigatorTree.ts#L103) currently only branches on `ref.kind === "schema"` ([:108](frontend/src/navigator/NavigatorTree.ts#L108)) and relations; a `ref.kind === "database"` branch is added ahead of them. Node activation reuses [openReferencedTable](frontend/src/SqlAdminController.ts#L446), but — unlike the single-schema diagram, which hardcodes `schema: ref.schema` ([SqlAdminController.ts:356-362](frontend/src/SqlAdminController.ts#L356)) — the database diagram must pass **the activated node's own schema** (read from `node.data.schema`), since it varies across the diagram.

---

## Public API

### Library — `typescript-ui`

`DiagramModel.ts` — add to `DiagramNodeData`:

```typescript
/**
 * Optional child nodes. A node with a non-empty `children` is a compound
 * *container* (e.g. a schema box grouping its tables); ELK lays its children
 * out inside it and computes the container's own size. A node with no
 * `children` is a leaf, exactly as before.
 */
children?: DiagramNodeData[];
```

`DiagramGroupNode.ts` (new component + callable export, mirroring `DiagramNode`):

```typescript
export interface DiagramGroupNodeOptions extends PanelOptions {
    /** The container's header label (e.g. the schema name). */
    label?: string;
}
/** A titled, translucent container box for a compound diagram node. */
class DiagramGroupNode extends Panel<DiagramGroupNodeOptions> { /* … */ }
```

`DiagramView.ts` — add to `DiagramViewOptions`:

```typescript
/** Factory for compound container components; defaults to `DiagramGroupNode`. */
groupRenderer?: (data: DiagramNodeData) => Component;
```

`index.ts` — add `export { DiagramGroupNode }` + `export type { DiagramGroupNodeOptions }`, and add `groupRenderer` to the re-exported `DiagramViewOptions` (already re-exported as a type).

### App — `frontend/src/data/`

```typescript
// buildDatabaseDiagram.ts
/** One schema's tables and their structures, positionally paired. */
export interface SchemaTables { schema: string; tables: string[]; structures: TableStructure[]; }
/** Typed leaf-node metadata carried on DiagramNodeData.data for grouping + activation. */
export interface TableNodeData { schema: string; table: string; }
/** Flat cross-schema FK graph: qualified leaf ids, cross-schema + self edges. */
export function buildDatabaseDiagram(schemas: SchemaTables[]): DiagramData;
/** The stable qualified id for a table node (schema.table). */
export function qualifiedId(schema: string, table: string): string;

// groupBySchema.ts
/** Wrap a flat table graph's leaves into one compound container node per schema. */
export function groupBySchema(flat: DiagramData): DiagramData;

// schemaOverviewDiagram.ts
/** Nodes = schemas; edges = cross-schema FK counts (label + data.count). */
export function buildSchemaOverviewDiagram(schemas: SchemaTables[]): DiagramData;
```

### App — `frontend/src/SqlAdminController.ts`

```typescript
/** Open the database-wide ER diagram (all schemas) in the Dock, deduped by id. */
async openDatabaseDiagram(ref: DbObjectRef, _node?: TreeNode): Promise<void>;
/** Fetch every schema's tables + structures for the database diagram. */
private buildDatabaseGraphData(ref: DbObjectRef): Promise<SchemaTables[] | null>;
/** Stable id for the database diagram tab. */
private databaseDiagramPanelId(ref: DbObjectRef): string;
```

### App — `frontend/src/dock/DatabaseDiagramPanel.ts` (new)

```typescript
/**
 * @param schemas - Per-schema tables + structures (from buildDatabaseGraphData).
 * @param onSelectTable - Invoked with the activated leaf's schema + table.
 */
export function DatabaseDiagramPanel(
    schemas: SchemaTables[],
    onSelectTable: (schema: string, table: string) => void,
): Component;
```

---

## Internal Structure

### `groupBySchema` (shape)

```
container node:  { id: `schema:${schema}`, label: schema, children: [ …leaf nodes… ] }
leaf node:       unchanged from the flat graph (id `schema.table`, data { schema, table })
edges:           passed through verbatim (they reference leaf ids)
layoutOptions:   carried through from flat
```
Containers are built in first-seen schema order; a schema with no surviving leaves produces no container.

### `DiagramView` compound handling (key deltas)

- `rebuildNodes(data)` / `collectNodeSizes(data)` gain a recursive walk: for a node with `children`, build/size the container **and** recurse into its children; register every node (container + leaf) in `_nodeComponents` / `_nodeData`. Container components come from `_options.groupRenderer ?? (d => new DiagramGroupNode({ label: d.label }))`; leaves from the existing `nodeRenderer` path. Containers carry **no** explicit size to ELK (let ELK compute).
- `applyLayout(result)` iterates the flattened node list (containers + leaves, absolute coords). When any container exists, set `edgeLayer.setZIndex(1)`, each container `setZIndex(0)`, each leaf `setZIndex(2)`; otherwise leave z-index untouched (flat-graph path).

### `buildElkGraph` compound handling

- Map nodes recursively: a container → `{ id, children: [...recursed], layoutOptions: { ...padding/label options } }` with **no** width/height; a leaf → today's `{ id, width, height, layoutOptions }`.
- Root `layoutOptions` merge gains `elk.hierarchyHandling: "INCLUDE_CHILDREN"` (added to defaults, still overridable by `data.layoutOptions`).
- Edges stay a flat root-level list referencing leaf ids.

### `mapElkResult` flatten

Recursive walk over `result.children`, threading an `(offsetX, offsetY)` accumulator; each emitted node's absolute `x = offset + child.x`, `y = offset + child.y`; a container recurses with its own absolute origin as the new offset. Output stays the flat `DiagramLayoutResult.nodes` shape (containers + leaves). Edges unchanged.

---

## Ordered Implementation Steps

**Phase A — library compound support (build:lib before the app touches it).**

1. `typescript-ui` `DiagramModel.ts`: add `children?: DiagramNodeData[]` to `DiagramNodeData` with the JSDoc above.
2. `typescript-ui` `ElkLayoutEngine.ts`: make `buildElkGraph` map container nodes to nested `children` (no size) with padding/label layout options; add `elk.hierarchyHandling: "INCLUDE_CHILDREN"` to the root options; make `mapElkResult` flatten parent-relative child coords to absolute via a recursive offset walk. Keep both functions pure/synchronous.
3. `typescript-ui` `DiagramGroupNode.ts` (new): a `Panel` subclass rendering a titled translucent box (header label top-left, transparent body so children show through), themed border, `callable`-wrapped export mirroring `DiagramNode.ts`.
4. `typescript-ui` `DiagramView.ts`: add `groupRenderer` to `DiagramViewOptions` + cache in `applyOptions`; make `rebuildNodes` / `collectNodeSizes` recurse into `children`; apply the container/edge/leaf z-index in `applyLayout` only when a container exists.
5. `typescript-ui` `index.ts`: export `DiagramGroupNode` + `DiagramGroupNodeOptions`.
6. Add library unit tests: `buildElkGraph` container mapping + `hierarchyHandling`; `mapElkResult` flatten-to-absolute (mirror [ElkLayoutEngine.test.ts](../../typescript-ui/tests/component/diagram/ElkLayoutEngine.test.ts)). Run `npm test` in `typescript-ui`.
7. **Checkpoint:** in `typescript-ui`, run `npm run build:lib`. The app cannot typecheck against `children`/`groupRenderer`/`DiagramGroupNode` until this rebuild lands in `dist/lib`.

**Phase B — app pure builders.**

8. `frontend/src/data/buildDatabaseDiagram.ts` (new): `qualifiedId`, `SchemaTables`, `TableNodeData`, `buildDatabaseDiagram`. Type-only diagram-barrel import; keep the `TABLE_GLYPH = "table"` literal + its sync-with-`KIND_GLYPH` comment (copy the rationale from [buildSchemaDiagram.ts:16-21](frontend/src/data/buildSchemaDiagram.ts#L16)). Leaf `label` = bare table; leaf `data` = `{ schema, table }`. Edge kept iff `qualifiedId(fk.refSchema, fk.refTable)` is in the global id set. Layout options = layered/RIGHT.
9. `frontend/src/data/buildDatabaseDiagram.test.ts` (new): cover cross-schema edge kept, same-named tables in two schemas stay distinct, dangling FK dropped, self-FK kept, empty database.
10. `frontend/src/data/groupBySchema.ts` (new) + `.test.ts`: wrap flat leaves into `schema:${schema}` containers by `node.data.schema`; edges/layoutOptions pass through; empty-schema container omitted.
11. `frontend/src/data/schemaOverviewDiagram.ts` (new) + `.test.ts`: schema nodes + aggregated cross-schema FK-count edges (label + `data.count`); intra-schema FKs excluded; empty database → empty graph.

**Phase C — controller + panel + navigator.**

12. `frontend/src/SqlAdminController.ts`: add `buildDatabaseGraphData(ref)` (getSchemas → per-schema getObjects/getStructure → `SchemaTables[]`, `notifyError` + return null on failure); `databaseDiagramPanelId(ref)` = `${ref.connectionId}/${ref.database}::db-diagram` (distinct from [diagramPanelId](frontend/src/SqlAdminController.ts#L1035)); `openDatabaseDiagram(ref, _node?)` — dedupe via `dock.focusPanel`, build data, `addPanel` hosting `DatabaseDiagramPanel(schemas, (schema, table) => this.openReferencedTable({ connectionId: ref.connectionId, database: ref.database, schema, name: table, kind: "table" }))`, set a status message with the table count.
13. `frontend/src/dock/DatabaseDiagramPanel.ts` (new): Border layout mirroring [RelationDiagramPanel.ts](frontend/src/dock/RelationDiagramPanel.ts) — WEST controls + CENTER `DiagramView`. Modes: **Overview** (default; `buildSchemaOverviewDiagram(schemas)`, flat) and **Tables** (`buildDatabaseDiagram(schemas)` → optional `rootedDiagram`/`applyHide` → `groupBySchema` → `setData`). WEST: a mode toggle; in Tables mode a root-table `ComboBox` over all qualified ids (default "(none)" = full grouped graph) enabling the same direction/depth/prune controls as RelationDiagramPanel (import `rootedDiagram`/`applyHide`/`TraversalDirection` from `relationDiagram.ts`); a per-schema show/hide legend. `activate` on a leaf → `onSelectTable(node.data.schema, node.data.table)`; `activate` on an Overview schema node → switch to Tables mode filtered to that schema; `activate` on a container is ignored.
14. `frontend/src/navigator/NavigatorTree.ts`: in the `contextmenu` handler, add a `ref.kind === "database"` branch (ahead of the schema branch at [:108](frontend/src/navigator/NavigatorTree.ts#L108)) showing one item `{ text: "Open database diagram", glyph: "diagram-project", action: () => void controller.openDatabaseDiagram(ref, node) }`.
15. **Checkpoint:** `npm run build:lib` already done in step 7; run the app typecheck + tests (see Verification).

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts` |
| Modify | `typescript-ui/src/typescript/lib/component/diagram/ElkLayoutEngine.ts` |
| Create | `typescript-ui/src/typescript/lib/component/diagram/DiagramGroupNode.ts` |
| Modify | `typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts` |
| Modify | `typescript-ui/src/typescript/lib/component/diagram/index.ts` |
| Create | `typescript-ui/tests/component/diagram/DiagramGroupNode.test.ts` (optional) |
| Modify | `typescript-ui/tests/component/diagram/ElkLayoutEngine.test.ts` |
| Create | `frontend/src/data/buildDatabaseDiagram.ts` |
| Create | `frontend/src/data/buildDatabaseDiagram.test.ts` |
| Create | `frontend/src/data/groupBySchema.ts` |
| Create | `frontend/src/data/groupBySchema.test.ts` |
| Create | `frontend/src/data/schemaOverviewDiagram.ts` |
| Create | `frontend/src/data/schemaOverviewDiagram.test.ts` |
| Create | `frontend/src/dock/DatabaseDiagramPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/navigator/NavigatorTree.ts` |

---

## Expected Behaviour

### Unit-testable (pure, node vitest)

**`buildDatabaseDiagram` (`frontend/src/data/`):**
- One leaf node per table across all schemas; id = `schema.table`, label = bare table, `data = { schema, table }`, glyph = `"table"`.
- Two schemas with a same-named table (`a.users`, `b.users`) yield two distinct nodes (distinct ids), not one.
- A cross-schema FK (`a.orders.customer_id → b.customers`) becomes an edge `source: "a.orders"`, `target: "b.customers"` — **kept** (the bug the single-schema builder has is fixed here).
- A self-schema FK is kept; a self-referential FK (table → itself) is kept.
- An FK whose `refSchema.refTable` is absent from the fetched set (system catalog / un-fetched schema) is dropped.
- Edge ids are globally unique (`${schema.table}.${fk.name}`), even when two tables share an FK constraint name.
- Empty database (no schemas / no tables) → empty nodes and edges; layout options still layered/RIGHT.

**`groupBySchema` (`frontend/src/data/`):**
- Flat leaves are wrapped into one container per schema (`id: "schema:${schema}"`, `label: schema`, `children` = that schema's leaves in order).
- Edges and `layoutOptions` pass through verbatim (edges still reference leaf ids).
- A schema with zero surviving leaves (after filtering) produces no container.
- Container order follows first-seen schema order.

**`buildSchemaOverviewDiagram` (`frontend/src/data/`):**
- One node per schema (id = label = schema name).
- An edge `S → T` exists iff ≥1 FK in `S` references a table in `T ≠ S`; its label and `data.count` equal the number of such FKs.
- Multiple cross-schema FKs between the same ordered pair aggregate into one edge with the summed count.
- Intra-schema FKs contribute no overview edge.
- Empty / single-schema-with-no-cross-FK database → nodes but no edges.

**`buildElkGraph` / `mapElkResult` (library):**
- A container node maps to an `ElkNode` with nested `children` and **no** `width`/`height`; leaves keep explicit/sizes-map/default sizing.
- Root options include `elk.hierarchyHandling: "INCLUDE_CHILDREN"`, still overridable by `data.layoutOptions`.
- `mapElkResult` flattens a nested result: a child at parent-relative `(x, y)` inside a container at `(cx, cy)` emits absolute `(cx + x, cy + y)`; the container itself emits its absolute box. A flat (no-children) result maps exactly as today.

### Manual-verify (needs a browser / real ELK / Dock)

- **Compound ELK layout + nesting:** open the database diagram; each schema's tables sit inside a labelled schema box; cross-schema FK edges cross between boxes; leaves are clickable and sit visually on top of their container.
- **Rendering/z-index:** container boxes paint behind edges; edges behind leaves; selecting/double-clicking a leaf works (hit-testing unaffected); a container/schema box does not steal a leaf's click.
- **Flat-graph regression:** the existing single-schema diagram and relation-rooted diagram render and behave exactly as before (no container boxes, unchanged z-order).
- **Dock/navigator:** right-clicking a **database** node shows "Open database diagram"; it opens one deduped tab; the schema node still shows "Open schema diagram"; a relation node's menu is unchanged.
- **Filtering:** the mode toggle switches Overview ↔ Tables; a root-table selection + direction/depth/prune narrows the table view; the per-schema legend hides/shows whole schemas; double-clicking a leaf opens its table (revealed in the navigator) using **that leaf's** schema, not a fixed one.
- **Overview drill-down:** double-clicking a schema node in Overview switches to Tables mode focused on that schema.

---

## Verification

- **Library:** in `typescript-ui`, `npm test` (new ELK compound tests green) then `npm run build:lib` (required before the app resolves the new API).
- **App typecheck + unit:** in `frontend`, `npm run build` / `tsc` typecheck and `npm test` — the new `buildDatabaseDiagram`, `groupBySchema`, `schemaOverviewDiagram` suites green; existing `buildSchemaDiagram.test.ts` and `relationDiagram.test.ts` unchanged and green.
- **Regression grep:** `grep -n 'schema: ref.schema' frontend/src/SqlAdminController.ts` — the single-schema diagram/relation activations still hardcode `ref.schema` (unchanged); confirm the database activation instead threads `node.data.schema`.
- **Manual smoke:** run the app (`npm run dev` in `frontend`), expand a database, right-click it → "Open database diagram"; exercise every Manual-verify bullet above. Confirm the single-schema "Open schema diagram" and relation "Show relations" tabs still render identically (flat-graph regression).

---

## Potential Challenges

- **Fetch fan-out.** `buildDatabaseGraphData` issues `O(schemas × tables)` structure requests; a large database is slow to open. Mitigation: the request is one-shot behind the tab open (a spinner is acceptable), and the on-screen graph is bounded by the filter layer, not the fetch. A row-count guard on the initial unfiltered Tables view (default to Overview mode) keeps the first paint legible.
- **ELK cross-hierarchy edge routing.** `INCLUDE_CHILDREN` is required for edges declared on the root to cross container boundaries; without it ELK may drop or mis-route cross-schema edges. Verify visually that cross-schema edges route between boxes.
- **Coordinate flattening.** ELK child coords are parent-relative; a missed offset accumulation places leaves at the wrong absolute position. The `mapElkResult` flatten test pins this; verify visually that leaves sit inside their box.
- **Container click interception.** Containers are flat siblings under the content host; if a container's box captured pointer events over a leaf, selection would break. The z-index ordering (leaves on top) plus separate DOM elements prevent this; verify a leaf click never selects its schema box.
- **`qualifiedId` delimiter.** A `.` in a schema or table name could in principle collide; this mirrors the existing `panelId` convention and is accepted as a known, pre-existing limitation.

---

## Critical Files

- [frontend/src/data/buildSchemaDiagram.ts](frontend/src/data/buildSchemaDiagram.ts) — the builder to generalize (bare ids, intra-schema-only edges, purity discipline, `TABLE_GLYPH` literal).
- [frontend/src/data/relationDiagram.ts](frontend/src/data/relationDiagram.ts) — the flat rooted/prune layer the Tables mode reuses unchanged.
- [frontend/src/dock/RelationDiagramPanel.ts](frontend/src/dock/RelationDiagramPanel.ts) — the panel structure (WEST controls + CENTER view, legend, `rebuildBase`/`applyFilter`) to mirror in `DatabaseDiagramPanel`.
- [frontend/src/SqlAdminController.ts](frontend/src/SqlAdminController.ts) — `buildSchemaGraphData` ([:377](frontend/src/SqlAdminController.ts#L377)), `openSchemaDiagram` ([:339](frontend/src/SqlAdminController.ts#L339)), `openReferencedTable` ([:446](frontend/src/SqlAdminController.ts#L446)), panel-id helpers ([:1020-1047](frontend/src/SqlAdminController.ts#L1020)).
- [frontend/src/navigator/NavigatorTree.ts](frontend/src/navigator/NavigatorTree.ts) — the `contextmenu` handler ([:103](frontend/src/navigator/NavigatorTree.ts#L103)) and `databaseNode` ([:172](frontend/src/navigator/NavigatorTree.ts#L172)).
- [frontend/src/contract.ts](frontend/src/contract.ts) — `DbObjectRef` ([:7](frontend/src/contract.ts#L7)), `ForeignKeyMeta.refSchema`/`refTable` ([:141](frontend/src/contract.ts#L141)).
- Library: [DiagramModel.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts), [ElkLayoutEngine.ts](../../typescript-ui/src/typescript/lib/component/diagram/ElkLayoutEngine.ts) (`buildElkGraph`/`mapElkResult`), [DiagramView.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts) (`rebuildNodes`/`collectNodeSizes`/`applyLayout`), [DiagramNode.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramNode.ts) (template for `DiagramGroupNode`), [index.ts](../../typescript-ui/src/typescript/lib/component/diagram/index.ts).

---

## Non-Goals

- **Crow's-foot cardinality / edge styling / weight-scaled overview strokes** — owned by the sibling `fk-diagram-cardinality-and-index-coverage` plan; this plan only labels overview counts.
- **View / inheritance / role / schema-dependency graphs** — separate sibling plans.
- **Column cards / column-to-column ports** — the sibling `column-level-er-diagram` plan; leaves stay table-level.
- **Cross-database (multi-connection) diagrams** — stay within one database's schemas.
- **The deferred diagram UI/UX redesign.**
- **A backend change** — the diagram is assembled entirely from existing introspection endpoints (`getSchemas`/`getObjects`/`getStructure`).
```