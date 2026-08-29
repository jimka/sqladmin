// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.
//
// Each area of work — panels, diagrams, DDL, sidebar reveal, the query
// workspace, and roles — lives in its own module under controller/, reached
// through the matching public field, never a delegating wrapper method here.
// Every collaborator reaches back through the PanelHost interface alone
// (controller/panelHost.ts, implemented below) — no import cycle can form.

import { Dock, Menu, Notification, NotificationHistoryButton, Tooltip }                                                                                                                            from "@jimka/typescript-ui/overlay";
import type { DockPanelEvent, DockExceptionEvent }                                                                                                                                                 from "@jimka/typescript-ui/overlay";
import { Component }                                                                                                                                                                               from "@jimka/typescript-ui/core";
import { HBox }                                                                                                                                                                                    from "@jimka/typescript-ui/layout";
import { StatusBar }                                                                                                                                                                               from "@jimka/typescript-ui/component/container";
import { Text }                                                                                                                                                                                    from "@jimka/typescript-ui/component/input";
import { Glyph }                                                                                                                                                                                   from "@jimka/typescript-ui/component/display";
import { terminal }                                                                                                                                                                                from "@jimka/typescript-ui/glyphs/solid/terminal";
import { table_columns }                                                                                                                                                                           from "@jimka/typescript-ui/glyphs/solid/table_columns";
import { file_code }                                                                                                                                                                               from "@jimka/typescript-ui/glyphs/solid/file_code";
import { key }                                                                                                                                                                                     from "@jimka/typescript-ui/glyphs/solid/key";
import { diagram_project }                                                                                                                                                                         from "@jimka/typescript-ui/glyphs/solid/diagram_project";
import { sitemap }                                                                                                                                                                                 from "@jimka/typescript-ui/glyphs/solid/sitemap";
import { share_nodes }                                                                                                                                                                             from "@jimka/typescript-ui/glyphs/solid/share_nodes";
import { circle_nodes }                                                                                                                                                                            from "@jimka/typescript-ui/glyphs/solid/circle_nodes";
import { file_lines }                                                                                                                                                                              from "@jimka/typescript-ui/glyphs/solid/file_lines";
import { user }                                                                                                                                                                                    from "@jimka/typescript-ui/glyphs/solid/user";
import { showObjectMenu }                                                                                                                                                                          from "./navigator/objectMenu";
import { resolveAddressBarRoute }                                                                                                                                                                  from "./shell/routeTargets";
import type { PanelRoute }                                                                                                                                                                         from "./shell/routeTargets";
import type { ColumnMeta, DbObjectRef } from "./contract";
import { getColumns, tableExportUrl } from "./data/api";
import { exportQueryResult }                                                                                                                                                                       from "./dock/exportQueryResult";
import { exportExplainPlan }                                                                                                                                                                       from "./dock/exportExplainResult";
import type { ActiveExport }                                                                                                                                                                       from "./data/explain";
import { exportRoleGrants }                                                                                                                                                                        from "./dock/exportRoleGrants";
import { PropertiesPanel }                                                                                                                                                                          from "./properties/PropertiesPanel";
import { RolesPropertiesPanel }                                                                                                                                                                    from "./roles/RolesPropertiesPanel";
import { kindDisplayLabel }                                                                                                                                                                        from "./navigator/objectKinds";
import { LayoutStore }                                                                                                                                                                             from "./data/layoutStore";
import {
    panelId, structurePanelId,
    panelTooltip as buildPanelTooltip, errorMessage, panelIdsFor, tableExportFilename,
} from "./controller/controllerText";
import { downloadUrl } from "./data/download";
import { PanelLoadError } from "./controller/panelHost";
import type { PanelHost, OpenPanel, RoleGrants, AsyncPanelSpec, ShowObjectContextMenu } from "./controller/panelHost";
import { RevealCoordinator } from "./controller/revealCoordinator";
import { DdlLaunchers } from "./controller/ddlLaunchers";
import { QueryWorkspace } from "./controller/queryWorkspace";
import { ObjectPanels } from "./controller/objectPanels";
import { DiagramPanels } from "./controller/diagramPanels";
import { RoleActions } from "./controller/roleActions";

