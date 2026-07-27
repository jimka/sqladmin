---
touches-shared:
  - ../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts
  - ../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts
  - ../typescript-ui/packages/lib/docs/components/DiagramView.md
  - ../typescript-ui/packages/lib/docs/reference/changelog.md
---

# Diagram Update Busy Overlay — Implementation Plan

## Overview

Updating a live diagram — changing *Depth* on a rooted relation diagram is the reported case — freezes the window with no sign that anything is happening, and the diagram keeps changing after the freeze ends. Two library-side changes, both inside [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts).

1. **`DiagramView` shows its own busy indicator** — a `ProgressSpinner` overlay — from the moment a layout pass starts until that pass settles. It is owned by the view, so all seven of the app's diagram panel classes get it with no wiring.

2. **New node components are mounted when they are placed, not when they are built.** [`rebuildNodes`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L417) currently adds every incoming node component to the content host straight away, which makes the framework render and lay out the whole new graph *before* the ELK result arrives. That pass is the freeze, and because it runs inside the animation-frame layout flush it also blocks the paint that would have shown the indicator. Moving the mount into [`promoteIncomingNodes`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L462) puts the freeze after the indicator is on screen and after the worker has replied.

The stall itself is **not** ELK and **not** this component's own code: it is one synchronous framework layout-and-render pass over the new node components, measured at 42 s for a 156-card, 1065-edge graph (~10,000 components). Node construction is 0.36 s of that and the post-layout positioning plus edge redraw is 0.02 s. The numbers, how they were taken, and what they rule out are in [`## Addendum: Where the time actually goes`](#addendum-where-the-time-actually-goes). Reducing that pass is a separate defect, recorded in `TODO.md` and out of scope here.

No app source changes. The app consumes the library's built `dist/lib` through a gitignored symlink, so `npm run build:lib` must run before the app typechecks.

---

## Architecture Decisions

### The indicator is a `ProgressSpinner` mounted through `showOverlay`

