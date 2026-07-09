// Pure assembly of a schema's entity-relationship graph for DiagramView: one
// node per table, one edge per foreign key whose referenced table is also in
// the schema. No DOM, no ELK — layout runs lazily inside DiagramView itself.

import type { DiagramData, DiagramEdgeData, DiagramNodeData, DiagramPortData } from "@jimka/typescript-ui/component/diagram";
import type { ColumnMeta, TableStructure } from "../contract";
import { CARD_WIDTH, cardHeight, columnPortY, deriveColumnRows, portId } from "./schemaCardModel";

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
 * The foreign-key metadata carried on each edge's `data`. Inert for the current
 * table-to-table rendering, it feeds later cardinality work and column-to-column
 * (port) anchoring: `columns` / `refColumns` name the local and referenced
 * columns, positionally paired.
 */
export interface FkEdgeData {
    columns: string[]; // local FK columns, in key order
    refColumns: string[]; // referenced columns, positionally paired with `columns`
    refSchema: string;
    onUpdate: string;
    onDelete: string;
    /** Set by annotateFkCardinality: FK local columns lack a covering index. */
    uncovered?: boolean;
}

/**
 * Build the DiagramView graph for a schema from its tables and their structures.
 * Nodes are the tables; edges are each table's foreign keys whose referenced
 * table is also in the set (dangling / cross-schema FKs are dropped).
 *
 * Passing `columnsByTable` switches on **card mode**: each node gains its
 * column rows (`data`), an explicit card size (`width`/`height`), and
 * `elk.portConstraints=FIXED_POS`; each surviving FK edge anchors
 * column-to-column via `sourcePort`/`targetPort` when its first column pair
 * is present in the fetched columns (falling back to a node-level anchor
 * otherwise). Omitting it keeps today's flat table-to-table output unchanged.
 *
 * @param tables - The schema's table names (kind "table" objects).
 * @param structures - Each table's structure, positionally paired with `tables`.
 * @param columnsByTable - Optional per-table fetched columns; presence switches
 *   on card mode (see above).
 * @returns The nodes + edges + layered/RIGHT layout options for DiagramView.
 */
export function buildSchemaDiagram(
    tables: string[],
    structures: TableStructure[],
    columnsByTable?: Map<string, ColumnMeta[]>,
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
                // Carried for later cardinality / column-to-column work; ignored
                // by the current table-to-table rendering.
                data  : {
                    columns   : fk.columns,
                    refColumns: fk.refColumns,
                    refSchema : fk.refSchema,
                    onUpdate  : fk.onUpdate,
                    onDelete  : fk.onDelete,
                } satisfies FkEdgeData,
            });
        }
    });

    if (columnsByTable) {
        applyCardMode(nodes, edges, columnsByTable, structures, tables);
    }

    return { nodes, edges, layoutOptions: LAYOUT_OPTIONS };
}

/**
 * Mutates `nodes`/`edges` in place to switch on card mode: sizes + column data
 * for every node, and column-to-column ports for every surviving FK edge whose
 * first column pair is present in the endpoints' fetched columns. See
 * {@link buildSchemaDiagram}'s card-mode paragraph for the contract.
 *
 * @param nodes - The flat nodes already built (mutated: `data`/`width`/`height`/`layoutOptions`/`ports`).
 * @param edges - The flat edges already built (mutated: `sourcePort`/`targetPort`).
 * @param columnsByTable - Per-table fetched columns.
 * @param structures - Each table's structure, positionally paired with `tables` (for FK lookup by node id).
 * @param tables - The schema's table names, positionally paired with `structures`.
 */
function applyCardMode(
    nodes: DiagramNodeData[],
    edges: DiagramEdgeData[],
    columnsByTable: Map<string, ColumnMeta[]>,
    structures: TableStructure[],
    tables: string[],
): void {
    const foreignKeysByTable = new Map(tables.map((name, i) => [name, structures[i].foreignKeys]));

    // Node data + size (step 1).
    for (const node of nodes) {
        const cols = columnsByTable.get(node.id) ?? [];

        node.data          = { columns: deriveColumnRows(cols, foreignKeysByTable.get(node.id) ?? []) };
        node.width         = CARD_WIDTH;
        node.height        = cardHeight(cols.length);
        node.layoutOptions = { "elk.portConstraints": "FIXED_POS" };
    }

    // Port collection (step 2), de-duplicated per (node, column, dir).
    const neededPorts = new Map<string, Set<string>>(); // nodeId -> Set<"column::dir">
    const recordPort = (nodeId: string, column: string, dir: "in" | "out"): void => {
        if (!neededPorts.has(nodeId)) {
            neededPorts.set(nodeId, new Set());
        }

        neededPorts.get(nodeId)!.add(`${column}::${dir}`);
    };

    for (const edge of edges) {
        const fkData = edge.data as FkEdgeData;
        const sourceCols = columnsByTable.get(edge.source) ?? [];
        const targetCols = columnsByTable.get(edge.target) ?? [];
        const localCol = fkData.columns[0];
        const refCol = fkData.refColumns[0];

        if (sourceCols.some(c => c.name === localCol)) {
            recordPort(edge.source, localCol, "out");
            edge.sourcePort = portId(edge.source, localCol, "out");
        }

        if (targetCols.some(c => c.name === refCol)) {
            recordPort(edge.target, refCol, "in");
            edge.targetPort = portId(edge.target, refCol, "in");
        }
    }

    // Port emission (step 3).
    for (const node of nodes) {
        const needed = neededPorts.get(node.id);

        if (!needed) {
            continue; // no edge anchors to this node's columns: leave ports unset
        }

        const cols = columnsByTable.get(node.id) ?? [];
        const ports: DiagramPortData[] = [];

        for (const entry of needed) {
            const [column, dir] = entry.split("::") as [string, "in" | "out"];
            const index = cols.findIndex(c => c.name === column);

            ports.push({
                id    : portId(node.id, column, dir),
                x     : dir === "out" ? CARD_WIDTH - 1 : 0,
                y     : columnPortY(index),
                width : 1,
                height: 1,
                side  : dir === "out" ? "EAST" : "WEST",
            });
        }

        node.ports = ports;
    }
}
