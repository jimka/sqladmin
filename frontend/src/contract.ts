// The wire contract, mirrored on the TS side. Matches the backend's WireType
// scalar set and introspection/list shapes (see backend/app/contract.py).

export type DbObjectKind = "database" | "schema" | "table" | "view";

/** Identifies a database object the navigator can act on. */
export interface DbObjectRef {
    connectionId: string; // "default" in Phase 0-1; the multi-DB seam
    database?: string;
    schema?: string;
    name?: string; // table/view name
    kind: DbObjectKind;
}

/**
 * The fixed contract scalar set the backend emits (never raw Postgres types).
 * The frontend Model/Field types mirror this set.
 */
export type WireType =
    | "number"
    | "string"
    | "boolean"
    | "isoString"
    | "json"
    | "base64"
    | "jsonArray";

/** One column's introspected metadata (drives Model + column generation). */
export interface ColumnMeta {
    name: string;
    dataType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    isGenerated: boolean;
    hasDefault: boolean; // has a column default; not user-required on insert
    wireType: WireType;
}

/** The list endpoint envelope the configured JsonReader parses. */
export interface TableListEnvelope {
    rows: Record<string, unknown>[];
    totalCount: number;
}

/** One result column from an arbitrary query (name + inferred wire scalar). */
export interface QueryColumnMeta {
    name: string;
    wireType: WireType;
}

/** A query that returned a result set (any SELECT / RETURNING). */
export interface QueryRowsResult {
    kind: "rows";
    columns: QueryColumnMeta[];
    rows: Record<string, unknown>[];
    rowCount: number;
}

/** A query that returned no result set (INSERT/UPDATE/DDL). */
export interface QueryStatusResult {
    kind: "status";
    command: string; // the backend's command tag, e.g. "INSERT 0 3"
    rowCount: number;
}

/** The result of running one arbitrary SQL statement. */
export type QueryResult = QueryRowsResult | QueryStatusResult;
