# Library notes (`@jimka/typescript-ui`)

SQLAdmin is a demo app that doubles as a real-world test of the widget library.
This file logs every **bug** and **usage papercut** hit while building it, so the
library can be made more straightforward later. Newest entries first.

Status legend: 🐞 bug · ✂️ papercut/friction · ✅ fixed in library · 🩹 worked around in app · 🔎 open

---

## ✂️✅ Tree exposed no way to observe or read back its expanded set

Persisting which nodes are expanded in the Database and Roles rail trees
(plan `tree-expand-state-persistence`) needed to read a tree's current
expanded set at save time and to await a lazy node's expansion during
restore. `Tree` tracked expansion in a private `_expandedNodes` set with no
public getter, its `TreeEvent` union carried no expand/collapse member, and
`expandNode(node)` returned `this` with no way to know when a lazy node's
`loadChildren` had resolved.

Fixed in the library: `Tree` gained `getExpandedNodes()`, `expandNodeAsync()`
(resolving once a lazy node's children have loaded and the expansion has
committed), and `"expand"`/`"collapse"` `TreeEvent` members firing after an
expansion or collapse commits. Adopted here: `TreeExpansionPersistence`
(`data/treeExpansion.ts`) reads `getExpandedNodes()` to build the saved path
set and awaits `expandNodeAsync()` while walking a saved path back open;
`NavigatorTree` and `RolesTree` each wire its `save` hook to `"expand"` and
`"collapse"`.

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

## 🐞✅ `SqlPreviewDialog`'s failed-execute retry crashes — `Dialog` now owns its content's teardown too (app bug, exposed by 0.4.1, symlinked)

Found manually verifying `align-with-library-post-0.4.1`'s Change 2 "failed Execute, followed by retry"
bullet — pre-existing code, **not** touched by that plan's diff (only `resizer.fit = () =>
dialog.resizeToContent();` was added nearby; the crashing line itself,
[`SqlPreviewDialog.ts:213`](frontend/src/dock/SqlPreviewDialog.ts#L213)'s
`dialog.getContentComponent().removeComponent(content);`, is original `ddl-infrastructure.md` code).

Repro: "Create table" on `wide`, name it `cols_10` (already exists), Execute. The expected
`relation "cols_10" already exists"` error notification appears — but the dialog does **not** re-show for
a retry; it simply vanishes. Console shows an unhandled rejection:

```
Uncaught (in promise)
  at resolve (DOM.ts:239) → apply (DOM.ts:1474) → set (ElementAttributes.ts:51)
  → setElementAttribute (Component.ts:1457) → setDataAttribute (Component.ts:1749)
  → getLayoutManager (Component.ts:5334) → delLayoutConstraints (Component.ts:5294)
  → unwireChild (Component.ts:4980) → removeComponent (Component.ts:5171)
  → showExecuteRetryLoop (SqlPreviewDialog.ts:213)
```

