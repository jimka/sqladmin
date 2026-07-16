# Explorer Resizable Sections — Implementation Plan

## Overview

The library's `Accordion` gained draggable gutters between adjacent open sections (`Accordion.setResizable`, forwarded by `AccordionPanel`'s `resizable` option). This plan adopts it in SQLAdmin's sidebar rails so the user can apportion height between the tree and the inspector instead of the inspector sitting at a fixed 220px.

Three files change. [`frontend/src/shell/treeExplorerView.ts:55`](frontend/src/shell/treeExplorerView.ts#L55) gains `resizable: true` and a real height floor on the tree; [`frontend/src/properties/PropertyValuePanel.ts:46`](frontend/src/properties/PropertyValuePanel.ts#L46) drops its `minSize.height` from 220 to a small floor (**without this the inspector can only ever be dragged bigger** — see the Architecture Decisions); [`frontend/src/shell/QueriesView.ts:125`](frontend/src/shell/QueriesView.ts#L125) gets the same treatment for the Saved/Recent rail. `DatabaseExplorerView` and `RolesExplorerView` inherit from `TreeExplorerView` and need no edit.

This is a geometry/drag change. Nothing here is unit-testable in this repo's node vitest env — every touched module pulls library UI code that touches `document` at import scope. `## Expected Behaviour` is therefore almost entirely manual-verify, and says so per case.

---

## Architecture Decisions

### `resizable` composes cleanly with the existing `fillWeight: 1` — the seed **is** the fill result

This was the central risk; the library resolves it. `Accordion.computeResizableHeights` (typescript-ui `src/typescript/lib/layout/Accordion.ts:2104`) runs *after* `computeShrinkRatio` and `computeFill`, and seeds each not-yet-stored open section from `this.openContentHeight(component, shrinkRatio) + (fills.get(i) ?? 0)` — **exactly what the non-resizable path would have rendered**, fill included (`Accordion.ts:2146`). So the first resizable layout of the explorer rail reproduces today's split pixel-for-pixel: tree = `budget − headers − 220`, inspector = 220. The library's own docs (`docs/layouts/Accordion.md`, corrected in typescript-ui commit `1079eb8e`) narrow the "seamless" claim to exactly this case — *"with a fill option on (or when the content overflows) turning `resizable` on is visually seamless … if no fill option is set … enabling `resizable` grows the sections to close that gap."* The explorer rails set `fillWeight: 1`, so they are in the seamless case. **No change to `fillWeight: 1` is needed or wanted.**

After seeding, `fillWeight` is dead weight for the open set: `distributeWithinConstraints` (`Accordion.ts:2180`) rescales the *stored* sizes by `openBudget / storedTotal` on every layout, and only a gutter drag rewrites the stored ratio. One consequence the implementer must not "fix": **resizing the sidebar's height now rescales both sections proportionally**, where today the tree absorbed 100% of the change. That is the library's intended resizable behaviour (the drag ratio is authoritative and survives container resize), and it is what the papercut asked for.

### The `setPreferredSize(0, 0)` tree does **not** break drag — but its **zero min** does, and must be fixed

The 0-preferred tree does not break drag-resize: the drag reads live heights (`components[ci].getHeight()`, `Accordion.ts:1690`), and the *stored* size comes from the post-fill seed, not from the preferred size. So the tree gets a real, persistable size.

The real defect is the tree's **minimum**. `NavigatorTree`/`RolesTree` extend `Tree`, which overrides no `getMinSize`; `Component.getMinSize` is `max(own minSize constraint, layoutManager.getMinSize())` and `LayoutManager._defaultMinSize` is `{0,0}` — so the tree's min height is **0**. Two failures follow:

1. **The drag can erase the tree entirely** — `onGutterDrag` floors each section at `getMinSize().height` (`Accordion.ts:1691`), i.e. 0.
2. **A degenerate seed is a permanent fixed point.** `openContentHeight` returns `max(min(pref − ratio·(pref−min), max), min)`; with `pref = min = 0` it is always `0`, so if the seeding layout ever runs with `leftover ≤ 0`, the tree stores **0** — and `0 × factor = 0` under proportional rescale, so the tree would render at zero height forever, at every budget.

**Decision:** replace `tree.setPreferredSize(0, 0)` with `tree.setPreferredSize(0, TREE_MIN_HEIGHT)` **and** `tree.setMinSize(0, TREE_MIN_HEIGHT)`, `TREE_MIN_HEIGHT = 96`. Set both (not min alone) so the tree never reports `min > preferred`, which would be an incoherent report to the host.

**This is visually a no-op at every normal sidebar height.** `computeFill` charges `used = headers(44) + openContentHeight(tree) + openContentHeight(inspector)`, and the tree's `fillWeight: 1` then hands it *all* the leftover: `96 + (budget − 44 − 96 − 220) = budget − 264` — identical to today's `0 + (budget − 44 − 0 − 220)`. The floor only changes the picture below ~360px of sidebar height, where it makes the layout *better* (a graceful shrink instead of a clip).

### The inspector's `minSize.height: 220` is the thing that actually blocks the feature — lower it

[`PropertyValuePanel.ts:26,45-46`](frontend/src/properties/PropertyValuePanel.ts#L26) pins `PANEL_HEIGHT = 220` as **both** `preferredSize.height` and `minSize.height`, documented at L22-25 as "Pinned as both preferred and minimum so the accordion's shrink never steals from it". Under `resizable`, `getMinSize().height` is the drag's floor — so with min = 220 the user could only ever drag the inspector **bigger**. That is half the feature missing, and it would look like the drag "sticks".

**Decision:** keep `preferredSize.height = PANEL_HEIGHT (220)` — it is what seeds the initial 220px look — and add `PANEL_MIN_HEIGHT = 96` as the new `minSize.height`. The Panel's merged min is `max(96, Fit.getMinSize() = Table.getMinSize(0) + 8px Panel insets)` = 96, so lowering the constraint genuinely lowers the floor. The initial render is unchanged because `computeShrinkRatio` returns 0 whenever the sections fit, making `openContentHeight(inspector, 0) = 220` regardless of the min. Rewrite the L22-25 comment: the min is no longer the shrink guard, it is the drag floor.

### Persistence is out of scope — but a drag already survives toggles and rail switches for free

Nothing is written to `localStorage`, and no `onSectionToggle` relay is added. The library already covers everything except a page reload:

- **Collapse/expand toggle** — `_resizeSizes` is keyed by `Component` and only pruned for components no longer in the container (`Accordion.ts:2109-2113`); a closed section keeps its entry frozen (`Accordion.ts:181-184`). Reopening restores the dragged ratio.
- **Rail switch** — `Card.doLayout` lays out only `_currentVisible` (`layout/Card.ts:249`); the hidden page's `Accordion` is never re-laid-out, and `ActivityBar` never rebuilds the view (`SqlAdminShell.ts:421-423` constructs each once for the session). `_resizeSizes` survives untouched. Collapsing the deck (`ActivityBar.ts:178`, `deck.setDisplayed(false)`) is likewise inert.
- **Reload** — the drag is lost; the seed reapplies. Accepted: `Accordion` exposes no getter/setter for `_resizeSizes`, so persisting it needs **new library API**, and this plan is app-side adoption only.

### Scope: the two explorer rails **and** `QueriesView`; **not** `StructurePanel` or `ExplainDiagramPanel`

- **`TreeExplorerView`** (→ `DatabaseExplorerView`, `RolesExplorerView`) — **IN**. The logged papercut.
- **`QueriesView`** ([`shell/QueriesView.ts:125-131`](frontend/src/shell/QueriesView.ts#L125)) — **IN**. It is the third page of the same activity-bar deck (`SqlAdminShell.ts:423,428`), with the identical shape: two `initiallyOpen: true` sections, `fillWeight: 1` each, `setCompact(true)`. The papercut reads verbatim ("apportion height between Saved and Recent"), and a user who learns the drag on the Database rail will try it on Queries. Cost is one option plus one min floor.
- **`StructurePanel`** ([`dock/StructurePanel.ts:129-163`](frontend/src/dock/StructurePanel.ts#L129)) — **OUT**. It deliberately hosts the accordion inside an `autoScroll: "auto"` VBox at weight 1 so *the whole stack scrolls* when the sections overflow. `resizable` inverts that: `distributeWithinConstraints` forces the open set to sum to the accordion's own inner budget, so four open sections would be squeezed to fit rather than scroll — contradicting the panel's documented design.
- **`ExplainDiagramPanel`** ([`dock/ExplainDiagramPanel.ts:141-148`](frontend/src/dock/ExplainDiagramPanel.ts#L141)) — **OUT**. Three sections, not two: "Summary" and "Plan tree" are both `initiallyOpen: true` and only "Plan steps" starts closed — so the panel already has **two** open sections by default, and turning `resizable` on *would* produce a working Summary/Plan-tree gutter immediately (unlike a below-threshold accordion, where `setResizable` is a documented no-op — see `docs/layouts/Accordion.md`'s "No gutter appears with fewer than two open sections"). That is a different, three-section shape this plan never analysed: "Summary" carries no `fillWeight` and no min floor analogous to this plan's `TREE_MIN_HEIGHT`/`PANEL_MIN_HEIGHT` fix, so an unguarded drag could crush it to zero — the same class of bug this plan fixes for the sidebar rails, unaddressed here. Opening "Plan steps" later adds a third open section and a second gutter, widening the surface further. Out of scope: this plan's mandate is the sidebar's two named rails (the logged papercut) plus `QueriesView`; a `dock/` accordion is a separate area and would need its own floor analysis, not a drive-by option flip.

### `setCompact(true)` does not thin the gutter — but the gutter does overlay 6px of tree content

`setCompact` only changes header height (`COMPACT_HEADER_HEIGHT = 22` vs 28), header padding, and chevron size (`Accordion.setCompact`, `Accordion.ts:394`). It never touches the gutter. `RESIZE_GUTTER_SIZE` is a fixed **6px** module constant with no setter (`Accordion.ts:57`), and `placeGutter` positions it at `upperBottom − RESIZE_GUTTER_SIZE` overlaying the **upper section's content bottom**, reserving no layout budget (`Accordion.ts:1582-1590`).

So the drag target is a full 6px regardless of compact — **but** it sits on top of the bottom 6px of the tree, i.e. a quarter of the last visible 24px tree row, which stops being a row-click target. **Decision: accept it, and manual-verify it.** The app has no knob (no `setGutterSize`), the geometry matches VSCode's explorer, and 6px over the last row's lower quarter is the library's chosen trade-off. The gutter is also created with `expandedBackground: "transparent"` (`Accordion.ts:1559`), so the affordance is **cursor-only** (a `row-resize` cursor on hover) — this is expected, not a bug to chase.

### No library rebuild is required

Verified: the symlinked `node_modules/@jimka/typescript-ui → /home/jika/typescript/typescript-ui` build already ships the feature. `dist/lib/types/component/container/AccordionPanel.d.ts:15` declares `resizable?: boolean`, `dist/lib/types/layout/Accordion.d.ts:73` declares `setResizable(value: boolean): this`, `dist/lib/component/container.es.js` contains the runtime, and `dist/` is newer than `src/`. **Step 0 re-checks this** — if it ever comes back empty, run `npm run build:lib` (**not** `npm run build`) in `/home/jika/typescript/typescript-ui`.

---

## Ordered Implementation Steps

1. **Confirm the built library carries the option.** Run:
   ```
   grep -n "resizable" /home/jika/typescript/sqladmin/frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/container/AccordionPanel.d.ts
   ```
   Expect `resizable?: boolean;`. If empty, run `npm run build:lib` in `/home/jika/typescript/typescript-ui` first (not `npm run build`), then re-run the grep.

2. **`frontend/src/properties/PropertyValuePanel.ts` — lower the inspector's drag floor.** Add a second constant beside `PANEL_HEIGHT` (L26) and rewrite the L22-25 comment block, which currently documents the now-removed min/preferred pin:
   ```ts
   // The inspector's natural height at the bottom of the sidebar accordion: the
   // tree/navigator above it takes the rest, and this is what the accordion's
   // resizable mode seeds the section's stored height from (see
   // ../shell/treeExplorerView.ts). The Table scrolls internally if the property
   // list exceeds it.
   const PANEL_HEIGHT = 220;

   // The inspector's floor. Under the accordion's resizable mode this is the
   // gutter drag's lower stop (the drag floors each section at getMinSize) — it
   // was previously pinned to PANEL_HEIGHT, which let the user drag the inspector
   // only bigger, never smaller. 96px mirrors treeExplorerView's TREE_MIN_HEIGHT
   // so neither section can be dragged away entirely.
   const PANEL_MIN_HEIGHT = 96;
   ```
   Then change **only** the `minSize` line in the `Panel({...})` call (L46), leaving `preferredSize` at `PANEL_HEIGHT`:
   ```ts
   preferredSize: { width: 0, height: PANEL_HEIGHT },
   minSize      : { width: 0, height: PANEL_MIN_HEIGHT },
   ```
   Check: `grep -n "PANEL_HEIGHT\|PANEL_MIN_HEIGHT" frontend/src/properties/PropertyValuePanel.ts` — `PANEL_HEIGHT` must survive on the `preferredSize` line.

3. **`frontend/src/shell/treeExplorerView.ts` — floor the tree and turn resizable on.** Add the constant above the class (after the imports):
   ```ts
   // The tree section's floor and its preferred height. Both are set to the same
   // value: under the accordion's resizable mode getMinSize is the gutter drag's
   // stop, and a Tree reports a min of 0 (it overrides no getMinSize, and the
   // default LayoutManager min is 0) — so without a floor the drag could erase
   // the tree, and a first layout with no leftover height would store a zero size
   // that proportional rescaling can never grow back. 96px is four rows at the
   // library Tree's fixed 24px ROW_HEIGHT. Set as preferred too so the section
   // never reports min > preferred; the fillWeight below still grows the tree
   // into all the leftover height, so the rendered result is unchanged.
   const TREE_MIN_HEIGHT = 96;
   ```
   Replace the `tree.setPreferredSize(0, 0);` call and its L50-54 comment with:
   ```ts
   // The tree's section takes all the leftover height via its fillWeight below;
   // TREE_MIN_HEIGHT is its floor, not its target. Pre-super: `this` is
   // unavailable until super() returns.
   tree.setPreferredSize(0, TREE_MIN_HEIGHT);
   tree.setMinSize(0, TREE_MIN_HEIGHT);
   ```
   Add `resizable: true` to the `super({...})` options bag (L55-61), beside `id` and above `sections`:
   ```ts
   super({
       id: config.id,
       // Draggable gutter between the tree and the inspector, so the user
       // apportions the height. The tree's fillWeight seeds the split at exactly
       // today's geometry (tree fills, inspector at its 220px preferred); a drag
       // is authoritative from then on and survives a section toggle and a rail
       // switch.
       resizable: true,
       sections: [ /* unchanged */ ],
   });
   ```
   Leave `fillWeight: 1`, `setCompact(true)`, `setToolsVisibility("always")`, and `bindRefreshShortcut` untouched.

4. **`frontend/src/shell/treeExplorerView.ts` — update the class doc comment.** The L36-42 JSDoc and the L1-3 header comment both describe the inspector as fixed-height. Amend both to say the tree seeds at the fill height and the inspector at its preferred 220, with a draggable gutter between them from then on.

5. **`frontend/src/shell/QueriesView.ts` — same treatment for the Saved/Recent rail.** Add a constant near the other module constants:
   ```ts
   // Each section's floor and preferred height. Under the accordion's resizable
   // mode getMinSize is the gutter drag's stop; a Fit Panel over a zero-preferred
   // List reports a min of only its 8px insets, which would let a drag reduce a
   // section to a sliver. 96px mirrors treeExplorerView's TREE_MIN_HEIGHT. Set as
   // preferred too so a section never reports min > preferred; the equal
   // fillWeights still split all the leftover height, so the rendered result is
   // unchanged.
   const SECTION_MIN_HEIGHT = 96;
   ```
   At L183 in `buildSection`, give the host an explicit preferred and min (mirroring `PropertyValuePanel`'s proven `Fit` Panel shape):
   ```ts
   const host = Panel({
       layoutManager: new Fit(),
       preferredSize: { width: 0, height: SECTION_MIN_HEIGHT },
       minSize      : { width: 0, height: SECTION_MIN_HEIGHT },
   });
   ```
   Add `resizable: true` to the `super({...})` bag (L125-132), beside `id`, with a one-line comment pointing at the equal `fillWeight`s as the seed.

6. **Regression greps.**
   - `grep -rn "setPreferredSize(0, 0)" frontend/src/shell/` — expect **zero** matches (the tree call is gone; `buildList`'s zero-preferred List uses the options-bag form at `QueriesView.ts:321` and is intentionally untouched).
   - `grep -rn "resizable: true" frontend/src/` — expect exactly two matches: `treeExplorerView.ts` and `QueriesView.ts`. (A bare `grep -rn "resizable"` also hits pre-existing, unrelated prose already on `main` — `shell/SqlAdminShell.ts:8`, `shell/localStorageWindow.ts:1,31`, `dock/QueryPanel.ts:4,140` — describing the unrelated `Split` gutter and a floating `Window`; scope to the option spelling to avoid a false failure against those.)
   - `grep -rn "resizable: true" frontend/src/dock/` — expect **zero** matches (StructurePanel and ExplainDiagramPanel stay out; `dock/QueryPanel.ts`'s pre-existing "resizable" prose is unrelated — see above).

7. **`npm run typecheck` in `frontend/`.** Expect clean. A failure on `resizable` means step 1's build check was skipped.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `frontend/src/shell/treeExplorerView.ts` |
| Modify | `frontend/src/properties/PropertyValuePanel.ts` |
| Modify | `frontend/src/shell/QueriesView.ts` |

`DatabaseExplorerView.ts` and `RolesExplorerView.ts` inherit the change — **do not edit them**.

---

## Expected Behaviour

Everything below is **manual-verify** unless marked otherwise. This repo's vitest runs in the `node` environment over `tests/**` only (`frontend/vitest.config.ts`), and every module here transitively imports library UI code that touches `document` at import scope — none of these cases can be driven by a unit test, and no new test file should be created for them.

**Initial render is unchanged (the regression that matters most).**
1. Database rail, normal window: the Properties inspector is exactly **220px** tall and the Database tree fills all remaining height. Byte-for-byte what `main` renders. Same for the Roles rail ("Details" at 220px).
2. Queries rail: Saved and Recent split the leftover height equally, as on `main`.

**The gutter.**
3. Hovering the boundary between the tree's content bottom and the "Properties" header shows a `row-resize` cursor. There is **no visible divider** — the gutter is transparent by design.
4. Dragging that boundary **up** shrinks the tree and grows the inspector; dragging **down** grows the tree and shrinks the inspector. The gutter tracks the cursor.
5. Dragging up stops when the tree reaches **96px** (~4 rows). Dragging down stops when the inspector reaches **96px** — *this is the case that fails on `main`'s min of 220, and is the point of step 2.*
6. Overshooting a stop and reversing: the gutter re-engages immediately at the cursor (the library retains the overshoot as a dead zone), it does not jump.
7. With only two sections there is exactly **one** gutter, and it never appears above the first header or below the last.

**Persistence within the session.**
8. Drag the Properties inspector to ~400px, collapse the Properties section via its header, re-expand it → it returns to ~400px, not 220px.
9. Drag the inspector to ~400px, switch to the Roles rail and back to Database → still ~400px. The Roles rail keeps its own independent split.
10. Drag, then collapse the whole sidebar via the active rail button, then expand → the split is preserved.
11. Reload the page → the split resets to tree-fills / inspector-220. **Expected**, per the persistence decision.

**Container resize (a deliberate behaviour change).**
12. With no drag performed, resizing the window taller grows **both** sections proportionally from the seeded ratio — on `main` the tree absorbed 100% of the change. This is the library's intended resizable behaviour; do not "fix" it.
13. After a drag, resizing the window preserves the dragged **ratio**, and neither section is pushed below its 96px floor while the sidebar is tall enough to honour both.

**Untouched surfaces.**
14. Alt+R still refreshes the focused rail's tree (`bindRefreshShortcut`); the header tools (Refresh, Create schema) still fire on click and are unaffected by the gutter — the gutter overlays the *content* bottom, never a header.
15. `StructurePanel`'s dock tab still scrolls its whole accordion stack when several sections are open, with no gutters.
16. The menu's "Open Saved…" / "Query History…" still expands and focuses the right Queries section (`controller.setQueriesSectionFocus`, `QueriesView.ts:143-147`).

---

## Verification

1. `cd frontend && npm run typecheck` — clean.
2. `cd frontend && npm run test` — unchanged, all green. No new tests (see `## Expected Behaviour`).
3. The three greps in step 6.
4. **Manual smoke, per the `sqladmin-login-driving-app` note (log in with Host `sqladmin-db`, not `localhost`):** drive the WEST sidebar. Walk cases 1-2 (initial render — compare against `main` before committing), 4-6 (drag stops in both directions — case 5 is the one that regresses if step 2 is skipped), 8-9 (toggle and rail switch), and 12 (window resize). Then open a table's Structure dock tab and confirm case 15.

---

## Potential Challenges

- **The seed is taken once, at the first layout with a container size — a degenerate first layout would lock a wrong ratio.** `computeResizableHeights` bails only when `getInnerSize()` is `null` (`Accordion.ts:2105`), and `getInnerSize` reads the layout-assigned `_width`/`_height`, not the DOM — so an accordion laid out before its host has a real height would seed from a `96:220` ratio rather than `fill:220`. The floors added in steps 2/3/5 **bound the damage** (the worst case is a usable 96:220 split the user can drag, not a zero-height tree), and `Card` only ever lays out the visible page, so the pathway is narrow. Case 1 of `## Expected Behaviour` is the check. If it ever reproduces, the fix is library-side (a reseed / `setResizeSizes` API) — **do not** hack around it in the app.
- **The bottom 6px of the tree stops being a row-click target** (the gutter overlays it). Accepted; `RESIZE_GUTTER_SIZE` has no setter. Confirm during the manual smoke that clicking the *middle* of the last tree row still selects it.
- **Do not add a `fillHeight` call anywhere in these files.** `setFillHeight` now opts *every* open section into weight 1, which would fight the explorer rails' deliberate "only the tree fills" seed.

---

## Critical Files

Read before starting:

- `/home/jika/typescript/sqladmin/frontend/src/shell/treeExplorerView.ts` — the seam; the base both explorer rails inherit.
- `/home/jika/typescript/sqladmin/frontend/src/properties/PropertyValuePanel.ts` — the shared inspector base; **`minSize` here is the drag floor**.
- `/home/jika/typescript/sqladmin/frontend/src/shell/QueriesView.ts` — the third rail; `buildSection`'s `host` (L183) is the section component `_resizeSizes` keys on, and it is stable across `refresh()`.
- `/home/jika/typescript/sqladmin/frontend/COMPONENT_CONVENTIONS.md` — class-first, and §(b) the super-cascade trap: `tree.setPreferredSize`/`setMinSize` must stay **before** `super()`, on the local, since `this` is unavailable until `super()` returns.
- `/home/jika/typescript/typescript-ui/src/typescript/lib/layout/Accordion.ts` — reference only, **never edit**. `setResizable` (L563), `computeResizableHeights` + the seed (L2104-2151), `distributeWithinConstraints` (L2180), the drag's min/max reads (L1691-1700), `RESIZE_GUTTER_SIZE` (L57).
- `/home/jika/typescript/typescript-ui/docs/layouts/Accordion.md` — the "Resizable sections" section, incl. the corrected seamless-toggle claim.
- `/home/jika/typescript/sqladmin/frontend/src/shell/SqlAdminShell.ts:420-430` — `buildSidebar`; each view is constructed once per session, which is why the drag survives a rail switch.

---

## Non-Goals

- **Persisting the split across reloads.** Needs library API to read/write `_resizeSizes`; see the persistence decision.
- **`StructurePanel` and `ExplainDiagramPanel`.** Out with reasons in the scope decision — do not add `resizable` to `frontend/src/dock/`.
- **Changing `fillWeight: 1`, `setCompact(true)`, or `setToolsVisibility("always")`.** All three still do their job; `fillWeight` is what makes the seed seamless.
- **Styling the gutter or changing its 6px thickness.** No app-side knob exists.
- **Fixing `StructurePanel`'s now-stale fill comment.** Separate, pre-existing drift from the same library update: [`dock/StructurePanel.ts:160-163`](frontend/src/dock/StructurePanel.ts#L160) says "the last open section grows to fill leftover height", but the library's `setFillHeight` now spreads the slack across *every* open section by weight (typescript-ui changelog, commit `1079eb8e`). The remediation is an explicit `fillWeight: 1` on the Columns section plus a comment fix — **out of scope here**; raise it separately.
