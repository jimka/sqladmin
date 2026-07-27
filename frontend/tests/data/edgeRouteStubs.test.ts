import { describe, it, expect } from "vitest";
import type { DiagramData, DiagramLayoutResult } from "@jimka/typescript-ui/component/diagram";
import { BUNDLE_MIN_MEMBERS, BUNDLING_STRATEGIES, stubBundledEdgeRoutes, stubGeometry } from "../../src/data/edgeRouteStubs";
import { bundlingMetrics } from "../../src/data/edgeBundleMetrics";

// The library's widest end marker ("zero or many") reaches 18 units back along
// the edge; JunctionDiagramView passes the real EDGE_MARKER_EXTENT, which this
// restates so the expected coordinates below are readable arithmetic.
const MARKER_EXTENT = 18;
const GEOMETRY = stubGeometry(MARKER_EXTENT);

/** The three-member fan-in the spine cases share: node E's west border at x=1000, anchor y=30. */
const FAN_IN_DATA: DiagramData = {
    nodes: [{ id: "P" }, { id: "Q" }, { id: "R" }, { id: "E" }],
    edges: [
        { id: "P->E", source: "P", target: "E" },
        { id: "Q->E", source: "Q", target: "E" },
        { id: "R->E", source: "R", target: "E" },
    ],
};

/**
 * The fan-in worked example's routes: three staircases into E's west border,
 * each with a distinct long run (the channel entry) and a perpendicular
 * approach. Built fresh per call so a case can mutate its own copy.
 */
function fanInResult(): DiagramLayoutResult {
    return {
        nodes: [{ id: "E", x: 1000, y: 0, width: 100, height: 60 }],
        edges: [
            { id: "P->E", sections: [{ startPoint: { x: 0, y: 500 }, endPoint: { x: 1000, y: 25 }, bendPoints: [{ x: 900, y: 500 }, { x: 900, y: 25 }] }] },
            { id: "Q->E", sections: [{ startPoint: { x: 0, y: 800 }, endPoint: { x: 1000, y: 30 }, bendPoints: [{ x: 910, y: 800 }, { x: 910, y: 30 }] }] },
            { id: "R->E", sections: [{ startPoint: { x: 0, y: 100 }, endPoint: { x: 1000, y: 35 }, bendPoints: [{ x: 920, y: 100 }, { x: 920, y: 35 }] }] },
        ],
        width: 1200,
        height: 1000,
    };
}

/** Engages a strategy on a small bundle by dropping the member threshold to two. */
const SPINE = { strategy: "spine", minMembers: 2 } as const;

