// The shared, DOM-free object context-menu builder: one source of per-object
// menu items for both the navigator tree (NavigatorTree.ts) and the diagram
// panels' right-click wiring (SqlAdminController.ts's diagramContextMenu).
// Extracted from NavigatorTree's own `contextmenu` handler (see
// plans/implemented/diagram-node-context-menu.md) so the two menus can never
// drift apart.
//
// Kept DOM-free (see memory "tsui DOM module side effects") so the node-only
// vitest can import it: the library imports below are `import type`, which
// erases at compile time, and glyphs are referenced by their registered
// string name rather than imported — `Glyph.register` stays in the modules
// that render these menus (NavigatorTree.ts, the controller's own
// registrations). Mirrors the ./dock/menuItems.ts idiom.

import type { Menu }             from "@jimka/typescript-ui/overlay";
import type { MenuItemConfig }   from "@jimka/typescript-ui/component/container";
import type { TreeNode }         from "@jimka/typescript-ui/component/tree";
import type { DbObjectRef }      from "../contract";
import type { SqlAdminController } from "../SqlAdminController";
import { isRelationKind }        from "./objectKinds";

/**
 * The controller methods the object context menu invokes. A narrowed slice of
 * SqlAdminController so the tree and the diagram panels build identical menus
 * without the builder depending on the whole controller. The controller (and
 * `this.controller` in the tree) satisfies it structurally. The import above
 * is `import type`, erased at runtime, so no cycle forms even though the
 * controller imports this module at runtime for `showObjectMenu`.
 */
export type ObjectMenuActions = Pick<SqlAdminController,
    | "openTable" | "openQueryFor" | "openStructure" | "openDefinition"
    | "openSequence" | "openFunctionDefinition" | "executeFunction"
    | "openRelationDiagram" | "openRelationDependencyGraph" | "openRelationInheritanceGraph"
    | "openSchemaDiagram" | "openSchemaDependencyGraph" | "openSchemaInheritanceGraph"
    | "openDatabaseDiagram"
    | "renameTable" | "dropTable" | "dropRelation" | "refreshMaterializedView"
    | "renameSchema" | "dropSchema"
    | "createTable" | "createView" | "createMaterializedView" | "createSequence"
    | "createType" | "createFunction"
    | "dropSequence" | "dropFunction" | "editType" | "dropType"
    | "exportTable"
    | "openIndex" | "openReferencedStructure">;

/**
 * Build the schema node's own menu: its identity actions (rename/drop) above a
 * separator, then the structural "Create …" launchers and the read-only
 * diagram views, each grouped into their own submenu to keep the top-level
 * menu short.
 */
function schemaMenuItems(ref: DbObjectRef, actions: ObjectMenuActions, node?: TreeNode): MenuItemConfig[] {
    return [
        { text: "Rename", glyph: "pencil", action: () => actions.renameSchema(ref) },
        { text: "Drop", glyph: "trash", action: () => actions.dropSchema(ref) },
        { separator: true },
        { text: "Create", glyph: "plus", submenu: { label: "Create", items: [
            { text: "Composite type", action: () => actions.createType(ref, "composite") },
            { text: "Enum type", action: () => actions.createType(ref, "enum") },
            { text: "Function", action: () => actions.createFunction(ref) },
            { text: "Materialized view", action: () => void actions.createMaterializedView(ref) },
            { text: "Sequence", action: () => actions.createSequence(ref) },
            { text: "Table", action: () => actions.createTable(ref) },
            { text: "View", action: () => void actions.createView(ref) },
        ] } },
        { text: "Show", glyph: "diagram-project", submenu: { label: "Show", items: [
            { text: "Database diagram", glyph: "circle-nodes",   action: () => void actions.openDatabaseDiagram({ connectionId: ref.connectionId, database: ref.database, kind: "database" }) },
            { text: "Dependency graph", glyph: "share-nodes",    action: () => void actions.openSchemaDependencyGraph(ref, node) },
            { text: "Inheritance graph", glyph: "sitemap",        action: () => void actions.openSchemaInheritanceGraph(ref, node) },
            { text: "Schema diagram", glyph: "diagram-project", action: () => void actions.openSchemaDiagram(ref, node) },
        ] } },
    ];
}

