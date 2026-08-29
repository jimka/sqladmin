// Structure/dispatch tests for the shared object context-menu builder (see
// plans/implemented/diagram-node-context-menu.md). Pins the per-kind item
// shape both callers (NavigatorTree and the diagram panels' controller
// wiring) rely on, plus the node-independence and showObjectMenu-empty-guard
// contracts. DOM-free (no glyph registration or Component construction
// happens here — see memory "tsui DOM module side effects"), mirroring
// tests/dock/menuItems.test.ts's style.

import { describe, expect, it, vi } from "vitest";
import { buildObjectMenuItems, showObjectMenu } from "../../src/navigator/objectMenu";
import type { ObjectMenuActions } from "../../src/navigator/objectMenu";
import type { DbObjectRef } from "../../src/contract";
import type { Menu } from "@jimka/typescript-ui/overlay";
import type { MenuItemConfig } from "@jimka/typescript-ui/component/container";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";

const CONN = "default";
const DB = "mydb";
const SCHEMA = "public";

/** A minimal ObjectMenuActions with every controller method a no-op spy. */
function stubActions(): ObjectMenuActions {
    return {
        openTable: vi.fn(), openStructure: vi.fn(), openDefinition: vi.fn(),
        openSequence: vi.fn(), openFunctionDefinition: vi.fn(),
        openRelationDiagram: vi.fn(), openRelationDependencyGraph: vi.fn(), openRelationInheritanceGraph: vi.fn(),
        openSchemaDiagram: vi.fn(), openSchemaDependencyGraph: vi.fn(), openSchemaInheritanceGraph: vi.fn(),
        exportTable: vi.fn(),
        openIndex: vi.fn(), openReferencedStructure: vi.fn(),
        openType: vi.fn(),
        workspace: {
            openQueryFor: vi.fn(), executeFunction: vi.fn(),
        },
        ddl: {
            renameTable: vi.fn(), dropTable: vi.fn(), dropRelation: vi.fn(), refreshMaterializedView: vi.fn(),
            renameSchema: vi.fn(), dropSchema: vi.fn(),
            createTable: vi.fn(), createView: vi.fn(), createMaterializedView: vi.fn(), createSequence: vi.fn(),
            createType: vi.fn(), createFunction: vi.fn(),
            dropSequence: vi.fn(), dropFunction: vi.fn(), editType: vi.fn(), dropType: vi.fn(),
        },
    } as unknown as ObjectMenuActions;
}

function tableRef(): DbObjectRef {
    return { connectionId: CONN, database: DB, schema: SCHEMA, name: "t1", kind: "table" };
}

function viewRef(): DbObjectRef {
    return { connectionId: CONN, database: DB, schema: SCHEMA, name: "v1", kind: "view" };
}

function matviewRef(): DbObjectRef {
    return { connectionId: CONN, database: DB, schema: SCHEMA, name: "mv1", kind: "materializedView" };
}

function schemaRef(): DbObjectRef {
    return { connectionId: CONN, database: DB, schema: SCHEMA, kind: "schema" };
}

function sequenceRef(): DbObjectRef {
    return { connectionId: CONN, database: DB, schema: SCHEMA, name: "s1", kind: "sequence" };
}

function functionRef(isProcedure: boolean): DbObjectRef {
    return { connectionId: CONN, database: DB, schema: SCHEMA, name: "f1", kind: "function", isProcedure };
}

function typeRef(): DbObjectRef {
    return { connectionId: CONN, database: DB, schema: SCHEMA, name: "ty1", kind: "type" };
}

function indexRef(): DbObjectRef {
    return { connectionId: CONN, database: DB, schema: SCHEMA, name: "idx1", kind: "index", table: "t1" };
}

function databaseRef(): DbObjectRef {
    return { connectionId: CONN, database: DB, kind: "database" };
}

/** Extracts each item's `text`, or "—" for a separator, in order. */
function itemLabels(items: MenuItemConfig[]): string[] {
    return items.map(i => (i.separator ? "—" : i.text ?? ""));
}

/**
 * A submenu's items, resolving the lazy-items function form (`MenuConfig.items`
 * is `MenuItemConfig[] | (() => MenuItemConfig[])`); every submenu this module
 * builds is the plain-array form, so this is purely a type-narrowing helper for
 * the tests.
 */
function submenuItems(item: MenuItemConfig | undefined): MenuItemConfig[] {
    const items = item?.submenu?.items ?? [];

    return typeof items === "function" ? items() : items;
}

