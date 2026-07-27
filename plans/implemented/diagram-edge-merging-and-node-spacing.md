---
touches-shared:
  - frontend/src/SqlAdminController.ts
  - ../typescript-ui/packages/lib/docs/components/DiagramView.md
---

# Diagram Edge Merging & Node Spacing — Implementation Plan

## Overview

Two items from the deferred diagram UI/UX wishlist turn out to be ELK layout **configuration**, not new code.

The governing rule, confirmed with the user, decides every per-diagram choice below: **merge where the diagram has no column model; keep edges separate where it has one.** A table-to-table diagram keys its edges on the node pair and shows no columns, so merging at the node is both the only merge available and the one asked for. The column-level card mode does show columns, so its edges stay separate per column — while two foreign keys targeting the *same* column already converge on that column's shared port, which is exactly the merging the wishlist asked for and needs no code.

**(A) Converging edges should join before their destination.** Switching on `elk.layered.mergeEdges` makes ELK give a node one shared input port and one shared output port instead of one port per edge, so several edges arriving at the same node merge into a single trunk before touching it.[^merge-semantics] The option joins the per-diagram layout-option constants the app already owns — [buildDatabaseDiagram.ts:17](frontend/src/data/buildDatabaseDiagram.ts#L17), [buildRoleGrantsDiagram.ts:11](frontend/src/data/buildRoleGrantsDiagram.ts#L11), [buildRoleMembershipDiagram.ts:10](frontend/src/data/buildRoleMembershipDiagram.ts#L10), and [SqlAdminController.ts:173-176](frontend/src/SqlAdminController.ts#L173)'s `DEPENDENCY_LAYOUT` / `INHERITANCE_LAYOUT` — and gets a second constant in [buildSchemaDiagram.ts:19](frontend/src/data/buildSchemaDiagram.ts#L19), which serves two modes from one map today. Two diagrams are deliberately left unmerged: the column-level card mode of `buildSchemaDiagram`, and the Explain plan tree.

**(B) A minimum gap between edges at a node, growing the node if needed.** ELK can do this natively (per-node `elk.portConstraints` + `elk.nodeSize.constraints` + `elk.spacing.portPort` + `elk.nodeSize.minimum`), and the library already writes ELK's returned size back onto each node component ([DiagramView.ts:471](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L471)). **No diagram enables it.** On the merged graphs the options are inert, and the two unmerged diagrams render through fixed-width card renderers where extra ELK-granted room would be dead space.[^growth-nowhere] What this plan ships for (B) is the recorded decision plus one documentation line in the library, so the requirement is written down where the next reader will look.

The library change is Markdown only — a bullet added to [packages/lib/docs/components/DiagramView.md](../typescript-ui/packages/lib/docs/components/DiagramView.md)'s `## Notes` section stating that node growth needs `elk.nodeSize.constraints` because `DiagramView` always feeds ELK an explicit size. No library source is touched, so no `npm run build:lib` is required.[^no-rebuild]

This plan introduces **no new numeric constants**. `elk.layered.mergeEdges` is a boolean flag; every spacing value stays at ELK's default, per the project's preference for leaning on library defaults.

---

## Architecture Decisions

### `mergeEdges` goes in the existing per-diagram graph-option constants

Each builder already owns a module-level `LAYOUT_OPTIONS` map, and the two relation graphs get theirs from `DEPENDENCY_LAYOUT` / `INHERITANCE_LAYOUT` in the controller. The new key is added to those maps with a comment explaining why, mirroring the comment above [buildSchemaDiagram.ts:9-18](frontend/src/data/buildSchemaDiagram.ts#L9) that records why its two spacings were widened past ELK's defaults.[^precedent]

`elk.layered.mergeEdges` is a graph-level (parent-targeted) option, so it belongs in `DiagramData.layoutOptions` and never on a node.

### Card mode keeps its own, unmerged option map

`buildSchemaDiagram` serves two modes from one constant today. It gains a second constant so only the flat mode gets `mergeEdges`; passing `columnsByTable` (card mode) keeps the unchanged map.[^card-inert]

Card mode is the one diagram with a column model, so by the governing rule its edges stay separate — but only per *column*. Two FKs anchored to different columns keep their distinct ports; two FKs anchored to the same column already converge on that column's single shared port. Both behaviours are already true today and neither needs code; the decision here is only to keep node-level merging out of the way.

| Mode | Entry point | Options returned |
|---|---|---|
| Flat table-to-table | `openSchemaDiagram` → `buildSchemaGraphData(ref)` ([SqlAdminController.ts:1502](frontend/src/SqlAdminController.ts#L1502)) | `FLAT_LAYOUT_OPTIONS` (with `mergeEdges`) |
| Column-level cards | `openRelationDiagram` → `buildSchemaGraphData(ref, { withColumns: true })` ([SqlAdminController.ts:1674](frontend/src/SqlAdminController.ts#L1674)) | `LAYOUT_OPTIONS` (no `mergeEdges`) |

### The Explain plan tree is not merged

`buildExplainDiagram` keeps its options as they are.[^explain-no-merge]

### The schema-overview graph is not touched

`buildSchemaOverviewDiagram` ([frontend/src/data/schemaOverviewDiagram.ts:61](frontend/src/data/schemaOverviewDiagram.ts#L61)) emits no `layoutOptions` at all and stays that way.[^overview-untouched]

### Node growth is enabled on no diagram

The four ELK options that make a node grow to fit its edge anchors are not added anywhere. The reasons are per-diagram, not general.[^growth-nowhere] The library doc line records the requirement; [Addendum: Enabling node growth later](#addendum-enabling-node-growth-later) records the exact recipe and its hazard so a future change does not have to re-derive them.

---

## Internal Structure

### What `mergeEdges` changes

Take three tables whose foreign keys all point at `orders`:

| Graph | Input ports ELK creates at `orders` | Drawn result |
|---|---|---|
| `line_items → orders`, `shipments → orders`, `payments → orders`, option **off** (today) | three, spread along the west side | three separate lines, each meeting `orders` at its own point |
| the same graph, option **on** | one, shared | the three lines converge into one trunk before touching `orders` |

The same applies in reverse to a node's outgoing edges (one shared output port), which is what makes a role's many grant edges leave its node from a single anchor instead of one anchor each.

### The option map per diagram after this plan

| Diagram | Where the map lives | `elk.layered.mergeEdges` |
|---|---|---|
| Schema diagram (flat) | `buildSchemaDiagram` `FLAT_LAYOUT_OPTIONS` (new) | `"true"` |
| Schema diagram (column cards) | `buildSchemaDiagram` `LAYOUT_OPTIONS` | absent |
| Database diagram, Tables mode | `buildDatabaseDiagram` `LAYOUT_OPTIONS` | `"true"` |
| Database diagram, Overview mode | `buildSchemaOverviewDiagram` — emits none | absent (file untouched) |
| Dependency graph | `SqlAdminController` `DEPENDENCY_LAYOUT` | `"true"` |
| Inheritance graph | `SqlAdminController` `INHERITANCE_LAYOUT` | `"true"` |
| Role membership graph | `buildRoleMembershipDiagram` `LAYOUT_OPTIONS` | `"true"` |
| Role grants graph | `buildRoleGrantsDiagram` `LAYOUT_OPTIONS` | `"true"` |
| Explain plan diagram | `buildExplainDiagram` `LAYOUT_OPTIONS` | absent |

### `buildSchemaDiagram`'s two constants

```typescript
// (existing comment about direction and the two widened spacings stays as-is)
const LAYOUT_OPTIONS: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.layered.spacing.nodeNodeBetweenLayers": "120",
    "elk.spacing.nodeNode": "40",
};

// Flat mode only. `mergeEdges` gives each node ONE shared input port and ONE
// shared output port instead of one port per edge, so several FKs pointing at
// the same table join into one trunk before reaching it. It applies only to
// edges that carry no ports, so it must NOT be set in card mode: card nodes pin
// their ports with `elk.portConstraints: FIXED_POS`, and a card-mode FK that
// falls back to a node-level anchor would ask ELK to invent a merged port on a
// node whose port positions are all fixed.
const FLAT_LAYOUT_OPTIONS: Record<string, string> = {
    ...LAYOUT_OPTIONS,
    "elk.layered.mergeEdges": "true",
};
```

The return becomes `layoutOptions: columnsByTable ? LAYOUT_OPTIONS : FLAT_LAYOUT_OPTIONS` ([buildSchemaDiagram.ts:114](frontend/src/data/buildSchemaDiagram.ts#L114)).

### The library documentation bullet

Added to the `## Notes` list in `packages/lib/docs/components/DiagramView.md` ([line 144](../typescript-ui/packages/lib/docs/components/DiagramView.md#L144)), in the same bold-lead style as the bullets around it:

> - **Growing a node to fit its edges needs `elk.nodeSize.constraints`.** The view always feeds ELK an explicit size for every leaf node — the model's `width`/`height` when set, else the node component's preferred size — and ELK treats a sized node with the default (empty) `elk.nodeSize.constraints` as fixed. To let ELK enlarge a node so its edge anchors clear each other, set `elk.nodeSize.constraints: 'PORTS'` (optionally `'PORTS,NODE_LABELS'`) plus `elk.portConstraints: 'FIXED_SIDE'` in that node's `layoutOptions`, and give `elk.nodeSize.minimum` so the node cannot shrink below its rendered content. The returned size is written back through `setPreferredSize`, so a grown node renders grown — which only helps if the node's renderer fills the extra space.

---

## Ordered Implementation Steps

### Library (typescript-ui) — first, per the cross-repo convention

1. **`packages/lib/docs/components/DiagramView.md`**: add the `## Notes` bullet from _Internal Structure_ above, after the "Custom node content." bullet. No other edit; no new page, no new link target, no sidebar or catalog entry (the page already exists).
2. **Checkpoint**: in `/home/jika/typescript/typescript-ui`, run `npm -w packages/docs run test` — the docs-app tests (`tests/pages.test.ts`, `tests/links.test.ts`) must stay green. Do **not** run `npm run build:lib`: no library source changed, so there is nothing to rebuild.[^no-rebuild]

### App (sqladmin/frontend) — tests first, per the project's red-green flow

3. **`frontend/tests/data/buildSchemaDiagram.test.ts`**: update the two `toEqual` layout-option assertions (lines 98 and 118) to include `"elk.layered.mergeEdges": "true"`, and add a card-mode test asserting the key is **absent** in card mode. Run `npm test` — these must fail before step 4.
4. **`frontend/src/data/buildSchemaDiagram.ts`**: add `FLAT_LAYOUT_OPTIONS` with its comment, switch the return at line 114 to pick between the two maps, and extend the `@returns` line of `buildSchemaDiagram`'s JSDoc (line 68) to say that flat mode also merges portless edges while card mode does not. Re-run `npm test` — green.
5. **`frontend/tests/data/buildDatabaseDiagram.test.ts`**: add `"elk.layered.mergeEdges": "true"` to the `toEqual` at line 130 (fails), then add the key to `LAYOUT_OPTIONS` in **`frontend/src/data/buildDatabaseDiagram.ts:17`** with a one-line comment pointing at `buildSchemaDiagram`'s `FLAT_LAYOUT_OPTIONS` for the rationale. Green.
6. **`frontend/tests/data/buildRoleMembershipDiagram.test.ts`**: extend the "passes the layered/RIGHT layout options through" test with `expect(out.layoutOptions?.["elk.layered.mergeEdges"]).toBe("true")` (fails), then add the key in **`frontend/src/data/buildRoleMembershipDiagram.ts:10`**. Green.
7. **`frontend/tests/data/buildRoleGrantsDiagram.test.ts`**: add a new test asserting `layoutOptions` carries `elk.algorithm: "layered"`, `elk.direction: "RIGHT"`, and `elk.layered.mergeEdges: "true"` (fails on the last), then add the key in **`frontend/src/data/buildRoleGrantsDiagram.ts:11`**. Green.
8. **`frontend/tests/data/buildExplainDiagram.test.ts`**: add an assertion that `buildExplainDiagram([node("0")]).layoutOptions?.["elk.layered.mergeEdges"]` is `undefined`, with a comment naming the reason (arrowheads sit on the source end). This test passes immediately — it pins the deliberate exclusion so a later sweep does not switch it on. No source change to `buildExplainDiagram.ts`.
9. **`frontend/src/SqlAdminController.ts`**: add `"elk.layered.mergeEdges": "true"` to `DEPENDENCY_LAYOUT` (line 173) and `INHERITANCE_LAYOUT` (line 176), extending each existing comment with one clause on why. No test covers these two.[^controller-untestable]
10. **Regression grep**: `grep -rn 'elk.layered.mergeEdges' frontend/src` — expect **six lines across five files**: one each in `buildSchemaDiagram.ts`, `buildDatabaseDiagram.ts`, `buildRoleMembershipDiagram.ts`, `buildRoleGrantsDiagram.ts`, and two in `SqlAdminController.ts`. `grep -rn 'nodeSize' frontend/src` — expect zero matches (it is zero today, and this plan adds none).
11. **Checkpoint**: `cd frontend && npm run typecheck && npm test` — all green.
12. **Manual verification**: work through every case in _Expected Behaviour → manual-verify_ below.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `../typescript-ui/packages/lib/docs/components/DiagramView.md` (one `## Notes` bullet) |
| Modify | `frontend/src/data/buildSchemaDiagram.ts` (`FLAT_LAYOUT_OPTIONS`, mode-dependent return, JSDoc) |
| Modify | `frontend/src/data/buildDatabaseDiagram.ts` (`mergeEdges` in `LAYOUT_OPTIONS`) |
| Modify | `frontend/src/data/buildRoleMembershipDiagram.ts` (`mergeEdges` in `LAYOUT_OPTIONS`) |
| Modify | `frontend/src/data/buildRoleGrantsDiagram.ts` (`mergeEdges` in `LAYOUT_OPTIONS`) |
| Modify | `frontend/src/SqlAdminController.ts` (`mergeEdges` in `DEPENDENCY_LAYOUT` and `INHERITANCE_LAYOUT`) |
| Modify | `frontend/tests/data/buildSchemaDiagram.test.ts` |
| Modify | `frontend/tests/data/buildDatabaseDiagram.test.ts` |
| Modify | `frontend/tests/data/buildRoleMembershipDiagram.test.ts` |
| Modify | `frontend/tests/data/buildRoleGrantsDiagram.test.ts` |
| Modify | `frontend/tests/data/buildExplainDiagram.test.ts` |

---

## Expected Behaviour

Most of the payoff here is **visual**: the tests can only pin which options each builder emits, not what ELK draws with them. Both halves are listed separately below.

### Unit-testable — the emitted `layoutOptions` maps (node vitest, `frontend/tests/data/`)

`buildSchemaDiagram`:
- Flat mode (`buildSchemaDiagram(["a"], [structure()])`) → `layoutOptions` equals exactly:
  `{ "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.layered.spacing.nodeNodeBetweenLayers": "120", "elk.spacing.nodeNode": "40", "elk.layered.mergeEdges": "true" }`.
- Flat mode with an empty schema (`buildSchemaDiagram([], [])`) → the same map (options do not depend on content).
- Card mode (`columnsByTable` present) → the same map **minus** `elk.layered.mergeEdges`; the key is absent, not `"false"`.
- Card mode still sets `elk.portConstraints: "FIXED_POS"` on each node, unchanged.
- Nodes, edges, ports, and edge ids are byte-for-byte unchanged in both modes — only `layoutOptions` differs.

`buildDatabaseDiagram`:
- `layoutOptions` equals `{ "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.layered.mergeEdges": "true" }`.
- `groupBySchema` still passes `layoutOptions` through verbatim, so the compound (Tables-mode) graph carries the key too — the existing pass-through test at [tests/data/groupBySchema.test.ts:47](frontend/tests/data/groupBySchema.test.ts#L47) already covers this and must stay green unchanged.

`buildRoleMembershipDiagram` and `buildRoleGrantsDiagram`:
- `layoutOptions["elk.layered.mergeEdges"] === "true"`, alongside the existing `layered` / `RIGHT` pair.

`buildExplainDiagram`:
- `layoutOptions["elk.layered.mergeEdges"]` is `undefined`; `elk.direction` is still `"DOWN"` and `elk.layered.spacing.nodeNodeBetweenLayers` still `"50"`.

`buildSchemaOverviewDiagram`:
- Unchanged — still returns no `layoutOptions` at all. No new test.

### Manual-verify — needs the real app, ELK, and a browser

Log in with Host **`sqladmin-db`** (not `localhost`).

| Screen | How to open | What to look for |
|---|---|---|
| Schema diagram (flat) | right-click a schema → "Open schema diagram" | several FKs pointing at one table now join into a single trunk before reaching it; a self-referential FK still draws its loop; two FK constraints between the same table pair now draw as **one** route — intended, since this diagram has no column model, and the per-constraint detail stays visible in card mode |
| Relation diagram (column cards) | right-click a table → "Show relations" | **unchanged** from before: two FKs on different columns still land on their own column rows; two FKs on the same column still converge on that row's single anchor |
| Database diagram, Tables mode | open the database diagram, switch Mode to "Tables" | cross-schema FKs merge at their target table; edges still cross the schema container boxes correctly and no edge is dropped |
| Database diagram, Overview mode | the database diagram's default mode | **unchanged** — this builder was not touched |
| Dependency graph | right-click a schema → the dependency graph action | several views depending on one table converge into one trunk; edges stay dashed |
| Inheritance graph | right-click a schema → the inheritance graph action | a partitioned parent's edges to its children leave from one anchor under the parent |
| Role membership graph | a role's "membership" action | edges into a widely-granted parent role merge; the `admin` edge labels stay readable and do not stack |
| Role grants graph | a role's grants action | the fan-out to the granted tables leaves the role node at a single anchor; the per-edge privilege labels stay legible |
| Explain diagram | run a query with EXPLAIN and open the diagram | **unchanged** — each child still has its own edge, its own arrowhead at the parent end, and its own row-count label |

Also confirm on every merged screen that pan, zoom, zoom-to-fit, node selection, and double-click activation still work, and that the browser console stays free of ELK errors.

---

## Verification

- **Library docs**: in `/home/jika/typescript/typescript-ui`, `npm -w packages/docs run test` — green. No `build:lib`, no `docs:api` regeneration (no symbol changed).
- **App typecheck**: `cd frontend && npm run typecheck`.
- **App unit tests**: `cd frontend && npm test` — the five builder test files above cover every _unit-testable_ case; `groupBySchema.test.ts`, `relationDiagram.test.ts`, `buildRelationGraph.test.ts`, and `schemaOverviewDiagram.test.ts` must stay green **without edits**.
- **Grep invariants**: `grep -rn 'elk.layered.mergeEdges' frontend/src` → six lines across five files; `grep -rn 'nodeSize' frontend/src` → zero matches (proves (B) was not switched on anywhere).
- **Manual smoke**: the table in _Expected Behaviour → manual-verify_, driven against Host `sqladmin-db`.

---

## Documentation Impact

- The only doc change is one bullet in the hand-written `packages/lib/docs/components/DiagramView.md`. `packages/lib/docs/api/` is TypeDoc output and gitignored — never edit it.
- No public symbol is added, renamed, or removed, so no barrel export, catalog entry, sidebar entry, or `llms.txt` update is needed.
- No app-side documentation change: `frontend/COMPONENT_CONVENTIONS.md` and `LIBRARY_NOTES.md` are unaffected, and `TODO.md` has no entry for either wishlist item.

---

## Potential Challenges

- **Two FK constraints between the same table pair collapse to one drawn route** in the flat schema diagram, because merging gives both edges the same source and target port. This is the governing rule working as intended, not a cost: the flat diagram has no column model to tell the two constraints apart, and the per-constraint detail is exactly what the column-level card mode exists to show. Listed as a manual check so the behaviour is confirmed by eye, not assumed.
- **Self-referential FKs.** `buildSchemaDiagram` keeps them ([tests/data/buildSchemaDiagram.test.ts:86](frontend/tests/data/buildSchemaDiagram.test.ts#L86)), and a merged self-loop now starts and ends on the node's two shared ports. Manual check: the loop still renders on a table with a `manager_id`-style FK.
- **Hierarchy interaction in Tables mode.** The database diagram sets `elk.hierarchyHandling: "INCLUDE_CHILDREN"` by library default, and `elk.layered.mergeHierarchyEdges` already defaults to `true` in ELK, so hierarchy-crossing edges already share hierarchical ports. Adding `mergeEdges` changes the node-level ports only. Manual check: no cross-schema edge disappears.
- **Edge labels near a merged anchor.** Labels render at the route midpoint, and merged edges share only the segment nearest the node, so midpoints still differ. Manual check on the role grants and role membership graphs, whose edges are labelled.
- **If a merged trunk looks crowded**, the levers are `elk.spacing.edgeEdge` and `elk.spacing.edgeNode` in the same graph-option map — not code, and not part of this plan (each would be a new number needing its own justification).

---

## Critical Files

- [frontend/src/data/buildSchemaDiagram.ts:9-24](frontend/src/data/buildSchemaDiagram.ts#L9) — `LAYOUT_OPTIONS` and the comment above it explaining why its two spacings were widened past ELK's defaults. **This is the comment style every new option must follow.**
- [frontend/src/data/buildSchemaDiagram.ts:129-200](frontend/src/data/buildSchemaDiagram.ts#L129) — `applyCardMode`: sets `elk.portConstraints: "FIXED_POS"` per node and anchors edges to `portId(...)` ports, falling back to a node-level anchor when a column is missing. The fallback is why card mode must not merge.
- [frontend/src/data/schemaCardModel.ts:12-63](frontend/src/data/schemaCardModel.ts#L12) — `CARD_WIDTH`, `CARD_ROW_HEIGHT`, `cardHeight`, `columnPortY`: the fixed geometry that already guarantees card-mode edge separation.
- [frontend/src/data/buildExplainDiagram.ts:13-21](frontend/src/data/buildExplainDiagram.ts#L13) and [:70-77](frontend/src/data/buildExplainDiagram.ts#L70) — the DOWN layout options, and the `startMarker: "arrow"` + mid-edge label that make merging wrong here.
- [frontend/src/SqlAdminController.ts:171-176](frontend/src/SqlAdminController.ts#L171) — `DEPENDENCY_LAYOUT` / `INHERITANCE_LAYOUT`, passed into `buildRelationGraph` verbatim.
- [frontend/src/data/buildRelationGraph.ts:68-93](frontend/src/data/buildRelationGraph.ts#L68) — emits no ports and no per-node `layoutOptions`, so its nodes are fully portless.
- [frontend/src/dock/TableCardNode.ts:78-83](frontend/src/dock/TableCardNode.ts#L78) and [frontend/src/dock/ExplainNode.ts:28-32](frontend/src/dock/ExplainNode.ts#L28) — both card renderers pin their inner content to a fixed `CARD_WIDTH`; this is why node growth would produce dead space.
- [../typescript-ui/packages/lib/src/typescript/lib/component/diagram/ElkLayoutEngine.ts:149-177](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/ElkLayoutEngine.ts#L149) — `mapDiagramNode`: every leaf gets an explicit `width`/`height` (falling back to 120×40), which is what makes `elk.nodeSize.constraints` mandatory for growth.
- [../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts:430-475](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L430) — `collectNodeSizes` and `applyLayout`: the size round-trip, including the write-back through `setPreferredSize`.
- [../typescript-ui/packages/lib/docs/components/DiagramView.md:144-149](../typescript-ui/packages/lib/docs/components/DiagramView.md#L144) — the `## Notes` list the new bullet joins.

---

## Non-Goals

- **Enabling node growth** (`elk.nodeSize.constraints`, `elk.nodeSize.minimum`, `elk.spacing.portPort`, `elk.portConstraints: FIXED_SIDE`) on any diagram — see the decision above and the addendum for the recipe if it is ever wanted.
- **Any library source change.** The only library edit is a Markdown bullet.
- **Touching `buildSchemaOverviewDiagram`** or the database diagram's Overview mode.
- **Tuning `elk.spacing.edgeEdge` / `elk.spacing.edgeNode`** or any other spacing value — every existing number stays as-is, and no new one is introduced.
- **Making the merge user-toggleable.** It is a fixed per-diagram layout choice, like `elk.direction`.
- The scope of the sibling diagram UI/UX plans: `elkjs-0-12-upgrade`, `diagram-layout-settled-and-root-focus`, `diagram-edge-interaction`, `diagram-depth-limit-and-expand-indicator`. Nothing here duplicates them. Two files are plausibly shared and declared in the frontmatter's `touches-shared`: `frontend/src/SqlAdminController.ts` (edited only at lines 173-176) and the library's `DiagramView.md` (one added bullet).
- **Rendering a visual junction dot** where merged edges meet — ELK produces the shared geometry; drawing a marker at the junction would be a `DiagramEdgeLayer` change and belongs to the edge-rendering siblings.

---

## Addendum: Enabling node growth later

If a future diagram does need ELK to enlarge a node so its edge anchors clear each other, the recipe is four options in that **node's** `layoutOptions` (all four option ids verified present in both the installed elkjs 0.10.2 bundle and 0.12.0):

| Option | Value | Why it is needed |
|---|---|---|
| `elk.portConstraints` | `"FIXED_SIDE"` | keeps incoming edges on one side and outgoing on the other while letting ELK choose positions along it |
| `elk.nodeSize.constraints` | `"PORTS"` (or `"PORTS,NODE_LABELS"`) | without it, ELK's empty default means "this node's size is already fixed, do not change it" |
| `elk.spacing.portPort` | leave at ELK's default (`10`) | the minimum gap between two anchors on the same side |
| `elk.nodeSize.minimum` | the node's rendered size | with a non-empty `nodeSize.constraints`, ELK may also **shrink** the node to the computed minimum, clipping its content |

Two hazards to handle at that point:

1. **`mergeEdges` must be off for that node's graph.** Merging leaves the node with one input and one output port, so there is no port pair for `spacing.portPort` to separate and nothing for `nodeSize.constraints: PORTS` to grow around — the four options become inert.
2. **A size ratchet.** `DiagramView.collectNodeSizes` reads a node component's preferred size when the model carries no explicit `width`/`height`, and `applyLayout` writes ELK's returned size back into that same preferred size. Today ELK returns the size it was given, so the loop is stable. With `nodeSize.constraints` non-empty it need not be, and each re-layout could feed back a larger input. Setting an explicit `width`/`height` on the model node, or a fixed `nodeSize.minimum`, breaks the loop.

---

## Implementation Notes

Manual verification (per `## Expected Behaviour → Manual-verify`) was performed against the
real app — Postgres via `docker compose up -d db`, a dedicated backend on a free port with
`SQLADMIN_ALLOWED_HOSTS` covering `localhost:5432`, and a `--strictPort` Vite dev server for
this worktree's `frontend/` (the shared dev stack on :8000/:5173 was already in use by another
concurrent session, so a separate backend/frontend pair avoided disturbing it) — driven with
the chrome-devtools MCP tools, logging in with Host `localhost` (this environment has no
`sqladmin-db` DNS entry outside the Docker Compose network; `localhost:5432` is the
backend's default allowlisted host and is a like-for-like substitute for the same Postgres
instance). Console stayed free of ELK errors in every case below (only the pre-existing
favicon 404 and an incidental pre-login `/api/whoami` 401 were logged).

Confirmed working as intended — the merge behaviour itself was actually seen, not just the
absence of a crash:
- **Role grants graph** (`readwrite` role, 8 granted tables): unambiguous — all 8 edges leave
  the role node through one shared trunk before fanning out, matching item (A) exactly.
- **Explain diagram** (`EXPLAIN ANALYZE` on a two-table join): confirmed *not* merged — the
  `Hash Join` node's two incoming edges keep separate arrowheads and separate row-count
  labels, as the exclusion in `buildExplainDiagram.ts` requires.
- **Schema diagram, flat mode**: `public` (2 tables) and `sales` (4 tables, two disjoint FK
  pairs) render unchanged, as expected with no convergence present in that data. The 154-table
  `hub` schema visibly narrows to a small number of thick trunks before widening again,
  consistent with merged input/output ports at a shared hub table, though this large a graph
  did not let me isolate one specific converging node with certainty.
- **Schema diagram, card mode** (`public.orders` "Show relations"): renders unchanged — FK
  anchored to a specific column row, matching the pre-existing per-column port behavior.
- **Database diagram, Overview mode**: unchanged (schema-level nodes only), as expected since
  that builder is untouched.

Rendered correctly, but the merge itself was not specifically isolated — only confirmed as
"no ELK error, no dropped edge," not as "I watched a convergence happen here":
- **Database diagram, Tables mode** (171 tables, all schemas): renders cross-schema FKs
  without error, but I did not pick out one specific cross-schema target table and confirm its
  incoming edges shared a single trunk the way the Role grants graph screen did.
- **Dependency graph**: `public` (2 relations) and `hub` (313 relations) both render without
  ELK errors; the `hub` graph was too dense to visually isolate one converging node, and
  `public`'s 2 relations gave no convergence to look for.

Not confirmed, and why:
- **Inheritance graph**: every schema in this seeded database (`analytics`, `hub`, and others
  checked) reports 0 relations — there are no partitioned tables in the dataset, so the merge
  behavior on `INHERITANCE_LAYOUT` has no edges to exercise here. The option is present in the
  constant (`SqlAdminController.ts`) and the graph renders an empty canvas without error, but a
  converging parent-with-children case was not available to click through.
- **Role membership graph**: opened (`readwrite`, depth 1) but the visible slice was a single
  linear chain (`app_service -> readwrite -> readonly`), not a multi-parent convergence, so it
  did not exercise the merge visually. `Show grants graph` (above) exercises the same
  `buildRoleMembershipDiagram`/`buildRoleGrantsDiagram` sibling code path and layout-option
  shape, so this is a coverage gap in the specific case checked, not in the code path.
- The two remaining "Potential Challenges" call-outs — a self-referential FK's merged
  self-loop, and two FK constraints between the same table pair collapsing to one drawn route
  in flat mode — were not specifically constructed and checked; the seeded dataset's schema
  diagrams did not happen to contain either case.

## Notes

[^merge-semantics]: ELK registers the option as `org.eclipse.elk.layered.mergeEdges`, titled "Merge Edges", described as: *"Edges that have no ports are merged so they touch the connected nodes at the same points. When this option is disabled, one port is created for each edge directly connected to a node. When it is enabled, all such incoming edges share an input port, and all outgoing edges share an output port."* Default `false`. Read out of the option registry in the app's installed `node_modules/elkjs/lib/elk.bundled.js` (elkjs 0.10.2) and confirmed present in 0.12.0. Because it only affects portless edges, it needs no library support: graph-level `DiagramData.layoutOptions` already reach ELK untouched via `buildElkGraph`'s merge of `HIERARCHY_HANDLING_DEFAULT` < view defaults < `data.layoutOptions`.

[^card-inert]: Three separate reasons, any one of which is sufficient. (1) Card mode already merges by construction: every FK into a given (table, column) resolves to the same `targetPort` id through `portId` ([schemaCardModel.ts:142](frontend/src/data/schemaCardModel.ts#L142)), so ELK's router already treats them as one hyperedge into one anchor. (2) `applyCardMode` sets `elk.portConstraints: "FIXED_POS"` on every card node, which tells ELK all port positions are fixed; asking it to invent a merged port there has no defined position. (3) Card mode is not fully ported — an FK whose first local column is missing from the fetched columns falls back to a node-level anchor ([buildSchemaDiagram.ts:165-173](frontend/src/data/buildSchemaDiagram.ts#L165)), so a card-mode graph can contain portless edges that `mergeEdges` would act on. Splitting the constant is one line and removes the question entirely.

[^explain-no-merge]: A query plan is a tree: every child has exactly one parent, so there is no incoming convergence to merge. Merging would only collapse each parent's *outgoing* edges onto one anchor, and that makes the diagram worse in two concrete ways. The arrowhead sits on the **source** end (`startMarker: "arrow"`, auto-reversed to point up the tree — [buildExplainDiagram.ts:74-77](frontend/src/data/buildExplainDiagram.ts#L74)), so every one of a parent's arrowheads would be drawn on the same pixel. And each edge carries a mid-edge row-count label whose legibility depends on the edges being separated near the parent; `elk.layered.spacing.nodeNodeBetweenLayers` was already widened to `50` specifically to give those labels room ([buildExplainDiagram.ts:13-21](frontend/src/data/buildExplainDiagram.ts#L13)).

[^overview-untouched]: `buildSchemaOverviewDiagram` returns `{ nodes, edges }` with no `layoutOptions`, relying on ELK's and the library's defaults — exactly the "lean on library defaults" preference. Its edges are already aggregated one per ordered schema pair, so a schema has at most one edge to each other schema; with a handful of schemas there is nothing worth merging. Adding a first `layoutOptions` map to that builder for no visible gain would be scope creep.

[^growth-nowhere]: Three findings, taken together. (1) **On the merged graphs the options are inert.** `mergeEdges` leaves a node with one input and one output port, so `elk.spacing.portPort` has no same-side pair to separate and `elk.nodeSize.constraints: "PORTS"` computes a minimum from two ports — no growth. Item (A) and item (B) are alternatives for the same node, and (A) is what the wishlist asked for on convergence. (2) **The two unmerged diagrams render through fixed-width cards.** `TableCardNode` pins its header and every row to `CARD_WIDTH = 220` ([TableCardNode.ts:78-83](frontend/src/dock/TableCardNode.ts#L78)) at `CARD_ROW_HEIGHT` each, and `ExplainNode` pins its header and metric grid to `CARD_WIDTH = 240` ([ExplainNode.ts:32](frontend/src/dock/ExplainNode.ts#L32)); a card ELK enlarged would show an empty strip, not useful room. (3) **Card mode already satisfies the requirement.** Ports are pinned `FIXED_POS` at `columnPortY(index)`, so two edges on distinct columns are always at least `CARD_ROW_HEIGHT` (22px) apart, and the card's height already accounts for every row via `cardHeight`. Two card-mode edges can coincide only when they share a column — which is item (A)'s merge case, not a spacing case. `FIXED_POS` also tells ELK not to move ports or resize the node, so "grow the node" has no meaning for a card.

[^no-rebuild]: The cross-repo convention puts library steps first with a `npm run build:lib` checkpoint because the app typechecks against the library's built declarations. Here the library edit is a Markdown file that no build consumes and no declaration references, so a rebuild would verify nothing. The docs app reads `packages/lib/docs/` directly, so `npm -w packages/docs run test` is the checkpoint that actually covers the change.

[^controller-untestable]: `DEPENDENCY_LAYOUT` and `INHERITANCE_LAYOUT` are module-private constants inside `SqlAdminController.ts`, which imports UI-bundle code and therefore cannot be loaded by the app's DOM-free node vitest (the same constraint the builders' purity comments describe). They reach ELK only through `buildRelationGraph`'s pass-through parameter, which `tests/data/buildRelationGraph.test.ts` already covers with its own fixture map. Their contents are manual-verify only, via the dependency and inheritance graph screens.

[^precedent]: [buildSchemaDiagram.ts:9-18](frontend/src/data/buildSchemaDiagram.ts#L9) is the in-repo precedent for documenting an ELK option: it names the direction choice, then says exactly why each spacing was widened past ELK's ~20px default and what visual problem the widening solves. [buildExplainDiagram.ts:13-16](frontend/src/data/buildExplainDiagram.ts#L13) follows the same shape for its own widened spacing. New options follow it: what the option does, why this diagram wants it, and where it must not be set.
