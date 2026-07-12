// The Roles explorer — a Card page in the activity bar's deck: a compact Accordion
// of the roles tree (filling) over the read-only role inspector (fixed height).
// See TreeExplorerView for the shared assembly.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): a thin subclass of
// TreeExplorerView that just fixes the config for the Roles tree.

import { RolesTree }               from "../roles/RolesTree";
import { TreeExplorerView }        from "./treeExplorerView";
import type { SqlAdminController } from "../SqlAdminController";

/** The Roles explorer view (roles tree + read-only inspector accordion). */
export class RolesExplorerView extends TreeExplorerView {
    /**
     * @param controller - The mediator owning the role data and the inspector.
     * @param id - The Card-page key the activity-bar rail selects this view by.
     */
    constructor(controller: SqlAdminController, id: string) {
        super({
            id,
            explorer:       new RolesTree(controller),
            treeLabel:      "Roles",
            treeGlyph:      "users",
            inspector:      controller.rolesProperties.component,
            inspectorLabel: "Details",
        });
    }
}
