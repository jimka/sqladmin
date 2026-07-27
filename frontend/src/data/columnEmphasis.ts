// Pure resolution of a card-mode column click to the foreign-key edges
// attached to it and the column rows to highlight at both ends. No DOM, no
// ELK — type-only imports from the diagram barrel plus this schema's own pure
// helpers keep this node-vitest-testable, the same purity discipline as
// buildSchemaDiagram.ts:16-21 (never import UI-bundle runtime code, which
// runs DOM-touching module-level side effects on import).

import type { DiagramData } from "@jimka/typescript-ui/component/diagram";
import type { FkEdgeData } from "./buildSchemaDiagram";
import { portId } from "./schemaCardModel";

/** What one column click emphasises. */
export interface ColumnEmphasis {
    /** Ids of every edge anchored to the clicked column's in or out port. */
    edgeIds: string[];
    /** Node id → column names to highlight on that card, including the clicked one. */
    columns: Map<string, string[]>;
}

/**
 * Records that `column` should be highlighted on the card for `nodeId`,
 * appending to any columns already recorded for that node rather than
 * replacing them (a card can end up with several highlighted rows — its own
 * clicked one plus the far end of every attached edge — and a column visited
 * twice, e.g. by two branching edges, is recorded once).
 *
 * @param columns - The node id → column names map being built.
 * @param nodeId - The node whose card the column belongs to.
 * @param column - The column name to record.
 */
function addColumn(columns: Map<string, string[]>, nodeId: string, column: string): void {
    const existing = columns.get(nodeId) ?? [];

    if (!existing.includes(column)) {
        existing.push(column);
    }

    columns.set(nodeId, existing);
}

/**
 * Resolve a clicked column to the foreign-key edges attached to it and to the
 * column rows at both ends of each. Pure; `data` is not mutated.
 *
 * Attachment is decided by the port, because a port is what actually draws
 * the edge onto a row: an edge whose `sourcePort` names the clicked column's
 * out port is attached there (its far end is the target's `refColumns[0]`),
 * and one whose `targetPort` names the clicked column's in port is attached
 * there (its far end is the source's `columns[0]`). Only the first column
 * pair is considered, matching the existing card-mode limitation —
 * `applyCardMode` ports only `columns[0]` / `refColumns[0]`.
 *
 * @param data - The graph currently shown (card mode, with ports).
 * @param nodeId - The clicked card's node id.
 * @param column - The clicked column's name.
 *
 * @returns The attached edge ids and the per-node columns to highlight.
 */
export function columnEmphasis(data: DiagramData, nodeId: string, column: string): ColumnEmphasis {
    const outPort = portId(nodeId, column, "out");
    const inPort  = portId(nodeId, column, "in");

    const edgeIds: string[] = [];
    const columns = new Map<string, string[]>();

    addColumn(columns, nodeId, column);

    for (const edge of data.edges) {
        const fkData = edge.data as FkEdgeData | undefined;

        if (edge.sourcePort === outPort) {
            edgeIds.push(edge.id);

            const farColumn = fkData?.fks[0]?.refColumns[0];

            if (farColumn !== undefined) {
                addColumn(columns, edge.target, farColumn);
            }
        }

        if (edge.targetPort === inPort) {
            edgeIds.push(edge.id);

            const farColumn = fkData?.fks[0]?.columns[0];

            if (farColumn !== undefined) {
                addColumn(columns, edge.source, farColumn);
            }
        }
    }

    return { edgeIds, columns };
}
