---
touches-shared:
  - frontend/src/controller/queryWorkspace.ts
  - frontend/COMPONENT_CONVENTIONS.md
---

# Documentation Panel Toolbar Adoption — Implementation Plan

## Overview

The Notes tab (Tools → Notes…) is a bare `MarkdownEditor` with no formatting controls. [`frontend/src/dock/DocumentationPanel.ts:28`](frontend/src/dock/DocumentationPanel.ts#L28) builds one editor, wraps it in a `Fit` host, seeds it from the per-connection notes store, reports each edit through an `onChange` callback, and focuses it once the Dock has laid it out.

The library grew the missing half. `MarkdownDocumentPanel` ([`packages/lib/src/typescript/lib/component/editor/MarkdownDocumentPanel.ts:165`](../../typescript-ui/packages/lib/src/typescript/lib/component/editor/MarkdownDocumentPanel.ts#L165)) is a `Container` that docks a glyph-only `ToolBar` NORTH and a `MarkdownEditor` CENTER, and delegates `getValue()` / `setValue()` / `markClean()` / the `"change"` event to that editor. It is the component `DocumentationPanel` would otherwise have to hand-build.

This plan rewrites `DocumentationPanel` as a subclass of `MarkdownDocumentPanel`, keeping its `(initial, onChange)` constructor and its focus-on-open behaviour, and updates its one call site — [`frontend/src/controller/queryWorkspace.ts:246`](frontend/src/controller/queryWorkspace.ts#L246). No other app file changes. The work is gated on a local library rebuild: `MarkdownDocumentPanel` ships in the library's unreleased 0.9.0 batch and is **not** in the `dist/lib` the app currently imports.[^dist-missing]

---

## Architecture Decisions

### `DocumentationPanel` extends `MarkdownDocumentPanel`

`DocumentationPanel` becomes a class that `extends` the library's callable `MarkdownDocumentPanel` export and is itself re-exported through `callable()` — convention (a) plus (d) of [`frontend/COMPONENT_CONVENTIONS.md:25`](frontend/COMPONENT_CONVENTIONS.md#L25). Its whole body is a `super({ value: initial })` call, one `"change"` subscription, and one focus registration.

The precedent is [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts#L31): an app panel that `extends Panel`, wraps itself in `callable()`, and is handed to the Dock as tab content directly. `DocumentationPanel` is the same shape with a more specific base.[^why-extends]

### The `Fit` host and the `content` field are deleted

The instance *is* the tab's content. `DocumentationPanel` stops owning a `content: Container`; the caller passes the instance itself to `Dock.addPanel`, exactly as [`frontend/src/controller/ddlLaunchers.ts:532`](frontend/src/controller/ddlLaunchers.ts#L532) already does for `DdlFormPanel`.

| | Today | After |
|---|---|---|
| `DocumentationPanel.ts` | `readonly content: Container` wrapping a `MarkdownEditor` in a `Fit` | no `content` field; the class *is* the component |
| `queryWorkspace.ts:246` | `const panel = new DocumentationPanel(…)` | unchanged |
| `queryWorkspace.ts:253` | `content: panel.content` | `content: panel` |

### The app adds no layout of its own

`MarkdownDocumentPanel` sets its own `Border` layout and docks the toolbar NORTH and the editor CENTER in its constructor ([`MarkdownDocumentPanel.ts:198-207`](../../typescript-ui/packages/lib/src/typescript/lib/component/editor/MarkdownDocumentPanel.ts#L198)). `DocumentationPanel` calls neither `setLayoutManager` nor `addComponent`.

This is the same "toolbar NORTH, content CENTER" arrangement [`DefinitionPanel.ts:95-97`](frontend/src/dock/DefinitionPanel.ts#L95) builds by hand around [`definitionEditor.ts:85`](frontend/src/dock/definitionEditor.ts#L85)'s `ToolBar`. Here the library owns it, so the app builds none of it.[^layout-owned]

### Focus stays on the owned editor, reached through `getEditor()`

The constructor keeps `editor.onFirstLayout(() => editor.focus())`, with `editor` now being `this.getEditor()` rather than a local the panel built. `onFirstLayout` is a `Component` method that fires after *that component's* first connected layout, so nesting the editor one level deeper changes nothing about when that callback runs.[^onfirstlayout]

A toolbar above the editor does not compete for that focus: [`QueryPanel.ts:1265`](frontend/src/dock/QueryPanel.ts#L1265) already focuses its `CodeEditor` this way from under a full NORTH toolbar.

### Nothing is disposed by hand

`DocumentationPanel` gets no `dispose`, no `destructor()` override, and no teardown wiring. Closing the tab destroys the panel, and that destroy recurses into every registered child — here the `ToolBar` and the `MarkdownEditor` that `MarkdownDocumentPanel`'s constructor added. This is the rule [`plans/implemented/adopt-dock-owned-teardown.md`](plans/implemented/adopt-dock-owned-teardown.md) established for every panel in `dock/`; inserting `MarkdownDocumentPanel` between the panel and the editor adds one more link to a chain the recursion already walks.[^disposal]

### The pinned library range stays at `^0.8.0`

`frontend/package.json` is not edited. The app builds against the symlinked local library checkout, and the range bump is release work, owned by [`release-steps.md`](release-steps.md).[^no-bump]

---

## Public API

```ts
// frontend/src/dock/DocumentationPanel.ts
class DocumentationPanel extends MarkdownDocumentPanel {
    constructor(initial: string, onChange: (markdown: string) => void);
}

const DocumentationPanelCallable = callable(DocumentationPanel);
type DocumentationPanelCallable = DocumentationPanel;
export { DocumentationPanelCallable as DocumentationPanel };
```

The constructor parameters are unchanged. The `readonly content: Container` field is **removed**; the instance is the mountable component. Everything `MarkdownDocumentPanel` exposes — `getValue()`, `setValue()`, `markClean()`, `getEditor()`, `getToolbar()`, `on("change", …)` — is inherited and re-exposed unchanged.

---

## Internal Structure

The whole new class body:

```ts
class DocumentationPanel extends MarkdownDocumentPanel {
    constructor(initial: string, onChange: (markdown: string) => void) {
        super({ value: initial });

        this.on("change", ({ value }) => onChange(value));

        const editor = this.getEditor();

        editor.onFirstLayout(() => editor.focus());
    }
}
```

Convention (b) ([`COMPONENT_CONVENTIONS.md:52`](frontend/COMPONENT_CONVENTIONS.md#L52)) requires child widgets to be built as locals *before* `super()` whenever `super()`'s own options bag reads them. Nothing needs hoisting here: this constructor builds no child widget, and `{ value: initial }` reads only a parameter.

---

## Ordered Implementation Steps

Steps 1–3 are setup and are a hard gate: nothing below step 3 compiles until step 3's check passes.

1. **Symlink the worktree's frontend dependencies.** From the implementation worktree's root:
   `ln -s /home/jika/typescript/sqladmin/frontend/node_modules frontend/node_modules`.
   Check: `ls -ld frontend/node_modules` shows a symlink. Skip if it already exists.

2. **Confirm the library override is in place.** `readlink -e frontend/node_modules/@jimka/typescript-ui` must print `/home/jika/typescript/typescript-ui/packages/lib`. If it prints anything else (or nothing), repoint it:
   `rm -rf frontend/node_modules/@jimka/typescript-ui && ln -s /home/jika/typescript/typescript-ui/packages/lib frontend/node_modules/@jimka/typescript-ui`.
   The target is absolute on purpose — a relative one resolves differently from a worktree.

3. **Rebuild the library.** In `/home/jika/typescript/typescript-ui`, run `npm run build:lib` — **not** `npm run build`.
   Checks, both required before continuing:
   - `ls frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/editor/MarkdownDocumentPanel.d.ts` — the file exists.
   - `grep -rl MarkdownDocumentPanel frontend/node_modules/@jimka/typescript-ui/dist/lib/` — at least one hit, `component/editor.es.js` among them.

4. **Rewrite `frontend/src/dock/DocumentationPanel.ts`.**
   - Replace the imports with `callable` from `@jimka/typescript-ui/core` and `MarkdownDocumentPanel` from `@jimka/typescript-ui/component/editor`. The `Container`, `Fit`, and `MarkdownEditor` imports all go.
   - Replace the exported class with the unexported `class DocumentationPanel extends MarkdownDocumentPanel` from `## Internal Structure`, plus the three-line `callable()` export block from `## Public API`.
   - Rewrite the module header comment. Keep the sentences placing this panel among the app's other editors (it is still the app's only Markdown editor; `DefinitionPanel`'s SQL editor is still editable; `IndexInfoPanel` and `QueryPanel`'s Explain viewer are still the read-only ones). Replace the "class-first composition wrapper … owns `content` alone" sentence with: the panel extends the library's `MarkdownDocumentPanel`, which owns the toolbar and the editor and lays them out itself, so the Dock's teardown on tab close reaches both with no disposal of this class's own.
   - Keep the constructor JSDoc's `@param initial` / `@param onChange` text as-is, and keep the comment explaining why focus is deferred to first layout.

5. **Update the call site in `frontend/src/controller/queryWorkspace.ts`.** At [line 253](frontend/src/controller/queryWorkspace.ts#L253), change `content: panel.content` to `content: panel`. Leave line 246's `new DocumentationPanel(…)` alone — a variable binding takes `new` under convention (d) ([`COMPONENT_CONVENTIONS.md:168`](frontend/COMPONENT_CONVENTIONS.md#L168)).
   Do **not** touch line 147, which is `QueryPanel`'s own `panel.content` and still correct.

6. **Update `frontend/COMPONENT_CONVENTIONS.md`'s section (f).** In the closing paragraph at [lines 244-250](frontend/COMPONENT_CONVENTIONS.md#L244):
   - Drop `DocumentationPanel` from the list of panels the composition fallback covers, since it is now an `extends` class.
   - Fix the stale path `plans/in-progress/adopt-dock-owned-teardown.md` → `plans/implemented/adopt-dock-owned-teardown.md`. That directory does not exist; the file moved when the plan shipped.

7. **Grep checks.** All four run from `frontend/`:
   - `grep -n '^import' src/dock/DocumentationPanel.ts` — exactly two lines: `callable` from `@jimka/typescript-ui/core`, `MarkdownDocumentPanel` from `@jimka/typescript-ui/component/editor`.
   - `grep -n 'readonly content\|this.content\|new Fit\|new MarkdownEditor' src/dock/DocumentationPanel.ts` — zero hits.
   - `grep -n 'panel.content' src/controller/queryWorkspace.ts` — exactly one hit, line 147 (`QueryPanel`'s).
   - `grep -rn 'DocumentationPanel' src/ | grep -v 'src/dock/DocumentationPanel.ts'` — exactly two hits: the import at `queryWorkspace.ts:19` and the construction at `queryWorkspace.ts:246`.

8. **Typecheck and test.** `cd frontend && npm run typecheck && npm test` — both clean. `notesStore.test.ts` is untouched and must still pass.

9. **Build.** `cd frontend && npm run build` — clean.

10. **Manual smoke.** Drive the app per `.claude/skills/verify/SKILL.md` and walk `## Expected Behaviour`. Restart the dev server rather than only clearing `.vite` if the toolbar does not appear — a rebuilt library can be served from a stale in-memory dependency snapshot.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/DocumentationPanel.ts` |
| Modify | `frontend/src/controller/queryWorkspace.ts` |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |

---

## Expected Behaviour

Every case below is **manual**. The frontend's vitest runs in the node environment with no DOM ([`frontend/vitest.config.ts`](frontend/vitest.config.ts)), so no panel behaviour is unit-testable; the only automated coverage in this area is `notesStore.test.ts`, which this plan does not touch.

1. **Toolbar appears.** Tools → Notes… opens a tab showing a glyph-only toolbar above the editor: five format toggles, a Link button, Insert and Table dropdowns, Text style / Alignment / Columns dropdowns, and an "Edit Markdown source" toggle at the far right.
2. **Seeding is unchanged.** A connection with saved notes opens with that Markdown rendered in the editor; a connection with none opens empty.
3. **Focus lands in the editor, not the toolbar.** Typing immediately after the tab opens inserts text into the document.
4. **Editing still persists.** Typing fires `onChange` → `NotesStore.save`. Reloading the page and reopening Notes shows the text.
5. **A toolbar edit persists too.** Selecting a word and clicking Bold bolds it, presses the Bold button, and saves — reload and reopen shows `**word**` rendered bold.
6. **Context-sensitive buttons.** Link is disabled with no selection and outside a link; Table is disabled unless the caret is inside a table.
7. **Source toggle.** "Edit Markdown source" switches the editor to raw Markdown and back, and the round-tripped text still saves.
8. **Singleton tab.** Invoking Tools → Notes… again focuses the open tab instead of opening a second — unchanged.
9. **Close and reopen.** Closing the Notes tab and reopening it rebuilds the panel and re-seeds from the store, with no console error from the teardown.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — the existing suite green, `notesStore.test.ts` included.
- `cd frontend && npm run build` — clean.
- The four greps in step 7.
- The two library-build checks in step 3.
- Manual: the nine cases in `## Expected Behaviour`, on the Notes tab reached through Tools → Notes….

---

## Documentation Impact

Outside `plans/`, `frontend/COMPONENT_CONVENTIONS.md` is the only doc that names `DocumentationPanel`; step 6 covers it. `CHANGELOG.md` is written at release time, not per feature ([`release-steps.md`](release-steps.md)), so this plan adds no entry. `README.md`, `LIBRARY_NOTES.md`, and `TODO.md` do not mention the Notes panel.

The plans under `plans/implemented/` that describe `DocumentationPanel`'s earlier shapes are historical records of shipped work and are left as they are.

---

## Potential Challenges

- **The library build is the gate.** The `dist/lib` the app imports today has no `MarkdownDocumentPanel`, so without step 3 the import fails at typecheck even though the name is present in the library's source and barrel. Run step 3's two checks before writing any code.
- **A stale Vite dependency snapshot.** After a mid-session library rebuild the dev server can keep serving the previous bundle, showing an editor with no toolbar. Restart the dev server; clearing `frontend/node_modules/.vite` alone is not always enough.
- **A 5px gap between toolbar and editor.** `Border`'s default component spacing is 5px, and `MarkdownDocumentPanel` constructs `new Border()` with no override — where `DefinitionPanel` and `DdlFormPanel` pass `spacing: 0`. If the gap reads wrong beside the app's other toolbars, that is a library-side default to change in the typescript-ui repo, not something to patch from the app.
- **The manifest reads `^0.8.0` while the code needs 0.9.0.** Expected until the library releases; see the `## Non-Goals` bullet.

---

## Critical Files

- [`frontend/src/dock/DocumentationPanel.ts`](frontend/src/dock/DocumentationPanel.ts) — the file being rewritten; its header comment carries the current disposal story.
- [`../../typescript-ui/packages/lib/src/typescript/lib/component/editor/MarkdownDocumentPanel.ts`](../../typescript-ui/packages/lib/src/typescript/lib/component/editor/MarkdownDocumentPanel.ts) — the new base class: constructor at :195, the `Border`/NORTH/CENTER wiring at :198-207, `getEditor()` at :538, the `"change"` re-emit at :559, the `callable()` export at :589.
- [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts#L31) — the precedent this plan mirrors: an app panel that `extends` a library base, wraps itself in `callable()`, and is mounted as tab content directly.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — sections (a), (b), (d), and (f); section (f)'s closing paragraph is edited.
- [`frontend/src/controller/queryWorkspace.ts:239-254`](frontend/src/controller/queryWorkspace.ts#L239) — `openDocumentation`, the only call site.
- [`frontend/src/dock/QueryPanel.ts:1258-1268`](frontend/src/dock/QueryPanel.ts#L1258) — focus-on-first-layout under a NORTH toolbar, the pattern the Notes panel keeps.
- [`.claude/skills/verify/SKILL.md`](.claude/skills/verify/SKILL.md) — the *Library changes* section, source of steps 2 and 3.

---

## Non-Goals

- **Bumping `@jimka/typescript-ui` past `^0.8.0`.** The range moves when the library releases 0.9.0, as part of the release checklist in `release-steps.md`, not as part of this feature.
- **Any change in the typescript-ui repo.** `MarkdownDocumentPanel` already exists there; this plan only builds and consumes it.
- **Tuning the toolbar for the Notes use case** — hiding entries, reordering groups, reaching into `getToolbar()`, or overriding the panel's `Border` spacing. The library defaults ship as they are; a defect in them is a library fix.
- **A dirty indicator or explicit Save for Notes.** Persistence stays keystroke-driven through `onChange`; `markClean()` and `isDirty()` are inherited but unused.
- **Unit tests for the panel.** The test harness has no DOM; `## Expected Behaviour` is manual by construction.

---

## Implementation Notes

**Steps 1–3's gate was already satisfied by the time this worktree started — no symlink or library rebuild was needed.** The plan's setup steps assume `frontend/node_modules/@jimka/typescript-ui` is a symlink into a local `typescript-ui` checkout that still needs `npm run build:lib`. By the time this plan was implemented, `frontend/node_modules` in this worktree was instead a symlink back to the main tree's `frontend/node_modules`, which holds a real `npm`-installed `@jimka/typescript-ui@0.9.0` — confirmed via `readlink -e frontend/node_modules/@jimka/typescript-ui` (resolves inside `node_modules`, not into a sibling checkout) and its `package.json`'s `"version": "0.9.0"`. Step 3's two checks both passed unchanged against this install: the `MarkdownDocumentPanel.d.ts` file exists under `dist/lib/types/component/editor/`, and `component/editor.es.js` already contains `MarkdownDocumentPanel`. Steps 1–3 were skipped as no-ops rather than performed.

**The pinned range is `^0.9.0`, not the `^0.8.0` this plan's Architecture Decisions and Non-Goals describe.** `frontend/package.json` already declared `"@jimka/typescript-ui": "^0.9.0"` before this worktree branched — `git log -p -1 -- frontend/package.json` shows the range moved from `^0.8.0` to `^0.9.0` in a "Bump sqladmin to 0.9.0 and typescript-ui to ^0.9.0" commit on the base branch, made to align the app with the just-released library version the four plans in this batch (including this one) depend on. That commit predates this plan's own work; this plan neither made nor needed to make that bump, so its "range stays at `^0.8.0`" decision and its "bumping past `^0.8.0`" non-goal are both mooted by history rather than contradicted by anything this plan did.

**One of step 7's four grep checks reports one hit more than the plan predicts, harmlessly.** The last check — `grep -rn 'DocumentationPanel' src/ | grep -v 'src/dock/DocumentationPanel.ts'` — was predicted to return exactly two hits (the import and the construction in `queryWorkspace.ts`) but returns three: `queryWorkspace.ts:235`, a pre-existing JSDoc line reading "a WYSIWYG DocumentationPanel seeded from and persisting to the …" on the `openDocumentation` method, untouched by this plan and already present before it. The check's intent — confirm no import or construction site exists outside the one call site this plan updates — still holds; the miscount is the plan's check missing an incidental prose mention, not a functional gap.

**Step 10's manual smoke was walked against a dev server serving this worktree** (Postgres and the backend were already running; `npm run dev` was started from `frontend/` here). All nine `## Expected Behaviour` cases pass: the toolbar renders with the five format toggles, Link, Insert/Table dropdowns, Text style/Alignment/Columns dropdowns, and the "Edit Markdown source" toggle; seeding starts empty for this connection; focus lands in the editor immediately (typing inserted text with no extra click, both on first open and after a reload); a keystroke edit and a toolbar-driven Bold both persisted through `onChange`/`NotesStore.save` and survived a full page reload; Link/Table stay disabled with no selection/outside a table and Link enables on a selection; the Markdown-source toggle round-tripped `**hello world**` back to the same bold rendering; invoking Tools → Notes… while the tab was open focused it rather than opening a second; and closing then reopening the tab rebuilt the panel and re-seeded from the store with no console error. The test note was cleared from the store afterward.

---

## Notes

[^dist-missing]: Verified, not inferred from the changelog: `frontend/node_modules/@jimka/typescript-ui` is a symlink to `/home/jika/typescript/typescript-ui/packages/lib`, and on 2026-09-07 `grep -rln MarkdownDocumentPanel packages/lib/dist/lib` in that checkout returned nothing, while the source and the barrel (`component/editor/index.ts:15`) both export it. The library's built output lags its source, and `npm run build:lib` is what closes the gap. The published 0.8.0 tarball does not contain the component either — it is documented in the unreleased `packages/lib/docs/reference/changelog/0.9.0.md`.

[^why-extends]: The competing shape is the one the file has today: a composition wrapper owning a `content` field, kept as a plain class. `frontend/COMPONENT_CONVENTIONS.md:201` makes composition a *fallback* from `extends`, used "only when the super-cascade hoist genuinely doesn't pay for itself" — a constructor with one `super()` call and two statements is the cheapest hoist available. `plans/implemented/class-first-lifecycle-panels.md` chose composition for this file for one stated reason: all four lifecycle panels flowed through the controller's single `_panelDisposers` disposal path, and mixing shapes across that set bought nothing. That path no longer exists — `plans/implemented/adopt-dock-owned-teardown.md` deleted `frontend/src/dock/panelDisposers.ts` and the `_panelDisposers` field outright (`grep -rn _panelDisposers frontend/src` finds nothing), so the uniformity argument has expired with it. The conventions doc also says to convert a module when you are already touching it for another reason (`COMPONENT_CONVENTIONS.md:9`), which is exactly this edit. A third option — deleting `DocumentationPanel.ts` and constructing `MarkdownDocumentPanel` in `queryWorkspace.openDocumentation` with an inline `onChange` adapter — was rejected: it moves UI wiring out of `dock/` and into a controller collaborator whose stated job is workspace state, and it leaves the focus-on-open behaviour homeless. `DefinitionPanel` keeps its own class for the same reason even though `definitionEditor.ts` does most of its work.

[^layout-owned]: `MarkdownDocumentPanel`'s constructor calls `this.setLayoutManager(new Border())` and then `super.addComponent(toolbar, { placement: Placement.NORTH })` / `super.addComponent(editor, { placement: Placement.CENTER })`. A `Border` gives its NORTH region the child's preferred height and hands the rest to CENTER, so the editor absorbs whatever the tab has left after the toolbar row — the same arithmetic `DefinitionPanel` gets from its own hand-built `Border`. The `Fit` host the app used to supply existed only to give a lone editor a container; with the library component supplying its own layout, a second wrapper would add a level of nesting that does nothing.

[^onfirstlayout]: `Component.onFirstLayout` queues a callback and drains it the first time *that component* lays out while connected to the document (`core/Component.ts:7014`, and `runFirstLayoutCallbacks` below it, which returns early while the element is missing or detached). It is explicitly documented as waiting for this component specifically, so it is safe to register before the host mounts it — which is why the current code can register on an editor the Dock has not yet mounted. Depth of nesting is irrelevant to that condition: an editor two levels under the tab content lays out connected at the same moment one level under it does. The glyph registrations the toolbar needs are likewise not the app's problem — `MarkdownDocumentPanel.ts:41` calls `Glyph.register(...)` at module scope, so importing the class is enough, unlike the app's own toolbars which register their glyphs by hand.

[^disposal]: `MarkdownDocumentPanel` adds both children through `super.addComponent`, so they are registered children in the sense `Component.destructor()`'s recursion uses, and it registers its own `"change"` listener bag through `registerListenerBag`, which the same teardown clears. `MarkdownEditor` has a `destructor()` of its own (`MarkdownEditor.ts:2237`) that disposes its context menu and then calls `super.destructor()`. So the chain from the closed tab to the editor's teardown is unbroken, and the app needs no `dispose` field, no `destructor()` override, and no registry entry. The `QueryPanelContent` exception described in `COMPONENT_CONVENTIONS.md` section (f) does not apply: nothing in this panel is detached from the tree while hidden.

[^no-bump]: `^0.8.0` resolves to `>=0.8.0 <0.9.0`, so the release carrying `MarkdownDocumentPanel` will *not* satisfy the current range and a bump is genuinely required — later, not here. `release-steps.md`'s *Update version string* section owns it: "If a new `@jimka/typescript-ui` version is being picked up in this release, also bump its version in frontend/package.json's dependencies." Folding a dependency bump into feature work is what that split exists to prevent. The interim mismatch — a manifest naming a range the working build is ahead of — is the same state `plans/implemented/adopt-dock-owned-teardown.md` ran its phase 1 in, and `plans/implemented/align-with-library-post-0.4.1.md` shipped in outright.
