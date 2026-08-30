// The dock work panel for one standalone enum or composite type: its category
// and owning role, plus an inline-editable grid of its ordered enum labels or
// composite attributes — shown in its own tab opened from the navigator's
// double-click / "Show info" context item on a Types-category leaf. This is
// the type-panel-inline-editing phase's single edit surface for a standalone
// type: the navigator's old separate "Edit" menu item, and the two forms
// that backed it, are gone (one deleted outright, the other pared down to
// its create-only role). The body is a grid rather than a CodeEditor, unlike
// FunctionDefinitionPanel: a type has no catalog-authoritative definition
// text (there is no `pg_get_typedef` for a standalone type), and its
// payload — an ordered label/attribute list — is a variable-length shape a
// grid fits better than a fixed field set.
//
// The two possible payload shapes (enum labels vs. composite attributes) are
// chosen once at construction, from `detail.category`: a category cannot
// change in place in PostgreSQL, so `reload` never has to swap the grid's
// columns — it throws instead if a re-fetched category ever disagrees (see
// `reload`'s doc).
//
// Save mirrors StructurePanel's Columns section: it diffs the grid's current
// rows against `_original` (the definition the tab loaded) and opens the
// shared SQL preview dialog with one summary line per change. Composite
// attributes get one `ALTER TYPE ... ATTRIBUTE` statement per change,
// `";\n"`-joined (see `saveComposite`/`diffCompositeAttributeSpecs`). Enum
// labels get in-place `ADD VALUE`/`RENAME VALUE` statements UNLESS a loaded
// label was deleted, in which case Postgres's lack of `ALTER TYPE ... DROP
// VALUE` routes the whole Save through a recreate-and-migrate script instead
// (see `saveEnum`/`diffEnumLabels`). Save starts disabled and re-syncs on
// every grid change (an inline edit, an added row, or a removed row all fire
// the store's "datachange" event); Delete is gated on the grid having a
// selected row; Add is always enabled.
//
// Needs no disposal of its own: this panel `extends`-es a library base
// rather than composing one, so every child (the toolbar, the
// LabeledFieldSet's Text rows, the grid) is a registered descendant, and the
// Dock's teardown on tab close reaches each one, same as IndexInfoPanel.

import { Container, callable }         from "@jimka/typescript-ui/core";
import { Border as BorderLayout }      from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Button }                      from "@jimka/typescript-ui/component/button";
import { Text }                        from "@jimka/typescript-ui/component/input";
import { LabeledFieldSet, Spacer }     from "@jimka/typescript-ui/component/container";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import { Table }                       from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }             from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model }          from "@jimka/typescript-ui/data";
import type { FieldOptions, ModelRecord } from "@jimka/typescript-ui/data";
import { plus }                        from "@jimka/typescript-ui/glyphs/solid/plus";
import { trash }                       from "@jimka/typescript-ui/glyphs/solid/trash";
import { save }                        from "@jimka/typescript-ui/glyphs/solid/save";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import { glyphButton }                 from "./glyphButton";
import { REFRESH_SHORTCUT }            from "../shell/queryShortcuts";
import { CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR, PRIMARY_COLOR } from "../theme";
import { attributeRows, categoryLabel, enumLabelRows } from "./typeInfoRows";
import { FILLER_COLUMN, gateOnSelection } from "./columnsGrid";
import { CONTENT_SPACING, CONTENT_WIDTH_CAP } from "./panelMetrics";
import {
    describeCompositeSpecs, describeEnumPlan, diffCompositeAttributeSpecs, diffEnumLabels, orderRenamesForExecution,
} from "./ddlSpecs";
import type { EditedAttributeRow, EditedLabelRow, EnumEditPlan } from "./ddlSpecs";
import { openSqlPreviewDialog }        from "./SqlPreviewDialog";
import { summaryPanel }                from "./summaryPanel";
import type {
    AlterCompositeTypeSpec,
    AlterTypeAddValueSpec,
    AlterTypeRenameValueSpec,
    DdlPreview,
    QueryStatusResult,
    RecreateEnumTypeSpec,
    TypeDefinition,
} from "../contract";

