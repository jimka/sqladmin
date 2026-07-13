// Pure spec-assembly tests for the table-DDL dialog forms: row -> ColumnSpec,
// action + fields -> the action-tagged specs, and the column-order helper
// backing ColumnChecklist.readSelected(). DOM-free (the forms themselves
// touch `document` at import scope — see memory "tsui DOM module side
// effects" — and are manual-verify; this module is the pure logic they call).

import { describe, expect, it } from "vitest";
import {
    buildAlterSequenceSpec,
    buildAlterTableSpec,
    buildAlterTypeAddValueSpec,
    buildConstraintSpec,
    buildCreateCompositeTypeSpec,
    buildCreateEnumTypeSpec,
    buildCreateFunctionSpec,
    buildCreateSchemaSpec,
    buildCreateSequenceSpec,
    buildCreateTableSpec,
    buildDropFunctionSpec,
    buildDropSchemaSpec,
    buildDropSequenceSpec,
    buildDropTypeSpec,
    buildIndexSpec,
    buildRenameSchemaSpec,
    buildSequenceOwnerSpec,
    diffSequenceSpecs,
    orderColumnsBySelection,
    parseColumnList,
    parseOptionalInt,
    stripTrailingSemicolon,
} from "../../src/dock/ddlSpecs";
import type { ColumnRow, EditedSequenceValues, FunctionArgRow } from "../../src/dock/ddlSpecs";
import type { SequenceDetail } from "../../src/contract";

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

describe("parseOptionalInt", () => {
    it("returns undefined for blank text", () => {
        expect(parseOptionalInt("   ", "increment")).toBeUndefined();
    });

    it("parses a valid whole number", () => {
        expect(parseOptionalInt(" 42 ", "increment")).toBe(42);
    });

    it("parses a negative whole number", () => {
        expect(parseOptionalInt("-1", "min value")).toBe(-1);
    });

    it("throws on non-numeric text", () => {
        expect(() => parseOptionalInt("abc", "increment")).toThrow(/increment/);
    });

    it("throws on a non-integral number", () => {
        expect(() => parseOptionalInt("1.5", "cache")).toThrow(/cache/);
    });
});

describe("buildCreateSchemaSpec", () => {
    it("omits authorization when not given", () => {
        const spec = buildCreateSchemaSpec("analytics");

        expect(spec).toEqual({ name: "analytics" });
    });

    it("carries authorization when given", () => {
        const spec = buildCreateSchemaSpec("analytics", "app_owner");

        expect(spec).toEqual({ name: "analytics", authorization: "app_owner" });
    });
});

describe("buildDropSchemaSpec", () => {
    it("carries cascade only when set", () => {
        expect(buildDropSchemaSpec("analytics").cascade).toBeUndefined();
        expect(buildDropSchemaSpec("analytics", true).cascade).toBe(true);
    });
});

describe("buildRenameSchemaSpec", () => {
    it("builds a name/newName pair", () => {
        expect(buildRenameSchemaSpec("analytics", "reporting")).toEqual({
            name: "analytics", newName: "reporting",
        });
    });
});

describe("buildCreateSequenceSpec", () => {
    it("carries only the given numeric fields", () => {
        const spec = buildCreateSequenceSpec("public", "s", { increment: 1, start: 1000 });

        expect(spec).toEqual({ schema: "public", name: "s", increment: 1, start: 1000 });
    });

    it("omits cycle when false and carries it when true", () => {
        expect(buildCreateSequenceSpec("public", "s", {}).cycle).toBeUndefined();
        expect(buildCreateSequenceSpec("public", "s", {}, true).cycle).toBe(true);
    });

    it("carries ownedBy when given", () => {
        const ownedBy = { schema: "public", table: "orders", column: "id" };
        const spec = buildCreateSequenceSpec("public", "s", {}, false, ownedBy);

        expect(spec.ownedBy).toEqual(ownedBy);
    });
});

describe("buildAlterSequenceSpec", () => {
    it("carries only the given fields", () => {
        const spec = buildAlterSequenceSpec("public", "s", { increment: 2 });

        expect(spec).toEqual({ schema: "public", name: "s", increment: 2 });
    });

    it("carries restartDefault when set, distinct from a numeric restart", () => {
        expect(buildAlterSequenceSpec("public", "s", { restartDefault: true })).toEqual({
            schema: "public", name: "s", restartDefault: true,
        });
        expect(buildAlterSequenceSpec("public", "s", { restart: 5 })).toEqual({
            schema: "public", name: "s", restart: 5,
        });
    });

    it("carries an explicit false cycle (not just a truthy check)", () => {
        expect(buildAlterSequenceSpec("public", "s", { cycle: false })).toEqual({
            schema: "public", name: "s", cycle: false,
        });
    });

    it("omits cycle when unset", () => {
        expect(buildAlterSequenceSpec("public", "s", {}).cycle).toBeUndefined();
    });

    it("carries dataType when given", () => {
        expect(buildAlterSequenceSpec("public", "s", { dataType: "bigint" })).toEqual({
            schema: "public", name: "s", dataType: "bigint",
        });
    });

    it("carries start when given, as a string", () => {
        expect(buildAlterSequenceSpec("public", "s", { start: "1000" })).toEqual({
            schema: "public", name: "s", start: "1000",
        });
    });
});

