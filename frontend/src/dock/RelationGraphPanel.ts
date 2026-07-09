// A read-only relation-graph tab, shared by the schema dependency graph and
// the schema inheritance graph (they differ only in which endpoint supplied
// the DiagramData and the ELK layout direction — see buildRelationGraph.ts).
// Wraps a DiagramView; when rooted (an entry from a single relation), the root
// node is emphasized with the same accent-border idiom RelationDiagramPanel
// uses. Double-clicking a node reports its RelationNodeData back to the
// controller, which routes activation through openReferencedTable.

import { DiagramNode, DiagramView }          from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { Component }                    from "@jimka/typescript-ui/core";
import type { RelationNodeData }             from "../data/buildRelationGraph";

// The root node's emphasis: a 2px accent border over the DiagramNode default of
// a 1px border, so the root reads as the anchor of the view (mirrors
// RelationDiagramPanel's ROOT_BORDER).
const ROOT_BORDER = "2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))";

/**
 * Build the relation-graph panel: a DiagramView over `data`. When `rootId` is
 * given, that node is emphasized with an accent border. Double-clicking a node
 * invokes `onSelect` with that node's RelationNodeData.
 *
 * @param data - The graph model (from buildRelationGraph).
 * @param onSelect - Invoked with the activated node's RelationNodeData.
 * @param rootId - The rooted entry's root node id, if this tab is rooted.
 * @returns A DiagramView Component to host as the tab content.
 */
export function RelationGraphPanel(
    data: DiagramData,
    onSelect: (node: RelationNodeData) => void,
    rootId?: string,
): Component {
    const nodeRenderer = (n: DiagramNodeData): Component => {
        const node = DiagramNode({ label: n.label, glyph: n.glyph });

        if (rootId !== undefined && n.id === rootId) {
            node.setBorder(ROOT_BORDER);
        }

        return node;
    };

    const view = DiagramView({ data, nodeRenderer });

    view.on("activate", (n: DiagramNodeData) => onSelect(n.data as RelationNodeData));

    return view;
}
