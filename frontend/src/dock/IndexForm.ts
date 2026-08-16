// The "Create index" dialog form: an optional name field, a column
// checklist, a unique checkbox, and an access-method combo. Used by the
// controller's createIndex launcher, embedded as a SqlPreviewDialog's `form`.

import { Panel, callable } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { Checkbox, ComboBox, TextField } from "@jimka/typescript-ui/component/input";
import type { IndexSpec } from "../contract";
import { buildIndexSpec, preserveSuggestedColumnOrder } from "./ddlSpecs";
import { ColumnChecklist } from "./ColumnChecklist";

// The index access methods offered, plus a leading "unset" choice that
// leaves Postgres's own default (btree). Matches the backend's
// _INDEX_METHODS allowlist exactly.
const METHOD_UNSET = "";
const METHOD_CHOICES = [METHOD_UNSET, "btree", "hash", "gin", "gist", "spgist", "brin"];

// Vertical gap between the form's fields.
const ROW_SPACING = 6;

/** The create-index form: name, column checklist, unique, and method. */
class IndexForm extends Panel {
    private readonly _schema: string;
    private readonly _table: string;
    private readonly _nameField:   TextField;
    private readonly _checklist:   ColumnChecklist;
    private readonly _uniqueBox:   Checkbox;
    private readonly _methodCombo: ComboBox;
    private readonly _suggestedOrder: string[] | undefined;

    /**
     * @param schema - the table's schema.
     * @param table - the table to index.
     * @param columns - the table's columns, for the checklist.
     * @param initiallySelected - column names to pre-check, in the order they
     *   must appear in the index (the index advisor's suggested columns, when
     *   the form is seeded from one). `readSpec()` honours this order as long
     *   as the checked set stays unchanged — see `preserveSuggestedColumnOrder`.
     */
    constructor(schema: string, table: string, columns: string[], initiallySelected?: string[]) {
        const nameField   = new TextField({ placeholder: "index name (optional)" });
        const checklist   = new ColumnChecklist(columns, initiallySelected);
        const uniqueBox   = Checkbox({ label: "Unique", selected: false });
        const methodCombo = new ComboBox({ items: METHOD_CHOICES, value: METHOD_UNSET });

        super({
            layoutManager: new VBox({ itemAlign: "stretch", spacing: ROW_SPACING }),
            components:    [nameField, checklist, uniqueBox, methodCombo],
        });

        this._schema      = schema;
        this._table       = table;
        this._nameField    = nameField;
        this._checklist    = checklist;
        this._uniqueBox    = uniqueBox;
        this._methodCombo  = methodCombo;
        this._suggestedOrder = initiallySelected;
    }

    /**
     * @returns the `create`-tagged IndexSpec for the form's current fields.
     *   The column order is the seeded suggestion's own order when the
     *   checklist's selection hasn't changed from it, else the checklist's
     *   table-order default (see `preserveSuggestedColumnOrder`).
     */
    readSpec(): IndexSpec {
        return buildIndexSpec(this._schema, "create", {
            table:   this._table,
            columns: preserveSuggestedColumnOrder(this._checklist.readSelected(), this._suggestedOrder),
            name:    this._nameField.getValue() || undefined,
            unique:  this._uniqueBox.getValue(),
            method:  this._methodCombo.getValue() || undefined,
        });
    }
}

const IndexFormCallable = callable(IndexForm);
type IndexFormCallable = IndexForm;
export { IndexFormCallable as IndexForm };
