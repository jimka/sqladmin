// The generic "confirm a drop" form: a one-line summary plus an optional
// CASCADE checkbox. Reused by drop-table, drop-column, drop-constraint, and
// drop-index — every drop launcher builds one with its own summary text and
// embeds it as a SqlPreviewDialog's `form`.

import { Panel, callable } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { Checkbox } from "@jimka/typescript-ui/component/input";
import { Text } from "@jimka/typescript-ui/component/input";

// Vertical gap between the summary line and the CASCADE checkbox.
const ROW_SPACING = 6;

/** The drop-confirmation form: a summary line plus an optional CASCADE checkbox. */
class ConfirmCascadeForm extends Panel {
    private readonly _cascadeBox: Checkbox;

    /**
     * @param summary - a one-line description of what is being dropped
     *   (e.g. `Drop table "public"."customers"?`).
     */
    constructor(summary: string) {
        const cascadeBox = Checkbox({ label: "CASCADE (also drop dependent objects)", selected: false });

        super({
            layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }),
            components:    [new Text(summary), cascadeBox],
        });

        this._cascadeBox = cascadeBox;
    }

    /** @returns whether the CASCADE checkbox is checked. */
    readSpec(): { cascade: boolean } {
        return { cascade: this._cascadeBox.getValue() };
    }
}

const ConfirmCascadeFormCallable = callable(ConfirmCascadeForm);
type ConfirmCascadeFormCallable = ConfirmCascadeForm;
export { ConfirmCascadeFormCallable as ConfirmCascadeForm };
