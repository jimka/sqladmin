# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

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
