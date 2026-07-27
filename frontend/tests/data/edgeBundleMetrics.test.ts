import { describe, it, expect } from "vitest";
import type { DiagramLayoutResult } from "@jimka/typescript-ui/component/diagram";
import { bundlingMetrics, formatBundlingMetrics } from "../../src/data/edgeBundleMetrics";

/** Fixed-width side column the formatted lines have to fit, in characters. */
const COLUMN_CHARS = 18;

describe("bundlingMetrics", () => {
    it("counts ink and route length alike when no geometry is shared", () => {
        const result: DiagramLayoutResult = {
            nodes: [],
            edges: [
                { id: "a", sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 100, y: 0 } }] },
                { id: "b", sections: [{ startPoint: { x: 0, y: 50 }, endPoint: { x: 60, y: 50 } }] },
            ],
            width: 200,
            height: 200,
        };

        const metrics = bundlingMetrics(result);

        expect(metrics.totalRouteLength).toBe(160);
        expect(metrics.distinctInkLength).toBe(160);
    });

    it("counts a coincident segment once as ink but twice as route length", () => {
        const result: DiagramLayoutResult = {
            nodes: [],
            edges: [
                { id: "a", sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 100, y: 0 } }] },
                { id: "b", sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 100, y: 0 } }] },
            ],
            width: 200,
            height: 200,
        };

        const metrics = bundlingMetrics(result);

        expect(metrics.totalRouteLength).toBe(200);
        expect(metrics.distinctInkLength).toBe(100);
    });

    it("merges partly overlapping runs on the same line into one interval", () => {
        const result: DiagramLayoutResult = {
            nodes: [],
            edges: [
                { id: "a", sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 100, y: 0 } }] },
                { id: "b", sections: [{ startPoint: { x: 60, y: 0 }, endPoint: { x: 200, y: 0 } }] },
            ],
            width: 300,
            height: 300,
        };

        const metrics = bundlingMetrics(result);

        expect(metrics.totalRouteLength).toBe(240);
        expect(metrics.distinctInkLength).toBe(200);
    });

    it("reports the widest fan at any vertex, counting directions modulo 180 degrees", () => {
        // Three edges arrive at (100, 100) along 90, 45 and 135 degrees and all
        // leave along 0: four distinct directions meet there. Each arrival must
        // differ from the shared departure, or it adds no direction of its own.
        const result: DiagramLayoutResult = {
            nodes: [],
            edges: [
                { id: "a", sections: [{ startPoint: { x: 100, y: 0 }, endPoint: { x: 200, y: 100 }, bendPoints: [{ x: 100, y: 100 }] }] },
                { id: "b", sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 200, y: 100 }, bendPoints: [{ x: 100, y: 100 }] }] },
                { id: "c", sections: [{ startPoint: { x: 0, y: 200 }, endPoint: { x: 200, y: 100 }, bendPoints: [{ x: 100, y: 100 }] }] },
            ],
            width: 300,
            height: 300,
        };

        expect(bundlingMetrics(result).maxVertexFan).toBe(4);
    });

    it("reports a plain bend as a fan of two", () => {
        const result: DiagramLayoutResult = {
            nodes: [],
            edges: [
                { id: "a", sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 100, y: 100 }, bendPoints: [{ x: 100, y: 0 }] }] },
            ],
            width: 200,
            height: 200,
        };

        expect(bundlingMetrics(result).maxVertexFan).toBe(2);
    });

    it("reports no node intersections when every route stays clear", () => {
        const result: DiagramLayoutResult = {
            nodes: [{ id: "N", x: 200, y: 200, width: 100, height: 100 }],
            edges: [
                { id: "a", sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 200, y: 0 } }] },
                // Ends exactly on the node's west border: touching is not crossing.
                { id: "b", sections: [{ startPoint: { x: 0, y: 250 }, endPoint: { x: 200, y: 250 } }] },
            ],
            width: 400,
            height: 400,
        };

        expect(bundlingMetrics(result).nodeIntersections).toBe(0);
    });

    it("counts a segment that runs through a node", () => {
        const result: DiagramLayoutResult = {
            nodes: [{ id: "N", x: 200, y: 200, width: 100, height: 100 }],
            edges: [
                { id: "a", sections: [{ startPoint: { x: 0, y: 250 }, endPoint: { x: 400, y: 250 } }] },
            ],
            width: 500,
            height: 500,
        };

        expect(bundlingMetrics(result).nodeIntersections).toBe(1);
    });
});

describe("formatBundlingMetrics", () => {
    it("returns one short line per metric", () => {
        const lines = formatBundlingMetrics({
            totalRouteLength : 1234567,
            distinctInkLength: 4321,
            maxVertexFan     : 154,
            nodeIntersections: 0,
        });

        expect(lines).toHaveLength(4);

        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(COLUMN_CHARS);
        }

        expect(lines.some(l => l.startsWith("Max fan"))).toBe(true);
        expect(lines.some(l => l.startsWith("Node hits"))).toBe(true);
    });
});
