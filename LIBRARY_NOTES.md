# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

---

## ✅ Fixed in library: no direct way to expand a freshly-loaded tree node

`NavigatorTree.refresh()` (`navigator/NavigatorTree.ts`) needed to
auto-expand a single-schema database's lone schema node on load. `Tree` had
no direct "expand this node" call, so the app matched the schema's first
category node via `revealByPredicate(data => data === undefined)` —
`revealByPredicate` expands a match's *ancestors*, not the match itself, so
this was a surrogate-match trick to reach the schema one level up.

Fixed in the library: `Tree` gained `expandNode(node)`, which runs the same
commit path a caret click does (including the lazy-load branch) directly on
the node you already have. Adopted here (plan
`align-with-library-post-0.4.1`): `refresh()` now calls
`this.expandNode(nodes[0])`, since `loadSchemas()` already resolves the
schema's own `TreeNode`. One behaviour changed at an edge case: an *empty*
single schema now expands to an empty parent instead of staying collapsed,
per `_loadAndExpand`'s own documented behaviour for a zero-length resolved
children array — a minor improvement, not a regression.

---

## 🐞🔎 Closing any panel with a live subtree listener throws on the next matching event (0.4.1, symlinked)

Found during `adopt-dock-owned-teardown`'s manual verification (**M2**/**M3**), not by design. `QueryPanel.ts` wires
`Event.addSubtreeListener(editor, "keydown", …)` for its Run/Save/Explain/Clear/history-recall shortcuts.
`Component.destructor()` does not purge this module-level map entry when the editor is disposed — a known gap
stated plainly in the library plan `dock-disposes-tab-content.md`'s Non-Goals, and recorded (before this entry
existed) as a "bounded, silent" leak in `adopt-dock-owned-teardown.md`'s own footnote.

**It is not merely silent.** Confirmed here: once at least one query tab has been closed, the very next `keydown`
event anywhere in the document — not necessarily inside a query editor — throws `Uncaught Error: DOM handle <n> is
not registered (released or never minted)`, from `DOM.ts`'s `resolve`/`getId`, called from `Event.ts`'s base
listener as it walks the event target's ancestor chain against the stale subtree-listener entry and hits an
already-released `Handle`. Reproduced reliably with a single query-tab open/close/keydown cycle — no accumulation
needed — using both real UI interaction (click-driven) and scripted events, ruling out a test-harness artifact.

