import { describe, it, expect } from "vitest";
import { buildDatabaseDiagram, qualifiedId } from "./buildDatabaseDiagram";
import type { SchemaTables } from "./buildDatabaseDiagram";
import type { TableStructure, ForeignKeyMeta } from "../contract";

/** Build a minimal ForeignKeyMeta, filling in the fields these tests don't vary. */
function fk(name: string, refSchema: string, refTable: string): ForeignKeyMeta {
    return {
        name,
        columns   : ["x_id"],
        refSchema,
        refTable,
        refColumns: ["id"],
        onUpdate  : "NO ACTION",
        onDelete  : "NO ACTION",
    };
}

/** Build a minimal TableStructure carrying only the given foreign keys. */
function structure(foreignKeys: ForeignKeyMeta[] = []): TableStructure {
    return { indexes: [], constraints: [], foreignKeys };
}

describe("qualifiedId", () => {
    it("joins schema and table with a dot", () => {
        expect(qualifiedId("public", "users")).toBe("public.users");
    });
});

describe("buildDatabaseDiagram", () => {
    it("emits one leaf node per table, id = schema.table, label = bare table, data = {schema, table}", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["users"], structures: [structure()] },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.nodes).toEqual([
            { id: "a.users", label: "users", glyph: "table", data: { schema: "a", table: "users" } },
        ]);
    });

    it("keeps two schemas' same-named tables as distinct nodes", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["users"], structures: [structure()] },
            { schema: "b", tables: ["users"], structures: [structure()] },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.nodes.map(n => n.id)).toEqual(["a.users", "b.users"]);
    });

    it("keeps a cross-schema FK as an edge between the qualified ids", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["orders"], structures: [structure([fk("fk_customer", "b", "customers")])] },
            { schema: "b", tables: ["customers"], structures: [structure()] },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.edges).toEqual([{
            id    : "a.orders.fk_customer",
            source: "a.orders",
            target: "b.customers",
            data  : {
                columns   : ["x_id"],
                refColumns: ["id"],
                refSchema : "b",
                onUpdate  : "NO ACTION",
                onDelete  : "NO ACTION",
            },
        }]);
    });

    it("keeps a same-schema FK", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["orders", "customers"], structures: [structure([fk("fk_customer", "a", "customers")]), structure()] },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.edges.map(e => ({ source: e.source, target: e.target })))
            .toEqual([{ source: "a.orders", target: "a.customers" }]);
    });

    it("keeps a self-referential FK", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["nodes"], structures: [structure([fk("fk_parent", "a", "nodes")])] },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.edges.map(e => ({ source: e.source, target: e.target })))
            .toEqual([{ source: "a.nodes", target: "a.nodes" }]);
    });

    it("drops an FK whose refSchema.refTable is absent from the fetched set", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["orders"], structures: [structure([fk("fk_missing", "z", "ghost")])] },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.edges).toEqual([]);
    });

    it("keeps edge ids globally unique when two tables share an FK constraint name", () => {
        const schemas: SchemaTables[] = [
            {
                schema: "a",
                tables: ["orders", "invoices"],
                structures: [
                    structure([fk("fk_x", "a", "orders")]),
                    structure([fk("fk_x", "a", "orders")]),
                ],
            },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.edges.map(e => e.id)).toEqual(["a.orders.fk_x", "a.invoices.fk_x"]);
    });

    it("returns an empty graph for an empty database, still with layered/RIGHT layout options", () => {
        const data = buildDatabaseDiagram([]);

        expect(data.nodes).toEqual([]);
        expect(data.edges).toEqual([]);
        expect(data.layoutOptions).toEqual({ "elk.algorithm": "layered", "elk.direction": "RIGHT" });
    });
});
