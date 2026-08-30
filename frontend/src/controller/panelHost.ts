// The collaborator-facing seam every controller collaborator (DdlLaunchers,
// QueryWorkspace, ObjectPanels, DiagramPanels, RoleActions, and
// RevealCoordinator's siblings) reaches the app through: the Dock, the panel
// registry, the status/error plumbing, and the layout store. Implemented by
// SqlAdminController alone — not part of the app-facing controller surface,
// which is the coordinator's own public fields (`controller.panels.openTable`
// and so on). No collaborator imports SqlAdminController.ts itself, which is
// what keeps the module graph acyclic; every library value import here is
// `import type` (verbatimModuleSyntax erases it at compile time) so this
// module carries no runtime DOM dependency of its own.

import type { Dock } from "@jimka/typescript-ui/overlay";
import type { Component } from "@jimka/typescript-ui/core";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { AjaxStore } from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef, RolePrivilege } from "../contract";
import type { PanelRoute } from "../shell/routeTargets";
import type { ActiveExport } from "../data/explain";
import type { LayoutStore } from "../data/layoutStore";
import type { RolesPropertiesPanel } from "../roles/RolesPropertiesPanel";

/**
 * Registry entry for one open dock panel. `store` is absent for the storeless
 * detail tabs (structure, definition); `columns` is present only when the tab
 * was built from introspected columns (data, structure). `detail` labels a
 * storeless tab in the status line ("structure" / "definition").
 */
export interface OpenPanel {
    ref: DbObjectRef;
    node: TreeNode | null; // null when opened without a navigator node (e.g. an FK target)
    store?: AjaxStore;
    columns?: ColumnMeta[];
    detail?: string;
    // Set only by the six storeless detail tabs (structure, definition,
    // function definition, sequence, index, type) — what `refreshActive`
    // dispatches to instead of the store-reload path. Never set alongside `store`.
    refresh?: () => void;
}

/** A recently opened table, kept with its node so the start page can re-open it. */
export interface RecentTable {
    ref: DbObjectRef;
    node: TreeNode;
}

/** A role grants tab's full grant set, for the active-tab export. */
export interface RoleGrants {
    role: string;
    privileges: RolePrivilege[];
}

/** The identity of a work-area tab whose content is fetched behind a spinner. */
export interface AsyncPanelSpec {
    id: string;
    title: string;
    glyph: string;
    tooltip?: string;
    ref?: DbObjectRef;
    route?: PanelRoute;
}

/**
 * A panel-load failure, carrying the object being opened so the Dock's
 * "exception" handler can name it, and whether the error was already
 * surfaced by the fetch helper that produced it.
 */
export class PanelLoadError extends Error {
    constructor(
        readonly reason: unknown,
        readonly ref?: DbObjectRef,
        readonly reported: boolean = false,
    ) {
        super("panel load failed");
    }
}

/** Show `ref`'s object context menu at the right-click's position. */
export type ShowObjectContextMenu = (ref: DbObjectRef, event: MouseEvent) => void;

/**
 * The shared app services every controller collaborator reaches through.
 * Implemented by SqlAdminController; this is the collaborator-facing seam, not
 * part of the app-facing controller surface.
 */
export interface PanelHost {
    readonly dock: Dock;
    readonly layout: LayoutStore;
    readonly connectionId: string;
    readonly database: string | undefined;
    /** The roles inspector a role open refreshes. */
    readonly rolesProperties: RolesPropertiesPanel;

    /** Write a status message, prefixed with the connected database. */
    status(message: string): void;
    /** Surface an error to the status bar and the notification history. */
    notifyError(error: unknown, ref?: DbObjectRef): void;
    /** The hover tooltip for a tab showing `ref`. */
    panelTooltip(ref: DbObjectRef): string;

    /** Register a tab whose content is fetched behind the library's spinner. */
    openAsyncPanel(spec: AsyncPanelSpec, build: () => Promise<Component>): void;
    /** Record the address-bar route for a tab opened without openAsyncPanel. */
    setPanelRoute(id: string, route: PanelRoute): void;
    /** Add or replace this panel's open-panel registry entry. */
    registerPanel(id: string, entry: OpenPanel): void;
    /** The live registry entry for `id`, or undefined when the tab is not open. */
    panelEntry(id: string): OpenPanel | undefined;
    /** Close every tab that can exist for `ref` (see panelIdsFor). */
    closeTabsFor(ref: DbObjectRef): void;
    /** Fetch a relation's columns, coalescing concurrent requests for the same object. */
    fetchColumns(ref: DbObjectRef): Promise<ColumnMeta[]>;
    /** Select the panel's navigator node and refresh the status bar to match. */
    syncToPanel(id: string): void;

    /** Record a query panel's latest run for the address-bar sync. */
    recordQueryRun(id: string, timestamp: number): void;
    /** Mirror a query panel's latest exportable result. */
    setActiveExport(id: string, active: ActiveExport | null): void;
    /** Track a grants tab's full grant set for the active-tab export. */
    setActiveRoleGrants(id: string, grants: RoleGrants): void;
}
