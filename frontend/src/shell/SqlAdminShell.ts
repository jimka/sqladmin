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
import { Border as BorderLayout, Split, Card } from "@jimka/typescript-ui/layout";
import { MenuBar }                 from "@jimka/typescript-ui/component/menubar";
import { Glyph }                   from "@jimka/typescript-ui/component/display";
import { database }                from "@jimka/typescript-ui/glyphs/solid/database";
import { circle_info }             from "@jimka/typescript-ui/glyphs/solid/circle_info";
import { users }                   from "@jimka/typescript-ui/glyphs/solid/users";
import { terminal }                from "@jimka/typescript-ui/glyphs/solid/terminal";
import { arrows_rotate }           from "@jimka/typescript-ui/glyphs/solid/arrows_rotate";
import { ActivityBar, SIDEBAR_RAIL_WIDTH, SIDEBAR_DEFAULT_WIDTH } from "./ActivityBar";
import type { ActivityBarHandle, SidebarSizer } from "./ActivityBar";
import { DatabaseExplorerView }    from "./DatabaseExplorerView";
import { RolesExplorerView }       from "./RolesExplorerView";
import { QueriesView }             from "./QueriesView";
import { StartPage }               from "./StartPage";
import {
    NEW_QUERY_SHORTCUT, OPEN_SAVED_SHORTCUT, QUERY_HISTORY_SHORTCUT,
    isNewQueryChord, isOpenSavedChord, isQueryHistoryChord,
} from "./queryShortcuts";
import type { SqlAdminController } from "../SqlAdminController";

// Glyphs used across the sidebar subtree: a database for the Database view (rail
// button + navigator section), an info circle for the Properties/Details sections,
// and a people icon for the Roles view (rail button + roles section), plus a
// rotate icon for the section refresh tools. Registered once here, the
// composition root, and referenced by name downstream.
Glyph.register(database, circle_info, users, terminal, arrows_rotate);

// The view-container ids; each view's rail button selects it by this id.
const DATABASE_VIEW_ID = "database";
const ROLES_VIEW_ID    = "roles";
const QUERIES_VIEW_ID  = "queries";

// The CENTER Card-deck page ids: the Dock work area, and the start page shown
// when no panels are open (only one is ever visible at a time).
const CENTER_DOCK_ID  = "work-dock";
const CENTER_START_ID = "work-start";

/** Build the shell Panel, hosting the controller's Dock and StatusBar. */
export function SqlAdminShell(controller: SqlAdminController): Panel {
    const sidebar  = buildSidebar(controller);
    const workArea = buildWorkArea(sidebar, controller);

    // The menu's "Open Saved…"/"Query History…" entry points route through the
    // controller; give it the shell-owned selector for the Queries view. The
    // New-Query menu shortcut is a display hint only (MenuItem.ts), so install
    // the real Alt+N accelerator as a document keydown listener.
    controller.setShowQueriesView(() => sidebar.selectView(QUERIES_VIEW_ID));
    installQueryAccelerators(controller);

    return Panel({
        layoutManager: new BorderLayout(),
        components: [
            { component: buildMenuBar({
                onToggleSidebar: sidebar.toggleCollapsed,
                onNewQuery     : () => controller.openQuery(),
                onOpenSaved    : () => controller.showQueriesView("saved"),
                onQueryHistory : () => controller.showQueriesView("recent"),
                onExportResults: format => controller.exportActive(format),
            }), constraints: { placement: Placement.NORTH } },
            { component: workArea,             constraints: { placement: Placement.CENTER } },
            { component: controller.statusBar, constraints: { placement: Placement.SOUTH } },
        ],
    });
}

/**
 * Install the global query accelerators. The library renders a menu shortcut as
 * a label but does not bind it, so each chord is wired as a real keydown
 * accelerator: Alt+N opens a new query, Alt+S jumps to the Saved list, Alt+H
 * jumps to the history list.
 *
 * Registered on `window` in the CAPTURE phase: the library's Event dispatcher is
 * a window-capture handler that calls `stopPropagation()` for any focused target
 * that has its own listeners (a focused List, the editor, …), which would stop a
 * document bubble-phase accelerator from ever seeing the key. A same-node
 * capture listener fires regardless (LIBRARY_NOTES.md).
 *
 * @param controller - The mediator the chords drive.
 */
