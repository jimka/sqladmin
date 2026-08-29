// The schema-wide relation graph, serving both the dependency graph and the
// inheritance graph (they differ only in which endpoint supplied the
// DiagramData and the ELK layout direction — see buildRelationGraph.ts).
// Extends FilteredDiagramShell (see ./filteredDiagramShell.ts) with a
// selectable root: the shell's WEST `Root relation` selector +
// direction/depth/prune controls + legend, over a CENTER DiagramView. Opens
// on the whole graph with no root chosen; picking a root narrows to its
// direction+depth neighbourhood. RootedRelationGraphPanel
// (./RootedRelationGraphPanel.ts) is this graph's fixed-root counterpart, and
// reuses `relationGraphNodeRenderer` below so a rooted and an unrooted
// relation graph draw nodes identically. Double-clicking a node reports its
// RelationNodeData back to the controller, which routes activation through
// openReferencedTable.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends
// FilteredDiagramShell directly, which owns the whole derive/legend/filter
// lifecycle. `nodeRenderer` is passed through
// `JunctionDiagramView({ data, nodeRenderer })`, built as a local before
// `super()` (it is `super()`'s CENTER child); the "activate" / "contextmenu"
// handlers are inline arrows closing over `onSelect` / `onContextMenu`, never
// handed off by reference, so they need no arrow-function field.

import { callable } from "@jimka/typescript-ui/core";
import { DiagramNode }                       from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { Component }                    from "@jimka/typescript-ui/core";
import type { RelationNodeData }             from "../data/buildRelationGraph";
import { FilteredDiagramShell }              from "./filteredDiagramShell";
import { JunctionDiagramView }               from "./JunctionDiagramView";
import { ROOT_FRAME }                        from "../theme";

// The shared root frame (theme.ts's ROOT_FRAME), applied here as a border;
// TableCardNode applies the same value as an outline so it takes no layout
// space.

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
            node.setBorder(ROOT_FRAME);
        }

        return node;
    };
}

/**
 * The relation graph panel: the shell's WEST `Root relation` + direction /
 * depth + prune + legend column plus a CENTER DiagramView. Double-clicking a
 * node invokes `onSelect` with that node's RelationNodeData.
 */
class RelationGraphPanel extends FilteredDiagramShell {
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

        this.view.on("activate", (n: DiagramNodeData) => onSelect(n.data as RelationNodeData));

        this.view.on("contextmenu", (n: DiagramNodeData, event: MouseEvent) => {
            onContextMenu?.(n.data as RelationNodeData, event);
        });
    }
}

const RelationGraphPanelCallable = callable(RelationGraphPanel);
type RelationGraphPanelCallable = RelationGraphPanel;
export { RelationGraphPanelCallable as RelationGraphPanel };
