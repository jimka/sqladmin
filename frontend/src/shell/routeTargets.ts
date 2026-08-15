// The URL vocabulary appRouter.ts registers against: which relation kinds
// and role buckets have a path segment, which trailing segment names which
// alternative view for a relation/schema/role route, and how a query
// parameter parses as a boolean flag. Kept free of library imports (only a
// type import from ../contract) so it loads under the project's
// node-environment vitest — mirroring recordNavigation.ts's and
// depthChoices.ts's own DOM-free split.

import type { DbObjectKind } from "../contract";

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
