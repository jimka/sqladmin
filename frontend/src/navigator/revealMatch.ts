// The reveal predicates: one factory per "which tree node am I looking for?"
// rule the controller hands to `Tree.revealByPredicate`. They live here, in
// their own module, so the differences between them are visible side by side
// rather than buried as inline closures at four call sites — the two navigator
// object rules deliberately differ on whether they compare `kind` (see the
// plan's "The two object predicates stay distinct" decision). Its only import
// is an `import type` — nothing else may be imported from the library — so,
// like objectKinds.ts beside it, this module stays free of the DOM side effects
// library component modules run at import scope and keeps running under the
// node vitest harness.

import type { DbObjectRef } from "../contract";

/**
 * Tests one tree node's `data` payload. `unknown` because a Tree's payload is
 * untyped: a navigator leaf carries a {@link DbObjectRef}, a roles leaf a bare
 * name string, and a category/group parent nothing at all.
 */
export type NodeMatch = (data: unknown) => boolean;

/**
 * Read a node payload as a navigator leaf's ref.
 *
 * @param data - One tree node's `data` payload.
 *
 * @returns The ref, or undefined for any payload that is not one (a category
 * group's absent data, a roles-tree leaf's name string).
 */
function asObjectRef(data: unknown): DbObjectRef | undefined {
    if (typeof data !== "object" || data === null) {
        return undefined;
    }

    return data as DbObjectRef;
}

/**
 * Matches a navigator leaf on database + schema + name + kind.
 *
 * Kind is compared because a sequence and a relation can share a schema and a
 * name (`products_id_seq` is unique, but nothing forbids a table of that name),
 * so matching database/schema/name alone could reveal the wrong node. Every
 * caller knows the exact kind — a route reads it from its own path segment.
 *
 * @param ref - The object to reveal.
 *
 * @returns The predicate to hand to `Tree.revealByPredicate`.
 */
export function matchesObject(ref: DbObjectRef): NodeMatch {
    return data => {
        const leaf = asObjectRef(data);

        return !!leaf && leaf.kind === ref.kind && leaf.database === ref.database
            && leaf.schema === ref.schema && leaf.name === ref.name;
    };
}

/**
 * Matches a navigator leaf on database + schema + name, ignoring kind — for
 * diagram nodes whose ref kind may not be the navigator leaf's kind.
 *
 * Callers reaching a table through a foreign key hardcode `kind: "table"` while
 * the diagram node they came from may be a view or a materialized view, so
 * comparing kind here would silently stop revealing those.
 *
 * @param ref - The relation to reveal.
 *
 * @returns The predicate to hand to `Tree.revealByPredicate`.
 */
export function matchesRelationName(ref: DbObjectRef): NodeMatch {
    return data => {
        const leaf = asObjectRef(data);

        return !!leaf && leaf.database === ref.database && leaf.schema === ref.schema && leaf.name === ref.name;
    };
}

/**
 * Matches a navigator leaf on schema + name only: a `RolePrivilege` carries no
 * database (the roles endpoint is not database-scoped), so a granted table
 * adopts whichever database the matched node carries.
 *
 * @param schema - The granted table's schema.
 * @param table - The granted table's name.
 *
 * @returns The predicate to hand to `Tree.revealByPredicate`.
 */
export function matchesGrantedTable(schema: string, table: string): NodeMatch {
    return data => {
        const leaf = asObjectRef(data);

        return !!leaf && leaf.schema === schema && leaf.name === table;
    };
}

/**
 * Matches a roles-tree leaf, whose `data` is the role name itself. A group
 * parent carries a `RoleGroupData` marker object instead, so the string test
 * skips it.
 *
 * @param name - The role to reveal.
 *
 * @returns The predicate to hand to `Tree.revealByPredicate`.
 */
export function matchesRole(name: string): NodeMatch {
    return data => data === name;
}
