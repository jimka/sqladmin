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

/** One route endpoint that has joined a bundle: which edge, which end, and the geometry the routers need. */
interface BundleMember {
    edgeId: string;
    end: "source" | "target";
    /** The node this end is anchored to — what the obstacle check excludes. */
    nodeId: string;
    /** The endpoint's own point, on the node's border. */
    point: ElkPoint;
    /** The route's next vertex past this endpoint (toward the rest of the route) — the approach bend. */
    nextVertex: ElkPoint;
    /**
     * The vertex one further out again: where the route's own long run enters
     * the approach channel. Null when the section carries fewer than two bend
     * points, i.e. there is no distinct channel run to redirect.
     */
    priorVertex: ElkPoint | null;
    side: Side;
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
                const bends = firstSection.bendPoints ?? [];

                addMember(`${modelEdge.source}${BUNDLE_KEY_SEPARATOR}out${BUNDLE_KEY_SEPARATOR}${side}`, {
                    edgeId: edge.id,
                    end: "source",
                    nodeId: modelEdge.source,
                    point: firstSection.startPoint,
                    // A source end reads its route forwards: the approach bend is
                    // the first, the channel entry the second.
                    nextVertex: bends[0] ?? firstSection.endPoint,
                    priorVertex: bends.length >= 2 ? bends[1] : null,
                    side,
                });
            }
        }

        if (!modelEdge.targetPort) {
            const rect = rectById.get(modelEdge.target);
            const lastSection = edge.sections[edge.sections.length - 1];
            const side = rect ? sideOfPoint(lastSection.endPoint, rect) : null;

            if (side !== null) {
                const bends = lastSection.bendPoints ?? [];

                addMember(`${modelEdge.target}${BUNDLE_KEY_SEPARATOR}in${BUNDLE_KEY_SEPARATOR}${side}`, {
                    edgeId: edge.id,
                    end: "target",
                    nodeId: modelEdge.target,
                    point: lastSection.endPoint,
                    // A target end reads its route backwards: the approach bend is
                    // the last, the channel entry the one before it.
                    nextVertex: bends[bends.length - 1] ?? lastSection.startPoint,
                    priorVertex: bends.length >= 2 ? bends[bends.length - 2] : null,
                    side,
                });
            }
        }
    }

    return bundles;
}

/**
 * The border-relative frame every strategy works in, so none of them assumes
 * east/west. `out` measures distance off the border along the outward normal;
 * `across` measures position along the border itself.
 */
interface BorderFrame {
    /** The bundle's shared anchor on the node border — the frame's origin. */
    anchor:  ElkPoint;
    /** Unit vector pointing out of the border. */
    normal:  ElkPoint;
    /** Unit vector along the border. */
    tangent: ElkPoint;
}

/**
 * The unit vector along `side`, perpendicular to its outward normal.
 *
 * @param side - A node border.
 * @returns The unit tangent.
 */
function tangent(side: Side): ElkPoint {
    switch (side) {
        case "west":
        case "east":  return { x: 0, y: 1 };
        case "north":
        case "south": return { x: 1, y: 0 };
    }
}

/**
 * How far off the border `point` sits.
 *
 * @param point - The point to measure.
 * @param frame - The bundle's border frame.
 * @returns The signed distance along the outward normal.
 */
function outAlong(point: ElkPoint, frame: BorderFrame): number {
    return (point.x - frame.anchor.x) * frame.normal.x + (point.y - frame.anchor.y) * frame.normal.y;
}

/**
 * Where along the border `point` sits.
 *
 * @param point - The point to measure.
 * @param frame - The bundle's border frame.
 * @returns The signed distance along the border, zero at the anchor.
 */
function acrossAlong(point: ElkPoint, frame: BorderFrame): number {
    return (point.x - frame.anchor.x) * frame.tangent.x + (point.y - frame.anchor.y) * frame.tangent.y;
}

/**
 * The point at frame coordinates (`out`, `across`).
 *
 * @param frame - The bundle's border frame.
 * @param out - Distance off the border along the outward normal.
 * @param across - Distance along the border from the anchor.
 * @returns The absolute point.
 */
function pointAt(frame: BorderFrame, out: number, across: number): ElkPoint {
    return {
        x: frame.anchor.x + frame.normal.x * out + frame.tangent.x * across,
        y: frame.anchor.y + frame.normal.y * out + frame.tangent.y * across,
    };
}

