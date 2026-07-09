// Pure graph operations over a schema's DiagramData: root-anchored traversal,
// subgraph extraction, and show/hide-with-prune. No DOM, no ELK — type-only
// imports from the diagram barrel keep this node-vitest-testable (the same
// purity discipline as buildSchemaDiagram.ts; never import UI-bundle runtime
// code, which runs DOM-touching module-level side effects).

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
