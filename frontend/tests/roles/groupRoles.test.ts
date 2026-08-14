import { describe, it, expect } from "vitest";
import { groupRoles, roleNodeKey } from "../../src/roles/groupRoles";
import type { RoleGroupData } from "../../src/roles/groupRoles";
import type { RoleSummary } from "../../src/contract";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";

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

describe("roleNodeKey", () => {
    it("a group parent built by groupRoles yields its bare section name, not its counted label", () => {
        const [usersGroup] = groupRoles([role({ name: "sqladmin", canLogin: true })]);

        expect(usersGroup.label).toBe("Users (1)");
        expect(roleNodeKey(usersGroup)).toBe("Users");
    });

    it("a role leaf yields its role-name string", () => {
        const [usersGroup] = groupRoles([role({ name: "sqladmin", canLogin: true })]);
        const leaf = usersGroup.children![0];

        expect(roleNodeKey(leaf)).toBe("sqladmin");
    });

    it("a node with no data falls back to its label", () => {
        const node: TreeNode = { label: "orphan" };

        expect(roleNodeKey(node)).toBe("orphan");
    });
});