**Root cause confirmed by reading the library, not guessed.** `Component.destructor()`
([`Component.ts:762`](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L762)) recursively
destroys every registered child (`for (const child of this._components) { child.destructor(); }`) — the
same owned-teardown mechanism this app already adapted `Dock`/`Tab.closeEntry` to via
`adopt-dock-owned-teardown` (see the top-of-file `Closing a table tab strands...` entry's resolution).
`Dialog.destructor()` ([`Dialog.ts:1173`](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L1173))
calls `super.destructor()`, so **`dialog.hide()` now destroys the dialog's entire content subtree** —
`_contentContainer` and, since `SqlPreviewDialog` added it as a child, the persistent `content` Panel
(form + "Regenerate SQL" button + `editor`) along with it. `hide()`'s `finalize()`
([`Dialog.ts:1119`](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dialog.ts#L1119)) calls
`this.destructor()` *before* resolving the `show()` promise, so by the time `showExecuteRetryLoop`'s
`await dialog.show()` returns after a Cancel/close/Execute-failure, `content` — and `editor` inside it — are
already disposed. The catch block's `dialog.getContentComponent().removeComponent(content)` then operates
on an already-torn-down parent and child, hitting a released DOM handle deep in `Component`'s attribute
plumbing.

**This is `Dialog` working as designed, not a library defect** — mirrors the same owned-teardown contract
`Dock` already carries, and is presumably intentional/consistent library behaviour, unlike the `CodeEditor`
entry above. The bug is **app-side**: `SqlPreviewDialog.ts`'s whole "detach the persistent content from the
spent dialog and re-wrap it in a fresh one" retry design (see the file's own header comment,
"`Dialog.hide()` destructs the Dialog instance on every dismissal, so a retry cannot re-show the same
instance — it detaches the persistent content... so the form's and the editor's own state... survive
across retries") was true when written but is now **false**: the content does not survive `hide()` to be
detached at all. `FilterDialog` has no equivalent retry path to have already surfaced this against (Apply/
Clear/Cancel don't retry), so `SqlPreviewDialog` appears to be the only place in the app this contract
change actually breaks.

**Confirmed no data corruption** — the `CREATE TABLE` correctly failed server-side before the crash (`wide.cols_10`
unchanged); this is a pure UI-teardown/retry-flow bug, but it means **every DDL phase's Execute-failure retry
is currently non-functional**: any invalid SQL, permission error, or name conflict on Execute silently
drops the dialog instead of letting the user fix and retry, which is the dialog's whole documented purpose.

**Not fixed here** — out of `align-with-library-post-0.4.1`'s scope (its two changes are `NavigatorTree`
and `SqlPreviewDialog`'s *sizing*, not its retry lifecycle; this bug predates and is orthogonal to both).
Fixing it properly needs a real redesign — e.g. rebuilding the form + editor content fresh on each retry
instead of reusing the disposed instance, mirroring how `adopt-dock-owned-teardown` handled the same class
of problem for Dock tabs — which belongs in its own plan, not a mid-implementation patch.

**Fixed here** (`sqlpreviewdialog-retry-content-teardown-fix.md`) — the fix is app-side, entirely in
`frontend/src/dock/SqlPreviewDialog.ts`: a `RetainedContentDialog` subclass detaches `content` from the
base class's owned teardown one step earlier than the code above tried to — inside its own `destructor()`
override, before `super.destructor()` runs, rather than after `dialog.show()` resolves. Since `content` is
now detached from every dialog it wraps instead of being disposed as a side effect of `hide()`,
`runSqlPreviewDialog`'s `finally` block disposes `content` itself, once, on every exit path — nothing else
disposes it now that the detach happens before teardown can reach it. The repro, root-cause analysis, and
console trace above remain accurate history of the bug as found.

---

## 🐞🔎 `CodeEditor.autoHeightMaxRows` can collapse the editor to 0px on a shrink (0.4.1, symlinked)

Found while manually verifying `align-with-library-post-0.4.1`'s `SqlPreviewDialog` adoption of
`autoHeightMaxRows` (the entry below this one) — not a defect in the app's own wiring, which matches the
plan's `## Internal Structure` exactly. **Reproduced twice, cleanly, via the ordinary "Create table" DDL
dialog with no scripted shortcuts beyond driving the same UI a real user would:**

1. Open "Create table", name it, add one column (`id integer`), click "Regenerate SQL" — editor renders
   3 lines at a real, correct **68px**.
2. Click "Add column", fill a second column (`col_1 text`), click "Regenerate SQL" — editor **grows**
   correctly to 4 lines at **87.375px**. Growth works.
3. Click that second column's "Remove column", click "Regenerate SQL" again — back to the exact same
   3-line SQL text as step 1. The editor's committed height is now **0px** (`style="...height: 0px"` on the
   `.CodeEditor` element), even though `.cm-scroller.scrollHeight` correctly reports **68px** of real
   content a full second later. The editor is completely invisible — not merely undersized — while its
   underlying CodeMirror document is intact and correct (confirmed: executing the dialog at this point
   creates the table exactly as the 3-line SQL specifies, so this is a pure layout/height bug, not a data
   bug).

**Ruled out: the app's own `resizer.fit()` call is not the trigger.** `SqlPreviewDialog`'s
`"heightchange"` listener calls `editor.clearPreferredSize()` then `resizer.fit()` (→
`dialog.resizeToContent()`) synchronously, mirroring `FilterDialog`'s precedent. Suspecting this
synchronous call might be re-entering `CodeEditor`'s own `geometryChanged`-driven `syncAutoHeight()` mid-
measurement (plausible, since `resizeToContent()` changes the very box `syncAutoHeight` measures), the
call was temporarily deferred via `queueMicrotask(() => resizer.fit())` and the repro re-run from a fresh
page load. **Identical result — height still collapses to 0px on the same shrink.** Since the collapse
still happens even when the app's resize call cannot execute until after the current synchronous work (and
any microtask queue ahead of it) has drained, the cause is not this app's call timing; it lives inside
`syncAutoHeight` itself (`CodeEditor.ts:835`) or the `EditorView.updateListener` that re-invokes it
(`CodeEditor.ts:696`, on `heightChanged || geometryChanged`) — plausibly a re-entrant cascade: `syncAutoHeight`'s
own `this.setHeight(desired)` commit is itself a geometry change CodeMirror's internal `ResizeObserver`-driven
measurement reacts to, re-invoking `syncAutoHeight` again on an *unchanged* shape, where only a **sub-pixel**
shrink is guarded against (`CodeEditor.ts:984`'s `previousHeight - desired < 1` check) — a chain of several
such re-entrant calls each shrinking by more than a pixel would not be caught by that guard and could walk the
height down past zero, entirely within the library's own update loop, with no app involvement. Not confirmed by
instrumenting the library directly (would need a `dist/lib` rebuild with temporary logging); this is the
leading hypothesis from reading `syncAutoHeight`'s source and its own extensive comments about the analogous
*growth* re-entrancy the method already guards against, not a certainty.

**Not fixed here** — out of this plan's scope (`## Non-Goals`: "Any library-side (`typescript-ui` repo)
change"), and there is no legitimate app-side workaround for a component-internal computation bug (per this
project's own "fix in library, not workaround" convention — a defensive minimum-height clamp in the app
would hide the symptom, not the cause, and every one of `SqlPreviewDialog`'s existing manual-verify bullets
for "no visible fixed-height box" / "grows or shrinks to fit content" is written against `autoHeightMaxRows`
behaving correctly, which a client-side clamp would only partially restore). **This is a real, user-facing
regression risk**: unlike the old fixed-180px box, which was always at least visible, a user who adds then
removes a column (or otherwise edits the form back to a shorter previous state) before executing can lose
all visual access to the SQL they are about to run. Needs its own library-side investigation before this
adoption should be considered fully safe for end users, even though the app-side wiring itself is correct
and complete per the plan.

---

## ✅ Fixed in library: no way to grow a `CodeEditor` to fit its content

`SqlPreviewDialog`'s DDL preview editor (`dock/SqlPreviewDialog.ts`) sat in a
fixed 180px box regardless of how much SQL `generateSql()` produced, so a
short preview left dead space and a long one deferred entirely to the
dialog's outer scroll. There was no way to ask a `CodeEditor` to size itself
to its own content, capped at a maximum.

Fixed in the library: `CodeEditor` gained an opt-in `autoHeightMaxRows`
option and a `"heightchange"` event fired whenever its measured height
changes. Adopted here (plan `align-with-library-post-0.4.1`): the editor is
capped at `SQL_PREVIEW_MAX_ROWS` (24, sized to this app's own `wide.cols_20`
DDL fixture), and its seed `preferredSize` is dropped via
`clearPreferredSize()` on the first `"heightchange"` so it stops fighting the
editor's own live height on later relayouts. The dialog re-fits itself on
every `"heightchange"` via a `resizer` object mirroring `FilterDialog`'s own
re-fit hook, rewired on every dialog rebuild so a failed-execute retry keeps
resizing correctly.

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

**Re-measured against 0.7.0 (symlinked, not yet released) — the reversing-sweep stall no longer reproduces.**
0.7.0 ships three changes squarely in the space this entry has been chasing: `table-column-window-rotation`'s fast
path ("horizontal scrolling now touches only the columns entering or leaving the visible window, instead of
re-deriving every rendered column's cell assignment on every tick"), `row-cell-cache` (a narrowed table caches
displaced cells instead of disposing/rebuilding them), and the CSS-hoisting work's own class-tier dedup, which
should shrink the shared stylesheet the DOMSize-scaling hypothesis implicated. Re-ran the identical
`wide.cols_60`, 1500×800, real-`WheelEvent`, direction-reversing protocol this entry's own numbers came from (a
fixed 16ms-paced dispatch cadence, not `requestAnimationFrame`-paced, for the same reason the
`smooth-scroller-confound` footnote above already ruled that pacing method out): a 4-leg/80-event burst measured a
worst single frame gap of **83 ms**, zero gaps over 100 ms; a harsher 6-leg/150-event burst run immediately after
on the same page (no reload, to probe the entry's own still-open "session accumulation" question, at least across
two back-to-back bursts rather than a single fresh one) measured a worst gap of **133 ms**, 7 frames over 100 ms,
zero over 500 ms — against the pre-fix baseline's 5–75 s wall-clock and gaps up to 14.5 s under the same protocol.
A Chrome performance trace taken during a third identical burst found `getComputedStyle` calls still at zero (the
already-fixed forced-reflow mechanism stays fixed) and, this time, **no `DOMSize` insight at all** — the insight
that dominated every prior post-forced-reflow-fix trace in this entry is simply absent; the only `ForcedReflow`
attribution left is the same already-known-negligible `getScrollLeft` cost this entry documented before (1,257 ms
across the whole ~11 s trace, Chrome's own "estimated savings: none").

**Not a full re-run of this entry's own protocol** — two escalating bursts back-to-back is not the "genuine
multi-minute session accumulation" the Status paragraph above says was never tested, so that specific question
is still technically open. But the mechanism this entry ultimately traced the stall to (style-recalculation cost
scaling with page size) no longer shows up in a trace at all under the same repro that reliably surfaced it
before, which is a materially different result from every earlier "still stalls, mechanism confirmed" update in
this entry. Worth a final confirmation pass against the tagged 0.7.0 release (not just the symlinked build) before
closing this entry outright.

**Correction to the above, same day: the "no `DOMSize` insight at all" result was a viewport-size false negative,
not a fix.** The prior re-measurement ran at this entry's original 1500×800 (~7,700–8,100 total DOM elements). Retried
at a maximized 5120×1932 window (this machine's real display, ~17,300–19,750 total elements depending on scroll
position — the same table renders far more columns and rows simultaneously) and the `DOMSize` insight **reappears**,
with the same signature as every pre-0.7.0 trace in this entry: 35 style-recalculation passes in one burst, 90–144 ms
each, each touching **12,462–14,094 of 19,752 total elements** — 63–71% of the entire page restyling per pass, the
same "essentially the whole page restyles on every recalculation, not just the handful of cells that actually
changed" shape this entry described at 0.4.1, scaled proportionally with the bigger DOM (pre-0.7.0 at the smaller
viewport: 5,470–6,038 of 9,318, 59–65%). `getComputedStyle` stayed at zero and `ForcedReflow` stayed
`getScrollLeft`-only (2,072 ms across the burst, "estimated savings: none") — unchanged from before. **So the
underlying mechanism is not fixed; 0.7.0 just moved the DOM-size threshold at which it becomes visible, and the
1500×800 test sat under that threshold.**

That said, **severity is genuinely, reproducibly better, not merely hidden.** Four runs of the identical 4-leg/
80-event reversing-`WheelEvent` burst at the maximized size (two horizontal, two vertical, same page, no reload)
never produced a gap anywhere near the pre-0.7.0 5–75 s stalls: worst horizontal frame gap across the four runs was
**433–533 ms** (one run barely crossed 500 ms once), average **91–95 ms**, with roughly **30% of frames over
100 ms** — real, user-noticeable jank on a big monitor, but bounded, not a multi-second freeze.

**The sharpest new lead: horizontal and vertical scrolling are not equally affected at the same DOM size, which
narrows the mechanism further than this entry ever managed to.** The identical burst protocol dispatched as
vertical (`deltaY`) scrolling instead, on the same page, same element count, same trace: worst frame gap
**150–167 ms**, average **27–31 ms**, only **~4% of frames over 100 ms** — three to four times smoother than
horizontal by every measure, with nothing to suggest row-scrolling's own cell-recycling path (`row-cell-cache`,
new in 0.7.0) triggers a comparable whole-page style recalc. Column-window reconciliation does something vertical
row-window reconciliation does not — plausibly a class-tier or shared-rule write on the column-window slide path
that invalidates a selector matched far outside the table (the same "read-all-then-write-all cannot fix it, a
render pass writes rules before it can read" shape the 0.4.0 entry above already worked through), where the row
path's equivalent write is scoped more narrowly. Not root-caused past this point — would need the same kind of
live `DOM.sink.setRuleStyles`/style-write instrumentation this entry used earlier, scoped to compare the two paths
directly, which no session has done yet.

**Status: revise "fixed" to "improved, mechanism unchanged, now better localized."** Worth a final pass against the
tagged 0.7.0 release, and the horizontal-vs-vertical asymmetry above is a concrete enough lead that the library's
own next investigation should start there rather than re-deriving DOM-size-scaling from scratch again.

**Re-measured against the local `column-window-edge-stability` fix (symlinked, not yet released) — real
improvement on both figures this entry's own 0.7.0 update named as the next lead, though the underlying
DOM-size-scaling mechanism is still not root-caused.** Same `wide.cols_60`, maximized (5120×1932, ~18,750 total
elements — in range of the prior entry's 19,750), same 4-leg/80-event direction-reversing `WheelEvent` burst
protocol (fixed 16ms-paced dispatch). A first instrumented pass (trace running) measured horizontal worst frame
gap **416.6 ms**, average **76.4 ms**, **26.6%** of frames over 100 ms — already inside the pre-fix range
(433–533 ms / 91–95 ms / ~30%), and its Chrome trace's `DOMSize` insight found only **one** style-recalculation
pass over the whole burst, 46 ms, touching **2,738 of 18,750 elements (14.6%)** — down sharply from the pre-fix
63–71%. A second pair of untraced runs (horizontal then vertical, same page, no reload) sharpened the picture:
horizontal worst **200.1 ms**, average **53.2 ms**, **18.3%** over 100 ms; vertical worst **116.7 ms**, average
**34.0 ms**, **0.9%** over 100 ms — horizontal has moved noticeably toward vertical's numbers, which is exactly
what this plan targeted, though a real gap between the two remains and an isolated anomalous vertical run (worst
350.1 ms) during the traced pass is a reminder this environment's numbers carry real run-to-run noise. Neither the
traced horizontal-2 nor the vertical run surfaced a `DOMSize` insight at all (below Chrome's significance
threshold), consistent with fewer/smaller whole-page restyle passes than before.

**Not independently re-verified live: the exact-pixel edge-flush and header/body-alignment claims in this plan's
own manual-verification checklist.** Synthetic `WheelEvent`/`PointerEvent` dispatch in this session could not be
made to reliably drive the custom horizontal scrollbar to its exact extremes (repeated large-magnitude bursts in
both directions left the rendered column window pinned at its already-computed edge window with no observed
change, and a simulated thumb drag had no effect at all) — likely a sign-convention or trusted-event mismatch
with `VirtualScroller`'s own gesture handling rather than a product defect, but not tracked down further here.
Relying instead on the plan's own unit coverage for those specific invariants (`Body.test.ts`'s
`firstCol`/`lastCol` bounds checks at extreme `scrollX`, and the geometry-after-slide cases), which all pass and
whose reasoning — every window slot still maps to a real column, so `bindAndPositionRows`'s existing accumulation
is unaffected — was not itself in question; only a fresh live pixel measurement of it is missing. Worth a repeat
attempt with real (non-synthetic) input if this entry gets picked up again.

**Re-measured against the combined `column-window-edge-stability` + `header-column-window-rotation` stack
(symlinked at `.worktrees/header-column-window-rotation`, `dist/lib` rebuilt fresh, not yet released), 2026-08-23 —
numbers moved the wrong direction from the edge-stability-alone entry above, though same-session vertical noise
makes a clean regression verdict unsafe.** Same `wide.cols_60`, maximized 5120×1932 (17,600–19,200 total elements
across runs, in range of prior maximized-viewport traces), same 4-leg/80-event direction-reversing `WheelEvent`
burst protocol (fixed 16ms-paced dispatch). First, a process pitfall that cost the first measurement attempt
entirely: this session's long-running dev server had survived several prior `dist/lib` rebuilds across earlier
work on this same stack, and a first traced run was still executing a stale `DOM-Cjh7_7TF.js`/`Component-D99-15Zt.js`
pair — confirmed by cross-checking the running module's resource URL against the freshly built `dist/lib`'s actual
chunk hashes, `DOM-Duqyqa3h.js`/`Component-CBqLXFCF.js` — despite the symlink and the rebuild both being correct.
That run's numbers (a 16–18 second dispatch for a nominally ~1.3 second burst) are discarded outright. Killing both
stray `vite` processes bound to :5173/:5174 and starting one fresh instance fixed it, confirmed by the served chunk
hashes matching the fresh build before re-measuring. Worth carrying forward: a symlinked-lib re-verify against a
dev server that has survived several rebuilds needs a server restart, not just a page reload, to be trusted.

**Untraced pair (horizontal then vertical, same page, no reload; run twice each for reproducibility, since this
entry's own baselines only had single-trial numbers to compare against).** Horizontal worst **216.7–250 ms**,
average **88.2–94.9 ms**, **32.7–34.6%** of frames over 100 ms. Vertical worst **150.0–166.7 ms**, average
**44.6–45.0 ms**, **4.6–5.0%** over 100 ms. Both axes reproduced tightly across their two trials.

**Traced runs ran substantially worse than untraced ones this session, and getting a usable `DOMSize` insight out
of one proved unexpectedly hard.** Five direct start-trace/dispatch/stop-trace attempts (worst gaps 300–433 ms,
averages 128–156 ms, 57–84% of frames over 100 ms — every one worse than either untraced trial) came back with
**no insights in any category**, despite the frame-gap numbers clearly showing a problem. Each trace's own reported
bounds spanned 16–18 seconds against a ~5 second dispatch-plus-settle window; the unaccounted ~12 seconds is almost
certainly dead time from this session's own tool-call round-trips between issuing `performance_start_trace`,
`evaluate_script`, and `performance_stop_trace`, which dilutes the burst's share of an otherwise-idle trace below
whatever threshold Chrome's insight engine uses to decide something is worth surfacing — a session-specific
measurement limitation, not evidence the mechanism is gone (the frame-gap numbers say otherwise). Worked around by
moving the whole burst into a page `initScript` that self-triggers ~2 s after `load`, combined with a trace started
before the reload — no manual round trip between trace-start and dispatch. That run did surface both insights.
`ForcedReflow` stayed negligible (**197 ms** total, only **17 ms** of it `getScrollLeft` — consistent with every
prior measurement in this entry). `DOMSize` did not: **171 ms touching 17,793 elements** (against this trace's own
17,621-element total — DOM size drifted slightly between snapshots, so read this as touching essentially the whole
page), **114 ms touching 12,853 elements**, and **106 ms touching 1,548 elements**, plus a separate **72 ms** layout
pass touching 21,584 of 22,844 total *nodes* (a node count that includes text nodes, so not directly comparable to
the element counts above, but the same story: nearly the whole tree). That is multiple passes touching roughly
**73–100%** of the page — much closer to the pre-fix baseline's 63–71% than to edge-stability-alone's single
14.6%-touched pass. This same run's frame gaps were the worst of the session (worst **1,583.3 ms**, average
**244.4 ms**, **78.8%** over 100 ms), but it ran immediately after a fresh reload, so some of that is plausibly
first-paint/cold-cache cost the other five, warm-page traced attempts didn't carry — and it is the only run mixing
page-load activity into the same trace as the burst, so its `DOMSize` figures are not as cleanly burst-only as the
isolated-page traces earlier in this entry.

**Against both baselines: worst-case single-frame gap stayed roughly bounded (the 1,583 ms cold-start run aside,
everything else sits in the same 200–430 ms band both prior measurements found), but every other metric drifted
back toward the pre-fix numbers rather than past edge-stability-alone's.** Untraced horizontal's average
(88.2–94.9 ms) sits almost exactly on the *original pre-fix* baseline's 91–95 ms, not edge-stability-alone's
53.2 ms; its 32.7–34.6% over 100 ms is if anything slightly above pre-fix's ~30%, not below edge-stability-alone's
18.3%. Vertical softened the same way relative to edge-stability-alone's own vertical run (worst 116.7 ms, average
34.0 ms, 0.9% over 100 ms) — this session's 150.0–166.7 ms / 44.6–45.0 ms / 4.6–5.0% land almost exactly on the
*pre-fix* vertical baseline instead. Because vertical scrolling isn't touched by either the edge-stability or
header-rotation fix, and it degraded by roughly the same proportion as horizontal did relative to the
edge-stability-alone entry, at least part of this is elevated session noise rather than something specific to the
header fix — the horizontal-vs-vertical asymmetry this entry has tracked throughout is still clearly present
(worst/average/percent-over-100ms all 2–5× higher on horizontal than vertical here, matching every prior
measurement). But the `DOMSize` insight's affected-element percentage reverting most of the way from
edge-stability-alone's 14.6% back up to ~73–100% is a larger, more specific shift than session noise alone
comfortably explains, and it is exactly the mechanism this entry has chased since 0.7.0. **Net: this session's data
does not show the header fix improving on edge-stability-alone, and on the `DOMSize` metric specifically it looks
worse — but with only one session's readings, elevated same-session noise on the unrelated vertical axis, and a
`DOMSize` sample that mixes page-load and burst activity, this is not strong enough evidence to call it a confirmed
regression either.** Needs a repeat pass in a fresh, dedicated session (clean dev server, no prior tracing attempts
against the same page) before concluding anything about the header fix's actual effect on top of edge-stability.

