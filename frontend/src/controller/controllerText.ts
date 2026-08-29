// The controller's pure string derivations — panel ids, tab tooltips,
// status-name elision, backend-error extraction — split out from
// SqlAdminController.ts and kept free of library imports so the node vitest
// can load it (mirroring startPageWelcome.ts's own header). Every function
// here is pure: no DOM, no fetch, no controller state.

import type { DbObjectRef } from "../contract";

// How much of a user-supplied name a status message may spend. A saved query's
// name is free text with no length limit of its own, and the status bar is one
// line — past this the name crowds out the message it is there to label.
const MAX_STATUS_NAME_CHARS = 40;

/**
 * Stable panel id so re-opening focuses the existing panel. Includes the
 * connection and database so same-named tables in different databases (e.g.
 * `postgres` vs `sqladmin`, both with `public.customers`) never collide.
 */
export function panelId(ref: DbObjectRef): string {
    return `${ref.connectionId}/${ref.database}/${ref.schema}.${ref.name}`;
}

/** Stable id for a table's structure tab, distinct from its data tab. */
export function structurePanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}::structure`;
}

/** Stable id for a view's definition tab, distinct from its data/structure tabs. */
export function definitionPanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}::definition`;
}

/** Stable id for a sequence's info tab, distinct from any relation tab. */
export function sequenceInfoPanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}::sequence`;
}

/** Stable id for an index's info tab, distinct from any relation tab. */
export function indexInfoPanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}::index`;
}

/** Stable id for a type's info tab, distinct from any relation tab. */
export function typeInfoPanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}::type`;
}

/**
 * Stable id for a function/procedure's definition tab. Includes the
 * identity signature so two overloads of the same name (e.g.
 * `total_orders()` and `total_orders(integer)`) get distinct tabs rather
 * than colliding on `schema.name`.
 */
export function functionDefinitionPanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}(${ref.signature ?? ""})::function`;
}

/** Stable id for a schema's diagram tab, distinct from any relation tab. */
export function diagramPanelId(ref: DbObjectRef): string {
    return `${ref.connectionId}/${ref.database}/${ref.schema}::diagram`;
}

/**
 * Stable id for a relation's rooted-diagram tab. `panelId` already includes
 * the relation name, so this never collides with the schema diagram id
 * (`.../schema::diagram`) nor with the relation's data/structure/definition
 * tabs.
 */
export function relationDiagramPanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}::diagram`;
}

/** Stable id for a schema's dependency-graph tab, distinct from any relation tab. */
export function dependencyPanelId(ref: DbObjectRef): string {
    return `${ref.connectionId}/${ref.database}/${ref.schema}::dependencies`;
}

/** Stable id for a relation's rooted dependency-graph tab. */
export function relationDependencyPanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}::dependencies`;
}

/** Stable id for a schema's inheritance-graph tab, distinct from any relation tab. */
export function inheritancePanelId(ref: DbObjectRef): string {
    return `${ref.connectionId}/${ref.database}/${ref.schema}::inheritance`;
}

/** Stable id for a relation's rooted inheritance-graph tab. */
export function relationInheritancePanelId(ref: DbObjectRef): string {
    return `${panelId(ref)}::inheritance`;
}

/**
 * Stable id for a database's diagram tab, distinct from a schema's diagram
 * id (no `/schema` segment) and from any relation tab.
 */
export function databaseDiagramPanelId(ref: DbObjectRef): string {
    return `${ref.connectionId}/${ref.database}::db-diagram`;
}

/** Stable id for a DDL draft tab. See the id table in the plan's `## Architecture Decisions`. */
export function ddlPanelId(ref: DbObjectRef, slug: string): string {
    return `${ref.connectionId}/${ref.database}/${ref.schema ?? ""}/${ref.name ?? ""}::ddl-${slug}`;
}

/** Stable id for the singleton per-connection notes/documentation tab. */
export function notesPanelId(connectionId: string): string {
    return `notes/${connectionId}`;
}

/** Stable id for a role's grants tab (RoleActions.openRoleGrants). */
export function roleGrantsPanelId(connectionId: string, role: string): string {
    return `grants/${connectionId}/${role}`;
}

/**
 * Stable id for a role's grants-diagram tab, distinct from
 * `roleGrantsPanelId`'s grid tab id.
 */
