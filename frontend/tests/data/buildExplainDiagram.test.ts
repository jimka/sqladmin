import { describe, it, expect } from "vitest";
import { buildExplainDiagram } from "../../src/data/buildExplainDiagram";
import type { ExplainNodeData } from "../../src/data/buildExplainDiagram";
import type { ExplainPlanNode } from "../../src/data/parseExplainPlan";

/**
 * Build a plan node carrying only the fields a test needs; everything else
 * defaults to undefined / no children.
 *
 * @param id - The node's path id.
 * @param fields - Overrides (cost/time/memory/children).
 * @returns A plan node.
 */
function node(id: string, fields: Partial<ExplainPlanNode> = {}): ExplainPlanNode {
    return {
        id,
        nodeType: "Node",
        label   : `node ${id}`,
        children: [],
        ...fields,
    };
}

/** The ExplainNodeData a diagram node carries, by node id. */
function dataById(nodes: { id: string; data?: unknown }[]): Map<string, ExplainNodeData> {
    return new Map(nodes.map(n => [n.id, n.data as ExplainNodeData]));
}

describe("buildExplainDiagram", () => {
    it("emits one node per plan node and one edge per parent→child link", () => {
        const roots = [node("0", { children: [node("0/0", { children: [node("0/0/0")] }), node("0/1")] })];
        const data  = buildExplainDiagram(roots);

        expect(data.nodes.map(n => n.id)).toEqual(["0", "0/0", "0/0/0", "0/1"]);

        const edgePairs = data.edges.map(e => [e.source, e.target]);

        expect(edgePairs).toEqual(expect.arrayContaining([["0", "0/0"], ["0/0", "0/0/0"], ["0", "0/1"]]));
        expect(data.edges).toHaveLength(3);

        const edgeIds = data.edges.map(e => e.id);

        expect(new Set(edgeIds).size).toBe(edgeIds.length);
    });

    it("lays out top-down and returns empty for an empty forest", () => {
        expect(buildExplainDiagram([]).nodes).toEqual([]);
        expect(buildExplainDiagram([]).edges).toEqual([]);
        expect(buildExplainDiagram([node("0")]).layoutOptions?.["elk.direction"]).toBe("DOWN");
    });

    it("attaches the plan node to each diagram node's data, keyed by the same id", () => {
        const roots = [node("0", { children: [node("0/0")] })];
        const data  = dataById(buildExplainDiagram(roots).nodes);

        expect(data.get("0")?.plan.id).toBe("0");
        expect(data.get("0/0")?.plan.id).toBe("0/0");
    });

    it("heats nodes by self-time share of the plan when analyzed", () => {
        // Cumulative actual time = Actual Total Time × Actual Loops; self = own minus
        // children. root 10 − (6+1) = 3; A 6 − 2 = 4; grandchild 2; B 1. max self = 4.
        const roots = [node("0", {
            actualTotalTime: 10, actualLoops: 1,
            children: [
                node("0/0", { actualTotalTime: 6, actualLoops: 1, children: [node("0/0/0", { actualTotalTime: 2, actualLoops: 1 })] }),
                node("0/1", { actualTotalTime: 1, actualLoops: 1 }),
            ],
        })];
        const data = dataById(buildExplainDiagram(roots).nodes);

        expect(data.get("0")?.heat).toBeCloseTo(3 / 4);
        expect(data.get("0/0")?.heat).toBeCloseTo(1);
        expect(data.get("0/0/0")?.heat).toBeCloseTo(2 / 4);
        expect(data.get("0/1")?.heat).toBeCloseTo(1 / 4);
    });

    it("heats nodes by self-cost share of the plan when not analyzed", () => {
        // Total Cost is cumulative; self = own minus children. root 100 − (60+10) = 30;
        // A 60 − 20 = 40; grandchild 20; B 10. max self = 40.
        const roots = [node("0", {
            totalCost: 100,
            children: [
                node("0/0", { totalCost: 60, children: [node("0/0/0", { totalCost: 20 })] }),
                node("0/1", { totalCost: 10 }),
            ],
        })];
        const data = dataById(buildExplainDiagram(roots).nodes);

        expect(data.get("0")?.heat).toBeCloseTo(30 / 40);
        expect(data.get("0/0")?.heat).toBeCloseTo(1);
        expect(data.get("0/0/0")?.heat).toBeCloseTo(20 / 40);
        expect(data.get("0/1")?.heat).toBeCloseTo(10 / 40);
    });

    it("scales the memory bar by peak memory relative to the plan max", () => {
        const roots = [node("0", {
            peakMemoryUsage: 256,
            children: [node("0/0", { peakMemoryUsage: 1024 }), node("0/1")],
        })];
        const data = dataById(buildExplainDiagram(roots).nodes);

        expect(data.get("0")?.memShare).toBeCloseTo(256 / 1024);
        expect(data.get("0/0")?.memShare).toBeCloseTo(1);
        expect(data.get("0/1")?.memShare).toBe(0);
    });

    it("gives zero heat and zero memShare when the plan has no cost/time/memory", () => {
        const data = dataById(buildExplainDiagram([node("0", { children: [node("0/0")] })]).nodes);

        expect(data.get("0")?.heat).toBe(0);
        expect(data.get("0")?.memShare).toBe(0);
    });

    it("labels each edge with the child's produced rows — actual (×loops) when analyzed", () => {
        const roots = [node("0", { children: [node("0/0", { actualRows: 100, actualLoops: 3 })] })];
        const edge  = buildExplainDiagram(roots).edges[0];

        expect(edge.style?.label).toBe("300");
        // The arrow sits at the source (parent) end so it points up toward the parent.
        expect(edge.style?.startMarker).toBe("arrow");
        expect(edge.style?.endMarker).toBeUndefined();
    });

    it("labels an edge with a ~-prefixed estimate when the child has no actual rows", () => {
        const roots = [node("0", { children: [node("0/0", { planRows: 1234 })] })];
        const edge  = buildExplainDiagram(roots).edges[0];

        expect(edge.style?.label).toBe("~1.2k");
    });

    it("still draws the (source-end) arrow when the child reports no rows", () => {
        const roots = [node("0", { children: [node("0/0")] })];
        const edge  = buildExplainDiagram(roots).edges[0];

        expect(edge.style?.startMarker).toBe("arrow");
        expect(edge.style?.label).toBeUndefined();
    });
});
