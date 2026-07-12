import { describe, it, expect } from "vitest";
import { buildFilters, conditionsFromFilters, type FilterCondition } from "../../src/dock/filterModel";
import type { FilterDescriptor } from "@jimka/typescript-ui/data";
import type { ColumnMeta, WireType } from "../../src/contract";

/** Build a minimal ColumnMeta for a given name/wire type (other flags irrelevant here). */
function col(name: string, wireType: WireType): ColumnMeta {
    return {
        name,
        dataType: "text",
        nullable: true,
        isPrimaryKey: false,
        isGenerated: false,
        hasDefault: false,
        wireType,
    };
}

const COLUMNS: ColumnMeta[] = [
    col("id", "number"),
    col("name", "string"),
    col("active", "boolean"),
    col("created", "isoString"),
];

/** A concise condition literal for the tests. */
function cond(field: string, operator: FilterCondition["operator"], value: string): FilterCondition {
    return { field, operator, value };
}

describe("buildFilters", () => {
    it("returns no descriptors for no conditions", () => {
        expect(buildFilters([], COLUMNS)).toEqual([]);
    });

    it("drops rows with an empty field or an empty value", () => {
        const conditions = [
            cond("", "eq", "x"),
            cond("name", "eq", ""),
            cond("name", "contains", "ada"),
        ];

        expect(buildFilters(conditions, COLUMNS)).toEqual([
            { type: "contains", field: "name", value: "ada" },
        ]);
    });

    it("keeps the raw string for contains and startsWith (no coercion, case preserved)", () => {
        const conditions = [
            cond("name", "contains", "AbC"),
            cond("id", "startsWith", "12"),
        ];

        expect(buildFilters(conditions, COLUMNS)).toEqual([
            { type: "contains", field: "name", value: "AbC" },
            { type: "startsWith", field: "id", value: "12" },
        ]);
    });

    it("coerces a numeric-wire column to a number for equality and comparison", () => {
        const conditions = [
            cond("id", "eq", "42"),
            cond("id", "gt", "10"),
            cond("id", "lte", "99"),
        ];

        expect(buildFilters(conditions, COLUMNS)).toEqual([
            { type: "eq", field: "id", value: 42 },
            { type: "gt", field: "id", value: 10 },
            { type: "lte", field: "id", value: 99 },
        ]);
    });

    it("drops a non-numeric value on a numeric-wire column rather than binding NaN", () => {
        const conditions = [
            cond("id", "eq", "abc"),
            cond("name", "eq", "keep"),
        ];

        expect(buildFilters(conditions, COLUMNS)).toEqual([
            { type: "eq", field: "name", value: "keep" },
        ]);
    });

    it("coerces a boolean-wire column's true/false to a boolean", () => {
        const conditions = [
            cond("active", "eq", "true"),
            cond("active", "neq", "false"),
        ];

        expect(buildFilters(conditions, COLUMNS)).toEqual([
            { type: "eq", field: "active", value: true },
            { type: "neq", field: "active", value: false },
        ]);
    });

    it("passes a string/isoString-wire value through unchanged for equality", () => {
        const conditions = [
            cond("name", "eq", "ada"),
            cond("created", "eq", "2026-07-02T00:00:00Z"),
        ];

        expect(buildFilters(conditions, COLUMNS)).toEqual([
            { type: "eq", field: "name", value: "ada" },
            { type: "eq", field: "created", value: "2026-07-02T00:00:00Z" },
        ]);
    });

    it("preserves input order so the caller AND-combines the descriptors", () => {
        const conditions = [
            cond("name", "contains", "a"),
            cond("id", "gt", "5"),
            cond("active", "eq", "true"),
        ];

        expect(buildFilters(conditions, COLUMNS)).toEqual([
            { type: "contains", field: "name", value: "a" },
            { type: "gt", field: "id", value: 5 },
            { type: "eq", field: "active", value: true },
        ]);
    });
});

describe("conditionsFromFilters", () => {
    it("returns no conditions for no filters", () => {
        expect(conditionsFromFilters([])).toEqual([]);
    });

    it("maps each single-field descriptor back to a condition, preserving order", () => {
        const filters: FilterDescriptor[] = [
            { type: "contains", field: "name", value: "ada" },
            { type: "gt", field: "id", value: 5 },
            { type: "startsWith", field: "id", value: "12" },
        ];

        expect(conditionsFromFilters(filters)).toEqual([
            cond("name", "contains", "ada"),
            cond("id", "gt", "5"),
            cond("id", "startsWith", "12"),
        ]);
    });

    it("stringifies numeric and boolean values back to the value field's text", () => {
        const filters: FilterDescriptor[] = [
            { type: "eq", field: "id", value: 42 },
            { type: "eq", field: "active", value: true },
            { type: "neq", field: "active", value: false },
        ];

        expect(conditionsFromFilters(filters)).toEqual([
            cond("id", "eq", "42"),
            cond("active", "eq", "true"),
            cond("active", "neq", "false"),
        ]);
    });

    it("skips descriptor shapes the dialog does not offer (in / and / or / not)", () => {
        const filters: FilterDescriptor[] = [
            { type: "eq", field: "name", value: "keep" },
            { type: "in", field: "id", values: [1, 2] },
            { type: "and", filters: [{ type: "eq", field: "id", value: 1 }] },
            { type: "not", filter: { type: "eq", field: "id", value: 1 } },
        ];

        expect(conditionsFromFilters(filters)).toEqual([
            cond("name", "eq", "keep"),
        ]);
    });

    it("round-trips the descriptors buildFilters produces back into equivalent conditions", () => {
        const built = buildFilters([
            cond("name", "contains", "a"),
            cond("id", "gt", "5"),
            cond("active", "eq", "true"),
        ], COLUMNS);

        expect(conditionsFromFilters(built)).toEqual([
            cond("name", "contains", "a"),
            cond("id", "gt", "5"),
            cond("active", "eq", "true"),
        ]);
    });
});
