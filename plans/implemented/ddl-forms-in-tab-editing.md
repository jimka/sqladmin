---
depends-on: [dialog-subclass-foundation]
touches-shared:
  - frontend/src/SqlAdminController.ts
  - frontend/src/dock/SqlPreviewDialog.ts
  - frontend/src/dock/ImportRowsDialog.ts
  - frontend/src/dock/CreateTableForm.ts
  - frontend/src/dock/EnumTypeForm.ts
  - frontend/src/dock/CompositeTypeForm.ts
  - frontend/src/dock/FunctionForm.ts
  - frontend/src/dock/AddEnumValueForm.ts
  - frontend/src/dock/ConfirmCascadeForm.ts
  - frontend/src/dock/SchemaDdlForms.ts
  - frontend/src/dock/SequenceDdlForms.ts
  - frontend/src/dock/ViewFormDialog.ts
  - frontend/src/dock/MaterializedViewFormDialog.ts
  - frontend/src/dock/RelationDdlActions.ts
  - frontend/src/dock/ddlSpecs.ts
  - frontend/COMPONENT_CONVENTIONS.md
---

# DDL Creation Forms Move Into Tabs — Implementation Plan

## Overview

Creating a database object today happens entirely inside one modal. The
navigator's "Create ▸ Table" builds a `CreateTableForm` and hands it straight to
`openSqlPreviewDialog` as that dialog's `form` slot
([`SqlAdminController.ts:1062-1073`](frontend/src/SqlAdminController.ts#L1062)),
so the structured form, the generated-SQL editor and Execute all share a single
`Dialog` ([`SqlPreviewDialog.ts:154-157`](frontend/src/dock/SqlPreviewDialog.ts#L154)).
The dialog also runs `generateSql` against the still-empty form as it opens, so
every creation dialog appears with its error banner already showing.

Editing an *existing* object does not work that way: a table's Structure tab
edits its columns in place and only opens `SqlPreviewDialog` when Save is pressed
([`StructurePanel.ts:295-328`](frontend/src/dock/StructurePanel.ts#L295)), and a
sequence's info tab does the same
([`SequenceInfoPanel.ts:303-339`](frontend/src/dock/SequenceInfoPanel.ts#L303)).

This plan makes creation work the way editing already does. Each of the eight
creation flows — table, view, materialized view, schema, sequence, enum type,
composite type, function — opens a **dock tab** holding its form, with one
toolbar tool that opens the SQL review dialog. The composite-type *recreate*
path (`editType`'s composite branch) follows the same route, because it reuses
the same form. Drops, renames and refreshes stay dialogs.

Underneath, three shared pieces land first. `RowGridPanel` absorbs the
add/remove-row grid that `CreateTableForm`, `EnumTypeForm`, `CompositeTypeForm`
and `FunctionForm` each carry a private copy of — and fixes a live leak in all
four at once: every one of them detaches a removed row with `removeComponent`
and never disposes it. `DdlFormPanel` is the tab host. And the two incompatible
launcher wiring conventions collapse into one: every form module exports only
its form class, and `SqlAdminController` does the wiring.

Alongside, four smaller defects in the same files: `RelationDdlActions`'s
private copy of `ConfirmCascadeForm`, `ImportRowsDialog`'s hand-rolled copy of
`readOnlyTable()`, `refreshStructure` closing the Structure tab without
reopening it, and two spec-builder branches with no production caller. Three
stale module comments — in `ImportRowsDialog.ts`, `ConfirmCascadeForm.ts` and
`ddlSpecs.ts` — are corrected at the end.

---

## Architecture Decisions

### A creation form lives in a tab; only the SQL review stays a dialog

Each creation flow opens a `DdlFormPanel` tab whose toolbar carries one tool,
`Review SQL…`, that opens `openSqlPreviewDialog`. That arrangement mirrors
[`SequenceInfoPanel.ts:139-248`](frontend/src/dock/SequenceInfoPanel.ts#L139)
exactly: a `Container` under a `Border` layout, a `ToolBar` in the NORTH
region, and the form in a `Panel({ layoutManager: new VBox(), autoScroll: "auto" })`
in the CENTER region.[^tab-precedent]

### The review dialog shows SQL only, not the form again

`SqlPreviewDialogOptions.form` becomes optional. A tab-hosted flow omits it, so
the dialog is the editable SQL preview, the `Regenerate SQL` button, and
Cancel/Execute. A component has one parent, so the live form cannot be mounted
in both places; and for a `CREATE` the generated SQL already says everything the
form does.[^no-form-in-dialog]

### One launcher convention: form modules export a form class, the controller wires it

Every `open*Dialog` wrapper function and every `*DialogDeps` interface in
`frontend/src/dock/` is deleted. Each form module exports only its form class
through the `callable()` wrapper, exactly as `CreateTableForm`, `ConstraintForm`,
`IndexForm` and `ConfirmCascadeForm` already do. `SqlAdminController` builds the
form and calls either `openDdlPanel` (creation) or `openSqlPreviewDialog`
(everything else).[^one-convention]

Two private controller helpers absorb what those wrappers were carrying:
`ddlDefaults(ref)` returns the `execute`/`onError` pair repeated at every DDL
call site, and `fetchSchemaNames(ref)` replaces the three copies of the
schema-list preamble.

### `RowGridPanel` disposes removed rows

The shared base's `removeRow` calls `removeComponent(cell)` **and then**
`cell.dispose()` for every cell in the row. `removeComponent` only unwires and
detaches — it never disposes — so all four current copies orphan a row's
`TextField`s and its remove `Button` (with a live `"action"` listener) on every
removal.[^remove-does-not-dispose]

### `RowGridPanel` is `abstract` and not `callable()`-wrapped

`COMPONENT_CONVENTIONS.md` section (d) asks that a class-first component be
exported through `callable()` so call sites can construct it without `new`.
`RowGridPanel` is never constructed as a value — only `extends`-ed — so it is a
plain `export abstract class` instead. Its four subclasses keep their existing
`callable()` exports.[^abstract-base]

### A draft tab is deduped by target, and is not in the panel registry

`openDdlPanel` dedupes on a panel id built from connection, database, schema,
object name and a per-flow slug, so re-launching the same creation focuses the
in-progress draft rather than replacing it with a blank one. Draft tabs are
**not** registered in `_openPanels` and carry no route, matching how `openQuery`
([`SqlAdminController.ts:2540-2586`](frontend/src/SqlAdminController.ts#L2540))
and `openDocumentation` ([`:1773-1788`](frontend/src/SqlAdminController.ts#L1773))
already handle a tab with no `DbObjectRef` behind it.[^no-registry]

The id rule — schema and name both contribute, blank when absent:

| Launch | `ref` | slug | Panel id |
|---|---|---|---|
| Create table in `public` | `{schema: "public", kind: "schema"}` | `table` | `default/sqladmin/public/::ddl-table` |
| Create enum type in `public` | `{schema: "public", kind: "schema"}` | `enum-type` | `default/sqladmin/public/::ddl-enum-type` |
| Create composite type in `public` | `{schema: "public", kind: "schema"}` | `composite-type` | `default/sqladmin/public/::ddl-composite-type` |
| Recreate composite `public.addr` | `{schema: "public", name: "addr", kind: "type"}` | `composite-type` | `default/sqladmin/public/addr::ddl-composite-type` |
| Create schema in `sqladmin` | `{database: "sqladmin", kind: "database"}` | `schema` | `default/sqladmin//::ddl-schema` |

Enum and composite creation both target a *type*, so the slug — not the object
kind — is what keeps their two drafts apart. Create-schema is passed a
database-scoped ref it synthesizes, so the same draft is focused however many
different schema nodes it is launched from.[^database-scoped-schema]

### `refreshStructure` reseeds the tab instead of closing and reopening it

`refreshStructure(ref)` becomes a call to the in-place `refresh` closure
`openStructure` already registers
([`SqlAdminController.ts:939-950`](frontend/src/SqlAdminController.ts#L939)).
The current body removes the panel and reopens it only when the registry holds a
navigator node, so a Structure tab opened from a deep link — which stores
`node: null` — is closed and never comes back when a constraint or index is
added or dropped.[^refresh-structure]

### The two drop spec-builders get wired instead of deleted

`buildConstraintSpec`'s `"drop"` case
([`ddlSpecs.ts:330-331`](frontend/src/dock/ddlSpecs.ts#L330)) and
`buildIndexSpec`'s drop path ([`:371-376`](frontend/src/dock/ddlSpecs.ts#L371))
have no production caller — `dropConstraint` and `dropIndex` build the same
literals inline. The controller is pointed at the builders, which removes the
controller-side copy as well as the dead branch.[^wire-not-delete]

The one observable difference is behaviour-preserving: the builders omit
`cascade` when it is false, where the inline literal spells out `cascade: false`.

| Form state | Inline literal today | Builder output | Backend reads |
|---|---|---|---|
| CASCADE unchecked | `{…, cascade: false}` | `{…}` | `spec.get("cascade", False)` → `False` |
| CASCADE checked | `{…, cascade: true}` | `{…, cascade: true}` | `True` |

---

## Public API

### `frontend/src/dock/RowGridPanel.ts` (new)

```ts
import { Panel }        from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import type { GridTrack } from "@jimka/typescript-ui/layout";
import { Button }       from "@jimka/typescript-ui/component/button";

/** One built row of an add/remove-row grid. */
export interface RowGridRow<TRow> {
    /**
     * The row's grid cells, one per column track, in display order. MUST
     * include `removeButton` — the base disposes every cell on removal, and a
     * button left out of this array would be orphaned.
     */
    cells: Component[];
    /** Snapshot the row's current values. */
    read: () => TRow;
    /** The row's remove button. The base disables it while it is the only row. */
    removeButton: Button;
}

/** Construction inputs for {@link RowGridPanel}. */
export interface RowGridPanelOptions<TRow> {
    /** Components stacked above the Add button, in order (typically a name field). */
    header: Component[];
    /** The Add button's face text, e.g. `"Add column"`. */
    addLabel: string;
    /** The row grid's column tracks. Its length is the grid's column count. */
    columnTracks: GridTrack[];
    /**
     * Build one row. `onRemove` is already wired to the base's removal path;
     * the factory must register it on the row's remove button.
     */
    buildRow: (onRemove: () => void, prefill?: TRow) => RowGridRow<TRow>;
}

export abstract class RowGridPanel<TRow> extends Panel {
    protected constructor(options: RowGridPanelOptions<TRow>);

    /** Every row's current values, in display order. */
    protected readRows(): TRow[];

    /** Append a row, optionally pre-filled. Call from a subclass constructor to seed. */
    protected appendRow(prefill?: TRow): void;
}
```

### `frontend/src/dock/DdlFormPanel.ts` (new)

```ts
import type { Component }         from "@jimka/typescript-ui/core";
import type { QueryStatusResult } from "../contract";

/** The execute + error-report pair every DDL flow wires identically. */
export interface DdlExecuteDeps {
    /** Execute the (possibly hand-edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;
    /** Report a preview/execute error. */
    onError: (message: string) => void;
}

/** A DDL draft's live form plus the SQL generator that reads it. */
export interface DdlDraft {
    form: Component;
    generateSql: () => Promise<string>;
}

/** Construction inputs for {@link DdlFormPanel}. */
export interface DdlFormPanelOptions extends DdlExecuteDeps, DdlDraft {
    /** Title of the SQL review dialog the panel's `Review SQL…` tool opens. */
    reviewTitle: string;
    /** Run after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;
}

class DdlFormPanel extends Container {
    constructor(options: DdlFormPanelOptions);
}

const DdlFormPanelCallable = callable(DdlFormPanel);
type  DdlFormPanelCallable = DdlFormPanel;
export { DdlFormPanelCallable as DdlFormPanel };
```

### `SqlPreviewDialogOptions` (changed)

```ts
/**
 * The phase's structured form, hosted above the SQL preview editor. Omitted by
 * a tab-hosted flow, whose form stays in its own dock tab (see DdlFormPanel):
 * the dialog is then the SQL preview alone.
 */
form?: Component;
```

### Form modules (changed exports)

"Deleted" covers module-private members as well as exports.

| Module | Exported after this plan | Deleted |
|---|---|---|
| `SchemaDdlForms.ts` | `CreateSchemaForm`, `RenameSchemaForm` | `openCreateSchemaDialog`, `openDropSchemaDialog`, `openRenameSchemaDialog`, `CreateSchemaDialogDeps`, `DropSchemaDialogDeps`, `RenameSchemaDialogDeps` |
| `SequenceDdlForms.ts` | `CreateSequenceForm` | `openCreateSequenceDialog`, `openDropSequenceDialog`, `CreateSequenceDialogDeps`, `DropSequenceDialogDeps` |
| `ViewForm.ts` (renamed) | `ViewForm` | `openViewDialog`, `ViewDialogDeps` |
| `MaterializedViewForm.ts` (renamed) | `MaterializedViewForm` | `openMaterializedViewDialog`, `MatviewDialogDeps` |
| `RefreshMatviewForm.ts` (renamed) | `RefreshMatviewForm` | `openDropRelationDialog`, `openRefreshMatviewDialog`, `DropDialogDeps`, `RefreshDialogDeps`, `DropRelationForm`, `relationLabel` |

All five exported classes are `callable()`-wrapped, matching `ConfirmCascadeForm`.

### Spec readers converge on `readSpec()`

`EnumTypeForm`, `CompositeTypeForm`, `FunctionForm` and `AddEnumValueForm`
rename `getSpec()` to `readSpec()`, the name the other seven forms already use.
`ViewForm` and `MaterializedViewForm` gain `readSpec(): CreateViewSpec` /
`readSpec(): CreateMatviewSpec`, absorbing the spec literals their launchers
build today; their `schema()`/`name()`/`columns()`/`withData()` accessors become
private.

### `SqlAdminController` private members (new)

```ts
/** Stable id for a DDL draft tab. See the id table in `## Architecture Decisions`. */
private ddlPanelId(ref: DbObjectRef, slug: string): string;

/** The execute + error-report pair every DDL flow wires the same way. */
private ddlDefaults(ref: DbObjectRef): DdlExecuteDeps;

/** The connection's schema names, or null after reporting a failed fetch. */
private async fetchSchemaNames(ref: DbObjectRef): Promise<string[] | null>;

/** Open (or focus) a DDL draft tab. */
private openDdlPanel(spec: {
    ref: DbObjectRef;
    slug: string;
    title: string;
    glyph: string;
    reviewTitle: string;
    build: () => DdlDraft;
}): void;

/** The shared body of `createView` and `createMaterializedView`. */
private async createRelationDraft(ref: DbObjectRef, kind: "view" | "materializedView"): Promise<void>;
```

`createView` and `createMaterializedView` keep their names and signatures —
`navigator/objectMenu.ts` calls them — and become one-line delegations.

---

## Internal Structure

### `RowGridPanel`

Per `COMPONENT_CONVENTIONS.md` section (b), the grid, its host panel and the
Add button are locals built before `super()`; fields and the listener follow.

```ts
const ROW_SPACING = 6;

export abstract class RowGridPanel<TRow> extends Panel {
    private readonly _grid: Grid;
    private readonly _gridPanel: Panel;
    private readonly _buildRow: (onRemove: () => void, prefill?: TRow) => RowGridRow<TRow>;
    private readonly _rows: RowGridRow<TRow>[] = [];

    protected constructor(options: RowGridPanelOptions<TRow>) {
        const grid = new Grid({
            columns:      options.columnTracks.length,
            spacing:      ROW_SPACING,
            columnTracks: options.columnTracks,
        });
        const gridPanel = Panel({ layoutManager: grid, insets: new Insets(0, 0, 0, 0) });
        const addButton = Button({
            glyph: "plus", text: options.addLabel, showText: true, showDescription: false,
            compact: true, glyphColor: CONSTRUCTIVE_COLOR,
        });

        super({
            layoutManager: new VBox({ itemAlign: "stretch", spacing: ROW_SPACING }),
            components:    [...options.header, addButton, gridPanel],
        });

        this._grid      = grid;
        this._gridPanel = gridPanel;
        this._buildRow  = options.buildRow;

        addButton.on("action", () => this.appendRow());
    }

    protected readRows(): TRow[] {
        return this._rows.map(r => r.read());
    }

    protected appendRow(prefill?: TRow): void {
        const row = this._buildRow(() => this.removeRow(row), prefill);

        this._rows.push(row);

        for (const cell of row.cells) {
            this._gridPanel.addComponent(cell);
        }

        this.syncGrid();
    }

    /** Remove one row (never past the last remaining row), disposing its cells. */
    private removeRow(row: RowGridRow<TRow>): void {
        const index = this._rows.indexOf(row);

        if (index < 0 || this._rows.length <= 1) {
            return;
        }

        for (const cell of row.cells) {
            this._gridPanel.removeComponent(cell);
            cell.dispose();
        }

        this._rows.splice(index, 1);
        this.syncGrid();
    }

    /** Resize the grid to the current row count and keep the sole row's remove button disabled. */
    private syncGrid(): void {
        this._grid.setRows(this._rows.length);

        const soleRow = this._rows.length === 1;

        for (const row of this._rows) {
            row.removeButton.setEnabled(!soleRow);
        }
    }
}
```

The module owns `ROW_SPACING = 6`, `Glyph.register(plus)`, and the
`CONSTRUCTIVE_COLOR` import. Each subclass keeps `Glyph.register(minus)` and
`DESTRUCTIVE_COLOR` for its own remove button.

### A converted subclass — `EnumTypeForm`

```ts
class EnumTypeForm extends RowGridPanel<string> {
    private readonly _schema: string;
    private readonly _nameField: TextField;

    constructor(init: { schema: string }) {
        const nameField = new TextField({ placeholder: "type name" });

        super({
            header:       [nameField],
            addLabel:     "Add label",
            columnTracks: [{ mode: "weight", value: LABEL_WEIGHT }, { mode: "content" }],
            buildRow:     buildLabelRow,
        });

        this._schema    = init.schema;
        this._nameField = nameField;

        this.appendRow();
        this.appendRow(); // an enum needs at least one label to be useful
    }

    readSpec(): CreateEnumTypeSpec {
        return buildCreateEnumTypeSpec(this._schema, this._nameField.getValue(), this.readRows());
    }
}
```

`buildLabelRow` keeps its current body; only its return shape changes
(`inputs` → `cells`) and it gains an ignored second parameter position so it
matches `RowGridPanelOptions.buildRow`. The other three convert the same way;
`CompositeTypeForm`'s `buildAttrRow` is the one that actually reads `prefill`.

### `DdlFormPanel`

```ts
class DdlFormPanel extends Container {
    private readonly _deps: DdlFormPanelOptions;

    constructor(options: DdlFormPanelOptions) {
        const formHost = Panel({ layoutManager: new VBox(), autoScroll: "auto" });

        formHost.addComponent(options.form);

        const reviewButton = glyphButton("save", PRIMARY_COLOR, "Review SQL…", () => this.review());
        const toolbar      = new ToolBar({ components: [reviewButton, Spacer.flex()] });

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this._deps = options;

        this.addComponent(toolbar,  { placement: Placement.NORTH });
        this.addComponent(formHost, { placement: Placement.CENTER });
    }

    /** Open the shared SQL review dialog over this tab's form. */
    private review(): void {
        openSqlPreviewDialog({
            title:       this._deps.reviewTitle,
            generateSql: this._deps.generateSql,
            execute:     this._deps.execute,
            onSuccess:   this._deps.onSuccess,
            onError:     this._deps.onError,
        });
    }
}
```

The field is `_deps`, **not** `_options`: `Container` already declares an
`_options` member, and a subclass field of that name is a `TS2416` error.

`reviewButton` is built **before** `super()` even though its handler closes over
`this`. That is legal — the arrow body does not run until the click — and it is
the shape
[`SequenceInfoPanel.ts:208-215`](frontend/src/dock/SequenceInfoPanel.ts#L208)
already uses for its own Save tool, building `glyphButton("save",
PRIMARY_COLOR, "Save", () => this.handleSave())` seven lines above its
`super()`.

### `SqlAdminController.openDdlPanel`

```ts
private openDdlPanel(spec: {
    ref: DbObjectRef; slug: string; title: string; glyph: string;
    reviewTitle: string; build: () => DdlDraft;
}): void {
    const id = this.ddlPanelId(spec.ref, spec.slug);

    if (this.dock.focusPanel(id)) {
        return;
    }

    const draft = spec.build();
    const panel = new DdlFormPanel({
        reviewTitle: spec.reviewTitle,
        form:        draft.form,
        generateSql: draft.generateSql,
        onSuccess:   () => {
            this.dock.removePanel(id);
            this._navigator?.refresh?.();
        },
        ...this.ddlDefaults(spec.ref),
    });

    this.dock.addPanel({ id, title: spec.title, glyph: spec.glyph, content: panel });
}
```

`build` is a factory so nothing is constructed on the dedup path.
`ddlPanelId`:

```ts
private ddlPanelId(ref: DbObjectRef, slug: string): string {
    return `${ref.connectionId}/${ref.database}/${ref.schema ?? ""}/${ref.name ?? ""}::ddl-${slug}`;
}
```

### A converted launcher — `createTable`

```ts
createTable(ref: DbObjectRef): void {
    this.openDdlPanel({
        ref,
        slug:        "table",
        title:       `New table (${ref.schema})`,
        glyph:       KIND_GLYPH.table,
        reviewTitle: "Create table",
        build:       () => {
            const form = new CreateTableForm(ref.schema!);

            return { form, generateSql: async () => (await previewCreateTable(ref, form.readSpec())).sql };
        },
    });
}
```

### Every converted launcher's strings

| Controller method | slug | Tab title | Glyph | Review-dialog title |
|---|---|---|---|---|
| `createTable` | `table` | `New table (public)` | `KIND_GLYPH.table` | `Create table` |
| `createView` | `view` | `New view (public)` | `KIND_GLYPH.view` | `Create view` |
| `createMaterializedView` | `matview` | `New materialized view (public)` | `KIND_GLYPH.materializedView` | `Create materialized view` |
| `createSchema` | `schema` | `New schema (sqladmin)` | `KIND_GLYPH.schema` | `Create schema` |
| `createSequence` | `sequence` | `New sequence (public)` | `KIND_GLYPH.sequence` | `Create sequence` |
| `createFunction` | `function` | `New function (public)` | `KIND_GLYPH.function` | `Create function` |
| `createType` (enum) | `enum-type` | `New enum type (public)` | `KIND_GLYPH.type` | `Create enum type` |
| `createType` (composite) | `composite-type` | `New composite type (public)` | `KIND_GLYPH.type` | `Create composite type` |
| `editType` (composite) | `composite-type` | `Recreate addr (composite type)` | `KIND_GLYPH.type` | `Edit composite type (recreate)` |

Every review-dialog title is the string that flow passes to
`openSqlPreviewDialog` today, unchanged.

---

## Ordered Implementation Steps

### Phase 1 — Shared row grid, form-API convergence, three local convergences

1. **Create `frontend/src/dock/RowGridPanel.ts`** with the class body,
   interfaces and constants from `## Internal Structure` and `## Public API`.
   Imports: `Panel`, `type Component` from `@jimka/typescript-ui/core`; `Grid`,
   `VBox`, `type GridTrack` from `@jimka/typescript-ui/layout`; `Button` from
   `@jimka/typescript-ui/component/button`; `Glyph` from
   `@jimka/typescript-ui/component/display`; `plus` from its glyph module;
   `Insets` from `@jimka/typescript-ui/primitive`; `CONSTRUCTIVE_COLOR` from
   `../theme`. Module header: one owner for the add/remove-row grid the four DDL
   forms shared by copy; a removed row's cells are **disposed**, not merely
   detached, because `Component.removeComponent` only unwires; `cells` must
   include the row's remove button.
   Check: `npm --prefix frontend run typecheck`.

2. **`frontend/src/dock/CreateTableForm.ts` onto the base.** Change the class to
   `extends RowGridPanel<ColumnRow>`; pass `header: [nameField]`,
   `addLabel: "Add column"`, the existing six `columnTracks` entries, and
   `buildRow: buildColumnRow`. Delete the private `RowHandle` interface, the
   `_grid`/`_gridPanel`/`_rows` fields, `appendRow`, `removeRow`, `syncGrid`, the
   `GRID_COLUMNS` and `ROW_SPACING` constants, and the add-button construction.
   `readSpec()` becomes
   `buildCreateTableSpec(this._schema, this._nameField.getValue(), this.readRows())`.
   In `buildColumnRow`, rename the returned `inputs` key to `cells` and change
   its return type to `RowGridRow<ColumnRow>`. Drop the now-unused `Panel`,
   `Grid`, `VBox`, `Insets`, `type Component`, `CONSTRUCTIVE_COLOR` and `plus`
   imports, and reduce `Glyph.register(plus, minus)` to `Glyph.register(minus)`.
   Keep the `NAME_WEIGHT`/`TYPE_WEIGHT`/`DEFAULT_WEIGHT` constants and the
   six-cell comment beside `columnTracks`.
   Check: `npm --prefix frontend run typecheck`.

3. **`frontend/src/dock/EnumTypeForm.ts` onto the base**, exactly as step 2
   (`RowGridPanel<string>`, `addLabel: "Add label"`, `buildRow: buildLabelRow`,
   two seed rows). **Also rename `getSpec()` to `readSpec()`** and update its
   caller at [`SqlAdminController.ts:1634`](frontend/src/SqlAdminController.ts#L1634).
   Check: `npm --prefix frontend run typecheck`.

4. **`frontend/src/dock/CompositeTypeForm.ts` onto the base**
   (`RowGridPanel<{ name: string; type: string }>`, `addLabel: "Add attribute"`,
   `buildRow: buildAttrRow`). The constructor keeps its prefill branch, now
   calling the inherited `this.appendRow(attr)`. **Rename `getSpec()` to
   `readSpec()`** and update both callers,
   [`SqlAdminController.ts:1648`](frontend/src/SqlAdminController.ts#L1648) and
   [`:1705`](frontend/src/SqlAdminController.ts#L1705).
   Check: `npm --prefix frontend run typecheck`.

5. **`frontend/src/dock/FunctionForm.ts` onto the base**
   (`RowGridPanel<FunctionArgRow>`, `addLabel: "Add argument"`,
   `buildRow: buildArgRow`). Its `header` is the six-widget list
   `[nameField, kindCombo, languageField, returnsField, volatilityField, replaceBox]`.
   Delete the private `ArgRowHandle` interface. **Rename `getSpec()` to
   `readSpec()`** and update
   [`SqlAdminController.ts:1468`](frontend/src/SqlAdminController.ts#L1468).
   Check: `npm --prefix frontend run typecheck`.

6. **`frontend/src/dock/AddEnumValueForm.ts`: rename `getSpec()` to
   `readSpec()`** and update
   [`SqlAdminController.ts:1691`](frontend/src/SqlAdminController.ts#L1691).
   Check: `grep -rn '\.getSpec()' frontend/src/` — expect zero matches.

7. **`frontend/src/dock/RelationDdlActions.ts`: drop the private
   `DropRelationForm`.** Delete the class at
   [`:34-50`](frontend/src/dock/RelationDdlActions.ts#L34). In
   `openDropRelationDialog`, build
   `new ConfirmCascadeForm(\`Drop ${label} "${deps.schema}"."${deps.name}"?\`)`
   and read `form.readSpec().cascade` where it read `form.cascade()`. Add the
   `ConfirmCascadeForm` import; drop the now-unused `Text` import.
   Check: `npm --prefix frontend run typecheck`.

8. **`frontend/src/dock/ImportRowsDialog.ts`: use `readOnlyTable()`.** Replace
   [`:107`](frontend/src/dock/ImportRowsDialog.ts#L107)'s
   `Table(previewStore, { columns: [], autoSizeColumns: true, rowReadOnly: () => true })`
   with `readOnlyTable(previewStore)`, importing it from `./columnsGrid`. Drop
   the now-unused `Table` import.
   Check: `npm --prefix frontend run typecheck`.

9. **`frontend/src/dock/SqlPreviewDialog.ts`: make `form` optional.** Change the
   `form` field of `SqlPreviewDialogOptions` to the optional declaration in
   `## Public API`, and make the `content` Panel's `components` conditional:
   `options.form ? [options.form, regenerateButton, editor] : [regenerateButton, editor]`.
   Both sites are found by content, not line number — this file is also rewritten
   by `dialog-subclass-foundation`. Rewrite the module header's opening sentence
   so it no longer claims every DDL phase embeds a form: say the dialog hosts an
   optional structured form above an editable SQL preview, and that a tab-hosted
   creation flow omits the form (its own tab keeps it) so the dialog is the SQL
   review alone.
   Check: `npm --prefix frontend run typecheck && npm --prefix frontend test`.

### Phase 2 — The tab host, the controller helpers, and `createTable`

10. **Create `frontend/src/dock/DdlFormPanel.ts`** with the class body and
    interfaces from `## Internal Structure` and `## Public API`. Imports:
    `Container`, `Panel`, `callable`, `type Component` from
    `@jimka/typescript-ui/core`; `Border as BorderLayout`, `VBox` from
    `@jimka/typescript-ui/layout`; `Placement` from
    `@jimka/typescript-ui/primitive`; `ToolBar` from
    `@jimka/typescript-ui/component/menubar`; `Spacer` from
    `@jimka/typescript-ui/component/container`; `Glyph` from
    `@jimka/typescript-ui/component/display`; `save` from its glyph module;
    `glyphButton` from `./glyphButton`; `openSqlPreviewDialog` from
    `./SqlPreviewDialog`; `PRIMARY_COLOR` from `../theme`;
    `type QueryStatusResult` from `../contract`. Add
    `Glyph.register(save)`. Module header: the dock-tab host for a DDL creation
    form — the creation counterpart to `SequenceInfoPanel`'s and
    `StructurePanel`'s in-tab Save; the tab owns the form, the review dialog owns
    only the SQL; the field is `_deps` because `Container` reserves `_options`.
    Check: `npm --prefix frontend run typecheck`.

11. **`frontend/src/SqlAdminController.ts`: add three helpers.** Add
    `ddlPanelId` beside the other panel-id builders (after
    [`typeInfoPanelId`](frontend/src/SqlAdminController.ts#L3409)), and
    `ddlDefaults` and `openDdlPanel` just above
    [`createTable`](frontend/src/SqlAdminController.ts#L1062). Bodies as given in
    `## Internal Structure`. Add imports: `DdlFormPanel`, `type DdlDraft`,
    `type DdlExecuteDeps` from `./dock/DdlFormPanel`. `fetchSchemaNames` is
    **not** added here — it arrives with its three callers in step 20, so it is
    never an unused member.
    Check: run steps 11 and 12 together before typechecking — `noUnusedLocals`
    reports the three new members as unread until step 12 calls `openDdlPanel`.

12. **`createTable` opens a tab.** Replace its body with the `openDdlPanel` call
    from `## Internal Structure`. Update its JSDoc: it opens the create-table
    **tab**; a successful execute closes the tab and refreshes the navigator.
    Check: `npm --prefix frontend run typecheck`, then run the app and confirm
    `## Expected Behaviour` cases 5-9 against the `public` schema.

### Phase 3 — The five remaining schema-scoped creates and the composite recreate

13. **`createSchema`.** In `frontend/src/dock/SchemaDdlForms.ts`, export
    `CreateSchemaForm` through `callable()` and delete `openCreateSchemaDialog`
    and `CreateSchemaDialogDeps`. In the controller, replace `createSchema`'s
    body with an `openDdlPanel` call using the strings from the launcher table
    and a **database-scoped ref** built in the method:
    `const target: DbObjectRef = { connectionId: ref.connectionId, database: ref.database, kind: "database" };`
    — pass `target` as both `ref` and the argument to `previewCreateSchema`.
    Check: `npm --prefix frontend run typecheck`.

14. **`createSequence`.** In `frontend/src/dock/SequenceDdlForms.ts`, export
    `CreateSequenceForm` through `callable()`; delete `openCreateSequenceDialog`
    and `CreateSequenceDialogDeps`. Convert the controller's `createSequence`.
    Check: `npm --prefix frontend run typecheck`.

15. **`createFunction`.** Convert the controller's `createFunction` to
    `openDdlPanel`. No form-module change (`FunctionForm` is already a bare
    exported class).
    Check: `npm --prefix frontend run typecheck`.

16. **`createType`.** Convert both branches to `openDdlPanel`, with slugs
    `enum-type` and `composite-type`. The `onSuccess`/`onError` locals at
    [`:1625-1626`](frontend/src/SqlAdminController.ts#L1625) go — `openDdlPanel`
    supplies both.
    Check: `npm --prefix frontend run typecheck`.

17. **`editType`'s composite branch.** Convert to `openDdlPanel` with slug
    `composite-type`, tab title `` `Recreate ${ref.name} (composite type)` ``, and
    review title `"Edit composite type (recreate)"`. The enum branch is
    untouched: it keeps `openSqlPreviewDialog` with `AddEnumValueForm`. Update
    the method's JSDoc to say the composite path now opens a recreate **tab**
    while the enum path stays a dialog.
    Check: `npm --prefix frontend run typecheck`, then exercise
    `## Expected Behaviour` case 12.

### Phase 4 — The two relation creates

18. **Rename `frontend/src/dock/ViewFormDialog.ts` to
    `frontend/src/dock/ViewForm.ts`** (`git mv`). Export `ViewForm` through
    `callable()`; delete `openViewDialog` and `ViewDialogDeps`. Add
    `readSpec(): CreateViewSpec` returning
    `{ schema: this._schemaCombo.getValue(), name: this._nameField.getValue(), select: NEW_VIEW_SELECT_SKELETON, orReplace: false, columns: this.columns() }`,
    and make `schema()`, `name()` and `columns()` private. Rewrite the module
    header's first paragraph: this is the CREATE VIEW **form**, hosted in its own
    dock tab; the SELECT body is still authored in the review dialog's editor.
    Check: `grep -rn '/ViewFormDialog' frontend/src/` — expect zero matches. (The
    leading slash keeps this from matching `MaterializedViewFormDialog`, which
    step 19 renames.)

19. **Rename `frontend/src/dock/MaterializedViewFormDialog.ts` to
    `frontend/src/dock/MaterializedViewForm.ts`** and apply step 18's treatment:
    export `MaterializedViewForm`, delete `openMaterializedViewDialog` and
    `MatviewDialogDeps`, add `readSpec(): CreateMatviewSpec`, privatize the three
    accessors, rewrite the header's first paragraph.
    Check: `grep -rn 'MaterializedViewFormDialog' frontend/src/` — expect zero matches.

20. **Collapse `createView` and `createMaterializedView`.** First add the private
    `fetchSchemaNames(ref)` from `## Public API` — the preamble
    [`createView:1279-1287`](frontend/src/SqlAdminController.ts#L1279) already
    runs, returning `null` after `this.notifyError(err, ref)`. Then add the
    private `createRelationDraft(ref, kind)`: it awaits
    `this.fetchSchemaNames(ref)`, returns on `null`, then calls `openDdlPanel`
    with the row for `kind` from the launcher-strings table, building either form
    inside `build`. `createView` becomes
    `await this.createRelationDraft(ref, "view");` and
    `createMaterializedView` becomes
    `await this.createRelationDraft(ref, "materializedView");` — both keep their
    public names and `async` signatures, because
    [`objectMenu.ts:59,62`](frontend/src/navigator/objectMenu.ts#L59) calls them.
    In the same step, replace `addConstraint`'s inline schema fetch
    ([`:1144-1152`](frontend/src/SqlAdminController.ts#L1144)) with
    `fetchSchemaNames`, keeping its `kind === "foreignKey"` guard.
    Check: `grep -c 'getSchemas(ref.connectionId' frontend/src/SqlAdminController.ts`
    — expect `1` (inside `fetchSchemaNames`).

### Phase 5 — Remaining launcher convergence and cleanups

21. **Inline the five surviving wrapper launchers.** For each, move the
    `openSqlPreviewDialog` call from the form module into the controller method
    that calls it, keeping the title, `generateSql` body and `onSuccess` exactly
    as they are today:

    | Controller method | Wrapper deleted from |
    |---|---|
    | `dropSchema` | `SchemaDdlForms.ts` (`openDropSchemaDialog`, `DropSchemaDialogDeps`) |
    | `renameSchema` | `SchemaDdlForms.ts` (`openRenameSchemaDialog`, `RenameSchemaDialogDeps`) |
    | `dropSequence` | `SequenceDdlForms.ts` (`openDropSequenceDialog`, `DropSequenceDialogDeps`) |
    | `dropRelation` | `RelationDdlActions.ts` (`openDropRelationDialog`, `DropDialogDeps`, `relationLabel`) |
    | `refreshMaterializedView` | `RelationDdlActions.ts` (`openRefreshMatviewDialog`, `RefreshDialogDeps`) |

    `SchemaDdlForms.ts` exports `RenameSchemaForm` through `callable()`;
    `dropSchema`/`dropSequence`/`dropRelation` build `ConfirmCascadeForm`
    directly — for `dropRelation` that is the construction step 7 already put in
    place, moved across unchanged. `relationLabel` becomes a local in
    `dropRelation`:
    `const label = ref.kind === "materializedView" ? "materialized view" : "view";`.
    Then **rename `frontend/src/dock/RelationDdlActions.ts` to
    `frontend/src/dock/RefreshMatviewForm.ts`** (`git mv`), export
    `RefreshMatviewForm` through `callable()`, and rewrite its module header to
    describe one form.
    Check: `grep -rn 'DialogDeps\|export function open.*Dialog' frontend/src/dock/`
    — expect matches only in `SqlPreviewDialog.ts` (`openSqlPreviewDialog`) and
    `ImportRowsDialog.ts` (`openImportRowsDialog`, `ImportRowsDialogOptions`);
    and `grep -rn 'RelationDdlActions' frontend/src/` — expect zero matches.

22. **Spread `ddlDefaults(ref)` at every remaining `openSqlPreviewDialog` call
    site in the controller.** Replace each explicit
    `execute: sql => executeDdl(this._connectionId, sql)` and
    `onError: msg => this.notifyError(new Error(msg), ref)` pair with
    `...this.ddlDefaults(ref)`. The call sites are `dropTable`, `renameTable`,
    `addConstraint`, `dropConstraint`, `createIndex`, `dropIndex`,
    `createSuggestedIndex`, `dropRelation`, `refreshMaterializedView`,
    `dropSchema`, `renameSchema`, `dropSequence`, `dropFunction`, `editType`
    (enum branch) and `dropType`. Leave three sites alone:
    `structureActionsFor`'s `columnEdits` and `openSequence`'s
    `SequenceInfoPanelDeps` wire panels, not dialogs, and their `onError` takes
    the same shape but reaches a different interface; `openDefinition`'s Save
    ([`:617`](frontend/src/SqlAdminController.ts#L617)) awaits `executeDdl`
    directly with no dialog at all.
    Check: `grep -c 'executeDdl(this._connectionId, sql)' frontend/src/SqlAdminController.ts`
    — expect `4` (`ddlDefaults`, `structureActionsFor`, `openSequence`,
    `openDefinition`), down from 27.

23. **Fix `refreshStructure`.** Replace its body
    ([`:1756-1765`](frontend/src/SqlAdminController.ts#L1756)) with
    `this._openPanels.get(this.structurePanelId(ref))?.refresh?.();`. Rewrite the
    JSDoc: it reseeds the open Structure tab in place through the same closure
    Alt+R uses, keeping section open-state and scroll position, and is a no-op
    when the tab is not open — replacing a remove-and-reopen that permanently
    closed a tab opened without a navigator node.
    Check: `grep -n 'openStructure(ref, node)' frontend/src/SqlAdminController.ts`
    — expect zero matches.

24. **Wire the two drop spec-builders.** In `dropConstraint`, replace the inline
    spec at [`:1180-1182`](frontend/src/SqlAdminController.ts#L1180) with
    `buildConstraintSpec(ref.schema!, ref.name!, "drop", { constraintName, cascade: form.readSpec().cascade })`.
    In `dropIndex`, replace [`:1222-1224`](frontend/src/SqlAdminController.ts#L1222)
    with `buildIndexSpec(ref.schema!, "drop", { indexName, cascade: form.readSpec().cascade })`.
    Add both to the `./dock/ddlSpecs` import. Then extend
    `frontend/tests/dock/ddlSpecs.test.ts`: beside the existing drop cases at
    [`:358-363`](frontend/tests/dock/ddlSpecs.test.ts#L358) and
    [`:374-379`](frontend/tests/dock/ddlSpecs.test.ts#L374), add one case per
    builder asserting that `cascade: false` produces an object with **no**
    `cascade` key (`expect("cascade" in spec).toBe(false)`), and one asserting
    `cascade: true` carries it through — the rule the table in
    `## Architecture Decisions` states.
    Check: `npm --prefix frontend test`.

25. **The three stale doc comments.**
    - `frontend/src/dock/ImportRowsDialog.ts` header: delete the clause claiming
      `SqlPreviewDialog`'s Execute "always succeeds at closing and retries by
      rebuilding a fresh Dialog on a failed execute". Both dialogs validate in
      place through `DialogButtonConfig.onClick`; say so once and drop the
      contrast.
    - `frontend/src/dock/ConfirmCascadeForm.ts:1-4`: replace the consumer list
      with the real one — drop-table, drop-view, drop-materialized-view,
      drop-schema, drop-sequence, drop-index, drop-constraint, drop-function and
      drop-type. There is no drop-column flow.
    - `frontend/src/dock/ddlSpecs.ts:1-7`: replace "the table-DDL dialog forms"
      and its four named consumers with a description that cannot go stale —
      every DDL form under `dock/`, the two in-tab Save flows
      (`StructurePanel`'s Columns diff and `SequenceInfoPanel`'s), and
      `SqlAdminController`'s own drop launchers.

26. **Add section (h) to `frontend/COMPONENT_CONVENTIONS.md`**, after the
    section `dialog-subclass-foundation` added: "DDL creation edits in a tab".
    State the rule and its two halves — a form that authors a new object's
    structure is hosted in a `DdlFormPanel` dock tab and reaches
    `openSqlPreviewDialog` only from its `Review SQL…` tool; a form that merely
    confirms or re-parameterizes an existing object (a drop, a rename, a
    refresh) stays a plain `openSqlPreviewDialog` call. Name `SequenceInfoPanel`
    and `StructurePanel` as the edit-side precedent the creation side now
    matches. Keep it to roughly the length of section (e).

27. **Full check.** `npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build`,
    then the manual smoke tests in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/RowGridPanel.ts` |
| Create | `frontend/src/dock/DdlFormPanel.ts` |
| Rename + modify | `frontend/src/dock/ViewFormDialog.ts` → `frontend/src/dock/ViewForm.ts` |
| Rename + modify | `frontend/src/dock/MaterializedViewFormDialog.ts` → `frontend/src/dock/MaterializedViewForm.ts` |
| Rename + modify | `frontend/src/dock/RelationDdlActions.ts` → `frontend/src/dock/RefreshMatviewForm.ts` |
| Modify | `frontend/src/dock/CreateTableForm.ts` |
| Modify | `frontend/src/dock/EnumTypeForm.ts` |
| Modify | `frontend/src/dock/CompositeTypeForm.ts` |
| Modify | `frontend/src/dock/FunctionForm.ts` |
| Modify | `frontend/src/dock/AddEnumValueForm.ts` |
| Modify | `frontend/src/dock/ConfirmCascadeForm.ts` |
| Modify | `frontend/src/dock/SchemaDdlForms.ts` |
| Modify | `frontend/src/dock/SequenceDdlForms.ts` |
| Modify | `frontend/src/dock/SqlPreviewDialog.ts` |
| Modify | `frontend/src/dock/ImportRowsDialog.ts` |
| Modify | `frontend/src/dock/ddlSpecs.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/tests/dock/ddlSpecs.test.ts` |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |

---

## Expected Behaviour

The frontend's vitest suite runs in the `node` environment
(`frontend/vitest.config.ts`) and covers DOM-free helpers only. Cases 1-4 are
**unit-testable**; everything from case 5 on is **manual-verify**.

**Spec builders (unit-testable, `tests/dock/ddlSpecs.test.ts`)**

1. `buildConstraintSpec("public", "t", "drop", { constraintName: "t_email_key", cascade: false })`
   returns `{ schema: "public", name: "t", action: "drop", constraintName: "t_email_key" }`
   with no `cascade` key.
2. The same call with `cascade: true` additionally carries `cascade: true`.
3. `buildIndexSpec("public", "drop", { indexName: "t_email_idx", cascade: false })`
   returns `{ schema: "public", action: "drop", indexName: "t_email_idx" }` with
   no `cascade` key.
4. The same call with `cascade: true` additionally carries `cascade: true`.

**A creation tab**

5. Right-clicking the `public` schema and choosing Create ▸ Table opens a dock
   tab titled `New table (public)` with a table glyph, a `Review SQL…` toolbar
   tool, and the same name field + one-row column grid the dialog showed. **No
   dialog opens, and no error banner or notification appears** — today the
   dialog opens with its error banner already showing, because it previews an
   empty form on open.
6. Filling the form and pressing `Review SQL…` opens the `Create table` dialog
   showing only the generated SQL, the `Regenerate SQL` button and
   Cancel/Execute — no second copy of the form.
7. Cancelling the dialog returns to the tab with the form exactly as it was.
8. Executing valid SQL closes both the dialog and the tab, and refreshes the
   navigator so the new table appears.
9. Executing SQL that fails (a duplicate name) leaves the dialog open with the
   error banner and the SQL intact; cancelling returns to the still-filled tab.
10. Re-running Create ▸ Table from `public` while the draft tab is open focuses
    that tab with its contents intact, rather than opening a second one.
11. Create ▸ Table from a *different* schema opens a second, independent draft
    tab.
12. Right-clicking a *composite* type leaf and choosing Edit opens a tab titled
    `Recreate addr (composite type)` prefilled with the type's current
    attributes; its review dialog is titled `Edit composite type (recreate)`.
    The same gesture on an *enum* leaf still opens the `Add enum value`
    **dialog**.
13. Closing a draft tab discards it with no prompt and no console warning.
14. Each of the eight creation flows opens the tab named in the launcher-strings
    table, and each review dialog carries the title in that table's last column.

**Row grids**

15. In the Create-table tab, `Add column` appends a row and `Remove column`
    removes it; with one row left, that row's remove button is disabled.
16. Adding three columns, removing the middle one, then executing produces a
    `CREATE TABLE` naming exactly the two surviving columns in order.
17. Adding and removing rows repeatedly leaves the DiagnosticsOverlay's live
    component count returning to its pre-add level rather than climbing — the
    leak this plan fixes. The same applies in the enum, composite-type and
    function tabs.

**Structure-tab refresh**

18. With a table's Structure tab open, adding a constraint reseeds every section
    **in place**: the tab stays open, its accordion keeps which sections were
    expanded, and the new constraint appears in the Constraints grid.
19. Opening a Structure tab from a deep link
    (`/schema/public/table/customers/structure`), then adding or dropping an
    index, keeps the tab open and shows the change. This is the regression case:
    the tab closes and never returns today.

**Unchanged flows**

20. Drop table, Drop view, Drop materialized view, Drop schema, Drop sequence,
    Drop function, Drop type, Drop constraint, Drop index, Rename table, Rename
    schema, Refresh materialized view, Add constraint and Create index all still
    open a dialog with their form above the SQL preview, and execute as before.
21. Drop view / Drop materialized view render as before, with one cosmetic
    change: the gap between the summary line and the CASCADE checkbox is
    `ConfirmCascadeForm`'s declared 6px instead of the box layout's default 5px,
    matching every other drop dialog.
22. The Import dialog's preview grid renders and behaves exactly as before.

---

## Verification

- `npm --prefix frontend run typecheck` — the primary gate. `noUnusedLocals`
  and `noUnusedParameters` are on, so every import left behind by the deletions
  in Phases 1, 3, 4 and 5 fails here.
- `npm --prefix frontend test` — cases 1-4, plus the existing suite green.
- `npm --prefix frontend run build`.
- Grep invariants:
  - `grep -rn '\.getSpec()' frontend/src/` → zero matches.
  - `grep -rn 'DialogDeps' frontend/src/` → zero matches.
  - `grep -rn 'export function open.*Dialog' frontend/src/dock/` → only
    `openSqlPreviewDialog` and `openImportRowsDialog`.
  - `grep -rn 'ViewFormDialog\|MaterializedViewFormDialog\|RelationDdlActions' frontend/src/`
    → zero matches.
  - `grep -rn 'removeComponent' frontend/src/dock/CreateTableForm.ts frontend/src/dock/EnumTypeForm.ts frontend/src/dock/CompositeTypeForm.ts frontend/src/dock/FunctionForm.ts`
    → zero matches; the row-removal copy now lives only in `RowGridPanel.ts`.
  - `grep -c 'executeDdl(this._connectionId, sql)' frontend/src/SqlAdminController.ts`
    → `4`.
  - `grep -c 'getSchemas(ref.connectionId' frontend/src/SqlAdminController.ts` → `1`.
- Manual smoke tests, driving the app per the `verify` skill: the navigator's
  schema context menu for cases 5-11 and 14; a type leaf's Edit for case 12; a
  table's Structure tab toolbars for cases 18-19; the navigator's drop/rename
  items for cases 20-21; a table's Data tab → Import for case 22. Case 17 needs
  the library DiagnosticsOverlay (About → Debug).

---

## Documentation Impact

`frontend/COMPONENT_CONVENTIONS.md` gains section (h) (step 26). It is where the
follow-on plan that splits `SqlAdminController.ts` will read which launchers are
tab-hosted and which stay dialogs, so it must state the rule, not just point at
the example.

`CHANGELOG.md` is **not** touched. Per `release-steps.md`, changelog sections are
written at release time. The user-visible items for whoever cuts the next release
are the eight creation flows moving into tabs (`Changed`) and the Structure tab
no longer closing on a constraint/index change (`Fixed`).

---

## Potential Challenges

- **`Container` reserves `_options`.** A subclass field of that name is a
  `TS2416` error against the installed 0.8.0 types — confirmed by compiling a
  probe before this plan was written.[^probe] `DdlFormPanel` uses `_deps`, as
  `SequenceInfoPanel` does.
- **`SqlPreviewDialog.ts` and `ImportRowsDialog.ts` are rewritten by
  `dialog-subclass-foundation` first.** Every edit to those two files in this
  plan is described by content, not line number. Locate the `form` field and the
  `content` Panel by name, not by the line numbers quoted from today's tree.
- **A draft tab cannot be closed while its review dialog is open.** The dialog is
  modal and its backdrop covers the dock, so `generateSql`'s closure over the
  live form can never outlive the form. Do not add a defensive guard for it.
- **`build` must stay a factory.** `openDdlPanel` returns early when the panel id
  is already open; a form constructed at the call site instead would be built and
  then orphaned on that path.
- **`createRelationDraft` fetches the schema list before the dedup check.**
  Re-launching Create ▸ View while a draft is open costs one redundant
  `getSchemas` call, and a failure of that call reports an error instead of
  focusing the open draft. Both are acceptable; do not add a second id
  computation to avoid them.
- **`git mv` the three renamed modules** rather than delete-and-create, so their
  history follows. Their importers are `SqlAdminController.ts` only.

---

## Critical Files

- `frontend/src/dock/SequenceInfoPanel.ts:112-248,303-339` — the precedent this
  plan's approach mirrors: a `Container` with a NORTH `ToolBar` and a CENTER
  `autoScroll` form host, whose Save opens `openSqlPreviewDialog` with a
  summary rather than the live form. `DdlFormPanel` copies its construction
  shape and its deps-interface style.
- `frontend/src/dock/StructurePanel.ts:295-328` — the second in-tab
  edit-then-review flow, and the one the app owner named. Read `saveColumns`
  for how a panel hands `generateSql`/`execute`/`onSuccess` to the shared
  dialog.
- `frontend/COMPONENT_CONVENTIONS.md` — sections (a) `extends` the callable
  base, (b) the super-cascade trap, (c) arrow-function handler fields, (d) the
  instance is the component and the `callable()` export form, and the section
  (g) `dialog-subclass-foundation` adds. Governs both new classes.
- `frontend/src/SqlAdminController.ts:2540-2586` and `:1773-1788` — `openQuery`
  and `openDocumentation`, the two existing tabs that carry no `DbObjectRef`
  and so are opened with `dock.addPanel` and left out of `_openPanels`. DDL
  draft tabs follow them, not `openAsyncPanel`.
- `frontend/src/SqlAdminController.ts:905-1021` — `openStructure`, which
  registers the in-place `refresh` closure step 23 dispatches to.
- `frontend/src/dock/CreateTableForm.ts` — the fullest of the four row-grid
  forms (six cells per row); read it beside `EnumTypeForm.ts` to see exactly
  what `RowGridPanel` absorbs and what stays per-form.
- `frontend/src/dock/columnsGrid.ts:122-124` — `readOnlyTable`, the helper
  step 8 adopts.
- `LIBRARY_NOTES.md:331-397` — the `SqlPreviewDialog` retry-rebuild history the
  stale `ImportRowsDialog` comment in step 25 still describes.
- `plans/research/codebase-health-audit-2026-08-29.md` — Priority 1 #1 and #6,
  Priority 2 #1, #3, #4, #5, the dead-spec-builder bullet in Priority 3, and
  three Priority 4 bullets: the findings this plan closes.

---

## Non-Goals

- **Moving drop, rename or refresh flows into tabs.** A one-line summary plus a
  CASCADE checkbox is a confirmation, not an editing session; a whole tab for it
  would be worse than the dialog. They converge on the launcher convention only.
- **Moving Add constraint / Create index into tabs.** Both are launched from a
  table's Structure tab toolbar and refresh that same tab on success; opening a
  second tab to edit the first one reads badly. They keep `ConstraintForm` and
  `IndexForm` in a dialog.
- **Moving `editType`'s enum branch into a tab.** `AddEnumValueForm` appends one
  label to an existing type — an alteration, not an authoring session.
- **A dirty-close guard on a draft tab.** Closing a tab with an unsaved draft
  discards it silently, as closing a query tab with unsaved SQL already does.
- **A URL route for a draft tab.** `routeTargets.ts` addresses objects that
  exist; a draft has none. A focused draft tab resolves to `/`, like a query tab
  with no recorded run.
- **Splitting `SqlAdminController.ts`.** A later plan owns that; this one only
  converges the launcher pattern and touches the call sites the migration
  requires.
- **`RoleGrantsPanel.ts:49` and `QueryResultView.ts:97`'s `readOnlyTable`
  bypasses.** A different plan owns those two files.
- **The remaining unreachable spec-builder fields** — `IndexFields.ifExists`,
  `AlterTableFields.cascade` and `buildCreateTableSpec`'s `ifNotExists`. No UI
  collects them; wiring the two drop paths is what was asked for, and the rest
  need a feature, not a refactor.
- **Editing `CHANGELOG.md`.** See `## Documentation Impact`.

---

## Notes

[^tab-precedent]: The app owner named `StructurePanel` as the precedent, and it
    is the right one for the *flow* — edit in place, Save opens
    `SqlPreviewDialog`. But its editing surface is an inline-editable `Table`
    inside an accordion section, and its Save tool sits in a section header, so
    there is no whole-tab shape to copy. `SequenceInfoPanel` runs the identical
    flow over a *form*: `Container` + `Border`, a `ToolBar` in NORTH, and
    `Panel({ layoutManager: new VBox(), autoScroll: "auto" })` in CENTER holding
    the form. That wrapper matters — `SequenceInfoPanel.ts:198-205` explains that
    dropping a form straight into CENTER stretches its input track across the
    whole tab, unwieldy on a wide window, while a plain `VBox` sizes the form to
    its own preferred width and the `autoScroll` keeps a narrow tab scrollable
    rather than clipped. `DdlFormPanel` inherits both decisions rather than
    rediscovering them.

[^no-form-in-dialog]: Three options were weighed. Keeping the form in the dialog
    is impossible: a `Component` has one parent, and re-parenting the live form
    for the dialog's lifetime would leave the tab empty behind the backdrop.
    Building a per-kind read-only summary — what `StructurePanel` and
    `SequenceInfoPanel` pass — would mean eight new summary builders; those two
    need summaries because their SQL is a *diff* of several `ALTER` statements
    whose before/after is invisible in the SQL text, which is not true of a
    `CREATE`. Omitting the form leaves the dialog showing the one thing that is
    authoritative at execute anyway (the previewed text), and it deletes a wart:
    today's create dialogs run `generateSql` against an empty form on open, so
    every one of them opens with an error banner already showing.

[^one-convention]: The audit (Priority 2 #5) counted ten launchers behind a
    bespoke `*DialogDeps` interface against thirteen inlined in the controller,
    and listed picking one as an open design call. The class-plus-deps side wins
    on three counts. It is what the two *panels* already do
    (`SequenceInfoPanelDeps`, `ColumnEditActions`), so tab-hosting has nothing
    new to invent. It is what the majority of form modules already do
    (`CreateTableForm`, `ConstraintForm`, `IndexForm`, `ConfirmCascadeForm`,
    `RenameTableForm`, `AddEnumValueForm`, `FunctionForm`, `EnumTypeForm`,
    `CompositeTypeForm` — nine of fourteen). And the wrapper functions are what
    carried the duplication the audit measured: nine near-identical
    `execute`/`onSuccess`/`onError` re-declarations with copy-pasted JSDoc, none
    of which survives.

[^remove-does-not-dispose]: Verified against the shipped bundle, not assumed.
    `Component.removeComponent` in the installed `@jimka/typescript-ui@0.8.0`
    delegates to a private `unwireChild`, whose body releases the child's layout
    constraints, nulls both size-change callback slots, clears `_parent` and
    calls `removeElement()` — and returns. It never reaches `destructor()`.
    (Read from `dist/lib/Component-YrLXKJZS.js.map`'s embedded
    `core/Component.ts` source, lines 6313-6335.) `dispose()` is documented
    idempotent in the same file, so calling it on a cell that a later teardown
    also reaches is harmless.

[^abstract-base]: `callable()` exists so a call site can write
    `ActivityBar(views)` instead of `new ActivityBar(views)` when constructing a
    component inline as a value. `RowGridPanel` is never a value: its four
    subclasses are the only things that name it, and each keeps its own
    `callable()` export. Marking it `abstract` makes that contract compile-time
    enforced rather than conventional. `abstract` + generic + `extends` the
    callable `Panel`, with a concrete `callable()`-wrapped subclass on top, was
    compiled against the installed 0.8.0 types before this plan was written and
    produced no diagnostics.

[^no-registry]: `_openPanels` entries drive `syncToPanel` (select the tab's
    navigator node, show its properties in the inspector), `updateStatusFor`
    (the status-line row count or detail label), `refreshActive` (Alt+R) and
    `exportActive`. A draft tab has no navigator node to select, no object to
    inspect, nothing to refresh and nothing to export, so an entry would be four
    dead fields. Both no-ref tabs that already exist — a scratch query panel and
    the notes tab — are handled the same way, and `openQuery`'s own comment
    states the reasoning. Every consumer degrades correctly on a missing entry:
    `syncToPanel` returns early, `refreshActive` returns, `canExportActive`
    returns false, and `resolveAddressBarRoute` falls back to `{ path: "/" }`.

[^database-scoped-schema]: `CREATE SCHEMA` is database-scoped but is launched
    from a schema node, because the navigator's top level *is* the logged-in
    database's schemas and there is no database node to right-click (see
    `SchemaDdlForms.ts`'s header). Keying the draft on the launching schema
    would open a second identical `New schema` tab for every schema node the
    user tried it from. Synthesizing a `{connectionId, database, kind:
    "database"}` ref is the same move `databaseDiagramPanelId` already makes by
    ignoring `ref.schema`, and `previewCreateSchema` reads only `connectionId`
    and `database` from the ref it is given. `notifyError` degrades cleanly on a
    ref with no `name`: it already guards with `ref?.name ? …`.

[^refresh-structure]: `refreshStructure`'s own comment calls the `node: null`
    case one that "should not happen in practice — the navigator always supplies
    one". Two paths falsify that: `appRouter.ts` opens a Structure tab from a
    URL with no node, and `openReferencedStructure` stores `null` when a reveal
    finds nothing. In both, adding or dropping a constraint or index removes the
    tab and the `if (node)` guard then declines to reopen it. Dispatching to the
    registered `refresh` closure is not just a smaller fix than repairing the
    guard: it is what the Columns-Save path already does
    (`openStructure`'s `onColumnsSaved`), it preserves accordion open-state and
    scroll position that a reopen discards, and it keeps `entry.columns` — which
    `structureColumns(ref)` reads to build the next constraint form's checklist —
    updated by the same closure.

[^wire-not-delete]: Deleting the two branches was the other option. Wiring them
    is strictly better: it also removes the controller-side copy of the same
    literals, which is the actual duplication, and it turns
    `tests/dock/ddlSpecs.test.ts`'s two existing drop-spec tests from coverage of
    unreachable code into coverage of the live path — the outcome the audit's
    Priority 3 bullet was worried about ("a future editor changing a drop spec's
    shape would edit `ddlSpecs.ts`, watch tests pass, and ship nothing"). The
    omitted-versus-explicit `cascade: false` difference is confirmed harmless
    against the backend: `ddl_table.py:266` and `:315` both read
    `bool(spec.get("cascade", False))`.

[^probe]: A throwaway module containing `RowGridPanel` (abstract, generic,
    `extends` the callable `Panel`), a concrete `callable()`-wrapped subclass of
    it, and `DdlFormPanel` was compiled against the installed
    `@jimka/typescript-ui@0.8.0` with the project's own `tsconfig.json`
    (`strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`).
    It surfaced two things this plan encodes: `Container` already declares
    `_options`, so a subclass field of that name fails with `TS2416`; and
    `openSqlPreviewDialog` rejects a call omitting `form` until
    `SqlPreviewDialogOptions.form` is made optional. With those two addressed the
    probe produced no diagnostics — covering `Grid`'s `GridTrack[]` from
    `@jimka/typescript-ui/layout`, `Spacer.flex()` inside a `ToolBar`,
    `Placement.NORTH`/`CENTER` under `Border`, and `cell.dispose()` on a
    `Component` from the `cells` array. A second probe confirmed that
    `DdlFormPanel`'s `glyphButton(…, () => this.review())` typechecks when the
    button is built *before* `super()`, as `SequenceInfoPanel` builds its own.
    Both probes were deleted; nothing from either is committed.