describe("stubBundledEdgeRoutes", () => {
    it("produces the fan-out worked example: three outgoing edges share one run then diverge", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
                { id: "A->D", source: "A", target: "D" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 100, y: 15 }, endPoint: { x: 300, y: 15 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 100, y: 30 }, endPoint: { x: 300, y: 200 } }] },
                { id: "A->D", sections: [{ startPoint: { x: 100, y: 45 }, endPoint: { x: 300, y: 400 } }] },
            ],
            width: 500,
            height: 500,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        for (const id of ["A->B", "A->C", "A->D"]) {
            expect(byId.get(id)!.sections[0].startPoint).toEqual({ x: 100, y: 30 });
            // anchor x=100 plus the preferred distance, marker extent 18 + 14.
            expect(byId.get(id)!.sections[0].bendPoints?.[0]).toEqual({ x: 132, y: 30 });
        }

        expect(byId.get("A->B")!.sections[0].endPoint).toEqual({ x: 300, y: 15 });
        expect(byId.get("A->C")!.sections[0].endPoint).toEqual({ x: 300, y: 200 });
        expect(byId.get("A->D")!.sections[0].endPoint).toEqual({ x: 300, y: 400 });
    });

    it("produces the fan-in worked example: three incoming edges converge to one shared arrival", () => {
        const data: DiagramData = {
            nodes: [{ id: "P" }, { id: "Q" }, { id: "R" }, { id: "E" }],
            edges: [
                { id: "P->E", source: "P", target: "E" },
                { id: "Q->E", source: "Q", target: "E" },
                { id: "R->E", source: "R", target: "E" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "E", x: 1000, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "P->E", sections: [{ startPoint: { x: 800, y: 10 }, endPoint: { x: 1000, y: 15 }, bendPoints: [{ x: 900, y: 15 }] }] },
                { id: "Q->E", sections: [{ startPoint: { x: 800, y: 30 }, endPoint: { x: 1000, y: 30 }, bendPoints: [{ x: 900, y: 30 }] }] },
                { id: "R->E", sections: [{ startPoint: { x: 800, y: 50 }, endPoint: { x: 1000, y: 45 }, bendPoints: [{ x: 900, y: 45 }] }] },
            ],
            width: 1200,
            height: 500,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        for (const id of ["P->E", "Q->E", "R->E"]) {
            const section = byId.get(id)!.sections[0];

            expect(section.endPoint).toEqual({ x: 1000, y: 30 });
            // anchor x=1000 minus the preferred distance, marker extent 18 + 14.
            expect(section.bendPoints?.at(-1)).toEqual({ x: 968, y: 30 });
        }
    });

    it("leaves a bundle of one untouched", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }],
            edges: [{ id: "A->B", source: "A", target: "B" }],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [{ id: "A->B", sections: [{ startPoint: { x: 100, y: 30 }, endPoint: { x: 200, y: 30 } }] }],
            width: 300,
            height: 300,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);

        expect(stubbed.edges).toEqual(result.edges);
    });

    it("holds the junction clear of the marker glyph when half the shortest run would not", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 100, y: 30 }, endPoint: { x: 130, y: 30 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 100, y: 30 }, endPoint: { x: 130, y: 50 } }] },
            ],
            width: 300,
            height: 300,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        expect(GEOMETRY).toEqual({ preferred: 32, minimum: 22 });
        // dmin = 30 (both next vertices sit 30 units from the shared anchor). Half
        // of that is 15, which would bury the junction under an 18-unit glyph, so
        // the minimum clearance wins: L = min(32, max(22, 15), 27) = 22.
        expect(byId.get("A->B")!.sections[0].bendPoints?.[0]).toEqual({ x: 122, y: 30 });
        expect(byId.get("A->C")!.sections[0].bendPoints?.[0]).toEqual({ x: 122, y: 30 });
    });

    it("never pushes the junction onto the next vertex, even when the clearance cannot be met", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 100, y: 30 }, endPoint: { x: 110, y: 30 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 100, y: 30 }, endPoint: { x: 110, y: 40 } }] },
            ],
            width: 300,
            height: 300,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        // dmin = 10, too short to clear an 18-unit glyph at all. The hard cap
        // still binds: L = min(32, max(22, 5), 9) = 9, so the junction stays
        // short of the endpoint instead of reaching or passing it.
        expect(byId.get("A->B")!.sections[0].bendPoints?.[0]).toEqual({ x: 109, y: 30 });
        expect(byId.get("A->C")!.sections[0].bendPoints?.[0]).toEqual({ x: 109, y: 30 });
    });

    it("uses the bundle minimum, not each member's own distance, when capping the stub", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                // Next vertex 30 units out.
                { id: "A->B", sections: [{ startPoint: { x: 100, y: 30 }, endPoint: { x: 130, y: 30 } }] },
                // Next vertex 400 units out — must not get its own longer stub.
                { id: "A->C", sections: [{ startPoint: { x: 100, y: 30 }, endPoint: { x: 500, y: 30 } }] },
            ],
            width: 600,
            height: 300,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        // dmin is the 30-unit member's, not the 400-unit one's: L = min(32,
        // max(22, 15), 27) = 22, the same junction for both.
        expect(byId.get("A->B")!.sections[0].bendPoints?.[0]).toEqual({ x: 122, y: 30 });
        expect(byId.get("A->C")!.sections[0].bendPoints?.[0]).toEqual({ x: 122, y: 30 });
    });

    it("never bundles a ported endpoint, including a mix of one ported and one portless edge", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
            edges: [
                { id: "A->B", source: "A", target: "B", sourcePort: "A.out" },
                { id: "A->C", source: "A", target: "C", sourcePort: "A.out2" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 100, y: 10 }, endPoint: { x: 200, y: 10 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 100, y: 50 }, endPoint: { x: 200, y: 50 } }] },
            ],
            width: 300,
            height: 300,
        };

        expect(stubBundledEdgeRoutes(data, result, GEOMETRY).edges).toEqual(result.edges);

        // One ported, one portless: the portless edge is alone in its bundle.
        const mixedData: DiagramData = {
            nodes: data.nodes,
            edges: [
                { id: "A->B", source: "A", target: "B", sourcePort: "A.out" },
                { id: "A->C", source: "A", target: "C" },
            ],
        };

        expect(stubBundledEdgeRoutes(mixedData, result, GEOMETRY).edges).toEqual(result.edges);
    });

    it("keeps sides apart: an east-side pair bundles, a west-side edge does not", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
                { id: "D->A", source: "D", target: "A" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 100, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 200, y: 10 }, endPoint: { x: 300, y: 10 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 200, y: 50 }, endPoint: { x: 300, y: 50 } }] },
                { id: "D->A", sections: [{ startPoint: { x: 0, y: 30 }, endPoint: { x: 100, y: 30 } }] },
            ],
            width: 400,
            height: 300,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        expect(byId.get("A->B")!.sections[0].startPoint).toEqual({ x: 200, y: 30 });
        expect(byId.get("A->C")!.sections[0].startPoint).toEqual({ x: 200, y: 30 });
        // The west-side incoming edge is alone at that side/direction: untouched.
        expect(byId.get("D->A")!.sections[0]).toEqual(result.edges[2].sections[0]);
    });

    it("keeps direction apart: an incoming and outgoing endpoint on the same side do not bundle", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "C->A", source: "C", target: "A" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                // A's own outgoing edge leaves the east border.
                { id: "A->B", sections: [{ startPoint: { x: 100, y: 20 }, endPoint: { x: 200, y: 20 } }] },
                // An edge arriving at A's east border (unusual, but geometrically valid).
                { id: "C->A", sections: [{ startPoint: { x: 200, y: 40 }, endPoint: { x: 100, y: 40 } }] },
            ],
            width: 300,
            height: 300,
        };

        expect(stubBundledEdgeRoutes(data, result, GEOMETRY).edges).toEqual(result.edges);
    });

    it("leaves a self-loop untouched even when other edges bundle at the same node", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }],
            edges: [
                { id: "A->A", source: "A", target: "A" },
                { id: "A->B1", source: "A", target: "B" },
                { id: "A->B2", source: "A", target: "B" },
            ],
        };
        const selfLoopSection = { startPoint: { x: 100, y: 10 }, endPoint: { x: 100, y: 20 }, bendPoints: [{ x: 130, y: 15 }] };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->A", sections: [selfLoopSection] },
                { id: "A->B1", sections: [{ startPoint: { x: 100, y: 35 }, endPoint: { x: 200, y: 35 } }] },
                { id: "A->B2", sections: [{ startPoint: { x: 100, y: 45 }, endPoint: { x: 200, y: 45 } }] },
            ],
            width: 300,
            height: 300,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        expect(byId.get("A->A")!.sections[0]).toEqual(selfLoopSection);
        // The two portless non-loop edges still bundle with each other.
        expect(byId.get("A->B1")!.sections[0].startPoint).toEqual({ x: 100, y: 40 });
        expect(byId.get("A->B2")!.sections[0].startPoint).toEqual({ x: 100, y: 40 });
    });

    it("leaves edges untouched when their node is absent from result.nodes", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [], // "A" is missing entirely
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 100, y: 10 }, endPoint: { x: 200, y: 10 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 100, y: 50 }, endPoint: { x: 200, y: 50 } }] },
            ],
            width: 300,
            height: 300,
        };

        expect(() => stubBundledEdgeRoutes(data, result, GEOMETRY)).not.toThrow();
        expect(stubBundledEdgeRoutes(data, result, GEOMETRY).edges).toEqual(result.edges);
    });

    it("leaves an endpoint farther than BOUNDARY_EPSILON from every border alone", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
            ],
        };
        const result: DiagramLayoutResult = {
            // Both routes start well inside A's rect, not on any border.
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 50, y: 30 }, endPoint: { x: 200, y: 10 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 50, y: 30 }, endPoint: { x: 200, y: 50 } }] },
            ],
            width: 300,
            height: 300,
        };

        expect(stubBundledEdgeRoutes(data, result, GEOMETRY).edges).toEqual(result.edges);
    });

    it("is pure: the input result, edges, and sections are not mutated, and nodes/width/height pass through", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 100, y: 15 }, endPoint: { x: 200, y: 15 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 100, y: 45 }, endPoint: { x: 200, y: 45 } }] },
            ],
            width: 300,
            height: 300,
        };
        const snapshot = JSON.parse(JSON.stringify(result));

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);

        expect(result).toEqual(snapshot);
        expect(stubbed.nodes).toBe(result.nodes);
        expect(stubbed.width).toBe(result.width);
        expect(stubbed.height).toBe(result.height);
    });

    it("leaves the default strategy alone: a spine bundle below the member threshold stays a junction", () => {
        const data: DiagramData = {
            nodes: [{ id: "P" }, { id: "Q" }, { id: "R" }, { id: "E" }],
            edges: [
                { id: "P->E", source: "P", target: "E" },
                { id: "Q->E", source: "Q", target: "E" },
                { id: "R->E", source: "R", target: "E" },
            ],
        };
        const result = fanInResult();

        // Three members, well below BUNDLE_MIN_MEMBERS: every strategy defers to
        // the junction, so all three agree with the no-options call.
        const junction = stubBundledEdgeRoutes(data, result, GEOMETRY);

        expect(BUNDLE_MIN_MEMBERS).toBeGreaterThan(3);

        for (const strategy of BUNDLING_STRATEGIES) {
            expect(stubBundledEdgeRoutes(data, result, GEOMETRY, { strategy }).edges).toEqual(junction.edges);
        }
    });

    it("stubs downward on a DOWN layout, proving nothing assumes east/west", () => {
        const data: DiagramData = {
            nodes: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
            edges: [
                { id: "A->B", source: "A", target: "B" },
                { id: "A->C", source: "A", target: "C" },
                { id: "A->D", source: "A", target: "D" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [{ id: "A", x: 0, y: 0, width: 100, height: 60 }],
            edges: [
                { id: "A->B", sections: [{ startPoint: { x: 20, y: 60 }, endPoint: { x: 20, y: 150 } }] },
                { id: "A->C", sections: [{ startPoint: { x: 50, y: 60 }, endPoint: { x: 200, y: 150 } }] },
                { id: "A->D", sections: [{ startPoint: { x: 80, y: 60 }, endPoint: { x: 400, y: 150 } }] },
            ],
            width: 500,
            height: 500,
        };

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        for (const id of ["A->B", "A->C", "A->D"]) {
            expect(byId.get(id)!.sections[0].startPoint).toEqual({ x: 50, y: 60 });
            // South normal = (0, 1): the junction sits below the anchor.
            expect(byId.get(id)!.sections[0].bendPoints?.[0].y).toBeGreaterThan(60);
            expect(byId.get(id)!.sections[0].bendPoints?.[0].x).toBe(50);
        }
    });
});

