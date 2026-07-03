// Introspection data path: a plain typed fetch client that reads the backend's
// error body ({detail}) directly and returns contract types. It does NOT go
// through the proxy/store (that is the row-CRUD path; see stores.ts).

import type {
    ColumnMeta,
    DbObjectKind,
    DbObjectRef,
    QueryResult,
    RoleDetail,
    RoleSummary,
    ViewDefinition,
    TableStructure,
} from "../contract";

/** Pull the backend's `{detail}` error message off a non-OK response. */
async function readDetail(response: Response): Promise<string> {
    try {
        const body = await response.json();

        if (body && typeof body.detail === "string") {
            return body.detail;
        }
    } catch {
        // Body was not JSON; fall through to the status line.
    }

    return `${response.status} ${response.statusText}`;
}

/** Fetch JSON from `url`, throwing the backend's detail message on failure. */
async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(await readDetail(response));
    }

    return (await response.json()) as T;
}

/** POST `body` as JSON to `url`, throwing the backend's detail on failure. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
        method : "POST",
        headers: { "Content-Type": "application/json" },
        body   : JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(await readDetail(response));
    }

    return (await response.json()) as T;
}

/** The navigator's database level. */
export function getDatabases(connectionId: string): Promise<{ name: string }[]> {
    return getJson(`/api/${connectionId}/databases`);
}

/** The navigator's schema level. */
export function getSchemas(connectionId: string, database: string): Promise<{ name: string }[]> {
    return getJson(`/api/${connectionId}/${database}/schemas`);
}

/** The navigator's table/view level. */
export function getObjects(
    connectionId: string,
    database    : string,
    schema      : string,
): Promise<{ name: string; kind: DbObjectKind }[]> {
    return getJson(`/api/${connectionId}/${database}/${schema}/objects`);
}

/** Introspect a table's columns (drives the Model + data grid). */
export function getColumns(ref: DbObjectRef): Promise<ColumnMeta[]> {
    const url = `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/columns`;

    return getJson<ColumnMeta[]>(url);
}

/** Fetch a (materialized) view's definition SQL (pg_get_viewdef). */
export function getViewDefinition(ref: DbObjectRef): Promise<ViewDefinition> {
    const url = `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/definition`;

    return getJson<ViewDefinition>(url);
}

/** Fetch a table's indexes, constraints, and foreign keys in one round trip. */
export function getStructure(ref: DbObjectRef): Promise<TableStructure> {
    const url = `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/structure`;

    return getJson<TableStructure>(url);
}

/**
 * Run one arbitrary SQL statement — the query panel's one-shot data path. Unlike
 * row CRUD (an AjaxStore), an arbitrary result has no PK or collection URL, so it
 * goes through this typed fetch and loads into a MemoryStore.
 */
export function runQuery(connectionId: string, sql: string): Promise<QueryResult> {
    return postJson<QueryResult>(`/api/${connectionId}/query`, { sql });
}

/**
 * Build the URL of the backend streaming full-table export for a table/view. No
 * fetch happens here: the caller navigates the browser to this URL so the
 * `Content-Disposition: attachment` response downloads the streamed body
 * directly, without ever buffering the whole relation in memory.
 *
 * @param ref - The table/view to export (its connection/database/schema/name).
 * @param format - The export format ("csv" or "json").
 *
 * @returns The `/…/export?format=…` URL to navigate to.
 */
export function tableExportUrl(ref: DbObjectRef, format: "csv" | "json"): string {
    const seg = (s: string): string => encodeURIComponent(s);
    const path = `${seg(ref.connectionId)}/${seg(ref.database ?? "")}/${seg(ref.schema ?? "")}/${seg(ref.name ?? "")}`;

    return `/api/${path}/export?format=${format}`;
}

/** The Roles view's role list (introspection one-shot). */
export function getRoles(connectionId: string): Promise<RoleSummary[]> {
    return getJson<RoleSummary[]>(`/api/${connectionId}/roles`);
}

/** One role's combined attributes, memberships, and table privileges. */
export function getRoleDetail(connectionId: string, role: string): Promise<RoleDetail> {
    return getJson<RoleDetail>(`/api/${connectionId}/roles/${encodeURIComponent(role)}`);
}
