// The schema-wide relation graph, serving both the dependency graph and the
// inheritance graph (they differ only in which endpoint supplied the
// DiagramData and the ELK layout direction — see buildRelationGraph.ts).
// Extends DiagramShell (see ./diagramShell.ts) with a selectable root: the
// shell's WEST `Root relation` selector + direction/depth/prune controls +
// legend, over a CENTER DiagramView. Opens on the whole graph with no root
// chosen; picking a root narrows to its direction+depth neighbourhood.
// RootedRelationGraphPanel (./RootedRelationGraphPanel.ts) is this graph's
// fixed-root counterpart, and reuses `relationGraphNodeRenderer` below so a
// rooted and an unrooted relation graph draw nodes identically.
// Double-clicking a node reports its RelationNodeData back to the controller,
// which routes activation through openReferencedTable.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramShell
// directly. `nodeRenderer` is passed through
// `JunctionDiagramView({ data, nodeRenderer })`, built as a local before
// `super()` (it is `super()`'s CENTER child); the "activate" / "contextmenu"
// handlers are inline arrows closing over `onSelect` / `onContextMenu`, never
// handed off by reference, so they need no arrow-function field. `applyFilter`
// and `rebuildBase` are handed to `fillLegend`/invoked from `rootingChanged`,
// so they are arrow-function fields.

import { callable } from "@jimka/typescript-ui/core";
import { DiagramNode }                       from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { Component }                    from "@jimka/typescript-ui/core";
import type { RelationNodeData }             from "../data/buildRelationGraph";
import { rootedBase, filteredBase }          from "../data/relationDiagram";
import { DiagramShell, fillLegend }          from "./diagramShell";
import { JunctionDiagramView }               from "./JunctionDiagramView";

// The root node's emphasis: a 2px accent border over the DiagramNode default of
// a 1px border, so the root reads as the anchor of the view (mirrors
// RelationDiagramPanel's ROOT_BORDER).
const ROOT_BORDER = "2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))";

/**
 * The node renderer both relation-graph panels share: a stock DiagramNode
 * carrying the node's label, glyph, and depth badge, with an accent border on
 * the root.
 *
 * @param rootId - The root node id, or undefined for an unrooted graph.
 * @returns A DiagramView node renderer.
 */
export function relationGraphNodeRenderer(rootId?: string): (n: DiagramNodeData) => Component {
    return (n: DiagramNodeData): Component => {
        const node = DiagramNode({ label: n.label, glyph: n.glyph, badge: n.badge });

        if (rootId !== undefined && n.id === rootId) {
            node.setBorder(ROOT_BORDER);
        }

        return node;
    };
}

/**
 * The relation graph panel: the shell's WEST `Root relation` + direction /
 * depth + prune + legend column plus a CENTER DiagramView. Double-clicking a
 * node invokes `onSelect` with that node's RelationNodeData.
 */
class RelationGraphPanel extends DiagramShell {
    private readonly full: DiagramData;
    private readonly hidden = new Set<string>();
    private base: DiagramData;

    /**
     * @param data - The graph model (from buildRelationGraph).
     * @param onSelect - Invoked with the activated node's RelationNodeData.
     * @param onContextMenu - Invoked with a right-clicked node's
     *   RelationNodeData and the originating event.
     */
    constructor(data: DiagramData, onSelect: (node: RelationNodeData) => void,
                onContextMenu?: (node: RelationNodeData, event: MouseEvent) => void) {
        // Local before super() — it is super()'s CENTER child (`this` is
        // unavailable until super() returns).
        const view = JunctionDiagramView({ data, nodeRenderer: relationGraphNodeRenderer() });

        super({ view, full: data, rootCaption: "Root relation" });

        this.full = data;
        this.base = data;

        this.view.on("activate", (n: DiagramNodeData) => onSelect(n.data as RelationNodeData));

        this.view.on("contextmenu", (n: DiagramNodeData, event: MouseEvent) => {
            onContextMenu?.(n.data as RelationNodeData, event);
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

const RelationGraphPanelCallable = callable(RelationGraphPanel);
type RelationGraphPanelCallable = RelationGraphPanel;
export { RelationGraphPanelCallable as RelationGraphPanel };
