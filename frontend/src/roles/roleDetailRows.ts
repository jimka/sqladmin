// Pure flattening of a RoleDetail into the Property/Value rows the read-only
// RolesPropertiesPanel renders. Kept separate from the panel component so the
// mapping is unit-testable in the node test env (no Table/DOM import).

import type { RoleDetail } from "../contract";

/** One Property/Value row in the role inspector grid. */
export interface RoleDetailRow {
    property: string;
    value: string;
}

/**
 * Flatten a role's attributes, memberships, and privileges into Property/Value
 * rows: the nine attribute rows first (booleans as Yes/No, the `-1` connection
 * limit as "No limit", a missing `validUntil` as "—"), then one "Member of" row
 * per parent role and one "Grant" row per table privilege.
 */
export function roleDetailRows(detail: RoleDetail): RoleDetailRow[] {
    const role = detail.role;

    const rows: RoleDetailRow[] = [
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

    for (const grant of detail.privileges) {
        const base = `${grant.schema}.${grant.table}: ${grant.privilege}`;
        rows.push({ property: "Grant", value: grant.grantable ? `${base} (grantable)` : base });
    }

    return rows;
}

function yesNo(value: boolean): string {
    return value ? "Yes" : "No";
}
