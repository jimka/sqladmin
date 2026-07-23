# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

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
