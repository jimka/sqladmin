// Pure spec-assembly tests for the table-DDL dialog forms: row -> ColumnSpec,
// action + fields -> the action-tagged specs, and the column-order helper
// backing ColumnChecklist.readSelected(). DOM-free (the forms themselves
// touch `document` at import scope — see memory "tsui DOM module side
// effects" — and are manual-verify; this module is the pure logic they call).

import { describe, expect, it } from "vitest";
import {
    buildAlterTableSpec,
    buildConstraintSpec,
    buildCreateTableSpec,
    buildIndexSpec,
    orderColumnsBySelection,
    parseColumnList,
    stripTrailingSemicolon,
} from "../../src/dock/ddlSpecs";
import type { ColumnRow } from "../../src/dock/ddlSpecs";

describe("buildCreateTableSpec", () => {
    it("drops blank-name rows", () => {
        const rows: ColumnRow[] = [
            { name: "id", type: "bigint", nullable: false, default: "", primaryKey: true },
            { name: "  ", type: "text", nullable: true, default: "", primaryKey: false },
        ];

        const spec = buildCreateTableSpec("public", "t", rows);

        expect(spec.columns).toHaveLength(1);
        expect(spec.columns[0].name).toBe("id");
    });

    it("maps nullable/default/primaryKey and carries an empty default as null", () => {
        const rows: ColumnRow[] = [
            { name: "created", type: "timestamptz", nullable: true, default: "", primaryKey: false },
        ];

        const spec = buildCreateTableSpec("public", "t", rows);

        expect(spec.columns[0]).toEqual({
            name: "created", type: "timestamptz", nullable: true, default: null, primaryKey: false,
        });
    });

    it("carries a non-empty default through", () => {
        const rows: ColumnRow[] = [
            { name: "created", type: "timestamptz", nullable: true, default: "now()", primaryKey: false },
        ];

        const spec = buildCreateTableSpec("public", "t", rows);

        expect(spec.columns[0].default).toBe("now()");
    });

    it("omits ifNotExists when not requested", () => {
        const spec = buildCreateTableSpec("public", "t", []);

        expect(spec.ifNotExists).toBeUndefined();
    });

    it("carries ifNotExists when requested", () => {
        const spec = buildCreateTableSpec("public", "t", [], true);

        expect(spec.ifNotExists).toBe(true);
    });
});

describe("buildAlterTableSpec", () => {
    it("builds a changeType spec with an optional using clause", () => {
        const spec = buildAlterTableSpec("public", "t", "changeType", {
            column: "amt", newType: "numeric(10,2)", using: "amt::numeric(10,2)",
        });

        expect(spec).toEqual({
            schema: "public", name: "t", action: "changeType",
            column: "amt", newType: "numeric(10,2)", using: "amt::numeric(10,2)",
        });
    });

    it("omits using when not given", () => {
        const spec = buildAlterTableSpec("public", "t", "changeType", { column: "amt", newType: "text" });

        expect(spec.using).toBeUndefined();
    });

    it("builds an addColumn spec carrying columnDef", () => {
        const columnDef = { name: "note", type: "text", nullable: true, default: null, primaryKey: false };

        const spec = buildAlterTableSpec("public", "t", "addColumn", { columnDef });

        expect(spec).toEqual({ schema: "public", name: "t", action: "addColumn", columnDef });
    });

    it("builds a renameColumn spec", () => {
        const spec = buildAlterTableSpec("public", "t", "renameColumn", { column: "note", newName: "memo" });

        expect(spec).toEqual({ schema: "public", name: "t", action: "renameColumn", column: "note", newName: "memo" });
    });

    it("builds a setDefault spec", () => {
        const spec = buildAlterTableSpec("public", "t", "setDefault", { column: "created", default: "now()" });

        expect(spec).toEqual({ schema: "public", name: "t", action: "setDefault", column: "created", default: "now()" });
    });

    it("builds a renameTable spec", () => {
        const spec = buildAlterTableSpec("public", "t", "renameTable", { newName: "t2" });

        expect(spec).toEqual({ schema: "public", name: "t", action: "renameTable", newName: "t2" });
    });

    it("carries cascade on dropColumn only when set", () => {
        const withoutCascade = buildAlterTableSpec("public", "t", "dropColumn", { column: "note" });
        const withCascade = buildAlterTableSpec("public", "t", "dropColumn", { column: "note", cascade: true });

        expect(withoutCascade.cascade).toBeUndefined();
        expect(withCascade.cascade).toBe(true);
    });
});

