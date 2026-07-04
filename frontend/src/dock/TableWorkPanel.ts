// The dock work panel for one table: an inline ToolBar of glyph-only actions
// (Add / Delete / Save … Refresh) over the live data grid.
//
// The toolbar drives the store directly: load / add / remove / sync. Transport
// errors surface as the store's 'exception'/'sync' events, wired to the
// controller's notifyError in openTable; client-side validation messages and the
// save-feedback go through the `notify` callback the controller supplies. The
// table's structure opens in its own tab from the navigator's right-click menu
// (see StructurePanel / SqlAdminController).

import { Container, Panel }                       from "@jimka/typescript-ui/core";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit } from "@jimka/typescript-ui/layout";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Spacer }                      from "@jimka/typescript-ui/component/container";
import { Button }                      from "@jimka/typescript-ui/component/button";
import { Table }                       from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }             from "@jimka/typescript-ui/component/table";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import { Dialog, DialogButtons, Menu } from "@jimka/typescript-ui/overlay";
import type { AjaxStore, ModelRecord } from "@jimka/typescript-ui/data";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import { plus }                        from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus }                       from "@jimka/typescript-ui/glyphs/solid/minus";
import { save }                        from "@jimka/typescript-ui/glyphs/solid/save";
import { filter }                      from "@jimka/typescript-ui/glyphs/solid/filter";
import { file_export }                 from "@jimka/typescript-ui/glyphs/solid/file_export";
import { file_csv }                    from "@jimka/typescript-ui/glyphs/solid/file_csv";
import { file_code }                   from "@jimka/typescript-ui/glyphs/solid/file_code";
import type { ColumnMeta }             from "../contract";
import { openFilterDialog }            from "./FilterDialog";

Glyph.register(refresh, plus, minus, save, filter, file_export, file_csv, file_code);

/** Toolbar glyph colors: blue for neutral actions, green to add, red to delete. */
const BLUE  = "rgb(30, 100, 200)";
const GREEN = "rgb(46, 125, 50)";
const RED   = "rgb(198, 40, 40)";

/** Amber tints the Filter button while a filter is active, signalling the grid is narrowed. */
const FILTER_ACTIVE = "rgb(230, 145, 30)";

/** Surface a short status message (validation / save feedback) to the user. */
export type Notify = (message: string) => void;

/** Export the whole relation server-side (the streaming full-table export). */
export type ExportTable = (format: "csv" | "json") => void;

