---
touches-shared:
  - frontend/src/SqlAdminController.ts
  - frontend/src/SqlAdminApp.ts
  - frontend/src/shell/appRouter.ts
  - frontend/src/shell/routeTargets.ts
  - frontend/src/navigator/revealMatch.ts
  - frontend/src/data/queryStore.ts
  - README.md
  - TODO.md
---

# Address Bar Navigation Sync — Implementation Plan

## Overview

`router-deep-linking` made a URL open a view; `navigator-sync-on-open` made that open reveal itself in the sidebar. Neither writes the URL back out: [`appRouter.ts:1-22`](frontend/src/shell/appRouter.ts#L1) still states "nothing here ever calls `router.navigate` or `getHref`", and clicking around the app never touches `location`. This plan adds the missing direction — the address bar follows what is on screen — plus two extensions that make more of the app reachable by URL at all: ad-hoc query panels (previously excluded — see `router-deep-linking`'s "Methods that are deliberately not route targets" table) get a URL keyed by their run history, and a schema or role bucket can be deep-linked as a container, revealing it in the sidebar without opening a tab.

The three parts share one seam. Every route-targetable open records, at open time, the exact URL that reopens it (`frontend/src/shell/routeTargets.ts`'s new `objectPath`/`rolePath`/`databaseDiagramPath`/`notesPath` builders, sharing `RELATION_KINDS`/`ROLE_BUCKETS`/`relationView`/`schemaView` with `appRouter.ts`'s own forward table). [`SqlAdminController.ts:370-377`](frontend/src/SqlAdminController.ts#L370)'s existing `dock.on("focus", ...)` handler — which already resyncs the navigator and status bar on every tab switch — looks that URL up and writes it, using `replace` semantics so switching tabs never floods browser history. A query panel has no such fixed identity (each open mints a fresh `query-N` id), so it is addressed instead by the `timestamp` of its latest recorded run in `QueryHistoryStore` ([`queryStore.ts:21-30`](frontend/src/data/queryStore.ts#L21)) — the same stable-key reasoning `router-deep-linking`'s "A record is addressed by its primary-key value, not by row index" decision already worked through for `?record=`, applied to a second unstable id. The container-level routes (`/schema/:schema`, `/role/user`) are a small, separate addition to the same forward route table, reusing `navigator-sync-on-open`'s reveal machinery (`Tree.revealByPredicate` plus the library's own `Tree.expandNode`) rather than inventing a second one.

**Two places in this plan are inferences beyond what was explicitly asked, flagged so they are easy to correct:** the "database rail" example is read as a bare schema container, `/schema/:schema` with no view segment — not a whole-tree-root `/database` route (see the "The database rail becomes a bare schema route" decision below); and the `predefined` role bucket is given the same container route as `user`/`group` for vocabulary symmetry with `ROLE_BUCKETS` (see "The `predefined` bucket gets the same container route as `user`/`group`" below).

---

## Architecture Decisions

### The sync writes through `getHref` + `DOM.sink.replaceHistoryPath`, never `Router.navigate`

`Router.navigate(path, { replace: true, query })` looks like the obvious call, but it is wrong here: `navigate`'s History-mode branch calls `this.applyCurrentRoute()` unconditionally after *any* successful write, replace included — it only skips that call when the new path/query/fragment exactly equal the current URL ([`Router.ts:217-231`](../typescript-ui/packages/lib/src/typescript/lib/router/Router.ts#L217)). A genuine tab switch is exactly the case where the URL *changes*, so `navigate` would re-run the newly-synced route's own handler on every switch — for most routes a harmless no-op (`dock.focusPanel(id)` in every `open*` method already short-circuits a re-open), but for a query panel it is not: `openQuery` never dedupes ([`SqlAdminController.ts:2400-2437`](frontend/src/SqlAdminController.ts#L2400)), so re-dispatching `/query/history/:timestamp` on every focus of that same tab would mint and auto-run a second, duplicate query panel every time.[^navigate-vs-write]

The sync hook instead calls `router.getHref(path, query)` — pure formatting, no dispatch — and writes the result with `DOM.sink.replaceHistoryPath(href)`, the exact primitive `navigate`'s replace branch itself calls ([`DOM.ts:1760-1762`](../typescript-ui/packages/lib/src/typescript/lib/core/DOM.ts#L1760)). This is not a library workaround: `navigate`'s "go there and run the handler" contract is correct for a future manual link click; syncing is a different operation — "record where I already am" — that the library does not need to special-case for one caller.

### The controller stays router-agnostic; the shell wires a callback

`SqlAdminController.ts` has never imported `@jimka/typescript-ui/router` — `appRouter.ts` was written as the one and only place `Router` is touched, and the controller reaches the shell only through injected function hooks (`setShowDatabaseView`, `setShowQueriesView`, …, [`SqlAdminController.ts:2739-2761`](frontend/src/SqlAdminController.ts#L2739)). The address-bar sync follows the same shape: a new `setSyncAddressBar(sync)` hook, wired from [`SqlAdminApp.ts:31-33`](frontend/src/SqlAdminApp.ts#L31) (the one place both `controller` and `router` already exist), keeps `Router` entirely out of the controller.

### A per-panel route registry, filled once at open time — not live-tracked state

Every `open*` call that reaches `openAsyncPanel` already knows everything needed to build its own reopen URL (its `ref`, which view it is, and any `depth`/`rotated`/`record`/`signature` it was opened with). `openAsyncPanel` gains one optional `route?: PanelRoute` field on its `spec`, and — right before it calls `dock.addLazyPanel` — stashes it into a new `_panelRoutes: Map<string, PanelRoute>`, keyed by panel id. The dock's `"focus"` handler reads it back out; `"close"` deletes it.

This snapshot is taken once, at open time, and never updated. Toggling a table's record view, stepping to a different record, or dragging a diagram's Depth control afterward does **not** update the synced URL — none of those already fire any event the controller observes, and adding one for each just to keep four query parameters perfectly live is a large addition for a case `router-deep-linking` itself already treats as a one-time open-time option, not live state.[^open-time-snapshot] Refocusing the tab (closing and reopening it, or switching away and back) does not re-snapshot it either — the entry lives for the tab's whole open lifetime.

### The reverse URL builders live beside the forward vocabulary, reusing it directly

`frontend/src/shell/routeTargets.ts` already holds `RELATION_KINDS`, `ROLE_BUCKETS`, `relationView`, `schemaView`, `roleView` — the vocabulary `appRouter.ts`'s forward table is built from. The new `objectPath(ref, view?)` and `rolePath(role, view?)` builders (below) look a kind up in `RELATION_KINDS` to find its path segment, and validate a requested view through the *same* `relationView`/`schemaView` functions the forward direction already uses — one vocabulary, read both ways, instead of a second list that can drift.

A single generic `{pattern, paramsToRef, refToParams}` table — replacing `appRouter.ts`'s eleven hand-written `router.register` calls with one data-driven loop that also drives the reverse direction — was considered and rejected. No existing part of this codebase builds URL patterns generically (`appRouter.ts` itself is eleven literal, readable `register` calls, not a table interpreter), and rewriting a file that eighteen manual-verification cases already cover, for a benefit that is mostly line-count, is a bigger risk than the duplication it would remove. Sharing the *vocabulary constants* is the smaller, precedented move; the *route table* (which pattern exists at all) stays hand-written in `appRouter.ts` alone.

### A role's synced URL always uses the `user` bucket segment

`router-deep-linking`'s own Architecture Decision already made a role route's bucket segment decorative — `/role/group/analyst` opens `analyst` exactly like `/role/user/analyst` would, because the roles list has not loaded at route-apply time to validate against. Building a reopen URL hits the same wall from the other side: nothing the controller holds at focus time carries a role's `canLogin`/`pg_`-prefix classification (`RolesTree`'s leaf `data` is the bare name string — see `groupRoles.ts`), so there is nothing to classify against without a fresh, un-cached fetch. `rolePath` always emits `/role/user/<name>`; since the bucket is unvalidated on the way in, this always reopens the correct role regardless of which bucket it actually belongs to.

### A view/matview's data tab is not given a `_panelRoutes` entry

`openTable`'s view/matview branch ([`SqlAdminController.ts:462-470`](frontend/src/SqlAdminController.ts#L462)) opens a fresh, auto-run `query-N` browse panel through `openQuery`, before reaching the `panelId`/`dock.focusPanel`/`openAsyncPanel` code the rest of this plan hooks. It is deliberately left alone: giving that panel a `_panelRoutes` entry pointing back at `/schema/:schema/view/:name` would go stale the moment the user edits the SQL and reruns it (a routine action — the panel is an ordinary editable query buffer once open), leaving a URL that claims to reopen "the view's default browse" but actually reopens something else. Letting it fall through to the query-history mechanism (below) instead means the synced URL always matches the SQL currently in the tab, however it has been edited.

### Query-history links replay the run behind an opaque local key, and auto-run it

`router-deep-linking` rejected seeding+auto-running SQL from a URL because the SQL was attacker-controlled — anyone could hand a victim `?sql=DROP TABLE …&run=true`. `/query/history/:timestamp` carries no SQL at all, only an opaque key into the *local* `QueryHistoryStore`; resolving it can only replay a statement this browser has already executed. An attacker who somehow learns a valid timestamp gains nothing new — the worst case is nudging a user to re-run a query they already ran themselves. That collapses the original risk to something categorically smaller, so the same "seed and auto-run" shape `router-deep-linking` rejected for arbitrary SQL is safe to use here: the route calls `controller.openQuery(entry.sql, true)`, matching the tab's own live state (a `HistoryEntry` only exists because that SQL already ran) and matching `openQueryFor`'s existing auto-run precedent for "open this as a query."[^history-not-preview]

`HistoryEntry` does not record whether the original run was a plain execution or an `EXPLAIN`, so a revisit always re-runs plainly even if the original was an `EXPLAIN ANALYZE`. Pre-existing data-shape limitation, not something this plan changes.

### `timestamp` is the stable key, exactly as `router-deep-linking` reasoned through for `?record=`

A `HistoryEntry`'s position in `QueryHistoryStore.list()` shifts on every new run (it moves to the head) and on eviction past the 100-entry cap — the same instability `router-deep-linking`'s "A record is addressed by its primary-key value, not by row index" decision rejected a row index over. `timestamp` (`Date.now()` at the run, [`queryStore.ts:25`](frontend/src/data/queryStore.ts#L25)) is stable across both: a lookup by timestamp still finds the right entry after ten more runs have happened elsewhere. The new `findHistoryEntry(entries, rawTimestamp)` matches `String(e.timestamp) === rawTimestamp`, mirroring `findRecordByKey`'s `String(id) === key` comparison exactly (`recordNavigation.ts`) — the same reasoning, the same shape, applied to a second unstable-index problem.

### `openSavedQuery` gets no route of its own — it is already covered

A saved query, once run, goes through the identical `openQuery` → `onRun` → history-recording path every other query panel does — nothing distinguishes it once open. The moment a saved query is executed it already has a resolvable `timestamp`, so `/query/history/:timestamp` already reopens it; adding a second, name-keyed `/query/saved/:name` route would give one open tab two different "canonical" URLs and a precedence rule between them to invent and document. An unrun saved query (opened with the default `run: false`) has no timestamp yet, so it falls to the same `/` fallback as a brand-new scratch buffer — consistent, not a gap.

### A tab with no resolvable route falls back to `/`

One rule covers every non-routable case: the dock is empty, the focused tab is a query panel that has never run (or whose last-recorded timestamp has since been evicted from `QueryHistoryStore`), or — in principle — a future panel kind this plan does not cover. `resolveAddressBarRoute` (below) returns `{ path: "/" }` whenever it cannot resolve a real route, rather than leaving the previous tab's URL showing. Leaving the URL alone was considered and rejected: since only `replace` is ever used, the *previous* tab's URL would keep showing while a completely different (and non-routable) tab is focused — actively misleading, since nothing marks it as stale.[^why-not-leave-alone]

### Container reveals compose `Tree.expandNode` with the existing reveal machinery — no new tree API

`navigator-sync-on-open`'s `revealByPredicate` (library, `Tree.ts:420-440`) already expands every *ancestor* of a matched node and scrolls it into view, but leaves the matched node itself collapsed — it was only ever used to reveal *leaves*. The library's `Tree.expandNode(node)` ([`Tree.ts:743-749`](../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L743)) already exists, is already public on `ExplorerTree` (which `extends Tree`), and is already used by `NavigatorTree`'s own single-schema auto-expand ([`NavigatorTree.ts:234-236`](frontend/src/navigator/NavigatorTree.ts#L234)) — loading a lazy branch's children first when needed. Revealing a container is therefore composing two existing calls — `revealByPredicate` to find and scroll to it, `expandNode` to open it — not extending the tree at all.

### The bare schema route reveals the schema's own node, matching `selectObject`'s existing predicate

A schema node's `data` is already a full `DbObjectRef` (`{connectionId, database, schema, kind: "schema"}`, no `name`) — the exact same shape `/schema/:schema/:view`'s existing `controller.selectObject(ref)` call already reveals ([`schemaNode`, `NavigatorTree.ts:261-268`](frontend/src/navigator/NavigatorTree.ts#L261)). No new predicate is needed for this half; `matchesObject(ref)` already matches it. What is new is a controller method that also expands the found node — `selectObject` deliberately never does, since expanding is meaningless for every *other* kind it is called with (a table leaf has no children).

### The database rail becomes a bare schema route, not a whole-tree-root route

**Inference, not a literal instruction — the user named only "the database rail," not a URL.** The closest parallel to a role bucket (a named container one level below a rail) is a single schema: `/schema/:schema` with no `:view` segment, currently unmatched entirely (`/schema/:schema/:view` requires exactly three segments, so a two-segment `/schema/sales` matches nothing today). This reveals the Database rail and expands that one schema's node — its Tables/Views/Sequences/… category folders, per `NavigatorTree`'s existing schema→category structure (`schemaNode`/`categoryNode`, [`NavigatorTree.ts:261-323`](frontend/src/navigator/NavigatorTree.ts#L261)), not a flat list of every object. A bare `/database` route revealing the whole tree root (all schemas at once) was the other reading and is not built; nothing in `NavigatorTree` groups schemas under one expandable root node — the tree's top level *is* the schema list — so "expand the whole tree" would mean expanding every schema node in a loop, a different and much noisier operation than "reveal a container."

### The two new container patterns add no ambiguity to the route table

`/schema/:schema` and `/role/${bucket}` are both new *two*-segment shapes — the shortest existing patterns under each prefix are three segments (`/schema/:schema/:view`, `/role/{user,group,predefined}/:role`). The one existing two-segment pattern, `/database/diagram`, has a distinct static first segment (`"database"` vs. `"schema"`/`"role"`), so `matchPattern`'s exact-segment-count rule (`RoutePattern.ts`, cited in full by `router-deep-linking`'s "Pattern selection" paragraph) rules out any collision the same way it already rules out every other pair in this table: two patterns can only tie if they share both segment count and every static segment, and no two ever do here.

| URL | Segments | Matches |
|---|---|---|
| `/database/diagram` | 2 | `/database/diagram` only |
| `/schema/sales` | 2 | `/schema/:schema` only (new) |
| `/role/user` | 2 | `/role/${bucket}` only (new) |
| `/schema/sales/diagram` | 3 | `/schema/:schema/:view` only (unchanged) |
| `/role/user/analyst` | 3 | `/role/{user,group,predefined}/:role` only (unchanged) |

### The `predefined` bucket gets the same container route as `user`/`group`

**Inference, not a literal instruction** — the user gave `/role/user` and `/role/group` as examples and named "the database rail" as a third, not `/role/predefined`. `ROLE_BUCKETS` (`routeTargets.ts:34`) already treats all three uniformly everywhere else — the existing `/role/{user,group,predefined}/:role` routes loop over it without a special case, and `RolesTree` shows all three sections the same way. Registering the new bare-bucket route from the same loop, rather than carving out two of three buckets by hand, is both less code and consistent with that established uniformity.

### The role-bucket predicate matches on `groupRoles.ts`'s section label — a new, code-only mirror

`ROLE_BUCKETS` already mirrors `RolesTree`'s "Users"/"Groups"/"Predefined" sections *without* importing `groupRoles.ts` — the mirror is asserted in a doc comment, not enforced by a shared import (`routeTargets.ts:27-33`), because `routeTargets.ts` is deliberately kept free of any import beyond `../contract` so it stays loadable by the node vitest harness with zero transitive DOM surface. The new `ROLE_BUCKET_SECTIONS: Record<RoleBucket, string>` constant, mapping `"user"→"Users"`, `"group"→"Groups"`, `"predefined"→"Predefined"`, extends that same established, unenforced mirror by one more entry rather than adding a new coupling.

---

## Public API

### `frontend/src/shell/routeTargets.ts`

```ts
// Widen the existing import:
import type { DbObjectKind, DbObjectRef } from "../contract";
import type { HistoryEntry } from "../data/queryStore";
import { findHistoryEntry } from "../data/queryStore";

/** One static path plus its query string, ready for router.getHref/navigate. */
export interface PanelRoute {
    path: string;
    query?: Record<string, string>;
}

/**
 * `ROLE_BUCKETS`, mapped to the RolesTree section label it mirrors — see the
 * plan's Architecture Decision on why this is a second, code-only mirror
 * rather than an import from groupRoles.ts.
 */
export const ROLE_BUCKET_SECTIONS: Record<RoleBucket, string>;

/**
 * The URL that reopens a database object at an optional named view — the
 * inverse of RELATION_KINDS' segment lookup and relationView/schemaView's
 * forward validity check. An invalid `view` for `ref.kind` is ignored (the
 * bare object path is still returned, not null). Returns null only for a
 * `"database"` or `"type"` ref (use databaseDiagramPath for the former; the
 * latter has no route), or a ref missing the schema/name its kind needs.
 *
 * @param ref - The object to build a URL for.
 * @param view - The trailing view segment ("structure", "diagram", …),
 *   omitted for the bare/default tab.
 */
export function objectPath(ref: DbObjectRef, view?: string): PanelRoute | null;

/**
 * The URL that reopens a role at an optional named view. Always uses the
 * "user" bucket segment — see the plan's Architecture Decision.
 *
 * @param role - The role name.
 * @param view - "grants-diagram" or "membership"; omitted for the bare grants tab.
 */
export function rolePath(role: string, view?: RoleView): PanelRoute;

/** The fixed URL for the whole-database diagram. */
export function databaseDiagramPath(): PanelRoute;

/** The fixed URL for the notes/documentation tab. */
export function notesPath(): PanelRoute;

/** The URL for a query-history entry. */
export function queryHistoryPath(timestamp: number): PanelRoute;

/**
 * The address bar's target for the currently focused panel: its own
 * recorded route if one was captured at open time; else, for a query panel,
 * its latest recorded run's history URL if that entry still exists; else
 * `{ path: "/" }`. See the plan's "A tab with no resolvable route falls
 * back to /" Architecture Decision.
 *
 * @param id - The focused panel's id, or null when the dock is empty.
 * @param panelRoutes - The controller's per-panel route registry.
 * @param queryPanelRuns - The controller's panel-id -> latest-run-timestamp map.
 * @param history - The current run history (newest-first).
 */
export function resolveAddressBarRoute(
    id: string | null,
    panelRoutes: ReadonlyMap<string, PanelRoute>,
    queryPanelRuns: ReadonlyMap<string, number>,
    history: readonly HistoryEntry[],
): PanelRoute;
```

### `frontend/src/data/queryStore.ts`

```ts
/**
 * The first entry whose `timestamp` stringifies to `rawTimestamp` — the
 * inverse of a query-history route's `:timestamp` param. Mirrors
 * recordNavigation.ts's findRecordByKey exactly: a stored timestamp is a
 * number, a route param is a string, so the comparison goes through String()
 * rather than parsing the param, avoiding a NaN/loose-equality trap.
 *
 * @param entries - The history list to search (any order).
 * @param rawTimestamp - The route's raw `:timestamp` param.
 */
export function findHistoryEntry(entries: readonly HistoryEntry[], rawTimestamp: string): HistoryEntry | undefined;
```

### `frontend/src/navigator/revealMatch.ts`

```ts
/**
 * Matches a roles-tree GROUP parent (a RoleGroupData marker) whose section
 * equals `section` — "Users" / "Groups" / "Predefined". Does not import
 * RoleGroupData; tests the shape structurally, mirroring asObjectRef's own
 * style in this file.
 *
 * @param section - The section label to match ("Users", "Groups", "Predefined").
 */
export function matchesRoleSection(section: string): NodeMatch;
```

### `frontend/src/SqlAdminController.ts`

```ts
/** Register the shell's address-bar sync callback. */
setSyncAddressBar(sync: (path: string, query?: Record<string, string>) => void): void;

/**
 * Switch the sidebar to the Database view and expand `schema`'s own
 * navigator node (its category children become visible) — no tab opens.
 * Best-effort, mirroring selectObject.
 */
revealSchema(schema: string): void;

/**
 * Switch the sidebar to the Roles view and expand the named section's group
 * node ("Users" / "Groups" / "Predefined") — its role leaves become visible
 * — no tab opens. Best-effort.
 */
revealRoleSection(section: string): void;
```

`openAsyncPanel`'s `spec` parameter gains one field:

```ts
private openAsyncPanel(
    spec: { id: string; title: string; glyph: string; tooltip?: string; ref?: DbObjectRef; route?: PanelRoute },
    build: () => Promise<Component>,
): void;
```

New private state (backing fields for the above, plus the query-history link):

| Field | Type | Set by |
|---|---|---|
| `_panelRoutes` | `Map<string, PanelRoute>` | `openAsyncPanel` (from `spec.route`), `openDocumentation` |
| `_queryPanelRuns` | `Map<string, number>` | `recordRun` |
| `_syncAddressBar` | `((path: string, query?: Record<string, string>) => void) \| null` | `setSyncAddressBar` |

**Changed:** `private revealRoleNode(name: string)` becomes `private revealRoleNode(match: NodeMatch)`, generalized to match `revealNavigatorNode(match: NodeMatch)`'s existing shape — `selectRole` now builds `matchesRole(name)` itself and passes it in, exactly as `selectObject` already builds `matchesObject(ref)` before calling `revealNavigatorNode`. `private recordRun(entry: HistoryEntry)` becomes `private recordRun(id: string, entry: HistoryEntry)`.

---

## Internal Structure

### `objectPath` — branching by kind, reusing the forward vocabulary

```ts
export function objectPath(ref: DbObjectRef, view?: string): PanelRoute | null {
    if (ref.kind === "schema") {
        if (!ref.schema) { return null; }
        const validView = view !== undefined && schemaView(view) !== null ? view : undefined;
        return { path: `/schema/${ref.schema}${validView ? `/${validView}` : ""}` };
    }

    if (!ref.schema || !ref.name) {
        return null;
    }

    const relation = RELATION_KINDS.find(r => r.kind === ref.kind);

    if (relation) {
        const validView = view !== undefined && relationView(relation.kind, view) !== null ? view : undefined;
        return { path: `/schema/${ref.schema}/${relation.segment}/${ref.name}${validView ? `/${validView}` : ""}` };
    }

    if (ref.kind === "sequence" || ref.kind === "index") {
        return { path: `/schema/${ref.schema}/${ref.kind}/${ref.name}` };
    }

    if (ref.kind === "function") {
        return {
            path : `/schema/${ref.schema}/function/${ref.name}`,
            query: ref.signature ? { signature: ref.signature } : undefined,
        };
    }

    return null; // "database" (use databaseDiagramPath) and "type" (no route) have no per-object path
}
```

### `resolveAddressBarRoute`

```ts
export function resolveAddressBarRoute(
    id: string | null,
    panelRoutes: ReadonlyMap<string, PanelRoute>,
    queryPanelRuns: ReadonlyMap<string, number>,
    history: readonly HistoryEntry[],
): PanelRoute {
    if (id === null) {
        return { path: "/" };
    }

    const route = panelRoutes.get(id);

    if (route) {
        return route;
    }

    const ts = queryPanelRuns.get(id);

    if (ts !== undefined) {
        const entry = findHistoryEntry(history, String(ts));

        if (entry) {
            return queryHistoryPath(entry.timestamp);
        }
    }

    return { path: "/" };
}
```

### `SqlAdminController`'s dock listeners — the two edits

```ts
this.dock.on("close", (e: DockPanelEvent) => {
    this.disposePanel(e.id);
    this._activeQueryResult.delete(e.id);
    this._activeRoleGrants.delete(e.id);
    this._panelRoutes.delete(e.id);
    this._queryPanelRuns.delete(e.id);
});
```

```ts
this.dock.on("focus", (e: DockPanelEvent | null) => {
    if (e) {
        this._activePanelId = e.id;
        this.syncToPanel(e.id);
    } else {
        this._activePanelId = null;
    }

    const route = resolveAddressBarRoute(e ? e.id : null, this._panelRoutes, this._queryPanelRuns, this._history.list());

    this._syncAddressBar?.(route.path, route.query);
});
```

### `openAsyncPanel` — recording the route before the tab is added

```ts
private openAsyncPanel(
    spec: { id: string; title: string; glyph: string; tooltip?: string; ref?: DbObjectRef; route?: PanelRoute },
    build: () => Promise<Component>,
): void {
    if (spec.route) {
        this._panelRoutes.set(spec.id, spec.route);
    }

    this.dock.addLazyPanel({ /* …unchanged… */ });
    this.statusBar.setMessage(`${this._statusScope} · ${spec.title}: loading…`);
}
```

Recording before `addLazyPanel` (not inside the async `content` factory) guarantees the entry exists before any "focus" event the add can trigger — a `Map.set` cannot race a synchronous emit that follows it.

### `openTable` — the route local for its table branch

Placed after the existing `const id = this.panelId(ref);` / `dock.focusPanel` check, before the `openAsyncPanel` call:

```ts
const query: Record<string, string> = {};
if (view?.rotated) { query.rotated = "true"; }
if (view?.record)  { query.record  = view.record; }
const built = objectPath(ref);
const route: PanelRoute | undefined = built ? { path: built.path, query: Object.keys(query).length > 0 ? query : undefined } : undefined;
```

then `route` joins `ref` in the `openAsyncPanel({...})` call. The view/matview branch above this point returns early and is untouched — see the "not given a `_panelRoutes` entry" Architecture Decision.

### The three relation-diagram-family openers — the depth merge

`openRelationDiagram`, `openRelationDependencyGraph`, `openRelationInheritanceGraph`, and `openRoleMembershipDiagram` each already take a `depth?: string` parameter. Each gains, before its `openAsyncPanel` call, the same two-line shape — only the first line's `built` source differs per method, exactly as `## Ordered Implementation Steps`' step-12 table states for each:

```ts
// openRelationDiagram:
const built = objectPath(ref, "diagram");
const route: PanelRoute | undefined = built ? { path: built.path, query: depth ? { depth } : undefined } : undefined;
```

`openRelationDependencyGraph` and `openRelationInheritanceGraph` are identical except for `objectPath(ref, "dependencies")` and `objectPath(ref, "inheritance")` respectively. `openRoleMembershipDiagram` uses `rolePath(name, "membership")` instead of `objectPath(...)` for `built` — `rolePath` never returns null, so its `route` local can drop the `built ?` guard: `const route: PanelRoute = { path: built.path, query: depth ? { depth } : undefined };`.

### `recordRun` and `openQuery`'s `onRun` — threading the panel id

```ts
private recordRun(id: string, entry: HistoryEntry): void {
    this._history.record(entry);
    this._queryPanelRuns.set(id, entry.timestamp);
    this.notifyWorkspaceChanged();
}
```

`openQuery`'s `onRun: (entry: HistoryEntry) => this.recordRun(entry)` becomes `onRun: (entry: HistoryEntry) => this.recordRun(id, entry)` — `id` is already the panel's local a few lines above.

### `revealSchema` / `revealRoleSection`

```ts
revealSchema(schema: string): void {
    const ref: DbObjectRef = { connectionId: this._connectionId, database: this._database ?? "", schema, kind: "schema" };

    void this.revealNavigatorNode(matchesObject(ref)).then(node => {
        if (node) {
            this._navigator?.selectNode(node);
            this._navigator?.expandNode(node);
        }
    });
}

revealRoleSection(section: string): void {
    void this.revealRoleNode(matchesRoleSection(section)).then(node => {
        if (node) {
            this._rolesTree?.selectNode(node);
            this._rolesTree?.expandNode(node);
        }
    });
}
```

### `appRouter.ts` — the three new registrations

```ts
router.register("/schema/:schema", params => dispatch(controller, () => {
    controller.revealSchema(params.schema);
}));
```

```ts
router.register("/query/history/:timestamp", (params, path) => dispatch(controller, () => {
    const entry = findHistoryEntry(controller.historyList(), params.timestamp);

    if (!entry) {
        reportUnknownLink(controller, path);

        return;
    }

    controller.openQuery(entry.sql, true);
}));
```

Inside the existing `for (const bucket of ROLE_BUCKETS)` loop, alongside the two current registrations:

```ts
router.register(`/role/${bucket}`, () => dispatch(controller, () => {
    controller.revealRoleSection(ROLE_BUCKET_SECTIONS[bucket]);
}));
```

### `SqlAdminApp.ts` — wiring the sync hook

```ts
import { Body, DOM } from "@jimka/typescript-ui/core";
// …
const controller = new SqlAdminController(session.connectionId, session.username, session.database);
const router     = buildAppRouter(controller);

// The reverse of router.start(): as the user switches tabs, replace the
// address bar with that tab's own URL. getHref does the formatting (base
// join, percent-encoding); replaceHistoryPath writes it directly, bypassing
// Router.navigate's automatic re-dispatch — see the plan's Architecture
// Decision on why navigate() would be unsafe here.
controller.setSyncAddressBar((path, query) => DOM.sink.replaceHistoryPath(router.getHref(path, query)));

Body.getInstance().addComponent(SqlAdminShell(controller));

router.start();
```

---

## Ordered Implementation Steps

1. **Baseline.** `cd frontend && npm run typecheck && npm test` — both clean before any edit. Re-check `frontend/package.json`'s `@jimka/typescript-ui` range and whether `frontend/node_modules/@jimka/typescript-ui` is still a symlink to `../typescript-ui/packages/lib` (`ls -la frontend/node_modules/@jimka/`): if the installed/symlinked build already exports `Router.getHref`/`navigate`/`getQuery` (it does — `router-deep-linking` already depends on and verified this), no library change is needed for this plan; record whichever is true (symlink vs. registry install) rather than assuming.

2. **`frontend/tests/data/queryStore.test.ts`.** Add a `describe("findHistoryEntry")` block with the cases from `## Expected Behaviour`. Red.

3. **`frontend/src/data/queryStore.ts`.** Add `findHistoryEntry` per `## Public API`. Green.

4. **`frontend/tests/navigator/revealMatch.test.ts`.** Add `matchesRoleSection` cases. Red.

5. **`frontend/src/navigator/revealMatch.ts`.** Add `matchesRoleSection` per `## Public API`, no new imports. Green.

6. **`frontend/tests/shell/routeTargets.test.ts`.** Add cases for `ROLE_BUCKET_SECTIONS`, `objectPath`, `rolePath`, `databaseDiagramPath`, `notesPath`, `queryHistoryPath`, `resolveAddressBarRoute`. Red — none of the new exports exist yet.

7. **`frontend/src/shell/routeTargets.ts`.** Widen the `../contract` import to include `DbObjectRef`; add `import type { HistoryEntry } from "../data/queryStore"; import { findHistoryEntry } from "../data/queryStore";`. Add `PanelRoute`, `ROLE_BUCKET_SECTIONS`, `objectPath`, `rolePath`, `databaseDiagramPath`, `notesPath`, `queryHistoryPath`, `resolveAddressBarRoute` per `## Public API` / `## Internal Structure`. Extend the file header comment: it now also holds the reverse (ref/role → URL) direction, sharing `RELATION_KINDS`/`ROLE_BUCKETS`/`relationView`/`schemaView` with the forward one. Green.

**Steps 8-13 land as one compiling unit** — `openAsyncPanel`'s new `route` field is unused until callers pass it, and `_panelRoutes`/`_queryPanelRuns` are unused until the focus handler reads them; `npm run typecheck` is expected to fail *between* these steps. Run it after step 13, not inside the run.

8. **`frontend/src/SqlAdminController.ts` — imports and new state.** Add `import { objectPath, rolePath, databaseDiagramPath, notesPath, resolveAddressBarRoute } from "./shell/routeTargets"; import type { PanelRoute } from "./shell/routeTargets"; import { matchesRoleSection } from "./navigator/revealMatch";` (extend the existing `revealMatch` import line rather than duplicating it). Add `_panelRoutes`, `_queryPanelRuns`, `_syncAddressBar` fields per `## Public API`'s table, placed beside `_openPanels` and `_showRolesView` respectively.

9. **`openAsyncPanel`.** Add the `route?: PanelRoute` field to its `spec` parameter type and the `_panelRoutes.set` line per `## Internal Structure`, before the `dock.addLazyPanel` call.

10. **The dock `"close"` and `"focus"` handlers** (constructor, [`SqlAdminController.ts:341`](frontend/src/SqlAdminController.ts#L341) and [`:370`](frontend/src/SqlAdminController.ts#L370)). Apply the two edits from `## Internal Structure` exactly.

11. **`recordRun` and `openQuery`.** Change `recordRun`'s signature and body per `## Internal Structure`; update its one call site inside `openQuery`'s `onRun`.

12. **Add a `route` local + field to each of the following**, per `## Internal Structure`'s patterns (bare `objectPath(ref, view) ?? undefined` for most; the depth-merge shape for the three relation-diagram-family methods and `openRoleMembershipDiagram`; `databaseDiagramPath()`/`rolePath(...)` — never null — need no `?? undefined`):

    | Method | Line | `route` expression |
    |---|---|---|
    | `openTable` (table branch only) | [455](frontend/src/SqlAdminController.ts#L455) | see `## Internal Structure`'s `openTable` snippet |
    | `openStructure` | [811](frontend/src/SqlAdminController.ts#L811) | `objectPath(ref, "structure") ?? undefined` |
    | `openDefinition` | [534](frontend/src/SqlAdminController.ts#L534) | `objectPath(ref, "definition") ?? undefined` |
    | `openSequence` | [683](frontend/src/SqlAdminController.ts#L683) | `objectPath(ref) ?? undefined` |
    | `openIndex` | [760](frontend/src/SqlAdminController.ts#L760) | `objectPath(ref) ?? undefined` |
    | `openFunctionDefinition` | [1407](frontend/src/SqlAdminController.ts#L1407) | `objectPath(ref) ?? undefined` |
    | `openSchemaDiagram` | [1720](frontend/src/SqlAdminController.ts#L1720) | `objectPath(ref, "diagram") ?? undefined` |
    | `openSchemaDependencyGraph` | [1998](frontend/src/SqlAdminController.ts#L1998) | `objectPath(ref, "dependencies") ?? undefined` |
    | `openSchemaInheritanceGraph` | [2114](frontend/src/SqlAdminController.ts#L2114) | `objectPath(ref, "inheritance") ?? undefined` |
    | `openRelationDiagram` | [1897](frontend/src/SqlAdminController.ts#L1897) | depth-merge over `objectPath(ref, "diagram")` |
    | `openRelationDependencyGraph` | [2053](frontend/src/SqlAdminController.ts#L2053) | depth-merge over `objectPath(ref, "dependencies")` |
    | `openRelationInheritanceGraph` | [2170](frontend/src/SqlAdminController.ts#L2170) | depth-merge over `objectPath(ref, "inheritance")` |
    | `openDatabaseDiagram` | [1813](frontend/src/SqlAdminController.ts#L1813) | `databaseDiagramPath()` |
    | `openRoleGrants` (private, called by `showRole`) | [2949](frontend/src/SqlAdminController.ts#L2949) | `rolePath(role)` |
    | `openRoleGrantsDiagram` | [3020](frontend/src/SqlAdminController.ts#L3020) | `rolePath(name, "grants-diagram")` |
    | `openRoleMembershipDiagram` | [2987](frontend/src/SqlAdminController.ts#L2987) | depth-merge over `rolePath(name, "membership")` |

    Each `route` local is computed just before its method's `openAsyncPanel({...})` call, and the call gains a trailing `route,` field.

13. **`openDocumentation`** ([`SqlAdminController.ts:1695`](frontend/src/SqlAdminController.ts#L1695)). Add `this._panelRoutes.set(id, notesPath());` immediately before its `this.dock.addPanel(...)` call (it does not go through `openAsyncPanel`).

14. **`revealRoleNode` and `selectRole`.** Change `revealRoleNode`'s parameter from `name: string` to `match: NodeMatch`, replacing its body's `matchesRole(name)` with the passed-in `match`. Update `selectRole` to `void this.revealRoleNode(matchesRole(name)).then(...)`, matching `selectObject`'s existing `revealNavigatorNode(matchesObject(ref))` shape. Add `revealSchema` and `revealRoleSection` per `## Internal Structure`, placed beside `selectObject`/`selectRole`.

15. **`setSyncAddressBar`.** Add the setter beside `setShowRolesView`.

16. **Typecheck the unit.** `cd frontend && npm run typecheck` — clean, closing steps 8-15.

17. **`frontend/src/shell/appRouter.ts`.** Add `import { findHistoryEntry } from "../data/queryStore";` and extend the `./routeTargets` import with `ROLE_BUCKET_SECTIONS`. Register `/schema/:schema` beside the existing `/schema/:schema/:view` registration, `/query/history/:timestamp` as a new top-level registration (beside `/notes`/`/database/diagram`), and the third `/role/${bucket}` registration inside the existing `ROLE_BUCKETS` loop — all three per `## Internal Structure`. Rewrite the file header's "Consume-only" paragraph: it no longer states nothing here ever informs a written-back URL (the write itself still happens outside this file, in `SqlAdminApp.ts` — clarify that split). Check: `grep -c "router.register(" frontend/src/shell/appRouter.ts` — 14 literal calls (up from 11: +1 for `/schema/:schema`, +1 for `/query/history/:timestamp`, +1 for the third call added inside the `ROLE_BUCKETS` loop), registering 24 routes at run time (up from 19: the 2 new standalone routes, plus the role loop now contributing 9 routes instead of 6 — 3 registrations × 3 buckets).

18. **`frontend/src/SqlAdminApp.ts`.** Widen the `@jimka/typescript-ui/core` import to include `DOM`; add the `controller.setSyncAddressBar(...)` line per `## Internal Structure`, placed after `const router = buildAppRouter(controller);` and before `Body.getInstance().addComponent(...)`. Extend the file header comment to mention the sync hook.

19. **Regression checks.**
    - `grep -rn "router\.navigate(" frontend/src/` — zero matches; this plan never calls `navigate`, only `getHref` + `DOM.sink.replaceHistoryPath` (see the Architecture Decision on why).
    - `grep -c "DOM.sink.replaceHistoryPath" frontend/src/SqlAdminApp.ts` — 1.
    - `grep -rn "revealRoleNode(" frontend/src/SqlAdminController.ts` — every call site passes a `NodeMatch` (`matchesRole(...)` or `matchesRoleSection(...)`), never a bare string.

20. **`README.md` and `TODO.md`** per `## Documentation Impact`.

21. **Verification** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/shell/routeTargets.ts` |
| Modify | `frontend/src/shell/appRouter.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/SqlAdminApp.ts` |
| Modify | `frontend/src/navigator/revealMatch.ts` |
| Modify | `frontend/src/data/queryStore.ts` |
| Modify | `frontend/tests/shell/routeTargets.test.ts` |
| Modify | `frontend/tests/navigator/revealMatch.test.ts` |
| Modify | `frontend/tests/data/queryStore.test.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

No new files — every module this plan extends already exists.

---

## Expected Behaviour

### `findHistoryEntry` — *unit* (`tests/data/queryStore.test.ts`)

| `entries`' timestamps | `rawTimestamp` | Result |
|---|---|---|
| `[100, 200, 300]` | `"200"` | the entry with timestamp `200` |
| `[100, 200]` | `"999"` | `undefined` |
| `[100, 100]` | `"100"` | the **first** matching entry |
| `[]` | `"100"` | `undefined` |
| `[100]` | `""` | `undefined` |

### `matchesRoleSection` — *unit* (`tests/navigator/revealMatch.test.ts`)

| Call | Against | Result |
|---|---|---|
| `matchesRoleSection("Users")` | `{section: "Users", glyph: "users"}` | `true` |
| `matchesRoleSection("Users")` | `{section: "Groups", glyph: "user-group"}` | `false` |
| `matchesRoleSection("Users")` | `"analyst"` (a role leaf) | `false` |
| `matchesRoleSection("Users")` | `undefined` | `false` |

### `objectPath` — *unit* (`tests/shell/routeTargets.test.ts`)

| `ref` | `view` | Result |
|---|---|---|
| `{kind: "table", schema: "sales", name: "invoices"}` | *(none)* | `{path: "/schema/sales/table/invoices"}` |
| same | `"structure"` | `{path: "/schema/sales/table/invoices/structure"}` |
| same | `"definition"` (invalid for a table) | `{path: "/schema/sales/table/invoices"}` — invalid view ignored |
| `{kind: "view", schema: "sales", name: "v_orders"}` | `"definition"` | `{path: "/schema/sales/view/v_orders/definition"}` |
| `{kind: "materializedView", schema: "sales", name: "mv"}` | `"diagram"` | `{path: "/schema/sales/matview/mv/diagram"}` |
| `{kind: "sequence", schema: "sales", name: "seq1"}` | `"diagram"` (ignored — sequences have no view) | `{path: "/schema/sales/sequence/seq1"}` |
| `{kind: "index", schema: "sales", name: "idx1"}` | *(none)* | `{path: "/schema/sales/index/idx1"}` |
| `{kind: "function", schema: "sales", name: "fn", signature: "p_x integer"}` | *(none)* | `{path: "/schema/sales/function/fn", query: {signature: "p_x integer"}}` |
| `{kind: "function", schema: "sales", name: "fn", signature: ""}` | *(none)* | `{path: "/schema/sales/function/fn"}` — empty signature omitted, not `?signature=` |
| `{kind: "schema", schema: "sales"}` | *(none)* | `{path: "/schema/sales"}` |
| `{kind: "schema", schema: "sales"}` | `"diagram"` | `{path: "/schema/sales/diagram"}` |
| `{kind: "schema", schema: "sales"}` | `"bogus"` | `{path: "/schema/sales"}` — invalid view ignored |
| `{kind: "database"}` | — | `null` |
| `{kind: "type", schema: "sales", name: "t1"}` | — | `null` |
| `{kind: "table", name: "x"}` (no `schema`) | — | `null` |

### `rolePath` — *unit*

| `role` | `view` | Result |
|---|---|---|
| `"analyst"` | *(none)* | `{path: "/role/user/analyst"}` |
| `"analyst"` | `"membership"` | `{path: "/role/user/analyst/membership"}` |
| `"analyst"` | `"grants-diagram"` | `{path: "/role/user/analyst/grants-diagram"}` |

`databaseDiagramPath()` → `{path: "/database/diagram"}`. `notesPath()` → `{path: "/notes"}`. `queryHistoryPath(1699999999999)` → `{path: "/query/history/1699999999999"}`. `ROLE_BUCKET_SECTIONS` → exactly `{user: "Users", group: "Groups", predefined: "Predefined"}`.

### `resolveAddressBarRoute` — *unit*

| `id` | `panelRoutes` | `queryPanelRuns` | `history` | Result |
|---|---|---|---|---|
| `null` | *(any)* | *(any)* | *(any)* | `{path: "/"}` |
| `"p1"` | `{p1: {path: "/schema/sales/table/x"}}` | `{}` | `[]` | `{path: "/schema/sales/table/x"}` |
| `"q1"` | `{}` | `{q1: 100}` | `[{timestamp: 100, ...}]` | `{path: "/query/history/100"}` |
| `"q1"` | `{}` | `{q1: 999}` | `[{timestamp: 100, ...}]` | `{path: "/"}` — recorded timestamp no longer in history (evicted) |
| `"q2"` | `{}` | `{}` | `[]` | `{path: "/"}` — never run |
| `"unknown"` | `{}` | `{}` | `[]` | `{path: "/"}` |

### Manual verification (DOM, dock, and browser-history-dependent — outside the node harness)

Run against the seeded demo database (`db/init/*.sql`), `npm run dev` with the backend running. `sales.invoices` and `sales.orders` stand in for "a table"; `sales.order_summary` (a view) for the query-tab case; `analyst`/`readonly`/`pg_monitor` for the three role buckets.

1. **Click-driven sync, table.** Open `invoices`' data tab by double-clicking it in the navigator. The address bar reads `/schema/sales/table/invoices`, with no browser-history entry added (check the back button still lands where it did before this click).
2. **Click-driven sync, structure tab.** Open `invoices`' Structure tab from its context menu. The address bar reads `/schema/sales/table/invoices/structure`.
3. **Tab switching updates on every focus.** With both tabs from cases 1-2 open, click between them repeatedly. The address bar updates each time; back/forward still skip over all of it (`replace`, never `push`).
4. **Empty dock falls back to `/`.** Close every open tab. The address bar reads `/`.
5. **A view opens as a query tab, address bar syncs to its history.** Double-click `order_summary` (a view). It opens as an auto-run browse-query tab; once the run completes, the address bar reads `/query/history/<some timestamp>` — not `/schema/sales/view/order_summary`.
6. **An unrun scratch panel falls back to `/`.** Menu → New Query. Do not run it. The address bar reads `/`.
7. **Running it updates the address bar.** Run the query from case 6. The address bar now reads `/query/history/<timestamp>`.
8. **Editing and rerunning supersedes the old link.** Edit the SQL from case 7 and run again. The address bar's timestamp changes to the new run's. Manually visiting the *old* URL (case 7's) shows an error toast (the entry was replaced, not duplicated — `QueryHistoryStore.record` dedupes by SQL) and the start page stays.
9. **Reopening a history link reruns it.** Copy the URL from case 7, open it in a fresh tab (or paste + reload). A new query tab opens titled `Query 1`, seeded with the same SQL, already run with matching results.
10. **Unknown/evicted timestamp.** Visit `/query/history/1`. An error toast reads `no view matches the link path "/query/history/1"`; the start page stays.
11. **Role tab always syncs to `/role/user/...`.** Open `readonly`'s (a Groups-bucket role) grants tab. The address bar reads `/role/user/readonly`, not `/role/group/readonly`.
12. **Diagram depth is open-time only.** Load `/schema/hr/table/employees/diagram?depth=2` (a deep link). The address bar keeps reading `...?depth=2` while that tab is focused. Change the Depth control to `3` without switching tabs away and back — the address bar is unchanged (still `depth=2`); switch to another tab and back — still `depth=2` (the snapshot is not retaken on refocus).
13. **A normal (non-route) diagram open carries no depth.** Double-click into `hr.employees`' relations diagram from the Structure tab's FK link (not via URL). The address bar reads `.../diagram` with no `?depth=` at all.
14. **Function overload.** Open `price_with_tax(p_price numeric)`'s definition from the navigator. The address bar reads `/schema/sales/function/price_with_tax?signature=p_price%20numeric`.
15. **No duplicate tab from the sync echo.** Load a deep link, e.g. `/schema/sales/table/invoices`. Exactly one tab opens (check the dock's tab strip) — the focus event the initial open fires does not cause a second `openTable` dispatch. Repeat with `/schema/sales/view/order_summary` (the view/query-tab case) and confirm still exactly one query tab opens, not two.
16. **Container: `/role/user`.** Load `/role/user`. The Roles rail shows, the "Users" section is expanded showing its role leaves, and no tab opens.
17. **Container: trailing slash.** Load `/role/user/`. Identical to case 16.
18. **Container: the other two buckets.** Load `/role/group` and `/role/predefined`. Each expands its own section on the Roles rail; no tab opens.
19. **Container: bare schema.** Load `/schema/sales`. The Database rail shows, the `sales` schema node is expanded showing its Tables/Views/Sequences/… category folders, and no tab opens.
20. **Container: bare schema, trailing slash.** Load `/schema/sales/`. Identical to case 19.
21. **Sign-in round trip still works for every new route.** Sign out, load `/role/user`, sign back in: the Roles rail shows Users expanded, exactly as a direct visit would.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — the three extended suites green, the rest unchanged.
- `cd frontend && npm run build`.
- `grep -rn "router\.navigate(" frontend/src/` — zero matches.
- `grep -c "DOM.sink.replaceHistoryPath" frontend/src/SqlAdminApp.ts` — 1.
- `grep -c "router.register(" frontend/src/shell/appRouter.ts` — 14 (see step 17's accounting: 24 routes registered at run time).
- `grep -c "_panelRoutes.set(" frontend/src/SqlAdminController.ts` — 2 (the one call inside `openAsyncPanel` itself, which every routed method's `route` field flows through, plus `openDocumentation`'s direct call — it bypasses `openAsyncPanel`).
- `grep -c "objectPath(ref" frontend/src/SqlAdminController.ts` — 12 (the step-12 table's `objectPath`-based rows). `grep -c "rolePath(" frontend/src/SqlAdminController.ts` — 3. `grep -c "databaseDiagramPath()" frontend/src/SqlAdminController.ts` — 1. `grep -c "notesPath()" frontend/src/SqlAdminController.ts` — 1.
- Manual cases 1-21 above. Entry point: `npm run dev` in `frontend` with the backend running.

---

## Documentation Impact

- **`README.md`** — the **Deep links** bullet ([lines 27-36](README.md#L27)). Replace "Links are read on load only — the address bar does not yet follow in-app navigation" with: the address bar also follows in-app navigation as tabs are opened and focused (using `replace`, so switching tabs never adds browser-history entries); an ad-hoc query panel gets a URL once it has run at least once, keyed to that run in the browser's own local history (`/query/history/…` — resolves only on the same browser, same user, same connection, the same limitation `openSavedQuery` already has); and `/schema/<schema>` / `/role/user` (or `group`/`predefined`) reveal a schema or role-bucket container in the sidebar without opening a tab.
- **`TODO.md`** — the **Shareable link UI** bullet under `## Backlog (no plan yet)` → `### Connections / platform`. Trim to just the remaining half: a "Copy link" action (context menu / toolbar) that builds a URL for the focused tab. Remove "plus keeping the address bar in step as the user navigates" — that half is now done.
- **`CHANGELOG.md`** — no entry; written at release time, not in feature work (established convention).
- **`frontend/COMPONENT_CONVENTIONS.md`** — no change; no new components, only pure functions and controller methods.

---

## Potential Challenges

- **`applyCurrentRoute`'s unconditional re-dispatch on `navigate`.** The whole reason this plan writes through `getHref` + `DOM.sink.replaceHistoryPath` instead of `router.navigate` — see the Architecture Decision. Do not "simplify" the sync hook to call `navigate` later; it reintroduces the duplicate-query-tab bug case 15's manual check exists to catch.
- **`openAsyncPanel`'s `route` must be computed before the call, not inside its async `build` callback.** `build` runs behind the dock's spinner and may resolve after several other focus events have already fired; the route has to be in `_panelRoutes` synchronously, before `dock.addLazyPanel` is even called.
- **`_panelRoutes`/`_queryPanelRuns` are per-session, in-memory state — nothing persists them.** A reload always starts from an empty dock (per `router-deep-linking`'s existing Non-Goal on workspace restore); this plan does not change that, it only makes the *currently* focused tab's URL accurate while the session lasts.
- **A composite-key table's `?record=` and a diagram's `?depth=` inherit `router-deep-linking`'s existing caveats** (a composite key resolves to its first column; an out-of-range depth silently falls back). This plan reads those values back out verbatim from what was passed in at open time — it introduces no new interpretation of either.
- **`RolesTree`'s section labels ("Users"/"Groups"/"Predefined") are asserted, not type-checked, against `ROLE_BUCKET_SECTIONS`.** If `groupRoles.ts`'s `SECTIONS` labels ever change, `ROLE_BUCKET_SECTIONS` needs a matching edit — the same maintenance burden `ROLE_BUCKETS`' own doc-comment mirror already carries, not a new one.

---

## Critical Files

| File | Why |
|---|---|
| [`plans/implemented/router-deep-linking.md`](plans/implemented/router-deep-linking.md) | The forward route table, the URL/query-string split, and the "A record is addressed by its primary-key value" / "Methods that are deliberately not route targets" reasoning this plan's Part 2 applies a second time. |
| [`plans/implemented/navigator-sync-on-open.md`](plans/implemented/navigator-sync-on-open.md) | `LoadSignal`, `revealMatch.ts`'s existing predicates, and the `revealNavigatorNode`/`revealRoleNode` shape Part 3's new methods extend. |
| [`frontend/src/shell/routeTargets.ts`](frontend/src/shell/routeTargets.ts) | The forward vocabulary (`RELATION_KINDS`, `ROLE_BUCKETS`, `relationView`, `schemaView`, `roleView`) every new reverse builder reuses directly. |
| [`frontend/src/shell/appRouter.ts`](frontend/src/shell/appRouter.ts) | The route table the three new patterns join; its `dispatch`/`reportUnknownLink` helpers are reused as-is. |
| `typescript-ui/packages/lib/src/typescript/lib/router/Router.ts` (sibling repo) | `navigate`'s unconditional `applyCurrentRoute()` after any write — the mechanic the "writes through `getHref` + `replaceHistoryPath`" Architecture Decision is built around. Read `navigate` and `getHref` in full before touching `SqlAdminApp.ts`. |
| `typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts` (sibling repo) | `revealByPredicate` (expands ancestors, not the target) and `expandNode` (the target itself) — the two calls Part 3's reveal methods compose. |
| [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) | `openAsyncPanel` (3274) is the one funnel Part 1 hooks; `dock.on("focus"/"close", ...)` (341, 370) are the two listeners this plan extends; `openQuery` (2400) is Part 2's open path. |
| [`frontend/src/data/queryStore.ts`](frontend/src/data/queryStore.ts) | `HistoryEntry`, `QueryHistoryStore.record`'s dedupe-by-SQL behavior (why a rerun supersedes rather than duplicates a history entry) — read before writing `findHistoryEntry`. |
| [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) | `schemaNode`/`categoryNode` (261-323) — the schema container's actual child structure `revealSchema` exposes. |
| [`frontend/src/roles/groupRoles.ts`](frontend/src/roles/groupRoles.ts) | `SECTIONS`, `RoleGroupData` — the section-label vocabulary `ROLE_BUCKET_SECTIONS` mirrors. |

---

## Non-Goals

- **A "Copy link" UI affordance.** Still a separate fast-follow (`TODO.md`'s trimmed **Shareable link UI** bullet). This plan makes the address bar follow navigation automatically; it adds no manual share action.
- **Changing the URL scheme for already-routable objects.** Schema/table/role identity and view-mode query properties are unchanged; this plan only adds new routes and a write direction.
- **Live-tracking a tab's in-progress view state** (record selection, rotated toggle, diagram depth) after it opens. The synced URL reflects the tab's *open-time* options only — see the "per-panel route registry" Architecture Decision.
- **A name-keyed route for saved queries** (`/query/saved/:name`). Automatically covered by the history-keyed route once a saved query has run; see the matching Architecture Decision.
- **Restoring a whole workspace, or any dock tab, from a reload with no URL.** Unchanged from `router-deep-linking`'s existing Non-Goal — this plan only makes the *currently shown* URL accurate, never persists which tabs were open.
- **Validating a role route's bucket segment against the role's real classification.** Still unvalidated on the way in (`router-deep-linking`'s decision); the way out (`rolePath`) sidesteps needing the classification at all by always emitting `user`.
- **A bare `/database` route revealing the whole navigator tree.** The database-rail inference is `/schema/:schema`, not a tree-root route — see the matching Architecture Decision.
- **Fixing the latent double-open risk in `openTable`'s view/matview branch for a hypothetical future `navigate()` caller.** This plan's own sync mechanism never triggers it (that is the entire point of not using `navigate`); a future "Copy link" pass that *does* call `navigate` on a repeat visit to the same view URL would need to address it then.

---

## Implementation Notes

**`recordRun` also re-syncs the address bar for the still-focused panel — not in the plan's `## Internal Structure` snippet.** The plan's `recordRun` (lines 401-406) only records history, sets `_queryPanelRuns`, and calls `notifyWorkspaceChanged`; it does not touch the address bar. Manual verification case 5 (and, by the same mechanism, cases 7 and 9) failed against that literal implementation: double-clicking `order_summary` opened its auto-run query tab, but the address bar stayed on `/` even after the run completed and results rendered. The cause is a gap in the dock `"focus"` handler's timing — it fires once, synchronously, at open time, before `openQuery`'s auto-run has resolved (a real network round trip), and nothing else re-fires `"focus"` once the run finishes while the tab stays focused. `recordRun` (`SqlAdminController.ts`) was extended to call a new private `syncAddressBarFor(id)` — factored out of the `"focus"` handler's own route-resolution + write — whenever `id === this._activePanelId`, so a completed run re-syncs only when its panel is still the one on screen; a background tab's completed run never touches the visible URL. This does not extend the "per-panel route registry, filled once at open time — not live-tracked state" Architecture Decision (which scopes to `_panelRoutes`' open-time-frozen `depth`/`rotated`/`record` query params on fixed-identity panels): `_queryPanelRuns` was always meant to change on every rerun of the same tab — the plan's own "`timestamp` is the stable key" decision and manual case 8 ("the address bar's timestamp changes to the new run's") already require it; `recordRun` was simply missing the one call that makes that resolution reach the address bar without waiting for an intervening tab switch.

**Step 1's symlink-vs-registry-install baseline determination.** `frontend/node_modules/@jimka/typescript-ui` is a registry install (not symlinked), version `0.6.0`; `Router.getHref`/`navigate`/`getQuery` and `Tree.expandNode` are all present, so no library change was needed. Recorded here since the plan's step 1 asked for this to be recorded but named no specific location.

---

## Notes

[^navigate-vs-write]: Confirmed by reading `Router.navigate`'s History-mode branch directly (`Router.ts:213-231`): the same-value short-circuit (`if (target === this.getPath() && ...) { return this; }`) only fires when the *new* URL equals the *current* one — which is true for the harmless self-echo case (a route-driven open's own "focus" event trying to write back the URL it was just opened from) but false for every genuine tab switch, which is exactly when `syncAddressBar` needs to do real work. `applyCurrentRoute()` runs unconditionally in every other case, re-invoking the newly-synced route's handler. Most handlers no-op safely on a repeat call (`dock.focusPanel(id)` short-circuits before any rebuild), but `openQuery` — used by both the new `/query/history/:timestamp` route and `openTable`'s view/matview branch — never dedupes by design (`SqlAdminController.ts:2384-2389`'s own comment: "each call always mints a unique id"), so a re-dispatch would open (and re-run) a second, duplicate query panel on every single focus of an already-open query-history tab.

[^open-time-snapshot]: Making every relevant view state live-trackable was considered: `TableWorkPanel` would need a `isRotated()`/`getFocusedRecordKey()` pair, and `DiagramShell`/`RelationDiagramPanel` a `getDepth()`, each firing (or being polled) on every internal state change so `_panelRoutes` could be kept current. This was rejected as disproportionate to the value: none of `rotated`/`record`/`depth` currently drive any event the controller listens to, `router-deep-linking` itself designed these as one-shot *open-time* options (its own `## Non-Goals` never promised live sync), and the dock's `"focus"` event — the one hook this plan is told to build on — only fires on a tab *switch*, so even a perfectly live-tracked value would only ever reach the address bar on the next switch anyway, not the moment it changes. Snapshotting at open time is simpler, matches the hook's actual granularity, and is the smallest change that satisfies "the address bar tracks in-app navigation."

[^why-not-leave-alone]: Leaving the address bar showing the previous tab's URL while a non-routable tab (an empty dock, an unrun query panel) is focused was the alternative to falling back to `/`. It reads as actively wrong rather than merely imprecise: nothing in the UI marks that URL as stale, so a copied link would silently misdescribe what is on screen. `/` is honest — it is the same path the app already treats as "nothing specific is open" (the router's own `/` registration is a no-op handler for exactly this state, `appRouter.ts`'s existing `router.register("/", () => {})`).

[^history-not-preview]: A "show without running" alternative was considered for `/query/history/:timestamp` — seed the editor with the historical SQL and stop. It was rejected because it breaks the round-trip this plan otherwise establishes: Part 1 syncs the address bar to a query tab's URL only *after* a run recorded it, so the tab the link was generated from was, by construction, already showing results — landing an inert, unrun editor on revisit would be a downgrade from what the link was generated to represent, and would need an extra manual Run click every single time, undermining "the URL reflects what you were looking at."
