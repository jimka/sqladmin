import { describe, it, expect } from "vitest";
import { buildColumnSpec, isRequiredColumn, missingRequiredFields } from "../../src/dock/tableWriteRules";
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

describe("isRequiredColumn", () => {
    it("is true for a not-nullable, non-generated, no-default column", () => {
        expect(isRequiredColumn(column({ nullable: false }))).toBe(true);
    });

    it("is false for a nullable column", () => {
        expect(isRequiredColumn(column({ nullable: true }))).toBe(false);
    });

    it("is false for a generated column even when not nullable", () => {
        expect(isRequiredColumn(column({ nullable: false, isGenerated: true }))).toBe(false);
    });

    it("is false for a defaulted column even when not nullable", () => {
        expect(isRequiredColumn(column({ nullable: false, hasDefault: true }))).toBe(false);
    });

    it("is false when both generated and defaulted", () => {
        expect(isRequiredColumn(column({ nullable: false, isGenerated: true, hasDefault: true }))).toBe(false);
    });

    it("is false for the default fixture (nullable: true)", () => {
        expect(isRequiredColumn(column())).toBe(false);
    });
});

describe("buildColumnSpec", () => {
    it("marks every column read-only when the caller lacks UPDATE", () => {
        const spec = buildColumnSpec([column({ name: "a" }), column({ name: "b" })], false);

        expect(spec.columns).toEqual([
            { field: "a", readOnly: true, required: false },
            { field: "b", readOnly: true, required: false },
        ]);
    });

    it("marks only generated columns read-only when the caller has UPDATE", () => {
        const spec = buildColumnSpec([column({ name: "a" }), column({ name: "b", isGenerated: true })], true);

        expect(spec.columns).toEqual([
            { field: "a", readOnly: false, required: false },
            { field: "b", readOnly: true, required: false },
        ]);
    });

    it("marks required tracking the predicate, independent of canUpdate", () => {
        const columns = [column({ name: "email", nullable: false }), column({ name: "note" })];

        expect(buildColumnSpec(columns, true).columns).toEqual([
            { field: "email", readOnly: false, required: true },
            { field: "note", readOnly: false, required: false },
        ]);

        expect(buildColumnSpec(columns, false).columns).toEqual([
            { field: "email", readOnly: true, required: true },
            { field: "note", readOnly: true, required: false },
        ]);
    });

    it("marks a generated NOT-NULL column read-only but not required", () => {
        const spec = buildColumnSpec([column({ name: "id", nullable: false, isGenerated: true })], true);

        expect(spec.columns).toEqual([{ field: "id", readOnly: true, required: false }]);
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
