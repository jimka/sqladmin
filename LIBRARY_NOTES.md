# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

---

## 🐞🔎 Closing a table tab strands ~2288 per-instance stylesheet rules (0.4.0)

Opening and closing one 20-column table tab (`wide.cols_20`, 42 rendered rows)
leaves **2288 rules** behind on the shared sheet, every cycle, for ever. Four
open/close cycles measured in the browser against 0.4.0:

| after | rules | DOM nodes | components |
|---|---|---|---|
| fresh page load | 436 | 491 | 334 |
| baseline (tabs closed) | 6771 | 618 | 426 |
| cycle 1 | 9059 | 618 | 426 |
| cycle 2 | 11347 | 618 | 426 |
| cycle 3 | 13635 | 618 | 426 |
| cycle 4 | 15923 | 618 | 426 |

Growth is perfectly linear at +2288/cycle. Characterised at the end of that run:
of 15,923 rules, 15,862 are `#uuid`-scoped per-instance rules and **15,385 of
those are orphaned** — their element id is no longer in the document. 96.6% of
the sheet is dead.

The DOM-node and component columns returning to baseline reads like proof that
teardown is fine and only the rules survive. **It is not, and that reading was
wrong.** Those columns count `.ts-ui-component` *elements*, which disappear when
an ancestor is removed whether or not any destructor ran — the number never
measured JS-side teardown at all. The components are in fact **retained**: the
id-keyed maps in the library's `core/Event.ts` hold a `CompFunc` of
`{ component, listeners }`, a strong `Component` reference from a module-level
Map, which is a GC root. So a component that ever registered a listener stays
permanently reachable, and this is a memory leak as well as a stylesheet one.

That has a second consequence worth spelling out, because it explains an
otherwise puzzling observation: the framework's `_componentFinalizer` — the GC
backstop that would have released handles and disposed selectors for a component
nobody explicitly destroyed — **can never fire while a listener registration
holds the component alive**. The leak disarms its own safety net. Fixing the
listener maps (library plan `component-purges-event-listeners`) is what restores
that backstop.

**The 0.4.0 row-pool fix is present and correct — it is simply never reached.**
`VirtualRowView.destructor()` does dispose every pooled row and the scroller's
overlay scrollbars, exactly as the changelog describes, and
`Component.destructor()` recurses into `_components`. The chain breaks one level
up: **`Dock` never disposes the content component of a tab it closes.** Closing
a tab removes the element and drops the tab, but nothing calls `dispose()` on
what the consumer handed it, so no destructor in that subtree ever runs.

SQLAdmin only escapes this where it opts in. `SqlAdminController.openAsyncPanel`
registers a panel with its own `PanelDisposers` registry **only** when the
caller passes `disposeOnClose: true` — set at the nine diagram sites, which own
ELK workers that must be terminated, and *not* on `openTable` (line 448) or the
structure panel (line 508). Those two are the app's highest-traffic tabs, and
they are the ones measured above.

So the app has a workaround available today (pass the flag at the remaining
sites), but the durable fix is library-side: a consumer that closes a tab
should not silently accumulate an unbounded stylesheet, and the evidence that
this is a trap rather than a contract is that this app built a whole disposal
registry to work around it and still missed its two busiest panels. Owning
teardown in `Dock` would let most of `PanelDisposers` go away — its remaining
job would be the genuinely app-specific part (ELK worker termination, and the
in-flight-build token that disposes a panel whose tab closed mid-fetch).

Note the changelog's quantified claim — a 45-column table retaining 104 rules
per cycle where it used to retain 5512 — is measured on a directly-disposed
view, not through a Dock tab close, which is why it does not describe what a
consumer sees.

Why it matters beyond memory: style-recalc cost grows with the size of the
sheet, so every later frame in a session gets dearer. This is the mechanism
behind the app-level symptom — *"performance drops after having opened and
closed a number of tables"* — and it compounds the forced-reflow entry below,
since each forced reflow re-runs style resolution against the bloated sheet.

Repro: open a table tab, close it, and read
`[...document.styleSheets].reduce((n, s) => n + s.cssRules.length, 0)` before
and after. No app change can address this; it needs a library fix.

