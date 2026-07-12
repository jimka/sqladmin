---
depends-on: [class-first-shell-views]
touches-shared: [frontend/src/shell/SqlAdminShell.ts]
---

# Class-First `SqlAdminShell` — Implementation Plan

## Overview

Convert the app's composition root from the builder factory
`export function SqlAdminShell(controller): Container`
([`frontend/src/shell/SqlAdminShell.ts:82`](frontend/src/shell/SqlAdminShell.ts#L82))
to the class-first form `export class SqlAdminShell extends Container`, following
`frontend/COMPONENT_CONVENTIONS.md` and the in-repo precedents
[`ActivityBar`](frontend/src/shell/ActivityBar.ts) and
[`LoginForm`](frontend/src/shell/LoginForm.ts).

The shell assembles four regions with a `Border` layout: the `MenuBar` (NORTH), a
`Split`-hosted work area (CENTER) that places the `ActivityBar` sidebar left of a
`Card`-deck Dock/StartPage, and the controller-owned `StatusBar` (SOUTH). It also
installs global keyboard accelerators and wires two controller hooks
(`setShowQueriesView`, and — via `buildCenterDeck` — `setStartToggle`).

This is a pure structural conversion: **no behaviour changes, no new public API,
and no new instance state.** The shell has no post-construction API — the call
site mounts it and never calls a method on it — so the class needs **zero private
fields**; it is a single constructor that builds locals, calls `super()`, and
wires side-effects. The only edits are (1) the factory → class shell, and (2) the
single call site in
[`frontend/src/SqlAdminApp.ts:31`](frontend/src/SqlAdminApp.ts#L31), which gains a
`new`.

Sequence **after** `class-first-shell-views` (`depends-on`): that plan converts
`DatabaseExplorerView` / `RolesExplorerView` / `QueriesView` / `StartPage` to
classes and rewrites their construction *inside this same file* (the module-level
`buildSidebar` / `buildCenterDeck`) from factory calls to `new`. Both plans edit
`SqlAdminShell.ts` (`touches-shared`); because shell-views lands first, this plan
**preserves** the `new View(...)` call sites it introduced and only wraps the file
into a class.

---

## Architecture Decisions

### Extend `Container`, not `Panel`

The current factory returns `Container({ layoutManager: new BorderLayout({ spacing: 0 }), … })`.
Extend the same callable base, `Container` (already imported at
[`SqlAdminShell.ts:19`](frontend/src/shell/SqlAdminShell.ts#L19)). Per
`COMPONENT_CONVENTIONS.md` (a), `Panel` would silently add a 4px content inset;
the shell wants zero insets so its regions meet the viewport edges. `ActivityBar`
extends `Container` for the identical reason.

### No private fields, no stored `controller`/`sidebar`

Nothing on the shell instance is read after construction: the call site does
`Body.getInstance().addComponent(new SqlAdminShell(controller))` and never touches
it again, and no shell method exists to reference stored state. `controller` and
`sidebar` are used only *during* construction, as constructor-scope locals. So the
class declares **no fields** — do not add `private controller` / `private sidebar`
"just in case." (Contrast `ActivityBar`, which stores `card`/`rail`/… because its
public arrow methods use them; the shell has no such methods.)

### Every helper stays a module-level function — forced by the super-cascade

`super()` for a `Border` container takes its children in the `components` option,
so `menuBar` and `workArea` must exist as **locals before `super()`**, where
`this` is unavailable (`COMPONENT_CONVENTIONS.md` (b)). Therefore the
component-producing builders **cannot** be instance methods — an instance method
called pre-`super()` would touch a non-existent `this`. And since none of them
touch `this` anyway (each takes what it needs as parameters), the convention's
"stateless helpers … can stay ordinary module-level functions" rule (end of
section (c), the `save_`/`confirmDelete` precedent in `TableWorkPanel`) applies
uniformly. Decision **per helper**:

| Helper | Disposition | Why |
|---|---|---|
| `buildSidebar(controller, onLogout)` | **module-level function** (unchanged shape) | Runs pre-`super()` (the `sidebar` local feeds `buildWorkArea` and the menu callbacks); no `this`. |
| `buildWorkArea(sidebar, controller)` | **module-level function** (unchanged shape) | Produces the CENTER local; no `this`. |
| `buildCenterDeck(controller)` | **module-level function** (unchanged shape) | Called by `buildWorkArea`; no `this`. |
| `buildMenuBar(actions)` | **module-level function** (unchanged shape) | Produces the NORTH local; no `this`. |
| `installAccelerators(controller, sidebar)` | **module-level function** (unchanged shape) | Registers a global side-effect, not a super-component; takes params, no `this`. |
| `MenuBarActions` interface | **module-level** (unchanged) | A parameter type. |
| `Glyph.register(...)` calls (lines 67–69) | **module top-level** (unchanged) | Import-time side-effect; runs once on module load. |

The upshot: the *bodies* of these helpers do not move — only `SqlAdminShell`
itself changes from `function` to `class`, and the helper calls that were inside
the factory body move into the constructor.

### Callbacks held by reference are already safely bound — no shell arrow fields

The task's binding concern resolves to "already handled," because the shell stores
no state and thus no handler needs the shell's `this`:

- **Menu action callbacks** (`onNewQuery: () => controller.openQuery()`, …) are
  inline arrows that capture the constructor-scope `controller`/`sidebar` locals
  lexically. Built as a local `MenuBarActions` object passed to `buildMenuBar`,
  they are safe by reference without being fields on the shell.
- **`onToggleSidebar: sidebar.toggleCollapsed`** — `toggleCollapsed` is already a
  public arrow field on `ActivityBar` ([`ActivityBar.ts:208`](frontend/src/shell/ActivityBar.ts#L208)),
  so it survives being passed by reference.
- **The `document` keydown listener** inside `installAccelerators` is already an
  inline arrow (`(event) => { … }`) capturing the `controller`/`sidebar`
  parameters lexically. This is the "**otherwise bound**" case in
  `COMPONENT_CONVENTIONS.md` (c): it needs no `this`, so it stays an inline arrow
  and `installAccelerators` stays a module-level function. Do **not** promote it
  to a shell arrow field — that would force introducing `this.controller` /
  `this.sidebar` fields the shell otherwise doesn't need.
- **The `SidebarSizer` closure** (`buildWorkArea`, lines 206–242) whose
  `collapse`/`expand` are held by `ActivityBar` via `sidebar.setSizer(sizer)` is an
  object literal closing over the `split`/`pane`/`center` locals and a
  closure-local `let lastWidth`. It captures lexical scope, not `this`, so it works
  by reference unchanged. Keep it exactly as a local closure inside `buildWorkArea`
  — `lastWidth` stays session-scoped closure state; do **not** hoist it to a shell
  field.

### Internal `Container({ … })` calls stay callable

`buildWorkArea` and `buildCenterDeck` build helper containers via the **callable**
factory (`Container({ layoutManager: split })`,
[`SqlAdminShell.ts:186`](frontend/src/shell/SqlAdminShell.ts#L186),
[`:262`](frontend/src/shell/SqlAdminShell.ts#L262)). Those are not the shell — leave
them as callable `Container({...})`. Only the top-level `SqlAdminShell` extends
`Container`. Likewise leave `new Split(...)`, `new Card()`, `MenuBar({...})`,
`Button({...})`, `Spacer.flex()` exactly as they are.

### Post-`super()` wiring order is behaviour-neutral

The two side-effects `controller.setShowQueriesView(() => sidebar.selectView(QUERIES_VIEW_ID))`
and `installAccelerators(controller, sidebar)` currently run *before* the
`Container({...})` is built (lines 94–95). Neither touches `this` nor feeds the
`components` array, and neither is observed by the `super()` cascade, so moving
them to run **after `super()`** (per convention (b) step 3, "wiring after
`super()`") is safe and does not change behaviour. Place them after `super()`
using the still-in-scope `controller`/`sidebar` locals.

### Rewrite the stale file-header comment

The header (lines 1–17) still explains why the shell "is built as a callable
factory." After conversion that rationale is gone — rewrite the header to describe
the class-first shell (`extends Container`, the instance is the mountable
component), keeping the accurate region/`Split`/`SidebarSizer` description
(lines 1–10). Do not carry over the "Built as a callable factory … not-yet-migrated
holdover" paragraph (lines 12–17).

---

## Internal Structure

Target shape of the constructor (helper bodies unchanged, shown elided):

```ts
export class SqlAdminShell extends Container {
    constructor(controller: SqlAdminController) {
        // Signs out: drop the server session and reload to the login dialog.
        const onLogout = (): void => { void logout().then(() => window.location.reload()); };

        // Locals needed by super()'s components array (pre-super — no `this` yet).
        const sidebar  = buildSidebar(controller, onLogout);
        const workArea = buildWorkArea(sidebar, controller);
        const menuBar  = buildMenuBar({
            onToggleSidebar    : sidebar.toggleCollapsed,
            onNewQuery         : () => controller.openQuery(),
            onOpenSaved        : () => controller.showQueriesView("saved"),
            onQueryHistory     : () => controller.showQueriesView("recent"),
            onExportResults    : format => controller.exportActive(format),
            activeExportKind   : () => controller.activeExportKind(),
            canExportActive    : () => controller.canExportActive(),
            onOpenDocumentation: () => controller.openDocumentation(),
            onShowLocalStorage : () => openLocalStorageWindow(),
            onShowShortcuts    : () => openShortcutsDialog(),
            onAbout            : () => openAboutDialog(),
            onShowDatabases    : () => sidebar.selectView(DATABASE_VIEW_ID),
            onShowRoles        : () => sidebar.selectView(ROLES_VIEW_ID),
            onShowQueries      : () => sidebar.selectView(QUERIES_VIEW_ID),
            onRefresh          : () => controller.refreshActive(),
        });

        super({
            layoutManager: new BorderLayout({ spacing: 0 }),
            components: [
                { component: menuBar,             constraints: { placement: Placement.NORTH } },
                { component: workArea,            constraints: { placement: Placement.CENTER } },
                { component: controller.statusBar, constraints: { placement: Placement.SOUTH } },
            ],
        });

        // Post-super() wiring (no `this` required; see Architecture Decisions).
        controller.setShowQueriesView(() => sidebar.selectView(QUERIES_VIEW_ID));
        installAccelerators(controller, sidebar);
    }
}

// buildSidebar / buildWorkArea / buildCenterDeck / buildMenuBar /
// installAccelerators and the MenuBarActions interface remain module-level,
// bodies unchanged (except buildSidebar/buildCenterDeck already use `new View(...)`
// after class-first-shell-views).
```

---

## Ordered Implementation Steps

1. **Precondition:** confirm `class-first-shell-views` has landed —
   `grep -n "new DatabaseExplorerView\|new RolesExplorerView\|new QueriesView\|new StartPage" frontend/src/shell/SqlAdminShell.ts`.
   If those constructions are still bare factory calls, that plan has not run;
   `depends-on` should have ordered it first. This plan does **not** convert the
   views and must not revert their `new`.

2. **`frontend/src/shell/SqlAdminShell.ts` — header comment.** Replace lines 1–17
   with a class-first description: the shell `extends Container`, the instance is
   the mountable component, keeping the region/`Split`/`SidebarSizer` explanation
   from lines 1–10. Drop the factory-rationale paragraph (lines 12–17).

3. **Same file — convert the factory to a class.** Replace the
   `export function SqlAdminShell(controller: SqlAdminController): Container { … }`
   declaration (lines 82–124) with `export class SqlAdminShell extends Container`
   containing a single `constructor(controller: SqlAdminController)`, per
   *Internal Structure*:
   - Move `onLogout`, `sidebar`, `workArea`, and the `menuBar` (built from the
     inline `MenuBarActions` object) into locals **before** `super()`.
   - Call `super({ layoutManager: new BorderLayout({ spacing: 0 }), components: [ NORTH menuBar, CENTER workArea, SOUTH controller.statusBar ] })`.
   - After `super()`, call `controller.setShowQueriesView(() => sidebar.selectView(QUERIES_VIEW_ID))` then `installAccelerators(controller, sidebar)`.
   - Declare **no** fields.

4. **Same file — leave helpers untouched.** `buildSidebar`, `buildWorkArea`,
   `buildCenterDeck`, `buildMenuBar`, `installAccelerators`, `MenuBarActions`, and
   the two `Glyph.register` calls stay module-level with unchanged bodies. Confirm
   the internal `Container({...})` calls in `buildWorkArea`/`buildCenterDeck` and
   `new Split`/`new Card` remain as-is.

5. **`frontend/src/SqlAdminApp.ts:31` — add `new`.** Change
   `Body.getInstance().addComponent(SqlAdminShell(controller));` to
   `Body.getInstance().addComponent(new SqlAdminShell(controller));`. The import at
   line 10 is unchanged (named import of the class).

6. **Grep invariants:**
   - `grep -rn "SqlAdminShell(" frontend/src` — expect exactly one construction,
     `new SqlAdminShell(controller)` in `SqlAdminApp.ts`; the factory-style call is
     gone.
   - `grep -n "export class SqlAdminShell extends Container" frontend/src/shell/SqlAdminShell.ts` — expect one match.
   - `grep -n "private " frontend/src/shell/SqlAdminShell.ts` — expect no field
     declarations inside the class (helpers are module-level).

7. **Typecheck:** `npx tsc --noEmit` from `frontend/` — expect clean.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/shell/SqlAdminShell.ts` (factory → `class … extends Container`; header comment; **shared** with `class-first-shell-views`) |
| Modify | `frontend/src/SqlAdminApp.ts` (call site gains `new`) |

---

## Expected Behaviour

No behaviour changes from the current build — this is a structural conversion. All
cases are DOM/event/geometry driven and thus **manual-verify** (the unit harness
cannot exercise layout, keyboard events, or drag). Drive them in the running app
(mount reached via `SqlAdminApp` after login).

- **Shell renders all four regions** — MenuBar across the top (NORTH), the
  ActivityBar sidebar at the left of the CENTER split, the Dock/StartPage deck
  filling the rest of CENTER, and the StatusBar along the bottom (SOUTH).
  *(manual)*
- **Accelerators fire** — each global chord invokes its handler and suppresses the
  browser default, unchanged from before: New Query, Databases / Roles / Queries
  rail switches, Refresh, Open Saved, Query History, and the shortcuts/help chord
  (the `is*Chord` predicates from `queryShortcuts.ts`, i.e. the Alt+D/O/Q/R/N/S/H
  family plus Help). An unmatched key passes through with its default intact.
  *(manual — keyboard events)*
- **Toggle Sidebar** — the View → Toggle Sidebar menu item collapses/expands the
  sidebar (drives `ActivityBar.toggleCollapsed` by reference through the menu
  callback). *(manual)*
- **Sidebar collapse/expand via the `SidebarSizer`** — clicking the active rail
  icon (or toggling) pins the sidebar to the rail width and lets the Dock reclaim
  the space; re-expanding restores the last width; the gutter stays drag-resizable
  and cannot shrink the sidebar below the rail floor. *(manual — layout + drag)*
- **StartPage deck** — the start page shows when the workspace is empty and yields
  to the Dock when a panel opens (`controller.setStartToggle` still wired via
  `buildCenterDeck`). *(manual)*
- **CSS class name** — the mounted root now reports `constructor.name ===
  "SqlAdminShell"` instead of the generic `"Container"` (convention (e)); no app
  CSS targets the old name (verified: no `.css` files and no `.Container` selectors
  under `frontend/src`), so nothing breaks. *(manual — inspect the DOM class)*

---

## Verification

- **Typecheck:** `npx tsc --noEmit` in `frontend/` — clean.
- **Build:** `npm run build` (Vite) in `frontend/` — succeeds; note `vite.config.ts`
  sets `esbuild.keepNames: true`, so `constructor.name` survives minification.
- **Grep invariants:** the three greps in step 6.
- **Manual smoke test:** run the app (login → shell mounts), then walk the
  *Expected Behaviour* list — render of all four regions, each Alt-chord, Toggle
  Sidebar, rail collapse/expand + gutter drag, and StartPage ↔ Dock switching.

**Performed at implementation time:** the dev server was launched against the
already-running seed-DB/backend Docker stack and driven through
`chrome-devtools` (an already-authenticated session, so the shell mounted
directly). All four regions rendered — MenuBar (NORTH) with Query/Tools/View
menus and Shortcuts/About buttons, the ActivityBar rail + sidebar (WEST) with
the Databases tree open by default, the Dock/StartPage deck (CENTER), and the
StatusBar (SOUTH) showing `Connection: default` / `sqladmin`. `document
.querySelector('[class*="SqlAdminShell"]').className === "SqlAdminShell"`
confirmed convention (e) took effect (not the generic `"Container"`).
Every accelerator in the Alt+D/O/Q/R/N/S/H + Help family was exercised via
`press_key` and screenshotted: **Alt+N** opened a new Query tab, replacing
StartPage with the Dock (confirms the CENTER Card-deck toggle);
**Alt+O**/**Alt+Q**/**Alt+D** switched the sidebar to Roles/Queries/Databases
respectively; **Alt+S** switched to Queries with the Saved section expanded;
**Alt+R** fired with no console error; **`?`** (Help) opened the Keyboard
Shortcuts dialog, closed cleanly via its Close button. **View → Toggle
Sidebar** collapsed the sidebar to the rail width (Dock reclaimed the space)
and, toggled again, re-expanded to the prior width. Clicking the **active
rail icon** independently collapsed/re-expanded the sidebar (the
`SidebarSizer` path). A synthetic `mousedown`/`mousemove`/`mouseup` sequence
on the `.SplitGutter` element dragged the gutter from `x=280` to `x=360`,
confirming the Split-hosted gutter is still drag-resizable post-conversion.
`list_console_messages` showed only the two expected Vite HMR debug lines
(`connecting…` / `connected.`) throughout — no runtime errors at any step.

---

## Potential Challenges

- **Shared-file coordination with `class-first-shell-views`.** Both plans edit
  `SqlAdminShell.ts`. `depends-on` orders shell-views first (it rewrites the view
  constructions to `new`). When restructuring the file into a class, keep those
  `new View(...)` call sites intact — step 1's grep guards this.
- **Super-cascade ordering.** `menuBar` and `workArea` must be built *before*
  `super()`; the menu-callback object references the `sidebar` local, so `sidebar`
  must be built first. The *Internal Structure* ordering (onLogout → sidebar →
  workArea → menuBar → super → wiring) satisfies every dependency.
- **Resisting over-conversion.** The natural instinct to make the `Container({...})`
  helper calls `new`, or to promote helpers to methods/fields, is wrong here — the
  super-cascade forbids pre-`super()` methods and the shell has no state. Follow
  the per-helper table exactly.

---

## Critical Files

- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — the
  class-first rules: (a) extend the callable base, (b) super-cascade, (c) arrow
  fields vs. module functions, (d) the instance is the component, (e)
  `constructor.name` → CSS class.
- [`frontend/src/shell/ActivityBar.ts`](frontend/src/shell/ActivityBar.ts) —
  worked `extends Container` precedent (arrow fields, `BorderLayout({spacing:0})`).
- [`frontend/src/shell/LoginForm.ts`](frontend/src/shell/LoginForm.ts) — the
  locals → `super({ components })` → field-assignment template.
- [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts) —
  the file being converted; its stale header already notes subclassing is
  supported and the factory is a holdover.
- [`frontend/src/SqlAdminApp.ts`](frontend/src/SqlAdminApp.ts) — the sole call site.

---

## Non-Goals

- **Converting the views** (`DatabaseExplorerView`, `RolesExplorerView`,
  `QueriesView`, `StartPage`) — owned by `class-first-shell-views`; this plan only
  consumes their `new`-able form.
- **Adding shell state or public API** — the shell stays a stateless composition
  root; do not introduce fields, getters, or methods.
- **Touching the internal helper container/`Split`/`Card`/`MenuBar` construction
  styles** — only the top-level shell changes base-class treatment.
- **Reworking the accelerator, menu, or SidebarSizer logic** — behaviour is
  preserved verbatim.
