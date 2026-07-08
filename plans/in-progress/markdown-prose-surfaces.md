# Markdown Prose Surfaces — Implementation Plan

## Overview

Adopt typescript-ui's read-only [`Markdown`](https://github.com/jimka/typescript-ui) display component (`@jimka/typescript-ui/component/display`) for two authored-prose surfaces in the sqladmin frontend:

1. **About dialog** — replace the hand-built stack of `Text` lines in [frontend/src/shell/aboutDialog.ts:45](frontend/src/shell/aboutDialog.ts#L45) with a single authored `Markdown` string inside the existing padded, fixed-width `Dialog`.
2. **Start-page empty state** — add a "Getting started" `Markdown` blurb in [frontend/src/shell/StartPage.ts](frontend/src/shell/StartPage.ts) that renders **only** when the workspace is truly empty (no recent tables **and** no saved queries), above the existing interactive buttons, without touching any of the live action buttons/lists.

`Markdown(markdownString, options?)` is a callable class (`export { … MarkdownCallable as Markdown }` in the library) that lexes with `marked` and builds real DOM (no `innerHTML`). It self-sizes its **height** at the width its parent assigns and reports that height as a *minimum*, so it drops straight into a vertically-scrolling `Panel`. It owns a theme-change listener that must be released via `dispose()` before the component is removed from a page that rebuilds. The confirmed export is `Markdown` (value + instance type) from `dist/lib/types/component/display/Markdown.d.ts:39`.

This plan uses **only** the read-only viewer. It must not introduce or touch `MarkdownEditor` (a separate parallel plan owns the editable documentation panel).

---

## Architecture Decisions

### Reuse the existing Dialog wrapper and sizing — swap only the content children

The About `Dialog` already fixes width to `DIALOG_WIDTH = 460` and sizes its height to the wrapped content measured at that width ([aboutDialog.ts:16-19](frontend/src/shell/aboutDialog.ts#L16), [:63-69](frontend/src/shell/aboutDialog.ts#L63)). Keep the `Panel` + `VBox({ stretching: true })` + `Insets(CONTENT_PAD…)` wrapper unchanged; only replace its five `Text` children with one `Markdown` child. `stretching: true` gives the `Markdown` a concrete content width (460 − 2×16 = 428) to wrap and self-measure within, and the `Dialog` continues to measure the wrapped height exactly as before. No `Dialog` sizing code changes.

### Bold-label lines replace muted `Text`; secondary lines lose the grey tint

The current dialog greys the author/source/library lines with `MUTED_TEXT_COLOR`. `Markdown` renders prose in the theme's default foreground, so those lines render at normal weight/colour with **bold labels** (`**Author:**`) instead of a grey tint. This is an intentional, minor visual change — authored prose is the point of the component. The two bare GitHub URLs become real Markdown links (`[text](url)`), which `Markdown` renders as `<a target="_blank" rel="noopener noreferrer">` — an improvement over the previous non-clickable text.

### Preserve actual current About content — no version, no license

The live dialog shows: app name, one-sentence description, author, source URL, UI-library URL. There is **no version line and no license line** in the current code — do not invent them. The `Markdown` string reproduces exactly these five facts.

### Dispose the About `Markdown` when the dialog is dismissed

`Dialog(...).show()` returns `Promise<DialogResult>` that resolves on any dismissal (Close / Escape / backdrop / title-bar close — [Dialog.d.ts:74](../typescript-ui/dist/lib/types/overlay/Dialog.d.ts)). Chain `.then(() => md.dispose())` off `show()` so each open cleans up its theme listener, instead of the current fire-and-forget `void dialog.show()`. The dialog can be reopened many times per session, so leaking a listener per open is real.

### Start-page welcome is opt-in per rebuild and disposed on every rebuild

`StartPage.rebuild()` runs on `controller.onWorkspaceChanged` and starts with `page.removeAllComponents()` ([StartPage.ts:46-47](frontend/src/shell/StartPage.ts#L46)). `removeAllComponents()` detaches DOM but does **not** call `Markdown.dispose()`, so the transient welcome `Markdown` must be tracked in a closure variable and disposed at the **top** of `rebuild()` before `removeAllComponents()`. The block is created only when `controller.recentTables().length === 0 && controller.savedList().length === 0`, and inserted after the existing "SQL Admin" heading and before the "New Query" button, so all interactivity below it is untouched.

### The start-page welcome copy must not duplicate the "SQL Admin" H1 already on the page

The page already renders a bold "SQL Admin" heading at the top ([StartPage.ts:49](frontend/src/shell/StartPage.ts#L49)), which stays. The welcome `Markdown` therefore opens with a `##`-level "Getting started" heading and guidance — not another top-level app title — to avoid a stuttered heading.

### No host/layout change on StartPage — it already scrolls

The `page` `Panel` is already `VBox({ stretching: true })` with `overflow: "auto"` ([StartPage.ts:39-42](frontend/src/shell/StartPage.ts#L39)). `stretching` assigns the `Markdown` its content width; the `VBox` sums children's preferred heights (including the `Markdown`'s self-measured minimum) and the `Panel` scrolls when the total exceeds the viewport. No `setAutoScroll`/`overflow` change is needed — the existing scroll host already satisfies the component's sizing contract.

---

## Public API

No new exported symbols. Both files consume the existing `Markdown` callable:

```typescript
import { Markdown } from "@jimka/typescript-ui/component/display";
// value: Markdown(markdown?: string, options?: MarkdownOptions) => Markdown
// type:  Markdown  (instance type — usable in `let welcome: Markdown | null`)
```

`StartPage.ts` already imports `Glyph` from the same `@jimka/typescript-ui/component/display` bundle ([StartPage.ts:14](frontend/src/shell/StartPage.ts#L14)) — add `Markdown` to that import or a sibling import line.

---

## Ordered Implementation Steps

### About dialog — [frontend/src/shell/aboutDialog.ts](frontend/src/shell/aboutDialog.ts)

1. **Add the import.** Add `import { Markdown } from "@jimka/typescript-ui/component/display";`.
2. **Author the copy as a module constant.** Define an `ABOUT_MARKDOWN` string constant (near the existing size constants) with a JSDoc/comment noting it is the authored dialog body. Content (reproducing the current five facts exactly):

   ```
   # SQL Admin

   A browser-based PostgreSQL administration & query tool. Browse databases,
   schemas, tables and roles; run, explain and export SQL.

   **Author:** Jimmy Karlsson

   **Source:** [github.com/jimka/sqladmin](https://github.com/jimka/sqladmin)

   **UI library:** [github.com/jimka/typescript-ui](https://github.com/jimka/typescript-ui)
   ```
   (Write it as a single template literal with real `\n` line breaks. Blank lines between blocks are required so `marked` lexes separate paragraphs/heading.)
3. **Build the content.** In `openAboutDialog()`, keep the `Panel({ layoutManager: new VBox({ … stretching: true }), insets: new Insets(CONTENT_PAD, …) })` wrapper. Replace the five `content.addComponent(line(...))` calls with:
   ```typescript
   const md = Markdown(ABOUT_MARKDOWN);
   content.addComponent(md);
   ```
4. **Dispose on dismissal.** Replace `void dialog.show();` with `void dialog.show().then(() => md.dispose());`.
5. **Remove now-dead code.** Delete the `line()` helper ([:25-38](frontend/src/shell/aboutDialog.ts#L25)) and the `LINE_SPACING` constant if the single-child `VBox` no longer needs it (a lone child makes spacing a no-op — you may keep `VBox({ stretching: true })` with no `spacing`). Remove now-unused imports: `Text` (from `component/input`) and `MUTED_TEXT_COLOR` (from `../theme`). Keep `Panel`, `VBox`, `Insets`, `Dialog`, `DialogButtons`, `Component` only if still referenced — drop any that became unused (`Component` was only the `line()` return type; remove it if `line()` is gone).
6. **Update the file's top-of-file comment** ([:1-6](frontend/src/shell/aboutDialog.ts#L1)) to say the body is a single authored `Markdown` string rather than "a VBox of Text lines".
7. **Checkpoint:** `grep -n "line(\|Text\|MUTED_TEXT_COLOR" frontend/src/shell/aboutDialog.ts` — expect zero matches for the removed symbols.

### Start-page empty state — [frontend/src/shell/StartPage.ts](frontend/src/shell/StartPage.ts)

8. **Add `Markdown` to the display import** ([:14](frontend/src/shell/StartPage.ts#L14)): `import { Glyph, Markdown } from "@jimka/typescript-ui/component/display";`.
9. **Author the welcome copy as a module constant.** Add a `GETTING_STARTED_MARKDOWN` string constant with a comment. Suggested copy (does not repeat the "SQL Admin" H1 already on the page):
   ```
   ## Getting started

   Your workspace is empty. Open a new query or pick a table from the sidebar
   to begin — your **recent tables** and **saved queries** collect here as you
   work.

   - **New Query** — open a blank SQL editor
   - Click a table in the sidebar to inspect its structure and data
   - Save a query to pin it to this page
   ```
10. **Track the transient instance.** Inside `StartPage()`, before `rebuild` is defined, declare `let welcome: Markdown | null = null;`.
11. **Dispose at the top of `rebuild()`.** As the first statements of `rebuild()` (before `page.removeAllComponents()`):
    ```typescript
    if (welcome) {
        welcome.dispose();
        welcome = null;
    }
    ```
12. **Insert the block when empty.** After `page.addComponent(heading("SQL Admin", "600"));` ([:49](frontend/src/shell/StartPage.ts#L49)) and before the "New Query" `actionButton` ([:50](frontend/src/shell/StartPage.ts#L50)), add:
    ```typescript
    const isEmpty = controller.recentTables().length === 0 && controller.savedList().length === 0;

    if (isEmpty) {
        welcome = Markdown(GETTING_STARTED_MARKDOWN);
        page.addComponent(welcome);
    }
    ```
    Keep every existing line below unchanged (New Query button, `appendList` calls, Connection, Keyboard).
13. **Checkpoint:** confirm `appendList(...)` for "Recent tables"/"Saved queries" still no-ops on empty (it already returns early on `items.length === 0` — [:89](frontend/src/shell/StartPage.ts#L89)), so the empty state shows only the welcome block plus New Query/Connection/Keyboard, never empty section headers.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | [frontend/src/shell/aboutDialog.ts](frontend/src/shell/aboutDialog.ts) |
| Modify | [frontend/src/shell/StartPage.ts](frontend/src/shell/StartPage.ts) |

No new files, no deletions. typescript-ui is a `file:` symlink with the `component/display` bundle prebuilt and `marked` installed — no `npm install`.

---

## Expected Behaviour

All behaviours below are **manual-verify** — both surfaces are UI/geometry with no unit-test harness (there are no existing tests for `aboutDialog`/`StartPage`).

### About dialog
- Opening About shows a 460-px-wide dialog whose body is the authored prose: an "SQL Admin" heading, the description paragraph (wrapped, not hand-broken), and three labelled lines with **Source**/**UI library** as clickable links.
- The links open `github.com/jimka/sqladmin` and `github.com/jimka/typescript-ui` in a **new tab**.
- The dialog height still fits the content (no clipping, no excess whitespace) at width 460.
- Close / Escape / backdrop all dismiss; reopening and dismissing repeatedly does not accumulate theme listeners (the `.then(() => md.dispose())` fires on each dismissal).

### Start-page empty state
- With a fresh/empty workspace (no recent tables, no saved queries), the start page shows the "SQL Admin" heading, then the "Getting started" `Markdown` block (heading + paragraph + bullet list), then the "New Query" button, Connection, and Keyboard sections.
- After opening a table or saving a query (so `recentTables()` or `savedList()` is non-empty), `onWorkspaceChanged` fires, `rebuild()` disposes and drops the welcome block, and the Recent/Saved sections appear in its place. The welcome block never shows alongside populated lists.
- All interactive buttons remain functional (New Query, recent-table rows, saved-query rows) — the welcome block is inert display only and sits above them.
- The page scrolls vertically when the welcome block plus the rest exceeds the viewport (existing `overflow: "auto"`).

---

## Verification

- **Typecheck:** `cd frontend && npx tsc --noEmit` (or the project's `npm run typecheck` if defined) — expect no errors; confirms the removed imports in `aboutDialog.ts` leave no dangling references and `Markdown` resolves from the bundle.
- **Build:** `cd frontend && npm run build` (Vite) — expect success.
- **Grep invariants:**
  - `grep -n "line(\|MUTED_TEXT_COLOR\|from \"@jimka/typescript-ui/component/input\"" frontend/src/shell/aboutDialog.ts` — expect no matches (Text/muted usage fully removed).
  - `grep -n "Markdown" frontend/src/shell/StartPage.ts` — expect the import, the constant, the `let welcome`, dispose, and construction.
- **Manual smoke (run the frontend, e.g. `npm run dev`):**
  1. Open the About dialog from the far-right of the menu bar; verify layout, wrapping, links open in a new tab, and repeated open/close.
  2. Start with an empty workspace and confirm the "Getting started" block renders above New Query; open a table and confirm the block is replaced by the Recent tables list on rebuild.

---

## Potential Challenges

- **Markdown blank-line lexing.** `marked` needs a blank line between block elements; a template literal without blank lines collapses paragraphs/lists into one block. Author each constant with explicit blank lines (double `\n`).
- **`let welcome` typing.** `Markdown` is exported as *both* a callable value and an instance type, so `let welcome: Markdown | null = null;` type-annotates against the instance while `Markdown(...)` calls the value — no separate `InstanceType<...>` needed.
- **Dispose ordering on StartPage.** The dispose must run *before* `removeAllComponents()` each rebuild; placing it after would dispose an already-detached component and, more importantly, a rebuild that skips disposal leaks a listener each time the workspace toggles between empty and non-empty. Keep it the first block in `rebuild()`.
- **Unused-import lint after the About swap.** Removing `line()` orphans `Text`, `MUTED_TEXT_COLOR`, and possibly `Component`; delete them or the typecheck/lint fails on unused imports.

---

## Critical Files

- [frontend/src/shell/aboutDialog.ts](frontend/src/shell/aboutDialog.ts) — current `Dialog` + `Panel`/`VBox`/`Text` build and sizing constants to preserve.
- [frontend/src/shell/StartPage.ts](frontend/src/shell/StartPage.ts) — `rebuild()` flow, `appendList` empty-guard, `removeAllComponents()` rebuild seam, existing `component/display` import.
- [frontend/src/SqlAdminController.ts:620-638,699](frontend/src/SqlAdminController.ts) — `savedList()`, `recentTables()`, `onWorkspaceChanged()` used for the empty check and rebuild trigger.
- `typescript-ui` — `dist/lib/types/component/display/Markdown.d.ts` (callable class, `dispose()`, `setMarkdown`) and `docs/components/Markdown.md` (supported subset, sizing contract).

---

## Non-Goals

- **No `MarkdownEditor`.** This plan uses only the read-only viewer; the editable documentation panel is a separate parallel plan and must not be touched here.
- **No replacement of the whole StartPage with Markdown.** StartPage stays a live composed panel of interactive buttons; the `Markdown` block is an additive empty-state overlay only.
- **No new version/license content in the About dialog.** Only the five facts currently shown are reproduced.
- **No StartPage scroll-host or layout refactor.** The existing `VBox({ stretching: true })` + `overflow: "auto"` already satisfies the component's sizing contract.
