---
touches-shared:
  - frontend/src/shell/DatabaseExplorerView.ts
  - frontend/src/shell/RolesExplorerView.ts
  - frontend/src/shell/treeExplorerView.ts
---

# Class-First Explorer Trees — Implementation Plan

## Overview

Convert the two sidebar tree *builders* — `NavigatorTree` ([`frontend/src/navigator/NavigatorTree.ts:66`](frontend/src/navigator/NavigatorTree.ts#L66)) and `RolesTree` ([`frontend/src/roles/RolesTree.ts:40`](frontend/src/roles/RolesTree.ts#L40)) — from capitalized factory functions that `new` a library `Tree` and return a hand-rolled `{ tree, refresh }` handle, to **class-first** components that `extends Tree` directly (per [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md)). After the change the instance *is* the tree; `refresh` becomes a public arrow-field on it.

`Tree` is the callable library base both builders already `new` ([`.../component/tree/Tree.d.ts`](frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/tree/Tree.d.ts) exports it as `export { Tree as _Tree, TreeCallable as Tree }` with `type TreeCallable = Tree`, so the name `Tree` is simultaneously a constructable value and the instance type — the same shape as `Container`, which `ActivityBar` extends). This is a faithful handle→class conversion mirroring the `ActivityBar` precedent ([`frontend/src/shell/ActivityBar.ts`](frontend/src/shell/ActivityBar.ts), which deleted its `ActivityBarHandle`).

The shared contract `ExplorerTree` ([`frontend/src/navigator/NavigatorTree.ts:60`](frontend/src/navigator/NavigatorTree.ts#L60)) is **kept**, not deleted (see decision below). It is consumed polymorphically by `buildTreeExplorerView` ([`frontend/src/shell/treeExplorerView.ts:36`](frontend/src/shell/treeExplorerView.ts#L36)) over both trees, so it stays as the one shared type — but reshaped from a `{ tree; refresh }` handle into an interface that extends `Tree`.

The three shell-view files touched (`DatabaseExplorerView.ts`, `RolesExplorerView.ts`, `treeExplorerView.ts`) are shell factories that a future `class-first-shell-views.md` plan may also convert; they are flagged `touches-shared` (that plan is not yet drafted — no file exists in `plans/`, `plans/implemented/`, or any `feature/class-first-shell-views` commit at write time).

---

## Architecture Decisions

### Keep `ExplorerTree` — reshape it, don't delete it

`ActivityBar` deleted its handle because nothing consumed it polymorphically. `ExplorerTree` is different: `buildTreeExplorerView` accepts *either* tree through the one `TreeExplorerConfig.explorer: ExplorerTree` field ([`treeExplorerView.ts:16`](frontend/src/shell/treeExplorerView.ts#L16)), and `RolesTree.ts` imports the type from `NavigatorTree.ts` ([`RolesTree.ts:20`](frontend/src/roles/RolesTree.ts#L20)). It is a genuine shared contract, so it stays — but its shape changes from a handle to a tree-subtype:

```ts
// Before: a handle wrapping the tree.
export interface ExplorerTree { tree: Tree; refresh: () => void; }
// After: a Tree that also exposes refresh.
export interface ExplorerTree extends Tree { refresh(): void; }
```

An interface may extend a class type; because `Tree` has `private` members, only `Tree` subclasses satisfy `ExplorerTree` — both `NavigatorTree` and `RolesTree` extend `Tree`, so both qualify. This keeps `buildTreeExplorerView` polymorphic while dropping the `.tree` indirection.

### `extends Tree` (the callable), not `Panel`/`Container`

Both builders `new` exactly `Tree()` and add tree-specific wiring (`setRendererFactory`, `on("selection"|"dblclick"|"contextmenu"|"loaderror")`, `setNodes`, `revealByPredicate`). The faithful base is `Tree` itself — import the callable `Tree` from `@jimka/typescript-ui/component/tree` (already imported in both files) and `extends` it. Do **not** use the `_Tree` raw alias (convention (a)).

### `refresh` must be a public arrow-function field

`refresh` is passed **by reference** twice in `buildTreeExplorerView`: `refreshTool(refresh)` (which does `button.on("action", onRefresh)`, [`refreshTool.ts:20`](frontend/src/shell/refreshTool.ts#L20)) and `bindRefreshShortcut(view, refresh)` ([`refreshTool.ts:33`](frontend/src/shell/refreshTool.ts#L33)). A plain method would lose `this` when detached. Per convention (c) it becomes a public arrow-field: `refresh = (): void => { ... }`. A property of function type satisfies the interface's `refresh(): void` member.

### `implements ExplorerTree` on both classes

Add `implements ExplorerTree` to both classes. It is redundant for assignability (they satisfy it structurally by extending `Tree` + adding `refresh`) but pins the contract at the class definition, so a signature drift errors at the class rather than only at the `buildTreeExplorerView` call site.

### Super-cascade is trivial here

`Tree()` takes no options in either builder, so the constructor is `super()` then all wiring post-`super()` (convention (b)). No option-cascade setter writes any field, so plain field assignment suffices — no `declare` needed. Build `refresh` as an arrow-field (initialized right after `super()`); it only *reads* `this.controller`/`this.conn` when invoked, which happens at the end of the constructor body after those are assigned, so field-init ordering is safe.

### Module-level pure helpers stay module-level

`nodeGlyph`, `isRelation`, `OBJECT_CATEGORIES`, `CATEGORY_GLYPH`, `loadDatabases`, `databaseNode`, `loadSchemas`, `schemaNode`, `loadObjects`, `categoryNode`, `objectLeaf` (Navigator) and `roleRowGlyph` + the `Glyph.register(...)` calls (Roles) take everything as parameters and don't touch instance state — they stay module-level functions/consts (convention (c) end).

### `constructor.name` → CSS class name

The class-first instances report `"NavigatorTree"` / `"RolesTree"` as their CSS class instead of the generic `"Tree"` (`vite.config.ts` `keepNames: true` makes this minify-safe). Grep confirmed no app CSS targets a `.Tree` selector under `navigator/` or `roles/`.

---

## Public API

```ts
// frontend/src/navigator/NavigatorTree.ts
export interface ExplorerTree extends Tree {
    refresh(): void;
}

export class NavigatorTree extends Tree implements ExplorerTree {
    constructor(controller: SqlAdminController);
    refresh: () => void;   // public arrow-field
}
```

```ts
// frontend/src/roles/RolesTree.ts
export class RolesTree extends Tree implements ExplorerTree {
    constructor(controller: SqlAdminController);
    refresh: () => void;   // public arrow-field
}
```

The base `Tree` methods used by callers (`setNodes`, `revealByPredicate`, `selectNode`, `setPreferredSize`, `on`, `setRendererFactory`) are inherited unchanged.

---

## Internal Structure

`NavigatorTree` constructor shape (order is load-bearing per convention (b)):

```ts
export class NavigatorTree extends Tree implements ExplorerTree {
    private readonly controller: SqlAdminController;
    private readonly conn:       string;
    private readonly contextMenu = Menu();   // field-init: runs after super(), no `this` needed

    constructor(controller: SqlAdminController) {
        super();                             // Tree() takes no options
        this.controller = controller;
        this.conn       = controller.connectionId;

        this.setRendererFactory(() => new IconLabelTreeNodeRenderer(nodeGlyph));
        this.on("selection",   (nodes) => { /* ...unchanged body... */ });
        this.on("dblclick",    (node)  => { /* ...unchanged body... */ });
        this.on("contextmenu", (node, event) => { /* uses this.contextMenu, this.controller */ });
        this.on("loaderror",   (_node, error) => this.controller.notifyError(error));

        this.controller.setNavigator(this);  // was setNavigator(tree); `this` is a Tree
        this.refresh();                       // initial load
    }

    refresh = (): void => {
        void loadDatabases(this.conn)
            .then(nodes => this.setNodes(nodes))
            .catch(error => this.controller.notifyError(error));
    };
}
```

`RolesTree` is the same pattern minus `setNavigator` (Roles is not the navigator) and with the Roles-specific handler bodies and refresh (`this.controller.loadRoles()` → `this.setNodes(groupRoles(roles))` → `this.revealByPredicate(...)`). Its `refresh` closes over `this.controller` only (no `conn`). Keep the module-scope `Glyph.register(...)` calls where they are.

`buildTreeExplorerView` ([`treeExplorerView.ts:37`](frontend/src/shell/treeExplorerView.ts#L37)) — the explorer no longer has a `.tree`; it *is* the tree:

```ts
// Before:
const { tree, refresh } = config.explorer;
// After:
const tree    = config.explorer;                 // the Tree instance itself
const refresh = config.explorer.refresh;         // bound arrow-field, safe by reference
```

The rest of the body (`tree.setPreferredSize(0, 0)`, `component: tree`, `tools: [refreshTool(refresh)]`, `bindRefreshShortcut(view, refresh)`) is unchanged.

---

## Ordered Implementation Steps

1. **`frontend/src/navigator/NavigatorTree.ts`** — reshape the interface: replace `export interface ExplorerTree { tree: Tree; refresh: () => void; }` with `export interface ExplorerTree extends Tree { refresh(): void; }`.
2. Same file — convert `export function NavigatorTree(controller): ExplorerTree { ... }` into `export class NavigatorTree extends Tree implements ExplorerTree`. Follow the Internal Structure skeleton: add `private readonly controller`, `private readonly conn`, `private readonly contextMenu = Menu()` fields; move builder body into the constructor as `super()` → field assignments → `this.setRendererFactory` / `this.on(...)` (replace every `tree.` with `this.`) → `this.controller.setNavigator(this)` → `this.refresh()`. Convert the `refresh` closure into a public arrow-field. Delete the trailing `return { tree, refresh };` and the `const tree = Tree()` / `const contextMenu = Menu()` locals. Leave all module-level helper functions/consts untouched.
3. **`frontend/src/roles/RolesTree.ts`** — convert `export function RolesTree(controller): ExplorerTree { ... }` into `export class RolesTree extends Tree implements ExplorerTree`. Same transform: `super()` → `this.controller = controller` → `this.setRendererFactory` / `this.on(...)` (replace `tree.` with `this.`, including `this.setNodes` / `this.revealByPredicate` inside `refresh`) → `this.refresh()`. `refresh` becomes a public arrow-field over `this.controller`. Keep the imported `ExplorerTree` type and the module-scope `Glyph.register(...)` calls. No `setNavigator` call.
4. **`frontend/src/shell/treeExplorerView.ts`** — replace `const { tree, refresh } = config.explorer;` with `const tree = config.explorer;` and `const refresh = config.explorer.refresh;`. Nothing else changes; the `ExplorerTree` import and `TreeExplorerConfig.explorer: ExplorerTree` field stay.
5. **`frontend/src/shell/DatabaseExplorerView.ts`** — change `explorer: NavigatorTree(controller),` ([line 22](frontend/src/shell/DatabaseExplorerView.ts#L22)) to `explorer: new NavigatorTree(controller),`. Import line stays (value import of the now-class).
6. **`frontend/src/shell/RolesExplorerView.ts`** — change `explorer: RolesTree(controller),` ([line 21](frontend/src/shell/RolesExplorerView.ts#L21)) to `explorer: new RolesTree(controller),`.
7. **Checkpoint** — `grep -rn 'NavigatorTree(\|RolesTree(' frontend/src` should show only the two `new NavigatorTree(`/`new RolesTree(` call sites plus the `class` declarations; zero bare-factory calls remain. `grep -rn 'Tree()' frontend/src` should return zero (both `Tree()` locals removed). `grep -rn '\.tree\b' frontend/src` should return zero references to the old handle field.
8. **Checkpoint** — from `frontend/`: `npm run typecheck` clean.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/navigator/NavigatorTree.ts` (interface reshape + class conversion) |
| Modify | `frontend/src/roles/RolesTree.ts` (class conversion) |
| Modify | `frontend/src/shell/treeExplorerView.ts` (drop `.tree` destructuring) — **touches-shared** |
| Modify | `frontend/src/shell/DatabaseExplorerView.ts` (`new NavigatorTree`) — **touches-shared** |
| Modify | `frontend/src/shell/RolesExplorerView.ts` (`new RolesTree`) — **touches-shared** |

No files created or deleted (`ExplorerTree` is kept and reshaped in place).

---

## Expected Behaviour

Behaviour must be identical to today — this is a structural refactor. Concretely:

- **Type-level (unit-testable via `tsc --noEmit`):**
  - `new NavigatorTree(controller)` and `new RolesTree(controller)` are assignable to `ExplorerTree` and to `Tree`/`Component`.
  - `TreeExplorerConfig.explorer` accepts each `new`-ed instance directly (no `.tree` wrapper).
  - `controller.setNavigator(new NavigatorTree(controller))` typechecks (`setNavigator(tree: Tree)` at [`SqlAdminController.ts:251`](frontend/src/SqlAdminController.ts#L251)).
- **Runtime / DOM-bound (manual-verify — the vitest harness cannot exercise the live `Tree` DOM):**
  - Database rail renders the databases → schemas → Tables/Views/Materialized-Views categories → object leaves; lazy expansion still fetches on first open and caches on re-expand.
  - Single-click a leaf shows its Properties; double-click a relation opens its data tab; right-click a table/view/matview opens the context menu (Open/Show data, Open as query, structure, diagrams, Export submenu) and its actions fire; database/schema nodes show their diagram menus.
  - Roles rail renders Users/Groups/Predefined groups; the first login role is revealed on load; select/dblclick/right-click behave as before (Show data, membership/grants graphs, Export grants).
  - The section-header refresh tool **and** Alt+R (while the rail has focus) reload each tree's top level — this is the arrow-field-by-reference path; verify both trees refresh (not just the initially-focused one), confirming `this` binding survived.
  - `loaderror` still routes to `controller.notifyError` (e.g. induce a failed load).

---

## Verification

- `frontend/` → `npm run typecheck` (`tsc --noEmit`) — clean.
- `frontend/` → `npm test` — `src/roles/groupRoles.test.ts` still passes (it tests the untouched module-level `groupRoles`; no test covers the DOM-bound trees).
- `frontend/` → `npm run build` — clean.
- Grep invariants from steps 7: zero `Tree()` locals, zero bare `NavigatorTree(`/`RolesTree(` factory calls, zero `.tree` handle accesses.
- Manual smoke test in the running app: launch, sign in, exercise both the **Database** and **Roles** activity-bar rails per Expected Behaviour (render, expand, select, double-click, right-click menu opens tables/diagrams, refresh tool + Alt+R).

---

## Potential Challenges

- **Field-init vs constructor-body ordering:** `refresh` (arrow-field) initializes right after `super()`, *before* `this.controller`/`this.conn` are assigned in the body — safe because `refresh` only reads them when *called* (at the end of the constructor). Don't move the `this.refresh()` initial-load call above the `this.controller = ...` assignment.
- **Interface-extends-class satisfaction:** `interface ExplorerTree extends Tree` inherits `Tree`'s private members, so only `Tree` subclasses satisfy it. This is intended (both classes extend `Tree`); a non-`Tree` object can no longer be passed as an `ExplorerTree`, which is correct for the new contract.
- **Shared shell-view overlap:** if `class-first-shell-views.md` is drafted/implemented and also rewrites `DatabaseExplorerView`/`RolesExplorerView`/`treeExplorerView`, coordinate — both plans edit the same lines (`new NavigatorTree` / `new RolesTree` / the `explorer` destructuring). Whichever lands second must re-apply the other's `new`/destructuring change.

---

## Critical Files

- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — the class-first rules (a)–(e); (b) super-cascade, (c) arrow-field handlers, (d) instance-is-component.
- [`frontend/src/shell/ActivityBar.ts`](frontend/src/shell/ActivityBar.ts) — the in-repo handle→class precedent (deleted `ActivityBarHandle`, arrow-field public API).
- [`frontend/src/shell/LoginForm.ts`](frontend/src/shell/LoginForm.ts) — locals → `super({...})` → field-assignment template.
- [`.../component/tree/Tree.d.ts`](frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/tree/Tree.d.ts) — the base being extended; confirms `Tree` is the callable export and lists inherited `setNodes`/`revealByPredicate`/`selectNode`/`on`/`setRendererFactory`.
- [`frontend/src/shell/refreshTool.ts`](frontend/src/shell/refreshTool.ts) — proves `refresh` is passed by reference (→ arrow-field).
- [`frontend/src/SqlAdminController.ts:251`](frontend/src/SqlAdminController.ts#L251) — `setNavigator(tree: Tree)`, the consumer of `this`.

---

## Non-Goals

- Not converting the shell views (`DatabaseExplorerView`, `RolesExplorerView`, `buildTreeExplorerView`) to classes — they stay factory functions here; only their internal call to the tree builders changes. Converting them is the `class-first-shell-views` plan's job.
- Not touching the inspector handles (`controller.properties.component`, `controller.rolesProperties.component`) — unrelated `.component` handles, out of scope.
- Not migrating other builders or altering any tree behaviour, wire protocol, glyphs, or menu contents.
