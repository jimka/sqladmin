// The card-DOM <-> ELK-port geometry seam for the column-level ER diagram.
// Both the pure builder (buildSchemaDiagram, card mode) and the card renderer
// (TableCardNode) read these metrics/derived coordinates so a column row and
// the ELK port an FK edge lands on always agree on the same vertical
// coordinate without either side measuring the other. Pure and DOM-free — no
// `@jimka/typescript-ui` runtime import (only its types are used elsewhere),
// keeping the node-vitest purity discipline buildSchemaDiagram.ts follows.
//
// Renderer contract: `cardHeight` is the card element's OUTER box height —
// the size ELK lays the node out at, which DiagramView commits as the
// component's preferred size under `box-sizing: border-box` — and
// `columnPortY` is measured from that outer box's top edge. The renderer must
// therefore add no vertical decoration to the card (zero top/bottom insets,
// no top/bottom border or padding): any such decoration eats into the inner
// height, shrinks every row below CARD_ROW_HEIGHT, and walks the FK ports off
// the row centres they were pinned to.

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
    /** Whether the column accepts NULL (drives the "NOT NULL" tooltip attribute). */
    nullable: boolean;
    /** Whether the column is generated (a `GENERATED` tooltip attribute). */
    generated: boolean;
    /** Whether the column has a default (a `DEFAULT` tooltip attribute). */
    hasDefault: boolean;
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
        name      : c.name,
        type      : c.dataType,
        pk        : c.isPrimaryKey,
        fk        : fkColumns.has(c.name),
        nullable  : c.nullable,
        generated : c.isGenerated,
        hasDefault: c.hasDefault,
    }));
}

/**
 * A multi-line hover-tooltip description of the table itself: an unlabelled
 * name heading, then a column count, primary-key columns, and foreign-key
 * columns — each detail line omitted when it has nothing to say. A node with
 * no columns at all (e.g. a role in the reused role-membership graph) yields
 * the heading alone.
 *
 * @param label - The table's (or, in the reused role-membership graph, the
 *   role's) display name.
 * @param columns - The card's column rows; a column that is both PK and FK
 *   appears in both lists. Multiple PK/FK columns are joined `", "` in
 *   declaration order.
 * @returns The tooltip text; `\n`-separated, which the Tooltip renders as line breaks.
 */
export function tableTooltip(label: string, columns: readonly ColumnRowData[]): string {
    const lines = [label];

    if (columns.length > 0) {
        lines.push(`Columns: ${columns.length}`);
    }

    const pk = columns.filter(c => c.pk).map(c => c.name);
    const fk = columns.filter(c => c.fk).map(c => c.name);

    if (pk.length > 0) {
        lines.push(`Primary key: ${pk.join(", ")}`);
    }

    if (fk.length > 0) {
        lines.push(`Foreign keys: ${fk.join(", ")}`);
    }

    return lines.join("\n");
}

/**
 * A multi-line hover-tooltip description of a column row: a `Name:`/`Type:`
 * labelled name and full type, then a labelled `Attributes:` line of the ones
 * worth calling out (key role, NOT NULL, DEFAULT, GENERATED). The name and type
 * repeat what the card shows so the tooltip still reveals them in full when the
 * row ellipsised them; the attributes line is omitted when there are none.
 *
 * @param column - The row to describe.
 * @returns The tooltip text; `\n`-separated, which the Tooltip renders as line breaks.
 */
export function columnTooltip(column: ColumnRowData): string {
    const attributes: string[] = [];

    if (column.pk) {
        attributes.push("PRIMARY KEY");
    }

    if (column.fk) {
        attributes.push("FOREIGN KEY");
    }

    if (!column.nullable) {
        attributes.push("NOT NULL");
    }

    if (column.hasDefault) {
        attributes.push("DEFAULT");
    }

    if (column.generated) {
        attributes.push("GENERATED");
    }

    const lines = [`Name: ${column.name}`, `Type: ${column.type}`];

    if (attributes.length > 0) {
        lines.push(`Attributes: ${attributes.join(" · ")}`);
    }

    return lines.join("\n");
}

/**
 * A column row's full hover tooltip: the table block, a blank line, then the
 * column block. `table` is {@link tableTooltip}'s result, computed once per
 * card and shared by every row (rather than recomputed per row); the blank
 * line is what visually separates the two blocks once the Tooltip renders
 * the `\n`-joined text as line breaks.
 *
 * @param table - The card's {@link tableTooltip} result.
 * @param column - The row to describe.
 * @returns The tooltip text; `\n`-separated, which the Tooltip renders as line breaks.
 */
export function cardTooltip(table: string, column: ColumnRowData): string {
    return `${table}\n\n${columnTooltip(column)}`;
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
