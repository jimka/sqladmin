// The relation-rooted dependency/inheritance graph, opened as its own Dock tab
// from the navigator's right-click "Dependencies" / "Inheritance" on a
// table/view/matview. Extends DiagramShell (see ./diagramShell.ts) with a
// fixed root for its WEST direction/depth+legend column; this class supplies
// the CENTER DiagramView over the whole schema's dependency or inheritance
// graph, narrowed to the chosen root's neighbourhood via the shared
// direction+depth traversal. Reuses RelationGraphPanel's node renderer
// (relationGraphNodeRenderer) so a rooted and an unrooted relation graph draw
// nodes identically. Double-clicking a node reports its RelationNodeData back
// to the controller, which routes activation through openReferencedTable.
// This tab's title names its root, so the root never changes and no
// `Root …` selector is built.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramShell
// directly. The `JunctionDiagramView` and its badged base graph are built as locals
// before `super()` (they are `super()`'s children); the "activate" /
// "contextmenu" listeners are wired after `super()` since they close over
// `this.cards`-free state but still need `this` for `rebuildBase`/`applyFilter`
// dispatch via the protected hooks.

import { callable } from "@jimka/typescript-ui/core";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { rootedDiagram, applyHide, withDepthBadges } from "../data/relationDiagram";
import type { RelationNodeData } from "../data/buildRelationGraph";
import { relationGraphNodeRenderer } from "./RelationGraphPanel";
import { DiagramShell, legendRow, DEFAULT_DEPTH } from "./diagramShell";
import { JunctionDiagramView } from "./JunctionDiagramView";

/**
 * The relation-rooted dependency/inheritance graph panel: the shell's WEST
 * direction / depth + legend column plus a CENTER DiagramView. The root node
 * is emphasized; double-clicking any node invokes `onSelect` with its
 * RelationNodeData.
 */
class RootedRelationGraphPanel extends DiagramShell {
    private readonly full: DiagramData;
    private readonly root: DiagramNodeData;
    private readonly hidden = new Set<string>();
    private base!: DiagramData;

    /**
     * @param full - The whole schema's dependency or inheritance graph.
     * @param root - The rooted relation's node data (id = `schema.name`).
     * @param onSelect - Invoked with the activated node's RelationNodeData.
     * @param onContextMenu - Invoked with a right-clicked node's RelationNodeData
     *   and the originating event.
     */
    constructor(
        full: DiagramData,
        root: DiagramNodeData,
        onSelect: (node: RelationNodeData) => void,
        onContextMenu?: (node: RelationNodeData, event: MouseEvent) => void,
    ) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns).
        const base = withDepthBadges(rootedDiagram(full, root, "both", DEFAULT_DEPTH), full.edges, "both");
        const view = JunctionDiagramView({
            data: base,
            nodeRenderer: relationGraphNodeRenderer(root.id),
            initialFocusNode: root.id,
        });

        super({ view, fixedRoot: true, root: root.id });

        this.full = full;
        this.root = root;
        this.base = base;

        this.rebuildLegend();

        // Wire listeners after super() (this now available).
        this.view.on("activate", (n: DiagramNodeData) => onSelect(n.data as RelationNodeData));
        this.view.on("contextmenu", (n: DiagramNodeData, event: MouseEvent) => {
            onContextMenu?.(n.data as RelationNodeData, event);
        });
    }

    protected rootingChanged(): void {
        this.rebuildBase();
    }

    protected pruneChanged(): void {
        this.applyFilter();
    }

    // Passed by reference to legendRow — MUST be an arrow field, or it would
    // lose `this` when invoked as a callback.
    private applyFilter = (): void => {
        this.view.setData(applyHide(this.base, this.root.id, this.hidden, this.isPrune(), this.getDirection()));
    };

    private rebuildLegend = (): void => {
        this.legend.removeAllComponents();

        for (const n of this.base.nodes) {
            this.legend.addComponent(legendRow(n, this.root.id, this.hidden, this.applyFilter));
        }
    };

    private rebuildBase = (): void => {
        const direction = this.getDirection();

        this.base = withDepthBadges(
            rootedDiagram(this.full, this.root, direction, this.getDepth()),
            this.full.edges,
            direction,
        );

        this.hidden.clear();

        this.rebuildLegend();
        this.applyFilter();
    };
}

const RootedRelationGraphPanelCallable = callable(RootedRelationGraphPanel);
type RootedRelationGraphPanelCallable = RootedRelationGraphPanel;
export { RootedRelationGraphPanelCallable as RootedRelationGraphPanel };
