// A read-only Property/Value inspector bound to the navigator selection. It sits
// below the navigator in the WEST sidebar and summarises whatever object is
// selected — a database, schema, table, or view. For a table/view the controller
// also passes its columns so the count and primary key can be shown; the detailed
// per-column grid lives in StructurePanel, opened from the right-click menu.
//
// The panel/store scaffolding lives in the shared PropertyValuePanel base, and the
// selection→rows mapping lives one file over in propertyRows.ts (DOM-free, so it
// stays unit-testable); this class only wires the two together.

import { callable } from "@jimka/typescript-ui/core";
import type { ColumnMeta, DbObjectRef } from "../contract";
import { PropertyValuePanel } from "./PropertyValuePanel";
import { propertyRows } from "./propertyRows";

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

const PropertiesPanelCallable = callable(PropertiesPanel);
type PropertiesPanelCallable = PropertiesPanel;
export { PropertiesPanelCallable as PropertiesPanel };