function installQueryAccelerators(controller: SqlAdminController): void {
    window.addEventListener("keydown", (event: KeyboardEvent) => {
        if (isNewQueryChord(event)) {
            event.preventDefault();
            controller.openQuery();
        } else if (isOpenSavedChord(event)) {
            event.preventDefault();
            controller.showQueriesView("saved");
        } else if (isQueryHistoryChord(event)) {
            event.preventDefault();
            controller.showQueriesView("recent");
        }
    }, true);
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
function buildWorkArea(sidebar: ActivityBarHandle, controller: SqlAdminController): Component {
    const split  = new Split({ orientation: "horizontal" });
    const body   = Panel({ layoutManager: split });
    const pane   = sidebar.component;
    const center = buildCenterDeck(controller);

    // collapsible: false suppresses the gutter's native collapse chevron and
    // double-click — the sidebar collapses only through the rail icon / menu (to
    // the rail width, not the Split's collapse-to-strip) — while the gutter stays
    // draggable for resize. The single gutter serves the leading (sidebar) pane,
    // so opting it out is what removes the chevron.
    body.addComponent(pane, { weight: 0, collapsible: false });
    body.addComponent(center, { weight: 1 });

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
            // sidebar here and lets the weighted work area reclaim the freed width.
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
            const total = (split.getPaneSize(pane) ?? lastWidth) + (split.getPaneSize(center) ?? 0);
            split.setPaneSize(pane, lastWidth);
            split.setPaneSize(center, Math.max(0, total - lastWidth));
            body.doLayout();
        },
    };

    sidebar.setSizer(sizer);

    return body;
}

/**
 * The CENTER Card deck: the Dock work area and the empty-workspace start page,
 * one visible at a time. The Dock exposes no emptyContent hook or "became empty"
 * event (see StartPage / the plan's Dock investigation), so the controller
 * tracks an open-panel count and drives this deck through the injected toggle —
 * mirroring how the ActivityBar takes a SidebarSizer.
 *
 * @param controller - The mediator owning the Dock and the panel count.
 *
 * @returns The deck component to place in the work area's CENTER pane.
 */
function buildCenterDeck(controller: SqlAdminController): Component {
    const card = new Card();
    const deck = Panel({ layoutManager: card });

    // Each deck page needs an id the Card matches on.
    controller.dock.setId(CENTER_DOCK_ID);

    const start = StartPage(controller);
    start.setId(CENTER_START_ID);

    deck.addComponent(controller.dock);
    deck.addComponent(start);
    card.setVisibleComponentId(CENTER_DOCK_ID);

    // The controller reflects the current emptiness immediately on registration,
    // so the start page shows at once for the initially empty workspace.
    controller.setStartToggle((visible: boolean): void => {
        card.setVisibleComponentId(visible ? CENTER_START_ID : CENTER_DOCK_ID);
    });

    return deck;
}

/** The menu-bar action callbacks the shell wires to the controller and sidebar. */
interface MenuBarActions {
    /** Collapses/expands the activity bar (View → Toggle Sidebar). */
    onToggleSidebar: () => void;
    /** Opens a fresh query panel (Query → New Query, and the Alt+N accelerator). */
    onNewQuery: () => void;
    /** Selects the Queries view's Saved section (Query → Open Saved…). */
    onOpenSaved: () => void;
    /** Selects the Queries view's Recent section (Query → Query History…). */
    onQueryHistory: () => void;
    /** Exports the active work tab's data (Tools → Export results ▸ CSV/JSON). */
    onExportResults: (format: "csv" | "json") => void;
}

/**
 * The Query, Tools, and View menus. Query holds New Query (the Alt+N accelerator
 * is a real listener; the shortcut here is only a display hint) and the saved and
 * history entry points into the Queries view. Tools holds Export results, which
 * acts on the active work tab's data. View → Toggle Sidebar drives the activity
 * bar's collapse.
 *
 * @param actions - The menu action callbacks.
 *
 * @returns The composed menu bar.
 */
function buildMenuBar(actions: MenuBarActions): MenuBar {
    return MenuBar({
        menus: [
            { label: "Query", items: [
                { text: "New Query", shortcut: NEW_QUERY_SHORTCUT, action: actions.onNewQuery },
                { separator: true },
                { text: "Open Saved…",    shortcut: OPEN_SAVED_SHORTCUT,    action: actions.onOpenSaved },
                { text: "Query History…", shortcut: QUERY_HISTORY_SHORTCUT, action: actions.onQueryHistory },
            ] },
            { label: "Tools", items: [
                // Exports the active work tab's data — a query result, a table/view's
                // rows, or a role's grants. Each tab's own toolbar button is the
                // primary surface; this acts on whichever tab is focused.
                { text: "Export results…", submenu: { label: "Export results…", items: [
                    { text: "CSV",  action: () => actions.onExportResults("csv") },
                    { text: "JSON", action: () => actions.onExportResults("json") },
                ] } },
            ] },
            { label: "View", items: [{ text: "Toggle Sidebar", action: actions.onToggleSidebar }] },
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
    const queries  = QueriesView(controller, QUERIES_VIEW_ID);

    return ActivityBar([
        { id: DATABASE_VIEW_ID, label: "Database", glyph: "database", component: explorer },
        { id: ROLES_VIEW_ID,    label: "Roles",    glyph: "users",    component: roles },
        { id: QUERIES_VIEW_ID,  label: "Queries",  glyph: "terminal", component: queries },
    ]);
}
