// The relation-rooted entity-relationship diagram, opened as its own Dock tab
// from the navigator's right-click "Show relations" on a table/view/matview.
// Wraps a DiagramView (ELK-laid-out, pan/zoom) over the whole schema graph
// buildSchemaDiagram assembled, but shows only the neighbourhood of a chosen
// root: a WEST side panel drives direction (downstream / upstream / both) and
// depth, plus a per-node legend that hides nodes (optionally pruning any node
// thereby orphaned from the root). Double-clicking a node reports its table name
// back to the controller via onSelectTable — the same open path the schema
// diagram and an FK link in StructurePanel use.

import { Component, Panel }         from "@jimka/typescript-ui/core";
import { Border, HBox, VBox }       from "@jimka/typescript-ui/layout";
import { Placement }                from "@jimka/typescript-ui/primitive";
import { Checkbox, ComboBox, Text } from "@jimka/typescript-ui/component/input";
import { DiagramView }              from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { rootedDiagram, applyHide } from "../data/relationDiagram";
import type { TraversalDirection }  from "../data/relationDiagram";
import { applyCoverageStyle }       from "../data/fkCardinality";
import { TableCardNode }            from "./TableCardNode";

// One hop keeps the first cut readable — the root plus its direct FK neighbours,
// not the whole transitive closure. The user widens it via the Depth control.
const DEFAULT_DEPTH = 1;

// Depth choices offered in the control; capped low because deeper walks quickly
// pull in most of the schema and defeat the point of a rooted view.
const DEPTH_CHOICES = ["1", "2", "3"];

// Fixed width of the WEST side panel: enough for a checkbox plus a typical table
// name without stealing canvas width from the diagram.
const LEGEND_WIDTH = 220;

/**
 * Build the relation-rooted diagram panel: a Border layout with a WEST
 * direction / depth + legend side panel and a CENTER DiagramView. The root node
 * is emphasized; double-clicking any node invokes `onSelectTable` with its id.
 *
 * @param full - The whole schema's graph (from buildSchemaDiagram).
 * @param root - The root relation's node data (id = bare table name; carries the
 *   kind glyph so a view / matview root still renders when it has no FK edges).
 * @param onSelectTable - Invoked with the activated node's table name (its id).
 * @returns A Component to host as the tab content.
 */