describe("stubBundledEdgeRoutes — collector spine", () => {
    it("moves every member's long run onto one shared trunk beside the node", () => {
        const result = fanInResult();
        const stubbed = stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY, SPINE);
        const byId = new Map(stubbed.edges.map(e => [e.id, e]));

        // Perpendicular runs are 100 / 90 / 80, so the shortest is 80 and the
        // 0.9 cap (72) does not bind: the spine sits at the preferred 32 units
        // out, i.e. x = 968, and B = (968, 30) on the anchor's own row.
        expect(byId.get("P->E")!.sections[0].bendPoints).toEqual([{ x: 900, y: 500 }, { x: 968, y: 500 }, { x: 968, y: 30 }]);
        expect(byId.get("Q->E")!.sections[0].bendPoints).toEqual([{ x: 910, y: 800 }, { x: 968, y: 800 }, { x: 968, y: 30 }]);
        expect(byId.get("R->E")!.sections[0].bendPoints).toEqual([{ x: 920, y: 100 }, { x: 968, y: 100 }, { x: 968, y: 30 }]);

        for (const id of ["P->E", "Q->E", "R->E"]) {
            expect(byId.get(id)!.sections[0].endPoint).toEqual({ x: 1000, y: 30 });
        }

        expect(stubbed.nodes).toBe(result.nodes);
        expect(stubbed.width).toBe(result.width);
        expect(stubbed.height).toBe(result.height);
    });

    it("keeps a member with no distinct channel run on the junction while the rest use the spine", () => {
        const result = fanInResult();

        // One bend point only: no channel entry to redirect.
        result.edges[0].sections[0].bendPoints = [{ x: 900, y: 25 }];

        const byId = new Map(stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY, SPINE).edges.map(e => [e.id, e]));

        expect(byId.get("P->E")!.sections[0].bendPoints).toEqual([{ x: 900, y: 25 }, { x: 968, y: 30 }]);
        expect(byId.get("Q->E")!.sections[0].bendPoints).toEqual([{ x: 910, y: 800 }, { x: 968, y: 800 }, { x: 968, y: 30 }]);
    });

    it("keeps a member whose approach is not level with its endpoint on the junction", () => {
        const result = fanInResult();

        // The approach bend sits 5 units off the endpoint's row, so this route
        // does not arrive straight out of the border.
        result.edges[0].sections[0].bendPoints = [{ x: 900, y: 500 }, { x: 900, y: 20 }];

        const byId = new Map(stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY, SPINE).edges.map(e => [e.id, e]));

        expect(byId.get("P->E")!.sections[0].bendPoints).toEqual([{ x: 900, y: 500 }, { x: 900, y: 20 }, { x: 968, y: 30 }]);
        expect(byId.get("R->E")!.sections[0].bendPoints).toEqual([{ x: 920, y: 100 }, { x: 968, y: 100 }, { x: 968, y: 30 }]);
    });

    it("falls the whole bundle back to the junction when the trunk would cross a node", () => {
        const result = fanInResult();

        // The trunk runs at x=968 from y=30 to y=800; this rect straddles it.
        result.nodes = [...result.nodes, { id: "X", x: 960, y: 200, width: 20, height: 200 }];

        const spined = stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY, SPINE);
        const junction = stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY);

        expect(spined.edges).toEqual(junction.edges);
    });

    it("falls back when the shortest perpendicular run leaves no room outside the glyph", () => {
        const result = fanInResult();

        // Runs of 22 units: 0.9 of that is 19.8, inside the 22-unit minimum, so
        // a spine could only sit under the end-marker glyph.
        result.edges[0].sections[0].bendPoints = [{ x: 900, y: 500 }, { x: 978, y: 25 }];
        result.edges[1].sections[0].bendPoints = [{ x: 910, y: 800 }, { x: 978, y: 30 }];
        result.edges[2].sections[0].bendPoints = [{ x: 920, y: 100 }, { x: 978, y: 35 }];

        const spined = stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY, SPINE);
        const junction = stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY);

        expect(spined.edges).toEqual(junction.edges);
    });

    it("runs the spine along a south border too, proving nothing assumes east/west", () => {
        const data: DiagramData = {
            nodes: [{ id: "P" }, { id: "Q" }, { id: "E" }],
            edges: [
                { id: "P->E", source: "P", target: "E" },
                { id: "Q->E", source: "Q", target: "E" },
            ],
        };
        const result: DiagramLayoutResult = {
            // Routes arrive at E's south border (y = 160) from below.
            nodes: [{ id: "E", x: 0, y: 100, width: 100, height: 60 }],
            edges: [
                { id: "P->E", sections: [{ startPoint: { x: 500, y: 600 }, endPoint: { x: 40, y: 160 }, bendPoints: [{ x: 500, y: 400 }, { x: 40, y: 400 }] }] },
                { id: "Q->E", sections: [{ startPoint: { x: 700, y: 600 }, endPoint: { x: 60, y: 160 }, bendPoints: [{ x: 700, y: 300 }, { x: 60, y: 300 }] }] },
            ],
            width: 900,
            height: 900,
        };

        const byId = new Map(stubBundledEdgeRoutes(data, result, GEOMETRY, SPINE).edges.map(e => [e.id, e]));

        // South normal is (0, 1) and the tangent (1, 0): the spine is the
        // horizontal line y = 160 + 32 = 192, and the anchor is x = 50.
        expect(byId.get("P->E")!.sections[0].bendPoints).toEqual([{ x: 500, y: 400 }, { x: 500, y: 192 }, { x: 50, y: 192 }]);
        expect(byId.get("Q->E")!.sections[0].bendPoints).toEqual([{ x: 700, y: 300 }, { x: 700, y: 192 }, { x: 50, y: 192 }]);
        expect(byId.get("P->E")!.sections[0].endPoint).toEqual({ x: 50, y: 160 });
    });
});

