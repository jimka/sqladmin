// The dock's button-triggered dropdown item builders: the CSV/JSON export
// chooser (table export and query-result export) and the Structure panel's
// Add-constraint submenu. Pulled out of their panel modules so the guards and
// branches — the only real logic in this change — can be pinned by node
// vitest.
//
// Kept DOM-free (see memory "tsui DOM module side effects") so the node-only
// vitest can import it: the library import below is `import type`, which
// erases at compile time, and glyphs are referenced by their registered string
// name rather than imported — the `Glyph.register` calls stay in the panel
// modules that render these buttons. Mirrors the ddlSpecs.ts idiom.

import type { MenuItemConfig }   from "@jimka/typescript-ui/component/container";
import type { ActiveExport }     from "../data/explain";
import type { Notify }           from "./QueryPanel";
import type { StructureActions } from "./StructurePanel";
import type { ConstraintKind } from "../contract";
import { exportQueryResult } from "./exportQueryResult";
import { exportExplainPlan } from "./exportExplainResult";

// The "Add constraint" submenu's kinds, in menu order. Moved verbatim from
// StructurePanel.ts. Foreign key lives here (not as its own Foreign Keys
// toolbar button) so every constraint kind — including FK — has exactly one
// add affordance.
const ADD_CONSTRAINT_KINDS: ReadonlyArray<{ label: string; kind: ConstraintKind }> = [
    { label: "Primary key…", kind: "primaryKey" },
    { label: "Unique…", kind: "unique" },
    { label: "Check…", kind: "check" },
    { label: "Foreign key…", kind: "foreignKey" },
];

/**
 * Build the table/role-grants Export button's CSV/JSON chooser.
 *
 * @param onExport - Runs the export in the chosen format.
 *
 * @returns The two format items.
 */
export function buildTableExportItems(onExport: (format: "csv" | "json") => void): MenuItemConfig[] {
    return [
        { text: "Export CSV (.csv)",   glyph: "file-csv",  action: () => onExport("csv") },
        { text: "Export JSON (.json)", glyph: "file-code", action: () => onExport("json") },
    ];
}

/**
 * Build the query-result Export button's chooser, branching on whether the
 * panel currently holds a rows result or an EXPLAIN plan.
 *
 * @param active - The panel's current exportable result, or `null` when there
 *   is nothing to export.
 * @param notify - Reports each export's outcome to the status line.
 *
 * @returns The format items for the current result, or an empty list when
 *   nothing is active — an empty list means "don't open" (`Menu.toggleFor`
 *   suppresses it), reproducing the early-return this replaced. Defensive: the
 *   Export button is disabled whenever `active` is null (`setActiveExport`).
 */
export function buildQueryExportItems(active: ActiveExport | null, notify: Notify): MenuItemConfig[] {
    if (!active) {
        return [];
    }

    if (active.kind === "rows") {
        return [
            { text: "Export CSV (.csv)",   glyph: "file-csv",  action: () => exportQueryResult(active.result, "csv", notify) },
            { text: "Export JSON (.json)", glyph: "file-code", action: () => exportQueryResult(active.result, "json", notify) },
        ];
    }

    return [
        { text: "Export text (.txt)",  glyph: "file-lines", action: () => void exportExplainPlan(active.plan, "txt", notify) },
        { text: "Export JSON (.json)", glyph: "file-code",  action: () => void exportExplainPlan(active.plan, "json", notify) },
    ];
}

/**
 * Build the Constraints section's "Add constraint" submenu.
 *
 * @param actions - The launcher callbacks to invoke.
 *
 * @returns The four constraint-kind items — never empty, so its button always
 *   opens.
 */
export function buildAddConstraintItems(actions: StructureActions): MenuItemConfig[] {
    return ADD_CONSTRAINT_KINDS.map(k => ({ text: k.label, action: () => actions.onAddConstraint(k.kind) }));
}
