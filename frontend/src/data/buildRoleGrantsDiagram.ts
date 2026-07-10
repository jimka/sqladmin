// Pure assembly of one role's grants star for DiagramView: the role node at
// the centre, one node per distinct schema.table it holds a privilege on, one
// edge per table labelled with its privilege list. No DOM, no ELK — layout
// runs lazily inside DiagramView itself.

import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { RolePrivilege } from "../contract";

// Left-to-right layered layout, matching the schema/membership graphs' layout
// even though a depth-1 star has no real hierarchy to speak of.
const LAYOUT_OPTIONS: Record<string, string> = { "elk.algorithm": "layered", "elk.direction": "RIGHT" };

// The registered glyph names for the role and table nodes. Deliberately
// inline literals, not imported from `../roles/RolesTree` / `../navigator/
// objectGlyphs` (both pull in `@jimka/typescript-ui/component/display`, a
// bundled chunk whose unrelated components run DOM-touching module-level side
// effects on import), which crashes under this project's DOM-less vitest
// "node" environment. This builder stays pure and unit-testable by never
// importing UI-bundle code; keep these literals in sync with RolesTree.ts's
// `Glyph.register(user)` and objectGlyphs.ts's `KIND_GLYPH.table`.
const ROLE_GLYPH = "user";
const TABLE_GLYPH = "table";

/** Node metadata distinguishing the role node from a granted-table node. */
export type GrantNodeData =
    | { kind: "role" }
    | { kind: "table"; schema: string; table: string };

/** Opaque metadata carried on a grant edge: the table's privilege list. */
export interface GrantEdgeData {
    privileges: string[]; // distinct privileges held on this table, sorted
}

/**
 * Build the per-role grants star: the role node plus one node per distinct
 * schema.table it holds a privilege on, one edge role -> table labelled with
 * that table's privilege list.
 *
 * @param role - The role name (the centre node).
 * @param privileges - The role's full grant list (RoleDetail.privileges).
 * @returns Nodes (role + tables) + edges (one per table).
 */
export function buildRoleGrantsDiagram(role: string, privileges: RolePrivilege[]): DiagramData {
    const roleNodeId = `role:${role}`;

    const nodes: DiagramNodeData[] = [
        { id: roleNodeId, label: role, glyph: ROLE_GLYPH, data: { kind: "role" } satisfies GrantNodeData },
    ];
    const edges: DiagramEdgeData[] = [];

    // Group privileges by schema.table, preserving first-seen order so the
    // node/edge order is deterministic given the input order.
    const byTable = new Map<string, { schema: string; table: string; privileges: Set<string> }>();

    for (const p of privileges) {
        const key = `${p.schema}.${p.table}`;
        let group = byTable.get(key);

        if (!group) {
            group = { schema: p.schema, table: p.table, privileges: new Set() };
            byTable.set(key, group);
        }

        group.privileges.add(p.privilege);
    }

    for (const [key, group] of byTable) {
        const tableNodeId = `table:${key}`;
        const privs = [...group.privileges].sort();

        nodes.push({
            id   : tableNodeId,
            label: key,
            glyph: TABLE_GLYPH,
            data : { kind: "table", schema: group.schema, table: group.table } satisfies GrantNodeData,
        });

        edges.push({
            id    : `grant:${key}`,
            source: roleNodeId,
            target: tableNodeId,
            label : privs.join(", "),
            data  : { privileges: privs } satisfies GrantEdgeData,
        });
    }

    return { nodes, edges, layoutOptions: LAYOUT_OPTIONS };
}
