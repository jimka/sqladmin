---
touches-shared: [frontend/src/shell/SqlAdminShell.ts, frontend/src/SqlAdminController.ts]
---

# Class-first shell views & StructurePanel — Implementation Plan

## Overview

Convert five builder-first UI modules to class-first components that `extends`
their library base directly, following convention (a)–(e) in
[`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) and the
worked pilots [`ActivityBar`](frontend/src/shell/ActivityBar.ts#L89) and
[`TableWorkPanel`](frontend/src/dock/TableWorkPanel.ts#L55). Each currently is a
capitalized factory function; after conversion the instance itself is the
mountable component and call sites construct with `new`.

The five targets, with the concrete base each actually assembles (investigated,
not assumed):

- [`DatabaseExplorerView`](frontend/src/shell/DatabaseExplorerView.ts#L19) and
  [`RolesExplorerView`](frontend/src/shell/RolesExplorerView.ts#L18) — thin
  wrappers that both delegate to
  [`buildTreeExplorerView`](frontend/src/shell/treeExplorerView.ts#L36), which
  returns `new AccordionPanel(...)`. The shared assembly becomes a shared base
  class **`TreeExplorerView extends AccordionPanel`** (replacing the builder in
  `treeExplorerView.ts`); the two views become thin subclasses of it.
- [`QueriesView`](frontend/src/shell/QueriesView.ts#L94) — returns `new
  AccordionPanel(...)`, so `extends AccordionPanel`.
- [`StartPage`](frontend/src/shell/StartPage.ts#L64) — returns `Panel({...})`
  with `autoScroll` + non-zero `insets`, so `extends Panel`. Carries the
  documented **id-at-construction** subtlety (see Architecture Decisions).
- [`StructurePanel`](frontend/src/dock/StructurePanel.ts#L44) — returns
  `Panel({...})` with default insets + `autoScroll`, so `extends Panel`.

Call sites needing `new` (both are SHARED files — see the Files table):
[`SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts) constructs the four
shell views (lines 271, 405–407);
[`SqlAdminController.ts`](frontend/src/SqlAdminController.ts) constructs
`StructurePanel` (line 385 on this branch's base — the original draft cited
394, which predated the sibling-merge base this branch starts from). No barrel
or test re-exports any of the five.

---

## Reconciliation note (added at implementation time)

This branch starts from the tip of a Phase-1 stack that already merged
`feature/class-first-explorer-trees`, which reshaped `TreeExplorerConfig`'s
`explorer` field ahead of this plan and already converted the two tree call
sites to `new`. Concretely, as-implemented differs from the snippets above:

- **`treeExplorerView.ts`** — `ExplorerTree` is now `interface ExplorerTree
  extends Tree { refresh(): void }`, i.e. **the tree instance itself is the
  explorer** (both `NavigatorTree` and `RolesTree` `extends Tree implements
  ExplorerTree`, with `refresh` a public arrow-function field). The old `{
  tree, refresh } = config.explorer` destructure is already gone from
  `buildTreeExplorerView`; it now reads `const tree = config.explorer; const
  refresh = config.explorer.refresh;`. `TreeExplorerConfig` itself
  (`explorer: ExplorerTree`, the label/glyph/inspector fields) is unchanged —
  only how the body reads `tree`/`refresh` off it changed. The `TreeExplorerView`
  base class built in this plan is hoisted from that already-reshaped body
  (see the updated _Internal Structure_ below), not from the original
  destructuring snippet.
- **`DatabaseExplorerView.ts`** / **`RolesExplorerView.ts`** — already
  construct `explorer: new NavigatorTree(controller)` / `explorer: new
  RolesTree(controller)` (class construction, not a factory call). This
  plan's conversion **preserves** those `new` calls verbatim inside the
  `super({...})` config passed from the new subclasses — nothing about the
  tree construction changes, only the surrounding factory function becomes a
  subclass constructor.