describe("buildConstraintSpec", () => {
    it("builds an addPrimaryKey spec", () => {
        const spec = buildConstraintSpec("public", "t", "addPrimaryKey", { columns: ["id"] });

        expect(spec).toEqual({ schema: "public", name: "t", action: "addPrimaryKey", columns: ["id"] });
    });

    it("builds an addForeignKey spec across schemas with only the given referential actions", () => {
        const spec = buildConstraintSpec("public", "order", "addForeignKey", {
            columns: ["customer_id"], refSchema: "sales", refTable: "customer", refColumns: ["id"], onDelete: "CASCADE",
        });

        expect(spec).toEqual({
            schema: "public", name: "order", action: "addForeignKey",
            columns: ["customer_id"], refSchema: "sales", refTable: "customer", refColumns: ["id"], onDelete: "CASCADE",
        });
        expect(spec.onUpdate).toBeUndefined();
    });

    it("builds a drop spec carrying only the constraint name (and cascade when set)", () => {
        const spec = buildConstraintSpec("public", "t", "drop", { constraintName: "t_email_key" });

        expect(spec).toEqual({ schema: "public", name: "t", action: "drop", constraintName: "t_email_key" });
    });
});

describe("buildIndexSpec", () => {
    it("builds a create spec carrying only the given optional fields", () => {
        const spec = buildIndexSpec("public", "create", { table: "t", columns: ["email"], unique: true });

        expect(spec).toEqual({ schema: "public", action: "create", table: "t", columns: ["email"], unique: true });
        expect(spec.method).toBeUndefined();
        expect(spec.name).toBeUndefined();
    });

    it("builds a drop spec", () => {
        const spec = buildIndexSpec("public", "drop", { indexName: "t_email_idx", cascade: true });

        expect(spec).toEqual({ schema: "public", action: "drop", indexName: "t_email_idx", cascade: true });
    });
});

describe("orderColumnsBySelection", () => {
    it("returns checked names in the table's column order, not selection order", () => {
        const allColumns = ["id", "email", "created"];
        const selected = new Set(["created", "id"]);

        expect(orderColumnsBySelection(allColumns, selected)).toEqual(["id", "created"]);
    });

    it("accepts a plain array of selected names", () => {
        expect(orderColumnsBySelection(["a", "b", "c"], ["c", "a"])).toEqual(["a", "c"]);
    });

    it("returns an empty array when nothing is selected", () => {
        expect(orderColumnsBySelection(["a", "b"], [])).toEqual([]);
    });
});

describe("parseColumnList", () => {
    it("splits and trims a comma-separated list", () => {
        expect(parseColumnList("id, tenant_id")).toEqual(["id", "tenant_id"]);
    });

    it("drops empty entries from trailing/doubled commas", () => {
        expect(parseColumnList("id,, tenant_id,")).toEqual(["id", "tenant_id"]);
    });

    it("returns an empty array for blank input", () => {
        expect(parseColumnList("   ")).toEqual([]);
    });
});

describe("stripTrailingSemicolon", () => {
    it("removes a single trailing semicolon", () => {
        expect(stripTrailingSemicolon("SELECT 1;")).toBe("SELECT 1");
    });

    it("removes surrounding whitespace along with the semicolon", () => {
        expect(stripTrailingSemicolon("  SELECT id\nFROM t;\n\n")).toBe("SELECT id\nFROM t");
    });

    it("leaves text with no trailing semicolon untouched (besides trimming)", () => {
        expect(stripTrailingSemicolon("  SELECT 1  ")).toBe("SELECT 1");
    });

    it("only strips the final semicolon, not ones embedded earlier", () => {
        expect(stripTrailingSemicolon("SELECT ';' AS x;")).toBe("SELECT ';' AS x");
    });
});
