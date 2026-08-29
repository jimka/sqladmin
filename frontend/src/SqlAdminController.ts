// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.

import { Dock, Menu, Notification, NotificationHistoryButton, Tooltip }                                                                                                                            from "@jimka/typescript-ui/overlay";
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
import { showObjectMenu }                                                                                                                                                                          from "./navigator/objectMenu";
import { matchesGrantedTable }                                                                                                                                                                     from "./navigator/revealMatch";
import { objectPath, rolePath, databaseDiagramPath, resolveAddressBarRoute }                                                                                                                       from "./shell/routeTargets";
import type { PanelRoute }                                                                                                                                                                         from "./shell/routeTargets";
import type { ColumnMeta, DbObjectRef, RelationNodeRef, RoleDetail, RolePrivilege, RoleSummary } from "./contract";
import { getColumns, getDatabaseGraph, getDependencies, getInheritance, getRoleDetail, getRoles, getSchemaGraph, tableExportUrl } from "./data/api";
import { exportQueryResult }                                                                                                                                                                       from "./dock/exportQueryResult";
import { exportExplainPlan }                                                                                                                                                                       from "./dock/exportExplainResult";
import type { ActiveExport }                                                                                                                                                                       from "./data/explain";
import { buildSchemaDiagram }                                                                                                                                                                      from "./data/buildSchemaDiagram";
import { annotateFkCardinality }                                                                                                                                                                   from "./data/fkCardinality";
import { buildRoleMembershipDiagram }                                                                                                                                                              from "./data/buildRoleMembershipDiagram";
import { buildRoleGrantsDiagram }                                                                                                                                                                  from "./data/buildRoleGrantsDiagram";
import { buildRelationGraph, relationNodeId }                                                                                                                                                      from "./data/buildRelationGraph";
import type { RelationNodeData }                                                                                                                                                                   from "./data/buildRelationGraph";
import { RoleGrantsPanel }                                                                                                                                                                         from "./dock/RoleGrantsPanel";
import { exportRoleGrants }                                                                                                                                                                        from "./dock/exportRoleGrants";
import { SchemaDiagramPanel }                                                                                                                                                                      from "./dock/SchemaDiagramPanel";
import { RelationDiagramPanel }                                                                                                                                                                    from "./dock/RelationDiagramPanel";
import { DatabaseDiagramPanel }                                                                                                                                                                    from "./dock/DatabaseDiagramPanel";
import type { SchemaTables }                                                                                                                                                                       from "./data/buildDatabaseDiagram";
import { RoleGrantsDiagramPanel }                                                                                                                                                                  from "./dock/RoleGrantsDiagramPanel";
import { RelationGraphPanel }                                                                                                                                                                      from "./dock/RelationGraphPanel";
import { RootedRelationGraphPanel }                                                                                                                                                                from "./dock/RootedRelationGraphPanel";
import { RoleMembershipDiagramPanel }                                                                                                                                                              from "./dock/RoleMembershipDiagramPanel";
import type { DiagramData, DiagramNodeData }                                                                                                                                                       from "@jimka/typescript-ui/component/diagram";
import { PropertiesPanel }                                                                                                                                                                          from "./properties/PropertiesPanel";
import { RolesPropertiesPanel }                                                                                                                                                                    from "./roles/RolesPropertiesPanel";
import { KIND_GLYPH }                                                                                                                                                                              from "./navigator/objectGlyphs";
import { kindDisplayLabel }                                                                                                                                                                        from "./navigator/objectKinds";
import { LayoutStore }                                                                                                                                                                             from "./data/layoutStore";
import {
    panelId, structurePanelId, diagramPanelId, relationDiagramPanelId,
    dependencyPanelId, relationDependencyPanelId, inheritancePanelId, relationInheritancePanelId,
    databaseDiagramPanelId, roleGrantsPanelId, roleGrantsDiagramPanelId, roleMembershipDiagramPanelId,
    panelTooltip as buildPanelTooltip, errorMessage, panelIdsFor, tableExportFilename,
} from "./controller/controllerText";
import { downloadUrl } from "./data/download";
import { PanelLoadError } from "./controller/panelHost";
import type { PanelHost, OpenPanel, RoleGrants, AsyncPanelSpec } from "./controller/panelHost";
import { RevealCoordinator } from "./controller/revealCoordinator";
import { DdlLaunchers } from "./controller/ddlLaunchers";
import { QueryWorkspace } from "./controller/queryWorkspace";
import { ObjectPanels } from "./controller/objectPanels";

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

