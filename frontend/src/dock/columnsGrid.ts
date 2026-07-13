// The shared read-only Columns grid — a Table over a MemoryStore of a
// relation's introspected columns (name/type/nullable/PK/generated/wire
// type), used by both StructurePanel's Columns section (tables) and
// DefinitionPanel's Columns section (views/matviews) so the column set and
// formatting stay identical everywhere a relation's columns are shown.
//
// Returns the store alongside the grid so a caller that needs to reseed the
// grid later (DefinitionPanel, after a definition Save) can call
// `store.loadData(...)` directly, without rebuilding the Table.

import { Table }               from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model }  from "@jimka/typescript-ui/data";
import type { ColumnMeta }     from "../contract";

/** A built Columns grid plus the store backing it. */
export interface ColumnsGrid {
    grid: Table;
    store: MemoryStore;
}

/**
 * Build a read-only grid over a store. Structure/definition edits are
 * toolbar- or Save-button-launched flows, never inline cell edits, so every
 * column stays locked regardless of caller.
 *
 * @param store - The grid's backing store.
 * @returns A read-only Table over the store.
 */
export function readOnlyTable(store: MemoryStore): Table {
    return Table(store, { columns: [], rowReadOnly: () => true });
}

/**
 * Build the Columns grid — name/type/nullable/PK/generated/wire-type — over
 * a fresh in-memory store.
 *
 * @param columns - The relation's introspected columns.
 */
export function buildColumnsGrid(columns: ColumnMeta[]): ColumnsGrid {
    const model = new Model({
        fields: [
            { name: "name", type: "string", description: "Column", order: 1 },
            { name: "dataType", type: "string", description: "Type", order: 2 },
            { name: "nullable", type: "boolean", description: "Nullable", order: 3 },
            { name: "isPrimaryKey", type: "boolean", description: "PK", order: 4 },
            { name: "isGenerated", type: "boolean", description: "Generated", order: 5 },
            { name: "wireType", type: "string", description: "Wire type", order: 6 },
        ],
    });

    const store = new MemoryStore({ model, data: columns, autoLoad: true });

    return { grid: readOnlyTable(store), store };
}