**The requested repeat pass, run clean (machine otherwise idle, fresh `vite` kill-and-restart per version, served
chunk hashes verified against each version's `dist/lib` before measuring), covering v0.6.0, v0.7.0, and the combined
stack side by side with the identical protocol.** `DOM-C-Edb3tA.js`/`Component-B0ShfPVi.js` for v0.6.0,
`DOM-Cjh7_7TF.js`/`Component-D99-15Zt.js` for v0.7.0, `DOM-Duqyqa3h.js`/`Component-CBqLXFCF.js` for the combined
stack — all confirmed served before any measurement in that version's block. Same `wide.cols_60`, maximized
5120×1932, same 4-leg/80-event direction-reversing `WheelEvent` burst (fixed 16ms-paced dispatch), untraced pair run
twice per axis, one traced horizontal run per version via a page `initScript` that self-triggers ~2s after `load`
(trace started before the reload, same workaround the noisy session used, and this time the trace bounds stayed
tight to the actual burst window for v0.7.0 and the combined stack — v0.6.0's trace ran needlessly long due to this
session's own wait-timing overhead, but the insight data came through fine regardless).

**v0.6.0, never before measured against this entry's current standardized protocol, cleanly reproduces the old
multi-second-stall era.** Horizontal: run 1 took **27.5 s** to dispatch a nominal ~1.3 s burst, worst gap
**1,666.5 ms**, average **254.8 ms**, **40.9%** of frames over 100 ms; run 2, **34.4 s** dispatch, worst
**1,700 ms**, average **298.4 ms**, **43.6%** over 100 ms. Vertical was unaffected both times: **~2.5 s** dispatch
(near-nominal), worst **133–150 ms**, average **~39.5 ms**, **2.6–5.3%** over 100 ms — the horizontal/vertical
asymmetry this entry has tracked since the 0.7.0 update is already present a full baseline earlier than this entry
had previously measured it.

**v0.7.0 reproduces its own prior entry closely, confirming that measurement was not a fluke.** Horizontal: worst
**400.1 ms** then **350 ms**, average **111.2–119.5 ms**, **36.8–39.5%** over 100 ms across the two runs — matching
the prior 0.7.0 update's 433–533 ms / 91–95 ms / ~30% band within normal session-to-session variation (this run's
worst gaps are a little better, its averages a little worse). Vertical: worst **150 ms** both times, average
**41.5–42.4 ms**, **4.2–4.4%** over 100 ms — matching the prior entry's 150–167 ms / 27–31 ms / ~4% almost exactly.

**`DOMSize` traces for v0.6.0 and v0.7.0 are close enough to be the same mechanism at the same scale — new, direct
confirmation of this entry's own "0.7.0 moved the threshold, didn't fix the mechanism" conclusion.** v0.6.0 (16,678
total elements): three style-recalculation passes at 102 ms/1,548 elements, 166 ms/16,924 elements (101% — DOM size
drifted slightly mid-trace), 124 ms/12,273 elements, plus a 49 ms layout pass touching 20,426 of 21,586 nodes. v0.7.0
(16,751 total elements): 104 ms/1,548 elements, 144 ms/16,923 elements, 101 ms/12,271 elements, 42 ms layout touching
20,444 of 21,695 nodes — the same three pass sizes to within a handful of elements. `ForcedReflow` stayed negligible
both times (200 ms and 185 ms total respectively, `getBorderWidths` at 8 ms in each — the poisoned-write mechanism
from 0.4.0 stays fixed in both).

