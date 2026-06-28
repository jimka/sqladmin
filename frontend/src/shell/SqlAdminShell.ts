// The app shell: a Border-laid Panel with the four regions — MenuBar (NORTH),
// the explorer sidebar (WEST, collapsible), the Dock work area (CENTER), and the
// StatusBar (SOUTH). The Dock and StatusBar are owned by the controller; the
// shell only arranges them. The WEST region is a placeholder until the activity
// bar + navigator land next.
//
// Built as a callable factory (not `extends Panel`): subclassing the callable
// Panel export type-checks against the library source but not against its built
// .d.ts (the callable constructor type drops instance methods for external
// consumers). See LIBRARY_NOTES.md.

import { Component, Panel } from "@jimka/typescript-ui/core";
import { Placement } from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit } from "@jimka/typescript-ui/layout";
import { MenuBar } from "@jimka/typescript-ui/component/menubar";
import { NavigatorTree } from "../navigator/NavigatorTree";
import type { SqlAdminController } from "../SqlAdminController";

// Sidebar width until the activity-bar rail + Accordion explorer replace it.
const SIDEBAR_WIDTH = 240;

/** Build the shell Panel, hosting the controller's Dock and StatusBar. */
export function SqlAdminShell(controller: SqlAdminController): Panel {
    const shell = Panel({ layoutManager: new BorderLayout() });

    shell.addComponent(buildMenuBar(), { placement: Placement.NORTH });
    shell.addComponent(buildSidebar(controller), { placement: Placement.WEST, collapsible: true });
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

/** WEST sidebar: the lazy object navigator, fixed to the sidebar width. */
function buildSidebar(controller: SqlAdminController): Component {
    const sidebar = Panel({
        layoutManager: new Fit(),
        components: [NavigatorTree(controller)],
    });

    sidebar.setPreferredSize(SIDEBAR_WIDTH, 0);

    return sidebar;
}
