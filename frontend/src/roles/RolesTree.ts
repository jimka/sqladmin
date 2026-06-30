// The roles picker: a flat Tree of leaf nodes, one per role, loaded eagerly (a
// single small list — no hierarchy to defer). Each node carries the role name on
// node.data; selecting a node loads that role's detail through the controller.
// Mirrors NavigatorTree's selection→controller wiring, minus the lazy levels.

import { Tree }                      from "@jimka/typescript-ui/component/tree";
import type { TreeNode }             from "@jimka/typescript-ui/component/tree";
import type { RoleSummary }          from "../contract";
import type { SqlAdminController }   from "../SqlAdminController";

/** Build the roles Tree, wired to show a role's detail and report load errors. */
export function RolesTree(controller: SqlAdminController): Tree {
    const tree = Tree();

    tree.on("selection", (nodes: TreeNode[]) => {
        const name = nodes[0]?.data as string | undefined;

        if (name) {
            void controller.showRole(name);
        }
    });

    void controller.loadRoles()
        .then(roles => tree.setNodes(roles.map(roleNode)))
        .catch(error => controller.notifyError(error));

    return tree;
}

/** A leaf node for one role; node.data is the role name the detail loads by. */
function roleNode(role: RoleSummary): TreeNode {
    return { label: role.name, data: role.name };
}
