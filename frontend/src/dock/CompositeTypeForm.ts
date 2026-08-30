// The CREATE TYPE ... AS (...) composite-type form: a name field plus
// an add/remove-row (name, type) attribute grid, built on the shared
// RowGridPanel base. An optional `prefill` (edit mode — see the
// function-type-ddl plan's "composite recreate" decision: restructuring an
// existing composite in place is a Non-Goal, so editing one only clones its
// current attributes into a fresh CREATE TYPE for the user to reconcile with
// the original) seeds the grid instead of one empty row.

import { callable } from "@jimka/typescript-ui/core";
import { TextField } from "@jimka/typescript-ui/component/input";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import type { CreateCompositeTypeSpec } from "../contract";
import { buildCreateCompositeTypeSpec } from "./ddlSpecs";
import { DESTRUCTIVE_COLOR } from "../theme";
import { RowGridPanel } from "./RowGridPanel";
import type { RowGridRow } from "./RowGridPanel";

Glyph.register(minus);

// One attribute row has three cells: name, type, remove.
const NAME_WEIGHT = 140;
const TYPE_WEIGHT = 140;

/**
 * The CREATE TYPE ... AS (...) form: a type-name field over an add/remove-row
 * attribute grid. Embedded as a `DdlFormPanel` dock tab's form by the
 * controller's `createType` launcher (composite category) and `editType`
 * (composite recreate/clone).
 */
class CompositeTypeForm extends RowGridPanel<{ name: string; type: string }> {
    private readonly _schema: string;
    private readonly _nameField: TextField;

    /**
     * @param init - `schema` fixes the new type's schema; `prefill` (edit
     *   mode) seeds the grid with the existing composite's attributes.
     */
    constructor(init: { schema: string; prefill?: { name: string; type: string }[] }) {
        const nameField = new TextField({ placeholder: "type name" });

        super({
            header:       [nameField],
            addLabel:     "Add attribute",
            columnTracks: [
                { mode: "weight", value: NAME_WEIGHT },
                { mode: "weight", value: TYPE_WEIGHT },
                { mode: "content" }, // remove button
            ],
            buildRow: buildAttrRow,
        });

        this._schema    = init.schema;
        this._nameField = nameField;

        if (init.prefill && init.prefill.length > 0) {
            for (const attr of init.prefill) {
                this.appendRow(attr);
            }
        } else {
            this.appendRow(); // seed with one empty row
        }
    }

    /**
     * @returns the CreateCompositeTypeSpec for the form's current name +
     *   attributes (rows with a blank name/type are dropped by
     *   buildCreateCompositeTypeSpec).
     */
    readSpec(): CreateCompositeTypeSpec {
        return buildCreateCompositeTypeSpec(this._schema, this._nameField.getValue(), this.readRows());
    }
}

/**
 * Build one attribute row — name/type TextFields and a remove ("−") button —
 * as the three cells the caller tiles into the grid, with a reader that
 * snapshots them into a `{name, type}` pair.
 *
 * @param onRemove - invoked when the row's remove button is pressed.
 * @param prefill - optional initial `{name, type}` text for the row.
 * @returns the row's cells, a reader, and the remove button.
 */
function buildAttrRow(
    onRemove: () => void,
    prefill?: { name: string; type: string },
): RowGridRow<{ name: string; type: string }> {
    const nameField = new TextField({ placeholder: "attribute name", text: prefill?.name ?? "" });
    const typeField = new TextField({ placeholder: "type, e.g. text", text: prefill?.type ?? "" });

    const removeButton = Button({
        glyph: "minus", text: "Remove attribute", showText: false, showDescription: false,
        foregroundColor: DESTRUCTIVE_COLOR, compact: true,
    });
    removeButton.on("action", onRemove);

    const read = (): { name: string; type: string } => ({ name: nameField.getValue(), type: typeField.getValue() });

    return {
        cells: [nameField, typeField, removeButton],
        read,
        removeButton,
    };
}

const CompositeTypeFormCallable = callable(CompositeTypeForm);
type CompositeTypeFormCallable = CompositeTypeForm;
export { CompositeTypeFormCallable as CompositeTypeForm };
