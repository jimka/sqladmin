// The "Add constraint" dialog form: parameterized by ConstraintKind, each
// rendering only the fields that kind needs. PK/unique pick columns from a
// ColumnChecklist; check collects a raw expression; foreignKey adds a
// referenced schema/table/columns and optional referential actions on top
// of its own local ColumnChecklist. Every kind offers an optional
// constraint-name field. Used by the controller's addConstraint launcher,
// embedded as a SqlPreviewDialog's `form`.

import { Component, Panel } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { ComboBox, TextField } from "@jimka/typescript-ui/component/input";
import type { ConstraintKind, ConstraintSpec } from "../contract";
import { buildConstraintSpec, parseColumnList } from "./ddlSpecs";
import { ColumnChecklist } from "./ColumnChecklist";

// The referential actions offered for FK ON UPDATE/ON DELETE, plus a leading
// "unset" choice that omits the clause entirely (Postgres's own NO ACTION
// default). Matches the backend's _REFERENTIAL_ACTIONS allowlist exactly.
const NO_ACTION_UNSET = "";
const REFERENTIAL_ACTION_CHOICES = [
    NO_ACTION_UNSET, "NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT",
];

// Vertical gap between the kind-specific field(s) and the shared name field.
const ROW_SPACING = 6;

/** The kind-specific fields the form renders, and handles to read them. */
interface KindFields {
    components:      Component[];
    checklist?:      ColumnChecklist;
    expressionField?: TextField;
    refSchemaCombo?: ComboBox;
    refTableField?:  TextField;
    refColumnsField?: TextField;
    onUpdateCombo?:  ComboBox;
    onDeleteCombo?:  ComboBox;
}

/**
 * Build the field(s) one constraint kind needs.
 *
 * @param kind - the constraint kind the form is collecting fields for.
 * @param columns - the table's own columns, for the local column checklist.
 * @param schemas - the connection's schemas, for the FK's referenced-schema combo.
 * @returns the components to host and handles to the live inputs (only the
 *   ones this kind renders are set).
 */
function buildKindFields(kind: ConstraintKind, columns: string[], schemas: string[]): KindFields {
    if (kind === "primaryKey" || kind === "unique") {
        const checklist = new ColumnChecklist(columns);

        return { components: [checklist], checklist };
    }

    if (kind === "check") {
        const expressionField = new TextField({ placeholder: "check expression, e.g. balance >= 0" });

        return { components: [expressionField], expressionField };
    }

    const checklist       = new ColumnChecklist(columns);
    const refSchemaCombo  = new ComboBox({ items: schemas });
    const refTableField   = new TextField({ placeholder: "referenced table" });
    const refColumnsField = new TextField({ placeholder: "referenced columns (comma-separated)" });
    const onUpdateCombo   = new ComboBox({ items: REFERENTIAL_ACTION_CHOICES, value: NO_ACTION_UNSET });
    const onDeleteCombo   = new ComboBox({ items: REFERENTIAL_ACTION_CHOICES, value: NO_ACTION_UNSET });

    return {
        components: [checklist, refSchemaCombo, refTableField, refColumnsField, onUpdateCombo, onDeleteCombo],
        checklist, refSchemaCombo, refTableField, refColumnsField, onUpdateCombo, onDeleteCombo,
    };
}

/** The add-constraint form: the fields `kind` needs, plus an optional name. */
export class ConstraintForm extends Panel {
    private readonly _schema: string;
    private readonly _table: string;
    private readonly _kind: ConstraintKind;
    private readonly _fields: KindFields;
    private readonly _nameField: TextField;

    /**
     * @param schema - the table's schema.
     * @param table - the table's name.
     * @param kind - which constraint kind this form collects fields for.
     * @param columns - the table's own columns.
     * @param schemas - the connection's schemas (for a foreignKey's referenced-schema combo).
     */
    constructor(schema: string, table: string, kind: ConstraintKind, columns: string[], schemas: string[]) {
        const fields    = buildKindFields(kind, columns, schemas);
        const nameField = new TextField({ placeholder: "constraint name (optional)" });

        super({
            layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }),
            components:    [...fields.components, nameField],
        });

        this._schema    = schema;
        this._table     = table;
        this._kind      = kind;
        this._fields    = fields;
        this._nameField = nameField;
    }

    /** @returns the action-tagged ConstraintSpec for the form's current fields. */
    readSpec(): ConstraintSpec {
        const constraintName = this._nameField.getValue() || undefined;

        if (this._kind === "primaryKey") {
            return buildConstraintSpec(this._schema, this._table, "addPrimaryKey", {
                columns: this._fields.checklist!.readSelected(), constraintName,
            });
        }

        if (this._kind === "unique") {
            return buildConstraintSpec(this._schema, this._table, "addUnique", {
                columns: this._fields.checklist!.readSelected(), constraintName,
            });
        }

        if (this._kind === "check") {
            return buildConstraintSpec(this._schema, this._table, "addCheck", {
                expression: this._fields.expressionField!.getValue(), constraintName,
            });
        }

        return buildConstraintSpec(this._schema, this._table, "addForeignKey", {
            columns:    this._fields.checklist!.readSelected(),
            refSchema:  this._fields.refSchemaCombo!.getValue(),
            refTable:   this._fields.refTableField!.getValue(),
            refColumns: parseColumnList(this._fields.refColumnsField!.getValue()),
            onUpdate:   this._fields.onUpdateCombo!.getValue() || undefined,
            onDelete:   this._fields.onDeleteCombo!.getValue() || undefined,
            constraintName,
        });
    }
}
