import { describe, it, expect } from "vitest";
import type { ExplainPlanNode } from "../../src/data/parseExplainPlan";
import type { TableStructure } from "../../src/contract";
import {
    collectIndexCandidates,
    rejectCoveredCandidates,
    rankCandidates,
    suggestionDdl,
    resolveIndexSuggestions,
    buildIndexSuggestionRows,
    relationKey,
} from "../../src/data/suggestIndexes";
import type { IndexCandidate, IndexSuggestion, LoadTableStructure } from "../../src/data/suggestIndexes";

/**
 * Build a plan node carrying only the fields a test needs; everything else
 * defaults to undefined / no children. Mirrors buildPlanSteps.test.ts's node().
 *
 * @param id - The node's path id.
 * @param fields - Overrides.
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

/** Fixture 12: a Seq Scan on public.orders with a selective, gate-passing filter. */
function seqScanOrders(overrides: Partial<ExplainPlanNode> = {}): ExplainPlanNode {
    return node("0", {
        nodeType           : "Seq Scan",
        relationName       : "orders",
        schema             : "public",
        alias              : "o",
        filter             : "(o.status = 'shipped'::text)",
        actualRows         : 500,
        rowsRemovedByFilter: 99500,
        totalCost          : 2000,
        ...overrides,
    });
}

/** Fixture 16: a Sort over a Seq Scan with a composite (AND) filter, same relation. */
function compositeFixture(): ExplainPlanNode {
    return node("0", {
        nodeType: "Sort",
        sortKey : ["o.created_at"],
        actualRows: 10000,
        totalCost : 500,
        children: [
            node("0/0", {
                nodeType           : "Seq Scan",
                relationName       : "orders",
                schema             : "public",
                alias              : "o",
                filter             : "((o.status = 'x'::text) AND (o.total > 100))",
                actualRows         : 10000,
                rowsRemovedByFilter: 90000,
                totalCost          : 2500,
            }),
        ],
    });
}

/** A minimal TableStructure carrying one index definition. */
function structureWithIndex(definition: string): TableStructure {
    return { indexes: [{ name: "ix", definition, unique: false, primary: false }], constraints: [], foreignKeys: [] };
}

describe("relationKey", () => {
    it("joins schema and relation with a dot", () => {
        expect(relationKey("public", "orders")).toBe("public.orders");
    });
});

