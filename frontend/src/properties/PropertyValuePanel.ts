// The shared base for a read-only Property/Value inspector: a fixed-height panel
// over a persistent MemoryStore-backed grid. The Database sidebar (PropertiesPanel)
// and the Roles sidebar (RolesPropertiesPanel) are the same panel — only the
// selection they summarise and its row mapping differ — so the store, model, and
// component live here once. A subclass adds a `show(...)` that maps its selection
// to rows and calls `setRows`.
//
// Each update replaces the rows via loadData (synchronous, fires 'load'), so the
// Table re-renders in place without rebuilding the component.

import { Panel }              from "@jimka/typescript-ui/core";
import { Fit }                from "@jimka/typescript-ui/layout";
import { Table }              from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model } from "@jimka/typescript-ui/data";

/** One row of a Property/Value inspector. */
export interface PropertyValueRow {
    property: string;
    value: string;
}

// The inspector's natural height at the bottom of the sidebar accordion: the
// tree/navigator above it takes the rest, and this is what the accordion's
// resizable mode seeds the section's stored height from (see
// ../shell/treeExplorerView.ts). The Table scrolls internally if the property
// list exceeds it.
const PANEL_HEIGHT = 220;

// The inspector's floor. Under the accordion's resizable mode this is the
// gutter drag's lower stop (the drag floors each section at getMinSize) — it
// was previously pinned to PANEL_HEIGHT, which let the user drag the inspector
// only bigger, never smaller. 96px mirrors treeExplorerView's TREE_MIN_HEIGHT
// so neither section can be dragged away entirely.
const PANEL_MIN_HEIGHT = 96;

/** Base for a read-only Property/Value inspector bound to a sidebar selection. */
export class PropertyValuePanel {
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
            preferredSize: { width: 0, height: PANEL_HEIGHT },
            minSize      : { width: 0, height: PANEL_MIN_HEIGHT },
            components   : [Table(this._store, { columns: [], rowReadOnly: () => true })],
        });
    }

    /** Replace the displayed Property/Value rows. */
    protected setRows(rows: PropertyValueRow[]): void {
        this._store.loadData(rows);
    }
}
