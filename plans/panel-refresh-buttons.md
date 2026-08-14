---
touches-shared:
  - frontend/src/SqlAdminController.ts
  - frontend/src/dock/StructurePanel.ts
  - frontend/src/dock/DefinitionPanel.ts
  - frontend/src/dock/FunctionDefinitionPanel.ts
  - frontend/src/dock/SequenceInfoPanel.ts
  - frontend/src/dock/IndexInfoPanel.ts
  - frontend/src/dock/definitionEditor.ts
  - README.md
---

# Panel Refresh Buttons — Implementation Plan

## Overview

Five dock tabs currently show a snapshot fetched when they opened, with no way to re-read it: the table Structure tab ([`frontend/src/dock/StructurePanel.ts:95`](frontend/src/dock/StructurePanel.ts#L95)), the view/matview Definition tab ([`DefinitionPanel.ts:47`](frontend/src/dock/DefinitionPanel.ts#L47)), the function/procedure Definition tab ([`FunctionDefinitionPanel.ts:28`](frontend/src/dock/FunctionDefinitionPanel.ts#L28)), the Sequence info tab ([`SequenceInfoPanel.ts:108`](frontend/src/dock/SequenceInfoPanel.ts#L108)), and the Index info tab ([`IndexInfoPanel.ts:40`](frontend/src/dock/IndexInfoPanel.ts#L40)). Re-opening a tab only focuses it ([`SqlAdminController.ts:728`](frontend/src/SqlAdminController.ts#L728)), so today the only way to see fresh data is to close the tab and open it again.

This plan gives each of the five a toolbar Refresh button that re-fetches the tab's data and reseeds the panel in place. The Structure and Index tabs get a toolbar for the first time; the other three gain a second button beside their existing Save. The Structure, Index, and Sequence panels gain a public `reload(...)` — the two definition panels already have one — and the controller's five `open*` methods each register a refresh closure on their `_openPanels` entry ([`SqlAdminController.ts:175`](frontend/src/SqlAdminController.ts#L175)).

Registering that closure also makes the existing Alt+R accelerator and the View → Refresh menu item work on all five tabs, since both call `refreshActive()` ([`SqlAdminController.ts:2838`](frontend/src/SqlAdminController.ts#L2838)), which today no-ops for any tab without a data store.

---

## Architecture Decisions

### Refresh re-fetches and reloads the tab in place

Every Refresh runs the same shape: re-run the tab's own open-time fetch, hand the result to the panel's `reload(...)`, and leave the tab, its position in the tab strip, and its scroll state alone. This mirrors the Save-success reload path `openDefinition` and `openFunctionDefinition` already run ([`SqlAdminController.ts:559-561`](frontend/src/SqlAdminController.ts#L559), [`:1304-1306`](frontend/src/SqlAdminController.ts#L1304)).[^in-place-not-reopen]

### The button is `glyphButton("refresh", …)`, not `refreshTool`

All five Refresh buttons are built with `glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", handler)` from [`dock/glyphButton.ts:42`](frontend/src/dock/glyphButton.ts#L42) — character-for-character the call [`TableWorkPanel.ts:166`](frontend/src/dock/TableWorkPanel.ts#L166) already makes for the data grid's Refresh, the only existing dock-tab Refresh button.[^glyph-button-not-refresh-tool]

### Alt+R and View → Refresh route through `refreshActive`, not a per-panel accelerator

`OpenPanel` gains an optional `refresh?: () => void`, each `open*` method sets it, and `refreshActive()` calls it when present. No panel binds its own keyboard shortcut.[^route-through-refresh-active]

### The Structure tab gets a tab-level NORTH toolbar, not an accordion section tool

`StructurePanel`'s root changes from `Panel` (the scroll host) to `Container` with a `Border` layout: a one-button `ToolBar` NORTH, and the existing `autoScroll` VBox `Panel` — accordion and all — moved into CENTER. This is the exact shape `SequenceInfoPanel` already has ([`SequenceInfoPanel.ts:201-226`](frontend/src/dock/SequenceInfoPanel.ts#L201)): `Container`/`Border` root, `ToolBar` NORTH, `Panel({ layoutManager: new VBox(), autoScroll: "auto" })` CENTER.[^structure-toolbar-not-section-tool]

### Refresh discards unsaved edits without asking, and is always enabled

On the three editable tabs (view definition, function definition, sequence form), Refresh replaces the widgets' contents and resets the Save baseline, throwing away any in-progress edit with no confirmation prompt. The button never disables.[^discard-silently]

### One private controller helper wraps every panel's re-fetch

`SqlAdminController` gains `private async refreshPanel(ref, reload)`, which runs the caller's re-fetch inside a `try`/`catch` and owns both outcome messages. Each `open*` method supplies only the fetch-and-reseed body.[^one-helper]

### Constraint and foreign-key row mapping moves to a DOM-free module

The `.map(...)` bodies inside `buildConstraintsGrid` ([`StructurePanel.ts:351`](frontend/src/dock/StructurePanel.ts#L351)) and `buildForeignKeysGrid` ([`StructurePanel.ts:392`](frontend/src/dock/StructurePanel.ts#L392)) move to a new `frontend/src/dock/structureRows.ts` as `constraintRows` and `foreignKeyRows`, called from both the initial build and `reload`. This mirrors `columnSequence.ts`'s `toColumnRows`, split out of `columnsGrid.ts` for exactly this reason.[^structure-rows-module]

The two mappings flatten each metadata record's string arrays into one comma-joined display string and pass every other field through untouched:

| Input | `constraintRows` output |
|---|---|
| `{name: "orders_pkey", type: "primaryKey", columns: ["id"], definition: "PRIMARY KEY (id)"}` | `{name: "orders_pkey", type: "primaryKey", columns: "id", definition: "PRIMARY KEY (id)"}` |
| `{name: "chk_total", type: "check", columns: [], definition: "CHECK (total >= 0)"}` | `{name: "chk_total", type: "check", columns: "", definition: "CHECK (total >= 0)"}` |

| Input | `foreignKeyRows` output |
|---|---|
| `{name: "fk_o_c", columns: ["cust_id","org_id"], refSchema: "sales", refTable: "customers", refColumns: ["id","org"], onUpdate: "NO ACTION", onDelete: "CASCADE"}` | `{name: "fk_o_c", columns: "cust_id, org_id", refSchema: "sales", refTable: "customers", refColumns: "id, org", onUpdate: "NO ACTION", onDelete: "CASCADE"}` |

---

## Public API

### `frontend/src/dock/structureRows.ts` (new)

```ts
export interface ConstraintRow {
    name: string;
    type: string;
    columns: string;
    definition: string;
}

export interface ForeignKeyRow {
    name: string;
    columns: string;
    refSchema: string;
    refTable: string;
    refColumns: string;
    onUpdate: string;
    onDelete: string;
}

export function constraintRows(constraints: ConstraintMeta[]): ConstraintRow[];
export function foreignKeyRows(foreignKeys: ForeignKeyMeta[]): ForeignKeyRow[];
```

### `frontend/src/dock/StructurePanel.ts`

```ts
class StructurePanel extends Container {           // was: extends Panel
    constructor(
        columns: ColumnMeta[],
        structure: TableStructure,
        onOpenReferenced: (refSchema: string, refTable: string) => void,
        onOpenSequence: OpenSequenceHandler,
        onRefresh: () => void,                     // new, 5th positional
        layout: AccordionLayoutBinding,
        actions?: StructureActions,
    );

    reload(columns: ColumnMeta[], structure: TableStructure): void;   // new
}
```

Backing fields for `reload`: `_columns: ColumnMeta[]` (mutable — the Columns section tools resolve a selected row against it), plus one `StructureGrid` per section (`_columnsSection`, `_indexesSection`, `_constraintsSection`, `_foreignKeysSection`).

### `frontend/src/dock/IndexInfoPanel.ts`

```ts
export interface IndexInfoPanelDeps {
    schema: string;
    onOpenTable: (schema: string, table: string) => void;
    onRefresh: () => void;                         // new
}

class IndexInfoPanel extends Container {
    reload(detail: IndexDetail): void;             // new
}
```

Backing fields: `_detail: IndexDetail` (mutable), `_tableLink: Link`, `_uniqueText: Text`, `_primaryText: Text`, `_editor: CodeEditor`.

### `frontend/src/dock/SequenceInfoPanel.ts`

```ts
export interface SequenceInfoPanelDeps {
    // …existing members unchanged…
    onRefresh: () => void;                         // new
}

class SequenceInfoPanel extends Container {
    reload(detail: SequenceDetail): void;          // new — promoted from handleSuccess
}
```

### `frontend/src/dock/definitionEditor.ts`

```ts
export class DefinitionEditor {
    constructor(
        definition: string,
        onSave: (text: string) => void | Promise<void>,
        onRefresh: () => void,                     // new, 3rd positional
    );
}
```

### `frontend/src/dock/DefinitionPanel.ts`

```ts
export class DefinitionPanel {
    constructor(
        definition: string,
        columns: ColumnMeta[],
        onSave: (newDefinition: string) => void | Promise<void>,
        onRefresh: () => void,                     // new, 4th positional
        layout: SplitLayoutBinding,
    );
}
```

### `frontend/src/dock/FunctionDefinitionPanel.ts`

```ts
export class FunctionDefinitionPanel {
    constructor(
        definition: string,
        onSave: (newDefinition: string) => void | Promise<void>,
        onRefresh: () => void,                     // new, 3rd positional
    );
}
```

### `frontend/src/SqlAdminController.ts`

```ts
interface OpenPanel {
    ref: DbObjectRef;
    node: TreeNode | null;
    store?: AjaxStore;
    columns?: ColumnMeta[];
    detail?: string;
    refresh?: () => void;                          // new
}

// on SqlAdminController:
private async refreshPanel(ref: DbObjectRef, reload: () => Promise<void>): Promise<void>;
```

---

## Internal Structure

### `refreshPanel` — the shared outcome wrapper

```ts
private async refreshPanel(ref: DbObjectRef, reload: () => Promise<void>): Promise<void> {
    try {
        await reload();
    } catch (err) {
        this.notifyError(new Error(`failed to refresh: ${this.errorMessage(err)}`), ref);

        return;
    }

    this.statusBar.setMessage(`${this._statusScope} · ${ref.name}: refreshed`);
}
```

It never rejects, so every call site may write `void this.refreshPanel(...)`.

### `refreshActive` — panel closure first, store second

```ts
refreshActive(): void {
    const entry = this._activePanelId ? this._openPanels.get(this._activePanelId) : undefined;

    if (entry?.refresh) {
        entry.refresh();

        return;
    }

    if (!entry?.store) {
        return;
    }

    // …existing reject()/load()/setMessage body, unchanged…
}
```

No entry ever carries both `refresh` and `store`: `openTable` sets only `store`, and the five `open*` methods here set only `refresh`. The `refresh` branch reports its own outcome through `refreshPanel`, so it must return before the store branch's `setMessage`.

### `StructurePanel` — the reseed handle per section

```ts
/** A structure grid plus the store backing it, so `reload` can reseed without rebuilding the Table. */
interface StructureGrid {
    grid: Table;
    store: MemoryStore;
}

/** Drop the section's selection, then replace its rows. */
function reseed(section: StructureGrid, rows: object[]): void {
    section.grid.selectRecord(null);
    section.store.loadData(rows);
}
```

`buildColumnsGrid`'s exported `ColumnsGrid` ([`columnsGrid.ts:24`](frontend/src/dock/columnsGrid.ts#L24)) has the identical shape, so it assigns to a `StructureGrid` field with no cast.

```ts
reload(columns: ColumnMeta[], structure: TableStructure): void {
    this._columns = columns;

    reseed(this._columnsSection,     toColumnRows(columns));
    reseed(this._indexesSection,     structure.indexes);
    reseed(this._constraintsSection, constraintRows(structure.constraints));
    reseed(this._foreignKeysSection, foreignKeyRows(structure.foreignKeys));
}
```

### `StructurePanel` — the Columns tools read `_columns` lazily

`buildColumnsTools` currently closes over the `columns` array passed at construction, which `reload` replaces — a captured array would leave Alter/Drop resolving a selected row against the pre-refresh column list. Its first parameter becomes a getter:

```ts
function buildColumnsTools(currentColumns: () => ColumnMeta[], grid: Table, actions: StructureActions): Button[]
```

called from the section config as `buildColumnsTools(() => this._columns, columnsGrid, actions)`, and internally as `selectedColumn(currentColumns(), grid)`. `this._columns` is assigned immediately after `super()` returns, before the accordion is built, so the getter is valid from the first click.

### The five refresh closures

Each lives inside its `open*` method's async body, before the `_openPanels.set(...)` that registers it.

```ts
// openStructure
const refresh = (): void => void this.refreshPanel(ref, async () => {
    const [freshColumns, freshStructure] = await Promise.all([getColumns(ref), getStructure(ref)]);
    const entry = this._openPanels.get(id);

    panel.reload(freshColumns, freshStructure);

    // structureColumns(ref) reads this cache to build the constraint/index
    // dialogs' column checklists — it must track the refreshed columns.
    if (entry) {
        entry.columns = freshColumns;
    }
});

// openDefinition
const refresh = (): void => void this.refreshPanel(ref, async () => {
    const [freshDefinition, freshColumns] = await this.fetchDefinitionAndColumns(ref);

    panel.reload(freshDefinition, freshColumns);
});

// openFunctionDefinition
const refresh = (): void => void this.refreshPanel(ref, async () => {
    panel.reload((await getFunctionDefinition(ref, signature)).definition);
});

// openSequence
const refresh = (): void => void this.refreshPanel(ref, async () => {
    panel.reload(await getSequenceDetail(ref));
});

// openIndex
const refresh = (): void => void this.refreshPanel(ref, async () => {
    panel.reload(await getIndexDetail(ref));
});
```

`openStructure`, `openSequence`, and `openIndex` currently `return` their panel expression directly; each needs a forward-declared `let panel: X;` assigned just before the `return`, matching what `openDefinition` ([`SqlAdminController.ts:522`](frontend/src/SqlAdminController.ts#L522)) and `openFunctionDefinition` ([`:1283`](frontend/src/SqlAdminController.ts#L1283)) already do.

---

## Ordered Implementation Steps

1. **Create `frontend/tests/dock/structureRows.test.ts`** with the `constraintRows` / `foreignKeyRows` cases from `## Expected Behaviour` (cases 1–4). Red: the module does not exist yet.

2. **Create `frontend/src/dock/structureRows.ts`** exporting `ConstraintRow`, `ForeignKeyRow`, `constraintRows`, `foreignKeyRows`. Bodies are the existing `.map(...)` expressions at [`StructurePanel.ts:351-356`](frontend/src/dock/StructurePanel.ts#L351) and [`:392-400`](frontend/src/dock/StructurePanel.ts#L392), lifted verbatim. Import types from `../contract` only — no library import, so the node vitest harness can load it. Head the file with a comment saying it is the DOM-free row mapping kept out of `StructurePanel.ts` (mirroring `columnSequence.ts`'s own header). Check: `cd frontend && npx vitest run tests/dock/structureRows.test.ts` — green.

3. **`frontend/src/dock/definitionEditor.ts`** — add `refresh` to the glyph import and to `Glyph.register` (line 19). Add a third constructor parameter `onRefresh: () => void` with a JSDoc `@param`. Change the toolbar to `new ToolBar({ components: [this._saveButton, glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", onRefresh)] })`. Update the class doc's "the NORTH toolbar's single Save button" phrasing to name both buttons.

4. **`frontend/src/dock/FunctionDefinitionPanel.ts`** — add a third constructor parameter `onRefresh: () => void` (JSDoc: re-fetches the routine's definition and reseeds the editor, discarding unsaved edits) and pass it as `new DefinitionEditor(definition, onSave, onRefresh)`.

5. **`frontend/src/dock/DefinitionPanel.ts`** — add a fourth constructor parameter `onRefresh: () => void` **before** `layout`, with the same JSDoc shape, and pass it to `new DefinitionEditor(definition, onSave, onRefresh)`.

6. **`frontend/src/dock/IndexInfoPanel.ts`** — add `onRefresh: () => void` to `IndexInfoPanelDeps`. Import `Glyph` from `@jimka/typescript-ui/component/display`, `ToolBar` from `@jimka/typescript-ui/component/menubar`, `glyphButton` from `./glyphButton`, `PRIMARY_COLOR` from `../theme`, and the `refresh` glyph; add a `Glyph.register(refresh)` call. Hold the `Link`, the two `Text` rows, the `CodeEditor`, and `detail` as fields; change the link's listener to `() => deps.onOpenTable(deps.schema, this._detail.table)` so a refreshed detail is what it opens. That arrow is built before `super()` (this panel constructs its children as pre-`super()` locals), which is safe because it only *evaluates* `this` when clicked — the same shape as `SequenceInfoPanel.ts:204`'s Save handler; see `COMPONENT_CONVENTIONS.md` (b). Restructure the body: root `Container`/`Border` gets the `ToolBar` NORTH and a nested `Container({ layoutManager: new BorderLayout({ spacing: 0 }) })` CENTER holding the fieldset NORTH and the editor CENTER. Add `reload(detail: IndexDetail): void` reseeding all four widgets. Update the class doc — it currently states the tab "has no Save toolbar", which stays true, but it must no longer imply there is no toolbar at all.

7. **`frontend/src/dock/SequenceInfoPanel.ts`** — add `onRefresh: () => void` to `SequenceInfoPanelDeps` (JSDoc: re-fetch the detail and reseed the form, discarding unsaved edits). Add `refresh` to the glyph import and `Glyph.register`. Build `const refreshButton = glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", () => deps.onRefresh());` beside `saveButton` (line 204) and pass `components: [saveButton, refreshButton]`. Add public `reload(detail: SequenceDetail): void` holding the four statements currently at lines 337-340, and reduce `handleSuccess` to `this.reload(await this._deps.reloadDetail());` followed by its existing `onStatus` call.

8. **`frontend/src/dock/StructurePanel.ts`** — the largest change, in this order:
   a. Imports: add `Container` to the core import, `Border as BorderLayout` to the layout import, `Placement` from `@jimka/typescript-ui/primitive`, `ToolBar` from `@jimka/typescript-ui/component/menubar`, `MemoryStore` is already imported, `glyphButton` is already imported, `toColumnRows` from `./columnSequence`, `constraintRows`/`foreignKeyRows` from `./structureRows`, the `refresh` glyph, and add `refresh` to the `Glyph.register` call at line 73.
   b. Add the `StructureGrid` interface and the module-level `reseed` helper.
   c. Change `buildIndexesGrid`, `buildConstraintsGrid`, and `buildForeignKeysGrid` to return `StructureGrid` (`return { grid, store };`), and have the latter two build their rows via `constraintRows(...)` / `foreignKeyRows(...)`.
   d. Update the four construction sites in the constructor to hold whole sections rather than bare grids — this is where the return-type change from (c) lands, and every use of the old `…Grid` locals must follow:
      - `const columnsSection = buildColumnsGrid(columns, onOpenSequence);` (drop the trailing `.grid` at line 129, which currently discards the store), and the same shape for `indexesSection`, `constraintsSection`, `foreignKeysSection`.
      - The `setPreferredSize` loop (line 137) becomes `for (const section of [columnsSection, indexesSection, constraintsSection, foreignKeysSection]) { section.grid.setPreferredSize({ width: 0, height: SECTION_HEIGHT }); }`.
      - Each `AccordionPanel` section config takes `component: <name>Section.grid`, and each `tools:` call passes `<name>Section.grid`.
   e. Change `class StructurePanel extends Panel` to `extends Container`. `super(...)` stays the constructor's first statement, as today, and becomes `super({ layoutManager: new BorderLayout({ spacing: 0 }) })` — nothing else is passed into it, so no child needs hoisting above it. After `super()`, build `const scrollHost = Panel({ layoutManager: new VBox({ stretching: true }), autoScroll: "auto" });` and `const toolbar = new ToolBar({ components: [glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", onRefresh)] });`, keep the existing grid/accordion construction, then `scrollHost.addComponent(accordion, constraints)` (the existing weight-1 `LayoutConstraints`), `this.addComponent(toolbar, { placement: Placement.NORTH })`, `this.addComponent(scrollHost, { placement: Placement.CENTER })`.
   f. Add the `onRefresh: () => void` parameter in 5th position. Assign `this._columns = columns;` immediately after `super()`, before the accordion is built; assign the four `_…Section` fields from the (d) locals.
   g. Change `buildColumnsTools`'s first parameter to `currentColumns: () => ColumnMeta[]` and its two `selectedColumn(columns, grid)` calls to `selectedColumn(currentColumns(), grid)`; pass `() => this._columns` at the call site.
   h. Add `reload(columns, structure)` per `## Internal Structure`.
   i. Update the class doc's last paragraph — it currently reads "the panel `extends Panel` (the scroll host) and holds the AccordionPanel as its sole weighted child" — to describe the `Container`/`Border` root, the NORTH Refresh toolbar, and the CENTER scroll host, and note that the 4px content inset now comes from the inner `Panel` rather than the root.

9. **`frontend/src/SqlAdminController.ts` — `OpenPanel`** (line 175): add `refresh?: () => void;` with a comment saying it is set only by the five non-store detail tabs and is what `refreshActive` dispatches to.

10. **`frontend/src/SqlAdminController.ts` — `refreshPanel`**: add the private helper from `## Internal Structure`, placed directly after `fetchDefinitionAndColumns` ([line 598](frontend/src/SqlAdminController.ts#L598)).

11. **`frontend/src/SqlAdminController.ts` — `refreshActive`** (line 2838): insert the `entry?.refresh` branch ahead of the store branch and rewrite the doc comment — it currently says the method is a no-op for "a query, a role's grants, a structure/definition tab", which the change makes false for the five tabs.

12. **`frontend/src/SqlAdminController.ts` — `openStructure`** (line 725): add `let panel: StructurePanel;`, the `refresh` closure, `refresh` in the `_openPanels.set(...)` payload, `refresh` as the 5th argument to `StructurePanel(...)`, and assign-then-return `panel`. Also extend `structureColumns`'s doc ([line 1490](frontend/src/SqlAdminController.ts#L1490)) — the cache is now "populated by `openStructure` and kept current by its Refresh".

13. **`frontend/src/SqlAdminController.ts` — `openDefinition`** (line 501): add the `refresh` closure after `onSave`, pass it as the 4th argument to `new DefinitionPanel(...)`, and add `refresh` to the `_openPanels.set(...)` payload.

14. **`frontend/src/SqlAdminController.ts` — `openFunctionDefinition`** (line 1258): same, passing `refresh` as the 3rd argument to `new FunctionDefinitionPanel(...)`.

15. **`frontend/src/SqlAdminController.ts` — `openSequence`** (line 621): add `let panel: SequenceInfoPanel;`, the `refresh` closure, `onRefresh: refresh` in the deps bag, `refresh` in the `_openPanels.set(...)` payload, and assign-then-return `panel`.

16. **`frontend/src/SqlAdminController.ts` — `openIndex`** (line 686): same as step 15, with `IndexInfoPanel` and `onRefresh: refresh` in its deps bag.

17. **`frontend/src/SqlAdminController.ts` — the dock `"focus"` handler** (line 351): add an `else { this._activePanelId = null; }` branch so a closed-last-tab state cannot leave Alt+R pointing at a destroyed panel.[^clear-active-on-null-focus]

18. **Regression checks**: `grep -n 'extends Panel' frontend/src/dock/StructurePanel.ts` — expect zero matches. `grep -rn 'new DefinitionEditor(' frontend/src/` — expect two matches, both three-argument. `grep -rn 'refreshTool\|bindRefreshShortcut' frontend/src/dock/` — expect zero matches (the dock never uses the rail helpers).

19. **`README.md`** — extend the "Structure & definitions" highlight bullet per `## Documentation Impact`.

20. **Manual verification** — per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/structureRows.ts` |
| Create | `frontend/tests/dock/structureRows.test.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` |
| Modify | `frontend/src/dock/DefinitionPanel.ts` |
| Modify | `frontend/src/dock/FunctionDefinitionPanel.ts` |
| Modify | `frontend/src/dock/SequenceInfoPanel.ts` |
| Modify | `frontend/src/dock/IndexInfoPanel.ts` |
| Modify | `frontend/src/dock/definitionEditor.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `README.md` |

---

## Expected Behaviour

### Unit-testable (`frontend/tests/dock/structureRows.test.ts`)

1. `constraintRows` joins `columns` with `", "` and passes `name`, `type`, and `definition` through unchanged — the `orders_pkey` row in the `## Architecture Decisions` table.
2. `constraintRows` maps an empty `columns` array to `""`, not `"—"` or `undefined` — the table-level `chk_total` row.
3. `foreignKeyRows` joins both `columns` and `refColumns` with `", "` and passes `refSchema`, `refTable`, `onUpdate`, and `onDelete` through unchanged — the `fk_o_c` row.
4. Both functions return `[]` for `[]`.

### Manual verification (UI, focus, and network — outside the node vitest harness)

5. **Structure tab.** Open a table's Structure tab. The tab now shows a one-button toolbar above the accordion, with a glyph-only Refresh button. Add a column to the table from another client, click Refresh: the Columns section shows the new column without the tab closing, reopening, or moving in the tab strip. The Indexes, Constraints, and Foreign Keys sections re-read from the same click.
6. **Structure tab, open sections preserved.** Expand Constraints, collapse Columns, click Refresh: the open/collapsed state is unchanged.
7. **Structure tab, selection cleared.** Select a row in Columns, click Refresh: the selection clears and the Alter/Drop header tools return to disabled.
8. **Structure tab, DDL dialogs see refreshed columns.** After a Refresh that added a column, open the Constraints section's "Add constraint ▸ Unique" dialog: the new column appears in its column checklist.
9. **Index tab.** Open an index's info tab. It now has a toolbar above the fieldset. Click Refresh: the definition, Unique, Primary, and Table rows re-read; the tab stays open.
10. **View definition tab.** Open a view's Definition tab, type an edit into the editor (Save enables), click Refresh: the editor reverts to the server's definition with no prompt, and Save disables again. The Columns grid re-reads too.
11. **Function definition tab.** Same as case 10, without a Columns grid.
12. **Sequence tab.** Open a sequence's info tab, change Increment (Save enables), click Refresh: every field reseeds from the server and Save disables.
13. **Success message.** Any successful Refresh writes `<database> · <object name>: refreshed` to the status bar.
14. **Failure leaves the tab alone.** Drop the object from another client, then click Refresh: an error toast reading `<name>: failed to refresh: <detail>` appears, the status bar shows the error, and the tab stays open still showing its last-good data. Contrast the open-time fetch failure, which closes the tab.
15. **Alt+R.** With any of the five tabs focused — including with the caret inside a definition `CodeEditor` — Alt+R performs the same Refresh as the button.
16. **View → Refresh.** The menu bar's View → Refresh item does the same on all five tabs.
17. **Data grid unaffected.** With a table's data tab focused, Alt+R still discards pending edits and reloads the store, and the status bar still reports `<database> · <object name>: refreshed`.
18. **No open tab.** Close every tab, press Alt+R: nothing happens and no error appears.

---

## Verification

- `cd frontend && npm run typecheck` — clean. Every changed constructor has exactly one call site, all in `SqlAdminController.ts`; a missed one surfaces here as an arity error.
- `cd frontend && npm test` — the new `structureRows.test.ts` green, the rest of the suite unchanged (`menuItems.test.ts` imports only the `StructureActions` *type* from `StructurePanel.ts`, which is untouched).
- `grep -rn 'new DefinitionEditor(' frontend/src/` — two matches, both passing three arguments.
- Manual smoke per `## Expected Behaviour` cases 5-18. Entry point: the navigator's WEST sidebar against the seeded demo database — any indexed table (e.g. `sales.products`) for the Structure and Index tabs, any seeded view or materialized view for the definition tab, any `*_id_seq` for the sequence tab, and any function under a schema's Functions category for the function tab. Cases 5, 8, and 14 need a second client (a SQL workspace tab in the same session is enough) to change the object behind the tab's back.

---

## Documentation Impact

- **`README.md`** — the "Structure & definitions" highlight currently reads "inspect columns, view a view's definition, and read a table's `GRANT`s." Extend it to note that each inspector tab has a Refresh button (also Alt+R) that re-reads the object from the database. No other bullet mentions these tabs.
- **`frontend/src/shell/shortcutRegistry.ts`** — no change. Its Alt+R entry already reads "Refresh the active view", which stays accurate and simply covers more tabs; `tests/shell/shortcutRegistry.test.ts` asserts only the id and key list.
- **`TODO.md`** — no backlog bullet mentions refresh (grepped), so nothing to rewrite or retire.
- **`CHANGELOG.md`** — no entry; written at release time, not in feature work (established by `plans/implemented/table-local-filter.md`).

---

## Potential Challenges

- **`selectRecord(null)` may not emit `"selection"`.** If it does not, a section's Alter/Drop tools could stay visually enabled after a Refresh. They are already guarded (`if (record)` / `if (column)` in each handler), so a click is a harmless no-op rather than a wrong-target DDL. Manual case 7 is the check; if it fails, gate the buttons off `grid.getSelectedRecord()` inside the handlers rather than adding an event workaround.
- **`IndexInfoPanel`'s NORTH placement is already taken** by its fieldset. Rather than add a second component at the same `Border` placement, step 6 moves the fieldset into a nested `Border` in CENTER — the shape `DefinitionPanel` already uses (toolbar NORTH of `content`, body CENTER).
- **Losing the root `Panel`'s content inset.** `Container` has no inset while `Panel` defaults to 4px (`COMPONENT_CONVENTIONS.md` (a)). `StructurePanel`'s inset must move to the inner scroll-host `Panel`, or the accordion will sit flush against the tab edge. Step 8e keeps the `Panel` for exactly this reason.
- **Refreshing a renamed or dropped object.** The tab is keyed by the object's name, so after a rename the re-fetch 404s. That surfaces as `failed to refresh: <backend detail>` and the tab keeps its last-good contents — the intended outcome, not a bug to guard against.
- **A definition tab's Save baseline after Refresh.** `DefinitionEditor.reload` sets `_baseline` before `setValue`, so `syncDirty` sees a clean editor and disables Save. Any change to that ordering silently leaves Save enabled on unmodified text.

---

## Critical Files

- [`frontend/src/dock/TableWorkPanel.ts:70`](frontend/src/dock/TableWorkPanel.ts#L70) and [`:166`](frontend/src/dock/TableWorkPanel.ts#L166) — the existing dock-tab Refresh button and its glyph registration; the precedent every new button copies.
- [`frontend/src/dock/SequenceInfoPanel.ts:201-226`](frontend/src/dock/SequenceInfoPanel.ts#L201) — the `Container`/`Border` root + `ToolBar` NORTH + `autoScroll` `Panel` CENTER shape `StructurePanel` adopts, and (line 204) the pre-`super()` arrow that reads `this` only at click time, which `IndexInfoPanel`'s table link copies.
- [`frontend/src/dock/definitionEditor.ts`](frontend/src/dock/definitionEditor.ts) — the shared toolbar both definition panels mount, and the `_baseline`/`syncDirty` gating a Refresh resets.
- [`frontend/src/dock/columnsGrid.ts:24`](frontend/src/dock/columnsGrid.ts#L24) and [`frontend/src/dock/columnSequence.ts`](frontend/src/dock/columnSequence.ts) — the `{ grid, store }` reseed-handle idiom and the DOM-free row-mapping module `structureRows.ts` mirrors.
- [`frontend/src/SqlAdminController.ts:2838`](frontend/src/SqlAdminController.ts#L2838) — `refreshActive`, the single dispatcher behind both Alt+R and View → Refresh.
- [`frontend/src/SqlAdminController.ts:559-575`](frontend/src/SqlAdminController.ts#L559) — the post-save re-fetch whose error wording (`saved, but failed to refresh the tab: …`) the new `failed to refresh: …` message is modelled on.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — sections (b) (super-cascade: locals before `super()`, fields after) and (d) (the instance is the component) govern `StructurePanel`'s and `IndexInfoPanel`'s restructuring.

---

## Non-Goals

- **Reworking `refreshStructure`** ([`SqlAdminController.ts:1511`](frontend/src/SqlAdminController.ts#L1511)). Its remove-and-reopen is still the right shape for its post-DDL callers, where the tab's toolbar wiring may itself be stale. It keeps working unchanged, alongside the new in-place path.
- **Catching `handleSuccess`'s rejection** in `SequenceInfoPanel`. Its `void this.handleSuccess()` can already leak an unhandled rejection when the post-save re-fetch fails; that is pre-existing and independent of Refresh, which routes through `refreshPanel`'s own `try`/`catch`.
- **Deleting `_openPanels` entries when a tab closes.** Entries are deliberately kept as a column cache read after close ([`SqlAdminController.ts:2597`](frontend/src/SqlAdminController.ts#L2597)); step 17's null-focus guard is the targeted fix instead.
- **A confirmation prompt or a dirty-disabled Refresh** on the three editable tabs — see the discard decision.
- **Auto-refresh, polling, or refreshing on tab focus.** Refresh stays an explicit user action.
- **A Refresh button on any other tab.** Query, diagram, dependency, inheritance, role-grants, and documentation tabs are out of scope.

---

## Notes

[^in-place-not-reopen]: The alternative was to reuse `refreshStructure` ([`SqlAdminController.ts:1511`](frontend/src/SqlAdminController.ts#L1511)), which removes the panel and re-runs `openStructure`. It was rejected on three counts: it would destroy the panel from inside its own button's click handler; the reopened tab is appended to the end of the tab strip, so the tab the user is looking at visibly jumps; and it silently no-ops when the entry has no navigator `node`, which happens for a tab opened from a foreign-key or "Owned by column" link. In-place reload also matches what the other four panels need anyway — two of them (`DefinitionPanel`, `FunctionDefinitionPanel`) already have a `reload` doing exactly this after a Save.

[^glyph-button-not-refresh-tool]: `refreshTool` ([`frontend/src/shell/refreshTool.ts:17`](frontend/src/shell/refreshTool.ts#L17)) also produces a Refresh button, but its own header documents it as an accordion *section header* tool, and its three call sites are all sidebar rails (`treeExplorerView.ts`, `QueriesView.ts`). `glyphButton`'s header states it is the shared face for "the dock work panels … whose toolbars all build their actions this way", with "one owner, so the three variants cannot drift apart in a toolbar that mixes them" — and four of the five new buttons sit in a toolbar beside a `glyphButton` Save. `refreshTool` omits `showDescription: false`, so mixing the two would be precisely that drift. The two glyph aliases (`refresh` and `arrows-rotate`) resolve to byte-identical SVG paths in the library, so the choice is naming, not appearance.

[^route-through-refresh-active]: The alternative was `bindRefreshShortcut(this, onRefresh)` ([`refreshTool.ts:33`](frontend/src/shell/refreshTool.ts#L33)) on each panel, which scopes Alt+R to the focused subtree. It was rejected because it fixes only the keyboard chord: the menu bar's View → Refresh item ([`SqlAdminShell.ts:407`](frontend/src/shell/SqlAdminShell.ts#L407)) calls `controller.refreshActive()` directly and would keep no-opping on these tabs, leaving the menu item and its own advertised shortcut doing different things. Routing through `refreshActive` fixes both from one place, needs no per-panel keyboard wiring, and reuses the `_openPanels` registry the controller already keeps per tab. The document-level accelerator reaches these tabs even while a `CodeEditor` has focus: it is a bubble-phase `document` listener and the library's dispatcher only stops propagation when a focused component actually consumed the key (`SqlAdminShell.ts:153-156`).

[^structure-toolbar-not-section-tool]: Hanging `refreshTool` off an `AccordionSectionConfig`'s `tools` slot — the shape `treeExplorerView.ts:91` uses — was rejected because all four sections are seeded from a single `getColumns` + `getStructure` fetch, so one Refresh necessarily reloads all four. Putting it on one section would imply it refreshes only that facet; putting it on all four would fire four redundant, identical fetches. The section `tools` slots are already spoken for by per-facet add/alter/drop launchers, which genuinely are section-scoped. A whole-tab action belongs in a whole-tab toolbar, which is what every other dock work panel has.

[^discard-silently]: This matches the data grid's Refresh, which runs `store.reject(); void store.load();` with no prompt ([`TableWorkPanel.ts:166`](frontend/src/dock/TableWorkPanel.ts#L166)), and `refreshActive`'s own doc, which describes "discarding a table's unsaved edits first" as the intended contract. Keeping Refresh enabled while dirty is the point: an edit the user wants to abandon is exactly when Refresh is most useful, and a Refresh that disables itself the moment you touch the editor is a button that stops working when you need it. A confirmation dialog was rejected for the same reason it was rejected on the data grid — it would make the app's two Refresh buttons behave differently for no gain.

[^one-helper]: Five call sites, one identical outcome contract: the same success wording, the same error wrapping, and the same "leave the tab open on failure" rule. Inlining it five times is where those three drift apart — the codebase already has two hand-written copies of the neighbouring post-save message. The precedent for a small private controller helper backing one concern is `fetchDefinitionAndColumns` ([`SqlAdminController.ts:598`](frontend/src/SqlAdminController.ts#L598)), which exists for a single panel's two fetch sites. What deliberately stays inline is the per-panel fetch body itself: each of the five fetches a different thing and calls a differently-shaped `reload`, so there is nothing common there to hoist.

[^structure-rows-module]: `reload` has to re-derive the constraint and foreign-key display rows from fresh metadata, so the mapping needs to be callable from two places instead of one. `columnSequence.ts` is the settled answer to that in this codebase: its header says it is "kept out of `columnsGrid.ts` so it can be unit-tested under the node vitest harness without touching the DOM", and `columnsGrid.ts` points back at it. `StructurePanel.ts` runs `Glyph.register(...)` at import scope, so anything left inside it is unreachable from the node test harness (`vitest.config.ts` sets `environment: "node"`, and the repo's convention is that DOM components are manual-verify while their pure logic is unit-tested). The Indexes grid needs no such helper — `IndexMeta` is already flat and is passed to the store as-is.

[^clear-active-on-null-focus]: `_activePanelId` is only ever assigned on a non-null `"focus"` payload, so closing the last tab leaves it naming a destroyed panel; Alt+R would then invoke a refresh closure holding a torn-down panel. Clearing it is safe because the library emits `focus(null)` only from `recomputeFocusAfterClose`, when no frame remains — never when DOM focus merely leaves the dock — so the Query-menu's export targeting, the other reader of `_activePanelId`, is unaffected. The guard also makes the pre-existing store path (`store.load()` on a closed data tab) correct.
