// The CREATE TABLE dialog form: a table-name field plus an add/remove-row
// column grid, mirroring FilterDialog's Grid idiom (see FilterDialog.ts). The
// column rows themselves collect raw name/type/default/nullable/primaryKey
// fields; readSpec() hands them to the pure buildCreateTableSpec helper.

import { Panel } from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { Grid, VBox } from "@jimka/typescript-ui/layout";
import { Checkbox, TextField } from "@jimka/typescript-ui/component/input";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { plus } from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import { Insets } from "@jimka/typescript-ui/primitive";
import type { CreateTableSpec } from "../contract";
import { buildCreateTableSpec } from "./ddlSpecs";
import type { ColumnRow } from "./ddlSpecs";
import { CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR } from "../theme";

Glyph.register(plus, minus);

// Row geometry: name/type/default share the dialog width by weight; the
// nullable/PK checkboxes and the remove button are content-sized. Mirrors
// FilterDialog's COLUMN_WEIGHT-style tracks, tuned for four extra fields.
const NAME_WEIGHT    = 130;
const TYPE_WEIGHT    = 120;
const DEFAULT_WEIGHT = 130;
const ROW_SPACING    = 6;

// One row has six cells: name, type, nullable, default, primary-key,
// remove — matches the six `columnTracks` entries below.
const GRID_COLUMNS = 6;

/** One column row's live handles: its grid cells and a reader. */
interface RowHandle {
    inputs: Component[];
    read: () => ColumnRow;
    removeButton: Button;
}

/**
 * The CREATE TABLE form: a table-name field over an add/remove-row column
 * grid. Embedded as the `form` of a `SqlPreviewDialog` by the controller's
 * `createTable` launcher.
 */
export class CreateTableForm extends Panel {
    private readonly _schema: string;
    private readonly _nameField: TextField;
    private readonly _grid: Grid;
    private readonly _gridPanel: Panel;
    private readonly _rows: RowHandle[] = [];

    /**
     * @param schema - the schema the new table is created in (fixed — the
     *   launcher is invoked from that schema's navigator node).
     */
    constructor(schema: string) {
        const nameField = new TextField({ placeholder: "table name" });
        const grid = new Grid({
            columns: GRID_COLUMNS,
            spacing: ROW_SPACING,
            columnTracks: [
                { mode: "weight", value: NAME_WEIGHT },
                { mode: "weight", value: TYPE_WEIGHT },
                { mode: "content" }, // nullable checkbox
                { mode: "weight", value: DEFAULT_WEIGHT },
                { mode: "content" }, // primary-key checkbox
                { mode: "content" }, // remove button
            ],
        });
        const gridPanel = Panel({ layoutManager: grid, insets: new Insets(0, 0, 0, 0) });
        const addButton = Button({
            glyph: "plus", text: "Add column", showText: true, showDescription: false,
            compact: true, glyphColor: CONSTRUCTIVE_COLOR,
        });

        super({
            layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }),
            components:    [nameField, addButton, gridPanel],
        });

        this._schema    = schema;
        this._nameField = nameField;
        this._grid       = grid;
        this._gridPanel  = gridPanel;

        addButton.on("action", () => this.appendRow());
        this.appendRow(); // seed with one empty row
    }

    /**
     * @returns the CreateTableSpec for the form's current name + rows
     *   (rows with a blank name are dropped by buildCreateTableSpec).
     */
    readSpec(): CreateTableSpec {
        return buildCreateTableSpec(this._schema, this._nameField.getValue(), this._rows.map(r => r.read()));
    }

    /** Append a new, empty column row to the grid. */
    private appendRow(): void {
        const row = buildColumnRow(() => this.removeRow(row));

        this._rows.push(row);

        for (const input of row.inputs) {
            this._gridPanel.addComponent(input);
        }

        this.syncGrid();
    }

    /** Remove one column row (never past the last remaining row). */
    private removeRow(row: RowHandle): void {
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
 * Build one column row — name/type TextFields, nullable/PK Checkboxes, a
 * default TextField, and a remove ("−") button — as the six cells the caller
 * tiles into the grid, with a reader that snapshots them into a ColumnRow.
 *
 * @param onRemove - invoked when the row's remove button is pressed.
 * @returns the row's cells, a reader, and the remove button.
 */
function buildColumnRow(onRemove: () => void): RowHandle {
    const nameField     = new TextField({ placeholder: "column name" });
    const typeField      = new TextField({ placeholder: "type, e.g. text" });
    const nullableBox   = Checkbox({ label: "Null", selected: true });
    const defaultField  = new TextField({ placeholder: "default (optional)" });
    const primaryKeyBox = Checkbox({ label: "PK", selected: false });

    const removeButton = Button({
        glyph: "minus", text: "Remove column", showText: false, showDescription: false,
        foregroundColor: DESTRUCTIVE_COLOR, compact: true,
    });
    removeButton.on("action", onRemove);

    const read = (): ColumnRow => ({
        name:       nameField.getValue(),
        type:       typeField.getValue(),
        nullable:   nullableBox.getValue(),
        default:    defaultField.getValue(),
        primaryKey: primaryKeyBox.getValue(),
    });

    return {
        inputs: [nameField, typeField, nullableBox, defaultField, primaryKeyBox, removeButton],
        read,
        removeButton,
    };
}
