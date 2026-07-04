# SQL Admin — six feature updates

## Context

Six independent improvements to the SQL Admin frontend (`/home/jika/typescript/sqladmin/frontend`) and its
sibling component library (`/home/jika/typescript/typescript-ui`, symlinked as `@jimka/typescript-ui`):

1. **Rail click semantics** — single-click currently opens+executes a data tab; it should only *select* and show
   the record in the properties panel. Double-click (new) opens+executes the tab. Context menu gains a **Show data**
   item that does the double-click action. Applies to both the Databases and Roles rails.
2. **Accordion regression** — when a panel expands, the sibling above *snaps* to its final size instead of animating.
3. **Menubar background** — library default: MenuBar should share ToolBar's background color.
4. **About button** — far-right of the sqladmin menubar, opening an informational dialog.
5. **localStorage viewer** — a Tools-menu action opening a **Window** that shows what's in localStorage and can clear it.
6. **Keyboard shortcuts** — the six chords in the table below.

Decisions taken with the user: localStorage viewer = **Window** (non-modal, resizable); Explain Analyze =
**Ctrl+Shift+E** (Ctrl+A would break select-all); Refresh = **Alt+R**, and the Roles rail moves to **Alt+O** to free it.

Final shortcut map: Alt+D = Databases rail · Alt+O = Roles rail · Alt+Q = Queries rail ·
Ctrl+E = Explain · Ctrl+Shift+E = Explain Analyze · Alt+R = Refresh active view.

---

## 1. Rail click semantics + "Show data" context item

**Library change — add a double-click event to the Tree** (there is none today; Tree emits only
`"selection"` on the first click). In `typescript-ui/src/typescript/lib/component/tree/Tree.ts`:
- Extend `TreeEvent` (`Tree.ts:20`) with `"dblclick"`, and add the `on()` overload / listener typing
  (mirror the existing `"selection"` entries at `Tree.ts:57-61` and `:343-374`).
- In `init` (near the existing click/contextmenu wiring at `Tree.ts:1180-1190`) add
  `Event.addSubtreeListener(this, "dblclick", …)` → a new `_handleDblClick` that resolves the row index the way
  `_handleClick` (`Tree.ts:798-842`) does and `emit("dblclick", node)`. Selection already fires on the first click,
  so no need to also re-select here.

**Databases rail** — `frontend/src/navigator/NavigatorTree.ts`:
- In the `"selection"` handler (`:50-65`), for a relation call `controller.showProperties(ref)` **instead of**
  `controller.openTable(ref, node)` — i.e. always select + populate the properties panel, never open a tab.
  (`showProperties` at `SqlAdminController.ts:726-755` already fetches/reuses relation columns.)
- Add `tree.on("dblclick", node => …)` that calls `controller.openTable(ref, node)` for relations (the old
  single-click behaviour, incl. `store.load()` at `SqlAdminController.ts:228`).
- Add a **Show data** item at the top of the context-menu `items` array (`:77-81`) →
  `() => void controller.openTable(ref, node)`. Double-click and the menu item share `openTable`.

**Roles rail** — `frontend/src/roles/RolesTree.ts` + `SqlAdminController.ts`:
- Split `showRole` (`SqlAdminController.ts:772-787`, currently shows properties **and** opens the grants tab) into
  a properties-only path and the tab path. Add `showRoleProperties(name)` = fetch detail + `rolesProperties.show(detail)`
  (reuse the `_roleSeq` guard). Keep `showRole` (properties + `openRoleGrants`) for double-click.
- `"selection"` handler (`RolesTree.ts:17-23`) → `controller.showRoleProperties(name)` (no tab).
- Add `tree.on("dblclick", …)` → `controller.showRole(name)` (properties + grants tab).
- Add a **Show data** item to the roles context menu (`RolesTree.ts:30-43`) → `controller.openRoleGrants(...)`
  (via `showRole` or a direct grants-open helper).

---

## 2. Accordion animation regression

**Root cause (confirmed):** in `Accordion.ts` `doLayout`, the panel **content** component's height is written
directly with **no CSS transition** (`Accordion.ts:1258-1262`, the write at `:1261`), while only the *wrapper* gets a
`height` transition (`buildWrapperTransition`, `Accordion.ts:1080-1087`, `:1545-1547`). A growing panel looks smooth
because its `overflow:hidden` wrapper clips content that stays ≥ the wrapper; but a sibling that must **shrink**
(fill-mode redistribution, added in commit `f2d9ca77`, at `Accordion.ts:1246-1248`) has its content jump to the final
smaller height on frame 1 → the "snap". Reverse (grow-on-collapse) is masked by the clip, matching the user's hunch.

