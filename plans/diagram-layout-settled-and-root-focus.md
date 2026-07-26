---
touches-shared:
  - ../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts
  - frontend/src/SqlAdminController.ts
  - frontend/src/dock/RelationDiagramPanel.ts
  - frontend/src/dock/DatabaseDiagramPanel.ts
  - frontend/src/dock/RelationGraphPanel.ts
  - frontend/src/dock/RoleGrantsDiagramPanel.ts
  - frontend/src/dock/ExplainDiagramPanel.ts
---

# Diagram Layout Settled & Root Focus — Implementation Plan

## Overview

Three linked fixes to the diagram layout lifecycle. All three are mostly library work in the sibling repo `../typescript-ui`, consumed by the app through a `file:` dependency, so every library step lands before the app typechecks.

1. **Nodes no longer paint before they are placed.** Opening a schema diagram today shows every node stacked in the top-left corner until the ELK result lands, then they snap into position. [`DiagramView.rebuildNodes`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L366) mounts each node component with no `x`/`y` — so all of them sit at the content host's origin — and only then starts the async layout in [`relayout`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L408). Positions arrive later, in [`applyLayout`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L462), a full Web Worker round-trip after first paint. The fix mounts new node components hidden and reveals them in `applyLayout`; a *re-*layout keeps the previous graph painted and swaps the two sets in one step. A new awaitable `whenLaidOut()` lets the app hold the lazy tab's spinner up until placement.

2. **The first render centres the root node** instead of the graph's bounds, for the diagrams that have a root. A new `initialFocusNode` option plus an imperative `focusNode(id)` generalise the existing one-shot initial centring ([`tryInitialCentre`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L678)) from "centre the bounds" to "centre this node". The zoom is left alone — no zoom-to-fit.

3. **Disposing a component mid-transition no longer logs a stray error.** Closing a diagram tab while a fade is still running logs one uncaught `DOM handle N is not registered (released or never minted)`. `Component.destructor()` releases the element handles, then the pending transition's deferred inline-style write resolves one of them. `Component.destructor()` gains a cancel pass over the transitions still running against the handles it is about to release.

