import { describe, it, expect } from "vitest";
import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { reachableNodeIds, subgraph, rootedDiagram, applyHide } from "../../src/data/relationDiagram";

/** A bare node with matching id/label. */
function node(id: string): DiagramNodeData {
    return { id, label: id, glyph: "table" };
}

/** A directed edge `source -> target` with the schema-diagram id convention. */
function edge(source: string, target: string, name: string): DiagramEdgeData {
    return { id: `${source}.${name}`, source, target };
}

// a -> b -> c, and d -> a. Layout options carried to assert passthrough.
function graph(): DiagramData {
    return {
        nodes: [node("a"), node("b"), node("c"), node("d")],
        edges: [edge("a", "b", "f1"), edge("b", "c", "f2"), edge("d", "a", "f3")],
        layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
    };
}

/** Sorted id array from a set, for order-independent comparison. */
function ids(set: Set<string>): string[] {
    return [...set].sort();
}

describe("reachableNodeIds", () => {
    const g = graph();

    it("walks downstream to the depth limit", () => {
        expect(ids(reachableNodeIds(g.edges, "a", "downstream", 1))).toEqual(["a", "b"]);
        expect(ids(reachableNodeIds(g.edges, "a", "downstream", 2))).toEqual(["a", "b", "c"]);
    });

    it("walks upstream (reverse FK) to the depth limit", () => {
        expect(ids(reachableNodeIds(g.edges, "a", "upstream", 1))).toEqual(["a", "d"]);
    });

    it("walks both directions", () => {
        expect(ids(reachableNodeIds(g.edges, "a", "both", 1))).toEqual(["a", "b", "d"]);
    });

    it("includes the root at depth 0", () => {
        expect(ids(reachableNodeIds(g.edges, "a", "both", 0))).toEqual(["a"]);
    });

    it("follows a self-referential edge without looping", () => {
        const self = [edge("a", "a", "f0")];

        expect(ids(reachableNodeIds(self, "a", "both", 3))).toEqual(["a"]);
    });

    it("never enters an excluded node", () => {
        expect(ids(reachableNodeIds(g.edges, "a", "downstream", Number.POSITIVE_INFINITY, new Set(["b"]))))
            .toEqual(["a"]);
    });

    it("returns an empty set when the root itself is excluded", () => {
        expect(reachableNodeIds(g.edges, "a", "both", Number.POSITIVE_INFINITY, new Set(["a"])).size).toBe(0);
    });
});

describe("subgraph", () => {
    it("keeps only kept nodes and edges with both endpoints kept", () => {
        const g = graph();
        const out = subgraph(g, new Set(["a", "b"]));

        expect(out.nodes.map(n => n.id)).toEqual(["a", "b"]);
        expect(out.edges.map(e => e.id)).toEqual(["a.f1"]); // b.f2 dropped (c gone), d.f3 dropped (d gone)
    });

    it("passes layoutOptions through verbatim", () => {
        const g = graph();

        expect(subgraph(g, new Set(["a"])).layoutOptions).toEqual(g.layoutOptions);
    });
});

describe("rootedDiagram", () => {
    it("keeps the root plus its neighbours within depth/direction", () => {
        const out = rootedDiagram(graph(), node("a"), "downstream", 1);

        expect(out.nodes.map(n => n.id).sort()).toEqual(["a", "b"]);
        expect(out.edges.map(e => e.id)).toEqual(["a.f1"]);
    });

    it("injects a root absent from the full graph (view/matview root with no FK edges)", () => {
        const out = rootedDiagram(graph(), { id: "v", label: "v", glyph: "eye" }, "both", 2);

        expect(out.nodes.map(n => n.id)).toEqual(["v"]);
        expect(out.edges).toEqual([]);
    });

    it("passes layoutOptions through", () => {
        expect(rootedDiagram(graph(), node("a"), "both", 2).layoutOptions)
            .toEqual({ "elk.algorithm": "layered", "elk.direction": "RIGHT" });
    });
});

describe("applyHide", () => {
    // Base: a -> b -> c, rooted at a.
    function base(): DiagramData {
        return {
            nodes: [node("a"), node("b"), node("c")],
            edges: [edge("a", "b", "f1"), edge("b", "c", "f2")],
            layoutOptions: {},
        };
    }

    it("plain hide drops the node and its edges, leaving orphans", () => {
        const out = applyHide(base(), "a", new Set(["b"]), false, "downstream");

        expect(out.nodes.map(n => n.id).sort()).toEqual(["a", "c"]); // c orphaned but kept
        expect(out.edges).toEqual([]);
    });

    it("prune additionally drops nodes made unreachable from the root", () => {
        const out = applyHide(base(), "a", new Set(["b"]), true, "downstream");

        expect(out.nodes.map(n => n.id)).toEqual(["a"]); // c unreachable once b hidden
        expect(out.edges).toEqual([]);
    });

    it("keeps everything when nothing is hidden", () => {
        const out = applyHide(base(), "a", new Set(), false, "downstream");

        expect(out.nodes.map(n => n.id).sort()).toEqual(["a", "b", "c"]);
        expect(out.edges.map(e => e.id).sort()).toEqual(["a.f1", "b.f2"]);
    });
});