// The non-relation dock-tab glyphs (query / structure / definition / grants /
// notes) plus the distinct diagram-tab glyphs: `diagram-project` is the FK
// entity-relationship diagram (relation-rooted and whole-schema), `circle-nodes`
// the whole-database ER diagram, `share-nodes` a view/matview dependency graph,
// and `sitemap` a table inheritance/partitioning graph — one glyph per kind of
// view so a tab (and its navigator "Show" menu item) reads its type at a glance.
// The relation-kind glyphs (table / view / materialized view) come from
// objectGlyphs via KIND_GLYPH, which registers them. `user` is the
// membership-diagram root's glyph — also registered by RolesTree.ts, but
// registered here too so the root node always renders regardless of whether the
// Roles rail has mounted yet.
Glyph.register(terminal, table_columns, file_code, key, diagram_project, sitemap, share_nodes, circle_nodes, file_lines, user);

// The registered glyph name for a role node in the diagram views (the
// membership root, and buildRoleGrantsDiagram's/buildRoleMembershipDiagram's
// own role nodes). Keep in sync with those builders' inline `ROLE_GLYPH`.
const ROLE_GLYPH = "user";

/**
 * The signed-in-user badge for the status bar's right zone: a user glyph beside
 * the username, with the fuller "username @ database" carried in a hover
 * tooltip (the left zone's "Connection" id is an internal handle, not the DB).
 */
function buildIdentityWidget(username: string, database?: string): Component {
    const widget = new Component({
        layoutManager: new HBox({ spacing: 6 }),
        components:    [new Glyph(ROLE_GLYPH), new Text(username)],
    });

    Tooltip.attach(widget, database ? `Signed in as ${username} @ ${database}` : `Signed in as ${username}`);

    return widget;
}

/** The optional hook a diagram-bearing panel exposes so its tab can wait for placement. */
interface LayoutSettlingPanel {
    whenLaidOut(): Promise<void>;
}

/**
 * Hold a lazy tab's spinner until the panel's diagram has placed its nodes, so
 * no tab is ever revealed showing an unplaced graph. The method is probed
 * optionally: the non-diagram panels `openAsyncPanel` builds do not have it
 * and resolve at once.
 */
function awaitDiagramLayout(content: Component): Promise<void> {
    const panel = content as unknown as Partial<LayoutSettlingPanel>;

    return panel.whenLaidOut?.() ?? Promise.resolve();
}

export class SqlAdminController implements PanelHost {
    readonly dock           : Dock;
    readonly statusBar      : StatusBar;
    readonly properties     : PropertiesPanel;
    readonly rolesProperties: RolesPropertiesPanel;
    // Public, not private-with-delegators: mirroring the whole store API onto
    // the controller would carry no information (eight layout sites bind
    // against this directly).
    readonly layout         : LayoutStore;
    // Reveal-then-select wiring for the two sidebar trees. Built first among
    // the collaborators since ddl/panels/diagrams/roles all depend on it.
    readonly reveal         : RevealCoordinator;
    // Every DDL launcher, plus the Structure tab's Constraints/Indexes toolbar.
    readonly ddl            : DdlLaunchers;
    // Scratch query panels, the run-history/saved-query/notes stores, and
    // recently opened tables.
    readonly workspace      : QueryWorkspace;
    // Every per-object panel opener, and the reveal-then-open wiring for a
    // foreign key's referenced table.
    readonly panels         : ObjectPanels;
    // Every diagram/graph opener (ER diagrams, dependency/inheritance graphs).
    readonly diagrams       : DiagramPanels;
    // Every role-inspection and role-diagram action.
    readonly roles          : RoleActions;

