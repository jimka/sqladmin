import { describe, it, expect } from "vitest";
import type { DiagramData, DiagramLayoutResult } from "@jimka/typescript-ui/component/diagram";
import { stubBundledEdgeRoutes, stubGeometry } from "../../src/data/edgeRouteStubs";

// The library's widest end marker ("zero or many") reaches 18 units back along
// the edge; JunctionDiagramView passes the real EDGE_MARKER_EXTENT, which this
// restates so the expected coordinates below are readable arithmetic.
const MARKER_EXTENT = 18;
const GEOMETRY = stubGeometry(MARKER_EXTENT);

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
