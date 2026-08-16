// The URL vocabulary appRouter.ts registers against: which relation kinds
// and role buckets have a path segment, which trailing segment names which
// alternative view for a relation/schema/role route, and how a query
// parameter parses as a boolean flag. Also holds the reverse (ref/role ->
// URL) direction — the address-bar sync's objectPath/rolePath/
// databaseDiagramPath/notesPath/queryHistoryPath/resolveAddressBarRoute —
// sharing RELATION_KINDS/ROLE_BUCKETS/relationView/schemaView with the
// forward one. Kept free of library imports (only type imports from
// ../contract and ../data/queryStore) so it loads under the project's
// node-environment vitest — mirroring recordNavigation.ts's and
// depthChoices.ts's own DOM-free split.

import type { DbObjectKind, DbObjectRef } from "../contract";
import type { HistoryEntry } from "../data/queryStore";
import { findHistoryEntry } from "../data/queryStore";

/** The relation kinds a route can address. */
export type RelationKind = Extract<DbObjectKind, "table" | "view" | "materializedView">;

/** One relation kind and the URL path segment that names it. */
export interface RelationRoute {
    segment: string;
    kind:    RelationKind;
}

/** Every relation kind a route can address, with its path segment. */
export const RELATION_KINDS: readonly RelationRoute[] = [
    { segment: "table",   kind: "table" },
    { segment: "view",    kind: "view" },
    { segment: "matview", kind: "materializedView" },
];

/**
 * The three role buckets a route can address, mirroring RolesTree's own
 * Users/Groups/Predefined navigator sections. Not validated against a role's
 * actual classification at consume time — see the plan's Architecture
 * Decisions: the roles list has not loaded when a route is applied, so there
 * is nothing to validate against, and any bucket opens the same role by name.
 */
export const ROLE_BUCKETS = ["user", "group", "predefined"] as const;

/** One of the three URL segments a role route's bucket prefix can be. */
export type RoleBucket = typeof ROLE_BUCKETS[number];

/**
 * `ROLE_BUCKETS`, mapped to the RolesTree section label it mirrors — see the
 * plan's Architecture Decision on why this is a second, code-only mirror
 * rather than an import from groupRoles.ts.
 */
export const ROLE_BUCKET_SECTIONS: Record<RoleBucket, string> = {
    user:       "Users",
    group:      "Groups",
    predefined: "Predefined",
};

/** The alternative views a relation route's trailing segment can name. */
export type RelationView = "structure" | "definition" | "diagram" | "dependencies" | "inheritance";

/** The alternative views a schema route's trailing segment can name. */
export type SchemaView = "diagram" | "dependencies" | "inheritance";

/** The alternative views a role route's trailing segment can name. */
export type RoleView = "grants-diagram" | "membership";

// Every RelationView, mapped to the relation kinds it is valid for.
// `definition` is view-only because it reads pg_get_viewdef; `inheritance`
// is table-only because PostgreSQL inheritance and partitioning are
// table-only.
const RELATION_VIEW_KINDS: Record<RelationView, readonly RelationKind[]> = {
    structure:    ["table", "view", "materializedView"],
    definition:   ["view", "materializedView"],
    diagram:      ["table", "view", "materializedView"],
    dependencies: ["table", "view", "materializedView"],
    inheritance:  ["table"],
};

const SCHEMA_VIEWS: readonly SchemaView[] = ["diagram", "dependencies", "inheritance"];
const ROLE_VIEWS: readonly RoleView[] = ["grants-diagram", "membership"];

/**
 * `segment` as a view `kind` supports, or null when it is neither a known
 * view name nor valid for `kind`.
 *
 * @param kind - The relation kind the route's object-kind segment named.
 * @param segment - The route's trailing segment.
 * @returns The matching view, or null.
 */
export function relationView(kind: RelationKind, segment: string): RelationView | null {
    const view = segment as RelationView;

    return Object.hasOwn(RELATION_VIEW_KINDS, view) && RELATION_VIEW_KINDS[view].includes(kind) ? view : null;
}

/**
 * `segment` as a schema view, or null.
 *
 * @param segment - The route's trailing segment.
 * @returns The matching view, or null.
 */
export function schemaView(segment: string): SchemaView | null {
    return SCHEMA_VIEWS.includes(segment as SchemaView) ? (segment as SchemaView) : null;
}

/**
 * `segment` as a role view, or null.
 *
 * @param segment - The route's trailing segment.
 * @returns The matching view, or null.
 */
export function roleView(segment: string): RoleView | null {
    return ROLE_VIEWS.includes(segment as RoleView) ? (segment as RoleView) : null;
}

