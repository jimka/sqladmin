---
touches-shared:
  - frontend/src/SqlAdminController.ts
  - frontend/src/theme.ts
  - frontend/src/contract.ts
  - frontend/src/data/buildDatabaseDiagram.ts
  - frontend/src/data/buildRoleGrantsDiagram.ts
  - frontend/src/data/buildRoleMembershipDiagram.ts
  - frontend/src/data/fkEdgeTooltip.ts
  - frontend/src/data/presetStore.ts
  - frontend/src/dock/ColumnChecklist.ts
  - frontend/src/dock/ConstraintForm.ts
  - frontend/src/dock/ImportRowsDialog.ts
  - frontend/src/dock/IndexInfoPanel.ts
  - frontend/src/dock/QueryPanel.ts
  - frontend/src/dock/RelationGraphPanel.ts
  - frontend/src/dock/SequenceInfoPanel.ts
  - frontend/src/dock/SqlPreviewDialog.ts
  - frontend/src/dock/StructurePanel.ts
  - frontend/src/dock/TableCardNode.ts
  - frontend/src/dock/TableWorkPanel.ts
  - frontend/src/dock/TypeInfoPanel.ts
  - frontend/src/dock/columnsGrid.ts
  - frontend/src/dock/ddlSpecs.ts
  - frontend/src/dock/menuItems.ts
  - frontend/src/roles/RolesTree.ts
  - frontend/src/shell/StartPage.ts
  - frontend/src/shell/appRouter.ts
  - frontend/COMPONENT_CONVENTIONS.md
  - frontend/tests/dock/ddlSpecs.test.ts
  - backend/app/auth.py
  - backend/app/config.py
  - backend/app/connections.py
  - backend/app/main.py
  - backend/app/operations/ddl.py
  - backend/app/operations/ddl_function_type.py
  - backend/app/operations/ddl_schema_sequence.py
  - backend/app/operations/type_definition.py
  - backend/app/sql/ddl.py
  - backend/tests/test_auth.py
---

# Debt Sweep: Leftover Duplication, Dead Code and Stale Docs — Implementation Plan

## Overview

The 2026-08-29 codebase health audit ([plans/research/codebase-health-audit-2026-08-29.md](plans/research/codebase-health-audit-2026-08-29.md)) recorded ~85 advisory-tier findings. Ten sibling plans have claimed the ones that fit their themes. This plan is the remainder: small, independent edits — a shared helper that already exists and is bypassed, a constant declared twice, a comment that describes code that has since changed — plus five behaviour fixes small enough to travel with them.

Everything here is deliberately low-risk and self-contained. No item depends on another item in this plan, and no item requires a sibling plan to land first. Several touch files a sibling also edits, so `## Sequencing against the sibling plans` names the ones worth ordering.

The work is grouped into eight phases by area — a shared text helper, the diagram data layer, dock constants, DDL forms, data/roles/shell, one documentation correction, backend operations, and the backend SQL/auth layer. Each phase stands alone and can be implemented, reviewed and committed on its own.

