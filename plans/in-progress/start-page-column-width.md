# Start Page Column Width Cap — Implementation Plan

## Overview

The start page is the empty-workspace welcome screen shown in the shell's CENTER whenever no dock panels are open ([frontend/src/shell/StartPage.ts:64](frontend/src/shell/StartPage.ts#L64)). It is a `Panel` laid out as a vertical stack: an app heading, an optional welcome blurb, and a two-column row built by `buildColumns` ([frontend/src/shell/StartPage.ts:144](frontend/src/shell/StartPage.ts#L144)) — quick actions and the recent-tables / saved-queries lists on the left, the keyboard-shortcut legend and connection info on the right. Both columns are added to an `HBox` with `weight: 1` ([frontend/src/shell/StartPage.ts:147-148](frontend/src/shell/StartPage.ts#L147)), so each takes half of whatever width the window offers — on a wide monitor an even split produces two very wide, very sparse columns.

This change caps each column's width. Each column `Panel` gains a `maxSize` constraint alongside its existing `weight: 1`, so a column grows with the window up to a fixed ceiling and then stops, while still shrinking normally when the window is narrow. The capped block stays anchored to the page's left inset.

Only [frontend/src/shell/StartPage.ts](frontend/src/shell/StartPage.ts) changes. No library change is needed — the shipped `@jimka/typescript-ui` 0.4.1 already clamps a weighted `HBox` child to its `maxSize`.[^shipped-support]

---

## Architecture Decisions

### Cap each column with a `maxSize` constraint, keeping `weight: 1`

Each column `Panel` gets `maxSize: { width: COLUMN_MAX_WIDTH, height: UNBOUNDED }` in its own options bag, and keeps the `weight: 1` layout constraint it already has. The pair means "take an equal share of the row, but never more than `COLUMN_MAX_WIDTH`".[^weight-and-max]

