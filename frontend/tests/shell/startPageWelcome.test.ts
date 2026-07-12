import { describe, it, expect } from "vitest";
import { shouldShowWelcome } from "../../src/shell/startPageWelcome";
import type { DbObjectRef } from "../../src/contract";
import type { SavedQuery } from "../../src/data/queryStore";

const TABLE_REF: DbObjectRef = { connectionId: "default", schema: "public", name: "orders", kind: "table" };
const SAVED_QUERY: SavedQuery = { name: "top orders", sql: "select 1", savedAt: 0 };

/** A stub matching only the two accessors `shouldShowWelcome` reads. */
function stores(recentTables: DbObjectRef[], savedList: SavedQuery[]): { recentTables: () => DbObjectRef[]; savedList: () => SavedQuery[] } {
    return { recentTables: () => recentTables, savedList: () => savedList };
}

describe("shouldShowWelcome", () => {
    it("is true when there are no recent tables and no saved queries", () => {
        expect(shouldShowWelcome(stores([], []))).toBe(true);
    });

    it("is false when there is a recent table", () => {
        expect(shouldShowWelcome(stores([TABLE_REF], []))).toBe(false);
    });

    it("is false when there is a saved query", () => {
        expect(shouldShowWelcome(stores([], [SAVED_QUERY]))).toBe(false);
    });

    it("is false when both are populated", () => {
        expect(shouldShowWelcome(stores([TABLE_REF], [SAVED_QUERY]))).toBe(false);
    });
});
