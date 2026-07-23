// The CREATE TYPE ... AS (...) composite-type dialog form: a name field plus
// an add/remove-row (name, type) attribute grid, mirroring CreateTableForm's
// Grid idiom. An optional `prefill` (edit mode — see the function-type-ddl
// plan's "composite recreate" decision: restructuring an existing composite
// in place is a Non-Goal, so editing one only clones its current attributes
// into a fresh CREATE TYPE for the user to reconcile with the original) seeds
// the grid instead of one empty row.

import { Panel, callable } from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { Grid, VBox } from "@jimka/typescript-ui/layout";
import { TextField } from "@jimka/typescript-ui/component/input";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { plus } from "@jimka/typescript-ui/glyphs/solid/plus";
import { minus } from "@jimka/typescript-ui/glyphs/solid/minus";
import { Insets } from "@jimka/typescript-ui/primitive";
import type { CreateCompositeTypeSpec } from "../contract";
import { buildCreateCompositeTypeSpec } from "./ddlSpecs";
import { CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR } from "../theme";

Glyph.register(plus, minus);

// One attribute row has three cells: name, type, remove.
const GRID_COLUMNS = 3;
const NAME_WEIGHT = 140;
const TYPE_WEIGHT = 140;
const ROW_SPACING = 6;

/** One attribute row's live handles: its grid cells and a reader. */
interface RowHandle {
    inputs: Component[];
    read: () => { name: string; type: string };
    removeButton: Button;
}

/**
 * The CREATE TYPE ... AS (...) form: a type-name field over an add/remove-row
 * attribute grid. Embedded as the `form` of a `SqlPreviewDialog` by the
 * controller's `createType` launcher (composite category) and `editType`
 * (composite recreate/clone).
 */
class CompositeTypeForm extends Panel {
    private readonly _schema: string;
    private readonly _nameField: TextField;
    private readonly _grid: Grid;
    private readonly _gridPanel: Panel;
    private readonly _rows: RowHandle[] = [];

    /**
     * @param init - `schema` fixes the new type's schema; `prefill` (edit
     *   mode) seeds the grid with the existing composite's attributes.
     */
    constructor(init: { schema: string; prefill?: { name: string; type: string }[] }) {
        const nameField = new TextField({ placeholder: "type name" });
        const grid = new Grid({
            columns: GRID_COLUMNS,
            spacing: ROW_SPACING,
            columnTracks: [
                { mode: "weight", value: NAME_WEIGHT },
                { mode: "weight", value: TYPE_WEIGHT },
                { mode: "content" }, // remove button
            ],
        });
        const gridPanel = Panel({ layoutManager: grid, insets: new Insets(0, 0, 0, 0) });
        const addButton = Button({
            glyph: "plus", text: "Add attribute", showText: true, showDescription: false,
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

        if (init.prefill && init.prefill.length > 0) {
            for (const attr of init.prefill) {
                this.appendRow(attr);
            }
        } else {
            this.appendRow(); // seed with one empty row
        }
    }

    /**
     * @returns the CreateCompositeTypeSpec for the form's current name +
     *   attributes (rows with a blank name/type are dropped by
     *   buildCreateCompositeTypeSpec).
     */
    getSpec(): CreateCompositeTypeSpec {
        return buildCreateCompositeTypeSpec(this._schema, this._nameField.getValue(), this._rows.map(r => r.read()));
    }

    /** Append a new attribute row to the grid, optionally pre-filled. */
    private appendRow(prefill?: { name: string; type: string }): void {
        const row = buildAttrRow(() => this.removeRow(row), prefill);

        this._rows.push(row);

        for (const input of row.inputs) {
            this._gridPanel.addComponent(input);
        }

        this.syncGrid();
    }

    /** Remove one attribute row (never past the last remaining row). */
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
 * Build one attribute row — name/type TextFields and a remove ("−") button —
 * as the three cells the caller tiles into the grid, with a reader that
 * snapshots them into a `{name, type}` pair.
 *
 * @param onRemove - invoked when the row's remove button is pressed.
 * @param prefill - optional initial `{name, type}` text for the row.
 * @returns the row's cells, a reader, and the remove button.
 */
function buildAttrRow(onRemove: () => void, prefill?: { name: string; type: string }): RowHandle {
    const nameField = new TextField({ placeholder: "attribute name", text: prefill?.name ?? "" });
    const typeField = new TextField({ placeholder: "type, e.g. text", text: prefill?.type ?? "" });

    const removeButton = Button({
        glyph: "minus", text: "Remove attribute", showText: false, showDescription: false,
        foregroundColor: DESTRUCTIVE_COLOR, compact: true,
    });
    removeButton.on("action", onRemove);

    const read = (): { name: string; type: string } => ({ name: nameField.getValue(), type: typeField.getValue() });

    return {
        inputs: [nameField, typeField, removeButton],
        read,
        removeButton,
    };
}

const CompositeTypeFormCallable = callable(CompositeTypeForm);
type CompositeTypeFormCallable = CompositeTypeForm;
export { CompositeTypeFormCallable as CompositeTypeForm };
