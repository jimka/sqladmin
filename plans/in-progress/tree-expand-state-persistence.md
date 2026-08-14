---
touches-shared: [frontend/src/navigator/NavigatorTree.ts]
---

# Tree Expand State Persistence — Implementation Plan

## Overview

The Database and Roles sidebar trees start fully collapsed on every page load. Whatever the user drilled into — a schema, its "Tables" group, a roles section — is thrown away by the reload. This plan persists which *nodes inside* each tree are expanded, and re-expands them on the next load.

The saved state rides in the two `LayoutStore` site blobs that already exist for these rails: `sqladmin.layout.<user>.database` and `sqladmin.layout.<user>.roles` ([`frontend/src/data/layoutStore.ts:25`](frontend/src/data/layoutStore.ts#L25)). `LayoutStore` gains a third binding factory, `bindTreeExpansion`, alongside `bindSplit` and `bindAccordion`. A new pure module, `frontend/src/data/treeExpansion.ts`, turns the tree's expanded nodes into serializable key paths and drives the restore. [`NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) and [`RolesTree.ts`](frontend/src/roles/RolesTree.ts) each wire it in a handful of lines.

This is **not** the Accordion open/collapsed state (whether the rail's tree section or its inspector section is open). That is already persisted through `LayoutStore.bindAccordion("database" | "roles")` ([`layoutStore.ts:200`](frontend/src/data/layoutStore.ts#L200)), wired at [`treeExplorerView.ts:94`](frontend/src/shell/treeExplorerView.ts#L94), and is untouched here.

**This plan has a hard prerequisite on `@jimka/typescript-ui`.** The library's `Tree` today has no way for a consumer to observe or read back which nodes are expanded, and no way to await a lazy node's expansion. Three additions to `Tree` are required before implementation can start — see `## Library Prerequisite`.

---

## Library Prerequisite

`Tree` tracks expansion in a private `_expandedNodes` set ([`Tree.ts:124`](../../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L124)) with no public getter, and its `TreeEvent` union ([`Tree.ts:22`](../../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L22)) carries no expand or collapse event. `expandNode(node)` returns `this` and gives no signal when a lazy node's `loadChildren` has resolved ([`Tree.ts:655`](../../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L655)).

**These additions are a dependency of this plan, not part of it** — building them is separate work in `/home/jika/typescript/typescript-ui`, outside this repo, and is not scoped here.[^library-not-scoped]

```ts
// packages/lib/src/typescript/lib/component/tree/Tree.ts

export type TreeEvent = "selection" | "loaderror" | "contextmenu" | "dblclick" | "expand" | "collapse";

export interface TreeOptions extends ComponentOptions {
    listeners?: {
        // …existing entries unchanged…
        expand?:   (node: TreeNode) => void;
        collapse?: (node: TreeNode) => void;
    };
}

class Tree extends VirtualRowView<TreeRow, TreeOptions> {
    /** Every currently expanded node, in no guaranteed order. Mirrors `getSelectedNodes()`. */
    getExpandedNodes(): TreeNode[];

    /**
     * Expands `node` and resolves once the expansion has committed, awaiting
     * `loadChildren` first for an unloaded lazy node.
     *
     * Resolves `true` when the node ends up expanded (including when it already
     * was), `false` when a lazy load rejected and the node stayed collapsed.
     * When a load for `node` is already in flight, resolves with that load's
     * outcome rather than starting a second one.
     */
    expandNodeAsync(node: TreeNode): Promise<boolean>;

    on(event: "expand",   listener: (node: TreeNode) => void): this;
    on(event: "collapse", listener: (node: TreeNode) => void): this;
}
```

`"expand"` fires after an expansion commits — for a lazy node, after its children are loaded and attached, not when the toggle was requested. `"collapse"` fires when a node leaves the expanded set. Neither fires from `setNodes()`, which drops the whole dataset rather than toggling anything.

This plan does **not** require `expandAll()` or `revealByPredicate()` to emit the events.[^reveal-emission]

---

## Architecture Decisions

### The saved state lives in the existing `LayoutStore` site blob

`LayoutStore` gains `bindTreeExpansion(site)` beside `bindSplit` and `bindAccordion`, writing an `expanded` field into the same per-site JSON object those two already share ([`layoutStore.ts:58`](frontend/src/data/layoutStore.ts#L58), [`:282`](frontend/src/data/layoutStore.ts#L282)). The Database rail's whole persisted UI state — gutter position, section open flags, expanded nodes — ends up under one key, `sqladmin.layout.<user>.database`.[^why-layoutstore]

No new key prefix is introduced, so the localStorage inspector's `.`-split key grouping ([`localStorageWindow.ts:108`](frontend/src/shell/localStorageWindow.ts#L108)) already shows the value in the right place, and "Clear SQLAdmin data" already removes it. Neither file changes.

A stored blob now looks like this:

```json
{
  "sizes":    [{ "unit": "ratio", "value": 1 }, { "unit": "px", "value": 220 }],
  "open":     [true, true],
  "expanded": [["public"], ["sales"], ["sales", "Tables"]]
}
```

### A node is identified by a path of per-tree key segments

Each expanded node is stored as the list of key segments from a root down to it — one segment per level. A tree supplies a `NodeKey` function deciding a node's segment. The default is the node's `label`; the Roles tree overrides it, because its group labels carry a live member count that changes as roles are created or dropped.

| Tree | Node | `label` | `data` | Key segment | Why |
|---|---|---|---|---|---|
| Database | schema | `public` | `{ kind: "schema", schema: "public", … }` | `public` | The label *is* the schema name, and schema names are unique |
| Database | category group | `Tables` | `undefined` | `Tables` | `data` is undefined here, so the label is the only identity available |
| Roles | group parent | `Users (12)` | `{ section: "Users", glyph: "users" }` | `Users` | The label's count changes when a role is added or dropped |
| Roles | role leaf | `alice` | `"alice"` | `alice` | Leaves never expand; defined for completeness |

Paths are stored as arrays of strings, not as a joined string, so no separator has to be escaped out of a PostgreSQL identifier.

### Only visible expansions are saved

A path is saved only when every one of its ancestors is expanded too. Collapsing a parent therefore drops its descendants' saved state, even though the library keeps those descendants in `_expandedNodes`.[^visible-only]

Two properties follow, and restoring depends on both: every prefix of a saved path is itself a saved path, and the saved list is in parent-before-child order.

### Restore is eager, not lazy

On load, every saved path is re-expanded immediately, fetching each saved schema's objects as it goes. The tree returns to its pre-reload shape without the user touching it.[^eager-restore]

Worked example. A database with schemas `analytics`, `public`, and `sales`. The user expands `sales`, then `sales`'s `Tables` group, then `public`, then reloads. Stored `expanded` is `[["public"], ["sales"], ["sales", "Tables"]]`.

| Moment | What the tree shows |
|---|---|
| `getSchemas` resolves and `setNodes` runs | `analytics`, `public`, `sales` — all collapsed |
| Restore expands `public`, awaiting its object fetch | `public` shows the loading affordance, then its category rows, all collapsed |
| Restore expands `sales`, awaiting its object fetch | `sales` expands to its category rows, all collapsed |
| Restore expands `sales` › `Tables` | `Tables` expands to its table leaves — no fetch, the schema's load already supplied them |
| Restore finishes | The pre-reload tree, exactly |

The fetch cost is one `/objects` + `/functions` + `/types` triple per saved **schema** path — two in the example above. Category and leaf expansions cost nothing, because a schema's load returns its categories with their leaves already attached ([`NavigatorTree.ts:238`](frontend/src/navigator/NavigatorTree.ts#L238)). Paths are restored one at a time, in saved order, rather than in parallel.[^sequential-restore]

### A saved set suppresses each tree's first-run default expansion

Both trees expand something by default after a load: the Database tree expands a lone schema when the database has exactly one ([`NavigatorTree.ts:206`](frontend/src/navigator/NavigatorTree.ts#L206)), and the Roles tree reveals the first login role to open the "Users" section ([`RolesTree.ts:114`](frontend/src/roles/RolesTree.ts#L114)). Those are first-run conveniences. Once the user has expansion state of their own, that state wins — including when the user has collapsed everything.

`restore()` reports which case applies by returning whether a saved set existed at all:

| Stored `expanded` field | `loadExpanded()` | `restore()` returns | Default expansion |
|---|---|---|---|
| absent (first run, or after "Clear SQLAdmin data") | `null` | `false` | runs |
| `[]` (the user collapsed everything) | `[]` | `true` | skipped |
| `[["public"]]` | `[["public"]]` | `true` | skipped |

### Saving is suspended while a restore runs

`TreeExpansionPersistence` holds a `_restoring` flag. Every `"expand"` fired during a restore would otherwise write a partial set, so saves are skipped until the restore finishes, at which point one save runs.[^suspend-saving] That final save is also what prunes paths whose nodes no longer exist — a dropped schema disappears from storage the first time the tree loads without it.

### Each tree owns its own binding; the explorer views do not change

`NavigatorTree` and `RolesTree` each already hold the controller, so each calls `controller.layout.bindTreeExpansion(...)` itself. `DatabaseExplorerView`, `RolesExplorerView`, and `TreeExplorerView` are not touched.[^views-untouched]

### The store's write is whole-array, unlike its two siblings

`onExpanded(paths)` replaces the stored array outright, where `bindSplit`'s `onCollapse` and `bindAccordion`'s `onToggle` each merge a single index into the existing one ([`layoutStore.ts:218`](frontend/src/data/layoutStore.ts#L218), [`:239`](frontend/src/data/layoutStore.ts#L239)). The caller here always has the complete set in hand, recomputed from the tree itself, so there is nothing to merge with.[^whole-array]

---

## Public API

### `frontend/src/data/layoutStore.ts`

```ts
/** A persisted tree-expansion site. The string is the key segment under `sqladmin.layout.`. */
export type TreeSite = "database" | "roles";

/** One tree's saved expanded-node paths plus its save hook. */
export interface TreeExpansionBinding {
    /** The saved paths; `[]` when explicitly saved empty, `null` when never saved or not an array. */
    loadExpanded: () => string[][] | null;
    /** Persist the complete set of expanded paths, replacing any previous one. */
    onExpanded:   (paths: string[][]) => void;
}

class LayoutStore {
    bindTreeExpansion(site: TreeSite): TreeExpansionBinding;
}
```

`StoredLayout` gains one optional field: `expanded?: string[][]`.

### `frontend/src/data/treeExpansion.ts` (new)

```ts
/** Derives one node's path segment. Sibling segments must be unique and stable across reloads. */
export type NodeKey = (node: TreeNode) => string;

/** The default {@link NodeKey}: the node's own label. */
export const labelNodeKey: NodeKey;

/** Every expanded node's root-to-node key path, parents before children, skipping any node with a collapsed ancestor. */
export function collectExpandedPaths(
    roots: TreeNode[], expanded: ReadonlySet<TreeNode>, nodeKey: NodeKey,
): string[][];

/** The subset of `Tree` this module drives, so the persistence logic unit-tests against a plain object. */
export interface TreeExpansionHost {
    getNodes(): TreeNode[];
    getExpandedNodes(): TreeNode[];
    expandNodeAsync(node: TreeNode): Promise<boolean>;
}

/** Saves a tree's expanded nodes to a {@link TreeExpansionBinding} and restores them on load. */
export class TreeExpansionPersistence {
    constructor(tree: TreeExpansionHost, binding: TreeExpansionBinding, nodeKey?: NodeKey);

    /** Write the tree's current expanded set. An arrow field: wired by reference to `"expand"`/`"collapse"`. */
    save: () => void;

    /** Re-expand every saved path. Resolves to whether a saved set existed. */
    restore(): Promise<boolean>;
}
```

### `frontend/src/roles/groupRoles.ts`

```ts
/** The Roles tree's {@link NodeKey}: a group parent's stable section name, or a leaf's role name. */
export const roleNodeKey: NodeKey;
```

---

## Internal Structure

### `readExpanded` — the store's shape guard

Placed after `readCollapsed` ([`layoutStore.ts:150`](frontend/src/data/layoutStore.ts#L150)) and mirroring it: individual malformed entries are dropped rather than rejecting the whole array, because each path stands alone.

```ts
function readExpanded(values: unknown): string[][] | null {
    if (!Array.isArray(values)) {
        return null;
    }

    return (values as unknown[])
        .filter(isKeyPath)
        .map(path => [...path]);
}

function isKeyPath(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.every(s => typeof s === "string");
}
```

| Stored `expanded` | `loadExpanded()` | Why |
|---|---|---|
| absent | `null` | Never saved — the tree's first-run default expansion still applies |
| `[]` | `[]` | Saved empty — the user collapsed everything |
| `[["public"], ["public", "Tables"]]` | unchanged | Well-formed |
| `[["public"], "nope", [], [1]]` | `[["public"]]` | Non-array, empty, and non-string-member entries are dropped |
| `"nope"` / `5` / `{}` | `null` | Not an array |

### `bindTreeExpansion`

Placed after `bindAccordion` ([`layoutStore.ts:200`](frontend/src/data/layoutStore.ts#L200)), in the same shape as its two siblings.

```ts
bindTreeExpansion(site: TreeSite): TreeExpansionBinding {
    return {
        loadExpanded: () => readExpanded(this._read(site).expanded),
        onExpanded  : paths => this._write(site, { expanded: paths }),
    };
}
```

### `collectExpandedPaths`

Descends only into expanded nodes, which is what makes a collapsed parent hide its descendants from the saved set.

```ts
export function collectExpandedPaths(
    roots: TreeNode[], expanded: ReadonlySet<TreeNode>, nodeKey: NodeKey,
): string[][] {
    const paths: string[][] = [];

    const walk = (nodes: TreeNode[], prefix: string[]): void => {
        for (const node of nodes) {
            if (!expanded.has(node)) {
                continue;
            }

            const path = [...prefix, nodeKey(node)];

            paths.push(path);
            walk(node.children ?? [], path);
        }
    };

    walk(roots, []);

    return paths;
}
```

### `TreeExpansionPersistence`

```ts
export class TreeExpansionPersistence {
    private readonly _tree:    TreeExpansionHost;
    private readonly _binding: TreeExpansionBinding;
    private readonly _nodeKey: NodeKey;
    private _restoring: boolean = false;

    constructor(tree: TreeExpansionHost, binding: TreeExpansionBinding, nodeKey: NodeKey = labelNodeKey) {
        this._tree    = tree;
        this._binding = binding;
        this._nodeKey = nodeKey;
    }

    // An arrow field: both trees register it by reference on "expand"/"collapse",
    // which would lose `this` for a plain method (COMPONENT_CONVENTIONS.md (c)).
    save = (): void => {
        if (this._restoring) {
            return;
        }

        const expanded = new Set(this._tree.getExpandedNodes());

        this._binding.onExpanded(collectExpandedPaths(this._tree.getNodes(), expanded, this._nodeKey));
    };

    async restore(): Promise<boolean> {
        const paths = this._binding.loadExpanded();

        if (paths === null) {
            return false;
        }

        this._restoring = true;

        try {
            for (const path of paths) {
                await this._expandPath(path);
            }
        } finally {
            this._restoring = false;
        }

        // Rewrites the set now that the tree has settled, dropping any saved
        // path whose node no longer exists.
        this.save();

        return true;
    }

    /**
     * Walk one saved path from the roots down, expanding each segment; stop at
     * the first segment that is missing or fails to load. Every path is walked
     * from the roots independently, so an ancestor shared with an earlier path
     * is expanded again — a no-op that resolves `true` immediately.
     */
    private async _expandPath(path: string[]): Promise<void> {
        let siblings = this._tree.getNodes();

        for (const segment of path) {
            const node = siblings.find(candidate => this._nodeKey(candidate) === segment);

            if (node === undefined) {
                return;
            }

            const expanded = await this._tree.expandNodeAsync(node);

            if (!expanded) {
                return;
            }

            siblings = node.children ?? [];
        }
    }
}
```

### `NavigatorTree.refresh` after the change

The existing `if (nodes.length === 1)` guard keeps whatever call sits inside it; only the condition gains `!restored &&`, and the callback becomes `async`.

```ts
refresh = (): void => {
    void loadSchemas(this.conn, this.database)
        .then(async nodes => {
            this.setNodes(nodes);

            const restored = await this._expansion.restore();

            // …existing comment about the single-schema case, plus: skipped
            // once the user has expansion state of their own.
            if (!restored && nodes.length === 1) {
                // …existing call, unchanged…
            }
        })
        .catch(error => this.controller.notifyError(error));
};
```

---

## Ordered Implementation Steps

1. **Confirm the library prerequisite.** Run, from the repo root:

   ```
   grep -n 'getExpandedNodes\|expandNodeAsync\|"expand"' \
     frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/tree/Tree.d.ts
   ```

   Expect a match for each of the three. If any is missing, **stop and report that the library additions in `## Library Prerequisite` are not present yet.** Do not substitute an app-side approach, and do not continue to step 2. (Today this grep finds none of them — `TreeEvent` is still the four-member union and `expandNode` still returns `this`.)

2. **`frontend/tests/data/layoutStore.test.ts`** — add a `describe("LayoutStore — bindTreeExpansion")` block covering the `## Expected Behaviour` store cases. Run `npm run test` from `frontend/`; expect the new block to fail.

3. **`frontend/src/data/layoutStore.ts`** — add, in this order:
   - `TreeSite` beside `AccordionSite` ([:31](frontend/src/data/layoutStore.ts#L31)).
   - `expanded?: string[][]` on `StoredLayout` ([:58](frontend/src/data/layoutStore.ts#L58)).
   - `TreeExpansionBinding` after `AccordionLayoutBinding` ([:77](frontend/src/data/layoutStore.ts#L77)).
   - `isKeyPath` and `readExpanded` after `readCollapsed` ([:150](frontend/src/data/layoutStore.ts#L150)).
   - `bindTreeExpansion` after `bindAccordion` ([:200](frontend/src/data/layoutStore.ts#L200)).

   Extend the module header comment ([:1-16](frontend/src/data/layoutStore.ts#L1)) so it names expanded tree nodes alongside Split gutter positions and Accordion open state. Re-run `npm run test`; expect the new block to pass.

4. **`frontend/tests/data/treeExpansion.test.ts`** (new) — write the `collectExpandedPaths` and `TreeExpansionPersistence` cases from `## Expected Behaviour`, against a hand-built `TreeNode[]` and a fake `TreeExpansionHost` object literal. Expect failures (the module does not exist).

5. **`frontend/src/data/treeExpansion.ts`** (new) — implement per `## Internal Structure`. Its only imports are `import type { TreeNode } from "@jimka/typescript-ui/component/tree";` and `import type { TreeExpansionBinding } from "./layoutStore";`. Both must be `import type`, and nothing else may be imported from the library, so the module stays free of the DOM side effects library component modules run at import scope and keeps running under the node vitest environment. Re-run `npm run test`; expect green.

6. **`frontend/tests/roles/groupRoles.test.ts`** — add `roleNodeKey` cases (group parent, role leaf, missing `data`). Expect failure.

7. **`frontend/src/roles/groupRoles.ts`** — add `import type { NodeKey } from "../data/treeExpansion";` beside the existing type imports, then add `roleNodeKey`:

   ```ts
   export const roleNodeKey: NodeKey = node =>
       typeof node.data === "string"
           ? node.data
           : (node.data as RoleGroupData | undefined)?.section ?? node.label;
   ```

   Re-run `npm run test`; expect green.

8. **`frontend/src/navigator/NavigatorTree.ts`**:
   - Add `import { TreeExpansionPersistence } from "../data/treeExpansion";` beside the existing `../data/api` import.
   - Declare `private readonly _expansion: TreeExpansionPersistence;` beside the other private fields ([:104-109](frontend/src/navigator/NavigatorTree.ts#L104)). Declare it without an initialiser — it is assigned in the constructor body, which runs after the class's field initialisers.
   - In the constructor, **before** the existing `this.refresh()` call ([:187](frontend/src/navigator/NavigatorTree.ts#L187)), assign it and wire the two events. The default `labelNodeKey` applies — pass no third argument:

     ```ts
     this._expansion = new TreeExpansionPersistence(this, controller.layout.bindTreeExpansion("database"));
     this.on("expand",   this._expansion.save);
     this.on("collapse", this._expansion.save);
     ```

   - In `refresh` ([:195-211](frontend/src/navigator/NavigatorTree.ts#L195)), make the `.then` callback `async`, `await this._expansion.restore()` into a `restored` const right after `this.setNodes(nodes)`, and change the guard to `if (!restored && nodes.length === 1)`. Leave the call inside the guard exactly as it is.[^align-overlap] Extend the guard's existing comment with one sentence saying the default is skipped once saved expansion state exists.

9. **`frontend/src/roles/RolesTree.ts`** — the same edits:
   - Add `import { TreeExpansionPersistence } from "../data/treeExpansion";`, and add `roleNodeKey` to the existing `./groupRoles` value import.
   - Declare `private readonly _expansion: TreeExpansionPersistence;` beside `controller`/`contextMenu` ([:42-43](frontend/src/roles/RolesTree.ts#L42)), without an initialiser.
   - Before the constructor's `this.refresh()` ([:100](frontend/src/roles/RolesTree.ts#L100)), passing `roleNodeKey` as the third argument:

     ```ts
     this._expansion = new TreeExpansionPersistence(this, controller.layout.bindTreeExpansion("roles"), roleNodeKey);
     this.on("expand",   this._expansion.save);
     this.on("collapse", this._expansion.save);
     ```

   - In `refresh` ([:109-121](frontend/src/roles/RolesTree.ts#L109)), make the `.then` callback `async`, `await this._expansion.restore()` right after `this.setNodes(...)`, and change the guard to `if (!restored && firstUser)`. Extend the method's existing comment the same way.

10. **`LIBRARY_NOTES.md`** — add the entry described in `## Documentation Impact`.

11. **Verify** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/data/treeExpansion.ts` |
| Create | `frontend/tests/data/treeExpansion.test.ts` |
| Modify | `frontend/src/data/layoutStore.ts` |
| Modify | `frontend/tests/data/layoutStore.test.ts` |
| Modify | `frontend/src/roles/groupRoles.ts` |
| Modify | `frontend/tests/roles/groupRoles.test.ts` |
| Modify | `frontend/src/navigator/NavigatorTree.ts` |
| Modify | `frontend/src/roles/RolesTree.ts` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

### `LayoutStore.bindTreeExpansion` — unit-testable

1. `loadExpanded()` on empty storage returns `null`.
2. `onExpanded([["public"], ["public", "Tables"]])` then `loadExpanded()` round-trips the same nested array.
3. `onExpanded([])` then `loadExpanded()` returns `[]`, not `null` — an explicit empty save is distinguishable from never having saved.
4. The value is stored under `sqladmin.layout.<user>.<site>` — the same key `bindAccordion(site)` uses, with no extra segment.
5. Writing expansion leaves `sizes` and `open` in the blob intact, and writing accordion state leaves `expanded` intact.
6. A second `onExpanded` replaces the array rather than merging into it.
7. Malformed entries are dropped, the well-formed ones survive: `[["public"], "nope", [], [1], ["a", 2]]` loads as `[["public"]]`.
8. A non-array `expanded` (`"nope"`, `5`, `{}`) loads as `null`.
9. Corrupt JSON in the key loads as `null`, without throwing; a later write repairs the blob.
10. `"database"` and `"roles"` do not cross-read.

### `collectExpandedPaths` — unit-testable

11. No expanded nodes returns `[]`.
12. One expanded root returns `[[key]]`.
13. An expanded root with an expanded child returns both, parent first: `[["sales"], ["sales", "Tables"]]`.
14. An expanded node under a **collapsed** parent is omitted, and so is the parent.
15. A supplied `nodeKey` is applied at every level — with `node => node.label.split(" ")[0]`, an expanded node labelled `Users (12)` yields `[["Users"]]`.
16. A node in the expanded set that is not reachable from `roots` is omitted.

### `TreeExpansionPersistence` — unit-testable against a fake host

17. `save()` writes exactly what `collectExpandedPaths` produces for the host's current nodes and expanded set.
18. `restore()` with no saved state resolves `false` and calls `expandNodeAsync` zero times.
19. `restore()` with `[]` saved resolves `true` and calls `expandNodeAsync` zero times.
20. `restore()` with `[["sales"], ["sales", "Tables"]]` calls `expandNodeAsync` three times, in order: `sales`, `sales` again (the second path is walked from the roots too), then its `Tables` child.
21. A path whose first segment matches no root is skipped, and later paths still restore.
22. When `expandNodeAsync` resolves `false` for a segment, the rest of that path is abandoned, and later paths still restore.
23. With a fake host whose `expandNodeAsync` calls `save()` (standing in for the tree's `"expand"` event), no write reaches the binding until `restore()` resolves, and exactly one write happens then.
24. That final save prunes a saved path whose node is gone: with `[["dropped"], ["public"]]` saved and only `public` present, storage ends up holding `[["public"]]`.

### `roleNodeKey` — unit-testable

25. A group parent built by `groupRoles` yields its bare section name (`Users`), not its counted label (`Users (12)`).
26. A role leaf yields its role-name string.
27. A node with no `data` falls back to its label.

### In the running app — manual verification

28. Expand a schema and one of its category groups in the Database rail, reload the page: after the schema's objects load, the same schema and category group are expanded again and the tree is scrolled to the top.
29. Collapse everything in the Database rail, reload: nothing is expanded, and a single-schema database does **not** auto-expand its lone schema.
30. On a first run with no saved state (after "Clear SQLAdmin data" and a reload), a single-schema database still auto-expands its lone schema, and the Roles rail still opens its "Users" section.
31. Expand a Roles group other than "Users", reload: that group is expanded and "Users" is not re-opened by the default reveal.
32. Add or drop a role so the "Users (n)" count changes, reload: the group is still restored — the count is not part of its saved identity.
33. Press Alt+R (or the section's Refresh tool) in the Database rail: the tree re-fetches and comes back with the same nodes expanded instead of fully collapsed.
34. Drop an expanded schema through the navigator's context menu: the tree refreshes without it, and the vanished schema does not reappear in storage.
35. Open the Local Storage window from the Tools menu: `layout › <user> › database` shows an `expanded` field beside `sizes` and `open`, and "Clear SQLAdmin data" removes it.

---

## Verification

From `frontend/`:

- `npm run typecheck` — passes. This is also the second gate on the library prerequisite: `expandNodeAsync` and the `"expand"`/`"collapse"` overloads must resolve from the symlinked package's `.d.ts` files.
- `npm run test` — all suites pass, including the new `tests/data/treeExpansion.test.ts` and the added blocks in `tests/data/layoutStore.test.ts` and `tests/roles/groupRoles.test.ts`.
- `grep -n "expanded" src/shell/localStorageWindow.ts` — zero matches: the inspector lists every key generically and needed no change, because this plan adds no new storage key.
- `grep -n "sqladmin\." src/data/treeExpansion.ts` — zero matches: the new module builds no storage key of its own, it only writes through the binding it is handed.

Then drive the app (log in against a test database) and walk cases 28-35 above. The Database rail and the Roles rail are both reached from the activity bar; the Local Storage window is under the Tools menu.

---

## Documentation Impact

sqladmin publishes no API docs, so there is no doc site, barrel, or catalog to update.

- **`LIBRARY_NOTES.md`** — add one newest-first entry, `## ✂️✅ Tree exposed no way to observe or read back its expanded set`, above the current top entry. It records that persisting a tree's expanded nodes needed three additions to `Tree` (`getExpandedNodes()`, `expandNodeAsync()`, and the `"expand"`/`"collapse"` events), that `_expandedNodes` was private with no getter and `TreeEvent` had no expand/collapse member, and that the gap was closed in the library rather than worked around in the app. Follow the file's status legend at [:7](LIBRARY_NOTES.md#L7).
- **`CHANGELOG.md`** — no entry. The changelog is written per release, and the file carries no `Unreleased` section.
- **`frontend/COMPONENT_CONVENTIONS.md`** — no change. `TreeExpansionPersistence` is a plain class, not a library subclass, and its `save` arrow field is exactly what section (c) already prescribes.

---

## Potential Challenges

- **The library prerequisite is not in the symlinked build.** Step 1 catches this before any code is written; the instruction there is to stop, not to improvise.
- **A schema whose objects fail to load stalls its path.** `expandNodeAsync` resolves `false`, the path is abandoned, and the tree's existing `"loaderror"` handler reports the failure through `controller.notifyError` ([`NavigatorTree.ts:180`](frontend/src/navigator/NavigatorTree.ts#L180)). Later paths still restore. Because saving is suspended during the restore, the failed path stays in storage and is retried on the next load.
- **`_expansion` must exist before `refresh()` runs.** Both constructors call `this.refresh()` as their last statement, and `refresh` reads `this._expansion`. Assign `_expansion` earlier in the constructor body, as steps 8 and 9 specify.
- **The controller reveals nodes behind the user's back.** `syncToPanel` and the diagram "reveal in navigator" actions call `revealByPredicate` on the navigator, which expands ancestors. Those expansions are saved on the next `"expand"` or `"collapse"`, because `save()` reads the tree's whole expanded set rather than accumulating events.
- **Storage size.** Only schemas and category groups expand in the Database tree, capping the stored set at `schemas × 7` paths; the Roles tree caps at 3. A 100-schema database stores roughly 20 KB, well inside a localStorage origin quota.

---

## Critical Files

- [`frontend/src/data/layoutStore.ts`](frontend/src/data/layoutStore.ts) — the precedent this plan follows: per-user namespaced keys, shape-only validation, and `bind*` factories returning typed load/save hooks. Read in full before step 3.
- [`frontend/tests/data/layoutStore.test.ts`](frontend/tests/data/layoutStore.test.ts) — the `fakeStorage()` helper and the assertion style the new store tests must match.
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) — `schemaNode` and `categoryNode` show why category groups have no `data` and why a label path is the only identity available there.
- [`frontend/src/roles/groupRoles.ts`](frontend/src/roles/groupRoles.ts) — `RoleGroupData` and the counted group label that `roleNodeKey` exists to work around.
- [`frontend/src/roles/RolesTree.ts`](frontend/src/roles/RolesTree.ts) — the second wiring site, and the default "Users" reveal the restore suppresses.
- [`/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts`](../../typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts) — `_onToggle`, `_loadAndExpand`, and `setNodes` fix when the required events fire and what `expandNodeAsync` must wait for.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — section (c) on arrow-function fields for by-reference handlers.

---

## Non-Goals

- **Persisting selection or scroll position.** Only expansion is saved. The tree lands scrolled to the top after a restore.
- **Persisting expansion for any other tree.** The Explain diagram's plan tree ([`dock/ExplainDiagramPanel.ts:139`](frontend/src/dock/ExplainDiagramPanel.ts#L139)) and the Local Storage inspector's key tree both call `expandAll()` on every load and have no state worth saving.
- **Scoping the saved state per database.** The key stays per-user, matching `LayoutStore`'s existing sites. A schema saved from one database and absent in the next is simply skipped on restore and pruned on the following save.
- **Capping the number of saved paths.** The expandable node count is bounded by the schema count, so no `MAX_HISTORY`-style cap is needed.
- **Designing or scoping the library additions.** `## Library Prerequisite` states the required shape; building it is separate work in `/home/jika/typescript/typescript-ui`.

---

## Notes

[^library-not-scoped]: The project routes a missing capability into the library rather than working around it app-side, and `plans/align-with-library-post-0.4.1.md` is the recent precedent for an app plan written against library API that exists in the symlinked build but not in a published npm version. `frontend/node_modules/@jimka/typescript-ui` is a symlink to `/home/jika/typescript/typescript-ui/packages/lib`, so the app builds against that repo's `dist/lib` directly. An app-side alternative does exist and was rejected: the app could mirror the expanded set itself from a `"expand"`/`"collapse"` event pair and drive the restore as a state machine advanced by each `"expand"` event, needing no `getExpandedNodes()` and no `expandNodeAsync()`. That mirror drifts the moment anything expands without an event — `setNodes()` clears `_expandedNodes` silently, and `revealByPredicate` expands ancestors directly — and the event-driven restore has no way to notice that a path stalled on a failed load. Reading the tree's own truth at save time and awaiting each expansion removes both failure modes for two small additions.

[^reveal-emission]: `expandAll()` and `revealByPredicate()` write to `_expandedNodes` directly rather than going through `_onToggle`, so whether they emit `"expand"` is the library's call. This plan works either way: `save()` recomputes from `getExpandedNodes()`, so an expansion that arrives without an event is still picked up by the next event from any source. The only visible difference is timing — the Roles tree's first-run "Users" reveal would be saved immediately if `revealByPredicate` emits, or on the user's next toggle if it does not.

[^why-layoutstore]: Two other homes were considered. A separate per-user-and-connection store, `sqladmin.tree.<user>.<connection>`, mirroring `NotesStore` ([`frontend/src/data/notesStore.ts:15`](frontend/src/data/notesStore.ts#L15)), has the right instinct — expansion paths name database objects, so they are arguably per-database — but `connectionId` does not identify a database in this app: the backend defaults it to the literal `"default"` ([`backend/app/auth.py:204`](backend/app/auth.py#L204)) and the login form never sends one, so the extra segment would isolate nothing. A new per-user site key, `sqladmin.treeExpansion.<user>.<site>`, would add a second key per rail describing the same rail's UI state, with no compensating benefit — `StoredLayout`'s fields are already all optional and `_write` already merges, so an extra field costs nothing. Reusing the existing `"database"`/`"roles"` site segments also means the `AccordionSite` and `TreeSite` unions name the same two rails the same way.

[^visible-only]: The library keeps a collapsed parent's expanded descendants in `_expandedNodes`, so re-expanding the parent restores its inner shape within a session. Persisting that hidden state would mean restoring expansions the user cannot see, and would break the property the restore loop relies on — that every prefix of a saved path is itself a saved path — since a saved `["sales", "Tables"]` with `sales` collapsed would force the restore to expand `sales` anyway. The cost is small and bounded: after collapsing `sales` and reloading, re-expanding `sales` shows its category groups collapsed.

[^eager-restore]: Lazy restore — remembering the paths and expanding a node's saved descendants only when the user expands that node — was rejected. It defers the fetch, but the user's request is that the drilled-down view survives a refresh, and a lazy restore delivers nothing until the user re-navigates, which is most of the work the feature exists to remove. The cost eager restore avoids is also small here: only schemas are lazy in the Database tree, category groups and leaves arrive with their schema's load, and the Roles tree fetches nothing beyond the single role list it already loads. Lazy restore would also need to keep the saved paths alive for the whole session and reconcile them against user-driven expansion, where eager restore is finished before the user's first click.

[^sequential-restore]: Restoring paths in parallel would overlap the schema fetches, but every prefix of a saved path is itself a saved path, so parallel restore would run `expandNodeAsync` on the same node from two paths at once and depend on how the library de-duplicates a load already in flight. Sequential restore keeps the fetch order deterministic and the failure handling simple, at the cost of serialising a handful of requests.

[^suspend-saving]: Without the flag, the first `"expand"` of a restore would write a one-path set over the full saved one, and a reload landing in that window would lose the rest. Each later expansion would grow it back, so the end state is the same — but the intermediate writes are strictly worse than not writing at all, and a path that fails to load would be dropped permanently rather than retried next time. The flag also keeps the restore's own event traffic out of storage entirely, so the single save at the end is the only write a restore produces.

[^align-overlap]: `plans/align-with-library-post-0.4.1.md` replaces the call inside that guard — `void this.revealByPredicate(data => data === undefined)` becomes `this.expandNode(nodes[0])`. The two plans do not conflict: this one changes only the guard's condition and the callback's `async`, so it applies unchanged whichever version of the call is present, and neither plan has to land first. `touches-shared` names the file so `/implement` serialises them if they are run together.

[^whole-array]: `onCollapse` and `onToggle` merge because their callers know only about one index — `Split`'s `"panecollapse"` and `Accordion`'s `"sectiontoggle"` report a single element's new state, so the store has to preserve the others. `"expand"`/`"collapse"` also report a single node, but `save()` ignores the payload and rebuilds the whole set from `getExpandedNodes()`, so a merge would have nothing to preserve. Making the write whole-array also means a node that vanished from the tree disappears from storage on the next save, rather than lingering because no event ever named it.

[^views-untouched]: `TreeExplorerConfig.layout` carries the accordion binding because `TreeExplorerView` is what builds the `AccordionPanel` and therefore what consumes it ([`treeExplorerView.ts:79-95`](frontend/src/shell/treeExplorerView.ts#L79)). The expansion binding is consumed inside the tree, which the view receives already built via `NavigatorTree(controller)` / `RolesTree(controller)`. Routing it through the config would have the view forward a value it never reads, and would force every future `TreeExplorerView` caller to supply one.
