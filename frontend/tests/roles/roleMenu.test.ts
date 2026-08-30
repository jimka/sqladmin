// Structure/dispatch tests for the roles-tree context-menu builder. Pins the
// six-item shape RolesTree's context menu relies on, plus the export
// submenu's two formats. DOM-free (no glyph registration or Component
// construction happens here — see memory "tsui DOM module side effects"),
// mirroring tests/navigator/objectMenu.test.ts's style.

import { describe, expect, it, vi } from "vitest";
import { buildRoleMenuItems } from "../../src/roles/roleMenu";
import type { RoleMenuActions } from "../../src/roles/roleMenu";
import type { MenuItemConfig } from "@jimka/typescript-ui/component/container";

const ROLE = "alice";

/** A minimal RoleMenuActions with every action a no-op spy. */
function stubActions(): RoleMenuActions {
    return {
        showRole:              vi.fn(),
        openMembershipDiagram: vi.fn(),
        openGrantsDiagram:     vi.fn(),
        exportGrants:          vi.fn(),
    };
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

describe("buildRoleMenuItems", () => {
    it("returns six entries in order, with the two separators", () => {
        const items = buildRoleMenuItems(ROLE, stubActions());

        expect(itemLabels(items)).toEqual([
            "Show data", "—", "Show membership graph", "Show grants graph", "—", "Export grants",
        ]);
    });

    it("gives Export grants a submenu of the CSV and JSON entries", () => {
        const items = buildRoleMenuItems(ROLE, stubActions());
        const exportItem = items.find(i => i.text === "Export grants");

        expect(itemLabels(submenuItems(exportItem))).toEqual(["CSV (.csv)", "JSON (.json)"]);
    });

    it("dispatches Show data to showRole with the role name", () => {
        const actions = stubActions();
        const items = buildRoleMenuItems(ROLE, actions);

        items.find(i => i.text === "Show data")?.action?.();
        expect(actions.showRole).toHaveBeenCalledWith(ROLE);
        expect(actions.showRole).toHaveBeenCalledTimes(1);
    });

    it("dispatches the two graph items to their matching actions", () => {
        const actions = stubActions();
        const items = buildRoleMenuItems(ROLE, actions);

        items.find(i => i.text === "Show membership graph")?.action?.();
        expect(actions.openMembershipDiagram).toHaveBeenCalledWith(ROLE);

        items.find(i => i.text === "Show grants graph")?.action?.();
        expect(actions.openGrantsDiagram).toHaveBeenCalledWith(ROLE);
    });

    it("dispatches the export submenu's CSV and JSON entries with the role name and format", () => {
        const actions = stubActions();
        const items = buildRoleMenuItems(ROLE, actions);
        const exportItems = submenuItems(items.find(i => i.text === "Export grants"));

        exportItems.find(i => i.text === "CSV (.csv)")?.action?.();
        expect(actions.exportGrants).toHaveBeenCalledWith(ROLE, "csv");

        exportItems.find(i => i.text === "JSON (.json)")?.action?.();
        expect(actions.exportGrants).toHaveBeenCalledWith(ROLE, "json");

        expect(actions.exportGrants).toHaveBeenCalledTimes(2);
    });
});
