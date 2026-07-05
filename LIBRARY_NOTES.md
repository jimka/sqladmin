# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

---

## ✂️🩹✅ App shadow-counted dock panels instead of using `Dock`'s empty-state API

The controller tracked its own open-panel count (`_openPanelCount`,
`panelOpened`/`panelClosed`) to toggle a `Card` deck (start page vs. Dock) when
the workspace emptied — every open path had to keep the count in step. This was a
reimplementation: `Dock` **already** exposes the empty state as a dock-wide
aggregate — `isEmpty()`, a `"emptychange"` event carrying `{ empty }` (once per
real empty↔populated transition, tear-off-aware), and an `emptyContent` chrome
slot. (A stale `StartPage.ts` comment asserting "the Dock exposes no emptyContent
hook or emptychange event" was simply out of date.)

**The one real gap (fixed, library):** `DockOptions` had no `listeners` bag, so
those events could only be wired imperatively via `on(...)`. Added
`DockOptions.listeners` (the declarative form, dispatched through the shared
`Component.applyListeners`), matching the `listeners` bag other components accept.
Regression test added.

**App change:** the controller builds `Dock({ listeners: { emptychange: e =>
this._startToggle?.(e.empty) } })` and reads `dock.isEmpty()` for the initial
toggle, dropping `_openPanelCount` / `panelOpened` / `panelClosed` and their five
call sites (`SqlAdminController`). (Kept the app's CENTER Card-deck architecture
rather than switching to the Dock's `emptyContent` slot, which would nest the
start page inside the dock's empty region.)

---

## ✂️🔎 `ButtonGroup` forces one-always-selected — no collapsible/deselectable radio mode

The activity-bar rail is a set of icon `ToggleButton`s where selecting one view
deselects the others (radio), **but** clicking the already-active view deselects
*all* of them to collapse the sidebar. The library's `ButtonGroup` provides the
radio half, yet its `updateButtonStates` re-selects a button that was clicked off
(`if (!initiator.isSelected()) initiator.setSelected(true)`) — it enforces
"exactly one selected" — so it cannot express the click-active-to-collapse
gesture.

**Worked around (app):** the rail keeps its own two-line mutual-exclusion loop
(`buttonById.forEach(b => b.setSelected(id === activeId))`) plus a collapse path,
rather than adopting `ButtonGroup` (`shell/ActivityBar.ts`).

**Possible library improvement:** a `ButtonGroup` option (e.g. `allowDeselect` /
`toggle`) that lets a click on the selected member leave the group with nothing
selected and emit that, so a collapsible rail can use it. Low value — the manual
loop is small — so deferred until a second consumer wants it.

---

## 🐞✅ `autoScroll` Panel keeps its scrollbar gutter + scroll shadow after content shrinks

A `Panel` with `autoScroll` reserves a scrollbar **gutter** (it shrinks its
reported inner size by the bar width — `measureScrollbarGutter`) and paints a
**scroll shadow** overlay while its content overflows. Growing the content past
the viewport engages both correctly. But *shrinking* the content back within the
viewport — by removing children — did **not** clear them: the reserved gutter
space and the (e.g. bottom) shadow lingered until some **later, unrelated**
layout pass ran. Adding another child triggered such a pass, which is why the
stale state appeared to "fix itself" on the next add.

**Root cause:** `measureScrollbarGutter` runs in `Panel.doLayout` but only calls
`scheduleLayout()` for a follow-up pass when the measured gutter *changes*. On a
shrink the overflow→fit transition often hasn't settled on the pass right after
the removal, so the gutter reads its old (overflowing) value, sees no change,
and schedules nothing; the gutter and shadow (`updateScrollShadows`, same pass)
keep their overflow-state values until an external layout pass re-measures.

**Repro (sqladmin):** the filter dialog's condition rows live in an `autoScroll:
"y"` viewport. Add enough rows to show the scrollbar, then remove rows back below
the cap — the reserved gutter strip and the bottom scroll shadow stayed until you
added a row again.

**Fix (library):** `Panel.doLayout` now tracks its child count across passes and,
on the pass after a **decrease**, forces one follow-up layout
(`scheduleGutterSettleOnShrink`) so the next frame re-measures the gutter and
shadow against the settled (smaller) content and clears anything no longer
needed. Bounded and non-looping — it fires only after a decrease, and never for
a `"none"` panel. (Offline tests cover the scheduling contract; the visual
transition needs no overflow model the offline DOM lacks.)

**App change:** `dock/FilterDialog.ts`'s `removeRow` dropped its
`requestAnimationFrame(() => viewport.flushLayout())` follow-up — the panel now
self-clears.

---

## ✂️✅ `Button` can't tint the glyph independently of the text — no `glyphColor` option

`Button`'s `foregroundColor` sets CSS `color` on the whole button, and both the
title and the leading glyph inherit it (the glyph's SVG fills with
`currentColor`). So there was no first-class way to render, say, a green glyph
beside default-black text — a single button-level color painted both.

**Repro (sqladmin):** the filter dialog's "Add condition" button wants a green
`plus` glyph with a normal black label. Setting `foregroundColor: green` turned
the *text* green too.

**Fix (library):** added `glyphColor` and `descriptionColor` options (with
`setGlyphColor` / `setDescriptionColor` runtime setters) that colour the glyph or
the description element independently of the button's `foregroundColor`. The tint
is stored on the options bag, so a later `setGlyph` re-applies it to the swapped
glyph and a lazily-created description picks it up. Regression test added.

**App change:** the "Add condition" button passes `glyphColor: ADD_COLOR` in its
options bag instead of reaching into `getGlyph().setForegroundColor(...)`
(`dock/FilterDialog.ts`).

---

## 🐞✅ `ComboBox` with plain-string items made `getValue()` return the row *index*, not the string

`ComboBox({ items: ["id", "name", …] })` auto-keyed each plain-string item by its
array position — `setItems`/`AbstractCustomList` stored it as `{ key: String(i),
label }`. `getValue()` returns the selected item's **key**, so it yielded `"0"`,
`"1"`, … — the positional index — **not** the visible string. The API reads as if
`getValue()` returns the chosen string, so this was silent and easy to miss: the
label showed correctly, only the *value* was wrong.

**Repro (sqladmin):** the filter dialog built its column and operator combos from
plain-string arrays and used `columnCombo.getValue()` as the filter field. Apply
sent `field: "1"`; the backend `FilterCompiler` rejected it (`Unknown filter
column '1'`) → HTTP **422 Unprocessable Entity**, so filtering never worked. The
operator combo hit the same bug — `getValue()` returned `"0"`, so the label→key
lookup always fell through to its `contains` default. Reopening the dialog then
couldn't re-select the column, because the stored `"1"` matched no column name.

**Fix (library):** `AbstractCustomList.setItems` / `addItem` now key a plain-string
item by its own value (`{ key: label }`) instead of its array index, so
`getValue` / `setValue` round-trip the visible string for the common "list of
names" case. A pre-formed `{ key, label }` item still keeps its explicit key. This
is a behavioural change — callers that relied on index keys pass explicit
`{ key, label }` items to restore them; the affected List/MultiSelectList tests
were updated, and a round-trip regression test added.

**App change:** the column combo uses plain strings (`[NO_COLUMN, ...names]`);
the operator combo keeps explicit `{ key, label }` items because its display label
differs from its operator key (`dock/FilterDialog.ts`, `buildConditionRow`).

---

## ✂️✅ `Dialog` can't grow to its content after `show()` — no resize-on-content-change

A `Dialog`'s height was computed **once**, in the constructor, from the content
component's preferred size (`TITLE_HEIGHT + contentHeight + BUTTON_HEIGHT`), and
never revisited. Its content container is `Fit` + `overflow-y: auto`, so content
that grew *after* `show()` was stretched/compressed to the fixed area rather than
scrolled — and there was no hook to grow the dialog to fit new content.

**Repro (sqladmin):** the filter dialog lets the user add condition rows. Appending
a row grows the form's preferred height, but the already-shown dialog stayed its
original size.

**Fix (library):** added `Dialog.resizeToContent()` — it re-fits the height to the
content's current preferred size (`TITLE + content + BUTTON`), floored at the
dialog minimum and capped so the panel keeps a margin from the viewport edges
(past the cap the content area scrolls), then re-centres. No-op before `show()`
and when the height is unchanged. Regression tests added.

**App change:** `dock/FilterDialog.ts` no longer pins the form to a constant
height. It takes a `Dialog` instance and calls `dialog.resizeToContent()` from
the row add/remove path (`onContentChange`), so the dialog grows and shrinks with
the condition rows up to the viewport cap, then the inner `autoScroll` viewport
scrolls. (The prior workaround pinned the form to a fixed height so the dialog was
a constant size.)

---

## 🐞✅ `Event.addListener`'s capture dispatcher `stopPropagation`s events, swallowing document-level accelerators

`Event.addListener` (`core/Event.ts`) does not attach a per-element listener — it
registers the component in a map and installs **one window capture-phase
dispatcher** per event type (`baseListener`). When an event fires, `baseListener`
resolves the *exact target* element; if that element has any registered listeners,
it calls native `stopPropagation()` before invoking them. The event therefore never
leaves the window-capture phase — it reaches neither the bubble phase nor any
listener on `document`.

**Consequence:** a consumer's global keyboard accelerator wired the documented way
(a `document` keydown listener, bubble phase) only fires while focus is on an element
with **no** library listeners (e.g. `body`). The moment a component that registers
keydown is focused — a `List`, the `TextArea` editor, a `Tree` — its keydowns are
`stopPropagation`ed and the accelerator goes dead.

**Repro (sqladmin):** press Alt+H to focus the Recent list, then Alt+S — the second
chord is swallowed, because the now-focused `List` is the keydown target and has its
own keydown listeners.

**Fix (library):** `baseListener` no longer calls `stopPropagation()` on a
component's behalf (`core/Event.ts`). It dispatches to the exact-target
component's listeners and halts the event only when one of them *explicitly*
calls `stopPropagation` — so an unconsumed event keeps propagating through the
bubble phase to `document`-level listeners. The framework's own ancestor
dispatch is the explicit subtree walk (not native bubble), so its semantics are
unchanged. Tests pin that the native stop fires only on an explicit consume.

**App change:** `SqlAdminShell.installQueryAccelerators` dropped the
window-capture trick and registers a plain `document` keydown accelerator
(bubble phase) — the documented way — which now fires even while a `List` / the
editor / a `Tree` is focused. This also unblocks the planned focus-history
feature's global keydown accelerator.

---

## 🐞✅ Context-menu (`Menu.show`) outside-click dismissal misses `pointerdown`-cancelling targets

The rebuild-mode `Menu` (`overlay/Menu.ts`) — the right-click context menu, shown
via `menu.show(x, y, configs)` — wires its own outside-click dismissal: a
capture-phase **window `mousedown`** listener (`_onViewportMouseDown`, added in
`show()`) hides the menu when a press lands outside it. So dismissal *is* the
library's responsibility, and it works for most targets.

But `mousedown` is a **compatibility mouse event**: the browser suppresses it when
the preceding `pointerdown` was canceled with `preventDefault()`. `CustomListRow`
(`component/list/AbstractCustomList.ts`) does exactly that in `onPointerDown` (to
keep a row click from blurring the list root). So right-clicking a `List` row to
open a context menu, then clicking **another list row** to dismiss it, fires
`pointerdown` but **no `mousedown`** — the menu never closes. Any component that
cancels `pointerdown` (tree items, tab bars, drag handles) defeats it the same way.

**Repro (sqladmin Queries rail):** right-click a Saved/Recent row → context menu
opens → left-click another row → menu stays open. Verified with a window-capture
probe: a real row click reports `pointerdown: 1, mousedown: 0` and the menu stays;
clicking a plain element (the SQL editor) reports `pointerdown: 1, mousedown: 1`
and the menu closes.

**Fix (library):** `Menu`'s outside-press light dismiss now listens on
**`pointerdown`** instead of the compatibility `mousedown` (`overlay/Menu.ts`,
`_onViewportPointerDown`). Pointer events fire regardless of the compat-event
suppression, so a press on a `pointerdown`-cancelling target (another list row, a
tree item, a tab) now closes the menu. It still reaches the window-capture
viewport listener for targets that consume the event because `baseViewportListener`
only `stopPropagation()`s (not `stopImmediatePropagation()`), so same-node
same-phase listeners survive. Regression test added.

**App change:** `QueriesView` dropped its window capture-phase `pointerdown`
dismissal helper and calls `menu.show()` directly again (`shell/QueriesView.ts`).

---

## ✂️✅ No `Tree` expand-to-node / reveal-by-predicate seam

The Structure view's foreign-key click-through opens the referenced table and
then tries to reveal it in the navigator. But `Tree.selectNode` is a **no-op
when the target is not in the currently-visible flattened set** (an ancestor is
collapsed, or its lazy children have not loaded), and `Tree` exposed no public
API to expand a path to a node or find a node by predicate — `getNodes()`
returns only the roots and expansion is user-click-driven. So an FK whose target
lived under an unexpanded schema could not be revealed at all.

**Fix (library):** added `Tree.revealByPredicate((data, node) => boolean)` — a
depth-first search that awaits each lazy branch's `loadChildren` on the way
down, and on the first match expands every ancestor on the path and scrolls the
node into view, returning it (or `null`). Revealing does not select or emit
`"selection"`; a rejected lazy load is skipped. Regression tests added.

**App change:** `SqlAdminController.openReferencedTable` now reveals the target
via `revealByPredicate` (matching the node's `DbObjectRef`), opens the tab with
the revealed node, and selects it — so an FK target under an unexpanded schema
is expanded-to and highlighted, not just opened as a tab. The loaded-only
`findLoadedNode` walk was removed.

---

## ✂️✅ No `ColumnConfig` cell renderer for a link-styled cell

The Foreign Keys grid would ideally render its referenced table as a clickable
link cell. `Table` now emits a `"cellclick"` event (record + column), but
`ColumnConfig` had no `renderer` hook, so a cell could not be styled as a link
or carry custom markup.

**Fix (library):** added `ColumnConfig.renderer` — a `() => CellRenderer<any>`
factory. `Row.createCellForField` honours it ahead of the `values` (combo)
routing and the field-type switch, building a display-only `Cell` (no editor,
so it never enters edit mode) around a fresh renderer from the factory. Also
shipped `LinkCellRenderer` (link-coloured, underlined, pointer cursor) as the
first concrete renderer, so the common clickable-link case needs no
`CellRenderer` subclass (external subclassing is awkward because of the
callable-export `.d.ts` papercut below). Regression tests added.

**App change:** the Foreign Keys grid renders its `refTable` column with
`renderer: () => new LinkCellRenderer()` and opens the referenced table from the
grid's `"cellclick"` event (gated on `field === "refTable"`), replacing the
`"selectionchange"` workaround (`dock/StructurePanel.ts`).

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

## ✂️ Usage note: `Split.setPaneSize` is a raw, relative primitive — apportion *all* panes

`setPaneSize(pane, px)` just seeds/overrides that one pane's stored size; it does
**not** rebalance the siblings. To force a pane to a specific size you must set
the other panes too, so the stored sizes sum to the available extent — the same
thing [`dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) already does when it
splits the editor over the result grid (it sets both panes). This is by design,
not a defect: `weight` is consulted only by the *container-resize* delta path
(when `available` changes); a same-extent refill scales the flexible panes
**proportionally**.

The shell sidebar hit this by deviating from that pattern. Collapse pins the
sidebar `min == max == RAIL_WIDTH`, and the pin-aware refill inflates the weighted
dock to fill the freed space. Expand then called `setPaneSize(sidebar, lastWidth)`
**alone** — leaving the dock at its inflated width, so Σ overshot `available` and
the proportional refill scaled the sidebar back *below* `lastWidth`, compounding
every cycle (280 → 226 → 190 → 165 → …; confirmed offline in the library's `Split`
TestDOM harness). Fixed in the app by setting the dock too on expand —
`setPaneSize(dock, (paneSize(sidebar) + paneSize(dock)) − lastWidth)` — since the
two stored sizes always sum to the available extent (the refill's Σ invariant), so
their current total is a reliable stand-in for it (`shell/SqlAdminShell.ts`,
`buildWorkArea`).

**Not a library gap.** An auto-rebalancing `setPaneSize` would be a breaking
change for the apportion-all-panes callers above, so it isn't wanted. The only
plausible library candidate — and only if the VSCode-rail pattern recurs in
another consumer — is a **collapsed-size option on the existing native collapse**
(`setPaneCollapsed` collapses a pane to 0 + a `COLLAPSE_STRIP_SIZE` strip; the
shell instead wants collapse-to-rail-width so the icon rail stays visible, which
is why it pins `min == max` rather than using native collapse). Deferred until a
second consumer needs it.

---

## 🐞✅ Large `MemoryStore.loadData` renders zero rows in a Table

Selecting a PostgreSQL superuser in the Phase-2 roles browser (~1500 detail rows:
9 attributes + ~1477 table grants) left the role-detail Table blank — `loadData`
replaced the store records but the Table rendered zero rows, with **no error**.
Small roles (≤ ~12 rows) rendered fine; the failure scaled with row count.

**Root cause (library, confirmed in a browser):** at `_allRecords.length >=
WORKER_THRESHOLD` (1000) `AbstractStore.applyView()` offloads the sort/filter to a
Web Worker and populates the view (`_records`) only when that promise **resolves**
— but `ingestRaw` discarded the promise and `loadData` / `load` emitted `'load'`
**synchronously** right after, so `'load'` fired with `_records` still empty. The
bound `Table` rendered zero rows and never recovered, because nothing re-emits
when the worker lands (a later layout re-runs `renderWindow` but no store event
re-triggers it). Below the threshold the view builds in-process, so small datasets
worked — exactly the "scales with row count" symptom. (Diagnosed by reproducing in
a live browser: a 1500-row store in a hidden→shown Card deck showed `poolLen 0 /
contentHeight 0`, and the `'load'` event fired with `getRecords().length === 0`.)

**Fix (library):** `ingestRaw` now returns the `applyView` promise; `loadData`
emits `'load'` synchronously when the view built in-process and defers to the
worker's resolution otherwise, and the async `load()` awaits the view before
emitting. Regression test (stubbed worker) added. Verified in a browser: the
1500-row table now renders.

**App handling:** the role's grants stay in a *paginated* Dock table (`Store` +
an in-memory `PagingMemoryProxy` + `PaginationBar`, ≤ 100 rows/page) — kept on
purpose, since paging is the better UX (phpMyAdmin-style) for ~1500 grants, not
because the library forces it. A plain large `MemoryStore` Table now works too.

---

## 🐞✅ Menu item hover highlight stuck after clicking a command

After clicking **View → Toggle Sidebar** once, the item stayed highlighted, and
the highlight reappeared every time the View menu was reopened. Only View showed
it (its item is the only enabled one; disabled items never take the hover style).

**Root cause (library):** hover paints the item via `setFocused(true)` and relies
on `mouseout` (`setFocused(false)`) to clear it. The click that activates the item
closes and **detaches** the menu under the pointer, so the browser fires no
`mouseout` (same class as the orphaned-tooltip bug). `close()`'s
`setFocusedIndex(-1)` only resets the *keyboard*-tracked item, not one highlighted
by hover. Persistent-mode (MenuBar) menus reuse their item elements across
open/close, so the stale highlight persisted.

**Fix (library):** `Menu.close()` now sweeps every item with `setFocused(false)`.
Regression test added. No app change.

---

## 🐞✅ MenuBar dropdown item actions never fired

Wiring **View → Toggle Sidebar** to a `MenuBar` menu item's `action` did nothing —
the dropdown closed but the command never ran.

**Root cause (library):** a persistent-mode `Menu` (what a `MenuBar` dropdown uses)
wired each item's activation to **only** call the menu's `onClose`, never the
item's `config.action`. The rebuild-mode `show()` path (context menus) called
`config.action` correctly, so right-click menus worked while menu-bar commands
silently no-op'd. `MenuItemConfig.action` is documented as "called when the item
is activated".

**Fix (library):** `Menu.buildPersistentItems` now calls `config.action?.()`
before `onClose`, mirroring the `show()` path. Regression test added (the prior
test had codified the missing call). No app change beyond wiring the menu item.

---

## ✂️🔎 Accordion sections should be resizable

The `Accordion` has no way to resize its open sections — section heights are fixed
by each section's preferred/min size plus `fillHeight` (which only grows the
bottommost open section; see the note below). A VSCode-style explorer wants
draggable splitters between sections so the user can apportion height (e.g.
navigator vs properties) instead of one section being pinned to a fixed height.

