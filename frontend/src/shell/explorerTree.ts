// The explorer-tree load lifecycle both sidebar rails (NavigatorTree,
// RolesTree) share: arm the load signal, fetch, map to nodes, restore any
// saved expansion, and — only on a first run with nothing saved — apply the
// kind-specific default expansion. ExplorerTreeBase owns that whole chain
// once; each subclass supplies just its three moving parts (load, toNodes,
// applyDefaultExpansion). Mirrors shell/treeExplorerView.ts, which already
// converged the two explorer *views* one layer up into a shared base with
// thin per-rail subclasses.

import { Tree }                     from "@jimka/typescript-ui/component/tree";
import type { TreeNode }            from "@jimka/typescript-ui/component/tree";
import { TreeExpansionPersistence } from "../data/treeExpansion";
import type { NodeKey }             from "../data/treeExpansion";
import type { TreeExpansionBinding } from "../data/layoutStore";
import { LoadSignal }               from "../data/loadSignal";
import type { SqlAdminController }  from "../SqlAdminController";

/** A `Tree` that also exposes a `refresh` action reloading its top level. */
export interface ExplorerTree extends Tree {
    refresh(): void;
    /**
     * Resolves once the tree's top level has loaded; already resolved when no
     * load is running. Await it before a reveal, which searches the tree's
     * current nodes and would silently find nothing in a tree still filling.
     */
    whenLoaded(): Promise<void>;
}

/**
 * Shared base for a sidebar explorer tree: owns the expand/collapse
 * persistence wiring and the arm/fetch/map/restore/default-expand/settle load
 * chain, so NavigatorTree and RolesTree each supply only their own fetch,
 * node mapping, and first-run default. Does not call `refresh()` itself —
 * subclass fields (`conn`, `database`, `contextMenu`, ...) are assigned after
 * `super()` returns, so a base-constructor `refresh()` would run against
 * still-`undefined` subclass state; each subclass keeps its own trailing
 * `this.refresh()` call instead.
 */
export abstract class ExplorerTreeBase<TData> extends Tree implements ExplorerTree {
    protected readonly controller: SqlAdminController;

    private readonly _expansion: TreeExpansionPersistence;
    private readonly _loaded: LoadSignal = new LoadSignal();

    /**
     * @param controller - The mediator, held for `notifyError` on a failed load.
     * @param binding - Where this rail's expanded-node paths are loaded from and saved to.
     * @param nodeKey - Derives one node's path segment; defaults to the node's label.
     */
    constructor(controller: SqlAdminController, binding: TreeExpansionBinding, nodeKey?: NodeKey) {
        super();
        this.controller = controller;
        this._expansion = new TreeExpansionPersistence(this, binding, nodeKey);
        this.on("expand",   this._expansion.save);
        this.on("collapse", this._expansion.save);
    }

    // (Re)load the tree's top level; used for the initial load and the
    // section refresh tool. A public arrow-function field: refreshTool/
    // bindRefreshShortcut hold this by reference, which would lose `this` if
    // it were a plain method.
    refresh = (): void => {
        this._loaded.arm();

        void this.load()
            .then(async data => {
                const nodes = this.toNodes(data);

                this.setNodes(nodes);

                const restored = await this._expansion.restore();

                // Only when the user has no saved expansion of their own.
                if (!restored) {
                    await this.applyDefaultExpansion(data, nodes);
                }
            })
            .catch(error => this.controller.notifyError(error))
            // After the whole chain — the expansion restore included — so a
            // waiting reveal never races the restore into re-collapsing the
            // path it just opened. Attached after the .catch so the signal
            // settles on the failure path too, rather than depending on
            // handler order.
            .finally(() => this._loaded.settle());
    };

    /**
     * @returns A promise resolving once {@link refresh}'s load chain has
     * finished; an already-resolved one when no load is running.
     */
    whenLoaded(): Promise<void> {
        return this._loaded.whenSettled();
    }

    /** Fetch this rail's top-level payload. */
    protected abstract load(): Promise<TData>;

    /** Map the fetched payload to the tree's top-level nodes. */
    protected abstract toNodes(data: TData): TreeNode[];

    /**
     * Apply this rail's first-run default expansion — run only when
     * `refresh`'s restore found no saved expansion of the user's own. A
     * no-op by default; a subclass overrides it when it has one. An override
     * that reveals a node asynchronously must return that promise: the load
     * signal settles only once this resolves, and an unawaited reveal risks
     * being scrolled away from by a later one that lands first.
     */
    protected applyDefaultExpansion(_data: TData, _nodes: TreeNode[]): void | Promise<void> {
        // No default expansion unless a subclass overrides this.
    }
}