    private readonly _connectionId: string;
    private readonly _database    : string | undefined;
    private readonly _openPanels  : Map<string, OpenPanel> = new Map();
    // Reopens each routed panel at its own URL — set from spec.route in
    // openAsyncPanel, read by the dock's "focus" handler via resolveAddressBarRoute.
    private readonly _panelRoutes: Map<string, PanelRoute> = new Map();
    // A query panel's latest recorded run, by panel id — resolveAddressBarRoute's
    // fallback for a panel with no _panelRoutes entry.
    private readonly _queryPanelRuns: Map<string, number> = new Map();
    // The diagram panels' shared right-click menu, mirroring how NavigatorTree
    // and RolesTree each own one reusable Menu(). Named diagramContextMenu below,
    // not showObjectMenu, so it does not shadow the imported module wrapper.
    private readonly _objectMenu: Menu = Menu();

    // Shell-injected handle (mirroring how ActivityBar takes a SidebarSizer):
    // toggles the start-page deck. The Queries-view selector/section-focuser
    // live on `workspace`, and the Database/Roles view selectors on `reveal`.
    private _startToggle        : ((visible: boolean) => void) | null = null;
    // The address-bar sync hook, wired from SqlAdminApp.ts — see setSyncAddressBar.
    private _syncAddressBar     : ((path: string, query?: Record<string, string>) => void) | null = null;

    // Bumped on every showProperties call so a stale column fetch is discarded.
    private _propsSeq: number = 0;

    // In-flight `getColumns` requests, keyed by panel id, so several column
    // fetches from one navigator double-click collapse into one request.
    private readonly _columnsInFlight = new Map<string, Promise<ColumnMeta[]>>();

    // The latest exportable result each query panel displayed, keyed by panel
    // id, plus the currently focused panel id — lets the menubar "Export
    // results…" item act on the active panel with no back-reference to it.
    private readonly _activeQueryResult: Map<string, ActiveExport | null> = new Map();
    // A grants tab's full grant set, keyed by panel id, mirroring
    // _activeQueryResult for the active-tab export (grants tabs carry no
    // DbObjectRef, so they are not in _openPanels).
    private readonly _activeRoleGrants: Map<string, RoleGrants> = new Map();
    private _activePanelId: string | null = null;

