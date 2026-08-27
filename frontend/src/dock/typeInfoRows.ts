// The Type Info tab's pure, DOM-free row mapping (see the "tsui DOM module
// side effects" convention — kept out of TypeInfoPanel.ts, which runs
// Glyph.register at import scope and so is unreachable from the node vitest
// harness, so it can be unit-tested without touching the DOM). Mirrors
// structureRows.ts's shape: one small pure function per grid/row the panel
// needs to (re)build.

import type { TypeDefinition } from "../contract";

/** One row of the enum body grid: a label's 1-based catalog order and its text. */
export interface EnumLabelRow {
    position: number;
    label: string;
}

/**
 * Number an enum's ordered labels 1..n for the info tab's grid.
 *
 * @param labels - the enum's labels, already in catalog (enumsortorder) order.
 * @returns One row per label, 1-based, in the given order.
 */
export function enumLabelRows(labels: string[]): EnumLabelRow[] {
    return labels.map((label, index) => ({ position: index + 1, label }));
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
