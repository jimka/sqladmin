// The Database explorer — a Card page in the activity bar's deck: a compact
// Accordion of the lazy object navigator (filling) over the read-only Properties
// inspector (fixed height). See TreeExplorerView for the shared assembly.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): a thin subclass of
// TreeExplorerView that just fixes the config for the Database tree.

import { callable } from "@jimka/typescript-ui/core";
import { NavigatorTree }           from "../navigator/NavigatorTree";
import { TreeExplorerView }        from "./treeExplorerView";
import { createSchemaTool }        from "./createSchemaTool";
import type { SqlAdminController } from "../SqlAdminController";

/** The Database explorer view (Navigator + Properties accordion). */
class DatabaseExplorerView extends TreeExplorerView {
    /**
     * @param controller - The mediator owning the navigator's data and the
     *   Properties inspector.
     * @param id - The Card-page key the activity-bar rail selects this view by.
     */
    constructor(controller: SqlAdminController, id: string) {
        super({
            id,
            explorer:       NavigatorTree(controller),
            treeLabel:      "Database",
            treeGlyph:      "database",
            treeTools:      [createSchemaTool(() => controller.createSchema({
                connectionId: controller.connectionId,
                database:     controller.database,
                kind:         "database",
            }))],
            inspector:      controller.properties.component,
            inspectorLabel: "Properties",
            layout:         controller.layout.bindAccordion("database"),
        });
    }
}

const DatabaseExplorerViewCallable = callable(DatabaseExplorerView);
type DatabaseExplorerViewCallable = DatabaseExplorerView;
export { DatabaseExplorerViewCallable as DatabaseExplorerView };