    /**
     * Wire the Dock, StatusBar, and Properties inspector, and subscribe to the
     * Dock's panel-close and focus events.
     *
     * @param connectionId - The connection these operations target (Phase 0-1: "default").
     * @param username - The signed-in database user, pinned to the status bar's
     *   right zone. Omitted only by DOM-less callers that never show the bar.
     * @param database - The connected database: roots the navigator at its
     *   schemas, labels the status bar's left zone, and shows in the identity
     *   tooltip. Omitted only by DOM-less callers.
     */
    constructor(connectionId: string = "default", username?: string, database?: string) {
        this._connectionId = connectionId;
        this._database     = database;
        // The dock owns its own emptiness; drive the start-page deck straight off
        // its "emptychange" aggregate (empty↔populated, once per transition)
        // instead of shadow-counting opens and closes here.
        this.dock            = Dock({ listeners: { emptychange: e => this._startToggle?.(e.empty) } });
        this.statusBar       = new StatusBar();
        this.properties      = new PropertiesPanel();
        this.rolesProperties = new RolesPropertiesPanel();

        // Fall back to "default" when the username is absent (a bare test
        // construction), keeping localStorage keys well-formed.
        const userId = username || "default";

        // No connectionId — layout is a property of the user's window, not of the
        // database being viewed, so it is scoped per user only (see data/layoutStore.ts).
        this.layout = new LayoutStore(userId, window.localStorage);

        // The six collaborators, in dependency order. The context-menu
        // callback lets diagrams/roles show the object menu without holding
        // the whole controller.
        const contextMenu: ShowObjectContextMenu = (ref, event) => this.diagramContextMenu(ref, event);

        this.reveal    = new RevealCoordinator(connectionId, database);
        this.ddl       = new DdlLaunchers(this, this.reveal);
        this.workspace = new QueryWorkspace(this, this.ddl, username);
        this.panels    = new ObjectPanels(this, this.reveal, this.ddl, this.workspace);
        this.diagrams  = new DiagramPanels(this, this.panels, contextMenu);
        this.roles     = new RoleActions(this, this.reveal, this.panels, contextMenu);

        // The dock disposes a closed tab's content itself (destroying every
        // registered child in its subtree) and fires "close" only on genuine
        // destruction (a tear-off fires "detach" and the panel survives). This
        // handler drops only the app's own per-panel bookkeeping: the closed
        // query panel's held result, so it can't be exported.
        this.dock.on("close", (e: DockPanelEvent) => {
            this.disposePanel(e.id);
            this._activeQueryResult.delete(e.id);
            this._activeRoleGrants.delete(e.id);
            this._panelRoutes.delete(e.id);
            this._queryPanelRuns.delete(e.id);
        });

        // A deferred panel whose fetch rejected: the Dock has already closed the tab,
        // so all that is left is reporting. A PanelLoadError raised by a helper that
        // already called notifyError is swallowed, to avoid a second notification.
        this.dock.on("exception", (e: DockExceptionEvent) => {
            if (e.error instanceof PanelLoadError) {
                if (!e.error.reported) {
                    this.notifyError(e.error.reason, e.error.ref);
                }

                return;
            }

            this.notifyError(e.error);
        });

        // Switching tabs syncs the navigator selection and the status bar to the
        // now-active panel, and records the active panel id so the Query-menu
        // export targets it. A null payload means no panel is focused — the
        // library emits it only from recomputeFocusAfterClose, when no frame
        // remains — so clearing `_activePanelId` here also keeps a
        // closed-last-tab Alt+R from invoking a refresh on a torn-down panel.
        this.dock.on("focus", (e: DockPanelEvent | null) => {
            if (e) {
                this._activePanelId = e.id;
                this.syncToPanel(e.id);
            } else {
                this._activePanelId = null;
            }

            this.syncAddressBarFor(e ? e.id : null);
        });

        // Show the connected database in the status bar's left zone.
        this.statusBar.setMessage(`Database: ${this._statusScope}`);

        // Pin the signed-in identity to the status bar's RIGHT zone. The left
        // zone shows transient per-operation messages (setMessage), so identity
        // lives on the right where those never clobber it.
        if (username) {
            this.statusBar.addRight(buildIdentityWidget(username, database));
        }

        // The notification history sits at the FAR right — appended after the
        // identity widget, since the right zone's HBox lays out left-to-right.
        // flat + compact keep the library button inside the bar's fixed 22px row.
        const historyButton = new NotificationHistoryButton({ flat: true, compact: true });

        Tooltip.attach(historyButton, "Notification history");
        this.statusBar.addRight(historyButton);
    }

    get connectionId(): string {
        return this._connectionId;
    }

    /**
     * The connected database name (from the authenticated session), or
     * undefined for DOM-less callers that omit it. Feeds the navigator root and
     * the status bar.
     */
    get database(): string | undefined {
        return this._database;
    }

    /**
     * What the status bar names the current connection by: the database the
     * session is connected to. Falls back to the connection id only for the
     * DOM-less path that omits `database`.
     */
    private get _statusScope(): string {
        return this._database ?? this._connectionId;
    }

    /**
     * Show `ref`'s object context menu at `event`'s position — the same menu
     * the navigator tree shows for the identical object, built by the shared
     * buildObjectMenuItems (see objectMenu.ts). Called by each diagram panel's
     * "contextmenu" forwarding; a no-op for a kind with no menu.
     */
    private diagramContextMenu(ref: DbObjectRef, event: MouseEvent): void {
        showObjectMenu(this._objectMenu, ref, this, event);
    }

    /**
     * Export the active work tab's data as CSV or JSON — the menubar's "Export
     * results…" convenience, routed to whichever tab is focused. A query panel
     * exports its loaded result client-side; a table/view data tab streams the
     * whole relation server-side; a role grants tab serializes its full grant
     * set — each matching that tab's own toolbar Export button. Notifies when
     * the focused tab has nothing to export.
     */
    exportActive(format: "csv" | "json"): void {
        const id = this._activePanelId;

        if (id) {
            const active = this._activeQueryResult.get(id);
            const notify = (message: string): void => {
                this.status(`export: ${message}`);
            };

            if (active?.kind === "rows") {
                exportQueryResult(active.result, format, notify);

                return;
            }

            if (active?.kind === "plan") {
                // A plan isn't tabular: map the menu's CSV/JSON to the plan's text
                // and structured-JSON exports (CSV → plain-text plan).
                void exportExplainPlan(active.plan, format === "csv" ? "txt" : "json", notify);

                return;
            }

            // A table/view data tab carries a store in _openPanels; its ref drives
            // the server-side full-relation export (a structure/definition detail
            // tab has no store, so it falls through to the notify below).
            const panel = this.panelEntry(id);

            if (panel && panel.store) {
                this.exportTable(panel.ref, format);

                return;
            }

            // A role grants tab is tracked separately (it has no DbObjectRef); its
            // full grant set serializes client-side, all pages included.
            const grants = this._activeRoleGrants.get(id);

            if (grants) {
                exportRoleGrants(grants.role, grants.privileges, format);

                return;
            }
        }

        this.statusBar.setMessage("No data to export");
    }