// The toolbar's add/delete/save glyphs, plus its own Refresh glyph.
Glyph.register(plus, trash, save, refresh);

/** The enum body grid's fields: 1-based catalog order, the (editable) label, its diff anchor, then a blank filler. */
const ENUM_FIELDS: FieldOptions[] = [
    { name: "position",      type: "number", description: "Order", order: 1 },
    { name: "label",         type: "string", description: "Label", order: 2 },
    { name: "originalLabel", type: "string", description: "Original label", order: 3 },
    { name: "filler",        type: "string", description: "",      order: 4 },
];

/** The composite body grid's fields: the (editable) attribute name/type, its diff anchor, then a blank filler. */
const ATTRIBUTE_FIELDS: FieldOptions[] = [
    { name: "name",         type: "string", description: "Attribute",     order: 1 },
    { name: "type",         type: "string", description: "Type",          order: 2 },
    { name: "originalName", type: "string", description: "Original name", order: 3 },
    { name: "filler",       type: "string", description: "",              order: 4 },
];

/**
 * The body grid over `store`: `realColumns` inline-editable (capped at
 * {@link CONTENT_WIDTH_CAP}) except `position` (an enum's catalog-order
 * column, which never accepts edits), and a blank `filler` column absorbing
 * the panel's leftover width — mirrors columnsGrid.ts's `linkedColumnsTable`,
 * which applies the same pattern to the Columns grid.
 *
 * @param store - the grid's backing store.
 * @param realColumns - the store's fields to show, in display order (`filler`
 *   excluded — it's appended here).
 */
function bodyTable(store: MemoryStore, realColumns: string[]): Table {
    const spec: ColumnSpec = {
        columns: [
            ...realColumns.map(field => ({ field, maxWidth: CONTENT_WIDTH_CAP, readOnly: field === "position" })),
            FILLER_COLUMN,
        ],
        autoSizeColumns: true,
        appendUnlisted:  false,
    };

    return Table(store, spec);
}

/**
 * The body grid's row data for a detail: an enum's labels numbered 1..n
 * (each carrying its own `originalLabel` diff anchor), or a composite's
 * attributes (each carrying its own `originalName` diff anchor).
 */
function bodyRows(detail: TypeDefinition): object[] {
    return detail.category === "enum" ? enumLabelRows(detail.labels) : attributeRows(detail.attributes);
}

/**
 * Build the body grid for a detail, over a fresh store — a fresh `Model` each
 * call (unlike the module-level `FieldOptions[]` arrays), so two open type
 * tabs never share one.
 */
function buildBodyGrid(detail: TypeDefinition): { grid: Table; store: MemoryStore } {
    const isEnum      = detail.category === "enum";
    const fields      = isEnum ? ENUM_FIELDS : ATTRIBUTE_FIELDS;
    const realColumns = isEnum ? ["position", "label"] : ["name", "type"];
    const store       = new MemoryStore({ model: new Model({ fields }), data: bodyRows(detail), autoLoad: true });

    return { grid: bodyTable(store, realColumns), store };
}

/** Dependencies {@link TypeInfoPanel} needs to preview/execute/reload a Save. */
export interface TypeInfoPanelDeps {
    schema: string;
    name: string;

    /** Preview one composite-attribute ALTER TYPE statement. */
    previewAlterComposite: (spec: AlterCompositeTypeSpec) => Promise<DdlPreview>;

    /** Preview an ALTER TYPE ... ADD VALUE statement. */
    previewAddEnumValue: (spec: AlterTypeAddValueSpec) => Promise<DdlPreview>;

    /** Preview an ALTER TYPE ... RENAME VALUE statement. */
    previewRenameEnumValue: (spec: AlterTypeRenameValueSpec) => Promise<DdlPreview>;

    /** Preview the enum recreate-and-migrate script. */
    previewRecreateEnum: (spec: RecreateEnumTypeSpec) => Promise<DdlPreview>;

    /** Execute the (possibly hand-edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Re-fetch this type's definition after a successful Save. */
    reloadDetail: () => Promise<TypeDefinition>;

    /** Report a diff/preview/execute error. */
    onError: (message: string) => void;