**The blast radius is wider than one call site.** Re-confirmed during this run's phase-2 verification pass on a
plain table tab, no query editor involved: closing `wide.cols_20`'s Data tab throws the identical `DOM handle <n>
is not registered` error on the very first close, with a single real UI click and nothing scripted. `Table`'s own
`Body.ts` (`Event.addSubtreeListener(this, "click", this.onSubtreeClick)`) and `Header.ts`
(`click`/`contextmenu`) carry the same pattern the library uses internally, and the click that closes the tab is
itself the event whose subtree walk trips over the handle the same click's `Tab.closeEntry` just released. So this
is not specific to `keydown`, to `QueryPanel`, or to any app code — it is the library's own `Table` component
tripping its own defect, on the single most common tab type in the app. Confirmed the app stays fully usable
afterward in both cases (query tab and table tab): reopening and interacting with other panels works normally: the
failure is a thrown console error on that one event, not a broken app.

**Confirmed unrelated to `adopt-dock-owned-teardown`'s own change**, in both the original and the wider case. The
`Event.addSubtreeListener` call sites in `QueryPanel.ts` and in the library's own `Table` component are untouched
by that plan's diff, and `dispose()` is invoked identically either way — via the old app-side
`PanelDisposers`-driven explicit call, or the new library-driven recursive one from `Tab.closeEntry`. Not fixed
here: purging this map on dispose is a library-level fix, and adding an app-side `Event.removeSubtreeListener`
call would be a new workaround in place of the one that plan retires (see its own Non-Goals) — and would not even
cover the `Table`-internal case, which no app code can reach. **Deferred to 0.4.2**, not `0.4.1`: it does not stop
the app from running — reopening and interacting with other panels works fine right after the thrown error — so it
does not block this app's adoption. SQLAdmin's `^0.4.1` dependency range will accept a `0.4.2` once one exists, but
picking it up still needs a normal `npm install`/lockfile refresh in this app — the range alone does not pull a new
version in on its own.

**A related library fix already shipped in `0.4.1` — and does not close this entry.** `typescript-ui`'s
`component-purges-event-listeners` plan added `Event.purgeComponent(componentId)`, called from the top of
`Component.destructor()`, which purges a disposed component's own `listenerMap`/`subtreeListenerMap`/
`viewportListenerMap` entries so they can't fire on a *later*, unrelated event. It's an ancestor of the `v0.4.1`
tag and confirmed present in the installed package (`purgeComponent` appears in `dist/lib`'s `Component-*.js`).
Re-tested live against the real installed `0.4.1` (not the symlink) after this shipped: closing `wide.cols_20`
still throws the identical `DOM handle <n> is not registered` error, on the first close, every time. The two
mechanisms are different: `purgeComponent` prevents a *stale* registration from a *past* disposal firing on a
*future* event; this defect is **same-event reentrancy** — the click that closes the tab is itself the event whose
own subtree-dispatch walk trips over the handle that same click's synchronous teardown released moments earlier,
before that same event finishes bubbling. Purging eagerly on dispose doesn't help here because the walk that
crashes belongs to the very event that triggered the dispose. Still open; no plan addresses this angle yet.

**Fixed — confirmed live, 2026-08-09.** `typescript-ui`'s `subtree-listener-reentrant-dispose` plan (commits
`fa11d755`…`dc4edf85`, an ancestor of the current `master` but not yet tagged — sits past `v0.4.1` in `next.md`)
makes the subtree-listener ancestor walk tolerant of a handle released mid-dispatch by the same event that is
still bubbling: "A component disposed synchronously by a handler running during an event's own dispatch — most
commonly, a tab's close button disposing the tab's content — no longer throws `DOM handle <n> is not registered`
when that same event's subtree-listener walk reaches the released handle. The walk now ends cleanly at that point
instead." That is a direct match for both repros logged above.

Re-ran both against the symlinked build (`packages/lib` at `0914daee`, dist rebuilt same day): (1) opened a query
tab, closed it, pressed a key — no console error. (2) opened `public.customers`'s Data tab, closed it, clicked
elsewhere in the document — no console error. Both previously threw on the very first cycle, no accumulation
needed, so a clean single cycle each is sufficient evidence. `list_console_messages` showed only the pre-login
`401` and the two Vite HMR debug lines throughout the whole session — no new errors from either repro or from
general navigation (tree expand/collapse, context menu, dialogs).

**Not yet released.** `master` is 178 commits past the `v0.4.1` tag with the version field still reading `0.4.1`
— this fix ships whenever that batch is cut (the `next.md` changelog page, not yet numbered). SQLAdmin's `^0.4.1`
range will accept it once tagged; until then this is verified only against the symlinked build, not the installed
package.

Found while chasing what looked like a teardown regression during `adopt-dock-owned-teardown`'s **M2** (a
never-run query tab, closed four times): the aggregate `[...document.styleSheets].reduce((n, s) => n +
s.cssRules.length, 0)` probe grew by a steady ~20 rules per cycle instead of returning to baseline. A scoped
before/after id diff (every element id under the closed tab's own root, checked against the stylesheet after
close) showed **zero** of them survived — the tab's whole `QueryPanelContent` subtree, including its `CodeEditor`,
disposed cleanly. The growth turned out to be `.ͼN`-selector rules — CodeMirror's own `StyleModule` mount, one
freshly-numbered module per `new CodeEditor(…)` call, accumulating on the document's stylesheet for the page's
lifetime regardless of whether the owning `CodeEditor` is ever disposed. `EditorView.destroy()` does not and
cannot remove them: `StyleModule` is designed to be shared/deduplicated across every live editor on the page, so a
module's rules outliving one specific editor instance is CodeMirror's own contract, not a bug reachable from
`Component.dispose()`. Confirmed the same growth occurs regardless of `adopt-dock-owned-teardown`'s changes,
since `editor.dispose()` is called identically before and after that plan.

**Practical consequence:** the aggregate stylesheet-rule-count probe this file uses throughout is *not* a reliable
signal for any scenario that constructs a `CodeEditor`/`MarkdownEditor` — repeated `wide.cols_20` table-tab cycles
(no `CodeEditor` involved) return to an exact flat baseline, but repeated query-tab cycles will not, even with
perfectly correct disposal. A scoped id-diff against the closed tab's own subtree is the reliable substitute; the
two entries above and below this one both used it instead of the aggregate. Not something the app or this plan
can fix — CodeMirror's module cache is by design page-global — but worth a "Possible library improvement" if the
library ever wants to interned/dedupe modules by content instead of by construction identity.

---

## 🐞🔎 A closed diagram/tree tab strands a handful of `LabelListItemRenderer`/`Text` rules (0.4.1, symlinked)

Also found during `adopt-dock-owned-teardown`'s manual verification (**M3**/**M4**), using the same scoped
before/after id diff as the entry above (the aggregate rule count is unreliable here too, for the same CodeMirror
reason where a `CodeEditor` is anywhere on the page): capture every element id under the tab's own root before
close, close the tab, then check which of those ids still back a stylesheet rule afterward. Reproduced identically
in two unrelated contexts — `QueryPanel`'s
Explain-diagram tab (its "Plan tree" `Tree`) and a whole-schema `SchemaDiagramPanel`'s table-card nodes — each
leaving exactly six elements undisposed: three `LabelListItemRenderer` instances plus their three `Text` label
children. Everything else in both subtrees disposed correctly, including the diagram's own `DiagramView` and (by
the destructor chain that terminates it) its ELK Web Worker — this is not a worker-termination regression, just a
small, consistent residual confined to one renderer class.

**Confirmed unrelated to `adopt-dock-owned-teardown`.** Neither context is app code the deleted `PanelDisposers`
registry ever covered — `LabelListItemRenderer`/`LabelTreeNodeRenderer` are library-internal renderers for `Tree`
and/or `DiagramView` node content, not something SQLAdmin constructs or references directly. The likely shape,
by analogy with the `Menu`/`Tooltip` unregistered-chrome defect this file already documents further down: some
piece of a tree node's or diagram card's rich content renders without being registered as a normal child, so the
ordinary destroy recursion `Tab.closeEntry` now drives never reaches it. Location not narrowed past the renderer
class name; needs its own investigation, in the same spirit as the still-open `TableWorkPanel` toolbar residual
below.

---

## ✂️🔎 A paged remote store's `autoSizeColumns` widths derive from page one only (0.4.0)

`Table.maybeResampleColumnWidths` re-derives column widths once, on the first
`'load'`/`'add'`/`'remove'`/`'datachange'` that finds records, and then sets a
guard that only `Table.setStore` clears (see `Table.ts`'s `_hasResampled`
handling). Against a `Store` over a paginated remote proxy — the shape both the
main data grid (`dock/tableWriteRules.ts`) and the role-grants grid
(`dock/RoleGrantsPanel.ts`) use — that first `'load'` is page one, so the
derivation samples at most `SAMPLE_ROWS` (50) of the `PAGE_SIZE` (100) rows on
that page and never resamples for any page, sort or filter afterwards. A
column whose widest value lives on a later page renders at whatever width page
one's sample produced and clips or truncates until the user drags it wider.

This is a deliberate trade, not an oversight: re-deriving on every page/sort/
filter would make column widths jump around under the user's cursor while
paging, which is worse than a width that is occasionally too narrow. It is
also not something the app can ask for — nothing on `Table`'s public surface
exposes a "resample now" call short of `setStore`, which would also discard
the store's loaded rows.

**Possible library improvement:** expose a narrow, explicit "resample column
widths against the currently loaded page" method (distinct from `setStore`,
which replaces the store entirely) so a consumer whose store pages through
data neither the app author nor its widths can equally clarify. Until then,
sqladmin does nothing about it — see `content-derived-column-sizing.md`'s
Non-Goals, and the plan's Potential Challenges for how a user works around it
today (drag the column).

---

## 🐞🔎 Horizontal scrolling a wide grid layout-thrashes on `getBorderWidths` (0.4.0)

Scrolling `wide.cols_60` (60 columns, 6014px of content in a 1206px viewport,
54 rendered rows) horizontally from end to end at 1500×800 took **50.6 s for
150 frames — 3.0 fps** — with a **5030 ms** longest main-thread block and 20
blocks over 100 ms. A shorter 20-frame gesture took 30.1 s (1507 ms/frame).

Chrome's ForcedReflow insight spans essentially the whole trace and attributes
it to the library, not the app:

- `getBorderWidths` @ `@jimka/typescript-ui/dist/lib/DOM-*.js` — 405 ms
- `getScrollLeft` @ same — 146 ms
- the measurement harness itself — 3 ms

Two controls locate the cost. At 8px/frame, both an in-place jitter and a steady
advance that *does* cross column boundaries run at ~62 fps with no gap over
50 ms — so crossing a boundary is not the trigger. And the cost does not scale
with column count: `cols_20` cost 1286 ms/frame against `cols_60`'s
1507–2102 ms/frame, despite a third of the columns. What it scales with is the
number of **cells entering the column window per frame** (rendered rows ×
columns crossed).

**The mechanism is not what the profiler's headline suggests, and the obvious
reading of it is wrong.** `getBorderWidths` is only ~1.5% of a slow frame. The
cost is what the read *does to everything after it*: `Component.getBorderSize()`
issues a per-component `getComputedStyle` read mid-frame, and that read makes
every **subsequent shared-stylesheet rule write in the same task about 85×
dearer** — 0.014 ms to ~1.2 ms each. Those poisoned writes are ~80% of a slow
frame. Established by measurement in the library's own demo, not by reading the
trace summary.

Two hypotheses were disproved on the way and are recorded here so they are not
re-proposed: that `getBorderWidths` is itself expensive (it is not), and that
read-all-then-write-all would fix it (it cannot — a render pass writes rules
before it can read).

The fix, planned in the library as `table-scroll-forced-reflow`, shares one
browser measurement per border spec in a new internal `core/BorderWidths.ts`. It
is A/B proven in the library's own 45-column demo table, which reproduces the
stall without this app at all: 45 scroll frames went from 8.0–9.9 s with 9–10
frames over 100 ms, to 1.08–1.18 s with none.

**This is why the two entries compound, and the coupling is now mechanism rather
than conjecture:** the poisoned rule-write cost scales with the size of the
shared stylesheet, and the Dock-disposal leak above grows that sheet without
bound. Every table tab closed makes wide-grid scrolling permanently slower for
the rest of the session.

The app-side numbers at the top of this entry came from a Vite **dev** build,
which inflates the JS around the reflow but not the browser work itself. They
are kept as the field report that started the hunt; the library demo's A/B
figures above are the authoritative ones. To re-measure through this app against
a production bundle, note `vite preview` needs its own `preview.proxy` for
`/api`, since `server.proxy` does not apply to it.

**Re-measured against the local `table-scroll-forced-reflow` fix (symlinked, not
yet released) — the targeted mechanism is confirmed gone, but a second,
different bottleneck dominates in this app and the field symptom is only
partly resolved.** Instrumenting `getComputedStyle` and every
`CSSStyleDeclaration.cssText` write during a scroll on `wide.cols_60` found
**zero** `getComputedStyle` calls — the border-width cache is working exactly as
designed, and `getBorderWidths` no longer appears anywhere in Chrome's
forced-reflow attribution. The original 150-frame heartbeat measurement improved
from 50.6 s to **26.5 s** (3.0 fps → 5.7 fps) — real, but nowhere near the
library demo's own 8–10 s → 1.1–1.2 s.

The remaining cost is not forced reflow: Chrome's ForcedReflow insight now
attributes only **259 ms of ~26 s** to a different call (`getScrollLeft`), so
over 99% of the time is something the fix's own mechanism cannot explain. A
control at 120 px/frame is bimodal and steady-state (not a startup-backlog
artefact — checked per-frame over 40 frames, front half 829 ms avg vs back half
967 ms avg, evenly distributed throughout): about half the frames cost
20–200 ms and the other half cost 1000–2550 ms, both while writing ~176
`cssText` rules/frame against an ~2700-rule sheet with zero style reads. A
sharper control — the same 120 px delta, oscillating (+120/−120 alternating)
instead of advancing — costs **343 ms/frame** against a **steady** advance's
**19.7 ms/frame** at the same delta size, an ~17× gap that the original
finding's controls never surfaced (they only varied delta size, not direction).
That points at something direction-sensitive in cell recycling — plausibly the
"skip a cell whose geometry is unchanged" optimisation from 0.4.0's own
changelog failing to help (or actively penalising) a window that keeps
reversing, rather than at anything this fix touches.

Two live hypotheses, neither confirmed: plain style-recalculation cost scaling
with the ~2700-rule sheet size regardless of any read (a *different* cost model
than the poisoned-write mechanism this fix removed, since removing all reads
did not remove the bimodal slowness); or a genuinely separate forced-layout
trigger this fix's `BorderWidths` cache does not cover, surfaced by `cols_60`'s
richer per-cell wiring (editor pool, required-column outline, per-type
renderers) that the library's minimal demo table does not exercise. Needs its
own investigation before 0.4.1 ships — SQLAdmin is again the harder test the
library's own demo did not surface.

**Re-measured against the local `table-scroll-recycling-cost` fix
(`setShadow`/`clearShadow` idempotence guard, symlinked, not yet released) —
real, substantial, still incomplete, and the direction-sensitivity story from
the prior entry does not hold up under a clean re-test.** On a fresh page
(`wide.cols_60` opened once, no accumulated leak-cycle state — checked, since
sheet size confounds this: freshly-opened `cols_60` alone reaches ~2800 rules,
dwarfing the ~350 a preceding leak-cycle test would have added, so the two
investigations' measurements don't contaminate each other here), the 150-frame
heartbeat improved **26.5 s → 13.7–13.8 s** (5.7 fps → ~11 fps) — real, on top
of the scroll fix's own already-confirmed elimination of every `getComputedStyle`
call, but still roughly 10× the library demo's clean 1.1–1.2 s.

The steady-vs-oscillating control **no longer shows anything close to 17×** —
174.1 ms/frame steady vs 190.5 ms/frame oscillating, a ~1.1× ratio, matching
what the scroll-fix plan's own instrumentation found (~1.7×) far better than
the pre-fix field figure. But a third run of the **same steady pattern
immediately after** the first two dropped to **18 ms/frame** — a ~10×
difference between two identical gestures, one first-visit and one revisiting
territory the prior gesture just covered. That is not explained by direction
at all, and was not tested for in either prior investigation (both varied
delta size or direction, never first-visit vs revisit of the same column
range). The likely mechanism is some form of first-touch cost per column (or
per column-type) that a revisit skips — consistent with, but not proven to be,
the same stylesheet-size-scaling cost already implicated in the leak entry
above, since a first-visit column may need rules a revisit already has
materialised. Not resolved here; the position/history confound makes this hard
to isolate through ad-hoc browser scripting and likely needs the library's own
controlled test harness (as both prior investigations used) rather than more
live-session measurement.

**The first-touch hypothesis above was investigated and refuted — this entry is still open, but that specific
theory is closed.** `typescript-ui`'s `table-scroll-first-visit-cost` plan ran a controlled first-visit/revisit
protocol against the library's own demo tables, widened to `wide.cols_60`'s exact shape (60 columns, 6 types) —
also an ancestor of `v0.4.1` and already in the installed package. Four consecutive identical sweeps over the same
column range cost the same every time (62.5 / 63.4 / 62.7 / 60.6 ms/frame, identical `insertRule` counts); no
first-visit penalty exists anywhere in `Row.setColumnWindow` / `Header.reconcileColumnCells` — both dispose a
recycled cell's rule immediately, so there is no per-session cache for a revisit to warm. Their read on the ~10×
field gap this entry measured: probably a **measurement artifact**, not a real cost — a sweep that runs the column
window past the table's last column stops changing what it renders, so a sweep that happens to end there reads
artificially cheap, which fits this entry's own description of the two compared sweeps as "overlapping-but-shifted,"
not a clean identical-range comparison. Documentation-only change (`docs/concepts/performance.md`), no code fix,
and no re-test has been run against a corrected boundary-safe protocol in SQLAdmin itself. The underlying
~10×-vs-the-library-demo gap this entry opened with is therefore still unexplained — one candidate cause is ruled
out, not the entry itself.

**The app-level headline numbers above (50.6s → 26.5s → 13.7s) were never re-run against a realistic input
protocol — only the library's own internal controls were. Doing so against live SQLAdmin changes the story
again: a single scroll gesture is genuinely fast, but the entry is not resolved — it reproduces worse than ever
documented, through a different, now-identified mechanism.** Every number in this entry's history was gathered by
dispatching a synthetic `WheelEvent` on every animation frame — the same harness `typescript-ui`'s
`table-scroll-recycling-cost` plan already proved confounded (see its `smooth-scroller-confound` footnote):
`SmoothScroller`'s easing loop re-renders on every frame it is "mid-flight," independent of how many events were
dispatched, so a harness that redispatches every frame never lets it settle and measures a sustained worst case no
real gesture produces. That correction was only ever applied to the library's own internal control test, never to
this entry's SQLAdmin-side headline figures.

Re-measured against live SQLAdmin (`wide.cols_60`, symlinked build, both prior fixes present) with a realistic
protocol instead: a burst of 12 `WheelEvent`s over ~300 ms (typical trackpad-fling cadence), then idle. **A single
fresh sweep is fast and smooth** — 1.8 s wall-clock, worst inter-frame gap 21 ms, matching this app's own informal
manual-testing impression exactly. A human-paced sequence of three such flicks with ~900 ms dwell between them
(look, scroll, look, scroll) stays smooth throughout — 3.1 s, zero gaps over 50 ms — even though it covers the same
net distance as the failing cases below.

**But rapid, repeated sweeps — especially reversing direction with little or no dwell — reproducibly stall for
seconds, confirmed across many trials, not a one-off:** 12.1 s (worst gap 8.2 s) → 15.9 s (6.1 s) → 36.5 s (9.9 s)
→ 44.7 s (14.5 s) across one escalating same-session sequence; a later instrumented sequence hit 52.5 s, 75.6 s,
and 41.7 s in three consecutive rounds. No console errors at any point. This is not the already-fixed leak: a
before/after diff of every `#uuid`-scoped rule's live-vs-orphaned status across many cycles found **zero orphaned
rules** every time — added rules always belonged to currently-rendered elements, matching `Row.setColumnWindow`'s
documented recycle-or-dispose contract. It is also not the already-fixed forced-reflow mechanism: `getComputedStyle`
stayed at **zero calls** throughout every trial, live-instrumented (see below).

