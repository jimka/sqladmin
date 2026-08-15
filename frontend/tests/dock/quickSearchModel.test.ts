import { describe, it, expect } from "vitest";
import { quickSearchStatus } from "../../src/dock/quickSearchModel";

describe("quickSearchStatus", () => {
    it("formats a plain count with no server remainder", () => {
        expect(quickSearchStatus(3, 100, 100)).toBe("3 of 100 loaded rows");
    });

    it("appends the more-on-the-server clause when totalCount exceeds loadedCount", () => {
        expect(quickSearchStatus(0, 100, 4500)).toBe("0 of 100 loaded rows (4400 more on the server not searched)");
    });

    it("uses the singular 'row' when exactly one row is loaded", () => {
        expect(quickSearchStatus(1, 1, 1)).toBe("1 of 1 loaded row");
    });

    it("uses 'rows' when zero rows are loaded, with totalCount undefined", () => {
        expect(quickSearchStatus(0, 0, undefined)).toBe("0 of 0 loaded rows");
    });

    it("omits the server-remainder clause when totalCount is undefined", () => {
        expect(quickSearchStatus(5, 20, undefined)).toBe("5 of 20 loaded rows");
    });

    it("omits the server-remainder clause when totalCount equals loadedCount", () => {
        expect(quickSearchStatus(2, 50, 50)).toBe("2 of 50 loaded rows");
    });

    it("omits the server-remainder clause when totalCount is less than loadedCount", () => {
        // Shouldn't normally happen, but the clause's condition is a strict >.
        expect(quickSearchStatus(2, 50, 10)).toBe("2 of 50 loaded rows");
    });

    it("uses 'rows' (plural) for any loadedCount other than exactly one", () => {
        expect(quickSearchStatus(0, 2, 2)).toBe("0 of 2 loaded rows");
    });
});