    /** Report a short status message (e.g. a no-op Save, a successful alter). */
    onStatus: (message: string) => void;

    /** Re-fetch this type's definition and reseed the tab in place, discarding any unsaved edit. */
    onRefresh: () => void;
}

/**
 * A tab-filling, inline-editable view of one type's category, owner, and
 * payload. All four preview callbacks in {@link TypeInfoPanelDeps} are
 * always wired; the panel calls only the ones its own category needs.
 */
class TypeInfoPanel extends Container {
    private readonly _deps:         TypeInfoPanelDeps;
    private readonly _categoryText: Text;
    private readonly _ownerText:    Text;
    private readonly _grid:         Table;
    private readonly _store:        MemoryStore;
    private readonly _saveButton:   Button;
    // The category the body grid's columns were built for — reload() refuses
    // to reseed across a category flip (see reload's doc).
    private readonly _category: TypeDefinition["category"];

    // Mutable: reassigned by `reload`, so `saveComposite()`/`saveEnum()`'s
    // diff always compares the grid against the definition most recently
    // loaded, not a stale captured value — mirrors StructurePanel's `_columns`.
    private _original: TypeDefinition;

    /**
     * @param detail - the type's category, owner, and labels/attributes,
     *   fetched by the controller before construction.
     * @param deps - the schema/name (for the fieldset legend and Save specs),
     *   the preview/execute/reload callbacks, and the status/error/refresh
     *   reporters.
     */
    constructor(detail: TypeDefinition, deps: TypeInfoPanelDeps) {
        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        const isEnum = detail.category === "enum";

        const categoryText = new Text(categoryLabel(detail.category));
        const ownerText    = new Text(detail.owner);

        // The legend is the type's schema-qualified name — see
        // IndexInfoPanel's identical rationale (must be non-empty, or the
        // fieldset's top border shows a gap where the legend notch sits).
        const fieldSet = new LabeledFieldSet(`${deps.schema}.${deps.name}`, {
            rows: [
                [{ title: "Category", component: categoryText }],
                [{ title: "Owner", component: ownerText }],
            ],
        });

        const { grid, store } = buildBodyGrid(detail);

        // Built after super() so `this` is available for the click handlers
        // (COMPONENT_CONVENTIONS.md (b)) — mirrors StructurePanel's identical
        // post-super() `columnsSaveButton`.
        const addButton = glyphButton(
            "plus", CONSTRUCTIVE_COLOR, isEnum ? "Add label" : "Add attribute",
            () => grid.addRow(isEnum ? { label: "", originalLabel: "" } : { name: "", type: "", originalName: "" }),
        );
        const deleteButton = glyphButton(
            "trash", DESTRUCTIVE_COLOR, isEnum ? "Delete label" : "Delete attribute",
            () => grid.removeSelectedRow(),
        );
        const saveButton    = glyphButton("save", PRIMARY_COLOR, "Save", () => this.handleSave());
        const refreshButton = glyphButton("refresh", PRIMARY_COLOR, `Refresh (${REFRESH_SHORTCUT})`, () => deps.onRefresh());

        gateOnSelection(grid, [deleteButton]);

        const toolbar = new ToolBar({
            components: [addButton, deleteButton, saveButton, Spacer.flex(), refreshButton],
        });

        // The fieldset and grid sit in a nested Border below the toolbar —
        // the toolbar already claims the root's NORTH placement, mirroring
        // IndexInfoPanel's identical nesting. Unlike IndexInfoPanel (whose
        // CENTER is a CodeEditor that already carries its own visual
        // padding), this CENTER is a Table butted directly against the
        // fieldset below it, so this inner Border needs its own spacing —
        // CONTENT_SPACING, this app's usual dialog/panel content gap.
        const content = Container({ layoutManager: new BorderLayout({ spacing: CONTENT_SPACING }) });
        content.addComponent(fieldSet, { placement: Placement.NORTH });
        content.addComponent(grid, { placement: Placement.CENTER });

        this._deps         = deps;
        this._categoryText = categoryText;
        this._ownerText    = ownerText;
        this._grid         = grid;
        this._store        = store;
        this._saveButton   = saveButton;
        this._category     = detail.category;
        this._original     = detail;

        this.addComponent(toolbar, { placement: Placement.NORTH });
        this.addComponent(content, { placement: Placement.CENTER });

        // Save starts disabled (no pending edits yet) and re-syncs on every
        // grid change — an inline edit, an added row, or a removed row all
        // fire the store's "datachange" event.
        store.on("datachange", this.syncSaveEnabled);
        this.syncSaveEnabled();
    }

