---
touches-shared:
  - frontend/src/dock/RelationDiagramPanel.ts
  - frontend/src/dock/RootedRelationGraphPanel.ts
  - frontend/src/dock/DatabaseDiagramPanel.ts
  - frontend/src/data/relationDiagram.ts
---

# One Diagram Shell With an Optional Root — Implementation Plan

## Overview

Six diagram panels currently split into two kinds. Three extend [`RootedDiagramShell`](frontend/src/dock/rootedDiagramShell.ts#L134) and are rooted for life; three extend `DiagramView` directly and show one whole graph with no controls at all. The root itself is not shell state today — [`DatabaseDiagramPanel`](frontend/src/dock/DatabaseDiagramPanel.ts#L51) hand-builds a selectable root on top of the shell: the `(none)` sentinel ([:42](frontend/src/dock/DatabaseDiagramPanel.ts#L42)), the combo box ([:89](frontend/src/dock/DatabaseDiagramPanel.ts#L89)), the hide-the-controls-while-unrooted calls ([:116-117](frontend/src/dock/DatabaseDiagramPanel.ts#L116)), and the centre-after-layout listener ([:153-182](frontend/src/dock/DatabaseDiagramPanel.ts#L153)).

**This plan moves the root into the shell.** The shell holds the root as `string | null`, builds the `Root …` selector, shows the Direction / Depth / prune block exactly while a root is chosen, and centres the view on a pick. A panel that must never re-root passes `fixedRoot: true`. All six panels then extend one shell: `RelationDiagramPanel` and `RootedRelationGraphPanel` with a fixed root, `DatabaseDiagramPanel` with a selectable root (deleting its own machinery and inheriting the shell's), and `SchemaDiagramPanel`, `RelationGraphPanel`, and `RoleGrantsDiagramPanel` gaining a selectable root they never had. `ExplainDiagramPanel` does not extend the shell and is untouched.

**The `Deeper` button is removed** in the same pass: the button ([`rootedDiagramShell.ts:165`](frontend/src/dock/rootedDiagramShell.ts#L165)), `setDeeperEnabled` ([:234](frontend/src/dock/rootedDiagramShell.ts#L234)), `stepDepth` ([:306](frontend/src/dock/rootedDiagramShell.ts#L306)), its five call sites across three panels, and its enable predicate `hasDepthBadge` ([`frontend/src/data/relationDiagram.ts:269`](frontend/src/data/relationDiagram.ts#L269)), which has no other caller. The `+N` depth badge on a cut node stays exactly as it is.

The shell's module and class are renamed to `frontend/src/dock/diagramShell.ts` / `DiagramShell`. New pure logic — the selector's item list and the two graph-derivation steps a plain panel needs — goes in [`frontend/src/data/relationDiagram.ts`](frontend/src/data/relationDiagram.ts), which is unit-testable under the app's DOM-less vitest. No library change, and no panel's constructor signature changes, so `SqlAdminController.ts` is untouched.

---

## Architecture Decisions

### One shell owns the root; `DatabaseDiagramPanel`'s copy is deleted

`DiagramShell` gains `rootId: string | null`, the `Root …` combo box, `ROOT_NONE`, the visibility rule, and the viewport move. `DatabaseDiagramPanel` deletes its `ROOT_NONE` constant, its `rootId` field, its `rootControl` field and construction, and its whole `change` listener, and reads `this.getRoot()` instead.[^one-shell]

### `fixedRoot` is separate from the initial root, and the config makes the pairing a compile-time rule

The config carries an initial `root` and a `fixedRoot` flag as independent fields, so a selector that opens pre-rooted stays expressible. `DiagramShellConfig` is a union of two variants, so `fixedRoot: true` cannot compile without a `root`, and a selectable panel cannot compile without a `rootCaption`.[^union]

| Panel | Config | Opens |
|---|---|---|
| `RelationDiagramPanel` | `fixedRoot: true, root: root.id` | rooted, no selector |
| `RootedRelationGraphPanel` | `fixedRoot: true, root: root.id` | rooted, no selector |
| `DatabaseDiagramPanel` | `full, rootCaption: "Root table"` | unrooted (and in Overview mode) |
| `SchemaDiagramPanel` | `full, rootCaption: "Root table"` | whole graph |
| `RelationGraphPanel` | `full, rootCaption: "Root relation"` | whole graph |
| `RoleGrantsDiagramPanel` | `full, rootCaption: "Root node"` | whole graph |

### A fixed root is a tab-identity rule, not a taste

`RelationDiagramPanel` and `RootedRelationGraphPanel` open from a navigator object and their tabs are titled after it — `invoices (relations)`, `invoices (dependencies)` ([`SqlAdminController.ts:1694`](frontend/src/SqlAdminController.ts#L1694), [:1849](frontend/src/SqlAdminController.ts#L1849)). Re-rooting inside such a tab would make its title name a relation the diagram is no longer about. The other four panels' titles name a schema, a database, or a role — a container, not the root — so a root selector inside them contradicts nothing.

### The traversal block follows the root; one panel has a second, orthogonal reason to hide it

The shell's rule: **the Direction / Depth / prune block — the traversal block — is displayed exactly while the root is non-null.** No subclass calls a visibility setter for that any more.

`DatabaseDiagramPanel` needs one more thing, and the shell gives it exactly one narrow mechanism, `setRootingDisplayed(false)`: in Overview mode the drawn graph is not the rooted graph at all, so the selector row, the traversal block, and the legend all go away together. Overview is *not* modelled as "root = null" — Tables mode with no root is a different, legitimate state that must keep its per-schema legend.[^overview-override]

| Mode | Root | `Root table` row | Traversal block | Legend | Drawn graph |
|---|---|---|---|---|---|
| Overview | any (retained) | hidden | hidden | hidden | schema overview |
| Tables | `(none)` | shown | **hidden** (today: shown but inert) | shown (per-schema) | whole grouped graph |
| Tables | `public.invoices` | shown | shown | shown (per-schema) | rooted neighbourhood, grouped |

### The module and class are renamed to `diagramShell.ts` / `DiagramShell`

"Rooted" would state the opposite of what the class now guarantees, since the root may be null for four of the six panels.[^rename]

### The derivation pipeline stays in the panels, shared as pure functions

The shell owns no `full` / `base` / `hidden` state. The three new panels each keep a four-member pipeline whose bodies are one call each, because the work sits in three shared helpers: `rootedBase` and `filteredBase` (pure, in `relationDiagram.ts`) and `fillLegend` (beside `legendRow` in the shell module).[^no-pipeline-in-shell]

### The selector lists labels, falling back to ids when a label is ambiguous

`rootChoices(data)` maps each node to `{ key: node id, label: node label }`, sorted by the displayed label with ties broken by key. **A label shared by two or more nodes cannot name either of them, so each of those nodes is listed by its id instead.** The list is built once from the whole graph, not from the narrowed subgraph currently drawn.[^whole-graph-list]

| `data.nodes` as (id / label) | `rootChoices(data)` in order (key → shown label) |
|---|---|
| `public.users` / `users`, `audit.users` / `users`, `public.orders` / `orders`, `t9` / *no label* | `audit.users` → `audit.users`, `public.orders` → `orders`, `public.users` → `public.users`, `t9` → `t9` |

Both `users` nodes fall back to their ids and sort under `a` and `p`; the unambiguous `public.orders` shows as `orders`; the label-less `t9` shows its id.

### Picking a root centres on it; clearing fits the whole graph

Both moves wait for the layout pass the re-derivation started, then act, re-checking that the root has not changed again meanwhile — the reasoning already written out in `DatabaseDiagramPanel`'s listener ([:153-182](frontend/src/dock/DatabaseDiagramPanel.ts#L153)). A pick calls `view.focusNode(rootId)`; clearing to `(none)` calls `view.zoomToFit()`.[^fit-on-clear]

### `Deeper` goes, the `+N` badge stays

The badge answers "there is more this way", and `withDepthBadges` is untouched. The button that stepped Depth on the user's behalf is removed, and the Depth control remains the way to widen a rooted view. Removing `stepDepth` leaves `depthControl` with no reader, so it becomes a constructor local.[^depth-control-local]

### The chosen root gets no accent border

The narrowed graph, the centred viewport, and the selector's own value identify the root; the converted panels keep their current node rendering.[^no-root-border]

---

## Public API

### `frontend/src/data/relationDiagram.ts`

```typescript
/** One entry of a root selector: the node id as `key`, its display name as `label`. */
export interface RootChoice {
    key: string;
    label: string;
}

/**
 * The root-selector items for a graph: one per node, keyed by node id. A node is
 * labelled by its own label, or by its id when it has none or when another node
 * carries the same label. Sorted by the shown label, ties broken by key. Pure.
 *
 * @param data - The graph whose nodes are selectable.
 * @returns The items in display order; empty for a graph with no nodes.
 */
export function rootChoices(data: DiagramData): RootChoice[];

/**
 * The base graph for a panel whose root may be absent: the badged
 * direction+depth neighbourhood of `rootId`, or `full` itself when `rootId` is
 * null or names no node in `full`. Pure.
 *
 * @param full - The whole graph.
 * @param rootId - The chosen root's node id, or null for the whole graph.
 * @param direction - The traversal direction to walk.
 * @param depth - The hop limit from the root.
 * @returns The base graph to filter and draw.
 */
export function rootedBase(
    full: DiagramData,
    rootId: string | null,
    direction: TraversalDirection,
    depth: number,
): DiagramData;

/**
 * The graph to draw from a base: `base` unchanged when there is no root (nothing
 * to hide against), else `base` with the hidden nodes removed — and, when
 * pruning, what they orphaned from the root. Pure.
 *
 * @param base - The base graph.
 * @param rootId - The chosen root's node id, or null.
 * @param hidden - Node ids the user has hidden.
 * @param prune - Whether to also drop nodes orphaned from the root.
 * @param direction - The base's traversal direction.
 * @returns The subgraph to hand to the view.
 */
export function filteredBase(
    base: DiagramData,
    rootId: string | null,
    hidden: ReadonlySet<string>,
    prune: boolean,
    direction: TraversalDirection,
): DiagramData;
```

Removed from the same file: `export function hasDepthBadge(data: DiagramData): boolean`.

### `frontend/src/dock/diagramShell.ts` (renamed from `rootedDiagramShell.ts`)

Unchanged exports: `DEPTH_ALL`, `DEPTH_CHOICES`, `DEFAULT_DEPTH`, `depthFromChoice`, `labelledRow`, `legendRow`.

```typescript
/** The root selector's sentinel item: no root chosen, so the whole graph shows. */
export const ROOT_NONE = "(none)";

/**
 * Fill a legend column with one row per node in `base`, the root's row locked
 * shown. Clears the column and adds nothing when `rootId` is null — an
 * unrooted view draws the whole graph and has nothing to hide against.
 *
 * @param legend - The legend column to refill.
 * @param base - The graph whose nodes get a row.
 * @param rootId - The chosen root's node id, or null.
 * @param hidden - The shared hidden-id set the rows mutate.
 * @param applyFilter - Re-filters the view after a toggle.
 */
export function fillLegend(
    legend: Panel,
    base: DiagramData,
    rootId: string | null,
    hidden: Set<string>,
    applyFilter: () => void,
): void;
```

The config is a union, so the compiler enforces the `fixedRoot` / `root` / `rootCaption` pairings:

```typescript
/** The CENTER view plus the subclass's extra control slots. */
export interface DiagramShellSlots {
    /** The CENTER diagram. Built by the subclass, which owns the node renderer. */
    view: DiagramView;
    /** Always-visible controls above the `Root …` row (the database diagram's Mode row). */
    headerControls?: Component[];
    /** Controls inside the hideable block, above Direction. */
    rootedControls?: Component[];
    /** Controls inside the hideable block, below the prune row (the relation diagram's coverage row). */
    extraControls?: Component[];
}

/** A panel whose root never changes: no `Root …` row is built, and a root is required. */
export interface FixedRoot {
    fixedRoot: true;
    /** The immutable root's node id. */
    root: string;
}

/** A panel the user may re-root from a `Root …` row listing `full`'s nodes. */
export interface SelectableRoot {
    fixedRoot?: false;
    /** The whole graph, whose nodes the selector lists. */
    full: DiagramData;
    /** The selector row's caption, naming what this panel's nodes are ("Root table"). */
    rootCaption: string;
    /** The root to open at; omitted or null opens on the whole graph. */
    root?: string | null;
}

export type DiagramShellConfig = DiagramShellSlots & (FixedRoot | SelectableRoot);
```

```typescript
class DiagramShell extends Panel {
    /** @param config - The CENTER view, the root mode, and the extra control slots. */
    constructor(config: DiagramShellConfig);

    /** Resolves once the view's in-flight layout pass has placed its nodes. */
    whenLaidOut(): Promise<void>;

    /** The chosen root's node id, or null while the whole graph is shown. */
    protected getRoot(): string | null;

    /**
     * Adopt a root programmatically: writes the root, syncs the selector,
     * re-applies the traversal block's visibility, and invokes
     * `rootingChanged()`. Moves no viewport and emits no `change`.
     */
    protected setRoot(root: string | null): this;

    /**
     * Whether this panel is showing a rooted graph at all. False hides the
     * `Root …` row, the traversal block, and the legend together; true restores
     * them, the block still only while the root is non-null.
     */
    protected setRootingDisplayed(displayed: boolean): this;

    /** The Direction control's current value. */
    protected getDirection(): TraversalDirection;

    /** The Depth control's current hop limit. */
    protected getDepth(): number;

    /** Whether the prune checkbox is ticked. */
    protected isPrune(): boolean;

    /** The root, Direction, or Depth changed. Subclasses re-root here. */
    protected rootingChanged(): void;

    /** The prune checkbox changed. Subclasses re-filter here. */
    protected pruneChanged(): void;
}
```

Removed from the shell: `setDeeperEnabled`, `setRootedControlsDisplayed`, `setLegendDisplayed`, and the private `stepDepth`.

### Panel constructors — all six unchanged

```typescript
class SchemaDiagramPanel extends DiagramShell {
    constructor(data: DiagramData, onSelectTable: (table: string) => void,
                onContextMenu?: (table: string, event: MouseEvent) => void);
}

class RelationGraphPanel extends DiagramShell {
    constructor(data: DiagramData, onSelect: (node: RelationNodeData) => void,
                onContextMenu?: (node: RelationNodeData, event: MouseEvent) => void);
}

class RoleGrantsDiagramPanel extends DiagramShell {
    constructor(data: DiagramData, onOpenTable: (schema: string, table: string) => void,
                onContextMenu?: (schema: string, table: string, event: MouseEvent) => void);
}
```

`relationGraphNodeRenderer` ([`RelationGraphPanel.ts:37`](frontend/src/dock/RelationGraphPanel.ts#L37)) keeps its signature and its export — `RootedRelationGraphPanel` still imports it.

---

## Internal Structure

### The three new pure functions

```typescript
export function rootChoices(data: DiagramData): RootChoice[] {
    const labelCounts = new Map<string, number>();

    for (const n of data.nodes) {
        const label = n.label ?? n.id;

        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    const choices = data.nodes.map((n) => {
        const label = n.label ?? n.id;

        // A label two nodes share names neither of them: fall back to the id,
        // which is unique across a graph by construction.
        return { key: n.id, label: labelCounts.get(label) === 1 ? label : n.id };
    });

    return choices.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

export function rootedBase(
    full: DiagramData,
    rootId: string | null,
    direction: TraversalDirection,
    depth: number,
): DiagramData {
    const root = rootId === null ? undefined : full.nodes.find(n => n.id === rootId);

    if (!root) {
        return full;
    }

    return withDepthBadges(rootedDiagram(full, root, direction, depth), full.edges, direction);
}

export function filteredBase(
    base: DiagramData,
    rootId: string | null,
    hidden: ReadonlySet<string>,
    prune: boolean,
    direction: TraversalDirection,
): DiagramData {
    return rootId === null ? base : applyHide(base, rootId, hidden, prune, direction);
}
```

### The shell's new state and members

Fields (replacing the `depthControl` / `deeperButton` pair at [:140-142](frontend/src/dock/rootedDiagramShell.ts#L140)):

```typescript
    /** The `Root …` row, or null when the root is fixed (no row is built). */
    private readonly rootRow:     Component | null;
    /** The `Root …` combo, or null when the root is fixed. Re-synced by setRoot. */
    private readonly rootControl: ComboBox  | null;
    private readonly rootedBlock: Panel;

    private rootId: string | null;
    /** False while the panel is not showing a rooted graph at all (Overview mode). */
    private rootingDisplayed = true;
    private direction: TraversalDirection = "both";
    private depthIndex = DEPTH_CHOICES.indexOf(String(DEFAULT_DEPTH));
    private prune = false;
```

Constructor, pre-`super()` additions beside the existing control locals:

```typescript
        const initialRoot = config.fixedRoot ? config.root : (config.root ?? null);

        // No selector when the root is fixed — the tab's title names that root.
        const rootControl = config.fixedRoot
            ? null
            : ComboBox({ items: [ROOT_NONE, ...rootChoices(config.full)], value: initialRoot ?? ROOT_NONE });
        const rootRow = rootControl === null ? null : labelledRow(config.rootCaption, rootControl);
```

The `Root …` row sits above the hideable block, so it survives while the root is null:

```typescript
        const controls = Panel({
            layoutManager: new VBox({ spacing: 4 }),
            components: [...(config.headerControls ?? []), ...(rootRow ? [rootRow] : []), rootedBlock],
        });
```

Constructor, post-`super()`:

```typescript
        this.rootRow     = rootRow;
        this.rootControl = rootControl;
        this.rootedBlock = rootedBlock;
        this.rootId      = initialRoot;

        // Reads only this shell's own fields, so no subclass field is touched
        // before the subclass body has run.
        this.applyRootVisibility();

        // Wire listeners after super() (this now available), per
        // COMPONENT_CONVENTIONS.md (b).
        directionControl.on("change", (v: string) => { this.direction = v as TraversalDirection; this.rootingChanged(); });
        depthControl.on("change",     (v: string) => { this.depthIndex = DEPTH_CHOICES.indexOf(v); this.rootingChanged(); });
        pruneControl.on("change",     (v: boolean) => { this.prune = v; this.pruneChanged(); });
        rootControl?.on("change",     (v: string) => this.chooseRoot(v === ROOT_NONE ? null : v));
```

The root members:

```typescript
    protected getRoot(): string | null {
        return this.rootId;
    }

    protected setRoot(root: string | null): this {
        this.rootId = root;

        // A programmatic ComboBox.setValue fires no `change` (the inner List
        // fires only from its click / keyboard reducers), so this does not
        // re-enter chooseRoot and the caller's own rootingChanged below is the
        // only re-derivation.
        this.rootControl?.setValue(root ?? ROOT_NONE);

        this.applyRootVisibility();
        this.rootingChanged();

        return this;
    }

    protected setRootingDisplayed(displayed: boolean): this {
        this.rootingDisplayed = displayed;
        this.applyRootVisibility();

        return this;
    }

    // The selector's own gesture: adopt the root, then move the viewport.
    private chooseRoot(root: string | null): void {
        this.setRoot(root);

        // Waits for the re-derivation's setData to place the new graph before
        // moving the viewport: node ids are stable across a re-root, so acting
        // synchronously would target the graph setData has just started
        // replacing, spending the one-shot centring on it. Re-checks the root
        // once the wait resolves, because whenLaidOut's promise is shared across
        // passes and the user may have picked again meanwhile.
        void this.view.whenLaidOut().then(() => {
            if (this.rootId !== root) {
                return;
            }

            if (root === null) {
                this.view.zoomToFit();
            } else {
                this.view.focusNode(root);
            }
        });
    }

    // The selector row and the legend follow "is this a rooted view at all";
    // the traversal block additionally needs a root to act on.
    private applyRootVisibility(): void {
        this.rootRow?.setDisplayed(this.rootingDisplayed);
        this.legend.setDisplayed(this.rootingDisplayed);
        this.rootedBlock.setDisplayed(this.rootingDisplayed && this.rootId !== null);
    }
```

`fillLegend`, added beside `legendRow` in the same module:

```typescript
export function fillLegend(
    legend: Panel,
    base: DiagramData,
    rootId: string | null,
    hidden: Set<string>,
    applyFilter: () => void,
): void {
    legend.removeAllComponents();

    if (rootId === null) {
        return;
    }

    for (const n of base.nodes) {
        legend.addComponent(legendRow(n, rootId, hidden, applyFilter));
    }
}
```

### A plain panel's body — identical in all three new panels

Only the constructor differs. `SchemaDiagramPanel` in full:

```typescript
class SchemaDiagramPanel extends DiagramShell {
    private readonly full: DiagramData;
    private readonly hidden = new Set<string>();
    private base: DiagramData;

    constructor(data: DiagramData, onSelectTable: (table: string) => void,
                onContextMenu?: (table: string, event: MouseEvent) => void) {
        // Local before super() — it is super()'s CENTER child (`this` is
        // unavailable until super() returns).
        const view = DiagramView({ data, elkWorkerFactory });

        super({ view, full: data, rootCaption: "Root table" });

        this.full = data;
        this.base = data;

        attachFkEdgeTooltip(this.view);

        // Double-click opens the table; a single click only selects it.
        this.view.on("activate", (node: DiagramNodeData) => {
            onSelectTable(node.id);
        });

        this.view.on("contextmenu", (node: DiagramNodeData, event: MouseEvent) => {
            onContextMenu?.(node.id, event);
        });
    }

    protected rootingChanged(): void {
        this.rebuildBase();
    }

    protected pruneChanged(): void {
        this.applyFilter();
    }

    // Passed by reference to fillLegend's rows — MUST be an arrow field, or it
    // would lose `this` when invoked as a callback.
    private applyFilter = (): void => {
        this.view.setData(
            filteredBase(this.base, this.getRoot(), this.hidden, this.isPrune(), this.getDirection()));
    };

    private rebuildBase = (): void => {
        this.base = rootedBase(this.full, this.getRoot(), this.getDirection(), this.getDepth());

        this.hidden.clear();
        fillLegend(this.legend, this.base, this.getRoot(), this.hidden, this.applyFilter);
        this.applyFilter();
    };
}
```

`RelationGraphPanel` and `RoleGrantsDiagramPanel` differ only in their constructors:

```typescript
        const view = DiagramView({ data, nodeRenderer: relationGraphNodeRenderer(), elkWorkerFactory });

        super({ view, full: data, rootCaption: "Root relation" });
```

```typescript
        const roleNodeId = data.nodes.find(n => (n.data as GrantNodeData | undefined)?.kind === "role")?.id;
        const view = DiagramView({ data, elkWorkerFactory, initialFocusNode: roleNodeId });

        super({ view, full: data, rootCaption: "Root node" });
```

### What each existing subclass keeps

- **`RelationDiagramPanel`** and **`RootedRelationGraphPanel`** keep their own `full`, `root` (a `DiagramNodeData`, not an id — `rootedDiagram` injects a root that has no edges in `full`, which is how a view / matview root still renders, and an id cannot express that), `base`, `hidden`, and their existing pipelines. They change only their `super({ … })` config and lose their `setDeeperEnabled` lines.
- **`DatabaseDiagramPanel`** keeps `full`, `overviewGraph`, `schemaNames`, `mode`, `modeControl`, `base`, `hiddenSchemas`, `isHiddenLeaf`, `applyFilter`, `rebuildLegend`, `rebuildBase`, `focusSchema`, and `schemaLegendRow`. Its per-schema legend is its own; only the legend column's visibility is the shell's.

### `DatabaseDiagramPanel`'s changed members

```typescript
        const config: DiagramShellConfig = {
            view,
            full,
            rootCaption   : "Root table",
            headerControls: [labelledRow("Mode", modeControl)],
        };

        super(config);
        // …
        // Overview is the default mode: this panel is not showing a rooted graph
        // at all, so the selector row, the traversal block, and the legend all go.
        this.setRootingDisplayed(false);
```

```typescript
        modeControl.on("change", (v: string) => {
            this.mode = v as DiagramMode;

            if (this.mode === "overview") {
                this.setRootingDisplayed(false);
                this.view.setData(this.overviewGraph);
            } else {
                this.setRootingDisplayed(true);
                this.rebuildBase();
                this.rebuildLegend();
            }
        });
```

```typescript
    private applyFilter = (): void => {
        if (this.mode !== "tables") {
            return;
        }

        const root = this.getRoot();

        const filtered = root !== null
            ? applyHide(this.base, root, new Set(this.base.nodes.filter(this.isHiddenLeaf).map(n => n.id)), this.isPrune(), this.getDirection())
            : subgraph(this.base, new Set(this.base.nodes.filter(n => !this.isHiddenLeaf(n)).map(n => n.id)));

        this.view.setData(groupBySchema(filtered));
    };

    private rebuildBase = (): void => {
        this.base = rootedBase(this.full, this.getRoot(), this.getDirection(), this.getDepth());

        this.applyFilter();
    };

    private focusSchema = (schema: string): void => {
        this.mode = "tables";
        this.hiddenSchemas.clear();

        for (const s of this.schemaNames) {
            if (s !== schema) {
                this.hiddenSchemas.add(s);
            }
        }

        this.modeControl.setValue("tables");
        this.setRootingDisplayed(true);
        this.rebuildLegend();

        // Last: setRoot resets the selector to (none) and re-derives through
        // rootingChanged, so mode and hiddenSchemas must already be set.
        this.setRoot(null);
    };
```

---

## Ordered Implementation Steps

Steps 1–8 remove the `Deeper` button and leave the app green on its own. Steps 9–16 unify the root.

1. **`frontend/tests/data/relationDiagram.test.ts`** — delete `hasDepthBadge` from the import at [line 5](frontend/tests/data/relationDiagram.test.ts#L5) and its whole `describe` block ([lines 276-301](frontend/tests/data/relationDiagram.test.ts#L276)). Add `describe` blocks for `rootChoices`, `rootedBase`, and `filteredBase` covering every case in _Expected Behaviour → Unit-testable_. `cd frontend && npm test` — red on the three missing exports only.

2. **`frontend/src/data/relationDiagram.ts`** — delete `hasDepthBadge` and its doc comment ([:262-271](frontend/src/data/relationDiagram.ts#L262)). Add `RootChoice`, `rootChoices`, `rootedBase`, and `filteredBase` per _Public API_ / _Internal Structure_. Extend the header comment ([:1-5](frontend/src/data/relationDiagram.ts#L1)) to name the new derivations. Keep the file's purity rule: type-only imports from the diagram barrel, no UI-bundle runtime import. `npm test` — green.

3. **`frontend/src/dock/rootedDiagramShell.ts`** — remove the `Deeper` button, in place (the file is renamed later, in step 9):
   - Delete the `deeperButton` field ([:141](frontend/src/dock/rootedDiagramShell.ts#L141)), its construction ([:165](frontend/src/dock/rootedDiagramShell.ts#L165)), its entry in the `rootedBlock` components array ([:174](frontend/src/dock/rootedDiagramShell.ts#L174)), its assignment ([:206](frontend/src/dock/rootedDiagramShell.ts#L206)), and its `action` listener ([:213](frontend/src/dock/rootedDiagramShell.ts#L213)).
   - Delete `setDeeperEnabled` ([:228-238](frontend/src/dock/rootedDiagramShell.ts#L228)) and `stepDepth` ([:302-315](frontend/src/dock/rootedDiagramShell.ts#L302)).
   - Delete the now-unused `Button` import ([:23](frontend/src/dock/rootedDiagramShell.ts#L23)).
   - Demote `depthControl` to a constructor local: delete the field ([:140](frontend/src/dock/rootedDiagramShell.ts#L140)) and its assignment ([:205](frontend/src/dock/rootedDiagramShell.ts#L205)); the `const depthControl` local ([:164](frontend/src/dock/rootedDiagramShell.ts#L164)) stays, closed over by its own listener ([:212](frontend/src/dock/rootedDiagramShell.ts#L212)).
   - Update the comments naming the button: `DEPTH_CHOICES` ([:31-33](frontend/src/dock/rootedDiagramShell.ts#L31)), `DEFAULT_DEPTH` ([:36-39](frontend/src/dock/rootedDiagramShell.ts#L36)), `rootingChanged` ([:292](frontend/src/dock/rootedDiagramShell.ts#L292)). The file header and the class doc are rewritten wholesale in step 9, so leave them for now.

4. **`frontend/src/dock/RelationDiagramPanel.ts`** — delete both `this.setDeeperEnabled(hasDepthBadge(this.base));` lines ([:110](frontend/src/dock/RelationDiagramPanel.ts#L110), [:193](frontend/src/dock/RelationDiagramPanel.ts#L193)) and drop `hasDepthBadge` from the import ([:28](frontend/src/dock/RelationDiagramPanel.ts#L28)).

5. **`frontend/src/dock/RootedRelationGraphPanel.ts`** — the same two deletions ([:69](frontend/src/dock/RootedRelationGraphPanel.ts#L69), [:112](frontend/src/dock/RootedRelationGraphPanel.ts#L112)) and the import ([:22](frontend/src/dock/RootedRelationGraphPanel.ts#L22)).

6. **`frontend/src/dock/DatabaseDiagramPanel.ts`** — delete the `setDeeperEnabled` line ([:252](frontend/src/dock/DatabaseDiagramPanel.ts#L252)) and drop `hasDepthBadge` from the import ([:34](frontend/src/dock/DatabaseDiagramPanel.ts#L34)).

7. **Checkpoint.** `cd frontend && npm run typecheck && npm test` — green. `grep -rn 'Deeper\|setDeeperEnabled\|hasDepthBadge' frontend/src frontend/tests` — zero matches. `grep -rn 'withDepthBadges' frontend/src` — the three rooted panels plus `relationDiagram.ts`: the badge itself must survive.

8. **Commit-sized pause point.** Part 1 is complete and independently verifiable; the manual `Deeper` checks in _Expected Behaviour → Manual_ can be run here.

9. **Rename the shell module.** `git mv frontend/src/dock/rootedDiagramShell.ts frontend/src/dock/diagramShell.ts`, rename the class `RootedDiagramShell` → `DiagramShell` and the callable-export block accordingly, and rename the config type `RootedDiagramShellConfig` → the `DiagramShellConfig` union from _Public API_ (with `DiagramShellSlots`, `FixedRoot`, `SelectableRoot`). Rewrite the file header comment: one shell for the six traversal panels, the root is `string | null`, `fixedRoot` suppresses the selector, the visibility rule, and the class-first note (`extends Panel`, locals before `super()`, listeners after). Rewrite the class doc comment to match. Do not touch `ExplainDiagramPanel`, which does not use this module.

10. **`frontend/src/dock/diagramShell.ts`** — add the root: `ROOT_NONE`, the `rootRow` / `rootControl` fields, `rootId`, `rootingDisplayed`, the constructor additions, `getRoot`, `setRoot`, `setRootingDisplayed`, `chooseRoot`, `applyRootVisibility`, and the `fillLegend` helper — all per _Internal Structure_. Delete `setRootedControlsDisplayed` ([:240-251](frontend/src/dock/rootedDiagramShell.ts#L240)) and `setLegendDisplayed` ([:253-263](frontend/src/dock/rootedDiagramShell.ts#L253)). Import `rootChoices` from `../data/relationDiagram`. Typecheck now fails in the three panels that already extend the shell — their configs lack the new fields and their import path has moved — which steps 11-13 fix; the other three are converted in steps 14-16.

11. **`frontend/src/dock/RelationDiagramPanel.ts`** — point the import at `./diagramShell`, change `extends RootedDiagramShell` to `extends DiagramShell`, retype the config local ([:92](frontend/src/dock/RelationDiagramPanel.ts#L92)) as `DiagramShellConfig`, and add `fixedRoot: true, root: root.id` to it. Nothing else changes: it keeps `full`, `root`, `base`, `hidden`, `cards`, `showCoverage`, and all four helpers. Update the header comment's reference to the shell's file name and to the WEST column's contents.

12. **`frontend/src/dock/RootedRelationGraphPanel.ts`** — the same: import path, base class, and `super({ view, fixedRoot: true, root: root.id })` ([:63](frontend/src/dock/RootedRelationGraphPanel.ts#L63)). Its pipeline is untouched. Update the header comment.

13. **`frontend/src/dock/DatabaseDiagramPanel.ts`** — delete its root machinery and inherit the shell's:
    - Delete the `ROOT_NONE` constant and its comment ([:40-42](frontend/src/dock/DatabaseDiagramPanel.ts#L40)), the `rootId` field ([:65](frontend/src/dock/DatabaseDiagramPanel.ts#L65)), the `rootControl` field ([:70](frontend/src/dock/DatabaseDiagramPanel.ts#L70)), its construction ([:89](frontend/src/dock/DatabaseDiagramPanel.ts#L89)), its assignment ([:112](frontend/src/dock/DatabaseDiagramPanel.ts#L112)), and its whole `change` listener ([:153-182](frontend/src/dock/DatabaseDiagramPanel.ts#L153)).
    - Config ([:99-103](frontend/src/dock/DatabaseDiagramPanel.ts#L99)): add `full` and `rootCaption: "Root table"`, keep `headerControls`, drop `rootedControls` entirely.
    - Replace the two post-`super()` visibility calls ([:116-117](frontend/src/dock/DatabaseDiagramPanel.ts#L116)) with `this.setRootingDisplayed(false);`.
    - Rewrite the mode handler ([:183-196](frontend/src/dock/DatabaseDiagramPanel.ts#L183)), `applyFilter` ([:216-226](frontend/src/dock/DatabaseDiagramPanel.ts#L216)), `rebuildBase` ([:240-254](frontend/src/dock/DatabaseDiagramPanel.ts#L240)), and `focusSchema` ([:260-277](frontend/src/dock/DatabaseDiagramPanel.ts#L260)) per _Internal Structure → `DatabaseDiagramPanel`'s changed members_. `rebuildBase` now calls `rootedBase`, so its `../data/relationDiagram` import ([:34](frontend/src/dock/DatabaseDiagramPanel.ts#L34)) becomes `{ applyHide, subgraph, rootedBase }` — `rootedDiagram` and `withDepthBadges` are no longer used here.
    - Import path and base class as in step 11, plus `ROOT_NONE` is no longer needed here at all.
    - Update the header comment: the root/direction/depth controls and the sentinel now come from the shell; Overview mode hides the whole rooted column through `setRootingDisplayed`.

14. **`frontend/src/dock/SchemaDiagramPanel.ts`** — replace `extends DiagramView` with `extends DiagramShell` and write the body from _Internal Structure → A plain panel's body_. Keep the `callable()` export block. Imports each of the three new panels needs, beyond what it already has: `{ DiagramShell, fillLegend }` from `./diagramShell` and `{ rootedBase, filteredBase }` from `../data/relationDiagram`; `DiagramView` stays a value import, since the view is now built as a local rather than inherited. Rewrite the header comment: the panel is now the shell's WEST `Root table` + traversal + legend column over a CENTER `DiagramView`, opening on the whole schema graph.

15. **`frontend/src/dock/RelationGraphPanel.ts`** — the same body, `rootCaption: "Root relation"`, the view keeping `nodeRenderer: relationGraphNodeRenderer()`. Leave the exported `relationGraphNodeRenderer` and `ROOT_BORDER` untouched. Update the header comment, which currently says the panel has "no side column, no root, and no depth control".

16. **`frontend/src/dock/RoleGrantsDiagramPanel.ts`** — the same body, `rootCaption: "Root node"`, keeping the pre-`super()` `roleNodeId` lookup as the view's `initialFocusNode` and the module-level `Glyph.register(user, table)`. Update the header comment.

17. **Checkpoint.** `cd frontend && npm run typecheck && npm test` — green. Then the greps in _Verification_, then the manual walk-through. No library rebuild: nothing under `packages/lib` changes.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Delete | `frontend/src/dock/rootedDiagramShell.ts` (renamed — `git mv`, not a rewrite) |
| Create | `frontend/src/dock/diagramShell.ts` (the renamed shell: owns the root, `ROOT_NONE`, `fillLegend`; loses `Deeper`) |
| Modify | `frontend/src/dock/SchemaDiagramPanel.ts` (extends the shell; selectable root) |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` (extends the shell; selectable root) |
| Modify | `frontend/src/dock/RoleGrantsDiagramPanel.ts` (extends the shell; selectable root) |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` (deletes its root machinery; `Deeper` call site) |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` (`fixedRoot` config; `Deeper` call sites) |
| Modify | `frontend/src/dock/RootedRelationGraphPanel.ts` (`fixedRoot` config; `Deeper` call sites) |
| Modify | `frontend/src/data/relationDiagram.ts` (delete `hasDepthBadge`; add `rootChoices`, `rootedBase`, `filteredBase`) |
| Modify | `frontend/tests/data/relationDiagram.test.ts` (delete the `hasDepthBadge` block; add three blocks) |

---

## Expected Behaviour

### Unit-testable (`frontend/tests/data/relationDiagram.test.ts`)

**`rootChoices`**

1. A graph with no nodes returns `[]`.
2. A node with a label unique in the graph is listed as `{ key: id, label }`.
3. A node with no label is listed with its id as the label.
4. When two nodes share a label, both are listed with their ids as labels, and a third node with a unique label keeps it — the worked table in _Architecture Decisions_ is the case to encode.
5. Order is by shown label, ties broken by key.

**`rootedBase`**

6. `rootId` null returns `full` itself (same nodes and edges).
7. `rootId` naming no node in `full` returns `full` itself.
8. `rootId` naming a node returns the direction+depth neighbourhood, with `+N` badges on nodes whose neighbours the depth limit cut — the same output as `withDepthBadges(rootedDiagram(…), full.edges, direction)`.
9. Depth `Number.POSITIVE_INFINITY` returns the whole reachable component with no badge on any node.

**`filteredBase`**

10. `rootId` null returns `base` unchanged, even when `hidden` is non-empty — nothing is hidden while the whole graph is shown.
11. `rootId` set with `prune` false drops the hidden nodes and their edges, leaving nodes they orphaned in place.
12. `rootId` set with `prune` true also drops nodes made unreachable from the root.

Every existing test in the file — `reachableNodeIds`, `subgraph`, `rootedDiagram`, `applyHide`, `hiddenNeighbourCounts`, `depthBadgeLabel`, `withDepthBadges` — must stay green untouched.

### Manual

All of the below is panel wiring, ELK layout, and viewport geometry, so it needs the running app.

**Schema diagram** — navigator, right-click a schema → *Show ▸ Schema diagram*:

- Opens on the whole FK graph, the same nodes and edges as today. The WEST column shows the `Root table` row reading `(none)`; no Direction / Depth / prune block; the legend area is empty.
- Pick a table: the graph narrows to it plus its direct FK neighbours (Direction `Both`, Depth `1`), the view centres on it, the traversal block and the legend rows appear, and cut neighbours carry `+N` / `←+N` badges.
- Depth `2` widens it; `All` draws the whole reachable component with no badge left.
- Untick a legend row: that node goes. Tick `Hide with prune`: nodes it orphaned from the root go too. The root's own row stays ticked and disabled.
- Back to `(none)`: the whole graph returns, the traversal block and the legend rows go, and the view fits the whole graph.
- Hovering an FK edge still shows its tooltip; double-click still opens the table; right-click still shows the object menu.
- A schema with no tables opens empty and offers only `(none)`.

**Dependency graph / inheritance graph** — right-click a schema → *Show ▸ Dependency graph* / *Inheritance graph*: the same sequence with the caption `Root relation`. Dependency edges stay dashed; node glyphs are unchanged, rooted or not.

**Grants graph** — Roles rail, right-click a role → *Show grants graph*: opens on the whole star, centred on the role node as today, caption `Root node`. Picking a granted table narrows to that table plus the role; picking the role shows the whole star; `(none)` restores it.

**Database diagram** — right-click a schema → *Show ▸ Database diagram*:

- Opens in Overview with no `Root table` row, no traversal block, and no legend — one Mode row only.
- Switch to Tables: the `Root table` row and the per-schema legend appear; the traversal block does **not**, because no root is chosen (a change from today, where it appeared but did nothing). Hiding a schema from the legend still works.
- Pick a root table: the traversal block appears, the graph re-roots, the view centres on the root, and badges appear on cut leaves. Schema container boxes never carry a badge.
- Switch to Overview and back to Tables: the chosen root and its view come back, exactly as today.
- Double-click a schema node in Overview: it drills into Tables mode with only that schema shown, and the `Root table` row reads `(none)`.
- The root dropdown now lists `schema.table` for tables whose bare name repeats across schemas, and the bare table name for those that are unique.

**No `Deeper` button anywhere, badges intact:**

- Right-click a table → *Show ▸ Relations*: Direction, Depth, `Hide with prune`, and the legend, with no button between Depth and the prune row. No `Root …` row — this tab is titled after its root. Badges still appear on cut nodes and still move when Depth changes.
- Right-click a relation → *Show ▸ Dependencies* / *Inheritance*: the same.
- Roles rail → *Show membership graph*: the same (it reuses `RelationDiagramPanel`).

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — green, including the three new `describe` blocks.
- `grep -rn 'Deeper\|setDeeperEnabled\|hasDepthBadge' frontend/src frontend/tests` — zero matches.
- `grep -rn 'rootedDiagramShell\|RootedDiagramShell' frontend/src` — zero matches (the rename is complete).
- `grep -rn 'extends DiagramView' frontend/src` — zero matches.
- `grep -rn 'setRootedControlsDisplayed\|setLegendDisplayed' frontend/src` — zero matches.
- `grep -rn 'ROOT_NONE' frontend/src` — the definition in `diagramShell.ts` and its uses inside that same file; no other panel needs it.
- `grep -rn 'setRootingDisplayed' frontend/src` — the shell's definition plus exactly four calls, all in `DatabaseDiagramPanel.ts` (post-`super()`, both mode-handler branches, and `focusSchema`).
- `git diff --stat frontend/src/SqlAdminController.ts` — empty.
- The manual walk-through above. Entry points: the navigator's schema and relation *Show* submenus, and the Roles rail's role menu.
- No `npm run build:lib` in `packages/lib`: this change is app-only.

---

## Documentation Impact

No public API and no library surface change, so there is no doc page, catalog entry, or sidebar to touch.

**Live documentation to correct:** code comments only, each named in the steps — the shell's file header and class doc (rewritten in step 9), its `DEPTH_CHOICES` / `DEFAULT_DEPTH` / `rootingChanged` comments, `relationDiagram.ts`'s header, and all six panels' header comments (three of which currently state they extend `DiagramView` and have no control column, and three of which describe the shell's column as `Direction / Depth / Deeper`).

**Records to leave alone:** `plans/implemented/diagram-depth-limit-and-expand-indicator.md` names the `Deeper` button and `RootedDiagramShell` throughout — in its design sections, its API sketch, its steps, and its verification log. It records what was built at the time and must not be edited; the same holds for every other file under `plans/implemented/`.

**Not to be touched:** `README.md`, `CHANGELOG.md`, and `TODO.md` never mention the `Deeper` button, the shell, or the diagram control column (`grep -rn 'Deeper\|DiagramShell' README.md CHANGELOG.md TODO.md` finds nothing), and `TODO.md` has no backlog entry for either half of this plan. `CHANGELOG.md` gains its entry at release time, which this plan does not touch.

One in-flight sibling plan, `plans/diagram-edge-merge-junctions.md`, mentions the diagram controls in a manual-verification row; its wording ("the Depth / hide controls still work") already survives this plan. Leave that file alone.

---

## Potential Challenges

- **`noUnusedLocals` turns the orphaned `depthControl` field into a build error.** Removing `stepDepth` removes its only reader, and the app's `tsconfig.json` sets `noUnusedLocals: true`. Step 3 demotes it to a constructor local, which `directionControl` and `pruneControl` already are.
- **The config union must be narrowed before `config.full` or `config.rootCaption` is read.** Read them only inside the `config.fixedRoot ? … : …` expression shown in _Internal Structure_; reading `config.full` unguarded does not compile, which is the point of the union.
- **No overridable method may run during the shell's constructor.** `applyRootVisibility` is private and reads only shell fields; `setRoot` (which calls the `rootingChanged` hook) is never called from the constructor, whose initial root comes from `config` directly. A subclass's fields do not exist until after `super()` returns.
- **`DatabaseDiagramPanel`'s `focusSchema` must call `setRoot` last.** `setRoot` re-derives through `rootingChanged` → `rebuildBase` → `applyFilter`, and `applyFilter` reads `this.mode` and `this.hiddenSchemas`; both must already be set.
- **Wrapping a `DiagramView` in a `Panel` must not leak the ELK worker.** `Component.destructor()` recurses into its children before releasing its own handles, so closing a tab still reaches the nested view's teardown. The three shell panels already rely on this, and `PanelDisposers` stores the panel object and calls `panel.dispose()` itself.
- **The tab's spinner must still wait for the first layout.** `openAsyncPanel` calls `awaitDiagramLayout(content)` ([`SqlAdminController.ts:159`](frontend/src/SqlAdminController.ts#L159)), which duck-types `whenLaidOut`; the shell forwards it to the view, so the three converted panels keep the behaviour they have as bare `DiagramView`s.
- **`(none)` is a reserved key.** A node whose id were literally `(none)` could not be selected, since the sentinel is compared before the lookup. Accepted, and now stated in one place instead of one panel.

---

## Critical Files

- [`frontend/src/dock/rootedDiagramShell.ts`](frontend/src/dock/rootedDiagramShell.ts) — the whole file, since it is being renamed and extended: the config slots, the WEST assembly, the `protected` seam (`view`, `legend`, `getDirection`, `getDepth`, `isPrune`, `rootingChanged`, `pruneChanged`), and the depth vocabulary.
- [`frontend/src/dock/DatabaseDiagramPanel.ts`](frontend/src/dock/DatabaseDiagramPanel.ts) — the root machinery being absorbed and the Mode × root state machine: the combo ([:89](frontend/src/dock/DatabaseDiagramPanel.ts#L89)), the visibility calls ([:116](frontend/src/dock/DatabaseDiagramPanel.ts#L116)), the centre-after-layout listener and its comments ([:153-182](frontend/src/dock/DatabaseDiagramPanel.ts#L153)), the mode handler ([:183-196](frontend/src/dock/DatabaseDiagramPanel.ts#L183)), `applyFilter` ([:216](frontend/src/dock/DatabaseDiagramPanel.ts#L216)), `rebuildBase` ([:240](frontend/src/dock/DatabaseDiagramPanel.ts#L240)), and `focusSchema` ([:260](frontend/src/dock/DatabaseDiagramPanel.ts#L260)).
- [`frontend/src/dock/RootedRelationGraphPanel.ts`](frontend/src/dock/RootedRelationGraphPanel.ts) — the plain pipeline the three new panels mirror ([:89-115](frontend/src/dock/RootedRelationGraphPanel.ts#L89)), and why a fixed root is kept as a `DiagramNodeData`.
- [`frontend/src/dock/RelationDiagramPanel.ts`](frontend/src/dock/RelationDiagramPanel.ts) — the richest subclass: locals before `super()`, the typed config local ([:92](frontend/src/dock/RelationDiagramPanel.ts#L92)), and `attachFkEdgeTooltip(this.view)` ([:133](frontend/src/dock/RelationDiagramPanel.ts#L133)).
- [`frontend/src/data/relationDiagram.ts`](frontend/src/data/relationDiagram.ts) and [`frontend/tests/data/relationDiagram.test.ts`](frontend/tests/data/relationDiagram.test.ts) — `rootedDiagram`'s root-injection behaviour ([:91-107](frontend/src/data/relationDiagram.ts#L91)), `applyHide` ([:122](frontend/src/data/relationDiagram.ts#L122)), `withDepthBadges` ([:244](frontend/src/data/relationDiagram.ts#L244)), and the purity rule in the header.
- The three panels being converted: [`SchemaDiagramPanel.ts`](frontend/src/dock/SchemaDiagramPanel.ts), [`RelationGraphPanel.ts`](frontend/src/dock/RelationGraphPanel.ts), [`RoleGrantsDiagramPanel.ts`](frontend/src/dock/RoleGrantsDiagramPanel.ts).
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — (b) the super-cascade order, (c) arrow-function handler fields, (d) the `callable()` export block.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — the six construction sites that must keep compiling unchanged ([:1537](frontend/src/SqlAdminController.ts#L1537), [:1627](frontend/src/SqlAdminController.ts#L1627), [:1711](frontend/src/SqlAdminController.ts#L1711), [:1809](frontend/src/SqlAdminController.ts#L1809), [:1871](frontend/src/SqlAdminController.ts#L1871), [:2744](frontend/src/SqlAdminController.ts#L2744)) and `awaitDiagramLayout` ([:159](frontend/src/SqlAdminController.ts#L159)).

---

## Non-Goals

- **`ExplainDiagramPanel` stays outside the shell.** It extends `Panel` with its own accordion column, and a query plan has one true root it already opens focused on.
- **No tab-title rewriting.** The fixed-root panels keep their titles because their roots do not change; nothing renames a tab.
- **`DatabaseDiagramPanel`'s Overview mode is not re-modelled.** Overview stays a mode flag with its own graph; it is not expressed as a root value.
- **No accent border, glyph, or other emphasis on the chosen root** in the four selectable panels.
- **No per-node "expand this node's cut neighbours" gesture.** The Depth control is the only way to widen a rooted view.
- **The `+N` badge's own logic is not changed** — `hiddenNeighbourCounts`, `depthBadgeLabel`, and `withDepthBadges` are untouched; the four selectable panels simply route through them, so a rooted view in any of them badges its cut nodes the same way a rooted view does today.
- **No version bump, no `CHANGELOG.md` entry, no publish step.** The coordinated 0.3.0 release is its own step.
- **No library change.** `focusNode`, `zoomToFit`, `whenLaidOut`, `setData`, and `setDisplayed` are used exactly as they already exist.

---

## Notes

[^one-shell]: A separate base class for the selectable-root panels was considered and rejected: `DatabaseDiagramPanel` already implements that pipeline, so a second copy would have to be kept in step with it forever. Absorbing the root into the one shell deletes the copy instead of adding to it. The shell was already the owner of everything else the column agrees on — the depth vocabulary, the prune row, the legend, the Border assembly — so the root is the last piece of shared column state that was still living in a subclass.

[^union]: The alternative was a flat config with `root?: string | null`, `fixedRoot?: boolean`, and `rootCaption?: string`, leaving three combinations that type-check but cannot work: `fixedRoot` with no root (the traversal block would be hidden forever with no way to show it), a selector with no caption, and a fixed root that still builds a selector. The union turns all three into compile errors, which is what "`fixedRoot: true` guarantees the root is non-null" has to mean if it is a guarantee rather than a comment. `full` lives in the selectable variant only, so a fixed-root panel is not asked for a graph the shell would never read.

[^overview-override]: Modelling Overview as "root = null" was tried on paper and breaks: Tables mode with no root is its own state, and it is the state the Overview drill-down lands in — `focusSchema` shows one schema's tables out of the whole database graph, with the per-schema legend the user needs to bring the others back. Collapsing the two would either hide that legend or make Overview show the traversal block. So the shell owns the rule that depends on the root, and the panel keeps one boolean for the orthogonal question of whether it is drawing the rooted graph at all. That is one mechanism called from three places in one panel, down from two public setters called from four places today. The visible consequence of the split is that Tables-with-no-root now hides Direction / Depth / prune instead of showing them; with no root those three controls have nothing to act on — `rebuildBase` ignores direction and depth, and the unrooted `applyFilter` branch ignores prune — so hiding them removes a control that silently did nothing.

[^rename]: The rename costs six import lines and two comment rewrites, all in files this plan already modifies, and no test imports the module. Against that, `RootedDiagramShell` would be the name of a class whose root is null for four of its six subclasses and whose whole point is that the root is optional — a name that has to be explained every time it is read. `DiagramShell` is unqualified on purpose: it is the shell for the app's traversal diagram panels, and its header comment names the six and says `ExplainDiagramPanel` is not one of them.

[^no-pipeline-in-shell]: Moving `full` / `base` / `hidden` into the shell was rejected on a hard constraint, not a preference: TypeScript forbids a subclass from declaring a private field whose name a base class already declares privately, so a shell-owned `base` / `hidden` would force `RelationDiagramPanel`, `RootedRelationGraphPanel`, and `DatabaseDiagramPanel` to rename their own fields — churn in three working panels for no gain, since each of those three derives its base differently (card mode plus coverage styling, a root node that may be absent from the graph, per-schema hiding plus container grouping). Extracting the shared *steps* instead gets the same result without touching them: `rootedBase` also replaces `DatabaseDiagramPanel`'s own root-lookup branching, and `fillLegend` is the legend loop `RelationDiagramPanel` and `RootedRelationGraphPanel` each spell out. What is left per new panel is two one-line hooks and two short arrow fields.

[^whole-graph-list]: Deriving the list from the drawn subgraph would trap the user: once narrowed to one table's neighbourhood, every node outside it would drop out of the list and there would be no way to re-root anywhere else without clearing first. Each panel's graph is fetched once when the tab opens and never replaced, so one derivation in the constructor is both complete and stable. Labels rather than ids because two of the four selectable panels have ids the user has never seen — `role:analyst` and `table:public.orders` in the grants star, `public.v_accounts` in the relation graphs. The duplicate-label fallback exists for the database diagram, whose node labels are bare table names that repeat across schemas while its ids are `schema.table`; without the fallback its dropdown would list `users` twice with no way to tell them apart. `localeCompare` follows `presetStore.ts` and `queryStore.ts`, which sort user-facing names the same way.

[^fit-on-clear]: `setData` does not re-centre: the view's one-shot initial centring is long spent by the time the user clears the root, so the whole graph would return drawn around whatever pan the focused view left behind — off-screen, on a large schema. `zoomToFit` fits and centres the graph bounds, which is what "back to the whole graph" means, and it is what the view's own Fit control does. `resetView` was the other candidate and was rejected: the in-flight `diagram-viewport-focus-and-reset` plan changes `resetView` to re-centre on the view's focus node when that node is in the shown graph, and after clearing the root that node is still in the whole graph — so `resetView` would centre the node the user just stopped caring about. That plan explicitly leaves `zoomToFit` alone, so this call means the same thing before and after it lands, and this plan needs no ordering against it.

[^depth-control-local]: The same rule already applied once in this file. When the shell was first extracted, `directionControl` and `pruneControl` were deliberately left as constructor locals rather than fields, because nothing read them back after construction and `noUnusedLocals` rejects a private field that is only ever written. `depthControl` was a field solely because `stepDepth` read it.

[^no-root-border]: `RootedRelationGraphPanel` borders its root because that root is fixed for the tab's life and comes from outside the panel. In a selectable panel the root is a value the user just set, the graph is narrowed around it, and the viewport is centred on it. Drawing the border would mean re-pointing a node renderer that is built before `super()` and invoked during `DiagramView`'s own construction, so it cannot read `this` — the mutable-local-plus-setter-field dance `RelationDiagramPanel`'s `selectColumn` needs — and it would change how `SchemaDiagramPanel` and `RoleGrantsDiagramPanel` draw nodes, which today they do with the stock renderer.

---

## Implementation Notes

**The constructor's `rootRow`/`rootControl` derivation in _Internal Structure_ does not compile as written; the implementation uses an equivalent `if` block instead.** The plan's sketch builds `rootControl` from one ternary keyed on `config.fixedRoot` (which correctly narrows `config` to `SelectableRoot` inside its `: …` branch, so `config.full` type-checks), then builds `rootRow` from a *second*, independent ternary keyed on `rootControl === null` — and TypeScript cannot carry the first ternary's narrowing of `config` into the second: `config.rootCaption` is rejected with "Property 'rootCaption' does not exist on type 'DiagramShellSlots & FixedRoot'" (TS2339), because from the compiler's standpoint `rootControl`'s nullability says nothing about which arm of the `config` union applies. The implementation (`frontend/src/dock/diagramShell.ts`, constructor) instead declares `rootControl`/`rootRow` as `let`-typed locals initialized to `null` and assigns both inside one `if (!config.fixedRoot) { … }` block, so the single narrowing covers both reads of `config` (`config.full` and `config.rootCaption`) at once. Behaviourally this is identical to the plan's sketch — same fields, same values, same order relative to `super()` — so no design decision changed, only the shape of the type-narrowing.

No other deviations from the plan were needed. Every unit test in `frontend/tests/data/relationDiagram.test.ts` (`rootChoices`, `rootedBase`, `filteredBase`, plus the pre-existing suites) and the plan's verification greps pass as specified.

**Manual walkthrough (`## Expected Behaviour → Manual`), performed against the running app (login `sqladmin`/`sqladmin` on the seeded dev database, driven via chrome-devtools MCP):**

- **Schema diagram** (`public` schema): opened on the whole FK graph with `Root table` reading `(none)`, no traversal block, empty legend. Picked `orders` as root: traversal block appeared (Direction `Both`, Depth `1`, `Hide with prune`, no `Deeper` button), legend rows for `customers`/`orders` appeared with the root's row checked-and-disabled, and the view re-centred on `orders`. Unticking `customers` hid it. Clearing back to `(none)` restored the whole graph, removed the traversal block and legend, and fit the whole graph in view.
- **Database diagram** (whole `sqladmin` database, 171 tables across 6 schemas): opened in Overview with only a `Mode` row — no `Root table` row, no traversal block, no legend. Switching to Tables showed the `Root table` row and the per-schema legend (`hr`/`hub`/`inventory`/`public`/`sales`/`wide`, all checked) with the traversal block correctly absent (no root chosen yet) — the plan's called-out behaviour change confirmed live. Picking `workorders` as root made the traversal block appear, re-rooted and re-centred the view, and kept the per-schema legend. Switching to Overview and back to Tables brought the chosen root and its view back unchanged. Double-clicking the `public` box in Overview drilled into Tables mode with only `public` checked and `Root table` reset to `(none)`.
- **Fixed-root relations tab** (`orders (relations)`, opened via *Show ▸ Relations* on `public.orders`): confirmed no `Root …` row (the tab is titled after its root), Direction/Depth/`Hide with prune`/coverage checkbox with no button between Depth and the prune row, and the card-mode FK diagram rendered correctly.
- **Dependency graph** (`public (dependencies)`, newly selectable via `RelationGraphPanel`): opened on the whole graph with `Root relation` reading `(none)`; picking `customers` showed the traversal block, the legend, and re-centred the view; the dependency edge stayed rendered as a dependency (non-FK) style throughout.
- **Grants graph** (newly selectable via `RoleGrantsDiagramPanel`): opened with `Root node` reading `(none)` for three different roles (`analyst`, `app_service`, `dba`); each rendered correctly through the shell. The seed data grants no roles any direct table privileges, so re-rooting onto an actual granted table could not be exercised live; `rootedBase`/`filteredBase`'s node-narrowing logic is otherwise identical to the already-exercised Schema-diagram and Dependency-graph cases, and is unit-tested independently of any panel.
- Browser console showed no errors beyond the pre-existing `favicon.ico` 404 the `verify` skill already documents as unrelated.

**Not exercised live, and why:** (1) the `+N` cut-neighbour badge's on-screen appearance — the seed data's FK chains in `public`/`hr`/`sales` are all one hop deep, and `hub`'s densely-connected `workorders` table reaches its entire one-hop neighbourhood with nothing cut, so no rooted view in the seed data actually has a cut neighbour to badge. `withDepthBadges` itself is untouched by this plan and already covered by its own pre-existing tests, and `rootedBase`'s new test (case 8, `relationDiagram.test.ts`) asserts its output equals `withDepthBadges(rootedDiagram(...), ...)` directly. (2) The root-selector's ambiguous-label id fallback — every table name in the seed data is unique across schemas, so `rootChoices`'s fallback branch was only exercised through its dedicated unit test (the `rootChoices` describe block's fourth case, mirroring the plan's worked table in `## Architecture Decisions`), not through a live dropdown showing a `schema.table` fallback.