    /**
     * The export-format family the focused tab offers, so the menubar's "Export
     * results" submenu can label its two items correctly: an EXPLAIN plan exports
     * as text / JSON (`"plan"`); everything else — query rows, a table/view
     * stream, a role's grants, or nothing — exports as CSV / JSON (`"tabular"`).
     * Read fresh each time that submenu opens.
     *
     * @returns `"plan"` when the focused tab shows an EXPLAIN plan, else `"tabular"`.
     */
    activeExportKind(): "plan" | "tabular" {
        const id     = this._activePanelId;
        const active = id ? this._activeQueryResult.get(id) : null;

        return active?.kind === "plan" ? "plan" : "tabular";
    }

    /**
     * Whether the focused tab has anything to export, so the menubar's "Export
     * results" item can grey out when it does not. Mirrors {@link exportActive}'s
     * sources: a query result/plan, a table/view data grid, or a role's grants —
     * a structure/definition detail tab or no open tab has nothing.
     */
    canExportActive(): boolean {
        const id = this._activePanelId;

        if (!id) {
            return false;
        }

        return this._activeQueryResult.get(id) != null   // query rows or an EXPLAIN plan
            || this.panelEntry(id)?.store != null    // a table/view data grid
            || this._activeRoleGrants.get(id) != null;    // a role grants tab
    }

    /**
     * Open the backend streaming export for a table/view: navigate a hidden
     * anchor to the export URL so the `attachment` response downloads the full
     * relation without buffering it in the browser (a big table exports
     * without freezing the grid). Works identically for a table and a view.
     */
    exportTable(ref: DbObjectRef, format: "csv" | "json"): void {
        downloadUrl(tableExportUrl(ref, format), tableExportFilename(ref, format));
    }

    /**
     * Re-open a recently opened table from the start page, reusing the stored
     * navigator node so the reopened panel still drives the tree selection.
     */
    reopenTable(ref: DbObjectRef): void {
        const entry = this.workspace.recentEntry(ref);

        if (entry) {
            void this.panels.openTable(entry.ref, entry.node);
        }
    }

    /**
     * Register the shell's start-page deck toggle. Invoked once the shell has
     * built the CENTER Card; mirrors how the ActivityBar takes a SidebarSizer.
     * The current emptiness is reflected immediately so the deck starts correct.
     */
    setStartToggle(toggle: (visible: boolean) => void): void {
        this._startToggle = toggle;
        toggle(this.dock.isEmpty());
    }

    /**
     * Register the shell's address-bar sync callback, invoked with the
     * currently focused tab's own URL (see resolveAddressBarRoute) whenever
     * that URL might have changed, so the shell can write it in place
     * without triggering the router's own navigation dispatch.
     */
    setSyncAddressBar(sync: (path: string, query?: Record<string, string>) => void): void {
        this._syncAddressBar = sync;
    }

    /**
     * Resolve `id`'s address-bar route and write it, if a sync hook is
     * registered. Called on every dock "focus" event, and — since an
     * auto-run query panel's run finishes asynchronously behind an
     * already-focused tab — from recordQueryRun when the completing run
     * belongs to the panel that is still focused.
     */
    private syncAddressBarFor(id: string | null): void {
        const route = resolveAddressBarRoute(id, this._panelRoutes, this._queryPanelRuns, this.workspace.historyList());

        this._syncAddressBar?.(route.path, route.query);
    }

