// Pins RevealCoordinator's reveal/select wiring against the plan's
// `## Expected Behaviour` cases 15-23
// (plans/implemented/sqladmin-controller-split.md). Drives the coordinator
// with a stub ExplorerTree recording its calls — the `as unknown as
// ExplorerTree` technique tests/navigator/objectMenu.test.ts already uses for
// ObjectMenuActions.

import { describe, expect, it, vi } from "vitest";
import { RevealCoordinator } from "../../src/controller/revealCoordinator";
import type { NodeMatch } from "../../src/navigator/revealMatch";
import type { ExplorerTree } from "../../src/shell/explorerTree";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { DbObjectRef } from "../../src/contract";

/** A deferred promise, so a test can control exactly when `whenLoaded` settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });

    return { promise, resolve };
}

/** A minimal ExplorerTree stub recording every call the coordinator makes on it. */
function stubTree(revealed: TreeNode | undefined, whenLoaded: Promise<void> = Promise.resolve()): ExplorerTree {
    return {
        whenLoaded: vi.fn(() => whenLoaded),
        revealByPredicate: vi.fn(() => Promise.resolve(revealed)),
        selectNode: vi.fn(),
        expandNode: vi.fn(),
        refresh: vi.fn(),
    } as unknown as ExplorerTree;
}

const NODE: TreeNode = { label: "orders" } as TreeNode;
const MATCH: NodeMatch = () => true;

