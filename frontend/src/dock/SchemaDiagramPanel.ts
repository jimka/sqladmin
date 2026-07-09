// The read-only schema entity-relationship diagram, opened as its own Dock tab
// from the navigator's schema-node right-click menu ("Open schema diagram").
// Wraps DiagramView (ELK-laid-out nodes/edges, pan/zoom, single-select) over the
// graph the controller assembled via buildSchemaDiagram. Selecting a node is the
// diagram's only interaction: it reports the clicked table's name back to the
// controller, which reuses openReferencedTable — the same open path an FK link
// in StructurePanel uses — so a diagram click behaves identically.

import { DiagramView } from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { Component } from "@jimka/typescript-ui/core";

/**
 * Build the read-only schema diagram panel. Wraps a DiagramView over the graph;
 * selecting a node invokes `onSelectTable` with the node's table name.
 *
 * @param data - The graph model (from buildSchemaDiagram).
 * @param onSelectTable - Invoked with the selected node's table name (its id).
 * @returns A DiagramView Component to host as the tab content.
 */
export function SchemaDiagramPanel(
    data: DiagramData,
    onSelectTable: (table: string) => void,
): Component {
    const view = DiagramView({ data });

    // DiagramView is single-select: an empty array means the selection was
    // cleared (a click on empty canvas), which opens nothing.
    view.on("selection", (nodes: DiagramNodeData[]) => {
        if (nodes.length > 0) {
            onSelectTable(nodes[0].id);
        }
    });

    return view;
}
