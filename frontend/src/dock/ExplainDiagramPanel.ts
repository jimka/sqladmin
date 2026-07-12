// A read-only Dock panel pairing a structural plan Tree (WEST) with the plan
// DiagramView (CENTER), opened from QueryPanel's "Explain diagram" button. The
// two views are correlated by node id (ExplainPlanNode.id === DiagramNodeData.id
// === the id carried on each TreeNode.data): selecting a tree row selects and
// scrolls the matching diagram node into the viewport (the feature's hard
// requirement), and selecting a diagram node highlights and scrolls its tree
// row. Neither programmatic selectNode emits, so the two directions never feed
// back into each other — only genuine user clicks drive a cross-selection.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends Panel directly (a
// Border-layout Panel, like RelationDiagramPanel). The Tree and DiagramView are
// built as locals before super() (they are super()'s children — the
// super-cascade trap) and their "selection" listeners are wired after super()
// via .on(...), capturing the locals directly; the handlers close over the
// sibling view and the id→TreeNode map rather than instance fields. No disposer
// is registered — Tree and DiagramView need no explicit teardown (SchemaDiagram/
// RelationDiagram panels are likewise opened without a _panelDisposers entry).

import { Panel }             from "@jimka/typescript-ui/core";
import { Border }            from "@jimka/typescript-ui/layout";
import { Placement }         from "@jimka/typescript-ui/primitive";
import { Tree }              from "@jimka/typescript-ui/component/tree";
import type { TreeNode }     from "@jimka/typescript-ui/component/tree";
import { DiagramView }       from "@jimka/typescript-ui/component/diagram";
import type { DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { buildExplainDiagram } from "../data/buildExplainDiagram";
import { ExplainNode }         from "./ExplainNode";
import type { ExplainPlanNode } from "../data/parseExplainPlan";

// Fixed width of the WEST plan tree: fits a node-type heading plus indentation
// without stealing canvas width from the diagram (mirrors RelationDiagramPanel's
// LEGEND_WIDTH rationale).
const TREE_WIDTH = 300;

/**
 * A read-only Dock panel pairing a structural plan Tree (WEST) with the plan
 * DiagramView (CENTER). Tree selection selects + reveals the diagram node;
 * diagram selection selects + reveals the tree row. Class-first: extends Panel.
 */
export class ExplainDiagramPanel extends Panel {
    /**
     * @param roots - The parsed plan roots (from `parseExplainPlan`).
     */
    constructor(roots: ExplainPlanNode[]) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns).
        const data         = buildExplainDiagram(roots);
        const treeNodeById = new Map<string, TreeNode>();
        const tree         = new Tree();

        tree.setNodes(toTreeNodes(roots, treeNodeById));
        // Flatten the whole plan so every row is visible — and so tree.selectNode
        // (which no-ops under a collapsed ancestor) can reach any node on a
        // diagram→tree reverse selection.
        tree.expandAll();

        // Custom node renderer: each node is a metric card (costs, rows, actual
        // timings, group key, batches, memory) heat-tinted by its plan share.
        const diagram = new DiagramView({ data, nodeRenderer: (n: DiagramNodeData) => new ExplainNode(n) });

        const west = Panel({
            layoutManager: new Border(),
            preferredSize: { width: TREE_WIDTH, height: 0 },
            minSize      : { width: TREE_WIDTH, height: 0 },
            components   : [{ component: tree, constraints: { placement: Placement.CENTER } }],
        });

        super({
            layoutManager: new Border(),
            components   : [
                { component: west,    constraints: { placement: Placement.WEST } },
                { component: diagram, constraints: { placement: Placement.CENTER } },
            ],
        });

        // Tree → diagram: select + scroll the matching node into the diagram
        // viewport (the hard requirement). The id lives on the TreeNode's data.
        tree.on("selection", (nodes: TreeNode[]) => {
            const id = nodes[0]?.data;

            if (typeof id === "string") {
                diagram.selectNode(id).revealNode(id);
            }
        });

        // Diagram → tree: highlight + scroll the row. tree.selectNode also scrolls
        // it into view, and expandAll above guarantees the row is in the flattened
        // (visible) set so the select never no-ops.
        diagram.on("selection", (selection: DiagramNodeData[]) => {
            const picked   = selection[0];
            const treeNode = picked ? treeNodeById.get(picked.id) : undefined;

            if (treeNode) {
                tree.selectNode(treeNode);
            }
        });
    }
}

/**
 * Map a parsed plan forest to the library Tree's node model, recording each
 * built TreeNode in `byId` under its plan-node id so a diagram→tree selection
 * can look it up. Each TreeNode carries the plan node's id as its opaque `data`
 * payload (the tree→diagram correlation key) and its heading as the label.
 *
 * @param roots - The plan nodes at this level.
 * @param byId - Accumulates id → TreeNode for reverse selection.
 *
 * @returns The TreeNode array for these roots.
 */
function toTreeNodes(roots: ExplainPlanNode[], byId: Map<string, TreeNode>): TreeNode[] {
    return roots.map((node) => {
        const treeNode: TreeNode = {
            label   : node.label,
            data    : node.id,
            children: node.children.length > 0 ? toTreeNodes(node.children, byId) : undefined,
        };

        byId.set(node.id, treeNode);

        return treeNode;
    });
}
