import { describe, it, expect } from "vitest";
import { buildSchemaDiagram, collapseParallelFkEdges } from "../../src/data/buildSchemaDiagram";
import type { DiagramEdgeData } from "@jimka/typescript-ui/component/diagram";
import type { FkEdgeData } from "../../src/data/buildSchemaDiagram";
import { CARD_WIDTH, cardHeight, columnPortY, portId } from "../../src/data/schemaCardModel";
import { uniformNodeWidth } from "../../src/data/uniformNodeWidth";
import type { TableStructure, ForeignKeyMeta, ColumnMeta } from "../../src/contract";

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
    it("emits one node per table with the table glyph and one shared width", () => {
        const data = buildSchemaDiagram(["a", "b"], [structure(), structure()]);
        const width = uniformNodeWidth(["a", "b"]);

        expect(data.nodes).toEqual([
            { id: "a", label: "a", glyph: "table", width },
            { id: "b", label: "b", glyph: "table", width },
        ]);
    });

    it("widens every node together when one table name is long", () => {
        const data = buildSchemaDiagram(["a", "a_considerably_longer_name"], [structure(), structure()]);

        // Every node in a layer must share an edge to read as a column, so the
        // longest label sets the width for all of them, not just its own node.
        expect(data.nodes[0].width).toBe(data.nodes[1].width);
        expect(data.nodes[0].width).toBe(uniformNodeWidth(["a_considerably_longer_name"]));
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
            data  : { fks: [{
                columns   : ["x_id"],
                refColumns: ["id"],
                refSchema : "public",
                onUpdate  : "NO ACTION",
                onDelete  : "NO ACTION",
            }] },
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

        expect(data.edges[0].data).toEqual({ fks: [{
            columns   : ["p", "q"],
            refColumns: ["r", "s"],
            refSchema : "public",
            onUpdate  : "CASCADE",
            onDelete  : "SET NULL",
        }] });
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
            "elk.layered.spacing.nodeNodeBetweenLayers": "60",
            "elk.spacing.nodeNode": "40",
            // Widened from ELK's default 10 so a junction stub can sit past the
            // 18-unit crow's-foot glyph and still stop short of the first bend.
            "elk.spacing.edgeNode": "40",
            "elk.layered.spacing.edgeNodeBetweenLayers": "40",
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
            "elk.layered.spacing.nodeNodeBetweenLayers": "60",
            "elk.spacing.nodeNode": "40",
            // Widened from ELK's default 10 so a junction stub can sit past the
            // 18-unit crow's-foot glyph and still stop short of the first bend.
            "elk.spacing.edgeNode": "40",
            "elk.layered.spacing.edgeNodeBetweenLayers": "40",
        });
    });

    describe("folding parallel foreign keys (flat mode)", () => {
        it("folds two FKs between the same table pair into one edge, keeping the first id and both keys", () => {
            const data = buildSchemaDiagram(
                ["a", "b"],
                [structure([fk("fk1", "b"), fk("fk2", "b")]), structure()],
            );

            expect(data.edges).toHaveLength(1);
            expect(data.edges[0].id).toBe("a.fk1");
            expect((data.edges[0].data as { fks: unknown[] }).fks).toHaveLength(2);
        });

        it("does not fold FKs to different targets", () => {
            const data = buildSchemaDiagram(
                ["a", "b", "c"],
                [structure([fk("fk1", "b"), fk("fk2", "c")]), structure(), structure()],
            );

            expect(data.edges).toHaveLength(2);
        });

        it("does not fold FKs from different sources to the same target", () => {
            const data = buildSchemaDiagram(
                ["a", "b", "c"],
                [structure([fk("fk1", "c")]), structure([fk("fk1", "c")]), structure()],
            );

            expect(data.edges.map(e => e.id)).toEqual(["a.fk1", "b.fk1"]);
        });

        it("does not fold a pair the other way round: a->b and b->a stay two edges", () => {
            const data = buildSchemaDiagram(
                ["a", "b"],
                [structure([fk("fk1", "b")]), structure([fk("fk1", "a")])],
            );

            expect(data.edges).toHaveLength(2);
        });

        it("folds two self-referential foreign keys on the same table", () => {
            const data = buildSchemaDiagram(["a"], [structure([fk("fk1", "a"), fk("fk2", "a")])]);

            expect(data.edges).toHaveLength(1);
            expect(data.edges[0].id).toBe("a.fk1");
            expect((data.edges[0].data as { fks: unknown[] }).fks).toHaveLength(2);
        });

        it("returns an empty list when given no edges", () => {
            expect(collapseParallelFkEdges([])).toEqual([]);
        });

        it("keeps folded keys in first-seen (declaration) order", () => {
            const data = buildSchemaDiagram(
                ["a", "b"],
                [structure([
                    { name: "fk1", columns: ["x1"], refSchema: "public", refTable: "b", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION" },
                    { name: "fk2", columns: ["x2"], refSchema: "public", refTable: "b", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION" },
                ]), structure()],
            );

            expect(data.edges).toHaveLength(1);
            expect((data.edges[0].data as FkEdgeData).fks.map(fk => fk.columns[0])).toEqual(["x1", "x2"]);
        });
    });

    describe("collapseParallelFkEdges", () => {
        function fkEdge(id: string, source: string, target: string, localCol: string): DiagramEdgeData {
            return {
                id, source, target,
                data: { fks: [{ columns: [localCol], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION" }] } satisfies FkEdgeData,
            };
        }

        it("does not mutate the input array or its edge objects", () => {
            const edges = [fkEdge("a.fk1", "a", "b", "x1"), fkEdge("a.fk2", "a", "b", "x2")];
            const originalFirst = edges[0];

            const result = collapseParallelFkEdges(edges);

            expect(edges).toHaveLength(2);
            expect(edges[0]).toBe(originalFirst);
            expect((edges[0].data as FkEdgeData).fks).toHaveLength(1);
            expect(result[0]).not.toBe(originalFirst);
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

        it("card mode and flat mode share one layout-options map", () => {
            const tables = ["a"];
            const structures = [structure()];
            const columnsByTable = new Map([["a", [column("id", true)]]]);

            const card = buildSchemaDiagram(tables, structures, columnsByTable);
            const flat = buildSchemaDiagram(tables, structures);

            expect(card.layoutOptions).toBe(flat.layoutOptions);
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

        it("does not fold parallel FKs in card mode: each keeps its own ports", () => {
            const columnsByTable = new Map([
                ["a", [column("id", true), column("x1"), column("x2")]],
                ["b", [column("id", true)]],
            ]);
            const data = buildSchemaDiagram(
                ["a", "b"],
                [structure([
                    { name: "fk1", columns: ["x1"], refSchema: "public", refTable: "b", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION" },
                    { name: "fk2", columns: ["x2"], refSchema: "public", refTable: "b", refColumns: ["id"], onUpdate: "NO ACTION", onDelete: "NO ACTION" },
                ]), structure()],
                columnsByTable,
            );

            expect(data.edges).toHaveLength(2);

            for (const edge of data.edges) {
                expect((edge.data as { fks: unknown[] }).fks).toHaveLength(1);
            }

            expect(data.edges[0].sourcePort).toBe(portId("a", "x1", "out"));
            expect(data.edges[1].sourcePort).toBe(portId("a", "x2", "out"));
            expect(data.edges[0].targetPort).toBe(portId("b", "id", "in"));
            expect(data.edges[1].targetPort).toBe(portId("b", "id", "in"));
        });

        it("leaves the flat path (no columnsByTable) with no ports, no data, and no height", () => {
            const data = buildSchemaDiagram(["a", "b"], [structure([fk("fk_ab", "b")]), structure()]);
            const width = uniformNodeWidth(["a", "b"]);

            // Flat mode carries a width — one shared value so a layer's nodes
            // line up — but nothing else card mode adds: the height still comes
            // from the rendered node, and there are no ports or column data.
            expect(data.nodes).toEqual([
                { id: "a", label: "a", glyph: "table", width },
                { id: "b", label: "b", glyph: "table", width },
            ]);
            expect(data.nodes[0].height).toBeUndefined();
            expect(data.nodes[0].layoutOptions).toBeUndefined();
            expect(data.edges[0].sourcePort).toBeUndefined();
            expect(data.edges[0].targetPort).toBeUndefined();
        });
    });
});
