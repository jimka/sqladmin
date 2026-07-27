# Diagram Edge Bundling Strategies — Implementation Plan

## Overview

The schema diagram's dominant visual problem is fan-in. In the 154-table `hub`
schema, four tables absorb 606 of the 903 foreign-key edges (`users` 153,
`projects` 152, `workorders` 151, `workorder_rows` 150); every other table takes
2 to 4. Each of those four nodes sits at the apex of a cone of ~150 long lines.
Today's post-layout rewrite,
[`stubBundledEdgeRoutes`](frontend/src/data/edgeRouteStubs.ts#L321), moves the
apex about 32 units off the node but leaves the cone intact.

This plan adds two alternative bundling strategies to that same rewrite — a
**collector spine** and a **binary merge tree** — keeps today's **single
junction** as the default, and puts a live selector plus a numeric metrics
readout in the diagram control column
([`diagramShell.ts:267`](frontend/src/dock/diagramShell.ts#L267)) so the three
can be compared side by side on one layout.

The change is app-only. It touches the pure transform
([`edgeRouteStubs.ts`](frontend/src/data/edgeRouteStubs.ts)), the view that
applies it ([`JunctionDiagramView.ts`](frontend/src/dock/JunctionDiagramView.ts)),
the shared control column ([`diagramShell.ts`](frontend/src/dock/diagramShell.ts)),
and adds one new pure module for the comparison metrics. No library change is
needed.[^app-only]

---

## Architecture Decisions

### The strategies are new branches inside the existing pure rewrite

`stubBundledEdgeRoutes` gains an optional fourth argument selecting the
strategy; the two new routers live in the same module and reuse its bundle
collection, anchor, and stub-length code.[^same-module] The module keeps its
type-only import of `@jimka/typescript-ui/component/diagram`, so the app's
DOM-less vitest can still exercise every strategy. Any new geometry constant
that depends on how the library *draws* an edge is injected as a parameter, the
way `EDGE_MARKER_EXTENT` already is via
[`stubGeometry`](frontend/src/data/edgeRouteStubs.ts#L64) — neither new strategy
needs one, so no new injection point appears.

### Every constructed segment is checked against node rectangles before it is used

A router returns `null` when any segment it would draw passes through a node's
rectangle; the bundle then falls back to the single junction. This replaces an
assumption about how ELK aligns nodes within a layer with a check.[^obstacle]
The check is exact for the segments these routers build, because every one of
them is parallel or perpendicular to the destination border.

### A trunk may not sit further back than `BUNDLE_TRUNK_REACH` = 90 units

`BUNDLE_TRUNK_REACH` bounds how far, in graph units, a shared trunk may sit from
the destination node's border. The default 90 is the narrowest inter-layer gap
measured on the `hub` schema, so a trunk stays inside the channel ELK reserved
immediately before the destination and never reaches the previous layer's
nodes.[^reach] The collector spine uses only the innermost position (the
existing junction distance), so the reach binds the merge tree alone.

### Bundling engages only at 12 or more members

`BUNDLE_MIN_MEMBERS` = 12. Below it, a bundle keeps today's single junction
whatever strategy is selected. The `hub` measurements are bimodal — four nodes
at ~150 and 148 nodes at 2 to 4, nothing between — so any threshold in that gap
selects exactly the four hubs; 12 is low enough that a moderately referenced
lookup table still benefits and high enough that no ordinary table runs the new
path.[^threshold]

### The merge tree merges by cluster centroid, not by nearest member

Merging the pair of clusters whose **centroids** are closest produces a balanced
tree. Merging by nearest *member* produces a comb: one junction per member,
strung out in a chain instead of a branching tree.[^linkage] Ties break toward
the pair with the smaller centroid, so the output is deterministic. A tree that
still comes out deeper than `MERGE_TREE_MAX_DEPTH` = 16 is rejected and the
bundle falls back to the single junction.

Worked example — five members at across-coordinates 0, 10, 20, 30, 40:

| Step | Closest pair | Merged cluster (centroid) | Remaining clusters |
|---|---|---|---|
| 1 | 0, 10 (d=10, tie broken low) | `{0,10}` at 5 | 5, 20, 30, 40 |
| 2 | 20, 30 (d=10) | `{20,30}` at 25 | 5, 25, 40 |
| 3 | 25, 40 (d=15) | `{20,30,40}` at 30 | 5, 30 |
| 4 | 5, 30 (d=25) | root | — |

Three levels below the root over five leaves. Nearest-member linkage would
instead have merged 10→20, then 20→30, then 30→40: a four-level comb.

### The strategy selector lives in `DiagramShell`, above the root row

Every `DiagramShell` subclass already builds a `JunctionDiagramView`, so the
control is meaningful in all of them and belongs with the other controls the
shell owns. It sits in the always-visible block above the `Root …` row, not in
`rootedBlock`, because `rootedBlock` is hidden while no root is chosen — and the
unrooted whole-graph view is exactly where the cone appears.[^selector-home]

`DiagramShellSlots.view` narrows from `DiagramView` to `JunctionDiagramView`.
All six subclasses already pass one, so no call site changes.

### Switching strategy reuses the cached ELK result and does not move the viewport

`JunctionLayoutEngine` caches the raw, un-rewritten ELK result alongside the
`DiagramData` reference it was computed from. A second `layout()` call for the
same graph re-runs only the rewrite, so a strategy switch is instant instead of a
multi-second ELK pass over 154 nodes and 903 edges.[^cache] The shell does not
call `settleViewport` after a switch: node positions and graph bounds are
identical across strategies, so the user's pan and zoom still mean the same
thing — which is what makes an A/B comparison readable.

---

## Public API

```ts
// frontend/src/data/edgeRouteStubs.ts

/** Which shape a bundle's shared run takes. */
export type BundlingStrategy = "junction" | "spine" | "tree";

/** The strategies in selector order; "junction" is the default. */
export const BUNDLING_STRATEGIES: readonly BundlingStrategy[];

/** Tuning for {@link stubBundledEdgeRoutes}; every field has a documented default. */
export interface BundlingOptions {
    /** The shape to build. Default "junction" (today's behaviour). */
    strategy?:     BundlingStrategy;
    /** Smallest bundle a non-junction strategy engages on. Default BUNDLE_MIN_MEMBERS. */
    minMembers?:   number;
    /** How far back from the destination border a trunk may sit. Default BUNDLE_TRUNK_REACH. */
    trunkReach?:   number;
    /** Deepest merge tree accepted before falling back. Default MERGE_TREE_MAX_DEPTH. */
    maxTreeDepth?: number;
}

export function stubBundledEdgeRoutes(
    data:     DiagramData,
    result:   DiagramLayoutResult,
    geometry: StubGeometry,
    options?: BundlingOptions,
): DiagramLayoutResult;
```

```ts
// frontend/src/data/edgeBundleMetrics.ts  (new)

/** The four numbers that separate one bundling strategy from another. */
export interface BundlingMetrics {
    /** Sum of every edge's polyline length, in graph units. */
    totalRouteLength:  number;
    /** Length of the union of the drawn segments — coincident runs counted once. */
    distinctInkLength: number;
    /** Largest number of distinct segment directions meeting at one vertex. */
    maxVertexFan:      number;
    /** Segments passing through a node rectangle. Expected 0. */
    nodeIntersections: number;
}

export function bundlingMetrics(result: DiagramLayoutResult): BundlingMetrics;

/** The metrics as short display lines, one per line, for the shell's column. */
export function formatBundlingMetrics(metrics: BundlingMetrics): string[];
```

```ts
// frontend/src/dock/JunctionDiagramView.ts

class JunctionDiagramView extends DiagramView {
    /** Assigned by createEngine() during super(); `declare` so no initializer clobbers it. */
    private declare _junctionEngine: JunctionLayoutEngine;

    /** Re-applies the rewrite with a new strategy, reusing the cached ELK result. */
    setBundlingStrategy(strategy: BundlingStrategy): this;
    getBundlingStrategy(): BundlingStrategy;
    /** The metrics of the most recent rewrite, or null before the first layout. */
    getBundlingMetrics(): BundlingMetrics | null;
}
```

```ts
// frontend/src/dock/diagramShell.ts

/** The `Edge bundling` selector's items, in order. */
export const BUNDLING_CHOICES: { key: BundlingStrategy; label: string }[];

export interface DiagramShellSlots {
    view: JunctionDiagramView;   // narrowed from DiagramView
    // ...unchanged
}
```

---

## Internal Structure

### The border-relative coordinate frame

All three strategies work in the same two-axis frame, so nothing assumes
east/west. For a bundle on side `s` with anchor `A`:

- `n` = `outwardNormal(s)` — already in the module.
- `t` = `tangent(s)` — new: `{x:0,y:1}` for `west`/`east`, `{x:1,y:0}` for `north`/`south`.
- `out(P)` = `(P − A) · n` — how far off the border a point is.
- `across(P)` = `(P − A) · t` — where along the border it is.
- `pointAt(o, a)` = `A + n·o + t·a`.

### The three vertices at a bundled end

ELK routes these diagrams orthogonally, so a route arriving at a west border
ends as a staircase `… → P3 → P2 → P1 → endPoint`:

| Vertex | Field on `BundleMember` | Position in the frame |
|---|---|---|
| `endPoint` | `point` (exists today) | `out = 0` (on the border) |
| `P1` — the approach bend | `nextVertex` (exists today) | `out > 0`, `across ≈ across(endPoint)` |
| `P2` — the channel entry | `priorVertex` (new, nullable) | same `out` as `P1`, `across` = the edge's own haul coordinate |

`priorVertex` is `bendPoints[len-2]` for a `target` end and `bendPoints[1]` for a
`source` end, and is **`null` whenever the section has fewer than two bend
points** — there is then no distinct channel entry to work from.

A member with `priorVertex === null`, or whose approach is not parallel to `n`
(`|across(nextVertex) − across(point)| > 0.5`), does not join the shared
structure: it keeps today's single-junction tail while the rest of the bundle
uses the new one. This degrades per member instead of failing the whole
bundle.[^partial]

### The rewritten tail

```ts
/** What one member's end is rewritten to. Replaces today's `JunctionPair`. */
interface MemberTail {
    /** Points inserted between the member's own route and `anchor`, ordered toward the node. */
    via:              ElkPoint[];
    /** The bundle's shared anchor on the node border. */
    anchor:           ElkPoint;
    /** Whether the member's approach bend is removed before `via` is spliced in. */
    dropApproachBend: boolean;
}
```

`L` is the clamped stub length today's `junctionFor` already computes, and `B =
pointAt(L, 0)` is today's junction point. All three strategies end every member
with `… → B → anchor`, so the crow's-foot clearance rule is untouched.

| Strategy | `via` (route order, toward the node) | `dropApproachBend` |
|---|---|---|
| `junction` | `[B]` | `false` |
| `spine` | `[pointAt(L, across(P2)), B]` | `true` |
| `tree` | `pointAt(out_k, across(P2))`, then a `(step along n, slide along t)` pair per ancestor from the parent up to the root, ending at `B` | `true` |

For the spine, the member's long run in the channel moves from its own private
coordinate to the shared spine coordinate: ~150 near-parallel verticals become
one.

The spine additionally clamps `L` to `STUB_MAX_FRACTION × min out(nextVertex)`
over the participating members, since `stubLength`'s own cap uses Euclidean
distance and can exceed the perpendicular one. If that clamp drops `L` below
`geometry.minimum`, the whole bundle falls back to the single junction.

### Merge-tree level placement

Leaves are the participating members, positioned at `across(P2)`. Clusters merge
by closest centroid (weighted mean by member count) until one remains. Depth is
measured from the root: the root is depth 0 at `out_0 = L`; an internal node at
depth `j` sits at `out_j = L + j · step`, where `step = (reach − L) / max(1, D)`
and `D` is the deepest internal node's depth. `reach` = `options.trunkReach ??
BUNDLE_TRUNK_REACH`. The root's across-coordinate is forced to 0, so the root
point is exactly `B`. A tree with `D > maxTreeDepth` is rejected.

### The obstacle check

```ts
/**
 * True when the axis-parallel segment a→b passes through the interior of any
 * node rectangle other than `exclude`. Rectangles are inset by
 * NODE_CLEARANCE_INSET so a segment ending on a border does not count.
 */
function segmentHitsNode(a: ElkPoint, b: ElkPoint, rects: Map<string, NodeRect>, exclude: string): boolean;
```

Both routers check every segment they construct — each member's spur, each trunk
run, and each level step — and return `null` on the first hit. The spine's trunk
run spans `across` from `min(0, …)` to `max(0, …)` over the participating
members, because `B` sits at across 0 and every member reaches it.

---

## Ordered Implementation Steps

Work test-first: each step that adds logic gets its failing test before the code.

1. **`frontend/src/data/edgeRouteStubs.ts`** — add `priorVertex: ElkPoint | null`
   and `nodeId: string` to `BundleMember`
   ([:96](frontend/src/data/edgeRouteStubs.ts#L96)) and populate both in
   `collectBundles` ([:171](frontend/src/data/edgeRouteStubs.ts#L171)) per the
   *three vertices* table.
   *Check:* `npm run typecheck`; the existing `edgeRouteStubs` tests still pass.

2. **Same file** — split `junctionFor`
   ([:240](frontend/src/data/edgeRouteStubs.ts#L240)) into
   `bundleAnchor(members)` and `stubLength(members, anchor, geometry)`, leaving
   `junctionFor` as a two-line caller. Behaviour must not change.
   *Check:* existing tests still pass, unedited.

3. **Same file** — add the frame helpers `tangent`, `outAlong`, `acrossAlong`,
   `pointAt`, and the obstacle check `segmentHitsNode` with
   `NODE_CLEARANCE_INSET = 1`.

4. **Same file** — replace `JunctionPair` with `MemberTail`, and generalise
   `withStub` ([:279](frontend/src/data/edgeRouteStubs.ts#L279)) into
   `withTail(sections, end, tail)`. `via` is ordered from the member's own route
   toward the anchor: a `source` end prepends `[...via].reverse()`, a `target`
   end appends `via`. When `dropApproachBend` is true the adjacent bend point is
   removed first.
   *Check:* a tail of `{ via: [junction], anchor, dropApproachBend: false }` must
   reproduce today's output — the existing tests are the assertion.

5. **Same file** — add `BundlingStrategy`, `BUNDLING_STRATEGIES`,
   `BundlingOptions`, and the constants `BUNDLE_MIN_MEMBERS = 12`,
   `BUNDLE_TRUNK_REACH = 90`, `MERGE_TREE_MAX_DEPTH = 16`, each with the
   "what/why" comment the code conventions require.

6. **Same file** — add `routeCollectorSpine(members, anchor, length, geometry,
   rects)` returning `Map<string, MemberTail> | null` keyed by edge id. Partition
   the members into participants and non-participants first; return `null` when
   fewer than two participate, when the clamped `L` falls below
   `geometry.minimum`, or when any constructed segment hits a node.
   Non-participants get the junction tail.

7. **Same file** — add `routeMergeTree(members, anchor, length, reach, maxDepth,
   rects)` with the same return contract: centroid-linkage clustering
   with the low tie-break, depth measurement, level placement, rejection above
   `maxDepth`, obstacle check.

8. **Same file** — add the `options` parameter to `stubBundledEdgeRoutes`
   ([:321](frontend/src/data/edgeRouteStubs.ts#L321)) and dispatch per bundle:
   fewer than 2 members → skip; `strategy === "junction"` or fewer than
   `minMembers` → today's junction; otherwise call the router and fall back to
   the junction for the whole bundle when it returns `null`.
   *Check:* the parameter is optional, so `JunctionDiagramView`'s existing
   three-argument call still compiles before step 10.

9. **Create `frontend/src/data/edgeBundleMetrics.ts`** — `BundlingMetrics`,
   `bundlingMetrics(result)`, `formatBundlingMetrics(metrics)`. Type-only library
   import, matching `edgeRouteStubs.ts`'s header discipline. Ink length dedupes
   axis-parallel segments by `(orientation, fixed coordinate rounded to 1 unit)`
   and merges the resulting intervals; vertex fan rounds each vertex to 1 unit
   and each incident direction to 1 degree modulo 180.

10. **`frontend/src/dock/JunctionDiagramView.ts`** — give `JunctionLayoutEngine`
    a public `strategy` field (default `"junction"`), a `metrics` field, and a
    raw-result cache keyed on the `data` and `defaults` references. `layout()`
    reuses the cached raw result on a reference hit, rewrites it with
    `stubBundledEdgeRoutes(data, raw, STUB_GEOMETRY, { strategy: this.strategy })`,
    stores `bundlingMetrics(rewritten)`, and returns the rewritten result.
    Override `dispose()` to clear the cache before `super.dispose()`.

11. **Same file** — stash the engine on the view: `private declare
    _junctionEngine: JunctionLayoutEngine;`, assigned inside `createEngine()`
    ([:68](frontend/src/dock/JunctionDiagramView.ts#L68)). Add
    `setBundlingStrategy` (no-op when the strategy is unchanged; otherwise write
    the engine field, then call `this.setData(data)` when `getData()` is
    non-null), `getBundlingStrategy`, and `getBundlingMetrics`. Extend the
    `createEngine` doc comment: it still reads nothing off `this`, it only
    writes, which is why the field is `declare`.

12. **`frontend/src/dock/diagramShell.ts`** — narrow `DiagramShellSlots.view`
    ([:157](frontend/src/dock/diagramShell.ts#L157)) and the `view` field
    ([:201](frontend/src/dock/diagramShell.ts#L201)) to `JunctionDiagramView`
    (type-only import). Add `BUNDLING_CHOICES`.
    *Check:* `npm run typecheck` — no panel should need editing.

13. **Same file** — build the `Edge bundling` combo and an empty metrics `Panel`
    as locals before `super()`, and place both in the `controls` VBox
    ([:267](frontend/src/dock/diagramShell.ts#L267)) *before*
    `config.headerControls`, outside `rootedBlock`. After `super()`, wire
    `bundlingControl.on("change", …)` to `this.view.setBundlingStrategy(...)`
    (deliberately without `settleViewport`), and `view.on("layout", () =>
    this.refreshBundlingMetrics())`. `refreshBundlingMetrics` clears the metrics
    panel and re-adds one `Text` per line from `formatBundlingMetrics`, mirroring
    `fillLegend` ([:138](frontend/src/dock/diagramShell.ts#L138)).

14. **`frontend/tests/data/edgeRouteStubs.test.ts`** — add the new cases from
    `## Expected Behaviour`. Leave every existing case byte-identical; they are
    the regression guard for the default strategy.

15. **Create `frontend/tests/data/edgeBundleMetrics.test.ts`** — the metric cases
    from `## Expected Behaviour`.

16. Run `npm run typecheck` and `npm test` in `frontend/`, then the manual checks
    in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/data/edgeRouteStubs.ts` |
| Create | `frontend/src/data/edgeBundleMetrics.ts` |
| Modify | `frontend/src/dock/JunctionDiagramView.ts` |
| Modify | `frontend/src/dock/diagramShell.ts` |
| Modify | `frontend/tests/data/edgeRouteStubs.test.ts` |
| Create | `frontend/tests/data/edgeBundleMetrics.test.ts` |

---

## Expected Behaviour

Unit-testable unless marked **manual**.

### The default strategy is unchanged

- `stubBundledEdgeRoutes(data, result, geometry)` with no fourth argument returns
  exactly what it returns today. Every existing test in `edgeRouteStubs.test.ts`
  passes without edit.
- `{ strategy: "spine" }` on a bundle of 3 (below `minMembers` 12) produces the
  single-junction output.

### Collector spine

Fan-in of three staircase routes into a node at `x = 1000`, `y = 0`, `100 × 60`,
with `MARKER_EXTENT = 18` (so `preferred = 32`, `minimum = 22`):

| Edge | Original section |
|---|---|
| `P->E` | start `(0, 500)`, bends `(900, 500)`, `(900, 25)`, end `(1000, 25)` |
| `Q->E` | start `(0, 800)`, bends `(910, 800)`, `(910, 30)`, end `(1000, 30)` |
| `R->E` | start `(0, 100)`, bends `(920, 100)`, `(920, 35)`, end `(1000, 35)` |

With `{ strategy: "spine", minMembers: 2 }`:

- anchor = `(1000, 30)`; the shortest run is 80 units, so `L = min(32, max(22,
  40), 72) = 32`, the spine sits at `x = 968`, and `B = (968, 30)`.
- `P->E` becomes start `(0, 500)`, bends `(900, 500)`, `(968, 500)`, `(968, 30)`,
  end `(1000, 30)`. The approach bend `(900, 25)` is gone.
- `Q->E` becomes bends `(910, 800)`, `(968, 800)`, `(968, 30)`; `R->E` becomes
  bends `(920, 100)`, `(968, 100)`, `(968, 30)`. All three share the last two
  points `(968, 30)` and `(1000, 30)`.
- `nodes`, `width`, and `height` are the same objects/values as the input.

Edge cases:

- A member whose section has fewer than two bend points keeps the single-junction
  tail while the other members use the spine.
- A member whose approach bend is not level with its endpoint (`|Δ across| >
  0.5`) likewise keeps the single-junction tail.
- Adding a node rect covering `x 960…980`, `y 200…400` makes the whole bundle
  fall back to the single junction.
- A bundle whose shortest perpendicular run is at or below `geometry.minimum`
  falls back to the single junction.
- The same bundle on a `south` border produces the same shape rotated: the spine
  runs horizontally at `y = anchor.y + 32`.

### Merge tree

- Four participating members at across-coordinates 0, 10, 20, 30 with `{
  strategy: "tree", minMembers: 2 }` produce a tree one level deep: `{0,10}`
  merges first (tie broken low), then `{20,30}`, then the root.
- With `reach = 90` and `L = 32`, `D = 1` gives `step = 58`, so both level-1
  trunks sit at `out = 90`. Members 0 and 10 share the run from `(90, 5)` to
  `(32, 5)` to `B`; members 20 and 30 share `(90, 25)` to `(32, 25)` to `B`.
- Every member's route still ends `… → (anchor + n·32) → anchor`.
- Members at exponentially spaced across-coordinates (0, 1, 3, 7, 15, 31) chain
  into a five-level comb; with `maxTreeDepth: 3` the bundle falls back to the
  single junction.
- An obstacle on any level trunk falls the bundle back to the single junction.

### Rules held by every strategy

- `result`, its edges, and their sections are never mutated; `nodes`, `width`,
  and `height` pass through by reference/value.
- Every input edge id appears exactly once in the output, and each edge keeps its
  section count — so per-edge tooltips, emphasis, and the hit paths in the
  library's `DiagramEdgeLayer.edgesNear` keep mapping back to their foreign key.
- No constructed segment passes through a node rectangle.

### Metrics

- On a two-edge result with no shared geometry, `distinctInkLength ===
  totalRouteLength`.
- Two edges drawing the identical segment count that segment once in
  `distinctInkLength` and twice in `totalRouteLength`.
- A vertex where three edges arrive from three different directions and leave
  along one shared direction reports `maxVertexFan = 4`; a plain bend reports 2.
- A result whose edges avoid every node rect reports `nodeIntersections = 0`.
- `formatBundlingMetrics` returns four lines, one per metric, each short enough
  for the 220-unit control column.

### What the metrics do and do not settle

`distinctInkLength` and `maxVertexFan` are the discriminating pair: the single
junction draws ~150 separate long lines and puts ~150 distinct directions at one
point, while both new strategies collapse those to one trunk and a fan of 2 at
any vertex. `totalRouteLength` measures the detour each strategy costs, and rises
where ink falls. `nodeIntersections` is a safety assertion, not a comparison —
0 for all three or the strategy is broken.

Apex distance is deliberately **not** a metric: all three strategies place their
innermost shared point at the same distance `L` from the border by construction,
so it cannot separate them.

### Manual

- **manual** — On the `hub` schema diagram (unrooted), the `Edge bundling`
  selector switches between the three strategies without moving the viewport and
  without a visible re-layout delay.
- **manual** — Whether the spine reads as "one trunk plus spurs" and the tree as
  a river rather than a ramp is only judgeable by eye; the metrics narrow the
  choice but do not settle it.
- **manual** — Hovering a trunk still shows the tooltip listing every foreign key
  drawn there, and clicking a node still dims the unrelated edges.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — all suites green, including the untouched
  `edgeRouteStubs` cases.
- `grep -rn "stubBundledEdgeRoutes" frontend/src frontend/tests` — the only
  runtime call site under `src/` is `JunctionDiagramView`.
- `grep -n "@jimka/typescript-ui" frontend/src/data/edgeRouteStubs.ts
  frontend/src/data/edgeBundleMetrics.ts` — every match is an `import type`.
- Manual: open a `hub`-sized schema via the navigator's schema node →
  *Open schema diagram*. Leave the root unset. Cycle the `Edge bundling` selector
  through Junction / Collector spine / Merge tree and read the four metric lines
  under it. `Node hits` must stay 0 in all three; `Max fan` should drop from ~154
  to a single digit on the two new strategies.
- Manual: repeat on the *Relation graph* and *Role grants* diagrams to confirm
  the selector is present and inert there (no bundle reaches 12 members).

---

## Potential Challenges

- **The metrics readout costs column height.** Four `Text` rows sit above the
  legend in a 220-wide column; keep each line under ~18 characters so nothing
  ellipsises.
- **The busy spinner may blink on a cached switch.** `relayout` shows it
  synchronously and the cached path resolves a microtask later; no paint happens
  in between, so it should be invisible. If it does flash, it is cosmetic — do
  not add a second code path to suppress it.
- **`setData` clears node selection and emphasis.** A strategy switch therefore
  drops any active highlight. Accept it; every other shell control already
  behaves that way.
- **The merge tree may look like the spine.** `L` is 32 and `reach` is 90, so a
  deep tree's levels end up only a few units apart. If the levels are
  indistinguishable in the app, raise `BUNDLE_TRUNK_REACH` — the obstacle check,
  not the constant, is what keeps the routes legal.
- **Flat-mode nodes have varying widths.** The schema diagram is built without
  `columnsByTable` ([`SqlAdminController.ts:1575`](frontend/src/SqlAdminController.ts#L1575)),
  so a layer's nodes need not share an `x`. The obstacle check is why this does
  not have to be resolved.

---

## Critical Files

- [`frontend/src/data/edgeRouteStubs.ts`](frontend/src/data/edgeRouteStubs.ts) —
  the transform being extended; its header states the purity discipline every new
  helper must follow, and `junctionFor` (:240) is the anchor and stub-length code
  the new routers reuse.
- [`frontend/src/dock/JunctionDiagramView.ts`](frontend/src/dock/JunctionDiagramView.ts) —
  the `createEngine` seam the whole feature hangs off, and the worked example of
  injecting `EDGE_MARKER_EXTENT` across the purity boundary.
- [`frontend/src/dock/diagramShell.ts`](frontend/src/dock/diagramShell.ts) — the
  control column; `fillLegend` (:138) is the rebuild-children pattern the metrics
  block copies, and `applyRootVisibility` (:463) shows what `rootedBlock` hides.
- [`frontend/src/data/buildSchemaDiagram.ts`](frontend/src/data/buildSchemaDiagram.ts) —
  `LAYOUT_OPTIONS` (:26) and its comment carry the measured inter-layer gaps
  `BUNDLE_TRUNK_REACH` is derived from.
- [`frontend/tests/data/edgeRouteStubs.test.ts`](frontend/tests/data/edgeRouteStubs.test.ts) —
  the test shape to match: literal coordinates with an arithmetic comment.
- `packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts` in
  `/home/jika/typescript/typescript-ui/.worktrees/diagram-viewport-and-edge-polish/`
  — `EDGE_MARKER_EXTENT` (:152) and `edgesNear` (:482), which is why every edge
  must keep its own complete route.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) —
  section (b), the super-cascade trap, governs the `declare` field in step 11.

---

## Non-Goals

- **No library change.** `DiagramView`, `ElkLayoutEngine`, and `DiagramEdgeLayer`
  are untouched, so no second branch and no `build:lib` step enters the stack.
- **No change to `ExplainDiagramPanel`.** It builds a plain `DiagramView`
  ([:166](frontend/src/dock/ExplainDiagramPanel.ts#L166)); a query plan is a tree
  with no fan-in to bundle.
- **No node movement and no layout-option changes.** The rewrite stays
  post-layout; `elk.spacing.edgeNode` and its siblings keep their current values.
- **No persistence of the chosen strategy.** It is a comparison control, reset to
  `"junction"` whenever a diagram tab opens.
- **No CHANGELOG entry.** This repo's changelog is written per release, not per
  branch.
- **No per-node or per-bundle strategy override.** One selector governs the whole
  view.

---

## Notes

[^app-only]: The library already exposes everything needed. `DiagramView.createEngine`
    is a documented swappable-engine seam, `EDGE_MARKER_EXTENT` is exported for
    exactly this kind of consumer rewrite, and `DiagramEdgeLayer` draws one path
    per edge from that edge's own sections — so coincident trunks fall out of
    giving several edges the same coordinates, with no library support needed.
    The one thing the library does not offer is a public way to re-apply a layout
    result without re-running ELK; the engine-side cache described under
    *Switching strategy* works around that from the app.

[^same-module]: `edgeRouteStubs.ts` grows from ~370 to roughly 650 lines. A
    separate router module was considered and rejected: the routers need
    `BundleMember`, `StubGeometry`, `outwardNormal`, and `stubLength`, and
    `stubBundledEdgeRoutes` needs the routers, so splitting them creates a runtime
    import cycle unless the shared helpers move to a third module — which would
    break the imports in `JunctionDiagramView.ts` and in the existing test file
    for no gain. The module still does one thing: rewrite an ELK result's routes.
    The metrics are genuinely separate (they read a result and know nothing about
    bundles), so they do get their own file.

[^obstacle]: The safe claim is only that ELK reserves the channel between two
    layers. Whether the strip immediately beside a node is free depends on whether
    ELK left-aligns a layer's nodes at a common coordinate — true when the nodes
    have equal widths (card mode gives every card `CARD_WIDTH`) but not something
    to rely on in flat mode, which is what the schema diagram actually uses.
    Rather than assert it, the routers test each constructed segment against the
    node rectangles already present in `result.nodes` and decline the strategy on
    a hit. The test is exact for these segments because every one is parallel or
    perpendicular to the destination border, which makes it a plain axis-aligned
    box overlap. It is also cheap: only bundles at or above `BUNDLE_MIN_MEMBERS`
    reach it, which on the `hub` schema is four bundles.

[^partial]: Failing the whole bundle on one awkward member would be a cliff: a
    single short edge among 150 would silently restore the cone. Falling back per
    member costs at most a handful of radiating lines, and every one of those
    lines is a route the current code already draws. The two conditions that
    trigger it — fewer than two bend points, and a non-level approach — are both
    "this route has no distinct channel run to redirect", so there is nothing to
    reroute in the first place.

[^reach]: `buildSchemaDiagram.ts`'s `LAYOUT_OPTIONS` comment records the measured
    result of dropping `nodeNodeBetweenLayers` to 60 on the `hub` schema: "99 gaps
    at 100 and 50 at 90 — none at 60". Ninety is therefore the narrowest channel a
    trunk could find itself in, and a trunk confined to 90 units off the
    destination border cannot reach the previous layer's nodes in any of the
    measured gaps. Scaling the reach to the graph width was rejected: a bundle
    spanning many layers is far more likely to cross occupied ground, and a
    width-relative reach grows exactly where the risk grows.

[^threshold]: Measured in-degree over the folded FK graph (903 edges, 154
    targets): `users` 153, `projects` 152, `workorders` 151, `workorder_rows` 150,
    everything else 1 to 4. There is no target between 4 and 150, so every
    threshold from 5 to 150 selects the same four nodes today. Twelve sits inside
    that gap rather than at its edge: at 5 a table with a handful of references
    would take the risky path for no visible gain, and at 100 a schema with a
    lookup table referenced 30 times would get nothing. Twelve is also roughly
    where a fan stops being individually traceable by eye.

[^linkage]: Single-linkage (nearest *member*) clustering on one-dimensional points
    chains. Given 0, 10, 20, 30, 40, merging `{0,10}` leaves member 10 at distance
    10 from 20, which is still the global minimum, so 20 joins the same cluster,
    then 30, then 40 — one junction per member. Centroid linkage moves the merged
    cluster's representative to 5, which is 15 away from 20, so the next merge is
    the independent pair `{20,30}`. On evenly spaced points that yields a
    tournament of depth `log2(n)`; on 153 members that is 8 rather than 152.
    Centroid linkage can still chain on exponentially spaced points, which is what
    `MERGE_TREE_MAX_DEPTH` catches. Sixteen is twice the ideal depth for 153
    leaves, so a merely unbalanced tree passes and only a genuine comb is
    rejected.

[^selector-home]: Three homes were considered. `SchemaDiagramPanel` alone is too
    narrow — `DatabaseDiagramPanel`'s Tables mode draws the same kind of FK graph
    with the same hubs. A new `DiagramShellSlots` slot would need the same control
    constructed in each of six panels. The shell itself already owns the controls
    that "have to agree across every subclass" (its own header comment), and every
    subclass passes a `JunctionDiagramView`, so the strategy is meaningful in all
    of them. On the graphs where no node collects 12 references — the relation,
    inheritance, and role-grant graphs — the selector is present and simply
    changes nothing, which is a clearer contract than hiding it conditionally.

[^cache]: `DiagramView.relayout` is reached only from `setData(data)`, and the
    node sizes it collects are derived from `data` alone: card-mode nodes carry
    explicit `width`/`height`, and flat nodes are measured from freshly built
    renderer components whose content comes from the same node data. So calling
    `setData` again with the same `DiagramData` object must produce the same raw
    ELK result, and caching it keyed on that object's identity (plus the
    `defaults` record's identity) is sound. Without the cache, every strategy
    switch would re-run ELK across 154 nodes and 903 edges — seconds of wait
    between the two pictures the user is trying to compare, which defeats the
    comparison. The cache holds one extra layout result per view and is cleared in
    `dispose()`.

---

## Implementation Notes

### Measured on the `hub` schema

| | Junction | Collector spine | Merge tree |
|---|---|---|---|
| `totalRouteLength` | 15.0M | 15.0M | 16.7M |
| `distinctInkLength` | 14.9M | **12.8M** | 13.0M |
| `maxVertexFan` | 27 | 8 | 8 |
| `nodeIntersections` | 0 | 0 | 0 |

Both new strategies hold `nodeIntersections` at 0 and keep all 1846 drawn paths.
The viewport held exactly across every switch. Visually the junction baseline is
a fence of ~90 parallel verticals, each edge descending its own channel into the
hub; the spine collapses those onto one line, the tree into nested brackets.

### `maxVertexFan` does not reach the predicted ~154

`## Verification` expected the junction's fan to read "~154" and drop to a single
digit. It reads **27**, dropping to 8. The prediction was wrong, not the metric:
at the junction each member arrives from a channel entry thousands of units away
across a stub only 32 units long, so the incident directions differ by far less
than a degree and collapse when rounded onto `DIRECTION_GRID`. The metric still
separates the strategies in the right direction and by a clear margin — it just
cannot report a fan the geometry never makes angularly distinct.

### Participation carries a third condition

`## Internal Structure` gives two conditions for a member joining the shared
structure: a non-null `priorVertex`, and an approach parallel to the normal. A
third is required for the geometry to be valid — the channel entry must sit
*further out* than the trunk it would join, or the spur doubles back on itself.
It is applied per member (`participates`), matching the plan's own rule that a
member with nothing to reroute keeps the single-junction tail rather than
failing the whole bundle.

### The spine's clamped length governs its whole bundle

Where the spine clamps `L` down to fit the shortest perpendicular run, the
clamped value is used as the innermost distance for *every* member of that
bundle, including the non-participants that keep a junction tail and the members
downgraded by `BOTH_ENDS_MIN_BENDS` below. Using the unclamped `length` for them
would have put two different innermost points on one node's border, which the
plan's "all three strategies end every member with `… → B → anchor`" rule reads
as one. `junctionFallback` therefore reads the shared point back off the tail a
member would otherwise have been given, rather than recomputing it — the second
audit caught it recomputing.

### `junctionFor` dissolved rather than thinning

Step 2 called for leaving `junctionFor` as a two-line caller, but step 4 removed
`JunctionPair`, which was its return type. It is therefore replaced by
`bundleFrame` + `stubLength` + `junctionTail` rather than retained. The frame
helpers also take a `BorderFrame` record (anchor, normal, tangent) instead of
three loose parameters, since all three strategies thread the same triple
through every call.

### One section rewritten at both ends needs three bend points

`## Internal Structure`'s three-vertex table describes one end at a time and
assumes each end owns its own vertices. When a single section is bundled at both
ends — two parallel edges between the same pair, which the schema diagram folds
but the relation graphs do not — the two ends read the same bend list from
opposite directions: the source's channel entry is `bendPoints[1]` and the
target's is `bendPoints[length - 2]`. At exactly two bends those *are* each
other's approach bends, so both ends dropped the vertex the other was routing
from and the two shared runs were joined by a single diagonal straight across
the inter-node gap, which no obstacle check covered.

`resolveEndTails` now falls both ends back to the single junction below
`BOTH_ENDS_MIN_BENDS` (three), the first length at which the ends' entries
coincide on a middle vertex that neither drops. Found by the audit, not by the
plan's cases, none of which bundle a section at both ends.
