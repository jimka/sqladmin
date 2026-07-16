// Pure tests for the sequence info form's seeding/dirty helpers. DOM-free
// (the form itself is a DOM component — see memory "tsui DOM module side
// effects" — and is manual-verify; this module is the pure logic it calls).

import { describe, expect, it } from "vitest";
import {
    dataTypeItems,
    detailToEditedValues,
    isSequenceFormDirty,
    ownedByLabel,
    ownerItems,
    SEQUENCE_DATA_TYPE_CHOICES,
} from "../../src/dock/sequenceFormState";
import type { EditedSequenceValues } from "../../src/dock/ddlSpecs";
import type { SequenceDetail } from "../../src/contract";

const detail: SequenceDetail = {
    lastValue: null,
    startValue: "1",
    minValue: "1",
    maxValue: "100",
    increment: "1",
    cacheSize: "1",
    cycle: false,
    dataType: "integer",
    owner: "alice",
};

describe("detailToEditedValues", () => {
    it("seeds the Current value field as \"\" for a null lastValue, not \"—\"", () => {
        expect(detailToEditedValues(detail).lastValue).toBe("");
    });

    it("carries every other field verbatim, as strings", () => {
        const edited = detailToEditedValues({ ...detail, lastValue: "42" });

        expect(edited).toEqual({
            lastValue: "42",
            startValue: "1",
            increment: "1",
            minValue: "1",
            maxValue: "100",
            cacheSize: "1",
            cycle: false,
            dataType: "integer",
            owner: "alice",
        });
    });

    it("preserves a bigint-sized value as a string, never Number()d", () => {
        expect(detailToEditedValues({ ...detail, maxValue: "9223372036854775807" }).maxValue)
            .toBe("9223372036854775807");
    });
});

describe("isSequenceFormDirty", () => {
    const baseline: EditedSequenceValues = detailToEditedValues(detail);

    it("is false when nothing changed", () => {
        expect(isSequenceFormDirty(baseline, { ...baseline })).toBe(false);
    });

    it("ignores incidental leading/trailing whitespace on string fields", () => {
        expect(isSequenceFormDirty(baseline, { ...baseline, increment: "  1  " })).toBe(false);
    });

    it("is true when a numeric field changes", () => {
        expect(isSequenceFormDirty(baseline, { ...baseline, increment: "5" })).toBe(true);
    });

    it("is true when cycle changes", () => {
        expect(isSequenceFormDirty(baseline, { ...baseline, cycle: true })).toBe(true);
    });

    it("is true when dataType or owner changes", () => {
        expect(isSequenceFormDirty(baseline, { ...baseline, dataType: "bigint" })).toBe(true);
        expect(isSequenceFormDirty(baseline, { ...baseline, owner: "bob" })).toBe(true);
    });

    it("never throws on non-integer in-progress text", () => {
        expect(() => isSequenceFormDirty(baseline, { ...baseline, increment: "not a number" })).not.toThrow();
        expect(isSequenceFormDirty(baseline, { ...baseline, increment: "not a number" })).toBe(true);
    });
});

describe("dataTypeItems", () => {
    it("returns the fixed allowlist when the current type is one of its members", () => {
        expect(dataTypeItems("bigint")).toEqual([...SEQUENCE_DATA_TYPE_CHOICES]);
    });

    it("appends an out-of-allowlist current type instead of dropping it", () => {
        expect(dataTypeItems("numeric")).toEqual([...SEQUENCE_DATA_TYPE_CHOICES, "numeric"]);
    });
});

describe("ownerItems", () => {
    it("returns the role list unchanged when it already includes the current owner", () => {
        expect(ownerItems(["alice", "bob"], "alice")).toEqual(["alice", "bob"]);
    });

    it("appends the current owner when the role list omits it", () => {
        expect(ownerItems(["bob"], "alice")).toEqual(["bob", "alice"]);
    });

    it("falls back to a single-item list when the roles fetch failed (empty roles)", () => {
        expect(ownerItems([], "alice")).toEqual(["alice"]);
    });
});

describe("ownedByLabel", () => {
    it("renders the owning column as schema.table.column", () => {
        expect(ownedByLabel({ schema: "sales", table: "products", column: "id" })).toBe("sales.products.id");
    });

    it("is empty for a standalone sequence", () => {
        expect(ownedByLabel(null)).toBe("");
        expect(ownedByLabel(undefined)).toBe("");
    });
});

describe("ownedBy is outside the edit flow", () => {
    it("is not dirty when only ownedBy differs — ownership is not editable through this form", () => {
        // ALTER SEQUENCE ... OWNER TO changes the owning ROLE, not the owning
        // COLUMN, so the Save diff must never react to ownedBy.
        const owned: SequenceDetail = { ...detail, ownedBy: { schema: "sales", table: "products", column: "id" } };
        const baseline = detailToEditedValues(detail);

        expect(isSequenceFormDirty(baseline, detailToEditedValues(owned))).toBe(false);
    });
});
