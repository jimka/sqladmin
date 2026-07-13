// The ALTER COLUMN dialog form: parameterized by AlterColumnAction and
// prefilled from the selected column's metadata. Renders only the field(s)
// the action needs — a rename shows a new-name field, a type change shows
// new-type + optional USING, a default change shows a default field, and
// the toggle-only actions (set/drop NOT NULL, drop default) show a summary
// line with nothing to fill in. Used by the controller's alterColumn
// launcher, embedded as a SqlPreviewDialog's `form`.

import { Component, Panel } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { Text, TextField } from "@jimka/typescript-ui/component/input";
import type { AlterColumnAction, AlterTableSpec, ColumnMeta } from "../contract";
import { buildAlterTableSpec } from "./ddlSpecs";

// Vertical gap between the action's field(s).
const ROW_SPACING = 6;

/** The fields one ALTER-column action renders, and the components to host them. */
interface ActionFields {
    components:   Component[];
    newNameField?: TextField;
    newTypeField?: TextField;
    usingField?:   TextField;
    defaultField?: TextField;
}

/**
 * Build the field(s) one ALTER-column action needs, prefilled from the
 * column's current metadata where that makes sense (rename seeds the
 * current name; changeType seeds the current Postgres type).
 *
 * @param action - the ALTER action the form is collecting fields for.
 * @param column - the column being altered.
 * @returns the components to host and handles to the live inputs (only the
 *   ones this action renders are set).
 */
function buildActionFields(action: AlterColumnAction, column: ColumnMeta): ActionFields {
    switch (action) {
        case "renameColumn": {
            const newNameField = new TextField({ placeholder: "new column name", text: column.name });

            return { components: [newNameField], newNameField };
        }
        case "changeType": {
            const newTypeField = new TextField({ placeholder: "new type", text: column.dataType });
            const usingField   = new TextField({ placeholder: "USING expression (optional)" });

            return { components: [newTypeField, usingField], newTypeField, usingField };
        }
        case "setDefault": {
            const defaultField = new TextField({ placeholder: "default expression, e.g. now()" });

            return { components: [defaultField], defaultField };
        }
        case "setNotNull":
            return { components: [new Text(`Set "${column.name}" NOT NULL?`)] };
        case "dropNotNull":
            return { components: [new Text(`Drop NOT NULL on "${column.name}"?`)] };
        case "dropDefault":
            return { components: [new Text(`Drop the default on "${column.name}"?`)] };
    }
}

/** The ALTER COLUMN form: the one/two fields (or summary) `action` needs. */
export class AlterColumnForm extends Panel {
    private readonly _schema: string;
    private readonly _table: string;
    private readonly _action: AlterColumnAction;
    private readonly _column: string;
    private readonly _fields: ActionFields;

    /**
     * @param schema - the table's schema.
     * @param table - the table's name.
     * @param column - the column being altered (its current metadata seeds
     *   the rename/changeType fields).
     * @param action - which ALTER action this form collects fields for.
     */
    constructor(schema: string, table: string, column: ColumnMeta, action: AlterColumnAction) {
        const fields = buildActionFields(action, column);

        super({ layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }), components: fields.components });

        this._schema = schema;
        this._table  = table;
        this._action = action;
        this._column = column.name;
        this._fields = fields;
    }

    /** @returns the action-tagged AlterTableSpec for the form's current fields. */
    readSpec(): AlterTableSpec {
        return buildAlterTableSpec(this._schema, this._table, this._action, {
            column:  this._column,
            newName: this._fields.newNameField?.getValue(),
            newType: this._fields.newTypeField?.getValue(),
            using:   this._fields.usingField?.getValue() || undefined,
            default: this._fields.defaultField?.getValue(),
        });
    }
}
