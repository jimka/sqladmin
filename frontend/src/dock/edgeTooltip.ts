// Wires a diagram view's edge-hover events to the shared Tooltip singleton,
// composing the tooltip text app-side from the hover payload (fkEdgeTooltip)
// rather than carrying it on the model — a model string cannot describe a
// merged trunk carrying several different foreign keys. Shared by every
// diagram panel that shows foreign-key edges (RelationDiagramPanel,
// SchemaDiagramPanel, DatabaseDiagramPanel); shown immediately, unlike
// Tooltip.attach's 500ms hover delay, since the user has already aimed at a
// narrow edge hit path.

import type { DiagramView } from "@jimka/typescript-ui/component/diagram";
import { Tooltip } from "@jimka/typescript-ui/overlay";
import { fkEdgeTooltip } from "../data/fkEdgeTooltip";

/**
 * Wire a diagram view's edge-hover events to the shared Tooltip singleton.
 *
 * @param view - The view whose foreign-key edges get hover tooltips.
 */
export function attachFkEdgeTooltip(view: DiagramView): void {
    view.on("edgehover", (edges, event) => {
        const text = fkEdgeTooltip(edges);

        if (text !== null) {
            Tooltip.show(text, event.clientX, event.clientY);
        }
    });

    view.on("edgeleave", () => {
        Tooltip.hide();
    });
}
