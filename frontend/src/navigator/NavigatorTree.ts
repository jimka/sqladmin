// The lazy object navigator: a Tree whose levels (databases -> schemas ->
// tables/views) are fetched on first expansion via the introspection api. Each
// node carries its DbObjectRef on node.data; selecting a table/view leaf opens
// it in the Dock through the controller. The Tree caches loaded children, so a
// collapse/re-expand does not refetch.

import { Tree } from "@jimka/typescript-ui/component/tree";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import { Menu } from "@jimka/typescript-ui/overlay";
import type { DbObjectRef } from "../contract";
import { getDatabases, getObjects, getSchemas } from "../data/api";
import type { SqlAdminController } from "../SqlAdminController";

/** Build the navigator Tree, wired to open tables and report load errors. */
export function NavigatorTree(controller: SqlAdminController): Tree {
    const conn = controller.connectionId;
    const tree = Tree();
    const contextMenu = Menu();

    tree.on("selection", (nodes: TreeNode[]) => {
        const node = nodes[0];
        const ref = node?.data as DbObjectRef | undefined;

        if (!node || !ref) {
            return;
        }

        // Every selection updates the Properties inspector; a table/view also
        // opens (or focuses) its data tab in the Dock.
        if (ref.kind === "table" || ref.kind === "view") {
            void controller.openTable(ref, node);
        } else {
            void controller.showProperties(ref);
        }
    });

    // Right-clicking a table/view offers its structure in a separate tab.
    tree.on("contextmenu", (node: TreeNode, event: MouseEvent) => {
        const ref = node.data as DbObjectRef | undefined;

        if (ref && (ref.kind === "table" || ref.kind === "view")) {
            contextMenu.show(event.clientX, event.clientY, [
                { text: "Open structure", action: () => void controller.openStructure(ref, node) },
            ]);
        }
    });

    tree.on("loaderror", (_node: TreeNode, error: unknown) => controller.notifyError(error));

    // Let the controller drive selection when a dock tab is focused.
    controller.setNavigator(tree);

    void loadDatabases(conn)
        .then(nodes => tree.setNodes(nodes))
        .catch(error => controller.notifyError(error));

    return tree;
}

async function loadDatabases(conn: string): Promise<TreeNode[]> {
    const databases = await getDatabases(conn);

    return databases.map(db => databaseNode(conn, db.name));
}

function databaseNode(conn: string, database: string): TreeNode {
    return {
        label: database,
        hasChildren: true,
        data: { connectionId: conn, database, kind: "database" } satisfies DbObjectRef,
        loadChildren: () => loadSchemas(conn, database),
    };
}

async function loadSchemas(conn: string, database: string): Promise<TreeNode[]> {
    const schemas = await getSchemas(conn, database);

    return schemas.map(s => schemaNode(conn, database, s.name));
}

function schemaNode(conn: string, database: string, schema: string): TreeNode {
    return {
        label: schema,
        hasChildren: true,
        data: { connectionId: conn, database, schema, kind: "schema" } satisfies DbObjectRef,
        loadChildren: () => loadObjects(conn, database, schema),
    };
}

async function loadObjects(conn: string, database: string, schema: string): Promise<TreeNode[]> {
    const objects = await getObjects(conn, database, schema);

    return objects.map(o => ({
        label: o.name,
        data: { connectionId: conn, database, schema, name: o.name, kind: o.kind } satisfies DbObjectRef,
    }));
}