describe("buildSequenceOwnerSpec", () => {
    it("builds a schema/name/owner triple", () => {
        expect(buildSequenceOwnerSpec("public", "s", "app_owner")).toEqual({
            schema: "public", name: "s", owner: "app_owner",
        });
    });
});

describe("buildDropSequenceSpec", () => {
    it("carries cascade only when set", () => {
        expect(buildDropSequenceSpec("public", "s").cascade).toBeUndefined();
        expect(buildDropSequenceSpec("public", "s", true).cascade).toBe(true);
    });
});

describe("diffSequenceSpecs", () => {
    const original: SequenceDetail = {
        lastValue: null,
        startValue: "1",
        minValue: "1",
        maxValue: "100",
        increment: "1",
        cacheSize: "1",
        cycle: false,
        dataType: "integer",
        owner: "alice",
    };

    // The edited-values snapshot the panel's readEdited() would produce with
    // no edits — every field mirrors `original` (Current value as "—", the
    // sentinel diffSequenceSpecs itself treats as "unset" for a null lastValue).
    const unedited: EditedSequenceValues = {
        lastValue: "—",
        startValue: original.startValue,
        increment: original.increment,
        minValue: original.minValue,
        maxValue: original.maxValue,
        cacheSize: original.cacheSize,
        cycle: original.cycle,
        dataType: original.dataType,
        owner: original.owner,
    };

    it("returns an empty result when nothing changed", () => {
        expect(diffSequenceSpecs("public", "s", original, unedited)).toEqual({});
    });

    it("diffs a changed increment as a string, not a number", () => {
        const specs = diffSequenceSpecs("public", "s", original, { ...unedited, increment: "5" });

        expect(specs).toEqual({ alter: { schema: "public", name: "s", increment: "5" } });
        expect(specs.alter?.increment).toBe("5");
    });

    it("preserves a bigint-sized maxValue as a string, never Number()d", () => {
        const specs = diffSequenceSpecs(
            "public", "s", original, { ...unedited, maxValue: "9223372036854775807" },
        );

        expect(specs.alter?.maxValue).toBe("9223372036854775807");
    });

    it("diffs cycle false->true and true->false, preserving an explicit false", () => {
        expect(diffSequenceSpecs("public", "s", original, { ...unedited, cycle: true })).toEqual({
            alter: { schema: "public", name: "s", cycle: true },
        });

        const cycledOriginal: SequenceDetail = { ...original, cycle: true };
        const cycledUnedited: EditedSequenceValues = { ...unedited, cycle: true };
        const specs = diffSequenceSpecs("public", "s", cycledOriginal, { ...cycledUnedited, cycle: false });

        expect(specs).toEqual({ alter: { schema: "public", name: "s", cycle: false } });
    });

    it("diffs only owner into a separate owner spec, leaving alter undefined", () => {
        const specs = diffSequenceSpecs("public", "s", original, { ...unedited, owner: "bob" });

        expect(specs).toEqual({ owner: { schema: "public", name: "s", owner: "bob" } });
    });

    it("sets both alter and owner when both change", () => {
        const specs = diffSequenceSpecs(
            "public", "s", original, { ...unedited, increment: "5", owner: "bob" },
        );

        expect(specs.alter).toEqual({ schema: "public", name: "s", increment: "5" });
        expect(specs.owner).toEqual({ schema: "public", name: "s", owner: "bob" });
    });

    it("diffs a changed dataType", () => {
        const specs = diffSequenceSpecs("public", "s", original, { ...unedited, dataType: "bigint" });

        expect(specs.alter?.dataType).toBe("bigint");
    });

    it("maps the Current value cell to restart, but only when actually set", () => {
        expect(diffSequenceSpecs("public", "s", original, { ...unedited, lastValue: "—" })).toEqual({});
        expect(diffSequenceSpecs("public", "s", original, { ...unedited, lastValue: "" })).toEqual({});

        const specs = diffSequenceSpecs("public", "s", original, { ...unedited, lastValue: "42" });

        expect(specs.alter).toEqual({ schema: "public", name: "s", restart: "42" });
    });

    it("throws on a non-integer changed numeric cell, mentioning the field", () => {
        expect(() => diffSequenceSpecs("public", "s", original, { ...unedited, increment: "1.5" }))
            .toThrow(/Increment/);
        expect(() => diffSequenceSpecs("public", "s", original, { ...unedited, increment: "x" }))
            .toThrow(/Increment/);
    });

    it("treats a revert-to-original edit as unchanged", () => {
        const roundTripped = { ...unedited, increment: "5" };
        const reverted = { ...roundTripped, increment: original.increment };

        expect(diffSequenceSpecs("public", "s", original, reverted)).toEqual({});
    });
});

