// A read-only, paginated grid of a role's table privileges (one row per grant),
// shown in its own Dock work-area tab opened from the Roles view. Backed by a
// Store over an in-memory paging proxy with a PaginationBar: a superuser can
// hold ~1500 grants, and the library Table renders nothing when handed that many
// rows in one load (see LIBRARY_NOTES.md), so the grants are paged — also a
// phpMyAdmin-style work-area table.

import { Panel }              from "@jimka/typescript-ui/core";
import { Border }             from "@jimka/typescript-ui/layout";
import { Placement }          from "@jimka/typescript-ui/primitive";
import { Table }              from "@jimka/typescript-ui/component/table";
import { Store, Model }       from "@jimka/typescript-ui/data";
import { PaginationBar }      from "@jimka/typescript-ui/component/display";
import type { RolePrivilege } from "../contract";
import { PagingMemoryProxy }  from "../data/PagingMemoryProxy";

// Rows per page — comfortably below the count at which the library Table render
// limit bites (the row-CRUD path uses the same 100), and a sensible page for the
// work area.
const PAGE_SIZE = 100;

/** Build a Dock panel showing a role's table grants as a paginated read-only grid. */
export function RoleGrantsPanel(privileges: RolePrivilege[]): Panel {
    const model = new Model({
        fields: [
            { name: "schema", type: "string", description: "Schema", order: 1 },
            { name: "table", type: "string", description: "Table", order: 2 },
            { name: "privilege", type: "string", description: "Privilege", order: 3 },
            { name: "grantable", type: "boolean", description: "Grantable", order: 4 },
        ],
    });

    // RolePrivilege's keys (schema/table/privilege/grantable) match the model
    // fields one-to-one, so the contract objects load directly with no mapping.
    const proxy = new PagingMemoryProxy();
    proxy.setData(privileges);

    const store = new Store({ model, proxy });
    store.setPageSize(PAGE_SIZE);

    const panel = Panel({
        layoutManager: new Border(),
        components   : [
            { component: Table(store, { columns: [], rowReadOnly: () => true }), constraints: { placement: Placement.CENTER } },
            { component: new PaginationBar(store),                               constraints: { placement: Placement.SOUTH } },
        ],
    });

    void store.load();

    return panel;
}