/**
 * Four routes into E's west border whose channel entries sit at across
 * coordinates 0, 10, 20 and 30 — evenly spread, so centroid linkage pairs them
 * into a two-level tree rather than a chain. Anchor y = 30, L = 32.
 */
function evenTreeResult(): DiagramLayoutResult {
    return {
        nodes: [{ id: "E", x: 1000, y: 0, width: 100, height: 60 }],
        edges: [
            { id: "T1", sections: [{ startPoint: { x: 0, y: 30 }, endPoint: { x: 1000, y: 15 }, bendPoints: [{ x: 800, y: 30 }, { x: 900, y: 15 }] }] },
            { id: "T2", sections: [{ startPoint: { x: 0, y: 40 }, endPoint: { x: 1000, y: 25 }, bendPoints: [{ x: 800, y: 40 }, { x: 900, y: 25 }] }] },
            { id: "T3", sections: [{ startPoint: { x: 0, y: 50 }, endPoint: { x: 1000, y: 35 }, bendPoints: [{ x: 800, y: 50 }, { x: 900, y: 35 }] }] },
            { id: "T4", sections: [{ startPoint: { x: 0, y: 60 }, endPoint: { x: 1000, y: 45 }, bendPoints: [{ x: 800, y: 60 }, { x: 900, y: 45 }] }] },
        ],
        width: 1200,
        height: 1000,
    };
}

