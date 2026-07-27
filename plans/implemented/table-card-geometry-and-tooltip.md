# Table Card Geometry & Tooltip — Implementation Plan

## Overview

Two defects in the card-mode table node of the relation-rooted ER diagram — the cards drawn by [TableCardNode.ts](frontend/src/dock/TableCardNode.ts) from the geometry seam [schemaCardModel.ts](frontend/src/data/schemaCardModel.ts).

**(a) Foreign-key edges land below the row they belong to, by an error that grows down the card.** `schemaCardModel` pins each FK port at [columnPortY:58](frontend/src/data/schemaCardModel.ts#L58) — `28 + 22·index + 10.5`, measured from the card's top-left — and sizes the card at [cardHeight:46](frontend/src/data/schemaCardModel.ts#L46) — `28 + 22·columnCount`. `TableCardNode` then renders that same `cardHeight` as the card's box **including** a 1px border (2px for the root card, [ROOT_BORDER:28](frontend/src/dock/TableCardNode.ts#L28)) and `Panel`'s default 4px insets, so the card's usable inner height is ~10px short of what its header and rows need. `VBox` shrinks every child to fit instead of overflowing, each row renders about 20.4px instead of 22, and the ports stay pinned in the unshrunk coordinate space. Measured in the running app: rows render 20.33px on a 4-column non-root card and 20.5px on the 6-column root card, and the port-to-row-centre error walks from −1.66px on the first row to +4.25px on the root card's last row.[^mechanism] This is not an elkjs bug: ELK places each port exactly where it was told.

The fix makes the card's box decoration **layout-neutral** — zero top/bottom insets, and the frame painted as a CSS `outline` (which takes no layout space) instead of a `border`. The card's inner height then equals `cardHeight(n)` exactly, every row renders at its full 22px, and the root and non-root cards share one geometry despite their different frame widths.

**(b) The hover tooltip shows only column information.** [columnTooltip:98](frontend/src/data/schemaCardModel.ts#L98) is the whole tooltip today, attached per row inside [columnRow:182](frontend/src/dock/TableCardNode.ts#L182). It gains a table block above it, separated by a blank line, and the table block alone becomes the tooltip for the rest of the card — including the header strip, which shows no tooltip at all today.

Both parts are **app-only**: no library change is needed. `Component.setOutline` and the `insets` option already exist ([Component.ts:2442](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2442), [Panel.ts:113](../typescript-ui/packages/lib/src/typescript/lib/core/Panel.ts#L113)), so nothing has to be rebuilt with `npm run build:lib`.

---

## Architecture Decisions

### The card's box decoration becomes layout-neutral

`TableCardNode` passes `insets: new Insets(0, 4, 0, 4)` (zero top and bottom, the Panel default 4px kept on the sides) and paints its frame with `setOutline` instead of `setBorder`. The card's inner height is then exactly the `cardHeight` ELK laid the node out at, so no child shrinks and a rendered row's centre coincides with its pinned port.[^layout-neutral]

The precedent is the sibling card node in the same app: [ExplainNode.ts:52-62](frontend/src/dock/ExplainNode.ts#L52) keeps its border at 1px in **both** states and expresses the extra emphasis as a `box-shadow`, because "a 1px→2px border would nudge everything in". This plan applies the same principle one step further — the frame takes no layout space in either state, so the root card's wider accent frame cannot shift its rows either. Zeroing the vertical insets also follows [ARCHITECTURE.md's "No cosmetic insets or padding"](../typescript-ui/ARCHITECTURE.md#L118): the 4px vertical inset is inherited `Panel` decoration that the card's fixed-height row grid never asked for, and the horizontal 4px stays because it is real structural breathing room between the frame and the row text.

### `schemaCardModel` keeps every geometry number, and gains no new one

`CARD_HEADER_HEIGHT`, `CARD_ROW_HEIGHT`, `cardHeight`, and `columnPortY` are unchanged. The chosen fix removes the offsets rather than compensating for them, so the renderer needs no border or inset figure from the model — which is exactly why it wins over folding the decoration into the formulas.[^layout-neutral] What `schemaCardModel`'s header comment gains is the rule that makes the seam safe: `cardHeight` is the card element's **outer** box, so the renderer must add no vertical decoration.

### The tooltip text is composed in `schemaCardModel`, not in the renderer

`schemaCardModel` gains `tableTooltip` (the table block) and `cardTooltip` (the table block, a blank line, then the column block). `columnTooltip` keeps its current signature and output. All three are pure string functions, so the blank-line rule and every "omit this line when empty" case is unit-testable under the app's node vitest — the same reason `columnTooltip` and `fkEdgeTooltip` already live in `src/data/`.

The table block's first line is the relation's **unlabelled** name, matching the heading-then-detail shape of [fkEdgeTooltip.ts:91-93](frontend/src/data/fkEdgeTooltip.ts#L91). The detail lines are the column count, the primary-key columns, and the foreign-key columns, each omitted when it has nothing to say.[^table-block]

| card | table block |
|---|---|
| `credit_notes`: 4 columns, PK `id`, FK columns `invoice_id`, `order_id` | `credit_notes` / `Columns: 4` / `Primary key: id` / `Foreign keys: invoice_id, order_id` |
| `order_items`: 3 columns, composite PK `order_id`, `line_no` (and `order_id` is also an FK column) | `order_items` / `Columns: 3` / `Primary key: order_id, line_no` / `Foreign keys: order_id` |
| `audit_log`: 2 columns, no PK, no FK | `audit_log` / `Columns: 2` |
| a role node in the reused membership graph: no columns at all | `analyst` |

### The table block is attached to the card, so the header shows it on its own

`Tooltip.attach(this, tableBlock)` in the constructor, alongside the per-row `Tooltip.attach(row, cardTooltip(...))` that already exists. Hovering a row shows the combined tooltip; hovering anywhere else on the card — the header strip, the 4px side margins, or the whole card when a node has no columns — shows the table block alone. The header stays pointer-transparent, so its comment at [TableCardNode.ts:113-118](frontend/src/dock/TableCardNode.ts#L113) stands unchanged.[^tooltip-attach]

---

## Public API

Three exports from `frontend/src/data/schemaCardModel.ts` (`columnTooltip` unchanged, two new):

```ts
/** The table block: unlabelled name heading, then Columns / Primary key / Foreign keys lines. */
export function tableTooltip(label: string, columns: readonly ColumnRowData[]): string;

/** The existing column block: Name / Type / Attributes. Unchanged. */
export function columnTooltip(column: ColumnRowData): string;

/** A card row's full tooltip: the table block, a blank line, then the column block. */
export function cardTooltip(table: string, column: ColumnRowData): string;
```

`cardTooltip`'s `table` parameter is the string `tableTooltip` returned — built once per card and shared by every row, rather than recomputed per row.

---

## Implementation

### `tableTooltip`

```ts
export function tableTooltip(label: string, columns: readonly ColumnRowData[]): string {
    const lines = [label];

    if (columns.length > 0) {
        lines.push(`Columns: ${columns.length}`);
    }

    const pk = columns.filter(c => c.pk).map(c => c.name);
    const fk = columns.filter(c => c.fk).map(c => c.name);

    if (pk.length > 0) {
        lines.push(`Primary key: ${pk.join(", ")}`);
    }

    if (fk.length > 0) {
        lines.push(`Foreign keys: ${fk.join(", ")}`);
    }

    return lines.join("\n");
}
```

### `cardTooltip`

```ts
export function cardTooltip(table: string, column: ColumnRowData): string {
    return `${table}\n\n${columnTooltip(column)}`;
}
```

### The card's box in `TableCardNode`

Constants replacing `ROOT_BORDER` / `CARD_BORDER`, plus the surviving horizontal inset:

```ts
// The card's frame, painted as an `outline` rather than a `border`: an outline
// takes no layout space, so the card's inner height stays exactly
// cardHeight(columns.length) and every row renders at its full CARD_ROW_HEIGHT
// — which is what makes a row's centre coincide with the FK port
// schemaCardModel pinned to it. A border would eat 1px (2px on the root card)
// off the inner height and shrink every row instead. Same widths and colours as
// the borders they replace.
const CARD_OUTLINE = "1px solid var(--ts-ui-border-color, rgb(180, 180, 180))";
const ROOT_OUTLINE = "2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))";

// Horizontal breathing room between the card's frame and its row text — the
// Panel default, restated because the card must pass explicit insets to get
// ZERO vertical ones (see schemaCardModel's header comment).
const CARD_INSET_X = 4;
```

The `super()` options bag gains one entry, and the border setter becomes an outline setter:

```ts
super({
    layoutManager: new VBox({ spacing: 0 }),
    preferredSize: { width: CARD_WIDTH, height: cardHeight(columns.length) },
    insets       : new Insets(0, CARD_INSET_X, 0, CARD_INSET_X),
    components   : [header, ...rowComponents],
});

this.rows = rows;

this.setOutline(isRoot ? ROOT_OUTLINE : CARD_OUTLINE);   // was setBorder(isRoot ? ROOT_BORDER : CARD_BORDER)
this.setBackgroundColor(CARD_BG);                        // unchanged
this.setCursor("pointer");                               // unchanged
```

---

## Ordered Implementation Steps

1. **`frontend/src/data/schemaCardModel.ts` — extend the header comment.** After the existing "Pure and DOM-free" sentence, state the renderer contract: `cardHeight` is the card element's **outer** box height (the size ELK lays the node out at, which `DiagramView` commits as the component's preferred size under `box-sizing: border-box`), and `columnPortY` is measured from that outer box's top edge — so the renderer must add no vertical decoration to the card (zero top/bottom insets, no top/bottom border or padding) — decoration shrinks every row and walks the FK edges off their rows.

2. **`frontend/src/data/schemaCardModel.ts` — add `tableTooltip`.** Place it immediately above `columnTooltip` (line 88's doc comment). Body per _Implementation_. JSDoc: what the block contains, which lines are omitted when empty, that the name heading is unlabelled, and that a node with no columns yields the heading alone (the reused role-membership graph).

3. **`frontend/src/data/schemaCardModel.ts` — add `cardTooltip`.** Place it immediately below `columnTooltip`. Body per _Implementation_. JSDoc must say the `table` argument is `tableTooltip`'s result, computed once per card, and that the blank line is what separates the two blocks in the rendered tooltip.

4. **`frontend/tests/data/schemaCardModel.test.ts` — add the two tooltip suites and the port-centre test** from `## Expected Behaviour` (unit-testable rows only). Run `npm run test` in `frontend/` — the new tests fail until step 2 and 3 land, and the port-centre test passes immediately (it pins arithmetic this plan does not change).

5. **`frontend/src/dock/TableCardNode.ts` — swap border for outline.** Replace the `ROOT_BORDER` / `CARD_BORDER` constants with `ROOT_OUTLINE` / `CARD_OUTLINE` and add `CARD_INSET_X` (all three comments per _Implementation_); change [line 137](frontend/src/dock/TableCardNode.ts#L137) from `this.setBorder(...)` to `this.setOutline(...)`. Add `import { Insets } from "@jimka/typescript-ui/primitive";` (the import form [ExplainNode.ts:21](frontend/src/dock/ExplainNode.ts#L21) uses).

6. **`frontend/src/dock/TableCardNode.ts` — zero the vertical insets.** Add `insets: new Insets(0, CARD_INSET_X, 0, CARD_INSET_X)` to the `super()` options bag at [lines 129-133](frontend/src/dock/TableCardNode.ts#L129).

7. **`frontend/src/dock/TableCardNode.ts` — wire the tooltips.** In the constructor, build `const tableBlock = tableTooltip(node.label ?? node.id, columns);` as a local **before** `super()` (it is passed to `columnRow` while building `rowComponents`, which are `super()`'s children — `this` is unavailable until `super()` returns, per COMPONENT_CONVENTIONS.md (b)). Pass it into `columnRow(column, tableBlock, onSelectColumn)`; inside `columnRow`, change [line 218](frontend/src/dock/TableCardNode.ts#L218) to `Tooltip.attach(row, cardTooltip(tableBlock, column))`. After `super()`, add `Tooltip.attach(this, tableBlock);`. Update the imports on line 22 to bring in `tableTooltip` and `cardTooltip`.

8. **`frontend/src/dock/TableCardNode.ts` — update the doc comments.** The module header's "Every dimension comes from schemaCardModel" paragraph gains a sentence naming the outline + zero-vertical-inset rule and why (a border or vertical inset would shrink every row and move the ports off their rows). The class doc's "Rows take pointer events (for their hover tooltip)" sentence gains the card-level tooltip. `columnRow`'s doc gains its new `tableBlock` parameter and says the row's tooltip is the table block, a blank line, then the column block.

9. **Regression checkpoints.**
   - `grep -n "setBorder\|CARD_BORDER\|ROOT_BORDER" frontend/src/dock/TableCardNode.ts` — expect zero matches.
   - `grep -rn "CARD_ROW_HEIGHT\|CARD_HEADER_HEIGHT\|cardHeight\|columnPortY" frontend/src/data/schemaCardModel.ts frontend/src/data/buildSchemaDiagram.ts` — the four numbers and both formulas are unchanged.
   - `npm run typecheck && npm run test` in `frontend/`.

10. **Manual verification** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/data/schemaCardModel.ts` |
| Modify | `frontend/src/dock/TableCardNode.ts` |
| Modify | `frontend/tests/data/schemaCardModel.test.ts` |

---

## Expected Behaviour

### Unit-testable (node vitest, `frontend/tests/data/schemaCardModel.test.ts`)

`tableTooltip`:

| input | output |
|---|---|
| `("credit_notes", [id(pk), invoice_id(fk), order_id(fk), amount])` | `"credit_notes\nColumns: 4\nPrimary key: id\nForeign keys: invoice_id, order_id"` |
| `("order_items", [order_id(pk,fk), line_no(pk), qty])` | `"order_items\nColumns: 3\nPrimary key: order_id, line_no\nForeign keys: order_id"` |
| `("audit_log", [ts, message])` — no PK, no FK | `"audit_log\nColumns: 2"` |
| `("analyst", [])` — a node with no columns | `"analyst"` |

- A column that is both PK and FK appears in both lists (see the `order_items` row).
- Multiple PK or FK columns are joined with `", "` in declaration order.

`cardTooltip`:

- `cardTooltip("credit_notes\nColumns: 4", row({ name: "invoice_id", type: "bigint", fk: true, nullable: false }))` returns `"credit_notes\nColumns: 4\n\nName: invoice_id\nType: bigint\nAttributes: FOREIGN KEY · NOT NULL"`.
- Splitting the result on `"\n"` yields exactly one empty entry, and it sits between the two blocks: `cardTooltip(t, c).split("\n").filter(l => l === "").length === 1`.
- For any `t` and `c`, `cardTooltip(t, c)` equals `t`, then `"\n\n"`, then `columnTooltip(c)` — the join is the only thing it does.

`columnTooltip` — unchanged; its existing three tests must still pass verbatim.

The geometry contract (a regression pin for the numbers the renderer now depends on; passes before and after the code change):

- `columnPortY(i) + 0.5 === CARD_HEADER_HEIGHT + i * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2` for `i` in `0..5` — the port's 1px-tall centre is the row's centre, measured from the card's top edge with **no** allowance for a border or inset.
- `cardHeight(n) === CARD_HEADER_HEIGHT + n * CARD_ROW_HEIGHT` for `n` in `0..6` — the card's outer height is the header plus the rows and nothing else (already covered by the existing `cardHeight` suite; keep it).

### Manual verification (pixel geometry and hover — the node vitest has no DOM)

**Screen: the `invoices` relations tab.** Navigator → schema `sales` → table `invoices` → right-click → Show relations. The tab is titled `invoices (relations)`.

1. Every FK edge meets the vertical middle of the column row it belongs to, on the root `invoices` card (6 rows, accent frame) and on every non-root card — including the root card's **bottom** row, where today's error is worst (+4.25px).
2. Measured with `evaluate_script` (use `offsetHeight` / `offsetTop`, not `getBoundingClientRect`, so the view's zoom transform doesn't scale the numbers):

```js
const card = [...document.querySelectorAll(".TableCardNode")].find(el => el.textContent.startsWith("invoices"));
const rows = [...card.children].slice(1);                    // children[0] is the header
[rows.map(r => r.offsetHeight),                              // expect 22 on every row
 rows[0].offsetTop - card.offsetTop,                         // expect 28 (CARD_HEADER_HEIGHT)
 card.offsetHeight]                                          // expect 28 + 22 * rows.length
```

3. The root card still reads as the accent-framed anchor, and every card still shows its 1px grey frame. Accepted visual change: the frame is now painted just **outside** the card's box instead of just inside, so a card looks 2px (root: 4px) larger than before; node spacing is 40px/120px, so nothing collides.
4. Single-clicking a card still tints it; clicking a row still emphasises that column's edges and rows; the frame is unaffected by selection (as today).
5. Hovering a row for ≥500ms (the tooltip's show delay) shows the table block, a blank line, then the column block. Hovering the header strip shows the table block alone. The header keeps the card's pointer cursor.

**Screen: the `order_items` relations tab.** Same navigator path on `sales.order_items`. Repeat checks 1 and 2 — this diagram is the second success criterion, and `order_items` has a composite primary key, so its tooltip's `Primary key:` line lists two columns.

**Screen: a role-membership graph.** Roles view → a role → its membership graph (`RelationDiagramPanel` is reused there with role nodes that carry no card `data`). Header-only cards still render, and hovering one shows its name alone — no `Columns:` line, no crash.

---

## Verification

```bash
cd frontend && npm run typecheck && npm run test
grep -n "setBorder\|CARD_BORDER\|ROOT_BORDER" src/dock/TableCardNode.ts   # expect zero matches
```

Then the manual checks above, driven per `.claude/skills/verify/SKILL.md` (login Host `sqladmin-db` when the backend runs under Compose). No `npm run build:lib` is needed — the library is untouched.

---

## Potential Challenges

- **A future `setBorder` on the card silently reintroduces the bug.** Both module header comments state the rule, and the frame constants are named `*_OUTLINE`, so the next reader has to type `setOutline`.
- **Any padding on the card would shrink it the same way.** `getInnerSize` subtracts insets, border, *and* CSS padding ([Component.ts:2909](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2909)); the card sets no padding today and must not gain one. Covered by the same header-comment rule (it says "no vertical decoration", not "no border").
- **The row tooltip is now long enough to wrap.** `Tooltip` caps its width at 300px and soft-wraps beyond it, growing the line count ([Tooltip.ts:236-241](../typescript-ui/packages/lib/src/typescript/lib/overlay/Tooltip.ts#L236)). A table with many FK columns produces a wrapped `Foreign keys:` line. Acceptable — the tooltip stays on screen; no cap is added.

---

## Critical Files

Read before implementing:

- [frontend/src/data/schemaCardModel.ts](frontend/src/data/schemaCardModel.ts) — the geometry seam and today's `columnTooltip`; its header comment states the purity discipline the new functions must keep.
- [frontend/src/dock/TableCardNode.ts](frontend/src/dock/TableCardNode.ts) — the card renderer; every change but the tooltip text lands here.
- [frontend/src/dock/ExplainNode.ts:52-62](frontend/src/dock/ExplainNode.ts#L52) and [:146](frontend/src/dock/ExplainNode.ts#L146) — **the precedent**: the sibling card node keeps its border width constant and paints extra emphasis with a shadow, so selecting never reflows the card.
- [frontend/src/data/fkEdgeTooltip.ts](frontend/src/data/fkEdgeTooltip.ts) — the app's other multi-line diagram tooltip; the heading-then-detail-lines shape `tableTooltip` follows, and the `" · "` separator `columnTooltip` shares.
- [frontend/src/dock/RelationDiagramPanel.ts:81-87](frontend/src/dock/RelationDiagramPanel.ts#L81) — the only `TableCardNode` call site (its `nodeRenderer`), and the panel the role-membership graph reuses.
- [frontend/COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) — sections (a) (a `Panel` subclass carries a 4px inset unless told otherwise) and (b) (the pre-`super()` locals rule step 7 depends on).
- [ARCHITECTURE.md's "No cosmetic insets or padding"](../typescript-ui/ARCHITECTURE.md#L118) and ["Size constraints"](../typescript-ui/ARCHITECTURE.md#L89) — the two rules this fix is derived from.

---

## Non-Goals

- **`frontend/src/data/buildSchemaDiagram.ts` is not modified.** `cardHeight` and `columnPortY` keep their current formulas, so the card sizes and port coordinates it emits are byte-identical and its existing tests need no edit. (This is also why the sibling `diagram-edge-merge-junctions` plan's edits to that file cannot conflict with this one — no frontmatter `touches-shared` is needed.)
- **No new backend field or fetch.** The table block is derived entirely from `DiagramNodeData.label` and the `CardNodeData.columns` the card already holds; `frontend/src/contract.ts` and `buildSchemaGraphData` are untouched.
- **The name in the tooltip is not schema-qualified.** A node's id is the bare relation name and the relation diagram spans one schema, so a qualified name would need a new field on the node for no information gain.
- **The depth badge is not in the tooltip.**[^table-block]
- **The card's horizontal geometry is not changed.** The 4px side insets are preserved exactly; removing the border widens each card's inner width by 2px (4px on the root), which is the only horizontal difference. A row is still slightly wider than the card's inner box and still clips at the edge, as today — out of scope.
- **No version bump, changelog entry, or publish step.** The coordinated 0.3.0 release is a separate step the user owns.

---

## Implementation Notes

Manual verification (per `## Expected Behaviour → Manual verification`) was performed
against the real app — Postgres already running via `docker compose up -d db`, the shared
backend already up on :8000 (`SQLADMIN_ALLOWED_HOSTS=localhost:5432`; the Docker Compose
network's `sqladmin-db` DNS name is not reachable from this host, so Host `localhost` was used
at login instead of `sqladmin-db`), and a dedicated `--strictPort` Vite dev server for this
worktree's `frontend/` on port 5177 (the shared dev stack on :5173 was already in use by
another concurrent worktree in this batch, so a separate port avoided disturbing it) — driven
with the chrome-devtools MCP tools.

Confirmed working as intended, with the concrete numbers:

- **`sales.invoices` relations tab, root card (6 rows, 2px accent outline):** the FK edge from
  `credit_notes.invoice_id` visibly bisects both `credit_notes`'s row and `invoices`'s `id`
  row. `evaluate_script` against the live DOM: every row's `offsetHeight` is `22`; the first
  row's `offsetTop` (relative to the card, which is each row's `offsetParent` since every
  `Component` is absolutely positioned) is `28`; the card's `offsetHeight` is `160`, exactly
  `28 + 6*22` — the pre-fix shrinkage (rows at ~20.3–20.5px) is gone.
- **`sales.order_items` relations tab, root card (5 rows):** same check —
  `offsetTop`s `[28, 50, 72, 94, 116]`, every `offsetHeight` `22`, card height `138 = 28 + 5*22`.
  The FK edge from `order_items.product_id` (row index 2) to `products.id` bisects both rows
  visually, confirming the fix on a non-first-row port too.
- **Tooltips:** hovering `invoices`'s `id` row showed
  `"invoices\nColumns: 6\nPrimary key: id\nForeign keys: order_id\n\nName: id\nType: integer\nAttributes: PRIMARY KEY · NOT NULL · GENERATED"`
  — table block, blank line, column block, exactly per `cardTooltip`'s contract. Hovering the
  card away from any row (dispatching the hover on the card element itself, since the header is
  `pointer-events: none` and a real browser event would never target it) showed the table block
  alone: `"invoices\nColumns: 6\nPrimary key: id\nForeign keys: order_id"`. On `order_items`,
  hovering `product_id` showed `Foreign keys: order_id, product_id` in declaration order,
  matching the composite/multi-FK case.
- **Selection and column emphasis still work:** clicking the root card's header area toggled
  its background to the accent-tinted selected colour and left its 2px accent outline in place;
  clicking `invoices.id` tinted both that row and `credit_notes.invoice_id`'s row the same
  accent shade (the existing column-emphasis wiring, unaffected by the outline/inset change).
- **Role-membership graph** (Roles rail → `analyst` → right-click → "Show membership graph"):
  the `analyst` (root, no columns) and `readonly` (non-root, no columns) cards both render
  header-only, `28`px tall, with no crash. Hovering the `analyst` card showed the tooltip text
  `"analyst"` alone — no `Columns:` line, confirming `tableTooltip`'s no-columns case degrades
  correctly on the reused panel.

Not separately isolated: a genuinely composite (multi-column) primary key. This seeded
database's `order_items` has a single-column surrogate `id` PK rather than the plan's
hypothetical `(order_id, line_no)` example, so the `Primary key: a, b` join-with-comma case
was confirmed only by the unit tests (`frontend/tests/data/schemaCardModel.test.ts`), not by a
live screen — no table in the checked schemas has a composite PK to click through.

## Notes

[^mechanism]: The full chain, verified in code: `buildSchemaDiagram` sets `node.height = cardHeight(n)` ([buildSchemaDiagram.ts:158](frontend/src/data/buildSchemaDiagram.ts#L158)); `DiagramView` feeds that to ELK and writes ELK's returned size back as the card component's preferred size ([DiagramView.ts:551](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L551) and [:593](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L593)); every `Component` is `box-sizing: border-box` ([Component.ts:512](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L512)), and `getInnerSize` subtracts insets *and* border widths from the committed size ([Component.ts:2909](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2909)), with `Panel` defaulting to 4px insets on all four sides ([Panel.ts:113](../typescript-ui/packages/lib/src/typescript/lib/core/Panel.ts#L113)). The header (28) plus the rows (22·n) sum to exactly the committed height, so they overflow the inner box by border+insets — 10px on a non-root card, 12px on the root. `BoxLayout.computeShrink` ([BoxLayout.ts:373](../typescript-ui/packages/lib/src/typescript/lib/layout/BoxLayout.ts#L373)) then shrinks each child from its preferred toward its own minimum by a shared ratio `excess / shrinkable`, which is why the header (a taller-than-its-text 28px box, so more shrinkable) loses ~2.5px while each row loses ~1.6px rather than all children losing the same amount. Reconciling with the measurements: on `credit_notes` (4 rows, 1px border) rows at 20.33px and a ~25.5px header put row 0's centre at `1 + 4 + 25.5 + 10.17 = 40.7`, against a port centre of `28 + 10.5 + 0.5 = 39` — a −1.7px error that grows by `22 − 20.33 = 1.67px` per row, reaching +3.3px on row 3, matching the measured −1.66 → +3.34. A `Panel` does not inflate back to its content size (it clips or scrolls — see ARCHITECTURE.md's `Panel` carve-out), which is why the shortfall shows up as silently shrunken rows rather than an overflowing card.

[^layout-neutral]: The alternative was folding the decoration into the pure formulas — `cardHeight` returning `28 + 22n + 2·border + insets` and `columnPortY` adding `border + insetTop`. Rejected: the border width differs between the root card (2px) and every other card (1px), so both formulas would need to know **which card is the root** — a rendering decision made in `RelationDiagramPanel`'s `nodeRenderer` ([RelationDiagramPanel.ts:82](frontend/src/dock/RelationDiagramPanel.ts#L82)), two modules away from the builder that pins the ports. The full schema graph is built once, root-agnostically, by `buildSchemaGraphData`, and re-rooted client-side, so the ports would have to be re-emitted on every re-rooting. It also spreads DOM facts (border widths, `Panel` inset defaults) into the module whose whole purpose is to be DOM-free, and it papers over the shortfall rather than removing it, against ARCHITECTURE.md's "trace it to the layout cause and fix it there". Making the decoration layout-neutral instead leaves both formulas exact and makes root-ness invisible to geometry. Within that choice, `outline` beats an inset `box-shadow`: an inset shadow is painted on the card element, and the rows — which now span the card's full inner box — paint above it, so an emphasis-tinted row would wash out the frame line behind it. An `outline` is painted outside the border box, where no child can reach it. `outline-offset` is left at its default 0 for the same reason (a negative offset would move the frame back under the rows).

[^tooltip-attach]: `Tooltip.attach` listens on `mouseover` / `mouseout`, which both bubble ([Tooltip.ts:374](../typescript-ui/packages/lib/src/typescript/lib/overlay/Tooltip.ts#L374)). Hovering a row therefore reaches the row's handler first (target phase) and the card's handler second, and the card's handler returns immediately because a show timer is already pending — so the row's combined tooltip wins over the card's table block, never the reverse. Moving between two rows fires the outgoing row's `mouseout` (which hides) fully before the incoming row's `mouseover` (which re-arms), so the card's bubbled `mouseout` cannot cancel the new row's tooltip. Moving from a row onto the header fires `mouseout` on the row and then `mouseover` on the card — the browser fires these on parent/descendant transitions too, which is exactly what makes the header pick the table block up. The blank separator line survives rendering because the tooltip's label uses `white-space: pre-wrap` and sizes itself by `\n`-split line count ([Tooltip.ts:169](../typescript-ui/packages/lib/src/typescript/lib/overlay/Tooltip.ts#L169), [:222-241](../typescript-ui/packages/lib/src/typescript/lib/overlay/Tooltip.ts#L222)). Attaching to the card rather than to the header covers three cases in one attach — the header, the card's 4px side margins, and a node with no rows at all — and leaves the header pointer-transparent, so it needs no `setCursor` of its own.

[^table-block]: The block answers "what is this relation" from data the card already holds. The depth badge (`DiagramNodeData.badge`, e.g. `←+2 +1→`) was considered and left out: it is already drawn in full on the card header, where the fixed-width badge cell never ellipsises it, so repeating it adds nothing a hover could reveal — and it describes the *current depth setting*, not the table. Rendering it as plain English ("2 more tables reference this one") would need the `HiddenNeighbourCounts` that `withDepthBadges` computes and discards ([relationDiagram.ts:244-260](frontend/src/data/relationDiagram.ts#L244)), and `DiagramNodeData` has no field left to carry them — `data` is taken by `CardNodeData` — so it would mean a second counts channel through a module that is deliberately generic across the role graphs too. The name heading is unlabelled (no `Table: ` prefix) for the same generality: `RelationDiagramPanel` is reused for the role-membership graph, whose nodes are roles, and `fkEdgeTooltip` already establishes an unlabelled heading line above labelled detail lines. The FK line lists the **local** columns, not their targets, because `ColumnRowData` carries only an `fk` flag — the referenced table lives on the edge, and the edge has its own tooltip.
