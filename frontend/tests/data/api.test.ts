import { describe, it, expect, vi, afterEach } from "vitest";
import {
    getViewDefinition, getStructure, getSchemaGraph, getDatabaseGraph, runExplain, runQuery, tableExportUrl,
    setCsrfToken, csrfHeader, executeDdl, apiPath, tableRowsUrl, getObjects, previewDropTable, previewImportRows,
    getRoleDetail, getSchemas, previewCreateTable, getDatabases, getRoles,
} from "../../src/data/api";
import type { DbObjectRef } from "../../src/contract";

afterEach(() => {
    vi.restoreAllMocks();
    setCsrfToken(null); // reset module-level token so header assertions stay isolated
});

describe("apiPath", () => {
    it("joins plain segments under /api/", () => {
        expect(apiPath("default", "shop", "public", "orders", "columns"))
            .toBe("/api/default/shop/public/orders/columns");
    });

    it("percent-encodes a slash inside a segment rather than splitting it", () => {
        expect(apiPath("default", "shop", "we/ird", "objects"))
            .toBe("/api/default/shop/we%2Fird/objects");
    });

    it("percent-encodes a hash inside a segment", () => {
        expect(apiPath("default", "shop", "a#b", "t", "structure"))
            .toBe("/api/default/shop/a%23b/t/structure");
    });

    it("percent-encodes a space inside a segment", () => {
        expect(apiPath("default", "my db", "public", "objects"))
            .toBe("/api/default/my%20db/public/objects");
    });

    it("renders an undefined segment as empty rather than the literal 'undefined'", () => {
        expect(apiPath("default", undefined, "public", "objects"))
            .toBe("/api/default//public/objects");
    });

    it("returns /api/ for no segments", () => {
        expect(apiPath()).toBe("/api/");
    });

    it("returns /api/login for a single segment", () => {
        expect(apiPath("login")).toBe("/api/login");
    });
});

describe("getObjects with a hostile schema name", () => {
    it("percent-encodes the schema segment rather than dropping the rest of the path", async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
        vi.stubGlobal("fetch", fetchMock);

        await getObjects("default", "shop", "we/ird");

        expect(fetchMock).toHaveBeenCalledWith("/api/default/db/shop/we%2Fird/objects");
    });
});

describe("getStructure with hostile schema and name", () => {
    it("percent-encodes both segments", async () => {
        const ref: DbObjectRef = {
            connectionId: "default",
            database    : "shop",
            schema      : "a#b",
            name        : "my table",
            kind        : "table",
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);

        await getStructure(ref);

        expect(fetchMock).toHaveBeenCalledWith("/api/default/db/shop/a%23b/my%20table/structure");
    });
});

describe("previewDropTable with a hostile database name", () => {
    it("percent-encodes the database segment", async () => {
        const ref: DbObjectRef = {
            connectionId: "default",
            database    : "my db",
            schema      : "public",
            name        : "orders",
            kind        : "table",
        };
        const spec      = { schema: "public", name: "orders" };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sql: "" }) });
        vi.stubGlobal("fetch", fetchMock);

        await previewDropTable(ref, spec as never);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/db/my%20db/ddl/table/drop",
            expect.objectContaining({ method: "POST" }),
        );
    });
});

describe("previewImportRows with a hostile table name", () => {
    it("percent-encodes the name segment", async () => {
        const ref: DbObjectRef = {
            connectionId: "default",
            database    : "shop",
            schema      : "public",
            name        : "od/d",
            kind        : "table",
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);

        await previewImportRows(ref, []);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/db/shop/public/od%2Fd/rows/import/preview",
            expect.objectContaining({ method: "POST" }),
        );
    });
});

describe("getRoleDetail with a hostile role name", () => {
    it("percent-encodes the role segment", async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);

        await getRoleDetail("default", "role/x");

        expect(fetchMock).toHaveBeenCalledWith("/api/default/roles/role%2Fx");
    });
});

