import { describe, it, expect, vi } from "vitest";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import { collectExpandedPaths, TreeExpansionPersistence, labelNodeKey } from "../../src/data/treeExpansion";
import type { TreeExpansionHost } from "../../src/data/treeExpansion";
import type { TreeExpansionBinding } from "../../src/data/layoutStore";

/** A trivial in-memory binding fake, recording every `onExpanded` write in order. */
function fakeBinding(initial: string[][] | null = null): TreeExpansionBinding & { writes: string[][][] } {
    let stored: string[][] | null = initial;
    const writes: string[][][]    = [];

    return {
        writes,
        loadExpanded: () => stored,
        onExpanded  : paths => { stored = paths; writes.push(paths); },
    };
}

/** A trivial TreeExpansionHost fake over a fixed node set. */
function fakeHost(
    nodes: TreeNode[],
    expandedNodes: TreeNode[] = [],
    expandNodeAsync: (node: TreeNode) => Promise<boolean> = async () => true,
): TreeExpansionHost {
    return {
        getNodes        : () => nodes,
        getExpandedNodes: () => expandedNodes,
        expandNodeAsync,
    };
}

describe("collectExpandedPaths", () => {
    it("no expanded nodes returns []", () => {
        const roots: TreeNode[] = [{ label: "public" }, { label: "sales" }];

        expect(collectExpandedPaths(roots, new Set(), labelNodeKey)).toEqual([]);
    });

    it("one expanded root returns [[key]]", () => {
        const publicNode: TreeNode = { label: "public" };
        const roots = [publicNode, { label: "sales" }];

        expect(collectExpandedPaths(roots, new Set([publicNode]), labelNodeKey)).toEqual([["public"]]);
    });

    it("an expanded root with an expanded child returns both, parent first", () => {
        const tablesGroup: TreeNode = { label: "Tables", children: [] };
        const sales: TreeNode       = { label: "sales", children: [tablesGroup] };

        expect(collectExpandedPaths([sales], new Set([sales, tablesGroup]), labelNodeKey))
            .toEqual([["sales"], ["sales", "Tables"]]);
    });

    it("an expanded node under a collapsed parent is omitted, and so is the parent", () => {
        const tablesGroup: TreeNode = { label: "Tables", children: [] };
        const sales: TreeNode       = { label: "sales", children: [tablesGroup] };

        expect(collectExpandedPaths([sales], new Set([tablesGroup]), labelNodeKey)).toEqual([]);
    });

    it("a supplied nodeKey is applied at every level", () => {
        const usersGroup: TreeNode = { label: "Users (12)" };
        const nodeKey = (node: TreeNode): string => node.label.split(" ")[0];

        expect(collectExpandedPaths([usersGroup], new Set([usersGroup]), nodeKey)).toEqual([["Users"]]);
    });

    it("a node in the expanded set that is not reachable from roots is omitted", () => {
        const orphan: TreeNode      = { label: "orphan" };
        const publicNode: TreeNode  = { label: "public" };

        expect(collectExpandedPaths([publicNode], new Set([orphan]), labelNodeKey)).toEqual([]);
    });
});

describe("TreeExpansionPersistence — save()", () => {
    it("writes exactly what collectExpandedPaths produces for the host's current nodes and expanded set", () => {
        const tablesGroup: TreeNode = { label: "Tables", children: [] };
        const sales: TreeNode       = { label: "sales", children: [tablesGroup] };
        const host                  = fakeHost([sales], [sales, tablesGroup]);
        const binding                = fakeBinding();
        const persistence           = new TreeExpansionPersistence(host, binding);

        persistence.save();

        expect(binding.writes).toEqual([[["sales"], ["sales", "Tables"]]]);
    });
});

