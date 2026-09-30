# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

---

## 🐞🔎 `SplitButton`'s dropdown cannot be opened from the keyboard (0.10.0)

Found while giving the query panel's Save button a "Save as…" chevron menu. The chevron is a
non-focusable `Glyph` inside the `<button>`, opened only by a subtree `click` listener
(`component/button/SplitButton.ts:141-156`, `_toggleMenu` at `:235`); there is no keydown path
(e.g. Alt+ArrowDown / ArrowDown) and no `aria-haspopup`/`aria-expanded`, so keyboard and
screen-reader users cannot reach the menu.

Recommended fix: open the menu on Alt+ArrowDown (and ArrowDown) while the button has focus,
and expose `aria-haspopup="menu"` plus `aria-expanded`.

SQLAdmin impact: the query panel's "Save as…" menu item is mouse-only; Ctrl/Cmd+Shift+S covers
keyboard users. SQLAdmin does not work around it.

---

## 🐞🔎 `SpatialNavigation` control tier: container priority beats a band-sharing neighbour, so `Ctrl+Alt+←` from a `CodeEditor` stays in its own panel (0.10.0)

Found verifying `spatial-navigation-adoption` against an unreleased library build; the
same ranking ships in 0.10.0. Paths and line numbers below are under
`typescript-ui/packages/lib/src/typescript/lib/core` on that build.

In a query tab, `Ctrl+Alt+←` from the SQL editor lands on the result pane's *Record
view* toolbar button, just below and left of the editor, not on the sidebar tree
beside it. Geometry at 1500×850: the focused `.cm-content` spans x 331–890, y
103–253 (CodeMirror's line-number gutter fills x 280–331). The *Record view* button
is at x 280–300, y 284–308. The navigator tree is at x 41–279, y 81–585.

`rankInDirection` (`SpatialNavigation.ts:122-154`) sorts candidates that share the
origin's perpendicular band first. The tree shares the editor's vertical band and
the button does not, so on geometry alone the tree wins. But `rankWithContainerPriority`
(`SpatialNavigation.ts:559-582`) first ranks every candidate inside the origin's
nearest revealing container (`FocusReveal.containing`) ahead of every candidate
outside it. The *Record view* button is inside the query panel's container and the
tree is not, so the button wins even though it is outside the band.

The priority exists so a move can't skip a scrolled-out sibling. It also overrides
direction whenever a nearer-in-band control sits outside the container. Suggested
fix: apply the container priority only among candidates that share the band (or
only among candidates not yet revealed), so a band-sharing neighbour outside the
container still beats an off-band one inside it. The region tier is unaffected:
`Ctrl+Alt+Shift+←` from the editor lands in the sidebar as expected. SQLAdmin does
not work around it.

---

## 🐞🔎 `Dialog` restores focus to a disposed opener, throws, and never resolves `show()` (0.9.0, 0.10.0)

Found while verifying the navigator refresh after DDL. After Create schema (or table, view)
→ *Review SQL…* → *Execute*, the console shows `DOM handle <n> is not registered`. It
reproduces identically on 0.9.0 and 0.10.0, so it is not an upgrade regression. Paths below
are under `typescript-ui/packages/lib/src/typescript/lib`.

`Dialog.show` stores the opener's focus as a handle (`overlay/Dialog.ts:922`,
`_previousFocus = DOM.source.getActiveElement()`), here the create tab's *Review SQL…*
button. Execute's success path closes that tab (`dock.removePanel`), disposing the button and
releasing its handle. `Dialog.hide`'s finalize then calls `DOM.sink.focus(this._previousFocus)`
unguarded (`Dialog.ts:1285-1286`), and `HandleRegistry.resolve` throws.

The throw lands before `this._resolvePromise(result)` (`Dialog.ts:1289-1292`), so the
`show()` promise never resolves. In SQLAdmin that skips `SqlPreviewDialog`'s
`finally { errorBanner.dispose() }`, leaking one error banner per successful create-tab
Execute. The DDL itself has already run, so no data is affected.

Recommended fix: guard the restore the way `overlay/Tooltip.ts:132` already does
(`DOM.source.isRegistered(...) && DOM.source.isConnected(...)`), and resolve the promise
even if restoring focus fails. SQLAdmin does not work around it.

---

## 🐞🔎 Tab modified dot: glyph-less tabs show nothing, no accessible cue, docs describe the old placement (0.10.0)

Found wiring SQLAdmin's dirty-tab indicator to `Dock.setPanelModified`. Paths below are
under `typescript-ui/packages/lib`.

