// The Structure tab's pure row mapping for the Constraints and Foreign Keys
// grids: flattens each metadata record's string arrays into one comma-joined
// display string and passes every other field through untouched.

import { describe, expect, it } from "vitest";
import { constraintRows, foreignKeyRows } from "../../src/dock/structureRows";
import type { ConstraintMeta, ForeignKeyMeta } from "../../src/contract";

describe("constraintRows", () => {
    it("joins columns with ', ' and passes name/type/definition through unchanged", () => {
        const constraints: ConstraintMeta[] = [
            { name: "orders_pkey", type: "primaryKey", columns: ["id"], definition: "PRIMARY KEY (id)" },
        ];

        expect(constraintRows(constraints)).toEqual([
            { name: "orders_pkey", type: "primaryKey", columns: "id", definition: "PRIMARY KEY (id)" },
        ]);
    });

    it("maps an empty columns array to '', not '—' or undefined", () => {
        const constraints: ConstraintMeta[] = [
            { name: "chk_total", type: "check", columns: [], definition: "CHECK (total >= 0)" },
        ];

        expect(constraintRows(constraints)).toEqual([
            { name: "chk_total", type: "check", columns: "", definition: "CHECK (total >= 0)" },
        ]);
    });

    it("returns [] for []", () => {
        expect(constraintRows([])).toEqual([]);
    });
});

describe("foreignKeyRows", () => {
    it("joins columns and refColumns with ', ' and passes the rest through unchanged", () => {
        const foreignKeys: ForeignKeyMeta[] = [
            {
                name: "fk_o_c",
                columns: ["cust_id", "org_id"],
                refSchema: "sales",
                refTable: "customers",
                refColumns: ["id", "org"],
                onUpdate: "NO ACTION",
                onDelete: "CASCADE",
            },
        ];

        expect(foreignKeyRows(foreignKeys)).toEqual([
            {
                name: "fk_o_c",
                columns: "cust_id, org_id",
                refSchema: "sales",
                refTable: "customers",
                refColumns: "id, org",
                onUpdate: "NO ACTION",
                onDelete: "CASCADE",
            },
        ]);
    });

    it("returns [] for []", () => {
        expect(foreignKeyRows([])).toEqual([]);
    });
});