describe("tableRowsUrl", () => {
    it("percent-encodes the name segment and ends in /rows", () => {
        const ref: DbObjectRef = {
            connectionId: "default",
            database    : "shop",
            schema      : "public",
            name        : "my table",
            kind        : "table",
        };

        expect(tableRowsUrl(ref)).toBe("/api/default/db/shop/public/my%20table/rows");
    });
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
            "/api/default/db/sqladmin/public/active_customers/definition",
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
        expect(fetchMock).toHaveBeenCalledWith("/api/default/db/sqladmin/public/customers/structure");
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

describe("getSchemaGraph", () => {
    const ref: DbObjectRef = {
        connectionId: "default",
        database    : "sqladmin",
        schema      : "public",
        kind        : "schema",
    };

    it("GETs the schema's /graph endpoint and returns the parsed envelope", async () => {
        const graph = {
            tables: [
                {
                    name     : "customers",
                    structure: { indexes: [], constraints: [], foreignKeys: [] },
                    columns  : [{
                        name: "id", dataType: "integer", nullable: false, isPrimaryKey: true,
                        isGenerated: true, hasDefault: true, wireType: "number", sequence: null,
                    }],
                },
            ],
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => graph });
        vi.stubGlobal("fetch", fetchMock);

        const result = await getSchemaGraph(ref);

        expect(result).toEqual(graph);
        expect(fetchMock).toHaveBeenCalledWith("/api/default/db/sqladmin/public/graph");
    });

    it("throws the backend {detail} on a non-OK response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok        : false,
            status    : 500,
            statusText: "Internal Server Error",
            json      : async () => ({ detail: "boom" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(getSchemaGraph(ref)).rejects.toThrow("boom");
    });
});

describe("getDatabaseGraph", () => {
    const ref: DbObjectRef = {
        connectionId: "default",
        database    : "sqladmin",
        kind        : "database",
    };

    it("GETs the database's /graph endpoint and returns the parsed envelope", async () => {
        const graph = {
            schemas: [
                {
                    schema: "public",
                    tables: [{ name: "customers", structure: { indexes: [], constraints: [], foreignKeys: [] } }],
                },
            ],
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => graph });
        vi.stubGlobal("fetch", fetchMock);

        const result = await getDatabaseGraph(ref);

        expect(result).toEqual(graph);
        expect(fetchMock).toHaveBeenCalledWith("/api/default/db/sqladmin/graph");
    });

    it("throws the backend {detail} on a non-OK response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok        : false,
            status    : 500,
            statusText: "Internal Server Error",
            json      : async () => ({ detail: "boom" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(getDatabaseGraph(ref)).rejects.toThrow("boom");
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
            .toBe("/api/default/db/sqladmin/public/customers/export?format=csv");
        expect(tableExportUrl(ref, "json"))
            .toBe("/api/default/db/sqladmin/public/customers/export?format=json");
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
            .toBe("/api/default/db/sqladmin/public/my%20table/export?format=csv");
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
    it("POSTs { sql, analyze, format, verbose } to the explain endpoint and returns the envelope", async () => {
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
                body   : JSON.stringify({ sql: "select 1", analyze: false, format: "text", verbose: false }),
            }),
        );
    });

    it("forwards verbose:true when requested", async () => {
        const envelope  = { kind: "explain", format: "json", analyze: false, plan: "", planJson: [] };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope });
        vi.stubGlobal("fetch", fetchMock);

        await runExplain("default", "select 1", { analyze: false, format: "json", verbose: true });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/explain",
            expect.objectContaining({
                body: JSON.stringify({ sql: "select 1", analyze: false, format: "json", verbose: true }),
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

describe("executeDdl", () => {
    it("POSTs { sql } to the connection's DDL execute endpoint and returns the envelope", async () => {
        const envelope  = { kind: "status", command: "CREATE TABLE", rowCount: 0 };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => envelope });
        vi.stubGlobal("fetch", fetchMock);

        const result = await executeDdl("default", "CREATE TABLE t (id int)");

        expect(result).toEqual(envelope);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/ddl/execute",
            expect.objectContaining({
                method : "POST",
                headers: { "Content-Type": "application/json" },
                body   : JSON.stringify({ sql: "CREATE TABLE t (id int)" }),
            }),
        );
    });

    it("throws the backend {detail} on a non-OK response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok        : false,
            status    : 400,
            statusText: "Bad Request",
            json      : async () => ({ detail: "syntax error at or near \"CRATE\"" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(executeDdl("default", "CRATE TABLE t (id int)"))
            .rejects.toThrow('syntax error at or near "CRATE"');
    });
});

describe("database-scoped builders carry the /db/ segment", () => {
    it("getSchemas fetches /api/{connectionId}/db/{database}/schemas", async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
        vi.stubGlobal("fetch", fetchMock);

        await getSchemas("default", "shop");

        expect(fetchMock).toHaveBeenCalledWith("/api/default/db/shop/schemas");
    });

    it("previewCreateTable posts to /api/{connectionId}/db/{database}/ddl/table/create", async () => {
        const ref: DbObjectRef = {
            connectionId: "default",
            database    : "shop",
            schema      : "public",
            name        : "orders",
            kind        : "table",
        };
        const spec      = { schema: "public", name: "orders", columns: [] };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sql: "" }) });
        vi.stubGlobal("fetch", fetchMock);

        await previewCreateTable(ref, spec as never);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/db/shop/ddl/table/create",
            expect.objectContaining({ method: "POST" }),
        );
    });

    it("previewImportRows posts to /api/{connectionId}/db/{database}/{schema}/{name}/rows/import/preview", async () => {
        const ref: DbObjectRef = {
            connectionId: "default",
            database    : "shop",
            schema      : "public",
            name        : "orders",
            kind        : "table",
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);

        await previewImportRows(ref, []);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/default/db/shop/public/orders/rows/import/preview",
            expect.objectContaining({ method: "POST" }),
        );
    });
});

describe("connection-scoped builders are unchanged by the /db/ segment", () => {
    it("runQuery, runExplain, and executeDdl stay directly under the connection", async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);

        await runQuery("default", "select 1");
        await runExplain("default", "select 1", { analyze: false, format: "text" });
        await executeDdl("default", "CREATE TABLE t (id int)");

        expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/default/query", expect.anything());
        expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/default/explain", expect.anything());
        expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/default/ddl/execute", expect.anything());
    });

    it("getDatabases, getRoles, and getRoleDetail stay directly under the connection", async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
        vi.stubGlobal("fetch", fetchMock);

        await getDatabases("default");
        await getRoles("default");
        await getRoleDetail("default", "schemas");

        expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/default/databases");
        expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/default/roles");
        expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/default/roles/schemas");
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
