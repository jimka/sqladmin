// The query workspace: scratch query panels, the run-history/saved-query/
// notes localStorage stores, recently opened tables, and the Queries
// activity-bar view's own wiring — split out of SqlAdminController.ts. Owns
// state nothing else touches (three per-connection stores, the recent-tables
// list, the scratch-panel counter), which is what makes it a genuinely
// self-contained collaborator rather than a per-kind grouping (see the
// plan's Architecture Decisions).

import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import { Dialog } from "@jimka/typescript-ui/overlay";
import type { DbObjectRef } from "../contract";
import type { ActiveExport } from "../data/explain";
import { runExplain, runQuery, getStructure } from "../data/api";
import { buildSelectSql, buildRoutineCallSql, routineCallIsComplete } from "../data/sql";
import { QueryHistoryStore, SavedQueryStore } from "../data/queryStore";
import type { HistoryEntry, SavedQuery } from "../data/queryStore";
import { NotesStore } from "../data/notesStore";
import { QueryPanel } from "../dock/QueryPanel";
import { DocumentationPanel } from "../dock/DocumentationPanel";
import { promptQueryName } from "../promptQueryName";
import { notesPath } from "../shell/routeTargets";
import { panelId, notesPanelId, elideName } from "./controllerText";
import type { PanelHost, RecentTable } from "./panelHost";
import type { DdlLaunchers } from "./ddlLaunchers";

/** A focusable section of the Queries view — the Saved or the Recent list. */
export type QueriesSection = "saved" | "recent";

// How many recently opened tables the start page lists. Small enough to stay a
// glanceable "jump back in" strip, not a full history.
const MAX_RECENT_TABLES = 8;

export class QueryWorkspace {
    private readonly host: PanelHost;
    private readonly ddl: DdlLaunchers;

    // The per-connection localStorage stores backing the Queries view, the start
    // page, and the panel's Ctrl+↑/↓ recall.
    private readonly _history: QueryHistoryStore;
    private readonly _saved  : SavedQueryStore;
    private readonly _notes  : NotesStore;

    // Recently opened tables (newest-first), surfaced on the start page.
    private readonly _recentTables: RecentTable[] = [];

    // Monotonic counter minting unique ids for scratch query panels, which are
    // never deduped (each "New Query" / "Open as query" opens a fresh panel).
    private _queryCounter: number = 0;

    private _showQueriesView    : (() => void) | null = null;
    private _focusQueriesSection: ((section: QueriesSection) => void) | null = null;

    // Listeners rebuilt when the workspace data changes (a run recorded, a query
    // saved/removed, a table opened) — the Queries view and the start page.
    private readonly _workspaceListeners: Array<() => void> = [];

    /**
     * @param host - The shared app services (Dock, status/error, panel registry).
     * @param ddl - The index advisor's "Create index…" launcher.
     * @param username - The signed-in database user, scoping the three
     *   localStorage stores. Falls back to "default" when absent (a bare
     *   test construction), keeping the storage key well-formed.
     */
    constructor(host: PanelHost, ddl: DdlLaunchers, username: string | undefined) {
        this.host = host;
        this.ddl  = ddl;

        // Every localStorage store is scoped to the signed-in user so nothing
        // bleeds between users on a shared browser. Production storage is the
        // DOM localStorage (persisted per user and connection); the pure
        // stores keep it injected so their logic tests run DOM-less. History,
        // saved queries, and notes are the user's own work against a specific
        // database, so they carry both the user and connection.
        const userId = username || "default";

        this._history = new QueryHistoryStore(userId, host.connectionId, window.localStorage);
        this._saved   = new SavedQueryStore(userId, host.connectionId, window.localStorage);
        this._notes   = new NotesStore(userId, host.connectionId, window.localStorage);
    }