**Possible library improvement:** add resizable gutters between open Accordion
sections (or a documented recipe for composing the Accordion with `Split`).
Investigate later.

---

## ✂️🔎 Consider a zero-inset default for rail-style containers

Building the activity bar, the containing Border panel's default content insets
(~4px per side) squeezed the narrow WEST rail once the bar collapsed to the rail
width — the rail (and its icon column) changed size across collapse/expand. Worked
around with `activityBar.setInsets(new Insets(0, 0, 0, 0))`.

**Possible library improvement:** let rail-style containers — a vertical `ToolBar`
used as an activity rail, or narrow fixed-width Border regions — default to zero
content insets, so a fixed-width strip stays a constant width regardless of the
host's size. Investigate later (confirm it doesn't regress normal ToolBar/ Border
spacing first).

---

## 🐞✅ `ToggleButton` ignores the `glyph` option (renders no icon)

**Symptom:** `new ToggleButton("", { glyph: "database" })` produced a button with
no glyph — it collapsed to a 14×6 box with no `<svg>` — so the activity-bar rail
icons were invisible.

**Root cause (library):** `ToggleButton`'s constructor calls `super(text)` with
**no options** (it dispatches the bag through `applyOptions` at the tail, after
`super()`), so `Button`'s constructor-time content build runs with `glyph`
undefined and never creates the glyph. The tail `applyOptions` then recorded
`_options.glyph` but did **not** call `setGlyph` — it assumed a *separate* late
`setGlyph`/`setDescription` triggered the content-row rebuild. For a plain
`Button` the constructor sees the option and renders; for `ToggleButton` (and any
subclass that forwards only `text` to super) the glyph option was silently
dropped.

