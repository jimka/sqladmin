// The modal filter dialog: a small AND-combined, per-column filter form for a
// table's data grid. It is a thin shell around the pure `buildFilters`
// translation (filterModel.ts) — it collects one FilterCondition per row from
// its inputs, builds the descriptors, and applies them to the store.
//
// Chosen over an inline per-column filter row because the library's header /
// column geometry is not an app seam (see plans/implemented/grid-filter-sort).
//
// Behaviour (verified manually — the node-only harness can't drive the inputs,
// focus, or the store's network reload):
//   - Apply: clear the store's filter, then apply one descriptor per complete
//     row; an all-empty form therefore just clears the filter.
//   - Clear: clear the store's filter regardless of the form.
//   - Cancel — and every dismiss gesture (Escape, backdrop click, title-bar
//     close), which all resolve to the same result — leave the filter untouched.
// `filterBy` appends, so Apply always `clearFilter()`s first to avoid stacking
// filters across re-applies.

import { Panel }                     from "@jimka/typescript-ui/core";
import { HBox, VBox }                from "@jimka/typescript-ui/layout";
import { ComboBox, TextField }       from "@jimka/typescript-ui/component/input";
import { Dialog }                    from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig }   from "@jimka/typescript-ui/overlay";
import type { AjaxStore }            from "@jimka/typescript-ui/data";
import type { ColumnMeta }           from "../contract";
import { buildFilters }              from "./filterModel";
import type { FilterCondition, FilterOperator } from "./filterModel";

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

// The dialog ships a fixed, small set of condition rows instead of an add-row
// affordance: three is enough to AND a couple of conditions in the first cut,
// and each row left unset (empty column) is dropped by buildFilters.
const CONDITION_ROWS = 3;

// Input geometry, in CSS px. Tuned so the three inputs sit comfortably on one
// row inside the dialog; the dialog width is the sum plus inter-input spacing
// and the dialog's own horizontal insets.
const COLUMN_WIDTH   = 150;
const OPERATOR_WIDTH = 130;
const VALUE_WIDTH    = 170;
const INPUT_HEIGHT   = 30;
const ROW_SPACING    = 6;
const DIALOG_WIDTH   = 500;

/** The empty column choice that marks a condition row as unset (dropped on Apply). */
const NO_COLUMN = "";

/**
 * Open the filter dialog for a store. On Apply, translate the form's rows into
 * FilterDescriptors and apply them (AND-combined) to the store; on Clear, clear
 * the store's filter; on Cancel or any dismiss gesture, do nothing.
 *
 * @param store - the table's AjaxStore (remoteFilter drives the server reload).
 * @param columns - the table's introspected columns, for the column list and coercion.
 */
export function openFilterDialog(store: AjaxStore, columns: ColumnMeta[]): void {
    const { form, readConditions } = buildConditionForm(columns);

    void runFilterDialog(store, columns, form, readConditions);
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
): Promise<void> {
    const result = await Dialog.show({
        title:            "Filter rows",
        contentComponent: form,
        width:            DIALOG_WIDTH,
        buttons:          [CANCEL_BUTTON, CLEAR_BUTTON, APPLY_BUTTON],
    });

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
 * Build the VBox form of condition rows and a reader that snapshots them.
 *
 * @param columns - the table's columns; each row's column list is drawn from these.
 * @returns the form panel and a function reading the current conditions in row order.
 */
function buildConditionForm(columns: ColumnMeta[]): { form: Panel; readConditions: () => FilterCondition[] } {
    const rows = Array.from({ length: CONDITION_ROWS }, () => buildConditionRow(columns));

    const form = Panel({
        layoutManager: new VBox({ spacing: ROW_SPACING }),
        components:    rows.map(r => r.row),
    });

    form.setPreferredSize(DIALOG_WIDTH, CONDITION_ROWS * INPUT_HEIGHT + (CONDITION_ROWS - 1) * ROW_SPACING);

    return { form, readConditions: () => rows.map(r => r.read()) };
}

/**
 * Build one condition row — a column ComboBox, an operator ComboBox, and a value
 * TextField — laid out horizontally, with a reader that snapshots its inputs.
 *
 * @param columns - the table's columns; the column list is these plus an empty (unset) choice.
 * @returns the row panel and a function reading its current FilterCondition.
 */
function buildConditionRow(columns: ColumnMeta[]): { row: Panel; read: () => FilterCondition } {
    const columnCombo = new ComboBox({ items: [NO_COLUMN, ...columns.map(c => c.name)], selectedIndex: 0 });
    const operatorCombo = new ComboBox({ items: OPERATORS.map(o => o.label), selectedIndex: 0 });
    const valueField = new TextField({ placeholder: "value" });

    columnCombo.setPreferredSize(COLUMN_WIDTH, INPUT_HEIGHT);
    operatorCombo.setPreferredSize(OPERATOR_WIDTH, INPUT_HEIGHT);
    valueField.setPreferredSize(VALUE_WIDTH, INPUT_HEIGHT);

    const row = Panel({
        layoutManager: new HBox({ spacing: ROW_SPACING }),
        components:    [columnCombo, operatorCombo, valueField],
    });

    const read = (): FilterCondition => ({
        field:    columnCombo.getValue(),
        operator: operatorForLabel(operatorCombo.getValue()),
        value:    valueField.getValue(),
    });

    return { row, read };
}

/**
 * Map an operator ComboBox label back to its FilterOperator key.
 *
 * @param label - the selected operator label.
 * @returns the matching operator key, defaulting to "contains" if unrecognised.
 */
function operatorForLabel(label: string): FilterOperator {
    return OPERATORS.find(o => o.label === label)?.op ?? "contains";
}
