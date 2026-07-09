# FK Diagram Cardinality & Index-Coverage Overlays — Implementation Plan

## Overview

Enrich the existing foreign-key ER diagram (schema diagram + relation-rooted diagram) with two annotations derived from metadata the app can already fetch — **no new backend endpoint**:

1. **Crow's-foot cardinality** on every FK edge: 1:1 vs 1:N (is the FK's local column set backed by a UNIQUE constraint/index?) and mandatory vs optional (are the FK's local columns NOT NULL?), plus an optional referential-action label. Rendering crow's-foot markers is a **library change** owned by this plan: an additive edge-style / edge-marker descriptor on `DiagramEdgeData` + rendering in `DiagramEdgeLayer`.
2. **FK-without-covering-index overlay**: FK edges whose local columns are not backed by a covering index get a warning-tinted stroke, gated behind a toggle in the relation-rooted panel's side controls.

The cardinality/coverage **inference is pure** and lives in a new node-vitest-testable module `frontend/src/data/fkCardinality.ts` (type-only imports from the diagram barrel; no UI-bundle runtime imports — the same DOM-free discipline as [buildSchemaDiagram.ts:16-21](frontend/src/data/buildSchemaDiagram.ts#L16)). The **rendering** is the additive library change. The two are joined in [SqlAdminController.buildSchemaGraphData](frontend/src/SqlAdminController.ts#L377), which already fetches structures for the whole schema and will now also fetch columns.

Library files (separate repo, consumed via the `file:../../typescript-ui` symlink dep — [frontend/package.json:14](frontend/package.json#L14)): `DiagramModel.ts`, `DiagramEdgeLayer.ts`, `DiagramView.ts`, barrel `index.ts`. After any library edit, `npm run build:lib` must run in the library repo before the app typechecks against it.

---

## Architecture Decisions

### Inference is a separate pure module, not folded into `buildSchemaDiagram`

`buildSchemaDiagram(tables, structures)` stays byte-for-byte as-is (its tests stay green). A new pure module `frontend/src/data/fkCardinality.ts` takes the assembled `DiagramData` plus the per-table structures and columns and returns a new `DiagramData` with cardinality `style` baked onto each FK edge and an `uncovered` flag added to each edge's `FkEdgeData`. This isolates all new inference behind its own focused unit tests and keeps graph assembly decoupled from the extra columns fetch.

### Cardinality is always-on; index-coverage is a toggle

Cardinality markers are baked onto edges at graph-build time in `buildSchemaGraphData`, so **both** the schema diagram and the relation-rooted diagram show them with no UI. Index-coverage is presentational-only: the `uncovered` boolean is always computed and carried on the edge, but the warning tint is applied only when the user enables it. The toggle lives in `RelationDiagramPanel`'s WEST side panel, mirroring the existing `pruneControl` ([RelationDiagramPanel.ts:119-122](frontend/src/dock/RelationDiagramPanel.ts#L119)). `SchemaDiagramPanel` has no side panel, so it shows cardinality only — no coverage toggle (keeps the schema-wide view uncluttered; the relation-rooted view is where a focused node set makes the overlay actionable).

### Uniqueness and covering-index come from BOTH constraints and index definitions

`ConstraintMeta` carries a structured `columns` array ([contract.ts:133-138](frontend/src/contract.ts#L133)), but `IndexMeta` carries only `name/definition/unique/primary` — **no column list** (confirmed in the backend: [backend/app/operations/table_structure.py](backend/app/operations/table_structure.py) `ListIndexesQuery.get_result` emits `name/definition/unique/primary`; only the constraints query emits `columns`). So:
- **Uniqueness** (1:1 detection): true if a `primaryKey`/`unique` `ConstraintMeta` has a column *set* equal to the FK's columns, OR a `unique` `IndexMeta` whose parsed columns set-equal the FK columns.
- **Covering index**: true if any `IndexMeta`'s parsed leading columns are a prefix matching the FK's columns in order, OR a `primaryKey`/`unique` constraint covers them.

Both require parsing the column list out of `IndexMeta.definition` (the `CREATE INDEX … USING method (col, …)` text). A small pure `parseIndexColumns(definition)` helper does this conservatively; expression/functional index terms it cannot resolve to a bare column name make that index count as "not covering" (safe under-reporting). This is a frontend-only string parse — **no backend change** (the task's "no new endpoint / metadata already available" constraint). Adding a structured `columns` field to `IndexMeta` on the backend was rejected to keep this change frontend-only.

### The edge-style descriptor is generic, not FK-specific

The library gains a `DiagramEdgeStyle` (start/end marker kind, dash, stroke override, optional label) on `DiagramEdgeData`, plus rendering in `DiagramEdgeLayer`. It is designed as a general "edge kind/style" descriptor so the sibling **schema-dependency-graphs** plan can reuse it for dashed dependency edges. Marker kinds are a closed string union covering the crow's-foot vocabulary plus the existing default arrow. Existing plain edges (no `style`) keep today's single arrowhead — the change is strictly additive.

### The ELK round-trip drops edge metadata; re-join style in `DiagramView`

`ElkLayoutEngine.mapElkResult` returns edges as `{ id, sections }` only ([ElkLayoutEngine.ts:161-164](frontend/src/../../../typescript-ui/src/typescript/lib/component/diagram/ElkLayoutEngine.ts#L161)) — `label`/`data`/`style` never reach the edge layer. So `DiagramView.applyLayout` must join each layout route (by `id`) back to the model edge in `this._options.data.edges` and attach `style`/`label` to the `DiagramEdgeRoute` before `setEdges`. ELK itself stays untouched (it needs no styling knowledge).

### Warning-tinted edge, not a node badge

Coverage is a **per-FK** fact; a referencing table can have some covered and some uncovered FKs, so a per-node badge would be ambiguous. The overlay tints the specific uncovered FK edge's stroke instead.

---

## Public API

### Library — `DiagramModel.ts` (new/changed exports)

```typescript
/** Edge end-cap kinds. `"arrow"` is the existing default arrowhead; the rest are
 *  ER crow's-foot end markers. */
export type DiagramEdgeMarker =
    | "arrow"
    | "one"          // "one and only one": ‖ (two perpendicular bars)
    | "zeroOrOne"    // ○‖-ish: circle + one bar
    | "oneOrMany"    // bar + crow's foot
    | "zeroOrMany";  // circle + crow's foot

/** Optional per-edge visual style. Absent = today's plain arrow-ended edge. */
export interface DiagramEdgeStyle {
    /** Marker at the source end (marker-start). Absent = no start marker. */
    startMarker?: DiagramEdgeMarker;
    /** Marker at the target end (marker-end). Absent = no end marker. */
    endMarker?: DiagramEdgeMarker;
    /** Dashed stroke when true (for the sibling dependency-graph plan). */
    dashed?: boolean;
    /** Themed stroke override (e.g. a warning tint). Falls back to EDGE_STROKE. */
    stroke?: string;
    /** Optional mid-edge label (e.g. the referential action). */
    label?: string;
}

export interface DiagramEdgeData {
    // ...existing id/source/target/label/sourcePort/targetPort/data...
    /** Optional additive visual style; plain edges omit it. */
    style?: DiagramEdgeStyle;
}
```

### Library — `DiagramEdgeLayer.ts`

```typescript
export interface DiagramEdgeRoute {
    id:        string;
    sections:  ElkEdgeSection[];
    style?:    DiagramEdgeStyle;   // joined in by DiagramView.applyLayout
}
```

### App — `frontend/src/data/fkCardinality.ts` (new, pure)

```typescript
import type { DiagramData } from "@jimka/typescript-ui/component/diagram";
import type { ColumnMeta, TableStructure } from "../contract";

/** Parse the leading column list out of a CREATE INDEX definition. Returns the
 *  bare column names in order, or null when it cannot parse a plain column list
 *  (e.g. an expression index). */
export function parseIndexColumns(definition: string): string[] | null;

/** True when the FK column set is backed by a PK/unique constraint or a unique index. */
export function isFkUnique(fkColumns: string[], structure: TableStructure): boolean;

/** True when every FK local column is NOT NULL. */
export function isFkMandatory(fkColumns: string[], columns: ColumnMeta[]): boolean;

/** True when some index (or PK/unique constraint) has fkColumns as a leading prefix. */
export function isFkCovered(fkColumns: string[], structure: TableStructure): boolean;

/** Bake cardinality `style` onto each FK edge and set `uncovered` on its FkEdgeData.
 *  `structures`/`columns` are positionally paired with `tables` (same order the
 *  controller fetched them). Returns a NEW DiagramData; input is not mutated. */
export function annotateFkCardinality(
    data: DiagramData,
    tables: string[],
    structures: TableStructure[],
    columns: ColumnMeta[][],
): DiagramData;

/** Return a new DiagramData whose uncovered FK edges get a warning stroke merged
 *  into their style when `show` is true; identity-ish (cardinality style only)
 *  when false. Pure; input not mutated. */
export function applyCoverageStyle(data: DiagramData, show: boolean): DiagramData;
```

### App — `FkEdgeData` gains `uncovered`

```typescript
// buildSchemaDiagram.ts
export interface FkEdgeData {
    // ...existing columns/refColumns/refSchema/onUpdate/onDelete...
    /** Set by annotateFkCardinality: FK local columns lack a covering index. */
    uncovered?: boolean;
}
```

---

## Internal Structure

### Cardinality → marker mapping (in `annotateFkCardinality`)

Edges are oriented `source = referencing (child)`, `target = referenced (parent)` (see [buildSchemaDiagram.ts:66-81](frontend/src/data/buildSchemaDiagram.ts#L66)). So:

- `endMarker` (target/parent end) = `"one"` always (a FK references exactly one parent row).
- `startMarker` (source/child end) from `(unique, mandatory)`:
  | unique | mandatory | startMarker    | meaning        |
  |--------|-----------|----------------|----------------|
  | true   | true      | `"one"`        | 1:1 mandatory  |
  | true   | false     | `"zeroOrOne"`  | 1:1 optional   |
  | false  | true      | `"oneOrMany"`  | 1:N mandatory  |
  | false  | false     | `"zeroOrMany"` | 1:N optional   |

- `unique = isFkUnique(fkCols, structure)`, `mandatory = isFkMandatory(fkCols, columns)`.
- Optional label: `style.label = referentialActionLabel(onUpdate, onDelete)` — e.g. join non-`"NO ACTION"` actions as `"ON DELETE CASCADE"`; omit when both are `"NO ACTION"`. (Rendering the label is the optional final step; the string is cheap to compute here regardless.)

Look up per edge by `edge.source` (the table name) against maps built from the positional `tables`/`structures`/`columns` arrays. Read the FK columns from `(edge.data as FkEdgeData).columns`.

### `parseIndexColumns` (conservative)

From a definition like `CREATE UNIQUE INDEX idx ON public.t USING btree (a, b DESC)`:
1. Find the first top-level `(` after the `USING <method>` (or after `ON <table>` if no `USING`).
2. Take the balanced-paren substring; split on top-level commas (depth 0).
3. Trim each term; strip trailing `ASC`/`DESC`/`NULLS FIRST`/`NULLS LAST`; strip surrounding quotes.
4. If any term is not a bare identifier (contains `(`, operators, spaces after cleanup), return `null` (treat the whole index as unparseable → not covering).

### `isFkCovered` / `isFkUnique` prefix logic

- `covered`: any index whose `parseIndexColumns(def)` is non-null and starts with `fkColumns` in order (prefix), OR any `primaryKey`/`unique` constraint whose `columns` starts with `fkColumns` in order.
- `unique`: any `primaryKey`/`unique` constraint whose `columns` **set-equals** `fkColumns`, OR any `unique` index whose parsed columns set-equal `fkColumns`. (Uniqueness needs an exact column-set match — a unique index on a superset does not make the FK 1:1.)

### `DiagramEdgeLayer` rendering

`createRootElement` pre-defines one `<marker>` per non-`"arrow"` kind in `<defs>` (plus the existing arrow marker), each id namespaced with `this.getId()`, drawn with the themed `EDGE_STROKE` and `orient="auto-start-reverse"` so a marker used at `marker-start` auto-reverses. `rebuildPaths` per edge:
- No `style` → keep today's behaviour: `marker-end` = arrow, no start marker, default stroke. (Back-compat for other consumers.)
- `style` present → set `stroke` from `style.stroke ?? EDGE_STROKE`; set `stroke-dasharray` when `style.dashed`; set `marker-start`/`marker-end` to the namespaced marker id for `style.startMarker`/`style.endMarker` (omit that end when the field is absent).
- Optional label: when `style.label`, append one `<text>` at the mid-point of the route (mid bend point, else midpoint of start/end) — additive, lowest priority; may be deferred.

Marker geometry (starting coordinates in a `markerUnits="userSpaceOnUse"` box, refY at vertical centre; **exact pixels are manual-verify and expected to need visual tuning**):
- `"one"` — two short perpendicular bars across the line near the node end.
- `"oneOrMany"` — a three-prong crow's foot opening toward the node, with one perpendicular bar just inboard of it.
- `"zeroOrOne"` — one perpendicular bar plus a small `<circle>` inboard.
- `"zeroOrMany"` — a crow's foot plus a small `<circle>` inboard.
Track every seam-created marker/child handle via `trackHandle` exactly as the current arrow marker does ([DiagramEdgeLayer.ts:133-135](frontend/src/../../../typescript-ui/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L133)).

### `DiagramView.applyLayout` join

Before `this._edgeLayer.setEdges(result.edges)` ([DiagramView.ts:319](frontend/src/../../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L319)), build `const modelById = new Map(this._options.data.edges.map(e => [e.id, e]))` and map `result.edges` to routes carrying `style: modelById.get(id)?.style`. `DiagramEdgeRoute` gains the optional `style`.

---

## Ordered Implementation Steps

### Library (typescript-ui) — do first so `build:lib` can run before the app typechecks

1. **`DiagramModel.ts`**: add `DiagramEdgeMarker` union and `DiagramEdgeStyle` interface; add optional `style?: DiagramEdgeStyle` to `DiagramEdgeData`. (See Public API.)
2. **`index.ts` barrel**: add `DiagramEdgeMarker`, `DiagramEdgeStyle` to the `export type { … } from '~/component/diagram/DiagramModel.js'` line ([index.ts:11](frontend/src/../../../typescript-ui/src/typescript/lib/component/diagram/index.ts#L11)).
3. **`DiagramEdgeLayer.ts`**: add `style?` to `DiagramEdgeRoute`; import `DiagramEdgeStyle`/`DiagramEdgeMarker` from `~/component/diagram/DiagramModel.js`. In `createRootElement`, define the crow's-foot `<marker>`s alongside the existing arrow (namespaced ids, tracked handles). In `rebuildPaths`, branch on `edge.style` per _Internal Structure_ (no style → unchanged arrow path). Optional: render the label `<text>`.
4. **`DiagramView.ts`**: in `applyLayout`, join model edges by id and attach `style` to each `DiagramEdgeRoute` passed to `setEdges`.
5. **Checkpoint**: in the library repo run `npm run build:lib`. Must succeed (declaration emit + `tsc-alias` + bundle). Then `npm test` in the library (its diagram tests must stay green).

### App (sqladmin/frontend)

6. **`buildSchemaDiagram.ts`**: add optional `uncovered?: boolean` to `FkEdgeData` ([buildSchemaDiagram.ts:29-35](frontend/src/data/buildSchemaDiagram.ts#L29)). No other change; signature and behaviour unchanged.
7. **New `frontend/src/data/fkCardinality.ts`**: implement `parseIndexColumns`, `isFkUnique`, `isFkMandatory`, `isFkCovered`, a private `referentialActionLabel`, `annotateFkCardinality`, `annotateFkCardinality`'s marker mapping, and `applyCoverageStyle`. Type-only imports from `@jimka/typescript-ui/component/diagram` and `../contract`; **no runtime UI-bundle import** (keeps node-vitest purity). Reuse the same "keep literals in sync, don't import UI bundle" discipline documented at [buildSchemaDiagram.ts:16-21](frontend/src/data/buildSchemaDiagram.ts#L16).
8. **New `frontend/src/data/fkCardinality.test.ts`**: cover the _Expected Behaviour → unit-testable_ cases below.
9. **`SqlAdminController.ts` — `buildSchemaGraphData`** ([SqlAdminController.ts:377-390](frontend/src/SqlAdminController.ts#L377)): after fetching `structures`, also `const columns = await Promise.all(tables.map(name => getColumns({ …, name, kind: "table" })))`; then `return annotateFkCardinality(buildSchemaDiagram(tables, structures), tables, structures, columns)`. `getColumns` is already imported ([SqlAdminController.ts:17](frontend/src/SqlAdminController.ts#L17)); add the `annotateFkCardinality` import. Both `openSchemaDiagram` and `openRelationDiagram` consume this, so cardinality reaches both with no further change.
10. **`RelationDiagramPanel.ts`**: add a `showCoverage` state var and a coverage `Checkbox` control mirroring `pruneControl` ([RelationDiagramPanel.ts:119-131](frontend/src/dock/RelationDiagramPanel.ts#L119)), captioned e.g. "Highlight FKs without a covering index". In `applyFilter` ([RelationDiagramPanel.ts:82-84](frontend/src/dock/RelationDiagramPanel.ts#L82)) wrap: `view.setData(applyCoverageStyle(applyHide(base, root.id, hidden, prune, direction), showCoverage))`. Import `applyCoverageStyle` from `../data/fkCardinality`. The checkbox's `change` sets `showCoverage` and calls `applyFilter`.
11. **`SchemaDiagramPanel.ts`**: no code change — it already renders whatever edges/styles the annotated `DiagramData` carries.
12. **Checkpoint**: `cd frontend && npm run typecheck` (needs the rebuilt library from step 5) then `npm test`.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `../typescript-ui/src/typescript/lib/component/diagram/DiagramModel.ts` (add `DiagramEdgeMarker`, `DiagramEdgeStyle`, `DiagramEdgeData.style`) |
| Modify | `../typescript-ui/src/typescript/lib/component/diagram/index.ts` (barrel exports) |
| Modify | `../typescript-ui/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts` (markers + style rendering, `DiagramEdgeRoute.style`) |
| Modify | `../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts` (join style into routes in `applyLayout`) |
| Modify | `frontend/src/data/buildSchemaDiagram.ts` (`FkEdgeData.uncovered`) |
| Create | `frontend/src/data/fkCardinality.ts` |
| Create | `frontend/src/data/fkCardinality.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (`buildSchemaGraphData`: fetch columns, call `annotateFkCardinality`) |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` (coverage toggle) |
| Modify (optional) | `../typescript-ui/tests/component/diagram/DiagramView.test.ts` and/or a new edge-layer test (assert marker refs via the TestDOM sink) |

---

## Expected Behaviour

### Unit-testable — `fkCardinality.ts` (node vitest, `frontend/src/data/fkCardinality.test.ts`)

`parseIndexColumns`:
- `CREATE INDEX i ON public.t USING btree (a, b)` → `["a", "b"]`.
- `CREATE UNIQUE INDEX i ON t USING btree (a DESC, b NULLS FIRST)` → `["a", "b"]`.
- Quoted: `… (\"MixedCase\", b)` → `["MixedCase", "b"]`.
- Expression index `… (lower(email))` → `null`.
- Partial index `… (a) WHERE deleted = false` → `["a"]` (WHERE clause ignored).

`isFkUnique`:
- FK `["a"]` + a `unique` constraint with `columns: ["a"]` → `true`.
- FK `["a"]` + a `primaryKey` constraint `columns: ["a"]` → `true`.
- FK `["a"]` + a `unique` index def on `(a)` → `true`.
- FK `["a"]` + unique constraint on `["a","b"]` (superset) → `false`.
- FK `["a","b"]` + unique constraint on `["a","b"]` (order-insensitive set match) → `true`.
- No unique constraint/index → `false`.

`isFkMandatory`:
- All FK columns `nullable:false` → `true`; any `nullable:true` → `false`.
- Composite: one nullable member → `false`.

`isFkCovered`:
- FK `["a"]` + plain index on `(a, b)` (prefix) → `true`.
- FK `["a","b"]` + index on `(a)` only → `false`.
- FK `["a","b"]` + index on `(a, b, c)` (prefix) → `true`.
- FK `["a","b"]` + index on `(b, a)` (wrong order) → `false`.
- FK `["a"]` + PK/unique constraint on `["a"]` → `true`.
- Only an expression index that can't be parsed → `false`.

`annotateFkCardinality` (marker mapping, per the table in _Internal Structure_):
- unique+mandatory → edge `style.startMarker === "one"`, `style.endMarker === "one"`.
- !unique+optional → `startMarker === "zeroOrMany"`.
- unique+optional → `startMarker === "zeroOrOne"`; !unique+mandatory → `startMarker === "oneOrMany"`.
- Uncovered FK → `(edge.data as FkEdgeData).uncovered === true`; covered → `false`.
- Referential-action label: `onDelete: "CASCADE"` → `style.label` contains `"ON DELETE CASCADE"`; both `"NO ACTION"` → `style.label` undefined.
- Input `DiagramData` is not mutated (returns a new object; original edges unchanged).
- An edge whose source table is missing from the maps (defensive) → left without cardinality style rather than throwing.

`applyCoverageStyle`:
- `show:true` + an edge with `data.uncovered:true` → returned edge's `style.stroke` is the warning colour; its cardinality markers are preserved.
- `show:true` + `data.uncovered:false` → stroke unchanged (cardinality style intact).
- `show:false` → no warning stroke on any edge.
- Input not mutated.

### Library — assertable via the TestDOM sink (`RecordingDOMSink`, as in `DiagramView.test.ts`)

- An edge route with `style.endMarker:"one"` produces a `<path>` whose `marker-end` references the `"one"` marker id; `style.startMarker` sets `marker-start`.
- An edge route with no `style` still gets the arrow `marker-end` and no `marker-start` (back-compat).
- `style.stroke` sets the path `stroke`; `style.dashed` sets `stroke-dasharray`.
- `DiagramView.applyLayout` attaches the model edge's `style` to the route it passes to `setEdges` (assert via a stub engine + a model edge carrying `style`).

### Manual-verify (needs the real app + ELK + browser)

- Open a schema diagram on a schema with FKs: every FK edge shows crow's-foot ends — a "one" bar at the referenced table, a crow's foot (or bar for 1:1) at the referencing table; optional/nullable FKs show the circle.
- Open a relation-rooted diagram; toggle "Highlight FKs without a covering index": uncovered FK edges turn the warning colour; toggling off restores the normal stroke; direction/depth/prune still work alongside it.
- Marker geometry reads correctly at multiple zoom levels and does not overlap node borders (tune coordinates as needed).
- A 1:1 FK (backed by a unique constraint) renders a bar-not-crow's-foot child end.

---

## Verification

- **Library**: `npm run build:lib` (declaration emit + `tsc-alias` + bundle) and `npm test` in `../typescript-ui` — diagram tests green.
- **App typecheck**: `cd frontend && npm run typecheck` — requires the rebuilt library.
- **App unit tests**: `cd frontend && npm test` — `fkCardinality.test.ts` covers every _unit-testable_ case above; existing `buildSchemaDiagram.test.ts` / `relationDiagram.test.ts` stay green (unchanged signatures).
- **Manual smoke**: launch the app, right-click a schema → "Open schema diagram" (cardinality markers); right-click a table → "Show relations" → toggle the coverage checkbox. Entry points: `SqlAdminController.openSchemaDiagram` / `openRelationDiagram`.
- **Regression grep**: `grep -rn "buildSchemaDiagram(" frontend/src` — the only call site is `buildSchemaGraphData` (now wrapped in `annotateFkCardinality`); its own 2-arg tests unchanged.

---

## Potential Challenges

- **Extra N column fetches**: `buildSchemaGraphData` now issues one `getColumns` per table on top of `getStructure`, doubling round trips for a whole schema. Acceptable for the current scale; a combined structure+columns endpoint is out of scope. Fetch columns with `Promise.all` (already the pattern for structures) so they run concurrently.
- **`IndexMeta` has no column list**: mitigated by `parseIndexColumns`; unparseable (expression) indexes safely count as non-covering / non-unique.
- **ELK drops edge metadata**: mitigated by re-joining `style` from the model in `DiagramView.applyLayout` (the model edges survive on `this._options.data`).
- **Crow's-foot marker geometry / orientation**: SVG marker orientation at the start end is handled with `orient="auto-start-reverse"`; exact coordinates are a manual-verify tuning step, not a correctness risk.
- **Library rebuild ordering**: the app typechecks against built declarations, so `npm run build:lib` must run after every library edit and before the app typecheck (step 5 before step 12).

---

## Critical Files

- [frontend/src/data/buildSchemaDiagram.ts](frontend/src/data/buildSchemaDiagram.ts) — `FkEdgeData`, edge assembly, and the DOM-free-purity comment to mirror.
- [frontend/src/data/relationDiagram.ts](frontend/src/data/relationDiagram.ts) — `applyHide`/`subgraph` (edge objects are filtered, not cloned; `applyCoverageStyle` must return new objects to avoid mutating `base`).
- [frontend/src/SqlAdminController.ts:377](frontend/src/SqlAdminController.ts#L377) — `buildSchemaGraphData` (the single integration point).
- [frontend/src/dock/RelationDiagramPanel.ts:119](frontend/src/dock/RelationDiagramPanel.ts#L119) — the control/`applyFilter` pattern the coverage toggle mirrors.
- [frontend/src/contract.ts:125](frontend/src/contract.ts#L125) — `IndexMeta` (no `columns`), `ConstraintMeta` (has `columns`), `ColumnMeta.nullable`, `ForeignKeyMeta`.
- Library `DiagramModel.ts`, `DiagramEdgeLayer.ts`, `DiagramView.ts`, `index.ts` (paths under `../typescript-ui/src/typescript/lib/component/diagram/`).
- `../typescript-ui/tests/component/diagram/DiagramView.test.ts` — the `StubEngine` + `installTestDOM`/`RecordingDOMSink` pattern for asserting rendered SVG attributes without a real DOM.

---

## Non-Goals

- Column/field-card node rendering — nodes stay label + glyph.
- Column-to-column (port) FK edges — `DiagramPortData` remains inert.
- A backend change (new endpoint or a `columns` field on `IndexMeta`) — inference is frontend-only.
- View/inheritance/role graphs, database-level cross-schema diagram, column-level ER diagram (sibling plans).
- The deferred diagram UI/UX visual redesign.
- Coverage overlay in the schema-wide `SchemaDiagramPanel` (no side panel; cardinality only there).
- Dashed dependency edges — the sibling **schema-dependency-graphs** plan consumes this edge-style capability but is not built here.