export function roleGrantsDiagramPanelId(connectionId: string, role: string): string {
    return `roles/${connectionId}/${role}::grants-diagram`;
}

/** Stable id for a role's membership-diagram tab. */
export function roleMembershipDiagramPanelId(connectionId: string, role: string): string {
    return `roles/${connectionId}/${role}::membership`;
}

/**
 * Every panel id that can exist for `ref`, for `PanelHost.closeTabsFor`.
 *
 * @param ref - The object being dropped or otherwise fully closed.
 * @returns Every tab id `ref` could ever occupy. Ids for a tab kind that
 *   `ref.kind` cannot actually open are included too — `Dock.removePanel` on
 *   an id with no open tab is already relied on elsewhere as a no-op.
 */
export function panelIdsFor(ref: DbObjectRef): string[] {
    if (ref.kind === "database") {
        return [databaseDiagramPanelId(ref)];
    }

    if (ref.kind === "schema") {
        return [diagramPanelId(ref), dependencyPanelId(ref), inheritancePanelId(ref)];
    }

    // Every object-scoped tab, whether or not this kind can open all of them:
    // Dock.removePanel on an id with no open tab is already relied on as a no-op
    // (dropTable removes a structure tab that may never have been opened).
    return [
        panelId(ref), structurePanelId(ref), definitionPanelId(ref),
        sequenceInfoPanelId(ref), indexInfoPanelId(ref), typeInfoPanelId(ref),
        functionDefinitionPanelId(ref),
        relationDiagramPanelId(ref), relationDependencyPanelId(ref), relationInheritancePanelId(ref),
    ];
}

/**
 * A tab's hover tooltip: the object name, then Type/Schema/Database ordered
 * most-specific to broadest.
 *
 * @param ref - The tab's object.
 * @param typeLabel - The kind's display label (the caller supplies it so
 *   this module stays free of the library-touching lookup that derives it).
 */
export function panelTooltip(ref: DbObjectRef, typeLabel: string): string {
    return `${ref.name}\n\nType: ${typeLabel}\nSchema: ${ref.schema}\nDatabase: ${ref.database}`;
}

/**
 * Shorten a free-text name to fit a status message, eliding the tail so the
 * ellipsis reads as "there is more name here" rather than a truncation the user
 * has to guess at. The full name still shows wherever it has room to breathe —
 * the tab title, the Queries view.
 *
 * @param name - The name as the user typed it.
 * @returns The name, tail-elided when it runs past MAX_STATUS_NAME_CHARS.
 */
export function elideName(name: string): string {
    if (name.length <= MAX_STATUS_NAME_CHARS) {
        return name;
    }

    // Trailing space before the ellipsis reads as a typo, so shed it.
    return `${name.slice(0, MAX_STATUS_NAME_CHARS - 1).trimEnd()}…`;
}

/**
 * Extract a readable message from a backend error body. A domain error's
 * `detail` is a string; a FastAPI validation error's `detail` is an array of
 * `{msg, ...}` entries, which are joined.
 */
export function detailOf(body: unknown): string | null {
    if (!body || typeof body !== "object") {
        return null;
    }

    const detail = (body as { detail?: unknown }).detail;

    if (typeof detail === "string") {
        return detail;
    }

    if (Array.isArray(detail)) {
        return detail
            .map(d => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
            .join("; ");
    }

    return null;
}

/**
 * The download filename for a table/view export — `<schema>.<table>.<format>`.
 * Shared by `SqlAdminController.exportTable` (the coordinator's own export
 * route) and `ObjectPanels.openTable` (the data tab's own Export toolbar
 * button), both of which trigger the identical streaming download.
 */
export function tableExportFilename(ref: DbObjectRef, format: "csv" | "json"): string {
    return `${[ref.schema, ref.name].filter(Boolean).join(".") || "export"}.${format}`;
}

/** Prefer an AjaxError's parsed {detail}; fall back to a message or string. */
export function errorMessage(error: unknown): string {
    const e = error as { body?: unknown; message?: unknown };
    const detail = detailOf(e?.body);

    if (detail) {
        return detail;
    }

    if (typeof e?.message === "string" && e.message) {
        return e.message;
    }

    return String(error);
}
