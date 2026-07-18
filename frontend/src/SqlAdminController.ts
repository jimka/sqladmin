// The app mediator. Owns the Dock, the StatusBar, the current connection, and
// the open-panel registry (deduped by panel id). Components stay dumb: they emit,
// the controller decides. All app-side errors funnel to notifyError.

import { Dialog, Dock, Notification, NotificationHistoryButton, Tooltip }                                                                                                                          from "@jimka/typescript-ui/overlay";
import type { DockPanelEvent }                                                                                                                                                                     from "@jimka/typescript-ui/overlay";
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
import { file_lines }                                                                                                                                                                              from "@jimka/typescript-ui/glyphs/solid/file_lines";
import { user }                                                                                                                                                                                    from "@jimka/typescript-ui/glyphs/solid/user";
import type { TreeNode }                                                                                                                                                                           from "@jimka/typescript-ui/component/tree";
import type { ExplorerTree }                                                                                                                                                                       from "./navigator/NavigatorTree";
import type { AjaxStore, StoreExceptionEvent, StoreSyncEvent }                                                                                                                                     from "@jimka/typescript-ui/data";
import type { AlterColumnAction, ColumnMeta, ConstraintKind, DbObjectRef, FunctionDefinition, RelationNodeRef, RoleDetail, RolePrivilege, RoleSummary, TablePrivileges, TableStructure, TypeDefinition } from "./contract";
import { executeDdl, getColumns, getDependencies, getFunctionDefinition, getInheritance, getObjects, getRoleDetail, getRoles, getSchemas, getTablePrivileges, getTypeDefinition, getViewDefinition, getStructure, previewAlterSequence, previewAlterTable, previewAlterTypeAddValue, previewConstraint, previewCreateCompositeType, previewCreateEnumType, previewCreateFunction, previewCreateMatview, previewCreateSchema, previewCreateSequence, previewCreateTable, previewCreateView, previewDropFunction, previewDropMatview, previewDropSchema, previewDropSequence, previewDropTable, previewDropType, previewDropView, previewIndex, previewRefreshMatview, previewRenameSchema, previewReplaceMatview, previewSequenceOwner, runExplain, runQuery, tableExportUrl } from "./data/api";
import { getSequenceDetail }                                                                                                                                                                       from "./data/api";
import { exportQueryResult }                                                                                                                                                                       from "./dock/exportQueryResult";
import { exportExplainPlan }                                                                                                                                                                       from "./dock/exportExplainResult";
import type { ActiveExport }                                                                                                                                                                       from "./data/explain";
import { buildModel }                                                                                                                                                                              from "./data/buildModel";
import { buildSchemaDiagram }                                                                                                                                                                      from "./data/buildSchemaDiagram";
import { annotateFkCardinality }                                                                                                                                                                   from "./data/fkCardinality";
import { buildRoleMembershipDiagram }                                                                                                                                                              from "./data/buildRoleMembershipDiagram";
import { buildRoleGrantsDiagram }                                                                                                                                                                  from "./data/buildRoleGrantsDiagram";
import { buildRelationGraph, relationNodeId }                                                                                                                                                      from "./data/buildRelationGraph";
import { rootedDiagram }                                                                                                                                                                           from "./data/relationDiagram";
import { buildSelectSql, buildRoutineCallSql, routineCallIsComplete }                                                                                                                              from "./data/sql";
import { buildStore }                                                                                                                                                                              from "./data/stores";
import { TableWorkPanel }                                                                                                                                                                          from "./dock/TableWorkPanel";
import { StructurePanel }                                                                                                                                                                          from "./dock/StructurePanel";
import type { StructureActions }                                                                                                                                                                  from "./dock/StructurePanel";
import { openSqlPreviewDialog }                                                                                                                                                                    from "./dock/SqlPreviewDialog";
import { CreateTableForm }                                                                                                                                                                         from "./dock/CreateTableForm";
import { RenameTableForm }                                                                                                                                                                         from "./dock/RenameTableForm";
import { ColumnForm }                                                                                                                                                                              from "./dock/ColumnForm";
import { AlterColumnForm }                                                                                                                                                                         from "./dock/AlterColumnForm";
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
    // Public (not private-with-delegators like `_history`): eight layout sites
    // bind against it directly, and mirroring the whole store API onto the
    // controller would carry no information.
    readonly layout         : LayoutStore;

    private readonly _connectionId: string;
    private readonly _database    : string | undefined;
    private readonly _openPanels  : Map<string, OpenPanel> = new Map();
    // Live-only panels (QueryPanel, DefinitionPanel, DocumentationPanel) expose
    // a `dispose` that must run on tab close — the framework has no cascading
    // dispose, so the controller owns invoking it (see the "close" handler
    // below).
    private readonly _panelDisposers: Map<string, () => void> = new Map();
    private _navigator            : ExplorerTree | null = null;

    // The per-connection localStorage stores backing the Queries view, the start
    // page, and the panel's Ctrl+↑/↓ recall.
    private readonly _history: QueryHistoryStore;
    private readonly _saved  : SavedQueryStore;
    private readonly _notes  : NotesStore;

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

        // Production storage is the DOM localStorage (persisted per connection);
        // the pure stores keep it injected so their logic tests run DOM-less.
        this._history = new QueryHistoryStore(connectionId, window.localStorage);
        this._saved   = new SavedQueryStore(connectionId, window.localStorage);
        this._notes   = new NotesStore(connectionId, window.localStorage);

        // No connectionId — layout is global by design, unlike the three stores
        // above it (see data/layoutStore.ts).
        this.layout = new LayoutStore(window.localStorage);

        // Disposal is wired once: the dock fires "close" only on genuine
        // destruction (a tear-off fires "detach" and the panel survives). A
        // closed query panel's held result is dropped so it can't be exported.
        this.dock.on("close", (e: DockPanelEvent) => {
            this.disposePanel(e.id);
            this._activeQueryResult.delete(e.id);
            this._activeRoleGrants.delete(e.id);
            this._panelDisposers.get(e.id)?.();
            this._panelDisposers.delete(e.id);
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
     */
    async openTable(ref: DbObjectRef, node?: TreeNode): Promise<void> {
        // A view/matview has no editable data surface, so it opens as an auto-run
        // browse query on the shared QueryPanel rather than a dedicated data panel.
        // A query panel has no pagination, so the seed carries buildSelectSql's
        // small preview LIMIT (the user can raise or remove it). Each open mints a
        // fresh query tab (no dedup, like every query panel); it is still recorded
        // in recent tables so it reopens from the start page.
        if (ref.kind === "view" || ref.kind === "materializedView") {
            if (node) {
                this.rememberTable(ref, node);
            }

            this.openQuery(buildSelectSql(ref), true, ref.name);

            return;
        }

        const id = this.panelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let store: AjaxStore;
        let columns: ColumnMeta[];
        let privileges: TablePrivileges = NO_TABLE_PRIVILEGES;

        try {
            columns = await getColumns(ref);
            privileges = await getTablePrivileges(ref);
            store = buildStore(ref, buildModel(columns), columns);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

        store.on("exception", (e: StoreExceptionEvent) => this.notifyError(e.error, ref));
        store.on("sync", (e: StoreSyncEvent) => this.reportSync(e, ref));

        this._openPanels.set(id, { ref, node: node ?? null, store, columns });

        if (node) {
            this.rememberTable(ref, node);
        }

        // Open lazily: the tab appears at once, and the grid UI builds on first
        // activation behind a spinner, so a wide table never blocks the tab.
        const notify = (message: string): void => { this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: ${message}`); };
        this.dock.addLazyPanel({
            id,
            title  : ref.name ?? id,
            glyph  : KIND_GLYPH[ref.kind],
            tooltip: this.panelTooltip(ref),
            content: () => new TableWorkPanel(store, columns, notify, format => this.exportTable(ref, format), privileges)
        });

        try {
            await store.load();
            this.syncToPanel(id);
        } catch {
            // load() rethrows, but the 'exception' listener already surfaced it.
        }
    }

    /**
     * Open an editable definition tab for a view/matview — its Columns grid
     * above its SQL definition (pg_get_viewdef, the SELECT body only),
     * deduping by definition-panel id. The definition and columns are
     * fetched up front and passed to a `DefinitionPanel` wired with an
     * `onSave` that builds and executes the edit directly, with no
     * intermediate dialog: `CREATE OR REPLACE VIEW` for a view, or the
     * atomic DROP+CREATE replace pair for a materialized view (a
     * materialized view cannot be CREATE OR REPLACE'd — see the
     * view-matview-ddl plan's "Matview edit strategy" decision). On success
     * the navigator refreshes and the tab reseeds itself in place (via
     * `panel.reload`) rather than closing — the object list may be
     * unaffected, but the tab's own definition/columns just changed. A
     * failed fetch surfaces through notifyError and no tab opens; a failed
     * save surfaces through notifyError and leaves the tab (and the user's
     * edits) open. Tables have no definition, so the navigator only offers
     * this for views (see NavigatorTree).
     */
    async openDefinition(ref: DbObjectRef, node: TreeNode): Promise<void> {
        const id = this.definitionPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        let definition: string;
        let columns: ColumnMeta[];

        try {
            [definition, columns] = await this.fetchDefinitionAndColumns(ref);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

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

        panel = new DefinitionPanel(definition, columns, onSave, this.layout.bindSplit("definition"));

        // No `columns` field here: unlike the structure tab (keyed by
        // structurePanelId, whose `columns` backs structureColumns()), the
        // definition tab's columns are only ever read by the DefinitionPanel
        // itself, which already holds its own copy — nothing looks this
        // entry up by definitionPanelId.
        this._openPanels.set(id, { ref, node, detail: "definition" });
        this._panelDisposers.set(id, panel.dispose);
        this.dock.addPanel({
            id,
            title  : `${ref.name ?? id} (definition)`,
            glyph  : "file-code",
            tooltip: this.panelTooltip(ref),
            content: panel.content
        });
        this.syncToPanel(id);
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
     * Open an editable info tab for a sequence — its current value and
     * parameters (pg_sequences), deduping by sequence-info-panel id. The
     * detail and the connection's role names (for the form's Owner combo)
     * are fetched in parallel and passed to a SequenceInfoPanel wired with
     * the alter/owner preview, execute, and reload callbacks its Save flow
     * needs. A failed detail fetch surfaces through notifyError and no tab
     * opens; a failed roles fetch degrades gracefully instead (the tab still
     * opens, with `roles: []` — see SequenceInfoPanelDeps.roles). A sequence
     * has no rows, so unlike openTable this has no store to register, and
     * unlike openDefinition the panel needs no dispose (see
     * SequenceInfoPanel).
     */
    async openSequence(ref: DbObjectRef, node?: TreeNode): Promise<void> {
        const id = this.sequenceInfoPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const [detailResult, rolesResult] = await Promise.allSettled([
            getSequenceDetail(ref),
            getRoles(ref.connectionId),
        ]);

        if (detailResult.status === "rejected") {
            this.notifyError(detailResult.reason, ref);

            return;
        }

        const detail = detailResult.value;
        const roles  = rolesResult.status === "fulfilled" ? rolesResult.value.map(r => r.name) : [];

        this._openPanels.set(id, { ref, node: node ?? null, detail: "info" });
        this.dock.addPanel({
            id,
            title  : ref.name ?? id,
            glyph  : "arrow-up-1-9",
            tooltip: this.panelTooltip(ref),
            content: new SequenceInfoPanel(detail, {
                schema:       ref.schema!,
                name:         ref.name!,
                roles,
                previewAlter: spec => previewAlterSequence(ref, spec),
                previewOwner: spec => previewSequenceOwner(ref, spec),
                execute:      sql => executeDdl(this._connectionId, sql),
                reloadDetail: () => getSequenceDetail(ref),
                onStatus:     m => this.statusBar.setMessage(`${this._statusScope} · ${m}`),
                onError:      m => this.notifyError(new Error(m), ref),
                onOpenOwner:  (schema, table) => this.openReferencedStructure({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }),
            }),
        });
        this.syncToPanel(id);
    }

    /** Open a read-only structure (column metadata) tab for a table/view. */
    async openStructure(ref: DbObjectRef, node?: TreeNode): Promise<void> {
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

        this._openPanels.set(id, { ref, node: node ?? null, columns, detail: "structure" });
        this.dock.addPanel({
            id,
            title  : `${ref.name ?? id} (structure)`,
            glyph  : "table-columns",
            tooltip: this.panelTooltip(ref),
            content: new StructurePanel(columns, structure, (refSchema, refTable) =>
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
                }), this.layout.bindAccordion("structure"), this.structureActionsFor(ref)),
        });
        this.syncToPanel(id);
    }

    /**
     * Build the StructureActions the structure tab's section toolbars call
     * into — one closure per action, each fixed to this tab's own table ref.
     * A table (not a view/matview) is required for any of these to ever be
     * invoked (the navigator only offers table-DDL launchers on a table
     * node), but the type accepts any relation ref uniformly with the rest
     * of the panel.
     *
     * @param ref - The structure tab's own table.
     */
    private structureActionsFor(ref: DbObjectRef): StructureActions {
        return {
            onAddColumn:      () => this.addColumn(ref),
            onAlterColumn:    (column, action) => this.alterColumn(ref, column, action),
            onDropColumn:     column => this.dropColumn(ref, column),
            onAddConstraint:  kind => void this.addConstraint(ref, kind),
            onDropConstraint: constraintName => this.dropConstraint(ref, constraintName),
            onCreateIndex:    () => this.createIndex(ref),
            onDropIndex:      indexName => this.dropIndex(ref, indexName),
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
     * Open the ADD COLUMN dialog for a table (the Columns section toolbar).
     * Success rebuilds the structure tab and closes the data tab (its Model
     * is now stale — see the table-ddl plan's "Stale open data grid" note).
     *
     * @param ref - The table to add a column to.
     */
    addColumn(ref: DbObjectRef): void {
        const form = new ColumnForm();

        openSqlPreviewDialog({
            title:       "Add column",
            form,
            generateSql: async () =>
                (await previewAlterTable(ref, { schema: ref.schema!, name: ref.name!, action: "addColumn", columnDef: form.readColumn() })).sql,
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this.onColumnsChanged(ref),
            onError:   msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the ALTER COLUMN dialog for one action on a column (the Columns
     * section toolbar's "Alter column" submenu). A rename or type change
     * also closes the data tab (its Model's column set/shape is now stale);
     * the toggle-only actions (NOT NULL, default) don't change the column
     * set, so only the structure tab rebuilds.
     *
     * @param ref - The table the column belongs to.
     * @param column - The column being altered.
     * @param action - Which ALTER action to run.
     */
    alterColumn(ref: DbObjectRef, column: ColumnMeta, action: AlterColumnAction): void {
        const form = new AlterColumnForm(ref.schema!, ref.name!, column, action);
        const columnSetChanges = action === "renameColumn" || action === "changeType";

        openSqlPreviewDialog({
            title:       "Alter column",
            form,
            generateSql: async () => (await previewAlterTable(ref, form.readSpec())).sql,
            execute:     sql => executeDdl(this._connectionId, sql),
            onSuccess:   () => columnSetChanges ? this.onColumnsChanged(ref) : this.refreshStructure(ref),
            onError:     msg => this.notifyError(new Error(msg), ref),
        });
    }

    /**
     * Open the DROP COLUMN dialog for a column (the Columns section
     * toolbar). Success rebuilds the structure tab and closes the data tab.
     *
     * @param ref - The table the column belongs to.
     * @param column - The column to drop.
     */
    dropColumn(ref: DbObjectRef, column: ColumnMeta): void {
        const form = new ConfirmCascadeForm(`Drop column "${column.name}" from "${ref.schema}"."${ref.name}"?`);

        openSqlPreviewDialog({
            title:       "Drop column",
            form,
            generateSql: async () => (await previewAlterTable(ref, {
                schema: ref.schema!, name: ref.name!, action: "dropColumn", column: column.name, ...form.readSpec(),
            })).sql,
            execute:   sql => executeDdl(this._connectionId, sql),
            onSuccess: () => this.onColumnsChanged(ref),
            onError:   msg => this.notifyError(new Error(msg), ref),
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
     * double-click or the navigator's "Show definition". Fetches the routine's
     * `pg_get_functiondef` text — already a complete, executable
     * `CREATE OR REPLACE FUNCTION|PROCEDURE …` statement — and seeds a
     * FunctionDefinitionPanel with it, deduping by function-definition-panel
     * id. The panel's Save hands the edited text straight to `executeDdl` with
     * no preview/wrapper (the text is already the whole statement — see the
     * function-type-ddl plan's "prefer CREATE OR REPLACE" decision: a
     * signature-changing edit is the user's own manual escape hatch, not an
     * auto-generated drop-recreate). On success the navigator refreshes and the
     * tab reseeds itself in place (via `panel.reload`) rather than closing. A
     * failed fetch surfaces through notifyError and no tab opens; a failed save
     * surfaces through notifyError and leaves the tab (and the user's edits) open.
     *
     * @param ref - the function/procedure leaf to open (its `signature`
     *   disambiguates overloads).
     */
    async openFunctionDefinition(ref: DbObjectRef, node: TreeNode): Promise<void> {
        const id = this.functionDefinitionPanelId(ref);

        if (this.dock.focusPanel(id)) {
            return;
        }

        const signature = ref.signature ?? "";

        let definition: FunctionDefinition;

        try {
            definition = await getFunctionDefinition(ref, signature);
        } catch (err) {
            this.notifyError(err, ref);

            return;
        }

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

        panel = new FunctionDefinitionPanel(definition.definition, onSave);

        this._openPanels.set(id, { ref, node, detail: "definition" });
        this._panelDisposers.set(id, panel.dispose);
        this.dock.addPanel({
            id,
            // Include the identity signature so two overloads of the same name
            // get visibly distinct tab titles (e.g. `total_orders()` vs
            // `total_orders(p_customer_id integer)`), matching their distinct ids.
            title  : `${ref.name ?? id}(${signature}) (definition)`,
            glyph  : "file-code",
            tooltip: this.panelTooltip(ref),
            content: panel.content,
        });
        this.syncToPanel(id);
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
     * registry (populated by `openStructure`) — the source the Constraints/
     * Indexes forms build their column checklists from. Empty when the
     * structure tab isn't open (a toolbar action can't run without it, so
     * this is defensive, not an expected path).
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
     * Rebuild the structure tab and close the data tab after a change that
     * alters the table's column set (add/drop/rename a column, or change a
     * column's type) — the data tab's Model is now stale (see the table-ddl
     * plan's "Stale open data grid" note); the user reopens it fresh.
     *
     * @param ref - The table whose column set changed.
     */
    private onColumnsChanged(ref: DbObjectRef): void {
        this.refreshStructure(ref);
        this.dock.removePanel(this.panelId(ref));
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
        this._panelDisposers.set(id, panel.dispose);

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

        const data = await this.buildSchemaGraphData(ref);

        if (!data) {
            return;
        }

        this.dock.addPanel({
            id,
            title  : `${ref.schema} (diagram)`,
            glyph  : "diagram-project",
            content: new SchemaDiagramPanel(data, table => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : ref.schema,
                name        : table,
                kind        : "table",
            })),
        });
        this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}: diagram (${data.nodes.length} tables)`);
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
            content: new DatabaseDiagramPanel(schemas, (schema, table) => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema,
                name        : table,
                kind        : "table",
            })),
        });

        const tableCount = schemas.reduce((total, s) => total + s.tables.length, 0);
        this.statusBar.setMessage(`${this._statusScope} · ${ref.database}: diagram (${tableCount} tables)`);
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
            content: new RelationDiagramPanel(full, root, table => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : ref.schema,
                name        : table,
                kind        : "table",
            })),
        });
        this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}.${ref.name}: relations`);
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
            content: new RelationGraphPanel(data, nd => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            })),
        });
        this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}: dependencies (${data.nodes.length} relations)`);
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
            content: new RelationGraphPanel(data, nd => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            }), root.id),
        });
        this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}.${ref.name}: dependencies`);
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
            content: new RelationGraphPanel(data, nd => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            })),
        });
        this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}: inheritance (${data.nodes.length} relations)`);
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
            content: new RelationGraphPanel(data, nd => this.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            }), root.id),
        });
        this.statusBar.setMessage(`${this._statusScope} · ${ref.schema}.${ref.name}: inheritance`);
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
     * Open a column's backing sequence's info tab and reveal it in the
     * navigator — the Structure tab's Sequence link. Best-effort, exactly like
     * {@link openReferencedTable}: if no node matches, the tab still opens.
     *
     * @param ref - The sequence to open (kind "sequence").
     */
    openReferencedSequence(ref: DbObjectRef): void {
        void (async () => {
            const node = await this.revealObject(ref);

            await this.openSequence(ref, node);

            if (node) {
                this._navigator?.selectNode(node);
            }
        })();
    }

    /**
     * Open a table's Structure tab and reveal the table in the navigator — the
     * sequence info tab's "Owned by column" link. Best-effort, exactly like
     * {@link openReferencedTable}.
     *
     * @param ref - The table whose structure to open (kind "table").
     */
    openReferencedStructure(ref: DbObjectRef): void {
        void (async () => {
            const node = await this.revealObject(ref);

            await this.openStructure(ref, node);

            if (node) {
                this._navigator?.selectNode(node);
            }
        })();
    }

    /**
     * Reveal an object's navigator node, expanding the path to it — loading
     * lazy branches (unexpanded schemas) as needed — so the target is revealed
     * even when the user never navigated to it.
     *
     * Unlike {@link openReferencedTable}'s inline predicate, this one also
     * matches on `kind`: a sequence and a relation can share a schema+name
     * (`products_id_seq` is unique, but nothing forbids a table of that name),
     * and matching database/schema/name alone could reveal the wrong node.
     *
     * @param ref - The object to reveal.
     *
     * @returns The revealed node, or undefined when no node matches.
     */
    private async revealObject(ref: DbObjectRef): Promise<TreeNode | undefined> {
        return (await this._navigator?.revealByPredicate((data: unknown) => {
            const r = data as DbObjectRef | undefined;

            return !!r && r.kind === ref.kind && r.database === ref.database
                && r.schema === ref.schema && r.name === ref.name;
        })) ?? undefined;
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
            onRun     : (entry: HistoryEntry) => this.recordRun(entry),
            getHistory: () => this._history.list().map(e => e.sql),
            // The Save toolbar button hands back the trimmed SQL; the
            // controller owns the naming modal and the saved-query store.
            onSave    : (sql: string) => void this.promptAndSaveQuery(sql),
            // Mirror this panel's latest exportable result (rows or plan) so
            // the menubar export can reach it while it is the active panel.
            onResult  : (active: ActiveExport | null) => this._activeQueryResult.set(id, active),
            splitLayout         : this.layout.bindSplit("query"),
            explainDiagramLayout: this.layout.bindAccordion("explainDiagram"),
        });

        this._panelDisposers.set(id, panel.dispose);
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
            content: new RoleGrantsPanel(role, privileges),
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
            content: new RelationDiagramPanel(full, root, roleName => void this.showRoleProperties(roleName)),
        });
        this.statusBar.setMessage(`${this._statusScope} · ${name}: membership (${full.nodes.length} roles)`);
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
            content: new RoleGrantsDiagramPanel(data, (schema, table) => this.openGrantedTable(schema, table)),
        });
        this.statusBar.setMessage(`${this._statusScope} · ${name}: grants graph (${data.nodes.length - 1} tables)`);
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
                this.statusBar.setMessage(`${this._statusScope} · ${schema}.${table}: not found in navigator`);

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
