// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.

import { Dock, Tooltip }                                       from "@jimka/typescript-ui/overlay";
import type { DockPanelEvent }                                 from "@jimka/typescript-ui/overlay";
import { Component }                                           from "@jimka/typescript-ui/core";
import { HBox }                                                from "@jimka/typescript-ui/layout";
import { StatusBar }                                           from "@jimka/typescript-ui/component/container";
import { Text }                                                from "@jimka/typescript-ui/component/input";
import { Glyph }                                               from "@jimka/typescript-ui/component/display";
import { terminal }                                            from "@jimka/typescript-ui/glyphs/solid/terminal";
import { table_columns }                                       from "@jimka/typescript-ui/glyphs/solid/table_columns";
import { file_code }                                           from "@jimka/typescript-ui/glyphs/solid/file_code";
import { key }                                                 from "@jimka/typescript-ui/glyphs/solid/key";
import { diagram_project }                                     from "@jimka/typescript-ui/glyphs/solid/diagram_project";
import { file_lines }                                          from "@jimka/typescript-ui/glyphs/solid/file_lines";
import { user }                                                from "@jimka/typescript-ui/glyphs/solid/user";
import type { MarkdownEditor }                                 from "@jimka/typescript-ui/component/editor";import type { Tree, TreeNode }                                 from "@jimka/typescript-ui/component/tree";
import type { AjaxStore, StoreExceptionEvent, StoreSyncEvent } from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef, RelationNodeRef, RoleDetail, RolePrivilege, RoleSummary, TablePrivileges, TableStructure } from "./contract";
import { getColumns, getDependencies, getInheritance, getObjects, getRoleDetail, getRoles, getSchemas, getTablePrivileges, getViewDefinition, getStructure, runExplain, runQuery, tableExportUrl } from "./data/api";import { exportQueryResult }                                   from "./dock/exportQueryResult";
import { exportExplainPlan }                                   from "./dock/exportExplainResult";
import type { ActiveExport }                                   from "./data/explain";
import { buildModel }                                          from "./data/buildModel";
import { buildSchemaDiagram }                                  from "./data/buildSchemaDiagram";
import { annotateFkCardinality }                                from "./data/fkCardinality";
import { buildRoleMembershipDiagram }                          from "./data/buildRoleMembershipDiagram";
import { buildRoleGrantsDiagram }                              from "./data/buildRoleGrantsDiagram";
import { buildRelationGraph, relationNodeId }                  from "./data/buildRelationGraph";
import { rootedDiagram }                                       from "./data/relationDiagram";
import { buildSelectSql }                                      from "./data/sql";import { buildStore }                                          from "./data/stores";
import { TableWorkPanel }                                      from "./dock/TableWorkPanel";
import { ViewWorkPanel }                                       from "./dock/ViewWorkPanel";
import { StructurePanel }                                      from "./dock/StructurePanel";
import { DefinitionPanel }                                     from "./dock/DefinitionPanel";
import { DocumentationPanel }                                  from "./dock/DocumentationPanel";
import { QueryPanel }                                          from "./dock/QueryPanel";
import { RoleGrantsPanel }                                     from "./dock/RoleGrantsPanel";
import { exportRoleGrants }                                     from "./dock/exportRoleGrants";
import { SchemaDiagramPanel }                                  from "./dock/SchemaDiagramPanel";
import { RelationDiagramPanel }                                from "./dock/RelationDiagramPanel";
import { DatabaseDiagramPanel }                                from "./dock/DatabaseDiagramPanel";
import type { SchemaTables }                                   from "./data/buildDatabaseDiagram";
import { RoleGrantsDiagramPanel }                              from "./dock/RoleGrantsDiagramPanel";
import { RelationGraphPanel }                                  from "./dock/RelationGraphPanel";
import type { DiagramData, DiagramNodeData }                   from "@jimka/typescript-ui/component/diagram";import { PropertiesPanel, relationTypeLabel }                  from "./properties/PropertiesPanel";
import { RolesPropertiesPanel }                                from "./roles/RolesPropertiesPanel";
import { KIND_GLYPH }                                          from "./navigator/objectGlyphs";
import { QueryHistoryStore, SavedQueryStore }                  from "./data/queryStore";
import type { HistoryEntry, SavedQuery }                       from "./data/queryStore";
import { NotesStore }                                          from "./data/notesStore";
import { promptQueryName }                                     from "./promptQueryName";

