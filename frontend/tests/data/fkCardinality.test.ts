import { describe, it, expect } from "vitest";
import type { DiagramData, DiagramEdgeData } from "@jimka/typescript-ui/component/diagram";
import type { ColumnMeta, ConstraintMeta, IndexMeta, TableStructure } from "../../src/contract";
import type { FkDetail, FkEdgeData } from "../../src/data/buildSchemaDiagram";
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
function fkGraph(fk: Partial<FkDetail> = {}): {
    data: DiagramData;
    childStructure: TableStructure;
} {
    const fkData: FkEdgeData = {
        fks: [{
            columns: ["parent_id"],
            refColumns: ["id"],
            refSchema: "public",
            onUpdate: "NO ACTION",
            onDelete: "NO ACTION",
            ...fk,
        }],
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

        expect((result.edges[0].data as FkEdgeData).fks[0].uncovered).toBe(true);
    });

    it("marks a covered FK edge uncovered:false", () => {
        const { data, childStructure } = fkGraph();
        const result = annotateFkCardinality(data, tables, [childStructure, structure()], columnsFor(false));

        expect((result.edges[0].data as FkEdgeData).fks[0].uncovered).toBe(false);
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
        expect((data.edges[0].data as FkEdgeData).fks[0].uncovered).toBeUndefined();
        expect(data.edges[0].style).toBeUndefined();
    });

    it("leaves an edge whose source table is missing from the maps without cardinality style", () => {
        const { data } = fkGraph();

        // Only "parent" is in the positional arrays -- "child" (the edge source) is absent.
        const result = annotateFkCardinality(data, ["parent"], [structure()], [[]]);

        expect(result.edges[0].style).toBeUndefined();
    });
});

