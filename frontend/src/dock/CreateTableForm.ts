// The CREATE TABLE form: a table-name field plus an add/remove-row column
// grid — a weighted Grid whose tracks share the tab's width (see
// COLUMN_WEIGHT below), so the inputs stretch to fill it instead of sitting
// squished at a fixed width. The column rows themselves collect raw
// name/type/default/nullable/primaryKey fields; readSpec() hands them to the
// pure buildCreateTableSpec helper. The row grid itself is RowGridPanel's —
// see that module for the shared add/remove-row mechanics and the leak its
// disposal fixes.

import { callable } from "@jimka/typescript-ui/core";
import { Checkbox, TextField } from "@jimka/typescript-ui/component/input";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import type { CreateTableSpec } from "../contract";
import { buildCreateTableSpec } from "./ddlSpecs";
import type { ColumnRow } from "./ddlSpecs";
import { DESTRUCTIVE_COLOR } from "../theme";
import { RowGridPanel } from "./RowGridPanel";
import type { RowGridRow } from "./RowGridPanel";

Glyph.register(minus);

// Row geometry: name/type/default share the dialog width by weight; the
// nullable/PK checkboxes and the remove button are content-sized — the
// weighted-Grid row idiom this app's dialogs use, tuned here for four
// extra fields.
const NAME_WEIGHT    = 130;
const TYPE_WEIGHT    = 120;
const DEFAULT_WEIGHT = 130;

/**
 * The CREATE TABLE form: a table-name field over an add/remove-row column
 * grid. Embedded as a `DdlFormPanel` dock tab's form by the controller's
 * `createTable` launcher.
 */
class CreateTableForm extends RowGridPanel<ColumnRow> {
    private readonly _schema: string;
    private readonly _nameField: TextField;

    /**
     * @param schema - the schema the new table is created in (fixed — the
     *   launcher is invoked from that schema's navigator node).
     */
    constructor(schema: string) {
        const nameField = new TextField({ placeholder: "table name" });

        super({
            header:       [nameField],
            addLabel:     "Add column",
            // Six cells: name, type, nullable, default, primary-key, remove
            // — matches buildColumnRow's six-cell row below.
            columnTracks: [
                { mode: "weight", value: NAME_WEIGHT },
                { mode: "weight", value: TYPE_WEIGHT },
                { mode: "content" }, // nullable checkbox
                { mode: "weight", value: DEFAULT_WEIGHT },
                { mode: "content" }, // primary-key checkbox
                { mode: "content" }, // remove button
            ],
            buildRow: buildColumnRow,
        });

        this._schema    = schema;
        this._nameField = nameField;

        this.appendRow(); // seed with one empty row
    }

    /**
     * @returns the CreateTableSpec for the form's current name + rows
     *   (rows with a blank name are dropped by buildCreateTableSpec).
     */
    readSpec(): CreateTableSpec {
        return buildCreateTableSpec(this._schema, this._nameField.getValue(), this.readRows());
    }
}

/**
 * Build one column row — name/type TextFields, nullable/PK Checkboxes, a
 * default TextField, and a remove ("−") button — as the six cells the caller
 * tiles into the grid, with a reader that snapshots them into a ColumnRow.
 *
 * @param onRemove - invoked when the row's remove button is pressed.
 * @returns the row's cells, a reader, and the remove button.
 */
function buildColumnRow(onRemove: () => void): RowGridRow<ColumnRow> {
    const nameField     = new TextField({ placeholder: "column name" });
    const typeField      = new TextField({ placeholder: "type, e.g. text" });
    const nullableBox   = Checkbox({ label: "Null", selected: true });
    const defaultField  = new TextField({ placeholder: "default (optional)" });
    const primaryKeyBox = Checkbox({ label: "PK", selected: false });

    const removeButton = Button({
        glyph: "minus", text: "Remove column", showText: false, showDescription: false,
        foregroundColor: DESTRUCTIVE_COLOR, compact: true,
    });
    removeButton.on("action", onRemove);

    const read = (): ColumnRow => ({
        name:       nameField.getValue(),
        type:       typeField.getValue(),
        nullable:   nullableBox.getValue(),
        default:    defaultField.getValue(),
        primaryKey: primaryKeyBox.getValue(),
    });

    return {
        cells: [nameField, typeField, nullableBox, defaultField, primaryKeyBox, removeButton],
        read,
        removeButton,
    };
}

const CreateTableFormCallable = callable(CreateTableForm);
type CreateTableFormCallable = CreateTableForm;
export { CreateTableFormCallable as CreateTableForm };
