import { describe, it, expect } from "vitest";
import type { DiagramData } from "@jimka/typescript-ui/component/diagram";
import type { FkEdgeData } from "../../src/data/buildSchemaDiagram";
import { portId } from "../../src/data/schemaCardModel";
import { columnEmphasis } from "../../src/data/columnEmphasis";

/** Build a minimal FkEdgeData, filling in the fields these tests don't vary. */
function fkData(columns: string[], refColumns: string[]): FkEdgeData {
    return { fks: [{ columns, refColumns, refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION" }] };
}

/**
 * The plan's fixture: `orders -> customer` and `invoices -> customer`, both
 * column-to-column ported on `customer_id` / `id`.
 */
function fixtureData(): DiagramData {
    return {
        nodes: [{ id: "orders" }, { id: "customer" }, { id: "invoices" }],
        edges: [
            {
                id: "orders.fk_customer",
                source: "orders",
                target: "customer",
                sourcePort: portId("orders", "customer_id", "out"),
                targetPort: portId("customer", "id", "in"),
                data: fkData(["customer_id"], ["id"]),
            },
            {
                id: "invoices.fk_customer",
                source: "invoices",
                target: "customer",
                sourcePort: portId("invoices", "customer_id", "out"),
                targetPort: portId("customer", "id", "in"),
                data: fkData(["customer_id"], ["id"]),
            },
        ],
    };
}

describe("columnEmphasis", () => {
    it("clicking the merged-into referenced column returns every referencing edge and both far-end columns", () => {
        const result = columnEmphasis(fixtureData(), "customer", "id");

        expect(result.edgeIds).toEqual(["orders.fk_customer", "invoices.fk_customer"]);
        expect(result.columns.get("customer")).toEqual(["id"]);
        expect(result.columns.get("orders")).toEqual(["customer_id"]);
        expect(result.columns.get("invoices")).toEqual(["customer_id"]);
    });

    it("clicking the local FK column returns only its own edge and the referenced far-end column", () => {
        const result = columnEmphasis(fixtureData(), "orders", "customer_id");

        expect(result.edgeIds).toEqual(["orders.fk_customer"]);
        expect(result.columns.get("orders")).toEqual(["customer_id"]);
        expect(result.columns.get("customer")).toEqual(["id"]);
        expect(result.columns.has("invoices")).toBe(false);
    });

    it("clicking a plain column with no port highlights only the clicked row and attaches no edge", () => {
        const result = columnEmphasis(fixtureData(), "orders", "total");

        expect(result.edgeIds).toEqual([]);
        expect(result.columns.get("orders")).toEqual(["total"]);
        expect(result.columns.size).toBe(1);
    });

    it("clicking a node id absent from the graph still carries the clicked pair, with no edges", () => {
        const result = columnEmphasis(fixtureData(), "nonexistent", "foo");

        expect(result.edgeIds).toEqual([]);
        expect(result.columns.get("nonexistent")).toEqual(["foo"]);
    });

    it("an edge with no sourcePort is not attached at its source, even when columns[0] matches the clicked column", () => {
        const data: DiagramData = {
            nodes: [{ id: "orders" }, { id: "customer" }],
            edges: [{
                id: "orders.fk_customer",
                source: "orders",
                target: "customer",
                // No sourcePort: the local column was not fetched, so
                // applyCardMode never assigned one.
                targetPort: portId("customer", "id", "in"),
                data: fkData(["customer_id"], ["id"]),
            }],
        };

        const result = columnEmphasis(data, "orders", "customer_id");

        expect(result.edgeIds).toEqual([]);
        expect(result.columns.get("orders")).toEqual(["customer_id"]);
    });

    it("a column that is both an out port on one edge and an in port on another returns both edges", () => {
        const data: DiagramData = {
            nodes: [{ id: "orders" }, { id: "customer" }, { id: "region" }],
            edges: [
                {
                    id: "orders.fk_customer",
                    source: "orders",
                    target: "customer",
                    sourcePort: portId("orders", "customer_id", "out"),
                    targetPort: portId("customer", "id", "in"),
                    data: fkData(["customer_id"], ["id"]),
                },
                {
                    id: "customer.fk_region",
                    source: "customer",
                    target: "region",
                    sourcePort: portId("customer", "id", "out"),
                    targetPort: portId("region", "region_id", "in"),
                    data: fkData(["id"], ["region_id"]),
                },
            ],
        };

        const result = columnEmphasis(data, "customer", "id");

        expect(result.edgeIds).toEqual(["orders.fk_customer", "customer.fk_region"]);
        expect(result.columns.get("orders")).toEqual(["customer_id"]);
        expect(result.columns.get("region")).toEqual(["region_id"]);
    });

    it("does not mutate the input DiagramData", () => {
        const data = fixtureData();
        const before = JSON.stringify(data);

        columnEmphasis(data, "customer", "id");

        expect(JSON.stringify(data)).toBe(before);
    });
});
