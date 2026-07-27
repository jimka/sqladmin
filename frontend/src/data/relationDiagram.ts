// Pure graph operations over a schema's DiagramData: root-anchored traversal,
// subgraph extraction, show/hide-with-prune, the root-selector item list
// (rootChoices), and the two derivation steps a panel with an optional root
// runs (rootedBase, filteredBase). No DOM, no ELK — type-only imports from the
// diagram barrel keep this node-vitest-testable (the same purity discipline as
// buildSchemaDiagram.ts; never import UI-bundle runtime code, which runs
// DOM-touching module-level side effects).

import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";

/** Which foreign-key directions to walk out from the root. */
export type TraversalDirection = "downstream" | "upstream" | "both";

/**
 * BFS the directed FK graph from `rootId`, returning every node id reachable
 * within `maxDepth` hops. `downstream` follows source -> target (the relation's
 * own FKs); `upstream` follows target -> source (tables referencing it); `both`
 * follows either. Nodes in `excluded` are never entered (used by prune to walk
 * around hidden nodes). Pass `Number.POSITIVE_INFINITY` for an unbounded walk.
 *
 * @param edges - The full edge set to traverse.
 * @param rootId - The node to start from (always included unless excluded).
 * @param direction - Which FK directions to follow.
 * @param maxDepth - Hop limit; the root is depth 0.
 * @param excluded - Node ids that must not be entered (optional).
 * @returns The set of reachable node ids (includes `rootId` unless excluded).
 */
export function reachableNodeIds(
    edges: readonly DiagramEdgeData[],
    rootId: string,
    direction: TraversalDirection,
    maxDepth: number,
    excluded?: ReadonlySet<string>,
): Set<string> {
    if (excluded?.has(rootId)) {
        return new Set();
    }

    const visited = new Set<string>([rootId]);
    let frontier: string[] = [rootId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const next: string[] = [];

        for (const u of frontier) {
            for (const e of edges) {
                const down = (direction === "downstream" || direction === "both") && e.source === u;
                const up   = (direction === "upstream"   || direction === "both") && e.target === u;

                for (const v of [down ? e.target : null, up ? e.source : null]) {
                    if (v !== null && !visited.has(v) && !excluded?.has(v)) {
                        visited.add(v);
                        next.push(v);
                    }
                }
            }
        }

        frontier = next;
    }

    return visited;
}

/**
 * Restrict `data` to the nodes in `keep`; an edge survives only when BOTH of its
 * endpoints are kept. Graph-level `layoutOptions` pass through verbatim.
 *
 * @param data - The graph to filter.
 * @param keep - Node ids to retain.
 * @returns A new graph containing only the kept nodes and their internal edges.
 */
export function subgraph(data: DiagramData, keep: ReadonlySet<string>): DiagramData {
    return {
        nodes: data.nodes.filter(n => keep.has(n.id)),
        edges: data.edges.filter(e => keep.has(e.source) && keep.has(e.target)),
        layoutOptions: data.layoutOptions,
    };
}

/**
 * The root-anchored view: the nodes reachable from `root` within `depth` hops in
 * `direction`, plus the root itself. When the root is absent from `full.nodes`
 * (e.g. a view / materialized view root — FKs are table-only, so it has no
 * edges), the root node is injected so the diagram always renders it.
 *
 * @param full - The whole schema's graph.
 * @param root - The root relation's node data (id must match its FK endpoints).
 * @param direction - Which FK directions to follow from the root.
 * @param depth - Hop limit from the root.
 * @returns The rooted subgraph, always containing `root`.
 */
export function rootedDiagram(
    full: DiagramData,
    root: DiagramNodeData,
    direction: TraversalDirection,
    depth: number,
): DiagramData {
    const keep = reachableNodeIds(full.edges, root.id, direction, depth);
    keep.add(root.id);

    const data = subgraph(full, keep);

    if (!data.nodes.some(n => n.id === root.id)) {
        data.nodes.unshift(root); // view/matview root absent from a table-only full graph
    }

    return data;
}

/**
 * The filtered view over a rooted base. Plain hide (`prune` false) drops the
 * `hidden` nodes and their incident edges, leaving any node they orphaned in
 * place. Prune (`prune` true) additionally drops every node made unreachable
 * from `rootId` once the hidden nodes are removed.
 *
 * @param base - The rooted base graph.
 * @param rootId - The root node id (never hidden; anchors the prune walk).
 * @param hidden - Node ids the user has hidden.
 * @param prune - Whether to also drop nodes orphaned from the root.
 * @param direction - The base's traversal direction (drives the prune walk).
 * @returns The filtered subgraph.
 */
export function applyHide(
    base: DiagramData,
    rootId: string,
    hidden: ReadonlySet<string>,
    prune: boolean,
    direction: TraversalDirection,
): DiagramData {
    let keep: Set<string>;

    if (prune) {
        keep = reachableNodeIds(base.edges, rootId, direction, Number.POSITIVE_INFINITY, hidden);
        keep.add(rootId);
    } else {
        keep = new Set(base.nodes.map(n => n.id).filter(id => !hidden.has(id)));
    }

    return subgraph(base, keep);
}

/** Neighbours of one drawn node that the depth limit left out. */
export interface HiddenNeighbourCounts {
    /** Distinct neighbours reached by following source -> target (downstream). */
    outgoing: number;
    /** Distinct neighbours reached by following target -> source (upstream). */
    incoming: number;
}

/**
 * Per drawn node, how many distinct neighbours the depth limit cut. Only edges
 * the given direction follows are counted — a neighbour no depth setting would
 * ever reveal is not "deeper". Pure.
 *
 * @param edges - The WHOLE graph's edges (the base's own edges are not enough:
 *   a cut edge has exactly one endpoint in `shown`).
 * @param shown - Node ids the depth-limited walk kept.
 * @param direction - The traversal direction the walk used.
 * @returns One entry per node with at least one cut neighbour; nodes with none
 *   are absent from the map.
 */
