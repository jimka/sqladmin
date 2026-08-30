// The Properties inspector's selection→rows mapping, split out of
// PropertiesPanel.ts so it is unit-testable in the node vitest environment
// (see roles/roleBaseInfoRows.ts for the same split on the Roles side). Its
// only library-facing import is `import type { PropertyValueRow }`, so this
// module carries none of the DOM side effects PropertyValuePanel's own
// Table/Panel imports run at import scope (see data/treeExpansion.ts's
// import-type-only rule).

import type { ColumnMeta, DbObjectRef } from "../contract";
import { kindDisplayLabel } from "../navigator/objectKinds";
import type { PropertyValueRow } from "./PropertyValuePanel";

/** Map a selected object to its Property/Value rows, keyed off the object kind. */
export function propertyRows(ref: DbObjectRef, columns?: ColumnMeta[]): PropertyValueRow[] {
    switch (ref.kind) {
        case "database":
            return [
                { property: "Name", value: ref.database ?? "—" },
                { property: "Type", value: kindDisplayLabel(ref.kind) },
                { property: "Connection", value: ref.connectionId },
            ];
        case "schema":
            return [
                { property: "Name", value: ref.schema ?? "—" },
                { property: "Database", value: ref.database ?? "—" },
                { property: "Type", value: kindDisplayLabel(ref.kind) },
            ];
        case "table":
        case "view":
        case "materializedView":
            return tableRows(ref, columns);
        case "sequence":
            return sequenceRows(ref);
        case "function":
            return functionRows(ref);
        case "type":
            return typeRows(ref);
        case "index":
            return indexRows(ref);
    }
}

/**
 * Rows for a sequence: identity only (Name/Schema/Database/Type). Not built
 * via `tableRows` — that helper is relation-only (a sequence has
 * `isRelation: false` in the object-kind registry). Deep sequence
 * introspection (current value, increment) is a stated Non-Goal of the
 * schema-sequence-ddl plan; the Alter dialog collects new values without
 * prefilling current ones.
 */
function sequenceRows(ref: DbObjectRef): PropertyValueRow[] {
    return [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: kindDisplayLabel(ref.kind) },
    ];
}

/**
 * Rows for a function/procedure: identity plus its identity-argument
 * signature (disambiguates overloads of the same name). Not a relation
 * (`isRelation: false` in the object-kind registry) — it has no columns.
 * `isProcedure` is a per-object flag, not a separate kind — the navigator
 * files both procedures and functions under the one `"function"` kind — so
 * `Procedure` is a caller-side override the registry's `displayLabel`
 * cannot express.
 */
function functionRows(ref: DbObjectRef): PropertyValueRow[] {
    return [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: ref.isProcedure ? "Procedure" : kindDisplayLabel(ref.kind) },
        { property: "Signature", value: ref.signature || "—" },
    ];
}

/**
 * Rows for a standalone enum/composite type: identity only. The category
 * (enum vs. composite) and its labels/attributes are a separate
 * introspection fetch (`getTypeDefinition`), shown in the type's (editable)
 * info tab rather than here — the Properties inspector never round-trips
 * per selection for a non-relation kind.
 */
function typeRows(ref: DbObjectRef): PropertyValueRow[] {
    return [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: kindDisplayLabel(ref.kind) },
    ];
}

/**
 * Rows for an index leaf: identity plus its owning table. Not a relation
 * (`isRelation: false` in the object-kind registry) — the Indexes category is
 * a flat, schema-wide list, so its "table" here is the fact that ties a leaf
 * back to the relation it belongs to.
 */
function indexRows(ref: DbObjectRef): PropertyValueRow[] {
    return [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: kindDisplayLabel(ref.kind) },
        { property: "Table", value: ref.table ?? "—" },
    ];
}

/**
 * Rows for a table, view, or materialized view: identity plus a column count
 * and primary key.
 */
function tableRows(ref: DbObjectRef, columns?: ColumnMeta[]): PropertyValueRow[] {
    const rows = [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: kindDisplayLabel(ref.kind) },
    ];

    if (columns) {
        const primaryKey = columns.filter(c => c.isPrimaryKey).map(c => c.name);

        rows.push({ property: "Columns", value: String(columns.length) });
        rows.push({ property: "Primary key", value: primaryKey.length > 0 ? primaryKey.join(", ") : "—" });
    }

    return rows;
}
