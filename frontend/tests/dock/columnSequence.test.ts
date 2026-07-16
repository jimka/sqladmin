// The Columns grid's pure row mapping: the sequence display label and the
// hidden schema/name fields the grid's cellclick handler reads back.

import { describe, expect, it } from "vitest";
import { sequenceLabel, toColumnRows } from "../../src/dock/columnSequence";
import type { ColumnMeta } from "../../src/contract";

/** A ColumnMeta with the given sequence (or none), over fixed display fields. */
function column(sequence?: ColumnMeta["sequence"]): ColumnMeta {
    return {
        name:         "id",
        dataType:     "integer",
        nullable:     false,
        isPrimaryKey: true,
        isGenerated:  true,
        hasDefault:   true,
        wireType:     "number",
        sequence,
    };
}

describe("sequenceLabel", () => {
    it("schema-qualifies the sequence name", () => {
        expect(sequenceLabel({ schema: "sales", name: "products_id_seq" })).toBe("sales.products_id_seq");
    });

    it("is empty for a column with no backing sequence", () => {
        expect(sequenceLabel(null)).toBe("");
        expect(sequenceLabel(undefined)).toBe("");
    });
});

describe("toColumnRows", () => {
    it("carries the sequence into the display field and the two hidden fields", () => {
        const [row] = toColumnRows([column({ schema: "sales", name: "document_number_seq" })]);

        expect(row.sequence).toBe("sales.document_number_seq");
        expect(row.sequenceSchema).toBe("sales");
        expect(row.sequenceName).toBe("document_number_seq");
    });

    it("blanks all three sequence fields when no sequence backs the column", () => {
        const [row] = toColumnRows([column(null)]);

        expect(row.sequence).toBe("");
        expect(row.sequenceSchema).toBe("");
        expect(row.sequenceName).toBe("");
    });

    it("treats an absent sequence field the same as an explicit null", () => {
        const [row] = toColumnRows([column(undefined)]);

        expect(row.sequence).toBe("");
        expect(row.sequenceSchema).toBe("");
    });

    it("preserves every existing display field", () => {
        const [row] = toColumnRows([column(null)]);

        expect(row).toMatchObject({
            name:         "id",
            dataType:     "integer",
            nullable:     false,
            isPrimaryKey: true,
            isGenerated:  true,
            wireType:     "number",
        });
    });

    it("keeps a schema or sequence name containing a dot recoverable from the hidden fields", () => {
        // The label is ambiguous here ("my.schema.some.seq"), which is exactly
        // why the click handler reads the hidden fields instead of re-splitting it.
        const [row] = toColumnRows([column({ schema: "my.schema", name: "some.seq" })]);

        expect(row.sequenceSchema).toBe("my.schema");
        expect(row.sequenceName).toBe("some.seq");
    });

    it("maps every column in order", () => {
        const rows = toColumnRows([column({ schema: "s", name: "a" }), column(null)]);

        expect(rows).toHaveLength(2);
        expect(rows[0].sequence).toBe("s.a");
        expect(rows[1].sequence).toBe("");
    });
});