const TREE_DATA: DiagramData = {
    nodes: [{ id: "S1" }, { id: "S2" }, { id: "S3" }, { id: "S4" }, { id: "E" }],
    edges: [
        { id: "T1", source: "S1", target: "E" },
        { id: "T2", source: "S2", target: "E" },
        { id: "T3", source: "S3", target: "E" },
        { id: "T4", source: "S4", target: "E" },
    ],
};

const TREE = { strategy: "tree", minMembers: 2 } as const;

describe("stubBundledEdgeRoutes — merge tree", () => {
    it("pairs nearest clusters into a tree, each level one step further out", () => {
        const byId = new Map(stubBundledEdgeRoutes(TREE_DATA, evenTreeResult(), GEOMETRY, TREE).edges.map(e => [e.id, e]));

        // Leaves at 0, 10, 20, 30 merge as {0,10} and {20,30} (ties break low),
        // then the root — one internal level below the root, so the single step
        // is (90 - 32) / 1 = 58 and the level-1 trunks sit at out = 90, x = 910.
        // The level-1 centroids are 5 and 25, i.e. y = 35 and y = 55.
        expect(byId.get("T1")!.sections[0].bendPoints).toEqual([{ x: 800, y: 30 }, { x: 910, y: 30 }, { x: 910, y: 35 }, { x: 968, y: 35 }, { x: 968, y: 30 }]);
        expect(byId.get("T2")!.sections[0].bendPoints).toEqual([{ x: 800, y: 40 }, { x: 910, y: 40 }, { x: 910, y: 35 }, { x: 968, y: 35 }, { x: 968, y: 30 }]);
        expect(byId.get("T3")!.sections[0].bendPoints).toEqual([{ x: 800, y: 50 }, { x: 910, y: 50 }, { x: 910, y: 55 }, { x: 968, y: 55 }, { x: 968, y: 30 }]);
        expect(byId.get("T4")!.sections[0].bendPoints).toEqual([{ x: 800, y: 60 }, { x: 910, y: 60 }, { x: 910, y: 55 }, { x: 968, y: 55 }, { x: 968, y: 30 }]);

        // Every member still ends on the same innermost vertex and anchor as the
        // junction strategy would have given them.
        for (const id of ["T1", "T2", "T3", "T4"]) {
            expect(byId.get(id)!.sections[0].bendPoints?.at(-1)).toEqual({ x: 968, y: 30 });
            expect(byId.get(id)!.sections[0].endPoint).toEqual({ x: 1000, y: 30 });
        }
    });

    it("falls back to the junction when the members chain into a comb", () => {
        // Exponentially spread channel entries: each merged cluster's centroid
        // stays nearest the next lone leaf, so the tree is a chain four internal
        // levels deep.
        const acrosses = [0, 1, 3, 7, 15, 31];
        const ends     = [5, 15, 25, 35, 45, 55];
        const result: DiagramLayoutResult = {
            nodes: [{ id: "E", x: 1000, y: 0, width: 100, height: 60 }],
            edges: acrosses.map((a, i) => ({
                id: `C${i}`,
                sections: [{
                    startPoint: { x: 0, y: 30 + a },
                    endPoint  : { x: 1000, y: ends[i] },
                    bendPoints: [{ x: 800, y: 30 + a }, { x: 900, y: ends[i] }],
                }],
            })),
            width: 1200,
            height: 1000,
        };
        const data: DiagramData = {
            nodes: [...acrosses.map((_, i) => ({ id: `S${i}` })), { id: "E" }],
            edges: acrosses.map((_, i) => ({ id: `C${i}`, source: `S${i}`, target: "E" })),
        };

        const junction = stubBundledEdgeRoutes(data, result, GEOMETRY);

        expect(stubBundledEdgeRoutes(data, result, GEOMETRY, { ...TREE, maxTreeDepth: 3 }).edges).toEqual(junction.edges);
        // The cap is what rejects it: the same comb is accepted when it fits.
        expect(stubBundledEdgeRoutes(data, result, GEOMETRY, TREE).edges).not.toEqual(junction.edges);
    });

    it("falls the whole bundle back to the junction when a level trunk would cross a node", () => {
        const result = evenTreeResult();

        // Straddles the level-1 trunk, which runs at x = 910.
        result.nodes = [...result.nodes, { id: "X", x: 900, y: 32, width: 20, height: 10 }];

        const junction = stubBundledEdgeRoutes(TREE_DATA, result, GEOMETRY);

        expect(stubBundledEdgeRoutes(TREE_DATA, result, GEOMETRY, TREE).edges).toEqual(junction.edges);
    });

    it("keeps every edge routable and pure under all three strategies", () => {
        const result = evenTreeResult();
        const snapshot = JSON.parse(JSON.stringify(result));

        for (const strategy of BUNDLING_STRATEGIES) {
            const stubbed = stubBundledEdgeRoutes(TREE_DATA, result, GEOMETRY, { strategy, minMembers: 2 });

            expect(stubbed.edges.map(e => e.id).sort()).toEqual(["T1", "T2", "T3", "T4"]);

            for (const edge of stubbed.edges) {
                expect(edge.sections).toHaveLength(1);
            }

            expect(stubbed.nodes).toBe(result.nodes);
            expect(result).toEqual(snapshot);
        }
    });
});