/**
 * The border frame for one bundle: the anchor is the members' mean point, and
 * the axes come from the border they share.
 *
 * @param members - The bundle's members (at least one; callers skip size-1 bundles).
 * @returns The bundle's frame.
 */
function bundleFrame(members: BundleMember[]): BorderFrame {
    return {
        anchor: {
            x: members.reduce((sum, m) => sum + m.point.x, 0) / members.length,
            y: members.reduce((sum, m) => sum + m.point.y, 0) / members.length,
        },
        normal : outwardNormal(members[0].side),
        tangent: tangent(members[0].side),
    };
}

/**
 * The clamped distance from the border at which a bundle's innermost shared
 * point sits. Every strategy uses it, so all three place their final vertex the
 * same distance out and the marker-clearance rule holds across all of them.
 *
 * @param members - The bundle's members.
 * @param frame - The bundle's border frame (for the anchor).
 * @param geometry - The junction distances for the diagram's end-marker extent.
 * @returns The stub length in graph units.
 */
function stubLength(members: BundleMember[], frame: BorderFrame, geometry: StubGeometry): number {
    const dmin = Math.min(...members.map(m => distance(frame.anchor, m.nextVertex)));

    // Three rules, tightest wins: never longer than the preferred distance; at
    // least the marker clearance, so a short edge still branches outside its
    // glyph rather than underneath it; and never more than STUB_MAX_FRACTION of
    // the shortest member, so that floor can't push the junction onto its next
    // vertex.
    return Math.min(
        geometry.preferred,
        Math.max(geometry.minimum, dmin * STUB_CLEARANCE_FRACTION),
        dmin * STUB_MAX_FRACTION,
    );
}

/** How one member's end is rewritten onto its bundle's shared structure. */
interface MemberTail {
    /** Points inserted between the member's own route and `anchor`, ordered toward the node. */
    via: ElkPoint[];
    /** The bundle's shared anchor on the node border. */
    anchor: ElkPoint;
    /** Whether the member's own approach bend is dropped before `via` is spliced in. */
    dropApproachBend: boolean;
}

/**
 * The single-junction tail: today's behaviour, and every strategy's fallback.
 * The member keeps its own approach bend and simply meets the shared junction.
 *
 * @param frame - The bundle's border frame.
 * @param length - The stub length from {@link stubLength}.
 * @returns The tail every member of a junction-strategy bundle shares.
 */
function junctionTail(frame: BorderFrame, length: number): MemberTail {
    return { via: [pointAt(frame, length, 0)], anchor: frame.anchor, dropApproachBend: false };
}

/**
 * Rewrites one end of a routed edge's sections onto its bundle's shared
 * structure: the endpoint moves to `tail.anchor` and `tail.via` is spliced in
 * beside it, optionally replacing the member's own approach bend. Returns a new
 * array; the input sections are not mutated, and every section other than the
 * rewritten one is passed through unchanged.
 *
 * @param sections - The edge's routed sections.
 * @param end - Which end to rewrite — `"source"` touches the first section,
 *   `"target"` the last (the same section when there is only one).
 * @param tail - What to rewrite the end onto.
 * @returns The rewritten sections.
 */
function withTail(
    sections: ElkEdgeSection[],
    end: "source" | "target",
    tail: MemberTail,
): ElkEdgeSection[] {
    const index = end === "source" ? 0 : sections.length - 1;

    return sections.map((section, i) => {
        if (i !== index) {
            return section;
        }

        const bends = section.bendPoints ?? [];

        // `via` runs toward the node, so a source end — whose bend list runs away
        // from the node — takes it reversed. Dropping the approach bend removes
        // the vertex nearest the node, which is the one `via` supersedes.
        if (end === "source") {
            const kept = tail.dropApproachBend ? bends.slice(1) : bends;

            return { ...section, startPoint: tail.anchor, bendPoints: [...[...tail.via].reverse(), ...kept] };
        }

        const kept = tail.dropApproachBend ? bends.slice(0, -1) : bends;

        return { ...section, endPoint: tail.anchor, bendPoints: [...kept, ...tail.via] };
    });
}

