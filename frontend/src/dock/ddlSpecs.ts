// Pure spec-assembly helpers for the table-DDL dialog forms: translate a
// form's collected rows/fields into the wire spec the matching preview
// client sends. Kept DOM-free (see memory "tsui DOM module side effects") so
// vitest (node-only) can pin them; each form (CreateTableForm,
// AlterColumnForm, ConstraintForm, IndexForm, ColumnChecklist) is a thin
// collector that hands its inputs to one of these.

import type {
    AlterColumnAction,
    AlterTableSpec,
    ColumnSpec,
    ConstraintSpec,
    CreateTableSpec,
    IndexSpec,
} from "../contract";

/** One column row collected by the CreateTableForm grid. */
export interface ColumnRow {
    name: string;
    type: string;
    nullable: boolean;
    default: string; // "" means "no default" (mapped to null in the spec)
    primaryKey: boolean;
}

/**
 * Translate the create-table form's rows into a CreateTableSpec: blank-name
 * rows are dropped (an in-progress row the user hasn't finished), and an
 * empty default string is carried as `null` (the wire contract's "no
 * default" value, matching `_column_clause`'s `if default:` check).
 *
 * @param schema - the new table's schema.
 * @param name - the new table's name.
 * @param rows - the grid's current rows, in entry order.
 * @param ifNotExists - whether to emit `IF NOT EXISTS`; omitted when false.
 * @returns the spec `previewCreateTable` sends.
 */
export function buildCreateTableSpec(
    schema: string,
    name: string,
    rows: ColumnRow[],
    ifNotExists?: boolean,
): CreateTableSpec {
    const columns: ColumnSpec[] = rows
        .filter(row => row.name.trim() !== "")
        .map(row => ({
            name: row.name,
            type: row.type,
            nullable: row.nullable,
            default: row.default.trim() === "" ? null : row.default,
            primaryKey: row.primaryKey,
        }));

    return { schema, name, columns, ...(ifNotExists ? { ifNotExists: true } : {}) };
}

/** The fields an ALTER TABLE action may carry; which ones apply depends on `action`. */
export interface AlterTableFields {
    column?: string;
    newName?: string;
    newType?: string;
    using?: string;
    default?: string;
    cascade?: boolean;
    columnDef?: ColumnSpec;
}

/**
 * Translate one ALTER TABLE gesture into its action-tagged spec, carrying
 * only the fields that action needs — mirroring the backend's
 * `PreviewAlterTable.build()` dispatch, so the two stay obviously in sync.
 *
 * @param schema - the table's schema.
 * @param name - the table's name.
 * @param action - the ALTER action the launcher is running.
 * @param fields - the action's collected fields (unused ones are ignored).
 * @returns the spec `previewAlterTable` sends.
 */
export function buildAlterTableSpec(
    schema: string,
    name: string,
    action: AlterColumnAction | "addColumn" | "dropColumn" | "renameTable",
    fields: AlterTableFields,
): AlterTableSpec {
    const base = { schema, name, action };

    switch (action) {
        case "addColumn":
            return { ...base, columnDef: fields.columnDef };
        case "dropColumn":
            return { ...base, column: fields.column, ...(fields.cascade ? { cascade: true } : {}) };
        case "renameColumn":
            return { ...base, column: fields.column, newName: fields.newName };
        case "changeType":
            return { ...base, column: fields.column, newType: fields.newType, ...(fields.using ? { using: fields.using } : {}) };
        case "setNotNull":
        case "dropNotNull":
        case "dropDefault":
            return { ...base, column: fields.column };
        case "setDefault":
            return { ...base, column: fields.column, default: fields.default };
        case "renameTable":
            return { ...base, newName: fields.newName };
    }
}

/** The fields a constraint action may carry; which ones apply depends on `action`. */
export interface ConstraintFields {
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

/**
 * Translate one constraint add/drop gesture into its action-tagged spec,
 * carrying only the fields that action needs — mirroring the backend's
 * `PreviewConstraint.build()` dispatch.
 *
 * @param schema - the table's schema.
 * @param name - the table's name.
 * @param action - the constraint action the launcher is running.
 * @param fields - the action's collected fields (unused ones are ignored).
 * @returns the spec `previewConstraint` sends.
 */
export function buildConstraintSpec(
    schema: string,
    name: string,
    action: ConstraintSpec["action"],
    fields: ConstraintFields,
): ConstraintSpec {
    const base = { schema, name, action };
    const named = fields.constraintName ? { constraintName: fields.constraintName } : {};

    switch (action) {
        case "addPrimaryKey":
        case "addUnique":
            return { ...base, columns: fields.columns, ...named };
        case "addCheck":
            return { ...base, expression: fields.expression, ...named };
        case "addForeignKey":
            return {
                ...base,
                columns: fields.columns,
                refSchema: fields.refSchema,
                refTable: fields.refTable,
                refColumns: fields.refColumns,
                ...named,
                ...(fields.onUpdate ? { onUpdate: fields.onUpdate } : {}),
                ...(fields.onDelete ? { onDelete: fields.onDelete } : {}),
            };
        case "drop":
            return { ...base, constraintName: fields.constraintName, ...(fields.cascade ? { cascade: true } : {}) };
    }
}

/** The fields an index action may carry; which ones apply depends on `action`. */
export interface IndexFields {
    table?: string;
    columns?: string[];
    name?: string;
    unique?: boolean;
    method?: string;
    indexName?: string;
    cascade?: boolean;
    ifExists?: boolean;
}

/**
 * Translate one index create/drop gesture into its action-tagged spec,
 * carrying only the fields that action needs — mirroring the backend's
 * `PreviewIndex.build()` dispatch.
 *
 * @param schema - the index's schema.
 * @param action - "create" or "drop".
 * @param fields - the action's collected fields (unused ones are ignored).
 * @returns the spec `previewIndex` sends.
 */
export function buildIndexSpec(schema: string, action: IndexSpec["action"], fields: IndexFields): IndexSpec {
    const base = { schema, action };

    if (action === "create") {
        return {
            ...base,
            table: fields.table,
            columns: fields.columns,
            ...(fields.name ? { name: fields.name } : {}),
            ...(fields.unique ? { unique: true } : {}),
            ...(fields.method ? { method: fields.method } : {}),
        };
    }

    return {
        ...base,
        indexName: fields.indexName,
        ...(fields.cascade ? { cascade: true } : {}),
        ...(fields.ifExists ? { ifExists: true } : {}),
    };
}

/**
 * Order a set of selected column names by the table's own introspected
 * column order (not the order they were checked in) — the deterministic
 * ordering PK/unique/FK/index specs need, since column order is
 * semantically significant to Postgres. Backs
 * `ColumnChecklist.readSelected()`.
 *
 * @param allColumns - the table's columns, in their introspected order.
 * @param selected - the checked column names, as a Set or plain array.
 * @returns the selected names, in `allColumns`' order.
 */
export function orderColumnsBySelection(allColumns: string[], selected: ReadonlySet<string> | string[]): string[] {
    const selectedSet = selected instanceof Set ? selected : new Set(selected);

    return allColumns.filter(c => selectedSet.has(c));
}

/**
 * Parse a comma-separated column list (the FK form's ref-columns TextField —
 * see plans/implemented/table-ddl.md's "FK ref-column entry" mitigation),
 * trimming whitespace and dropping empty entries.
 *
 * @param text - the raw comma-separated text, e.g. `"id, tenant_id"`.
 * @returns the column names, trimmed, in entry order.
 */
export function parseColumnList(text: string): string[] {
    return text.split(",").map(s => s.trim()).filter(s => s.length > 0);
}
