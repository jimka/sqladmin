// Pure spec-assembly tests for the table-DDL dialog forms: row -> ColumnSpec,
// action + fields -> the action-tagged specs, and the column-order helper
// backing ColumnChecklist.readSelected(). DOM-free (the forms themselves
// touch `document` at import scope — see memory "tsui DOM module side
// effects" — and are manual-verify; this module is the pure logic they call).

import { describe, expect, it } from "vitest";
import {
    buildAlterCompositeTypeSpec,
    buildAlterSequenceSpec,
    buildAlterTableSpec,
    buildAlterTypeAddValueSpec,
    buildAlterTypeRenameValueSpec,
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
    buildRecreateEnumTypeSpec,
    buildRenameSchemaSpec,
    buildSequenceOwnerSpec,
    describeColumnSpecs,
    describeCompositeSpecs,
    describeEnumPlan,
    describeSequenceSpecs,
    diffColumnSpecs,
    diffCompositeAttributeSpecs,
    diffEnumLabels,
    diffSequenceSpecs,
    orderColumnsBySelection,
    orderRenamesForExecution,
    preserveSuggestedColumnOrder,
    parseColumnList,
    parseOptionalInt,
    stripTrailingSemicolon,
} from "../../src/dock/ddlSpecs";
import type {
    ColumnRow, EditedAttributeRow, EditedColumnRow, EditedLabelRow, EditedSequenceValues, FunctionArgRow,
} from "../../src/dock/ddlSpecs";
import type { AlterTableSpec, ColumnMeta, SequenceDetail } from "../../src/contract";