/**
 * Smallest bundle a non-junction strategy engages on. Below it every strategy
 * keeps the single junction.
 *
 * Measured over the 154-table `hub` schema's folded FK graph (903 edges): four
 * tables take ~150 incoming edges each and every other table takes 1 to 4, so
 * any threshold between 5 and 150 selects the same four hubs today. Twelve sits
 * inside that gap rather than at its edge — low enough that a moderately
 * referenced lookup table still benefits, high enough that no ordinary table
 * runs the new path, and roughly where a fan stops being traceable by eye.
 */
export const BUNDLE_MIN_MEMBERS = 12;

/**
 * How far, in graph units, a shared trunk may sit from the destination border.
 *
 * The narrowest inter-layer gap measured on `hub` is 90 (see
 * buildSchemaDiagram.ts's LAYOUT_OPTIONS comment: "99 gaps at 100 and 50 at 90
 * — none at 60"), so a trunk held inside 90 stays in the channel ELK reserved
 * immediately before the destination and cannot reach the previous layer's
 * nodes. Deliberately not scaled to the graph width: a bundle spanning many
 * layers is likelier to cross occupied ground, so a width-relative reach would
 * grow exactly where the risk grows.
 */
export const BUNDLE_TRUNK_REACH = 90;

/**
 * Deepest merge tree accepted before a bundle falls back to the single
 * junction. Centroid linkage yields about log2(n) levels on evenly spread
 * members — 8 for 153 — but can still chain on exponentially spread ones.
 * Sixteen is twice that ideal depth, so a merely unbalanced tree passes and
 * only a genuine comb is rejected.
 */
export const MERGE_TREE_MAX_DEPTH = 16;

/**
 * How far a node rect is shrunk before the obstacle check, in graph units. A
 * constructed segment legitimately ends *on* the destination's border, so an
 * un-inset rect would report every bundle as blocked; one unit is below ELK's
 * coordinate granularity yet enough to exclude a touching endpoint.
 */
const NODE_CLEARANCE_INSET = 1;

/** Which shape a bundle's shared run takes. */
export type BundlingStrategy = "junction" | "spine" | "tree";

/** The strategies in selector order; `"junction"` is the default. */
export const BUNDLING_STRATEGIES: readonly BundlingStrategy[] = ["junction", "spine", "tree"];

/** Tuning for {@link stubBundledEdgeRoutes}; every field has a documented default. */
export interface BundlingOptions {
    /** The shape to build. Default `"junction"` (today's behaviour). */
    strategy?: BundlingStrategy;
    /** Smallest bundle a non-junction strategy engages on. Default {@link BUNDLE_MIN_MEMBERS}. */
    minMembers?: number;
    /** How far back from the destination border a trunk may sit. Default {@link BUNDLE_TRUNK_REACH}. */
    trunkReach?: number;
    /** Deepest merge tree accepted before falling back. Default {@link MERGE_TREE_MAX_DEPTH}. */
    maxTreeDepth?: number;
}

/**
 * True when the axis-parallel segment `a`-`b` passes through the interior of
 * any node rect other than `exclude`. Rects are inset by
 * {@link NODE_CLEARANCE_INSET} so a segment merely ending on a border does not
 * count. Exact for the segments the routers build, since every one of them is
 * parallel or perpendicular to the destination border, making this a plain
 * axis-aligned box overlap.
 *
 * @param a - One end of the segment.
 * @param b - The other end.
 * @param rects - Every node's absolute rect, keyed by id.
 * @param exclude - The bundle's own node, whose border the segment ends on.
 * @returns True when the segment crosses an obstacle.
 */
function segmentHitsNode(a: ElkPoint, b: ElkPoint, rects: Map<string, NodeRect>, exclude: string): boolean {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);

    for (const [id, rect] of rects) {
        if (id === exclude) {
            continue;
        }

        const left   = rect.x + NODE_CLEARANCE_INSET;
        const right  = rect.x + rect.width  - NODE_CLEARANCE_INSET;
        const top    = rect.y + NODE_CLEARANCE_INSET;
        const bottom = rect.y + rect.height - NODE_CLEARANCE_INSET;

        if (minX < right && maxX > left && minY < bottom && maxY > top) {
            return true;
        }
    }

    return false;
}

/**
 * How far a member's approach bend may sit off its own endpoint's across
 * coordinate and still count as running straight out from the border. Same
 * rationale as {@link BOUNDARY_EPSILON}: ELK reports fractional coordinates, so
 * an exact equality test would reject real perpendicular approaches.
 */
