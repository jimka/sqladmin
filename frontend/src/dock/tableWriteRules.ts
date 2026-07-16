// TableWorkPanel's write-gating pure logic, split out so it can be
// unit-tested without pulling in the library's DOM-backed component classes
// (TableWorkPanel.ts's top-level imports touch `document` at module-load
// time, which the project's node-environment test runner has no stand-in for
// — see vitest.config.ts).

import type { ColumnSpec } from "@jimka/typescript-ui/component/table";
import type { ColumnMeta } from "../contract";

/** The subset of a ModelRecord's API these helpers read. */
interface RecordLike {
    isNew(): boolean;
    isDirty(): boolean;
    get(field: string): unknown;
}

/** The subset of an AjaxStore's API these helpers read. */
interface RecordSource {
    getAll(): Iterable<RecordLike>;
}

/**
 * Returns whether the user must supply a value for this column on insert.
 * Required = NOT NULL, not generated, and no DB default.
 */
export function isRequiredColumn(column: ColumnMeta): boolean {
    return !column.nullable && !column.isGenerated && !column.hasDefault;
}

/**
 * Build the data grid's column spec. Cells are inline-editable by default;
 * generated columns are marked read-only since the DB assigns their values
 * (the SqlAdminWriter also strips them from writes). When the user lacks UPDATE
 * on the table, every column is forced read-only so no edit can be started that
 * Save could not persist. Required columns (NOT NULL, not generated, no default)
 * get a header asterisk and an empty-cell outline from the library; read-only
 * wins over the outline, so a grid without UPDATE shows asterisks but no outlines.
 */
export function buildColumnSpec(columns: ColumnMeta[], canUpdate: boolean): ColumnSpec {
    return {
        columns: columns.map(c => ({
            field: c.name,
            readOnly: !canUpdate || c.isGenerated,
            required: isRequiredColumn(c),
        })),
    };
}

/**
 * Collect the names of required fields left empty across the pending (new or
 * edited) records. Required as per `isRequiredColumn`.
 */
export function missingRequiredFields(store: RecordSource, columns: ColumnMeta[]): string[] {
    const required = columns.filter(isRequiredColumn);
    const missing = new Set<string>();

    for (const record of store.getAll()) {
        if (!record.isNew() && !record.isDirty()) {
            continue;
        }

        for (const column of required) {
            const value = record.get(column.name);

            if (value === null || value === undefined || value === "") {
                missing.add(column.name);
            }
        }
    }

    return [...missing];
}
