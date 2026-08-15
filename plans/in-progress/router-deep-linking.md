---
touches-shared:
  - frontend/src/SqlAdminApp.ts
  - frontend/src/SqlAdminController.ts
  - frontend/src/dock/TableWorkPanel.ts
  - frontend/src/dock/diagramShell.ts
  - frontend/src/dock/RelationDiagramPanel.ts
  - frontend/src/dock/RootedRelationGraphPanel.ts
  - frontend/src/dock/recordNavigation.ts
  - README.md
  - TODO.md
---

# Router Deep Linking — Implementation Plan

## Overview

SQLAdmin ignores the URL. [`SqlAdminApp.ts:18-35`](frontend/src/SqlAdminApp.ts#L18) boots the UI, gates on a session, and mounts the shell; nothing anywhere reads `location`. Every view is reached by clicking. This plan makes a URL address a view: `/schema/sales/table/customers?rotated=true&record=42` opens that table's data tab in record view showing record 42, `/schema/sales/diagram` opens the schema's ER diagram, `/role/user/analyst/grants-diagram` opens a role's grants graph.

The work is a `Router` from `@jimka/typescript-ui/router` constructed after the login gate, a route table that maps patterns onto the controller's existing `open*` methods, and two small panel additions so a route can ask for an initial traversal depth (`RelationDiagramPanel`, `RootedRelationGraphPanel`) and an initial record view focused on one record (`TableWorkPanel`). Everything a URL has to parse lands in DOM-free modules — two new ones plus an addition to an existing one — so it is unit-testable under the project's node-environment vitest.

Two boundaries are set before anything else:

**This pass only consumes URLs.** No "Copy link" action, no context-menu or toolbar affordance that generates a shareable URL, and no call to `router.navigate` anywhere — the URL is read once at boot and never written. Generating links is an explicit fast-follow, out of scope here.[^no-navigate]

**The library half must land first.** The `Router` in the installed `@jimka/typescript-ui@0.5.0` throws query strings away. The one piece of new API this plan consumes is `RouteHandler`'s fourth argument, `query: Record<string, string>` — the read side. Its write side (`getHref(path, query?)`, `navigate(path, { query })`) is what a "Copy link" pass would use and goes untouched here. Both are specified by `typescript-ui/plans/router-query-string-support.md` in the sibling repo, which this plan treats as fixed and re-decides none of.[^library-gated]

---

## Architecture Decisions

### History mode, not hash mode

The `Router` is constructed as `new Router({ mode: "history" })`, so links are ordinary paths (`/schema/sales/table/customers`) with a real `location.search`, not `#/…`. Both ways this app is served — the Vite dev server and the FastAPI static mount — already return `index.html` for an unknown path.[^history-not-hash]

`base` is left at its `"/"` default, because `frontend/vite.config.ts` sets no Vite `base` and the FastAPI mount serves the app at the site root. If the app is ever served under a sub-path, Vite's `base` and the `Router`'s `base` have to be set together.

### `router.start()` runs after the shell is mounted, and after the login gate

The boot sequence gains two statements and keeps its existing order:

```ts
const controller = new SqlAdminController(session.connectionId, session.username, session.database);
const router     = buildAppRouter(controller);

Body.getInstance().addComponent(SqlAdminShell(controller));

router.start();
```

Login gating falls out of this order for free: `showLoginDialog()` ([`LoginDialog.ts:199`](frontend/src/shell/LoginDialog.ts#L199)) is an in-page modal that never touches the URL, and it is awaited before the router exists — so an unauthenticated user sees the login dialog, and the route is applied only once the shell is up.[^start-after-mount]

### Schema-scoped objects nest under their schema in the path

A table, view, matview, sequence, index, or function route nests under `/schema/:schema/` — `/schema/sales/table/customers`, not `/table/sales/customers` — mirroring how the navigator itself contains things: a schema node, expanded, is what reveals its tables, sequences, indexes, and functions. The schema's own route, `/schema/:schema/:view` for its diagram/dependencies/inheritance graphs, already had this shape; every schema-scoped object route now shares the same top-level prefix instead of the schema and its objects being addressed by two different conventions.

This adds no new specificity logic to the router. `matchPattern` (`RoutePattern.ts` in the sibling `typescript-ui` repo) requires an exact segment count for every pattern registered here — none end in a catch-all `*` — so `segments.length !== staticLength` rejects a candidate outright before any segment is even compared. `/schema/:schema/:view` (3 segments) and `/schema/:schema/table/:name` (4 segments) can therefore never both match one URL: a request only ever reaches the candidates whose segment count matches its own. Within one segment count, the object-kind segment (`table`, `sequence`, `function`, …) is a distinct static literal per family, so two same-length patterns under `/schema/:schema/` can only tie if they are literally the same pattern, which the route table never registers twice. `selectPattern`'s specificity tie-break (`isMoreSpecific`, ranking a static segment above a param above a catch-all, position by position) exists for cases where an ambiguity is possible in principle; here, disambiguation is by segment count and a distinct static literal instead, so that tie-break is never invoked for these routes.

### A bare object path opens that object's default tab; a trailing segment names an alternative view

`/schema/sales/table/customers` opens the data tab. `/schema/sales/table/customers/structure` opens the Structure tab. `/role/user/analyst` opens the role's grants tab; `/role/user/analyst/membership` opens its membership graph. There is no `/data` or `/grants` segment — the default tab has no name of its own.[^default-tab-rule]

| URL | Opens |
|---|---|
| `/schema/sales/table/customers` | the table's data tab |
| `/schema/sales/table/customers/structure` | the table's Structure tab |
| `/schema/sales/view/v_orders` | the view's browse-query tab |
| `/schema/sales/view/v_orders/definition` | the view's Definition tab |
| `/role/user/analyst` | the role's grants tab |
| `/role/user/analyst/membership` | the role's membership graph |

### Object identity lives in path segments; view-mode properties live in the query string

Schema, relation name, and role name are path segments — the values that select *which* resource family and *which* specific resource within it a URL addresses. Initial traversal depth, the record-view flag, the focused record, and a routine's overload-disambiguating signature are query parameters. This is the split the library plan fixes; see below for why `signature` sits on the query side despite disambiguating identity.

| URL | Path carries | Query carries |
|---|---|---|
| `/schema/sales/table/customers?rotated=true&record=42` | schema `sales`, table `customers` | record view, record `42` |
| `/schema/sales/table/customers/diagram?depth=2` | schema `sales`, table `customers` | traversal depth 2 |
| `/role/user/analyst/membership?depth=all` | role `analyst` | unbounded depth |
| `/schema/sales/function/calc_total?signature=numeric` | schema `sales`, function `calc_total` | overload signature `numeric` |

**Why `signature` belongs in the query string despite disambiguating identity.** An absent `signature` already has defined fallback behaviour — the no-overload case, resolved as `openFunctionDefinition({ …, signature: "" })` — the same shape as every other query property in the table above: an absent `depth`, `rotated`, or `record` also falls back to a documented default. What sets `:schema` and `:name` apart from `signature` is that they select *which* resource family and resource a URL is even addressing — no two different functions share a `(schema, name)` pair — while two overloads of the *same* function already share a fully-matched `(schema, name)`; `signature` only narrows which overload of that already-uniquely-identified name is meant. A value that narrows an already-selected resource, rather than selecting which resource is addressed, is exactly what belongs in the query string under this split.

### The three relation kinds and the three role buckets are static path segments, registered in a loop

`table`, `view`, and `matview` are static segments right after `/schema/:schema/`, and `user`, `group`, and `predefined` are static segments right after `/role/`, so `/schema/sales/widget/a` and `/role/bogus/x` both match no pattern at all and report through the router's own `nomatch` event. Both vocabularies are registered by iterating one exported constant each — `RELATION_KINDS` and `ROLE_BUCKETS` — rather than by writing six (and six) near-identical `register` calls.[^kind-in-path]

### A record is addressed by its primary-key value, not by row index

`?record=42` means "the record whose primary key stringifies to `42`", matched against the loaded page via `ModelRecord.getId()`. A row index would name a different row after any sort or filter change.[^record-is-primary-key]

### Route handlers call the plain `open*` methods, never the `openReferenced*` variants

`openReferencedTable` / `openReferencedSequence` / `openReferencedStructure` ([`SqlAdminController.ts:2205`](frontend/src/SqlAdminController.ts#L2205), [`:2237`](frontend/src/SqlAdminController.ts#L2237), [`:2252`](frontend/src/SqlAdminController.ts#L2252)) pair an open with a navigator reveal. At `router.start()` time the navigator's schema list has not arrived yet, so the reveal cannot match anything — the route handlers use `openTable`, `openSequence`, and `openStructure` directly instead.[^no-navigator-reveal]

### A role route's bucket segment is never validated against the role's real classification

`/role/user/analyst`, `/role/group/analyst`, and `/role/predefined/analyst` all open the same role `analyst` unconditionally — the bucket is not checked against `RoleSummary.canLogin` or the `pg_`-prefix rule `groupRoles.ts` uses to sort a role into Users, Groups, or Predefined ([`groupRoles.ts:32-34`](frontend/src/roles/groupRoles.ts#L32)). This is deliberate, not a shortcut, and follows the identical limitation as the `openReferenced*` decision above: the role list `RolesTree` sorts into buckets has not loaded when `router.start()` applies the first route, so there is nothing to validate a bucket claim against at consume time — the same race documented in [^no-navigator-reveal], against `RolesTree`'s data instead of `NavigatorTree`'s. The bucket exists purely so a hand-written or generated link can match the vocabulary the app's own navigator already uses — `/role/user/…` for a login-capable role, `/role/group/…` for a user-created NOLOGIN role, `/role/predefined/…` for a `pg_*` built-in — not to gate which URL can open which role.

### A route that cannot be resolved reports and leaves the start page

Three failure shapes, one outcome — an error notification plus the untouched start page, never a broken boot:

| Failure | Where it surfaces |
|---|---|
| No pattern matches (`/nope`) | the router's `nomatch` listener |
| A pattern matches but its view segment is not valid for that kind (`/schema/sales/table/a/definition`) | the handler's own vocabulary check |
| The object does not exist in the session's database (`/schema/sales/table/gone`) | the tab's fetch rejects → the Dock's existing `"exception"` handler ([`SqlAdminController.ts:340`](frontend/src/SqlAdminController.ts#L340)) |

Every handler body additionally runs inside a `dispatch` wrapper that catches a synchronous throw and a rejected promise and routes both to `controller.notifyError`, so no route can ever reject into `main()`'s boot `catch`.

### The depth vocabulary moves to a DOM-free module

`DEPTH_ALL`, `DEPTH_CHOICES`, `DEFAULT_DEPTH`, and `depthFromChoice` move out of [`diagramShell.ts:38-65`](frontend/src/dock/diagramShell.ts#L38) into a new `frontend/src/dock/depthChoices.ts`, joined by a new `depthChoice(raw)` normalizer that both the route layer and `DiagramShell` call. `diagramShell.ts` imports the library's DOM-backed components at module scope, so nothing inside it is reachable from the node vitest harness.[^depth-vocabulary-move]

`depthChoice` maps a raw query value onto a `DEPTH_CHOICES` entry:

| `raw` | Result |
|---|---|
| `undefined` / `""` | `"1"` |
| `"2"` | `"2"` |
| `"all"` / `"All"` / `"ALL"` | `"All"` |
| `"0"` / `"4"` / `"deep"` | `"1"` |

### `rotated` and `record` are independent

`?rotated=true` opens the record view — the same `Table.setDisplayMode("rotated")` call the toolbar toggle makes ([`TableWorkPanel.ts:283`](frontend/src/dock/TableWorkPanel.ts#L283)). `?record=42` selects record 42, which in the normal grid scrolls its row into view and in the record view re-targets the displayed record. Neither implies the other.[^rotated-and-record-orthogonal]

| Query | Result on a table's data tab |
|---|---|
| *(none)* | grid, first page, nothing selected |
| `?rotated=true` | record view, on whichever record the grid targets first |
| `?record=42` | grid, row 42 selected and scrolled into view |
| `?rotated=true&record=42` | record view showing record 42 |

Both are honoured only for `kind: "table"`. A view or materialized view opens as a browse-query tab ([`SqlAdminController.ts:440`](frontend/src/SqlAdminController.ts#L440)), which has no `TableWorkPanel`, so the two parameters are ignored there.

---

## Public API

### `frontend/src/dock/depthChoices.ts` (new)

Pure; imports nothing.

```ts
/** The `Depth` choice meaning an unbounded walk. */
export const DEPTH_ALL = "All";

/** Depth choices offered by the control, in order. */
export const DEPTH_CHOICES = ["1", "2", "3", DEPTH_ALL];

/** The depth every rooted diagram opens at. */
export const DEFAULT_DEPTH = 1;

/** The hop limit a `Depth` choice means; `Number.POSITIVE_INFINITY` for `DEPTH_ALL`. */
export function depthFromChoice(choice: string): number;

/**
 * Normalize a raw depth request (a route's `depth` query value, or a panel's
 * `initialDepth`) onto a `DEPTH_CHOICES` entry. Case-insensitive for `All`;
 * anything unrecognized falls back to `String(DEFAULT_DEPTH)`.
 */
export function depthChoice(raw: string | undefined): string;
```

### `frontend/src/dock/diagramShell.ts`

```ts
export interface DiagramShellSlots {
    view: DiagramView;
    headerControls?: Component[];
    rootedControls?: Component[];
    extraControls?: Component[];
    /** The `DEPTH_CHOICES` entry the Depth control opens at; normalized through
     *  `depthChoice`, so an unrecognized value opens at the default. */
    initialDepth?: string;                                        // NEW
}
```

`DEPTH_ALL`, `DEPTH_CHOICES`, `DEFAULT_DEPTH`, and `depthFromChoice` are **no longer declared here** — they move to `depthChoices.ts` and are not re-exported. Backing field: the existing `private depthIndex`, now seeded in the constructor body from `depthChoice(config.initialDepth)` instead of by its field initializer.

### `frontend/src/dock/RelationDiagramPanel.ts` / `RootedRelationGraphPanel.ts`

```ts
class RelationDiagramPanel extends DiagramShell {
    constructor(
        full: DiagramData,
        root: DiagramNodeData,
        onSelectTable: (table: string) => void,
        onContextMenu?: (table: string, event: MouseEvent) => void,
        initialDepth?: string,                                    // NEW, 5th positional
    );
}

class RootedRelationGraphPanel extends DiagramShell {
    constructor(
        full: DiagramData,
        root: DiagramNodeData,
        onSelect: (node: RelationNodeData) => void,
        onContextMenu?: (node: RelationNodeData, event: MouseEvent) => void,
        initialDepth?: string,                                    // NEW, 5th positional
    );
}
```

### `frontend/src/dock/recordNavigation.ts`

```ts
/** The minimum a record must expose to be addressed by its primary-key value. */
export interface KeyedRecord {
    getId(): unknown;
}

/**
 * The first record whose primary-key value stringifies to `key`, or undefined
 * when none does. A record with no primary key (`getId()` undefined or null)
 * never matches.
 */
export function findRecordByKey<T extends KeyedRecord>(records: T[], key: string): T | undefined;
```

### `frontend/src/dock/TableWorkPanel.ts`

```ts
/** How a table's data tab should open — the view-mode properties a route can request. */
export interface TableViewOptions {
    /** Open in the rotated (one record as field/value rows) display mode. */
    rotated?: boolean;
    /** Primary-key value of the record to select once the first page has loaded. */
    record?: string;
}

class TableWorkPanel extends Container {
    constructor(
        store: AjaxStore,
        columns: ColumnMeta[],
        notify: Notify,
        onExport: ExportTable,
        privileges: TablePrivileges,
        view?: TableViewOptions,                                  // NEW, 6th positional
    );
}
```

### `frontend/src/shell/routeTargets.ts` (new)

Pure; imports `DbObjectKind` from `../contract` and nothing else.

```ts
/** The relation kinds a route can address. */
export type RelationKind = Extract<DbObjectKind, "table" | "view" | "materializedView">;

/** One relation kind and the URL path segment that names it. */
export interface RelationRoute {
    segment: string;
    kind:    RelationKind;
}

/** Every relation kind a route can address, with its path segment. */
export const RELATION_KINDS: readonly RelationRoute[];

/**
 * The three role buckets a route can address, mirroring RolesTree's own
 * Users/Groups/Predefined navigator sections. Not validated against a
 * role's actual classification at consume time — see Architecture Decisions.
 */
export const ROLE_BUCKETS: readonly ["user", "group", "predefined"];

/** One of the three URL segments a role route's bucket prefix can be. */
export type RoleBucket = typeof ROLE_BUCKETS[number];

/** The alternative views a relation route's trailing segment can name. */
export type RelationView = "structure" | "definition" | "diagram" | "dependencies" | "inheritance";

/** The alternative views a schema route's trailing segment can name. */
export type SchemaView = "diagram" | "dependencies" | "inheritance";

/** The alternative views a role route's trailing segment can name. */
export type RoleView = "grants-diagram" | "membership";

/** `segment` as a view `kind` supports, or null when it is neither. */
export function relationView(kind: RelationKind, segment: string): RelationView | null;

/** `segment` as a schema view, or null. */
export function schemaView(segment: string): SchemaView | null;

/** `segment` as a role view, or null. */
export function roleView(segment: string): RoleView | null;

/**
 * A query parameter read as a boolean flag: a present-but-empty value (`?rotated`),
 * `"true"`, or `"1"` is true, case-insensitively. Everything else, including an
 * absent parameter, is false.
 */
export function routeFlag(raw: string | undefined): boolean;
```

### `frontend/src/shell/appRouter.ts` (new)

```ts
/**
 * Build the app's Router with every route registered, ready to `start()`.
 * Does not start it — the caller starts it after mounting the shell.
 */
export function buildAppRouter(controller: SqlAdminController): Router;
```

### `frontend/src/SqlAdminController.ts`

```ts
// CHANGED — each gains one trailing optional parameter
async openTable(ref: DbObjectRef, node?: TreeNode | Promise<TreeNode | undefined>, view?: TableViewOptions): Promise<void>;
async openRelationDiagram(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void>;
async openRelationDependencyGraph(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void>;
async openRelationInheritanceGraph(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void>;
async openRoleMembershipDiagram(name: string, depth?: string): Promise<void>;
```

`depth` is a raw request, documented as "a `DEPTH_CHOICES` entry; anything else opens at the default" — it is passed straight through to the panel, which normalizes it through `depthChoice`. No other controller method changes.

---

## The route table

Registered against `controller.connectionId` and `controller.database` ([`SqlAdminController.ts:388`](frontend/src/SqlAdminController.ts#L388), [`:397`](frontend/src/SqlAdminController.ts#L397)) — the session connects to exactly one database ([`api.ts:83`](frontend/src/data/api.ts#L83)), so no route names a database or a connection.

| Pattern | Query keys | Controller call |
|---|---|---|
| `/` | — | none — the start page already shows while the Dock is empty |
| `/notes` | — | `openDocumentation()` |
| `/database/diagram` | — | `openDatabaseDiagram({ connectionId, database, kind: "database" })` |
| `/schema/:schema/:view` | — | `schemaView(params.view)`: `diagram` → `openSchemaDiagram`, `dependencies` → `openSchemaDependencyGraph`, `inheritance` → `openSchemaInheritanceGraph` |
| `/schema/:schema/{table,view,matview}/:name` | `rotated`, `record` | `openTable(ref, undefined, { rotated, record })` |
| `/schema/:schema/{table,view,matview}/:name/:view` | `depth` | `relationView(kind, params.view)` — see the matrix below |
| `/schema/:schema/sequence/:name` | — | `openSequence(ref)` |
| `/schema/:schema/index/:name` | — | `openIndex(ref)` |
| `/schema/:schema/function/:name` | `signature` | `openFunctionDefinition({ …, signature: query.signature ?? "" })` — the single registration for every routine, overloaded or not |
| `/role/{user,group,predefined}/:role` | — | `showRole(role)` |
| `/role/{user,group,predefined}/:role/:view` | `depth` | `roleView(params.view)`: `grants-diagram` → `openRoleGrantsDiagram(role)`, `membership` → `openRoleMembershipDiagram(role, depth)` |

The two relation patterns are registered once per `RELATION_KINDS` entry, and the two role patterns once per `ROLE_BUCKETS` entry — six and six `register` calls from two lines of code each.

**The `ref` each route builds** is uniform: `{ connectionId: controller.connectionId, database: controller.database, schema, name, kind }`, with `kind` fixed by the route's own object-kind segment — the static segment right after `/schema/:schema/` — `"table"` / `"view"` / `"materializedView"` for the relation routes, `"sequence"`, `"index"`, `"function"` (plus `signature`, read from the query string), `"schema"` (no `name`; the schema's own three-segment `/schema/:schema/:view` route has no object-kind segment to key off), `"database"` (no `schema`, no `name`). Nothing else is needed: `getSequenceDetail`, `getIndexDetail`, and `getFunctionDefinition` build their URLs from `connectionId`/`database`/`schema`/`name` alone ([`api.ts:270`](frontend/src/data/api.ts#L270), [`:277`](frontend/src/data/api.ts#L277), [`:457`](frontend/src/data/api.ts#L457)), and `DbObjectRef.table` is set only on navigator-built index leaves, which nothing on these paths reads.

**Relation view matrix** — `relationView(kind, segment)` returns the view only where the cell is `✓`:

| `segment` | `table` | `view` | `materializedView` | Controller call | Query |
|---|---|---|---|---|---|
| `structure` | ✓ | ✓ | ✓ | `openStructure(ref)` | — |
| `definition` | — | ✓ | ✓ | `openDefinition(ref)` | — |
| `diagram` | ✓ | ✓ | ✓ | `openRelationDiagram(ref, undefined, depth)` | `depth` |
| `dependencies` | ✓ | ✓ | ✓ | `openRelationDependencyGraph(ref, undefined, depth)` | `depth` |
| `inheritance` | ✓ | — | — | `openRelationInheritanceGraph(ref, undefined, depth)` | `depth` |

`definition` is view-only because it reads `pg_get_viewdef`; `inheritance` is table-only because PostgreSQL inheritance and partitioning are table-only, which is what [`openRelationInheritanceGraph`](frontend/src/SqlAdminController.ts#L2140)'s own `@param` already states. `diagram` covers all three: a view or matview root shows alone, as [`openRelationDiagram`](frontend/src/SqlAdminController.ts#L1873) documents.

**Pattern selection.** No two patterns above can match the same URL, so the router's specificity tie-break never comes into play. The top level is a small, distinct-static set (`schema`, `database`, `role`, `notes`), so `/schema/…` and `/role/…` never collide with each other, with `/database/diagram`, or with `/notes`. Within `/schema/:schema/…`, `matchPattern` requires an exact segment count for every registered pattern, so a 3-segment URL (`/schema/sales/diagram`) can only match `/schema/:schema/:view`, a 4-segment URL (`/schema/sales/table/customers`) can only match one of the object-kind-then-name patterns, and a 5-segment URL (`/schema/sales/table/customers/diagram`) can only match one of the object-kind-then-name-then-view patterns — segment count alone rules out cross-family ambiguity before the object-kind segment (`table`/`view`/`matview`/`sequence`/`index`/`function`) is even compared, and that segment is a distinct static literal per family. The identical argument covers `/role/{user,group,predefined}/…`, with the bucket segment playing the object-kind segment's role. Object names never collide with the vocabulary either — a schema named `table` is addressed as `/schema/table/diagram`, since a schema route's second segment is the schema *name*, not a kind keyword, and nothing in `/schema/:schema/…` ever compares a captured `:schema` value against the vocabulary. See the "Schema-scoped objects nest under their schema in the path" Architecture Decision for the underlying `RoutePattern` mechanics this reasoning rests on.

### Methods that are deliberately not route targets

| Method | Why not |
|---|---|
| `openQuery`, `openQueryFor` | An ad-hoc query panel has no stable identity — each open mints a fresh `query-N` id — and a URL that seeds and auto-runs SQL is a link that executes SQL on open.[^query-panels-not-routed] |
| `openSavedQuery` | The SQL lives in the opening user's own `localStorage`, keyed by user and connection, so a shared link resolves to nothing for anyone else.[^query-panels-not-routed] |
| `openReferencedTable`, `openReferencedSequence`, `openReferencedStructure` | Reveal-and-open wrappers; the reveal cannot land at boot — see the Architecture Decision. Their underlying `open*` methods are the route targets. |
| `openGrantedTable` | Reveals by schema+name through the navigator and status-bars "not found in navigator" when the tree is not loaded ([`SqlAdminController.ts:2942`](frontend/src/SqlAdminController.ts#L2942)). `/schema/:schema/table/:name` reaches the same tab directly. |
| `reopenTable` | A start-page affordance over the in-memory recent-table list ([`SqlAdminController.ts:2591`](frontend/src/SqlAdminController.ts#L2591)); `/schema/:schema/table/:name` is the same open. |
| `openRoleGrants` | Private; `showRole` ([`SqlAdminController.ts:2768`](frontend/src/SqlAdminController.ts#L2768)) is its public entry point and is what `/role/{user,group,predefined}/:role` calls. |
| `createTable`, `dropTable`, `createIndex`, and every other DDL launcher | Not an `open*` method, and a URL must never perform a mutation. |

---

## Internal Structure

### `depthChoices.ts`

```ts
export function depthFromChoice(choice: string): number {
    return choice === DEPTH_ALL ? Number.POSITIVE_INFINITY : Number(choice);
}

export function depthChoice(raw: string | undefined): string {
    if (raw === undefined) {
        return String(DEFAULT_DEPTH);
    }

    if (raw.toLowerCase() === DEPTH_ALL.toLowerCase()) {
        return DEPTH_ALL;
    }

    return DEPTH_CHOICES.includes(raw) ? raw : String(DEFAULT_DEPTH);
}
```

### `diagramShell.ts` — seeding the Depth control

Pre-`super()`, beside the other control locals:

```ts
const initialDepth = depthChoice(config.initialDepth);
const depthControl = ComboBox({ items: DEPTH_CHOICES, value: initialDepth });
```

Post-`super()`, beside the other field assignments:

```ts
this.depthIndex = DEPTH_CHOICES.indexOf(initialDepth);
```

The `private depthIndex = DEPTH_CHOICES.indexOf(String(DEFAULT_DEPTH));` field initializer stays as the declaration's default; a class field initializer runs immediately after `super()` returns and before the rest of the constructor body, so this assignment lands on top of it. `depthChoice` guarantees `indexOf` finds the value, so `depthIndex` is never `-1`.

### The two rooted panels — building the base graph at the requested depth

Each builds its pre-`super()` base with a hardcoded `DEFAULT_DEPTH` today ([`RelationDiagramPanel.ts:73`](frontend/src/dock/RelationDiagramPanel.ts#L73), [`RootedRelationGraphPanel.ts:56`](frontend/src/dock/RootedRelationGraphPanel.ts#L56)). That line becomes two:

```ts
const depth = depthChoice(initialDepth);
const base  = withDepthBadges(rootedDiagram(full, root, "both", depthFromChoice(depth)), full.edges, "both");
```

and pass `initialDepth: depth` in the config bag they hand `super()`. `depthChoice` is idempotent, so normalizing here and again inside `DiagramShell` yields the same entry.

### `recordNavigation.ts` — finding a record by its key

```ts
export function findRecordByKey<T extends KeyedRecord>(records: T[], key: string): T | undefined {
    return records.find(record => {
        const id = record.getId();

        return id !== undefined && id !== null && String(id) === key;
    });
}
```

### `TableWorkPanel` — the two view options

The `recordToggle` local, built pre-`super()`, seeds its state from the request:

```ts
const recordToggle = glyphToggleButton("table-list", PRIMARY_COLOR, "Record view (one record as field/value rows)", view?.rotated === true);
```

Post-`super()`, as the last block of the constructor (after the existing listener wiring, so the two sync calls act on the final state):

```ts
if (view?.rotated === true) {
    this.dataGrid.setDisplayMode("rotated");
    this.syncAddEnabled();
    this.syncStepEnabled();
}

if (view?.record !== undefined && view.record !== "") {
    this.focusRecord(view.record);
}
```

```ts
/**
 * Select the record whose primary key is `key` once the store's first page
 * arrives, then stop listening — a later Refresh must not re-target the grid
 * behind the user. Reports through `notify` when no loaded record matches,
 * which is what a record outside the first page looks like from here.
 *
 * @param key - The primary-key value from the route's `record` parameter.
 */
private focusRecord(key: string): void {
    const onLoad = (): void => {
        this.store.off("load", onLoad);

        const target = findRecordByKey(this.store.getRecords(), key);

        if (!target) {
            this.notify(`no loaded record has key ${key}`);

            return;
        }

        this.dataGrid.selectRecord(target);
    };

    this.store.on("load", onLoad);
}
```

`openTable` constructs the panel before calling `void store.load()` ([`SqlAdminController.ts:483-488`](frontend/src/SqlAdminController.ts#L483)), so the listener is always registered before the first load fires. That ordering is load-bearing: reversing it would drop the focus request silently.

### `appRouter.ts` — the dispatch guard and the handler shape

```ts
/**
 * Run a route handler's body, reporting anything it throws or rejects with.
 * A route must never reject into SqlAdminApp's boot catch.
 */
function dispatch(controller: SqlAdminController, open: () => void | Promise<void>): void {
    try {
        void Promise.resolve(open()).catch((error: unknown) => controller.notifyError(error));
    } catch (error) {
        controller.notifyError(error);
    }
}

/** Report a URL this app has no view for, leaving the start page as it is. */
function reportUnknownLink(controller: SqlAdminController, path: string): void {
    controller.notifyError(new Error(`no view matches the link path "${path}"`));
}

/** A relation ref in the session's database, from a route's path params. */
function relationRef(controller: SqlAdminController, kind: RelationKind, schema: string, name: string): DbObjectRef {
    return { connectionId: controller.connectionId, database: controller.database, schema, name, kind };
}
```

One registered pair, as the template for the rest — nested under `/schema/:schema/` per the "Schema-scoped objects nest under their schema in the path" Architecture Decision:

```ts
for (const { segment, kind } of RELATION_KINDS) {
    router.register(`/schema/:schema/${segment}/:name`, (params, _path, _fragment, query) => dispatch(controller, () =>
        controller.openTable(relationRef(controller, kind, params.schema, params.name), undefined, {
            rotated: routeFlag(query.rotated),
            record:  query.record,
        })));

    router.register(`/schema/:schema/${segment}/:name/:view`, (params, path, _fragment, query) => dispatch(controller, () => {
        const view = relationView(kind, params.view);

        if (view === null) {
            reportUnknownLink(controller, path);

            return;
        }

        const ref = relationRef(controller, kind, params.schema, params.name);

        switch (view) {
            case "structure":    return controller.openStructure(ref);
            case "definition":   return controller.openDefinition(ref);
            case "diagram":      return controller.openRelationDiagram(ref, undefined, query.depth);
            case "dependencies": return controller.openRelationDependencyGraph(ref, undefined, query.depth);
            case "inheritance":  return controller.openRelationInheritanceGraph(ref, undefined, query.depth);
        }
    }));
}
```

The role loop follows the identical shape, registering `` `/role/${bucket}/:role` `` and `` `/role/${bucket}/:role/:view` `` per `ROLE_BUCKETS` entry; the function route is the one registration in `## The route table` above, reading `signature` off `query.signature ?? ""` instead of a second pattern.

`tsconfig.json` sets `noUnusedParameters`, so every handler parameter it does not read is `_`-prefixed (`_path`, `_fragment`), and `verbatimModuleSyntax` means `RouteParams` / `RouteQuery` come in through `import type`.

---

## Ordered Implementation Steps

1. **Check the library dependency, then baseline.** Run `grep -rn "getQuery" frontend/node_modules/@jimka/typescript-ui/dist/lib/types/router/` — it must find `getQuery`. If it does not, stop and get the library half in place first: build the branch implementing `typescript-ui/plans/router-query-string-support.md` with `npm run clean && npm run build:lib` in `packages/lib`, and point `frontend/node_modules/@jimka/typescript-ui` at `../typescript-ui/packages/lib` as a symlink. Then record the baseline: `cd frontend && npm run typecheck` and `npm test`.

2. **Create `frontend/tests/dock/depthChoices.test.ts`** with the `depthFromChoice` and `depthChoice` cases from `## Expected Behaviour`. Red — the module does not exist.

3. **Create `frontend/src/dock/depthChoices.ts`.** Move `DEPTH_ALL`, `DEPTH_CHOICES`, `DEFAULT_DEPTH`, and `depthFromChoice` out of [`diagramShell.ts:38-65`](frontend/src/dock/diagramShell.ts#L38) verbatim (JSDoc included), add `depthChoice` per `## Internal Structure`, and head the file with a comment saying it is the DOM-free depth vocabulary kept out of `diagramShell.ts` so it can be unit-tested under the node harness — mirroring `recordNavigation.ts`'s own header. Check: `npx vitest run tests/dock/depthChoices.test.ts` green.

4. **`frontend/src/dock/diagramShell.ts`.** Delete the four moved declarations and add `import { DEPTH_CHOICES, DEFAULT_DEPTH, depthChoice, depthFromChoice } from "./depthChoices";` — exactly those four, since `DEPTH_ALL` is no longer named in this file and `noUnusedLocals` would reject it. Add `initialDepth?: string` to `DiagramShellSlots`. Seed `depthControl` and `this.depthIndex` per `## Internal Structure`. Update the header comment's "the shell owns … the depth vocabulary (DEPTH_CHOICES, the All sentinel, depthFromChoice)" clause — the shell now owns the *control*, `depthChoices.ts` owns the vocabulary. Check: `grep -n "export const DEPTH\|export function depthFromChoice" frontend/src/dock/diagramShell.ts` — zero matches.

5. **`frontend/src/dock/RelationDiagramPanel.ts`.** Narrow the `./diagramShell` import to `{ DiagramShell, legendRow }` and add `import { depthChoice, depthFromChoice } from "./depthChoices";` — `DEFAULT_DEPTH` is no longer named here, and `noUnusedLocals` would reject it if it were left in. Add the 5th `initialDepth?: string` parameter with a JSDoc `@param`, build `base` at the requested depth, and pass `initialDepth` in the `DiagramShellConfig`.

6. **`frontend/src/dock/RootedRelationGraphPanel.ts`.** The same three changes; its `super({ view, fixedRoot: true, root: root.id })` call gains `initialDepth`.

7. **`frontend/tests/dock/recordNavigation.test.ts`.** Add a `describe("findRecordByKey")` block with the cases from `## Expected Behaviour`, using a `keyed(id)` stand-in beside the file's existing `record(data)` helper. Red.

8. **`frontend/src/dock/recordNavigation.ts`.** Add `KeyedRecord` and `findRecordByKey` per `## Public API` / `## Internal Structure`, and widen the header comment — the module is no longer only the stepper's logic. Green.

9. **`frontend/src/dock/TableWorkPanel.ts`.** Export `TableViewOptions`; add the 6th constructor parameter; seed `recordToggle`; add the post-`super()` block and the `focusRecord` method per `## Internal Structure`; import `findRecordByKey` alongside the existing `stepIndex, visibleRecords`. Extend the file header's record-view paragraph to say the panel can open rotated and focused on a requested record.

10. **Create `frontend/tests/shell/routeTargets.test.ts`** with every `## Expected Behaviour` case for `RELATION_KINDS`, `ROLE_BUCKETS`, `relationView`, `schemaView`, `roleView`, and `routeFlag`. Red.

11. **Create `frontend/src/shell/routeTargets.ts`** per `## Public API`. Import only `import type { DbObjectKind } from "../contract";`. Head it with a comment saying it holds the URL vocabulary, kept free of library imports so the node harness can load it. `ROLE_BUCKETS`/`RoleBucket` need no additional import — like `RELATION_KINDS`, the constant is its own vocabulary. Green.

12. **`frontend/src/SqlAdminController.ts`.** Five signature changes, each additive:
    - `openTable` ([line 433](frontend/src/SqlAdminController.ts#L433)) — add `view?: TableViewOptions` and pass it as `TableWorkPanel`'s 6th argument ([line 483](frontend/src/SqlAdminController.ts#L483)). Import the type from `./dock/TableWorkPanel`. Document in the method's JSDoc that `view` is ignored on the view/matview branch, which opens a query tab.
    - `openRelationDiagram` ([line 1873](frontend/src/SqlAdminController.ts#L1873)) — add `depth?: string`, pass as `RelationDiagramPanel`'s 5th argument.
    - `openRelationDependencyGraph` ([line 2026](frontend/src/SqlAdminController.ts#L2026)) and `openRelationInheritanceGraph` ([line 2140](frontend/src/SqlAdminController.ts#L2140)) — the same, on `RootedRelationGraphPanel`.
    - `openRoleMembershipDiagram` ([line 2857](frontend/src/SqlAdminController.ts#L2857)) — add `depth?: string`; its `RelationDiagramPanel(full, root, cb)` call gains an explicit `undefined` for `onContextMenu` before `depth`.
    Each new parameter gets a JSDoc `@param` saying it is a `DEPTH_CHOICES` entry and that anything else opens at the default.

13. **Create `frontend/src/shell/appRouter.ts`** per `## Public API`, `## The route table`, and `## Internal Structure`. Register `/` first with an empty handler and a comment saying it exists so an ordinary visit to the site root is not reported as an unknown link. Wire `nomatch` through `RouterOptions.listeners`. Nest every schema-scoped object route under `/schema/:schema/`, registering the relation pair from `RELATION_KINDS` and the role pair from `ROLE_BUCKETS` by the identical technique — two loops over two exported constants. Collapse the function route into the single `/schema/:schema/function/:name` registration, reading `signature` off the query (`query.signature ?? ""`) instead of a second pattern.

14. **`frontend/src/SqlAdminApp.ts`.** Import `buildAppRouter`; construct the router after the controller; call `router.start()` after `Body.getInstance().addComponent(...)`. Carry the docs app's reason in a comment: `start()` applies the current route synchronously, so it belongs after the tree is built and before the first layout pass. Extend the file's header comment to mention the router.

15. **Regression checks.** `grep -rn "DEFAULT_DEPTH\|DEPTH_CHOICES" frontend/src/` — every hit imports from `./depthChoices` (or is inside it). `grep -rn "router\.navigate(\|\.getHref(" frontend/src/` — zero matches (a call-site check, not a bare-mention one: `appRouter.ts`'s own header comment names both symbols while explaining the invariant, which a plain-substring grep would misreport as a hit); this pass never writes a URL. `grep -c "router.register(" frontend/src/shell/appRouter.ts` — 11 literal calls, which register 19 routes at run time (the relation pair runs once per `RELATION_KINDS` entry, three times; the role pair runs once per `ROLE_BUCKETS` entry, three times; the remaining seven literal calls — `/`, `/notes`, `/database/diagram`, `/schema/:schema/:view`, `/schema/:schema/sequence/:name`, `/schema/:schema/index/:name`, `/schema/:schema/function/:name` — each register exactly once).

16. **`README.md` and `TODO.md`** per `## Documentation Impact`.

17. **Verification** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/depthChoices.ts` |
| Create | `frontend/src/shell/routeTargets.ts` |
| Create | `frontend/src/shell/appRouter.ts` |
| Create | `frontend/tests/dock/depthChoices.test.ts` |
| Create | `frontend/tests/shell/routeTargets.test.ts` |
| Modify | `frontend/src/SqlAdminApp.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/dock/diagramShell.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/dock/RootedRelationGraphPanel.ts` |
| Modify | `frontend/src/dock/recordNavigation.ts` |
| Modify | `frontend/src/dock/TableWorkPanel.ts` |
| Modify | `frontend/tests/dock/recordNavigation.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### `depthChoice` — *unit* (`tests/dock/depthChoices.test.ts`)

| Input | Result |
|---|---|
| `undefined` | `"1"` |
| `""` | `"1"` |
| `"1"` / `"2"` / `"3"` | itself |
| `"All"` | `"All"` |
| `"all"` / `"ALL"` | `"All"` |
| `"0"` / `"4"` / `"-1"` / `"deep"` | `"1"` |
| `depthChoice(depthChoice("all"))` | `"All"` — idempotent |

### `depthFromChoice` — *unit*

| Input | Result |
|---|---|
| `"1"` | `1` |
| `"3"` | `3` |
| `"All"` | `Number.POSITIVE_INFINITY` |

### `findRecordByKey` — *unit* (`tests/dock/recordNavigation.test.ts`)

| Records' ids | `key` | Result |
|---|---|---|
| `[1, 2, 3]` | `"2"` | the record with id `2` |
| `["a", "b"]` | `"b"` | the record with id `"b"` |
| `[1, 2]` | `"9"` | `undefined` |
| `[1, 1]` | `"1"` | the **first** record |
| `[undefined]` | `"undefined"` | `undefined` — a record with no primary key never matches |
| `[null]` | `"null"` | `undefined` |
| `[]` | `"1"` | `undefined` |
| `[1]` | `""` | `undefined` |

### `routeFlag` — *unit* (`tests/shell/routeTargets.test.ts`)

| Input | Result |
|---|---|
| `undefined` | `false` |
| `""` | `true` — a bare `?rotated` parses to an empty value |
| `"true"` / `"TRUE"` / `"True"` | `true` |
| `"1"` | `true` |
| `"false"` / `"0"` / `"yes"` | `false` |

### `relationView`, `schemaView`, `roleView`, `RELATION_KINDS`, `ROLE_BUCKETS` — *unit*

| Call | Result |
|---|---|
| `relationView("table", "structure")` | `"structure"` |
| `relationView("table", "definition")` | `null` |
| `relationView("view", "definition")` | `"definition"` |
| `relationView("materializedView", "definition")` | `"definition"` |
| `relationView("table", "inheritance")` | `"inheritance"` |
| `relationView("view", "inheritance")` | `null` |
| `relationView("materializedView", "diagram")` | `"diagram"` |
| `relationView("table", "bogus")` / `relationView("table", "")` | `null` |
| `schemaView("dependencies")` | `"dependencies"` |
| `schemaView("structure")` / `schemaView("")` | `null` |
| `roleView("membership")` | `"membership"` |
| `roleView("grants-diagram")` | `"grants-diagram"` |
| `roleView("grants")` | `null` — the bare `/role/{user,group,predefined}/:role` is the grants tab |
| `RELATION_KINDS` | exactly three entries: `table`→`table`, `view`→`view`, `matview`→`materializedView` |
| `ROLE_BUCKETS` | exactly three entries, in order: `"user"`, `"group"`, `"predefined"` — `RolesTree`'s own Users/Groups/Predefined order |

### Manual verification (routing, DOM, and network — outside the node harness)

Run against the seeded demo database (`db/init/*.sql`). `sales.invoices` (single-column primary key `id`, one foreign key to `public.orders`) stands in for the generic "a table" case; `sales.order_items` and `hr.employees` (self-referencing `manager_id`) exercise the FK-diagram depth control; `sales.price_with_tax(p_price numeric)` / `(p_price numeric, p_rate numeric)` is the seeded overloaded routine; `analyst` (Users), `readonly` (Groups), and `pg_monitor` (Predefined) are real examples of the three role buckets.

1. **Already signed in, deep link.** With a live session, load `/schema/sales/table/invoices`. The data tab opens; the start page is replaced; the URL still reads `/schema/sales/table/invoices`.
2. **Signed out, deep link.** Sign out, then load `/schema/sales/table/invoices`. The login dialog appears first; after signing in, the data tab opens — the URL survived the login round-trip untouched.
3. **Record view.** Load `/schema/sales/table/invoices?rotated=true&record=2`. The tab opens in record view with the toggle already lit, showing record `2` (`document_no 2`, `net 35.50`, …), Add disabled, and Previous/Next both enabled.
4. **Record outside the first page.** Load `/schema/sales/table/invoices?rotated=true&record=999999`. The tab still opens in record view, and the status line reads `… no loaded record has key 999999`.
5. **Focused record, grid mode.** Load `/schema/sales/table/invoices?record=3`. The grid opens normally with row `3` selected and highlighted.
6. **Diagram depth.** Load `/schema/hr/table/employees/diagram?depth=2`. The FK diagram opens with the Depth control reading `2`. `/schema/hr/table/employees/diagram?depth=all` opens with the control reading `All`; `?depth=banana` opens at `1` (the default). The control genuinely reflects the requested value in every case; this "relations" panel does not cross schema boundaries, and the seeded schemas are shallow enough within one schema that depth 1 vs. 2 does not always add a visibly new node for every table, so the check here is the control's value, not a node count.
7. **Schema and role views.** `/schema/sales/diagram`, `/schema/sales/dependencies`, `/schema/sales/inheritance`, `/database/diagram`, and `/notes` each open their tab. `/role/user/analyst` opens analyst's grants tab; `/role/user/analyst/grants-diagram` opens its grants graph; `/role/group/readonly/membership?depth=2` opens its membership graph with Depth reading `2`.
8. **A role route's bucket is not validated.** Load `/role/group/analyst` (`analyst` is actually a Users-bucket role) and `/role/predefined/readonly` (`readonly` is actually a Groups-bucket role). Both open the named role's grants tab exactly as the correctly-bucketed URL would — confirming the bucket segment is decorative at consume time, per the Architecture Decision.
9. **Detail tabs.** `/schema/sales/table/invoices/structure`, `/schema/sales/view/order_summary/definition`, `/schema/sales/sequence/document_number_seq`, and `/schema/sales/index/invoices_pkey` each open their tab.
10. **Overloaded function, disambiguated by query.** `/schema/sales/function/price_with_tax` (no `signature`) fails, the same as any object absent from the database — no zero-argument overload exists, matching the query's `signature: ""` fallback. `/schema/sales/function/price_with_tax?signature=p_price%20numeric` opens the tab titled `price_with_tax(p_price numeric) (definition)`, showing the single-argument overload's body — the query parameter correctly disambiguates.
11. **Unknown path.** Load `/nope/at/all`. An error toast reads `no view matches the link path "/nope/at/all"`, the start page stays, and no tab opens.
12. **View segment invalid for the kind.** Load `/schema/sales/table/invoices/definition`. The same "no view matches" toast; no tab opens.
13. **Object missing from this database.** Load `/schema/sales/table/does_not_exist`. The tab opens and stays open showing an empty grid; an error toast names the failure (`Table 'sales.does_not_exist' not found`). `openTable` *does* use the deferred `openAsyncPanel` pattern like every other tab ([`SqlAdminController.ts:461`](frontend/src/SqlAdminController.ts#L461)) — a throw inside its builder callback would close the tab, per the callback's own comment at `:468-469` — but the builder does not throw here: `fetchColumns`/`getTablePrivileges` ([`:474`](frontend/src/SqlAdminController.ts#L474)) resolve for a nonexistent table rather than rejecting (the backend's `columns` route returns an empty list, not a 404 — [`backend/app/main.py:395-413`](backend/app/main.py#L395)), so the panel is built and the tab opens normally. The 404 only surfaces afterwards, from the separate, un-awaited `store.load()` call ([`:493`](frontend/src/SqlAdminController.ts#L493)), which is caught by the store's own `"exception"` listener ([`:478`](frontend/src/SqlAdminController.ts#L478)) rather than the Dock's deferred-panel exception handler — so nothing closes the tab. Both mechanisms are pre-existing controller behaviour, not part of the route table itself.
14. **Site root.** Load `/`. The start page shows and **no** toast appears.
15. **Boot survives every failure.** In cases 11-13 the app is fully usable afterwards: the navigator loads, the menus work, tabs open by clicking.
16. **The URL does not follow in-app navigation.** After case 1, double-click another table in the navigator. The URL still reads `/schema/sales/table/invoices` — this pass never writes the URL.
17. **Sign out and back in.** From a deep-linked view, sign out (which reloads the current URL, landing on the login dialog with the deep-linked path still in the address bar) and sign back in: the same view opens again.
18. **Production serving.** Not re-run live (would need a Docker rebuild against no code change: `git diff` against `main` touches zero files under `backend/`). `backend/app/static.py`'s `spa_index` catch-all matches `/{full_path:path}` regardless of segment count, so the deeper nested URLs here (up to five segments, e.g. `/schema/sales/table/customers/diagram`) resolve through the same mechanism already verified live — see [^history-not-hash].

---

## Verification

- `cd frontend && npm run typecheck` — clean against the step-1 baseline. Every changed constructor and controller method gained only trailing optional parameters, so existing call sites — including `objectMenu.ts`'s `Pick<SqlAdminController, …>` action bundle and its test stub — keep compiling.
- `cd frontend && npm test` — the two new suites and the extended `recordNavigation.test.ts` green, the rest unchanged.
- `cd frontend && npm run build` — `tsc --noEmit` plus a production Vite build.
- `grep -rn "router\.navigate(\|\.getHref(" frontend/src/` — zero matches (see step 15's note on why the grep targets a call, not a bare mention).
- `grep -rn "DEFAULT_DEPTH\|DEPTH_CHOICES" frontend/src/` — no hit imports from `./diagramShell`.
- `grep -c "router.register(" frontend/src/shell/appRouter.ts` — 11 literal calls, registering 19 routes at run time (see `## Ordered Implementation Steps`, step 15, for the full accounting).
- Manual cases 1-18 above. Entry point: `npm run dev` in `frontend` with the backend running, then type each URL into the address bar and reload (a reload, not an in-page click — the route is read at boot).

---

## Documentation Impact

- **`README.md`** — the **Deep links** bullet under `## Highlights`, after **Object navigator**, gives `/schema/<schema>/table/<table>`, `/schema/<schema>/table/<table>/structure`, `/schema/<schema>/diagram`, and `/role/user/<role>/membership` as examples, and says that an unauthenticated visitor is prompted to sign in first and then lands on the requested view. Links are read on load only — the address bar does not follow in-app navigation yet.
- **`TODO.md`** — the **Shareable link UI** bullet under `## Backlog (no plan yet)` → `### Connections / platform`, added when this plan first shipped, needs no further edit for this revision: it names a "Copy link" action and address-bar sync as the follow-up, with no concrete URL example to update. Verified by reading the bullet, not assumed.
- **`CHANGELOG.md`** — no entry; changelog text is written at release time, not in feature work (established by `plans/implemented/table-local-filter.md`).
- **`frontend/COMPONENT_CONVENTIONS.md`** — no change. The new modules are plain functions, not components.
- **`frontend/package.json`** — the `@jimka/typescript-ui` dependency must move to the first released version that carries the router's query-string support. `^0.5.0` accepts `>=0.5.0 <0.6.0`, so a `0.6.x` publish needs the range bumped; until then the symlink override from step 1 is what the app builds against.

---

## Potential Challenges

- **The library half is not released.** Step 1 is a hard gate: without `getQuery` in the installed package, the fourth handler argument does not exist and nothing here typechecks. Verify against the symlinked local build first, and bump `frontend/package.json` when the library ships.
- **`noUnusedParameters` bites every route handler.** Handlers take four positional arguments and most read one or two; the unread ones must be `_path` / `_fragment`, or `npm run typecheck` fails.
- **`RouteQuery` is an index signature, so a missing key types as `string` but *is* `undefined`.** `query.depth` on a URL with no query compiles as `string` and arrives as `undefined` at run time (`tsconfig.json` does not set `noUncheckedIndexedAccess`). Both readers already take `string | undefined` — `depthChoice` and `routeFlag` — and `TableViewOptions.record` is optional, so the trap is only in adding a new reader that assumes a value is there.
- **`depthIndex` is assigned twice.** Its field initializer runs right after `super()` and the constructor body then overwrites it. Keep the assignment in the constructor body *after* `super()`, not as a changed initializer — the initializer cannot see `config`.
- **A composite primary key resolves to its first column.** `buildModel` sets `primaryKey: columns.find(c => c.isPrimaryKey)?.name` ([`buildModel.ts:31`](frontend/src/data/buildModel.ts#L31)), so `getId()` already returns one column's value app-wide. `?record=` inherits that: on a composite-key table it selects the first row whose leading key column matches. Pre-existing, not introduced here.
- **The one-shot load listener survives a failed first load.** If the initial `store.load()` rejects, `"load"` never fires and the listener stays armed, so a later Refresh applies the focus instead. That is the useful outcome, not a leak — the listener dies with the panel either way.
- **The navigator is still loading when the route is applied.** `NavigatorTree`'s constructor kicks off an async `refresh()` ([`NavigatorTree.ts:205`](frontend/src/navigator/NavigatorTree.ts#L205)), so a deep-linked tab opens with no navigator selection. Expected — see the `openReferenced*` decision.
- **Back / forward after a manual URL edit.** The app creates no history entries, so `popstate` only fires for entries made outside it. When it does fire, the route re-applies and the `open*` methods' panel-id dedup focuses the already-open tab rather than duplicating it.
- **Percent-encoding in path segments and query values.** The `Router` encodes and decodes each path segment, so a schema or table name containing a space or `/` round-trips. `signature` is a query value, not a path segment, but needs the same care: a hand-written link to an overloaded routine must percent-encode it (`?signature=p_customer_id%20integer`).

---

## Critical Files

| File | Why |
|---|---|
| `typescript-ui/plans/router-query-string-support.md` (sibling repo) | The producer half. Fixes `RouteHandler`'s fourth `query` argument, `getQuery`, and the identity-in-path / view-mode-in-query split this plan consumes. Read its `## Public API` before writing `appRouter.ts`. |
| `typescript-ui/packages/docs/src/main.ts` (sibling repo) | The only existing real-world consumer of this `Router`: construct → register → mount → `start()`, with the comment explaining why `start()` comes after the tree is built and before the first layout pass. `appRouter.ts` and `SqlAdminApp.ts` mirror it. |
| `typescript-ui/packages/lib/src/typescript/lib/router/RoutePattern.ts` (sibling repo) | `matchPattern`'s exact-segment-count rule and `selectPattern`/`isMoreSpecific`'s static-outranks-param tie-break are what the "Schema-scoped objects nest under their schema in the path" Architecture Decision's no-new-ambiguity claim and the route table's "Pattern selection" paragraph rest on. Read before asserting either. |
| [`frontend/src/roles/RolesTree.ts`](frontend/src/roles/RolesTree.ts) / [`frontend/src/roles/groupRoles.ts`](frontend/src/roles/groupRoles.ts) | The Users/Groups/Predefined navigator sections `ROLE_BUCKETS` mirrors, and the `canLogin` / `pg_`-prefix classification rule a role route's bucket segment deliberately does not check. |
| [`frontend/src/SqlAdminApp.ts`](frontend/src/SqlAdminApp.ts) | The boot sequence the router slots into, and the `catch` a route must never reach. |
| [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) | Every route target. `openAsyncPanel` (3146) and the Dock `"exception"` handler (340) are what make a missing object degrade to a toast; `notifyError` (3015) is the one error surface; `panelId` (3028) is why re-applying a route focuses rather than duplicates. |
| [`frontend/src/shell/LoginDialog.ts`](frontend/src/shell/LoginDialog.ts) | Confirms the login gate is a pure in-page modal with no URL involvement — the reason deep-link-then-login works with no extra state. |
| [`frontend/src/dock/diagramShell.ts`](frontend/src/dock/diagramShell.ts) | The Depth control, the `depthIndex` field, and the `DiagramShellSlots` bag the two rooted panels fill. Its header states the super-cascade constraint the `initialDepth` seeding must respect. |
| [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) | `toggleRecordView` (283) is the runtime path `rotated` mirrors; `syncAddEnabled` / `syncStepEnabled` (301, 317) are what must be re-run after seeding the mode. |
| [`frontend/src/dock/recordNavigation.ts`](frontend/src/dock/recordNavigation.ts) | The DOM-free-module pattern the two new pure modules follow, and where `findRecordByKey` lands. Its header states why the split exists. |
| [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) | Section (b) — locals before `super()`, fields after — governs both panel changes. |
| [`plans/implemented/panel-refresh-buttons.md`](plans/implemented/panel-refresh-buttons.md) | The structural sibling: one concern threaded uniformly through many `open*` methods, pure logic split into a DOM-free module with its own vitest suite, and DOM behaviour covered by numbered manual cases. This plan follows its shape. |
| [`backend/app/static.py`](backend/app/static.py) | `spa_index` — the catch-all that returns `index.html` for any non-`/api` path, which is what makes History mode viable in production. |

---

## Non-Goals

- **A "Copy link" affordance.** No context-menu item, toolbar button, or menu entry that builds a URL for the focused tab. Consume-only this pass; tracked in `TODO.md`.
- **Keeping the address bar in step with in-app navigation.** No `router.navigate` call exists after this plan, so opening a tab by clicking leaves the URL as loaded.
- **Restoring a whole workspace from one URL.** A URL addresses one view. Multi-tab layout restore is what `LayoutStore` already does per user.
- **Routing ad-hoc or saved query panels.** See the "not route targets" table.
- **Routing a database or connection.** A session connects to exactly one database ([`api.ts:83`](frontend/src/data/api.ts#L83)); the database is read off the session, never off the URL.
- **Revealing or selecting the deep-linked object in the navigator.** The tree's schemas have not loaded when the route is applied.
- **Validating a role route's bucket segment against the role's real classification.** `/role/group/analyst` opens `analyst` exactly as `/role/user/analyst` would, even though `analyst` is actually a Users-bucket role. The roles list has not loaded when the route is applied — the identical limitation as the navigator-reveal non-goal above, against `RolesTree`'s data instead — so there is nothing to validate the bucket against. See the matching Architecture Decision.
- **An initial root or depth on the selectable-root panels** — `SchemaDiagramPanel`, `DatabaseDiagramPanel`, `RelationGraphPanel`, `RoleGrantsDiagramPanel`. They open unrooted, so a depth would have nothing to walk from.
- **Routing `kind: "type"` objects.** Enums and composites have DDL forms but no view tab to open.
- **Any mutating route.** No URL triggers DDL, a write, or a query execution.
- **Changing the library.** `@jimka/typescript-ui` is consumed as published; the query-string work is the sibling repo's plan.

---

## Notes

[^no-navigate]: Generating links is a bigger design question than resolving them — which tab's URL a "Copy link" copies, what it does on a tab with no route (an ad-hoc query panel), and whether opening a tab should push a history entry. Resolving an incoming URL is independently useful and independently testable: it is what makes a URL pasted into a chat message work. Splitting the two also keeps this pass free of `router.navigate`, which is what lets `## Verification` assert `grep -rn "router\.navigate(\|\.getHref(" frontend/src/` finds no call site — a cheap, mechanical guard that the scope line held.

[^library-gated]: `frontend/package.json` depends on `@jimka/typescript-ui@^0.5.0`, and `packages/lib/package.json` in the sibling checkout is at `0.5.0` — neither carries `getQuery` or the fourth `RouteHandler` argument. This project's convention is that a library fix is verified inside SQLAdmin through the `frontend/node_modules/@jimka/typescript-ui` symlink override before the app work counts as done: build the library branch (`npm run clean && npm run build:lib` — a plain `npm run build` is the wrong target, and `emptyOutDir: false` makes `dist/lib` append-only, so the clean is not optional), point the symlink at `../typescript-ui/packages/lib`, and run the manual cases against that. The `package.json` range bump happens when the library actually publishes. The dependency is not expressible as plan frontmatter: `depends-on` resolves against this repo's `plans/implemented/`, and the producer plan lives in another repository.

[^history-not-hash]: Both hosts already do the fallback History mode needs, and this was checked rather than assumed. In production, `backend/app/static.py`'s `spa_index` catches `/{full_path:path}` and returns `index.html` for everything that is not `/api…`, with `/assets` mounted separately ahead of it. In development, Vite 6.4.3 runs `appType: "spa"` by default, which installs `htmlFallbackMiddleware` for unknown non-file paths. `frontend/index.html` references its entry as an absolute `/src/SqlAdminApp.ts` (and, after a build, an absolute `/assets/…` chunk), so a deep path loads the same bundle as the root. That leaves nothing for hash mode to buy: `#/schema/sales/table/…` is uglier, is dropped by some link-handling tools, and would put the route in the one part of the URL the browser never sends to the server. Hash mode would also embed the query inside the hash, which reads worse for exactly the URLs this feature exists to share.

[^start-after-mount]: `start()` applies the matching route synchronously and only then installs its `popstate` listener, so calling it after the component tree exists but before the first layout pass means the routed tab is already opening when that pass runs — no frame of start page followed by a jump. The docs app states this in a comment at its own `router.start()` call. Placing it *after* the shell is constructed matters for a second reason here: `SqlAdminShell` builds the navigator eagerly, and `NavigatorTree`'s constructor calls `controller.setNavigator(this)`, so a handler that touches the navigator finds one registered. Placing it after the login gate is what makes the login flow work at all — but that needs no code, only order: `showLoginDialog()` is awaited before the router is constructed, and the dialog never navigates, so the URL that arrives at `start()` is exactly the one the user pasted.

[^default-tab-rule]: The alternative was an explicit `/data` (and `/grants`) segment, making every route uniformly one segment longer. It was rejected because the shortest, most-shared URL is the common case — a link to a table almost always means "show me this table" — and `/schema/sales/table/customers/data` spends a segment restating the noun. The rule also matches the navigator's own menus, where "Open data" is the double-click default and everything else is a named menu item. The cost is one extra pattern per object family — a four-segment and a five-segment form, both nested under `/schema/:schema/` — which the `RELATION_KINDS` loop absorbs.

[^kind-in-path]: A single `/schema/:schema/:kind/:name` pattern with the kind validated inside the handler — and, by the same logic, a single `/role/:bucket/:name` pattern with the bucket validated inside the handler — was considered and rejected for both. Static segments outrank `:param` segments position by position in the router's specificity rule, so a static-segment form and a `:param` form would coexist safely — but the param form turns `/schema/sales/widget/a` (or `/role/bogus/x`) into a *matched* route whose handler then has to reject it, while static segments make it a genuine `nomatch` handled in one place. Registering them from `RELATION_KINDS` and `ROLE_BUCKETS` keeps each vocabulary in its own pure, unit-tested constant rather than duplicated across six-and-six literal `register` calls, so the URL segments `matview` and `predefined` are each spelled exactly once.

[^record-is-primary-key]: A row index into the loaded page was the other candidate, and it is what "which record" means inside `TableWorkPanel` today (`stepIndex` walks indices). It fails as a *URL*: the store pages 100 rows at a time with `remoteSort` and `remoteFilter` on, so index 7 names a different row after any sort change, and a link sent to someone whose grid is sorted differently lands on the wrong record silently — the worst failure mode for a shareable link. The primary key is already the app's row identity: `buildModel` sets the model's primary key so `record.getId()` resolves, and the write path uses it for `PUT`/`DELETE` URLs. Matching by `String(getId()) === key` rather than `store.getById(key)` avoids a type mismatch — `getById` looks up an index keyed by the raw value, so a numeric key stored as `42` would miss the string `"42"` the URL carries, and the string comparison covers numeric, text, and UUID keys with one rule.

[^no-navigator-reveal]: `Tree.revealByPredicate` walks the tree's current root node set. `NavigatorTree`'s constructor ends with `this.refresh()`, which loads the top-level schemas asynchronously and calls `setNodes` when they arrive — after `router.start()` has already run and returned. So a reveal issued from a route handler always searches an empty tree, returns null, and does nothing. Using `openReferencedTable` anyway would be harmless (it is best-effort by design and the tab still opens) but misleading: it would read as though the deep link reveals the object, which it cannot. Making the reveal work would mean deferring the route until the navigator's first load resolves, which contradicts the synchronous-first-route rule the whole boot ordering rests on. Selecting the deep-linked object in the tree is left as a Non-Goal with this reason attached.

[^query-panels-not-routed]: `openQuery` mints `query-${++this._queryCounter}` per call and deliberately keeps its panels out of `_openPanels` — there is nothing to dedup against and nothing to name in a URL, so `/query/…` would open a fresh panel on every reload. Seeding one from the URL is worse than useless: `?sql=…&run=true` is a link that executes attacker-chosen SQL against whatever database the recipient's session happens to connect to, which is a category of link this app should not be able to produce. `openSavedQuery` looks routable — the name is stable — but `SavedQueryStore` is `localStorage` scoped to user and connection, so the SQL simply is not there for anyone else; the recipient gets a silent no-op, since `openSavedQuery` returns without a message for an unknown name. `TODO.md` already tracks "backend-persisted, shareable saved queries", which is the change that would make a saved-query route mean something.

[^depth-vocabulary-move]: The route layer has to turn `?depth=2` into something a panel can open at, and `DEPTH_CHOICES` is the vocabulary that decides what is valid. Leaving it in `diagramShell.ts` would mean either importing that module from the route layer — it imports `ComboBox`, `Checkbox`, and the library's `Panel` at module scope, so `vitest.config.ts`'s node environment cannot load it — or duplicating the choice list, which is exactly how two spellings of "All" get into one app. This codebase has a settled answer for that shape: `recordNavigation.ts`, `tableWriteRules.ts`, `quickSearchModel.ts`, `columnSequence.ts`, and `structureRows.ts` were each split out of a DOM-touching module so their logic could be unit-tested, and each says so in its header. `depthChoices.ts` is one more. Only three files import the moved symbols, all inside `frontend/src/dock/`, so no re-export shim is warranted.

[^rotated-and-record-orthogonal]: Making `?record=` imply `rotated=true` was considered — a focused single record is the record view's whole purpose. It was rejected because `Table.selectRecord` is meaningful in both modes: in the normal grid it selects the row and scrolls it into view, which is a perfectly good thing for a link to do ("here is the row I mean, in context"), and in the record view it re-targets the displayed record. One call covers both, so an implicit mode switch would remove a useful destination to save the link author four characters. Keeping them independent also keeps the rule statable in one line, which is what the query-parameter table shows.

---

## Implementation Notes

**`focusRecord`'s "not found" message needed a deferred `setTimeout`, not the plain `this.notify(...)` the `## Internal Structure` snippet shows.** Manual verification case 6 (`?rotated=true&record=999999`) initially failed: the record view opened correctly, but the status line read `sqladmin · invoices: 3 rows` instead of `… no loaded record has key 999999`. Root cause: `AbstractStore.load()` (`packages/lib/src/typescript/lib/data/AbstractStore.ts`) emits `"load"` synchronously as the last statement before its own `async` body returns, so every `"load"` listener — including `focusRecord`'s `onLoad`, called via `this.notify(...)` — runs and returns *before* `load()`'s returned promise resolves. `SqlAdminController.openTable`'s `store.load().then(() => this.syncToPanel(id))` can therefore only run afterwards, as a later microtask, and `syncToPanel`'s `updateStatusFor` unconditionally overwrites the status bar with the row count — deterministically clobbering `focusRecord`'s message on every load, not just occasionally. Fixed by wrapping the `notify` call in `setTimeout(fn, 0)`: a macrotask runs only once the whole pending microtask queue (including `syncToPanel`'s chain, whatever its depth) has drained, so the "not found" message is reliably the one still showing once the tab settles. Verified live against the seeded demo database (`sales.invoices`, `?rotated=true&record=999999`) both before (message clobbered) and after (message survives) the fix. This is a defect in the plan's own `## Internal Structure` snippet for `focusRecord`, not a deviation in the surrounding design — `TableWorkPanel.ts`'s `focusRecord` method carries the fix and its reasoning in a comment.