The design is fine: the dot is a badge over the upper-left corner of the tab's leading
glyph (`TabButton.setModified`, `src/typescript/lib/component/button/TabButton.ts:470`),
and typescript-ui commit `df98c1f6` moved it there from trailing the label on purpose.
Three things around it are wrong:

- **Code defect.** `positionModifiedBadge` computes
  `shown = this._modified && glyph !== null` (`TabButton.ts:554`), so a tab with no glyph
  that is marked modified shows no dot at all. The library's own `TabDemoPanel`
  reproduces it: *Toggle Modified* on any tab but the glyph-bearing "Alpha" shows nothing.
- **Accessibility gap.** The modified state has no ARIA or other accessible exposure, so
  assistive technology cannot tell a dirty tab from a clean one.
- **Wrong docs.** These still describe the old trailing-the-label placement:
  `docs/reference/changelog/0.10.0.md:599-603`, `docs/components/TabButton.md:26-37`,
  `docs/layouts/Tab.md:107`, `docs/components/TabBar.md:64`, and the `MODIFIED_GLYPH`
  comment at `TabButton.ts:21`.

Recommended fix, as a 0.10.x patch: a trailing-dot fallback for glyph-less tabs, an
accessible cue for the modified state, and the doc corrections above. SQLAdmin impact: the
dot renders, because every SQLAdmin tab has a glyph, but dirty tabs get no screen-reader
cue until the patch ships. SQLAdmin does not work around it.

---

## 🐞🔎 `Dock` drops focus to `null` when the tiled area empties while a float still holds a panel (0.10.0)

Found wiring SQLAdmin's status-bar caret readout to the Dock's `"focus"` event. With one
query tab torn into a float and the tiled tabs then closed (tab menu *Close all*), the
Dock emits `focus(null)` although the float's panel is still open and on screen.
`recomputeFocusAfterClose` (`Dock.ts:1851`) only looks for a survivor in the region the
closed frame came from; when that region is empty it calls `setFocus(null)` even though
`_frames` is non-empty. Clicking into the float's editor afterwards does not repair it: the
float is already frontmost, so its window `"activate"` does not fire, and its tab is already
the active one. Focus comes back only on a click on the float's tab strip or a raise from
behind another window. Until then every app feature keyed on the focused panel is off — in
SQLAdmin the caret readout stays hidden while typing in the float, and the address bar and
the Query-menu export no longer follow it either. Reproduced live: tear a query tab into a
float, close all tiled tabs, click into the float's editor and type — the readout stays
hidden until the float's tab label is clicked. A fix would fall back to the frontmost float's
active panel when the closed frame's region is empty. SQLAdmin does not work around it.

---

## ✂️🔎 `Dock.on("beforeclose")` types a window close's controller as `TabCloseController` (0.10.0)

Found moving SQLAdmin's dirty-tab close guard onto the Dock-level `"beforeclose"` event.
`Dock.on("beforeclose")` (`Dock.ts:2275`) and the `DockOptions.listeners.beforeclose`
entry (`:108`) type the listener's controller as `TabCloseController`. But the Dock also
forwards a float window's chrome ✕ through the same event: `onFloatBeforeClose` (`:1730`)
passes the window's `WindowCloseController`, and `emit` (`:2365`) is typed
`TabCloseController | WindowCloseController`. The two interfaces have the same shape, so
the app compiles and `preventDefault()` works on either; the listener's declared type is
simply narrower than what it receives. A fix would type the parameter as
`TabCloseController | WindowCloseController`, or as one shared `CloseController`.

Related: a listener cannot tell a tab ✕ from a window ✕ by the payload, since `window`
names the float in both cases. SQLAdmin does not need to — it groups the events one
gesture raises by synchronous turn (`frontend/src/controller/closeRequestBatcher.ts`),
which also gives the tab menu's *Close all* rows one prompt — so this is noted, not
worked around.

---

## ✂️🔎 Unclosed-paren diagnostics land at the statement's failure point, not the paren (0.9.0)

Hit while manually verifying `sql-editor-live-linting`'s live diagnostics.
`SELECT count(* FROM t;` reports one "Missing input" diagnostic at the `;`
(offset 21), not after `count(` (offset 13) where the mistake actually is.
Confirmed this is unrelated to the dialect gap in the entry below: parsing the
same string with `@codemirror/lang-sql`'s `sql({ dialect: PostgreSQL })`
produces the identical error node at the identical offset as the library's
undialected default — the mislocation happens the same way under every
dialect, so choosing a PostgreSQL-aware `LanguageDefinition` would not fix it.

