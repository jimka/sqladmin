import { describe, it, expect } from "vitest";
import { stepIndex, visibleRecords } from "../../src/dock/recordNavigation";

/** A minimal stand-in for a ModelRecord, satisfying only what matchesQuickSearch reads. */
function record(data: Record<string, unknown>) {
    return { getData: () => data };
}

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

describe("visibleRecords", () => {
    const alice = record({ name: "Alice" });
    const bob   = record({ name: "Bob" });
    const carol = record({ name: "Carol Ann" });

    it("returns every record, in order, for a blank query", () => {
        expect(visibleRecords([alice, bob, carol], "")).toEqual([alice, bob, carol]);
    });

    it("returns every record for a whitespace-only query, same as blank", () => {
        expect(visibleRecords([alice, bob, carol], "   ")).toEqual([alice, bob, carol]);
    });

    it("narrows to the records matching the query, preserving original order", () => {
        expect(visibleRecords([alice, bob, carol], "a")).toEqual([alice, carol]);
    });

    it("returns an empty array when nothing matches", () => {
        expect(visibleRecords([alice, bob, carol], "zzz")).toEqual([]);
    });
});

// TableWorkPanel.ts's stepRecord/syncStepEnabled both compose visibleRecords
// with stepIndex the same way: filter to the matching records, look up the
// currently displayed record's index within that filtered list (-1 if it
// isn't there — e.g. the query just narrowed past it), then step. These
// tests exercise that exact composition through the two exported, unit-
// tested primitives, without duplicating TableWorkPanel.ts's own DOM-bound
// code (which stays untested here per this file's header comment).
describe("Previous/Next stepping composed with a live quick-search query", () => {
    function targetIndex(records: ReturnType<typeof record>[], current: ReturnType<typeof record> | null, query: string, delta: number): number | null {
        const filtered = visibleRecords(records, query);

        return stepIndex(current ? filtered.indexOf(current) : -1, delta, filtered.length);
    }

    const alice = record({ name: "Alice" });
    const bob   = record({ name: "Bob" });
    const carol = record({ name: "Carol Ann" });
    const dave  = record({ name: "Dave" });
    const all   = [alice, bob, carol, dave];

    it("Next skips a non-matching record in the middle of the loaded set", () => {
        // "a" matches alice, carol, dave but not bob; stepping Next from alice
        // must land on carol, not bob.
        const filtered = visibleRecords(all, "a");
        const target   = targetIndex(all, alice, "a", 1);

        expect(target).not.toBeNull();
        expect(filtered[target as number]).toBe(carol);
    });

    it("stepping away from a record the query has since hidden lands on a matching record instead of failing", () => {
        // bob no longer matches "a"; his index in the filtered list is -1,
        // which stepIndex treats like "nothing displayed yet" rather than an
        // error — landing on the first matching record.
        const filtered = visibleRecords(all, "a");
        const target   = targetIndex(all, bob, "a", 1);

        expect(target).not.toBeNull();
        expect(filtered[target as number]).toBe(alice);
    });

    it("disables (returns null) both ways when the query matches only the displayed record", () => {
        expect(targetIndex(all, alice, "Alice", 1)).toBeNull();
        expect(targetIndex(all, alice, "Alice", -1)).toBeNull();
    });

    it("re-enables once the query widens to include a neighbour again", () => {
        expect(targetIndex(all, alice, "Alice", 1)).toBeNull();
        expect(targetIndex(all, alice, "a", 1)).not.toBeNull();
    });
});
