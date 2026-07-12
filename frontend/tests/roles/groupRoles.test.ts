import { describe, it, expect } from "vitest";
import { groupRoles } from "./groupRoles";
import type { RoleGroupData } from "./groupRoles";
import type { RoleSummary } from "../contract";

function role(overrides: Partial<RoleSummary> = {}): RoleSummary {
    return {
        name: "app",
        canLogin: false,
        isSuperuser: false,
        inherit: true,
        createRole: false,
        createDb: false,
        replication: false,
        connectionLimit: -1,
        validUntil: null,
        ...overrides,
    };
}

describe("groupRoles", () => {
    it("buckets login roles as Users, plain NOLOGIN roles as Groups, pg_* as Predefined", () => {
        const nodes = groupRoles([
            role({ name: "sqladmin", canLogin: true }),
            role({ name: "reporting" }),
            role({ name: "pg_monitor" }),
        ]);

        expect(nodes.map(n => n.label)).toEqual([
            "Users (1)",
            "Groups (1)",
            "Predefined (1)",
        ]);
        expect(nodes.map(n => n.children?.map(c => c.label))).toEqual([
            ["sqladmin"],
            ["reporting"],
            ["pg_monitor"],
        ]);
    });

    it("omits empty sections", () => {
        const nodes = groupRoles([role({ name: "sqladmin", canLogin: true })]);

        expect(nodes.map(n => n.label)).toEqual(["Users (1)"]);
    });

    it("keeps a login-capable pg_* role under Users, not Predefined", () => {
        // Defensive: predefined roles are NOLOGIN in practice, but canLogin wins
        // because Users is matched first.
        const nodes = groupRoles([role({ name: "pg_signal_backend", canLogin: true })]);

        expect(nodes.map(n => n.label)).toEqual(["Users (1)"]);
    });

    it("tags each leaf with its role name and each parent with a glyph marker", () => {
        const [usersGroup] = groupRoles([role({ name: "sqladmin", canLogin: true })]);

        expect((usersGroup.data as RoleGroupData).glyph).toBe("users");
        expect(usersGroup.children?.[0]?.data).toBe("sqladmin");
    });

    it("preserves incoming role order within a section", () => {
        const [groups] = groupRoles([
            role({ name: "zeta" }),
            role({ name: "alpha" }),
        ]);

        expect(groups.children?.map(c => c.label)).toEqual(["zeta", "alpha"]);
    });
});
