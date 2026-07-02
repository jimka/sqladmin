// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.

import { Dock }                                                from "@jimka/typescript-ui/overlay";
import type { DockPanelEvent }                                 from "@jimka/typescript-ui/overlay";
import { StatusBar }                                           from "@jimka/typescript-ui/component/container";
import type { Tree, TreeNode }                                 from "@jimka/typescript-ui/component/tree";
import type { AjaxStore, StoreExceptionEvent, StoreSyncEvent } from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef, QueryRowsResult, RolePrivilege, RoleSummary, TableStructure } from "./contract";
import { getColumns, getRoleDetail, getRoles, getViewDefinition, getStructure, runQuery, tableExportUrl } from "./data/api";
import { exportQueryResult }                                   from "./dock/exportQueryResult";
import { buildModel }                                          from "./data/buildModel";
import { buildSelectSql }                                      from "./data/sql";
import { buildStore }                                          from "./data/stores";
import { TableWorkPanel }                                      from "./dock/TableWorkPanel";
import { ViewWorkPanel }                                       from "./dock/ViewWorkPanel";
import { StructurePanel }                                      from "./dock/StructurePanel";
import { DefinitionPanel }                                     from "./dock/DefinitionPanel";
import { QueryPanel }                                          from "./dock/QueryPanel";
import { RoleGrantsPanel }                                     from "./dock/RoleGrantsPanel";
import { PropertiesPanel, relationTypeLabel }                  from "./properties/PropertiesPanel";
import { RolesPropertiesPanel }                                from "./roles/RolesPropertiesPanel";
import { QueryHistoryStore, SavedQueryStore }                  from "./data/queryStore";
import type { HistoryEntry, SavedQuery }                       from "./data/queryStore";
import { promptQueryName }                                     from "./promptQueryName";

/** A focusable section of the Queries view — the Saved or the Recent list. */
export type QueriesSection = "saved" | "recent";

/**
 * Registry entry for one open dock panel. `store` is absent for the storeless
 * detail tabs (structure, definition); `columns` is present only when the tab
 * was built from introspected columns (data, structure). `detail` labels a
 * storeless tab in the status line ("structure" / "definition").
 */
interface OpenPanel {
    ref: DbObjectRef;
    node: TreeNode | null; // null when opened without a navigator node (e.g. an FK target)
    store?: AjaxStore;
    columns?: ColumnMeta[];
    detail?: string;
}

/** A recently opened table, kept with its node so the start page can re-open it. */
interface RecentTable {
    ref: DbObjectRef;
    node: TreeNode;
}

// How many recently opened tables the start page lists. Small enough to stay a
// glanceable "jump back in" strip, not a full history.
const MAX_RECENT_TABLES = 8;

export class SqlAdminController {
    readonly dock           : Dock;
    readonly statusBar      : StatusBar;
    readonly properties     : PropertiesPanel;
    readonly rolesProperties: RolesPropertiesPanel;

    private readonly _connectionId: string;
    private readonly _openPanels  : Map<string, OpenPanel> = new Map();
    private _navigator            : Tree | null = null;

    // The per-connection localStorage stores backing the Queries view, the start
    // page, and the panel's Ctrl+↑/↓ recall.
    private readonly _history: QueryHistoryStore;
    private readonly _saved  : SavedQueryStore;

    // Recently opened tables (newest-first), surfaced on the start page.
    private readonly _recentTables: RecentTable[] = [];

    // Count of open dock panels, driving the start page: it shows at 0 and hides
    // once the first panel opens. Every addPanel-issuing method increments; the
    // single "close" subscription decrements.
    private _openPanelCount: number = 0;

    // Shell-injected handles (mirroring how ActivityBar takes a SidebarSizer): one
    // toggles the start-page deck, one selects the Queries activity-bar view, one
    // focuses a section (Saved/Recent) of the Queries view.
    private _startToggle        : ((visible: boolean) => void) | null = null;
    private _showQueriesView    : (() => void) | null = null;
    private _focusQueriesSection: ((section: QueriesSection) => void) | null = null;

