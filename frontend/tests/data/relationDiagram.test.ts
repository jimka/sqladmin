import { describe, it, expect } from "vitest";
import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import {
    reachableNodeIds, subgraph, rootedDiagram, applyHide,
    hiddenNeighbourCounts, depthBadgeLabel, withDepthBadges,
    rootChoices, rootedBase, filteredBase,
} from "../../src/data/relationDiagram";

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

// The plan's worked example: a -> b, b -> c, d -> a, a -> e, f -> b. Root a.
function workedGraph(): DiagramEdgeData[] {
    return [
        edge("a", "b", "f1"),
        edge("b", "c", "f2"),
        edge("d", "a", "f3"),
        edge("a", "e", "f4"),
        edge("f", "b", "f5"),
    ];
}

describe("hiddenNeighbourCounts", () => {
    it("counts both-direction cut neighbours (the worked table's first row)", () => {
        const out = hiddenNeighbourCounts(workedGraph(), new Set(["a", "b", "d", "e"]), "both");

        expect([...out.keys()]).toEqual(["b"]);
        expect(out.get("b")).toEqual({ incoming: 1, outgoing: 1 });
    });

    it("counts only downstream-followed cut neighbours, ignoring upstream-only edges", () => {
        const out = hiddenNeighbourCounts(workedGraph(), new Set(["a", "b"]), "downstream");

        expect(out.get("a")).toEqual({ incoming: 0, outgoing: 1 }); // e
        expect(out.get("b")).toEqual({ incoming: 0, outgoing: 1 }); // c
        expect(out.size).toBe(2); // d->a and f->b are not counted
    });

    it("counts only upstream-followed cut neighbours, ignoring downstream-only edges", () => {
        const out = hiddenNeighbourCounts(workedGraph(), new Set(["a", "b"]), "upstream");

        expect(out.get("a")).toEqual({ incoming: 1, outgoing: 0 }); // d
        expect(out.get("b")).toEqual({ incoming: 1, outgoing: 0 }); // f
        expect(out.size).toBe(2); // a->e and b->c are not counted
    });

    it("returns an empty map when every node is shown", () => {
        const shown = new Set(["a", "b", "c", "d", "e", "f"]);

        expect(hiddenNeighbourCounts(workedGraph(), shown, "both").size).toBe(0);
    });

    it("counts two parallel edges to the same hidden node as one hidden neighbour", () => {
        const edges = [edge("a", "z", "f1"), edge("a", "z", "f2")];
        const out = hiddenNeighbourCounts(edges, new Set(["a"]), "downstream");

        expect(out.get("a")).toEqual({ incoming: 0, outgoing: 1 });
    });

    it("a self-referential edge on a shown node contributes nothing", () => {
        const edges = [edge("a", "a", "f0")];

        expect(hiddenNeighbourCounts(edges, new Set(["a"]), "both").size).toBe(0);
    });

    it("returns an empty map for an empty edge list", () => {
        expect(hiddenNeighbourCounts([], new Set(["a"]), "both").size).toBe(0);
    });
});

describe("depthBadgeLabel", () => {
    it("returns null when nothing was cut", () => {
        expect(depthBadgeLabel({ incoming: 0, outgoing: 0 })).toBeNull();
    });

    it("formats an outgoing-only cut", () => {
        expect(depthBadgeLabel({ incoming: 0, outgoing: 3 })).toBe("+3→");
    });

    it("formats an incoming-only cut", () => {
        expect(depthBadgeLabel({ incoming: 2, outgoing: 0 })).toBe("←+2");
    });

    it("formats a cut on both sides", () => {
        expect(depthBadgeLabel({ incoming: 2, outgoing: 3 })).toBe("←+2 +3→");
    });
});

describe("withDepthBadges", () => {
    // a -> b, b -> c, d -> a, a -> e, f -> b, rooted at a, depth 1, both.
    function fullGraph(): DiagramData {
        return {
            nodes: [node("a"), node("b"), node("c"), node("d"), node("e"), node("f")],
            edges: workedGraph(),
            layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
        };
    }

    it("badges a node whose neighbours were cut and leaves the others alone", () => {
        const full = fullGraph();
        const base = rootedDiagram(full, node("a"), "both", 1);
        const out  = withDepthBadges(base, full.edges, "both");

        const byId = new Map(out.nodes.map(n => [n.id, n]));

        expect(byId.get("b")!.badge).toBe("←+1 +1→");
        expect(byId.get("a")!.badge).toBeUndefined();
        expect(byId.get("d")!.badge).toBeUndefined();
        expect(byId.get("e")!.badge).toBeUndefined();
    });

    it("does not mutate the input base or the nodes it shares with the full graph", () => {
        const full = fullGraph();
        const base = rootedDiagram(full, node("a"), "both", 1);
        const originalB = base.nodes.find(n => n.id === "b")!;
        const out = withDepthBadges(base, full.edges, "both");
        const outB = out.nodes.find(n => n.id === "b")!;

        expect(originalB.badge).toBeUndefined();
        expect(outB).not.toBe(originalB);
    });

    it("passes edges and layoutOptions through by reference", () => {
        const full = fullGraph();
        const base = rootedDiagram(full, node("a"), "both", 1);
        const out = withDepthBadges(base, full.edges, "both");

        expect(out.edges).toBe(base.edges);
        expect(out.layoutOptions).toBe(base.layoutOptions);
    });

    it("badges nothing at an unbounded depth", () => {
        const full = fullGraph();
        const base = rootedDiagram(full, node("a"), "both", Number.POSITIVE_INFINITY);
        const out = withDepthBadges(base, full.edges, "both");

        expect(out.nodes.every(n => n.badge === undefined)).toBe(true);
    });

    it("does not throw and badges nothing for an injected root with no edges", () => {
        const full = fullGraph();
        const root: DiagramNodeData = { id: "v", label: "v", glyph: "eye" };
        const base = rootedDiagram(full, root, "both", 1);
        const out = withDepthBadges(base, full.edges, "both");

        expect(out.nodes.map(n => n.id)).toEqual(["v"]);
        expect(out.nodes[0].badge).toBeUndefined();
    });
});

