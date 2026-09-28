// The navigator's targeted refresh, as pure logic: which parts of the tree a
// successful DDL can have changed (navigatorScopeFor), and how a fresh listing
// is merged into the nodes the tree already holds by identity, so every node
// that still exists keeps its object — and with it its expansion, selection
// and the scroll offset (reconcileNodes). NavigatorTree.refreshScope drives
// the Tree with these results; the logic lives here, with only `import type`
// imports, because NavigatorTree.ts pulls in library modules that touch
// `document` at import scope — the same split data/treeExpansion.ts and
// revealMatch.ts beside it already use, so this module runs under node vitest
// with no DOM.

import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { DbObjectKind, DbObjectRef } from "../contract";
import type { ExplorerTree } from "../shell/explorerTree";

/** What one successful DDL did, as far as the navigator cares. */
export interface DdlChange {
    action: "create" | "drop" | "rename" | "alter";
    /** The kind acted on: "schema" for a schema itself, "table" for a constraint change, "index" for an index. */
    kind: DbObjectKind;
    /** The schema holding the object (for a create: the schema it was created in; for kind "schema": that schema). */
    schema?: string;
    /** True when a drop ran with CASCADE. */
    cascade?: boolean;
    /** True when the executed SQL was user-edited or user-written. */
    sqlEdited?: boolean;
}

/** Which parts of the navigator a targeted refresh re-reads. */
export interface NavigatorScope {
    /** Re-read the schema list and merge the root level. */
    schemaList: boolean;
    /** Schemas whose object lists to re-read; "allLoaded" = every schema whose children are loaded. */
    schemas: readonly string[] | "allLoaded";
}

/** The navigator tree as the reveal coordinator sees it: an explorer tree plus the targeted refresh. */
export interface NavigatorExplorerTree extends ExplorerTree {
    /**
     * Re-read only the parts of the tree `scope` names and merge them into
     * the existing nodes, keeping every surviving node's state.
     *
     * @param scope - What to re-read.
     */
    refreshScope(scope: NavigatorScope): Promise<void>;
}

/** The result of merging fresh children into existing ones. */
export interface ReconcileResult {
    /** The new child list, in fresh order: kept existing objects plus new fresh ones. */
    children: TreeNode[];
    /** Kept existing nodes whose label or data was overwritten from the fresh twin. */
    changed: TreeNode[];
    /** Each kept existing node paired with its fresh twin, for a second-level merge. */
    kept: { existing: TreeNode; fresh: TreeNode }[];
}

/**
 * Map one DDL change to the parts of the navigator it can have affected. The
 * first matching rule wins: edited SQL could have done anything, so it
 * re-reads everything loaded; a schema change touches the root level (plus
 * every loaded schema for a cascading drop); a change with no schema is
 * treated as edited, defensively; a cascading drop can reach dependents in
 * any schema; anything else stays inside its own schema.
 *
 * @param change - What the DDL did.
 *
 * @returns The scope a targeted refresh should re-read.
 */
export function navigatorScopeFor(change: DdlChange): NavigatorScope {
    const cascadingDrop = change.action === "drop" && change.cascade === true;

    if (change.sqlEdited === true) {
        return { schemaList: true, schemas: "allLoaded" };
    }

    if (change.kind === "schema") {
        return { schemaList: true, schemas: cascadingDrop ? "allLoaded" : [] };
    }

    if (change.schema === undefined) {
        return { schemaList: true, schemas: "allLoaded" };
    }

    if (cascadingDrop) {
        return { schemaList: false, schemas: "allLoaded" };
    }

    return { schemaList: false, schemas: [change.schema] };
}

/**
 * A navigator node's identity across two fetches: kind, schema, name and
 * signature for a node carrying a ref (the kind separates a table from a
 * same-named sequence, the signature separates function overloads), and the
 * label for a category, which carries no data. The label is not part of a
 * leaf's identity, because an index's label names its table and changes on a
 * table rename while the index itself does not. `JSON.stringify` of the tuple
 * keeps punctuation inside quoted identifiers from colliding with a separator.
 *
 * @param node - A schema, category or object leaf node.
 *
 * @returns The identity string.
 */
export function navigatorNodeIdentity(node: TreeNode): string {
    const ref = node.data as DbObjectRef | undefined;

    if (ref === undefined) {
        return JSON.stringify(["category", node.label]);
    }

    return JSON.stringify([ref.kind, ref.schema ?? "", ref.name ?? "", ref.signature ?? ""]);
}

/**
 * Merge a fresh child list into the existing one by identity. The result keeps
 * the fresh order; each fresh node whose identity an existing node shares is
 * replaced by that existing object, whose `label`/`data` are overwritten from
 * the fresh twin when they differ. Existing nodes with no fresh twin are left
 * out. Mutates only the `label`/`data` of kept nodes — never any node's
 * `children`, which the caller commits through `Tree.setChildren`.
 *
 * @param existing - The children the tree holds now.
 * @param fresh - The children just fetched.
 *
 * @returns The merged list, the kept nodes that changed, and each kept pair.
 */
export function reconcileNodes(existing: readonly TreeNode[], fresh: readonly TreeNode[]): ReconcileResult {
    const byIdentity = new Map(existing.map(node => [navigatorNodeIdentity(node), node]));
    const children: TreeNode[] = [];
    const changed: TreeNode[] = [];
    const kept: ReconcileResult["kept"] = [];

    for (const freshNode of fresh) {
        const match = byIdentity.get(navigatorNodeIdentity(freshNode));

        if (match === undefined) {
            children.push(freshNode);
            continue;
        }

        if (match.label !== freshNode.label || !sameRef(match.data, freshNode.data)) {
            match.label = freshNode.label;
            // Assign the fresh object; the old ref is never mutated in place,
            // since an open tab or the inspector may still hold it.
            match.data = freshNode.data;
            changed.push(match);
        }

        children.push(match);
        kept.push({ existing: match, fresh: freshNode });
    }

    return { children, changed, kept };
}

/**
 * The schemas the tree has loaded: the label of each root whose `children`
 * are set (it was expanded at least once), in root order. An empty loaded
 * list counts as loaded.
 *
 * @param roots - The navigator's root (schema) nodes.
 *
 * @returns The loaded schemas' names.
 */
export function loadedSchemaNames(roots: readonly TreeNode[]): string[] {
    return roots.filter(node => node.children !== undefined).map(node => node.label);
}

/**
 * Compare two node payloads as `DbObjectRef`s, field by field. Two absent
 * payloads (category nodes) are equal; one absent payload never equals a
 * present one.
 *
 * @param a - One node's `data`.
 * @param b - The other node's `data`.
 *
 * @returns True when every ref field matches.
 */
function sameRef(a: unknown, b: unknown): boolean {
    if (a === undefined || b === undefined) {
        return a === b;
    }

    const left = a as DbObjectRef;
    const right = b as DbObjectRef;

    return left.connectionId === right.connectionId
        && left.database === right.database
        && left.schema === right.schema
        && left.name === right.name
        && left.kind === right.kind
        && left.signature === right.signature
        && left.isProcedure === right.isProcedure
        && left.table === right.table;
}
