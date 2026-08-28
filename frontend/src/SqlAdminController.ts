// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.

import { Dialog, Dock, Menu, Notification, NotificationHistoryButton, Tooltip }                                                                                                                    from "@jimka/typescript-ui/overlay";
import type { DockPanelEvent, DockExceptionEvent }                                                                                                                                                 from "@jimka/typescript-ui/overlay";
import { Component, Util }                                                                                                                                                                         from "@jimka/typescript-ui/core";
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
import type { TreeNode }                                                                                                                                                                           from "@jimka/typescript-ui/component/tree";
import type { ExplorerTree }                                                                                                                                                                       from "./navigator/NavigatorTree";
import { showObjectMenu }                                                                                                                                                                          from "./navigator/objectMenu";
import { matchesGrantedTable, matchesObject, matchesRelationName, matchesRole, matchesRoleSection }                                                                                                from "./navigator/revealMatch";
import type { NodeMatch }                                                                                                                                                                          from "./navigator/revealMatch";
import { objectPath, rolePath, databaseDiagramPath, notesPath, resolveAddressBarRoute }                                                                                                            from "./shell/routeTargets";
import type { PanelRoute }                                                                                                                                                                         from "./shell/routeTargets";
import type { AjaxStore, StoreExceptionEvent, StoreSyncEvent }                                                                                                                                     from "@jimka/typescript-ui/data";
import type { ColumnMeta, ConstraintKind, DbObjectRef, FunctionDefinition, RelationNodeRef, RoleDetail, RolePrivilege, RoleSummary, TypeDefinition } from "./contract";
import { executeDdl, getColumns, getDatabaseGraph, getDependencies, getFunctionDefinition, getInheritance, getRoleDetail, getRoles, getSchemaGraph, getSchemas, getTablePrivileges, getTypeDefinition, getViewDefinition, getStructure, previewAlterSequence, previewAlterTable, previewAlterTypeAddValue, previewConstraint, previewCreateCompositeType, previewCreateEnumType, previewCreateFunction, previewCreateMatview, previewCreateSchema, previewCreateSequence, previewCreateTable, previewCreateView, previewDropFunction, previewDropMatview, previewDropSchema, previewDropSequence, previewDropTable, previewDropType, previewDropView, previewIndex, previewRefreshMatview, previewRenameSchema, previewReplaceMatview, previewSequenceOwner, runExplain, runQuery, tableExportUrl } from "./data/api";
import { getSequenceDetail }                                                                                                                                                                       from "./data/api";
import { getIndexDetail }                                                                                                                                                                          from "./data/api";
import { exportQueryResult }                                                                                                                                                                       from "./dock/exportQueryResult";
import { exportExplainPlan }                                                                                                                                                                       from "./dock/exportExplainResult";
import type { ActiveExport }                                                                                                                                                                       from "./data/explain";
import { buildModel }                                                                                                                                                                              from "./data/buildModel";
import { buildSchemaDiagram }                                                                                                                                                                      from "./data/buildSchemaDiagram";
import { annotateFkCardinality }                                                                                                                                                                   from "./data/fkCardinality";
import { buildRoleMembershipDiagram }                                                                                                                                                              from "./data/buildRoleMembershipDiagram";
import { buildRoleGrantsDiagram }                                                                                                                                                                  from "./data/buildRoleGrantsDiagram";
import { buildRelationGraph, relationNodeId }                                                                                                                                                      from "./data/buildRelationGraph";
import { buildSelectSql, buildRoutineCallSql, routineCallIsComplete }                                                                                                                              from "./data/sql";
import { buildStore }                                                                                                                                                                              from "./data/stores";
import { TableWorkPanel }                                                                                                                                                                          from "./dock/TableWorkPanel";
import type { TableViewOptions }                                                                                                                                                                   from "./dock/TableWorkPanel";
import { StructurePanel }                                                                                                                                                                          from "./dock/StructurePanel";
import type { StructureActions, StructureRefresh }                                                                                                                                                from "./dock/StructurePanel";
import { openSqlPreviewDialog }                                                                                                                                                                    from "./dock/SqlPreviewDialog";
import { CreateTableForm }                                                                                                                                                                         from "./dock/CreateTableForm";
import { RenameTableForm }                                                                                                                                                                         from "./dock/RenameTableForm";
import { ConstraintForm }                                                                                                                                                                          from "./dock/ConstraintForm";
import { IndexForm }                                                                                                                                                                               from "./dock/IndexForm";
import { ConfirmCascadeForm }                                                                                                                                                                      from "./dock/ConfirmCascadeForm";
import { openViewDialog }                                                                                                                                                                          from "./dock/ViewFormDialog";
import { openMaterializedViewDialog }                                                                                                                                                              from "./dock/MaterializedViewFormDialog";
import { openDropRelationDialog, openRefreshMatviewDialog }                                                                                                                                        from "./dock/RelationDdlActions";
import { stripTrailingSemicolon }                                                                                                                                                                  from "./dock/ddlSpecs";
import { openCreateSchemaDialog, openDropSchemaDialog, openRenameSchemaDialog }                                                                                                                    from "./dock/SchemaDdlForms";
import { openCreateSequenceDialog, openDropSequenceDialog }                                                                                                                                        from "./dock/SequenceDdlForms";
import { FunctionForm }                                                                                                                                                                            from "./dock/FunctionForm";
import { EnumTypeForm }                                                                                                                                                                            from "./dock/EnumTypeForm";
import { CompositeTypeForm }                                                                                                                                                                       from "./dock/CompositeTypeForm";
import { AddEnumValueForm }                                                                                                                                                                        from "./dock/AddEnumValueForm";
import { buildDropFunctionSpec, buildDropTypeSpec }                                                                                                                                                from "./dock/ddlSpecs";
import { DefinitionPanel }                                                                                                                                                                         from "./dock/DefinitionPanel";
import { FunctionDefinitionPanel }                                                                                                                                                                 from "./dock/FunctionDefinitionPanel";
import { SequenceInfoPanel }                                                                                                                                                                       from "./dock/SequenceInfoPanel";
import { IndexInfoPanel }                                                                                                                                                                          from "./dock/IndexInfoPanel";
import { DocumentationPanel }                                                                                                                                                                      from "./dock/DocumentationPanel";
import { QueryPanel }                                                                                                                                                                              from "./dock/QueryPanel";
import { RoleGrantsPanel }                                                                                                                                                                         from "./dock/RoleGrantsPanel";
import { exportRoleGrants }                                                                                                                                                                        from "./dock/exportRoleGrants";
import { SchemaDiagramPanel }                                                                                                                                                                      from "./dock/SchemaDiagramPanel";
import { RelationDiagramPanel }                                                                                                                                                                    from "./dock/RelationDiagramPanel";
import { DatabaseDiagramPanel }                                                                                                                                                                    from "./dock/DatabaseDiagramPanel";
import type { SchemaTables }                                                                                                                                                                       from "./data/buildDatabaseDiagram";
import { RoleGrantsDiagramPanel }                                                                                                                                                                  from "./dock/RoleGrantsDiagramPanel";
import { RelationGraphPanel }                                                                                                                                                                      from "./dock/RelationGraphPanel";
import { RootedRelationGraphPanel }                                                                                                                                                                from "./dock/RootedRelationGraphPanel";
import type { DiagramData, DiagramNodeData }                                                                                                                                                       from "@jimka/typescript-ui/component/diagram";
import { PropertiesPanel, relationTypeLabel }                                                                                                                                                      from "./properties/PropertiesPanel";
import { RolesPropertiesPanel }                                                                                                                                                                    from "./roles/RolesPropertiesPanel";
import { KIND_GLYPH }                                                                                                                                                                              from "./navigator/objectGlyphs";
import { QueryHistoryStore, SavedQueryStore }                                                                                                                                                      from "./data/queryStore";
import type { HistoryEntry, SavedQuery }                                                                                                                                                           from "./data/queryStore";
import { NotesStore }                                                                                                                                                                              from "./data/notesStore";
import { LayoutStore }                                                                                                                                                                             from "./data/layoutStore";
import { promptQueryName }                                                                                                                                                                         from "./promptQueryName";

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

// How much of a user-supplied name a status message may spend. A saved query's
// name is free text with no length limit of its own, and the status bar is one
// line — past this the name crowds out the message it is there to label.
const MAX_STATUS_NAME_CHARS = 40;

/**
 * Shorten a free-text name to fit a status message, eliding the tail so the
 * ellipsis reads as "there is more name here" rather than a truncation the user
 * has to guess at. The full name still shows wherever it has room to breathe —
 * the tab title, the Queries view.
 *
 * @param name - The name as the user typed it.
 * @returns The name, tail-elided when it runs past MAX_STATUS_NAME_CHARS.
 */
function elideName(name: string): string {
    if (name.length <= MAX_STATUS_NAME_CHARS) {
        return name;
    }

    // Trailing space before the ellipsis reads as a typo, so shed it.
    return `${name.slice(0, MAX_STATUS_NAME_CHARS - 1).trimEnd()}…`;
}

/** The optional hook a diagram-bearing panel exposes so its tab can wait for placement. */
interface LayoutSettlingPanel {
    whenLaidOut(): Promise<void>;
}

/**
 * Hold a lazy tab's spinner until the panel's diagram has placed its nodes, so
 * no tab is ever revealed showing an unplaced graph. The method is probed
 * optionally: the non-diagram panels `openAsyncPanel` builds do not have it and
 * resolve at once.
 *
 * @param content - The freshly built panel.
 *
 * @returns A promise resolving once the panel's first diagram layout settled.
 */
function awaitDiagramLayout(content: Component): Promise<void> {
    const panel = content as unknown as Partial<LayoutSettlingPanel>;

    return panel.whenLaidOut?.() ?? Promise.resolve();
}

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
    // Set only by the five storeless detail tabs (structure, definition,
    // function definition, sequence, index) — what `refreshActive` dispatches
    // to instead of the store-reload path. Never set alongside `store`.
    refresh?: () => void;
}

/** A recently opened table, kept with its node so the start page can re-open it. */
interface RecentTable {
    ref: DbObjectRef;
    node: TreeNode;
}

// How many recently opened tables the start page lists. Small enough to stay a
// glanceable "jump back in" strip, not a full history.
const MAX_RECENT_TABLES = 8;

// Dependency graph reads left-to-right as a dependency flow (view -> underlying),
// matching the FK schema diagram's RIGHT layered layout.
const DEPENDENCY_LAYOUT = { "elk.algorithm": "layered", "elk.direction": "RIGHT" };

// Inheritance reads top-to-bottom as a containment tree (parent above children).
const INHERITANCE_LAYOUT = { "elk.algorithm": "layered", "elk.direction": "DOWN" };

/**
 * A panel-load failure, carrying the object being opened so the Dock's
 * "exception" handler can name it, and whether the error was already
 * surfaced by the fetch helper that produced it.
 */
class PanelLoadError extends Error {
    constructor(
        readonly reason: unknown,
        readonly ref?: DbObjectRef,
        readonly reported: boolean = false,
    ) {
        super("panel load failed");
    }
}

export class SqlAdminController {
    readonly dock           : Dock;
    readonly statusBar      : StatusBar;
    readonly properties     : PropertiesPanel;
    readonly rolesProperties: RolesPropertiesPanel;
    // Public (not private-with-delegators like `_history`): eight layout sites
    // bind against it directly, and mirroring the whole store API onto the
    // controller would carry no information.
    readonly layout         : LayoutStore;

    private readonly _connectionId: string;
    private readonly _database    : string | undefined;
    private readonly _openPanels  : Map<string, OpenPanel> = new Map();
    // Reopens each routed panel at its own URL — set from spec.route in
    // openAsyncPanel (or openDocumentation's direct call), read by the dock's
    // "focus" handler via resolveAddressBarRoute. See routeTargets.ts's PanelRoute.
    private readonly _panelRoutes: Map<string, PanelRoute> = new Map();
    // A query panel's latest recorded run, by panel id — resolveAddressBarRoute's
    // fallback for a panel with no _panelRoutes entry (openTable's view/matview
    // branch deliberately has none — see the plan's Architecture Decision).
    private readonly _queryPanelRuns: Map<string, number> = new Map();
    private _navigator            : ExplorerTree | null = null;
    // The Roles rail's tree, registered the same way the navigator is, so a role
    // opened from a route or a link can drive its selection too.
    private _rolesTree            : ExplorerTree | null = null;
    // The diagram panels' shared right-click menu, mirroring how NavigatorTree
    // and RolesTree each own one reusable Menu(). Named diagramContextMenu (see
    // below), not showObjectMenu, so the method does not shadow the imported
    // module wrapper of the same purpose.
    private readonly _objectMenu: Menu = Menu();