describe("annotateFkCardinality on a folded (two-key) edge", () => {
    // The plan's worked example: orders has two foreign keys into addresses,
    // both referencing addresses(id). fk_billing is mandatory and covered with
    // an ON DELETE CASCADE; fk_shipping is optional, uncovered, and has no
    // referential action. Neither key is unique.
    function foldedGraph(): { data: DiagramData; ordersStructure: TableStructure } {
        const fkData: FkEdgeData = {
            fks: [
                { columns: ["billing_address_id"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "CASCADE" },
                { columns: ["shipping_address_id"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION" },
            ],
        };
        const edge: DiagramEdgeData = { id: "orders.fk_billing", source: "orders", target: "addresses", data: fkData };
        const data: DiagramData = {
            nodes: [{ id: "orders", label: "orders" }, { id: "addresses", label: "addresses" }],
            edges: [edge],
        };
        // Only billing_address_id is covered by an index; shipping_address_id is not.
        const ordersStructure = structure({ indexes: [index("CREATE INDEX i ON t USING btree (billing_address_id)")] });

        return { data, ordersStructure };
    }

    function foldedColumns(): ColumnMeta[][] {
        return [[column("billing_address_id", false), column("shipping_address_id", true)], []];
    }

    it("drops the start marker to zeroOrMany when the folded keys disagree on unique/mandatory", () => {
        const { data, ordersStructure } = foldedGraph();
        const result = annotateFkCardinality(data, ["orders", "addresses"], [ordersStructure, structure()], foldedColumns());

        expect(result.edges[0].style?.startMarker).toBe("zeroOrMany");
        expect(result.edges[0].style?.endMarker).toBe("one");
    });

    it("sets uncovered per key, so a covered + uncovered pair yields [false, true]", () => {
        const { data, ordersStructure } = foldedGraph();
        const result = annotateFkCardinality(data, ["orders", "addresses"], [ordersStructure, structure()], foldedColumns());

        expect((result.edges[0].data as FkEdgeData).fks.map(fk => fk.uncovered)).toEqual([false, true]);
    });

    it("omits the label when the folded keys' referential actions differ", () => {
        const { data, ordersStructure } = foldedGraph();
        const result = annotateFkCardinality(data, ["orders", "addresses"], [ordersStructure, structure()], foldedColumns());

        expect(result.edges[0].style?.label).toBeUndefined();
    });

    it("Expected Behaviour row 1: a unique+mandatory key folded with a non-unique+optional key drops to zeroOrMany", () => {
        // child.a_id -> parent(id): unique (a unique constraint matches it exactly),
        // mandatory, covered, ON DELETE CASCADE. child.b_id -> parent(id): not
        // unique (no constraint/index matches it), optional, uncovered, no label.
        const fkData: FkEdgeData = {
            fks: [
                { columns: ["a_id"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "CASCADE" },
                { columns: ["b_id"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION" },
            ],
        };
        const edge: DiagramEdgeData = { id: "child.fk_parent", source: "child", target: "parent", data: fkData };
        const data: DiagramData = {
            nodes: [{ id: "child", label: "child" }, { id: "parent", label: "parent" }],
            edges: [edge],
        };
        const childStructure = structure({ constraints: [constraint("unique", ["a_id"])] });
        const cols: ColumnMeta[][] = [[column("a_id", false), column("b_id", true)], []];

        const result = annotateFkCardinality(data, ["child", "parent"], [childStructure, structure()], cols);
        const outEdge = result.edges[0];

        expect(outEdge.style?.startMarker).toBe("zeroOrMany");
        expect((outEdge.data as FkEdgeData).fks.map(fk => fk.uncovered)).toEqual([false, true]);
        expect(outEdge.style?.label).toBeUndefined();
    });

    it("applyCoverageStyle tints the edge when at least one of the two folded keys is uncovered", () => {
        const { data, ordersStructure } = foldedGraph();
        const annotated = annotateFkCardinality(data, ["orders", "addresses"], [ordersStructure, structure()], foldedColumns());

        expect(applyCoverageStyle(annotated, true).edges[0].style?.stroke).toBeTruthy();
        expect(applyCoverageStyle(annotated, false).edges[0].style?.stroke).toBeUndefined();
    });

    it("keeps a unique/mandatory marker and a shared label when both folded keys fully agree", () => {
        const fkData: FkEdgeData = {
            fks: [
                { columns: ["a_id"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "CASCADE" },
                { columns: ["b_id"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "CASCADE" },
            ],
        };
        const edge: DiagramEdgeData = { id: "child.fk_parent", source: "child", target: "parent", data: fkData };
        const data: DiagramData = {
            nodes: [{ id: "child", label: "child" }, { id: "parent", label: "parent" }],
            edges: [edge],
        };
        const childStructure = structure({
            indexes: [
                index("CREATE INDEX i1 ON t USING btree (a_id)"),
                index("CREATE INDEX i2 ON t USING btree (b_id)"),
            ],
        });
        const cols: ColumnMeta[][] = [[column("a_id", false), column("b_id", false)], []];

        const result = annotateFkCardinality(data, ["child", "parent"], [childStructure, structure()], cols);
        const outEdge = result.edges[0];

        expect(outEdge.style?.startMarker).toBe("oneOrMany");
        expect((outEdge.data as FkEdgeData).fks.map(fk => fk.uncovered)).toEqual([false, false]);
        expect(outEdge.style?.label).toBe("ON DELETE CASCADE");
    });
});

describe("applyCoverageStyle", () => {
    function uncoveredEdge(): DiagramEdgeData {
        return {
            id: "e", source: "a", target: "b",
            data: { fks: [{ columns: ["a"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION", uncovered: true }] } satisfies FkEdgeData,
            style: { startMarker: "oneOrMany", endMarker: "one" },
        };
    }

    function coveredEdge(): DiagramEdgeData {
        return {
            id: "e2", source: "a", target: "b",
            data: { fks: [{ columns: ["a"], refColumns: ["id"], refSchema: "public", onUpdate: "NO ACTION", onDelete: "NO ACTION", uncovered: false }] } satisfies FkEdgeData,
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

    it("returns an edge whose data has no fks untouched rather than throwing", () => {
        const nonFkEdge: DiagramEdgeData = { id: "dep", source: "a", target: "b", data: { kind: "dependency" } };
        const data: DiagramData = { nodes: [], edges: [nonFkEdge] };

        expect(() => applyCoverageStyle(data, true)).not.toThrow();
        expect(applyCoverageStyle(data, true).edges[0]).toEqual(nonFkEdge);
    });
});
