// Build a library Model from introspected column metadata. The contract's
// WireType maps to the Model's FieldType; the PK column becomes the model's
// primary key so record.getId() resolves for PUT/DELETE URLs. Column order is
// carried through so the data grid renders columns in table order.

import { Model }                                      from "@jimka/typescript-ui/data";
import type { FieldType }                             from "@jimka/typescript-ui/data";
import type { ColumnMeta, QueryColumnMeta, WireType } from "../contract";

const WIRE_TO_FIELD: Record<WireType, FieldType> = {
    number   : "number",
    string   : "string",
    boolean  : "boolean",
    isoString: "datetime",
    json     : "auto",
    base64   : "string",
    jsonArray: "auto",
};

/** The column shape both model builders read: a name and its wire type. */
type WireColumn = { name: string; wireType: WireType };

/** Map columns to ordered Model field specs (name, mapped type, table order). */
function toFields(columns: WireColumn[]): { name: string; type: FieldType; order: number }[] {
    return columns.map((c, i) => ({ name: c.name, type: WIRE_TO_FIELD[c.wireType], order: i }));
}

/** Map introspected columns to a Model (PK set, columns ordered). */
export function buildModel(columns: ColumnMeta[]): Model {
    return new Model({
        fields    : toFields(columns),
        primaryKey: columns.find(c => c.isPrimaryKey)?.name,
    });
}

/**
 * Map arbitrary-query result columns to a Model. Like {@link buildModel} but
 * with no primary key — a query result set has none and is never written back.
 */
export function buildQueryModel(columns: QueryColumnMeta[]): Model {
    return new Model({ fields: toFields(columns) });
}
