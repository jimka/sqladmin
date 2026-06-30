// A read-only Property/Value inspector for the selected role's BASE information —
// its attributes and the roles it belongs to. The Roles view's counterpart to
// PropertiesPanel; its table grants are shown separately in a paginated Dock
// table (RoleGrantsPanel), so this panel stays small and needs no pagination.
//
// Backed by a single persistent MemoryStore: each selection replaces its rows
// via loadData (synchronous, fires 'load'), so the Table re-renders in place.

import { Panel }              from "@jimka/typescript-ui/core";
import { Fit }                from "@jimka/typescript-ui/layout";
import { Table }              from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model } from "@jimka/typescript-ui/data";
import type { RoleDetail }    from "../contract";
import { roleBaseInfoRows }   from "./roleBaseInfoRows";

// Fixed height the inspector occupies at the bottom of the roles accordion; the
// tree above it takes the rest (mirrors PropertiesPanel).
const PANEL_HEIGHT = 220;

/** The selected role's base info, shown as a read-only Property/Value grid. */
export class RolesPropertiesPanel {
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
            minSize      : { width: 0, height: PANEL_HEIGHT },
            components   : [Table(this._store, { columns: [], rowReadOnly: () => true })],
        });

        this.clear();
    }

    /** Replace the grid with the given role's attributes and memberships. */
    show(detail: RoleDetail): void {
        this._store.loadData(roleBaseInfoRows(detail));
    }

    /** Empty state shown before any role is selected. */
    clear(): void {
        this._store.loadData([{ property: "Role", value: "Select a role to view its details." }]);
    }
}