// Dependency graph reads left-to-right as a dependency flow (view -> underlying),
// matching the FK schema diagram's RIGHT layered layout.
const DEPENDENCY_LAYOUT = { "elk.algorithm": "layered", "elk.direction": "RIGHT" };

// Inheritance reads top-to-bottom as a containment tree (parent above children).
const INHERITANCE_LAYOUT = { "elk.algorithm": "layered", "elk.direction": "DOWN" };

/**
 * What the dependency and inheritance graph open paths differ by — everything
 * `openSchemaRelationGraph`/`openRootedRelationGraph` need to build either
 * graph without branching on which one it is.
 */
interface RelationGraphKind {
    /** Route key, title suffix, and status-line word ("dependencies"/"inheritance"). */
    key: "dependencies" | "inheritance";
    /** The tab glyph. */
    glyph: string;
    /** The whole schema's graph, or null after the failure was already reported. */
    fetch: (ref: DbObjectRef) => Promise<DiagramData | null>;
    /** The schema-wide tab's panel id. */
    schemaPanelId: (ref: DbObjectRef) => string;
    /** The relation-rooted tab's panel id. */
    relationPanelId: (ref: DbObjectRef) => string;
}

export class SqlAdminController implements PanelHost {
    readonly dock           : Dock;
    readonly statusBar      : StatusBar;
    readonly properties     : PropertiesPanel;
    readonly rolesProperties: RolesPropertiesPanel;
    // Public (not private-with-delegators like `_history`): eight layout sites
    // bind against it directly, and mirroring the whole store API onto the
    // controller would carry no information.
    readonly layout         : LayoutStore;
    // The reveal-then-select wiring for the two sidebar trees. Constructed
    // first among the collaborators (see the constructor) since ddl/panels/
    // diagrams/roles all depend on it.
    readonly reveal         : RevealCoordinator;
    // Every DDL launcher (create/rename/drop for every object kind, plus the
    // Structure tab's Constraints/Indexes toolbar actions).
    readonly ddl            : DdlLaunchers;
    // Scratch query panels, the run-history/saved-query/notes stores, and
    // recently opened tables.
    readonly workspace      : QueryWorkspace;
    // Every per-object panel opener (table/view data, structure, definition,
    // sequence, index, standalone-type info) and the reveal-then-open wiring
    // for a foreign key's referenced table.
    readonly panels         : ObjectPanels;

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
    // The diagram panels' shared right-click menu, mirroring how NavigatorTree
    // and RolesTree each own one reusable Menu(). Named diagramContextMenu (see
    // below), not showObjectMenu, so the method does not shadow the imported
    // module wrapper of the same purpose.
    private readonly _objectMenu: Menu = Menu();

    // Shell-injected handle (mirroring how ActivityBar takes a SidebarSizer):
    // toggles the start-page deck. The Queries-view selector/section-focuser
    // live on `workspace` instead, and the Database/Roles view selectors live
    // on `reveal` — a reveal never searches a tree whose deck page is hidden.
    private _startToggle        : ((visible: boolean) => void) | null = null;
    // The address-bar sync hook, wired from SqlAdminApp.ts — see setSyncAddressBar.
    private _syncAddressBar     : ((path: string, query?: Record<string, string>) => void) | null = null;

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
    private readonly _activeRoleGrants: Map<string, RoleGrants> = new Map();
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

        // No connectionId — layout is a property of the user's window, not of the
        // database being viewed, so it is scoped per user only (see data/layoutStore.ts).
        this.layout = new LayoutStore(userId, window.localStorage);

