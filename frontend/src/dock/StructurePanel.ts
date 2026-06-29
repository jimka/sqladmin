// A read-only grid of a table's introspected column metadata (one row per
// column), shown in its own dock tab opened from the navigator's right-click
// menu. Backed by an in-memory store over the ColumnMeta list.

import { Component, Panel }   from "@jimka/typescript-ui/core";
import { Fit }                from "@jimka/typescript-ui/layout";
import { Table }              from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model } from "@jimka/typescript-ui/data";
import type { ColumnMeta }    from "../contract";

/** Build a panel showing one table's column metadata as a read-only grid. */
export function StructurePanel(columns: ColumnMeta[]): Panel {
    return Panel({ layoutManager: new Fit(), components: [buildStructureTable(columns)] });
}

/** A read-only grid of the introspected column metadata. */
function buildStructureTable(columns: ColumnMeta[]): Component {
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

    // Enforce read-only: editing column metadata would need ALTER TABLE DDL the
    // backend does not have yet, so every cell is locked (rowReadOnly applies to
    // all auto-appended columns). Make this editable when DDL support lands.
    return Table(store, { columns: [], rowReadOnly: () => true });
}
