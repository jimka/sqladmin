---
depends-on: [diagram-layout-settled-and-root-focus.md]
touches-shared:
  - ../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts
  - ../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts
  - ../typescript-ui/packages/lib/docs/components/DiagramView.md
  - ../typescript-ui/packages/lib/docs/reference/changelog.md
  - frontend/src/dock/RelationDiagramPanel.ts
  - frontend/src/dock/DatabaseDiagramPanel.ts
---

# Diagram Edge Interaction — Implementation Plan

## Overview

Two wishlist items make the diagram's edges answerable instead of decorative. Both need new library capability in the sibling repo `../typescript-ui`, consumed by the app through a `file:` dependency, so every library step lands before the app typechecks.

**(1) Clicking a column row emphasises the foreign keys attached to it.** Today this is impossible from the app: `DiagramView`'s selection is whole-node only ([DiagramView.ts:862](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L862)), and [`DiagramEdgeLayer`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts) can only redraw every edge from scratch through `setEdges`. The library gains an *edge emphasis* set that restyles drawn edges in place; the app resolves a clicked column row to its attached edge ids through a new pure helper and hands them over.

**(2) Hovering an edge shows a tooltip.** Edges are inert on purpose — the layer's constructor calls `setPointerEvents("none")` ([DiagramEdgeLayer.ts:230](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L230)) so node clicks fall through. Each edge gains an invisible wide "hit" path that opts *itself* back in, the root `<svg>` stays inert, and `DiagramView` emits `"edgehover"` / `"edgeleave"` carrying the model edges. The tooltip text is composed app-side.

Library files: `DiagramEdgeLayer.ts` and `DiagramView.ts` only — **no change to `DiagramModel.ts`** and no barrel change.[^no-model-change] After any library edit, `npm run build:lib` must run in `/home/jika/typescript/typescript-ui` before the app typechecks, because the app consumes the library's built, symlinked `dist/lib` rather than its sources.

This plan is written against the `DiagramView` the sibling [`plans/diagram-layout-settled-and-root-focus.md`](plans/diagram-layout-settled-and-root-focus.md) plan leaves behind — the double-buffered `rebuildNodes` / `applyLayout` and the `whenLaidOut()` deferred. Every method this plan touches is named below with the shape that plan gives it.

---

## Architecture Decisions

### Emphasis dims the others; it never brightens the selected

