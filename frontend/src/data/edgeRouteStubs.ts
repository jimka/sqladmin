// Pure rewrite of an ELK layout result: gives every fan-out/fan-in bundle of
// portless edges a short shared run near the node they share, instead of the
// long coincident trunk `elk.layered.mergeEdges` used to produce. No DOM, no
// ELK — type-only imports from the diagram barrel keep this node-vitest-
// testable, the same purity discipline as fkCardinality.ts:1-7 (never import
// UI-bundle runtime code, which runs DOM-touching module-level side effects on
// import). Nothing here mutates `result`, its edges, or their sections; see
// `stubBundledEdgeRoutes`'s own purity note.

import type { DiagramData, DiagramLayoutResult, ElkEdgeSection, ElkPoint } from "@jimka/typescript-ui/component/diagram";

/**
 * Clear line, in graph units, left between the tip of an end marker and the
 * junction. The junction has to read as sitting outside the glyph, not at its
 * edge, so this is nearly as long as the glyph itself.
 */
const JUNCTION_GLYPH_MARGIN = 14;

/**
 * Clear line left between marker tip and junction when the shortest bundle
 * member is too short for the preferred distance. Enough to keep the branch
 * visibly outside the glyph rather than touching it.
 */
const JUNCTION_GLYPH_MIN_MARGIN = 4;

/**
 * Fraction of the shortest leading run a junction comfortably consumes. A half
 * keeps the junction well inside every bundle member's own first segment on a
 * normal-length edge.
 */
const STUB_CLEARANCE_FRACTION = 0.5;

/**
 * Hard cap on the fraction of the shortest leading run a junction may consume,
 * applied after {@link StubGeometry.minimum} has had its say. Without it that
 * floor could push a junction onto — or past — the next vertex of a very short
 * edge (adjacent layers, or two overlapping nodes) and double the route back on
 * itself.
 */
const STUB_MAX_FRACTION = 0.9;

/** The two distances a junction respects, both derived from the end-marker extent. */
export interface StubGeometry {
    /** Preferred distance from the node border to the junction. */
    preferred: number;
    /** Shortest distance still worth calling a junction, used when an edge is short. */
    minimum:   number;
}

/**
 * The junction distances for a given end-marker extent. An end marker is drawn
 * backwards from the arrival vertex over `markerExtent` units, so a shared run
 * shorter than that puts the branch underneath the glyph rather than beside it.
 *
 * The extent is a parameter rather than an import because the library only
 * exposes it (as `EDGE_MARKER_EXTENT`) from a barrel whose modules touch
 * `document` at import scope — see this file's header note on staying
 * node-vitest-testable. `JunctionDiagramView`, which already imports the
 * library at runtime, supplies it.
 *
 * @param markerExtent - How far an end marker reaches back along the edge.
 * @returns The preferred and minimum junction distances.
 */
export function stubGeometry(markerExtent: number): StubGeometry {
    return {
        preferred: markerExtent + JUNCTION_GLYPH_MARGIN,
        minimum:   markerExtent + JUNCTION_GLYPH_MIN_MARGIN,
    };
}

/**
 * How far off a node's border an endpoint may sit and still count as anchored to
 * it. ELK reports fractional coordinates, so an exact equality test would reject
 * real anchors; anything farther than half a unit from all four borders is not a
 * border anchor and is left alone.
 */
const BOUNDARY_EPSILON = 0.5;

// Bundle key separator, NUL. A node id, "in"/"out", and a Side string can
// never themselves contain NUL, so no combination of them can collide across
// bundle keys -- the same rationale as buildSchemaDiagram.ts's
// PAIR_KEY_SEPARATOR, which this mirrors.
const BUNDLE_KEY_SEPARATOR = "\u0000";

/** A node's absolute rect in graph space, as `DiagramLayoutResult.nodes` reports it. */
interface NodeRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Which border of a node's rect a point sits on. */
type Side = "west" | "east" | "north" | "south";

/** One route endpoint that has joined a bundle: which edge, which end, and the geometry `junctionFor` needs. */
interface BundleMember {
    edgeId: string;
    end: "source" | "target";
    /** The endpoint's own point, on the node's border. */
    point: ElkPoint;
    /** The route's next vertex past this endpoint (toward the rest of the route). */
    nextVertex: ElkPoint;
    side: Side;
}

/** The shared anchor and junction a bundle's members are rewritten onto. */
interface JunctionPair {
    anchor: ElkPoint;
    junction: ElkPoint;
}

