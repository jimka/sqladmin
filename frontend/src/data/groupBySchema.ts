// Pure wrap of a flat, already-filtered table graph into one compound
// container node per schema, for the final DiagramView.setData call. Runs
// strictly after the flat rooted/prune filter layer (relationDiagram.ts),
// which must never learn about compound nodes — see buildDatabaseDiagram.ts's
// header comment for the purity discipline this module shares.

import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { TableNodeData } from "./buildDatabaseDiagram";

/**
 * Wrap a flat table graph's leaves into one compound container node per
 * schema, read from each leaf's `node.data.schema`. Edges and `layoutOptions`
 * pass through verbatim (edges still reference leaf ids — grouping never
 * changes edge endpoints). A schema with zero surviving leaves (already
 * filtered out upstream) produces no container. Containers are emitted in
 * first-seen schema order.
 *
 * @param flat - The (already-filtered) flat leaf graph, e.g. from
 *   `buildDatabaseDiagram` optionally passed through `rootedDiagram`/`applyHide`.
 * @returns A new graph whose `nodes` are one `schema:${schema}` container per
 *   schema, each carrying that schema's leaves as `children`.
 */
export function groupBySchema(flat: DiagramData): DiagramData {
    const order: string[] = [];
    const bySchema = new Map<string, DiagramNodeData[]>();

    for (const node of flat.nodes) {
        const schema = (node.data as TableNodeData | undefined)?.schema;

        if (schema === undefined) {
            continue; // not a schema-tagged leaf — nothing to group it under
        }

        if (!bySchema.has(schema)) {
            bySchema.set(schema, []);
            order.push(schema);
        }

        bySchema.get(schema)!.push(node);
    }

    const nodes: DiagramNodeData[] = order.map(schema => ({
        id      : `schema:${schema}`,
        label   : schema,
        children: bySchema.get(schema)!,
    }));

    return { nodes, edges: flat.edges, layoutOptions: flat.layoutOptions };
}
