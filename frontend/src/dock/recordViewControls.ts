// The shared record-view toggle, its Previous/Next steppers, and the
// quick-search field: one owner for the group both TableWorkPanel's data grid
// and QueryResultView's QueryResultGrid built for themselves, so the table
// grid and the query-result grid cannot drift apart.
//
// A composition helper, not a component — `definitionEditor.ts`'s
// `DefinitionEditor` is the precedent: the host lays out `buttons` and
// `searchField` itself, the way `definitionEditor.ts` hands over `editor`
// and `toolbar` rather than mounting either.
//
// The grid must still be in the library's "normal" display mode at
// construction time: `quickSearchFields` (gridQuickSearch.ts) is captured
// once here, and a grid already flipped into "rotated" mode exposes a
// different (field/value) column set that would silently starve every later
// match test.

import { Button, ToggleButton } from "@jimka/typescript-ui/component/button";
import { TextField }            from "@jimka/typescript-ui/component/input";
import { Table }                from "@jimka/typescript-ui/component/table";
import { Glyph }                from "@jimka/typescript-ui/component/display";
import type { Component }       from "@jimka/typescript-ui/core";
import type { ModelRecord }     from "@jimka/typescript-ui/data";
import { table_list }           from "@jimka/typescript-ui/glyphs/solid/table_list";
import { angle_left }           from "@jimka/typescript-ui/glyphs/solid/angle_left";
import { angle_right }          from "@jimka/typescript-ui/glyphs/solid/angle_right";
import { glyphButton, glyphToggleButton } from "./glyphButton";
import { stepIndex, visibleRecords }      from "./recordNavigation";
import { quickSearchFields, matchesQuery } from "./gridQuickSearch";
import { PRIMARY_COLOR } from "../theme";

Glyph.register(table_list, angle_left, angle_right);

/** Construction inputs for {@link RecordViewControls}. */
export interface RecordViewControlsOptions {
    /**
     * The grid these controls drive. Must still be in the `"normal"` display
     * mode: the constructor captures the quick-search field scope from it.
     */
    grid: Table;
    /** The quick-search field's placeholder text. */
    searchPlaceholder: string;
    /** Run after every display-mode flip, once the steppers have re-synced. */
    onRotate?: () => void;
    /** Run after every quick-search change, once the steppers have re-synced. */
    onQuery?: () => void;
}

/**
 * The shared record-view toggle, its Previous/Next steppers, and the
 * quick-search field, plus all the grid wiring behind them. `TableWorkPanel`
 * extends the group with `onRotate`/`onQuery` hooks for its own status line
 * and Add-button gating; `QueryResultGrid` passes neither.
 */
export class RecordViewControls {
    /** The record-view toggle, Previous and Next, in toolbar order. */
    readonly buttons: Component[];

    /** The quick-search field, placed separately in each host's toolbar. */
    readonly searchField: TextField;

    private readonly _grid    : Table;
    private readonly _fields  : string[];
    private readonly _toggle  : ToggleButton;
    private readonly _prev    : Button;
    private readonly _next    : Button;
    private readonly _onRotate: (() => void) | undefined;
    private readonly _onQuery : (() => void) | undefined;

    constructor(options: RecordViewControlsOptions) {
        this._grid     = options.grid;
        this._fields   = quickSearchFields(options.grid);
        this._onRotate = options.onRotate;
        this._onQuery  = options.onQuery;

        this._toggle = glyphToggleButton("table-list", PRIMARY_COLOR,
            "Record view (one record as field/value rows)", false);
        this._prev   = glyphButton("angle-left",  PRIMARY_COLOR, "Previous record", () => this.stepRecord(-1));
        this._next   = glyphButton("angle-right", PRIMARY_COLOR, "Next record",     () => this.stepRecord(1));

        this.searchField = new TextField({ placeholder: options.searchPlaceholder });
        this.buttons     = [this._toggle, this._prev, this._next];

        this._toggle.on("action", () => this.setRotated(this._toggle.isSelected()));
        this.searchField.on("change", this.applyQuickSearch);
        options.grid.on("selection", this.syncStepEnabled);

        this.syncStepEnabled();
    }

    /** The trimmed quick-search text currently in the field. */
    getQuery(): string {
        return this.searchField.getValue().trim();
    }

    /** Whether the grid is in the rotated (record) display mode. */
    isRotated(): boolean {
        return this._grid.getDisplayMode() === "rotated";
    }

    /** The loaded records matching the live quick-search query, in store order. */
    matchingRecords(): ModelRecord[] {
        const needle = this.getQuery().toLowerCase();

        return visibleRecords(this._grid.getStore().getRecords(),
            (r: ModelRecord) => matchesQuery(this._grid, this._fields, r, needle));
    }

    /** Flip the grid's display mode, the toggle, and the steppers, then run `onRotate`. */
    setRotated = (rotated: boolean): void => {
        const record = this._grid.getSelectedRecord();

        this._toggle.setSelected(rotated);

        if (rotated) {
            this._grid.setDisplayMode("rotated");
        } else {
            this._grid.setDisplayMode("normal");
            // setDisplayMode re-selects the displayed record but does not reveal
            // it; selectRecord's normal-mode path scrolls the row back into view.
            this._grid.selectRecord(record);
        }

        this.syncStepEnabled();
        this._onRotate?.();
    };

    /** Re-derive Previous/Next enablement. Safe to register by reference. */
    syncStepEnabled = (): void => {
        const rotated = this.isRotated();
        const records = this.matchingRecords();
        const current = this._grid.getSelectedRecord();
        const index   = current ? records.indexOf(current) : -1;

        this._prev.setEnabled(rotated && stepIndex(index, -1, records.length) !== null);
        this._next.setEnabled(rotated && stepIndex(index,  1, records.length) !== null);
    };

    /**
     * Installs a fresh quick-search predicate on the grid; empty clears it
     * entirely. Also re-syncs the steppers: their enabled state depends on
     * the query too, and only "selection" would otherwise trigger a
     * re-check, lagging behind what was just typed. Registered by reference
     * on `searchField` ("change") — arrow-function field.
     */
    private applyQuickSearch = (): void => {
        this._grid.setQuickSearch(this.getQuery());
        this.syncStepEnabled();
        this._onQuery?.();
    };

    /** Step the displayed record by `delta` within the rows matching the live query, clamped. */
    private stepRecord(delta: number): void {
        const records = this.matchingRecords();
        const current = this._grid.getSelectedRecord();
        const target  = stepIndex(current ? records.indexOf(current) : -1, delta, records.length);

        if (target !== null) {
            this._grid.selectRecord(records[target]);
        }
    }
}
