// Pure spec-assembly helpers for the app's DDL flows: translate a form's
// collected rows/fields into the wire spec the matching preview client
// sends. Kept DOM-free (see memory "tsui DOM module side effects") so vitest
// (node-only) can pin them. Every DDL form under dock/ is a thin collector
// that hands its inputs to one of these; so are the two in-tab Save flows
// (StructurePanel's Columns-grid diff, via diffColumnSpecs/
// describeColumnSpecs below, and SequenceInfoPanel's, via diffSequenceSpecs)
// and SqlAdminController's own drop launchers.

import type {
    AlterColumnAction,
    AlterCompositeTypeSpec,
    AlterSequenceSpec,
    AlterTableSpec,
    AlterTypeAddValueSpec,
    AlterTypeRenameValueSpec,
    ColumnMeta,
    ColumnSpec,
    ConstraintSpec,
    CreateCompositeTypeSpec,
    CreateEnumTypeSpec,
    CreateFunctionSpec,
    CreateSchemaSpec,
    CreateSequenceSpec,
    CreateTableSpec,
    DropFunctionSpec,
    DropSchemaSpec,
    DropSequenceSpec,
    DropTypeSpec,
    FunctionArgSpec,
    IndexSpec,
    RecreateEnumTypeSpec,
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

/** One Columns-grid row, as the Save diff reads it. */
export interface EditedColumnRow {
    /** The row's column name when the grid was seeded; "" for a row added since. */
    originalName: string;
    name: string;
    type: string;
    nullable: boolean;
    /** "" means "no default". */
    default: string;
}

/**
 * Diff the edited Columns grid against the columns the tab loaded, returning
 * the ALTER TABLE specs in execution order: drops (original order), then
 * per-kept-row alters (grid order, each keyed on the row's pre-rename
 * `originalName`), then renames (grid order), then adds (grid order). Every
 * clause before a rename names the column the database still has, and every
 * added column is created after the names it might reuse have been freed —
 * see the plan's "Statement order" Architecture Decision. Every spec is
 * assembled through {@link buildAlterTableSpec}.
 *
 * @param schema - the table's schema.
 * @param table - the table's name.
 * @param original - the columns the Structure tab loaded (the diff's baseline).
 * @param edited - the Columns grid's current rows, in store order.
 * @throws Error if a kept row's name or type is blank, or an added row has a
 *   name but a blank type — naming the offending column, surfaced through the
 *   Save flow's `onError` rather than opening a preview dialog.
 * @returns the ordered specs; empty when nothing changed.
 */
export function diffColumnSpecs(
    schema: string,
    table: string,
    original: ColumnMeta[],
    edited: EditedColumnRow[],
): AlterTableSpec[] {
    const byOriginal = new Map(original.map(c => [c.name, c] as const));
    const kept        = edited.filter(r => r.originalName !== "");
    const added       = edited.filter(r => r.originalName === "" && r.name.trim() !== "");
    const keptNames   = new Set(kept.map(r => r.originalName));
    const specs: AlterTableSpec[] = [];

    // 1. Drops, in the original column order.
    for (const c of original) {
        if (!keptNames.has(c.name)) {
            specs.push(buildAlterTableSpec(schema, table, "dropColumn", { column: c.name }));
        }
    }

    // 2. Per-kept-row alters, always naming the pre-rename `base.name`.
    for (const r of kept) {
        const base = byOriginal.get(r.originalName);

        if (!base) {
            continue; // Defensive: every kept row's originalName came from `original`.
        }
        if (r.name.trim() === "") {
            throw new Error(`Column "${r.originalName}" cannot be renamed to an empty name`);
        }
        if (r.type.trim() === "") {
            throw new Error(`Column "${r.originalName}" needs a type`);
        }

        if (r.type.trim() !== base.fullType) {
            specs.push(buildAlterTableSpec(schema, table, "changeType", { column: base.name, newType: r.type.trim() }));
        }
        if (r.nullable !== base.nullable) {
            specs.push(buildAlterTableSpec(schema, table, r.nullable ? "dropNotNull" : "setNotNull", { column: base.name }));
        }

        const editedDefault   = r.default.trim();
        const originalDefault = (base.defaultExpr ?? "").trim();

        if (editedDefault !== originalDefault) {
            specs.push(editedDefault === ""
                ? buildAlterTableSpec(schema, table, "dropDefault", { column: base.name })
                : buildAlterTableSpec(schema, table, "setDefault", { column: base.name, default: editedDefault }));
        }
    }

    // 3. Renames, in grid order — after every alter, so each alter still names
    //    the pre-rename identifier.
    for (const r of kept) {
        const base = byOriginal.get(r.originalName);

        if (base && r.name.trim() !== base.name) {
            specs.push(buildAlterTableSpec(schema, table, "renameColumn", { column: base.name, newName: r.name.trim() }));
        }
    }

    // 4. Adds, in grid order — after drops/renames, so an added column may
    //    reuse a name a drop or rename just freed.
    for (const r of added) {
        if (r.type.trim() === "") {
            throw new Error(`New column "${r.name.trim()}" needs a type`);
        }

        specs.push(buildAlterTableSpec(schema, table, "addColumn", {
            columnDef: {
                name:       r.name.trim(),
                type:       r.type.trim(),
                nullable:   r.nullable,
                default:    r.default.trim() === "" ? null : r.default.trim(),
                primaryKey: false,
            },
        }));
    }

    return specs;
}

/**
 * Describe one {@link AlterTableSpec} as a single human-readable summary
 * line, for the preview dialog's form panel. Exhaustive over every
 * `AlterTableSpec.action` — `diffColumnSpecs` never emits `renameTable`, but
 * `describeColumnSpecs` takes the general `AlterTableSpec[]` type, so every
 * action needs a line.
 *
 * @param spec - the spec to describe.
 * @returns the summary line.
 */
function describeColumnSpec(spec: AlterTableSpec): string {
    switch (spec.action) {
        case "renameColumn":
            return `Rename: "${spec.column}" → "${spec.newName}"`;
        case "changeType":
            return `Change type: "${spec.column}" → ${spec.newType}`;
        case "setNotNull":
            return `Set NOT NULL: "${spec.column}"`;
        case "dropNotNull":
            return `Drop NOT NULL: "${spec.column}"`;
        case "setDefault":
            return `Set default: "${spec.column}" → ${spec.default}`;
        case "dropDefault":
            return `Drop default: "${spec.column}"`;
        case "dropColumn":
            return `Drop column: "${spec.column}"`;
        case "addColumn":
            return `Add column: "${spec.columnDef!.name}" ${spec.columnDef!.type}`;
        case "renameTable":
            return `Rename table to "${spec.newName}"`;
    }
}

/**
 * Describe every spec in `specs`, in order — one summary line per spec, for
 * the Save preview dialog's form panel.
 *
 * @param specs - the diff's specs, in execution order.
 * @returns one line per spec, in the same order; `[]` for an empty input.
 */
export function describeColumnSpecs(specs: AlterTableSpec[]): string[] {
    return specs.map(describeColumnSpec);
}

/**
 * Describe a sequence Save diff's alter/owner specs, one line per changed
 * property (e.g. `"Increment: 10 → 25"`), for the Save preview dialog's form
 * panel.
 *
 * @param specs - the diff's alter/owner specs (either or both may be set).
 * @param detail - the pre-edit detail, supplying each line's "before" value.
 * @returns one line per changed property, in declared order; `[]` when
 *   neither `alter` nor `owner` is set.
 */
export function describeSequenceSpecs(specs: SequenceEditSpecs, detail: SequenceDetail): string[] {
    const lines: string[] = [];
    const alter = specs.alter;

    if (alter) {
        if (alter.dataType !== undefined) {
            lines.push(`Data type: ${detail.dataType} → ${alter.dataType}`);
        }
        if (alter.increment !== undefined) {
            lines.push(`Increment: ${detail.increment} → ${alter.increment}`);
        }
        if (alter.start !== undefined) {
            lines.push(`Start value: ${detail.startValue} → ${alter.start}`);
        }
        if (alter.minValue !== undefined) {
            lines.push(`Min value: ${detail.minValue} → ${alter.minValue}`);
        }
        if (alter.maxValue !== undefined) {
            lines.push(`Max value: ${detail.maxValue} → ${alter.maxValue}`);
        }
        if (alter.cache !== undefined) {
            lines.push(`Cache size: ${detail.cacheSize} → ${alter.cache}`);
        }
        if (alter.cycle !== undefined) {
            lines.push(`Cycle: ${detail.cycle ? "Yes" : "No"} → ${alter.cycle ? "Yes" : "No"}`);
        }
        if (alter.restart !== undefined) {
            lines.push(`Current value: ${detail.lastValue ?? "—"} → ${alter.restart}`);
        }
    }
    if (specs.owner) {
        lines.push(`Owner: ${detail.owner} → ${specs.owner.owner}`);
    }

    return lines;
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
 * The column order for a CREATE INDEX spec seeded from a deliberate
 * suggestion (the heuristic index advisor's "Create index…" action): honours
 * `suggestedOrder` exactly when the checklist's current selection is still
 * the same set of columns, since `orderColumnsBySelection`'s table-order
 * default — right for a form with no other ordering signal — would otherwise
 * silently discard the advisor's deliberate equality/sort/range order (see
 * suggestIndexes.ts's "Column order" rule). Falls back to `selected` (already
 * in table order) once the user edits the checked set, since a column added
 * or removed from the suggestion leaves no reliable signal for where it
 * belongs.
 *
 * @param selected - The checklist's current selection, in table order
 *   (`ColumnChecklist.readSelected()`'s own order).
 * @param suggestedOrder - The order the form was seeded with, if any.
 * @returns `suggestedOrder` when `selected` is still the same column set, else `selected`.
 */
export function preserveSuggestedColumnOrder(selected: string[], suggestedOrder?: string[]): string[] {
    if (suggestedOrder === undefined || suggestedOrder.length !== selected.length) {
        return selected;
    }

    const selectedSet = new Set(selected);

    return suggestedOrder.every(c => selectedSet.has(c)) ? suggestedOrder : selected;
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
 * expect a bare SELECT body with none — see ViewForm's
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

/** One CREATE FUNCTION/PROCEDURE argument row collected by the FunctionForm grid. */
export interface FunctionArgRow {
    type: string;
    name: string; // "" means "no name" (mapped to undefined)
    mode: string; // "" means "no mode" (mapped to undefined)
    default: string; // "" means "no default" (mapped to undefined)
}

/** The function-only fields a create-function form collects, alongside the
 *  fixed schema/name/kind/language/body/args. */
export interface CreateFunctionOptions {
    returns?: string;
    volatility?: string;
    replace?: boolean;
}

/**
 * Translate the create-function form's fields into a CreateFunctionSpec:
 * argument rows with a blank `type` are dropped (an in-progress row), and
 * each row's blank `name`/`mode`/`default` is carried as `undefined` (the
 * wire contract's "omit this optional field" value).
 *
 * @param schema - the new routine's schema.
 * @param name - the new routine's name.
 * @param kind - "function" or "procedure".
 * @param rows - the argument grid's current rows, in entry order.
 * @param language - the routine's language (e.g. "plpgsql").
 * @param body - the routine body text, as edited in the SQL preview (this
 *   helper only assembles the *initial* seed spec; the body the user
 *   actually executes is whatever they left in the preview editor).
 * @param options - the function-only returns/volatility/replace fields.
 * @returns the spec `previewCreateFunction` sends.
 */
export function buildCreateFunctionSpec(
    schema: string,
    name: string,
    kind: "function" | "procedure",
    rows: FunctionArgRow[],
    language: string,
    body: string,
    options: CreateFunctionOptions,
): CreateFunctionSpec {
    const args: FunctionArgSpec[] = rows
        .filter(row => row.type.trim() !== "")
        .map(row => ({
            type: row.type,
            ...(row.name.trim() !== "" ? { name: row.name } : {}),
            ...(row.mode.trim() !== "" ? { mode: row.mode } : {}),
            ...(row.default.trim() !== "" ? { default: row.default } : {}),
        }));

    return {
        schema,
        name,
        kind,
        args,
        language,
        body,
        ...(options.returns ? { returns: options.returns } : {}),
        ...(options.volatility ? { volatility: options.volatility } : {}),
        replace: options.replace ?? false,
    };
}

/**
 * Translate the drop-function form's fields into a DropFunctionSpec.
 *
 * @param schema - the routine's schema.
 * @param name - the routine's name.
 * @param kind - "function" or "procedure".
 * @param signature - the identity-argument list, disambiguating overloads.
 * @param cascade - whether to emit CASCADE.
 * @param ifExists - whether to emit IF EXISTS.
 * @returns the spec `previewDropFunction` sends.
 */
export function buildDropFunctionSpec(
    schema: string,
    name: string,
    kind: "function" | "procedure",
    signature: string,
    cascade?: boolean,
    ifExists?: boolean,
): DropFunctionSpec {
    return {
        schema, name, kind, signature,
        ...(cascade ? { cascade: true } : {}),
        ...(ifExists ? { ifExists: true } : {}),
    };
}

/**
 * Translate the create-enum-type form's label rows into a
 * CreateEnumTypeSpec, dropping blank rows (an in-progress row).
 *
 * @param schema - the new type's schema.
 * @param name - the new type's name.
 * @param labels - the label grid's current rows, in entry order.
 * @returns the spec `previewCreateEnumType` sends.
 */
export function buildCreateEnumTypeSpec(schema: string, name: string, labels: string[]): CreateEnumTypeSpec {
    return { schema, name, labels: labels.filter(label => label.trim() !== "") };
}

/**
 * Translate the create-composite-type form's attribute rows into a
 * CreateCompositeTypeSpec, dropping a row whose name or type is blank (an
 * in-progress row).
 *
 * @param schema - the new type's schema.
 * @param name - the new type's name.
 * @param attributes - the attribute grid's current rows, in entry order.
 * @returns the spec `previewCreateCompositeType` sends.
 */
export function buildCreateCompositeTypeSpec(
    schema: string,
    name: string,
    attributes: { name: string; type: string }[],
): CreateCompositeTypeSpec {
    return {
        schema,
        name,
        attributes: attributes.filter(a => a.name.trim() !== "" && a.type.trim() !== ""),
    };
}

/**
 * Translate the drop-type form's fields into a DropTypeSpec.
 *
 * @param schema - the type's schema.
 * @param name - the type to drop.
 * @param cascade - whether to emit CASCADE.
 * @param ifExists - whether to emit IF EXISTS.
 * @returns the spec `previewDropType` sends.
 */
export function buildDropTypeSpec(schema: string, name: string, cascade?: boolean, ifExists?: boolean): DropTypeSpec {
    return { schema, name, ...(cascade ? { cascade: true } : {}), ...(ifExists ? { ifExists: true } : {}) };
}

/**
 * Translate the add-enum-value form's fields into an AlterTypeAddValueSpec.
 *
 * @param schema - the enum type's schema.
 * @param name - the enum type's name.
 * @param value - the new label to add.
 * @param position - an optional BEFORE/AFTER placement relative to an
 *   existing label; omitted appends the value at the end.
 * @returns the spec `previewAlterTypeAddValue` sends.
 */
export function buildAlterTypeAddValueSpec(
    schema: string,
    name: string,
    value: string,
    position?: { placement: "before" | "after"; label: string },
): AlterTypeAddValueSpec {
    return { schema, name, value, ...(position ? { position } : {}) };
}

/** The fields a composite-attribute action may carry; which ones apply depends on `action`. */
export interface AlterCompositeTypeFields {
    attribute?: string;
    newName?: string;
    newType?: string;
    attributeDef?: { name: string; type: string };
}

/**
 * Translate one composite-attribute ALTER gesture into its action-tagged
 * spec, carrying only the fields that action needs — mirroring the backend's
 * `AlterCompositeTypePreview.build()` dispatch.
 *
 * @param schema - the composite type's schema.
 * @param name - the composite type's name.
 * @param action - the ALTER ATTRIBUTE action the diff is emitting.
 * @param fields - the action's collected fields (unused ones are ignored).
 * @returns the spec `previewAlterCompositeType` sends.
 */
export function buildAlterCompositeTypeSpec(
    schema: string,
    name: string,
    action: AlterCompositeTypeSpec["action"],
    fields: AlterCompositeTypeFields,
): AlterCompositeTypeSpec {
    const base = { schema, name, action };

    switch (action) {
        case "addAttribute":
            return { ...base, attributeDef: fields.attributeDef };
        case "dropAttribute":
            return { ...base, attribute: fields.attribute };
        case "changeAttributeType":
            return { ...base, attribute: fields.attribute, newType: fields.newType };
        case "renameAttribute":
            return { ...base, attribute: fields.attribute, newName: fields.newName };
    }
}

/** One composite-attribute grid row, as the Save diff reads it. */
export interface EditedAttributeRow {
    /** The row's attribute name when the grid was seeded; "" for a row added since. */
    originalName: string;
    name: string;
    type: string;
}

/**
 * Diff the edited composite-attribute grid against the attributes the type
 * tab loaded, returning the ALTER TYPE specs in execution order: drops
 * (original order), then per-kept-row type changes (grid order, each keyed
 * on the row's pre-rename `originalName`), then renames (grid order), then
 * adds (grid order) — the same shape `diffColumnSpecs` uses, for the same
 * reasons (see the plan's "Composite attributes: one statement per change,
 * ordered like `diffColumnSpecs`" Architecture Decision). Every spec is
 * assembled through {@link buildAlterCompositeTypeSpec}.
 *
 * @param schema - the composite type's schema.
 * @param name - the composite type's name.
 * @param original - the attributes the type tab loaded (the diff's baseline).
 * @param edited - the body grid's current rows, in store order.
 * @throws Error if a kept row's name or type is blank, or an added row has a
 *   name but a blank type — naming the offending attribute, surfaced through
 *   the Save flow's `onError` rather than opening a preview dialog.
 * @returns the ordered specs; empty when nothing changed.
 */
export function diffCompositeAttributeSpecs(
    schema: string,
    name: string,
    original: { name: string; type: string }[],
    edited: EditedAttributeRow[],
): AlterCompositeTypeSpec[] {
    const byOriginal = new Map(original.map(a => [a.name, a] as const));
    const kept        = edited.filter(r => r.originalName !== "");
    const added       = edited.filter(r => r.originalName === "" && r.name.trim() !== "");
    const keptNames   = new Set(kept.map(r => r.originalName));
    const specs: AlterCompositeTypeSpec[] = [];

    // 1. Drops, in the original attribute order.
    for (const a of original) {
        if (!keptNames.has(a.name)) {
            specs.push(buildAlterCompositeTypeSpec(schema, name, "dropAttribute", { attribute: a.name }));
        }
    }

    // 2. Per-kept-row type changes, always naming the pre-rename `base.name`.
    for (const r of kept) {
        const base = byOriginal.get(r.originalName);

        if (!base) {
            continue; // Defensive: every kept row's originalName came from `original`.
        }
        if (r.name.trim() === "") {
            throw new Error(`Attribute "${r.originalName}" cannot be renamed to an empty name`);
        }
        if (r.type.trim() === "") {
            throw new Error(`Attribute "${r.originalName}" needs a type`);
        }

        if (r.type.trim() !== base.type) {
            specs.push(buildAlterCompositeTypeSpec(schema, name, "changeAttributeType", {
                attribute: base.name, newType: r.type.trim(),
            }));
        }
    }

    // 3. Renames, in grid order — after every type change, so each type
    //    change still names the pre-rename identifier.
    for (const r of kept) {
        const base = byOriginal.get(r.originalName);

        if (base && r.name.trim() !== base.name) {
            specs.push(buildAlterCompositeTypeSpec(schema, name, "renameAttribute", {
                attribute: base.name, newName: r.name.trim(),
            }));
        }
    }

    // 4. Adds, in grid order — after drops/renames, so an added attribute
    //    may reuse a name a drop or rename just freed.
    for (const r of added) {
        if (r.type.trim() === "") {
            throw new Error(`New attribute "${r.name.trim()}" needs a type`);
        }

        specs.push(buildAlterCompositeTypeSpec(schema, name, "addAttribute", {
            attributeDef: { name: r.name.trim(), type: r.type.trim() },
        }));
    }

    return specs;
}

/**
 * Describe one {@link AlterCompositeTypeSpec} as a single human-readable
 * summary line, for the preview dialog's form panel.
 *
 * @param spec - the spec to describe.
 * @returns the summary line.
 */
function describeCompositeSpec(spec: AlterCompositeTypeSpec): string {
    switch (spec.action) {
        case "addAttribute":
            return `Add attribute: "${spec.attributeDef!.name}" ${spec.attributeDef!.type}`;
        case "dropAttribute":
            return `Drop attribute: "${spec.attribute}"`;
        case "changeAttributeType":
            return `Change type: "${spec.attribute}" → ${spec.newType}`;
        case "renameAttribute":
            return `Rename: "${spec.attribute}" → "${spec.newName}"`;
    }
}

/**
 * Describe every spec in `specs`, in order — one summary line per spec, for
 * the Save preview dialog's form panel.
 *
 * @param specs - the diff's specs, in execution order.
 * @returns one line per spec, in the same order; `[]` for an empty input.
 */
export function describeCompositeSpecs(specs: AlterCompositeTypeSpec[]): string[] {
    return specs.map(describeCompositeSpec);
}

/** One enum-label grid row, as the Save diff reads it. */
export interface EditedLabelRow {
    /** The row's label when the grid was seeded; "" for a row added since. */
    originalLabel: string;
    label: string;
}

/**
 * What a Save on an enum tab will run: no changes, a batch of in-place
 * `ADD VALUE`/`RENAME VALUE` statements, or — when a loaded label was
 * deleted — a full recreate (see the plan's "Enum labels: deleting a label
 * routes the whole Save through a recreate" Architecture Decision).
 *
 * A recreate plan carries every kept rename twice, for two different jobs:
 *
 * - `renames` (the full set) rides in `spec.renames`, sent to the recreate
 *   preview so the backend can rewrite a dependent column's stale DEFAULT
 *   literal (see `RecreateEnumTypeSpec`'s doc) — needed regardless of
 *   whether any given rename also runs live, because that introspection
 *   runs before *any* statement in the script (live rename included) has
 *   touched the database.
 * - `liveRenames` is the subset actually run as standalone `RENAME VALUE`
 *   statements against the original type, before the recreate script: this
 *   is how a held row's data reads back under the post-rename spelling by
 *   the time the migration casts it through `::text` (see
 *   `alter_type_rename_value`'s doc — a rename's catalog-only effect, not a
 *   physical rewrite). It excludes exactly the rename(s) whose `newValue`
 *   collides with a label this same edit also removes: Postgres refuses
 *   `RENAME VALUE ... TO 'x'` while a distinct label `'x'` still exists on
 *   the type (`enum label "x" already exists`), and there is no `DROP
 *   VALUE` to free it first — so that one case is left entirely to the
 *   recreate step, whose `CREATE TYPE` already builds the fresh type from
 *   `spec.labels`, the grid's final (already-renamed) label list.
 */
export type EnumEditPlan =
    | { kind: "none" }
    | { kind: "alter"; adds: AlterTypeAddValueSpec[]; renames: AlterTypeRenameValueSpec[] }
    | {
          kind: "recreate";
          spec: RecreateEnumTypeSpec;
          removed: string[];
          renames: AlterTypeRenameValueSpec[];
          liveRenames: AlterTypeRenameValueSpec[];
      };

/**
 * Translate one ALTER TYPE ... RENAME VALUE gesture into its spec.
 *
 * @param schema - the enum type's schema.
 * @param name - the enum type's name.
 * @param value - the label as the database currently has it.
 * @param newValue - the label's new text.
 * @returns the spec `previewAlterTypeRenameValue` sends.
 */
export function buildAlterTypeRenameValueSpec(
    schema: string, name: string, value: string, newValue: string,
): AlterTypeRenameValueSpec {
    return { schema, name, value, newValue };
}

/**
 * Translate the enum recreate's final label list and this same edit's kept
 * renames into its spec.
 *
 * @param schema - the enum type's schema.
 * @param name - the enum type's name.
 * @param labels - the recreated type's full label list, in order.
 * @param renames - this same edit's kept renames, in full — including any
 *   whose target collides with a same-edit removal (see {@link EnumEditPlan}'s
 *   doc for why the backend needs the full set even though only some of them
 *   also run live).
 * @param collidingRenames - the subset of `renames` whose target collides
 *   with a same-edit removal (see `RecreateEnumTypeSpec`'s doc for why the
 *   backend's data migration needs this narrower list separately).
 * @returns the spec `previewRecreateEnumType` sends.
 */
export function buildRecreateEnumTypeSpec(
    schema: string,
    name: string,
    labels: string[],
    renames: AlterTypeRenameValueSpec[],
    collidingRenames: AlterTypeRenameValueSpec[],
): RecreateEnumTypeSpec {
    return {
        schema, name, labels,
        renames:          renames.map(r => ({ value: r.value, newValue: r.newValue })),
        collidingRenames: collidingRenames.map(r => ({ value: r.value, newValue: r.newValue })),
    };
}

/**
 * Order a same-edit batch of label renames into a sequence of live
 * `ALTER TYPE ... RENAME VALUE` statements that each succeed when run in
 * that order. Postgres refuses to rename onto a label the type still has, so
 * a rename's target can be blocked by more than just a same-edit removal
 * (see {@link EnumEditPlan}'s doc for that case) — by another same-edit
 * rename's still-live source, or by any other label the type currently has
 * that this batch doesn't touch at all (a kept-unchanged label, or a
 * same-edit rename `EnumEditPlan` itself excluded from live execution):
 *
 * - A *chain* (`"a"` → `"b"`, `"b"` → `"c"`) — the first rename must wait
 *   for the second to run first, freeing `"b"`.
 * - A *rotation* (`"a"` → `"b"`, `"b"` → `"a"`) — no order works at all,
 *   since each rename's target is the other's still-live source. Broken by
 *   rerouting the first rename that would otherwise deadlock through a
 *   synthetic temporary label (fails loudly, like every other DDL preview,
 *   on the vanishingly unlikely chance a real label already has that exact
 *   spelling — see `ddl.py`'s identical no-collision-check precedent for
 *   its own `__old` recreate suffix), then completing the redirect once the
 *   rest of the cycle has run and freed the real target.
 * - A target blocked by a label *outside* this batch (e.g. a rename
 *   `EnumEditPlan` excluded because its own target collided with a same-edit
 *   removal) can never be freed by anything this function runs — the
 *   temp-label trick only ever frees a label some *other* pending rename is
 *   waiting on. Detected by capping the number of temp labels at
 *   `renames.length` (a genuine cycle among `renames` never needs more than
 *   one per disjoint cycle, so hitting the cap proves no live order exists)
 *   and raising instead of looping forever — this also catches an edited
 *   grid's duplicate final label (two renames targeting the same name),
 *   which is equally unresolvable.
 *
 * @param renames - the renames to run live, in any order (grid order is the
 *   natural input — {@link EnumEditPlan}'s `renames`/`liveRenames` already
 *   excludes one that can never run live at all: a target colliding with a
 *   same-edit removal).
 * @param currentLabels - every label the type currently has, before any of
 *   `renames` runs (typically the tab's loaded `original.labels`) — not just
 *   `renames`' own sources, since a label this batch doesn't touch still
 *   occupies its name for the whole live-rename phase.
 * @throws Error if no live execution order exists at all.
 * @returns the statements to run, in order — possibly more entries than
 *   `renames.length` when a cycle needed breaking.
 */
export function orderRenamesForExecution(
    renames: AlterTypeRenameValueSpec[], currentLabels: Iterable<string>,
): AlterTypeRenameValueSpec[] {
    const occupied = new Set(currentLabels);
    let pending = [...renames];
    const ordered: AlterTypeRenameValueSpec[] = [];
    let tempSuffix = 0;

    while (pending.length > 0) {
        const runnableIndex = pending.findIndex(r => !occupied.has(r.newValue));

        if (runnableIndex !== -1) {
            const rename = pending[runnableIndex];

            ordered.push(rename);
            occupied.delete(rename.value);
            occupied.add(rename.newValue);
            pending = pending.filter((_, i) => i !== runnableIndex);
            continue;
        }

        if (tempSuffix >= renames.length) {
            throw new Error(
                "Cannot order these label renames to run: a target is still occupied by a label this edit " +
                "doesn't free, or two renames target the same label",
            );
        }

        // Every remaining rename's target is currently occupied — by
        // another pending rename's not-yet-run source, or (per the
        // `currentLabels` doc) a label outside this batch. Reroute the
        // first one through a fresh temporary label now (always immediately
        // safe — the type can't already have it), and replace it in
        // `pending` with the temp-to-real-target hop that finishes the
        // redirect once whatever's blocking the real target has freed it.
        const [victim, ...rest] = pending;
        const tempLabel = `__rename_tmp_${tempSuffix++}__`;

        ordered.push({ ...victim, newValue: tempLabel });
        occupied.delete(victim.value);
        occupied.add(tempLabel);
        pending = [{ ...victim, value: tempLabel, newValue: victim.newValue }, ...rest];
    }

    return ordered;
}

/**
 * Diff the edited enum-label grid against the labels the type tab loaded,
 * producing the plan its Save will run. A loaded label missing from the
 * grid — a deletion of something the database actually has — routes the
 * whole Save through a recreate; deleting a row the user added in this same
 * editing session leaves no trace at all (it was never in `original`), so
 * that case falls through to the in-place branch untouched.
 *
 * @param schema - the enum type's schema.
 * @param name - the enum type's name.
 * @param original - the labels the type tab loaded (the diff's baseline), in
 *   catalog order.
 * @param edited - the body grid's current rows, in store order.
 * @throws Error if a kept row is renamed to a blank label, naming the
 *   offending label; or if the edit would leave the type with no labels at
 *   all.
 * @returns the plan Save will run.
 */
export function diffEnumLabels(
    schema: string, name: string, original: string[], edited: EditedLabelRow[],
): EnumEditPlan {
    const kept  = edited.filter(r => r.originalLabel !== "");
    const added = edited.filter(r => r.originalLabel === "" && r.label.trim() !== "");

    for (const r of kept) {
        if (r.label.trim() === "") {
            throw new Error(`Label "${r.originalLabel}" cannot be renamed to an empty name`);
        }
    }

    const keptOriginals = new Set(kept.map(r => r.originalLabel));
    const removed        = original.filter(label => !keptOriginals.has(label));

    // The grid's full final label list, in grid order — every kept row
    // (already validated non-blank above) plus every non-blank added row.
    const finalLabels = edited
        .filter(r => r.originalLabel !== "" || r.label.trim() !== "")
        .map(r => r.label.trim());

    if (finalLabels.length === 0) {
        throw new Error(`Type "${schema}"."${name}" needs at least one label`);
    }

    // Computed before the branch below: a recreate plan needs its own kept
    // renames too (see EnumEditPlan's doc) — the alter branch's `adds` is
    // the only piece a recreate never carries, since a brand-new label has
    // no stale stored data that could need its pre-rename text.
    const renames = kept
        .filter(r => r.label.trim() !== r.originalLabel)
        .map(r => buildAlterTypeRenameValueSpec(schema, name, r.originalLabel, r.label.trim()));

    if (removed.length > 0) {
        // A rename whose target collides with a label this same edit removes
        // can never run live (see EnumEditPlan's doc); every other kept
        // rename still does, ahead of the recreate script. The colliding
        // ones are passed to the backend separately (spec.collidingRenames)
        // so the data migration can tell a row holding the rename's
        // pre-rename value apart from one holding the removed label's own
        // value — see RecreateEnumTypeSpec's doc.
        const removedSet       = new Set(removed);
        const liveRenames      = renames.filter(r => !removedSet.has(r.newValue));
        const collidingRenames = renames.filter(r => removedSet.has(r.newValue));

        return {
            kind: "recreate",
            spec: buildRecreateEnumTypeSpec(schema, name, finalLabels, renames, collidingRenames),
            removed,
            renames,
            liveRenames,
        };
    }

    const adds = added.map(r => buildAlterTypeAddValueSpec(schema, name, r.label.trim()));

    if (renames.length === 0 && adds.length === 0) {
        return { kind: "none" };
    }

    return { kind: "alter", adds, renames };
}

/**
 * Describe a recreate plan: one "Rename label" line per kept rename (they
 * run first — see {@link EnumEditPlan}'s doc — so they lead the summary too,
 * matching the order their SQL actually runs in), then the fixed three-line
 * warning: which labels are being removed, what happens to the type, and
 * what can make the recreate fail. Shown above the migration SQL in the Save
 * preview dialog.
 *
 * @param plan - the recreate plan to describe.
 * @returns the rename lines (if any) followed by the three warning lines.
 */
function describeRecreatePlan(plan: Extract<EnumEditPlan, { kind: "recreate" }>): string[] {
    const removedNoun = plan.removed.length === 1 ? "label" : "labels";
    const removedList = plan.removed.map(label => `'${label}'`).join(", ");
    const labelsList  = plan.spec.labels.map(label => `'${label}'`).join(", ");

    return [
        ...plan.renames.map(r => `Rename label: '${r.value}' → '${r.newValue}'`),
        `Removing ${removedNoun} ${removedList} needs the type recreated `
        + "— PostgreSQL has no ALTER TYPE ... DROP VALUE.",
        `"${plan.spec.schema}"."${plan.spec.name}" is renamed aside, recreated as (${labelsList}), `
        + "and every table column using it is rewritten.",
        "This fails and rolls back if a stored row still holds a removed label, "
        + "or a view depends on one of those columns.",
    ];
}

/**
 * Describe an enum Save plan for the preview dialog's form panel: no lines
 * for a no-op, one line per statement for an in-place alter, or the
 * three-line recreate warning (see {@link describeRecreatePlan}).
 *
 * @param plan - the plan to describe.
 * @returns the summary lines, in the order the plan's SQL would run.
 */
export function describeEnumPlan(plan: EnumEditPlan): string[] {
    switch (plan.kind) {
        case "none":
            return [];
        case "alter":
            // Renames before adds — the same order `saveEnum()` runs them in
            // (see the plan's "Renames are emitted before adds" rule).
            return [
                ...plan.renames.map(r => `Rename label: '${r.value}' → '${r.newValue}'`),
                ...plan.adds.map(a => `Add label: '${a.value}'`),
            ];
        case "recreate":
            return describeRecreatePlan(plan);
    }
}