Two findings here are security-relevant and appear in no sibling plan: [`auth.py:172`](backend/app/auth.py#L172) compares the CSRF token with `!=` rather than a constant-time comparison, and `login` never closes the session the caller was already holding, so re-logging in leaves the previous session live for up to 30 minutes.

---

## Architecture Decisions

### A bypassed helper is adopted; a duplicated literal moves to the module that already owns its kind

Most items here follow the same rule: find where the codebase already keeps this kind of thing, and move the second copy there. [`frontend/src/theme.ts:1-6`](frontend/src/theme.ts#L1) states that rule for itself — it exists because "two near-identical blues, two reds, two muted greys had crept in across the panels". The same argument places the diagram frame colours in `theme.ts`, the shared grid column spec in [`columnsGrid.ts`](frontend/src/dock/columnsGrid.ts) beside `readOnlyTable()`, and the row cap in [`backend/app/operations/common.py`](backend/app/operations/common.py).

### New shared modules are pure and node-testable, mirroring the repo's existing split

Five small modules are created rather than folded into an existing file. Each is DOM-free so it runs under the project's node vitest, the split [`frontend/src/dock/structureRows.ts:1-4`](frontend/src/dock/structureRows.ts#L1) and [`frontend/src/roles/roleBaseInfoRows.ts`](frontend/src/roles/roleBaseInfoRows.ts) already make for the same reason.[^new-modules]

### `RolesTree`'s context menu moves out to a pure builder, following `objectMenu.ts`

The roles context menu becomes `buildRoleMenuItems()` in a new `frontend/src/roles/roleMenu.ts`, mirroring [`frontend/src/navigator/objectMenu.ts:1-12`](frontend/src/navigator/objectMenu.ts#L1) — a pure `MenuItemConfig[]` builder that names glyphs as strings and leaves `Glyph.register` to the component module. [`frontend/tests/navigator/objectMenu.test.ts`](frontend/tests/navigator/objectMenu.test.ts) is the template for its test.

### `appRouter` registers its three single-object routes from a table

[`appRouter.ts:155`](frontend/src/shell/appRouter.ts#L155) and [`:259`](frontend/src/shell/appRouter.ts#L259) already register families of routes by looping over a table. The sequence, index and type routes ([`:190-230`](frontend/src/shell/appRouter.ts#L190)) become a third such table instead of three copies of the same eleven lines.

### `_withRepair` discards presets only on a parse failure

[`presetStore.ts:121`](frontend/src/data/presetStore.ts#L121) currently answers *any* write failure by deleting every saved preset and retrying. It narrows to `SyntaxError` — the error `JSON.parse` raises on a corrupt blob, which is the only failure discarding the blob can fix.[^parse-only-repair]

### `SUGGESTIONS_HEIGHT` sizes the strip, not the table inside it

[`IndexSuggestionsView.ts:35`](frontend/src/dock/IndexSuggestionsView.ts#L35) documents 140px as "the whole strip", then applies it to both the strip and the table it contains — so the table asks for the strip's entire height and the toolbar above it has none to take. The two `table.set*Size` calls go; the strip keeps its own.[^strip-height]

### `create_routine`'s `LANGUAGE` and volatility get allowlists, like every other keyword in the module

[`sql/ddl.py:1146-1157`](backend/app/sql/ddl.py#L1146) states the module's own rule: a *keyword* is validated against a fixed allowlist, while type strings, defaults and bodies pass through raw for the user to review in the preview editor. `LANGUAGE` and volatility are keywords and are interpolated raw today. They join `_ARG_MODES` and `_REFERENTIAL_ACTIONS` in being checked.[^keyword-allowlist]

### `login` closes the caller's previous session before issuing a new cookie

`close_session` is already imported by [`auth.py:26`](backend/app/auth.py#L26) and is already a no-op for an absent or unknown token, so this is one statement.[^relogin]

---

## Public API

New exported symbols. Nothing existing changes shape except `IndexDetail`, which gains an `extends` clause with identical members.

```ts
// frontend/src/textFormat.ts
export function yesNo(value: boolean): string;
```

```ts
// frontend/src/data/diagramLayout.ts
export const LAYERED_RIGHT: Record<string, string>;
export const LAYERED_DOWN: Record<string, string>;
```

```ts
// frontend/src/dock/panelMetrics.ts
export const CONTENT_SPACING: number;    // 8
export const CONTENT_WIDTH_CAP: number;  // 400
```

```ts
// frontend/src/dock/notify.ts
export type Notify = (message: string) => void;
```

```ts
// frontend/src/dock/summaryPanel.ts
export function summaryPanel(lines: string[]): Panel;
```

```ts
// frontend/src/shell/mutedText.ts
export function mutedHeading(text: string): Component;
export function mutedText(text: string): Component;
```

```ts
// frontend/src/roles/roleMenu.ts
export interface RoleMenuActions {
    showRole:              (name: string) => void;
    openMembershipDiagram: (name: string) => void;
    openGrantsDiagram:     (name: string) => void;
    exportGrants:          (name: string, format: "csv" | "json") => void;
}

export function buildRoleMenuItems(name: string, actions: RoleMenuActions): MenuItemConfig[];
```

```ts
// frontend/src/data/buildSchemaDiagram.ts — new export beside collapseParallelFkEdges
export function fkEdge(sourceId: string, targetId: string, fk: ForeignKeyMeta): DiagramEdgeData;
```

```ts
// frontend/src/data/fkCardinality.ts — new export
export function referentialActionParts(onUpdate: string, onDelete: string): string[];
```

```ts
// frontend/src/dock/columnsGrid.ts — new export beside readOnlyTable.
// The library exports no name for one entry of a ColumnSpec's `columns`, so the
// type is derived from the ColumnSpec the module already imports.
export const FILLER_COLUMN: NonNullable<ColumnSpec["columns"]>[number];
```

```ts
// frontend/src/dock/ddlSpecs.ts — new export beside describeColumnSpecs
export function describeSequenceSpecs(specs: SequenceEditSpecs, detail: SequenceDetail): string[];
```

```ts
// frontend/src/contract.ts — IndexDetail's members are unchanged
export interface IndexDetail extends IndexMeta {
    table: string;
}
```

```python
# backend/app/operations/common.py
MAX_ROWS_PER_REQUEST: int = 1000

def affected(status: str | None) -> int: ...
def status_envelope(status: str | None) -> dict: ...
```

```python
# backend/app/sql/ddl.py — added to __all__
def ident_list(names: Iterable[str]) -> str: ...
```

```python
# backend/app/auth.py — renamed from _ALLOWED_HOSTS_ENV (now imported by dev.py)
ALLOWED_HOSTS_ENV: str = "SQLADMIN_ALLOWED_HOSTS"
```

---

## Internal Structure

`fkEdge` is the literal both FK builders write today, with the id and endpoints lifted into parameters:

```ts
export function fkEdge(sourceId: string, targetId: string, fk: ForeignKeyMeta): DiagramEdgeData {
    return {
        // FK constraint names are unique per table but can repeat across tables,
        // so prefix with the source's id for global uniqueness.
        id    : `${sourceId}.${fk.name}`,
        source: sourceId,
        target: targetId,
        // Carried for later cardinality / column-to-column work; ignored by the
        // current table-to-table rendering.
        data  : { fks: [{
            columns   : fk.columns,
            refColumns: fk.refColumns,
            refSchema : fk.refSchema,
            onUpdate  : fk.onUpdate,
            onDelete  : fk.onDelete,
        }] } satisfies FkEdgeData,
    };
}
```

`referentialActionParts` is the shared half of the two builders; the separator stays with each caller, because they render into different places:

| Caller | Call | Separator | Empty result |
|---|---|---|---|
| `fkCardinality.referentialActionLabel` | `referentialActionParts(onUpdate, onDelete)` | `" "` | `undefined` |
| `fkEdgeTooltip.referentialActionLine` | `referentialActionParts(fk.onUpdate, fk.onDelete)` | `" · "` | `null` |

`selectionDropButton` in `StructurePanel.ts` replaces the three copies at [`:502`](frontend/src/dock/StructurePanel.ts#L502), [`:535`](frontend/src/dock/StructurePanel.ts#L535) and [`:569`](frontend/src/dock/StructurePanel.ts#L569):

```ts
function selectionDropButton(grid: Table, tooltip: string, onDrop: (name: string) => void): Button {
    const button = glyphButton("trash", DESTRUCTIVE_COLOR, tooltip, () => {
        const record = grid.getSelectedRecord();

        if (record) {
            onDrop(String(record.get("name")));
        }
    });

    gateOnSelection(grid, [button]);

    return button;
}
```

`appRouter`'s third route table, placed beside the existing `RELATION_KINDS` loop:

```ts
// The three single-object routes are registered once per entry rather than as
// three near-identical literal `register` calls — the technique RELATION_KINDS
// and ROLE_BUCKETS already use in this file.
const SCHEMA_OBJECT_ROUTES: {
    segment: string;
    kind: DbObjectRef["kind"];
    open: (controller: SqlAdminController, ref: DbObjectRef) => Promise<void>;
}[] = [
    { segment: "sequence", kind: "sequence", open: (c, ref) => c.openSequence(ref) },
    { segment: "index",    kind: "index",    open: (c, ref) => c.openIndex(ref) },
    { segment: "type",     kind: "type",     open: (c, ref) => c.openType(ref) },
];
```

`status_envelope` in `backend/app/operations/common.py`, the one copy of what `run_query.py` and `ddl.py` each return today:

```python
def status_envelope(status: str | None) -> dict:
    """
    Build the status-result envelope a non-rows statement returns.

    Args:
        status: the driver's command tag, or None when the driver reported none.

    Returns:
        ``{"kind": "status", "command", "rowCount"}``.
    """
    return {"kind": "status", "command": status or "", "rowCount": affected(status)}
```

---

## Ordered Implementation Steps

Each phase is independent. Within a phase, follow the steps in order.

### Phase A — A shared `yesNo` formatter

1. **Create `frontend/tests/textFormat.test.ts`.** Cover the two `yesNo` cases from `## Expected Behaviour`. Import from `../src/textFormat`, which does not exist yet — the suite must fail. Follow [`frontend/tests/appIdentity.test.ts`](frontend/tests/appIdentity.test.ts)'s import style (a root-level pure module with a root-level test).

2. **Create `frontend/src/textFormat.ts`.** Give it a header saying it holds the app's small pure value-to-display-string helpers and imports nothing from the library, so it runs under the node vitest. Move `yesNo` across from [`IndexInfoPanel.ts:35`](frontend/src/dock/IndexInfoPanel.ts#L35) and export it.

3. **Adopt `yesNo`.** Delete the local function in [`IndexInfoPanel.ts:35`](frontend/src/dock/IndexInfoPanel.ts#L35) and in [`roleBaseInfoRows.ts:44`](frontend/src/roles/roleBaseInfoRows.ts#L44); both files import it from `../textFormat` instead. Then run `npm --prefix frontend run typecheck` and `npm --prefix frontend test`.
   Check: `grep -rn 'function yesNo' frontend/src/` — expect one match, in `textFormat.ts`.

### Phase B — Diagram data layer

4. **Create `frontend/src/data/diagramLayout.ts`** with `LAYERED_RIGHT` and `LAYERED_DOWN` per `## Public API`. The header must say the two objects are shared by reference and passed straight through by [`relationDiagram.ts:77`](frontend/src/data/relationDiagram.ts#L77) and [`groupBySchema.ts:55`](frontend/src/data/groupBySchema.ts#L55), so no consumer may mutate them.

5. **Adopt the two bases at all six sites.** Keep every existing explanatory comment, moving it above the new reference where a local constant is deleted:

   | File | Line | After |
   |---|---|---|
   | `frontend/src/data/buildDatabaseDiagram.ts` | 18-21 | delete the local; line 123 returns `layoutOptions: LAYERED_RIGHT` |
   | `frontend/src/data/buildRoleGrantsDiagram.ts` | 11 | delete the local; line 90 returns `layoutOptions: LAYERED_RIGHT` |
   | `frontend/src/data/buildRoleMembershipDiagram.ts` | 10 | delete the local; line 64 returns `layoutOptions: LAYERED_RIGHT` |
   | `frontend/src/data/buildSchemaDiagram.ts` | 28 | `{ ...LAYERED_RIGHT, <the five spacing entries, comments intact> }` |
   | `frontend/src/data/buildExplainDiagram.ts` | 17 | `{ ...LAYERED_DOWN, "elk.layered.spacing.nodeNodeBetweenLayers": "50" }` |
   | `frontend/src/SqlAdminController.ts` | 204, 207 | `const DEPENDENCY_LAYOUT = LAYERED_RIGHT;` / `const INHERITANCE_LAYOUT = LAYERED_DOWN;` |

   Check: `grep -rn '"elk.algorithm"' frontend/src/` — expect one match, in `diagramLayout.ts`.

6. **`frontend/src/data/buildSchemaDiagram.ts` — add `fkEdge`.** Place it directly above `collapseParallelFkEdges`, with the body from `## Internal Structure`. Import `ForeignKeyMeta` as a type from `../contract`. Replace the inline literal at [`:140-154`](frontend/src/data/buildSchemaDiagram.ts#L140) with `edges.push(fkEdge(sourceTable, fk.refTable, fk));`.

7. **`frontend/src/data/buildDatabaseDiagram.ts` — use `fkEdge`.** Add it to the existing `./buildSchemaDiagram` import and replace the literal at [`:102-118`](frontend/src/data/buildDatabaseDiagram.ts#L102) with `edges.push(fkEdge(sourceId, targetId, fk));`. The `FkEdgeData` type import is then unused — remove it.
   Check: `grep -n 'refColumns: fk.refColumns' frontend/src/data/` — expect one match, inside `fkEdge`.

8. **`frontend/src/data/fkCardinality.ts` — export `referentialActionParts`.** Extract the two `if` blocks from [`referentialActionLabel:225-237`](frontend/src/data/fkCardinality.ts#L225) into the new exported function returning `string[]`; `referentialActionLabel` becomes `const parts = referentialActionParts(onUpdate, onDelete); return parts.length > 0 ? parts.join(" ") : undefined;`.

9. **`frontend/src/data/fkEdgeTooltip.ts` — use it.** Import `referentialActionParts` from `./fkCardinality` and rewrite [`referentialActionLine:55-67`](frontend/src/data/fkEdgeTooltip.ts#L55) as `const parts = referentialActionParts(fk.onUpdate, fk.onDelete); return parts.length > 0 ? parts.join(" · ") : null;`. Keep the existing comment about matching `columnTooltip`'s separator.
   Check: `grep -rn 'ON UPDATE \${' frontend/src/` — expect one match, inside `referentialActionParts`.

10. **`frontend/src/theme.ts` — add the two diagram frame values.** Append `CARD_FRAME` (`"1px solid var(--ts-ui-border-color, rgb(180, 180, 180))"`) and `ROOT_FRAME` (`"2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))"`). Each doc comment must say the value is a CSS shorthand applied as an *outline* by `TableCardNode` (so it takes no layout space and cannot compress the card's column rows) and as a *border* by the panels that draw a plain node.

11. **Adopt the frame constants.** In [`TableCardNode.ts:40-41`](frontend/src/dock/TableCardNode.ts#L40) delete `ROOT_OUTLINE`/`CARD_OUTLINE` and use `ROOT_FRAME`/`CARD_FRAME` at [`:159`](frontend/src/dock/TableCardNode.ts#L159), updating the header's reference at [`:8`](frontend/src/dock/TableCardNode.ts#L8). In [`ExplainNode.ts:56`](frontend/src/dock/ExplainNode.ts#L56) delete `CARD_BORDER` and use `CARD_FRAME` at lines 125, 145 and 333. In [`RelationGraphPanel.ts:35`](frontend/src/dock/RelationGraphPanel.ts#L35) delete `ROOT_BORDER`, use `ROOT_FRAME` at [`:50`](frontend/src/dock/RelationGraphPanel.ts#L50), and replace the comment at [`:34`](frontend/src/dock/RelationGraphPanel.ts#L34) — which cites a `ROOT_BORDER` that `RelationDiagramPanel` does not have — with: *"The shared root frame (theme.ts's `ROOT_FRAME`), applied here as a border; `TableCardNode` applies the same value as an outline so it takes no layout space."*
    Check: `grep -rn 'ts-ui-border-color\|ts-ui-accent-color' frontend/src/` — expect matches only in `theme.ts`.

12. **Run typecheck and the frontend suite.** `frontend/tests/data/buildDatabaseDiagram.test.ts`, `buildSchemaDiagram.test.ts`, `fkEdgeTooltip.test.ts` and `fkCardinality.test.ts` must pass unchanged — every change in this phase is a pure extraction.

### Phase C — Dock constants and grid specs

13. **Create `frontend/src/dock/panelMetrics.ts`** with `CONTENT_SPACING` and `CONTENT_WIDTH_CAP` per `## Public API`. Move each constant's existing comment across: `CONTENT_WIDTH_CAP`'s from the block directly above [`columnsGrid.ts:100`](frontend/src/dock/columnsGrid.ts#L100) (the leftover-width mechanism it drives together with the filler column) and `CONTENT_SPACING`'s from [`TypeInfoPanel.ts:52-54`](frontend/src/dock/TypeInfoPanel.ts#L52) (this app's usual dialog/panel content gap). Give the module a header naming `theme.ts` as its colour counterpart.

14. **Adopt `panelMetrics`.** Delete the local declarations at [`columnsGrid.ts:100`](frontend/src/dock/columnsGrid.ts#L100), [`TypeInfoPanel.ts:49`](frontend/src/dock/TypeInfoPanel.ts#L49) and [`:54`](frontend/src/dock/TypeInfoPanel.ts#L54), [`SqlPreviewDialog.ts:76`](frontend/src/dock/SqlPreviewDialog.ts#L76) and [`ImportRowsDialog.ts:61`](frontend/src/dock/ImportRowsDialog.ts#L61); each file imports what it uses from `./panelMetrics`.
    Check: `grep -rn 'const CONTENT_SPACING\|const CONTENT_WIDTH_CAP' frontend/src/` — expect matches only in `panelMetrics.ts`.

15. **`frontend/src/dock/columnsGrid.ts` — export `FILLER_COLUMN`.** Declare it beside `readOnlyTable` as the exact literal at [`:195`](frontend/src/dock/columnsGrid.ts#L195), with a doc comment saying it is the blank column that absorbs a grid's leftover width and must be paired with `appendUnlisted: false` and a `filler` model field. Use it at `:195`, and in [`TypeInfoPanel.ts:84`](frontend/src/dock/TypeInfoPanel.ts#L84) import and use it instead of the retyped literal.
    Check: `grep -rn 'unhideable: true' frontend/src/` — expect one match, inside `FILLER_COLUMN`.

16. **Create `frontend/src/dock/notify.ts`** declaring the `Notify` type with a doc comment saying it is the status-line reporter every panel and menu builder takes. Delete the declarations at [`TableWorkPanel.ts:89`](frontend/src/dock/TableWorkPanel.ts#L89) and [`QueryPanel.ts:126`](frontend/src/dock/QueryPanel.ts#L126); both files import the type from `./notify` instead. Retarget the two consumers: [`SqlAdminController.ts:46`](frontend/src/SqlAdminController.ts#L46) and [`menuItems.ts:15`](frontend/src/dock/menuItems.ts#L15).
    Check: `grep -rn 'type Notify =' frontend/src/` — expect one match, in `notify.ts`.

17. **Create `frontend/src/dock/summaryPanel.ts`** holding the exported `summaryPanel(lines)` moved verbatim from [`StructurePanel.ts:476`](frontend/src/dock/StructurePanel.ts#L476), with its existing doc comment minus the "Mirrors SequenceInfoPanel's own `summaryPanel`" sentence (there is no longer a second one). `StructurePanel.ts` imports it and deletes its local copy.

18. **`frontend/src/dock/ddlSpecs.ts` — add `describeSequenceSpecs`.** Move the line-building half of [`SequenceInfoPanel.ts:372`](frontend/src/dock/SequenceInfoPanel.ts#L372)'s `summaryPanel` here, beside `describeColumnSpecs`, as an exported pure function returning `string[]`. Its body is that function's `lines` construction, unchanged; the `Panel` construction stays behind. `SequenceEditSpecs` is already declared in this module ([`:667`](frontend/src/dock/ddlSpecs.ts#L667)); import `SequenceDetail` as a type from `../contract`.

19. **`frontend/src/dock/SequenceInfoPanel.ts` — use both.** Delete the local `summaryPanel`, import `summaryPanel` from `./summaryPanel` and `describeSequenceSpecs` from `./ddlSpecs`, and change [`:322`](frontend/src/dock/SequenceInfoPanel.ts#L322) to `form: summaryPanel(describeSequenceSpecs(specs, this._detail)),`. The `Panel`/`Text`/`VBox` imports may become unused — remove any that do.
    Check: `grep -rn 'function summaryPanel' frontend/src/` — expect one match, in `summaryPanel.ts`.

20. **`frontend/tests/dock/ddlSpecs.test.ts` — cover `describeSequenceSpecs`.** Add a `describe` block for the cases in `## Expected Behaviour`, placed beside the existing `describeColumnSpecs` block at [`:304`](frontend/tests/dock/ddlSpecs.test.ts#L304) and reusing that file's existing `original` sequence fixture from the `diffSequenceSpecs` block at [`:589`](frontend/tests/dock/ddlSpecs.test.ts#L589).

21. **`frontend/src/dock/StructurePanel.ts` — extract `selectionDropButton`.** Add the function from `## Internal Structure` directly below `gateOnSelection` ([`:396`](frontend/src/dock/StructurePanel.ts#L396)), and replace the three copies with calls:

    | Function | Line | Replacement |
    |---|---|---|
    | `buildIndexesTools` | 502 | `const dropButton = selectionDropButton(grid, "Drop index", name => actions.onDropIndex(name));` |
    | `buildConstraintsTools` | 535 | `const dropButton = selectionDropButton(grid, "Drop constraint", name => actions.onDropConstraint(name));` |
    | `buildForeignKeysTools` | 569 | `const dropButton = selectionDropButton(grid, "Drop constraint", name => actions.onDropConstraint(name));` |

    Delete the now-redundant `gateOnSelection(grid, [dropButton]);` line that followed each (lines 510, 543, 577). Leave the Drop column button at [`:439`](frontend/src/dock/StructurePanel.ts#L439) alone — it removes a grid row rather than reading a name, and still calls `gateOnSelection` itself.
    Check: `grep -c 'gateOnSelection(grid' frontend/src/dock/StructurePanel.ts` — expect `2` (the Drop column site and the call inside `selectionDropButton`).

22. **`frontend/src/dock/IndexSuggestionsView.ts` — size only the strip.** Delete lines 73-74 (`table.setMinSize` / `table.setPreferredSize`), keeping [`:98-99`](frontend/src/dock/IndexSuggestionsView.ts#L98) on the strip itself. Extend `SUGGESTIONS_HEIGHT`'s comment to say the value covers the toolbar *and* the table, and that the table fills whatever the toolbar leaves because it sits in the `BorderLayout`'s CENTER.

23. **Run typecheck and the frontend suite.**

### Phase D — DDL form fixes

24. **`frontend/src/dock/ColumnChecklist.ts` — drop the redundant second pass.** [`readSelected:41-43`](frontend/src/dock/ColumnChecklist.ts#L41) filters `this._columns` (already the table's own order) and then re-orders that result through `orderColumnsBySelection`, which filters the same array by the same set. Replace the body with `return this._columns.filter((_, i) => this._boxes[i].getValue());` and delete the `orderColumnsBySelection` import. Rewrite the module header's second sentence to say the order guarantee comes from filtering the introspected column array directly, keeping the reference to why the order matters. `orderColumnsBySelection` stays exported from `ddlSpecs.ts` — [`ddlSpecs.ts:400`](frontend/src/dock/ddlSpecs.ts#L400) documents against it and its unit tests stay.
    Check: `grep -rn 'orderColumnsBySelection' frontend/src/` — expect matches only in `ddlSpecs.ts`.

25. **`frontend/src/dock/ConstraintForm.ts` — seed the referenced-schema combo.** Give `buildKindFields` ([`:48`](frontend/src/dock/ConstraintForm.ts#L48)) a leading `schema: string` parameter (documented in its JSDoc as the table's own schema, the combo's default), pass `schema` from the constructor, and change [`:62`](frontend/src/dock/ConstraintForm.ts#L62) to:

    ```ts
    // Default the referenced schema to the table's own — a foreign key most
    // often points inside its own schema, and an unseeded combo would otherwise
    // land on whichever schema the list happens to start with.
    const refSchemaCombo = new ComboBox({ items: schemas, value: schemas.includes(schema) ? schema : undefined });
    ```

26. **Run typecheck and the frontend suite.**

### Phase E — Data layer, roles and shell

27. **`frontend/tests/data/presetStore.test.ts` — pin the repair rule.** Add the two cases from `## Expected Behaviour`: a write that throws a `SyntaxError` clears the key and retries; a write that throws any other error propagates and leaves the stored presets intact. Follow the file's existing Map-backed storage stub. The suite must fail on the second case.

28. **`frontend/src/data/presetStore.ts` — narrow the repair.** Replace [`_withRepair`'s catch:124-127](frontend/src/data/presetStore.ts#L124) with:

    ```ts
    } catch (error) {
        // Only a corrupt blob is fixed by discarding it. A quota or security
        // failure from the write itself must not destroy the user's presets.
        if (!(error instanceof SyntaxError)) {
            throw error;
        }

        this._storage.removeItem(PRESETS_KEY);
        await write();
    }
    ```

    Update the method's doc comment to name `SyntaxError` as the only repaired failure, and the module header's `_withRepair` reference at [`:6-8`](frontend/src/data/presetStore.ts#L6) to match.

29. **`frontend/src/contract.ts` — `IndexDetail` extends `IndexMeta`.** Rewrite [`:492-498`](frontend/src/contract.ts#L492) as `export interface IndexDetail extends IndexMeta { table: string; }`, keeping the existing doc comment and adding one sentence saying it is `IndexMeta` plus the owning table.

30. **Create `frontend/tests/roles/roleMenu.test.ts`.** Cover the `## Expected Behaviour` cases for `buildRoleMenuItems`, following [`frontend/tests/navigator/objectMenu.test.ts`](frontend/tests/navigator/objectMenu.test.ts)'s shape (build the items with stub actions, assert texts/glyphs in order, invoke an item's `action` and assert the stub was called). Import from `../../src/roles/roleMenu`, which does not exist yet.

31. **Create `frontend/src/roles/roleMenu.ts`.** Move the six-entry array from [`RolesTree.ts:88-100`](frontend/src/roles/RolesTree.ts#L88) into `buildRoleMenuItems(name, actions)` per `## Public API`, replacing each `this.controller.…` call with the matching `actions.…` callback. Give it a header stating — as [`objectMenu.ts:11`](frontend/src/navigator/objectMenu.ts#L11) does — that glyphs are named as strings, never imported, so the module stays free of DOM side effects at import scope and the registration stays with `RolesTree`.

32. **`frontend/src/roles/RolesTree.ts` — use the builder, the shared predicate, and register its glyphs.**
    - Replace the inline array at [`:88-100`](frontend/src/roles/RolesTree.ts#L88) with `this.contextMenu.show(event.clientX, event.clientY, buildRoleMenuItems(name, { showRole: n => void this.controller.showRole(n), openMembershipDiagram: n => void this.controller.openRoleMembershipDiagram(n), openGrantsDiagram: n => void this.controller.openRoleGrantsDiagram(n), exportGrants: (n, format) => void this.controller.exportRole(n, format) }));`.
    - Replace the inline predicate at [`:137`](frontend/src/roles/RolesTree.ts#L137) with `matchesRole(firstUser.name)`, imported from `../navigator/revealMatch`.
    - Extend the `Glyph.register` block at [`:29-32`](frontend/src/roles/RolesTree.ts#L29) with the five glyphs the menu names — `key`, `diagram_project`, `file_export`, `file_csv`, `file_code` — importing each from `@jimka/typescript-ui/glyphs/solid/…` as the existing four are. Note in the comment that a menu item's glyph is registered by the component that shows the menu, the rule [`NavigatorTree.ts:45`](frontend/src/navigator/NavigatorTree.ts#L45) already follows for `objectMenu`.[^glyph-registration]

33. **`frontend/src/shell/appRouter.ts` — register the three object routes from a table.** Add `SCHEMA_OBJECT_ROUTES` from `## Internal Structure` beside `RELATION_KINDS`'s loop, generalize `relationRef` ([`:68`](frontend/src/shell/appRouter.ts#L68)) to take `kind: DbObjectRef["kind"]` and rename it `objectRef` (the relation loop passes its own `kind` unchanged), then replace the three `router.register` blocks at [`:190-230`](frontend/src/shell/appRouter.ts#L190) with:

    ```ts
    for (const { segment, kind, open } of SCHEMA_OBJECT_ROUTES) {
        router.register(`/schema/:schema/${segment}/:name`, params => dispatch(controller, () => {
            const ref = objectRef(controller, kind, params.schema, params.name);

            controller.selectObject(ref);

            return open(controller, ref);
        }));
    }
    ```

    Leave `/schema/:schema/function/:name` ([`:236`](frontend/src/shell/appRouter.ts#L236)) as its own registration — it reads a `signature` query parameter the others have no counterpart for, and its own comment explains why.
    Check: `grep -c 'connectionId: controller.connectionId' frontend/src/shell/appRouter.ts` — expect `4` (`objectRef`, the database-diagram route, the schema-view route, and the function route), down from 7.

34. **Create `frontend/src/shell/mutedText.ts`** with `mutedHeading` and `mutedText` per `## Public API`, moving [`shortcutLegend.ts:86-99`](frontend/src/shell/shortcutLegend.ts#L86)'s two functions across (`heading` becomes `mutedHeading`). `mutedHeading` hardcodes `fontWeight: "600"`.

35. **Adopt `mutedText.ts`.** In [`shortcutLegend.ts`](frontend/src/shell/shortcutLegend.ts) delete both locals, import the pair, and change the `heading(group.title)` call at [`:53`](frontend/src/shell/shortcutLegend.ts#L53) to `mutedHeading(group.title)`. In [`StartPage.ts`](frontend/src/shell/StartPage.ts) delete `heading` ([`:288`](frontend/src/shell/StartPage.ts#L288)) and change [`:280`](frontend/src/shell/StartPage.ts#L280) to `host.addComponent(mutedHeading(title));` — the `fontWeight` parameter goes, since `"600"` was its only argument. Drop the `MUTED_TEXT_COLOR` import from both files if nothing else uses it.
    Check: `grep -rn 'setForegroundColor(MUTED_TEXT_COLOR)' frontend/src/` — expect matches only in `mutedText.ts`.

36. **Run typecheck and the frontend suite.**

### Phase F — Frontend documentation correction

37. **`frontend/COMPONENT_CONVENTIONS.md:18` — drop the stale factory example.** The paragraph opens "Some builders (`SqlAdminShell` among them) were written as factories because of a real library bug". `SqlAdminShell` is `class SqlAdminShell extends Container` ([`SqlAdminShell.ts:82`](frontend/src/shell/SqlAdminShell.ts#L82)). Delete the parenthetical `(SqlAdminShell among them)` and nothing else; the paragraph's point — that a factory found today is a holdover, not a current constraint — stands without an example. Leave section (b) alone: `sqladmin-controller-split` owns its worked example.

### Phase G — Backend operations layer

38. **`backend/app/operations/common.py` — one row cap and one status envelope.** Widen the module docstring from "the row operations" to "the row and result-shaping operations". Add `MAX_ROWS_PER_REQUEST = 1000` with a comment naming all three uses (ad-hoc query result cap, list-rows page ceiling, import ceiling) and saying it is one number because a request's row budget is one policy. Add `affected(status)` — moved verbatim from [`run_query.py:97-115`](backend/app/operations/run_query.py#L97), renamed from `_affected` — and `status_envelope(status)` from `## Internal Structure`.

39. **`backend/app/operations/run_query.py`** — delete `_affected` and `MAX_RESULT_ROWS`; import `MAX_ROWS_PER_REQUEST` and `status_envelope` from `.common`. Replace `MAX_RESULT_ROWS` at lines 160, 191 and 192 and in the prose at lines 149, 177 and 178. Replace the return at [`:212`](backend/app/operations/run_query.py#L212) with `return status_envelope(self._status)`. Keep the module's existing comment explaining *why* the ad-hoc panel needs a cap, rewritten to point at the shared constant.
    `backend/tests/test_run_query.py` imports `MAX_RESULT_ROWS` at lines 78 and 94 — change both to `MAX_ROWS_PER_REQUEST` from `app.operations.common`. `app/main.py:884`'s docstring names `MAX_RESULT_ROWS`; update it.

40. **`backend/app/operations/ddl.py`** — delete `from .run_query import _affected` ([`:22`](backend/app/operations/ddl.py#L22)) and replace [`get_result`'s return:118](backend/app/operations/ddl.py#L118) with `return status_envelope(self._status)`, imported from `.common`. This also removes the unreachable `self._status or ""` — line 115's `is None` guard already narrows `_status` to `str`, so the fallback could only ever return the empty string it replaced.

41. **`backend/app/operations/list_rows.py`** — delete `_MAX_PAGE_SIZE` ([`:23`](backend/app/operations/list_rows.py#L23)) and use `MAX_ROWS_PER_REQUEST` at [`:65`](backend/app/operations/list_rows.py#L65), keeping the "hostile/buggy client" comment.

42. **`backend/app/operations/import_rows.py`** — delete `MAX_IMPORT_ROWS` ([`:40`](backend/app/operations/import_rows.py#L40)) and use `MAX_ROWS_PER_REQUEST` at lines 158, 159, 225 and 226 and in the docstrings at 155 and 222. Check whether `backend/tests/test_import_rows.py` imports `MAX_IMPORT_ROWS` and retarget it if so.
    Check: `grep -rn '= 1000' backend/app/` — expect one match, in `common.py`.

43. **`backend/app/operations/common.py` — `qualified` delegates to `qualify`.** Replace its body with `return qualify(table.schema, table.name)`, importing `qualify` from `..sql.ddl`; drop the now-unused `quote_ident` import if nothing else in the file uses it. [`sql/ddl.py:72-87`](backend/app/sql/ddl.py#L72)'s own docstring already calls `qualify` a generalization of `qualified`, and `common.py` already imports from `..sql`, so no new dependency direction is created.
    Check: `grep -n 'quote_ident(table' backend/app/operations/common.py` — expect zero matches.

44. **`backend/tests/test_type_definition.py` — pin the type guard.** Add the three cases from `## Expected Behaviour`: a `typtype` outside `('e','c')` raises `NotFound` from `get_result()`; a `typtype='c'` row whose `typrelid` names a table (not a stand-alone composite) is not returned; an enum and a real composite still return as they do today. The suite must fail on the first two.

45. **`backend/app/operations/type_definition.py` — add the guard.** Add `_COMPOSITE_TYPTYPE = "c"` beside [`_ENUM_TYPTYPE:24`](backend/app/operations/type_definition.py#L24) (the comment there already describes both codes). Extend `_TYPE_SQL` ([`:37-42`](backend/app/operations/type_definition.py#L37)) with the same two conditions [`list_types.py:35-36`](backend/app/operations/list_types.py#L35) uses — `LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid`, `AND t.typtype IN ('e', 'c')`, `AND (t.typrelid = 0 OR c.relkind = 'c')` — so the query answers for exactly the types the navigator lists. Change the `else` at [`:92`](backend/app/operations/type_definition.py#L92) to `elif type_row["typtype"] == _COMPOSITE_TYPTYPE:` with a final `else` that sets `self._category = None` and `self._raw = []`, which `get_result()`'s existing `NotFound` at [`:114`](backend/app/operations/type_definition.py#L114) then reports — clear `self._owner` in that branch so the guard fires.[^type-guard]

46. **Fix the twelve inline docstrings.** In [`backend/app/operations/ddl_schema_sequence.py`](backend/app/operations/ddl_schema_sequence.py) (lines 105, 130, 158, 195, 316, 341) and [`backend/app/operations/ddl_function_type.py`](backend/app/operations/ddl_function_type.py) (lines 132, 160, 192, 223, 248, 284), split each one-line `"""text"""` onto three lines per `~/.claude/CODE_CONVENTIONS.md`'s Python rule. `SequenceAlterPreview.build` ([`ddl_schema_sequence.py:270`](backend/app/operations/ddl_schema_sequence.py#L270)) already has the correct form — use it as the template. Text is unchanged.

47. **Run `cd backend && poetry run python -m pytest`.**

### Phase H — Backend SQL, connections and auth

48. **`backend/app/sql/ddl.py` — add `ident_list`.** Declare it beside `qualify` ([`:72`](backend/app/sql/ddl.py#L72)) as `def ident_list(names: Iterable[str]) -> str: return ", ".join(quote_ident(n) for n in names)` — adding `from collections.abc import Iterable` to the module's imports — and add `"ident_list"` to `__all__`. Replace the six copies at lines 194, 423, 454, 538, 539 and 614, and the nested variant inside `create_view`'s `columns_clause` at [`:691`](backend/app/sql/ddl.py#L691) (`f" ({ident_list(columns)})" if columns else ""`). Then replace the seventh copy at [`backend/app/operations/insert_row.py:65`](backend/app/operations/insert_row.py#L65), importing `ident_list` from `...sql.ddl`.[^ident-list]
    Check: `grep -rn 'join(quote_ident' backend/app/` — expect one match, inside `ident_list`.

49. **`backend/app/sql/ddl.py` — `_require_ident` returns nothing.** Its 21 call sites (893, 916, 938, 939, 1001, 1066, 1116, 1117, 1138, 1278, 1279, 1324, 1325, 1350, 1351, 1379, 1380, 1404, 1405, 1436, 1437) all discard the result. Change the signature to `-> None`, delete the `Returns:` block from its docstring ([`:859-876`](backend/app/sql/ddl.py#L859)) and the trailing `return value`. No call site changes.

50. **`backend/app/sql/ddl.py` — share the sequence option ladder.** `sequence_create` ([`:965`](backend/app/sql/ddl.py#L965)) and `sequence_alter` ([`:1024`](backend/app/sql/ddl.py#L1024)) build the same five clauses in the same order. Add a module-private helper:

    ```python
    def _sequence_bound_clauses(
        *,
        increment: int | None,
        min_value: int | None,
        max_value: int | None,
        start: int | None,
        cache: int | None,
    ) -> list[str]:
        """
        Build the sequence option clauses CREATE and ALTER share, in Postgres's
        documented clause order, skipping every option left unset.
        """
    ```

    Both builders call it and extend the returned list with their own clauses — `CYCLE`/`OWNED BY` for create, `AS`/`RESTART`/`CYCLE`/`NO CYCLE` for alter. Keep `sequence_alter`'s `len(parts) == 1` guard and its `_SEQUENCE_TYPES` check exactly as they are. Behaviour is unchanged, so `backend/tests/test_ddl_schema_sequence_sql.py` must pass untouched.

51. **`backend/app/sql/ddl.py` — allowlist the routine keywords.** Add `_ROUTINE_LANGUAGES: frozenset[str] = frozenset({"sql", "plpgsql"})` and `_VOLATILITIES: frozenset[str] = frozenset({"IMMUTABLE", "STABLE", "VOLATILE"})` beside `_ARG_MODES` ([`:1162`](backend/app/sql/ddl.py#L1162)), each with a comment saying the value is a SQL keyword rather than a reviewed passthrough expression, per the section comment at [`:1146-1157`](backend/app/sql/ddl.py#L1146). In `create_routine`, validate `spec.language` (lower-cased) before line 1290 and `spec.volatility` (upper-cased) before line 1292, raising `ValidationError(f"Unknown routine language '{spec.language}'")` / `ValidationError(f"Unknown volatility '{spec.volatility}'")`. Add matching cases to `backend/tests/test_ddl_function_type_sql.py`.

52. **`backend/app/connections.py` — one pop-and-close.** Add a module-private `async def _pop_and_close(session_id: str) -> None` holding the `_sessions.pop(...)` + `if session is not None: await session.pool.close()` pair. Call it from `close_session` ([`:162`](backend/app/connections.py#L162)) and from `sweep_idle_sessions`'s loop ([`:189-191`](backend/app/connections.py#L189)). Rewrite `close_all_sessions` ([`:194`](backend/app/connections.py#L194)) as `for sid in list(_sessions): await _pop_and_close(sid)` and delete the trailing `_sessions.clear()` — the helper removes each entry as it goes.[^close-all]
    Check: `grep -c 'pool.close()' backend/app/connections.py` — expect `1`.

53. **`backend/tests/test_auth.py` — pin the two auth fixes.** Add the cases from `## Expected Behaviour`: a request whose `X-CSRF-Token` matches is accepted and one that does not is rejected (unchanged behaviour, pinned before the comparison changes); and a second successful `POST /api/login` while a session cookie is present leaves the old session id unusable — a subsequent request carrying the old cookie gets 401.

54. **`backend/app/auth.py` — constant-time CSRF comparison.** Add `import secrets` and change [`:172`](backend/app/auth.py#L172) to compare with `secrets.compare_digest`, guarding the `None` header first:

    ```python
    header = request.headers.get(_CSRF_HEADER)

    if header is None or not secrets.compare_digest(header, session.csrf_token):
        raise Forbidden("CSRF token missing or invalid")
    ```

55. **`backend/app/auth.py` — re-login closes the previous session.** In `login`, immediately after `create_session` succeeds (after [`:250`](backend/app/auth.py#L250)'s `try` block and before `clear_login_failures`), add:

    ```python
    # Re-logging in revokes the caller's previous session: without this the old
    # token stays live in the registry, and every request under it re-bumps
    # last_seen, deferring the idle sweep indefinitely.
    await close_session(request.cookies.get(SESSION_COOKIE_NAME))
    ```

    `close_session` is already imported and is already a no-op for an absent or unknown token. Extend `login`'s docstring with one sentence saying so.

56. **Consolidate the `SQLADMIN_ALLOWED_HOSTS` name.** Rename `auth._ALLOWED_HOSTS_ENV` ([`auth.py:40`](backend/app/auth.py#L40)) to the public `ALLOWED_HOSTS_ENV`, updating its two uses in `auth.py` (line 70 and the `Forbidden` message inside `login`). In [`dev.py:28`](backend/app/dev.py#L28) import it and replace the hardcoded `"SQLADMIN_ALLOWED_HOSTS"` string.
    Check: `grep -rn '"SQLADMIN_ALLOWED_HOSTS"' backend/app/` — expect one match, the constant's own definition.

57. **Fix the remaining inline docstrings and one stale claim.** Split the one-liners at [`static.py:32`](backend/app/static.py#L32) and [`:39`](backend/app/static.py#L39), [`rate_limit.py:43`](backend/app/rate_limit.py#L43), [`sql/ddl.py:948`](backend/app/sql/ddl.py#L948), [`:1167`](backend/app/sql/ddl.py#L1167), [`:1177`](backend/app/sql/ddl.py#L1177) and [`:1185`](backend/app/sql/ddl.py#L1185); and fix `dev.py`'s two docstrings (lines 1 and 21), whose summary text sits on the opening `"""` line. Text is unchanged. In [`config.py:1-3`](backend/app/config.py#L1) the docstring says configuration is read with "bare `os.environ` like `connections.py`" — `connections.py` reads no environment variable at all. Replace the comparison with `static.py`, which does follow the convention and says so in its own header ([`static.py:6-8`](backend/app/static.py#L6)).

58. **Run `cd backend && poetry run python -m pytest`.**

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/textFormat.ts` |
| Create | `frontend/src/data/diagramLayout.ts` |
| Create | `frontend/src/dock/panelMetrics.ts` |
| Create | `frontend/src/dock/notify.ts` |
| Create | `frontend/src/dock/summaryPanel.ts` |
| Create | `frontend/src/shell/mutedText.ts` |
| Create | `frontend/src/roles/roleMenu.ts` |
| Create | `frontend/tests/textFormat.test.ts` |
| Create | `frontend/tests/roles/roleMenu.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/theme.ts` |
| Modify | `frontend/src/contract.ts` |
| Modify | `frontend/src/data/buildSchemaDiagram.ts` |
| Modify | `frontend/src/data/buildDatabaseDiagram.ts` |
| Modify | `frontend/src/data/buildRoleGrantsDiagram.ts` |
| Modify | `frontend/src/data/buildRoleMembershipDiagram.ts` |
| Modify | `frontend/src/data/buildExplainDiagram.ts` |
| Modify | `frontend/src/data/fkCardinality.ts` |
| Modify | `frontend/src/data/fkEdgeTooltip.ts` |
| Modify | `frontend/src/data/presetStore.ts` |
| Modify | `frontend/src/dock/ColumnChecklist.ts` |
| Modify | `frontend/src/dock/ConstraintForm.ts` |
| Modify | `frontend/src/dock/ExplainNode.ts` |
| Modify | `frontend/src/dock/TableCardNode.ts` |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` |
| Modify | `frontend/src/dock/IndexInfoPanel.ts` |
| Modify | `frontend/src/dock/IndexSuggestionsView.ts` |
| Modify | `frontend/src/dock/SqlPreviewDialog.ts` |
| Modify | `frontend/src/dock/ImportRowsDialog.ts` |
| Modify | `frontend/src/dock/TypeInfoPanel.ts` |
| Modify | `frontend/src/dock/columnsGrid.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` |
| Modify | `frontend/src/dock/SequenceInfoPanel.ts` |
| Modify | `frontend/src/dock/TableWorkPanel.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/dock/menuItems.ts` |
| Modify | `frontend/src/dock/ddlSpecs.ts` |
| Modify | `frontend/src/roles/RolesTree.ts` |
| Modify | `frontend/src/roles/roleBaseInfoRows.ts` |
| Modify | `frontend/src/shell/StartPage.ts` |
| Modify | `frontend/src/shell/shortcutLegend.ts` |
| Modify | `frontend/src/shell/appRouter.ts` |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |
| Modify | `frontend/tests/dock/ddlSpecs.test.ts` |
| Modify | `frontend/tests/data/presetStore.test.ts` |
| Modify | `backend/app/operations/common.py` |
| Modify | `backend/app/operations/run_query.py` |
| Modify | `backend/app/operations/ddl.py` |
| Modify | `backend/app/operations/list_rows.py` |
| Modify | `backend/app/operations/import_rows.py` |
| Modify | `backend/app/operations/insert_row.py` |
| Modify | `backend/app/operations/type_definition.py` |
| Modify | `backend/app/operations/ddl_schema_sequence.py` |
| Modify | `backend/app/operations/ddl_function_type.py` |
| Modify | `backend/app/sql/ddl.py` |
| Modify | `backend/app/connections.py` |
| Modify | `backend/app/auth.py` |
| Modify | `backend/app/config.py` |
| Modify | `backend/app/static.py` |
| Modify | `backend/app/rate_limit.py` |
| Modify | `backend/app/dev.py` |
| Modify | `backend/app/main.py` (one docstring reference to `MAX_RESULT_ROWS`) |
| Modify | `backend/tests/test_run_query.py` |
| Modify | `backend/tests/test_import_rows.py` (only if it imports `MAX_IMPORT_ROWS`) |
| Modify | `backend/tests/test_type_definition.py` |
| Modify | `backend/tests/test_ddl_function_type_sql.py` |
| Modify | `backend/tests/test_auth.py` |

No file is deleted.

---

## Sequencing against the sibling plans

Nothing here blocks on a sibling, and no step assumes one has landed. Five are worth ordering anyway, because both plans open the same lines:

- **Phase C steps 18-20 after `ddl-forms-in-tab-editing`.** That plan renames `getSpec()` to `readSpec()` across the form modules and edits `ddlSpecs.ts` and `tests/dock/ddlSpecs.test.ts`. `describeSequenceSpecs` lands cleanly either way, but landing second keeps the test file's diff small.
- **Phase C step 14 after `dialog-subclass-foundation`.** That plan rewrites `SqlPreviewDialog.ts`'s and `ImportRowsDialog.ts`'s error-banner code; `CONTENT_SPACING` sits a few lines above it in both files.
- **Phase E step 32 after `data-layer-navigator-convergence` and `refresh-export-action-dedup`.** The first moves `RolesTree.refresh`'s body into an `applyDefaultExpansion` hook on a shared base — the reveal predicate this plan replaces moves with it. The second replaces the two export items inside the context menu this plan extracts. After both land, step 32's menu array is the one `buildRoleMenuItems` should carry.
- **Phase B step 5 after `sqladmin-controller-split`.** That plan moves `DEPENDENCY_LAYOUT` and `INHERITANCE_LAYOUT` out of `SqlAdminController.ts` into a new `frontend/src/controller/diagramPanels.ts`. The edit is the same either way; landing second means editing them where they finally live.
- **Phase G steps 40 and 45-46 after `backend-query-ddl-layer-convergence`.** That plan rewrites `ddl.py`, `type_definition.py`, `ddl_schema_sequence.py` and `ddl_function_type.py` extensively. The edits here are additive and small; landing them second keeps them mechanical.

---

## Expected Behaviour

### Unit-testable

**`yesNo` (`frontend/tests/textFormat.test.ts`)** — `yesNo(true)` is `"Yes"`; `yesNo(false)` is `"No"`.

**`describeSequenceSpecs` (`frontend/tests/dock/ddlSpecs.test.ts`)**

| Specs | Lines |
|---|---|
| `{}` (no alter, no owner) | `[]` |
| alter with `increment: 25` over a detail whose increment is `10` | `["Increment: 10 → 25"]` |
| alter with `dataType` and `cache` both set | one line each, data type first, in the function's declared order |
| owner-only spec | the owner line alone |

**`buildRoleMenuItems` (`frontend/tests/roles/roleMenu.test.ts`)**

- Returns six entries in order: `"Show data"`, a separator, `"Show membership graph"`, `"Show grants graph"`, a separator, `"Export grants"`.
- `"Export grants"` carries a submenu whose two items are the CSV and JSON entries.
- Invoking each item's `action` calls the matching `RoleMenuActions` member exactly once, with the role name (and, for the export items, the format).

**`presetStore._withRepair` (`frontend/tests/data/presetStore.test.ts`)**

| Write throws | Stored presets afterwards | Call result |
|---|---|---|
| `SyntaxError` on the first attempt, succeeds on the retry | the retry's write | resolves |
| `Error("QuotaExceededError")` | unchanged | rejects with that error |

**Backend (`poetry run pytest`)**

- `status_envelope(None)` is `{"kind": "status", "command": "", "rowCount": 0}`; `status_envelope("UPDATE 5")` is `{"kind": "status", "command": "UPDATE 5", "rowCount": 5}`. The existing assertions in `test_execute_ddl.py:40,47` and `test_run_query.py:140` must pass unchanged.
- `ident_list(["a", 'b"c'])` is `"a", "b""c"`; `ident_list([])` is `""`.
- `TypeDefinitionQuery` against a `typtype` of `"b"`, `"d"`, `"r"` or `"p"` raises `NotFound` from `get_result()`; against a `typtype` of `"c"` whose `typrelid` names a table, the row is not returned at all (the SQL excludes it) and `get_result()` raises `NotFound`; an enum and a stand-alone composite return exactly what they return today.
- `create_routine` with `language="python"` raises `ValidationError`; with `volatility="FAST"` raises `ValidationError`; with `language="plpgsql"` and `volatility="STABLE"` emits today's SQL.
- `sequence_create` and `sequence_alter` emit byte-identical SQL to today for every case in `test_ddl_schema_sequence_sql.py`.
- `require_csrf` accepts a matching header and rejects a mismatched or absent one, exactly as today.
- A second successful `POST /api/login` while a session cookie is present invalidates the old session id: a request carrying the old cookie returns 401.
- `close_all_sessions()` leaves `_sessions` empty and every pool closed.

### Manual verification

The node vitest harness cannot construct any of these — `Table`, `Panel`, `Tree` and `Dialog` all touch `document` at import scope.

- **Diagrams.** A schema diagram, a whole-database diagram, a role-grants graph, a role-membership graph and an EXPLAIN diagram all lay out exactly as before (Phase B changes only where the layout options and edge literals are declared). A table card's frame and the EXPLAIN node's frame are unchanged; the root node of a relation graph still draws the accent frame.
- **Structure tab.** The Indexes, Constraints and Foreign Keys sections each still show a Drop button that is disabled until a row is selected and enabled after, and dropping still targets the selected row's name.
- **Index suggestions strip.** With the strip open under a query's EXPLAIN result, the "Create index…" toolbar is fully visible above the table and the table scrolls internally — today the toolbar is squeezed.
- **Add constraint → Foreign key.** The referenced-schema combo opens pre-set to the table's own schema.
- **Roles rail.** Right-clicking a role shows all six menu entries with their glyphs rendered (not blank boxes), and each action still works.
- **Deep links.** `#/schema/public/sequence/<name>`, `#/schema/public/index/<name>` and `#/schema/public/type/<name>` each open the right tab and reveal the object in the navigator.
- **Start page and Shortcuts dialog.** Section headings still render bold and muted.
- **Saved connections.** Saving a preset with storage full surfaces the error and leaves existing presets listed.

---

## Verification

1. `npm --prefix frontend run typecheck` — clean.
2. `npm --prefix frontend test` — green, including the three new/extended suites.
3. `npm --prefix frontend run build` — clean.
4. `cd backend && poetry run python -m pytest` — green.
5. Convergence greps (all run from the repo root):
   - `grep -rn 'function yesNo' frontend/src/` → one.
   - `grep -rn '"elk.algorithm"' frontend/src/` → one.
   - `grep -rn 'ts-ui-border-color\|ts-ui-accent-color' frontend/src/` → `theme.ts` only.
   - `grep -rn 'const CONTENT_SPACING\|const CONTENT_WIDTH_CAP' frontend/src/` → `panelMetrics.ts` only.
   - `grep -rn 'type Notify =' frontend/src/` → one.
   - `grep -rn 'function summaryPanel' frontend/src/` → one.
   - `grep -rn 'orderColumnsBySelection' frontend/src/` → `ddlSpecs.ts` only.
   - `grep -rn '= 1000' backend/app/` → one, in `common.py`.
   - `grep -rn 'join(quote_ident' backend/app/` → one, inside `ident_list`.
   - `grep -c 'pool.close()' backend/app/connections.py` → 1.
   - `grep -rn '"SQLADMIN_ALLOWED_HOSTS"' backend/app/` → one.
6. The manual checks above, driven through the running app (`.claude/skills/verify`). Entry points: the navigator's schema/relation context menus, a table's Structure tab, the Roles rail, the query workspace's Explain result, and the address bar for the three deep links.

---

## Documentation Impact

No public API and no docs site is involved — this is an app-internal sweep. The in-repo documents that change:

- **`frontend/COMPONENT_CONVENTIONS.md`** — step 37's single correction, in the intro paragraph. `sqladmin-controller-split` corrects section (b)'s worked example and two other plans add new sections, so the edits do not collide.
- **Module headers rewritten to match what the code now does**: `ColumnChecklist.ts`, `RelationGraphPanel.ts`, `TableCardNode.ts`, `IndexSuggestionsView.ts`, `presetStore.ts`, `backend/app/config.py`, `backend/app/operations/common.py`.
- **`CHANGELOG.md` is not edited here.** The two auth fixes (steps 54-55) are user-visible security behaviour and belong in the release's changelog entry, written when the release is prepared, not per-plan.

---

## Potential Challenges

- **`import type` discipline in the new pure modules.** `textFormat.ts`, `diagramLayout.ts`, `notify.ts` and `roleMenu.ts` must not import a library *value*; a plain (non-`type`) import of a component module pulls `document`-touching side effects into the node test environment. `roleMenu.ts` imports `MenuItemConfig` as a type only.
- **`summaryPanel.ts` is not pure.** It constructs `Panel` and `Text`, so it stays untested by unit test — which is why the line-building half moves to `ddlSpecs.ts` instead.
- **`ComboBox` with a `value` not in `items`.** Step 25 guards with `schemas.includes(schema)`; without the guard a table whose schema is missing from the fetched list would seed an invalid value.
- **The shared ELK option objects must not be mutated.** `relationDiagram.ts` and `groupBySchema.ts` pass `layoutOptions` through by reference, so a consumer that wrote into the returned object would corrupt every other diagram. Nothing does today; the module header says so.
- **`_pop_and_close` inside `close_all_sessions` needs a snapshot.** Iterating `_sessions` while the helper pops from it raises; step 52 iterates `list(_sessions)`.
- **The type-definition SQL change is behavioural.** Step 45 narrows what `_TYPE_SQL` matches, so a request naming a table now 404s instead of returning empty attributes. Step 44's tests must be written first.

---

## Critical Files

- [frontend/src/theme.ts](frontend/src/theme.ts) — the precedent for centralizing an app-level constant, and its header states the rule this plan applies repeatedly.
- [frontend/src/navigator/objectMenu.ts](frontend/src/navigator/objectMenu.ts) and [frontend/tests/navigator/objectMenu.test.ts](frontend/tests/navigator/objectMenu.test.ts) — the model for `roleMenu.ts` and its test.
- [frontend/src/dock/columnsGrid.ts](frontend/src/dock/columnsGrid.ts) — owns `readOnlyTable`, `CONTENT_WIDTH_CAP` and the filler-column mechanism the whole of Phase C rests on.
- [frontend/src/shell/appRouter.ts](frontend/src/shell/appRouter.ts) — its `RELATION_KINDS` and `ROLE_BUCKETS` loops are the pattern step 33 follows.
- [backend/app/operations/common.py](backend/app/operations/common.py) and [backend/app/operations/base.py](backend/app/operations/base.py) — the shared-helper home and the CQRS contract Phase G edits sit inside.
- [backend/app/sql/ddl.py:1146-1157](backend/app/sql/ddl.py#L1146) — the module's own statement of which values are validated keywords and which are reviewed passthroughs; step 51 applies it.
- [~/.claude/CODE_CONVENTIONS.md](~/.claude/CODE_CONVENTIONS.md) — the Python docstring rule steps 46 and 57 enforce.
- [plans/research/codebase-health-audit-2026-08-29.md](plans/research/codebase-health-audit-2026-08-29.md) — the source survey.

---

## Non-Goals

These were investigated and deliberately left out.

- **Extracting a shared `errorMessage(err)` and routing the six hand-written `err instanceof Error ? err.message : String(err)` sites through it.** `sqladmin-controller-split` moves the controller's richer `errorMessage`/`detailOf` — which unwraps a backend `{detail}` body before falling back to `.message` — into `frontend/src/controller/controllerText.ts` with its own tests. Adding a second function of the same name here would leave two homes for one idea. The six remaining sites are `parseImport.ts:180`, `SqlPreviewDialog.ts:296`, `LoginDialog.ts:308`, `SequenceInfoPanel.ts:309`, `exportExplainResult.ts:58` and `StructurePanel.ts:309`; routing them through `controllerText.errorMessage` is a one-line-per-site follow-up once that plan lands. (`dialog-subclass-foundation` absorbs the three error-banner copies separately.)
- **`shortcutRegistry.ts`'s dead `ShortcutScope`, `SqlAdminShell.ts`'s two stale JSDoc claims, `ActivityBar.ts`'s Phase-1 claim, and `COMPONENT_CONVENTIONS.md` section (b)'s worked example.** All four are `sqladmin-controller-split`'s steps 18-21.
- **A generic `findByStringKey` merging `findHistoryEntry` and `findRecordByKey`.** [`queryStore.ts:160`](frontend/src/data/queryStore.ts#L160) and [`recordNavigation.ts:72`](frontend/src/dock/recordNavigation.ts#L72) are three lines each, already cross-reference one another, and differ in a null guard only one caller needs. A shared version would take a key-extractor callback and a guard flag — more indirection than it removes.
- **A shared "safely read JSON from storage" helper.** Only two of the three sites actually parse JSON: [`presetStore._readSafe:105`](frontend/src/data/presetStore.ts#L105) delegates to the library's `WebStorageProxy.read()`. The two that do parse differ in their accept check (array vs. plain object) and fallback (`[]` vs. `{}`), so the shared function would take both as parameters.
- **A shared serialize→mime→download wrapper for the two exporters.** `query-workspace-toolbar-dedup` adds unit tests to both `exportQueryResult` and `exportRoleGrants` that mock `../data/download` and assert the `download(content, filename, mime)` call. An intermediate wrapper would be mocked away with it and the tests would stop testing the thing they were written for.
- **Extracting the shared shape of `api.ts`'s ~25 `preview*` builders.** `data-layer-navigator-convergence` rewrites all 54 URL constructions through `apiPath`, and `backend-route-registration-restructure` inserts a `db` segment into 44 of them. A third pass over the same lines is not worth the conflict.
- **Unwrapping `onError`'s `string` into `unknown`.** `ddl-forms-in-tab-editing` deliberately keeps `onError: (message: string) => void` on its new `DdlExecuteDeps`, and its `ddlDefaults(ref)` reduces the string-to-`Error` rewrap to one site. Changing the signature would contradict that decision.
- **Merging `RenameTableForm` with `RenameSchemaForm`, or `ViewForm` with `MatviewForm`.** `ddl-forms-in-tab-editing` keeps all four as separate form classes and names them individually in its migration tables.
- **Extracting the whole Save-diff flow shared by `StructurePanel` and `SequenceInfoPanel`.** Only the summary panel is genuinely identical; the two `generateSql` bodies differ (one joins N column previews, the other an alter plus an owner preview) and the two `deps` interfaces are unrelated types.
- **`ddlSpecs.ts`'s unreachable spec fields** (`IndexFields.ifExists`, `AlterTableFields.cascade`, `buildCreateTableSpec`'s `ifNotExists`). `ddl-forms-in-tab-editing` states these need a feature, not a refactor, and wires the two drop paths that do have a UI.
- **Extracting a shared id-carrying grid-spec builder.** Only two specs carry a hidden `id` field ([`IndexSuggestionsView.ts:43`](frontend/src/dock/IndexSuggestionsView.ts#L43), [`ExplainDiagramPanel.ts:103`](frontend/src/dock/ExplainDiagramPanel.ts#L103)) and their column lists are entirely different; the shared part is one `appendUnlisted: false`.
- **Decomposing the long constructors in `ExplainDiagramPanel`, `DiagramShell` and `DatabaseDiagramPanel`.** All three are being restructured by `diagram-panel-family-convergence`; splitting them here would collide with that work and re-split what it has already moved.
- **The two write-only backend fields.** [`import_rows.py:147-148`](backend/app/operations/import_rows.py#L147) documents `PreviewImportRowsQuery._table` as carried for symmetry, and [`list_schemas.py:34`](backend/app/operations/list_schemas.py#L34) documents `_database` as the multi-DB seam — a seam [`contract.py:33`](backend/app/contract.py#L33) also names and `backend-query-ddl-layer-convergence`'s migration table carries forward on purpose.
- **`ExportRowsQuery` not implementing `apply()`/`get_result()`.** `backend-query-ddl-layer-convergence` decided to keep `Query` a bare marker precisely so this class keeps a clear `NotImplementedError`, and [`export_rows.py:1-12`](backend/app/operations/export_rows.py#L1) documents the deviation.
- **Making a malformed login body count toward the lockout.** A body that is valid JSON but not an object is rejected by FastAPI before `login` is entered, so it neither counts nor is rate-limited — while `{}` reaches `_conn_parts` and does count. The asymmetry is real but not exploitable for credential guessing (no credential check runs on that path), and closing it means changing how the login route validates its body, which belongs with `backend-route-registration-restructure`.
- **Consolidating every env-var read into `config.py`.** [`static.py:6-8`](backend/app/static.py#L6) documents the per-module `_..._ENV` + bare `os.environ` shape as the deliberate convention, and `config.py` also carries the `/api/config` route handler, so it is not a pure config module today. Choosing between those two shapes is a design call, not a sweep item; this plan fixes only the two documentation and naming defects underneath it (steps 56-57).
- **`table_structure.py`'s "these four codes" comment, `backend/README.md`'s Layout gaps, and `main.py`'s `/objects` docstring.** All three are corrected by `backend-query-ddl-layer-convergence` and `backend-route-registration-restructure`.

---

## Implementation Notes

- **Step 49 (`_require_ident` returns nothing) was skipped — its target no longer exists in the shape the plan describes.** By the time this plan landed, `backend-query-ddl-layer-convergence`'s own audit loop had already renamed `sql/ddl.py`'s `_require_ident` to the public `require_text(value, label)` (commit "Converge the four DDL modules' required-field validation") **and** given it a genuine second caller: `operations/ddl.py`'s new `require_field(spec, key)` returns `require_text(...)`'s value directly. `require_text` still has the same 21 discard-the-result call sites inside `sql/ddl.py` this step was written against, but changing its signature to `-> None` (as the plan directs) would break `require_field`, which needs the validated string back. Since the function this step targets was consolidated into a different shape with a real consumer, there is no version of the described fix that both matches the plan's intent and doesn't regress `require_field` — so the step is left unapplied rather than force-fit.
- **Several convergence greps in the plan's own step text (steps 21, 42's neighbor, 52) count one extra literal match than the plan predicted**, because the grep pattern also matches a function's own definition line (e.g. `gateOnSelection(grid: Table` contains the substring `gateOnSelection(grid`) or an unrelated pre-existing call outside the refactor's scope (`connections.py`'s probe-failure `pool.close()`, which closes a pool never registered in `_sessions` and so has nothing to do with the pop-and-close consolidation). In each case the actual invariant the check was written to verify — one call site remaining, or the intended `pool.close()` sites collapsing to one shared helper — was confirmed by inspecting the matches directly, not just the count.
- **`appRouter.ts`'s new `SCHEMA_OBJECT_ROUTES` loop uses `controller.reveal.selectObject(ref)`, not `controller.selectObject(ref)`, and its three `open` callbacks call `c.panels.openSequence(ref)`/`.openIndex(ref)`/`.openType(ref)`, not `c.openSequence(ref)` etc., as the plan's `## Internal Structure` snippet shows.** `sqladmin-controller-split` had already moved `selectObject` onto a `reveal` sub-object and `openSequence`/`openIndex`/`openType` onto a `panels` sub-object by the time this step landed, and every other route handler in the file already calls them that way; the plan's snippet predates the split.
- **`RolesTree.ts`'s new `buildRoleMenuItems` wiring calls `this.controller.roles.showRole(n)`/`.openRoleMembershipDiagram(n)`/`.openRoleGrantsDiagram(n)`/`.exportRole(n, format)`, not `this.controller.showRole(n)` etc. as the plan's step 32 literally specifies.** `this.controller.roles` was already the established shape at this branch's own start point (`git show 22148f7:frontend/src/roles/RolesTree.ts`), from an earlier sibling restructuring; the plan's step predates it. Same drift class as the `.reveal`/`.panels` notes above.
- **Step 39's `backend/app/main.py` docstring fix landed in `backend/app/endpoints/query.py` instead — `main.py` is untouched by this branch.** The plan (and the Files table's `main.py` row) was written against a pre-restructure snapshot where `main.py:884` carried the `MAX_RESULT_ROWS` docstring reference; by the time this plan landed, the already-merged `backend-route-registration-restructure` sibling plan had shrunk `main.py` to 134 lines and moved that docstring to `endpoints/query.py:37`. The fix was applied at its real location (commit `022340c`) — no `MAX_RESULT_ROWS`/`MAX_IMPORT_ROWS`/`_MAX_PAGE_SIZE` reference remains anywhere in `backend/` — but `main.py` itself was correctly never touched, since it no longer had anything to fix.
- **Step 16's second `Notify` consumer retarget landed in `frontend/src/controller/objectPanels.ts`, not `SqlAdminController.ts:46` as the plan names it — `SqlAdminController.ts` is untouched by this branch, and the Files table's `SqlAdminController.ts` row is not satisfied by it.** `sqladmin-controller-split` had already moved that consumer (the `TableViewOptions`/`Notify` type import feeding `TableWorkPanel`) into the new `controller/objectPanels.ts:17` by the time this step landed. The retarget was applied at its real location (folded into commit `cb1a5bc`) and is otherwise identical to what the plan describes; this is the same class of controller-split drift already documented above for `DEPENDENCY_LAYOUT`/`INHERITANCE_LAYOUT` (Phase B) and `.reveal.selectObject` (Phase E), just a Phase C instance the plan's own `## Sequencing against the sibling plans` didn't call out.

---

## Notes

[^new-modules]: Five new modules is more files than folding each helper into an existing one, and each is small. The alternative was rejected per case, not as a rule. `yesNo` cannot live in either caller: `IndexInfoPanel.ts` and `roleBaseInfoRows.ts` are in different directories and neither is the other's parent. `Notify` is declared by two peers that must not import each other. `summaryPanel` is used by two peers in the same directory. `diagramLayout`'s constants are read by five builders and the controller. `mutedText`'s two functions are used by a shell module and the start page. In every case the alternative is one module importing a helper out of an unrelated sibling — which is the coupling `graph.py`'s `from .table_structure import _CONSTRAINT_TYPES` already demonstrates the cost of. `frontend/src/appIdentity.ts` plus `frontend/tests/appIdentity.test.ts` is the in-repo precedent for a small root-level pure module with its own test.

[^parse-only-repair]: `_withRepair` exists for one failure: `WebStorageProxy`'s `create`/`update`/`destroy` re-parse the stored blob and throw synchronously when it is corrupt. That throw is a `SyntaxError` from `JSON.parse`. Every other failure a web-storage write can raise — `QuotaExceededError` when storage is full, a `SecurityError` when storage is blocked — is unaffected by deleting the key, so the current catch-all answers "I could not save your preset" by deleting every preset the user has and then failing again anyway. Narrowing to `SyntaxError` keeps the repair for the case it was written for. Checking the message text instead was rejected as browser-dependent; `JSON.parse` throwing `SyntaxError` is specified.

[^strip-height]: The other direction — keep the sizes on the table and add the toolbar's height to the strip's — was rejected because the toolbar's height is not a number this module knows; it comes from the library's `ToolBar` and its button metrics. Sizing only the outer strip lets the `BorderLayout` do that arithmetic, which is what a `BorderLayout` is for, and it matches what `SUGGESTIONS_HEIGHT`'s own comment already claims the value means.

[^keyword-allowlist]: `LANGUAGE` and volatility reach `create_routine` straight from the wire payload with no validation at any layer ([`ddl_function_type.py:124`](backend/app/operations/ddl_function_type.py#L124) and [`:127`](backend/app/operations/ddl_function_type.py#L127)), and are interpolated into the statement text unquoted. The module's trust model does cover raw passthroughs, but it enumerates them — "raw type strings, defaults, function bodies, and enum labels" — and says a *mode* "is a keyword (not a passthrough expression), so it is validated against this fixed allowlist rather than inserted raw". Language and volatility are keywords by that same test, so the module is inconsistent with its own stated rule. This is not a privilege escalation — the route needs an authenticated session and a CSRF token, and the SQL is shown in an editable preview before execute — but it is the one place in `sql/ddl.py` where a keyword slot takes arbitrary text. `_ROUTINE_LANGUAGES` holds `sql` and `plpgsql`, the two languages the frontend's function form offers; adding another is a one-line change with a test.

[^relogin]: `login` never reads the request's session cookie, and `create_session` unconditionally registers a new entry under a fresh token ([`connections.py:139`](backend/app/connections.py#L139)). The old `Session` stays in `_sessions` with its pool open, reachable by its old token. Nothing evicts it until `sweep_idle_sessions` finds it idle for 30 minutes — and every request under the old token re-bumps `last_seen` at [`auth.py:150`](backend/app/auth.py#L150), so an active holder defers that indefinitely. Re-logging in is therefore not a revocation, which is what a user expects it to be. `min_size=0` on the pool ([`connections.py:116`](backend/app/connections.py#L116)) means an abandoned pool holds no live Postgres connections, so the cost is the revocation gap and some memory rather than connection exhaustion.

[^type-guard]: Clearing `self._owner` in the fallthrough branch is what makes the guard visible to `get_result()`: that method reports `NotFound` when `_owner` is `None` ([`type_definition.py:114`](backend/app/operations/type_definition.py#L114)) and otherwise trusts `_category`. Raising from `apply()` instead was rejected — `apply()` is the I/O phase and every sibling handler reports "not found" from `get_result()`, which is what makes the transform unit-testable by hand. Extending `_TYPE_SQL` with `list_types.py`'s two conditions rather than filtering in Python keeps the two modules' definition of "a type the navigator lists" in one shape, and means a table name never reaches the shaping code at all.

[^ident-list]: `ident_list` is exported and added to `__all__` rather than kept module-private because the seventh copy lives outside `sql/ddl.py`, in [`insert_row.py:65`](backend/app/operations/insert_row.py#L65). `operations` already imports from `sql` (`common.py` imports `quote_ident` from `..sql.compiler`), so no new dependency direction is created. Placing it in `sql/compiler.py` beside `quote_ident` was the alternative; `sql/ddl.py` wins because six of the seven call sites are already in it and `qualify` — the other identifier-composition helper — lives there too.

[^close-all]: Routing `close_all_sessions` through the same helper leaves one function that closes a pool, which is the point of the extraction. The behaviour is identical: today's version closes every pool then clears the dict in one call; the helper removes each entry as it closes it, and the loop iterates a snapshot (`list(_sessions)`) so mutation during iteration is safe. A session added concurrently mid-loop would survive — but this function only runs at lifespan shutdown, after the server has stopped accepting requests.

[^glyph-registration]: `Glyph.register` is global and idempotent, so the five glyphs `RolesTree`'s menu names do resolve today — `SqlAdminController.ts:104` registers `key` and `diagram_project`, and `SqlAdminShell.ts:69` registers the three file glyphs. The menu therefore renders correctly by accident of what else the app happens to load. `NavigatorTree.ts:45` registers exactly the glyphs `objectMenu.ts` names for this reason, and both `objectMenu.ts` and `menuItems.ts` state the convention in their headers. Registering them in `RolesTree` makes the roles menu hold to the same rule and survives any future change to what the controller and shell import.
