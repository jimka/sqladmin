// Pure measurement of a routed ELK layout, for comparing edge-bundling
// strategies against each other on one layout. Knows nothing about bundles: it
// reads a finished DiagramLayoutResult and reports four numbers. No DOM, no ELK
// — type-only imports from the diagram barrel keep this node-vitest-testable,
// the same purity discipline as edgeRouteStubs.ts:1-8 (never import UI-bundle
// runtime code, which runs DOM-touching module-level side effects on import).

import type { DiagramLayoutResult, ElkPoint } from "@jimka/typescript-ui/component/diagram";

/**
 * Grid, in graph units, that coincident geometry is snapped to before being
 * compared. ELK reports fractional coordinates, so two runs a strategy intended
 * to share a line can differ in the last decimal; one unit is well below the
 * spacing between neighbouring routes yet coarse enough to fuse them.
 */
const COINCIDENCE_GRID = 1;

/**
 * Angular grid, in degrees, that a segment's direction is snapped to before
 * distinct directions are counted at a vertex. Mirrors
 * {@link COINCIDENCE_GRID}'s rationale in the angular domain.
 */
const DIRECTION_GRID = 1;

/**
 * How far a node rect is shrunk before the intersection test, in graph units.
 * A route legitimately ends *on* the border of the node it connects to, so an
 * un-inset rect would report every edge as intersecting; one unit is below
 * ELK's coordinate granularity yet enough to exclude a touching endpoint.
 */
const NODE_CLEARANCE_INSET = 1;

/** Half a turn in degrees — a direction and its opposite draw the same line. */
const HALF_TURN_DEGREES = 180;

/** The four numbers that separate one bundling strategy from another. */
export interface BundlingMetrics {
    /** Sum of every edge's polyline length, in graph units. */
    totalRouteLength: number;
    /** Length of the union of the drawn segments — coincident runs counted once. */
    distinctInkLength: number;
    /** Largest number of distinct segment directions meeting at one vertex. */
    maxVertexFan: number;
    /** Segments passing through a node rectangle. Expected 0. */
    nodeIntersections: number;
}

/** One drawn segment, already extracted from its section. */
interface Segment {
    a: ElkPoint;
    b: ElkPoint;
}

/**
 * Every drawn segment in the result, in no particular order.
 *
 * @param result - The routed layout.
 * @returns The segments.
 */
function segmentsOf(result: DiagramLayoutResult): Segment[] {
    const segments: Segment[] = [];

    for (const edge of result.edges) {
        for (const section of edge.sections) {
            const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];

            for (let i = 1; i < points.length; i += 1) {
                segments.push({ a: points[i - 1], b: points[i] });
            }
        }
    }

    return segments;
}

/** Rounds `value` onto {@link COINCIDENCE_GRID}. */
function snap(value: number): number {
    return Math.round(value / COINCIDENCE_GRID) * COINCIDENCE_GRID;
}

/** Euclidean length of one segment. */
function lengthOf(segment: Segment): number {
    return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
}

/**
 * The union length of a set of intervals on one line.
 *
 * @param intervals - The `[low, high]` pairs, in any order.
 * @returns The length covered at least once.
 */
function unionLength(intervals: [number, number][]): number {
    const sorted = [...intervals].sort((p, q) => p[0] - q[0]);
    let covered = 0;
    let [, reach] = [0, Number.NEGATIVE_INFINITY];

    for (const [low, high] of sorted) {
        if (low > reach) {
            covered += high - low;
            reach = high;
        } else if (high > reach) {
            covered += high - reach;
            reach = high;
        }
    }

    return covered;
}

/**
 * The length of the union of the drawn segments: axis-parallel runs sharing a
 * line are merged so a shared trunk counts once however many edges draw it.
 *
 * Only axis-parallel segments are deduplicated. Two diagonals coincide only by
 * accident in a layered orthogonal routing, and grouping them would need a full
 * line-equation key for no gain — so each is counted in full.
 *
 * @param segments - Every drawn segment.
 * @returns The distinct ink length in graph units.
 */
function distinctInk(segments: Segment[]): number {
    // Keyed by orientation and the snapped fixed coordinate, so every run on one
    // horizontal or vertical line lands in the same bucket.
    const lines = new Map<string, [number, number][]>();
    let diagonal = 0;

    for (const segment of segments) {
        const horizontal = snap(segment.a.y) === snap(segment.b.y);
        const vertical   = snap(segment.a.x) === snap(segment.b.x);

        if (!horizontal && !vertical) {
            diagonal += lengthOf(segment);
            continue;
        }

        const key   = horizontal ? `h${snap(segment.a.y)}` : `v${snap(segment.a.x)}`;
        const from  = horizontal ? segment.a.x : segment.a.y;
        const to    = horizontal ? segment.b.x : segment.b.y;
        const range: [number, number] = [Math.min(from, to), Math.max(from, to)];

        const existing = lines.get(key);

        if (existing) {
            existing.push(range);
        } else {
            lines.set(key, [range]);
        }
    }

    let total = diagonal;

    for (const intervals of lines.values()) {
        total += unionLength(intervals);
    }

    return total;
}

