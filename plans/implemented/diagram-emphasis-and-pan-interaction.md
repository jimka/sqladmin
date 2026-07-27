---
touches-shared:
  - ../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts
  - ../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts
  - ../typescript-ui/packages/lib/docs/components/DiagramView.md
  - ../typescript-ui/packages/lib/docs/reference/changelog.md
  - frontend/src/dock/RelationDiagramPanel.ts
---

# Diagram Emphasis and Pan Interaction — Implementation Plan

## Overview

Four interaction defects reported after testing the diagram stack. Three are library-side, in the sibling repo `../typescript-ui`; one adds a library API and wires it in the app.

**(a) De-emphasised edges do not recede far enough.** `DIMMED_EDGE_OPACITY` is `0.4` ([DiagramEdgeLayer.ts:64](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L64)) — borrowed from `ChartLegend`'s hidden-series strength, which is tuned for a filled swatch, not a 1.5px hairline. It drops to `0.15`.

**(b) Dragging over an edge must pan the canvas.** `_handlePointerDown` refuses to pan when the pointer is over a node, over the control cluster, **or** over an edge hit path ([DiagramView.ts:1459-1460](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1459)). The edge clause goes; an edge behaves like empty canvas for pan and for the `grab` / `grabbing` cursor, while keeping its hover tooltips.

**(c) A drag must never change the selection.** `_handleClick` ([DiagramView.ts:1243](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1243)) has no "did the pointer move" guard, so a pan that starts and ends on empty canvas fires a canvas click that clears both the selection and the edge emphasis the user was studying. A 4px movement guard is added.

