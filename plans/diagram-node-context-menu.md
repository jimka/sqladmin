# Diagram Node Context Menu — Implementation Plan

## Overview

Make a right-click on a **diagram node** show the same context menu the user gets from right-clicking that object in the navigator tree. Today only the navigator tree ([`src/navigator/NavigatorTree.ts:170`](src/navigator/NavigatorTree.ts#L170)) builds a per-object `MenuItemConfig[]`; the diagram panels ([`src/dock/SchemaDiagramPanel.ts`](src/dock/SchemaDiagramPanel.ts) and its siblings) only handle double-click.

The work is in two parts. First, **extract** the tree's per-object menu-item builder into a shared, DOM-free pure function `buildObjectMenuItems(ref, actions, node?)` in a new module `src/navigator/objectMenu.ts`, plus a small `showObjectMenu(...)` wrapper — so the tree and the diagrams build identical menus from one source. Second, **wire** each database-object diagram panel to the library's new `"contextmenu"` event and route it through a controller method `diagramContextMenu(ref, event)` that reuses the shared builder.

The double-click half of the request already works and needs no code change — see [Double-click parity (confirm-only)](#double-click-parity-confirm-only).

This plan depends on a library change shipping first: `DiagramView` must emit a `"contextmenu"` event. See [Library dependency](#library-dependency) — do not start until the installed `@jimka/typescript-ui` build exposes it.

---

## Library dependency

`SchemaDiagramPanel` and its siblings extend the library's `DiagramView`. The app subscribes to `DiagramView` events with `.on(...)`. Today `DiagramView` emits only `"selection" | "activate" | "layout"` ([`packages/lib/.../DiagramView.ts:34`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L34)) — there is **no** `"contextmenu"` event yet.

The parallel **diagram-viewport-navigation** plan (in the `@jimka/typescript-ui` library repo, not this repo) adds it, with this exact signature:

```ts
on(event: "contextmenu", listener: (node: DiagramNodeData, event: MouseEvent) => void): this;
```

It fires only when a **node** is right-clicked; a right-click on empty canvas emits nothing. The app consumes the library's built (symlinked, gitignored) `dist/lib`, so the event only becomes available after the library is rebuilt with that change.

This is a cross-repo dependency, so it is **not** expressed as `depends-on` frontmatter (that key only orders plans inside this repo's `plans/implemented/`). Instead, the first implementation step is a hard gate: confirm the event exists before writing any wiring, or the `.on("contextmenu", …)` calls will not typecheck.

---

## Architecture Decisions

### Extract one pure menu-item builder, mirror the Structure-panel precedent

The per-object menu items move verbatim into `buildObjectMenuItems(ref, actions, node?): MenuItemConfig[]` in a new DOM-free module `src/navigator/objectMenu.ts`. This mirrors [`src/dock/menuItems.ts`](src/dock/menuItems.ts) — the app's existing pattern for a shared, unit-testable menu-item builder that keeps its DOM-touching dependencies out so node vitest can import it.[^precedent]

The builder is keyed on `ref.kind`: a branch each for `schema`, `sequence`, `function`, `type`, and the relation kinds (`table` / `view` / `materializedView`), and `[]` for anything else. Returning `[]` (rather than showing nothing via an early `return`) lets both callers share one "empty means don't show" guard, matching how `menuItems.ts` treats an empty list ([`src/dock/menuItems.ts:70`](src/dock/menuItems.ts#L70)).

### The builder takes a narrowed slice of the controller, not the whole controller

The action closures call ~31 controller methods (`openTable`, `openStructure`, `renameTable`, `dropTable`, `createTable`, `exportTable`, …). The builder's `actions` parameter is typed `ObjectMenuActions`, a `Pick<>` of exactly those methods from `SqlAdminController`.[^actions-type] The tree passes `this.controller`; the controller passes `this`; both satisfy the pick structurally. The import of `SqlAdminController` is **type-only**, so it is erased at runtime and creates no import cycle and no DOM dependency.

### Glyphs stay string-referenced; registration is unchanged

`objectMenu.ts` names glyphs by their registered string (`"pencil"`, `"trash"`, `"diagram-project"`, …) and imports **no** glyph modules — importing them pulls the DOM-touching display bundle and breaks the node-vitest import, the same reason [`buildSchemaDiagram.ts:36`](src/data/buildSchemaDiagram.ts#L36) keeps its glyph as a literal. Glyph *registration* is left exactly where it is: `NavigatorTree`'s module-level `Glyph.register(...)` ([`src/navigator/NavigatorTree.ts:43`](src/navigator/NavigatorTree.ts#L43)) and the controller's own registrations already run at app load, before any diagram tab can be opened, and `Glyph.register` is global.[^glyphs]

### Each panel gets an optional `onContextMenu` callback, parallel to its activate callback

Every diagram panel already receives its open action as a constructor callback (`onSelectTable`, `onOpenTable`, `onSelect`) and subscribes to `"activate"` internally. The context menu follows the same seam: an **optional** `onContextMenu?` callback with the same argument shape as that panel's activate callback plus a trailing `MouseEvent`. The panel wires `this.on("contextmenu", …)` only to forward to it.

The callback is optional because `RelationDiagramPanel` is reused for the **role-membership** graph, whose nodes are roles, not database objects ([`src/SqlAdminController.ts:2592`](src/SqlAdminController.ts#L2592)). That caller omits `onContextMenu`, so a role node shows no object menu.[^membership]

### One reusable Menu on the controller; the wrapper lives in the DOM-free module

The controller gains a single reusable `private readonly _objectMenu = Menu()` and a `private diagramContextMenu(ref, event)`, mirroring how `NavigatorTree` and `RolesTree` each own one reusable `Menu()`. The distinct name (not `showObjectMenu`) avoids shadowing the imported module wrapper inside the controller. The `showObjectMenu(menu, ref, actions, event, node?)` **wrapper** — the piece that calls `menu.show(...)` after building the items and guards the empty list — lives in `objectMenu.ts` beside the builder, using a **type-only** `import type { Menu }` so the module stays node-vitest-importable (the real `Menu` instance is passed in at the call site).

### App consumes the library `"contextmenu"` event exactly as `QueriesView` consumes the List one

The precedent for turning a library `"contextmenu"` event into a shown `Menu` in this app is `QueriesView` ([`src/shell/QueriesView.ts:307`](src/shell/QueriesView.ts#L307)): it owns a reusable `Menu`, subscribes with `list.on("contextmenu", (index, e) => …)`, and calls `menu.show(e.clientX, e.clientY, items)`. The diagram wiring follows the same shape (`view.on("contextmenu", (node, event) => …)` → `menu.show(...)`), differing only in that the item builder is the shared `buildObjectMenuItems`.

---

## Public API

### `src/navigator/objectMenu.ts` (new)

```ts
import type { Menu } from "@jimka/typescript-ui/overlay";
import type { MenuItemConfig } from "@jimka/typescript-ui/component/container";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { DbObjectRef } from "../contract";
import type { SqlAdminController } from "../SqlAdminController";

/**
 * The controller methods the object context menu invokes. A narrowed slice of
 * SqlAdminController so the tree and the diagram panels build identical menus
 * without the builder depending on the whole controller. The controller (and
 * `this.controller` in the tree) satisfies it structurally.
 */
export type ObjectMenuActions = Pick<SqlAdminController,
    | "openTable" | "openQueryFor" | "openStructure" | "openDefinition"
    | "openSequence" | "openFunctionDefinition" | "executeFunction"
    | "openRelationDiagram" | "openRelationDependencyGraph" | "openRelationInheritanceGraph"
    | "openSchemaDiagram" | "openSchemaDependencyGraph" | "openSchemaInheritanceGraph"
    | "openDatabaseDiagram"
    | "renameTable" | "dropTable" | "dropRelation" | "refreshMaterializedView"
    | "renameSchema" | "dropSchema"
    | "createTable" | "createView" | "createMaterializedView" | "createSequence"
    | "createType" | "createFunction"
    | "dropSequence" | "dropFunction" | "editType" | "dropType"
    | "exportTable">;

/**
 * Build the context-menu items for one database object, keyed on `ref.kind`.
 * Returns [] for a kind with no menu (database, or an unhandled kind).
 *
 * @param ref - The object the menu acts on.
 * @param actions - The controller slice the item actions dispatch to.
 * @param node - The object's navigator TreeNode when the caller is the tree;
 *   omitted by the diagram panels (which have no tree node). Threaded into the
 *   action closures that accept an optional node; never read to decide item
 *   text or structure, so the same ref yields the same items with or without it.
 * @returns The menu items, or [] when the kind has no menu.
 */
export function buildObjectMenuItems(
    ref: DbObjectRef,
    actions: ObjectMenuActions,
    node?: TreeNode,
): MenuItemConfig[];

/**
 * Build the items for `ref` and, when non-empty, show them on `menu` at the
 * event's client coordinates. A no-op when the kind has no menu.
 */
export function showObjectMenu(
    menu: Menu,
    ref: DbObjectRef,
    actions: ObjectMenuActions,
    event: MouseEvent,
    node?: TreeNode,
): void;
```

### `SqlAdminController` (modified)

```ts
// New reusable menu + convenience method (mirrors NavigatorTree's contextMenu field).
// Named diagramContextMenu, not showObjectMenu, so it does not shadow the imported wrapper.
private readonly _objectMenu: Menu;              // = Menu()
private diagramContextMenu(ref: DbObjectRef, event: MouseEvent): void;   // → showObjectMenu(this._objectMenu, ref, this, event)

// Two signatures relaxed so the shared builder (which threads node?) typechecks:
async openDefinition(ref: DbObjectRef, node?: TreeNode): Promise<void>;          // was node: TreeNode
async openFunctionDefinition(ref: DbObjectRef, node?: TreeNode): Promise<void>;  // was node: TreeNode
```

### Diagram panels (modified) — new optional constructor callback each

```ts
// SchemaDiagramPanel
constructor(data: DiagramData, onSelectTable: (table: string) => void,
            onContextMenu?: (table: string, event: MouseEvent) => void);

// RelationDiagramPanel
constructor(full: DiagramData, root: DiagramNodeData, onSelectTable: (table: string) => void,
            onContextMenu?: (table: string, event: MouseEvent) => void);

// DatabaseDiagramPanel
constructor(schemas: SchemaTables[], onSelectTable: (schema: string, table: string) => void,
            onContextMenu?: (schema: string, table: string, event: MouseEvent) => void);

// RelationGraphPanel
constructor(data: DiagramData, onSelect: (node: RelationNodeData) => void,
            rootId?: string,
            onContextMenu?: (node: RelationNodeData, event: MouseEvent) => void);

// RoleGrantsDiagramPanel
constructor(data: DiagramData, onOpenTable: (schema: string, table: string) => void,
            onContextMenu?: (schema: string, table: string, event: MouseEvent) => void);
```

`RelationGraphPanel` keeps `rootId` in its current position (third) and appends `onContextMenu` fourth, so its three existing call sites are unaffected.

---

## Internal Structure

### The builder body is the current tree handler, moved

`buildObjectMenuItems` is the body of `NavigatorTree`'s `this.on("contextmenu", …)` handler ([`src/navigator/NavigatorTree.ts:170`](src/navigator/NavigatorTree.ts#L170)), transformed by three mechanical edits:

1. `this.controller.foo(...)` → `actions.foo(...)`.
2. Each per-kind branch's `this.contextMenu.show(x, y, [ … ]); return;` becomes `return [ … ];`.
3. The trailing relation block's `this.contextMenu.show(x, y, items);` becomes `return items;`. The opening `if (!ref || !isRelation(ref.kind)) { return; }` becomes `if (!isRelationKind(ref.kind)) { return []; }` (the `!ref` case is handled by the tree before it calls the builder — the builder's `ref` is non-optional).

Keep `isRelationKind` imported from [`./objectKinds`](src/navigator/objectKinds.ts) (DOM-free). The relation block's local `const items: MenuItemConfig[] = [ … ]` and its `items.push(...)` sequence move unchanged.

### The tree handler shrinks to a call

```ts
this.on("contextmenu", (node: TreeNode, event: MouseEvent) => {
    const ref = node.data as DbObjectRef | undefined;

    if (!ref) {
        return;
    }

    showObjectMenu(this.contextMenu, ref, this.controller, event, node);
});
```

### Each panel forwards the library event to its callback

`SchemaDiagramPanel` and `RelationDiagramPanel` (every node is a table):

```ts
// after super(), beside the existing "activate" wiring
this.on("contextmenu", (node: DiagramNodeData, event: MouseEvent) => {
    onContextMenu?.(node.id, event);
});
```

`DatabaseDiagramPanel` mirrors its `"activate"` branch logic ([`src/dock/DatabaseDiagramPanel.ts:173`](src/dock/DatabaseDiagramPanel.ts#L173)) — only a Tables-mode leaf forwards; an Overview schema node or a container box does not:

```ts
this.view.on("contextmenu", (node: DiagramNodeData, event: MouseEvent) => {
    if (this.mode === "overview" || (node.children?.length ?? 0) > 0) {
        return;
    }

    const data = node.data as TableNodeData | undefined;

    if (data) {
        onContextMenu?.(data.schema, data.table, event);
    }
});
```

`RelationGraphPanel` forwards the node's `RelationNodeData` (mirroring its activate `n.data as RelationNodeData`):

```ts
this.on("contextmenu", (n: DiagramNodeData, event: MouseEvent) => {
    onContextMenu?.(n.data as RelationNodeData, event);
});
```

`RoleGrantsDiagramPanel` forwards only a table node (mirroring its activate branch — the role node has no object menu):

```ts
this.on("contextmenu", (node: DiagramNodeData, event: MouseEvent) => {
    const meta = node.data as GrantNodeData | undefined;

    if (meta?.kind === "table") {
        onContextMenu?.(meta.schema, meta.table, event);
    }
});
```

### Controller wires each open-method's panel construction

Each construction gains the `onContextMenu` argument, building a `DbObjectRef` the same way that panel's activate closure builds its open target, then calling `this.diagramContextMenu(ref, event)`. Worked examples:

```ts
// openSchemaDiagram — hardcoded schema, kind table (mirrors its openReferencedTable closure)
return SchemaDiagramPanel(
    data,
    table => this.openReferencedTable({ connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name: table, kind: "table" }),
    (table, event) => this.diagramContextMenu({ connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name: table, kind: "table" }, event),
);

// openSchemaDependencyGraph / the other three RelationGraphPanel methods — kind from the node
return RelationGraphPanel(
    data,
    nd => this.openReferencedTable({ connectionId: ref.connectionId, database: ref.database, schema: nd.schema, name: nd.name, kind: nd.kind }),
    undefined,   // rootId (unchanged where already present; pass the existing root.id for the rooted graphs)
    (nd, event) => this.diagramContextMenu({ connectionId: ref.connectionId, database: ref.database, schema: nd.schema, name: nd.name, kind: nd.kind }, event),
);

// openRoleGrantsDiagram — grants are within the connected database, so use the session db
return RoleGrantsDiagramPanel(
    data,
    (schema, table) => this.openGrantedTable(schema, table),
    (schema, table, event) => this.diagramContextMenu({ connectionId: this._connectionId, database: this._database, schema, name: table, kind: "table" }, event),
);

// openRoleMembershipDiagram — RelationDiagramPanel reused for ROLE nodes: pass NO onContextMenu (unchanged call)
return RelationDiagramPanel(full, root, roleName => void this.showRoleProperties(roleName));
```

The two rooted `RelationGraphPanel` calls (`openRelationDependencyGraph`, `openRelationInheritanceGraph`) already pass `root.id` as the third argument — keep it and append the `onContextMenu` fourth.

---

## Ordered Implementation Steps

1. **Gate on the library event.** In the app, confirm `DiagramView`'s `on` overloads include `"contextmenu"`: `grep -rn '"contextmenu"' frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/diagram/DiagramView.d.ts`. If it is absent, stop — the library must ship diagram-viewport-navigation first.

2. **Relax the two required-node signatures** in [`src/SqlAdminController.ts`](src/SqlAdminController.ts): `openDefinition(ref, node?: TreeNode)` (L471) and `openFunctionDefinition(ref, node?: TreeNode)` (L1169). In each body, change the `_openPanels.set(id, { ref, node, detail: "definition" })` to `{ ref, node: node ?? null, … }` (`OpenPanel.node` is `TreeNode | null` — [`src/SqlAdminController.ts:153`](src/SqlAdminController.ts#L153)). Typecheck: `cd frontend && npx tsc --noEmit`.

3. **Create `src/navigator/objectMenu.ts`.** Add the type-only imports, `ObjectMenuActions`, `buildObjectMenuItems`, and `showObjectMenu` per [Public API](#public-api) and [Internal Structure](#internal-structure). Move the tree handler's per-kind branches in verbatim, applying the three mechanical edits. Reference glyphs by string; import no glyph modules.

4. **Shrink `NavigatorTree`'s handler** ([`src/navigator/NavigatorTree.ts:170`](src/navigator/NavigatorTree.ts#L170)) to the `showObjectMenu(this.contextMenu, ref, this.controller, event, node)` form. Keep the module-level `Glyph.register(...)` and the `MenuItemConfig` type import (still used indirectly is fine to drop if now unused — verify). Delete the now-unused `isRelation` local helper only if nothing else references it; keep `isRelationKind` usage inside `objectMenu.ts`.

5. **Add the controller's reusable menu + convenience method.** In [`src/SqlAdminController.ts`](src/SqlAdminController.ts): import `Menu` from `@jimka/typescript-ui/overlay` (extend the existing overlay import line at L5) and `showObjectMenu` from `./navigator/objectMenu`; add `private readonly _objectMenu = Menu();` beside the other `private readonly` fields; add `private diagramContextMenu(ref: DbObjectRef, event: MouseEvent): void { showObjectMenu(this._objectMenu, ref, this, event); }`.

6. **Add `onContextMenu?` to the five panels** ([`SchemaDiagramPanel`](src/dock/SchemaDiagramPanel.ts), [`RelationDiagramPanel`](src/dock/RelationDiagramPanel.ts), [`DatabaseDiagramPanel`](src/dock/DatabaseDiagramPanel.ts), [`RelationGraphPanel`](src/dock/RelationGraphPanel.ts), [`RoleGrantsDiagramPanel`](src/dock/RoleGrantsDiagramPanel.ts)) and the `this.on("contextmenu", …)` forwarding per [Internal Structure](#internal-structure). For `RelationGraphPanel`, append `onContextMenu` after the existing `rootId` param.

7. **Pass the callback from each controller open-method:** `openSchemaDiagram` (L1479), `openRelationDiagram` (L1642), `openDatabaseDiagram` (L1565), `openSchemaDependencyGraph` (L1731), `openRelationDependencyGraph` (L1773), `openSchemaInheritanceGraph` (L1823), `openRelationInheritanceGraph` (L1866), `openRoleGrantsDiagram` (L2603). Leave `openRoleMembershipDiagram` (L2570) unchanged (no callback). Build each ref exactly as that method's activate closure builds its open target.

8. **Typecheck and build:** `cd frontend && npx tsc --noEmit && npm run build`.

9. **Add unit tests** `frontend/tests/navigator/objectMenu.test.ts` per [Expected Behaviour](#expected-behaviour), mirroring [`tests/dock/menuItems.test.ts`](frontend/tests/dock/menuItems.test.ts). Run `cd frontend && npx vitest run tests/navigator/objectMenu.test.ts`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/navigator/objectMenu.ts` |
| Create | `frontend/tests/navigator/objectMenu.test.ts` |
| Modify | `frontend/src/navigator/NavigatorTree.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/dock/SchemaDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` |
| Modify | `frontend/src/dock/RoleGrantsDiagramPanel.ts` |

---

## Expected Behaviour

### Unit-testable — `buildObjectMenuItems` structure (node vitest)

Assert the returned items' `text` / `glyph` / `separator` / `submenu` shape for each kind. A stub `ObjectMenuActions` (a `Proxy` returning no-op functions, or explicit `vi.fn()`s) suffices — structure assertions never invoke the actions. Pin these cases:

| `ref.kind` | Top-level items (in order) |
|---|---|
| `table` | `Open data`, `Open as query`, `—`, `Show` (submenu: `Dependencies`, `Inheritance`, `Relations`, `Structure`), `—`, `Rename`, `Drop`, `—`, `Export` (submenu: CSV, JSON) |
| `view` | `Show data`, `—`, `Show dependencies`, `Show definition`, `—`, `Drop`, `—`, `Export` |
| `materializedView` | `Show data`, `—`, `Show dependencies`, `Show definition`, `—`, `Refresh`, `Drop`, `—`, `Export` |
| `schema` | `Rename`, `Drop`, `—`, `Create` (submenu of 7), `Show` (submenu of 4) |
| `sequence` | `Show info`, `Drop` |
| `function`, `isProcedure:false` | `Execute`, `—`, `Show definition`, `Drop` |
| `function`, `isProcedure:true` | `Call`, `—`, `Show definition`, `Drop` |
| `type` | `Edit`, `Drop` |
| `database` (or any unhandled kind) | `[]` (empty) |

Additional unit cases:
- **Node-independence:** for a `table` ref, `buildObjectMenuItems(ref, actions)` and `buildObjectMenuItems(ref, actions, someNode)` return structurally identical items (same texts/glyphs) — the node never changes the menu shape.
- **Action dispatch (optional, spy):** invoking the `table` menu's first item's `action` calls `actions.openTable`; `Drop`'s calls `actions.dropTable`; `Export ▸ CSV` calls `actions.exportTable(ref, "csv")`.
- **`showObjectMenu` empty guard:** with a `database` ref, `showObjectMenu` does not call `menu.show` (pass a spy `Menu`); with a `table` ref it calls `menu.show(event.clientX, event.clientY, <non-empty items>)`.

### Manual-verify (UI events — not unit-testable)

- Right-click a table node in a **schema diagram** → the table menu appears at the cursor; `Open data`, `Structure`, `Rename`, `Drop`, `Export ▸ CSV` all act on the right table.
- Right-click a node in the **relation (FK) diagram**, **database diagram** (Tables mode leaf), and **dependency / inheritance graphs** → the correct object menu appears; a **view** node in a dependency graph shows the view menu (`Show data` / `Show dependencies` / `Show definition` / `Drop`).
- Right-click a **table** node in the **role-grants diagram** → the table menu appears and opens the table; right-click the **role** node → nothing.
- Right-click a role node in the **role-membership diagram** → nothing (its `RelationDiagramPanel` gets no `onContextMenu`).
- Right-click empty diagram canvas → nothing (library-guaranteed).
- Right-click an **Overview** schema node in the database diagram → nothing (only Tables-mode leaves forward).
- Double-click every diagram node → still opens as before (unchanged).
- Right-click a node in the **navigator tree** → the identical menu (regression: the extraction changed nothing user-visible).

---

## Verification

- `cd frontend && npx tsc --noEmit` — clean.
- `cd frontend && npx vitest run tests/navigator/objectMenu.test.ts` — the new unit suite passes.
- `cd frontend && npx vitest run` — full suite green (no regression in `tests/navigator/` or `tests/dock/`).
- `cd frontend && npm run build` — production build succeeds.
- `grep -n 'this.contextMenu.show' frontend/src/navigator/NavigatorTree.ts` — one call remains (inside the shrunk handler), none of the old per-branch calls.
- Manual smoke per [Manual-verify](#manual-verify-ui-events--not-unit-testable): open a schema diagram from the navigator's schema right-click "Show ▸ Schema diagram", then right-click a node.

---

## Double-click parity (confirm-only)

Interaction 1 (double-click a node opens it like the tree does) **already holds** and needs no code change — confirm only:

- The schema, relation-FK, and database diagrams contain **table nodes only** (they are built from the FK graph / table list — [`buildSchemaDiagram`](src/data/buildSchemaDiagram.ts), [`buildDatabaseDiagram`](src/data/buildDatabaseDiagram.ts)). Each panel's `"activate"` routes to `openReferencedTable({ … kind: "table" })`, which reveals the tree node then calls `openTable` — the same path the tree's double-click uses ([`src/navigator/NavigatorTree.ts:162`](src/navigator/NavigatorTree.ts#L162)).
- The **dependency / inheritance graphs** carry `RelationNodeData` with a real `kind`, and their activate uses `nd.kind`, so a view/matview node opens correctly (as a browse query, per `openTable`).
- The **relation-FK diagram** is only ever rooted at a **table** — the navigator offers "Show ▸ Relations" only for tables, not views/matviews ([`src/navigator/NavigatorTree.ts:297`](src/navigator/NavigatorTree.ts#L297)) — so its `kind: "table"` activate is never wrong.

No gap remains for the diagrams this plan touches.

---

## Potential Challenges

- **Library event missing at implement time.** The whole plan cannot typecheck without the library `"contextmenu"` event. Mitigation: Step 1 is a hard gate that greps the installed `.d.ts` before any wiring.
- **`RelationDiagramPanel` reuse for role nodes.** Wiring its context menu unconditionally would show a table menu on a role node. Mitigation: `onContextMenu` is optional and the membership caller omits it (see [architecture note](#each-panel-gets-an-optional-oncontextmenu-callback-parallel-to-its-activate-callback)).
- **Role-grants tables lack a database on the wire.** `RolePrivilege` carries no database. Mitigation: grants are within the connected database, so the controller builds the ref with the session `this._database` — the same database every navigator object lives in.
- **`Pick` drift.** If a controller method's signature changes, the `Pick` picks the new shape and the call site breaks loudly at compile time — a feature, not a risk. The two node-required methods must be relaxed (Step 2) *before* the `Pick`-typed builder can call them with an optional node.

---

## Critical Files

- [`src/navigator/NavigatorTree.ts`](src/navigator/NavigatorTree.ts) — source of the menu builder being extracted (the `contextmenu` handler, L170-346; the reusable `Menu` field, L109).
- [`src/dock/menuItems.ts`](src/dock/menuItems.ts) — the precedent: a shared, DOM-free, node-vitest-tested menu-item builder taking a narrow actions interface.
- [`src/shell/QueriesView.ts`](src/shell/QueriesView.ts) — the precedent for consuming a library `"contextmenu"` event and showing a reusable `Menu` (L307-318).
- [`src/dock/SchemaDiagramPanel.ts`](src/dock/SchemaDiagramPanel.ts) / [`RelationDiagramPanel.ts`](src/dock/RelationDiagramPanel.ts) / [`DatabaseDiagramPanel.ts`](src/dock/DatabaseDiagramPanel.ts) / [`RelationGraphPanel.ts`](src/dock/RelationGraphPanel.ts) / [`RoleGrantsDiagramPanel.ts`](src/dock/RoleGrantsDiagramPanel.ts) — the panels to wire; each shows the activate seam to mirror.
- [`src/SqlAdminController.ts`](src/SqlAdminController.ts) — the diagram open-methods (L1479, L1565, L1642, L1731, L1773, L1823, L1866, L2570, L2603) and the two node-required methods to relax (L471, L1169).
- [`src/contract.ts`](src/contract.ts) — `DbObjectRef` / `DbObjectKind` (L4-24).
- [`src/navigator/objectKinds.ts`](src/navigator/objectKinds.ts) — `isRelationKind` (L79), the DOM-free kind predicate the builder reuses.
- [`tests/dock/menuItems.test.ts`](frontend/tests/dock/menuItems.test.ts) — the test-shape precedent for the new unit suite.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — class-first / callback-field conventions the panel edits must respect.

---

## Non-Goals

- **A role-node context menu** on the role-grants or role-membership diagrams. The roles menu is name-based and lives separately in [`src/roles/RolesTree.ts:77`](src/roles/RolesTree.ts#L77); extracting it is a distinct piece of work. Role nodes stay menu-less here.
- **Empty-canvas menus** (e.g. "Create table here"). The library event fires only on nodes; there is no canvas-level menu to build.
- **New menu items unique to diagrams.** The diagram menu is identical to the tree menu, by design — no diagram-only actions are added.
- **Converting any not-yet-migrated panel to class-first**, beyond the small callback additions. The panels touched are already class-first.

---

## Notes

[^precedent]: `src/dock/menuItems.ts` was extracted (audit backlog) so its guards and branches — the real logic — can be pinned by node vitest, keeping the module DOM-free (`import type` for the library, glyphs by string name). `objectMenu.ts` is the same move applied to the object context menu. A brief alternative considered and rejected: leaving the builder inline in `NavigatorTree` and having the diagram panels each duplicate the branch logic — that is the duplication the shared helper exists to prevent, and it would drift the two menus apart on the next change.

[^actions-type]: Two alternatives were rejected. (1) Passing the whole `SqlAdminController` — works, but couples a leaf module to the entire controller surface and reads less clearly about what the menu actually needs. (2) Hand-writing a 31-method interface — duplicates every signature and rots silently when a controller method changes. `Pick<SqlAdminController, …>` names exactly the dependency surface *and* stays signature-exact for free, so a controller change surfaces at the call site as a type error rather than a runtime mismatch. The import is `import type`, erased at runtime, so no cycle forms even though the controller imports `objectMenu.ts` at runtime for `showObjectMenu`.

[^glyphs]: A diagram tab is only reachable through the app shell, which constructs `NavigatorTree` (its module-level `Glyph.register(plus, pencil, trash, arrows_rotate, play, sitemap, share_nodes, circle_nodes)` runs on import) and the controller (its own registrations) before any diagram can open. `Glyph.register` is global and idempotent, so the shared menu's glyph strings resolve without `objectMenu.ts` importing — or re-registering — any glyph. If a menu glyph ever renders blank from a new load path, register it in the controller, not in `objectMenu.ts` (which must stay DOM-free).

[^membership]: `openRoleMembershipDiagram` reuses `RelationDiagramPanel` with role nodes and an activate that calls `showRoleProperties`, not `openReferencedTable`. Making `onContextMenu` a required param would force that caller to supply a table menu for role nodes; making it optional lets the caller opt out, which is the correct behaviour (a role node shows no object menu).
