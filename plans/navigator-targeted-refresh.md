---
touches-shared:
  - frontend/src/controller/ddlLaunchers.ts
  - frontend/src/controller/objectPanels.ts
  - frontend/src/controller/revealCoordinator.ts
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/shell/explorerTree.ts
  - frontend/src/dock/SqlPreviewDialog.ts
  - frontend/src/dock/DdlFormPanel.ts
  - frontend/tests/controller/revealCoordinator.test.ts
---

# Navigator Targeted Refresh — Implementation Plan

## Overview

Every DDL success path ends in `RevealCoordinator.refreshNavigator()` ([revealCoordinator.ts:207](frontend/src/controller/revealCoordinator.ts#L207)), which calls `ExplorerTreeBase.refresh` ([explorerTree.ts:62-85](frontend/src/shell/explorerTree.ts#L62)). That refresh calls `Tree.setNodes`, which drops every node's expansion, loaded children and selection. It then re-expands the paths saved in localStorage, re-fetching each expanded schema. The result after, say, creating one table: the whole tree flickers closed and reopens, the scroll offset resets, the selection is lost, and every open tab's registered navigator node (`OpenPanel.node`, read by `SqlAdminController.syncToPanel` at [SqlAdminController.ts:768-770](frontend/src/SqlAdminController.ts#L768)) now points at a node the tree no longer holds.

This plan replaces that reset with a **targeted refresh**. Each DDL success path describes what it did as a `DdlChange`. A pure function maps the change to a `NavigatorScope`: whether the schema list must be re-read, and which schemas' object lists must be re-read. `NavigatorTree.refreshScope` re-fetches only those parts and merges the fresh nodes into the existing ones by identity, using typescript-ui 0.10.0's `Tree.setChildren` and `Tree.notifyNodeChanged`. Every node that still exists keeps its object, so its expansion, selection, and the scroll offset survive.

The same `DdlChange` call is also added to five index/constraint actions — the four Structure-tab toolbar actions and the index advisor's "Create index…" — in [ddlLaunchers.ts](frontend/src/controller/ddlLaunchers.ts), which today never refresh the navigator, so the Indexes category goes stale after them. The full `refresh()` stays as it is for the initial load and the explicit Refresh tool / Alt+R.

---

## Architecture Decisions

### Re-fetch a whole schema and merge by identity; don't compute single inserts/removes

A targeted refresh re-runs the navigator's existing per-schema fetch, `loadObjects` ([NavigatorTree.ts:246](frontend/src/navigator/NavigatorTree.ts#L246)), and merges its result into the existing category and leaf nodes. It does not use `insertNode`/`removeNode` to apply one computed change.[^fetch-not-compute]

The merge ("reconcile") keeps the fresh list's order and, for each fresh node, reuses the existing node with the same identity:

| Existing children | Fresh children | Result | Why |
|---|---|---|---|
| `[A, C]` | `[a, b, c]` | `[A, b, C]` | `A`/`C` kept (same objects), `b` is new |
| `[A, B]` | `[a]` | `[A]` | `B` dropped |
| `[X "orders_pkey (on orders)"]` | `[x "orders_pkey (on invoices)"]` | `[X]`, `X.label`/`X.data` taken from `x`, `X` reported changed | same identity, new label |

Capital letters are node objects already in the tree; lower case are the fresh nodes with the same identity.

The reconcile runs at two levels per schema: the schema's category nodes, then each surviving category's leaves. A kept node whose `label` or `data` differs from its fresh twin gets the fresh values assigned (never its `children`), and the caller repaints it with `notifyNodeChanged`.

### Node identity is kind + schema + name + signature

`navigatorNodeIdentity(node)` returns:

| Node | Identity |
|---|---|
| table `public.orders` | `["table","public","orders",""]` |
| function `public.total_orders(p_customer_id integer)` | `["function","public","total_orders","p_customer_id integer"]` |
| schema `sales` | `["schema","sales","",""]` |
| category `Tables` (no `data`) | `["category","Tables"]` |

Each is the `JSON.stringify` of the tuple shown. The label is not part of a leaf's identity, because an index's label embeds its table name and changes on a table rename while the index itself does not.[^identity]

### The DDL change decides the scope, through one pure mapping

`navigatorScopeFor(change)` applies these rules; the first that matches wins:

1. `sqlEdited` is true → schema list **and** every loaded schema.
2. `kind === "schema"` → schema list; plus every loaded schema when `action === "drop"` and `cascade` is true.
3. `schema` is missing → schema list and every loaded schema (defensive).
4. `action === "drop"` and `cascade` is true → every loaded schema.
5. Otherwise → just `[schema]`.

| Change | Scope |
|---|---|
| create table in `public` | `{ schemaList: false, schemas: ["public"] }` |
| drop view `public.v`, no cascade | `{ schemaList: false, schemas: ["public"] }` |
| drop table `public.t`, cascade | `{ schemaList: false, schemas: "allLoaded" }` |
| create schema | `{ schemaList: true, schemas: [] }` |
| drop schema `old`, cascade | `{ schemaList: true, schemas: "allLoaded" }` |
| rename table, preview SQL edited | `{ schemaList: true, schemas: "allLoaded" }` |
| create index on `sales.orders` | `{ schemaList: false, schemas: ["sales"] }` |

"Loaded" means the schema node's `children` are set — it was expanded at least once. An unloaded schema is never fetched: its next expand calls `loadChildren` and gets fresh data anyway.[^scope-rules]

### An edited preview widens the scope to everything loaded

`SqlPreviewDialog` passes a second argument to `onSuccess`: `sqlEdited`, true when the executed text differs from the text `generateSql()` seeded. Every DDL call site forwards it into its `DdlChange`. The function-definition save executes user-written SQL directly, so it always passes `sqlEdited: true`.[^edited-sql]

### There is no fallback to the reset

The widest scope — schema list plus every loaded schema — already re-reads everything the tree has loaded while keeping node state, so no DDL needs the `setNodes` reset. `RevealCoordinator.refreshNavigator()` is removed; `ExplorerTreeBase.refresh` stays for the initial load and the Refresh tool.[^no-reset-fallback]

### Stale fetches are dropped with a per-schema sequence number

`NavigatorTree` keeps one counter for the schema list and one per schema name. A fetch records the counter's new value before it starts and applies its result only if the counter still holds that value, so an older fetch that resolves after a newer one is discarded. This mirrors `QueryPanel`'s `runSeq` guard ([QueryPanel.ts:792](frontend/src/dock/QueryPanel.ts#L792), checked at [:706-715](frontend/src/dock/QueryPanel.ts#L706)).[^seq-guard]

The target schema node is looked up by label **after** its fetch resolves, not before, and the result is dropped if that node is gone or unloaded by then.

### A targeted refresh waits for any running full load, and does not arm the load signal

`refreshScope` first awaits `whenLoaded()`, so it never merges into a tree that a full refresh or the expansion restore is still building. It does not arm the `LoadSignal` itself.[^no-arm]

### Pure logic lives in a DOM-free module beside the tree

`DdlChange`, `NavigatorScope`, `navigatorScopeFor`, `navigatorNodeIdentity`, `reconcileNodes` and `loadedSchemaNames` go in a new `frontend/src/navigator/navigatorRefresh.ts` with only `import type` imports. This is the pattern [data/treeExpansion.ts](frontend/src/data/treeExpansion.ts) and [navigator/revealMatch.ts](frontend/src/navigator/revealMatch.ts) set: the tree-shaped logic is pure and runs under the node vitest harness, and the Tree-driving class stays thin.[^pure-module]

### The coordinator keeps owning the DDL→navigator hop

`RevealCoordinator.refreshNavigator()` becomes `refreshNavigatorAfter(change: DdlChange)`, which maps the change and calls the navigator's `refreshScope`. Call sites keep going through `this.reveal`, as they do today.

---

## Public API

All app-internal; nothing is exported from a library.

`frontend/src/navigator/navigatorRefresh.ts` (new):

```ts
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { DbObjectKind, DbObjectRef } from "../contract";   // DbObjectRef: sameRef's payload shape
import type { ExplorerTree } from "../shell/explorerTree";

/** What one successful DDL did, as far as the navigator cares. */
export interface DdlChange {
    action: "create" | "drop" | "rename" | "alter";
    /** The kind acted on: "schema" for a schema itself, "table" for a constraint change, "index" for an index. */
    kind: DbObjectKind;
    /** The schema holding the object (for a create: the schema it was created in; for kind "schema": that schema). */
    schema?: string;
    /** True when a drop ran with CASCADE. */
    cascade?: boolean;
    /** True when the executed SQL was user-edited or user-written. */
    sqlEdited?: boolean;
}

/** Which parts of the navigator a targeted refresh re-reads. */
export interface NavigatorScope {
    /** Re-read the schema list and merge the root level. */
    schemaList: boolean;
    /** Schemas whose object lists to re-read; "allLoaded" = every schema whose children are loaded. */
    schemas: readonly string[] | "allLoaded";
}

/** The navigator tree as the reveal coordinator sees it: an explorer tree plus the targeted refresh. */
export interface NavigatorExplorerTree extends ExplorerTree {
    refreshScope(scope: NavigatorScope): Promise<void>;
}

/** The result of merging fresh children into existing ones. */
export interface ReconcileResult {
    /** The new child list, in fresh order: kept existing objects plus new fresh ones. */
    children: TreeNode[];
    /** Kept existing nodes whose label or data was overwritten from the fresh twin. */
    changed: TreeNode[];
    /** Each kept existing node paired with its fresh twin, for a second-level merge. */
    kept: { existing: TreeNode; fresh: TreeNode }[];
}

export function navigatorScopeFor(change: DdlChange): NavigatorScope;
export function navigatorNodeIdentity(node: TreeNode): string;
export function reconcileNodes(existing: readonly TreeNode[], fresh: readonly TreeNode[]): ReconcileResult;
export function loadedSchemaNames(roots: readonly TreeNode[]): string[];
```

`frontend/src/controller/revealCoordinator.ts`:

```ts
setNavigator(tree: NavigatorExplorerTree): void;          // parameter type narrowed from ExplorerTree
refreshNavigatorAfter(change: DdlChange): void;           // replaces refreshNavigator()
```

`frontend/src/shell/explorerTree.ts` — `ExplorerTreeBase` gains:

```ts
/** Write the tree's current expanded set to storage (the same write an expand/collapse makes). */
protected saveExpansion(): void;
```

`frontend/src/navigator/NavigatorTree.ts` — `NavigatorTree` now `implements NavigatorExplorerTree` and gains:

```ts
async refreshScope(scope: NavigatorScope): Promise<void>;
```

`frontend/src/dock/SqlPreviewDialog.ts` and `frontend/src/dock/DdlFormPanel.ts`:

```ts
onSuccess: (result: QueryStatusResult, sqlEdited: boolean) => void;
```

Existing one-argument callbacks stay assignable to this type; only the call sites this plan lists read the second argument.

---

## Internal Structure

`reconcileNodes` (pure; mutates only `label`/`data` of kept nodes):

```ts
export function reconcileNodes(existing: readonly TreeNode[], fresh: readonly TreeNode[]): ReconcileResult {
    const byIdentity = new Map(existing.map(node => [navigatorNodeIdentity(node), node]));
    const children: TreeNode[] = [];
    const changed:  TreeNode[] = [];
    const kept: ReconcileResult["kept"] = [];

    for (const freshNode of fresh) {
        const match = byIdentity.get(navigatorNodeIdentity(freshNode));

        if (match === undefined) {
            children.push(freshNode);
            continue;
        }

        if (match.label !== freshNode.label || !sameRef(match.data, freshNode.data)) {
            match.label = freshNode.label;
            match.data  = freshNode.data;   // assign the fresh object; never mutate the old ref in place
            changed.push(match);
        }

        children.push(match);
        kept.push({ existing: match, fresh: freshNode });
    }

    return { children, changed, kept };
}
```

`sameRef` is a private helper comparing two `DbObjectRef`-shaped payloads field by field (`connectionId`, `database`, `schema`, `name`, `kind`, `signature`, `isProcedure`, `table`); two `undefined` payloads are equal.

`NavigatorTree.refreshScope` and its helpers:

```ts
private _schemaListSeq = 0;
private readonly _schemaSeq = new Map<string, number>();

async refreshScope(scope: NavigatorScope): Promise<void> {
    await this.whenLoaded();

    if (scope.schemaList) {
        await this.reconcileSchemaList();
    }

    const names = scope.schemas === "allLoaded" ? loadedSchemaNames(this.getNodes()) : scope.schemas;

    await Promise.all(names.map(name => this.reconcileSchema(name)));

    this.saveExpansion();
}

private async reconcileSchemaList(): Promise<void> {
    const seq = ++this._schemaListSeq;

    try {
        const fresh = this.toNodes(await this.load());

        if (seq !== this._schemaListSeq) {
            return;
        }

        const merged = reconcileNodes(this.getNodes(), fresh);

        this.setChildren(null, merged.children);
        merged.changed.forEach(node => this.notifyNodeChanged(node));
    } catch (error) {
        this.controller.notifyError(error);
    }
}

private async reconcileSchema(name: string): Promise<void> {
    // An unloaded schema is never fetched: its next expand loads fresh data anyway.
    if (!this.isSchemaLoaded(name)) {
        return;
    }

    const seq = (this._schemaSeq.get(name) ?? 0) + 1;

    this._schemaSeq.set(name, seq);

    try {
        const fresh = await loadObjects(this.conn, this.database, name);

        if (seq !== this._schemaSeq.get(name)) {
            return;
        }

        // Looked up after the fetch: a full refresh or a schema-list merge may have replaced it meanwhile.
        const schemaNode = this.getNodes().find(node => node.label === name);

        if (schemaNode === undefined || schemaNode.children === undefined) {
            return;
        }

        this.mergeSchemaChildren(schemaNode, fresh);
    } catch (error) {
        this.controller.notifyError(error);
    }
}
```

`mergeSchemaChildren(schemaNode, fresh)` (private method):

1. `const categories = reconcileNodes(schemaNode.children ?? [], fresh);`
2. For each `{ existing, fresh }` in `categories.kept`: `const leaves = reconcileNodes(existing.children ?? [], fresh.children ?? []);` then `this.setChildren(existing, leaves.children);` and collect `leaves.changed`.
3. `this.setChildren(schemaNode, categories.children);`
4. `notifyNodeChanged` every collected changed leaf, and every node in `categories.changed`.

`isSchemaLoaded(name)` (private) returns `this.getNodes().find(node => node.label === name)?.children !== undefined`. `reconcileSchema` checks it before the fetch, so an unloaded name in `scope.schemas` (for example a view created into a never-expanded schema) costs no request, and re-checks the node after the fetch as shown.

---

## Ordered Implementation Steps

0. **Worktree setup.** In the implementation worktree, symlink `frontend/node_modules` to the main tree's (`ln -s /home/jika/typescript/sqladmin/frontend/node_modules <worktree>/frontend/node_modules`) so typecheck and tests resolve the linked typescript-ui 0.10.0. Check: `ls -l <worktree>/frontend/node_modules/@jimka/typescript-ui` resolves to `/home/jika/typescript/typescript-ui/packages/lib`, and `grep -c setChildren /home/jika/typescript/typescript-ui/packages/lib/dist/lib/types/component/tree/Tree.d.ts` is non-zero. Do not change `frontend/package.json`'s `@jimka/typescript-ui` range.

1. **Tests first — `frontend/tests/navigator/navigatorRefresh.test.ts` (new).** Write the unit cases U1–U16 from `## Expected Behaviour`. They fail (module missing).

2. **`frontend/src/navigator/navigatorRefresh.ts` (new).** Module header comment in the style of [revealMatch.ts:1-10](frontend/src/navigator/revealMatch.ts#L1): states it is DOM-free, `import type` only, and why. Add every export from `## Public API` and the `sameRef` helper, each with JSDoc. `navigatorScopeFor` implements the five numbered rules in order. `loadedSchemaNames` returns the `label` of each root whose `children !== undefined`, in root order. Check: `npx vitest run tests/navigator/navigatorRefresh.test.ts` passes.

3. **`frontend/src/shell/explorerTree.ts`.** Add `protected saveExpansion(): void { this._expansion.save(); }` with a JSDoc line. Nothing else changes; `refresh` stays exactly as it is.

4. **`frontend/src/navigator/NavigatorTree.ts`.**
   - Import `loadedSchemaNames` and `reconcileNodes` (values) and `NavigatorExplorerTree` and `NavigatorScope` (types) from `./navigatorRefresh`. `navigatorScopeFor` is not imported here; the coordinator owns the mapping.
   - Change `implements ExplorerTree` to `implements NavigatorExplorerTree`; drop the now-unused `ExplorerTree` type import if nothing else uses it.
   - Add the two sequence fields, `refreshScope`, `reconcileSchemaList`, `reconcileSchema`, `isSchemaLoaded` and `mergeSchemaChildren` from `## Internal Structure`, each with JSDoc. `refreshScope` is a plain `async` method (it is only ever called as `tree.refreshScope(...)`, never handed out by reference).
   - Update the module header (lines 1-14): the navigator is fully reset only by the initial load and the Refresh tool; a DDL change re-reads just the affected schemas via `refreshScope`.
   - Check: `npm run typecheck` in `frontend/`.

5. **`frontend/src/controller/revealCoordinator.ts`.**
   - Change `_navigator`'s type to `NavigatorExplorerTree | null` and `setNavigator`'s parameter to `NavigatorExplorerTree` (update its JSDoc: "…and DDL flows can trigger its targeted refresh").
   - Replace `refreshNavigator()` (lines 206-209) with:
     ```ts
     /** Bring the navigator in step with one successful DDL, re-reading only what `change` can have affected. */
     refreshNavigatorAfter(change: DdlChange): void {
         void this._navigator?.refreshScope(navigatorScopeFor(change));
     }
     ```
   - Import `navigatorScopeFor` (value — the module is DOM-free, so this file still loads under the node harness) and the `DdlChange`/`NavigatorExplorerTree` types.
   - Check: `grep -rn 'refreshNavigator()' frontend/src` → zero matches after step 8.

6. **`frontend/src/dock/SqlPreviewDialog.ts`.**
   - Change `SqlPreviewDialogOptions.onSuccess` to `(result: QueryStatusResult, sqlEdited: boolean) => void`; document `sqlEdited` ("true when the executed SQL differs from the text `generateSql` seeded").
   - In `runSqlPreviewDialog`, add `let seededSql = "";` before `seedPreview`; in `seedPreview`'s `try`, assign the generated string to `seededSql` and then `editor.setValue(seededSql)`. A failed seed leaves `seededSql` as `""`.
   - In `tryExecute`, read `const sql = editor.getValue();` once, execute it, then call `options.onSuccess(status, sql !== seededSql)`.
   - Update the header comment's flow sentence to mention that `onSuccess` learns whether the SQL was edited.

7. **`frontend/src/dock/DdlFormPanel.ts`.** Change `DdlFormPanelOptions.onSuccess` to the same two-argument type; `review()` already forwards `this._deps.onSuccess` unchanged.

8. **`frontend/src/controller/ddlLaunchers.ts`.** Import `DdlChange` (type) and `DbObjectKind` (type, from `../contract`). Then:
   - Add a module-local interface `LaunchedDraft extends DdlDraft { targetSchema: () => string | undefined }` with JSDoc ("the schema the new object lands in, read at success time").
   - `openDdlPanel`'s `spec` gains `kind: DbObjectKind`, and `build` returns `LaunchedDraft`. Its `onSuccess` becomes `(_result, sqlEdited) => { const change: DdlChange = { action: "create", kind: spec.kind, schema: draft.targetSchema(), sqlEdited }; this.host.dock.removePanel(id); this.reveal.refreshNavigatorAfter(change); }` — the change is built **before** `removePanel`, which disposes the form it reads.
   - Each `openDdlPanel` caller passes `kind` and a `targetSchema`:

     | Launcher | `kind` | `targetSchema` |
     |---|---|---|
     | `createTable` | `"table"` | `() => ref.schema` |
     | `createSchema` | `"schema"` | `() => undefined` |
     | `createSequence` | `"sequence"` | `() => ref.schema` |
     | `createFunction` | `"function"` | `() => ref.schema` |
     | `createType` (both branches) | `"type"` | `() => ref.schema` |
     | `createRelationDraft` view | `"view"` | `() => form.readSpec().schema` |
     | `createRelationDraft` matview | `"materializedView"` | `() => form.readSpec().schema` |

   - Replace each `this.reveal.refreshNavigator()` in a dialog `onSuccess` with `refreshNavigatorAfter`, turning the callback into `(_result, sqlEdited) => …` and keeping every other statement (`closeTabsFor`, etc.) in place:

     | Method (current line) | `DdlChange` |
     |---|---|
     | `renameTable` (201) | `{ action: "rename", kind: "table", schema: ref.schema, sqlEdited }` |
     | `renameSchema` (217) | `{ action: "rename", kind: "schema", schema: ref.schema, sqlEdited }` |
     | `dropTable` (264) | `{ action: "drop", kind: "table", schema: ref.schema, cascade: form.readSpec().cascade, sqlEdited }` |
     | `dropRelation` (288) | `{ action: "drop", kind: ref.kind, schema: ref.schema, cascade: form.readSpec().cascade, sqlEdited }` |
     | `dropSchema` (309) | `{ action: "drop", kind: "schema", schema: ref.schema, cascade: form.readSpec().cascade, sqlEdited }` |
     | `dropSequence` (325) | `{ action: "drop", kind: "sequence", schema: ref.schema, cascade: form.readSpec().cascade, sqlEdited }` |
     | `dropFunction` (350) | `{ action: "drop", kind: "function", schema: ref.schema, cascade: form.readSpec().cascade, sqlEdited }` |
     | `dropType` (366) | `{ action: "drop", kind: "type", schema: ref.schema, cascade: form.readSpec().cascade, sqlEdited }` |

   - Add the navigator call to the five index/constraint actions, after the existing `this.refreshStructure(ref)`:

     | Method (current line) | `DdlChange` |
     |---|---|
     | `addConstraint` (398) | `{ action: "alter", kind: "table", schema: ref.schema, sqlEdited }` |
     | `dropConstraint` (418) | `{ action: "alter", kind: "table", schema: ref.schema, sqlEdited }` |
     | `createIndex` (432) | `{ action: "create", kind: "index", schema: ref.schema, sqlEdited }` |
     | `dropIndex` (451) | `{ action: "drop", kind: "index", schema: ref.schema, cascade: form.readSpec().cascade, sqlEdited }` |
     | `createSuggestedIndex` (487) | `{ action: "create", kind: "index", schema, sqlEdited }` |

   - `refreshMaterializedView` (240) is unchanged: a REFRESH changes no listed object.
   - Update the JSDoc of every touched method that says "refreshes the navigator" only where it now misleads (the five index/constraint methods: "Success rebuilds the structure tab and re-reads the table's schema in the navigator (its Indexes category)").

9. **`frontend/src/controller/objectPanels.ts`.**
   - Line 310 (view/matview definition save): `this.reveal.refreshNavigatorAfter({ action: "alter", kind: ref.kind, schema: ref.schema });`
   - Line 587 (function definition save): `this.reveal.refreshNavigatorAfter({ action: "alter", kind: "function", schema: ref.schema, sqlEdited: true });`
   - Import the `DdlChange` type only if a local annotation needs it (object literals passed inline need no import).
   - Check: `grep -rn 'refreshNavigator()' frontend/src` → zero matches.

10. **`frontend/tests/controller/revealCoordinator.test.ts`.** Add `refreshScope: vi.fn(() => Promise.resolve())` to `stubTree`, change its return cast to `NavigatorExplorerTree`, and rewrite case 22 per U17 below.

11. **Full check.** `npm run typecheck` and `npm test` in `frontend/`; then the manual checks in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/navigator/navigatorRefresh.ts` |
| Create | `frontend/tests/navigator/navigatorRefresh.test.ts` |
| Modify | `frontend/src/navigator/NavigatorTree.ts` |
| Modify | `frontend/src/shell/explorerTree.ts` |
| Modify | `frontend/src/controller/revealCoordinator.ts` |
| Modify | `frontend/src/controller/ddlLaunchers.ts` |
| Modify | `frontend/src/controller/objectPanels.ts` |
| Modify | `frontend/src/dock/SqlPreviewDialog.ts` |
| Modify | `frontend/src/dock/DdlFormPanel.ts` |
| Modify | `frontend/tests/controller/revealCoordinator.test.ts` |

---

## Expected Behaviour

### Unit-testable (`navigatorRefresh.test.ts`)

`navigatorScopeFor`:

- **U1** `{ action: "create", kind: "table", schema: "public" }` → `{ schemaList: false, schemas: ["public"] }`.
- **U2** `{ action: "drop", kind: "view", schema: "public", cascade: false }` → `{ schemaList: false, schemas: ["public"] }`.
- **U3** `{ action: "drop", kind: "table", schema: "public", cascade: true }` → `{ schemaList: false, schemas: "allLoaded" }`.
- **U4** `{ action: "create", kind: "schema" }` → `{ schemaList: true, schemas: [] }`.
- **U5** `{ action: "rename", kind: "schema", schema: "old" }` → `{ schemaList: true, schemas: [] }`.
- **U6** `{ action: "drop", kind: "schema", schema: "old", cascade: true }` → `{ schemaList: true, schemas: "allLoaded" }`; with `cascade: false` → `{ schemaList: true, schemas: [] }`.
- **U7** `{ action: "rename", kind: "table", schema: "public", sqlEdited: true }` → `{ schemaList: true, schemas: "allLoaded" }` (rule 1 beats rule 5).
- **U8** `{ action: "drop", kind: "schema", schema: "x", cascade: false, sqlEdited: true }` → `{ schemaList: true, schemas: "allLoaded" }` (rule 1 beats rule 2).
- **U9** `{ action: "create", kind: "index", schema: "sales" }` → `{ schemaList: false, schemas: ["sales"] }`; `{ action: "alter", kind: "table", schema: "sales", cascade: true }` → `{ schemaList: false, schemas: ["sales"] }` (cascade only widens a drop).
- **U10** `{ action: "create", kind: "table" }` (no schema) → `{ schemaList: true, schemas: "allLoaded" }`.

`navigatorNodeIdentity`:

- **U11** The four rows of the identity table in `## Architecture Decisions` produce exactly those strings; a table and a sequence with the same schema and name produce different identities; two function overloads differing only in signature produce different identities.

`reconcileNodes`:

- **U12** Existing `[A, C]`, fresh `[a, b, c]` → `children` is `[A, b, C]` with `A`/`C` the same objects (`toBe`), `kept` has two pairs, `changed` is empty.
- **U13** Existing `[A, B]`, fresh `[a]` → `children` is `[A]`.
- **U14** Existing index leaf labelled `orders_pkey (on orders)` with `data.table === "orders"`, fresh twin labelled `orders_pkey (on invoices)` with `data.table === "invoices"` → `children[0]` is the existing object, its `label`/`data` now equal the fresh ones, `changed` is `[existing]`, and the existing node's former `data` object is unmodified (`table` still `"orders"`).
- **U15** Fresh order wins: existing `[B, A]`, fresh `[a, b]` → `[A, B]`. Empty fresh → `[]`. Empty existing → the fresh array's objects, all new. The function never assigns `children` on any node.

`loadedSchemaNames`:

- **U16** Roots `[{label:"a", children:[]}, {label:"b"}, {label:"c", children:[x]}]` → `["a", "c"]` (an empty loaded list counts as loaded).

### Unit-testable (`revealCoordinator.test.ts`)

- **U17** Case 22 rewritten: with no navigator, `refreshNavigatorAfter({ action: "create", kind: "table", schema: "public" })` does not throw. With a stub navigator, the same call invokes `refreshScope` once with `{ schemaList: false, schemas: ["public"] }`, and `selectNavigatorNode` still delegates to `selectNode`.

### Manual (live app — tree state, network, focus)

- **M1** Expand `public` → Tables and Indexes, select a table leaf, scroll the tree. Create a table in `public`: the new leaf appears in sorted position; the other expansions, the selection and the scroll offset are unchanged; the network panel shows `/objects`, `/functions`, `/types`, `/indexes` for `public` only, and no `/schemas`.
- **M2** Drop a table with a primary key and a `serial` column: its leaf, its index leaf in Indexes, and its owned sequence leaf all disappear. Dropping the last table in a schema removes the Tables category.
- **M3** Rename a table that has an index: the table leaf shows the new name (collapsed, unselected); the index leaf's label changes to `(on <new name>)` in place.
- **M4** With `public` and `sales` expanded and a view in `sales` selecting from a table in `public`: drop that table with CASCADE; the view disappears from `sales`, and both schemas keep their other expansions.
- **M5** Create a schema: it appears in sorted position, collapsed; every other schema keeps its state. Rename a schema: the old node goes, the new one appears collapsed. Drop an empty schema: its node goes.
- **M6** From a schema node, create a view whose schema combo is set to a different, expanded schema: that schema's Views category updates, the launching schema is not fetched.
- **M7** Create a table in a schema that was never expanded: no object fetch for that schema; expanding it afterwards shows the table.
- **M8** In a drop-table dialog, edit the preview SQL (for example add `CASCADE`), execute: `/schemas` and every expanded schema's four endpoints are fetched; state is kept.
- **M9** From a table's Structure tab, create an index, then drop it: the Indexes category gains and loses the leaf without a tree reset. Add a primary-key constraint: its index appears.
- **M10** Save a function definition that changes the argument list: the new overload's leaf appears beside the old one.
- **M11** After any of the above, switch between two open dock tabs: the navigator selects each tab's node (their registered nodes are still in the tree).
- **M12** The Database rail's Refresh tool and Alt+R still reset the whole tree and restore the saved expansion, as before.
- **M13** Reload the page after M1: the saved expansion restores the same shape (the expansion save after a targeted refresh kept storage in step).

---

## Verification

- `cd <worktree>/frontend && npm run typecheck` — clean.
- `npm test` — all suites pass, including U1–U17.
- `grep -rn 'refreshNavigator()' frontend/src frontend/tests` — zero matches.
- `grep -rn 'refreshNavigatorAfter(' frontend/src/controller | wc -l` — 17: 14 calls in `ddlLaunchers.ts` (8 dialog sites, 1 in `openDdlPanel`, 5 index/constraint sites), 2 in `objectPanels.ts`, and the definition in `revealCoordinator.ts`.
- Manual M1–M13 using the `verify` skill ([.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md)) against the symlinked typescript-ui 0.10.0 build, with the browser network panel open for M1, M6, M7 and M8.

---

## Potential Challenges

- **The linked library, not the manifest, provides the new Tree methods.** `package.json` still says `^0.9.0`; typecheck and tests must run with `node_modules` symlinked as in step 0, and the range bump belongs to the coordinated release, not this branch.
- **`removePanel` disposes the draft form.** Build the `DdlChange` (which may call `form.readSpec()`) before `this.host.dock.removePanel(id)` in `openDdlPanel`.
- **A schema load already in flight when the DDL succeeds.** Such a schema has `children === undefined`, so `refreshScope` skips it and its pending load commits whatever it read, which may predate the DDL. The window is one round trip; the Refresh tool corrects it, and no guard is added.
- **A selected leaf that the merge removes.** `setChildren` drops it from the selection without a `"selection"` event, so the Properties inspector keeps showing the removed object — the same as today's `setNodes` reset.
- **`notifyNodeChanged` must follow `setChildren`.** Calling it before the merged list is committed can repaint a row that the commit then rebinds anyway; call it last, as `mergeSchemaChildren` step 4 does.

---

## Critical Files

- [frontend/src/shell/explorerTree.ts](frontend/src/shell/explorerTree.ts) — the full-refresh chain that stays, `whenLoaded`, and where `saveExpansion` goes.
- [frontend/src/navigator/NavigatorTree.ts](frontend/src/navigator/NavigatorTree.ts) — `schemaNode`, `loadObjects`, `categoryNode`, `objectLeaf`, `leafLabel`: the node shapes the merge must match.
- [frontend/src/data/treeExpansion.ts](frontend/src/data/treeExpansion.ts) — the pure, `import type`-only tree-logic precedent `navigatorRefresh.ts` follows, and the `save` that `saveExpansion` calls.
- [frontend/src/navigator/revealMatch.ts](frontend/src/navigator/revealMatch.ts) — header style and the kind-sensitive identity rule (`matchesObject`) the node identity mirrors.
- [frontend/src/dock/QueryPanel.ts:792](frontend/src/dock/QueryPanel.ts#L792) — the `runSeq` staleness guard precedent.
- [frontend/src/controller/revealCoordinator.ts](frontend/src/controller/revealCoordinator.ts) and [frontend/tests/controller/revealCoordinator.test.ts](frontend/tests/controller/revealCoordinator.test.ts).
- [frontend/src/dock/SqlPreviewDialog.ts](frontend/src/dock/SqlPreviewDialog.ts) — `seedPreview`/`tryExecute`.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts` — `setChildren` (line ~504), `notifyNodeChanged` (~533), and the `TreeNode.loadChildren` remarks in `TreeNode.ts` on dropped in-flight loads.
- `/home/jika/typescript/typescript-ui/packages/lib/docs/reference/changelog/0.10.0.md` — the "`Tree` gains `insertNode`, `removeNode`, `setChildren` and `notifyNodeChanged`" and reveal/expand race entries.
- [frontend/COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) (c) — arrow field vs plain method.

---

## Non-Goals

- **`shell/localStorageWindow.ts`'s `refresh`.** It rebuilds a small, fully expanded key-inspector tree after a clear that removes most of its nodes; a reset is the right tool there and it has nothing to do with DDL.
- **The Roles tree.** Role DDL is not part of this change; `RolesTree` keeps its full refresh.
- **Structure-tab Columns save, `SequenceInfoPanel` and `TypeInfoPanel` saves.** They do not call the navigator today and rarely change a listed object; threading `sqlEdited` through their panels is left out. The Refresh tool covers the rare case (a dropped column taking an index with it).
- **DDL typed into a query tab.** The query workspace never refreshed the navigator and still does not.
- **Keeping a renamed schema expanded, or selecting a renamed/created object.** A renamed object is a new node and starts collapsed and unselected, as it does after today's reset.
- **Clearing the Properties inspector when its selected object is dropped.** Unchanged from today.
- **Bumping `@jimka/typescript-ui` in `package.json`.** Done at release time.

---

## Notes

[^fetch-not-compute]: Computing single inserts and removes on the client would mean re-implementing what the server already decides. The listing order comes from `ORDER BY` in the backend queries under the database's collation (`list_schemas.py`, `list_functions.py`, `list_types.py`), which the client cannot reproduce exactly. A drop also removes things the client does not see in the DDL: a table's indexes and its owned `serial` sequences; a rename relabels every index leaf naming the table; a primary-key constraint adds an index. Re-running `loadObjects` gets all of this right at the cost of four small requests per affected schema, which is less than today's reset (it re-fetches every expanded schema). `insertNode`/`removeNode` are therefore not used; `setChildren` with kept node objects gives the same state preservation.

[^identity]: A kind is part of identity for the same reason `matchesObject` compares it ([revealMatch.ts:37-56](frontend/src/navigator/revealMatch.ts#L37)): a sequence and a table may share a schema and a name. The signature separates function overloads, which share a name. Categories carry no `data`, so their label is their identity; the `"category"` prefix keeps a category from ever colliding with an object tuple. `JSON.stringify` of the tuple avoids separator collisions with quoted identifiers that contain `|` or other punctuation.

[^scope-rules]: Why each rule holds. A non-cascading drop, a create, a rename or an alter only changes objects in the object's own schema: indexes live in their table's schema, and PostgreSQL requires an owned sequence to be in its table's schema. CASCADE can drop dependents in any schema (a view in `sales` selecting from `public.orders`), so it widens to every loaded schema. A non-cascading schema drop only succeeds on an empty schema, so only the root level changes. `schemas: []` with `schemaList: true` still handles a dropped schema fully: the root merge removes its node and everything under it. The defensive rule 3 covers a non-schema change that arrives without a schema name, which no current call site produces.

[^edited-sql]: The preview dialog's text is authoritative at execute (plans/implemented/ddl-infrastructure.md's "editable preview is authoritative" decision), so a user can turn a plain drop into a CASCADE drop, or add a second statement. The form's own values then no longer describe what ran. Rather than parse SQL, the dialog reports whether the text changed, and the mapping treats any change as "could have touched anything loaded". A whitespace-only edit also counts as edited; that only costs extra requests. The view/matview definition save is not marked edited: the user edits only the SELECT body, which the backend's create/replace preview wraps in a statement whose schema and name come from the ref.

[^no-reset-fallback]: The request asked for a fallback to the full refresh for changes that cannot be targeted. The widest targeted scope covers every such change: it re-reads the schema list and every schema the tree has loaded, and unloaded schemas re-read themselves on expand. It does this without dropping expansion, selection, scroll, or open tabs' registered nodes, so it is strictly better than the reset for this purpose. With every DDL path moved to `refreshNavigatorAfter`, `refreshNavigator()` has no callers and is removed rather than kept as dead code.

[^seq-guard]: Two DDLs in quick succession can start two fetches of the same schema; if the older one resolves last it would overwrite the newer state. A counter per schema name is enough because every fetch of a given schema returns that schema's whole listing. A full `refresh()` racing a targeted one needs no guard: both fetches start after the DDL committed, so either result is current.

[^no-arm]: Arming the signal would make a reveal issued meanwhile wait for the targeted refresh. That is not needed: typescript-ui 0.10.0's `revealByPredicate` follows `setChildren` calls made while it runs (it finds nodes added meanwhile and never returns a node the tree dropped), and an expand and a reveal share one `loadChildren` call. Waiting on `whenLoaded()` at the start is still needed, because merging into roots that `setNodes` is about to replace would be wasted work, and the expansion restore must finish before `saveExpansion` writes.

[^pure-module]: `NavigatorTree.ts` imports library component modules that touch `document` at import scope, so it cannot load under the node vitest environment. Putting the scope mapping and the merge in a module with only `import type` imports keeps them unit-testable, the same split `treeExpansion.ts` (`TreeExpansionPersistence` tested against a plain `TreeExpansionHost`) and `revealMatch.ts` already use. `reconcileNodes` works on plain `TreeNode` objects, so its tests need no Tree at all.
