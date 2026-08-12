import { describe, it, expect } from "vitest";
import { matchesQuickSearch, quickSearchStatus } from "../../src/dock/quickSearchModel";

/** A minimal stand-in for a ModelRecord, satisfying only what this module reads. */
function record(data: Record<string, unknown>) {
    return { getData: () => data };
}

describe("matchesQuickSearch", () => {
    // The customers(name, email, signup_count, active, created_at, metadata)
    // worked example from the plan's Architecture Decisions.
    const customer = record({
        name: "John Smith",
        email: "js@corp.com",
        signup_count: 3,
        active: true,
        created_at: new Date("2026-01-01T00:00:00Z"),
        metadata: { nickname: "Smith" },
    });

    it("matches a string field by case-insensitive substring", () => {
        expect(matchesQuickSearch(customer, "smith")).toBe(true);
    });

    it("matches uppercase query text against lowercase stored text", () => {
        expect(matchesQuickSearch(record({ name: "John Smith" }), "SMITH")).toBe(true);
    });

    it("does not match a string field with no substring hit", () => {
        expect(matchesQuickSearch(record({ email: "js@corp.com" }), "smith")).toBe(false);
    });

    it("stringifies a number field before matching, and does not match unrelated text", () => {
        expect(matchesQuickSearch(record({ signup_count: 3 }), "smith")).toBe(false);
    });

    it("matches a number field against its stringified digits", () => {
        expect(matchesQuickSearch(record({ signup_count: 3 }), "3")).toBe(true);
    });

    it("stringifies a boolean field before matching, and does not match unrelated text", () => {
        expect(matchesQuickSearch(record({ active: true }), "smith")).toBe(false);
    });

    it("matches a boolean field against its stringified form", () => {
        expect(matchesQuickSearch(record({ active: true }), "true")).toBe(true);
    });

    it("excludes a Date-valued field (isoString) from matching", () => {
        expect(matchesQuickSearch(record({ created_at: new Date("2026-01-01T00:00:00Z") }), "2026")).toBe(false);
    });

    it("excludes a JSON object-valued field from matching", () => {
        expect(matchesQuickSearch(record({ metadata: { nickname: "Smith" } }), "smith")).toBe(false);
    });

    it("matches on any one field among several", () => {
        expect(matchesQuickSearch(customer, "smith")).toBe(true);
    });

    it("an empty query matches every record", () => {
        expect(matchesQuickSearch(customer, "")).toBe(true);
    });

    it("a whitespace-only query matches every record, same as empty", () => {
        expect(matchesQuickSearch(customer, "   ")).toBe(true);
    });

    it("a record whose only matching field is null does not match a non-empty query", () => {
        expect(matchesQuickSearch(record({ name: null }), "smith")).toBe(false);
    });

    it("a record whose only matching field is undefined does not match a non-empty query", () => {
        expect(matchesQuickSearch(record({ name: undefined }), "smith")).toBe(false);
    });

    it("a record with no fields at all matches only the empty query", () => {
        const empty = record({});

        expect(matchesQuickSearch(empty, "smith")).toBe(false);
        expect(matchesQuickSearch(empty, "")).toBe(true);
    });
});

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
