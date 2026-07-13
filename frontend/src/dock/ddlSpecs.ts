// Pure spec-assembly helpers for the table-DDL dialog forms: translate a
// form's collected rows/fields into the wire spec the matching preview
// client sends. Kept DOM-free (see memory "tsui DOM module side effects") so
// vitest (node-only) can pin them; each form (CreateTableForm,
// AlterColumnForm, ConstraintForm, IndexForm, ColumnChecklist) is a thin
// collector that hands its inputs to one of these.

import type {
    AlterColumnAction,
    AlterSequenceSpec,
    AlterTableSpec,
    ColumnSpec,
    ConstraintSpec,
    CreateSchemaSpec,
    CreateSequenceSpec,
    CreateTableSpec,
    DropSchemaSpec,
    DropSequenceSpec,
    IndexSpec,
    RenameSchemaSpec,
    SequenceDetail,
    SequenceOwnedBy,
    SequenceOwnerSpec,
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

/**
 * Strip a single trailing semicolon (and surrounding whitespace) from a
 * fetched view/matview definition before it goes back into a `select` spec
 * field. `getViewDefinition` (pg_get_viewdef) always terminates its output
 * with a semicolon, but `CreateViewSpec.select` / `ReplaceMatviewSpec.select`
 * expect a bare SELECT body with none — see ViewFormDialog's
 * `NEW_VIEW_SELECT_SKELETON`. A CREATE VIEW harmlessly absorbs a stray
 * trailing semicolon into its own statement terminator, but a materialized
 * view's DROP+CREATE replace pair appends `WITH DATA` right after the select
 * body, so a stray semicolon there breaks the generated SQL (`...WHERE x >
 * 0; WITH DATA` is a syntax error) — this normalizes both call sites the
 * same way regardless.
 *
 * @param select - the editor's current text (a definition tab's Save, or a
 *   freshly fetched definition).
 * @returns the text with leading/trailing whitespace and one trailing
 *   semicolon removed.
 */
export function stripTrailingSemicolon(select: string): string {
    return select.trim().replace(/;\s*$/, "");
}

/**
 * Parse an optional-integer field's text (a sequence numeric option: increment,
 * start, min/max value, cache, restart-with-value): blank means "not set"
 * (the field is omitted from the spec, letting Postgres apply its own
 * default); non-blank text must be a whole number — this is a client-side
 * guard mirroring the backend's own `_int_opt` coercion (see
 * `ddl_schema_sequence.py`), so a bad value is rejected before the preview
 * round-trip rather than surfacing only as a server error.
 *
 * @param text - the field's current text.
 * @param label - the field's human label, used in the thrown message.
 * @throws Error if non-blank text is not a valid integer — a synchronous
 *   throw from inside a form's `readSpec()`, which the dialog's async
 *   `generateSql()` call turns into a rejected promise that
 *   `SqlPreviewDialog` surfaces the same way it does a preview/execute error.
 * @returns the parsed integer, or `undefined` for blank text.
 */
export function parseOptionalInt(text: string, label: string): number | undefined {
    const trimmed = text.trim();

    if (trimmed === "") {
        return undefined;
    }

    const parsed = Number(trimmed);

    if (!Number.isInteger(parsed)) {
        throw new Error(`'${label}' must be a whole number`);
    }

    return parsed;
}

/**
 * Translate the create-schema form's fields into a CreateSchemaSpec, omitting
 * a blank authorization.
 *
 * @param name - the new schema's name.
 * @param authorization - an optional owning role.
 * @returns the spec `previewCreateSchema` sends.
 */
export function buildCreateSchemaSpec(name: string, authorization?: string): CreateSchemaSpec {
    return { name, ...(authorization ? { authorization } : {}) };
}

/**
 * Translate the drop-schema form's fields into a DropSchemaSpec.
 *
 * @param name - the schema to drop.
 * @param cascade - whether to emit CASCADE.
 * @param ifExists - whether to emit IF EXISTS.
 * @returns the spec `previewDropSchema` sends.
 */
export function buildDropSchemaSpec(name: string, cascade?: boolean, ifExists?: boolean): DropSchemaSpec {
    return { name, ...(cascade ? { cascade: true } : {}), ...(ifExists ? { ifExists: true } : {}) };
}

/**
 * Translate the rename-schema form's fields into a RenameSchemaSpec.
 *
 * @param name - the schema's current name.
 * @param newName - the schema's new name.
 * @returns the spec `previewRenameSchema` sends.
 */
export function buildRenameSchemaSpec(name: string, newName: string): RenameSchemaSpec {
    return { name, newName };
}

/** The numeric options a create-sequence form collects, all optional. */
export interface SequenceNumericFields {
    increment?: number;
    start?: number;
    minValue?: number;
    maxValue?: number;
    cache?: number;
}

/**
 * Translate the create-sequence form's fields into a CreateSequenceSpec,
 * carrying only the numeric options that were actually set, and `cycle`/
 * `ownedBy` only when given.
 *
 * @param schema - the new sequence's schema.
 * @param name - the new sequence's name.
 * @param numeric - the form's numeric fields (already parsed by
 *   `parseOptionalInt`); each is included only if not `undefined`.
 * @param cycle - whether to emit CYCLE (omitted when false — Postgres's own
 *   default is no cycling).
 * @param ownedBy - an optional OWNED BY target.
 * @returns the spec `previewCreateSequence` sends.
 */
export function buildCreateSequenceSpec(
    schema: string,
    name: string,
    numeric: SequenceNumericFields,
    cycle?: boolean,
    ownedBy?: SequenceOwnedBy,
): CreateSequenceSpec {
    return {
        schema,
        name,
        ...(numeric.increment !== undefined ? { increment: numeric.increment } : {}),
        ...(numeric.start !== undefined ? { start: numeric.start } : {}),
        ...(numeric.minValue !== undefined ? { minValue: numeric.minValue } : {}),
        ...(numeric.maxValue !== undefined ? { maxValue: numeric.maxValue } : {}),
        ...(numeric.cache !== undefined ? { cache: numeric.cache } : {}),
        ...(cycle ? { cycle: true } : {}),
        ...(ownedBy ? { ownedBy } : {}),
    };
}

/**
 * The fields an alter-sequence form's Parameters card may carry. `restart`
 * and `restartDefault` are mutually exclusive (see `buildAlterSequenceSpec`);
 * `cycle` is a tri-state (`undefined` = leave unchanged, matching the
 * backend's `ALTER SEQUENCE` "omit the clause" semantics).
 */
export interface AlterSequenceParamFields {
    dataType?: string;
    restart?: string | number;
    restartDefault?: boolean;
    increment?: string | number;
    start?: string | number;
    minValue?: string | number;
    maxValue?: string | number;
    cache?: string | number;
    cycle?: boolean;
}

/**
 * Translate the alter-sequence form's Parameters card into an
 * AlterSequenceSpec, carrying only the fields that were actually set. `cycle`
 * is checked with `!== undefined` (not truthiness) so an explicit "NO CYCLE"
 * (`cycle: false`) is preserved rather than dropped.
 *
 * @param schema - the sequence's schema.
 * @param name - the sequence's name.
 * @param fields - the Parameters card's current fields.
 * @returns the spec `previewAlterSequence` sends.
 */
export function buildAlterSequenceSpec(
    schema: string,
    name: string,
    fields: AlterSequenceParamFields,
): AlterSequenceSpec {
    return {
        schema,
        name,
        ...(fields.dataType !== undefined ? { dataType: fields.dataType } : {}),
        ...(fields.restartDefault
            ? { restartDefault: true }
            : fields.restart !== undefined ? { restart: fields.restart } : {}),
        ...(fields.increment !== undefined ? { increment: fields.increment } : {}),
        ...(fields.start !== undefined ? { start: fields.start } : {}),
        ...(fields.minValue !== undefined ? { minValue: fields.minValue } : {}),
        ...(fields.maxValue !== undefined ? { maxValue: fields.maxValue } : {}),
        ...(fields.cache !== undefined ? { cache: fields.cache } : {}),
        ...(fields.cycle !== undefined ? { cycle: fields.cycle } : {}),
    };
}

/**
 * Translate the alter-sequence form's Owner card into a SequenceOwnerSpec.
 *
 * @param schema - the sequence's schema.
 * @param name - the sequence's name.
 * @param owner - the new owning role.
 * @returns the spec `previewSequenceOwner` sends.
 */
export function buildSequenceOwnerSpec(schema: string, name: string, owner: string): SequenceOwnerSpec {
    return { schema, name, owner };
}

/**
 * Translate the drop-sequence form's fields into a DropSequenceSpec.
 *
 * @param schema - the sequence's schema.
 * @param name - the sequence to drop.
 * @param cascade - whether to emit CASCADE.
 * @param ifExists - whether to emit IF EXISTS.
 * @returns the spec `previewDropSequence` sends.
 */
export function buildDropSequenceSpec(
    schema: string,
    name: string,
    cascade?: boolean,
    ifExists?: boolean,
): DropSequenceSpec {
    return { schema, name, ...(cascade ? { cascade: true } : {}), ...(ifExists ? { ifExists: true } : {}) };
}

/**
 * The sequence info form's current field values, read from its widgets (the
 * numeric fields all as strings — see the editable-sequence-tab plan's
 * "bigint stays a STRING end-to-end" decision — plus the Cycle checkbox and
 * the Data type / Owner combos).
 */
export interface EditedSequenceValues {
    lastValue: string; // the Current value field's text ("—" or "" both mean "unset")
    startValue: string;
    increment: string;
    minValue: string;
    maxValue: string;
    cacheSize: string;
    cycle: boolean;
    dataType: string;
    owner: string;
}

/** The ALTER SEQUENCE / OWNER TO specs a Save diff produces; either may be absent. */
export interface SequenceEditSpecs {
    alter?: AlterSequenceSpec;
    owner?: SequenceOwnerSpec;
}

/**
 * Validate a changed numeric cell's text is a whole-number string, without
 * ever parsing it to a `number` — a bigint-sized value (e.g.
 * `"9223372036854775807"`) exceeds `Number.MAX_SAFE_INTEGER`, so the value
 * must stay a string all the way to the backend's own `int()` coercion.
 *
 * @param text - the cell's current text.
 * @param label - the field's human label, used in the thrown message.
 * @throws Error if `text` (trimmed) is not `/^[+-]?\d+$/`.
 * @returns the trimmed text, still a string.
 */
function requireIntString(text: string, label: string): string {
    const trimmed = text.trim();

    if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new Error(`'${label}' must be a whole number`);
    }

    return trimmed;
}