**Fix (library):** `Button.applyOptions` now dispatches `setText`/`setGlyph`/
`setDescription` when the content row is already built — a post-construction call
such as a subclass's tail `applyOptions` or a runtime re-apply — and pure-writes
only during the super-time cascade (before the row exists, where the constructor
still dispatches). A `ToggleButton` built with `{ glyph }` renders its icon.
Regression test added.

**App change:** the rail passes the glyph in the `ToggleButton` options bag again
and dropped the explicit `setGlyph` call (`shell/ActivityBar.ts`).

---

## ✂️🩹✅ Accordion `fillHeight` only fills the bottommost open section

The sidebar wants the navigator (top section) to fill while the Properties
inspector (bottom section) stays a fixed compact height. `Accordion.fillHeight`
routes all leftover space to the **bottommost open** section — there is no
per-section fill weight or "this section fills" flag — so with both sections open
the bottom one always grows. Turning fill off instead leaves an empty gap when
the content underflows.

**Worked around (app):** disabled `fillHeight`, gave the filling section an
outsized preferred height (`SIDEBAR_FILL_HINT = 10000`) so the accordion's
proportional shrink handed it every remaining pixel. Worked, but relied on a
magic preferred height rather than declaring intent — and split the two Queries
lists ~50/50 only by coincidence of equal preferreds.

