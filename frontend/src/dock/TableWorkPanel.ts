// The dock work panel for one table: an inline ToolBar of glyph-only actions
// (Add / Delete / Save … Refresh) over the live data grid.
//
// The toolbar drives the store directly: load / add / remove / sync. Transport
// errors surface as the store's 'exception'/'sync' events, wired to the
// controller's notifyError in openTable; client-side validation messages and the
// save-feedback go through the `notify` callback the controller supplies. The
// table's structure opens in its own tab from the navigator's right-click menu
// (see StructurePanel / SqlAdminController).

import { Panel }                       from "@jimka/typescript-ui/core";
import type { Container }              from "@jimka/typescript-ui/core";
import { Fit }                         from "@jimka/typescript-ui/layout";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Spacer }                      from "@jimka/typescript-ui/component/container";
import { glyphButton }                 from "./glyphButton";
import { Table }                       from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }             from "@jimka/typescript-ui/component/table";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import { Dialog, DialogButtons }       from "@jimka/typescript-ui/overlay";
import type { AjaxStore, ModelRecord } from "@jimka/typescript-ui/data";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import { plus }                        from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus }                       from "@jimka/typescript-ui/glyphs/solid/minus";
import { save }                        from "@jimka/typescript-ui/glyphs/solid/save";
import { filter }                      from "@jimka/typescript-ui/glyphs/solid/filter";
import type { ColumnMeta }             from "../contract";
import { openFilterDialog }            from "./FilterDialog";
import { buildExportButton }           from "./exportButton";
import { workPanelShell }              from "./workPanelShell";
import { PRIMARY_COLOR, CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR, FILTER_ACTIVE_COLOR } from "../theme";

Glyph.register(refresh, plus, minus, save, filter);

/** Surface a short status message (validation / save feedback) to the user. */
export type Notify = (message: string) => void;

/** Export the whole relation server-side (the streaming full-table export). */
export type ExportTable = (format: "csv" | "json") => void;

/** Build the work panel hosting a table's data grid. */
export function TableWorkPanel(store: AjaxStore, columns: ColumnMeta[], notify: Notify, onExport: ExportTable): Container {
    const dataGrid = Table(store, buildColumnSpec(columns));

    return workPanelShell(
        buildToolBar(store, dataGrid, columns, notify, onExport),
        Panel({ layoutManager: new Fit(), components: [dataGrid] }),
    );
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
    const deleteButton = glyphButton("minus", DESTRUCTIVE_COLOR, "Delete row", () => void confirmDelete(store, dataGrid));
    const saveButton = glyphButton("save", PRIMARY_COLOR, "Save", () => save_(store, columns, notify));
    const filterButton = glyphButton("filter", PRIMARY_COLOR, "Filter rows", () => openFilterDialog(store, columns));

    // The full-relation export runs server-side (it streams the whole table, not
    // the grid's loaded page), so it stays correct regardless of paging, sort, or
    // filter — the table analogue of the query-result Export button.
    const exportButton = buildExportButton("Export table (CSV / JSON)", onExport);

    const bar = new ToolBar({
        components: [
            glyphButton("plus", CONSTRUCTIVE_COLOR, "Add row", () => store.add({})),
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
            glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", () => { store.reject(); void store.load(); })
        ]
    });

    // Tint the Filter button and mark its tooltip while any filter is active.
    // 'filterchange' fires whenever the store's active-filter set changes (the
    // dialog's Apply/Clear drive it through filterBy/clearFilter).
    const syncFilterActive = (): void => {
        const active = store.getActiveFilters().length > 0;

        filterButton.setForegroundColor(active ? FILTER_ACTIVE_COLOR : PRIMARY_COLOR);
        filterButton.setDescription(active ? "Filter rows (active)" : "Filter rows");
    };
    syncFilterActive();
    store.on("filterchange", syncFilterActive);

    // Save is only meaningful with unsaved edits/adds/removes; 'datachange'
    // fires on each of those (and after a sync clears them).
    const syncSaveEnabled = (): void => void saveButton.setEnabled(store.hasPendingChanges());
    syncSaveEnabled();
    store.on("datachange", syncSaveEnabled);

    // Delete needs at least one selected row that still exists. Re-check on
    // selection changes and on 'datachange' (a removal drops rows from the
    // store, so a now-deleted selection no longer counts).
    const syncDeleteEnabled = (): void => {
        const live             = new Set(store.getAll());
        const hasLiveSelection = dataGrid.getSelectedRecords().some((r: ModelRecord) => live.has(r));

        deleteButton.setEnabled(hasLiveSelection);
    };
    syncDeleteEnabled();
    dataGrid.on("selection", syncDeleteEnabled);
    store.on("datachange", syncDeleteEnabled);

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

