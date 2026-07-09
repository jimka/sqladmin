---
touches-shared: ["frontend/src/SqlAdminController.ts", "frontend/src/navigator/NavigatorTree.ts"]
---

# Schema Diagram — Relation-Rooted View + Show/Hide-with-Prune — Implementation Plan

## Overview

The next slice of the schema-diagram feature. Three deliverables, all built on the already-implemented schema-diagram base (`buildSchemaDiagram`, `SchemaDiagramPanel`, `openSchemaDiagram`, the `DiagramView` library component):

1. **Relation-rooted diagram** — a new **"Show relations"** context-menu item on table/view/materializedView navigator nodes opens a `DiagramView` rooted at that relation, with a **direction** control (downstream / upstream / both), a **depth** limit (default 1 hop), and **visual emphasis** on the root node.
2. **Show/hide with prune** — a legend/filter side panel listing every node with a checkbox; **plain hide** drops a node + its incident edges, **hide-&-prune** additionally drops nodes made unreachable from the root. Each toggle recomputes filtered `DiagramData` and calls `view.setData(...)`.
3. **Forward-compat for column-level (port) edges** — carry FK `columns`/`refColumns` on the edge model now, and shape `DiagramNodeData` / `DiagramEdgeData` so that adding ELK ports later is purely additive (no re-key, no re-plumb). No card/port rendering in this slice.

