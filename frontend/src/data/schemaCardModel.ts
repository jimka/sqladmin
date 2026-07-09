// The card-DOM <-> ELK-port geometry seam for the column-level ER diagram.
// Both the pure builder (buildSchemaDiagram, card mode) and the card renderer
// (TableCardNode) read these metrics/derived coordinates so a column row and
// the ELK port an FK edge lands on always agree on the same vertical
// coordinate without either side measuring the other. Pure and DOM-free — no
// `@jimka/typescript-ui` runtime import (only its types are used elsewhere),
// keeping the node-vitest purity discipline buildSchemaDiagram.ts follows.

import type { ColumnMeta, ForeignKeyMeta } from "../contract";

/** Fixed card width in pixels; also the ELK node width and the EAST port x anchor. */
export const CARD_WIDTH = 220;

/** Height in pixels of the card's table-name header row. */
export const CARD_HEADER_HEIGHT = 28;

/** Height in pixels of one column row. */
export const CARD_ROW_HEIGHT = 22;

/** One column row rendered on a table card. */
export interface ColumnRowData {
    name: string;
    type: string;
    pk: boolean;
    fk: boolean;
}

/** The shape of {@link DiagramNodeData.data} in card mode: the card's column rows. */
export interface CardNodeData {
    columns: ColumnRowData[];
}

/**
 * A card's total height for `columnCount` rows: the header plus one row height
 * per column.
 *
 * @param columnCount - Number of column rows the card lists.
 * @returns The card's pixel height.
 */
export function cardHeight(columnCount: number): number {
    return CARD_HEADER_HEIGHT + columnCount * CARD_ROW_HEIGHT;
}

/**
 * The vertical centre, in pixels from the card's top-left, of the column row
 * at `index`. Used both to size a rendered row and to pin an ELK port so an FK
 * edge lands exactly on that row.
 *
 * @param index - Zero-based column row index.
 * @returns The row's vertical centre in pixels.
 */
export function columnPortY(index: number): number {
    // The port is 1px tall (see buildSchemaDiagram's port emission), so its
    // centre sits (height-1)/2 below the row's top edge; the <=0.5px offset
    // this introduces is immaterial at diagram scale.
    return CARD_HEADER_HEIGHT + index * CARD_ROW_HEIGHT + (CARD_ROW_HEIGHT - 1) / 2;
}

/**
 * Builds the card's column rows from a table's fetched columns and foreign
 * keys: order preserved, `pk` from `ColumnMeta.isPrimaryKey`, `fk` set when the
 * column is named in any FK's local `columns`, `type` from `ColumnMeta.dataType`.
 *
 * @param columns - The table's columns, in declaration order.
 * @param foreignKeys - The table's foreign keys (local columns checked for `fk`).
 * @returns One row per column, in the same order.
 */
export function deriveColumnRows(columns: ColumnMeta[], foreignKeys: ForeignKeyMeta[]): ColumnRowData[] {
    const fkColumns = new Set(foreignKeys.flatMap(fk => fk.columns));

    return columns.map(c => ({
        name: c.name,
        type: c.dataType,
        pk  : c.isPrimaryKey,
        fk  : fkColumns.has(c.name),
    }));
}

/**
 * A stable, direction-qualified port id for a node's column. Two edges sharing
 * an endpoint column and direction reuse the same id (de-duplicated by the
 * caller); a column referenced both upstream and downstream gets distinct
 * in/out ids at the same node.
 *
 * @param nodeId - The table node's id.
 * @param column - The column name the port anchors to.
 * @param dir - `"out"` for an FK's local (source) column, `"in"` for its
 *   referenced (target) column.
 * @returns The port id.
 */
export function portId(nodeId: string, column: string, dir: "in" | "out"): string {
    return `${nodeId}::${column}::${dir}`;
}