const APPROACH_PARALLEL_EPSILON = 0.5;

/**
 * Whether a member has a distinct channel run a shared structure can redirect:
 * a channel-entry vertex, an approach that runs straight out from the border,
 * and that entry sitting further out than the trunk it would join. A member
 * failing any of these keeps the single-junction tail while the rest of the
 * bundle uses the shared shape — degrading per member rather than per bundle,
 * since a route with no channel run to redirect has nothing to reroute.
 *
 * @param member - The member to test.
 * @param frame - The bundle's border frame.
 * @param trunkOut - How far out the trunk this member would join sits.
 * @returns True when the member can join the shared structure.
 */
function participates(member: BundleMember, frame: BorderFrame, trunkOut: number): boolean {
    if (member.priorVertex === null) {
        return false;
    }

    const drift = Math.abs(acrossAlong(member.nextVertex, frame) - acrossAlong(member.point, frame));

    if (drift > APPROACH_PARALLEL_EPSILON) {
        return false;
    }

    return outAlong(member.priorVertex, frame) > trunkOut;
}

/**
 * Whether a member could join a shared structure at all, ignoring how far out
 * that structure sits — the two conditions that depend only on the route's own
 * shape. Separated from {@link participates} because a spine's position is
 * itself derived from these members.
 *
 * @param member - The member to test.
 * @param frame - The bundle's border frame.
 * @returns True when the member has a redirectable channel run.
 */
function hasChannelRun(member: BundleMember, frame: BorderFrame): boolean {
    if (member.priorVertex === null) {
        return false;
    }

    return Math.abs(acrossAlong(member.nextVertex, frame) - acrossAlong(member.point, frame)) <= APPROACH_PARALLEL_EPSILON;
}

/**
 * True when any segment of the polyline `points` crosses a node other than
 * `exclude`.
 *
 * @param points - The polyline's vertices, in order.
 * @param rects - Every node's absolute rect.
 * @param exclude - The bundle's own node.
 * @returns True when the polyline crosses an obstacle.
 */
function polylineHitsNode(points: ElkPoint[], rects: Map<string, NodeRect>, exclude: string): boolean {
    for (let i = 1; i < points.length; i += 1) {
        if (segmentHitsNode(points[i - 1], points[i], rects, exclude)) {
            return true;
        }
    }

    return false;
}

/**
 * Routes a bundle as a collector spine: one trunk in the channel beside the
 * node, which every participating member joins at its own across coordinate.
 * The member's long run moves from its own private coordinate onto the shared
 * one, so a fan of near-parallel approaches collapses to a single line.
 *
 * @param members - The bundle's members.
 * @param frame - The bundle's border frame.
 * @param length - The stub length {@link stubLength} computed.
 * @param geometry - The junction distances for the diagram's end-marker extent.
 * @param rects - Every node's absolute rect, for the obstacle check.
 * @returns One tail per member, or null when the spine cannot be built safely.
 */
function routeCollectorSpine(
    members: BundleMember[],
    frame: BorderFrame,
    length: number,
    geometry: StubGeometry,
    rects: Map<string, NodeRect>,
): Map<string, MemberTail> | null {
    const candidates = members.filter(m => hasChannelRun(m, frame));

    if (candidates.length < 2) {
        return null;
    }

    // `stubLength` measures Euclidean distance from the anchor; a spine needs
    // the perpendicular run, which is never longer and is what the trunk
    // actually consumes.
    const shortestRun = Math.min(...candidates.map(m => outAlong(m.nextVertex, frame)));
    const spineOut    = Math.min(length, shortestRun * STUB_MAX_FRACTION);

    if (spineOut < geometry.minimum) {
        return null; // no room to sit outside the end-marker glyph
    }

    const participants = candidates.filter(m => participates(m, frame, spineOut));

    if (participants.length < 2) {
        return null;
    }

    const acrosses = participants.map(m => acrossAlong(m.priorVertex!, frame));
    const trunk    = [
        pointAt(frame, spineOut, Math.min(0, ...acrosses)),
        pointAt(frame, spineOut, Math.max(0, ...acrosses)),
    ];

    if (polylineHitsNode(trunk, rects, participants[0].nodeId)) {
        return null;
    }

    const tails = new Map<string, MemberTail>(members.map(m => [m.edgeId, junctionTail(frame, spineOut)]));

    for (const [i, member] of participants.entries()) {
        const join = pointAt(frame, spineOut, acrosses[i]);

        if (polylineHitsNode([member.priorVertex!, join], rects, member.nodeId)) {
            return null;
        }

        tails.set(member.edgeId, {
            via: [join, pointAt(frame, spineOut, 0)],
            anchor: frame.anchor,
            dropApproachBend: true,
        });
    }

    return tails;
}

