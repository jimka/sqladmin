// The ALTER TYPE ... ADD VALUE dialog form: shows an existing enum's current
// labels for reference (read-only — Postgres has no CREATE OR REPLACE TYPE,
// so an enum edit is append-only; see the function-type-ddl plan's "enum
// edits are append-only" decision), a new-label field, and an optional
// BEFORE/AFTER placement relative to an existing label.

import { Panel, callable } from "@jimka/typescript-ui/core";
import { VBox } from "@jimka/typescript-ui/layout";
import { ComboBox, Text, TextField } from "@jimka/typescript-ui/component/input";
import type { AlterTypeAddValueSpec } from "../contract";
import { buildAlterTypeAddValueSpec } from "./ddlSpecs";

const PLACEMENT_NONE = "none";
const PLACEMENT_BEFORE = "before";
const PLACEMENT_AFTER = "after";

// Vertical gap between the existing-labels line, the new-value field, and the
// placement controls.
const ROW_SPACING = 6;

/**
 * The ALTER TYPE ... ADD VALUE form: a read-only existing-labels line, a new
 * label field, and a BEFORE/AFTER placement combo + existing-label combo
 * (disabled/ignored when placement is "none" — appended at the end).
 */
class AddEnumValueForm extends Panel {
    private readonly _schema: string;
    private readonly _name: string;
    private readonly _valueField: TextField;
    private readonly _placementCombo: ComboBox;
    private readonly _existingCombo: ComboBox;

    /**
     * @param init - the enum type's schema/name and its current labels
     *   (shown for reference and offered as BEFORE/AFTER targets).
     */
    constructor(init: { schema: string; name: string; existingLabels: string[] }) {
        const existingLine = new Text(
            init.existingLabels.length > 0
                ? `Current labels: ${init.existingLabels.join(", ")}`
                : "Current labels: (none)",
        );
        const valueField = new TextField({ placeholder: "new label" });
        const placementCombo = new ComboBox({
            items: [
                { key: PLACEMENT_NONE, label: "Append at the end" },
                { key: PLACEMENT_BEFORE, label: "Before…" },
                { key: PLACEMENT_AFTER, label: "After…" },
            ],
            value: PLACEMENT_NONE,
        });
        const existingCombo = new ComboBox({
            items: init.existingLabels.map(label => ({ key: label, label })),
            value: init.existingLabels[0] ?? "",
        });

        super({
            layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }),
            components:    [existingLine, valueField, placementCombo, existingCombo],
        });

        this._schema = init.schema;
        this._name = init.name;
        this._valueField = valueField;
        this._placementCombo = placementCombo;
        this._existingCombo = existingCombo;
    }

    /** @returns the AlterTypeAddValueSpec for the form's current fields. */
    getSpec(): AlterTypeAddValueSpec {
        const value = this._valueField.getValue();
        const placement = this._placementCombo.getValue();

        if (placement !== PLACEMENT_BEFORE && placement !== PLACEMENT_AFTER) {
            return buildAlterTypeAddValueSpec(this._schema, this._name, value);
        }

        return buildAlterTypeAddValueSpec(this._schema, this._name, value, {
            placement,
            label: this._existingCombo.getValue(),
        });
    }
}

const AddEnumValueFormCallable = callable(AddEnumValueForm);
type AddEnumValueFormCallable = AddEnumValueForm;
export { AddEnumValueFormCallable as AddEnumValueForm };
