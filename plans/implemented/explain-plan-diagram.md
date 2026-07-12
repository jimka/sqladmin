# EXPLAIN Plan Diagram + Tree — Implementation Plan

## Overview

Add a presentation layer that turns a Postgres `EXPLAIN (FORMAT JSON)` plan into a **node/edge diagram** paired with a structural **tree**, opened as its own Dock tab. Selecting a tree row selects the matching diagram node **and scrolls it into the diagram viewport**; selecting a diagram node highlights and scrolls its tree row (the reverse is included — it is cheap once the tree is fully expanded and closes the loop without feedback since neither programmatic `selectNode` emits).

The EXPLAIN plumbing already exists ([`data/api.ts:237`](frontend/src/data/api.ts#L237) `runExplain`, [`contract.ts:89`](frontend/src/contract.ts#L89) `QueryExplainResult.planJson`). This feature is **additive**: a new pure parse module, a new diagram builder, a new Dock panel, one new toolbar button in `QueryPanel`, one new controller open-method, and **two small library additions** to `@jimka/typescript-ui` (a `DiagramView.revealNode` and a `Tree.expandAll`, since neither exists today).

The JSON plan tree is obtained the same way the JSON export already does it ([`dock/exportExplainResult.ts:47`](frontend/src/dock/exportExplainResult.ts#L47)): a second `runExplain(..., { format: "json" })` re-request. The diagram button is enabled only when an Explain text plan is already shown, and it re-requests JSON with **the same `analyze` flag** as that plan — reusing the established on-demand-JSON pattern rather than adding a third explain code path.

---

## Architecture Decisions

### Entry point — a "diagram" button gated on an existing Explain plan
`QueryPanel` gains an "Explain diagram" toolbar button (glyph `sitemap`) placed after the Explain Analyze button. It is enabled **only while an Explain tab exists** (`explainSlot !== null`); clicking it re-requests the shown statement as `FORMAT JSON` with `analyze: explainSlot.result.analyze` and opens the diagram tab. Rationale: this reuses the exact "re-request the same statement as JSON on demand" pattern `exportExplainPlan` uses, needs no duplicate read-only guard (the text Explain already ran and, for analyze, already passed `isReadOnlyStatement`), and the analyze flag naturally follows what the user explained. **Rejected**: a standalone always-enabled button that runs its own plain `EXPLAIN (FORMAT JSON)` — it would add a third explain path plus a duplicated read-only check for no real gain.

### Pure parse module owns the FORMAT JSON → model mapping
A new DOM-free `data/parseExplainPlan.ts` (sibling of [`data/explain.ts`](frontend/src/data/explain.ts)) converts `planJson: unknown` into an `ExplainPlanNode[]` tree. It imports **no** UI-bundle code (same purity discipline as [`buildSchemaDiagram.ts:26`](frontend/src/data/buildSchemaDiagram.ts#L26)'s `TABLE_GLYPH` note) so the app's node-only vitest red-greens it without a DOM. Node ids are **stable path strings** (`"0"`, `"0/0"`, `"0/1"`, `"0/0/0"`) derived from array position, so the same id keys a diagram node, a tree row's payload, and the two selection maps.

### Node id is the single correlation key
`DiagramNodeData.id === ExplainPlanNode.id`, and each `TreeNode.data` carries that same id string (the library `Tree` treats `TreeNode.data` as an opaque payload and has **no** `id` field — [`TreeNode.ts:58`](../../typescript-ui/src/typescript/lib/component/tree/TreeNode.ts)). Tree selection → `node.data as string` → `diagram.selectNode(id).revealNode(id)`. Diagram selection → `id` → `treeNodeById.get(id)` → `tree.selectNode(treeNode)`.

### DiagramView needs a new `revealNode` — the geometry lives in the view
`DiagramView` has `selectNode(id)` (highlight, no emit — [`DiagramView.ts:534`](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L534)) but **no** scroll-into-view. Add `revealNode(id)` to the library class, not the app panel: only the view holds the node components' laid-out positions (`_nodeComponents`), the current zoom, and the viewport scroll accessors. Pan in this view is native scroll on the viewport Panel and nodes sit at **unscaled** graph coordinates under a `scale(zoom)` transform on the content host, so the reveal math is exactly the inverse of `_handleWheel`'s ([`DiagramView.ts:713`](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts#L713)) — see `## Public API`.

### Tree needs `expandAll` so the whole plan is visible and selectable
`Tree.setNodes` collapses every node ([`Tree.ts:123`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts#L123)) and the Tree exposes no expand-all. A plan tree must show its full structure, and — critically — `Tree.selectNode` **no-ops on a node whose ancestor is collapsed** ([`Tree.ts:199`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts#L199)), so the diagram→tree reverse selection would silently fail for deep nodes unless every row is in the flattened set. Add a small public `Tree.expandAll()` and call it right after `setNodes`.

### The panel is class-first `extends Panel`, Border WEST tree + CENTER diagram
Follows the [`RelationDiagramPanel`](frontend/src/dock/RelationDiagramPanel.ts) template exactly: a `Border`-layout `Panel` with a fixed-width WEST `Tree` and a CENTER `DiagramView`. Children are built as locals **before** `super()` (they are `super()`'s children — the super-cascade trap, COMPONENT_CONVENTIONS (b)); fields are assigned and `.on(...)` listeners wired **after** `super()`. No disposer is registered — `Tree` and `DiagramView` need no explicit teardown (`SchemaDiagramPanel` is likewise opened without a `_panelDisposers` entry, [`SqlAdminController.ts:442`](frontend/src/SqlAdminController.ts#L442)).

---

## Public API

### Library: `DiagramView.revealNode` (new — `component/diagram/DiagramView.ts`)

```ts
/**
 * Scrolls the viewport so the given node is centred, without changing the
 * selection or emitting any event. No-op for an unknown id or before the
 * first layout has positioned the node. Pair with {@link selectNode} to both
 * highlight and reveal.
 *
 * @param id - The node id to centre, or a no-op when not found.
 * @returns This view, for method chaining.
 */
revealNode(id: string): this
```

Body (node components carry **unscaled** graph coords via `getX/getY`; the content host applies `scale(zoom)`; `this` is the scrolling viewport Panel):

```ts
revealNode(id: string): this {
    const component = this._nodeComponents.get(id);

    if (!component) {
        return this;
    }

    const zoom = this.getZoom();

    // Node centre in scaled (on-screen) coordinates; the inverse of
    // _handleWheel's graphX = (pointer + scroll) / zoom.
    const centreX = (component.getX() + component.getWidth()  / 2) * zoom;
    const centreY = (component.getY() + component.getHeight() / 2) * zoom;

    // Scroll so the centre lands at the viewport centre; the DOM clamps the
    // upper bound on write-back (setScrollLeft reads the applied value).
    this.setScrollLeft(Math.max(0, centreX - this.getWidth()  / 2));
    this.setScrollTop (Math.max(0, centreY - this.getHeight() / 2));

    return this;
}
```

All accessors are confirmed to exist: `getX/getY/getWidth/getHeight/getPreferredSize` on `Component`, `getScrollLeft/Top`, `setScrollLeft/Top` on `Component`, `getZoom()` on `DiagramView`. `_nodeComponents` is the private id→component map populated by `applyLayout`.

### Library: `Tree.expandAll` (new — `component/tree/Tree.ts`)

```ts
/**
 * Expands every node that has (already-loaded) children, so the whole tree
 * is flattened and visible. Does not load lazy branches and does not change
 * the selection or emit any event.
 *
 * @returns This tree, for method chaining.
 */
expandAll(): this {
    const addExpandable = (nodes: TreeNode[]): void => {
        for (const node of nodes) {
            if (node.children && node.children.length > 0) {
                this._expandedNodes.add(node);
                addExpandable(node.children);
            }
        }
    };

    addExpandable(this._nodes);
    this._reflattenAndRender();

    return this;
}
```

Uses the existing private `_expandedNodes` set and `_reflattenAndRender()` ([`Tree.ts:513`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts#L513)). Insert it as a public method near `setNodes`.

### App: parsed model + parser (new — `frontend/src/data/parseExplainPlan.ts`)

```ts
/** One key metric shown for a plan node (numeric so tests can assert it). */
export interface ExplainMetric {
    label: string;   // e.g. "cost", "rows", "actual time (ms)", "actual rows", "loops"
    value: number;
}

/** A parsed EXPLAIN plan node; the tree/diagram share these ids. */
export interface ExplainPlanNode {
    id: string;                       // stable path: "0", "0/0", "0/1", ...
    nodeType: string;                 // "Node Type", e.g. "Seq Scan"
    label: string;                    // display heading, e.g. "Seq Scan on users"
    relationName?: string;            // "Relation Name" when present
    metrics: ExplainMetric[];         // cost/rows(+actual when analyze), in fixed order
    children: ExplainPlanNode[];
}

/**
 * Parse a Postgres `EXPLAIN (FORMAT JSON)` payload into a plan-node forest.
 * Tolerant of shape: returns [] for anything that is not an array of objects
 * each carrying a "Plan" object.
 *
 * @param planJson - The raw `QueryExplainResult.planJson` (typed unknown).
 * @returns The root plan nodes (usually one), or [] when malformed/empty.
 */
export function parseExplainPlan(planJson: unknown): ExplainPlanNode[]
```

### App: diagram builder (new — `frontend/src/data/buildExplainDiagram.ts`)

```ts
/**
 * Build the DiagramView graph for a parsed plan forest: one node per plan
 * node (id === ExplainPlanNode.id), one edge per parent→child link. Top-down
 * layered layout so the root plan node sits at the top like the text plan.
 *
 * @param roots - The parsed plan roots (from parseExplainPlan).
 * @returns Nodes + edges + DOWN-layered layout options for DiagramView.
 */
export function buildExplainDiagram(roots: ExplainPlanNode[]): DiagramData
```

### App: the panel (new — `frontend/src/dock/ExplainDiagramPanel.ts`)

```ts
/**
 * A read-only Dock panel pairing a structural plan Tree (WEST) with the plan
 * DiagramView (CENTER). Tree selection selects + reveals the diagram node;
 * diagram selection selects + reveals the tree row. Class-first: extends Panel.
 */
export class ExplainDiagramPanel extends Panel {
    constructor(roots: ExplainPlanNode[])
}
```

### App: `QueryPanelOptions` gains one callback ([`QueryPanel.ts:95`](frontend/src/dock/QueryPanel.ts#L95))

```ts
/**
 * Open the plan as a tree+diagram tab. The panel calls this with the shown
 * statement and the analyze flag of the current Explain plan; the controller
 * re-requests FORMAT JSON, parses it, and opens ExplainDiagramPanel.
 */
onExplainDiagram?: (sql: string, analyze: boolean) => void;
```

---

## Internal Structure

### `parseExplainPlan` mapping (Postgres FORMAT JSON)

Source shape (array, one entry per statement — normally length 1):
```
[ { "Plan": { "Node Type": "...", "Relation Name": "...", "Alias": "...",
              "Total Cost": n, "Plan Rows": n, "Plan Width": n,
              "Actual Total Time": n, "Actual Rows": n, "Actual Loops": n,
              "Plans": [ ...child Plan objects... ] },
    "Planning Time": n, "Execution Time": n } ]   // last two only when analyze
```

Per node:
- `nodeType` ← `"Node Type"` (string; skip/`""` guard if missing).
- `relationName` ← `"Relation Name"` when a string.
- `label` ← `nodeType` + `" on " + relationName` when present, else `nodeType`; append `"(" + alias + ")"` only when `"Alias"` differs from `relationName`. Keep it one line.
- `metrics`, in this fixed order, each pushed only when the source field is a finite number:
  - always-present (plain EXPLAIN): `{ "cost", "Total Cost" }`, `{ "rows", "Plan Rows" }`, `{ "width", "Plan Width" }`.
  - analyze-only: `{ "actual time (ms)", "Actual Total Time" }`, `{ "actual rows", "Actual Rows" }`, `{ "loops", "Actual Loops" }`.
- `children` ← recurse over `"Plans"` (array) when present, else `[]`.
- `id` ← path: root `String(rootIndex)`; child `k` of a node with id `P` → `` `${P}/${k}` ``.

Diagram node label: reuse `label`; optionally append the first metric inline (`` `${label} · ${metrics[0].label} ${metrics[0].value}` ``) so the default `DiagramNode` (single-line `{ label, glyph }`) still reads usefully. A custom multi-line node renderer is a **Non-Goal**.

### `buildExplainDiagram`

```ts
const LAYOUT_OPTIONS: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",   // root at top, inputs below — matches the text plan
};
```
Walk `roots` depth-first: for each node push `{ id, label: <diagram label>, glyph: "sitemap" }`; for each child push edge `{ id: `${node.id}->${child.id}`, source: node.id, target: child.id }`. Return `{ nodes, edges, layoutOptions: LAYOUT_OPTIONS }`. (No `width/height`/ports — the default `DiagramNode` preferred size is used, as in `buildSchemaDiagram` flat mode.)

### `ExplainDiagramPanel` (Border WEST tree + CENTER diagram)

```ts
import { Panel } from "@jimka/typescript-ui/core";
import { Border } from "@jimka/typescript-ui/layout";
import { Placement } from "@jimka/typescript-ui/primitive";
import { Tree } from "@jimka/typescript-ui/component/tree";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import { DiagramView } from "@jimka/typescript-ui/component/diagram";
import type { DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { sitemap } from "@jimka/typescript-ui/glyphs/solid/sitemap";
import { buildExplainDiagram } from "../data/buildExplainDiagram";
import type { ExplainPlanNode } from "../data/parseExplainPlan";

Glyph.register(sitemap);

const TREE_WIDTH = 300; // WEST tree width: fits a node-type label + indentation without stealing canvas.

// module-level pure helpers:
// toTreeNodes(roots, byId): TreeNode[]  — each { label: n.label, children, data: n.id }, filling byId[n.id] = treeNode
// indexPlan(roots): Map<string, ExplainPlanNode> (unused by wiring; keep only byId map above if not needed)

constructor(roots) {
    const data = buildExplainDiagram(roots);
    const tree = new Tree();
    const treeNodeById = new Map<string, TreeNode>();

    tree.setNodes(toTreeNodes(roots, treeNodeById));
    tree.expandAll();

    const diagram = new DiagramView({ data });

    const west = Panel({
        layoutManager: new Border(),
        preferredSize: { width: TREE_WIDTH, height: 0 },
        minSize      : { width: TREE_WIDTH, height: 0 },
        components: [{ component: tree, constraints: { placement: Placement.CENTER } }],
    });

    super({
        layoutManager: new Border(),
        components: [
            { component: west,    constraints: { placement: Placement.WEST } },
            { component: diagram, constraints: { placement: Placement.CENTER } },
        ],
    });

    // Tree → diagram: select + scroll into the diagram viewport (the hard requirement).
    tree.on("selection", (nodes: TreeNode[]) => {
        const id = nodes[0]?.data;
        if (typeof id === "string") { diagram.selectNode(id).revealNode(id); }
    });

    // Diagram → tree: highlight + scroll the row (reverse; tree.selectNode no-ops
    // only if hidden — expandAll above guarantees every row is visible).
    diagram.on("selection", (sel: DiagramNodeData[]) => {
        const picked = sel[0];
        const treeNode = picked && treeNodeById.get(picked.id);
        if (treeNode) { tree.selectNode(treeNode); }
    });
}
```
Neither `tree.selectNode` nor `diagram.selectNode`/`revealNode` emits, so there is no selection feedback loop; only genuine user clicks fire `"selection"`.

### `QueryPanel` button wiring ([`QueryPanel.ts`](frontend/src/dock/QueryPanel.ts))

- Destructure `onExplainDiagram` from options (line ~146).
- After `analyzeButton` (line ~203) add:
  ```ts
  const diagramButton = glyphButton("sitemap", NEUTRAL_COLOR, "Explain diagram", () => openExplainDiagram());
  ```
  Register `sitemap` in the existing `Glyph.register(...)` call (line 82) and import it.
- Insert `diagramButton` into the ToolBar `components` array (line ~218) right after `analyzeButton`.
- Add helper and enable/disable sync:
  ```ts
  function syncDiagramButton(): void { diagramButton.setEnabled(explainSlot !== null); }
  function openExplainDiagram(): void {
      if (!explainSlot) { return; }              // defensive — button is disabled otherwise
      onExplainDiagram?.(explainSlot.sql, explainSlot.result.analyze);
  }
  ```
- Call `syncDiagramButton()` at the end of `showPlan` (after `explainSlot = …`, line ~695), in `removeExplainTab` (after `explainSlot = null`, line ~311), in `clear`, and in the initial-state block (line ~800) so it starts disabled. `setBusy` does **not** need to touch it (opening the diagram does not run a query; it is fine to leave enabled while a run is in flight, but for parity with the other action buttons you may disable it in `setBusy(true)` and restore via `syncDiagramButton()` in `setBusy(false)` — either is acceptable).

### Controller open-method ([`SqlAdminController.ts`](frontend/src/SqlAdminController.ts))

In `openQuery` (line ~887) pass the new callback into `new QueryPanel({...})`:
```ts
onExplainDiagram: (sql, analyze) => void this.openExplainDiagram(sql, analyze, label),
```
Add the method (near `openSchemaDiagram`, ~line 429):
```ts
/**
 * Open a plan tree+diagram tab: re-request the statement as FORMAT JSON, parse
 * it, and mount an ExplainDiagramPanel. A malformed/empty plan notifies and
 * opens nothing. Not deduped — each invocation opens a fresh tab.
 */
async openExplainDiagram(sql: string, analyze: boolean, label?: string): Promise<void> {
    let planJson: unknown;
    try {
        planJson = (await runExplain(this._connectionId, sql, { analyze, format: "json" })).planJson;
    } catch (err) { this.notifyError(err); return; }

    const roots = parseExplainPlan(planJson);
    if (roots.length === 0) { this.statusBar.setMessage(`${this._connectionId}: no JSON plan tree`); return; }

    const id = `explain-diagram-${++this._explainDiagramCounter}`;
    this.dock.addPanel({
        id,
        title  : `${label ?? "Query"} (plan diagram)`,
        glyph  : "sitemap",
        content: new ExplainDiagramPanel(roots),
    });
}
```
Add a private counter field `private _explainDiagramCounter = 0;` (mirrors `_queryCounter`) and import `parseExplainPlan` + `ExplainDiagramPanel`. `runExplain` is already imported (line 22).

---

## Ordered Implementation Steps

1. **Library — `Tree.expandAll`** in `/home/jika/typescript/typescript-ui/src/typescript/lib/component/tree/Tree.ts`: add the public method from `## Public API` next to `setNodes`.
2. **Library — `DiagramView.revealNode`** in `.../component/diagram/DiagramView.ts`: add the public method from `## Public API` next to `selectNode`.
3. **Build the library**: from `/home/jika/typescript/typescript-ui` run `npm run build:lib` (NOT `npm run build`) so sqladmin's symlinked `dist/lib` picks up the two new methods (project memory: "sqladmin consumes built dist/lib").
4. **`frontend/src/data/parseExplainPlan.ts`** (new): implement `ExplainMetric`, `ExplainPlanNode`, `parseExplainPlan` per `## Internal Structure`. Type-only imports; no UI-bundle imports.
5. **`frontend/tests/data/parseExplainPlan.test.ts`** (new): cover the `## Expected Behaviour` parse cases.
6. **`frontend/src/data/buildExplainDiagram.ts`** (new): implement `buildExplainDiagram` per `## Internal Structure`. Import `DiagramData` type from `@jimka/typescript-ui/component/diagram` (type-only, like `buildSchemaDiagram`).
7. **`frontend/tests/data/buildExplainDiagram.test.ts`** (new): assert node/edge ids and counts (see `## Expected Behaviour`).
8. **`frontend/src/dock/ExplainDiagramPanel.ts`** (new): the class-first panel per `## Internal Structure`, including module-level `toTreeNodes` and the `treeNodeById` map.
9. **`frontend/src/dock/QueryPanel.ts`**: import + register `sitemap`; add `diagramButton`, `syncDiagramButton`, `openExplainDiagram`; destructure `onExplainDiagram`; extend `QueryPanelOptions`; wire the enable/disable sync at the four sites listed.
10. **`frontend/src/SqlAdminController.ts`**: import `parseExplainPlan` + `ExplainDiagramPanel`; add `_explainDiagramCounter`; add `openExplainDiagram`; pass `onExplainDiagram` in `openQuery`.
11. **Typecheck + tests + build** (see `## Verification`).

Regression checkpoint after step 9: `grep -n "sitemap" frontend/src/dock/QueryPanel.ts` — expect the import, the `Glyph.register` arg, and the button.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `/home/jika/typescript/typescript-ui/src/typescript/lib/component/tree/Tree.ts` (add `expandAll`) |
| Modify | `/home/jika/typescript/typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts` (add `revealNode`) |
| Create | `frontend/src/data/parseExplainPlan.ts` |
| Create | `frontend/src/data/buildExplainDiagram.ts` |
| Create | `frontend/src/dock/ExplainDiagramPanel.ts` |
| Create | `frontend/tests/data/parseExplainPlan.test.ts` |
| Create | `frontend/tests/data/buildExplainDiagram.test.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` (button, option, sync) |
| Modify | `frontend/src/SqlAdminController.ts` (open-method, callback wiring) |

---

## Expected Behaviour

**Unit-testable — `parseExplainPlan`** (`frontend/tests/data/parseExplainPlan.test.ts`):
- A single-node plain plan `[{ "Plan": { "Node Type": "Seq Scan", "Relation Name": "users", "Total Cost": 12.5, "Plan Rows": 100, "Plan Width": 8 } }]` → one root: `id === "0"`, `nodeType === "Seq Scan"`, `label === "Seq Scan on users"`, `relationName === "users"`, `children === []`, and `metrics` = `[{cost,12.5},{rows,100},{width,8}]` (no actual-* entries).
- A nested plan (root with `"Plans": [childA, childB]`, childA with one grandchild) → ids `"0"`, `"0/0"`, `"0/1"`, `"0/0/0"`; parent/child nesting preserved.
- Analyze plan (nodes carry `"Actual Total Time"`, `"Actual Rows"`, `"Actual Loops"`) → `metrics` additionally include `actual time (ms)`, `actual rows`, `loops` in that order after the plan metrics.
- A node with no `"Relation Name"` (e.g. `"Hash Join"`) → `label === nodeType`, `relationName` undefined.
- A node missing an optional numeric field (e.g. no `"Plan Width"`) → that metric is omitted, others present (no `NaN`/`undefined` metric values).
- Malformed inputs each → `[]`: `undefined`, `null`, `{}` (not an array), `[]`, `[{}]` (no `"Plan"`), `[{ "Plan": 5 }]` (Plan not an object).
- Multi-statement array (length 2) → two roots with ids `"0"` and `"1"`.

**Unit-testable — `buildExplainDiagram`** (`frontend/tests/data/buildExplainDiagram.test.ts`):
- Roots from a 4-node nested plan → `nodes.length === 4` with ids `"0","0/0","0/1","0/0/0"`; `edges` = parent→child pairs (`0→0/0`, `0→0/1`, `0/0→0/0/0`) with `source`/`target` matching and unique `id`s; `layoutOptions["elk.direction"] === "DOWN"`.
- Empty roots `[]` → `{ nodes: [], edges: [] }` (plus layoutOptions).
- Every `DiagramNodeData.id` equals its `ExplainPlanNode.id` (correlation invariant).

**Manual-verify — selection, scroll, geometry (UI events; not exercisable by the node vitest):**
- Run a query, click **Explain** (or **Explain Analyze**), then the **Explain diagram** button → a new "(plan diagram)" tab opens with the tree on the left (fully expanded) and the diagram on the right.
- The **Explain diagram** button is disabled until an Explain plan tab exists, and re-disabled after the Explain tab is closed or Clear is pressed.
- Click a **deep** tree row → the matching diagram node highlights **and the diagram scrolls to centre it** (the hard requirement). Verify with a plan large enough that the target node starts off-screen.
- Click a diagram node → its tree row highlights and the tree scrolls it into view.
- With the diagram zoomed out then in (wheel), tree→diagram reveal still centres correctly (zoom is folded into the geometry).
- Analyze diagram shows actual-time/rows in node labels; plain diagram shows cost/rows.

---

## Verification

- **Typecheck**: `cd frontend && npm run typecheck` (or the repo's configured TS check) — expect clean.
- **Build the library first** (only after steps 1–2): `cd /home/jika/typescript/typescript-ui && npm run build:lib`. Without this the app cannot see `revealNode`/`expandAll` (it imports the built, symlinked `dist/lib`).
- **Unit tests**: `cd frontend && npx vitest run tests/data/parseExplainPlan.test.ts tests/data/buildExplainDiagram.test.ts` — cover every `## Expected Behaviour` parse/build case. Then the full `npx vitest run`.
- **App build**: `cd frontend && npm run build`.
- **Manual smoke** (the selection/scroll requirement the harness can't drive): launch the app, open a query, Explain → Explain diagram, then exercise the tree→diagram select-and-scroll and diagram→tree cases from `## Expected Behaviour`.

---

## Potential Challenges

- **Reveal before layout**: `revealNode` reads laid-out node geometry, which is 0 until ELK's async layout lands. Mitigation: reveals are user-click-driven, long after open; do **not** auto-reveal on construction. If a future auto-select-root is added, defer its reveal to the `DiagramView` `"layout"` event.
- **`getWidth()` on the viewport includes any scrollbar band**, so centring can be a few px off. Acceptable for "scroll into view"; the node lands well inside the viewport. Flagged as manual-verify.
- **`Tree.selectNode` silently no-ops on a collapsed ancestor** — the reason `expandAll()` must run right after `setNodes` (Architecture Decisions).
- **Two library edits require `build:lib`** — forgetting it yields a runtime "revealNode is not a function". Step 3 pins it before any app code compiles against the methods.

---

## Critical Files

- [`frontend/src/dock/RelationDiagramPanel.ts`](frontend/src/dock/RelationDiagramPanel.ts) — the class-first Border-layout panel template (locals→`super()`→fields; `.on()` after super).
- [`frontend/src/data/buildSchemaDiagram.ts`](frontend/src/data/buildSchemaDiagram.ts) — pure diagram-builder + `DiagramData` shape + no-UI-imports purity note.
- [`frontend/src/data/explain.ts`](frontend/src/data/explain.ts) / [`frontend/src/dock/exportExplainResult.ts`](frontend/src/dock/exportExplainResult.ts) — the pure-module home and the on-demand FORMAT JSON re-request pattern.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — toolbar/`explainSlot`/button-sync sites to edit.
- [`../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts`](../../typescript-ui/src/typescript/lib/component/diagram/DiagramView.ts) and [`.../component/tree/Tree.ts`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts) — where `revealNode` / `expandAll` are added.
- [`frontend/src/roles/RolesTree.ts`](frontend/src/roles/RolesTree.ts) — `Tree` subclass usage (`setNodes`, `TreeNode.data` payload, `"selection"` wiring).
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — class-first rules (super-cascade, arrow-field handlers).

---

## Non-Goals

- A custom multi-line diagram-node renderer showing a full metrics table — the default single-line `DiagramNode` label (heading + first metric) is enough for the first cut.
- A resizable gutter between tree and diagram — the fixed-width WEST tree matches `RelationDiagramPanel`; a `Split` can come later.
- Deduping diagram tabs by SQL, an inspector/detail pane on selection, or editing/re-running the plan from the diagram.
- Parsing `FORMAT TEXT` plans — the diagram consumes `planJson` only.
