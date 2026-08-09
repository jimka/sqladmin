import { describe, it, expect } from "vitest";
import { stepIndex } from "../../src/dock/recordNavigation";

describe("stepIndex", () => {
    it("returns null when already at the first record", () => {
        expect(stepIndex(0, -1, 120)).toBeNull();
    });

    it("steps forward from the first record", () => {
        expect(stepIndex(0, 1, 120)).toBe(1);
    });

    it("returns null at the last loaded record (the page boundary)", () => {
        expect(stepIndex(99, 1, 100)).toBeNull();
    });

    it("steps to the first record when nothing is displayed yet and delta is 1", () => {
        expect(stepIndex(-1, 1, 120)).toBe(0);
    });

    it("steps to the first record when nothing is displayed yet and delta is -1", () => {
        expect(stepIndex(-1, -1, 120)).toBe(0);
    });

    it("returns null for an empty store", () => {
        expect(stepIndex(-1, 1, 0)).toBeNull();
    });

    it("returns null both ways when only one record is loaded", () => {
        expect(stepIndex(0, 1, 1)).toBeNull();
        expect(stepIndex(0, -1, 1)).toBeNull();
    });

    it("clamps rather than overshooting when delta exceeds the remaining distance", () => {
        expect(stepIndex(98, 5, 100)).toBe(99);
    });
});