    // The per-connection localStorage stores backing the Queries view, the start
    // page, and the panel's Ctrl+↑/↓ recall.
    private readonly _history: QueryHistoryStore;
    private readonly _saved  : SavedQueryStore;
    private readonly _notes  : NotesStore;

    // Recently opened tables (newest-first), surfaced on the start page.
    private readonly _recentTables: RecentTable[] = [];

    // Shell-injected handles (mirroring how ActivityBar takes a SidebarSizer): one
    // toggles the start-page deck, three select an activity-bar view (Queries,
    // Database, Roles), one focuses a section (Saved/Recent) of the Queries view.
    // The Database/Roles pair brings a revealed object's own tree forward, so a
    // reveal never searches a tree whose deck page is hidden.
    private _startToggle        : ((visible: boolean) => void) | null = null;
    private _showQueriesView    : (() => void) | null = null;
    private _showDatabaseView   : (() => void) | null = null;
    private _showRolesView      : (() => void) | null = null;
    // The address-bar sync hook, wired from SqlAdminApp.ts — see setSyncAddressBar.
    private _syncAddressBar     : ((path: string, query?: Record<string, string>) => void) | null = null;
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

    // In-flight `getColumns` requests, keyed by panel id, so the several column
    // fetches a single navigator double-click triggers collapse into one request
    // (see fetchColumns).
    private readonly _columnsInFlight = new Map<string, Promise<ColumnMeta[]>>();

    // The latest exportable result each query panel displayed — a rows grid or an
    // EXPLAIN plan — keyed by panel id (set via the panel's injected onResult),
    // plus the currently focused panel id. Together they let the menubar "Export
    // results…" item act on the active panel without the controller holding a
    // reference back to the panel object.
    private readonly _activeQueryResult: Map<string, ActiveExport | null> = new Map();
    // A grants tab's full grant set, keyed by panel id, so the active-tab export
    // covers a focused role grants tab the same way _activeQueryResult covers a
    // query panel. Grants tabs are not in _openPanels (no DbObjectRef).
    private readonly _activeRoleGrants: Map<string, { role: string; privileges: RolePrivilege[] }> = new Map();
    private _activePanelId: string | null = null;

    // The same monotonic guard for the Roles view's detail fetch.
    private _roleSeq: number = 0;

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

        // Every localStorage store is scoped to the signed-in user so nothing
        // bleeds between users on a shared browser. Fall back to "default" when the
        // username is absent (a bare test construction), keeping the key well-formed.
        const userId = username || "default";

        // Production storage is the DOM localStorage (persisted per user and
        // connection); the pure stores keep it injected so their logic tests run
        // DOM-less. History, saved queries, and notes are the user's own work
        // against a specific database, so they carry both the user and connection.
        this._history = new QueryHistoryStore(userId, connectionId, window.localStorage);
        this._saved   = new SavedQueryStore(userId, connectionId, window.localStorage);
        this._notes   = new NotesStore(userId, connectionId, window.localStorage);

        // No connectionId — layout is a property of the user's window, not of the
        // database being viewed, so it is scoped per user only (see data/layoutStore.ts).
        this.layout = new LayoutStore(userId, window.localStorage);

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
        // remains (never when DOM focus merely leaves the dock) — so clearing
        // `_activePanelId` here can't affect Query-menu export targeting on an
        // ordinary tab switch. Clearing it also keeps a closed-last-tab Alt+R
        // from invoking a refresh closure holding a torn-down panel.
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
     * Register the navigator tree so the focused tab can drive its
     * selection and table-DDL launchers can trigger its top-level `refresh`.
     */
    setNavigator(tree: ExplorerTree): void {
        this._navigator = tree;
    }

    /**
     * Register the roles tree so a role open can drive its selection, mirroring
     * {@link setNavigator}.
     */
    setRolesTree(tree: ExplorerTree): void {
        this._rolesTree = tree;
    }

    /**
     * Open a relation in the Dock. A table opens the editable TableWorkPanel
     * (deduped by panel id, its store wired for transport errors and
     * write-feedback). A view or materialized view is read-only and has no CRUD
     * surface, so it instead opens as an auto-run browse query —
     * `SELECT * FROM … LIMIT n` on the shared QueryPanel — the same surface its
     * Explain/Export already used; its structure and definition still open as
     * their own tabs from the navigator's right-click menu.
     *
     * The `node` is optional: an FK-referenced table may have no currently-loaded
     * navigator node, so its tab still opens but the focus-sync skips the reveal.
     * It may also be a still-pending `Promise` — an in-progress navigator reveal
     * (see `openReferencedTable`) — so a slow reveal never delays the tab itself;
     * it is awaited alongside the table's own fetch instead of gating it.
     *
     * @param view - The view-mode properties a route can request (record view,
     *   a focused record). Ignored on the view/matview branch above, which
     *   opens a query tab instead of a `TableWorkPanel`.
     */
    async openTable(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>, view?: TableViewOptions): Promise<void> {
        // A view/matview has no editable data surface, so it opens as an auto-run
        // browse query on the shared QueryPanel rather than a dedicated data panel.
        // A query panel has no pagination, so the seed carries buildSelectSql's
        // small preview LIMIT (the user can raise or remove it). Each open mints a
        // fresh query tab (no dedup, like every query panel); it is still recorded
        // in recent tables so it reopens from the start page.
        if (ref.kind === "view" || ref.kind === "materializedView") {
            // Not awaited: remembering the table has no bearing on the query tab
            // that follows, and a pending reveal must not delay it.
            void Promise.resolve(node).then(resolved => { if (resolved) { this.rememberTable(ref, resolved); } });

            this.openQuery(buildSelectSql(ref), true, ref.name);

            return;
        }

        const id = this.panelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        // The address-bar route captured at open time — record/rotated flags
        // only, never a diagram depth (openTable has none); see the plan's
        // "per-panel route registry" Architecture Decision for why this is a
        // one-shot snapshot rather than kept live as the tab's view changes.
        const query: Record<string, string> = {};

        if (view?.rotated) { query.rotated = "true"; }
        if (view?.record)  { query.record  = view.record; }

        const built = objectPath(ref);
        const route: PanelRoute | undefined = built ? { path: built.path, query: Object.keys(query).length > 0 ? query : undefined } : undefined;

        this.openAsyncPanel({
            id,
            title  : ref.name ?? id,
            glyph  : KIND_GLYPH[ref.kind],
            tooltip: this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            // The fetch now runs behind the library's spinner. A throw here closes
            // the tab and reaches the "exception" handler — so no local catch. The
            // requests are independent, so they run concurrently; getColumns is
            // shared with the selection-driven Properties fetch via fetchColumns,
            // and a pending `node` reveal rides along rather than gating any of it.
            const [columns, privileges, resolvedNode] = await Promise.all([
                this.fetchColumns(ref), getTablePrivileges(ref), Promise.resolve(node),
            ]);
            const store = buildStore(ref, buildModel(columns), columns);

            store.on("exception", (e: StoreExceptionEvent) => this.notifyError(e.error, ref));
            store.on("sync", (e: StoreSyncEvent) => this.reportSync(e, ref));

            this._openPanels.set(id, { ref, node: resolvedNode ?? null, store, columns });

            if (resolvedNode) {
                this.rememberTable(ref, resolvedNode);
            }

            const notify = (message: string): void => { this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: ${message}`); };
            const panel = new TableWorkPanel(store, columns, notify, format => this.exportTable(ref, format), privileges, view);

            // Not awaited: the panel already exists, so TablePanel's own store-driven
            // spinner covers the row load, and load()'s rejection is already surfaced by
            // the "exception" listener wired above.
            void store.load().then(() => this.syncToPanel(id)).catch(() => {});

            return panel;
        });
    }

    /**
     * Open an editable definition tab for a view/matview — its Columns grid
     * above its SQL definition (pg_get_viewdef, the SELECT body only),
     * deduping by definition-panel id. The tab opens at once behind the
     * library's spinner; the definition and columns are fetched behind it and
     * passed to a `DefinitionPanel` wired with an `onSave` that builds and
     * executes the edit directly, with no intermediate dialog: `CREATE OR
     * REPLACE VIEW` for a view, or the atomic DROP+CREATE replace pair for a
     * materialized view (a materialized view cannot be CREATE OR REPLACE'd —
     * see the view-matview-ddl plan's "Matview edit strategy" decision). On
     * success the navigator refreshes and the tab reseeds itself in place (via
     * `panel.reload`) rather than closing — the object list may be
     * unaffected, but the tab's own definition/columns just changed. A failed
     * fetch closes the tab it opened, reported through notifyError; a failed
     * save surfaces through notifyError and leaves the tab (and the user's
     * edits) open. Tables have no definition, so the navigator only offers
     * this for views (see NavigatorTree).
     */
    async openDefinition(ref: DbObjectRef, node?: TreeNode): Promise<void> {
        const id = this.definitionPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, "definition") ?? undefined;

        this.openAsyncPanel({
            id,
            title  : `${ref.name ?? id} (definition)`,
            glyph  : "file-code",
            tooltip: this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            // The fetch now runs behind the library's spinner. A throw here closes
            // the tab and reaches the "exception" handler — so no local catch.
            const [definition, columns] = await this.fetchDefinitionAndColumns(ref);

            // Read by `onSave` only after a Save click, which always happens
            // after this variable is assigned just below — the forward
            // reference is safe.
            let panel: DefinitionPanel;

            const onSave = async (newDefinition: string): Promise<void> => {
                // getViewDefinition's pg_get_viewdef output always ends with a
                // semicolon; CreateViewSpec/ReplaceMatviewSpec's `select` expects
                // a bare body with none (see stripTrailingSemicolon's doc — a
                // stray one is harmless for CREATE OR REPLACE VIEW but breaks the
                // matview replace's appended WITH DATA).
                const select = stripTrailingSemicolon(newDefinition);

                try {
                    // cascade is hardcoded false: this tab has no CASCADE
                    // toggle (the dialog's edit mode had one; this Save button
                    // deliberately has no dialog at all — see this method's
                    // doc). A matview with dependents therefore can't be edited
                    // here at all: the DROP half fails with a dependency error,
                    // surfaced below via notifyError, leaving the matview and
                    // the tab untouched; the user must drop the dependent(s)
                    // out-of-band (e.g. the SQL workspace) before retrying.
                    const sql = ref.kind === "materializedView"
                        ? (await previewReplaceMatview(ref, {
                            schema: ref.schema!, name: ref.name!, select, cascade: false, withData: true,
                        })).sql
                        : (await previewCreateView(ref, {
                            schema: ref.schema!, name: ref.name!, select, orReplace: true,
                        })).sql;

                    await executeDdl(this._connectionId, sql);
                } catch (err) {
                    this.notifyError(err, ref);

                    return;
                }

                this._navigator?.refresh?.();

                try {
                    const [reloadedDefinition, reloadedColumns] = await this.fetchDefinitionAndColumns(ref);

                    panel.reload(reloadedDefinition, reloadedColumns);
                } catch (err) {
                    // The save itself already succeeded (executeDdl above didn't
                    // throw) — only the post-save re-fetch failed, so this is
                    // NOT a failed save. Say so explicitly: a bare notifyError
                    // here would read as "the save failed", inviting a retry
                    // that re-runs the (for a matview, destructive) DDL a second
                    // time for no reason.
                    this.notifyError(new Error(`saved, but failed to refresh the tab: ${this.errorMessage(err)}`), ref);

                    return;
                }

                this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: definition saved`);
            };

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                const [freshDefinition, freshColumns] = await this.fetchDefinitionAndColumns(ref);

                panel.reload(freshDefinition, freshColumns);
            });

            panel = new DefinitionPanel(definition, columns, onSave, refresh, this.layout.bindSplit("definition"));

            // No `columns` field here: unlike the structure tab (keyed by
            // structurePanelId, whose `columns` backs structureColumns()), the
            // definition tab's columns are only ever read by the DefinitionPanel
            // itself, which already holds its own copy — nothing looks this
            // entry up by definitionPanelId.
            this._openPanels.set(id, { ref, node: node ?? null, detail: "definition", refresh });
            this.syncToPanel(id);

