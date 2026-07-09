// The read-only schema entity-relationship diagram, opened as its own Dock tab
// from the navigator's schema-node right-click menu ("Open schema diagram").
// Wraps DiagramView (ELK-laid-out nodes/edges, pan/zoom, single-select) over the
// graph the controller assembled via buildSchemaDiagram. A single click only
// selects (highlights) a node; double-clicking a node reports its table name
// back to the controller, which reuses openReferencedTable — the same open path
// an FK link in StructurePanel uses — so activating a table behaves identically.

import { DiagramView } from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { Component } from "@jimka/typescript-ui/core";

/**
 * Build the read-only schema diagram panel. Wraps a DiagramView over the graph;
 * double-clicking a node invokes `onSelectTable` with the node's table name.
 *
 * @param data - The graph model (from buildSchemaDiagram).
 * @param onSelectTable - Invoked with the activated node's table name (its id).
 * @returns A DiagramView Component to host as the tab content.
 */
export function SchemaDiagramPanel(
    data: DiagramData,
    onSelectTable: (table: string) => void,
): Component {
    const view = DiagramView({ data });

    // Double-click opens the table; a single click only selects it. The
    // "activate" payload is the double-clicked node, whose id is its table name.
    view.on("activate", (node: DiagramNodeData) => {
        onSelectTable(node.id);
    });

    return view;
}
