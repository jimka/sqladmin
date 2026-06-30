// Pure flattening of a role's base information (attributes + memberships) into
// the Property/Value rows the read-only RolesPropertiesPanel renders. Grants are
// NOT included here — they are shown in their own paginated Dock table
// (RoleGrantsPanel). Kept separate from the panel component so the mapping is
// unit-testable in the node test env (no Table/DOM import).

import type { RoleDetail } from "../contract";

/** One Property/Value row in the role base-info inspector grid. */
export interface RoleBaseInfoRow {
    property: string;
    value: string;
}

/**
 * Flatten a role's base information into Property/Value rows: the nine attribute
 * rows first (booleans as Yes/No, the `-1` connection limit as "No limit", a
 * missing `validUntil` as "—"), then one "Member of" row per parent role. The
 * role's table grants are deliberately excluded — they live in the Dock grants
 * table, not the narrow sidebar.
 */
export function roleBaseInfoRows(detail: RoleDetail): RoleBaseInfoRow[] {
    const role = detail.role;

    const rows: RoleBaseInfoRow[] = [
        { property: "Name", value: role.name },
        { property: "Can login", value: yesNo(role.canLogin) },
        { property: "Superuser", value: yesNo(role.isSuperuser) },
        { property: "Inherit", value: yesNo(role.inherit) },
        { property: "Create role", value: yesNo(role.createRole) },
        { property: "Create DB", value: yesNo(role.createDb) },
        { property: "Replication", value: yesNo(role.replication) },
        { property: "Connection limit", value: role.connectionLimit === -1 ? "No limit" : String(role.connectionLimit) },
        { property: "Valid until", value: role.validUntil ?? "—" },
    ];

    for (const member of detail.memberOf) {
        rows.push({ property: "Member of", value: member.admin ? `${member.roleName} (admin)` : member.roleName });
    }

    return rows;
}

function yesNo(value: boolean): string {
    return value ? "Yes" : "No";
}
