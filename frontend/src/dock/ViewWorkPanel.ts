// The dock work panel for one view or materialized view: a read-only, paginated
// data grid with a single Refresh action. Unlike TableWorkPanel there are NO
// write actions (Add/Delete/Save) — a view is read-only — so the store's
// mutation methods are never invoked and the write toolbar is omitted entirely.
//
// The view's SQL definition and its column structure each open in their own tab
// from the navigator's right-click menu (see DefinitionPanel / StructurePanel and
// the controller's openDefinition / openStructure), keeping this panel a plain
// data surface — the same shape a table's data tab has, minus the edit actions.

import { Panel }                       from "@jimka/typescript-ui/core";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit } from "@jimka/typescript-ui/layout";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Spacer }                      from "@jimka/typescript-ui/component/container";
import { Button }                      from "@jimka/typescript-ui/component/button";
import { Table }                       from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }             from "@jimka/typescript-ui/component/table";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import type { AjaxStore }              from "@jimka/typescript-ui/data";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import type { ColumnMeta }             from "../contract";

Glyph.register(refresh);

/** Neutral toolbar glyph color, matching TableWorkPanel's Refresh action. */
const BLUE = "rgb(30, 100, 200)";

/**
 * Build the read-only work panel for a view/materialized view: a paginated data
 * grid with a Refresh action, and nothing else on the toolbar.
 *
 * @param store - The paginated AjaxStore over the view's rows (never written to).
 * @param columns - The view's introspected columns (drive the grid's columns).
 * @returns The assembled panel.
 */
export function ViewWorkPanel(store: AjaxStore, columns: ColumnMeta[]): Panel {
    // Read-only grid: every cell is locked (rowReadOnly), the same lock
    // StructurePanel/RoleGrantsPanel use.
    const dataGrid = Table(store, buildViewColumnSpec(columns));

    const panel = Panel({ layoutManager: new BorderLayout() });
    panel.addComponent(buildToolBar(store), { placement: Placement.NORTH });
    panel.addComponent(Panel({ layoutManager: new Fit(), components: [dataGrid] }), { placement: Placement.CENTER });

    return panel;
}

/**
 * Build the data grid's column spec: one column per introspected field, with
 * every row locked read-only (a view is never edited through this panel).
 */
function buildViewColumnSpec(columns: ColumnMeta[]): ColumnSpec {
    return { columns: columns.map(c => ({ field: c.name })), rowReadOnly: () => true };
}

/**
 * Build the toolbar: a flex spacer and a lone Refresh button, right-aligned to
 * match the Refresh position in TableWorkPanel's toolbar.
 */
function buildToolBar(store: AjaxStore): ToolBar {
    return new ToolBar({
        components: [
            // Flex spacer pushes Refresh to the far right, matching TableWorkPanel.
            Spacer.flex(),
            // No reject() before load(): a read-only store has no pending edits.
            glyphButton("refresh", BLUE, "Refresh", () => void store.load()),
        ],
    });
}

/** A glyph-only toolbar button: colored icon, hover tooltip + accessible name, click handler. */
function glyphButton(glyph: string, color: string, label: string, handler: () => void): Button {
    // showText:false keeps the face glyph-only while the label drives both the
    // hover tooltip and the aria-label (accessible name) — no manual setLabel.
    const button = Button({ glyph, text: label, showText: false, foregroundColor: color, compact: true });

    button.on("action", handler);

    return button;
}