/**
 * The largest number of distinct directions meeting at any one vertex. A
 * direction and its opposite count as one, since they draw the same line — so a
 * plain bend reports two and a 150-way convergence reports its full fan.
 *
 * @param segments - Every drawn segment.
 * @returns The widest fan, or 0 when there are no segments.
 */
function widestVertexFan(segments: Segment[]): number {
    const atVertex = new Map<string, Set<number>>();

    const record = (vertex: ElkPoint, other: ElkPoint): void => {
        const key = `${snap(vertex.x)},${snap(vertex.y)}`;
        const raw = Math.atan2(other.y - vertex.y, other.x - vertex.x) * HALF_TURN_DEGREES / Math.PI;

        // Modulo a half turn: the segment's two ends must agree on one line.
        const direction = Math.round(((raw % HALF_TURN_DEGREES) + HALF_TURN_DEGREES) % HALF_TURN_DEGREES / DIRECTION_GRID);

        const existing = atVertex.get(key);

        if (existing) {
            existing.add(direction);
        } else {
            atVertex.set(key, new Set([direction]));
        }
    };

    for (const segment of segments) {
        record(segment.a, segment.b);
        record(segment.b, segment.a);
    }

    let widest = 0;

    for (const directions of atVertex.values()) {
        widest = Math.max(widest, directions.size);
    }

    return widest;
}

/**
 * How many segments pass through a node's rectangle. Exact for the axis-parallel
 * segments a layered routing draws; a bounding-box test for any diagonal, which
 * over-reports rather than under-reports — the safe direction for an assertion
 * that expects zero.
 *
 * @param segments - Every drawn segment.
 * @param result - The routed layout, for its node rects.
 * @returns The number of offending segments.
 */
function nodeIntersections(segments: Segment[], result: DiagramLayoutResult): number {
    let hits = 0;

    for (const segment of segments) {
        const minX = Math.min(segment.a.x, segment.b.x);
        const maxX = Math.max(segment.a.x, segment.b.x);
        const minY = Math.min(segment.a.y, segment.b.y);
        const maxY = Math.max(segment.a.y, segment.b.y);

        const crosses = result.nodes.some((node) => {
            const left   = node.x + NODE_CLEARANCE_INSET;
            const right  = node.x + node.width  - NODE_CLEARANCE_INSET;
            const top    = node.y + NODE_CLEARANCE_INSET;
            const bottom = node.y + node.height - NODE_CLEARANCE_INSET;

            return minX < right && maxX > left && minY < bottom && maxY > top;
        });

        if (crosses) {
            hits += 1;
        }
    }

    return hits;
}

/**
 * Measures a routed layout on the four axes that separate bundling strategies.
 *
 * @param result - The routed layout to measure.
 * @returns The metrics.
 */
export function bundlingMetrics(result: DiagramLayoutResult): BundlingMetrics {
    const segments = segmentsOf(result);

    return {
        totalRouteLength : segments.reduce((sum, segment) => sum + lengthOf(segment), 0),
        distinctInkLength: distinctInk(segments),
        maxVertexFan     : widestVertexFan(segments),
        nodeIntersections: nodeIntersections(segments, result),
    };
}

/** Graph units per "k" in a formatted length. */
const THOUSAND = 1000;

/**
 * A length as a short display string: whole units below a thousand, then `k`,
 * then `M`, so the widest value still fits the side column.
 *
 * @param value - The length in graph units.
 * @returns The display string.
 */
function shortLength(value: number): string {
    if (value < THOUSAND) {
        return String(Math.round(value));
    }

    if (value < THOUSAND * THOUSAND) {
        return `${(value / THOUSAND).toFixed(1)}k`;
    }

    return `${(value / (THOUSAND * THOUSAND)).toFixed(1)}M`;
}

/**
 * The metrics as short display lines, one per line, for the shell's fixed-width
 * control column.
 *
 * @param metrics - The measured metrics.
 * @returns Four lines, in reading order.
 */
export function formatBundlingMetrics(metrics: BundlingMetrics): string[] {
    return [
        `Total: ${shortLength(metrics.totalRouteLength)}`,
        `Ink: ${shortLength(metrics.distinctInkLength)}`,
        `Max fan: ${metrics.maxVertexFan}`,
        `Node hits: ${metrics.nodeIntersections}`,
    ];
}
