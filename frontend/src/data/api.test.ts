import { describe, it, expect, vi, afterEach } from "vitest";
import { getViewDefinition, runQuery } from "./api";
import type { DbObjectRef } from "../contract";

afterEach(() => vi.restoreAllMocks());

describe("getViewDefinition", () => {
    const ref: DbObjectRef = {
        connectionId: "default",
        database    : "sqladmin",
        schema      : "public",
        name        : "active_customers",
        kind        : "view",
    };

    it("GETs the view's definition endpoint and returns the parsed shape", async () => {
        const payload   = { definition: "SELECT id FROM customers WHERE active" };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
        vi.stubGlobal("fetch", fetchMock);

        const result = await getViewDefinition(ref);

        expect(result).toEqual(payload);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/sqladmin/public/active_customers/definition",
        );
    });

    it("throws the backend {detail} on a non-OK response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok        : false,
            status    : 404,
            statusText: "Not Found",
            json      : async () => ({ detail: "View 'public.active_customers' not found" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(getViewDefinition(ref)).rejects.toThrow("View 'public.active_customers' not found");
    });
});

describe("runQuery", () => {
    it("POSTs { sql } to the connection's query endpoint and returns the envelope", async () => {
        const envelope  = { kind: "rows", columns: [], rows: [], rowCount: 0 };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope });
        vi.stubGlobal("fetch", fetchMock);

        const result = await runQuery("default", "select 1");

        expect(result).toEqual(envelope);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/query",
            expect.objectContaining({
                method : "POST",
                headers: { "Content-Type": "application/json" },
                body   : JSON.stringify({ sql: "select 1" }),
            }),
        );
    });

    it("throws the backend {detail} on a non-OK response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok        : false,
            status    : 400,
            statusText: "Bad Request",
            json      : async () => ({ detail: 'syntax error at or near "slect"' }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(runQuery("default", "slect 1")).rejects.toThrow('syntax error at or near "slect"');
    });
});
