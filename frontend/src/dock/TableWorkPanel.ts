// The dock work panel for one table: an inline ToolBar of glyph-only actions
// over the live data grid — the record-view toggle and its Previous / Next
// steppers at the far left, a separator, then Add / Delete / Save, then a
// quick-search field set off by a separator from Export and Refresh.
//
// The toolbar drives the store directly: load / add / remove / sync. Transport
// errors surface as the store's 'exception'/'sync' events, wired to the
// controller's notifyError in openTable; client-side validation messages and the
// save-feedback go through the `notify` callback the controller supplies. The
// table's structure opens in its own tab from the navigator's right-click menu
// (see StructurePanel / SqlAdminController).
//
// Quick search (applyQuickSearch/syncQuickSearchStatus) is local: it narrows
// which already-loaded rows the grid shows via `Table.setRowVisible`, with no
// network request, and reports its match count through the shared `notify`
// status line rather than a dedicated toolbar label. The grid's own header
// filter row (toggled from its right-click context menu, via
// `Table.setFilterRowVisible`) is remote: each committed keystroke there
// writes into the store's filter state, which reloads page 1 from the server.
// Both can be active at once — see quickSearchModel.ts and
// plans/implemented/table-local-filter.md's Architecture Decisions.
//
// The record-view toggle flips the same grid to the library's rotated
// (field/value) display mode via `Table.setDisplayMode` — no second grid, no
// app-side projection. The mode is read-only, so it never affects Save; only
// Add changes meaning between the two views, since it needs the grid to fill
// in a new row. Previous/Next step `store.getRecords()` — the loaded page —
// clamped at both ends by the pure `stepIndex` helper.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the panel `extends
// Container`, inlining its own Border frame directly (the same shape
// RoleGrantsPanel inlines too). The sync handlers, `toggleRecordView`,
// `applyQuickSearch`, and `syncQuickSearchStatus` are arrow-function fields —
// they're registered by reference on `store`/`dataGrid`/`recordToggle`/
// `quickSearchField` events, which would drop `this` if they were plain
// methods. `buildColumnSpec`/`save_`/`missingRequiredFields`/`confirmDelete`/
// `stepRecord` stay stateless module-level functions.

import { Container, Panel, callable } from "@jimka/typescript-ui/core";
import { Border as BorderLayout, Fit } from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { ToolBar, ToolBarSeparator }   from "@jimka/typescript-ui/component/menubar";
import { Button, ToggleButton }        from "@jimka/typescript-ui/component/button";
import { Spacer }                      from "@jimka/typescript-ui/component/container";
import { TextField }                   from "@jimka/typescript-ui/component/input";
import { glyphButton, glyphToggleButton } from "./glyphButton";
import { Table }                       from "@jimka/typescript-ui/component/table";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import { Dialog, DialogButtons }       from "@jimka/typescript-ui/overlay";
import type { AjaxStore, ModelRecord } from "@jimka/typescript-ui/data";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import { plus }                        from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus }                       from "@jimka/typescript-ui/glyphs/solid/minus";
import { save }                        from "@jimka/typescript-ui/glyphs/solid/save";
import { table_list }                  from "@jimka/typescript-ui/glyphs/solid/table_list";
import { angle_left }                  from "@jimka/typescript-ui/glyphs/solid/angle_left";
import { angle_right }                 from "@jimka/typescript-ui/glyphs/solid/angle_right";
import type { ColumnMeta, TablePrivileges } from "../contract";
import { buildExportButton }           from "./exportButton";
import { buildColumnSpec, missingRequiredFields } from "./tableWriteRules";
import { matchesQuickSearch, quickSearchStatus } from "./quickSearchModel";
import { stepIndex }                   from "./recordNavigation";
import { PRIMARY_COLOR, CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR } from "../theme";

