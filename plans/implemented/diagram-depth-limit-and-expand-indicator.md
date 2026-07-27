---
depends-on: [diagram-layout-settled-and-root-focus.md]
touches-shared:
  - ../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts
  - ../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts
  - ../typescript-ui/packages/lib/docs/components/DiagramView.md
  - ../typescript-ui/packages/lib/docs/reference/changelog.md
  - frontend/src/SqlAdminController.ts
  - frontend/src/dock/TableCardNode.ts
  - frontend/src/dock/RelationDiagramPanel.ts
  - frontend/src/dock/DatabaseDiagramPanel.ts
  - frontend/src/dock/RelationGraphPanel.ts
---

# Diagram Depth Limit & Expand Indicator — Implementation Plan

## Overview

The last wishlist item of the deferred diagram UI/UX pass: show fewer nodes on a rooted diagram's first render, let the user widen the cut, and mark the nodes whose neighbours were left out.

Three pieces.

1. **Every rooted diagram gets a Direction + Depth control.** Two of them already do — [`RelationDiagramPanel`](frontend/src/dock/RelationDiagramPanel.ts#L109) and [`DatabaseDiagramPanel`](frontend/src/dock/DatabaseDiagramPanel.ts#L114). The relation-rooted dependency and inheritance graphs do not: they render through [`RelationGraphPanel`](frontend/src/dock/RelationGraphPanel.ts#L33), a bare `DiagramView` subclass with no controls, after the controller has already narrowed the graph with an unbounded [`rootedDiagram`](frontend/src/SqlAdminController.ts#L1842) call. A new sibling panel gives those two entry points the same controls, and a new shared base class owns the control column for all three panels that have one.

2. **A `+N` marker on a node whose neighbours the depth limit cut.** The count is computed by a pure helper beside [`reachableNodeIds`](frontend/src/data/relationDiagram.ts#L26); it is carried to the renderer through a new library model field `DiagramNodeData.badge`, drawn by the stock [`DiagramNode`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramNode.ts#L52) and by the app's own [`TableCardNode`](frontend/src/dock/TableCardNode.ts#L67).

3. **A `Deeper` button** in the control column that steps Depth to the next choice, enabled exactly while some drawn node still carries a marker. The Depth control also gains an `All` choice for the unbounded walk `reachableNodeIds` already accepts.

**Depth limits what is *drawn*, not what is *fetched*.** No backend endpoint and no frontend API call takes a depth parameter; every diagram fetch returns the whole graph and all narrowing is client-side display filtering over the fetched `DiagramData`. Raising the depth never issues a request.

Library work lands first, in the sibling repo `/home/jika/typescript/typescript-ui`, with an `npm run build:lib` checkpoint before the app typechecks — the app consumes the library's built, symlinked `dist/lib` through a `file:` dependency, not its sources. Diagram sources live under `packages/lib/src/typescript/lib/component/diagram/`, tests under `packages/lib/tests/component/diagram/`.

This plan is written against the `DiagramView` that [`plans/diagram-layout-settled-and-root-focus.md`](plans/diagram-layout-settled-and-root-focus.md) leaves behind, and it supersedes one of that plan's app-side steps — see _Architecture Decisions → The rooted relation graph moves to a new panel_.

---

## Architecture Decisions

### Depth controls go on rooted diagrams only

A depth is a hop count from a root. A diagram with no root has nothing to count from, so it gets no control. Worked out per entry point:

| Diagram | Entry point | Panel | Rooted? | Depth controls |
|---|---|---|---|---|
| Schema FK diagram | `openSchemaDiagram` | `SchemaDiagramPanel` | no — whole schema | none (unchanged) |
| Relation FK diagram | `openRelationDiagram` | `RelationDiagramPanel` | yes | already has; gains `All`, `Deeper`, markers |
| Database diagram, Overview | `openDatabaseDiagram` | `DatabaseDiagramPanel` | no — one node per schema | block stays hidden (unchanged) |
| Database diagram, Tables | `openDatabaseDiagram` | `DatabaseDiagramPanel` | root optional | already has; gains `All`, `Deeper`, markers when a root is chosen |
| Schema dependency graph | `openSchemaDependencyGraph` | `RelationGraphPanel` | no — whole schema | none |
| Relation dependency graph | `openRelationDependencyGraph` | **`RootedRelationGraphPanel`** (new) | yes | **new**: Direction, Depth, `Deeper`, prune, legend, markers |
| Schema inheritance graph | `openSchemaInheritanceGraph` | `RelationGraphPanel` | no — whole schema | none |
| Relation inheritance graph | `openRelationInheritanceGraph` | **`RootedRelationGraphPanel`** (new) | yes | **new**, as above |
| Role membership graph | `openRoleMembershipDiagram` | `RelationDiagramPanel` | yes | already has; gains everything `RelationDiagramPanel` gains |
| Role grants graph | `openRoleGrantsDiagram` | `RoleGrantsDiagramPanel` | star, one hop by construction | none[^grants-star] |
| Explain plan diagram | `QueryPanel` → Explain diagram | `ExplainDiagramPanel` | plan root | none[^explain-whole] |

`DatabaseDiagramPanel` is the precedent for the optional-root case: its `rebuildBase` returns the whole graph when no root is chosen ([DatabaseDiagramPanel.ts:258](frontend/src/dock/DatabaseDiagramPanel.ts#L258)), so the depth value is ignored until the user picks one. That behaviour is unchanged here.

### The control column is extracted into a shared base panel

A new `RootedDiagramShell` (`frontend/src/dock/rootedDiagramShell.ts`) owns the WEST column — Direction, Depth, `Deeper`, prune, the caller's extra controls, and the scrolling legend — plus the Border assembly over the CENTER `DiagramView`. `RelationDiagramPanel`, `DatabaseDiagramPanel`, and the new `RootedRelationGraphPanel` extend it and override two protected hooks. The precedent is [`PropertyValuePanel`](frontend/src/properties/PropertyValuePanel.ts#L37): a shared base that owns the assembly and exposes a protected seam its subclasses drive.[^shell-scope]

The shell owns the depth vocabulary (`DEPTH_CHOICES`, the `All` sentinel, `depthFromChoice`), which is what makes the extraction load-bearing rather than cosmetic: three panels have to agree on it, and a divergence would be a silent bug.

### The hooks are protected overrides, not registered callbacks

`RootedDiagramShell` calls `this.rootingChanged()` and `this.pruneChanged()` from its own control listeners; subclasses override them. No handler is passed into `super()`.[^protected-hooks] The shell also owns the current Direction / Depth / prune values and exposes them through protected getters, so a subclass keeps no copy.

### The rooted relation graph moves to a new panel

`RelationGraphPanel` stays a bare `DiagramView` and serves only the two schema-wide (unrooted) entry points. The two relation-rooted entry points get a new `RootedRelationGraphPanel extends RootedDiagramShell`. The in-repo precedent for the split is the FK pair: `SchemaDiagramPanel` (schema-wide, bare view) beside `RelationDiagramPanel` (rooted, Border + controls).[^why-split]

**Reconciliation with [`plans/diagram-layout-settled-and-root-focus.md`](plans/diagram-layout-settled-and-root-focus.md).** That plan's step 16 forwards `RelationGraphPanel`'s `rootId` parameter into `super({ …, initialFocusNode: rootId })`. After this plan `RelationGraphPanel` is never constructed with a root, so that forwarding, the `rootId` parameter, and the `ROOT_BORDER` emphasis all move to `RootedRelationGraphPanel`, whose `DiagramView` is built with `initialFocusNode: root.id`. The observable outcome the layout plan pins is unchanged: the relation-rooted dependency and inheritance graphs still open centred on their root, and the schema-wide ones still centre the graph's bounds. The layout plan's `whenLaidOut()` forwarders on `RelationDiagramPanel` and `DatabaseDiagramPanel` also move — into `RootedDiagramShell`, one forwarder for all three subclasses.

### The rooted dependency and inheritance graphs open at depth 1

Today the controller hands those two panels a graph already narrowed with `rootedDiagram(full, root, "both", Number.POSITIVE_INFINITY)` — the whole connected component. The new panel takes the **unnarrowed** graph plus the root node and does its own narrowing, seeded at Direction `Both` / Depth `1`, matching `RelationDiagramPanel`'s seed. Picking `All` restores exactly today's view.[^depth-1-default]

### The `+N` marker is a new library model field

`DiagramNodeData` gains `badge?: string`, rendered after the label by the stock `DiagramNode`. The precedent is the neighbouring `label` / `glyph` fields: cached pure in `applyOptions` and dispatched from the constructor body once the content child exists ([DiagramNode.ts:91](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramNode.ts#L91)). The badge is drawn **in flow**, in a row after the label, so it widens the node's preferred size and ELK reserves room for it.[^in-flow]

An app-side wrapper around `DiagramNode` was rejected in favour of the model field.

### `DiagramGroupNode` ignores `badge`

The default group renderer does not forward it, and container boxes never carry one. The database diagram's containers are synthesised by [`groupBySchema`](frontend/src/data/groupBySchema.ts#L48) *after* the depth filter has run over the flat leaf graph, so a container is not a node the traversal ever visits. The leaves inside a container pass through by reference and keep whatever badge they were given.

### Custom node renderers draw the badge themselves

A `nodeRenderer` receives the whole `DiagramNodeData` and builds its own DOM, so the library cannot draw the badge for it. Both app renderers are covered explicitly:

- **`TableCardNode`** — renders `RelationDiagramPanel`'s cards and therefore *does* receive badges. Its header becomes a row of the table name plus the badge, pinned to the same `CARD_WIDTH`.
- **`ExplainNode`** — renders the Explain plan diagram, which has no depth control and whose builder never sets `badge`. **Not changed.**[^explain-node]
- **`RelationGraphPanel`'s renderer** builds a stock `DiagramNode`, so it forwards `badge: n.badge` — one line. It never receives one today (its two entry points are unrooted), but `RootedRelationGraphPanel` reuses the same renderer function, and that one does.

### The marker counts only what raising the depth would reveal

A cut neighbour counts only when the current Direction would have walked to it. In `downstream` mode an upstream neighbour is not "deeper" — no depth setting would ever show it — so it is not counted. Counts are of distinct neighbour **node ids**, not edges: two foreign keys to the same hidden table are one hidden neighbour.

Markers are computed against the direction+depth-rooted base graph, **before** the legend's hide/prune filter. Ticking a legend checkbox therefore never reshuffles the markers.[^before-hide]

### Going deeper is a button, not a gesture on the node

Node double-click already opens the object ([`activate`](frontend/src/dock/RelationDiagramPanel.ts#L150)) and right-click already opens the shared object menu ([`diagramContextMenu`](frontend/src/SqlAdminController.ts#L2019)); both are taken. The affordance is a `Deeper` button directly under the Depth control. It steps Depth to the next choice and is enabled exactly while some drawn node carries a badge — so the markers say "there is more" and the button next to them gets it.[^deeper-button]

---

## Public API

### Library — `DiagramModel.ts`

```typescript
export interface DiagramNodeData {
    // ...existing id / label / glyph / width / height / layoutOptions / ports / data / children...

    /**
     * Optional short marker drawn after the label by the default node renderer —
     * e.g. `"+3→"` for neighbours a consumer's own depth filter left out. A
     * custom `nodeRenderer` receives it like any other field and must draw it
     * itself. Container nodes (non-empty `children`) ignore it.
     */
    badge?: string;
}
```

### Library — `DiagramNode.ts`

```typescript
export interface DiagramNodeOptions extends PanelOptions {
    // ...existing label / glyph / selected...

    /** Short marker text drawn after the label, in the same row. */
    badge?: string;
}

/**
 * Returns the node's badge text, or `null` when none was set.
 *
 * @returns The badge text, or `null`.
 */
getBadge(): string | null;
```

Construction-time only, with no `setBadge` — matching `glyph`, the neighbouring field whose value is likewise consumed while the content child is built.[^no-set-badge] `getBadge()` reads `this._options.badge ?? null`, mirroring `getLabel()`.

### App — `frontend/src/data/relationDiagram.ts` (new exports)

```typescript
/** Neighbours of one drawn node that the depth limit left out. */
export interface HiddenNeighbourCounts {
    /** Distinct neighbours reached by following source -> target (downstream). */
    outgoing: number;
    /** Distinct neighbours reached by following target -> source (upstream). */
    incoming: number;
}

/**
 * Per drawn node, how many distinct neighbours the depth limit cut. Only edges
 * the given direction follows are counted — a neighbour no depth setting would
 * ever reveal is not "deeper". Pure.
 *
 * @param edges - The WHOLE graph's edges (the base's own edges are not enough:
 *   a cut edge has exactly one endpoint in `shown`).
 * @param shown - Node ids the depth-limited walk kept.
 * @param direction - The traversal direction the walk used.
 * @returns One entry per node with at least one cut neighbour; nodes with none
 *   are absent from the map.
 */
export function hiddenNeighbourCounts(
    edges: readonly DiagramEdgeData[],
    shown: ReadonlySet<string>,
    direction: TraversalDirection,
): Map<string, HiddenNeighbourCounts>;

/**
 * The badge text for one node's cut-neighbour counts, or null when nothing was
 * cut. The arrow points the way the traversal was walking, not a screen
 * direction.
 *
 * @param counts - That node's cut-neighbour counts.
 * @returns The badge text, or null.
 */
export function depthBadgeLabel(counts: HiddenNeighbourCounts): string | null;

/**
 * A copy of `base` whose nodes carry a `badge` wherever the depth limit cut a
 * neighbour. Node objects are copied, never mutated, so the graph `base` was
 * derived from is untouched. Edges and `layoutOptions` pass through verbatim.
 *
 * @param base - The direction+depth-rooted graph about to be filtered/drawn.
 * @param fullEdges - The whole graph's edges, including the cut ones.
 * @param direction - The traversal direction `base` was rooted with.
 * @returns A new graph whose nodes carry depth badges.
 */
export function withDepthBadges(
    base: DiagramData,
    fullEdges: readonly DiagramEdgeData[],
    direction: TraversalDirection,
): DiagramData;

/**
 * Whether any node in `data` carries a depth badge — the `Deeper` button's
 * enablement.
 *
 * @param data - The graph to inspect.
 * @returns True when at least one node has a `badge`.
 */
export function hasDepthBadge(data: DiagramData): boolean;
```

### App — `frontend/src/dock/rootedDiagramShell.ts` (new)

```typescript
/** The `Depth` choice meaning an unbounded walk. */
export const DEPTH_ALL = "All";

/** Depth choices offered by the control, in order; `Deeper` steps through them. */
export const DEPTH_CHOICES: string[];   // ["1", "2", "3", DEPTH_ALL]

/** The depth every rooted diagram opens at. */
export const DEFAULT_DEPTH = 1;

/**
 * The hop limit a `Depth` choice means.
 *
 * @param choice - A `DEPTH_CHOICES` entry.
 * @returns The hop count, or `Number.POSITIVE_INFINITY` for `DEPTH_ALL`.
 */
export function depthFromChoice(choice: string): number;

/**
 * A caption stacked above its control. Vertical (not side-by-side) so a caption
 * is never squeezed in the fixed-width side column.
 *
 * @param caption - The control's label.
 * @param control - The control component.
 * @returns A VBox with the caption above the control.
 */
export function labelledRow(caption: string, control: Component): Component;

/**
 * One legend row: a checkbox (checked = shown) beside the node's name. The root
 * row is disabled and pinned checked.
 *
 * @param n - The node this row represents.
 * @param rootId - The root node id (its row is locked shown).
 * @param hidden - The shared hidden-id set this row mutates.
 * @param applyFilter - Re-filters the view after a toggle.
 * @returns The row component.
 */
export function legendRow(
    n: DiagramNodeData,
    rootId: string,
    hidden: Set<string>,
    applyFilter: () => void,
): Component;

/** What a subclass hands the shell to assemble. */
export interface RootedDiagramShellConfig {
    /** The CENTER diagram. Built by the subclass, which owns the node renderer. */
    view: DiagramView;
    /** Always-visible controls at the top of the column (the database diagram's Mode row). */
    headerControls?: Component[];
    /** Controls inside the hideable block, above Direction (the database diagram's Root table row). */
    rootedControls?: Component[];
    /** Controls inside the hideable block, below the prune row (the relation diagram's coverage row). */
    extraControls?: Component[];
}

class RootedDiagramShell extends Panel {
    /** The CENTER diagram. */
    protected readonly view: DiagramView;
    /** The scrolling legend column; the subclass fills it. */
    protected readonly legend: Panel;

    constructor(config: RootedDiagramShellConfig);

    /** Resolves once the view's in-flight layout pass has placed its nodes. */
    whenLaidOut(): Promise<void>;

    /** Enable the `Deeper` button — true while some drawn node still carries a badge. */
    setDeeperEnabled(enabled: boolean): this;

    /** Show or hide the Direction / Depth / Deeper / prune block plus its two extra slots. */
    setRootedControlsDisplayed(displayed: boolean): this;

    /** Show or hide the legend column. */
    setLegendDisplayed(displayed: boolean): this;

    /** The Direction control's current value. */
    protected getDirection(): TraversalDirection;

    /** The Depth control's current hop limit (`Number.POSITIVE_INFINITY` for `All`). */
    protected getDepth(): number;

    /** Whether the prune checkbox is ticked. */
    protected isPrune(): boolean;

    /** Direction, Depth, or `Deeper` changed. Subclasses re-root here. Default: no-op. */
    protected rootingChanged(): void;

    /** The prune checkbox changed. Subclasses re-filter here. Default: no-op. */
    protected pruneChanged(): void;
}
```

Exported through `callable()` under the class name, per [`COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) (d).

### App — `frontend/src/dock/RootedRelationGraphPanel.ts` (new)

```typescript
class RootedRelationGraphPanel extends RootedDiagramShell {
    /**
     * @param full - The whole schema's dependency or inheritance graph.
     * @param root - The rooted relation's node data (id = `schema.name`).
     * @param onSelect - Invoked with the activated node's RelationNodeData.
     * @param onContextMenu - Invoked with a right-clicked node's RelationNodeData
     *   and the originating event.
     */
    constructor(
        full: DiagramData,
        root: DiagramNodeData,
        onSelect: (node: RelationNodeData) => void,
        onContextMenu?: (node: RelationNodeData, event: MouseEvent) => void,
    );
}
```

### App — `frontend/src/dock/RelationGraphPanel.ts` (changed)

```typescript
// The `rootId` parameter and the root accent border move to RootedRelationGraphPanel.
constructor(
    data: DiagramData,
    onSelect: (node: RelationNodeData) => void,
    onContextMenu?: (node: RelationNodeData, event: MouseEvent) => void,
);

/**
 * The node renderer both relation-graph panels share: a stock DiagramNode
 * carrying the node's label, glyph, and depth badge, with an accent border on
 * the root.
 *
 * @param rootId - The root node id, or undefined for an unrooted graph.
 * @returns A DiagramView node renderer.
 */
export function relationGraphNodeRenderer(rootId?: string): (n: DiagramNodeData) => Component;
```

### App — `frontend/src/dock/TableCardNode.ts` (unchanged signature)

The constructor keeps `(node: DiagramNodeData, isRoot: boolean)`; it now reads `node.badge` for its header row. (The sibling [`plans/diagram-edge-interaction.md`](plans/diagram-edge-interaction.md) adds a third `onSelectColumn` parameter; the two changes are independent.)

---

## Internal Structure

### The badge rule, worked

Graph: `a→b`, `b→c`, `d→a`, `a→e`, `f→b`. Root `a`. `Drawn` is what `rootedDiagram` keeps at that direction and depth; `Cut edges` are the whole graph's edges with exactly one endpoint drawn, restricted to the directions the walk follows.

| Direction | Depth | Drawn (`shown`) | Cut edges | Per-node counts | Badges |
|---|---|---|---|---|---|
| `both` | 1 | `a, b, d, e` | `b→c` (target cut), `f→b` (source cut) | `b: {incoming 1, outgoing 1}` | `b` → `←+1 +1→` |
| `downstream` | 1 | `a, b, e` | `b→c` | `b: {incoming 0, outgoing 1}` | `b` → `+1→` |
| `both` | `All` | `a, b, c, d, e, f` | none | — | none |

The `downstream` row counts neither `d→a` nor `f→b`: both are upstream edges, and no downstream depth would ever draw `d` or `f`.

`depthBadgeLabel` formats those counts:

| incoming | outgoing | label |
|---|---|---|
| 0 | 0 | `null` — the node gets no badge |
| 0 | 3 | `+3→` |
| 2 | 0 | `←+2` |
| 2 | 3 | `←+2 +3→` |

The arrow points the way the traversal was walking — `→` downstream (source → target), `←` upstream. On a `RIGHT`-laid-out graph that also matches the drawn direction; on the inheritance graph (`elk.direction: DOWN`) it does not, and the arrow still means traversal direction.

### `hiddenNeighbourCounts`

One pass over `edges`, accumulating **sets** of neighbour ids per node (so duplicate edges between the same pair count once), converted to counts at the end:

- `direction` follows downstream (`"downstream"` or `"both"`), `shown.has(e.source)`, `!shown.has(e.target)` → `e.source` gains outgoing neighbour `e.target`.
- `direction` follows upstream (`"upstream"` or `"both"`), `shown.has(e.target)`, `!shown.has(e.source)` → `e.target` gains incoming neighbour `e.source`.

A self-referential edge (`source === target`) can never straddle `shown`, so it never contributes.

### `withDepthBadges`

```typescript
const counts = hiddenNeighbourCounts(fullEdges, new Set(base.nodes.map(n => n.id)), direction);

return {
    nodes: base.nodes.map((n) => {
        const label = counts.has(n.id) ? depthBadgeLabel(counts.get(n.id)!) : null;

        return label === null ? { ...n } : { ...n, badge: label };
    }),
    edges: base.edges,
    layoutOptions: base.layoutOptions,
};
```

Every node is copied even when unbadged, so a caller can never mutate the graph `base` was derived from — the same discipline [`subgraph`](frontend/src/data/relationDiagram.ts#L71) follows for its filtered arrays.

### `DiagramNode`'s content row

Today `_content` is the `IconText`/`Text` added to the panel, and `setLabel` writes through it ([DiagramNode.ts:108-140](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramNode.ts#L108)). Split it in two so a badged node can wrap both children without breaking `setLabel`:

```typescript
/** The glyph+label (or bare label). */
private _label!: IconText | Text;

/** The child added to the node: `_label` alone, or an HBox row of `_label` + `_badge`. */
private _content!: Component;

/** The trailing badge chip, when the node carries one. */
private _badge?: Text;
```

`buildContent(glyph, label, badge)`:

1. Remove the previous `_content` if there is one (unchanged).
2. Build `_label` exactly as today — `new IconText(glyph, label)` when a glyph is given, else `new Text(label)`.
3. `badge === undefined` → `this._content = this._label` (byte-for-byte today's structure).
4. Otherwise build `this._badge = new Text(badge)`, call `this._badge.setOpacity(BADGE_OPACITY)`, and set `this._content` to a `Component` with `new HBox()` holding `[this._label, this._badge]`.
5. `this._content.setPointerEvents("none")` — unchanged, and `pointer-events: none` inherits, so one call still covers every nested piece.
6. `this.addComponent(this._content)` — unchanged.

`setLabel` becomes `this._label.setText(value)`. New module constant:

```typescript
// The badge's opacity: present but secondary to the label it trails. Matches the
// "dim the supporting value" weight the framework already uses for a receded
// label, so the badge reads as an annotation rather than a second name.
const BADGE_OPACITY = 0.6;
```

The row uses `new HBox()` at the library's default 5px spacing — no new number.

`DiagramView.rebuildNodes`'s default node renderer ([DiagramView.ts:377](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L377)) gains `badge: node.badge`. The default **group** renderer on the next line does not.

### `RootedDiagramShell`'s column

Top to bottom inside the fixed-width WEST panel (`LEGEND_WIDTH = 220`, moved from the two panels):

1. `headerControls` — always visible.
2. The **rooted block** (one `Panel`, `VBox`), shown by default:
   `rootedControls`, `labelledRow("Direction", …)`, `labelledRow("Depth", …)`, the `Deeper` button, the prune row, `extraControls`.
3. `legend` — a `Panel({ layoutManager: new VBox({ spacing: 2 }), autoScroll: "auto" })` in the WEST panel's CENTER.

The shell's own `super()` is the Border over `{ west, CENTER: view }`, exactly the assembly the two existing panels have today ([RelationDiagramPanel.ts:123-139](frontend/src/dock/RelationDiagramPanel.ts#L123)). Child controls are built as locals before `super()` and the `.on("change", …)` listeners are wired after it, per [`COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) (b) — the same shape both panels use today.

Fields, private to the shell — the four controls it owns, the hideable block, and the control state:

```typescript
private readonly directionControl: ComboBox;
private readonly depthControl:     ComboBox;
private readonly deeperButton:     Button;
private readonly pruneControl:     Checkbox;
private readonly rootedBlock:      Panel;

private direction: TraversalDirection = "both";
private depthIndex = DEPTH_CHOICES.indexOf(String(DEFAULT_DEPTH));
private prune = false;
```

`getDepth()` returns `depthFromChoice(DEPTH_CHOICES[this.depthIndex])`. `setDeeperEnabled` forwards to `this.deeperButton.setEnabled(…)`; `setRootedControlsDisplayed` to `this.rootedBlock.setDisplayed(…)`; `setLegendDisplayed` to `this.legend.setDisplayed(…)`. The `Deeper` button starts disabled — a subclass enables it from its own constructor once it has a badged base.

### `Deeper` must invoke the hook itself

```typescript
// ComboBox.setValue is a programmatic write: the inner List fires "change" only
// from its click / keyboard reducers, never from setValue. So stepping the
// control does NOT re-enter the change listener, and this method has to call
// rootingChanged() itself.
private stepDepth(): void {
    if (this.depthIndex >= DEPTH_CHOICES.length - 1) {
        return;
    }

    this.depthIndex += 1;
    this.depthControl.setValue(DEPTH_CHOICES[this.depthIndex]);

    this.rootingChanged();
}
```

### What each subclass keeps

`RelationDiagramPanel` after the change:

```typescript
class RelationDiagramPanel extends RootedDiagramShell {
    private readonly full: DiagramData;
    private readonly root: DiagramNodeData;
    private showCoverage = false;
    private readonly hidden = new Set<string>();
    private base!: DiagramData;

    protected rootingChanged(): void { this.rebuildBase(); }
    protected pruneChanged(): void   { this.applyFilter(); }
}
```

Those five fields plus `applyFilter`, `rebuildLegend`, `rebuildBase`, and the two overrides are the **whole** class body. Everything else it has today moves to the shell: its `direction`, `depth`, `prune`, `view`, and `legend` fields; its `LEGEND_WIDTH` / `DEFAULT_DEPTH` / `DEPTH_CHOICES` constants; its `labelledRow` and `legendRow` functions; its Direction / Depth / prune control construction; its `controls` and `west` panels; its Border `super()`; and the `whenLaidOut()` forwarder the layout plan added.

`rebuildBase` gains the badge pass and the button sync:

```typescript
private rebuildBase = (): void => {
    const direction = this.getDirection();

    this.base = withDepthBadges(
        rootedDiagram(this.full, this.root, direction, this.getDepth()),
        this.full.edges,
        direction,
    );

    this.hidden.clear();

    this.setDeeperEnabled(hasDepthBadge(this.base));
    this.rebuildLegend();
    this.applyFilter();
};
```

`applyFilter` is unchanged except that `this.prune` becomes `this.isPrune()` and `this.direction` becomes `this.getDirection()`.

`DatabaseDiagramPanel` follows the same shape; its `rebuildBase` badges only in the rooted branch (the unrooted branch draws the whole graph, so nothing is cut). Its `mode` listener and `focusSchema` call `this.setRootedControlsDisplayed(…)` / `this.setLegendDisplayed(…)` in place of today's `tablesControls.setDisplayed(…)` / `legend.setDisplayed(…)`, and it starts with both hidden (Overview is the default mode).

### `TableCardNode`'s header row

The card's width is a shared geometry seam — `schemaCardModel`'s `CARD_WIDTH` also drives the ELK port x positions — so the badge must fit **inside** the existing width, never widen the card:

```typescript
// Locals before super(). The header is a row so a depth badge can trail the
// table name; the name cell takes the weight and ellipsises, and the row stays
// pinned to CARD_WIDTH, because the card's width is the shared geometry
// schemaCardModel pins the FK ports to and must not change. The 6px gap is
// columnRow's row spacing, so the header's cells line up with the rows below.
const name = new Text(node.label ?? node.id);

name.setFontWeight("bold");
name.setPointerEvents("none");

const badge = node.badge !== undefined ? new Text(node.badge) : null;

badge?.setOpacity(BADGE_OPACITY);
badge?.setPointerEvents("none");

const header = new Component({
    layoutManager: new HBox({ spacing: 6, stretching: true }),
    preferredSize: { width: CARD_WIDTH, height: CARD_HEADER_HEIGHT },
    components   : badge ? [{ component: name, constraints: { weight: 1 } }, badge] : [name],
});
```

`CARD_WIDTH`, `CARD_HEADER_HEIGHT`, and `cardHeight` are untouched.

---

## Ordered Implementation Steps

### Library — `/home/jika/typescript/typescript-ui` (first; the app typechecks against the built output)

1. **`packages/lib/tests/component/diagram/DiagramNode.test.ts`** — add the cases from _Expected Behaviour → `DiagramNode`_ first, so they start red. Keep the two existing hover-cursor cases exactly as they are: they assert on `_content` for a badgeless node, which must stay the bare `IconText` / `Text`.

2. **`packages/lib/src/typescript/lib/component/diagram/DiagramModel.ts`** — add `badge?: string` to `DiagramNodeData`, after `glyph` ([DiagramModel.ts:44](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramModel.ts#L44)), with the JSDoc from _Public API_.

3. **`packages/lib/src/typescript/lib/component/diagram/DiagramNode.ts`** — add `badge?: string` to `DiagramNodeOptions`; import `Component` from `~/core/Component.js` and `HBox` from `~/layout/HBox.js`; add the `BADGE_OPACITY` constant; split `_content` into `_label` / `_content` / `_badge` and rewrite `buildContent` per _Internal Structure_; point `setLabel` at `_label`; cache `badge` in `applyOptions` beside `label` / `glyph`; pass `this._options.badge` in the constructor's `buildContent` call; add `getBadge()`. Run `npm test` — step 1's cases go green.

4. **`packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`** — in `rebuildNodes` ([DiagramView.ts:377](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L377)), add `badge: node.badge` to the default node renderer's `DiagramNode({ … })`. Leave the group renderer on the next line alone.

5. **`packages/lib/tests/component/diagram/DiagramView.test.ts`** — add the default-renderer passthrough case from _Expected Behaviour → `DiagramView`_.

6. **`packages/lib/src/typescript/lib/component/diagram/index.ts`** — no change: `DiagramNodeData` and `DiagramNodeOptions` are already re-exported and the new members ride along.

7. **`packages/lib/docs/components/DiagramView.md`** — per _Documentation Impact_.

8. **`packages/lib/docs/reference/changelog.md`** — an `### Added` entry under the unreleased `## 0.3.0` heading for `DiagramNodeData.badge` / `DiagramNodeOptions.badge`.

9. **Checkpoint** — from `/home/jika/typescript/typescript-ui`: `npm test`, then `npm run lint` (the `local/no-raw-dom` baseline is empty; the change adds no DOM touch — it composes existing components), then `npm run docs:api` (must finish with zero warnings; do not `{@link}` `_label` or any other private member from the public JSDoc), then **`npm run build:lib`**. The app cannot typecheck until `build:lib` has succeeded.

### App — `sqladmin/frontend` (pure helpers test-first)

10. **`frontend/tests/data/relationDiagram.test.ts`** — add the cases from _Expected Behaviour → `relationDiagram.ts`_ to the existing file, reusing its `node` / `edge` / `graph` helpers. Red.

11. **`frontend/src/data/relationDiagram.ts`** — add `HiddenNeighbourCounts`, `hiddenNeighbourCounts`, `depthBadgeLabel`, `withDepthBadges`, and `hasDepthBadge` per _Public API_ and _Internal Structure_. Type-only imports only; no runtime UI-bundle import, keeping the file node-vitest-clean exactly as its header comment requires. `npm test` — green.

12. **New `frontend/src/dock/rootedDiagramShell.ts`** — the constants, `depthFromChoice`, `labelledRow` (moved verbatim from `RelationDiagramPanel.ts:191`), `legendRow` (moved verbatim from `RelationDiagramPanel.ts:209`), `RootedDiagramShellConfig`, and the `RootedDiagramShell` class per _Public API_ and _Internal Structure_. A file header comment stating what the shell owns, which panels extend it, and the two `COMPONENT_CONVENTIONS.md` rules it follows (locals before `super()`; listeners wired after). Export through `callable()`.

13. **`frontend/src/dock/RelationDiagramPanel.ts`** — change `extends Panel` to `extends RootedDiagramShell`; reduce the class body to what _Internal Structure → What each subclass keeps_ lists and delete everything that section names as moving; build the coverage checkbox row as a local and pass it as `extraControls`; pass `initialFocusNode: root.id` on the `DiagramView` local (kept from the layout plan's step 14); seed `base` pre-`super()` through `withDepthBadges`; after `super()` call `this.setDeeperEnabled(hasDepthBadge(this.base))` and `this.rebuildLegend()`; add the two `protected` overrides; update `applyFilter` / `rebuildBase` per _Internal Structure_. Update the file header comment to say the control column now comes from the shell.

14. **`frontend/src/dock/DatabaseDiagramPanel.ts`** — same conversion. `headerControls: [labelledRow("Mode", modeControl)]`, `rootedControls: [labelledRow("Root table", rootControl)]`, no `extraControls`. Delete its own `labelledRow`, `LEGEND_WIDTH`, `DEFAULT_DEPTH`, `DEPTH_CHOICES`, `view`, `legend`, `tablesControls`, `direction`, `depth`, `prune` fields and the layout plan's `whenLaidOut()` forwarder. After `super()`, call `this.setRootedControlsDisplayed(false)` and `this.setLegendDisplayed(false)` (Overview is the default mode). In `rebuildBase`, badge the rooted branch and call `this.setDeeperEnabled(hasDepthBadge(this.base))` in both branches. Keep `schemaLegendRow` where it is — it is per-schema, not per-node.

15. **`frontend/src/dock/RelationGraphPanel.ts`** — export `relationGraphNodeRenderer(rootId?)` (today's inline renderer, plus `badge: n.badge`); drop the `rootId` parameter from the constructor so `onContextMenu` becomes the third argument; keep `ROOT_BORDER` (the shared renderer uses it). Update the file header comment: this panel now serves the schema-wide dependency and inheritance graphs only.

16. **New `frontend/src/dock/RootedRelationGraphPanel.ts`** — `extends RootedDiagramShell`. Pre-`super()`: `const base = withDepthBadges(rootedDiagram(full, root, "both", DEFAULT_DEPTH), full.edges, "both")`, `const view = DiagramView({ data: base, nodeRenderer: relationGraphNodeRenderer(root.id), elkWorkerFactory, initialFocusNode: root.id })`. `super({ view })` — no extra control slots. After `super()`: store `full` / `root` / `base`, wire `view.on("activate", …)` and `view.on("contextmenu", …)` forwarding `n.data as RelationNodeData`, call `setDeeperEnabled` and `rebuildLegend`. Its `applyFilter` / `rebuildLegend` / `rebuildBase` mirror `RelationDiagramPanel`'s without the coverage step. Export through `callable()`.

17. **`frontend/src/SqlAdminController.ts`** —
    - `openSchemaDependencyGraph` ([SqlAdminController.ts:1783](frontend/src/SqlAdminController.ts#L1783)) and `openSchemaInheritanceGraph` ([:1899](frontend/src/SqlAdminController.ts#L1899)): drop the `undefined` third argument from the `RelationGraphPanel(…)` call so `onContextMenu` moves up a position. No other change.
    - `openRelationDependencyGraph` ([:1836-1863](frontend/src/SqlAdminController.ts#L1836)) and `openRelationInheritanceGraph` ([:1953-1980](frontend/src/SqlAdminController.ts#L1953)): delete the `const data = rootedDiagram(…)` line and call `RootedRelationGraphPanel(full, root, onSelect, onContextMenu)` instead of `RelationGraphPanel(data, onSelect, root.id, onContextMenu)`.
    - Remove the now-unused `rootedDiagram` import ([:38](frontend/src/SqlAdminController.ts#L38)); add the `RootedRelationGraphPanel` import beside the other dock panel imports.

18. **`frontend/src/dock/TableCardNode.ts`** — rebuild the header as the row in _Internal Structure_; add the `BADGE_OPACITY` constant with its comment. Do not touch `CARD_WIDTH`, `CARD_HEADER_HEIGHT`, or `cardHeight`.

19. **Regression greps** (from `/home/jika/typescript/sqladmin`):
    - `grep -rn 'DEPTH_CHOICES\|LEGEND_WIDTH\|function labelledRow\|function legendRow' frontend/src` — every hit is in `frontend/src/dock/rootedDiagramShell.ts`; no second copy survives in either panel.
    - `grep -rn 'rootedDiagram' frontend/src` — hits only in `data/relationDiagram.ts` and the three rooted panels; **zero** in `SqlAdminController.ts`.
    - `grep -rn 'RelationGraphPanel(' frontend/src/SqlAdminController.ts` — exactly two call sites, both three-argument.

20. **Checkpoint** — `cd frontend && npm run typecheck` (needs step 9's `build:lib`), then `npm test`.

21. **Manual verification** — per _Verification_.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramModel.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramNode.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramNode.test.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts` |
| Modify | `../typescript-ui/packages/lib/docs/components/DiagramView.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog.md` |
| Modify | `frontend/src/data/relationDiagram.ts` |
| Modify | `frontend/tests/data/relationDiagram.test.ts` |
| Create | `frontend/src/dock/rootedDiagramShell.ts` |
| Create | `frontend/src/dock/RootedRelationGraphPanel.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` |
| Modify | `frontend/src/dock/TableCardNode.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |

---

## Expected Behaviour

### Unit-testable — `relationDiagram.ts` (`frontend/tests/data/relationDiagram.test.ts`, node vitest)

Fixture: the worked graph `a→b`, `b→c`, `d→a`, `a→e`, `f→b`.

`hiddenNeighbourCounts` takes `shown` as a parameter, so these cases pass a set directly rather than deriving one from a walk:
- `shown = {a,b,d,e}`, `both` → one entry, `b` with `{ incoming: 1, outgoing: 1 }` (the first row of the worked table).
- `shown = {a,b}`, `downstream` → `a: { incoming: 0, outgoing: 1 }` (`e`), `b: { incoming: 0, outgoing: 1 }` (`c`); `d→a` and `f→b` are **not** counted.
- `shown = {a,b}`, `upstream` → `a: { incoming: 1, outgoing: 0 }` (`d`), `b: { incoming: 1, outgoing: 0 }` (`f`); `a→e` and `b→c` are **not** counted.
- `shown` covering every node → the map is empty.
- Two parallel edges `a→z` (different ids, same endpoints) with `z` cut → `a.outgoing === 1`, not 2.
- A self-referential edge `a→a` with `a` shown contributes nothing.
- An empty edge list → an empty map.

`depthBadgeLabel` — every row of the format table in _Internal Structure_, i.e. `{0,0}` → `null`, `{0,3}` → `"+3→"`, `{2,0}` → `"←+2"`, `{2,3}` → `"←+2 +3→"`.

`withDepthBadges`:
- Base rooted at `a`, `both`, depth 1 → the returned node `b` has `badge === "←+1 +1→"`; `a`, `d`, `e` have `badge === undefined`.
- The input `base` and the nodes it shares with the full graph are **not** mutated (assert the original node objects still have no `badge`, and that the returned node objects are different references).
- `edges` and `layoutOptions` are the same references the input carried.
- Depth `Number.POSITIVE_INFINITY` → no node carries a badge.
- A base whose root was injected by `rootedDiagram` (a view/matview with no edges) → no badge, no throw.

`hasDepthBadge`:
- True for the depth-1 `both` result above; false for the unbounded one; false for `{ nodes: [], edges: [] }`.

### Unit-testable — `DiagramNode` (`packages/lib/tests/component/diagram/DiagramNode.test.ts`)

- `new DiagramNode({ label: 'users' })` → `getBadge()` is `null`, and `_content` is the bare `Text` (today's structure, pinned so the split cannot regress it).
- `new DiagramNode({ glyph: 'xmark', label: 'users' })` → `_content` is still the `IconText` itself.
- `new DiagramNode({ label: 'users', badge: '+3→' })` → `getBadge()` is `'+3→'`; `_content` is **not** the label component; `_content.getPointerEvents()` is `'none'`; `_badge.getText()` is `'+3→'`.
- A badged node's preferred width is greater than the same node's without a badge (this is what makes ELK reserve room).
- `setLabel('orders')` on a badged node updates the label and leaves `getBadge()` unchanged.
- `new DiagramNode({ label: 'users', badge: '' })` → `getBadge()` is `''` and `_content` is the wrapper row, not the label: an empty string is a badge like any other, and it is `undefined` alone that means "none".

### Unit-testable — `DiagramView` (`packages/lib/tests/component/diagram/DiagramView.test.ts`)

- A graph node carrying `badge` is rendered by the default renderer into a `DiagramNode` whose `getBadge()` returns that string; a node without one returns `null`.
- A **container** node (non-empty `children`) carrying a `badge` still renders a `DiagramGroupNode`, and that component exposes no `getBadge` — the group renderer must not be given the field. Its leaf children keep their own badges.

### Manual verification (needs the running app, a real ELK worker, and a browser)

Everything panel-side is manual-verify only: `frontend/tests/` runs in vitest's node environment over pure helpers, and every diagram panel imports UI-bundle modules that touch `document` at load. Log in with Host **`sqladmin-db`** (not `localhost`), database / user / password `sqladmin`.

**Relation FK diagram** — right-click a table → *Show relations*:
- Opens at Depth `1`; a card whose further neighbours were cut shows a dimmed `+N` marker after its name, inside the card's existing width (the card does not get wider, and a long table name ellipsises rather than pushing the marker out).
- `Deeper` is enabled while any marker is showing; clicking it moves Depth `1 → 2`, re-lays out, and the markers move outward. Repeat to `3`, then to `All`, where every marker disappears and `Deeper` goes disabled.
- Picking `All` from the Depth combo directly does the same.
- Switching Direction to *Downstream* leaves only `+N→` markers; *Upstream* leaves only `←+N`.
- Hiding a node in the legend does **not** change any remaining node's marker.
- The root card still opens centred (the layout plan's `initialFocusNode`), and double-clicking a card still opens that table.

**Role membership graph** — Roles rail → right-click a role → *Show membership graph*: the same controls, `All`, `Deeper`, and markers, on role nodes.

**Database diagram, Tables mode** — right-click the database → *Database diagram* → Mode *Tables*:
- With **no** root table: no markers anywhere and `Deeper` disabled (nothing is cut).
- Pick a *Root table*: the view re-roots and centres on it, markers appear on cut leaves, `Deeper` steps the depth. Markers render on the stock node boxes; the schema container boxes never carry one.
- Switch back to Mode *Overview*: the whole Direction / Depth / `Deeper` / prune block and the legend hide, and the Mode control stays. Drilling into a schema from Overview shows them again.

**Relation dependency graph** — right-click a view or table → *Dependencies*:
- The tab now has a WEST column (Direction, Depth, `Deeper`, prune, legend) it did not have before, and opens at Depth `1` rather than showing the whole connected component.
- Picking `All` reproduces exactly what this tab showed before this change.
- The root node still has its accent border and is still centred; double-clicking another node still opens it; right-clicking still opens the object menu.

**Relation inheritance graph** — right-click a table → *Inheritance*: as above. Its layout is top-down, so confirm the `←` / `→` arrows read as traversal direction and are not mistaken for screen direction.

**Unchanged surfaces** — confirm no WEST column and no marker appears on: the schema diagram, the schema-wide dependency graph, the schema-wide inheritance graph, the role grants graph, the database diagram's Overview mode, and the Explain plan diagram. Each must still open, lay out, pan, zoom, select, and activate exactly as before.

---

## Verification

- **Library**: in `/home/jika/typescript/typescript-ui` — `npm test`, `npm run lint`, `npm run docs:api` (zero warnings), `npm run build:lib`.
- **App typecheck**: `cd frontend && npm run typecheck` — requires the rebuilt library.
- **App unit tests**: `cd frontend && npm test` — `relationDiagram.test.ts` covers every _unit-testable_ app case; `buildSchemaDiagram.test.ts`, `groupBySchema.test.ts`, `buildRelationGraph.test.ts`, `buildRoleGrantsDiagram.test.ts`, `buildRoleMembershipDiagram.test.ts`, and `fkCardinality.test.ts` must stay green **without edits**.
- **Grep invariants**: the three greps in step 19.
- **Manual smoke**: the _Manual verification_ list. Entry points: `SqlAdminController.openRelationDiagram`, `openDatabaseDiagram`, `openRelationDependencyGraph`, `openRelationInheritanceGraph`, `openSchemaDependencyGraph`, `openSchemaInheritanceGraph`, `openRoleMembershipDiagram`, `openRoleGrantsDiagram`, `openSchemaDiagram`, and `QueryPanel`'s *Explain diagram* button.

---

## Documentation Impact

`DiagramNodeData` and `DiagramNodeOptions` are already re-exported from `packages/lib/src/typescript/lib/component/diagram/index.ts`, so `badge` reaches the public API with **no barrel change**. `packages/lib/docs/api/` is generated TypeDoc output and is **gitignored** (`.gitignore:12`) — run `npm run docs:api` as a zero-warning check, never hand-edit it, and do not commit it.

`packages/lib/docs/components/DiagramView.md` (the only hand-written page covering this component):

- The model paragraph ([line 40](../typescript-ui/packages/lib/docs/components/DiagramView.md#L40)) — add a sentence: a node's optional `badge` is a short marker the default renderer draws after the label, for annotations such as "N neighbours not shown".
- **Notes → Custom node content** bullet — extend: a custom `nodeRenderer` receives `badge` like every other field and must draw it itself; the default `groupRenderer` ignores it, so a container box never shows one.

`packages/lib/docs/reference/changelog.md` — an `### Added` entry under the unreleased `## 0.3.0` per step 8.

No `llms.txt` change: it is generated from `packages/lib/scripts/llms/manifest.data.mjs`, which carries no diagram entry.

App side: no documentation change. [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) is unaffected — `RootedDiagramShell` and its three subclasses are ordinary class-first components under rules (b), (c), and (d). `LIBRARY_NOTES.md` records library *defects* the app works around, and this plan adds capability rather than working around one. `TODO.md` has no entry for this wishlist item.

---

## Potential Challenges

- **`ComboBox.setValue` fires no `change`.** The inner `List` fires `change` only from its click / keyboard reducers ([List.ts:139-145](../typescript-ui/packages/lib/src/typescript/lib/component/list/List.ts#L139)). `stepDepth` therefore calls `rootingChanged()` itself; forgetting that is a `Deeper` button that visibly moves the combo and changes nothing.
- **Three panels converted in one change.** Each conversion deletes fields and constants the shell now owns; a leftover shadowing field (e.g. a private `direction` beside the shell's) compiles but silently ignores the control. Step 19's first grep is the net.
- **A badged node is wider, so the graph re-lays out when the badge appears or vanishes.** Expected — the marker is in flow precisely so ELK reserves room for it — but it means node positions shift on a depth change even for nodes that were already drawn.
- **`TableCardNode` must not widen the card.** `CARD_WIDTH` is the seam `schemaCardModel` pins the FK ports to; a badge that grew the card would move every port off its edge. The header row is pinned to `CARD_WIDTH` and the name cell ellipsises.
- **`DiagramNode`'s existing tests read `_content` directly.** The badgeless path deliberately leaves `_content` as the bare `IconText` / `Text` so those two cases stay green unchanged; step 1 pins that as a test of its own.
- **Library rebuild ordering.** The app typechecks against the library's built declarations, so `npm run build:lib` must run after every library edit and before the app typecheck — step 9 before step 20. Without it, `n.badge` is a type error in `withDepthBadges`.
- **The two schema-wide `RelationGraphPanel` call sites lose an argument.** Dropping `rootId` shifts `onContextMenu` from fourth to third position. Leaving all four arguments in place is a compile error, so that mistake is caught; the one that is **not** caught is deleting the wrong argument — keeping the `undefined` as the third and dropping the handler compiles cleanly and silently removes the context menu. Step 19's third grep pins both call sites at three arguments; the manual pass checks the menu still opens.

---

## Critical Files

- [`frontend/src/data/relationDiagram.ts`](frontend/src/data/relationDiagram.ts) — `reachableNodeIds` (26), `subgraph` (71), `rootedDiagram` (91), `applyHide` (122), and the header comment's DOM-free purity discipline the new helpers must keep.
- [`frontend/tests/data/relationDiagram.test.ts`](frontend/tests/data/relationDiagram.test.ts) — the `node` / `edge` / `graph` / `ids` fixture helpers the new cases extend.
- [`frontend/src/dock/RelationDiagramPanel.ts`](frontend/src/dock/RelationDiagramPanel.ts) — the control column being extracted: constants (40-48), the pre-`super()` locals (88-131), the Border `super()` (133), `applyFilter` (162), `rebuildLegend` (167), `rebuildBase` (175), `labelledRow` (191), `legendRow` (209).
- [`frontend/src/dock/DatabaseDiagramPanel.ts`](frontend/src/dock/DatabaseDiagramPanel.ts) — the second copy of that column (37-155), plus `applyFilter` (236), `rebuildBase` (258), and `focusSchema` (273), which drive the show/hide the shell must reproduce.
- [`frontend/src/dock/RelationGraphPanel.ts`](frontend/src/dock/RelationGraphPanel.ts) — `ROOT_BORDER` (26) and the inline `nodeRenderer` (43) being exported.
- [`frontend/src/properties/PropertyValuePanel.ts:37`](frontend/src/properties/PropertyValuePanel.ts#L37) — the base-class-plus-protected-seam precedent `RootedDiagramShell` follows.
- [`frontend/src/shell/treeExplorerView.ts:63`](frontend/src/shell/treeExplorerView.ts#L63) — the second extraction precedent: a shared assembly taking a config bag, with locals built before `super()`.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — (b) the super-cascade trap, (c) handlers registered by reference, (d) the instance is the component and the `callable()` export.
- [`frontend/src/dock/TableCardNode.ts`](frontend/src/dock/TableCardNode.ts) — the header (75-79) becoming a row, and `CARD_SELECTED_BG` / `setSelected` (102) which must keep working.
- [`frontend/src/data/schemaCardModel.ts`](frontend/src/data/schemaCardModel.ts) — `CARD_WIDTH`, `CARD_HEADER_HEIGHT`, `cardHeight`, `columnPortY`: the geometry the badge must fit inside.
- [`frontend/src/data/groupBySchema.ts:48`](frontend/src/data/groupBySchema.ts#L48) — leaves pass into `children` by reference, which is what carries badges through the database diagram's grouping step.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — the four `RelationGraphPanel` call sites (1783, 1846, 1899, 1963), the two `rootedDiagram` calls (1842, 1959), `diagramContextMenu` (2019), and `openRoleMembershipDiagram`'s `RelationDiagramPanel` call (2685).
- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramNode.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramNode.ts) — `DiagramNodeOptions` (22), `_content` (55), `applyOptions` (91), `buildContent` (108), `setLabel` (135), `getLabel` (147).
- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts:366-399`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L366) — `rebuildNodes` and the two default renderers.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/list/List.ts:139`](../typescript-ui/packages/lib/src/typescript/lib/component/list/List.ts#L139) — `notifyUserChange`'s doc comment, the source of the "programmatic `setValue` fires nothing" rule.
- [`../typescript-ui/ARCHITECTURE.md`](../typescript-ui/ARCHITECTURE.md) — *All attributes and styles go through typed setters* and the three DOM-write rules governing the new `badge` option.
- [`plans/diagram-layout-settled-and-root-focus.md`](plans/diagram-layout-settled-and-root-focus.md) — steps 14-16 and the `whenLaidOut()` forwarders this plan relocates. Read _Public API_ and step 16 before touching `RelationGraphPanel`.

---

## Non-Goals

- **A depth parameter on the backend or the frontend API.** Every fetch stays unbounded; depth is display filtering only.
- **Depth controls on `SchemaDiagramPanel`, the schema-wide dependency and inheritance graphs, the database diagram's Overview mode, `RoleGrantsDiagramPanel`, or `ExplainDiagramPanel`** — none of them has a root to count hops from.[^grants-star][^explain-whole]
- **Ghost placeholder nodes or stub edges** standing in for the cut neighbours.[^no-ghosts]
- **Per-node expansion** — an "expand just this node's cut neighbours" set threaded through the traversal. `Deeper` moves the single global depth instead.[^deeper-button]
- **Re-rooting from a node.** The root is a construction-time input that also names the tab; changing it belongs to a separate change.
- **Disabling Direction / Depth in the database diagram when no root is chosen.** They stay visible and inert, exactly as today.
- **Unifying `RelationDiagramPanel`'s and `RootedRelationGraphPanel`'s filter pipelines.** The shell stops at the control column, the legend container, and the Border assembly; each panel keeps its own `full` / `base` / `hidden` state and its own `applyFilter`, because the database diagram's pipeline (per-schema hide, optional root, `groupBySchema`) does not fit a shared one.[^shell-scope]
- **A `setBadge` runtime setter on `DiagramNode`.**[^no-set-badge]
- **Changing `CARD_WIDTH`, `CARD_HEADER_HEIGHT`, or `cardHeight`.**
- **Rendering a badge on `DiagramGroupNode`** or on `ExplainNode`.
- The scope of the sibling diagram UI/UX plans — `elkjs-0-12-upgrade`, `diagram-layout-settled-and-root-focus`, `diagram-edge-merging-and-node-spacing`, and `diagram-edge-interaction`. Nothing here duplicates them; `DiagramModel.ts` is touched by this plan alone.

---

## Notes

[^grants-star]: `buildRoleGrantsDiagram` emits a star: one role node plus one node per granted table, and one edge `role → table` each ([buildRoleGrantsDiagram.ts:43-88](frontend/src/data/buildRoleGrantsDiagram.ts#L43)). Every table node is therefore exactly one hop from the role, so depth 1 already draws the whole graph and no depth setting could reveal or hide anything. Direction is equally inert — every edge leaves the role. The panel is left as a bare `DiagramView`.

[^explain-whole]: The Explain plan diagram is a tree the user opens to read whole; its own builder sets no `badge` and the panel offers no filtering of any kind. Adding a depth control there would hide plan nodes, which is the opposite of what the tab is for.

[^shell-scope]: The count both ways. Extracting deletes, per existing panel, the depth/legend-width constants, the `labelledRow` function, the Direction and Depth combo construction, the prune row, the WEST Border panel, the outer Border `super()`, and the `whenLaidOut()` forwarder — roughly 45 lines each — and `RootedRelationGraphPanel` gets all of it without writing any. Against that, the shell is about 120 lines with a six-member surface. So the line count is close to break-even; what makes the extraction worth it is that the depth vocabulary (`DEPTH_CHOICES`, the `All` sentinel, `depthFromChoice`, the `Deeper` step) now has exactly one owner instead of three that have to agree. Pushing further — moving `full` / `base` / `hidden` / `applyFilter` into the shell as well — was rejected: the database diagram filters by schema and then groups into container boxes, so a shared pipeline would immediately need a per-subclass override for the only part that matters, relocating the difference rather than removing it. The remaining parallel code between `RelationDiagramPanel` and `RootedRelationGraphPanel` is about 30 lines and is accepted.

[^protected-hooks]: The alternative is passing handlers into the shell's constructor. That does not work directly, because `this` is unavailable in the argument expression to `super()` — the handler would have to be a mutable local re-pointed after `super()` returns, the dance the sibling `diagram-edge-interaction` plan needs for its node renderer. That dance is unavoidable there (`DiagramView` invokes the renderer *during* `super()`), but it is avoidable here: the shell's control listeners are wired in its own constructor body, after `super()`, and fire only on a user gesture, so `this.rootingChanged()` always resolves to the subclass override. Protected overrides also keep the subclasses free of registration boilerplate — `PropertyValuePanel`'s `setRows` seam works the same way, from the other direction.

[^why-split]: Converting `RelationGraphPanel` itself would mean one class serving both a rooted and an unrooted mode, with a `RootedDiagramShell | null` field and a null guard in every helper — the unrooted entry points want no side column at all, not an empty one. The FK graph already answers this with two classes: `SchemaDiagramPanel` is a bare `DiagramView` over the whole schema, and `RelationDiagramPanel` is a Border with controls over a root. Splitting the relation graph the same way keeps each class doing one thing and leaves the two schema-wide tabs byte-for-byte as they are.

[^depth-1-default]: The wishlist item is "limit the node depth shown at first render", and these two tabs are exactly the ones that currently render an unbounded walk. Keeping `All` as their default would ship the controls with the feature switched off. A relation's dependency closure in a real schema routinely runs to dozens of views, which is the readability problem the depth cut exists for. `All` is one click away and reproduces the old view exactly, so nothing is lost.

[^explain-node]: `buildExplainDiagram` builds a plan tree and sets no `badge` on any node, and `ExplainDiagramPanel` offers no direction, depth, or hide control that could ever cut a neighbour — so an `ExplainNode` that drew a badge would be drawing a field nothing sets. Adding the rendering "for symmetry" would mean widening the fixed-width card's header row and re-deriving its height arithmetic for a case that cannot occur. If the Explain diagram ever gains a filter, that is when its renderer draws the badge.

[^in-flow]: The alternative is `SortPriorityBadge`'s shape ([SortPriorityBadge.ts:67](../typescript-ui/packages/lib/src/typescript/lib/component/table/cell/SortPriorityBadge.ts#L67)): an absolutely positioned overlay pinned to a corner. That is right for a table header cell, whose geometry is fixed by the column and must not shift. A diagram node is the opposite case — `DiagramView` feeds ELK the node component's preferred size when the model carries no explicit `width`/`height`, so a node that grows for its badge is a node ELK routes edges around. An overlay would instead sit on top of the label on any node narrower than label-plus-badge.

[^no-set-badge]: `glyph` is the neighbouring field with the same lifecycle — consumed while the content child is built, with no post-construction setter — and `badge` behaves identically. Nothing in this plan mutates a badge in place: the app re-derives badges in `withDepthBadges` and pushes a whole new graph through `setData`, which rebuilds every node component through the renderer. A setter would have to rebuild the content row and would have no caller.

[^before-hide]: The alternative is computing badges against the post-hide node set, so a badge would also count neighbours the user hid from the legend. That conflates two different statements — "the depth limit cut this" and "you hid that" — and it makes the badges jump around as the user works the legend, which is exactly when they are trying to read the diagram. It would also make the `Deeper` button's enablement depend on the legend, which is incoherent: `Deeper` raises the depth, and no depth raises a legend-hidden node back into view. Computing before the hide keeps the badge answering one question and keeps it stable.

[^deeper-button]: Both gestures on the node are already spoken for, and both are shared with the navigator: double-click routes to `openReferencedTable` and right-click to the same object menu the navigator tree shows ([SqlAdminController.ts:2019](frontend/src/SqlAdminController.ts#L2019)), so appending a diagram-only entry there would leak diagram vocabulary into a menu the tree also uses. A button under the Depth control sits beside the thing it changes and needs no new library capability. Its enablement is derived from the badges themselves (`hasDepthBadge`), so the two are always consistent: a marker on screen means the button works, no marker means it is off. Stepping the shared depth rather than expanding one node's neighbours was chosen because a per-node expansion set would be a third narrowing mechanism beside direction+depth and the legend, each of which would then have to define what it does to the other two.

[^no-ghosts]: Drawing a placeholder node (a "…" box) or an edge running to nothing for each cut neighbour was rejected outright. Placeholders are real nodes to ELK, so they take part in layer assignment and node placement and push the graph the user *does* want to read out of shape — the more is hidden, the worse the distortion. They would also appear in `RelationDiagramPanel`'s and `RootedRelationGraphPanel`'s per-node legend as rows the user can hide, which is meaningless, and a dangling edge would break `subgraph`'s rule that an edge survives only when both endpoints are kept. The badge carries the same information with no effect on layout.

---

## Implementation Notes

- **`RootedDiagramShell` keeps only `depthControl`, `deeperButton`, and `rootedBlock` as fields — not `directionControl`/`pruneControl`.** The Public API sketch lists all five controls as private fields, but `directionControl`/`pruneControl` are read only once, from their own `.on("change", …)` closures wired in the constructor; nothing else in the class ever reads `this.directionControl` or `this.pruneControl` back. The app's `tsconfig.json` has `noUnusedLocals: true`, which flags a private field that is assigned but never read as an error — so the two were kept as constructor locals (closed over by their own listeners) instead of fields, matching the pre-refactor precedent in `RelationDiagramPanel`/`DatabaseDiagramPanel`, where the direction/prune *controls* were likewise never fields (only the derived `direction`/`prune` *values* were). `depthControl` (read by `stepDepth`) and `deeperButton` (read by `setDeeperEnabled`) do need to stay fields, since each is read again after construction.

- **Manual verification was performed** against a real backend (own `uvicorn` instance on a free port, `sqladmin-db`'s Postgres container reused) and a real Vite dev server (own instance, temporarily pointed at that backend; `vite.config.ts` was reverted afterwards), driven headlessly via chrome-devtools. Confirmed live: `RelationDiagramPanel` ("Show relations") opens at Depth 1 with a dimmed `←+N`/`+N→` badge on `hub.proc_account` when rooted at `hub.core_account`, the root card keeps its accent border, and `Deeper` steps Depth 1→2, re-lays out, and disables itself once the whole reachable component (154 tables) is drawn with no cut neighbours left. The brand-new `RootedRelationGraphPanel` ("Show ▸ Dependencies") was exercised the same way — Direction/Depth/Deeper/legend appeared for the first time on `hub.core_account`'s dependency graph, a `+3→` badge appeared on `v_core_account`, `Deeper` revealed `projects`/`users`/`workorders` with their own badges, and switching Direction to Downstream re-rooted the graph and cleared the badges (this graph has no downstream dependency edges from `core_account`). `Fit to view` on the 154-node graph confirmed the layout centres correctly with no runaway pan. Also confirmed live, via `elementFromPoint` hit-testing, that `TableCardNode`'s header row correctly falls through to the card's `pointer` cursor (the audit's BLOCKING finding 1, fixed in the fixup folded into the code commit). **Not performed**: the `DatabaseDiagramPanel` Tables-mode root-selection scenario and the `Inheritance` entry point — the database-level right-click entry point could not be located quickly in this pass, and the remaining manual-verify items (prune, legend-hide-doesn't-move-badges, Overview-mode hides controls) were not separately driven live. These exercise the same shared `RootedDiagramShell`/`withDepthBadges` code paths already confirmed working above and are covered by the unit-tested pure helpers, but the panel wiring itself was not eyeballed.