describe("collectIndexCandidates", () => {
    it("row 12: a seq scan with a selective, gate-passing filter yields one candidate", () => {
        const candidates = collectIndexCandidates([seqScanOrders()]);

        expect(candidates).toHaveLength(1);
        expect(candidates[0].schema).toBe("public");
        expect(candidates[0].relation).toBe("orders");
        expect(candidates[0].columns).toEqual(["status"]);
        expect(candidates[0].reasons).toEqual(["Seq Scan filter on status"]);
        expect(candidates[0].rowsScanned).toBe(100000);
    });

    it("row 13: a sort before a limit is a candidate regardless of its row count", () => {
        const roots = [node("0", {
            nodeType  : "Limit",
            actualRows: 50,
            totalCost : 10,
            children  : [
                node("0/0", {
                    nodeType  : "Sort",
                    sortKey   : ["o.created_at DESC"],
                    actualRows: 50,
                    totalCost : 10,
                    children  : [
                        node("0/0/0", {
                            nodeType    : "Seq Scan",
                            relationName: "orders",
                            schema      : "public",
                            alias       : "o",
                            actualRows  : 50,
                            totalCost   : 5,
                        }),
                    ],
                }),
            ],
        })];

        const candidates = collectIndexCandidates(roots);

        expect(candidates).toHaveLength(1);
        expect(candidates[0].columns).toEqual(["created_at"]);
        expect(candidates[0].reasons).toEqual(["Top-N sort on created_at"]);
    });

    it("row 14: a sort with no limit and a tiny row count yields no candidate", () => {
        const sortNode = node("0", {
            nodeType  : "Sort",
            sortKey   : ["o.created_at DESC"],
            actualRows: 50,
            totalCost : 10,
            children  : [
                node("0/0", {
                    nodeType: "Seq Scan", relationName: "orders", schema: "public", alias: "o",
                    actualRows: 50, totalCost: 5,
                }),
            ],
        });

        expect(collectIndexCandidates([sortNode])).toEqual([]);
    });

    it("row 15: a join gates each side independently on its own scan's rows", () => {
        const roots = [node("0", {
            nodeType  : "Hash Join",
            hashCond  : "(o.customer_id = c.id)",
            actualRows: 200000,
            totalCost : 5000,
            children  : [
                node("0/0", {
                    nodeType: "Seq Scan", relationName: "orders", schema: "public", alias: "o",
                    actualRows: 200000, totalCost: 3000,
                }),
                node("0/1", {
                    nodeType  : "Hash",
                    actualRows: 300,
                    totalCost : 10,
                    children  : [
                        node("0/1/0", {
                            nodeType: "Seq Scan", relationName: "customers", schema: "public", alias: "c",
                            actualRows: 300, totalCost: 8,
                        }),
                    ],
                }),
            ],
        })];

        const candidates = collectIndexCandidates(roots);

        expect(candidates).toHaveLength(1);
        expect(candidates[0].relation).toBe("orders");
        expect(candidates[0].columns).toEqual(["customer_id"]);
        expect(candidates[0].reasons).toEqual(["Hash Join condition on customer_id"]);
    });

    it("row 16: a sort plus a composite filter on the same relation merge into one candidate", () => {
        const candidates = collectIndexCandidates([compositeFixture()]);

        expect(candidates).toHaveLength(1);
        expect(candidates[0].columns).toEqual(["status", "created_at", "total"]);
        expect(candidates[0].reasons).toEqual(["Sort on created_at", "Seq Scan filter on status, total"]);
    });

    it("row 20: a scan with no schema (a plan fetched without VERBOSE) yields no candidate", () => {
        expect(collectIndexCandidates([seqScanOrders({ schema: undefined })])).toEqual([]);
    });

    it("an inner Nested Loop side gates on the loop's own totalCost, not its per-iteration cost", () => {
        const roots = [node("0", {
            nodeType  : "Nested Loop",
            joinFilter: "(o.customer_id = c.id)",
            totalCost : 5000,
            children  : [
                node("0/0", {
                    nodeType: "Seq Scan", relationName: "orders", schema: "public", alias: "o",
                    parentRelationship: "Outer", totalCost: 3000,
                }),
                node("0/1", {
                    nodeType: "Seq Scan", relationName: "customers", schema: "public", alias: "c",
                    parentRelationship: "Inner", totalCost: 5,
                }),
            ],
        })];

        const candidates = collectIndexCandidates(roots);
        const customers  = candidates.find(c => c.relation === "customers");

        expect(customers).toBeDefined();
        expect(customers?.columns).toEqual(["id"]);
    });
});

describe("rejectCoveredCandidates", () => {
    it("drops a candidate an existing index already leads with", () => {
        const candidate: IndexCandidate = {
            schema: "public", relation: "orders", columns: ["status"], reasons: [], nodeIds: [], cost: 0,
        };
        const structures = new Map([["public.orders", structureWithIndex(
            "CREATE INDEX ix ON public.orders USING btree (status)",
        )]]);

        expect(rejectCoveredCandidates([candidate], structures)).toEqual([]);
    });

    it("drops a candidate with no entry in structures", () => {
        const candidate: IndexCandidate = {
            schema: "public", relation: "orders", columns: ["status"], reasons: [], nodeIds: [], cost: 0,
        };

        expect(rejectCoveredCandidates([candidate], new Map())).toEqual([]);
    });

    it("row 18: a composite candidate survives when only a column-prefix subset is indexed", () => {
        const candidate: IndexCandidate = {
            schema: "public", relation: "orders", columns: ["status", "created_at", "total"], reasons: [], nodeIds: [], cost: 0,
        };
        const structures = new Map([["public.orders", structureWithIndex(
            "CREATE INDEX ix ON public.orders USING btree (status)",
        )]]);

        expect(rejectCoveredCandidates([candidate], structures)).toEqual([candidate]);
    });
});

