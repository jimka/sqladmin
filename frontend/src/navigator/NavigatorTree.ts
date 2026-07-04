// The lazy object navigator: a Tree whose levels (databases -> schemas ->
// Tables/Views/Materialized Views category groups -> object leaves) are fetched
// on first expansion via the introspection api. Each object leaf carries its
// DbObjectRef on node.data; selecting one shows its metadata in the Properties
// inspector, and double-clicking a relation (or its "Show data" context item)
// opens the object in the Dock through the controller. Category nodes carry no
// data, so selecting them is a no-op. The Tree caches loaded children, so a
// collapse/re-expand does not refetch.

import { Tree }                                 from "@jimka/typescript-ui/component/tree";
import type { TreeNode }                        from "@jimka/typescript-ui/component/tree";
import { Menu }                                 from "@jimka/typescript-ui/overlay";
import type { MenuItemConfig }                  from "@jimka/typescript-ui/component/container";
import type { DbObjectKind, DbObjectRef }       from "../contract";
import { getDatabases, getObjects, getSchemas } from "../data/api";
import type { SqlAdminController }              from "../SqlAdminController";

/** One object leaf as returned by the objects endpoint. */
interface DbObject {
    name: string;
    kind: DbObjectKind;
}

/**
 * The navigator's object categories, in display order. Each groups the leaves
 * of one wire kind under a synthetic, non-selectable parent node; an empty
 * category is omitted so a schema shows only the groups it actually has.
 */
const OBJECT_CATEGORIES: { label: string; kind: DbObjectKind }[] = [
    { label: "Tables", kind: "table" },
    { label: "Views", kind: "view" },
    { label: "Materialized Views", kind: "materializedView" },
];

/** True for the object kinds that open in the Dock and offer a context menu. */
function isRelation(kind: DbObjectKind | undefined): boolean {
    return kind === "table" || kind === "view" || kind === "materializedView";
}

/** A built explorer tree plus a refresh action that reloads its top level. */
export interface ExplorerTree {
    tree:    Tree;
    refresh: () => void;
}

/** Build the navigator Tree, wired to open tables and report load errors. */
export function NavigatorTree(controller: SqlAdminController): ExplorerTree {
    const conn        = controller.connectionId;
    const tree        = Tree();
    const contextMenu = Menu();

    // A single click only selects: it shows the object's metadata in the
    // Properties inspector without opening anything. Opening (and executing) a
    // relation's data tab is reserved for a double-click and the "Show data"
    // context item — see below.
    tree.on("selection", (nodes: TreeNode[]) => {
        const node = nodes[0];
        const ref  = node?.data as DbObjectRef | undefined;

        if (!node || !ref) {
            return;
        }

        void controller.showProperties(ref);
    });

    // A double-click on a table, view, or materialized view opens (or focuses)
    // its data tab in the Dock and loads it — the behaviour a single click used
    // to have. Non-relation nodes (databases, schemas, categories) have no tab.
    tree.on("dblclick", (node: TreeNode) => {
        const ref = node.data as DbObjectRef | undefined;

        if (ref && isRelation(ref.kind)) {
            void controller.openTable(ref, node);
        }
    });

    // Right-clicking a table/view/matview offers, in a separate tab each: "open
    // as query" (a generated SELECT in a query panel) first, then — below a
    // separator — its structure and, for a (materialized) view, its SQL definition.
    tree.on("contextmenu", (node: TreeNode, event: MouseEvent) => {
        const ref = node.data as DbObjectRef | undefined;

        if (!ref || !isRelation(ref.kind)) {
            return;
        }

        const items: MenuItemConfig[] = [
            // "Show data" mirrors the double-click: open (or focus) the relation's
            // data tab and load it. The glyphs match the tabs each item opens.
            { text: "Show data", glyph: "table", action: () => void controller.openTable(ref, node) },
            { text: "Open as query", glyph: "terminal", action: () => controller.openQueryFor(ref) },
            { separator: true },
            { text: "Open structure", glyph: "table-columns", action: () => void controller.openStructure(ref, node) },
        ];

        // Only a (materialized) view has a definition; a table has none.
        if (ref.kind === "view" || ref.kind === "materializedView") {
            items.push({ text: "Open definition", glyph: "file-code", action: () => void controller.openDefinition(ref, node) });
        }

        // Export streams the full relation server-side (not the loaded page), so a
        // large table/view exports without bulk-loading the grid.
        items.push({ separator: true });
        items.push({ text: "Export", glyph: "file-export", submenu: { label: "Export", items: [
            { text: "CSV (.csv)",   glyph: "file-csv",  action: () => controller.exportTable(ref, "csv") },
            { text: "JSON (.json)", glyph: "file-code", action: () => controller.exportTable(ref, "json") },
        ] } });

        contextMenu.show(event.clientX, event.clientY, items);
    });

    tree.on("loaderror", (_node: TreeNode, error: unknown) => controller.notifyError(error));

    // Let the controller drive selection when a dock tab is focused.
    controller.setNavigator(tree);

    // (Re)load the top-level databases; the lazy schema/object levels reload on
    // their next expansion. Used for the initial load and the section refresh tool.
    const refresh = (): void => {
        void loadDatabases(conn)
            .then(nodes => tree.setNodes(nodes))
            .catch(error => controller.notifyError(error));
    };

    refresh();

    return { tree, refresh };
}

async function loadDatabases(conn: string): Promise<TreeNode[]> {
    const databases = await getDatabases(conn);

    return databases.map(db => databaseNode(conn, db.name));
}

function databaseNode(conn: string, database: string): TreeNode {
    return {
        label       : database,
        hasChildren : true,
        data        : { connectionId: conn, database, kind: "database" } satisfies DbObjectRef,
        loadChildren: () => loadSchemas(conn, database),
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

async function loadObjects(conn: string, database: string, schema: string): Promise<TreeNode[]> {
    const objects = await getObjects(conn, database, schema);

    return OBJECT_CATEGORIES
        .map(category => categoryNode(category, objects, conn, database, schema))
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

/** Build one object leaf node carrying its DbObjectRef on `data`. */
function objectLeaf(o: DbObject, conn: string, database: string, schema: string): TreeNode {
    return {
        label: o.name,
        data : { connectionId: conn, database, schema, name: o.name, kind: o.kind } satisfies DbObjectRef,
    };
}
