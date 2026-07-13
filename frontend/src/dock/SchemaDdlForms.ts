// The CREATE / RENAME / DROP SCHEMA dialog forms + launchers. A schema is
// database-scoped, but the navigator has no separate database node to
// right-click (its top level IS the logged-in database's schemas — see
// NavigatorTree's header comment); "Create schema…" is launched from an
// existing schema node's context menu instead, synthesizing the database-level
// target the same way "Show database diagram" already does (see
// plans/implemented/schema-sequence-ddl.md's drift notes). Rename/drop act on
// an existing schema node directly.

import { Panel } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { TextField } from "@jimka/typescript-ui/component/input";
import type { CreateSchemaSpec, DdlPreview, DropSchemaSpec, QueryStatusResult, RenameSchemaSpec } from "../contract";
import { openSqlPreviewDialog } from "./SqlPreviewDialog";
import { buildCreateSchemaSpec, buildDropSchemaSpec, buildRenameSchemaSpec } from "./ddlSpecs";
import { ConfirmCascadeForm } from "./ConfirmCascadeForm";

/** Dependencies for {@link openCreateSchemaDialog}. */
export interface CreateSchemaDialogDeps {
    /** Preview the CREATE SCHEMA statement for the form's current fields. */
    preview: (spec: CreateSchemaSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/** The CREATE SCHEMA form: a name field and an optional owner (AUTHORIZATION) field. */
class CreateSchemaForm extends Panel {
    private readonly _nameField: TextField;
    private readonly _authField: TextField;

    constructor() {
        const nameField = new TextField({ placeholder: "schema name" });
        const authField = new TextField({ placeholder: "authorization (optional owner role)" });

        super({ layoutManager: new VBox({ stretching: true }), components: [nameField, authField] });

        this._nameField = nameField;
        this._authField = authField;
    }

    /** @returns the CreateSchemaSpec for the form's current fields. */
    readSpec(): CreateSchemaSpec {
        return buildCreateSchemaSpec(this._nameField.getValue(), this._authField.getValue() || undefined);
    }
}

/**
 * Open the CREATE SCHEMA dialog.
 *
 * @param deps - the preview/execute callbacks.
 */
export function openCreateSchemaDialog(deps: CreateSchemaDialogDeps): void {
    const form = new CreateSchemaForm();

    openSqlPreviewDialog({
        title: "Create schema",
        form,
        generateSql: async () => (await deps.preview(form.readSpec())).sql,
        execute:     deps.execute,
        onSuccess:   deps.onSuccess,
        onError:     deps.onError,
    });
}

/** Dependencies for {@link openDropSchemaDialog}. */
export interface DropSchemaDialogDeps {
    name: string;

    /** Preview the DROP SCHEMA statement for the form's current CASCADE toggle. */
    preview: (spec: DropSchemaSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/**
 * Open the DROP SCHEMA dialog. Reuses the generic {@link ConfirmCascadeForm}
 * (a summary line plus a CASCADE checkbox) — the same idiom drop-table/
 * drop-index already use; `ifExists` is likewise never surfaced in the UI.
 *
 * @param deps - the target schema and preview/execute callbacks.
 */
export function openDropSchemaDialog(deps: DropSchemaDialogDeps): void {
    const form = new ConfirmCascadeForm(`Drop schema "${deps.name}"? This drops every object it contains.`);

    openSqlPreviewDialog({
        title: "Drop schema",
        form,
        generateSql: async () => (await deps.preview(buildDropSchemaSpec(deps.name, form.readSpec().cascade))).sql,
        execute:     deps.execute,
        onSuccess:   deps.onSuccess,
        onError:     deps.onError,
    });
}

/** Dependencies for {@link openRenameSchemaDialog}. */
export interface RenameSchemaDialogDeps {
    name: string;

    /** Preview the RENAME statement for the form's current new-name field. */
    preview: (spec: RenameSchemaSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/** The RENAME SCHEMA form: a single new-name field, seeded with the current name. */
class RenameSchemaForm extends Panel {
    private readonly _newNameField: TextField;

    /** @param name - the schema's current name, seeding the field. */
    constructor(name: string) {
        const newNameField = new TextField({ placeholder: "new schema name", text: name });

        super({ layoutManager: new VBox({ stretching: true }), components: [newNameField] });

        this._newNameField = newNameField;
    }

    /** @returns the entered new name. */
    newName(): string {
        return this._newNameField.getValue();
    }
}

/**
 * Open the RENAME SCHEMA dialog.
 *
 * @param deps - the target schema and preview/execute callbacks.
 */
export function openRenameSchemaDialog(deps: RenameSchemaDialogDeps): void {
    const form = new RenameSchemaForm(deps.name);

    openSqlPreviewDialog({
        title: "Rename schema",
        form,
        generateSql: async () => (await deps.preview(buildRenameSchemaSpec(deps.name, form.newName()))).sql,
        execute:     deps.execute,
        onSuccess:   deps.onSuccess,
        onError:     deps.onError,
    });
}
