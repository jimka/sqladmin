---
touches-shared: ["frontend/src/SqlAdminController.ts"]
---

# Schema Diagram View — Implementation Plan

## Overview

Add a read-only entity-relationship diagram for a whole schema, rendered with typescript-ui's new [`DiagramView`](../../typescript-ui/docs/components/DiagramView.md) (`@jimka/typescript-ui/component/diagram`): each table is a node, each foreign key an edge, auto-laid-out by ELK. The entry point is a new **"Open schema diagram"** context-menu item on a schema node in [frontend/src/navigator/NavigatorTree.ts:103](frontend/src/navigator/NavigatorTree.ts#L103); it calls a new `SqlAdminController.openSchemaDiagram(ref, node)` that opens a deduped Dock tab, mirroring `openStructure`.

The graph data is assembled **client-side** from the existing introspection endpoints — no backend change. `openSchemaDiagram` calls `getObjects` to list the schema's tables, then `Promise.all(getStructure)` per table for foreign keys, and feeds the result through a new pure builder `buildSchemaDiagram` into a new `SchemaDiagramPanel` view. Clicking a node reuses the existing `openReferencedTable` flow, so selecting a table in the diagram reveals it in the navigator and opens its data tab — the same behaviour as clicking an FK link in [frontend/src/dock/StructurePanel.ts:199](frontend/src/dock/StructurePanel.ts#L199).

New files: `frontend/src/data/buildSchemaDiagram.ts` (+ test), `frontend/src/dock/SchemaDiagramPanel.ts`. Modified: `frontend/src/SqlAdminController.ts` (additive), `frontend/src/navigator/NavigatorTree.ts`, `frontend/package.json` (elkjs dep).

---

## Architecture Decisions

### Data sourcing — client-side assembly, no new backend endpoint