describe("rootChoices", () => {
    it("returns an empty list for a graph with no nodes", () => {
        expect(rootChoices({ nodes: [], edges: [] })).toEqual([]);
    });

    it("labels a node with a label unique in the graph by that label", () => {
        const data: DiagramData = { nodes: [node("public.orders")], edges: [] };

        expect(rootChoices(data)).toEqual([{ key: "public.orders", label: "public.orders" }]);
    });

    it("labels a node with no label by its id", () => {
        const data: DiagramData = { nodes: [{ id: "t9", glyph: "table" }], edges: [] };

        expect(rootChoices(data)).toEqual([{ key: "t9", label: "t9" }]);
    });

    it("falls back to the id for every node sharing an ambiguous label, keeping a unique one", () => {
        // The plan's worked table: public.users/users, audit.users/users,
        // public.orders/orders (unique), t9/no label.
        const data: DiagramData = {
            nodes: [
                { id: "public.users", label: "users", glyph: "table" },
                { id: "audit.users",  label: "users", glyph: "table" },
                { id: "public.orders", label: "orders", glyph: "table" },
                { id: "t9", glyph: "table" },
            ],
            edges: [],
        };

        expect(rootChoices(data)).toEqual([
            { key: "audit.users",  label: "audit.users" },
            { key: "public.orders", label: "orders" },
            { key: "public.users", label: "public.users" },
            { key: "t9", label: "t9" },
        ]);
    });

    it("orders by shown label, ties broken by key", () => {
        const data: DiagramData = {
            nodes: [node("b"), node("a"), node("c")],
            edges: [],
        };

        expect(rootChoices(data).map(c => c.key)).toEqual(["a", "b", "c"]);
    });
});

describe("rootedBase", () => {
    it("returns full itself when rootId is null", () => {
        const full = graph();

        expect(rootedBase(full, null, "both", 1)).toBe(full);
    });

    it("returns full itself when rootId names no node in full", () => {
        const full = graph();

        expect(rootedBase(full, "zzz", "both", 1)).toBe(full);
    });

    it("returns the direction+depth neighbourhood with cut-neighbour badges", () => {
        const full: DiagramData = {
            nodes: [node("a"), node("b"), node("c"), node("d"), node("e"), node("f")],
            edges: workedGraph(),
        };

        const out = rootedBase(full, "a", "both", 1);
        const expected = withDepthBadges(rootedDiagram(full, node("a"), "both", 1), full.edges, "both");

        expect(out).toEqual(expected);
    });

    it("badges nothing at an unbounded depth", () => {
        const full: DiagramData = {
            nodes: [node("a"), node("b"), node("c"), node("d"), node("e"), node("f")],
            edges: workedGraph(),
        };

        const out = rootedBase(full, "a", "both", Number.POSITIVE_INFINITY);

        expect(out.nodes.every(n => n.badge === undefined)).toBe(true);
        expect(out.nodes.map(n => n.id).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    });
});

describe("filteredBase", () => {
    // Base: a -> b -> c, rooted at a.
    function base(): DiagramData {
        return {
            nodes: [node("a"), node("b"), node("c")],
            edges: [edge("a", "b", "f1"), edge("b", "c", "f2")],
            layoutOptions: {},
        };
    }

    it("returns base unchanged when rootId is null, even with hidden nodes", () => {
        const b = base();

        expect(filteredBase(b, null, new Set(["b"]), false, "downstream")).toBe(b);
    });

    it("drops hidden nodes and their edges, leaving orphans, when rootId is set and prune is false", () => {
        const out = filteredBase(base(), "a", new Set(["b"]), false, "downstream");

        expect(out.nodes.map(n => n.id).sort()).toEqual(["a", "c"]);
        expect(out.edges).toEqual([]);
    });

    it("also drops nodes orphaned from the root when prune is true", () => {
        const out = filteredBase(base(), "a", new Set(["b"]), true, "downstream");

        expect(out.nodes.map(n => n.id)).toEqual(["a"]);
    });
});
