// Pure assembly of a schema's entity-relationship graph for DiagramView: one
// node per table, one edge per foreign key whose referenced table is also in
// the schema. No DOM, no ELK — layout runs lazily inside DiagramView itself.

import type { DiagramData, DiagramEdgeData, DiagramNodeData, DiagramPortData } from "@jimka/typescript-ui/component/diagram";
import type { ColumnMeta, TableStructure } from "../contract";
import { CARD_WIDTH, cardHeight, columnPortY, deriveColumnRows, portId } from "./schemaCardModel";
import { uniformNodeWidth } from "./uniformNodeWidth";
import type { MeasureWidths } from "./uniformNodeWidth";

// Left-to-right layered layout: a schema's FK graph reads naturally as a
// dependency flow (referencing table -> referenced table), matching the
// left-to-right reading order most ER diagrams use.
//
// The spacings are widened past ELK's ~20px defaults: the card nodes are large
// and each FK edge carries crow's-foot cardinality markers at both ends plus an
// optional referential-action label, all of which crowd together on a short
// edge. `spacing.nodeNode` keeps stacked cards in a layer from touching.
//
// `nodeNodeBetweenLayers` and `spacing.edgeNode` both push layers apart, and
// below about 90 the edge clearance is the one that binds — an edge crossing a
// gap needs `edgeNode` on each side, so the gap cannot close further however
// low this value goes. It is therefore set below that floor rather than at it:
// the effective gap comes from edge routing, and this only decides gaps that
// carry no edge at all. Measured on the 154-table `hub` schema, dropping it
// from 120 to 60 took the width from 42,625 to 39,145 (-8%), leaving 99 gaps at
// 100 and 50 at 90 — none at 60.
const LAYOUT_OPTIONS: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.layered.spacing.nodeNodeBetweenLayers": "60",
    "elk.spacing.nodeNode": "40",
    // Room for a junction stub to clear the crow's-foot glyph. At ELK's default
    // 10 the first bend lands ~13 units off the border — closer than the longest
    // marker is long — so no junction could sit past the glyph and short of the
    // bend at once, and every fan-out branched underneath its own glyph (see
    // edgeRouteStubs' stubGeometry). Only this builder needs it: crow's feet
    // reach 18 units and are applied to this graph alone, by
    // annotateFkCardinality in SqlAdminController; the other portless diagrams
    // draw the 8-unit default arrow, which the default spacing already clears.
    // This is what sets the inter-layer floor described above, so raising it
    // widens the whole diagram and lowering it puts junctions back under their
    // glyphs; the two are one trade, not two independent knobs.
    "elk.spacing.edgeNode": "40",
    "elk.layered.spacing.edgeNodeBetweenLayers": "40",
};

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
 * One foreign key's own metadata, as carried in {@link FkEdgeData.fks}. Inert
 * for the current table-to-table rendering, it feeds later cardinality work
 * and column-to-column (port) anchoring: `columns` / `refColumns` name the
 * local and referenced columns, positionally paired.
 */
export interface FkDetail {
    columns: string[]; // local FK columns, in key order
    refColumns: string[]; // referenced columns, positionally paired with `columns`
    refSchema: string;
    onUpdate: string;
    onDelete: string;
    /** Set by annotateFkCardinality: this key's local columns lack a covering index. */
    uncovered?: boolean;
}

/**
 * The payload carried on every FK edge's `data`: every foreign key the edge
 * draws. Always a list — length 1 outside a fold, more when
 * {@link collapseParallelFkEdges} has folded several keys between the same
 * table pair into one edge.
 */
export interface FkEdgeData {
    fks: FkDetail[];
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
 * @param measureWidths - Optional real text measurer passed through to
 *   `uniformNodeWidth`. Omitting it keeps the estimated node width, which is
 *   what this builder's own tests do; the app supplies `Util.measureTextWidths`.
 * @returns The nodes + edges + layered/RIGHT layout options for DiagramView.
 *   Flat mode also folds parallel foreign keys — two FKs sharing both
 *   endpoints — into one edge via {@link collapseParallelFkEdges}; card mode
 *   does not, since its edges anchor to distinct per-column ports and so are
 *   never parallel.
 */
export function buildSchemaDiagram(
    tables: string[],
    structures: TableStructure[],
    columnsByTable?: Map<string, ColumnMeta[]>,
    measureWidths?: MeasureWidths,
): DiagramData {
    const tableSet = new Set(tables);

    // One width for every node, via the library's own `width` field. Left unset
    // each node is sized to its own label, so a layer's nodes are staggered by
    // up to 85px and stop reading as a column — card mode avoids this for free
    // by giving every card the same CARD_WIDTH, and applyCardMode overwrites
    // this value with it. `measureWidths`, when given, replaces the
    // character-count estimate with a real batched measurement.
    const nodeWidth = uniformNodeWidth(tables, measureWidths);

    const nodes: DiagramNodeData[] = tables.map(name => ({
        id   : name,
        label: name,
        glyph: TABLE_GLYPH,
        width: nodeWidth,
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
                data  : { fks: [{
                    columns   : fk.columns,
                    refColumns: fk.refColumns,
                    refSchema : fk.refSchema,
                    onUpdate  : fk.onUpdate,
                    onDelete  : fk.onDelete,
                }] } satisfies FkEdgeData,
            });
        }
    });

    if (columnsByTable) {
        applyCardMode(nodes, edges, columnsByTable, structures, tables);
    }

    return {
        nodes,
        // Card mode keeps one edge per FK: its endpoints are per-column ports,
        // so two FKs between the same table pair are not parallel there.
        edges: columnsByTable ? edges : collapseParallelFkEdges(edges),
        layoutOptions: LAYOUT_OPTIONS,
    };
}

// Pair key separator, NUL. A Postgres identifier cannot contain NUL, so no
// schema/table name can make two different endpoint pairs produce the same key
// — unlike a printable separator such as `.` or `->`, which a quoted identifier
// is allowed to contain.
const PAIR_KEY_SEPARATOR = "\u0000";

/**
 * Folds edges sharing BOTH endpoints into one edge per (source, target) pair,
 * concatenating their `fks` in first-seen order. The survivor keeps the first
 * folded edge's id, so ids stay unique and stable. Pure — neither the input
 * array nor its edges are mutated.
 *
 * Only for portless (flat-mode) FK edges: an edge anchored to per-column ports
 * has columns, not nodes, as endpoints, so two such edges between the same node
 * pair are not parallel.
 *
 * @param edges - The FK edges to fold, in build order.
 * @returns One edge per (source, target) pair, in first-seen order.
 */
export function collapseParallelFkEdges(edges: DiagramEdgeData[]): DiagramEdgeData[] {
    const byPair = new Map<string, DiagramEdgeData>();

    for (const edge of edges) {
        const key  = `${edge.source}${PAIR_KEY_SEPARATOR}${edge.target}`;
        const kept = byPair.get(key);

        if (!kept) {
            byPair.set(key, edge);
            continue;
        }

        byPair.set(key, {
            ...kept,
            data: {
                fks: [...(kept.data as FkEdgeData).fks, ...(edge.data as FkEdgeData).fks],
            } satisfies FkEdgeData,
        });
    }

    return [...byPair.values()];
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
        const fk = (edge.data as FkEdgeData).fks[0];
        const sourceCols = columnsByTable.get(edge.source) ?? [];
        const targetCols = columnsByTable.get(edge.target) ?? [];
        const localCol = fk.columns[0];
        const refCol = fk.refColumns[0];

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
