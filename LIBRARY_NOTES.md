# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

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
