// A read-only Property/Value inspector bound to the navigator selection. It sits
// below the navigator in the WEST sidebar and summarises whatever object is
// selected — a database, schema, table, or view. For a table/view the controller
// also passes its columns so the count and primary key can be shown; the detailed
// per-column grid lives in StructurePanel, opened from the right-click menu.
//
// Backed by a single persistent MemoryStore: each selection replaces its rows via
// loadData (synchronous, fires 'load'), so the Table re-renders in place without
// rebuilding the component.

import { Panel } from "@jimka/typescript-ui/core";
import { Fit } from "@jimka/typescript-ui/layout";
import { Table } from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model } from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef } from "../contract";

// Fixed height the inspector occupies at the bottom of the sidebar accordion;
// the navigator above it takes the rest. Pinned as both preferred and minimum so
// the accordion's shrink never steals from it — the navigator absorbs all the
// flex instead. The Table scrolls internally if the property list ever exceeds it.
const PANEL_HEIGHT = 220;

/** The selected object's metadata, shown as a read-only Property/Value grid. */
export class PropertiesPanel {
    readonly component: Panel;

    private readonly _store: MemoryStore;

    constructor() {
        const model = new Model({
            fields: [
                { name: "property", type: "string", description: "Property", order: 1 },
                { name: "value", type: "string", description: "Value", order: 2 },
            ],
        });

        this._store = new MemoryStore({ model, data: [], autoLoad: true });
        this.component = Panel({
            layoutManager: new Fit(),
            components: [Table(this._store, { columns: [], rowReadOnly: () => true })],
        });
        this.component.setPreferredSize(0, PANEL_HEIGHT);
        this.component.setMinSize(0, PANEL_HEIGHT);
    }

    /**
     * Replace the displayed metadata with that of `ref`. For a table or view,
     * pass its `columns` so the column count and primary key are included.
     */
    show(ref: DbObjectRef, columns?: ColumnMeta[]): void {
        this._store.loadData(propertyRows(ref, columns));
    }
}

/** Map a selected object to its Property/Value rows, keyed off the object kind. */
function propertyRows(ref: DbObjectRef, columns?: ColumnMeta[]): { property: string; value: string }[] {
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
            return tableRows(ref, columns);
    }
}

/** Rows for a table or view: identity plus a column count and primary key. */
function tableRows(ref: DbObjectRef, columns?: ColumnMeta[]): { property: string; value: string }[] {
    const rows = [
        { property: "Name", value: ref.name ?? "—" },
        { property: "Schema", value: ref.schema ?? "—" },
        { property: "Database", value: ref.database ?? "—" },
        { property: "Type", value: ref.kind === "view" ? "View" : "Table" },
    ];

    if (columns) {
        const primaryKey = columns.filter(c => c.isPrimaryKey).map(c => c.name);

        rows.push({ property: "Columns", value: String(columns.length) });
        rows.push({ property: "Primary key", value: primaryKey.length > 0 ? primaryKey.join(", ") : "—" });
    }

    return rows;
}
