# Explain Accordion Resize — Implementation Plan

## Overview

The Explain-diagram panel's WEST info column ([`frontend/src/dock/ExplainDiagramPanel.ts:153`](frontend/src/dock/ExplainDiagramPanel.ts#L153)) is a three-section `AccordionPanel` — Summary, Plan tree, Plan steps — built with no `resizable` option and no bound on the Plan tree's reported height. Two problems follow. First, `tree.expandAll()` flattens the whole plan into visible rows with no cap on the tree's preferred height, so on a large plan the accordion's shrink math (`Accordion.computeShrinkRatio`/`openContentHeight`) crushes Summary and Plan steps toward their own minimums — both currently `0` — while the oversized tree renders scaled down instead of scrolling internally. Second, there is no way for the user to trade height between the three sections by hand.

This plan bounds Plan tree's reported height, gives all three sections real minimum floors, turns on `resizable: true`, and wires the already-existing but currently unused `loadSizes`/`onSizes` persistence hook from [`frontend/src/data/layoutStore.ts:200`](frontend/src/data/layoutStore.ts#L200). The whole change is scoped to [`frontend/src/dock/ExplainDiagramPanel.ts`](frontend/src/dock/ExplainDiagramPanel.ts), plus a one-line doc-comment touch-up in [`frontend/src/dock/QueryPanel.ts:138`](frontend/src/dock/QueryPanel.ts#L138). No exported symbol changes, and no changes to `data/layoutStore.ts` — its `AccordionSite`/`bindAccordion("explainDiagram")` plumbing already has the right shape.

The direct precedent is [`frontend/src/shell/treeExplorerView.ts`](frontend/src/shell/treeExplorerView.ts), which already does `resizable: true` plus real min floors plus `applySectionSizes`/`on("sectionresize", ...)` wiring for the sidebar rails. `plans/implemented/explorer-resizable-sections.md` is that precedent's own plan and explicitly scoped `ExplainDiagramPanel` **out**, flagging exactly the risk this plan resolves: a third open-by-default section with no min floor that an unguarded drag could crush to zero.

---

## Architecture Decisions

### Turning on `resizable` is the actual fix for the crush-toward-zero bug — not just the drag affordance

Without `resizable`, every layout of an overflowing accordion runs `computeShrinkRatio` (`Accordion.ts:1992`), which computes **one** ratio from the *combined* preferred/min of every open section and applies it to each section individually (`openContentHeight`, `Accordion.ts:2061`). A section with `minSize.height: 0` shrinks all the way to `0` before a section with a large min does — today, Summary and Plan steps both have `minSize.height: 0`, so they lose first while the ballooned Plan tree — which also has an effective min of `0` — merely renders below its (huge) preferred size.

With `resizable: true`, every layout instead runs `computeResizableHeights` → `distributeWithinConstraints` (`Accordion.ts:2313`, `2434`). This path treats every **unweighted** open section (`weight` unset or `0`) as *resize-pinned*: it holds its own stored pixel height across a container resize, while only the **weighted** section absorbs the change[^resize-pinning]. Giving Plan tree the accordion's sole `weight` and giving Summary/Plan steps real (non-zero) min floors turns this into exactly the wanted shape — automatically, without any separate "shrink" logic to write. The floors matter because `distributeWithinConstraints` still floors every section, pinned or free, at its own `getMinSize()` (`Accordion.ts:2470-2482`) — a `0` floor is what let the old crush happen, and a real floor is what stops it.

| Section | `weight` | Container resize, no drag | Gutter-drag floor |
|---|---|---|---|
| Summary | none | holds its stored px — stays at `SUMMARY_HEIGHT` (88) | 88px |
| Plan tree | `1` | absorbs the entire change | `PLAN_TREE_MIN_HEIGHT` (96) |
| Plan steps | none | holds its stored px — stays at `PLAN_STEPS_MIN_HEIGHT` (96) | 96px |