export function RelationDiagramPanel(
    full: DiagramData,
    root: DiagramNodeData,
    onSelectTable: (table: string) => void,
): Component {
    // View state, held in the factory closure and re-derived on each control /
    // legend change. `base` is the direction+depth-rooted graph; the filtered
    // (hide+prune) view over it is what the DiagramView actually shows.
    let direction: TraversalDirection = "both";
    let depth = DEFAULT_DEPTH;
    let prune = false;
    let showCoverage = false;
    const hidden = new Set<string>();
    let base: DiagramData = rootedDiagram(full, root, direction, depth);

    // Emphasis lives in the renderer (not applied imperatively after setData), so
    // it survives every filter recompute — setData rebuilds nodes through it.
    // `full` already carries card `data`/`ports` from the controller (card mode),
    // so this single renderer covers every node without a mode flag.
    const nodeRenderer = (n: DiagramNodeData): Component => TableCardNode(n, n.id === root.id);

    const view = DiagramView({ data: base, nodeRenderer });

    view.on("activate", (n: DiagramNodeData) => onSelectTable(n.id));

    // The legend rows live in this container so a direction / depth change can
    // rebuild them wholesale (the node set changes).
    const legend = Panel({ layoutManager: new VBox({ spacing: 2 }), autoScroll: "auto" });

    /** Push the current base + hide/prune + coverage-overlay state into the view. */
    const applyFilter = (): void => {
        view.setData(applyCoverageStyle(applyHide(base, root.id, hidden, prune, direction), showCoverage));
    };

    /** Rebuild the legend rows from the current base's nodes. */
    const rebuildLegend = (): void => {
        legend.removeAllComponents();

        for (const n of base.nodes) {
            legend.addComponent(legendRow(n, root.id, hidden, applyFilter));
        }
    };

    /** Re-root on a direction / depth change: fresh base, cleared hidden set. */
    const rebuildBase = (): void => {
        base = rootedDiagram(full, root, direction, depth);
        hidden.clear();
        rebuildLegend();
        applyFilter();
    };

    const directionControl = ComboBox({
        items: [
            { key: "downstream", label: "Downstream" },
            { key: "upstream",   label: "Upstream" },
            { key: "both",       label: "Both" },
        ],
        value: "both",
        listeners: { change: (v: string) => { direction = v as TraversalDirection; rebuildBase(); } },
    });

    const depthControl = ComboBox({
        items: DEPTH_CHOICES,
        value: String(DEFAULT_DEPTH),
        listeners: { change: (v: string) => { depth = Number(v); rebuildBase(); } },
    });

    const pruneControl = Checkbox({
        value: false,
        listeners: { change: (v: boolean) => { prune = v; applyFilter(); } },
    });

    const coverageControl = Checkbox({
        value: false,
        listeners: { change: (v: boolean) => { showCoverage = v; applyFilter(); } },
    });

    const controls = Panel({
        layoutManager: new VBox({ spacing: 4 }),
        components: [
            labelledRow("Direction", directionControl),
            labelledRow("Depth", depthControl),
            new Component({ layoutManager: new HBox({ spacing: 4 }), components: [pruneControl, new Text("Hide with prune")] }),
            new Component({ layoutManager: new HBox({ spacing: 4 }), components: [coverageControl, new Text("Highlight FKs without a covering index")] }),
        ],
    });

    rebuildLegend();

    const west = Panel({
        layoutManager: new Border(),
        preferredSize: { width: LEGEND_WIDTH, height: 0 },
        minSize      : { width: LEGEND_WIDTH, height: 0 },
        components: [
            { component: controls, constraints: { placement: Placement.NORTH } },
            { component: legend,   constraints: { placement: Placement.CENTER } },
        ],
    });

    return Panel({
        layoutManager: new Border(),
        components: [
            { component: west, constraints: { placement: Placement.WEST } },
            { component: view, constraints: { placement: Placement.CENTER } },
        ],
    });
}

/**
 * A caption stacked above its control. Vertical (not side-by-side) so a caption
 * is never squeezed / ellipsised in the fixed-width side panel.
 *
 * @param caption - The control's label.
 * @param control - The control component.
 * @returns A VBox with the caption above the control.
 */
function labelledRow(caption: string, control: Component): Component {
    return new Component({
        layoutManager: new VBox({ spacing: 2 }),
        components   : [new Text(caption), control],
    });
}

/**
 * One legend row: a checkbox (checked = shown) beside the node's name. Toggling
 * it off adds the node id to `hidden`; on removes it; then re-filters. The root
 * row is disabled and pinned checked — hiding the root is meaningless.
 *
 * @param n - The node this row represents.
 * @param rootId - The root node id (its row is locked shown).
 * @param hidden - The shared hidden-id set this row mutates.
 * @param applyFilter - Re-filters the view after a toggle.
 * @returns The row component.
 */
function legendRow(
    n: DiagramNodeData,
    rootId: string,
    hidden: Set<string>,
    applyFilter: () => void,
): Component {
    const isRoot = n.id === rootId;

    const checkbox = Checkbox({
        value: !hidden.has(n.id),
        listeners: {
            change: (v: boolean) => {
                if (v) {
                    hidden.delete(n.id);
                } else {
                    hidden.add(n.id);
                }

                applyFilter();
            },
        },
    });

    if (isRoot) {
        checkbox.setValue(true);
        checkbox.setEnabled(false);
    }

    return new Component({
        layoutManager: new HBox({ spacing: 4 }),
        components   : [checkbox, new Text(n.label ?? n.id)],
    });
}
