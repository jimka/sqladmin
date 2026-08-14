// The Structure tab's pure, DOM-free row mapping for the Constraints and
// Foreign Keys grids (see the "tsui DOM module side effects" convention —
// kept out of StructurePanel.ts, which runs Glyph.register at import scope
// and so is unreachable from the node vitest harness, so it can be
// unit-tested without touching the DOM). Both grids' `reload` need to
// re-derive these display rows from fresh metadata, so the mapping is
// callable from the initial build and from reload alike.

import type { ConstraintMeta, ForeignKeyMeta } from "../contract";

/** One Constraints-grid row: the constrained columns joined into one string. */
export interface ConstraintRow {
    name: string;
    type: string;
    columns: string;
    definition: string;
}

/** One Foreign-Keys-grid row: both column lists joined into one string each. */
export interface ForeignKeyRow {
    name: string;
    columns: string;
    refSchema: string;
    refTable: string;
    refColumns: string;
    onUpdate: string;
    onDelete: string;
}

/**
 * Flatten constraint metadata into the Constraints grid's row shape.
 *
 * @param constraints - the table's non-FK constraints (primary key / unique / check).
 * @returns One row per constraint, in the given order.
 */
export function constraintRows(constraints: ConstraintMeta[]): ConstraintRow[] {
    return constraints.map(c => ({
        name: c.name,
        type: c.type,
        columns: c.columns.join(", "),
        definition: c.definition,
    }));
}

/**
 * Flatten foreign key metadata into the Foreign Keys grid's row shape.
 *
 * @param foreignKeys - the table's foreign keys.
 * @returns One row per foreign key, in the given order.
 */
export function foreignKeyRows(foreignKeys: ForeignKeyMeta[]): ForeignKeyRow[] {
    return foreignKeys.map(fk => ({
        name: fk.name,
        columns: fk.columns.join(", "),
        refSchema: fk.refSchema,
        refTable: fk.refTable,
        refColumns: fk.refColumns.join(", "),
        onUpdate: fk.onUpdate,
        onDelete: fk.onDelete,
    }));
}
