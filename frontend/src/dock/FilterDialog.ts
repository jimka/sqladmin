// The modal filter dialog: an AND-combined, per-column filter form for a
// table's data grid. It is a thin shell around the pure translation in
// filterModel.ts — it collects one FilterCondition per row from its inputs and
// `buildFilters` them into descriptors to apply, and seeds its rows from the
// store's active filter via `conditionsFromFilters` so reopening it shows the
// filter that is currently applied.
//
// Chosen over an inline per-column filter row because the library's header /
// column geometry is not an app seam (see plans/implemented/grid-filter-sort).
//
// The rows live in a vertically-scrolling viewport capped at VIEWPORT_HEIGHT;
// the dialog re-fits to the form on each add/remove (Dialog.resizeToContent), so
// it grows and shrinks with the rows up to that cap, then the viewport scrolls.
// An "Add condition" button appends rows for more than the initial few criteria,
// and each row's "−" button removes it (down to one).
//
// Behaviour (verified manually — the node-only harness can't drive the inputs,
// focus, scrolling, or the store's network reload):
//   - Apply: clear the store's filter, then apply one descriptor per complete
//     row; an all-empty form therefore just clears the filter.
//   - Clear: clear the store's filter regardless of the form.
//   - Cancel — and every dismiss gesture (Escape, backdrop click, title-bar
//     close), which all resolve to the same result — leave the filter untouched.
// `filterBy` appends, so Apply always `clearFilter()`s first to avoid stacking
// filters across re-applies.

import { Panel }                     from "@jimka/typescript-ui/core";
import type { Component }            from "@jimka/typescript-ui/core";
import { Grid, VBox }          from "@jimka/typescript-ui/layout";
import { ComboBox, TextField }       from "@jimka/typescript-ui/component/input";
import { Button }                    from "@jimka/typescript-ui/component/button";
import { Glyph }                     from "@jimka/typescript-ui/component/display";
import { plus }                      from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus }                     from "@jimka/typescript-ui/glyphs/solid/minus";
import { Dialog }                    from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig }   from "@jimka/typescript-ui/overlay";
import type { AjaxStore }            from "@jimka/typescript-ui/data";
import type { ColumnMeta }           from "../contract";
import { buildFilters, conditionsFromFilters } from "./filterModel";
import type { FilterCondition, FilterOperator } from "./filterModel";
import { Insets } from "@jimka/typescript-ui/primitive";
import { CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR } from "../theme";

Glyph.register(plus, minus);

/** The operators offered by the dialog, paired with a human-readable label. */
const OPERATORS: ReadonlyArray<{ label: string; op: FilterOperator }> = [
    { label: "contains",     op: "contains" },
    { label: "equals",       op: "eq" },
    { label: "not equals",   op: "neq" },
    { label: "greater than", op: "gt" },
    { label: "≥",            op: "gte" },
    { label: "less than",    op: "lt" },
    { label: "≤",            op: "lte" },
    { label: "starts with",  op: "startsWith" },
];

// The dialog opens with this many empty condition rows; the "Add condition"
// button appends more and each row's "−" button removes it (down to one), and a
// row left unset (empty column) is dropped by buildFilters. Reopening a filtered
// store seeds one row per active condition, so the actual starting count is
// max(CONDITION_ROWS, active conditions).
const CONDITION_ROWS = 2;

// Row geometry. Each row tiles a Grid of three weight-tracked input columns plus
// a fixed remove-button column. The inputs share the dialog's inner width in
// these proportions (column : operator : value) rather than taking fixed widths,
// so the fields grow with the dialog instead of sitting squished at a preferred
// size. Rows are a fixed INPUT_HEIGHT tall; DIALOG_WIDTH sets the dialog's width.
const COLUMN_WEIGHT   = 150;
const OPERATOR_WEIGHT = 130;
const VALUE_WEIGHT    = 170;
const INPUT_HEIGHT    = 30;
const ROW_SPACING     = 6;
const DIALOG_WIDTH    = 500;