**Fix (library):** added a per-section `fillWeight` constraint (surfaced via
`AccordionSectionConfig.fillWeight` / `addSection`). When the open sections
underflow, the leftover height is split among the weighted sections in
proportion — so a single weighted section (in any position, not just the
bottommost) fills all the slack and equal weights share it. `computeFill` returns
a per-section extra-height map; with no weights set it falls back to the
bottommost-fills behaviour, so `setFillHeight` is unchanged. Regression tests
added (non-bottommost fill; weighted split).

**App change:** the tree-explorer's tree section and both Queries list sections
declare `fillWeight: 1` (the tree and lists carry a `0` preferred so the sections
underflow and actually fill); `sidebarFillHint.ts` and the `10000` constant are
gone (`shell/treeExplorerView.ts`, `shell/QueriesView.ts`).

---

## 🐞✅ Tooltip rendered beneath modal dialogs

Hovering a button on a modal `Dialog` showed its tooltip *under* the dialog and
its darkened backdrop. The tooltip's z-index was a hardcoded 10001, below the
`LayerManager` Dialog band (11000).

**Fix (library):** added a Tooltip z-index band (12000) above every managed
layer; the Tooltip singleton stamps itself from it. No app change.

---

## 🐞✅ Tooltip lingered after its anchor vanished

