// The read-only per-role grants diagram, opened as its own Dock tab from the
// Roles rail's right-click "Show grants graph". Wraps a DiagramView (ELK-laid-
// out, pan/zoom) over the star buildRoleGrantsDiagram assembled: the role node
// at the centre, one node per granted table. Node kinds differ (role vs.
// table), so — unlike SchemaDiagramPanel, which treats every node as a table —
// this panel reads each activated node's `data` to distinguish kinds and only
// routes a table double-click to onOpenTable.

import { DiagramView }              from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { Component }           from "@jimka/typescript-ui/core";
import { Glyph }                    from "@jimka/typescript-ui/component/display";
import { user }                     from "@jimka/typescript-ui/glyphs/solid/user";
import { table }                    from "@jimka/typescript-ui/glyphs/solid/table";
import type { GrantNodeData }       from "../data/buildRoleGrantsDiagram";

// The role node and table-node glyphs this panel renders. Registered here so
// the panel works standalone regardless of import order elsewhere (mirrors
// RolesTree.ts's and objectGlyphs.ts's own `Glyph.register` calls for the same
// glyphs).
Glyph.register(user, table);

/**
 * Build the read-only per-role grants diagram panel. Wraps a DiagramView over
 * the star; double-clicking a table node invokes `onOpenTable` with its
 * schema + table. Double-clicking the role node (or a node with no `data`) is
 * a no-op — there is nothing further to open.
 *
 * @param data - The graph (from buildRoleGrantsDiagram).
 * @param onOpenTable - Invoked with a table node's schema and table on activate.
 * @returns A Component to host as the tab content.
 */
export function RoleGrantsDiagramPanel(
    data: DiagramData,
    onOpenTable: (schema: string, table: string) => void,
): Component {
    const view = DiagramView({ data });

    view.on("activate", (node: DiagramNodeData) => {
        const meta = node.data as GrantNodeData | undefined;

        if (meta?.kind === "table") {
            onOpenTable(meta.schema, meta.table);
        }
    });

    return view;
}