// The condition rows live in a vertically-scrolling viewport that grows with the
// rows up to this cap (six rows plus their inter-row gaps): below the cap the
// viewport hugs its rows so the Add button sits directly beneath the last one;
// at the cap it stops growing and further rows scroll into view.
const VIEWPORT_HEIGHT = (6 * INPUT_HEIGHT) + (5 * ROW_SPACING);

/** The empty column choice that marks a condition row as unset (dropped on Apply). */
const NO_COLUMN = "";

/** One condition row's live handles: its grid cells, a reader, and its remove button. */
interface RowHandle {

    /** The row's cells in column order: column combo, operator combo, value field, remove button. */
    inputs: Component[];

    /** Snapshots the row's current inputs into a FilterCondition. */
    read: () => FilterCondition;

    /** The row's remove button (disabled by syncGrid when it is the only row). */
    removeButton: Button;
}

/**
 * Open the filter dialog for a store. On Apply, translate the form's rows into
 * FilterDescriptors and apply them (AND-combined) to the store; on Clear, clear
 * the store's filter; on Cancel or any dismiss gesture, do nothing.
 *
 * @param store - the table's AjaxStore (remoteFilter drives the server reload).
 * @param columns - the table's introspected columns, for the column list and coercion.
 */
export function openFilterDialog(store: AjaxStore, columns: ColumnMeta[]): void {
    // Seed the form with the store's active filter so reopening the dialog shows
    // (and edits) the filter that is currently applied; an unfiltered store
    // seeds nothing and the form opens with empty rows.
    const initial = conditionsFromFilters(store.getActiveFilters());
    // The resize hook is wired to the dialog once it exists (see runFilterDialog);
    // until then it's a no-op, so the initial rows don't try to resize a dialog
    // that hasn't been constructed yet.
    const resizer = { fit: () => {} };
    const { form, readConditions } = buildConditionForm(columns, initial, () => resizer.fit());

    void runFilterDialog(store, columns, form, readConditions, resizer);
}

/**
 * Show the dialog and dispatch on the button pressed. Kept separate from
 * `openFilterDialog` so the public entry point stays synchronous (void).
 *
 * @param store - the table's store.
 * @param columns - the table's columns, for coercion in buildFilters.
 * @param form - the built condition form to host as the dialog content.
 * @param readConditions - reads the current condition rows from the form.
 */
async function runFilterDialog(
    store: AjaxStore,
    columns: ColumnMeta[],
    form: Panel,
    readConditions: () => FilterCondition[],
    resizer: { fit: () => void },
): Promise<void> {
    const dialog = new Dialog({
        title:            "Filter rows",
        contentComponent: form,
        width:            DIALOG_WIDTH,
        buttons:          [CANCEL_BUTTON, CLEAR_BUTTON, APPLY_BUTTON],
    });

    // Now that the dialog exists, adding/removing a row re-fits it to the form's
    // new height (up to the viewport cap), so it grows and shrinks with the rows.
    resizer.fit = () => dialog.resizeToContent();

    const result = await dialog.show();

    // Apply commits the form; Clear (result "cancel") drops the filter; Cancel
    // (result "close") — and every dismiss gesture, which the library also
    // resolves to "close" — leaves the active filter untouched.
    if (result === "confirm") {
        await applyFilters(store, columns, readConditions());

        return;
    }

    if (result === "cancel") {
        await store.clearFilter();
    }
}

// The Dialog exposes only three result codes ("confirm" | "cancel" | "close"),
// and every dismiss gesture (Escape, backdrop click, title-bar close) resolves
// to "close". To keep dismissing safe, the Cancel button carries "close" too,
// so a dismiss behaves exactly like Cancel (leave the filter untouched); the
// explicit Clear button therefore takes the remaining "cancel" code, and Apply
// takes "confirm". Glyphs are omitted so no consumer-registered glyph is needed.
const APPLY_BUTTON: DialogButtonConfig = { text: "Apply", result: "confirm", primary: true };

/** Clear button — drops the active filter regardless of the form. */
const CLEAR_BUTTON: DialogButtonConfig = { text: "Clear", result: "cancel" };

/** Cancel button — shares "close" with every dismiss gesture, so both no-op. */
const CANCEL_BUTTON: DialogButtonConfig = { text: "Cancel", result: "close" };