**(d) Selecting a column must dim unrelated nodes too.** `DiagramView` gains `setNodeEmphasis` / `getNodeEmphasis`, mirroring the existing `setEdgeEmphasis` / `getEdgeEmphasis` pair ([DiagramView.ts:958-971](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L958)). `RelationDiagramPanel.selectColumn` ([RelationDiagramPanel.ts:158](frontend/src/dock/RelationDiagramPanel.ts#L158)) passes it the nodes the clicked column's foreign keys touch, so the two tables an FK connects stay at full strength and every other card recedes.

After any library edit, run **`npm run build:lib`** in `../typescript-ui/packages/lib` — the app imports the library's built, symlinked `dist/lib`, not its sources, so `npm run build` is the wrong command and no library change reaches the app without this one.

---

## Architecture Decisions

### The dim opacity drops to `0.15`

`DIMMED_EDGE_OPACITY` becomes `"0.15"`. That leaves an emphasised edge roughly 6.7× the opacity of a dimmed one, instead of today's 2.5×, while a dimmed hairline still resolves to a visible pale grey rather than disappearing.[^dim-value]

### The dim opacity stays a plain constant, not a themeable custom property

No `--ts-ui-diagram-*` custom property is added. Every existing diagram theme hook is a *colour*; every *numeric* visual in the same file — stroke width, hit width, dash pattern, label font size, halo width — is a plain module constant, and the library exposes no numeric theme token anywhere.[^no-opacity-token]

### Edges pan; only nodes and the control cluster refuse

`_handlePointerDown` keeps exactly two refusals — the control cluster and a node (leaf or container). An edge press starts a pan like a press on empty canvas.

| Pointer-down target | Starts a pan? | Cursor shown |
|---|---|---|
| Empty canvas | yes | `grab` → `grabbing` |
| Edge hit path | **yes** (was no) | **`grab` → `grabbing`** (was the plain arrow) |
| Node (leaf or container) | no | `pointer` |
| Control cluster | no | the button's own cursor |

Edge hover keeps working unchanged: `edgehover` / `edgeleave` ride a separate `mousemove` / `mouseout` pair, and `_handleEdgeMouseMove`'s existing `_panning` guard ([DiagramView.ts:1328](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1328)) already suppresses hover during a drag. That guard stays.

### The edge cursor comes from inheritance, and needs two writes

The hit path's `cursor: "default"` ([DiagramEdgeLayer.ts:634](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L634)) becomes `cursor: "inherit"`, **and** `DiagramEdgeLayer`'s constructor gains `this.setCursor("inherit")`. Both are needed: `cursor` inherits down the DOM, and the layer's own `<svg>` otherwise resolves to the `cursor: "default"` every Component defaults to ([ComponentDefaults.ts:17](../typescript-ui/packages/lib/src/typescript/lib/core/ComponentDefaults.ts#L17)), so a hit path inheriting from it would still paint an arrow.[^two-cursor-writes] Inheriting — rather than writing `grab` on the hit path — is also what makes an edge switch to `grabbing` mid-drag for free, since the single live write on the view root governs the whole subtree. This mirrors the content host, which is `cursor: "inherit"` for the same reason ([DiagramView.ts:279](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L279)).

### A drag is remembered during the press, not measured at the click

`DiagramView` records the pointer position on every `pointerdown` and flips a sticky `_pointerMoved` flag the moment a later `pointermove` passes 4px from it; `_handleClick` returns early while that flag is set. This mirrors `DragManager`'s session, which records `startX` / `startY` at press and flips `committed` in its move handler past the same 4px slop ([DragManager.ts:185](../typescript-ui/packages/lib/src/typescript/lib/overlay/DragManager.ts#L185), [DragManager.ts:499-504](../typescript-ui/packages/lib/src/typescript/lib/overlay/DragManager.ts#L499)) — the library's only existing click-versus-drag disambiguation.[^why-sticky-flag]

The reset and the recording go at the very top of `_handlePointerDown`, above every early return, so a press that refuses to pan (a node, the control cluster, a non-primary button) still arms the guard.

| Gesture | `_pointerMoved` at click | Selection outcome |
|---|---|---|
| Press and release on empty canvas, no movement | `false` | selection clears (unchanged) |
| Press empty canvas, drag 40px, release | `true` | selection and emphasis untouched |
| Press empty canvas, jitter 2px, release | `false` | selection clears |
| Press node A, drag 40px onto canvas, release | `true` | selection untouched |
| Click with no preceding `pointerdown` | `false` | selection changes normally |

### Node emphasis dims through `Component.setOpacity`, not a duck-typed method

`applyNodeEmphasis` calls `component.setOpacity(DIMMED_NODE_OPACITY)` on every node outside the set and `component.clearOpacity()` on the rest — real `Component` methods ([Component.ts:4217](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L4217)), so a custom renderer needs no cooperation. This deliberately diverges from `applySelectedVisual`, which duck-types `setSelected?.()` ([DiagramView.ts:1080](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L1080)).[^opacity-not-duck-typed]

`DIMMED_NODE_OPACITY` is `0.35`, not the edge's `0.15`: a card is a filled box with a border and text, and an area reads as far more present than a hairline at the same opacity, so the two numbers buy the same amount of recession.[^node-value]

### The node emphasis set lives on the view

`_nodeEmphasis: Set<string>` is a private field on `DiagramView`, cleared in `promoteIncomingNodes` beside the existing `this._selection = []` ([DiagramView.ts:475](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L475)). It is runtime interaction state, so it stays off `DiagramViewOptions` — the same call the edge layer makes for `_edgeEmphasis`.[^state-on-view]

### The app derives the emphasised nodes from the columns map

`RelationDiagramPanel.selectColumn` passes `[...emphasis.columns.keys()]` to `setNodeEmphasis`. `ColumnEmphasis.columns` is keyed by exactly the nodes the click touches — the clicked card, plus the far end of every attached edge ([columnEmphasis.ts:17](frontend/src/data/columnEmphasis.ts#L17)) — so no new derivation and no change to the pure helper is needed.[^columns-keys]

---

## Public API

```typescript
class DiagramView extends Panel<DiagramViewOptions> {
    /** Dim every node outside `ids`; `null` or `[]` clears. Emits nothing. */
    setNodeEmphasis(ids: readonly string[] | null): this;

    /** A copy of the emphasised node ids; empty when nothing is emphasised. */
    getNodeEmphasis(): string[];
}
```

Backing state: `private _nodeEmphasis: Set<string> = new Set();` plus a `private applyNodeEmphasis(): void`. There is **no** `DiagramViewOptions.nodeEmphasis` field and no `emit`, matching `setEdgeEmphasis` exactly.

---

## Internal Structure

### Constants

| File | Constant | From | To |
|---|---|---|---|
| `DiagramEdgeLayer.ts` | `DIMMED_EDGE_OPACITY` | `"0.4"` | `"0.15"` |
| `DiagramView.ts` | `DIMMED_NODE_OPACITY` | — (new) | `0.35` |
| `DiagramView.ts` | `CLICK_SLOP` | — (new) | `4` |

### `DiagramView` — new fields

```typescript
/**
 * Pointer position at the last `pointerdown`, and whether the pointer has
 * since travelled past `CLICK_SLOP`. Runtime gesture state, off the options
 * bag: `_handleClick` reads `_pointerMoved` to tell a click from the tail of
 * a drag.
 */
private _pressX: number = 0;
private _pressY: number = 0;
private _pointerMoved: boolean = false;

/** Ids of the emphasised nodes; every other node component is dimmed. */
private _nodeEmphasis: Set<string> = new Set();
```

### `DiagramView` — handler changes

```typescript
private _handleClick(event: MouseEvent): void {
    // A drag is not a click: a pan that starts and ends on empty canvas
    // still fires one, and it must not clear the selection (or the edge
    // emphasis the app keys off it).
    if (this._pointerMoved) {
        return;
    }

    // ...existing controls / edge / node branches, unchanged...
}

private _handlePointerDown(event: PointerEvent): void {
    // Recorded above every guard below, so a press that does not pan (a
    // node, the control cluster) still arms the click-versus-drag guard.
    this._pressX = event.clientX;
    this._pressY = event.clientY;
    this._pointerMoved = false;

    // A press on a node (leaf or container) or the control cluster is not a
    // pan: both show `pointer`, and the cursor has to promise what the drag
    // will do. Everything else — empty canvas and edges alike — pans.
    if (event.button !== 0 || this.isControlsTarget(event.target) || this.nodeIdAt(event.target) !== null) {
        return;
    }

    // ...existing pan-start body, unchanged...
}

private _handlePointerMove(event: PointerEvent): void {
    if (!this._pointerMoved) {
        const dx = event.clientX - this._pressX;
        const dy = event.clientY - this._pressY;

        this._pointerMoved = dx * dx + dy * dy >= CLICK_SLOP * CLICK_SLOP;
    }

    if (!this._panning) {
        return;
    }

    // ...existing pan body, unchanged...
}
```

The squared-distance comparison avoids a `Math.hypot`, matching `DragManager`'s own threshold test.

### `DiagramView` — node emphasis

```typescript
setNodeEmphasis(ids: readonly string[] | null): this {
    this._nodeEmphasis = new Set(ids ?? []);
    this.applyNodeEmphasis();

    return this;
}

getNodeEmphasis(): string[] {
    return [...this._nodeEmphasis];
}

private applyNodeEmphasis(): void {
    for (const [id, component] of this._nodeComponents) {
        if (this._nodeEmphasis.size === 0 || this._nodeEmphasis.has(id)) {
            component.clearOpacity();
        } else {
            component.setOpacity(DIMMED_NODE_OPACITY);
        }
    }
}
```

| `_nodeEmphasis` | Node `a` | Node `b` |
|---|---|---|
| `{}` (cleared) | full | full |
| `{a}` | full | `0.35` |
| `{a, zzz}` (unknown id kept) | full | `0.35` |
| `{zzz}` only | `0.35` | `0.35` |

---

## Ordered Implementation Steps

### Library — `/home/jika/typescript/typescript-ui` (first; the app typechecks against the built output)

1. **`packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts`** — retarget the existing expectations, so they start red: the four `'0.4'` assertions at lines [339](../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts#L339), [392](../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts#L392), [407](../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts#L407) and [439](../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts#L439) become `'0.15'`, and the hit path's `expect(hit.cursor).toBe('default')` at [line 168](../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts#L168) becomes `'inherit'`. Add one case: a fresh `DiagramEdgeLayer`'s own `getCursor()` is `'inherit'`.

2. **`packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts`** — set `DIMMED_EDGE_OPACITY` to `"0.15"` and rewrite its doc comment (it currently cites `ChartLegend`'s `HIDDEN_OPACITY`, which is no longer the source of the number — say instead that a hairline needs a much lower opacity than a filled swatch to read as receded). In `drawHitPath`, change `cursor: "default"` to `cursor: "inherit"` and replace the three-line comment above it with one saying the edge takes the viewport's own `grab` / `grabbing`, because dragging an edge pans. Add `this.setCursor("inherit")` beside the constructor's `setPointerEvents("none")` ([DiagramEdgeLayer.ts:325](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts#L325)), with a comment that the `<svg>` must not stamp the Component default cursor or the hit paths inherit an arrow. Run `npm test` — step 1 goes green.

3. **`packages/lib/tests/component/diagram/DiagramView.test.ts`** — invert one existing case and add the new ones; they start red.
    - Rewrite `_handlePointerDown on an edge hit path leaves _panning false` ([DiagramView.test.ts:1662-1679](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1662)) to assert `_panning === true` and `getCursor() === 'grabbing'`, and rename its `describe` ([line 1642](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts#L1642)) — an edge press now pans, but still does not clear the selection. The sibling cases in that block (`_handleClick`, `_handleDoubleClick`, `_handleContextMenu` on a hit path) keep their current expectations.
    - Add the moved-guard cases and the node-emphasis cases from _Expected Behaviour_.

4. **`packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`** — add the `CLICK_SLOP` and `DIMMED_NODE_OPACITY` module constants (each with the comment its value needs); add the three gesture fields and `_nodeEmphasis`; apply the three handler changes from _Internal Structure_ (including dropping the `edgeIdAt` clause and rewriting the comment above the condition); add `setNodeEmphasis` / `getNodeEmphasis` / `applyNodeEmphasis` directly after `getEdgeEmphasis` ([DiagramView.ts:971](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L971)), with JSDoc mirroring `setEdgeEmphasis`'s (dimming nodes rather than edges, `null` and `[]` both clearing, unknown ids kept but inert, cleared by the next layout that rebuilds nodes, emits nothing); add `this._nodeEmphasis = new Set();` in `promoteIncomingNodes` beside `this._selection = []`. Do **not** touch `_handleEdgeMouseMove`, `_handleEdgeMouseOut`, or `_handlePointerUp`. Run `npm test` — step 3 goes green and the rest of the suite stays green.

5. **`packages/lib/docs/components/DiagramView.md`** — per _Documentation Impact_.

6. **`packages/lib/docs/reference/changelog.md`** — per _Documentation Impact_.

7. **Checkpoint** — in `/home/jika/typescript/typescript-ui`: `npm test`, `npm run lint`, `npm run docs:api` (zero warnings — do not `{@link}` `applyNodeEmphasis` or any other private symbol from public JSDoc), then in `packages/lib`: **`npm run build:lib`**. The app cannot typecheck until `build:lib` has succeeded.

### App — `sqladmin/frontend`

8. **`frontend/src/dock/RelationDiagramPanel.ts`** — two additions:
    - in `selectColumn`, after `this.view.setEdgeEmphasis(emphasis.edgeIds)` ([line 167](frontend/src/dock/RelationDiagramPanel.ts#L167)), add `this.view.setNodeEmphasis([...emphasis.columns.keys()]);` with a one-line comment that the columns map is keyed by exactly the cards the click touches;
    - in the `"selection"` listener's empty-payload branch, beside `this.view.setEdgeEmphasis(null)` ([line 125](frontend/src/dock/RelationDiagramPanel.ts#L125)), add `this.view.setNodeEmphasis(null);`.

9. **Regression greps** (from `/home/jika/typescript/sqladmin`):
    - `grep -n 'edgeIdAt' ../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts` — expect three matches: `_handleClick`, `_handleEdgeMouseMove`, `_handleEdgeMouseOut`. None in `_handlePointerDown`.
    - `grep -rn "'0.4'\|\"0.4\"" ../typescript-ui/packages/lib/tests/component/diagram/` — expect zero matches.
    - `grep -rn 'setNodeEmphasis' frontend/src` — expect exactly two matches, both in `RelationDiagramPanel.ts`.

10. **Checkpoint** — `cd frontend && npm run typecheck` (needs step 7's `build:lib`), then `npm test` (every existing suite green, unedited).

11. **Manual verification** — per _Verification_.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts` |
| Modify | `../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramEdgeLayer.test.ts` |
| Modify | `../typescript-ui/packages/lib/tests/component/diagram/DiagramView.test.ts` |
| Modify | `../typescript-ui/packages/lib/docs/components/DiagramView.md` |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog.md` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |

---

## Expected Behaviour

The library's offline test harness records DOM writes through a stub sink and calls the private handlers directly with synthetic events (`view._handlePointerDown(makeEvent(handle, 'pointerdown', { button: 0, clientX: 100, clientY: 100 }))`). So **state transitions and the resulting DOM writes are unit-testable**, including the handler sequence of a synthetic drag. What the harness cannot exercise: a real pointer drag, a rendered cursor, hover, geometry, or anything about how the result looks. Those cases are marked manual.

### Unit-testable — `DiagramEdgeLayer` (`tests/component/diagram/DiagramEdgeLayer.test.ts`)

1. With `setEdgeEmphasis(['e1'])` over two drawn edges, `e1`'s visible path gets `opacity: '1'` and `e2`'s gets `opacity: '0.15'`.
2. A dimmed edge carrying a label writes `'0.15'` on the label text too.
3. An emphasis set naming only unknown ids dims every drawn edge (all `'0.15'`), and does not throw.
4. `setEdgeEmphasis(null)` and `setEdgeEmphasis([])` both restore `'1'` everywhere.
5. Each hit path is created with `cursor: 'inherit'`.
6. A fresh `DiagramEdgeLayer`'s `getCursor()` is `'inherit'`.

### Unit-testable — `DiagramView` (`tests/component/diagram/DiagramView.test.ts`)

7. `_handlePointerDown` on an edge hit path sets `_panning === true` and the cursor to `'grabbing'`.
8. A following `_handlePointerMove` (with `buttons: 1`) from that edge press writes the content host's translate by the pointer delta, exactly as an empty-canvas pan does.
9. `_handlePointerDown` on a leaf node, on a container node, and on a control button all still leave `_panning === false`.
10. Press empty canvas at `(100, 100)`, move to `(140, 130)` with `buttons: 1`, then `_handleClick` — an existing selection survives and no `"selection"` fires.
11. Press a node at `(100, 100)`, move to `(140, 130)`, then `_handleClick` with that node as target — the selection does not change and no `"selection"` fires.
12. Press empty canvas at `(100, 100)`, move to `(102, 101)` (inside the 4px slop), then `_handleClick` on empty canvas — an existing selection clears and `"selection"` fires with `[]`.
13. `_handleClick` with no preceding `_handlePointerDown` still selects the node under the target (the guard defaults to "not moved").
14. A second press resets the guard: after case 10, a fresh `_handlePointerDown` then an unmoved `_handleClick` on empty canvas clears the selection.
15. `setNodeEmphasis(['a'])` over a two-node graph leaves `a`'s component opacity unset (`getOpacity() === null`) and sets `b`'s to `0.35`.
16. `setNodeEmphasis(null)` and `setNodeEmphasis([])` both restore every node component to `getOpacity() === null`.
17. `getNodeEmphasis()` returns `['a']` after `setNodeEmphasis(['a'])` and `[]` after the clear; the array is a copy (mutating it does not change what a second call returns).
18. An emphasis set naming an unknown id dims every node without throwing, and `getNodeEmphasis()` still reports that id.
19. `setNodeEmphasis` emits nothing — no `"selection"`, no `"layout"`.
20. A `setData` whose layout lands clears the emphasis: `getNodeEmphasis()` is `[]` afterwards and the fresh node components have no opacity set.
21. A `setData` whose layout *fails* leaves the previous graph's emphasis in place (matching how a failed layout leaves the shown graph alone).

### Manual verification (needs the running app, a real ELK worker, and a browser)

The app side is manual-only: `frontend/tests/` runs in vitest's node environment over pure helpers, and the diagram panels import UI-bundle modules that touch `document` at load. Log in with Host **`sqladmin-db`** (not `localhost`).

**Column emphasis** — right-click a table with foreign keys → *Show relations*:
- Click a column row that owns a foreign key: that row and the referenced table's key row tint, the attached edge and the two cards it connects stay at full strength, and every other card and edge visibly recedes.
- Click a referenced key column on a parent card several tables point at: every referencing edge and every referencing card stays full-strength; unrelated cards recede.
- Click a plain (non-key) column: only that row tints, only its own card stays full-strength, and every edge returns to normal weight.
- Click empty canvas without moving the pointer: the row tint, the edge dimming, and the card dimming all clear together.
- Judge the two strengths in both themes and at zoom `0.25` and `4`: a dimmed edge must still be traceable, and a dimmed card must still be identifiable but clearly secondary.
- Change Direction / Depth / *Hide with prune* / *Highlight FKs without a covering index* while a column is emphasised: the emphasis clears with the re-layout and no card comes back stuck dim.

**Pan from an edge** — in the relation diagram, and again in the schema and database diagrams:
- Press directly on an edge and drag: the canvas pans by the drag delta, exactly as dragging empty canvas does.
- The cursor over an edge is `grab` at rest and `grabbing` for the whole drag — never the plain arrow.
- Hovering an edge still shows its foreign-key tooltip; moving off still hides it.
- Starting a pan from an edge leaves the tooltip that was already open in place until the pointer leaves the edge; it must not follow the pointer or re-show mid-drag.
- Dragging from a node still does not pan; dragging from the control cluster still does not pan.

**A drag never changes the selection:**
- Select a card, then drag empty canvas and release: the card stays selected and the edge/card emphasis stays exactly as it was.
- With a column emphasised, pan by dragging empty canvas, an edge, and (starting on a card) a node: none of the three clears the emphasis.
- Click empty canvas without moving: the selection and the emphasis clear — the original behaviour is intact.
- Click a card to select it, and double-click a card to open it: both still work after the guard is in.

---

## Verification

- **Library**: in `/home/jika/typescript/typescript-ui` — `npm test`, `npm run lint`, `npm run docs:api` (zero warnings), then `npm run build:lib` **in `packages/lib`** (not `npm run build`; the app consumes the built, symlinked `dist/lib`, and a plain `build` does not refresh it).
- **App typecheck**: `cd frontend && npm run typecheck` — requires the rebuilt library.
- **App unit tests**: `cd frontend && npm test` — every suite stays green **without edits**; `tests/data/columnEmphasis.test.ts` in particular, since the pure helper is unchanged.
- **Grep invariants**: the three greps in step 9.
- **Manual smoke**: the _Manual verification_ list above. Entry points: `SqlAdminController.openRelationDiagram` (right-click a table → *Show relations*), plus `openSchemaDiagram` and `openDatabaseDiagram` for the edge-pan and cursor checks.

---

## Documentation Impact

`DiagramView` is exported from `~/component/diagram/index.ts` and documented at `packages/lib/docs/components/DiagramView.md`; its catalog row in `docs/components/index.md` and its sidebar entry in `packages/docs/src/content/pages.ts` already exist and need no change. `docs/api/` is TypeDoc output — regenerated by `npm run docs:api`, never hand-edited.

**`packages/lib/docs/components/DiagramView.md`:**
- *Common methods* table — add a row beside the `setEdgeEmphasis` one: `` `setNodeEmphasis(ids)` / `getNodeEmphasis()` `` — dim every node outside the given set; `null` clears; reset by the next layout.
- *Edge style* section, the edge-emphasis paragraph — note that node emphasis is the same kind of view-level dimming, applied as opacity on the node component, so a custom `nodeRenderer` needs no cooperation.
- *Interaction* → **Pan** bullet — currently says a drag starting on an edge does not pan and that the cursor is "the plain arrow over an edge". Rewrite: only a node or the control cluster refuses to pan; an edge pans like empty canvas and shows `grab` / `grabbing`.
- *Interaction* → **Select** bullet — add that a drag never changes the selection: a press that travels more than a few pixels before release is a pan, not a click.
- *Interaction* → **Edges** bullet — replace "A press on an edge neither pans nor clears the selection" with: dragging an edge pans the canvas, while a press without movement still leaves the selection alone.

**`packages/lib/docs/reference/changelog.md`** (all under the unreleased `## 0.3.0`):
- `### Added` — a `**DiagramView.setNodeEmphasis(ids)` / `getNodeEmphasis()`** entry, phrased like the neighbouring `setEdgeEmphasis` one: dims every node outside the set, `null` or `[]` clears, the next `setData` clears it, emits nothing.
- The existing `"edgehover"` / `"edgeleave"` entry contains the now-false sentence "A press on an edge neither pans nor clears the node selection." Because 0.3.0 is unreleased, **edit that sentence in place** rather than adding a contradicting "Changed" entry: an edge press pans the canvas like empty canvas does, and still never clears the node selection.
- `### Changed` — the de-emphasised edge opacity is stronger (`0.4` → `0.15`), so an emphasised edge stands out on a dense graph. A consumer relying on the old strength has no option to restore it (deliberately; see _Non-Goals_).
- `### Fixed` — a pan drag no longer clears the diagram's selection: a press that travels past 4px is treated as a drag, so the click it produces is ignored.

---

## Potential Challenges

- **The `_panning` hover suppression now applies to a drag that starts *on* an edge.** A tooltip already open when the drag begins stays visible and stationary until the pointer leaves the hit path. Accepted: the alternative (hiding on pan start) needs a new signal out of the view, and the pointer usually leaves the edge within a few pixels of the drag anyway.
- **`clearOpacity()` wipes a node component's own root opacity.** A custom renderer that sets opacity on its own root loses it when the emphasis lifts. Note it in the `setNodeEmphasis` JSDoc; no app renderer does this (`TableCardNode` sets opacity only on inner labels).
- **Dimming a card multiplies with its children's opacity.** A dimmed `TableCardNode`'s type column renders at `0.6 × 0.35`. Check readability during manual verification; if it reads as broken rather than receded, raise `DIMMED_NODE_OPACITY` — do not special-case the app renderer.
- **Three sibling plans in this round also edit `DiagramView.ts`.** Confine edits to `_handleClick`, `_handlePointerDown`, `_handlePointerMove`, the new fields and constants, the two emphasis methods, and the one line in `promoteIncomingNodes`; leave the viewport/zoom methods and the layout pipeline untouched so the chained rebase stays resolvable.

---

## Critical Files

- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramEdgeLayer.ts) — the dim constant, `edgeOpacity` / `applyEdgeEmphasis`, `drawHitPath`, and the `setEdgeEmphasis` / `getEdgeEmphasis` pair the new node API mirrors.
- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts) — the four pointer handlers, `promoteIncomingNodes`, `applySelectedVisual`, and the edge-emphasis forwarders.
- [`../typescript-ui/packages/lib/src/typescript/lib/overlay/DragManager.ts`](../typescript-ui/packages/lib/src/typescript/lib/overlay/DragManager.ts) — the 4px slop and the record-at-press / commit-in-move shape the click guard mirrors (lines 169-185, 499-504).
- [`../typescript-ui/packages/lib/src/typescript/lib/core/ComponentDefaults.ts`](../typescript-ui/packages/lib/src/typescript/lib/core/ComponentDefaults.ts) — the `cursor: "default"` every Component inherits, which is why the edge layer needs its own `inherit`.
- [`../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts`](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts) — `setOpacity` / `clearOpacity` (lines 4206-4236).
- [`frontend/src/dock/RelationDiagramPanel.ts`](frontend/src/dock/RelationDiagramPanel.ts) — `selectColumn` and the `"selection"` clear branch, the only two app call sites.
- [`frontend/src/data/columnEmphasis.ts`](frontend/src/data/columnEmphasis.ts) — the `ColumnEmphasis.columns` map the emphasised node set comes from.
- [`frontend/src/dock/TableCardNode.ts`](frontend/src/dock/TableCardNode.ts) — `setSelected` / `setEmphasisedColumns`, the house style for a card's own emphasis visuals (unchanged by this plan).

---

## Non-Goals

- **No CSS custom property for either dim strength.** Decided against above; a consumer who needs a different strength has no hook, deliberately.
- **No edge selection, edge context menu, or edge click event.** An edge press pans and nothing else; `_handleClick`'s existing edge branch keeps a stationary edge press from touching the selection.
- **No change to `columnEmphasis.ts` or its tests.** The emphasised node set is derived at the call site from the map the helper already returns.
- **No node-emphasis wiring outside `RelationDiagramPanel`.** The schema, database, dependency, role and Explain diagrams have no column-click gesture to drive it.
- **No `"nodeemphasis"` event.** Both emphasis setters are silent, and the app already knows what it set.
- **No version bump and no publish.** The coordinated 0.3.0 release is a separate step; this plan only adds entries under the existing `## 0.3.0` heading.

---

## Notes

[^dim-value]: `0.4` came from `ChartLegend`'s `HIDDEN_OPACITY` ([ChartLegend.ts:60](../typescript-ui/packages/lib/src/typescript/lib/component/chart/ChartLegend.ts#L60)), which dims a filled legend swatch and its text — a shape with enough area that 40% still reads as "greyed out". A 1.5px stroke has almost no area, so at 40% it still reads as a full line and the emphasised edge does not win. `0.15` over the default light canvas puts a dimmed grey stroke at roughly `rgb(235, 235, 235)`: visible enough to trace where the graph's other relationships run, faint enough that the emphasised edges are what the eye lands on. `0.2` was tried on paper first and gives only a 5× ratio; `0.1` starts to lose the route entirely at zoom `0.25`.

[^no-opacity-token]: The diagram's five theme hooks are all colours — `--ts-ui-diagram-node-bg`, `--ts-ui-diagram-node-selected-bg`, `--ts-ui-diagram-edge`, `--ts-ui-diagram-bg`, `--ts-ui-diagram-group-bg` / `-border` — and colours are what a theme must be able to swap, because a dark palette has no way to derive them. Every *number* in `DiagramEdgeLayer.ts` (`EDGE_STROKE_WIDTH`, `EDGE_HIT_WIDTH`, `DASH_ARRAY`, `LABEL_FONT_SIZE`, `LABEL_HALO_WIDTH`, `ARROW_SIZE`) is a plain constant, and `core/Theme.ts` registers no numeric token at all — nor any diagram token, so the `--ts-ui-diagram-*` names are consumer-override fallbacks rather than part of the theme surface. Exposing an opacity would therefore be the library's first numeric hook, i.e. a new pattern, and the pattern-conformance rule says a new one needs the existing one to be unable to carry the case. It can: the constant is one edit away for the library, and a consumer wanting a different strength is not a case anyone has raised.

[^two-cursor-writes]: `cursor` is an inherited CSS property, so the hit path could simply omit it — but it would then inherit the layer `<svg>`'s computed value, and `Component.applyBoxAndVisibilityStyles` writes `cursor: default` into every component's own rule from `ComponentDefaults`. The `<svg>` being `pointer-events: none` does not help: inheritance follows the DOM tree, not hit-testing, so the hit path resolves `default` from its parent and paints an arrow. Setting `inherit` on the layer root passes the chain through to the view root's live `grab` / `grabbing` write — the same fix, for the same reason, that the content host already carries.

[^why-sticky-flag]: The alternative — no flag, and `_handleClick` comparing the click's own `clientX` / `clientY` against the recorded press point — is one field lighter but misses a drag that loops back and releases near where it began, and that gesture is common when nudging a large graph into place. A flag set the first time the pointer passes the slop cannot be un-set by the pointer coming back, which is exactly `DragManager.DragSession.committed`. Setting it above `_handlePointerMove`'s `_panning` guard also covers the drag that begins on a node: the browser fires `click` on the nearest common ancestor of press and release, so a node-to-canvas drag produces a canvas click that would otherwise clear the selection.

[^opacity-not-duck-typed]: `applySelectedVisual` duck-types because "selected" has no single generic rendering — a card tints its background, the library's `DiagramNode` uses a `.selected` state rule — so only the renderer can decide. "Dimmed" does have one: opacity on the node's own box, which is what `ChartLegend` and `DiagramNode`'s badge already use to recede something. A duck-typed `setDimmed?.()` would silently do nothing for every renderer that had not implemented it, including the library's own `DiagramNode` and `DiagramGroupNode`, and would put a second visual-state method on the app's `TableCardNode` for no gain.

[^node-value]: Perceived presence scales with the area an element covers, not just its alpha. A `TableCardNode` is `CARD_WIDTH` wide and tens of pixels tall, with a border and several rows of text; at `0.15` it very nearly disappears and the diagram reads as broken rather than focused. `0.35` keeps the card's shape and table name legible while putting it clearly behind the emphasised pair. The two numbers are intentionally different constants in different files, each documented where it lives.

[^state-on-view]: Edge emphasis lives in `DiagramEdgeLayer` because the layer owns the drawn edges and `DiagramView` only forwards. There is no equivalent layer for nodes — `DiagramView` owns `_nodeComponents` directly — so the view is the only place the set can live, and the mirror of "the layer clears it in `setEdges`" is "the view clears it in `promoteIncomingNodes`". Both clear points sit on the same `applyLayout` path, so one layout clears both kinds of emphasis together.

[^columns-keys]: `columnEmphasis` calls `addColumn` for the clicked node and, for every attached edge, for the node at the far end ([columnEmphasis.ts:68-90](frontend/src/data/columnEmphasis.ts#L68)), so the map's key set is exactly "the clicked card plus both ends of every emphasised edge". The far-end record is skipped only when the edge carries no `FkEdgeData` columns, which cannot happen here: `buildSchemaDiagram` attaches a `satisfies FkEdgeData` payload to every edge it builds ([buildSchemaDiagram.ts:119](frontend/src/data/buildSchemaDiagram.ts#L119)) and a foreign key always has at least one column pair. Adding a separate `nodeIds` field to `ColumnEmphasis` would duplicate that key set and its test coverage for no new information.

---

## Implementation Notes

**Line-number drift from the five already-merged sibling plans.** The plan's cited line numbers for `DiagramView.ts` (e.g. `_handlePointerDown` at 1459-1460, `promoteIncomingNodes`'s `this._selection = []` at 475, `setEdgeEmphasis`/`getEdgeEmphasis` at 958-971) had all shifted by the time this plan started, because `diagram-viewport-focus-and-reset` and `diagram-update-busy-overlay` (both merged ahead of this plan in the six-plan batch) rewrote `resetView`/`centreNode` and added the busy-overlay spinner plus moved node-component mounting from `rebuildNodes` into `promoteIncomingNodes`'s reveal loop. The plan's *intent* was unaffected: `_nodeEmphasis` is cleared in the current `promoteIncomingNodes` beside `this._selection = []` exactly as specified, just at a different line number (now ~484). The app side likewise adapted mechanically: `RelationDiagramPanel.ts`'s `selectColumn` and the `"selection"` clear branch are unchanged in shape from the plan's citations, just shifted a couple of lines by the `diagram-edge-merge-junctions` and `diagram-shell-optional-root` restructurings that landed just before this plan. No design decision changed — only the line numbers the plan cited.

**A bug in the plan's own proposed `_handlePointerMove` snippet.** The plan's `## Internal Structure` section proposed:

```typescript
private _handlePointerMove(event: PointerEvent): void {
    if (!this._pointerMoved) {
        const dx = event.clientX - this._pressX;
        const dy = event.clientY - this._pressY;
        this._pointerMoved = dx * dx + dy * dy >= CLICK_SLOP * CLICK_SLOP;
    }
    if (!this._panning) { return; }
    // ...
}
```

Implemented verbatim, this runs the distance check on *every* `pointermove` over the view's subtree — including ordinary ambient hover with no mouse button held, since `_handlePointerMove` is a `Event.addSubtreeListener` registration, not gated by button state. Because `_pressX`/`_pressY` default to `(0, 0)` and are only refreshed by `_handlePointerDown`, any real mouse movement before the very first press (near-certain, since `(0, 0)` is the viewport's corner) would immediately and permanently latch `_pointerMoved = true`, silently breaking the very first click of every session — a live, user-facing regression, not just a test gap: the offline unit test for Expected Behaviour case 13 passed regardless, because it invokes `_handleClick` directly without ever simulating the ambient `pointermove` a real browser session always produces first.

This was caught by the audit skill's first review pass, not by the test-first cycle, because the plan's own proposed code (which I followed per _Follow established patterns_) carried the defect. The fix adds one gate — `(event.buttons & 1) !== 0` — before the distance check, mirroring `DragManager.onMouseMove`'s `if (activeSession === null) { return; }` gate (`DragManager.ts:492`), which is structurally the same idea: only track movement while a press is actually in progress. A new regression test ("an ambient pointermove with no button held (hover, before any press) does not arm the guard") pins this. The fix is folded into the `Recede dimmed edges further, let a drag pan from an edge, and guard clicks` commit (library branch) rather than left as a separate follow-up commit, per the commit skill's fold-in-place rule for a defect in a commit already on the branch.

**Manual verification was performed**, not skipped: with the app running against the rebuilt library, node-emphasis dimming/clearing was confirmed both visually (screenshot) and programmatically (`TableCardNode.style.opacity === "0.35"` on an unrelated card, cleared to `""` after an empty-canvas click); edge-press panning was confirmed via a synthetic pointer sequence on a real edge hit path in the `hub` schema's 154-table flat diagram, showing the cursor go `grab` → `grabbing` → `grab` and the content host's `translate()` shift by exactly the drag delta; and the drag-never-clears-selection behaviour was confirmed visually (a card's selection border survived a drag started on empty canvas). Edge hover-tooltip-during-pan and the two-theme/zoom judgment calls in the plan's manual-verification list were not separately re-checked in this session, since they exercise code paths (`_handleEdgeMouseMove`'s pre-existing `_panning` guard, `TableCardNode`'s own rendering) that this plan does not touch and whose tests were unaffected.
