---
depends-on: [ddl-forms-in-tab-editing, diagram-panel-family-convergence, refresh-export-action-dedup]
touches-shared:
  - frontend/src/SqlAdminController.ts
  - frontend/src/navigator/objectMenu.ts
  - frontend/src/shell/SqlAdminShell.ts
  - frontend/src/shell/ActivityBar.ts
  - frontend/COMPONENT_CONVENTIONS.md
---

# SqlAdminController Split — Implementation Plan

## Overview

`frontend/src/SqlAdminController.ts` is one class doing seven jobs: opening a panel
for every object kind, launching every DDL flow, revealing objects in the two
sidebar trees, running the query workspace and its localStorage stores, resolving
address-bar routes, routing exports, and carrying the app's error and status
plumbing. It has no test coverage anywhere in `frontend/tests/`.
[`navigator/objectMenu.ts`](frontend/src/navigator/objectMenu.ts)'s
`ObjectMenuActions` already has to `Pick` **33** methods off the class to describe
what a right-click menu needs — a surface that wide is the symptom.

This plan cuts the class into a coordinator plus six collaborator modules and two
supporting modules — the pure helpers and the shared seam — under a new
`frontend/src/controller/` directory. Every
collaborator reaches the app through one injected `PanelHost` interface; the
coordinator holds each collaborator as a public readonly field, so consumers call
`controller.panels.openTable(…)` the same way they already call
`controller.layout.bindSplit(…)`. Two of the new modules are free of library
imports and get node tests — `controllerText.ts` (the panel-id builders, the
tooltip, the status-name elision, the error-message extraction) and
`revealCoordinator.ts` (the reveal-then-open wiring repeated across seven call
sites today).

Three sibling plans land first and reshape the file this one operates on, so
`SqlAdminController.ts` is addressed **by member name throughout, never by line
number**.[^post-convergence] Alongside the split, this plan closes the audit's
in-file advisory items — the three-way duplicated reveal-then-open tail, eight
public methods no other file can reach, an orphaned JSDoc block, inconsistent
stale-tab cleanup after a DROP — and four documentation defects outside it.

---

## Architecture Decisions

### The cut is by responsibility, not by object kind

The audit proposed a per-kind split (relations / routines+types /
schema+sequence+index / roles / queries). This plan cuts by what the code *does*
instead: panel-opening, diagram-opening, DDL launching, reveal, workspace, roles.
A per-kind cut would file `dropTable` beside `openTable` — two methods that share
a noun and nothing else — and would scatter the eight near-identical DDL creation
launchers across four files.[^why-responsibility]

### Six collaborators, reached through public readonly fields

`SqlAdminController` gains `reveal`, `ddl`, `workspace`, `panels`, `diagrams` and
`roles` as public readonly fields, and external callers reach through them —
`controller.panels.openTable(ref, node)`, `controller.ddl.dropTable(ref)`. The
class does **not** keep delegating wrappers. This is the rule the file already
states for its five existing collaborator fields (`dock`, `statusBar`,
`properties`, `rolesProperties`, `layout`): "mirroring the whole store API onto
the controller would carry no information".[^no-delegation]

### One `PanelHost` interface is the only seam back to the coordinator