**Re-measured against the local `dock-disposes-tab-content` fix (symlinked, not
yet released) — real, large, incomplete.** Four `wide.cols_20` open/close cycles:
retained rules per cycle dropped from **2288 to 78** — a ~29× reduction — and the
live-component count now returns to baseline correctly (`+4`, constant across
cycles rather than growing, and confined to what looks like one tab button's own
subtree — not investigated further). But growth is still perfectly linear at
+78/cycle, and it is still genuinely orphaned: of 854 `#uuid`-scoped rules
present after four cycles, 380 have no matching element in the document. The fix
is correct for what it targets (confirmed by code review: `constraintsFor` fixed
at the source, the empty-state trap handled, no workaround anywhere) — this is a
**second, smaller instance of the same defect class**, something else in a
table tab's subtree still raw-appends chrome without registering it as a child,
so `Tab.closeEntry`'s new disposal cannot reach it. Location not yet identified;
a scoped snapshot (component id → className immediately before close, checked
against orphaned rule selectors after) caught only the already-expected tab
button chain, so the leak is likely chrome that mounts outside the tab's own DOM
subtree entirely — a `LayerManager`-hosted `Tooltip` or `Menu` attached from a
toolbar button (Export, Filter) is the obvious candidate, since those overlay
into a separate root and would not appear in a scan scoped to the tab panel.
Needs its own investigation before 0.4.1 ships.

**Re-measured against the local `table-tab-close-residual-leak` fix (Menu
teardown across all seven owners, symlinked, not yet released) — the
`LayerManager`/`Menu` hypothesis was correct and is confirmed fixed at the
unit level, but it was not the dominant contributor to this app's leak, and
the app-level number barely moved.** Four `wide.cols_20` cycles on a fresh
page: retained rules per cycle went from 78 to **~72–73** — an ~8% reduction,
not the near-elimination the fix's own library-level tests show (confirmed via
`insertRule`/`deleteRule` instrumentation across one full cycle: 2371 inserted,
2299 deleted, 73 survivors, all `#uuid`-scoped).

Cross-referencing every surviving rule's id against a `MutationObserver` log of
every element ever added during the cycle (so transient components missed by a
before/after DOM snapshot are still caught) identified the leak precisely, and
it is **not `Menu`** — no `Menu`/`MenuItem`/`Tooltip` class appears anywhere in
the survivors:

| class | count |
|---|---|
| `Text` | 38 |
| `Panel` | 20 |
| `Button` | 6 |
| `Component` | 4 |
| `TabCloseButton` | 3 |
| `Glyph` | 2 |

`Button`: 6 matches `TableWorkPanel`'s toolbar button count exactly
(Add/Delete/Save/Refresh/Filter/Export, each built through `glyphButton`,
which routes every label through `Button`'s own tooltip text). This is **not**
an unregistered-child defect the way `Menu` was: confirmed by reading source
that `TableWorkPanel.addComponent(toolbar, …)` and `ToolBar`'s own
`addComponent(button)` pattern both register normally, so the ordinary child
recursion should already reach every one of these. Whatever leaks their rules
is a different mechanism than "raw-appended, never a child" — possibly
`Button`'s own `Tooltip.attach(this, str)` call (mirrors the `#uuid`-keyed
static `Tooltip.attachments` map already flagged as an unrelated memory-only
finding by the Menu-fix's own implementation, scoped out there as
non-stylesheet — worth re-checking whether that scoping was too narrow), or a
timing interaction with this app's own now-partially-redundant `PanelDisposers`
workaround (not yet deleted — that is `adopt-dock-owned-teardown`, still
unimplemented). Not resolved here; needs its own investigation.

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

## ✅ Fixed in library: no way to register a Dock tab whose content arrives later

Every async "open" in this app fetched its data **before** creating a tab —
`dock.addPanel`/`addLazyPanel` both required the panel's `Component` (or a
synchronous factory returning one) up front. Against a real database that
meant the user clicked, nothing appeared for seconds, and then a finished tab
popped in. There was no library-level way to say "register the tab now, build
its content once this fetch resolves" — a consumer that fetches before it can
build had to hand-roll its own placeholder panel and swap logic to get a tab
to appear first.

Fixed in the library (typescript-ui plan `tab-lazy-layout-constraint`):
`DockPanelSpec.content` widens to accept a `ComponentFactory` that may return
`Component | Promise<Component>`, and `dock.addLazyPanel` runs an async
factory behind its own spinner, swapping the built panel in on success. A
rejection tears the tab down and reaches a new Dock `"exception"` event
(`{ id, error }`) instead of leaving an empty tab behind. This app adopted
both across all fourteen of its async opens (plan
`lazy-tab-loading-sequence`): each `open*` method now registers its tab first
via a shared `openAsyncPanel` helper and hands the Dock an async factory,
with a single `dock.on("exception", …)` subscription routing failures to the
existing `notifyError`. SQLAdmin ships no spinner code, no placeholder
component, and no in-flight bookkeeping of its own.