/**
 * Which border of `rect` `point` sits on, or `null` when it is farther than
 * {@link BOUNDARY_EPSILON} from all four.
 *
 * @param point - The point to classify.
 * @param rect - The node's absolute rect.
 * @returns The border, or `null`.
 */
function sideOfPoint(point: ElkPoint, rect: NodeRect): Side | null {
    if (Math.abs(point.x - rect.x) <= BOUNDARY_EPSILON) {
        return "west";
    }

    if (Math.abs(point.x - (rect.x + rect.width)) <= BOUNDARY_EPSILON) {
        return "east";
    }

    if (Math.abs(point.y - rect.y) <= BOUNDARY_EPSILON) {
        return "north";
    }

    if (Math.abs(point.y - (rect.y + rect.height)) <= BOUNDARY_EPSILON) {
        return "south";
    }

    return null;
}

/**
 * The unit vector pointing out of `side`.
 *
 * @param side - A node border.
 * @returns The outward unit normal.
 */
function outwardNormal(side: Side): ElkPoint {
    switch (side) {
        case "west":  return { x: -1, y: 0 };
        case "east":  return { x: 1, y: 0 };
        case "north": return { x: 0, y: -1 };
        case "south": return { x: 0, y: 1 };
    }
}

/** Euclidean distance between two points. */
function distance(a: ElkPoint, b: ElkPoint): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Groups every portless, non-self-loop, on-border route endpoint into bundles
 * keyed by (node, direction, side): every endpoint in one bundle shares a node,
 * leaves or arrives together, and sits on the same border.
 *
 * @param data - The model graph (for each edge's `source`/`target`/`sourcePort`/`targetPort`).
 * @param result - The ELK layout result (for each edge's routed sections).
 * @param rectById - Every node's absolute rect, keyed by id.
 * @returns The bundles, keyed by an opaque bundle key.
 */
function collectBundles(
    data: DiagramData,
    result: DiagramLayoutResult,
    rectById: Map<string, NodeRect>,
): Map<string, BundleMember[]> {
    const modelEdgeById = new Map(data.edges.map(e => [e.id, e]));
    const bundles = new Map<string, BundleMember[]>();

    const addMember = (key: string, member: BundleMember): void => {
        const existing = bundles.get(key);

        if (existing) {
            existing.push(member);
        } else {
            bundles.set(key, [member]);
        }
    };

    for (const edge of result.edges) {
        const modelEdge = modelEdgeById.get(edge.id);

        if (!modelEdge || modelEdge.source === modelEdge.target || edge.sections.length === 0) {
            continue; // no model edge, a self-loop, or no route: nothing to bundle
        }

        if (!modelEdge.sourcePort) {
            const rect = rectById.get(modelEdge.source);
            const firstSection = edge.sections[0];
            const side = rect ? sideOfPoint(firstSection.startPoint, rect) : null;

            if (side !== null) {
                addMember(`${modelEdge.source}${BUNDLE_KEY_SEPARATOR}out${BUNDLE_KEY_SEPARATOR}${side}`, {
                    edgeId: edge.id,
                    end: "source",
                    point: firstSection.startPoint,
                    nextVertex: firstSection.bendPoints?.[0] ?? firstSection.endPoint,
                    side,
                });
            }
        }

        if (!modelEdge.targetPort) {
            const rect = rectById.get(modelEdge.target);
            const lastSection = edge.sections[edge.sections.length - 1];
            const side = rect ? sideOfPoint(lastSection.endPoint, rect) : null;

            if (side !== null) {
                addMember(`${modelEdge.target}${BUNDLE_KEY_SEPARATOR}in${BUNDLE_KEY_SEPARATOR}${side}`, {
                    edgeId: edge.id,
                    end: "target",
                    point: lastSection.endPoint,
                    nextVertex: lastSection.bendPoints?.[lastSection.bendPoints.length - 1] ?? lastSection.startPoint,
                    side,
                });
            }
        }
    }

    return bundles;
}

/**
 * The shared anchor (the bundle's mean point) and junction (the anchor pushed
 * out along the border's normal by the clamped stub length) for one bundle.
 *
 * @param members - The bundle's members (at least one; callers skip size-1 bundles).
 * @param geometry - The junction distances for the diagram's end-marker extent.
 * @returns The anchor + junction pair every member is rewritten onto.
 */
function junctionFor(members: BundleMember[], geometry: StubGeometry): JunctionPair {
    const anchor: ElkPoint = {
        x: members.reduce((sum, m) => sum + m.point.x, 0) / members.length,
        y: members.reduce((sum, m) => sum + m.point.y, 0) / members.length,
    };

    const normal = outwardNormal(members[0].side);
    const dmin   = Math.min(...members.map(m => distance(anchor, m.nextVertex)));

    // Three rules, tightest wins: never longer than the preferred distance; at
    // least the marker clearance, so a short edge still branches outside its
    // glyph rather than underneath it; and never more than STUB_MAX_FRACTION of
    // the shortest member, so that floor can't push the junction onto its next
    // vertex.
    const length = Math.min(
        geometry.preferred,
        Math.max(geometry.minimum, dmin * STUB_CLEARANCE_FRACTION),
        dmin * STUB_MAX_FRACTION,
    );

    return {
        anchor,
        junction: { x: anchor.x + normal.x * length, y: anchor.y + normal.y * length },
    };
}

/**
 * Rewrites one end of a routed edge's sections: the endpoint moves to `anchor`
 * and `junction` is inserted as the adjacent vertex. Returns a new array; the
 * input sections are not mutated, and every section other than the rewritten
 * one is passed through unchanged.
 *
 * @param sections - The edge's routed sections.
 * @param end - Which end to rewrite — `"source"` touches the first section,
 *   `"target"` the last (the same section when there is only one).
 * @param anchor - The bundle's shared anchor, replacing the endpoint's own point.
 * @param junction - The bundle's shared junction, inserted next to the anchor.
 * @returns The rewritten sections.
 */
function withStub(
    sections: ElkEdgeSection[],
    end: "source" | "target",
    anchor: ElkPoint,
    junction: ElkPoint,
): ElkEdgeSection[] {
    const index = end === "source" ? 0 : sections.length - 1;

    return sections.map((section, i) => {
        if (i !== index) {
            return section;
        }

        if (end === "source") {
            return { ...section, startPoint: anchor, bendPoints: [junction, ...(section.bendPoints ?? [])] };
        }

        return { ...section, endPoint: anchor, bendPoints: [...(section.bendPoints ?? []), junction] };
    });
}

/**
 * Rewrites `result`'s routes so every fan-out and fan-in bundle of portless
 * edges meets at a short junction near the node they share, instead of the
 * long coincident trunk `elk.layered.mergeEdges` used to produce (see the
 * plan's `## Architecture Decisions`). A bundle is every route endpoint that
 * shares a node, a direction (leaving or arriving), and a node side, counting
 * only endpoints whose model edge names no port on that side — an edge whose
 * `sourcePort`/`targetPort` is set never joins a bundle, and neither does a
 * self-loop (pulling both of its endpoints to one anchor would collapse it to
 * zero area). A bundle of one is left untouched.
 *
 * Pure: `result`, its edges, and their sections are never mutated; `nodes`,
 * `width`, and `height` pass through unchanged, since the transform moves no
 * node and adds no vertex outside the span the bundle's own routes already
 * covered.
 *
 * @param data - The model graph the layout was built from (for port lookups).
 * @param result - The ELK layout result to rewrite.
 * @param geometry - The junction distances, from {@link stubGeometry}.
 * @returns A new `DiagramLayoutResult` with stubbed routes.
 */
export function stubBundledEdgeRoutes(
    data: DiagramData,
    result: DiagramLayoutResult,
    geometry: StubGeometry,
): DiagramLayoutResult {
    const rectById = new Map(result.nodes.map(n => [n.id, { x: n.x, y: n.y, width: n.width, height: n.height }]));
    const bundles  = collectBundles(data, result, rectById);

    const patches = new Map<string, { source?: JunctionPair; target?: JunctionPair }>();

    for (const members of bundles.values()) {
        if (members.length < 2) {
            continue; // a bundle of one has nothing to converge with
        }

        const pair = junctionFor(members, geometry);

        for (const member of members) {
            const patch = patches.get(member.edgeId) ?? {};

            patch[member.end] = pair;
            patches.set(member.edgeId, patch);
        }
    }

    const edges = result.edges.map((edge) => {
        const patch = patches.get(edge.id);

        if (!patch) {
            return edge;
        }

        let sections = edge.sections;

        if (patch.source) {
            sections = withStub(sections, "source", patch.source.anchor, patch.source.junction);
        }

        if (patch.target) {
            sections = withStub(sections, "target", patch.target.anchor, patch.target.junction);
        }

        return { id: edge.id, sections };
    });

    return { nodes: result.nodes, edges, width: result.width, height: result.height };
}
