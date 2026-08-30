// The dock work panel for one standalone enum or composite type's read-only
// detail: its category and owning role, plus its ordered enum labels or
// composite attributes — shown in its own tab opened from the navigator's
// double-click / "Show info" context item on a Types-category leaf.
//
// Read-only throughout, like IndexInfoPanel: type creation/editing/dropping
// already live on the navigator's create/edit/drop DDL flows, so this tab has
// no Save toolbar and no dirty tracking — just a Refresh button. The body is a
// grid rather than a CodeEditor, unlike FunctionDefinitionPanel: a type has no
// catalog-authoritative definition text (there is no `pg_get_typedef` for a
// standalone type), and its payload — an ordered label/attribute list — is a
// variable-length shape a grid fits better than a fixed field set.
//
// The two possible payload shapes (enum labels vs. composite attributes) are
// chosen once at construction, from `detail.category`: a category cannot
// change in place in PostgreSQL, so `reload` never has to swap the grid's
// columns — it throws instead if a re-fetched category ever disagrees (see
// `reload`'s doc).
//
// Needs no disposal of its own: this panel `extends`-es a library base rather
// than composing one, so every child (the toolbar, the LabeledFieldSet's Text
// rows, the grid) is a registered descendant, and the Dock's teardown on tab
// close reaches each one, same as IndexInfoPanel.

import { Container, callable }         from "@jimka/typescript-ui/core";
import { Border as BorderLayout }      from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Text }                        from "@jimka/typescript-ui/component/input";
import { LabeledFieldSet, Spacer }     from "@jimka/typescript-ui/component/container";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import { Table }                       from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }             from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model }          from "@jimka/typescript-ui/data";
import type { FieldOptions }           from "@jimka/typescript-ui/data";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import { glyphButton }                 from "./glyphButton";
import { REFRESH_SHORTCUT }            from "../shell/queryShortcuts";
import { PRIMARY_COLOR }               from "../theme";
import { categoryLabel, enumLabelRows } from "./typeInfoRows";
import type { TypeDefinition }         from "../contract";

Glyph.register(refresh);

// This grid's own auto-width cap, matching columnsGrid.ts's CONTENT_WIDTH_CAP:
// declaring it on every column but `filler` excludes those columns from the
// library's leftover-width split, so `filler` alone absorbs whatever width
// remains instead of Name/Type stretching to fill the panel (see
// columnsGrid.ts's CONTENT_WIDTH_CAP comment for the full mechanism).
const CONTENT_WIDTH_CAP = 400;

// Vertical gap between the fieldset and the body grid — this app's usual
// dialog/panel content spacing (see e.g. ImportRowsDialog.ts's and
// SqlPreviewDialog.ts's own CONTENT_SPACING).
const CONTENT_SPACING = 8;

/** The enum body grid's fields: 1-based catalog order, the label text, then a blank filler. */
const ENUM_FIELDS: FieldOptions[] = [
    { name: "position", type: "number", description: "Order", order: 1 },
    { name: "label",    type: "string", description: "Label", order: 2 },
    { name: "filler",   type: "string", description: "",      order: 3 },
];

/** The composite body grid's fields: attribute name, its type, then a blank filler. */
const ATTRIBUTE_FIELDS: FieldOptions[] = [
    { name: "name",   type: "string", description: "Attribute", order: 1 },
    { name: "type",   type: "string", description: "Type",      order: 2 },
    { name: "filler", type: "string", description: "",          order: 3 },
];

/**
 * A read-only grid over `store`, with `realColumns` capped at
 * {@link CONTENT_WIDTH_CAP} and a blank `filler` column absorbing the panel's
 * leftover width — mirrors columnsGrid.ts's `linkedColumnsTable`, which
 * applies the same pattern to the Columns grid.
 *
 * @param store - the grid's backing store.
 * @param realColumns - the store's fields to show, in display order (`filler`
 *   excluded — it's appended here).
 */
function bodyTable(store: MemoryStore, realColumns: string[]): Table {
    const spec: ColumnSpec = {
        columns: [
            ...realColumns.map((field) => ({ field, maxWidth: CONTENT_WIDTH_CAP })),
            { field: "filler", headerText: "", minWidth: 0, unhideable: true, readOnly: true },
        ],
        autoSizeColumns: true,
        appendUnlisted:  false,
        rowReadOnly:     () => true,
    };

    return Table(store, spec);
}

/**
 * The body grid's row data for a detail: an enum's labels numbered 1..n, or a
 * composite's attributes passed straight through (their `{name, type}` shape
 * already matches `ATTRIBUTE_FIELDS`).
 */
function bodyRows(detail: TypeDefinition): object[] {
    return detail.category === "enum" ? enumLabelRows(detail.labels) : detail.attributes;
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

/** Dependencies {@link TypeInfoPanel} needs for its fieldset legend and Refresh. */
export interface TypeInfoPanelDeps {
    schema: string;
    name: string;

    /** Re-fetch this type's definition and reseed the tab in place. */
    onRefresh: () => void;
}

/** A tab-filling, read-only view of one type's category, owner, and payload. */
class TypeInfoPanel extends Container {
    private readonly _schema: string;
    private readonly _name: string;
    private readonly _categoryText: Text;
    private readonly _ownerText: Text;
    private readonly _store: MemoryStore;
    // The category the body grid's columns were built for — reload() refuses
    // to reseed across a category flip (see reload's doc).
    private readonly _category: TypeDefinition["category"];

    /**
     * @param detail - the type's category, owner, and labels/attributes,
     *   fetched by the controller before construction.
     * @param deps - the schema/name (for the fieldset legend and reload's
     *   error message) and the "refresh" callback.
     */
    constructor(detail: TypeDefinition, deps: TypeInfoPanelDeps) {
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

        // Flex spacer pushes Refresh to the far right rather than leaving it
        // pinned at the toolbar's left edge — matches the other info tabs'
        // Refresh placement.
        const toolbar = new ToolBar({
            components: [Spacer.flex(), glyphButton("refresh", PRIMARY_COLOR, `Refresh (${REFRESH_SHORTCUT})`, () => deps.onRefresh())],
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

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this._schema       = deps.schema;
        this._name         = deps.name;
        this._categoryText = categoryText;
        this._ownerText    = ownerText;
        this._store        = store;
        this._category     = detail.category;

        this.addComponent(toolbar, { placement: Placement.NORTH });
        this.addComponent(content, { placement: Placement.CENTER });
    }

    /**
     * Reseed the Category/Owner rows and the body grid after a successful
     * Refresh.
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
                `${this._schema}.${this._name} is now a ${detail.category} type, `
                + `not ${this._category}; close and reopen the tab`,
            );
        }

        this._categoryText.setText(categoryLabel(detail.category));
        this._ownerText.setText(detail.owner);
        this._store.loadData(bodyRows(detail));
    }
}

const TypeInfoPanelCallable = callable(TypeInfoPanel);
type TypeInfoPanelCallable = TypeInfoPanel;
export { TypeInfoPanelCallable as TypeInfoPanel };
