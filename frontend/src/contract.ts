// The wire contract, mirrored on the TS side. Matches the backend's WireType
// scalar set and introspection/list shapes (see backend/app/contract.py).

export type DbObjectKind = "database" | "schema" | "table" | "view" | "materializedView";

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

/**
 * The connected user's effective rights on a table (membership-aware, from
 * `has_table_privilege`). Drives the table editor's Add/Delete/Save gating and
 * cell editability.
 */
export interface TablePrivileges {
    select: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
}

/** A (materialized) view's reconstructed SELECT (pg_get_viewdef). */
export interface ViewDefinition {
    definition: string; // the pretty-printed pg_get_viewdef(oid, true) SQL
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
    /** True when the result exceeded the backend cap and only `rows` (the first N) are returned. */
    truncated: boolean;
}

/** A query that returned no result set (INSERT/UPDATE/DDL). */
export interface QueryStatusResult {
    kind: "status";
    command: string; // the backend's command tag, e.g. "INSERT 0 3"
    rowCount: number;
}

/** A DDL preview endpoint's response: the generated SQL to show in the editable
 *  preview before the user confirms and executes it. */
export interface DdlPreview {
    sql: string;
}

/** One column definition collected by a create-table/add-column form. */
export interface ColumnSpec {
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
    primaryKey: boolean;
}

/** The spec a CREATE TABLE preview/execute call sends. */
export interface CreateTableSpec {
    schema: string;
    name: string;
    columns: ColumnSpec[];
    ifNotExists?: boolean;
}

/** The spec a DROP TABLE preview/execute call sends. */
export interface DropTableSpec {
    schema: string;
    name: string;
    cascade?: boolean;
    ifExists?: boolean;
}

/** The ALTER-column actions the StructurePanel's "Alter column" menu offers. */
export type AlterColumnAction =
    | "renameColumn"
    | "changeType"
    | "setNotNull"
    | "dropNotNull"
    | "setDefault"
    | "dropDefault";

/**
 * An action-tagged ALTER TABLE spec; which of the optional fields are set
 * depends on `action` (see the table-ddl plan's PreviewAlterTable dispatch).
 */
export interface AlterTableSpec {
    schema: string;
    name: string;
    action: AlterColumnAction | "addColumn" | "dropColumn" | "renameTable";
    column?: string;
    newName?: string;
    newType?: string;
    using?: string;
    default?: string;
    cascade?: boolean;
    columnDef?: ColumnSpec;
}

/** The constraint kinds the "Add constraint" launcher offers. */
export type ConstraintKind = "primaryKey" | "unique" | "check" | "foreignKey";

/** An action-tagged constraint add/drop spec; fields present depend on `action`. */
export interface ConstraintSpec {
    schema: string;
    name: string;
    action: "addPrimaryKey" | "addUnique" | "addCheck" | "addForeignKey" | "drop";
    columns?: string[];
    expression?: string;
    constraintName?: string;
    refSchema?: string;
    refTable?: string;
    refColumns?: string[];
    onUpdate?: string;
    onDelete?: string;
    cascade?: boolean;
}

/** An action-tagged index create/drop spec; fields present depend on `action`. */
export interface IndexSpec {
    schema: string;
    action: "create" | "drop";
    table?: string;
    name?: string;
    columns?: string[];
    unique?: boolean;
    method?: string;
    indexName?: string;
    cascade?: boolean;
    ifExists?: boolean;
}

/** EXPLAIN output format. TEXT is the first cut; JSON is the follow-on tree source. */
export type ExplainFormat = "text" | "json";

/** The result of an EXPLAIN / EXPLAIN ANALYZE run. */
export interface QueryExplainResult {
    kind: "explain";
    format: ExplainFormat;
    analyze: boolean;
    /** FORMAT TEXT: the joined plan text (one plan line per source row). */
    plan: string;
    /** FORMAT JSON: the raw parsed plan tree (follow-on; omitted in the text cut). */
    planJson?: unknown;
}

/** The result of running one arbitrary SQL statement. */
export type QueryResult = QueryRowsResult | QueryStatusResult | QueryExplainResult;

/** One PostgreSQL role (user or group), with its pg_roles attribute flags. */
export interface RoleSummary {
    name: string; // rolname
    canLogin: boolean; // rolcanlogin (a "user" can log in; a "group" cannot)
    isSuperuser: boolean; // rolsuper
    inherit: boolean; // rolinherit
    createRole: boolean; // rolcreaterole
    createDb: boolean; // rolcreatedb
    replication: boolean; // rolreplication
    connectionLimit: number; // rolconnlimit; -1 means "no limit"
    validUntil: string | null; // rolvaliduntil as ISO-8601, or null for no expiry
}

/** One membership edge: this role is a member of `roleName`. */
export interface RoleMembership {
    roleName: string; // the granting/parent role
    admin: boolean; // admin_option on the membership
}

/** One table privilege held by a role. */
export interface RolePrivilege {
    schema: string;
    table: string;
    privilege: string; // SELECT / INSERT / ...
    grantable: boolean; // is_grantable
}

/** The combined per-role detail the detail endpoint returns. */
export interface RoleDetail {
    role: RoleSummary;
    memberOf: RoleMembership[]; // roles this role belongs to
    privileges: RolePrivilege[]; // table grants held by this role
}

/** One index on a table (from pg_indexes / pg_index). */
export interface IndexMeta {
    name: string; // indexname
    definition: string; // full CREATE INDEX … text (indexdef)
    unique: boolean;
    primary: boolean; // backs the primary key
}

/** One non-FK constraint (primary key / unique / check). */
export interface ConstraintMeta {
    name: string;
    type: "primaryKey" | "unique" | "check";
    columns: string[]; // constrained columns (empty for a table-level check)
    definition: string; // pg_get_constraintdef(oid) — the reconstructed clause
}

/** One foreign key, with its referenced relation and referential actions. */
export interface ForeignKeyMeta {
    name: string;
    columns: string[]; // local FK columns, in key order
    refSchema: string;
    refTable: string;
    refColumns: string[]; // referenced columns, positionally paired with `columns`
    onUpdate: string; // "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT"
    onDelete: string; // same set
}

/** The combined structure payload the /structure route returns. */
export interface TableStructure {
    indexes: IndexMeta[];
    constraints: ConstraintMeta[];
    foreignKeys: ForeignKeyMeta[];
}

/** One relation in a dependency / inheritance graph, schema-qualified. `kind`
 *  is the collapsed contract kind (partitioned/foreign tables arrive as "table"). */
export interface RelationNodeRef {
    schema: string;
    name: string;
    kind: DbObjectKind;
}

/** One directed relation edge: dependency (view -> underlying) or inheritance
 *  (parent -> child). Orientation is fixed by the endpoint. */
export interface RelationEdge {
    source: RelationNodeRef;
    target: RelationNodeRef;
}

/**
 * A named connection target picked at login. Carries host/port/database ONLY —
 * never a username or password (credentials are per-login, handled by the
 * browser's own password manager). Shared by server presets (from the pre-auth
 * `/api/config`) and the user's own localStorage presets.
 */
export interface ConnectionPreset {
    name: string;
    host: string;
    port: number;
    database: string;
}