A tooltip whose attached component was removed from the DOM stayed on screen
until another tooltip registered. The browser fires no `mouseout` when an
element is removed under a stationary pointer, so the anchored hide never ran.

**Fix (library):** the Tooltip now tracks its active anchor and, while shown,
watches pointer movement; once the anchor is no longer connected it dismisses
itself. No app change.

---

## ✂️✅ Table had no selection-change event

Disabling the toolbar's Delete button until a row is selected needed to react to
the grid's selection changing, but `Table` exposed only `getSelectedRecords()` —
no event, and the `Body` it wraps is private.

**Fix (library):** `Body` now emits `"selectionchange"` (current selection) from
every mutation point, and `Table` gained its own event surface forwarding it.
The toolbar enables Delete only when a still-live row is selected
(`TableWorkPanel`, re-checked on `selectionchange` and store `datachanged`).

---

## 🔎 No built-in "required" cell affordance (enhancement, deferred)

The table has no way to mark a column/cell as required and visually flag it —
e.g. a header asterisk and a tint on an empty required cell, especially in a
freshly added (new) row. SQLAdmin validates required fields (NOT NULL, not
generated, no default) only at Save time and reports the missing names on the
status bar; there is no inline, per-cell hint guiding the user *as they fill a
new row*.

**Suggested library enhancement:** a `ColumnConfig.required` flag (or a
`requiredPredicate(record)`) that renders a required affordance and tints empty
required cells, so consumers get the visual guidance without a custom renderer.
Deferred for now — the Save-time validation message covers the basic need.

