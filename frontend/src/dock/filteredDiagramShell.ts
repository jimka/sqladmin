// The shared derive/legend/filter lifecycle for the five DiagramShell panels
// whose legend is one row per node: a whole graph (`full`), a direction+depth
// derived `base`, a `hidden` node-id set the legend rows mutate, and the
// filter that turns `base` + `hidden` + prune into what the view draws.
// SchemaDiagramPanel, RelationGraphPanel, RoleGrantsDiagramPanel,
// RelationDiagramPanel, and RootedRelationGraphPanel all extend this instead
// of DiagramShell directly — see plans/implemented/diagram-panel-family-convergence.md
// for the convergence rationale. DatabaseDiagramPanel does NOT: its legend is
// per-schema, not per-node, and its filter is gated on Tables mode, so it
// stays on DiagramShell directly (see that plan's `## Architecture Decisions`).
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramShell
// directly. `applyFilter()` and `filteredGraph()` are plain protected
// prototype methods, not arrow fields, precisely so a subclass CAN override
// them (COMPONENT_CONVENTIONS (c): a subclass's own arrow field would
// initialize only after this base constructor has already run and handed an
// arrow out by reference, silently missing the override — see (c)'s note on
// this trap). The one reference a legend row needs by-reference IS an arrow
// field (`refilter`), and it dispatches through `this.applyFilter()` so
// virtual dispatch still reaches whatever a subclass installed.

import { Component, callable } from "@jimka/typescript-ui/core";
import { HBox } from "@jimka/typescript-ui/layout";
import { Checkbox, Text } from "@jimka/typescript-ui/component/input";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { rootedBase, filteredBase, fixedRootBase } from "../data/relationDiagram";
import { DiagramShell } from "./diagramShell";
import type { DiagramShellConfig, DiagramShellSlots } from "./diagramShell";

/**
 * One legend row: a checkbox (checked = shown) beside the node's name. Toggling
 * it off adds the node id to `hidden`; on removes it; then re-filters. The root
 * row is disabled and pinned checked — hiding the root is meaningless.
 *
 * @param n - The node this row represents.
 * @param rootId - The root node id (its row is locked shown).
 * @param hidden - The shared hidden-id set this row mutates.
 * @param applyFilter - Re-filters the view after a toggle.
 * @returns The row component.
 */
function legendRow(
    n: DiagramNodeData,
    rootId: string,
    hidden: Set<string>,
    applyFilter: () => void,
): Component {
    const isRoot = n.id === rootId;

    const checkbox = Checkbox({
        value: !hidden.has(n.id),
        listeners: {
            change: (v: boolean) => {
                if (v) {
                    hidden.delete(n.id);
                } else {
                    hidden.add(n.id);
                }

                applyFilter();
            },
        },
    });

    if (isRoot) {
        checkbox.setValue(true);
        checkbox.setEnabled(false);
    }

    return new Component({
        layoutManager: new HBox({ spacing: 4 }),
        components   : [checkbox, new Text(n.label ?? n.id)],
    });
}

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

/** What a leaf panel hands `FilteredDiagramShell` to assemble. */
export type FilteredDiagramConfig =
    DiagramShellSlots & { full: DiagramData } & (FixedRootGraph | SelectableRootGraph);

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

/**
 * The shared derive/legend/filter lifecycle for a DiagramShell panel whose
 * legend is one row per node: owns `full`, `base`, `hidden`, the legend
 * refill, and the `rootingChanged`/`pruneChanged` hooks. A leaf panel keeps
 * only its view construction, its own listeners, and whatever it genuinely
 * adds — see `RelationDiagramPanel`'s `applyFilter` override for the one
 * leaf that still needs its own filter step (clearing `cards` before
 * `setData`, and folding in the coverage style).
 */
class FilteredDiagramShell extends DiagramShell {
    /** The whole graph every derivation starts from. */
    protected readonly full: DiagramData;
    /** Node ids the legend has hidden; cleared on every base rebuild. */
    protected readonly hidden = new Set<string>();
    /** The direction+depth-rooted graph the filter runs over. */
    protected base: DiagramData;

    /** The fixed root's node data, or null for a selectable-root panel. */
    private readonly rootNode: DiagramNodeData | null;

    /** @param config - The whole graph, the root mode, and the shell's slots. */
    constructor(config: FilteredDiagramConfig) {
        super(shellConfig(config));

        this.full     = config.full;
        this.rootNode = config.fixedRoot ? config.rootNode : null;
        this.base     = this.derivedBase();

        this.rebuildLegend();
    }

    protected rootingChanged(): void {
        this.rebuildBase();
    }

    protected pruneChanged(): void {
        this.applyFilter();
    }

    /**
     * Re-derive the base for the current root/direction/depth, refill the
     * legend, redraw.
     */
    protected rebuildBase(): void {
        this.base = this.derivedBase();
        this.hidden.clear();
        this.rebuildLegend();
        this.applyFilter();
    }

    /** Push the current filtered graph into the view. */
    protected applyFilter(): void {
        this.view.setData(this.filteredGraph());
    }

    /** The graph to draw for the current root / hidden / prune / direction state. */
    protected filteredGraph(): DiagramData {
        return filteredBase(this.base, this.getRoot(), this.hidden, this.isPrune(), this.getDirection());
    }

    // Private, so no subclass override can run against half-initialized
    // subclass fields — called from this constructor before any subclass
    // field exists (see COMPONENT_CONVENTIONS (b), the super-cascade trap).
    private derivedBase(): DiagramData {
        return this.rootNode !== null
            ? fixedRootBase(this.full, this.rootNode, this.getDirection(), this.getDepth())
            : rootedBase(this.full, this.getRoot(), this.getDirection(), this.getDepth());
    }

    private rebuildLegend(): void {
        this.legend.disposeAllComponents(); // dispose, not detach: a detached row leaks its listeners

        const rootId = this.getRoot();

        if (rootId === null) {
            return; // an unrooted view draws the whole graph and has nothing to hide against
        }

        for (const n of this.base.nodes) {
            this.legend.addComponent(legendRow(n, rootId, this.hidden, this.refilter));
        }
    }

    // Handed to legend rows by reference, so it MUST be an arrow field; it
    // dispatches through this.applyFilter() so a subclass override is
    // honoured however late that subclass's own fields initialize.
    private readonly refilter = (): void => {
        this.applyFilter();
    };
}

const FilteredDiagramShellCallable = callable(FilteredDiagramShell);
type FilteredDiagramShellCallable = FilteredDiagramShell;
export { FilteredDiagramShellCallable as FilteredDiagramShell };
