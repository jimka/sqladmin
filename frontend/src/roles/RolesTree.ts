// The roles picker: a flat Tree of leaf nodes, one per role, loaded eagerly (a
// single small list — no hierarchy to defer). Each node carries the role name on
// node.data; selecting a node shows that role's detail in the inspector, and
// double-clicking (or its "Show data" context item) also opens the role's grants
// tab through the controller. Mirrors NavigatorTree's click→controller wiring.

import { Tree, IconLabelTreeNodeRenderer } from "@jimka/typescript-ui/component/tree";
import type { TreeNode }             from "@jimka/typescript-ui/component/tree";
import { Menu }                      from "@jimka/typescript-ui/overlay";
import { Glyph }                     from "@jimka/typescript-ui/component/display";
import { user }                      from "@jimka/typescript-ui/glyphs/solid/user";
import type { RoleSummary }          from "../contract";
import type { SqlAdminController }   from "../SqlAdminController";
import type { ExplorerTree }         from "../navigator/NavigatorTree";

// Every row is a role; a single user glyph reads the list as "these are roles".
Glyph.register(user);

/** Build the roles Tree, wired to show a role's detail and report load errors. */
export function RolesTree(controller: SqlAdminController): ExplorerTree {
    const tree = Tree();

    // Render each role row as a user glyph beside its name.
    tree.setRendererFactory(() => new IconLabelTreeNodeRenderer(() => "user"));

    // A single click only selects: show the role's base info in the inspector
    // without opening a tab. Opening the grants tab is reserved for a double-click
    // and the "Show data" context item.
    tree.on("selection", (nodes: TreeNode[]) => {
        const name = nodes[0]?.data as string | undefined;

        if (name) {
            void controller.showRoleProperties(name);
        }
    });

    // A double-click shows the role's detail and opens (or focuses) its grants
    // tab in the Dock — the behaviour a single click used to have.
    tree.on("dblclick", (node: TreeNode) => {
        const name = node.data as string | undefined;

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
            // "Show data" mirrors the double-click: show the role and open its grants
            // tab. Glyphs match the grants tab and the export formats.
            { text: "Show data", glyph: "key", action: () => void controller.showRole(name) },
            { separator: true },
            { text: "Export grants", glyph: "file-export", submenu: { label: "Export grants", items: [
                { text: "CSV (.csv)",   glyph: "file-csv",  action: () => void controller.exportRole(name, "csv") },
                { text: "JSON (.json)", glyph: "file-code", action: () => void controller.exportRole(name, "json") },
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