// The pre-edit sequence detail shared by describeSequenceSpecs's and
// diffSequenceSpecs's suites — both describe the same "what changed" shape,
// one as text lines and the other as wire specs.
const SEQUENCE_DETAIL: SequenceDetail = {
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

describe("diffColumnSpecs", () => {
    /** A minimal ColumnMeta, filling in the fields a case doesn't vary. */
    function columnMeta(overrides: Partial<ColumnMeta> & { name: string }): ColumnMeta {
        return {
            dataType: "text", fullType: "text", nullable: true, isPrimaryKey: false,
            isGenerated: false, hasDefault: false, defaultExpr: null, wireType: "string",
            ...overrides,
        };
    }

    /** The edited row an unedited grid seed produces for `c`. */
    function seededRow(c: ColumnMeta): EditedColumnRow {
        return { originalName: c.name, name: c.name, type: c.fullType, nullable: c.nullable, default: c.defaultExpr ?? "" };
    }

    /** A blank in-progress "Add column" row, overridable per test. */
    function blankRow(overrides: Partial<EditedColumnRow> = {}): EditedColumnRow {
        return { originalName: "", name: "", type: "", nullable: true, default: "", ...overrides };
    }

    const note: ColumnMeta   = columnMeta({ name: "note", fullType: "text" });
    const legacy: ColumnMeta = columnMeta({ name: "legacy", fullType: "integer" });
    const original: ColumnMeta[] = [note, legacy];
    const unedited: EditedColumnRow[] = original.map(seededRow);

    it("returns no specs when nothing changed", () => {
        expect(diffColumnSpecs("public", "invoices", original, unedited)).toEqual([]);
    });

    it("diffs a renamed column", () => {
        const edited = unedited.map(r => r.originalName === "note" ? { ...r, name: "memo" } : r);

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([
            { schema: "public", name: "invoices", action: "renameColumn", column: "note", newName: "memo" },
        ]);
    });

    it("diffs a changed type", () => {
        const edited = unedited.map(r => r.originalName === "note" ? { ...r, type: "varchar(200)" } : r);

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([
            { schema: "public", name: "invoices", action: "changeType", column: "note", newType: "varchar(200)" },
        ]);
    });

    it("diffs nullable cleared to setNotNull", () => {
        const edited = unedited.map(r => r.originalName === "note" ? { ...r, nullable: false } : r);

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([
            { schema: "public", name: "invoices", action: "setNotNull", column: "note" },
        ]);
    });

    it("diffs a NOT NULL column's nullable checked to dropNotNull", () => {
        const requiredCol = columnMeta({ name: "req", fullType: "text", nullable: false });
        const edited = [{ ...seededRow(requiredCol), nullable: true }];

        expect(diffColumnSpecs("public", "invoices", [requiredCol], edited)).toEqual([
            { schema: "public", name: "invoices", action: "dropNotNull", column: "req" },
        ]);
    });

    it("diffs a set default", () => {
        const edited = unedited.map(r => r.originalName === "note" ? { ...r, default: "now()" } : r);

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([
            { schema: "public", name: "invoices", action: "setDefault", column: "note", default: "now()" },
        ]);
    });

    it("diffs a defaulted column's default cleared to dropDefault", () => {
        const defaultedCol = columnMeta({ name: "created", fullType: "timestamptz", defaultExpr: "now()" });
        const edited = [{ ...seededRow(defaultedCol), default: "" }];

        expect(diffColumnSpecs("public", "invoices", [defaultedCol], edited)).toEqual([
            { schema: "public", name: "invoices", action: "dropDefault", column: "created" },
        ]);
    });

    it("diffs a removed row to dropColumn", () => {
        const edited = unedited.filter(r => r.originalName !== "legacy");

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([
            { schema: "public", name: "invoices", action: "dropColumn", column: "legacy" },
        ]);
    });

    it("diffs a new row to addColumn", () => {
        const edited = [...unedited, blankRow({ name: "memo", type: "text" })];

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([
            {
                schema: "public", name: "invoices", action: "addColumn",
                columnDef: { name: "memo", type: "text", nullable: true, default: null, primaryKey: false },
            },
        ]);
    });

    it("silently drops a blank in-progress new row", () => {
        const edited = [...unedited, blankRow()];

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([]);
    });

    it("throws naming the column when a new row has a name but a blank type", () => {
        const edited = [...unedited, blankRow({ name: "memo" })];

        expect(() => diffColumnSpecs("public", "invoices", original, edited)).toThrow(/memo/);
    });

    it("throws naming the column when a kept row's name is cleared", () => {
        const edited = unedited.map(r => r.originalName === "note" ? { ...r, name: "" } : r);

        expect(() => diffColumnSpecs("public", "invoices", original, edited)).toThrow(/note/);
    });

    it("throws naming the column when a kept row's type is cleared", () => {
        const edited = unedited.map(r => r.originalName === "note" ? { ...r, type: "" } : r);

        expect(() => diffColumnSpecs("public", "invoices", original, edited)).toThrow(/note/);
    });

    it("orders a rename-and-retype column's changeType (naming the old name) before its renameColumn", () => {
        const edited = unedited.map(r => r.originalName === "note" ? { ...r, name: "memo", type: "varchar(200)" } : r);
        const specs = diffColumnSpecs("public", "invoices", original, edited);

        expect(specs).toEqual([
            { schema: "public", name: "invoices", action: "changeType", column: "note", newType: "varchar(200)" },
            { schema: "public", name: "invoices", action: "renameColumn", column: "note", newName: "memo" },
        ]);
    });

    it("orders the worked example: drops, then alters, then renames, then adds", () => {
        // note -> memo, retyped, NOT NULL; legacy dropped; issued_at added.
        const edited: EditedColumnRow[] = [
            { originalName: "note", name: "memo", type: "varchar(200)", nullable: false, default: "" },
            blankRow({ name: "issued_at", type: "timestamptz", default: "now()" }),
        ];

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([
            { schema: "public", name: "invoices", action: "dropColumn", column: "legacy" },
            { schema: "public", name: "invoices", action: "changeType", column: "note", newType: "varchar(200)" },
            { schema: "public", name: "invoices", action: "setNotNull", column: "note" },
            { schema: "public", name: "invoices", action: "renameColumn", column: "note", newName: "memo" },
            {
                schema: "public", name: "invoices", action: "addColumn",
                columnDef: { name: "issued_at", type: "timestamptz", nullable: true, default: "now()", primaryKey: false },
            },
        ]);
    });

    it("produces no spec for a field edited then reverted to its original text", () => {
        const roundTripped = unedited.map(r => r.originalName === "note" ? { ...r, type: "varchar(200)" } : r);
        const reverted = roundTripped.map(r => r.originalName === "note" ? { ...r, type: "text" } : r);

        expect(diffColumnSpecs("public", "invoices", original, reverted)).toEqual([]);
    });

    it("produces no spec when a type differs from the original only by surrounding whitespace", () => {
        const edited = unedited.map(r => r.originalName === "note" ? { ...r, type: "  text  " } : r);

        expect(diffColumnSpecs("public", "invoices", original, edited)).toEqual([]);
    });
});

describe("describeColumnSpecs", () => {
    it("returns an empty array for an empty input", () => {
        expect(describeColumnSpecs([])).toEqual([]);
    });

    it("describes each action in spec order, one line per spec", () => {
        const specs: AlterTableSpec[] = [
            { schema: "public", name: "t", action: "dropColumn", column: "legacy" },
            { schema: "public", name: "t", action: "changeType", column: "note", newType: "varchar(200)" },
            { schema: "public", name: "t", action: "setNotNull", column: "note" },
            { schema: "public", name: "t", action: "dropNotNull", column: "note" },
            { schema: "public", name: "t", action: "setDefault", column: "note", default: "now()" },
            { schema: "public", name: "t", action: "dropDefault", column: "note" },
            { schema: "public", name: "t", action: "renameColumn", column: "note", newName: "memo" },
            {
                schema: "public", name: "t", action: "addColumn",
                columnDef: { name: "memo", type: "text", nullable: true, default: null, primaryKey: false },
            },
            { schema: "public", name: "t", action: "renameTable", newName: "invoices2" },
        ];

        expect(describeColumnSpecs(specs)).toEqual([
            'Drop column: "legacy"',
            'Change type: "note" → varchar(200)',
            'Set NOT NULL: "note"',
            'Drop NOT NULL: "note"',
            'Set default: "note" → now()',
            'Drop default: "note"',
            'Rename: "note" → "memo"',
            'Add column: "memo" text',
            'Rename table to "invoices2"',
        ]);
    });
});

describe("describeSequenceSpecs", () => {
    it("returns an empty array when neither alter nor owner is set", () => {
        expect(describeSequenceSpecs({}, SEQUENCE_DETAIL)).toEqual([]);
    });

    it("describes a changed increment against the pre-edit value", () => {
        const detail: SequenceDetail = { ...SEQUENCE_DETAIL, increment: "10" };
        const specs = { alter: { schema: "public", name: "s", increment: "25" } };

        expect(describeSequenceSpecs(specs, detail)).toEqual(["Increment: 10 → 25"]);
    });

    it("describes several changed alter fields, data type first, in declared order", () => {
        const specs = { alter: { schema: "public", name: "s", dataType: "bigint", cache: "50" } };

        expect(describeSequenceSpecs(specs, SEQUENCE_DETAIL)).toEqual([
            "Data type: integer → bigint",
            "Cache size: 1 → 50",
        ]);
    });

    it("describes an owner-only spec as the owner line alone", () => {
        const specs = { owner: { schema: "public", name: "s", owner: "bob" } };

        expect(describeSequenceSpecs(specs, SEQUENCE_DETAIL)).toEqual(["Owner: alice → bob"]);
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

    it("omits cascade from a drop spec when the CASCADE checkbox is unchecked", () => {
        const spec = buildConstraintSpec("public", "t", "drop", { constraintName: "t_email_key", cascade: false });

        expect("cascade" in spec).toBe(false);
    });

    it("carries cascade through a drop spec when the CASCADE checkbox is checked", () => {
        const spec = buildConstraintSpec("public", "t", "drop", { constraintName: "t_email_key", cascade: true });

        expect(spec).toEqual({
            schema: "public", name: "t", action: "drop", constraintName: "t_email_key", cascade: true,
        });
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

    it("omits cascade from a drop spec when the CASCADE checkbox is unchecked", () => {
        const spec = buildIndexSpec("public", "drop", { indexName: "t_email_idx", cascade: false });

        expect("cascade" in spec).toBe(false);
    });

    it("carries cascade through a drop spec when the CASCADE checkbox is checked", () => {
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

describe("preserveSuggestedColumnOrder", () => {
    it("returns the suggested order when the selection is unchanged from it", () => {
        // The table's own column order ("id" before "status" before "created_at")
        // differs from the advisor's deliberate equality-then-sort order.
        const selected = ["id", "status", "created_at"];
        const suggested = ["status", "created_at", "id"];

        expect(preserveSuggestedColumnOrder(selected, suggested)).toEqual(suggested);
    });

    it("returns the suggested order regardless of the selection's own order", () => {
        expect(preserveSuggestedColumnOrder(["created_at", "status"], ["status", "created_at"]))
            .toEqual(["status", "created_at"]);
    });

    it("falls back to the table-order selection once the user unchecks a suggested column", () => {
        const selected = ["status"]; // "created_at" was unchecked
        const suggested = ["status", "created_at"];

        expect(preserveSuggestedColumnOrder(selected, suggested)).toEqual(selected);
    });

    it("falls back to the table-order selection once the user checks an extra column", () => {
        const selected = ["status", "created_at", "total"]; // "total" was added
        const suggested = ["status", "created_at"];

        expect(preserveSuggestedColumnOrder(selected, suggested)).toEqual(selected);
    });

    it("returns the selection unchanged when there is no suggested order", () => {
        expect(preserveSuggestedColumnOrder(["a", "b"], undefined)).toEqual(["a", "b"]);
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
    const original: SequenceDetail = SEQUENCE_DETAIL;

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

describe("buildAlterCompositeTypeSpec", () => {
    it("carries only the fields dropAttribute needs", () => {
        const spec = buildAlterCompositeTypeSpec("public", "addr", "dropAttribute", { attribute: "city" });

        expect(spec).toEqual({ schema: "public", name: "addr", action: "dropAttribute", attribute: "city" });
    });

    it("carries only the fields addAttribute needs", () => {
        const spec = buildAlterCompositeTypeSpec("public", "addr", "addAttribute", {
            attributeDef: { name: "zip", type: "varchar(10)" },
        });

        expect(spec).toEqual({
            schema: "public", name: "addr", action: "addAttribute",
            attributeDef: { name: "zip", type: "varchar(10)" },
        });
    });
});

describe("diffCompositeAttributeSpecs", () => {
    const ORIGINAL = [{ name: "street", type: "text" }, { name: "city", type: "text" }];

    it("returns [] for an unchanged grid", () => {
        const edited: EditedAttributeRow[] = [
            { originalName: "street", name: "street", type: "text" },
            { originalName: "city", name: "city", type: "text" },
        ];

        expect(diffCompositeAttributeSpecs("public", "addr", ORIGINAL, edited)).toEqual([]);
    });

    it("emits a delete, a rename and an add, in that order", () => {
        const edited: EditedAttributeRow[] = [
            { originalName: "street", name: "road", type: "text" },
            { originalName: "", name: "zip", type: "varchar(10)" },
        ];

        const specs = diffCompositeAttributeSpecs("public", "addr", ORIGINAL, edited);

        expect(specs).toEqual([
            { schema: "public", name: "addr", action: "dropAttribute", attribute: "city" },
            { schema: "public", name: "addr", action: "renameAttribute", attribute: "street", newName: "road" },
            {
                schema: "public", name: "addr", action: "addAttribute",
                attributeDef: { name: "zip", type: "varchar(10)" },
            },
        ]);
    });

    it("orders a retype-and-rename as changeAttributeType (pre-rename name) then renameAttribute", () => {
        const original = [{ name: "a", type: "int" }];
        const edited: EditedAttributeRow[] = [{ originalName: "a", name: "b", type: "bigint" }];

        const specs = diffCompositeAttributeSpecs("public", "addr", original, edited);

        expect(specs).toEqual([
            { schema: "public", name: "addr", action: "changeAttributeType", attribute: "a", newType: "bigint" },
            { schema: "public", name: "addr", action: "renameAttribute", attribute: "a", newName: "b" },
        ]);
    });

    it("throws when a kept row's name is blank", () => {
        const edited: EditedAttributeRow[] = [{ originalName: "street", name: "  ", type: "text" }];

        expect(() => diffCompositeAttributeSpecs("public", "addr", ORIGINAL.slice(0, 1), edited))
            .toThrow('Attribute "street" cannot be renamed to an empty name');
    });

    it("throws when a kept row's type is blank", () => {
        const edited: EditedAttributeRow[] = [{ originalName: "street", name: "street", type: "  " }];

        expect(() => diffCompositeAttributeSpecs("public", "addr", ORIGINAL.slice(0, 1), edited))
            .toThrow('Attribute "street" needs a type');
    });

    it("throws when an added row has a name but a blank type", () => {
        const edited: EditedAttributeRow[] = [{ originalName: "", name: "zip", type: "  " }];

        expect(() => diffCompositeAttributeSpecs("public", "addr", [], edited))
            .toThrow('New attribute "zip" needs a type');
    });

    it("ignores an added row whose name is blank", () => {
        const edited: EditedAttributeRow[] = [{ originalName: "", name: "  ", type: "text" }];

        expect(diffCompositeAttributeSpecs("public", "addr", [], edited)).toEqual([]);
    });
});

describe("describeCompositeSpecs", () => {
    it("describes one line per spec, in the given order", () => {
        const specs = [
            buildAlterCompositeTypeSpec("public", "addr", "addAttribute", { attributeDef: { name: "zip", type: "varchar(10)" } }),
            buildAlterCompositeTypeSpec("public", "addr", "dropAttribute", { attribute: "city" }),
            buildAlterCompositeTypeSpec("public", "addr", "changeAttributeType", { attribute: "a", newType: "bigint" }),
            buildAlterCompositeTypeSpec("public", "addr", "renameAttribute", { attribute: "street", newName: "road" }),
        ];

        expect(describeCompositeSpecs(specs)).toEqual([
            'Add attribute: "zip" varchar(10)',
            'Drop attribute: "city"',
            'Change type: "a" → bigint',
            'Rename: "street" → "road"',
        ]);
    });
});

describe("diffEnumLabels", () => {
    const ORIGINAL = ["sad", "ok", "happy"];

    function rows(labels: { originalLabel: string; label: string }[]): EditedLabelRow[] {
        return labels;
    }

    it("adds a label", () => {
        const edited = rows([
            { originalLabel: "sad", label: "sad" },
            { originalLabel: "ok", label: "ok" },
            { originalLabel: "happy", label: "happy" },
            { originalLabel: "", label: "elated" },
        ]);

        expect(diffEnumLabels("public", "mood", ORIGINAL, edited)).toEqual({
            kind: "alter",
            adds: [{ schema: "public", name: "mood", value: "elated" }],
            renames: [],
        });
    });

    it("renames a label", () => {
        const edited = rows([
            { originalLabel: "sad", label: "sad" },
            { originalLabel: "ok", label: "fine" },
            { originalLabel: "happy", label: "happy" },
        ]);

        expect(diffEnumLabels("public", "mood", ORIGINAL, edited)).toEqual({
            kind: "alter",
            adds: [],
            renames: [{ schema: "public", name: "mood", value: "ok", newValue: "fine" }],
        });
    });

    it("renames a label and adds one, renames first", () => {
        const edited = rows([
            { originalLabel: "sad", label: "sad" },
            { originalLabel: "ok", label: "fine" },
            { originalLabel: "happy", label: "happy" },
            { originalLabel: "", label: "elated" },
        ]);

        const plan = diffEnumLabels("public", "mood", ORIGINAL, edited);

        expect(plan).toEqual({
            kind: "alter",
            adds: [{ schema: "public", name: "mood", value: "elated" }],
            renames: [{ schema: "public", name: "mood", value: "ok", newValue: "fine" }],
        });
    });

    it("routes a deleted label through a recreate", () => {
        const edited = rows([
            { originalLabel: "sad", label: "sad" },
            { originalLabel: "happy", label: "happy" },
        ]);

        expect(diffEnumLabels("public", "mood", ORIGINAL, edited)).toEqual({
            kind: "recreate",
            spec: { schema: "public", name: "mood", labels: ["sad", "happy"], renames: [], collidingRenames: [] },
            removed: ["ok"],
            renames: [],
            liveRenames: [],
        });
    });

    it("routes a deleted label plus an add through a recreate carrying both", () => {
        const edited = rows([
            { originalLabel: "sad", label: "sad" },
            { originalLabel: "happy", label: "happy" },
            { originalLabel: "", label: "elated" },
        ]);

        expect(diffEnumLabels("public", "mood", ORIGINAL, edited)).toEqual({
            kind: "recreate",
            spec: {
                schema: "public", name: "mood", labels: ["sad", "happy", "elated"], renames: [], collidingRenames: [],
            },
            removed: ["ok"],
            renames: [],
            liveRenames: [],
        });
    });

    it("carries a kept rename into the recreate plan, keyed on the pre-rename label", () => {
        // A rename of a label that survives the edit must run against the
        // *original* type, before it's renamed aside — otherwise the
        // migration casts stored data through its stale, pre-rename text
        // and the recreate fails against any row still holding it. It also
        // rides in `spec.renames`, since the backend's own dependent-column
        // introspection runs before this (or any) statement has executed.
        // It's non-colliding (its target isn't a removed label), so it's
        // absent from `spec.collidingRenames`.
        const edited = rows([
            { originalLabel: "sad", label: "fine" },
            { originalLabel: "happy", label: "happy" },
        ]);

        const rename = { schema: "public", name: "mood", value: "sad", newValue: "fine" };

        expect(diffEnumLabels("public", "mood", ORIGINAL, edited)).toEqual({
            kind: "recreate",
            spec: {
                schema: "public", name: "mood", labels: ["fine", "happy"],
                renames: [{ value: "sad", newValue: "fine" }], collidingRenames: [],
            },
            removed: ["ok"],
            renames: [rename],
            liveRenames: [rename],
        });
    });

    it("excludes a rename from liveRenames when its target collides with a same-edit removal", () => {
        // Renaming "foo" to "bar" while also deleting the original "bar" in
        // the same edit: Postgres refuses `RENAME VALUE ... TO 'bar'` while
        // the type still has a distinct "bar" label (no DROP VALUE exists to
        // free the name first), so this rename must never run live — the
        // recreate step's own CREATE TYPE builds the fresh type with "bar"
        // (the grid's final spelling) directly instead. It's colliding, so
        // it rides in `spec.collidingRenames` too, for the backend's
        // rename-aware data migration.
        const edited = rows([
            { originalLabel: "foo", label: "bar" },
            { originalLabel: "baz", label: "baz" },
        ]);

        const rename = { schema: "public", name: "mood", value: "foo", newValue: "bar" };

        expect(diffEnumLabels("public", "mood", ["foo", "bar", "baz"], edited)).toEqual({
            kind: "recreate",
            spec: {
                schema: "public", name: "mood", labels: ["bar", "baz"],
                renames: [{ value: "foo", newValue: "bar" }], collidingRenames: [{ value: "foo", newValue: "bar" }],
            },
            removed: ["bar"],
            renames: [rename],
            liveRenames: [],
        });
    });

    it("reports no changes for a row added and then deleted again in the same session", () => {
        // The grid never carries a phantom row for an add-then-delete — the
        // row is simply gone from `edited`, identical to the loaded state.
        const edited = rows([
            { originalLabel: "sad", label: "sad" },
            { originalLabel: "ok", label: "ok" },
            { originalLabel: "happy", label: "happy" },
        ]);

        expect(diffEnumLabels("public", "mood", ORIGINAL, edited)).toEqual({ kind: "none" });
    });

    it("throws when every row is deleted", () => {
        expect(() => diffEnumLabels("public", "mood", ORIGINAL, []))
            .toThrow('Type "public"."mood" needs at least one label');
    });

    it("throws when a kept row is renamed to blank", () => {
        const edited = rows([{ originalLabel: "ok", label: "  " }]);

        expect(() => diffEnumLabels("public", "mood", ["ok"], edited))
            .toThrow('Label "ok" cannot be renamed to an empty name');
    });

    it("ignores an added row with a blank label", () => {
        const edited = rows([{ originalLabel: "ok", label: "ok" }, { originalLabel: "", label: "  " }]);

        expect(diffEnumLabels("public", "mood", ["ok"], edited)).toEqual({ kind: "none" });
    });
});

describe("describeEnumPlan", () => {
    it("returns [] for a no-op plan", () => {
        expect(describeEnumPlan({ kind: "none" })).toEqual([]);
    });

    it("describes an alter plan's statements, renames before adds", () => {
        const plan = diffEnumLabels("public", "mood", ["sad", "ok", "happy"], [
            { originalLabel: "sad", label: "sad" },
            { originalLabel: "ok", label: "fine" },
            { originalLabel: "happy", label: "happy" },
            { originalLabel: "", label: "elated" },
        ]);

        expect(describeEnumPlan(plan)).toEqual([
            "Rename label: 'ok' → 'fine'",
            "Add label: 'elated'",
        ]);
    });

    it("describes a recreate plan's three warning lines, naming every removed label", () => {
        const plan = diffEnumLabels("public", "mood", ["sad", "ok", "happy"], [
            { originalLabel: "sad", label: "sad" },
            { originalLabel: "happy", label: "happy" },
        ]);

        expect(describeEnumPlan(plan)).toEqual([
            "Removing label 'ok' needs the type recreated — PostgreSQL has no ALTER TYPE ... DROP VALUE.",
            "\"public\".\"mood\" is renamed aside, recreated as ('sad', 'happy'), and every table column using it is rewritten.",
            "This fails and rolls back if a stored row still holds a removed label, or a view depends on one of those columns.",
        ]);
    });

    it("leads a recreate plan's summary with its kept renames, before the warning lines", () => {
        const plan = diffEnumLabels("public", "mood", ["sad", "ok", "happy"], [
            { originalLabel: "sad", label: "fine" },
            { originalLabel: "happy", label: "happy" },
        ]);

        expect(describeEnumPlan(plan)).toEqual([
            "Rename label: 'sad' → 'fine'",
            "Removing label 'ok' needs the type recreated — PostgreSQL has no ALTER TYPE ... DROP VALUE.",
            "\"public\".\"mood\" is renamed aside, recreated as ('fine', 'happy'), and every table column using it is rewritten.",
            "This fails and rolls back if a stored row still holds a removed label, or a view depends on one of those columns.",
        ]);
    });

    it("comma-joins multiple removed labels in the recreate warning's first line", () => {
        const plan = diffEnumLabels("public", "mood", ["sad", "ok", "happy"], [
            { originalLabel: "sad", label: "sad" },
        ]);

        expect(describeEnumPlan(plan)[0]).toBe(
            "Removing labels 'ok', 'happy' needs the type recreated — PostgreSQL has no ALTER TYPE ... DROP VALUE.",
        );
    });
});

describe("buildAlterTypeRenameValueSpec / buildRecreateEnumTypeSpec", () => {
    it("builds a rename-value spec", () => {
        expect(buildAlterTypeRenameValueSpec("public", "mood", "ok", "fine")).toEqual({
            schema: "public", name: "mood", value: "ok", newValue: "fine",
        });
    });

    it("builds a recreate spec with no renames", () => {
        expect(buildRecreateEnumTypeSpec("public", "mood", ["sad", "happy"], [], [])).toEqual({
            schema: "public", name: "mood", labels: ["sad", "happy"], renames: [], collidingRenames: [],
        });
    });

    it("builds a recreate spec carrying its renames and collidingRenames as {value, newValue} pairs", () => {
        const rename = { schema: "public", name: "mood", value: "ok", newValue: "fine" };

        expect(buildRecreateEnumTypeSpec("public", "mood", ["fine", "happy"], [rename], [rename])).toEqual({
            schema: "public", name: "mood", labels: ["fine", "happy"],
            renames: [{ value: "ok", newValue: "fine" }], collidingRenames: [{ value: "ok", newValue: "fine" }],
        });
    });
});

describe("orderRenamesForExecution", () => {
    // Simulates running the ordered statements against a live enum's label
    // set, throwing the same way Postgres's own `RENAME VALUE` would if a
    // step's source is gone or its target still exists — a pass proves the
    // sequence is genuinely executable, not just plausible-looking, and the
    // returned per-entity name proves a rotation's members actually swapped
    // rather than merely leaving the label *set* unchanged. `currentLabels`
    // defaults to every rename's own source, the common case in these tests;
    // the "blocked by a label outside the batch" cases pass their own.
    function simulate(
        renames: { value: string; newValue: string }[], currentLabels?: string[],
    ): Record<string, string> {
        const specs  = renames.map(x => buildAlterTypeRenameValueSpec("public", "mood", x.value, x.newValue));
        const labels = currentLabels ?? renames.map(r => r.value);
        const entities = labels.map(id => ({ id, name: id }));
        const byName   = new Map(entities.map(e => [e.name, e]));

        for (const r of orderRenamesForExecution(specs, labels)) {
            const entity = byName.get(r.value);

            if (!entity) throw new Error(`rename source "${r.value}" does not exist at this point`);
            if (byName.has(r.newValue)) throw new Error(`rename target "${r.newValue}" already exists at this point`);

            byName.delete(r.value);
            entity.name = r.newValue;
            byName.set(r.newValue, entity);
        }

        return Object.fromEntries(entities.map(e => [e.id, e.name]));
    }

    it("returns an empty sequence for no renames", () => {
        expect(orderRenamesForExecution([], [])).toEqual([]);
    });

    it("leaves a single rename untouched", () => {
        const rename = buildAlterTypeRenameValueSpec("public", "mood", "ok", "fine");

        expect(orderRenamesForExecution([rename], ["ok"])).toEqual([rename]);
    });

    it("leaves independent renames in their original order", () => {
        const renames = [
            buildAlterTypeRenameValueSpec("public", "mood", "a", "x"),
            buildAlterTypeRenameValueSpec("public", "mood", "c", "y"),
        ];

        expect(orderRenamesForExecution(renames, ["a", "c"])).toEqual(renames);
    });

    it("reorders a chain so the blocking rename runs first", () => {
        // "a"->"b" can't run until "b"->"c" has freed "b".
        const ordered = orderRenamesForExecution(
            [
                buildAlterTypeRenameValueSpec("public", "mood", "a", "b"),
                buildAlterTypeRenameValueSpec("public", "mood", "b", "c"),
            ],
            ["a", "b"],
        );

        expect(ordered.map(r => `${r.value}->${r.newValue}`)).toEqual(["b->c", "a->b"]);
        expect(simulate([{ value: "a", newValue: "b" }, { value: "b", newValue: "c" }])).toEqual({ a: "b", b: "c" });
    });

    it("breaks a two-way rotation with a synthetic temporary label", () => {
        // Neither order works unaided: renaming "a"->"b" first collides with
        // the still-live "b", and renaming "b"->"a" first collides with the
        // still-live "a".
        expect(simulate([{ value: "a", newValue: "b" }, { value: "b", newValue: "a" }])).toEqual({ a: "b", b: "a" });
    });

    it("breaks a three-way rotation", () => {
        expect(simulate([
            { value: "a", newValue: "b" }, { value: "b", newValue: "c" }, { value: "c", newValue: "a" },
        ])).toEqual({ a: "b", b: "c", c: "a" });
    });

    it("breaks a rotation combined with an independent chain in the same edit", () => {
        expect(simulate([
            { value: "a", newValue: "b" }, { value: "b", newValue: "a" },
            { value: "x", newValue: "y" }, { value: "y", newValue: "z" },
        ])).toEqual({ a: "b", b: "a", x: "y", y: "z" });
    });

    it("waits on a label outside the renames batch, then succeeds once it's freed by another rename", () => {
        // "b"->"c" isn't in this batch at all (e.g. EnumEditPlan excluded it
        // for its own reasons) but it still occupies "b" until *something*
        // frees it — here, nothing does, so "a"->"b" can never run live.
        // Compare the next test, where a same-batch rename does free "b".
        expect(() => simulate([{ value: "a", newValue: "b" }], ["a", "b"])).toThrow();
    });

    it("runs a rename once a same-batch rename frees its target first", () => {
        // "z"->"b" only becomes runnable after "b"->"c" has vacated "b".
        expect(simulate(
            [{ value: "b", newValue: "c" }, { value: "z", newValue: "b" }],
        )).toEqual({ b: "c", z: "b" });
    });

    it("throws instead of looping forever when two renames target the same label", () => {
        // "x"->"a" and "b"->"a" can never both succeed — Postgres allows only
        // one label spelled "a". No amount of reordering or temp-labelling
        // resolves this, so it must raise rather than hang.
        const renames = [
            buildAlterTypeRenameValueSpec("public", "mood", "x", "a"),
            buildAlterTypeRenameValueSpec("public", "mood", "b", "a"),
        ];

        expect(() => orderRenamesForExecution(renames, ["x", "a", "b"])).toThrow();
    });

    it("throws when a rename's target is occupied by a label nothing in the batch frees", () => {
        // "a"->"b" is blocked by the type's own untouched "b" label — no
        // rename in this batch ever vacates it.
        const renames = [buildAlterTypeRenameValueSpec("public", "mood", "a", "b")];

        expect(() => orderRenamesForExecution(renames, ["a", "b"])).toThrow();
    });
});
