import { describe, it, expect } from "vitest";
import type { DiagramData, DiagramEdgeData } from "@jimka/typescript-ui/component/diagram";
import type { ColumnMeta, ConstraintMeta, IndexMeta, TableStructure } from "../../src/contract";
import type { FkEdgeData } from "../../src/data/buildSchemaDiagram";
import {
    parseIndexColumns,
    isFkUnique,
    isFkMandatory,
    isFkCovered,
    annotateFkCardinality,
    applyCoverageStyle,
} from "../../src/data/fkCardinality";

/** Build a minimal ColumnMeta, filling in the fields these tests don't vary. */
function column(name: string, nullable: boolean): ColumnMeta {
    return { name, dataType: "text", nullable, isPrimaryKey: false, isGenerated: false, hasDefault: false, wireType: "string" };
}

/** Build a minimal ConstraintMeta. */
function constraint(type: ConstraintMeta["type"], columns: string[]): ConstraintMeta {
    return { name: `${type}_c`, type, columns, definition: "" };
}

/** Build a minimal IndexMeta from a raw CREATE INDEX definition string. */
function index(definition: string, unique = false): IndexMeta {
    return { name: "idx", definition, unique, primary: false };
}

/** Build a minimal TableStructure. */
function structure(overrides: Partial<TableStructure> = {}): TableStructure {
    return { indexes: [], constraints: [], foreignKeys: [], ...overrides };
}

describe("parseIndexColumns", () => {
    it("parses a plain btree column list", () => {
        expect(parseIndexColumns("CREATE INDEX i ON public.t USING btree (a, b)")).toEqual(["a", "b"]);
    });

    it("strips DESC / NULLS FIRST modifiers", () => {
        expect(parseIndexColumns("CREATE UNIQUE INDEX i ON t USING btree (a DESC, b NULLS FIRST)")).toEqual(["a", "b"]);
    });

    it("unquotes a quoted mixed-case identifier", () => {
        expect(parseIndexColumns('CREATE INDEX i ON t USING btree ("MixedCase", b)')).toEqual(["MixedCase", "b"]);
    });

    it("returns null for an expression index", () => {
        expect(parseIndexColumns("CREATE INDEX i ON t USING btree (lower(email))")).toBeNull();
    });

    it("ignores a trailing WHERE clause on a partial index", () => {
        expect(parseIndexColumns("CREATE INDEX i ON t USING btree (a) WHERE deleted = false")).toEqual(["a"]);
    });
});

describe("isFkUnique", () => {
    it("true for a unique constraint matching the FK columns", () => {
        expect(isFkUnique(["a"], structure({ constraints: [constraint("unique", ["a"])] }))).toBe(true);
    });

    it("true for a primary key constraint matching the FK columns", () => {
        expect(isFkUnique(["a"], structure({ constraints: [constraint("primaryKey", ["a"])] }))).toBe(true);
    });

    it("true for a unique index over exactly the FK columns", () => {
        const structureWithIndex = structure({ indexes: [index("CREATE UNIQUE INDEX i ON t USING btree (a)", true)] });

        expect(isFkUnique(["a"], structureWithIndex)).toBe(true);
    });

    it("false when the unique constraint is a superset of the FK columns", () => {
        expect(isFkUnique(["a"], structure({ constraints: [constraint("unique", ["a", "b"])] }))).toBe(false);
    });

    it("true for an order-insensitive set match on a composite FK", () => {
        expect(isFkUnique(["a", "b"], structure({ constraints: [constraint("unique", ["b", "a"])] }))).toBe(true);
    });

    it("false with no unique constraint or index", () => {
        expect(isFkUnique(["a"], structure())).toBe(false);
    });
});

describe("isFkMandatory", () => {
    it("true when every FK column is NOT NULL", () => {
        expect(isFkMandatory(["a", "b"], [column("a", false), column("b", false)])).toBe(true);
    });

    it("false when any FK column is nullable", () => {
        expect(isFkMandatory(["a"], [column("a", true)])).toBe(false);
    });

    it("false for a composite FK with one nullable member", () => {
        expect(isFkMandatory(["a", "b"], [column("a", false), column("b", true)])).toBe(false);
    });
});

