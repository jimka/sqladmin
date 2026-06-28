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
import { Border as BorderLayout } from "@jimka/typescript-ui/layout";
import { MenuBar } from "@jimka/typescript-ui/component/menubar";
import { AccordionPanel } from "@jimka/typescript-ui/component/container";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { database } from "@jimka/typescript-ui/glyphs/solid/database";
import { circle_info } from "@jimka/typescript-ui/glyphs/solid/circle_info";
import { NavigatorTree } from "../navigator/NavigatorTree";
import type { SqlAdminController } from "../SqlAdminController";

// Accordion section-header glyphs: a database for the object navigator, an info
// circle for the metadata inspector.
Glyph.register(database, circle_info);

// Sidebar width until the activity-bar rail replaces it.
const SIDEBAR_WIDTH = 240;

// A preferred height large enough to always overflow the sidebar, so the
// accordion's shrink hands the navigator section all the space the fixed-height
// Properties section leaves — i.e. the navigator fills, Properties stays compact.
const NAV_FILL_HINT = 10000;

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

/**
 * WEST sidebar: a compact Accordion of two collapsible sections, fixed to the
 * sidebar width — the lazy object navigator on top, the Properties inspector
 * below it. The navigator carries an outsized preferred height so the accordion's
 * shrink gives it every pixel the fixed-height Properties section leaves, letting
 * the navigator fill while Properties stays compact. The inspector tracks the
 * navigator selection; the controller owns and updates it.
 */
function buildSidebar(controller: SqlAdminController): Component {
    const navigator = NavigatorTree(controller);

    navigator.setPreferredSize(0, NAV_FILL_HINT);

    const sidebar = new AccordionPanel({
        sections: [
            { label: "Navigator", component: navigator, initiallyOpen: true, glyph: "database" },
            { label: "Properties", component: controller.properties.component, initiallyOpen: true, glyph: "circle-info" },
        ],
    });

    sidebar.getAccordion().setCompact(true);
    sidebar.setPreferredSize(SIDEBAR_WIDTH, 0);

    return sidebar;
}