/** Build a sequence leaf's small menu: show its info, or drop it. */
function sequenceMenuItems(ref: DbObjectRef, actions: ObjectMenuActions, node?: TreeNode): MenuItemConfig[] {
    return [
        { text: "Show info", glyph: "arrow-up-1-9", action: () => void actions.openSequence(ref, node) },
        { text: "Drop", glyph: "trash", action: () => actions.dropSequence(ref) },
    ];
}

/**
 * Build a function/procedure leaf's menu: run it first (the primary action),
 * then, below a separator, its definition and drop.
 */
function functionMenuItems(ref: DbObjectRef, actions: ObjectMenuActions, node?: TreeNode): MenuItemConfig[] {
    return [
        { text: ref.isProcedure ? "Call" : "Execute", glyph: "play", action: () => actions.executeFunction(ref) },
        { separator: true },
        { text: "Show definition", glyph: "file-code", action: () => void actions.openFunctionDefinition(ref, node) },
        { text: "Drop", glyph: "trash", action: () => actions.dropFunction(ref) },
    ];
}

/** Build a standalone enum/composite type leaf's menu: edit it, or drop it. */
function typeMenuItems(ref: DbObjectRef, actions: ObjectMenuActions): MenuItemConfig[] {
    return [
        { text: "Edit", glyph: "pencil", action: () => void actions.editType(ref) },
        { text: "Drop", glyph: "trash", action: () => actions.dropType(ref) },
    ];
}

/**
 * Build an index leaf's small menu: show its info, or jump to its owning
 * table's Structure tab — no DDL actions (CREATE/DROP INDEX already live on
 * StructurePanel's Indexes section; duplicating them here is out of scope).
 */
function indexMenuItems(ref: DbObjectRef, actions: ObjectMenuActions, node?: TreeNode): MenuItemConfig[] {
    return [
        { text: "Show info", glyph: "magnifying-glass", action: () => void actions.openIndex(ref, node) },
        { text: "Open table", glyph: "table-columns", action: () => actions.openReferencedStructure({
            connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name: ref.table, kind: "table",
        }) },
    ];
}

/**
 * Build a relation's (table/view/materializedView) menu: its data-open items,
 * then a "Show" section, then its structural launchers, then Export.
 */
function relationMenuItems(ref: DbObjectRef, actions: ObjectMenuActions, node?: TreeNode): MenuItemConfig[] {
    const items: MenuItemConfig[] = [
        // Mirrors the double-click: open (or focus) the relation's data tab and
        // load it. A table's grid is editable (writes back), so it reads "Open
        // data"; a view/matview is read-only and opens as an auto-run query
        // (SELECT * … LIMIT n) — so it reads "Show data". The glyphs match the
        // tabs each item opens.
        { text: ref.kind === "table" ? "Open data" : "Show data", glyph: "table", action: () => void actions.openTable(ref, node) },
    ];

    // "Open as query" is a table-only affordance: a table's primary open is its
    // editable grid, so browsing it as a generated SELECT is a distinct action.
    // A view already opens as that query ("Show data" above), so the item would
    // be a redundant duplicate there.
    if (ref.kind === "table") {
        items.push({ text: "Open as query", glyph: "terminal", action: () => actions.openQueryFor(ref) });
    }

    items.push({ separator: true });

    if (ref.kind === "table") {
        // Every read-only "Show …" view for a table grouped into one submenu,
        // the "Show" prefix stripped and the items alphabetized — mirrors the
        // schema context menu's Show submenu. Structure is the Columns +
        // Indexes + Constraints + Foreign Keys inspector; Relations is the
        // relation-rooted ER diagram (table-only — a view/matview root has no
        // FK edges and would render as a lone node); Dependencies is the
        // connected dependency component; Inheritance is the pg_inherits
        // partitioning/inheritance graph (also table-only).
        items.push({ text: "Show", glyph: "diagram-project", submenu: { label: "Show", items: [
            { text: "Dependencies", glyph: "share-nodes",     action: () => void actions.openRelationDependencyGraph(ref, node) },
            { text: "Inheritance",  glyph: "sitemap",         action: () => void actions.openRelationInheritanceGraph(ref, node) },
            { text: "Relations",    glyph: "diagram-project", action: () => void actions.openRelationDiagram(ref, node) },
            { text: "Structure",    glyph: "table-columns",   action: () => void actions.openStructure(ref, node) },
        ] } });
    } else {
        // A view/matview has fewer facets — no structure/relations/inheritance
        // (its only columns facet lives in the editable definition tab) — so
        // its two Show items stay flat rather than in a one-or-two-item
        // submenu: its connected dependency component and, since only a
        // (materialized) view has one, its editable SQL definition.
        items.push({ text: "Show dependencies", glyph: "share-nodes", action: () => void actions.openRelationDependencyGraph(ref, node) });
        items.push({ text: "Show definition", glyph: "file-code", action: () => void actions.openDefinition(ref, node) });
    }

    // Structural launchers (table-ddl phase): rename/drop this table. Only a
    // table offers them. Grouped in their own separated section since they
    // mutate, unlike everything above.
    if (ref.kind === "table") {
        items.push({ separator: true });
        items.push({ text: "Rename", glyph: "pencil", action: () => actions.renameTable(ref, node) });
        items.push({ text: "Drop", glyph: "trash", action: () => actions.dropTable(ref, node) });
    }

    // Structural launchers (view-matview-ddl phase): drop this view or
    // matview, plus a matview-only Refresh. Grouped in their own separated
    // section, mirroring the table launchers above.
    if (ref.kind === "view") {
        items.push({ separator: true });
        items.push({ text: "Drop", glyph: "trash", action: () => actions.dropRelation(ref) });
    } else if (ref.kind === "materializedView") {
        items.push({ separator: true });
        items.push({ text: "Refresh", glyph: "arrows-rotate", action: () => actions.refreshMaterializedView(ref) });
        items.push({ text: "Drop", glyph: "trash", action: () => actions.dropRelation(ref) });
    }

    // Export streams the full relation server-side (not the loaded page), so a
    // large table/view exports without bulk-loading the grid.
    items.push({ separator: true });
    items.push({ text: "Export", glyph: "file-export", submenu: { label: "Export", items: [
        { text: "CSV (.csv)",   glyph: "file-csv",  action: () => actions.exportTable(ref, "csv") },
        { text: "JSON (.json)", glyph: "file-code", action: () => actions.exportTable(ref, "json") },
    ] } });

    return items;
}