describe("buildCreateFunctionSpec", () => {
    it("drops blank-type argument rows", () => {
        const rows: FunctionArgRow[] = [
            { type: "integer", name: "a", mode: "IN", default: "" },
            { type: "  ", name: "b", mode: "", default: "" },
        ];

        const spec = buildCreateFunctionSpec("public", "add", "function", rows, "plpgsql", "BEGIN END;", {});

        expect(spec.args).toHaveLength(1);
        expect(spec.args[0]).toEqual({ type: "integer", name: "a", mode: "IN" });
    });

    it("omits blank name/mode/default from an argument row", () => {
        const rows: FunctionArgRow[] = [{ type: "integer", name: "", mode: "", default: "" }];

        const spec = buildCreateFunctionSpec("public", "f", "function", rows, "sql", "SELECT 1", {});

        expect(spec.args[0]).toEqual({ type: "integer" });
    });

    it("carries a non-blank default through", () => {
        const rows: FunctionArgRow[] = [{ type: "integer", name: "a", mode: "", default: "0" }];

        const spec = buildCreateFunctionSpec("public", "f", "function", rows, "sql", "SELECT 1", {});

        expect(spec.args[0].default).toBe("0");
    });

    it("omits returns/volatility when unset and defaults replace to false", () => {
        const spec = buildCreateFunctionSpec("public", "f", "function", [], "sql", "SELECT 1", {});

        expect(spec.returns).toBeUndefined();
        expect(spec.volatility).toBeUndefined();
        expect(spec.replace).toBe(false);
    });

    it("carries returns/volatility/replace when set", () => {
        const spec = buildCreateFunctionSpec("public", "f", "function", [], "sql", "SELECT 1", {
            returns: "integer", volatility: "IMMUTABLE", replace: true,
        });

        expect(spec.returns).toBe("integer");
        expect(spec.volatility).toBe("IMMUTABLE");
        expect(spec.replace).toBe(true);
    });

    it("carries the procedure kind through", () => {
        expect(buildCreateFunctionSpec("public", "p", "procedure", [], "sql", "", {}).kind).toBe("procedure");
    });
});

describe("buildDropFunctionSpec", () => {
    it("carries the signature and cascade/ifExists only when set", () => {
        const spec = buildDropFunctionSpec("public", "add", "function", "integer, integer");

        expect(spec).toEqual({ schema: "public", name: "add", kind: "function", signature: "integer, integer" });
    });

    it("carries cascade and ifExists when set", () => {
        const spec = buildDropFunctionSpec("public", "add", "function", "integer, integer", true, true);

        expect(spec.cascade).toBe(true);
        expect(spec.ifExists).toBe(true);
    });
});

describe("buildCreateEnumTypeSpec", () => {
    it("drops blank label rows", () => {
        const spec = buildCreateEnumTypeSpec("public", "mood", ["sad", "  ", "happy"]);

        expect(spec.labels).toEqual(["sad", "happy"]);
    });
});

describe("buildCreateCompositeTypeSpec", () => {
    it("drops a row with a blank name or type", () => {
        const spec = buildCreateCompositeTypeSpec("public", "addr", [
            { name: "street", type: "text" },
            { name: "  ", type: "text" },
            { name: "zip", type: "" },
        ]);

        expect(spec.attributes).toEqual([{ name: "street", type: "text" }]);
    });
});

describe("buildDropTypeSpec", () => {
    it("carries cascade/ifExists only when set", () => {
        expect(buildDropTypeSpec("public", "mood")).toEqual({ schema: "public", name: "mood" });
        expect(buildDropTypeSpec("public", "mood", true, true)).toEqual({
            schema: "public", name: "mood", cascade: true, ifExists: true,
        });
    });
});

describe("buildAlterTypeAddValueSpec", () => {
    it("omits position when not given", () => {
        expect(buildAlterTypeAddValueSpec("public", "mood", "great")).toEqual({
            schema: "public", name: "mood", value: "great",
        });
    });

    it("carries a given position through", () => {
        const spec = buildAlterTypeAddValueSpec("public", "mood", "great", { placement: "after", label: "happy" });

        expect(spec.position).toEqual({ placement: "after", label: "happy" });
    });
});
