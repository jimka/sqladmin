# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

---

## 🐞🩹🔎 `Event.addListener`'s capture dispatcher `stopPropagation`s events, swallowing document-level accelerators

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

**Worked around (app):** register accelerators on **`window` in the capture phase**
(`SqlAdminShell.installQueryAccelerators`). `baseListener` calls `stopPropagation()`,
not `stopImmediatePropagation()`, so other listeners on the *same node and phase*
(window capture) still run. The same trick fixes the context-menu dismissal below.

**Possible library improvement:** don't `stopPropagation()` unless a component's
handler actually consumes the event, or expose a first-class global-accelerator /
keybinding API. Also affects the planned focus-history feature, which relies on a
global keydown accelerator.

**Status:** 🩹 worked around in the app; 🔎 fix belongs in the library.

---

## 🐞🩹🔎 Context-menu (`Menu.show`) outside-click dismissal misses `pointerdown`-cancelling targets

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

**Possible library improvement:** have the light-dismiss listen on **`pointerdown`**
(in addition to, or instead of, `mousedown`) — pointer events fire regardless of the
compat-event suppression. The same applies to any overlay using `mousedown`-based
light dismiss; the window-`blur` fallback is unaffected.

**Worked around (app):** `QueriesView.showContextMenu` registers a window
capture-phase `pointerdown` listener alongside `menu.show()` that hides the menu on
an outside press, removed via `show`'s `onClose`. Capture phase is required for the
reason in the accelerator note above.

**Status:** 🩹 worked around in the app; 🔎 fix belongs in the library.

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

## 🐞🔎🩹 Large `MemoryStore.loadData` renders zero rows in a Table

Selecting a PostgreSQL superuser in the Phase-2 roles browser (~1500 detail rows:
9 attributes + ~1477 table grants) left the role-detail Table blank — `loadData`
replaced the store records but the Table rendered zero/stale rows, with **no
error**. Small roles (≤ ~12 rows) render fine; the failure scales with row count.

**Root cause (so far):** `AbstractStore.loadData` is synchronous and *does* update
the records (`ingestRaw` → `applyView` → emit `'load'`), so the store is correct —
the failure is downstream in the Table's load→render / `VirtualScroller` path for
a large in-memory dataset. The Table is built inside an initially-hidden `Card`
deck page (the activity-bar Roles view) and shown later; collapsing/re-expanding
(forcing a fresh layout) does **not** recover it, so it is not purely a
viewport-measure-on-show issue. Needs a dedicated debug pass on the
Table/`VirtualScroller` large-`loadData` render in the library.

**App handling (🩹):** the role's grants render in a *paginated* Dock table
(`Store` + an in-memory `PagingMemoryProxy` + `PaginationBar`, ≤ 100 rows/page,
mirroring the MiscPanel paginated-table demo), so the Table never loads more than
a page at once. (The sidebar Details panel shows only base info — attributes +
memberships, always small — so it uses a plain `MemoryStore` and never hits the
limit.) Paging is also better UX (phpMyAdmin-style), but it sidesteps rather than
fixes the underlying library limit, which stays **open**.

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

## 🐞🩹 `ToggleButton` ignores the `glyph` option (renders no icon)

**Symptom:** `new ToggleButton("", { glyph: "database" })` produced a button with
no glyph — it collapsed to a 14×6 box with no `<svg>` — so the activity-bar rail
icons were invisible.

**Root cause (library):** `ToggleButton`'s constructor calls `super(text)` with
**no options** (it dispatches the bag through `applyOptions` at the tail, after
`super()`), so `Button`'s constructor-time content build runs with `glyph`
undefined and never creates the glyph. The tail `applyOptions` then records
`_options.glyph` but does **not** call `setGlyph` — it assumes a *separate* late
`setGlyph`/`setDescription` triggered the content-row rebuild (see the comment at
`Button.applyOptions`). For a plain `Button` the constructor sees the option and
renders; for `ToggleButton` (and any subclass that forwards only `text` to super)
the glyph option is silently dropped.

**Worked around (app):** construct without the option and call `button.setGlyph(name)`
explicitly — that path triggers the content-row rebuild and the icon appears
(`shell/ActivityBar.ts`).

**Possible library fix:** have `Button.applyOptions` dispatch `setGlyph`/`setText`/
`setDescription` when those options change post-construction (not just record
them), or have `ToggleButton` forward the options bag to super.

---

## ✂️🩹 Accordion `fillHeight` only fills the bottommost open section

The sidebar wants the navigator (top section) to fill while the Properties
inspector (bottom section) stays a fixed compact height. `Accordion.fillHeight`
routes all leftover space to the **bottommost open** section — there is no
per-section fill weight or "this section fills" flag — so with both sections open
the bottom one always grows. Turning fill off instead leaves an empty gap when
the content underflows.

**Worked around (app):** disabled `fillHeight`, pinned the Properties section to a
fixed height (`preferred === min`, so the shrink can't steal from it), and gave
the navigator an outsized preferred height (`NAV_FILL_HINT`) so the accordion's
proportional shrink hands it every remaining pixel. Works, but relies on a magic
preferred height rather than declaring intent.

**Possible library improvement:** a per-section grow/fill weight (or a
`setFillTarget(index)` override), so a non-bottom section can be the one that
absorbs leftover height without the outsized-preferred trick.

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

## ✂️ Subclassing the callable component export drops instance methods (external `.d.ts`)

`class SqlAdminShell extends Panel { ... this.addComponent(...) }` type-checks
inside the library's own source (where `@jimka/typescript-ui/*` resolves to
source) but **fails for an external consumer** resolving the built `.d.ts`:
`tsc` reports *"Property 'addComponent' does not exist on type 'SqlAdminShell'"*.
The public `Panel` is the `callable()`-wrapped export, whose value type is a
call/construct signature that doesn't carry the class's instance members through
`extends` in the emitted declarations.

**App workaround:** build components with the callable factory form
(`const shell = Panel({...}); shell.addComponent(...)`) instead of subclassing —
which is the recommended construction idiom anyway (`shell/SqlAdminShell.ts`).

**Suggestion:** expose a subclassable class type for external consumers (there is
a `_Panel` raw export, but it reads as private), or make the callable export type
a proper subclassable constructor in the built `.d.ts`.

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