**Isolating the harness from the table shows `SmoothScroller` itself costs a real, bounded ~15×, with cols_60
responsible for a further, much larger and non-deterministic multiplier on top.** Same reversing-sweep pattern,
three ways: direct `VirtualScroller.setScrollX` (bypassing `SmoothScroller` and `WheelEvent` entirely) against the
library's own 45-column demo — 298 ms for six full-width alternating jumps, worst gap 55 ms, ~77 rule writes per
jump, zero `getComputedStyle` calls. The same jumps driven through real `WheelEvent`s (so through `SmoothScroller`)
against the same 45-column demo — 4.3 s, worst gap 107 ms: real, bounded overhead from the easing loop, still
smooth. The identical `WheelEvent`-driven protocol against live SQLAdmin's `wide.cols_60` — 12–75 s, worst gaps up
to 14.5 s: another large multiplier on top, and this time not bounded — it got worse, not better, across repeated
trials in the same session.

**Three candidate explanations for that remaining multiplier were tested by direct reproduction and ruled out.**
(1) Cell-type richness: a demo table rebuilt to `wide.cols_60`'s exact shape (60 columns, 6 types — string, number,
boolean, date, time, datetime — via `Model`/`MemoryStore`/`TablePanel` imported live from the dev server, mirroring
`table-scroll-first-visit-cost`'s own widened-demo technique) reproduced none of it: 4.2 s, worst gap 110 ms, under
the identical reversing-burst protocol. (2) The one non-declarative thing SQLAdmin's own code does —
`tableWriteRules.ts`'s `required: isRequiredColumn(c)`, which activates the library's required-column outline,
documented as re-evaluated on every visible-window render pass — was added to that same widened demo (one column
marked `required`, matching that only 1 of `wide.cols_60`'s 60 columns is actually `NOT NULL`). Still no
reproduction: 6.0 s, worst gap 268 ms. (3) Ambient shared-stylesheet size: the widened demo's sheet was inflated
with ~4,200 synthetic dummy rules to match live SQLAdmin's own ~8,200-rule total. Still no reproduction: 5.3 s,
worst gap 262 ms — ruling out stylesheet *rule count* in isolation (see below for why this doesn't rule out DOM
*element* count, which this test never controlled for).

**Live instrumentation of the real app (not just the isolated demo) shows rule-write volume does not explain the
wall-clock cost either — something else dominates.** `DOM.sink.setRuleStyles` was patched on the actual running
module instance (found via `performance.getEntriesByType('resource')`, since a naive re-import of the same source
path creates a second, unpatched module graph and silently patches nothing — the live instance is served at
`/@fs/.../dist/lib/core.es.js?t=<timestamp>`, not `/node_modules/...`). Across five consecutive instrumented
rounds, rule-write count and wall-clock time did not correlate: one round wrote 1,412 rules in 3.7 s; two other
rounds wrote only **26 rules each** yet took **5.6 s and 6.2 s**, with worst single-frame gaps of 5.0 s and 5.5 s.
`getComputedStyle` was zero in every round.

**A performance trace taken during a live reproduction (confirmed the stall still reproduces without tracing
first, so this was for attribution only) points at ordinary style recalculation scaling with page size, not a
forced read.** Chrome's `ForcedReflow` insight attributed only 969 ms total (across a ~170 s trace) to
`getScrollLeft` — real, small, and already the known non-dominant contributor from this entry's own earlier
measurements. Its `DOMSize` insight is the more consequential one: repeated *ordinary* (non-forced) style
recalculation passes costing 60–80 ms each and touching **5,470–6,038 of the page's 9,318 total DOM elements per
pass** — essentially the whole page restyles on every recalculation, not just the handful of cells that actually
changed. This is, for the first time with direct trace evidence, this entry's own long-standing second hypothesis
("plain style-recalculation cost scaling with... sheet size regardless of any read") — except the scaling variable
looks like total **DOM element count**, not stylesheet rule count: candidate (3) above inflated the stylesheet to
match live SQLAdmin's rule count and still stayed fast, but never touched the demo's DOM element count, whereas
live SQLAdmin's persistent chrome (sidebar database tree, menus, dock, the CodeMirror query editor) plausibly
carries a much larger total element count than the isolated demo ever reaches.

**Tested and also ruled out: raw DOM element count alone is not sufficient either.** The isolated demo (the
required-column variant) was bulked from 5,414 to 9,615 total elements — matching live SQLAdmin's 9,318 — by
appending 4,200 plain `div.ts-ui-component` filler nodes off-screen, no stylesheet changes beyond what those
elements' existing shared classes already implied. Re-running the identical reversing-burst protocol (four
consecutive legs this time, to match the length of the worst real-app sequences): 12.4 s total, worst single-frame
gap 421 ms, **zero gaps over 500 ms** — a real but mild ~20–30%-per-leg slowdown from the pre-bulk baseline, nowhere
near live SQLAdmin's 5–75 s stalls with multi-second individual gaps. Five candidate explanations have now been
tested by direct reproduction and ruled out: cell-type richness, the required-column outline, stylesheet rule
count, and raw DOM element count, on top of the already-excluded forced-reflow and stylesheet-leak mechanisms.

