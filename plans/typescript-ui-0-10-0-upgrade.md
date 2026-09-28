---
touches-shared: [TODO.md, LIBRARY_NOTES.md, frontend/src/SqlAdminApp.ts, frontend/src/dock/SqlPreviewDialog.ts, frontend/src/controller/revealCoordinator.ts]
---

# typescript-ui 0.10.0 Upgrade — Implementation Plan

## Overview

Adopt `@jimka/typescript-ui` 0.10.0 in SQLAdmin. The work is developed and checked against the local 0.10.0 build, which `frontend/node_modules/@jimka/typescript-ui` already symlinks to. [`frontend/package.json:20`](frontend/package.json#L20) keeps naming `^0.9.0` for the whole plan. `npm run typecheck` and all 1023 vitest tests already pass against the symlink, so none of 0.10.0's removed APIs (`Event.init`, `BodyOptions.components`, `Slider.showTicks`, `WindowBorder.setDirection`) is called from this app.

One change is required. 0.10.0 made `Body.init` return `Promise<Body>` and removed the startup layout gate that used to hold the first layout until the web font was active. [`frontend/src/SqlAdminApp.ts:29`](frontend/src/SqlAdminApp.ts#L29) calls `Body.init` without awaiting it, so the login dialog, the shell and a deep-linked tab can now be measured against the browser's fallback font. Two cleanups follow from the release: [`frontend/src/shell/StartPage.ts:120-148`](frontend/src/shell/StartPage.ts#L120) replaces a hand-written dispose loop with `Component.disposeAllComponents()`, and about 40 source comments stop claiming that importing the library touches the DOM. The rest is bookkeeping in [`TODO.md`](TODO.md) and [`LIBRARY_NOTES.md`](LIBRARY_NOTES.md), one measurement, and a manual check of four behaviour changes the app gets for free.

No step installs, bumps a version, or commits a release. The swap to the published package is a separate follow-up the user runs by hand (see [Addendum: Post-release swap](#addendum-post-release-swap-run-by-hand)).

---

## Architecture Decisions

### `main()` awaits `Body.init` before anything else runs

`SqlAdminApp.ts`'s `main()` changes `Body.init(...)` to `const body = await Body.init(...)` as its first statement, before `whoami()`. The shell is then mounted with `body.addComponent(...)` instead of `Body.getInstance().addComponent(...)`. This mirrors the library's own entry points: [`typescript-ui/packages/docs/src/main.ts:10`](../typescript-ui/packages/docs/src/main.ts) and `packages/create-app/template/src/main.ts:6` both do `const body = await Body.init({ layoutManager: Fit() })` and then add their tree to `body`.[^await-first]

### `StartPage` calls `disposeAllComponents()`

The `rebuild` closure in `StartPage`'s constructor replaces its `for … dispose()` loop plus `removeAllComponents()` with one `this.disposeAllComponents()` call. The library method does exactly what the loop did: it disposes every child in `_components` and then calls `removeAllComponents()`.[^dispose-all-equiv] The app already uses it this way in [`dock/DatabaseDiagramPanel.ts:204`](frontend/src/dock/DatabaseDiagramPanel.ts#L204) (`rebuildLegend`) and [`dock/filteredDiagramShell.ts:186`](frontend/src/dock/filteredDiagramShell.ts#L186). The long comment above `rebuild` that promises "once it ships, replace the loop" is cut down to the part that is still true.

### Every pure-logic split stays; only its stated reason changes

0.10.0's changelog says "Importing the library no longer touches the DOM". A probe run while drafting this plan confirmed it: `StructurePanel`, `TableWorkPanel`, `StartPage`, `SqlAdminShell`, `JunctionDiagramView`, `TypeInfoPanel`, `PropertiesPanel` and `SequenceInfoPanel` all import cleanly under the node vitest.[^import-probe] About 40 comments still justify a split with the old reason ("the library touches `document` at import scope", "DOM-touching module-level side effects", "unreachable from the node vitest").

No split is undone. Each is rewritten to give one of three true reasons:

| Kind of module | New reason |
|---|---|
| Pure logic split out of a component module (`tableWriteRules.ts`, `structureRows.ts`, …) | The component module *constructs* library components, which needs a DOM. The split-out functions need none, so node vitest can test them. |
| A module with only `import type` from the library (`treeExpansion.ts`, `revealMatch.ts`, `menuItems.ts`, …) | It constructs no component and registers no glyph, so it runs under node vitest with no DOM. |
| A diagram data builder under `data/` | It imports only types from the library and nothing from a UI module (`navigator/`, `roles/`, `dock/`, `shell/`). It is a pure function of its inputs. |

References to the private memory note "tsui DOM module side effects" are removed. That note lives outside the repo, and it now records the opposite of what these comments cite it for. [Addendum: Comment sweep](#addendum-comment-sweep) lists every site and its replacement text.

### `buildSchemaDiagram.ts`'s header becomes the one place the builder rule is stated

The builder rule is: diagram builders import only types from the library and nothing from a UI module. Today about ten comments point at "buildSchemaDiagram.ts's header note" or "buildSchemaDiagram.ts:16-21" for it. Neither exists: the header is three lines with no such note, and lines 16-21 are ELK spacing comments. The rule is added to the header at [`data/buildSchemaDiagram.ts:1-3`](frontend/src/data/buildSchemaDiagram.ts#L1), and every pointer is rewritten to say "buildSchemaDiagram.ts's header".

### Glyph-name literals in the builders stay, with a layering reason

`TABLE_GLYPH` (in `buildSchemaDiagram.ts`, `buildDatabaseDiagram.ts`, `buildRoleGrantsDiagram.ts`), `ROLE_GLYPH` (in `buildRoleGrantsDiagram.ts`, `buildRoleMembershipDiagram.ts`) and `SCHEMA_GLYPH` (in `groupBySchema.ts`) keep their literal values. Their comments now say why they are not imported. `navigator/objectGlyphs.ts` and `roles/RolesTree.ts` are UI modules that call `Glyph.register` when imported, and a data builder imports no UI module. The "keep in sync" instruction stays.[^glyph-literals]

### `edgeRouteStubs.ts` keeps its `markerExtent` parameter

`stubGeometry(markerExtent)` and `stubBundledEdgeRoutes(…, geometry)` keep their signatures. `JunctionDiagramView.ts` keeps binding `STUB_GEOMETRY = stubGeometry(EDGE_MARKER_EXTENT)`. The comments stop saying the parameter exists because of import-scope DOM access. They now say it keeps the transform a pure function of its inputs, and that it lets `tests/data/edgeRouteStubs.test.ts` check coordinates against an extent it states itself (18).[^stub-param]

### The toast z-index comments name the library band

[`dock/ImportRowsDialog.ts:17-21`](frontend/src/dock/ImportRowsDialog.ts#L17) and [`dock/SqlPreviewDialog.ts:27-31`](frontend/src/dock/SqlPreviewDialog.ts#L27) say a toast's z-index is `10002`. 0.10.0 moved toasts to `LayerManager.Band.Notification` (10500). The comments now name both bands, `LayerManager.Band.Notification` (10500) and `LayerManager.Band.Dialog` (11000). The reasoning holds: a toast still sits below a modal dialog, so both in-content error banners stay.

### `CHANGELOG.md` is not edited here

[`release-steps.md:23-31`](release-steps.md#L23) writes the changelog at release time as a dated `## [X.Y.Z]` section. The file has no "Unreleased" section, and feature plans in this repo do not add one.[^changelog-at-release] This plan instead carries ready-to-paste release-note bullets in [Addendum: Release-note material](#addendum-release-note-material). The release-time pass reads `plans/implemented/*.md`, so it will find them there.

### One open `LIBRARY_NOTES.md` claim is measured before it is flipped

0.10.0 says "A `CodeEditor` no longer adds 51 CSS rules to the page for every editor". [`LIBRARY_NOTES.md:639-658`](LIBRARY_NOTES.md#L639) says every `new CodeEditor(…)` leaves `.ͼN` rules behind for good. These overlap, but they are not the same claim: the library fix covers the editor's *theme* modules, and the note counts all CodeMirror modules. So step 13 measures before the note changes. The outcome picks the edit:

| Rule count after 5 open/close cycles of a query tab | Edit |
|---|---|
| Cycles 2-5 each end at cycle 1's count (flat) | Append a "**Fixed in 0.10.0 — measured {date}.**" paragraph under line 658 with the numbers. It says the aggregate rule-count probe is reliable again for editor scenarios. |
| Still grows by *k* > 0 rules per cycle | Move lines 639-658 into a new `## ✂️🔎 Each CodeEditor still leaves {k} `.ͼN` rules on the page (0.10.0)` entry at the top of the file (newest first), and add the numbers to it. The paragraphs no longer sit under a ✅ heading (see step 12). |

---

## Public API

None. No exported symbol changes signature. `stubGeometry` and `stubBundledEdgeRoutes` are unchanged on purpose (see `### edgeRouteStubs.ts keeps its markerExtent parameter`).

---

## Implementation

`frontend/src/SqlAdminApp.ts`, lines 25-47 after the change (lines 1-24 and 49-61 are untouched):

```ts
(async function main(): Promise<void> {
    // Mount the Body FIRST (empty) and wait for it. The UI runtime — theme,
    // layout, and the overlay/layer manager a Dialog mounts into — must be up
    // before the login dialog is shown, or the dialog is created but never
    // renders. The promise resolves once the theme's web font is active (or
    // the library's bounded deadline passes), so the login dialog, the shell
    // and a deep-linked tab are all measured against the real face rather
    // than the browser's fallback.
    const body = await Body.init({ layoutManager: Fit(), favicon: APP_FAVICON });

    const session = (await whoami()) ?? (await showLoginDialog());

    // … unchanged: setCsrfToken, controller, router, setSyncAddressBar …

    // Now that we are authenticated, mount the shell into the Body mounted
    // above.
    body.addComponent(SqlAdminShell(controller));
```

`frontend/src/shell/StartPage.ts`, the comment and closure at lines 120-148 become:

```ts
        // The whole body is rebuilt each time the workspace toggles between
        // empty and non-empty (recent tables / saved queries need to stay
        // current). disposeAllComponents(), not removeAllComponents(): the
        // latter only detaches, which would leak the previous body's theme
        // listeners and per-instance stylesheet rules on every toggle. A
        // constructor-local closure captures `this` lexically, so passing
        // `rebuild` to `controller.workspace.onWorkspaceChanged` below is safe
        // without an arrow-function field.
        const rebuild = (): void => {
            this.disposeAllComponents();

            this.addComponent(buildColumns(controller));

            this.doLayout();
        };
```

---

## Ordered Implementation Steps

### Part A — setup

1. **Worktree install.** From the worktree root: `ln -s /home/jika/typescript/sqladmin/frontend/node_modules frontend/node_modules`. Then confirm the app will run the 0.10.0 build: `node -p "require('./frontend/node_modules/@jimka/typescript-ui/package.json').version"` → `0.10.0`. If it prints anything else, stop and report. Do not run `npm install`.[^symlink-target]

2. **Baseline.** `cd frontend && npm run typecheck && npm test`. Expect clean, with 1023 tests passing.

### Part B — code

3. **`frontend/src/SqlAdminApp.ts`** — apply the [Implementation](#implementation) snippet:
   - Replace the comment at lines 26-28 and the call at line 29 with the new comment and `const body = await Body.init(…)`.
   - Replace the comment at lines 45-46 and `Body.getInstance().addComponent(...)` at line 47 with the new comment and `body.addComponent(SqlAdminShell(controller));`.
   - Leave the `Body` import on line 13 as it is (`Body` is still used).

   Check: `grep -n 'getInstance' frontend/src/SqlAdminApp.ts` → zero matches.

4. **`frontend/src/shell/StartPage.ts`** — replace lines 120-148 (from `// The whole body is rebuilt…` through the closing `};` of `rebuild`) with the [Implementation](#implementation) snippet. Leave lines 150-151 (`onWorkspaceChanged(rebuild); rebuild();`) untouched.

   Check: `grep -n 'future disposeAllComponents\|removeAllComponents\|dispose-all-components' frontend/src/shell/StartPage.ts` → zero matches.

5. **Checkpoint.** `cd frontend && npm run typecheck && npm test`.

### Part C — comments

6. **Canonical builder note.** In [`frontend/src/data/buildSchemaDiagram.ts:1-3`](frontend/src/data/buildSchemaDiagram.ts#L1), append the canonical note to the header comment. The exact text is in [Addendum: Comment sweep](#addendum-comment-sweep), row C0.

7. **Comment sweep.** Apply every row of [Addendum: Comment sweep](#addendum-comment-sweep), in table order. Each row names a file, the line range to replace, and the replacement text. Change comment lines only. No code line in any listed file changes.

8. **Toast band comments.**
   - `frontend/src/dock/ImportRowsDialog.ts:18-21`: replace `a Notification's z-index (10002) sits below the Dialog band (11000, see LayerManager's Z_BAND_DIALOG)` with `a Notification's z-index (LayerManager.Band.Notification, 10500) sits below the Dialog band (LayerManager.Band.Dialog, 11000)`. Keep the rest of the sentence.
   - `frontend/src/dock/SqlPreviewDialog.ts:28-30`: make the same replacement.

   Check: `grep -rn '10002\|Z_BAND_DIALOG' frontend/src` → zero matches.

9. **Stale-reason check.** From the repo root:

   ```bash
   grep -rnE "at import scope|at module-load|module-level side effects|DOM side effects|UI-bundle|unimportable|unreachable from the node|tsui DOM module side effects|touching .document. (on import|and unloadable)|buildSchemaDiagram\.ts:16-21" frontend/src frontend/tests | grep -v 'shell/queryShortcuts.ts'
   ```

   Expect no output. `queryShortcuts.ts:118` is excluded because it describes its *own* module ("DOM refs live only inside this body"), which is still true.

10. **Checkpoint.** `cd frontend && npm run typecheck && npm test && npm run build`. All three must pass. Comment edits cannot break them, but the build proves the file set still compiles as one bundle.

### Part D — bookkeeping

11. **`TODO.md`.**
    - Delete the whole bullet at lines 71-72 ("**Large `MemoryStore.loadData` renders zero rows** …").
    - Replace the bullet at lines 9-12 with:

      ```markdown
      - **Result pagination for query panels / large views.** A query result
        loads into an in-memory `MemoryStore`, and the backend returns at most
        1,000 rows per request (`MAX_ROWS_PER_REQUEST`,
        `backend/app/operations/common.py:14`), with a "result truncated" note
        in the status bar. Paging past that cap would let a user browse a large
        result without rewriting the query with `LIMIT`/`OFFSET`.
      ```

    Check: `grep -n 'zero-render\|renders zero rows\|1500' TODO.md` → zero matches.[^memorystore-fixed]

12. **`LIBRARY_NOTES.md`, subtree-listener entry.**
    - Line 568: `## 🐞🔎 Closing any panel with a live subtree listener throws …` → `## 🐞✅ Closing any panel with a live subtree listener throws …`. Keep the rest of the heading unchanged.
    - Replace the "**Not yet released.**" paragraph at lines 634-637 with: `**Released in 0.5.0** (typescript-ui changelog \`0.5.0.md\`, "A component disposed synchronously by a handler running during an event's own dispatch …"), so every SQLAdmin build since 0.5.0 carries it.`[^subtree-shipped]

13. **Measure CodeMirror rule growth** (manual, in the browser). Bring the stack up per `.claude/skills/verify/SKILL.md` against the symlinked build, and log in. In the DevTools console, define:

    ```js
    const rules = () => [...document.styleSheets].reduce((n, s) => { try { return n + s.cssRules.length; } catch { return n; } }, 0);
    const cmRules = () => [...document.styleSheets].reduce((n, s) => { try { return n + [...s.cssRules].filter(r => (r.selectorText ?? '').includes('ͼ')).length; } catch { return n; } }, 0);
    ```

    Record `rules()` and `cmRules()` once before any query tab has been opened. Then run five cycles of: open a new query tab (Query → New Query), type `select 1`, close the tab, and record both counts. Apply the matching row of the routing table in `### One open LIBRARY_NOTES.md claim is measured before it is flipped`. Either edit records: the date, the before-first-open counts, all five per-cycle counts, and the 0.10.0 changelog line it tests.

### Part E — manual verification

14. Walk every table in [Expected Behaviour](#expected-behaviour) against the dev server (`npm run dev`), with the DevTools console open. Walk the 1,000-row case a second time against a built bundle (`cd frontend && npm run build && npx vite preview`; `preview` reuses `server.proxy`, so `/api` still reaches the backend on :8000). A failure is reported, not worked around. If a failure is in library behaviour, it gets a `LIBRARY_NOTES.md` entry at the top of the file (newest first) with a `🐞🔎` heading, following the existing entries' shape.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `frontend/src/SqlAdminApp.ts` (await `Body.init`; mount on the resolved `body`) |
| Modify | `frontend/src/shell/StartPage.ts` (`disposeAllComponents()`; comment) |
| Modify | `frontend/src/dock/ImportRowsDialog.ts` (toast band comment) |
| Modify | `frontend/src/dock/SqlPreviewDialog.ts` (toast band comment) |
| Modify | every file in [Addendum: Comment sweep](#addendum-comment-sweep) — comments only (42 source files, 6 test files) |
| Modify | `TODO.md` (delete the zero-render bullet; reword the pagination bullet) |
| Modify | `LIBRARY_NOTES.md` (subtree entry → ✅, release line; CodeMirror note per step 13) |

---

## Expected Behaviour

No new logic reaches a unit test. `SqlAdminApp.ts` runs only in a browser, and `StartPage` needs a DOM to construct. The existing 1023 tests must stay green unchanged. Everything below is manual-verify.

### Startup (the `Body.init` await)

| Case | How | Correct |
|---|---|---|
| Logged-out load | Sign out, reload | The login dialog renders in Manrope, not a serif/sans fallback. No `typescript-ui: text was measured before the startup font settled` warning in the console. |
| Logged-in reload | Reload while signed in | The shell appears with no visible re-flow after the first frame. Navigator rows are present. No early-measure warning. |
| Deep link | Load `/schema/public/table/customers` (any real table) while signed in | That table's tab opens directly, with no flash of the start page. |
| Deep link through login | Same URL while signed out, then sign in | The tab opens after sign-in. The URL survived the login round trip. |

### Start page rebuild

| Case | How | Correct |
|---|---|---|
| Empty → non-empty | Clear localStorage (Tools → Show localStorage… → Clear SQLAdmin data), reload, then open any table | The welcome list is replaced by a "Recent tables" list, with no console error. |
| Repeated toggles | Save and delete a query three times | The page updates each time. No console error, and no duplicated columns. |

### Query results at the worker threshold

This case exercised the bug 0.10.0 fixed: in a built 0.9.0 app, a `MemoryStore` of 1,000+ rows never rendered. The backend's 1,000-row cap hit that threshold exactly.

| Case | How | Correct (dev **and** `vite preview`) |
|---|---|---|
| Truncated result | Run `select g from generate_series(1, 1500) g` | The status bar reads `showing first 1000 rows — result truncated`. The grid shows rows 1… and scrolls to 1000. |
| Sort over the threshold | Click the `g` header twice | The rows reverse (1000 first). |
| Degradation warning | Console after both | No store-worker `console.warn`. If one appears, record it in `LIBRARY_NOTES.md`; it is not a failure of this plan. |

### The SQL review dialog opens with focus in the editor

0.10.0 counts a `contenteditable` element (CodeMirror's `.cm-content`) as focusable. `Dialog` focuses the first focusable element in its content. A review dialog whose content has no other focusable element therefore now opens with the caret in the SQL editor, instead of on the Execute button. This change is intended, and no code changes.

| Dialog | How to open | Correct |
|---|---|---|
| Create-object review (no form) | Navigator → right-click a schema → Create ▶ Table → fill a name → Review SQL… | The caret is in the SQL editor. Enter inserts a newline and does **not** execute. Tab reaches the buttons. Clicking Execute runs it. |
| Columns Save (summary-only form) | Table → Structure → edit a column → Save | Same as above. |
| Sequence Save | Sequence info tab → edit a field → Save | Same as above. |
| Enum or composite Save | Type info tab → edit → Save | Same as above. |
| Rename (real form) | Navigator → right-click a table → Rename | Unchanged: focus is in the name field. |

### Visual-only changes

| Change | Where | Correct |
|---|---|---|
| `MenuBar` is 29px tall (was 28) | Menu bar, and the trailing Shortcuts / Changelog / About buttons | No button glyph or label is clipped at the bottom edge. |
| `:focus-visible` rings | Tab through a dock toolbar with the keyboard | A ring shows on keyboard focus but not on mouse click. |
| One Tab stop per toolbar | Tab from a grid into a toolbar and on | One Tab enters the toolbar and the next leaves it. The arrow keys move between buttons. |

### Noted, not fixed here

- **Date cells are stricter.** The table's date-time cell editor now rejects a `T` separator, a `Z` or offset suffix, and fractional seconds. A bare `2026-09-01` typed into a `date` column reverts, because SQLAdmin models `date` as the library's `datetime` field type ([`frontend/src/data/buildModel.ts:14`](frontend/src/data/buildModel.ts#L14)). A separate plan, `date-time-column-field-types.md`, maps those types; this plan only records the behaviour in the release notes.

---

## Verification

| # | Where | Command / action | Expect |
|---|---|---|---|
| 1 | worktree | `node -p "require('./frontend/node_modules/@jimka/typescript-ui/package.json').version"` | `0.10.0` |
| 2 | `frontend` | `npm run typecheck` | clean |
| 3 | `frontend` | `npm test` | 1023 passing, same as the baseline |
| 4 | `frontend` | `npm run build` | succeeds |
| 5 | repo root | step 9's grep | no output |
| 6 | repo root | `grep -rn '10002\|Z_BAND_DIALOG' frontend/src` | no output |
| 7 | repo root | `grep -n 'getInstance' frontend/src/SqlAdminApp.ts` | no output |
| 8 | repo root | `grep -n 'zero-render\|renders zero rows' TODO.md` | no output |
| 9 | repo root | `grep -c '"@jimka/typescript-ui": "\^0.9.0"' frontend/package.json` | `1` (the range is untouched) |
| 10 | browser | step 13 and every table in [Expected Behaviour](#expected-behaviour) | walked, with numbers recorded |

---

## Potential Challenges

- **The symlink points somewhere else.** A worktree `node_modules` symlink can silently resolve to a different library build. Step 1's version check catches the wrong version. In the browser, confirm that a served `/node_modules/.vite/deps` or `@fs/…/typescript-ui/packages/lib/dist/lib/` chunk comes from the 0.10.0 tree.
- **A stale Vite dep cache.** After several library rebuilds, the dev server can serve an old dependency snapshot. Restart `npm run dev`; if diagrams render empty, also `rm -rf frontend/node_modules/.vite`.
- **Comment rows drift.** If a listed range no longer matches (another branch merged first), find the quoted stale phrase with `grep -n` and replace that sentence. Step 9's grep is the backstop.
- **`vite preview` cannot reach the API.** If `/api` 404s under preview, add `--port 4173` and confirm the backend listens on :8000. Do not edit `vite.config.ts`.

---

## Critical Files

- [`frontend/src/SqlAdminApp.ts`](frontend/src/SqlAdminApp.ts) — the bootstrap being changed.
- [`../typescript-ui/packages/docs/src/main.ts`](../typescript-ui/packages/docs/src/main.ts) — precedent for `await Body.init` followed by `body.addComponent`.
- `../typescript-ui/packages/lib/src/typescript/lib/core/Body.ts:89-146` — `Body.init`'s contract (sync option dispatch, then `await whenFontActivated()`).
- `../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts:7733-7752` — `disposeAllComponents`.
- [`frontend/src/dock/DatabaseDiagramPanel.ts:203-209`](frontend/src/dock/DatabaseDiagramPanel.ts#L203) — precedent for `disposeAllComponents()` in a rebuild.
- [`frontend/src/data/edgeRouteStubs.ts`](frontend/src/data/edgeRouteStubs.ts), [`frontend/src/dock/JunctionDiagramView.ts`](frontend/src/dock/JunctionDiagramView.ts), [`frontend/tests/data/edgeRouteStubs.test.ts`](frontend/tests/data/edgeRouteStubs.test.ts) — the injected-extent design whose comments change.
- `../typescript-ui/packages/lib/docs/reference/changelog/0.10.0.md` and `…/migration/0.10.0.md` — the source for every behaviour claim here.
- [`plans/implemented/typescript-ui-0-4-0-upgrade.md`](plans/implemented/typescript-ui-0-4-0-upgrade.md) — the precedent upgrade plan, for the verification-sweep shape.

---

## Non-Goals

- **The dependency swap and any version bump.** `frontend/package.json` stays `^0.9.0`, and the lockfile and `THIRD-PARTY-NOTICES.md` are untouched. The swap waits for the library release, which itself waits on this verification, so it cannot be a step here. See [Addendum: Post-release swap](#addendum-post-release-swap-run-by-hand).
- **`CHANGELOG.md`.** It is written at release time (see Architecture Decisions).
- **New features 0.10.0 makes possible.** These are covered by separate plans: the Dock `beforeclose` guard, a dirty-tab indicator, query error reveal, navigator targeted refresh, `SpatialNavigation`, a selection status readout, and date/time column mapping.
- **`resizeMode: 'outline'`.** The user decided not to adopt it.
- **Sourcing `TABLE_GLYPH` from `objectKinds.ts`**, as `buildRelationGraph.ts:12-17` does for its own map. That would remove a "keep in sync" literal, but it is a behaviour-neutral refactor that 0.10.0 does not cause.
- **`importPreviewRows.ts`'s row cap.** It is a deliberate bounded sample (the table-data-import plan's "Preview grid shows a bounded sample" decision), not a worker-threshold workaround.
- **Other open `LIBRARY_NOTES.md` entries.** None is fixed by 0.10.0.[^other-notes]

---

## Addendum: Comment sweep

Replace each range with the given text. The text is shown without leading `// `. Re-wrap it to the file's existing comment width (about 80 columns) with `// ` on each line, or ` * ` for the JSDoc rows. Line ranges are inclusive, as of `792e4ef`.

**C0 — canonical builder note.** Append a new paragraph to the header of `src/data/buildSchemaDiagram.ts` (after line 3, before the blank line at 4):

> Like every diagram builder under data/, this module imports only types from the library and nothing from a UI module (navigator/, roles/, dock/, shell/), so it stays a pure function of its inputs and unit-tests under the node vitest without a DOM. Anything that needs the DOM — text measurement, glyph registration — is injected by the caller (see controller/diagramPanels.ts's `Util.measureTextWidths`).

**Group 1 — logic split out of a component module.**

| # | File | Lines | Replacement text |
|---|---|---|---|
| 1 | `src/shell/startPageWelcome.ts` | 1-5 | The start page's empty-workspace gating logic, split out from StartPage.ts so node vitest can unit-test it: StartPage constructs library components, which need a DOM, and this function needs none. |
| 2 | `src/dock/quickSearchModel.ts` | 1-5 | TableWorkPanel's quick-search pure logic, split out so node vitest can unit-test it: TableWorkPanel constructs library components, which need a DOM, and this logic needs none (tableWriteRules.ts is the same split). |
| 3 | `src/dock/tableWriteRules.ts` | 1-5 | TableWorkPanel's write-gating pure logic, split out so node vitest can unit-test it: TableWorkPanel constructs library components, which need a DOM, and this logic needs none. |
| 4 | `src/dock/recordNavigation.ts` | 1-5 (through `— see vitest.config.ts).`) | The table work panel's pure record-lookup logic, split out so node vitest can unit-test it: TableWorkPanel constructs library components, which need a DOM, and this logic needs none. *(Keep line 5's "Mirrors tableWriteRules.ts, which exists for the same reason." and everything after it.)* |
| 5 | `src/dock/importPreviewRows.ts` | 1-6 | Pure preview-grid row-building logic for ImportRowsDialog.ts, split out so node vitest can unit-test it: the dialog constructs library components (Dialog, FileDropZone, Table, …), which need a DOM, and this logic needs none — the same split tableWriteRules.ts makes for TableWorkPanel.ts. |
| 6 | `src/dock/structureRows.ts` | 1-5 (through `touching the DOM).`) | The Structure tab's pure row mapping for the Constraints and Foreign Keys grids, kept out of StructurePanel.ts (which constructs library components and so needs a DOM) so node vitest can unit-test it. *(Keep "Both grids' `reload` need to …" onward.)* |
| 7 | `src/dock/typeInfoRows.ts` | 1-4 (through `touching the DOM).`) | The Type Info tab's pure row mapping, kept out of TypeInfoPanel.ts (which constructs library components and so needs a DOM) so node vitest can unit-test it. *(Keep "Mirrors structureRows.ts's shape …" onward.)* |
| 8 | `src/dock/columnSequence.ts` | 1-3 | Pure row mapping for the Columns grid, kept out of columnsGrid.ts (which constructs the Table) so node vitest can unit-test it without a DOM. |
| 9 | `src/dock/sequenceFormState.ts` | 1-4 (through `touching the DOM).`) | Pure helpers backing the sequence info form's seeding and dirty tracking, kept out of SequenceInfoPanel.ts (which constructs library components) so node vitest can unit-test them without a DOM. *(Keep "Distinct from `ddlSpecs.ts`'s …" onward.)* |
| 10 | `src/dock/diagramShellState.ts` | 4-9 | Kept out of diagramShell.ts (which constructs the actual controls — ComboBox, Checkbox, Panel — and so needs a DOM) so this state machine can be unit-tested under node vitest, mirroring depthChoices.ts's split and recordNavigation.ts's split out of TableWorkPanel.ts. |
| 11 | `src/dock/depthChoices.ts` | 3-7 | Kept out of diagramShell.ts (which constructs the Depth control and the rest of the shell's components, and so needs a DOM) so depthChoice/depthFromChoice can be unit-tested under node vitest, mirroring recordNavigation.ts's split. |

**Group 2 — modules with type-only library imports.**

| # | File | Lines | Replacement text |
|---|---|---|---|
| 12 | `src/data/loadSignal.ts` | 7-10 (from `Imports nothing at all`) | Imports nothing at all, so — like treeExpansion.ts beside it — it runs under node vitest with no DOM. |
| 13 | `src/data/treeExpansion.ts` | 2-6 (from `Its` through `vitest environment.`) | Its only imports are `import type`s — nothing else may be imported from the library — so it constructs no component and runs under node vitest with no DOM. *(Keep "Consumed by NavigatorTree/RolesTree; …" onward.)* |
| 14 | `src/properties/propertyRows.ts` | 1-7 | The Properties inspector's selection→rows mapping, split out of PropertiesPanel.ts so node vitest can unit-test it (see roles/roleBaseInfoRows.ts for the same split on the Roles side). Its only library-facing import is `import type { PropertyValueRow }`, so it constructs no Table or Panel and needs no DOM. |
| 15 | `src/shell/appStorageKeys.ts` | 9-11 (from `Its only import`) | Its only import is `PRESETS_KEY` (a plain string constant), so it runs under node vitest with no DOM. |
| 16 | `src/navigator/revealMatch.ts` | 6-10 (from `Its only import`) | Its only import is an `import type` — nothing else may be imported from the library — so, like objectKinds.ts beside it, it runs under node vitest with no DOM. |
| 17 | `src/roles/roleMenu.ts` | 3-7 (from `glyphs are named`) | glyphs are named as strings, never imported — `Glyph.register` stays in the modules that render this menu (RolesTree.ts) — so this module registers nothing and runs under node vitest with no DOM. |
| 18 | `src/navigator/objectMenu.ts` | 8-15 | Kept pure so node vitest can exercise it: the library imports below are `import type`, which erase at compile time, and glyphs are referenced by their registered string name rather than imported — `Glyph.register` stays in the modules that render these menus (NavigatorTree.ts, the controller's own registrations). Mirrors the ./dock/menuItems.ts idiom; `../dock/menuItems` is pure in the same way. |
| 19 | `src/dock/menuItems.ts` | 9-13 | Kept pure so node vitest can exercise it: the library import below is `import type`, which erases at compile time, and glyphs are referenced by their registered string name rather than imported — the `Glyph.register` calls stay in the panel modules that render these buttons. Mirrors the ddlSpecs.ts idiom. |
| 20 | `src/dock/ddlSpecs.ts` | 3-4 (the sentence `Kept DOM-free … can pin them.`) | Kept pure (no library value imports) so node vitest can pin them. |
| 21 | `src/navigator/objectKinds.ts` | 8-10 (from `DOM-free:`) | Pure: this module only holds data and lookups, so it (and its derivations) unit-test under node vitest with no DOM. |
| 22 | `src/shell/changelogText.ts` | 4-7 (from `Deliberately`) | Deliberately imports no library component, so node vitest can import it (frontend/vitest.config.ts) and test the text without a DOM. |
| 23 | `src/controller/revealCoordinator.ts` | 3-7 (from `No library value import:`) | No library value import: `ExplorerTree`/`TreeNode` are type-only and `matchesObject`/`matchesRole`/`matchesRoleSection` come from the pure navigator/revealMatch.ts, so this module needs no DOM under node vitest — mirroring startPageWelcome.ts's own header. |
| 24 | `src/controller/controllerText.ts` | 3-4 (the clause `kept free of library imports so the node vitest can load it`) | kept free of library imports so node vitest can test it without a DOM |
| 25 | `src/shell/shortcutRegistry.ts` | 6-7 (from `Pure data + grouping`) | Pure data + grouping, no typescript-ui import, so node vitest tests it without a DOM (mirroring startPageWelcome.ts). |
| 26 | `src/shell/routeTargets.ts` | 8-11 (from `Kept free of library imports`) | Kept free of library imports (only type imports from ../contract and ../data/queryStore) so node vitest tests it without a DOM — mirroring recordNavigation.ts's and depthChoices.ts's own splits. |

**Group 3 — diagram data builders.**

| # | File | Lines | Replacement text |
|---|---|---|---|
| 27 | `src/data/edgeRouteStubs.ts` | 3-8 (from `No DOM, no`) | No DOM, no ELK — type-only imports from the diagram barrel, per buildSchemaDiagram.ts's header. Nothing here mutates `result`, its edges, or their sections; see `stubBundledEdgeRoutes`'s own purity note. |
| 28 | `src/data/edgeRouteStubs.ts` | 55-59 (JSDoc, the paragraph `The extent is a parameter …supplies it.`) | The extent is a parameter so this transform stays a pure function of its inputs, and its tests can pin coordinates against an extent they state themselves. `JunctionDiagramView` binds it to the library's `EDGE_MARKER_EXTENT`. |
| 29 | `src/dock/JunctionDiagramView.ts` | 23-26 | The library's marker extent is bound here, in the one module that runs the transform, so edgeRouteStubs stays a pure function of its inputs (see its `stubGeometry`). |
| 30 | `src/data/fkCardinality.ts` | 4-7 (from `No DOM, no ELK`) | No DOM, no ELK — type-only imports from the diagram barrel, per buildSchemaDiagram.ts's header. |
| 31 | `src/data/columnEmphasis.ts` | 2-6 (from `No DOM, no`) | No DOM, no ELK — type-only imports from the diagram barrel plus this schema's own pure helpers, per buildSchemaDiagram.ts's header. |
| 32 | `src/data/relationDiagram.ts` | 4-7 (from `No DOM, no ELK`) | No DOM, no ELK — type-only imports from the diagram barrel, per buildSchemaDiagram.ts's header. |
| 33 | `src/data/uniformNodeWidth.ts` | 2-6 (from `No DOM by default`) | No DOM by default — the width is estimated from label length, which keeps this pure and lets the builders that use it stay node-vitest-testable (see buildSchemaDiagram.ts's header). A caller that can reach the DOM may pass a real measurer instead; see `MeasureWidths`. |
| 34 | `src/data/parseExplainPlan.ts` | 2-6 (from `Kept beside`) | Kept beside explain.ts so node vitest can red-green it without a backend or a DOM; it imports no UI module (the diagram builder and node renderer that consume it read these plain fields). |
| 35 | `src/data/buildExplainDiagram.ts` | 5-7 (from `Imports only`) | Imports only the DiagramData *type* and the parsed model, per buildSchemaDiagram.ts's header, so node vitest can red-green it. |
| 36 | `src/data/buildPlanSteps.ts` | 6-8 (from `Imports only the`) | Imports only the parsed model — no DOM, no UI module — so node vitest can red-green it (mirrors buildExplainDiagram's purity note). |
| 37 | `src/data/buildSchemaDiagram.ts` | 48-55 | The registered glyph name for a table node. Deliberately NOT imported from `../navigator/objectGlyphs` (its KIND_GLYPH.table has this same value): that module is UI — it calls `Glyph.register` when imported — and a data builder imports no UI module (see this file's header). Keep this literal in sync with KIND_GLYPH.table if that mapping ever changes. |
| 38 | `src/data/buildDatabaseDiagram.ts` | 18-22 | The registered glyph name for a table node. Deliberately NOT imported from `../navigator/objectGlyphs` — see buildSchemaDiagram.ts's TABLE_GLYPH for why; keep this literal in sync with KIND_GLYPH.table if that mapping ever changes. |
| 39 | `src/data/buildRoleGrantsDiagram.ts` | 11-19 | The registered glyph names for the role and table nodes. Deliberately inline literals, not imported from `../roles/RolesTree` / `../navigator/objectGlyphs`: both are UI modules that call `Glyph.register` when imported, and a data builder imports no UI module (see buildSchemaDiagram.ts's header). Keep these literals in sync with RolesTree.ts's `Glyph.register(user)` and objectGlyphs.ts's `KIND_GLYPH.table`. |
| 40 | `src/data/buildRoleMembershipDiagram.ts` | 11-17 | The registered glyph name for a role node. Deliberately an inline literal, not imported from `../roles/RolesTree`: that is a UI module that calls `Glyph.register` when imported, and a data builder imports no UI module (see buildSchemaDiagram.ts's header). Keep this literal in sync with RolesTree.ts's `Glyph.register(user)`. |
| 41 | `src/data/buildRelationGraph.ts` | 12-16 | Built from the objectKinds.ts registry rather than navigator/objectGlyphs.ts's own KIND_GLYPH: that module is UI (it calls `Glyph.register` when imported), while objectKinds.ts is pure data, so this stays both pure and single-sourced (no hand-copied literal to keep in sync). |
| 42 | `src/data/groupBySchema.ts` | 10-13 | The registered glyph shown before a schema container's name, matching the navigator's KIND_GLYPH.schema. Kept as a literal (not imported from ../navigator/objectGlyphs) for the same layering reason as buildDatabaseDiagram's TABLE_GLYPH; keep in sync with KIND_GLYPH.schema. |
| 42a | `src/data/fkEdgeTooltip.ts` | 2-4 (from `No DOM, no ELK` through `buildSchemaDiagram.ts:16-21.`) | No DOM, no ELK — type-only imports from the diagram barrel, per buildSchemaDiagram.ts's header. |
| 42b | `src/data/buildRelationGraph.ts` | 60 (JSDoc line) | Pure — type-only diagram imports, no UI-module import. |

**Group 4 — test headers.**

| # | File | Lines | Replacement text |
|---|---|---|---|
| 43 | `tests/dock/ddlSpecs.test.ts` | 3-5 (from `DOM-free (the forms`) | DOM-free (the forms themselves construct library components and are manual-verify; this module is the pure logic they call). |
| 44 | `tests/roles/roleMenu.test.ts` | 3-5 (from `DOM-free`) | DOM-free (no glyph registration or Component construction happens here), mirroring tests/navigator/objectMenu.test.ts's style. |
| 45 | `tests/properties/propertyRows.test.ts` | 2-3 (from `DOM-free`) | DOM-free (no Table/Panel construction happens here). |
| 46 | `tests/navigator/objectKinds.test.ts` | 3-4 (from `DOM-free`) | DOM-free (no glyph registration or Component construction happens here). |
| 47 | `tests/navigator/objectMenu.test.ts` | 5-7 (from `DOM-free`) | DOM-free (no glyph registration or Component construction happens here), mirroring tests/dock/menuItems.test.ts's style. |
| 48 | `tests/dock/sequenceFormState.test.ts` | 1-3 (from `DOM-free`) | Pure tests for the sequence info form's seeding/dirty helpers. DOM-free (the form itself is a DOM component and is manual-verify; this module is the pure logic it calls). |

Sites checked and left alone because their wording is still true: `src/textFormat.ts:1-2`, `src/dock/diagramShell.ts:15-17`, `src/shell/queryShortcuts.ts:117-119`, `src/controller/diagramPanels.ts:147-150` (its pointer to "buildSchemaDiagram.ts's header note" becomes valid once C0 lands), and `src/SqlAdminController.ts:707`.

---

## Addendum: Release-note material

For the release-time `CHANGELOG.md` pass. Place these under the next release's headings, in the file's bold-lead-sentence style.

`### Changed`
- **The SQL review dialog now opens with the cursor in the SQL editor.** In the Review SQL… dialog of a create-object tab, and the Save review of the Structure, sequence and type tabs, you can edit the statement straight away. Pressing Enter adds a line instead of running it; run it with the Execute button.
- **Date and time cells accept only the format they display.** A date-time cell rejects a `T` separator, a `Z` or offset suffix, and fractional seconds. A value in any other shape reverts on commit instead of being guessed at.
- **Keyboard focus is easier to follow.** Toolbars and the menu bar show a focus ring when reached with the keyboard, and each toolbar is a single Tab stop whose buttons are reached with the arrow keys.

`### Fixed`
- **Query results of 1,000 rows or more now render.** A result that reached the server's 1,000-row cap could show an empty grid in the built app.

`### Internal`
- Migrated to `@jimka/typescript-ui` 0.10.0: the app now awaits the library's startup before building any UI, so the first screen is laid out in the app's own font.

---

## Addendum: Post-release swap (run by hand)

Not a step of this plan. Once `@jimka/typescript-ui` 0.10.0 is on the registry, the user runs:

1. `cd frontend && npm install @jimka/typescript-ui@^0.10.0`. This replaces the symlink with the registry copy and rewrites the range and the lockfile.
2. `ls -ld node_modules/@jimka/typescript-ui` → a real directory, not a symlink. `node -p "require('./node_modules/@jimka/typescript-ui/package.json').version"` → `0.10.0`.
3. `rm -rf node_modules/.vite && npm run typecheck && npm test && npm run build`.
4. Regenerate `THIRD-PARTY-NOTICES.md` per `release-steps.md`'s "Third-party notices" section.

---

## Notes

[^await-first]: Awaiting before `whoami()` costs at most the library's `FONT_ACTIVATION_DEADLINE_MS` (50 ms, `core/FontActivation.ts:25`), and in practice about 1.4 ms, since the fonts are inline subsets. Running `Body.init` and `whoami()` in parallel with `Promise.all` would hide those milliseconds, but it would split the bootstrap into two concurrent paths for no visible gain, and the library's own entry points do not do it. `Body.getInstance()` would still work at line 47, because the promise has resolved by then. Using the resolved `body` makes that ordering explicit and matches the documented `await Body.init(...); body.addComponent(...)` form in `migration/0.10.0.md` ("Mounting is awaited"). If the await is left out, `Body.init`'s option dispatch still runs synchronously, so nothing crashes. But the library no longer holds the first layout for the font, so text measured before the font lands is sized against the fallback. `DOM.ts`'s `_warnEarlyMeasure` then logs the warning the Expected Behaviour tables check for.

[^dispose-all-equiv]: `Component.disposeAllComponents()` (`core/Component.ts:7747`) is `for (const component of this._components) { component.dispose(); } return this.removeAllComponents();`. `getComponents()` returns `this._components` (`Component.ts:7776`), so the existing loop and the library method visit the same array in the same order. The method is not new in 0.10.0: the app already called it in two places under 0.9.0. The StartPage comment was simply never revisited when the library's `dispose-all-components` plan shipped.

[^import-probe]: While drafting, a throwaway `tests/zz/importprobe.test.ts` (deleted afterwards) dynamically imported those eight modules under `frontend/vitest.config.ts`'s `environment: "node"`, against the symlinked 0.10.0 build. All eight resolved. Under 0.9.0 the same imports threw `document is not defined`. Constructing a component still needs a DOM, which is why every split is kept. Also, 0.10.0's changelog says the library's `<style>` element is now added at the first stylesheet write rather than at import, which could reorder it after an app's own `<style>`. SQLAdmin adds no stylesheet of its own (`index.html` has none and `src/` imports no `.css`), so that reordering cannot apply.

[^glyph-literals]: Three of these literals (`TABLE_GLYPH`) could be derived from the pure `navigator/objectKinds.ts` registry, as `buildRelationGraph.ts` already does. `ROLE_GLYPH` has no pure source; it is also duplicated in `SqlAdminController.ts:71` and `controller/roleActions.ts:28`. Consolidating the glyph names is a refactor in its own right, which 0.10.0 neither requires nor enables. The layering reason is true under both 0.9.0 and 0.10.0, because `objectGlyphs.ts` still calls `Glyph.register` at module scope.

[^stub-param]: Importing `EDGE_MARKER_EXTENT` into `edgeRouteStubs.ts` now works under node vitest, and it was considered. It was rejected for three reasons. It would make a pure transform import a runtime value from the diagram UI barrel, so its unit tests would load `DiagramView`, `ElkLayoutEngine` and the rest of that module graph. It would break the builder rule this plan writes into `buildSchemaDiagram.ts`'s header. And the tests' expected coordinates (`132 = 18 + 14`) would move silently if the library ever widened a marker. The indirection costs one `const` in `JunctionDiagramView.ts`.

[^changelog-at-release]: `plans/implemented/backend-security-config-hardening.md:389` ("`CHANGELOG.md` gains no entry — changelog text is written at release time, not in feature work") and `diagram-edge-merge-junctions.md:478` state this convention. The user's own flow (memory "Changelog via parallel plan research") builds each release entry by reading `plans/implemented/*.md`, so bullets carried in an implemented plan reach the changelog without an interim section in the file.

[^symlink-target]: `frontend/node_modules` in the main tree already holds `@jimka/typescript-ui → /home/jika/typescript/typescript-ui/packages/lib`, whose `package.json` reads `0.10.0` (tag `v0.10.0`). The worktree borrows that install through the symlink. `npm install` inside the worktree would write through the symlink into the main tree and replace the library link with the registry's 0.9.0.

[^memorystore-fixed]: 0.10.0 changelog, Fixed → Data: "A store holding 1,000 records or more now builds its view." `AbstractStore.ts:16` sets `WORKER_THRESHOLD = 1000`, compared with `>=` at line 1938. `backend/app/operations/common.py:14` sets `MAX_ROWS_PER_REQUEST = 1000`. So every truncated query result sat exactly on the threshold, and in a built 0.9.0 bundle the worker script's absolute URL did not resolve, which left the grid empty. The TODO bullet's "see `LIBRARY_NOTES.md`" pointer is dangling too: no such entry remains in that file. SQLAdmin serves no Content-Security-Policy (none in `backend/app`, `Dockerfile` or `docker-compose.yml`), so the new `worker-src blob:` requirement does not apply.

[^subtree-shipped]: typescript-ui `docs/reference/changelog/0.5.0.md:249-253` carries the fix the entry's "Fixed — confirmed live, 2026-08-09" paragraph verified. The entry's body already records the fix. Only the heading's 🔎 and the "Not yet released" paragraph were never updated.

[^other-notes]: Each remaining 🔎 heading in `LIBRARY_NOTES.md` was checked against the 0.10.0 changelog: the unclosed-paren diagnostics and PostgreSQL-dialect lint entries, `ToolBar` arrow keys and a text child, `Markdown` link-reference definitions, `CodeEditor.autoHeightMaxRows` collapse, stranded `LabelListItemRenderer` rules, paged-store `autoSizeColumns`, wide-grid `getBorderWidths` thrash, and `keepNames`. None is named as fixed. The changelog's `ToolBar` arrow-key fix (line 1433) is about a bar with *no* children, which is not the text-child case the notes record.
