---
depends-on: [router-deep-linking]
touches-shared:
  - frontend/src/SqlAdminController.ts
  - frontend/src/shell/SqlAdminShell.ts
  - frontend/src/shell/ActivityBar.ts
  - frontend/src/shell/appRouter.ts
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/roles/RolesTree.ts
  - README.md
---

# Navigator Sync on Open — Implementation Plan

## Overview

Opening a view from a URL leaves the sidebar untouched: the rail keeps showing whatever view it showed before, and neither tree highlights the object that just opened. A deep link to `/role/user/analyst` opens the role's grants tab behind the Database rail, and `/schema/sales/table/invoices` opens the table with nothing selected in the navigator.

Two separate defects produce that one symptom.

**The rail never switches on a programmatic open.** `ActivityBar.selectView` ([`ActivityBar.ts:225`](frontend/src/shell/ActivityBar.ts#L225)) is called only from `SqlAdminShell` — the View menu, the Alt+D/O/Q accelerators, and each rail button's own click handler ([`SqlAdminShell.ts:106-108`](frontend/src/shell/SqlAdminShell.ts#L106), [`:171-176`](frontend/src/shell/SqlAdminShell.ts#L171)). The controller can reach the Queries view through a shell-injected hook (`setShowQueriesView`, [`SqlAdminController.ts:2646`](frontend/src/SqlAdminController.ts#L2646)) but has no equivalent for Database or Roles.

**A reveal issued before a tree has data silently finds nothing.** `Tree.revealByPredicate` searches the tree's current root nodes, which `NavigatorTree` fills from an un-awaited `refresh()` fired in its constructor ([`NavigatorTree.ts:204`](frontend/src/navigator/NavigatorTree.ts#L204), [`:212-229`](frontend/src/navigator/NavigatorTree.ts#L212)). Nothing exposes when that load finished, so `openReferencedTable` / `openReferencedSequence` / `openReferencedStructure` ([`SqlAdminController.ts:2219`](frontend/src/SqlAdminController.ts#L2219), [`:2251`](frontend/src/SqlAdminController.ts#L2251), [`:2266`](frontend/src/SqlAdminController.ts#L2266)) and `openGrantedTable` ([`:2958`](frontend/src/SqlAdminController.ts#L2958)) all search an empty tree when called early. `RolesTree` ([`RolesTree.ts:116`](frontend/src/roles/RolesTree.ts#L116)) has the same shape and, on top of that, never registers itself with the controller at all — so nothing can drive its selection.

The second defect predates deep linking but was hard to hit: both trees load inside the first round trip after sign-in, so only a click landing in that window missed. Deep linking made it systematic, because a route runs inside exactly that window. One pre-routing path shows it plainly — `openGrantedTable` reports `… not found in navigator` and opens **nothing** when the reveal misses, so an early double-click in a role's grants graph silently refuses to open the table.

This plan adds a load-completion signal to both trees, two rail hooks mirroring the Queries one, and one reveal call per object-bearing route. `frontend/src/shell/appRouter.ts` gains a statement per handler; the router itself, its URL scheme, and every `open*` method's contract stay as they are.

---

## Architecture Decisions

### A tree exposes an awaitable `whenLoaded()`, backed by a shared `LoadSignal`

`ExplorerTree` gains `whenLoaded(): Promise<void>`. Each tree arms the signal when `refresh()` starts and settles it when the load chain finishes, so a caller awaiting `whenLoaded()` before a reveal always searches a populated tree. When no load is running, `whenLoaded()` is already resolved. This copies `DiagramView.whenLaidOut()` ([`DiagramView.ts:629`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L629)), the pattern this app already uses to wait on an async UI step.[^ready-is-a-promise]

The deferred lives in a new DOM-free `LoadSignal` class rather than being written twice, once per tree.[^signal-is-shared]

### The reveal switches the rail; a plain selection does not

Revealing an object means searching a tree and scrolling to the result — pointless while that tree's deck page is hidden. So the two controller reveal helpers switch the sidebar to the owning view first. Focus-driven selection in `syncToPanel` ([`SqlAdminController.ts:3196`](frontend/src/SqlAdminController.ts#L3196)) is untouched: switching between two already-open tabs does not move the rail.[^open-not-focus]

### The rail switch respects a collapsed sidebar

`ActivityBar` gains `revealView(id)` beside `selectView(id)`. `revealView` changes which view is active without expanding a sidebar the user collapsed; `selectView` (menu items, accelerators) keeps expanding as it does today.[^reveal-view]

| Sidebar state | `selectView("roles")` | `revealView("roles")` |
|---|---|---|
| expanded, Database showing | Roles page shows, stays expanded | Roles page shows, stays expanded |
| collapsed | Roles page shows, sidebar **expands** | stays collapsed; a later expand opens on Roles |

### Route handlers keep calling the plain `open*` methods and add one reveal call

Each object-bearing route handler in `appRouter.ts` gains a single `controller.selectObject(ref)` (or `controller.selectRole(role)`) statement immediately before its `open*` call. The handlers do **not** switch to the `openReferenced*` wrappers.[^not-open-referenced]

This mirrors how the app already pairs an open with a reveal: `openReferencedTable` is a *caller-side* pairing of `openTable` with a reveal, not a reveal baked into `openTable`. The route layer is another such caller.

### The two object predicates stay distinct

The reveal predicates move into a DOM-free module. The two that match a navigator object keep their current, different rules: `matchesObject` compares kind as well as name, `matchesRelationName` does not.[^two-predicates]

| Predicate | Matches on | Used by |
|---|---|---|
| `matchesObject(ref)` | database + schema + name + kind | `selectObject`, `openReferencedSequence`, `openReferencedStructure` |
| `matchesRelationName(ref)` | database + schema + name | `openReferencedTable` |
| `matchesGrantedTable(schema, table)` | schema + name | `openGrantedTable` |
| `matchesRole(name)` | the node's `data` string equals `name` | `selectRole` |

Worked cases against a navigator leaf carrying `{database: "app", schema: "sales", name: "orders", kind: "table"}`:

| Call | Result | Why |
|---|---|---|
| `matchesObject({database: "app", schema: "sales", name: "orders", kind: "table"})` | `true` | every field agrees |
| `matchesObject({database: "app", schema: "sales", name: "orders", kind: "sequence"})` | `false` | kind differs |
| `matchesRelationName({database: "app", schema: "sales", name: "orders", kind: "sequence"})` | `true` | kind is not compared |
| `matchesGrantedTable("sales", "orders")` | `true` | database is not compared |
| `matchesGrantedTable("hr", "orders")` | `false` | schema differs |

### A ref with no schema switches the rail and reveals nothing

`selectObject` returns early for a ref carrying no `schema` — the `/database/diagram` route's `{kind: "database"}` ref is the only one today. The navigator has no database level, so a search would walk every schema and lazily fetch each one's objects to find nothing.[^no-schema-guard]

---

## Public API

### `frontend/src/data/loadSignal.ts` (new)

Pure; imports nothing.

```ts
/**
 * A re-armable "the load finished" awaitable. Arm it when a load starts and
 * settle it when the load chain ends (success or failure); `whenSettled`
 * resolves at once whenever no load is armed.
 */
export class LoadSignal {
    /** Arm the awaitable. A no-op while one is already armed. */
    arm(): void;

    /** Settle the armed awaitable, if there is one. A no-op when idle. */
    settle(): void;

    /** A promise resolving when the armed load settles; already resolved when idle. */
    whenSettled(): Promise<void>;
}
```

Backing field: `private _pending: { promise: Promise<void>; resolve: () => void } | null = null`.

### `frontend/src/navigator/revealMatch.ts` (new)

Pure; imports only `import type { DbObjectRef } from "../contract";`.

```ts
/** Tests one tree node's `data` payload. */
export type NodeMatch = (data: unknown) => boolean;

/** Matches a navigator leaf on database + schema + name + kind. */
export function matchesObject(ref: DbObjectRef): NodeMatch;

/**
 * Matches a navigator leaf on database + schema + name, ignoring kind — for
 * diagram nodes whose ref kind may not be the navigator leaf's kind.
 */
export function matchesRelationName(ref: DbObjectRef): NodeMatch;

/**
 * Matches a navigator leaf on schema + name only: a RolePrivilege carries no
 * database, so a granted table adopts whichever database the match carries.
 */
export function matchesGrantedTable(schema: string, table: string): NodeMatch;

/** Matches a roles-tree leaf, whose `data` is the role name itself. */
export function matchesRole(name: string): NodeMatch;
```

### `frontend/src/navigator/NavigatorTree.ts`

```ts
export interface ExplorerTree extends Tree {
    refresh(): void;
    /** Resolves once the tree's top level has loaded; already resolved when idle. */
    whenLoaded(): Promise<void>;       // NEW
}
```

`NavigatorTree` and `RolesTree` each implement `whenLoaded()` as `return this._loaded.whenSettled();`, over a `private readonly _loaded: LoadSignal = new LoadSignal();` field.

### `frontend/src/shell/ActivityBar.ts`

```ts
class ActivityBar extends Container {
    /**
     * Make `id` the active view without changing the sidebar's collapsed
     * state. An arrow-function field — the shell passes it by reference.
     */
    revealView = (id: string): void => { /* … */ };
}
```

### `frontend/src/SqlAdminController.ts`

```ts
/** Register the roles tree so a role open can drive its selection. */
setRolesTree(tree: ExplorerTree): void;

/** Register the shell's Database-view selector. */
setShowDatabaseView(select: () => void): void;

/** Register the shell's Roles-view selector. */
setShowRolesView(select: () => void): void;

/**
 * Switch the sidebar to the Database view and select `ref`'s navigator node
 * once the navigator has loaded. Best-effort: a ref with no navigator node
 * only switches the view.
 */
selectObject(ref: DbObjectRef): void;

/**
 * Switch the sidebar to the Roles view and select `name`'s roles-tree node
 * once the role list has loaded. Best-effort.
 */
selectRole(name: string): void;
```

New private members, with their backing fields:

| Member | Backing field | Set by |
|---|---|---|
| `showDatabaseView(): void` | `_showDatabaseView: (() => void) \| null = null` | `setShowDatabaseView` |
| `showRolesView(): void` | `_showRolesView: (() => void) \| null = null` | `setShowRolesView` |
| `revealNavigatorNode(match: NodeMatch): Promise<TreeNode \| undefined>` | — | — |
| `revealRoleNode(name: string): Promise<TreeNode \| undefined>` | — | — |
| — | `_rolesTree: ExplorerTree \| null = null` | `setRolesTree` |

`revealObject(ref)` ([`SqlAdminController.ts:2287`](frontend/src/SqlAdminController.ts#L2287)) keeps its name and signature and becomes a one-line delegate to `revealNavigatorNode(matchesObject(ref))`.

---

## Internal Structure

### `loadSignal.ts`

```ts
arm(): void {
    if (this._pending !== null) {
        return;
    }

    let resolve: () => void = () => {};
    const promise = new Promise<void>(r => { resolve = r; });

    this._pending = { promise, resolve };
}

settle(): void {
    const pending = this._pending;

    this._pending = null;
    pending?.resolve();
}

whenSettled(): Promise<void> {
    return this._pending?.promise ?? Promise.resolve();
}
```

### `NavigatorTree.refresh` — arm and settle around the existing chain

```ts
refresh = (): void => {
    this._loaded.arm();

    void loadSchemas(this.conn, this.database)
        .then(async nodes => {
            // …unchanged body…
        })
        .catch(error => this.controller.notifyError(error))
        .finally(() => this._loaded.settle());
};
```

The `.finally` settles after the whole chain — including `_expansion.restore()` — so a reveal never races the expansion restore into re-collapsing the path it just opened.

### `RolesTree.refresh` — the same, plus one `await`

`RolesTree.refresh`'s first-login-role reveal is currently fired as `void this.revealByPredicate(…)` ([`RolesTree.ts:126`](frontend/src/roles/RolesTree.ts#L126)). It must be awaited, so the signal settles only after that reveal has finished scrolling:

```ts
if (!restored && firstUser) {
    await this.revealByPredicate(data => data === firstUser.name);
}
```

Without the `await`, a role route's own reveal can land first and then be scrolled away from by the default one.

### `ActivityBar.revealView`

```ts
revealView = (id: string): void => {
    if (this.collapsed) {
        // Rail buttons stay deselected while collapsed, so recording the id and
        // the deck page is all a later expand needs (toggleCollapsed re-runs
        // showView on activeId).
        this.activeId = id;
        this.card.setVisibleComponentId(id);

        return;
    }

    this.showView(id);
};
```

### The controller's two reveal helpers

```ts
private async revealNavigatorNode(match: NodeMatch): Promise<TreeNode | undefined> {
    this.showDatabaseView();
    await this._navigator?.whenLoaded();

    return (await this._navigator?.revealByPredicate(match)) ?? undefined;
}

private async revealRoleNode(name: string): Promise<TreeNode | undefined> {
    this.showRolesView();
    await this._rolesTree?.whenLoaded();

    return (await this._rolesTree?.revealByPredicate(matchesRole(name))) ?? undefined;
}
```

`selectObject` and `selectRole` add the selection on top:

```ts
selectObject(ref: DbObjectRef): void {
    // A database-wide ref names no navigator node (the tree is rooted at
    // schemas), so switch the view and stop — a search would lazily load every
    // schema's objects to find nothing.
    if (!ref.schema) {
        this.showDatabaseView();

        return;
    }

    void this.revealObject(ref).then(node => { if (node) { this._navigator?.selectNode(node); } });
}

selectRole(name: string): void {
    void this.revealRoleNode(name).then(node => { if (node) { this._rolesTree?.selectNode(node); } });
}
```

### `openReferencedTable` — same shape, one fewer promise dance

```ts
const revealed = this.revealNavigatorNode(matchesRelationName(ref));

void this.openTable(ref, revealed);
void revealed.then(node => { if (node) { this._navigator?.selectNode(node); } });
```

The reveal still runs concurrently with the open, so waiting on `whenLoaded()` never delays the tab.

---

## The route table's reveal calls

Every object-bearing handler in `appRouter.ts` gains exactly one statement, immediately before its `open*` call and after any view-segment check.

| Pattern | Added statement | Reveals |
|---|---|---|
| `/` | — | — |
| `/notes` | — | — |
| `/database/diagram` | `controller.selectObject(ref);` | nothing; switches to the Database view |
| `/schema/:schema/:view` | `controller.selectObject(ref);` | the schema node |
| `/schema/:schema/{table,view,matview}/:name` | `controller.selectObject(ref);` | the relation leaf |
| `/schema/:schema/{table,view,matview}/:name/:view` | `controller.selectObject(ref);` | the relation leaf |
| `/schema/:schema/sequence/:name` | `controller.selectObject(ref);` | the sequence leaf |
| `/schema/:schema/index/:name` | `controller.selectObject(ref);` | the index leaf |
| `/schema/:schema/function/:name` | `controller.selectObject(ref);` | the first leaf of that function name |
| `/role/{user,group,predefined}/:role` | `controller.selectRole(params.role);` | the role leaf |
| `/role/{user,group,predefined}/:role/:view` | `controller.selectRole(params.role);` | the role leaf |

Four handlers build their ref inline as a call argument today — `/database/diagram`, `/schema/:schema/sequence/:name`, `/schema/:schema/index/:name`, `/schema/:schema/function/:name`. Each extracts that object literal to a `const ref: DbObjectRef = …` local first, then reveals and opens:

```ts
router.register("/schema/:schema/sequence/:name", params => dispatch(controller, () => {
    const ref: DbObjectRef = {
        connectionId: controller.connectionId,
        database    : controller.database,
        schema      : params.schema,
        name        : params.name,
        kind        : "sequence",
    };

    controller.selectObject(ref);

    return controller.openSequence(ref);
}));
```

The two view-checking handlers already hold a `ref` local; the reveal goes after `const ref = …`, which itself sits after the `view === null` early return, so an unknown view segment reveals nothing.

---

## Ordered Implementation Steps

1. **Baseline.** `cd frontend && npm run typecheck && npm test` — both clean before any edit.

2. **Create `frontend/tests/data/loadSignal.test.ts`** with the `## Expected Behaviour` cases for `LoadSignal`. Red — the module does not exist.

3. **Create `frontend/src/data/loadSignal.ts`** per `## Public API` / `## Internal Structure`. Head it with a comment saying it is the DOM-free load-completion awaitable both explorer trees hang off, mirroring `DiagramView`'s `whenLaidOut` deferred. Check: `npx vitest run tests/data/loadSignal.test.ts` green.

4. **Create `frontend/tests/navigator/revealMatch.test.ts`** with the predicate cases from `## Expected Behaviour`. Red.

5. **Create `frontend/src/navigator/revealMatch.ts`** per `## Public API`. Import only `import type { DbObjectRef } from "../contract";`. Head it with a comment saying the predicates live here, free of library imports, so the node vitest harness can load them — mirroring `objectKinds.ts`'s own header. Green.

**Steps 6-11 land as one compiling unit.** `npm run typecheck` fails *between* them by design: adding `whenLoaded` to `ExplorerTree` breaks both trees until each implements it, and a new private hook is unused — which `noUnusedLocals` rejects — until its caller lands. Run the typecheck after step 11, not inside the run.

6. **`frontend/src/SqlAdminController.ts` — new state and hooks.**
   - Add `_rolesTree` beside `_navigator` ([line 233](frontend/src/SqlAdminController.ts#L233)), and `_showDatabaseView` / `_showRolesView` beside `_showQueriesView` ([line 253](frontend/src/SqlAdminController.ts#L253)); extend that block's comment, which currently lists three shell-injected handles.
   - Add `setRolesTree` right after `setNavigator` ([line 415](frontend/src/SqlAdminController.ts#L415)), and `setShowDatabaseView` / `setShowRolesView` right after `setShowQueriesView` ([line 2646](frontend/src/SqlAdminController.ts#L2646)).
   - Add the private `showDatabaseView()` / `showRolesView()` one-liners beside them.

7. **`frontend/src/navigator/NavigatorTree.ts`.** Add `whenLoaded(): Promise<void>` to the `ExplorerTree` interface ([line 102](frontend/src/navigator/NavigatorTree.ts#L102)) with a doc comment. Add `private readonly _loaded: LoadSignal = new LoadSignal();`, a `whenLoaded()` method returning `this._loaded.whenSettled()`, and the `arm()` / `.finally(settle)` bracket around `refresh`'s chain ([line 212](frontend/src/navigator/NavigatorTree.ts#L212)). Import `LoadSignal` from `../data/loadSignal`.

8. **`frontend/src/roles/RolesTree.ts`.** The same three additions to `refresh` ([line 116](frontend/src/roles/RolesTree.ts#L116)); change `void this.revealByPredicate(…)` to `await this.revealByPredicate(…)` ([line 126](frontend/src/roles/RolesTree.ts#L126)); add `this.controller.setRolesTree(this);` in the constructor, immediately before the `_expansion` assignment, with the same comment style as `NavigatorTree`'s `setNavigator` call ([`NavigatorTree.ts:195-196`](frontend/src/navigator/NavigatorTree.ts#L195)).

9. **`frontend/src/shell/ActivityBar.ts`.** Add the `revealView` arrow-function field per `## Internal Structure`, directly after `selectView` ([line 225](frontend/src/shell/ActivityBar.ts#L225)). Extend the file header's list of arrow-function fields to name it alongside `toggleCollapsed`/`setSizer`/`selectView`.

10. **`frontend/src/SqlAdminController.ts` — the reveal path.** Import `matchesObject, matchesRelationName, matchesGrantedTable, matchesRole` and the `NodeMatch` type from `./navigator/revealMatch`. Add `revealNavigatorNode` and `revealRoleNode` per `## Internal Structure`, placed beside the existing `revealObject` ([line 2287](frontend/src/SqlAdminController.ts#L2287)). Then rewrite three call sites to route through them:
    - `revealObject` ([line 2287](frontend/src/SqlAdminController.ts#L2287)) → `return this.revealNavigatorNode(matchesObject(ref));` (no longer `async`; keep and update its doc comment).
    - `openReferencedTable` ([line 2219](frontend/src/SqlAdminController.ts#L2219)) → the snippet in `## Internal Structure`.
    - `openGrantedTable` ([line 2958](frontend/src/SqlAdminController.ts#L2958)) → `const node = await this.revealNavigatorNode(matchesGrantedTable(schema, table));`, replacing its inline predicate. Its "not found in navigator" message stays for a genuine miss.

    `openReferencedSequence` and `openReferencedStructure` ([:2251](frontend/src/SqlAdminController.ts#L2251), [:2266](frontend/src/SqlAdminController.ts#L2266)) need no edit — they call `revealObject` and inherit the wait and the view switch through it.
    Add the public `selectObject` and `selectRole` per `## Internal Structure`, placed after `openReferencedStructure`.
    Check: `grep -c "revealByPredicate" frontend/src/SqlAdminController.ts` — exactly 2 (the two new helpers).

11. **`frontend/src/shell/SqlAdminShell.ts`.** Beside the existing `controller.setShowQueriesView(…)` ([line 140](frontend/src/shell/SqlAdminShell.ts#L140)), add:
    ```ts
    controller.setShowDatabaseView(() => sidebar.revealView(DATABASE_VIEW_ID));
    controller.setShowRolesView(() => sidebar.revealView(ROLES_VIEW_ID));
    ```
    Extend that block's comment to say the two new hooks let a programmatic reveal bring its tree's view forward, and that they use `revealView` (not `selectView`) so a collapsed sidebar stays collapsed. Check: `cd frontend && npm run typecheck` — clean again, closing the steps 6-11 unit.

12. **`frontend/src/shell/appRouter.ts`.** Add the reveal statement to each of the nine handlers in `## The route table's reveal calls`, extracting a `const ref: DbObjectRef` local in the four handlers that build their ref inline. Extend the file header to say each object-bearing route also reveals its object in the sidebar. Check: `grep -c "controller.selectObject(" frontend/src/shell/appRouter.ts` — 7; `grep -c "controller.selectRole(" frontend/src/shell/appRouter.ts` — 2.

13. **`README.md`** per `## Documentation Impact`.

14. **Verification** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/data/loadSignal.ts` |
| Create | `frontend/src/navigator/revealMatch.ts` |
| Create | `frontend/tests/data/loadSignal.test.ts` |
| Create | `frontend/tests/navigator/revealMatch.test.ts` |
| Modify | `frontend/src/navigator/NavigatorTree.ts` |
| Modify | `frontend/src/roles/RolesTree.ts` |
| Modify | `frontend/src/shell/ActivityBar.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Modify | `frontend/src/shell/appRouter.ts` |
| Modify | `README.md` |

---

## Expected Behaviour

### `LoadSignal` — *unit* (`tests/data/loadSignal.test.ts`)

| Sequence | Result |
|---|---|
| `whenSettled()` on a fresh signal | already resolved |
| `arm()`, then `whenSettled()` | pending |
| `arm()`, `whenSettled()`, `settle()` | resolves |
| `arm()`, `arm()`, `settle()` | one `settle()` resolves it — the second `arm()` did not replace the deferred |
| `arm()`, `whenSettled()` twice | the same promise object both times |
| `arm()`, `settle()`, `whenSettled()` | already resolved |
| `settle()` with nothing armed | no throw; `whenSettled()` still already resolved |
| `arm()`, `settle()`, `arm()`, `whenSettled()` | pending again — a re-armed signal waits for the new load |

### Reveal predicates — *unit* (`tests/navigator/revealMatch.test.ts`)

Against the node payload `{database: "app", schema: "sales", name: "orders", kind: "table"}` unless stated otherwise:

| Call | Result |
|---|---|
| `matchesObject({database: "app", schema: "sales", name: "orders", kind: "table"})` | `true` |
| `matchesObject({… kind: "sequence"})` | `false` |
| `matchesObject({… schema: "hr", …})` | `false` |
| `matchesObject({… database: "other", …})` | `false` |
| `matchesRelationName({… kind: "sequence"})` | `true` |
| `matchesRelationName({… name: "invoices"})` | `false` |
| `matchesGrantedTable("sales", "orders")` | `true` |
| `matchesGrantedTable("hr", "orders")` | `false` |
| any predicate against `undefined` | `false` |
| any predicate against `"analyst"` (a roles-tree payload) | `false` |
| any predicate against a category node's `undefined` data | `false` |
| `matchesRole("analyst")` against `"analyst"` | `true` |
| `matchesRole("analyst")` against `"readonly"` | `false` |
| `matchesRole("analyst")` against a `RoleGroupData` object | `false` |

### Manual verification (rail, tree, and network — outside the node harness)

Run against the seeded demo database (`db/init/*.sql`) with `npm run dev`. Type each URL into the address bar and reload — the route is read at boot.

1. **A deep-linked table is selected in the navigator.** Load `/schema/sales/table/invoices`. The data tab opens, the navigator expands `sales` → Tables, and `invoices` is highlighted and scrolled into view. (Before this change, nothing was selected.)
2. **A deep-linked role switches the rail.** Load `/role/user/analyst`. The sidebar switches from Database to Roles, Users expands, `analyst` is highlighted, and the grants tab is open.
3. **A deep-linked schema view selects the schema.** Load `/schema/sales/diagram`. The ER diagram tab opens and the `sales` schema node is selected (not expanded past itself).
4. **A deep-linked detail tab selects its object.** `/schema/sales/table/invoices/structure`, `/schema/sales/sequence/document_number_seq`, and `/schema/sales/index/invoices_pkey` each open their tab with the matching navigator leaf selected.
5. **The database diagram reveals nothing and crawls nothing.** Load `/database/diagram` with the browser's Network tab open. The diagram opens, the Database view is showing, no navigator node is selected, and there is **no** burst of one `/objects` request per schema.
6. **An overloaded function selects its first leaf.** Load `/schema/sales/function/price_with_tax?signature=p_price%20numeric`. The definition tab opens for the requested overload; the navigator selects the first `price_with_tax(…)` leaf (the predicate does not compare signatures).
7. **A missing object selects nothing.** Load `/schema/sales/table/does_not_exist`. The tab opens as it does today, the existing error toast appears, and no navigator node is selected.
8. **An invalid view segment reveals nothing.** Load `/schema/sales/table/invoices/definition`. The "no view matches" toast appears, no tab opens, and the navigator selection is unchanged.
9. **An FK jump from the Roles rail comes back to Database.** Open `/schema/sales/table/invoices/structure`, click the Roles rail button, then click the Structure tab's foreign-key link to `public.orders`. The sidebar switches back to Database, `orders` is revealed and selected, and its tab opens.
10. **A collapsed sidebar stays collapsed.** Collapse the sidebar (View → Toggle Sidebar), then click that same foreign-key link. The tab opens and the sidebar stays collapsed. Expand it: the Database view is showing with `orders` selected.
11. **A granted table opens at boot.** Load `/role/user/analyst/grants-diagram` and double-click a table node as soon as the graph paints. The table's tab opens and the navigator reveals it. (Before this change, an early double-click status-barred `… not found in navigator` and opened nothing.)
12. **Tab switching does not move the rail.** With a table tab and a role grants tab both open, click between them. The rail stays on whichever view it was showing; the navigator selection still follows the table tab as it does today.
13. **The roles tree's own gestures are unchanged.** Double-click `readonly` in the Roles tree: its grants tab opens, it stays selected, and the rail does not move.
14. **A reveal during a tree refresh still lands.** Click the navigator section's Refresh tool and immediately click a foreign-key link in an open Structure tab. The reveal resolves against the reloaded tree — the target ends up selected, not lost.
15. **Boot is unaffected when no route matches.** Load `/nope/at/all`. The "no view matches" toast appears, the start page stays, the navigator finishes loading normally, and the rail is untouched.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — the two new suites green, the rest unchanged.
- `cd frontend && npm run build`.
- `grep -c "revealByPredicate" frontend/src/SqlAdminController.ts` — 2 (only `revealNavigatorNode` and `revealRoleNode`).
- `grep -rn "whenLoaded" frontend/src/` — declared once in `ExplorerTree`, implemented once each in `NavigatorTree` and `RolesTree`, awaited only in the controller's two reveal helpers.
- `grep -c "controller.selectObject(" frontend/src/shell/appRouter.ts` — 7; `grep -c "controller.selectRole(" frontend/src/shell/appRouter.ts` — 2.
- `grep -c "sidebar.revealView(" frontend/src/shell/SqlAdminShell.ts` — 2 (the two new hooks). `grep -c "selectView(" frontend/src/shell/SqlAdminShell.ts` — 7, unchanged: the three View-menu items, the three rail accelerators, and the Queries hook.
- Manual cases 1-15 above. Entry point: `npm run dev` in `frontend` with the backend running.

---

## Documentation Impact

- **`README.md`** — the **Deep links** bullet ([lines 28-35](README.md#L28)) ends with "Links are read on load only — the address bar does not yet follow in-app navigation." Add a sentence before that clause: a deep link also brings the object's sidebar view forward and selects the object in its tree.
- **`CHANGELOG.md`** — no entry; changelog text is written at release time, not in feature work.
- **`frontend/COMPONENT_CONVENTIONS.md`** — no change. `revealView` is an arrow-function field per section (c) because the shell passes it by reference, which the existing `selectView` already establishes.
- **`TODO.md`** — no change. The **Shareable link UI** bullet covers link *generation*, which this plan does not touch.

---

## Potential Challenges

- **`router.start()` must stay after the shell is mounted.** `whenLoaded()` resolves immediately when no load is armed, so a route applied before `NavigatorTree`'s constructor ran would reveal against an empty tree — exactly the bug being fixed. [`SqlAdminApp.ts:36-47`](frontend/src/SqlAdminApp.ts#L36) already pins that order and its comment says why; do not move `router.start()`.
- **A missing object still crawls the tree.** `revealByPredicate` is depth-first over every root, lazily loading each branch, so a reveal for an object that is not there fetches every schema's objects before returning null. That cost is pre-existing (`openReferencedTable` already pays it); manual case 7 only asserts the selection, not the request count.
- **`RolesTree`'s default first-user reveal must be awaited.** Leaving it as `void` lets the signal settle early, so a role route's own reveal can be scrolled away from by the default one landing afterwards.
- **`.finally` on a chain that already has `.catch`.** Attach `.finally(() => this._loaded.settle())` after the existing `.catch`, so the signal settles on both the success and the failure path. Attaching it before the `.catch` would settle before `notifyError` runs — harmless today, but it makes the settle point depend on handler order.
- **`selectNode` does not emit `"selection"`.** The reveal therefore does not repopulate the Properties inspector; the opened tab's own `syncToPanel` already does that. Do not "fix" this by emitting a selection event — it would fire a second `showProperties` fetch per open.
- **`noUnusedParameters` and `verbatimModuleSyntax`.** `NodeMatch` comes into the controller through `import type`; the four predicate functions come in as value imports.

---

## Critical Files

| File | Why |
|---|---|
| [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) | The `ExplorerTree` interface both trees implement, the constructor's `setNavigator` registration this plan mirrors for roles, and the `refresh` chain the signal brackets. |
| [`frontend/src/roles/RolesTree.ts`](frontend/src/roles/RolesTree.ts) | The second `ExplorerTree`, its un-awaited default reveal, and the tree that today registers with nothing. |
| [`frontend/src/data/treeExpansion.ts`](frontend/src/data/treeExpansion.ts) | The precedent for the two new pure modules: a DOM-free helper both trees hold, with a narrow host interface so its logic unit-tests against a plain object. Its header states the import rule (`import type` only) the new modules follow. |
| `typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts` (sibling repo) | `_layoutSettled` / `armLayoutSettled` / `settleLayout` / `whenLaidOut` — the deferred `LoadSignal` copies. Read before writing `loadSignal.ts`. |
| `typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts` (sibling repo) | `revealByPredicate` (searches `_nodes`, expands ancestors, scrolls) and `selectNode` (no-ops for a node not in the flattened rows, emits no event) — the two calls every reveal composes. |
| [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) | `setShowQueriesView`/`_showQueriesView` (2646, 253) is the hook shape the two new rail hooks copy; `openReferenced*` (2219, 2251, 2266) is the open-plus-reveal pairing the route layer copies; `syncToPanel` (3196) is the focus-driven selection that stays as it is. |
| [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts) | The one place hooks are injected (140) and the only place rail views are named (72-74). |
| [`frontend/src/shell/ActivityBar.ts`](frontend/src/shell/ActivityBar.ts) | `showView`/`collapse`/`setCollapsed` — what `revealView` must and must not touch. |
| [`frontend/src/shell/appRouter.ts`](frontend/src/shell/appRouter.ts) | Every handler that gains a reveal statement. |
| [`plans/implemented/router-deep-linking.md`](plans/implemented/router-deep-linking.md) | The plan this one follows on from. Its "Route handlers call the plain `open*` methods" decision and its navigator-reveal Non-Goal are what this plan retires. |
| [`plans/implemented/diagram-layout-settled-and-root-focus.md`](plans/implemented/diagram-layout-settled-and-root-focus.md) | The structural sibling: a new awaitable added to signal an async step's completion, plus an optional-probe seam in the controller. Read its `## Architecture Decisions`. |

---

## Non-Goals

- **Generating a shareable link, or keeping the address bar in step with in-app navigation.** Both tracked in `TODO.md` under **Shareable link UI**; no `router.navigate` or `getHref` call is added.
- **Any change to the URL scheme.** The patterns, path/query split, and role buckets shipped in `router-deep-linking` are unchanged.
- **Switching the rail when a dock tab is merely focused.** The sidebar follows an open, not a focus — see the matching Architecture Decision.
- **Syncing `RolesTree`'s selection when a role tab is focused.** A role's tabs are not registered in `_openPanels` (they carry no `DbObjectRef`), so `syncToPanel` never runs for them and there is no per-tab record to sync from. Closing that gap means a second panel registry keyed by role, which none of the reported symptoms need.[^roles-focus-sync]
- **Validating a role route's bucket segment.** `/role/group/analyst` still opens and reveals `analyst` even though `analyst` is a Users-bucket role. `router-deep-linking` decided this deliberately; the roles tree now being loadable does not reopen it.
- **Unifying the two navigator predicates.** See the matching Architecture Decision.
- **Revealing a function's exact overload.** `matchesObject` compares name and kind, not signature, so an overloaded routine reveals its first leaf.

---

## Notes

[^ready-is-a-promise]: An event (`tree.on("loaded", …)`) was the alternative and loses on two counts. A listener registered after the load already fired never runs, so every caller would need the "did it already happen?" flag that a promise carries for free — and the callers here are exactly the late ones (a route handler runs after the tree was constructed, an FK click minutes later). `Tree`'s event vocabulary is also a fixed union in the library (`"selection" | "loaderror" | "contextmenu" | "dblclick" | "expand" | "collapse"`), so a `"loaded"` event would mean either a library change or a second, app-only dispatcher beside the inherited one. A promise needs neither, and the app already has this exact shape: `DiagramView.whenLaidOut()` returns `this._layoutSettled?.promise ?? Promise.resolve()`, and `SqlAdminController.awaitDiagramLayout` awaits it to hold a lazy tab's spinner until a diagram has placed its nodes. `router-deep-linking` recorded the navigator race as unfixable-here because no such signal existed; it exists after this plan.

[^signal-is-shared]: `NavigatorTree` and `RolesTree` have identical `refresh` shapes — arm, fetch, `setNodes`, restore expansion, settle — so the deferred would be copied verbatim into both. Putting it in `frontend/src/data/` follows `treeExpansion.ts`, which factored the other piece of shared tree behaviour the same way and for the same second reason: a class with no library imports runs under the node vitest environment, where a tree class itself cannot (the library's component modules touch `document` at import scope). The alternative — a shared base class between the two trees — would fix the duplication too, but both already `extends Tree`, so it means an intermediate class carrying one field for two subclasses.

[^open-not-focus]: Hooking the dock's `"focus"` event instead would move the rail on every tab switch. It was rejected for three reasons. It fixes only part of the problem: role tabs are not in `_openPanels`, so a focus-driven sync would cover database objects and silently skip roles — the asymmetry that makes the current behaviour confusing in the first place. It also fires on gestures the user did not frame as navigation: clicking a dock tab to read it would yank a sidebar the user had deliberately pointed elsewhere. And it changes established click-path behaviour, which none of the reported symptoms ask for. Tying the reveal to the open keeps one statable rule and leaves `syncToPanel` — which already selects the navigator node of a focused tab that has one — exactly as it is.

[^reveal-view]: `selectView` calls `showView`, which ends in `setCollapsed(false)`; reusing it would pop a collapsed sidebar open every time an FK link, a diagram node, or a deep link revealed something. That is right for a menu item named "Open Saved…" — the user asked to see a list — and wrong for a side effect of opening a tab, where the user asked to see the *tab*. The two are kept as separate methods rather than one with an option flag, because every call site is a compile-time constant choice and a boolean parameter at the call site (`selectView(id, false)`) reads as nothing at all. `revealView`'s collapsed branch deliberately does not touch the rail buttons: `collapse()` deselects all of them, and lighting one while its deck page is hidden would show an active view that is not visible. Recording `activeId` is enough, because `toggleCollapsed` re-runs `showView(this.activeId)` on the way back out.

[^not-open-referenced]: Switching the route handlers to `openReferencedTable` / `openReferencedSequence` / `openReferencedStructure` was the obvious move once reveals work, and it fails on coverage. Those three wrappers cover a table's data tab, a sequence's info tab, and a table's Structure tab — three of the eleven route targets. Nothing equivalent exists for a definition, an index, a function, any of the six diagram views, or a role, so the route table would end up half revealing through a wrapper and half through an explicit call. Two smaller problems compound it: `openReferencedTable(ref)` takes only a ref, so `/schema/:schema/table/:name?rotated=true&record=42` could not pass its `TableViewOptions` without widening the wrapper's signature; and it reveals with the kind-blind `matchesRelationName` predicate, while a route always knows the exact kind from its own path segment and should use the stricter one. A third option — making every `open*` method reveal when its `node` argument is `undefined` — would have left `appRouter.ts` untouched, but it changes the contract of thirteen public methods to fix a caller-side omission, and it silently redefines "I have no tree node" as "reveal one", which the six diagram openers (whose `_node` parameter is currently ignored entirely) never meant.

[^two-predicates]: `matchesRelationName` is the predicate `openReferencedTable` uses today, and it must stay kind-blind. Four of its eight call sites hardcode `kind: "table"` while the diagram node they came from may be a view or a materialized view; tightening the predicate to compare kind would silently stop revealing those. `matchesObject` compares kind because `openReferencedSequence` and `openReferencedStructure` need it — a sequence and a table can share a schema and a name — and a route's kind comes from its own URL segment, so it is always exact. Extracting both to `revealMatch.ts` is what makes the difference visible and testable; folding them into one rule is a separate change with a regression risk this plan cannot cheaply verify.

[^no-schema-guard]: `NavigatorTree` is rooted at schemas — the app connects to one database per session, so there is no database node — and `revealByPredicate` walks depth first, calling `loadChildren` on each branch it descends. A search for `{kind: "database"}` therefore visits every schema, issues that schema's four introspection requests (`/objects`, `/functions`, `/types`, `/indexes`), and returns null. On the seeded demo database that is a dozen wasted requests at boot for the one route that can never match. The guard keys on `schema` rather than on `kind === "database"` so any future schema-less ref is covered by the same rule.

[^roles-focus-sync]: The framing that `RolesTree`'s missing focus sync shares a root cause with the navigator's was checked against the code and only half holds. The shared half is real and fixed here: `RolesTree` had no ready signal and was never registered with the controller, so nothing could drive its selection at all. The other half is a different defect. `openRoleGrants`, `openRoleGrantsDiagram`, and `openRoleMembershipDiagram` never call `_openPanels.set` — the registry entry requires a `DbObjectRef`, and a role is a bare name — so `syncToPanel` returns at its first line for every role tab, and the dock's `"focus"` listener has nothing to read. Fixing that means a parallel registry (`Map<panelId, roleName>`) written by all three openers and read by the focus listener. That is a self-contained change with no bearing on the deep-linking symptoms this plan addresses, so it stays out.
