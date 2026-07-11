# Class-First Components — Pilot & Pattern — Implementation Plan

## Context

The sqladmin frontend is **builder-first**: ~30 UI modules are capitalized factory functions (`ActivityBar()`, `TableWorkPanel()`, `SqlAdminShell()`, …) that `new` up library primitives, wire event listeners and sync closures, and return a bare `Container`/`Component` or a hand-rolled handle object. Only 4 UI modules are class-first, and every one **extends a library base** (`LoginForm extends Form`, `PropertiesPanel extends PropertyValuePanel`).

The user wants to move toward **class-first** components — declaring components as classes that extend the library's base types — the shape `LoginForm` already uses. Two facts make now the right time:

1. **The historical blocker is gone.** The top-level shell was deliberately written as a `callable()` factory (not `extends Panel`) because of a real library bug: the shipped `.d.ts` kept unresolved `~/*` path aliases that collapsed every library base class to `any` for external consumers, so subclasses inherited no members. The library fixed this by running `tsc-alias` after declaration emit (`LIBRARY_NOTES.md`, "External consumers couldn't subclass a library class" — "SqlAdminShell can subclass Panel again"). But the justifying comment at [SqlAdminShell.ts:12-15](frontend/src/shell/SqlAdminShell.ts#L12-L15) was never updated, so later builders kept following a premise that is no longer true.
2. **The library fully supports `extends`.** The `callable()` export is a `Proxy` that preserves `extends`/`instanceof` (`typescript-ui/src/typescript/lib/core/Callable.ts:37`); `LoginForm extends Form` is the working in-repo precedent.

This plan does **not** convert the whole layer. It is a **pilot** (per the user's choice): convert the two most representative closure-heavy builders to `extends`-a-library-base classes, and capture the resulting pattern in a short convention doc so the remaining ~28 modules can be migrated incrementally, as touched. The two pilots are chosen to exercise both canonical conversions: **ActivityBar** (a returned handle-of-closures over mutable state → a class instance) and **TableWorkPanel** (sync-closures registered on store/grid events → the "handler becomes an arrow field" case).

**Out of scope / non-goals** are listed at the end — the other 28 modules, `SqlAdminController` (already a class, and the mediator hub), and `SqlAdminShell` itself (kept as-is this round; only its stale comment is corrected).

---

## Architecture Decisions

### Extend `Container`, not `Panel`, for both pilots
Both current builders assemble a `Container` with a zero-spacing `Border`/`Card` layout and **no content insets**. `Panel` defaults to 4px insets (`Panel.ts` `_defaultPanelOptions`), which [ActivityBar.ts:195-198](frontend/src/shell/ActivityBar.ts#L195-L198) explicitly avoids so the rail width stays constant across collapse. `TableWorkPanel` goes through `workPanelShell`, which builds a `Container`. So the faithful base is **`Container`**, extended exactly as the library extends it internally (`class Container extends Component`). Import the callable `Container` from `@jimka/typescript-ui/core` and `extends` it — do **not** reach for the `_Container` raw alias (the library itself never imports the underscore aliases; the callable extends fine).

### Event handlers become **arrow-function fields**, not plain methods
This is the load-bearing rule the pilot establishes. A handler registered by reference — `store.on("datachange", this.syncSaveEnabled)` or `onToggleSidebar: sidebar.toggleCollapsed` — **loses its `this`** if it is a plain method (the reference is detached from the instance). So any closure-over-mutable-state that is *passed as a callback* becomes a **private arrow-function field** (`private syncSaveEnabled = (): void => { … }`), which captures `this` permanently. This mirrors the library's own `Form.handleSubmit`. Pure helpers only ever invoked as `this.foo()` (e.g. `showView` called from other methods) may stay plain methods — but when in doubt, prefer the arrow field, since it is safe under both call and reference.

### The super-cascade trap: build children as locals, wire `this` after `super()`
`this` is unavailable until `super()` returns, and the library's option cascade runs setters *during* `super()`. So: build child widgets as **locals**, pass layout via `super({ layoutManager })` (children can be added after), then assign instance fields, `addComponent(...)`, and wire listeners **in the constructor body after `super()`**. Fields that would be touched by the cascade use `declare` (not `= initializer`, which runs after `super()` and would clobber a cascaded value). `LoginForm.ts:24-57` is the canonical template. Neither pilot passes cascade-touched options, so plain field assignment after `super()` is sufficient; no `declare` needed.

### The instance *is* the component — call sites drop `.component`
`ActivityBar` currently returns a handle whose `.component` field is the mountable component. As a `Container` subclass, the instance itself is mountable, so callers use it directly (`const pane = sidebar;`). The `ActivityBarHandle` interface is deleted and its consumers re-typed to `ActivityBar`.

### `constructor.name` → CSS class name changes (acceptable)
The library derives a component's CSS class from `this.constructor.name`. Today an `ActivityBar()` result reports `"Container"`; the new class reports `"ActivityBar"` (and `"TableWorkPanel"`). This is a net improvement (more specific, self-documenting classes) and the prod build already sets `esbuild.keepNames: true` in `frontend/vite.config.ts`, so minification preserves the names. No app CSS currently targets the generic `.Container` class for these subtrees — **verify with a grep** (step check below) and confirm no visual regression manually.

---

## Public API

### `ActivityBar` — class replacing the builder + handle
```ts
export class ActivityBar extends Container {
    private readonly card:       Card;
    private readonly deck:       Container;
    private readonly rail:       ToolBar;
    private readonly buttonById: Map<string, ToggleButton>;
    private activeId:  string;
    private collapsed: boolean;
    private sizer:     SidebarSizer | null;

    constructor(views: ActivityView[], options?: ActivityBarOptions);

    /** Collapse the deck if expanded, or re-open the active view if collapsed. */
    toggleCollapsed(): void;              // arrow field — passed by reference by the shell
    /** Wire the Split-backed sizer once the shell has built the Split. */
    setSizer(sizer: SidebarSizer): void;  // arrow field — passed/held by the shell
    /** Select and expand a view by id. */
    selectView(id: string): void;         // wraps the private showView
}
```
Keep the existing exports unchanged: `ActivityView`, `ActivityBarOptions`, `SidebarSizer`, `SIDEBAR_RAIL_WIDTH`, `SIDEBAR_DEFAULT_WIDTH`. **Delete** the `ActivityBarHandle` interface.

`toggleCollapsed` and `setSizer` are **arrow-function fields** (the shell passes `sidebar.toggleCollapsed` by reference at [SqlAdminShell.ts:100](frontend/src/shell/SqlAdminShell.ts#L100)). `selectView` may be a plain method (only ever called as `sidebar.selectView(id)`), but making it an arrow field too is fine and consistent. Private `setCollapsed`, `showView`, `collapse` are plain methods (invoked as `this.*`).

### `TableWorkPanel` — class replacing the builder
```ts
export class TableWorkPanel extends Container {
    constructor(
        store: AjaxStore, columns: ColumnMeta[], notify: Notify,
        onExport: ExportTable, privileges: TablePrivileges,
    );
}
```
Public surface stays constructor-only (the controller mounts the instance as a dock tab's `content`). Internals — the toolbar buttons, `canWrite`, and the three sync handlers — become private fields/methods.

---

## Internal Structure

### ActivityBar constructor skeleton
```ts
constructor(views: ActivityView[], options: ActivityBarOptions = {}) {
    super({ layoutManager: new BorderLayout({ spacing: 0 }) });   // no insets: Container, not Panel

    this.card       = new Card();
    this.deck       = Container({ layoutManager: this.card });
    this.rail       = new ToolBar({ orientation: "vertical" });
    this.buttonById = new Map();
    this.activeId   = views[0].id;
    this.collapsed  = false;
    this.sizer      = null;

    for (const view of views) {
        this.deck.addComponent(view.component);
        const button = new ToggleButton("", { selected: view.id === this.activeId, glyph: view.glyph });
        button.pinGlyphSize(GLYPH_SIZE);
        Tooltip.attach(button, view.shortcut ? `${view.label} (${view.shortcut})` : view.label);
        button.on("action", () => (button.isSelected() ? this.showView(view.id) : this.collapse()));
        this.rail.addComponent(button);
        this.buttonById.set(view.id, button);
    }

    if (options.onSignOut) { /* Spacer.flex() + sign-out Button, verbatim from current lines 181-190 */ }

    this.rail.setPreferredSize(RAIL_WIDTH, 0);
    this.card.setVisibleComponentId(this.activeId);
    this.addComponent(this.rail, { placement: Placement.WEST });
    this.addComponent(this.deck, { placement: Placement.CENTER });
    this.setPreferredSize(RAIL_WIDTH + DECK_WIDTH, 0);
}
```
The four closures (`setCollapsed`/`showView`/`collapse`/`toggleCollapsed`) move out to methods/fields, bodies **unchanged** except `activeId`/`collapsed`/`sizer` become `this.activeId`/`this.collapsed`/`this.sizer` and `buttonById`/`card`/`deck` become `this.*`.

### TableWorkPanel constructor skeleton
```ts
constructor(store, columns, notify, onExport, privileges) {
    const dataGrid = Table(store, buildColumnSpec(columns, privileges.update));
    const toolbar  = /* build via the buttons below */;

    super({ layoutManager: new BorderLayout({ spacing: 0 }) });   // == workPanelShell's frame

    this.store = store; this.dataGrid = dataGrid; /* buttons, canWrite … */
    this.addComponent(toolbar,                                    { placement: Placement.NORTH });
    this.addComponent(Panel({ layoutManager: new Fit(), components: [dataGrid] }), { placement: Placement.CENTER });

    store.on("filterchange", this.syncFilterActive);
    store.on("datachange",   this.syncSaveEnabled);
    store.on("datachange",   this.syncDeleteEnabled);
    dataGrid.on("selection", this.syncDeleteEnabled);
    this.syncFilterActive(); this.syncSaveEnabled(); this.syncDeleteEnabled();
}

private syncSaveEnabled = (): void => { this.saveButton.setEnabled(this.canWrite && this.store.hasPendingChanges()); };
// syncFilterActive, syncDeleteEnabled likewise — arrow fields (registered by reference)
```
Because `super()` must precede `this`, build `dataGrid` and the toolbar as **locals before `super()`**, then assign to fields after. The toolbar buttons that the sync handlers toggle (`saveButton`, `deleteButton`, `filterButton`, `addButton`) must be reachable from the handlers — assign them to `this.*` after `super()` and have the (post-super) `.on`/`sync*` wiring read `this.*`. Keep `buildColumnSpec`, `save_`, `missingRequiredFields`, `confirmDelete` as module-level functions (they are stateless); the sync handlers are the only things that must become instance members.

> Note: inlining `workPanelShell`'s Border frame into the class (rather than calling it) is deliberate — the class *is* the frame now. `workPanelShell` stays for the not-yet-converted `ViewWorkPanel`/`RoleGrantsPanel`.

---

## Ordered Implementation Steps

1. **`frontend/src/shell/ActivityBar.ts`** — convert the builder to `export class ActivityBar extends Container`.
   - Import `Container` as the extended base (already imported for the callable use). Keep all other imports.
   - Move mutable locals → private fields; move the four closures → methods (`setCollapsed`/`showView`/`collapse` plain; `toggleCollapsed`/`setSizer`/`selectView` as public arrow-field/methods per Public API). Bodies unchanged except `this.` prefixes.
   - Delete the `ActivityBarHandle` interface and the returned object literal.
   - Check: `grep -n "ActivityBarHandle" frontend/src` — expect matches only in SqlAdminShell.ts (fixed next).

2. **`frontend/src/shell/SqlAdminShell.ts`** — update the one call site + types.
   - [Line 407](frontend/src/shell/SqlAdminShell.ts#L407): `return new ActivityBar([...], { onSignOut });` (add `new`; body unchanged).
   - Change the import at line 42 and the param types in `buildSidebar` (return type), `installAccelerators`, `buildWorkArea` from `ActivityBarHandle` → `ActivityBar`. Drop `ActivityBarHandle` from the import; keep `SidebarSizer`.
   - [Line 185](frontend/src/shell/SqlAdminShell.ts#L185): `const pane = sidebar;` (was `sidebar.component`).
   - [Line 100](frontend/src/shell/SqlAdminShell.ts#L100): if `toggleCollapsed` is kept an arrow field, `onToggleSidebar: sidebar.toggleCollapsed` works as-is; if it were a plain method it would break. This plan makes it an arrow field, so **no change needed** — but verify by typecheck. (`sidebar.selectView(...)` calls are method-call form, always safe.)
   - **Correct the stale comment** at lines 12-15: replace the "cannot subclass the callable Panel" rationale with a note that subclassing library bases is now supported (the `.d.ts`/`tsc-alias` fix, per `LIBRARY_NOTES.md`) and that the shell staying a factory is a not-yet-migrated holdover, not a constraint.

3. **`frontend/src/dock/TableWorkPanel.ts`** — convert the builder to `export class TableWorkPanel extends Container`.
   - Import `Container` (extend) and keep `Panel`, `Fit`, `Placement`(add), `Border`(add) — mirror `workPanelShell`'s imports for the inlined frame.
   - Constructor per skeleton: build `dataGrid` + toolbar buttons as locals, `super({ layoutManager: new BorderLayout({ spacing: 0 }) })`, assign fields, `addComponent` NORTH/CENTER, wire store/grid listeners to the three arrow-field handlers, prime them once.
   - The three `sync*` closures → private **arrow-function fields**; `buildToolBar`'s body folds into the constructor (buttons) + the fields. Keep `buildColumnSpec`/`save_`/`missingRequiredFields`/`confirmDelete` as module functions.
   - Check: `grep -n "workPanelShell" frontend/src/dock/TableWorkPanel.ts` — expect zero (frame is now inlined).

4. **`frontend/src/SqlAdminController.ts`** — update the one call site.
   - [Line 320](frontend/src/SqlAdminController.ts#L320): `() => new TableWorkPanel(store, columns, notify, format => this.exportTable(ref, format), privileges)` (add `new`). The result is a `Container`, so the `content:` usage is unchanged.

5. **Pattern doc — `frontend/COMPONENT_CONVENTIONS.md` (new).** A short doc capturing the class-first convention for the incremental migration of the remaining modules. Cover: (a) `extends` the callable library base (`Container`/`Panel`/`Form`); (b) the super-cascade trap (children as locals, `this` only after `super()`, `declare` for cascade-touched fields); (c) **event handlers = arrow-function fields** (the `this`-by-reference rule), pure helpers may be plain methods; (d) the instance *is* the component (no handle/`.component`); (e) `constructor.name` becomes the CSS class (keepNames already set). Cite `LoginForm.ts` as the template and the two pilots as worked examples.

6. **Cross-reference the doc.** Add a one-line pointer from `LIBRARY_NOTES.md` (near the existing "External consumers couldn't subclass a library class" section) to `frontend/COMPONENT_CONVENTIONS.md`, since that section is where the subclass-capability fix is already recorded.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/shell/ActivityBar.ts` (builder+handle → class; delete `ActivityBarHandle`) |
| Modify | `frontend/src/shell/SqlAdminShell.ts` (call site, types, stale comment) |
| Modify | `frontend/src/dock/TableWorkPanel.ts` (builder → class; inline the Border frame) |
| Modify | `frontend/src/SqlAdminController.ts` (add `new` at the one call site) |
| Create | `frontend/COMPONENT_CONVENTIONS.md` (class-first pattern doc) |
| Modify | `LIBRARY_NOTES.md` (one-line pointer to the new doc) |

---

## Expected Behaviour

Behaviour must be **identical** to today — this is a structural refactor, not a feature change. Pin these:

**ActivityBar** (mostly manual-verify — DOM/layout/events the vitest harness can't drive; see the DOM-side-effect memory):
- Constructing `new ActivityBar(views)` renders a WEST rail (icon-only ToggleButtons, one per view) + CENTER deck; the first view starts selected and expanded.
- Clicking an inactive view's button switches the deck to it and deselects the others; clicking the active button again collapses the deck (rail stays at `RAIL_WIDTH`).
- `toggleCollapsed()` collapses when expanded and re-opens the active view when collapsed — **and still works when passed by reference** as `onToggleSidebar: sidebar.toggleCollapsed` (the arrow-field guarantee; regression-critical).
- `selectView(id)` selects+expands that view; `setSizer(s)` then collapse/expand drives the shell Split's pane width (unchanged from today).
- Switching Databases↔Roles (expanded→expanded) does **not** change the sidebar width (the `setCollapsed` transition guard is preserved).

**TableWorkPanel** (mix — the privilege-gating logic is unit-testable via the existing suite; grid/DOM is manual):
- With full privileges: Add enabled, Delete enables on a live selection, Save enables when `hasPendingChanges()`, cells editable — identical to current tests.
- With no INSERT: Add stays disabled for the panel's life. No UPDATE: every column read-only. No DELETE: Delete stays disabled even with a selection. No write privileges at all: Save never enables. (These are exactly the current gating rules — the existing `TableWorkPanel` tests must pass unchanged against the class.)
- The three sync handlers fire on `store` `filterchange`/`datachange` and grid `selection` events **after** conversion (the arrow-field binding must not detach `this` — a plain-method regression would silently no-op them).

**Pure/logic (unit-testable now):** `buildColumnSpec(columns, canUpdate)` still returns `readOnly: !canUpdate || c.isGenerated` per column; `missingRequiredFields` unchanged. If these are extractable without DOM, add/keep node-vitest coverage per the `tsui-dom-module-side-effects` memory.

---

## Verification

- **Typecheck:** `cd frontend && npx tsc --noEmit` — 0 errors. This is the primary proof the `extends Container` subclass resolves inherited members against the **built** library `.d.ts` (the thing the old bug broke). If tsc still flags missing base members, stop — the `tsc-alias` fix may not be in the consumed build; surface it before proceeding.
- **Unit tests:** `cd frontend && npm test -- --run` — all 252 currently-passing tests stay green; the existing `TableWorkPanel` privilege-gating tests exercise the class unchanged.
- **Grep invariants:**
  - `grep -rn "ActivityBarHandle" frontend/src` → zero after step 2.
  - `grep -rn "ActivityBar(" frontend/src | grep -v "new ActivityBar\|class ActivityBar"` → zero (all call sites use `new`).
  - `grep -rn "TableWorkPanel(" frontend/src | grep -v "new TableWorkPanel\|class TableWorkPanel"` → zero.
  - `grep -rn "\.Container\b" frontend` (CSS/style) → confirm nothing targets the generic class for these subtrees (constructor-name change is safe).
- **Manual smoke (chrome-devtools MCP), signed in against the demo DB:**
  1. Activity rail: click Database/Roles/Queries icons — deck switches; click active icon — collapses; menu "Toggle Sidebar" and the Alt+D/Alt+R/Alt+Q chords still switch views (exercises the by-reference `toggleCollapsed` + `selectView`).
  2. Open a table as `app_service` (full CRUD): Add/Delete/Save/cell-edit all work; open one as `intern`/`analyst` (SELECT-only): Add+Save disabled, cells read-only, Delete stays disabled on selection.
  3. Confirm no visual shift in rail width across collapse/expand and no console errors.
- **Build:** `cd frontend && npm run build` — clean (confirms `keepNames` prod path with the new class names).

---

## Potential Challenges

- **Detached-`this` handlers** — the single biggest regression risk. Any `sync*`/`toggleCollapsed` left as a plain method but registered by reference silently no-ops. Mitigation: arrow-function fields for every by-reference handler; the manual smoke steps above specifically exercise the by-reference paths.
- **Super-cascade ordering** — referencing `this` before `super()` is a compile error; assigning a field with `=` that the cascade also sets would clobber it. Mitigation: locals-before-`super()`, plain field assignment after; neither pilot passes cascade-touched options so no `declare` is needed.
- **Stale `.d.ts` in the consumed library build** — if the app consumes a pre-`tsc-alias` build, `extends Container` could still degrade to `any`. Mitigation: the tsc step is the canary; if it fails on missing base members, rebuild/repoint the library per `LIBRARY_NOTES.md` before continuing.
- **`workPanelShell` divergence** — inlining its frame into `TableWorkPanel` means two frame definitions until the other panels convert. Acceptable for a pilot; the doc notes the eventual convergence.

---

## Critical Files

- `frontend/src/shell/LoginForm.ts` — the in-repo `extends`-a-library-base template to mirror (locals→`super({components})`→field assignment).
- `frontend/src/dock/workPanelShell.ts` — the Border frame `TableWorkPanel` inlines (import list to copy: `Container`, `Border`, `Placement`).
- `typescript-ui/src/typescript/lib/core/Panel.ts` / `Container.ts` / `Form.ts` — the library's own subclass idiom (`super(options, subclassDefaults)`, `applyOptions` override, post-`super` wiring) and the super-cascade-trap comments.
- `LIBRARY_NOTES.md` (§ "External consumers couldn't subclass a library class") — why `extends` was blocked and how it was fixed; the authority the stale SqlAdminShell comment contradicts.
- `frontend/vite.config.ts` — confirms `esbuild.keepNames: true` (the `constructor.name`→CSS-class safety net).

---

## Non-Goals

- **Converting the other ~28 builders** (`SqlAdminShell`, `QueryPanel`, the diagram panels, `NavigatorTree`/`RolesTree`, the shell views, the `open*Dialog` helpers). They migrate incrementally, as touched, guided by the new doc — not in this plan.
- **Converting `SqlAdminShell` itself.** Only its stale comment is corrected; the shell stays a factory this round to keep the pilot small and its blast radius contained.
- **Touching `SqlAdminController`** beyond the one `new` at the call site — it is already a class and is the mediator hub, not a conversion target.
- **A composition-wrapper style** (the `LoginDialog` shape that owns a field instead of extending). The chosen target is `extends`-a-library-base; composition is only the fallback where a base genuinely doesn't fit (e.g. owning a `Dialog`), and neither pilot is that case.
- **Renaming files or changing module public exports** beyond deleting the now-dead `ActivityBarHandle` interface.
