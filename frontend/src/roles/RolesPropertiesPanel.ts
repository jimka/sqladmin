// A read-only Property/Value inspector for the selected role's BASE information —
// its attributes and the roles it belongs to. The Roles view's counterpart to
// PropertiesPanel; its table grants are shown separately in a paginated Dock table
// (RoleGrantsPanel), so this panel stays small and needs no pagination.
//
// The panel/store scaffolding lives in the shared PropertyValuePanel base; this
// class adds only the role→rows mapping and the empty state.

import { callable } from "@jimka/typescript-ui/core";
import type { RoleDetail }      from "../contract";
import { roleBaseInfoRows }     from "./roleBaseInfoRows";
import { PropertyValuePanel }   from "../properties/PropertyValuePanel";

/** The selected role's base info, shown as a read-only Property/Value grid. */
class RolesPropertiesPanel extends PropertyValuePanel {
    constructor() {
        super();
        this.clear();
    }

    /** Replace the grid with the given role's attributes and memberships. */
    show(detail: RoleDetail): void {
        this.setRows(roleBaseInfoRows(detail));
    }

    /** Empty state shown before any role is selected. */
    clear(): void {
        this.setRows([{ property: "Role", value: "Select a role to view its details." }]);
    }
}

const RolesPropertiesPanelCallable = callable(RolesPropertiesPanel);
type RolesPropertiesPanelCallable = RolesPropertiesPanel;
export { RolesPropertiesPanelCallable as RolesPropertiesPanel };
