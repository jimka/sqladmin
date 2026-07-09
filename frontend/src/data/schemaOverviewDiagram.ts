// Pure aggregation of a database's schemas into a legible zoom-out overview
// graph for DiagramView: one node per schema, one edge per ordered schema
// pair carrying the count of cross-schema foreign keys between them. No DOM,
// no ELK, no compound nodes needed — flat, like buildSchemaDiagram.ts.
// Edge-styling by weight (stroke width) is out of scope here — see the
// sibling fk-diagram-cardinality-and-index-coverage plan.

import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { SchemaTables } from "./buildDatabaseDiagram";

/** The aggregated cross-schema FK count carried on an overview edge's `data`. */
export interface SchemaOverviewEdgeData {
    count: number;
}

/**
 * Build the schema-overview graph: one node per schema, and one edge per
 * ordered schema pair `(S -> T)` for which at least one FK in `S` references a
 * table in a different schema `T`, labelled with (and carrying on `data`) the
 * number of such FKs. Intra-schema FKs contribute no overview edge — they
 * don't cross a schema boundary.
 *
 * @param schemas - Every schema's table names + structures, positionally paired.
 * @returns The schema nodes + aggregated cross-schema edges for DiagramView.
 */
export function buildSchemaOverviewDiagram(schemas: SchemaTables[]): DiagramData {
    const nodes: DiagramNodeData[] = schemas.map(({ schema }) => ({ id: schema, label: schema }));

    // Aggregate by ordered (source schema, target schema) pair before emitting
    // edges, so multiple FKs between the same two schemas collapse into one
    // edge carrying the summed count.
    const counts = new Map<string, { source: string; target: string; count: number }>();

    for (const { schema: sourceSchema, structures } of schemas) {
        for (const structure of structures) {
            for (const fk of structure.foreignKeys) {
                if (fk.refSchema === sourceSchema) {
                    continue; // intra-schema: does not cross a schema boundary
                }

                const key = `${sourceSchema}->${fk.refSchema}`;
                const existing = counts.get(key);

                if (existing) {
                    existing.count += 1;
                } else {
                    counts.set(key, { source: sourceSchema, target: fk.refSchema, count: 1 });
                }
            }
        }
    }

    const edges: DiagramEdgeData[] = [...counts.entries()].map(([id, { source, target, count }]) => ({
        id,
        source,
        target,
        label: String(count),
        data : { count } satisfies SchemaOverviewEdgeData,
    }));

    return { nodes, edges };
}
