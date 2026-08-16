import { describe, it, expect } from "vitest";
import { parseConditionColumns, parseSortKeyColumns } from "../../src/data/planPredicates";

describe("parseConditionColumns", () => {
    it("row 1: a plain equality comparison yields one equality ref", () => {
        expect(parseConditionColumns("(o.status = 'active'::text)")).toEqual([
            { alias: "o", column: "status", role: "equality" },
        ]);
    });

    it("row 2: a cast-wrapped column ref strips the parens and the ::type suffix", () => {
        expect(parseConditionColumns("((o.status)::text = 'x'::text)")).toEqual([
            { alias: "o", column: "status", role: "equality" },
        ]);
    });

    it("row 3: an AND of two conjuncts yields both refs in order (equality, then range)", () => {
        expect(parseConditionColumns("((o.status = 'x'::text) AND (o.total > 100))")).toEqual([
            { alias: "o", column: "status", role: "equality" },
            { alias: "o", column: "total", role: "range" },
        ]);
    });

    it("row 4: a join condition between two column refs yields both as equality", () => {
        expect(parseConditionColumns("(o.customer_id = c.id)")).toEqual([
            { alias: "o", column: "customer_id", role: "equality" },
            { alias: "c", column: "id", role: "equality" },
        ]);
    });

    it("row 5: an = ANY (...) comparison yields the left column as equality", () => {
        expect(parseConditionColumns("(o.status = ANY ('{a,b}'::text[]))")).toEqual([
            { alias: "o", column: "status", role: "equality" },
        ]);
    });

    it("row 6: a top-level OR yields nothing", () => {
        expect(parseConditionColumns("((o.a = 1) OR (o.b = 2))")).toEqual([]);
    });

    it("row 7: an expression on the left (a function call) yields nothing", () => {
        expect(parseConditionColumns("(lower((o.email)::text) = 'x'::text)")).toEqual([]);
    });

    it("row 8: <> is not an indexable operator here", () => {
        expect(parseConditionColumns("(o.status <> 'x'::text)")).toEqual([]);
    });

    it("row 9: an unqualified column has no alias", () => {
        expect(parseConditionColumns("(status = 'x'::text)")).toEqual([
            { column: "status", role: "equality" },
        ]);
    });
});

describe("parseSortKeyColumns", () => {
    it("row 10: strips DESC and reads a bare trailing key, both aliased", () => {
        expect(parseSortKeyColumns(["o.created_at DESC", "o.id"])).toEqual([
            { alias: "o", column: "created_at" },
            { alias: "o", column: "id" },
        ]);
    });

    it("row 11: an expression term yields [] for the whole array", () => {
        expect(parseSortKeyColumns(["(o.total * 2)"])).toEqual([]);
    });

    it("strips NULLS LAST alongside DESC", () => {
        expect(parseSortKeyColumns(["o.created_at DESC NULLS LAST"])).toEqual([
            { alias: "o", column: "created_at" },
        ]);
    });

    it("one unparseable term drops the whole array, not just that term", () => {
        expect(parseSortKeyColumns(["o.created_at", "(o.total * 2)"])).toEqual([]);
    });
});
