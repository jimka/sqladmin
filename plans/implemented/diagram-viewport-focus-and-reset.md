---
touches-shared:
  - ../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts
  - ../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts
  - ../typescript-ui/packages/lib/docs/components/DiagramView.md
  - ../typescript-ui/packages/lib/docs/reference/changelog.md
---

# Diagram Viewport Focus & Reset — Implementation Plan

## Overview

Three defects in `DiagramView`'s viewport handling, all reported after testing the current diagram stack, all fixed inside [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts).

1. **Reset ignores the focus node.** [`resetView`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L756) always calls `centreGraph()`, so on a rooted diagram the Reset button centres the *whole graph* rather than the root the view opened on. Every rooted app panel passes `initialFocusNode` ([RelationDiagramPanel.ts:89](frontend/src/dock/RelationDiagramPanel.ts#L89), [RootedRelationGraphPanel.ts:60](frontend/src/dock/RootedRelationGraphPanel.ts#L60), [RoleGrantsDiagramPanel.ts:50](frontend/src/dock/RoleGrantsDiagramPanel.ts#L50), [ExplainDiagramPanel.ts:170](frontend/src/dock/ExplainDiagramPanel.ts#L170)), so all of them are affected.

2. **Centring on a node can leave it clipped.** [`centreNode`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1004) writes only a pan, so a root card taller or wider than the viewport is centred *and* cut off on all four sides. Centring on a node now also lowers the zoom — never raises it — until the node's whole box fits.

3. **Reset appears broken after a live re-layout.** Changing the Depth control calls `setData`, which re-lays the graph out around the pan the user was already at. The initial centring is one-shot — armed once, cleared by the first centring that lands, never re-armed — so the root drifts off-screen, and Reset, centring the graph bounds, pushes it further away on a large graph. Fix 1 is the whole fix here: with Reset targeting the root again, the recovery gesture works. The one-shot rule itself is deliberately left in place.

The library is edited first; the app consumes the library's built, symlinked `dist/lib`, so `npm run build:lib` must run before the app typechecks. **No app-side change is needed** — see _Architecture Decisions → No app code depends on the old behaviour_.

---

## Architecture Decisions

### `resetView` re-arms the pending centring and delegates to `tryInitialCentre`

`resetView` sets the default zoom, sets `_needsInitialCentre = true`, and calls [`tryInitialCentre()`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L807), which already makes the focus-node-else-graph-bounds choice against `_focusNodeId` and `_nodeComponents`. This is the same shape [`focusNode`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1044) already uses to mean "centre on my target, retrying after the next layout if it can't land now".[^reuse-flag]

The choice `tryInitialCentre` makes, unchanged:

| `_focusNodeId` | In the shown graph? | Reset centres |
|---|---|---|
| `"public.users"` | yes | node `public.users`, whole box visible |
| `"public.users"` | no (a depth change dropped it) | the graph bounds |
| `null` (no `initialFocusNode`, no `focusNode` call) | — | the graph bounds |

### Fitting the node happens inside `centreNode`, not only on the reset path

`centreNode` lowers the zoom until the node fits, so all four callers — `resetView`, `focusNode`, `revealNode`, and the initial centring driven by `initialFocusNode` — get it.[^fit-in-centrenode] The zoom only ever *decreases*, and only when the node does not already fit, so a node smaller than the viewport (the common case, and every case the existing tests cover) is unaffected.

This changes three documented contracts, all restated in `## Public API`: `revealNode` and `focusNode` both promise not to change the zoom, and `initialFocusNode` promises the configured `zoom` is left alone.

### The reduced zoom goes through `clampZoom`, which can never block the fit

`centreNode` resolves its zoom through a new private `zoomFittingNode(size)` that ends in [`clampZoom`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L916), so the configured `maxZoom` and the adaptive floor from [`effectiveMinZoom`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L893) both still apply. The clamp can never stop a node from fitting: a node's box is contained in the graph bounds, so the node's fit zoom is always at or above the graph's fit zoom, which is the floor `effectiveMinZoom` drops to.[^clamp-cannot-block]

### A `setData` re-layout does not re-arm the centring

The one-shot rule stays: only an explicit gesture (`resetView`, `focusNode`) re-centres. A `setData`-driven re-layout leaves the pan where the user put it.[^no-rearm-on-setdata]

### No app code depends on the old behaviour

`grep -rn 'resetView\|revealNode\|focusNode\|initialFocusNode' frontend/src/` finds four `initialFocusNode` call sites, one `focusNode` ([DatabaseDiagramPanel.ts:178](frontend/src/dock/DatabaseDiagramPanel.ts#L178)), one `revealNode` ([ExplainDiagramPanel.ts:198](frontend/src/dock/ExplainDiagramPanel.ts#L198)), and no `resetView` — the Reset button is the library's own control cluster. Every one of them wants the node fully visible, so all six improve and none needs editing.

---

## Public API

No signature changes and no new exported symbol. Three contracts change.

```typescript
/**
 * Resets to the default zoom, then re-centres: on the focus node when the
 * view has one that is in the shown graph, else on the graph bounds. The
 * focus node is `initialFocusNode`, or the target of the most recent
 * `focusNode` call. Centring a node also lowers the zoom, if needed, until
 * the node's whole box fits. Retried after the next layout pass when the
 * view has no committed size yet.
 */
resetView(): this;
```

```typescript
/**
 * Pans so the given node is centred, and lowers the zoom if the node is too
 * large to fit the viewport whole. Never raises the zoom. Changes no
 * selection and emits nothing.
 */
revealNode(id: string): this;
```

```typescript
/**
 * Centres the given node, retried after each layout pass until it succeeds.
 * Lowers the zoom if the node is too large to fit the viewport whole; never
 * raises it.
 */
focusNode(id: string): this;
```

```typescript
interface DiagramViewOptions {
    /**
     * Id of the node the one-shot initial view centres on, instead of the
     * graph's bounds. An id naming no node in the graph falls back to
     * centring the bounds. The configured `zoom` is honoured, except that a
     * focus node too large to fit the viewport lowers it until the node fits.
     */
    initialFocusNode?: string;
}
```

---

## Internal Structure

`resetView` (replacing the body at [line 756](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L756)):

```typescript
resetView(): this {
    this.setZoom(this._defaultOptions.zoom ?? DEFAULT_ZOOM);

    this._needsInitialCentre = true;
    this.tryInitialCentre();

    return this;
}
```

`zoomFittingNode`, a new private helper placed immediately after `clampZoom` ([line 921](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L921)), beside the other zoom-resolution helpers:

```typescript
private zoomFittingNode(size: { width: number; height: number }): number {
    const current = this.getZoom();
    const vw      = this.getWidth();
    const vh      = this.getHeight();

    // `getWidth()` / `getHeight()` are `NaN` before the first `setSize`, and a
    // zero-sized node box has no fit zoom — `> 0` rejects both, since every
    // NaN comparison is false (see `effectiveMinZoom`).
    if (!(vw > 0) || !(vh > 0) || !(size.width > 0) || !(size.height > 0)) {
        return this.clampZoom(current);
    }

    const fitZoom = Math.min(vw / size.width, vh / size.height);

    return this.clampZoom(Math.min(current, fitZoom));
}
```

`centreNode` (replacing the body at [line 1004](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1004)) — the only change is that `zoom` now comes from `zoomFittingNode`, and the write is `setZoom` rather than `applyTransformToHost`:

```typescript
private centreNode(id: string): boolean {
    const component = this._nodeComponents.get(id);
    const size      = component?.getPreferredSize();

    if (!component || !size) {
        return false;
    }

    const zoom = this.zoomFittingNode(size);

    // Node centre in unscaled graph coordinates.
    const centreX = component.getX() + size.width  / 2;
    const centreY = component.getY() + size.height / 2;

    // Pan so the node centre maps to the viewport centre: viewport = pan + graph·zoom.
    const panX = this.getWidth()  / 2 - centreX * zoom;
    const panY = this.getHeight() / 2 - centreY * zoom;

    if (!Number.isFinite(panX) || !Number.isFinite(panY)) {
        return false;
    }

    this._panX = panX;
    this._panY = panY;

    // Writes the pan fields first, then lets `setZoom` apply the transform
    // once — the shape `zoomAboutViewportPoint` already uses.
    this.setZoom(zoom);

    return true;
}
```

Two ordering rules the implementer must not reorder:

- **`setZoom` comes after the finite-pan guard.** An unsized view must leave the zoom untouched as well as the pan; calling `setZoom` before the guard would commit a zoom change on a call that then reports failure.
- **`zoom` is used for the pan and then handed to `setZoom`.** Because `zoomFittingNode` already clamps, the pan is computed against exactly the zoom that gets committed. Never pass an unclamped value here.

---

## Ordered Implementation Steps

Work in `/home/jika/typescript/typescript-ui`. Steps 1-3 are test-first: add the failing tests, then make them pass.

1. **Add two layout fixtures** to `../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts`, beside `fixedResult()` ([line 84](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L84)):
   - `oversizedNodeResult()` — node `a` at `(100, 50, 2000, 1000)`, node `b` at `(2300, 0, 60, 30)`, no edges, graph `2400 × 1100`.
   - `movedRootResult()` — node `a` at `(500, 400, 60, 30)`, node `b` at `(900, 700, 60, 30)`, no edges, graph `2000 × 1200`. Stands in for the post-depth-change re-layout.
2. **Add a `describe('DiagramView — resetView targets the focus node')` block** covering the reset cases in `## Expected Behaviour`. Run `npx vitest run tests/component/diagram/DiagramView.test.ts` — the new reset tests fail, everything else passes.
3. **Add a `describe('DiagramView — centring a node fits it in the viewport')` block** covering the fit cases in `## Expected Behaviour`. Run the same command — the new fit tests fail too.
4. **Add `zoomFittingNode`** to `DiagramView.ts` immediately after `clampZoom` ([line 921](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L921)), per `## Internal Structure`, with a JSDoc description plus `@param` and `@returns`.
5. **Rewrite `centreNode`'s body** ([line 1004](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1004)) per `## Internal Structure`, and extend its JSDoc: it now also lowers the zoom, never raises it, and writes nothing at all when the node is unknown or the view is unsized.
6. **Rewrite `resetView`'s body** ([line 756](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L756)) per `## Internal Structure`, and replace its JSDoc with the `## Public API` wording.
7. **Update the three JSDoc blocks whose stated contract changed**, using the `## Public API` wording: `revealNode` ([line 989](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L989)) — drop "without changing the ... zoom" and say the zoom is lowered when the node does not fit; `focusNode` ([line 1044](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1044)) — replace "The zoom is left unchanged."; `DiagramViewOptions.initialFocusNode` ([line 128](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L128)) — replace "The configured `zoom` is left alone either way."
8. **Update `tryInitialCentre`'s JSDoc** ([line 807](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L807)): it is now reached from `resetView` as well as `applyLayout`, `doLayout`, and `focusNode`, and its "The configured `zoom` is deliberately left alone" sentence needs the same node-fit exception. Do not rename the method or `_needsInitialCentre` (see `## Non-Goals`).
9. **Run the full library suite**: `npm test` in `/home/jika/typescript/typescript-ui`. All new tests pass; every pre-existing test in `tests/component/diagram/` passes unchanged.
10. **Grep invariant**, in `../typescript-ui/packages/lib/src`: `grep -n "centreGraph()" typescript/lib/component/diagram/DiagramView.ts` — expect exactly three matches: the method's own declaration, the call in `zoomToFit`, and the call in `tryInitialCentre`. A fourth means `resetView` still calls it directly.
11. **Grep invariant**: `grep -n "applyTransformToHost()" typescript/lib/component/diagram/DiagramView.ts` — read every hit; `centreNode` must not be among them (it writes through `setZoom` now).
12. **Grep invariant**: `grep -nE "The zoom is left|left alone|selection, zoom" typescript/lib/component/diagram/DiagramView.ts` — expect zero matches. Before the change this finds exactly the five JSDoc claims steps 5, 7, and 8 rewrite: `initialFocusNode` (126), `tryInitialCentre` (790), `revealNode` (975), `centreNode` (997), `focusNode` (1037).
13. **Update `../typescript-ui/packages/lib/docs/components/DiagramView.md`** per `## Documentation Impact`.
14. **Update `../typescript-ui/packages/lib/docs/reference/changelog.md`** per `## Documentation Impact` — amend two existing `## 0.3.0` bullets, add one `### Changed` and one `### Fixed` bullet. No version bump.
15. **Library checks**: `npm run lint`, `npm run docs:api` (zero warnings), then `npm run build:lib`.
16. **App regression check**: in `/home/jika/typescript/sqladmin/frontend` — `npm run typecheck` and `npm test`. Both are pure regression checks; no app source changes in this plan.
17. **Manual verification** per the list in `## Expected Behaviour`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts` |
| Modify | `../typescript-ui/packages/lib/docs/components/DiagramView.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog.md` |
| Regenerate | `../typescript-ui/packages/lib/docs/api/component/diagram/**` (TypeDoc output, gitignored — produced by `npm run docs:api`, never hand-edited) |

---

## Expected Behaviour

### Unit-testable (`DiagramView.test.ts`, `StubEngine` + `RecordingDOMSink`)

Viewport is `1280 × 800` throughout, via `view.setSize({ width: 1280, height: 800 })`. Assertions read `view._contentHost.getTransform()`, or `parseTransform` ([line 97](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L97)) where a value needs `toBeCloseTo`.

The fixtures and the numbers each one pins:

| Fixture | Focus node `a` | Graph | Node fit zoom | Node centre |
|---|---|---|---|---|
| `fixedResult()` (existing) | `(10, 20, 60, 30)` | `160 × 230` | `21.33` — no shrink | `(40, 35)` |
| `oversizedNodeResult()` | `(100, 50, 2000, 1000)` | `2400 × 1100` | `min(0.64, 0.8) = 0.64` | `(1100, 550)` |
| `movedRootResult()` | `(500, 400, 60, 30)` | `2000 × 1200` | `21.33` — no shrink | `(530, 415)` |

**`resetView` targets the focus node:**
- `initialFocusNode: 'a'`, `fixedResult()`, sized, then a hand-written pan (`_panX = 99; _panY = 77; applyTransformToHost()`), then `resetView()` → `translate(600px, 365px) scale(1)` — the node, not the bounds.
- No `initialFocusNode`, `fixedResult()`, sized, `zoomToFit()` then `resetView()` → `translate(560px, 285px) scale(1)`. This is the existing test at [line 563](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L563) and must stay green unchanged.
- **Reset after a live re-layout** (the depth-change case). A two-call stub returning `fixedResult()` then `movedRootResult()`, mirroring the custom-stub shape at [line 1306](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1306). `initialFocusNode: 'a'`, sized, first layout settles → `translate(600px, 365px) scale(1)`. Then `setData(...)` + `flush()` → the pan is unchanged (one-shot). Then `resetView()` → `translate(110px, -15px) scale(1)`.
- **Focus node gone from the new graph.** Same two-call stub, second result `{ nodes: [{ id: 'z', x: 0, y: 0, width: 20, height: 20 }], edges: [], width: 400, height: 300 }` with a second `setData` whose graph has only node `z`. `resetView()` falls back to the bounds → `translate(440px, 250px) scale(1)`.
- **Unsized view.** `fixedResult()`, no `setSize`, `resetView()` → transform stays `translate(0px, 0px) scale(1)` (the existing test at [line 578](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L578)), and additionally `view._needsInitialCentre === true`; a following `setSize` + `doLayout()` then lands the centring.
- **No graph laid out at all.** A **sized** view with no `data` ever set, `resetView()` → transform stays `translate(0px, 0px) scale(1)`. (Previously `centreGraph` wrote `translate(640px, 400px)` here, centring a zero-sized graph at the viewport centre; there is nothing to centre, so now nothing is written.)

**Centring a node fits it in the viewport:**
- `initialFocusNode: 'a'`, `oversizedNodeResult()`, sized before the layout lands → `translate(-64px, 48px) scale(0.64)`.
- `revealNode('a')` on the same sized, settled view → the same `translate(-64px, 48px) scale(0.64)`. Follow the shape of the existing `revealNode` test at [line 845](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L845).
- **The zoom is never raised.** `zoom: 0.5` + `initialFocusNode: 'a'`, `fixedResult()`, sized → `translate(620px, 382.5px) scale(0.5)`: node `a` fits many times over at 0.5, and the configured zoom stands.
- **The configured `minZoom` cannot block the fit.** `minZoom: 1` + `initialFocusNode: 'a'`, with a result whose node `a` *is* the whole graph — `{ nodes: [{ id: 'a', x: 0, y: 0, width: 2000, height: 1000 }], edges: [], width: 2000, height: 1000 }` — sized → `translate(0px, 80px) scale(0.64)`. `effectiveMinZoom` drops the floor to the graph's own fit zoom, which equals the node's here.
- **A reset that has to shrink.** `initialFocusNode: 'a'`, `oversizedNodeResult()`, sized, `setZoom(2)`, then `resetView()` → `translate(-64px, 48px) scale(0.64)`: the default zoom is restored first, then lowered to fit.
- **Unsized view writes neither pan nor zoom.** `zoom: 2`, `oversizedNodeResult()`, no `setSize`, `revealNode('a')` → `getZoom() === 2` and transform `translate(0px, 0px) scale(2)`.
- Every existing test in the `revealNode` ([line 844](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L844)), initial-centring ([line 613](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L613)), and `initialFocusNode` / `focusNode` ([line 1411](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1411)) blocks stays green with no edit — all of them use `fixedResult()`, whose nodes fit the viewport many times over.

### Manual verification (needs the running app, a real ELK worker, and a browser)

The library's offline harness records DOM writes rather than laying out real geometry, and never paints, so anything below that depends on a real card's measured height, a real drag, or a visible clip has no automated red-green cycle. Log in with Host **`sqladmin-db`** under Compose (**`localhost`** when the backend runs natively).

- **Reset returns to the root — Relation diagram.** Right-click a table → *Open relation diagram*. Drag the graph far off-screen, then click the crosshairs (Reset) button at the bottom right of the canvas: the root table's card lands centred, whole.
- **Reset after a depth change.** In the same panel, set *Depth* to `3` or `All` and wait for the re-layout, then click Reset. The root card is centred and fully visible — this is the reported defect.
- **A root card taller than the viewport.** Shrink the browser window (or drag the dock divider) until the root card is taller than the diagram canvas, then click Reset: the view zooms out far enough to show the whole card, and no further.
- **Reset with no root.** Right-click a schema → *Open schema diagram* (no `initialFocusNode`): Reset still centres the whole graph, as before.
- **Open-time fit.** Open the relation-rooted dependency graph, the relation-rooted inheritance graph, the role-membership graph, and the role grants graph. Each opens with its root centred and its whole card visible.
- **Explain diagram cross-selection.** Run *Explain diagram* from a query panel, then click rows in the tree and the steps table. Each selection reveals the matching card; a card taller than the canvas zooms out to fit rather than being clipped.
- **Panning is still free.** After a Reset, drag the empty canvas: the pan is unchanged in feel and is not snapped back.

---

## Verification

- **Library**, in `/home/jika/typescript/typescript-ui`: `npm test`, `npm run lint`, `npm run docs:api` (zero warnings apart from typedoc's pre-existing "unsupported TypeScript version" notice).
- **Library build**: `npm run build:lib` — **not** `npm run build`. SQLAdmin imports typescript-ui's built `dist/lib` through a gitignored symlink, so the app sees a library edit only after `build:lib` runs in `packages/lib`.
- **App typecheck**: `cd /home/jika/typescript/sqladmin/frontend && npm run typecheck` — requires the rebuilt library.
- **App unit tests**: `cd /home/jika/typescript/sqladmin/frontend && npm test` — regression check only; no app test covers the diagram panels (they import UI-bundle modules that touch `document` at load).
- **Grep invariants**, in `../typescript-ui/packages/lib/src`:
  - `grep -n "centreGraph()" typescript/lib/component/diagram/DiagramView.ts` — three matches: the declaration plus the calls in `zoomToFit` and `tryInitialCentre`.
  - `grep -n "applyTransformToHost()" typescript/lib/component/diagram/DiagramView.ts` — `centreNode` is not among the hits.
  - `grep -nE "The zoom is left|left alone|selection, zoom" typescript/lib/component/diagram/DiagramView.ts` — zero matches: no surviving claim that a node centring leaves the zoom alone.
- **Manual smoke**: the list above. Entry points: `SqlAdminController.openRelationDiagram`, `openSchemaDiagram`, `openRelationDependencyGraph`, `openRelationInheritanceGraph`, `openRoleMembershipDiagram`, `openRoleGrantsDiagram`, and `QueryPanel`'s *Explain diagram* button.

---

## Documentation Impact

No new public symbol: `DiagramView` and `DiagramViewOptions` are already re-exported from `component/diagram/index.ts`, and `zoomFittingNode` is private. So no barrel, sidebar, catalog, or `llms.txt` change — `llms.txt` is generated from `scripts/llms/manifest.data.mjs` and carries no diagram entry. `docs/api/**` is gitignored TypeDoc output; `npm run docs:api` rewrites the `DiagramView` class page and the `DiagramViewOptions` interface page from the JSDoc.

`../typescript-ui/packages/lib/docs/components/DiagramView.md`:
- **Common methods** table ([lines 107-110](../typescript-ui/packages/lib/docs/components/DiagramView.md#L107)) — rewrite the `resetView()` row as "Reset to the default zoom, then re-centre on the focus node (`initialFocusNode`, or the last `focusNode` target) if there is one, else on the graph bounds." Rewrite the `revealNode(id)` row: it centres the node and lowers the zoom if the node does not fit whole, never raises it, and still changes no selection and emits nothing. Extend the `focusNode(id)` row the same way.
- **Interaction → Initial view** bullet ([line 125](../typescript-ui/packages/lib/docs/components/DiagramView.md#L125)) — replace "either way the zoom is untouched": the configured zoom stands unless the focus node is too large to fit the viewport, in which case it is lowered until the node fits. The "it does **not** auto-fit" sentence about the *graph* stays true and unchanged.
- **Interaction → Zoom** bullet ([line 129](../typescript-ui/packages/lib/docs/components/DiagramView.md#L129)) — add `revealNode` / `focusNode` to the list of methods that can change the zoom, noting they only ever lower it.

`../typescript-ui/packages/lib/docs/reference/changelog.md`, all under the existing unreleased `## 0.3.0` heading (no version bump — the coordinated 0.3.0 release is a separate step):
- **Amend** the `DiagramView.focusNode(id)` bullet ([line 54](../typescript-ui/packages/lib/docs/reference/changelog.md#L54)) and the `DiagramViewOptions.initialFocusNode` bullet ([line 58](../typescript-ui/packages/lib/docs/reference/changelog.md#L58)) — both are unreleased, so correct them in place rather than contradicting them later in the same file. Drop "the configured `zoom` is left alone either way" and state the node-fit exception.
- **Add** under `### Changed` ([line 24](../typescript-ui/packages/lib/docs/reference/changelog.md#L24)): `revealNode(id)` now lowers the zoom when the named node is too large to fit the viewport whole, so a centred node is never clipped. It never raises the zoom, so a node that already fits is centred at the current zoom exactly as before. (`revealNode` shipped in 0.1.0, so this is a change to released behaviour, not an addition.)
- **Add** under `### Fixed` ([line 91](../typescript-ui/packages/lib/docs/reference/changelog.md#L91)): `resetView()` now returns to the focus node rather than always to the graph bounds, so on a rooted diagram the built-in Reset control brings the root back instead of centring a graph the root may sit far outside — which is what made Reset look broken after a live `setData` re-layout grew the graph around the existing pan.

App side: nothing. `TODO.md` never listed this defect, and `LIBRARY_NOTES.md` records library defects the app *works around* — this plan removes the defect instead.

---

## Potential Challenges

- **A once-zoomed-out view stays zoomed out.** Revealing a huge node lowers the zoom, and revealing a small one afterwards does not raise it back — so `ExplainDiagramPanel`'s cross-selection can leave the user zoomed out after one large card. Deliberate: silently raising the zoom on every reveal would fight the user's own wheel-zoom. Reset and the zoom-in button both recover it.
- **`resetView` on an unsized view now leaves the centring armed.** A Reset that could not land is retried on the next layout pass, which also means a `setData` before that pass re-centres. Only reachable before the first sizing, where there is no user pan to protect.
- **Two sibling plans in this round also edit `DiagramView.test.ts`.** Add the new tests as two fresh `describe` blocks at the end of the file rather than extending existing ones, so the chained rebase resolves cleanly.
- **`getPreferredSize()` returns `Size | null`.** `centreNode`'s existing `!size` guard already covers it; do not drop that guard when rewriting the body.

---

## Critical Files

- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts) — read, in this order: `focusNode` (1044, the precedent `resetView` mirrors), `tryInitialCentre` (807, the selector being reused), `centreGraph` (832), `centreNode` (1004), `resetView` (756), `setZoom` (719), `clampZoom` (916), `effectiveMinZoom` (893), `zoomAboutViewportPoint` (862, the pan-then-`setZoom` write shape), `zoomToFit` (737, the no-padding fit precedent), `applyLayout` (584) and `doLayout` (1152) for where `tryInitialCentre` is retried from.
- [`../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts`](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts) — `StubEngine`'s three modes (27), `StubDiagramView` (66), `flush()` (73), `fixedResult()` (84), `parseTransform` (97), the two-call custom stub (1306), and the four blocks the new tests sit beside: `resetView` (562), initial centring (613), `revealNode` (844), `initialFocusNode` / `focusNode` (1411). The file-level comment at line 129 explains why only the first `describe` may dispatch real DOM events — the new blocks must not.
- [`../typescript-ui/CODE_CONVENTIONS.md`](../typescript-ui/CODE_CONVENTIONS.md) — *Don't `{@link}` internal symbols from public JSDoc*: the new `revealNode` / `focusNode` / `initialFocusNode` wording must describe the node-fit behaviour in prose, never `{@link}` the private `zoomFittingNode` or `centreNode`.
- [`../typescript-ui/packages/lib/docs/components/DiagramView.md`](../typescript-ui/packages/lib/docs/components/DiagramView.md) — the curated page; the three edits above.
- [`frontend/src/dock/ExplainDiagramPanel.ts`](frontend/src/dock/ExplainDiagramPanel.ts) — line 198's `selectNode(id).revealNode(id)` is the one app call site whose behaviour changes; read it to confirm no app edit is needed.

---

## Non-Goals

- **Re-arming the initial centring on every `setData`.** Rejected: it breaks the one-shot rule two existing tests pin, and would yank a pan the user deliberately dragged to on every depth step.[^no-rearm-on-setdata]
- **Renaming `tryInitialCentre` or `_needsInitialCentre`.** Already a stated Non-Goal of [`plans/diagram-layout-settled-and-root-focus.md`](plans/diagram-layout-settled-and-root-focus.md), and renaming would edit `applyLayout` and `doLayout`, which the sibling `diagram-update-busy-overlay` plan owns.
- **Padding or a margin around the fitted node.** `zoomToFit` fits the graph edge-to-edge with no inset; the node fit follows that precedent.
- **Changing `zoomToFit`.** It fits and centres the *graph* and is correct as it stands.
- **Auto-fitting the graph on open.** Unchanged: a graph larger than the viewport still overflows at the configured zoom. Only a focus *node* that does not fit lowers the zoom.
- **Any app-side change.** No app code depends on the old behaviour.
- **A version bump or publish step.** The coordinated 0.3.0 release is a separate step the user owns; only changelog entries under the existing `## 0.3.0` heading belong here.
- **The layout pipeline and the click/pan handlers.** `doLayout` / `applyLayout` / `settleLayout` belong to the sibling `diagram-update-busy-overlay` plan; `_handleClick` / `_handlePointerDown` and node emphasis belong to `diagram-emphasis-and-pan-interaction`. Keep this plan's edits inside the viewport / zoom / centring methods.

---

## Notes

[^reuse-flag]: The alternative was to extract the focus-node-else-graph choice out of `tryInitialCentre` into a `centreOnFocusOrGraph()` helper that both it and `resetView` call. Rejected: arming `_needsInitialCentre` is not a workaround but the whole point — it also gives `resetView` the retry `focusNode` gets, so a Reset clicked before the view is sized lands on the next layout pass instead of being silently dropped. The extraction would have added a method and lost that, and `focusNode` at line 1044 already establishes arm-then-`tryInitialCentre` as this file's idiom for "centre on my target".

[^fit-in-centrenode]: The alternative was to fit only on the reset path, leaving `revealNode` and the initial centring pan-only. Rejected on three counts. All four callers mean "show me this node", and a centring that clips it fails all of them identically — two different meanings for "centre on a node" would be a second behaviour to document, test, and choose between at each call site. The initial centring is where the user actually meets the bug: four app panels pass `initialFocusNode`, so a root card taller than the canvas is clipped on *open*, before any Reset. And the blast radius is narrow either way, because the zoom only moves when the node genuinely does not fit — every existing test uses a node that fits many times over, and all of them stay green untouched.

[^clamp-cannot-block]: A node's box lies inside the graph bounds on both axes, so `graphWidth >= nodeWidth` and `graphHeight >= nodeHeight`, hence `min(vw/nodeW, vh/nodeH) >= min(vw/graphW, vh/graphH)` — the node's fit zoom is at or above the graph's. `effectiveMinZoom` returns `min(configuredMin, graphFitZoom)`, which is at or below the graph's fit zoom, so it is always at or below the node's. The `minZoom: 1` test case in `## Expected Behaviour` pins this: the floor drops to 0.64 and the node still fits.

[^no-rearm-on-setdata]: Fix 1 alone resolves the reported symptom — "Reset view does not seem to work properly after updating a live diagram" is exactly "Reset does not bring the root back", and Reset now does. Re-arming on `setData` as well would additionally re-centre without being asked, which breaks two tests that deliberately pin the one-shot rule ("centres only the first layout — a later setData leaves the current pan alone", [line 693](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L693), and "is one-shot: a later setData does not re-yank a pan the user has since dragged to", [line 1467](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1467)). Those tests encode a real requirement: the rooted panels call `setData` on every Direction, Depth, prune, legend, and coverage toggle, so re-centring per `setData` would snap the viewport back on every one of them while the user is reading some other part of the graph. Re-arming per *viewport resize* is worse still and is not on the table — `anchorCentreAcrossResize` ([line 1172](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1172)) already holds the centre point still across a resize precisely so the view does not move on its own.
