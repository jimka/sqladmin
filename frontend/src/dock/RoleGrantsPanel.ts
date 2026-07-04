// A read-only, paginated grid of a role's table privileges (one row per grant),
// shown in its own Dock work-area tab opened from the Roles view. Backed by a
// Store over an in-memory paging proxy with a PaginationBar: a superuser can
// hold ~1500 grants, and the library Table renders nothing when handed that many
// rows in one load (see LIBRARY_NOTES.md), so the grants are paged — also a
// phpMyAdmin-style work-area table.

import { Panel }              from "@jimka/typescript-ui/core";
import { Border }             from "@jimka/typescript-ui/layout";
import { Placement }          from "@jimka/typescript-ui/primitive";
import { ToolBar }            from "@jimka/typescript-ui/component/menubar";
import { Spacer }             from "@jimka/typescript-ui/component/container";
import { Button }             from "@jimka/typescript-ui/component/button";
import { Table }              from "@jimka/typescript-ui/component/table";
import { Store, Model }       from "@jimka/typescript-ui/data";
import { PaginationBar, Glyph } from "@jimka/typescript-ui/component/display";
import { Menu }               from "@jimka/typescript-ui/overlay";
import { file_export }        from "@jimka/typescript-ui/glyphs/solid/file_export";
import { file_csv }           from "@jimka/typescript-ui/glyphs/solid/file_csv";
import { file_code }          from "@jimka/typescript-ui/glyphs/solid/file_code";
import type { RolePrivilege } from "../contract";
import { PagingMemoryProxy }  from "../data/PagingMemoryProxy";
import { exportRoleGrants }   from "./exportRoleGrants";

Glyph.register(file_export, file_csv, file_code);

// Rows per page — comfortably below the count at which the library Table render
// limit bites (the row-CRUD path uses the same 100), and a sensible page for the
// work area.
const PAGE_SIZE = 100;

/** Neutral toolbar glyph color, matching the table/view work panels' Export button. */
const BLUE = "rgb(30, 100, 200)";

/** Build a Dock panel showing a role's table grants as a paginated read-only grid. */
export function RoleGrantsPanel(role: string, privileges: RolePrivilege[]): Panel {
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
            { component: buildToolBar(role, privileges),                        constraints: { placement: Placement.NORTH } },
            { component: Table(store, { columns: [], rowReadOnly: () => true }), constraints: { placement: Placement.CENTER } },
            { component: new PaginationBar(store),                               constraints: { placement: Placement.SOUTH } },
        ],
    });

    void store.load();

    return panel;
}

/**
 * Build the toolbar: a flex spacer and an Export button, right-aligned to match
 * the table/view work panels. Export serializes the role's whole grant set —
 * every page, since the grants are held in memory and paging is display-only.
 */
function buildToolBar(role: string, privileges: RolePrivilege[]): ToolBar {
    const exportMenu = Menu();
    const exportButton = glyphButton("file-export", BLUE, "Export grants (CSV / JSON)", event => {
        exportMenu.show(event.clientX, event.clientY, [
            { text: "Export CSV (.csv)",   glyph: "file-csv",  action: () => exportRoleGrants(role, privileges, "csv") },
            { text: "Export JSON (.json)", glyph: "file-code", action: () => exportRoleGrants(role, privileges, "json") },
        ]);
    });

    return new ToolBar({ components: [Spacer.flex(), exportButton] });
}

/** A glyph-only toolbar button: colored icon, hover tooltip + accessible name, click handler. */
function glyphButton(glyph: string, color: string, label: string, handler: (event: MouseEvent) => void): Button {
    // showText:false keeps the face glyph-only while the label drives both the
    // hover tooltip and the aria-label (accessible name).
    const button = Button({ glyph, text: label, showText: false, foregroundColor: color, compact: true });

    button.on("action", handler);

    return button;
}
