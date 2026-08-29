// The per-role grants diagram, opened as its own Dock tab from the Roles
// rail's right-click "Show grants graph". Extends FilteredDiagramShell (see
// ./filteredDiagramShell.ts) with a selectable root: the shell's WEST `Root
// node` selector + direction/depth/prune controls + legend, over a CENTER
// DiagramView built from the star buildRoleGrantsDiagram assembled: the role
// node at the centre, one node per granted table. Opens on the whole star,
// centred on the role node; picking a granted table narrows to that table
// plus the role, and picking the role node itself shows the whole star (the
// role reaches every granted table within one hop). Node kinds differ (role
// vs. table), so — unlike SchemaDiagramPanel, which treats every node as a
// table — this panel reads each activated node's `data` to distinguish kinds
// and only routes a table double-click to onOpenTable.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends
// FilteredDiagramShell directly, which owns the whole derive/legend/filter
// lifecycle. The `roleNodeId` lookup and the `JunctionDiagramView` are built
// as locals before `super()` (they are `super()`'s CENTER child and its
// `initialFocusNode`); the "activate" / "contextmenu" handlers are inline
// arrows closing over the constructor's `onOpenTable` / `onContextMenu`
// parameters, never handed off by reference, so they need no arrow-function
// field.

import { callable } from "@jimka/typescript-ui/core";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { Glyph }                    from "@jimka/typescript-ui/component/display";
import { user }                     from "@jimka/typescript-ui/glyphs/solid/user";
import { table }                    from "@jimka/typescript-ui/glyphs/solid/table";
import type { GrantNodeData }       from "../data/buildRoleGrantsDiagram";
import { FilteredDiagramShell }     from "./filteredDiagramShell";
import { JunctionDiagramView }      from "./JunctionDiagramView";

// The role node and table-node glyphs this panel renders. Registered here so
// the panel works standalone regardless of import order elsewhere (mirrors
// RolesTree.ts's and objectGlyphs.ts's own `Glyph.register` calls for the same
// glyphs).
Glyph.register(user, table);

/**
 * The role grants diagram panel: the shell's WEST `Root node` + direction /
 * depth + prune + legend column plus a CENTER DiagramView. Double-clicking a
 * table node invokes `onOpenTable` with its schema + table. Double-clicking
 * the role node (or a node with no `data`) is a no-op — there is nothing
 * further to open.
 */
class RoleGrantsDiagramPanel extends FilteredDiagramShell {
    /**
     * @param data - The graph (from buildRoleGrantsDiagram).
     * @param onOpenTable - Invoked with a table node's schema and table on activate.
     * @param onContextMenu - Invoked with a right-clicked table node's schema,
     *   table, and the originating event. The role node (or a node with no
     *   `data`) never forwards — it has no object menu.
     */
    constructor(data: DiagramData, onOpenTable: (schema: string, table: string) => void,
                onContextMenu?: (schema: string, table: string, event: MouseEvent) => void) {
        // Locals before super() — they are super()'s data (the super-cascade
        // trap: `this` is unavailable until super() returns).
        const roleNodeId = data.nodes.find(n => (n.data as GrantNodeData | undefined)?.kind === "role")?.id;
        const view = JunctionDiagramView({ data, initialFocusNode: roleNodeId });

        super({ view, full: data, rootCaption: "Root node" });

        this.view.on("activate", (node: DiagramNodeData) => {
            const meta = node.data as GrantNodeData | undefined;

            if (meta?.kind === "table") {
                onOpenTable(meta.schema, meta.table);
            }
        });

        this.view.on("contextmenu", (node: DiagramNodeData, event: MouseEvent) => {
            const meta = node.data as GrantNodeData | undefined;

            if (meta?.kind === "table") {
                onContextMenu?.(meta.schema, meta.table, event);
            }
        });
    }
}

const RoleGrantsDiagramPanelCallable = callable(RoleGrantsDiagramPanel);
type RoleGrantsDiagramPanelCallable = RoleGrantsDiagramPanel;
export { RoleGrantsDiagramPanelCallable as RoleGrantsDiagramPanel };