    /**
     * Open a fresh scratch query panel, optionally seeded with SQL to run on
     * open. Each call mints a new id, so re-invoking always opens a new panel
     * (no dedup — the natural behaviour for a scratch buffer).
     *
     * Query panels are deliberately NOT registered in the open-panel registry:
     * they carry no `ref`/`node`/`columns` and need no dedup or focus-sync, so
     * the table-panel lifecycle (`registerPanel`/`syncToPanel`) stays
     * untouched. Nothing holds a reference back to the panel — the Dock
     * destroys its content, and every live CodeEditor beneath it, when its
     * tab closes.
     *
     * @param seedSql - SQL to prefill the editor with.
     * @param run - Whether to execute the seeded SQL on open. Defaults to
     *   `false` — opening seeds the editor only; a caller that wants the
     *   phpMyAdmin "run immediately" behaviour (Open-as-query, "Execute") opts in.
     * @param title - The tab title (and status-line label). Defaults to
     *   `Query N`; a saved query passes its name so the tab reads as the query.
     * @param explain - Auto-EXPLAIN the seeded SQL on open instead of running it
     *   (`"plain"` / `"analyze"`); used by the view panel's Explain actions.
     */
    openQuery(seedSql?: string, run: boolean = false, title?: string, explain?: "plain" | "analyze"): void {
        const n     = ++this._queryCounter;
        const id    = `query-${n}`;
        const label = title ?? `Query ${n}`;

        // The tab keeps the full name; only the status line, which has to fit a
        // scope and a message beside it, spends a bounded amount on the label.
        const statusLabel = elideName(label);

        const notify = (message: string): void => {
            this.host.status(`${statusLabel}: ${message}`);
        };

        const panel = new QueryPanel({
            runQuery  : sql => runQuery(this.host.connectionId, sql),
            runExplain: (sql, opts) => runExplain(this.host.connectionId, sql, opts),
            notify,
            onError   : error => this.host.notifyError(error),
            initialSql : seedSql,
            autoRun    : run,
            autoExplain: explain,
            // Record every run in history and feed the panel's Ctrl+↑/↓ recall.
            // The store dependency stays here — the panel is a pure view over
            // these injected callbacks (matching notify/onError).
            onRun     : (entry: HistoryEntry) => this.recordRun(id, entry),
            getHistory: () => this._history.list().map(e => e.sql),
            // The Save toolbar button hands back the trimmed SQL; the
            // workspace owns the naming modal and the saved-query store.
            onSave    : (sql: string) => void this.promptAndSaveQuery(sql),
            // Mirror this panel's latest exportable result (rows or plan) so
            // the menubar export can reach it while it is the active panel.
            onResult  : (active: ActiveExport | null) => this.host.setActiveExport(id, active),
            splitLayout         : this.host.layout.bindSplit("query"),
            explainDiagramLayout: this.host.layout.bindAccordion("explainDiagram"),
            // The advisor needs a database name for /structure; omitted (no
            // strip, no suggestions computed) when the host has none.
            indexAdvisor: this.host.database === undefined ? undefined : {
                loadTableStructure: (schema: string, relation: string) => getStructure({
                    connectionId: this.host.connectionId, database: this.host.database, schema, name: relation, kind: "table",
                }),
                onCreateIndex: (schema: string, relation: string, columns: string[]) =>
                    void this.ddl.createSuggestedIndex(schema, relation, columns),
            },
        });

        this.host.dock.addPanel({ id, title: label, glyph: "terminal", content: panel.content });
    }

    /**
     * Open a table/view "as a query": a generated `SELECT * FROM … LIMIT n` in a
     * new query panel (the phpMyAdmin drop-to-SQL affordance). Additive to
     * `ObjectPanels.openTable`, never a replacement — the CRUD panel stays the
     * primary open.
     *
     * @param ref - The table/view to browse as a query.
     */
    openQueryFor(ref: DbObjectRef): void {
        this.openQuery(buildSelectSql(ref), true);
    }