**The combined stack's untraced frame-gap numbers are unambiguously clean this time and supersede the 2026-08-23
noisy session's untraced figures for this specific metric — on average and percent-over-100ms decisively, on
worst-gap more narrowly.** Horizontal: worst **183.4 ms** then **216.7 ms**, average **64.6–64.7 ms**,
**15.6–16.4%** over 100 ms; dispatch time itself dropped to **3.6–3.8 s** for the nominal 1.3 s burst, the fastest
dispatch of the three versions measured this session. Average and percent-over-100ms are roughly half the noisy
session's own untraced horizontal figures (average 88.2–94.9 ms, 32.7–34.6% over 100 ms). Worst-gap is more mixed,
worth stating precisely rather than rounding away: one run (183.4 ms) beats the noisy session's own best case
outright, the other (216.7 ms) ties its lower bound exactly — neither comes close to its 250 ms upper bound, but
it isn't a clean sweep on this one sub-metric. Vertical: worst **149.9–150 ms**, average **39.8–41.4 ms**,
**5.6–5.7%** over 100 ms — essentially identical to the noisy session's own vertical (150.0–166.7 ms / 44.6–45.0 ms
/ 4.6–5.0%), both still somewhat elevated versus `column-window-edge-stability`-alone's vertical baseline (116.7 ms
/ 34.0 ms / 0.9%). That reproduction matters: the noisy session guessed its elevated vertical numbers were "session
noise... rather than something specific to the header fix"; a clean session landing on nearly the same vertical
figures argues against one-off noise as the explanation, though vertical scrolling touches neither fix's code path,
so whatever is elevating it against the edge-stability-alone baseline is still unidentified and evidently not
merely bad luck in one session.

