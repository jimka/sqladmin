// The shared add/remove-row grid every DDL create form's row list is built
// from — one owner for what CreateTableForm, EnumTypeForm, CompositeTypeForm
// and FunctionForm each used to carry a private copy of. A removed row's
// cells are DISPOSED, not merely detached: Component.removeComponent only
// unwires and detaches a child (see the plan's `remove-does-not-dispose`
// footnote, verified against the shipped bundle), so every one of those four
// copies orphaned a row's TextFields and its remove Button (with a live
// "action" listener) on every removal. `cells` must include the row's remove
// button — the base disposes every cell in the array on removal, and a
// button left out of it would be orphaned exactly as before.

import { Panel } from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { Grid, VBox } from "@jimka/typescript-ui/layout";
import type { GridTrack } from "@jimka/typescript-ui/layout";
import { Button } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { plus } from "@jimka/typescript-ui/glyphs/solid/plus";
import { Insets } from "@jimka/typescript-ui/primitive";
import { CONSTRUCTIVE_COLOR } from "../theme";

Glyph.register(plus);

// Vertical gap between the header widgets, the Add button, and the row grid
// — the row-spacing every DDL row-grid form already used before this base
// existed; kept as the base's own constant so a subclass no longer carries it.
const ROW_SPACING = 6;

/** One built row of an add/remove-row grid. */
export interface RowGridRow<TRow> {
    /**
     * The row's grid cells, one per column track, in display order. MUST
     * include `removeButton` — the base disposes every cell on removal, and a
     * button left out of this array would be orphaned.
     */
    cells: Component[];
    /** Snapshot the row's current values. */
    read: () => TRow;
    /** The row's remove button. The base disables it while it is the only row. */
    removeButton: Button;
}

/** Construction inputs for {@link RowGridPanel}. */
export interface RowGridPanelOptions<TRow> {
    /** Components stacked above the Add button, in order (typically a name field). */
    header: Component[];
    /** The Add button's face text, e.g. `"Add column"`. */
    addLabel: string;
    /** The row grid's column tracks. Its length is the grid's column count. */
    columnTracks: GridTrack[];
    /**
     * Build one row. `onRemove` is already wired to the base's removal path;
     * the factory must register it on the row's remove button.
     */
    buildRow: (onRemove: () => void, prefill?: TRow) => RowGridRow<TRow>;
}

/**
 * The shared add/remove-row grid base: a header, an Add button, and a Grid
 * of built rows. Never constructed directly — every DDL form with a row grid
 * `extends` this with its own `TRow` and row factory.
 */
export abstract class RowGridPanel<TRow> extends Panel {
    private readonly _grid: Grid;
    private readonly _gridPanel: Panel;
    private readonly _buildRow: (onRemove: () => void, prefill?: TRow) => RowGridRow<TRow>;
    private readonly _rows: RowGridRow<TRow>[] = [];

    protected constructor(options: RowGridPanelOptions<TRow>) {
        const grid = new Grid({
            columns:      options.columnTracks.length,
            spacing:      ROW_SPACING,
            columnTracks: options.columnTracks,
        });
        const gridPanel = Panel({ layoutManager: grid, insets: new Insets(0, 0, 0, 0) });
        const addButton = Button({
            glyph: "plus", text: options.addLabel, showText: true, showDescription: false,
            compact: true, glyphColor: CONSTRUCTIVE_COLOR,
        });

        super({
            layoutManager: new VBox({ itemAlign: "stretch", spacing: ROW_SPACING }),
            components:    [...options.header, addButton, gridPanel],
        });

        this._grid      = grid;
        this._gridPanel = gridPanel;
        this._buildRow  = options.buildRow;

        addButton.on("action", () => this.appendRow());
    }

    /** Every row's current values, in display order. */
    protected readRows(): TRow[] {
        return this._rows.map(r => r.read());
    }

    /** Append a row, optionally pre-filled. Call from a subclass constructor to seed. */
    protected appendRow(prefill?: TRow): void {
        const row = this._buildRow(() => this.removeRow(row), prefill);

        this._rows.push(row);

        for (const cell of row.cells) {
            this._gridPanel.addComponent(cell);
        }

        this.syncGrid();
    }

    /** Remove one row (never past the last remaining row), disposing its cells. */
    private removeRow(row: RowGridRow<TRow>): void {
        const index = this._rows.indexOf(row);

        if (index < 0 || this._rows.length <= 1) {
            return;
        }

        for (const cell of row.cells) {
            this._gridPanel.removeComponent(cell);
            cell.dispose();
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
