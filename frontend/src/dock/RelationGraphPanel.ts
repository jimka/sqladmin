// A read-only relation-graph tab, shared by the schema dependency graph and
// the schema inheritance graph (they differ only in which endpoint supplied
// the DiagramData and the ELK layout direction — see buildRelationGraph.ts).
// Extends DiagramView; when rooted (an entry from a single relation), the root
// node is emphasized with the same accent-border idiom RelationDiagramPanel
// uses. Double-clicking a node reports its RelationNodeData back to the
// controller, which routes activation through openReferencedTable.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramView (class-
// first). `nodeRenderer` is built as a local before `super()` — it closes over
// the constructor's `rootId` param and the module `ROOT_BORDER`, not `this` —
// and passed through `super({ data, nodeRenderer })`; the "activate" handler is
// an inline arrow closing over `onSelect`, never handed off by reference, so it
// needs no arrow-function field.

import { DiagramNode, DiagramView }          from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { Component }                    from "@jimka/typescript-ui/core";
import type { RelationNodeData }             from "../data/buildRelationGraph";

// The root node's emphasis: a 2px accent border over the DiagramNode default of
// a 1px border, so the root reads as the anchor of the view (mirrors
// RelationDiagramPanel's ROOT_BORDER).
const ROOT_BORDER = "2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))";

/**
 * The relation-graph panel: a DiagramView over `data`. When `rootId` is given,
 * that node is emphasized with an accent border. Double-clicking a node
 * invokes `onSelect` with that node's RelationNodeData.
 */
export class RelationGraphPanel extends DiagramView {
    /**
     * @param data - The graph model (from buildRelationGraph).
     * @param onSelect - Invoked with the activated node's RelationNodeData.
     * @param rootId - The rooted entry's root node id, if this tab is rooted.
     */
    constructor(data: DiagramData, onSelect: (node: RelationNodeData) => void, rootId?: string) {
        const nodeRenderer = (n: DiagramNodeData): Component => {
            const node = DiagramNode({ label: n.label, glyph: n.glyph });

            if (rootId !== undefined && n.id === rootId) {
                node.setBorder(ROOT_BORDER);
            }

            return node;
        };

        super({ data, nodeRenderer });

        this.on("activate", (n: DiagramNodeData) => onSelect(n.data as RelationNodeData));
    }
}