/** Build the work panel hosting a table's data grid. */
export function TableWorkPanel(store: AjaxStore, columns: ColumnMeta[], notify: Notify, onExport: ExportTable): Panel {
    const dataGrid = Table(store, buildColumnSpec(columns));

    const panel = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
    panel.addComponent(buildToolBar(store, dataGrid, columns, notify, onExport), { placement: Placement.NORTH });
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

/** Glyph-only toolbar wired to the store (CRUD) with validation + confirmation. */
function buildToolBar(store: AjaxStore, dataGrid: Table, columns: ColumnMeta[], notify: Notify, onExport: ExportTable): ToolBar {
    const deleteButton = glyphButton("minus", RED, "Delete row", () => void confirmDelete(store, dataGrid));
    const saveButton = glyphButton("save", BLUE, "Save", () => save_(store, columns, notify));
    const filterButton = glyphButton("filter", BLUE, "Filter rows", () => openFilterDialog(store, columns));

    // The full-relation export runs server-side (it streams the whole table, not
    // the grid's loaded page), so it stays correct regardless of paging, sort, or
    // filter — the table analogue of the query-result Export button. The CSV/JSON
    // chooser opens at the click point and is reused across clicks.
    const exportMenu = Menu();
    const exportButton = glyphButton("file-export", BLUE, "Export table (CSV / JSON)", event => {
        exportMenu.show(event.clientX, event.clientY, [
            { text: "Export CSV (.csv)",   glyph: "file-csv",  action: () => onExport("csv") },
            { text: "Export JSON (.json)", glyph: "file-code", action: () => onExport("json") },
        ]);
    });

    const bar = new ToolBar({
        components: [
            glyphButton("plus", GREEN, "Add row", () => store.add({})),
            deleteButton,
            saveButton,
            // Flex spacer pushes the view actions (Filter, Export, Refresh) to the
            // far right, away from the edit actions.
            Spacer.flex(),
            filterButton,
            exportButton,
            // Refresh discards unsaved edits then reloads from the server. reject()
            // must precede load(): load() replaces the records but leaves pending
            // removals queued, so without it a deleted row would reappear yet stay
            // marked for deletion on the next Save.
            glyphButton("refresh", BLUE, "Refresh (Alt+R)", () => { store.reject(); void store.load(); })
        ]
    });

    // Tint the Filter button and mark its tooltip while any filter is active.
    // 'filterchange' fires whenever the store's active-filter set changes (the
    // dialog's Apply/Clear drive it through filterBy/clearFilter).
    const syncFilterActive = (): void => {
        const active = store.getActiveFilters().length > 0;

        filterButton.setForegroundColor(active ? FILTER_ACTIVE : BLUE);
        filterButton.setDescription(active ? "Filter rows (active)" : "Filter rows");
    };
    syncFilterActive();
    store.on("filterchange", syncFilterActive);

    // Save is only meaningful with unsaved edits/adds/removes; 'datachanged'
    // fires on each of those (and after a sync clears them).
    const syncSaveEnabled = (): void => void saveButton.setEnabled(store.hasPendingChanges());
    syncSaveEnabled();
    store.on("datachanged", syncSaveEnabled);

    // Delete needs at least one selected row that still exists. Re-check on
    // selection changes and on 'datachanged' (a removal drops rows from the
    // store, so a now-deleted selection no longer counts).
    const syncDeleteEnabled = (): void => {
        const live             = new Set(store.getAll());
        const hasLiveSelection = dataGrid.getSelectedRecords().some((r: ModelRecord) => live.has(r));

        deleteButton.setEnabled(hasLiveSelection);
    };
    syncDeleteEnabled();
    dataGrid.on("selectionchange", syncDeleteEnabled);
    store.on("datachanged", syncDeleteEnabled);

    return bar;
}

/**
 * Validate required fields, then sync. A required field is one that is NOT NULL,
 * not generated, and has no DB default — the user must supply it. Reporting the
 * missing fields up front avoids a raw Postgres NOT NULL error on the round-trip.
 */
function save_(store: AjaxStore, columns: ColumnMeta[], notify: Notify): void {
    const missing = missingRequiredFields(store, columns);

    if (missing.length > 0) {
        notify(`Required field(s) missing: ${missing.join(", ")}`);

        return;
    }

    void store.sync();
}

/**
 * Collect the names of required fields left empty across the pending (new or
 * edited) records. Required = not nullable, not generated, no default.
 */
function missingRequiredFields(store: AjaxStore, columns: ColumnMeta[]): string[] {
    const required = columns.filter(c => !c.nullable && !c.isGenerated && !c.hasDefault);
    const missing = new Set<string>();

    for (const record of store.getAll()) {
        if (!record.isNew() && !record.isDirty()) {
            continue;
        }

        for (const column of required) {
            const value = record.get(column.name);

            if (value === null || value === undefined || value === "") {
                missing.add(column.name);
            }
        }
    }

    return [...missing];
}

/** Confirm before queuing the selected rows for deletion (applied on Save). */
async function confirmDelete(store: AjaxStore, dataGrid: Table): Promise<void> {
    const selected = dataGrid.getSelectedRecords();

    if (selected.length === 0) {
        return;
    }

    const result = await Dialog.show({
        title: "Delete rows",
        message: `Delete ${selected.length} selected row(s)? The deletion is applied when you Save.`,
        buttons: [DialogButtons.Cancel, { ...DialogButtons.Confirm, text: "Delete" }],
    });

    if (result === "confirm") {
        selected.forEach((r: ModelRecord) => store.remove(r));
    }
}

/** A glyph-only toolbar button: colored icon, hover tooltip + accessible name, click handler. */
function glyphButton(glyph: string, color: string, label: string, handler: (event: MouseEvent) => void): Button {
    // showText:false keeps the face glyph-only while the label drives both the
    // hover tooltip and the aria-label (accessible name) — no manual setLabel.
    // showDescription:false keeps a description (e.g. the Filter button's
    // "(active)" state) in the tooltip only, off the glyph-only face.
    const button = Button({ glyph, text: label, showText: false, showDescription: false, foregroundColor: color, compact: true });

    button.on("action", handler);

    return button;
}
