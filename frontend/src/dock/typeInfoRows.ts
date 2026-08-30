// The Type Info tab's pure, DOM-free row mapping (see the "tsui DOM module
// side effects" convention — kept out of TypeInfoPanel.ts, which runs
// Glyph.register at import scope and so is unreachable from the node vitest
// harness, so it can be unit-tested without touching the DOM). Mirrors
// structureRows.ts's shape: one small pure function per grid/row the panel
// needs to (re)build.

import type { TypeDefinition } from "../contract";

/** One row of the enum body grid: catalog order, the (editable) label, and the diff's identity anchor. */
export interface EnumLabelRow {
    position: number;
    label: string;
    /** The row's label when the grid was seeded — the Save diff's baseline anchor (see `diffEnumLabels`). */
    originalLabel: string;
}

/** One row of the composite body grid: the (editable) name/type pair plus the diff's identity anchor. */
export interface AttributeRow {
    name: string;
    type: string;
    /** The row's attribute name when the grid was seeded — the Save diff's baseline anchor (see `diffCompositeAttributeSpecs`). */
    originalName: string;
}

/**
 * Number an enum's ordered labels 1..n for the info tab's grid, seeding each
 * row's `originalLabel` from its current label — the Save diff's baseline
 * anchor, unrendered (see `columnsGrid.ts`'s `originalName` for the same
 * trick on the Columns grid).
 *
 * @param labels - the enum's labels, already in catalog (enumsortorder) order.
 * @returns One row per label, 1-based, in the given order.
 */
export function enumLabelRows(labels: string[]): EnumLabelRow[] {
    return labels.map((label, index) => ({ position: index + 1, label, originalLabel: label }));
}

/**
 * Map a composite type's attributes into the info tab's grid rows, seeding
 * each row's `originalName` from its current name — the Save diff's baseline
 * anchor, unrendered (see `enumLabelRows`'s identical `originalLabel`).
 *
 * @param attributes - the composite's attributes, already in catalog (attnum) order.
 * @returns One row per attribute, in the given order.
 */
export function attributeRows(attributes: { name: string; type: string }[]): AttributeRow[] {
    return attributes.map(({ name, type }) => ({ name, type, originalName: name }));
}

/**
 * The Category fieldset row's display text.
 *
 * @param category - the type's category, as returned by `TypeDefinitionQuery`.
 * @returns `"Enum"` or `"Composite"`.
 */
export function categoryLabel(category: TypeDefinition["category"]): string {
    return category === "enum" ? "Enum" : "Composite";
}
