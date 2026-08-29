---
touches-shared: [frontend/src/data/api.ts, frontend/src/data/stores.ts, frontend/src/data/loadSignal.ts, frontend/src/shell/localStorageWindow.ts, frontend/src/shell/SqlAdminShell.ts, frontend/src/navigator/NavigatorTree.ts, frontend/src/navigator/objectKinds.ts, frontend/src/roles/RolesTree.ts, frontend/src/properties/PropertiesPanel.ts]
---

# Data layer & explorer-tree convergence — Implementation Plan

Two correctness bugs and a cluster of duplication in the frontend's data layer and its Navigator / Roles / Properties tree UI, fixed in one pass. The bugs: every request path in [frontend/src/data/api.ts](frontend/src/data/api.ts) interpolates database, schema, relation, and role names without percent-encoding them, and [frontend/src/data/loadSignal.ts:27](frontend/src/data/loadSignal.ts#L27)'s `arm()` truncates a wait it documents as extending.

Alongside those two bugs: "Clear SQLAdmin data" ([frontend/src/shell/localStorageWindow.ts:268](frontend/src/shell/localStorageWindow.ts#L268)) splits into two actions so saved connection presets stop being destroyed by an unconfirmed click; the duplicated explorer-tree load lifecycle in [frontend/src/navigator/NavigatorTree.ts:228](frontend/src/navigator/NavigatorTree.ts#L228) and [frontend/src/roles/RolesTree.ts:121](frontend/src/roles/RolesTree.ts#L121) converges onto one abstract base; per-kind display labels move into the [frontend/src/navigator/objectKinds.ts:37](frontend/src/navigator/objectKinds.ts#L37) registry that already calls itself their single source; three dead exports go; and a handful of stale doc comments are corrected.

Test coverage follows the changed code: `apiPath`, `LoadSignal`, the storage-key partition rule, the Properties row mapping, `SqlAdminWriter`, and `buildModel`'s primary-key resolution all gain unit tests under the existing node vitest harness.

---

## Architecture Decisions

### Every request path goes through one `apiPath` builder

`api.ts` gains `apiPath(...segments)`, which percent-encodes each segment and joins them under `/api/`. Every URL in the file is rebuilt through it, including the four static ones (`/api/login`, `/api/logout`, `/api/whoami`, `/api/config`) and the two builders that already encode today, `tableExportUrl` and `getRoleDetail`.[^api-path]

The row-CRUD collection URL currently written inline at [frontend/src/data/stores.ts:25](frontend/src/data/stores.ts#L25) becomes `tableRowsUrl(ref)`, exported from `api.ts` and called by `stores.ts`.[^rows-url]

An `undefined` segment (an absent optional `DbObjectRef` field) becomes an empty segment, matching what `tableExportUrl` does today.[^undefined-segment]

| Call | Result |
|---|---|
| `apiPath("default", "shop", "public", "orders", "columns")` | `/api/default/shop/public/orders/columns` |
| `apiPath("default", "shop", "we/ird", "objects")` | `/api/default/shop/we%2Fird/objects` |
| `apiPath("default", "shop", "a#b", "t", "structure")` | `/api/default/shop/a%23b/t/structure` |
| `apiPath("default", "my db", "public", "objects")` | `/api/default/my%20db/public/objects` |
| `apiPath("default", undefined, "public", "objects")` | `/api/default//public/objects` |

Route words are separate arguments, never one string: `apiPath(c, d, "ddl", "table", "create")` gives `/api/c/d/ddl/table/create`, while `apiPath(c, d, "ddl/table/create")` would give `/api/c/d/ddl%2Ftable%2Fcreate`.

### `LoadSignal` counts outstanding loads

`LoadSignal` keeps one deferred but adds a count of loads that have armed and not yet settled. `arm()` increments it; `settle()` decrements it and resolves the shared promise only when the count reaches zero. A re-`arm()` mid-load therefore extends the wait, which is what the class's own doc comment already claims.[^load-counter]

| Sequence | `whenSettled()` taken after the first `arm()` |
|---|---|
| `arm`, `settle` | resolved |
| `arm`, `arm`, `settle` | still pending |
| `arm`, `arm`, `settle`, `settle` | resolved |
| `arm`, `settle`, `arm` | still pending (a fresh deferred) |
| `settle` alone | resolved (nothing was armed) |

### The Clear action splits in two, and only the presets half confirms

The localStorage inspector gets two buttons instead of one: `Clear {APP_NAME} data` removes every `sqladmin.*` key except the presets key, and `Clear saved connections` removes only the presets key behind a `Dialog.confirm`, mirroring the sign-out confirm at [frontend/src/shell/SqlAdminShell.ts:447](frontend/src/shell/SqlAdminShell.ts#L447).[^presets-confirm]

The partition rule itself moves into a new DOM-free module, `frontend/src/shell/appStorageKeys.ts`, so it can be unit-tested — it is the rule that must never regress.

| localStorage key | `Clear {APP_NAME} data` | `Clear saved connections` |
|---|---|---|
| `sqladmin.history.u.default` | removed | kept |
| `sqladmin.saved.u.default` | removed | kept |
| `sqladmin.notes.u.default` | removed | kept |
| `sqladmin.layout.u.dock` | removed | kept |
| `sqladmin.presets` | kept | removed |
| `theme` (an unrelated origin key) | kept | kept |

### One abstract `ExplorerTreeBase` owns the explorer load lifecycle

`NavigatorTree` and `RolesTree` both extend a new abstract `ExplorerTreeBase<TData>` in `frontend/src/shell/explorerTree.ts`, which owns the `TreeExpansionPersistence` + `LoadSignal` field pair, the expand/collapse wiring, `refresh`, and `whenLoaded`. Each subclass supplies three things: `load()` (fetch the payload), `toNodes(data)` (map it to tree nodes), and `applyDefaultExpansion(data, nodes)` (the first-run default, run only when no saved expansion was restored).

This mirrors [frontend/src/shell/treeExplorerView.ts:63](frontend/src/shell/treeExplorerView.ts#L63), which already converged the two explorer *views* one layer up into a shared base with thin `DatabaseExplorerView` / `RolesExplorerView` subclasses. The `ExplorerTree` interface moves out of `NavigatorTree.ts` into the same new module, next to the base that implements it.[^tree-base-home]

Each subclass constructor keeps its own trailing `this.refresh()` call.[^tree-refresh-call]

### `displayLabel` joins the object-kind registry

`ObjectKindInfo` gains a required `displayLabel`, and `objectKinds.ts` exports `kindDisplayLabel(kind)`. `PropertiesPanel`'s per-kind "Type" row values and its exported `relationTypeLabel` are both replaced by that one lookup; `relationTypeLabel` is deleted and its single external caller ([frontend/src/SqlAdminController.ts:3488](frontend/src/SqlAdminController.ts#L3488)) calls `kindDisplayLabel` instead.[^display-label]

| `kind` | `kindDisplayLabel(kind)` |
|---|---|
| `database` | `Database` |
| `schema` | `Schema` |
| `table` | `Table` |
| `view` | `View` |
| `materializedView` | `Materialized view` |
| `sequence` | `Sequence` |
| `function` | `Function` |
| `type` | `Type` |
| `index` | `Index` |

### The Properties row mapping moves to a DOM-free module

`propertyRows` and its per-kind builders move out of `PropertiesPanel.ts` into `frontend/src/properties/propertyRows.ts`, leaving the panel as the component that calls it. This is how the repo already makes inspector row mappings testable — [frontend/src/roles/roleBaseInfoRows.ts:22](frontend/src/roles/roleBaseInfoRows.ts#L22) is the worked example, with its test at `frontend/tests/roles/roleBaseInfoRows.test.ts`.[^rows-extract]

---

## Public API

```ts
// frontend/src/data/api.ts
export function apiPath(...segments: (string | undefined)[]): string;
export function tableRowsUrl(ref: DbObjectRef): string;
```

```ts
// frontend/src/data/queryStore.ts — was module-private
export function scopeKey(userId: string, connectionId: string): string;
```

```ts
// frontend/src/data/presetStore.ts — was module-private
export const PRESETS_KEY = "sqladmin.presets";
```

```ts
// frontend/src/shell/appStorageKeys.ts — new module
export const APP_KEY_PREFIX = "sqladmin.";
export function isAppKey(key: string): boolean;
export function isDisposableAppKey(key: string): boolean;
export function isPresetKey(key: string): boolean;
```

```ts
// frontend/src/shell/explorerTree.ts — new module
export interface ExplorerTree extends Tree {
    refresh(): void;
    whenLoaded(): Promise<void>;
}

export abstract class ExplorerTreeBase<TData> extends Tree implements ExplorerTree {
    protected readonly controller: SqlAdminController;

    constructor(controller: SqlAdminController, binding: TreeExpansionBinding, nodeKey?: NodeKey);

    refresh: () => void;                       // arrow field — held by reference
    whenLoaded(): Promise<void>;

    protected abstract load(): Promise<TData>;
    protected abstract toNodes(data: TData): TreeNode[];
    protected applyDefaultExpansion(data: TData, nodes: TreeNode[]): void | Promise<void>;
}
```

```ts
// frontend/src/navigator/objectKinds.ts
export interface ObjectKindInfo {
    kind: DbObjectKind;
    glyph: string;
    /** Human-readable name for this kind, shown as the "Type" row / tab tooltip line. */
    displayLabel: string;
    categoryLabel?: string;
    isRelation: boolean;
}

export function kindDisplayLabel(kind: DbObjectKind): string;
```

```ts
// frontend/src/properties/propertyRows.ts — new module
export function propertyRows(ref: DbObjectRef, columns?: ColumnMeta[]): PropertyValueRow[];
```

Removed exports: `relationTypeLabel` (`properties/PropertiesPanel.ts`), `kindGlyph` (`navigator/objectKinds.ts`), `FILTER_ACTIVE_COLOR` (`theme.ts`), `TableListEnvelope` (`contract.ts`).

---

## Internal Structure

`LoadSignal`, after the fix:

```ts
export class LoadSignal {
    private _pending: { promise: Promise<void>; resolve: () => void } | null = null;
    // Loads that have armed and not yet settled. The shared deferred resolves
    // when this returns to zero, so overlapping refreshes extend one wait.
    private _armed: number = 0;

    arm(): void {
        this._armed += 1;

        if (this._pending !== null) {
            return;
        }

        let resolve: () => void = () => {};
        const promise = new Promise<void>(r => { resolve = r; });

        this._pending = { promise, resolve };
    }

    settle(): void {
        if (this._armed === 0) {
            return;
        }

        this._armed -= 1;

        if (this._armed > 0) {
            return;
        }

        const pending = this._pending;

        this._pending = null;
        pending?.resolve();
    }

    whenSettled(): Promise<void> {
        return this._pending?.promise ?? Promise.resolve();
    }
}
```

`ExplorerTreeBase`'s load chain — the single copy of what `NavigatorTree.refresh` and `RolesTree.refresh` each carry today:

```ts
refresh = (): void => {
    this._loaded.arm();

    void this.load()
        .then(async data => {
            const nodes = this.toNodes(data);

            this.setNodes(nodes);

            const restored = await this._expansion.restore();

            // Only when the user has no saved expansion of their own.
            if (!restored) {
                await this.applyDefaultExpansion(data, nodes);
            }
        })
        .catch(error => this.controller.notifyError(error))
        // After the whole chain — the expansion restore included — so a waiting
        // reveal never races the restore into re-collapsing the path it just
        // opened. Attached after the .catch so the signal settles on the failure
        // path too, rather than depending on handler order.
        .finally(() => this._loaded.settle());
};
```

The two subclasses' hook bodies:

```ts
// NavigatorTree — payload is the raw schema list; loadSchemas() disappears,
// its fetch half becoming load() and its mapping half toNodes().
protected load(): Promise<{ name: string }[]> { return getSchemas(this.conn, this.database); }
protected toNodes(schemas: { name: string }[]): TreeNode[] {
    return schemas.map(s => schemaNode(this.conn, this.database, s.name));
}
protected applyDefaultExpansion(_schemas: { name: string }[], nodes: TreeNode[]): void {
    // A single-schema database: expand that lone schema immediately.
    if (nodes.length === 1) {
        this.expandNode(nodes[0]);
    }
}

// RolesTree
protected load(): Promise<RoleSummary[]> { return this.controller.loadRoles(); }
protected toNodes(roles: RoleSummary[]): TreeNode[] { return groupRoles(roles); }
protected async applyDefaultExpansion(roles: RoleSummary[]): Promise<void> {
    const firstUser = roles.find(role => role.canLogin);

    // Awaited, not fired and forgotten: the signal must settle only once this
    // default reveal has finished scrolling, or a waiting reveal of its own can
    // land first and then be scrolled away from by this one.
    if (firstUser) {
        await this.revealByPredicate(data => data === firstUser.name);
    }
}
```

The key-partition rule:

```ts
// frontend/src/shell/appStorageKeys.ts
export function isAppKey(key: string): boolean { return key.startsWith(APP_KEY_PREFIX); }
export function isPresetKey(key: string): boolean { return key === PRESETS_KEY; }
export function isDisposableAppKey(key: string): boolean { return isAppKey(key) && !isPresetKey(key); }
```

---

## Ordered Implementation Steps

1. **`frontend/tests/data/api.test.ts` — write the failing tests first.** Add an `apiPath` describe covering the five rows of the `apiPath` table above, plus one hostile-identifier assertion per route family, each asserting the exact URL passed to the mocked `fetch`: `getObjects("default", "shop", "we/ird")`, `getStructure({… schema: "a#b", name: "my table" …})`, `previewDropTable({… database: "my db" …}, spec)`, `previewImportRows({… name: "od/d" …}, rows)`, `getRoleDetail("default", "role/x")`, and `tableRowsUrl({… name: "my table" …})`. Import `apiPath` and `tableRowsUrl` from `../../src/data/api`. They do not exist yet — the suite must fail.

2. **`frontend/src/data/api.ts` — add the builders and route every URL through them.** Add `apiPath` and `tableRowsUrl` near the top, below `postJson`. Then rewrite all 54 URL constructions in the file (line numbers 141–529 at time of writing) to call `apiPath`, following the shape table:

   | Current literal | Replacement |
   |---|---|
   | `"/api/login"` | `apiPath("login")` |
   | `` `/api/${connectionId}/databases` `` | `apiPath(connectionId, "databases")` |
   | `` `/api/${connectionId}/${database}/${schema}/objects` `` | `apiPath(connectionId, database, schema, "objects")` |
   | `` `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/structure` `` | `apiPath(ref.connectionId, ref.database, ref.schema, ref.name, "structure")` |
   | `` `/api/${ref.connectionId}/${ref.database}/ddl/table/create` `` | `apiPath(ref.connectionId, ref.database, "ddl", "table", "create")` |
   | `` `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/rows/import/preview` `` | `apiPath(ref.connectionId, ref.database, ref.schema, ref.name, "rows", "import", "preview")` |
   | `` `/api/${connectionId}/roles/${encodeURIComponent(role)}` `` | `apiPath(connectionId, "roles", role)` |

   Delete `tableExportUrl`'s local `seg` helper; its body becomes `` `${apiPath(ref.connectionId, ref.database, ref.schema, ref.name, "export")}?format=${format}` ``. Update the `executeDdl` JSDoc's worked example (around line 345) — it currently teaches the raw-interpolation pattern to the next phase that adds a preview method — to the `apiPath` form.

3. **`frontend/src/data/stores.ts` — use `tableRowsUrl`.** Replace the inline `url:` template at line 25 with `url: tableRowsUrl(ref)` and add `tableRowsUrl` to the existing `./api` import. Check: `grep -rn '/api/' frontend/src/data/` returns exactly one line, inside `apiPath`.

4. **`frontend/tests/data/loadSignal.test.ts` — flip the pinned behaviour.** Replace the test at lines 52–63 (`"a second arm() does not replace the deferred, so one settle() resolves it"`) with two tests matching the `LoadSignal` table: a second `arm()` leaves the promise pending after one `settle()`, and the matching second `settle()` resolves it. Leave the other seven tests unchanged — they all still hold. The suite must fail on the new pair.

5. **`frontend/src/data/loadSignal.ts` — add the counter.** Apply the body from `## Internal Structure`. Update the `arm()` doc comment so it describes the counter rather than the old "no-op while armed" wording, and keep the class-level comment's promise that a caller awaiting `whenSettled()` searches a populated tree.

6. **`frontend/tests/navigator/objectKinds.test.ts` — pin `displayLabel`.** Add a test asserting every `OBJECT_KINDS` entry has a non-empty `displayLabel` (mirroring the existing glyph test) and a `kindDisplayLabel` describe asserting all nine rows of the label table.

7. **`frontend/src/navigator/objectKinds.ts` — add the field and the lookup.** Add `displayLabel` to `ObjectKindInfo` (required, documented as the human-readable name) and to all nine `OBJECT_KINDS` entries with the values from the label table. Add `kindDisplayLabel(kind)`, built on the existing private `kindInfo` exactly as `isRelationKind` is. In the same pass, delete the dead `kindGlyph` function (lines 88–95) — `grep -rn 'kindGlyph' frontend/src frontend/tests` must return zero matches afterwards.

8. **`frontend/tests/properties/propertyRows.test.ts` — new test file, new directory.** Cover: each of the nine kinds' rows (`Name`/`Schema`/`Database`/`Type` identity plus the kind-specific extras), a `function` ref with `isProcedure: true` giving `Type: Procedure`, a `table` ref with `columns` adding `Columns` and `Primary key`, a table whose columns have no primary key giving `Primary key: —`, and a composite primary key joined with `, `. Import `propertyRows` from `../../src/properties/propertyRows`, which does not exist yet.

9. **`frontend/src/properties/propertyRows.ts` — extract the mapping.** Move `propertyRows`, `sequenceRows`, `functionRows`, `typeRows`, `indexRows`, and `tableRows` verbatim out of `PropertiesPanel.ts`, then replace every hardcoded `"Type"` row value with `kindDisplayLabel(ref.kind)` — except `functionRows`, which keeps `ref.isProcedure ? "Procedure" : kindDisplayLabel(ref.kind)`. Import `PropertyValueRow` with `import type` from `./PropertyValuePanel`, and give the module a header stating that its only library-facing import is a type, so it stays free of DOM side effects and runs under the node vitest environment (the rule `frontend/src/data/treeExpansion.ts` states for itself).

10. **`frontend/src/properties/PropertiesPanel.ts` — slim to the component.** Delete the moved functions and the whole `relationTypeLabel` function, import `propertyRows` from `./propertyRows`, and update the module header (the "selection→rows mapping" now lives one file over).

11. **`frontend/src/SqlAdminController.ts` — retarget the label call.** Change line 84's import to `import { PropertiesPanel } from "./properties/PropertiesPanel";`, add `kindDisplayLabel` to the existing `./navigator/objectKinds` import surface (line 86 already imports `KIND_GLYPH` from `./navigator/objectGlyphs`; add a separate `import { kindDisplayLabel } from "./navigator/objectKinds";`), and change `panelTooltip` (line 3488) to call `kindDisplayLabel(ref.kind)`. Check: `grep -rn 'relationTypeLabel' frontend/src frontend/tests` returns zero matches.

12. **`frontend/src/shell/explorerTree.ts` — new module.** Move the `ExplorerTree` interface out of `NavigatorTree.ts` (lines 102–111) verbatim, and add `ExplorerTreeBase<TData>` with the constructor, `refresh`, `whenLoaded`, and the three hooks from `## Public API` and `## Internal Structure`. The base does not call `refresh()` itself. Export the interface and the abstract class directly — no `callable()` wrapper, since an abstract class is never constructed.

13. **`frontend/src/navigator/NavigatorTree.ts` — extend the base.** Change the class to `extends ExplorerTreeBase<{ name: string }[]> implements ExplorerTree`; drop the `controller`, `_expansion`, and `_loaded` fields, the `expand`/`collapse` wiring, the `refresh` arrow field, and `whenLoaded`; pass `controller` and `controller.layout.bindTreeExpansion("database")` to `super(...)`. Keep everything else — the renderer factory, the `selection`/`dblclick`/`contextmenu`/`loaderror` handlers, `controller.setNavigator(this)`, and the trailing `this.refresh()`. Add the three hook implementations from `## Internal Structure`, and delete the now-empty `loadSchemas` helper (lines 263–267), whose two halves become `load()` and `toNodes()`. In the same pass, fix the module header (lines 2–4): its category list omits Indexes, which has shipped since the navigator-indexes-category phase.

14. **`frontend/src/roles/RolesTree.ts` — extend the base.** Same treatment: `extends ExplorerTreeBase<RoleSummary[]> implements ExplorerTree`, pass `controller`, `controller.layout.bindTreeExpansion("roles")`, and `roleNodeKey` to `super(...)`, drop the same five members, keep the handlers, `controller.setRolesTree(this)`, and the trailing `this.refresh()`. Import `ExplorerTree`/`ExplorerTreeBase` from `../shell/explorerTree` instead of `ExplorerTree` from `../navigator/NavigatorTree`, and import `RoleSummary` from `../contract`.

15. **`frontend/src/shell/treeExplorerView.ts` and `frontend/src/SqlAdminController.ts` — retarget the interface import.** Both currently import `ExplorerTree` from `../navigator/NavigatorTree` / `./navigator/NavigatorTree`; point them at `./explorerTree` / `./shell/explorerTree`. Check: `grep -rn 'interface ExplorerTree' frontend/src` returns exactly one line, in `shell/explorerTree.ts`, and neither of the two files above still names `NavigatorTree` in an import.

16. **`frontend/tests/shell/appStorageKeys.test.ts` — new test file.** Assert `isAppKey`, `isPresetKey`, and `isDisposableAppKey` against every row of the clear-partition table, including the unrelated `theme` key.

17. **`frontend/src/data/presetStore.ts` — export the key, fix the header.** Add `export` to `PRESETS_KEY` (line 15). Update the header comment (line 5): the presets key is no longer covered by "Clear SQLAdmin data" — it has its own confirmed action.

18. **`frontend/src/shell/appStorageKeys.ts` — new module.** `APP_KEY_PREFIX` moves here from `localStorageWindow.ts`; add `isAppKey`, `isPresetKey`, and `isDisposableAppKey` per `## Internal Structure`. Its only import is `PRESETS_KEY` from `../data/presetStore`; document that the module is DOM-free so the partition rule is unit-testable.

19. **`frontend/src/shell/localStorageWindow.ts` — split the clear action.** Replace `clearAppKeys` with one `clearKeys(matches: (key: string) => boolean)` helper keeping the existing snapshot-then-remove comment, import `APP_KEY_PREFIX`, `isDisposableAppKey`, and `isPresetKey` from `./appStorageKeys`, and delete the local `APP_KEY_PREFIX`. In `buildContent`, keep the existing `Clear ${APP_NAME} data` button but wire it to `clearKeys(isDisposableAppKey)`, and add a `Clear saved connections` button before Close, wired to a module-level `async function confirmClearPresets(onCleared: () => void)` that runs `Dialog.confirm("Clear saved connections", "Delete every saved connection? Saved connections cannot be recovered.")` and, when confirmed, calls `clearKeys(isPresetKey)` then `onCleared()`. The handler is `() => { void confirmClearPresets(refresh); }`, mirroring `SqlAdminShell`'s `onLogout`. Import `Dialog` from `@jimka/typescript-ui/overlay` (the module already imports `Window` from there).

20. **`frontend/src/shell/localStorageWindow.ts` — rewrite the header's wrong claims.** Line 3's "offers a one-click 'Clear SQLAdmin data'" now describes two buttons, not one. The claim that JSON parsing succeeds for "every `sqladmin.*` value" (lines 16 and 168) is false: `NotesStore` stores raw Markdown under `sqladmin.notes.*` with no JSON wrapper, and the `catch` branch is what actually renders it. Say that instead. Then restate the key inventory (lines 19–28) as the five real families — `sqladmin.history.*` and `sqladmin.saved.*` (`data/queryStore.ts`), `sqladmin.notes.*` (`data/notesStore.ts`), `sqladmin.layout.*` (`data/layoutStore.ts`), and `sqladmin.presets` (`data/presetStore.ts`) — and say which of the two buttons clears which. The audit's claim that the header omits notes is wrong; only presets was missing from it, in both the header and the `APP_KEY_PREFIX` comment.

21. **`frontend/src/data/queryStore.ts` and `frontend/src/data/notesStore.ts` — share `scopeKey`.** Export `scopeKey` from `queryStore.ts` and have `NotesStore`'s constructor build its key as `NOTES_KEY_PREFIX + scopeKey(userId, connectionId)`.[^scope-key] Fix `queryStore.ts`'s comment at line 50, which calls notes a "per-user-only" setting — the notes key carries both segments, exactly like history and saved queries. The existing `"stores under the key sqladmin.notes.<user>.<connectionId>"` test is the regression check; it must still pass unchanged.

22. **Remove the two remaining dead exports.** Delete `FILTER_ACTIVE_COLOR` (`frontend/src/theme.ts:33-34`) and `TableListEnvelope` (`frontend/src/contract.ts:106-110`). Check: `grep -rn 'FILTER_ACTIVE_COLOR\|TableListEnvelope' frontend/src frontend/tests` returns zero matches.

23. **`frontend/tests/data/SqlAdminWriter.test.ts` — new test file.** Cover `writeRecord` stripping a generated column, `writeRecord` with an empty generated set passing the data through unchanged, `writeRecords` stripping across an array, and a generated-column name that matches no field being a no-op. Build records as `new ModelRecord(model, data)` against a small `Model`, following `frontend/tests/data/buildModel.test.ts`'s import style.

24. **`frontend/tests/data/buildModel.test.ts` — cover `buildModel`.** Add a `buildModel` describe: fields and order map exactly as `buildQueryModel`'s do; `getPrimaryKeyField()` names the column flagged `isPrimaryKey`; it is `undefined` when no column is flagged; and with two flagged columns the model takes the first in column order — pinned as current behaviour, with a comment saying a composite primary key is not modelled.[^composite-pk]

25. **Run the full verification set** in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/shell/explorerTree.ts` |
| Create | `frontend/src/shell/appStorageKeys.ts` |
| Create | `frontend/src/properties/propertyRows.ts` |
| Create | `frontend/tests/shell/appStorageKeys.test.ts` |
| Create | `frontend/tests/properties/propertyRows.test.ts` |
| Create | `frontend/tests/data/SqlAdminWriter.test.ts` |
| Modify | `frontend/src/data/api.ts` |
| Modify | `frontend/src/data/stores.ts` |
| Modify | `frontend/src/data/loadSignal.ts` |
| Modify | `frontend/src/data/presetStore.ts` |
| Modify | `frontend/src/data/queryStore.ts` |
| Modify | `frontend/src/data/notesStore.ts` |
| Modify | `frontend/src/contract.ts` |
| Modify | `frontend/src/theme.ts` |
| Modify | `frontend/src/navigator/objectKinds.ts` |
| Modify | `frontend/src/navigator/NavigatorTree.ts` |
| Modify | `frontend/src/roles/RolesTree.ts` |
| Modify | `frontend/src/properties/PropertiesPanel.ts` |
| Modify | `frontend/src/shell/localStorageWindow.ts` |
| Modify | `frontend/src/shell/treeExplorerView.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/tests/data/api.test.ts` |
| Modify | `frontend/tests/data/loadSignal.test.ts` |
| Modify | `frontend/tests/data/buildModel.test.ts` |
| Modify | `frontend/tests/navigator/objectKinds.test.ts` |

---

## Expected Behaviour

**Unit-testable.**

- `apiPath` returns each row of the `apiPath` table above, verbatim.
- `apiPath()` with no segments returns `/api/`; `apiPath("login")` returns `/api/login`.
- Every `api.ts` builder passes a fully encoded URL to `fetch`. With `schema: "a#b"`, `getStructure` requests `/api/default/shop/a%23b/t/structure` — today it requests `/api/default/shop/a` and drops the rest client-side.
- `tableRowsUrl({connectionId: "default", database: "shop", schema: "public", name: "my table", kind: "table"})` is `/api/default/shop/public/my%20table/rows`.
- `getRoleDetail` and `tableExportUrl` produce byte-identical URLs to today for both ordinary and odd identifiers — they already encoded, and routing them through `apiPath` must not change their output.
- `LoadSignal` behaves as its table above: two overlapping `arm()`s need two `settle()`s, and `whenSettled()` hands out the same promise object for the whole span.
- `LoadSignal.settle()` with nothing armed neither throws nor leaves the signal armed, and never drives the count below zero (a stray extra `settle()` followed by `arm()` still yields a pending promise).
- `kindDisplayLabel` returns each row of the label table; `OBJECT_KINDS` has a non-empty `displayLabel` on all nine entries.
- `propertyRows` for a `function` ref with `isProcedure: true` gives `Type: Procedure`; with `isProcedure` unset it gives `Type: Function`.
- `propertyRows` for a `materializedView` gives `Type: Materialized view`; for `index` it also carries a `Table` row; for `sequence`, `type`, `function`, `schema`, and `database` it carries only the identity rows those builders carry today.
- `propertyRows` for a table with columns appends `Columns` (the count as a string) and `Primary key` (flagged column names joined with `, `, or `—` when none is flagged).
- `isDisposableAppKey`, `isPresetKey`, and `isAppKey` return each row of the clear-partition table.
- `NotesStore` still stores under `sqladmin.notes.<user>.<connectionId>` after routing through `scopeKey`.
- `SqlAdminWriter.writeRecord` omits every name in its generated set and keeps every other field; `writeRecords` does the same across an array; an empty set changes nothing.
- `buildModel` sets the model's primary key to the first column flagged `isPrimaryKey`, and leaves it undefined when none is.

**Manual verification** (the test harness is node-only; `Tree`, `Window`, `Dialog`, and `Button` all touch the DOM at import scope).

- Database rail: the tree loads, a single-schema database still auto-expands its lone schema on a first run, expansion state still survives a reload, and the section Refresh tool (and Alt+R) still reloads it.
- Roles rail: the tree loads, the first login role is still revealed on a first run, and the Users section is open while Groups / Predefined stay collapsed.
- A deep link into a table (address bar route) still reveals the node — the reveal awaits `whenLoaded()`, and with two refreshes in flight it must now wait for both.
- A table, view, sequence, function, type, and index each show the right `Type` row in the Properties inspector, and an open tab's hover tooltip shows the same label.
- Tools → Show localStorage…: `Clear SQLAdmin data` empties history / saved queries / notes / layout and leaves `presets` in the key tree; `Clear saved connections` asks first, Cancel changes nothing, OK removes only `presets`; the key tree refreshes in place after either.
- A database, schema, or table whose name contains a space or `#` opens, lists, and exports correctly (create one in a scratch database to exercise it).

---

## Verification

```bash
cd frontend
npm run typecheck
npm run test
npm run build
```

Grep invariants (run from the repo root, each expecting the stated result):

```bash
grep -rn '/api/' frontend/src/data/                        # exactly 1 line — inside apiPath
grep -rn 'encodeURIComponent' frontend/src/data/           # exactly 1 line — inside apiPath
grep -rn 'kindGlyph\|relationTypeLabel' frontend/src frontend/tests   # 0
grep -rn 'FILTER_ACTIVE_COLOR\|TableListEnvelope' frontend/src frontend/tests   # 0
grep -rn 'clearAppKeys' frontend/src                       # 0
grep -rn 'interface ExplorerTree' frontend/src             # exactly 1 line — shell/explorerTree.ts
grep -rn 'ExplorerTree' frontend/src/SqlAdminController.ts frontend/src/shell/treeExplorerView.ts frontend/src/roles/RolesTree.ts   # every import names shell/explorerTree
```

Manual smoke: run the app with the project's `/verify` skill, sign in, and walk the manual list in `## Expected Behaviour`.

---

## Potential Challenges

- **A missed encoding site is silent.** The `grep -rn '/api/' frontend/src/data/` invariant is the mechanical catch — it fails loudly if any template literal keeps its own `/api/` prefix.
- **Splitting a route word across `apiPath` arguments.** Passing `"ddl/table/create"` as one argument yields `%2F`-escaped slashes and a 404. The per-family assertions in step 1 cover the DDL and import shapes.
- **Constructor ordering in the tree subclasses.** Subclass fields (`conn`, `database`, `contextMenu`) are assigned after `super()` returns, so the base must not call `refresh()`; each subclass keeps its own trailing call. Reversing that produces a tree that loads against `undefined` field values.
- **`RolesTree`'s `applyDefaultExpansion` must return its promise.** The base awaits the hook, so an override that fires the reveal without returning it lets the load signal settle early — and a waiting reveal then gets scrolled away from by the default one.
- **`Dialog.confirm` over a non-modal `Window`.** The inspector is a `Window`, not a `Dialog`; confirm the modal renders above it and that Cancel leaves the window usable.
- **`import type` discipline in `propertyRows.ts`.** A plain (non-`type`) import of `PropertyValuePanel` pulls `Table`/`Panel` into the node test environment and breaks the new suite.

---

## Critical Files

- [frontend/src/shell/treeExplorerView.ts](frontend/src/shell/treeExplorerView.ts) — the precedent for the tree convergence: a shared base plus thin per-rail subclasses. Read with [frontend/src/shell/DatabaseExplorerView.ts](frontend/src/shell/DatabaseExplorerView.ts) and [frontend/src/shell/RolesExplorerView.ts](frontend/src/shell/RolesExplorerView.ts).
- [frontend/src/roles/roleBaseInfoRows.ts](frontend/src/roles/roleBaseInfoRows.ts) — the precedent for extracting an inspector's row mapping into a DOM-free, node-testable module.
- [frontend/src/data/treeExpansion.ts](frontend/src/data/treeExpansion.ts) — states the `import type`-only rule the two new pure modules follow, and owns `TreeExpansionPersistence`, whose constructor the tree base now calls.
- [frontend/src/navigator/objectGlyphs.ts](frontend/src/navigator/objectGlyphs.ts) — the precedent for deriving a per-kind table off `OBJECT_KINDS` instead of hand-maintaining it.
- [frontend/src/shell/SqlAdminShell.ts:447](frontend/src/shell/SqlAdminShell.ts#L447) — `confirmSignOut`, the shape the presets confirm mirrors.
- [frontend/COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) — sections (b) super-cascade and (c) arrow-function fields both bind the tree base.
- [plans/research/codebase-health-audit-2026-08-29.md](plans/research/codebase-health-audit-2026-08-29.md) — Priority 1 #8/#9/#10, Priority 2 #14/#15, and the Priority 3/4 frontend bullets this plan closes.

---

## Non-Goals

- **Composite primary keys.** `buildModel` takes the first flagged column; the library `Model` has one primary-key field. Step 24 pins that behaviour rather than changing it.
- **The remaining Priority 3 dead exports** (`ROOT_NONE`, the three edge-data types, `ShortcutScope`, the dead `ddlSpecs` drop branches). They sit in diagram and DDL files this plan never opens.
- **`SqlAdminController`'s size.** The audit lists its split as needing a design decision; this plan touches three of its import lines and one call site.
- **Backend encoding.** `Content-Disposition` building from unsanitized identifiers (audit Priority 1 #16) is a backend fix on its own.
- **Colouring the clear buttons.** The confirm dialog is the guard; adding a `DESTRUCTIVE_COLOR` tint is a separate visual decision.

---

## Notes

[^api-path]: A whole-path builder rather than a bare segment encoder, because a per-interpolation wrap has no mechanical check: 48 unencoded sites each need a hand-added `seg(...)` around each of ~90 interpolations, and an omission looks exactly like the correct code in review. Routing every URL through `apiPath` reduces the check to one grep — no `/api/` literal may survive anywhere in `frontend/src/data/` except inside `apiPath` itself. The four static paths (`/api/login`, `/api/logout`, `/api/whoami`, `/api/config`) go through it too, purely so that invariant is "exactly one" rather than "exactly five". The encoder body is `tableExportUrl`'s existing local `seg` helper, unchanged: `encodeURIComponent`.

[^rows-url]: `stores.ts`'s header says the row-CRUD path deliberately does not go through `api.ts`'s typed fetch, and that stays true — the `AjaxProxy` still owns every row request. Only the *path* moves, to the module that owns path construction, which is what makes the one-`/api/`-literal invariant hold across `frontend/src/data/` and what makes the row URL unit-testable at all (an `AjaxStore`'s configured proxy URL is not readable back).

[^undefined-segment]: `DbObjectRef.database`, `.schema`, and `.name` are all optional, so an interpolated `undefined` currently produces the literal string `undefined` inside the path. `tableExportUrl` already coerces those to `""`; `apiPath` does the same for every builder. Both requests fail, so this is not a behaviour regression — an empty segment is merely the more honest of the two, and it keeps `apiPath`'s output a pure function of its arguments.

[^load-counter]: The alternative — replacing the deferred on every `arm()` — is what the current comment explicitly warns against: the first load's `settle()` would then resolve a promise nobody holds, and any caller who took `whenSettled()` before the re-arm would wait forever. Keeping one deferred and counting the outstanding loads gives the documented "extend the wait" semantics without ever handing out a promise that has no resolver. Both trees pair every `arm()` with exactly one `settle()` in a `.finally`, so the count cannot drift; `settle()` still guards against an unmatched call.

[^presets-confirm]: The two halves differ in recoverability, and that is the whole reason for the split. History, saved queries, notes, and layout are either regenerable or cheap to lose; a saved connection preset carries a host, port, database, and username the user typed once and cannot get back. Confirming both would train the user to click through the dialog, which is how the destructive one gets confirmed by reflex — so only the presets action asks.

[^tree-base-home]: `shell/` already hosts the shared assembly for exactly this pair of rails (`treeExplorerView.ts`), and `dock/QueryPanel.ts` already imports from `shell/`, so `navigator/` and `roles/` importing a shell module introduces no new direction of dependency. Moving the `ExplorerTree` interface along with the base keeps the contract and its only implementation in one file; leaving the interface in `NavigatorTree.ts` would have `shell/explorerTree.ts` and `navigator/NavigatorTree.ts` importing from each other. The cost is a one-line import change in `treeExplorerView.ts` and one in `SqlAdminController.ts`.

[^tree-refresh-call]: A base-constructor `refresh()` would run before the subclass constructor body has assigned `conn`, `database`, and `contextMenu` — field initializers and constructor bodies of a subclass both run after `super()` returns. Each subclass therefore keeps the trailing `this.refresh()` it has today. The `refresh` arrow field itself is a base field initializer, so it exists by the time the subclass body calls it.

[^display-label]: `displayLabel` is required, not optional, so a kind added later cannot silently fall through to a wrong label: TypeScript rejects a registry entry that omits it, and step 6's non-empty test catches an empty string. `Procedure` stays a caller-side override in `functionRows`: it is selected by `DbObjectRef.isProcedure`, a per-object flag, not by kind — the navigator files both procedures and functions under the one `"function"` kind. `relationTypeLabel` is deleted rather than kept as a delegate: it is named for relations but already carries apologetic branches for three non-relation kinds, and those branches are exactly the duplicated data the registry now owns.

[^rows-extract]: `PropertiesPanel.ts` imports `PropertyValuePanel`, which imports `Table` and `Panel` — library component modules that touch `document` at import scope, so nothing in that file can be reached from the node vitest environment. Every comparable mapping in the repo is already split out for this reason (`roles/roleBaseInfoRows.ts`, `dock/structureRows.ts`, `dock/typeInfoRows.ts`), each with a matching test. The extraction is what makes a `frontend/tests/properties/` directory — absent today — possible at all.

[^composite-pk]: `buildModel` passes one `primaryKey` name to the library `Model`, so a table with a composite primary key gets only its first key column, and `record.getId()` cannot round-trip such a row. That is pre-existing and orthogonal to everything else here — writing a test that documents it is worth doing now; changing it means a `Model` API that takes multiple key fields, which is a library-side design question.

[^scope-key]: `notesStore.ts` already imports `KeyValueStore` from `queryStore.ts`, so the dependency exists and no new coupling is created; the two were building the same `<user>.<connection>` suffix from two copies of the same template literal. `scopeKey`'s own doc comment says it is "kept in one place so the two stores stay in step" while one of the three stores that uses the scheme could not see it.