    /**
     * Fetch a relation's columns, coalescing concurrent requests for the same
     * object. A navigator double-click fires two selection events (each showing
     * Properties) and then opens the object — three column fetches for one
     * gesture. Sharing the in-flight promise collapses them into a single
     * request. The entry is removed as soon as the fetch settles, so a later
     * fetch (e.g. after a structure change) always goes to the server rather
     * than serving stale columns from a cache.
     */
    fetchColumns(ref: DbObjectRef): Promise<ColumnMeta[]> {
        const key = panelId(ref);
        const inFlight = this._columnsInFlight.get(key);

        if (inFlight) {
            return inFlight;
        }

        const request = getColumns(ref);

        this._columnsInFlight.set(key, request);
        void request.finally(() => {
            // Guard against clearing a newer request that reused the key.
            if (this._columnsInFlight.get(key) === request) {
                this._columnsInFlight.delete(key);
            }
        });

        return request;
    }

    /**
     * Show the selected object's metadata in the Properties inspector. A database
     * or schema renders immediately; a table, view, or materialized view needs
     * its columns (for the count and primary key), reused from an open panel when
     * possible and fetched otherwise. A monotonic guard discards a stale fetch
     * whose selection has since changed, so rapid clicks never render the wrong
     * object.
     */
    async showProperties(ref: DbObjectRef): Promise<void> {
        const seq = ++this._propsSeq;

        if (ref.kind !== "table" && ref.kind !== "view" && ref.kind !== "materializedView") {
            this.properties.show(ref);

            return;
        }

        const cached = this.panelEntry(panelId(ref))?.columns
                       ?? this.panelEntry(structurePanelId(ref))?.columns;

        if (cached) {
            this.properties.show(ref, cached);

            return;
        }

        try {
            const columns = await this.fetchColumns(ref);

            if (seq === this._propsSeq) {
                this.properties.show(ref, columns);
            }
        } catch (err) {
            if (seq === this._propsSeq) {
                this.notifyError(err, ref);
            }
        }
    }

    /**
     * Refresh the active work tab. Two reloadable shapes: the six storeless
     * detail tabs dispatch to their own registered `refresh` closure, which
     * re-fetches and reseeds via the panel's `reload`; a data grid instead
     * reloads its store from the server, discarding a table's unsaved edits
     * first (a read-only view has none to reject). A no-op when the focused
     * tab has neither (a query, a role's grants, the empty start page).
     * Wired to the Alt+R accelerator.
     */
    refreshActive(): void {
        const entry = this._activePanelId ? this.panelEntry(this._activePanelId) : undefined;

        if (entry?.refresh) {
            entry.refresh();

            return;
        }

        if (!entry?.store) {
            return;
        }

        const readOnly = entry.ref.kind === "view" || entry.ref.kind === "materializedView";

        if (!readOnly) {
            entry.store.reject();
        }

        void entry.store.load();
        this.status(`${entry.ref.name ?? ""}: refreshed`);
    }

    /**
     * Surface an error (AjaxError detail, or any thrown value) to the StatusBar
     * and as an error Notification — the toast is what lands it in
     * `Notification.getHistory()`, since the status bar's line is clobbered by
     * the next setMessage. Drops the "Error" prefix: the toast's own badge says so.
     */
    notifyError(error: unknown, ref?: DbObjectRef): void {
        const where  = ref?.name ? ` (${ref.name})` : "";
        const detail = errorMessage(error);

        this.statusBar.setMessage(`Error${where}: ${detail}`);
        Notification.show(ref?.name ? `${ref.name}: ${detail}` : detail, "error");
    }

    /** Write a status message, prefixed with the connected database (PanelHost). */
    status(message: string): void {
        this.statusBar.setMessage(`${this._statusScope} · ${message}`);
    }

    /** Add or replace this panel's open-panel registry entry (PanelHost). */
    registerPanel(id: string, entry: OpenPanel): void {
        this._openPanels.set(id, entry);
    }

