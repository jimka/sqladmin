import { describe, it, expect } from "vitest";
import { buildSchemaDiagram } from "./buildSchemaDiagram";
import type { TableStructure, ForeignKeyMeta } from "../contract";

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

describe("buildSchemaDiagram", () => {
    it("emits one node per table with the table glyph", () => {
        const data = buildSchemaDiagram(["a", "b"], [structure(), structure()]);

        expect(data.nodes).toEqual([
            { id: "a", label: "a", glyph: "table" },
            { id: "b", label: "b", glyph: "table" },
        ]);
    });

    it("keeps an intra-schema edge", () => {
        const data = buildSchemaDiagram(
            ["a", "b"],
            [structure([fk("fk_ab", "b")]), structure()],
        );

        expect(data.edges).toEqual([{ id: "a.fk_ab", source: "a", target: "b" }]);
    });

    it("drops a dangling / cross-schema edge", () => {
        const data = buildSchemaDiagram(["a"], [structure([fk("fk_az", "z")])]);

        expect(data.edges).toEqual([]);
    });

    it("keeps a self-referential foreign key", () => {
        const data = buildSchemaDiagram(["a"], [structure([fk("fk_aa", "a")])]);

        expect(data.edges).toEqual([{ id: "a.fk_aa", source: "a", target: "a" }]);
    });

    it("returns an empty graph for an empty schema", () => {
        const data = buildSchemaDiagram([], []);

        expect(data.nodes).toEqual([]);
        expect(data.edges).toEqual([]);
        expect(data.layoutOptions).toEqual({ "elk.algorithm": "layered", "elk.direction": "RIGHT" });
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

        expect(data.layoutOptions).toEqual({ "elk.algorithm": "layered", "elk.direction": "RIGHT" });
    });
});