describe("RevealCoordinator.revealInNavigator (cases 15-19)", () => {
    it("case 15: on a match, shows the Database view, awaits load, reveals, then selects — never expands", async () => {
        const tree = stubTree(NODE);
        const showDatabaseView = vi.fn();
        const coordinator = new RevealCoordinator("default", "sqladmin");
        coordinator.setNavigator(tree);
        coordinator.setShowDatabaseView(showDatabaseView);

        coordinator.revealInNavigator(MATCH);
        await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

        expect(showDatabaseView).toHaveBeenCalledTimes(1);
        expect(tree.whenLoaded).toHaveBeenCalledTimes(1);
        expect(tree.revealByPredicate).toHaveBeenCalledWith(MATCH);
        expect(tree.selectNode).toHaveBeenCalledWith(NODE);
        expect(tree.expandNode).not.toHaveBeenCalled();
    });

    it("case 16: with { expand: true }, also expands after selecting", async () => {
        const tree = stubTree(NODE);
        const coordinator = new RevealCoordinator("default", "sqladmin");
        coordinator.setNavigator(tree);
        coordinator.setShowDatabaseView(vi.fn());

        coordinator.revealInNavigator(MATCH, { expand: true });
        await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

        expect(tree.selectNode).toHaveBeenCalledWith(NODE);
        expect(tree.expandNode).toHaveBeenCalledWith(NODE);

        const selectOrder = (tree.selectNode as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
        const expandOrder = (tree.expandNode as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
        expect(selectOrder).toBeLessThan(expandOrder);
    });

    it("case 17: with { open }, open runs synchronously with a still-pending promise, before whenLoaded settles", () => {
        const gate = deferred<void>();
        const tree = stubTree(NODE, gate.promise);
        const coordinator = new RevealCoordinator("default", "sqladmin");
        coordinator.setNavigator(tree);
        coordinator.setShowDatabaseView(vi.fn());

        let openCalled = false;
        let receivedPromise: Promise<TreeNode | undefined> | undefined;

        coordinator.revealInNavigator(MATCH, {
            open: revealed => {
                openCalled = true;
                receivedPromise = revealed;
            },
        });

        // Synchronous: no await, no microtask flush — open must already have run.
        expect(openCalled).toBe(true);
        expect(receivedPromise).toBeInstanceOf(Promise);
        // whenLoaded (gate.promise) has not been resolved yet, so selectNode
        // cannot have run — proving open ran before the reveal settled.
        expect(tree.selectNode).not.toHaveBeenCalled();

        gate.resolve();
    });

    it("case 18: when nothing matches, open still runs and selectNode is never called", async () => {
        const tree = stubTree(undefined);
        const coordinator = new RevealCoordinator("default", "sqladmin");
        coordinator.setNavigator(tree);
        coordinator.setShowDatabaseView(vi.fn());

        const open = vi.fn();
        coordinator.revealInNavigator(MATCH, { open });
        await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

        expect(open).toHaveBeenCalledTimes(1);
        expect(tree.selectNode).not.toHaveBeenCalled();
    });

    it("case 19: with no tree registered, the view selector still runs, open resolves undefined, nothing throws", async () => {
        const showDatabaseView = vi.fn();
        const coordinator = new RevealCoordinator("default", "sqladmin");
        coordinator.setShowDatabaseView(showDatabaseView);

        let resolved: TreeNode | undefined = NODE;
        const open = vi.fn((revealed: Promise<TreeNode | undefined>) => {
            void revealed.then(node => { resolved = node; });
        });

        expect(() => coordinator.revealInNavigator(MATCH, { open })).not.toThrow();
        await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

        expect(showDatabaseView).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledTimes(1);
        expect(resolved).toBeUndefined();
    });
});

describe("RevealCoordinator.revealInRoles (case 20)", () => {
    it("mirrors revealInNavigator against the roles tree and Roles-view selector, and never touches the navigator", async () => {
        const rolesTree = stubTree(NODE);
        const navigatorTree = stubTree(NODE);
        const showRolesView = vi.fn();
        const showDatabaseView = vi.fn();
        const coordinator = new RevealCoordinator("default", "sqladmin");
        coordinator.setRolesTree(rolesTree);
        coordinator.setNavigator(navigatorTree);
        coordinator.setShowRolesView(showRolesView);
        coordinator.setShowDatabaseView(showDatabaseView);

        coordinator.revealInRoles(MATCH);
        await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

        expect(showRolesView).toHaveBeenCalledTimes(1);
        expect(showDatabaseView).not.toHaveBeenCalled();
        expect(rolesTree.selectNode).toHaveBeenCalledWith(NODE);
        expect(navigatorTree.selectNode).not.toHaveBeenCalled();
        expect(navigatorTree.whenLoaded).not.toHaveBeenCalled();
    });
});

describe("RevealCoordinator.selectObject (case 21)", () => {
    it("a schema-less ref only switches the view; a schema-bearing ref reveals", async () => {
        const tree = stubTree(NODE);
        const showDatabaseView = vi.fn();
        const coordinator = new RevealCoordinator("default", "sqladmin");
        coordinator.setNavigator(tree);
        coordinator.setShowDatabaseView(showDatabaseView);

        const dbRef: DbObjectRef = { connectionId: "default", database: "sqladmin", kind: "database" };
        coordinator.selectObject(dbRef);

        expect(showDatabaseView).toHaveBeenCalledTimes(1);
        expect(tree.revealByPredicate).not.toHaveBeenCalled();

        const tableRef: DbObjectRef = { connectionId: "default", database: "sqladmin", schema: "public", name: "orders", kind: "table" };
        coordinator.selectObject(tableRef);
        await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

        expect(tree.revealByPredicate).toHaveBeenCalledTimes(1);
        expect(tree.selectNode).toHaveBeenCalledWith(NODE);
    });
});

describe("RevealCoordinator.refreshNavigator / selectNavigatorNode (case 22)", () => {
    it("delegate to the navigator when registered, and no-op silently otherwise", () => {
        const coordinator = new RevealCoordinator("default", "sqladmin");

        expect(() => coordinator.refreshNavigator()).not.toThrow();
        expect(() => coordinator.selectNavigatorNode(NODE)).not.toThrow();

        const tree = stubTree(NODE);
        coordinator.setNavigator(tree);

        coordinator.refreshNavigator();
        coordinator.selectNavigatorNode(NODE);

        expect(tree.refresh).toHaveBeenCalledTimes(1);
        expect(tree.selectNode).toHaveBeenCalledWith(NODE);
    });
});

describe("RevealCoordinator.findInNavigator (case 23)", () => {
    it("resolves the revealed node without selecting or expanding it, and calls the Database-view selector either way", async () => {
        const tree = stubTree(NODE);
        const showDatabaseView = vi.fn();
        const coordinator = new RevealCoordinator("default", "sqladmin");
        coordinator.setNavigator(tree);
        coordinator.setShowDatabaseView(showDatabaseView);

        const found = await coordinator.findInNavigator(MATCH);

        expect(found).toBe(NODE);
        expect(tree.selectNode).not.toHaveBeenCalled();
        expect(tree.expandNode).not.toHaveBeenCalled();
        expect(showDatabaseView).toHaveBeenCalledTimes(1);
    });

    it("resolves undefined when nothing matches, and when no navigator is registered", async () => {
        const noMatchTree = stubTree(undefined);
        const showDatabaseView = vi.fn();
        const withTree = new RevealCoordinator("default", "sqladmin");
        withTree.setNavigator(noMatchTree);
        withTree.setShowDatabaseView(showDatabaseView);

        await expect(withTree.findInNavigator(MATCH)).resolves.toBeUndefined();
        expect(showDatabaseView).toHaveBeenCalledTimes(1);

        const noTree = new RevealCoordinator("default", "sqladmin");
        const showDatabaseView2 = vi.fn();
        noTree.setShowDatabaseView(showDatabaseView2);

        await expect(noTree.findInNavigator(MATCH)).resolves.toBeUndefined();
        expect(showDatabaseView2).toHaveBeenCalledTimes(1);
    });
});
