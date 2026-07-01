// The app shell: a Border-laid Panel with MenuBar (NORTH), the StatusBar
// (SOUTH), and a horizontal Split (CENTER) holding the activity bar beside the
// Dock work area. The Dock and StatusBar are owned by the controller; the shell
// only arranges them. The sidebar seeds at its natural width and stays fixed on
// viewport resize (weight 0) while the Dock absorbs the slack (weight 1); the
// gutter between them is user-drag-resizable. Collapse runs through the Split:
// the shell injects a SidebarSizer into the activity bar that pins the sidebar
// pane to the rail width (min == max) to collapse and restores a draggable width
// to expand — the Split ignores a pane's preferred size after its one-time seed,
// so preferred can no longer drive collapse.
//
// Built as a callable factory (not `extends Panel`): subclassing the callable
// Panel export type-checks against the library source but not against its built
// .d.ts (the callable constructor type drops instance methods for external
// consumers). See LIBRARY_NOTES.md.

import { Panel, Component }        from "@jimka/typescript-ui/core";
import { Placement, UNBOUNDED }    from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Split } from "@jimka/typescript-ui/layout";
import { MenuBar }                 from "@jimka/typescript-ui/component/menubar";
import { Glyph }                   from "@jimka/typescript-ui/component/display";
import { database }                from "@jimka/typescript-ui/glyphs/solid/database";
import { circle_info }             from "@jimka/typescript-ui/glyphs/solid/circle_info";
import { users }                   from "@jimka/typescript-ui/glyphs/solid/users";
import { arrows_rotate }           from "@jimka/typescript-ui/glyphs/solid/arrows_rotate";
import { ActivityBar, SIDEBAR_RAIL_WIDTH, SIDEBAR_DEFAULT_WIDTH } from "./ActivityBar";
import type { ActivityBarHandle, SidebarSizer } from "./ActivityBar";
import { DatabaseExplorerView }    from "./DatabaseExplorerView";
import { RolesExplorerView }       from "./RolesExplorerView";
import type { SqlAdminController } from "../SqlAdminController";

// Glyphs used across the sidebar subtree: a database for the Database view (rail
// button + navigator section), an info circle for the Properties/Details sections,
// and a people icon for the Roles view (rail button + roles section), plus a
// rotate icon for the section refresh tools. Registered once here, the
// composition root, and referenced by name downstream.
Glyph.register(database, circle_info, users, arrows_rotate);

// The view-container ids; each view's rail button selects it by this id.
const DATABASE_VIEW_ID = "database";
const ROLES_VIEW_ID    = "roles";

/** Build the shell Panel, hosting the controller's Dock and StatusBar. */
export function SqlAdminShell(controller: SqlAdminController): Panel {
    const sidebar  = buildSidebar(controller);
    const workArea = buildWorkArea(sidebar, controller.dock);

    return Panel({
        layoutManager: new BorderLayout(),
        components: [
            { component: buildMenuBar(sidebar.toggleCollapsed, () => controller.openQuery()), constraints: { placement: Placement.NORTH } },
            { component: workArea,             constraints: { placement: Placement.CENTER } },
            { component: controller.statusBar, constraints: { placement: Placement.SOUTH } },
        ],
    });
}

/**
 * The CENTER work area: a horizontal Split with the activity bar (left) beside
 * the Dock (right). The sidebar pane takes weight 0 (fixed on viewport resize,
 * seeded at its natural width via its preferred size); the Dock MUST take a
 * positive weight so it is the absorber — a bare, unweighted Dock would report no
 * preferred size and steal the sidebar's seed back toward an equal split. A
 * SidebarSizer is wired into the bar so its collapse/expand drives the pane's
 * width through the Split's live min/max instead of a (now-ignored) preferred.
 */
