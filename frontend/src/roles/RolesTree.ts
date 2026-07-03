// The roles picker: a flat Tree of leaf nodes, one per role, loaded eagerly (a
// single small list — no hierarchy to defer). Each node carries the role name on
// node.data; selecting a node loads that role's detail through the controller.
// Mirrors NavigatorTree's selection→controller wiring, minus the lazy levels.

import { Tree }                      from "@jimka/typescript-ui/component/tree";
import type { TreeNode }             from "@jimka/typescript-ui/component/tree";
import { Menu }                      from "@jimka/typescript-ui/overlay";
import type { RoleSummary }          from "../contract";
import type { SqlAdminController }   from "../SqlAdminController";
import type { ExplorerTree }         from "../navigator/NavigatorTree";

/** Build the roles Tree, wired to show a role's detail and report load errors. */
export function RolesTree(controller: SqlAdminController): ExplorerTree {
    const tree = Tree();

    tree.on("selection", (nodes: TreeNode[]) => {
        const name = nodes[0]?.data as string | undefined;

        if (name) {
            void controller.showRole(name);
        }
    });

    // Right-clicking a role offers a CSV/JSON export of its full grant set,
    // fetched on demand so the role need not be open. Mirrors NavigatorTree's
    // table/view Export submenu.
    const contextMenu = Menu();

    tree.on("contextmenu", (node: TreeNode, event: MouseEvent) => {
        const name = node.data as string | undefined;

        if (!name) {
            return;
        }

        contextMenu.show(event.clientX, event.clientY, [
            { text: "Export grants", submenu: { label: "Export grants", items: [
                { text: "CSV",  action: () => void controller.exportRole(name, "csv") },
                { text: "JSON", action: () => void controller.exportRole(name, "json") },
            ] } },
        ]);
    });

    // (Re)load the role list; used for the initial load and the refresh tool.
    const refresh = (): void => {
        void controller.loadRoles()
            .then(roles => tree.setNodes(roles.map(roleNode)))
            .catch(error => controller.notifyError(error));
    };

    refresh();

    return { tree, refresh };
}

/** A leaf node for one role; node.data is the role name the detail loads by. */
function roleNode(role: RoleSummary): TreeNode {
    return { label: role.name, data: role.name };
}