---

## 🐞✅ MenuBar menu stayed open when empty bar space was clicked

Opening a menubar menu and then clicking empty space *in the menubar* (beside the
buttons) left the menu open. `MenuBar.openMenu` excluded the whole bar element
from the dropdown's outside-click dismissal (to stop the opener button's own
mousedown self-closing it), which also exempted the empty bar background.

**Fix (library):** exclude only the opener button, not the whole bar — empty-bar
clicks now fall through to the menu's dismissal. No app change.

---

## 🐞✅ Boolean table cells ignored read-only

Locking the structure grid (`Table` with `rowReadOnly: () => true`) stopped text
cells from editing but **not** boolean cells — their checkboxes stayed
interactive, so a user could still toggle `nullable`/`isPrimaryKey`/etc. A
`BooleanCell`'s checkbox is its always-on renderer, so the cell's read-only flag
never reached it (and `BooleanCell.startEdit` overrode the base's `isReadOnly`
guard, leaving the dblclick / keyboard toggle paths open too).

**Fix (library):** `BooleanCell.setReadOnly` forwards to the checkbox and
`startEdit` short-circuits when read-only. No app change — the app already
requested read-only correctly; the library now honors it.

---

## ✂️✅ Dock tabs had no tooltip option

A dock tab showed only its title; there was no way to give it a hover tooltip
(the app wanted each tab to show the table's name, database, and schema).
`DockPanelSpec` carried `title`/`glyph`/`closeable` but nothing for a tooltip.

**Fix (library):** added `DockPanelSpec.tooltip` (carried via
`LayoutConstraints.tooltip`); `TabBar` attaches it to the tab button with
`Tooltip.attach` and detaches on removal. The controller passes a
`name\nDatabase: …\nSchema: …` string for each opened tab (`SqlAdminController`).

---

## ✂️✅ Tree had no programmatic selection setter

Syncing the navigator's highlighted node to the active dock tab needed to set
the tree selection from code, but `Tree` exposed only `getSelectedNode(s)` —
selection could only change via a user click / arrow key.

**Fix (library):** added `Tree.selectNode(node)` — selects + scrolls into view,
and deliberately does **not** emit `"selection"` (a programmatic sync must not
re-trigger the open-the-table side effect a real click has). The controller calls
it from the Dock `"focus"` handler (`SqlAdminController`).

---

## ✂️✅ Tree had no right-click / context-menu hook

`Tree` emitted only `selection` and `loaderror`, so there was no way to offer a
right-click action on a node (the navigator needed "open the table's structure in
its own tab"). Re-clicking selection was the only signal, and it is wired to
opening the data tab — unsuitable for a secondary action.

**Fix (library):** added a `"contextmenu"` event firing `(node, MouseEvent)`; it
suppresses the native menu and leaves selection unchanged. The navigator pairs it
with a rebuild-mode `Menu` (`navigator/NavigatorTree.ts`) to show "Open structure".

---

## 🐞✅ Card: a child first shown at runtime renders blank

`Card` (used for the table panel's Data | Structure toggle) showed the structure
view blank the first time the Structure button was pressed; switching dock tabs
and back made it appear. `Card.doLayout` only ever lays out the *visible* child,
so the structure view — hidden during the panel's initial layout pass — was never
sized. `setVisibleComponentId` flipped visibility but scheduled no layout, so the
newly shown child stayed unsized until an unrelated relayout (the dock tab switch)
laid the whole subtree out again.

**Fix (library):** `Card.setVisibleComponentId` now calls
`getContainer()?.scheduleLayout()` after switching, so the newly shown child is
sized on the next frame. No app change needed.

---

## ✂️ AjaxProxy.writeRecord sends the WHOLE record, so the backend must coerce wire types

On a per-record write, `AjaxProxy.create`/`update` serialize the *entire* record
(`writeRecord` → every field, not just the dirty ones) as **wire scalars** — e.g.
a timestamp goes out as the ISO string `"2026-06-28T12:04:59.110Z"` and a numeric
as the precision string `"1240.50"`. The server therefore cannot bind the JSON
values to typed columns directly: asyncpg rejects an ISO *string* for a
`timestamptz` parameter ("expected a datetime instance, got 'str'").

**App fix (backend):** added `from_wire_value(value, column)` in `wire.py` — the
inverse of `to_wire_value` — that maps each wire scalar back to the native Python
type the column binds (ISO string → `datetime`/`date`/`time`, numeric string →
`Decimal`, base64 → `bytes`, json → text), driven by the column's introspected
type. `InsertRowCommand`/`UpdateRowCommand` run every payload value through it.

**Note:** because the writer sends *all* fields, an UPDATE re-sends unchanged
columns too. Harmless once the server coerces, but a `dirty-only` write mode (or
a `Writer` that emits only changed fields) would shrink the payload.

---

## 🐞✅ AjaxStore batched writes with no per-record opt-out

`store.sync()` sent a **single batch array** to the collection URL for each phase —
`createBatch`/`updateBatch`/`destroyBatch` POST/PUT/DELETE `writeRecords(records)`
(a JSON array) to `{url}`. `AbstractStore.sync` uses the batch method whenever the
proxy defines it, and `AjaxProxy` *always* defined them, so there was no way to opt
into per-record writes (the documented `POST {url}` single-object /
`PUT|DELETE {url}/{id}` per-id endpoints were only hit when the proxy lacked the
batch methods). The SQLAdmin backend's per-record endpoints received a batch array
instead — adding a row then Save posted body `[{}]`, which FastAPI rejected with
422 "Input should be a valid dictionary", so Save never reached the DB.

**Fix (library):** added a `batch?: boolean` option to `AjaxProxyOptions`
(default `true`). When `false`, the constructor hides the three batch hooks on the
instance, so `AbstractStore.sync` falls back to one request per record against the
existing `POST {url}` / `PUT|DELETE {url}/{id}` endpoints. The app sets
`batch: false` on its store (`data/stores.ts`). Editable grid cells (so a new row
can be filled) come from a `ColumnSpec` marking generated columns `readOnly`;
cells are inline-editable by default.

---

## 🐞✅ Dock: `addPanel` crashed after the last tab was closed (empty dock)

After closing every tab, no table could be opened again. Closing the last tab
prunes its (root) region — `pruneRegion` removed the emptied region from its
parent, which for the root *is the dock* — leaving the dock with no region. The
next `addPanel` → `activeTabRegion` → `isTab(undefined)` →
`undefined.getLayoutManager()` threw (`Cannot read properties of undefined`),
rejected the `openTable` promise, and nothing opened.

**Fix (library):** `pruneRegion` keeps an emptied **root** region (its parent is
the dock) as the dock's add/drop target; only nested regions are pruned. An empty
dock now retains a valid empty region, so `addPanel` works again.

---

## 🐞✅ Dock: opening a panel didn't activate it

`dock.addPanel(spec)` added the tab but left the previously-active tab showing —
the newly opened panel opened *behind* the current one. A `dock.focusPanel(id)`
immediately after `addPanel` was a no-op, because the Tab creates a child's tab
cell lazily during its next `doLayout` pass, so right after `addPanel` the frame
isn't in the Tab's content list yet (`indexOfContent` → -1). Re-selecting an
already-open panel focused fine (its cell existed by then).

**Fix (library):** added `Tab.setActiveContent(content)` that activates the tab,
deferring to the next `doLayout` if the cell doesn't exist yet; `Dock.addPanel`
calls it so opening a panel shows it. The app's manual post-`addPanel`
`focusPanel` is removed.

---

## ✂️✅ Dock: tabs were not closeable, with no way to enable it

`DockPanelSpec` had no closeable option and `Dock`'s internal `leafConstraints`
never set `closeable`, so dock tabs never showed a close button — and a consumer
had no way to turn it on. (The Tab layer fully supports it via
`LayoutConstraints.closeable`, and the Dock already wires tab close → its
`"close"` lifecycle event; only the toggle was missing.)

**Fix (library):** added `DockPanelSpec.closeable` (default `true`) and had
`leafConstraints` request it. Closing a tab now fires the Dock `"close"` event,
which the app's controller already maps to disposing the panel's store.

---

## 🐞✅ Component `#id` CSS rule not escaped → breaks on ids with `.`/`:`

**Symptom:** A `Dock` panel rendered with its tab bar *behind* the content — the
content frame overlapped and hid the `TabBar`.

**Root cause (library):** Each component's `position:absolute` (and all other
rule-based styles) comes from a per-component CSS rule scoped to `#<id>`. The
selector was built as `"#" + id` with **no `CSS.escape`** (`core/StyleTarget.ts`
`_selectorOf`). Our Dock panel id was `public.customers`; `#public.customers`
parses in CSS as *id `public` + class `customers`*, so the rule never matched
the element, `position:absolute` was dropped, and the frame collapsed to
`position:static` (rendering at top:0 over the tab bar).

**Fix (library):** `_selectorOf` now `CSS.escape`es the id; added an optional
`suffix` to the `component` scope so live selector suffixes (`:hover`,
`.selected`) stay unescaped. Hardened `DOM` `escapeSelector` to fall back when
`CSS.escape` is absent (jsdom/SSR). Regression test: `tests/core/StyleTarget.test.ts`.

**Takeaway:** Any consumer-supplied id (Dock panel ids, component ids) could
contain CSS-special chars. The library should escape ids everywhere it builds a
selector from one — audit other `#${id}` / `'#' + id` sites for the same gap.

---

## ✂️✅ External consumers couldn't subclass a library class (unresolved `~/` alias in the shipped `.d.ts`)

`class SqlAdminShell extends Panel { ... this.addComponent(...) }` type-checked
inside the library's own source but **failed for an external consumer** resolving
the built `.d.ts`: `tsc` reported *"Property 'addComponent' does not exist on type
'SqlAdminShell'"*. The same wall blocked `class PagingMemoryProxy extends
MemoryProxy` (*"Property 'setData' does not exist"*) — even though a **direct**
`new MemoryProxy().setData([])` type-checked fine (confirmed with a two-line probe).
So it was **not** the `callable()` wrapper, which was the original guess here: it
hit *every* library class, plain data classes included.

**Root cause (found + fixed in the library).** The library source uses a `~/*`
path alias (`~ -> src/typescript/lib`), and the declaration build emitted the
`.d.ts` with those alias imports **verbatim** — `tsc` does not rewrite path aliases
on emit, and no post-step did. A consumer has no `~` mapping, so e.g.
`import { Proxy } from '~/data/proxy/Proxy.js'` inside `MemoryProxy.d.ts` resolved
to `any` (silently, under the consumer's `skipLibCheck`). A base class that resolves
to `any` makes a *further* subclass inherit none of the base's members — while a
direct instance, whose own declared members don't depend on the broken base, is
unaffected. Proven by adding a temporary `~` → `dist/lib/types` mapping in the app:
subclassing then saw every inherited member.

**Library fix.** Run `tsc-alias` after the declaration emit (`build:lib`) to
rewrite the `~/*` imports to relative paths, plus an `outDir` for tsc-alias to
locate the `.d.ts` (emitDeclarationOnly emits no `.js`) — so the shipped types are
self-contained. Verified: 0 `~/` imports remain in `dist/lib/types`, and an
external consumer can now `extends Panel` / `extends MemoryProxy` and reach
inherited members with no workaround.

**Fallout (worth knowing).** Once real types flowed to the consumer they unmasked
latent errors the `any` had hidden — 14 in sqladmin: 7 app-side (mostly `: Panel`
annotations on functions returning a `Container`, and a `Container({ autoScroll })`
that silently ignored the Panel-only option), and 7 library public-API type bugs
(`Menu()`'s no-arg overload dropped by the callable's `ConstructorParameters`,
`ComboBoxOptions.items` narrower than `setItems`, `Text`'s over-narrowing options
generic) — all now fixed.

**App change:** `SqlAdminShell` can subclass `Panel` again, and
`data/PagingMemoryProxy.ts` now `extends MemoryProxy` (dropping its reimplemented
array storage) instead of the abstract `Proxy`.

---

## ✂️ Remote `AjaxStore` silently needs a page size to parse an envelope

A remote store whose backend returns a `{rows, totalCount}` envelope only parses
it in **paginated** mode — i.e. only when the read carries `page`/`pageSize`.
With no page size set, `AjaxProxy.read` runs the unpaginated branch, which
expects a **top-level array**, and throws `response is not an array`.

**App workaround:** always set `pageSize` on the store (`data/stores.ts`).

**Suggestion:** make the envelope/array decision driven by the reader/response
shape rather than by whether pagination params were sent, or surface a clearer
error ("expected an array but got an object — did you mean to set a page size /
configure a rootProperty?").

---

## ✂️ `AjaxStore` store-level options only apply via the single-bag form

`remoteSort` / `remoteFilter` / `pageSize` are only honored when the store is
built with the single options bag (`new AjaxStore({ model, proxy, ... })`). The
positional `new AjaxStore(model, proxyOptions)` form skips `applyOptions`, so
those options are silently ignored.

**Suggestion:** either apply store options in the positional path too, or
document/deprecate the positional form.

---

## ✂️ Construction idiom is discoverable only by reading the demos

The preferred "callable shorthand + options bag" style (`Panel({ layoutManager:
HBox(), components: [...] })`, `Table(store)`) — and the fact that components/
layouts are `callable()`-wrapped (work with or without `new`) while data classes
(`Model`, `AjaxStore`, `JsonReader`) are **not** — isn't documented; it was
learned from `ComplexUIPanel.ts`.

**Suggestion:** a short "constructing components" doc page covering the callable
shorthand, `components:`/`layoutManager:` nesting, and which exports are callable.

---

## ✂️✅ Glyph barrel import pulls ~2,000 modules in dev

Importing from `@jimka/typescript-ui/glyphs/solid` (the barrel) makes Vite's dev
server fetch every glyph module on page load. Per-glyph subpath imports
(`.../glyphs/solid/file`) + `Glyph.register(...)` avoid it — but the built
package only exported the barrel, so an external consumer *couldn't* import a
single glyph (the subpath didn't resolve).

**Fix (library):** added a `"./glyphs/solid/*"` wildcard export mapping to the
per-glyph files the build already emits. The toolbar now imports just
`refresh`/`plus`/`minus`/`save` (see `dock/TableWorkPanel.ts`) and registers them.

---

## ✂️ Linking the library into a Vite app needs config tweaks

Consuming the library via a symlinked local dep (`file:../../typescript-ui`)
needed `server.fs.strict: false`, `resolve.dedupe`, and
`optimizeDeps.exclude` for `@jimka/typescript-ui` (see `frontend/vite.config.ts`)
to avoid out-of-root fs errors and double-bundling. Worth a documented recipe
for local development against the library.
