import { describe, it, expect } from "vitest";
import type { Field } from "@jimka/typescript-ui/data";
import { buildModel, buildQueryModel } from "../../src/data/buildModel";
import type { ColumnMeta, QueryColumnMeta } from "../../src/contract";

function column(overrides: Partial<ColumnMeta> & { name: string }): ColumnMeta {
    return {
        dataType    : "integer",
        fullType    : "integer",
        nullable    : false,
        isPrimaryKey: false,
        isGenerated : false,
        hasDefault  : false,
        defaultExpr : null,
        wireType    : "number",
        ...overrides,
    };
}

describe("buildQueryModel", () => {
    it("maps wire types to field types, in order, with no primary key", () => {
        const cols: QueryColumnMeta[] = [
            { name: "id", wireType: "number" },
            { name: "label", wireType: "string" },
            { name: "at", wireType: "isoString" },
        ];

        const model  = buildQueryModel(cols);
        const byName = Object.fromEntries(
            model.getFields().map((f: Field) => [f.getName(), { type: f.getType(), order: f.getOrder() }]),
        );

        expect(byName).toEqual({
            id   : { type: "number", order: 0 },
            label: { type: "string", order: 1 },
            at   : { type: "datetime", order: 2 },
        });
        expect(model.getPrimaryKeyField()).toBeUndefined();
    });
});

describe("buildModel", () => {
    it("maps fields and order exactly as buildQueryModel does", () => {
        const cols: ColumnMeta[] = [
            column({ name: "id", wireType: "number" }),
            column({ name: "label", wireType: "string" }),
            column({ name: "at", wireType: "isoString" }),
        ];

        const model  = buildModel(cols);
        const byName = Object.fromEntries(
            model.getFields().map((f: Field) => [f.getName(), { type: f.getType(), order: f.getOrder() }]),
        );

        expect(byName).toEqual({
            id   : { type: "number", order: 0 },
            label: { type: "string", order: 1 },
            at   : { type: "datetime", order: 2 },
        });
    });

    it("sets the primary key to the column flagged isPrimaryKey", () => {
        const cols: ColumnMeta[] = [
            column({ name: "id", isPrimaryKey: true }),
            column({ name: "label" }),
        ];

        expect(buildModel(cols).getPrimaryKeyField()?.getName()).toBe("id");
    });

    it("leaves the primary key undefined when no column is flagged", () => {
        const cols: ColumnMeta[] = [column({ name: "id" }), column({ name: "label" })];

        expect(buildModel(cols).getPrimaryKeyField()).toBeUndefined();
    });

    // A composite primary key is not modelled: the library Model has one
    // primary-key field, so buildModel takes the first flagged column in
    // column order and record.getId() cannot round-trip a composite-PK row.
    // This is pre-existing behaviour, pinned here rather than changed.
    it("takes the first flagged column, in column order, when two are flagged", () => {
        const cols: ColumnMeta[] = [
            column({ name: "order_id", isPrimaryKey: true }),
            column({ name: "line_no", isPrimaryKey: true }),
            column({ name: "sku" }),
        ];

        expect(buildModel(cols).getPrimaryKeyField()?.getName()).toBe("order_id");
    });
});
