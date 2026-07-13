// The CREATE MATERIALIZED VIEW dialog form + launcher: a schema/name/
// WITH-DATA form. The SELECT body itself is authored in the
// SqlPreviewDialog's editable preview editor, not a form field (mirrors
// ViewFormDialog).
//
// Editing an *existing* matview's definition is no longer this dialog's
// job — the definition tab (DefinitionPanel, opened via the navigator's
// "Show definition") is directly editable with its own Save button, which
// runs the atomic DROP+CREATE replace pair itself (a materialized view
// cannot be CREATE OR REPLACE'd — see the view-matview-ddl plan's "Matview
// edit strategy" decision), wired through SqlAdminController.openDefinition.
// This dialog now only ever builds new matviews (see the plan's superseded
// "edit mode").

import { Panel }                     from "@jimka/typescript-ui/core";
import { VBox }                      from "@jimka/typescript-ui/layout";
import { ComboBox, TextField, Checkbox } from "@jimka/typescript-ui/component/input";
import type { CreateMatviewSpec, DbObjectRef, DdlPreview, QueryStatusResult } from "../contract";
import { openSqlPreviewDialog } from "./SqlPreviewDialog";

// Mirrors ViewFormDialog's NEW_VIEW_SELECT_SKELETON: CreateMaterializedViewPreview
// rejects a blank SELECT, so the initial seed needs a non-blank starting keyword.
const NEW_MATVIEW_SELECT_SKELETON = "SELECT";

/** Dependencies for {@link openMaterializedViewDialog}. */
export interface MatviewDialogDeps {
    /** The target schema node this dialog creates the new matview under. */
    ref: DbObjectRef;

    /** The connection's schemas, for the schema ComboBox. */
    schemas: string[];

    /** Preview a CREATE MATERIALIZED VIEW statement for the form's current fields. */
    createPreview: (spec: CreateMatviewSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/** The CREATE MATERIALIZED VIEW form: schema/name/WITH-DATA. */
class MatviewForm extends Panel {
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

        super({ layoutManager: new VBox({ stretching: true }), components: [schemaCombo, nameField, withDataBox] });

        this._schemaCombo = schemaCombo;
        this._nameField = nameField;
        this._withDataBox = withDataBox;
    }

    /** @returns the schema field's current value. */
    schema(): string {
        return this._schemaCombo.getValue();
    }

    /** @returns the name field's current value. */
    name(): string {
        return this._nameField.getValue();
    }

    /** @returns whether to populate immediately (defaults true). */
    withData(): boolean {
        return this._withDataBox.getValue();
    }
}

/**
 * Open the CREATE MATERIALIZED VIEW dialog: builds the structural form and
 * wraps it in the shared SqlPreviewDialog.
 *
 * @param deps - the target schema ref, schema list, and preview/execute callbacks.
 */
export function openMaterializedViewDialog(deps: MatviewDialogDeps): void {
    const form = new MatviewForm(deps.ref, deps.schemas);

    openSqlPreviewDialog({
        title: "Create materialized view",
        form,
        generateSql: async () => (await deps.createPreview({
            schema:   form.schema(),
            name:     form.name(),
            select:   NEW_MATVIEW_SELECT_SKELETON,
            withData: form.withData(),
        })).sql,
        execute:   deps.execute,
        onSuccess: deps.onSuccess,
        onError:   deps.onError,
    });
}
