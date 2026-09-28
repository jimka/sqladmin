// Pins navigatorRefresh.ts's pure scope mapping, node identity, merge and
// loaded-schema scan against plans/implemented/navigator-targeted-refresh.md's
// `## Expected Behaviour` cases U1-U16. Every case works on plain TreeNode
// objects, so no Tree (and no DOM) is needed.

import { describe, expect, it } from "vitest";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { DbObjectKind, DbObjectRef } from "../../src/contract";
import { loadedSchemaNames, navigatorNodeIdentity, navigatorScopeFor, reconcileNodes } from "../../src/navigator/navigatorRefresh";

/**
 * An object leaf the way NavigatorTree builds one: the label plus a
 * `DbObjectRef` payload.
 *
 * @param kind - The object's kind.
 * @param name - The object's name.
 * @param extra - Any further ref fields (`signature`, `table`, …) and an optional label override.
 *
 * @returns The leaf node.
 */
function leaf(kind: DbObjectKind, name: string, extra: Partial<DbObjectRef> & { label?: string } = {}): TreeNode {
    const { label, ...refExtra } = extra;

    return {
        label: label ?? name,
        data : { connectionId: "default", database: "app", schema: "public", name, kind, ...refExtra } satisfies DbObjectRef,
    };
}

/**
 * A schema node the way NavigatorTree builds one (no `name` on its ref).
 *
 * @param schema - The schema's name.
 *
 * @returns The schema node.
 */
function schemaNode(schema: string): TreeNode {
    return { label: schema, data: { connectionId: "default", database: "app", schema, kind: "schema" } satisfies DbObjectRef };
}

describe("navigatorScopeFor", () => {
    it("U1: a create re-reads just its schema", () => {
        expect(navigatorScopeFor({ action: "create", kind: "table", schema: "public" }))
            .toEqual({ schemaList: false, schemas: ["public"] });
    });

    it("U2: a non-cascading drop re-reads just its schema", () => {
        expect(navigatorScopeFor({ action: "drop", kind: "view", schema: "public", cascade: false }))
            .toEqual({ schemaList: false, schemas: ["public"] });
    });

    it("U3: a cascading drop re-reads every loaded schema", () => {
        expect(navigatorScopeFor({ action: "drop", kind: "table", schema: "public", cascade: true }))
            .toEqual({ schemaList: false, schemas: "allLoaded" });
    });

    it("U4: creating a schema re-reads only the schema list", () => {
        expect(navigatorScopeFor({ action: "create", kind: "schema" }))
            .toEqual({ schemaList: true, schemas: [] });
    });

    it("U5: renaming a schema re-reads only the schema list", () => {
        expect(navigatorScopeFor({ action: "rename", kind: "schema", schema: "old" }))
            .toEqual({ schemaList: true, schemas: [] });
    });

    it("U6: dropping a schema widens to every loaded schema only with cascade", () => {
        expect(navigatorScopeFor({ action: "drop", kind: "schema", schema: "old", cascade: true }))
            .toEqual({ schemaList: true, schemas: "allLoaded" });
        expect(navigatorScopeFor({ action: "drop", kind: "schema", schema: "old", cascade: false }))
            .toEqual({ schemaList: true, schemas: [] });
    });

    it("U7: edited SQL beats the plain same-schema rule", () => {
        expect(navigatorScopeFor({ action: "rename", kind: "table", schema: "public", sqlEdited: true }))
            .toEqual({ schemaList: true, schemas: "allLoaded" });
    });

    it("U8: edited SQL beats the schema-kind rule", () => {
        expect(navigatorScopeFor({ action: "drop", kind: "schema", schema: "x", cascade: false, sqlEdited: true }))
            .toEqual({ schemaList: true, schemas: "allLoaded" });
    });

    it("U9: index and constraint changes re-read their schema; cascade only widens a drop", () => {
        expect(navigatorScopeFor({ action: "create", kind: "index", schema: "sales" }))
            .toEqual({ schemaList: false, schemas: ["sales"] });
        expect(navigatorScopeFor({ action: "alter", kind: "table", schema: "sales", cascade: true }))
            .toEqual({ schemaList: false, schemas: ["sales"] });
    });

    it("U10: a non-schema change without a schema re-reads everything loaded", () => {
        expect(navigatorScopeFor({ action: "create", kind: "table" }))
            .toEqual({ schemaList: true, schemas: "allLoaded" });
    });
});

