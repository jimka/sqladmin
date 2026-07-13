// The CREATE VIEW dialog form + launcher. The schema and name are editable
// and column aliases are optional. The SELECT body itself is NOT a form
// field: it is authored directly in the SqlPreviewDialog's editable preview
// editor, seeded once by generateSql() from a bare skeleton the user
// completes (see the plan's "Structural fields in the form" decision).
//
// Editing an *existing* view's definition is no longer this dialog's job —
// the definition tab (DefinitionPanel, opened via the navigator's "Show
// definition") is directly editable with its own Save button, wired through
// SqlAdminController.openDefinition. This dialog now only ever builds new
// views (see the view-matview-ddl plan's superseded "edit mode").

import { Panel }                   from "@jimka/typescript-ui/core";
import { VBox }                    from "@jimka/typescript-ui/layout";
import { ComboBox, TextField }     from "@jimka/typescript-ui/component/input";
import type { CreateViewSpec, DbObjectRef, DdlPreview, QueryStatusResult } from "../contract";
import { openSqlPreviewDialog }    from "./SqlPreviewDialog";
import { parseColumnList }         from "./ddlSpecs";

// A CREATE VIEW preview rejects a blank SELECT (CreateViewPreview's
// __init__ guard), so the initial seed can't pass "" — this bare keyword is
// the smallest non-blank starting point, producing the legible skeleton
// `CREATE VIEW "s"."n" AS\nSELECT` the user completes in the preview editor.
const NEW_VIEW_SELECT_SKELETON = "SELECT";

/** Dependencies for {@link openViewDialog}. */
export interface ViewDialogDeps {
    /** The target schema node this dialog creates the new view under. */
    ref: DbObjectRef;

    /** The connection's schemas, for the schema ComboBox. */
    schemas: string[];

    /** Preview a CREATE VIEW statement for the form's current fields. */
    preview: (spec: CreateViewSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/** The CREATE VIEW form: an editable schema/name/column-aliases group. */
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

        super({ layoutManager: new VBox({ stretching: true }), components: [schemaCombo, nameField, columnsField] });

        this._schemaCombo = schemaCombo;
        this._nameField = nameField;
        this._columnsField = columnsField;
    }

    /** @returns the schema field's current value. */
    schema(): string {
        return this._schemaCombo.getValue();
    }

    /** @returns the name field's current value. */
    name(): string {
        return this._nameField.getValue();
    }

    /** @returns the parsed column aliases, or undefined when none were given. */
    columns(): string[] | undefined {
        const parsed = parseColumnList(this._columnsField.getValue());

        return parsed.length > 0 ? parsed : undefined;
    }
}

/**
 * Open the CREATE VIEW dialog: builds the structural form and wraps it in
 * the shared SqlPreviewDialog.
 *
 * @param deps - the target schema ref, schema list, and preview/execute callbacks.
 */
export function openViewDialog(deps: ViewDialogDeps): void {
    const form = new ViewForm(deps.ref, deps.schemas);

    openSqlPreviewDialog({
        title: "Create view",
        form,
        generateSql: async () => (await deps.preview({
            schema:    form.schema(),
            name:      form.name(),
            select:    NEW_VIEW_SELECT_SKELETON,
            orReplace: false,
            columns:   form.columns(),
        })).sql,
        execute:   deps.execute,
        onSuccess: deps.onSuccess,
        onError:   deps.onError,
    });
}