describe("isFkCovered", () => {
    it("true when a plain index has the FK columns as a leading prefix", () => {
        const s = structure({ indexes: [index("CREATE INDEX i ON t USING btree (a, b)")] });

        expect(isFkCovered(["a"], s)).toBe(true);
    });

    it("false when the index covers fewer columns than the FK", () => {
        const s = structure({ indexes: [index("CREATE INDEX i ON t USING btree (a)")] });

        expect(isFkCovered(["a", "b"], s)).toBe(false);
    });

    it("true when the index is a prefix superset of the FK columns", () => {
        const s = structure({ indexes: [index("CREATE INDEX i ON t USING btree (a, b, c)")] });

        expect(isFkCovered(["a", "b"], s)).toBe(true);
    });

    it("false when the index columns are in the wrong order", () => {
        const s = structure({ indexes: [index("CREATE INDEX i ON t USING btree (b, a)")] });

        expect(isFkCovered(["a", "b"], s)).toBe(false);
    });

    it("true when a PK/unique constraint covers the FK columns", () => {
        expect(isFkCovered(["a"], structure({ constraints: [constraint("primaryKey", ["a"])] }))).toBe(true);
    });

    it("false when only an unparseable expression index exists", () => {
        const s = structure({ indexes: [index("CREATE INDEX i ON t USING btree (lower(email))")] });

        expect(isFkCovered(["a"], s)).toBe(false);
    });
});

/** A one-edge DiagramData: table "child" FK-references table "parent". */
function fkGraph(fk: Partial<FkEdgeData> = {}): {
    data: DiagramData;
    childStructure: TableStructure;
} {
    const fkData: FkEdgeData = {
        columns: ["parent_id"],
        refColumns: ["id"],
        refSchema: "public",
        onUpdate: "NO ACTION",
        onDelete: "NO ACTION",
        ...fk,
    };

    const edge: DiagramEdgeData = { id: "child.fk_parent", source: "child", target: "parent", data: fkData };

    const data: DiagramData = {
        nodes: [{ id: "child", label: "child" }, { id: "parent", label: "parent" }],
        edges: [edge],
    };

    const childStructure = structure({
        constraints: [constraint("primaryKey", ["parent_id"])], // unique by default; overridden per test
    });

    return { data, childStructure };
}

