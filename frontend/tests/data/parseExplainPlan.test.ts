import { describe, it, expect } from "vitest";
import { parseExplainPlan, parseExplainSummary } from "../../src/data/parseExplainPlan";

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
    it("parses a single-node plain plan's cost/rows/width fields", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Startup Cost": 0.29,
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
        expect(root.startupCost).toBe(0.29);
        expect(root.totalCost).toBe(12.5);
        expect(root.planRows).toBe(100);
        expect(root.planWidth).toBe(8);
        // No analyze fields on a plain plan.
        expect(root.actualStartupTime).toBeUndefined();
        expect(root.actualTotalTime).toBeUndefined();
        expect(root.actualRows).toBeUndefined();
        expect(root.actualLoops).toBeUndefined();
        // No extras absent from the source.
        expect(root.groupKey).toBeUndefined();
        expect(root.hashBatches).toBeUndefined();
        expect(root.peakMemoryUsage).toBeUndefined();
    });

    it("assigns path ids across a nested plan and preserves the hierarchy", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Hash Join",
            "Total Cost": 50,
            "Plans": [
                {
                    "Node Type": "Seq Scan",
                    "Relation Name": "a",
                    "Total Cost": 5,
                    "Plans": [
                        { "Node Type": "Result", "Total Cost": 1 },
                    ],
                },
                { "Node Type": "Seq Scan", "Relation Name": "b", "Total Cost": 6 },
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

    it("captures the analyze timing fields when present", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Total Cost": 12.5,
            "Actual Startup Time": 0.02,
            "Actual Total Time": 3.14,
            "Actual Rows": 99,
            "Actual Loops": 2,
        }));

        expect(roots[0].actualStartupTime).toBe(0.02);
        expect(roots[0].actualTotalTime).toBe(3.14);
        expect(roots[0].actualRows).toBe(99);
        expect(roots[0].actualLoops).toBe(2);
    });

    it("captures group key, hash batches, and peak memory usage", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "HashAggregate",
            "Total Cost": 20,
            "Group Key": ["u.dept_id", "u.region"],
            "Hash Batches": 4,
            "Peak Memory Usage": 512,
        }));

        expect(roots[0].groupKey).toEqual(["u.dept_id", "u.region"]);
        expect(roots[0].hashBatches).toBe(4);
        expect(roots[0].peakMemoryUsage).toBe(512);
    });

    it("labels a node without a Relation Name by its node type alone", () => {
        const roots = parseExplainPlan(envelope({ "Node Type": "Hash Join", "Total Cost": 50 }));

        expect(roots[0].label).toBe("Hash Join");
        expect(roots[0].relationName).toBeUndefined();
    });

    it("appends a differing alias to the label in parentheses", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Alias": "u",
            "Total Cost": 1,
        }));

        expect(roots[0].label).toBe("Seq Scan on users (u)");
    });

    it("omits a numeric field whose source value is missing or non-finite", () => {
        const roots = parseExplainPlan(envelope({
            "Node Type": "Seq Scan",
            "Relation Name": "users",
            "Total Cost": 12.5,
            "Plan Rows": 100,
            // no "Plan Width", no "Startup Cost"
        }));

        expect(roots[0].totalCost).toBe(12.5);
        expect(roots[0].planRows).toBe(100);
        expect(roots[0].planWidth).toBeUndefined();
        expect(roots[0].startupCost).toBeUndefined();
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
            { "Plan": { "Node Type": "Seq Scan", "Relation Name": "a", "Total Cost": 1 } },
            { "Plan": { "Node Type": "Seq Scan", "Relation Name": "b", "Total Cost": 2 } },
        ]);

        expect(roots.map(r => r.id)).toEqual(["0", "1"]);
        expect(roots.map(r => r.relationName)).toEqual(["a", "b"]);
    });
});

describe("parseExplainSummary", () => {
    it("reads planning and execution time from the top-level entry", () => {
        const summary = parseExplainSummary([{
            "Plan": { "Node Type": "Seq Scan" },
            "Planning Time": 0.123,
            "Execution Time": 4.567,
        }]);

        expect(summary.planningTime).toBe(0.123);
        expect(summary.executionTime).toBe(4.567);
    });

    it("leaves execution time undefined for a plain (non-analyze) plan", () => {
        const summary = parseExplainSummary([{
            "Plan": { "Node Type": "Seq Scan" },
            "Planning Time": 0.2,
        }]);

        expect(summary.planningTime).toBe(0.2);
        expect(summary.executionTime).toBeUndefined();
    });

    it("returns an empty summary for every malformed or empty input shape", () => {
        expect(parseExplainSummary(undefined)).toEqual({});
        expect(parseExplainSummary(null)).toEqual({});
        expect(parseExplainSummary({})).toEqual({});
        expect(parseExplainSummary([])).toEqual({});
        expect(parseExplainSummary([5])).toEqual({});
        expect(parseExplainSummary([{ "Planning Time": "slow" }])).toEqual({});
    });
});
