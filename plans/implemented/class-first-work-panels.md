---
touches-shared: [frontend/src/SqlAdminController.ts]
---

# Class-first work panels: ViewWorkPanel & RoleGrantsPanel — Implementation Plan

## Overview

Convert the two remaining dock work-panel builders to class-first components that
`extends Container`, mirroring the already-converted pilot
[`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts#L55).
Each currently is a capitalized factory function returning a bare `Container`
assembled by [`workPanelShell`](frontend/src/dock/workPanelShell.ts#L20). After
conversion both inline the `workPanelShell` Border frame directly (toolbar NORTH,
main surface CENTER, optional SOUTH), following convention (a)–(e) in
[`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md).

- [`frontend/src/dock/ViewWorkPanel.ts`](frontend/src/dock/ViewWorkPanel.ts#L51):
  `export function ViewWorkPanel(...): Container` → `export class ViewWorkPanel extends Container`.
  Frame is toolbar NORTH + a `Fit`-wrapped grid CENTER (no SOUTH). Keeps its one
  `Event.addSubtreeListener` keydown handler (Ctrl+E / Ctrl+Shift+E → Explain).
- [`frontend/src/dock/RoleGrantsPanel.ts`](frontend/src/dock/RoleGrantsPanel.ts#L21):
  `export function RoleGrantsPanel(...): Container` → `export class RoleGrantsPanel extends Container`.
  Frame is toolbar NORTH + raw `Table` CENTER + `PaginationBar` SOUTH.

Both call sites live in the SHARED
[`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts): the
`ViewWorkPanel(...)` factory call at
[line 315](frontend/src/SqlAdminController.ts#L315) and the `RoleGrantsPanel(...)`
call at [line 1366](frontend/src/SqlAdminController.ts#L1366) each gain a `new`.

Once both are converted, `workPanelShell` has zero consumers (TableWorkPanel
stopped using it on the pilot branch), so
[`frontend/src/dock/workPanelShell.ts`](frontend/src/dock/workPanelShell.ts) is
deleted.

---

## Architecture Decisions

### Both panels are pure assembly — no arrow-function-field handlers, no extracted logic

Neither panel registers a handler *by reference* that closes over mutable
instance state, so convention (c)'s arrow-field rule does not apply the way it did
to TableWorkPanel's three `sync*` handlers.

- **ViewWorkPanel**'s only registered listener is the `Event.addSubtreeListener`
  keydown callback. It closes over the `onExplain` *constructor parameter* (a
  local), not over `this`, exactly like TableWorkPanel's inline button click
  handlers (`() => store.add({})`, `() => save_(store, columns, notify)`). Keep it
  an **inline arrow in the constructor** (registered after `super()`); do **not**
  promote it to an arrow-function field and do **not** store `onExplain` as a
  field — nothing else needs it.
- **RoleGrantsPanel** registers no event listeners at all.

Consequently **neither panel needs any instance fields**: TableWorkPanel kept
button fields only because its `sync*` handlers toggled them reactively; these
panels have no reactive state. This is the intended shape — a class-first
component with an empty field section is fine.

### No new sibling module for node-vitest — no extractable decision logic exists

The task's extraction check (mirroring how TableWorkPanel's write-gating moved to
[`tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts)) applies only when
*untested decision logic* exists. It does not here:

- `buildViewColumnSpec` is a constant transform —
  `columns.map(c => ({ field: c.name }))` with `rowReadOnly: () => true`. No
  branching, no gating; nothing worth a unit test.
- `buildToolBar` (both panels) and RoleGrantsPanel's `Model` field list are
  assembly/data, not logic.

So keep `buildViewColumnSpec`, both `buildToolBar` helpers, and `buildViewColumnSpec`
as **stateless module-level functions** (convention (c), final paragraph — the
`save_`/`confirmDelete` precedent). Create **no** new file and **no** new test.

### Extend `Container`, not `Panel`

`workPanelShell` built a bare `Container` (zero content inset). Extending `Panel`
would reintroduce its 4px default inset (convention (a)). Match TableWorkPanel:
`extends Container`, `super({ layoutManager: new BorderLayout({ spacing: 0 }) })`.

### Preserve each panel's exact CENTER wrapping — do not normalize

ViewWorkPanel wraps its grid in `Panel({ layoutManager: new Fit(), components: [dataGrid] })`
for CENTER (same as TableWorkPanel). RoleGrantsPanel places its **raw** `Table`
directly in CENTER (no `Fit`/`Panel` wrapper). These differ today; keep them as-is.
Do **not** add a wrapper to RoleGrantsPanel that `workPanelShell` never added.

### Super-cascade ordering (convention (b))

Build every child (grid, toolbar, and for RoleGrantsPanel the model/proxy/store/
paginationbar) as **locals before `super()`**; call `super({ layoutManager })`;
then do all `addComponent(...)`, the keydown-listener wiring, and `void store.load()`
**after `super()`**. No option passed to `super()` is cascade-touched, so plain
field assignment would be safe — but since neither panel needs fields, there is
nothing to assign; `declare` is not needed.

### CSS class-name change is safe

Convention (e): the instances will now report `this.constructor.name` as
`"ViewWorkPanel"` / `"RoleGrantsPanel"` instead of the generic `"Container"`.
`grep -rn '\.Container' frontend/src` and a scan for `.css` files both return
nothing, so no selector breaks (same finding as the pilot). `keepNames: true` in
`vite.config.ts` keeps this correct under minification.

---

## Public API

Both exports change from a factory function to a class; the instance *is* the
mountable component (convention (d)). Signatures are otherwise unchanged.

```ts
// frontend/src/dock/ViewWorkPanel.ts
export class ViewWorkPanel extends Container {
    constructor(store: AjaxStore, columns: ColumnMeta[], onExport: ExportTable, onExplain: ExplainView);
}
// `export type ExplainView` stays exported unchanged.

// frontend/src/dock/RoleGrantsPanel.ts
export class RoleGrantsPanel extends Container {
    constructor(role: string, privileges: RolePrivilege[]);
}
```

No handle interface exists to delete (both already returned a bare `Container`).
The module-level helpers (`buildViewColumnSpec`, `buildToolBar`) stay private
module functions, unexported.

---

## Internal Structure

### ViewWorkPanel constructor (after conversion)

```ts
constructor(store: AjaxStore, columns: ColumnMeta[], onExport: ExportTable, onExplain: ExplainView) {
    // Locals before super() — `this` is unavailable during the option cascade.
    const dataGrid = Table(store, buildViewColumnSpec(columns));
    const toolbar  = buildToolBar(store, onExport, onExplain);

    super({ layoutManager: new BorderLayout({ spacing: 0 }) });

    this.addComponent(toolbar, { placement: Placement.NORTH });
    this.addComponent(Panel({ layoutManager: new Fit(), components: [dataGrid] }), { placement: Placement.CENTER });

    // Ctrl+E / Ctrl+Shift+E explain the view while this panel has focus. Inline
    // arrow closing over the `onExplain` param (no `this` capture needed).
    Event.addSubtreeListener(this, "keydown", (event: KeyboardEvent) => {
        if (isExplainChord(event)) {
            event.preventDefault();
            event.stopPropagation();
            onExplain(false);
        } else if (isExplainAnalyzeChord(event)) {
            event.preventDefault();
            event.stopPropagation();
            onExplain(true);
        }
    });
}
```

`buildViewColumnSpec` and `buildToolBar` are kept verbatim as module-level
functions below the class.

### RoleGrantsPanel constructor (after conversion)

```ts
constructor(role: string, privileges: RolePrivilege[]) {
    // Locals before super().
    const model = new Model({
        fields: [
            { name: "schema",    type: "string",  description: "Schema",    order: 1 },
            { name: "table",     type: "string",  description: "Table",     order: 2 },
            { name: "privilege", type: "string",  description: "Privilege", order: 3 },
            { name: "grantable", type: "boolean", description: "Grantable", order: 4 },
        ],
    });

    const proxy = new PagingMemoryProxy();
    proxy.setData(privileges);

    const store = new Store({ model, proxy });
    store.setPageSize(PAGE_SIZE);

    const toolbar    = buildToolBar(role, privileges);
    const grid       = Table(store, { columns: [], rowReadOnly: () => true });
    const pagination = new PaginationBar(store);

    super({ layoutManager: new BorderLayout({ spacing: 0 }) });

    this.addComponent(toolbar,    { placement: Placement.NORTH });
    this.addComponent(grid,       { placement: Placement.CENTER });
    this.addComponent(pagination, { placement: Placement.SOUTH });

    // Load after the panel is assembled (mirrors the original ordering).
    void store.load();
}
```

`buildToolBar` is kept verbatim as the module-level function below the class.

---

## Ordered Implementation Steps

1. **Convert `frontend/src/dock/ViewWorkPanel.ts`.**
   - Imports: change `import { Panel, Event } from "@jimka/typescript-ui/core"`
     to also bring in `Container` as a value (`import { Container, Panel, Event } from "@jimka/typescript-ui/core"`);
     **delete** the `import type { Container } from "@jimka/typescript-ui/core"` line
     (it becomes a value import). Add `import { Border as BorderLayout } from "@jimka/typescript-ui/layout"`
     (keep the existing `Fit` import from the same module) and
     `import { Placement } from "@jimka/typescript-ui/primitive"`. **Delete**
     `import { workPanelShell } from "./workPanelShell"`.
   - Replace the `export function ViewWorkPanel(...): Container { ... return panel; }`
     body with `export class ViewWorkPanel extends Container { constructor(...) { ... } }`
     per _Internal Structure_. Keep the `buildViewColumnSpec` and `buildToolBar`
     module functions unchanged below the class.
   - Update the leading file comment: it currently says the panel is built by a
     factory / references the read-only shape; add the class-first note in the
     style of TableWorkPanel's header (extends `Container`, inlines the
     `workPanelShell` frame, keydown listener stays an inline arrow, helpers stay
     module-level).