The parse tree explains why: `Script(Statement(Keyword,Keyword,Parens("(",
Operator,Keyword,Identifier,⚠),";"))` — once `count(` opens a `Parens` node,
Lezer's LR grammar keeps absorbing whatever comes next (`FROM`, `t`) as long
as each token is locally consistent with still being inside an open
expression list, and only plants its single synthetic error token where it
truly cannot continue. That is standard LR error-recovery: the parser reports
the point of no return, not the root cause. `collectSyntaxErrors`
(`packages/lib/src/typescript/lib/component/editor/syntaxDiagnostics.ts`) has
no opinion here — it walks the tree Lezer already built and reports whatever
error nodes exist, verbatim, with no relocation heuristic. A narrow fix would
teach `collectSyntaxErrors` (or a wrapper around it) to walk back from an
error node to the nearest unmatched opening delimiter. A more thorough one —
which would also close the dialect gap in the entry below, since both stem
from the same root cause (a generic-SQL grammar standing in for real
PostgreSQL) — is swapping the `"sql"` `LanguageDefinition`'s `loadLintSource`
for one backed by a `libpg_query` binding (`libpg-query` or `pgsql-parser` on
npm), which wraps Postgres's actual C parser via WASM and so reports real
Postgres error text and positions instead of Lezer's best-effort recovery.
That parser is batch, not incremental, but re-parsing one SQL statement on
the existing 750ms lint debounce is cheap enough that this is unlikely to
matter. It would only replace what feeds diagnostics — Lezer's own grammar
would stay in place for syntax highlighting, folding, and completion, which
`libpg_query` doesn't provide. Either fix is general parser tooling, not
something specific to this app. Left open rather than worked around.

---

## ✂️🔎 `CodeEditor`'s built-in `"sql"` language lints against generic SQL, not PostgreSQL (0.9.0)

Hit while wiring `CodeEditor`'s new `lint` option into the query editor and the
view/matview definition editor (`sql-editor-live-linting`). The library's `"sql"`
`LanguageDefinition` calls `@codemirror/lang-sql`'s `sql()` with no dialect
argument, which defaults to `StandardSQL`. Three constructs PostgreSQL accepts are
reported as parse errors under that dialect but parse clean under the same
package's `PostgreSQL` dialect:

- `@>` — `SELECT * FROM t WHERE c @> '{}'::jsonb;` → 1 error (`Unexpected input`)
  under `StandardSQL`, 0 under `PostgreSQL`.
- `<@` — `SELECT * FROM t WHERE c <@ '{}'::jsonb;` → 1 error under `StandardSQL`,
  0 under `PostgreSQL`.
- Dollar quoting — `CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ BEGIN RETURN
  1; END; $$ LANGUAGE plpgsql;` → 2 errors under `StandardSQL`, 0 under
  `PostgreSQL`; the tagged form (`$function$ … $function$`) → 4 errors under
  `StandardSQL`, 0 under `PostgreSQL`.

The dollar-quoted case is why `FunctionDefinitionPanel`'s definition tab and
`SqlPreviewDialog`'s CREATE FUNCTION preview both keep `lint` off:
`pg_get_functiondef` always returns a dollar-quoted body and
`backend/app/sql/ddl.py`'s `create_routine` always generates one, so either
surface would show a permanent false error on every open if lint were on. The
`@>`/`<@` case is a lesser, content-dependent false positive the query editor and
the view/matview definition editor accept, since both are otherwise legitimate
free-form SQL authoring surfaces. Left open rather than worked around — see
`plans/implemented/sql-editor-live-linting.md`'s `## Architecture Decisions` for
why registering a PostgreSQL-dialect `LanguageDefinition` inside sqladmin was
rejected. See the entry above for a candidate fix (a `libpg_query`-backed
`loadLintSource`) that would close this dialect gap too, not just the
mislocation issue it was written for.

---

## 🐞🔎 `ToolBar`'s roving-tabindex keydown handler steals arrow keys from a text child

Found running the `table-local-filter` plan's manual verification, case 12 (caret
keys inside the toolbar's new quick-search field — the first text input any
`ToolBar` in this app has ever hosted). Typing text into `TableWorkPanel`'s
quick-search `TextField`, then pressing ArrowLeft/ArrowRight to move the caret
within the field, instead moves toolbar roving focus to a neighbouring button —
the caret never moves. Repro (confirmed live): focus the quick-search field with
non-empty text, press ArrowLeft — focus jumps to the toolbar's last button
(Refresh); press ArrowRight from the field — focus jumps to the toolbar's first
button (Record view), wrapping around in both directions.

