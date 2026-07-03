import { describe, it, expect } from "vitest";
import { capRows } from "./capRows";

describe("capRows", () => {
    it("returns the rows unchanged when at or below the cap", () => {
        const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];

        expect(capRows(rows, 3)).toBe(rows);
        expect(capRows(rows, 5)).toBe(rows);
    });

    it("returns exactly the first max rows when over the cap", () => {
        const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }];

        const capped = capRows(rows, 2);

        expect(capped).toEqual([{ a: 1 }, { a: 2 }]);
    });
});