**Fix:** give the content component the **same `height` transition as its wrapper** for open sections, so content and
wrapper animate in lockstep. In `createSection` where the wrapper transition is installed (`Accordion.ts:1080-1087`),
install the equivalent transition on the content component too (reuse `buildWrapperTransition`'s property/duration/easing),
and mirror whatever enable/disable gating the wrapper uses in `primeWrapper` (`Accordion.ts:1482-1528`) so content
animates **only during toggle motion**, not during live window-resize drags. Closed sections keep content at
`contentPref` (`Accordion.ts:1251`) and are unaffected. Verify with `AccordionDemoPanel.ts` in the library.

---

## 3. Menubar background = toolbar background (library default)

MenuBar defaults to `transparent` (`MenuBar.ts:72`, token `--ts-ui-menu-bar-bg`); ToolBar defaults to grey
(`ToolBar.ts:87`, token `--ts-ui-toolbar-bg`). The `--ts-ui-menu-bar-bg` token is consumed **only** by MenuBar.

**Change:** set each shipped theme's `menuBar.background` to that theme's `toolBar.background` value (keeps the
token semantics and stays dark-theme-correct, where the toolbar is `rgb(45,45,45)`):
- `ClassicTheme.ts:169` (menuBar) → match `:194` (toolBar) `rgb(245,245,245)`
- `ModernTheme.ts:183` → match `:208` `rgb(245,245,245)`
- `DarkTheme.ts:168` → match `:193` `rgb(45,45,45)`

Leave the separate `menuBar.border`/`--ts-ui-menu-bar-border` token as-is.

---

## 4. About button (far-right menubar)

**New file** `frontend/src/shell/aboutDialog.ts` exporting `openAboutDialog(): void`, using `Dialog`
(pattern from `frontend/src/dock/FilterDialog.ts:140` / `promptQueryName.ts`): a `contentComponent` Panel of text
lines + a single **Close** button (`DialogButtons.Close`). Draft content (author from git; adjust freely):
- **SQL Admin** — a browser-based PostgreSQL administration & query tool: browse databases, schemas, tables and
  roles; run, explain and export SQL.
- Author: **Jimmy Karlsson**
- Source: `github.com/jimka/sqladmin`
- Built on the **@jimka/typescript-ui** component library: `github.com/jimka/typescript-ui`

**Pin to far right** — in `buildMenuBar` (`frontend/src/shell/SqlAdminShell.ts:251-282`), after the
`MenuBar({ menus })` factory runs, append a flex spacer then the About button:
`menubar.addComponent(Spacer.flex())` (`Spacer.flex` at `typescript-ui/.../Spacer.ts:106`) then
`menubar.addComponent(aboutButton)`. MenuBar's HBox already has stretching enabled (`MenuBar.ts:67-70`); this is the
same mechanism ToolBar uses. Safe because the app builds menus only once (never re-calls `setMenus`, which would wipe
children). The About button's `action` calls `openAboutDialog()`.

---

## 5. localStorage viewer Window (Tools menu)

**New file** `frontend/src/shell/localStorageWindow.ts` exporting `openLocalStorageWindow(): void`, using `Window`
(`typescript-ui/src/typescript/lib/overlay/Window.ts`; usage pattern in `MiscPanel.ts:205-260`):
`new Window("Local Storage")`, `setWidth/Height`, `setContentFactory(() => buildContent())`, `show()`.

Content (self-contained on `window.localStorage`): enumerate keys, pretty-print each value's JSON in a scrollable
area, highlighting the app's keys — exactly `sqladmin.history.default` (run history) and `sqladmin.saved.default`
(saved queries), per `frontend/src/data/queryStore.ts:47-48`. Provide a **Clear** action (remove the `sqladmin.*`
keys via `localStorage.removeItem`, then rebuild the content). History reads fresh each `list()` so no cache
invalidation needed; note the Queries rail may need a manual refresh to reflect a clear.

**Wire into Tools menu** — mirror the existing `onExportResults` wiring:
- Add `onShowLocalStorage: () => void` to `MenuBarActions` (`SqlAdminShell.ts:223-238`).
- Add a `{ text: "Show localStorage…", action: actions.onShowLocalStorage }` entry to the Tools menu items provider
  (`SqlAdminShell.ts:260-277`).
- Pass `onShowLocalStorage: () => openLocalStorageWindow()` at the `buildMenuBar({...})` call site
  (`SqlAdminShell.ts:71-79`).

---

## 6. Keyboard shortcuts

Extend the existing document-level accelerator system: chord helpers in `frontend/src/shell/queryShortcuts.ts`
and dispatch branches in `installQueryAccelerators` (`frontend/src/shell/SqlAdminShell.ts:87-113`, `document`
keydown at `:100`; `sidebar` is in scope). All `preventDefault()` on match.

**Rail chords** (Alt family, like Alt+N/S/H) — add `isAltChord`-based helpers and branches:
- Alt+D → `sidebar.selectView(DATABASE_VIEW_ID)` (`"database"`)
- Alt+O → `sidebar.selectView(ROLES_VIEW_ID)` (`"roles"`)
- Alt+Q → `sidebar.selectView(QUERIES_VIEW_ID)` (`"queries"`)

(`selectView` is `ActivityBarHandle.selectView`, `ActivityBar.ts:65-74`, `:132-137`; view-id constants at
`SqlAdminShell.ts:47-49`.)

**Explain chords** (editor-scoped — the Explain engine is local to `QueryPanel`'s closure with no controller entry
point). Add to the existing editor keydown block (`frontend/src/dock/QueryPanel.ts:470-499`, alongside Ctrl+Enter):
- Ctrl+E → `runExplainRun(false)` (`QueryPanel.ts:361`)
- Ctrl+Shift+E → `runExplainRun(true)` (Explain Analyze; already guarded by `isReadOnlyStatement`)

Editor-scoping makes these inherently act on the active query view and sidesteps any select-all clash.

**Refresh chord** (Alt+R, global). Refresh today is per-section/panel closures with no global concept
(`refreshTool.ts:12`; rail refreshes from `NavigatorTree`/`RolesTree`/`QueriesView`; grids refresh inline in
`TableWorkPanel.ts:99` / `ViewWorkPanel.ts:113`). Add a small **active-refresh seam** mirroring the export-active
pattern (`SqlAdminController.ts:471-478`, `_activePanelId` set on Dock `"focus"` at `:145-148`):
- A `refreshActive()` on the controller that prefers the active data-grid panel's refresh closure, falling back to
  the active rail's refresh.
- Register each refreshable data-grid panel's refresh closure keyed by panel id when it's created (Table/ViewWorkPanel);
  track the active rail's refresh where `sidebar.selectView` runs. If no refreshable target is active, Alt+R is a no-op.
- `installQueryAccelerators` Alt+R branch → `controller.refreshActive()`.

**Discoverability (optional):** update the display-only `shortcut` labels on the corresponding menu items
(`MenuItemConfig.shortcut`, `MenuItem.ts:47-48`) — e.g. rail items in the View menu, Explain items — so the chords show
in the menus.

---

## Files touched (summary)

**typescript-ui (library):**
- `lib/component/tree/Tree.ts` — add `"dblclick"` event.
- `lib/layout/Accordion.ts` — animate content height in lockstep with wrapper.
- `lib/core/themes/{ClassicTheme,ModernTheme,DarkTheme}.ts` — menuBar background = toolBar background.

**sqladmin frontend (app):**
- `navigator/NavigatorTree.ts`, `roles/RolesTree.ts` — single/double-click split + "Show data" menu item.
- `SqlAdminController.ts` — `showRoleProperties`, `refreshActive` + active-refresh registration.
- `shell/SqlAdminShell.ts` — About button (far-right), Tools "Show localStorage…", rail/refresh accelerators.
- `shell/queryShortcuts.ts` — new chord helpers.
- `dock/QueryPanel.ts` — Ctrl+E / Ctrl+Shift+E in the editor keydown block.
- `dock/TableWorkPanel.ts`, `dock/ViewWorkPanel.ts` — register refresh closures for Alt+R.
- **new** `shell/aboutDialog.ts`, **new** `shell/localStorageWindow.ts`.

---

## Verification

- **Build/typecheck:** `cd frontend && npm run typecheck` (both packages compile via the symlink).
- **Unit tests:** `cd frontend && npm test` (vitest) — the node harness can't drive DOM, so behavioural checks are manual.
- **Manual (run `npm run dev` in `frontend`, drive in the browser):**
  1. Rails: single-click a table → only the properties panel updates, no new tab. Double-click → data tab opens and
     loads. Right-click → **Show data** opens the tab. Repeat on the Roles rail (properties vs grants tab).
  2. Accordion: expand a panel with an open sibling above (fill mode) → the sibling **animates** its resize, no snap;
     collapse and confirm the reverse.
  3. Menubar now shares the toolbar's background in Classic/Modern/Dark themes.
  4. About button sits far-right; opens the dialog; Close dismisses.
  5. Tools → Show localStorage… opens a movable/resizable Window listing `sqladmin.history.default` /
     `sqladmin.saved.default`; Clear empties them and the display refreshes.
  6. Shortcuts: Alt+D/O/Q switch rails; Ctrl+E / Ctrl+Shift+E run Explain / Explain Analyze in the active query
     editor; Alt+R refreshes the active grid/rail. Confirm select-all still works in the editor and lists.
- Consider the `/verify` skill on the click-semantics and accordion changes (they have the most runtime surface).
