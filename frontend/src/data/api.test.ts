import { describe, it, expect, vi, afterEach } from "vitest";
import {
    getViewDefinition, getStructure, runExplain, runQuery, tableExportUrl,
    setCsrfToken, csrfHeader,
} from "./api";
import type { DbObjectRef } from "../contract";

afterEach(() => {
    vi.restoreAllMocks();
    setCsrfToken(null); // reset module-level token so header assertions stay isolated
});

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

describe("getStructure", () => {
    const ref: DbObjectRef = {
        connectionId: "default",
        database    : "sqladmin",
        schema      : "public",
        name        : "customers",
        kind        : "table",
    };

    it("GETs the table's /structure endpoint and returns the parsed payload", async () => {
        const structure = {
            indexes    : [{ name: "customers_pkey", definition: "CREATE UNIQUE INDEX …", unique: true, primary: true }],
            constraints: [{ name: "customers_pkey", type: "primaryKey", columns: ["id"], definition: "PRIMARY KEY (id)" }],
            foreignKeys: [],
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => structure });
        vi.stubGlobal("fetch", fetchMock);

        const result = await getStructure(ref);

        expect(result).toEqual(structure);
        expect(fetchMock).toHaveBeenCalledWith("/api/default/sqladmin/public/customers/structure");
    });

    it("throws the backend {detail} on a non-OK response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok        : false,
            status    : 500,
            statusText: "Internal Server Error",
            json      : async () => ({ detail: "boom" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(getStructure(ref)).rejects.toThrow("boom");
    });
});

describe("tableExportUrl", () => {
    it("builds the streaming-export URL with the format query param", () => {
        const ref: DbObjectRef = {
            connectionId: "default",
            database    : "sqladmin",
            schema      : "public",
            name        : "customers",
            kind        : "table",
        };

        expect(tableExportUrl(ref, "csv"))
            .toBe("/api/default/sqladmin/public/customers/export?format=csv");
        expect(tableExportUrl(ref, "json"))
            .toBe("/api/default/sqladmin/public/customers/export?format=json");
    });

    it("percent-encodes path segments so odd identifiers stay well-formed", () => {
        const ref: DbObjectRef = {
            connectionId: "default",
            database    : "sqladmin",
            schema      : "public",
            name        : "my table",
            kind        : "view",
        };

        expect(tableExportUrl(ref, "csv"))
            .toBe("/api/default/sqladmin/public/my%20table/export?format=csv");
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

describe("runExplain", () => {
    it("POSTs { sql, analyze, format } to the explain endpoint and returns the envelope", async () => {
        const envelope  = { kind: "explain", format: "text", analyze: false, plan: "Seq Scan" };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope });
        vi.stubGlobal("fetch", fetchMock);

        const result = await runExplain("default", "select 1", { analyze: false, format: "text" });

        expect(result).toEqual(envelope);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/explain",
            expect.objectContaining({
                method : "POST",
                headers: { "Content-Type": "application/json" },
                body   : JSON.stringify({ sql: "select 1", analyze: false, format: "text" }),
            }),
        );
    });

    it("throws the backend {detail} on a non-OK response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok        : false,
            status    : 400,
            statusText: "Bad Request",
            json      : async () => ({ detail: "syntax error" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(runExplain("default", "slect 1", { analyze: true, format: "text" }))
            .rejects.toThrow("syntax error");
    });
});

describe("csrfHeader / setCsrfToken", () => {
    it("returns {} when no token is set (so postJson sends only Content-Type)", () => {
        expect(csrfHeader()).toEqual({});
    });

    it("adds X-CSRF-Token to a mutating request once a token is set", async () => {
        setCsrfToken("tok-123");
        const envelope  = { kind: "status", command: "SELECT", rowCount: 0 };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope });
        vi.stubGlobal("fetch", fetchMock);

        await runQuery("default", "select 1");

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/query",
            expect.objectContaining({
                headers: { "Content-Type": "application/json", "X-CSRF-Token": "tok-123" },
            }),
        );
    });
});
