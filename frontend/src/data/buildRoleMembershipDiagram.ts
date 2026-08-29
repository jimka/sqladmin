// Pure assembly of the whole role-membership DAG for DiagramView: one node per
// role, one edge `role -> parent` per membership whose parent is also a known
// role. No DOM, no ELK — layout runs lazily inside DiagramView itself.

import type { DiagramData, DiagramEdgeData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { RoleDetail } from "../contract";
import { uniformNodeWidth } from "./uniformNodeWidth";
import type { MeasureWidths } from "./uniformNodeWidth";

// Left-to-right layered layout: a membership DAG reads naturally as a
// hierarchy flow (member -> parent), matching the schema FK graph's layout.
const LAYOUT_OPTIONS: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
};

// The registered glyph name for a role node. Deliberately an inline literal,
// not imported from `../roles/RolesTree` (whose `Glyph.register(user)` import
// pulls in `@jimka/typescript-ui/component/display`, a bundled chunk whose
// unrelated components run DOM-touching module-level side effects on import),
// which crashes under this project's DOM-less vitest "node" environment. This
// builder stays pure and unit-testable by never importing UI-bundle code;
// keep this literal in sync with RolesTree.ts's `Glyph.register(user)`.
const ROLE_GLYPH = "user";

/** Opaque metadata carried on a membership edge (admin_option on the grant). */
interface MembershipEdgeData {
    admin: boolean;
}

/**
 * Build the whole role-membership DAG for DiagramView: one node per role, one
 * edge `role -> parent` per membership whose parent is also a known role.
 *
 * @param details - Every role's detail (its memberOf drives the edges).
 * @param measureWidths - Optional real text measurer passed through to
 *   `uniformNodeWidth`. Omitting it keeps the estimated node width, which is
 *   what this builder's own tests do; the app supplies `Util.measureTextWidths`.
 * @returns Nodes + edges + layered layout options. Every node carries the
 *   same `width` (see `uniformNodeWidth`), measured over every role name.
 */
export function buildRoleMembershipDiagram(details: RoleDetail[], measureWidths?: MeasureWidths): DiagramData {
    const roleNames = new Set(details.map(d => d.role.name));
    const nodeWidth = uniformNodeWidth(details.map(d => d.role.name), measureWidths);

    const nodes: DiagramNodeData[] = details.map(d => ({
        id   : d.role.name,
        label: d.role.name,
        glyph: ROLE_GLYPH,
        width: nodeWidth,
    }));

    const edges: DiagramEdgeData[] = [];

    for (const d of details) {
        for (const m of d.memberOf) {
            if (!roleNames.has(m.roleName)) {
                continue; // dangling parent: no node to link to
            }

            edges.push({
                // A (role, parent) pair is unique, so this id is globally unique.
                id    : `${d.role.name}->${m.roleName}`,
                source: d.role.name,
                target: m.roleName,
                label : m.admin ? "admin" : undefined,
                data  : { admin: m.admin } satisfies MembershipEdgeData,
            });
        }
    }

    return { nodes, edges, layoutOptions: LAYOUT_OPTIONS };
}
