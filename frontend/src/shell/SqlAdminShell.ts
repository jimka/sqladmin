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
// Built as a callable factory (not `extends Panel`) for now: subclassing a
// library base is fully supported today (the .d.ts's unresolved `~/*` aliases
// were fixed with a post-emit `tsc-alias` pass — see LIBRARY_NOTES.md,
// "External consumers couldn't subclass a library class"). The shell staying
// a factory is a not-yet-migrated holdover, not a constraint — ActivityBar
// and TableWorkPanel are the class-first precedent (COMPONENT_CONVENTIONS.md).

import { Component, Container }        from "@jimka/typescript-ui/core";
import { Placement, UNBOUNDED }    from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Split, Card } from "@jimka/typescript-ui/layout";
import { MenuBar }                 from "@jimka/typescript-ui/component/menubar";
import { Button }                  from "@jimka/typescript-ui/component/button";
import { Spacer }                  from "@jimka/typescript-ui/component/container";
import { Glyph }                   from "@jimka/typescript-ui/component/display";
import { database }                from "@jimka/typescript-ui/glyphs/solid/database";
import { circle_info }             from "@jimka/typescript-ui/glyphs/solid/circle_info";
import { users }                   from "@jimka/typescript-ui/glyphs/solid/users";
import { terminal }                from "@jimka/typescript-ui/glyphs/solid/terminal";
import { arrows_rotate }           from "@jimka/typescript-ui/glyphs/solid/arrows_rotate";
import { plus }                    from "@jimka/typescript-ui/glyphs/solid/plus";
import { floppy_disk }             from "@jimka/typescript-ui/glyphs/solid/floppy_disk";
import { clock_rotate_left }       from "@jimka/typescript-ui/glyphs/solid/clock_rotate_left";
import { wrench }                  from "@jimka/typescript-ui/glyphs/solid/wrench";
import { eye }                     from "@jimka/typescript-ui/glyphs/solid/eye";
import { file_export }             from "@jimka/typescript-ui/glyphs/solid/file_export";
import { file_lines }              from "@jimka/typescript-ui/glyphs/solid/file_lines";
import { file_csv }                from "@jimka/typescript-ui/glyphs/solid/file_csv";
import { file_code }               from "@jimka/typescript-ui/glyphs/solid/file_code";
import { bars }                    from "@jimka/typescript-ui/glyphs/solid/bars";
import { keyboard }                from "@jimka/typescript-ui/glyphs/solid/keyboard";
import { right_from_bracket }      from "@jimka/typescript-ui/glyphs/solid/right_from_bracket";
import { ActivityBar, SIDEBAR_RAIL_WIDTH, SIDEBAR_DEFAULT_WIDTH } from "./ActivityBar";
import type { SidebarSizer } from "./ActivityBar";
import { DatabaseExplorerView }    from "./DatabaseExplorerView";
import { RolesExplorerView }       from "./RolesExplorerView";
import { QueriesView }             from "./QueriesView";
import { StartPage }               from "./StartPage";
import {
    NEW_QUERY_SHORTCUT, OPEN_SAVED_SHORTCUT, QUERY_HISTORY_SHORTCUT,
    DATABASES_RAIL_SHORTCUT, ROLES_RAIL_SHORTCUT, QUERIES_RAIL_SHORTCUT, REFRESH_SHORTCUT,
    isNewQueryChord, isOpenSavedChord, isQueryHistoryChord,
    isDatabasesRailChord, isRolesRailChord, isQueriesRailChord, isRefreshChord,
    isHelpChord,
} from "./queryShortcuts";
import { openAboutDialog }         from "./aboutDialog";
import { logout }                  from "../data/api";
import { openShortcutsDialog }     from "./shortcutsDialog";
import { openLocalStorageWindow }  from "./localStorageWindow";
import type { SqlAdminController } from "../SqlAdminController";