// The non-relation dock-tab glyphs (query / structure / definition / grants /
// schema diagram / notes). The relation-kind glyphs (table / view / materialized
// view) come from objectGlyphs via KIND_GLYPH, which registers them. `user` is
// the membership-diagram root's glyph — also registered by RolesTree.ts, but
// registered here too so the root node always renders regardless of whether the
// Roles rail has mounted yet.
Glyph.register(terminal, table_columns, file_code, key, diagram_project, file_lines, user);

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

// The write-nothing default carried down the read-only (view/matview) path,
// where TableWorkPanel is never built and the value is unused — it only keeps
// the editable-table privileges variable definitely-assigned.
const NO_TABLE_PRIVILEGES: TablePrivileges = { select: false, insert: false, update: false, delete: false };

// Dependency graph reads left-to-right as a dependency flow (view -> underlying),
// matching the FK schema diagram's RIGHT layered layout.
const DEPENDENCY_LAYOUT = { "elk.algorithm": "layered", "elk.direction": "RIGHT" };

// Inheritance reads top-to-bottom as a containment tree (parent above children).
const INHERITANCE_LAYOUT = { "elk.algorithm": "layered", "elk.direction": "DOWN" };

export class SqlAdminController {
    readonly dock           : Dock;
    readonly statusBar      : StatusBar;
    readonly properties     : PropertiesPanel;
    readonly rolesProperties: RolesPropertiesPanel;

    private readonly _connectionId: string;
    private readonly _openPanels  : Map<string, OpenPanel> = new Map();
    // Live-only panels (QueryPanel, DefinitionPanel) return a teardown closure
    // that must run on tab close — the framework has no cascading dispose, so
    // the controller owns invoking it (see the "close" handler below).
    private readonly _panelDisposers: Map<string, () => void> = new Map();
    private _navigator            : Tree | null = null;

    // The per-connection localStorage stores backing the Queries view, the start
    // page, and the panel's Ctrl+↑/↓ recall.
    private readonly _history: QueryHistoryStore;
    private readonly _saved  : SavedQueryStore;
    private readonly _notes  : NotesStore;

    // The live MarkdownEditor backing the notes tab, held so it can be disposed
    // by hand on tab close (MarkdownEditor.dispose() is not framework-driven —
    // see the "close" handler below).
    private _notesEditor: MarkdownEditor | null = null;