---

## ✅ Fixed in library: button-triggered menus were anchored to the pointer

Four dock toolbar buttons (table/role-grants Export, the Structure panel's
Alter-column and Add-constraint launchers, the query-result Export) passed
`event.clientX`/`event.clientY` to `Menu.show(...)`, which cursor-anchors and
clamps-but-never-flips. It looked fine only because three of the four sat in
toolbars pinned to the top of their panel; the Structure accordion's header
tools live in a scrolling host and can reach the bottom edge, where the menu
would clamp upward over the button instead of flipping cleanly above it.

Fixed in the library by `MenuButton` (anchors to the button's rect, flips above
when the room below is short) plus a rect-anchored `Menu.toggleFor` (typescript-ui
plan `menu-anchored-placement`), adopted here across all four sites (plan
`menubutton-adoption`).

Adopting it surfaced two API gaps, both raised and **fixed in the library
before this migration landed** — logged here as resolved, not as open papercuts:

- An early draft mandated a single non-overloaded `MenuButton` constructor,
  which would have forced every options-first construction to pass a dummy
  `undefined` text. It now mirrors `Button`'s overload pair (options-only
  last), so `MenuButton({ … })` works exactly like `Button({ … })`.
- A per-open item provider had no way to say "open nothing" — an empty array
  mounted a bare, empty panel. `Menu.toggleFor` now suppresses the open (and
  still fires `onClose`) when the resolved item list is empty, which is what
  lets this app's two dynamic builders (`buildQueryExportItems`,
  `buildAlterColumnItems`) return `[]` instead of inventing placeholder
  strings for a state that has no honest explanation.

Both gaps were found only by a second consumer trying to *use* the component —
which is exactly what this app is for.

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

---

## ✅ Fixed in library: `Split.setPaneSize` looked like a raw primitive, but a weight-0 pane's decay was a refill bug

`setPaneSize(pane, px)` just seeds/overrides that one pane's stored size; it does
**not** rebalance the siblings. To force a *flexible* pane to a specific size you
must still set the other flexible panes too, so the stored sizes sum to the
available extent — the same thing [`dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts)
already does when it splits the editor over the result grid (it sets both panes).
This part is by design, not a defect: `weight` is consulted only by the
*container-resize* delta path (when `available` changes); a same-extent refill
scales the flexible panes **proportionally**.

The shell sidebar's collapse/expand cycle looked like it hit the same rule, but
didn't: the sidebar is `{ weight: 0 }` — a resize-pinned pane, not a flexible
one — and the pre-fix refill classified it flexible anyway (it tested only
`min == max`, the *hard* collapse pin), so a same-extent refill rescaled it like
any other flexible pane. Collapse pins the sidebar `min == max == RAIL_WIDTH`,
inflating the weighted dock to fill the freed space; expand then called
`setPaneSize(sidebar, lastWidth)` alone, leaving the dock at its inflated width,
so Σ overshot `available` and the proportional refill scaled the sidebar back
*below* `lastWidth`, compounding every cycle (280 → 226 → 190 → 165 → …;
confirmed offline in the library's `Split` TestDOM harness). That decay **was**
the library gap — a weight-0 pane should never be rescaled by a same-extent
refill, resize-pinned or not — and it is fixed upstream by
`split-weight-pin-refill`'s three-tier cascade (hard-pinned / resize-pinned /
flexible), which now holds a weight-0 pane at its stored px regardless of
sibling inflation.

The app's apportion-both-panes `expand()` workaround —
`setPaneSize(dock, (paneSize(sidebar) + paneSize(dock)) − lastWidth)` — **has
been removed** as part of `plans/implemented/layout-persistence.md` (step 6b). A
lone `split.setPaneSize(sidebar, lastWidth)` now holds: the fixed refill pins the
weight-0 sidebar at that px and the flexible dock alone reclaims the freed width
(`shell/SqlAdminShell.ts`, `buildWorkArea`).

The surviving "apportion all panes" guidance above is unchanged for the general
case — a caller forcing a *flexible* pane to a size still has to apportion its
siblings; only the weight-0-pin case is now handled by the library's refill.
