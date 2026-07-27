import { describe, it, expect } from "vitest";
import { uniformNodeWidth } from "../../src/data/uniformNodeWidth";

describe("uniformNodeWidth", () => {
    it("sizes to the longest label, so no label is clipped", () => {
        const short = uniformNodeWidth(["a", "bb"]);
        const long = uniformNodeWidth(["a", "bb", "a_much_longer_table_name"]);

        expect(long).toBeGreaterThan(short);
    });

    it("depends only on the longest label, not on how many there are", () => {
        expect(uniformNodeWidth(["users", "projects"]))
            .toBe(uniformNodeWidth(["projects", "users", "orders", "projects"]));
    });

    it("clears the width the longest label actually renders at", () => {
        // Measured on the 154-table mesh diagram: node width fits
        // 6.77 * characters + 45.5 with a maximum residual of 14.2px, and the
        // widest node ("asset_status_history", 20 chars) rendered at 178px.
        expect(uniformNodeWidth(["asset_status_history"])).toBeGreaterThanOrEqual(178);
    });

    it("stays within a reasonable margin of the rendered width", () => {
        // Generous enough to clear the fit's residual, tight enough that a layer
        // does not carry an extra node's worth of whitespace.
        expect(uniformNodeWidth(["asset_status_history"])).toBeLessThanOrEqual(178 + 40);
    });

    it("returns a whole number of pixels", () => {
        expect(uniformNodeWidth(["core_status_history"]) % 1).toBe(0);
    });

    it("falls back to the minimum for an empty graph rather than returning zero", () => {
        expect(uniformNodeWidth([])).toBeGreaterThan(0);
    });

    it("never returns less than the minimum, however short the labels", () => {
        expect(uniformNodeWidth(["a"])).toBe(uniformNodeWidth([]));
    });
});
