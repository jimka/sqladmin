// The CREATE TYPE ... AS ENUM dialog form: a name field plus an add/remove-row
// label grid, mirroring CreateTableForm's Grid idiom.

import { Panel, callable } from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { Grid, VBox } from "@jimka/typescript-ui/layout";
import { TextField } from "@jimka/typescript-ui/component/input";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { plus } from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import { Insets } from "@jimka/typescript-ui/primitive";
import type { CreateEnumTypeSpec } from "../contract";
import { buildCreateEnumTypeSpec } from "./ddlSpecs";
import { CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR } from "../theme";

Glyph.register(plus, minus);

// One label row has two cells: the label field and the remove button.
const GRID_COLUMNS = 2;
const LABEL_WEIGHT = 200;
const ROW_SPACING = 6;

/** One label row's live handles: its grid cells and a reader. */
interface RowHandle {
    inputs: Component[];
    read: () => string;
    removeButton: Button;
}

/**
 * The CREATE TYPE ... AS ENUM form: a type-name field over an add/remove-row
 * label grid. Embedded as the `form` of a `SqlPreviewDialog` by the
 * controller's `createType` launcher (enum category).
 */
class EnumTypeForm extends Panel {
    private readonly _schema: string;
    private readonly _nameField: TextField;
    private readonly _grid: Grid;
    private readonly _gridPanel: Panel;
    private readonly _rows: RowHandle[] = [];

    /**
     * @param init - `schema` fixes the new type's schema (the launcher is
     *   invoked from that schema's navigator node).
     */
    constructor(init: { schema: string }) {
        const nameField = new TextField({ placeholder: "type name" });
        const grid = new Grid({
            columns: GRID_COLUMNS,
            spacing: ROW_SPACING,
            columnTracks: [{ mode: "weight", value: LABEL_WEIGHT }, { mode: "content" }],
        });
        const gridPanel = Panel({ layoutManager: grid, insets: new Insets(0, 0, 0, 0) });
        const addButton = Button({
            glyph: "plus", text: "Add label", showText: true, showDescription: false,
            compact: true, glyphColor: CONSTRUCTIVE_COLOR,
        });

        super({
            layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }),
            components:    [nameField, addButton, gridPanel],
        });

        this._schema    = init.schema;
        this._nameField = nameField;
        this._grid       = grid;
        this._gridPanel  = gridPanel;

        addButton.on("action", () => this.appendRow());
        this.appendRow();
        this.appendRow(); // seed with two empty rows — an enum needs at least one label to be useful
    }

    /**
     * @returns the CreateEnumTypeSpec for the form's current name + labels
     *   (blank labels are dropped by buildCreateEnumTypeSpec).
     */
    getSpec(): CreateEnumTypeSpec {
        return buildCreateEnumTypeSpec(this._schema, this._nameField.getValue(), this._rows.map(r => r.read()));
    }

    /** Append a new, empty label row to the grid. */
    private appendRow(): void {
        const row = buildLabelRow(() => this.removeRow(row));

        this._rows.push(row);

        for (const input of row.inputs) {
            this._gridPanel.addComponent(input);
        }

        this.syncGrid();
    }

    /** Remove one label row (never past the last remaining row). */
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
 * Build one label row — a text field and a remove ("−") button — as the two
 * cells the caller tiles into the grid, with a reader that snapshots the
 * field's current text.
 *
 * @param onRemove - invoked when the row's remove button is pressed.
 * @returns the row's cells, a reader, and the remove button.
 */
function buildLabelRow(onRemove: () => void): RowHandle {
    const labelField = new TextField({ placeholder: "label" });

    const removeButton = Button({
        glyph: "minus", text: "Remove label", showText: false, showDescription: false,
        foregroundColor: DESTRUCTIVE_COLOR, compact: true,
    });
    removeButton.on("action", onRemove);

    return {
        inputs: [labelField, removeButton],
        read: () => labelField.getValue(),
        removeButton,
    };
}

const EnumTypeFormCallable = callable(EnumTypeForm);
type EnumTypeFormCallable = EnumTypeForm;
export { EnumTypeFormCallable as EnumTypeForm };
