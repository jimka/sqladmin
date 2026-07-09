---
touches-shared:
  - frontend/src/SqlAdminController.ts   # buildSchemaGraphData column fetch — shared with fk-diagram-cardinality-and-index-coverage
  - frontend/src/data/buildSchemaDiagram.ts
---

# Column-Level ER Diagram — Implementation Plan

## Overview

Upgrade the relation-rooted ER diagram from label+glyph boxes to **table-card** nodes that list each column (name, type, PK/FK markers), and anchor foreign-key edges **column-to-column** — the FK's local column row on the source card to the referenced column row on the target card — via ELK ports. This activates two model fields that already exist but are inert: `DiagramNodeData.ports` / `DiagramPortData` and `DiagramEdgeData.sourcePort` / `targetPort` ([DiagramModel.ts:12-93](../../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts#L12)), fed by the FK columns already carried on each edge's `data` ([buildSchemaDiagram.ts:29-35](frontend/src/data/buildSchemaDiagram.ts#L29)).

The work splits across two repos. **Library** (`typescript-ui`): teach `buildElkGraph` to emit ELK ports from `node.ports` and route edges through `edge.sourcePort` / `targetPort`, plus a two-field additive extension to `DiagramPortData` (explicit `x`/`y`) that `buildElkGraph` needs to pin a port at a column-row coordinate. **App** (`sqladmin`): a pure card-mode extension to `buildSchemaDiagram` (derive column rows, assign ports, set edge ports, size the node), an app-side `nodeRenderer` that paints the card, a per-table `getColumns` fetch in `buildSchemaGraphData`, and wiring in `RelationDiagramPanel` / `openRelationDiagram`.

Card mode is **opt-in** and confined to the **relation-rooted** diagram — its rooted+depth+hide interaction ([RelationDiagramPanel.ts:55-101](frontend/src/dock/RelationDiagramPanel.ts#L55)) keeps the rendered neighbourhood small, which is the only scope where full column cards stay readable. The schema-wide diagram ([SchemaDiagramPanel.ts](frontend/src/dock/SchemaDiagramPanel.ts)) keeps today's flat label nodes.

---

## Architecture Decisions

### The card-DOM ↔ ELK-port geometry seam — one shared constants module

This is the crux. The rendered card row and the ELK port that an edge attaches to must sit at the **same** vertical coordinate, and neither side may measure the other. The seam is a single pure module `frontend/src/data/schemaCardModel.ts` exporting the card metrics (`CARD_WIDTH`, `CARD_HEADER_HEIGHT`, `CARD_ROW_HEIGHT`) and the derived coordinates (`columnPortY(index)`, `cardHeight(columnCount)`). Both consumers read from it:

- The **pure builder** (`buildSchemaDiagram`, card mode) sets each node's explicit `width = CARD_WIDTH` / `height = cardHeight(n)` and, for each port, `y = columnPortY(index)`, `x = 0` (WEST / referenced-column anchor) or `CARD_WIDTH - 1` (EAST / FK-source anchor).
- The **card renderer** (`TableCardNode`) builds a `VBox` of a header (`CARD_HEADER_HEIGHT`) followed by one fixed-height row (`CARD_ROW_HEIGHT`) per column, at width `CARD_WIDTH`.

Because column row *i*'s vertical centre is `CARD_HEADER_HEIGHT + i*CARD_ROW_HEIGHT + CARD_ROW_HEIGHT/2` on **both** sides, the edge lands on the row without either side inspecting the other. `DiagramView` guarantees the card is sized to exactly `(node.width, node.height)`: `collectNodeSizes` prefers the explicit `node.width/height` over any measured preferred size ([DiagramView.ts:274-288](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L274)), and `applyLayout` writes that same size back onto the component ([DiagramView.ts:303-311](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L303)). So the DOM box the card fills is the exact box ELK positioned the ports within — the ports are never measured from the DOM.

### ELK port positioning — FIXED_POS with explicit x/y (minimal model addition)

Pinning a port to a specific row centre requires giving ELK the port's exact coordinate, which means the card node must carry `elk.portConstraints=FIXED_POS` and each port must carry an `x`/`y`. `DiagramPortData` today has `id`, `side`, `width`, `height` but **no position** ([DiagramModel.ts:12-21](../../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts#L12)). The minimal library addition is two optional fields, `x?: number` / `y?: number`, on `DiagramPortData`; `buildElkGraph` passes them through. This keeps ports inert for existing callers (both fields optional, unused when `ports` is absent) and lets the app own all geometry. `portConstraints` is set by the **app** (a per-node `layoutOptions` entry the builder writes), not baked into the library — the library stays layout-policy-free.

### Ports live only where an edge needs one

A card lists every column, but only columns that participate in an intra-schema FK get a port: for each surviving FK edge, the **source** node gets an EAST out-port for its first local column and the **target** node gets a WEST in-port for its first referenced column. A column both referenced by an upstream FK and used as a downstream FK source gets two distinct ports (`…::in` on WEST, `…::out` on EAST) at the same `y`. Ports are de-duplicated per (node, column, side) so several edges sharing an endpoint column reuse one port. This keeps the ELK port count minimal and avoids reserving space for unused anchors.

### Composite FKs anchor to the first column pair

`DiagramEdgeData` has a single `sourcePort`/`targetPort`, so a multi-column FK is anchored to its **first** column pair (`columns[0] → refColumns[0]`) and still renders as one edge. Splitting a composite FK into one edge per column pair is a Non-Goal — one anchored edge conveys the relationship; per-column fan-out would clutter the card.

### DiagramEdgeLayer and mapElkResult need no change (verified)

`DiagramEdgeLayer` draws each edge purely from the ELK-provided `sections` (`startPoint`/`bendPoints`/`endPoint`) with no knowledge of nodes or ports ([DiagramEdgeLayer.ts:44-58,157-193](../../typescript-ui/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L44)). Ports only change **where** ELK routes those section endpoints; the coordinate space is unchanged (a flat graph — all edges on `root` — so section coordinates are graph coordinates, the same space node `x/y` live in). `mapElkResult` maps node coords + edge sections and ignores ports on output ([ElkLayoutEngine.ts:152-172](../../typescript-ui/src/typescript/lib/component/diagram/ElkLayoutEngine.ts#L152)) — nothing to add. The layer and result mapper stay byte-for-byte as-is; the arrowhead already lands at the target (referenced/PK) end, which is the correct FK→PK direction.

### Card mode is opt-in; the flat path is untouched

`buildSchemaDiagram(tables, structures)` keeps its exact current signature and output when called without the new optional `columnsByTable` argument (its existing tests stay green). Passing `columnsByTable` switches on card mode: node `data`, `ports`, `width/height`, `layoutOptions`, and edge `sourcePort/targetPort`. `buildSchemaGraphData` fetches columns only when its caller asks (`openRelationDiagram` → yes; `openSchemaDiagram` → no), so the schema-wide diagram is unchanged and pays no extra fetch.

### Column fetch cost

Card mode adds one `getColumns` call per table across the **whole** schema (not just the rendered neighbourhood) because `buildSchemaGraphData` assembles the full graph before the panel roots/filters it, and port assignment needs each table's ordered column list at build time. The calls run in `Promise.all` alongside the existing structure fetch. The rooted+depth+hide interaction limits what **renders**, not what is fetched. A lazy per-neighbourhood column fetch is a Non-Goal (it would move port assignment out of the pure builder). This mirrors the `fk-diagram-cardinality-and-index-coverage` sibling plan, which also adds a `getColumns` fetch here — the two share this fetch (see Non-Goals / Potential Challenges).

---

## Public API

### Library — `DiagramPortData` (add two optional fields)

```typescript
export interface DiagramPortData {
    id: string;
    side?: string;                       // existing
    width?: number;                      // existing
    height?: number;                     // existing
    /** Explicit port x relative to the node's top-left, fed to ELK under FIXED_POS. */
    x?: number;                          // NEW
    /** Explicit port y relative to the node's top-left, fed to ELK under FIXED_POS. */
    y?: number;                          // NEW
}
```

### Library — `ElkLayoutEngine` internal ELK shapes (no export change)

```typescript
interface ElkPort {
    id: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    layoutOptions?: Record<string, string>;
}
interface ElkNode {
    // …existing fields…
    ports?: ElkPort[];                   // NEW
}
```

`buildElkGraph` gains: per child, `ports: node.ports?.map(...)` (id/x/y/width/height + `{ "elk.port.side": side }` when `side` set); per edge, `sources: [edge.sourcePort ?? edge.source]`, `targets: [edge.targetPort ?? edge.target]`.

### App — `frontend/src/data/schemaCardModel.ts` (new, pure)

```typescript
export const CARD_WIDTH: number;          // fixed card + ELK node width (= EAST port x anchor)
export const CARD_HEADER_HEIGHT: number;  // table-name header row height
export const CARD_ROW_HEIGHT: number;     // one column row height

export interface ColumnRowData { name: string; type: string; pk: boolean; fk: boolean; }
export interface CardNodeData  { columns: ColumnRowData[]; }   // shape of DiagramNodeData.data in card mode

export function cardHeight(columnCount: number): number;       // CARD_HEADER_HEIGHT + n*CARD_ROW_HEIGHT
export function columnPortY(index: number): number;            // row-centre y for column at `index`
export function deriveColumnRows(columns: ColumnMeta[], foreignKeys: ForeignKeyMeta[]): ColumnRowData[];
export function portId(nodeId: string, column: string, dir: "in" | "out"): string;
```

### App — `buildSchemaDiagram` (add optional third argument)

```typescript
export function buildSchemaDiagram(
    tables: string[],
    structures: TableStructure[],
    columnsByTable?: Map<string, ColumnMeta[]>,   // NEW — presence switches on card mode
): DiagramData;
```

### App — `frontend/src/dock/TableCardNode.ts` (new, UI)

```typescript
export function TableCardNode(node: DiagramNodeData, isRoot: boolean): Component;
```

### App — `buildSchemaGraphData` (add options arg)

```typescript
private async buildSchemaGraphData(
    ref: DbObjectRef,
    opts?: { withColumns?: boolean },   // NEW
): Promise<DiagramData | null>;
```

---

## Internal Structure

### Card-mode branch of `buildSchemaDiagram`

When `columnsByTable` is present, after building the flat nodes/edges as today:

1. **Node data + size.** For each node `name`, `cols = columnsByTable.get(name) ?? []`; set `node.data = { columns: deriveColumnRows(cols, structures[i].foreignKeys) }`, `node.width = CARD_WIDTH`, `node.height = cardHeight(cols.length)`, `node.layoutOptions = { "elk.portConstraints": "FIXED_POS" }`.
2. **Port collection.** Walk the *kept* edges. For each edge with `data.columns[0] = c` present in the source table's `cols`, record a needed `(sourceNode, c, "out")`; for `data.refColumns[0] = r` present in the target table's `cols`, record `(targetNode, r, "in")`. De-dup per (node, column, dir).
3. **Port emission.** For each node, build `DiagramPortData[]` from its recorded ports: `id = portId(name, col, dir)`, `y = columnPortY(indexOf col in cols)`, `x = dir === "out" ? CARD_WIDTH - 1 : 0`, `width = height = 1`, `side = dir === "out" ? "EAST" : "WEST"`.
4. **Edge ports.** On each edge set `sourcePort = portId(source, columns[0], "out")` when that port was emitted (else leave undefined → anchors to node), and `targetPort = portId(target, refColumns[0], "in")` likewise.

Port `y` uses `(CARD_ROW_HEIGHT - 1) / 2` inside `columnPortY` so the 1px port centres on the row centre; the ≤0.5px offset is immaterial at diagram scale. Document that constant in `schemaCardModel.ts`.

### `TableCardNode`

A `Panel` (fixed `preferredSize = { CARD_WIDTH, cardHeight }`, bordered like `DiagramNode`) with a `VBox`: a header `Text` (the table name, `isRoot` → accent border, mirroring [RelationDiagramPanel.ts:63-71](frontend/src/dock/RelationDiagramPanel.ts#L63)) then one fixed-height (`CARD_ROW_HEIGHT`) row per `CardNodeData.columns` entry showing `name`, `type`, and PK/FK glyph markers. Every child sets `pointer-events: none` so clicks/dblclicks fall through to the card (the `DiagramNode` precedent, [DiagramNode.ts:108-126](../../typescript-ui/src/typescript/lib/component/diagram/DiagramNode.ts#L108)). A node whose `data` is absent or has no columns (e.g. an injected view/matview root, [relationDiagram.ts:102-104](frontend/src/data/relationDiagram.ts#L102)) renders header-only.

---

## Ordered Implementation Steps

**Phase A — Library ports (typescript-ui), landed and rebuilt first so the app can consume it.**

1. `DiagramModel.ts`: add optional `x?: number` / `y?: number` to `DiagramPortData` with JSDoc (per Public API). No other change.
2. `ElkLayoutEngine.ts`: add the `ElkPort` interface and `ports?: ElkPort[]` on `ElkNode`. In `buildElkGraph`, map `node.ports` to ELK ports (id/x/y/width/height, plus `layoutOptions: { "elk.port.side": p.side }` only when `p.side` is set) and change the edge map to `sources: [edge.sourcePort ?? edge.source]`, `targets: [edge.targetPort ?? edge.target]`. Leave `mapElkResult` untouched.
3. `tests/component/diagram/ElkLayoutEngine.test.ts`: add cases — (a) a node with `ports` maps to ELK `ports` with side layoutOptions; (b) an edge with `sourcePort`/`targetPort` maps to those port ids in `sources`/`targets`; (c) an edge without ports still maps to `[source]`/`[target]` (regression). Run `npm test` in `typescript-ui` — expect green.
4. Rebuild the library: `cd /home/jika/typescript/typescript-ui && npm run build:lib`. This is what the app's `file:` dep resolves against; the app sees no change until this runs.

**Phase B — App pure model (sqladmin), node-vitest-testable.**

5. Create `frontend/src/data/schemaCardModel.ts` per Public API (constants + `cardHeight` + `columnPortY` + `deriveColumnRows` + `portId` + `ColumnRowData`/`CardNodeData`). Type-only import of `ColumnMeta`/`ForeignKeyMeta` from `../contract`; **no** `@jimka/typescript-ui` runtime import (keep the DOM-free purity discipline, [buildSchemaDiagram.ts:16-21](frontend/src/data/buildSchemaDiagram.ts#L16)).
6. Create `frontend/src/data/schemaCardModel.test.ts`: cover `deriveColumnRows` (PK flag, FK flag from FK local columns, type mapping), `cardHeight`, `columnPortY`, `portId`.
7. `frontend/src/data/buildSchemaDiagram.ts`: add the optional `columnsByTable` param and the card-mode branch (Internal Structure). Keep the flat path (no arg) byte-identical. Import metrics/helpers from `schemaCardModel.ts`.
8. `frontend/src/data/buildSchemaDiagram.test.ts`: add card-mode cases — node carries `data.columns` + `width`/`height` + `portConstraints`; a single-column FK sets `sourcePort`/`targetPort` and emits the matching EAST/WEST ports at the right `y`; a self-referential FK yields both an in- and out-port on the one node; the flat path (no `columnsByTable`) is unchanged. Run `npm test` in `frontend` — expect green.

**Phase C — App rendering + wiring (manual-verify).**

9. Create `frontend/src/dock/TableCardNode.ts` (Internal Structure). It may import UI-bundle components (it is not a `data/` module).
10. `frontend/src/dock/RelationDiagramPanel.ts`: replace the inline `nodeRenderer` ([RelationDiagramPanel.ts:63-71](frontend/src/dock/RelationDiagramPanel.ts#L63)) with `n => TableCardNode(n, n.id === root.id)`. The panel's rooting/filter/legend logic is unchanged — `full` now already carries card `data`/`ports` from the controller.
11. `frontend/src/SqlAdminController.ts`: give `buildSchemaGraphData` an `opts?: { withColumns?: boolean }`; when set, `Promise.all` a `getColumns(...)` per table alongside the structures fetch ([SqlAdminController.ts:381-382](frontend/src/SqlAdminController.ts#L381)), build a `Map<string, ColumnMeta[]>`, and pass it to `buildSchemaDiagram`. `openRelationDiagram` calls `buildSchemaGraphData(ref, { withColumns: true })` ([SqlAdminController.ts:412](frontend/src/SqlAdminController.ts#L412)); `openSchemaDiagram` stays `buildSchemaGraphData(ref)` ([SqlAdminController.ts:346](frontend/src/SqlAdminController.ts#L346)).
12. Typecheck + build: `cd frontend && npm run build`. Manual-verify per Verification.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `../../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts` |
| Modify | `../../typescript-ui/src/typescript/lib/component/diagram/ElkLayoutEngine.ts` |
| Modify | `../../typescript-ui/tests/component/diagram/ElkLayoutEngine.test.ts` |
| Create | `frontend/src/data/schemaCardModel.ts` |
| Create | `frontend/src/data/schemaCardModel.test.ts` |
| Modify | `frontend/src/data/buildSchemaDiagram.ts` |
| Modify | `frontend/src/data/buildSchemaDiagram.test.ts` |
| Create | `frontend/src/dock/TableCardNode.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |

---

## Expected Behaviour

### Unit-testable (pure)

Library — `buildElkGraph` (`ElkLayoutEngine.test.ts`):
- A node with `ports: [{ id: "p", x: 0, y: 30, width: 1, height: 1, side: "WEST" }]` maps to an ELK child whose `ports[0]` is `{ id, x, y, width, height, layoutOptions: { "elk.port.side": "WEST" } }`.
- A port with no `side` maps with no `layoutOptions` (undefined), not an empty object mislabelled.
- An edge `{ source: "a", target: "b", sourcePort: "a::c::out", targetPort: "b::d::in" }` maps to `sources: ["a::c::out"]`, `targets: ["b::d::in"]`.
- An edge with neither port maps to `sources: ["a"]`, `targets: ["b"]` (regression — existing behaviour).

App — `schemaCardModel.test.ts`:
- `deriveColumnRows`: a PK column → `pk: true`; a column named in any FK's `columns` → `fk: true`; `type` = `ColumnMeta.dataType`; order preserved.
- `cardHeight(0) === CARD_HEADER_HEIGHT`; `cardHeight(3) === CARD_HEADER_HEIGHT + 3*CARD_ROW_HEIGHT`.
- `columnPortY(0)` = row-0 centre; `columnPortY(i)` increases by `CARD_ROW_HEIGHT` per index.
- `portId("t", "c", "out")` is stable and distinct from `portId("t", "c", "in")`.

App — `buildSchemaDiagram.test.ts` (card mode):
- With `columnsByTable`, each node gets `data.columns` (from `deriveColumnRows`), `width === CARD_WIDTH`, `height === cardHeight(n)`, `layoutOptions["elk.portConstraints"] === "FIXED_POS"`.
- A single-column intra-schema FK `a.x_id → b.id`: node `a` emits an EAST out-port for `x_id` at `columnPortY(indexOf x_id in a's cols)` with `x = CARD_WIDTH-1`; node `b` emits a WEST in-port for `id` at `x = 0`; the edge's `sourcePort`/`targetPort` reference those ids.
- A composite FK anchors to `columns[0]`/`refColumns[0]` only (one port each side).
- A self-referential FK yields one node with both an out- and an in-port (distinct ids).
- An FK whose `columns[0]` is not in the source table's fetched columns leaves `sourcePort` undefined and emits no such port (graceful fallback to node anchor).
- Without `columnsByTable` the output is unchanged (no `ports`, no `data.columns`, no explicit size) — all existing assertions hold.

### Manual-verify (UI / ELK / geometry)

- **Card rendering.** `openRelationDiagram` on a table with FKs shows each node as a card: table name header + one row per column with type and PK/FK markers; the root card carries the accent border.
- **Column-to-column edges.** Each FK edge visibly leaves the source card at its FK column's row and arrives at the target card at the referenced column's row (arrowhead at the referenced/PK end). Confirm the endpoints line up with the row centres at zoom 1 and after zoom/pan.
- **Layout.** ELK lays cards out left-to-right without overlap; edges route to ports, not node centres.
- **Interaction unchanged.** Direction/depth/hide/prune controls and the legend still re-filter; double-clicking a card opens its table (`onSelectTable(n.id)`); single-click selection still works (card has no selected highlight — acceptable, `applySelectedVisual` no-ops on a plain card).
- **Header-only root.** `openRelationDiagram` on a view/matview root renders a header-only card and no ports (no table columns fetched for the injected root).
- **Schema diagram unchanged.** `openSchemaDiagram` still shows flat label nodes with node-to-node edges and issues no `getColumns` calls.

---

## Verification

- Library: `cd /home/jika/typescript/typescript-ui && npm test` (diagram suite green), then `npm run build:lib`.
- App unit: `cd /home/jika/typescript/sqladmin/frontend && npm test` — `schemaCardModel.test.ts`, `buildSchemaDiagram.test.ts` (card + flat), existing `relationDiagram.test.ts` green.
- App typecheck/build: `cd frontend && npm run build`.
- `grep -rn "portConstraints" frontend/src` — appears only in `buildSchemaDiagram.ts` (the app owns port policy; the library stays policy-free).
- Manual smoke (per Expected Behaviour → Manual-verify): navigator → right-click a table with FKs → "Show relations" → confirm cards + column-to-column edges; then right-click a schema → "Open schema diagram" → confirm flat nodes unchanged.

---

## Potential Challenges

- **Port coordinate drift.** If the card renderer ever measures/wraps text so a row is not exactly `CARD_ROW_HEIGHT`, edges detach from rows. Mitigation: fixed row heights and fixed `CARD_WIDTH`; type/name overflow is clipped/ellipsised, never wrapped.
- **ELK FIXED_POS port support.** Confirm the pinned x/y are honoured (not re-spread) during the manual smoke; if ELK ignores them, the fallback is `FIXED_ORDER` with `side`+index — but that reintroduces the reverse-coupling the shared-constants seam avoids, so prefer FIXED_POS.
- **Shared `getColumns` fetch with the cardinality sibling.** Both this plan and `fk-diagram-cardinality-and-index-coverage` add a per-table `getColumns` to `buildSchemaGraphData`. Whichever lands second must reuse the fetch already there rather than issuing a second round of calls.
- **Whole-schema column fetch on large schemas.** Many tables → many `getColumns` calls up front. Mitigation: `Promise.all`; the rooted view caps what renders. Real remedy (lazy fetch) is a Non-Goal.

---

## Critical Files

- [DiagramModel.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts) — `DiagramPortData`, `node.ports`, `edge.sourcePort/targetPort`, `edge.data` (the fields this plan activates).
- [ElkLayoutEngine.ts](../../typescript-ui/src/typescript/lib/component/diagram/ElkLayoutEngine.ts) — `buildElkGraph` (the only library logic change) + the `ElkNode`/`ElkExtendedEdge` shapes.
- [DiagramView.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts) — `nodeRenderer`, `collectNodeSizes` (explicit-size precedence), `applyLayout` (writes ELK size back), `activate` event — the seam the card relies on.
- [DiagramEdgeLayer.ts](../../typescript-ui/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts) — read to confirm the no-change conclusion (draws from ELK sections only).
- [buildSchemaDiagram.ts](frontend/src/data/buildSchemaDiagram.ts) — the FK edge data + the purity discipline the new module must follow.
- [RelationDiagramPanel.ts](frontend/src/dock/RelationDiagramPanel.ts) — the `nodeRenderer` seam and root emphasis.
- [SqlAdminController.ts](frontend/src/SqlAdminController.ts) — `buildSchemaGraphData`, `openRelationDiagram`, `openSchemaDiagram`.
- [StructurePanel.ts](frontend/src/dock/StructurePanel.ts) — how columns/PK/FK are already presented (`buildColumnsGrid`, `buildForeignKeysGrid`), to mirror field semantics in the card.
- [contract.ts](frontend/src/contract.ts) — `ColumnMeta.isPrimaryKey`, `ForeignKeyMeta.columns/refColumns`.

---

## Non-Goals

- **Crow's-foot cardinality / edge markers** — owned by `fk-diagram-cardinality-and-index-coverage` (a library `DiagramEdgeLayer` change). It composes with column edges but is out of scope here.
- **Per-column edge fan-out for composite FKs** — anchor to the first column pair; one edge per FK.
- **Card mode for the schema-wide diagram** — kept flat; full cards for a whole schema are unreadable and the fetch cost is unbounded.
- **Lazy per-neighbourhood column fetch** — would move port assignment out of the pure builder; fetch the whole schema's columns up front.
- **Collapse/expand or a per-card size cap** — the rooted+depth+hide interaction already bounds the rendered set; an explicit column collapse affordance is deferred.
- **Selected-card highlight**, editing columns, view/inheritance/role graphs, and the cross-schema database-level diagram.
