// The read-only schema entity-relationship diagram, opened as its own Dock tab
// from the navigator's schema-node right-click menu ("Open schema diagram").
// Extends DiagramView (ELK-laid-out nodes/edges, pan/zoom, single-select) over
// the graph the controller assembled via buildSchemaDiagram. A single click
// only selects (highlights) a node; double-clicking a node reports its table
// name back to the controller, which reuses openReferencedTable — the same
// open path an FK link in StructurePanel uses — so activating a table behaves
// identically.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramView (class-
// first), so the instance itself is the mountable component. The "activate"
// handler is an inline arrow closing over the constructor's `onSelectTable`
// parameter, never handed off by reference, so it needs no arrow-function field.

import { DiagramView } from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";

/**
 * The read-only schema diagram panel. Extends DiagramView over the graph;
 * double-clicking a node invokes `onSelectTable` with the node's table name.
 */
export class SchemaDiagramPanel extends DiagramView {
    /**
     * @param data - The graph model (from buildSchemaDiagram).
     * @param onSelectTable - Invoked with the activated node's table name (its id).
     */
    constructor(data: DiagramData, onSelectTable: (table: string) => void) {
        super({ data });

        // Double-click opens the table; a single click only selects it. The
        // "activate" payload is the double-clicked node, whose id is its table name.
        this.on("activate", (node: DiagramNodeData) => {
            onSelectTable(node.id);
        });
    }
}
