// The read-only per-role grants diagram, opened as its own Dock tab from the
// Roles rail's right-click "Show grants graph". Extends DiagramView (ELK-laid-
// out, pan/zoom) over the star buildRoleGrantsDiagram assembled: the role node
// at the centre, one node per granted table. Node kinds differ (role vs.
// table), so — unlike SchemaDiagramPanel, which treats every node as a table —
// this panel reads each activated node's `data` to distinguish kinds and only
// routes a table double-click to onOpenTable.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramView (class-
// first); the "activate" handler is an inline arrow closing over the
// constructor's `onOpenTable` parameter, never handed off by reference, so it
// needs no arrow-function field.

import { DiagramView }              from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
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
 * The read-only per-role grants diagram panel. Extends DiagramView over the
 * star; double-clicking a table node invokes `onOpenTable` with its schema +
 * table. Double-clicking the role node (or a node with no `data`) is a no-op —
 * there is nothing further to open.
 */
export class RoleGrantsDiagramPanel extends DiagramView {
    /**
     * @param data - The graph (from buildRoleGrantsDiagram).
     * @param onOpenTable - Invoked with a table node's schema and table on activate.
     */
    constructor(data: DiagramData, onOpenTable: (schema: string, table: string) => void) {
        super({ data });

        this.on("activate", (node: DiagramNodeData) => {
            const meta = node.data as GrantNodeData | undefined;

            if (meta?.kind === "table") {
                onOpenTable(meta.schema, meta.table);
            }
        });
    }
}