export function hiddenNeighbourCounts(
    edges: readonly DiagramEdgeData[],
    shown: ReadonlySet<string>,
    direction: TraversalDirection,
): Map<string, HiddenNeighbourCounts> {
    // Sets first (dedupes parallel edges to the same neighbour), converted to
    // counts once every edge has been walked.
    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();

    for (const e of edges) {
        if (e.source === e.target) {
            continue; // can never straddle `shown`
        }

        const followsDown = direction === "downstream" || direction === "both";
        const followsUp   = direction === "upstream"   || direction === "both";

        if (followsDown && shown.has(e.source) && !shown.has(e.target)) {
            addToSetMap(outgoing, e.source, e.target);
        }

        if (followsUp && shown.has(e.target) && !shown.has(e.source)) {
            addToSetMap(incoming, e.target, e.source);
        }
    }

    const counts = new Map<string, HiddenNeighbourCounts>();

    for (const id of new Set([...outgoing.keys(), ...incoming.keys()])) {
        counts.set(id, {
            outgoing: outgoing.get(id)?.size ?? 0,
            incoming: incoming.get(id)?.size ?? 0,
        });
    }

    return counts;
}

/** Adds `value` to the `Set` keyed by `key` in `map`, creating the set if absent. */
function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
    let set = map.get(key);

    if (!set) {
        set = new Set();
        map.set(key, set);
    }

    set.add(value);
}

/**
 * The badge text for one node's cut-neighbour counts, or null when nothing was
 * cut. The arrow points the way the traversal was walking, not a screen
 * direction.
 *
 * @param counts - That node's cut-neighbour counts.
 * @returns The badge text, or null.
 */
export function depthBadgeLabel(counts: HiddenNeighbourCounts): string | null {
    const parts: string[] = [];

    if (counts.incoming > 0) {
        parts.push(`←+${counts.incoming}`);
    }

    if (counts.outgoing > 0) {
        parts.push(`+${counts.outgoing}→`);
    }

    return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * A copy of `base` whose nodes carry a `badge` wherever the depth limit cut a
 * neighbour. Node objects are copied, never mutated, so the graph `base` was
 * derived from is untouched. Edges and `layoutOptions` pass through verbatim.
 *
 * @param base - The direction+depth-rooted graph about to be filtered/drawn.
 * @param fullEdges - The whole graph's edges, including the cut ones.
 * @param direction - The traversal direction `base` was rooted with.
 * @returns A new graph whose nodes carry depth badges.
 */
export function withDepthBadges(
    base: DiagramData,
    fullEdges: readonly DiagramEdgeData[],
    direction: TraversalDirection,
): DiagramData {
    const counts = hiddenNeighbourCounts(fullEdges, new Set(base.nodes.map(n => n.id)), direction);

    return {
        nodes: base.nodes.map((n) => {
            const label = counts.has(n.id) ? depthBadgeLabel(counts.get(n.id)!) : null;

            return label === null ? { ...n } : { ...n, badge: label };
        }),
        edges: base.edges,
        layoutOptions: base.layoutOptions,
    };
}

/** One entry of a root selector: the node id as `key`, its display name as `label`. */
export interface RootChoice {
    key: string;
    label: string;
}

/**
 * The root-selector items for a graph: one per node, keyed by node id. A node is
 * labelled by its own label, or by its id when it has none or when another node
 * carries the same label. Sorted by the shown label, ties broken by key. Pure.
 *
 * @param data - The graph whose nodes are selectable.
 * @returns The items in display order; empty for a graph with no nodes.
 */
export function rootChoices(data: DiagramData): RootChoice[] {
    const labelCounts = new Map<string, number>();

    for (const n of data.nodes) {
        const label = n.label ?? n.id;

        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }

    const choices = data.nodes.map((n) => {
        const label = n.label ?? n.id;

        // A label two nodes share names neither of them: fall back to the id,
        // which is unique across a graph by construction.
        return { key: n.id, label: labelCounts.get(label) === 1 ? label : n.id };
    });

    return choices.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

/**
 * The base graph for a panel whose root may be absent: the badged
 * direction+depth neighbourhood of `rootId`, or `full` itself when `rootId` is
 * null or names no node in `full`. Pure.
 *
 * @param full - The whole graph.
 * @param rootId - The chosen root's node id, or null for the whole graph.
 * @param direction - The traversal direction to walk.
 * @param depth - The hop limit from the root.
 * @returns The base graph to filter and draw.
 */
export function rootedBase(
    full: DiagramData,
    rootId: string | null,
    direction: TraversalDirection,
    depth: number,
): DiagramData {
    const root = rootId === null ? undefined : full.nodes.find(n => n.id === rootId);

    if (!root) {
        return full;
    }

    return withDepthBadges(rootedDiagram(full, root, direction, depth), full.edges, direction);
}

/**
 * The graph to draw from a base: `base` unchanged when there is no root (nothing
 * to hide against), else `base` with the hidden nodes removed — and, when
 * pruning, what they orphaned from the root. Pure.
 *
 * @param base - The base graph.
 * @param rootId - The chosen root's node id, or null.
 * @param hidden - Node ids the user has hidden.
 * @param prune - Whether to also drop nodes orphaned from the root.
 * @param direction - The base's traversal direction.
 * @returns The subgraph to hand to the view.
 */
export function filteredBase(
    base: DiagramData,
    rootId: string | null,
    hidden: ReadonlySet<string>,
    prune: boolean,
    direction: TraversalDirection,
): DiagramData {
    return rootId === null ? base : applyHide(base, rootId, hidden, prune, direction);
}
