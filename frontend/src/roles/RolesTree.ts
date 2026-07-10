// The roles picker: a Tree whose top level is three group parents — "Users"
// (login-capable roles), "Groups" (user-created NOLOGIN roles), and "Predefined"
// (PostgreSQL's built-in pg_* roles) — each expanding to its role leaves. See
// groupRoles for the bucketing. A leaf carries its role name on node.data;
// selecting a leaf shows that role's detail in the inspector, and double-clicking
// (or its "Show data" context item) also opens the role's grants tab through the
// controller. Group parents carry a RoleGroupData marker instead, so the leaf
// handlers skip them and the glyph resolver can pick each parent's icon. Mirrors
// NavigatorTree's click→controller wiring.

import { Tree, IconLabelTreeNodeRenderer } from "@jimka/typescript-ui/component/tree";
import type { TreeNode }             from "@jimka/typescript-ui/component/tree";
import { Menu }                      from "@jimka/typescript-ui/overlay";
import { Glyph }                     from "@jimka/typescript-ui/component/display";
import { user }                      from "@jimka/typescript-ui/glyphs/solid/user";
import { users }                     from "@jimka/typescript-ui/glyphs/solid/users";
import { user_group }                from "@jimka/typescript-ui/glyphs/solid/user_group";
import { gears }                     from "@jimka/typescript-ui/glyphs/solid/gears";
import type { SqlAdminController }   from "../SqlAdminController";
import type { ExplorerTree }         from "../navigator/NavigatorTree";
import { groupRoles }                from "./groupRoles";
import type { RoleGroupData }        from "./groupRoles";

// Leaf rows use the single-user glyph; the group parents carry their own glyph
// (from RoleGroupData) so each section reads as users / a group / built-ins.
Glyph.register(user);
Glyph.register(users);
Glyph.register(user_group);
Glyph.register(gears);

/** Resolve a row's glyph: a group parent's own glyph, or a user glyph per leaf. */
function roleRowGlyph(node: TreeNode): string {
    const data = node.data;

    // A role leaf's data is its name string; a group parent's is a marker.
    return typeof data === "string" ? "user" : (data as RoleGroupData).glyph;
}

/** Build the roles Tree, wired to show a role's detail and report load errors. */
export function RolesTree(controller: SqlAdminController): ExplorerTree {
    const tree = Tree();

    // Render each row as its glyph (group parent or role leaf) beside its label.
    tree.setRendererFactory(() => new IconLabelTreeNodeRenderer(roleRowGlyph));

    // A single click only selects: show the role's base info in the inspector
    // without opening a tab. Group parents (non-string data) are skipped here —
    // clicking one only toggles its expansion. Opening the grants tab is
    // reserved for a double-click and the "Show data" context item.
    tree.on("selection", (nodes: TreeNode[]) => {
        const name = nodes[0]?.data;

        if (typeof name === "string") {
            void controller.showRoleProperties(name);
        }
    });

    // A double-click on a role leaf shows its detail and opens (or focuses) its
    // grants tab in the Dock — the behaviour a single click used to have.
    tree.on("dblclick", (node: TreeNode) => {
        const name = node.data;

        if (typeof name === "string") {
            void controller.showRole(name);
        }
    });

    // Right-clicking a role offers a CSV/JSON export of its full grant set,
    // fetched on demand so the role need not be open. Mirrors NavigatorTree's
    // table/view Export submenu. Group parents have no context menu.
    const contextMenu = Menu();

    tree.on("contextmenu", (node: TreeNode, event: MouseEvent) => {
        const name = node.data;

        if (typeof name !== "string") {
            return;
        }

        contextMenu.show(event.clientX, event.clientY, [
            // "Show data" mirrors the double-click: show the role and open its grants
            // tab. Glyphs match the grants tab and the export formats.
            { text: "Show data", glyph: "key", action: () => void controller.showRole(name) },
            { separator: true },
            { text: "Show membership graph", glyph: "diagram-project", action: () => void controller.openRoleMembershipDiagram(name) },
            { text: "Show grants graph", glyph: "diagram-project", action: () => void controller.openRoleGrantsDiagram(name) },
            { separator: true },
            { text: "Export grants", glyph: "file-export", submenu: { label: "Export grants", items: [
                { text: "CSV (.csv)",   glyph: "file-csv",  action: () => void controller.exportRole(name, "csv") },
                { text: "JSON (.json)", glyph: "file-code", action: () => void controller.exportRole(name, "json") },
            ] } },
        ]);
    });

    // (Re)load the role list; used for the initial load and the refresh tool.
    // setNodes collapses every group, so afterwards we reveal the first login
    // role to expand the "Users" section by default — the real users sit up
    // front while the noisy Groups / Predefined sections stay collapsed.
    const refresh = (): void => {
        void controller.loadRoles()
            .then(roles => {
                tree.setNodes(groupRoles(roles));

                const firstUser = roles.find(role => role.canLogin);

                if (firstUser) {
                    void tree.revealByPredicate(data => data === firstUser.name);
                }
            })
            .catch(error => controller.notifyError(error));
    };

    refresh();

    return { tree, refresh };
}
