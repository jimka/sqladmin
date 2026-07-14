# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

---

## ✂️🔎 Extract `LabeledFieldSet`'s labeled-grid interior into a chrome-less container

`LabeledFieldSet` couples two separable concerns: (1) the baseline-aligned
title/component pair grid (multi-column via its `columns` option), and (2) the
`<fieldset>` chrome — a bordered box with a `<legend>` caption. A consumer who
just wants to line up a set of components with their labels has no way to get
concern (1) without also getting concern (2)'s border and legend (see the
empty-legend papercut below, which that chrome forces on you).

Proposal: extract the interior grid into a standalone container rendered in a
plain `<div>` — no `<fieldset>`, no legend — exposing the same
`addField`/`addRow`/`addFullWidthRow` methods and `columns`/`fieldSpacing`/`rows`
options. `LabeledFieldSet` then composes it internally (the extracted grid placed
inside its `<fieldset>` chrome), so nothing changes for existing consumers. This
gives users a quick way to align a labelled set of components without opting into
fieldset features they may not want.

Naming (open). `LabeledComponentSet` was the first thought, but "Set" reads as
the HTML `<fieldset>` this variant deliberately drops, so a different suffix is
clearer:
- **`LabeledGrid`** (recommended) — "a grid of labelled components"; general
  enough for arbitrary components, and composes cleanly to read as
  `LabeledFieldSet` = a `LabeledGrid` inside a `FieldSet`. Minor overlap with the
  `Grid` layout-manager name, but a different namespace (a container, not a layout).
- **`LabeledFieldGrid`** — parallels `LabeledFieldSet`, keeps the "field" term.
- **`FieldGrid`** / **`LabeledFields`** — shorter alternatives.

---

## ✂️🩹🔎 `LabeledFieldSet` with an empty legend leaves a gap in the top border

`SequenceInfoPanel` originally built its form as `new LabeledFieldSet("", {...})`
— an empty legend string still reserves the legend's notch in the fieldset's top
border, so the border renders with a visible gap where the (invisible) legend
text would sit. Worked around in the app by always passing a non-empty legend
(the sequence's schema-qualified name). Candidate library fix: collapse the
legend notch entirely when the title is empty, the same way a browser-native
`<fieldset><legend></legend></fieldset>` does.

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

## ✂️ Linking the library into a Vite app needs config tweaks

Consuming the library via a symlinked local dep (`file:../../typescript-ui`)
needed `server.fs.strict: false`, `resolve.dedupe`, and
`optimizeDeps.exclude` for `@jimka/typescript-ui` (see `frontend/vite.config.ts`)
to avoid out-of-root fs errors and double-bundling. Worth a documented recipe
for local development against the library.
