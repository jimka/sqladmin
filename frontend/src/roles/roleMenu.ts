// The roles-tree context-menu builder, extracted from RolesTree's own
// `contextmenu` handler so its shape is unit-testable. Mirrors
// ../navigator/objectMenu.ts: glyphs are named as strings, never imported —
// `Glyph.register` stays in the modules that render this menu (RolesTree.ts)
// — so this module stays free of the DOM side effects library component
// modules run at import scope and keeps running under the node vitest
// harness.

import type { MenuItemConfig }   from "@jimka/typescript-ui/component/container";
import { buildTableExportItems } from "../dock/menuItems";

/** The four role actions the roles-tree context menu invokes. */
export interface RoleMenuActions {
    /** Show the role's detail and open (or focus) its grants tab. */
    showRole: (name: string) => void;
    /** Open the role's membership graph. */
    openMembershipDiagram: (name: string) => void;
    /** Open the role's grants graph. */
    openGrantsDiagram: (name: string) => void;
    /** Export the role's full grant set in the given format. */
    exportGrants: (name: string, format: "csv" | "json") => void;
}

/**
 * Build a role leaf's context menu: "Show data" (mirrors the double-click),
 * then the membership/grants graphs, then an "Export grants" submenu of the
 * CSV/JSON formats.
 *
 * @param name - The role the menu was opened for.
 * @param actions - The callbacks to invoke, keyed by menu item.
 * @returns The menu items, in display order.
 */
export function buildRoleMenuItems(name: string, actions: RoleMenuActions): MenuItemConfig[] {
    return [
        // "Show data" mirrors the double-click: show the role and open its grants
        // tab. Glyphs match the grants tab and the export formats.
        { text: "Show data", glyph: "key", action: () => actions.showRole(name) },
        { separator: true },
        { text: "Show membership graph", glyph: "diagram-project", action: () => actions.openMembershipDiagram(name) },
        { text: "Show grants graph", glyph: "diagram-project", action: () => actions.openGrantsDiagram(name) },
        { separator: true },
        { text: "Export grants", glyph: "file-export", submenu: { label: "Export grants",
            items: buildTableExportItems(format => actions.exportGrants(name, format)) } },
    ];
}