2. **Convert `frontend/src/dock/RoleGrantsPanel.ts`.**
   - Imports: change `import type { Container } from "@jimka/typescript-ui/core"`
     to `import { Container } from "@jimka/typescript-ui/core"` (value). Add
     `import { Border as BorderLayout } from "@jimka/typescript-ui/layout"` and
     `import { Placement } from "@jimka/typescript-ui/primitive"`. **Delete**
     `import { workPanelShell } from "./workPanelShell"`.
   - Replace `export function RoleGrantsPanel(...): Container { ... return panel; }`
     with `export class RoleGrantsPanel extends Container { constructor(...) { ... } }`
     per _Internal Structure_. Keep the `buildToolBar` module function unchanged
     below the class. Preserve the raw (un-wrapped) `Table` in CENTER.
   - Update the leading file comment with a one-line class-first note.

3. **Update the two call sites in the SHARED `frontend/src/SqlAdminController.ts`.**
   - [Line 315](frontend/src/SqlAdminController.ts#L315): `() => ViewWorkPanel(store, columns, ...)`
     → `() => new ViewWorkPanel(store, columns, ...)` (leave the arguments and the
     surrounding lazy-content arrow untouched).
   - [Line 1366](frontend/src/SqlAdminController.ts#L1366): `content: RoleGrantsPanel(role, privileges),`
     → `content: new RoleGrantsPanel(role, privileges),`.
   - Import lines 34 and 39 need no change (named imports resolve to the class).

4. **Delete `frontend/src/dock/workPanelShell.ts`** (now unreferenced).

5. **Verify zero consumers:** `grep -rn "workPanelShell" frontend/src` — expect
   **zero** matches (the two remaining prose mentions in TableWorkPanel's header
   comment describe the now-removed shared frame; update or drop them so the grep
   is clean and the comment isn't stale — TableWorkPanel's header currently says
   "ViewWorkPanel/RoleGrantsPanel still call it", which is no longer true).

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/ViewWorkPanel.ts` |
| Modify | `frontend/src/dock/RoleGrantsPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` **(SHARED — call sites at L315, L1366; also edited by sibling class-first plans)** |
| Modify | `frontend/src/dock/TableWorkPanel.ts` **(header-comment only — remove the stale "ViewWorkPanel/RoleGrantsPanel still call it" `workPanelShell` reference)** |
| Delete | `frontend/src/dock/workPanelShell.ts` |

---

## Expected Behaviour

All behaviours are **DOM/layout — manual verification** (the node-environment
vitest runner has no DOM; these panels only assemble library widgets, so there is
no pure decision logic to unit-test — see the "no new sibling module" decision).

- **ViewWorkPanel renders identically to today.** Opening a view/matview tab shows
  the read-only paginated grid with the toolbar NORTH: Explain, Explain Analyze,
  flex spacer, Export, Refresh. Every cell is read-only. Manual.
- **ViewWorkPanel keyboard shortcuts.** With the view panel focused, Ctrl+E opens a
  Query tab running `EXPLAIN` on the view's backing SELECT; Ctrl+Shift+E runs
  `EXPLAIN ANALYZE`. Both suppress default/propagation. The grid is not disturbed.
  Manual (keyboard + focus).
- **ViewWorkPanel toolbar actions.** Export streams the whole relation server-side;
  Refresh reloads (`store.load()`, no `reject()`). Manual.
- **RoleGrantsPanel renders identically to today.** Opening a role's Grants tab
  shows the read-only grid (one row per grant), toolbar NORTH (flex spacer +
  Export), and a `PaginationBar` SOUTH; `store.load()` populates the first page.
  Manual.
- **RoleGrantsPanel export.** The Export button serializes the role's whole grant
  set (all pages) via `exportRoleGrants`. Manual.
- **Both panels mount via `new`.** The controller's `addLazyPanel`/`addPanel`
  `content` accepts the instance directly (it `extends Container`, a `Component`).
  No handle indirection. Manual (tab opens without error).
- **CSS class names.** DOM inspection shows the panel root carries class
  `ViewWorkPanel` / `RoleGrantsPanel` (was `Container`); no visual regression since
  no selector targeted `.Container`. Manual (optional dev-tools check).

---

## Verification

- **Typecheck / build:** `cd frontend && npx tsc --noEmit` (or the project's
  `npm run build`) — expect no errors. This catches the value-vs-`type` import
  change on `Container` and both `new` call sites.
- **Consumer grep:** `grep -rn "workPanelShell" frontend/src` — expect zero
  matches (step 5).
- **Call-site grep:** `grep -rn "ViewWorkPanel(\|RoleGrantsPanel(" frontend/src`
  — expect the only construction sites to be `new ViewWorkPanel(` (L315) and
  `new RoleGrantsPanel(` (L1366).
- **Unit tests:** `cd frontend && npx vitest run` — the existing suite (incl.
  `src/dock/tableWriteRules.test.ts`, `src/data/PagingMemoryProxy.test.ts`) must
  stay green; no new tests are added.
- **Manual smoke (dev server):** open a view tab (grid + Explain/Analyze/Export/
  Refresh; Ctrl+E / Ctrl+Shift+E open EXPLAIN query tabs) and a role's Grants tab
  (paginated read-only grid + Export), confirming both match current behaviour.

---

## Critical Files

- [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) —
  the worked class-first precedent: locals→`super()`→`addComponent`, inlined
  Border frame, `Fit`-wrapped CENTER, arrow-field vs inline-arrow handler split.
- [`frontend/src/shell/LoginForm.ts`](frontend/src/shell/LoginForm.ts) — the
  locals → `super({ components })` → field-assignment template.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) —
  conventions (a) extend the callable base, (b) super-cascade, (c) arrow-field
  handlers, (d) the instance is the component, (e) `constructor.name` CSS class.
- [`frontend/src/dock/workPanelShell.ts`](frontend/src/dock/workPanelShell.ts) —
  the frame being inlined then deleted.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) —
  SHARED call sites (L315, L1366).

---

## Non-Goals

- **No behavioural or visual change.** Pure structural refactor; toolbars, grids,
  read-only locking, pagination, and shortcuts stay exactly as they are.
- **No new sibling logic module / no new tests.** Unlike TableWorkPanel, neither
  panel has untested decision logic to extract (see Architecture Decisions).
- **No normalizing of RoleGrantsPanel's CENTER wrapping.** Its raw-`Table` CENTER
  is preserved; do not add a `Fit`/`Panel` wrapper.
- **No conversion of other builders.** Only the two named work panels; class-first
  migration remains touch-it-when-you-touch-it.
