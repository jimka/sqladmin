// Pure assembly of a dependency- or inheritance-graph's DiagramData from a
// directed relation edge list. Shared by both graphs (they differ only in
// which endpoint supplied the edges and the ELK layout direction). No DOM, no
// ELK — layout runs lazily inside DiagramView itself.

import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { DbObjectKind, RelationEdge, RelationNodeRef } from "../contract";

// keep in sync with KIND_GLYPH (navigator/objectGlyphs.ts); NOT imported — that
// module runs DOM side effects on import and would crash the node vitest env.
// Same discipline as buildSchemaDiagram.ts's TABLE_GLYPH.
const KIND_GLYPH: Record<DbObjectKind, string> = {
    database: "database", schema: "folder", table: "table",
    view: "eye", materializedView: "layer-group",
};

/** Metadata stashed on each node's `data` so the panel can open the relation. */
export interface RelationNodeData {
    schema: string;
    name: string;
    kind: DbObjectKind;
}

/**
 * The schema-qualified node id (`schema.name`). Exported so the controller can
 * build a root id that matches a graph node.
 *
 * @param ref - The relation to id.
 * @returns `${ref.schema}.${ref.name}`.
 */
export function relationNodeId(ref: RelationNodeRef): string {
    return `${ref.schema}.${ref.name}`;
}

/** Add `ref`'s node to `nodes` if not already present (first wins). */
function addNode(nodes: Map<string, DiagramNodeData>, ref: RelationNodeRef, homeSchema: string): void {
    const id = relationNodeId(ref);

    if (nodes.has(id)) {
        return;
    }

    nodes.set(id, {
        id,
        label: ref.schema === homeSchema ? ref.name : id,
        glyph: KIND_GLYPH[ref.kind],
        data : { schema: ref.schema, name: ref.name, kind: ref.kind } satisfies RelationNodeData,
    });
}

/**
 * Assemble DiagramData from a directed relation edge list. Nodes are the union
 * of edge endpoints (deduped by id); each carries its kind glyph and a
 * RelationNodeData on `data`. A node in `homeSchema` is labelled by its bare
 * name; a foreign-schema node by `schema.name`. Edges keep the input
 * orientation; duplicate (source,target) pairs are deduped by edge id.
 * Pure — type-only diagram imports, no UI-bundle runtime import.
 *
 * @param edges - The directed relation edges (dependency or inheritance).
 * @param homeSchema - The schema being viewed; gates the bare-name label.
 * @param layoutOptions - ELK layout options, passed through verbatim.
 * @param dashed - When true, every edge renders dashed (distinguishes a
 *   dependency graph's edges from a plain FK diagram's). Omitted/false leaves
 *   edges with no `style` (plain).
 * @returns The assembled DiagramData.
 */
export function buildRelationGraph(
    edges: RelationEdge[],
    homeSchema: string,
    layoutOptions: Record<string, string>,
    dashed?: boolean,
): DiagramData {
    const nodes = new Map<string, DiagramNodeData>();
    const edgeMap = new Map<string, DiagramEdgeData>();

    for (const e of edges) {
        addNode(nodes, e.source, homeSchema);
        addNode(nodes, e.target, homeSchema);

        const sourceId = relationNodeId(e.source);
        const targetId = relationNodeId(e.target);
        const id = `${sourceId}->${targetId}`;

        edgeMap.set(id, {
            id,
            source: sourceId,
            target: targetId,
            ...(dashed ? { style: { dashed: true } } : {}),
        });
    }

    return { nodes: [...nodes.values()], edges: [...edgeMap.values()], layoutOptions };
}
