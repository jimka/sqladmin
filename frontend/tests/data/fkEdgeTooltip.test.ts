import { describe, it, expect } from "vitest";
import type { DiagramEdgeData } from "@jimka/typescript-ui/component/diagram";
import type { FkDetail, FkEdgeData } from "../../src/data/buildSchemaDiagram";
import { fkEdgeTooltip } from "../../src/data/fkEdgeTooltip";

/** Build a minimal FK edge, filling in the fields these tests don't vary. */
function fkEdge(
    source: string, target: string, columns: string[], refColumns: string[],
    overrides: Partial<FkDetail> = {},
): DiagramEdgeData {
    return {
        id: `${source}.fk_${target}`,
        source,
        target,
        data: {
            fks: [{
                columns, refColumns, refSchema: "public",
                onUpdate: "NO ACTION", onDelete: "NO ACTION",
                ...overrides,
            }],
        } satisfies FkEdgeData,
    };
}

/** Build a folded FK edge carrying several keys, filling in the fields these tests don't vary. */
function fkEdgeMulti(source: string, target: string, keys: Array<Partial<FkDetail> & { columns: string[]; refColumns: string[] }>): DiagramEdgeData {
    return {
        id: `${source}.fk_${target}`,
        source,
        target,
        data: {
            fks: keys.map(k => ({ refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION", ...k })),
        } satisfies FkEdgeData,
    };
}

describe("fkEdgeTooltip", () => {
    it("returns null for an empty edge list", () => {
        expect(fkEdgeTooltip([])).toBeNull();
    });

    it("returns null when no edge carries FkEdgeData", () => {
        const noData: DiagramEdgeData = { id: "e1", source: "a", target: "b" };
        const undefinedColumns: DiagramEdgeData = { id: "e2", source: "a", target: "b", data: { note: "not an fk" } };

        expect(fkEdgeTooltip([noData])).toBeNull();
        expect(fkEdgeTooltip([undefinedColumns])).toBeNull();
    });

    it("renders a single edge's full detail: its header and the referential action", () => {
        const edge = fkEdge("orders", "customer", ["customer_id"], ["id"], { onDelete: "CASCADE", uncovered: true });

        // `uncovered` is set and still contributes no line: index coverage is the
        // warning-tinted stroke's job, not the tooltip's.
        expect(fkEdgeTooltip([edge])).toBe("orders(customer_id) → customer(id)\nON DELETE CASCADE");
    });

    it("omits the referential-action line when both actions are the Postgres default", () => {
        const edge = fkEdge("orders", "customer", ["customer_id"], ["id"]);

        expect(fkEdgeTooltip([edge])).toBe("orders(customer_id) → customer(id)");
    });

    it("renders a composite key as a comma-separated column list on both ends", () => {
        const edge = fkEdge("t", "u", ["a", "b"], ["x", "y"]);

        expect(fkEdgeTooltip([edge])).toBe("t(a, b) → u(x, y)");
    });

    it("summarises several edges sharing one target column as a merged-trunk bundle", () => {
        const edges = [
            fkEdge("orders", "customer", ["customer_id"], ["id"]),
            fkEdge("invoices", "customer", ["customer_id"], ["id"]),
            fkEdge("payments", "customer", ["bill_to"], ["id"]),
        ];

        expect(fkEdgeTooltip(edges)).toBe(
            "3 references to customer(id)\norders(customer_id)\ninvoices(customer_id)\npayments(bill_to)",
        );
    });

    it("summarises edges with different targets as a plain foreign-key list", () => {
        const edges = [
            fkEdge("orders", "customer", ["customer_id"], ["id"]),
            fkEdge("line_items", "orders", ["order_id"], ["id"]),
        ];

        expect(fkEdgeTooltip(edges)).toBe(
            "2 foreign keys here\norders(customer_id) → customer(id)\nline_items(order_id) → orders(id)",
        );
    });

    it("uses the single-edge form when only one of several edges actually contributes FkEdgeData", () => {
        const contributing = fkEdge("orders", "customer", ["customer_id"], ["id"]);
        const nonContributing: DiagramEdgeData = { id: "dep", source: "x", target: "y", data: { kind: "dependency" } };

        expect(fkEdgeTooltip([nonContributing, contributing])).toBe("orders(customer_id) → customer(id)");
    });

    it("flattens one folded edge's two keys into a merged-trunk bundle listing both", () => {
        const edge = fkEdgeMulti("orders", "addresses", [
            { columns: ["billing_address_id"], refColumns: ["id"] },
            { columns: ["shipping_address_id"], refColumns: ["id"] },
        ]);

        expect(fkEdgeTooltip([edge])).toBe(
            "2 references to addresses(id)\norders(billing_address_id)\norders(shipping_address_id)",
        );
    });

    it("gives a folded merged-trunk bundle one line per key, uncovered or not", () => {
        const edge = fkEdgeMulti("orders", "addresses", [
            { columns: ["billing_address_id"], refColumns: ["id"], uncovered: false },
            { columns: ["shipping_address_id"], refColumns: ["id"], uncovered: true },
        ]);

        expect(fkEdgeTooltip([edge])).toBe(
            "2 references to addresses(id)\norders(billing_address_id)\norders(shipping_address_id)",
        );
    });

    it("gives a folded different-targets bundle one line per key, uncovered or not", () => {
        const edge = fkEdgeMulti("orders", "addresses", [
            { columns: ["billing_address_id"], refColumns: ["id"], uncovered: false },
            { columns: ["shipping_address_id"], refColumns: ["street"], uncovered: true },
        ]);

        expect(fkEdgeTooltip([edge])).toBe(
            "2 foreign keys here\n"
            + "orders(billing_address_id) → addresses(id)\n"
            + "orders(shipping_address_id) → addresses(street)",
        );
    });

    it("summarises one folded edge's two keys with different refColumns as a plain foreign-key list", () => {
        const edge = fkEdgeMulti("orders", "addresses", [
            { columns: ["billing_address_id"], refColumns: ["id"] },
            { columns: ["shipping_address_id"], refColumns: ["street"] },
        ]);

        expect(fkEdgeTooltip([edge])).toBe(
            "2 foreign keys here\n"
            + "orders(billing_address_id) → addresses(id)\n"
            + "orders(shipping_address_id) → addresses(street)",
        );
    });

    it("flattens two hovered edges carrying two keys each into four detail lines", () => {
        const edgeA = fkEdgeMulti("orders", "customer", [
            { columns: ["billing_id"], refColumns: ["id"] },
            { columns: ["shipping_id"], refColumns: ["id"] },
        ]);
        const edgeB = fkEdgeMulti("invoices", "customer", [
            { columns: ["billed_to"], refColumns: ["id"] },
            { columns: ["paid_by"], refColumns: ["id"] },
        ]);

        const tooltip = fkEdgeTooltip([edgeA, edgeB])!;
        const lines = tooltip.split("\n");

        expect(lines[0]).toBe("4 references to customer(id)");
        expect(lines.slice(1)).toEqual([
            "orders(billing_id)", "orders(shipping_id)", "invoices(billed_to)", "invoices(paid_by)",
        ]);
    });

    it("caps a merged trunk's detail lines at eight, with a trailing summary line for the rest", () => {
        const edges = Array.from({ length: 10 }, (_, i) =>
            fkEdge(`t${i}`, "customer", [`col${i}`], ["id"]));

        const tooltip = fkEdgeTooltip(edges)!;
        const lines = tooltip.split("\n");

        expect(lines[0]).toBe("10 references to customer(id)");
        expect(lines).toHaveLength(1 + 8 + 1);
        expect(lines[9]).toBe("…and 2 more");
    });

    it("caps the detail at eight keys and collapses the rest into a trailing summary", () => {
        // Every key renders exactly one line, so the eight-line budget is also an
        // eight-key budget; the summary counts the keys dropped, not lines.
        const edges = Array.from({ length: 10 }, (_, i) =>
            fkEdge(`t${i}`, "customer", [`col${i}`], ["id"], { uncovered: i % 2 === 0 }));

        const tooltip = fkEdgeTooltip(edges)!;
        const lines = tooltip.split("\n");

        expect(lines[0]).toBe("10 references to customer(id)");
        expect(lines.slice(1, 9)).toEqual([
            "t0(col0)", "t1(col1)", "t2(col2)", "t3(col3)", "t4(col4)", "t5(col5)", "t6(col6)", "t7(col7)",
        ]);
        expect(lines[9]).toBe("…and 2 more");
        expect(lines).toHaveLength(1 + 8 + 1);
    });

    it("shows every key when there are exactly eight, with no trailing summary", () => {
        const edges = Array.from({ length: 8 }, (_, i) => fkEdge(`t${i}`, "customer", [`col${i}`], ["id"]));

        const lines = fkEdgeTooltip(edges)!.split("\n");

        expect(lines).toHaveLength(1 + 8);
        expect(lines.at(-1)).toBe("t7(col7)");
    });
});