    /** The live registry entry for `id`, or undefined when the tab is not open (PanelHost). */
    panelEntry(id: string): OpenPanel | undefined {
        return this._openPanels.get(id);
    }

    /** Record the address-bar route for a tab opened without openAsyncPanel (PanelHost). */
    setPanelRoute(id: string, route: PanelRoute): void {
        this._panelRoutes.set(id, route);
    }

    /** Close every tab that can exist for `ref` (PanelHost; see panelIdsFor). */
    closeTabsFor(ref: DbObjectRef): void {
        panelIdsFor(ref).forEach(id => this.dock.removePanel(id));
    }

    /**
     * Record a query panel's latest run for the address-bar sync, and
     * re-sync the address bar when `id` is still the focused panel: an
     * auto-run query tab's run finishes after the "focus" event that opened
     * it already fired, so without this the bar would stay on "/" (PanelHost).
     */
    recordQueryRun(id: string, timestamp: number): void {
        this._queryPanelRuns.set(id, timestamp);

        if (id === this._activePanelId) {
            this.syncAddressBarFor(id);
        }
    }

    /** Mirror a query panel's latest exportable result (PanelHost). */
    setActiveExport(id: string, active: ActiveExport | null): void {
        this._activeQueryResult.set(id, active);
    }

    /** Track a grants tab's full grant set for the active-tab export (PanelHost). */
    setActiveRoleGrants(id: string, grants: RoleGrants): void {
        this._activeRoleGrants.set(id, grants);
    }

    /**
     * Hover tooltip for a tab: the object name, then Type/Schema/Database ordered
     * most-specific to broadest. A thin wrapper over the pure builder — named
     * `buildPanelTooltip` on import so this method's body cannot be misread as
     * recursive — supplying the type label the free function stays free of the
     * DOM-touching lookup for.
     */
    panelTooltip(ref: DbObjectRef): string {
        return buildPanelTooltip(ref, kindDisplayLabel(ref.kind));
    }

    /** Drop a closed panel's store from the registry (the dock drives the start page). */
    private disposePanel(id: string): void {
        this._openPanels.delete(id);
    }

    /**
     * Register a work-area tab whose content is fetched: the tab appears at once
     * with the library's spinner, `build` runs behind it, and the built panel
     * replaces the spinner. A rejection closes the tab and reaches the Dock
     * "exception" handler, which reports it through notifyError. A build that
     * lands after its tab closed (or the id was reopened) is handled by the
     * Dock itself — it cancels the materialization and disposes the arrival.
     */
    openAsyncPanel(spec: AsyncPanelSpec, build: () => Promise<Component>): void {
        if (spec.route) {
            this._panelRoutes.set(spec.id, spec.route);
        }

        this.dock.addLazyPanel({
            id     : spec.id,
            title  : spec.title,
            glyph  : spec.glyph,
            tooltip: spec.tooltip,
            content: async () => {
                try {
                    const content = await build();

                    await awaitDiagramLayout(content);

                    return content;
                } catch (error) {
                    // Already wrapped (a helper that reported and returned null):
                    // pass it through so `reported` is not lost.
                    if (error instanceof PanelLoadError) {
                        throw error;
                    }

                    // Re-thrown so the library tears the tab down; the wrapper
                    // carries the ref so the "exception" handler can name it.
                    throw new PanelLoadError(error, spec.ref);
                }
            },
        });

        this.status(`${spec.title}: loading…`);
    }

    /** Select the panel's navigator node and refresh the status bar to match. */
    syncToPanel(id: string): void {
        const panel = this.panelEntry(id);

        if (!panel) {
            return;
        }

        if (panel.node) {
            this.reveal.selectNavigatorNode(panel.node);
        }

        this.updateStatusFor(panel);
        void this.showProperties(panel.ref);
    }

    /** Status line for a panel: row count for a data tab, else the detail label. */
    private updateStatusFor(panel: OpenPanel): void {
        if (panel.store) {
            const count = panel.store.getTotalCount() ?? panel.store.getRecords().length;
            this.status(`${panel.ref.name}: ${count} rows`);
        } else {
            this.status(`${panel.ref.name}: ${panel.detail ?? "structure"}`);
        }
    }
}
