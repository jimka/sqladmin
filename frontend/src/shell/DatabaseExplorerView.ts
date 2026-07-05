// The Database explorer — a Card page in the activity bar's deck: a compact
// Accordion of the lazy object navigator (filling) over the read-only Properties
// inspector (fixed height). See buildTreeExplorerView for the shared assembly.

import { Component }               from "@jimka/typescript-ui/core";
import { NavigatorTree }           from "../navigator/NavigatorTree";
import { buildTreeExplorerView }   from "./treeExplorerView";
import type { SqlAdminController } from "../SqlAdminController";

/**
 * Build the Database explorer view (Navigator + Properties accordion).
 *
 * @param controller - The mediator owning the navigator's data and the
 *   Properties inspector.
 * @param id - The Card-page key the activity-bar rail selects this view by.
 *
 * @returns The explorer view component.
 */
export function DatabaseExplorerView(controller: SqlAdminController, id: string): Component {
    return buildTreeExplorerView({
        id,
        explorer:       NavigatorTree(controller),
        treeLabel:      "Databases",
        treeGlyph:      "database",
        inspector:      controller.properties.component,
        inspectorLabel: "Properties",
    });
}
