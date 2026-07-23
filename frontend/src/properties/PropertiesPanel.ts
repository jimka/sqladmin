// A read-only Property/Value inspector bound to the navigator selection. It sits
// below the navigator in the WEST sidebar and summarises whatever object is
// selected — a database, schema, table, or view. For a table/view the controller
// also passes its columns so the count and primary key can be shown; the detailed
// per-column grid lives in StructurePanel, opened from the right-click menu.
//
// The panel/store scaffolding lives in the shared PropertyValuePanel base; this
// class adds only the selection→rows mapping.

import { callable } from "@jimka/typescript-ui/core";
import type { ColumnMeta, DbObjectRef } from "../contract";
import { PropertyValuePanel }           from "./PropertyValuePanel";
import type { PropertyValueRow }        from "./PropertyValuePanel";

/** The selected object's metadata, shown as a read-only Property/Value grid. */
class PropertiesPanel extends PropertyValuePanel {
    /**
     * Replace the displayed metadata with that of `ref`. For a table, view, or
     * materialized view, pass its `columns` so the column count and primary key
     * are included.
     */
    show(ref: DbObjectRef, columns?: ColumnMeta[]): void {
        this.setRows(propertyRows(ref, columns));
    }
}

/** Map a selected object to its Property/Value rows, keyed off the object kind. */
function propertyRows(ref: DbObjectRef, columns?: ColumnMeta[]): PropertyValueRow[] {
    switch (ref.kind) {
        case "database":
            return [
                { property: "Name", value: ref.database ?? "—" },
                { property: "Type", value: "Database" },
                { property: "Connection", value: ref.connectionId },
            ];
        case "schema":
            return [
                { property: "Name", value: ref.schema ?? "—" },
                { property: "Database", value: ref.database ?? "—" },
                { property: "Type", value: "Schema" },
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
    }
}

/**
 * Rows for a sequence: identity only (Name/Schema/Database/Type). Not built
 * via `tableRows`/`relationTypeLabel` — those helpers are relation-only (a
 * sequence has `isRelation: false` in the object-kind registry, and
 * `relationTypeLabel` only distinguishes table/view/materializedView). Deep
 * sequence introspection (current value, increment) is a stated Non-Goal of
 * the schema-sequence-ddl plan; the Alter dialog collects new values without
 * prefilling current ones.
 */
function sequenceRows(ref: DbObjectRef): PropertyValueRow[] {
    return [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: "Sequence" },
    ];
}

/**
 * Rows for a function/procedure: identity plus its identity-argument
 * signature (disambiguates overloads of the same name). Not a relation
 * (`isRelation: false` in the object-kind registry) — it has no columns.
 */
function functionRows(ref: DbObjectRef): PropertyValueRow[] {
    return [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: ref.isProcedure ? "Procedure" : "Function" },
        { property: "Signature", value: ref.signature || "—" },
    ];
}

/**
 * Rows for a standalone enum/composite type: identity only. The category
 * (enum vs. composite) and its labels/attributes are a separate
 * introspection fetch (`getTypeDefinition`), shown in the edit dialog rather
 * than here — the Properties inspector never round-trips per selection for
 * a non-relation kind.
 */
function typeRows(ref: DbObjectRef): PropertyValueRow[] {
    return [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: "Type" },
    ];
}

/** Human-readable Type label for a relation kind (table/view/materialized view). */
export function relationTypeLabel(kind: DbObjectRef["kind"]): string {
    if (kind === "view") {
        return "View";
    }

    if (kind === "materializedView") {
        return "Materialized view";
    }

    // Not a relation kind (see objectKinds.ts's isRelation), but panelTooltip
    // calls this for every open tab including the sequence info tab, so the
    // Type line reads "Sequence" rather than falling through to "Table".
    if (kind === "sequence") {
        return "Sequence";
    }

    return "Table";
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
        { property: "Type", value: relationTypeLabel(ref.kind) },
    ];

    if (columns) {
        const primaryKey = columns.filter(c => c.isPrimaryKey).map(c => c.name);

        rows.push({ property: "Columns", value: String(columns.length) });
        rows.push({ property: "Primary key", value: primaryKey.length > 0 ? primaryKey.join(", ") : "—" });
    }

    return rows;
}

const PropertiesPanelCallable = callable(PropertiesPanel);
type PropertiesPanelCallable = PropertiesPanel;
export { PropertiesPanelCallable as PropertiesPanel };
