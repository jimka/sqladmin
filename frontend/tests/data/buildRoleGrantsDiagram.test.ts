import { describe, it, expect } from "vitest";
import type { RolePrivilege } from "../contract";
import { buildRoleGrantsDiagram } from "./buildRoleGrantsDiagram";

/** A single table privilege, defaulting to a plain non-grantable SELECT. */
function priv(overrides: Partial<RolePrivilege> = {}): RolePrivilege {
    return { schema: "public", table: "t", privilege: "SELECT", grantable: false, ...overrides };
}

describe("buildRoleGrantsDiagram", () => {
    it("always emits exactly one role centre node", () => {
        const out = buildRoleGrantsDiagram("app", []);

        expect(out.nodes).toEqual([{ id: "role:app", label: "app", glyph: "user", data: { kind: "role" } }]);
    });

    it("collapses multiple privileges on the same table into one node and one edge", () => {
        const out = buildRoleGrantsDiagram("app", [priv({ privilege: "SELECT" }), priv({ privilege: "INSERT" })]);

        const tableNodes = out.nodes.filter(n => n.id !== "role:app");
        expect(tableNodes).toEqual([
            { id: "table:public.t", label: "public.t", glyph: "table", data: { kind: "table", schema: "public", table: "t" } },
        ]);
        expect(out.edges).toHaveLength(1);
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
});
