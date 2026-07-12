import { describe, it, expect } from "vitest";
import { buildRelationGraph, relationNodeId } from "../../src/data/buildRelationGraph";
import type { RelationEdge, RelationNodeRef } from "../../src/contract";

const LAYOUT = { "elk.algorithm": "layered", "elk.direction": "RIGHT" };

/** Build a minimal RelationNodeRef. */
function ref(schema: string, name: string, kind: RelationNodeRef["kind"] = "table"): RelationNodeRef {
    return { schema, name, kind };
}

/** Build a minimal RelationEdge between two same-schema relations. */
function edge(source: RelationNodeRef, target: RelationNodeRef): RelationEdge {
    return { source, target };
}

describe("relationNodeId", () => {
    it("joins schema and name with a dot", () => {
        expect(relationNodeId({ schema: "s", name: "t", kind: "table" })).toBe("s.t");
    });
});

describe("buildRelationGraph", () => {
    it("dedupes shared endpoints into one node per relation", () => {
        const edges = [
            edge(ref("home", "a"), ref("home", "b")),
            edge(ref("home", "a"), ref("home", "c")),
        ];

        const data = buildRelationGraph(edges, "home", LAYOUT);

        expect(data.nodes.map(n => n.id)).toEqual(["home.a", "home.b", "home.c"]);
        expect(data.nodes.map(n => n.label)).toEqual(["a", "b", "c"]);
    });

    it("labels a foreign-schema node as schema.name", () => {
        const edges = [edge(ref("home", "a"), ref("other", "z"))];

        const data = buildRelationGraph(edges, "home", LAYOUT);
        const foreign = data.nodes.find(n => n.id === "other.z");

        expect(foreign?.label).toBe("other.z");
    });

    it("maps each kind to its glyph", () => {
        const edges = [
            edge(ref("home", "a", "view"), ref("home", "b", "table")),
            edge(ref("home", "a", "view"), ref("home", "c", "materializedView")),
        ];

        const data = buildRelationGraph(edges, "home", LAYOUT);
        const glyphOf = (id: string): string | undefined => data.nodes.find(n => n.id === id)?.glyph;

        expect(glyphOf("home.a")).toBe("eye");
        expect(glyphOf("home.b")).toBe("table");
        expect(glyphOf("home.c")).toBe("layer-group");
    });

    it("carries a RelationNodeData on each node's data", () => {
        const edges = [edge(ref("home", "a", "view"), ref("other", "b", "table"))];

        const data = buildRelationGraph(edges, "home", LAYOUT);

        expect(data.nodes.find(n => n.id === "home.a")?.data).toEqual({ schema: "home", name: "a", kind: "view" });
        expect(data.nodes.find(n => n.id === "other.b")?.data).toEqual({ schema: "other", name: "b", kind: "table" });
    });

    it("builds an edge id from the node ids and preserves orientation", () => {
        const edges = [edge(ref("home", "a"), ref("home", "b"))];

        const data = buildRelationGraph(edges, "home", LAYOUT);

        expect(data.edges).toEqual([{ id: "home.a->home.b", source: "home.a", target: "home.b" }]);
    });

    it("dedupes two identical (source,target) edges into one", () => {
        const edges = [
            edge(ref("home", "a"), ref("home", "b")),
            edge(ref("home", "a"), ref("home", "b")),
        ];

        const data = buildRelationGraph(edges, "home", LAYOUT);

        expect(data.edges).toHaveLength(1);
    });

    it("returns an empty graph with layoutOptions passed through for no edges", () => {
        const data = buildRelationGraph([], "home", LAYOUT);

        expect(data.nodes).toEqual([]);
        expect(data.edges).toEqual([]);
        expect(data.layoutOptions).toEqual(LAYOUT);
    });

    it("omits edge style when dashed is not requested", () => {
        const edges = [edge(ref("home", "a"), ref("home", "b"))];

        const data = buildRelationGraph(edges, "home", LAYOUT);

        expect(data.edges[0].style).toBeUndefined();
    });

    it("sets style.dashed on every edge when dashed=true", () => {
        const edges = [
            edge(ref("home", "a"), ref("home", "b")),
            edge(ref("home", "a"), ref("home", "c")),
        ];

        const data = buildRelationGraph(edges, "home", LAYOUT, true);

        expect(data.edges.every(e => e.style?.dashed === true)).toBe(true);
    });
});
