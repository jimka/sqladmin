// The CREATE MATERIALIZED VIEW form: a schema/name/WITH-DATA group, hosted in
// its own dock tab. The SELECT body itself is authored in the SqlPreviewDialog
// review dialog's editable preview editor, not a form field (mirrors ViewForm).
//
// Editing an *existing* matview's definition is no longer this form's job —
// the definition tab (DefinitionPanel, opened via the navigator's "Show
// definition") is directly editable with its own Save button, which runs
// the atomic DROP+CREATE replace pair itself (a materialized view cannot be
// CREATE OR REPLACE'd — see the view-matview-ddl plan's "Matview edit
// strategy" decision), wired through SqlAdminController.openDefinition. This
// form now only ever builds new matviews (see the plan's superseded "edit
// mode").

import { Panel, callable }               from "@jimka/typescript-ui/core";
import { VBox }                          from "@jimka/typescript-ui/layout";
import { ComboBox, TextField, Checkbox } from "@jimka/typescript-ui/component/input";
import type { CreateMatviewSpec, DbObjectRef } from "../contract";

// Mirrors ViewForm's NEW_VIEW_SELECT_SKELETON: CreateMaterializedViewPreview
// rejects a blank SELECT, so the initial seed needs a non-blank starting keyword.
const NEW_MATVIEW_SELECT_SKELETON = "SELECT";

/**
 * The CREATE MATERIALIZED VIEW form: schema/name/WITH-DATA. Embedded as a
 * `DdlFormPanel` dock tab's form by the controller's `createRelationDraft`
 * launcher.
 */
class MaterializedViewForm extends Panel {
    private readonly _schemaCombo: ComboBox;
    private readonly _nameField: TextField;
    private readonly _withDataBox: Checkbox;

    /**
     * @param ref - the target schema node.
     * @param schemas - the connection's schemas, for the schema combo.
     */
    constructor(ref: DbObjectRef, schemas: string[]) {
        const schemaCombo = new ComboBox({ items: schemas, value: ref.schema ?? schemas[0] ?? "" });
        const nameField = new TextField({ placeholder: "materialized view name" });
        const withDataBox = Checkbox({ label: "Populate immediately (WITH DATA)", selected: true });

        super({ layoutManager: new VBox({ itemAlign: "stretch" }), components: [schemaCombo, nameField, withDataBox] });

        this._schemaCombo = schemaCombo;
        this._nameField = nameField;
        this._withDataBox = withDataBox;
    }

    /** @returns the CreateMatviewSpec for the form's current fields. */
    readSpec(): CreateMatviewSpec {
        return {
            schema:   this._schemaCombo.getValue(),
            name:     this._nameField.getValue(),
            select:   NEW_MATVIEW_SELECT_SKELETON,
            withData: this.withData(),
        };
    }

    /** @returns whether to populate immediately (defaults true). */
    private withData(): boolean {
        return this._withDataBox.getValue();
    }
}

const MaterializedViewFormCallable = callable(MaterializedViewForm);
type MaterializedViewFormCallable = MaterializedViewForm;
export { MaterializedViewFormCallable as MaterializedViewForm };