/** One node of the merge tree: a leaf holds a member, an internal node holds two children. */
interface MergeCluster {
    /** Where along the border this cluster sits. */
    centroid: number;
    /** How many members it covers, for the weighted merge. */
    count: number;
    children: [MergeCluster, MergeCluster] | null;
    /** The member, on a leaf; null on an internal node. */
    member: BundleMember | null;
    /** Levels below the root, filled once the tree is built. */
    depth: number;
}

/**
 * Clusters `leaves` bottom-up, repeatedly merging the pair whose centroids are
 * closest. `leaves` must be sorted by centroid, which makes the closest pair
 * always adjacent and keeps the list sorted as merges replace pairs — so ties
 * break toward the leftmost, i.e. the smaller centroid.
 *
 * Merging by centroid rather than by nearest member is what produces a tree
 * instead of a comb: nearest-member linkage on collinear points chains, since
 * the merged cluster keeps a member at the old minimum distance.
 *
 * @param leaves - The leaf clusters, sorted ascending by centroid.
 * @returns The root cluster.
 */
function buildMergeTree(leaves: MergeCluster[]): MergeCluster {
    const clusters = [...leaves];

    while (clusters.length > 1) {
        let best = 0;
        let bestGap = Number.POSITIVE_INFINITY;

        for (let i = 0; i + 1 < clusters.length; i += 1) {
            const gap = clusters[i + 1].centroid - clusters[i].centroid;

            if (gap < bestGap) {
                bestGap = gap;
                best = i;
            }
        }

        const [left, right] = [clusters[best], clusters[best + 1]];
        const count = left.count + right.count;

        clusters.splice(best, 2, {
            centroid: (left.centroid * left.count + right.centroid * right.count) / count,
            count,
            children: [left, right],
            member  : null,
            depth   : 0,
        });
    }

    return clusters[0];
}

/**
 * Labels every cluster with its depth below the root.
 *
 * @param cluster - The subtree root.
 * @param depth - The depth to assign it.
 * @returns The deepest internal (non-leaf) depth in the subtree.
 */
function labelDepths(cluster: MergeCluster, depth: number): number {
    cluster.depth = depth;

    if (!cluster.children) {
        return -1; // a leaf occupies no trunk level of its own
    }

    return Math.max(depth, labelDepths(cluster.children[0], depth + 1), labelDepths(cluster.children[1], depth + 1));
}

/**
 * Walks the tree collecting each leaf together with its ancestor chain,
 * root-first.
 *
 * @param cluster - The subtree root.
 * @param ancestors - The chain above `cluster`, root-first.
 * @param into - Collects one entry per leaf.
 */
function collectLeafPaths(
    cluster: MergeCluster,
    ancestors: MergeCluster[],
    into: { leaf: MergeCluster; ancestors: MergeCluster[] }[],
): void {
    if (!cluster.children) {
        into.push({ leaf: cluster, ancestors });

        return;
    }

    const chain = [...ancestors, cluster];

    collectLeafPaths(cluster.children[0], chain, into);
    collectLeafPaths(cluster.children[1], chain, into);
}

/**
 * Routes a bundle as a merge tree: members converge in pairs of nearest
 * clusters, each merge sitting one trunk level further out than the one it
 * feeds, so the fan resolves into a branching structure rather than a single
 * apex.
 *
 * @param members - The bundle's members.
 * @param frame - The bundle's border frame.
 * @param length - The stub length {@link stubLength} computed; the root sits here.
 * @param reach - How far out the deepest trunk level may sit.
 * @param maxDepth - Deepest tree accepted before declining the bundle.
 * @param rects - Every node's absolute rect, for the obstacle check.
 * @returns One tail per member, or null when the tree cannot be built safely.
 */
