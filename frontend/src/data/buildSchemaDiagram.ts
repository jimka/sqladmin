// Pure assembly of a schema's entity-relationship graph for DiagramView: one
// node per table, one edge per foreign key whose referenced table is also in
// the schema. No DOM, no ELK — layout runs lazily inside DiagramView itself.

import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { TableStructure } from "../contract";

// Left-to-right layered layout: a schema's FK graph reads naturally as a
// dependency flow (referencing table -> referenced table), matching the
// left-to-right reading order most ER diagrams use.
const LAYOUT_OPTIONS: Record<string, string> = { "elk.algorithm": "layered", "elk.direction": "RIGHT" };

// The registered glyph name for a table node. Deliberately NOT imported from
// `../navigator/objectGlyphs` (its KIND_GLYPH.table has this same value):
// that module pulls in `@jimka/typescript-ui/component/display`, a bundled
// chunk whose unrelated components run DOM-touching module-level side effects
// on import (e.g. ProgressSpinner's StyleRule.ensureKeyframes), which crashes
// under this project's DOM-less vitest "node" environment. This builder stays
// pure and unit-testable by never importing UI-bundle code; keep this literal
// in sync with KIND_GLYPH.table if that mapping ever changes.
const TABLE_GLYPH = "table";

/**
 * Build the DiagramView graph for a schema from its tables and their structures.
 * Nodes are the tables; edges are each table's foreign keys whose referenced
 * table is also in the set (dangling / cross-schema FKs are dropped).
 *
 * @param tables - The schema's table names (kind "table" objects).
 * @param structures - Each table's structure, positionally paired with `tables`.
 * @returns The nodes + edges + layered/RIGHT layout options for DiagramView.
 */
export function buildSchemaDiagram(
    tables: string[],
    structures: TableStructure[],
): DiagramData {
    const tableSet = new Set(tables);

    const nodes: DiagramNodeData[] = tables.map(name => ({
        id   : name,
        label: name,
        glyph: TABLE_GLYPH,
    }));

    const edges: DiagramEdgeData[] = [];

    tables.forEach((sourceTable, i) => {
        for (const fk of structures[i].foreignKeys) {
            if (!tableSet.has(fk.refTable)) {
                continue; // dangling / cross-schema target: no node to link to
            }

            edges.push({
                // FK constraint names are unique per table but can repeat across
                // tables, so prefix with the source table for global uniqueness.
                id    : `${sourceTable}.${fk.name}`,
                source: sourceTable,
                target: fk.refTable,
            });
        }
    });

    return { nodes, edges, layoutOptions: LAYOUT_OPTIONS };
}
