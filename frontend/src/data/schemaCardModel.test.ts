import { describe, it, expect } from "vitest";
import {
    CARD_HEADER_HEIGHT,
    CARD_ROW_HEIGHT,
    cardHeight,
    columnPortY,
    deriveColumnRows,
    portId,
} from "./schemaCardModel";
import type { ColumnMeta, ForeignKeyMeta } from "../contract";

/** Build a minimal ColumnMeta, filling in the fields these tests don't vary. */
function column(name: string, dataType: string, isPrimaryKey = false): ColumnMeta {
    return { name, dataType, nullable: false, isPrimaryKey, isGenerated: false, hasDefault: false, wireType: "string" };
}

/** Build a minimal ForeignKeyMeta naming only the local `columns` these tests vary. */
function fk(columns: string[]): ForeignKeyMeta {
    return { name: "fk", columns, refSchema: "public", refTable: "b", refColumns: columns, onUpdate: "NO ACTION", onDelete: "NO ACTION" };
}

describe("deriveColumnRows", () => {
    it("flags a primary-key column as pk", () => {
        const rows = deriveColumnRows([column("id", "integer", true)], []);

        expect(rows).toEqual([{ name: "id", type: "integer", pk: true, fk: false }]);
    });

    it("flags a column named in any FK's local columns as fk", () => {
        const rows = deriveColumnRows(
            [column("id", "integer", true), column("x_id", "integer")],
            [fk(["x_id"])],
        );

        expect(rows).toEqual([
            { name: "id",   type: "integer", pk: true,  fk: false },
            { name: "x_id", type: "integer", pk: false, fk: true },
        ]);
    });

    it("preserves column order", () => {
        const rows = deriveColumnRows(
            [column("c", "text"), column("a", "text"), column("b", "text")],
            [],
        );

        expect(rows.map(r => r.name)).toEqual(["c", "a", "b"]);
    });

    it("uses ColumnMeta.dataType verbatim as the row's type", () => {
        const rows = deriveColumnRows([column("id", "bigint")], []);

        expect(rows[0].type).toBe("bigint");
    });
});

describe("cardHeight", () => {
    it("is just the header for zero columns", () => {
        expect(cardHeight(0)).toBe(CARD_HEADER_HEIGHT);
    });

    it("adds one row height per column", () => {
        expect(cardHeight(3)).toBe(CARD_HEADER_HEIGHT + 3 * CARD_ROW_HEIGHT);
    });
});

describe("columnPortY", () => {
    it("centres row 0 within the header", () => {
        expect(columnPortY(0)).toBe(CARD_HEADER_HEIGHT + (CARD_ROW_HEIGHT - 1) / 2);
    });

    it("increases by CARD_ROW_HEIGHT per index", () => {
        expect(columnPortY(1) - columnPortY(0)).toBe(CARD_ROW_HEIGHT);
        expect(columnPortY(2) - columnPortY(1)).toBe(CARD_ROW_HEIGHT);
    });
});

describe("portId", () => {
    it("is stable for the same inputs", () => {
        expect(portId("t", "c", "out")).toBe(portId("t", "c", "out"));
    });

    it("distinguishes in from out for the same node/column", () => {
        expect(portId("t", "c", "out")).not.toBe(portId("t", "c", "in"));
    });
});
