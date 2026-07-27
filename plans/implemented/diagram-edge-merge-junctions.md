---
touches-shared:
  - frontend/src/data/buildSchemaDiagram.ts
  - frontend/src/dock/RelationDiagramPanel.ts
---

# Diagram Edge Merge Junctions — Implementation Plan

## Overview

Edges that share a node should meet in a **junction close to that node**: one line leaves a source and splits a short distance out, and many lines converge a short distance before their target so only one line arrives. Today `"elk.layered.mergeEdges": "true"` produces the merging but puts the split in the wrong place — measured on the `hub` schema diagram, the five largest fan-out groups run together for 2,755px / 10,424px / 17,642px / 25,689px / 33,424px on a canvas about 36,000px wide, and one eight-edge group split after 25px while others ran past 25,000px. A viewer cannot tell which line goes where.

The merged trunk is only coincident geometry: the model holds 1058 edges, ELK returns 1058 routes, and the edge layer draws 1058 `<path>` elements whose polylines match to 0.1px over the shared prefix and then diverge. Nothing is collapsed in the data. So shortening the shared run is a route-geometry problem, and ELK has no option that controls where a merged bundle splits.[^no-elk-knob]

This plan therefore does three things:

1. **Drops `mergeEdges`** at all five sites ([buildSchemaDiagram.ts:35](frontend/src/data/buildSchemaDiagram.ts#L35), [buildDatabaseDiagram.ts:24](frontend/src/data/buildDatabaseDiagram.ts#L24), [buildRoleGrantsDiagram.ts:18](frontend/src/data/buildRoleGrantsDiagram.ts#L18), [buildRoleMembershipDiagram.ts:17](frontend/src/data/buildRoleMembershipDiagram.ts#L17), [SqlAdminController.ts:197](frontend/src/SqlAdminController.ts#L197) and [:202](frontend/src/SqlAdminController.ts#L202)), so ELK routes every edge independently with no long shared run.
2. **Adds a short shared stub** to the routes ELK returns: each fan-out and fan-in bundle gets one shared anchor on the node border and one shared junction `EDGE_STUB_LENGTH` away from it, applied by a new pure module and installed through a `DiagramView` subclass that overrides the library's documented swappable-engine seam.[^engine-seam]
3. **Folds two foreign keys between the same table pair into one edge**, since those share *both* anchors and would otherwise be two fully coincident routes. The edge's `data` becomes a list of foreign keys, and the annotations that disagree between folded keys combine by a stated rule.

Everything is app-only — no library source, no library documentation, no `npm run build:lib`.[^app-only]

---

## Architecture Decisions

### Rewrite the returned routes, rather than adding junction nodes to the graph

The stub is produced by transforming `DiagramLayoutResult` after ELK returns it. The rejected alternative was inserting an invisible junction node one layer out from each fan-out source and routing through it.[^mechanism-choice]

### The transform is a pure module; a `DiagramView` subclass installs it

`frontend/src/data/edgeRouteStubs.ts` holds the geometry as a pure function over `(DiagramData, DiagramLayoutResult)`, importing only *types* from `@jimka/typescript-ui/component/diagram` so it stays testable under the app's DOM-free node vitest — the same discipline `buildSchemaDiagram.ts:1-3` and `fkCardinality.ts:1-7` follow. `frontend/src/dock/JunctionDiagramView.ts` holds a `DiagramView` subclass whose `createEngine()` returns an `ElkLayoutEngine` subclass that awaits `super.layout(...)` and passes the result through that function.[^engine-seam]

### Only portless bundles are stubbed

An endpoint that names a `sourcePort` / `targetPort` never joins a bundle. This is the rule ELK's own flag used ("edges that have no ports are merged"), and it keeps the column-level card diagram untouched: every card-mode edge anchors to a per-column port, so no card-mode bundle ever forms.[^portless-rule]

### Two foreign keys between the same table pair become one edge

The two share both anchors, so they coincide over their whole length and no junction can separate them. The foreign-key builders fold them into one edge whose `data` is `FkEdgeData { fks: FkDetail[] }` — a list, always, length 1 outside a fold.[^list-not-primary] `collapseParallelFkEdges` is exported from `buildSchemaDiagram.ts` and imported by `buildDatabaseDiagram.ts`, which already imports `FkEdgeData` from there ([buildDatabaseDiagram.ts:13](frontend/src/data/buildDatabaseDiagram.ts#L13)).[^helper-home]

### Combining rule for a folded edge

A folded edge draws one set of markers, one optional stroke tint, and at most one label:

| Annotation | Combining rule | Why in one line |
|---|---|---|
| Crow's-foot start marker | claim **unique** only when every folded key is unique; claim **mandatory** only when every folded key is mandatory | the line must not assert a constraint that some folded key breaks |
| Index-coverage warning stroke | shown when **at least one** folded key lacks a covering index | a warning that disappears because a sibling key is indexed is a lost warning |
| `ON UPDATE … ON DELETE …` label | shown only when every folded key produces the **same** label text; omitted otherwise | one label cannot describe two different referential actions |

Worked example — `orders` has two foreign keys into `addresses`, both referencing `addresses(id)`:

| Folded key | unique | mandatory | covered | own label |
|---|---|---|---|---|
| `fk_billing (billing_address_id)` | no | yes | yes | `ON DELETE CASCADE` |
| `fk_shipping (shipping_address_id)` | no | no | no | *(none)* |
| **folded edge** | no | **no** | **not covered** | ***(omitted — they disagree)*** |

So the drawn line gets `startMarker: "zeroOrMany"`, `endMarker: "one"`, no label, and the amber warning stroke when index-coverage styling is on. Had both keys carried `ON DELETE CASCADE`, the edge would show `ON DELETE CASCADE`.

Each key's own coverage verdict stays on its `FkDetail.uncovered`; the edge-level "tint this line" question is answered by `fks.some(...)` where it is asked. There is no edge-level `uncovered` field.[^no-edge-level-flag]

### Every diagram except the Explain plan gets stubs

Stubbing is a property of the view, not of a builder, so a diagram opts in by using `JunctionDiagramView`. The dependency, inheritance, role-membership, role-grants, schema-overview, and both schema/database foreign-key diagrams all opt in; their builders need no change beyond dropping the flag, because each already emits at most one edge per endpoint pair and so has nothing to fold.[^non-fk-graphs] The Explain plan diagram keeps plain `DiagramView`.[^explain-excluded]

### The tooltip keeps its bundle logic, fed a flattened list

`fkEdgeTooltip` still renders the same three forms. It builds its `(edge, key)` pair list by flattening each hovered edge's `fks` instead of taking one pair per edge. A hover over a shared stub still reports several edges, so the bundle forms remain reachable and necessary.[^tooltip-flatten]

---

## Public API

All app-internal module exports; nothing is published from a package.

```ts
// frontend/src/data/buildSchemaDiagram.ts

/** One foreign key's own metadata, as carried in FkEdgeData.fks. */
export interface FkDetail {
    columns: string[];      // local FK columns, in key order
    refColumns: string[];   // referenced columns, positionally paired with `columns`
    refSchema: string;
    onUpdate: string;
    onDelete: string;
    /** Set by annotateFkCardinality: this key's local columns lack a covering index. */
    uncovered?: boolean;
}

/** The payload on every FK edge's `data`: every foreign key the edge draws. */
export interface FkEdgeData {
    fks: FkDetail[];
}

export function collapseParallelFkEdges(edges: DiagramEdgeData[]): DiagramEdgeData[];
```

```ts
// frontend/src/data/edgeRouteStubs.ts

/** Distance from a node border to the shared junction, in graph units. */
export const EDGE_STUB_LENGTH: number;

export function stubBundledEdgeRoutes(
    data: DiagramData,
    result: DiagramLayoutResult,
): DiagramLayoutResult;
```

```ts
// frontend/src/dock/JunctionDiagramView.ts
// Callable-class export per COMPONENT_CONVENTIONS (d): call sites may write
// `JunctionDiagramView({ … })` with no `new`, and may `extends` it.

class JunctionDiagramView extends DiagramView {
    protected createEngine(): ElkLayoutEngine;   // returns the stubbing engine
}
```

Unchanged signatures: `buildSchemaDiagram`, `buildDatabaseDiagram`, `annotateFkCardinality`, `applyCoverageStyle`, `fkEdgeTooltip`, `columnEmphasis`.

---

## Internal Structure

### `collapseParallelFkEdges`

```typescript
// Pair key separator, NUL. A Postgres identifier cannot contain NUL, so no
// schema/table name can make two different endpoint pairs produce the same key
// — unlike a printable separator such as `.` or `->`, which a quoted identifier
// is allowed to contain.
const PAIR_KEY_SEPARATOR = "\u0000";

/**
 * Folds edges sharing BOTH endpoints into one edge per (source, target) pair,
 * concatenating their `fks` in first-seen order. The survivor keeps the first
 * folded edge's id, so ids stay unique and stable. Pure — neither the input
 * array nor its edges are mutated.
 *
 * Only for portless (flat-mode) FK edges: an edge anchored to per-column ports
 * has columns, not nodes, as endpoints, so two such edges between the same node
 * pair are not parallel.
 *
 * @param edges - The FK edges to fold, in build order.
 * @returns One edge per (source, target) pair, in first-seen order.
 */
export function collapseParallelFkEdges(edges: DiagramEdgeData[]): DiagramEdgeData[] {
    const byPair = new Map<string, DiagramEdgeData>();

    for (const edge of edges) {
        const key  = `${edge.source}${PAIR_KEY_SEPARATOR}${edge.target}`;
        const kept = byPair.get(key);

        if (!kept) {
            byPair.set(key, edge);
            continue;
        }

        byPair.set(key, {
            ...kept,
            data: {
                fks: [...(kept.data as FkEdgeData).fks, ...(edge.data as FkEdgeData).fks],
            } satisfies FkEdgeData,
        });
    }

    return [...byPair.values()];
}
```

`buildSchemaDiagram`'s return becomes:

```typescript
    if (columnsByTable) {
        applyCardMode(nodes, edges, columnsByTable, structures, tables);
    }

    return {
        nodes,
        // Card mode keeps one edge per FK: its endpoints are per-column ports,
        // so two FKs between the same table pair are not parallel there.
        edges: columnsByTable ? edges : collapseParallelFkEdges(edges),
        layoutOptions: LAYOUT_OPTIONS,
    };
```

`buildDatabaseDiagram` has no card mode, so its return becomes `{ nodes, edges: collapseParallelFkEdges(edges), layoutOptions: LAYOUT_OPTIONS }`.

### The stub rule

A **bundle** is every route endpoint that shares a node, a direction (leaving or arriving), and a node side, counting only endpoints whose model edge names no port on that side. A bundle of one is left untouched. A bundle of two or more gets:

- **A**, the shared anchor: the mean of the bundle's own endpoints. They all sit on one node side, so their mean sits on it too.
- **J**, the shared junction: `A` plus the side's outward normal times `L`, where `L = min(EDGE_STUB_LENGTH, dmin × STUB_CLEARANCE_FRACTION)` and `dmin` is the shortest distance from `A` to any bundle member's next route vertex. The fraction keeps `J` inside every member's own leading run, so a stub can never overshoot a bend.

Each member's endpoint is then moved to `A` and `J` inserted as the adjacent vertex; the rest of the route is untouched.

Worked example — node `A` at `x:0, y:0, w:100, h:60` with three outgoing edges, layout direction RIGHT, so all three leave the east border at `x = 100`:

| Edge | Before: start → first bend | After: start → vertices |
|---|---|---|
| A→B | `(100, 15)` → `(160, 15)` | `(100, 30)` → `(124, 30)` → `(160, 15)` → … |
| A→C | `(100, 30)` → `(160, 200)` | `(100, 30)` → `(124, 30)` → `(160, 200)` → … |
| A→D | `(100, 45)` → `(160, 400)` | `(100, 30)` → `(124, 30)` → `(160, 400)` → … |

The anchor is the mean of the three starts, `(100, 30)`; the nearest next vertex is `(160, 15)` at about 61.8 units, so `L = min(24, 30.9) = 24` and `J = (124, 30)`. All three edges now draw the identical 24-unit segment `(100,30) → (124,30)` and diverge after it: one line leaves, then splits.

The arrival side mirrors it. Node `E` at `x:1000, y:0, w:100, h:60` with three incoming edges on its west border and last bends at `x = 940` gets `A = (1000, 30)`, normal `(-1, 0)`, `J = (976, 30)`, and every route ends `… → (976, 30) → (1000, 30)` — many lines merge, one arrives.

### Constants

```typescript
/**
 * Distance from a node's border to the shared junction, in graph units. The
 * longest crow's-foot marker (`zeroOrMany`) is 18 units long and is drawn
 * backwards from the arrival vertex, so a shared arriving run shorter than that
 * would let the marker spill past the junction into the fanned-out lines; 24
 * clears it with a margin while staying far below the 120-unit minimum layer gap
 * the schema diagrams use, so the junction reads as "at the node" rather than
 * "somewhere in the gap".
 */
export const EDGE_STUB_LENGTH = 24;

/**
 * Fraction of the shortest leading run a junction may consume. A half keeps the
 * junction strictly inside every bundle member's own first segment, so a stub on
 * a short edge (adjacent layers, or two overlapping nodes) can never reach past
 * a bend and double the route back on itself.
 */
const STUB_CLEARANCE_FRACTION = 0.5;

/**
 * How far off a node's border an endpoint may sit and still count as anchored to
 * it. ELK reports fractional coordinates, so an exact equality test would reject
 * real anchors; anything farther than half a unit from all four borders is not a
 * border anchor and is left alone.
 */
const BOUNDARY_EPSILON = 0.5;
```

### `stubBundledEdgeRoutes`

Structure, one nameable step per function:

| Function | Responsibility |
|---|---|
| `stubBundledEdgeRoutes(data, result)` | orchestrates: index nodes and model edges, collect bundles, rewrite, return a new result |
| `sideOfPoint(point, rect)` | which border a point sits on (`"west"`/`"east"`/`"north"`/`"south"`), or `null` beyond `BOUNDARY_EPSILON` |
| `outwardNormal(side)` | the unit vector pointing out of that side |
| `collectBundles(data, result, rectById)` | groups endpoints into `Map<bundleKey, BundleMember[]>`, skipping ported endpoints, self-loops, and nodes with no rect |
| `junctionFor(members)` | the `{ anchor, junction }` pair for one bundle, per the rule above |
| `withStub(sections, end, anchor, junction)` | a new section array with the endpoint moved and the junction inserted |

`data` supplies each edge's `sourcePort` / `targetPort` and `source` / `target`; `result.nodes` supplies every node's absolute rect; `result.edges` supplies the routes. The returned object is new throughout — `result` and its sections are never mutated — and `nodes`, `width`, and `height` pass through unchanged.[^bbox-unchanged]

Self-loops (`edge.source === edge.target`) are excluded entirely: pulling both of a loop's endpoints to one anchor would collapse it to zero area.

An edge's source side uses the **first** section's `startPoint`, its target side the **last** section's `endPoint`.

### `JunctionDiagramView`

```typescript
class JunctionLayoutEngine extends ElkLayoutEngine {
    async layout(
        data: DiagramData,
        sizes: Map<string, { width: number; height: number }>,
        defaults?: Record<string, string>,
    ): Promise<DiagramLayoutResult> {
        return stubBundledEdgeRoutes(data, await super.layout(data, sizes, defaults));
    }
}

class JunctionDiagramView extends DiagramView {
    /**
     * Builds the stubbing layout engine. A plain prototype method, not an arrow
     * field: `DiagramView`'s constructor calls `createEngine()` (DiagramView.ts:266),
     * so an arrow field would not exist yet — and for the same reason this
     * override must read nothing off `this`, which is why the worker factory
     * comes from the shared module rather than from the view's own options.
     */
    protected createEngine(): ElkLayoutEngine {
        return new JunctionLayoutEngine({ workerFactory: elkWorkerFactory });
    }
}
```

---

## Ordered Implementation Steps

All paths are relative to the repo root; unit tests run from `frontend/`.

### Phase A — drop `mergeEdges` (red-green)

1. Change the assertions that expect the option to expect its absence: `tests/data/buildSchemaDiagram.test.ts` lines **103** and **124** (drop the `"elk.layered.mergeEdges": "true"` entry from both `toEqual` maps), `tests/data/buildDatabaseDiagram.test.ts` line **133** (same), `tests/data/buildRoleGrantsDiagram.test.ts` line **66** (same; retitle the test at line 60 to drop "with merged edges"), `tests/data/buildRoleMembershipDiagram.test.ts` line **84** (delete that `expect`). Replace the card-mode test at `tests/data/buildSchemaDiagram.test.ts` **150-161** with one titled "card mode and flat mode share one layout-options map" that builds both graphs from the same tables and asserts `expect(card.layoutOptions).toBe(flat.layoutOptions)` — object identity, pinning that only one map survives. Run `npm test`: the four `toEqual` assertions and the new identity test must fail (five failures).
2. `src/data/buildSchemaDiagram.ts`: delete `FLAT_LAYOUT_OPTIONS` and its comment (**26-36**), return `layoutOptions: LAYOUT_OPTIONS` for both modes (**128**), and drop the two merging sentences from the `@returns` (**80-82**).
3. Delete the `"elk.layered.mergeEdges": "true"` entry and the `mergeEdges` sentences from the comment above it in `src/data/buildDatabaseDiagram.ts` (**18-20**, **24**), `src/data/buildRoleGrantsDiagram.ts` (**12-14**, **18**), `src/data/buildRoleMembershipDiagram.ts` (**11-13**, **17**). Keep each map's `elk.algorithm` / `elk.direction` entries and the first paragraph of each comment.
4. `src/SqlAdminController.ts`: drop the option from `DEPENDENCY_LAYOUT` (**197**) and `INHERITANCE_LAYOUT` (**202**), and the `mergeEdges` sentences from their comments (**194-196**, **200-201**).
5. Delete the `it("does not merge edges: …")` block at `tests/data/buildExplainDiagram.test.ts` **52-58** — with the option gone from every builder, a test pinning its absence in one of them says nothing. The repo-wide grep in step 25 replaces it.
6. **Checkpoint**: `grep -rn 'mergeEdges' frontend/src frontend/tests` → zero. `cd frontend && npm run typecheck && npm test` → green.

### Phase B — reshape the edge payload (red = typecheck)

This phase is a straight port with no behaviour change: wherever the old code read a flat field off `FkEdgeData`, read it off `fks[0]`. Phase D generalizes it.

7. `src/data/buildSchemaDiagram.ts`: replace the `FkEdgeData` interface (**48-62**) with `FkDetail` + `FkEdgeData` from `## Public API`, each with its own JSDoc. In the edge-building loop (**105-120**) wrap the five fields as `data: { fks: [{ … }] } satisfies FkEdgeData`. In `applyCardMode`'s port loop (**172-188**) read the single key once — `const fk = (edge.data as FkEdgeData).fks[0];` — then `fk.columns[0]` / `fk.refColumns[0]`.
8. `src/data/buildDatabaseDiagram.ts`: wrap its edge payload the same way (**112-118**).
9. `src/data/fkCardinality.ts`: import `FkDetail` alongside `FkEdgeData`; port `annotateFkCardinality` (**269-284**) to read `fkData.fks[0]` for `unique` / `mandatory` / `label` and to write `data: { fks: [{ ...fkData.fks[0], uncovered: !covered }] }`; port `applyCoverageStyle` (**303**) to `show && fkData?.fks?.some(fk => fk.uncovered) === true`. Both optional chains are load-bearing: `fkData` is absent on an edge with no `data`, and `fks` is absent on a non-foreign-key graph's edge.
10. `src/data/columnEmphasis.ts`: `fkData?.refColumns[0]` → `fkData?.fks[0]?.refColumns[0]` (**74**) and `fkData?.columns[0]` → `fkData?.fks[0]?.columns[0]` (**84**).
11. `src/data/fkEdgeTooltip.ts`: `FkEdgePair.fk` becomes `FkDetail` (**22-25**); `isFkEdgeData` narrows on `Array.isArray(data.fks)` (**36-38**); the pair list (**151-153**) takes `edge.data.fks[0]`.
12. Migrate the fixtures — expected values do **not** change, only the shape of the `data` objects: `tests/data/buildSchemaDiagram.test.ts` **49-55** and **71-77**; `tests/data/buildDatabaseDiagram.test.ts` **66-73**; `tests/data/columnEmphasis.test.ts` `fkData` helper **8-9**; `tests/data/fkCardinality.test.ts` `fkGraph` **139-146**, the three `.uncovered` reads at **204**, **211**, **235** (→ `.fks[0].uncovered`), and `uncoveredEdge` / `coveredEdge` **250-264**; `tests/data/fkEdgeTooltip.test.ts` `fkEdge` helper **7-21** (keep its `overrides` parameter, retyped to `Partial<FkDetail>`, wrapped into `{ fks: [ … ] }`).
13. **Checkpoint**: `cd frontend && npm run typecheck && npm test` → green, every assertion's expected value identical to before this phase.

### Phase C — fold parallel foreign keys (red-green)

14. Add tests, then the code:
    - `tests/data/buildSchemaDiagram.test.ts`: two keys `a → b` fold into one edge whose id is the first one's and whose `data.fks` holds both in declaration order; `a → b` plus `a → c` stay two edges; `a → c` plus `b → c` stay two edges; `a → b` plus `b → a` stay two edges; two self-referential keys on `a` fold into one; **card mode does not fold** — the same two-key input with `columnsByTable` still yields two edges, each with one key and its own ports.
    - `tests/data/buildDatabaseDiagram.test.ts`: two keys from `a.orders` to `b.customers` fold into one edge with two keys; the existing tests at **108-123** stay green unchanged, since those are different pairs.
    - Run `npm test`: the new tests must fail.
15. Add `PAIR_KEY_SEPARATOR` and `collapseParallelFkEdges` to `src/data/buildSchemaDiagram.ts`, placed after `buildSchemaDiagram` and before `applyCardMode`; switch the return to `edges: columnsByTable ? edges : collapseParallelFkEdges(edges)` with the comment from `## Internal Structure`; update the `@returns` to say flat mode folds parallel foreign keys while card mode does not. Import the helper in `src/data/buildDatabaseDiagram.ts`, wrap its return, extend its `@returns`. Run `npm test` → green.

### Phase D — combining rules for a folded edge (red-green)

16. `tests/data/fkCardinality.test.ts`: add a two-key `fkGraph` variant and tests for — the start marker drops to `zeroOrMany` when one key is unique-and-mandatory and the other is neither; `uncovered` is set per key, so a covered + uncovered pair yields `[false, true]`; `applyCoverageStyle(…, true)` tints an edge with one uncovered key among two; the label is omitted when the two keys' labels differ and kept when they match. Run `npm test`: these must fail (step 9's port reads `fks[0]` only).
17. `src/data/fkCardinality.ts`: add `agreedReferentialActionLabel` — `const labels = new Set(fks.map(fk => referentialActionLabel(fk.onUpdate, fk.onDelete))); return labels.size === 1 ? [...labels][0] : undefined;` — and switch `annotateFkCardinality`'s body to map `uncovered` per key while computing `unique` / `mandatory` with `every`. Update the module header comment (**1-7**) and the function's JSDoc to state the three combining rules. Run `npm test` → green.

### Phase E — tooltip flattening (red-green)

18. `tests/data/fkEdgeTooltip.test.ts`: add tests for — one hovered edge with two keys renders the `"2 references to …"` bundle listing both source column lists; one hovered edge with two keys whose `refColumns` differ renders the `"N foreign keys here"` form with both full headers; a covered + uncovered pair prints `No covering index` under the uncovered one only; two hovered edges carrying two keys each produce four detail lines. Run `npm test`: these must fail.
19. `src/data/fkEdgeTooltip.ts`: switch the pair list to `edges.flatMap(edge => isFkEdgeData(edge.data) ? edge.data.fks.map((fk): FkEdgePair => ({ edge, fk })) : [])`; update the module header comment (**1-7**) and `fkEdgeTooltip`'s JSDoc to say the pairs come from every hovered edge's every folded key, in hover order then declaration order; retitle `shareOneTarget`'s doc line (**95**) from "a genuine merged ELK trunk" to "every pair referencing the same node on the same columns". Run `npm test` → green.

### Phase F — the stub geometry (red-green)

20. Create `tests/data/edgeRouteStubs.test.ts` covering every case in `## Expected Behaviour → stub geometry`, including the worked fan-out and fan-in examples from `## Internal Structure` with their exact numbers. Run `npm test`: all fail (no module yet).
21. Create `src/data/edgeRouteStubs.ts` with the constants and the six functions from `## Internal Structure`. Its only imports are `import type { DiagramData, DiagramLayoutResult, ElkEdgeSection, ElkPoint } from "@jimka/typescript-ui/component/diagram";` — types only, so the node vitest environment stays DOM-free. Head the file with a purity comment in the style of `fkCardinality.ts:1-7`. Run `npm test` → green.

### Phase G — install the stubbing view

22. Create `src/dock/JunctionDiagramView.ts` with `JunctionLayoutEngine` (module-private) and `JunctionDiagramView` from `## Internal Structure`, exported through `callable()` per COMPONENT_CONVENTIONS (d). Import `elkWorkerFactory` from `./elkWorkerFactory` and `stubBundledEdgeRoutes` from `../data/edgeRouteStubs`.
23. Point the three subclassing panels at it: `src/dock/SchemaDiagramPanel.ts` (**25**), `src/dock/RelationGraphPanel.ts` (**54**), `src/dock/RoleGrantsDiagramPanel.ts` (**35**) each change `extends DiagramView` to `extends JunctionDiagramView` and swap the import. Their `super({ … })` option bags stay exactly as they are.
24. Point the three value-construction panels at it: `src/dock/RelationDiagramPanel.ts` (**89**), `src/dock/RootedRelationGraphPanel.ts` (**56**), `src/dock/DatabaseDiagramPanel.ts` (**87**) each change `DiagramView({ … })` to `JunctionDiagramView({ … })` and swap the import. Leave `src/dock/ExplainDiagramPanel.ts` (**166**) on `DiagramView`.
25. **Grep invariants**: `grep -rn 'mergeEdges' frontend/src frontend/tests` → zero; `grep -rn 'FLAT_LAYOUT_OPTIONS' frontend/` → zero; `grep -rn 'nodeSize\|portPort' frontend/src` → zero; `grep -rn 'extends DiagramView\|DiagramView({\|new DiagramView' frontend/src/dock/` → exactly two matches, `JunctionDiagramView.ts` (`extends DiagramView`) and `ExplainDiagramPanel.ts` (`new DiagramView`).
26. **Checkpoint**: `cd frontend && npm run typecheck && npm test` → all green.
27. **Manual verification**: work through `## Expected Behaviour → manual-verify`.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Create | `frontend/src/data/edgeRouteStubs.ts` |
| Create | `frontend/tests/data/edgeRouteStubs.test.ts` |
| Create | `frontend/src/dock/JunctionDiagramView.ts` |
| Modify | `frontend/src/data/buildSchemaDiagram.ts` (`FkDetail`/`FkEdgeData`, `collapseParallelFkEdges`, drop `FLAT_LAYOUT_OPTIONS`) |
| Modify | `frontend/src/data/buildDatabaseDiagram.ts` (drop `mergeEdges`, wrap payload, fold) |
| Modify | `frontend/src/data/buildRoleGrantsDiagram.ts` (drop `mergeEdges`) |
| Modify | `frontend/src/data/buildRoleMembershipDiagram.ts` (drop `mergeEdges`) |
| Modify | `frontend/src/SqlAdminController.ts` (drop `mergeEdges` from both layout constants) |
| Modify | `frontend/src/data/fkCardinality.ts` (per-key coverage, combining rules) |
| Modify | `frontend/src/data/fkEdgeTooltip.ts` (flattened pair list) |
| Modify | `frontend/src/data/columnEmphasis.ts` (read through `fks[0]`) |
| Modify | `frontend/src/dock/SchemaDiagramPanel.ts` (base class) |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` (base class) |
| Modify | `frontend/src/dock/RoleGrantsDiagramPanel.ts` (base class) |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` (view construction) |
| Modify | `frontend/src/dock/RootedRelationGraphPanel.ts` (view construction) |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` (view construction) |
| Modify | `frontend/tests/data/buildSchemaDiagram.test.ts` |
| Modify | `frontend/tests/data/buildDatabaseDiagram.test.ts` |
| Modify | `frontend/tests/data/buildRoleGrantsDiagram.test.ts` |
| Modify | `frontend/tests/data/buildRoleMembershipDiagram.test.ts` |
| Modify | `frontend/tests/data/buildExplainDiagram.test.ts` (delete the `mergeEdges` test) |
| Modify | `frontend/tests/data/fkCardinality.test.ts` |
| Modify | `frontend/tests/data/fkEdgeTooltip.test.ts` |
| Modify | `frontend/tests/data/columnEmphasis.test.ts` |

---

## Expected Behaviour

### Unit-testable — stub geometry (`frontend/tests/data/edgeRouteStubs.test.ts`)

- **The fan-out worked example** from `## Internal Structure` produces exactly the "after" column: all three routes start at `(100, 30)`, all three carry `(124, 30)` as their first bend, and each keeps its own remaining vertices.
- **The fan-in worked example** produces `… → (976, 30) → (1000, 30)` on all three routes.
- **A bundle of one is untouched** — a node with a single outgoing edge returns a route deeply equal to the input.
- **A short edge caps the stub**: when the nearest next vertex is 30 units from the anchor, `L` is 15, not `EDGE_STUB_LENGTH`.
- **The cap uses the bundle minimum**: with next vertices at 30 and 400 units, every member gets `L = 15`.
- **A ported endpoint never bundles**: two edges leaving one node, both with `sourcePort` set, return unchanged routes; so does a mix of one ported and one portless edge (the portless one is alone in its bundle).
- **Sides are kept apart**: two edges leaving a node's east border and one leaving its west border yield a stub for the east pair only, and the west edge is untouched.
- **Direction is kept apart**: an incoming and an outgoing endpoint on the same side of the same node do not bundle together.
- **A self-loop is untouched**, even when other edges bundle at the same node.
- **A node absent from `result.nodes`** leaves its edges untouched rather than throwing.
- **An endpoint farther than `BOUNDARY_EPSILON` from every border** is left alone.
- **Purity**: the input `result`, its edge objects, and its section objects are not mutated (assert by deep-equality against a snapshot taken before the call); `nodes`, `width`, and `height` are passed through by value.
- **A DOWN layout works**: three edges leaving a node's south border stub downward, proving nothing assumes east/west.

### Unit-testable — folding and annotations

`collapseParallelFkEdges` / `buildSchemaDiagram` flat mode, with `a`, `b`, `c` as tables:

| Input foreign keys | Output edges | Notes |
|---|---|---|
| `a.fk1 → b`, `a.fk2 → b` | one, id `a.fk1` | `data.fks` holds both, `fk1` first |
| `a.fk1 → b`, `a.fk2 → c` | two | different targets |
| `a.fk1 → c`, `b.fk1 → c` | two | different sources; ids stay `a.fk1`, `b.fk1` |
| `a.fk1 → b`, `b.fk1 → a` | two | the pair is ordered |
| `a.fk1 → a`, `a.fk2 → a` | one, id `a.fk1` | self-loops fold like any other pair |
| none | none | an empty schema returns an empty edge list |

- The input array and its edge objects are not mutated: after a fold the first input edge still has one key, and the output edge is a different object.
- No builder's `layoutOptions` carries `elk.layered.mergeEdges` — absent, not `"false"`.
- Card mode: the same two-key input yields **two** edges, each with one key and its own `sourcePort`/`targetPort`; node `data`, `width`, `height`, `layoutOptions`, and `ports` are unchanged from today.
- `buildDatabaseDiagram`: two keys between the same qualified pair fold into one; a self-loop and another table's key into that same target stay two edges.

`annotateFkCardinality` on a two-key edge (source table `child`):

| Key 1 | Key 2 | `startMarker` | `fks[*].uncovered` | `style.label` |
|---|---|---|---|---|
| unique, mandatory, covered, `ON DELETE CASCADE` | non-unique, optional, uncovered, no label | `zeroOrMany` | `[false, true]` | absent |
| non-unique, mandatory, covered, `ON DELETE CASCADE` | non-unique, mandatory, covered, `ON DELETE CASCADE` | `oneOrMany` | `[false, false]` | `ON DELETE CASCADE` |

- `endMarker` is always `"one"`; a single-key edge produces exactly today's markers, label, and coverage verdict; the input `DiagramData` is not mutated; an edge whose source table is missing from the positional arrays is still returned without cardinality style.

`applyCoverageStyle`: `show: true` tints an edge when **any** key is uncovered and leaves an all-covered edge's stroke unset; `show: false` strips the stroke; an edge whose `data` has no `fks` is returned untouched rather than throwing.

`fkEdgeTooltip`: one hovered edge with one key gives today's text unchanged; one edge with two keys sharing `refColumns` gives `2 references to addresses(id)` plus one `source(columns)` line per key; two keys with different `refColumns` give `2 foreign keys here` plus full headers; two hovered edges with two keys each give four detail lines; `No covering index` prints only under an uncovered key; the eight-line cap and `…and N more` still apply; an edge whose `data` lacks `fks` contributes nothing and an all-non-foreign-key payload returns `null`.

`columnEmphasis`: unchanged `edgeIds` and per-node highlighted columns on card-mode graphs.

### Manual-verify — needs the real app, ELK, and a browser

Log in with Host `sqladmin-db` under Docker Compose, or `localhost` when the backend runs natively. The folding case needs a table pair with two foreign keys between it; if the connected database has none, add one and drop it afterwards:

```sql
ALTER TABLE public.orders ADD COLUMN alt_customer_id integer;
ALTER TABLE public.orders ADD CONSTRAINT fk_alt_customer
    FOREIGN KEY (alt_customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
```

| Screen | How to open | What to look for |
|---|---|---|
| Schema diagram, `hub` | right-click the schema → "Open schema diagram" | every fan-out splits within a couple of node-widths of its source — no bundle runs a large fraction of the canvas; the canvas is no wider than before |
| Schema diagram, fan-in | the same diagram | several tables referencing one table converge just before it, and a single line touches the target |
| Schema diagram, folding | the schema holding the pair above | the two `orders → customers` keys draw one line; hovering it lists both with their own columns; no `ON DELETE CASCADE` label while the two disagree |
| Relation diagram, column cards | right-click a table → "Show relations" | **unchanged**: per-column anchors, no stub, column-click emphasis and the Depth / hide controls still work |
| Role membership graph | a role's membership action | member edges converge before a shared parent; the `admin` labels stay separated, not stacked |
| Role grants graph | a role's grants action | the fan-out to granted tables leaves the role through one short shared run and then splits; the per-table privilege labels stay legible |
| Dependency graph | right-click a schema → dependency graph | views depending on one table converge just before it; edges stay dashed; none dropped |
| Inheritance graph | right-click a schema → inheritance graph | a partitioned parent's edges leave through one short run *below* the parent, proving the DOWN direction stubs on the right side |
| Database diagram, Tables mode | the database diagram → Mode "Tables" | cross-schema edges still cross the schema boxes, none dropped, and their stubs sit at the leaf tables rather than at a container border |
| Database diagram, Overview mode | the diagram's default mode | a schema with edges to several others fans out through one short run |
| Explain diagram | run a query with EXPLAIN, open the diagram | **unchanged**: every child keeps its own arrowhead and its own row-count label |

On every screen: pan, zoom, zoom-to-fit, selection, and double-click activation still work; every diagram draws its edges on first open; edge-emphasis (click a card column in the relation diagram) still dims the right lines; and the console is free of ELK errors. Re-run one layout twice (change the depth, then change it back) and confirm the junctions land in the same places.

---

## Verification

- **App typecheck**: `cd frontend && npm run typecheck`.
- **App unit tests**: `cd frontend && npm test`. `tests/data/groupBySchema.test.ts`, `tests/data/relationDiagram.test.ts`, `tests/data/buildRelationGraph.test.ts`, and `tests/data/schemaOverviewDiagram.test.ts` must stay green **without edits** — evidence that the graph-shaping modules were not disturbed.
- **Grep invariants**: the four greps in step 25.
- **No library work**: nothing under `/home/jika/typescript/typescript-ui` is edited, so no `npm run build:lib` and no docs-app test run.
- **Manual smoke**: the table in `## Expected Behaviour → manual-verify`, including the re-layout stability check.

---

## Documentation Impact

- No library change, so no library doc page, catalog entry, sidebar entry, or `llms.txt` edit. The `elk.layered.mergeEdges` mentions in [../typescript-ui/packages/lib/docs/components/DiagramView.md:160](../typescript-ui/packages/lib/docs/components/DiagramView.md#L160) and the library changelog cite the option only as *an example* of edges sharing a route, which stays accurate whichever way this app routes.
- The app has no documentation pages for the diagram layer; each module's contract lives in its own header comment and JSDoc, updated by steps 2, 7, 9, 15, 17, 19, 21, and 22.
- `frontend/COMPONENT_CONVENTIONS.md` needs no edit: `JunctionDiagramView` follows conventions (a), (c), (d), and (e) as written, and adds no new pattern.
- No `CHANGELOG.md` entry and no version bump — the coordinated 0.3.0 release is a separate step.

---

## Potential Challenges

- **Differing crow's-foot markers stack at a fan-out anchor.** A node's outgoing foreign keys can carry different start markers, and one line leaving the node means one point for all of them to sit at. This is inherent to the requested rule and is what the diagram already does today; the per-edge detail stays reachable through the hover tooltip and through the card-mode relation diagram, which is never stubbed. The arrival side is unaffected: `endMarker` is always `"one"`, so a fan-in stacks identical glyphs.
- **Hovering a stub reports every edge in the bundle.** That is why `fkEdgeTooltip`'s bundle forms are kept. Confirm by eye that hovering a fan-in stub lists all the arriving keys.
- **Edge labels sit at the polyline's halfway point** ([DiagramEdgeLayer.ts:145-152](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L145)), so a stub shifts each label by at most `EDGE_STUB_LENGTH`. Because bundled routes still diverge in the middle, their midpoints stay distinct and labels do not stack — checked on the two labelled graphs in the manual table.
- **`createEngine()` runs inside `DiagramView`'s constructor** ([DiagramView.ts:266](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L266)). The override must be a plain prototype method that reads nothing off `this`; an arrow-function field would not exist yet, and `this._options` is private to the base. This is the super-cascade trap from COMPONENT_CONVENTIONS (b) in a new place.
- **A panel left on plain `DiagramView` silently gets no stubs.** Step 25's grep is the guard: only `ExplainDiagramPanel` may still name `DiagramView` as a base or constructor.
- **A degenerate bundle** — two nodes overlapping, so the nearest next vertex is a fraction of a unit away — produces a stub too short to see. That is graceful degradation, not a failure; the clamp is what keeps it from drawing a route that doubles back.

---

## Critical Files

- [../typescript-ui/packages/lib/src/typescript/lib/component/diagram/ElkLayoutEngine.ts:310-340](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/ElkLayoutEngine.ts#L310) — `mapElkResult`: the exact `DiagramLayoutResult` shape the transform rewrites, including that section coordinates are lifted to absolute graph space and node rects are flattened absolute.
- [../typescript-ui/packages/lib/src/typescript/lib/component/diagram/ElkLayoutEngine.ts:451-465](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/ElkLayoutEngine.ts#L451) — `layout(data, sizes, defaults)`: the public method the app subclass overrides, and the source of the `DiagramData` the transform needs for port lookups.
- [../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts:266](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L266) and [:314-321](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L314) — where the engine is built and the `protected createEngine()` seam it is built through, documented as the swappable-engine seam.
- [../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts:100-127](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L100) — `MARKER_GEOMETRY`: the marker lengths and `refX` that set `EDGE_STUB_LENGTH`'s lower bound.
- [frontend/src/data/fkCardinality.ts:1-7](frontend/src/data/fkCardinality.ts#L1) — the purity comment every new pure module in `data/` copies.
- [frontend/src/data/schemaCardModel.ts](frontend/src/data/schemaCardModel.ts) — the in-repo precedent for pure *geometry* living in `data/` with its own unit tests.
- [frontend/src/data/buildSchemaDiagram.ts:143-217](frontend/src/data/buildSchemaDiagram.ts#L143) — `applyCardMode`: the per-column port anchoring that the portless rule protects.
- [frontend/src/dock/SchemaDiagramPanel.ts:25](frontend/src/dock/SchemaDiagramPanel.ts#L25) — the smallest of the three subclassing panels; the pattern the other two follow.
- [frontend/src/dock/elkWorkerFactory.ts](frontend/src/dock/elkWorkerFactory.ts) — the shared worker factory the engine override must use instead of reading the view's options.
- [frontend/COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) — sections (b), (c), (d), and (e) all bear on `JunctionDiagramView`.

---

## Non-Goals

- **Any library change.** No source, no docs, no rebuild.
- **Making ELK place the junction.** No new layout option is added, and no invisible junction node enters any graph.
- **Node growth or port spacing** (`elk.nodeSize.constraints`, `elk.nodeSize.minimum`, `elk.spacing.portPort`, `elk.portConstraints: FIXED_SIDE`). None is set today and none is added.
- **Tuning any spacing value.** `elk.spacing.nodeNode`, `elk.layered.spacing.nodeNodeBetweenLayers`, `elk.spacing.edgeEdge`, and `elk.spacing.edgeNode` stay as they are; the only new numbers are the three constants in `edgeRouteStubs.ts`.
- **Stubbing the Explain plan diagram**, or changing `buildExplainDiagram` beyond deleting the now-meaningless `mergeEdges` assertion in its test.
- **Changing card-mode behaviour.** Its edges, ports, node sizes, and geometry stay as they are, and the portless rule keeps stubs away from them; the only card-mode edit is reading the foreign-key payload through `fks[0]`. Card geometry is the sibling `table-card-geometry-and-tooltip` plan's scope.
- **Drawing a visible dot at a junction.** The junction is a shared vertex, not a marker.
- **Making the stub length user-configurable.** It is a fixed rendering constant, like the card geometry.
- **Naming the folded constraints in the tooltip.** `FkDetail` carries no constraint name and gains none; each folded key is identified by its column list.
- **Any version bump, changelog entry, or publish step.**

---

## Implementation Notes

### Construction-site adaptation for the post-drift shell shape

This plan predates `plans/implemented/diagram-shell-optional-root.md`, which already
unified `SchemaDiagramPanel`, `RelationGraphPanel`, `RoleGrantsDiagramPanel`,
`RelationDiagramPanel`, `RootedRelationGraphPanel`, and `DatabaseDiagramPanel` onto one
shared `DiagramShell` (`frontend/src/dock/diagramShell.ts`). By the time this plan landed,
none of the six panels bare-`extends DiagramView` (or bare-constructs it) the way `## Ordered
Implementation Steps` 23–24 describe; each builds its `DiagramView`/`JunctionDiagramView`
instance as a local `const view = …` and hands it to the shell via `super({ view, … })`.
The intent — swap every non-Explain construction site from `DiagramView` to
`JunctionDiagramView` — carried over exactly; only the mechanical shape of "where the
construction call lives" changed. All six sites were updated on that basis:
`SchemaDiagramPanel.ts:51`, `RelationGraphPanel.ts:77`, `RoleGrantsDiagramPanel.ts:63`,
`RelationDiagramPanel.ts:90`, `RootedRelationGraphPanel.ts:57`, `DatabaseDiagramPanel.ts:86`.
The plan's step-25 grep for "exactly two matches" of `extends DiagramView`/`DiagramView({`/`new
DiagramView` in `frontend/src/dock/` is, taken completely literally, no longer exact: the
pattern `DiagramView({` is a substring of every `JunctionDiagramView({` call site too, so a
plain rerun reports more than two hits. The grep's *intent* — no panel other than
`ExplainDiagramPanel` touches the bare `DiagramView` — was checked instead by inspecting
`frontend/src/dock/*.ts` directly: `JunctionDiagramView.ts:52` (`class JunctionDiagramView
extends DiagramView`) and `ExplainDiagramPanel.ts:166` (`new DiagramView({`) are the only two
places the bare class is named as a value; every other file's mentions are comments or a
`DiagramShellConfig`/`attachFkEdgeTooltip` type annotation, which is correct since a
`JunctionDiagramView` instance is a `DiagramView`.

### `elkWorkerFactory` dropped from every switched panel's option bag

Steps 23–24 say each panel's `super({ … })`/construction option bag "stays exactly as they
are" apart from the class swap. That held for every option except `elkWorkerFactory`: the
plan's own `## Internal Structure` design for `createEngine()` (the super-cascade trap)
already has `JunctionLayoutEngine` hardcode `workerFactory: elkWorkerFactory` from the shared
module rather than reading `this._options.elkWorkerFactory` — so on a `JunctionDiagramView`
that option is inert by the plan's own design, not by an implementation shortcut. Passing a
dead option at every one of six call sites would read as though it did something, so it was
removed from all six instead of carried over unused. `JunctionDiagramView.ts`'s class-level
JSDoc now states this explicitly (`elkWorkerFactory`/`elkWorkerUrl` are the one exception to
"every construction option is identical to `DiagramView`").

### Manual verification actually performed

Backend was already running on `:8000` and Postgres in Docker on `:5432`; logged in with Host
`localhost` (native backend, not the Compose `sqladmin-db` network), Database `sqladmin`. A
dedicated `--strictPort` Vite dev server for this worktree ran on `:5178` (`:5173`, `:5174`,
`:5177` were already in use by other worktrees), driven with the chrome-devtools MCP tools.

- **The sharpest check — junction geometry on `hub`'s flat schema diagram (154 tables).**
  Opened via the schema right-click menu → "Schema diagram". Extracted every distinct rendered
  edge route from `.DiagramEdgeLayer`'s `<path>` elements (`evaluate_script` against the live
  DOM): 1808 `<path>` elements collapse to **904 distinct routes**, each drawn exactly twice
  (an invisible hit-test stroke plus the visible stroke — a pre-existing per-edge duplication,
  not a merge artifact); no route is shared by 3+ edges, so the coincident-route defect is
  gone. Grouping routes by rounded start point (fan-out bundles) and separately by rounded end
  point (fan-in bundles) and walking each bundle's members index-by-index to the first vertex
  where they diverge: across all 152 multi-member bundles found each way, the **longest shared
  run measured was exactly 24 units — `EDGE_STUB_LENGTH`** — versus the plan's documented
  pre-fix baseline of up to 33,424px on the same schema. Most bundles' shared run was
  considerably shorter (down to ~7 units) where `STUB_CLEARANCE_FRACTION` clamped it. No ELK
  console errors; the only console message across the session was the pre-existing unrelated
  `favicon.ico` 404.
- **Edge-hover tooltip.** Organically observed while interacting with the diagram (before a
  root was chosen): hovering an edge showed `"crm_ledger_entry(workorder_id) →
  workorders(id)\nNo covering index"` — the single-edge form with the coverage line, rendering
  correctly against the new `{ fks: [...] }` payload shape.
- **Card mode unaffected.** Right-click → "Show relations" on `hub.asset_document` opened the
  card-mode relation diagram: cards render with per-column rows and FK badges, and each
  column-to-column edge visibly enters/leaves its own row with no visible junction or shared
  run between differently-anchored edges — confirming the portless rule keeps card mode
  exactly as it was.
- **Not manually driven this run:** the folding case specifically (adding the two-FK-into-
  `addresses` example from the manual-verify table and confirming the tooltip's bundle form
  and the absent `ON DELETE` label live), the role-membership graph, the role-grants graph, the
  dependency graph, the inheritance graph, the database diagram's Tables/Overview modes, and
  the Explain plan diagram. These share the same `stubBundledEdgeRoutes`/`JunctionDiagramView`
  code path already exercised live above and are additionally covered by unit tests
  (`tests/data/buildRoleMembershipDiagram.test.ts`, `tests/data/buildRoleGrantsDiagram.test.ts`,
  `tests/data/buildRelationGraph.test.ts`, `tests/data/buildDatabaseDiagram.test.ts`,
  `tests/data/buildExplainDiagram.test.ts`), but were not independently driven in the browser
  this run. A `git worktree list` / `docker compose ps` check at the time of writing showed the
  browser session shared with at least one other concurrent worktree's automation (a second
  page's URL changed mid-session to another worktree's dev-server port), which limited how much
  further interactive driving was practical without risking cross-talk with that other session.

---

## Notes

[^no-elk-knob]: Read out of the installed `frontend/node_modules/elkjs/lib/elk.bundled.js` (elkjs 0.12.0), whose registry holds 334 `org.eclipse.elk.*` ids. The only merge-related inputs are `org.eclipse.elk.layered.mergeEdges` and `org.eclipse.elk.layered.mergeHierarchyEdges`, both plain booleans with no distance parameter. `org.eclipse.elk.junctionPoints` and `org.eclipse.elk.bendPoints` are outputs, not inputs — the bundle contains the algorithm *writing* `junctionPoints` onto an edge during result export. The remaining candidates are spacings between routed things (`spacing.edgeEdge`, `spacing.edgeNode`, `layered.spacing.edgeEdgeBetweenLayers`, `layered.spacing.edgeNodeBetweenLayers`) and edge-routing styles (`edgeRouting`, the polyline/spline sub-options), none of which controls where a merged bundle diverges. The observed split point is a consequence of how far the nearest target is: merged edges share their long-edge dummy chain for as long as they travel together, so the bundle separates at the layer of its closest member — which is why one eight-edge group split after 25px and another ran 25,000px.

[^mechanism-choice]: Inserting an invisible junction node per bundle was rejected on four counts. (1) **It corrupts the app's own model.** Every pure graph module walks `data.edges` by endpoint id — `reachableNodeIds`, `hiddenNeighbourCounts`, `subgraph`, and `applyHide` in [relationDiagram.ts](frontend/src/data/relationDiagram.ts), plus `columnEmphasis` and the node counts the controller puts in the status bar. A junction node would appear as a neighbour, break the depth badges, and split one foreign key into two model edges. (2) **The crow's-foot markers land on the wrong thing**, since the real edge's target becomes the junction rather than the table. (3) **It changes the layout itself**: a junction takes a layer, pushing every downstream node one layer out, which widens a canvas already about 36,000px across, and adding or removing one edge can reshuffle layer assignment so junction placement shifts under small graph changes. (4) It is *more* invasive for the same result — the route rewrite touches no builder output and no graph traversal, and is a deterministic function of ELK's own output, so identical graphs give identical junctions.

[^engine-seam]: The seam is public and documented. `DiagramView.createEngine()` is `protected` and its JSDoc calls it "the swappable-engine seam"; `ElkLayoutEngine.layout(data, sizes, defaults)` is a public `async` method; and `DiagramLayoutResult`, `ElkEdgeSection`, `ElkPoint`, `ElkLayoutEngine`, and `DiagramView` are all exported from `@jimka/typescript-ui/component/diagram`'s barrel. A subclass overriding `layout` needs nothing private — it awaits `super.layout(...)`. So no library change is required, and none is made. Post-processing on the app side *before* `setData` is not possible for comparison: routes do not exist until the view has run its own layout, and `DiagramView` hands them straight from `applyLayout` to a private `_edgeLayer` ([DiagramView.ts:607](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L607)), so the engine is the only interception point that needs no library edit.

[^portless-rule]: Three reasons, any one sufficient. (1) It reproduces the semantics of the flag being removed, whose registry description is "edges that have no ports are merged so they touch the connected nodes at the same points" — so the set of bundles is the set ELK itself would have merged, just with the junction placed where the user wants it. (2) Card-mode ports are pinned `FIXED_POS` at `columnPortY(index)`, and a card's whole point is that an edge meets the row it belongs to; pulling a card's outgoing edges to one anchor would undo that. (3) A card-mode edge whose first local column is missing from the fetched columns falls back to a node-level anchor ([buildSchemaDiagram.ts:179-187](frontend/src/data/buildSchemaDiagram.ts#L179)), so a card graph can hold a few portless edges — those may bundle with each other, which is consistent, and they can never drag a ported edge along.

[^list-not-primary]: The rejected alternative kept `FkEdgeData`'s five flat fields as a "representative" key plus `folded?: FkEdgeData[]` for the extras. It has a smaller diff but a broken field: `uncovered` would have to mean "this key lacks an index" for the tooltip's per-key line *and* "some folded key lacks an index" for the warning stroke, and those disagree exactly when folding matters. Every reader would also have to remember to walk `folded` as well as the representative. One always-present list has a single shape, so `fks.map` / `every` / `some` read correctly at length 1 and length 3 alike, and card mode (always length 1) needs no special case. Also rejected, and not worth re-proposing: folding *only* same-endpoint-pair edges and leaving fan-in and fan-out unmerged, which would draw all 1058 lines separately and is not what is wanted.

[^helper-home]: [relationDiagram.ts](frontend/src/data/relationDiagram.ts) holds pure graph transforms, but those are view filters applied to an already-built graph, whereas folding is part of assembly and must run before `annotateFkCardinality` computes the combined markers. A third module for one twenty-line function would separate the foreign-key payload from the only operation that knows its internals. `buildSchemaDiagram.ts` already owns that payload type and already exports it to `buildDatabaseDiagram.ts`, so the import direction is established.

[^tooltip-flatten]: Two independent things put several foreign keys under one pointer, and the stub keeps both alive. A folded edge carries several keys by construction. Separately, `DiagramView._handleEdgeMouseMove` asks the edge layer for every route within hit tolerance and emits `"edgehover"` with all their model edges ([DiagramView.ts:1343-1361](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1343)), and a shared stub is by design a stretch of canvas where a whole bundle's routes coincide — so hovering one reports every member. Flattening `(edge, key)` pairs across both dimensions means `singleEdgeDetail`, `shareOneTarget`, `multiEdgeSummary`, and the eight-line cap all keep working unchanged, and the "N references to target(cols)" form now also covers the folded case, where the several sources happen to be the same table.

[^no-edge-level-flag]: Storing the "any key uncovered" answer on the edge as well as on each key would put one fact in two places for `annotateFkCardinality` to keep in sync. `applyCoverageStyle` is its only consumer and already walks the edge's `data`, so `fks.some(fk => fk.uncovered)` costs nothing and cannot drift. The tooltip needs the per-key verdict regardless, since it prints `No covering index` beneath the specific key that lacks one.

[^non-fk-graphs]: Each of these builders already keys its edges on the endpoint pair, so none can hold two edges between one pair and none needs folding. `buildRelationGraph` writes into a `Map` keyed `${sourceId}->${targetId}` ([buildRelationGraph.ts:83-90](frontend/src/data/buildRelationGraph.ts#L83)), serving both the dependency and inheritance graphs, pinned by [tests/data/buildRelationGraph.test.ts:76](frontend/tests/data/buildRelationGraph.test.ts#L76). `buildRoleMembershipDiagram` emits one edge per `(role, parent)` membership. `buildRoleGrantsDiagram` groups privileges by `schema.table` and emits one edge per table, pinned by [tests/data/buildRoleGrantsDiagram.test.ts:17](frontend/tests/data/buildRoleGrantsDiagram.test.ts#L17). `buildSchemaOverviewDiagram` aggregates by ordered schema pair and sets no `layoutOptions` at all, so it needs no edit whatsoever. They all still gain fan-in and fan-out stubs, because stubbing happens in the view they are drawn in, not in the builder.

[^explain-excluded]: A query plan is a tree, so it has no fan-in to disambiguate: every node has exactly one parent. What a stub would change is the fan-*out*, and there it costs more than it gives — each edge carries its arrowhead at the source end (`startMarker: "arrow"`, auto-reversed to point up the tree, [buildExplainDiagram.ts:74-77](frontend/src/data/buildExplainDiagram.ts#L74)), so a parent's arrowheads would all collapse onto one point and stop being countable, and each edge's mid-edge row-count label depends on the edges being distinguishable near the parent — `elk.layered.spacing.nodeNodeBetweenLayers` was already widened to `50` to give those labels room. Leaving `ExplainDiagramPanel` on plain `DiagramView` is also the cheapest possible expression of the exclusion: no flag, no option, no branch inside the transform.

[^bbox-unchanged]: The transform moves no node and adds no vertex outside the span the bundle's own routes already covered: the anchor is the mean of points already on the node border, and the junction is at most half the shortest leading run away from it, in the direction that run already went. So ELK's reported `width` and `height` still bound every drawn path and are passed through untouched — the 36,000px canvas stays 36,000px, which is the measurable difference from the rejected junction-node mechanism.

[^app-only]: The layout-option maps are app-owned constants, the folding is a transform over app-built `DiagramEdgeData` arrays, and the stub is a transform over the `DiagramLayoutResult` an app-side engine subclass received from `super.layout(...)`. The library's own mentions of `elk.layered.mergeEdges` are illustrative — `DiagramView.md`'s `"edgehover"` note names it as one way several edges can share a route, and the changelog repeats that phrasing — and both stay true statements about `DiagramView` whatever this app sets. With no library source touched there is nothing for `npm run build:lib` to rebuild. Swapping the view class also has no styling consequence: a component's CSS class comes from `this.constructor.name` ([Component.ts:5456](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L5456)), `DiagramView` defines no rule keyed on its own name, the app ships no CSS files, and three panels already report their own subclass names today.
