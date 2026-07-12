// A read-only, paginated grid of a role's table privileges (one row per grant),
// shown in its own Dock work-area tab opened from the Roles view. Backed by a
// Store over an in-memory paging proxy with a PaginationBar: a superuser can
// hold ~1500 grants, and paging them phpMyAdmin-style is the better UX for a
// work-area table than one long scroll.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the panel `extends
// Container`, inlining its own Border frame directly (toolbar NORTH, grid
// CENTER, PaginationBar SOUTH) rather than building it through a shared shell
// builder. No event listeners are registered, so the panel needs no instance
// fields at all. `buildToolBar` stays a stateless module-level function.

import { Container }          from "@jimka/typescript-ui/core";
import { Border as BorderLayout } from "@jimka/typescript-ui/layout";
import { Placement }          from "@jimka/typescript-ui/primitive";
import { ToolBar }            from "@jimka/typescript-ui/component/menubar";
import { Spacer }             from "@jimka/typescript-ui/component/container";
import { Table }              from "@jimka/typescript-ui/component/table";
import { Store, Model }       from "@jimka/typescript-ui/data";
import { PaginationBar }      from "@jimka/typescript-ui/component/display";
import type { RolePrivilege } from "../contract";
import { PagingMemoryProxy }  from "../data/PagingMemoryProxy";
import { exportRoleGrants }   from "./exportRoleGrants";
import { buildExportButton }  from "./exportButton";
import { PAGE_SIZE }          from "../data/stores";

/** A Dock panel showing a role's table grants as a paginated read-only grid. */
export class RoleGrantsPanel extends Container {
    constructor(role: string, privileges: RolePrivilege[]) {
        // `this` is unavailable until after `super()`, so everything is built
        // as locals first.
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

        const toolbar    = buildToolBar(role, privileges);
        const grid       = Table(store, { columns: [], rowReadOnly: () => true });
        const pagination = new PaginationBar(store);

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this.addComponent(toolbar,    { placement: Placement.NORTH });
        this.addComponent(grid,       { placement: Placement.CENTER });
        this.addComponent(pagination, { placement: Placement.SOUTH });

        // Load after the panel is assembled (mirrors the original ordering).
        void store.load();
    }
}

/**
 * Build the toolbar: a flex spacer and an Export button, right-aligned to match
 * the table/view work panels. Export serializes the role's whole grant set —
 * every page, since the grants are held in memory and paging is display-only.
 */
function buildToolBar(role: string, privileges: RolePrivilege[]): ToolBar {
    const exportButton = buildExportButton(
        "Export grants (CSV / JSON)",
        format => exportRoleGrants(role, privileges, format),
    );

    return new ToolBar({ components: [Spacer.flex(), exportButton] });
}