No conflict of intent was found: the sibling plan's reshape (tree-instance-is-
the-explorer) and this plan's goal (builder → class hierarchy) are
orthogonal — one changed *what shape `config.explorer` is*, the other changes
*how the assembly around `config` is packaged*. The `Internal Structure` and
`Ordered Implementation Steps` sections below are updated in place to reflect
the current file contents rather than the stale original snippets.

---

## Architecture Decisions

### Bases are the concrete library class each builder assembles, not a generic Container/Panel

The conventions doc says pick the base that matches what the builder *actually*
assembles. `DatabaseExplorerView`/`RolesExplorerView`/`QueriesView` all
construct an **`AccordionPanel`** — extend that, not `Container`/`Panel`.
`StartPage` and `StructurePanel` construct a bare **`Panel`** (with insets and
`autoScroll`) — extend `Panel`. None of these five assemble a zero-inset bare
`Container`, so the `ActivityBar`-style "extend Container to avoid the 4px inset"
case does not apply here.

### The shared explorer assembly becomes a shared base class `TreeExplorerView`

`buildTreeExplorerView` is the single shared assembly behind both explorer
views. A class-first component cannot call a builder that itself does `new
AccordionPanel`, so the builder is refactored into a base class
`TreeExplorerView extends AccordionPanel` in the same
[`treeExplorerView.ts`](frontend/src/shell/treeExplorerView.ts) module. Its
constructor takes the existing `TreeExplorerConfig` and performs the identical
assembly (pre-super `tree.setPreferredSize(0,0)` + build the two sections as the
`super({id, sections})` argument; post-super `getAccordion().setCompact(true)` /
`setToolsVisibility("always")` / `bindRefreshShortcut(this, refresh)`).
`DatabaseExplorerView` and `RolesExplorerView` become one-line subclasses whose
`(controller, id)` constructor just forwards a config to `super(...)`. This
keeps the shared assembly single-sourced (its whole reason for existing) while
making both views genuine class-first components. `TreeExplorerConfig` stays
exactly as-is.

### All five are pure assembly — no arrow-function-field handlers needed

Convention (c) requires arrow-function *fields* only for handlers registered by
reference that would otherwise be **plain methods** losing `this`. None of these
five has such a handler:

- The explorer views and `StructurePanel` register nothing by reference on the
  instance (the FK grid's `cellclick` handler in `StructurePanel` is inside a
  module-level helper and is untouched).
- `QueriesView`'s `rebuild`/`setQueriesSectionFocus` callbacks are
  **constructor-local closures** (and inline arrows) that capture their `saved`/
  `recent`/`accordion` locals — never plain methods read off `this` — so they
  stay constructor-local. `QueriesView` needs **no instance fields**.
- `StartPage`'s `rebuild` closure and its `welcome` mutable state stay
  **constructor-local** exactly as in the current factory (only `page` becomes
  `this`). A constructor-local arrow captures `this` lexically, so passing it to
  `controller.onWorkspaceChanged(rebuild)` is safe — the `this`-loss trap
  applies to detached plain methods, not to a local closure. `StartPage` needs
  **no instance fields**.

Because nothing is cascade-touched, no field needs `declare`; because nothing is
a by-reference plain method, no field needs to be an arrow.

### StartPage: `id` and `autoScroll` must both go in the `super()` options object, `id` first

