---
touches-shared: [frontend/src/SqlAdminController.ts]
---

# Class-First Diagram / Graph Panels — Implementation Plan

## Overview

Convert the six diagram/graph builder functions in `frontend/src/dock/` from
capitalized factory functions that `new` up a library primitive and return a
bare `Component` to **class-first** components that `extends` a library base
directly (per [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md),
with [`TableWorkPanel`](frontend/src/dock/TableWorkPanel.ts) and
[`ActivityBar`](frontend/src/shell/ActivityBar.ts) as the worked precedents).

Three of the six are trivial single-`DiagramView` wrappers; two are composite
`Panel`s that assemble a WEST control/legend panel over a CENTER `DiagramView`
and carry substantial view state in factory-closure `let`s; one
(`TableCardNode`) is a per-node renderer, not a mountable tab, but is still a
single `Panel` and converts cleanly.

The base to extend is dictated by what each builder currently returns:
`DiagramView` (a `class … extends Panel<DiagramViewOptions>`, exported via the
`callable()` wrapper at [`DiagramView.ts:777`](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L777)) for
the three thin wrappers, and `Panel` for the two composites and `TableCardNode`.
All diagram components are **live-only** — `DiagramView`'s ELK layout runs
through a lazily-imported engine that no-ops under the node/jsdom test harness —
so `## Expected Behaviour` is almost entirely manual-verify.