    /** Dispatch Save to the composite or enum diff/preview flow, per `_category`. */
    private handleSave(): void {
        if (this._category === "enum") {
            this.saveEnum();
        } else {
            this.saveComposite();
        }
    }

    /**
     * Diff the composite-attribute grid's current rows against
     * `this._original.attributes` and, if anything changed, open the shared
     * SQL preview dialog; a diff error (a blank name/type) and a no-op diff
     * are both reported through `_deps` without opening a dialog.
     */
    private saveComposite(): void {
        let specs: AlterCompositeTypeSpec[];

        try {
            specs = diffCompositeAttributeSpecs(
                this._deps.schema, this._deps.name, this._original.attributes, this.readEditedAttributeRows(),
            );
        } catch (err) {
            this._deps.onError(err instanceof Error ? err.message : String(err));

            return;
        }

        if (specs.length === 0) {
            this._deps.onStatus("No changes");

            return;
        }

        openSqlPreviewDialog({
            title:       "Alter composite type",
            form:        summaryPanel(describeCompositeSpecs(specs)),
            generateSql: async () =>
                (await Promise.all(specs.map(s => this._deps.previewAlterComposite(s)))).map(p => p.sql).join(";\n"),
            execute:     this._deps.execute,
            onSuccess:   () => void this.handleSuccess(),
            onError:     this._deps.onError,
        });
    }

    /**
     * Diff the enum-label grid's current rows against `this._original.labels`
     * and, if anything changed, open the shared SQL preview dialog: a
     * `recreate` plan previews its live renames (see {@link EnumEditPlan}'s
     * doc) then the migration script, an `alter` plan previews its renames
     * then its adds (see the plan's "Renames are emitted before adds" rule)
     * — both join every previewed statement into one script. A diff error (a
     * blank rename, every label deleted) and a `{kind: "none"}` diff are both
     * reported through `_deps` without opening a dialog.
     */
    private saveEnum(): void {
        let plan: EnumEditPlan;

        try {
            plan = diffEnumLabels(this._deps.schema, this._deps.name, this._original.labels, this.readEditedLabelRows());
        } catch (err) {
            this._deps.onError(err instanceof Error ? err.message : String(err));

            return;
        }

        if (plan.kind === "none") {
            this._deps.onStatus("No changes");

            return;
        }

        const resolvedPlan = plan;

        openSqlPreviewDialog({
            title:       "Alter enum type",
            form:        summaryPanel(describeEnumPlan(resolvedPlan)),
            generateSql: async () => {
                if (resolvedPlan.kind === "recreate") {
                    // liveRenames (not the full renames list) run first,
                    // against the *original* type: this is how a held row's
                    // data reads back under the post-rename spelling by the
                    // time the migration casts it through `::text` (see
                    // EnumEditPlan's doc). The one rename EnumEditPlan
                    // excludes from liveRenames — its target collides with a
                    // label this same edit also removes — is never run live
                    // at all; the recreate step's own CREATE TYPE already
                    // builds the fresh type from `spec.labels`, which the
                    // backend also uses (via `spec.renames`, the full set)
                    // to rewrite a dependent column's stale DEFAULT literal.
                    // orderRenamesForExecution further sequences (and, for a
                    // same-edit rotation, temp-labels) whatever's left, so
                    // two renames that collide with *each other* — or with a
                    // label this batch doesn't touch at all — still succeed,
                    // or raise a clear error up front instead of a doomed
                    // live statement (see its own doc).
                    const renamed = await Promise.all(
                        orderRenamesForExecution(resolvedPlan.liveRenames, this._original.labels).map(spec =>
                            this._deps.previewRenameEnumValue(spec)),
                    );
                    const recreated = await this._deps.previewRecreateEnum(resolvedPlan.spec);

                    return [...renamed.map(p => p.sql), recreated.sql].join(";\n");
                }

                // The alter branch has nothing to remove in this same edit,
                // so every kept rename runs live — a rename must land
                // against the *original* type/label text before anything
                // else touches it (see EnumEditPlan's doc), in the order
                // orderRenamesForExecution works out.
                const renamed = await Promise.all(
                    orderRenamesForExecution(resolvedPlan.renames, this._original.labels).map(spec =>
                        this._deps.previewRenameEnumValue(spec)),
                );
                const added   = await Promise.all(resolvedPlan.adds.map(spec => this._deps.previewAddEnumValue(spec)));

                return [...renamed, ...added].map(p => p.sql).join(";\n");
            },
            execute:   this._deps.execute,
            onSuccess: () => void this.handleSuccess(),
            onError:   this._deps.onError,
        });
    }

