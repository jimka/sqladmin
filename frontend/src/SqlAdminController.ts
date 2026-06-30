// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.

import { Dock }                                                from "@jimka/typescript-ui/overlay";
import type { DockPanelEvent }                                 from "@jimka/typescript-ui/overlay";
import { StatusBar }                                           from "@jimka/typescript-ui/component/container";
import type { Tree, TreeNode }                                 from "@jimka/typescript-ui/component/tree";
import type { AjaxStore, StoreExceptionEvent, StoreSyncEvent } from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef, RoleSummary }           from "./contract";
import { getColumns, getRoleDetail, getRoles, runQuery }       from "./data/api";
import { buildModel }                                          from "./data/buildModel";
import { buildSelectSql }                                      from "./data/sql";
import { buildStore }                                          from "./data/stores";
import { TableWorkPanel }                                      from "./dock/TableWorkPanel";
import { StructurePanel }                                      from "./dock/StructurePanel";
import { QueryPanel }                                          from "./dock/QueryPanel";
import { PropertiesPanel }                                     from "./properties/PropertiesPanel";
import { RolesPropertiesPanel }                                from "./roles/RolesPropertiesPanel";

/** Registry entry for one open dock panel; `store` is absent for structure tabs. */
interface OpenPanel {
    ref: DbObjectRef;
    node: TreeNode;
    store?: AjaxStore;
    columns: ColumnMeta[];
}

export class SqlAdminController {
    readonly dock           : Dock;
    readonly statusBar      : StatusBar;
    readonly properties     : PropertiesPanel;
    readonly rolesProperties: RolesPropertiesPanel;

    private readonly _connectionId: string;
    private readonly _openPanels  : Map<string, OpenPanel> = new Map();
    private _navigator            : Tree | null = null;

    // Monotonic counter minting unique ids for scratch query panels, which are
    // never deduped (each "New Query" / "Open as query" opens a fresh panel).
    private _queryCounter: number = 0;

    // Bumped on every showProperties call so a slow column fetch whose selection
    // has since moved on is discarded instead of clobbering the current view.
    private _propsSeq: number = 0;

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

        // Disposal is wired once: the dock fires "close" only on genuine
        // destruction (a tear-off fires "detach" and the panel survives).
        this.dock.on("close", (e: DockPanelEvent) => this.disposePanel(e.id));

        // Switching tabs syncs the navigator selection and the status bar to the
        // now-active panel. A null payload means no panel is focused.
        this.dock.on("focus", (e: DockPanelEvent | null) => {
            if (e) {
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

    /** Open a table in the Dock (deduping by panel id), wiring its store errors. */
    async openTable(ref: DbObjectRef, node: TreeNode): Promise<void> {
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

        store.on("exception", (e: StoreExceptionEvent) => this.notifyError(e.error, ref));
        store.on("sync", (e: StoreSyncEvent) => this.reportSync(e, ref));
        this._openPanels.set(id, { ref, node, store, columns });

        // Open lazily: the tab appears at once, and the grid UI builds on first
        // activation behind a spinner, so a wide table never blocks the tab.
        const notify = (message: string): void => this.statusBar.setMessage(`${this._connectionId} · ${ref.name}: ${message}`);
        this.dock.addLazyPanel({
            id,
            title  : ref.name ?? id,
            tooltip: this.panelTooltip(ref),
            content: () => TableWorkPanel(store, columns, notify)
        });

        try {
            await store.load();
            this.syncToPanel(id);
        } catch {
            // load() rethrows, but the 'exception' listener already surfaced it.
        }
    }

    /** Open a read-only structure (column metadata) tab for a table/view. */
    async openStructure(ref: DbObjectRef, node: TreeNode): Promise<void> {
        const id = this.structurePanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let columns: ColumnMeta[];

        try {
            columns = await getColumns(ref);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        this._openPanels.set(id, { ref, node, columns });
        this.dock.addPanel({
            id,
            title  : `${ref.name ?? id} (structure)`,
            tooltip: this.panelTooltip(ref),
            content: StructurePanel(columns)
        });
        this.syncToPanel(id);
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
     * @param seedSql - SQL to prefill the editor with and run on open.
     */
    openQuery(seedSql?: string): void {
        const n  = ++this._queryCounter;
        const id = `query-${n}`;

        const notify = (message: string): void =>
            this.statusBar.setMessage(`${this._connectionId} · Query ${n}: ${message}`);

        this.dock.addPanel({
            id,
            title  : `Query ${n}`,
            content: QueryPanel({
                runQuery  : sql => runQuery(this._connectionId, sql),
                notify,
                onError   : error => this.notifyError(error),
                initialSql: seedSql,
                autoRun   : seedSql !== undefined
            })
        });
    }

    /**
     * Open a table/view "as a query": a generated `SELECT * FROM … LIMIT n` in a
     * new query panel (the phpMyAdmin drop-to-SQL affordance). Additive to
     * `openTable`, never a replacement — the CRUD panel stays the primary open.
     *
     * @param ref - The table/view to browse as a query.
     */
    openQueryFor(ref: DbObjectRef): void {
        this.openQuery(buildSelectSql(ref));
    }

    /**
     * Show the selected object's metadata in the Properties inspector. A database
     * or schema renders immediately; a table/view needs its columns (for the
     * count and primary key), reused from an open panel when possible and fetched
     * otherwise. A monotonic guard discards a stale fetch whose selection has
     * since changed, so rapid clicks never render the wrong object.
     */
    async showProperties(ref: DbObjectRef): Promise<void> {
        const seq = ++this._propsSeq;

        if (ref.kind !== "table" && ref.kind !== "view") {
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
     * Show the named role's attributes, memberships, and table privileges in the
     * roles inspector. A monotonic guard discards a stale fetch whose selection
     * has since changed, so rapid role clicks never render the wrong role.
     */
    async showRole(name: string): Promise<void> {
        const seq = ++this._roleSeq;

        try {
            const detail = await getRoleDetail(this._connectionId, name);

            if (seq === this._roleSeq) {
                this.rolesProperties.show(detail);
            }
        } catch (err) {
            if (seq === this._roleSeq) {
                this.notifyError(err);
            }
        }
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

    /** Hover tooltip for a tab: the table name, its database, and its schema. */
    private panelTooltip(ref: DbObjectRef): string {
        return `${ref.name}\n\nDatabase: ${ref.database}\nSchema: ${ref.schema}`;
    }

    /** Drop a closed panel's store from the registry. */
    private disposePanel(id: string): void {
        this._openPanels.delete(id);
    }

    /** Select the panel's navigator node and refresh the status bar to match. */
    private syncToPanel(id: string): void {
        const panel = this._openPanels.get(id);

        if (!panel) {
            return;
        }

        this._navigator?.selectNode(panel.node);
        this.updateStatusFor(panel);
        void this.showProperties(panel.ref);
    }

    /** Status line for a panel: row count for a data tab, else a structure label. */
    private updateStatusFor(panel: OpenPanel): void {
        if (panel.store) {
            const count = panel.store.getTotalCount() ?? panel.store.getRecords().length;
            this.statusBar.setMessage(`${this._connectionId} · ${panel.ref.name}: ${count} rows`);
        } else {
            this.statusBar.setMessage(`${this._connectionId} · ${panel.ref.name}: structure`);
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
