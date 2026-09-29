---
depends-on: [typescript-ui-0-10-0-upgrade]
touches-shared: [frontend/src/SqlAdminApp.ts, frontend/src/SqlAdminController.ts, frontend/src/shell/StartPage.ts, frontend/src/dock/QueryPanel.ts, LIBRARY_NOTES.md]
---

# Spatial Navigation Adoption — Implementation Plan

> **Depends on the typescript-ui plan `spatial-navigation-region-chord-default`** (in the typescript-ui repo: `/home/jika/typescript/typescript-ui/plans/`). That plan changes `SpatialNavigation`'s default region-tier chord from `Ctrl+Shift`+arrow to `Ctrl+Alt+Shift`+arrow, so SQLAdmin can call plain `SpatialNavigation.enable()` with no modifier override. This plan runs before any library release, against a symlinked build of that plan's branch; `frontend/package.json` stays on `^0.10.0`. Step 1 checks the linked build's default chord and stops if it has not changed.[^library-branch]

## Overview

Turn on typescript-ui's `SpatialNavigation` service (added in 0.10.0; this plan needs 0.11.0's default chords) in SQLAdmin, so the keyboard can move focus between the app's major regions and between neighbouring controls. The service has two tiers, both driven by arrow keys held with modifiers:

- **Control tier** (the library calls it `"component"`): `Ctrl+Alt`+arrow moves to the nearest focusable control in that direction. This is the library default.
- **Region tier** (the library calls it `"target"`): `Ctrl+Alt+Shift`+arrow moves to the nearest container marked as a *navigation target*, and focuses the control that last had focus inside it (or its first control on a first visit). This is the library default from 0.11.0. In 0.10.0 the default is `Ctrl+Shift`, which takes `Ctrl+Shift+←/→` word selection away from the SQL editor and every text field.

The service is enabled in [`frontend/src/SqlAdminApp.ts`](frontend/src/SqlAdminApp.ts), right after the `await Body.init(...)` that the upgrade plan adds. SQLAdmin then marks its own regions as navigation targets: the sidebar views and their sections, the Dock, each Dock tab, the start page and the status bar. The one app keydown handler that reads arrow keys with modifiers, the query editor's history recall in [`frontend/src/dock/QueryPanel.ts:1175`](frontend/src/dock/QueryPanel.ts#L1175), gets the library's required `SpatialNavigation.claimsKey(e)` guard. The Keyboard Shortcuts dialog and the start-page legend list the two new chords. One `LIBRARY_NOTES.md` entry records the library default-chord change this plan waits on.

This is a step toward the TODO's "Command palette / keyboard-driven actions" item, not the whole of it.

---

## Architecture Decisions

### Enable next to the awaited `Body.init`, as the library demo does

`main()` calls `SpatialNavigation.enable()`, with no options, right after `const body = await Body.init(...)`, before `whoami()`. The precedent is the library's demo entry point, [`../typescript-ui/packages/lib/src/typescript/main.ts:45-46`](../typescript-ui/packages/lib/src/typescript/main.ts), which calls `SpatialNavigation.enable()` once at startup. The library's docs app (`packages/docs`) does not enable the service, so it gives no precedent.[^enable-early]

### Both tiers use the library defaults, which needs typescript-ui 0.11.0

SQLAdmin passes no modifier options. It uses the control tier's `Ctrl+Alt` and the region tier's `Ctrl+Alt+Shift`, both library defaults from 0.11.0 (memory "Prefer library defaults").

The 0.10.0 region default cannot be used. The service listens at the window, in the capture phase, with no check for text entry, and stops a claimed chord's propagation before any widget sees it (`SpatialNavigation.ts:208-209` holds the defaults). This table shows which editing keys each default takes:

| Chord (Windows/Linux) | Pre-empted binding | Where | 0.10.0 default | 0.11.0 default |
|---|---|---|---|---|
| `Ctrl+Shift+←/→` | select word left/right (CodeMirror `selectGroupLeft/Right`, and `selectSyntax`/`selectPage` on macOS; native in `<input>`) | SQL editor, definition editor, every text field | taken by the region tier | **free** for editing |
| `Ctrl+Alt+↑/↓` | add cursor above/below (CodeMirror `addCursorAbove/Below`) | SQL editor, definition editor | taken by the control tier | taken by the control tier |

Word selection is used constantly in a SQL editor, so the plan waits until the library frees it. The control tier only clashes on `↑`/`↓` with adding a cursor, which is rarely used and stays available through Alt+drag (rectangular selection). That trade is accepted.[^chords]

Both display strings live in [`frontend/src/shell/queryShortcuts.ts`](frontend/src/shell/queryShortcuts.ts), which is already the single source for the app's key strings.

### Which containers are navigation targets

