// The lazy object navigator: a Tree rooted at the logged-in database's schemas,
// whose levels (schemas -> Tables/Views/Materialized Views/Sequences/Functions/
// Types category groups -> object leaves) are fetched on first expansion via
// the introspection api. The app connects to one database per session, so
// there is no database level. Each
// object leaf carries its
// DbObjectRef on node.data; selecting one shows its metadata in the Properties
// inspector, and double-clicking a relation (or its "Show data" context item)
// opens the object in the Dock through the controller. Category nodes carry no
// data, so selecting them is a no-op. The Tree caches loaded children, so a
// collapse/re-expand does not refetch.

import { callable } from "@jimka/typescript-ui/core";
import { Tree, IconLabelTreeNodeRenderer }      from "@jimka/typescript-ui/component/tree";
import type { TreeNode }                        from "@jimka/typescript-ui/component/tree";
import { Menu }                                 from "@jimka/typescript-ui/overlay";
import { Glyph }                                from "@jimka/typescript-ui/component/display";
import { plus }                                 from "@jimka/typescript-ui/glyphs/solid/plus";
import { pencil }                               from "@jimka/typescript-ui/glyphs/solid/pencil";
import { trash }                                from "@jimka/typescript-ui/glyphs/solid/trash";
import { arrows_rotate }                        from "@jimka/typescript-ui/glyphs/solid/arrows_rotate";
import { play }                                 from "@jimka/typescript-ui/glyphs/solid/play";
import { sitemap }                              from "@jimka/typescript-ui/glyphs/solid/sitemap";
import { share_nodes }                          from "@jimka/typescript-ui/glyphs/solid/share_nodes";
import { circle_nodes }                         from "@jimka/typescript-ui/glyphs/solid/circle_nodes";
import type { DbObjectKind, DbObjectRef }       from "../contract";
import { getFunctions, getObjects, getSchemas, getTypes } from "../data/api";
import { KIND_GLYPH }                           from "./objectGlyphs";
import { isRelationKind, objectCategories }     from "./objectKinds";
import { showObjectMenu }                       from "./objectMenu";
import type { SqlAdminController }              from "../SqlAdminController";

// The table-ddl launcher items' glyphs (create/rename/drop table), plus the
// view-matview-ddl phase's refresh glyph (Edit/Drop reuse "pencil"/"trash").
// "arrow-up-1-9"/"code"/"cube" (the sequence/function/type-leaf glyphs, also
// reused for their "Create …" menu items above) are registered by
// objectGlyphs.ts, already imported above for KIND_GLYPH. The "Show" submenus'
// distinct diagram glyphs — sitemap (inheritance), share-nodes (dependencies),
// circle-nodes (whole-database diagram) — are registered here (and on the
// controller for the matching dock tabs); "diagram-project"/"table-columns"/
// "file-code" (the schema/relations diagram, structure, and definition items)
// come from the controller's own registration.
Glyph.register(plus, pencil, trash, arrows_rotate, play, sitemap, share_nodes, circle_nodes);

/**
 * One object leaf, merged from whichever endpoint supplied it: `/objects`
 * (table/view/materializedView/sequence) or the function-type-ddl phase's
 * dedicated `/functions`/`/types` (a function's identity signature has no
 * home in `/objects`' flat `{name, kind}` shape — see
 * plans/implemented/function-type-ddl.md's listing decision). Both optional
 * fields are set only on a function leaf.
 */
interface DbObject {
    name: string;
    kind: DbObjectKind;
    signature?: string;
    isProcedure?: boolean;
}

/**
 * The navigator's object categories, in display order — derived from the
 * objectKinds.ts registry (the single source a new listed kind is added to)
 * rather than a hand-maintained array. Each groups the leaves of one wire
 * kind under a synthetic, non-selectable parent node; an empty category is
 * omitted so a schema shows only the groups it actually has.
 */
const OBJECT_CATEGORIES: { label: string; kind: DbObjectKind }[] = objectCategories();

// Category group nodes carry no data (they are non-selectable parents); show the
// glyph of the objects they group, keyed by their synthetic label.
const CATEGORY_GLYPH = new Map(OBJECT_CATEGORIES.map(c => [c.label, KIND_GLYPH[c.kind]]));