    // Listeners rebuilt when the workspace data changes (a run recorded, a query
    // saved/removed, a table opened) — the Queries view and the start page.
    private readonly _workspaceListeners: Array<() => void> = [];

    // Monotonic counter minting unique ids for scratch query panels, which are
    // never deduped (each "New Query" / "Open as query" opens a fresh panel).
    private _queryCounter: number = 0;

    // Bumped on every showProperties call so a slow column fetch whose selection
    // has since moved on is discarded instead of clobbering the current view.
    private _propsSeq: number = 0;

    // The latest rows result each query panel displayed, keyed by panel id (set
    // via the panel's injected onResult), plus the currently focused panel id.
    // Together they let the Query-menu "Export results…" item act on the active
    // panel without the controller holding a reference back to the panel object.
    private readonly _activeQueryResult: Map<string, QueryRowsResult | null> = new Map();
    private _activePanelId: string | null = null;

    // The same monotonic guard for the Roles view's detail fetch.
    private _roleSeq: number = 0;

    /**
     * Wire the Dock, StatusBar, and Properties inspector, and subscribe to the
     * Dock's panel-close and focus events.
     *
     * @param connectionId - The connection these operations target (Phase 0-1: "default").
     */
    constructor(connectionId: string = "default") {
        this._connectionId = connectionId;
        this.dock            = Dock();
        this.statusBar       = new StatusBar();
        this.properties      = new PropertiesPanel();
        this.rolesProperties = new RolesPropertiesPanel();

        // Production storage is the DOM localStorage (persisted per connection);
        // the pure stores keep it injected so their logic tests run DOM-less.
        this._history = new QueryHistoryStore(connectionId, window.localStorage);
        this._saved   = new SavedQueryStore(connectionId, window.localStorage);

        // Disposal is wired once: the dock fires "close" only on genuine
        // destruction (a tear-off fires "detach" and the panel survives). A
        // closed query panel's held result is dropped so it can't be exported.
        this.dock.on("close", (e: DockPanelEvent) => {
            this.disposePanel(e.id);
            this._activeQueryResult.delete(e.id);
        });

        // Switching tabs syncs the navigator selection and the status bar to the
        // now-active panel, and records the active panel id so the Query-menu
        // export targets it. A null payload means no panel is focused.
        this.dock.on("focus", (e: DockPanelEvent | null) => {
            if (e) {
                this._activePanelId = e.id;
                this.syncToPanel(e.id);
            }
        });

        this.statusBar.setMessage(`Connection: ${connectionId}`);
    }

    get connectionId(): string {
        return this._connectionId;
    }

    /** Register the navigator tree so the focused tab can drive its selection. */
    setNavigator(tree: Tree): void {
        this._navigator = tree;
    }

