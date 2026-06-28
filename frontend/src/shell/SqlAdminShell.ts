// The app shell: a Border-laid Panel with the four regions — MenuBar (NORTH),
// the activity bar (WEST), the Dock work area (CENTER), and the StatusBar
// (SOUTH). The Dock and StatusBar are owned by the controller; the shell only
// arranges them. The activity bar manages its own collapse (the rail stays
// visible, only its deck hides), so the WEST region is not Border-collapsible.
//
// Built as a callable factory (not `extends Panel`): subclassing the callable
// Panel export type-checks against the library source but not against its built
// .d.ts (the callable constructor type drops instance methods for external
// consumers). See LIBRARY_NOTES.md.

import { Component, Panel } from "@jimka/typescript-ui/core";
import { Placement } from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout } from "@jimka/typescript-ui/layout";
import { MenuBar } from "@jimka/typescript-ui/component/menubar";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { database } from "@jimka/typescript-ui/glyphs/solid/database";
import { circle_info } from "@jimka/typescript-ui/glyphs/solid/circle_info";
import { ActivityBar } from "./ActivityBar";
import { DatabaseExplorerView } from "./DatabaseExplorerView";
import type { SqlAdminController } from "../SqlAdminController";

// Glyphs used across the sidebar subtree: a database for the Database view (rail
// button + navigator section), an info circle for the Properties section. Registered
// once here, the composition root, and referenced by name downstream.
Glyph.register(database, circle_info);

// The single Phase-1 view container's id (its rail button selects it by this).
const DATABASE_VIEW_ID = "database";

/** Build the shell Panel, hosting the controller's Dock and StatusBar. */
export function SqlAdminShell(controller: SqlAdminController): Panel {
    const shell = Panel({ layoutManager: new BorderLayout() });

    shell.addComponent(buildMenuBar(), { placement: Placement.NORTH });
    shell.addComponent(buildSidebar(controller), { placement: Placement.WEST });
    shell.addComponent(controller.dock, { placement: Placement.CENTER });
    shell.addComponent(controller.statusBar, { placement: Placement.SOUTH });

    return shell;
}

/** File / View / Tools menus (items stubbed/disabled until their features land). */
function buildMenuBar(): MenuBar {
    const bar = new MenuBar();

    bar.setMenus([
        { label: "File", items: [{ text: "Close Tab", enabled: false }, { separator: true }, { text: "Exit", enabled: false }] },
        { label: "View", items: [{ text: "Toggle Sidebar", enabled: false }] },
        { label: "Tools", items: [{ text: "Run SQL…", enabled: false }] },
    ]);

    return bar;
}

/**
 * WEST sidebar: a VSCode-style activity bar whose icon rail toggles its deck.
 * Phase 1 ships one view — the Database explorer (navigator + properties
 * accordion) — which is also the documented Phase-2 seam (one more rail button +
 * one more deck page adds a view).
 */
function buildSidebar(controller: SqlAdminController): Component {
    const explorer = DatabaseExplorerView(controller, DATABASE_VIEW_ID);

    return ActivityBar([
        { id: DATABASE_VIEW_ID, label: "Database", glyph: "database", component: explorer },
    ]);
}