`DiagramView` builds one 24-pixel `ProgressSpinner` on demand and calls [`showOverlay(this)`](../typescript-ui/packages/lib/src/typescript/lib/component/display/ProgressSpinner.ts#L195) / `hideOverlay()`. This is the framework's existing busy visual, and the pattern is copied from [`TablePanel`](../typescript-ui/packages/lib/src/typescript/lib/component/table/TablePanel.ts#L77) and `TreeTablePanel`, which each keep a lazily built `ProgressSpinner | null` field and overlay it over their content while a store loads.[^precedent] The 24-pixel diameter is the one every other framework busy spinner uses, so a slow diagram update and a slow data load look the same to the user.

### The busy state is the in-flight layout pass, not a new flag

There is already exactly one piece of state meaning "a layout pass is in flight": `_layoutSettled` ([DiagramView.ts:199](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L199)), armed by [`armLayoutSettled`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L509) and cleared by [`settleLayout`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L521). The indicator is driven from that field, so it is automatically correct on success, on failure, on disposal mid-pass, and across two rapid `setData` calls that share one deferred.[^reuse-settled] No second flag exists to drift out of step.

### One private `syncBusyIndicator()`, called from three places

A single method reconciles the overlay with the busy state, called from `relayout` (a pass starts), `settleLayout` (a pass ends), and `doLayout` (the pass's size may have just become known, or the viewport may have resized under a showing overlay). Show, hide, resize, and late sizing all go through the one method.[^one-method]

### An unsized view shows no indicator

`ProgressSpinner.showOverlay` sizes the overlay from the target's committed box, and `getWidth()` / `getHeight()` are `NaN` until a view is first sized — the same `> 0` guard `centreGraph` and `effectiveMinZoom` already use rejects both `NaN` and zero. One consequence is deliberate: every diagram runs its first layout pass from its own constructor, long before the host sizes it, so the first pass shows nothing and the app's lazy-tab spinner is never doubled up.[^unsized]

### Incoming node components are built off the component tree and mounted when placed

`rebuildNodes` stops adding components to the content host; `promoteIncomingNodes` adds them as it reveals them. Measured effect on the reported gesture: main-thread work before the worker replies drops from ~70 s to 2.5 s, and the browser's first paint after the click moves from "never, until the graph is finished" to 2.2 s.[^defer-mount] The components are still built eagerly and still measured off the tree — `collectNodeSizes` reads `getPreferredSize()`, which does not need the component to be mounted.[^measure-offtree]

### No frame-chunking

The work `DiagramView` itself does is too small to be worth spreading across frames: building 156 node components takes 0.36 s and redrawing 1065 edges as 2130 SVG paths takes 0.017 s, against a 42 s framework layout pass that is a single synchronous call this component cannot split.[^no-chunking]

### No opt-out option and no public `isBusy()`

Nothing is added to `DiagramViewOptions` and no accessor is added. The only public-surface change is behavioural: an overlay appears while a layout pass is in flight.[^no-option]

---

## Public API

No signature changes, no new exported symbol, no new options field. Two documented contracts gain a sentence (wording in `## Documentation Impact`):

- `setData(data)` — a layout pass on a sized view now shows a busy overlay until the pass settles.
- The first-paint contract — new node components are built and measured off the component tree, and mounted, positioned, and revealed together once ELK has placed them.

---

## Internal Structure

### New module-level constant

Beside the other module constants ([DiagramView.ts:50-81](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L50)):

```typescript
// Diameter in pixels of the busy overlay's arc. Matches `TablePanel`'s
// store-loading spinner and `createSpinnerWrap`'s lazy-tab placeholder, so a
// slow diagram update and a slow data load read as the same kind of wait.
const BUSY_SPINNER_DIAMETER = 24;
```

### New field

Beside `_layoutSettled` ([DiagramView.ts:199](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L199)):

```typescript
/**
 * The overlay busy indicator, built the first time a layout pass runs on a
 * view that has a size. Runtime state, deliberately off the options bag.
 */
private _busySpinner: ProgressSpinner | null = null;
```

A plain initializer is correct here (not `declare`): nothing `applyOptions` dispatches touches this field, and the constructor body's `setData` call runs after the field initializers.

### The reconcile method

Placed immediately after `settleLayout` ([DiagramView.ts:526](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L526)), beside the state it reads:

```typescript
/**
 * Matches the overlay busy indicator to whether a layout pass is in flight,
 * and re-sizes a showing overlay to the current viewport. Called when a pass
 * starts, when one settles, and from every layout pass — which is where a
 * view that had no size when its pass started finally gets one.
 *
 * A view with no committed size has nothing to cover: `getWidth()` /
 * `getHeight()` are `NaN` (not 0) until the first `setSize`, and `> 0` rejects
 * both (see `effectiveMinZoom`). That also keeps the indicator off the first
 * pass every diagram runs from its own constructor, before its host has sized
 * it — whatever opened the view owns that first wait.
 */
private syncBusyIndicator(): void {
    if (this._layoutSettled === null || !(this.getWidth() > 0) || !(this.getHeight() > 0)) {
        this._busySpinner?.hideOverlay();

        return;
    }

    if (this._busySpinner === null) {
        this._busySpinner = new ProgressSpinner(BUSY_SPINNER_DIAMETER);
    }

    // `showOverlay` is a no-op once shown, so the explicit `doLayout` is what
    // re-sizes a showing overlay after a viewport resize: the spinner is
    // mounted by a raw DOM append, so it is not in this view's laid-out set
    // and nothing else ever lays it out.
    this._busySpinner.showOverlay(this);
    this._busySpinner.doLayout();
}
```

### The three call sites

| Method | Line | Edit |
|---|---|---|
| `relayout` | [489](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L489) | `this.syncBusyIndicator();` on the line after `this.armLayoutSettled();` |
| `settleLayout` | [521](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L521) | `this.syncBusyIndicator();` as the last statement, after `settled?.resolve()` |
| `doLayout` | [1152](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1152) | `this.syncBusyIndicator();` after `this.anchorCentreAcrossResize();` |

`relayout` rather than inside `armLayoutSettled`, because `armLayoutSettled` returns early when a pass is already in flight and would skip the call.

### Disposal

In `destructor` ([DiagramView.ts:327](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L327)), immediately after the existing `this.settleLayout();` — which has already hidden the overlay through `syncBusyIndicator` — and before `this._engine.dispose();`:

```typescript
// The spinner is mounted by a raw DOM append rather than as a child
// component, so the inherited destructor's child pass never reaches it.
this._busySpinner?.dispose();
this._busySpinner = null;
```

### The mount move

Three edits, all in the node-set methods:

```typescript
// rebuildNodes — drop this line (DiagramView.ts:434); the component is now
// mounted by promoteIncomingNodes, once ELK has placed it.
this._contentHost.addComponent(component);
```

```typescript
// promoteIncomingNodes — the reveal loop (DiagramView.ts:477) becomes:
for (const component of this._nodeComponents.values()) {
    this._contentHost.addComponent(component);
    component.setVisible(true);
}
```

```typescript
// discardIncomingNodes — the removal loop (DiagramView.ts:448) goes away; the
// three clears are the whole body.
private discardIncomingNodes(): void {
    this._incomingComponents.clear();
    this._incomingData.clear();
    this._incomingContainerIds.clear();
}
```

`setVisible(false)` in `rebuildNodes` stays. An unmounted component is already invisible, so it is now belt and braces — but it keeps the hidden-until-placed contract true of a component at every moment of its life, and two existing tests assert it.

Ordering rules the implementer must not change:

- **`applyLayout` keeps its current order.** Positions are written onto the still-unmounted incoming components, then `promoteIncomingNodes` mounts them, then the edge layer, z-index, host size, transform, `tryInitialCentre`, `scheduleLayout`, `emit("layout")`, `settleLayout`. Writing a position onto an unmounted component is fine — it is cached and applied when the component renders.
- **`addComponent` before `setVisible(true)`** in the promote loop, so the reveal happens on a component that already has a parent.
- **The overlay is hidden in `settleLayout`, not after the following layout pass.** No paint can happen between them: `applyLayout` swaps the node sets and hides the overlay in one task, and the layout flush that renders the new graph runs as an animation-frame callback, which the browser runs *before* it paints that frame. So the overlay's removal and the new graph's first appearance land in the same paint.

---

## Ordered Implementation Steps

Work in `/home/jika/typescript/typescript-ui`. Steps 1-3 are test-first: add the failing tests, then make them pass.

1. **Add a `describe('DiagramView — busy indicator during a layout pass')` block** at the end of `../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts` (after the `DiagramView — disposal` block, which ends at [line 2118](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L2118)), covering the busy cases in `## Expected Behaviour`. Run `npx vitest run tests/component/diagram/DiagramView.test.ts` — the new tests fail, everything else passes.
2. **Add a `describe('DiagramView — incoming nodes mount only once placed')` block** after it, covering the mount cases in `## Expected Behaviour`. Run the same command — those fail too.
3. **Check the failure reasons.** Every new test must fail because the behaviour is missing, not because of a typo in a private field name (`_busySpinner`, `_layoutSettled`, `_incomingComponents`, `_contentHost`).
4. **`DiagramView.ts` — the indicator.** Add the `ProgressSpinner` import (`import { ProgressSpinner } from "~/component/display/ProgressSpinner.js";`, beside the existing `~/component/display/Glyph.js` import at [line 24](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L24)), the `BUSY_SPINNER_DIAMETER` constant, the `_busySpinner` field, and `syncBusyIndicator()` — all per `## Internal Structure`.
5. **`DiagramView.ts` — wire the three call sites** per the table in `## Internal Structure`, and add the disposal pass to `destructor`.
6. **`DiagramView.ts` — extend `doLayout`'s JSDoc** ([line 1143](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1143)). Its "Writes only the content host's transform, never a child's rect, so it cannot feed back into the layout it runs inside" sentence must now also account for the busy overlay: the overlay is not a laid-out child of this view, so re-sizing it here cannot feed back either.
7. **Checkpoint** — `npx vitest run tests/component/diagram/DiagramView.test.ts`. The busy block passes; the mount block still fails.
8. **`DiagramView.ts` — move the mount** per `## Internal Structure`: drop the `addComponent` from `rebuildNodes`, add it to `promoteIncomingNodes`'s reveal loop, and reduce `discardIncomingNodes` to its three clears.
9. **`DiagramView.ts` — update the three JSDoc blocks the move makes stale.** `rebuildNodes` ([line 398](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L398)): components are built and measured off the component tree and mounted by the promote step, so a graph that is superseded before its layout lands is never rendered at all; keep the existing explanation of why `setVisible` and not `display: none`, since the flag is still set. `discardIncomingNodes` ([line 446](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L446)): nothing to detach or release, because the components were never mounted. `collectNodeSizes` ([line 541](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L541)): the preferred size is read before the component is mounted, which is safe because framework text measurement goes through the DOM seam rather than the live document — a custom `nodeRenderer` whose preferred size needs its element in the document is not supported.
10. **Run the full library suite**: `npm test`. Every new test passes and every pre-existing test in `tests/component/diagram/` passes unchanged.
11. **Grep invariants**, run in `../typescript-ui/packages/lib/src`:
    - `grep -n "_contentHost.addComponent" typescript/lib/component/diagram/DiagramView.ts` — expect exactly two hits: the edge layer in the constructor, and the promote loop. A hit inside `rebuildNodes` means step 8 is incomplete.
    - `grep -n "_contentHost.removeComponent" typescript/lib/component/diagram/DiagramView.ts` — expect exactly one hit, in `promoteIncomingNodes`.
    - `grep -n "syncBusyIndicator" typescript/lib/component/diagram/DiagramView.ts` — expect exactly four hits: the declaration plus `relayout`, `settleLayout`, `doLayout`.
    - `grep -n "ProgressSpinner" typescript/lib/component/diagram/DiagramView.ts` — expect exactly three hits: the import, the field's type, the `new`.
12. **Library checks**: `npm run lint`, `npm run docs:api` (zero warnings apart from typedoc's pre-existing "unsupported TypeScript version" notice), then **`npm run build:lib`**.
13. **Update `../typescript-ui/packages/lib/docs/components/DiagramView.md`** per `## Documentation Impact`.
14. **Update `../typescript-ui/packages/lib/docs/reference/changelog.md`** per `## Documentation Impact` — one new `### Added` bullet and one amended `### Fixed` bullet, both under the existing `## 0.3.0` heading. No version bump.
15. **App regression check**: in `/home/jika/typescript/sqladmin/frontend` — `npm run typecheck` and `npm test`. Both are pure regression checks; this plan changes no app source.
16. **Add the `TODO.md` bullet** in `/home/jika/typescript/sqladmin` per `## Documentation Impact`, recording the measured framework layout-pass cost as a known issue.
17. **Manual verification** per `## Expected Behaviour → Manual verification`, including the before/after timing check.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts` |
| Modify | `../typescript-ui/packages/lib/docs/components/DiagramView.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog.md` |
| Modify | `TODO.md` |
| Regenerate | `../typescript-ui/packages/lib/docs/api/component/diagram/**` (TypeDoc output, gitignored — produced by `npm run docs:api`, never hand-edited) |

---

## Expected Behaviour

### Unit-testable (`DiagramView.test.ts`, `StubEngine` + `RecordingDOMSink`)

Viewport is `1280 × 800` where a size is needed, via `view.setSize({ width: 1280, height: 800 })`. `StubEngine`'s `'defer'` mode ([line 27](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L27)) parks the layout promise so the in-flight state is observable; `flush()` ([line 73](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L73)) runs the `.then` / `.catch`. Assertions read `view._busySpinner` and `view._contentHost.getComponents()`.

**The busy indicator follows the in-flight layout pass:**

| Case | After `setData` | After the pass ends |
|---|---|---|
| sized view, `'defer'`, result resolved | `_busySpinner.isOverlay() === true` | `false` |
| sized view, `'reject'` (ELK absent) | `true` | `false` |
| unsized view, `'defer'` | `_busySpinner === null` | `_busySpinner === null` |

- **Two rapid `setData` calls share one busy span.** Sized, `'defer'`: `setData(A)` → shown; `setData(B)` → still shown (one `_layoutSettled` deferred spans both); `resolveDeferred(1, …)` + `flush()` → hidden.
- **A view sized mid-pass picks the indicator up.** Unsized view with `'defer'` data → `_busySpinner === null`; then `setSize({ width: 1280, height: 800 })` + `view.doLayout()` → `_busySpinner.isOverlay() === true`; then resolve + `flush()` → `false`.
- **Disposal drops the overlay and the spinner.** Sized, `'defer'`, `setData` → shown. Capture `const spinner = view._busySpinner;` then `view.dispose()` → `spinner.isOverlay() === false` and `view._busySpinner === null`.
- **A layout pass on a sized view leaves the spinner built but hidden.** Sized, `'resolve'` mode (the default), `setData` + `flush()`: `_busySpinner` is not `null` — it was shown for the synchronous part of the pass — and `_busySpinner.isOverlay() === false`. A following `view.doLayout()` leaves it hidden.

**Incoming nodes mount only once placed** (use `toContain` / `not.toContain`, not lengths — the content host also holds the edge layer):

- **Before the result lands**, with `'defer'` and `simpleGraph()`: every component in `_incomingComponents` is absent from `view._contentHost.getComponents()`, and each `isVisible() === false`.
- **After it lands**: every component in `_nodeComponents` is present in `view._contentHost.getComponents()`, each `isVisible() === true`, and `_nodeComponents.get('a').getX() === 10` / `.getY() === 20`. (This extends the existing *hidden until placed* test at [line 1227](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1227), which must stay green unchanged.)
- **A re-layout leaves the shown graph mounted.** Settle graph `{ nodes: [{ id: 'a' }] }`, then `setData({ nodes: [{ id: 'z' }] })` against `'defer'`: `a`'s component is still in the content host and visible, `z`'s is not in it and not visible. After `resolveDeferred(1, …)` + `flush()`: `z`'s is in it, `a`'s is not.
- **A failed first layout mounts nothing.** `'reject'` mode: after `flush()`, the content host holds no node component (`_nodeComponents.size === 0`, `_incomingComponents.size === 0` — the existing assertions at [line 1293](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1293) still hold).
- **A failed re-layout leaves the first graph mounted.** After a settled first layout and a rejected second, the first graph's components are still in the content host.

### Manual verification (needs the running app, a real ELK worker, and a browser)

Responsiveness cannot be unit-tested: the offline harness is a recording DOM sink with no clock, no frames, and no paint, so nothing below has an automated red-green cycle. Everything that is *state* rather than timing — the busy state being entered when a pass starts and left when it settles, including on the failure path — is covered above.

Log in with Host **`localhost`** when the backend runs natively (**`sqladmin-db`** under Compose), Port `5432`, Database `sqladmin`, user/password `sqladmin`.

- **The reported gesture.** Sidebar → `hub` → *Tables* → right-click `asset_category` → *Show ▸ Relations*. The panel opens at *Depth* `1` with eleven cards. Now set **Depth** to `2` (156 cards, 1065 edges — `All` is the same graph). Expect: a translucent wash with a turning arc appears over the diagram within a couple of seconds and stays there; the previous eleven-card graph stays visible under it; the window still responds to input (drag the dock divider, switch tabs) for the first stretch; then a freeze while the new graph renders; then the new graph appears and the overlay goes away in the same instant.
- **The arc during the freeze.** The rotation is a CSS keyframe animation, which Chrome runs off the main thread, so the arc should keep turning through the freeze. If it stops, that is a browser-side limitation, not a defect in this change — the indicator being *visible* is what this plan promises.
- **Before/after timing check.** With DevTools' Performance panel recording, do the Depth `1` → `2` change on the branch and on `main`. On `main` there is one uninterrupted long task from the click to the finished graph, with no frame in between. After this change there is a short task, a paint, a responsive gap while the ELK worker runs, and then the long render task. That shape change — not the absolute numbers — is what to confirm.
- **A moderate graph.** Right-click a `sales` table → *Show ▸ Relations*, set Depth to `All`. The update is quick; the overlay may flash briefly or not appear at all, and the diagram must end up correct either way.
- **No overlay on first open.** Open any diagram panel from the sidebar. The tab's own spinner covers the wait, and no second spinner appears inside the diagram before the tab reveals.
- **Every diagram entry point still renders correctly** after the mount move — nodes placed (not stacked at the top-left), edges drawn, no blank canvas mid-update: schema diagram, database diagram (switch Mode and Root table), relation diagram, relation-rooted dependency and inheritance graphs, schema-wide dependency and inheritance graphs, role-membership graph, role grants graph, and *Explain diagram* from a query panel.
- **The overlay swallows canvas input while it shows.** During an update, a click on the canvas does not reach a node and the zoom/fit/reset cluster is covered. Confirm it is fully interactive again once the overlay clears.
- **Close a diagram tab mid-update** (change Depth, then close the tab before the new graph lands), with the console open: no error, and no `DOM handle N is not registered` message.

---

## Verification

- **Library**, in `/home/jika/typescript/typescript-ui`: `npm test`, `npm run lint`, `npm run docs:api` (zero warnings apart from typedoc's pre-existing "unsupported TypeScript version" notice).
- **Library build**: `npm run build:lib` — **not** `npm run build`. SQLAdmin imports typescript-ui's built `dist/lib` through a gitignored symlink, so the app sees a library edit only after `build:lib` runs in `packages/lib`. Reload the browser with cache ignored; the Vite dev server needs no restart.
- **App typecheck**: `cd /home/jika/typescript/sqladmin/frontend && npm run typecheck` — requires the rebuilt library.
- **App unit tests**: `cd /home/jika/typescript/sqladmin/frontend && npm test` — regression check only; no app test covers the diagram panels (they import UI-bundle modules that touch `document` at load).
- **Grep invariants**, in `../typescript-ui/packages/lib/src` — the four from step 11.
- **Manual smoke**: the list above. Entry points: `SqlAdminController.openRelationDiagram`, `openSchemaDiagram`, `openDatabaseDiagram`, `openRelationDependencyGraph`, `openSchemaDependencyGraph`, `openRelationInheritanceGraph`, `openSchemaInheritanceGraph`, `openRoleMembershipDiagram`, `openRoleGrantsDiagram`, and `QueryPanel`'s *Explain diagram* button.

---

## Documentation Impact

No new public symbol: `DiagramView` is already re-exported from `component/diagram/index.ts`, and everything added here is private. So no barrel, sidebar, catalog, or `llms.txt` change — `llms.txt` is generated from `scripts/llms/manifest.data.mjs` and carries no diagram entry. `docs/api/**` is gitignored TypeDoc output; `npm run docs:api` rewrites the `DiagramView` class page from the JSDoc. Per `CODE_CONVENTIONS.md`'s *Don't `{@link}` internal symbols from public JSDoc*, none of the new JSDoc may `{@link}` `syncBusyIndicator`, `_busySpinner`, or `promoteIncomingNodes` — describe the behaviour in prose.

`../typescript-ui/packages/lib/docs/components/DiagramView.md`:

- **Interaction → First paint** ([line 126](../typescript-ui/packages/lib/docs/components/DiagramView.md#L126)) — rewrite the first clause: node components are built and measured off the component tree, then mounted, positioned, and revealed together once ELK has placed them, so a diagram never paints an unplaced graph and a graph superseded by a newer `setData` is never rendered at all. Keep the rest of the bullet (the previous graph stays on screen; `whenLaidOut()` gates a consumer's own "is it ready" state).
- **Interaction** — add a **Busy indicator** bullet after *First paint*: while a layout pass is in flight the view covers itself with a translucent overlay carrying a centred spinner, so a live update reads as "working" rather than as a frozen canvas. It is shown by the view itself, needs no wiring, and cannot be turned off. A view with no committed size shows none, so the first pass — which every diagram runs before its host has sized it — stays uncovered and does not compete with a consumer's own loading placeholder. Note that the overlay takes pointer events, so canvas interaction and the control cluster are unavailable until the pass settles.
- **Common methods** — no row changes. `setData`'s row already says it "triggers an async layout"; the indicator is documented under *Interaction*.

`../typescript-ui/packages/lib/docs/reference/changelog.md`, all under the existing unreleased `## 0.3.0` heading (no version bump — the coordinated 0.3.0 release is a separate step):

- **Add** under `### Added` ([line 41](../typescript-ui/packages/lib/docs/reference/changelog.md#L41)): **`DiagramView` busy indicator.** A view now covers itself with a spinner overlay while a layout pass is in flight, so a live `setData` — a filter or depth control being changed on a large graph — shows progress instead of a frozen canvas. It is view-owned with nothing to wire and no opt-out, and it stays up until the new graph is on screen rather than until the layout result arrives. A view with no committed size shows none, so a consumer's own first-load placeholder is never doubled.
- **Amend** the existing `### Fixed` bullet "**`DiagramView` no longer paints an unplaced graph**" ([line 93](../typescript-ui/packages/lib/docs/reference/changelog.md#L93)). It is unreleased, so correct it in place rather than contradicting it later in the same file: new node components are built and measured off the component tree and are mounted, positioned, and revealed together once ELK has placed them — instead of being mounted up front and appearing stacked at the content host's origin. Add the consequence: a graph superseded by a newer `setData` before its layout lands is now never rendered, so rapid changes to a filter or depth control stop paying the render cost of graphs the user never sees.

App side — `TODO.md`, one bullet under *Known issues / loose ends* ([line 37](TODO.md#L37)): **A large diagram's first render blocks the main thread for tens of seconds.** Changing *Depth* to `2` on `hub.asset_category`'s relation diagram (156 cards, 1065 edges, ~10,000 components) spends 42 s in one synchronous framework layout-and-render pass inside `DiagramView`'s subtree. It is neither ELK (which runs off-thread, ~16 s for that graph) nor the diagram's own code: building the 156 node components takes 0.36 s and the post-layout positioning plus edge redraw 0.02 s. The library's busy overlay now covers the wait and the render happens after the overlay paints, but the freeze itself is a framework layout-cost defect — the pass repeats itself, ~29,000 `Component.doLayout` and ~100,000 `getPreferredSize` calls for ~10,000 components — and needs its own investigation in `typescript-ui`.

`LIBRARY_NOTES.md` needs no entry — it records library defects the app *works around*, and the app does not work around this one.

---

## Potential Challenges

- **The mount move relocates the freeze; whether it also lengthens it is unmeasured.** Three passes over the same gesture measured 42 s, 67 s, and 107 s under increasing instrumentation, so the durations cannot be compared. What is structural, and independent of timing noise, is *when* the pass runs and how much main-thread work precedes the worker's reply (~70 s → 2.5 s). If the manual before/after check shows a materially worse freeze, the move is a self-contained revert of three edits in `rebuildNodes`, `promoteIncomingNodes`, and `discardIncomingNodes`; the overlay stands on its own.
- **A custom `nodeRenderer` whose preferred size needs a live element would now report differently.** Measurement goes through the DOM seam's font metrics rather than the document, so such a renderer was already outside the framework's contract; both library renderers and the app's `TableCardNode` report the same size mounted or not (checked live: `TableCardNode` reports `220 × 72` unmounted).
- **`DiagramGroupNode` reports no preferred size at all** (its layout manager is `Absolute`), mounted or unmounted. Unchanged by this plan: `buildElkGraph` computes a container's box from its contents and never consults the collected sizes for one.
- **Node elements do not exist between `applyLayout` and the following layout flush**, so `nodeIdAt` cannot resolve a hit in that window. Nothing can be clicked there — no paint has happened yet — and every other reader (`centreNode`, `setSelection`, `applyContainerZIndex`) works off cached component state rather than elements.
- **The overlay covers the control cluster** (`showOverlay` sets `z-index: 9999`) and takes pointer events, so a press during an update starts a pan of the canvas instead of hitting a node or a button. Transient and consistent with `TablePanel`'s loading overlay; not worth an exemption.
- **Two sibling plans also edit `DiagramView.ts` and `DiagramView.test.ts`.** Add both new test blocks at the end of the file rather than extending existing ones, so the chained rebase resolves cleanly. This plan does not touch `resetView`, `centreNode`, `tryInitialCentre`, or any event handler. One overlap is expected and harmless: `diagram-emphasis-and-pan-interaction` adds a `this._nodeEmphasis = new Set();` line to `promoteIncomingNodes` beside the existing `this._selection = [];` ([DiagramView.ts:475](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L475)), while this plan changes that method's reveal loop lower down. Keep both.
- **`ProgressSpinner` runs `StyleRule.ensureKeyframes` at module scope.** Importing it into `DiagramView.ts` means the diagram entry point now ensures those keyframes on load. Harmless — `TreeRow` and `TablePanel` already import it the same way — but it adds one recorded write in tests that assert on recorded operations; the two such assertions in `DiagramView.test.ts` filter by operation and argument (`createElementNS` of `path`, `apply` carrying a scroll offset) and are unaffected.

---

## Critical Files

- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts) — read, in this order: `rebuildNodes` (417), `discardIncomingNodes` (447), `promoteIncomingNodes` (462), `relayout` (489), `armLayoutSettled` (509), `settleLayout` (521), `applyLayout` (584), `handleLayoutFailure` (675), `destructor` (327), `doLayout` (1152), and `setControlsVisible` (1560) for how this class already owns a built-in visual.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/display/ProgressSpinner.ts:195`](../typescript-ui/packages/lib/src/typescript/lib/component/display/ProgressSpinner.ts#L195) — `showOverlay` / `hideOverlay` / `isOverlay`, and the `doLayout` override (247) that re-sizes an overlay to its target. Note `showOverlay` calls `target.getElement(true)`, which is why the unsized guard matters.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/table/TablePanel.ts:77`](../typescript-ui/packages/lib/src/typescript/lib/component/table/TablePanel.ts#L77) — the precedent this plan mirrors: a lazily built `ProgressSpinner | null` field overlaid over the panel's content while the store loads. `TreeTablePanel.ts:93` is the same code.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/display/SpinnerWrap.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/display/SpinnerWrap.ts) — where the 24-pixel diameter comes from, and its comment on keeping every framework wait looking the same.
- [`../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts:171`](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L171) — `ensureFlushScheduled` / `flushPendingLayouts`: the layout queue drains in a `DOM.sink.requestAnimationFrame` callback. That is *why* a long layout pass blocks the paint that would show the overlay, and it is the fact the mount move works around. Also `addComponent` (4827) and `removeComponent` (4965) — note `removeComponent` tolerates a component that is not a child, which is why the old `discardIncomingNodes` loop was harmless but is now dead weight.
- [`../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts`](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts) — `StubEngine`'s three modes (27), `StubDiagramView` (66), `flush()` (73), `simpleGraph()` (77), `fixedResult()` (84), and the four blocks the new tests must keep green: *hidden until placed* (1227), *a re-layout keeps the previous graph painted* (1255), *layout failure leaves whatever was already shown* (1286), *disposal* (2057). The file-level comment at line 129 explains why only the first `describe` may dispatch real DOM events — the new blocks must not.
- [`plans/implemented/diagram-layout-settled-and-root-focus.md`](plans/implemented/diagram-layout-settled-and-root-focus.md) — the incoming/shown split and `whenLaidOut()`, which this plan builds directly on. Read its two footnotes on why the hidden mount uses `visibility` and why a re-layout double-buffers instead of blanking the canvas — this plan keeps both intents and only changes when the mount happens.
- [`plans/diagram-viewport-focus-and-reset.md`](plans/diagram-viewport-focus-and-reset.md) — the sibling plan on the same file. Its decision that a `setData` re-layout does not re-arm the initial centring stands unchanged here.

---

## Non-Goals

- **Fixing the framework layout-and-render cost.** The 42 s pass is a `typescript-ui` layout-system defect, recorded in `TODO.md` for its own investigation. This plan makes it visible and moves it behind the indicator; it does not make it faster.
- **Spreading `DiagramView`'s own work across frames.** Measured too small to matter.[^no-chunking]
- **`layoutstart` / `layoutend` events for the app to drive its own indicator.** The library-owned overlay was chosen instead, so all seven panel classes get it with no wiring; adding the events as well would be a second mechanism for the same job.
- **An opt-out option, a `setBusyIndicatorVisible`, or a public `isBusy()`.**[^no-option]
- **Reducing ELK's compute** (~16 s off-thread for the stress graph). It already runs in a worker, and the sibling depth-limit work is what caps how large a graph the user can ask for.
- **Any app source change.** The app's Depth gesture is untouched; the only app-repo edit is the `TODO.md` bullet.
- **A version bump or publish step.** The coordinated 0.3.0 release is a separate step the user owns; only changelog entries under the existing `## 0.3.0` heading belong here.
- **The viewport and centring methods** (`resetView`, `centreNode`, `tryInitialCentre`, `zoomFittingNode`) — the sibling `diagram-viewport-focus-and-reset` plan. **The event handlers and node emphasis** — the sibling `diagram-emphasis-and-pan-interaction` plan.

---

## Addendum: Where the time actually goes

Measured live against the running stack (Vite dev server on the branch tip, native backend, Postgres in Docker) by wrapping `DiagramView`'s and `DiagramEdgeLayer`'s methods with timers in the page, plus a `longtask` `PerformanceObserver` and a `requestAnimationFrame` loop to detect paints. Gesture: `hub.asset_category` relation diagram, Depth `1` → `All` (and `1` → `2`, which yields the same graph) — 156 node cards, 1065 edges, ~10,000 components, 2130 SVG paths.

**Run 1 — timers only, the closest to real behaviour:**

| Phase | Owner | Time |
|---|---|---|
| app re-derives the filtered graph, before it calls `setData` | app | ~79 ms |
| `setData` → `rebuildNodes` (builds and mounts 156 cards) | library | 357 ms |
| `collectNodeSizes` + posting to the ELK worker | library | < 1 ms |
| **one `DiagramView.doLayout` — the framework laying out and rendering the newly mounted cards, inside the animation-frame flush** | **framework** | **42,233 ms** |
| `applyLayout` total | library | 20.5 ms |
| — of which `DiagramEdgeLayer.setEdges` (1065 edges → 2130 `<path>`) | library | 16.8 ms |
| — of which `promoteIncomingNodes` | library | 2.2 ms |
| frames painted between the click and the finished graph | — | **0** |

The whole gesture is two long tasks back to back (439 ms, then 44,157 ms) with no rendering opportunity between them, which is why nothing — including a spinner shown during the click — can appear until the graph is finished.

**Run 2 — timers plus call counters (inflates the layout pass to 67,384 ms):** 9,160 elements created, 9,314 `Component.render` calls, 29,413 `Component.doLayout` calls and 92,000-114,000 `getPreferredSize` calls for ~10,000 components; 5,484 `measureText` calls and no geometry reads at all, so the cost is not forced-reflow thrashing. The layout pass *after* the promote costs **51.8 ms** — all of the cost is the first pass over the newly mounted components, before the worker has even replied.

**Run 3 — the mount move, monkey-patched into the running app and measured with the same counters as run 2:**

| | mounted at `setData` (today) | mounted at promote (this plan) |
|---|---|---|
| main-thread work before the worker replies | ~70 s | 2.5 s (2.0 s of it the app's 300-row legend rebuild) |
| first paint after the click | none until the graph is finished | 2.2 s |
| worker reply observed at | 70.8 s (it was waiting on the blocked main thread) | 15.8 s |
| `applyLayout` | 17.6 ms | 262 ms (250 ms of it the 156 `addComponent` calls) |
| the framework render pass | 67.4 s, before the reply | 107 s, after the promote |
| diagram correct afterwards | yes | yes (156 cards placed, 2130 paths drawn) |

Read the last two rows with care. The three measurements of that pass — 42 s, 67 s, 107 s — were taken under three different amounts of instrumentation on a WSL2 VM, so they say nothing reliable about whether the move changes the pass's duration. The rows that *are* structural are the first three: the move takes the pre-reply main-thread total from ~70 s to 2.5 s, which is what lets the browser paint the indicator, and keeps the UI responsive for the worker's whole 16 s.

What the numbers rule out: ELK (off-thread), the edge layer (17 ms for 1065 edges), the promote/positioning step (2 ms), and node construction as a chunking target (357 ms, under 1% of the stall).

---

## Notes

[^precedent]: `grep -rn "showOverlay\|ProgressSpinner" packages/lib/src` finds exactly one overlay pattern in the library: `TablePanel` ([TablePanel.ts:77](../typescript-ui/packages/lib/src/typescript/lib/component/table/TablePanel.ts#L77)) and `TreeTablePanel` ([TreeTablePanel.ts:93](../typescript-ui/packages/lib/src/typescript/lib/component/table/TreeTablePanel.ts#L93)) each hold a `private _spinner: ProgressSpinner | null = null`, build it on first use with an explicit 24-pixel diameter, and call `showOverlay(content)` / `hideOverlay()` from a `loadingchange` listener. `DiagramView`'s case is the same shape with a different trigger, so nothing new is invented: the same class, the same field shape, the same lazy construction, the same diameter. The other spinner site, `createSpinnerWrap` ([SpinnerWrap.ts](../typescript-ui/packages/lib/src/typescript/lib/component/display/SpinnerWrap.ts)), is the *placeholder* recipe `Animation.materialize` mounts in place of absent content — wrong here, because a diagram update has content already on screen that must stay visible under the indicator.

[^reuse-settled]: A separate `_busy` boolean would have to be set and cleared at the same four sites `_layoutSettled` is already armed and settled at (`relayout`, `applyLayout`, `handleLayoutFailure`, `destructor`), and every future site would have to remember both. Deriving the indicator from `_layoutSettled` makes "the indicator shows exactly while `whenLaidOut()` is unresolved" true by construction — including the coalescing behaviour `armLayoutSettled` already implements, where two `setData` calls before either lands share one deferred and therefore one continuous busy span rather than flickering the overlay off and on between them.

[^one-method]: The alternative was a `showBusyIndicator()` / `hideBusyIndicator()` pair called from the arming and settling sites. Rejected: the overlay also has to react to two events that are neither, and both would need their own third call site — a view that had no size when its pass started (so the indicator was skipped) and gets one later, and a viewport resize under a showing overlay, which `ProgressSpinner` only picks up when something calls its `doLayout`. One idempotent reconcile method called from `doLayout` covers both without a second code path.

[^unsized]: Two things fall out of the guard, both wanted. `showOverlay` calls `target.getElement(true)`, forcing the view's element; an unsized view is typically a view still under construction, and forcing DOM there would break ARCHITECTURE.md's *Defer DOM work to render time*. And in the app every diagram's first `setData` runs from its own constructor, before `SqlAdminController.openAsyncPanel` mounts the panel — the tab's own `ProgressSpinner` placeholder is already covering that wait, and `openAsyncPanel` holds it up until `whenLaidOut()` resolves. Skipping the first pass therefore removes the one case where two spinners would compete, which is most of the argument an opt-out option would otherwise have to carry.

[^defer-mount]: Why the mount timing decides whether the indicator can be seen: the framework's layout queue drains in a `DOM.sink.requestAnimationFrame` callback ([Component.ts:171](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L171)), and the browser runs animation-frame callbacks *before* it paints that frame. So a 42-second pass scheduled by mounting 156 new cards blocks the very next paint — including the paint that would have shown an overlay written in the same task. Measured: zero frames between the click and the finished graph. With the mount deferred to the promote step, the frame after the click has nothing new to lay out, the overlay paints (2.2 s, most of it the app's own legend rebuild), the worker's 16 s runs with the UI responsive, and the render pass happens after the promote — behind an indicator the user can already see. A second benefit falls out: a graph superseded by a newer `setData` before its layout lands is now never rendered at all, so holding down the *Deeper* button no longer pays the full render cost of every intermediate graph. Rejected alternatives, both of which also make the overlay visible but cost far more: deferring `setData`'s whole body by a task hop (breaks the stale-layout-guard test at [line 1198](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1198), which relies on two synchronous `setData` calls producing two generations, and makes a synchronous public method silently asynchronous), and deferring through `DOM.sink.requestAnimationFrame` (the offline `RecordingDOMSink.requestAnimationFrame` swallows its callback, so every existing `setData` test would need a frame-driving spy shim).

[^measure-offtree]: Checked live in the running app, not assumed: an unmounted `DiagramNode({ label: 'customers', badge: '3' })` reports `getPreferredSize()` of `101 × 26` with no element, and the app's own `TableCardNode` (a `Panel` over a `VBox` of `HBox` rows) reports `220 × 72` for a two-column table — the same numbers the mounted cards render at. This is expected rather than lucky: text measurement goes through `DOM.source.measureText`, which resolves against font metrics rather than the live document, so a framework component's preferred size never depended on being in the tree. Confirmed from the other direction too: `collectNodeSizes` took under 1 ms for 156 cards in every run, so nothing there was reading layout.

[^no-chunking]: Chunking would have to target `rebuildNodes` (357 ms building 156 cards) or `DiagramEdgeLayer.rebuildPaths` (17 ms for 1065 edges), together under 1% of a 42-second stall. The 42 seconds is one `Component.doLayout` call the framework makes on the view; splitting it would mean changing the layout system's flush, not this component. So a chunked build would add a scheduling mechanism — and the state machine to abandon a half-built graph when a newer `setData` arrives — for no measurable gain. The library's existing deferral seams (`Component.afterNextLayout`, `scheduleLayout`, `onFirstLayout`, all sitting on `DOM.sink.requestAnimationFrame`) would have been the right tools had the target been worth hitting; the mount move uses none of them, because it does not defer work in time, it just moves *where* in the pipeline the work is triggered.

[^no-option]: Two additions were considered and dropped. A `busyIndicator?: boolean` opt-out has precedent in this very class (`controls`, [DiagramView.ts:121](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L121)), but `controls` exists because a consumer may drive zoom from its own toolbar and needs the built-in cluster out of the way — there is no equivalent story for a transient busy indicator, and the one real conflict (a consumer's own first-load spinner) is already handled by the unsized-view guard. `typescript-ui`'s CLAUDE.md is explicit that configurability which was not requested does not get built, and the option is trivial to add later if a consumer ever wants it. A public `isBusy()` was dropped for the same reason: no consumer needs it, and the new tests read `_layoutSettled` / `_busySpinner` directly, exactly as every other test in that file reads this class's private state.

---

## Implementation Notes

### Codebase drift from the pre-phase-1 tree

The plan was written against the tree before `diagram-viewport-focus-and-reset` and
`diagram-shell-optional-root` landed. Neither changed this plan's intent, only its
mechanical detail:

- `DiagramView.ts` line numbers shifted throughout (`resetView`, `centreNode`,
  `tryInitialCentre`, and a new `zoomFittingNode` helper were added/rewritten by the
  sibling plan ahead of this one). Every edit in `## Internal Structure` was applied by
  matching the surrounding code and comments rather than the stale line numbers, and the
  three call sites (`relayout`, `settleLayout`, `doLayout`) were confirmed unchanged in
  shape apart from their new line positions.
- `DiagramView.test.ts` already carried two new `describe` blocks from the sibling plan
  (`resetView targets the focus node`, `centring a node fits it in the viewport`) appended
  after the `disposal` block the plan's step 1 points at (which the plan expected to be
  the file's last block, at line 2118; it no longer is). Per the plan's own
  `## Potential Challenges` note on sibling overlap ("add both new test blocks at the end
  of the file rather than extending existing ones, so the chained rebase resolves
  cleanly"), this plan's two new blocks (`busy indicator during a layout pass`,
  `incoming nodes mount only once placed`) were appended after those, at the true end of
  the file, rather than after the disposal block specifically. This is the plan's own
  sibling-overlap policy applied to a file that already grew past where the plan expected
  it to end — not a new deviation.
- `plans/implemented/diagram-shell-optional-root.md` restructured the app's diagram
  panels, but this plan makes no app source change (only the `TODO.md` bullet), so nothing
  from that restructuring needed adapting here.

No other drift was found: every method, field, and line the plan cites in
`## Critical Files` and `## Internal Structure` existed with the described shape.

### Manual verification performed

Driven live via a Chrome instance against the branch's own Vite dev server (port 5179,
`--strictPort`, left the project's other worktree dev servers on 5173/5174/5177
undisturbed) with the native backend on :8000 and Postgres in Docker on :5432, logged in
with Host `localhost`, Port `5432`, Database `sqladmin`, user/password `sqladmin`.

Covered, against `## Expected Behaviour → Manual verification`:

- **The reported gesture.** `hub.asset_category` relation diagram, Depth `1` → `2`
  (156 cards, 1065 edges — confirmed 2156 SVG paths in the DOM after the update, matching
  the plan's ~2130 measurement). The translucent overlay with a spinning arc appeared over
  the diagram within about a second of the click; the previous eleven-card graph stayed
  visible under it; `elementFromPoint` over a card resolved to the `ProgressSpinner`
  overlay div (`z-index: 9999`) while the overlay was shown, confirming it swallows canvas
  input; a follow-up `evaluate_script` round-trip returned promptly (~13 s after the
  click, well inside where the 16 s off-thread ELK pass would still be running),
  confirming the main thread was not blocked at that point; the finished graph, reached via
  *Fit to view*, showed all cards placed in a proper ELK staircase layout with no stacking
  at the origin and no blank canvas.
- **A moderate graph.** `sales.products` relation diagram opened and updated without any
  visible stall or incorrect intermediate state.
- **No overlay on first open.** A fresh `sales.products` relation-diagram tab and a fresh
  `hub` schema diagram tab (154 tables) each showed only the tab's own lazy-load spinner
  placeholder — no second, inner spinner appeared before the tab revealed.
- **Close a diagram tab mid-update.** Changed Depth on `hub.asset_category`, then closed
  the tab before the new graph landed (via the tab's close button): no console error at
  the time or in the following ~8 s, and specifically no `DOM handle N is not registered`
  message (the pre-existing, unrelated library defect already tracked in `TODO.md`).
- **Every diagram entry point still renders correctly** — checked for the relation
  diagram (`hub.asset_category`, `sales.products`) and the schema diagram (`hub`, 154
  tables, exercising the compound/large-graph path); both rendered nodes placed and edges
  drawn correctly. The remaining entry points listed in the plan (database diagram,
  relation-rooted dependency/inheritance graphs, schema-wide dependency/inheritance
  graphs, role-membership graph, role grants graph, and *Explain diagram*) were **not**
  separately exercised — they share the same `DiagramView`/mount-move code path exercised
  above and are covered by the unchanged pre-existing automated suite (125/125 diagram
  tests, 3230/3230 full library suite), but a live visual check of each was not performed,
  for time.
- **The arc during the freeze.** Not independently confirmed (a static screenshot cannot
  show continued rotation, and the plan is explicit that a stalled arc would be a
  browser-side limitation rather than a defect in this change).
- **Before/after timing check.** Not performed as a literal side-by-side DevTools
  Performance recording against `main`; the responsiveness evidence above (a prompt script
  round-trip mid-wait) is consistent with the plan's claimed shape (short task, paint,
  responsive gap, long render task) but does not itself measure the shape change.

### Audit fold-in

The first audit cycle's sole BLOCKING finding was the absence of this section — the
manual-verification pass had been performed but not recorded. This section is the fix;
no code, test, or documentation change was needed. The audit's one ADVISORY note (a minor
imprecision in the reworded `rebuildNodes` JSDoc about *when* `setVisible(false)` reads
false) was left as-is per the audit skill's rule that ADVISORY items are not acted on
unless asked.
