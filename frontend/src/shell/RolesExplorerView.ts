// The Roles explorer — a Card page in the activity bar's deck: a compact Accordion
// of the roles tree (filling) over the read-only role inspector (fixed height).
// See buildTreeExplorerView for the shared assembly.

import { Component }               from "@jimka/typescript-ui/core";
import { RolesTree }               from "../roles/RolesTree";
import { buildTreeExplorerView }   from "./treeExplorerView";
import type { SqlAdminController } from "../SqlAdminController";

/**
 * Build the Roles explorer view (roles tree + read-only inspector accordion).
 *
 * @param controller - The mediator owning the role data and the inspector.
 * @param id - The Card-page key the activity-bar rail selects this view by.
 *
 * @returns The explorer view component.
 */
export function RolesExplorerView(controller: SqlAdminController, id: string): Component {
    return buildTreeExplorerView({
        id,
        explorer:       RolesTree(controller),
        treeLabel:      "Roles",
        treeGlyph:      "users",
        inspector:      controller.rolesProperties.component,
        inspectorLabel: "Details",
    });
}