/** Every segment a rewritten result draws, as `a->b` strings, for orthogonality checks. */
function diagonalSegments(result: DiagramLayoutResult): string[] {
    const bad: string[] = [];

    for (const edge of result.edges) {
        for (const section of edge.sections) {
            const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];

            for (let i = 1; i < pts.length; i += 1) {
                const offAxis = Math.abs(pts[i].x - pts[i - 1].x) > 0.5 && Math.abs(pts[i].y - pts[i - 1].y) > 0.5;

                if (offAxis) {
                    bad.push(`${edge.id}: ${JSON.stringify(pts[i - 1])}->${JSON.stringify(pts[i])}`);
                }
            }
        }
    }

    return bad;
}

describe("stubBundledEdgeRoutes — a section bundled at both ends", () => {
    // Two parallel edges between the same pair, each a two-bend Z. S's outgoing
    // pair bundles on its east border and E's incoming pair on its west, so one
    // section is rewritten at both ends and the two ends read the same two bend
    // points from opposite directions.
    const data: DiagramData = {
        nodes: [{ id: "S" }, { id: "E" }],
        edges: [
            { id: "e0", source: "S", target: "E" },
            { id: "e1", source: "S", target: "E" },
        ],
    };

    function twoBendResult(): DiagramLayoutResult {
        return {
            nodes: [
                { id: "S", x: 0, y: 0, width: 100, height: 60 },
                { id: "E", x: 500, y: 0, width: 100, height: 60 },
            ],
            edges: [
                { id: "e0", sections: [{ startPoint: { x: 100, y: 15 }, endPoint: { x: 500, y: 45 }, bendPoints: [{ x: 300, y: 15 }, { x: 300, y: 45 }] }] },
                { id: "e1", sections: [{ startPoint: { x: 100, y: 45 }, endPoint: { x: 500, y: 15 }, bendPoints: [{ x: 320, y: 45 }, { x: 320, y: 15 }] }] },
            ],
            width: 700,
            height: 300,
        };
    }

    it("introduces no diagonal the junction does not already draw", () => {
        // The junction's own stub fans out diagonally from one shared point to
        // each member's next vertex; that is its shape. What the shared
        // structures must never do is add a diagonal of their own — which is
        // what dropping both ends' channel entries produced: a single unchecked
        // run straight across the gap between the two shared runs.
        const allowed = diagonalSegments(stubBundledEdgeRoutes(data, twoBendResult(), GEOMETRY));

        for (const strategy of BUNDLING_STRATEGIES) {
            const stubbed = stubBundledEdgeRoutes(data, twoBendResult(), GEOMETRY, { strategy, minMembers: 2 });

            expect(diagonalSegments(stubbed)).toEqual(allowed);
        }
    });

    it("falls both ends back to the junction when two bends cannot feed both", () => {
        const junction = stubBundledEdgeRoutes(data, twoBendResult(), GEOMETRY);

        // Two bend points leave each end's channel entry as the other end's
        // approach bend, so neither may drop one: both revert to the junction.
        for (const strategy of BUNDLING_STRATEGIES) {
            const stubbed = stubBundledEdgeRoutes(data, twoBendResult(), GEOMETRY, { strategy, minMembers: 2 });

            expect(stubbed.edges).toEqual(junction.edges);
        }
    });

    it("uses the shared structure at both ends once a third bend separates them", () => {
        const result = twoBendResult();

        // Orthogonal three-bend staircases: each end's channel entry is now the
        // middle vertex, which neither end drops.
        result.edges[0].sections[0].bendPoints = [{ x: 200, y: 15 }, { x: 200, y: 45 }, { x: 400, y: 45 }];
        result.edges[1].sections[0].bendPoints = [{ x: 220, y: 45 }, { x: 220, y: 15 }, { x: 420, y: 15 }];

        const stubbed = stubBundledEdgeRoutes(data, result, GEOMETRY, { strategy: "spine", minMembers: 2 });

        expect(stubbed.edges).not.toEqual(stubBundledEdgeRoutes(data, result, GEOMETRY).edges);
        // Both ends now reach their spine, and the whole route stays orthogonal.
        expect(diagonalSegments(stubbed)).toEqual([]);
        expect(stubbed.edges[0].sections[0].bendPoints).toEqual([
            { x: 132, y: 30 }, { x: 132, y: 45 }, { x: 200, y: 45 }, { x: 468, y: 45 }, { x: 468, y: 30 },
        ]);
    });
});

