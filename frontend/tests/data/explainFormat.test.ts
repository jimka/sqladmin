import { describe, it, expect } from "vitest";
import { formatMetric, formatRange } from "../../src/data/explainFormat";

describe("formatMetric", () => {
    it("renders integers as-is", () => {
        expect(formatMetric(100)).toBe("100");
        expect(formatMetric(0)).toBe("0");
    });

    it("rounds fractions to two decimals and trims trailing zeros", () => {
        expect(formatMetric(12.5)).toBe("12.5");
        expect(formatMetric(0.29)).toBe("0.29");
        expect(formatMetric(3.14159)).toBe("3.14");
        expect(formatMetric(2.5)).toBe("2.5");
    });

    it("renders undefined as an en dash", () => {
        expect(formatMetric(undefined)).toBe("–");
    });
});

describe("formatRange", () => {
    it("shows both ends when they format differently", () => {
        expect(formatRange(0, 35.5)).toBe("0 … 35.5");
        expect(formatRange(0.29, 12.5)).toBe("0.29 … 12.5");
    });

    it("collapses to one value when both ends format identically", () => {
        // Differ only below the displayed precision → one number, not "12.5 … 12.5".
        expect(formatRange(12.501, 12.503)).toBe("12.5");
        expect(formatRange(4, 4)).toBe("4");
    });

    it("collapses to the present end when only one is given", () => {
        expect(formatRange(undefined, 5)).toBe("5");
        expect(formatRange(3, undefined)).toBe("3");
    });

    it("renders an en dash when neither end is present", () => {
        expect(formatRange(undefined, undefined)).toBe("–");
    });
});
