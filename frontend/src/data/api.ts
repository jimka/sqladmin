// Introspection data path: a plain typed fetch client that reads the backend's
// error body ({detail}) directly and returns contract types. It does NOT go
// through the proxy/store (that is the row-CRUD path; see stores.ts).

import type {
    AlterTableSpec,
    ColumnMeta,
    ConstraintSpec,
    CreateTableSpec,
    DdlPreview,
    DropTableSpec,
    IndexSpec,
    TablePrivileges,
    ConnectionPreset,
    DbObjectKind,
    DbObjectRef,
    QueryExplainResult,
    QueryResult,
    QueryStatusResult,
    RelationEdge,
    RoleDetail,
    RoleSummary,
    ViewDefinition,
    TableStructure,
} from "../contract";
import type { ExplainOptions } from "./explain";

// The CSRF synchronizer token for the authenticated session. Set from the
// login/whoami response, held only in memory, and echoed as an `X-CSRF-Token`
// header on mutating requests. `null` until authenticated.
let _csrfToken: string | null = null;

/** Store (or clear, with `null`) the session's CSRF token after login/whoami. */
export function setCsrfToken(token: string | null): void {
    _csrfToken = token;
}

/**
 * The CSRF header to merge into a mutating request — `{ "X-CSRF-Token": token }`
 * when authenticated, else `{}` (never a null-valued key, so an unauthenticated
 * request's headers stay exactly what the caller set).
 */
export function csrfHeader(): Record<string, string> {
    return _csrfToken ? { "X-CSRF-Token": _csrfToken } : {};
}

/** Credentials a login submits (password used once, never stored by us). */
export interface LoginDetails {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    connectionId?: string;
}

/** The authenticated session's public fields (no password). */
export interface Session {
    connectionId: string;
    csrfToken: string;
    username: string;
    database: string;
}

/** The pre-auth app config that populates the login screen. */
export interface AppConfig {
    presets: ConnectionPreset[]; // admin-defined server presets
    allowUserPresets: boolean;   // gates the user's own localStorage presets
}

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
        headers: { "Content-Type": "application/json", ...csrfHeader() },
        body   : JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(await readDetail(response));
    }

    return (await response.json()) as T;
}

/** Authenticate against the target database; resolves the session on success. */
export function login(details: LoginDetails): Promise<Session> {
    return postJson<Session>("/api/login", details);
}

/** Drop the server-side session and clear the cookie (does not parse the 204). */
export async function logout(): Promise<void> {
    await fetch("/api/logout", { method: "POST" });
}

/** Recover the current session on load, or `null` when unauthenticated (401). */
export async function whoami(): Promise<Session | null> {
    const response = await fetch("/api/whoami");

    if (response.status === 401) {
        return null;
    }

    if (!response.ok) {
        throw new Error(await readDetail(response));
    }

    return (await response.json()) as Session;
}

/** The pre-auth app config (server presets + allowUserPresets), for the login screen. */
export function getConfig(): Promise<AppConfig> {
    return getJson<AppConfig>("/api/config");
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

/** View/matview dependency edges for a schema (view -> underlying relation). */
export function getDependencies(
    connectionId: string,
    database    : string,
    schema      : string,
): Promise<RelationEdge[]> {
    return getJson(`/api/${connectionId}/${database}/${schema}/dependencies`);
}

/** Inheritance/partition edges for a schema (parent -> child). */
export function getInheritance(
    connectionId: string,
    database    : string,
    schema      : string,
): Promise<RelationEdge[]> {
    return getJson(`/api/${connectionId}/${database}/${schema}/inheritance`);
}

/** Introspect a table's columns (drives the Model + data grid). */
export function getColumns(ref: DbObjectRef): Promise<ColumnMeta[]> {
    const url = `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/columns`;

    return getJson<ColumnMeta[]>(url);
}

/** The connected user's INSERT/UPDATE/DELETE/SELECT rights on a table. */
export function getTablePrivileges(ref: DbObjectRef): Promise<TablePrivileges> {
    const url = `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/privileges`;

    return getJson<TablePrivileges>(url);
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

/**
 * Run EXPLAIN / EXPLAIN ANALYZE for one statement and return its plan envelope.
 * A sibling of {@link runQuery} on the dedicated `/explain` route: the backend
 * rolls ANALYZE's execution back, so this never commits a side-effect.
 *
 * @param connectionId - The target connection.
 * @param sql - The statement to explain (the raw user SQL, unprefixed).
 * @param opts - Whether to ANALYZE and which output format to request.
 * @returns The explain result (joined plan text for the FORMAT TEXT cut).
 */
export function runExplain(
    connectionId: string,
    sql         : string,
    opts        : ExplainOptions,
): Promise<QueryExplainResult> {
    return postJson<QueryExplainResult>(`/api/${connectionId}/explain`, {
        sql,
        analyze: opts.analyze,
        format : opts.format,
    });
}

/**
 * Run a final (possibly user-edited) DDL statement — the single execute call
 * every `SqlPreviewDialog` confirm reuses, regardless of which phase's form
 * built the SQL. The previewed string is authoritative: this sends it
 * verbatim, never a spec re-compiled at execute time.
 *
 * A phase adds its own preview client method alongside this one, following
 * the pattern (no preview method ships in this infra module):
 * ```ts
 * export function previewCreateTable(ref: DbObjectRef, spec: CreateTableSpec): Promise<DdlPreview> {
 *     return postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/create-table`, spec);
 * }
 * ```
 *
 * @param connectionId - The target connection.
 * @param sql - The final DDL text to execute (exactly one statement).
 * @returns The status envelope (`{kind: "status", command, rowCount}`).
 */
export function executeDdl(connectionId: string, sql: string): Promise<QueryStatusResult> {
    return postJson<QueryStatusResult>(`/api/${connectionId}/ddl/execute`, { sql });
}

/** Preview a CREATE TABLE statement (table-ddl phase). */
export function previewCreateTable(ref: DbObjectRef, spec: CreateTableSpec): Promise<DdlPreview> {
    return postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/table/create`, spec);
}

/** Preview a DROP TABLE statement (table-ddl phase). */
export function previewDropTable(ref: DbObjectRef, spec: DropTableSpec): Promise<DdlPreview> {
    return postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/table/drop`, spec);
}

/** Preview one ALTER TABLE column/table-rename statement (table-ddl phase). */
export function previewAlterTable(ref: DbObjectRef, spec: AlterTableSpec): Promise<DdlPreview> {
    return postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/table/alter`, spec);
}

/** Preview one constraint add/drop statement (table-ddl phase). */
export function previewConstraint(ref: DbObjectRef, spec: ConstraintSpec): Promise<DdlPreview> {
    return postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/table/constraint`, spec);
}

/** Preview one index create/drop statement (table-ddl phase). */
export function previewIndex(ref: DbObjectRef, spec: IndexSpec): Promise<DdlPreview> {
    return postJson<DdlPreview>(`/api/${ref.connectionId}/${ref.database}/ddl/table/index`, spec);
}

/** The Roles view's role list (introspection one-shot). */
export function getRoles(connectionId: string): Promise<RoleSummary[]> {
    return getJson<RoleSummary[]>(`/api/${connectionId}/roles`);
}

/** One role's combined attributes, memberships, and table privileges. */
export function getRoleDetail(connectionId: string, role: string): Promise<RoleDetail> {
    return getJson<RoleDetail>(`/api/${connectionId}/roles/${encodeURIComponent(role)}`);
}