Each collaborator is constructed with a `PanelHost` — five shared surfaces (the
Dock, the layout store, the connection identity, the roles inspector) and the
thirteen operations the panel registry and the status/error plumbing expose.
`SqlAdminController implements PanelHost`. No
collaborator imports `SqlAdminController.ts`, so no import cycle can form. This is
[`ActivityBar.ts:77-82`](frontend/src/shell/ActivityBar.ts#L77)'s `SidebarSizer`
idiom at a larger scale, and the same deps-interface style as `StructureActions`
and `SequenceInfoPanelDeps`.[^host-not-bus]

### Cross-module calls are direct constructor-injected references

Where one collaborator needs another it holds it directly; there is no event bus
and nothing routes back through the coordinator. The reference graph is acyclic,
which fixes the construction order:

| Built | Depends on |
|---|---|
| 1. `reveal` | connection id + database only |
| 2. `ddl` | host, `reveal` |
| 3. `workspace` | host, `ddl` |
| 4. `panels` | host, `reveal`, `ddl`, `workspace` |
| 5. `diagrams` | host, `panels`, the context-menu callback |
| 6. `roles` | host, `reveal`, `panels`, the context-menu callback |

Two edges were cut to keep the graph acyclic: `reopenTable` moves to the
coordinator, and the diagram/roles panels take the object context menu as an
injected callback rather than the controller itself.[^acyclic]

### `objectMenu.ts`'s `Pick` splits into four narrow slices

`ObjectMenuActions` stops being one 33-member `Pick<SqlAdminController, …>` and
becomes a small record of four per-collaborator slices plus `exportTable`.
`SqlAdminController` still satisfies it structurally, so `NavigatorTree` keeps
passing `this.controller` and the controller keeps passing `this`; only the item
bodies gain a group prefix.[^pick-split]

### The pure helpers get their own module and their own tests

`controllerText.ts` holds the nineteen panel-id builders, `panelIdsFor`,
`panelTooltip`, `elideName`, `errorMessage` and `detailOf` as free functions with
no library import, tested under the node vitest harness. That is the repo's
established extraction pattern, applied six times already —
[`startPageWelcome.ts:1-5`](frontend/src/shell/startPageWelcome.ts#L1),
[`appHeaderText.ts:1-3`](frontend/src/shell/appHeaderText.ts#L1),
[`routeTargets.ts:8-11`](frontend/src/shell/routeTargets.ts#L8),
`recordNavigation.ts`, `quickSearchModel.ts`, `tableWriteRules.ts` — each with a
header saying why and a matching `frontend/tests/` file.

`panelTooltip` takes the type label as a parameter rather than importing it, so
`controllerText.ts` stays free of `properties/PropertiesPanel.ts` (which touches
the DOM at import scope). The coordinator supplies the label.[^tooltip-label]

### The reveal-then-open tail becomes two methods over one body

Seven call sites repeat "reveal a node, then select it, sometimes expand it,
sometimes start a panel open alongside". `RevealCoordinator` exposes
`revealInNavigator(match, options?)` and `revealInRoles(match, options?)` over one
private body. Two public methods, not one, because the two trees differ in which
view is brought forward, which tree is awaited, and which tree is
selected.[^two-reveals] An eighth site, `openGrantedTable`, must read the revealed
node before it can decide what to open, so it gets an awaitable
`findInNavigator(match)` over the same body.

### A DROP closes every tab for the dropped object

`closeTabsFor(ref)` on the coordinator removes every panel id that can exist for
`ref`, derived by the pure `panelIdsFor(ref)`. It replaces `dropTable`'s two
hand-listed ids, `dropRelation`'s different two, and `dropFunction`'s one, none of
which reach the object's diagram, dependency or inheritance tabs.[^close-tabs]

### `onWorkspaceChanged` keeps its push-only listener array

No unsubscribe API is added. Both subscribers — `QueriesView` and `StartPage` —
are constructed once by the shell and never replaced, so there is nothing to
unsubscribe; an API with no caller is the dead code the audit's Priority 3 is
already full of. The contract is written into the method's JSDoc
instead.[^no-unsubscribe]

---

## Public API

### `frontend/src/controller/panelHost.ts` (new)

Types only, plus one `Error` subclass — no library value import, so the module
loads under the node test harness.

```ts
/** Registry entry for one open dock panel. Moved verbatim from SqlAdminController.ts. */
export interface OpenPanel {
    ref: DbObjectRef;
    node: TreeNode | null;
    store?: AjaxStore;
    columns?: ColumnMeta[];
    detail?: string;
    refresh?: () => void;
}

/** A recently opened table, kept with its node so the start page can re-open it. */
export interface RecentTable {
    ref: DbObjectRef;
    node: TreeNode;
}

/** A role grants tab's full grant set, for the active-tab export. */
export interface RoleGrants {
    role: string;
    privileges: RolePrivilege[];
}

/** The identity of a work-area tab whose content is fetched behind a spinner. */
export interface AsyncPanelSpec {
    id: string;
    title: string;
    glyph: string;
    tooltip?: string;
    ref?: DbObjectRef;
    route?: PanelRoute;
}

/** A panel-load failure. Moved verbatim from SqlAdminController.ts. */
export class PanelLoadError extends Error {
    constructor(readonly reason: unknown, readonly ref?: DbObjectRef, readonly reported: boolean = false);
}

/** Show `ref`'s object context menu at the right-click's position. */
export type ShowObjectContextMenu = (ref: DbObjectRef, event: MouseEvent) => void;

/**
 * The shared app services every controller collaborator reaches through.
 * Implemented by SqlAdminController; this is the collaborator-facing seam, not
 * part of the app-facing controller surface.
 */
export interface PanelHost {
    readonly dock: Dock;
    readonly layout: LayoutStore;
    readonly connectionId: string;
    readonly database: string | undefined;
    /** The roles inspector a role open refreshes. */
    readonly rolesProperties: RolesPropertiesPanel;

    /** Write a status message, prefixed with the connected database. */
    status(message: string): void;
    /** Surface an error to the status bar and the notification history. */
    notifyError(error: unknown, ref?: DbObjectRef): void;
    /** The hover tooltip for a tab showing `ref`. */
    panelTooltip(ref: DbObjectRef): string;

    /** Register a tab whose content is fetched behind the library's spinner. */
    openAsyncPanel(spec: AsyncPanelSpec, build: () => Promise<Component>): void;
    /** Record the address-bar route for a tab opened without openAsyncPanel. */
    setPanelRoute(id: string, route: PanelRoute): void;
    /** Add or replace this panel's open-panel registry entry. */
    registerPanel(id: string, entry: OpenPanel): void;
    /** The live registry entry for `id`, or undefined when the tab is not open. */
    panelEntry(id: string): OpenPanel | undefined;
    /** Close every tab that can exist for `ref` (see panelIdsFor). */
    closeTabsFor(ref: DbObjectRef): void;
    /** Fetch a relation's columns, coalescing concurrent requests for the same object. */
    fetchColumns(ref: DbObjectRef): Promise<ColumnMeta[]>;
    /** Select the panel's navigator node and refresh the status bar to match. */
    syncToPanel(id: string): void;

    /** Record a query panel's latest run for the address-bar sync. */
    recordQueryRun(id: string, timestamp: number): void;
    /** Mirror a query panel's latest exportable result. */
    setActiveExport(id: string, active: ActiveExport | null): void;
    /** Track a grants tab's full grant set for the active-tab export. */
    setActiveRoleGrants(id: string, grants: RoleGrants): void;
}
```

### `frontend/src/controller/controllerText.ts` (new)

Every function is pure. `panelId` is the base every object-scoped id extends.

```ts
export function panelId(ref: DbObjectRef): string;
export function structurePanelId(ref: DbObjectRef): string;
export function definitionPanelId(ref: DbObjectRef): string;
export function sequenceInfoPanelId(ref: DbObjectRef): string;
export function indexInfoPanelId(ref: DbObjectRef): string;
export function typeInfoPanelId(ref: DbObjectRef): string;
export function functionDefinitionPanelId(ref: DbObjectRef): string;
export function relationDiagramPanelId(ref: DbObjectRef): string;
export function relationDependencyPanelId(ref: DbObjectRef): string;
export function relationInheritancePanelId(ref: DbObjectRef): string;
export function diagramPanelId(ref: DbObjectRef): string;
export function dependencyPanelId(ref: DbObjectRef): string;
export function inheritancePanelId(ref: DbObjectRef): string;
export function databaseDiagramPanelId(ref: DbObjectRef): string;
export function ddlPanelId(ref: DbObjectRef, slug: string): string;
export function notesPanelId(connectionId: string): string;
export function roleGrantsPanelId(connectionId: string, role: string): string;
export function roleGrantsDiagramPanelId(connectionId: string, role: string): string;
export function roleMembershipDiagramPanelId(connectionId: string, role: string): string;

/** Every panel id that can exist for `ref`, for closeTabsFor. */
export function panelIdsFor(ref: DbObjectRef): string[];

/** A tab's hover tooltip: the name, then Type/Schema/Database. */
export function panelTooltip(ref: DbObjectRef, typeLabel: string): string;

/** Shorten a free-text name to fit a status message, eliding the tail. */
export function elideName(name: string): string;

/** Prefer an AjaxError's parsed {detail}; fall back to a message or String(). */
export function errorMessage(error: unknown): string;

/** Extract a readable message from a backend error body, or null. */
export function detailOf(body: unknown): string | null;
```

The four id builders that take a `connectionId` read it from `this._connectionId`
today; `ddlPanelId` arrives from `ddl-forms-in-tab-editing`; `roleGrantsPanelId`
is extracted from the literal inlined in `openRoleGrants`.

### `frontend/src/controller/revealCoordinator.ts` (new)

No library value import — `matchesObject` and friends come from the DOM-free
`navigator/revealMatch.ts`, and `ExplorerTree`/`TreeNode` are type-only.

```ts
/** What a reveal does once its node is found. */
export interface RevealOptions {
    /** Also expand the revealed node (a schema's categories, a role section's leaves). */
    expand?: boolean;
    /**
     * Start a panel open alongside the reveal, handed the still-pending reveal
     * so a slow tree search never delays the tab. Called synchronously.
     */
    open?: (revealed: Promise<TreeNode | undefined>) => void;
}

export class RevealCoordinator {
    constructor(connectionId: string, database: string | undefined);

    /** Register the navigator tree (NavigatorTree calls this on construction). */
    setNavigator(tree: ExplorerTree): void;
    /** Register the roles tree (RolesTree calls this on construction). */
    setRolesTree(tree: ExplorerTree): void;
    /** Register the shell's Database-view selector. */
    setShowDatabaseView(select: () => void): void;
    /** Register the shell's Roles-view selector. */
    setShowRolesView(select: () => void): void;

    /** Refresh the navigator's top level (every DDL flow's success path). */
    refreshNavigator(): void;
    /** Select `node` in the navigator (the focus-driven sidebar sync). */
    selectNavigatorNode(node: TreeNode): void;

    /** Bring the Database view forward, reveal the first matching node, select it. */
    revealInNavigator(match: NodeMatch, options?: RevealOptions): void;
    /** The roles-side twin of revealInNavigator. */
    revealInRoles(match: NodeMatch, options?: RevealOptions): void;
    /**
     * Bring the Database view forward and reveal the first matching node,
     * awaitable and without selecting it — for a caller that must read the node
     * before deciding what to open (RoleActions.openGrantedTable).
     */
    findInNavigator(match: NodeMatch): Promise<TreeNode | undefined>;

    /** Bring the Database view forward and select `ref`'s navigator node. */
    selectObject(ref: DbObjectRef): void;
    /** Bring the Roles view forward and select `name`'s roles-tree node. */
    selectRole(name: string): void;
    /** Switch to the Database view and expand `schema`'s node. */
    revealSchema(schema: string): void;
    /** Switch to the Roles view and expand the named section's group node. */
    revealRoleSection(section: string): void;
}
```

### `frontend/src/controller/objectPanels.ts` (new)

```ts
export class ObjectPanels {
    constructor(host: PanelHost, reveal: RevealCoordinator, ddl: DdlLaunchers, workspace: QueryWorkspace);

    openTable(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>, view?: TableViewOptions): Promise<void>;
    openStructure(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void>;
    openDefinition(ref: DbObjectRef, node?: TreeNode): Promise<void>;
    openSequence(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void>;
    openIndex(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>): Promise<void>;
    openType(ref: DbObjectRef, node?: TreeNode): Promise<void>;
    openFunctionDefinition(ref: DbObjectRef, node?: TreeNode): Promise<void>;

    /** Reveal a foreign key's referenced table and open its data tab. */
    openReferencedTable(ref: DbObjectRef): void;
    /** Reveal a table and open its Structure tab (an index's or sequence's owner link). */
    openReferencedStructure(ref: DbObjectRef): void;
}
```

Private: `openReferencedSequence`, `fetchDefinitionAndColumns`, `refreshPanel`,
`reportSync`, `structureActionsFor`, `importIntoTable`.

### `frontend/src/controller/diagramPanels.ts` (new)

```ts
export class DiagramPanels {
    constructor(host: PanelHost, panels: ObjectPanels, showContextMenu: ShowObjectContextMenu);

    openSchemaDiagram(ref: DbObjectRef, node?: TreeNode): Promise<void>;
    openDatabaseDiagram(ref: DbObjectRef, node?: TreeNode): Promise<void>;
    openRelationDiagram(ref: DbObjectRef, node?: TreeNode, depth?: string): Promise<void>;
    openSchemaDependencyGraph(ref: DbObjectRef, node?: TreeNode): Promise<void>;
    openSchemaInheritanceGraph(ref: DbObjectRef, node?: TreeNode): Promise<void>;
    openRelationDependencyGraph(ref: DbObjectRef, node?: TreeNode, depth?: string): Promise<void>;
    openRelationInheritanceGraph(ref: DbObjectRef, node?: TreeNode, depth?: string): Promise<void>;
}
```

Private, all arriving from `diagram-panel-family-convergence`: `RelationGraphKind`,
`graphKind`, `relationGraphHandlers`, `openSchemaRelationGraph`,
`openRootedRelationGraph`, plus `buildSchemaGraphData`, `buildDatabaseGraphData`,
`fetchDependencyGraph`, `fetchInheritanceGraph` and the two ELK layout constants.

### `frontend/src/controller/ddlLaunchers.ts` (new)

```ts
export class DdlLaunchers {
    constructor(host: PanelHost, reveal: RevealCoordinator);

    createTable(ref: DbObjectRef): void;
    createView(ref: DbObjectRef): Promise<void>;
    createMaterializedView(ref: DbObjectRef): Promise<void>;
    createSchema(ref: DbObjectRef): void;
    createSequence(ref: DbObjectRef): void;
    createFunction(ref: DbObjectRef): void;
    createType(ref: DbObjectRef, category: "enum" | "composite"): void;
    editType(ref: DbObjectRef): Promise<void>;

    renameTable(ref: DbObjectRef, node?: TreeNode): void;
    renameSchema(ref: DbObjectRef): void;
    refreshMaterializedView(ref: DbObjectRef): void;

    dropTable(ref: DbObjectRef, node?: TreeNode): void;
    dropRelation(ref: DbObjectRef): void;
    dropSchema(ref: DbObjectRef): void;
    dropSequence(ref: DbObjectRef): void;
    dropFunction(ref: DbObjectRef): void;
    dropType(ref: DbObjectRef): void;

    /** The Structure tab's Constraints/Indexes section toolbars (ObjectPanels calls these). */
    addConstraint(ref: DbObjectRef, kind: ConstraintKind): Promise<void>;
    dropConstraint(ref: DbObjectRef, constraintName: string): void;
    createIndex(ref: DbObjectRef): void;
    dropIndex(ref: DbObjectRef, indexName: string): void;

    /** The query panel's index-advisor "Create index…" (QueryWorkspace calls this). */
    createSuggestedIndex(schema: string, table: string, columns: string[]): Promise<void>;
}
```

Private: `openDdlPanel`, `ddlDefaults`, `fetchSchemaNames`, `createRelationDraft`
(all from `ddl-forms-in-tab-editing`), `structureColumns`, `refreshStructure`.

### `frontend/src/controller/queryWorkspace.ts` (new)

```ts
/** A focusable section of the Queries view — the Saved or the Recent list. */
export type QueriesSection = "saved" | "recent";

export class QueryWorkspace {
    constructor(host: PanelHost, ddl: DdlLaunchers, username: string | undefined);

    openQuery(seedSql?: string, run?: boolean, title?: string, explain?: "plain" | "analyze"): void;
    openQueryFor(ref: DbObjectRef): void;
    executeFunction(ref: DbObjectRef): void;
    openSavedQuery(name: string, run?: boolean): void;
    promptAndSaveQuery(sql: string): Promise<void>;
    removeSavedQuery(name: string): Promise<void>;
    openDocumentation(): void;

    historyList(): HistoryEntry[];
    savedList(): SavedQuery[];
    recentTables(): DbObjectRef[];
    /** The remembered entry whose panel id matches `ref`, for the coordinator's reopenTable. */
    recentEntry(ref: DbObjectRef): RecentTable | undefined;
    /** Remember a just-opened relation (ObjectPanels calls this). */
    rememberTable(ref: DbObjectRef, node: TreeNode): void;

    showQueriesView(section?: QueriesSection): void;
    setShowQueriesView(select: () => void): void;
    setQueriesSectionFocus(focus: (section: QueriesSection) => void): void;
    onWorkspaceChanged(listener: () => void): void;
}
```

Private: `saveQuery`, `recordRun`, `notifyWorkspaceChanged`. Owns
`QueryHistoryStore`, `SavedQueryStore`, `NotesStore`, `_recentTables` and the
scratch-panel counter.

### `frontend/src/controller/roleActions.ts` (new)

```ts
export class RoleActions {
    constructor(host: PanelHost, reveal: RevealCoordinator, panels: ObjectPanels,
                showContextMenu: ShowObjectContextMenu);

    loadRoles(): Promise<RoleSummary[]>;
    showRole(name: string): void;
    showRoleProperties(name: string): Promise<void>;
    openRoleGrantsDiagram(name: string): Promise<void>;
    openRoleMembershipDiagram(name: string, depth?: string): Promise<void>;
    exportRole(role: string, format: "csv" | "json"): Promise<void>;
}
```

Private: `fetchRoleDetail`, `openRoleGrants`, `openGrantedTable`.

### `SqlAdminController` after the split

```ts
export class SqlAdminController implements PanelHost {
    // Library-owned surfaces the shell mounts (unchanged).
    readonly dock: Dock;
    readonly statusBar: StatusBar;
    readonly properties: PropertiesPanel;
    readonly rolesProperties: RolesPropertiesPanel;
    readonly layout: LayoutStore;

    // The six collaborators. Consumers call through these.
    readonly reveal: RevealCoordinator;
    readonly ddl: DdlLaunchers;
    readonly workspace: QueryWorkspace;
    readonly panels: ObjectPanels;
    readonly diagrams: DiagramPanels;
    readonly roles: RoleActions;

    constructor(connectionId?: string, username?: string, database?: string);

    get connectionId(): string;
    get database(): string | undefined;

    // App-facing surface.
    showProperties(ref: DbObjectRef): Promise<void>;
    refreshActive(): void;
    exportActive(format: "csv" | "json"): void;
    activeExportKind(): "plan" | "tabular";
    canExportActive(): boolean;
    exportTable(ref: DbObjectRef, format: "csv" | "json"): void;
    reopenTable(ref: DbObjectRef): void;
    setStartToggle(toggle: (visible: boolean) => void): void;
    setSyncAddressBar(sync: (path: string, query?: Record<string, string>) => void): void;

    // PanelHost implementation — the collaborator seam, not the app surface.
    status(message: string): void;
    notifyError(error: unknown, ref?: DbObjectRef): void;
    panelTooltip(ref: DbObjectRef): string;
    openAsyncPanel(spec: AsyncPanelSpec, build: () => Promise<Component>): void;
    setPanelRoute(id: string, route: PanelRoute): void;
    registerPanel(id: string, entry: OpenPanel): void;
    panelEntry(id: string): OpenPanel | undefined;
    closeTabsFor(ref: DbObjectRef): void;
    fetchColumns(ref: DbObjectRef): Promise<ColumnMeta[]>;
    syncToPanel(id: string): void;
    recordQueryRun(id: string, timestamp: number): void;
    setActiveExport(id: string, active: ActiveExport | null): void;
    setActiveRoleGrants(id: string, grants: RoleGrants): void;
}
```

Still private: `_openPanels`, `_panelRoutes`, `_queryPanelRuns`,
`_activeQueryResult`, `_activeRoleGrants`, `_activePanelId`, `_columnsInFlight`,
`_propsSeq`, `_objectMenu`, `syncAddressBarFor`, `updateStatusFor`,
`disposePanel`, `diagramContextMenu`, `_statusScope`.

### `frontend/src/navigator/objectMenu.ts` (changed)

```ts
export type ObjectPanelMenuActions = Pick<ObjectPanels,
    | "openTable" | "openStructure" | "openDefinition"
    | "openSequence" | "openIndex" | "openType"
    | "openFunctionDefinition" | "openReferencedStructure">;

export type DiagramMenuActions = Pick<DiagramPanels,
    | "openSchemaDiagram" | "openSchemaDependencyGraph" | "openSchemaInheritanceGraph"
    | "openRelationDiagram" | "openRelationDependencyGraph" | "openRelationInheritanceGraph">;

export type DdlMenuActions = Pick<DdlLaunchers,
    | "createTable" | "createView" | "createMaterializedView" | "createSequence"
    | "createType" | "createFunction"
    | "renameTable" | "renameSchema"
    | "dropTable" | "dropRelation" | "refreshMaterializedView"
    | "dropSchema" | "dropSequence" | "dropFunction" | "editType" | "dropType">;

export type WorkspaceMenuActions = Pick<QueryWorkspace, "openQueryFor" | "executeFunction">;

/**
 * The controller slices the object context menu invokes. SqlAdminController
 * satisfies this structurally through its own collaborator fields, so both
 * callers still pass the controller itself.
 */
export interface ObjectMenuActions {
    readonly panels: ObjectPanelMenuActions;
    readonly diagrams: DiagramMenuActions;
    readonly ddl: DdlMenuActions;
    readonly workspace: WorkspaceMenuActions;
    /** Streams a relation's full contents server-side (the coordinator's own route). */
    exportTable(ref: DbObjectRef, format: "csv" | "json"): void;
}
```

8 + 6 + 16 + 2 + 1 = the same 33 members, in four named groups.

---

## Internal Structure

### Panel ids — the naming scheme in three real instances

Every object-scoped id extends `panelId(ref)`; the schema-, database- and
role-scoped ids build their own key. The `::` suffix is what keeps a relation's
six tabs apart.

| Builder | `ref` | Result |
|---|---|---|
| `panelId` | `{connectionId:"default", database:"sqladmin", schema:"public", name:"orders", kind:"table"}` | `default/sqladmin/public.orders` |
| `structurePanelId` | same | `default/sqladmin/public.orders::structure` |
| `relationDependencyPanelId` | same | `default/sqladmin/public.orders::dependencies` |
| `functionDefinitionPanelId` | `{…, name:"total_orders", signature:"integer", kind:"function"}` | `default/sqladmin/public.total_orders(integer)::function` |
| `diagramPanelId` | `{…, schema:"public", kind:"schema"}` | `default/sqladmin/public::diagram` |
| `databaseDiagramPanelId` | `{…, database:"sqladmin", kind:"database"}` | `default/sqladmin::db-diagram` |
| `roleGrantsPanelId("default", "alice")` | — | `grants/default/alice` |
| `roleMembershipDiagramPanelId("default", "alice")` | — | `roles/default/alice::membership` |
| `notesPanelId("default")` | — | `notes/default` |

### `panelIdsFor`

```ts
export function panelIdsFor(ref: DbObjectRef): string[] {
    if (ref.kind === "database") {
        return [databaseDiagramPanelId(ref)];
    }

    if (ref.kind === "schema") {
        return [diagramPanelId(ref), dependencyPanelId(ref), inheritancePanelId(ref)];
    }

    // Every object-scoped tab, whether or not this kind can open all of them:
    // Dock.removePanel on an id with no open tab is already relied on as a no-op
    // (dropTable removes a structure tab that may never have been opened).
    return [
        panelId(ref), structurePanelId(ref), definitionPanelId(ref),
        sequenceInfoPanelId(ref), indexInfoPanelId(ref), typeInfoPanelId(ref),
        functionDefinitionPanelId(ref),
        relationDiagramPanelId(ref), relationDependencyPanelId(ref), relationInheritancePanelId(ref),
    ];
}
```

| `ref.kind` | ids returned |
|---|---|
| `"table"` / `"view"` / `"materializedView"` / `"sequence"` / `"index"` / `"type"` / `"function"` | the ten object-scoped ids |
| `"schema"` | `…/public::diagram`, `…/public::dependencies`, `…/public::inheritance` |
| `"database"` | `default/sqladmin::db-diagram` |

`closeTabsFor` on the coordinator is then one line:

```ts
closeTabsFor(ref: DbObjectRef): void {
    panelIdsFor(ref).forEach(id => this.dock.removePanel(id));
}
```

### `RevealCoordinator`'s shared body

```ts
/** The per-tree handles a reveal needs: which view to bring forward, and which tree to search. */
private side(side: "navigator" | "roles"): { show: () => void; tree: () => ExplorerTree | null } {
    return side === "navigator"
        ? { show: () => this._showDatabaseView?.(), tree: () => this._navigator }
        : { show: () => this._showRolesView?.(),    tree: () => this._rolesTree };
}

/**
 * Bring the tree's view forward and reveal the first node `match` accepts, once
 * that tree has finished loading. The view switch comes first because revealing
 * means searching and scrolling, which is pointless while the tree's deck page is
 * hidden; the whenLoaded wait is what makes a reveal issued at boot search a
 * populated tree rather than one still filling.
 */
private async find(side: "navigator" | "roles", match: NodeMatch): Promise<TreeNode | undefined> {
    const handles = this.side(side);

    handles.show();
    await handles.tree()?.whenLoaded();

    return (await handles.tree()?.revealByPredicate(match)) ?? undefined;
}

private revealAndSelect(side: "navigator" | "roles", match: NodeMatch, options?: RevealOptions): void {
    const handles  = this.side(side);
    const revealed = this.find(side, match);

    // Started before the reveal is awaited, so the tab appears at once and the
    // selection lands whenever the tree search resolves.
    options?.open?.(revealed);

    void revealed.then(node => {
        if (!node) {
            return;
        }

        handles.tree()?.selectNode(node);

        if (options?.expand) {
            handles.tree()?.expandNode(node);
        }
    });
}
```

The seven call sites afterwards:

| Method | Body |
|---|---|
| `revealInNavigator(m, o)` | `this.revealAndSelect("navigator", m, o)` |
| `revealInRoles(m, o)` | `this.revealAndSelect("roles", m, o)` |
| `selectObject(ref)` | `if (!ref.schema) { this._showDatabaseView?.(); return; } this.revealInNavigator(matchesObject(ref))` |
| `selectRole(name)` | `this.revealInRoles(matchesRole(name))` |
| `revealSchema(schema)` | `this.revealInNavigator(matchesObject(schemaRef), { expand: true })` |
| `revealRoleSection(section)` | `this.revealInRoles(matchesRoleSection(section), { expand: true })` |
| `ObjectPanels.openReferencedTable(ref)` | `this.reveal.revealInNavigator(matchesRelationName(ref), { open: r => void this.openTable(ref, r) })` |
| `ObjectPanels.openReferencedStructure(ref)` | `this.reveal.revealInNavigator(matchesObject(ref), { open: r => void this.openStructure(ref, r) })` |
| `ObjectPanels.openReferencedSequence(ref)` | `this.reveal.revealInNavigator(matchesObject(ref), { open: r => void this.openSequence(ref, r) })` |

`findInNavigator(match)` is the public form of `find("navigator", match)`.
`RoleActions.openGrantedTable` is the one caller that cannot use
`revealInNavigator`: its ref comes *out of* the revealed node (a `RolePrivilege`
carries no database), and it status-bars a "not found in navigator" message when
nothing matches, so it must await the node before opening anything. Its body keeps
today's shape with `this.reveal.findInNavigator(...)` in place of
`this.revealNavigatorNode(...)` and `this.reveal.selectNavigatorNode(node)` in
place of `this._navigator?.selectNode(node)`.

`selectObject`'s schema-less guard stays: a database-wide ref names no navigator
node, and `revealByPredicate` walks depth-first, so a search would lazily fetch
every schema's objects only to find nothing.

### The coordinator's constructor order

```ts
constructor(connectionId: string = "default", username?: string, database?: string) {
    this._connectionId = connectionId;
    this._database     = database;

    // 1. Everything PanelHost names must be assigned before any collaborator is built.
    this.dock            = Dock({ listeners: { emptychange: e => this._startToggle?.(e.empty) } });
    this.statusBar       = new StatusBar();
    this.properties      = new PropertiesPanel();
    this.rolesProperties = new RolesPropertiesPanel();
    this.layout          = new LayoutStore(username || "default", window.localStorage);

    // 2. The collaborators, in dependency order (see Architecture Decisions).
    const contextMenu: ShowObjectContextMenu = (ref, event) => this.diagramContextMenu(ref, event);

    this.reveal    = new RevealCoordinator(connectionId, database);
    this.ddl       = new DdlLaunchers(this, this.reveal);
    this.workspace = new QueryWorkspace(this, this.ddl, username);
    this.panels    = new ObjectPanels(this, this.reveal, this.ddl, this.workspace);
    this.diagrams  = new DiagramPanels(this, this.panels, contextMenu);
    this.roles     = new RoleActions(this, this.reveal, this.panels, contextMenu);

    // 3. Dock event wiring, status bar identity — unchanged from today.
}
```

**No collaborator constructor may call a `PanelHost` method.** `this` is handed
over before the constructor finishes; every field the interface names is assigned
in block 1, but nothing else is. Each collaborator constructor does field
assignment only.

### `reopenTable` on the coordinator

```ts
reopenTable(ref: DbObjectRef): void {
    const entry = this.workspace.recentEntry(ref);

    if (entry) {
        void this.panels.openTable(entry.ref, entry.node);
    }
}
```

---

## Ordered Implementation Steps

Every step ends with `npm --prefix frontend run typecheck` clean, so a step that
moves members also moves the consumers that call them.

### Phase 1 — The pure module

1. **Create `frontend/src/controller/controllerText.ts`** with every function
   listed in `## Public API`, bodies moved verbatim from `SqlAdminController.ts`'s
   corresponding private methods. The four connection-scoped builders take
   `connectionId` as their first parameter instead of reading `this._connectionId`;
   `panelTooltip` takes `typeLabel` as its second parameter instead of calling
   `relationTypeLabel`; `roleGrantsPanelId` is new, carrying the
   `` `grants/${connectionId}/${role}` `` literal currently inlined in
   `openRoleGrants`. Add `panelIdsFor` from `## Internal Structure`. Module header:
   the controller's pure string derivations — panel ids, tab tooltips, status-name
   elision, backend-error extraction — kept free of library imports so the node
   vitest can load it, mirroring `startPageWelcome.ts`'s own header.

2. **Create `frontend/tests/controller/controllerText.test.ts`** covering
   `## Expected Behaviour` cases 1-14.
   Check: `npx vitest run tests/controller/controllerText.test.ts` from `frontend/`.

3. **`frontend/src/SqlAdminController.ts` — delegate to it.** Delete the eighteen
   private id-builder methods (seventeen written today, plus `ddlPanelId` from
   `ddl-forms-in-tab-editing`), `elideName`, `errorMessage`, `detailOf`,
   `panelTooltip` and `MAX_STATUS_NAME_CHARS`, and import the free functions
   instead. `notesPanelId()`, `roleGrantsDiagramPanelId(role)` and
   `roleMembershipDiagramPanelId(role)` call sites gain `this._connectionId` as
   their first argument; `openRoleGrants`'s inline id literal becomes
   `roleGrantsPanelId(this._connectionId, role)`. Keep one method wrapper,
   `panelTooltip(ref)`, whose body is
   `return buildPanelTooltip(ref, relationTypeLabel(ref.kind));` — import the free
   function as `buildPanelTooltip` so the method body cannot be misread as
   recursive. The `relationTypeLabel` import at the top of the file stays exactly
   where it is.
   Check: `grep -n 'private .*PanelId(' frontend/src/SqlAdminController.ts` — zero matches.

### Phase 2 — The seam

4. **Create `frontend/src/controller/panelHost.ts`** with `OpenPanel`,
   `RecentTable`, `RoleGrants`, `AsyncPanelSpec`, `PanelLoadError`,
   `ShowObjectContextMenu` and `PanelHost` from `## Public API`. `OpenPanel`,
   `RecentTable` and `PanelLoadError` move out of `SqlAdminController.ts`
   verbatim, keeping their comments. Every library import is `import type` except
   nothing — `PanelLoadError` extends the global `Error`. Module header: the
   collaborator-facing seam; why it holds no library value import; that
   `SqlAdminController` is its only implementor.

5. **`frontend/src/SqlAdminController.ts` — implement it.** Add
   `implements PanelHost`, import the moved types, and add the members the
   interface names that do not exist yet:
   - `status(message)` → `this.statusBar.setMessage(\`${this._statusScope} · ${message}\`)`
   - `registerPanel(id, entry)` → `this._openPanels.set(id, entry)`
   - `panelEntry(id)` → `this._openPanels.get(id)`
   - `setPanelRoute(id, route)` → `this._panelRoutes.set(id, route)`
   - `closeTabsFor(ref)` → the body in `## Internal Structure`
   - `recordQueryRun(id, ts)` → `this._queryPanelRuns.set(id, ts)`, followed by
     `if (id === this._activePanelId) { this.syncAddressBarFor(id); }` — the
     re-sync moved out of `recordRun`[^record-run]
   - `setActiveExport(id, active)` → `this._activeQueryResult.set(id, active)`
   - `setActiveRoleGrants(id, grants)` → `this._activeRoleGrants.set(id, grants)`

   Widen `openAsyncPanel`, `fetchColumns` and `syncToPanel` from `private` to
   public and give `openAsyncPanel` the named `AsyncPanelSpec` parameter type.
   Then replace every in-file `` `${this._statusScope} · …` `` status write with
   `this.status(…)`, and every `this._openPanels.set/get` outside the four host
   methods with `registerPanel`/`panelEntry`.
   Check: `npm --prefix frontend run typecheck`.

### Phase 3 — The collaborators

Each step in this phase: create the module, move the members into it verbatim
(rewriting `this._navigator`/`this.statusBar`/`this._openPanels` into the host or
collaborator call the member now goes through), delete them from the controller,
add the controller field, and update every consumer named in the step.

6. **Create `frontend/src/controller/revealCoordinator.ts`** per `## Public API`
   and `## Internal Structure`, absorbing `setNavigator`, `setRolesTree`,
   `setShowDatabaseView`, `setShowRolesView`, `showDatabaseView`, `showRolesView`,
   `revealNavigatorNode`, `revealRoleNode`, `revealObject`, `selectObject`,
   `selectRole`, `revealSchema` and `revealRoleSection`. Add `refreshNavigator()`,
   `selectNavigatorNode(node)` and `findInNavigator(match)`. Add
   `readonly reveal: RevealCoordinator` to the controller and construct it first.

   The controller keeps no `_navigator`/`_rolesTree` field afterwards, so every
   remaining in-file use is rewritten: `syncToPanel`'s
   `this._navigator?.selectNode(panel.node)` becomes
   `this.reveal.selectNavigatorNode(panel.node)`; every
   `this._navigator?.refresh?.()` — the DDL launchers' success paths plus
   `openDefinition`'s and `openFunctionDefinition`'s save paths — becomes
   `this.reveal.refreshNavigator()`; and `openReferencedTable`,
   `openReferencedSequence`, `openReferencedStructure` and `openGrantedTable`,
   still on the controller at this point, take the bodies given in
   `## Internal Structure`'s call-site table.

   Consumers: `NavigatorTree.ts` (`controller.setNavigator(this)` →
   `controller.reveal.setNavigator(this)`); `RolesTree.ts` (`setRolesTree`);
   `SqlAdminShell.ts` (`controller.setShowDatabaseView`/`setShowRolesView` →
   `controller.reveal.…`); `appRouter.ts` (`selectObject`, `selectRole`,
   `revealSchema`, `revealRoleSection` → `controller.reveal.…`, 12 call sites).

7. **Create `frontend/tests/controller/revealCoordinator.test.ts`** covering
   `## Expected Behaviour` cases 15-23, with a stub tree cast
   `as unknown as ExplorerTree` — the technique
   [`tests/navigator/objectMenu.test.ts:22-36`](frontend/tests/navigator/objectMenu.test.ts#L22)
   already uses for `ObjectMenuActions`.
   Check: `npx vitest run tests/controller/revealCoordinator.test.ts`.

8. **Create `frontend/src/controller/ddlLaunchers.ts`** per `## Public API`,
   absorbing all 22 launchers plus `openDdlPanel`, `ddlDefaults`,
   `fetchSchemaNames`, `createRelationDraft`, `structureColumns` and
   `refreshStructure`. `this._navigator?.refresh?.()` becomes
   `this.reveal.refreshNavigator()`; `this.dock.removePanel(panelId(ref))` pairs in
   `dropTable`, `renameTable`, `dropRelation` and `dropFunction` become
   `this.host.closeTabsFor(ref)`. Add `readonly ddl: DdlLaunchers` to the
   controller.

   Consumers: `DatabaseExplorerView.ts` (`controller.createSchema` →
   `controller.ddl.createSchema`); `objectMenu.ts` — replace the sixteen DDL names
   in the flat `Pick` with `readonly ddl: DdlMenuActions` and prefix their sixteen
   item bodies with `actions.ddl.`; `tests/navigator/objectMenu.test.ts` — group
   the sixteen stubs under a `ddl: { … }` key.

9. **Create `frontend/src/controller/queryWorkspace.ts`** per `## Public API`,
   absorbing `openQuery`, `openQueryFor`, `executeFunction`, `openSavedQuery`,
   `saveQuery`, `promptAndSaveQuery`, `removeSavedQuery`, `historyList`,
   `savedList`, `recentTables`, `rememberTable`, `recordRun`,
   `notifyWorkspaceChanged`, `onWorkspaceChanged`, `showQueriesView`,
   `setShowQueriesView`, `setQueriesSectionFocus`, `openDocumentation`, the
   `QueriesSection` type, `MAX_RECENT_TABLES`, and the three localStorage stores
   (`QueryHistoryStore`, `SavedQueryStore`, `NotesStore`) with their
   `username || "default"` scoping comment. Add `recentEntry(ref)` — the lookup
   half of today's `reopenTable`. `recordRun` calls `host.recordQueryRun(id, ts)`
   instead of writing `_queryPanelRuns`, and drops the
   `if (id === this._activePanelId)` re-sync — the host does that.[^record-run]
   Add `readonly workspace: QueryWorkspace` to the controller, and add the
   coordinator's own `reopenTable(ref)` from `## Internal Structure`.

   Consumers: `SqlAdminShell.ts` (`openQuery`, `showQueriesView`,
   `openDocumentation`, `setShowQueriesView` → `controller.workspace.…`);
   `appRouter.ts` (`openDocumentation`, `historyList`, `openQuery`);
   `QueriesView.ts` (8 call sites); `StartPage.ts` (`onWorkspaceChanged`,
   `openQuery`, `recentTables`, `savedList`, `openSavedQuery`, and
   `shouldShowWelcome(controller)` → `shouldShowWelcome(controller.workspace)` —
   `reopenTable` stays `controller.reopenTable`); `startPageWelcome.ts` (retype the
   parameter to `Pick<QueryWorkspace, "recentTables" | "savedList">` and repoint the
   import — its test needs no change, it already passes a structural stub);
   `objectMenu.ts` (`openQueryFor`, `executeFunction` → `readonly workspace:
   WorkspaceMenuActions`) and its test.

10. **Create `frontend/src/controller/objectPanels.ts`** per `## Public API`,
    absorbing `openTable`, `openDefinition`, `fetchDefinitionAndColumns`,
    `refreshPanel`, `openSequence`, `openIndex`, `openType`, `openStructure`,
    `structureActionsFor`, `openFunctionDefinition`, `importIntoTable`,
    `reportSync`, `openReferencedTable`, `openReferencedSequence` and
    `openReferencedStructure`. The three `openReferenced*` bodies become the
    `revealInNavigator` calls from `## Internal Structure`'s table.
    `this.rememberTable(...)` becomes `this.workspace.rememberTable(...)`;
    `openTable`'s view/matview branch calls `this.workspace.openQuery(...)`;
    `structureActionsFor` dispatches to `this.ddl.…`. Add
    `readonly panels: ObjectPanels`.

    Consumers: `NavigatorTree.ts` (`openSequence`, `openIndex`, `openType`,
    `openTable` → `this.controller.panels.…`; `executeFunction` →
    `this.controller.workspace.executeFunction`); `appRouter.ts` (7 call sites);
    `objectMenu.ts` (eight names → `readonly panels: ObjectPanelMenuActions`) and
    its test.

11. **Create `frontend/src/controller/diagramPanels.ts`** per `## Public API`,
    absorbing the seven diagram openers, the four graph-fetch helpers, the
    `RelationGraphKind` machinery from `diagram-panel-family-convergence`, and the
    `DEPENDENCY_LAYOUT`/`INHERITANCE_LAYOUT` constants. Every
    `this.openReferencedTable(...)` becomes `this.panels.openReferencedTable(...)`
    and every `this.diagramContextMenu(...)` becomes
    `this.showContextMenu(...)`. Add `readonly diagrams: DiagramPanels`. Leave the
    controller's `Glyph.register(...)` call and its comment where they are — see
    `## Potential Challenges`.

    Consumers: `DatabaseExplorerView.ts` (`openDatabaseDiagram`); `appRouter.ts`
    (6 call sites); `objectMenu.ts` (six names → `readonly diagrams:
    DiagramMenuActions`) and its test.

12. **Create `frontend/src/controller/roleActions.ts`** per `## Public API`,
    absorbing `loadRoles`, `showRole`, `showRoleProperties`, `fetchRoleDetail`,
    `openRoleGrants`, `openRoleMembershipDiagram`, `openRoleGrantsDiagram`,
    `openGrantedTable`, `exportRole`, the `_roleSeq` guard and the `ROLE_GLYPH`
    constant. `openGrantedTable` calls `this.reveal.findInNavigator(...)`,
    `this.panels.openTable(...)` and `this.reveal.selectNavigatorNode(...)`;
    `openRoleGrants` calls `host.setActiveRoleGrants(...)`. `exportRole`'s
    no-grants message goes through `host.status(...)`, so it gains the
    connected-database prefix every other status message carries. Add
    `readonly roles: RoleActions`.

    Consumers: `RolesTree.ts` (6 call sites → `this.controller.roles.…`);
    `appRouter.ts` (3 call sites).

13. **Checkpoint.** `npm --prefix frontend run typecheck && npm --prefix frontend test`
    — clean and green. Then `grep -rn 'SqlAdminController' frontend/src/controller/`
    and `grep -rn 'Pick<SqlAdminController' frontend/src/` — both zero matches.

### Phase 4 — In-file cleanups

14. **Narrow the eight externally-unreachable methods** to the visibility their
    new owner allows, per the table in `## Expected Behaviour` case 24. Three
    become `private`; five stay public on a collaborator but leave the app-wide
    controller surface.
    Check: `grep -n 'private openReferencedSequence\|private openGrantedTable\|private saveQuery' frontend/src/controller/` — three matches.

15. **Move the orphaned JSDoc.** In `SqlAdminController.ts` the block beginning
    "Show the selected object's metadata in the Properties inspector" sits above
    `fetchColumns`, which has a second JSDoc of its own; `showProperties` below has
    none. Move that block down so it sits immediately above `showProperties`.
    Check: the two `/** … */` blocks around `fetchColumns` become one.

16. **Document `onWorkspaceChanged`'s contract.** In `queryWorkspace.ts`, extend
    the method's JSDoc: subscribers are never removed, so a listener must outlive
    the workspace; both current subscribers (`QueriesView`, `StartPage`) are
    constructed once by the shell and never replaced. Do not add an unsubscribe API.

17. **Rewrite `SqlAdminController.ts`'s module header.** It currently opens "The
    app mediator. Owns the Dock, the StatusBar, the current connection, and the
    open-panel registry (deduped by panel id)." Keep that sentence and the
    "Components stay dumb: they emit, the controller decides" rule, and add: each
    area of work — panels, diagrams, DDL, reveal, workspace, roles — lives in its
    own module under `controller/` and is reached through the matching public
    field; collaborators reach back through `PanelHost` alone (`controller/panelHost.ts`).

### Phase 5 — Documentation and dead code

18. **`frontend/src/shell/SqlAdminShell.ts` — two stale comments.** In
    `buildCenterDeck`'s JSDoc, replace the sentence "The Dock exposes no
    emptyContent hook or 'became empty' event (see StartPage / the plan's Dock
    investigation), so the controller tracks an open-panel count and drives this
    deck through the injected toggle" with one saying the Dock emits an
    `emptychange` event which the controller subscribes to in its constructor,
    driving this deck through the injected toggle. Keep the closing clause
    "mirroring how the ActivityBar takes a SidebarSizer". In `buildSidebar`'s
    JSDoc, replace "Phase 1 ships one view — the Database explorer (navigator +
    properties accordion) — which is also the documented Phase-2 seam (one more
    rail button + one more deck page adds a view)" with a sentence naming the
    three shipped views (Database, Roles, Queries) and keeping the "one more rail
    button + one more deck page" seam note.
    Check: `grep -rn 'no emptyContent hook\|Phase 1 ships' frontend/src/` — zero matches.

19. **`frontend/src/shell/ActivityBar.ts:3-4` — the same stale claim.** Replace
    "Phase 1 ships a single \"Database\" button; adding a view is one more button +
    one more Card page (the Phase-2 seam)." with a sentence naming the three
    shipped views and keeping the seam note. Comment only; no code changes.

20. **`frontend/COMPONENT_CONVENTIONS.md` section (b) — fix the worked example.**
    The snippet attributes a pre-`super()` `const rail` local to `ActivityBar`;
    `ActivityBar`'s real constructor calls `super({ layoutManager: … })` as its
    first statement and builds `card`/`deck`/`rail` afterwards. The code is
    correct and the example is not.[^which-side] Replace the snippet with
    `ActivityBar`'s actual opening lines, and add one sentence before it: a child
    widget must be a pre-`super()` local **only when `super()`'s own options bag
    reads it** — cite [`LoginForm.ts:27-51`](frontend/src/shell/LoginForm.ts#L27)
    and `SqlAdminShell`'s constructor as the cases where it does, and `ActivityBar`
    as the case where `super()` takes only a layout manager so the children are
    built after. Leave the three numbered rules, the `declare` paragraph and the
    `LoginForm` sentence as they are.

21. **`frontend/src/shell/shortcutRegistry.ts` — delete the dead
    `ShortcutScope`.** Remove the `ShortcutScope` type, the `scope` field on
    `ShortcutEntry` with its doc line, and the `scope:` key from all fourteen
    `SHORTCUTS` rows. Drop "scope" from the module header's list of display
    metadata.
    Check: `grep -rn 'ShortcutScope\|scope' frontend/src/shell/shortcutRegistry.ts frontend/tests/shell/shortcutRegistry.test.ts` — zero matches.

22. **Run `## Verification` end to end.**

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/controller/controllerText.ts` |
| Create | `frontend/src/controller/panelHost.ts` |
| Create | `frontend/src/controller/revealCoordinator.ts` |
| Create | `frontend/src/controller/ddlLaunchers.ts` |
| Create | `frontend/src/controller/queryWorkspace.ts` |
| Create | `frontend/src/controller/objectPanels.ts` |
| Create | `frontend/src/controller/diagramPanels.ts` |
| Create | `frontend/src/controller/roleActions.ts` |
| Create | `frontend/tests/controller/controllerText.test.ts` |
| Create | `frontend/tests/controller/revealCoordinator.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/navigator/objectMenu.ts` |
| Modify | `frontend/src/navigator/NavigatorTree.ts` |
| Modify | `frontend/src/roles/RolesTree.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Modify | `frontend/src/shell/appRouter.ts` |
| Modify | `frontend/src/shell/QueriesView.ts` |
| Modify | `frontend/src/shell/StartPage.ts` |
| Modify | `frontend/src/shell/startPageWelcome.ts` |
| Modify | `frontend/src/shell/DatabaseExplorerView.ts` |
| Modify | `frontend/src/shell/ActivityBar.ts` (comment only) |
| Modify | `frontend/src/shell/shortcutRegistry.ts` |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |
| Modify | `frontend/tests/navigator/objectMenu.test.ts` |

No file is deleted. `frontend/src/SqlAdminApp.ts` and
`frontend/src/shell/RolesExplorerView.ts` are read but unchanged: everything they
touch (`setSyncAddressBar`, `rolesProperties`, `layout`, `statusBar`) stays on the
coordinator.

---

## Expected Behaviour

Cases 1-24 are unit-testable under the node vitest harness. Cases 25-34 need
manual verification — they are tabs, menus, and sidebar behaviour the harness
cannot render.

### `controllerText.ts` panel ids (cases 1-6)

Use `REF = {connectionId:"default", database:"sqladmin", schema:"public", name:"orders", kind:"table"}`.

1. `panelId(REF)` is `default/sqladmin/public.orders`; `structurePanelId`,
   `definitionPanelId`, `sequenceInfoPanelId`, `indexInfoPanelId`,
   `typeInfoPanelId`, `relationDiagramPanelId`, `relationDependencyPanelId` and
   `relationInheritancePanelId` each append `::structure`, `::definition`,
   `::sequence`, `::index`, `::type`, `::diagram`, `::dependencies`,
   `::inheritance` respectively. All nine are distinct.
2. `functionDefinitionPanelId({…, name:"total_orders", signature:"integer"})` is
   `default/sqladmin/public.total_orders(integer)::function`, and the same ref with
   `signature` omitted gives `…public.total_orders()::function` — two overloads
   never collide.
3. `diagramPanelId`, `dependencyPanelId` and `inheritancePanelId` on a
   `{schema:"public", kind:"schema"}` ref omit the object segment:
   `default/sqladmin/public::diagram`, `…::dependencies`, `…::inheritance`.
   `databaseDiagramPanelId` omits the schema segment too:
   `default/sqladmin::db-diagram`.
4. `notesPanelId("default")` is `notes/default`;
   `roleGrantsPanelId("default","alice")` is `grants/default/alice`;
   `roleGrantsDiagramPanelId("default","alice")` is
   `roles/default/alice::grants-diagram`;
   `roleMembershipDiagramPanelId("default","alice")` is
   `roles/default/alice::membership`. All four are distinct.
5. `ddlPanelId({schema:"public", kind:"schema", …}, "table")` is
   `default/sqladmin/public/::ddl-table`; with `name:"addr"` and slug
   `composite-type` it is `default/sqladmin/public/addr::ddl-composite-type`.
6. Two refs differing only in `database` produce different `panelId`s — the
   same-named table in two databases never collides.

### `panelIdsFor` (cases 7-9)

7. For `REF` it returns exactly the ten object-scoped ids of case 1, in that order.
8. For a `"schema"` ref it returns exactly the three schema-scoped ids; for a
   `"database"` ref, exactly `databaseDiagramPanelId(ref)`.
9. Every returned id is distinct, and none appears in another kind's list.

### `panelTooltip`, `elideName`, `errorMessage`, `detailOf` (cases 10-14)

10. `panelTooltip(REF, "Table")` is
    `"orders\n\nType: Table\nSchema: public\nDatabase: sqladmin"`.
11. `elideName` returns a 40-character name unchanged, and elides a 41-character
    one to 39 characters plus `…`. A name whose 39th character is a space sheds it
    first, so the result never reads `"… …"`.
12. `errorMessage` prefers the body detail, then the message, then `String(error)`:

    | `error` | Result |
    |---|---|
    | `{ body: { detail: "relation does not exist" } }` | `relation does not exist` |
    | `{ body: { detail: [{msg:"a"},{msg:"b"}] } }` | `a; b` |
    | `{ body: {}, message: "network down" }` | `network down` |
    | `new Error("boom")` | `boom` |
    | `"plain"` | `plain` |
    | `null` | `null` |

13. `detailOf` returns `null` for `null`, `undefined`, a string, a number, and an
    object whose `detail` is a number; returns the string for `{detail:"x"}`; joins
    an array with `"; "`, using each entry's `msg` when present and `String(entry)`
    otherwise.
14. `errorMessage({ body: { detail: 42 }, message: "fallback" })` is `fallback` —
    an unusable `detail` falls through rather than stringifying `42`.

### `RevealCoordinator` (cases 15-23)

Drive these with a stub `ExplorerTree` recording its calls, and stub view selectors.

15. `revealInNavigator(match)` with a matching node calls the Database-view
    selector, awaits `whenLoaded()`, calls `revealByPredicate(match)`, then
    `selectNode(node)` — and never `expandNode`.
16. The same call with `{ expand: true }` also calls `expandNode(node)`, after
    `selectNode`.
17. With `{ open }`, `open` is invoked **synchronously**, before the tree's
    `whenLoaded` promise settles, and receives a still-pending promise. This is
    what keeps a tab from waiting on a tree search.
18. When `revealByPredicate` resolves `undefined`, `open` is still invoked and
    `selectNode` is never called.
19. With no tree registered, the view selector still runs, `open` still receives a
    promise resolving `undefined`, and nothing throws.
20. `revealInRoles` behaves identically against the roles tree and the Roles-view
    selector, and never touches the navigator.
21. `selectObject({connectionId, database, kind:"database"})` — no `schema` —
    calls the Database-view selector and never calls `revealByPredicate`.
    `selectObject` on a schema-bearing ref does reveal.
22. `refreshNavigator()` calls the navigator's `refresh`; with no navigator
    registered it is a silent no-op. `selectNavigatorNode(node)` likewise.
23. `findInNavigator(match)` resolves to the revealed node without calling
    `selectNode` or `expandNode`, and resolves `undefined` when nothing matches or
    no navigator is registered. It calls the Database-view selector either way.

### Method visibility after the split (case 24)

24. None of these eight names appears on `SqlAdminController` any more. Verified
    by `grep -rn '\bcontroller\.<name>\b' frontend/src` returning zero matches for
    each.

    | Method | New owner | Visibility | Why |
    |---|---|---|---|
    | `addConstraint` | `DdlLaunchers` | public | `ObjectPanels.structureActionsFor` calls it |
    | `dropConstraint` | `DdlLaunchers` | public | same |
    | `createIndex` | `DdlLaunchers` | public | same |
    | `dropIndex` | `DdlLaunchers` | public | same |
    | `openReferencedTable` | `ObjectPanels` | public | `DiagramPanels` and `RoleActions` call it |
    | `openReferencedSequence` | `ObjectPanels` | **private** | only `openStructure` calls it |
    | `openGrantedTable` | `RoleActions` | **private** | only `openRoleGrantsDiagram` calls it |
    | `saveQuery` | `QueryWorkspace` | **private** | only `promptAndSaveQuery` calls it |

### Manual verification (cases 25-34)

25. **Nothing changes on screen except case 26 and case 27.** Every tab still
    opens with the same title, glyph, tooltip, status message and address-bar
    route; re-opening focuses the existing tab; the navigator and Roles context
    menus show the same items in the same order.
26. **A DROP now closes every tab for the dropped object.** With a table's Data,
    Structure, Relations, Dependencies and Inheritance tabs all open, dropping the
    table closes all five (today: Data and Structure only). Dropping a view with
    its Definition, Data-as-query and Dependencies tabs open closes the Definition
    and Dependencies tabs; the auto-run query tab has its own minted scratch id and
    is left alone, exactly as today. Dropping a function closes its Definition tab.
    Dropping a schema closes that schema's Diagram, Dependency and Inheritance tabs.
27. **`exportRole` on a role with no grants** status-bars
    `sqladmin · alice has no table grants to export` — it gains the
    connected-database prefix every other status message already carries.
28. **Reveal-then-open still runs concurrently.** Clicking a foreign key in a
    Structure tab opens the referenced table's tab immediately, with the navigator
    selection landing afterwards; the same for an index tab's "Open table" and a
    sequence tab's "Owned by column". A target in an unexpanded schema still gets
    revealed.
29. **The sidebar switches before searching.** A deep link to
    `/role/user/alice` brings the Roles rail forward and selects `alice`;
    `/schema/public` brings the Database rail forward and expands `public`.
30. **The start page still tracks the workspace.** Opening a table adds it to
    Recent tables; clicking a Recent entry reopens it; saving and removing a query
    updates both the start page and the Queries rail live. An auto-run query tab
    still puts its run's URL in the address bar without a tab switch.
31. **Alt+R, the Tools → Export results submenu and its greying, View → Refresh,
    and the rail accelerators** all behave as before.
32. **The query panel's index advisor** still opens the Create-index flow with the
    suggested columns pre-checked.
33. **A role's grants graph** still opens a granted table by double-click — and
    still status-bars `… not found in navigator` when the table's database was
    never browsed — and still shows the object context menu on right-click; a
    diagram node's right-click menu is unchanged everywhere.
34. **The Keyboard Shortcuts dialog and the start page's legend** render the same
    fourteen rows in the same three groups after `ShortcutScope` is deleted.

---

## Verification

From `frontend/`:

1. `npm run typecheck` — clean. This is the primary gate: `noUnusedLocals`,
   `noUnusedParameters` and `verbatimModuleSyntax` are on, so every import left
   behind by a move fails here.
2. `npm test` — all suites green, including the two new
   `tests/controller/*.test.ts` files and the regrouped
   `tests/navigator/objectMenu.test.ts`. `tests/shell/startPageWelcome.test.ts` and
   `tests/shell/shortcutRegistry.test.ts` must pass **unchanged**.
3. `npm run build` — clean.

Grep invariants, from the repo root:

- `grep -rn 'SqlAdminController' frontend/src/controller/` — zero matches. A
  collaborator importing the coordinator is the cycle this plan exists to prevent.
- `grep -rn 'Pick<SqlAdminController' frontend/src/` — zero matches.
- `grep -n 'private .*PanelId(' frontend/src/SqlAdminController.ts` — zero matches.
- `grep -n 'function elideName\|private detailOf' frontend/src/SqlAdminController.ts` — zero matches.
- `grep -rn '_navigator\|_rolesTree' frontend/src/SqlAdminController.ts` — zero matches.
- `grep -rn 'ShortcutScope' frontend/src frontend/tests` — zero matches.
- `grep -rn 'no emptyContent hook\|Phase 1 ships' frontend/src/` — zero matches.
- `wc -l frontend/src/SqlAdminController.ts frontend/src/controller/*.ts` — the
  controller under 700 lines, and no module under `controller/` over 700.

Manual smoke test, driven through the running app (the `verify` skill). Exercise
`## Expected Behaviour` cases 25-34: the navigator's schema, relation, sequence,
index, type and function context menus; a table's Data, Structure, Definition,
Relations, Dependencies and Inheritance tabs; the database diagram; the Roles
rail's grants, membership and grants-graph items; the Queries rail and the start
page; the Query, Tools and View menus; and deep links to `/schema/public`,
`/schema/public/table/customers/structure`, `/role/user/postgres`, `/notes` and
`/database/diagram`.

---

## Documentation Impact

App-internal; no published API and no docs site is involved. The in-repo
documents that change:

- **`frontend/COMPONENT_CONVENTIONS.md` section (b)** — the super-cascade worked
  example is corrected to `ActivityBar`'s real constructor, with one added
  sentence stating when a pre-`super()` local is actually required (step 20).
- **`frontend/src/shell/SqlAdminShell.ts`** — `buildCenterDeck`'s and
  `buildSidebar`'s JSDoc (step 18).
- **`frontend/src/shell/ActivityBar.ts`** — the module header's Phase-1 claim
  (step 19).
- **`frontend/src/shell/shortcutRegistry.ts`** — the header's list of display
  metadata drops "scope" (step 21).
- **`frontend/src/SqlAdminController.ts`** — the module header names the six
  collaborator fields and points at `panelHost.ts` for the seam (step 17).
- Each new module carries a header naming what it owns and, for
  `controllerText.ts`, `panelHost.ts` and `revealCoordinator.ts`, why it holds no
  library value import — the same sentence `startPageWelcome.ts` and
  `routeTargets.ts` already carry.

`CHANGELOG.md` is not touched: changelog sections are written at release time
(`release-steps.md`). Nothing here is user-visible except cases 26 and 27.

---

## Potential Challenges

- **A collaborator constructor that calls a host method reads a half-built
  controller.** `this` is handed over before the coordinator's constructor
  finishes. Mitigation: every field `PanelHost` names is assigned in the
  constructor's first block, and each collaborator constructor does field
  assignment only — no method calls.
- **`objectMenu.ts` must stay loadable by the node test harness.** It gains four
  `import type` lines from `frontend/src/controller/`, whose modules do touch the
  DOM at import scope. `import type` erases at compile time under
  `verbatimModuleSyntax`, so nothing is pulled at runtime — the same reason its
  existing `import type { SqlAdminController }` is safe, as its own header says.
- **`import type` versus value import matters throughout.** `verbatimModuleSyntax`
  is on: a value import kept for a type-only use pulls the module at runtime and
  can break a node test. `panelHost.ts` in particular must import `Dock`,
  `StatusBar`, `LayoutStore`, `Component` and `RolesPropertiesPanel` as types only.
- **Leave `SqlAdminController.ts`'s `Glyph.register(...)` call where it is.**
  Registration is global and runs at module load, and the controller module is
  always loaded, so splitting the ten names across the new modules changes nothing
  except the chance of dropping one — and a name registered nowhere renders a blank
  button face. The comment above the call stays accurate as written.
- **`OpenPanel` entries are mutated in place.** `openStructure`'s refresh closure
  writes `entry.columns = freshColumns` on the object `panelEntry(id)` returns, and
  `DdlLaunchers.structureColumns` reads it back. `panelEntry` must return the live
  entry, not a copy.
- **The three sibling plans must be in `plans/implemented/` first.** Each rewrites
  members this plan then moves. Starting early means moving code that is about to
  be rewritten, and re-doing the move.

---

## Critical Files

| File | Why |
|---|---|
| [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) | The whole subject. Read it after the three sibling plans land, not before. |
| [`frontend/src/shell/startPageWelcome.ts`](frontend/src/shell/startPageWelcome.ts) + [`appHeaderText.ts`](frontend/src/shell/appHeaderText.ts) + [`routeTargets.ts`](frontend/src/shell/routeTargets.ts) | The pure-helper extraction precedent `controllerText.ts` and `revealCoordinator.ts` follow: a DOM-free module, a header saying why, and a matching `frontend/tests/` file. |
| [`frontend/src/shell/ActivityBar.ts:77-82`](frontend/src/shell/ActivityBar.ts#L77) | `SidebarSizer` — the in-repo precedent for injecting a narrow interface so a component drives something it must not know about. `PanelHost` is the same idea at scale. |
| [`frontend/src/navigator/objectMenu.ts`](frontend/src/navigator/objectMenu.ts) | The 33-member `Pick` being split, and the header explaining why the module must stay free of runtime library imports. |
| [`frontend/tests/navigator/objectMenu.test.ts:22-36`](frontend/tests/navigator/objectMenu.test.ts#L22) | The `as unknown as` stub technique `revealCoordinator.test.ts` reuses for `ExplorerTree`. |
| [`frontend/src/navigator/NavigatorTree.ts:103-111`](frontend/src/navigator/NavigatorTree.ts#L103) | The `ExplorerTree` interface `RevealCoordinator` holds and a test stubs. |
| [`frontend/src/navigator/revealMatch.ts`](frontend/src/navigator/revealMatch.ts) | The four DOM-free matchers `RevealCoordinator` composes. |
| [`frontend/src/shell/appRouter.ts`](frontend/src/shell/appRouter.ts) | The largest consumer — about 30 call sites move onto collaborator fields. |
| [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) | Section (b)'s worked example (corrected here) and section (d)'s `callable()` rule, which does **not** apply to these plain collaborator classes. |
| [`frontend/src/data/queryStore.ts`](frontend/src/data/queryStore.ts) + [`layoutStore.ts`](frontend/src/data/layoutStore.ts) | The naming precedent for a non-component class in a camelCase module. |
| [`plans/research/codebase-health-audit-2026-08-29.md`](plans/research/codebase-health-audit-2026-08-29.md) | The `SqlAdminController.ts` design-decision entry, the Priority 3 `ShortcutScope` bullet, and the three Priority 4 doc bullets this plan closes. |

---

## Non-Goals

- **Changing what any surface does.** This is a move, not a redesign. The two
  intentional behaviour changes are named in `## Expected Behaviour` cases 26 and 27.
- **Splitting `SqlAdminShell.ts`.** Its free-function decomposition
  (`buildSidebar`, `buildWorkArea`, `buildCenterDeck`, `buildMenuBar`,
  `installAccelerators`) already works; only two of its comments change here.
- **Converging `NavigatorTree` and `RolesTree`'s duplicated load lifecycle**, or
  moving `relationTypeLabel` into `objectKinds.ts`. `data-layer-navigator-convergence`
  owns both, and this plan is written so either order works.
- **An unsubscribe API for `onWorkspaceChanged`.** See the Architecture Decision.
- **Tests for the five DOM-bound collaborators** — `ObjectPanels`,
  `DiagramPanels`, `DdlLaunchers`, `QueryWorkspace`, `RoleActions`. Each imports
  library component classes that touch `document` at module load, and
  `vitest.config.ts` runs `environment: "node"`. `controllerText.ts` and
  `revealCoordinator.ts` are the parts that could be made testable, and they are;
  the rest is covered by the manual sweep.
- **The `_options`-shaped naming or `callable()` wrapping of the new classes.**
  `COMPONENT_CONVENTIONS.md` (d) governs mountable components; these are plain
  collaborator classes, like `QueryHistoryStore` and `LayoutStore`.
- **A `CHANGELOG.md` entry or a version bump.** Releases are the user's own step.
- **The remaining audit findings** — the API-URL encoding gap, the error-banner
  triplication, `LoadSignal.arm`, and every backend item. Different subsystems,
  separate passes.

---

## Notes

[^post-convergence]: Three plans land first and reshape this file.
    `ddl-forms-in-tab-editing` rewrites every DDL launcher onto `openDdlPanel` /
    `ddlDefaults` / `fetchSchemaNames` / `ddlPanelId`, turns `createView` and
    `createMaterializedView` into delegations to `createRelationDraft`, and reduces
    `refreshStructure` to a one-line dispatch.
    `diagram-panel-family-convergence` collapses the four dependency/inheritance
    openers onto `graphKind` / `relationGraphHandlers` / `openSchemaRelationGraph` /
    `openRootedRelationGraph`, and repoints `openRoleMembershipDiagram` at a new
    `RoleMembershipDiagramPanel`. `refresh-export-action-dedup` does not touch the
    controller but does touch `objectMenu.ts`, `SqlAdminShell.ts`,
    `NavigatorTree.ts`, `RolesTree.ts` and `QueriesView.ts`. Every line number in
    those five files therefore shifts, which is why this plan addresses members by
    name. Where a member's post-convergence body is described above, it is the
    sibling plan's version that moves, not today's.

[^why-responsibility]: The per-kind cut looks natural on today's file because the
    launchers are 30-line blocks that read like the panel openers beside them.
    After `ddl-forms-in-tab-editing` they are not: each is a ten-line
    `openDdlPanel` or `openSqlPreviewDialog` call sharing one `ddlDefaults(ref)`
    spread and one `fetchSchemaNames` preamble, and what they have in common is the
    wiring, not the object. Splitting them by kind would put four copies of that
    wiring in four files and re-create the duplication the sibling plan just
    removed. The same argument holds for the diagram openers, which after
    `diagram-panel-family-convergence` share `graphKind` and
    `relationGraphHandlers`. The responsibility cut also produces one module that
    is genuinely self-contained state (`QueryWorkspace` owns three localStorage
    stores nothing else touches) and one that is DOM-free and testable
    (`RevealCoordinator`), neither of which a per-kind cut would yield.

[^no-delegation]: Keeping `SqlAdminController.openTable(ref, node)` as a one-line
    forward to `this.panels.openTable(ref, node)` would leave every consumer
    untouched, which is tempting. It is rejected because it keeps the whole problem:
    `objectMenu.ts`'s `Pick` would still name 33 controller members, the class would
    still be the app's one god handle, and roughly 250 lines of forwarding would be
    added for no information. The file's own comment at the `layout` field says the
    rule — a store is exposed directly rather than mirrored — and eight sites already
    bind against `controller.layout` that way. The cost is a mechanical rename at
    about 60 call sites, all caught by `tsc`.

[^host-not-bus]: An internal event bus was considered and rejected. The
    collaborators' interactions are synchronous calls with return values
    (`panelEntry(id)` returns an entry, `fetchColumns(ref)` returns a promise) —
    not notifications — so a bus would need a request/response protocol on top,
    and would erase the compile-time call graph that makes this split checkable by
    `tsc`. Nothing in the repo uses one. Routing everything through the coordinator
    instead was rejected for the same reason as the delegation wrappers: it puts
    the surface back. The `PanelHost` interface is wide (18 members) because the
    shared core genuinely is that wide — the Dock, the panel registry, the status
    line and the error path are used by every area — and naming it in one
    documented interface is what makes that width visible instead of implicit.

[^acyclic]: Two edges would have made the graph cyclic. `reopenTable` needed
    `_recentTables` (workspace) and `openTable` (panels), while `openTable` needed
    `rememberTable` (workspace); moving the six-line `reopenTable` to the
    coordinator — which may call any collaborator — leaves one edge,
    `ObjectPanels → QueryWorkspace`, and `StartPage` keeps calling
    `controller.reopenTable(ref)` unchanged. `diagramContextMenu` needed the whole
    controller, because `showObjectMenu` takes an `ObjectMenuActions` that only the
    coordinator satisfies; injecting it as a `ShowObjectContextMenu` callback gives
    `DiagramPanels` and `RoleActions` a function instead of a back-reference. The
    alternative — lazy getter thunks — compiles but hides the ordering the table in
    `## Architecture Decisions` now makes explicit.

[^pick-split]: Three shapes were weighed. Keeping one flat `Pick` is impossible
    once the members live on six objects. Declaring the members structurally in
    `objectMenu.ts` would drop the compile-time link to the real signatures, which
    is the whole value of the current `Pick`. Grouping four `Pick`s under one record
    keeps that link, and keeps both callers passing the controller itself, because
    `SqlAdminController`'s `panels`/`diagrams`/`ddl`/`workspace` fields are assignable
    to the four slices. The grouping also makes the menu's own reach legible: eight
    panel opens, six diagram opens, sixteen DDL launchers, two query opens, one
    export. `exportTable` stays a direct member because it is the coordinator's own
    route — the streaming-download anchor — and belongs to no collaborator.

[^tooltip-label]: `panelTooltip` currently calls `relationTypeLabel`, exported by
    `properties/PropertiesPanel.ts`, which constructs library components at import
    scope. Importing it would make `controllerText.ts` unloadable in the node test
    environment and cost the module its tests. Taking the label as a parameter keeps
    the function pure, and leaves exactly one call site in the whole app that names
    the label source — the coordinator's `panelTooltip(ref)` wrapper. That also
    means `data-layer-navigator-convergence`, which deletes `relationTypeLabel` in
    favour of `objectKinds.ts`'s `kindDisplayLabel`, still has one line to change
    whichever order the two plans land in.

[^two-reveals]: One `openWithReveal(match, open)` would have to take the tree as a
    parameter, since the navigator and the roles tree differ in which view is
    brought forward, which `whenLoaded` is awaited and which `selectNode` is called.
    That parameter would appear at all seven call sites and would be the thing a
    reader has to decode at each of them. Two named methods over one private body
    remove the duplication just as completely — there is one copy of the
    reveal-select-expand tail — while each call site says which tree it means. The
    `RevealOptions` bag carries the two genuine variations (expand, open-alongside)
    rather than a third and fourth method.

[^close-tabs]: The three DROP paths disagree today: `dropTable` closes the data and
    structure tabs, `dropRelation` closes the data and definition tabs, and
    `dropFunction` closes only the definition tab. None closes the object's
    Relations, Dependencies or Inheritance tab, so dropping a table leaves up to
    three tabs rendering a graph rooted at an object that no longer exists — and a
    Refresh on one of them fails with a backend error. Deriving the list from
    `panelIdsFor(ref)` makes the rule impossible to get partially right, and makes it
    unit-testable, which none of the three hand-written lists was. Passing ids for
    tabs a kind cannot open is deliberate and free: `Dock.removePanel` on an unopened
    id is already relied on as a no-op — `dropTable` calls
    `removePanel(structurePanelId(ref))` whether or not a Structure tab was ever
    opened.

[^no-unsubscribe]: `_workspaceListeners` is push-only with no removal, which is a
    leak in general and not one here: `QueriesView` and `StartPage` are each
    constructed once, in `buildSidebar` and `buildCenterDeck`, and the shell never
    rebuilds either. Adding `offWorkspaceChanged` with no caller would ship an
    unused export into a codebase whose own audit lists eleven of those under
    Priority 3. The fix that costs nothing and prevents the future mistake is to
    write the requirement into the JSDoc, so a subscriber with a shorter life than
    the workspace is a decision someone makes against a stated rule rather than by
    accident.

[^record-run]: `recordRun` currently re-syncs the address bar when the completing
    run belongs to the still-focused panel, because an auto-run query tab's run
    finishes after the `"focus"` event that opened it has already fired. That check
    reads `_activePanelId`, which stays on the coordinator. It moves into
    `host.recordQueryRun(id, timestamp)`, which records the timestamp and re-syncs
    when `id` is the focused panel — the same two statements, on the side that owns
    both pieces of state. `QueryWorkspace.recordRun` keeps the history write and the
    workspace-changed notification.

[^which-side]: `COMPONENT_CONVENTIONS.md` section (b)'s rule is right and its
    example is not. The rule exists because `this` is unavailable until `super()`
    returns and the library's option cascade runs setters during `super()`; it
    therefore binds on anything `super()`'s own options bag reads. `ActivityBar`
    passes `super()` a layout manager and nothing else, so building `card`, `deck`
    and `rail` afterwards is correct, simpler, and what the file does. Changing
    `ActivityBar` to match the snippet would add a pre-`super()` local for no reason
    and make the file worse. `LoginForm` and `SqlAdminShell` are the constructors
    where the rule actually bites — both build children as locals because
    `super({ components: … })` reads them — and the doc already names `LoginForm` as
    the template two paragraphs down, so the corrected example and the surrounding
    text agree.
