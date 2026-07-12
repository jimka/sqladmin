import { describe, it, expect } from "vitest";
import { buildSchemaOverviewDiagram } from "../../src/data/schemaOverviewDiagram";
import type { SchemaTables } from "../../src/data/buildDatabaseDiagram";
import type { TableStructure, ForeignKeyMeta } from "../../src/contract";

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

describe("buildSchemaOverviewDiagram", () => {
    it("emits one node per schema, id = label = schema name", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: [], structures: [] },
            { schema: "b", tables: [], structures: [] },
        ];

        const data = buildSchemaOverviewDiagram(schemas);

        expect(data.nodes).toEqual([
            { id: "a", label: "a" },
            { id: "b", label: "b" },
        ]);
    });

    it("emits an edge S -> T when >=1 FK in S references a table in T != S, labelled with the count", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["orders"], structures: [structure([fk("fk1", "b", "customers")])] },
            { schema: "b", tables: ["customers"], structures: [structure()] },
        ];

        const data = buildSchemaOverviewDiagram(schemas);

        expect(data.edges).toEqual([{ id: "a->b", source: "a", target: "b", label: "1", data: { count: 1 } }]);
    });

    it("aggregates multiple cross-schema FKs between the same ordered pair into one edge with the summed count", () => {
        const schemas: SchemaTables[] = [
            {
                schema: "a",
                tables: ["orders", "invoices"],
                structures: [
                    structure([fk("fk1", "b", "customers")]),
                    structure([fk("fk2", "b", "customers"), fk("fk3", "b", "customers")]),
                ],
            },
            { schema: "b", tables: ["customers"], structures: [structure()] },
        ];

        const data = buildSchemaOverviewDiagram(schemas);

        expect(data.edges).toEqual([{ id: "a->b", source: "a", target: "b", label: "3", data: { count: 3 } }]);
    });

    it("contributes no overview edge for an intra-schema FK", () => {
        const schemas: SchemaTables[] = [
            { schema: "a", tables: ["orders", "customers"], structures: [structure([fk("fk1", "a", "customers")]), structure()] },
        ];

        const data = buildSchemaOverviewDiagram(schemas);

        expect(data.edges).toEqual([]);
    });

    it("returns nodes but no edges for an empty / single-schema-with-no-cross-FK database", () => {
        const empty = buildSchemaOverviewDiagram([]);
        expect(empty.nodes).toEqual([]);
        expect(empty.edges).toEqual([]);

        const single = buildSchemaOverviewDiagram([{ schema: "a", tables: ["x"], structures: [structure()] }]);
        expect(single.nodes).toEqual([{ id: "a", label: "a" }]);
        expect(single.edges).toEqual([]);
    });
});