describe("rankCandidates", () => {
    it("row 21: truncates to MAX_SUGGESTIONS (5), ordered by rowsScanned descending", () => {
        const candidates: IndexCandidate[] = [1, 2, 3, 4, 5, 6].map(n => ({
            schema: "public", relation: `t${n}`, columns: ["a"], reasons: ["Seq Scan filter on a"],
            nodeIds: [`${n}`], rowsScanned: n * 1000, cost: n * 100,
        }));

        const ranked = rankCandidates(candidates);

        expect(ranked).toHaveLength(5);
        expect(ranked.map(r => r.relation)).toEqual(["t6", "t5", "t4", "t3", "t2"]);
        expect(ranked.map(r => r.id)).toEqual(["0", "1", "2", "3", "4"]);
    });

    it("breaks a rowsScanned tie on contributing-node count descending", () => {
        const fewer: IndexCandidate = { schema: "public", relation: "a", columns: ["x"], reasons: [], nodeIds: ["0"], rowsScanned: 100, cost: 1 };
        const more : IndexCandidate = { schema: "public", relation: "b", columns: ["x"], reasons: [], nodeIds: ["0", "1"], rowsScanned: 100, cost: 1 };

        expect(rankCandidates([fewer, more]).map(r => r.relation)).toEqual(["b", "a"]);
    });

    it("falls back to cost when rowsScanned is absent (a plain, non-ANALYZE plan)", () => {
        const low : IndexCandidate = { schema: "public", relation: "a", columns: ["x"], reasons: [], nodeIds: ["0"], cost: 10 };
        const high: IndexCandidate = { schema: "public", relation: "b", columns: ["x"], reasons: [], nodeIds: ["0"], cost: 20 };

        expect(rankCandidates([low, high]).map(r => r.relation)).toEqual(["b", "a"]);
    });
});

describe("suggestionDdl", () => {
    it("row 22: renders a quoted CREATE INDEX preview", () => {
        const candidate: IndexCandidate = {
            schema: "public", relation: "orders", columns: ["status", "created_at"], reasons: [], nodeIds: [], cost: 0,
        };

        expect(suggestionDdl(candidate)).toBe('CREATE INDEX ON "public"."orders" ("status", "created_at")');
    });
});

describe("buildIndexSuggestionRows", () => {
    it("row 23: joins reasons with '; ' and omits Rows scanned when absent", () => {
        const suggestion: IndexSuggestion = {
            schema: "public", relation: "orders", columns: ["status"], reasons: ["Reason A", "Reason B"],
            nodeIds: ["0"], cost: 42, id: "0", ddl: 'CREATE INDEX ON "public"."orders" ("status")',
        };

        const [row] = buildIndexSuggestionRows([suggestion]);

        expect(row.Why).toBe("Reason A; Reason B");
        expect(row["Rows scanned"]).toBeUndefined();
        expect(row.Cost).toBe(42);
        expect(row.Index).toBe('CREATE INDEX ON "public"."orders" ("status")');
    });
});

describe("resolveIndexSuggestions", () => {
    it("row 17: drops a candidate an already-indexed relation covers", async () => {
        const load: LoadTableStructure = async () => structureWithIndex(
            "CREATE INDEX ix ON public.orders USING btree (status)",
        );

        expect(await resolveIndexSuggestions([seqScanOrders()], load)).toEqual([]);
    });

    it("row 18: a composite candidate survives partial coverage, end to end", async () => {
        const load: LoadTableStructure = async () => structureWithIndex(
            "CREATE INDEX ix ON public.orders USING btree (status)",
        );

        const suggestions = await resolveIndexSuggestions([compositeFixture()], load);

        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].columns).toEqual(["status", "created_at", "total"]);
    });

    it("row 19: drops a relation whose structure fetch rejects", async () => {
        const load: LoadTableStructure = async () => { throw new Error("not found"); };

        expect(await resolveIndexSuggestions([seqScanOrders()], load)).toEqual([]);
    });

    it("returns [] with no relation fetch when there are no candidates", async () => {
        let called = false;
        const load: LoadTableStructure = async () => { called = true; return structureWithIndex(""); };

        const suggestions = await resolveIndexSuggestions([node("0", { nodeType: "Result" })], load);

        expect(suggestions).toEqual([]);
        expect(called).toBe(false);
    });
});
