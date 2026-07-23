// The CREATE FUNCTION dialog form: editable name/kind/language/args/returns/
// volatility/replace fields, with a stub body seeded once into the SQL preview
// editor (the user fills it in there). No CodeEditor is embedded here — the
// body/SQL is authored in phase-1's shared preview editor, per the
// class-first-form convention every other DDL form follows.
//
// Editing an existing routine is no longer a form: the navigator opens a
// function's pg_get_functiondef text — already a complete, executable
// CREATE OR REPLACE statement — in an editable definition tab instead (see
// SqlAdminController.openFunctionDefinition), so this form is create-only.

import { Panel, callable } from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { Grid, VBox } from "@jimka/typescript-ui/layout";
import { Checkbox, ComboBox, TextField } from "@jimka/typescript-ui/component/input";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { plus } from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import { Insets } from "@jimka/typescript-ui/primitive";
import type { CreateFunctionSpec } from "../contract";
import { buildCreateFunctionSpec } from "./ddlSpecs";
import type { FunctionArgRow } from "./ddlSpecs";
import { CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR } from "../theme";

Glyph.register(plus, minus);

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
const GRID_COLUMNS = 5;
const MODE_WEIGHT = 90;
const NAME_WEIGHT = 100;
const TYPE_WEIGHT = 130;
const DEFAULT_WEIGHT = 110;
const ROW_SPACING = 6;

/** One argument row's live handles: its grid cells and a reader. */
interface ArgRowHandle {
    inputs: Component[];
    read: () => FunctionArgRow;
    removeButton: Button;
}

/**
 * The CREATE FUNCTION form: a structural field group plus an add/remove-row
 * argument grid. The body is authored in the shared SQL preview editor, seeded
 * with a stub.
 */
class FunctionForm extends Panel {
    private readonly _schema: string;
    private readonly _nameField: TextField;
    private readonly _kindCombo: ComboBox;
    private readonly _languageField: TextField;
    private readonly _returnsField: TextField;
    private readonly _volatilityField: TextField;
    private readonly _replaceBox: Checkbox;
    private readonly _gridPanel: Panel;
    private readonly _grid: Grid;
    private readonly _rows: ArgRowHandle[] = [];

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

        const grid = new Grid({
            columns: GRID_COLUMNS,
            spacing: ROW_SPACING,
            columnTracks: [
                { mode: "weight", value: MODE_WEIGHT },
                { mode: "weight", value: NAME_WEIGHT },
                { mode: "weight", value: TYPE_WEIGHT },
                { mode: "weight", value: DEFAULT_WEIGHT },
                { mode: "content" }, // remove button
            ],
        });
        const gridPanel = Panel({ layoutManager: grid, insets: new Insets(0, 0, 0, 0) });

        const addButton = Button({
            glyph: "plus", text: "Add argument", showText: true, showDescription: false,
            compact: true, glyphColor: CONSTRUCTIVE_COLOR,
        });

        super({
            layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }),
            components: [
                nameField, kindCombo, languageField, returnsField, volatilityField, replaceBox,
                addButton, gridPanel,
            ],
        });

        this._schema = init.schema;
        this._nameField = nameField;
        this._kindCombo = kindCombo;
        this._languageField = languageField;
        this._returnsField = returnsField;
        this._volatilityField = volatilityField;
        this._replaceBox = replaceBox;
        this._gridPanel = gridPanel;
        this._grid = grid;

        addButton.on("action", () => this.appendRow());
        this.appendRow(); // seed with one empty row
    }

    /**
     * @returns the CreateFunctionSpec for the form's current fields.
     */
    getSpec(): CreateFunctionSpec {
        const kind = this._kindCombo.getValue() === "procedure" ? "procedure" : "function";

        return buildCreateFunctionSpec(
            this._schema,
            this._nameField.getValue(),
            kind,
            this._rows.map(r => r.read()),
            this._languageField.getValue() || "sql",
            NEW_FUNCTION_BODY_STUB,
            {
                returns: this._returnsField.getValue() || undefined,
                volatility: this._volatilityField.getValue() || undefined,
                replace: this._replaceBox.getValue(),
            },
        );
    }

    /** Append a new, empty argument row to the grid. */
    private appendRow(): void {
        const row = buildArgRow(() => this.removeRow(row));

        this._rows.push(row);

        for (const input of row.inputs) {
            this._gridPanel.addComponent(input);
        }

        this.syncGrid();
    }

    /** Remove one argument row (never past the last remaining row). */
    private removeRow(row: ArgRowHandle): void {
        const index = this._rows.indexOf(row);

        if (index < 0 || this._rows.length <= 1) {
            return;
        }

        for (const input of row.inputs) {
            this._gridPanel.removeComponent(input);
        }

        this._rows.splice(index, 1);
        this.syncGrid();
    }

    /** Resize the grid to the current row count and keep the sole row's remove button disabled. */
    private syncGrid(): void {
        this._grid.setRows(this._rows.length);

        const soleRow = this._rows.length === 1;

        for (const row of this._rows) {
            row.removeButton.setEnabled(!soleRow);
        }
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
function buildArgRow(onRemove: () => void): ArgRowHandle {
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
        inputs: [modeField, nameField, typeField, defaultField, removeButton],
        read,
        removeButton,
    };
}

const FunctionFormCallable = callable(FunctionForm);
type FunctionFormCallable = FunctionForm;
export { FunctionFormCallable as FunctionForm };
