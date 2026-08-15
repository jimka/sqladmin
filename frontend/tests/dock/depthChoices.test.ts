import { describe, it, expect } from "vitest";
import { depthChoice, depthFromChoice } from "../../src/dock/depthChoices";

describe("depthChoice", () => {
    it("defaults to \"1\" for undefined", () => {
        expect(depthChoice(undefined)).toBe("1");
    });

    it("defaults to \"1\" for an empty string", () => {
        expect(depthChoice("")).toBe("1");
    });

    it("passes a valid numeric choice through unchanged", () => {
        expect(depthChoice("1")).toBe("1");
        expect(depthChoice("2")).toBe("2");
        expect(depthChoice("3")).toBe("3");
    });

    it("normalizes \"All\" unchanged", () => {
        expect(depthChoice("All")).toBe("All");
    });

    it("normalizes any case of \"all\" to \"All\"", () => {
        expect(depthChoice("all")).toBe("All");
        expect(depthChoice("ALL")).toBe("All");
    });

    it("falls back to \"1\" for an unrecognized value", () => {
        expect(depthChoice("0")).toBe("1");
        expect(depthChoice("4")).toBe("1");
        expect(depthChoice("-1")).toBe("1");
        expect(depthChoice("deep")).toBe("1");
    });

    it("is idempotent", () => {
        expect(depthChoice(depthChoice("all"))).toBe("All");
    });
});

describe("depthFromChoice", () => {
    it("returns the hop count for a numeric choice", () => {
        expect(depthFromChoice("1")).toBe(1);
        expect(depthFromChoice("3")).toBe(3);
    });

    it("returns positive infinity for \"All\"", () => {
        expect(depthFromChoice("All")).toBe(Number.POSITIVE_INFINITY);
    });
});