**Root cause confirmed by reading the library, not guessed.** `ToolBar`'s
constructor registers a *subtree* keydown listener
([`ToolBar.ts:165-179`](../typescript-ui/packages/lib/src/typescript/lib/component/menubar/ToolBar.ts#L165))
via `Event.addSubtreeListener(this, "keydown", this._onKeyDown)` — subtree, so it
fires for a keydown anywhere inside the bar, including inside a child
`TextField`'s native `<input>`. The handler unconditionally calls
`e.preventDefault()` and moves the roving-tabindex focus whenever `e.key` is
`ArrowLeft`/`ArrowRight` (horizontal orientation) or `ArrowUp`/`ArrowDown`
(vertical) — it never checks whether the event's target is itself a text-entry
control that wants those keys for caret movement instead of toolbar navigation.

**Not worked around in the app.** Per the `table-local-filter` plan's "Potential
Challenges", the fix belongs in the library (skip the roving-focus move when the
keydown's target is inside a text-entry control), not an app-side
`stopPropagation` on the quick-search field — that would just mask the same
defect for every future toolbar text child.

**Verify:** put a `TextField` inside a `ToolBar`, focus it with non-empty text
and the caret mid-string, press ArrowLeft/ArrowRight: the caret must move;
today, toolbar roving focus moves instead and the caret stays put.

---

## 🐞🔎 `Markdown` renders a trailing link-reference-definition block as literal text

Found manually verifying the new Changelog dialog (the `changelog-dialog` plan)
against the real `CHANGELOG.md`, whose bottom carries a standard
[reference-style link](https://spec.commonmark.org/0.31.2/#link-reference-definitions)
block:

```markdown
## [0.4.0] — 2026-08-04
...
[0.4.0]: https://github.com/jimka/sqladmin/releases/tag/v0.4.0
[0.3.0]: https://github.com/jimka/sqladmin/releases/tag/v0.3.0
```

The heading's `[0.4.0]` **does** render as a working link to the GitHub release
tag — `marked`'s lexer resolves the reference correctly for that purpose. But
the trailing `[0.4.0]: https://…` definition lines themselves also render, as a
plain paragraph of literal source text at the very end of the document, instead
of being consumed silently the way every CommonMark-compliant renderer treats a
link-reference definition. Reproduced in a live browser: with the dialog
scrolled to the bottom, the last visible content is the raw four lines
`[0.4.0]: https://github.com/jimka/sqladmin/releases/tag/v0.4.0 [0.3.0]: …`
etc., run together with no blank lines between them (their own blank-line
separators were part of what got "consumed").

**Root cause confirmed by reading the library, not guessed.**
[`Markdown.appendBlockToken`](../typescript-ui/packages/lib/src/typescript/lib/component/display/Markdown.ts#L1401)'s
switch only special-cases `heading`, `paragraph`, `list`, `blockquote`, `code`,
`table`, and `space` — there is no `case "def"` for marked's link-reference-definition
token type. Every other token type falls through to the `default` branch,
[`this.appendTextNode(parent, token.raw ?? "")`](../typescript-ui/packages/lib/src/typescript/lib/component/display/Markdown.ts#L1413),
which renders the token's raw source text as a plain visible text node — the
same catch-all the class doc comment describes as the deliberate "never a
crash, never markup" fallback for genuinely unsupported constructs (images, raw
HTML). A `def` token is different: `marked`'s lexer *does* fully resolve it
(the heading link above proves the reference data reaches the renderer), it is
only the definition's own leftover token in the block list that has nowhere to
go, so it prints instead of vanishing.

**Not worked around in the app.** Per the Changelog dialog's plan, the fix
belongs in the library (skip/ignore `def` tokens in `appendBlockToken`, mirroring
`case "space": break;`), not in a `changelogText.ts`-side Markdown pre-processing
step that strips reference definitions before handing the string to `Markdown` —
that would just be masking the same defect for every other `Markdown` consumer
who writes reference-style links.

**Verify:** render `# H\n\n[x]: https://example.com\n` (or any Markdown source
whose only reference-style link's definition trails un-referenced-elsewhere text)
through `Markdown` and check the rendered DOM for a paragraph containing the
literal `[x]: https://example.com` text.

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
