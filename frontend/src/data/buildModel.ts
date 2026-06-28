// Build a library Model from introspected column metadata. The contract's
// WireType maps to the Model's FieldType; the PK column becomes the model's
// primary key so record.getId() resolves for PUT/DELETE URLs. Column order is
// carried through so the data grid renders columns in table order.

import { Model } from "@jimka/typescript-ui/data";
import type { FieldType } from "@jimka/typescript-ui/data";
import type { ColumnMeta, WireType } from "../contract";

const WIRE_TO_FIELD: Record<WireType, FieldType> = {
    number: "number",
    string: "string",
    boolean: "boolean",
    isoString: "datetime",
    json: "auto",
    base64: "string",
    jsonArray: "auto",
};

/** Map introspected columns to a Model (PK set, columns ordered). */
export function buildModel(columns: ColumnMeta[]): Model {
    const primaryKey = columns.find(c => c.isPrimaryKey)?.name;

    return new Model({
        fields: columns.map((c, i) => ({
            name: c.name,
            type: WIRE_TO_FIELD[c.wireType],
            order: i,
        })),
        primaryKey,
    });
}
