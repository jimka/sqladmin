import { describe, it, expect } from "vitest";
import { buildPlanStepsRows } from "../../src/data/buildPlanSteps";
import type { ExplainPlanNode } from "../../src/data/parseExplainPlan";

/**
 * Build a plan node carrying only the fields a test needs; everything else
 * defaults to undefined / no children.
 *
 * @param id - The node's path id.
 * @param fields - Overrides (label/metrics/children).
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

describe("buildPlanStepsRows", () => {
    it("emits one row per node in depth-first (plan) order", () => {
        const roots = [node("0", { children: [node("0/0", { children: [node("0/0/0")] }), node("0/1")] })];

        expect(buildPlanStepsRows(roots).map(r => r.Action)).toEqual([
            "node 0", "node 0/0", "node 0/0/0", "node 0/1",
        ]);
    });

    it("maps each node's raw numeric metrics onto its row", () => {
        const roots = [node("0", {
            label          : "Seq Scan on users",
            totalCost      : 12.5,
            planRows       : 100,
            actualRows     : 99,
            planWidth      : 8,
            actualTotalTime: 3.14,
            hashBatches    : 4,
            peakMemoryUsage: 512,
        })];

        const [row] = buildPlanStepsRows(roots);

        expect(row.Action).toBe("Seq Scan on users");
        expect(row.Cost).toBe(12.5);
        expect(row["Expected Rows"]).toBe(100);
        expect(row["Actual Rows"]).toBe(99);
        expect(row.Width).toBe(8);
        expect(row.Time).toBe(3.14);
        expect(row.Batches).toBe(4);
        expect(row.Memory).toBe(512);
    });

    it("joins the group key with commas and omits it when absent", () => {
        const roots = [node("0", { groupKey: ["u.dept_id", "u.region"] }), node("1")];
        const rows  = buildPlanStepsRows(roots);

        expect(rows[0].Group).toBe("u.dept_id, u.region");
        expect(rows[1].Group).toBeUndefined();
    });

    it("leaves a metric absent (not zero) when the node does not report it", () => {
        const [row] = buildPlanStepsRows([node("0", { totalCost: 5 })]);

        expect(row.Cost).toBe(5);
        expect(row["Expected Rows"]).toBeUndefined();
        expect(row.Time).toBeUndefined();
        expect(row.Memory).toBeUndefined();
    });

    it("carries each node's plan id onto its row (for row→tree/diagram selection)", () => {
        const roots = [node("0", { children: [node("0/0"), node("0/1")] })];

        expect(buildPlanStepsRows(roots).map(r => r.id)).toEqual(["0", "0/0", "0/1"]);
    });

    it("returns [] for an empty forest", () => {
        expect(buildPlanStepsRows([])).toEqual([]);
    });
});
