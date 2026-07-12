// The dock work panel for one view or materialized view: a read-only, paginated
// data grid with Explain, Export, and Refresh actions. Unlike TableWorkPanel
// there are NO write actions (Add/Delete/Save) — a view is read-only — so the
// store's mutation methods are never invoked and the write toolbar is omitted.
//
// Explain / Explain Analyze do NOT touch this grid: they open a Query tab seeded
// with the view's backing `SELECT * FROM schema.view` and run EXPLAIN there (see
// the controller's openQuery), so the plan and its export live on the query
// surface that already handles them, and the data grid stays put.
//
// The view's SQL definition and its column structure each open in their own tab
// from the navigator's right-click menu (see DefinitionPanel / StructurePanel and
// the controller's openDefinition / openStructure), keeping this panel a plain
// data surface — the same shape a table's data tab has, minus the edit actions.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the panel `extends
// Container`, inlining its own Border frame directly (toolbar NORTH, grid
// CENTER) rather than building it through a shared shell builder.
// The keydown listener stays an inline arrow in the constructor — it closes
// over the `onExplain` constructor parameter, not over `this`, so it needs no
// arrow-function field. `buildViewColumnSpec`/`buildToolBar` stay stateless
// module-level functions.

import { Container, Panel, Event }     from "@jimka/typescript-ui/core";
import { Border as BorderLayout, Fit } from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Spacer }                      from "@jimka/typescript-ui/component/container";
import { glyphButton }                 from "./glyphButton";
import { Table }                       from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }             from "@jimka/typescript-ui/component/table";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import type { AjaxStore }              from "@jimka/typescript-ui/data";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import { diagram_project }             from "@jimka/typescript-ui/glyphs/solid/diagram_project";
import { flask }                       from "@jimka/typescript-ui/glyphs/solid/flask";
import type { ColumnMeta }             from "../contract";
import type { ExportTable }            from "./TableWorkPanel";
import { isExplainChord, isExplainAnalyzeChord } from "../shell/queryShortcuts";
import { buildExportButton }           from "./exportButton";
import { PRIMARY_COLOR, NEUTRAL_COLOR, CAUTION_COLOR } from "../theme";

Glyph.register(refresh, diagram_project, flask);

/** Open a Query tab that EXPLAINs the view (true = EXPLAIN ANALYZE, false = plain). */
export type ExplainView = (analyze: boolean) => void;

/**
 * The read-only work panel for a view/materialized view: a paginated data grid
 * (CENTER) with Explain, Export, and Refresh actions on the toolbar (NORTH).
 */
export class ViewWorkPanel extends Container {
    /**
     * @param store - The paginated AjaxStore over the view's rows (never written to).
     * @param columns - The view's introspected columns (drive the grid's columns).
     * @param onExport - Streams the whole relation server-side in the chosen format.
     * @param onExplain - Opens a Query tab that EXPLAINs the view's backing SELECT.
     */
    constructor(store: AjaxStore, columns: ColumnMeta[], onExport: ExportTable, onExplain: ExplainView) {
        // `this` is unavailable until after `super()`, so the grid and toolbar
        // are built as locals first.
        // Read-only grid: every cell is locked (rowReadOnly), the same lock
        // StructurePanel/RoleGrantsPanel use.
        const dataGrid = Table(store, buildViewColumnSpec(columns));
        const toolbar  = buildToolBar(store, onExport, onExplain);

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this.addComponent(toolbar, { placement: Placement.NORTH });
        this.addComponent(Panel({ layoutManager: new Fit(), components: [dataGrid] }), { placement: Placement.CENTER });

        // Ctrl+E / Ctrl+Shift+E explain the view while this panel has focus,
        // mirroring the toolbar's Explain / Explain Analyze buttons (each opens
        // a query tab). Closes over the `onExplain` param, not over `this`, so
        // stays an inline arrow rather than an arrow-function field.
        Event.addSubtreeListener(this, "keydown", (event: KeyboardEvent) => {
            if (isExplainChord(event)) {
                event.preventDefault();
                event.stopPropagation();
                onExplain(false);
            } else if (isExplainAnalyzeChord(event)) {
                event.preventDefault();
                event.stopPropagation();
                onExplain(true);
            }
        });
    }
}

/**
 * Build the data grid's column spec: one column per introspected field, with
 * every row locked read-only (a view is never edited through this panel).
 */
function buildViewColumnSpec(columns: ColumnMeta[]): ColumnSpec {
    return { columns: columns.map(c => ({ field: c.name })), rowReadOnly: () => true };
}

/**
 * Build the toolbar: the Explain / Analyze plan actions on the left, then a flex
 * spacer pushing Export and Refresh to the far right (matching TableWorkPanel's
 * view-action group).
 */
function buildToolBar(store: AjaxStore, onExport: ExportTable, onExplain: ExplainView): ToolBar {
    // The full-relation export streams the whole view server-side (not the loaded
    // page), matching TableWorkPanel's Export button.
    const exportButton = buildExportButton("Export view (CSV / JSON)", onExport);

    // Explain opens the plan on a Query tab (see openQuery); this panel's grid is
    // never disturbed. Analyze executes the view query (rolled back server-side).
    const explainButton = glyphButton("diagram-project", NEUTRAL_COLOR, "Explain (Ctrl+E)\n\nopens a query tab",
                                      () => onExplain(false));
    const analyzeButton = glyphButton("flask", CAUTION_COLOR, "Explain Analyze (Ctrl+Shift+E)\n\nopens a query tab; executes the view query",
                                      () => onExplain(true));

    return new ToolBar({
        components: [
            explainButton,
            analyzeButton,
            // Flex spacer pushes the view actions to the far right, matching
            // TableWorkPanel.
            Spacer.flex(),
            exportButton,
            // No reject() before load(): a read-only store has no pending edits.
            glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", () => void store.load()),
        ],
    });
}

