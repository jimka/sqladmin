import { describe, it, expect } from "vitest";
import { buildSelectSql } from "./sql";
import type { DbObjectRef } from "../contract";

const ref = (over: Partial<DbObjectRef> = {}): DbObjectRef => ({
    connectionId: "default",
    database    : "db",
    schema      : "public",
    name        : "customers",
    kind        : "table",
    ...over,
});

describe("buildSelectSql", () => {
    it("generates a quoted SELECT with the default LIMIT 50", () => {
        expect(buildSelectSql(ref())).toBe('SELECT * FROM "public"."customers" LIMIT 50');
    });

    it("honours a custom limit", () => {
        expect(buildSelectSql(ref(), 10)).toBe('SELECT * FROM "public"."customers" LIMIT 10');
    });

    it("omits the LIMIT entirely when passed null (e.g. for EXPLAIN)", () => {
        expect(buildSelectSql(ref(), null)).toBe('SELECT * FROM "public"."customers"');
    });

    it("doubles embedded double-quotes in identifiers", () => {
        expect(buildSelectSql(ref({ schema: 'we"ird', name: 'ta"ble' })))
            .toBe('SELECT * FROM "we""ird"."ta""ble" LIMIT 50');
    });
});
