// The CREATE FUNCTION form: editable name/kind/language/args/returns/
// volatility/replace fields, with a stub body seeded once into the SQL preview
// editor (the user fills it in there). No CodeEditor is embedded here — the
// body/SQL is authored in phase-1's shared preview editor, per the
// class-first-form convention every other DDL form follows. The argument grid
// is built on the shared RowGridPanel base.
//
// Editing an existing routine is no longer a form: the navigator opens a
// function's pg_get_functiondef text — already a complete, executable
// CREATE OR REPLACE statement — in an editable definition tab instead (see
// SqlAdminController.openFunctionDefinition), so this form is create-only.

import { callable } from "@jimka/typescript-ui/core";
import { Checkbox, ComboBox, TextField } from "@jimka/typescript-ui/component/input";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import type { CreateFunctionSpec } from "../contract";
import { buildCreateFunctionSpec } from "./ddlSpecs";
import type { FunctionArgRow } from "./ddlSpecs";
import { DESTRUCTIVE_COLOR } from "../theme";
import { RowGridPanel } from "./RowGridPanel";
import type { RowGridRow } from "./RowGridPanel";

Glyph.register(minus);

// A CREATE FUNCTION preview does not reject a blank body (unlike CREATE
// VIEW's blank-SELECT guard — a function's body is opaque SQL, not a
// parseable clause), but an empty body is never useful, so the create form
// seeds this small reminder instead of nothing; the user replaces it in the
// preview editor before executing.
const NEW_FUNCTION_BODY_STUB = "-- TODO: implement the routine body";

const KIND_ITEMS = [
    { key: "function", label: "Function" },
    { key: "procedure", label: "Procedure" },
];

// One argument row has five cells: mode, name, type, default, remove.
const MODE_WEIGHT = 90;
const NAME_WEIGHT = 100;
const TYPE_WEIGHT = 130;
const DEFAULT_WEIGHT = 110;

/**
 * The CREATE FUNCTION form: a structural field group plus an add/remove-row
 * argument grid. The body is authored in the shared SQL preview editor, seeded
 * with a stub. Embedded as a `DdlFormPanel` dock tab's form by the
 * controller's `createFunction` launcher.
 */
class FunctionForm extends RowGridPanel<FunctionArgRow> {
    private readonly _schema: string;
    private readonly _nameField: TextField;
    private readonly _kindCombo: ComboBox;
    private readonly _languageField: TextField;
    private readonly _returnsField: TextField;
    private readonly _volatilityField: TextField;
    private readonly _replaceBox: Checkbox;

    /**
     * @param init - `schema` fixes the routine's schema.
     */
    constructor(init: { schema: string }) {
        const nameField = new TextField({ placeholder: "function name" });
        const kindCombo = new ComboBox({ items: KIND_ITEMS, value: "function" });
        const languageField = new TextField({ placeholder: "language, e.g. plpgsql", text: "plpgsql" });
        const returnsField = new TextField({ placeholder: "return type, e.g. integer (function only)" });
        const volatilityField = new TextField({ placeholder: "volatility, e.g. IMMUTABLE (optional, function only)" });
        const replaceBox = Checkbox({ label: "OR REPLACE", selected: false });

        super({
            header: [nameField, kindCombo, languageField, returnsField, volatilityField, replaceBox],
            addLabel: "Add argument",
            columnTracks: [
                { mode: "weight", value: MODE_WEIGHT },
                { mode: "weight", value: NAME_WEIGHT },
                { mode: "weight", value: TYPE_WEIGHT },
                { mode: "weight", value: DEFAULT_WEIGHT },
                { mode: "content" }, // remove button
            ],
            buildRow: buildArgRow,
        });

        this._schema = init.schema;
        this._nameField = nameField;
        this._kindCombo = kindCombo;
        this._languageField = languageField;
        this._returnsField = returnsField;
        this._volatilityField = volatilityField;
        this._replaceBox = replaceBox;

        this.appendRow(); // seed with one empty row
    }

    /**
     * @returns the CreateFunctionSpec for the form's current fields.
     */
    readSpec(): CreateFunctionSpec {
        const kind = this._kindCombo.getValue() === "procedure" ? "procedure" : "function";

        return buildCreateFunctionSpec(
            this._schema,
            this._nameField.getValue(),
            kind,
            this.readRows(),
            this._languageField.getValue() || "sql",
            NEW_FUNCTION_BODY_STUB,
            {
                returns: this._returnsField.getValue() || undefined,
                volatility: this._volatilityField.getValue() || undefined,
                replace: this._replaceBox.getValue(),
            },
        );
    }
}

/**
 * Build one argument row — mode/name/type/default TextFields/ComboBox and a
 * remove ("−") button — as the five cells the caller tiles into the grid,
 * with a reader that snapshots them into a FunctionArgRow.
 *
 * @param onRemove - invoked when the row's remove button is pressed.
 * @returns the row's cells, a reader, and the remove button.
 */
function buildArgRow(onRemove: () => void): RowGridRow<FunctionArgRow> {
    const modeField = new TextField({ placeholder: "mode (optional)" });
    const nameField = new TextField({ placeholder: "arg name (optional)" });
    const typeField = new TextField({ placeholder: "type, e.g. integer" });
    const defaultField = new TextField({ placeholder: "default (optional)" });

    const removeButton = Button({
        glyph: "minus", text: "Remove argument", showText: false, showDescription: false,
        foregroundColor: DESTRUCTIVE_COLOR, compact: true,
    });
    removeButton.on("action", onRemove);

    const read = (): FunctionArgRow => ({
        mode: modeField.getValue(),
        name: nameField.getValue(),
        type: typeField.getValue(),
        default: defaultField.getValue(),
    });

    return {
        cells: [modeField, nameField, typeField, defaultField, removeButton],
        read,
        removeButton,
    };
}

const FunctionFormCallable = callable(FunctionForm);
type FunctionFormCallable = FunctionForm;
export { FunctionFormCallable as FunctionForm };
