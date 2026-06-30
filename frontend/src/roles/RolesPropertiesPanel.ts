// A read-only Property/Value inspector for the selected role — the Roles view's
// counterpart to PropertiesPanel. It summarises the selected role's attributes,
// the roles it belongs to, and the table grants it holds.
//
// The rows are paged through a Store + an in-memory paging proxy + a
// PaginationBar (mirroring the MiscPanel paginated-table demo): a superuser can
// hold ~1500 grants, and the Table is never handed more than one page at a time
// — both phpMyAdmin-style UX and a guard against the library's large
// MemoryStore.loadData render limit (see LIBRARY_NOTES.md). Each selection
// replaces the paged dataset and shows its first page.

import { Panel }            from "@jimka/typescript-ui/core";
import { Border }           from "@jimka/typescript-ui/layout";
import { Placement }        from "@jimka/typescript-ui/primitive";
import { Table }            from "@jimka/typescript-ui/component/table";
import { Store, Model }     from "@jimka/typescript-ui/data";
import { PaginationBar }    from "@jimka/typescript-ui/component/display";
import type { RoleDetail }  from "../contract";
import { roleDetailRows }   from "./roleDetailRows";
import type { RoleDetailRow } from "./roleDetailRows";
import { PagingMemoryProxy } from "./PagingMemoryProxy";

// Fixed height the inspector occupies at the bottom of the roles accordion; the
// tree above it takes the rest (mirrors PropertiesPanel, plus room for the
// pagination bar).
const PANEL_HEIGHT = 240;

// Rows per page. Comfortably below the row count at which the library's Table
// render limit bites, so every page renders; small enough to keep the narrow
// sidebar responsive.
const PAGE_SIZE = 50;

/** The selected role's detail, shown as a paged read-only Property/Value grid. */
export class RolesPropertiesPanel {
    readonly component: Panel;

    private readonly _store: Store;
    private readonly _proxy: PagingMemoryProxy;

    constructor() {
        const model = new Model({
            fields: [
                { name: "property", type: "string", description: "Property", order: 1 },
                { name: "value", type: "string", description: "Value", order: 2 },
            ],
        });

        this._proxy = new PagingMemoryProxy();
        this._store = new Store({ model, proxy: this._proxy });
        this._store.setPageSize(PAGE_SIZE);

        this.component = Panel({
            layoutManager: new Border(),
            preferredSize: { width: 0, height: PANEL_HEIGHT },
            minSize      : { width: 0, height: PANEL_HEIGHT },
            components   : [
                { component: Table(this._store, { columns: [], rowReadOnly: () => true }), constraints: { placement: Placement.CENTER } },
                { component: new PaginationBar(this._store),                               constraints: { placement: Placement.SOUTH } },
            ],
        });

        this.clear();
    }

    /** Replace the grid with the given role's attributes, memberships, and privileges. */
    show(detail: RoleDetail): void {
        this._load(roleDetailRows(detail));
    }

    /** Empty state shown before any role is selected. */
    clear(): void {
        this._load([{ property: "Role", value: "Select a role to view its details." }]);
    }

    /** Swap in a new paged dataset and show its first page. */
    private _load(rows: RoleDetailRow[]): void {
        this._proxy.setData(rows);

        // Reset to page 1 for the new role. goToPage(1) reloads only when the
        // page actually changes, so when already on page 1 load() is called
        // directly to fetch the new first page.
        if (this._store.getPage() === 1) {
            void this._store.load();
        } else {
            this._store.goToPage(1);
        }
    }
}
