import { describe, it, expect } from "vitest";
import {
    CARD_HEADER_HEIGHT,
    CARD_ROW_HEIGHT,
    cardHeight,
    cardTooltip,
    columnPortY,
    columnTooltip,
    deriveColumnRows,
    portId,
    tableTooltip,
} from "../../src/data/schemaCardModel";
import type { ColumnRowData } from "../../src/data/schemaCardModel";
import type { ColumnMeta, ForeignKeyMeta } from "../../src/contract";

/** Build a minimal ColumnMeta, filling in the fields these tests don't vary. */
function column(name: string, dataType: string, isPrimaryKey = false): ColumnMeta {
    return { name, dataType, nullable: false, isPrimaryKey, isGenerated: false, hasDefault: false, wireType: "string" };
}

/** Build a minimal ColumnRowData, filling in the flags a test doesn't vary. */
function row(over: Partial<ColumnRowData> = {}): ColumnRowData {
    return { name: "c", type: "text", pk: false, fk: false, nullable: true, generated: false, hasDefault: false, ...over };
}

/** Build a minimal ForeignKeyMeta naming only the local `columns` these tests vary. */
function fk(columns: string[]): ForeignKeyMeta {
    return { name: "fk", columns, refSchema: "public", refTable: "b", refColumns: columns, onUpdate: "NO ACTION", onDelete: "NO ACTION" };
}

describe("deriveColumnRows", () => {
    it("flags a primary-key column as pk", () => {
        const rows = deriveColumnRows([column("id", "integer", true)], []);

        expect(rows).toEqual([{ name: "id", type: "integer", pk: true, fk: false, nullable: false, generated: false, hasDefault: false }]);
    });

    it("flags a column named in any FK's local columns as fk", () => {
        const rows = deriveColumnRows(
            [column("id", "integer", true), column("x_id", "integer")],
            [fk(["x_id"])],
        );

        expect(rows).toEqual([
            { name: "id",   type: "integer", pk: true,  fk: false, nullable: false, generated: false, hasDefault: false },
            { name: "x_id", type: "integer", pk: false, fk: true,  nullable: false, generated: false, hasDefault: false },
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

    it("carries nullable / generated / hasDefault from the ColumnMeta", () => {
        const meta: ColumnMeta = { name: "c", dataType: "text", nullable: true, isPrimaryKey: false, isGenerated: true, hasDefault: true, wireType: "string" };
        const rows = deriveColumnRows([meta], []);

        expect(rows[0]).toMatchObject({ nullable: true, generated: true, hasDefault: true });
    });
});

describe("columnTooltip", () => {
    it("labels the name and type lines, with no attribute line when there are none", () => {
        expect(columnTooltip(row({ name: "email", type: "text", nullable: true }))).toBe("Name: email\nType: text");
    });

    it("lists the notable attributes on a labelled third line, in a fixed order", () => {
        const text = columnTooltip(row({ name: "id", type: "bigint", pk: true, fk: true, nullable: false, hasDefault: true, generated: true }));

        expect(text).toBe("Name: id\nType: bigint\nAttributes: PRIMARY KEY · FOREIGN KEY · NOT NULL · DEFAULT · GENERATED");
    });

    it("calls out NOT NULL only for a non-nullable column", () => {
        expect(columnTooltip(row({ nullable: false }))).toBe("Name: c\nType: text\nAttributes: NOT NULL");
        expect(columnTooltip(row({ nullable: true  }))).toBe("Name: c\nType: text");
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

describe("columnPortY / cardHeight geometry contract", () => {
    it("centres the port on the row it belongs to, with no allowance for a border or inset", () => {
        for (let i = 0; i <= 5; i++) {
            expect(columnPortY(i) + 0.5).toBe(CARD_HEADER_HEIGHT + i * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2);
        }
    });

    it("sizes the card's outer height as the header plus the rows and nothing else", () => {
        for (let n = 0; n <= 6; n++) {
            expect(cardHeight(n)).toBe(CARD_HEADER_HEIGHT + n * CARD_ROW_HEIGHT);
        }
    });
});

describe("tableTooltip", () => {
    it("lists column count, primary key, and foreign keys under the unlabelled name heading", () => {
        const columns = [
            row({ name: "id", pk: true }),
            row({ name: "invoice_id", fk: true }),
            row({ name: "order_id", fk: true }),
            row({ name: "amount" }),
        ];

        expect(tableTooltip("credit_notes", columns)).toBe(
            "credit_notes\nColumns: 4\nPrimary key: id\nForeign keys: invoice_id, order_id",
        );
    });

    it("lists a composite primary key in declaration order, with a column that is both pk and fk in both lists", () => {
        const columns = [
            row({ name: "order_id", pk: true, fk: true }),
            row({ name: "line_no", pk: true }),
            row({ name: "qty" }),
        ];

        expect(tableTooltip("order_items", columns)).toBe(
            "order_items\nColumns: 3\nPrimary key: order_id, line_no\nForeign keys: order_id",
        );
    });

    it("omits the Primary key and Foreign keys lines when there are none", () => {
        const columns = [row({ name: "ts" }), row({ name: "message" })];

        expect(tableTooltip("audit_log", columns)).toBe("audit_log\nColumns: 2");
    });

    it("yields the heading alone for a node with no columns (the role-membership graph)", () => {
        expect(tableTooltip("analyst", [])).toBe("analyst");
    });
});

describe("cardTooltip", () => {
    it("joins the table block and the column block with a blank line", () => {
        const text = cardTooltip(
            "credit_notes\nColumns: 4",
            row({ name: "invoice_id", type: "bigint", fk: true, nullable: false }),
        );

        expect(text).toBe("credit_notes\nColumns: 4\n\nName: invoice_id\nType: bigint\nAttributes: FOREIGN KEY · NOT NULL");
    });

    it("separates the two blocks with exactly one blank line", () => {
        const text = cardTooltip("t\nColumns: 1", row());

        expect(text.split("\n").filter(l => l === "").length).toBe(1);
    });

    it("is exactly table + blank line + columnTooltip(column), for any inputs", () => {
        const table = "some_table\nColumns: 2\nPrimary key: id";
        const column = row({ name: "x", type: "text", pk: true, hasDefault: true });

        expect(cardTooltip(table, column)).toBe(`${table}\n\n${columnTooltip(column)}`);
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
