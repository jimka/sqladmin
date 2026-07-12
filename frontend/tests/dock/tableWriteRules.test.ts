import { describe, it, expect } from "vitest";
import { buildColumnSpec, missingRequiredFields } from "../../src/dock/tableWriteRules";
import type { ColumnMeta } from "../../src/contract";

function column(overrides: Partial<ColumnMeta> = {}): ColumnMeta {
    return {
        name: "col", dataType: "text", nullable: true, isPrimaryKey: false,
        isGenerated: false, hasDefault: false, wireType: "string", ...overrides,
    };
}

/** A minimal stand-in for a ModelRecord, satisfying only what these helpers read. */
function record(data: Record<string, unknown>, opts: { isNew?: boolean; isDirty?: boolean } = {}) {
    return {
        isNew:   () => opts.isNew ?? false,
        isDirty: () => opts.isDirty ?? false,
        get:     (field: string) => data[field],
    };
}

describe("buildColumnSpec", () => {
    it("marks every column read-only when the caller lacks UPDATE", () => {
        const spec = buildColumnSpec([column({ name: "a" }), column({ name: "b" })], false);

        expect(spec.columns).toEqual([
            { field: "a", readOnly: true },
            { field: "b", readOnly: true },
        ]);
    });

    it("marks only generated columns read-only when the caller has UPDATE", () => {
        const spec = buildColumnSpec([column({ name: "a" }), column({ name: "b", isGenerated: true })], true);

        expect(spec.columns).toEqual([
            { field: "a", readOnly: false },
            { field: "b", readOnly: true },
        ]);
    });
});

describe("missingRequiredFields", () => {
    const required = column({ name: "email", nullable: false, isGenerated: false, hasDefault: false });
    const optional = column({ name: "note", nullable: true });

    it("skips records that are neither new nor dirty", () => {
        const store = { getAll: () => [record({ email: "" })] };

        expect(missingRequiredFields(store, [required, optional])).toEqual([]);
    });

    it("reports a required field left empty on a new record", () => {
        const store = { getAll: () => [record({ email: "" }, { isNew: true })] };

        expect(missingRequiredFields(store, [required, optional])).toEqual(["email"]);
    });

    it("reports a required field left null/undefined on a dirty record", () => {
        const store = { getAll: () => [record({ email: undefined }, { isDirty: true })] };

        expect(missingRequiredFields(store, [required])).toEqual(["email"]);
    });

    it("ignores generated and defaulted columns even when NOT NULL", () => {
        const generated = column({ name: "id", isGenerated: true, nullable: false });
        const defaulted = column({ name: "created_at", hasDefault: true, nullable: false });
        const store = { getAll: () => [record({ id: "", created_at: "", note: "" }, { isNew: true })] };

        expect(missingRequiredFields(store, [generated, defaulted, optional])).toEqual([]);
    });

    it("does not report a filled required field", () => {
        const store = { getAll: () => [record({ email: "a@b.com" }, { isNew: true })] };

        expect(missingRequiredFields(store, [required])).toEqual([]);
    });
});