describe("navigatorNodeIdentity (U11)", () => {
    it("produces the identity table's exact strings", () => {
        expect(navigatorNodeIdentity(leaf("table", "orders")))
            .toBe(JSON.stringify(["table", "public", "orders", ""]));
        expect(navigatorNodeIdentity(leaf("function", "total_orders", {
            signature: "p_customer_id integer", label: "total_orders(p_customer_id integer)",
        }))).toBe(JSON.stringify(["function", "public", "total_orders", "p_customer_id integer"]));
        expect(navigatorNodeIdentity(schemaNode("sales")))
            .toBe(JSON.stringify(["schema", "sales", "", ""]));
        expect(navigatorNodeIdentity({ label: "Tables" }))
            .toBe(JSON.stringify(["category", "Tables"]));
    });

    it("tells a table from a same-named sequence", () => {
        expect(navigatorNodeIdentity(leaf("table", "orders_id_seq")))
            .not.toBe(navigatorNodeIdentity(leaf("sequence", "orders_id_seq")));
    });

    it("tells two overloads apart by signature", () => {
        expect(navigatorNodeIdentity(leaf("function", "total_orders", { signature: "" })))
            .not.toBe(navigatorNodeIdentity(leaf("function", "total_orders", { signature: "p_customer_id integer" })));
    });

    it("ignores the label, so a relabelled index keeps its identity", () => {
        expect(navigatorNodeIdentity(leaf("index", "orders_pkey", { table: "orders", label: "orders_pkey (on orders)" })))
            .toBe(navigatorNodeIdentity(leaf("index", "orders_pkey", { table: "invoices", label: "orders_pkey (on invoices)" })));
    });
});

describe("reconcileNodes", () => {
    it("U12: keeps existing objects, inserts new ones in fresh order", () => {
        const A = leaf("table", "a");
        const C = leaf("table", "c");
        const a = leaf("table", "a");
        const b = leaf("table", "b");
        const c = leaf("table", "c");

        const result = reconcileNodes([A, C], [a, b, c]);

        expect(result.children).toHaveLength(3);
        expect(result.children[0]).toBe(A);
        expect(result.children[1]).toBe(b);
        expect(result.children[2]).toBe(C);
        expect(result.kept).toEqual([{ existing: A, fresh: a }, { existing: C, fresh: c }]);
        expect(result.kept[0].existing).toBe(A);
        expect(result.kept[0].fresh).toBe(a);
        expect(result.changed).toEqual([]);
    });

    it("U13: drops an existing node the fresh list no longer has", () => {
        const A = leaf("table", "a");
        const B = leaf("table", "b");

        const result = reconcileNodes([A, B], [leaf("table", "a")]);

        expect(result.children).toHaveLength(1);
        expect(result.children[0]).toBe(A);
    });

    it("U14: a same-identity node with a new label/data is kept, updated and reported changed", () => {
        const existing = leaf("index", "orders_pkey", { table: "orders", label: "orders_pkey (on orders)" });
        const formerData = existing.data as DbObjectRef;
        const fresh = leaf("index", "orders_pkey", { table: "invoices", label: "orders_pkey (on invoices)" });

        const result = reconcileNodes([existing], [fresh]);

        expect(result.children[0]).toBe(existing);
        expect(existing.label).toBe("orders_pkey (on invoices)");
        expect(existing.data).toEqual(fresh.data);
        expect(result.changed).toEqual([existing]);
        expect(result.changed[0]).toBe(existing);
        expect(formerData.table).toBe("orders");
    });

    it("U15: fresh order wins, empty lists work, and no node's children are assigned", () => {
        const A = leaf("table", "a");
        const B = leaf("table", "b");

        const reordered = reconcileNodes([B, A], [leaf("table", "a"), leaf("table", "b")]);

        expect(reordered.children[0]).toBe(A);
        expect(reordered.children[1]).toBe(B);

        expect(reconcileNodes([A, B], []).children).toEqual([]);

        const x = leaf("table", "x");
        const y = leaf("table", "y");
        const fromEmpty = reconcileNodes([], [x, y]);

        expect(fromEmpty.children[0]).toBe(x);
        expect(fromEmpty.children[1]).toBe(y);
        expect(fromEmpty.kept).toEqual([]);

        // Categories with children on both sides: the merge never touches `children`.
        const existingLeaves = [leaf("table", "a")];
        const freshLeaves    = [leaf("table", "a"), leaf("table", "b")];
        const existingCat: TreeNode = { label: "Tables", children: existingLeaves };
        const freshCat: TreeNode    = { label: "Tables", children: freshLeaves };

        reconcileNodes([existingCat], [freshCat]);

        expect(existingCat.children).toBe(existingLeaves);
        expect(freshCat.children).toBe(freshLeaves);
        expect(existingLeaves).toHaveLength(1);
    });
});

describe("loadedSchemaNames (U16)", () => {
    it("returns the labels of roots whose children are loaded, an empty list included", () => {
        const roots: TreeNode[] = [
            { label: "a", children: [] },
            { label: "b" },
            { label: "c", children: [{ label: "x" }] },
        ];

        expect(loadedSchemaNames(roots)).toEqual(["a", "c"]);
    });
});
