// The Roles explorer — the second Card page in the activity bar's deck (added on
// the Phase-2 seam, leaving the Database view untouched). A compact Accordion of
// two sections: the roles tree over the read-only role inspector. Both stay open;
// the tree carries an outsized preferred height so the accordion's shrink hands
// it all the space the fixed-height inspector leaves (the same arrangement as
// DatabaseExplorerView).

import { Component }               from "@jimka/typescript-ui/core";
import { AccordionPanel }          from "@jimka/typescript-ui/component/container";
import { RolesTree }               from "../roles/RolesTree";
import { refreshTool }             from "./refreshTool";
import type { SqlAdminController } from "../SqlAdminController";

// A preferred height large enough to always overflow the sidebar, so the
// accordion's shrink gives the roles tree every pixel the fixed-height inspector
// leaves.
const ROLES_FILL_HINT = 10000;

/**
 * Build the Roles explorer view (roles tree + read-only inspector accordion).
 *
 * @param controller - The mediator owning the role data and the inspector.
 * @param id - The Card-page key the activity-bar rail selects this view by; it
 *   becomes the view component's id, which the deck's `Card` matches against.
 *
 * @returns The explorer view component.
 */
export function RolesExplorerView(controller: SqlAdminController, id: string): Component {
    const { tree, refresh } = RolesTree(controller);

    tree.setPreferredSize(0, ROLES_FILL_HINT);

    const view = new AccordionPanel({
        id,
        sections: [
            { label: "Roles", component: tree, initiallyOpen: true, glyph: "users", tools: [refreshTool(refresh)] },
            { label: "Details", component: controller.rolesProperties.component, initiallyOpen: true, glyph: "circle-info" },
        ],
    });

    view.getAccordion().setCompact(true);
    view.getAccordion().setToolsVisibility("always");

    return view;
}
