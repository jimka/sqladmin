// Pure, DOM-free row mapping for the Columns grid (see the "tsui DOM module
// side effects" convention — kept out of columnsGrid.ts so it can be
// unit-tested under the node vitest harness without touching the DOM).
//
// A grid row is flat because MemoryStore fields are flat, so ColumnMeta's
// nested `sequence` is spread across three fields: a `sequence` display label
// and the `sequenceSchema`/`sequenceName` pair. The pair is what the grid's
// cellclick handler reads to open the sequence — the label must never be
// re-split on ".", since a schema or sequence name may itself contain one.

import type { ColumnMeta, SequenceRef } from "../contract";

/** One Columns-grid row: the display fields, plus the sequence link's data. */
export interface ColumnRow {
    name: string;
    dataType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    isGenerated: boolean;
    wireType: string;
    /** `"schema.name"`, or `""` when no sequence backs the column. */
    sequence: string;
    /** `""` when no sequence backs the column; unlisted, read by the click handler. */
    sequenceSchema: string;
    /** `""` when no sequence backs the column; unlisted, read by the click handler. */
    sequenceName: string;
}

/**
 * The Sequence cell's label — always schema-qualified, since a column can be
 * backed by a sequence from another schema (a shared sequence reached through
 * the column's default), which is exactly where the link matters most.
 *
 * @param sequence - the column's backing sequence, if any.
 * @returns `"schema.name"`, or `""` when nothing backs the column.
 */
export function sequenceLabel(sequence: SequenceRef | null | undefined): string {
    return sequence ? `${sequence.schema}.${sequence.name}` : "";
}

/**
 * Flatten introspected columns into the grid's row shape.
 *
 * @param columns - the relation's introspected columns.
 * @returns One row per column, in the given order.
 */
export function toColumnRows(columns: ColumnMeta[]): ColumnRow[] {
    return columns.map(column => ({
        name:           column.name,
        dataType:       column.dataType,
        nullable:       column.nullable,
        isPrimaryKey:   column.isPrimaryKey,
        isGenerated:    column.isGenerated,
        wireType:       column.wireType,
        sequence:       sequenceLabel(column.sequence),
        sequenceSchema: column.sequence?.schema ?? "",
        sequenceName:   column.sequence?.name ?? "",
    }));
}
