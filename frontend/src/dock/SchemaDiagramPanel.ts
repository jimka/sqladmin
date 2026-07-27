// The schema entity-relationship diagram, opened as its own Dock tab from the
// navigator's schema-node right-click menu ("Open schema diagram"). Extends
// DiagramShell (see ./diagramShell.ts) with a selectable root: the shell's
// WEST `Root table` selector + direction/depth/prune controls + legend, over a
// CENTER DiagramView built from the graph buildSchemaDiagram assembled. Opens
// on the whole FK graph with no root chosen; picking a root narrows the view
// to its direction+depth neighbourhood exactly as RelationDiagramPanel's fixed
// root does, but here the user may pick a different root or clear back to the
// whole graph at any time. A single click only selects (highlights) a node;
// double-clicking a node reports its table name back to the controller, which
// reuses openReferencedTable — the same open path an FK link in StructurePanel
// uses — so activating a table behaves identically.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramShell
// directly. The `JunctionDiagramView` (see ./JunctionDiagramView.ts) is built
// as a local before `super()` (it is `super()`'s CENTER child); the
// "activate" / "contextmenu" listeners are
// wired after `super()`, inline arrows closing over the constructor's
// `onSelectTable` / `onContextMenu` parameters, never handed off by
// reference, so they need no arrow-function field. `applyFilter` and
// `rebuildBase` are handed to `fillLegend`/invoked from `rootingChanged`, so
// they are arrow-function fields.

import { callable } from "@jimka/typescript-ui/core";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { rootedBase, filteredBase } from "../data/relationDiagram";
import { attachFkEdgeTooltip } from "./edgeTooltip";
import { DiagramShell, fillLegend } from "./diagramShell";
import { JunctionDiagramView } from "./JunctionDiagramView";

/**
 * The schema diagram panel: the shell's WEST `Root table` + direction / depth
 * + prune + legend column plus a CENTER DiagramView. Double-clicking a node
 * invokes `onSelectTable` with the node's table name.
 */
class SchemaDiagramPanel extends DiagramShell {
    private readonly full: DiagramData;
    private readonly hidden = new Set<string>();
    private base: DiagramData;

    /**
     * @param data - The graph model (from buildSchemaDiagram).
     * @param onSelectTable - Invoked with the activated node's table name (its id).
     * @param onContextMenu - Invoked with a right-clicked node's table name and
     *   the originating event; omitted callers get no context menu.
     */
    constructor(data: DiagramData, onSelectTable: (table: string) => void,
                onContextMenu?: (table: string, event: MouseEvent) => void) {
        // Local before super() — it is super()'s CENTER child (`this` is
        // unavailable until super() returns).
        const view = JunctionDiagramView({ data });

        super({ view, full: data, rootCaption: "Root table" });

        this.full = data;
        this.base = data;

        attachFkEdgeTooltip(this.view);

        // Double-click opens the table; a single click only selects it.
        this.view.on("activate", (node: DiagramNodeData) => {
            onSelectTable(node.id);
        });

        this.view.on("contextmenu", (node: DiagramNodeData, event: MouseEvent) => {
            onContextMenu?.(node.id, event);
        });
    }

    protected rootingChanged(): void {
        this.rebuildBase();
    }

    protected pruneChanged(): void {
        this.applyFilter();
    }

    // Passed by reference to fillLegend's rows — MUST be an arrow field, or it
    // would lose `this` when invoked as a callback.
    private applyFilter = (): void => {
        this.view.setData(
            filteredBase(this.base, this.getRoot(), this.hidden, this.isPrune(), this.getDirection()));
    };

    private rebuildBase = (): void => {
        this.base = rootedBase(this.full, this.getRoot(), this.getDirection(), this.getDepth());

        this.hidden.clear();
        fillLegend(this.legend, this.base, this.getRoot(), this.hidden, this.applyFilter);
        this.applyFilter();
    };
}

const SchemaDiagramPanelCallable = callable(SchemaDiagramPanel);
type SchemaDiagramPanelCallable = SchemaDiagramPanel;
export { SchemaDiagramPanelCallable as SchemaDiagramPanel };
