// The RENAME TABLE dialog form: a single new-name field. Used by the
// controller's renameTable launcher, embedded as a SqlPreviewDialog's `form`.
// The form reports edits to the name through `onFieldChange`, which
// SqlPreviewDialog uses to keep the preview in step.

import { Panel, callable } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { TextField } from "@jimka/typescript-ui/component/input";
import type { AlterTableSpec } from "../contract";
import { buildAlterTableSpec } from "./ddlSpecs";

/** The RENAME TABLE form: a single new-name field. */
class RenameTableForm extends Panel {
    private readonly _schema: string;
    private readonly _name: string;
    private readonly _newNameField: TextField;

    /**
     * @param schema - the table's current schema.
     * @param name - the table's current name.
     */
    constructor(schema: string, name: string) {
        const newNameField = new TextField({ placeholder: "new table name", text: name });

        super({ layoutManager: new VBox({ itemAlign: "stretch" }), components: [newNameField] });

        this._schema       = schema;
        this._name         = name;
        this._newNameField = newNameField;
    }

    /** @returns the `renameTable`-tagged AlterTableSpec for the entered new name. */
    readSpec(): AlterTableSpec {
        return buildAlterTableSpec(this._schema, this._name, "renameTable", { newName: this._newNameField.getValue() });
    }

    /**
     * Register `listener` to run whenever the new name changes. `SqlPreviewDialog`
     * uses it to keep the SQL preview in step with the form.
     *
     * @param listener - Called after each field change.
     * @returns This form, for chaining.
     */
    onFieldChange(listener: () => void): this {
        this._newNameField.on("change", listener);

        return this;
    }
}

const RenameTableFormCallable = callable(RenameTableForm);
type RenameTableFormCallable = RenameTableForm;
export { RenameTableFormCallable as RenameTableForm };