Glyph.register(refresh, plus, minus, save, table_list, angle_left, angle_right);

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
    private readonly notify:     Notify;

    // The buttons the sync handlers toggle need to be reachable as fields.
    // addButton is no longer a fixed capability: syncAddEnabled toggles it
    // with the record-view state as well as with `privileges.insert`.
    // quickSearchField backs the local, network-free quick search; its
    // status is reported through `notify` rather than a toolbar label.
    private readonly addButton:        Button;
    private readonly deleteButton:     Button;
    private readonly saveButton:       Button;
    private readonly recordToggle:     ToggleButton;
    private readonly prevButton:       Button;
    private readonly nextButton:       Button;
    private readonly quickSearchField: TextField;

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

        // Quick search: local, network-free row hiding over the loaded page
        // (see quickSearchModel.ts). Its match-count status is reported
        // through `notify` rather than a dedicated toolbar label.
        const quickSearchField = new TextField({ placeholder: "Quick search (loaded rows)" });

        // Record view: flips the grid to one record's field/value rows via
        // Table.setDisplayMode. The toggle's handler needs `this` (to re-sync
        // Add and the steppers), which is unavailable here, so it is wired
        // after super() returns. The steppers only need the `dataGrid` local.
        const recordToggle = glyphToggleButton("table-list", PRIMARY_COLOR, "Record view (one record as field/value rows)", false);
        const prevButton   = glyphButton("angle-left",  PRIMARY_COLOR, "Previous record", () => stepRecord(dataGrid, -1));
        const nextButton   = glyphButton("angle-right", PRIMARY_COLOR, "Next record",     () => stepRecord(dataGrid, 1));

        // The full-relation export runs server-side (it streams the whole table, not
        // the grid's loaded page), so it stays correct regardless of paging, sort, or
        // filter — the table analogue of the query-result Export button.
        const exportButton = buildExportButton("Export table (CSV / JSON)", onExport);

        const toolbar = new ToolBar({
            components: [
                // Record view leads at the far left, set off from the edit actions by
                // a separator — it's a view mode, not an edit, so it reads as its own
                // group rather than one more button beside Add/Delete/Save.
                recordToggle,
                prevButton,
                nextButton,
                new ToolBarSeparator(),
                addButton,
                deleteButton,
                saveButton,
                // Flex spacer pushes the remaining view actions (quick search,
                // Export, Refresh) to the far right, away from the edit
                // actions.
                Spacer.flex(),
                quickSearchField,
                // Separator sets quick search off from the Export/Refresh action
                // group, since it's a view filter rather than an action.
                new ToolBarSeparator(),
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
        this.notify     = notify;

        this.addButton        = addButton;
        this.deleteButton     = deleteButton;
        this.saveButton       = saveButton;
        this.recordToggle     = recordToggle;
        this.prevButton       = prevButton;
        this.nextButton       = nextButton;
        this.quickSearchField = quickSearchField;

        this.addComponent(toolbar, { placement: Placement.NORTH });
        this.addComponent(Panel({ layoutManager: new Fit(), components: [dataGrid] }), { placement: Placement.CENTER });

        // Quick search narrows the loaded page live, with no network request;
        // re-derive its status message whenever the loaded records change under it
        // (an edit, or a fresh page from Refresh / a column-filter reload).
        this.quickSearchField.on("change", this.applyQuickSearch);
        this.syncQuickSearchStatus();
        store.on("datachange", this.syncQuickSearchStatus);
        store.on("load", this.syncQuickSearchStatus);

        // Add is no longer a fixed capability: it also disables while the
        // record view is showing, since only the grid can fill in a new row.
        this.syncAddEnabled();

        // The record-view toggle flips the grid's display mode; re-sync Add
        // and the steppers on every flip (both read getDisplayMode()).
        this.recordToggle.on("action", this.toggleRecordView);

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

        // The steppers need a neighbour to exist in the loaded records;
        // re-check on selection changes (stepping/toggling, and a reload or
        // filter re-target, since Table re-emits 'selection' when it
        // re-targets the rotated record after its source store reloads) and
        // on 'datachange' (add/remove changes which records are loaded;
        // 'datachange' does not fire on load, so it is 'selection', not this,
        // that covers a reload).
        this.syncStepEnabled();
        dataGrid.on("selection", this.syncStepEnabled);
        store.on("datachange", this.syncStepEnabled);
    }

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

    // Registered by reference on `quickSearchField` ("change"), which
    // TextInput fires on every keystroke from its native `input` listener —
    // arrow-function field. Installs a fresh predicate each call; null when
    // the query is empty clears the filter entirely. Local and network-free:
    // it only ever decides which of the already-loaded rows are shown, never
    // reloads the store (that's the grid's own header filter row's job).
    private applyQuickSearch = (): void => {
        const query = this.quickSearchField.getValue().trim();

        this.dataGrid.setRowVisible(query === "" ? null : (record: ModelRecord) => matchesQuickSearch(record, query));
        this.syncQuickSearchStatus();
    };

    // Registered by reference on `store` ("datachange", "load") and called
    // directly from applyQuickSearch — arrow-function field. Recomputes the
    // message from the CURRENT query against whatever is loaded now, and
    // reports it through `notify` (the same shared, scoped status-bar line
    // every other panel message goes through) instead of a dedicated toolbar
    // label. An empty query leaves the status bar's last message alone rather
    // than emitting a fresh one: `notify` is a one-shot point message here
    // (Save, Refresh, …all write it the same way), not a continuously-synced
    // label, so there's nothing new to report once the query is cleared.
    private syncQuickSearchStatus = (): void => {
        const query = this.quickSearchField.getValue().trim();

        if (query === "") {
            return;
        }

        const loaded  = this.store.getRecords();
        const matched = loaded.filter((r: ModelRecord) => matchesQuickSearch(r, query)).length;

        this.notify(quickSearchStatus(matched, loaded.length, this.store.getTotalCount()));
    };

    // Registered by reference on `recordToggle` ("action") — arrow-function field.
    private toggleRecordView = (): void => {
        const record = this.dataGrid.getSelectedRecord();

        if (this.recordToggle.isSelected()) {
            this.dataGrid.setDisplayMode("rotated");
        } else {
            this.dataGrid.setDisplayMode("normal");
            // setDisplayMode re-selects the displayed record but does not reveal it;
            // selectRecord's normal-mode path scrolls the row back into view.
            this.dataGrid.selectRecord(record);
        }

        this.syncAddEnabled();
        this.syncStepEnabled();
    };

    // Only ever called as this.syncAddEnabled(), but stays an arrow field to
    // match its siblings in this file (COMPONENT_CONVENTIONS.md (c)).
    private syncAddEnabled = (): void => {
        const rotated = this.dataGrid.getDisplayMode() === "rotated";

        this.addButton.setEnabled(this.privileges.insert && !rotated);
        this.addButton.setDescription(rotated ? "Switch to the grid view to add a row" : "");
    };

    // Registered by reference on both `dataGrid` ("selection") and `store`
    // ("datachange") — arrow-function field.
    private syncStepEnabled = (): void => {
        const rotated = this.dataGrid.getDisplayMode() === "rotated";
        const records = this.store.getRecords();
        const current = this.dataGrid.getSelectedRecord();
        const index   = current ? records.indexOf(current) : -1;

        this.prevButton.setEnabled(rotated && stepIndex(index, -1, records.length) !== null);
        this.nextButton.setEnabled(rotated && stepIndex(index,  1, records.length) !== null);
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

/**
 * Step the record view's displayed record by `delta` positions within the
 * loaded, filtered/sorted records, clamped at both ends. A stateless helper
 * so it can be wired from the Previous/Next buttons while they are still
 * pre-`super()` locals, closing over `dataGrid` alone (no `this`).
 */
function stepRecord(dataGrid: Table, delta: number): void {
    const records = dataGrid.getStore().getRecords();
    const current = dataGrid.getSelectedRecord();
    const target  = stepIndex(current ? records.indexOf(current) : -1, delta, records.length);

    if (target !== null) {
        dataGrid.selectRecord(records[target]);
    }
}

const TableWorkPanelCallable = callable(TableWorkPanel);
type TableWorkPanelCallable = TableWorkPanel;
export { TableWorkPanelCallable as TableWorkPanel };