describe("TreeExpansionPersistence — restore()", () => {
    it("with no saved state resolves false and calls expandNodeAsync zero times", async () => {
        const expandNodeAsync = vi.fn(async () => true);
        const host            = fakeHost([], [], expandNodeAsync);
        const binding         = fakeBinding(null);
        const persistence     = new TreeExpansionPersistence(host, binding);

        await expect(persistence.restore()).resolves.toBe(false);
        expect(expandNodeAsync).not.toHaveBeenCalled();
    });

    it("with [] saved resolves true and calls expandNodeAsync zero times", async () => {
        const expandNodeAsync = vi.fn(async () => true);
        const host            = fakeHost([], [], expandNodeAsync);
        const binding         = fakeBinding([]);
        const persistence     = new TreeExpansionPersistence(host, binding);

        await expect(persistence.restore()).resolves.toBe(true);
        expect(expandNodeAsync).not.toHaveBeenCalled();
    });

    it("with [[\"sales\"], [\"sales\", \"Tables\"]] calls expandNodeAsync three times, in order: sales, sales again, then its Tables child", async () => {
        const tablesGroup: TreeNode = { label: "Tables", children: [] };
        const sales: TreeNode       = { label: "sales", children: [tablesGroup] };
        const calls: string[]       = [];
        const expandNodeAsync = vi.fn(async (node: TreeNode) => { calls.push(node.label); return true; });
        const host        = fakeHost([sales], [], expandNodeAsync);
        const binding     = fakeBinding([["sales"], ["sales", "Tables"]]);
        const persistence = new TreeExpansionPersistence(host, binding);

        await persistence.restore();

        expect(calls).toEqual(["sales", "sales", "Tables"]);
        expect(expandNodeAsync).toHaveBeenCalledTimes(3);
    });

    it("a path whose first segment matches no root is skipped, and later paths still restore", async () => {
        const publicNode: TreeNode = { label: "public" };
        const calls: string[]      = [];
        const expandNodeAsync = vi.fn(async (node: TreeNode) => { calls.push(node.label); return true; });
        const host        = fakeHost([publicNode], [], expandNodeAsync);
        const binding     = fakeBinding([["missing"], ["public"]]);
        const persistence = new TreeExpansionPersistence(host, binding);

        await persistence.restore();

        expect(calls).toEqual(["public"]);
    });

    it("matches a saved segment against a supplied nodeKey, not the node's label", async () => {
        const usersGroup: TreeNode = { label: "Users (12)", children: [] };
        const calls: string[]      = [];
        const expandNodeAsync = vi.fn(async (node: TreeNode) => { calls.push(node.label); return true; });
        const nodeKey = (node: TreeNode): string => node.label.split(" ")[0];
        const host        = fakeHost([usersGroup], [], expandNodeAsync);
        const binding     = fakeBinding([["Users"]]);
        const persistence = new TreeExpansionPersistence(host, binding, nodeKey);

        await persistence.restore();

        expect(calls).toEqual(["Users (12)"]);
    });

    it("when expandNodeAsync resolves false for a segment, the rest of that path is abandoned, and later paths still restore", async () => {
        const failChild: TreeNode  = { label: "Broken", children: [] };
        const failSchema: TreeNode = { label: "fail", children: [failChild] };
        const okSchema: TreeNode   = { label: "ok" };
        const calls: string[]      = [];
        const expandNodeAsync = vi.fn(async (node: TreeNode) => {
            calls.push(node.label);
            return node.label !== "fail";
        });
        const host        = fakeHost([failSchema, okSchema], [], expandNodeAsync);
        const binding     = fakeBinding([["fail", "Broken"], ["ok"]]);
        const persistence = new TreeExpansionPersistence(host, binding);

        await persistence.restore();

        expect(calls).toEqual(["fail", "ok"]);
    });

    it("with a fake host whose expandNodeAsync calls save() (standing in for the tree's \"expand\" event), no write reaches the binding until restore() resolves, and exactly one write happens then", async () => {
        const publicNode: TreeNode = { label: "public" };
        const binding = fakeBinding([["public"]]);
        let persistence!: TreeExpansionPersistence;
        const host: TreeExpansionHost = {
            getNodes        : () => [publicNode],
            getExpandedNodes: () => [publicNode],
            expandNodeAsync : async () => {
                persistence.save();

                return true;
            },
        };

        persistence = new TreeExpansionPersistence(host, binding);
        await persistence.restore();

        expect(binding.writes).toEqual([[["public"]]]);
    });

    it("the final save prunes a saved path whose node is gone", async () => {
        const publicNode: TreeNode = { label: "public" };
        const host        = fakeHost([publicNode], [publicNode]);
        const binding     = fakeBinding([["dropped"], ["public"]]);
        const persistence = new TreeExpansionPersistence(host, binding);

        await persistence.restore();

        expect(binding.loadExpanded()).toEqual([["public"]]);
    });

    it("the final save retains (does not prune) a path whose expansion failed, unlike a path whose node is gone", async () => {
        const failSchema: TreeNode = { label: "fail" };
        const okSchema: TreeNode   = { label: "ok" };
        const calls: string[]      = [];
        const expandNodeAsync = vi.fn(async (node: TreeNode) => {
            calls.push(node.label);

            return node.label !== "fail";
        });
        const host        = fakeHost([failSchema, okSchema], [okSchema], expandNodeAsync);
        const binding     = fakeBinding([["fail"], ["ok"]]);
        const persistence = new TreeExpansionPersistence(host, binding);

        await persistence.restore();

        // "ok" is genuinely expanded (reflected by getExpandedNodes()); "fail"
        // never expanded, but survives the closing save verbatim rather than
        // being pruned like a path whose node is gone.
        expect(binding.loadExpanded()).toEqual([["ok"], ["fail"]]);

        // A later load (a fresh persistence instance, standing in for the next
        // page load) re-reads the retained path and retries it.
        calls.length = 0;
        const again = new TreeExpansionPersistence(host, binding);
        await again.restore();

        expect(calls).toContain("fail");
    });
});