    // Recently opened tables (newest-first), surfaced on the start page.
    private readonly _recentTables: RecentTable[] = [];

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
     * @param database - The connected database, shown in the identity tooltip.
     */
    constructor(connectionId: string = "default", username?: string, database?: string) {
        this._connectionId = connectionId;
        // The dock owns its own emptiness; drive the start-page deck straight off
        // its "emptychange" aggregate (empty↔populated, once per transition)
        // instead of shadow-counting opens and closes here.
        this.dock            = Dock({ listeners: { emptychange: e => this._startToggle?.(e.empty) } });
        this.statusBar       = new StatusBar();
        this.properties      = new PropertiesPanel();
        this.rolesProperties = new RolesPropertiesPanel();

        // Production storage is the DOM localStorage (persisted per connection);
        // the pure stores keep it injected so their logic tests run DOM-less.
        this._history = new QueryHistoryStore(connectionId, window.localStorage);
        this._saved   = new SavedQueryStore(connectionId, window.localStorage);
        this._notes   = new NotesStore(connectionId, window.localStorage);

        // Disposal is wired once: the dock fires "close" only on genuine
        // destruction (a tear-off fires "detach" and the panel survives). A
        // closed query panel's held result is dropped so it can't be exported.
        this.dock.on("close", (e: DockPanelEvent) => {
            this.disposePanel(e.id);
            this._activeQueryResult.delete(e.id);
            this._activeRoleGrants.delete(e.id);
            this._panelDisposers.get(e.id)?.();
            this._panelDisposers.delete(e.id);

            if (e.id === this.notesPanelId()) {
                this._notesEditor?.dispose();
                this._notesEditor = null;
            }
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

        // Pin the signed-in identity to the status bar's RIGHT zone. The left
        // zone shows transient per-operation messages (setMessage), so identity
        // lives on the right where those never clobber it.
        if (username) {
            this.statusBar.addRight(buildIdentityWidget(username, database));
        }
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

        // A view/matview is read-only: it opens the ViewWorkPanel and never
        // writes, so the 'sync' write-feedback listener is not attached and the
        // per-user table privileges (which gate the editable panel's write
        // actions) are not fetched.
        const isReadOnly = ref.kind === "view" || ref.kind === "materializedView";

        let store: AjaxStore;
        let columns: ColumnMeta[];
        let privileges: TablePrivileges = NO_TABLE_PRIVILEGES;

        try {
            columns = await getColumns(ref);
            if (!isReadOnly) {
                privileges = await getTablePrivileges(ref);
            }
            store = buildStore(ref, buildModel(columns), columns);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        store.on("exception", (e: StoreExceptionEvent) => this.notifyError(e.error, ref));

        if (!isReadOnly) {
            store.on("sync", (e: StoreSyncEvent) => this.reportSync(e, ref));
        }

        this._openPanels.set(id, { ref, node: node ?? null, store, columns });

        if (node) {
            this.rememberTable(ref, node);
        }

        // Open lazily: the tab appears at once, and the grid UI builds on first
        // activation behind a spinner, so a wide table never blocks the tab.
        const notify = (message: string): void => { this.statusBar.setMessage(`${this._connectionId} · ${ref.name}: ${message}`); };
        this.dock.addLazyPanel({
            id,
            title  : ref.name ?? id,
            glyph  : KIND_GLYPH[ref.kind],
            tooltip: this.panelTooltip(ref),
            content: isReadOnly
                ? () => ViewWorkPanel(store, columns, format => this.exportTable(ref, format),
                    // Explain opens a query tab seeded with the view's own query
                    // (no LIMIT — a LIMIT node would mask the plan's real cost) and
                    // auto-runs EXPLAIN / EXPLAIN ANALYZE there.
                    analyze => this.openQuery(buildSelectSql(ref, null), false, ref.name, analyze ? "analyze" : "plain"))
                : () => TableWorkPanel(store, columns, notify, format => this.exportTable(ref, format), privileges)
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

        const { content, dispose } = DefinitionPanel(definition);

        this._openPanels.set(id, { ref, node, detail: "definition" });
        this._panelDisposers.set(id, dispose);
        this.dock.addPanel({
            id,
            title  : `${ref.name ?? id} (definition)`,
            glyph  : "file-code",
            tooltip: this.panelTooltip(ref),
            content
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
        this.dock.addPanel({
            id,
            title  : `${ref.name ?? id} (structure)`,
            glyph  : "table-columns",
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
     * Open (or focus) the singleton documentation/notes tab for this connection:
     * a WYSIWYG MarkdownEditor seeded from and persisting to the per-connection
     * notes store. Not registered in `_openPanels` (it carries no `DbObjectRef`),
     * matching how scratch query panels are handled.
     */
    openDocumentation(): void {
        const id = this.notesPanelId();

        if (this.dock.focusPanel(id)) {
            return;
        }

        const { component, editor } = DocumentationPanel(
            this._notes.load(),
            markdown => this._notes.save(markdown),
        );
        this._notesEditor = editor;

        this.dock.addPanel({ id, title: "Notes", glyph: "file-lines", content: component });
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

        const data = await this.buildSchemaGraphData(ref);

        if (!data) {
            return;
        }

        this.dock.addPanel({
            id,
            title  : `${ref.schema} (diagram)`,
            glyph  : "diagram-project",
            content: SchemaDiagramPanel(data, table => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : ref.schema,
                name        : table,
                kind        : "table",
            })),
        });
        this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}: diagram (${data.nodes.length} tables)`);
    }

    /**
     * Fetch a whole schema's ER graph: list its tables, load each table's
     * structure, and assemble the nodes+edges via buildSchemaDiagram. Shared by
     * the schema diagram and the relation-rooted diagram (which walks this full
     * graph from a chosen root). Returns null on failure, having already
     * reported the error.
     *
     * @param ref - The schema to fetch (database + schema set).
     * @param opts - `withColumns` also fetches every table's columns and builds
     *   card-mode nodes (table cards + column-to-column FK ports) — used by the
     *   relation-rooted diagram; omitted (or false) keeps the flat table-to-table
     *   graph the schema-wide diagram shows.
     * @returns The full schema graph, or null if the fetch failed.
     */
    private async buildSchemaGraphData(ref: DbObjectRef, opts?: { withColumns?: boolean }): Promise<DiagramData | null> {
        try {
            const objects    = await getObjects(ref.connectionId, ref.database!, ref.schema!);
            const tables     = objects.filter(o => o.kind === "table").map(o => o.name);
            const refFor     = (name: string): DbObjectRef =>
                ({ connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name, kind: "table" });

            // Structures and columns fetch concurrently in one Promise.all round.
            // Columns are always needed for FK cardinality annotation; card mode
            // additionally reuses the same fetched columns (no second round-trip).
            const [structures, columns] = await Promise.all([
                Promise.all(tables.map(name => getStructure(refFor(name)))),
                Promise.all(tables.map(name => getColumns(refFor(name)))),
            ]);

            const columnsByTable: Map<string, ColumnMeta[]> | undefined =
                opts?.withColumns ? new Map(tables.map((name, i) => [name, columns[i]])) : undefined;

            return annotateFkCardinality(buildSchemaDiagram(tables, structures, columnsByTable), tables, structures, columns);
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

        const schemas = await this.buildDatabaseGraphData(ref);

        if (!schemas) {
            return;
        }

        this.dock.addPanel({
            id,
            title  : `${ref.database} (diagram)`,
            glyph  : "diagram-project",
            content: DatabaseDiagramPanel(schemas, (schema, table) => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema,
                name        : table,
                kind        : "table",
            })),
        });

        const tableCount = schemas.reduce((total, s) => total + s.tables.length, 0);
        this.statusBar.setMessage(`${this._connectionId} · ${ref.database}: diagram (${tableCount} tables)`);
    }

    /**
     * Fetch every schema's tables + structures for the database diagram: list
     * the database's schemas, then per schema list its tables and load each
     * table's structure. The fetch is `O(schemas × tables)` round trips — a
     * one-shot cost behind the tab open; the on-screen graph size is bounded by
     * DatabaseDiagramPanel's rooted+prune+per-schema-hide filter layer, not by
     * this fetch. Returns null on failure, having already reported the error.
     *
     * @param ref - The database to fetch (database set).
     * @returns Every schema's tables + structures, or null if the fetch failed.
     */
    private async buildDatabaseGraphData(ref: DbObjectRef): Promise<SchemaTables[] | null> {
        try {
            const schemaList = await getSchemas(ref.connectionId, ref.database!);

            return await Promise.all(schemaList.map(async ({ name: schema }) => {
                const objects    = await getObjects(ref.connectionId, ref.database!, schema);
                const tables     = objects.filter(o => o.kind === "table").map(o => o.name);
                const structures = await Promise.all(tables.map(name =>
                    getStructure({ connectionId: ref.connectionId, database: ref.database, schema, name, kind: "table" })));

                return { schema, tables, structures } satisfies SchemaTables;
            }));
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
     */
    async openRelationDiagram(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = this.relationDiagramPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const full = await this.buildSchemaGraphData(ref, { withColumns: true });

        if (!full) {
            return;
        }

        const root: DiagramNodeData = { id: ref.name!, label: ref.name!, glyph: KIND_GLYPH[ref.kind] };

        this.dock.addPanel({
            id,
            title  : `${ref.name} (relations)`,
            glyph  : "diagram-project",
            tooltip: this.panelTooltip(ref),
            content: RelationDiagramPanel(full, root, table => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : ref.schema,
                name        : table,
                kind        : "table",
            })),
        });
        this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}.${ref.name}: relations`);
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

        const data = await this.fetchDependencyGraph(ref);

        if (!data) {
            return;
        }

        this.dock.addPanel({
            id,
            title  : `${ref.schema} (dependencies)`,
            glyph  : "diagram-project",
            content: RelationGraphPanel(data, nd => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            })),
        });
        this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}: dependencies (${data.nodes.length} relations)`);
    }

    /**
     * Open a relation-rooted dependency graph in the Dock (deduped by panel
     * id): the relation as the emphasized root plus its connected dependency
     * component (both directions, unbounded depth) from the whole schema's
     * dependency graph. Node activation is kind-aware via openReferencedTable.
     *
     * @param ref - The relation to root at (kind table/view/matview; name set).
     * @param _node - The relation's navigator node; accepted for call-site
     *   parity with the other open methods but unused.
     */
    async openRelationDependencyGraph(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = this.relationDependencyPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const full = await this.fetchDependencyGraph(ref);

        if (!full) {
            return;
        }

        const root: DiagramNodeData = {
            id   : relationNodeId(ref as RelationNodeRef),
            label: ref.name!,
            glyph: KIND_GLYPH[ref.kind],
            data : { schema: ref.schema!, name: ref.name!, kind: ref.kind },
        };
        const data = rootedDiagram(full, root, "both", Number.POSITIVE_INFINITY);

        this.dock.addPanel({
            id,
            title  : `${ref.name} (dependencies)`,
            glyph  : "diagram-project",
            tooltip: this.panelTooltip(ref),
            content: RelationGraphPanel(data, nd => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            }), root.id),
        });
        this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}.${ref.name}: dependencies`);
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

        const data = await this.fetchInheritanceGraph(ref);

        if (!data) {
            return;
        }

        this.dock.addPanel({
            id,
            title  : `${ref.schema} (inheritance)`,
            glyph  : "diagram-project",
            content: RelationGraphPanel(data, nd => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            })),
        });
        this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}: inheritance (${data.nodes.length} relations)`);
    }

    /**
     * Open a relation-rooted inheritance/partitioning graph in the Dock
     * (deduped by panel id): the relation as the emphasized root plus its
     * connected inheritance component (both directions, unbounded depth) from
     * the whole schema's inheritance graph. Node activation is kind-aware via
     * openReferencedTable.
     *
     * @param ref - The relation to root at (kind table; name set).
     * @param _node - The relation's navigator node; accepted for call-site
     *   parity with the other open methods but unused.
     */
    async openRelationInheritanceGraph(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = this.relationInheritancePanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const full = await this.fetchInheritanceGraph(ref);

        if (!full) {
            return;
        }

        const root: DiagramNodeData = {
            id   : relationNodeId(ref as RelationNodeRef),
            label: ref.name!,
            glyph: KIND_GLYPH[ref.kind],
            data : { schema: ref.schema!, name: ref.name!, kind: ref.kind },
        };
        const data = rootedDiagram(full, root, "both", Number.POSITIVE_INFINITY);

        this.dock.addPanel({
            id,
            title  : `${ref.name} (inheritance)`,
            glyph  : "diagram-project",
            tooltip: this.panelTooltip(ref),
            content: RelationGraphPanel(data, nd => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            }), root.id),
        });
        this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}.${ref.name}: inheritance`);
    }

    /**
     * Open a foreign key's referenced table in the Dock and reveal it in the
     * navigator. `Tree.revealByPredicate` expands the path to the node —
     * loading lazy branches (unexpanded schemas) as needed — so the target is
     * revealed even when the user never navigated to it, then the tab opens with
     * that node (so the panel remembers it) and it is selected. Best-effort: if
     * no node matches, the tab still opens.
     *
     * @param ref - The referenced table to open.
     */
    openReferencedTable(ref: DbObjectRef): void {
        void (async () => {
            const node = (await this._navigator?.revealByPredicate((data: unknown) => {
                const r = data as DbObjectRef | undefined;

                return !!r && r.database === ref.database && r.schema === ref.schema && r.name === ref.name;
            })) ?? undefined;

            await this.openTable(ref, node);

            if (node) {
                this._navigator?.selectNode(node);
            }
        })();
    }

    /**
     * Open a fresh scratch query panel, optionally seeded with SQL to run on
     * open. Each call mints a new id, so re-invoking always opens a new panel
     * (no dedup — the natural behaviour for a scratch buffer).
     *
     * Query panels are deliberately NOT registered in `_openPanels`: they carry
     * no `ref`/`node`/`columns` and need no dedup or focus-sync, so the
     * table-panel lifecycle (`OpenPanel`/`syncToPanel`/`disposePanel`) stays
     * untouched. The controller does hold one reference back to each panel: its
     * `dispose` closure, kept in `_panelDisposers` and invoked from the Dock's
     * "close" handler — the framework has no cascading dispose, and the panel's
     * live CodeEditor(s) would otherwise leak their CodeMirror view and
     * ThemeManager subscription.
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

        const notify = (message: string): void => {
            this.statusBar.setMessage(`${this._connectionId} · ${label}: ${message}`);
        };

        const { content, dispose } = QueryPanel({
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
            onRun     : (entry: HistoryEntry) => this.recordRun(entry),
            getHistory: () => this._history.list().map(e => e.sql),
            // The Save toolbar button hands back the trimmed SQL; the
            // controller owns the naming modal and the saved-query store.
            onSave    : (sql: string) => void this.promptAndSaveQuery(sql),
            // Mirror this panel's latest exportable result (rows or plan) so
            // the menubar export can reach it while it is the active panel.
            onResult  : (active: ActiveExport | null) => this._activeQueryResult.set(id, active)
        });

        this._panelDisposers.set(id, dispose);
        this.dock.addPanel({ id, title: label, glyph: "terminal", content });
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
                this.statusBar.setMessage(`${this._connectionId} · export: ${message}`);
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
        const detail = await this.fetchRoleDetail(name);

        if (detail) {
            this.rolesProperties.show(detail);
            this.openRoleGrants(name, detail.privileges);
        }
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

        this.dock.addPanel({
            id,
            title  : `Grants: ${role}`,
            glyph  : "key",
            content: RoleGrantsPanel(role, privileges),
        });

        // Track the grant set so the active-tab export (Tools menu) can reach it
        // while this tab is focused, mirroring _activeQueryResult for query panels.
        this._activeRoleGrants.set(id, { role, privileges });
    }

    /**
     * Open (or focus) the role-membership graph rooted at `name`: every role as
     * a node, `role -> parent` edges from each role's `memberOf`, driven by the
     * reused RelationDiagramPanel (direction / depth / legend). The membership
     * DAG needs every role's detail, so this fans out N per-role fetches
     * (mirroring buildSchemaGraphData's per-table fan-out) — acceptable for a
     * small role list. Double-clicking another role node shows its properties
     * in the inspector; it does not open a table tab.
     *
     * @param name - The role to root the graph at.
     */
    async openRoleMembershipDiagram(name: string): Promise<void> {
        const id = this.roleMembershipDiagramPanelId(name);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let details: RoleDetail[];

        try {
            const roles = await this.loadRoles();
            details = await Promise.all(roles.map(r => getRoleDetail(this._connectionId, r.name)));
        } catch (err) {
            this.notifyError(err);

            return;
        }

        const full = buildRoleMembershipDiagram(details);
        const root: DiagramNodeData = { id: name, label: name, glyph: ROLE_GLYPH };

        this.dock.addPanel({
            id,
            title  : `${name} (membership)`,
            glyph  : "diagram-project",
            content: RelationDiagramPanel(full, root, roleName => void this.showRoleProperties(roleName)),
        });
        this.statusBar.setMessage(`${this._connectionId} · ${name}: membership (${full.nodes.length} roles)`);
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

        const detail = await this.fetchRoleDetail(name);

        if (!detail) {
            return;
        }

        const data = buildRoleGrantsDiagram(name, detail.privileges);

        this.dock.addPanel({
            id,
            title  : `${name} (grants graph)`,
            glyph  : "diagram-project",
            content: RoleGrantsDiagramPanel(data, (schema, table) => this.openGrantedTable(schema, table)),
        });
        this.statusBar.setMessage(`${this._connectionId} · ${name}: grants graph (${data.nodes.length - 1} tables)`);
    }

    /**
     * Reveal a granted table in the navigator by schema+name and open it
     * (best-effort). `RolePrivilege` carries no database (the roles endpoint is
     * not database-scoped), so — unlike openReferencedTable, which matches on
     * database + schema + name — this matches on schema + name only and adopts
     * whichever database the first matching revealed navigator node carries. If
     * no node matches (the table's database was never browsed, or the tree is
     * not loaded), status-bars a "not found" message and opens nothing.
     *
     * @param schema - The granted table's schema.
     * @param table - The granted table's name.
     */
    openGrantedTable(schema: string, table: string): void {
        void (async () => {
            const node = (await this._navigator?.revealByPredicate((data: unknown) => {
                const r = data as DbObjectRef | undefined;

                return !!r && r.schema === schema && r.name === table;
            })) ?? undefined;

            if (!node) {
                this.statusBar.setMessage(`${this._connectionId} · ${schema}.${table}: not found in navigator`);

                return;
            }

            await this.openTable(node.data as DbObjectRef, node);
            this._navigator?.selectNode(node);
        })();
    }

    /**
     * Refresh the active work tab if it is a reloadable data grid: reload the
     * table's or view's store from the server, discarding a table's unsaved edits
     * first (mirroring the grid's own Refresh button — a read-only view has no
     * edits to reject). A no-op when the focused tab has no store (a query, a
     * role's grants, a structure/definition tab, or the empty start page), so
     * "refresh the current view" simply does nothing when there is nothing to
     * reload. Wired to the Alt+R accelerator.
     */
    refreshActive(): void {
        const entry = this._activePanelId ? this._openPanels.get(this._activePanelId) : undefined;

        if (!entry?.store) {
            return;
        }

        const readOnly = entry.ref.kind === "view" || entry.ref.kind === "materializedView";

        if (!readOnly) {
            entry.store.reject();
        }

        void entry.store.load();
        this.statusBar.setMessage(`${this._connectionId} · ${entry.ref.name ?? ""}: refreshed`);
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
