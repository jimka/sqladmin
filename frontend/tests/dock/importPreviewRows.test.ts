import { describe, it, expect } from "vitest";
import { buildPreviewGridRows } from "../../src/dock/importPreviewRows";
import type { ImportRowResult } from "../../src/contract";

describe("buildPreviewGridRows", () => {
    it("projects an ok row to its values plus an empty error cell", () => {
        const rows: ImportRowResult[] = [{ rowNumber: 1, ok: true, values: { id: 1, name: "ada" } }];

        expect(buildPreviewGridRows(rows, 100)).toEqual([{ id: 1, name: "ada", error: "" }]);
    });

    it("projects a failed row to just its error, with no other cells", () => {
        const rows: ImportRowResult[] = [{ rowNumber: 1, ok: false, error: "name: required" }];

        expect(buildPreviewGridRows(rows, 100)).toEqual([{ error: "name: required" }]);
    });

    it("caps the result at pageSize, regardless of how many rows were previewed", () => {
        const rows: ImportRowResult[] = Array.from({ length: 5 }, (_, i) => (
            { rowNumber: i + 1, ok: true, values: { id: i } }
        ));

        expect(buildPreviewGridRows(rows, 2)).toEqual([
            { id: 0, error: "" },
            { id: 1, error: "" },
        ]);
    });

    it("returns every row when there are fewer than pageSize", () => {
        const rows: ImportRowResult[] = [{ rowNumber: 1, ok: true, values: { id: 1 } }];

        expect(buildPreviewGridRows(rows, 100)).toHaveLength(1);
    });

    it("returns an empty array for an empty preview", () => {
        expect(buildPreviewGridRows([], 100)).toEqual([]);
    });
});
