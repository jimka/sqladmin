// The Type Info tab's pure row mapping: numbering an enum's ordered labels
// for the body grid, mapping a composite's attributes for its body grid, and
// the Category fieldset row's display text.

import { describe, expect, it } from "vitest";
import { attributeRows, categoryLabel, enumLabelRows } from "../../src/dock/typeInfoRows";

describe("enumLabelRows", () => {
    it("numbers labels 1-based, preserving input order, and carries originalLabel", () => {
        expect(enumLabelRows(["low", "medium", "high", "urgent"])).toEqual([
            { position: 1, label: "low", originalLabel: "low" },
            { position: 2, label: "medium", originalLabel: "medium" },
            { position: 3, label: "high", originalLabel: "high" },
            { position: 4, label: "urgent", originalLabel: "urgent" },
        ]);
    });

    it("returns [] for []", () => {
        expect(enumLabelRows([])).toEqual([]);
    });
});

describe("attributeRows", () => {
    it("carries name/type through and adds originalName", () => {
        expect(attributeRows([{ name: "a", type: "int" }, { name: "b", type: "text" }])).toEqual([
            { name: "a", type: "int", originalName: "a" },
            { name: "b", type: "text", originalName: "b" },
        ]);
    });

    it("returns [] for []", () => {
        expect(attributeRows([])).toEqual([]);
    });
});

describe("categoryLabel", () => {
    it("titlecases 'enum' to 'Enum'", () => {
        expect(categoryLabel("enum")).toBe("Enum");
    });

    it("titlecases 'composite' to 'Composite'", () => {
        expect(categoryLabel("composite")).toBe("Composite");
    });
});
