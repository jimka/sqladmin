// The dock work panel for one table: an inline ToolBar of glyph-only actions
// (Refresh / Add / Delete / Save) over the live data grid.
//
// The toolbar drives the store directly: load / add / remove / sync. Errors are
// not handled here — load()/sync() failures surface as the store's
// 'exception'/'sync' events, wired to the controller's notifyError in openTable.
// The table's structure (column metadata) opens in its own tab from the
// navigator's right-click menu (see StructurePanel / SqlAdminController).

import { Panel } from "@jimka/typescript-ui/core";
import { Placement } from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit } from "@jimka/typescript-ui/layout";
import { ToolBar } from "@jimka/typescript-ui/component/menubar";
import { Spacer } from "@jimka/typescript-ui/component/container";
import { Button } from "@jimka/typescript-ui/component/button";
import { Table } from "@jimka/typescript-ui/component/table";
import type { ColumnSpec } from "@jimka/typescript-ui/component/table";
import { Glyph } from "@jimka/typescript-ui/component/display";
import type { AjaxStore, ModelRecord } from "@jimka/typescript-ui/data";
import { refresh } from "@jimka/typescript-ui/glyphs/solid/refresh";
import { plus } from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import { save } from "@jimka/typescript-ui/glyphs/solid/save";
import type { ColumnMeta } from "../contract";

Glyph.register(refresh, plus, minus, save);

/** Toolbar glyph colors: blue for neutral actions, green to add, red to delete. */
const BLUE = "rgb(30, 100, 200)";
const GREEN = "rgb(46, 125, 50)";
const RED = "rgb(198, 40, 40)";

/** Build the work panel hosting a table's data grid. */
export function TableWorkPanel(store: AjaxStore, columns: ColumnMeta[]): Panel {
    const dataGrid = Table(store, buildColumnSpec(columns));

    const panel = Panel({ layoutManager: new BorderLayout() });
    panel.addComponent(buildToolBar(store, dataGrid), { placement: Placement.NORTH });
    panel.addComponent(Panel({ layoutManager: new Fit(), components: [dataGrid] }), { placement: Placement.CENTER });

    return panel;
}

/**
 * Build the data grid's column spec. Cells are inline-editable by default;
 * generated columns are marked read-only since the DB assigns their values
 * (the SqlAdminWriter also strips them from writes).
 */
function buildColumnSpec(columns: ColumnMeta[]): ColumnSpec {
    return { columns: columns.map(c => ({ field: c.name, readOnly: c.isGenerated })) };
}

/** Glyph-only toolbar wired to the store (CRUD). */
function buildToolBar(store: AjaxStore, dataGrid: Table): ToolBar {
    const bar = new ToolBar();

    bar.addComponent(glyphButton("plus", GREEN, "Add row", () => store.add({})));
    bar.addComponent(glyphButton("minus", RED, "Delete row", () => dataGrid.getSelectedRecords().forEach((r: ModelRecord) => store.remove(r))));
    const saveButton = glyphButton("save", BLUE, "Save", () => void store.sync());
    bar.addComponent(saveButton);
    // Flex spacer pushes Refresh to the far right, away from the edit actions.
    bar.addComponent(Spacer.flex());
    bar.addComponent(glyphButton("refresh", BLUE, "Refresh", () => void store.load()));

    // Save is only meaningful with unsaved edits/adds/removes; 'datachanged'
    // fires on each of those (and after a sync clears them).
    const syncSaveEnabled = (): void => void saveButton.setEnabled(store.hasPendingChanges());
    syncSaveEnabled();
    store.on("datachanged", syncSaveEnabled);

    return bar;
}

/** A glyph-only toolbar button: colored icon, accessible label, click handler. */
function glyphButton(glyph: string, color: string, label: string, handler: () => void): Button {
    const button = Button({ glyph, foregroundColor: color, compact: true });

    button.getAria().setLabel(label);
    button.on("action", handler);

    return button;
}
