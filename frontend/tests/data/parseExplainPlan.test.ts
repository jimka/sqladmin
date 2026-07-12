import { describe, it, expect } from "vitest";
import { parseExplainPlan } from "../../src/data/parseExplainPlan";

/**
 * Wrap one root Plan object as Postgres' FORMAT JSON payload shape: an array
 * with a single statement entry carrying the root under "Plan".
 *
 * @param plan - The root Plan object.
 * @returns The `[ { "Plan": plan } ]` envelope parseExplainPlan consumes.
 */
function envelope(plan: Record<string, unknown>): unknown {
    return [{ "Plan": plan }];
}

describe("parseExplainPlan", () => {
    it("parses a single-node plain plan into one root with cost/rows/width metrics", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Total Cost": 12.5,
            "Plan Rows": 100,
            "Plan Width": 8,
        }));

        expect(roots).toHaveLength(1);

        const root = roots[0];

        expect(root.id).toBe("0");
        expect(root.nodeType).toBe("Seq Scan");
        expect(root.label).toBe("Seq Scan on users");
        expect(root.relationName).toBe("users");
        expect(root.children).toEqual([]);
        expect(root.metrics).toEqual([
            { label: "cost", value: 12.5 },
            { label: "rows", value: 100 },
            { label: "width", value: 8 },
        ]);
    });

    it("assigns path ids across a nested plan and preserves the hierarchy", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Hash Join",
            "Total Cost": 50,
            "Plan Rows": 10,
            "Plan Width": 4,
            "Plans": [
                {
                    "Node Type": "Seq Scan",
                    "Relation Name": "a",
                    "Total Cost": 5,
                    "Plan Rows": 1,
                    "Plan Width": 4,
                    "Plans": [
                        { "Node Type": "Result", "Total Cost": 1, "Plan Rows": 1, "Plan Width": 4 },
                    ],
                },
                { "Node Type": "Seq Scan", "Relation Name": "b", "Total Cost": 6, "Plan Rows": 2, "Plan Width": 4 },
            ],
        }));

        expect(roots).toHaveLength(1);

        const root = roots[0];

        expect(root.id).toBe("0");
        expect(root.children.map(c => c.id)).toEqual(["0/0", "0/1"]);
        expect(root.children[0].children.map(c => c.id)).toEqual(["0/0/0"]);
        expect(root.children[0].nodeType).toBe("Seq Scan");
        expect(root.children[0].children[0].nodeType).toBe("Result");
    });

    it("appends actual-time / actual-rows / loops metrics for an analyze plan", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Total Cost": 12.5,
            "Plan Rows": 100,
            "Plan Width": 8,
            "Actual Total Time": 3.14,
            "Actual Rows": 99,
            "Actual Loops": 1,
        }));

        expect(roots[0].metrics).toEqual([
            { label: "cost", value: 12.5 },
            { label: "rows", value: 100 },
            { label: "width", value: 8 },
            { label: "actual time (ms)", value: 3.14 },
            { label: "actual rows", value: 99 },
            { label: "loops", value: 1 },
        ]);
    });

    it("labels a node without a Relation Name by its node type alone", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Hash Join",
            "Total Cost": 50,
            "Plan Rows": 10,
            "Plan Width": 4,
        }));

        expect(roots[0].label).toBe("Hash Join");
        expect(roots[0].relationName).toBeUndefined();
    });

    it("omits a metric whose source numeric field is missing", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Total Cost": 12.5,
            "Plan Rows": 100,
            // no "Plan Width"
        }));

        expect(roots[0].metrics).toEqual([
            { label: "cost", value: 12.5 },
            { label: "rows", value: 100 },
        ]);
    });

    it("returns [] for every malformed or empty input shape", () => {
        expect(parseExplainPlan(undefined)).toEqual([]);
        expect(parseExplainPlan(null)).toEqual([]);
        expect(parseExplainPlan({})).toEqual([]);
        expect(parseExplainPlan([])).toEqual([]);
        expect(parseExplainPlan([{}])).toEqual([]);
        expect(parseExplainPlan([{ "Plan": 5 }])).toEqual([]);
    });

    it("parses a multi-statement array into one root per entry", () => {
        const roots = parseExplainPlan([
            { "Plan": { "Node Type": "Seq Scan", "Relation Name": "a", "Total Cost": 1, "Plan Rows": 1, "Plan Width": 1 } },
            { "Plan": { "Node Type": "Seq Scan", "Relation Name": "b", "Total Cost": 2, "Plan Rows": 2, "Plan Width": 2 } },
        ]);

        expect(roots.map(r => r.id)).toEqual(["0", "1"]);
        expect(roots.map(r => r.relationName)).toEqual(["a", "b"]);
    });
});