`autoScroll` registers its eased wheel-scroll listener under the component's id
**at construction** (during the option cascade), and a later `setId` does not
re-register it (documented at
[`StartPage.ts:54`](frontend/src/shell/StartPage.ts#L54) and
[`SqlAdminShell.ts:267`](frontend/src/shell/SqlAdminShell.ts#L267)). The current
factory relies on `applyOptions` dispatching `id` before `autoScroll` within one
options object. Preserve this by passing **both** `id` and `autoScroll` in the
single `super({...})` options object, with `id` as the first key — the same
`applyOptions` runs during `super()`, so the listener still registers under the
right id. Do **not** call `setId`/`setAutoScroll` after construction, and do not
split them across super + a post-super call.

### `constructor.name` → CSS class change is safe

The class-first instances report `DatabaseExplorerView`/`RolesExplorerView`/
`QueriesView`/`StartPage`/`StructurePanel` as their CSS class (was
`AccordionPanel`/`Panel`). A repo-wide grep for `.css` selectors on the generic
or new names found **no** app CSS targeting them (there are no `.css` files under
`frontend/src`). `vite.config.ts` sets `esbuild.keepNames: true`, so the names
survive minification. No selector migration is required.

---

## Public API

```ts
// treeExplorerView.ts — builder replaced by a shared base class (TreeExplorerConfig unchanged)
export class TreeExplorerView extends AccordionPanel {
    constructor(config: TreeExplorerConfig);
}

// DatabaseExplorerView.ts
export class DatabaseExplorerView extends TreeExplorerView {
    constructor(controller: SqlAdminController, id: string);
}

// RolesExplorerView.ts
export class RolesExplorerView extends TreeExplorerView {
    constructor(controller: SqlAdminController, id: string);
}

// QueriesView.ts
export class QueriesView extends AccordionPanel {
    constructor(controller: SqlAdminController, id: string);
}

// StartPage.ts
export class StartPage extends Panel {
    constructor(controller: SqlAdminController, id: string);
}

// StructurePanel.ts
export class StructurePanel extends Panel {
    constructor(
        columns: ColumnMeta[],
        structure: TableStructure,
        onOpenReferenced: (refSchema: string, refTable: string) => void,
    );
}
```

Every constructor signature is identical to the current factory's parameter
list — only `new` is added at call sites. No new public state-bearing
properties; no accessors/setters introduced.

---

## Internal Structure

### `TreeExplorerView` (treeExplorerView.ts)

**Updated per the Reconciliation note** — `config.explorer` is already an
`ExplorerTree extends Tree` (the tree instance itself), not a `{ tree,
refresh }` handle; hoist the *current* `buildTreeExplorerView` body (which
already reads `const tree = config.explorer; const refresh =
config.explorer.refresh;`) into constructor phases:

```ts
export class TreeExplorerView extends AccordionPanel {
    constructor(config: TreeExplorerConfig) {
        const tree    = config.explorer;
        const refresh = config.explorer.refresh;
        tree.setPreferredSize(0, 0);                       // pre-super: child-widget setup
        super({
            id: config.id,
            sections: [
                { label: config.treeLabel, component: tree, initiallyOpen: true,
                  glyph: config.treeGlyph, tools: [refreshTool(refresh)], fillWeight: 1 },
                { label: config.inspectorLabel, component: config.inspector, initiallyOpen: true,
                  glyph: config.inspectorGlyph ?? "circle-info" },
            ],
        });
        this.getAccordion().setCompact(true);              // post-super
        this.getAccordion().setToolsVisibility("always");
        bindRefreshShortcut(this, refresh);
    }
}
```

Subclasses forward a config to `super(...)` verbatim from the current factory
bodies (e.g. `DatabaseExplorerView`: `explorer: new NavigatorTree(controller)`
— already a class construction, preserved as-is, not reverted to a factory
call —, `treeLabel: "Databases"`, `treeGlyph: "database"`, `inspector:
controller.properties.component`, `inspectorLabel: "Properties"`).

### `QueriesView` (QueriesView.ts)

`buildSection(...)` calls, `saved`/`recent`, and the two `AccordionPanel`
`sections` entries are built as **locals before `super`**; then `super({ id,
sections: [...] })`; then post-super: `const accordion = this.getAccordion()`,
`setCompact`/`setToolsVisibility`, `controller.setQueriesSectionFocus(...)`, the
local `rebuild` closure, `controller.onWorkspaceChanged(rebuild)`, `rebuild()`,
`bindRefreshShortcut(this, rebuild)`. Everything below line 94 that is a
module-level helper (`buildSection`, `wireRow`, `buildList`, `actionButton`,
`hintText`, `snippet`, the interfaces) stays module-level, unchanged.

### `StartPage` (StartPage.ts)

```ts
export class StartPage extends Panel {
    constructor(controller: SqlAdminController, id: string) {
        super({
            id,                                            // first key — see Architecture Decisions
            layoutManager: new VBox({ stretching: true, spacing: ENTRY_SPACING }),
            autoScroll: "y",
        });
        this.setInsets(new Insets(PAGE_PADDING, PAGE_PADDING, PAGE_PADDING, PAGE_PADDING));

        let welcome: Markdown | null = null;               // constructor-local, as today
        const rebuild = (): void => {
            if (welcome) { welcome.dispose(); welcome = null; }
            this.removeAllComponents();
            this.addComponent(heading("SQL Admin", "600"));
            if (shouldShowWelcome(controller)) {
                welcome = Markdown(GETTING_STARTED_MARKDOWN);
                this.addComponent(welcome);
            }
            this.addComponent(buildColumns(controller));
            this.doLayout();
        };
        controller.onWorkspaceChanged(rebuild);
        rebuild();
    }
}
```

All module-level helpers (`buildColumns`, `buildLeftColumn`, `buildRightColumn`,
`appendList`, `heading`, `mutedText`, `actionButton`) and constants stay
unchanged.

### `StructurePanel` (StructurePanel.ts)

Build the four `section(...)` locals before `super`, then `super({ layoutManager:
new VBox({ stretching: true }), autoScroll: "auto", components: [s1, s2, s3, s4]
})`. No fields, no post-super wiring. All `section`/`build*Grid`/`readOnlyTable`
helpers stay module-level, unchanged.

---

## Ordered Implementation Steps

1. **`treeExplorerView.ts`** — replace `export function buildTreeExplorerView(config): Component`
   with `export class TreeExplorerView extends AccordionPanel` per _Internal
   Structure_ (updated for the already-reshaped `config.explorer: ExplorerTree`
   — no `{ tree, refresh }` destructure). Keep `TreeExplorerConfig` and all
   imports; `Component` is still used by `TreeExplorerConfig.inspector`, so keep
   it. Move `tree.setPreferredSize(0,0)` before `super`, the section array into
   `super(...)`, and the three `getAccordion()`/`bindRefreshShortcut` calls
   after `super`.

2. **`DatabaseExplorerView.ts`** — replace the factory with
   `export class DatabaseExplorerView extends TreeExplorerView`; constructor
   `(controller, id)` calls `super({ id, explorer: new NavigatorTree(controller),
   treeLabel: "Databases", treeGlyph: "database", inspector:
   controller.properties.component, inspectorLabel: "Properties" })` —
   preserving the already-present `new NavigatorTree(...)` construction. Change
   the import from `{ buildTreeExplorerView }` to `{ TreeExplorerView }`. Remove
   the now-unused `Component` import.

3. **`RolesExplorerView.ts`** — same as step 2 with the Roles config
   (`explorer: new RolesTree(controller)` — preserving the already-present `new`
   —, `treeLabel: "Roles"`, `treeGlyph: "users"`, `inspector:
   controller.rolesProperties.component`, `inspectorLabel: "Details"`).
   Swap the import to `{ TreeExplorerView }`; remove the unused `Component` import.

4. **`QueriesView.ts`** — replace the factory with `export class QueriesView
   extends AccordionPanel`, moving assembly into the constructor per _Internal
   Structure_. Keep `Component`/`Panel` imports (used by helpers). All helpers
   below stay put.

5. **`StartPage.ts`** — replace the factory with `export class StartPage extends
   Panel` per _Internal Structure_. Keep `Component`/`Panel`/`Insets`/`Markdown`
   imports (helpers + constructor use them). Ensure `id` is the first key in the
   `super({...})` options and `autoScroll: "y"` is in the same object.

6. **`StructurePanel.ts`** — replace the factory with `export class
   StructurePanel extends Panel`; build the four sections as locals, then
   `super({ layoutManager, autoScroll, components })`. Keep all imports.

7. **`SqlAdminShell.ts`** (SHARED) — add `new`:
   line 271 `StartPage(...)` → `new StartPage(...)`;
   line 405 `DatabaseExplorerView(...)` → `new DatabaseExplorerView(...)`;
   line 406 `RolesExplorerView(...)` → `new RolesExplorerView(...)`;
   line 407 `QueriesView(...)` → `new QueriesView(...)`. Imports stay (named).

8. **`SqlAdminController.ts`** (SHARED) — line 385 (this branch's base; the
   draft cited 394 pre-merge)
   `StructurePanel(columns, structure, ...)` → `new StructurePanel(columns,
   structure, ...)`. Import stays.

9. **Regression checks:**
   - `grep -rn 'buildTreeExplorerView' frontend/src/` — expect **zero** matches.
   - `grep -rnE '[^.]\b(DatabaseExplorerView|RolesExplorerView|QueriesView|StartPage)\(' frontend/src/shell/SqlAdminShell.ts` — every construction is prefixed with `new`.
   - `grep -rn 'new StructurePanel(' frontend/src/SqlAdminController.ts` — expect one match; `grep -rn '[^w] StructurePanel(' ...` (non-`new`) — expect none.
   - `cd frontend && npm run typecheck` — clean.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `frontend/src/shell/treeExplorerView.ts` (builder → `TreeExplorerView` base class) |
| Modify | `frontend/src/shell/DatabaseExplorerView.ts` |
| Modify | `frontend/src/shell/RolesExplorerView.ts` |
| Modify | `frontend/src/shell/QueriesView.ts` |
| Modify | `frontend/src/shell/StartPage.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` |
| Modify (**SHARED**) | `frontend/src/shell/SqlAdminShell.ts` — `new` at 4 call sites |
| Modify (**SHARED**) | `frontend/src/SqlAdminController.ts` — `new` at the `StructurePanel` call site |

---

## Expected Behaviour

Behaviour is preserved exactly; this is a refactor with no functional change. The
cases to confirm (all **manual** — these are DOM/geometry/event behaviours the
node-vitest harness cannot exercise; there is no new pure logic to unit-test):

- **Database & Roles rails** — each rail button opens its accordion view; the
  tree section fills, the inspector stays compact; header tools are always
  visible (`setToolsVisibility("always")`); Alt+R refreshes the tree while the
  rail has focus. CSS class on the view element is now `DatabaseExplorerView` /
  `RolesExplorerView` (was `AccordionPanel`); styling is unchanged (no selectors
  target either name).
- **Queries view** — Saved/Recent lists populate; single-click arms the Open +
  Remove/Save tools; double-click executes; right-click shows Execute/Open;
  Enter opens, Ctrl/Cmd+Enter executes; the view rebuilds on
  `onWorkspaceChanged`; the menu's "Open Saved…"/"Query History…" expands and
  focuses the right section; Alt+R re-reads both stores.
- **Start page** — shows in the CENTER deck when the workspace is empty; the
  welcome blurb appears only when there are no recent tables and no saved
  queries; New Query / recent-table / saved-query buttons act; the page
  **scrolls smoothly** (eased `autoScroll`) when the viewport is short —
  *specifically verify smooth (not native) wheel scroll, since this is the
  id-at-construction invariant*; rebuilds on `onWorkspaceChanged` without leaking
  the welcome Markdown's theme listener.
- **Structure panel** — opens as a dock tab from the navigator's "Open
  structure"; stacks Columns/Indexes/Constraints/Foreign Keys, each a
  fixed-height read-only grid; the whole stack scrolls when the four overflow;
  clicking a Foreign Keys `refTable` link opens that referenced table.

---

## Verification

- `cd frontend && npm run typecheck` — clean (the `new` at every call site is the
  compiler's proof the factories are gone).
- `npm test` — existing suite still green (no test imports these five modules;
  `startPageWelcome.test.ts` covers `shouldShowWelcome`, which is untouched).
- The grep invariants in Ordered Step 9.
- Manual smoke (per _Expected Behaviour_): run `npm run dev`, log in against the
  seed DB, and exercise the four sidebar/center surfaces + the Structure tab.
  Pay special attention to **StartPage smooth wheel-scroll** (the id/autoScroll
  invariant) and the **FK link → open table** path.

**Performed at implementation time (StartPage id/autoScroll invariant only):**
against the running seed-DB stack, with the browser window resized to a short
viewport (900x350) so `#work-start` overflows (`scrollHeight` 703 vs
`clientHeight` 297), a single synthetic `wheel` event (`deltaY: 120`) was
dispatched and `scrollTop` sampled once per animation frame for 20 frames:
`[15, 42, 61, 76, 87, 95, 101, 106, 110, 112, 114, 116, 117, 118, 118, 119,
119, 119, 119, 120]` — a decelerating multi-frame ease into 120px, not an
instant one-frame jump, confirming the eased wheel-scroll listener is still
registered under `work-start` (the `CENTER_START_ID`) after the class-first
conversion. The element's CSS class is `StartPage` (was `Panel`), confirming
convention (e) took effect with no console errors. The other three manual
smoke items (Database/Roles/Queries rails, FK link → open table) were not
separately re-exercised beyond this StartPage check and the automated
typecheck/test/build/grep coverage above — they are pure DOM/geometry/event
behaviour per _Expected Behaviour_ and share the same conversion mechanics
(no new wiring beyond `extends`), so this remains an honest partial
manual-verify, not a full walkthrough of every bullet.

---

## Potential Challenges

- **StartPage id/autoScroll ordering** — the single most likely regression. If
  `id` and `autoScroll` are not both in the `super()` options object (or a
  `setId`/`setAutoScroll` is used post-super), the page reverts to native
  scrolling. Mitigation: follow _Internal Structure_ exactly; verify smooth
  scroll manually.
- **Shared-file merge order** — both `SqlAdminShell.ts` and
  `SqlAdminController.ts` are edited by sibling class-first plans
  (`class-first-work-panels.md` also touches `SqlAdminController.ts`). The edits
  here are surgical single-token `new` additions on distinct lines; sequence
  after (or rebase over) siblings to avoid a textual conflict. Declared in
  frontmatter `touches-shared`.
- **`TreeExplorerConfig.explorer` read before `super`** — per the Reconciliation
  note, `config.explorer` is now an `ExplorerTree extends Tree` (the tree
  instance itself), so the pre-super setup is two `const` reads, not a `{ tree,
  refresh }` handle destructure: `const tree = config.explorer; const refresh =
  config.explorer.refresh;` followed by `tree.setPreferredSize(0,0)`, all before
  `super()` (the section array needs `tree`). `refresh` is also used post-super
  by `bindRefreshShortcut`. Keep both `const` reads at the top of the
  constructor so both phases see them.

---

## Critical Files

- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — the
  (a)–(e) rules this plan follows.
- [`frontend/src/shell/ActivityBar.ts`](frontend/src/shell/ActivityBar.ts) and
  [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) —
  the worked class-first pilots (locals → `super` → post-super wiring).
- [`frontend/src/shell/LoginForm.ts`](frontend/src/shell/LoginForm.ts) — the
  simplest locals-then-fields precedent (`extends Form`).
- [`frontend/src/shell/refreshTool.ts`](frontend/src/shell/refreshTool.ts) —
  `refreshTool(onRefresh)` / `bindRefreshShortcut(component, onRefresh)`
  signatures the explorer/Queries views call.

---

## Non-Goals

- **Extracting `snippet()` (QueriesView) for unit tests** — it is trivial
  whitespace-collapse + ellipsis truncation; extracting it is orthogonal to the
  class-first conversion and not worth a new module. Keep the conversion
  surgical. (No other target contains untested pure logic worth extracting:
  `StartPage`'s gate is already in `startPageWelcome.ts` and tested;
  `StructurePanel`'s grids are library-Model plumbing.)
- **Converting the sibling not-yet-migrated builders** (`ViewWorkPanel`,
  `RoleGrantsPanel`, `QueryPanel`, `DefinitionPanel`, the diagram panels) — out
  of scope; class-first migration is opportunistic, not a whole-layer pass.
- **Changing any behaviour, layout, styling, or public signature** — pure
  refactor.
