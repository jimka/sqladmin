import { describe, it, expect } from "vitest";
import type { Field } from "@jimka/typescript-ui/data";
import { buildQueryModel } from "../../src/data/buildModel";
import type { QueryColumnMeta } from "../../src/contract";

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
