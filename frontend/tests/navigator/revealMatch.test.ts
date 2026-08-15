import { describe, it, expect } from "vitest";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { DbObjectRef } from "../../src/contract";
import type { RoleGroupData } from "../../src/roles/groupRoles";
import { matchesObject, matchesRelationName, matchesGrantedTable, matchesRole } from "../../src/navigator/revealMatch";
import type { NodeMatch } from "../../src/navigator/revealMatch";

/** The navigator leaf every case below is tested against: sales.orders, a table. */
const ORDERS_LEAF: DbObjectRef = {
    connectionId: "default",
    database    : "app",
    schema      : "sales",
    name        : "orders",
    kind        : "table",
};

/**
 * A ref naming the same object as {@link ORDERS_LEAF}, with `overrides` applied
 * on top — so each case states only the field it varies.
 *
 * @param overrides - The fields this case differs on.
 *
 * @returns The ref to build a predicate from.
 */
function ref(overrides: Partial<DbObjectRef> = {}): DbObjectRef {
    return { ...ORDERS_LEAF, ...overrides };
}

describe("matchesObject", () => {
    it("matches a leaf whose database, schema, name and kind all agree", () => {
        expect(matchesObject(ref())(ORDERS_LEAF)).toBe(true);
    });

    it("does not match when the kind differs", () => {
        expect(matchesObject(ref({ kind: "sequence" }))(ORDERS_LEAF)).toBe(false);
    });

    it("does not match when the schema differs", () => {
        expect(matchesObject(ref({ schema: "hr" }))(ORDERS_LEAF)).toBe(false);
    });

    it("does not match when the database differs", () => {
        expect(matchesObject(ref({ database: "other" }))(ORDERS_LEAF)).toBe(false);
    });
});

describe("matchesRelationName", () => {
    it("matches a leaf of a different kind — kind is not compared", () => {
        expect(matchesRelationName(ref({ kind: "sequence" }))(ORDERS_LEAF)).toBe(true);
    });

    it("does not match when the name differs", () => {
        expect(matchesRelationName(ref({ name: "invoices" }))(ORDERS_LEAF)).toBe(false);
    });

    it("does not match when the schema differs", () => {
        expect(matchesRelationName(ref({ schema: "hr" }))(ORDERS_LEAF)).toBe(false);
    });
});

describe("matchesGrantedTable", () => {
    it("matches on schema and name, ignoring the database the leaf carries", () => {
        expect(matchesGrantedTable("sales", "orders")(ORDERS_LEAF)).toBe(true);
    });

    it("does not match when the schema differs", () => {
        expect(matchesGrantedTable("hr", "orders")(ORDERS_LEAF)).toBe(false);
    });

    it("does not match when the table name differs", () => {
        expect(matchesGrantedTable("sales", "invoices")(ORDERS_LEAF)).toBe(false);
    });
});

// Every navigator predicate is handed each non-navigator payload a real tree
// carries: a category group node's absent `data`, and a roles-tree leaf's bare
// name string. None may match, and none may throw reading a field off them.
const NAVIGATOR_PREDICATES: { label: string; match: NodeMatch }[] = [
    { label: "matchesObject",       match: matchesObject(ref()) },
    { label: "matchesRelationName", match: matchesRelationName(ref()) },
    { label: "matchesGrantedTable", match: matchesGrantedTable("sales", "orders") },
];

for (const { label, match } of NAVIGATOR_PREDICATES) {
    describe(`${label} against a payload that is not a navigator leaf`, () => {
        it("does not match undefined", () => {
            expect(match(undefined)).toBe(false);
        });

        it("does not match a category group node's absent data", () => {
            const categoryNode: TreeNode = { label: "Tables", children: [] };

            expect(match(categoryNode.data)).toBe(false);
        });

        it("does not match a roles-tree leaf's name string", () => {
            expect(match("analyst")).toBe(false);
        });
    });
}

describe("matchesRole", () => {
    it("matches the leaf whose data is that role name", () => {
        expect(matchesRole("analyst")("analyst")).toBe(true);
    });

    it("does not match another role's name", () => {
        expect(matchesRole("analyst")("readonly")).toBe(false);
    });

    it("does not match a group parent's marker object", () => {
        const usersGroup: RoleGroupData = { section: "Users", glyph: "users" };

        expect(matchesRole("analyst")(usersGroup)).toBe(false);
    });

    it("does not match undefined", () => {
        expect(matchesRole("analyst")(undefined)).toBe(false);
    });
});