**But the `DOMSize` insight tells the opposite story on the combined stack, and this clean read confirms — rather
than refutes — the noisy session's specific worry there.** The combined stack's one traced horizontal run (17,621
total elements — matching the noisy session's own 17,621-element total exactly) found the same three-pass shape as
v0.6.0 and v0.7.0 above: 117 ms/1,548 elements, 148 ms/**17,793** elements, 112 ms/**12,853** elements, plus a 51 ms
layout pass touching 21,584 of 22,844 nodes. Those two bolded element counts, plus the 1,548 figure, match the
noisy session's own traced numbers exactly — 171 ms/17,793 elements, 114 ms/12,853 elements, 106 ms/1,548 elements
— down to the element count, even though the noisy session's read mixed page-load cost into the same trace and this
one did not. That is too precise a match to be coincidence: the combined stack genuinely still restyles essentially
the whole page (~101% of the DOM in the largest pass, drift included) on this burst, exactly like every
pre-`column-window-edge-stability` build in this entry, and unlike edge-stability-alone's own traced runs, which
found only a single 46 ms/14.6%-touched pass (or no `DOMSize` insight at all, twice). Whatever
`column-window-edge-stability` did to shrink the restyle scope, `header-column-window-rotation` on top of it does
not preserve — the DOM-size-scaling mechanism this entry has chased since 0.4.1 is unambiguously still present in
the combined stack, now confirmed rather than left as an open question. `ForcedReflow` stayed negligible here too
(239 ms total, `getBorderWidths` at 9 ms).

**Net picture, no longer noisy: the combined stack is the best build in this entry's history on wall-clock/frame-gap
terms, and simultaneously shows no improvement over the pre-fix `DOMSize` mechanism's scope.** Those two findings
coexist because the fix apparently works by touching fewer things *per wheel event* (the fast
column-window-edge-stability/header-rotation paths) rather than by shrinking what a style-recalculation pass touches
when one does fire — each pass still sweeps close to the whole page, but far fewer passes are needed to service the
same burst, and each one is fast enough (~100–150 ms here, versus the multi-second cascades this entry documented
pre-fix) that the net wall-clock effect is a large real win despite the underlying mechanism being untouched. One
more thing worth flagging plainly rather than smoothing over: every traced run in this session — all three
versions — measured substantially worse frame gaps than its own untraced pair (v0.6.0: 1,983.3 ms worst / 47.2% over
100 ms traced vs. 1,666.5–1,700 ms / 40.9–43.6% untraced; v0.7.0: 1,449.9 ms / 56.25% traced vs. 350–400.1 ms /
36.8–39.5% untraced; combined stack: 1,500 ms / 49.0% traced vs. 183.4–216.7 ms / 15.6–16.4% untraced) — confirming,
now across three separate builds instead of one, that Chrome's own trace recording adds real overhead to this
specific workload, and traced numbers should not be read as representative of unobserved scrolling.

**2026-08-23, a dedicated back-to-back same-session A/B between `column-window-edge-stability` alone and the
combined stack — filling the one gap the prior "clean" three-way session left open (it measured v0.6.0/v0.7.0/the
combined stack, never edge-stability-alone itself under the same method) — finds the `DOMSize`/average-gap
"regression" does not reproduce: it resolves to a measurement-methodology artifact, not a real cost from the header
fix.** Both builds freshly rebuilt (`npm run build:lib` in each worktree) immediately before measuring, dev server
killed and restarted between them, served chunk paths (`@fs/.../<worktree>/packages/lib/dist/lib/...`) confirmed
against each worktree before every run — `DOM-Duqyqa3h.js`/`Component-CBqLXFCF.js` came out byte-identical between
the two builds (their only difference is in `component/table.es.js`, 141,786 bytes for edge-stability-alone vs
144,211 bytes for the combined stack), so freshness here was verified by served *path*, not by a differing chunk
hash. Same `wide.cols_60`, maximized 5120×1932 (17,621 elements at trace time for both builds — identical), same
4-leg/80-event direction-reversing `WheelEvent` burst (60 px/event, fixed 16ms-paced dispatch — this session's own
re-derived delta, since no prior session's literal harness script was recoverable from history or from either
worktree's plan docs; internally consistent between the two builds, which is what an A/B needs regardless of
whether it matches an earlier session's absolute numbers).

**Untraced pair, horizontal then vertical, twice each, no reload.** Edge-stability-alone: horizontal worst
186.1/159.3 ms, average 45.1/55.8 ms, 10.4/11.2% over 100 ms; vertical worst 174.1/144.6 ms, average 34.4/32.9 ms,
1.8/1.8% over 100 ms. Combined stack: horizontal worst 236.8/165.3 ms, average 21.1/51.3 ms, 1.4/13.3% over 100 ms;
vertical worst 161.3/143.6 ms, average 33.1/33.1 ms, 3.5/0.9% over 100 ms. Every one of these eight figures overlaps
the other build's own two-run range on the matching axis/metric — there is no consistent direction of difference on
wall-clock/frame-gap terms, matching this entry's already-established pattern of substantial run-to-run noise at
this scale. Vertical in particular is close to indistinguishable between builds, as expected since neither fix
touches vertical scrolling.

**Traced horizontal run, one per build, via the page-`initScript`-self-triggers-2s-after-load technique (trace
started before the reload, no manual round trip between trigger and dispatch) — nearly identical on every figure.**
Edge-stability-alone: dispatch 5,002 ms, worst gap 603.8 ms, average 39.0 ms, 7.1% over 100 ms. Combined stack:
dispatch 4,988 ms, worst gap 611.1 ms, average 39.7 ms, 7.2% over 100 ms. `ForcedReflow` stayed negligible and
matched almost exactly both times (191 ms total for both builds; `getScrollLeft` 15 ms edge-stability-alone vs 7 ms
combined stack). **`DOMSize` — the metric this whole investigation turned on — came back essentially identical
between the two builds:** both traces show the same 17,621 total elements and the same three-pass shape
(edge-stability-alone: 106 ms/1,548 elements, 144 ms/17,793 elements, 118 ms/12,853 elements, plus a 102 ms layout
pass touching 21,584 of 22,844 nodes; combined stack: 109 ms/1,548 elements, 181 ms/17,793 elements, 113 ms/12,853
elements, plus a 70 ms layout pass touching the same 21,584 of 22,844 nodes) — the affected-element counts match to
the last digit across both builds.

**Verdict: the suspected regression does not reproduce.** Neither the `DOMSize` insight's affected-element share
nor the untraced average-frame-gap figure shows the combined stack doing worse than edge-stability-alone when both
are measured the identical way in the same session — they land on the same numbers, within the noise already
documented elsewhere in this entry. The prior comparison's edge-stability-alone figure (14.6% touched, one 46 ms
pass) was measured by a *different* tracing technique — direct start-trace/dispatch/stop-trace, from before this
entry's noisy header-rotation session discovered that technique dilutes a burst's signal below Chrome's insight
threshold and adopted the `initScript` workaround — while the combined-stack figure it was compared against (~101%
touched, three passes) was measured with the `initScript` technique from the start. That was an apples-to-oranges
methodology gap, not a same-method regression: this session's edge-stability-alone run, measured with the same
`initScript` technique the combined-stack figure always used, reproduces that build's own ~101%/three-pass shape
almost exactly, not the older 14.6%/single-pass figure. **Session noise and a methodology mismatch, not a real
header-fix cost — this time confirmed by a direct same-session, same-method comparison, not merely inferred from a
vertical-axis proxy.**

---

## 🐞✅ A numeric `fontSize` passed to `Text`'s constructor is silently ignored

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

Previously worked around in `AppHeader` by calling
`version.setFontSize(VERSION_FONT_SIZE)` after construction instead of passing
`fontSize` in the constructor options.

**Fixed in the library, 0.7.0.** The changelog's Fixed/Components entry
("A construction-time `fontSize`/`lineHeight` option on `Text` … was silently
ignored in the rendered CSS") matches this cause exactly, and also names
`PickerColumn`'s date/time column headers and `AbstractCalendarDropdown`'s
header cells as library-internal call sites that rendered at the wrong size
for the same reason. Adopted here: `AppHeader.ts`'s workaround is reverted —
`version` is now constructed with `{ fontSize: VERSION_FONT_SIZE }` directly,
verified against the symlinked 0.7.0 build.

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
