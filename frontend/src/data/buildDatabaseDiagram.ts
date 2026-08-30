// Pure assembly of a whole database's entity-relationship graph for
// DiagramView: one leaf node per table across every schema, one edge per
// foreign key whose referenced table is anywhere in the fetched set — schema
// or cross-schema. No DOM, no ELK — layout runs lazily inside DiagramView
// itself. Generalizes buildSchemaDiagram.ts to database scope: that builder
// stays byte-for-byte as-is (its bare-name ids and intra-schema-only edge
// matching are correct for a single schema); this is a new module because two
// schemas can share a table name, so node identity here must be
// schema-qualified.

import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { TableStructure } from "../contract";
import { collapseParallelFkEdges, fkEdge } from "./buildSchemaDiagram";
import { uniformNodeWidth } from "./uniformNodeWidth";
import type { MeasureWidths } from "./uniformNodeWidth";
import { LAYERED_RIGHT } from "./diagramLayout";

// The registered glyph name for a table node. Deliberately NOT imported from
// `../navigator/objectGlyphs` — see buildSchemaDiagram.ts's TABLE_GLYPH for
// the full rationale (avoids pulling in DOM-touching UI-bundle module-level
// side effects under this project's DOM-less vitest "node" environment); keep
// this literal in sync with KIND_GLYPH.table if that mapping ever changes.
const TABLE_GLYPH = "table";

/** One schema's tables and their structures, positionally paired. */
export interface SchemaTables {
    schema: string;
    tables: string[];
    structures: TableStructure[];
}

/** Typed leaf-node metadata carried on DiagramNodeData.data for grouping + activation. */
export interface TableNodeData {
    schema: string;
    table: string;
}

/**
 * The stable qualified id for a table node: `${schema}.${table}`. Both node
 * ids and edge endpoint ids are built through this one helper, so they always
 * agree — sidestepping any ambiguity from a `.` inside a schema or table name
 * (the same delimiter convention SqlAdminController.panelId already uses).
 *
 * @param schema - The table's schema.
 * @param table - The bare table name.
 * @returns The globally-unique qualified id.
 */
export function qualifiedId(schema: string, table: string): string {
    return `${schema}.${table}`;
}

/**
 * Build the DiagramView graph for a whole database from every schema's tables
 * and their structures. Nodes are every table across every schema, keyed by
 * its schema-qualified id; edges are each table's foreign keys whose
 * referenced table is anywhere in the fetched set (same schema or a different
 * one) — a dangling FK (referencing a table outside the fetched set, e.g. a
 * system catalog or an unfetched schema) is dropped.
 *
 * @param schemas - Every schema's table names + structures, positionally paired.
 * @param measureWidths - Optional real text measurer passed through to
 *   `uniformNodeWidth`. Omitting it keeps the estimated node width, which is
 *   what this builder's own tests do; the app supplies `Util.measureTextWidths`.
 * @returns The nodes + edges + layered/RIGHT layout options for DiagramView.
 *   Every leaf node carries the same `width` (see `uniformNodeWidth`), sized
 *   to the widest bare table name — `groupBySchema`'s later container boxes
 *   get none. Two foreign keys between the same qualified table pair fold
 *   into one edge via {@link collapseParallelFkEdges} — this builder has no
 *   card mode, so folding always applies.
 */
export function buildDatabaseDiagram(schemas: SchemaTables[], measureWidths?: MeasureWidths): DiagramData {
    const allTables = schemas.flatMap(s => s.tables);
    const nodeWidth = uniformNodeWidth(allTables, measureWidths);

    const nodes: DiagramNodeData[] = [];
    const nodeIds = new Set<string>();

    for (const { schema, tables } of schemas) {
        for (const table of tables) {
            const id = qualifiedId(schema, table);

            nodes.push({
                id,
                label: table,
                glyph: TABLE_GLYPH,
                width: nodeWidth,
                data : { schema, table } satisfies TableNodeData,
            });
            nodeIds.add(id);
        }
    }

    const edges: DiagramEdgeData[] = [];

    for (const { schema, tables, structures } of schemas) {
        tables.forEach((sourceTable, i) => {
            const sourceId = qualifiedId(schema, sourceTable);

            for (const fk of structures[i].foreignKeys) {
                const targetId = qualifiedId(fk.refSchema, fk.refTable);

                if (!nodeIds.has(targetId)) {
                    continue; // dangling / un-fetched target: no node to link to
                }

                edges.push(fkEdge(sourceId, targetId, fk));
            }
        });
    }

    // Left-to-right layered layout, matching buildSchemaDiagram's choice — a
    // database's FK graph still reads naturally as a dependency flow.
    return { nodes, edges: collapseParallelFkEdges(edges), layoutOptions: LAYERED_RIGHT };
}