**Two more candidates were tested the same way and also ruled out.** A live `CodeMirror` instance (the library's
own `CodeEditor` demo, which materializes the `ͼ1`/`ͼ2`/`cm-*` rules and `cm-blink` keyframe animations this file's
diff shows near its top) was mounted onto the same page alongside the bulked, required-column, 60-column/6-type
repro — the identical four-leg reversing-burst protocol still finished in 13.1 s, worst gap 353 ms, zero over
500 ms. DOM nesting depth was tested by re-parenting the repro `Window`'s root element under a chain of 12
`display:contents` wrapper `div`s (14 total levels from `body`, comparable to live SQLAdmin's `Dock` →
`TabPanel` → `QueryPanelContent` → `Container` × 2 → `Table` chain) — 12.9 s, worst gap 358 ms, zero over 500 ms.
Neither moved the needle. **Seven candidate explanations have now been tested by direct reproduction and ruled
out** — cell-type richness, the required-column outline, stylesheet rule count, DOM element count, live
`CodeMirror` presence, and DOM nesting depth, on top of the already-excluded forced-reflow and stylesheet-leak
mechanisms — and an isolated demo combining *all six* structural factors at once still stays under ~13 s with no
individual gap over 500 ms, against live SQLAdmin's 5–75 s with gaps up to 14.5 s under the identical protocol.