/**
 * True for the object kinds that open in the Dock and offer the relation
 * context-menu items — derived from the objectKinds.ts registry's
 * `isRelation` flag. A sequence is a listed leaf (it has a category) but is
 * NOT a relation: it has no rows, so no data tab / double-click open.
 */
function isRelation(kind: DbObjectKind | undefined): boolean {
    return isRelationKind(kind);
}

/**
 * Resolve a row's glyph: an object leaf / database / schema by its kind, a
 * category group by its label. Falls back to a folder for anything unmapped.
 */
function nodeGlyph(node: TreeNode): string {
    const ref = node.data as DbObjectRef | undefined;

    if (ref) {
        return KIND_GLYPH[ref.kind] ?? "folder";
    }

    return CATEGORY_GLYPH.get(node.label) ?? "folder";
}

/** A `Tree` that also exposes a `refresh` action reloading its top level. */
export interface ExplorerTree extends Tree {
    refresh(): void;
}

/** Build the navigator Tree, wired to open tables and report load errors. */
class NavigatorTree extends Tree implements ExplorerTree {
    private readonly controller: SqlAdminController;
    private readonly conn:       string;
    // The logged-in database, whose schemas are the tree's top level. `?? ""`
    // covers only DOM-less callers that omit it; in-app it is always set.
    private readonly database:   string;
    private readonly contextMenu = Menu();

    constructor(controller: SqlAdminController) {
        super();
        this.controller = controller;
        this.conn       = controller.connectionId;
        this.database   = controller.database ?? "";

        // Render each row as a kind glyph beside its label.
        this.setRendererFactory(() => new IconLabelTreeNodeRenderer(nodeGlyph));

        // A single click only selects: it shows the object's metadata in the
        // Properties inspector without opening anything. Opening (and executing) a
        // relation's data tab is reserved for a double-click and the "Show data"
        // context item — see below.
        this.on("selection", (nodes: TreeNode[]) => {
            const node = nodes[0];
            const ref  = node?.data as DbObjectRef | undefined;

            if (!node || !ref) {
                return;
            }

            void this.controller.showProperties(ref);
        });

        // A double-click on a table, view, or materialized view opens (or focuses)
        // its data tab in the Dock and loads it — the behaviour a single click used
        // to have. Non-relation nodes (schemas, categories) have no tab.
        this.on("dblclick", (node: TreeNode) => {
            const ref = node.data as DbObjectRef | undefined;

            // A sequence has no rows (isRelation is false for it — see
            // objectKinds.ts), so it opens the read-only info tab instead of a
            // data tab. Checked before the isRelation guard below, mirroring
            // the sequence branch in the contextmenu handler.
            if (ref && ref.kind === "sequence") {
                void this.controller.openSequence(ref, node);

                return;
            }

            // A function/procedure has no rows — double-click runs it (a query
            // tab seeded with a SELECT/CALL, auto-run when it takes no
            // arguments), the closest thing to a table's data tab. Its
            // definition is reached from the context menu's "Show definition".
            if (ref && ref.kind === "function") {
                this.controller.executeFunction(ref);

                return;
            }

            if (ref && isRelation(ref.kind)) {
                void this.controller.openTable(ref, node);
            }
        });

        // Right-clicking any object shows its context menu, built by the shared
        // buildObjectMenuItems (also used by the diagram panels — see
        // objectMenu.ts) so the tree and every diagram agree on one menu per
        // object kind.
        this.on("contextmenu", (node: TreeNode, event: MouseEvent) => {
            const ref = node.data as DbObjectRef | undefined;

            if (!ref) {
                return;
            }

            showObjectMenu(this.contextMenu, ref, this.controller, event, node);
        });

        this.on("loaderror", (_node: TreeNode, error: unknown) => this.controller.notifyError(error));

        // Let the controller drive selection when a dock tab is focused.
        this.controller.setNavigator(this);

        // (Re)load the top-level schemas; the lazy object levels reload on their
        // next expansion. Used for the initial load.
        this.refresh();
    }

