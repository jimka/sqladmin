// The CREATE / DROP SEQUENCE dialog forms + launchers. Sequences are
// schema-scoped: create is launched from a schema node, drop from a
// sequence leaf. ALTER SEQUENCE (parameters and OWNER TO) no longer has a
// modal dialog — it is now driven from the editable sequence info tab (see
// SequenceInfoPanel.ts and plans/implemented/editable-sequence-tab.md),
// which reuses buildAlterSequenceSpec/buildSequenceOwnerSpec via
// ddlSpecs.ts's diffSequenceSpecs instead of a form here.

import { Panel } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { Checkbox, TextField } from "@jimka/typescript-ui/component/input";
import type {
    CreateSequenceSpec,
    DdlPreview,
    DropSequenceSpec,
    QueryStatusResult,
} from "../contract";
import { openSqlPreviewDialog } from "./SqlPreviewDialog";
import { ConfirmCascadeForm } from "./ConfirmCascadeForm";
import {
    buildCreateSequenceSpec,
    buildDropSequenceSpec,
    parseOptionalInt,
} from "./ddlSpecs";

// --- Create -----------------------------------------------------------------

/** Dependencies for {@link openCreateSequenceDialog}. */
export interface CreateSequenceDialogDeps {
    /** The schema the new sequence is created in (fixed — the launcher is
     *  invoked from that schema's navigator node). */
    schema: string;

    /** Preview the CREATE SEQUENCE statement for the form's current fields. */
    preview: (spec: CreateSequenceSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/** The CREATE SEQUENCE form: a name field, the optional numeric options, and CYCLE. */
class CreateSequenceForm extends Panel {
    private readonly _schema: string;
    private readonly _nameField: TextField;
    private readonly _incrementField: TextField;
    private readonly _startField: TextField;
    private readonly _minField: TextField;
    private readonly _maxField: TextField;
    private readonly _cacheField: TextField;
    private readonly _cycleBox: Checkbox;

    /** @param schema - the new sequence's schema. */
    constructor(schema: string) {
        const nameField = new TextField({ placeholder: "sequence name" });
        const incrementField = new TextField({ placeholder: "increment (optional)" });
        const startField = new TextField({ placeholder: "start (optional)" });
        const minField = new TextField({ placeholder: "min value (optional)" });
        const maxField = new TextField({ placeholder: "max value (optional)" });
        const cacheField = new TextField({ placeholder: "cache (optional)" });
        const cycleBox = Checkbox({ label: "CYCLE", selected: false });

        super({
            layoutManager: new VBox({ stretching: true }),
            components:    [nameField, incrementField, startField, minField, maxField, cacheField, cycleBox],
        });

        this._schema         = schema;
        this._nameField       = nameField;
        this._incrementField  = incrementField;
        this._startField      = startField;
        this._minField        = minField;
        this._maxField        = maxField;
        this._cacheField      = cacheField;
        this._cycleBox        = cycleBox;
    }

    /**
     * @returns the CreateSequenceSpec for the form's current fields.
     * @throws Error if a numeric field holds non-blank, non-integer text
     *   (see `parseOptionalInt`) — surfaces through the dialog's preview
     *   rejection path.
     */
    readSpec(): CreateSequenceSpec {
        return buildCreateSequenceSpec(
            this._schema,
            this._nameField.getValue(),
            {
                increment: parseOptionalInt(this._incrementField.getValue(), "increment"),
                start:     parseOptionalInt(this._startField.getValue(), "start"),
                minValue:  parseOptionalInt(this._minField.getValue(), "min value"),
                maxValue:  parseOptionalInt(this._maxField.getValue(), "max value"),
                cache:     parseOptionalInt(this._cacheField.getValue(), "cache"),
            },
            this._cycleBox.getValue(),
        );
    }
}

/**
 * Open the CREATE SEQUENCE dialog.
 *
 * @param deps - the target schema and preview/execute callbacks.
 */
export function openCreateSequenceDialog(deps: CreateSequenceDialogDeps): void {
    const form = new CreateSequenceForm(deps.schema);

    openSqlPreviewDialog({
        title: "Create sequence",
        form,
        generateSql: async () => (await deps.preview(form.readSpec())).sql,
        execute:     deps.execute,
        onSuccess:   deps.onSuccess,
        onError:     deps.onError,
    });
}

// --- Drop --------------------------------------------------------------------

/** Dependencies for {@link openDropSequenceDialog}. */
export interface DropSequenceDialogDeps {
    schema: string;
    name: string;

    /** Preview the DROP SEQUENCE statement for the form's current CASCADE toggle. */
    preview: (spec: DropSequenceSpec) => Promise<DdlPreview>;

    /** Execute the (possibly edited) previewed SQL. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Reports a preview/execute error. */
    onError: (message: string) => void;
}

/**
 * Open the DROP SEQUENCE dialog. Reuses the generic {@link ConfirmCascadeForm},
 * matching drop-table/drop-index's idiom.
 *
 * @param deps - the target sequence and preview/execute callbacks.
 */
export function openDropSequenceDialog(deps: DropSequenceDialogDeps): void {
    const form = new ConfirmCascadeForm(`Drop sequence "${deps.schema}"."${deps.name}"?`);

    openSqlPreviewDialog({
        title: "Drop sequence",
        form,
        generateSql: async () =>
            (await deps.preview(buildDropSequenceSpec(deps.schema, deps.name, form.readSpec().cascade))).sql,
        execute:   deps.execute,
        onSuccess: deps.onSuccess,
        onError:   deps.onError,
    });
}
