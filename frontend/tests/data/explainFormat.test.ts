import { describe, it, expect } from "vitest";
import { formatMetric, formatRange, formatRowCount } from "../../src/data/explainFormat";

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

describe("formatRowCount", () => {
    it("shows counts below 1000 verbatim", () => {
        expect(formatRowCount(0)).toBe("0");
        expect(formatRowCount(42)).toBe("42");
        expect(formatRowCount(999)).toBe("999");
    });

    it("compacts thousands with a k suffix", () => {
        expect(formatRowCount(1000)).toBe("1k");
        expect(formatRowCount(1234)).toBe("1.2k");
        expect(formatRowCount(12345)).toBe("12.3k");
    });

    it("compacts millions and billions", () => {
        expect(formatRowCount(1000000)).toBe("1M");
        expect(formatRowCount(2500000)).toBe("2.5M");
        expect(formatRowCount(1000000000)).toBe("1B");
    });
});
