// Persists which nodes inside a Database/Roles rail tree are expanded, so a
// page reload restores the pre-reload shape instead of throwing it away. Its
// only imports are `import type`s — nothing else may be imported from the
// library — so this module stays free of the DOM side effects library
// component modules run at import scope and keeps running under the node
// vitest environment. Consumed by NavigatorTree/RolesTree; see
// LayoutStore.bindTreeExpansion for the storage side.

import type { TreeNode }              from "@jimka/typescript-ui/component/tree";
import type { TreeExpansionBinding }  from "./layoutStore";

/** Derives one node's path segment. Sibling segments must be unique and stable across reloads. */
export type NodeKey = (node: TreeNode) => string;

/** The default {@link NodeKey}: the node's own label. */
export const labelNodeKey: NodeKey = node => node.label;

/**
 * Every expanded node's root-to-node key path, parents before children,
 * skipping any node with a collapsed ancestor. Descends only into expanded
 * nodes, which is what makes a collapsed parent hide its descendants from the
 * saved set.
 *
 * @param roots - The tree's current top-level nodes.
 * @param expanded - The tree's currently expanded nodes.
 * @param nodeKey - Derives one node's path segment.
 *
 * @returns Parent-before-child key paths for every visibly expanded node.
 */
export function collectExpandedPaths(
    roots: TreeNode[], expanded: ReadonlySet<TreeNode>, nodeKey: NodeKey,
): string[][] {
    const paths: string[][] = [];

    const walk = (nodes: TreeNode[], prefix: string[]): void => {
        for (const node of nodes) {
            if (!expanded.has(node)) {
                continue;
            }

            const path = [...prefix, nodeKey(node)];

            paths.push(path);
            walk(node.children ?? [], path);
        }
    };

    walk(roots, []);

    return paths;
}

/** The subset of `Tree` this module drives, so the persistence logic unit-tests against a plain object. */
export interface TreeExpansionHost {
    getNodes(): TreeNode[];
    getExpandedNodes(): TreeNode[];
    expandNodeAsync(node: TreeNode): Promise<boolean>;
}

/** Saves a tree's expanded nodes to a {@link TreeExpansionBinding} and restores them on load. */
export class TreeExpansionPersistence {
    private readonly _tree:    TreeExpansionHost;
    private readonly _binding: TreeExpansionBinding;
    private readonly _nodeKey: NodeKey;
    private _restoring: boolean = false;

    /**
     * @param tree - The tree this persistence drives, read for its current nodes/expanded set.
     * @param binding - Where the expanded paths are loaded from and saved to.
     * @param nodeKey - Derives one node's path segment; defaults to the node's label.
     */
    constructor(tree: TreeExpansionHost, binding: TreeExpansionBinding, nodeKey: NodeKey = labelNodeKey) {
        this._tree    = tree;
        this._binding = binding;
        this._nodeKey = nodeKey;
    }

    // An arrow field: both trees register it by reference on "expand"/"collapse",
    // which would lose `this` for a plain method (COMPONENT_CONVENTIONS.md (c)).
    save = (): void => {
        if (this._restoring) {
            return;
        }

        this._write([]);
    };

    /**
     * Re-expand every saved path.
     *
     * @returns Whether a saved set existed at all — `false` only when nothing
     * was ever saved, so the caller's first-run default expansion still runs.
     */
    async restore(): Promise<boolean> {
        const paths = this._binding.loadExpanded();

        if (paths === null) {
            return false;
        }

        this._restoring = true;
        // Paths abandoned because `expandNodeAsync` rejected a segment's lazy
        // load — a transient failure, not evidence the node is gone. These are
        // excluded from the closing prune so the next load retries them; see
        // `_expandPath`'s "missing" vs "failed" distinction.
        const retryable: string[][] = [];

        try {
            for (const path of paths) {
                const outcome = await this._expandPath(path);

                if (outcome === "failed") {
                    retryable.push(path);
                }
            }
        } finally {
            this._restoring = false;
        }

        // Rewrites the set now that the tree has settled, dropping any saved
        // path whose node no longer exists, but keeping `retryable` verbatim.
        this._write(retryable);

        return true;
    }

    /**
     * Write the tree's current expanded set, plus `retain` appended verbatim.
     *
     * @param retain - Saved paths to keep even though they aren't (yet)
     * reflected in the tree's actual expanded set — see `restore`'s `retryable`.
     */
    private _write(retain: string[][]): void {
        const expanded = new Set(this._tree.getExpandedNodes());
        const paths    = collectExpandedPaths(this._tree.getNodes(), expanded, this._nodeKey);

        this._binding.onExpanded([...paths, ...retain]);
    }

    /**
     * Walk one saved path from the roots down, expanding each segment; stop at
     * the first segment that is missing or fails to load. Every path is walked
     * from the roots independently, so an ancestor shared with an earlier path
     * is expanded again — a no-op that resolves `true` immediately.
     *
     * @param path - One saved root-to-node key path.
     *
     * @returns `"expanded"` when every segment committed; `"missing"` when a
     * segment matched no current sibling (the node is genuinely gone — safe to
     * prune); `"failed"` when a segment's node was found but its lazy load
     * rejected (a transient failure — must not be pruned).
     */
    private async _expandPath(path: string[]): Promise<"expanded" | "missing" | "failed"> {
        let siblings = this._tree.getNodes();

        for (const segment of path) {
            const node = siblings.find(candidate => this._nodeKey(candidate) === segment);

            if (node === undefined) {
                return "missing";
            }

            const expanded = await this._tree.expandNodeAsync(node);

            if (!expanded) {
                return "failed";
            }

            siblings = node.children ?? [];
        }

        return "expanded";
    }
}
