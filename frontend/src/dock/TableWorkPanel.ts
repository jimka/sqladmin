// The dock work panel for one table: an inline ToolBar (Refresh / Add / Delete /
// Save + a Data | Structure toggle) over a Card body that switches between the
// live data grid and a read-only structure view (one row per column).
//
// The toolbar drives the store directly: load / add / remove / sync. Errors are
// not handled here — load()/sync() failures surface as the store's
// 'exception'/'sync' events, wired to the controller's notifyError in openTable.

import { Component, Panel } from "@jimka/typescript-ui/core";
import { Placement } from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Card, Fit } from "@jimka/typescript-ui/layout";
import { ToolBar } from "@jimka/typescript-ui/component/menubar";
import { Button } from "@jimka/typescript-ui/component/button";
import { Table } from "@jimka/typescript-ui/component/table";
import type { ColumnSpec } from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model } from "@jimka/typescript-ui/data";
import type { AjaxStore, ModelRecord } from "@jimka/typescript-ui/data";
import type { ColumnMeta } from "../contract";

/** Build the work panel hosting a table's data grid + structure view. */
export function TableWorkPanel(store: AjaxStore, columns: ColumnMeta[]): Panel {
    const dataGrid = Table(store, buildColumnSpec(columns));
    const dataView = Panel({ layoutManager: new Fit(), components: [dataGrid] });
    const structureView = Panel({ layoutManager: new Fit(), components: [buildStructureTable(columns)] });

    const body = Panel({ layoutManager: new Card() });
    body.addComponent(dataView);
    body.addComponent(structureView);

    const card = body.getLayoutManager() as Card;
    card.setVisibleComponentId(dataView.getId());

    const panel = Panel({ layoutManager: new BorderLayout() });
    panel.addComponent(buildToolBar(store, dataGrid, card, dataView.getId(), structureView.getId()), {
        placement: Placement.NORTH,
    });
    panel.addComponent(body, { placement: Placement.CENTER });

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

/** Toolbar wired to the store (CRUD) and the Data/Structure card toggle. */
function buildToolBar(
    store: AjaxStore,
    dataGrid: Table,
    card: Card,
    dataId: string,
    structureId: string,
): ToolBar {
    const bar = new ToolBar();

    bar.addComponent(actionButton("Refresh", () => void store.load()));
    bar.addComponent(actionButton("Add row", () => store.add({})));
    bar.addComponent(actionButton("Delete row", () => dataGrid.getSelectedRecords().forEach((r: ModelRecord) => store.remove(r))));
    bar.addComponent(actionButton("Save", () => void store.sync()));
    bar.addComponent(actionButton("Data", () => card.setVisibleComponentId(dataId)));
    bar.addComponent(actionButton("Structure", () => card.setVisibleComponentId(structureId)));

    return bar;
}

/** A toolbar button that runs `handler` on click. */
function actionButton(text: string, handler: () => void): Button {
    const button = Button({ text });
    button.on("action", handler);

    return button;
}

/** A read-only grid of the introspected column metadata. */
function buildStructureTable(columns: ColumnMeta[]): Component {
    const model = new Model({
        fields: [
            { name: "name", type: "string", description: "Column", order: 1 },
            { name: "dataType", type: "string", description: "Type", order: 2 },
            { name: "nullable", type: "boolean", description: "Nullable", order: 3 },
            { name: "isPrimaryKey", type: "boolean", description: "PK", order: 4 },
            { name: "isGenerated", type: "boolean", description: "Generated", order: 5 },
            { name: "wireType", type: "string", description: "Wire type", order: 6 },
        ],
    });

    const store = new MemoryStore({ model, data: columns, autoLoad: true });

    return Table(store);
}