function buildWorkArea(sidebar: ActivityBarHandle, dock: Component): Component {
    const split = new Split({ orientation: "horizontal" });
    const body  = Panel({ layoutManager: split });
    const pane  = sidebar.component;

    // collapsible: false suppresses the gutter's native collapse chevron and
    // double-click — the sidebar collapses only through the rail icon / menu (to
    // the rail width, not the Split's collapse-to-strip) — while the gutter stays
    // draggable for resize. The single gutter serves the leading (sidebar) pane,
    // so opting it out is what removes the chevron.
    body.addComponent(pane, { weight: 0, collapsible: false });
    body.addComponent(dock, { weight: 1 });

    // A rail-width floor so a gutter drag can't shrink the sidebar below the rail
    // (max stays unbounded, so it is draggable, not pinned — pinning is collapse).
    pane.setMinSize(SIDEBAR_RAIL_WIDTH, 0);

    // The width to reopen to on expand: the user's last dragged width, else the
    // natural default. Session-scoped closure state, not persisted across reloads.
    let lastWidth = SIDEBAR_DEFAULT_WIDTH;

    const sizer: SidebarSizer = {
        collapse(): void {
            // Capture the live (possibly dragged) width before the pin overwrites
            // the stored pane size, so expand can restore it.
            const current = split.getPaneSize(pane);
            if (current !== undefined && current > SIDEBAR_RAIL_WIDTH) {
                lastWidth = current;
            }

            // Pin the pane to the rail width (min == max). The constraint change
            // reschedules the Split's layout, whose pin-aware refill holds the
            // sidebar here and lets the weighted Dock reclaim the freed width.
            pane.setMinSize(SIDEBAR_RAIL_WIDTH, 0);
            pane.setMaxSize(SIDEBAR_RAIL_WIDTH, UNBOUNDED);
        },
        expand(): void {
            // Unpin (max unbounded → draggable again), keep the rail floor.
            pane.setMaxSize(UNBOUNDED, UNBOUNDED);
            pane.setMinSize(SIDEBAR_RAIL_WIDTH, 0);

            // Reopen to the remembered width and hand the remainder back to the
            // Dock. Both panes are flexible once expanded, so the Split reconciles
            // any Σ ≠ available by scaling the flexible panes *proportionally* —
            // and collapse inflated the Dock to fill the freed space. Setting only
            // the sidebar would leave Σ overshooting, and the proportional refill
            // would shrink the sidebar below lastWidth (compounding on every
            // collapse/expand cycle). Set the Dock explicitly to
            // available − lastWidth so the sum stays exact and the sidebar lands
            // precisely at lastWidth. The two stored sizes always sum to the
            // available extent (the refill's Σ invariant), collapsed or not, so
            // their current total is a reliable stand-in for it.
            const total = (split.getPaneSize(pane) ?? lastWidth) + (split.getPaneSize(dock) ?? 0);
            split.setPaneSize(pane, lastWidth);
            split.setPaneSize(dock, Math.max(0, total - lastWidth));
            body.doLayout();
        },
    };

    sidebar.setSizer(sizer);

    return body;
}

/**
 * File / View / Tools menus. View → Toggle Sidebar drives the activity bar's
 * collapse; the remaining items are stubbed/disabled until their features land.
 *
 * @param onToggleSidebar - Collapses/expands the activity bar.
 * @param onRunSql - Opens a new SQL query panel in the Dock.
 */
function buildMenuBar(onToggleSidebar: () => void, onRunSql: () => void): MenuBar {
    return MenuBar({
        menus: [
            { label: "File", items: [{ text: "Close Tab", enabled: false }, { separator: true }, { text: "Exit", enabled: false }] },
            { label: "View", items: [{ text: "Toggle Sidebar", action: onToggleSidebar }] },
            { label: "Tools", items: [{ text: "Run SQL…", action: onRunSql }] },
        ],
    });
}

/**
 * WEST sidebar: a VSCode-style activity bar whose icon rail toggles its deck.
 * Phase 1 ships one view — the Database explorer (navigator + properties
 * accordion) — which is also the documented Phase-2 seam (one more rail button +
 * one more deck page adds a view).
 */
function buildSidebar(controller: SqlAdminController): ActivityBarHandle {
    const explorer = DatabaseExplorerView(controller, DATABASE_VIEW_ID);
    const roles    = RolesExplorerView(controller, ROLES_VIEW_ID);

    return ActivityBar([
        { id: DATABASE_VIEW_ID, label: "Database", glyph: "database", component: explorer },
        { id: ROLES_VIEW_ID,    label: "Roles",    glyph: "users",    component: roles },
    ]);
}
