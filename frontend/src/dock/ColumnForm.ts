// The Add-Column dialog form: a vertical single-column field group
// (name/type/nullable/default). Used by the controller's addColumn
// launcher, embedded as a SqlPreviewDialog's `form`.

import { Panel } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { Checkbox, TextField } from "@jimka/typescript-ui/component/input";
import type { ColumnSpec } from "../contract";

// Vertical gap between the field rows — a compact, single-column form.
const ROW_SPACING = 6;

/** The ADD COLUMN form: name, type, nullable, and default fields. */
export class ColumnForm extends Panel {
    private readonly _nameField:    TextField;
    private readonly _typeField:    TextField;
    private readonly _nullableBox:  Checkbox;
    private readonly _defaultField: TextField;

    constructor() {
        const nameField    = new TextField({ placeholder: "column name" });
        const typeField    = new TextField({ placeholder: "type, e.g. text" });
        const nullableBox  = Checkbox({ label: "Nullable", selected: true });
        const defaultField = new TextField({ placeholder: "default (optional)" });

        super({
            layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }),
            components:    [nameField, typeField, nullableBox, defaultField],
        });

        this._nameField    = nameField;
        this._typeField    = typeField;
        this._nullableBox  = nullableBox;
        this._defaultField = defaultField;
    }

    /**
     * @returns the new column's spec, with an empty default carried as
     *   `null` (the wire contract's "no default" value).
     */
    readColumn(): ColumnSpec {
        const defaultText = this._defaultField.getValue();

        return {
            name:       this._nameField.getValue(),
            type:       this._typeField.getValue(),
            nullable:   this._nullableBox.getValue(),
            default:    defaultText.trim() === "" ? null : defaultText,
            primaryKey: false,
        };
    }
}
