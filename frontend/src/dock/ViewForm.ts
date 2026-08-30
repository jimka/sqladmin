// The CREATE VIEW form: an editable schema/name/column-aliases group, hosted
// in its own dock tab. The SELECT body itself is NOT a form field: it is
// authored directly in the SqlPreviewDialog review dialog's editable preview
// editor, seeded once by generateSql() from a bare skeleton the user
// completes (see the plan's "Structural fields in the form" decision).
//
// Editing an *existing* view's definition is no longer this form's job —
// the definition tab (DefinitionPanel, opened via the navigator's "Show
// definition") is directly editable with its own Save button, wired through
// SqlAdminController.openDefinition. This form now only ever builds new
// views (see the view-matview-ddl plan's superseded "edit mode").

import { Panel, callable }         from "@jimka/typescript-ui/core";
import { VBox }                    from "@jimka/typescript-ui/layout";
import { ComboBox, TextField }     from "@jimka/typescript-ui/component/input";
import type { CreateViewSpec, DbObjectRef } from "../contract";
import { parseColumnList }         from "./ddlSpecs";

// A CREATE VIEW preview rejects a blank SELECT (CreateViewPreview's
// __init__ guard), so the initial seed can't pass "" — this bare keyword is
// the smallest non-blank starting point, producing the legible skeleton
// `CREATE VIEW "s"."n" AS\nSELECT` the user completes in the preview editor.
const NEW_VIEW_SELECT_SKELETON = "SELECT";

/**
 * The CREATE VIEW form: an editable schema/name/column-aliases group.
 * Embedded as a `DdlFormPanel` dock tab's form by the controller's
 * `createRelationDraft` launcher.
 */
class ViewForm extends Panel {
    private readonly _schemaCombo: ComboBox;
    private readonly _nameField: TextField;
    private readonly _columnsField: TextField;

    /**
     * @param ref - the target schema node.
     * @param schemas - the connection's schemas, for the schema combo.
     */
    constructor(ref: DbObjectRef, schemas: string[]) {
        const schemaCombo = new ComboBox({ items: schemas, value: ref.schema ?? schemas[0] ?? "" });
        const nameField = new TextField({ placeholder: "view name" });
        const columnsField = new TextField({ placeholder: "column aliases (comma-separated, optional)" });

        super({ layoutManager: new VBox({ itemAlign: "stretch" }), components: [schemaCombo, nameField, columnsField] });

        this._schemaCombo = schemaCombo;
        this._nameField = nameField;
        this._columnsField = columnsField;
    }

    /** @returns the CreateViewSpec for the form's current fields. */
    readSpec(): CreateViewSpec {
        return {
            schema:    this._schemaCombo.getValue(),
            name:      this._nameField.getValue(),
            select:    NEW_VIEW_SELECT_SKELETON,
            orReplace: false,
            columns:   this.columns(),
        };
    }

    /** @returns the parsed column aliases, or undefined when none were given. */
    private columns(): string[] | undefined {
        const parsed = parseColumnList(this._columnsField.getValue());

        return parsed.length > 0 ? parsed : undefined;
    }
}

const ViewFormCallable = callable(ViewForm);
type ViewFormCallable = ViewForm;
export { ViewFormCallable as ViewForm };
