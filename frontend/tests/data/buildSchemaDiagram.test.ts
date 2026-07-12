import { describe, it, expect } from "vitest";
import { buildSchemaDiagram } from "./buildSchemaDiagram";
import { CARD_WIDTH, cardHeight, columnPortY, portId } from "./schemaCardModel";
import type { TableStructure, ForeignKeyMeta, ColumnMeta } from "../contract";

/** Build a minimal ForeignKeyMeta, filling in the fields these tests don't vary. */
function fk(name: string, refTable: string): ForeignKeyMeta {
    return {
        name,
        columns   : ["x_id"],
        refSchema : "public",
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

/** Build a minimal ColumnMeta, filling in the fields these tests don't vary. */
function column(name: string, isPrimaryKey = false): ColumnMeta {
    return { name, dataType: "text", nullable: false, isPrimaryKey, isGenerated: false, hasDefault: false, wireType: "string" };
}

describe("buildSchemaDiagram", () => {
    it("emits one node per table with the table glyph", () => {
        const data = buildSchemaDiagram(["a", "b"], [structure(), structure()]);

        expect(data.nodes).toEqual([
            { id: "a", label: "a", glyph: "table" },
            { id: "b", label: "b", glyph: "table" },
        ]);
    });

    it("keeps an intra-schema edge carrying the FK metadata", () => {
        const data = buildSchemaDiagram(
            ["a", "b"],
            [structure([fk("fk_ab", "b")]), structure()],
        );

        expect(data.edges).toEqual([{
            id    : "a.fk_ab",
            source: "a",
            target: "b",
            data  : {
                columns   : ["x_id"],
                refColumns: ["id"],
                refSchema : "public",
                onUpdate  : "NO ACTION",
                onDelete  : "NO ACTION",
            },
        }]);
    });

    it("carries the FK's local and referenced columns on the edge data", () => {
        const data = buildSchemaDiagram(
            ["a", "b"],
            [
                structure([{
                    name: "fk_multi", columns: ["p", "q"], refSchema: "public",
                    refTable: "b", refColumns: ["r", "s"], onUpdate: "CASCADE", onDelete: "SET NULL",
                }]),
                structure(),
            ],
        );

        expect(data.edges[0].data).toEqual({
            columns   : ["p", "q"],
            refColumns: ["r", "s"],
            refSchema : "public",
            onUpdate  : "CASCADE",
            onDelete  : "SET NULL",
        });
    });

    it("drops a dangling / cross-schema edge", () => {
        const data = buildSchemaDiagram(["a"], [structure([fk("fk_az", "z")])]);

        expect(data.edges).toEqual([]);
    });

    it("keeps a self-referential foreign key", () => {
        const data = buildSchemaDiagram(["a"], [structure([fk("fk_aa", "a")])]);

        expect(data.edges.map(e => ({ id: e.id, source: e.source, target: e.target })))
            .toEqual([{ id: "a.fk_aa", source: "a", target: "a" }]);
    });

    it("returns an empty graph for an empty schema", () => {
        const data = buildSchemaDiagram([], []);

        expect(data.nodes).toEqual([]);
        expect(data.edges).toEqual([]);
        expect(data.layoutOptions).toEqual({
            "elk.algorithm": "layered",
            "elk.direction": "RIGHT",
            "elk.layered.spacing.nodeNodeBetweenLayers": "120",
            "elk.spacing.nodeNode": "40",
        });
    });

    it("keeps edge ids unique across tables sharing an FK constraint name", () => {
        const data = buildSchemaDiagram(
            ["a", "b", "c"],
            [structure([fk("fk_x", "c")]), structure([fk("fk_x", "c")]), structure()],
        );

        expect(data.edges.map(e => e.id)).toEqual(["a.fk_x", "b.fk_x"]);
    });

    it("always sets the layered/RIGHT layout options", () => {
        const data = buildSchemaDiagram(["a"], [structure()]);

        expect(data.layoutOptions).toEqual({
            "elk.algorithm": "layered",
            "elk.direction": "RIGHT",
            "elk.layered.spacing.nodeNodeBetweenLayers": "120",
            "elk.spacing.nodeNode": "40",
        });
    });

    describe("card mode (columnsByTable present)", () => {
        it("gives each node its column rows, explicit size, and FIXED_POS port constraints", () => {
            const columnsByTable = new Map([
                ["a", [column("id", true), column("x_id")]],
                ["b", [column("id", true)]],
            ]);
            const data = buildSchemaDiagram(["a", "b"], [structure(), structure()], columnsByTable);

            const a = data.nodes.find(n => n.id === "a")!;
            const b = data.nodes.find(n => n.id === "b")!;

            expect(a.data).toEqual({ columns: [
                { name: "id", type: "text", pk: true, fk: false, nullable: false, generated: false, hasDefault: false },
                { name: "x_id", type: "text", pk: false, fk: false, nullable: false, generated: false, hasDefault: false },
            ] });
            expect(a.width).toBe(CARD_WIDTH);
            expect(a.height).toBe(cardHeight(2));
            expect(a.layoutOptions).toEqual({ "elk.portConstraints": "FIXED_POS" });

            expect(b.height).toBe(cardHeight(1));
        });

        it("anchors a single-column FK to matching EAST/WEST ports at the right row", () => {
            const columnsByTable = new Map([
                ["a", [column("id", true), column("x_id")]],
                ["b", [column("id", true)]],
            ]);
            const data = buildSchemaDiagram(
                ["a", "b"],
                [structure([fk("fk_ab", "b")]), structure()],
                columnsByTable,
            );

            const a = data.nodes.find(n => n.id === "a")!;
            const b = data.nodes.find(n => n.id === "b")!;

            expect(a.ports).toEqual([
                { id: portId("a", "x_id", "out"), x: CARD_WIDTH - 1, y: columnPortY(1), width: 1, height: 1, side: "EAST" },
            ]);
            expect(b.ports).toEqual([
                { id: portId("b", "id", "in"), x: 0, y: columnPortY(0), width: 1, height: 1, side: "WEST" },
            ]);

            const edge = data.edges[0];

            expect(edge.sourcePort).toBe(portId("a", "x_id", "out"));
            expect(edge.targetPort).toBe(portId("b", "id", "in"));
        });

        it("anchors a composite FK to its first column pair only", () => {
            const columnsByTable = new Map([
                ["a", [column("p"), column("q")]],
                ["b", [column("r"), column("s")]],
            ]);
            const data = buildSchemaDiagram(
                ["a", "b"],
                [structure([{
                    name: "fk_multi", columns: ["p", "q"], refSchema: "public",
                    refTable: "b", refColumns: ["r", "s"], onUpdate: "CASCADE", onDelete: "SET NULL",
                }]), structure()],
                columnsByTable,
            );

            const a = data.nodes.find(n => n.id === "a")!;
            const b = data.nodes.find(n => n.id === "b")!;

            expect(a.ports).toEqual([{ id: portId("a", "p", "out"), x: CARD_WIDTH - 1, y: columnPortY(0), width: 1, height: 1, side: "EAST" }]);
            expect(b.ports).toEqual([{ id: portId("b", "r", "in"), x: 0, y: columnPortY(0), width: 1, height: 1, side: "WEST" }]);
        });

        it("gives a self-referential FK both an out- and an in-port on the one node", () => {
            const columnsByTable = new Map([["a", [column("id", true), column("parent_id")]]]);
            const data = buildSchemaDiagram(
                ["a"],
                [structure([{
                    name: "fk_self", columns: ["parent_id"], refSchema: "public",
                    refTable: "a", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION",
                }])],
                columnsByTable,
            );

            const a = data.nodes[0];

            expect(a.ports).toEqual(expect.arrayContaining([
                { id: portId("a", "parent_id", "out"), x: CARD_WIDTH - 1, y: columnPortY(1), width: 1, height: 1, side: "EAST" },
                { id: portId("a", "id", "in"), x: 0, y: columnPortY(0), width: 1, height: 1, side: "WEST" },
            ]));
            expect(a.ports).toHaveLength(2);
        });

        it("leaves sourcePort undefined and emits no port when the FK's local column isn't in the fetched columns", () => {
            const columnsByTable = new Map([
                ["a", [column("id", true)]], // x_id (the FK's local column) is absent
                ["b", [column("id", true)]],
            ]);
            const data = buildSchemaDiagram(["a", "b"], [structure([fk("fk_ab", "b")]), structure()], columnsByTable);

            const a = data.nodes.find(n => n.id === "a")!;

            expect(a.ports).toBeUndefined();
            expect(data.edges[0].sourcePort).toBeUndefined();
            expect(data.edges[0].targetPort).toBe(portId("b", "id", "in"));
        });

        it("leaves the flat path (no columnsByTable) unchanged: no ports, no data, no explicit size", () => {
            const data = buildSchemaDiagram(["a", "b"], [structure([fk("fk_ab", "b")]), structure()]);

            expect(data.nodes).toEqual([
                { id: "a", label: "a", glyph: "table" },
                { id: "b", label: "b", glyph: "table" },
            ]);
            expect(data.edges[0].sourcePort).toBeUndefined();
            expect(data.edges[0].targetPort).toBeUndefined();
        });
    });
});
