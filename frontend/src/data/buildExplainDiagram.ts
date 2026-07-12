// Pure assembly of an EXPLAIN plan's node/edge graph for DiagramView: one node
// per plan node (id === ExplainPlanNode.id), one edge per parent→child link. No
// DOM, no ELK — layout runs lazily inside DiagramView itself. Imports only the
// DiagramData *type* and the parsed model, so the app's node-only vitest can
// red-green it without pulling in UI-bundle side effects (mirrors
// buildSchemaDiagram's purity note).

import type { DiagramData, DiagramNodeData, DiagramEdgeData } from "@jimka/typescript-ui/component/diagram";
import type { ExplainPlanNode } from "./parseExplainPlan";

// Top-down layered layout: the root plan node sits above the inputs it consumes,
// matching how the text plan reads (parent first, indented children below).
const LAYOUT_OPTIONS: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
};

// The registered glyph name for a plan node. A string literal (not imported from
// a glyph module) to keep this builder free of UI-bundle imports, exactly as
// buildSchemaDiagram keeps TABLE_GLYPH inline; QueryPanel registers "sitemap".
const NODE_GLYPH = "sitemap";

/**
 * Build the DiagramView graph for a parsed plan forest: one node per plan node
 * (id === {@link ExplainPlanNode.id}), one edge per parent→child link. Top-down
 * layered so the root plan node sits above its inputs, like the text plan.
 *
 * @param roots - The parsed plan roots (from `parseExplainPlan`).
 *
 * @returns Nodes + edges + DOWN-layered layout options for DiagramView.
 */
export function buildExplainDiagram(roots: ExplainPlanNode[]): DiagramData {
    const nodes: DiagramNodeData[] = [];
    const edges: DiagramEdgeData[] = [];

    const walk = (node: ExplainPlanNode): void => {
        nodes.push({ id: node.id, label: diagramLabel(node), glyph: NODE_GLYPH });

        for (const child of node.children) {
            edges.push({ id: `${node.id}->${child.id}`, source: node.id, target: child.id });
            walk(child);
        }
    };

    for (const root of roots) {
        walk(root);
    }

    return { nodes, edges, layoutOptions: LAYOUT_OPTIONS };
}

/**
 * The single-line node caption: the plan node's heading, plus its first metric
 * inline when present, so the default single-line DiagramNode still reads
 * usefully (a full metrics table would need a custom renderer — a Non-Goal).
 *
 * @param node - The plan node.
 *
 * @returns The diagram node label.
 */
function diagramLabel(node: ExplainPlanNode): string {
    const first = node.metrics[0];

    return first ? `${node.label} · ${first.label} ${first.value}` : node.label;
}
