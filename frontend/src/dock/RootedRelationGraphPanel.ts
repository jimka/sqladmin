// The relation-rooted dependency/inheritance graph, opened as its own Dock tab
// from the navigator's right-click "Dependencies" / "Inheritance" on a
// table/view/matview. Extends FilteredDiagramShell (see
// ./filteredDiagramShell.ts) with a fixed root for its WEST direction/depth+
// legend column; this class supplies the CENTER DiagramView over the whole
// schema's dependency or inheritance graph, narrowed to the chosen root's
// neighbourhood via the shared direction+depth traversal. Reuses
// RelationGraphPanel's node renderer (relationGraphNodeRenderer) so a rooted
// and an unrooted relation graph draw nodes identically. Double-clicking a
// node reports its RelationNodeData back to the controller, which routes
// activation through openReferencedTable. This tab's title names its root, so
// the root never changes and no `Root …` selector is built.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends
// FilteredDiagramShell directly, which owns the whole derive/legend/filter
// lifecycle. The `JunctionDiagramView` and its badged base graph are built as
// locals before `super()` (they are `super()`'s children, and the pre-super()
// base seeds the view's own initial `data` so it renders before
// FilteredDiagramShell's constructor derives its own — see that class's
// header for why both calls agree); the "activate" / "contextmenu" listeners
// are wired after `super()`.

import { callable } from "@jimka/typescript-ui/core";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { fixedRootBase } from "../data/relationDiagram";
import type { RelationNodeData } from "../data/buildRelationGraph";
import { relationGraphNodeRenderer } from "./RelationGraphPanel";
import { FilteredDiagramShell } from "./filteredDiagramShell";
import { depthChoice, depthFromChoice } from "./depthChoices";
import { JunctionDiagramView } from "./JunctionDiagramView";

/**
 * The relation-rooted dependency/inheritance graph panel: the shell's WEST
 * direction / depth + legend column plus a CENTER DiagramView. The root node
 * is emphasized; double-clicking any node invokes `onSelect` with its
 * RelationNodeData.
 */
class RootedRelationGraphPanel extends FilteredDiagramShell {
    /**
     * @param full - The whole schema's dependency or inheritance graph.
     * @param root - The rooted relation's node data (id = `schema.name`).
     * @param onSelect - Invoked with the activated node's RelationNodeData.
     * @param onContextMenu - Invoked with a right-clicked node's RelationNodeData
     *   and the originating event.
     * @param initialDepth - The `DEPTH_CHOICES` entry the Depth control opens
     *   at (see `depthChoices.ts`); anything else opens at the default.
     */
    constructor(
        full: DiagramData,
        root: DiagramNodeData,
        onSelect: (node: RelationNodeData) => void,
        onContextMenu?: (node: RelationNodeData, event: MouseEvent) => void,
        initialDepth?: string,
    ) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns).
        const depth = depthChoice(initialDepth);
        const base  = fixedRootBase(full, root, "both", depthFromChoice(depth));
        const view = JunctionDiagramView({
            data: base,
            nodeRenderer: relationGraphNodeRenderer(root.id),
            initialFocusNode: root.id,
        });

        super({ view, full, fixedRoot: true, rootNode: root, initialDepth: depth });

        // Wire listeners after super() (this now available).
        this.view.on("activate", (n: DiagramNodeData) => onSelect(n.data as RelationNodeData));
        this.view.on("contextmenu", (n: DiagramNodeData, event: MouseEvent) => {
            onContextMenu?.(n.data as RelationNodeData, event);
        });
    }
}

const RootedRelationGraphPanelCallable = callable(RootedRelationGraphPanel);
type RootedRelationGraphPanelCallable = RootedRelationGraphPanel;
export { RootedRelationGraphPanelCallable as RootedRelationGraphPanel };