`plans/implemented/explorer-resizable-sections.md` (written against an older library revision) says a container resize rescales *every* open section proportionally, weighted or not — its own Expected Behaviour case 12 states this explicitly. That is no longer accurate: the current library (confirmed directly in [`packages/lib/src/typescript/lib/layout/Accordion.ts`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts) and [`packages/lib/docs/layouts/Accordion.md`](/home/jika/typescript/typescript-ui/packages/lib/docs/layouts/Accordion.md), "Resizable sections") added the resize-pinning behaviour in the table above. Do not follow that older plan's resize-behaviour description — follow the current source and docs, cited here.

### Bound Plan tree's own reported height

[`Tree.getPreferredSize`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L208) returns `flatRows.length * ROW_HEIGHT` whenever the caller has set no explicit `preferredSize` constraint — exactly the "no bound at all" ballooning this plan fixes. Setting an explicit `preferredSize`/`minSize` makes `getPreferredSizeConstraint()` non-null, so `getPreferredSize()` returns the fixed value instead[^tree-preferred-override]. `PLAN_TREE_MIN_HEIGHT = 96` (four rows at Tree's fixed 24px `ROW_HEIGHT`) mirrors `treeExplorerView.ts`'s `TREE_MIN_HEIGHT` exactly — same Tree class, same derivation, same "set as both min and preferred so the section never reports min > preferred" reasoning.

This constant only bounds what Plan tree *asks for* in the shrink/seed math — its `weight: 1` (already present) still grows it to fill the leftover height once `distributeWithinConstraints` resolves the open budget, so the rendered height is normally far larger than 96px. The 96px floor only bites when the container is small or the user drags a gutter down hard.

### Plan tree's internal scroller needs no separate opt-in

`Tree` extends `VirtualRowView` ([`Tree.ts:123`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L123)), whose `VirtualScroller` decides whether to show a scrollbar by comparing the *owner's rendered height* (`getHeight()`) against the total content height (`computeScrollbarVisibility`, [`VirtualScroller.ts:300`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/container/VirtualScroller.ts#L300)) — not against any preferred-size hint. So the moment the Accordion assigns Plan tree less height than `flatRows.length * ROW_HEIGHT` needs, the tree scrolls internally on its own; nothing else has to be turned on. `Table`'s body uses the same `VirtualScroller` machinery ([`Table.ts:264-266`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L264)), so Plan steps gets the same free internal scroll once its own assigned height is less than its row count needs.

### Give Summary and Plan steps real, non-zero min floors — and drop Plan steps' `weight`

Both currently set `minSize.height: 0` ([`ExplainDiagramPanel.ts:289`](frontend/src/dock/ExplainDiagramPanel.ts#L289), [`:312`](frontend/src/dock/ExplainDiagramPanel.ts#L312)) and Plan steps additionally carries `weight: 1` ([`:159`](frontend/src/dock/ExplainDiagramPanel.ts#L159)) — both defects the precedent plan flagged as unaddressed for this panel.

- **Summary**: raise `minSize.height` from `0` to the already-existing `SUMMARY_HEIGHT` (88) — no new constant. Summary's content is always exactly two rows (planning/execution time); there is no smaller-but-still-useful state, so `min == preferred` is the correct floor, not an arbitrary smaller number.
- **Plan steps**: give it an explicit `preferredSize`/`minSize` of a new `PLAN_STEPS_MIN_HEIGHT = 96`, mirroring the app's already-established 96px accordion-section floor (`treeExplorerView.ts`'s `TREE_MIN_HEIGHT`, `PropertyValuePanel.ts`'s `PANEL_MIN_HEIGHT`, `QueriesView.ts`'s `SECTION_MIN_HEIGHT` — all three files, all three exactly 96). Table's own row height is theme-driven, not a fixed constant like Tree's, so this floor is justified by the app-wide convention rather than an "N rows" derivation. Drop Plan steps' `weight: 1` — only Plan tree should absorb the accordion's leftover space; if two sections both carried weight, opening Plan steps would steal fill from Plan tree instead of holding its own fixed height.

### Wire the already-existing `loadSizes`/`onSizes` hook — it matters more here than for the sidebar rails

`AccordionLayoutBinding` already has a working `loadSizes`/`onSizes` pair (`data/layoutStore.ts:77-86`), and `bindAccordion("explainDiagram")` already returns it fully wired — `plans/implemented/layout-persistence.md` (line 138 of that plan's own site table) built this generically for every `AccordionSite` but left `explainDiagram` as "open only" because the accordion wasn't resizable yet. `ExplainDiagramPanel` simply never calls `loadSizes`/`onSizes` today.

Wiring this matters more here than it did for `treeExplorerView.ts`: the sidebar rails are constructed once per app session (`SqlAdminShell.ts` builds each view once), so their `Accordion`'s in-memory `_resizeSizes` map survives for the whole session even without persistence. `ExplainDiagramPanel` is rebuilt on every Explain run (its own header comment: "never itself a top-level dock tab ... constructed inside QueryPanel's diagram slot"), so every new Explain tab gets a **fresh** `Accordion` with an empty `_resizeSizes`. Without wiring `loadSizes`/`onSizes`, a user's drag on one Explain tab would be silently forgotten the next time they ran Explain — the wiring is what makes one shared "explainDiagram" proportion apply across every Explain tab, and survive a page reload via `localStorage`.

`AccordionPanel` has no `sectionSizes` constructor passthrough — `AccordionPanelOptions` only declares `resizable?: boolean`, not `sectionSizes` (confirmed in [`AccordionPanel.ts:40-49`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/container/AccordionPanel.ts#L40)) — so restoring saved sizes goes through `accordion.getAccordion().applySectionSizes(...)` after construction, exactly the shape `treeExplorerView.ts:100-108` and `plans/implemented/layout-persistence.md`'s own "two wiring shapes" section (~line 416) already use. `ExplainDiagramPanel` builds `accordion` as a local before `super()` (it must — it's `super()`'s WEST child), but the restore/listener calls need no `this`, so they belong in the constructor body right after `super()` returns, next to this file's other post-super `.on(...)` wiring (the file's own header comment already documents that convention for the tree/diagram selection listeners).

### Why `StructurePanel`'s outer-autoScroll pattern does not apply here

`StructurePanel` wraps its whole accordion in an `autoScroll: "auto"` VBox at `weight: 1` ([`StructurePanel.ts:127`](frontend/src/dock/StructurePanel.ts#L127)) so the **entire stack** scrolls when its four sections overflow — there is no fixed-top/fixed-bottom shape there, every section is equally scrollable as a unit. That is the opposite of what this plan needs (top and bottom pinned, only the middle scrolls), and the two are structurally incompatible: `distributeWithinConstraints` forces the open section set to sum to the accordion's own inner budget on every layout, which fights an outer host that wants to hand the accordion more height than its budget and scroll the overflow itself. `plans/implemented/explorer-resizable-sections.md` already ruled `StructurePanel` out of its own resizable adoption for this exact reason. Do not adopt `StructurePanel`'s pattern here.

### Non-interaction with the Border WEST chevron

The accordion sits inside a `Border` region (`Placement.WEST, collapsible: true`, [`ExplainDiagramPanel.ts:178`](frontend/src/dock/ExplainDiagramPanel.ts#L178)). That chevron toggles the whole WEST column's displayed state at the `Border` layer; it has no interaction with the `Accordion` layout manager nested inside it. No change needed there.

---

## Ordered Implementation Steps

All steps are in [`frontend/src/dock/ExplainDiagramPanel.ts`](frontend/src/dock/ExplainDiagramPanel.ts) unless noted.

1. **Add the two new height constants** after the existing `SUMMARY_HEIGHT` (currently `:59-64`):
   ```ts
   // Plan tree's floor and target-until-fill height (px): four rows at the
   // library Tree's fixed 24px ROW_HEIGHT (mirrors treeExplorerView.ts's
   // TREE_MIN_HEIGHT — same Tree class, same derivation). Set as both the
   // section's minSize and preferredSize below: Tree.getPreferredSize reports
   // flatRows.length * ROW_HEIGHT (an ever-growing number after expandAll())
   // whenever no explicit preferredSize constraint is set, so leaving this
   // unset is what let Plan tree balloon past its siblings' budget. The
   // section's weight: 1 still grows it into all the leftover height once
   // resizable mode resolves the open budget — this constant only bounds what
   // Plan tree asks for, not what it renders at.
   const PLAN_TREE_MIN_HEIGHT = 96;

   // Plan steps' fixed height (px), mirroring the app's established 96px
   // accordion-section floor (treeExplorerView's TREE_MIN_HEIGHT,
   // PropertyValuePanel's PANEL_MIN_HEIGHT, QueriesView's SECTION_MIN_HEIGHT).
   // Set as both minSize and preferredSize, and carries no weight, so under
   // resizable mode it holds this px across a container resize instead of
   // growing or shrinking with the window or the plan's row count — the flat
   // steps table scrolls internally (Table's own VirtualScroller) for rows
   // beyond what this height shows.
   const PLAN_STEPS_MIN_HEIGHT = 96;
   ```

2. **Bound the tree's own reported height.** In the constructor, right after `tree.expandAll();` (currently `:139`), add:
   ```ts
   // Bound Plan tree's own reported preferred height so it stops growing with
   // the flattened row count (see Tree.getPreferredSize; PLAN_TREE_MIN_HEIGHT's
   // comment above has the full reasoning). Its weight: 1 (below) still grows
   // it to fill the accordion's leftover height; this only sets the floor and
   // the shrink/seed baseline.
   tree.setPreferredSize({ width: 0, height: PLAN_TREE_MIN_HEIGHT });
   tree.setMinSize({ width: 0, height: PLAN_TREE_MIN_HEIGHT });
   ```

3. **`buildSummaryTable` — raise the min floor and update its stale doc comment.** The function doc (`:266-276`) currently says "...relaxed min so the accordion section hugs it rather than reserving the Table's default 100px floor" — no longer true once the min is `SUMMARY_HEIGHT`. Replace that sentence with: "...and a real min floor equal to its own fixed height, so the accordion's resizable mode can pin it but never crush it." Then change the `setMinSize` call at `:289`:
   ```ts
   table.setMinSize({ width: 0, height: SUMMARY_HEIGHT });
   table.setPreferredSize({ width: LEFT_WIDTH, height: SUMMARY_HEIGHT });
   ```
   (The `setPreferredSize` line is unchanged — only `setMinSize`'s height moves from `0` to `SUMMARY_HEIGHT`.)

4. **`buildStepsTable` — add a fixed preferred height and raise the min floor; update its stale doc comment.** The function doc (`:295-303`) doesn't mention min/preferred at all yet, so add a sentence: "Pinned to `PLAN_STEPS_MIN_HEIGHT` (min and preferred) so the accordion's resizable mode holds it at a fixed, sane height and scrolls its rows internally rather than growing." The existing comment at `:310-311` ("Relax the Table's default 100×100 floor so the accordion can size the section to the column's height rather than the Table's minimum.") is also stale — replace with: "A real min floor (not the Table's default 100×100) so the accordion's resizable mode can pin this section but never crush it to zero." Then change `:312` and add a new call:
   ```ts
   table.setMinSize({ width: 0, height: PLAN_STEPS_MIN_HEIGHT });
   table.setPreferredSize({ width: LEFT_WIDTH, height: PLAN_STEPS_MIN_HEIGHT });
   ```

5. **Turn on `resizable` and drop Plan steps' `weight`.** In the `accordion` construction (currently `:153-162`):
   ```ts
   const accordion = new AccordionPanel({
       preferredSize: { width: LEFT_WIDTH, height: 0 },
       minSize      : { width: LEFT_WIDTH, height: 0 },
       // Draggable gutters between adjacent open sections (up to two, once
       // Plan steps is also open). Plan tree carries the accordion's only
       // weight, so it alone absorbs leftover height on an ordinary resize;
       // Summary and Plan steps hold their fixed height (see the min-floor
       // constants above) unless the user drags a gutter, which can still
       // resize any of the three — floored at its own min. See
       // ## Architecture Decisions in explain-accordion-resize.md.
       resizable: true,
       sections: [
           { label: "Summary",    component: buildSummaryTable(summary), initiallyOpen: open[0] },
           { label: "Plan tree",  component: tree,                       initiallyOpen: open[1], weight: 1 },
           { label: "Plan steps", component: stepsTable,                 initiallyOpen: open[2] },
       ],
       onSectionToggle: layout.onToggle,
   });
   ```
   (Only two things change from today: the new `resizable: true` line, and removing `weight: 1` from the "Plan steps" entry. "Plan tree"'s `weight: 1` is unchanged.)

6. **Rewrite the stale "WEST info column" comment** immediately above the `accordion` construction (currently `:149-152`, "The WEST info column: a Summary table over the plan tree over the flat steps table. The tree + steps sections share the column's leftover height (weight) so each scrolls internally; the summary stays pinned at its small fixed height." — this already describes the *intended*, not the actual pre-this-plan, behaviour). Replace with:
   ```ts
   // The WEST info column: a fixed-height Summary table over the plan Tree
   // over a fixed-height flat Plan-steps table, with draggable gutters
   // between every adjacent pair of open sections (resizable: true below).
   // Only Plan tree carries a weight, so it alone absorbs the column's
   // leftover height on an ordinary resize — expanding to fill available
   // space and, once its own VirtualRowView-backed scroller is given less
   // height than the flattened row count needs, scrolling internally rather
   // than reporting an ever-growing preferred height. Summary and Plan steps
   // stay pinned at their own fixed height (PLAN_STEPS_MIN_HEIGHT et al.)
   // regardless of window size or the plan's row count; a user gutter-drag
   // can still resize any of the three, floored at its own min.
   ```

7. **Restore saved sizes and wire the save hook**, right after `super({...});` ends (currently `:181`) and before the "Three-way cross-selection" comment block (currently `:183`):
   ```ts
   // Restore the last dragged section split, if any (a stale array is
   // discarded by the library; the accordion falls back to its normal
   // weight-seeded sizing instead). Unlike the sidebar rails, this panel is
   // rebuilt on every Explain run — without this, a drag on one Explain tab
   // would be forgotten the moment a new one opens (see ## Architecture
   // Decisions in explain-accordion-resize.md).
   const savedSizes = layout.loadSizes();

   if (savedSizes !== null) {
       accordion.getAccordion().applySectionSizes(savedSizes);
   }

   accordion.getAccordion().on("sectionresize", layout.onSizes);
   ```

8. **Update the constructor's `@param layout` doc comment** (currently `:124-126`, "...via QueryPanel). This accordion is not resizable, so only open state persists."). Replace the last sentence with: "The accordion is resizable — a dragged gutter's sizes persist alongside each section's open flag."

9. **`frontend/src/dock/QueryPanel.ts:138`** — the `explainDiagramLayout` doc comment currently reads "The saved Explain-diagram info-column Accordion open state plus its save hooks...". Change "open state" to "open state and section sizes" so it matches what the binding now actually saves.

10. **Regression greps:**
    - `grep -n "resizable: true" frontend/src/dock/ExplainDiagramPanel.ts` — expect exactly one match.
    - `grep -n "weight: 1" frontend/src/dock/ExplainDiagramPanel.ts` — expect exactly one match (Plan tree only).
    - `grep -n "setMinSize({ width: 0, height: 0 })" frontend/src/dock/ExplainDiagramPanel.ts` — expect zero matches (both `0`-height mins are gone).
    - `grep -n "PLAN_TREE_MIN_HEIGHT" frontend/src/dock/ExplainDiagramPanel.ts` — expect exactly three matches (the declaration plus its use in `setPreferredSize` and `setMinSize`). Same check for `PLAN_STEPS_MIN_HEIGHT` (declaration plus its use in `setMinSize` and `setPreferredSize`).

11. **`cd frontend && npm run typecheck`.** Expect clean.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `frontend/src/dock/ExplainDiagramPanel.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` (one doc-comment line only) |

`frontend/src/data/layoutStore.ts` is read, not modified — `bindAccordion("explainDiagram")` already returns the full binding this plan wires up.

---

## Expected Behaviour

This is a geometry/drag change. `frontend/vitest.config.ts` runs only the `node` environment over `tests/**`, and every touched module transitively imports library UI code that touches `document` at import scope — none of the following is unit-testable in this repo, and no new test file should be created for it. Every case below is manual-verify.

**Small plan (today's common case) — visually unchanged.**
1. Run an Explain on a query whose plan has few nodes. Summary renders at exactly 88px; Plan tree fills the rest of the WEST column, same as before this plan (the resize-pinned seed reproduces the weight-seeded split pixel-for-pixel — see the "resizable is seamless with a weight already set" reasoning cited in Architecture Decisions).

**Large plan — the bug this plan fixes.**
2. Run an Explain on a query whose plan has enough nodes that the flattened tree (`expandAll()`) would, pre-fix, exceed the WEST column's height. Summary still renders at exactly 88px (not crushed). Plan tree renders at its allotted height (bounded, not growing past the container) and shows an internal vertical scrollbar that scrolls through every flattened row. A good stress case: any query producing many plan nodes (e.g. several joins) — the `hub` schema's deep FK chain is a known way to get a large plan.

**Opening the third section.**
3. With Summary and Plan tree open (the default), open "Plan steps". A second gutter appears between Plan tree and Plan steps. Plan steps renders at exactly 96px and shows a handful of rows; if the plan has more steps than fit, it scrolls internally (Table's own `VirtualScroller`). Plan tree shrinks by Plan steps' height (plus its header and inter-section spacing) but still absorbs whatever height is left — it does not go below 96px unless the window itself is that short.

**Gutter drags — floored, not crushed.**
4. Drag the Summary/Plan-tree gutter down (growing Summary): Summary grows past 88px with no upper bound; Plan tree shrinks, floored at 96px.
5. Drag that same gutter up (shrinking Summary): the drag stops at 88px — Summary cannot be dragged smaller.
6. With Plan steps open, drag the Plan-tree/Plan-steps gutter in both directions: Plan steps floors at 96px in the same way; Plan tree still floors at 96px on the other side.

**Container resize with no drag.**
7. Resize the browser window (no gutter ever dragged): Summary and Plan steps (if open) hold their fixed pixel height; only Plan tree grows or shrinks. This is the resize-pinning behaviour described in Architecture Decisions — do not "fix" it into a proportional rescale.

**Persistence.**
8. Drag the Summary/Plan-tree gutter, close and reopen Plan steps → the drag is retained (a closed section keeps its stored height). Close the Explain tab and run a new Explain (a brand-new `ExplainDiagramPanel` instance) → the new tab opens with the same dragged proportions, not the default seed. Reload the whole page → the dragged proportions are still restored (backed by `localStorage` via `bindAccordion("explainDiagram")`).

**Untouched surfaces.**
9. The Border WEST region's collapse chevron still tucks the whole info column into a strip and back, unaffected by the gutters inside it.
10. Tree/diagram/steps-table three-way cross-selection (`:183-262`) is unaffected — it operates on the same `tree`/`stepsTable`/`diagram` instances regardless of their rendered height.
11. `StructurePanel`'s dock tab still scrolls its whole accordion stack with no gutters — untouched by this plan.

---

## Verification

1. `cd frontend && npm run typecheck` — clean.
2. `cd frontend && npm run test` — unchanged, all green (no new tests; see `## Expected Behaviour`).
3. The four regression greps in step 10.
4. **Manual smoke** (per the `sqladmin-login-driving-app` note — log in with Host `sqladmin-db`, not `localhost`, when the backend runs under Compose): open a query panel, run `EXPLAIN` on a small query and a large one (case 2's stress case), and walk Expected-Behaviour cases 1-9 in order.

---

## Potential Challenges

- **A degenerate first layout (container laid out before it has a real height) could seed `_resizeSizes` from a tiny budget.** `distributeWithinConstraints` still floors every section at its own min on every subsequent layout regardless of what the stored seed was, so the worst case is a usable floored split the user can drag, never a zero-height section. `explorer-resizable-sections.md`'s own "Potential Challenges" flagged the same bounded risk for the sidebar rails; same mitigation applies here — if it ever reproduces visibly, the fix is library-side, not an app workaround.
- **The 6px resize gutter overlays the bottom of the section above it** (`RESIZE_GUTTER_SIZE`, `Accordion.ts:60`, no app-side setter) — with Plan steps open there are two such overlaps (Summary/Plan-tree and Plan-tree/Plan-steps). Accepted, matching the sidebar rails' identical trade-off; confirm during manual smoke that clicking the middle of a tree/table row still selects it.

---

## Critical Files

Read before starting:

- [`frontend/src/dock/ExplainDiagramPanel.ts`](frontend/src/dock/ExplainDiagramPanel.ts) — every edit in this plan lands here.
- [`frontend/src/data/layoutStore.ts:76-86,200-209`](frontend/src/data/layoutStore.ts#L76) — `AccordionLayoutBinding`/`bindAccordion`, unmodified but wired up by this plan.
- [`frontend/src/shell/treeExplorerView.ts`](frontend/src/shell/treeExplorerView.ts) — the precedent for `resizable: true` + real min floors + `applySectionSizes`/`on("sectionresize", ...)` wiring; mirror its shape exactly.
- `plans/implemented/explorer-resizable-sections.md` — introduced `resizable` to this codebase and explicitly scoped `ExplainDiagramPanel` out with the risk this plan resolves. Its resize-on-container-change description (Expected Behaviour case 12) is stale against the current library — see the callout in Architecture Decisions.
- `plans/implemented/layout-persistence.md` — the current, authoritative source for the `loadSizes`/`applySectionSizes`/`sectionresize` wiring shape (its "two wiring shapes" section, ~line 404) and for why `explainDiagram` was left "open only" until now.
- `plans/implemented/explain-plan-diagram.md:426` — this panel's original build; its one prior "resizable" note is about a *different* axis (a WEST-tree-vs-diagram `Split` gutter), not the accordion's internal sections — don't confuse the two.
- `frontend/src/dock/StructurePanel.ts` — the incompatible outer-autoScroll pattern; read it to understand why it's not reused here (see Architecture Decisions).
- [`/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/layout/Accordion.ts) — reference only, never edit. `computeShrinkRatio` (`:1992`), `openContentHeight` (`:2061`), `computeResizableHeights` (`:2313`), `resizePinnedSections`/`effectiveWeight` (`:2160-2200`), `distributeWithinConstraints` (`:2434`), `getSectionSizes`/`applySectionSizes` (`:1016-1054`), `setResizable` (`:604`). Note the path: the library moved to `packages/lib/src/...` in a monorepo restructure — the older precedent plan's citations under `typescript-ui/src/...` no longer exist.
- [`/home/jika/typescript/typescript-ui/packages/lib/docs/layouts/Accordion.md`](/home/jika/typescript/typescript-ui/packages/lib/docs/layouts/Accordion.md) — "Resizable sections", current and correct description of the resize-pinning behaviour this plan relies on.
- [`/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts:208`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/tree/Tree.ts#L208) and [`.../component/container/VirtualScroller.ts:300`](/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/container/VirtualScroller.ts#L300) — confirm the preferred-size override and the height-driven scroll-on mechanism.

---

## Non-Goals

- **A max-height cap on any of the three sections.** Only floors are added, matching the sidebar-rail precedent; unbounded growth on drag is intentional.
- **Styling or resizing the 6px gutter.** No app-side knob exists (`RESIZE_GUTTER_SIZE` has no setter).
- **The WEST-tree-vs-diagram `Split` gutter** noted as a future idea in `plans/implemented/explain-plan-diagram.md:426`. Different axis (Border-level, not this accordion's internal sections) — untouched by this plan.
- **`StructurePanel`'s accordion.** Different shape (outer auto-scroll over the whole stack); incompatible with `resizable` — see Architecture Decisions.
- **The Border WEST region's collapse chevron.** Orthogonal to the accordion's internal gutters; unaffected.
- **Changing `ACCORDION_DEFAULT_OPEN.explainDiagram`** (`data/layoutStore.ts:54`, `[true, true, false]`). Unchanged — this plan only affects section *sizes*, not default open state.

---

## Notes

[^resize-pinning]: `resizePinnedSections` (`Accordion.ts:2181`) pins every open section whose `effectiveWeight` is `0` at its own stored `_resizeSizes` value, *provided* at least one open section is weighted (`flexible > 0`) and the pinned sections' total doesn't already exceed the open budget. If neither holds — no weighted section is open, or the pinned floors alone overrun the container — pinning is skipped and the whole open set falls back to a proportional rescale, still floored per-section at each one's own min via the same clamp loop `distributeWithinConstraints` always runs. So the floors in this plan matter in both the common (pinned) and the degenerate (all-proportional) case.

[^tree-preferred-override]: `Tree.getPreferredSize()` (`Tree.ts:208`): `if (this.getPreferredSizeConstraint() !== null) return super.getPreferredSize();` — else it returns `{ width: DEFAULT_PREFERRED_WIDTH, height: this._flatRows.length * this.getRowHeight() }`. `getPreferredSizeConstraint()` reads the explicit `preferredSize` option/setter value, so calling `tree.setPreferredSize(...)` is what flips this from the row-count formula to the fixed value.

---

## Implementation Notes

All ten Ordered Implementation Steps were followed verbatim, including the
literal code/comment blocks steps 1, 2, 5, 6, 7 dictate. Step 10's regression
greps still pass in spirit (each config change lands exactly once, and the
zero-height `setMinSize` grep correctly finds nothing), but their **counts**
run higher than the plan's stated expectations: `resizable: true` matches
twice (the code line plus step 6's own mandated comment referencing it),
`weight: 1` matches three times (the code line plus steps 1 and 2's mandated
comments), `PLAN_TREE_MIN_HEIGHT` matches four times, and
`PLAN_STEPS_MIN_HEIGHT` matches five times — one more each than stated,
because steps 1, 2, 4, and 6's own mandated prose reiterates these tokens in
English. This is a self-inconsistency in the plan's own verification text
(the grep's expected counts were seemingly written before, or without
accounting for, the cross-referencing prose those same steps require), not a
codebase-drift incompatibility or a code defect — manual inspection confirms
each constant is declared once and consumed in exactly the `setMinSize`/
`setPreferredSize` calls the plan specifies, and `resizable`/`weight: 1` each
appear exactly once in actual config. No code was changed to chase the
stated counts, since doing so would mean stripping the plan's own mandated
explanatory comments.
