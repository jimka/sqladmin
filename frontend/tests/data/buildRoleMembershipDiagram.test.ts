import { describe, it, expect } from "vitest";
import type { RoleDetail, RoleSummary } from "../../src/contract";
import { buildRoleMembershipDiagram } from "../../src/data/buildRoleMembershipDiagram";

function summary(overrides: Partial<RoleSummary> = {}): RoleSummary {
    return {
        name: "app",
        canLogin: true,
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

/** A role's detail with a given name and memberOf list; privileges are irrelevant here. */
function detail(name: string, memberOf: RoleDetail["memberOf"] = []): RoleDetail {
    return { role: summary({ name }), memberOf, privileges: [] };
}

describe("buildRoleMembershipDiagram", () => {
    it("emits one node per role, carrying the user glyph", () => {
        const out = buildRoleMembershipDiagram([detail("a"), detail("b")]);

        expect(out.nodes).toEqual([
            { id: "a", label: "a", glyph: "user" },
            { id: "b", label: "b", glyph: "user" },
        ]);
    });

    it("emits an edge role -> parent for each membership", () => {
        const out = buildRoleMembershipDiagram([
            detail("a", [{ roleName: "b", admin: false }]),
            detail("b"),
        ]);

        expect(out.edges).toHaveLength(1);
        expect(out.edges[0]).toMatchObject({ id: "a->b", source: "a", target: "b" });
    });

    it("carries the admin flag on edge data and label when true", () => {
        const out = buildRoleMembershipDiagram([
            detail("a", [{ roleName: "b", admin: true }]),
            detail("b"),
        ]);

        expect(out.edges[0].data).toEqual({ admin: true });
        expect(out.edges[0].label).toBe("admin");
    });

    it("carries the admin flag on edge data with no label when false", () => {
        const out = buildRoleMembershipDiagram([
            detail("a", [{ roleName: "b", admin: false }]),
            detail("b"),
        ]);

        expect(out.edges[0].data).toEqual({ admin: false });
        expect(out.edges[0].label).toBeUndefined();
    });

    it("drops a membership whose parent is not a known role", () => {
        const out = buildRoleMembershipDiagram([detail("a", [{ roleName: "ghost", admin: false }])]);

        expect(out.edges).toEqual([]);
    });

    it("returns an empty graph with layout options for no roles", () => {
        const out = buildRoleMembershipDiagram([]);

        expect(out.nodes).toEqual([]);
        expect(out.edges).toEqual([]);
        expect(out.layoutOptions).toBeDefined();
    });

    it("passes the layered/RIGHT layout options through", () => {
        const out = buildRoleMembershipDiagram([detail("a")]);

        expect(out.layoutOptions?.["elk.direction"]).toBe("RIGHT");
        expect(out.layoutOptions?.["elk.algorithm"]).toBe("layered");
    });
});
