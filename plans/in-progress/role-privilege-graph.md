---
depends-on: []
touches-shared: []
---

# Role / Privilege Graph — Implementation Plan

## Overview

Add two read-only role-visualisation diagrams to the **Roles** subsystem, each opened as its own Dock tab from the roles rail's right-click menu, both reusing the existing `DiagramView` stack:

1. **Role membership graph** — nodes are roles; a directed edge `role -> parent` means "this role is a member of `parent`" (the DAG of `RoleDetail.memberOf`). Rooted at the right-clicked role and driven by the *existing* [`RelationDiagramPanel`](frontend/src/dock/RelationDiagramPanel.ts) (direction / depth / legend) with **no new panel component**.
2. **Role → grants graph** — a per-role star: the role node at the centre, one node per distinct `schema.table` it holds a privilege on, one edge per table (its privilege list as the edge label). Double-clicking a table node opens that table's data tab via `openReferencedTable`. Needs a small new panel component.

The graph BUILDERS are two pure, node-vitest-testable modules under [`frontend/src/data/`](frontend/src/data), mirroring [`buildSchemaDiagram.ts`](frontend/src/data/buildSchemaDiagram.ts) — type-only imports from the diagram barrel, no UI-bundle runtime imports. All data is already on the wire: [`RoleDetail.memberOf`](frontend/src/contract.ts#L118) and [`RoleDetail.privileges`](frontend/src/contract.ts#L118), fetched by [`getRoleDetail`](frontend/src/data/api.ts#L154) / [`getRoles`](frontend/src/data/api.ts#L149). **No new backend endpoint.** The membership graph needs every role's `memberOf`, so it pays N per-role detail fetches (`Promise.all` over the role list) — the same fan-out shape [`buildSchemaGraphData`](frontend/src/SqlAdminController.ts#L377) uses for per-table structures.

---

## Architecture Decisions

### Two entry points, not one tab with a toggle

Two separate context-menu items on the roles rail — **"Show membership graph"** and **"Show grants graph"** — each opening its own deduped Dock tab. This mirrors the navigator's `"Open schema diagram"` / `"Show relations"` pair ([NavigatorTree.ts:110,129](frontend/src/navigator/NavigatorTree.ts#L110)) and keeps each tab a single-purpose view. A single toggling tab would fold two different panel shapes (rooted-traversal vs. star) behind one control for no gain.

### Membership graph reuses `RelationDiagramPanel` verbatim — no new panel

`RelationDiagramPanel(full, root, onSelect)` is generic over any `DiagramData`: it roots at `root`, offers direction/depth/legend via the pure [`relationDiagram.ts`](frontend/src/data/relationDiagram.ts) ops, emphasises the root, and calls `onSelect(node.id)` on double-click. The membership graph is just another directed graph, so it drops straight in. `root.id` = the role name; the activation callback is wired to `controller.showRoleProperties(name)` (show the role's base info in the inspector) instead of opening a table. The panel's "Direction / Depth / Hide with prune" labels are FK-neutral and read fine for membership (`Downstream` = roles this one is a member of; `Upstream` = its members).

### Grants graph is a per-role star — new `RoleGrantsDiagramPanel`, no legend/depth

Scoping is **per-role** (rooted at the selected role), the answer to the "all-roles-all-tables hairball" concern. Within one role the graph is a depth-1 star (role → each table), so the direction/depth/legend machinery is meaningless; the panel wraps a plain `DiagramView` like [`SchemaDiagramPanel`](frontend/src/dock/SchemaDiagramPanel.ts). Node **kinds differ** (role vs. table) and activation differs per kind, so it cannot reuse `SchemaDiagramPanel` (which treats every node as a table): the new panel reads `node.data` to distinguish kinds and route a table double-click to `openReferencedTable`.

### Node kind is carried on `node.data`, not parsed from the id

`DiagramNodeData.data` is an opaque passthrough ([DiagramModel.ts:58](../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts#L58)). The grants builder stamps each node with `{ kind: "role" }` or `{ kind: "table", schema, table }`. The panel's `"activate"` handler reads `node.data`; on a table node it calls `onOpenTable(schema, table)`. This avoids brittle `schema.table` string-splitting (schema/table names can contain dots) and gives the activation callback the exact `schema` + `name` — grants can span multiple schemas, so the schema is not fixed like it is in `SchemaDiagramPanel`.

### Grants-node navigation reveals by (schema, name), adopting the navigator node's database

`RolePrivilege` carries **no database** and the roles subsystem tracks none: the backend's role endpoint is `/api/{conn}/roles/{role}` (no `{database}` segment), and grants come from `information_schema.role_table_grants` — implicitly the connection's default database ([backend/app/operations/role_detail.py:116-119](backend/app/operations/role_detail.py#L116)). So `openReferencedTable`'s existing predicate (which matches `database === ref.database`, [SqlAdminController.ts:451](frontend/src/SqlAdminController.ts#L451)) cannot be used directly — there is no `ref.database` to supply. Instead, grants-node activation calls a controller path that reveals the table in the navigator by **schema + name only** (database-agnostic), then opens the *revealed* node — which carries the real `DbObjectRef` (database included) on its `data`. Implement this as a new small controller method `openGrantedTable(schema, table)` rather than overloading `openReferencedTable`: `revealByPredicate(r => r.schema === schema && r.name === table)`, then `openTable(revealedNode.data, revealedNode)` + `selectNode`. Best-effort like `openReferencedTable`: if the navigator has no matching node (the table lives in a database the user has not browsed, or the tree is not loaded), status-bar a "not found in navigator" message and open nothing. If two databases share the same `schema.table`, the first revealed match wins — acceptable for a best-effort read-only jump.

### Builders stay pure and DOM-free — glyph names are inline literals

Both builders live in `frontend/src/data/` and must run under the DOM-less vitest `node` env ([frontend/vitest.config.ts:9](frontend/vitest.config.ts#L9)). They import **types only** from `@jimka/typescript-ui/component/diagram` and never import `../navigator/objectGlyphs` (which pulls the display bundle's module-level DOM side effects) — exactly the constraint [`buildSchemaDiagram.ts:14-21`](frontend/src/data/buildSchemaDiagram.ts#L14) documents. Glyph names are inline literals: `ROLE_GLYPH = "user"` and `TABLE_GLYPH = "table"`, each with a "keep in sync" comment pointing at its registration site.

### Admin-option / privilege-list edge labels are a soft dependency on the fk-diagram plan

`DiagramEdgeData.label` exists in the model but `DiagramEdgeLayer` **does not render it today** (verified: no label/`<text>` handling in `DiagramEdgeLayer.ts`). Edge-label/style rendering is owned by the sibling **fk-diagram-cardinality-and-index-coverage** plan (its `DiagramEdgeStyle.label`). Therefore: the builders **always** carry the annotation on `edge.data` (`{ admin }` for membership; `{ privileges }` for grants) — this is the unit-testable part — **and** set `edge.label` to the display string (`"admin"`; the joined privilege list) so it renders for free once label support lands. Until then edges render plain. Do **not** import `DiagramEdgeStyle` (avoids a hard dependency on the sibling plan's library change).

### No new backend endpoint; membership pays N detail fetches

`getRoles` returns `RoleSummary[]` only (no `memberOf`); `getRoleDetail` carries `memberOf` + `privileges` per role. The grants graph needs one role's detail (already fetched on selection). The membership graph needs **every** role's `memberOf`, so `openRoleMembershipDiagram` does `Promise.all(roles.map(r => getRoleDetail(conn, r.name)))` — N requests, mirroring `buildSchemaGraphData`'s per-table `Promise.all`. This is acceptable for the small role list; an aggregate `roles?detail=1` endpoint is a possible future optimisation but is **not** required and is out of scope.

---

## Public API

### `frontend/src/data/buildRoleMembershipDiagram.ts` (new, pure)

```ts
/** Opaque metadata carried on a membership edge (admin_option on the grant). */
export interface MembershipEdgeData {
    admin: boolean;
}

/**
 * Build the whole role-membership DAG for DiagramView: one node per role, one
 * edge `role -> parent` per membership whose parent is also a known role.
 *
 * @param details - Every role's detail (its memberOf drives the edges).
 * @returns Nodes + edges + layered layout options.
 */
export function buildRoleMembershipDiagram(details: RoleDetail[]): DiagramData;
```

### `frontend/src/data/buildRoleGrantsDiagram.ts` (new, pure)

```ts
/** Node metadata distinguishing the role node from a granted-table node. */
export type GrantNodeData =
    | { kind: "role" }
    | { kind: "table"; schema: string; table: string };

/** Opaque metadata carried on a grant edge: the table's privilege list. */
export interface GrantEdgeData {
    privileges: string[]; // distinct privileges held on this table, sorted
}

/**
 * Build the per-role grants star: the role node plus one node per distinct
 * schema.table it holds a privilege on, one edge role -> table labelled with
 * that table's privilege list.
 *
 * @param role - The role name (the centre node).
 * @param privileges - The role's full grant list (RoleDetail.privileges).
 * @returns Nodes (role + tables) + edges (one per table).
 */
export function buildRoleGrantsDiagram(role: string, privileges: RolePrivilege[]): DiagramData;
```

### `frontend/src/dock/RoleGrantsDiagramPanel.ts` (new)

```ts
/**
 * Read-only per-role grants diagram. Wraps a DiagramView; double-clicking a
 * table node invokes onOpenTable with its schema + table.
 *
 * @param data - The graph (from buildRoleGrantsDiagram).
 * @param onOpenTable - Invoked with a table node's schema and table on activate.
 * @returns A Component to host as the tab content.
 */
export function RoleGrantsDiagramPanel(
    data: DiagramData,
    onOpenTable: (schema: string, table: string) => void,
): Component;
```

### `frontend/src/SqlAdminController.ts` (new public methods)

```ts
/** Open (or focus) the role-membership graph rooted at `name`. */
async openRoleMembershipDiagram(name: string): Promise<void>;

/** Open (or focus) the per-role grants graph for `name`. */
async openRoleGrantsDiagram(name: string): Promise<void>;

/** Reveal a granted table in the navigator by schema+name and open it (best-effort). */
openGrantedTable(schema: string, table: string): void;
```

---

## Internal Structure

### `buildRoleMembershipDiagram`

- `nodes = details.map(d => ({ id: d.role.name, label: d.role.name, glyph: ROLE_GLYPH }))`.
- `nodeIds = new Set(details.map(d => d.role.name))`.
- For each `d`, for each `m of d.memberOf`: skip if `!nodeIds.has(m.roleName)` (defensive, mirrors the dangling-FK drop in `buildSchemaDiagram`). Else push edge `{ id: \`${d.role.name}->${m.roleName}\`, source: d.role.name, target: m.roleName, label: m.admin ? "admin" : undefined, data: { admin: m.admin } satisfies MembershipEdgeData }`.
- `layoutOptions`: reuse `{ "elk.algorithm": "layered", "elk.direction": "RIGHT" }` (a membership DAG reads as a left-to-right hierarchy, like the schema FK graph). Edge id convention `A->B` is globally unique because a `(role, parent)` pair is unique.

### `buildRoleGrantsDiagram`

- Role node: `{ id: \`role:${role}\`, label: role, glyph: ROLE_GLYPH, data: { kind: "role" } }`.
- Group `privileges` by `\`${p.schema}.${p.table}\``. For each distinct group:
  - Table node: `{ id: \`table:${schema}.${table}\`, label: \`${schema}.${table}\`, glyph: TABLE_GLYPH, data: { kind: "table", schema, table } }`.
  - Edge: `{ id: \`grant:${schema}.${table}\`, source: \`role:${role}\`, target: \`table:${schema}.${table}\`, label: privs.join(", "), data: { privileges: privs } }` where `privs` = the group's distinct privilege strings, sorted.
- Id prefixes (`role:` / `table:`) keep the role node's id from ever colliding with a table node's id.
- `layoutOptions`: `{ "elk.algorithm": "layered", "elk.direction": "RIGHT" }`.

### `RoleGrantsDiagramPanel`

Mirror `SchemaDiagramPanel` but branch on `node.data`:

```ts
Glyph.register(user, table); // role + table node glyphs (this module owns them for this panel)
const view = DiagramView({ data });
view.on("activate", (node: DiagramNodeData) => {
    const meta = node.data as GrantNodeData | undefined;
    if (meta?.kind === "table") { onOpenTable(meta.schema, meta.table); }
});
return view;
```

### Controller methods

```ts
async openRoleMembershipDiagram(name: string): Promise<void> {
    const id = this.roleMembershipDiagramPanelId(name);
    if (this.dock.focusPanel(id)) return;
    let details: RoleDetail[];
    try {
        const roles = await this.loadRoles();
        details = await Promise.all(roles.map(r => getRoleDetail(this._connectionId, r.name)));
    } catch (err) { this.notifyError(err); return; }
    const full = buildRoleMembershipDiagram(details);
    const root: DiagramNodeData = { id: name, label: name, glyph: KIND_ROLE_GLYPH }; // "user"
    this.dock.addPanel({
        id, title: `${name} (membership)`, glyph: "diagram-project",
        content: RelationDiagramPanel(full, root, roleName => void this.showRoleProperties(roleName)),
    });
    this.statusBar.setMessage(`${this._connectionId} · ${name}: membership (${full.nodes.length} roles)`);
}

async openRoleGrantsDiagram(name: string): Promise<void> {
    const id = this.roleGrantsDiagramPanelId(name);
    if (this.dock.focusPanel(id)) return;
    const detail = await this.fetchRoleDetail(name);
    if (!detail) return;
    const data = buildRoleGrantsDiagram(name, detail.privileges);
    this.dock.addPanel({
        id, title: `${name} (grants graph)`, glyph: "diagram-project",
        content: RoleGrantsDiagramPanel(data, (schema, table) => this.openGrantedTable(schema, table)),
    });
    this.statusBar.setMessage(`${this._connectionId} · ${name}: grants graph (${data.nodes.length - 1} tables)`);
}

/** Reveal a granted table in the navigator by schema+name and open it (best-effort). */
openGrantedTable(schema: string, table: string): void {
    void (async () => {
        const node = (await this._navigator?.revealByPredicate((data: unknown) => {
            const r = data as DbObjectRef | undefined;
            return !!r && r.schema === schema && r.name === table;
        })) ?? undefined;
        if (!node) { this.statusBar.setMessage(`${this._connectionId} · ${schema}.${table}: not found in navigator`); return; }
        await this.openTable(node.data as DbObjectRef, node); // node.data carries the real database
        this._navigator?.selectNode(node);
    })();
}
```

`showRoleProperties` and `fetchRoleDetail` already exist ([:917](frontend/src/SqlAdminController.ts#L917), [:931](frontend/src/SqlAdminController.ts#L931)); `openTable` / `revealByPredicate` / `selectNode` are the same seams `openReferencedTable` uses ([:446-459](frontend/src/SqlAdminController.ts#L446)). Confirm the shape passed to `openTable` (it takes `(ref, node)`) and that a revealed navigator node's `data` is a `DbObjectRef` with `database` set — read `openReferencedTable` and `databaseNode`/object-leaf `data` in [NavigatorTree.ts](frontend/src/navigator/NavigatorTree.ts#L172) before writing.

---

## Ordered Implementation Steps

1. **`frontend/src/data/buildRoleMembershipDiagram.ts`** — new pure builder per _Internal Structure_. Inline `ROLE_GLYPH = "user"` with a keep-in-sync comment referencing `RolesTree.ts`'s `Glyph.register(user)`. Type-only diagram import.
2. **`frontend/src/data/buildRoleMembershipDiagram.test.ts`** — node-vitest, following the [`relationDiagram.test.ts`](frontend/src/data/relationDiagram.test.ts) / [`roleBaseInfoRows.test.ts`](frontend/src/roles/roleBaseInfoRows.test.ts) patterns (local `detail()` factory). Cover the _Expected Behaviour · membership builder_ cases.
3. **`frontend/src/data/buildRoleGrantsDiagram.ts`** — new pure builder per _Internal Structure_. Inline `ROLE_GLYPH = "user"`, `TABLE_GLYPH = "table"` (keep-in-sync comments → `RolesTree.ts` and `objectGlyphs.ts`). Type-only diagram import.
4. **`frontend/src/data/buildRoleGrantsDiagram.test.ts`** — node-vitest. Cover the _Expected Behaviour · grants builder_ cases.
5. **`frontend/src/dock/RoleGrantsDiagramPanel.ts`** — new panel per _Public API_ / _Internal Structure_. Import + `Glyph.register(user, table)` (mirror [`RolesTree.ts:11-17`](frontend/src/roles/RolesTree.ts#L11) and [`objectGlyphs.ts:5-13`](frontend/src/navigator/objectGlyphs.ts#L5)).
6. **`frontend/src/SqlAdminController.ts`** — add `openRoleMembershipDiagram`, `openRoleGrantsDiagram`, `openGrantedTable`, and two private panel-id helpers next to the existing ones ([:1034-1047](frontend/src/SqlAdminController.ts#L1034)):
   - `roleMembershipDiagramPanelId(role) => \`roles/${this._connectionId}/${role}::membership\``
   - `roleGrantsDiagramPanelId(role) => \`roles/${this._connectionId}/${role}::grants-diagram\`` (distinct from `openRoleGrants`'s `grants/${conn}/${role}` id at [:954](frontend/src/SqlAdminController.ts#L954)).
   Add imports for `buildRoleMembershipDiagram`, `buildRoleGrantsDiagram`, `RoleGrantsDiagramPanel`. Add `user` to the `Glyph.register(...)` line at [:45](frontend/src/SqlAdminController.ts#L45) so the membership root glyph is guaranteed registered (define `KIND_ROLE_GLYPH = "user"` or reuse the literal). `RelationDiagramPanel` and `getRoleDetail` are already imported.
7. **`frontend/src/roles/RolesTree.ts`** — add two items to the context menu ([:59-68](frontend/src/roles/RolesTree.ts#L59)), after `"Show data"` and before the export separator:
   - `{ text: "Show membership graph", glyph: "diagram-project", action: () => void controller.openRoleMembershipDiagram(name) }`
   - `{ text: "Show grants graph", glyph: "diagram-project", action: () => void controller.openRoleGrantsDiagram(name) }`
   `diagram-project` is already registered by the controller; confirm the glyph shows (it is used by the navigator's diagram items).
8. **Checkpoint** — `cd frontend && npm run typecheck && npx vitest run src/data/buildRoleMembershipDiagram.test.ts src/data/buildRoleGrantsDiagram.test.ts`.
9. **Checkpoint** — `grep -rn "openRoleMembershipDiagram\|openRoleGrantsDiagram\|RoleGrantsDiagramPanel\|buildRoleMembershipDiagram\|buildRoleGrantsDiagram" frontend/src` — expect the definition + wiring sites only, no stragglers.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/data/buildRoleMembershipDiagram.ts` |
| Create | `frontend/src/data/buildRoleMembershipDiagram.test.ts` |
| Create | `frontend/src/data/buildRoleGrantsDiagram.ts` |
| Create | `frontend/src/data/buildRoleGrantsDiagram.test.ts` |
| Create | `frontend/src/dock/RoleGrantsDiagramPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (two open methods, two id helpers, imports, `user` glyph) |
| Modify | `frontend/src/roles/RolesTree.ts` (two context-menu items) |

---

## Expected Behaviour

### Unit-testable — membership builder (`buildRoleMembershipDiagram.test.ts`, node vitest)

- **One node per role.** N details → N nodes, each `{ id, label } === role.name` and `glyph === "user"`.
- **Edge per membership, role → parent.** `detail(a, memberOf:[b])` → edge `{ source: "a", target: "b", id: "a->b" }`.
- **Admin flag on edge data + label.** `memberOf:[{roleName:"b", admin:true}]` → edge `data.admin === true` and `label === "admin"`; `admin:false` → `data.admin === false` and `label === undefined`.
- **Dangling parent dropped.** A `memberOf` naming a role not in `details` produces no edge (mirrors dangling-FK drop).
- **Empty input.** `[]` → `{ nodes: [], edges: [] }` with the layered layout options present.
- **Layout options passthrough.** `layoutOptions["elk.direction"] === "RIGHT"`.

### Unit-testable — grants builder (`buildRoleGrantsDiagram.test.ts`, node vitest)

- **Role centre node.** Always exactly one node with `data.kind === "role"`, `id === "role:<role>"`, `glyph === "user"`.
- **One table node per distinct schema.table.** Two privileges on `public.t` → a single `public.t` node (`data.kind === "table"`, `schema`/`table` set, `glyph === "table"`) and a single edge.
- **Edge label is the sorted distinct privilege list.** Grants `SELECT` + `INSERT` on `public.t` → edge `label === "INSERT, SELECT"` and `data.privileges === ["INSERT","SELECT"]`.
- **Multi-schema.** `public.t` and `sales.t` produce two distinct table nodes (ids differ by prefix), proving schema is not collapsed.
- **No grants.** `[]` → just the role node, no edges.
- **Ids never collide.** A role literally named `t` and a table `public.t` yield ids `role:t` vs `table:public.t`.

### Manual-verify (DiagramView + roles UI — not automatable)

- Right-click a role in the Roles rail → menu shows **Show membership graph** and **Show grants graph** with the diagram glyph.
- **Show membership graph** opens a tab titled `<role> (membership)`; the clicked role is the emphasised root; direction/depth/legend controls work; nodes render the user glyph; double-clicking another role node updates the inspector (no table tab opens). Re-invoking on the same role focuses the existing tab (dedup).
- **Show grants graph** opens a tab titled `<role> (grants graph)`: the role node centred, one table node per granted table; double-clicking a table node reveals it in the navigator by schema+name and opens its data tab (via `openGrantedTable`). A grant whose table is not in the loaded navigator status-bars "not found in navigator" and opens nothing. Status bar shows the table count. Dedup on re-invoke.
- A role with no memberships / no grants renders just its single node without error.
- Edges render plain today (no visible label); the admin/privilege label appears only after the fk-diagram plan adds edge-label rendering.

---

## Verification

- **Typecheck:** `cd frontend && npm run typecheck`.
- **Unit tests:** `npx vitest run src/data/buildRoleMembershipDiagram.test.ts src/data/buildRoleGrantsDiagram.test.ts` — green, covering every _Unit-testable_ case above.
- **Full suite:** `npx vitest run` — no regressions.
- **Build:** `npm run build` (prod build must still emit real class names — the `esbuild.keepNames` guard in [`frontend/vite.config.ts`](frontend/vite.config.ts) is already in place).
- **Grep invariants:** step 9's grep; and `grep -rn 'objectGlyphs' frontend/src/data/build*.ts` — expect **zero** (builders must not import the UI-bundle glyph module).
- **Manual smoke:** run the app (`npm run dev`), open the **Roles** rail (Alt+O), right-click a role, exercise both new items per _Manual-verify_. Pick a superuser to sanity-check the grants graph's node count.

---

## Potential Challenges

- **Superuser grants hairball.** A superuser can hold ~1477 grants across hundreds of tables ([LIBRARY_NOTES.md](LIBRARY_NOTES.md) "Large MemoryStore" entry). Per-role scoping is the primary mitigation; collapsing to one edge per table (not per privilege) cuts edge count further. If a specific role still renders unusably dense, a defensive `MAX_GRANT_TABLE_NODES` cap in the panel (render the first N, status-bar the truncation) is the follow-up — left out of the first cut to keep the builder deterministic and pure.
- **Membership N-fetch latency.** `Promise.all` over the role list is N round-trips; acceptable for a small role list. If it ever drags, an aggregate detail endpoint is the fix (out of scope here).
- **Grants carry no database.** `RolePrivilege` has only `schema`/`table`, and the roles endpoint is not database-scoped, so a grants table node cannot form a full `DbObjectRef`. Mitigated by `openGrantedTable` revealing by `(schema, name)` and adopting the navigator node's database (see _Internal Structure_); it is best-effort and no-ops with a status message when the table is not in the loaded navigator. A same-named table in two browsed databases resolves to the first match.
- **Root glyph registration.** The membership root node carries `glyph: "user"`; ensure `user` is registered (add it to the controller's `Glyph.register` line rather than relying on `RolesTree`'s import side effect).

---

## Critical Files

- [`frontend/src/data/buildSchemaDiagram.ts`](frontend/src/data/buildSchemaDiagram.ts) — the pure-builder template (purity discipline, inline glyph literal, edge-id uniqueness).
- [`frontend/src/data/relationDiagram.ts`](frontend/src/data/relationDiagram.ts) — the rooted-traversal ops `RelationDiagramPanel` consumes (reused unchanged for membership).
- [`frontend/src/dock/RelationDiagramPanel.ts`](frontend/src/dock/RelationDiagramPanel.ts) — reused verbatim for the membership graph; read its `onSelectTable` / root-glyph contract.
- [`frontend/src/dock/SchemaDiagramPanel.ts`](frontend/src/dock/SchemaDiagramPanel.ts) — the minimal `DiagramView` wrapper the grants panel mirrors.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — `openSchemaDiagram`/`openRelationDiagram` ([:339](frontend/src/SqlAdminController.ts#L339)/[:405](frontend/src/SqlAdminController.ts#L405)), `openReferencedTable` ([:446](frontend/src/SqlAdminController.ts#L446)), `showRoleProperties`/`fetchRoleDetail` ([:917](frontend/src/SqlAdminController.ts#L917)), panel-id helpers ([:1034](frontend/src/SqlAdminController.ts#L1034)), `Glyph.register` ([:45](frontend/src/SqlAdminController.ts#L45)).
- [`frontend/src/roles/RolesTree.ts`](frontend/src/roles/RolesTree.ts) — the context menu to extend; the `user` glyph registration.
- [`frontend/src/contract.ts`](frontend/src/contract.ts#L91) — `RoleSummary` / `RoleMembership` / `RolePrivilege` / `RoleDetail`.
- [`../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts`](../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts) — `DiagramNodeData.data` / `DiagramEdgeData.label`+`data` (the passthrough seams).
- `plans/fk-diagram-cardinality-and-index-coverage.md` — owns edge-label/`DiagramEdgeStyle` rendering (the soft dep for showing admin / privilege labels).

---

## Non-Goals

- **Editing** memberships or grants — read-only visualisation only.
- **Crow's-foot cardinality / edge markers** — owned by the fk-diagram plan; this plan carries labels on `edge.data`/`edge.label` and renders plain until that lands.
- **A defensive grants node cap** — deferred; per-role scoping is the first-cut mitigation (see _Potential Challenges_).
- **An aggregate roles-with-memberOf endpoint** — the per-role `Promise.all` fan-out is sufficient; no backend change.
- **Rooted/depth/legend controls on the grants graph** — it is a depth-1 star; those controls only apply to the membership graph (via the reused `RelationDiagramPanel`).
- **Column-level / port anchoring, view & inheritance graphs, database-level cross-schema diagrams, the diagram UI/UX redesign** — out of scope.
