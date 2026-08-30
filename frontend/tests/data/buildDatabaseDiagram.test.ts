import { describe, it, expect } from "vitest";
import { buildDatabaseDiagram, qualifiedId } from "../../src/data/buildDatabaseDiagram";
import type { SchemaTables } from "../../src/data/buildDatabaseDiagram";
import type { TableStructure, ForeignKeyMeta } from "../../src/contract";
import { uniformNodeWidth } from "../../src/data/uniformNodeWidth";

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
        const width = uniformNodeWidth(["users"]);

        expect(data.nodes).toEqual([
            { id: "a.users", label: "users", glyph: "table", width, data: { schema: "a", table: "users" } },
        ]);
    });

    it("gives every leaf the same width, sized to the widest bare table name", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["t", "a_considerably_longer_table_name"], structures: [structure(), structure()] },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.nodes[0].width).toBe(data.nodes[1].width);
        expect(data.nodes[0].width).toBe(uniformNodeWidth(["a_considerably_longer_table_name"]));
    });

    it("measures bare table names, not schema-qualified ids, for the width", () => {
        const schemas: SchemaTables[] = [
            { schema: "a_very_long_schema_name", tables: ["t"], structures: [structure()] },
        ];

        const data = buildDatabaseDiagram(schemas);

        // Only "t" (the bare table name) is measured — not "a_very_long_schema_name.t".
        expect(data.nodes[0].width).toBe(uniformNodeWidth(["t"]));
    });

    it("passes a stub measurer through to uniformNodeWidth, changing the width", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["users"], structures: [structure()] },
        ];

        const stub = (texts: string[]): number[] => texts.map(() => 500);
        const data = buildDatabaseDiagram(schemas, stub);

        expect(data.nodes[0].width).toBe(uniformNodeWidth(["users"], stub));
        expect(data.nodes[0].width).not.toBe(uniformNodeWidth(["users"]));
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
            data  : { fks: [{
                columns   : ["x_id"],
                refColumns: ["id"],
                refSchema : "b",
                onUpdate  : "NO ACTION",
                onDelete  : "NO ACTION",
            }] },
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

    it("folds two FKs between the same qualified table pair into one edge with both keys", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["orders"], structures: [structure([fk("fk1", "b", "customers"), fk("fk2", "b", "customers")])] },
            { schema: "b", tables: ["customers"], structures: [structure()] },
        ];

        const data = buildDatabaseDiagram(schemas);

        expect(data.edges).toHaveLength(1);
        expect(data.edges[0].id).toBe("a.orders.fk1");
        expect((data.edges[0].data as { fks: unknown[] }).fks).toHaveLength(2);
    });

    it("returns an empty graph for an empty database, still with layered/RIGHT layout options", () => {
        const data = buildDatabaseDiagram([]);

        expect(data.nodes).toEqual([]);
        expect(data.edges).toEqual([]);
        expect(data.layoutOptions).toEqual({
            "elk.algorithm": "layered",
            "elk.direction": "RIGHT",
        });
    });
});