            return panel.content;
        });
    }

    /**
     * Fetch a view/matview's definition and columns in parallel — shared by
     * `openDefinition`'s initial load and its Save-success reload.
     *
     * @param ref - The view/matview to fetch.
     * @returns A tuple of the definition SQL (the SELECT body only) and the columns.
     */
    private async fetchDefinitionAndColumns(ref: DbObjectRef): Promise<[string, ColumnMeta[]]> {
        const [definitionResult, columns] = await Promise.all([getViewDefinition(ref), getColumns(ref)]);

        return [definitionResult.definition, columns];
    }

    /**
     * Run one of the five detail tabs' Refresh: re-fetch and reseed via
     * `reload`, then report the outcome — the shared success/error wording
     * every Refresh button uses, so the five call sites don't drift apart.
     * Never rejects, so every call site may write `void this.refreshPanel(...)`.
     *
     * @param ref - The tab's own object, for the status message and a failed
     *   fetch's error label.
     * @param reload - The caller's fetch-and-reseed body; its own errors (a
     *   dropped/renamed object, a network failure) are caught here.
     */
    private async refreshPanel(ref: DbObjectRef, reload: () => Promise<void>): Promise<void> {
        try {
            await reload();
        } catch (err) {
            this.notifyError(new Error(`failed to refresh: ${this.errorMessage(err)}`), ref);

            return;
        }

        this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: refreshed`);
    }

    /**
     * Open an editable info tab for a sequence — its current value and
     * parameters (pg_sequences), deduping by sequence-info-panel id. The tab
     * opens at once behind the library's spinner; behind it, the detail and
     * the connection's role names (for the form's Owner combo) are fetched in
     * parallel and passed to a SequenceInfoPanel wired with the alter/owner
     * preview, execute, and reload callbacks its Save flow needs. A failed
     * detail fetch closes the tab it opened, reported through notifyError; a
     * failed roles fetch degrades gracefully instead (the tab still opens,
     * with `roles: []` — see SequenceInfoPanelDeps.roles). A sequence has no
     * rows, so unlike openTable this has no store to register, and unlike
     * openDefinition the panel needs no dispose (see SequenceInfoPanel).
     *
     * `node` may be a still-pending `Promise` — an in-progress navigator reveal
     * (see `openReferencedSequence`) — awaited alongside the detail/roles fetch
     * rather than gating the tab.
     */
    async openSequence(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void> {
        const id = this.sequenceInfoPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref) ?? undefined;

        this.openAsyncPanel({
            id,
            title  : ref.name ?? id,
            glyph  : "arrow-up-1-9",
            tooltip: this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const [[detailResult, rolesResult], resolvedNode] = await Promise.all([
                Promise.allSettled([getSequenceDetail(ref), getRoles(ref.connectionId)]),
                Promise.resolve(node),
            ]);

            if (detailResult.status === "rejected") {
                throw detailResult.reason;
            }

            const detail = detailResult.value;
            const roles  = rolesResult.status === "fulfilled" ? rolesResult.value.map(r => r.name) : [];

            // Read by `refresh` only after a click, which always happens after
            // this variable is assigned just below — the forward reference is
            // safe (mirrors openDefinition/openFunctionDefinition's `panel`).
            let panel: SequenceInfoPanel;

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                panel.reload(await getSequenceDetail(ref));
            });

            this._openPanels.set(id, { ref, node: resolvedNode ?? null, detail: "info", refresh });
            this.syncToPanel(id);

            panel = new SequenceInfoPanel(detail, {
                schema:       ref.schema!,
                name:         ref.name!,
                roles,
                previewAlter: spec => previewAlterSequence(ref, spec),
                previewOwner: spec => previewSequenceOwner(ref, spec),
                execute:      sql => executeDdl(this._connectionId, sql),
                reloadDetail: () => getSequenceDetail(ref),
                onStatus:     m => this.statusBar.setMessage(`${this._statusScope} · ${m}`),
                onError:      m => this.notifyError(new Error(m), ref),
                onRefresh:    refresh,
                onOpenOwner:  (schema, table) => this.openReferencedStructure({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }),
            });

            return panel;
        });
    }

    /**
     * Open a read-only info tab for an index — its owning table, unique/primary
     * flags, and full CREATE INDEX text, deduping by index-info-panel id. The
     * tab opens at once behind the library's spinner; behind it, the detail is
     * fetched fresh (matching openSequence/openFunctionDefinition/openStructure
     * — see the plan's fetch-fresh-on-open decision) and passed to an
     * IndexInfoPanel wired with the "open table" callback. A failed detail
     * fetch closes the tab it opened, reported through notifyError. An index
     * has no rows and no editable fields, so unlike openTable this has no
     * store to register, and unlike openSequence the panel needs no dispose
     * (see IndexInfoPanel).
     *
     * `node` may be a still-pending `Promise` — an in-progress navigator reveal
     * — awaited alongside the detail fetch rather than gating the tab.
     */
    async openIndex(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void> {
        const id = this.indexInfoPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref) ?? undefined;

        this.openAsyncPanel({
            id,
            title  : ref.name ?? id,
            glyph  : "magnifying-glass",
            tooltip: this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const [detail, resolvedNode] = await Promise.all([getIndexDetail(ref), Promise.resolve(node)]);

            // Read by `refresh` only after a click, which always happens after
            // this variable is assigned just below — the forward reference is
            // safe (mirrors openDefinition/openFunctionDefinition's `panel`).
            let panel: IndexInfoPanel;

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                panel.reload(await getIndexDetail(ref));
            });

            this._openPanels.set(id, { ref, node: resolvedNode ?? null, detail: "info", refresh });
            this.syncToPanel(id);

            panel = new IndexInfoPanel(detail, {
                schema: ref.schema!,
                onOpenTable: (schema, table) => this.openReferencedStructure({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }),
                onRefresh: refresh,
            });

            return panel;
        });
    }

    /**
     * Open a read-only structure (column metadata) tab for a table/view.
     *
     * `node` may be a still-pending `Promise` — an in-progress navigator reveal
     * (see `openReferencedStructure`) — awaited alongside the structure fetch
     * rather than gating the tab.
     */
    async openStructure(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void> {
        const id = this.structurePanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, "structure") ?? undefined;

        this.openAsyncPanel({
            id,
            title  : `${ref.name ?? id} (structure)`,
            glyph  : "table-columns",
            tooltip: this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            // The fetch now runs behind the library's spinner. A throw here closes
            // the tab and reaches the "exception" handler — so no local catch. A
            // pending `node` reveal rides along rather than gating the fetch.
            const [columns, structure, resolvedNode] = await Promise.all([
                getColumns(ref), getStructure(ref), Promise.resolve(node),
            ]);

            // Read by `refresh`/the section refreshes only after a click, which
            // always happens after this variable is assigned just below — the
            // forward reference is safe (mirrors openDefinition/
            // openFunctionDefinition's `panel`).
            let panel: StructurePanel;

            // The whole-tab refresh backs Alt+R / View → Refresh (see
            // refreshActive): it re-fetches everything and reseeds all four
            // sections via `panel.reload`, exactly as before this tab grew
            // per-section Refresh tools.
            const refresh = (): void => void this.refreshPanel(ref, async () => {
                const [freshColumns, freshStructure] = await Promise.all([getColumns(ref), getStructure(ref)]);
                const entry = this._openPanels.get(id);

                panel.reload(freshColumns, freshStructure);

                // structureColumns(ref) reads this cache to build the constraint/index
                // dialogs' column checklists — it must track the refreshed columns.
                if (entry) {
                    entry.columns = freshColumns;
                }
            });

            // The four per-section refreshes back each section header's own
            // Refresh tool (StructureRefresh). Indexes/Constraints/Foreign
            // Keys all read the same getStructure(ref) endpoint — each still
            // re-fetches the whole payload (there is no narrower endpoint) but
            // reseeds only its own section, so a click on one section's
            // Refresh never visibly touches the other two sourced from that
            // endpoint (see the plan's per-section-refresh Architecture
            // Decision for why this is worth the redundant fetch).
            const refreshColumns = (): void => void this.refreshPanel(ref, async () => {
                const freshColumns = await getColumns(ref);
                const entry = this._openPanels.get(id);

                panel.reloadColumns(freshColumns);

                if (entry) {
                    entry.columns = freshColumns;
                }
            });

            const refreshIndexes = (): void => void this.refreshPanel(ref, async () => {
                panel.reloadIndexes((await getStructure(ref)).indexes);
            });

            const refreshConstraints = (): void => void this.refreshPanel(ref, async () => {
                panel.reloadConstraints((await getStructure(ref)).constraints);
            });

            const refreshForeignKeys = (): void => void this.refreshPanel(ref, async () => {
                panel.reloadForeignKeys((await getStructure(ref)).foreignKeys);
            });

            const sectionRefresh: StructureRefresh = {
                onRefreshColumns:     refreshColumns,
                onRefreshIndexes:     refreshIndexes,
                onRefreshConstraints: refreshConstraints,
                onRefreshForeignKeys: refreshForeignKeys,
            };

            // The Columns section's Save success callback: the data tab's
            // Model is now stale (a column may have been renamed, retyped,
            // added, or removed), so it closes first — then the same
            // whole-tab `refresh` a Refresh/Alt+R uses reseeds every section
            // in place, rather than removing and reopening the structure tab
            // the way the old per-dialog column launchers did.
            const onColumnsSaved = (): void => {
                this.dock.removePanel(this.panelId(ref));
                refresh();
            };

            this._openPanels.set(id, { ref, node: resolvedNode ?? null, columns, detail: "structure", refresh });
            this.syncToPanel(id);

            panel = new StructurePanel(columns, structure, (refSchema, refTable) =>
                this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : refSchema,
                    name        : refTable,
                    kind        : "table",
                }), (seqSchema, seqName) => this.openReferencedSequence({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : seqSchema,
                    name        : seqName,
                    kind        : "sequence",
                }), sectionRefresh, this.layout.bindAccordion("structure"), this.structureActionsFor(ref, onColumnsSaved));

            return panel;
        });
    }

    /**
     * Build the StructureActions the structure tab's section toolbars call
     * into — one closure per action, each fixed to this tab's own table ref.
     * The Indexes/Constraints/Foreign Keys launchers accept any relation ref
     * uniformly with the rest of the panel (the navigator only offers them on
     * a table node in practice); `columnEdits` is narrower, since a view or
     * matview's Structure tab must keep its Columns grid read-only (see the
     * plan's "Only a table's Structure tab is editable" Architecture Decision).
     *
     * @param ref - The structure tab's own table.
     * @param onColumnsSaved - Invoked after a successful Columns Save —
     *   closes the (now-stale) data tab and reseeds the structure tab in
     *   place. Supplied by `openStructure`, which owns the tab's `refresh` closure.
     */
    private structureActionsFor(ref: DbObjectRef, onColumnsSaved: () => void): StructureActions {
        return {
            onAddConstraint:  kind => void this.addConstraint(ref, kind),
            onDropConstraint: constraintName => this.dropConstraint(ref, constraintName),
            onCreateIndex:    () => this.createIndex(ref),
            onDropIndex:      indexName => this.dropIndex(ref, indexName),
            columnEdits: ref.kind === "table" ? {
                schema:       ref.schema!,
                table:        ref.name!,
                previewAlter: spec => previewAlterTable(ref, spec),
                execute:      sql => executeDdl(this._connectionId, sql),
                onSaved:      onColumnsSaved,
                onError:      m => this.notifyError(new Error(m), ref),
                onStatus:     m => this.statusBar.setMessage(`${this._statusScope} · ${m}`),
            } : undefined,
        };
    }

    /**
     * Open the CREATE TABLE dialog for a schema (the navigator's schema
     * context-menu launcher). Success refreshes the navigator, since a new
     * table changes the schema's object list.
     *
     * @param ref - The target schema (kind "schema"; database + schema set).
     */
    createTable(ref: DbObjectRef): void {
        const form = new CreateTableForm(ref.schema!);

        openSqlPreviewDialog({
            title:       "Create table",
            form,
            generateSql: async () => (await previewCreateTable(ref, form.readSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess:   () => this._navigator?.refresh?.(),
            onError:     msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the DROP TABLE dialog for a table (the navigator's table
     * context-menu launcher). Success refreshes the navigator and closes any
     * open data/structure/definition tabs for the now-gone table.
     *
     * @param ref - The table to drop.
     * @param _node - The table's navigator node; accepted for call-site
     *   parity with the other table launchers but unused — the tabs closed
     *   on success are looked up by panel id, not by node.
     */
    dropTable(ref: DbObjectRef, _node?: TreeNode): void {
        const form = new ConfirmCascadeForm(`Drop table "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title:       "Drop table",
            form,
            generateSql: async () =>
                (await previewDropTable(ref, { schema: ref.schema!, name: ref.name!, ...form.readSpec() })).sql,
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => {
                this._navigator?.refresh?.();
                this.dock.removePanel(this.panelId(ref));
                this.dock.removePanel(this.structurePanelId(ref));
            },
            onError: msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the RENAME TABLE dialog for a table (the navigator's table
     * context-menu launcher). Success refreshes the navigator (the object
     * list's display name changed) and closes any open data/structure tabs
     * for the table's old identity, since they are keyed by name.
     *
     * @param ref - The table to rename.
     * @param _node - The table's navigator node; accepted for call-site
     *   parity with the other table launchers but unused (see {@link dropTable}).
     */
    renameTable(ref: DbObjectRef, _node?: TreeNode): void {
        const form = new RenameTableForm(ref.schema!, ref.name!);

        openSqlPreviewDialog({
            title:       "Rename table",
            form,
            generateSql: async () => (await previewAlterTable(ref, form.readSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess:   () => {
                this._navigator?.refresh?.();
                this.dock.removePanel(this.panelId(ref));
                this.dock.removePanel(this.structurePanelId(ref));
            },
            onError: msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the "Add constraint" dialog for one kind (the Constraints section
     * toolbar). A foreign key's form needs the connection's schema list for
     * its referenced-schema combo, fetched up front; the other kinds need no
     * extra fetch. Success rebuilds the structure tab only — a constraint
     * doesn't change the data tab's column set.
     *
     * @param ref - The table to constrain.
     * @param kind - Which constraint kind to add.
     */
    async addConstraint(ref: DbObjectRef, kind: ConstraintKind): Promise<void> {
        const columns = this.structureColumns(ref).map(c => c.name);
        let schemas: string[] = [];

        if (kind === "foreignKey") {
            try {
                schemas = (await getSchemas(ref.connectionId, ref.database!)).map(s => s.name);
            } catch (err) {
                this.notifyError(err, ref);

                return;
            }
        }

        const form = new ConstraintForm(ref.schema!, ref.name!, kind, columns, schemas);

        openSqlPreviewDialog({
            title:       "Add constraint",
            form,
            generateSql: async () => (await previewConstraint(ref, form.readSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess:   () => this.refreshStructure(ref),
            onError:     msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the DROP CONSTRAINT dialog for a named constraint — primary key,
     * unique, check, or foreign key alike, dropped uniformly by name (the
     * Constraints and Foreign Keys section toolbars).
     *
     * @param ref - The table the constraint belongs to.
     * @param constraintName - The constraint to drop.
     */
    dropConstraint(ref: DbObjectRef, constraintName: string): void {
        const form = new ConfirmCascadeForm(`Drop constraint "${constraintName}" on "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title:       "Drop constraint",
            form,
            generateSql: async () => (await previewConstraint(ref, {
                schema: ref.schema!, name: ref.name!, action: "drop", constraintName, ...form.readSpec(),
            })).sql,
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this.refreshStructure(ref),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the CREATE INDEX dialog for a table (the Indexes section
     * toolbar). Success rebuilds the structure tab only.
     *
     * @param ref - The table to index.
     */
    createIndex(ref: DbObjectRef): void {
        const columns = this.structureColumns(ref).map(c => c.name);
        const form    = new IndexForm(ref.schema!, ref.name!, columns);

        openSqlPreviewDialog({
            title:       "Create index",
            form,
            generateSql: async () => (await previewIndex(ref, form.readSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess:   () => this.refreshStructure(ref),
            onError:     msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the DROP INDEX dialog for a named index (the Indexes section
     * toolbar). Success rebuilds the structure tab only.
     *
     * @param ref - The table the index belongs to.
     * @param indexName - The index to drop.
     */
    dropIndex(ref: DbObjectRef, indexName: string): void {
        const form = new ConfirmCascadeForm(`Drop index "${indexName}"?`);

        openSqlPreviewDialog({
            title:       "Drop index",
            form,
            generateSql: async () => (await previewIndex(ref, {
                schema: ref.schema!, action: "drop", indexName, ...form.readSpec(),
            })).sql,
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this.refreshStructure(ref),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the "Create index" dialog for a heuristic index advisor suggestion,
     * with the suggested columns pre-checked — the suggestions strip's "Create
     * index…" action (QueryPanel's `indexAdvisor.onCreateIndex`). Modelled on
     * {@link createIndex}, but fetches the table's full column list with
     * `getColumns(ref)` rather than reading the cached `structureColumns`,
     * since a suggestion's table need not have its Structure tab open.
     *
     * @param schema - The suggested index's schema.
     * @param table - The suggested index's table.
     * @param columns - The advisor's suggested columns, pre-checked in the form.
     */
    private async createSuggestedIndex(schema: string, table: string, columns: string[]): Promise<void> {
        const ref: DbObjectRef = {
            connectionId: this._connectionId, database: this._database, schema, name: table, kind: "table",
        };

        let allColumns: string[];

        try {
            allColumns = (await getColumns(ref)).map(c => c.name);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        const form = new IndexForm(schema, table, allColumns, columns);

        openSqlPreviewDialog({
            title:       "Create index",
            form,
            generateSql: async () => (await previewIndex(ref, form.readSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess:   () => this.refreshStructure(ref),
            onError:     msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the CREATE VIEW dialog for a schema (the navigator's schema
     * context-menu launcher). Fetches the connection's schema list for the
     * form's schema ComboBox. Success refreshes the navigator, since a new
     * view changes the schema's object list.
     *
     * @param ref - The target schema (kind "schema"; database + schema set).
     */
    async createView(ref: DbObjectRef): Promise<void> {
        let schemas: string[];

        try {
            schemas = (await getSchemas(ref.connectionId, ref.database!)).map(s => s.name);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        openViewDialog({
            ref,
            schemas,
            preview:   spec => previewCreateView(ref, spec),
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this._navigator?.refresh?.(),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the CREATE MATERIALIZED VIEW dialog for a schema (the
     * navigator's schema context-menu launcher). Mirrors {@link createView}.
     *
     * @param ref - The target schema (kind "schema"; database + schema set).
     */
    async createMaterializedView(ref: DbObjectRef): Promise<void> {
        let schemas: string[];

        try {
            schemas = (await getSchemas(ref.connectionId, ref.database!)).map(s => s.name);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        openMaterializedViewDialog({
            ref,
            schemas,
            createPreview:  spec => previewCreateMatview(ref, spec),
            execute:        sql => executeDdl(this._connectionId, sql),
            onSuccess:      () => this._navigator?.refresh?.(),
            onError:        msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the DROP dialog for a view or materialized view (the
     * navigator's context-menu launcher). Success refreshes the navigator
     * and closes any open data/definition tabs for the now-gone object.
     *
     * @param ref - The view/matview to drop.
     */
    dropRelation(ref: DbObjectRef): void {
        openDropRelationDialog({
            kind:    ref.kind,
            schema:  ref.schema!,
            name:    ref.name!,
            preview: spec => ref.kind === "materializedView" ? previewDropMatview(ref, spec) : previewDropView(ref, spec),
            execute: sql => executeDdl(this._connectionId, sql),
            onSuccess: () => {
                this._navigator?.refresh?.();
                this.dock.removePanel(this.panelId(ref));
                this.dock.removePanel(this.definitionPanelId(ref));
            },
            onError: msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the REFRESH dialog for a materialized view (the navigator's
     * context-menu launcher). Success only sets a status message — a
     * refresh does not change the object list or the matview's column set,
     * so neither the navigator nor any open tab needs rebuilding.
     *
     * @param ref - The matview to refresh.
     */
    refreshMaterializedView(ref: DbObjectRef): void {
        openRefreshMatviewDialog({
            schema:    ref.schema!,
            name:      ref.name!,
            preview:   spec => previewRefreshMatview(ref, spec),
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: refreshed`),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the CREATE SCHEMA dialog, launched from an existing schema node's
     * context menu — the navigator has no separate database node to
     * right-click (its top level IS the logged-in database's schemas; see
     * NavigatorTree's header comment and
     * plans/implemented/schema-sequence-ddl.md's drift notes). The new
     * schema is created in `ref`'s own database. Success refreshes the
     * navigator, since a new schema changes the database's top-level list.
     *
     * @param ref - the launching schema node (its database is the target).
     */
    createSchema(ref: DbObjectRef): void {
        openCreateSchemaDialog({
            preview:   spec => previewCreateSchema(ref, spec),
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this._navigator?.refresh?.(),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the DROP SCHEMA dialog for a schema (the navigator's context-menu
     * launcher). Success refreshes the navigator.
     *
     * @param ref - the schema to drop.
     */
    dropSchema(ref: DbObjectRef): void {
        openDropSchemaDialog({
            name:      ref.schema!,
            preview:   spec => previewDropSchema(ref, spec),
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this._navigator?.refresh?.(),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the RENAME SCHEMA dialog for a schema (the navigator's
     * context-menu launcher). Success refreshes the navigator (the schema's
     * display name changed).
     *
     * @param ref - the schema to rename.
     */
    renameSchema(ref: DbObjectRef): void {
        openRenameSchemaDialog({
            name:      ref.schema!,
            preview:   spec => previewRenameSchema(ref, spec),
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this._navigator?.refresh?.(),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the CREATE SEQUENCE dialog for a schema (the navigator's
     * context-menu launcher). Success refreshes the navigator, since a new
     * sequence changes the schema's object list.
     *
     * @param ref - the target schema (kind "schema"; database + schema set).
     */
    createSequence(ref: DbObjectRef): void {
        openCreateSequenceDialog({
            schema:    ref.schema!,
            preview:   spec => previewCreateSequence(ref, spec),
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this._navigator?.refresh?.(),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the DROP SEQUENCE dialog for a sequence (the navigator's
     * context-menu launcher). Success refreshes the navigator.
     *
     * @param ref - the sequence to drop.
     */
    dropSequence(ref: DbObjectRef): void {
        openDropSequenceDialog({
            schema:    ref.schema!,
            name:      ref.name!,
            preview:   spec => previewDropSequence(ref, spec),
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this._navigator?.refresh?.(),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the CREATE FUNCTION/PROCEDURE dialog for a schema (the
     * navigator's context-menu launcher). Success refreshes the navigator,
     * since a new routine changes the schema's object list.
     *
     * @param ref - the target schema (kind "schema"; database + schema set).
     */
    createFunction(ref: DbObjectRef): void {
        const form = new FunctionForm({ schema: ref.schema! });

        openSqlPreviewDialog({
            title:       "Create function",
            form,
            generateSql: async () => (await previewCreateFunction(ref, form.getSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess:   () => this._navigator?.refresh?.(),
            onError:     msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open an editable definition tab for a function/procedure — the routine
     * counterpart to `openDefinition` (which handles views), opened by
     * double-click or the navigator's "Show definition". The tab opens at once
     * behind the library's spinner; behind it, fetches the routine's
     * `pg_get_functiondef` text — already a complete, executable
     * `CREATE OR REPLACE FUNCTION|PROCEDURE …` statement — and seeds a
     * FunctionDefinitionPanel with it, deduping by function-definition-panel
     * id. The panel's Save hands the edited text straight to `executeDdl` with
     * no preview/wrapper (the text is already the whole statement — see the
     * function-type-ddl plan's "prefer CREATE OR REPLACE" decision: a
     * signature-changing edit is the user's own manual escape hatch, not an
     * auto-generated drop-recreate). On success the navigator refreshes and the
     * tab reseeds itself in place (via `panel.reload`) rather than closing. A
     * failed fetch closes the tab it opened, reported through notifyError; a
     * failed save surfaces through notifyError and leaves the tab (and the
     * user's edits) open.
     *
     * @param ref - the function/procedure leaf to open (its `signature`
     *   disambiguates overloads).
     */
    async openFunctionDefinition(ref: DbObjectRef, node?: TreeNode): Promise<void> {
        const id = this.functionDefinitionPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const signature = ref.signature ?? "";
        const route = objectPath(ref) ?? undefined;

        this.openAsyncPanel({
            id,
            // Include the identity signature so two overloads of the same name
            // get visibly distinct tab titles (e.g. `total_orders()` vs
            // `total_orders(p_customer_id integer)`), matching their distinct ids.
            title  : `${ref.name ?? id}(${signature}) (definition)`,
            glyph  : "file-code",
            tooltip: this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            // The fetch now runs behind the library's spinner. A throw here closes
            // the tab and reaches the "exception" handler — so no local catch.
            const definition: FunctionDefinition = await getFunctionDefinition(ref, signature);

            // Read by `onSave` only after a Save click, which always happens after
            // this variable is assigned just below — the forward reference is safe.
            let panel: FunctionDefinitionPanel;

            const onSave = async (newDefinition: string): Promise<void> => {
                try {
                    // No preview/builder: pg_get_functiondef is already the full
                    // CREATE OR REPLACE statement, so the user's edited text runs
                    // as-is. Editing the argument list here creates a NEW overload
                    // rather than replacing this one (the signature is part of the
                    // routine's identity) — the stated escape-hatch behaviour; the
                    // re-fetch below then fails to find the original signature and
                    // reports "saved, but failed to refresh".
                    await executeDdl(this._connectionId, newDefinition);
                } catch (err) {
                    this.notifyError(err, ref);

                    return;
                }

                this._navigator?.refresh?.();

                try {
                    const reloaded = await getFunctionDefinition(ref, signature);

                    panel.reload(reloaded.definition);
                } catch (err) {
                    // The save itself already succeeded (executeDdl above didn't
                    // throw) — only the post-save re-fetch failed, so this is NOT a
                    // failed save. Say so explicitly, mirroring openDefinition.
                    this.notifyError(new Error(`saved, but failed to refresh the tab: ${this.errorMessage(err)}`), ref);

                    return;
                }

                this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: definition saved`);
            };

            const refresh = (): void => void this.refreshPanel(ref, async () => {
                panel.reload((await getFunctionDefinition(ref, signature)).definition);
            });

            panel = new FunctionDefinitionPanel(definition.definition, onSave, refresh);

            this._openPanels.set(id, { ref, node: node ?? null, detail: "definition", refresh });
            this.syncToPanel(id);

            return panel.content;
        });
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
     * Open the DROP FUNCTION/PROCEDURE dialog for a function/procedure leaf
     * (the navigator's context-menu launcher). Success refreshes the
     * navigator. Reuses `ConfirmCascadeForm`, matching every other drop
     * dialog's idiom.
     *
     * @param ref - the function/procedure to drop (its `signature`
     *   disambiguates overloads; `isProcedure` selects the DROP keyword).
     */
    dropFunction(ref: DbObjectRef): void {
        const kind = ref.isProcedure ? "procedure" : "function";
        const form = new ConfirmCascadeForm(`Drop ${kind} "${ref.schema}"."${ref.name}"(${ref.signature ?? ""})?`);

        openSqlPreviewDialog({
            title:       "Drop function",
            form,
            generateSql: async () => (await previewDropFunction(ref, buildDropFunctionSpec(
                ref.schema!, ref.name!, kind, ref.signature ?? "", form.readSpec().cascade,
            ))).sql,
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => {
                this._navigator?.refresh?.();
                this.dock.removePanel(this.functionDefinitionPanelId(ref));
            },
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the CREATE TYPE dialog for a schema (the navigator's "Create
     * type ▸ Enum | Composite" context-menu submenu). Success refreshes the
     * navigator, since a new type changes the schema's object list.
     *
     * @param ref - the target schema (kind "schema"; database + schema set).
     * @param category - which CREATE TYPE form to open.
     */
    createType(ref: DbObjectRef, category: "enum" | "composite"): void {
        const onSuccess = (): void => this._navigator?.refresh?.();
        const onError = (msg: string): void => this.notifyError(new Error(msg), ref);

        if (category === "enum") {
            const form = new EnumTypeForm({ schema: ref.schema! });

            openSqlPreviewDialog({
                title:       "Create enum type",
                form,
                generateSql: async () => (await previewCreateEnumType(ref, form.getSpec())).sql,
                execute:     sql => executeDdl(this._connectionId, sql),
                onSuccess,
                onError,
            });

            return;
        }

        const form = new CompositeTypeForm({ schema: ref.schema! });

        openSqlPreviewDialog({
            title:       "Create composite type",
            form,
            generateSql: async () => (await previewCreateCompositeType(ref, form.getSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess,
            onError,
        });
    }

    /**
     * Open the edit dialog for an existing type (the navigator's "Edit
     * type…" launcher). Introspects the type first, then routes on its
     * category: an enum offers `ALTER TYPE ... ADD VALUE` (append-only —
     * Postgres has no `CREATE OR REPLACE TYPE`); a composite offers a
     * recreate/clone form prefilled with its current attributes (restructuring
     * an existing composite in place is a stated Non-Goal — see the
     * function-type-ddl plan's "enum edits are append-only" decision).
     * Success refreshes the navigator only for the composite path (a new
     * `CREATE TYPE` statement); an enum `ADD VALUE` does not change the
     * object list, so it only sets a status message, mirroring
     * `alterSequence`.
     *
     * @param ref - the type leaf to edit.
     */
    async editType(ref: DbObjectRef): Promise<void> {
        let definition: TypeDefinition;

        try {
            definition = await getTypeDefinition(ref);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        const onError = (msg: string): void => this.notifyError(new Error(msg), ref);

        if (definition.category === "enum") {
            const form = new AddEnumValueForm({
                schema: ref.schema!, name: ref.name!, existingLabels: definition.labels,
            });

            openSqlPreviewDialog({
                title:       "Add enum value",
                form,
                generateSql: async () => (await previewAlterTypeAddValue(ref, form.getSpec())).sql,
                execute:     sql => executeDdl(this._connectionId, sql),
                onSuccess:   () => this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: altered`),
                onError,
            });

            return;
        }

        const form = new CompositeTypeForm({ schema: ref.schema!, prefill: definition.attributes });

        openSqlPreviewDialog({
            title:       "Edit composite type (recreate)",
            form,
            generateSql: async () => (await previewCreateCompositeType(ref, form.getSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess:   () => this._navigator?.refresh?.(),
            onError,
        });
    }

    /**
     * Open the DROP TYPE dialog for a type leaf (the navigator's
     * context-menu launcher). Success refreshes the navigator. Reuses
     * `ConfirmCascadeForm`, matching every other drop dialog's idiom.
     *
     * @param ref - the type to drop.
     */
    dropType(ref: DbObjectRef): void {
        const form = new ConfirmCascadeForm(`Drop type "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title:       "Drop type",
            form,
            generateSql: async () =>
                (await previewDropType(ref, buildDropTypeSpec(ref.schema!, ref.name!, form.readSpec().cascade))).sql,
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this._navigator?.refresh?.(),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * The structure tab's own columns for a table, from the open-panel
     * registry (populated by `openStructure` and kept current by its
     * Refresh) — the source the Constraints/Indexes forms build their
     * column checklists from. Empty when the structure tab isn't open (a
     * toolbar action can't run without it, so this is defensive, not an
     * expected path).
     *
     * @param ref - The table whose structure tab to read.
     */
    private structureColumns(ref: DbObjectRef): ColumnMeta[] {
        return this._openPanels.get(this.structurePanelId(ref))?.columns ?? [];
    }

    /**
     * Rebuild the structure tab (remove then reopen) after a structure-only
     * change (a constraint or index add/drop, or a NOT-NULL/default toggle)
     * — the data tab's column set is unaffected, so it's left open. A no-op
     * if the structure tab isn't open or was opened without a navigator node
     * (should not happen in practice — the navigator always supplies one).
     *
     * @param ref - The table whose structure tab to rebuild.
     */
    private refreshStructure(ref: DbObjectRef): void {
        const id   = this.structurePanelId(ref);
        const node = this._openPanels.get(id)?.node;

        this.dock.removePanel(id);

        if (node) {
            void this.openStructure(ref, node);
        }
    }

    /**
     * Open (or focus) the singleton documentation/notes tab for this connection:
     * a WYSIWYG DocumentationPanel seeded from and persisting to the
     * per-connection notes store. Not registered in `_openPanels` (it carries
     * no `DbObjectRef`), matching how scratch query panels are handled.
     */
    openDocumentation(): void {
        const id = this.notesPanelId();

        if (this.dock.focusPanel(id)) {
            return;
        }

        const panel = new DocumentationPanel(
            this._notes.load(),
            markdown => this._notes.save(markdown),
        );

        this._panelRoutes.set(id, notesPath());

        this.dock.addPanel({ id, title: "Notes", glyph: "file-lines", content: panel.content });
    }

    /**
     * Open a read-only entity-relationship diagram for a whole schema in the Dock
     * (deduped by panel id): tables as nodes, foreign keys as edges, auto-laid-out
     * by ELK. Selecting a node opens that table's data tab via openReferencedTable.
     *
     * @param ref - The schema to diagram (kind "schema"; database + schema set).
     * @param _node - The schema's navigator node; accepted for call-site parity
     *   with openStructure/openTable but unused — the diagram tab is not
     *   registered in _openPanels, so there is no node to remember.
     */
    async openSchemaDiagram(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = this.diagramPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, "diagram") ?? undefined;

        this.openAsyncPanel({
            id,
            title         : `${ref.schema} (diagram)`,
            glyph         : "diagram-project",
            ref,
            route,
        }, async () => {
            const data = await this.buildSchemaGraphData(ref);

            if (!data) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}: diagram (${data.nodes.length} tables)`);

            return SchemaDiagramPanel(
                data,
                table => this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : ref.schema,
                    name        : table,
                    kind        : "table",
                }),
                (table, event) => this.diagramContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : ref.schema,
                    name        : table,
                    kind        : "table",
                }, event),
            );
        });
    }

    /**
     * Fetch a whole schema's ER graph in one bulk request and assemble the
     * nodes+edges via buildSchemaDiagram. Shared by the schema diagram and the
     * relation-rooted diagram (which walks this full graph from a chosen
     * root). Returns null on failure, having already reported the error.
     *
     * @param ref - The schema to fetch (database + schema set).
     * @param opts - `withColumns` builds card-mode nodes (table cards +
     *   column-to-column FK ports) from the endpoint's always-fetched columns
     *   — used by the relation-rooted diagram; omitted (or false) keeps the
     *   flat table-to-table graph the schema-wide diagram shows.
     * @returns The full schema graph, or null if the fetch failed.
     */
    private async buildSchemaGraphData(ref: DbObjectRef, opts?: { withColumns?: boolean }): Promise<DiagramData | null> {
        try {
            const graph      = await getSchemaGraph(ref);
            const tables     = graph.tables.map(t => t.name);
            const structures = graph.tables.map(t => t.structure);
            const columns    = graph.tables.map(t => t.columns);

            const columnsByTable: Map<string, ColumnMeta[]> | undefined =
                opts?.withColumns ? new Map(graph.tables.map(t => [t.name, t.columns])) : undefined;

            // The measurer is injected here, rather than inside buildSchemaDiagram
            // or uniformNodeWidth, because this controller is the first module in
            // the chain allowed to touch the DOM — both of those stay pure and
            // node-vitest-testable (see buildSchemaDiagram.ts's header note).
            const diagram = buildSchemaDiagram(tables, structures, columnsByTable, Util.measureTextWidths);

            return annotateFkCardinality(diagram, tables, structures, columns);
        } catch (err) {
            this.notifyError(err, ref);

            return null;
        }
    }

    /**
     * Open a read-only entity-relationship diagram spanning every schema in a
     * database in the Dock (deduped by panel id). The panel defaults to a
     * legible schema-overview graph and offers a rooted/filtered Tables mode;
     * selecting a table opens its data tab via openReferencedTable, reading
     * *that leaf's own* schema off its node data (unlike the single-schema
     * diagram, which hardcodes `schema: ref.schema` — see openSchemaDiagram —
     * a database diagram spans many schemas, so the schema varies per node).
     *
     * @param ref - The database to diagram (kind "database"; database set).
     * @param _node - The database's navigator node; accepted for call-site
     *   parity with the other open methods but unused — the diagram tab is not
     *   registered in _openPanels, so there is no node to remember.
     */
    async openDatabaseDiagram(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = this.databaseDiagramPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = databaseDiagramPath();

        this.openAsyncPanel({
            id,
            title         : `${ref.database} (diagram)`,
            glyph         : "circle-nodes",
            ref,
            route,
        }, async () => {
            const schemas = await this.buildDatabaseGraphData(ref);

            if (!schemas) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            const tableCount = schemas.reduce((total, s) => total + s.tables.length, 0);

            this.statusBar.setMessage(`${this._statusScope} · ${ref.database}: diagram (${tableCount} tables)`);

            return DatabaseDiagramPanel(
                schemas,
                (schema, table) => this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }),
                (schema, table, event) => this.diagramContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }, event),
            );
        });
    }

    /**
     * Fetch every schema's tables + structures for the database diagram in one
     * bulk request. The on-screen graph size is bounded by
     * DatabaseDiagramPanel's rooted+prune+per-schema-hide filter layer, not by
     * this fetch. Returns null on failure, having already reported the error.
     *
     * @param ref - The database to fetch (database set).
     * @returns Every schema's tables + structures, or null if the fetch failed.
     */
    private async buildDatabaseGraphData(ref: DbObjectRef): Promise<SchemaTables[] | null> {
        try {
            const graph = await getDatabaseGraph(ref);

            return graph.schemas.map(s => ({
                schema    : s.schema,
                tables    : s.tables.map(t => t.name),
                structures: s.tables.map(t => t.structure),
            } satisfies SchemaTables));
        } catch (err) {
            this.notifyError(err, ref);

            return null;
        }
    }

    /**
     * Open a relation-rooted foreign-key diagram in the Dock (deduped by panel
     * id): the relation as the emphasized root, its FK neighbours out to a
     * user-chosen direction and depth, with a legend that hides nodes. Reuses the
     * schema-wide structure fetch and walks it from the root. A view /
     * materialized-view root shows alone — PostgreSQL foreign keys are
     * table-only. Node activation reuses openReferencedTable.
     *
     * @param ref - The relation to root at (kind table/view/matview; name set).
     * @param _node - The relation's navigator node; accepted for call-site parity
     *   with the other open methods but unused (the diagram tab is not tracked in
     *   _openPanels).
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    async openRelationDiagram(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void> {
        const id = this.relationDiagramPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const built = objectPath(ref, "diagram");
        const route: PanelRoute | undefined = built ? { path: built.path, query: depth ? { depth } : undefined } : undefined;

        this.openAsyncPanel({
            id,
            title         : `${ref.name} (relations)`,
            glyph         : "diagram-project",
            tooltip       : this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const full = await this.buildSchemaGraphData(ref, { withColumns: true });

            if (!full) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            const root: DiagramNodeData = { id: ref.name!, label: ref.name!, glyph: KIND_GLYPH[ref.kind] };

            this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}.${ref.name}: relations`);

            return RelationDiagramPanel(
                full,
                root,
                table => this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : ref.schema,
                    name        : table,
                    kind        : "table",
                }),
                (table, event) => this.diagramContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : ref.schema,
                    name        : table,
                    kind        : "table",
                }, event),
                depth,
            );
        });
    }

    /**
     * Fetch a schema's view/matview dependency graph: the view -> underlying
     * relation edges from the dependencies endpoint, assembled via
     * buildRelationGraph with dashed edges (distinguishing dependency edges
     * from a plain FK diagram's). Returns null on failure, having already
     * reported the error.
     *
     * @param ref - The schema to fetch (database + schema set).
     * @returns The full dependency graph, or null if the fetch failed.
     */
    private async fetchDependencyGraph(ref: DbObjectRef): Promise<DiagramData | null> {
        try {
            const edges = await getDependencies(ref.connectionId, ref.database!, ref.schema!);

            return buildRelationGraph(edges, ref.schema!, DEPENDENCY_LAYOUT, true);
        } catch (err) {
            this.notifyError(err, ref);

            return null;
        }
    }

    /**
     * Fetch a schema's inheritance/partitioning graph: the parent -> child
     * edges from the inheritance endpoint, assembled via buildRelationGraph
     * with plain edges. Returns null on failure, having already reported the
     * error.
     *
     * @param ref - The schema to fetch (database + schema set).
     * @returns The full inheritance graph, or null if the fetch failed.
     */
    private async fetchInheritanceGraph(ref: DbObjectRef): Promise<DiagramData | null> {
        try {
            const edges = await getInheritance(ref.connectionId, ref.database!, ref.schema!);

            return buildRelationGraph(edges, ref.schema!, INHERITANCE_LAYOUT);
        } catch (err) {
            this.notifyError(err, ref);

            return null;
        }
    }

    /**
     * Open a read-only view/matview dependency graph for a whole schema in the
     * Dock (deduped by panel id): views/matviews as nodes, edges to the
     * relations they read, laid out left-to-right by ELK. Node activation is
     * kind-aware: a view opens read-only, a table opens for data.
     *
     * @param ref - The schema to diagram (kind "schema"; database + schema set).
     * @param _node - The schema's navigator node; accepted for call-site parity
     *   with the other open methods but unused — the tab is not registered in
     *   _openPanels, so there is no node to remember.
     */
    async openSchemaDependencyGraph(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = this.dependencyPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, "dependencies") ?? undefined;

        this.openAsyncPanel({
            id,
            title         : `${ref.schema} (dependencies)`,
            glyph         : "share-nodes",
            ref,
            route,
        }, async () => {
            const data = await this.fetchDependencyGraph(ref);

            if (!data) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}: dependencies (${data.nodes.length} relations)`);

            return RelationGraphPanel(
                data,
                nd => this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : nd.schema,
                    name        : nd.name,
                    kind        : nd.kind,
                }),
                (nd, event) => this.diagramContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : nd.schema,
                    name        : nd.name,
                    kind        : nd.kind,
                }, event),
            );
        });
    }

    /**
     * Open a relation-rooted dependency graph in the Dock (deduped by panel
     * id): the relation as the emphasized root plus its connected dependency
     * component within the direction/depth the panel's own controls choose
     * (seeded at Both/1) from the whole schema's dependency graph. Node
     * activation is kind-aware via openReferencedTable.
     *
     * @param ref - The relation to root at (kind table/view/matview; name set).
     * @param _node - The relation's navigator node; accepted for call-site
     *   parity with the other open methods but unused.
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    async openRelationDependencyGraph(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void> {
        const id = this.relationDependencyPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const built = objectPath(ref, "dependencies");
        const route: PanelRoute | undefined = built ? { path: built.path, query: depth ? { depth } : undefined } : undefined;

        this.openAsyncPanel({
            id,
            title         : `${ref.name} (dependencies)`,
            glyph         : "share-nodes",
            tooltip       : this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const full = await this.fetchDependencyGraph(ref);

            if (!full) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            const root: DiagramNodeData = {
                id   : relationNodeId(ref as RelationNodeRef),
                label: ref.name!,
                glyph: KIND_GLYPH[ref.kind],
                data : { schema: ref.schema!, name: ref.name!, kind: ref.kind },
            };

            this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}.${ref.name}: dependencies`);

            return RootedRelationGraphPanel(
                full,
                root,
                nd => this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : nd.schema,
                    name        : nd.name,
                    kind        : nd.kind,
                }),
                (nd, event) => this.diagramContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : nd.schema,
                    name        : nd.name,
                    kind        : nd.kind,
                }, event),
                depth,
            );
        });
    }

    /**
     * Open a read-only table inheritance/partitioning graph for a whole schema
     * in the Dock (deduped by panel id): a top-to-bottom tree, parent -> child.
     * Node activation is kind-aware via openReferencedTable.
     *
     * @param ref - The schema to diagram (kind "schema"; database + schema set).
     * @param _node - The schema's navigator node; accepted for call-site parity
     *   with the other open methods but unused.
     */
    async openSchemaInheritanceGraph(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = this.inheritancePanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, "inheritance") ?? undefined;

        this.openAsyncPanel({
            id,
            title         : `${ref.schema} (inheritance)`,
            glyph         : "sitemap",
            ref,
            route,
        }, async () => {
            const data = await this.fetchInheritanceGraph(ref);

            if (!data) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}: inheritance (${data.nodes.length} relations)`);

            return RelationGraphPanel(
                data,
                nd => this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : nd.schema,
                    name        : nd.name,
                    kind        : nd.kind,
                }),
                (nd, event) => this.diagramContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : nd.schema,
                    name        : nd.name,
                    kind        : nd.kind,
                }, event),
            );
        });
    }

    /**
     * Open a relation-rooted inheritance/partitioning graph in the Dock
     * (deduped by panel id): the relation as the emphasized root plus its
     * connected inheritance component within the direction/depth the panel's
     * own controls choose (seeded at Both/1) from the whole schema's
     * inheritance graph. Node activation is kind-aware via
     * openReferencedTable.
     *
     * @param ref - The relation to root at (kind table; name set).
     * @param _node - The relation's navigator node; accepted for call-site
     *   parity with the other open methods but unused.
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    async openRelationInheritanceGraph(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void> {
        const id = this.relationInheritancePanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const built = objectPath(ref, "inheritance");
        const route: PanelRoute | undefined = built ? { path: built.path, query: depth ? { depth } : undefined } : undefined;

        this.openAsyncPanel({
            id,
            title         : `${ref.name} (inheritance)`,
            glyph         : "sitemap",
            tooltip       : this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const full = await this.fetchInheritanceGraph(ref);

            if (!full) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            const root: DiagramNodeData = {
                id   : relationNodeId(ref as RelationNodeRef),
                label: ref.name!,
                glyph: KIND_GLYPH[ref.kind],
                data : { schema: ref.schema!, name: ref.name!, kind: ref.kind },
            };

            this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}.${ref.name}: inheritance`);

            return RootedRelationGraphPanel(
                full,
                root,
                nd => this.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : nd.schema,
                    name        : nd.name,
                    kind        : nd.kind,
                }),
                (nd, event) => this.diagramContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : nd.schema,
                    name        : nd.name,
                    kind        : nd.kind,
                }, event),
                depth,
            );
        });
    }

    /**
     * Open a foreign key's referenced table in the Dock and reveal it in the
     * navigator. `Tree.revealByPredicate` expands the path to the node —
     * loading lazy branches (unexpanded schemas) as needed — so the target is
     * revealed even when the user never navigated to it. That reveal can take a
     * moment (it waits for the navigator's own load, and each unexpanded branch
     * on the path is a fetch), so it runs concurrently with the tab's own open
     * rather than gating it: the tab
     * appears at once, exactly like every other open path, with its content
     * loading lazily behind it (see openTable); the navigator selection lands
     * whenever the reveal resolves. Best-effort: if no node matches, the tab
     * still opens.
     *
     * @param ref - The referenced table to open.
     */
    openReferencedTable(ref: DbObjectRef): void {
        const revealed = this.revealNavigatorNode(matchesRelationName(ref));

        void this.openTable(ref, revealed);
        void revealed.then(node => { if (node) { this._navigator?.selectNode(node); } });
    }

    /**
     * Show `ref`'s object context menu at `event`'s position — the same menu
     * the navigator tree shows for the identical object, built by the shared
     * buildObjectMenuItems (see objectMenu.ts). Called by each diagram panel's
     * "contextmenu" forwarding; a no-op for a kind with no menu.
     *
     * @param ref - The right-clicked diagram node's object.
     * @param event - The originating right-click.
     */
    private diagramContextMenu(ref: DbObjectRef, event: MouseEvent): void {
        showObjectMenu(this._objectMenu, ref, this, event);
    }

    /**
     * Open a column's backing sequence's info tab and reveal it in the
     * navigator — the Structure tab's Sequence link. Best-effort, exactly like
     * {@link openReferencedTable}: if no node matches, the tab still opens; the
     * reveal runs concurrently with the tab's own open rather than gating it.
     *
     * @param ref - The sequence to open (kind "sequence").
     */
    openReferencedSequence(ref: DbObjectRef): void {
        const revealed = this.revealObject(ref);

        void this.openSequence(ref, revealed);
        void revealed.then(node => { if (node) { this._navigator?.selectNode(node); } });
    }

    /**
     * Open a table's Structure tab and reveal the table in the navigator — the
     * sequence info tab's "Owned by column" link. Best-effort, exactly like
     * {@link openReferencedTable}: the reveal runs concurrently with the tab's
     * own open rather than gating it.
     *
     * @param ref - The table whose structure to open (kind "table").
     */
    openReferencedStructure(ref: DbObjectRef): void {
        const revealed = this.revealObject(ref);

        void this.openStructure(ref, revealed);
        void revealed.then(node => { if (node) { this._navigator?.selectNode(node); } });
    }

    /**
     * Reveal an object's navigator node, expanding the path to it — loading
     * lazy branches (unexpanded schemas) as needed — so the target is revealed
     * even when the user never navigated to it.
     *
     * Matches on `kind` as well as database/schema/name (see
     * {@link matchesObject}), unlike {@link openReferencedTable}'s kind-blind
     * rule.
     *
     * @param ref - The object to reveal.
     *
     * @returns The revealed node, or undefined when no node matches.
     */
    private revealObject(ref: DbObjectRef): Promise<TreeNode | undefined> {
        return this.revealNavigatorNode(matchesObject(ref));
    }

    /**
     * Bring the Database view forward and reveal the first navigator node
     * `match` accepts, once the navigator has finished loading.
     *
     * The view switch comes first because revealing means searching a tree and
     * scrolling to the result, which is pointless while that tree's deck page
     * is hidden. The `whenLoaded` wait is what makes a reveal issued at boot —
     * a deep link's, or an early double-click's — search a populated tree
     * instead of silently finding nothing in one still filling.
     *
     * @param match - Tests each node's `data` payload; see revealMatch.ts.
     *
     * @returns The revealed node, or undefined when no node matches.
     */
    private async revealNavigatorNode(match: NodeMatch): Promise<TreeNode | undefined> {
        this.showDatabaseView();
        await this._navigator?.whenLoaded();

        return (await this._navigator?.revealByPredicate(match)) ?? undefined;
    }

    /**
     * Bring the Roles view forward and reveal the first roles-tree node
     * `match` accepts, once the role list has finished loading — the
     * roles-side twin of {@link revealNavigatorNode}.
     *
     * @param match - Tests each node's `data` payload; see revealMatch.ts.
     *
     * @returns The revealed node, or undefined when no node matches.
     */
    private async revealRoleNode(match: NodeMatch): Promise<TreeNode | undefined> {
        this.showRolesView();
        await this._rolesTree?.whenLoaded();

        return (await this._rolesTree?.revealByPredicate(match)) ?? undefined;
    }

    /**
     * Bring the Database view forward and select `ref`'s navigator node.
     *
     * The caller-side reveal a route handler pairs with its own `open*` call,
     * the same way {@link openReferencedTable} pairs one with `openTable` —
     * the sidebar follows an *open*, not a focus, so `syncToPanel`'s
     * focus-driven selection stays as it is. Best-effort and fire-and-forget:
     * a ref naming no navigator node only switches the view.
     *
     * @param ref - The object just opened.
     */
    selectObject(ref: DbObjectRef): void {
        // A database-wide ref names no navigator node (the tree is rooted at
        // schemas — the app connects to one database per session), so switch the
        // view and stop: revealByPredicate walks depth first, so a search would
        // lazily fetch every schema's objects only to find nothing. Keyed on
        // `schema` rather than `kind === "database"` so any future schema-less
        // ref is covered by the same rule.
        if (!ref.schema) {
            this.showDatabaseView();

            return;
        }

        void this.revealObject(ref).then(node => { if (node) { this._navigator?.selectNode(node); } });
    }

    /**
     * Bring the Roles view forward and select `name`'s roles-tree node — the
     * roles-side twin of {@link selectObject}. Best-effort and
     * fire-and-forget: a name matching no leaf only switches the view.
     *
     * @param name - The role just opened.
     */
    selectRole(name: string): void {
        void this.revealRoleNode(matchesRole(name)).then(node => { if (node) { this._rolesTree?.selectNode(node); } });
    }

    /**
     * Switch the sidebar to the Database view and expand `schema`'s own
     * navigator node (its category children become visible) — no tab opens.
     * Best-effort, mirroring selectObject: a schema matching no navigator
     * node only switches the view.
     *
     * @param schema - The schema to reveal.
     */
    revealSchema(schema: string): void {
        const ref: DbObjectRef = { connectionId: this._connectionId, database: this._database ?? "", schema, kind: "schema" };

        void this.revealNavigatorNode(matchesObject(ref)).then(node => {
            if (node) {
                this._navigator?.selectNode(node);
                this._navigator?.expandNode(node);
            }
        });
    }

    /**
     * Switch the sidebar to the Roles view and expand the named section's
     * group node ("Users" / "Groups" / "Predefined") — its role leaves
     * become visible — no tab opens. Best-effort, mirroring selectRole: a
     * section matching no group node only switches the view.
     *
     * @param section - The RolesTree section label to reveal.
     */
    revealRoleSection(section: string): void {
        void this.revealRoleNode(matchesRoleSection(section)).then(node => {
            if (node) {
                this._rolesTree?.selectNode(node);
                this._rolesTree?.expandNode(node);
            }
        });
    }

    /**
     * Open a fresh scratch query panel, optionally seeded with SQL to run on
     * open. Each call mints a new id, so re-invoking always opens a new panel
     * (no dedup — the natural behaviour for a scratch buffer).
     *
     * Query panels are deliberately NOT registered in `_openPanels`: they carry
     * no `ref`/`node`/`columns` and need no dedup or focus-sync, so the
     * table-panel lifecycle (`OpenPanel`/`syncToPanel`/`disposePanel`) stays
     * untouched. The controller holds no reference back to the panel — the Dock
     * destroys its content, and every live CodeEditor beneath it, when its tab
     * closes.
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
            this.statusBar.setMessage(`${this._statusScope} · ${statusLabel}: ${message}`);
        };

        const panel = new QueryPanel({
            runQuery  : sql => runQuery(this._connectionId, sql),
            runExplain: (sql, opts) => runExplain(this._connectionId, sql, opts),
            notify,
            onError   : error => this.notifyError(error),
            initialSql : seedSql,
            autoRun    : run,
            autoExplain: explain,
            // Record every run in history and feed the panel's Ctrl+↑/↓ recall.
            // The store dependency stays here — the panel is a pure view over
            // these injected callbacks (matching notify/onError).
            onRun     : (entry: HistoryEntry) => this.recordRun(id, entry),
            getHistory: () => this._history.list().map(e => e.sql),
            // The Save toolbar button hands back the trimmed SQL; the
            // controller owns the naming modal and the saved-query store.
            onSave    : (sql: string) => void this.promptAndSaveQuery(sql),
            // Mirror this panel's latest exportable result (rows or plan) so
            // the menubar export can reach it while it is the active panel.
            onResult  : (active: ActiveExport | null) => this._activeQueryResult.set(id, active),
            splitLayout         : this.layout.bindSplit("query"),
            explainDiagramLayout: this.layout.bindAccordion("explainDiagram"),
            // The advisor needs a database name for /structure; omitted (no
            // strip, no suggestions computed) when the controller has none.
            indexAdvisor: this._database === undefined ? undefined : {
                loadTableStructure: (schema: string, relation: string) => getStructure({
                    connectionId: this._connectionId, database: this._database, schema, name: relation, kind: "table",
                }),
                onCreateIndex: (schema: string, relation: string, columns: string[]) =>
                    void this.createSuggestedIndex(schema, relation, columns),
            },
        });

        this.dock.addPanel({ id, title: label, glyph: "terminal", content: panel.content });
    }

    /**
     * Export the active work tab's data as CSV or JSON — the menubar's "Export
     * results…" convenience, routed to whichever tab is focused. A query panel
     * exports its loaded result client-side; a table or view data tab streams the
     * whole relation server-side; a role grants tab serializes its full grant set.
     * Each matches that tab's own toolbar Export button. Notifies when the focused
     * tab has nothing to export — a structure/definition tab, an empty query
     * panel, or no open tab.
     *
     * @param format - The export format, "csv" or "json".
     */
    exportActive(format: "csv" | "json"): void {
        const id = this._activePanelId;

        if (id) {
            const active = this._activeQueryResult.get(id);
            const notify = (message: string): void => {
                this.statusBar.setMessage(`${this._statusScope} · export: ${message}`);
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
            const panel = this._openPanels.get(id);

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
     *
     * @returns True when the focused tab can export.
     */
    canExportActive(): boolean {
        const id = this._activePanelId;

        if (!id) {
            return false;
        }

        return this._activeQueryResult.get(id) != null   // query rows or an EXPLAIN plan
            || this._openPanels.get(id)?.store != null    // a table/view data grid
            || this._activeRoleGrants.get(id) != null;    // a role grants tab
    }

    /**
     * Fetch a role's detail and export its full grant set as CSV or JSON — the
     * roles context-menu convenience, usable on a role whose tab is not open.
     * Notifies when the role has no table grants.
     *
     * @param role - The role to export.
     * @param format - The export format, "csv" or "json".
     */
    async exportRole(role: string, format: "csv" | "json"): Promise<void> {
        let privileges: RolePrivilege[];

        try {
            privileges = (await getRoleDetail(this._connectionId, role)).privileges;
        } catch (err) {
            this.notifyError(err);

            return;
        }

        if (privileges.length === 0) {
            this.statusBar.setMessage(`${role} has no table grants to export`);

            return;
        }

        exportRoleGrants(role, privileges, format);
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
        // The download attribute makes this a file save rather than a top-level
        // navigation, and names the file `<schema>.<table>.<format>`.
        anchor.download      = `${[ref.schema, ref.name].filter(Boolean).join(".") || "export"}.${format}`;
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
        this.statusBar.setMessage(`${this._statusScope} · Saved query as “${elideName(name)}”`);
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
        toggle(this.dock.isEmpty());
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
     * Register the shell's Database-view selector, so a navigator reveal can
     * bring the tree it searches forward.
     *
     * @param select - Makes the Database activity-bar view the active one.
     */
    setShowDatabaseView(select: () => void): void {
        this._showDatabaseView = select;
    }

    /**
     * Register the shell's Roles-view selector, so a roles-tree reveal can
     * bring the tree it searches forward.
     *
     * @param select - Makes the Roles activity-bar view the active one.
     */
    setShowRolesView(select: () => void): void {
        this._showRolesView = select;
    }

    /**
     * Register the shell's address-bar sync callback, invoked with the
     * currently focused tab's own URL (see resolveAddressBarRoute) whenever
     * that URL might have changed, so the shell can write it in place
     * without triggering the router's own navigation dispatch.
     *
     * @param sync - Writes `path`/`query` to the address bar, replacing the
     *   current history entry.
     */
    setSyncAddressBar(sync: (path: string, query?: Record<string, string>) => void): void {
        this._syncAddressBar = sync;
    }

    /**
     * Resolve `id`'s address-bar route and write it, if a sync hook is
     * registered. Called on every dock "focus" event, and — since an
     * auto-run query panel's run finishes asynchronously behind an already-
     * focused tab, with no further "focus" event to catch it — from
     * recordRun whenever the completing run belongs to the panel that is
     * still focused.
     *
     * @param id - The panel id to resolve, or null for an empty dock.
     */
    private syncAddressBarFor(id: string | null): void {
        const route = resolveAddressBarRoute(id, this._panelRoutes, this._queryPanelRuns, this._history.list());

        this._syncAddressBar?.(route.path, route.query);
    }

    // Bring the Database / Roles view forward. Absent only before the shell has
    // wired them (and in the DOM-less path, which has no sidebar at all), so
    // both are optional calls, exactly like _showQueriesView above.
    private showDatabaseView(): void {
        this._showDatabaseView?.();
    }

    private showRolesView(): void {
        this._showRolesView?.();
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

    /**
     * Record a completed run in history, remember it as this panel's latest
     * run for the address-bar sync, and refresh the workspace surfaces. Also
     * re-syncs the address bar when `id` is still the focused panel: an
     * auto-run query tab's run finishes after the "focus" event that opened
     * it already fired (and fired too early — before any run existed to
     * resolve to), so without this the address bar would stay on "/" until
     * the user switched tabs away and back.
     *
     * @param id - The query panel's id (resolveAddressBarRoute's fallback key).
     * @param entry - The completed run.
     */
    private recordRun(id: string, entry: HistoryEntry): void {
        this._history.record(entry);
        this._queryPanelRuns.set(id, entry.timestamp);

        if (id === this._activePanelId) {
            this.syncAddressBarFor(id);
        }

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
    /**
     * Fetch a relation's columns, coalescing concurrent requests for the same
     * object. A navigator double-click fires two selection events (each showing
     * Properties) and then opens the object — three column fetches for one
     * gesture. Sharing the in-flight promise collapses them into a single
     * request. The entry is removed as soon as the fetch settles, so a later
     * fetch (e.g. after a structure change) always goes to the server rather
     * than serving stale columns from a cache.
     */
    private fetchColumns(ref: DbObjectRef): Promise<ColumnMeta[]> {
        const key = this.panelId(ref);
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
     * Fetch the role list for the Roles view's tree. The connection id stays
     * encapsulated here; the caller maps the result to nodes and reports any
     * failure via {@link notifyError}.
     */
    loadRoles(): Promise<RoleSummary[]> {
        return getRoles(this._connectionId);
    }

    /**
     * Open (or focus) the selected role's grants tab in the Dock work area and
     * show its base info (attributes + memberships) in the roles inspector. The
     * grants tab opens at once behind the library's spinner, with the role detail
     * fetched behind it — so a slow fetch never blocks the tab from appearing
     * (mirroring how openTable defers a table's fetch). Reached by a double-click
     * or the roles rail's "Show data".
     */
    showRole(name: string): void {
        this.openRoleGrants(name);
    }

    /**
     * Show the selected role's base info (attributes + memberships) in the roles
     * inspector only, without opening its grants tab — the single-click preview.
     * Opening the grants tab is {@link showRole} (double-click / "Show data").
     */
    async showRoleProperties(name: string): Promise<void> {
        const detail = await this.fetchRoleDetail(name);

        if (detail) {
            this.rolesProperties.show(detail);
        }
    }

    /**
     * Fetch a role's detail under the monotonic role guard, returning it only
     * while it is still the current selection (otherwise `null`); a failed fetch
     * reports the error and returns `null`. Shared by {@link showRole} and
     * {@link showRoleProperties} so rapid role clicks never render a stale role.
     */
    private async fetchRoleDetail(name: string): Promise<RoleDetail | null> {
        const seq = ++this._roleSeq;

        try {
            const detail = await getRoleDetail(this._connectionId, name);

            return seq === this._roleSeq ? detail : null;
        } catch (err) {
            if (seq === this._roleSeq) {
                this.notifyError(err);
            }

            return null;
        }
    }

    /**
     * Open the role's table grants in a Dock tab, or focus the existing one, and
     * refresh the roles inspector for the selection. The tab is deduped by role
     * (mirroring how a table opens its data tab); the grids are read-only and a
     * role's grants do not change within a session, so a re-selection focuses the
     * open tab and only re-previews the inspector, without rebuilding the grid.
     *
     * The role detail is fetched behind the tab's own spinner (not before the tab
     * opens) so opening never blocks on the round-trip, and it feeds both the
     * grants grid and the inspector. Unlike the transient inspector preview
     * (fetchRoleDetail), the fetch here is unguarded: a grants tab is deduped and
     * persistent, so there is no stale selection to discard — a failure closes
     * the tab and reports through the Dock "exception" handler.
     */
    private openRoleGrants(role: string): void {
        const id = `grants/${this._connectionId}/${role}`;

        if (this.dock.focusPanel(id)) {
            void this.showRoleProperties(role);

            return;
        }

        const route = rolePath(role);

        this.openAsyncPanel({ id, title: `Grants: ${role}`, glyph: "key", route }, async () => {
            const detail = await getRoleDetail(this._connectionId, role);

            this.rolesProperties.show(detail);

            // Track the grant set so the active-tab export (Tools menu) can reach
            // it while this tab is focused, mirroring _activeQueryResult for query
            // panels.
            this._activeRoleGrants.set(id, { role, privileges: detail.privileges });

            return RoleGrantsPanel(role, detail.privileges);
        });
    }

    /**
     * Open (or focus) the role-membership graph rooted at `name`: every role as
     * a node, `role -> parent` edges from each role's `memberOf`, driven by the
     * reused RelationDiagramPanel (direction / depth / legend). The membership
     * DAG needs every role's detail, so this fans out N per-role fetches —
     * unlike buildSchemaGraphData/buildDatabaseGraphData's single bulk `/graph`
     * request, there is no combined role-detail endpoint to collapse this into,
     * but N is a small role list, so the fan-out is acceptable. Double-clicking
     * another role node shows its properties in the inspector; it does not
     * open a table tab.
     *
     * @param name - The role to root the graph at.
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    async openRoleMembershipDiagram(name: string, depth?: string): Promise<void> {
        const id = this.roleMembershipDiagramPanelId(name);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const built = rolePath(name, "membership");
        const route: PanelRoute = { path: built.path, query: depth ? { depth } : undefined };

        this.openAsyncPanel({
            id,
            title         : `${name} (membership)`,
            glyph         : "diagram-project",
            route,
        }, async () => {
            // The fetch now runs behind the library's spinner. A throw here closes
            // the tab and reaches the "exception" handler — so no local catch.
            const roles   = await this.loadRoles();
            const details = await Promise.all(roles.map(r => getRoleDetail(this._connectionId, r.name)));

            const full = buildRoleMembershipDiagram(details);
            const root: DiagramNodeData = { id: name, label: name, glyph: ROLE_GLYPH };

            this.statusBar.setMessage(`${this._statusScope} · ${name}: membership (${full.nodes.length} roles)`);

            return RelationDiagramPanel(full, root, roleName => void this.showRoleProperties(roleName), undefined, depth);
        });
    }

    /**
     * Open (or focus) the per-role grants graph for `name`: the role node at
     * the centre, one node per distinct table it holds a privilege on.
     * Double-clicking a table node reveals + opens it via openGrantedTable.
     *
     * @param name - The role whose grants to graph.
     */
    async openRoleGrantsDiagram(name: string): Promise<void> {
        const id = this.roleGrantsDiagramPanelId(name);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = rolePath(name, "grants-diagram");

        this.openAsyncPanel({
            id,
            title         : `${name} (grants graph)`,
            glyph         : "diagram-project",
            route,
        }, async () => {
            const detail = await this.fetchRoleDetail(name);

            if (!detail) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, undefined, true);
            }

            const data = buildRoleGrantsDiagram(name, detail.privileges);

            this.statusBar.setMessage(`${this._statusScope} · ${name}: grants graph (${data.nodes.length - 1} tables)`);

            return RoleGrantsDiagramPanel(
                data,
                (schema, table) => this.openGrantedTable(schema, table),
                // Grants are within the connected database (RolePrivilege carries
                // no database of its own), so the ref is built with the session
                // db — the same database every navigator object lives in.
                (schema, table, event) => this.diagramContextMenu({
                    connectionId: this._connectionId,
                    database    : this._database,
                    schema,
                    name        : table,
                    kind        : "table",
                }, event),
            );
        });
    }

    /**
     * Reveal a granted table in the navigator by schema+name and open it
     * (best-effort). `RolePrivilege` carries no database (the roles endpoint is
     * not database-scoped), so — unlike openReferencedTable, which matches on
     * database + schema + name — this matches on schema + name only and adopts
     * whichever database the first matching revealed navigator node carries.
     * The reveal waits for the navigator's own load first, so an early
     * double-click in a grants graph no longer misses a tree that is still
     * filling; if no node genuinely matches (the table's database was never
     * browsed), status-bars a "not found" message and opens nothing.
     *
     * @param schema - The granted table's schema.
     * @param table - The granted table's name.
     */
    openGrantedTable(schema: string, table: string): void {
        void (async () => {
            const node = await this.revealNavigatorNode(matchesGrantedTable(schema, table));

            if (!node) {
                this.statusBar.setMessage(`${this._statusScope} · ${schema}.${table}: not found in navigator`);

                return;
            }

            await this.openTable(node.data as DbObjectRef, node);
            this._navigator?.selectNode(node);
        })();
    }

    /**
     * Refresh the active work tab. Two reloadable shapes: the five storeless
     * detail tabs (structure, definition, function definition, sequence,
     * index) dispatch to their own registered `refresh` closure, which
     * re-fetches and reseeds via the panel's `reload` and reports its own
     * outcome (see `refreshPanel`); a data grid instead reloads its table's
     * or view's store from the server, discarding a table's unsaved edits
     * first (mirroring the grid's own Refresh button — a read-only view has
     * no edits to reject). A no-op when the focused tab has neither (a
     * query, a role's grants, or the empty start page), so "refresh the
     * current view" simply does nothing when there is nothing to reload.
     * Wired to the Alt+R accelerator.
     */
    refreshActive(): void {
        const entry = this._activePanelId ? this._openPanels.get(this._activePanelId) : undefined;

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
        this.statusBar.setMessage(`${this._statusScope} · ${entry.ref.name ?? ""}: refreshed`);
    }

    /** Report a sync outcome: each failure as an error, or a success message. */
    private reportSync(event: StoreSyncEvent, ref: DbObjectRef): void {
        if (event.failures.length > 0) {
            event.failures.forEach((f: StoreExceptionEvent) => this.notifyError(f.error, ref));

            return;
        }

        this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: changes saved`);
    }

    /**
     * Surface an error (AjaxError detail, or any thrown value) to the StatusBar
     * and as an error Notification. The toast is what lands the error in
     * `Notification.getHistory()` — the status bar's line is clobbered by the
     * next setMessage, so the history is the only place a passed-over error
     * survives. The toast drops the "Error" prefix: its severity badge says so.
     */
    notifyError(error: unknown, ref?: DbObjectRef): void {
        const where  = ref?.name ? ` (${ref.name})` : "";
        const detail = this.errorMessage(error);

        this.statusBar.setMessage(`Error${where}: ${detail}`);
        Notification.show(ref?.name ? `${ref.name}: ${detail}` : detail, "error");
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

    /** Stable id for a sequence's info tab, distinct from any relation tab. */
    private sequenceInfoPanelId(ref: DbObjectRef): string {
        return `${this.panelId(ref)}::sequence`;
    }

    /** Stable id for an index's info tab, distinct from any relation tab. */
    private indexInfoPanelId(ref: DbObjectRef): string {
        return `${this.panelId(ref)}::index`;
    }

    /**
     * Stable id for a function/procedure's definition tab. Includes the
     * identity signature so two overloads of the same name (e.g.
     * `total_orders()` and `total_orders(integer)`) get distinct tabs rather
     * than colliding on `schema.name`.
     */
    private functionDefinitionPanelId(ref: DbObjectRef): string {
        return `${this.panelId(ref)}(${ref.signature ?? ""})::function`;
    }

    /** Stable id for a schema's diagram tab, distinct from any relation tab. */
    private diagramPanelId(ref: DbObjectRef): string {
        return `${ref.connectionId}/${ref.database}/${ref.schema}::diagram`;
    }

    /**
     * Stable id for a relation's rooted-diagram tab. `panelId` already includes
     * the relation name, so this never collides with the schema diagram id
     * (`.../schema::diagram`) nor with the relation's data/structure/definition
     * tabs.
     */
    private relationDiagramPanelId(ref: DbObjectRef): string {
        return `${this.panelId(ref)}::diagram`;
    }

    /** Stable id for the singleton per-connection notes/documentation tab. */
    private notesPanelId(): string {
        return `notes/${this._connectionId}`;
    }

    /**
     * Stable id for a database's diagram tab, distinct from a schema's diagram
     * id (no `/schema` segment) and from any relation tab.
     */
    private databaseDiagramPanelId(ref: DbObjectRef): string {
        return `${ref.connectionId}/${ref.database}::db-diagram`;
    }

    /** Stable id for a role's membership-diagram tab. */
    private roleMembershipDiagramPanelId(role: string): string {
        return `roles/${this._connectionId}/${role}::membership`;
    }

    /**
     * Stable id for a role's grants-diagram tab, distinct from openRoleGrants'
     * `grants/${conn}/${role}` grid tab id.
     */
    private roleGrantsDiagramPanelId(role: string): string {
        return `roles/${this._connectionId}/${role}::grants-diagram`;
    }

    /** Stable id for a schema's dependency-graph tab, distinct from any relation tab. */
    private dependencyPanelId(ref: DbObjectRef): string {
        return `${ref.connectionId}/${ref.database}/${ref.schema}::dependencies`;
    }

    /** Stable id for a relation's rooted dependency-graph tab. */
    private relationDependencyPanelId(ref: DbObjectRef): string {
        return `${this.panelId(ref)}::dependencies`;
    }

    /** Stable id for a schema's inheritance-graph tab, distinct from any relation tab. */
    private inheritancePanelId(ref: DbObjectRef): string {
        return `${ref.connectionId}/${ref.database}/${ref.schema}::inheritance`;
    }

    /** Stable id for a relation's rooted inheritance-graph tab. */
    private relationInheritancePanelId(ref: DbObjectRef): string {
        return `${this.panelId(ref)}::inheritance`;
    }
    /**
     * Hover tooltip for a tab: the object name, then Type/Schema/Database ordered
     * most-specific to broadest.
     */
    private panelTooltip(ref: DbObjectRef): string {
        return `${ref.name}\n\nType: ${relationTypeLabel(ref.kind)}\nSchema: ${ref.schema}\nDatabase: ${ref.database}`;
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
     * lands after its tab closed (or after the id was reopened) is handled by
     * the Dock itself — it cancels the materialization, and the arriving
     * component is disposed rather than mounted.
     *
     * @param spec - The tab's identity.
     */
    private openAsyncPanel(
        spec: { id: string; title: string; glyph: string; tooltip?: string; ref?: DbObjectRef; route?: PanelRoute },
        build: () => Promise<Component>,
    ): void {
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

        this.statusBar.setMessage(`${this._statusScope} · ${spec.title}: loading…`);
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

    /** Status line for a panel: row count for a data tab, else the detail label. */
    private updateStatusFor(panel: OpenPanel): void {
        if (panel.store) {
            const count = panel.store.getTotalCount() ?? panel.store.getRecords().length;
            this.statusBar.setMessage(`${this._statusScope} · ${panel.ref.name}: ${count} rows`);
        } else {
            this.statusBar.setMessage(`${this._statusScope} · ${panel.ref.name}: ${panel.detail ?? "structure"}`);
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