When a subset of edges is emphasised, every edge **outside** the set drops to a lower opacity. Edges inside the set are drawn exactly as they are today — same stroke, same width, same markers. On a dense diagram that reads far better than brightening a few lines against an already-busy canvas.[^dim-not-brighten] The de-emphasised opacity is `0.4`, the same strength `ChartLegend` already uses for a hidden series ([ChartLegend.ts:60](../typescript-ui/packages/lib/src/typescript/lib/component/chart/ChartLegend.ts#L60)) — the library's existing answer to "present but receded".

Card **rows** go the other way: the clicked row and the rows at the far end of each attached edge get an accent tint. A card has a handful of rows and a solid background, so a highlight is unambiguous there; the edge canvas is where dimming wins.

### Emphasis is a runtime verb, not an options-bag property

`setEdgeEmphasis(ids)` / `getEdgeEmphasis()` follow `selectNode(id)` / `getSelection()` in the same class ([DiagramView.ts:807](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L807)): a typed setter/getter pair over a private backing field, with **no** matching `DiagramViewOptions` field. ARCHITECTURE.md reserves the options bag for consumer-configurable *configuration*; transient interaction state stays off it.[^not-on-options]

### The emphasis set lives in the edge layer, and `setEdges` clears it

`DiagramEdgeLayer` owns the one `_edgeEmphasis` field. `DiagramView.setEdgeEmphasis` / `getEdgeEmphasis` are one-line forwarders holding no copy of their own.[^single-owner] Replacing the drawn edge set clears the emphasis, so a re-layout resets it — matching the sibling layout plan, whose `promoteIncomingNodes` likewise clears the node selection when a new graph is swapped in.

Because that plan double-buffers, the *old* edges stay painted (and stay emphasised) for the whole ELK round-trip after a `setData`; the reset lands with the new edges, in the same step that reveals them.

### Edges become hoverable through a per-edge hit path, not by making the layer interactive

Each drawn edge gets a second `<path>` beneath its visible one: same `d`, `stroke: transparent`, `stroke-width: 12`, `fill: none`, `pointer-events: stroke`. The root `<svg>` keeps `pointer-events: none` exactly as today, so empty canvas still pans and nodes still take their own clicks — an explicit `pointer-events` value on a descendant re-enables just that element.[^pointer-events-child]

### The hover payload is every edge within tolerance, resolved by arithmetic

The browser's hit test decides only *that* the pointer is on an edge; it always reports one topmost element, which is useless on a merged trunk where several routes share the same pixels. So the layer runs its own point-to-polyline distance test over every drawn route and returns all of them within `6` graph pixels. That array — not the topmost path — is what `"edgehover"` carries.[^why-arithmetic]

### Edges cannot be told apart on a shared trunk; the endpoints are the signal

A column's **out** port carries one edge per foreign key, so emphasising it emphasises all of them and they are drawn as separate lines — branching works naturally. A column's **in** port collects every referencing foreign key, and with `elk.layered.mergeEdges` on (the sibling [`plans/diagram-edge-merging-and-node-spacing.md`](plans/diagram-edge-merging-and-node-spacing.md) plan) those edges share one trunk.

**"Edges merged into the selected edge must not be selected" is not achievable on a shared trunk** — the selected edge and the others occupy the same pixels, so no per-edge styling can separate them there. This plan accepts that. The dim-the-others rule makes the shared segment read as emphasised (the trunk keeps full weight while unrelated edges recede), and the disambiguating signal is at the **endpoints**: the emphasised column rows on each card say exactly which foreign keys are in the set. No geometry splitting is attempted.

### The tooltip is composed by the app from the hover event, not carried on the model

`DiagramEdgeData` gains no `tooltip` field. The app listens to `"edgehover"` and shows the library `Tooltip` singleton itself.[^tooltip-app-side] It is shown immediately rather than after the 500 ms hover delay `Tooltip.attach` uses.[^no-delay]

### An edge press neither pans nor clears the selection

`_handlePointerDown` and `_handleClick` both gain an edge-target guard, so pressing an edge does nothing at all.[^edge-press]

---

## Public API

### `DiagramEdgeLayer` — new methods

```typescript
/**
 * Sets the emphasised edge ids. While the set is non-empty every edge NOT in
 * it is drawn at a reduced opacity; the emphasised edges keep their normal
 * weight. `null` or an empty array clears the emphasis. Ids naming no drawn
 * edge are kept but have no effect.
 *
 * @param ids - The edge ids to emphasise, or null to clear.
 *
 * @returns This layer, for method chaining.
 */
setEdgeEmphasis(ids: readonly string[] | null): this;

/**
 * The currently emphasised edge ids.
 *
 * @returns A copy of the emphasised id array; empty when nothing is emphasised.
 */
getEdgeEmphasis(): string[];

/**
 * Resolves a raw DOM event target to the edge whose invisible hit path it is.
 *
 * @param target - The raw DOM event target.
 * @returns The edge id, or null when the target is not an edge hit path.
 */
edgeIdAt(target: EventTarget | null): string | null;

/**
 * Every drawn edge whose route passes within the hit tolerance of a point, in
 * draw order. Several edges answer here wherever their routes overlap — which
 * is what makes a merged trunk answerable.
 *
 * @param x - Point x in unscaled graph coordinates.
 * @param y - Point y in unscaled graph coordinates.
 * @returns The routes within tolerance; empty when none is.
 */
edgesNear(x: number, y: number): DiagramEdgeRoute[];
```

Backing field: `private _edgeEmphasis: Set<string> = new Set();`. No `ComponentOptions` field — the layer takes plain `ComponentOptions` and this is runtime state.

### `DiagramView` — new methods

```typescript
/**
 * Emphasises a subset of the drawn edges: every edge outside the set recedes
 * to a lower opacity while the named ones keep their normal weight. Cleared by
 * `null`, by an empty array, and by the next layout that replaces the drawn
 * edges. Emits nothing.
 *
 * @param ids - The edge ids to emphasise, or null to clear.
 *
 * @returns This view, for method chaining.
 */
setEdgeEmphasis(ids: readonly string[] | null): this;

/**
 * The currently emphasised edge ids.
 *
 * @returns A copy of the emphasised id array; empty when nothing is emphasised.
 */
getEdgeEmphasis(): string[];
```

`setEdgeEmphasis` and `getEdgeEmphasis` forward straight to `this._edgeLayer`; `DiagramView` holds no backing field and gains no options field (see _Architecture Decisions_).

### `DiagramView` — new events

```typescript
export type DiagramViewEvent =
    "selection" | "activate" | "layout" | "contextmenu" | "edgehover" | "edgeleave";

on(event: "edgehover", listener: (edges: DiagramEdgeData[], event: MouseEvent) => void): this;
on(event: "edgeleave", listener: () => void): this;
```

`DiagramViewOptions.listeners` gains the two matching keys:

```typescript
listeners?: {
    // ...existing selection / activate / layout / contextmenu...
    edgehover?: (edges: DiagramEdgeData[], event: MouseEvent) => void;
    edgeleave?: () => void;
};
```

`emit` gains the two matching protected overloads. `DiagramEdgeData` must be added to `DiagramView.ts`'s existing type import from `~/component/diagram/DiagramModel.js`.

### App — `frontend/src/data/columnEmphasis.ts` (new, pure)

```typescript
import type { DiagramData } from "@jimka/typescript-ui/component/diagram";

/** What one column click emphasises. */
export interface ColumnEmphasis {
    /** Ids of every edge anchored to the clicked column's in or out port. */
    edgeIds: string[];
    /** Node id → column names to highlight on that card, including the clicked one. */
    columns: Map<string, string[]>;
}

/**
 * Resolve a clicked column to the foreign-key edges attached to it and to the
 * column rows at both ends of each. Pure; `data` is not mutated.
 *
 * @param data - The graph currently shown (card mode, with ports).
 * @param nodeId - The clicked card's node id.
 * @param column - The clicked column's name.
 *
 * @returns The attached edge ids and the per-node columns to highlight.
 */
export function columnEmphasis(data: DiagramData, nodeId: string, column: string): ColumnEmphasis;
```

### App — `frontend/src/data/fkEdgeTooltip.ts` (new, pure)

```typescript
import type { DiagramEdgeData } from "@jimka/typescript-ui/component/diagram";

/**
 * The `\n`-separated tooltip text for the edges under the pointer.
 *
 * @param edges - Every edge within the hit tolerance, in draw order.
 *
 * @returns The tooltip text, or null when no edge carries foreign-key data.
 */
export function fkEdgeTooltip(edges: DiagramEdgeData[]): string | null;
```

### App — `frontend/src/dock/edgeTooltip.ts` (new)

```typescript
/**
 * Wire a diagram view's edge-hover events to the shared Tooltip singleton.
 *
 * @param view - The view whose foreign-key edges get hover tooltips.
 */
export function attachFkEdgeTooltip(view: DiagramView): void;
```

### App — `TableCardNode`

```typescript
// Constructor gains a third parameter.
constructor(node: DiagramNodeData, isRoot: boolean, onSelectColumn?: (column: string) => void);

/**
 * Tint the named column rows and clear every other row's tint.
 *
 * @param columns - The column names to highlight; empty clears all.
 */
setEmphasisedColumns(columns: readonly string[]): void;
```

---

## Internal Structure

### `DiagramEdgeLayer` — the drawn-edge record

`_pathHandles: Handle[]` ([DiagramEdgeLayer.ts:212](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L212)) is replaced by a structured list, so a single edge's three elements can be found by id and restyled without a full rebuild:

```typescript
/** The elements drawn for one edge, so it can be hit-tested and restyled in place. */
interface DrawnEdge {
    id:    string;
    route: DiagramEdgeRoute;
    /** The visible stroked path. */
    path:  Handle;
    /** The invisible wide path that takes pointer events. */
    hit:   Handle;
    /** The mid-route label, when the edge carries one. */
    label: Handle | null;
}

/** Everything currently drawn, released and rebuilt by `rebuildPaths`. */
private _drawn: DrawnEdge[] = [];
```

New module-level constants:

```typescript
/**
 * Stroke width (px, unscaled graph units) of an edge's invisible hit path —
 * ±6px either side of the 1.5px visible hairline. A hairline is far too thin
 * to aim at, and this is deliberately wider than ELK's default 10px
 * `elk.spacing.edgeEdge`, so a bundle of parallel routes reports as a bundle
 * rather than forcing the user to land on exactly one of them.
 */
const EDGE_HIT_WIDTH = 12;

/** Half the hit width: the distance from a route within which it answers `edgesNear`. */
const EDGE_HIT_TOLERANCE = EDGE_HIT_WIDTH / 2;

/**
 * Opacity of an edge outside a non-empty emphasis set. Matches ChartLegend's
 * hidden-series opacity — the framework's existing "present but receded"
 * strength — so a dimmed edge is still traceable rather than gone.
 */
const DIMMED_EDGE_OPACITY = "0.4";

/** Opacity of an emphasised edge, and of every edge when nothing is emphasised. */
const NORMAL_EDGE_OPACITY = "1";
```

`rebuildPaths` ([DiagramEdgeLayer.ts:378](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L378)) changes in four ways, and is decomposed so it stays short: the release loop walks `_drawn` (`path`, `hit`, and `label` when present); a new private `drawHitPath(svg, d)` appends the hit path **before** the visible one; the visible path's `setAttr` gains `opacity: this.edgeOpacity(edge.id)`; and each drawn edge is pushed as a `DrawnEdge`. `drawLabel` returns its handle and takes the same opacity.

```typescript
/**
 * The opacity one edge draws at: reduced when an emphasis set is active and
 * this edge is not in it, normal otherwise.
 *
 * @param id - The edge id.
 * @returns The opacity attribute value.
 */
private edgeOpacity(id: string): string {
    if (this._edgeEmphasis.size === 0 || this._edgeEmphasis.has(id)) {
        return NORMAL_EDGE_OPACITY;
    }

    return DIMMED_EDGE_OPACITY;
}

/** Rewrites every drawn edge's opacity from the current emphasis set. */
private applyEdgeEmphasis(): void {
    for (const drawn of this._drawn) {
        const opacity = this.edgeOpacity(drawn.id);

        DOM.sink.apply(drawn.path, { setAttr: { opacity } });

        if (drawn.label) {
            DOM.sink.apply(drawn.label, { setAttr: { opacity } });
        }
    }
}
```

`setEdgeEmphasis` writes `_edgeEmphasis` then calls `applyEdgeEmphasis()`. `setEdges` clears `_edgeEmphasis` **before** calling `rebuildPaths()`, so the new edges draw undimmed. The hit paths never receive an opacity write — a dimmed edge is still hoverable.

The hit path's attributes:

```typescript
{
    d,
    fill:             "none",
    stroke:           "transparent",
    "stroke-width":   String(EDGE_HIT_WIDTH),
    "pointer-events": "stroke",
    // Neither `grab` (nothing pans here) nor `pointer` (nothing activates) is
    // honest over an edge, and this view's cursor always promises what a press
    // will do — so an edge shows the plain arrow.
    cursor:           "default",
}
```

### `DiagramEdgeLayer` — hit resolution

```typescript
edgeIdAt(target: EventTarget | null): string | null {
    if (target === null) {
        return null;
    }

    const handle = DOM.source.intern(target);

    return this._drawn.find(d => d.hit === handle)?.id ?? null;
}
```

A hit path has no children, so an exact handle match is enough — unlike `DiagramView.nodeIdAt` ([DiagramView.ts:1084](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1084)), which must also walk containment.

`edgesNear(x, y)` filters `_drawn` on a point-to-polyline distance, reusing the polyline the existing `labelPoint` helper already walks (`section.startPoint`, `section.bendPoints ?? []`, `section.endPoint`). Two new module-level pure functions carry the arithmetic: `distanceToSegment(px, py, ax, ay, bx, by)` (the standard clamped projection) and `distanceToRoute(sections, x, y)` (the minimum over every segment of every section). A route with no drawable segments answers `Infinity`.

### `DiagramView` — the edge-hover handlers

Two new handlers, declared and registered exactly like the six existing `_handleX` handlers (plain private methods; `Event` invokes them with the component as receiver):

```typescript
Event.addSubtreeListener(this, "mousemove", this._handleEdgeMouseMove);
Event.addSubtreeListener(this, "mouseout",  this._handleEdgeMouseOut);
```

`mousemove` / `mouseout` rather than `mouseenter` / `mouseleave`, per ARCHITECTURE.md: non-bubbling events never reach the framework's window-level capture handler.

```typescript
/** Edge ids of the last emitted "edgehover", joined, or null when not hovering. */
private _hoveredEdgeKey: string | null = null;
```

`_handleEdgeMouseMove(event: MouseEvent)`:

1. Return immediately while `this._panning` — a drag is not a hover.
2. `if (this._edgeLayer.edgeIdAt(event.target) === null) { this.leaveEdges(); return; }`
3. Convert the pointer to unscaled graph coordinates, the inverse of the mapping `zoomAboutViewportPoint` already uses ([DiagramView.ts:741](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L741)):
   ```typescript
   const rect = DOM.source.getViewportRect(this);
   const zoom = this.getZoom();
   const gx   = (event.clientX - rect.left - this._panX) / zoom;
   const gy   = (event.clientY - rect.top  - this._panY) / zoom;
   ```
4. `const routes = this._edgeLayer.edgesNear(gx, gy);` — empty means `leaveEdges()` and return.
5. Build `const key = routes.map(r => r.id).join(" ")`; return when it equals `_hoveredEdgeKey` (a move inside the same set re-emits nothing).
6. Join the routes back to the model by id — the mirror of `joinEdgeStyles` ([DiagramView.ts:535](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L535)) — dropping any id with no model edge, then set `_hoveredEdgeKey = key` and `emit("edgehover", edges, event)`.

`_handleEdgeMouseOut(event: MouseEvent)` calls `leaveEdges()` when `this._edgeLayer.edgeIdAt(event.target) !== null`. `leaveEdges()` is a private no-op unless `_hoveredEdgeKey !== null`, in which case it nulls the field and emits `"edgeleave"`.

### `DiagramView` — the two press guards

In `_handleClick` ([DiagramView.ts:1035](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1035)), immediately after the existing `isControlsTarget` guard:

```typescript
// A press on an edge is neither a node click nor a canvas click: it must not
// clear the selection the user is looking at.
if (this._edgeLayer.edgeIdAt(event.target) !== null) {
    return;
}
```

In `_handlePointerDown` ([DiagramView.ts:1167](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1167)), add `|| this._edgeLayer.edgeIdAt(event.target) !== null` to the existing early-return condition, and extend its comment to name edges alongside nodes and the control cluster.

`_handleDoubleClick` and `_handleContextMenu` need no change: both resolve through `nodeIdAt`, which answers `null` for a hit path, so they already no-op.

### App — `columnEmphasis`

Attachment is decided by the **port**, because a port is what actually draws the edge onto a row; the far-end column name is read from the edge's `FkEdgeData`, which is what `applyCardMode` built the port from ([buildSchemaDiagram.ts:158-174](frontend/src/data/buildSchemaDiagram.ts#L158)).

| Edge | Clicked | Attached? | Far end highlighted |
|---|---|---|---|
| `orders → customer`, `sourcePort = orders::customer_id::out` | `orders` / `customer_id` | yes (out) | `customer` / `refColumns[0]` |
| `orders → customer`, `targetPort = customer::id::in` | `customer` / `id` | yes (in) | `orders` / `columns[0]` |
| `orders → customer`, no `sourcePort` (column not fetched) | `orders` / `customer_id` | no | — |
| `orders → customer` | `orders` / `total` | no | — |

Only the first column pair is considered, matching the existing card-mode limitation — `applyCardMode` ports only `columns[0]` / `refColumns[0]`. The clicked `(nodeId, column)` is always added to `columns`, even when no edge attaches, so a click on a plain column visibly does something (its own row highlights, and the emphasis clears).

The module imports `portId` from `./schemaCardModel` and types only from the library and `./buildSchemaDiagram`, keeping the DOM-free purity discipline the other `frontend/src/data/` modules follow ([buildSchemaDiagram.ts:26-33](frontend/src/data/buildSchemaDiagram.ts#L26)).

### App — `fkEdgeTooltip`

An edge contributes when its `data` is an `FkEdgeData` (an object with a `columns` array). The rule, with its cases:

| Input | Output |
|---|---|
| no contributing edge | `null` |
| one edge: `orders → customer`, `columns ["customer_id"]`, `refColumns ["id"]`, `onDelete "CASCADE"`, `uncovered true` | `orders(customer_id) → customer(id)`<br>`ON DELETE CASCADE`<br>`No covering index` |
| one edge, both actions `"NO ACTION"`, covered | `orders(customer_id) → customer(id)` |
| three edges, all targeting `customer` on `["id"]` | `3 references to customer(id)`<br>`orders(customer_id)`<br>`invoices(customer_id)`<br>`payments(bill_to)` |
| two edges with different targets | `2 foreign keys here`<br>`orders(customer_id) → customer(id)`<br>`line_items(order_id) → orders(id)` |

- Endpoint names are the edge's `source` / `target` **node ids** verbatim, so the text is correct in the flat schema diagram (bare table names), the card diagram (bare names), and the database diagram (`schema.table`).
- The referential-action line joins the non-`"NO ACTION"` actions with `" · "`, matching `columnTooltip`'s attribute separator ([schemaCardModel.ts:124](frontend/src/data/schemaCardModel.ts#L124)); it is omitted when both are `"NO ACTION"`.
- The list is capped: at most `MAX_TOOLTIP_EDGES = 8` detail lines, then one `…and N more` line. The tooltip renders roughly 20px per line beside the cursor, so eight lines plus the heading stays under about 180px tall — comfortably inside a viewport without the tooltip needing to reposition.

### App — `RelationDiagramPanel` wiring, and the `super()`-cascade trap

The node renderer is built **before** `super()` (it is `super()`'s child's option) and `DiagramView`'s constructor invokes it during the cascade, so the renderer must not touch `this`. Both pieces it needs are locals, and the callback is re-pointed after `super()` returns:

```typescript
// Locals, because DiagramView's constructor calls nodeRenderer during super().
// `selectColumn` is re-pointed to the real handler once `this` exists; it can
// only ever be invoked by a user click, long after that.
const cards = new Map<string, TableCardNode>();
let selectColumn: (nodeId: string, column: string) => void = () => {};

const nodeRenderer = (n: DiagramNodeData): Component => {
    const card = TableCardNode(n, n.id === root.id, (column: string) => selectColumn(n.id, column));

    cards.set(n.id, card);

    return card;
};

// ...super({ ... }) ...

this.cards   = cards;
selectColumn = this.selectColumn;
```

`selectColumn` is a private arrow field (it is handed off by reference, per COMPONENT_CONVENTIONS.md (c)):

```typescript
private selectColumn = (nodeId: string, column: string): void => {
    const data = this.view.getData();

    if (data === null) {
        return;
    }

    const emphasis = columnEmphasis(data, nodeId, column);

    this.view.setEdgeEmphasis(emphasis.edgeIds);

    for (const [id, card] of this.cards) {
        card.setEmphasisedColumns(emphasis.columns.get(id) ?? []);
    }
};
```

Clearing has two paths, and neither needs new state:

- **Clicking empty canvas.** `DiagramView` already clears the node selection there and emits `"selection"` with an empty array; the panel listens and clears the emphasis alongside it.
- **Any filter change.** `applyFilter` calls `this.cards.clear()` immediately before `this.view.setData(...)`, and `setData` rebuilds every card through the renderer, so the rows come back untinted and the layer clears its own set.

`DatabaseDiagramPanel` and `SchemaDiagramPanel` get **only** the edge tooltip — they render plain nodes with no column rows, so there is nothing to click.

---

## Ordered Implementation Steps

### Library — `/home/jika/typescript/typescript-ui` (first; the app typechecks against the built output)

1. **`packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts`** — add the cases from _Expected Behaviour → `DiagramEdgeLayer`_ first, so they start red. `edgePathAttrs()`'s current "the one path with a `stroke-width`" heuristic no longer identifies a unique element (the hit path sets one too), so replace it with a helper that returns the attribute payloads for **all** edge paths and filter on `stroke === 'transparent'` to tell hit from visible. Existing cases keep asserting against the visible one.

2. **`packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts`** — the four constants, the `DrawnEdge` interface, `_drawn` replacing `_pathHandles`, `_edgeEmphasis`, `edgeOpacity`, `applyEdgeEmphasis`, `setEdgeEmphasis`, `getEdgeEmphasis`, `edgeIdAt`, `edgesNear`, the `distanceToSegment` / `distanceToRoute` module functions, `drawHitPath`, and the `rebuildPaths` / `drawLabel` changes — all per _Internal Structure_. `setEdges` clears `_edgeEmphasis` before rebuilding. Do **not** touch the constructor's `setPointerEvents("none")`; update the file-header comment to say the layer is inert *except* for the per-edge hit paths. Run `npm test` — step 1's cases go green.

3. **`packages/lib/tests/component/diagram/DiagramView.test.ts`** — add the cases from _Expected Behaviour → `DiagramView`_. They start red. Also update one existing test whose counts step 2 has already changed: `DiagramEdgeLayer — edge routing (U8)` ("creates one path per routed edge and clears prior paths on re-setEdges", [DiagramView.test.ts:1228](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1228)) counts `createElementNS('path')` and `removeChild` writes, and every edge now draws two paths — its three expectations become `4`, `4`, and `2`. Extend its name or comment to say the doubling is the hit path.

4. **`packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`** — widen `DiagramViewEvent`; add the two `on` overloads, the two `emit` overloads, and the two `listeners` keys; import `DiagramEdgeData`; add `setEdgeEmphasis` / `getEdgeEmphasis` forwarders next to `selectNode` / `getSelection`; add `_hoveredEdgeKey`, `_handleEdgeMouseMove`, `_handleEdgeMouseOut`, `leaveEdges`, and the two `Event.addSubtreeListener` registrations in `init` ([DiagramView.ts:1005](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1005)); add the two press guards. Run `npm test` — step 3's cases go green and the whole existing suite stays green.

5. **`packages/lib/docs/components/DiagramView.md`** — per _Documentation Impact_.

6. **`packages/lib/docs/reference/changelog.md`** — an `### Added` entry under the unreleased `## 0.3.0` heading for edge emphasis and the two edge-hover events.

7. **Checkpoint** — in `/home/jika/typescript/typescript-ui`: `npm test`, then `npm run lint` (the `local/no-raw-dom` baseline is empty; every new DOM touch goes through `DOM.sink` / `DOM.source`), then `npm run docs:api` (must finish with zero warnings — do not `{@link}` `DrawnEdge` or any other internal symbol from public JSDoc), then **`npm run build:lib`**. The app cannot typecheck until `build:lib` has succeeded.

### App — `sqladmin/frontend` (tests first, per the project's red-green flow)

8. **New `frontend/tests/data/columnEmphasis.test.ts`** — the cases from _Expected Behaviour → `columnEmphasis`_. Red.

9. **New `frontend/src/data/columnEmphasis.ts`** — per _Public API_ and _Internal Structure_. Type-only library imports plus `portId` from `./schemaCardModel` and the `FkEdgeData` type from `./buildSchemaDiagram`; no runtime UI-bundle import. Green.

10. **New `frontend/tests/data/fkEdgeTooltip.test.ts`** — the cases from _Expected Behaviour → `fkEdgeTooltip`_. Red.

11. **New `frontend/src/data/fkEdgeTooltip.ts`** — per _Internal Structure_'s rule table, including `MAX_TOOLTIP_EDGES` with its justifying comment. Green.

12. **New `frontend/src/dock/edgeTooltip.ts`** — `attachFkEdgeTooltip(view)`: `view.on("edgehover", …)` composes the text through `fkEdgeTooltip` and calls `Tooltip.show(text, event.clientX, event.clientY)` when it is non-null; `view.on("edgeleave", …)` calls `Tooltip.hide()`. Import `Tooltip` from `@jimka/typescript-ui/overlay`, as `TableCardNode` already does.

13. **`frontend/src/dock/TableCardNode.ts`** — add the optional `onSelectColumn` constructor parameter; build the rows into a local `Map<string, Component>` before `super()` and assign it to a `private readonly rows` field afterwards (COMPONENT_CONVENTIONS.md (b)); pass `onSelectColumn` into `columnRow`, which wires `Event.addListener(row, "click", …)` on the row it just created;[^app-row-listener] add `setEmphasisedColumns`. The row tint reuses the existing `CARD_SELECTED_BG` constant — extend its comment to say it doubles as the row-emphasis tint and stacks over a selected card's own tint. Do not stop propagation: a column click must still bubble to the card so `DiagramView` selects the table as it does today.

14. **`frontend/src/dock/RelationDiagramPanel.ts`** — the `cards` / `selectColumn` locals and the renderer per _Internal Structure_; the `cards` field; the `selectColumn` arrow field; `this.cards.clear()` at the top of `applyFilter` ([RelationDiagramPanel.ts:162](frontend/src/dock/RelationDiagramPanel.ts#L162)) before `setData`; a `view.on("selection", …)` listener clearing the emphasis when the payload is empty; and `attachFkEdgeTooltip(view)` after `super()`.

15. **`frontend/src/dock/SchemaDiagramPanel.ts`** — one line: `attachFkEdgeTooltip(this)` in the constructor, beside the existing `this.on("activate", …)` wiring. (This panel *is* the view.)

16. **`frontend/src/dock/DatabaseDiagramPanel.ts`** — one line: `attachFkEdgeTooltip(view)` after `super()`, beside the other post-`super()` `view.on(...)` wiring.

17. **Regression greps** (from `/home/jika/typescript/sqladmin`):
    - `grep -rn '_pathHandles' ../typescript-ui/packages/lib` — expect zero matches.
    - `grep -n 'setPointerEvents' ../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts` — expect exactly one match, the constructor's `"none"` (the layer root stays inert; only the hit paths opt back in, and they do so through an SVG attribute, not this setter).
    - `grep -rn 'attachFkEdgeTooltip' frontend/src` — expect seven lines: the definition, plus one import and one call in each of `SchemaDiagramPanel.ts`, `RelationDiagramPanel.ts`, and `DatabaseDiagramPanel.ts`.

18. **Checkpoint** — `cd frontend && npm run typecheck` (needs step 7's `build:lib`), then `npm test`.

19. **Manual verification** — per _Verification_.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts` |
| Modify | `../typescript-ui/packages/lib/docs/components/DiagramView.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog.md` |
| Create | `frontend/src/data/columnEmphasis.ts` |
| Create | `frontend/tests/data/columnEmphasis.test.ts` |
| Create | `frontend/src/data/fkEdgeTooltip.ts` |
| Create | `frontend/tests/data/fkEdgeTooltip.test.ts` |
| Create | `frontend/src/dock/edgeTooltip.ts` |
| Modify | `frontend/src/dock/TableCardNode.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/dock/SchemaDiagramPanel.ts` |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` |

---

## Expected Behaviour

### Unit-testable — `DiagramEdgeLayer` (`DiagramEdgeLayer.test.ts`, `RecordingDOMSink`)

**Hit paths:**
- One route produces two `<path>` creations; the hit one carries `stroke: "transparent"`, `stroke-width: "12"`, `pointer-events: "stroke"`, `fill: "none"`, `cursor: "default"`, and the same `d` as the visible one.
- The hit path is appended **before** the visible path (assert the `appendChild` write order).
- The hit path carries no `marker-end`, no `marker-start`, and no `stroke-dasharray`, whatever the route's `style` says.
- A route whose sections produce an empty `d` creates neither path.
- A second `setEdges` releases both paths of each previous edge (two routes → four `removeChild` writes).

**`edgeIdAt`:**
- The hit handle of route `e1` answers `"e1"`; its visible path handle answers `null`; an unrelated interned target answers `null`; `null` answers `null`.

**`edgesNear`** (routes `e1` `(0,0)→(100,0)` and `e2` `(0,0)→(100,0)→(100,100)`, i.e. a shared trunk that splits at `x = 100`):
- `edgesNear(50, 0)` → both, in draw order `['e1', 'e2']`.
- `edgesNear(50, 5)` → both (within the 6px tolerance).
- `edgesNear(50, 20)` → `[]`.
- `edgesNear(100, 60)` → `['e2']` only — past the split.
- A route with no sections is never returned.

**Emphasis:**
- With routes `e1`, `e2`: `setEdgeEmphasis(['e1'])` writes `opacity: "0.4"` on `e2`'s visible path and `opacity: "1"` on `e1`'s; neither hit path receives an opacity write.
- `setEdgeEmphasis(null)` and `setEdgeEmphasis([])` both restore `opacity: "1"` on every visible path.
- `getEdgeEmphasis()` returns `['e1']` after the first call and `[]` after the clear.
- An emphasis set naming an unknown id dims every drawn edge (nothing matches) and does not throw.
- A dimmed edge carrying `style.label` gets the same reduced opacity on its `<text>`.
- `setEdges` after `setEdgeEmphasis(['e1'])` leaves `getEdgeEmphasis()` empty and every redrawn path at `opacity: "1"`.
- Emphasis set before the element exists survives the first `render()` (drive `setEdgeEmphasis` before `getElement(true)`, then assert the drawn opacities).

### Unit-testable — `DiagramView` (`DiagramView.test.ts`, `StubEngine` + `RecordingDOMSink`)

- `setEdgeEmphasis(['e'])` reaches the layer (`view._edgeLayer.getEdgeEmphasis()` is `['e']`) and `view.getEdgeEmphasis()` reads the same back.
- `_handleClick` on an edge hit path leaves an existing selection intact and emits no `"selection"` (contrast the existing empty-canvas case, which clears).
- `_handlePointerDown` on an edge hit path leaves `_panning` false.
- `_handleDoubleClick` and `_handleContextMenu` on an edge hit path emit nothing (unchanged behaviour, pinned).
- `_handleEdgeMouseMove` over an edge on a sized, laid-out view emits `"edgehover"` once, with the **model** `DiagramEdgeData` objects (assert an edge's `data` passthrough survives, not just its id) and the originating `MouseEvent`.
- A second move at a different point still inside the same edge set emits nothing further.
- A move that leaves the edge (target is the view root) emits `"edgeleave"` once; a further such move emits nothing.
- `_handleEdgeMouseOut` on the edge's hit path emits `"edgeleave"`; on a non-edge target it emits nothing.
- With `_panning` true, `_handleEdgeMouseMove` emits nothing.
- Coordinate mapping: with a pan of `(100, 50)` and zoom `2`, a move whose client point maps to a graph point 30px off the route emits nothing, while one mapping to a point on the route emits `"edgehover"` — proving the pan/zoom inverse is applied.
- The `listeners: { edgehover, edgeleave }` bag is dispatched (extend the existing option-routing test).

### Unit-testable — `columnEmphasis` (`frontend/tests/data/columnEmphasis.test.ts`)

Fixture: `orders → customer` (`sourcePort orders::customer_id::out`, `targetPort customer::id::in`, `columns ["customer_id"]`, `refColumns ["id"]`) and `invoices → customer` (`sourcePort invoices::customer_id::out`, `targetPort customer::id::in`).

- Clicking `customer` / `id` → `edgeIds` is both edges; `columns` maps `customer → ["id"]`, `orders → ["customer_id"]`, `invoices → ["customer_id"]`. (The merge case.)
- Clicking `orders` / `customer_id` → `edgeIds` is `["orders.…"]` only; `columns` maps `orders → ["customer_id"]` and `customer → ["id"]`.
- Clicking `orders` / `total` (no port) → `edgeIds` empty; `columns` maps `orders → ["total"]` only.
- Clicking a node id not in the graph → `edgeIds` empty; `columns` still carries the clicked pair.
- An edge with no `sourcePort` is not attached at its source even when its `FkEdgeData.columns[0]` matches the clicked column.
- A column that is both an out port on one edge and an in port on another returns both edges (branching plus merging at one column).
- The input `DiagramData` is not mutated.

### Unit-testable — `fkEdgeTooltip` (`frontend/tests/data/fkEdgeTooltip.test.ts`)

Every row of the rule table in _Internal Structure_, plus:
- `[]` → `null`.
- Edges whose `data` is `undefined` or carries no `columns` array → `null`.
- A mix of one contributing and one non-contributing edge → the single-edge form for the contributing one.
- A composite key (`columns ["a","b"]`, `refColumns ["x","y"]`) renders `t(a, b) → u(x, y)`.
- Ten same-target edges → the heading plus eight source lines plus `…and 2 more`.

### Manual verification (needs the running app, a real ELK worker, and a browser)

Everything app-side is manual-verify only: `frontend/tests/` runs in vitest's node environment over pure helpers, and the diagram panels import UI-bundle modules that touch `document` at load. Log in with Host **`sqladmin-db`** (not `localhost`).

**Column emphasis** — right-click a table → *Show relations*:
- Click a column row on the root card that owns a foreign key: that row and the referenced table's key row both tint, the attached edge keeps full weight, and every other edge recedes.
- Click a *referenced* key column on a parent card that several tables point at: every referencing edge stays at full weight, all others recede, and one row on each referencing card tints. On a merged trunk the shared segment reads as one emphasised line — the accepted limitation; the emphasised rows are what say which foreign keys are in the set.
- Click a plain (non-key) column: only that row tints and every edge returns to normal weight.
- Click empty canvas: the tint and the dimming both clear.
- Change Direction / Depth / *Hide with prune* / *Highlight FKs without a covering index* while a column is emphasised: the emphasis clears with the re-layout and the previous graph stays on screen until the new one appears (the sibling layout plan's double buffer).
- Verify the dim strength reads correctly at zoom 0.25 and at zoom 4, and against both themes.

**Edge tooltip** — in the relation diagram, the schema diagram (right-click a schema → *Open schema diagram*), and the database diagram in Tables mode:
- Hovering a lone edge shows the full detail, positioned beside the cursor and legible over the canvas.
- Hovering a merged trunk shows the `N references to …` summary listing every foreign key on it; sliding the pointer along the trunk past the point where it splits swaps the tooltip to that one edge's full detail.
- Moving off the edge hides the tooltip; moving straight from one edge to another swaps it.
- The tooltip does not appear while dragging a pan across an edge.
- Hovering a widely-referenced table's trunk caps the list and shows `…and N more`.
- A foreign key flagged by *Highlight FKs without a covering index* shows its `No covering index` line.

**Pointer regressions** — on every diagram (including the dependency, inheritance, role-membership, role-grants and Explain diagrams, which get no tooltip but do get hit paths):
- Dragging empty canvas still pans; dragging from an edge does nothing at all; dragging from a node still does not pan.
- Clicking an edge does not clear the node selection; clicking empty canvas still does.
- Double-clicking a node still activates it; right-clicking a node still opens its menu; right-clicking an edge leaves the browser's own menu.
- On the database diagram in Tables mode, clicking a schema container box still selects it — except within the ~12px band where an edge crosses it (see _Potential Challenges_).
- The cursor is `grab` over canvas, `pointer` over a node, and the plain arrow over an edge.

---

## Verification

- **Library**: in `/home/jika/typescript/typescript-ui` — `npm test`, `npm run lint`, `npm run docs:api` (zero warnings), `npm run build:lib`.
- **App typecheck**: `cd frontend && npm run typecheck` — requires the rebuilt library.
- **App unit tests**: `cd frontend && npm test` — the two new test files cover every _unit-testable_ app case; `buildSchemaDiagram.test.ts`, `relationDiagram.test.ts`, `schemaCardModel.test.ts`, and `fkCardinality.test.ts` must stay green **without edits**.
- **Grep invariants**: the three greps in step 17.
- **Manual smoke**: the _Manual verification_ list above. Entry points: `SqlAdminController.openRelationDiagram`, `openSchemaDiagram`, `openDatabaseDiagram`.

---

## Documentation Impact

`DiagramView` and `DiagramViewOptions` are already re-exported from `component/diagram/index.ts`, and `DiagramEdgeLayer` / `DiagramEdgeRoute` are too, so every new member reaches the public API with **no barrel change**. `packages/lib/docs/api/` is generated TypeDoc output and is gitignored — run `npm run docs:api` as a zero-warning check, but never hand-edit it and do not commit it.

`packages/lib/docs/components/DiagramView.md` (the only hand-written page covering this component; there is no `DiagramEdgeLayer.md`):

- **Common methods** table — add `setEdgeEmphasis(ids)` / `getEdgeEmphasis()` ("Dim every edge outside the given set, so the named ones stand out; `null` clears. Reset by the next layout"), `on('edgehover', fn)` ("Fires with **every** model edge within the pointer's hit tolerance and the originating `MouseEvent` — several where routes overlap"), and `on('edgeleave', fn)`.
- **Interaction** — add an *Edges* bullet: edges take pointer events through an invisible wide hit path, so hovering one fires `"edgehover"` while the canvas around it still pans; a press on an edge neither pans nor clears the selection.
- **Interaction → Pan** bullet — extend "a drag that starts on a node (leaf or container) or on the control cluster does not pan" to include an edge, and note the plain-arrow cursor there.
- **Edge style** section — add a closing paragraph: emphasis is a *view-level* concern layered over `DiagramEdgeStyle`, dimming rather than restyling, so a consumer's own `stroke` / marker choices are preserved while a subset is emphasised.
- **Notes** — add a bullet stating that edges sharing a route (e.g. under `elk.layered.mergeEdges`) cannot be told apart along the shared segment, and that `"edgehover"` reports all of them so a consumer can describe the bundle.

`packages/lib/docs/reference/changelog.md` — an `### Added` entry under the unreleased `## 0.3.0` per step 6.

No `llms.txt` change: it is generated from `scripts/llms/manifest.data.mjs` and carries no diagram entry.

App side: no documentation change. `frontend/COMPONENT_CONVENTIONS.md` is unaffected, `LIBRARY_NOTES.md` records library *defects* the app works around and this plan adds capability rather than working around one, and `TODO.md` has no entry for either wishlist item.

---

## Potential Challenges

- **An edge crossing a compound container box steals the container's click within the hit band.** On a compound graph the edge layer sits above containers and below leaves ([DiagramView.ts:78-81](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L78)), so a hit path overlaying a schema box wins the target. Accepted: the band is 12 graph pixels against a box hundreds of pixels wide, and the guard makes the click a no-op rather than a wrong action. Named as a manual check so it is seen, not discovered. Leaves are unaffected — they sit above the layer.
- **`mousemove` now runs on every pointer move inside a diagram.** The handler returns immediately while panning and does nothing beyond one handle comparison per drawn edge until the pointer is actually on a hit path; the distance arithmetic only runs then. `DiagramView` already carries a subtree `pointermove` listener for panning, so this is not a new class of cost.
- **The hit band scales with the zoom.** Both the hit stroke and the tolerance are in unscaled graph units, so at zoom 0.25 the grabbable band is 3 screen pixels. That is consistent (the drawn line shrinks too) but hard to aim at; the mitigation is zooming in, not a screen-space tolerance, which would need the layer to know the view's zoom.
- **Emphasis ids that name no drawn edge dim everything.** A stale set (e.g. computed from a graph that has since been filtered) leaves the whole canvas receded with nothing standing out. The app avoids this by clearing on every `setData`, and the layer clears its own set on `setEdges`.
- **The tooltip and the column-row tooltips can both be armed.** Column rows use `Tooltip.attach`'s 500 ms delay while the edge tooltip is immediate, and both drive the same singleton — the last `show`/`hide` wins, which is the correct outcome since the pointer is only ever over one of them.
- **Library rebuild ordering.** The app typechecks against the library's built declarations, so `npm run build:lib` must run after every library edit and before the app typecheck (step 7 before step 18).

---

## Critical Files

- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts) — the whole of the rendering change. Read the file header (the "non-interactive overlay" claim this plan narrows), `_pathHandles` (212), `setEdges` (257), `rebuildPaths` (378), `drawLabel` (448), and `labelPoint` / `midpointAlong` (128, 147) — the polyline walk `distanceToRoute` mirrors.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts) — `DiagramViewEvent` (47), the z-index constants (78-81), the `listeners` bag (123), `joinEdgeStyles` (535) as the id-join precedent, `getSelection` / `selectNode` (795, 807) as the state-pair precedent, `on` / `off` / `emit` (901, 919, 932), `init`'s listener registrations (1005), `_handleClick` (1035), `nodeIdAt` (1084), `isControlsTarget` (1134), `_handleWheel` (1151) for the `getViewportRect` + client-coordinate idiom, and `_handlePointerDown` (1167).
- [`plans/diagram-layout-settled-and-root-focus.md`](plans/diagram-layout-settled-and-root-focus.md) — the version of `rebuildNodes` / `applyLayout` / `handleLayoutFailure` this plan composes with. Read its _Internal Structure → The two node sets_ before touching `DiagramView`.
- [`../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts`](../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts) — `attrWrites()` / `edgePathAttrs()`, the helper that must be generalised in step 1.
- [`../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts`](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts) — `StubEngine`, `StubDiagramView`, `flush()`, `fixedResult()`, `makeEvent`, and the file-level comment on why real dispatched events live only in the first `describe` block. Every new case drives the `_handleX` methods directly, as the rest of the file does.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/chart/ChartLegend.ts:60`](../typescript-ui/packages/lib/src/typescript/lib/component/chart/ChartLegend.ts#L60) — `HIDDEN_OPACITY`, the de-emphasis strength `DIMMED_EDGE_OPACITY` mirrors.
- [`../typescript-ui/packages/lib/src/typescript/lib/overlay/Tooltip.ts`](../typescript-ui/packages/lib/src/typescript/lib/overlay/Tooltip.ts) — `show(text, x, y)` / `hide()`, and `attach`'s 500 ms delay the edge tooltip deliberately skips.
- [`frontend/src/dock/TableCardNode.ts`](frontend/src/dock/TableCardNode.ts) — `columnRow` (115), the three pointer-transparent labels (131-133), the `Tooltip.attach` precedent (151), and `CARD_SELECTED_BG` (56).
- [`frontend/src/data/schemaCardModel.ts:142`](frontend/src/data/schemaCardModel.ts#L142) — `portId`, and the file header's DOM-free purity discipline.
- [`frontend/src/data/buildSchemaDiagram.ts:158-174`](frontend/src/data/buildSchemaDiagram.ts#L158) — where `sourcePort` / `targetPort` are assigned from `columns[0]` / `refColumns[0]`; `FkEdgeData` (42).
- [`frontend/src/dock/RelationDiagramPanel.ts`](frontend/src/dock/RelationDiagramPanel.ts) — the pre-`super()` locals (88-131), `applyFilter` (162), and the file header explaining which helpers must be arrow fields.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — sections (b) the super-cascade trap and (c) handlers registered by reference.

---

## Non-Goals

- **A `tooltip` field on `DiagramEdgeData`.** The app composes the text from the hover payload instead.[^tooltip-app-side]
- **Edge selection and an edge context menu.** `"edgehover"` / `"edgeleave"` are the whole event surface; nothing in either wishlist item needs a persistent edge selection, and adding one would need its own visual vocabulary alongside node selection.
- **Splitting a merged trunk's geometry** so overlapping edges can be told apart along the shared segment. Named as an accepted limitation in _Architecture Decisions_.
- **Edge tooltips on the dependency, inheritance, role-membership, role-grants, and Explain diagrams.** Their edges carry kind/direction data rather than `FkEdgeData`; they still gain hit paths and emit `"edgehover"`, but no panel listens.
- **Column emphasis outside the card-mode relation diagram.** The flat schema and database diagrams render plain nodes with no column rows to click.
- **A screen-space (zoom-independent) hit tolerance.**
- **Changing `DiagramEdgeLayer`'s root `pointer-events: none`.** Only the per-edge hit paths opt back in.
- The scope of the sibling diagram UI/UX plans: `elkjs-0-12-upgrade`, `diagram-layout-settled-and-root-focus`, `diagram-edge-merging-and-node-spacing`, and the depth-limit / expand-indicator plan. Nothing here duplicates them.

---

## Notes

[^no-model-change]: Neither item needs a model field. Emphasis is addressed by edge **id**, which `DiagramEdgeData` already has, and the hover payload is the model edge object itself, so the consumer reads whatever it already put on `data`. That matters for sequencing: the depth-limit / expand-indicator plan adds `DiagramNodeData.badge` to `DiagramModel.ts`, and leaving that file untouched here removes the only file the two plans would otherwise contend over.

[^dim-not-brighten]: Brightening a subset means finding a treatment louder than the default edge — a heavier stroke, an accent colour, or a glow. On a schema diagram with dozens of crossing hairlines that adds visual noise exactly where the diagram is already dense, and it collides with the two edge treatments the app already spends: the crow's-foot markers and the coverage warning tint (`fk-diagram-cardinality-and-index-coverage`). Dimming spends nothing — the emphasised edges are drawn exactly as they always are — and the contrast comes from everything else stepping back. It also degrades gracefully: emphasising *every* edge is indistinguishable from emphasising none, which is the correct reading.

[^not-on-options]: ARCHITECTURE.md's third DOM-write rule says the `XOptions` bag is for consumer-configurable properties, and that "runtime caches, framework-managed bookkeeping, derived state" stay in a private backing field. Edge emphasis is transient interaction state that the next layout discards, so a construction-time `edgeEmphasis` option would be meaningless the moment the first ELK result landed. The sibling layout plan reached the same conclusion for `_focusNodeId`, keeping `initialFocusNode` as construction-time intent and `focusNode(id)` as the runtime verb; here there is no construction-time intent at all, so there is no option.

[^single-owner]: The alternative is a `Set` on `DiagramView` mirrored into the layer. That needs the view to notice every path that invalidates it — `setData`, `applyLayout`, `handleLayoutFailure` — and the sibling layout plan puts two of those behind a generation guard and a double buffer, so a mirror would have to be cleared in the right one of several branches. One owner, cleared by the single method that replaces the drawn edges, has no such branch to get wrong. Reading through a child component's cache is still a cached read, not a DOM read, so it satisfies ARCHITECTURE.md's "reads return cached state".

[^pointer-events-child]: `pointer-events` is inherited, but an explicit value on a descendant overrides the ancestor's — unlike `visibility: hidden` or `opacity: 0`, a parent's `pointer-events: none` does not veto a child that re-enables itself. This is the standard "inert overlay with a few live spots" idiom. Keeping the root `<svg>` inert is what preserves the two behaviours the layer's file header promises: a press on empty canvas reaches `DiagramView` and starts a pan, and a press on a node reaches the node component. The `<text>` labels inherit `none` and stay inert, which is right — a label sitting over a node must not intercept that node's click.

[^why-arithmetic]: The browser hit-tests to exactly one element, and with merged edges the topmost hit path is an arbitrary choice among several routes drawn on the same pixels. Reporting only that one would make the merged case unanswerable, which is the case the tooltip exists for. Running the distance test in the layer also gets the "past the split" behaviour for free: the pointer never leaves the topmost edge's hit path as it slides along, so no `mouseover` fires, and only a recomputation on `mousemove` notices that the other routes have peeled away. The cost is a short polyline walk per drawn edge, run only when the pointer is already on a hit path.

[^tooltip-app-side]: The rejected alternative is a `tooltip` string on `DiagramEdgeData` that the layer attaches through `Tooltip.attachToElement(hitPath, text)` — appealing because it mirrors `style.label`, which is likewise model-carried and layer-rendered. It fails on the merged case, which is the whole point of the feature: one tooltip per hit path means a shared trunk shows whichever edge happens to be on top, and the "3 references to customer(id)" summary is not a concatenation of three per-edge strings but a different sentence that only the app can compose. Composing it needs the *set*, which only the hover event delivers. Passing the set into the library so it could compose the text would move app vocabulary ("foreign key", "covering index") into a generic graph component.

[^no-delay]: `Tooltip.attach` / `attachToElement` wait 500 ms so a tooltip does not flash while the pointer merely crosses a control. An edge is different: the user has aimed at a 12-pixel band on an otherwise empty canvas, so the hover is deliberate and immediate feedback confirms which edge was hit. `"edgehover"` also only fires when the reported set *changes*, so sliding along an edge does not re-show. Delaying would additionally mean the app owning a timer and cancelling it on dispose, for no gain.

[^edge-press]: Without the guards an edge press would do two wrong things. `_handlePointerDown` starts a pan whenever the target is neither the control cluster nor a node, so the graph would jump under a press meant to inspect an edge — and the cursor would have promised `grab` over a line that is not draggable canvas. `_handleClick` clears the node selection on any non-node target, so inspecting an edge would silently deselect the table the user was looking at. Doing nothing is the honest outcome: this plan adds no edge selection, so there is no positive action for a press to take.

[^app-row-listener]: `Event.addListener(row, "click", …)` from inside `columnRow` listens on a component that same function just created and owns — the app-side counterpart of the library's cell-editor carve-out, and the same shape as [`frontend/src/shell/QueriesView.ts:292`](frontend/src/shell/QueriesView.ts#L292), which registers a `keydown` on the `List` it built. A plain `Component` exposes no semantic `on("action")` (only interactive controls do), so there is no typed surface to route through. The exact-target form is correct here because the row's three labels are already pointer-transparent ([TableCardNode.ts:131-133](frontend/src/dock/TableCardNode.ts#L131)), so a click's target is always the row element itself.