Rooted traversal reuses the schema-wide structure fetch already performed by [`openSchemaDiagram`](frontend/src/SqlAdminController.ts#L337) (`getObjects` + `Promise.all(getStructure)`): build the **full** schema `DiagramData` once via `buildSchemaDiagram`, then walk it from the root. Upstream edges = reverse-FK scan across that same set. The BFS/prune/subgraph logic lives in a new **pure, node-vitest-tested** module `frontend/src/data/relationDiagram.ts`, mirroring the purity of [`buildSchemaDiagram.ts`](frontend/src/data/buildSchemaDiagram.ts) (type-only imports from the diagram barrel; no UI-bundle code).

New files: `frontend/src/data/relationDiagram.ts` (+ test), `frontend/src/dock/RelationDiagramPanel.ts`. Modified: `frontend/src/data/buildSchemaDiagram.ts` (+ its test) to carry FK metadata on edges, `frontend/src/SqlAdminController.ts` (additive: `openRelationDiagram`, a shared fetch helper, `relationDiagramPanelId`), `frontend/src/navigator/NavigatorTree.ts` (relation-menu item). Library: `typescript-ui/.../diagram/DiagramModel.ts` (additive optional fields) — requires `npm run build:lib`.

---

## Architecture Decisions

### Rooted traversal reuses the schema-wide fetch; upstream = reverse-FK scan — no new endpoint
`openRelationDiagram` fetches exactly what `openSchemaDiagram` fetches (`getObjects` for the schema's tables, then one `getStructure` per table in a `Promise.all`) and feeds it through `buildSchemaDiagram` to get the **full** schema `DiagramData`. Downstream edges are the root's own outgoing FKs; upstream edges require every *other* table's FKs — already present in the full edge set — so both directions are a walk over one in-memory graph. To avoid duplicating the fetch block, extract a private `buildSchemaGraphData(ref)` helper and have both `openSchemaDiagram` and `openRelationDiagram` call it.

### Two-layer recompute: full → rooted base (direction+depth) → filtered (hide+prune)
The panel holds the **full** graph and derives two views. Layer A `rootedDiagram(full, root, direction, depth)` recomputes when direction/depth change (increasing depth needs nodes beyond the current base, so it must start from `full`, not the current base). Layer B `applyHide(base, rootId, hidden, prune, direction)` recomputes on a legend/prune toggle and is what `view.setData` receives. Changing direction/depth resets the hidden set (fresh view) — simplest, least-surprising.

### Show/hide is subgraph recompute; prune is reachability-from-root over the base edges
Both hide modes reduce to `subgraph(base, keepSet)`. **Plain hide**: `keep = base node ids − hidden` (an orphaned node stays). **Prune**: `keep = reachableNodeIds(base.edges, rootId, direction, ∞, excluded = hidden)` (orphans drop). One `reachableNodeIds` BFS serves both the depth-limited rooted build and the unlimited prune walk, differing only by `maxDepth` and `excluded`.

### Views/matviews may be roots but have no FK edges (state explicitly)
PostgreSQL foreign keys are table-only, and `buildSchemaDiagram` emits nodes for `kind === "table"` only. "Show relations" is offered on **all** relations (matching the existing `isRelation` guard), but a **view/matview root has no incoming or outgoing FK edges**, so its diagram is the emphasized root node **alone**. To guarantee the root renders even when it is not a table node in `full`, the controller passes the root's `DiagramNodeData` explicitly and `rootedDiagram` seeds the keep-set with the root and injects that node if `full.nodes` lacks it. (Table roots appear normally; the injected-root path only fires for view/matview roots.)

### Root emphasis via a custom `nodeRenderer`, not a library change
`DiagramView` accepts a `nodeRenderer` factory ([DiagramView.ts:236](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L236)). `RelationDiagramPanel` supplies one closured over `rootId`: it builds the default `DiagramNode({ label, glyph })` and, for the root, overrides the border to a 2px accent stroke. Because `setData` rebuilds nodes through the same renderer, emphasis survives every filter recompute, and the node still supports `setSelected` (selection highlight) so emphasis and selection coexist. No library node-renderer change; field/card rendering stays deferred.

### Side panel host: a `Border` layout with a fixed-width WEST legend, CENTER `DiagramView`
Mirrors [`StructurePanel`](frontend/src/dock/StructurePanel.ts#L71)'s `Border`-with-`Placement` composition (simpler than a `Split`, and it sidesteps the `Split.setPaneSize` apportion-all-panes papercut documented in `LIBRARY_NOTES.md`). The WEST region is a `Panel({ autoScroll: "auto" })` (per the tsui-autoScroll memory: `autoScroll` gives the scrollbar) stacking the direction/depth controls above the per-node checkbox list; CENTER is the `DiagramView`.

### FK column metadata + port shape added to the library model NOW (additive, forward-compat)
`DiagramEdgeData` gains optional `data?: unknown` (the app stores `{ columns, refColumns, refSchema, onDelete, onUpdate }`), plus `sourcePort?: string` / `targetPort?: string`. `DiagramNodeData` gains optional `ports?: DiagramPortData[]` and `data?: unknown`. These are inert this slice — `buildElkGraph` and `DiagramEdgeLayer` ignore unknown fields — but establish the keys so column-to-column edges are a later *additive* change: `buildElkGraph` will map `node.ports → ElkNode.ports` and route edges through `edge.sourcePort`/`targetPort`; `DiagramEdgeLayer` needs **no** change because it already draws purely from ELK-provided sections (which ELK routes to port coordinates automatically). Node identity stays the bare table name (single-schema scope) — no schema-qualified ids here.

---

## Public API

### Library — `typescript-ui/.../component/diagram/DiagramModel.ts` (additive)

```typescript
/** A connection point on a node (a column-row anchor for column-to-column edges). */
export interface DiagramPortData {
    /** Stable id, referenced by an edge's sourcePort/targetPort. */
    id: string;
    /** Optional ELK side hint ("NORTH" | "SOUTH" | "EAST" | "WEST"), applied when ports are laid out. */
    side?: string;
    /** Optional explicit port width fed to ELK. */
    width?: number;
    /** Optional explicit port height fed to ELK. */
    height?: number;
}

export interface DiagramNodeData {
    // ...existing id/label/glyph/width/height/layoutOptions unchanged...
    /** Optional connection ports (column anchors); consumed by ELK when column-to-column edges are enabled. */
    ports?: DiagramPortData[];
    /** Opaque consumer metadata (e.g. per-column rows); ignored by layout and the default renderer. */
    data?: unknown;
}

export interface DiagramEdgeData {
    // ...existing id/source/target/label unchanged...
    /** Optional source port id (a node port) the edge anchors to; falls back to the node when absent. */
    sourcePort?: string;
    /** Optional target port id the edge anchors to; falls back to the node when absent. */
    targetPort?: string;
    /** Opaque consumer metadata (e.g. FK columns/refColumns); ignored by layout and rendering. */
    data?: unknown;
}
```

`export type { DiagramPortData }` must be added to the diagram barrel [index.ts](../../typescript-ui/src/typescript/lib/component/diagram/index.ts#L11) alongside `DiagramData`/`DiagramNodeData`/`DiagramEdgeData`.

### App — `frontend/src/data/buildSchemaDiagram.ts` (modified)

```typescript
/** The FK metadata carried on each edge's `data` for later cardinality/column work. */
export interface FkEdgeData {
    columns: string[];      // local FK columns, in key order
    refColumns: string[];   // referenced columns, positionally paired with `columns`
    refSchema: string;
    onUpdate: string;
    onDelete: string;
}
// buildSchemaDiagram signature unchanged; each emitted edge now also sets
//   data: { columns, refColumns, refSchema, onUpdate, onDelete } satisfies FkEdgeData
```

### App — `frontend/src/data/relationDiagram.ts` (new, pure)

```typescript
/** Which FK directions to walk from the root. */
export type TraversalDirection = "downstream" | "upstream" | "both";

/**
 * BFS the directed FK graph from `rootId`, returning the ids reachable within
 * `maxDepth` hops. Downstream follows source→target; upstream follows
 * target→source; both follows either. Nodes in `excluded` are never entered.
 */
export function reachableNodeIds(
    edges: readonly DiagramEdgeData[],
    rootId: string,
    direction: TraversalDirection,
    maxDepth: number,
    excluded?: ReadonlySet<string>,
): Set<string>

/** Keep only nodes whose id is in `keep`, and edges whose BOTH endpoints are. */
export function subgraph(data: DiagramData, keep: ReadonlySet<string>): DiagramData

/**
 * The rooted view: nodes reachable from `root` within `depth` hops in
 * `direction`, plus the root itself (injected when `full.nodes` lacks it, e.g.
 * a view/matview root with no FK edges).
 */
export function rootedDiagram(
    full: DiagramData,
    root: DiagramNodeData,
    direction: TraversalDirection,
    depth: number,
): DiagramData

/**
 * The filtered view over a rooted base. Plain hide drops `hidden` + their
 * incident edges; prune additionally drops nodes made unreachable from `rootId`.
 */
export function applyHide(
    base: DiagramData,
    rootId: string,
    hidden: ReadonlySet<string>,
    prune: boolean,
    direction: TraversalDirection,
): DiagramData
```

### App — `frontend/src/dock/RelationDiagramPanel.ts` (new, view)

```typescript
/**
 * Build the relation-rooted diagram panel: a Border layout with a WEST
 * direction/depth + legend side panel and a CENTER DiagramView. The root node is
 * emphasized; double-clicking any node invokes `onSelectTable` with its id.
 *
 * @param full - The whole schema's graph (from buildSchemaDiagram).
 * @param root - The root relation's node data (id = bare table name; carries the
 *   kind glyph so a view/matview root still renders when it has no FK edges).
 * @param onSelectTable - Invoked with the activated node's table name (its id).
 * @returns A Component to host as the tab content.
 */
export function RelationDiagramPanel(
    full: DiagramData,
    root: DiagramNodeData,
    onSelectTable: (table: string) => void,
): Component
```

### App — `SqlAdminController` (additive)

```typescript
/**
 * Open a relation-rooted FK diagram in the Dock (deduped by panel id): the
 * relation as the emphasized root, its FK neighbours to a configurable depth and
 * direction. Reuses the schema-wide structure fetch; a view/matview root shows
 * alone (FKs are table-only). Node activation reuses openReferencedTable.
 */
async openRelationDiagram(ref: DbObjectRef, node?: TreeNode): Promise<void>

/** Fetch the whole schema's graph (getObjects + per-table getStructure → buildSchemaDiagram); null on error (already reported). */
private async buildSchemaGraphData(ref: DbObjectRef): Promise<DiagramData | null>

/** Stable id for a relation's diagram tab, distinct from its data/structure/definition tabs. */
private relationDiagramPanelId(ref: DbObjectRef): string
```

---

## Internal Structure

### `relationDiagram.ts` — traversal + subgraph

`reachableNodeIds` — BFS with an explicit depth loop (so `maxDepth = Number.POSITIVE_INFINITY` gives an unbounded prune walk):

```typescript
if (excluded?.has(rootId)) { return new Set(); }        // root hidden → empty graph

const visited = new Set<string>([rootId]);
let frontier: string[] = [rootId];

for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];

    for (const u of frontier) {
        for (const e of edges) {
            const down = (direction === "downstream" || direction === "both") && e.source === u;
            const up   = (direction === "upstream"   || direction === "both") && e.target === u;

            for (const v of [down ? e.target : null, up ? e.source : null]) {
                if (v !== null && !visited.has(v) && !excluded?.has(v)) {
                    visited.add(v);
                    next.push(v);
                }
            }
        }
    }

    frontier = next;
}

return visited;
```

`subgraph` — `nodes = data.nodes.filter(n => keep.has(n.id))`, `edges = data.edges.filter(e => keep.has(e.source) && keep.has(e.target))`, `layoutOptions` passed through unchanged.

`rootedDiagram`:
```typescript
const keep = reachableNodeIds(full.edges, root.id, direction, depth);
keep.add(root.id);

const data = subgraph(full, keep);

if (!data.nodes.some(n => n.id === root.id)) {
    data.nodes.unshift(root);   // view/matview root absent from a table-only full graph
}

return data;
```

`applyHide`:
```typescript
const keep = prune
    ? (() => { const k = reachableNodeIds(base.edges, rootId, direction, Number.POSITIVE_INFINITY, hidden); k.add(rootId); return k; })()
    : new Set(base.nodes.map(n => n.id).filter(id => !hidden.has(id)));

return subgraph(base, keep);
```

### `RelationDiagramPanel.ts` — state + wiring

State held in the factory closure: `direction: TraversalDirection = "both"`, `depth = DEFAULT_DEPTH` (1), `hidden = new Set<string>()`, `prune = false`, and the current `base: DiagramData`.

- `DEFAULT_DEPTH = 1` — one hop keeps the first cut readable (the constant is documented: a small default that shows the root's direct FK neighbours without a large layout).
- `rebuildBase()`: `base = rootedDiagram(full, root, direction, depth)`; `hidden.clear()`; rebuild the legend rows from `base.nodes`; then `applyFilter()`.
- `applyFilter()`: `view.setData(applyHide(base, root.id, hidden, prune, direction))`.

`nodeRenderer` (emphasis):
```typescript
const nodeRenderer = (n: DiagramNodeData): Component => {
    const node = DiagramNode({ label: n.label, glyph: n.glyph });

    if (n.id === root.id) {
        // 2px accent border marks the root; the DiagramNode default is 1px border.
        node.setBorder("2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))");
    }

    return node;
};
const view = DiagramView({ data: base, nodeRenderer });
view.on("activate", (n: DiagramNodeData) => onSelectTable(n.id));
```

Controls (WEST panel, top to bottom):
- **Direction** — `ComboBox` with items `[{ key: "downstream", label: "Downstream" }, { key: "upstream", label: "Upstream" }, { key: "both", label: "Both" }]`, `value: "both"`, `listeners: { change: v => { direction = v as TraversalDirection; rebuildBase(); } }`. (Explicit `{ key, label }` items — the plain-string ComboBox key bug is fixed but keyed items are unambiguous.)
- **Depth** — `ComboBox` with items `["1", "2", "3"]`, `value: "1"`, `listeners: { change: v => { depth = Number(v); rebuildBase(); } }`.
- **Prune** — `Checkbox` labelled "Hide with prune", `listeners: { change: v => { prune = v; applyFilter(); } }` (composed as an HBox row with a `Text` label, since `Checkbox` renders only the box).
- **Legend list** — one row per `base.nodes` entry: an HBox of a `Checkbox` (value `!hidden.has(id)`) + a `Text(name)`. Toggling off adds the id to `hidden`; on removes it; then `applyFilter()`. The **root** row's checkbox is disabled and checked (hiding the root is meaningless) and its label is the emphasized root name.

### `openRelationDiagram` / `buildSchemaGraphData` — controller shape

Refactor the fetch out of `openSchemaDiagram` (currently [lines 344-359](frontend/src/SqlAdminController.ts#L344)) into:
```typescript
private async buildSchemaGraphData(ref: DbObjectRef): Promise<DiagramData | null> {
    try {
        const objects    = await getObjects(ref.connectionId, ref.database!, ref.schema!);
        const tables     = objects.filter(o => o.kind === "table").map(o => o.name);
        const structures = await Promise.all(tables.map(name =>
            getStructure({ connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name, kind: "table" })));

        return buildSchemaDiagram(tables, structures);
    } catch (err) {
        this.notifyError(err, ref);

        return null;
    }
}
```
`openSchemaDiagram` becomes: `const data = await this.buildSchemaGraphData(ref); if (!data) return;` then its existing `addPanel` (status message uses `data.nodes.length` for the table count).

`openRelationDiagram`:
```typescript
async openRelationDiagram(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
    const id = this.relationDiagramPanelId(ref);

    if (this.dock.focusPanel(id)) { return; }

    const full = await this.buildSchemaGraphData(ref);

    if (!full) { return; }

    const root: DiagramNodeData = { id: ref.name!, label: ref.name!, glyph: KIND_GLYPH[ref.kind] };

    this.dock.addPanel({
        id,
        title  : `${ref.name} (relations)`,
        glyph  : "diagram-project",
        tooltip: this.panelTooltip(ref),
        content: RelationDiagramPanel(full, root, table => this.openReferencedTable({
            connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name: table, kind: "table",
        })),
    });
    this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}.${ref.name}: relations`);
}
```
`relationDiagramPanelId(ref)`: `` return `${this.panelId(ref)}::diagram`; `` — `panelId` already includes `.name`, so it never collides with the schema-diagram id (`${conn}/${db}/${schema}::diagram`).

Import `DiagramData`, `DiagramNodeData` types and `RelationDiagramPanel` into the controller. `KIND_GLYPH` and `DiagramNodeData`'s glyph must be registered — `objectGlyphs` (imported for `KIND_GLYPH`) registers table/view/matview glyphs at import.

---

## Ordered Implementation Steps

1. **Library model — `typescript-ui/.../component/diagram/DiagramModel.ts`.** Add `DiagramPortData` and the optional fields to `DiagramNodeData` (`ports?`, `data?`) and `DiagramEdgeData` (`sourcePort?`, `targetPort?`, `data?`) per _Public API_. Export `DiagramPortData` from the diagram `index.ts`. Check: `grep -n "DiagramPortData\|sourcePort\|ports?" src/typescript/lib/component/diagram/DiagramModel.ts`.

2. **Build the library.** `cd /home/jika/typescript/typescript-ui && npm run build:lib`. Confirms the new types land in `dist/lib/types` so the app's `file:` symlink sees them.

3. **`frontend/src/data/buildSchemaDiagram.ts` — carry FK metadata.** Add and export `FkEdgeData`. On each pushed edge add `data: { columns: fk.columns, refColumns: fk.refColumns, refSchema: fk.refSchema, onUpdate: fk.onUpdate, onDelete: fk.onDelete } satisfies FkEdgeData`. Do not change node/edge ids or the drop-dangling logic.

4. **`frontend/src/data/buildSchemaDiagram.test.ts` — extend.** Add a case asserting a kept edge carries `data.columns` / `data.refColumns` from the FK. Keep existing cases green (they use `toEqual` on edges — update those expectations to include the new `data` field, or switch the id/source/target assertions to per-field checks).

5. **Create `frontend/src/data/relationDiagram.ts`.** Pure per _Public API_ + _Internal Structure_. `import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram"` (type-only — no UI-bundle runtime import, preserving node-vitest purity). Full JSDoc, explicit return types, no DOM.

6. **Create `frontend/src/data/relationDiagram.test.ts`.** Cover the cases in _Expected Behaviour_ (downstream/upstream/both, depth limit, self-loop, view-root injection, plain hide keeps orphan, prune drops orphan, root-hidden→empty). Mirror `buildSchemaDiagram.test.ts` style.

7. **Create `frontend/src/dock/RelationDiagramPanel.ts`.** Per _Public API_ + _Internal Structure_. Import `DiagramView`, `DiagramNode`, and types from `@jimka/typescript-ui/component/diagram`; `Component`, `Panel` from `@jimka/typescript-ui/core`; `Border` from `@jimka/typescript-ui/layout`; `Placement` from `@jimka/typescript-ui/primitive`; `ComboBox`, `Checkbox`, `Text` from `@jimka/typescript-ui/component/input`; `HBox`, `VBox` from `@jimka/typescript-ui/layout`; the pure functions from `../data/relationDiagram`.

8. **`frontend/src/SqlAdminController.ts` — additive.** (a) Extract `buildSchemaGraphData` and rewrite `openSchemaDiagram` to use it (status count from `data.nodes.length`). (b) Add `openRelationDiagram` and `relationDiagramPanelId`. (c) Import `RelationDiagramPanel` and the `DiagramData`/`DiagramNodeData` types. No existing glyph change needed — `diagram-project` is already registered ([line 43](frontend/src/SqlAdminController.ts#L43)).

9. **`frontend/src/navigator/NavigatorTree.ts` — relation menu.** In the relation branch's `items` array ([after line 126](frontend/src/navigator/NavigatorTree.ts#L126), the "Open structure" item), add `{ text: "Show relations", glyph: "diagram-project", action: () => void controller.openRelationDiagram(ref, node) }`. Leave the schema-node branch and all other items unchanged.

10. **Typecheck + test.** `cd frontend && npm run typecheck && npm test` — green, including both diagram builder tests.

11. **Regression grep.** `grep -rn "openRelationDiagram\|relationDiagram\|RelationDiagramPanel\|buildSchemaGraphData\|relationDiagramPanelId" frontend/src` — matches only in the new/touched files.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts` (optional port/data fields) |
| Modify | `typescript-ui/src/typescript/lib/component/diagram/index.ts` (export `DiagramPortData`) |
| Create | `frontend/src/data/relationDiagram.ts` |
| Create | `frontend/src/data/relationDiagram.test.ts` |
| Create | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/data/buildSchemaDiagram.ts` (FK metadata on edges + `FkEdgeData`) |
| Modify | `frontend/src/data/buildSchemaDiagram.test.ts` (edge `data` assertions) |
| Modify | `frontend/src/SqlAdminController.ts` (additive: fetch helper, `openRelationDiagram`, `relationDiagramPanelId`) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` ("Show relations" item) |

---

## Expected Behaviour

### `relationDiagram.ts` (unit-testable)

Given `full` with nodes `a,b,c,d` and edges `a→b` (id `a.f1`), `b→c` (`b.f2`), `d→a` (`d.f3`):

- **Downstream depth 1 from `a`** → keep `{a, b}`; edges `{a.f1}`. (`b→c` dropped: `c` beyond depth 1; `d→a` dropped: upstream.)
- **Downstream depth 2 from `a`** → keep `{a, b, c}`; edges `{a.f1, b.f2}`.
- **Upstream depth 1 from `a`** → keep `{a, d}`; edges `{d.f3}`.
- **Both depth 1 from `a`** → keep `{a, b, d}`; edges `{a.f1, d.f3}`.
- **Self-referential FK** (`a→a`, id `a.f0`) with root `a`, any direction, depth ≥ 1 → keep contains `a`; the self-loop edge is kept.
- **View/matview root** — `rootedDiagram(full, {id:"v",label:"v",glyph:"eye"}, "both", 2)` where `v ∉ full.nodes` → `{ nodes: [v], edges: [] }` (root injected, no edges).
- **Plain hide** — base `{a,b,c}` edges `{a.f1,b.f2}`, `applyHide(base,"a",{b},prune=false,"downstream")` → nodes `{a, c}`, edges `{}` (`b` gone with its incident edges; `c` orphaned but **kept**).
- **Prune** — same inputs with `prune=true` → nodes `{a}`, edges `{}` (`c` unreachable from `a` once `b` is hidden, so dropped).
- **Root hidden** — `reachableNodeIds(edges, "a", dir, ∞, excluded={a})` → empty set (defensive; the UI never lets the root be hidden).
- **subgraph edge rule** — an edge survives only when BOTH endpoints are in `keep`.
- **layoutOptions passthrough** — `subgraph`/`rootedDiagram`/`applyHide` preserve `full.layoutOptions` verbatim.

### `buildSchemaDiagram.ts` (unit-testable)

- **Edge FK metadata** — a kept edge for `fk("fk_ab","b")` (columns `["x_id"]`, refColumns `["id"]`) carries `data.columns === ["x_id"]` and `data.refColumns === ["id"]`. Existing node/id/drop/self-ref/uniqueness/layout cases stay green.

### Controller / UI (manual verification — DOM, ELK layout, Dock, combo/checkbox events)

- Right-clicking a **table** shows "Show relations" among its items; selecting it opens a Dock tab `<name> (relations)` with the `diagram-project` glyph.
- The tab shows the root emphasized (2px accent border) with its FK neighbours to depth 1, both directions, laid out by ELK.
- Changing **Direction** to Downstream shows only the root's outgoing FKs; Upstream shows only tables that reference the root; Both shows the union. Changing **Depth** to 2/3 expands the neighbourhood (and resets any hidden nodes).
- Unchecking a legend node **hides** it and its edges; checking it back restores it. With **Hide with prune** on, unchecking an articulation node additionally removes the nodes it cut off from the root; with prune off, those nodes remain (edgeless).
- Double-clicking any node opens (or focuses) that table's data tab via `openReferencedTable`, revealing it in the navigator — identical to the schema-diagram and FK-link behaviour.
- Right-clicking a **view/materialized view** and choosing "Show relations" opens a tab showing that root **alone** (no FK edges), with a single (disabled, checked) legend entry.
- Re-invoking "Show relations" on the same relation focuses the existing tab (dedup), does not open a second; a relation diagram and that relation's data/structure/definition tabs coexist (distinct ids).
- A schema whose objects fail to load reports the error on the status bar and opens no tab.

---

## Verification

- `cd /home/jika/typescript/typescript-ui && npm run build:lib` — succeeds; new diagram model types flow to the app (required before the app typechecks).
- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — green, including `relationDiagram.test.ts` (all traversal/hide/prune cases) and the extended `buildSchemaDiagram.test.ts`.
- `cd frontend && npm run build` — succeeds (confirms `elkjs` + the new panel bundle).
- `grep -rn "openRelationDiagram\|RelationDiagramPanel\|relationDiagramPanelId\|buildSchemaGraphData" frontend/src` — only the new/touched files.
- Manual smoke (`npm run dev`): expand a database → schema → Tables; right-click a table → **Show relations**; toggle Direction/Depth; uncheck legend nodes with and without prune; double-click a node to open its data tab; re-open to confirm dedup; try a view root to confirm the lone-root behaviour.

---

## Potential Challenges

- **`build:lib` ordering.** The app won't typecheck against the new `DiagramEdgeData.data` field until `build:lib` regenerates `dist/lib/types`; run step 2 before the app steps. (Worktree checks also need the `node_modules` symlink to the main tree — see the worktree-node-modules memory.)
- **Existing edge-equality assertions.** `buildSchemaDiagram.test.ts` uses `toEqual` on whole edge objects; adding `data` to edges breaks those unless the expectations are updated — do it in step 4, not as a surprise in step 10.
- **Border WEST sizing.** The WEST legend panel takes its width from its preferred size; pin it (`preferredSize: { width: LEGEND_WIDTH, height: 0 }`) so it doesn't collapse — document `LEGEND_WIDTH` (a fixed side-panel width chosen to fit a checkbox + a typical table name).
- **`view.setData` and emphasis.** Emphasis lives in the `nodeRenderer`, which `setData` re-runs, so it persists across every filter recompute — do **not** try to re-apply emphasis imperatively after `setData`.
- **Optional: fit on open.** `DiagramView.zoomToFit()` after the first `"layout"` event would frame small rooted graphs nicely; optional and not required for correctness.

---

## Critical Files

- [frontend/src/data/buildSchemaDiagram.ts](frontend/src/data/buildSchemaDiagram.ts) + [its test](frontend/src/data/buildSchemaDiagram.test.ts) — the pure builder to extend and the purity/test pattern to mirror.
- [frontend/src/dock/SchemaDiagramPanel.ts](frontend/src/dock/SchemaDiagramPanel.ts) — the existing `DiagramView` wrapper + `"activate"` wiring the new panel builds on.
- [frontend/src/dock/StructurePanel.ts](frontend/src/dock/StructurePanel.ts) — `Border` + `Placement` + `autoScroll` composition to mirror for the side-panel host.
- [frontend/src/SqlAdminController.ts](frontend/src/SqlAdminController.ts) — `openSchemaDiagram` (the fetch to extract), `openReferencedTable` (node-activate target), `panelId`/`structurePanelId`, `Glyph.register`. **Shared file — keep edits additive.**
- [frontend/src/navigator/NavigatorTree.ts](frontend/src/navigator/NavigatorTree.ts) — the relation `"contextmenu"` `items` array to extend; the `isRelation` guard.
- [typescript-ui/.../diagram/DiagramModel.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts), [DiagramView.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts) (`nodeRenderer`, `setData`), [ElkLayoutEngine.ts](../../typescript-ui/src/typescript/lib/component/diagram/ElkLayoutEngine.ts) (`buildElkGraph` — where ports would later attach), [DiagramEdgeLayer.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts) (draws from ELK sections; no port change needed).

---

## Non-Goals

- **Column-to-column (port) edge rendering** — the model fields (`ports`, `sourcePort`/`targetPort`, `data`) are added now, but `buildElkGraph` port mapping and card/field node rendering are a later additive change.
- **Cardinality / crow's-foot rendering** — the FK `columns`/`refColumns` carried on edges feed this later; not drawn here.
- **Cross-schema / database-level diagram and schema-qualified node identity** — node ids stay bare table names; roots and edges stay within one schema.
- **View-dependency, trigger/function-dependency, and role/privilege graphs** — separate future features.
- **Editing / layout persistence** — the diagram stays read-only; direction/depth/hide state is not persisted across sessions.
- **A backend schema-wide structure endpoint** — the client keeps assembling from per-table calls (inherited from the base plan).
