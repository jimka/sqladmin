// The dock work panel for one table: an inline ToolBar of glyph-only actions
// (Add / Delete / Save … Refresh) over the live data grid.
//
// The toolbar drives the store directly: load / add / remove / sync. Transport
// errors surface as the store's 'exception'/'sync' events, wired to the
// controller's notifyError in openTable; client-side validation messages and the
// save-feedback go through the `notify` callback the controller supplies. The
// table's structure opens in its own tab from the navigator's right-click menu
// (see StructurePanel / SqlAdminController).
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the panel `extends
// Container`, inlining its own Border frame directly (the same shape
// RoleGrantsPanel inlines too). The three sync handlers
// are arrow-function fields — they're registered by reference on
// `store`/`dataGrid` events, which would drop `this` if they were plain
// methods. `buildColumnSpec`/`save_`/`missingRequiredFields`/`confirmDelete`
// stay stateless module-level functions.

import { Container, Panel, callable } from "@jimka/typescript-ui/core";
import { Border as BorderLayout, Fit } from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Button }                      from "@jimka/typescript-ui/component/button";
import { Spacer }                      from "@jimka/typescript-ui/component/container";
import { glyphButton }                 from "./glyphButton";
import { Table }                       from "@jimka/typescript-ui/component/table";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import { Dialog, DialogButtons }       from "@jimka/typescript-ui/overlay";
import type { AjaxStore, ModelRecord } from "@jimka/typescript-ui/data";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import { plus }                        from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus }                       from "@jimka/typescript-ui/glyphs/solid/minus";
import { save }                        from "@jimka/typescript-ui/glyphs/solid/save";
import { filter }                      from "@jimka/typescript-ui/glyphs/solid/filter";
import type { ColumnMeta, TablePrivileges } from "../contract";
import { openFilterDialog }            from "./FilterDialog";
import { buildExportButton }           from "./exportButton";
import { buildColumnSpec, missingRequiredFields } from "./tableWriteRules";
import { PRIMARY_COLOR, CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR, FILTER_ACTIVE_COLOR } from "../theme";

Glyph.register(refresh, plus, minus, save, filter);

/** Surface a short status message (validation / save feedback) to the user. */
export type Notify = (message: string) => void;

/** Export the whole relation server-side (the streaming full-table export). */
export type ExportTable = (format: "csv" | "json") => void;

/**
 * The dock work panel hosting a table's data grid: a toolbar (NORTH) over the
 * live grid (CENTER). `privileges` gates the write actions: no UPDATE makes
 * every cell read-only, no INSERT disables Add, no DELETE disables Delete,
 * and Save enables only when a permitted change is pending.
 */
class TableWorkPanel extends Container {
    private readonly store:      AjaxStore;
    private readonly dataGrid:   Table;
    private readonly privileges: TablePrivileges;
    private readonly canWrite:   boolean;

    // Only the buttons the sync handlers toggle need to be reachable as
    // fields; addButton is set once (setEnabled below) and never revisited.
    private readonly deleteButton: Button;
    private readonly saveButton:   Button;
    private readonly filterButton: Button;

    constructor(store: AjaxStore, columns: ColumnMeta[], notify: Notify, onExport: ExportTable, privileges: TablePrivileges) {
        // `this` is unavailable until after `super()`, so the grid and toolbar
        // buttons are built as locals first.
        const dataGrid = Table(store, buildColumnSpec(columns, privileges.update));

        // A change can only be persisted with at least one write privilege; Save
        // enables only when a *permitted* change is pending (Add/Delete and cell
        // editing are themselves gated below, so pending changes never outrun this).
        const canWrite = privileges.insert || privileges.update || privileges.delete;

        // A permission-denied tooltip when the verb isn't granted, so a greyed-out
        // button explains itself rather than looking broken.
        const addButton = glyphButton("plus", CONSTRUCTIVE_COLOR,
            privileges.insert ? "Add row" : "Add row (no insert permission)", () => store.add({}));
        const deleteButton = glyphButton("minus", DESTRUCTIVE_COLOR,
            privileges.delete ? "Delete row" : "Delete row (no delete permission)", () => void confirmDelete(store, dataGrid));
        const saveButton = glyphButton("save", PRIMARY_COLOR,
            canWrite ? "Save" : "Save (read-only — no write permission)", () => save_(store, columns, notify));
        const filterButton = glyphButton("filter", PRIMARY_COLOR, "Filter rows", () => openFilterDialog(store, columns));

        // The full-relation export runs server-side (it streams the whole table, not
        // the grid's loaded page), so it stays correct regardless of paging, sort, or
        // filter — the table analogue of the query-result Export button.
        const exportButton = buildExportButton("Export table (CSV / JSON)", onExport);

        const toolbar = new ToolBar({
            components: [
                addButton,
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
                glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", () => { store.reject(); void store.load(); }),
            ],
        });

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this.store      = store;
        this.dataGrid   = dataGrid;
        this.privileges = privileges;
        this.canWrite   = canWrite;

        this.deleteButton = deleteButton;
        this.saveButton   = saveButton;
        this.filterButton = filterButton;

        this.addComponent(toolbar, { placement: Placement.NORTH });
        this.addComponent(Panel({ layoutManager: new Fit(), components: [dataGrid] }), { placement: Placement.CENTER });

        // Tint the Filter button and mark its tooltip while any filter is active.
        // 'filterchange' fires whenever the store's active-filter set changes (the
        // dialog's Apply/Clear drive it through filterBy/clearFilter).
        this.syncFilterActive();
        store.on("filterchange", this.syncFilterActive);

        // Add is a fixed capability: without INSERT it stays disabled for the
        // panel's life; otherwise it is always available.
        addButton.setEnabled(privileges.insert);

        // Save is only meaningful with unsaved edits/adds/removes AND some write
        // right; 'datachange' fires on each of those (and after a sync clears them).
        this.syncSaveEnabled();
        store.on("datachange", this.syncSaveEnabled);

        // Delete needs DELETE on the table plus at least one selected row that still
        // exists. Re-check on selection changes and on 'datachange' (a removal drops
        // rows from the store, so a now-deleted selection no longer counts).
        this.syncDeleteEnabled();
        dataGrid.on("selection", this.syncDeleteEnabled);
        store.on("datachange", this.syncDeleteEnabled);
    }

    // Registered by reference on `store` ("filterchange") — an arrow-function
    // field so it keeps `this` when invoked as a callback.
    private syncFilterActive = (): void => {
        const active = this.store.getActiveFilters().length > 0;

        this.filterButton.setForegroundColor(active ? FILTER_ACTIVE_COLOR : PRIMARY_COLOR);
        this.filterButton.setDescription(active ? "Filter rows (active)" : "Filter rows");
    };

    // Registered by reference on `store` ("datachange") — arrow-function field.
    private syncSaveEnabled = (): void => {
        this.saveButton.setEnabled(this.canWrite && this.store.hasPendingChanges());
    };

    // Registered by reference on both `dataGrid` ("selection") and `store`
    // ("datachange") — arrow-function field.
    private syncDeleteEnabled = (): void => {
        const live             = new Set(this.store.getAll());
        const hasLiveSelection = this.dataGrid.getSelectedRecords().some((r: ModelRecord) => live.has(r));

        this.deleteButton.setEnabled(this.privileges.delete && hasLiveSelection);
    };
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

const TableWorkPanelCallable = callable(TableWorkPanel);
type TableWorkPanelCallable = TableWorkPanel;
export { TableWorkPanelCallable as TableWorkPanel };
