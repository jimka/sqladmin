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
// The record-view toggle, its Previous/Next steppers, and quick search all
// live in the shared `RecordViewControls` (recordViewControls.ts) — the same
// group `QueryResultView.ts`'s `QueryResultGrid` mounts. This panel adds only
// the status line (`syncQuickSearchStatus`, through `notify`, which is why an
// empty query leaves the last message alone) and the Add gating that follows
// the display mode (`syncAddEnabled`). Quick search stays purely local (no
// network request); the grid's own header filter row (toggled from its
// right-click context menu, via `Table.setFilterRowVisible`) is the remote
// counterpart — each committed keystroke there writes into the store's filter
// state, which reloads page 1 from the server. Both can be active at once —
// see plans/implemented/table-local-filter.md's Architecture Decisions.
//
// The panel can also open pre-seeded by a route's view-mode request (rotated,
// a focused record, or both — see TableViewOptions): once wiring is done, the
// panel calls `controls.setRotated(true)`, and a requested record is focused
// once the store's first page loads via `focusRecord`/`findRecordByKey` (see
// recordNavigation.ts). Both are independent of each other and of quick search.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the panel `extends
// Container`, inlining its own Border frame directly (the same shape
// RoleGrantsPanel inlines too). The sync handlers and `syncQuickSearchStatus`
// are arrow-function fields — they're registered by reference on
// `store`/`dataGrid` events, which would drop `this` if they were plain
// methods. `buildColumnSpec`/`save_`/`missingRequiredFields`/`confirmDelete`
// stay stateless module-level functions.

import { Container, Panel, callable } from "@jimka/typescript-ui/core";
import { Border as BorderLayout, Fit } from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { ToolBar, ToolBarSeparator }   from "@jimka/typescript-ui/component/menubar";
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
import { file_import }                 from "@jimka/typescript-ui/glyphs/solid/file_import";
import type { ColumnMeta, TablePrivileges } from "../contract";
import { buildExportButton }           from "./exportButton";
import { buildColumnSpec, missingRequiredFields } from "./tableWriteRules";
import { quickSearchStatus }           from "./quickSearchModel";
import { findRecordByKey }             from "./recordNavigation";
import { RecordViewControls }          from "./recordViewControls";
import { REFRESH_SHORTCUT }            from "../shell/queryShortcuts";
import { PRIMARY_COLOR, CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR } from "../theme";
import type { Notify }                 from "./notify";

Glyph.register(refresh, plus, minus, save, file_import);

/** Export the whole relation server-side (the streaming full-table export). */
export type ExportTable = (format: "csv" | "json") => void;

/** Open the import dialog (file pick -> preview -> commit) for this table. */
export type ImportTable = () => void;

/** How a table's data tab should open — the view-mode properties a route can request. */
export interface TableViewOptions {
    /** Open in the rotated (one record as field/value rows) display mode. */
    rotated?: boolean;
    /** Primary-key value of the record to select once the first page has loaded. */
    record?: string;
}

/**
 * The dock work panel hosting a table's data grid: a toolbar (NORTH) over the
 * live grid (CENTER). `privileges` gates the write actions: no UPDATE makes
 * every cell read-only, no INSERT disables Add, no DELETE disables Delete,
 * and Save enables only when a permitted change is pending.
 */
class TableWorkPanel extends Container {
    private readonly store:        AjaxStore;
    private readonly dataGrid:     Table;
    private readonly privileges:   TablePrivileges;
    private readonly canWrite:     boolean;
    private readonly notify:       Notify;

    // The buttons the sync handlers toggle need to be reachable as fields.
    // addButton is no longer a fixed capability: syncAddEnabled toggles it
    // with the record-view state as well as with `privileges.insert`.
    private readonly addButton:    Button;
    private readonly deleteButton: Button;
    private readonly saveButton:   Button;
    private readonly controls:     RecordViewControls;