Every call site is in the shared controller
[`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts)
(nine `content:` sites) plus one internal `nodeRenderer` site inside
`RelationDiagramPanel.ts`; each flips from `Builder(args)` to `new Builder(args)`.

---

## Architecture Decisions

### Extend `DiagramView` for the thin wrappers (Schema / RoleGrants / RelationGraph)

`SchemaDiagramPanel`, `RoleGrantsDiagramPanel`, and `RelationGraphPanel` each
build one `DiagramView`, register a single `activate` listener, and return the
view. They become `extends DiagramView`. The base's constructor kicks off the
async ELK layout **inside `super()`** (via `setData` when a `data` option is
present — [`DiagramView.ts:180`](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L180)),
which is the library's own concern and touches only base state; our subclass
body runs entirely after `super()` returns, so the super-cascade is a non-issue
here. Pass `data` (and `nodeRenderer` for RelationGraph) through `super({...})`
and register the `activate` listener with `this.on("activate", …)` after
`super()`.

The `activate` handler is an **inline arrow closing over a constructor
parameter** (`onSelectTable` / `onOpenTable` / `onSelect`), never a method
handed off by reference, so it needs no arrow-function field — it mirrors the
factories' existing inline `view.on("activate", …)`.

### Extend `Panel` for the composites (RelationDiagram / DatabaseDiagram)

`RelationDiagramPanel` and `DatabaseDiagramPanel` return a Border-layout
`Panel` composing a WEST controls+legend `Panel` and a CENTER `DiagramView`, so
`Panel` is the faithful base (it matches what they assemble; the 4px `Panel`
content inset is already what the factory used — these are not the zero-inset
case `ActivityBar` avoided). This is the heavier conversion:

- Every factory-closure `let` (`direction`, `depth`, `prune`, `showCoverage`,
  `hidden`, `base` for RelationDiagram; `mode`, `rootId`, `direction`, `depth`,
  `prune`, `hiddenSchemas`, `base` for DatabaseDiagram) becomes a **private
  instance field**, assigned after `super()`.
- The closure helpers (`applyFilter`, `rebuildLegend`, `rebuildBase`,
  `focusSchema`, `isHiddenLeaf`) become **arrow-function fields**. `applyFilter`
  is passed **by reference** to the `legendRow` / `schemaLegendRow` helpers, so
  it must be an arrow field (a plain method would drop `this`); the others call
  and are called among this set, so keep them arrow fields too for consistency
  (convention (c): "when in doubt, prefer the arrow field").
- The child controls (`ComboBox`/`Checkbox`) and the `DiagramView` are built as
  **locals before `super()`** (they are `super()`'s `components`), assigned to
  fields after `super()`, and their `change` listeners are wired **after
  `super()`** via `control.on("change", v => { this.field = v; this.rebuildBase(); })`.
  Both `ComboBox` ([`ComboBox.ts:962`](../../typescript-ui/src/typescript/lib/component/input/ComboBox.ts#L962))
  and `Checkbox` ([`Checkbox.ts:329`](../../typescript-ui/src/typescript/lib/component/input/Checkbox.ts#L329))
  expose `on("change", …)`, so moving the wiring out of the construction-time
  `listeners:` bag into post-`super()` `.on()` calls keeps `this` available and
  matches the convention's locals→`super()`→wire order exactly. This sidesteps
  any "capture `this` before `super()`" subtlety.

### `TableCardNode` → `extends Panel`, `setSelected` becomes a real method

`TableCardNode` returns a single `Panel` and today grafts a selection hook onto
it with an `as unknown as SelectableCard` cast
([`TableCardNode.ts:94`](frontend/src/dock/TableCardNode.ts#L94)). As a class it
`extends Panel` and declares `setSelected(value: boolean)` as a **plain public
method** — `DiagramView.applySelectedVisual` calls it as
`component.setSelected?.(value)` (a method call on the node object, never a
detached reference — [`DiagramView.ts:567`](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L567)),
so `this` is bound correctly and no arrow field is needed. The `SelectableCard`
interface and the cast are deleted. This is a strict improvement, not a forced
fit. `columnRow` stays a stateless module-level function.

### One exported function per file — the "second function" is a private helper

An earlier grep flagged a second `function` near
`RelationDiagramPanel.ts:184` and `DatabaseDiagramPanel.ts:278`. These are
**not** exported: `legendRow`/`labelledRow` (RelationDiagram) and
`schemaLegendRow`/`labelledRow` (DatabaseDiagram) are private module-level
helper factories. They take everything they need as parameters, are never
registered by reference, and stay ordinary module functions (convention (c),
mirroring `TableWorkPanel`'s `save_`/`confirmDelete`). Only the one exported
`…Panel` symbol per file becomes a class.

### No builder is left a factory

All six convert. The two composites are the borderline cases (heavy state,
composite layout) but each still returns exactly one `Panel` that *is* the
mountable component, so `extends Panel` is faithful; `TableCardNode` is a
node-renderer child rather than a tab, but is likewise a single `Panel`.
No case requires the composition fallback.

### CSS-class rename is safe

`constructor.name` drives the component's CSS class (convention (e)). The thin
wrappers change `.DiagramView` → `.SchemaDiagramPanel` etc.; the composites and
`TableCardNode` change `.Panel` → `.RelationDiagramPanel` etc. A repo-wide grep
for `.Panel` / `.DiagramView` / `.Container` selectors found **no app CSS**
(the frontend ships no `.css` files and no such selectors in TS template
strings), so nothing targets the old generic names. `vite.config.ts` sets
`esbuild.keepNames: true`, so the names survive minification.

---

## Public API

Each exported factory becomes a class with the identical parameter list; the
instance *is* the component (no `.component` handle to unwrap).

```ts
// dock/SchemaDiagramPanel.ts
export class SchemaDiagramPanel extends DiagramView {
    constructor(data: DiagramData, onSelectTable: (table: string) => void);
}

// dock/RoleGrantsDiagramPanel.ts
export class RoleGrantsDiagramPanel extends DiagramView {
    constructor(data: DiagramData, onOpenTable: (schema: string, table: string) => void);
}

// dock/RelationGraphPanel.ts
export class RelationGraphPanel extends DiagramView {
    constructor(data: DiagramData, onSelect: (node: RelationNodeData) => void, rootId?: string);
}

// dock/RelationDiagramPanel.ts
export class RelationDiagramPanel extends Panel {
    constructor(full: DiagramData, root: DiagramNodeData, onSelectTable: (table: string) => void);
}

// dock/DatabaseDiagramPanel.ts
export class DatabaseDiagramPanel extends Panel {
    constructor(schemas: SchemaTables[], onSelectTable: (schema: string, table: string) => void);
}

// dock/TableCardNode.ts — a diagram node renderer, still a single Panel
export class TableCardNode extends Panel {
    constructor(node: DiagramNodeData, isRoot: boolean);
    setSelected(value: boolean): void;   // real method; DiagramView duck-types it
}
```

Import the **callable** base (`import { DiagramView } from
"@jimka/typescript-ui/component/diagram"`; `import { Panel } from
"@jimka/typescript-ui/core"`) and `extends` it — the same callable already
imported in these files — not the `_DiagramView`/`_Panel` raw alias.

---

## Internal Structure

### Thin wrappers — canonical shape (SchemaDiagramPanel shown)

```ts
export class SchemaDiagramPanel extends DiagramView {
    constructor(data: DiagramData, onSelectTable: (table: string) => void) {
        super({ data });
        // Double-click activates a node; the node id is its table name.
        this.on("activate", (node: DiagramNodeData) => onSelectTable(node.id));
    }
}
```

`RelationGraphPanel` additionally builds its `nodeRenderer` as a **local before
`super()`** (it closes over the `rootId` param and the module `ROOT_BORDER`, not
`this`) and passes it through `super({ data, nodeRenderer })`:

```ts
constructor(data: DiagramData, onSelect: (node: RelationNodeData) => void, rootId?: string) {
    const nodeRenderer = (n: DiagramNodeData): Component => {
        const node = DiagramNode({ label: n.label, glyph: n.glyph });
        if (rootId !== undefined && n.id === rootId) node.setBorder(ROOT_BORDER);
        return node;
    };
    super({ data, nodeRenderer });
    this.on("activate", (n: DiagramNodeData) => onSelect(n.data as RelationNodeData));
}
```

### Composite — canonical shape (RelationDiagramPanel)

```ts
export class RelationDiagramPanel extends Panel {
    private readonly full: DiagramData;
    private readonly root: DiagramNodeData;
    private readonly onSelectTable: (table: string) => void;

    private direction: TraversalDirection = "both";
    private depth        = DEFAULT_DEPTH;
    private prune        = false;
    private showCoverage = false;
    private readonly hidden = new Set<string>();
    private base!: DiagramData;                 // seeded post-super()

    private readonly view:   DiagramView;
    private readonly legend: Panel;

    constructor(full: DiagramData, root: DiagramNodeData, onSelectTable: (table: string) => void) {
        // Locals before super() — they are super()'s children.
        const base = rootedDiagram(full, root, "both", DEFAULT_DEPTH);
        const nodeRenderer = (n: DiagramNodeData): Component => new TableCardNode(n, n.id === root.id);
        const view   = DiagramView({ data: base, nodeRenderer });
        const legend = Panel({ layoutManager: new VBox({ spacing: 2 }), autoScroll: "auto" });

        const directionControl = ComboBox({ /* items…, value: "both" */ });   // no listeners: here
        const depthControl     = ComboBox({ /* items: DEPTH_CHOICES */ });
        const pruneControl      = Checkbox({ value: false });
        const coverageControl   = Checkbox({ value: false });

        const controls = Panel({ layoutManager: new VBox({ spacing: 4 }), components: [ /* labelledRow rows + checkbox rows */ ] });
        const west     = Panel({ layoutManager: new Border(), preferredSize: {…}, minSize: {…},
                                 components: [{ component: controls, constraints: { placement: Placement.NORTH } },
                                              { component: legend,   constraints: { placement: Placement.CENTER } }] });

        super({ layoutManager: new Border(),
                components: [{ component: west, constraints: { placement: Placement.WEST } },
                             { component: view, constraints: { placement: Placement.CENTER } }] });

        this.full = full; this.root = root; this.onSelectTable = onSelectTable;
        this.base = base; this.view = view; this.legend = legend;

        // Wire listeners after super() (this now available):
        view.on("activate", (n: DiagramNodeData) => onSelectTable(n.id));
        directionControl.on("change", v => { this.direction = v as TraversalDirection; this.rebuildBase(); });
        depthControl.on("change",     v => { this.depth = Number(v); this.rebuildBase(); });
        pruneControl.on("change",     v => { this.prune = v; this.applyFilter(); });
        coverageControl.on("change",  v => { this.showCoverage = v; this.applyFilter(); });

        this.rebuildLegend();
    }

    // Passed by reference to legendRow — MUST be an arrow field.
    private applyFilter = (): void => {
        this.view.setData(applyCoverageStyle(
            applyHide(this.base, this.root.id, this.hidden, this.prune, this.direction), this.showCoverage));
    };
    private rebuildLegend = (): void => {
        this.legend.removeAllComponents();
        for (const n of this.base.nodes) this.legend.addComponent(legendRow(n, this.root.id, this.hidden, this.applyFilter));
    };
    private rebuildBase = (): void => {
        this.base = rootedDiagram(this.full, this.root, this.direction, this.depth);
        this.hidden.clear();
        this.rebuildLegend();
        this.applyFilter();
    };
}
```

`legendRow` and `labelledRow` stay unchanged module functions below the class.

`DatabaseDiagramPanel` follows the identical pattern with its own field set
(`mode`, `rootId`, `direction`, `depth`, `prune`, `hiddenSchemas`, `base`) and
arrow-field methods (`applyFilter`, `rebuildLegend`, `rebuildBase`,
`focusSchema`, `isHiddenLeaf`). Note its extra wiring:
- the `view` starts on `overviewGraph` (not `base`), so `super({ data:
  overviewGraph })` isn't used — the child `view` local is `DiagramView({ data:
  overviewGraph })`;
- `focusSchema` (Overview drill-down) mutates `modeControl`/`rootControl` via
  `setValue` and toggles `tablesControls`/`legend` `setDisplayed` — all become
  `this.`-field references resolved at call time, so it works as an arrow field;
- `modeControl`/`rootControl`/`tablesControls`/`legend` must be **fields** (not
  just locals) because `focusSchema` and the mode listener reference them after
  construction;
- `schemaLegendRow` and `labelledRow` stay module functions.

---

## Ordered Implementation Steps

1. **`dock/SchemaDiagramPanel.ts`** — Replace the `export function
   SchemaDiagramPanel(…): Component` with `export class SchemaDiagramPanel
   extends DiagramView`. Change the `DiagramView` import to the value import
   (it is already `import { DiagramView } from
   "@jimka/typescript-ui/component/diagram"`; drop the now-unused `import type {
   Component }`). Body: `super({ data }); this.on("activate", node =>
   onSelectTable(node.id));`. Update the header comment's "Wraps DiagramView"
   framing to "extends DiagramView (class-first)".

2. **`dock/RoleGrantsDiagramPanel.ts`** — Same shape: `export class
   RoleGrantsDiagramPanel extends DiagramView`. Keep the module-level
   `Glyph.register(user, table)`. Drop the unused `import type { Component }`.
   Body: `super({ data }); this.on("activate", node => { const meta = node.data
   as GrantNodeData | undefined; if (meta?.kind === "table")
   onOpenTable(meta.schema, meta.table); });`.

3. **`dock/RelationGraphPanel.ts`** — `export class RelationGraphPanel extends
   DiagramView`. Build `nodeRenderer` as a local before `super({ data,
   nodeRenderer })`; register `this.on("activate", n => onSelect(n.data as
   RelationNodeData))` after. Keep `DiagramNode` imported (used in the
   renderer). Drop the unused `import type { Component }` only if no longer
   referenced (the renderer return type still needs `Component` — keep it).

4. **`dock/TableCardNode.ts`** — `export class TableCardNode extends Panel`.
   Build `header` + `columns.map(columnRow)` as locals; `super({ layoutManager:
   new VBox({ spacing: 0 }), preferredSize: { width: CARD_WIDTH, height:
   cardHeight(columns.length) }, components: [header, ...rows] })`. After
   `super()`: `this.setBorder(isRoot ? ROOT_BORDER : CARD_BORDER);
   this.setBackgroundColor(CARD_BG); this.setCursor("pointer");`. Add a real
   method `setSelected(value: boolean): void { this.setBackgroundColor(value ?
   CARD_SELECTED_BG : CARD_BG); }`. Delete the `SelectableCard` interface and
   the `(card as unknown as SelectableCard)` cast. Keep `columnRow` as a module
   function. Keep the `Component` import (columnRow returns it).

5. **`dock/RelationDiagramPanel.ts`** — Convert to `export class
   RelationDiagramPanel extends Panel` per the Internal Structure snippet:
   fields for view state, arrow-field methods (`applyFilter`, `rebuildLegend`,
   `rebuildBase`), controls/`view`/`legend` as locals→fields, listeners wired
   post-`super()` via `.on("change", …)`. Leave `legendRow`/`labelledRow` as
   module functions. `Component` import stays (helpers use it).

6. **`dock/DatabaseDiagramPanel.ts`** — Convert to `export class
   DatabaseDiagramPanel extends Panel` following the same pattern plus the
   Database-specific notes (Overview default `view` data, `focusSchema`,
   fields for `modeControl`/`rootControl`/`tablesControls`/`legend`). Leave
   `schemaLegendRow`/`labelledRow` as module functions.

7. **`SqlAdminController.ts` (shared)** — Prefix `new` at every construction
   site: line 455 `new SchemaDiagramPanel(…)`; line 537 `new
   DatabaseDiagramPanel(…)`; lines 613 and 1410 `new RelationDiagramPanel(…)`;
   lines 695, 742, 779, 827 `new RelationGraphPanel(…)`; line 1441 `new
   RoleGrantsDiagramPanel(…)`. No signature or argument changes — only `new`.
   The imports at lines 41–46 are unchanged (same symbol names).

8. **Checkpoint** — `grep -rn -E '\b(SchemaDiagramPanel|RelationDiagramPanel|RoleGrantsDiagramPanel|DatabaseDiagramPanel|RelationGraphPanel|TableCardNode)\(' frontend/src`
   should return **zero** call sites without a preceding `new` (i.e. no bare
   `Builder(` invocation remains). The only in-file `TableCardNode(` call was
   `RelationDiagramPanel.ts:64` — now `new TableCardNode(…)`.

9. **Typecheck / build** — run the frontend typecheck and build (see
   `## Verification`); fix any residual unused-import errors surfaced by the
   dropped `import type { Component }` lines.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/SchemaDiagramPanel.ts` |
| Modify | `frontend/src/dock/RoleGrantsDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` |
| Modify | `frontend/src/dock/TableCardNode.ts` |
| Modify (shared) | `frontend/src/SqlAdminController.ts` — 9 call sites gain `new`; **`touches-shared`** (sibling class-first plans also edit this file) |

---

## Expected Behaviour

All diagram rendering is **live-only** (ELK layout no-ops under the node/jsdom
vitest harness — the `DiagramView` engine is a lazily imported browser module),
so every behaviour below is **manual-verify** in the running app unless marked
otherwise. Behaviour must be **identical** to the pre-conversion factories —
this is a mechanical refactor, not a feature change.

- **Unit-testable (the only automatable slice):** `TableCardNode.setSelected`
  is pure DOM-attribute state. If a jsdom test can construct `new
  TableCardNode(node, false)` and assert `setSelected(true)` then
  `setSelected(false)` toggles the element's background between
  `CARD_SELECTED_BG` and `CARD_BG`, add it; if the harness cannot render a
  `Panel` far enough to read the background, treat it as manual-verify. Header-
  only rendering for a node with absent/empty `data.columns` is likewise
  testable only if `Panel` renders under the harness.

- **Schema diagram tab** (navigator → schema node → "Open schema diagram"):
  nodes lay out, pan/zoom work, single-click selects, double-click opens the
  table (reuses `openReferencedTable`). No console errors.

- **Relation diagram tab** ("Show relations" on a table/view/matview): WEST
  Direction/Depth/prune/coverage controls all mutate the view; the legend lists
  nodes and hiding a node re-filters; the root card shows the accent border and
  cannot be hidden; double-click opens a node's table. The same panel reused for
  the **role membership graph** (controller line 1410) still lays out and
  double-click routes to `showRoleProperties`.

- **Database diagram tab** ("Open database diagram"): Overview mode shows one
  node per schema; double-clicking a schema node drills into Tables mode
  filtered to that schema (`focusSchema`); the Mode/Root/Direction/Depth/prune
  controls and per-schema legend behave as before; double-click a leaf opens
  that leaf's own-schema table; double-click a container is a no-op.

- **Relation graph tabs** (dependency / inheritance, controller lines
  695/742/779/827): graph lays out; when rooted, the root node shows the 2px
  accent border; double-click routes through `openReferencedTable`.

- **Role grants diagram tab** ("Show grants graph"): star lays out; double-click
  a table node opens it; double-click the role node (or a `data`-less node) is a
  no-op.

- **Selection highlight in card-mode** (RelationDiagram / role membership):
  single-clicking a `TableCardNode` swaps its background to the accent tint via
  the new `setSelected` method (DiagramView's duck-typed
  `applySelectedVisual`); clicking empty space clears it.

- **CSS class names** now read `SchemaDiagramPanel`, `RelationDiagramPanel`,
  `TableCardNode`, … instead of `DiagramView`/`Panel` — cosmetic; verify no
  visual regression (no app CSS targets the old names).

---

## Verification

- **Typecheck + build**: from `frontend/`, run the project's typecheck and
  `vite build` (per `frontend/package.json` scripts) — expect zero errors,
  including no unused-import errors from the dropped `import type { Component }`
  lines.
- **Grep invariants**:
  - `grep -rn -E '\b(SchemaDiagramPanel|RelationDiagramPanel|RoleGrantsDiagramPanel|DatabaseDiagramPanel|RelationGraphPanel)\(' frontend/src/SqlAdminController.ts`
    — every hit is preceded by `new`.
  - `grep -rn 'TableCardNode(' frontend/src/dock/RelationDiagramPanel.ts` — the
    one hit is `new TableCardNode(`.
  - `grep -rn 'SelectableCard\|as unknown as SelectableCard' frontend/src/dock/TableCardNode.ts`
    — zero matches (interface + cast removed).
- **Unit tests**: run the node vitest suite; add/keep only the
  `TableCardNode.setSelected` test if the harness can render a `Panel` (see
  `## Expected Behaviour`). Do **not** attempt to unit-test diagram layout.
- **Manual smoke** (the primary verification, live app): open each of the six
  diagram tabs listed above, confirm layout renders, controls/legend behave,
  single/double-click behave, and the browser console is error-free.

---

## Potential Challenges

- **Arrow-field vs. plain method for the composites' helpers** — `applyFilter`
  is handed to `legendRow`/`schemaLegendRow` by reference; if left a plain
  method it loses `this` and throws on the first legend toggle. Mitigation: keep
  the whole helper set as arrow fields (spelled out in Internal Structure).
- **Listener wiring order** — wire control `.on("change", …)` **after**
  `super()` (not in the construction-time `listeners:` bag) so `this` is
  initialized; the controls themselves are still built as locals before `super()`
  because they are `super()`'s children. Mitigation: the step-by-step snippet
  fixes the order.
- **Shared `SqlAdminController.ts`** — sibling class-first plans
  (`class-first-shell-views`, `class-first-work-panels`, `class-first-app-shell`)
  also edit this file. Mitigation: `touches-shared` frontmatter is set; the
  edits here are nine isolated `new`-prefixes on distinct lines, low conflict
  risk.
- **`DatabaseDiagramPanel` field-vs-local controls** — `focusSchema` and the
  mode listener mutate `modeControl`/`rootControl`/`tablesControls`/`legend`
  after construction, so these must be instance fields, not just locals.
  Mitigation: called out in Internal Structure.

---

## Critical Files

- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — the
  class-first rules (a)–(e): callable base, super-cascade, arrow-field handlers,
  instance-is-component, CSS-class rename.
- [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) —
  precedent: locals→`super()`→field-assign→wire, arrow-field handlers, stateless
  module helpers kept as functions.
- [`frontend/src/shell/LoginForm.ts`](frontend/src/shell/LoginForm.ts) — minimal
  locals→`super({ components })`→field-assign template.
- [`frontend/src/shell/ActivityBar.ts`](frontend/src/shell/ActivityBar.ts) —
  arrow-field public API + Container-vs-Panel base choice.
- [`../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts`](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts)
  — base for the thin wrappers: `class … extends Panel`, `callable()`-exported,
  `data`/`nodeRenderer`/`listeners` options, async layout in `super()`,
  duck-typed `setSelected` at line 567.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) —
  the nine call sites (455, 537, 613, 695, 742, 779, 827, 1410, 1441).

---

## Non-Goals

- **No factory left in place** — all six exported builders convert; none uses
  the composition fallback (each returns a single `DiagramView`/`Panel` that is
  the mountable component).
- **No change to the private helper factories** (`legendRow`, `labelledRow`,
  `schemaLegendRow`, `columnRow`) — they stay module functions; converting them
  is out of scope and would not fit (they are not standalone components).
- **No diagram feature/behaviour change** — layout, controls, selection, and
  activation semantics are preserved exactly; this is a structural refactor.
- **No unit tests for diagram layout** — the ELK engine is live-only; layout is
  verified manually.
