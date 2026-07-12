// Pure assembly of an EXPLAIN plan's node/edge graph for DiagramView: one node
// per plan node (id === ExplainPlanNode.id), one edge per parent→child link,
// each diagram node carrying the parsed plan node plus two plan-relative visual
// intensities (heat, memShare) the ExplainNode renderer paints. No DOM, no ELK —
// layout runs lazily inside DiagramView. Imports only the DiagramData *type* and
// the parsed model, so the app's node-only vitest can red-green it without
// pulling in UI-bundle side effects (mirrors buildSchemaDiagram's purity note).

import type { DiagramData, DiagramNodeData, DiagramEdgeData } from "@jimka/typescript-ui/component/diagram";
import type { ExplainPlanNode } from "./parseExplainPlan";
import { formatRowCount } from "./explainFormat";

// Top-down layered layout: the root plan node sits above the inputs it consumes,
// matching how the text plan reads (parent first, indented children below). The
// between-layers spacing is widened past ELK's ~20px default so the row-count
// label sitting mid-edge has clear vertical room between two cards.
const LAYOUT_OPTIONS: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.layered.spacing.nodeNodeBetweenLayers": "50",
};

/**
 * The per-node payload a diagram node carries (as `DiagramNodeData.data`),
 * consumed by the ExplainNode renderer.
 */
export interface ExplainNodeData {
    /** The parsed plan node this diagram node represents. */
    plan: ExplainPlanNode;
    /**
     * 0..1 heat: this node's self-cost (or self-time when analyzed) as a share of
     * the hottest node in the plan, for the node's background tint.
     */
    heat: number;
    /**
     * 0..1 memory share: this node's peak working memory relative to the plan's
     * max, for the node's memory bar. 0 when the node (or plan) reports none.
     */
    memShare: number;
}

/**
 * Build the DiagramView graph for a parsed plan forest: one node per plan node
 * (id === {@link ExplainPlanNode.id}), one edge per parent→child link, each node
 * carrying its {@link ExplainNodeData}. Top-down layered so the root sits above
 * its inputs, like the text plan. Each edge is labelled with the actual rows the
 * child produces (they flow up the edge to the parent) when analyzed; the planner
 * estimate lives on the card's "expected rows" row instead.
 *
 * @param roots - The parsed plan roots (from `parseExplainPlan`).
 *
 * @returns Nodes (with `data`) + edges (labelled) + DOWN-layered layout options.
 */
export function buildExplainDiagram(roots: ExplainPlanNode[]): DiagramData {
    const visuals = computeNodeVisuals(roots);

    const nodes: DiagramNodeData[] = [];
    const edges: DiagramEdgeData[] = [];

    const walk = (node: ExplainPlanNode): void => {
        const visual = visuals.get(node.id) ?? { heat: 0, memShare: 0 };

        nodes.push({
            id   : node.id,
            label: node.label,
            data : { plan: node, heat: visual.heat, memShare: visual.memShare },
        });

        for (const child of node.children) {
            const edge: DiagramEdgeData = { id: `${node.id}->${child.id}`, source: node.id, target: child.id };
            const label = producedRowsLabel(child);

            // Rows flow from the child up to the parent, so the arrow points at the
            // parent. The edge runs parent(source)→child(target) to keep ELK's
            // parent-on-top layering, so the arrowhead goes on the *source* end
            // (startMarker, auto-reversed to point up) rather than the child end.
            edge.style = label !== undefined ? { startMarker: "arrow", label } : { startMarker: "arrow" };

            edges.push(edge);
            walk(child);
        }
    };

    for (const root of roots) {
        walk(root);
    }

    return { nodes, edges, layoutOptions: LAYOUT_OPTIONS };
}

/**
 * The edge label for the rows a node actually produces (which flow up to its
 * parent): the actual total, rows × loops, when analyzed. `undefined` for a plain
 * (non-analyze) plan — there the estimate lives on the card's "expected rows" row.
 *
 * @param node - The child plan node the edge points to.
 *
 * @returns The compact actual-rows label, or `undefined`.
 */
function producedRowsLabel(node: ExplainPlanNode): string | undefined {
    if (node.actualRows !== undefined) {
        return formatRowCount(node.actualRows * (node.actualLoops ?? 1));
    }

    return undefined;
}

/** A node's plan-relative visual intensities, keyed by node id. */
interface NodeVisual {
    heat: number;
    memShare: number;
}

/**
 * Compute each node's heat (self-cost/self-time share of the hottest node) and
 * memShare (peak memory relative to the plan max). A plan is "analyzed" when any
 * node reports an actual total time; heat then uses self-*time*, otherwise
 * self-*cost*. Self value = the node's own cumulative value minus its children's,
 * clamped at zero — the standard hot-spot heuristic (Postgres costs and times are
 * cumulative through the subtree).
 *
 * @param roots - The plan roots.
 *
 * @returns A map of node id → { heat, memShare }, both 0..1.
 */
function computeNodeVisuals(roots: ExplainPlanNode[]): Map<string, NodeVisual> {
    const analyzed  = someNode(roots, n => n.actualTotalTime !== undefined);
    const selfById  = new Map<string, number>();
    const memById   = new Map<string, number>();

    const measure = (node: ExplainPlanNode): void => {
        const own      = analyzed ? cumulativeTime(node) : (node.totalCost ?? 0);
        const children = node.children.reduce(
            (sum, c) => sum + (analyzed ? cumulativeTime(c) : (c.totalCost ?? 0)), 0);

        selfById.set(node.id, Math.max(0, own - children));
        memById.set(node.id, node.peakMemoryUsage ?? 0);

        for (const child of node.children) {
            measure(child);
        }
    };

    for (const root of roots) {
        measure(root);
    }

    const maxSelf = Math.max(0, ...selfById.values());
    const maxMem  = Math.max(0, ...memById.values());

    const visuals = new Map<string, NodeVisual>();

    for (const id of selfById.keys()) {
        visuals.set(id, {
            heat    : maxSelf > 0 ? (selfById.get(id) ?? 0) / maxSelf : 0,
            memShare: maxMem  > 0 ? (memById.get(id)  ?? 0) / maxMem  : 0,
        });
    }

    return visuals;
}

/**
 * A node's cumulative actual time contribution: the per-loop total time times the
 * loop count (0 when either is absent).
 *
 * @param node - The plan node.
 *
 * @returns The cumulative time in milliseconds.
 */
function cumulativeTime(node: ExplainPlanNode): number {
    return (node.actualTotalTime ?? 0) * (node.actualLoops ?? 1);
}

/**
 * Whether any node in the forest satisfies `predicate` (depth-first).
 *
 * @param nodes - The nodes to search at this level.
 * @param predicate - The per-node test.
 *
 * @returns True when any node matches.
 */
function someNode(nodes: ExplainPlanNode[], predicate: (node: ExplainPlanNode) => boolean): boolean {
    return nodes.some(n => predicate(n) || someNode(n.children, predicate));
}