    constructor(
        store: AjaxStore, columns: ColumnMeta[], notify: Notify, onExport: ExportTable, onImport: ImportTable,
        privileges: TablePrivileges, view?: TableViewOptions,
    ) {
        // `this` is unavailable until after `super()`, so the grid and toolbar
        // buttons are built as locals first.
        const dataGrid = Table(store, buildColumnSpec(columns, privileges.update));
        // Both arrows below reference `this` before `super()` has run; that
        // compiles and is safe, because neither runs until after construction
        // — RecordViewControls' own constructor only re-syncs the steppers,
        // never flips the display mode or applies a search (the two actions
        // that invoke these hooks).
        const controls = new RecordViewControls({
            grid:              dataGrid,
            searchPlaceholder: "Quick search (loaded rows)",
            onRotate:          () => this.syncAddEnabled(),
            onQuery:           () => this.syncQuickSearchStatus(),
        });

        // A change can only be persisted with at least one write privilege; Save
        // enables only when a *permitted* change is pending (Add/Delete and cell
        // editing are themselves gated below, so pending changes never outrun this).
        const canWrite = privileges.insert || privileges.update || privileges.delete;

        // A permission-denied tooltip when the verb isn't granted, so a greyed-out
        // button explains itself rather than looking broken.
        const addButton = glyphButton("plus", CONSTRUCTIVE_COLOR,
            privileges.insert ? "Add row" : "Add row (no insert permission)", () => store.add({}));
        // Import sits with Export in the far-right file-I/O group rather than
        // beside Add — grouped with "moves data in/out of the table" rather
        // than the row-level edit actions. Its construction and gating still
        // mirror addButton's own (including CONSTRUCTIVE_COLOR, since it is
        // itself an insert): it does not also disable in the rotated record
        // view the way Add does (that restriction is specific to "only the
        // grid can fill in a new row" — see syncAddEnabled below — which
        // doesn't apply to a modal dialog flow), and `privileges.insert`
        // never changes after the panel opens, so this is a one-time
        // setEnabled rather than a syncXEnabled listener like Add/Delete/Save.
        const importButton = glyphButton("file-import", CONSTRUCTIVE_COLOR,
            privileges.insert ? "Import data (CSV / JSON)" : "Import data (no insert permission)", () => onImport());
        importButton.setEnabled(privileges.insert);
        const deleteButton = glyphButton("minus", DESTRUCTIVE_COLOR,
            privileges.delete ? "Delete row" : "Delete row (no delete permission)", () => void confirmDelete(store, dataGrid));
        const saveButton = glyphButton("save", PRIMARY_COLOR,
            canWrite ? "Save" : "Save (read-only — no write permission)", () => save_(store, columns, notify));

        // The full-relation export runs server-side (it streams the whole table, not
        // the grid's loaded page), so it stays correct regardless of paging, sort, or
        // filter — the table analogue of the query-result Export button.
        const exportButton = buildExportButton("Export table (CSV / JSON)", onExport);

        const toolbar = new ToolBar({
            components: [
                // Record view leads at the far left, set off from the edit actions by
                // a separator — it's a view mode, not an edit, so it reads as its own
                // group rather than one more button beside Add/Delete/Save.
                ...controls.buttons,
                new ToolBarSeparator(),
                addButton,
                deleteButton,
                saveButton,
                // Flex spacer pushes the remaining view actions (quick search,
                // Import, Export, Refresh) to the far right, away from the
                // edit actions.
                Spacer.flex(),
                controls.searchField,
                // Separator sets quick search off from the Import/Export/Refresh
                // action group, since it's a view filter rather than an action.
                new ToolBarSeparator(),
                importButton,
                exportButton,
                // Refresh discards unsaved edits then reloads from the server. reject()
                // must precede load(): load() replaces the records but leaves pending
                // removals queued, so without it a deleted row would reappear yet stay
                // marked for deletion on the next Save.
                glyphButton("refresh", PRIMARY_COLOR, `Refresh (${REFRESH_SHORTCUT})`, () => { store.reject(); void store.load(); }),
            ],
        });

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this.store      = store;
        this.dataGrid   = dataGrid;
        this.privileges = privileges;
        this.canWrite   = canWrite;
        this.notify     = notify;

        this.addButton    = addButton;
        this.deleteButton = deleteButton;
        this.saveButton   = saveButton;
        this.controls     = controls;

        this.addComponent(toolbar, { placement: Placement.NORTH });
        this.addComponent(Panel({ layoutManager: new Fit(), components: [dataGrid] }), { placement: Placement.CENTER });

        // Quick search narrows the loaded page live, with no network request;
        // re-derive its status message whenever the loaded records change under it
        // (an edit, or a fresh page from Refresh / a column-filter reload).
        this.syncQuickSearchStatus();
        store.on("datachange", this.syncQuickSearchStatus);
        store.on("load", this.syncQuickSearchStatus);

        // Add is no longer a fixed capability: it also disables while the
        // record view is showing, since only the grid can fill in a new row.
        this.syncAddEnabled();

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

        // 'datachange' covers add/remove while the 'selection' the controls
        // registered (in their own constructor) covers stepping, toggling and
        // a reload's re-target.
        store.on("datachange", this.controls.syncStepEnabled);

        // Apply the route's requested view mode last, so setRotated's own sync
        // calls act on the final state rather than being immediately
        // superseded by the listener wiring above.
        if (view?.rotated === true) {
            this.controls.setRotated(true);
        }

        if (view?.record !== undefined && view.record !== "") {
            this.focusRecord(view.record);
        }
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

    // Registered by reference on `store` ("datachange", "load") — arrow-function
    // field. Recomputes the message from the CURRENT query against whatever is
    // loaded now, and reports it through `notify` (the same shared, scoped
    // status-bar line every other panel message goes through) instead of a
    // dedicated toolbar label. An empty query leaves the status bar's last
    // message alone rather than emitting a fresh one: `notify` is a one-shot
    // point message here (Save, Refresh, …all write it the same way), not a
    // continuously-synced label, so there's nothing new to report once the
    // query is cleared.
    private syncQuickSearchStatus = (): void => {
        const query = this.controls.getQuery();

        if (query === "") {
            return;
        }

        const loaded  = this.store.getRecords();
        const matched = this.controls.matchingRecords().length;

        this.notify(quickSearchStatus(matched, loaded.length, this.store.getTotalCount()));
    };

    // Only ever called as this.syncAddEnabled(), but stays an arrow field to
    // match its siblings in this file (COMPONENT_CONVENTIONS.md (c)).
    private syncAddEnabled = (): void => {
        const rotated = this.controls.isRotated();

        this.addButton.setEnabled(this.privileges.insert && !rotated);
        this.addButton.setDescription(rotated ? "Switch to the grid view to add a row" : "");
    };

    /**
     * Select the record whose primary key is `key` once the store's first page
     * arrives, then stop listening — a later Refresh must not re-target the grid
     * behind the user. Reports through `notify` when no loaded record matches,
     * which is what a record outside the first page looks like from here.
     *
     * @param key - The primary-key value from the route's `record` parameter.
     */
    private focusRecord(key: string): void {
        const onLoad = (): void => {
            this.store.off("load", onLoad);

            const target = findRecordByKey(this.store.getRecords(), key);

            if (!target) {
                // Deferred a macrotask (not called inline): AbstractStore.load()
                // emits "load" synchronously, one microtask turn before its own
                // returned promise resolves — so SqlAdminController.openTable's
                // `store.load().then(() => this.syncToPanel(id))` always runs
                // after this handler and would otherwise clobber this message
                // with syncToPanel's own "N rows" status line. setTimeout(0)
                // waits for the whole pending microtask queue (however many
                // hops the load chain has) to drain first, so this message is
                // the one still showing once the tab has settled.
                setTimeout(() => this.notify(`no loaded record has key ${key}`), 0);

                return;
            }

            this.dataGrid.selectRecord(target);
        };

        this.store.on("load", onLoad);
    }
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