    /**
     * Open a new query tab seeded with a call to this function/procedure, so
     * the routine can actually be run (the navigator's "Execute"/"Call"
     * launcher). A function is seeded as `SELECT * FROM …`, a procedure as
     * `CALL …` (see buildRoutineCallSql). A zero-argument routine's call is
     * complete, so it auto-runs; one with arguments seeds its signature as an
     * inline comment to fill in and waits for the user to run it.
     *
     * @param ref - the function/procedure to call.
     */
    executeFunction(ref: DbObjectRef): void {
        const verb = ref.isProcedure ? "Call" : "Run";

        this.openQuery(buildRoutineCallSql(ref), routineCallIsComplete(ref), `${verb} ${ref.name}`);
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
        this.host.status(`Saved query as “${elideName(name)}”`);
    }

    /**
     * Confirm (via the in-app modal), then remove a saved query and refresh the
     * workspace surfaces. Cancelling leaves the saved query untouched.
     *
     * @param name - The saved query's name.
     */
    async removeSavedQuery(name: string): Promise<void> {
        const confirmed = await Dialog.confirm(
            "Remove saved query",
            `Are you sure that you want to remove the saved query “${elideName(name)}”?`,
        );

        if (!confirmed) {
            return;
        }

        this._saved.remove(name);
        this.notifyWorkspaceChanged();
    }

    /**
     * Open (or focus) the singleton documentation/notes tab for this connection:
     * a WYSIWYG DocumentationPanel seeded from and persisting to the
     * per-connection notes store. Not registered in the open-panel registry (it
     * carries no `DbObjectRef`), matching how scratch query panels are handled.
     */
    openDocumentation(): void {
        const id = notesPanelId(this.host.connectionId);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const panel = new DocumentationPanel(
            this._notes.load(),
            markdown => this._notes.save(markdown),
        );

        this.host.setPanelRoute(id, notesPath());

        this.host.dock.addPanel({ id, title: "Notes", glyph: "file-lines", content: panel.content });
    }

    /** @returns The run history, newest-first (for the Queries view's Recent section). */
    historyList(): HistoryEntry[] {
        return this._history.list();
    }

    /** @returns The saved queries, sorted by name (for the Queries view + start page). */
    savedList(): SavedQuery[] {
        return this._saved.list();
    }

    /** @returns The recently opened tables, newest-first (for the start page). */
    recentTables(): DbObjectRef[] {
        return this._recentTables.map(t => t.ref);
    }

    /**
     * The remembered entry whose panel id matches `ref`, for the
     * coordinator's own `reopenTable`.
     *
     * @param ref - The table ref to look up (matched by panel id).
     */
    recentEntry(ref: DbObjectRef): RecentTable | undefined {
        return this._recentTables.find(t => panelId(t.ref) === panelId(ref));
    }

    /** Remember a just-opened table (dedupe by panel id, move-to-front, capped). */
    rememberTable(ref: DbObjectRef, node: TreeNode): void {
        const id       = panelId(ref);
        const existing = this._recentTables.findIndex(t => panelId(t.ref) === id);

        if (existing >= 0) {
            this._recentTables.splice(existing, 1);
        }

        this._recentTables.unshift({ ref, node });
        this._recentTables.length = Math.min(this._recentTables.length, MAX_RECENT_TABLES);
        this.notifyWorkspaceChanged();
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

    /** Save (upsert) a named query and refresh the workspace surfaces. */
    private saveQuery(name: string, sql: string): void {
        this._saved.save(name, sql);
        this.notifyWorkspaceChanged();
    }

    /**
     * Record a completed run in history, remember it as this panel's latest
     * run for the address-bar sync (via `PanelHost.recordQueryRun`, which also
     * re-syncs the address bar when `id` is still the focused panel — see its
     * own doc), and refresh the workspace surfaces.
     *
     * @param id - The query panel's id (resolveAddressBarRoute's fallback key).
     * @param entry - The completed run.
     */
    private recordRun(id: string, entry: HistoryEntry): void {
        this._history.record(entry);
        this.host.recordQueryRun(id, entry.timestamp);
        this.notifyWorkspaceChanged();
    }

    /** Notify every workspace-change listener that the stored data changed. */
    private notifyWorkspaceChanged(): void {
        this._workspaceListeners.forEach(listener => listener());
    }
}