function routeMergeTree(
    members: BundleMember[],
    frame: BorderFrame,
    length: number,
    reach: number,
    maxDepth: number,
    rects: Map<string, NodeRect>,
): Map<string, MemberTail> | null {
    if (reach <= length) {
        return null; // no depth to spread trunk levels through
    }

    const participants = members.filter(m => hasChannelRun(m, frame));

    if (participants.length < 2) {
        return null;
    }

    const leaves: MergeCluster[] = participants
        .map(m => ({ centroid: acrossAlong(m.priorVertex!, frame), count: 1, children: null, member: m, depth: 0 }))
        .sort((a, b) => a.centroid - b.centroid);

    const root     = buildMergeTree(leaves);
    const deepest  = labelDepths(root, 0);

    if (deepest > maxDepth) {
        return null; // a comb, not a tree — today's junction reads better
    }

    // Level 0 is the root at `length`; the deepest level lands exactly on
    // `reach`, so the whole tree fits the channel the caller allowed.
    const step  = (reach - length) / Math.max(1, deepest);
    const outAt = (depth: number): number => length + depth * step;

    // The root is forced onto the anchor's own across coordinate so its point is
    // the shared innermost vertex every other strategy also ends on.
    root.centroid = 0;

    const paths: { leaf: MergeCluster; ancestors: MergeCluster[] }[] = [];

    collectLeafPaths(root, [], paths);

    const tails = new Map<string, MemberTail>(members.map(m => [m.edgeId, junctionTail(frame, length)]));

    for (const { leaf, ancestors } of paths) {
        const member = leaf.member!;
        const parent = ancestors[ancestors.length - 1];

        if (outAlong(member.priorVertex!, frame) <= outAt(parent.depth)) {
            continue; // its channel entry is already inside the trunk it would join
        }

        const via = [pointAt(frame, outAt(parent.depth), leaf.centroid)];

        for (let j = ancestors.length - 1; j >= 0; j -= 1) {
            via.push(pointAt(frame, outAt(ancestors[j].depth), ancestors[j].centroid));

            if (j > 0) {
                via.push(pointAt(frame, outAt(ancestors[j - 1].depth), ancestors[j].centroid));
            }
        }

        if (polylineHitsNode([member.priorVertex!, ...via], rects, member.nodeId)) {
            return null;
        }

        tails.set(member.edgeId, { via, anchor: frame.anchor, dropApproachBend: true });
    }

    return tails;
}

/** What one end of an edge is rewritten onto, plus the junction it falls back to. */
interface EndPatch {
    tail: MemberTail;
    /** This bundle's single-junction tail, used when both ends cannot be honoured at once. */
    junction: MemberTail;
}

/**
 * The single-junction tail for whatever innermost point a bundle settled on.
 *
 * Every strategy ends every member on one shared vertex — the last point of
 * `via` — so reading it back off a member's own tail keeps a downgraded member
 * on the same point as its bundle-mates. Recomputing it from the unclamped stub
 * length would not: a spine that clamped itself to fit a short run sits nearer
 * the border than `stubLength` alone would put it, and the downgraded member
 * would then branch at a different distance from everything it arrives with.
 *
 * @param tail - The tail this member would otherwise have been given.
 * @param frame - The bundle's border frame.
 * @returns The junction tail on the bundle's own innermost point.
 */
function junctionFallback(tail: MemberTail, frame: BorderFrame): MemberTail {
    return { via: [tail.via[tail.via.length - 1]], anchor: frame.anchor, dropApproachBend: false };
}

/**
 * Fewest bend points a single section needs before both of its ends may drop
 * their approach bend.
 *
 * When one section is rewritten at both ends, the two ends read the same bend
 * list from opposite directions: the source's channel entry is `bendPoints[1]`
 * and the target's is `bendPoints[length - 2]`. At two bends those are the
 * *other* end's approach bend, so each end drops the vertex the other one is
 * routing from and the two shared runs join across a gap as one diagonal. Three
 * bends is the first length where the ends' entries coincide on a middle vertex
 * that neither drops.
 */
const BOTH_ENDS_MIN_BENDS = 3;

/**
 * The tails to rewrite one edge's two ends onto, downgrading both to the single
 * junction when the section cannot feed both shared structures at once (see
 * {@link BOTH_ENDS_MIN_BENDS}). Only a one-section edge can hit that: with two
 * or more sections the ends touch different ones and share no vertices.
 *
 * @param sections - The edge's routed sections, before rewriting.
 * @param patch - The tails collected for this edge's ends.
 * @returns The source and target tails to apply, either of which may be undefined.
 */