    /**
     * Open a table, view, or materialized view in the Dock (deduping by panel
     * id), wiring its store errors. A table opens the editable TableWorkPanel; a
     * view or materialized view opens the read-only ViewWorkPanel (a plain data
     * grid — its structure and definition open as separate tabs from the
     * navigator's right-click menu).
     *
     * The `node` is optional: an FK-referenced table may have no currently-loaded
     * navigator node, so its tab still opens but the focus-sync skips the reveal.
     */
    async openTable(ref: DbObjectRef, node?: TreeNode): Promise<void> {
        const id = this.panelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let store: AjaxStore;
        let columns: ColumnMeta[];

        try {
            columns = await getColumns(ref);
            store = buildStore(ref, buildModel(columns), columns);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        // A view/matview is read-only: it opens the ViewWorkPanel and never
        // writes, so the 'sync' write-feedback listener is not attached.
        const isReadOnly = ref.kind === "view" || ref.kind === "materializedView";

        store.on("exception", (e: StoreExceptionEvent) => this.notifyError(e.error, ref));

        if (!isReadOnly) {
            store.on("sync", (e: StoreSyncEvent) => this.reportSync(e, ref));
        }

        this._openPanels.set(id, { ref, node: node ?? null, store, columns });

        if (node) {
            this.rememberTable(ref, node);
        }

        this.panelOpened();

        // Open lazily: the tab appears at once, and the grid UI builds on first
        // activation behind a spinner, so a wide table never blocks the tab.
        const notify = (message: string): void => this.statusBar.setMessage(`${this._connectionId} · ${ref.name}: ${message}`);
        this.dock.addLazyPanel({
            id,
            title  : ref.name ?? id,
            tooltip: this.panelTooltip(ref),
            content: isReadOnly
                ? () => ViewWorkPanel(store, columns)
                : () => TableWorkPanel(store, columns, notify)
        });

        try {
            await store.load();
            this.syncToPanel(id);
        } catch {
            // load() rethrows, but the 'exception' listener already surfaced it.
        }
    }

    /**
     * Open a read-only definition (pg_get_viewdef SQL) tab for a view/matview,
     * deduping by definition-panel id. The SQL is fetched up front and passed to
     * a plain DefinitionPanel; a failed fetch surfaces through notifyError and no
     * tab opens. Tables have no definition, so the navigator only offers this for
     * views (see NavigatorTree).
     */
    async openDefinition(ref: DbObjectRef, node: TreeNode): Promise<void> {
        const id = this.definitionPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let definition: string;

        try {
            definition = (await getViewDefinition(ref)).definition;
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        this._openPanels.set(id, { ref, node, detail: "definition" });
        this.panelOpened();
        this.dock.addPanel({
            id,
            title  : `${ref.name ?? id} (definition)`,
            tooltip: this.panelTooltip(ref),
            content: DefinitionPanel(definition)
        });
        this.syncToPanel(id);
    }

    /** Open a read-only structure (column metadata) tab for a table/view. */
    async openStructure(ref: DbObjectRef, node: TreeNode): Promise<void> {
        const id = this.structurePanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let columns: ColumnMeta[];
        let structure: TableStructure;

        try {
            [columns, structure] = await Promise.all([getColumns(ref), getStructure(ref)]);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        this._openPanels.set(id, { ref, node, columns, detail: "structure" });
        this.panelOpened();
        this.dock.addPanel({
            id,
            title  : `${ref.name ?? id} (structure)`,
            tooltip: this.panelTooltip(ref),
            content: StructurePanel(columns, structure, (refSchema, refTable) =>
                this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : refSchema,
                    name        : refTable,
                    kind        : "table",
                })),
        });
        this.syncToPanel(id);
    }

    /**
     * Open a foreign key's referenced table in the Dock, revealing it in the
     * navigator when its node is already loaded. The reveal is best-effort: an
     * FK target under a collapsed or not-yet-loaded branch has no loaded node
     * and no library API forces the expand, so only the Dock tab opens.
     *
     * @param ref - The referenced table to open.
     */
    openReferencedTable(ref: DbObjectRef): void {
        const node = this.findLoadedNode(ref);

        void this.openTable(ref, node);
    }

    /**
     * Open a fresh scratch query panel, optionally seeded with SQL to run on
     * open. Each call mints a new id, so re-invoking always opens a new panel
     * (no dedup — the natural behaviour for a scratch buffer).
     *
     * Query panels are deliberately NOT registered in `_openPanels`: they carry
     * no `ref`/`node`/`columns`, need no dedup or focus-sync, and the controller
     * holds no reference back to them (the injected `notify`/`runQuery`/`onError`
     * closures point panel -> controller, not the reverse). So the Dock disposes
     * the subtree on close with no controller-side cleanup, and the table-panel
     * lifecycle (`OpenPanel`/`syncToPanel`/`disposePanel`) stays untouched.
     *
     * @param seedSql - SQL to prefill the editor with.
     * @param run - Whether to execute the seeded SQL on open. Defaults to
     *   `false` — opening seeds the editor only; a caller that wants the
     *   phpMyAdmin "run immediately" behaviour (Open-as-query, "Execute") opts in.
     * @param title - The tab title (and status-line label). Defaults to
     *   `Query N`; a saved query passes its name so the tab reads as the query.
     */
    openQuery(seedSql?: string, run: boolean = false, title?: string): void {
        const n     = ++this._queryCounter;
        const id    = `query-${n}`;
        const label = title ?? `Query ${n}`;

        const notify = (message: string): void =>
            this.statusBar.setMessage(`${this._connectionId} · ${label}: ${message}`);

        this.panelOpened();
        this.dock.addPanel({
            id,
            title  : label,
            content: QueryPanel({
                runQuery  : sql => runQuery(this._connectionId, sql),
                notify,
                onError   : error => this.notifyError(error),
                initialSql: seedSql,
                autoRun   : run,
                // Record every run in history and feed the panel's Ctrl+↑/↓ recall.
                // The store dependency stays here — the panel is a pure view over
                // these injected callbacks (matching notify/onError).
                onRun     : (entry: HistoryEntry) => this.recordRun(entry),
                getHistory: () => this._history.list().map(e => e.sql),
                // The Save toolbar button hands back the trimmed SQL; the
                // controller owns the naming modal and the saved-query store.
                onSave    : (sql: string) => void this.promptAndSaveQuery(sql),
                // Mirror this panel's latest result so the Query-menu export can
                // reach it while it is the active panel.
                onResult  : (result: QueryRowsResult | null) => this._activeQueryResult.set(id, result)
            })
        });
    }

    /**
     * Export the active query panel's loaded result as CSV or JSON (the Query
     * menu's "Export results…" convenience). Notifies when the focused panel has
     * no rows result. The panel's own toolbar button is the primary surface;
     * this routes to whichever panel is focused via the tracked active id.
     *
     * @param format - The export format, "csv" or "json".
     */
    exportActiveQuery(format: "csv" | "json"): void {
        const result = this._activePanelId ? this._activeQueryResult.get(this._activePanelId) : null;

        if (!result) {
            this.statusBar.setMessage("No query result to export");

            return;
        }

        exportQueryResult(result, format, message =>
            this.statusBar.setMessage(`${this._connectionId} · export: ${message}`));
    }

    /**
     * Open the backend streaming export for a table/view: navigate a hidden
     * anchor to the export URL so the `attachment` response downloads the full
     * relation without buffering it in the browser (a big table exports without
     * freezing the grid). Works identically for a table and a view.
     *
     * @param ref - The table/view to export.
     * @param format - The export format, "csv" or "json".
     */
    exportTable(ref: DbObjectRef, format: "csv" | "json"): void {
        const anchor = document.createElement("a");
        anchor.href          = tableExportUrl(ref, format);
        anchor.style.display = "none";

        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
    }

    /**
     * Open a table/view "as a query": a generated `SELECT * FROM … LIMIT n` in a
     * new query panel (the phpMyAdmin drop-to-SQL affordance). Additive to
     * `openTable`, never a replacement — the CRUD panel stays the primary open.
     *
     * @param ref - The table/view to browse as a query.
     */
    openQueryFor(ref: DbObjectRef): void {
        this.openQuery(buildSelectSql(ref), true);
    }

    /**
     * Open a saved query by name in a fresh query panel (a no-op for an unknown
     * name). Like every scratch panel, it is never deduped.
     *
     * @param name - The saved query's name.
     * @param run - Whether to execute it on open (the "Execute" gesture); the
     *   default opens it in the editor without running.
     */
    openSavedQuery(name: string, run: boolean = false): void {
        const saved = this._saved.get(name);

        if (saved) {
            this.openQuery(saved.sql, run, name);
        }
    }

    /**
     * Save (upsert) a named query and refresh the workspace surfaces.
     *
     * @param name - The name to store the query under (overwrites an existing one).
     * @param sql - The SQL to save.
     */
    saveQuery(name: string, sql: string): void {
        this._saved.save(name, sql);
        this.notifyWorkspaceChanged();
    }

    /**
     * Prompt (via the in-app modal) for a name and save the SQL under it,
     * reporting the outcome on the status bar. A cancelled or blank name
     * abandons the save. Bound to the query panel's Save toolbar button and the
     * Queries view's "Save…" action.
     *
     * @param sql - The SQL to save.
     */
    async promptAndSaveQuery(sql: string): Promise<void> {
        const name = await promptQueryName();

        if (name === null) {
            return;
        }

        this.saveQuery(name, sql);
        this.statusBar.setMessage(`${this._connectionId} · Saved query as “${name}”`);
    }

    /**
     * Remove a saved query and refresh the workspace surfaces.
     *
     * @param name - The saved query's name.
     */
    removeSavedQuery(name: string): void {
        this._saved.remove(name);
        this.notifyWorkspaceChanged();
    }

    /**
     * @returns The run history, newest-first (for the Queries view's Recent section).
     */
    historyList(): HistoryEntry[] {
        return this._history.list();
    }

    /**
     * @returns The saved queries, sorted by name (for the Queries view + start page).
     */
    savedList(): SavedQuery[] {
        return this._saved.list();
    }

    /**
     * @returns The recently opened tables, newest-first (for the start page).
     */
    recentTables(): DbObjectRef[] {
        return this._recentTables.map(t => t.ref);
    }

    /**
     * Re-open a recently opened table from the start page, reusing the stored
     * navigator node so the reopened panel still drives the tree selection.
     *
     * @param ref - The table ref (matched to a remembered entry by panel id).
     */
    reopenTable(ref: DbObjectRef): void {
        const entry = this._recentTables.find(t => this.panelId(t.ref) === this.panelId(ref));

        if (entry) {
            void this.openTable(entry.ref, entry.node);
        }
    }

    /**
     * Select and expand the Queries activity-bar view (the menu's entry point),
     * optionally focusing one of its sections so "Open Saved…" and "Query
     * History…" land the keyboard on the Saved vs Recent list respectively.
     *
     * @param section - Which section's list to focus, if any.
     */
    showQueriesView(section?: QueriesSection): void {
        this._showQueriesView?.();

        if (section) {
            this._focusQueriesSection?.(section);
        }
    }

    /**
     * Register the shell's start-page deck toggle. Invoked once the shell has
     * built the CENTER Card; mirrors how the ActivityBar takes a SidebarSizer.
     * The current emptiness is reflected immediately so the deck starts correct.
     *
     * @param toggle - Shows (true) or hides (false) the start page.
     */
    setStartToggle(toggle: (visible: boolean) => void): void {
        this._startToggle = toggle;
        toggle(this._openPanelCount === 0);
    }

    /**
     * Register the shell's Queries-view selector (the ActivityBar can select a
     * view by id, but only the shell holds the bar handle).
     *
     * @param select - Selects and expands the Queries activity-bar view.
     */
    setShowQueriesView(select: () => void): void {
        this._showQueriesView = select;
    }

    /**
     * Register the Queries view's section focuser (owned by the view, not the
     * shell): focus and reveal the Saved or Recent list.
     *
     * @param focus - Focuses the named section's list.
     */
    setQueriesSectionFocus(focus: (section: QueriesSection) => void): void {
        this._focusQueriesSection = focus;
    }

    /**
     * Subscribe to workspace changes (a run recorded, a query saved/removed, a
     * table opened) so a live surface can rebuild. Used by the Queries view and
     * the start page.
     *
     * @param listener - Called after any workspace-data change.
     */
    onWorkspaceChanged(listener: () => void): void {
        this._workspaceListeners.push(listener);
    }

    /** Remember a just-opened table (dedupe by panel id, move-to-front, capped). */
    private rememberTable(ref: DbObjectRef, node: TreeNode): void {
        const id       = this.panelId(ref);
        const existing = this._recentTables.findIndex(t => this.panelId(t.ref) === id);

        if (existing >= 0) {
            this._recentTables.splice(existing, 1);
        }

        this._recentTables.unshift({ ref, node });
        this._recentTables.length = Math.min(this._recentTables.length, MAX_RECENT_TABLES);
        this.notifyWorkspaceChanged();
    }

    /** Record a completed run in history and refresh the workspace surfaces. */
    private recordRun(entry: HistoryEntry): void {
        this._history.record(entry);
        this.notifyWorkspaceChanged();
    }

    /** Notify every workspace-change listener that the stored data changed. */
    private notifyWorkspaceChanged(): void {
        this._workspaceListeners.forEach(listener => listener());
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

        const cached = this._openPanels.get(this.panelId(ref))?.columns
                       ?? this._openPanels.get(this.structurePanelId(ref))?.columns;

        if (cached) {
            this.properties.show(ref, cached);

            return;
        }

        try {
            const columns = await getColumns(ref);

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
     * Fetch the role list for the Roles view's tree. The connection id stays
     * encapsulated here; the caller maps the result to nodes and reports any
     * failure via {@link notifyError}.
     */
    loadRoles(): Promise<RoleSummary[]> {
        return getRoles(this._connectionId);
    }

    /**
     * Show the selected role's base info (attributes + memberships) in the roles
     * inspector and open (or focus) its grants tab in the Dock work area. A
     * monotonic guard discards a stale fetch whose selection has since changed,
     * so rapid role clicks never render the wrong role.
     */
    async showRole(name: string): Promise<void> {
        const seq = ++this._roleSeq;

        try {
            const detail = await getRoleDetail(this._connectionId, name);

            if (seq === this._roleSeq) {
                this.rolesProperties.show(detail);
                this.openRoleGrants(name, detail.privileges);
            }
        } catch (err) {
            if (seq === this._roleSeq) {
                this.notifyError(err);
            }
        }
    }

    /**
     * Open the role's table grants in a Dock tab, or focus the existing one. The
     * tab is deduped by role (mirroring how a table opens its data tab); the
     * grids are read-only and a role's grants do not change within a session, so
     * a re-selection focuses the open tab without refetching its contents.
     */
    private openRoleGrants(role: string, privileges: RolePrivilege[]): void {
        const id = `grants/${this._connectionId}/${role}`;

        if (this.dock.focusPanel(id)) {
            return;
        }

        this.panelOpened();
        this.dock.addPanel({
            id,
            title  : `Grants: ${role}`,
            content: RoleGrantsPanel(privileges),
        });
    }

    /** Report a sync outcome: each failure as an error, or a success message. */
    private reportSync(event: StoreSyncEvent, ref: DbObjectRef): void {
        if (event.failures.length > 0) {
            event.failures.forEach((f: StoreExceptionEvent) => this.notifyError(f.error, ref));

            return;
        }

        this.statusBar.setMessage(`${this._connectionId} · ${ref.name}: changes saved`);
    }

    /** Surface an error (AjaxError detail, or any thrown value) to the StatusBar. */
    notifyError(error: unknown, ref?: DbObjectRef): void {
        const where = ref?.name ? ` (${ref.name})` : "";
        this.statusBar.setMessage(`Error${where}: ${this.errorMessage(error)}`);
    }

    /**
     * Stable panel id so re-opening focuses the existing panel. Includes the
     * connection and database so same-named tables in different databases (e.g.
     * `postgres` vs `sqladmin`, both with `public.customers`) never collide.
     */
    private panelId(ref: DbObjectRef): string {
        return `${ref.connectionId}/${ref.database}/${ref.schema}.${ref.name}`;
    }

    /** Stable id for a table's structure tab, distinct from its data tab. */
    private structurePanelId(ref: DbObjectRef): string {
        return `${this.panelId(ref)}::structure`;
    }

    /** Stable id for a view's definition tab, distinct from its data/structure tabs. */
    private definitionPanelId(ref: DbObjectRef): string {
        return `${this.panelId(ref)}::definition`;
    }

    /**
     * Hover tooltip for a tab: the object name, then Type/Schema/Database ordered
     * most-specific to broadest.
     */
    private panelTooltip(ref: DbObjectRef): string {
        return `${ref.name}\n\nType: ${relationTypeLabel(ref.kind)}\nSchema: ${ref.schema}\nDatabase: ${ref.database}`;
    }

    /** Drop a closed panel's store from the registry and update the start page. */
    private disposePanel(id: string): void {
        this._openPanels.delete(id);
        this.panelClosed();
    }

    /** Record that a panel opened: bump the count and hide the start page. */
    private panelOpened(): void {
        this._openPanelCount++;
        this._startToggle?.(false);
    }

    /** Record that a panel closed: drop the count and show the start page at 0. */
    private panelClosed(): void {
        this._openPanelCount = Math.max(0, this._openPanelCount - 1);

        if (this._openPanelCount === 0) {
            this._startToggle?.(true);
        }
    }

    /** Select the panel's navigator node and refresh the status bar to match. */
    private syncToPanel(id: string): void {
        const panel = this._openPanels.get(id);

        if (!panel) {
            return;
        }

        if (panel.node) {
            this._navigator?.selectNode(panel.node);
        }

        this.updateStatusFor(panel);
        void this.showProperties(panel.ref);
    }

    /**
     * Find an already-loaded navigator node for `ref`, matching on the node's
     * `DbObjectRef` by database/schema/name. Walks only nodes whose children are
     * loaded (never forcing a lazy load), so an FK target under an unexpanded
     * branch yields undefined and the caller opens the tab without a reveal.
     *
     * @param ref - The object to locate.
     *
     * @returns The matching loaded node, or undefined when none is loaded.
     */
    private findLoadedNode(ref: DbObjectRef): TreeNode | undefined {
        const roots = this._navigator?.getNodes() ?? [];
        const stack = [...roots];

        while (stack.length > 0) {
            const node = stack.pop() as TreeNode;
            const data = node.data as DbObjectRef | undefined;

            if (data && data.database === ref.database && data.schema === ref.schema && data.name === ref.name) {
                return node;
            }

            if (node.children) {
                stack.push(...node.children);
            }
        }

        return undefined;
    }

    /** Status line for a panel: row count for a data tab, else the detail label. */
    private updateStatusFor(panel: OpenPanel): void {
        if (panel.store) {
            const count = panel.store.getTotalCount() ?? panel.store.getRecords().length;
            this.statusBar.setMessage(`${this._connectionId} · ${panel.ref.name}: ${count} rows`);
        } else {
            this.statusBar.setMessage(`${this._connectionId} · ${panel.ref.name}: ${panel.detail ?? "structure"}`);
        }
    }

    /** Prefer an AjaxError's parsed {detail}; fall back to a message or string. */
    private errorMessage(error: unknown): string {
        const e = error as { body?: unknown; message?: unknown };
        const detail = this.detailOf(e?.body);

        if (detail) {
            return detail;
        }

        if (typeof e?.message === "string" && e.message) {
            return e.message;
        }

        return String(error);
    }

    /**
     * Extract a readable message from a backend error body. A domain error's
     * `detail` is a string; a FastAPI validation error's `detail` is an array of
     * `{msg, ...}` entries, which are joined.
     */
    private detailOf(body: unknown): string | null {
        if (!body || typeof body !== "object") {
            return null;
        }

        const detail = (body as { detail?: unknown }).detail;

        if (typeof detail === "string") {
            return detail;
        }

        if (Array.isArray(detail)) {
            return detail
                .map(d => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
                .join("; ");
        }

        return null;
    }
}