        // The reveal-then-select coordinator for the two sidebar trees, and the
        // DDL launchers that depend on it. Built before the rest of the
        // collaborators land (a later plan phase), since panels/diagrams/roles
        // will all depend on both.
        this.reveal    = new RevealCoordinator(connectionId, database);
        this.ddl       = new DdlLaunchers(this, this.reveal);
        this.workspace = new QueryWorkspace(this, this.ddl, username);
        this.panels    = new ObjectPanels(this, this.reveal, this.ddl, this.workspace);

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
        const id = diagramPanelId(ref);

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

            this.status(`${ref.schema}: diagram (${data.nodes.length} tables)`);

            return SchemaDiagramPanel(
                data,
                table => this.panels.openReferencedTable({
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
        const id = databaseDiagramPanelId(ref);

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

            this.status(`${ref.database}: diagram (${tableCount} tables)`);

            return DatabaseDiagramPanel(
                schemas,
                (schema, table) => this.panels.openReferencedTable({
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
        const id = relationDiagramPanelId(ref);

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

            this.status(`${ref.schema}.${ref.name}: relations`);

            return RelationDiagramPanel(
                full,
                root,
                table => this.panels.openReferencedTable({
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

            return buildRelationGraph(edges, ref.schema!, DEPENDENCY_LAYOUT, true, Util.measureTextWidths);
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

            return buildRelationGraph(edges, ref.schema!, INHERITANCE_LAYOUT, undefined, Util.measureTextWidths);
        } catch (err) {
            this.notifyError(err, ref);

            return null;
        }
    }

    /** What the dependency and inheritance graph paths differ by. */
    private graphKind(key: "dependencies" | "inheritance"): RelationGraphKind {
        return key === "dependencies"
            ? {
                key,
                glyph          : "share-nodes",
                fetch          : ref => this.fetchDependencyGraph(ref),
                schemaPanelId  : ref => dependencyPanelId(ref),
                relationPanelId: ref => relationDependencyPanelId(ref),
            }
            : {
                key,
                glyph          : "sitemap",
                fetch          : ref => this.fetchInheritanceGraph(ref),
                schemaPanelId  : ref => inheritancePanelId(ref),
                relationPanelId: ref => relationInheritancePanelId(ref),
            };
    }

    /**
     * The activate / context-menu arrow pair every dependency/inheritance
     * graph panel wires: both route through openReferencedTable /
     * diagramContextMenu, built from the activated node's own schema/name/kind
     * but `ref`'s connectionId/database — a graph node can name a relation in a
     * different schema than the one being diagrammed, but never a different
     * database.
     *
     * @param ref - The schema or relation the graph was opened for.
     * @returns The `onSelect`/`onContextMenu` pair to hand a graph panel.
     */
    private relationGraphHandlers(ref: DbObjectRef): {
        onSelect: (node: RelationNodeData) => void;
        onContextMenu: (node: RelationNodeData, event: MouseEvent) => void;
    } {
        return {
            onSelect: nd => this.panels.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            }),
            onContextMenu: (nd, event) => this.diagramContextMenu({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            }, event),
        };
    }

    /**
     * Open a read-only dependency/inheritance graph for a whole schema in the
     * Dock (deduped by panel id): the schema's relations as nodes, laid out
     * left-to-right by ELK. Node activation is kind-aware: a view opens
     * read-only, a table opens for data.
     *
     * @param ref - The schema to diagram (kind "schema"; database + schema set).
     * @param kind - Which graph (dependencies or inheritance) to open.
     */
    private async openSchemaRelationGraph(ref: DbObjectRef, kind: RelationGraphKind): Promise<void> {
        const id = kind.schemaPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, kind.key) ?? undefined;

        this.openAsyncPanel({
            id,
            title         : `${ref.schema} (${kind.key})`,
            glyph         : kind.glyph,
            ref,
            route,
        }, async () => {
            const data = await kind.fetch(ref);

            if (!data) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            this.status(`${ref.schema}: ${kind.key} (${data.nodes.length} relations)`);

            const { onSelect, onContextMenu } = this.relationGraphHandlers(ref);

            return RelationGraphPanel(data, onSelect, onContextMenu);
        });
    }

    /**
     * Open a relation-rooted dependency/inheritance graph in the Dock (deduped
     * by panel id): the relation as the emphasized root plus its connected
     * component within the direction/depth the panel's own controls choose
     * (seeded at Both/1) from the whole schema's graph. Node activation is
     * kind-aware via openReferencedTable.
     *
     * @param ref - The relation to root at (kind table/view/matview; name set).
     * @param kind - Which graph (dependencies or inheritance) to open.
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    private async openRootedRelationGraph(ref: DbObjectRef, kind: RelationGraphKind, depth?: string): Promise<void> {
        const id = kind.relationPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const built = objectPath(ref, kind.key);
        const route: PanelRoute | undefined = built ? { path: built.path, query: depth ? { depth } : undefined } : undefined;

        this.openAsyncPanel({
            id,
            title         : `${ref.name} (${kind.key})`,
            glyph         : kind.glyph,
            tooltip       : this.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const full = await kind.fetch(ref);

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

            this.status(`${ref.schema}.${ref.name}: ${kind.key}`);

            const { onSelect, onContextMenu } = this.relationGraphHandlers(ref);

            return RootedRelationGraphPanel(full, root, onSelect, onContextMenu, depth);
        });
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
        return this.openSchemaRelationGraph(ref, this.graphKind("dependencies"));
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
        return this.openRootedRelationGraph(ref, this.graphKind("dependencies"), depth);
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
        return this.openSchemaRelationGraph(ref, this.graphKind("inheritance"));
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
        return this.openRootedRelationGraph(ref, this.graphKind("inheritance"), depth);
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
     *
     * @returns True when the focused tab can export.
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
        downloadUrl(tableExportUrl(ref, format), tableExportFilename(ref, format));
    }

    /**
     * Re-open a recently opened table from the start page, reusing the stored
     * navigator node so the reopened panel still drives the tree selection.
     *
     * @param ref - The table ref (matched to a remembered entry by panel id).
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
     *
     * @param toggle - Shows (true) or hides (false) the start page.
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
        const route = resolveAddressBarRoute(id, this._panelRoutes, this._queryPanelRuns, this.workspace.historyList());

        this._syncAddressBar?.(route.path, route.query);
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
        const id = roleGrantsPanelId(this._connectionId, role);

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
     * a node, `role -> parent` edges from each role's `memberOf`, driven by
     * RoleMembershipDiagramPanel (direction / depth / legend). The membership
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
        const id = roleMembershipDiagramPanelId(this._connectionId, name);

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

            const full = buildRoleMembershipDiagram(details, Util.measureTextWidths);
            const root: DiagramNodeData = { id: name, label: name, glyph: ROLE_GLYPH };

            this.status(`${name}: membership (${full.nodes.length} roles)`);

            return RoleMembershipDiagramPanel(full, root, roleName => void this.showRoleProperties(roleName), depth);
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
        const id = roleGrantsDiagramPanelId(this._connectionId, name);

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

            const data = buildRoleGrantsDiagram(name, detail.privileges, Util.measureTextWidths);

            this.status(`${name}: grants graph (${data.nodes.length - 1} tables)`);

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
            const node = await this.reveal.findInNavigator(matchesGrantedTable(schema, table));

            if (!node) {
                this.status(`${schema}.${table}: not found in navigator`);

                return;
            }

            await this.panels.openTable(node.data as DbObjectRef, node);
            this.reveal.selectNavigatorNode(node);
        })();
    }

    /**
     * Refresh the active work tab. Two reloadable shapes: the six storeless
     * detail tabs (structure, definition, function definition, sequence,
     * index, type) dispatch to their own registered `refresh` closure, which
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
     * and as an error Notification. The toast is what lands the error in
     * `Notification.getHistory()` — the status bar's line is clobbered by the
     * next setMessage, so the history is the only place a passed-over error
     * survives. The toast drops the "Error" prefix: its severity badge says so.
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
     * it already fired (and fired too early — before any run existed to
     * resolve to), so without this the address bar would stay on "/" until
     * the user switched tabs away and back (PanelHost).
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
     * lands after its tab closed (or after the id was reopened) is handled by
     * the Dock itself — it cancels the materialization, and the arriving
     * component is disposed rather than mounted.
     *
     * @param spec - The tab's identity.
     */
    openAsyncPanel(
        spec: AsyncPanelSpec,
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