The app side is small: one shared wait inside [`SqlAdminController.openAsyncPanel`](frontend/src/SqlAdminController.ts#L2939), a `whenLaidOut()` forwarder on the two composite panels opened as tabs, and a root node named at each rooted entry point.

---

## Architecture Decisions

### Hidden-until-placed uses `visibility`, and a re-layout double-buffers

A new node component is mounted with `setVisible(false)` — CSS `visibility: hidden`, not `display: none` — and revealed in `applyLayout`.[^visibility] A `setData` on a view that already has a laid-out graph keeps that graph mounted and visible while a second set of node components is built hidden alongside it; `applyLayout` then removes the old set and reveals the new one in one step.[^double-buffer]

### `whenLaidOut()` is one deferred hung off the layout generation token

`relayout` arms a single promise; `applyLayout`, `handleLayoutFailure`, and `destructor` all settle it. The two layout-result settle sites already sit behind the `_layoutGeneration` guard ([DiagramView.ts:177](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L177)), so a stale pass cannot settle a newer wait, and two rapid `setData` calls share one deferred that the later pass resolves. It never rejects — a failed layout resolves too, so a caller awaiting first paint is never left hanging.[^never-rejects]

### The initial view centres a node by generalising the existing retry, not by calling `revealNode`

`tryInitialCentre` gains a target: a node id when one is set, the graph's bounds otherwise. It keeps its existing shape — retried from `applyLayout` and from every [`doLayout`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L949), with the pending flag cleared only on a confirmed centring. That retry is the precedent this decision follows: the graph bounds and the viewport size arrive asynchronously in either order, and the same race defeats an app-side `revealNode` call from a `"layout"` listener.[^retry-precedent]

### `initialFocusNode` is cached in `applyOptions` and dispatched from the constructor body

`applyOptions` only writes `this._options.initialFocusNode`; the constructor body seeds the runtime field from it before dispatching `setData`. This mirrors how `data` and `controls` are already handled in the same class ([DiagramView.ts:322-324](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L322)) — both are cached during the `super()` cascade and dispatched afterwards, because the effect needs state the constructor body builds.

### The app waits in one place, probing for the method optionally

`openAsyncPanel` awaits the built panel's `whenLaidOut()` when it has one, before registering the panel for disposal. One wait covers all nine diagram entry points, and the six non-diagram ones resolve at once. The optional-method probe mirrors [`DiagramView.applySelectedVisual`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L884), which reaches a custom node renderer's `setSelected` the same way.[^one-place]

### The stray-handle error is fixed by cancelling in `destructor()`, not by tolerating a released handle

A framework-internal registry maps a `Handle` to the cancel functions of the transitions running against it. `Animation.play` registers on start and unregisters on finish or cancel; `Component.destructor()` cancels every entry for each handle it is about to release. This mirrors `pendingLayouts.delete(this)` in the same destructor ([Component.ts:742](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L742)) — the identical fix for the identical class of bug, module-level deferred work outliving the component that queued it — and generalises what `Dialog.destructor()` ([Dialog.ts:1163](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L1163)) and `Notification.destructor()` ([Notification.ts:644](../typescript-ui/packages/lib/src/typescript/lib/overlay/Notification.ts#L644)) already do by hand.[^tolerate-rejected]

### The transition at fault is `Tab`'s cross-tab fade, not a diagram animation

`DiagramView` runs no entry or fit animation. The transition that fires when a diagram tab is closed just after its spinner clears is `Tab._tabFadeAnimation` ([Tab.ts:1898](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1898)), the fade that plays when the selected tab's content changes. It is cancelled only in `Tab.detach()` ([Tab.ts:970](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L970)) — not when the faded tab is closed.[^which-transition] `TODO.md`'s entry attributes it to a diagram animation and must be corrected.

---

## Public API

### `DiagramView` — new options field

```typescript
export interface DiagramViewOptions extends PanelOptions {
    // ...existing data / nodeRenderer / groupRenderer / layoutOptions /
    // elkWorkerUrl / elkWorkerFactory / minZoom / maxZoom / zoom / controls /
    // listeners...

    /**
     * Id of the node the one-shot initial view centres on, instead of the
     * graph's bounds. An id naming no node in the graph falls back to
     * centring the bounds. The configured `zoom` is left alone either way.
     */
    initialFocusNode?: string;
}
```

Backing runtime field: `private _focusNodeId: string | null = null`, seeded from `this._options.initialFocusNode` in the constructor body and re-pointed by `focusNode`. Not on the options bag as a mutable property — the option is construction-time intent; `focusNode` is the runtime verb.

### `DiagramView` — new methods

```typescript
/**
 * Resolves once the layout pass currently in flight has finished placing
 * nodes. Resolves immediately when no pass is in flight, and resolves (never
 * rejects) when a pass fails or the view is disposed mid-pass.
 *
 * @returns A promise settling on the next finished layout pass.
 */
whenLaidOut(): Promise<void>;

/**
 * Centres the given node in the viewport, retrying after each layout pass
 * until it succeeds — unlike `revealNode`, which centres only when the graph
 * and the viewport are both already measured. The zoom is left unchanged.
 *
 * @param id - The node id to centre on.
 *
 * @returns This view, for method chaining.
 */
focusNode(id: string): this;
```

`revealNode(id)` keeps its signature and its "no retry" contract; its body now delegates to the shared private `centreNode(id)`.

### App — `whenLaidOut()` forwarders

```typescript
// frontend/src/dock/RelationDiagramPanel.ts
// frontend/src/dock/DatabaseDiagramPanel.ts — identical body
whenLaidOut(): Promise<void>;   // returns this.view.whenLaidOut()
```

`SchemaDiagramPanel`, `RelationGraphPanel`, and `RoleGrantsDiagramPanel` extend `DiagramView` and inherit it.

---

## Internal Structure

### The two node sets

`DiagramView` keeps its three existing maps as the **shown** set and adds three **incoming** ones:

```typescript
/** Node components keyed by node id — the graph currently on screen. */
private _nodeComponents: Map<string, Component> = new Map();
private _nodeData:       Map<string, DiagramNodeData> = new Map();
private _containerIds:   Set<string> = new Set();

/**
 * The graph built by the latest `setData`, mounted hidden and awaiting a
 * layout. Promoted into the shown set by `applyLayout`, discarded by
 * `handleLayoutFailure` or by the next `rebuildNodes`.
 */
private _incomingComponents:  Map<string, Component> = new Map();
private _incomingData:        Map<string, DiagramNodeData> = new Map();
private _incomingContainerIds: Set<string> = new Set();
```

Everything that reads the *on-screen* graph — `nodeIdAt`, `setSelection`, `applyContainerZIndex`, `revealNode`, `centreNode` — keeps reading the shown maps unchanged. Only `rebuildNodes`, `collectNodeSizes`, the node-positioning loop in `applyLayout`, and the two new helpers below touch the incoming maps.

Two new private helpers:

```typescript
/** Removes the un-promoted incoming components from the host and forgets them. */
private discardIncomingNodes(): void;

/**
 * Swaps the incoming set in for the shown one: removes the shown components
 * from the content host, promotes the incoming maps, clears the selection,
 * and reveals every promoted component.
 */
private promoteIncomingNodes(): void;
```

`rebuildNodes` starts with `discardIncomingNodes()` (so a second `setData` before the first landed does not leak the first's components), builds each component, calls `component.setVisible(false)` on it, and adds it to the content host. The two lines it loses — `this._selection = []` and `this._edgeLayer.setEdges([])` — move into `promoteIncomingNodes` and `applyLayout` respectively, so neither the selection nor the painted edges are dropped before the swap.

`applyLayout`'s order after the generation guard: position the incoming nodes → record `_graphWidth`/`_graphHeight` → `promoteIncomingNodes()` → the existing edge-layer block → `applyContainerZIndex()` → content-host size + transform → `tryInitialCentre()` → `scheduleLayout()` → `emit("layout")` → `settleLayout()`.

### The layout-settled deferred

```typescript
/** Resolver for the promise `whenLaidOut` handed out, or null when idle. */
private _layoutSettled: { promise: Promise<void>; resolve: () => void } | null = null;
```

```typescript
/**
 * Arms the awaitable `whenLaidOut` hands out, so one deferred spans however
 * many layout passes run before one of them finishes.
 */
private armLayoutSettled(): void {
    if (this._layoutSettled !== null) {
        return;
    }

    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });

    this._layoutSettled = { promise, resolve };
}

/** Settles the armed `whenLaidOut` awaitable, if there is one. */
private settleLayout(): void {
    const settled = this._layoutSettled;

    this._layoutSettled = null;
    settled?.resolve();
}
```

`relayout` calls `armLayoutSettled()` before starting the engine. `applyLayout`, `handleLayoutFailure`, and `destructor` call `settleLayout()`. `whenLaidOut()` returns `this._layoutSettled?.promise ?? Promise.resolve()`.

### The initial view's target

`tryInitialCentre` picks between the two targets, degrading to the bounds when the focus id names no node in the graph just promoted:

```typescript
private tryInitialCentre(): void {
    if (!this._needsInitialCentre || !(this._graphWidth > 0) || !(this._graphHeight > 0)) {
        return;
    }

    const focus = this._focusNodeId !== null && this._nodeComponents.has(this._focusNodeId)
        ? this._focusNodeId
        : null;

    if (focus !== null ? this.centreNode(focus) : this.centreGraph()) {
        this._needsInitialCentre = false;
    }
}
```

| `_focusNodeId` | in the graph? | view sized? | outcome | still pending? |
|---|---|---|---|---|
| `null` | — | yes | graph bounds centred | no |
| `"users"` | yes | yes | `users` centred | no |
| `"users"` | yes | no | nothing written | yes — retried from `doLayout` |
| `"gone"` | no | yes | graph bounds centred | no |

`centreNode(id)` is `revealNode`'s current body, extracted and given a boolean result, with one change: it reads the node's extent from `getPreferredSize()` rather than `getWidth()`/`getHeight()`.[^preferred-size]

```typescript
private centreNode(id: string): boolean {
    const component = this._nodeComponents.get(id);
    const size      = component?.getPreferredSize();

    if (!component || !size) {
        return false;
    }

    const zoom = this.getZoom();

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

    this.applyTransformToHost();

    return true;
}
```

`focusNode(id)` sets `_focusNodeId`, re-arms `_needsInitialCentre`, and calls `tryInitialCentre()`; the `doLayout` retry covers the not-yet-sized case.

### The pending-transition registry

New framework-internal module `core/PendingTransitions.ts`, importing nothing but `type { Handle }`:

```typescript
/** Cancel functions of the transitions still running against each handle. */
const running: Map<Handle, Set<() => void>> = new Map();

export function registerTransition(handle: Handle, cancel: () => void): void;
export function unregisterTransition(handle: Handle, cancel: () => void): void;
/** Invokes and forgets every cancel function registered for `handle`. */
export function cancelTransitions(handle: Handle): void;
```

It is a leaf module so neither `Animation.ts` (which imports `Component`) nor `Component.ts` gains a cycle, following `core/ClassStyleRules.ts` and `core/ComponentDefaults.ts` — framework-internal core modules deliberately absent from `core/index.ts`.

`Animation.play` names its cancel function, registers it, and unregisters from both `finish()` and `cancel()`:

```typescript
const cancel = (): void => {
    if (done || cancelled) {
        return;
    }

    cancelled = true;

    if (frameId !== null) {
        DOM.sink.cancelAnimationFrame(frameId);
        frameId = null;
    }

    if (timerId !== null) {
        DOM.sink.clearTimeout(timerId);
        timerId = null;
    }

    unregisterTransition(el, cancel);
};
```

`finish()` adds `unregisterTransition(el, cancel);` immediately after `done = true;`, and the function returns `{ cancel }`. The reduced-motion early return keeps returning `NOOP_HANDLE` — it writes synchronously, so there is nothing to register. `registerTransition(el, cancel)` runs once, just before the `if (config.from)` branch.

`Component.destructor()` cancels immediately before its handle-release loop ([Component.ts:818](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L818)):

```typescript
// Abandon every transition still running against a handle released below. A
// pending deferred write — Animation.play's two-frame entrance dance, or the
// `transition: null` reset its completion performs — would otherwise resolve a
// released handle and throw, exactly the stale-deferred-work hazard
// `pendingLayouts.delete(this)` drops at the top of this method.
for (const handle of this._ownedHandles) {
    cancelTransitions(handle);
}
```

### The app's one shared wait

Module-private in `frontend/src/SqlAdminController.ts`, beside the existing module-level helpers:

```typescript
/** The optional hook a diagram-bearing panel exposes so its tab can wait for placement. */
interface LayoutSettlingPanel {
    whenLaidOut(): Promise<void>;
}

/**
 * Hold a lazy tab's spinner until the panel's diagram has placed its nodes, so
 * no tab is ever revealed showing an unplaced graph. The method is probed
 * optionally: the non-diagram panels openAsyncPanel builds do not have it and
 * resolve at once.
 *
 * @param content - The freshly built panel.
 *
 * @returns A promise resolving once the panel's first diagram layout settled.
 */
function awaitDiagramLayout(content: Component): Promise<void> {
    const panel = content as unknown as Partial<LayoutSettlingPanel>;

    return panel.whenLaidOut?.() ?? Promise.resolve();
}
```

---

## Ordered Implementation Steps

### Library — `../typescript-ui` (do first; the app typechecks against the built output)

1. **New `packages/lib/src/typescript/lib/core/PendingTransitions.ts`** — the three exported functions and the module-level `running` map per _Internal Structure_. Add a module header stating it is framework-internal and not exported from `core/index.ts`. Do **not** touch `core/index.ts`.

2. **New `packages/lib/tests/core/DisposedPendingTransition.test.ts`** — written before the two edits below, so it starts red. Mirror `tests/core/DisposedPendingLayout.test.ts`: the same `DOM.sink.requestAnimationFrame` spy shim and `flushFrame()` helper, and the same "assert on whether the write happened, not on `not.toThrow()`" discipline its header explains. Cover the _Expected Behaviour → transition cancellation_ cases.

3. **`packages/lib/src/typescript/lib/core/Animation.ts`** — import `registerTransition` / `unregisterTransition` from `~/core/PendingTransitions.js`. In `play` ([Animation.ts:98](../typescript-ui/packages/lib/src/typescript/lib/core/Animation.ts#L98)): hoist the returned handle's body into a named `const cancel` declared before `finish` ([Animation.ts:121](../typescript-ui/packages/lib/src/typescript/lib/core/Animation.ts#L121)), add the `unregisterTransition` calls to `cancel` and `finish`, call `registerTransition(el, cancel)` before the `if (config.from)` branch, and return `{ cancel }`. Extend `play`'s `@returns` remark in prose — do not `{@link}` the internal module.

4. **`packages/lib/src/typescript/lib/core/Component.ts`** — import `cancelTransitions` from `~/core/PendingTransitions.js` and add the cancel loop immediately before the `DOM.sink.release(handle)` loop in `destructor()`.

5. **Checkpoint** — `npm test` in `../typescript-ui`. The new file's cases pass and the whole existing suite stays green before continuing.

6. **`.../component/diagram/DiagramView.ts` — the two node sets.** Add the three `_incoming*` fields; add `discardIncomingNodes()` and `promoteIncomingNodes()`; rewrite `rebuildNodes` ([DiagramView.ts:366](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L366)) per _Internal Structure_ (leading `discardIncomingNodes()`, `setVisible(false)` per component, writes into the incoming maps, and the `_selection` / `setEdges([])` lines removed); point `collectNodeSizes` ([DiagramView.ts:430](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L430)) at `_incomingComponents`; point `applyLayout`'s positioning loop at `_incomingComponents` and insert `this.promoteIncomingNodes();` right after the `_graphWidth` / `_graphHeight` assignments; make `handleLayoutFailure` ([DiagramView.ts:547](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L547)) call `discardIncomingNodes()` instead of clearing the shown maps.

7. **`DiagramView.ts` — the settled deferred.** Add `_layoutSettled`, `armLayoutSettled()`, `settleLayout()`, and the public `whenLaidOut()`. Call `armLayoutSettled()` at the top of `relayout`; call `settleLayout()` at the end of `applyLayout`, at the end of `handleLayoutFailure`, and in `destructor()` right after the `_layoutGeneration += 1` bump ([DiagramView.ts:296](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L296)).

8. **`DiagramView.ts` — the root focus.** Add `initialFocusNode` to `DiagramViewOptions` and its cache line to `applyOptions`; add the `_focusNodeId` field and seed it in the constructor body before the `if (this._options.data)` block; extract `centreNode(id)` from `revealNode` ([DiagramView.ts:828](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L828)) and reduce `revealNode`'s body to `this.centreNode(id); return this;`; rewrite `tryInitialCentre` per _Internal Structure_; add the public `focusNode(id)`.

9. **`.../component/diagram/index.ts`** — no change: `DiagramViewOptions` is already re-exported, and the new members ride along.

10. **`packages/lib/tests/component/diagram/DiagramView.test.ts`** — add the cases from _Expected Behaviour → DiagramView_. Also touch two existing tests, whose assertions no longer pin what they were written to pin:
    - the ELK-absent test (`does not throw synchronously and leaves the view empty when layout rejects`) gains `expect(view._incomingComponents.size).toBe(0)`;
    - `D4: a layout rejecting after disposal does not strip the view's nodes` must drop its `await flush()` before `dispose()` so the first layout is genuinely in flight, and assert `expect(view._incomingComponents.size).toBe(2)` instead of on `_nodeComponents` — the incoming set is what `handleLayoutFailure` now clears, so it is the only observable that proves the generation guard dropped the stale failure. Update its comment to match.

11. **`packages/lib/docs/components/DiagramView.md`** — per _Documentation Impact_.

12. **`packages/lib/docs/reference/changelog.md`** — add entries under the unreleased `## 0.3.0` heading: `### Added` for `whenLaidOut()`, `focusNode(id)`, and `initialFocusNode`; a `### Fixed` subsection (create it after `### Added`) for the released-handle error and the unplaced-graph paint.

13. **Checkpoint** — in `../typescript-ui`: `npm test`, then `npm run lint` (the `local/no-raw-dom` baseline is empty — `PendingTransitions.ts` holds handles and closures only, never a DOM reference), then `npm run docs:api` (must finish with zero warnings), then **`npm run build:lib`**. The app cannot typecheck until `build:lib` has succeeded.

### App — `sqladmin/frontend`

14. **`frontend/src/dock/RelationDiagramPanel.ts`** — pass `initialFocusNode: root.id` in the `DiagramView({ ... })` local ([RelationDiagramPanel.ts:97](frontend/src/dock/RelationDiagramPanel.ts#L97)); add the `whenLaidOut()` forwarder returning `this.view.whenLaidOut()`.

15. **`frontend/src/dock/DatabaseDiagramPanel.ts`** — add the `whenLaidOut()` forwarder. Do **not** pass `initialFocusNode`: the panel opens in Overview mode with no root. Instead, in the `rootControl.on("change")` handler ([DatabaseDiagramPanel.ts:207](frontend/src/dock/DatabaseDiagramPanel.ts#L207)), after `this.rebuildBase()`, add `if (this.rootId !== null) { this.view.focusNode(this.rootId); }`.

16. **`frontend/src/dock/RelationGraphPanel.ts`** — forward the constructor's existing `rootId` parameter into `super({ data, nodeRenderer, elkWorkerFactory, initialFocusNode: rootId })` ([RelationGraphPanel.ts:53](frontend/src/dock/RelationGraphPanel.ts#L53)). It is already `string | undefined`, so the two unrooted callers (the schema-wide dependency and inheritance graphs, which pass `undefined`) stay unrooted with no further change.

17. **`frontend/src/dock/RoleGrantsDiagramPanel.ts`** — before `super`, derive the centre node id from the graph and pass it:
    ```ts
    const roleNodeId = data.nodes.find(n => (n.data as GrantNodeData | undefined)?.kind === "role")?.id;

    super({ data, elkWorkerFactory, initialFocusNode: roleNodeId });
    ```
    `GrantNodeData` is already imported there.

18. **`frontend/src/dock/ExplainDiagramPanel.ts`** — pass `initialFocusNode: roots[0]?.id` in the `new DiagramView({ ... })` call. No `whenLaidOut()` forwarder: this panel is mounted synchronously by `QueryPanel.showDiagramTab` with no spinner to hold.

19. **`frontend/src/dock/SchemaDiagramPanel.ts`** — no change. The schema-wide diagram has no root, so it keeps centring the graph's bounds, and it inherits `whenLaidOut()` from `DiagramView`.

20. **`frontend/src/SqlAdminController.ts`** — add the module-level `LayoutSettlingPanel` interface and `awaitDiagramLayout(content)` helper next to the existing module-level helpers (around [SqlAdminController.ts:135](frontend/src/SqlAdminController.ts#L135)), using the `as unknown as Partial<…>` probe idiom. In `openAsyncPanel`'s `content` callback, insert `await awaitDiagramLayout(content);` between `const content = await build();` and the `if (token)` block — **before** `settle`, so a tab closed during the wait leaves the panel unregistered and `settle` disposes it rather than handing a disposed component back to the library.

21. **`TODO.md`** — rewrite the "Disposing a component mid-transition throws a stray console error" bullet under _Known issues / loose ends_ as **resolved pending release**. It must now say: the transition was `Tab`'s cross-tab content fade, **not** a diagram entry/fit animation; the fix is the pending-transition cancel pass in `Component.destructor()`; and the app reaches that fix only through the dev symlink until typescript-ui publishes it — the same caveat the following `"@jimka/typescript-ui": "^0.2.0"` bullet already records. Keep it in _Known issues / loose ends_ so the unpublished-dependency caveat stays visible; it is removed when that version-range bullet is.

22. **Checkpoint** — `cd frontend && npm run typecheck` (needs step 13's `build:lib`), then `npm test`.

23. **Manual verification** — per _Verification_.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Create | `../typescript-ui/packages/lib/src/typescript/lib/core/PendingTransitions.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/core/Animation.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts` |
| Create | `../typescript-ui/packages/lib/tests/core/DisposedPendingTransition.test.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts` |
| Modify | `../typescript-ui/packages/lib/docs/components/DiagramView.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog.md` |
| Modify (generated) | `../typescript-ui/packages/lib/docs/api/component/diagram/**` — TypeDoc output, produced by `npm run docs:api`; never hand-edited |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` |
| Modify | `frontend/src/dock/RoleGrantsDiagramPanel.ts` |
| Modify | `frontend/src/dock/ExplainDiagramPanel.ts` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `DiagramView` (`DiagramView.test.ts`, `StubEngine` + `RecordingDOMSink`)

**Hidden until placed** (`StubEngine` in `'defer'` mode, graph `simpleGraph()`, result `fixedResult()`):
- Before the deferred layout resolves: `_incomingComponents.size === 2`, every incoming component's `isVisible() === false`, and `_nodeComponents.size === 0`.
- After it resolves: `_nodeComponents.size === 2`, every one's `isVisible() === true`, `_incomingComponents.size === 0`, and `_nodeComponents.get('a').getX() === 10` / `.getY() === 20`.

**A re-layout keeps the previous graph painted:**
- Settle a first layout, then `setData` a graph with different ids against a `'defer'` engine. Before the second result lands, `_nodeComponents` still holds the *first* graph's ids with `isVisible() === true`, and `_incomingComponents` holds the second graph's, hidden.
- After it lands, `_nodeComponents` holds only the second graph's ids.
- The existing stale-layout-guard test still passes unchanged: a newer `setData` resolving first, then the older one, leaves only the newer graph (`_nodeComponents.has('a') === false`, `get('z').getX() === 9`).

**Layout failure** (`'reject'` mode):
- A failed first layout leaves both sets empty (`_nodeComponents.size === 0`, `_incomingComponents.size === 0`) and `getSelection()` empty.
- A failed *re*-layout after a settled first one leaves the first graph shown: `_nodeComponents.size === 2`.

**`whenLaidOut()`:**
- On a view with no data ever set, resolves immediately.
- With a layout in flight (`'defer'`), resolves once the result is delivered.
- With a layout in flight that rejects, resolves — it does not reject.
- With a layout in flight, resolves when `dispose()` is called and the result never arrives.
- Two `setData` calls before either lands share one promise, resolved by the second pass (assert reference equality of the two `whenLaidOut()` results, and that it resolves after `resolveDeferred(1, …)`).

**`initialFocusNode` / `focusNode`** (viewport 1280×800, `fixedResult()`: node `a` at `(10, 20, 60, 30)`, node `b` at `(100, 200, 60, 30)`, graph `160×230`):
- `initialFocusNode: 'a'`, sized before the layout lands → transform `translate(600px, 365px) scale(1)`.
- `initialFocusNode: 'a'`, **not** sized when the layout lands → transform stays `translate(0px, 0px) scale(1)`; then `setSize({ width: 1280, height: 800 })` + `doLayout()` → `translate(600px, 365px) scale(1)`.
- `initialFocusNode: 'nope'` (no such node), sized → falls back to the bounds: `translate(560px, 285px) scale(1)`.
- No `initialFocusNode` → `translate(560px, 285px) scale(1)`, unchanged from today.
- One-shot: after the initial focus lands, a hand-written pan followed by `setData(simpleGraph())` leaves the pan alone.
- `focusNode('b')` on a settled, sized view → `translate(510px, 185px) scale(1)`.
- `focusNode('a')` on an unsized view writes nothing; a later `setSize` + `doLayout()` → `translate(600px, 365px) scale(1)`.
- `revealNode`'s two existing tests stay green unchanged.

### Unit-testable — transition cancellation (`DisposedPendingTransition.test.ts`)

- A `Component` whose element is rendered, with an `Animation.play` entrance (`from: { opacity: '0' }`) started against it: after `component.dispose()`, driving both captured animation frames performs **no** `apply` write carrying a `transition` style, and no `apply` write at all against the released handle.
- The control case: without `dispose()`, driving both frames **does** write the `transition` style.
- After `dispose()`, advancing timers past `durationMs + 40` performs no `apply` write (the fallback timer was disarmed).
- `registerTransition(h, fn)` then `unregisterTransition(h, fn)` then `cancelTransitions(h)` does not invoke `fn` — a completed transition leaves no entry behind.

### Manual verification (needs the running app, a real ELK worker, and a browser)

Everything on the app side is manual-verify only. `frontend/tests/` runs in vitest's node environment over pure data helpers; the diagram panels and `SqlAdminController` import UI-bundle modules that touch `document` at load, so `awaitDiagramLayout`, the `whenLaidOut()` forwarders, and every `initialFocusNode` call site have no automated red-green cycle available.

Log in with Host **`sqladmin-db`** (not `localhost`).

- **Schema diagram** — right-click a schema → *Open schema diagram*. The tab spinner stays up until the nodes are placed; there is no moment where nodes are stacked in the top-left corner. Same for the database diagram, the dependency and inheritance graphs (schema-wide and relation-rooted), the role-membership graph, and the role grants graph.
- **Root focus** — the relation-rooted diagram, the relation-rooted dependency and inheritance graphs, the role-membership graph, and the role grants graph all open with their root/centre node in the middle of the viewport, at the default zoom, with the graph not scaled to fit. The schema-wide diagram and the schema-wide dependency/inheritance graphs still open centred on the whole graph.
- **Database diagram root** — switch to Tables mode and pick a *Root table*: the view re-lays out and centres on that table.
- **No blank flash mid-session** — in the relation-rooted diagram change Direction, Depth, *Hide with prune*, the coverage checkbox, and a legend checkbox; in the database diagram change Mode (Overview ↔ Tables), Root table, Direction, Depth, prune, and a per-schema legend checkbox; drill into a schema from Overview. Each re-layout keeps the previous graph on screen until the new one appears — the canvas never goes blank.
- **Explain diagram** — run *Explain diagram* from a query panel. The plan diagram's tab now shows an empty canvas for the ELK round-trip rather than bunched nodes (this surface has no spinner), then appears with the plan root centred.
- **No stray handle error** — open a diagram tab and close it within roughly a third of a second of the spinner clearing, several times, with the console open. No `DOM handle N is not registered (released or never minted)` appears. Repeat while switching between two diagram tabs quickly.

---

## Verification

- **Library**: in `../typescript-ui` — `npm test`, `npm run lint`, `npm run docs:api` (zero warnings), `npm run build:lib`.
- **App typecheck**: `cd frontend && npm run typecheck` — requires the rebuilt library.
- **App unit tests**: `cd frontend && npm test` — no app test covers the diagram panels (they import UI-bundle modules that touch `document`), so this is a regression check only.
- **Grep invariants** (run in `../typescript-ui/packages/lib/src`):
  - `grep -n "setEdges(\[\])" typescript/lib/component/diagram/DiagramView.ts` — expect zero matches (the clear moved out of `rebuildNodes`).
  - `grep -n "PendingTransitions" typescript/lib/core/index.ts` — expect zero matches (framework-internal, deliberately unexported).
  - `grep -n "_nodeComponents\|_incomingComponents" typescript/lib/component/diagram/DiagramView.ts` — read every hit: `rebuildNodes`, `collectNodeSizes`, `discardIncomingNodes`, and `applyLayout`'s node-positioning loop must name only `_incomingComponents`; every other site must name only `_nodeComponents`, and `promoteIncomingNodes` is the one place both appear.
- **Manual smoke**: the _Manual verification_ list above. Entry points: `SqlAdminController.openSchemaDiagram`, `openDatabaseDiagram`, `openRelationDiagram`, `openSchemaDependencyGraph`, `openRelationDependencyGraph`, `openSchemaInheritanceGraph`, `openRelationInheritanceGraph`, `openRoleMembershipDiagram`, `openRoleGrantsDiagram`, and `QueryPanel`'s *Explain diagram* button.

---

## Documentation Impact

`DiagramViewOptions` and `DiagramView` are already re-exported from `component/diagram/index.ts`, so the new members reach the public API with no barrel change. `docs/api/**` is committed TypeDoc output: `npm run docs:api` rewrites the `DiagramView` class page and the `DiagramViewOptions` interface page. Commit those regenerated files; never hand-edit them. `PendingTransitions.ts` is absent from `core/index.ts`, so TypeDoc does not see it — which is also why `Animation.play`'s JSDoc must describe the cancellation in prose rather than `{@link}`-ing an undocumented symbol (see `CODE_CONVENTIONS.md`, *Don't `{@link}` internal symbols from public JSDoc*).

`packages/lib/docs/components/DiagramView.md`:
- **Common methods** table — add a `whenLaidOut()` row ("Resolves once the layout pass in flight has placed its nodes; resolves at once when idle, and never rejects") and a `focusNode(id)` row ("Centre a node, retried after each layout pass until it succeeds — the durable form of `revealNode`"). Leave the `revealNode(id)` row as is.
- **Interaction → Initial view** bullet — note that `initialFocusNode` centres that node instead of the graph's bounds, that an unknown id falls back to the bounds, and that the zoom is untouched either way.
- **Interaction** — add a *First paint* bullet: node components are mounted hidden and revealed once ELK has placed them, so a diagram never paints an unplaced graph; a `setData` on an already-laid-out view keeps the previous graph on screen until the new one is placed. Point at `whenLaidOut()` for consumers that gate a spinner on placement.
- **Notes → Graceful when ELK is absent** — extend: a *re*-layout that fails leaves the previously laid-out graph on screen rather than emptying the view.

`packages/lib/docs/reference/changelog.md` — entries under the unreleased `## 0.3.0` per step 12.

No `llms.txt` change: it is generated from `scripts/llms/manifest.data.mjs` and carries no diagram entry.

App side: `TODO.md`'s known-issue bullet per step 21. `LIBRARY_NOTES.md` needs no entry — it records library defects the app works around, and this plan removes the defect rather than working around it.

---

## Potential Challenges

- **A hung ELK worker would now hold the tab spinner forever.** `whenLaidOut()` settles on success, failure, and disposal, so the only hang is a worker that neither resolves nor rejects. No timeout is added; if it ever shows up, the tab is still closeable and the symptom is diagnosable.
- **Node widths commit one frame after the reveal.** `applyLayout` writes each node's `x`/`y` (which reach the DOM immediately) and its preferred size (which the content host's `Absolute` pass commits on the next flush). This is exactly today's post-layout sequence, unchanged — the reveal does not introduce it.
- **Both node sets are mounted during a re-layout.** Hit-testing, selection, and z-index all read the shown maps only, so a click during the swap window can never resolve to a hidden incoming node.
- **The base-class transition cancel could suppress an `onComplete` that carries teardown.** The only two owners whose completion callback owns teardown work — `Dialog` and `Notification` — already cancel in their own `destructor()` and compensate there, so the base-class pass is a no-op for them (`cancel()` is idempotent). `Tab`'s cross-tab fade and `CodeEditor`'s read-only flash pass no `onComplete` at all.
- **`focusNode` re-arms a flag named `_needsInitialCentre`.** The name is kept deliberately;[^keep-names] do not rename it as a drive-by.

---

## Critical Files

- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts) — the whole of pieces 1 and 2. Read `rebuildNodes` (366), `relayout` (408), `collectNodeSizes` (430), `applyLayout` (462), `handleLayoutFailure` (547), `tryInitialCentre` (678), `centreGraph` (699), `revealNode` (828), `doLayout` (949).
- [`../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts:742`](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L742) — `pendingLayouts.delete(this)`, the precedent the transition cancel mirrors, and the handle-release loop at 818 the new loop precedes. Also `setVisible` (1676) and `getLaidOutComponents` (5019), which is why `visibility` and not `display` is used.
- [`../typescript-ui/packages/lib/src/typescript/lib/core/Animation.ts:98`](../typescript-ui/packages/lib/src/typescript/lib/core/Animation.ts#L98) — `play`, its two-frame entrance dance, and the `CancelHandle` contract.
- [`../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts:1898`](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1898) — the cross-tab fade at fault, and `closeEntry` (1088) which cancels only the materialize animation.
- [`../typescript-ui/packages/lib/tests/core/DisposedPendingLayout.test.ts`](../typescript-ui/packages/lib/tests/core/DisposedPendingLayout.test.ts) — the test-file precedent for step 2: the rAF spy shim, `flushFrame()`, and why assertions target the write rather than a throw.
- [`../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts`](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts) — `StubEngine` (`resolve` / `reject` / `defer` modes), `StubDiagramView`, `flush()`, `fixedResult()`, `parseTransform`, and the existing initial-centring block the new focus tests sit beside.
- [`frontend/src/SqlAdminController.ts:2939`](frontend/src/SqlAdminController.ts#L2939) — `openAsyncPanel`, and `PanelDisposers.settle`'s token contract in [`frontend/src/dock/panelDisposers.ts`](frontend/src/dock/panelDisposers.ts) that fixes the wait's position.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — sections (b) and (d): locals before `super()`, the instance is the component. Steps 16-18 each pass a root id into `super()` — step 17 computes it as a local first, which is what the super-cascade rule requires.

---

## Non-Goals

- **Zoom-to-fit on open.** Decided against: the root is focused at the configured zoom, and a graph larger than the viewport still overflows.
- **A spinner for `QueryPanel`'s Explain diagram tab.** That tab mounts synchronously; giving it a placeholder is a separate change.
- **Registering `Animation.afterTransition` or `Animation.tween` with the pending-transition registry.** Only `play` writes styles through a raw `Handle` on a deferred tick, and it is the one the reported error came from. Their owners (`Accordion`, `CollapseSupport`) cancel their own handles.
- **Cancelling `Tab._tabFadeAnimation` in `closeEntry`.** Rejected in favour of the base-class fix.[^tab-local-rejected]
- **Renaming `_needsInitialCentre` / `tryInitialCentre`.**[^keep-names]
- **A `whenLaidOut()` forwarder on `ExplainDiagramPanel`.** Nothing waits on it there.
- **ELK layout options, edge merging, node spacing** — the sibling `diagram-edge-merging-and-node-spacing` plan.
- **The elkjs version bump** — the sibling `elkjs-0-12-upgrade` plan.
- **Edge hover/highlight and the depth-limit / expand indicator** — sibling plans that build on this one's decisions.

---

## Notes

[^visibility]: `display: none` would take the node out of its parent's laid-out set — `Component.getLaidOutComponents()` filters on `isDisplayed()` ([Component.ts:5019](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L5019)) — so the content host's `Absolute` pass would skip it and never commit the position `applyLayout` wrote, and the reveal would need a further layout pass to take effect. `visibility: hidden` keeps the layout slot, so a hidden node is measured and placed exactly as a shown one. That matters because the sequence being fixed is measure-then-place: `collectNodeSizes` reads each node component's `getPreferredSize()` to feed ELK, which is why the components have to exist and be measurable before any position is known.

[^double-buffer]: Hiding on a re-layout would blank the canvas for the whole ELK round-trip, which is worse than what it replaces — the graph is already correct on screen and the user has only nudged a filter. The interactions this covers are all of `RelationDiagramPanel`'s direction, depth, *Hide with prune*, coverage, and per-node legend toggles, and all of `DatabaseDiagramPanel`'s mode (including Overview ↔ Tables), root, direction, depth, prune, per-schema legend toggles, and the Overview drill-down — every one of them calls `setData`. The app-side wait in `openAsyncPanel` cannot help here at all: there is no spinner to hold once the tab is open, which is why the library carries the hide-and-swap rather than the app.

[^never-rejects]: A rejecting `whenLaidOut()` would force every caller into a `try`/`catch` whose only sensible branch is "carry on anyway" — the caller wants to know when to stop waiting, not whether ELK succeeded. `handleLayoutFailure` already leaves the view in a defined state, and `"layout"` remains the success-only signal for consumers that care about the difference. Settling from `destructor()` matters for a real case: `openAsyncPanel` awaits `whenLaidOut()` before registering the panel for disposal, and without the destructor settle a view disposed on some other path would leave that await pending forever.

[^retry-precedent]: `tryInitialCentre` exists because the graph bounds (from ELK) and the viewport size (from the host's layout pass) arrive asynchronously and in either order; it is called from `applyLayout` *and* from every `doLayout`, and clears its pending flag only when `centreGraph()` reports it actually wrote a pan. The same race breaks a node-centring attempt made from outside: `revealNode` has no retry, so a `view.on("layout", () => view.revealNode(rootId))` hook silently no-ops whenever the ELK result lands before the host has sized the view — `getWidth()` is `NaN` until then. It also no-ops in a second way an app-side caller cannot see: at the moment `applyLayout` fires, node components have a preferred size but no committed width, and `revealNode`'s current body reads `getWidth()`. Both failure modes disappear by generalising the retry that is already there instead of adding a second mechanism beside it.

[^one-place]: The alternative — a `laidOut(panel)` helper each build callback wraps its return value in — needs nine call sites to remember it, and a tenth diagram tab added later would silently skip the wait. Doing it inside `openAsyncPanel` makes the behaviour a property of "an async work-area tab" rather than of each call site. The probe has to be optional because six of the fifteen `openAsyncPanel` callers build non-diagram panels (a table, a structure tab, three definition tabs, and the role-grants grid); `content as unknown as Partial<LayoutSettlingPanel>` is the same double cast `applySelectedVisual` uses to reach an optional `setSelected` on a consumer-supplied node component.

[^tolerate-rejected]: The rejected alternative is making the deferred write tolerate a released handle. `HandleRegistry.resolve` throws on a released handle deliberately — its own doc comment says a use-after-free "becomes a loud failure instead of the silent no-op a stale element pointer would give" ([DOM.ts:235](../typescript-ui/packages/lib/src/typescript/lib/core/DOM.ts#L235)) — so relaxing it globally would hide every genuine use-after-free in the framework. Narrowing the tolerance to `Animation.play` would mean adding a public "is this handle still live" query to the read seam whose only purpose is to let callers probe for use-after-free, and it would leave the cause in place: an uncancelled animation on a destroyed element keeps a fallback timer armed and keeps its registry entry alive. Cancelling addresses the cause, keeps the loud-throw contract, and matches what the destructor already does one screen above for the layout queue.

[^which-transition]: `Animation.play` is the only place `applyTransitionAndTo` exists, and it only defers (two nested animation frames) when a `from` state is given. On a diagram-tab close there are exactly two candidates. The first is `Animation.materialize`'s spinner-to-content cross-fade, which `Tab.closeEntry` already cancels ([Tab.ts:1105](../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts#L1105)) before it removes the content or emits `"tabclose"` — so the app's `dispose()` cannot land on a live one. The second is `Tab._tabFadeAnimation`, started from `Tab`'s layout pass once the newly selected entry reaches `"ready"`, and cancelled only in `Tab.detach()`. Its window is about 190 ms (two frames, plus `TAB_FADE_DURATION_MS` of 120, plus the 40 ms fallback buffer), and it starts right after the 160 ms materialize fade completes — which is to say right after the spinner clears, exactly where the report puts it. It also explains the two negative observations recorded in `TODO.md`: leaving the diagram to settle first moves the close outside the window, and a `QueryPanel` opens fast enough that the fade is long finished before a user closes it.

[^tab-local-rejected]: Cancelling `Tab._tabFadeAnimation` from `closeEntry` looks narrower but is wrong: it is a single field for the whole strip, not per entry, so closing a background tab while a *different* tab is mid-fade would cancel that fade — and cancelling `Animation.play` during its two-frame entrance dance leaves the element stranded at the `from` state, i.e. a permanently blank tab at `opacity: 0`. Cancellation is only unconditionally safe when the element is being destroyed, which is precisely the condition `Component.destructor()` guarantees and `closeEntry` does not.

[^preferred-size]: `applyLayout` writes each node's `setPreferredSize` and `setX`/`setY` from the ELK result; the content host's `Absolute` manager then commits that preferred size as the node's real width and height on the next layout flush ([Absolute.doLayout](../typescript-ui/packages/lib/src/typescript/lib/layout/Absolute.ts)). So the two agree once a layout pass has run, and reading the preferred size additionally works in the window between `applyLayout` and that flush — which is where the initial focus attempt happens. `revealNode` picks up that widened window as a side effect of sharing `centreNode`; both of its existing tests still pass, including the unsized-view one, because the `NaN` guard now trips on the viewport size rather than on the node's.

[^keep-names]: `_needsInitialCentre` and `tryInitialCentre` still describe what happens — a one-time initial centring — and only *what* is centred generalises. Their current doc comments are referenced from comments elsewhere in the file (`applyLayout`, `doLayout`), so renaming them would spread a cosmetic change across passages this plan otherwise leaves alone.
