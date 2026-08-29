// The CREATE / RENAME SCHEMA forms. A schema is database-scoped, but the
// navigator has no separate database node to right-click (its top level IS
// the logged-in database's schemas — see NavigatorTree's header comment);
// "Create schema…" is launched from an existing schema node's context menu
// instead, synthesizing the database-level target the same way "Show
// database diagram" already does (see
// plans/implemented/schema-sequence-ddl.md's drift notes). Rename acts on an
// existing schema node directly; drop reuses the generic ConfirmCascadeForm
// and is built inline by the controller's `dropSchema` launcher.

import { Panel, callable } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { TextField } from "@jimka/typescript-ui/component/input";
import type { CreateSchemaSpec } from "../contract";
import { buildCreateSchemaSpec } from "./ddlSpecs";

/**
 * The CREATE SCHEMA form: a name field and an optional owner (AUTHORIZATION)
 * field. Embedded as a `DdlFormPanel` dock tab's form by the controller's
 * `createSchema` launcher.
 */
class CreateSchemaForm extends Panel {
    private readonly _nameField: TextField;
    private readonly _authField: TextField;

    constructor() {
        const nameField = new TextField({ placeholder: "schema name" });
        const authField = new TextField({ placeholder: "authorization (optional owner role)" });

        super({ layoutManager: new VBox({ itemAlign: "stretch" }), components: [nameField, authField] });

        this._nameField = nameField;
        this._authField = authField;
    }

    /** @returns the CreateSchemaSpec for the form's current fields. */
    readSpec(): CreateSchemaSpec {
        return buildCreateSchemaSpec(this._nameField.getValue(), this._authField.getValue() || undefined);
    }
}

const CreateSchemaFormCallable = callable(CreateSchemaForm);
type CreateSchemaFormCallable = CreateSchemaForm;
export { CreateSchemaFormCallable as CreateSchemaForm };

/**
 * The RENAME SCHEMA form: a single new-name field, seeded with the current
 * name. Embedded as a `SqlPreviewDialog`'s `form` by the controller's
 * `renameSchema` launcher.
 */
class RenameSchemaForm extends Panel {
    private readonly _newNameField: TextField;

    /** @param name - the schema's current name, seeding the field. */
    constructor(name: string) {
        const newNameField = new TextField({ placeholder: "new schema name", text: name });

        super({ layoutManager: new VBox({ itemAlign: "stretch" }), components: [newNameField] });

        this._newNameField = newNameField;
    }

    /** @returns the entered new name. */
    newName(): string {
        return this._newNameField.getValue();
    }
}

const RenameSchemaFormCallable = callable(RenameSchemaForm);
type RenameSchemaFormCallable = RenameSchemaForm;
export { RenameSchemaFormCallable as RenameSchemaForm };