/**
 * A query parameter read as a boolean flag: a present-but-empty value (`?rotated`),
 * `"true"`, or `"1"` is true, case-insensitively. Everything else, including an
 * absent parameter, is false.
 *
 * @param raw - The raw query value, or undefined when the parameter is absent.
 * @returns The parsed flag.
 */
export function routeFlag(raw: string | undefined): boolean {
    if (raw === undefined) {
        return false;
    }

    if (raw === "") {
        return true;
    }

    const lower = raw.toLowerCase();

    return lower === "true" || lower === "1";
}

/** One static path plus its query string, ready for router.getHref/navigate. */
export interface PanelRoute {
    path: string;
    query?: Record<string, string>;
}

/**
 * The URL that reopens a database object at an optional named view — the
 * inverse of RELATION_KINDS' segment lookup and relationView/schemaView's
 * forward validity check. An invalid `view` for `ref.kind` is ignored (the
 * bare object path is still returned, not null). Returns null only for a
 * `"database"` or `"type"` ref (use databaseDiagramPath for the former; the
 * latter has no route), or a ref missing the schema/name its kind needs.
 *
 * @param ref - The object to build a URL for.
 * @param view - The trailing view segment ("structure", "diagram", …),
 *   omitted for the bare/default tab.
 *
 * @returns The reopen URL, or null when `ref`'s kind has no route.
 */
export function objectPath(ref: DbObjectRef, view?: string): PanelRoute | null {
    if (ref.kind === "schema") {
        if (!ref.schema) {
            return null;
        }

        const validView = view !== undefined && schemaView(view) !== null ? view : undefined;

        return { path: `/schema/${ref.schema}${validView ? `/${validView}` : ""}` };
    }

    if (!ref.schema || !ref.name) {
        return null;
    }

    const relation = RELATION_KINDS.find(r => r.kind === ref.kind);

    if (relation) {
        const validView = view !== undefined && relationView(relation.kind, view) !== null ? view : undefined;

        return { path: `/schema/${ref.schema}/${relation.segment}/${ref.name}${validView ? `/${validView}` : ""}` };
    }

    if (ref.kind === "sequence" || ref.kind === "index") {
        return { path: `/schema/${ref.schema}/${ref.kind}/${ref.name}` };
    }

    if (ref.kind === "function") {
        return {
            path : `/schema/${ref.schema}/function/${ref.name}`,
            query: ref.signature ? { signature: ref.signature } : undefined,
        };
    }

    return null; // "database" (use databaseDiagramPath) and "type" (no route) have no per-object path
}

/**
 * The URL that reopens a role at an optional named view. Always uses the
 * "user" bucket segment — see the plan's Architecture Decision.
 *
 * @param role - The role name.
 * @param view - "grants-diagram" or "membership"; omitted for the bare grants tab.
 *
 * @returns The reopen URL.
 */
export function rolePath(role: string, view?: RoleView): PanelRoute {
    return { path: `/role/user/${role}${view ? `/${view}` : ""}` };
}

/** The fixed URL for the whole-database diagram. */
export function databaseDiagramPath(): PanelRoute {
    return { path: "/database/diagram" };
}

/** The fixed URL for the notes/documentation tab. */
export function notesPath(): PanelRoute {
    return { path: "/notes" };
}

/**
 * The URL for a query-history entry.
 *
 * @param timestamp - The recorded run's timestamp (HistoryEntry.timestamp).
 *
 * @returns The reopen URL.
 */
export function queryHistoryPath(timestamp: number): PanelRoute {
    return { path: `/query/history/${timestamp}` };
}

/**
 * The address bar's target for the currently focused panel: its own
 * recorded route if one was captured at open time; else, for a query panel,
 * its latest recorded run's history URL if that entry still exists; else
 * `{ path: "/" }`. See the plan's "A tab with no resolvable route falls
 * back to /" Architecture Decision.
 *
 * @param id - The focused panel's id, or null when the dock is empty.
 * @param panelRoutes - The controller's per-panel route registry.
 * @param queryPanelRuns - The controller's panel-id -> latest-run-timestamp map.
 * @param history - The current run history (newest-first).
 *
 * @returns The route to write to the address bar.
 */
export function resolveAddressBarRoute(
    id: string | null,
    panelRoutes: ReadonlyMap<string, PanelRoute>,
    queryPanelRuns: ReadonlyMap<string, number>,
    history: readonly HistoryEntry[],
): PanelRoute {
    if (id === null) {
        return { path: "/" };
    }

    const route = panelRoutes.get(id);

    if (route) {
        return route;
    }

    const ts = queryPanelRuns.get(id);

    if (ts !== undefined) {
        const entry = findHistoryEntry(history, String(ts));

        if (entry) {
            return queryHistoryPath(entry.timestamp);
        }
    }

    return { path: "/" };
}
