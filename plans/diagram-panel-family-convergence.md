---
touches-shared:
  - frontend/src/dock/diagramShell.ts
  - frontend/src/dock/DatabaseDiagramPanel.ts
  - frontend/src/dock/RelationDiagramPanel.ts
  - frontend/src/dock/RelationGraphPanel.ts
  - frontend/src/dock/RootedRelationGraphPanel.ts
  - frontend/src/dock/SchemaDiagramPanel.ts
  - frontend/src/dock/RoleGrantsDiagramPanel.ts
  - frontend/src/data/buildDatabaseDiagram.ts
  - frontend/src/data/buildRelationGraph.ts
  - frontend/src/data/buildRoleGrantsDiagram.ts
  - frontend/src/data/buildRoleMembershipDiagram.ts
  - frontend/src/data/relationDiagram.ts
  - frontend/src/data/schemaOverviewDiagram.ts
  - frontend/src/data/fkEdgeTooltip.ts
  - frontend/src/SqlAdminController.ts
---

# Diagram Panel Family Convergence — Implementation Plan

## Overview

Six diagram panels extend `DiagramShell` ([frontend/src/dock/diagramShell.ts:184](frontend/src/dock/diagramShell.ts#L184)), and five of them re-implement the same three-method body: hold the whole graph, re-derive a rooted `base` from it, refill a per-node legend, push a filtered graph into the view. `SchemaDiagramPanel`, `RelationGraphPanel`, and `RoleGrantsDiagramPanel` carry that body byte-identically ([SchemaDiagramPanel.ts:37-91](frontend/src/dock/SchemaDiagramPanel.ts#L37), [RelationGraphPanel.ts:63-112](frontend/src/dock/RelationGraphPanel.ts#L63), [RoleGrantsDiagramPanel.ts:47-108](frontend/src/dock/RoleGrantsDiagramPanel.ts#L47)); `RelationDiagramPanel` and `RootedRelationGraphPanel` carry a second near-identical pair ([RelationDiagramPanel.ts:154-207](frontend/src/dock/RelationDiagramPanel.ts#L154), [RootedRelationGraphPanel.ts:93-118](frontend/src/dock/RootedRelationGraphPanel.ts#L93)). That duplication has already shipped a live leak: a fix that disposes legend rows instead of detaching them landed in four copies and missed the fifth, so [RootedRelationGraphPanel.ts:98](frontend/src/dock/RootedRelationGraphPanel.ts#L98) still calls `removeAllComponents()` and orphans a `Checkbox`+`Text` pair per node on every Direction or Depth change.

This plan pulls that shared body into one intermediate class, `FilteredDiagramShell`, so there is exactly one copy of the derive/legend/filter lifecycle for all five panels. Alongside it, three more defects in the same family are fixed: the four flat diagram builders that never adopted `uniformNodeWidth` and so still stagger their columns ([uniformNodeWidth.ts:51-59](frontend/src/data/uniformNodeWidth.ts#L51)); the role-membership graph, opened through the foreign-key panel and so showing an FK checkbox it can never use ([SqlAdminController.ts:3234](frontend/src/SqlAdminController.ts#L3234)); and `settleViewport`'s blindness to `DatabaseDiagramPanel`'s Overview mode, which leaves the overview at the wrong zoom ([diagramShell.ts:452-465](frontend/src/dock/diagramShell.ts#L452), [DatabaseDiagramPanel.ts:14-18](frontend/src/dock/DatabaseDiagramPanel.ts#L14)).

The shell's root/direction/depth/prune state moves into a DOM-free `DiagramShellState` module so it can be unit-tested under the project's node-environment vitest, which cannot load `diagramShell.ts` itself. `SqlAdminController`'s four dependency/inheritance open methods ([:2088-2324](frontend/src/SqlAdminController.ts#L2088)) collapse onto shared private helpers; four dead exports go, and five stale comments are corrected.

---

## Architecture Decisions

### One intermediate class owns the derive/legend/filter lifecycle

A new `FilteredDiagramShell` sits between `DiagramShell` and the five node-legend panels. It owns `full`, `base`, `hidden`, the legend refill, and the `rootingChanged`/`pruneChanged` hooks; each leaf panel keeps only its view construction, its listeners, and whatever it genuinely adds. This mirrors [`treeExplorerView.ts:63`](frontend/src/shell/treeExplorerView.ts#L63), which converged the Database and Roles sidebar rails into one config-bag base with ~20-line subclasses such as [`RolesExplorerView.ts:14-30`](frontend/src/shell/RolesExplorerView.ts#L14).[^one-base]

### `DatabaseDiagramPanel` keeps extending `DiagramShell` directly

Its legend is per-schema, not per-node, its hide set holds schema names, and its filter is gated on the Overview/Tables mode — so it shares the shell's controls but none of the lifecycle `FilteredDiagramShell` owns.[^database-stays]

### The overridable seams are prototype methods; one arrow field carries the by-reference handoff

`applyFilter()` and `filteredGraph()` are `protected` prototype methods on `FilteredDiagramShell`. The single reference handed to a legend row is a `private readonly refilter` arrow field that calls `this.applyFilter()`.[^arrow-vs-method]

### The role-membership graph gets its own thin fixed-root panel

A new `RoleMembershipDiagramPanel` extends `FilteredDiagramShell` with the plain node renderer the relation graphs use and a role-name activation callback. `SqlAdminController.openRoleMembershipDiagram` opens it instead of `RelationDiagramPanel`.[^membership-panel]

### The four flat builders take an optional measurer, exactly like `buildSchemaDiagram`

`buildDatabaseDiagram`, `buildRelationGraph`, `buildRoleGrantsDiagram`, and `buildRoleMembershipDiagram` each gain a trailing `measureWidths?: MeasureWidths` parameter, call `uniformNodeWidth` over their node labels, and stamp the one width on every node — the shape [`buildSchemaDiagram.ts:109-130`](frontend/src/data/buildSchemaDiagram.ts#L109) already uses. The builders stay pure; the DOM-backed measurer is injected by the caller.[^measurer-injection]

### `settleViewport` decides from the *effective* root, not the raw root

The shell already tracks `rootingDisplayed`, the flag `DatabaseDiagramPanel` clears in Overview mode. `settleViewport` now fits the whole graph whenever no rooted graph is on screen, and focuses the root only when one is.[^effective-root]

### The shell's state machine moves to a DOM-free module

`DiagramShellState` in `frontend/src/dock/diagramShellState.ts` holds root, direction, depth choice, prune, and `rootingDisplayed`, and answers the two questions the shell asks of them: which column blocks are on screen, and what the viewport should do. `DiagramShell` keeps the widgets and delegates. The pattern is [`depthChoices.ts:1-7`](frontend/src/dock/depthChoices.ts#L1) and [`recordNavigation.ts:1-19`](frontend/src/dock/recordNavigation.ts#L1), both split out of a DOM-touching module for this exact reason.[^state-split]

### The controller's four graph openers collapse onto one descriptor and two helpers

A `RelationGraphKind` record names everything the dependency and inheritance paths differ by; `openSchemaRelationGraph` and `openRootedRelationGraph` carry the two remaining bodies, and `relationGraphHandlers(ref)` supplies the activate/context-menu arrow pair all four share.[^two-helpers]

---

## Public API

### `frontend/src/dock/diagramShellState.ts` (new)

```ts
/** What the viewport should do once the layout pass lands. */
export type ViewportSettle =
    | { kind: "fit" }
    | { kind: "focus"; nodeId: string };

/** Which of the shell's three WEST column blocks are on screen. */
export interface ColumnVisibility {
    rootRow: boolean;
    legend: boolean;
    rootedBlock: boolean;
}

/** Whether two settles name the same viewport move. */
export function sameSettle(a: ViewportSettle, b: ViewportSettle): boolean;

/** The DOM-free root / direction / depth / prune state a DiagramShell drives its controls from. */
export class DiagramShellState {
    constructor(root: string | null, initialDepth?: string);

    getRoot(): string | null;
    setRoot(root: string | null): void;

    getDirection(): TraversalDirection;
    setDirection(direction: TraversalDirection): void;

    /** The `DEPTH_CHOICES` entry the Depth control shows. */
    getDepthChoice(): string;
    /** Normalized through `depthChoice`, so an unrecognized value falls to the default. */
    setDepthChoice(choice: string): void;
    /** The hop limit that choice means (`Number.POSITIVE_INFINITY` for `All`). */
    getDepth(): number;

    isPrune(): boolean;
    setPrune(prune: boolean): void;

    isRootingDisplayed(): boolean;
    setRootingDisplayed(displayed: boolean): void;

    visibility(): ColumnVisibility;
    settle(): ViewportSettle;
}
```

Backing fields: `root: string | null`, `direction: TraversalDirection` (seeded `"both"`), `depth: string` (a `DEPTH_CHOICES` entry, seeded `depthChoice(initialDepth)`), `prune: boolean` (seeded `false`), `rootingDisplayed: boolean` (seeded `true`).

### `frontend/src/dock/filteredDiagramShell.ts` (new)

```ts
/** A filtered panel whose root never changes. */
export interface FixedRootGraph {
    fixedRoot: true;
    /** The root's own node data: its id roots the traversal, and the node itself is
     *  injected into the base when `full` carries no node with that id. */
    rootNode: DiagramNodeData;
}

/** A filtered panel the user may re-root from a `Root …` row. */
export interface SelectableRootGraph {
    fixedRoot?: false;
    /** The selector row's caption, naming what this panel's nodes are ("Root table"). */
    rootCaption: string;
    /** The root to open at; omitted or null opens on the whole graph. */
    root?: string | null;
}

export type FilteredDiagramConfig =
    DiagramShellSlots & { full: DiagramData } & (FixedRootGraph | SelectableRootGraph);

declare class FilteredDiagramShell extends DiagramShell {
    /** The whole graph every derivation starts from. */
    protected readonly full: DiagramData;
    /** Node ids the legend has hidden; cleared on every base rebuild. */
    protected readonly hidden: Set<string>;
    /** The direction+depth-rooted graph the filter runs over. */
    protected base: DiagramData;

    constructor(config: FilteredDiagramConfig);

    protected rootingChanged(): void;   // → rebuildBase()
    protected pruneChanged(): void;     // → applyFilter()

    /** Re-derive the base for the current root/direction/depth, refill the legend, redraw. */
    protected rebuildBase(): void;
    /** Push the current filtered graph into the view. */
    protected applyFilter(): void;
    /** The graph to draw for the current root / hidden / prune / direction state. */
    protected filteredGraph(): DiagramData;
}

export { FilteredDiagramShellCallable as FilteredDiagramShell };
```

`legendRow` moves here from `diagramShell.ts` and becomes module-private. `fillLegend` is deleted; its body becomes the private `rebuildLegend()`.

### `frontend/src/data/relationDiagram.ts`

```ts
/**
 * The base graph for a panel whose root is fixed: the badged direction+depth
 * neighbourhood of `root`, with `root` injected when `full` carries no node
 * with its id. Pure.
 */
export function fixedRootBase(
    full: DiagramData,
    root: DiagramNodeData,
    direction: TraversalDirection,
    depth: number,
): DiagramData;
```

### Builder signatures

```ts
export function buildDatabaseDiagram(schemas: SchemaTables[], measureWidths?: MeasureWidths): DiagramData;
export function buildRelationGraph(edges: RelationEdge[], homeSchema: string,
                                   layoutOptions: Record<string, string>, dashed?: boolean,
                                   measureWidths?: MeasureWidths): DiagramData;
export function buildRoleGrantsDiagram(role: string, privileges: RolePrivilege[],
                                       measureWidths?: MeasureWidths): DiagramData;
export function buildRoleMembershipDiagram(details: RoleDetail[], measureWidths?: MeasureWidths): DiagramData;
```

### `frontend/src/dock/RoleMembershipDiagramPanel.ts` (new)

```ts
declare class RoleMembershipDiagramPanel extends FilteredDiagramShell {
    /**
     * @param full - The whole role-membership DAG (from buildRoleMembershipDiagram).
     * @param root - The rooted role's node data (id = the role name).
     * @param onSelectRole - Invoked with an activated node's role name.
     * @param initialDepth - The `DEPTH_CHOICES` entry the Depth control opens at.
     */
    constructor(full: DiagramData, root: DiagramNodeData,
                onSelectRole: (role: string) => void, initialDepth?: string);
}

export { RoleMembershipDiagramPanelCallable as RoleMembershipDiagramPanel };
```

### `SqlAdminController` private members

```ts
/** What the dependency and inheritance graph paths differ by. */
interface RelationGraphKind {
    /** Route key, title suffix, and status-line word. */
    key: "dependencies" | "inheritance";
    /** The tab glyph. */
    glyph: string;
    /** The whole schema's graph, or null after the failure was already reported. */
    fetch: (ref: DbObjectRef) => Promise<DiagramData | null>;
    /** The schema-wide tab's panel id. */
    schemaPanelId: (ref: DbObjectRef) => string;
    /** The relation-rooted tab's panel id. */
    relationPanelId: (ref: DbObjectRef) => string;
}

private graphKind(key: "dependencies" | "inheritance"): RelationGraphKind;
private relationGraphHandlers(ref: DbObjectRef): {
    onSelect: (node: RelationNodeData) => void;
    onContextMenu: (node: RelationNodeData, event: MouseEvent) => void;
};
private async openSchemaRelationGraph(ref: DbObjectRef, kind: RelationGraphKind): Promise<void>;
private async openRootedRelationGraph(ref: DbObjectRef, kind: RelationGraphKind, depth?: string): Promise<void>;
```

The four public methods keep their existing signatures and become one-line delegations.

### Exports removed (no `export` keyword; the declarations stay)

`ROOT_NONE` ([diagramShell.ts:42](frontend/src/dock/diagramShell.ts#L42)), `GrantEdgeData` ([buildRoleGrantsDiagram.ts:33](frontend/src/data/buildRoleGrantsDiagram.ts#L33)), `MembershipEdgeData` ([buildRoleMembershipDiagram.ts:25](frontend/src/data/buildRoleMembershipDiagram.ts#L25)), `SchemaOverviewEdgeData` ([schemaOverviewDiagram.ts:12](frontend/src/data/schemaOverviewDiagram.ts#L12)). Each stays in place because its own module still reads it in a `satisfies` clause; only the `export` keyword goes.

---

## Internal Structure

### `DiagramShellState`'s two derived answers

```ts
visibility(): ColumnVisibility {
    return {
        rootRow    : this.rootingDisplayed,
        legend     : this.rootingDisplayed,
        rootedBlock: this.rootingDisplayed && this.root !== null,
    };
}

settle(): ViewportSettle {
    return this.rootingDisplayed && this.root !== null
        ? { kind: "focus", nodeId: this.root }
        : { kind: "fit" };
}
```

```ts
export function sameSettle(a: ViewportSettle, b: ViewportSettle): boolean {
    if (a.kind === "fit" || b.kind === "fit") {
        return a.kind === b.kind;
    }

    return a.nodeId === b.nodeId;
}
```

### `DiagramShell.settleViewport` after the change

```ts
protected settleViewport(): void {
    const target = this.state.settle();

    void this.view.whenLaidOut().then(() => {
        if (!sameSettle(this.state.settle(), target)) {
            return;   // a control moved again while the layout ran
        }

        if (target.kind === "fit") {
            this.view.zoomToFit();
        } else {
            this.view.focusNode(target.nodeId);
        }
    });
}
```

### `FilteredDiagramShell`'s body

Module-level, above the class:

```ts
/** Translates a filtered config into the plain shell config `DiagramShell` takes. */
function shellConfig(config: FilteredDiagramConfig): DiagramShellConfig {
    const slots: DiagramShellSlots = {
        view          : config.view,
        headerControls: config.headerControls,
        rootedControls: config.rootedControls,
        extraControls : config.extraControls,
        initialDepth  : config.initialDepth,
    };

    return config.fixedRoot
        ? { ...slots, fixedRoot: true, root: config.rootNode.id }
        : { ...slots, full: config.full, rootCaption: config.rootCaption, root: config.root };
}
```

The class itself:

```ts
/** The fixed root's node data, or null for a selectable-root panel. */
private readonly rootNode: DiagramNodeData | null;

constructor(config: FilteredDiagramConfig) {
    super(shellConfig(config));

    this.full     = config.full;
    this.rootNode = config.fixedRoot ? config.rootNode : null;
    this.base     = this.derivedBase();

    this.rebuildLegend();
}

// Private, so no subclass override can run against half-initialized subclass fields.
private derivedBase(): DiagramData {
    return this.rootNode !== null
        ? fixedRootBase(this.full, this.rootNode, this.getDirection(), this.getDepth())
        : rootedBase(this.full, this.getRoot(), this.getDirection(), this.getDepth());
}

private rebuildLegend(): void {
    this.legend.disposeAllComponents();   // dispose, not detach: a detached row leaks its listeners

    const rootId = this.getRoot();

    if (rootId === null) {
        return;   // an unrooted view draws the whole graph and has nothing to hide against
    }

    for (const n of this.base.nodes) {
        this.legend.addComponent(legendRow(n, rootId, this.hidden, this.refilter));
    }
}

protected rebuildBase(): void {
    this.base = this.derivedBase();
    this.hidden.clear();
    this.rebuildLegend();
    this.applyFilter();
}

protected applyFilter(): void {
    this.view.setData(this.filteredGraph());
}

protected filteredGraph(): DiagramData {
    return filteredBase(this.base, this.getRoot(), this.hidden, this.isPrune(), this.getDirection());
}

// Handed to legend rows by reference, so it MUST be an arrow field; it dispatches
// through this.applyFilter() so a subclass override is honoured however late that
// subclass's own fields initialize.
private readonly refilter = (): void => {
    this.applyFilter();
};
```

### `RelationDiagramPanel`'s two remaining differences

```ts
protected applyFilter(): void {
    // The nodeRenderer repopulates `cards` as setData rebuilds every node below —
    // cleared first so a card this filter change removes cannot linger as a stale entry.
    this.cards.clear();

    this.view.setData(applyCoverageStyle(this.filteredGraph(), this.showCoverage));
}
```

It keeps `showCoverage`, `cards`, and `selectColumn`; its `full`, `root`, `hidden`, `base`, `rootingChanged`, `pruneChanged`, `rebuildLegend`, and `rebuildBase` members are all deleted.

---

## Ordered Implementation Steps

1. **Create `frontend/src/dock/diagramShellState.ts`** with `ViewportSettle`, `ColumnVisibility`, `sameSettle`, and `DiagramShellState` exactly as `## Public API` and `## Internal Structure` give them. Its only imports are `depthChoice` / `depthFromChoice` from `./depthChoices` and the type-only `TraversalDirection` from `../data/relationDiagram`; both modules are already DOM-free. Header comment: state why this module is DOM-free too, pointing at `depthChoices.ts`'s own header.

2. **Create `frontend/tests/dock/diagramShellState.test.ts`** covering every case in `## Expected Behaviour`'s state-machine tables. Run `npx vitest run tests/dock/diagramShellState.test.ts` from `frontend/` — expect green.

3. **Rewrite `diagramShell.ts`'s state handling.** Delete the `rootId`, `rootingDisplayed`, `direction`, `depthIndex`, and `prune` fields and add `private readonly state: DiagramShellState;`. Assign it in the constructor body as `new DiagramShellState(initialRoot, config.initialDepth)` **before** the existing `applyRootVisibility()` call, which now reads it. Point `getRoot`, `setRoot`, `setRootingDisplayed`, `getDirection`, `getDepth`, and `isPrune` at it; the three control listeners call `state.setDirection` / `state.setDepthChoice` / `state.setPrune`. Rewrite `applyRootVisibility` to read `state.visibility()` and `settleViewport` to the body in `## Internal Structure`. Delete the `DEPTH_CHOICES.indexOf` assignment and its explanatory comment, and narrow the `./depthChoices` import to `DEPTH_CHOICES` and `depthChoice` — `DEFAULT_DEPTH` and `depthFromChoice` have no reader left and `noUnusedLocals` will reject them. Check: `grep -n 'depthIndex\|this\.rootId\|DEFAULT_DEPTH' frontend/src/dock/diagramShell.ts` — expect zero matches.

4. **Un-export `ROOT_NONE`** in the same file (remove the `export` keyword only) and **rewrite the constructor's `settleViewport` comment** ([:315-328](frontend/src/dock/diagramShell.ts#L315)) per `## Documentation Impact`. Check: `grep -rn 'ROOT_NONE' frontend/src frontend/tests` — expect matches only inside `diagramShell.ts`.

5. **Add `fixedRootBase` to `frontend/src/data/relationDiagram.ts`**, placed next to `rootedBase`, and add its cases to `frontend/tests/data/relationDiagram.test.ts`. Run the file — expect green.

6. **Create `frontend/src/dock/filteredDiagramShell.ts`**: a module-private `legendRow`, copied verbatim from `diagramShell.ts` minus its `export`; then `FixedRootGraph`, `SelectableRootGraph`, `FilteredDiagramConfig`, the module-private `shellConfig`, and the `FilteredDiagramShell` class, exported through `callable()` per COMPONENT_CONVENTIONS (d). Leave `diagramShell.ts`'s own `legendRow`/`fillLegend` in place for now — step 8 deletes them once nothing imports them.

7. **Convert the five panels to `extends FilteredDiagramShell`**, one file at a time, running `npm run typecheck` after each. Each panel keeps its view construction, its `activate` / `contextmenu` / `selection` listeners, and any `attachFkEdgeTooltip` or glyph registration it already has; what goes is the lifecycle:
   - `SchemaDiagramPanel.ts`: delete `full`, `hidden`, `base`, `rootingChanged`, `pruneChanged`, `applyFilter`, `rebuildBase`; `super({ view, full: data, rootCaption: "Root table" })`.
   - `RelationGraphPanel.ts`: same deletions; `super({ view, full: data, rootCaption: "Root relation" })`.
   - `RoleGrantsDiagramPanel.ts`: same deletions, keeping the pre-`super()` `roleNodeId` lookup and the view's `initialFocusNode`; `super({ view, full: data, rootCaption: "Root node" })`.
   - `RootedRelationGraphPanel.ts`: delete `full`, `root`, `hidden`, `base`, both hooks, `applyFilter`, `rebuildLegend`, `rebuildBase`, and the post-`super()` `rebuildLegend()` call; seed the view with `fixedRootBase(full, root, "both", depthFromChoice(depth))`; `super({ view, full, fixedRoot: true, rootNode: root, initialDepth: depth })`.
   - `RelationDiagramPanel.ts`: the same deletions, keeping `showCoverage`, `cards`, `selectColumn`, and adding the `applyFilter` override from `## Internal Structure`; seed the view with `fixedRootBase(...)` in place of the inline `withDepthBadges(rootedDiagram(...))`.

   Rewrite each file's header comment: the class-first paragraphs that describe `applyFilter`/`rebuildBase` as arrow fields are wrong once those members are gone.

8. **Delete `fillLegend` and `legendRow` from `diagramShell.ts`** along with their now-unused `DiagramNodeData` type import. Check: `grep -rn 'fillLegend' frontend/src frontend/tests` — expect zero matches; `npm run typecheck`.

9. **Create `frontend/src/dock/RoleMembershipDiagramPanel.ts`** per `## Public API`: `Glyph.register(user)` at module scope (mirroring [RoleGrantsDiagramPanel.ts:37](frontend/src/dock/RoleGrantsDiagramPanel.ts#L37)), a `JunctionDiagramView` with `relationGraphNodeRenderer(root.id)` and `initialFocusNode: root.id`, and one `activate` listener calling `onSelectRole(n.id)`. No context-menu listener, no coverage control, no `attachFkEdgeTooltip`.

10. **Point `SqlAdminController.openRoleMembershipDiagram` at it** ([:3234](frontend/src/SqlAdminController.ts#L3234)): `return RoleMembershipDiagramPanel(full, root, roleName => void this.showRoleProperties(roleName), depth);`. Swap the import. Then **delete the role-membership sentence from `RelationDiagramPanel`'s `onContextMenu` JSDoc** ([:62-64](frontend/src/dock/RelationDiagramPanel.ts#L62)) and from `TableCardNode.ts`'s header ([:13-14](frontend/src/dock/TableCardNode.ts#L13)), which both name a reuse that no longer exists. Check: `grep -rn 'membership' frontend/src/dock/RelationDiagramPanel.ts frontend/src/dock/TableCardNode.ts` — expect zero matches.

11. **Adopt `uniformNodeWidth` in `buildDatabaseDiagram.ts`.** Add the trailing `measureWidths?: MeasureWidths` parameter, compute `const nodeWidth = uniformNodeWidth(everyLabel, measureWidths)` over every leaf's bare table name, and set `width: nodeWidth` on each leaf node. Extend `frontend/tests/data/buildDatabaseDiagram.test.ts` first with the cases in `## Expected Behaviour`.

12. **Repeat for `buildRelationGraph.ts`, `buildRoleGrantsDiagram.ts`, and `buildRoleMembershipDiagram.ts`**, each with its own test additions. In `buildRelationGraph` the nodes are collected in a `Map` first, so stamp the width in a final pass over `nodes.values()` using `n.label ?? n.id` as the measured label; in `buildRoleGrantsDiagram` stamp it in a final pass over the pushed `nodes` array, measuring the role name and every `schema.table` label.

13. **Inject the measurer at the five call sites.** In `SqlAdminController`: `fetchDependencyGraph` and `fetchInheritanceGraph` pass `Util.measureTextWidths` as `buildRelationGraph`'s fifth argument; `openRoleGrantsDiagram` and `openRoleMembershipDiagram` pass it as their builders' second. In `DatabaseDiagramPanel.ts`, import `Util` from `@jimka/typescript-ui/core` and call `buildDatabaseDiagram(schemas, Util.measureTextWidths)`.

14. **Extract the controller's graph-open helpers.** Add the `RelationGraphKind` interface, `graphKind`, `relationGraphHandlers`, `openSchemaRelationGraph`, and `openRootedRelationGraph` next to the existing `fetchDependencyGraph`/`fetchInheritanceGraph`, then reduce `openSchemaDependencyGraph`, `openSchemaInheritanceGraph`, `openRelationDependencyGraph`, and `openRelationInheritanceGraph` to one-line delegations that keep their current JSDoc. Preserve every literal exactly: glyphs `share-nodes` / `sitemap`, titles `${ref.schema} (${key})` and `${ref.name} (${key})`, the relation-rooted `tooltip: this.panelTooltip(ref)` and `{ path, query: depth ? { depth } : undefined }` route, and the two status-message forms. Check: `grep -c 'RelationGraphPanel(' frontend/src/SqlAdminController.ts` and `grep -c 'RootedRelationGraphPanel(' frontend/src/SqlAdminController.ts` — one construction site each (plus the import line for each name).

15. **Un-export the three edge-data interfaces** in `buildRoleGrantsDiagram.ts`, `buildRoleMembershipDiagram.ts`, and `schemaOverviewDiagram.ts`. Check: `grep -rn 'GrantEdgeData\|MembershipEdgeData\|SchemaOverviewEdgeData' frontend/src frontend/tests` — every match is inside the declaring file.

16. **Fix the two remaining stale comments**: `RelationGraphPanel.ts:34` and `fkEdgeTooltip.ts:113-125`, per `## Documentation Impact`.

17. **Add the COMPONENT_CONVENTIONS note** described in `## Documentation Impact`.

18. **Run `## Verification` end to end.**

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/diagramShellState.ts` |
| Create | `frontend/src/dock/filteredDiagramShell.ts` |
| Create | `frontend/src/dock/RoleMembershipDiagramPanel.ts` |
| Create | `frontend/tests/dock/diagramShellState.test.ts` |
| Modify | `frontend/src/dock/diagramShell.ts` |
| Modify | `frontend/src/dock/SchemaDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` |
| Modify | `frontend/src/dock/RoleGrantsDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/dock/RootedRelationGraphPanel.ts` |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` |
| Modify | `frontend/src/dock/TableCardNode.ts` |
| Modify | `frontend/src/data/relationDiagram.ts` |
| Modify | `frontend/src/data/buildDatabaseDiagram.ts` |
| Modify | `frontend/src/data/buildRelationGraph.ts` |
| Modify | `frontend/src/data/buildRoleGrantsDiagram.ts` |
| Modify | `frontend/src/data/buildRoleMembershipDiagram.ts` |
| Modify | `frontend/src/data/schemaOverviewDiagram.ts` |
| Modify | `frontend/src/data/fkEdgeTooltip.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/tests/data/relationDiagram.test.ts` |
| Modify | `frontend/tests/data/buildDatabaseDiagram.test.ts` |
| Modify | `frontend/tests/data/buildRelationGraph.test.ts` |
| Modify | `frontend/tests/data/buildRoleGrantsDiagram.test.ts` |
| Modify | `frontend/tests/data/buildRoleMembershipDiagram.test.ts` |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |

No file is deleted.

---

## Expected Behaviour

### `DiagramShellState.settle()` — unit-testable

| `rootingDisplayed` | root | `settle()` | What the shell does once the layout lands |
|---|---|---|---|
| true | `"public.invoices"` | `{ kind: "focus", nodeId: "public.invoices" }` | `focusNode("public.invoices")` |
| true | `null` | `{ kind: "fit" }` | `zoomToFit()` |
| false | `"public.invoices"` | `{ kind: "fit" }` | `zoomToFit()` — the Overview case that is wrong today |
| false | `null` | `{ kind: "fit" }` | `zoomToFit()` |

### `DiagramShellState.visibility()` — unit-testable

| `rootingDisplayed` | root | `rootRow` | `legend` | `rootedBlock` |
|---|---|---|---|---|
| true | `null` | true | true | false |
| true | `"orders"` | true | true | true |
| false | `"orders"` | false | false | false |
| false | `null` | false | false | false |

### `sameSettle` — unit-testable

| a | b | result |
|---|---|---|
| `{fit}` | `{fit}` | true |
| `{fit}` | `{focus,"a"}` | false |
| `{focus,"a"}` | `{focus,"a"}` | true |
| `{focus,"a"}` | `{focus,"b"}` | false |

### `DiagramShellState` seeding and mutation — unit-testable

- A state built with `initialDepth` omitted reports `getDepthChoice() === "1"` and `getDepth() === 1`.
- Built with `"all"`, it reports `"All"` and `Number.POSITIVE_INFINITY`.
- Built with `"9"`, it falls back to `"1"` — `setDepthChoice("9")` does the same.
- A fresh state reports `getDirection() === "both"`, `isPrune() === false`, `isRootingDisplayed() === true`.
- `setRoot(null)` on a rooted state flips `visibility().rootedBlock` to false and leaves `rootRow`/`legend` true.

### `fixedRootBase` — unit-testable

- For a root present in `full`, it equals `withDepthBadges(rootedDiagram(full, root, direction, depth), full.edges, direction)`.
- For a root absent from `full` (a view with no foreign keys), the result's nodes contain the root and nothing else at depth 1.

### The four builders' node widths — unit-testable

| Builder | Labels measured | Nodes given the width |
|---|---|---|
| `buildDatabaseDiagram` | every leaf's bare table name | every leaf node (`groupBySchema` adds containers later; those get none) |
| `buildRelationGraph` | each node's label — the bare `name` in the home schema, `schema.name` otherwise | every node |
| `buildRoleGrantsDiagram` | the role name plus every `schema.table` label | the role node and every table node |
| `buildRoleMembershipDiagram` | every role name | every node |

For each builder: every node reports the same `width`; that width equals `uniformNodeWidth(labels)` computed over the same labels; a graph with no nodes produces no nodes and throws nothing; passing a stub measurer changes the width to what the stub implies. `buildDatabaseDiagram`'s edge folding, `buildRelationGraph`'s dedupe and dashed-edge flag, and the two role builders' node/edge shapes are unchanged by the addition — assert one existing case per builder still passes.

### Manual verification (the diagram surfaces have no automatable harness)

- **Legend disposal.** Open a table's *Dependencies* tab, change Depth 1 → 2 → 3 → All → 1 several times, then re-check component/listener counts in the About dialog's Debug overlay. Counts must return to their level after the first render, not climb once per node per change.
- **Overview zoom.** Open a database diagram, switch Mode to Tables, pick a root table, switch Mode back to Overview. The overview must arrive fitted to the viewport, not at the table graph's zoom.
- **Membership graph.** Open a role's membership graph from the Roles rail. There must be no "Highlight FKs without a covering index" checkbox, nodes must render as plain glyph-and-label nodes (not table cards), and hovering an edge must show no foreign-key tooltip. Double-clicking a role node must still show that role in the inspector.
- **Column alignment.** Open a database diagram in Tables mode, a schema's Dependency graph, a schema's Inheritance graph, a role's grants graph, and a role's membership graph. Each layer's nodes must share a left and right edge, as the schema diagram's already do.
- **Every panel still drives.** For each of the six panels, exercise Root (where present), Direction, Depth, prune, and legend checkboxes; the graph must re-derive and the viewport re-centre exactly as before.
- **The four graph tabs.** Open a schema's Dependency graph, a schema's Inheritance graph, a relation's Dependencies, and a relation's Inheritance from the navigator context menu. Titles, glyphs, tooltips, status-bar messages, address-bar routes (including `?depth=`), and node double-click behaviour must be unchanged; re-opening each must focus the existing tab rather than duplicating it.

---

## Verification

From `frontend/`:

1. `npm run typecheck` — clean.
2. `npm test` — all suites green, including the new `tests/dock/diagramShellState.test.ts` and the extended builder suites.
3. `npm run build` — clean.
4. Dead-export greps, each expected to match only inside the declaring module:
   - `grep -rn 'ROOT_NONE' src tests`
   - `grep -rn 'GrantEdgeData\|MembershipEdgeData\|SchemaOverviewEdgeData' src tests`
5. Convergence greps:
   - `grep -rn 'fillLegend' src tests` — zero matches.
   - `grep -n 'removeAllComponents' src/dock/RootedRelationGraphPanel.ts src/dock/filteredDiagramShell.ts` — zero matches (the remaining app-wide uses in `StartPage.ts` and `QueryResultView.ts` are unrelated and stay).
   - `grep -rn 'rebuildBase\|rebuildLegend' src/dock` — matches only in `filteredDiagramShell.ts` and `DatabaseDiagramPanel.ts`.
6. Stale-comment greps: `grep -rn 'ROOT_BORDER' src` matches only `RelationGraphPanel.ts`'s own constant and its corrected comment; `grep -rn 'no notion of this shell' src` — zero matches; `grep -n 'two rendered lines' src/data/fkEdgeTooltip.ts` — zero matches (`singleEdgeDetail`'s own mention of a removed coverage line at `:74` is correct and stays).
7. The manual checks listed above, driven through the running app (`.claude/skills/verify`). Entry points: the navigator's schema and relation context menus, the database node's "Open database diagram", and the Roles rail's "Show grants graph" / membership items.

---

## Documentation Impact

This is app-internal; no public API and no docs site is involved. The in-repo comments that change:

- **`diagramShell.ts`'s constructor comment on the deferred `settleViewport()`** ([:315-328](frontend/src/dock/diagramShell.ts#L315)) claims "the library has no notion of this shell's root". It does: every fixed-root panel passes `initialFocusNode: root.id`, so the view already opens centred on the root. Rewrite it to say what the call is actually for — a shell that opens with a root the view was *not* told about, which the `SelectableRoot` config permits — and keep the existing paragraph explaining why it is deferred to the view's first connected+sized layout.
- **`RelationGraphPanel.ts:34`** cites "RelationDiagramPanel's `ROOT_BORDER`", which does not exist. The counterpart is [`TableCardNode.ts:40`](frontend/src/dock/TableCardNode.ts#L40)'s `ROOT_OUTLINE`, deliberately an outline rather than a border so it takes no layout space. Restate the comment against that.
- **`fkEdgeTooltip.ts:113-125`**'s `capDetailLines` rationale says a block "may itself span two rendered lines (its header plus a coverage line)". Coverage lines were removed — the same file's [`singleEdgeDetail`](frontend/src/data/fkEdgeTooltip.ts#L74) and `multiEdgeSummary` both say so, and every block `multiEdgeSummary` passes in is one line. Rewrite the JSDoc to state that, and to say the loop counts rendered lines so the budget still holds if a block ever grows; leave the loop itself alone.
- **`RelationDiagramPanel.ts`'s `onContextMenu` JSDoc** and **`TableCardNode.ts`'s header** each name the role-membership graph as a consumer. After step 10 it is not one; delete those clauses.

One addition to **`frontend/COMPONENT_CONVENTIONS.md`**, section (c): a paragraph recording that a member a subclass is meant to *override* must be a plain prototype method, not an arrow-function field — a subclass's arrow field initializes after the base constructor has already handed the base's arrow out by reference, so the override is silently missed. Where such a member also needs a by-reference handoff, the base keeps one arrow field that dispatches through the overridable method, and cite `FilteredDiagramShell`'s `refilter`/`applyFilter` pair as the worked example.

---

## Potential Challenges

- **`FilteredDiagramShell`'s constructor runs before any subclass field exists.** It must never call `applyFilter()` or any other overridable member. Mitigation: the constructor calls only the *private* `derivedBase()` and `rebuildLegend()`, and `## Internal Structure` marks `derivedBase` private for exactly this reason.
- **The fixed-root panels derive their base twice at construction** — once as a pre-`super()` local to seed the view's `data`, once inside `FilteredDiagramShell`. Mitigation: both calls go through the same pure `fixedRootBase`, so they cannot disagree; the cost is one extra bounded BFS at open time.
- **A root injected by `rootedDiagram` carries no `width`.** When a fixed root is absent from `full` (a view with no dependencies, a role with no memberships), the controller's hand-built root node is the only node drawn, so the missing uniform width has nothing to misalign against. Do not add a width to those literals.
- **`initialFocusNode` and `settleViewport` both move the viewport on first layout.** They agree today (both target the root) and step 4 only rewrites the comment, not the call. Do not remove the call as part of the comment fix.
- **`buildRoleMembershipDiagram`'s `ROLE_GLYPH` is only rendered once the plain node renderer is in play.** `TableCardNode` ignored `glyph`; `DiagramNode` does not. Mitigation: step 9's module-scope `Glyph.register(user)`, mirroring `RoleGrantsDiagramPanel`.
- **`noUnusedLocals` is on.** Removing `export` from a type that its own module still uses in a `satisfies` clause is safe; removing one that is genuinely unread is a typecheck error. Step 15's grep is the check.

---

## Critical Files

| File | Why |
|---|---|
| [`frontend/src/shell/treeExplorerView.ts`](frontend/src/shell/treeExplorerView.ts) + [`RolesExplorerView.ts`](frontend/src/shell/RolesExplorerView.ts) | The precedent this plan's base/subclass split mirrors: a config-bag base plus thin subclasses that only fix the config. |
| [`frontend/src/dock/diagramShell.ts`](frontend/src/dock/diagramShell.ts) | The existing base: the control column, the root/depth/prune state being extracted, and `settleViewport`. |
| [`frontend/src/dock/depthChoices.ts`](frontend/src/dock/depthChoices.ts) + [`recordNavigation.ts`](frontend/src/dock/recordNavigation.ts) | The DOM-free-split pattern `diagramShellState.ts` follows, with the reasoning in their headers. |
| [`frontend/src/data/relationDiagram.ts`](frontend/src/data/relationDiagram.ts) | Every graph derivation the converged base calls (`rootedBase`, `filteredBase`, `rootedDiagram`, `applyHide`, `withDepthBadges`). |
| [`frontend/src/data/buildSchemaDiagram.ts`](frontend/src/data/buildSchemaDiagram.ts) | The `uniformNodeWidth` adoption the four other builders copy, including the measurer-injection contract. |
| [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) | The super-cascade rule (b), the arrow-field rule (c), and the callable-class export (d) every touched panel follows. |
| [`frontend/src/dock/DatabaseDiagramPanel.ts`](frontend/src/dock/DatabaseDiagramPanel.ts) | The one panel that stays on `DiagramShell`, and the only caller of `setRootingDisplayed` — the flag the viewport fix reads. |

---

## Non-Goals

- **Converging `DatabaseDiagramPanel` onto `FilteredDiagramShell`.** Its legend, hide set, and filter are per-schema and mode-gated; it would inherit an unused `hidden` set and a wrong `rebuildLegend`.
- **Touching `ExplainDiagramPanel`.** It extends `Panel`, not the shell — a query plan has one true root and its own accordion column.
- **Moving `relationGraphNodeRenderer` out of `RelationGraphPanel.ts`.** Two other panels now import it from there, which `RootedRelationGraphPanel` already did; a relocation is churn this plan does not need, and the constant's stale comment is fixed in place.
- **Simplifying `capDetailLines`' per-block line arithmetic.** The comment is wrong; the loop is correct for any block count and changing it would move tooltip behaviour for no user-visible gain.
- **The other diagram open methods' activate / context-menu arrow pairs** in `SqlAdminController` (`openSchemaDiagram`, `openDatabaseDiagram`, `openRelationDiagram`, `openRoleGrantsDiagram`). Their callbacks take `(table)` or `(schema, table)`, not `RelationNodeData`, so `relationGraphHandlers` cannot serve them.
- **Splitting `SqlAdminController.ts`.** A separate plan owns that; this one changes only the four dependency/inheritance open methods, their two fetch helpers' call sites, and `openRoleMembershipDiagram`.
- **The remaining audit findings** — the DDL row-grid leak, the error-banner triplication, the API-URL encoding gap, and every backend item. Different subsystems, separate passes.
- **A `CHANGELOG.md` entry or a version bump.** Releases are the user's own step.

---

## Notes

[^one-base]: A single base for all five panels, rather than one per family, is what makes the missed-fix class of bug impossible: with a per-family base there would still be two copies of `rebuildLegend`, and the legend-dispose fix could still land in one of them. The two families differ in exactly one respect — how the base graph is derived — and that difference is a single `rootNode !== null` branch inside `derivedBase()`, chosen once at construction from the config union. Both arms call the helpers that exist and are already unit-tested today (`rootedBase` for a selectable root, `fixedRootBase` for a fixed one), so no derivation semantics change. `plans/implemented/diagram-shell-optional-root.md:64` declined this extraction on the grounds that "the bodies are one call each"; that was true of two copies and is not true of five.

[^database-stays]: `DatabaseDiagramPanel.applyFilter` returns early outside Tables mode, filters on a set of *schema names* read off each leaf's `data`, and ends in `groupBySchema`; its `rebuildLegend` emits one row per schema, not per node; and its `rebuildBase` deliberately neither clears the hide set nor refills the legend, because a root change must not undo the user's per-schema hiding. Inheriting `FilteredDiagramShell` would give it an unused `hidden` set and a `rebuildLegend` it would have to override to something unrelated — more coupling than the two `rootedBase` calls it shares.

[^arrow-vs-method]: COMPONENT_CONVENTIONS (c) requires an arrow field for anything registered by reference, because a plain method loses `this`. An overridable member has the opposite requirement: a subclass's arrow field initializes only after the base constructor has returned, so a base constructor that hands `this.applyFilter` out by reference would capture the *base* arrow and silently ignore the override. The pair resolves both: `refilter` is the arrow the legend rows hold, and it dispatches through `this.applyFilter()`, which virtual dispatch resolves at call time. `RelationDiagramPanel`'s coverage checkbox already calls through an inline arrow, so no other handoff site exists.

[^membership-panel]: The alternative — a constructor flag on `RelationDiagramPanel` gating the coverage checkbox and the FK tooltip — was rejected. It would leave the membership graph rendering roles as fixed-width table cards through `TableCardNode`, still running `applyCoverageStyle` over edges that carry no FK data, and would add a mode flag to the one panel in the family that has real per-node state. The thin subclass is about thirty lines once `FilteredDiagramShell` exists, and it also lets the membership graph show its `user` glyph, which `TableCardNode` never rendered. Reusing `RootedRelationGraphPanel` unchanged was rejected too: its callbacks are typed `(node: RelationNodeData)` and read `n.data`, which a membership node does not carry — widening them to `DiagramNodeData` would push a cast into the controller and leave the two relation-graph panels with mismatched callback shapes.

[^measurer-injection]: `uniformNodeWidth` estimates from label length when no measurer is given, so the builders stay pure and node-testable; the real `Util.measureTextWidths` is DOM-backed and must be injected by a module allowed to touch the DOM. Three of the four new call sites are already in `SqlAdminController`, matching `buildSchemaGraphData`'s existing comment. The fourth, `buildDatabaseDiagram`, is called from inside `DatabaseDiagramPanel`'s constructor because the panel takes `SchemaTables[]`, not a built graph; the panel is a UI module and may import `Util` directly. Moving the build into the controller instead would change the panel's constructor signature for no benefit.

[^effective-root]: `rootingDisplayed` is already exactly the "is a rooted graph on screen" flag: `DatabaseDiagramPanel` clears it when entering Overview and sets it when entering Tables, and its own header calls Overview "not the rooted table graph at all". Reading it in `settle()` makes the viewport follow the graph actually drawn. Comparing the whole `ViewportSettle` after the layout pass — rather than the raw root id, as today — also aborts correctly when the mode flips mid-layout, which the current check misses.

[^state-split]: `diagramShell.ts` imports `Panel`, `ComboBox`, `Checkbox`, and `Text` at module scope; those touch `document` on import, and `vitest.config.ts` runs `environment: "node"`, so no test can load the module at all. That is why the root/depth/prune machine has never had a test, and why the Overview zoom bug shipped. `depthChoices.ts` was split out of the same file for the same reason and its header says so; `recordNavigation.ts` was split out of `TableWorkPanel.ts`. Keeping the state as a small class rather than free functions preserves `DiagramShell`'s existing accessor signatures exactly, so no subclass changes.

[^two-helpers]: The four methods split into two shapes, not one: the schema-wide pair builds a `RelationGraphPanel` with no tooltip, no depth query, and a node-count status line; the relation-rooted pair builds a `RootedRelationGraphPanel` with a tooltip, a `?depth=` route query, a hand-built root node, and a different status line. Folding both into a single body would need four conditionals and would read worse than the two it replaces. What all four genuinely share — the `openReferencedTable` / `diagramContextMenu` arrow pair, written out verbatim once per method — becomes the one shared helper, `relationGraphHandlers`. `graphKind` carries the dependency-versus-inheritance differences (glyph, route key, fetch, both panel-id builders) so neither helper branches on the kind itself.