describe("stubBundledEdgeRoutes — a channel entry inside the trunk", () => {
    it("keeps a spine member whose channel entry is nearer than the spine on the junction", () => {
        const result = fanInResult();

        // Channel entry only 10 units off the border, inside the 32-unit spine:
        // a spur to the spine would run backwards, so this member keeps its
        // junction tail while the other two use the spine.
        result.edges[0].sections[0].bendPoints = [{ x: 990, y: 500 }, { x: 900, y: 25 }];

        const byId = new Map(stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY, SPINE).edges.map(e => [e.id, e]));

        expect(byId.get("P->E")!.sections[0].bendPoints).toEqual([{ x: 990, y: 500 }, { x: 900, y: 25 }, { x: 968, y: 30 }]);
        expect(byId.get("Q->E")!.sections[0].bendPoints).toEqual([{ x: 910, y: 800 }, { x: 968, y: 800 }, { x: 968, y: 30 }]);
    });

    it("keeps a tree member whose channel entry is nearer than its trunk level on the junction", () => {
        const result = evenTreeResult();

        // Level-1 trunks sit 90 units out; this entry is 40, so the leaf cannot
        // reach its parent without doubling back and keeps the junction tail.
        result.edges[0].sections[0].bendPoints = [{ x: 960, y: 30 }, { x: 900, y: 15 }];

        const byId = new Map(stubBundledEdgeRoutes(TREE_DATA, result, GEOMETRY, TREE).edges.map(e => [e.id, e]));

        expect(byId.get("T1")!.sections[0].bendPoints).toEqual([{ x: 960, y: 30 }, { x: 900, y: 15 }, { x: 968, y: 30 }]);
        // Its siblings still merge: T3 and T4 share the level-1 trunk at y = 55.
        expect(byId.get("T3")!.sections[0].bendPoints).toEqual([{ x: 800, y: 50 }, { x: 910, y: 50 }, { x: 910, y: 55 }, { x: 968, y: 55 }, { x: 968, y: 30 }]);
    });
});

