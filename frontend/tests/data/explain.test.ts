import { describe, it, expect } from "vitest";
import { isReadOnlyStatement } from "../../src/data/explain";

describe("isReadOnlyStatement", () => {
    it("treats SELECT / TABLE / VALUES / SHOW as read-only, case- and space-insensitively", () => {
        expect(isReadOnlyStatement("SELECT * FROM t")).toBe(true);
        expect(isReadOnlyStatement("  select 1")).toBe(true);
        expect(isReadOnlyStatement("VALUES (1)")).toBe(true);
        expect(isReadOnlyStatement("TABLE t")).toBe(true);
        expect(isReadOnlyStatement("SHOW all")).toBe(true);
    });

    it("treats a WITH whose top-level body is a SELECT/VALUES as read-only", () => {
        expect(isReadOnlyStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
        expect(isReadOnlyStatement("with x as (select 1) values (1)")).toBe(true);
    });

    it("treats a WITH whose top-level body writes as not read-only", () => {
        expect(isReadOnlyStatement("WITH x AS (SELECT 1) DELETE FROM t")).toBe(false);
        expect(isReadOnlyStatement("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toBe(false);
    });

    it("treats writes and DDL as not read-only", () => {
        for (const sql of [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET x = 1",
            "DELETE FROM t",
            "CREATE TABLE t (id int)",
            "DROP TABLE t",
            "ALTER TABLE t ADD COLUMN c int",
            "TRUNCATE t",
            "GRANT SELECT ON t TO r",
        ]) {
            expect(isReadOnlyStatement(sql)).toBe(false);
        }
    });

    it("strips leading comments before classifying", () => {
        expect(isReadOnlyStatement("-- a note\nSELECT 1")).toBe(true);
        expect(isReadOnlyStatement("/* a note */ SELECT 1")).toBe(true);
        expect(isReadOnlyStatement("-- a note\nUPDATE t SET x = 1")).toBe(false);
    });

    it("is conservative for empty, whitespace-only, or unknown statements", () => {
        expect(isReadOnlyStatement("")).toBe(false);
        expect(isReadOnlyStatement("   \n  ")).toBe(false);
        expect(isReadOnlyStatement("EXPLAIN SELECT 1")).toBe(false);
        expect(isReadOnlyStatement("VACUUM")).toBe(false);
    });
});
