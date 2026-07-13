// A checklist of a table's columns, used by ConstraintForm (PK/unique/FK
// columns) and IndexForm (indexed columns). readSelected() returns the
// checked names in the table's own introspected column order — not the
// order they were checked in — via the pure orderColumnsBySelection helper,
// since composite-key/index column order is semantically significant to
// Postgres (see plans/implemented/table-ddl.md's "Composite-key column
// ordering" mitigation).

import { Panel } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { Checkbox } from "@jimka/typescript-ui/component/input";
import { orderColumnsBySelection } from "./ddlSpecs";

// Vertical gap between checklist rows — a compact list of checkboxes, not a
// spaced-out form.
const ROW_SPACING = 2;

/** A `VBox` of one `Checkbox` per column, for a constraint/index form. */
export class ColumnChecklist extends Panel {
    private readonly _columns: string[];
    private readonly _boxes: Checkbox[];

    /**
     * @param columns - the table's columns, in their introspected order.
     * @param initiallySelected - column names to pre-check (e.g. an existing
     *   constraint's columns, when the form is seeded for an edit).
     */
    constructor(columns: string[], initiallySelected: string[] = []) {
        const initial = new Set(initiallySelected);
        const boxes  = columns.map(name => Checkbox({ label: name, selected: initial.has(name) }));

        super({ layoutManager: new VBox({ spacing: ROW_SPACING }), components: boxes });
        this._columns = columns;
        this._boxes   = boxes;
    }

    /**
     * @returns the checked column names, in the table's own column order.
     */
    readSelected(): string[] {
        const selected = this._columns.filter((_, i) => this._boxes[i].getValue());

        return orderColumnsBySelection(this._columns, selected);
    }
}