describe("annotateFkCardinality", () => {
    const tables = ["child", "parent"];

    function columnsFor(nullable: boolean): ColumnMeta[][] {
        return [[column("parent_id", nullable)], []];
    }

    it("unique + mandatory FK gets a one/one marker pair", () => {
        const { data, childStructure } = fkGraph();
        const result = annotateFkCardinality(data, tables, [childStructure, structure()], columnsFor(false));
        const edge = result.edges[0];

        expect(edge.style?.startMarker).toBe("one");
        expect(edge.style?.endMarker).toBe("one");
    });

    it("non-unique + optional FK gets a zeroOrMany start marker", () => {
        const { data } = fkGraph();
        // No unique constraint/index on parent_id -> not unique; nullable -> optional.
        const result = annotateFkCardinality(data, tables, [structure(), structure()], columnsFor(true));

        expect(result.edges[0].style?.startMarker).toBe("zeroOrMany");
    });

    it("unique + optional FK gets a zeroOrOne start marker", () => {
        const { data, childStructure } = fkGraph();
        const result = annotateFkCardinality(data, tables, [childStructure, structure()], columnsFor(true));

        expect(result.edges[0].style?.startMarker).toBe("zeroOrOne");
    });

    it("non-unique + mandatory FK gets an oneOrMany start marker", () => {
        const { data } = fkGraph();
        const result = annotateFkCardinality(data, tables, [structure(), structure()], columnsFor(false));

        expect(result.edges[0].style?.startMarker).toBe("oneOrMany");
    });

    it("marks an uncovered FK edge (no covering index) uncovered:true", () => {
        const { data } = fkGraph();
        const result = annotateFkCardinality(data, tables, [structure(), structure()], columnsFor(false));

        expect((result.edges[0].data as FkEdgeData).uncovered).toBe(true);
    });

    it("marks a covered FK edge uncovered:false", () => {
        const { data, childStructure } = fkGraph();
        const result = annotateFkCardinality(data, tables, [childStructure, structure()], columnsFor(false));

        expect((result.edges[0].data as FkEdgeData).uncovered).toBe(false);
    });

    it("includes a referential-action label when onDelete is not NO ACTION", () => {
        const { data, childStructure } = fkGraph({ onDelete: "CASCADE" });
        const result = annotateFkCardinality(data, tables, [childStructure, structure()], columnsFor(false));

        expect(result.edges[0].style?.label).toContain("ON DELETE CASCADE");
    });

    it("omits the label when both referential actions are NO ACTION", () => {
        const { data, childStructure } = fkGraph();
        const result = annotateFkCardinality(data, tables, [childStructure, structure()], columnsFor(false));

        expect(result.edges[0].style?.label).toBeUndefined();
    });

    it("does not mutate the input DiagramData", () => {
        const { data, childStructure } = fkGraph();
        const originalEdge = data.edges[0];

        annotateFkCardinality(data, tables, [childStructure, structure()], columnsFor(false));

        expect(data.edges[0]).toBe(originalEdge);
        expect((data.edges[0].data as FkEdgeData).uncovered).toBeUndefined();
        expect(data.edges[0].style).toBeUndefined();
    });

    it("leaves an edge whose source table is missing from the maps without cardinality style", () => {
        const { data } = fkGraph();

        // Only "parent" is in the positional arrays -- "child" (the edge source) is absent.
        const result = annotateFkCardinality(data, ["parent"], [structure()], [[]]);

        expect(result.edges[0].style).toBeUndefined();
    });
});

describe("applyCoverageStyle", () => {
    function uncoveredEdge(): DiagramEdgeData {
        return {
            id: "e", source: "a", target: "b",
            data: { columns: ["a"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION", uncovered: true } satisfies FkEdgeData,
            style: { startMarker: "oneOrMany", endMarker: "one" },
        };
    }

    function coveredEdge(): DiagramEdgeData {
        return {
            id: "e2", source: "a", target: "b",
            data: { columns: ["a"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION", uncovered: false } satisfies FkEdgeData,
            style: { startMarker: "one", endMarker: "one" },
        };
    }

    it("show:true tints an uncovered FK edge's stroke while preserving its cardinality markers", () => {
        const data: DiagramData = { nodes: [], edges: [uncoveredEdge()] };
        const result = applyCoverageStyle(data, true);
        const edge = result.edges[0];

        expect(edge.style?.stroke).toBeTruthy();
        expect(edge.style?.startMarker).toBe("oneOrMany");
        expect(edge.style?.endMarker).toBe("one");
    });

    it("show:true leaves a covered FK edge's stroke unchanged", () => {
        const data: DiagramData = { nodes: [], edges: [coveredEdge()] };
        const result = applyCoverageStyle(data, true);

        expect(result.edges[0].style?.stroke).toBeUndefined();
        expect(result.edges[0].style?.startMarker).toBe("one");
    });

    it("show:false applies no warning stroke to any edge", () => {
        const data: DiagramData = { nodes: [], edges: [uncoveredEdge(), coveredEdge()] };
        const result = applyCoverageStyle(data, false);

        expect(result.edges.every(e => e.style?.stroke === undefined)).toBe(true);
    });

    it("does not mutate the input DiagramData", () => {
        const data: DiagramData = { nodes: [], edges: [uncoveredEdge()] };
        const originalEdge = data.edges[0];

        applyCoverageStyle(data, true);

        expect(data.edges[0]).toBe(originalEdge);
        expect(data.edges[0].style?.stroke).toBeUndefined();
    });
});