/**
 * Build the context-menu items for one database object, keyed on `ref.kind`.
 * Returns [] for a kind with no menu (database, or an unhandled kind).
 *
 * @param ref - The object the menu acts on.
 * @param actions - The controller slice the item actions dispatch to.
 * @param node - The object's navigator TreeNode when the caller is the tree;
 *   omitted by the diagram panels (which have no tree node). Threaded into the
 *   action closures that accept an optional node; never read to decide item
 *   text or structure, so the same ref yields the same items with or without it.
 * @returns The menu items, or [] when the kind has no menu.
 */
export function buildObjectMenuItems(
    ref: DbObjectRef,
    actions: ObjectMenuActions,
    node?: TreeNode,
): MenuItemConfig[] {
    if (ref.kind === "schema") {
        return schemaMenuItems(ref, actions, node);
    }

    if (ref.kind === "sequence") {
        return sequenceMenuItems(ref, actions, node);
    }

    if (ref.kind === "function") {
        return functionMenuItems(ref, actions, node);
    }

    if (ref.kind === "type") {
        return typeMenuItems(ref, actions);
    }

    if (ref.kind === "index") {
        return indexMenuItems(ref, actions, node);
    }

    if (!isRelationKind(ref.kind)) {
        return [];
    }

    return relationMenuItems(ref, actions, node);
}

/**
 * Build the items for `ref` and, when non-empty, show them on `menu` at the
 * event's client coordinates. A no-op when the kind has no menu.
 *
 * @param menu - The reused Menu instance to show on.
 * @param ref - The object the menu acts on.
 * @param actions - The controller slice the item actions dispatch to.
 * @param event - The originating right-click, whose client coordinates
 *   position the menu.
 * @param node - The object's navigator TreeNode when the caller is the tree;
 *   omitted by the diagram panels.
 */
export function showObjectMenu(
    menu: Menu,
    ref: DbObjectRef,
    actions: ObjectMenuActions,
    event: MouseEvent,
    node?: TreeNode,
): void {
    const items = buildObjectMenuItems(ref, actions, node);

    if (items.length === 0) {
        return;
    }

    menu.show(event.clientX, event.clientY, items);
}