This mirrors [frontend/src/dock/ExplainDiagramPanel.ts:152-155](frontend/src/dock/ExplainDiagramPanel.ts#L152), where a column's width policy is a module-level pixel constant applied as a size constraint inside the component's own options bag (`preferredSize`/`minSize` there, `maxSize` here). [frontend/src/shell/shortcutsDialog.ts:26-37](frontend/src/shell/shortcutsDialog.ts#L26) is the in-repo precedent for `maxSize` specifically being *the* tool for capping a component, including a written account of when not to reach for it.

### `COLUMN_MAX_WIDTH` is 420

420 pixels — the same width as the Keyboard Shortcuts dialog, which was sized to fit the widest keyboard-legend row without wrapping.[^column-width] The legend filling the right column is the widest fixed content on the page, so it sets the number.

### The capped block stays left-aligned

Once both columns hit the cap, the leftover width becomes empty space on the right; the columns stay at the page's left inset. The page is not centred.[^left-align]

### The welcome blurb is left alone

The Markdown welcome blurb already limits its own prose column — a *measure*, the maximum line length text is allowed to reach — to the theme's `--ts-ui-md-max-measure` (80 characters by default), so it never stretches to the window width and needs no cap of its own.[^blurb-already-capped]

---

## Implementation

The constant is declared after `BUTTON_HEIGHT`, at the end of the constants block at [frontend/src/shell/StartPage.ts:42-45](frontend/src/shell/StartPage.ts#L42), with its own comment — the block comment above `PAGE_PADDING` enumerates the four spacing/rhythm values in order and stays as it is:

```ts
// The widest a single column is allowed to grow. Matches the Keyboard Shortcuts
// dialog's width (shortcutsDialog.ts), which was picked to fit the widest
// "keys  label" legend row without wrapping — the legend is the widest fixed
// content either column carries, so it sets the ceiling. Below this width both
// columns still split the row evenly; above it they stop growing and the surplus
// stays as empty space to the right of the page.
const COLUMN_MAX_WIDTH = 420;
```

Both column builders take the same one-line addition — `buildLeftColumn` ([frontend/src/shell/StartPage.ts:162](frontend/src/shell/StartPage.ts#L162)) and `buildRightColumn` ([frontend/src/shell/StartPage.ts:182](frontend/src/shell/StartPage.ts#L182)):

```ts
const column = Panel({
    layoutManager: new VBox({ stretching: true, spacing: ENTRY_SPACING }),
    maxSize      : { width: COLUMN_MAX_WIDTH, height: UNBOUNDED },
});
```

`height: UNBOUNDED` is mandatory, not decorative: a finite height here would cap the columns' height as well, and — because the row's own maximum is derived from its children's maxima — would also stop the page's scroll host from growing to the full content height.[^unbounded-height]

---

## Ordered Implementation Steps

1. **Add `UNBOUNDED` to the primitive import.** In [frontend/src/shell/StartPage.ts:22](frontend/src/shell/StartPage.ts#L22), change `import { Insets } from "@jimka/typescript-ui/primitive";` to also import `UNBOUNDED`, keeping the file's aligned-`from` import style.

2. **Add the `COLUMN_MAX_WIDTH` constant.** Declare it at [frontend/src/shell/StartPage.ts:42-45](frontend/src/shell/StartPage.ts#L42) immediately after `BUTTON_HEIGHT`, with the dedicated comment shown in `## Implementation`. Leave the block comment above `PAGE_PADDING` untouched — it enumerates the four spacing/rhythm values in order, and the cap is a different kind of value carrying its own comment.

3. **Cap the left column.** In `buildLeftColumn` ([frontend/src/shell/StartPage.ts:162](frontend/src/shell/StartPage.ts#L162)), add `maxSize: { width: COLUMN_MAX_WIDTH, height: UNBOUNDED }` to the `Panel({ ... })` options bag. Leave the `VBox` and every `addComponent` call untouched.

4. **Cap the right column.** Make the identical change in `buildRightColumn` ([frontend/src/shell/StartPage.ts:182](frontend/src/shell/StartPage.ts#L182)).

5. **Update `buildColumns`'s doc comment.** The description at [frontend/src/shell/StartPage.ts:134-143](frontend/src/shell/StartPage.ts#L134) currently says "Both columns take equal weight and top-anchor their content so the page reads as a home rather than a stretched split." Extend that sentence to record the cap: the columns split the row evenly *up to* `COLUMN_MAX_WIDTH` each, after which the surplus width is left empty on the right. Do not change `buildColumns`'s body — the `weight: 1` constraints at [frontend/src/shell/StartPage.ts:147-148](frontend/src/shell/StartPage.ts#L147) stay exactly as they are.

6. **Update the module header comment.** The file header at [frontend/src/shell/StartPage.ts:1-18](frontend/src/shell/StartPage.ts#L1) describes the page as "a left column … and a right column …". Add that both columns are width-capped and left-anchored, so the next reader does not mistake the trailing empty space for a layout bug.

7. **Check the weights survived.** `grep -n 'weight: 1' frontend/src/shell/StartPage.ts` — expect exactly the two matches at the `buildColumns` `addComponent` calls. A missing weight means the cap was mistakenly applied by replacing the weight instead of joining it, which breaks shrinking on narrow windows.

8. **Check the cap reached both columns.** `grep -c 'COLUMN_MAX_WIDTH' frontend/src/shell/StartPage.ts` — expect 3 (the declaration plus one use per column).

9. **Typecheck.** `cd frontend && npm run typecheck` — expect no errors.

10. **Verify by eye** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/shell/StartPage.ts` |

---

## Expected Behaviour

Every case below is layout geometry, which the project's Node-environment test runner cannot exercise — all of them are **manual verification**.[^no-unit-test]

The sizing rule: each column takes an equal share of the columns row, clamped to `COLUMN_MAX_WIDTH`. Worked cases (page width is the width the CENTER region gives the start page; per-column figures are approximate, since the row and each column carry the `Panel` default content inset):

| Page width | Even share per column | Column width | Empty space at right |
|---|---|---|---|
| 800 | ~356 | ~356 — under the cap, unchanged from today | none |
| 1280 | ~600 | 420 — capped | ~350 |
| 2560 | ~1240 | 420 — capped | ~1630 |

1. **Wide window.** Both columns stop at 420 px. The two columns remain equal in width, `COLUMN_SPACING` (32 px) apart, and stay flush with the page's left padding; the surplus is empty page background to their right.

2. **Narrow window.** Below the point where the even share drops under 420 px, both columns shrink together exactly as they do today. Nothing is clipped and no horizontal scrollbar appears — the page's `autoScroll` is `"y"` only.

3. **Live resize.** Dragging the window from narrow to wide grows both columns until they reach 420 px and then holds them there; dragging back shrinks them again. No relayout artefacts on the boundary.

4. **The shortcut legend still fits.** At the capped width every legend row renders its keys and its label on one line with no clipping or wrapping — the same legend already renders inside the narrower Keyboard Shortcuts dialog.

5. **Quick-action buttons follow the column.** The left column's action buttons still span the full column width (they carry `preferredSize: { width: 0, … }` and rely on the column's `stretching` `VBox`), so on a wide window they are roughly 420 px wide instead of half-window-wide.

6. **The header and welcome blurb are unchanged.** The `SQLAdmin` heading and the Getting-started blurb keep their current position and width behaviour.

7. **Vertical scrolling still works.** On a short viewport the whole page still scrolls smoothly, and the shortcut legend at the bottom of the right column is reachable.

8. **Rebuild is unaffected.** Opening a table, then closing every tab to return to the start page, re-renders both columns still capped — the cap lives in the column builders, which `rebuild` re-runs.

---

## Verification

- `cd frontend && npm run typecheck` — no errors.
- The two greps in steps 7 and 8.
- Manual, in the running app: sign in, close every dock tab so the start page shows, and check cases 1-8 above. Widen the browser window well past 1280 px for case 1, and drag it narrow for cases 2 and 3. Open the Keyboard Shortcuts dialog (the `?` accelerator) alongside case 4 to compare the legend at both widths.
- `cd frontend && npm test` — the existing suite must stay green; no test covers this change.

---

## Documentation Impact

No exported API changes, so no doc page or barrel is touched. The change is user-visible and belongs under **Changed** in the next release's `CHANGELOG.md` entry — but `CHANGELOG.md` has no `[Unreleased]` section and its entries are written at release time, so do not add one now.

---

## Potential Challenges

- **`maxSize` must not replace `weight`.** Dropping `weight: 1` would make each column size to its content instead of filling up to the cap, and would shrink the quick-action buttons to their label widths. Step 7's grep catches it.
- **A finite `maxSize.height` breaks vertical growth.** Use the `UNBOUNDED` sentinel, not a large literal — the row derives its own maximum height from its children's.
- **`Panel`'s default 4 px content inset** means a column's inner content measures a few pixels less than `COLUMN_MAX_WIDTH`. Treat the cap as the column's outer width and do not retune the constant chasing an exact inner figure.
- **A stale Vite dep cache** can serve an old bundle after several rebuilds; restart the dev server rather than only clearing `.vite` if the page does not change.

---

## Critical Files

- [frontend/src/shell/StartPage.ts](frontend/src/shell/StartPage.ts) — the only file modified. Read the module header (lines 1-18) before editing: it records why `id` and `autoScroll` must both stay inside the single `super({...})` call, and why `rebuild` disposes children before detaching them.
- [frontend/src/dock/ExplainDiagramPanel.ts:55-59,152-155](frontend/src/dock/ExplainDiagramPanel.ts#L55) — the precedent this change mirrors: a column's width policy as a commented module-level pixel constant applied through the component's own options bag.
- [frontend/src/shell/shortcutsDialog.ts](frontend/src/shell/shortcutsDialog.ts) — the in-repo precedent for `maxSize` as the capping tool, and the source of the 420 px figure.
- [frontend/src/shell/shortcutLegend.ts](frontend/src/shell/shortcutLegend.ts) — the right column's content. Read `buildGrid` (lines 67-83) to confirm the legend's keys track is content-sized and its label track weighted, so the grid reflows into a narrower column without clipping.
- [frontend/COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) — section (a) notes that `Panel` carries a default 4 px content inset, which is why the per-column figures above are approximate.

---

## Non-Goals

- **No centring of the page content.** See the decision above; the columns stay left-anchored.
- **No cap on the heading or the welcome blurb.** The blurb already limits its own prose measure, and the heading is a short label whose box width is not visible.
- **No change to `weight`, `COLUMN_SPACING`, `PAGE_PADDING`, or the columns' vertical layout.** The only new behaviour is the horizontal ceiling.
- **No change to `shortcutLegend.ts` or `shortcutsDialog.ts`.** The legend fits the capped column as-is, and the dialog's own width is unaffected.
- **No new unit test.** There is no pure logic to test here.[^no-unit-test]
- **No library change.** The clamp this plan relies on already ships.[^shipped-support]

---

## Notes

[^shipped-support]: The app consumes `@jimka/typescript-ui` from the registry (`frontend/package.json` pins `^0.4.1`, and `frontend/node_modules/@jimka/typescript-ui` is 0.4.1). The clamp lives in `HBox`'s per-child width resolution — a weighted child takes `(weight / totalWeight) * remainingWidth` and is then clamped down to `maxSize.width` and up to `minSize.width` (`/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/layout/HBox.ts:628-651`). The same sequence is present in the shipped 0.4.1 bundle (`dist/lib/VBox-*.js`, which carries both box layouts), so no local library build or symlink override is required to implement or verify this change.

[^weight-and-max]: Three mechanisms could bound a column, and only one of them behaves correctly at every window width.
    `weight: 1` + `maxSize` — the chosen one — resolves the weighted share first and clamps it, so the column fills up to the cap on a wide window and shrinks with the row on a narrow one.
    `preferredSize.width` alone was rejected: `Panel`'s preferred size is derived from its layout manager, so an explicit `preferredSize` would override the derived *height* too, and there is no static height to supply.
    `minSize.width` + `maxSize.width` pinned to the same value was rejected: `HBox` floors a child at its minimum after every clamp, so the column would refuse to shrink below the cap on a narrow window and would overflow a page that only scrolls vertically.
    Dropping `weight` and letting the columns size to their content was also rejected: the column would then shrink-wrap its widest label, so its width would jump around as recent-table and saved-query names change, and the quick-action buttons — which are full-width by design via `preferredSize: { width: 0, … }` under a stretching `VBox` — would collapse to their label widths.

[^column-width]: `shortcutsDialog.ts` sets `DIALOG_WIDTH = 420` and records the reason: "wide enough for the longest `keys  label` row without wrapping". The same `buildShortcutLegend()` output is the right column's main content, so 420 is a measured figure for this page rather than a guess, and it gives both columns a generous but not sparse line length. The constant is redeclared in `StartPage.ts` rather than imported: `DIALOG_WIDTH` is a private module constant of the dialog, and importing it would couple two unrelated surfaces so that retuning either one silently moves the other.

[^left-align]: Centring the capped block is not expressible with this library's box layouts, and would look worse here even if it were.
    `VBox` — the page's own layout manager — cannot centre a child horizontally at all: horizontal is its cross axis, and `BoxLayout.crossAnchorEdge` maps only `WEST`/`EAST` (and the corners carrying them) onto the cross axis, returning `null` for `CENTER`, which leaves the child at the cross-axis origin (`/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/layout/BoxLayout.ts:485-500`).
    `HBox`'s `justify: "center"` is the only centring control in the box layouts, and it is skipped outright whenever any child carries a weight — the slack distribution is guarded by `if (totalWeight === 0)` (`.../layout/HBox.ts:497`), because weight cells are supposed to consume the slack themselves. Since the columns need `weight: 1` to fill up to the cap, `justify` can never apply to them. Removing the weights to unlock `justify` is not a way out: a weightless column sizes to its own content, so it would shrink-wrap its widest label and its width would move as recent-table and saved-query names change.
    That leaves a custom layout manager or a window-resize listener recomputing the page's insets — far more machinery than a spacing tweak warrants.
    Left alignment is also the better reading: the page heading and the welcome blurb sit in the same stack at the page's left inset, so a centred columns row would break the single left edge the page currently reads on, and every other surface in the app (activity bar, navigator sidebar, dock panels) is left-anchored.

[^blurb-already-capped]: `Markdown` writes `max-width: var(--ts-ui-md-max-measure, 70ch)` onto its own element (`/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/display/Markdown.ts:706`), and the base theme sets that variable to `80ch` (`.../core/themes/BaseTheme.ts:31`). The app's `frontend/src/theme.ts` does not override it. So the Getting-started blurb's text column already stops at roughly 80 characters however wide the page gets — the long-line problem this plan fixes is confined to the two columns. `Markdown` also re-measures its flowed height whenever its assigned width changes, so it would have been safe to cap; it is simply unnecessary.

[^unbounded-height]: A box layout derives its own maximum from its children's: `BoxLayout.aggregateMaxSize` sums the children's maxima along the main axis and takes the largest along the cross axis, treating the `UNBOUNDED` sentinel as "no limit" (`/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/layout/BoxLayout.ts:292-352`). Two consequences. First, capping the two columns automatically caps the columns row that holds them, at roughly `2 × COLUMN_MAX_WIDTH + COLUMN_SPACING` plus insets — so the row needs no `maxSize` of its own. Second, a finite `maxSize.height` on a column would propagate up as a height ceiling on the row, which would fight the page's `autoScroll: "y"` scroll host and could strand the bottom of the shortcut legend. `UNBOUNDED` is exported from `@jimka/typescript-ui/primitive`, the entry point `StartPage.ts` already imports `Insets` from.

[^no-unit-test]: The project's Vitest runs in a Node environment with no DOM, which is exactly why `shouldShowWelcome` was split out into `frontend/src/shell/startPageWelcome.ts` — `StartPage.ts`'s top-level imports touch `document` at module-load time and cannot be imported by a test. This change adds no pure logic that could be split out the same way: it is two option-bag entries and a constant, and the behaviour it produces is layout geometry the headless runner could not measure anyway. Verification is by eye, per `## Verification`.
