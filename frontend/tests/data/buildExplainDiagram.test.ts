import { describe, it, expect } from "vitest";
import { buildExplainDiagram } from "../../src/data/buildExplainDiagram";
import type { ExplainPlanNode } from "../../src/data/parseExplainPlan";

/**
 * Build a minimal ExplainPlanNode for wiring assertions — only the fields
 * buildExplainDiagram reads (id, label, children) carry meaning here.
 *
 * @param id - The node's path id.
 * @param children - The node's children.
 * @returns A plan node.
 */
function node(id: string, children: ExplainPlanNode[] = []): ExplainPlanNode {
    return { id, nodeType: "Seq Scan", label: `node ${id}`, metrics: [], children };
}

/** A 4-node nested plan: root "0" with children "0/0" (→ "0/0/0") and "0/1". */
function nestedRoots(): ExplainPlanNode[] {
    return [node("0", [node("0/0", [node("0/0/0")]), node("0/1")])];
}

describe("buildExplainDiagram", () => {
    it("emits one node per plan node and one edge per parent→child link", () => {
        const data = buildExplainDiagram(nestedRoots());

        expect(data.nodes.map(n => n.id)).toEqual(["0", "0/0", "0/0/0", "0/1"]);

        const edgePairs = data.edges.map(e => [e.source, e.target]);

        expect(edgePairs).toEqual(expect.arrayContaining([
            ["0", "0/0"],
            ["0/0", "0/0/0"],
            ["0", "0/1"],
        ]));
        expect(data.edges).toHaveLength(3);

        const edgeIds = data.edges.map(e => e.id);

        expect(new Set(edgeIds).size).toBe(edgeIds.length);
    });

    it("lays out top-down (root above its inputs)", () => {
        const data = buildExplainDiagram(nestedRoots());

        expect(data.layoutOptions?.["elk.direction"]).toBe("DOWN");
    });

    it("returns empty nodes and edges for an empty forest", () => {
        const data = buildExplainDiagram([]);

        expect(data.nodes).toEqual([]);
        expect(data.edges).toEqual([]);
        expect(data.layoutOptions?.["elk.direction"]).toBe("DOWN");
    });

    it("keeps every diagram node id equal to its plan node id", () => {
        const roots = nestedRoots();
        const data  = buildExplainDiagram(roots);

        const planIds = ["0", "0/0", "0/0/0", "0/1"];

        expect(new Set(data.nodes.map(n => n.id))).toEqual(new Set(planIds));
    });
});