**Status: severity is confirmed input-pattern-dependent, the entry's remaining mechanism is confirmed (via Chrome's
own trace insights) to be ordinary style-recalculation cost rather than a forced read or a leak, but every
structural variable cheap enough to synthesize in an isolated demo has now been tried and ruled out.** Typical,
human-paced scrolling — including repeatedly sweeping the same wide table — is fast and smooth; nothing here
changes that. Rapid, sustained, direction-reversing scrolling against live SQLAdmin reproducibly stalls for
seconds, sometimes over a minute; no combination of matched cell types, required-column config, stylesheet size,
DOM element count, live `CodeMirror` presence, or nesting depth reproduces it in isolation. What remains
untested — because it cannot be cheaply synthesized, only actually lived through — is genuine multi-minute
session accumulation: internal `Table`/`Row`/`Header` bookkeeping state that a long-running real session builds up
and a freshly-constructed demo, no matter how structurally bulked, never does. Needs its own library-side plan,
matching this entry's established pattern, to instrument that internal state directly (not just its DOM/stylesheet
symptoms) across a long-running session before attempting a fix.

---

## 🐞🩹🔎 A numeric `fontSize` passed to `Text`'s constructor is silently ignored

`new Text("v0.1.0", { fontSize: 10 })` renders at the theme default (14px), not
10px. Other `Text` options passed the same way (e.g. `fontWeight`) apply
correctly, so the option bag itself works — only `fontSize` is dropped.