/**
 * Clear the store's filter, then apply one descriptor per complete condition.
 * `filterBy` appends, so the leading `clearFilter` prevents re-applies from
 * stacking; an empty descriptor list therefore just clears the filter.
 *
 * @param store - the table's store.
 * @param columns - the table's columns, for wire-type coercion.
 * @param conditions - the rows collected from the form.
 */
async function applyFilters(store: AjaxStore, columns: ColumnMeta[], conditions: FilterCondition[]): Promise<void> {
    const filters = buildFilters(conditions, columns);

    await store.clearFilter();

    for (const filter of filters) {
        await store.filterBy(filter);
    }
}

/**
 * Build the form — a scrolling grid of condition rows plus an "Add condition"
 * button — and a reader that snapshots the rows.
 *
 * @param columns - the table's columns; each row's column list is drawn from these.
 * @param initial - conditions to seed the rows with (the store's active filter); the
 *   form opens with one row per seed, padded to at least CONDITION_ROWS empty rows.
 * @returns the form panel and a function reading the current conditions in row order.
 */
function buildConditionForm(
    columns: ColumnMeta[],
    initial: FilterCondition[],
    onContentChange: () => void,
): { form: Panel; readConditions: () => FilterCondition[] } {
    const rows: RowHandle[] = [];

    // A single Grid tiles every row: three weighted input columns share the
    // dialog width (so the inputs stretch to fill it instead of sitting at a
    // fixed, squished width) plus a fixed remove-button column, and the grid's
    // default fill (BOTH) makes each cell's child fill it. Auto-flow lays the
    // flattened cells out left-to-right, top-to-bottom, one row per four; the row
    // count and tracks are (re)synced by syncGrid as rows are added/removed.
    const grid = new Grid({
        columns:      4,
        spacing:      ROW_SPACING,
        columnTracks: [
            { mode: "weight", value: COLUMN_WEIGHT },
            { mode: "weight", value: OPERATOR_WEIGHT },
            { mode: "weight", value: VALUE_WEIGHT },
            { mode: "content" },
        ],
    });

    // The scrolling viewport hosting the grid. It is NOT pinned: with no explicit
    // preferred height it reports the grid's content height, so it hugs the rows
    // and grows as they are added — keeping the Add button directly beneath the
    // last row. `maxSize.height = VIEWPORT_HEIGHT` caps that growth, and
    // `autoScroll: "y"` scrolls the overflow once the rows exceed the cap.
    const viewport = Panel({
        autoScroll:    "y",
        layoutManager: grid,
        insets:       new Insets(0, 0, 0, 0),
        maxSize:       { width: Number.MAX_VALUE, height: VIEWPORT_HEIGHT },
    });

    // The Add button sits in its own fixed-height row beneath the viewport; the
    // flex spacer keeps the glyph button compact rather than stretching it across.
    // glyphColor tints only the glyph green (its SVG fills with `currentColor`),
    // leaving the button's own color unset so the label stays default black.
    const addButton = Button({
        glyph:           "plus",
        text:            "Add condition",
        showText:        true,
        showDescription: false,
        compact:         true,
        glyphColor:      CONSTRUCTIVE_COLOR,
    });
    addButton.on("action", () => appendRow());

    // The form takes its natural (content-sized) height: the VBox packs the
    // content-sized viewport and the Add row, so its preferred height is the Add
    // button plus the viewport's rows (capped at VIEWPORT_HEIGHT). The host dialog
    // re-fits to that height on each add/remove (see onContentChange), so the
    // dialog grows and shrinks with the rows instead of staying a constant size.
    // The dialog forces the content width, so the form needs no explicit width.
    const form = Panel({
        layoutManager: new VBox({ spacing: ROW_SPACING }),
        components:    [addButton, viewport],
    });

    // Resize the grid to the current row count (every row a fixed-height track)
    // and keep the sole remaining row's remove button disabled — the form always
    // keeps at least one condition row. Adding/removing a row's cells on the
    // viewport propagates a preferred-size change up to the form (and on to the
    // dialog), so the form's VBox re-measures the viewport at its new content
    // height and repositions the Add button without an explicit relayout here.
    const syncGrid = (): void => {
        grid.setRows(rows.length);

        const soleRow = rows.length === 1;

        for (const row of rows) {
            row.removeButton.setEnabled(!soleRow);
        }

        // Let the host dialog re-fit to the form's new preferred height (grow on
        // add, shrink on remove) up to the viewport cap. A no-op until the dialog
        // wires it after construction, so the initial rows added below don't fire.
        onContentChange();
    };

    const removeRow = (row: RowHandle): void => {
        const index = rows.indexOf(row);

        if (index < 0 || rows.length <= 1) {
            return;
        }

        for (const input of row.inputs) {
            viewport.removeComponent(input);
        }

        rows.splice(index, 1);
        syncGrid();
    };

    function appendRow(seed?: FilterCondition): void {
        const row = buildConditionRow(columns, seed, () => removeRow(row));

        rows.push(row);

        for (const input of row.inputs) {
            viewport.addComponent(input);
        }

        syncGrid();
    }

    // Open with one row per seeded condition, padded to at least CONDITION_ROWS
    // so an unfiltered (or lightly filtered) store still shows a few empty rows.
    const rowCount = Math.max(CONDITION_ROWS, initial.length);

    for (let i = 0; i < rowCount; i += 1) {
        appendRow(initial[i]);
    }

    return { form, readConditions: () => rows.map(r => r.read()) };
}

