// The Type Info tab's pure row mapping: numbering an enum's ordered labels
// for the body grid, and the Category fieldset row's display text.

import { describe, expect, it } from "vitest";
import { categoryLabel, enumLabelRows } from "../../src/dock/typeInfoRows";

describe("enumLabelRows", () => {
    it("numbers labels 1-based, preserving input order", () => {
        expect(enumLabelRows(["low", "medium", "high", "urgent"])).toEqual([
            { position: 1, label: "low" },
            { position: 2, label: "medium" },
            { position: 3, label: "high" },
            { position: 4, label: "urgent" },
        ]);
    });

    it("returns [] for []", () => {
        expect(enumLabelRows([])).toEqual([]);
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
