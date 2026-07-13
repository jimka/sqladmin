// The RENAME TABLE dialog form: a single new-name field. Used by the
// controller's renameTable launcher, embedded as a SqlPreviewDialog's `form`.

import { Panel } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { TextField } from "@jimka/typescript-ui/component/input";
import type { AlterTableSpec } from "../contract";
import { buildAlterTableSpec } from "./ddlSpecs";

/** The RENAME TABLE form: a single new-name field. */
export class RenameTableForm extends Panel {
    private readonly _schema: string;
    private readonly _name: string;
    private readonly _newNameField: TextField;

    /**
     * @param schema - the table's current schema.
     * @param name - the table's current name.
     */
    constructor(schema: string, name: string) {
        const newNameField = new TextField({ placeholder: "new table name", text: name });

        super({ layoutManager: new VBox({ stretching: true }), components: [newNameField] });

        this._schema       = schema;
        this._name         = name;
        this._newNameField = newNameField;
    }

    /** @returns the `renameTable`-tagged AlterTableSpec for the entered new name. */
    readSpec(): AlterTableSpec {
        return buildAlterTableSpec(this._schema, this._name, "renameTable", { newName: this._newNameField.getValue() });
    }
}