describe("stubBundledEdgeRoutes — a downgraded member inside a clamped bundle", () => {
    it("branches at its bundle's own innermost point, not at the unclamped stub distance", () => {
        // Three edges S->E, bundled at both ends. `c` carries only two bend
        // points, so it is downgraded to a junction; `a` and `b` carry three and
        // use the spine. On the target side the two outer members sit far from
        // the anchor, so stubLength's Euclidean measure gives 23.58 while their
        // perpendicular runs are only 25 — the spine clamps to 22.5. The
        // downgraded member must land on that clamped point too.
        const data: DiagramData = {
            nodes: [{ id: "S" }, { id: "E" }],
            edges: [
                { id: "a", source: "S", target: "E" },
                { id: "b", source: "S", target: "E" },
                { id: "c", source: "S", target: "E" },
            ],
        };
        const result: DiagramLayoutResult = {
            nodes: [
                { id: "S", x: 0, y: 0, width: 100, height: 100 },
                { id: "E", x: 600, y: 0, width: 100, height: 100 },
            ],
            edges: [
                { id: "a", sections: [{ startPoint: { x: 100, y: 10 }, endPoint: { x: 600, y: 10 }, bendPoints: [{ x: 150, y: 10 }, { x: 300, y: 10 }, { x: 575, y: 10 }] }] },
                { id: "b", sections: [{ startPoint: { x: 100, y: 50 }, endPoint: { x: 600, y: 90 }, bendPoints: [{ x: 160, y: 50 }, { x: 300, y: 90 }, { x: 575, y: 90 }] }] },
                { id: "c", sections: [{ startPoint: { x: 100, y: 90 }, endPoint: { x: 600, y: 50 }, bendPoints: [{ x: 200, y: 90 }, { x: 500, y: 50 }] }] },
            ],
            width: 800,
            height: 200,
        };

        const byId = new Map(stubBundledEdgeRoutes(data, result, GEOMETRY, SPINE).edges.map(e => [e.id, e]));

        for (const id of ["a", "b", "c"]) {
            const section = byId.get(id)!.sections[0];

            // Target side: anchor (600, 50), spine clamped to 22.5 units out.
            expect(section.bendPoints?.at(-1)).toEqual({ x: 577.5, y: 50 });
            expect(section.endPoint).toEqual({ x: 600, y: 50 });
            // Source side: anchor (100, 50), unclamped at 30 units out.
            expect(section.bendPoints?.[0]).toEqual({ x: 130, y: 50 });
            expect(section.startPoint).toEqual({ x: 100, y: 50 });
        }

        // `c` really was downgraded: it keeps both of its own bend points.
        expect(byId.get("c")!.sections[0].bendPoints).toEqual([
            { x: 130, y: 50 }, { x: 200, y: 90 }, { x: 500, y: 50 }, { x: 577.5, y: 50 },
        ]);
    });
});

describe("stubBundledEdgeRoutes — accepted bundles keep clear of nodes", () => {
    // The obstacle tests above pin the *decline* path: a rect planted on a trunk
    // makes the router give up. These pin the other direction, which is where a
    // defect would actually hide — a bundle the router accepts must draw no
    // segment through a node. Each places a rect close to the routes but clear
    // of them, so the strategy still engages and the count is a real assertion
    // rather than a vacuous one.

    it("adds no node crossing when a spine is accepted", () => {
        const result = fanInResult();

        // Between the members' own channel columns (x 900-920) and the spine
        // (x 968), spanning y 200-400 where no segment runs.
        result.nodes = [...result.nodes, { id: "X", x: 930, y: 200, width: 30, height: 200 }];

        const spined = stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY, SPINE);

        expect(spined.edges).not.toEqual(stubBundledEdgeRoutes(FAN_IN_DATA, result, GEOMETRY).edges);
        expect(bundlingMetrics(spined).nodeIntersections).toBe(0);
    });

    it("adds no node crossing when a merge tree is accepted", () => {
        const result = evenTreeResult();

        // Between the level-1 trunk (x 910) and the root (x 968), clear of the
        // y band the members occupy.
        result.nodes = [...result.nodes, { id: "X", x: 930, y: 200, width: 25, height: 200 }];

        const treed = stubBundledEdgeRoutes(TREE_DATA, result, GEOMETRY, TREE);

        expect(treed.edges).not.toEqual(stubBundledEdgeRoutes(TREE_DATA, result, GEOMETRY).edges);
        expect(bundlingMetrics(treed).nodeIntersections).toBe(0);
    });
});
