// Group a flat role list into the three navigator sections the roles tree
// shows: login-capable "Users", user-created NOLOGIN "Groups", and PostgreSQL's
// built-in "Predefined" pg_* roles. Pure and DOM-free so it unit-tests under
// node vitest; RolesTree wires the resulting parent nodes into the Tree and
// reads back the RoleGroupData marker to pick each parent row's glyph.

import type { TreeNode }    from "@jimka/typescript-ui/component/tree";
import type { RoleSummary } from "../contract";

/**
 * The `data` payload on a group-parent row. A role leaf carries its role-name
 * string on `data`; a group parent carries this marker instead, so the leaf
 * click handlers (which act only on `typeof data === "string"`) skip parents,
 * and the glyph resolver can read the parent's icon.
 */
export interface RoleGroupData {
    /** The bare section name, e.g. "Users" (the row label adds a count). */
    section: string;
    /** The glyph registry name shown on the parent row. */
    glyph: string;
}

// PostgreSQL reserves this prefix for its built-in predefined roles
// (pg_monitor, pg_read_all_data, …); every one is a NOLOGIN group.
const PREDEFINED_PREFIX = "pg_";

// The sections in display order. A role joins the first section whose `match`
// accepts it, so the tests here are read top-down: login roles are Users;
// remaining (NOLOGIN) roles are Groups unless they are pg_* predefined roles.
const SECTIONS: readonly { section: string; glyph: string; match: (role: RoleSummary) => boolean }[] = [
    { section: "Users",      glyph: "users",      match: role => role.canLogin },
    { section: "Groups",     glyph: "user-group", match: role => !role.name.startsWith(PREDEFINED_PREFIX) },
    { section: "Predefined", glyph: "gears",      match: () => true },
];

/**
 * Bucket roles into the three sections and return one expandable parent
 * TreeNode per non-empty section, in section order, each parent's children the
 * role leaves in the order they arrived (the backend orders roles by name).
 *
 * @param roles - The flat role list, e.g. from `controller.loadRoles()`.
 * @returns Group-parent nodes for `Tree.setNodes`; an empty section is omitted.
 */
export function groupRoles(roles: RoleSummary[]): TreeNode[] {
    const members = new Map<string, TreeNode[]>(SECTIONS.map(s => [s.section, []]));

    for (const role of roles) {
        const section = SECTIONS.find(s => s.match(role))!; // the last section matches all
        members.get(section.section)!.push(roleLeaf(role));
    }

    return SECTIONS
        .filter(s => members.get(s.section)!.length > 0)
        .map(s => ({
            label:    `${s.section} (${members.get(s.section)!.length})`,
            data:     { section: s.section, glyph: s.glyph } satisfies RoleGroupData,
            children: members.get(s.section)!,
        }));
}

/** A leaf node for one role; `data` is the role name the detail loads by. */
function roleLeaf(role: RoleSummary): TreeNode {
    return { label: role.name, data: role.name };
}