    /**
     * Read the composite-attribute grid's current rows into the shape
     * {@link diffCompositeAttributeSpecs} compares, off the store's master
     * list (`getAll()`) so a header sort never changes the diff's row order.
     */
    private readEditedAttributeRows(): EditedAttributeRow[] {
        return this._store.getAll().map((r: ModelRecord) => ({
            originalName: String(r.get("originalName") ?? ""),
            name:         String(r.get("name") ?? ""),
            type:         String(r.get("type") ?? ""),
        }));
    }

    /**
     * Read the enum-label grid's current rows into the shape
     * {@link diffEnumLabels} compares, off the store's master list
     * (`getAll()`) so a header sort never changes the diff's row order.
     */
    private readEditedLabelRows(): EditedLabelRow[] {
        return this._store.getAll().map((r: ModelRecord) => ({
            originalLabel: String(r.get("originalLabel") ?? ""),
            label:         String(r.get("label") ?? ""),
        }));
    }

    // Registered by reference on the store's "datachange" event — an
    // arrow-function field (COMPONENT_CONVENTIONS.md (c)).
    private syncSaveEnabled = (): void => {
        this._saveButton.setEnabled(this._store.hasPendingChanges());
    };

    /** After a successful execute: reload the detail and refresh the tab in place. */
    private async handleSuccess(): Promise<void> {
        this.reload(await this._deps.reloadDetail());
        this._deps.onStatus(`${this._deps.name}: altered`);
    }

    /**
     * Reseed the Category/Owner rows and the body grid after a successful
     * Refresh or Save.
     *
     * @param detail - the freshly re-fetched type definition.
     * @throws Error when `detail.category` differs from the category the
     *   panel was constructed for — PostgreSQL has no statement that converts
     *   an enum to a composite or back in place, so the grid's columns (fixed
     *   at construction) cannot be reseeded across that flip.
     */
    reload(detail: TypeDefinition): void {
        if (detail.category !== this._category) {
            throw new Error(
                `${this._deps.schema}.${this._deps.name} is now a ${detail.category} type, `
                + `not ${this._category}; close and reopen the tab`,
            );
        }

        this._categoryText.setText(categoryLabel(detail.category));
        this._ownerText.setText(detail.owner);

        // Drop the grid's selection before reseeding — mirrors
        // StructurePanel.ts's `reseed` helper. `loadData` alone does not
        // clear it (the grid's own selection tracking is untouched by a
        // store reseed), which would otherwise leave Delete enabled with
        // nothing selected, gated on a stale "selection" event that never
        // re-fires.
        this._grid.selectRecord(null);

        // `loadData` replaces the records but leaves pending removals queued
        // (see StructurePanel.reloadColumns's identical note), so `reject()`
        // must precede the reseed — otherwise a queued removal survives into
        // the next Save diff even though the row it named is back.
        this._store.reject();
        this._store.loadData(bodyRows(detail));
        this._original = detail;
        this.syncSaveEnabled();
    }
}

const TypeInfoPanelCallable = callable(TypeInfoPanel);
type TypeInfoPanelCallable = TypeInfoPanel;
export { TypeInfoPanelCallable as TypeInfoPanel };