There is **no** schema-wide structure endpoint. The backend exposes only per-table `/{table}/structure` ([backend/app/main.py:233](backend/app/main.py#L233), fronted by `getStructure` in [frontend/src/data/api.ts:93](frontend/src/data/api.ts#L93)) and the per-schema object list `/{schema}/objects` (`getObjects`, [frontend/src/data/api.ts:70](frontend/src/data/api.ts#L70)). The diagram is assembled by calling `getObjects` once, then `getStructure` per table in a single `Promise.all`. This keeps the feature **frontend-only** and reuses the exact calls `openStructure` already makes. The N+1 round-trip is acceptable for typical schema sizes (tens of tables); a backend aggregate endpoint is a deliberate Non-Goal (see below), not required for this feature.

### Nodes are tables only; edges are intra-schema foreign keys

Nodes = objects with `kind === "table"` (PostgreSQL foreign keys live on tables, not views). Edges = each table's `foreignKeys`, kept **only when the referenced table (`fk.refTable`) is itself a table node in this schema** — so an edge never dangles. Self-referential FKs (`source === target`) are kept (ELK renders a self-loop). Cross-schema FK targets are dropped from the edge set (their node isn't present); this is a Non-Goal, flagged to the user via nothing special — the edge simply doesn't appear.

### Node click reuses `openReferencedTable`, not a new open path

The `DiagramView` `"selection"` event yields the selected `DiagramNodeData`. The handler reconstructs the table's `DbObjectRef` from the schema ref + node id (the table name) and calls the existing `openReferencedTable(ref)` ([frontend/src/SqlAdminController.ts:325](frontend/src/SqlAdminController.ts#L325)). That method already reveals the table in the navigator (loading lazy branches) and opens its data tab even when no `TreeNode` is loaded — exactly the missing-node case a diagram click hits. Reusing it keeps click behaviour identical to the FK-link click in the structure inspector. (Chosen over `openStructure`, which requires a non-null `TreeNode` and would open a metadata grid rather than the data the user expects from a double-click-like gesture.)

### Diagram tab is not registered in `_openPanels`

Like query panels ([frontend/src/SqlAdminController.ts:362](frontend/src/SqlAdminController.ts#L362)), the diagram tab carries no store/columns and needs no focus-sync bookkeeping. Dedup (one diagram per schema) is achieved purely by a stable panel id through `this.dock.focusPanel(id)`. Keeping it out of `_openPanels` minimises edits to the shared controller file (this plan runs alongside a separate documentation-panel plan that also edits `SqlAdminController.ts`) and avoids widening the `OpenPanel` storeless-tab semantics.

### elkjs must be a frontend dependency

`DiagramView` lazily runs `import('elkjs/lib/elk.bundled.js')` on first layout. **elkjs is NOT installed in the frontend/root `node_modules`** — it exists only inside `typescript-ui/node_modules` (that package's own dev dep), which the frontend's Vite build cannot be relied on to resolve through the `file:` symlink. Add `elkjs` to `frontend/package.json` dependencies and install it. If it is somehow absent at runtime the view degrades to empty (never throws), so a missing install shows a blank diagram rather than a crash — but the intended behaviour requires the install.

---

## Public API

### `SqlAdminController` (additive)

```typescript
/**
 * Open a read-only entity-relationship diagram for a whole schema in the Dock
 * (deduped by panel id): tables as nodes, foreign keys as edges, auto-laid-out
 * by ELK. Selecting a node opens that table's data tab via openReferencedTable.
 *
 * @param ref - The schema to diagram (kind "schema"; database + schema set).
 * @param node - The schema's navigator node (used only for the status label; the
 *   tab is not registered in _openPanels).
 */
async openSchemaDiagram(ref: DbObjectRef, node?: TreeNode): Promise<void>

/** Stable id for a schema's diagram tab, distinct from any relation tab. */
private diagramPanelId(ref: DbObjectRef): string
```

### `frontend/src/data/buildSchemaDiagram.ts` (new, pure)

```typescript
/**
 * Build the DiagramView graph for a schema from its tables and their structures.
 * Nodes are the tables; edges are each table's foreign keys whose referenced
 * table is also in the set (dangling / cross-schema FKs are dropped).
 *
 * @param tables - The schema's table names (kind "table" objects).
 * @param structures - Each table's structure, positionally paired with `tables`.
 * @returns The nodes + edges + layered/RIGHT layout options for DiagramView.
 */
export function buildSchemaDiagram(
    tables: string[],
    structures: TableStructure[],
): DiagramData
```

### `frontend/src/dock/SchemaDiagramPanel.ts` (new, view)

```typescript
/**
 * Build the read-only schema diagram panel. Wraps a DiagramView over the graph;
 * selecting a node invokes `onSelectTable` with the node's table name.
 *
 * @param data - The graph model (from buildSchemaDiagram).
 * @param onSelectTable - Invoked with the selected node's table name (its id).
 * @returns A DiagramView Component to host as the tab content.
 */
export function SchemaDiagramPanel(
    data: DiagramData,
    onSelectTable: (table: string) => void,
): Component
```

---

## Internal Structure

### `buildSchemaDiagram` — id conventions

- **Node id = table name** (unique within a schema); `label` = the same name; `glyph` = `KIND_GLYPH.table` (`"table"`).
- **Edge id = `` `${sourceTable}.${fk.name}` ``** — FK constraint names are unique per table but can repeat across tables, so prefix with the source table to guarantee global uniqueness.
- Build a `Set<string>` of table names first; include an edge only when `tableSet.has(fk.refTable)`.
- `layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" }`.

### `SchemaDiagramPanel` — factory usage

`DiagramView` is a **callable factory** (no `new`), exported from `@jimka/typescript-ui/component/diagram`. Its `"selection"` payload is a `DiagramNodeData[]` (single-select: length 0 on clear-to-empty, 1 on select). Wire selection and gate on a non-empty array:

```typescript
const view = DiagramView({ data });
view.on("selection", (nodes: DiagramNodeData[]) => {
    if (nodes.length > 0) {
        onSelectTable(nodes[0].id);
    }
});
return view;
```

### `openSchemaDiagram` — orchestration shape

```typescript
const id = this.diagramPanelId(ref);
if (this.dock.focusPanel(id)) { return; }

let tables: string[];
let structures: TableStructure[];
try {
    const objects = await getObjects(ref.connectionId, ref.database!, ref.schema!);
    tables = objects.filter(o => o.kind === "table").map(o => o.name);
    structures = await Promise.all(tables.map(name =>
        getStructure({ connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name, kind: "table" })));
} catch (err) {
    this.notifyError(err, ref);
    return;
}

const data = buildSchemaDiagram(tables, structures);
this.dock.addPanel({
    id,
    title  : `${ref.schema} (diagram)`,
    glyph  : "diagram-project",
    content: SchemaDiagramPanel(data, table => this.openReferencedTable({
        connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name: table, kind: "table",
    })),
});
this.statusBar.setMessage(`${this._connectionId} · ${ref.schema}: diagram (${tables.length} tables)`);
```

Note `ref.database!`/`ref.schema!` — a schema ref always carries both (set in `schemaNode`, [frontend/src/navigator/NavigatorTree.ts:174](frontend/src/navigator/NavigatorTree.ts#L174)).

---

## Ordered Implementation Steps

1. **Install elkjs.** In `frontend/`, add `"elkjs": "^0.9.3"` to `dependencies` in `package.json` and run `npm install` (worktree checks need the root `node_modules` symlink per the project convention). Verify: `ls node_modules/elkjs/lib/elk.bundled.js` resolves.

2. **Create `frontend/src/data/buildSchemaDiagram.ts`.** Pure function per _Public API_ + _Internal Structure_. Import `DiagramData`, `DiagramNodeData`, `DiagramEdgeData` from `@jimka/typescript-ui/component/diagram`; `TableStructure` from `../contract`; `KIND_GLYPH` from `../navigator/objectGlyphs`. No DOM. Full JSDoc, explicit return types.

3. **Create `frontend/src/data/buildSchemaDiagram.test.ts`.** Cover the cases in _Expected Behaviour_ (node mapping, intra-schema edge kept, dangling/cross-schema edge dropped, self-ref kept, empty schema, edge-id uniqueness). Mirror the style of [frontend/src/data/buildModel.test.ts](frontend/src/data/buildModel.test.ts).

4. **Create `frontend/src/dock/SchemaDiagramPanel.ts`.** Factory per _Public API_; import `DiagramView`, `DiagramNodeData`, `DiagramData` from `@jimka/typescript-ui/component/diagram`, `Component` from `@jimka/typescript-ui/core`. Wire `"selection"` per _Internal Structure_.

5. **`frontend/src/SqlAdminController.ts` — imports (additive).** Add `getObjects` to the existing `./data/api` import ([line 16](frontend/src/SqlAdminController.ts#L16)). Import `SchemaDiagramPanel` from `./dock/SchemaDiagramPanel`. Import `buildSchemaDiagram` from `./data/buildSchemaDiagram`. Import the `diagram_project` glyph: `import { diagram_project } from "@jimka/typescript-ui/glyphs/solid/diagram_project";` and add it to the `Glyph.register(...)` call at [line 40](frontend/src/SqlAdminController.ts#L40) — its registered name is `"diagram-project"`.

6. **`SqlAdminController` — methods (additive).** Add `openSchemaDiagram` (place it after `openStructure`, ~line 313) and the private `diagramPanelId` (place it beside `structurePanelId`, ~line 906): `` return `${ref.connectionId}/${ref.database}/${ref.schema}::diagram`; ``. Do not touch existing methods.

7. **`frontend/src/navigator/NavigatorTree.ts` — schema context menu.** The current `"contextmenu"` handler returns early for non-relations ([line 106](frontend/src/navigator/NavigatorTree.ts#L106)). Before that guard, add a branch: when `ref` is present and `ref.kind === "schema"`, show a one-item menu `{ text: "Open schema diagram", glyph: "diagram-project", action: () => void controller.openSchemaDiagram(ref, node) }` via `contextMenu.show(event.clientX, event.clientY, items)` and `return`. Keep the relation branch unchanged.

8. **Typecheck + test.** `cd frontend && npm run typecheck && npm test` — expect green, including the new builder test.

9. **Regression grep.** `grep -rn "openSchemaDiagram\|buildSchemaDiagram\|SchemaDiagramPanel\|diagramPanelId" frontend/src` — expect matches only in the four touched/new files (controller, navigator, builder, panel) and the builder test.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `frontend/src/data/buildSchemaDiagram.ts` |
| Create | `frontend/src/data/buildSchemaDiagram.test.ts` |
| Create | `frontend/src/dock/SchemaDiagramPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (additive: imports, `openSchemaDiagram`, `diagramPanelId`, glyph register) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (schema-node context menu) |
| Modify | `frontend/package.json` (add `elkjs` dependency) |

---

## Expected Behaviour

`buildSchemaDiagram` (unit-testable):

- **Node per table.** `buildSchemaDiagram(["a","b"], [sA, sB])` yields two nodes with `id`/`label` `"a"` and `"b"`, each `glyph: "table"`.
- **Intra-schema edge kept.** A table `a` with an FK `fk_ab` referencing `refTable: "b"` (b in the set) yields one edge `{ id: "a.fk_ab", source: "a", target: "b" }`.
- **Dangling / cross-schema edge dropped.** An FK on `a` referencing `refTable: "z"` (not in the table set) produces no edge.
- **Self-referential FK kept.** An FK on `a` referencing `refTable: "a"` yields edge `{ source: "a", target: "a" }`.
- **Empty schema.** `buildSchemaDiagram([], [])` → `{ nodes: [], edges: [], layoutOptions: {...} }`.
- **Edge-id uniqueness.** Two different tables each with an FK named `fk_x` yield edge ids `"a.fk_x"` and `"b.fk_x"` (no collision).
- **Layout options.** `layoutOptions` always `{ "elk.algorithm": "layered", "elk.direction": "RIGHT" }`.

Controller / UI (manual verification — DOM, ELK layout, Dock, navigator geometry the node test harness can't exercise):

- Right-clicking a **schema** node shows a single "Open schema diagram" item; right-clicking a relation still shows the unchanged relation menu; right-clicking a database/category shows nothing.
- Selecting the item opens a Dock tab titled `<schema> (diagram)` with the `diagram-project` glyph, showing table nodes connected by FK arrows, laid out left-to-right by ELK.
- Re-invoking on the same schema focuses the existing tab (dedup), does not open a second.
- Clicking a table node reveals that table in the navigator and opens (or focuses) its data tab.
- A schema whose objects fail to load surfaces the error on the status bar and opens no tab.
- With `elkjs` installed the diagram lays out; a schema with tables but zero FKs shows unconnected nodes.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — green, including `buildSchemaDiagram.test.ts` covering the seven builder cases above.
- `grep -rn "diagram-project\|openSchemaDiagram" frontend/src` — appears in controller, navigator, and (glyph) only where added.
- Build: `cd frontend && npm run build` — succeeds (confirms `elkjs` resolves for the lazy import in the bundle).
- Manual smoke: `npm run dev`, expand a database to a schema, right-click the schema → "Open schema diagram"; confirm nodes/edges render, node click opens the table, re-open focuses the same tab.

---

## Potential Challenges

- **elkjs resolution through the `file:` symlink.** If the Vite build cannot resolve `elkjs/lib/elk.bundled.js` after adding it to `frontend/package.json`, confirm the install landed in the frontend/root `node_modules` (not only `typescript-ui/node_modules`); the diagram stays blank if unresolved. Mitigation: step 1's `ls` check + step 8's `npm run build`.
- **N+1 structure fetches.** A very large schema issues one `getStructure` per table. Mitigation: `Promise.all` fires them concurrently; acceptable for typical sizes — a backend aggregate endpoint is the escalation path (Non-Goal).
- **DiagramView needs a sized host.** The Dock tab body sizes its content region (as it does for the data grid and `StructurePanel`), so the `DiagramView` fills it without extra sizing — do not wrap it in an unsized container.
- **`getObjects` argument shape.** It takes `(connectionId, database, schema)` positional strings, not a `DbObjectRef` — pass `ref.database!`/`ref.schema!`.

---

## Critical Files

- [frontend/src/SqlAdminController.ts](frontend/src/SqlAdminController.ts) — `openStructure` (the pattern to mirror), `openReferencedTable` (node-click target), `panelId`/`structurePanelId`, the `Glyph.register` call. **Shared with the documentation-panel plan — keep edits additive and localized.**
- [frontend/src/dock/StructurePanel.ts](frontend/src/dock/StructurePanel.ts) — the storeless read-only panel + FK-link precedent.
- [frontend/src/navigator/NavigatorTree.ts](frontend/src/navigator/NavigatorTree.ts) — the `"contextmenu"` handler to extend for schema nodes.
- [frontend/src/data/api.ts](frontend/src/data/api.ts) — `getObjects`, `getStructure` signatures.
- [frontend/src/data/buildModel.ts](frontend/src/data/buildModel.ts) + [frontend/src/data/buildModel.test.ts](frontend/src/data/buildModel.test.ts) — the pure-builder + test style to mirror.
- [typescript-ui/docs/components/DiagramView.md](../../typescript-ui/docs/components/DiagramView.md) and `typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts` — the `DiagramData`/`DiagramNodeData`/`DiagramEdgeData` model and `DiagramView` factory/events.

---

## Non-Goals

- **A backend schema-wide diagram/structure endpoint.** Deferred; the client assembles the graph from existing per-table calls. Revisit only if N+1 latency becomes a problem on large schemas.
- **Cross-schema foreign-key edges.** FKs referencing tables in other schemas are dropped from the edge set (their node isn't rendered). A cross-schema/full-database diagram is out of scope.
- **View / materialized-view nodes.** Only tables are diagrammed (FKs are table-only).
- **Editing** — no node dragging, edge drawing, or DDL. `DiagramView` is read-only by design.
- **Persisting layout / zoom** across sessions.
</content>
</invoke>