Cause: `Text` binds its font size to the `--ts-ui-font-size` theme var through
two **field initializers** (`_fontSizeCSSVar`/`_fontSizeCSSRule`, `Text.ts`).
A constructor `fontSize` is applied during `super()` (the option cascade calls
`setFontSize(10)`, which nulls those fields and writes `10px`), but field
initializers run *after* `super()` returns, so they overwrite the just-nulled
fields back to the `var(--ts-ui-font-size, 14px)` binding — and the render path
prefers `_fontSizeCSSRule` when non-null, reverting to 14px. The setter path has
no such problem: `text.setFontSize(10)` *after* construction runs once the
initializers are already done, so nothing restores the var afterward.

Worked around in `AppHeader` by calling `version.setFontSize(VERSION_FONT_SIZE)`
after construction instead of passing `fontSize` in the constructor options.
The library fix is to have the field initializers not clobber an explicitly-set
numeric size — e.g. seed the var binding only when no `fontSize` option was
supplied, or move the restore ahead of the option cascade.

---

## ✂️🩹🔎 Consumers must set `keepNames` in their own minifier

The library derives every component's CSS class (via `init()` ->
`classList.add(this.constructor.name)`) and its Dock layout-serialization keys
from `this.constructor.name`. A production minifier mangles class identifiers by
default, so `constructor.name` returns a short string (e.g. `"Zt"`) — every
component ends up with the same wrong class, all CSS scoping breaks, and the app
renders unstyled/non-functional. The library's *own* Vite build already sets
`keepNames`, and its `dist/lib` bundle preserves class names — but that is **not
enough**: when a consuming app bundles and **re-minifies** `dist/lib`, its own
minifier re-mangles the names unless it too keeps them.

**Symptom in sqladmin's prod build:** `npm run build` produced a bundle where
`document.querySelectorAll('.Component').length === 0` and the DOM carried a
single mangled class (`Zt`). Dev (`npm run dev`, unminified) was fine, which is
why it hid until a production build.

**Worked around (app):** sqladmin is on Vite 6 (esbuild minifier), so
`frontend/vite.config.ts` now sets `esbuild: { keepNames: true }` (esbuild
injects `__name` helpers so `.name` survives mangling). Verified in a browser
against the prod build: `.Component` = 20, `.Button` = 3, `.Dock`/`.MenuBar`/
`.TabBar` present again. (A Vite 8 / rolldown-oxc consumer instead needs
`build.rollupOptions.output.minify.{compress,mangle}.keepNames`, as the library's
own config uses.)

**Verify:** `npm run build` in the consumer, then `npm run preview` and check
`document.querySelectorAll('.Component').length > 0` in the browser — the class
names must be the real ones, not a single mangled token.

**Possible library improvement:** stop deriving CSS classes / serialization keys
from `constructor.name` (use an explicit static class-name registry), so a
consumer's minifier settings can't break styling. Until then, every consumer must
be told to keep names.