The library already marks every `MenuBar`, `ToolBar` and `TabBar` as a target. That covers the menu bar, the activity-bar rail (a vertical `ToolBar`, [`ActivityBar.ts:110`](frontend/src/shell/ActivityBar.ts#L110)), every panel toolbar, and every tab strip. SQLAdmin marks the rest:

| Region | Component | Kind | Marked in |
|---|---|---|---|
| Database / Roles view | `TreeExplorerView` | outer | its `super({...})` options |
| — its tree section | `config.explorer` | inner | `setNavigationTarget(true)`, beside the existing pre-`super` size calls |
| — its inspector section (Properties / role details) | `config.inspector` | inner | same |
| Queries view | `QueriesView` | outer | its `super({...})` options |
| — Saved / Recent sections | each section's `host` `Panel` | inner | the `Panel({...})` options in `buildSection` |
| Work area | `controller.dock` | outer | `Dock({...})` options in the controller |
| — each Dock tab | the tab's frame (`DockPanelEvent.content`) | inner | a `dock.on("attach", …)` handler in the controller |
| Start page | `StartPage` | single | its `super({...})` options |
| Status bar | `controller.statusBar` | single | `new StatusBar({...})` options in the controller |

A component the marking site constructs gets `navigationTarget: true` in its constructor options. A component handed in from elsewhere gets `setNavigationTarget(true)`. The constructor-option form mirrors the library demo's [`MiscPanel.ts:216-217`](../typescript-ui/packages/lib/src/typescript/MiscPanel.ts), and the attach handler mirrors the controller's own `_openContents` tracker at [`SqlAdminController.ts:236-238`](frontend/src/SqlAdminController.ts#L236).

"Outer" and "inner" use the library's nesting rule. A move that comes from outside an outer target always lands in the outer target first, then focuses the control last used anywhere inside it. A move that starts inside the outer target reaches its inner targets directly. So `Ctrl+Alt+Shift+←` from the work area always returns to where the user was in the sidebar. From inside the sidebar, `Ctrl+Alt+Shift+↓` moves from the tree down to Properties.[^nesting]

### Dock tabs are marked through the `"attach"` event

The frame the Dock emits in `"attach"` is the Dock's own per-tab wrapper. It stays the same when a lazy panel's spinner is replaced by the built panel, and when a tab is torn off or re-docked. Marking it in one `"attach"` handler covers every tab-opening path: `addPanel` in `queryWorkspace.ts` and `ddlLaunchers.ts`, and `addLazyPanel` in the controller.[^attach-frame] A torn-off tab lives in its own window, where the service works only inside that window.

### The history-recall handler returns early on `claimsKey`

The editor's keydown handler in `QueryPanel.ts` gets `if (SpatialNavigation.claimsKey(e)) { return; }` as its first statement. This is the rule the 0.10.0 changelog and `docs/concepts/accessibility.md` ("Spatial focus navigation") set for every arrow-key handler. The library applies the same line itself in [`ToolBar.ts:192`](../typescript-ui/packages/lib/src/typescript/lib/component/menubar/ToolBar.ts) and `TabBar.ts:3463`.

Without the guard, the handler's check `(ctrlKey || metaKey) && ArrowUp/ArrowDown` also matches `Ctrl+Alt+↑` and `Ctrl+Alt+Shift+↑`. The editor would then recall a history entry in the same keypress that moves focus away. The handler is a window capture-phase listener, like the service, so the service's stop does not keep it from running.[^guard-order]

### Every other app key handler needs no guard

| Handler | Keys it reads | Guard? |
|---|---|---|
| `installAccelerators` ([`SqlAdminShell.ts:170`](frontend/src/shell/SqlAdminShell.ts#L170)), a `document` listener | `Alt+<letter>`, `?` | no — no arrows; a claimed chord never reaches `document` anyway |
| `bindRefreshShortcut` ([`refreshTool.ts:31`](frontend/src/shell/refreshTool.ts#L31)) | `Alt+R` | no — no arrows |
| QueriesView row keydown ([`QueriesView.ts:293`](frontend/src/shell/QueriesView.ts#L293)) | `Enter`, `Ctrl/Cmd+Enter` | no — no arrows |
| QueryPanel editor keydown ([`QueryPanel.ts:1175`](frontend/src/dock/QueryPanel.ts#L1175)) | `Ctrl/Cmd+↑/↓` and others | **yes** — see above |

The library widgets the app uses already guard their own arrow handlers: `Tree`, `List`, the table `Body`, `TabBar`, `ToolBar`, `MenuBar`, `ComboBox` and `Accordion`. `DiagramView` has no keyboard handling. `CodeEditor` and `MarkdownEditor` handle keys inside CodeMirror and Lexical, which never receive a claimed chord.[^audit]

### The Keyboard Shortcuts registry gains two Navigation entries

`SHORTCUTS` in [`shortcutRegistry.ts:41-56`](frontend/src/shell/shortcutRegistry.ts#L41) gains `focus-region` and `focus-control`, in the `navigation` category, between `refresh` and `help`. Both the Keyboard Shortcuts dialog and the start-page legend render from this registry, so both pick up the entries with no other change.[^legend-precedent]

| id | keys | label |
|---|---|---|
| `focus-region` | `Ctrl+Alt+Shift+Arrow` | Focus the next region |
| `focus-control` | `Ctrl+Alt+Arrow` | Focus the nearest control |

The display strings say `Ctrl`, not `Ctrl/Cmd`: the service matches `ctrlKey` exactly, so on macOS the chords use the Control key.

### The default-chord change is recorded as a library request, not worked around

A new `LIBRARY_NOTES.md` entry recommends two library changes for 0.11.0. First, change the region tier's default from `Ctrl+Shift` to `Ctrl+Alt+Shift`. Second, document the remaining trades in `accessibility.md`'s "Spatial focus navigation" section and the `CodeEditor` component page: the control tier takes `CodeEditor`'s add-cursor keys, and GNOME binds both chords to workspace actions. SQLAdmin passes no `targetModifiers` override in the meantime.[^not-workaround]

---

## Public API

No exported library-facing API changes. Two new exports in `frontend/src/shell/queryShortcuts.ts`:

```ts
/** The control-tier chord's display string (the library default modifiers). */
export const FOCUS_CONTROL_SHORTCUT = "Ctrl+Alt+Arrow";

/** The region-tier chord's display string (the library default modifiers from 0.11.0). */
export const FOCUS_REGION_SHORTCUT = "Ctrl+Alt+Shift+Arrow";
```

`queryShortcuts.ts` gains no import, so it still loads under the node vitest with no library runtime.

---

## Implementation

`frontend/src/SqlAdminApp.ts`, after the upgrade plan has landed. Only the import line and the lines after `Body.init` change:

```ts
import { Body, DOM, SpatialNavigation } from "@jimka/typescript-ui/core";
// …

    const body = await Body.init({ layoutManager: Fit(), favicon: APP_FAVICON });

    // Keyboard focus movement between regions (Ctrl+Alt+Shift+arrow) and
    // controls (Ctrl+Alt+arrow), both the library's default chords. The
    // service stands down on its own while a modal dialog or a menu is open,
    // so enabling it before the login dialog is safe.
    SpatialNavigation.enable();

    const session = (await whoami()) ?? (await showLoginDialog());
```

`frontend/src/SqlAdminController.ts`, the Dock tab marker, placed directly after the existing `_openContents` `"attach"` handler (line 236-238):

```ts
        // Each tab's frame is a spatial-navigation target, so Ctrl+Alt+Shift+
        // arrow moves between tiled tabs and returns to the control last used
        // in each. The frame is the Dock's stable per-tab wrapper (it survives
        // a lazy panel's spinner swap and a tear-off), and "attach" fires for
        // every way a tab opens, so this one handler covers them all.
        // Re-marking on a re-attach is harmless.
        this.dock.on("attach", (e: DockPanelEvent) => {
            e.content.setNavigationTarget(true);
        });
```

`frontend/src/dock/QueryPanel.ts`, the first lines of the editor keydown listener:

```ts
        Event.addSubtreeListener(editor, "keydown", (e: KeyboardEvent) => {
            // The spatial-navigation chords (Ctrl+Alt+arrow, Ctrl+Alt+Shift+
            // arrow) belong to the library service, which moves focus. Without
            // this, the Ctrl+↑/↓ check below would also recall history on them.
            if (SpatialNavigation.claimsKey(e)) {
                return;
            }

            const chord = e.ctrlKey || e.metaKey;
```

---

## Ordered Implementation Steps

### Part A — setup

1. **Check the dependencies.** Confirm `plans/implemented/typescript-ui-0-10-0-upgrade.md` exists and `grep -n 'await Body.init' frontend/src/SqlAdminApp.ts` prints one line. Then confirm the linked library build carries the new chord:
   - `readlink -f frontend/node_modules/@jimka/typescript-ui` must print the `packages/lib` of the typescript-ui worktree on the library plan's branch (find it with `git -C /home/jika/typescript/typescript-ui worktree list`), not the main typescript-ui checkout.
   - `grep -c '{ctrl:!0,alt:!0,shift:!0}' frontend/node_modules/@jimka/typescript-ui/dist/lib/SpatialNavigation-*.js` must print `1` or more, and `grep -c '{ctrl:!0,shift:!0}'` on the same file must print `0`. If the file is missing or older than the worktree's `src`, run `npm run build:lib` in the library worktree and re-check.

   If any check fails, stop and report: this plan waits on both.

2. **Worktree install.** From the worktree root: `ln -s /home/jika/typescript/sqladmin/frontend/node_modules frontend/node_modules`. Then repeat step 1's `grep -c '{ctrl:!0,alt:!0,shift:!0}'` check through the worktree path, to confirm the worktree sees the same linked build. Do not run `npm install`: it would replace the symlink with the registry's 0.10.0.

3. **Baseline.** `cd frontend && npm run typecheck && npm test`. Record the passing test count (call it *N*).

### Part B — shortcut constants and registry (test-first)

4. **Tests first.** In `frontend/tests/shell/shortcutRegistry.test.ts`:
   - import `FOCUS_REGION_SHORTCUT, FOCUS_CONTROL_SHORTCUT`;
   - add `"focus-region", "focus-control"` to `EXPECTED_IDS`, and change the comment above it to "The 16 ids the registry must carry";
   - rename the first test to "carries exactly the 16 expected ids with no duplicates";
   - add `expect(byId.get("focus-region")).toBe(FOCUS_REGION_SHORTCUT);` and `expect(byId.get("focus-control")).toBe(FOCUS_CONTROL_SHORTCUT);` to the constants test;
   - change the counts test to "groups the entries with counts 6 / 3 / 7" and `[6, 3, 7]`.

   Run `npm test` in `frontend`: the changed tests fail (red).

5. **`frontend/src/shell/queryShortcuts.ts`.**
   - After `HELP_SHORTCUT` (line 41), add the two exports from [Public API](#public-api), each with its doc comment. Add one comment above the pair saying: both strings mirror the library's default modifiers (`SpatialNavigation.ts`'s `DEFAULT_COMPONENT_MODIFIERS` and `DEFAULT_TARGET_MODIFIERS`), so they must change if the library's defaults change.
   - Append one sentence to the header comment (lines 1-16): "The spatial-navigation chords (Ctrl+Alt+arrow, Ctrl+Alt+Shift+arrow) are the library SpatialNavigation service's defaults, enabled in SqlAdminApp.ts; only their display strings live here."

6. **`frontend/src/shell/shortcutRegistry.ts`.** Add `FOCUS_REGION_SHORTCUT, FOCUS_CONTROL_SHORTCUT` to the import. Insert two entries between `refresh` and `help`:

   ```ts
       { id: "focus-region",    keys: FOCUS_REGION_SHORTCUT,    label: "Focus the next region",         category: "navigation" },
       { id: "focus-control",   keys: FOCUS_CONTROL_SHORTCUT,   label: "Focus the nearest control",     category: "navigation" },
   ```

   Check: `npm test` is green (*N* tests; this plan changes existing tests and adds none).

### Part C — enable the service

7. **`frontend/src/SqlAdminApp.ts`.** Apply the [Implementation](#implementation) snippet: add `SpatialNavigation` to the `core` import and insert the comment plus the `SpatialNavigation.enable()` call on the line after `const body = await Body.init(...)`, before `const session = …`.

   Check: `grep -n 'SpatialNavigation.enable()' frontend/src/SqlAdminApp.ts` → one match, on the line after `await Body.init`. `grep -rn 'targetModifiers\|componentModifiers' frontend/src` → zero matches.

### Part D — navigation targets

8. **`frontend/src/shell/treeExplorerView.ts`.**
   - After `tree.setMinSize(...)` (line 73), add `tree.setNavigationTarget(true);` and `config.inspector.setNavigationTarget(true);`. Extend the comment above lines 69-71 with one sentence: "The tree and the inspector are also spatial-navigation targets inside this view, so Ctrl+Alt+Shift+↑/↓ moves between them."
   - In the `super({...})` options (line 79), add `navigationTarget: true,` directly after `id: config.id,`, with the comment `// The whole view is one spatial-navigation region; entering it from outside restores the control last used in it.`

9. **`frontend/src/shell/QueriesView.ts`.**
   - In the `super({...})` options (line 133), add `navigationTarget: true,` directly after `id,`, with the same one-line comment as step 8.
   - In `buildSection`'s `Panel({...})` (lines 207-211), add `navigationTarget: true,` as the last option, with the comment `// Each section is a spatial-navigation target inside the view.`

10. **`frontend/src/SqlAdminController.ts`.**
    - Line 190: `Dock({ listeners: … })` → `Dock({ navigationTarget: true, listeners: { emptychange: e => this._startToggle?.(e.empty) } })`. Add to the comment above it: "It is also the work area's spatial-navigation region."
    - Line 191: `new StatusBar()` → `new StatusBar({ navigationTarget: true })`, with the comment `// A spatial-navigation target, so the keyboard reaches its notification-history button.`
    - Insert the `"attach"` marker from [Implementation](#implementation) directly after the `_openContents` handler (after line 238).

11. **`frontend/src/shell/StartPage.ts`.** In the `super({...})` options (lines 105-116), add `navigationTarget: true,` after `autoScroll: "y",`, with the comment `// The work area's spatial-navigation region while the Dock is empty.`

12. **Checkpoint.** `grep -rn 'navigationTarget: true\|setNavigationTarget(true)' frontend/src` → exactly 9 matches (treeExplorerView.ts 3, QueriesView.ts 2, SqlAdminController.ts 3, StartPage.ts 1). Then `cd frontend && npm run typecheck && npm test`.

### Part E — arrow-key guard

13. **`frontend/src/dock/QueryPanel.ts`.**
    - Line 64: add `SpatialNavigation` to the `core` import (`import { Component, Container, Event, SpatialNavigation } from …`).
    - Insert the guard from [Implementation](#implementation) as the first statement of the listener at line 1175.
    - In the comment block above the listener (lines 1160-1174), change "Plain arrows (no modifier) are untouched" to "Plain arrows (no modifier) and the spatial-navigation chords are untouched".

    Check: `grep -rn 'SpatialNavigation.claimsKey' frontend/src` → exactly one match, in `QueryPanel.ts`.

### Part F — bookkeeping

14. **`LIBRARY_NOTES.md`.** Add a new entry at the top of the file, directly under the `---` that follows the status legend (newest first). Use the text in [Addendum: LIBRARY_NOTES entry](#addendum-library_notes-entry) as written.

15. **Checkpoint.** `cd frontend && npm run typecheck && npm test && npm run build`.

### Part G — manual verification

16. Bring the stack up per `.claude/skills/verify/SKILL.md` against the linked library build from step 1 and log in. In DevTools, confirm the served `SpatialNavigation-<hash>.js` has the same file name as the one in the library worktree's `dist/lib`. Open a query tab and a table tab so the Dock has two tabs. Walk every table in [Expected Behaviour](#expected-behaviour) with the DevTools console open. A focus move that lands somewhere other than the stated place is reported, not worked around. If the cause is the library's ranking or reveal behaviour, add a `🐞🔎` entry to `LIBRARY_NOTES.md` under the one from step 14, in the existing entries' shape.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `frontend/src/SqlAdminApp.ts` (enable the service) |
| Modify | `frontend/src/shell/queryShortcuts.ts` (two constants, header sentence) |
| Modify | `frontend/src/shell/shortcutRegistry.ts` (two entries) |
| Modify | `frontend/src/shell/treeExplorerView.ts` (outer + two inner targets) |
| Modify | `frontend/src/shell/QueriesView.ts` (outer + section targets) |
| Modify | `frontend/src/shell/StartPage.ts` (target option) |
| Modify | `frontend/src/SqlAdminController.ts` (Dock and StatusBar options; `"attach"` marker) |
| Modify | `frontend/src/dock/QueryPanel.ts` (`claimsKey` guard; comment) |
| Modify | `frontend/tests/shell/shortcutRegistry.test.ts` (ids, constants, counts) |
| Modify | `LIBRARY_NOTES.md` (new entry) |

---

## Expected Behaviour

### Unit-testable

| # | Case | Expected |
|---|---|---|
| U1 | `SHORTCUTS` ids | exactly the 14 existing ids plus `focus-region` and `focus-control`, with no duplicates |
| U2 | `SHORTCUTS` keys | `focus-region` → `FOCUS_REGION_SHORTCUT`, `focus-control` → `FOCUS_CONTROL_SHORTCUT` |
| U3 | `groupByCategory()` counts | `[6, 3, 7]`; Navigation order is `databases-rail, roles-rail, queries-rail, refresh, focus-region, focus-control, help` |

Everything below is manual-verify: focus, geometry and key dispatch run only in a browser. "Region chord" means `Ctrl+Alt+Shift`+arrow and "control chord" means `Ctrl+Alt`+arrow. After every move, the newly focused element shows a focus ring.

### Moving between regions

Start with the Database view open, two tabs in the Dock, and the query tab active.

| # | Start | Keys | Correct |
|---|---|---|---|
| M1 | Click a table node in the navigator tree | region `→` | Focus lands inside the Dock. |
| M2 | Click into the SQL editor and place the caret mid-line | region `←`, then region `→` | `←` lands in the Database view. `→` puts the caret back in the SQL editor at the same place. |
| M3 | Arrow down the navigator tree to a node deep in it | region `→`, then region `←` | Focus returns to the same tree node. |
| M4 | Navigator tree | region `↓`, then region `↑` | `↓` lands in the Properties section. `↑` returns to the same tree node. |
| M5 | Navigator tree | region `←` | Focus lands on a rail button. Bare `↑`/`↓` then move along the rail. |
| M6 | SQL editor | region `↑` three times | 1st: the query panel's toolbar. 2nd: the Dock's tab strip. 3rd: the menu bar (a menu title is focused; no menu opens). |
| M7 | Any control in the Dock | region `↓`, repeated until focus stops moving | Focus reaches the status bar's notification-history button and stays there. |
| M8 | Drag the table tab to the Dock's right edge, so the two tabs are tiled side by side. Focus the query editor. | region `→`, then region `←` | `→` lands in the table tab. `←` puts the caret back in the query editor. |
| M9 | Queries view (Alt+Q), a row in Saved focused | region `↓`, then region `↑` | `↓` lands in the Recent list (if it has rows). `↑` returns to the same Saved row. |
| M10 | Close every tab (start page shows); focus the navigator tree | region `→` | Focus lands on a start-page button. |
| M11 | View → Toggle Sidebar (collapsed); focus the SQL editor | region `←` | Focus lands on a rail button. It never lands in the hidden view. |
| M12 | Collapse the Properties section; focus the navigator tree | region `↓` | Focus never lands inside the collapsed section while it stays collapsed. If the section expands and focus lands in it, that is also correct. |

### Moving between controls

| # | Start | Keys | Correct |
|---|---|---|---|
| C1 | The query panel's Run button | control `→` | The next toolbar control to the right. |
| C2 | SQL editor | control `←` | The nearest focusable control to the left, which is in the sidebar. |
| C3 | Table tab's quick-search field (in its toolbar), with text | control `↓` | Focus leaves the field for the grid. Bare `←`/`→` in the field still jump across the toolbar (the open `ToolBar` note; unchanged here). |

### No collisions

| # | Where | Keys | Correct |
|---|---|---|---|
| X1 | SQL editor with text | `Ctrl+Shift+←/→` | Extends the selection by a word. Focus does not move. |
| X2 | Navigator search field or any text field | `Ctrl+Shift+←/→` | Extends the selection by a word. |
| X3 | SQL editor, after running two queries | `Ctrl+↑`, `Ctrl+↓` | Recalls the older/newer query, as before. |
| X4 | SQL editor | `Ctrl+Alt+↑` and `Ctrl+Alt+Shift+↑` | Focus moves. The editor text does not change: no history recall, no extra cursor. |
| X5 | Navigator tree, table grid, rail, Dock tab strip | bare arrows | Each widget's own arrow handling works as before. |
| X6 | Schema diagram tab | mouse pan and zoom, then region `←` | Pan and zoom work as before. The chord moves focus out. |
| X7 | Any | `Alt+N`, `Alt+D`, `Alt+R` in the sidebar, `?` | Each accelerator works as before. |

### Dialogs, menus, windows

| # | Where | Keys | Correct |
|---|---|---|---|
| D1 | Keyboard Shortcuts dialog (`?`) | region and control chords, each direction | Focus stays inside the dialog. |
| D2 | Review SQL… dialog (Navigator → right-click a schema → Create ▶ Table → Review SQL…), caret in its SQL editor | `Ctrl+Shift+←` | Selects a word. Focus stays in the dialog. |
| D3 | Query menu open | control `↓` | Focus stays in the menu; the menu stays open. |
| D4 | Tools → Show localStorage… window, focused | control chords | Focus moves between controls inside the window only. |
| D5 | Keyboard Shortcuts dialog and start page | look | Both list "Ctrl+Alt+Shift+Arrow — Focus the next region" and "Ctrl+Alt+Arrow — Focus the nearest control" under Navigation. No dialog row wraps. |

---

## Verification

| # | Where | Command / action | Expect |
|---|---|---|---|
| 1 | worktree | `grep -c '{ctrl:!0,alt:!0,shift:!0}' frontend/node_modules/@jimka/typescript-ui/dist/lib/SpatialNavigation-*.js` | `1` or more |
| 2 | `frontend` | `npm run typecheck` | clean |
| 3 | `frontend` | `npm test` | *N* passing |
| 4 | `frontend` | `npm run build` | succeeds |
| 5 | repo root | `grep -rn 'SpatialNavigation.enable()' frontend/src` | one match, `SqlAdminApp.ts` |
| 6 | repo root | `grep -rn 'SpatialNavigation.claimsKey' frontend/src` | one match, `QueryPanel.ts` |
| 7 | repo root | `grep -rn 'navigationTarget: true\|setNavigationTarget(true)' frontend/src \| wc -l` | `9` |
| 8 | repo root | `grep -c '"@jimka/typescript-ui": "\^0.10.0"' frontend/package.json` | `1` (no version bump here) |
| 9 | browser | every manual table in [Expected Behaviour](#expected-behaviour) | walked |

---

## Potential Challenges

- **An OS takes the chord first.** On GNOME, `Ctrl+Alt+arrow` switches workspace and `Ctrl+Alt+Shift+arrow` moves the window to another workspace. Some Windows Intel graphics drivers bind `Ctrl+Alt+arrow` to screen rotation. If a chord never reaches the browser, record it in the plan's Implementation Notes; changing the chords is a separate decision.
- **A stale Vite dep cache** after library rebuilds can serve an older library build. The symptom is X1 failing: `Ctrl+Shift+←/→` moves focus instead of selecting a word (0.10.0's region default). Restart `npm run dev`; if needed, `rm -rf frontend/node_modules/.vite`.
- **The first visit to a region lands on its first control, not its main one.** The library focuses the first focusable element in DOM order until the region has a remembered control. For the Dock that is usually a tab-strip button. This is library behaviour, and M1 only checks that focus lands inside the Dock.
- **`M12`'s outcome depends on how `Accordion` hides a collapsed section.** Either outcome in the table is correct. Focus landing inside a section that stays collapsed is a library bug for `LIBRARY_NOTES.md`.

---

## Critical Files

- `../typescript-ui/packages/lib/src/typescript/lib/core/SpatialNavigation.ts` — the service: the default modifier sets (lines 208-209 in 0.10.0), `enable`, `claimsKey`, `claimedTier` (lines 237-255), `outermostTargets` (nesting), `onKeyDown` (lines 715-727).
- `../typescript-ui/packages/lib/docs/concepts/accessibility.md:152-200` — the "Spatial focus navigation" section, including the guard rule.
- `../typescript-ui/packages/lib/docs/reference/changelog/0.10.0.md:705-740` and `:822-970` — the Added and Fixed entries.
- `../typescript-ui/packages/lib/src/typescript/main.ts:45-46` — precedent for enabling at startup.
- `../typescript-ui/packages/lib/src/typescript/MiscPanel.ts:216-217` — precedent for `navigationTarget: true` in constructor options.
- `../typescript-ui/packages/lib/src/typescript/lib/component/menubar/ToolBar.ts:191-192` — precedent for the `claimsKey` guard.
- [`frontend/src/SqlAdminController.ts:236-238`](frontend/src/SqlAdminController.ts#L236) — precedent for the `"attach"` handler.
- [`frontend/src/shell/queryShortcuts.ts`](frontend/src/shell/queryShortcuts.ts), [`frontend/src/shell/shortcutRegistry.ts`](frontend/src/shell/shortcutRegistry.ts) — the key-string source and the legend registry.
- [`plans/typescript-ui-0-10-0-upgrade.md`](plans/typescript-ui-0-10-0-upgrade.md) — the `await Body.init` this plan builds on.

---

## Non-Goals

- **Tightening the history-recall chord.** `Ctrl+Shift+↑/↓` still recalls history in the editor, as today. With the `claimsKey` guard, no spatial chord reaches it.
- **The `ToolBar` text-child arrow-key bug.** The `LIBRARY_NOTES.md` entry stays open. 0.10.0 did not fix it (`ToolBar.ts:191-216` still has no text-target check), and the spatial chords are not affected, because `claimsKey` runs first.
- **`FocusHistory`.** A separate opt-in service; not enabled here.
- **A command palette.** The TODO bullet stays as it is.
- **Changing the library's default chords from SQLAdmin.** The change belongs to typescript-ui 0.11.0; the `LIBRARY_NOTES.md` entry requests it.
- **An app-side `targetModifiers` override.** Rejected in favour of waiting for the library default.[^not-workaround]
- **`CHANGELOG.md`.** It is written at release time; see [Addendum: Release-note material](#addendum-release-note-material).
- **The version bump and the registry swap.** Neither happens here. Moving `frontend/package.json` to typescript-ui 0.11.0 is a manual dependency step the user runs by hand.

---

## Addendum: LIBRARY_NOTES entry

```markdown
## ✂️🔎 `SpatialNavigation`'s default region chord takes word selection; recommend `Ctrl+Alt+Shift` for 0.11.0 (0.10.0)

Found while planning `spatial-navigation-adoption`. `SpatialNavigation` claims
its chords at the window in the capture phase, with no check for text entry,
and stops a claimed chord's propagation, so a widget below never sees it
(defaults at `SpatialNavigation.ts:208-209`). On Windows and Linux that
pre-empts:

- `Ctrl+Shift+←/→` (region tier default): word selection in every text input
  and in `CodeEditor` — CodeMirror's `selectGroupLeft/Right`, and
  `selectSyntax`/`selectPage` on macOS — plus the native
  `<input>`/`<textarea>` gesture.
- `Ctrl+Alt+↑/↓` (control tier default): CodeMirror's `addCursorAbove/Below`
  (`Mod-Alt-ArrowUp/Down`), live because `CodeEditor` sets
  `EditorState.allowMultipleSelections.of(true)`. `Ctrl+Alt+←/→` clashes with
  nothing; word selection is not affected by the control tier.

**Library change recommended for 0.11.0:**

1. Change the region tier's default from `Ctrl+Shift` to `Ctrl+Alt+Shift`. It
   has no CodeMirror or browser binding, so every app with text input can use
   the default.
2. Document the remaining trades in `docs/concepts/accessibility.md`'s
   "Spatial focus navigation" section and on the `CodeEditor` component page:
   the control tier takes `CodeEditor`'s add-cursor keys (Alt+drag rectangular
   selection still works), and GNOME binds `Ctrl+Alt+arrow` (switch workspace)
   and `Ctrl+Alt+Shift+arrow` (move window to workspace).

**In SQLAdmin:** `plans/spatial-navigation-adoption.md` waits for this change
and then calls plain `SpatialNavigation.enable()`. Nothing is enabled until then.

---
```

---

## Addendum: Release-note material

For the release-time `CHANGELOG.md` pass, in the file's bold-lead-sentence style.

`### Added`
- **Move keyboard focus between parts of the window.** `Ctrl+Alt+Shift`+arrow jumps between the sidebar, its sections, the work area, each tiled tab, the menu bar and the status bar, and returns to the control you last used in each. `Ctrl+Alt`+arrow moves to the nearest control in that direction. Both are listed in the Keyboard Shortcuts dialog.

`### Changed`
- **`Ctrl+Alt+↑/↓` in the SQL editor now moves focus.** It no longer adds a cursor above or below. Alt+drag still makes a rectangular selection.

---

## Notes

[^enable-early]: The demo calls `enable()` before `Body.init`; either order works, since `enable` only registers a window listener. Placing it after the await keeps all runtime setup in one place, next to the mount. The login dialog is modal, so `LayerManager.hasActiveInputLayer()` is true while it shows and the service does nothing until sign-in. The docs app (`packages/docs/src`) was searched for `SpatialNavigation`, `navigationTarget` and `claimsKey`: no matches.

[^chords]: The library's 0.10.0 defaults were the user's own choice, made knowing about the GNOME collision (`plans/implemented/spatial-focus-navigation.md:589` in typescript-ui). The same plan's Potential Challenges (line 530) names the word-selection clash. SQLAdmin's SQL editor, definition editor and navigator search are all text, so the 0.10.0 region default would break word selection across the app. Swapping the tiers (region on `Ctrl+Alt`, control on `Ctrl+Alt+Shift`) was rejected: it gives the more-used region jump two modifiers, and it contradicts the library docs' naming of `Ctrl+Alt` as the fine tier. `Ctrl+Alt+Shift+arrow` has no CodeMirror binding (the `Mod-Alt-Arrow` bindings have no Shift variant) and no browser binding. Its OS collision (GNOME's move-window-to-workspace) is the same class the library already accepted for `Ctrl+Alt`. On macOS, `ctrl` is the Control key, so neither chord touches CodeMirror's Cmd-based bindings there; VoiceOver uses Control+Option chords only while it is running.

[^nesting]: `outermostTargets` (`SpatialNavigation.ts:299-303`) drops an inner target whenever an outer target contains it and does not contain the focused element. `recordOrigin` (lines 275-281) records the focused element against *every* marked ancestor when a move leaves it, so both the outer and the inner target remember it. Marking only the inner sections was considered. It would let a move from the Dock land on either the tree or the inspector depending on the editor's vertical position, so "back to where I was in the sidebar" would not always hold. Marking only the outer view would lose `↑`/`↓` between tree and Properties. The two levels give both. The memory is written only when focus leaves a region by a spatial move; a mouse click elsewhere does not update it.

[^attach-frame]: `Dock.reconcileHosts` (`overlay/Dock.ts:1191-1215`) emits `"attach"` with `content: frame`, where the frame is the `Container` the Dock creates per panel id (lines 654 and 680). It emits on a first appearance and again on every host change. `setNavigationTarget(true)` sets an option and a data attribute, so calling it again is harmless. The `Tab` layout writes `tabindex="-1"` on each frame, so the frame itself is never a focus landing; the library lands on a control inside it.

[^guard-order]: `Event.addSubtreeListener` and `Event.addViewportListener` both install window-level, capture-phase listeners (`Event.ts:183-187`). `stopPropagation` does not stop other listeners on the same target, so the service and `QueryPanel`'s handler both run for every keydown in the editor, whichever registered first. That is why the library makes the guard every handler's own job. CodeMirror's keymap listens on its content element, below the window, so a stopped chord never reaches it.

[^audit]: The search was `grep -rn "keydown\|Arrow\|addSubtreeListener\|addViewportListener" frontend/src`, plus `grep -rn -i "\.key\b\|e\.code\|onKey" frontend/src`. It found exactly the four handlers in the table. In the library, `comm` of files mentioning arrow keys against files calling `claimsKey` left only `List.ts`, `AbstractCalendarDropdown.ts` and `AutoCompleteDropdown.ts`. `List` inherits its arrow handling from `AbstractSelectableList`, which is guarded. The two dropdowns run inside an open dropdown layer, where the service stands down. `DiagramView` registers no key listener.

[^legend-precedent]: `plans/implemented/shortcut-legend-home.md` created the registry as the one list both surfaces render. New chords are added there as entries with `keys` taken from `queryShortcuts.ts` constants, never literals, which the registry test checks. The longest new row, "Ctrl+Alt+Shift+Arrow" plus "Focus the next region", is about the width of the existing "Ctrl/Cmd+Shift+E" / "Explain Analyze the statement" row, so the dialog's 420px width should hold; case D5 checks it.

[^not-workaround]: An earlier draft passed `targetModifiers: { ctrl: true, alt: true, shift: true }` from the app, with a `FOCUS_REGION_MODIFIERS` constant and a test for it. That override is the library's documented option, but it was dropped under the user's rule to prefer library defaults: a default that breaks word selection in every text input is wrong for any app, so the fix belongs in the library, and every consumer then gets it without configuration.

[^library-branch]: The typescript-ui release waits on SQLAdmin's verification, so this plan cannot wait on the release (memory "Library release gated on SQLAdmin"). It runs against `frontend/node_modules/@jimka/typescript-ui` symlinked to the library worktree's `packages/lib`, while `frontend/package.json` still names `^0.10.0`; that mismatch is expected until the release. The check reads the built chunk rather than the library source or a version number, because the app runs the built `dist/lib`, and a symlink pointing at the main checkout would serve master's build (memory "Verify symlink must target worktree"). The library plan writes the default with its keys in `ctrl, alt, shift` order so the minified literal is stable. The `depends-on` frontmatter can only name SQLAdmin plans, so the library dependency is stated in the banner and checked in step 1.

---

## Implementation Notes

### Deviations

- **Registry counts.** This branch sits on `feature/review-dialog-keyboard-exit`, which added a `leave-editor` row to the Editor category after the plan was written. The registry therefore carries **17** ids, not 16, and `groupByCategory()` counts are `[7, 3, 7]`, not `[6, 3, 7]`. The test comment, the first test's name and the counts test say 17 and `[7, 3, 7]`. U3's Navigation order is now pinned too: the existing "preserves registry order within a group" test also asserts the Navigation ids in order. No test was added (N stays 1127).
- **`claimsKey` guard shape.** The plan's snippet put the call inside the `if` condition (`if (SpatialNavigation.claimsKey(e))`). The project rule forbids a call in an `if` condition, so the result is assigned first (`const claimedBySpatialNavigation = SpatialNavigation.claimsKey(e);`) and the variable is checked. The behaviour is the same, and the step-13 grep still finds exactly one `SpatialNavigation.claimsKey` match.
- **Comment wrapping.** The plan's one-line comment for the outer views ("The whole view is one spatial-navigation region; …") is wrapped over two lines to match the surrounding comment width. The `QueryPanel` comment-block edit is reflowed the same way.
- **LIBRARY_NOTES "In SQLAdmin" paragraph.** The addendum's last paragraph ("waits for this change … Nothing is enabled until then") would be false once this branch lands, because the library change already exists on the unreleased `feature/spatial-navigation-region-chord-default` branch and this branch enables the service. Following the base branch's 🐞✅ precedent (the review-dialog Tab-trap entry), that paragraph is replaced by a "Fixed in the library … Adopted here … Verified live" paragraph, and the status is ✂️✅, because the linked library branch makes both recommended changes (the default chord, and the accessibility and `CodeEditor` doc trades). It also says the 0.11.0 bump must ship with this adoption. The heading text and the rest of the entry are as written.
- **New 🐞🔎 LIBRARY_NOTES entry (step 16).** Case C2 failed; see below.

### Step 1 check

`frontend/node_modules/@jimka/typescript-ui` resolves to `/home/jika/typescript/typescript-ui/.worktrees/dialog-escape-releases-tab-owner/packages/lib`. That is the unreleased stack tip. It contains `feature/spatial-navigation-region-chord-default` (commit `1134d6a4` is an ancestor). The minified-text check passed as written: `SpatialNavigation-B3fDdDeZ.js` has one `{ctrl:!0,alt:!0,shift:!0}` and zero `{ctrl:!0,shift:!0}`, and the same result shows through the worktree's `node_modules` symlink. In the browser, `performance.getEntriesByType('resource')` showed the page loaded `/@fs/…/.worktrees/dialog-escape-releases-tab-owner/packages/lib/dist/lib/SpatialNavigation-B3fDdDeZ.js`. That is the same file name, and its fetched text has the new literal and not the old one. The Vite dep cache was cleared (`rm -rf frontend/node_modules/.vite`) and a fresh dev server was started from this worktree before the checks.

### Manual verification (step 16)

Stack: the Compose `db`, the backend run natively from this worktree (`SQLADMIN_ALLOWED_HOSTS=localhost:5432 poetry run uvicorn …`), and Vite from this worktree. Login used Host `localhost`. The browser was Chrome driven through chrome-devtools MCP at 1500×850.

**How the keys were driven.** Every chord and bare key under test was a real key press. The MCP `press_key` tool sends CDP `Input.dispatchKeyEvent`, so the browser gets trusted keydown/keyup with real modifier state, for example `Control+Alt+Shift+ArrowRight` and `Control+Alt+ArrowDown`. No case was driven with synthetic `dispatchEvent` keys. Text was typed with `type_text`, which is also real input. Clicks used the `click` tool, which is a real CDP mouse. Outcomes were read with a read-only `evaluate_script` helper. It reports `document.activeElement` and its `data-ts-ui-navigation-target` ancestors, the editor text, the CodeMirror cursor count and the selection. Setup that has no key or click form used synthetic pointer events and was never the thing under test: the right-click context menus (the verify skill's documented method), the tab drag that tiled `customers` beside `Query 1` for M8, and the pan and wheel-zoom gestures in X6. All nine planned targets were present (`data-ts-ui-navigation-target` on both explorer views, the tree, the inspector, `QueriesView`, both Queries sections, `#work-dock`, `#work-start` and the StatusBar), and the Dock tab frames were marked on attach.

| # | Result |
|---|---|
| M1 | Pass. From a clicked table node, region → focused the `Query 1` tab button inside `#work-dock`. |
| M2 | Pass. Caret at Ln 1 Col 17. Region ← went to the NavigatorTree, and region → went back to `.cm-content` at Col 17. |
| M3 | Pass. The tree was moved to "Views" with bare ↓×3. Region → went to the Dock's remembered control, and region ← went back to "Views" (still active and selected). |
| M4 | Pass. Region ↓ went to the Properties section's first control (its Column options button). Region ↑ went back to "Views". |
| M5 | Pass. Region ← went to rail button 0. Bare ↓ moved to button 1 and bare ↑ moved back. |
| M6 | Pass. From the editor, region ↑×3 went to the query toolbar (Run), then the Dock tab strip (`Query 1`), then the `Query` menu-bar title. No menu opened. |
| M7 | Pass. From the editor, region ↓ went to the result `Data` tab, then the result toolbar, then the StatusBar's Notification history button. A 4th ↓ stayed there. |
| M8 | Pass. With the tabs tiled (query x 280–890, table x 890–1500), region → went into the table tab (x=890), and region ← went back to the editor at the same caret (Col 9). |
| M9 | Pass. A scratch saved query was created with Ctrl+S (removed afterwards). With the Saved row focused, region ↓ went to the Recent list and region ↑ went back to Saved with the same row active. |
| M10 | Pass. After closing every tab, the start page showed. Region → from the tree focused its `New Query` button. |
| M11 | Pass. With the sidebar collapsed (View → Toggle Sidebar), region ← from the editor focused a rail button, not the hidden view. |
| M12 | Pass (the "expands" outcome). With Properties collapsed, region ↓ from the tree expanded the section and focused its Column options button. |
| C1 | Pass. Run was reached with region ↑ from the editor, because clicking Run hands focus back to the editor. Control → went to Save query. |
| C2 | **Fail, reported.** Control ← from the editor went to the result pane's *Record view* button (below-left), not the sidebar. The cause is the library's `rankWithContainerPriority`: see the new 🐞🔎 LIBRARY_NOTES entry. Region ← reaches the sidebar as expected. |
| C3 | Pass. In the table quick-search field with "ada", control ↓ went to the grid `TableBody`. |
| X1 | Pass. In the SQL editor, `Ctrl+Shift+→` selected "from", `Ctrl+Shift+←`×2 selected "name ", and focus stayed in the editor. |
| X2 | Pass in a plain text field: the Save-query name input selected "nav" (←) and "scratch" (→). In the table *toolbar's* quick-search field, `Ctrl+Shift+←` (and bare Home/End) moves toolbar roving focus instead. That is the existing open `ToolBar` text-child entry, not the spatial chords: the region chord now needs Alt and is not claimed. |
| X3 | Pass. After running `select id, name from customers` and then `select 2`, `Ctrl+↑` recalled the older query and `Ctrl+↓` recalled the newer. |
| X4 | Pass. From the editor at the newest history entry, `Ctrl+Alt+↑` moved focus to the toolbar. The text stayed `select 2` with one `.cm-cursor`: no recall and no extra cursor. `Ctrl+Alt+Shift+↑` moved focus to Run, with the text unchanged. |
| X5 | Pass. The tree (↓), rail (↑/↓), Dock tab strip (← switched tabs) and table grid (↓ moved the focused row) all worked. |
| X6 | Pass. On the database diagram, pan and wheel-zoom changed its transform (synthetic pointer/wheel, as noted above). Region ↓ entered the diagram panel, and region ← left it for the NavigatorTree. |
| X7 | Pass. `Alt+N` opened a query tab, `Alt+D` and `Alt+Q` switched rails, `?` opened the Shortcuts dialog, and `Alt+R` in the tree refetched the schema endpoints (seen in resource timing). |
| D1 | Pass. In the Keyboard Shortcuts dialog, all four region and all four control directions left focus on the dialog's own close button. The Save-query dialog behaved the same. |
| D2 | Pass. In the Review SQL dialog (sales → Create ▶ Table), with the caret at the end of line 2, `Ctrl+Shift+←` selected "integer" and focus stayed in `SqlPreviewModal`. It was cancelled, not executed, and `zz_spatial_scratch` does not exist in the DB. |
| D3 | Pass. With the Query menu open, control ↓ (before and after a bare ↓ into the menu) left the menu open and focus on the menu. |
| D4 | Pass. In the Local Storage window, control →, ↓, ←×3 and ↑×2 moved between the tree, the JSON editor, the footer buttons and the title-bar controls, and never left the window. |
| D5 | Pass. The dialog and the start-page legend both list "Ctrl+Alt+Shift+Arrow — Focus the next region" and "Ctrl+Alt+Arrow — Focus the nearest control" under Navigation. No dialog row wraps. |

Console: the only error was the expected pre-login `whoami` 401. No OS-level chord interception was seen (the browser ran under WSL, with no GNOME workspace bindings).