function resolveEndTails(
    sections: ElkEdgeSection[],
    patch: { source?: EndPatch; target?: EndPatch },
): [MemberTail | undefined, MemberTail | undefined] {
    const contested = patch.source?.tail.dropApproachBend === true
        && patch.target?.tail.dropApproachBend === true
        && sections.length === 1
        && (sections[0].bendPoints?.length ?? 0) < BOTH_ENDS_MIN_BENDS;

    if (contested) {
        return [patch.source!.junction, patch.target!.junction];
    }

    return [patch.source?.tail, patch.target?.tail];
}

/**
 * The tails for one bundle under the selected strategy. A strategy that cannot
 * route this bundle — too few members, no room, or an obstacle — falls the
 * whole bundle back to the single junction.
 *
 * @param members - The bundle's members (at least two).
 * @param frame - The bundle's border frame.
 * @param length - The stub length every strategy's innermost point sits at.
 * @param geometry - The junction distances for the diagram's end-marker extent.
 * @param rects - Every node's absolute rect, for the obstacle check.
 * @param options - The caller's tuning.
 * @returns One tail per member, keyed by edge id.
 */
function tailsFor(
    members: BundleMember[],
    frame: BorderFrame,
    length: number,
    geometry: StubGeometry,
    rects: Map<string, NodeRect>,
    options: BundlingOptions | undefined,
): Map<string, MemberTail> {
    const strategy   = options?.strategy   ?? "junction";
    const minMembers = options?.minMembers ?? BUNDLE_MIN_MEMBERS;

    const junctionTails = (): Map<string, MemberTail> =>
        new Map(members.map(m => [m.edgeId, junctionTail(frame, length)]));

    if (strategy === "junction" || members.length < minMembers) {
        return junctionTails();
    }

    const routed = strategy === "spine"
        ? routeCollectorSpine(members, frame, length, geometry, rects)
        : routeMergeTree(members, frame, length, options?.trunkReach ?? BUNDLE_TRUNK_REACH,
                         options?.maxTreeDepth ?? MERGE_TREE_MAX_DEPTH, rects);

    return routed ?? junctionTails();
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
 * Which shape a bundle's shared run takes is `options.strategy`'s to choose —
 * the single junction above, a collector spine, or a merge tree. A strategy
 * only engages on bundles of at least `options.minMembers`, and any bundle it
 * cannot route safely falls back to the single junction, so the two richer
 * shapes are additive: every route they decline is one this function already
 * drew.
 *
 * @param data - The model graph the layout was built from (for port lookups).
 * @param result - The ELK layout result to rewrite.
 * @param geometry - The junction distances, from {@link stubGeometry}.
 * @param options - Strategy and thresholds; omitted means today's single junction.
 * @returns A new `DiagramLayoutResult` with stubbed routes.
 */
export function stubBundledEdgeRoutes(
    data: DiagramData,
    result: DiagramLayoutResult,
    geometry: StubGeometry,
    options?: BundlingOptions,
): DiagramLayoutResult {
    const rectById = new Map(result.nodes.map(n => [n.id, { x: n.x, y: n.y, width: n.width, height: n.height }]));
    const bundles  = collectBundles(data, result, rectById);

    const patches = new Map<string, { source?: EndPatch; target?: EndPatch }>();

    for (const members of bundles.values()) {
        if (members.length < 2) {
            continue; // a bundle of one has nothing to converge with
        }

        const frame  = bundleFrame(members);
        const length = stubLength(members, frame, geometry);
        const tails  = tailsFor(members, frame, length, geometry, rectById, options);

        for (const member of members) {
            const patch = patches.get(member.edgeId) ?? {};
            const tail  = tails.get(member.edgeId)!;

            patch[member.end] = { tail, junction: junctionFallback(tail, frame) };
            patches.set(member.edgeId, patch);
        }
    }

    const edges = result.edges.map((edge) => {
        const patch = patches.get(edge.id);

        if (!patch) {
            return edge;
        }

        const [source, target] = resolveEndTails(edge.sections, patch);
        let sections = edge.sections;

        if (source) {
            sections = withTail(sections, "source", source);
        }

        if (target) {
            sections = withTail(sections, "target", target);
        }

        return { id: edge.id, sections };
    });

    return { nodes: result.nodes, edges, width: result.width, height: result.height };
}
