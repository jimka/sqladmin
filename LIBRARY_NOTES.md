# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

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