/**
 * Build one condition row — a column ComboBox, an operator ComboBox, a value
 * TextField, and a remove ("−") button — returned as the four cells (which the
 * caller tiles into a Grid), with a reader that snapshots the inputs and a handle
 * to the remove button. A `seed` pre-selects the inputs so a reopened dialog
 * shows the active filter.
 *
 * The column combo uses plain-string items — a ComboBox keys a plain string by
 * its own value, so `getValue` round-trips the column name. The operator combo
 * carries explicit-keyed items ({@link SelectableListItem}) because its display label
 * differs from its operator key, so it can't ride the plain-string default.
 *
 * @param columns - the table's columns; the column list is these plus an empty (unset) choice.
 * @param seed - a condition to pre-fill the row with, or undefined for an empty row.
 * @param onRemove - invoked when the row's remove button is pressed.
 * @returns the row's cells (input columns then remove button), a reader, and the remove button.
 */
function buildConditionRow(columns: ColumnMeta[], seed: FilterCondition | undefined, onRemove: () => void): RowHandle {
    const columnCombo = new ComboBox({
        items: [NO_COLUMN, ...columns.map(c => c.name)],
        value: seed?.field ?? NO_COLUMN,
    });
    const operatorCombo = new ComboBox({
        items: OPERATORS.map(o => ({ key: o.op, label: o.label })),
        value: seed?.operator ?? OPERATORS[0].op,
    });
    const valueField = new TextField({ placeholder: "value", text: seed?.value ?? "" });

    // Glyph-only "−" (label lives in the tooltip / aria-label, per the toolbar
    // convention); syncGrid disables it on the last remaining row.
    const removeButton = Button({
        glyph:           "minus",
        text:            "Remove condition",
        showText:        false,
        showDescription: false,
        foregroundColor: DESTRUCTIVE_COLOR,
        compact:         true,
    });
    removeButton.on("action", onRemove);

    const read = (): FilterCondition => ({
        field:    columnCombo.getValue(),
        operator: operatorFromKey(operatorCombo.getValue()),
        value:    valueField.getValue(),
    });

    return { inputs: [columnCombo, operatorCombo, valueField, removeButton], read, removeButton };
}

/**
 * Resolve an operator combo's selected key back to a FilterOperator. The keys are
 * the operator keys themselves, so this is a validated cast defaulting to the
 * first operator if the key is somehow unrecognised.
 *
 * @param key - the operator combo's selected key.
 * @returns the matching FilterOperator, or the first operator as a fallback.
 */
function operatorFromKey(key: string): FilterOperator {
    return OPERATORS.find(o => o.op === key)?.op ?? OPERATORS[0].op;
}
