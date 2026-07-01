# Shell Sidebar Split — Implementation Plan

## Overview

The app shell today is a single `Border`-laid `Panel` with four regions: MenuBar (NORTH), the activity bar (WEST), the Dock (CENTER), and the StatusBar (SOUTH) — see [frontend/src/shell/SqlAdminShell.ts:42](frontend/src/shell/SqlAdminShell.ts#L42). The WEST region is a fixed-width strip whose collapse works by the `ActivityBar` mutating its own `preferredSize` ([frontend/src/shell/ActivityBar.ts:76](frontend/src/shell/ActivityBar.ts#L76)), which a Border WEST region honours.

This plan converts the WEST + CENTER pair into a single **horizontal `Split`** that becomes the Border's CENTER region (NORTH and SOUTH stay as-is). The sidebar becomes the Split's first (left) pane, the Dock the second (right) pane. The sidebar seeds at its natural 280px width, stays fixed on viewport resize (`weight: 0`), is user-drag-resizable, and collapses through the Split's live `min == max` pin instead of by mutating its own `preferredSize` — because the just-merged library `Split` **ignores a pane's preferred size after the one-time seed** ([typescript-ui `Split.seedFromPreferred`](../typescript-ui/src/typescript/lib/layout/Split.ts#L403)), so the old collapse mechanism stops working.

This is the downstream adoption of the library's new Split seed/weight/pin contract; it touches only [SqlAdminShell.ts](frontend/src/shell/SqlAdminShell.ts) and [ActivityBar.ts](frontend/src/shell/ActivityBar.ts). The activity bar's inner Border (rail WEST + deck CENTER Card) is untouched — only the **outer** shell WEST/CENTER pair becomes a Split.

---

## Architecture Decisions

### Shell restructure — Border keeps NORTH/SOUTH, CENTER becomes a horizontal Split

The Border `Panel` keeps `MenuBar` at NORTH and `statusBar` at SOUTH. WEST (sidebar) and CENTER (dock) collapse into one horizontal `Split` (`new Split({ orientation: "horizontal" })`) mounted as the Border's CENTER. Pane order: sidebar first (left), dock second (right). A `Split` is a `LayoutManager`, so the body is a `Component`/`Panel` whose layout manager is the Split, matching the house pattern in [QueryPanel.ts:71](frontend/src/dock/QueryPanel.ts#L71) (`body.setLayoutManager(split); body.addComponent(...)`).

### Dock MUST carry a positive weight — correctness requirement, not a nicety

The dock pane must be added with `weight: 1`. This is load-bearing: the library `Split` first-layout slack distribution only hands leftover space to *positively-weighted* panes; a pane with **neither a preferred size nor a positive weight** (a bare dock `Container`, which reports no preferred-size constraint — see [`seedFromPreferred`](../typescript-ui/src/typescript/lib/layout/Split.ts#L415) skipping null-preferred panes) falls through to the equal-division fallback ([Split.ts:1337](../typescript-ui/src/typescript/lib/layout/Split.ts#L1337)) that **steals** size back from the seeded sidebar toward an equal split. Giving the dock `weight: 1` makes it the absorber: it takes `available − sidebarSeed`, so the sidebar's 280px seed sticks and the dock fills the rest. Without this the sidebar seed does not hold. The sidebar itself gets `weight: 0` (fixed on viewport resize; the delta bypasses it and the weighted dock absorbs it — [Split.ts:1260](../typescript-ui/src/typescript/lib/layout/Split.ts#L1260)).

### Collapse flows through the Split — ownership seam: shell owns the Split, ActivityBar drives it via an injected handle

The hard question: `ActivityBar` owns its collapse state (`collapsed`, `activeId`) and exposes `toggleCollapsed`, but the Split lives in the shell. Three options:

1. **Move all collapse logic into the shell.** Rejected — the rail-button click handlers (`showView`/`collapse`) live inside `ActivityBar` and are tied to its per-view button wiring; hoisting them fractures a cohesive unit and duplicates the view/button map in the shell.
2. **Shell passes a collapse *callback* into ActivityBar.** A single `(collapsed: boolean) => void` is too thin — the ActivityBar also needs to *seed* the Split's expand width and read the last-dragged width; a one-way boolean callback can't reopen to a remembered width.
3. **Shell injects a small `SidebarSizer` handle into ActivityBar (CHOSEN).** The shell constructs the `Split` and a tiny object exposing `collapse()` / `expand()` that internally drive the Split (set min/max, `setPaneSize`). `ActivityBar` calls `sizer.collapse()` / `sizer.expand()` from its existing `setCollapsed`, keeping its `collapsed`/`activeId` state and its public `toggleCollapsed`/`showView`/`collapse` surface unchanged. The Split and its pane references stay encapsulated in the shell; the ActivityBar knows only "collapse/expand me". This preserves the `ActivityBarHandle` + `toggleCollapsed` contract the MenuBar "Toggle Sidebar" command uses ([SqlAdminShell.ts:45](frontend/src/shell/SqlAdminShell.ts#L45), [:64](frontend/src/shell/SqlAdminShell.ts#L64)).

Chicken-and-egg: `ActivityBar` builds its own component, but the Split (needing the sidebar component as a pane) is built by the shell *after* `ActivityBar` returns. So `ActivityBar` must accept the sizer **after** construction. Cleanest: `ActivityBar` takes an optional `SidebarSizer` via a setter/handle field that the shell wires once it has built the Split. See **Public API**.

### Collapse mechanism — pin with `min == max == RAIL_WIDTH`; expand restores `min < max` + `setPaneSize`

- **Collapse:** the sizer sets the sidebar pane's `min == max == RAIL_WIDTH` (`setMinSize(RAIL_WIDTH, 0)` + `setMaxSize(RAIL_WIDTH, ∞)`). This fires `_onConstraintSizeChange`, which reschedules the parent Split's layout ([Component.ts:4174](../typescript-ui/src/typescript/lib/core/Component.ts#L4174)); the Split's re-clamp + pin-aware refill ([Split.ts:1382](../typescript-ui/src/typescript/lib/layout/Split.ts#L1382)) holds the sidebar at exactly RAIL_WIDTH and rescales the dock to fill the rest. The `ActivityBar` still hides the deck (`deck.setDisplayed(false)`); the rail stays visible.
- **Expand:** the sizer restores `min < max` (`setMinSize(RAIL_WIDTH, 0)` — a floor so the user can't drag below the rail — and `setMaxSize` back to unbounded so the gutter is draggable), then `split.setPaneSize(sidebar, restoredWidth)` to reopen it. The dock (weight 1) gives the space back via the pin-aware refill.
- **min < max only when expanded; min == max only when collapsed** — this makes the gutter draggable exactly when the sidebar is open, and pins it exactly when closed, mirroring the library collapse contract.

### Expand width — remember the last dragged width

On expand, restore to the user's last dragged width if they have resized, else the default `RAIL_WIDTH + DECK_WIDTH` (280). This is cheap: read `split.getPaneSize(sidebar)` **before** collapsing (while it still holds the live dragged extent) and stash it; expand seeds that value. First-ever expand (no prior width) falls back to 280. The stash lives in the shell's sizer closure, not persisted across reloads.

### The old `activityBar.setPreferredSize(...)` collapse call is removed

`setCollapsed` no longer calls `activityBar.setPreferredSize(...)` to drive width — the Split ignores preferred after seed, so that call is dead for sizing. The sidebar's **initial** `setPreferredSize(RAIL_WIDTH + DECK_WIDTH, 0)` at [ActivityBar.ts:135](frontend/src/shell/ActivityBar.ts#L135) is **kept** — it is the one-time seed the Split reads via `getPreferredSizeConstraint` on first layout.

---

## Public API

No library API changes. sqladmin-internal surface:

```typescript
// ActivityBar.ts — new: a handle the shell injects so the bar drives the Split.
export interface SidebarSizer {
    /** Pin the sidebar pane to RAIL_WIDTH (min == max) and hold it there. */
    collapse(): void;
    /** Restore min < max (draggable) and reopen to the remembered/default width. */
    expand(): void;
}

// ActivityBarHandle gains a wiring point (chosen over a constructor arg because
// the Split — which needs the sidebar component — is built by the shell after
// ActivityBar returns).
export interface ActivityBarHandle {
    component: Component;
    toggleCollapsed(): void;
    /** Wire the Split-backed sizer once the shell has built the Split. */
    setSizer(sizer: SidebarSizer): void;   // NEW
}
```

`RAIL_WIDTH` (40) and `DECK_WIDTH` (240) stay in ActivityBar. The shell needs `RAIL_WIDTH` for the collapse pin and `RAIL_WIDTH + DECK_WIDTH` (280) for the default expand width — export both, or (simpler) export a single `SIDEBAR_DEFAULT_WIDTH` (280) and `SIDEBAR_RAIL_WIDTH` (40) constant pair from ActivityBar for the shell to read, keeping the magic numbers single-sourced.

---

## Internal Structure

Shell CENTER assembly (replaces the WEST + CENTER entries):

```typescript
const split = new Split({ orientation: "horizontal" });
const body  = Panel({ layoutManager: split });          // or new Component()
body.addComponent(sidebar.component, { weight: 0 });     // pane 0: fixed, seeds at 280
body.addComponent(controller.dock,  { weight: 1 });      // pane 1: absorber (REQUIRED)

let lastWidth = SIDEBAR_DEFAULT_WIDTH;                    // remembered expand width
const sizer: SidebarSizer = {
    collapse() {
        const w = split.getPaneSize(sidebar.component);  // capture live dragged width
        if (w !== undefined && w > SIDEBAR_RAIL_WIDTH) lastWidth = w;
        sidebar.component.setMinSize(SIDEBAR_RAIL_WIDTH, 0);
        sidebar.component.setMaxSize(SIDEBAR_RAIL_WIDTH, UNBOUNDED_HEIGHT);   // pin
    },
    expand() {
        sidebar.component.setMaxSize(UNBOUNDED_WIDTH, UNBOUNDED_HEIGHT);      // unpin
        sidebar.component.setMinSize(SIDEBAR_RAIL_WIDTH, 0);                  // floor
        split.setPaneSize(sidebar.component, lastWidth);
        body.doLayout();                                                     // if needed
    },
};
sidebar.setSizer(sizer);
```

`ActivityBar.setCollapsed` then becomes:

```typescript
const setCollapsed = (value: boolean): void => {
    collapsed = value;
    deck.setDisplayed(!value);          // unchanged: rail stays, deck hides
    if (value) sizer?.collapse();
    else       sizer?.expand();
    // the old activityBar.setPreferredSize(...) line is deleted
};
```

Confirm the "unbounded" sentinel: check how `setMaxSize` expresses "no max" in the library (an unset max reads as `MAX_SAFE_INTEGER` in [`Split.isPinnedMain`](../typescript-ui/src/typescript/lib/layout/Split.ts#L394); `Component.setMaxSize` has an `isUnbounded` helper — [Component.ts:2357](../typescript-ui/src/typescript/lib/core/Component.ts#L2357)). Use the library's own unbounded constant rather than a hand-rolled `Infinity`; verify its name/import at implementation time. **Only the width axis matters** for a horizontal split — the height min/max on the sidebar pane should stay 0/unbounded so vertical layout is unaffected.

---

## Ordered Implementation Steps

1. **ActivityBar.ts — add the `SidebarSizer` seam.** Export the `SidebarSizer` interface; add `setSizer(sizer)` to `ActivityBarHandle` and a `let sizer: SidebarSizer | null = null` closure field set by it. Export `SIDEBAR_RAIL_WIDTH` (= `RAIL_WIDTH`) and `SIDEBAR_DEFAULT_WIDTH` (= `RAIL_WIDTH + DECK_WIDTH`) for the shell.
2. **ActivityBar.ts — reroute collapse through the sizer.** In `setCollapsed`, replace the `activityBar.setPreferredSize(...)` line with `value ? sizer?.collapse() : sizer?.expand()`. Keep `deck.setDisplayed(!value)`. Keep the initial `activityBar.setPreferredSize(RAIL_WIDTH + DECK_WIDTH, 0)` seed at the bottom of the builder (it is the Split's one-time seed hint).
3. **SqlAdminShell.ts — build the horizontal Split body.** Import `Split` from `@jimka/typescript-ui/layout` and the two width constants + `SidebarSizer` from `./ActivityBar`. Replace the WEST + CENTER component entries with a single CENTER entry whose component is a `Panel`/`Component` laid out by `new Split({ orientation: "horizontal" })`, adding `sidebar.component` with `{ weight: 0 }` then `controller.dock` with `{ weight: 1 }`.
4. **SqlAdminShell.ts — wire the sizer.** Build the `SidebarSizer` closure (remembered-width stash, collapse pin, expand unpin + `setPaneSize`) and call `sidebar.setSizer(sizer)` before returning the shell.
5. **Regression check:** `grep -n "setPreferredSize" frontend/src/shell/ActivityBar.ts` — expect exactly one match (the initial seed), the collapse-time call gone.
6. **Regression check:** `grep -n "Placement.WEST\|Placement.CENTER" frontend/src/shell/SqlAdminShell.ts` — expect the WEST entry gone and CENTER now hosting the Split body.
7. **Typecheck:** `cd frontend && npm run typecheck` — expect clean.
8. **Live smoke test** per **Verification** (drag / resize / collapse), since none of this is offline-testable in sqladmin's node-only harness.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | [frontend/src/shell/SqlAdminShell.ts](frontend/src/shell/SqlAdminShell.ts) — WEST/CENTER → horizontal Split; build + wire `SidebarSizer` |
| Modify | [frontend/src/shell/ActivityBar.ts](frontend/src/shell/ActivityBar.ts) — add `SidebarSizer`/`setSizer`, export width constants, reroute collapse through the sizer |

---

## Expected Behaviour

All geometry behaviours below are **manual-verify only**: sqladmin's vitest runs in the `node` environment with no DOM ([frontend/vitest.config.ts:9](frontend/vitest.config.ts#L9); existing tests cover only pure data helpers), so Split seed/weight/min-max redistribution cannot be exercised in an sqladmin unit test. (The same behaviours *are* offline-testable in the typescript-ui library's own TestDOM harness, but that harness is not available to sqladmin — the library plan owns those tests.) There is **no new pure logic** in this change to pin with an sqladmin unit test — the remembered-width stash is trivial closure state exercised only through DOM-driven collapse. So this section is a manual smoke checklist, not a test spec.

1. **Initial layout:** sidebar starts at 280px (rail 40 + deck 240); the dock fills the remaining width with no gap or overlap.
2. **Gutter drag:** dragging the gutter between sidebar and dock resizes the sidebar; the dock absorbs the delta; the deck content reflows within the new width. Dragging cannot shrink the sidebar below RAIL_WIDTH (the min floor).
3. **Viewport resize (expanded):** widening/narrowing the browser window keeps the sidebar width fixed (weight 0); the dock absorbs the entire delta (weight 1).
4. **Collapse via rail re-click:** clicking the active view's rail icon collapses the sidebar to exactly RAIL_WIDTH = 40, the deck hides, the rail stays visible, and the dock reclaims the freed width. The sidebar holds at 40 across a subsequent viewport resize (pinned min == max).
5. **Collapse via menu:** View → Toggle Sidebar performs the same collapse (and re-expands when toggled again) — the `ActivityBarHandle.toggleCollapsed` contract still drives it.
6. **Expand restores remembered width:** after dragging the sidebar to, say, 340px then collapsing and re-expanding, the sidebar reopens to ~340px (not the default 280); a fresh session with no drag reopens to 280.
7. **Gutter draggable only when expanded:** while collapsed the sidebar is pinned (min == max) and the gutter cannot resize it; expanding restores drag.
8. **No inner-Border regression:** the sidebar's internal rail/deck Card Border, the navigator, and the properties accordion render and behave exactly as before — only the outer shell WEST/CENTER became a Split.

---

## Verification

- **Typecheck:** `cd frontend && npm run typecheck` — clean.
- **Build:** `cd frontend && npm run build` — succeeds (runs `tsc --noEmit && vite build`).
- **Existing tests unaffected:** `cd frontend && npm run test` — the data-layer tests still pass (this change touches no data code).
- **grep invariants:** step 5 (`setPreferredSize` count in ActivityBar) and step 6 (no `Placement.WEST` in the shell) above.
- **Manual smoke (entry point: `npm run dev`, the running app shell):** walk **Expected Behaviour** 1–8 — seed at 280, drag the gutter, resize the window, collapse via rail icon and via View → Toggle Sidebar, confirm remembered-width re-expand, confirm the navigator/properties render unchanged.

---

## Potential Challenges

- **Bare dock steals the seed.** If the dock is added without `weight: 1`, the null-preferred dock takes the equal-division fallback and pulls the sidebar off its 280 seed — mitigate by treating `weight: 1` on the dock as a hard requirement (Architecture Decisions) and verifying behaviour 1 live.
- **Unbounded-max sentinel.** Hand-rolling `Infinity`/`Number.MAX_SAFE_INTEGER` for "no max" may not match what `Split.isPinnedMain` treats as unbounded — mitigate by using the library's own unbounded constant / `isUnbounded` convention (verify its exported name before use) and only touching the width axis.
- **Expand-width capture timing.** `getPaneSize` must be read *before* the collapse pins/re-clamps the sidebar, or it returns the pinned 40 — mitigate by capturing the live width at the top of `sizer.collapse()` before any `setMinSize`/`setMaxSize` call.
- **Relayout on expand.** Setting min/max fires `_onConstraintSizeChange` → `scheduleLayout` (async, next frame); an explicit `body.doLayout()` after `setPaneSize` may be needed for an immediate reopen — mitigate by mirroring QueryPanel's `body.doLayout()` calls after `setPaneSize` ([QueryPanel.ts:96](frontend/src/dock/QueryPanel.ts#L96)) and confirming no visible one-frame flicker.
- **Insets already zeroed.** The ActivityBar zeroes its content insets ([ActivityBar.ts:132](frontend/src/shell/ActivityBar.ts#L132)) so the rail stays a constant width across collapse — keep that; the Split does not add insets of its own, so the pin lands exactly on RAIL_WIDTH.

---

## Critical Files

- [frontend/src/shell/SqlAdminShell.ts](frontend/src/shell/SqlAdminShell.ts) — the Border assembly being restructured.
- [frontend/src/shell/ActivityBar.ts](frontend/src/shell/ActivityBar.ts) — the collapse machinery (`setCollapsed`/`showView`/`collapse`/`toggleCollapsed`) and RAIL_WIDTH/DECK_WIDTH.
- [frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts) — house Split usage: `body.setLayoutManager(split)`, `setPaneSize`, `body.doLayout()`.
- [typescript-ui `Split.ts`](../typescript-ui/src/typescript/lib/layout/Split.ts) — the seed/weight/pin contract: `seedFromPreferred` (L403), first-layout slack for weighted panes (L1294), resize-delta by weight (L1260), pin-aware refill (L1376), `setPaneResizeWeight`/`getPaneResizeWeight`/`setPaneSize`/`getPaneSize` (L291–345).
- [typescript-ui `Component.ts`](../typescript-ui/src/typescript/lib/core/Component.ts) — `setMinSize`/`setMaxSize` firing `_onConstraintSizeChange` (L2359/L2434) → parent `scheduleLayout` (L4174); `getPreferredSizeConstraint` (L2176).
- [typescript-ui `LayoutConstraints.ts`](../typescript-ui/src/typescript/lib/primitive/LayoutConstraints.ts) — the `weight` constraint field (L68).

---

## Non-Goals

- **No gutter double-click collapse.** The library `Split` gutter offers a native dblclick collapse; this app deliberately keeps collapse driven by the rail icon / menu (the existing VSCode-style UX), so the native chevron behaviour is out of scope.
- **No persistence of sidebar width across reloads.** The remembered width is in-memory (session-scoped closure state); persisting it to storage is out of scope.
- **No change to the inner rail/deck Border or the Card deck.** Only the outer shell WEST/CENTER pair becomes a Split.
- **No change to Dock, StatusBar, or MenuBar internals** beyond the shell rewiring; the MenuBar "Toggle Sidebar" command keeps calling `toggleCollapsed` unchanged.