    // (Re)load the top-level schemas of the logged-in database (there is no
    // database level); the lazy object levels reload on their next expansion.
    // Used for the initial load and the section refresh tool. A public
    // arrow-function field: refreshTool/bindRefreshShortcut hold this by
    // reference, which would lose `this` if it were a plain method.
    refresh = (): void => {
        void loadSchemas(this.conn, this.database)
            .then(nodes => {
                this.setNodes(nodes);

                // A single-schema database: expand that lone schema so its
                // category folders show immediately. revealByPredicate expands
                // the match's ANCESTORS (not the match), so match the schema's
                // first category node — the only nodes with no `data` (see
                // categoryNode) — to expand exactly the schema, one level. An
                // empty schema has no category to match, so nothing expands.
                if (nodes.length === 1) {
                    void this.revealByPredicate(data => data === undefined);
                }
            })
            .catch(error => this.controller.notifyError(error));
    };
}

async function loadSchemas(conn: string, database: string): Promise<TreeNode[]> {
    const schemas = await getSchemas(conn, database);

    return schemas.map(s => schemaNode(conn, database, s.name));
}

function schemaNode(conn: string, database: string, schema: string): TreeNode {
    return {
        label       : schema,
        hasChildren : true,
        data        : { connectionId: conn, database, schema, kind: "schema" } satisfies DbObjectRef,
        loadChildren: () => loadObjects(conn, database, schema),
    };
}

/**
 * Fetch a schema's tables/views/matviews/sequences (`/objects`) and its
 * functions/procedures and types (`/functions`/`/types`) in parallel, and
 * merge them into one `DbObject[]` — the same combined list `categoryNode`
 * groups by kind regardless of which endpoint supplied a given object, so a
 * function/type leaf flows through the identical category/glyph/`isRelation`
 * pipeline a sequence leaf already does (see the function-type-ddl plan's
 * listing decision).
 */
async function loadObjects(conn: string, database: string, schema: string): Promise<TreeNode[]> {
    const [objects, functions, types] = await Promise.all([
        getObjects(conn, database, schema),
        getFunctions(conn, database, schema),
        getTypes(conn, database, schema),
    ]);

    const combined: DbObject[] = [
        ...objects,
        ...functions.map(f => ({
            name: f.name, kind: "function" as const, signature: f.signature, isProcedure: f.isProcedure,
        })),
        ...types.map(t => ({ name: t.name, kind: "type" as const })),
    ];

    return OBJECT_CATEGORIES
        .map(category => categoryNode(category, combined, conn, database, schema))
        .filter((node): node is TreeNode => node !== null);
}

/**
 * Build a category group node (Tables / Views / Materialized Views) with its
 * object leaves pre-populated, or `null` when the schema has none of that kind.
 * The node carries no `data`, so selecting it is a no-op.
 */
function categoryNode(
    category: { label: string; kind: DbObjectKind },
    objects : DbObject[],
    conn    : string,
    database: string,
    schema  : string,
): TreeNode | null {
    const members = objects.filter(o => o.kind === category.kind);

    if (members.length === 0) {
        return null;
    }

    return {
        label   : category.label,
        children: members.map(o => objectLeaf(o, conn, database, schema)),
    };
}

/**
 * Build one object leaf node carrying its DbObjectRef on `data`. A
 * function's `signature`/`isProcedure` are carried onto the ref only when
 * present (a function leaf) — every other kind omits them.
 */
function objectLeaf(o: DbObject, conn: string, database: string, schema: string): TreeNode {
    return {
        label: leafLabel(o),
        data : {
            connectionId: conn, database, schema, name: o.name, kind: o.kind,
            ...(o.signature !== undefined ? { signature: o.signature } : {}),
            ...(o.isProcedure !== undefined ? { isProcedure: o.isProcedure } : {}),
        } satisfies DbObjectRef,
    };
}

/**
 * The tree label for an object leaf. A function/procedure shows its argument
 * signature — `total_orders(p_customer_id integer)`, `total_orders()` — so two
 * overloads of one name are visibly distinct in the tree; the ref still
 * carries the bare `name`. Every other kind shows its plain name.
 */
function leafLabel(o: DbObject): string {
    if (o.kind === "function") {
        return `${o.name}(${o.signature ?? ""})`;
    }

    return o.name;
}

const NavigatorTreeCallable = callable(NavigatorTree);
type NavigatorTreeCallable = NavigatorTree;
export { NavigatorTreeCallable as NavigatorTree };