/**
 * Diff the editable sequence info tab's current field values against the
 * originally-loaded `SequenceDetail`, producing only the specs for fields
 * that actually changed — the load-bearing logic behind the tab's Save:
 * every numeric comparison and carry stays a string (never `Number()`d), so
 * a bigint-sized value round-trips exactly. `cycle` compares with `!==`
 * (not truthiness) so an explicit revert to `false` is still carried.
 *
 * @param schema - the sequence's schema.
 * @param name - the sequence's name.
 * @param original - the detail last fetched from the server.
 * @param edited - the form's current widget values.
 * @throws Error if a changed numeric field is not a whole-number string (see
 *   `requireIntString`) — surfaces through the dialog's `generateSql`
 *   rejection path, the same as `parseOptionalInt`'s callers.
 * @returns `{ alter, owner }`, each omitted when its slice is unchanged.
 */
export function diffSequenceSpecs(
    schema: string,
    name: string,
    original: SequenceDetail,
    edited: EditedSequenceValues,
): SequenceEditSpecs {
    const alterFields: AlterSequenceParamFields = {};

    if (edited.dataType.trim() !== original.dataType) {
        alterFields.dataType = edited.dataType.trim();
    }
    if (edited.increment.trim() !== original.increment) {
        alterFields.increment = requireIntString(edited.increment, "Increment");
    }
    if (edited.startValue.trim() !== original.startValue) {
        alterFields.start = requireIntString(edited.startValue, "Start value");
    }
    if (edited.minValue.trim() !== original.minValue) {
        alterFields.minValue = requireIntString(edited.minValue, "Min value");
    }
    if (edited.maxValue.trim() !== original.maxValue) {
        alterFields.maxValue = requireIntString(edited.maxValue, "Max value");
    }
    if (edited.cacheSize.trim() !== original.cacheSize) {
        alterFields.cache = requireIntString(edited.cacheSize, "Cache size");
    }
    if (edited.cycle !== original.cycle) {
        alterFields.cycle = edited.cycle;
    }

    // The Current value cell only ever emits RESTART WITH n — a "—" (the
    // display for a null lastValue) or blank text means "unset", never 0.
    const originalLastValue = original.lastValue ?? "—";
    const editedLastValue = edited.lastValue.trim();

    if (editedLastValue !== originalLastValue && editedLastValue !== "" && editedLastValue !== "—") {
        alterFields.restart = requireIntString(edited.lastValue, "Current value");
    }

    const alter = Object.keys(alterFields).length > 0
        ? buildAlterSequenceSpec(schema, name, alterFields)
        : undefined;
    const owner = edited.owner.trim() !== original.owner
        ? buildSequenceOwnerSpec(schema, name, edited.owner.trim())
        : undefined;

    return { ...(alter ? { alter } : {}), ...(owner ? { owner } : {}) };
}