// Glyphs used across the sidebar subtree: a database for the Database view (rail
// button + navigator section), an info circle for the Properties/Details sections,
// and a people icon for the Roles view (rail button + roles section), plus a
// rotate icon for the section refresh tools. Registered once here, the
// composition root, and referenced by name downstream.
Glyph.register(database, circle_info, users, terminal, arrows_rotate);
// Glyphs decorating the menu bar's menus, items, and submenus.
Glyph.register(plus, floppy_disk, clock_rotate_left, wrench, eye, file_export, file_lines, file_csv, file_code, bars, keyboard, right_from_bracket);

// The view-container ids; each view's rail button selects it by this id.
const DATABASE_VIEW_ID = "database";
const ROLES_VIEW_ID    = "roles";
const QUERIES_VIEW_ID  = "queries";

// The CENTER Card-deck page ids: the Dock work area, and the start page shown
// when no panels are open (only one is ever visible at a time).
const CENTER_DOCK_ID  = "work-dock";
const CENTER_START_ID = "work-start";

/** Build the shell container, hosting the controller's Dock and StatusBar. */
export function SqlAdminShell(controller: SqlAdminController): Container {
    // Signs out: drops the server-side session and reloads to the login dialog.
    // Wired to the rail's bottom-pinned sign-out button (buildSidebar).
    const onLogout = (): void => { void logout().then(() => window.location.reload()); };

    const sidebar  = buildSidebar(controller, onLogout);
    const workArea = buildWorkArea(sidebar, controller);

    // The menu's "Open Saved…"/"Query History…" entry points route through the
    // controller; give it the shell-owned selector for the Queries view. The
    // New-Query menu shortcut is a display hint only (MenuItem.ts), so install
    // the real Alt+N accelerator as a document keydown listener.
    controller.setShowQueriesView(() => sidebar.selectView(QUERIES_VIEW_ID));
    installAccelerators(controller, sidebar);

    return Container({
        layoutManager: new BorderLayout({ spacing: 0 }),
        components: [
            {
                component: buildMenuBar({
                    onToggleSidebar    : sidebar.toggleCollapsed,
                    onNewQuery         : () => controller.openQuery(),
                    onOpenSaved        : () => controller.showQueriesView("saved"),
                    onQueryHistory     : () => controller.showQueriesView("recent"),
                    onExportResults    : format => controller.exportActive(format),
                    activeExportKind   : () => controller.activeExportKind(),
                    canExportActive    : () => controller.canExportActive(),
                    onOpenDocumentation: () => controller.openDocumentation(),
                    onShowLocalStorage : () => openLocalStorageWindow(),
                    onShowShortcuts    : () => openShortcutsDialog(),
                    onAbout            : () => openAboutDialog(),
                    onShowDatabases    : () => sidebar.selectView(DATABASE_VIEW_ID),
                    onShowRoles        : () => sidebar.selectView(ROLES_VIEW_ID),
                    onShowQueries      : () => sidebar.selectView(QUERIES_VIEW_ID),
                    onRefresh          : () => controller.refreshActive(),
                }), 
                constraints      : { placement: Placement.NORTH }
            },
            { component: workArea,             constraints: { placement: Placement.CENTER } },
            { component: controller.statusBar, constraints: { placement: Placement.SOUTH } },
        ],
    });
}

/**
 * Install the global accelerators. The library renders a menu shortcut as a
 * label but does not bind it, so each chord is wired as a real keydown
 * accelerator: Alt+N opens a new query, Alt+S/Alt+H jump to the Saved / history
 * lists; Alt+D/Alt+O/Alt+Q open the Databases / Roles / Queries rails; Alt+R
 * refreshes the active view. (Explain / Explain-Analyze — Ctrl+E / Ctrl+Shift+E
 * — are editor-scoped and bound inside QueryPanel, not here.)
 *
 * A plain `document` keydown accelerator (bubble phase): the library's Event
 * dispatcher no longer stops propagation unless a focused component actually
 * consumes the key, so an unhandled chord bubbles up to this listener even while
 * a List / the editor / a Tree is focused (LIBRARY_NOTES.md).
 *
 * @param controller - The mediator the query/refresh chords drive.
 * @param sidebar - The activity bar the rail chords switch views on.
 */
