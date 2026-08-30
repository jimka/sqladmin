import { describe, it, expect } from "vitest";
import type { RolePrivilege } from "../../src/contract";
import { buildRoleGrantsDiagram } from "../../src/data/buildRoleGrantsDiagram";
import { uniformNodeWidth } from "../../src/data/uniformNodeWidth";

/** A single table privilege, defaulting to a plain non-grantable SELECT. */
function priv(overrides: Partial<RolePrivilege> = {}): RolePrivilege {
    return { schema: "public", table: "t", privilege: "SELECT", grantable: false, ...overrides };
}

describe("buildRoleGrantsDiagram", () => {
    it("always emits exactly one role centre node", () => {
        const out = buildRoleGrantsDiagram("app", []);
        const width = uniformNodeWidth(["app"]);

        expect(out.nodes).toEqual([{ id: "role:app", label: "app", glyph: "user", width, data: { kind: "role" } }]);
    });

    it("collapses multiple privileges on the same table into one node and one edge", () => {
        const out = buildRoleGrantsDiagram("app", [priv({ privilege: "SELECT" }), priv({ privilege: "INSERT" })]);
        const width = uniformNodeWidth(["app", "public.t"]);

        const tableNodes = out.nodes.filter(n => n.id !== "role:app");
        expect(tableNodes).toEqual([
            { id: "table:public.t", label: "public.t", glyph: "table", width, data: { kind: "table", schema: "public", table: "t" } },
        ]);
        expect(out.edges).toHaveLength(1);
    });

    it("gives the role node and every table node the same width, sized to the widest label", () => {
        const out = buildRoleGrantsDiagram("app", [priv({ schema: "public", table: "a_considerably_longer_table" })]);

        const [roleNode, tableNode] = out.nodes;
        expect(roleNode.width).toBe(tableNode.width);
        expect(roleNode.width).toBe(uniformNodeWidth(["public.a_considerably_longer_table"]));
    });

    it("measures the role name plus every schema.table label", () => {
        const out = buildRoleGrantsDiagram("app", [priv({ schema: "public", table: "t" })]);

        expect(out.nodes[0].width).toBe(uniformNodeWidth(["app", "public.t"]));
    });

    it("passes a stub measurer through to uniformNodeWidth, changing the width", () => {
        const stub = (texts: string[]): number[] => texts.map(() => 500);

        const out = buildRoleGrantsDiagram("app", [priv({ schema: "public", table: "t" })], stub);

        expect(out.nodes[0].width).toBe(uniformNodeWidth(["app", "public.t"], stub));
        expect(out.nodes[0].width).not.toBe(uniformNodeWidth(["app", "public.t"]));
    });

    it("labels the edge with the sorted distinct privilege list", () => {
        const out = buildRoleGrantsDiagram("app", [priv({ privilege: "SELECT" }), priv({ privilege: "INSERT" })]);

        expect(out.edges[0].label).toBe("INSERT, SELECT");
        expect(out.edges[0].data).toEqual({ privileges: ["INSERT", "SELECT"] });
    });

    it("keeps distinct schema.table pairs as distinct nodes across schemas", () => {
        const out = buildRoleGrantsDiagram("app", [
            priv({ schema: "public", table: "t" }),
            priv({ schema: "sales", table: "t" }),
        ]);

        const tableIds = out.nodes.filter(n => n.id !== "role:app").map(n => n.id).sort();
        expect(tableIds).toEqual(["table:public.t", "table:sales.t"]);
    });

    it("emits just the role node and no edges when there are no grants", () => {
        const out = buildRoleGrantsDiagram("app", []);

        expect(out.nodes).toHaveLength(1);
        expect(out.edges).toEqual([]);
    });

    it("never collides a role node id with a table node id of the same name", () => {
        const out = buildRoleGrantsDiagram("t", [priv({ schema: "public", table: "t" })]);

        const ids = out.nodes.map(n => n.id);
        expect(ids).toContain("role:t");
        expect(ids).toContain("table:public.t");
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("sets the layered/RIGHT layout options", () => {
        const out = buildRoleGrantsDiagram("app", []);

        expect(out.layoutOptions).toEqual({
            "elk.algorithm": "layered",
            "elk.direction": "RIGHT",
        });
    });
});
