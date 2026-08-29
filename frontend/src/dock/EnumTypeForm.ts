// The CREATE TYPE ... AS ENUM form: a name field plus an add/remove-row
// label grid, built on the shared RowGridPanel base (see that module for the
// add/remove-row mechanics).

import { callable } from "@jimka/typescript-ui/core";
import { TextField } from "@jimka/typescript-ui/component/input";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import type { CreateEnumTypeSpec } from "../contract";
import { buildCreateEnumTypeSpec } from "./ddlSpecs";
import { DESTRUCTIVE_COLOR } from "../theme";
import { RowGridPanel } from "./RowGridPanel";
import type { RowGridRow } from "./RowGridPanel";

Glyph.register(minus);

// One label row has two cells: the label field and the remove button.
const LABEL_WEIGHT = 200;

/**
 * The CREATE TYPE ... AS ENUM form: a type-name field over an add/remove-row
 * label grid. Embedded as a `DdlFormPanel` dock tab's form by the
 * controller's `createType` launcher (enum category).
 */
class EnumTypeForm extends RowGridPanel<string> {
    private readonly _schema: string;
    private readonly _nameField: TextField;

    /**
     * @param init - `schema` fixes the new type's schema (the launcher is
     *   invoked from that schema's navigator node).
     */
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
        this.appendRow(); // seed with two empty rows — an enum needs at least one label to be useful
    }

    /**
     * @returns the CreateEnumTypeSpec for the form's current name + labels
     *   (blank labels are dropped by buildCreateEnumTypeSpec).
     */
    readSpec(): CreateEnumTypeSpec {
        return buildCreateEnumTypeSpec(this._schema, this._nameField.getValue(), this.readRows());
    }
}

/**
 * Build one label row — a text field and a remove ("−") button — as the two
 * cells the caller tiles into the grid, with a reader that snapshots the
 * field's current text.
 *
 * @param onRemove - invoked when the row's remove button is pressed.
 * @returns the row's cells, a reader, and the remove button.
 */
function buildLabelRow(onRemove: () => void): RowGridRow<string> {
    const labelField = new TextField({ placeholder: "label" });

    const removeButton = Button({
        glyph: "minus", text: "Remove label", showText: false, showDescription: false,
        foregroundColor: DESTRUCTIVE_COLOR, compact: true,
    });
    removeButton.on("action", onRemove);

    return {
        cells: [labelField, removeButton],
        read: () => labelField.getValue(),
        removeButton,
    };
}

const EnumTypeFormCallable = callable(EnumTypeForm);
type EnumTypeFormCallable = EnumTypeForm;
export { EnumTypeFormCallable as EnumTypeForm };