function installAccelerators(controller: SqlAdminController, sidebar: ActivityBar): void {
    document.addEventListener("keydown", (event: KeyboardEvent) => {
        let matched = true;

        if (isNewQueryChord(event)) {
            controller.openQuery();
        } else if (isOpenSavedChord(event)) {
            controller.showQueriesView("saved");
        } else if (isQueryHistoryChord(event)) {
            controller.showQueriesView("recent");
        } else if (isDatabasesRailChord(event)) {
            sidebar.selectView(DATABASE_VIEW_ID);
        } else if (isRolesRailChord(event)) {
            sidebar.selectView(ROLES_VIEW_ID);
        } else if (isQueriesRailChord(event)) {
            sidebar.selectView(QUERIES_VIEW_ID);
        } else if (isRefreshChord(event)) {
            controller.refreshActive();
        } else if (isHelpChord(event)) {
            openShortcutsDialog();
        } else {
            matched = false;
        }

        // Only swallow the browser default for a chord we actually handled;
        // otherwise every other key (Ctrl+F/Ctrl+P, Tab traversal, Space-scroll)
        // reaching document would have its default suppressed.
        if (matched) {
            event.preventDefault();
        }
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
function buildWorkArea(sidebar: ActivityBar, controller: SqlAdminController): Component {
    const split  = new Split({ orientation: "horizontal" });
    const body   = Container({ layoutManager: split });
    const pane   = sidebar;
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
    const deck = Container({ layoutManager: card });

    // Each deck page needs an id the Card matches on.
    controller.dock.setId(CENTER_DOCK_ID);

    // Pass the deck id into the constructor rather than a later setId: the start
    // page's autoScroll registers its eased wheel-scroll listener under the id at
    // construction, and setId does not re-register it (see StartPage), so a late
    // setId would leave the page scrolling natively instead of smoothly.
    const start = new StartPage(controller, CENTER_START_ID);

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
    /** The active tab's export family, so the submenu can label its items live. */
    activeExportKind: () => "plan" | "tabular";
    /** Whether the active tab has anything to export, to grey the item when not. */
    canExportActive: () => boolean;
    /** Opens (or focuses) the documentation/notes tab (Tools → Notes…). */
    onOpenDocumentation: () => void;
    /** Opens the localStorage inspector window (Tools → Show localStorage…). */
    onShowLocalStorage: () => void;
    /** Opens the Keyboard Shortcuts dialog (the menu-bar button beside About, and the ? accelerator). */
    onShowShortcuts: () => void;
    /** Opens the About dialog (the far-right menu-bar button). */
    onAbout: () => void;
    /** Selects the Databases rail (View → Databases, and the Alt+D accelerator). */
    onShowDatabases: () => void;
    /** Selects the Roles rail (View → Roles, and the Alt+O accelerator). */
    onShowRoles: () => void;
    /** Selects the Queries rail (View → Queries, and the Alt+Q accelerator). */
    onShowQueries: () => void;
    /** Refreshes the active view (View → Refresh, and the Alt+R accelerator). */
    onRefresh: () => void;
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
    const menuBar = MenuBar({
        menus: [
            { label: "Query", glyph: "terminal", items: [
                { text: "New Query", glyph: "plus", shortcut: NEW_QUERY_SHORTCUT, action: actions.onNewQuery },
                { separator: true },
                { text: "Open Saved…",    glyph: "floppy-disk",       shortcut: OPEN_SAVED_SHORTCUT,    action: actions.onOpenSaved },
                { text: "Query History…", glyph: "clock-rotate-left", shortcut: QUERY_HISTORY_SHORTCUT, action: actions.onQueryHistory },
            ] },
            { label: "Tools", glyph: "wrench", items: () => [
                // Exports the active work tab's data — a query result, a table/view's
                // rows, a role's grants, or a shown EXPLAIN plan. Each tab's own
                // toolbar button is the primary surface; this acts on whichever tab
                // is focused. Both this list and the submenu are providers, re-run
                // each time their menu opens: the item greys out when the focused
                // tab has nothing to export, and the submenu labels track its kind
                // (a plan shows text / JSON, everything else CSV / JSON).
                { text: "Export results…", glyph: "file-export", enabled: actions.canExportActive(),
                  submenu: { label: "Export results…", items: () => {
                    const plan = actions.activeExportKind() === "plan";

                    return [
                        // First slot: plain-text plan (file-lines) vs. CSV (file-csv);
                        // second is JSON (file-code) either way. Glyphs match every
                        // other export menu across the app.
                        { text: plan ? "Text (.txt)" : "CSV (.csv)", glyph: plan ? "file-lines" : "file-csv", action: () => actions.onExportResults("csv") },
                        { text: "JSON (.json)",                      glyph: "file-code",                     action: () => actions.onExportResults("json") },
                    ];
                } } },
                { separator: true },
                { text: "Notes…", glyph: "file-lines", action: actions.onOpenDocumentation },
                // Opens the localStorage inspector window (view + clear stored state).
                { text: "Show localStorage…", glyph: "database", action: actions.onShowLocalStorage },
            ] },
            // The rail switches and Refresh mirror the Alt+D/O/Q and Alt+R
            // accelerators; the shortcut labels are display hints (the real keys
            // are the document-level accelerators — installAccelerators).
            { label: "View", glyph: "eye", items: [
                { text: "Databases", glyph: "database", shortcut: DATABASES_RAIL_SHORTCUT, action: actions.onShowDatabases },
                { text: "Roles",     glyph: "users",    shortcut: ROLES_RAIL_SHORTCUT,     action: actions.onShowRoles },
                { text: "Queries",   glyph: "terminal", shortcut: QUERIES_RAIL_SHORTCUT,   action: actions.onShowQueries },
                { separator: true },
                { text: "Refresh", glyph: "arrows-rotate", shortcut: REFRESH_SHORTCUT, action: actions.onRefresh },
                { separator: true },
                { text: "Toggle Sidebar", glyph: "bars", action: actions.onToggleSidebar },
            ] },
        ],
    });

    // Pin an About button to the far right of the menu bar: a flex spacer eats
    // the gap between the left-aligned menus and the button, so it sits at the
    // trailing edge. Appended after the factory (not via `menus`, which are
    // dropdown openers) — safe because the app builds its menus once and never
    // re-calls setMenus (which would wipe these appended children).
    const shortcuts = Button({ glyph: "keyboard", text: "Shortcuts", showText: true, showDescription: false, compact: true, flat: true });
    shortcuts.on("action", actions.onShowShortcuts);

    const about = Button({ glyph: "circle-info", text: "About", showText: true, showDescription: false, compact: true, flat: true });
    about.on("action", actions.onAbout);

    menuBar.addComponent(Spacer.flex());
    menuBar.addComponent(shortcuts);
    menuBar.addComponent(about);

    return menuBar;
}

/**
 * WEST sidebar: a VSCode-style activity bar whose icon rail toggles its deck.
 * Phase 1 ships one view — the Database explorer (navigator + properties
 * accordion) — which is also the documented Phase-2 seam (one more rail button +
 * one more deck page adds a view).
 */
function buildSidebar(controller: SqlAdminController, onLogout: () => void): ActivityBar {
    const explorer = new DatabaseExplorerView(controller, DATABASE_VIEW_ID);
    const roles    = new RolesExplorerView(controller, ROLES_VIEW_ID);
    const queries  = new QueriesView(controller, QUERIES_VIEW_ID);

    return new ActivityBar([
        { id: DATABASE_VIEW_ID, label: "Database", shortcut: DATABASES_RAIL_SHORTCUT, glyph: "database", component: explorer },
        { id: ROLES_VIEW_ID,    label: "Roles",    shortcut: ROLES_RAIL_SHORTCUT,     glyph: "users",    component: roles },
        { id: QUERIES_VIEW_ID,  label: "Queries",  shortcut: QUERIES_RAIL_SHORTCUT,   glyph: "terminal", component: queries },
    ], { onSignOut: onLogout });
}