describe("buildObjectMenuItems", () => {
    it("builds a table's menu: data-open, show submenu, ddl, export", () => {
        const items = buildObjectMenuItems(tableRef(), stubActions());

        expect(itemLabels(items)).toEqual([
            "Open data", "Open as query", "—", "Show", "—", "Rename", "Drop", "—", "Export",
        ]);

        const showSubmenu = items.find(i => i.text === "Show");
        expect(submenuItems(showSubmenu).map(i => i.text)).toEqual(["Dependencies", "Inheritance", "Relations", "Structure"]);

        const exportSubmenu = items.find(i => i.text === "Export");
        expect(submenuItems(exportSubmenu).map(i => i.text)).toEqual(["CSV (.csv)", "JSON (.json)"]);
    });

    it("builds a view's menu: data-open, flat show items, drop, export", () => {
        const items = buildObjectMenuItems(viewRef(), stubActions());

        expect(itemLabels(items)).toEqual([
            "Show data", "—", "Show dependencies", "Show definition", "—", "Drop", "—", "Export",
        ]);
    });

    it("builds a materializedView's menu: data-open, flat show items, refresh+drop, export", () => {
        const items = buildObjectMenuItems(matviewRef(), stubActions());

        expect(itemLabels(items)).toEqual([
            "Show data", "—", "Show dependencies", "Show definition", "—", "Refresh", "Drop", "—", "Export",
        ]);
    });

    it("builds a schema's menu: identity actions, then Create/Show submenus", () => {
        const items = buildObjectMenuItems(schemaRef(), stubActions());

        expect(itemLabels(items)).toEqual(["Rename", "Drop", "—", "Create", "Show"]);

        const createSubmenu = items.find(i => i.text === "Create");
        expect(submenuItems(createSubmenu)).toHaveLength(7);

        const showSubmenu = items.find(i => i.text === "Show");
        expect(submenuItems(showSubmenu).map(i => i.text)).toEqual(["Dependency graph", "Inheritance graph", "Schema diagram"]);
    });

    it("builds a sequence's menu: show info, drop", () => {
        const items = buildObjectMenuItems(sequenceRef(), stubActions());

        expect(itemLabels(items)).toEqual(["Show info", "Drop"]);
    });

    it("labels a non-procedure function's primary action Execute", () => {
        const items = buildObjectMenuItems(functionRef(false), stubActions());

        expect(itemLabels(items)).toEqual(["Execute", "—", "Show definition", "Drop"]);
    });

    it("labels a procedure's primary action Call", () => {
        const items = buildObjectMenuItems(functionRef(true), stubActions());

        expect(itemLabels(items)).toEqual(["Call", "—", "Show definition", "Drop"]);
    });

    it("builds a type's menu: show info, edit, drop", () => {
        const items = buildObjectMenuItems(typeRef(), stubActions());

        expect(itemLabels(items)).toEqual(["Show info", "Edit", "Drop"]);
    });

    it("dispatches a type menu's Show info action to openType", () => {
        const ref = typeRef();
        const actions = stubActions();
        const items = buildObjectMenuItems(ref, actions);

        items.find(i => i.text === "Show info")?.action?.();
        expect(actions.openType).toHaveBeenCalledWith(ref, undefined);
    });

    it("builds an index's menu: show info, open table", () => {
        const items = buildObjectMenuItems(indexRef(), stubActions());

        expect(itemLabels(items)).toEqual(["Show info", "Open table"]);
    });

    it("dispatches an index menu's actions to the matching controller method", () => {
        const ref = indexRef();
        const actions = stubActions();
        const items = buildObjectMenuItems(ref, actions);

        items.find(i => i.text === "Show info")?.action?.();
        expect(actions.openIndex).toHaveBeenCalledWith(ref, undefined);

        items.find(i => i.text === "Open table")?.action?.();
        expect(actions.openReferencedStructure).toHaveBeenCalledWith({
            connectionId: ref.connectionId, database: ref.database, schema: ref.schema, name: ref.table, kind: "table",
        });
    });

    it("returns [] for a database ref (and any other unhandled kind)", () => {
        expect(buildObjectMenuItems(databaseRef(), stubActions())).toEqual([]);
    });

    it("is node-independent: the node never changes a table menu's shape", () => {
        const ref = tableRef();
        const withoutNode = buildObjectMenuItems(ref, stubActions());
        const withNode = buildObjectMenuItems(ref, stubActions(), {} as TreeNode);

        expect(itemLabels(withNode)).toEqual(itemLabels(withoutNode));
    });

    it("dispatches a table menu's actions to the matching controller method", () => {
        const ref = tableRef();
        const actions = stubActions();
        const items = buildObjectMenuItems(ref, actions);

        items.find(i => i.text === "Open data")?.action?.();
        expect(actions.openTable).toHaveBeenCalledWith(ref, undefined);

        items.find(i => i.text === "Drop")?.action?.();
        expect(actions.ddl.dropTable).toHaveBeenCalledWith(ref, undefined);

        const exportSubmenu = items.find(i => i.text === "Export");
        submenuItems(exportSubmenu).find(i => i.text === "CSV (.csv)")?.action?.();
        expect(actions.exportTable).toHaveBeenCalledWith(ref, "csv");
    });
});

describe("showObjectMenu", () => {
    it("does not show the menu for a database ref (empty items)", () => {
        const menu = { show: vi.fn() } as unknown as Menu;
        const event = { clientX: 10, clientY: 20 } as MouseEvent;

        showObjectMenu(menu, databaseRef(), stubActions(), event);

        expect(menu.show).not.toHaveBeenCalled();
    });

    it("shows the menu at the event's coordinates for a table ref", () => {
        const menu = { show: vi.fn() } as unknown as Menu;
        const event = { clientX: 10, clientY: 20 } as MouseEvent;
        const ref = tableRef();

        showObjectMenu(menu, ref, stubActions(), event);

        expect(menu.show).toHaveBeenCalledTimes(1);
        const [x, y, items] = (menu.show as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(x).toBe(10);
        expect(y).toBe(20);
        expect(items.length).toBeGreaterThan(0);
    });
});
