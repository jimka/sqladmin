// The relation-rooted entity-relationship diagram, opened as its own Dock tab
// from the navigator's right-click "Show relations" on a table/view/matview.
// Extends DiagramShell (see ./diagramShell.ts) with a fixed root for its WEST
// direction/depth+legend column; this class supplies the CENTER DiagramView
// (ELK-laid-out, pan/zoom) over the whole schema graph buildSchemaDiagram
// assembled, and everything specific to the FK diagram: card-mode nodes,
// column-emphasis wiring, and the coverage-highlight checkbox. Double-clicking
// a node reports its table name back to the controller via onSelectTable — the
// same open path the schema diagram and an FK link in StructurePanel use. This
// tab's title names its root (`invoices (relations)`), so the root never
// changes and no `Root …` selector is built.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramShell
// directly. Every former factory-closure `let` becomes a private instance
// field, assigned after `super()`. The closure helpers (`applyFilter`,
// `rebuildLegend`, `rebuildBase`) become arrow-function fields: `applyFilter`
// is passed by reference to `legendRow`, so it must be an arrow field (a plain
// method would drop `this`); the others call/are called among this set, so
// they stay arrow fields too for consistency. The child controls and the
// `JunctionDiagramView` are built as locals before `super()` (they are
// `super()`'s children), assigned to fields after, and their `change` listeners are wired
// after `super()` via `.on("change", …)` rather than the construction-time
// `listeners:` bag, so `this` is available.

import { Component, callable } from "@jimka/typescript-ui/core";
import { HBox }                     from "@jimka/typescript-ui/layout";
import { Checkbox, Text }           from "@jimka/typescript-ui/component/input";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { rootedDiagram, applyHide, withDepthBadges } from "../data/relationDiagram";
import { applyCoverageStyle }       from "../data/fkCardinality";
import { columnEmphasis }           from "../data/columnEmphasis";
import { TableCardNode }            from "./TableCardNode";
import { attachFkEdgeTooltip }      from "./edgeTooltip";
import { DiagramShell, legendRow }  from "./diagramShell";
import type { DiagramShellConfig } from "./diagramShell";
import { depthChoice, depthFromChoice } from "./depthChoices";
import { JunctionDiagramView }      from "./JunctionDiagramView";

/**
 * The relation-rooted diagram panel: the shell's WEST direction / depth +
 * legend column plus a CENTER DiagramView. The root node is emphasized;
 * double-clicking any node invokes `onSelectTable` with its id.
 */
class RelationDiagramPanel extends DiagramShell {
    private readonly full: DiagramData;
    private readonly root: DiagramNodeData;
    private showCoverage = false;
    private readonly hidden = new Set<string>();
    private base!: DiagramData;

    // Cards keyed by node id, so a column click can re-tint every card's rows
    // without a lookup through the view. Rebuilt by the nodeRenderer on every
    // setData (including a filter recompute), so it never goes stale.
    private readonly cards: Map<string, TableCardNode>;

    /**
     * @param full - The whole schema's graph (from buildSchemaDiagram).
     * @param root - The root relation's node data (id = bare table name; carries
     *   the kind glyph so a view / matview root still renders when it has no FK
     *   edges).
     * @param onSelectTable - Invoked with the activated node's table name (its id).
     * @param onContextMenu - Invoked with a right-clicked node's table name and
     *   the originating event; omitted callers get no context menu (e.g. the
     *   role-membership graph, whose nodes are roles, not database objects).
     * @param initialDepth - The `DEPTH_CHOICES` entry the Depth control opens
     *   at (see `depthChoices.ts`); anything else opens at the default.
     */
    constructor(full: DiagramData, root: DiagramNodeData, onSelectTable: (table: string) => void,
                onContextMenu?: (table: string, event: MouseEvent) => void, initialDepth?: string) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns). `selectColumn` is re-pointed to
        // the real handler once `this` exists (DiagramView's constructor calls
        // nodeRenderer during its own super() cascade, so the renderer must
        // not touch `this`); it can only ever be invoked by a user click, long
        // after that.
        const depth = depthChoice(initialDepth);
        const base  = withDepthBadges(rootedDiagram(full, root, "both", depthFromChoice(depth)), full.edges, "both");
        const cards = new Map<string, TableCardNode>();
        let selectColumn: (nodeId: string, column: string) => void = () => {};

        // Emphasis lives in the renderer (not applied imperatively after setData),
        // so it survives every filter recompute — setData rebuilds nodes through
        // it. `full` already carries card `data`/`ports` from the controller
        // (card mode), so this single renderer covers every node without a mode
        // flag.
        const nodeRenderer = (n: DiagramNodeData): Component => {
            const card = TableCardNode(n, n.id === root.id, (column: string) => selectColumn(n.id, column));

            cards.set(n.id, card);

            return card;
        };

        const view = JunctionDiagramView({ data: base, nodeRenderer, initialFocusNode: root.id });
        const coverageControl = Checkbox({ value: false });

        const config: DiagramShellConfig = {
            view,
            fixedRoot: true,
            root: root.id,
            extraControls: [
                new Component({
                    layoutManager: new HBox({ spacing: 4 }),
                    components   : [coverageControl, new Text("Highlight FKs without a covering index")],
                }),
            ],
            initialDepth: depth,
        };

        super(config);

        this.full = full;
        this.root = root;
        this.base = base;
        this.cards = cards;
        selectColumn = this.selectColumn;

        this.rebuildLegend();

        // Wire listeners after super() (this now available). Moved from the
        // construction-time `listeners:` bag to post-super() `.on()` calls so
        // `this` is initialized when a change fires.
        this.view.on("activate", (n: DiagramNodeData) => onSelectTable(n.id));
        this.view.on("contextmenu", (n: DiagramNodeData, event: MouseEvent) => onContextMenu?.(n.id, event));
        // Clicking empty canvas already clears the node selection and emits an
        // empty "selection" — clear the column emphasis alongside it. A
        // filter recompute needs no separate handling: applyFilter rebuilds
        // every card through the renderer, so rows come back untinted and the
        // layer clears its own emphasis on setEdges.
        this.view.on("selection", (nodes: DiagramNodeData[]) => {
            if (nodes.length === 0) {
                this.view.setEdgeEmphasis(null);
                this.view.setNodeEmphasis(null);

                for (const card of this.cards.values()) {
                    card.setEmphasisedColumns([]);
                }
            }
        });
        coverageControl.on("change", (v: boolean) => { this.showCoverage = v; this.applyFilter(); });
        attachFkEdgeTooltip(this.view);
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
        // The nodeRenderer repopulates `cards` as setData rebuilds every node
        // below — cleared first so a card removed by this filter change
        // cannot linger as a stale entry.
        this.cards.clear();

        this.view.setData(applyCoverageStyle(
            applyHide(this.base, this.root.id, this.hidden, this.isPrune(), this.getDirection()), this.showCoverage));
    };

    // Passed to the nodeRenderer (via the pre-super() `selectColumn` local) —
    // MUST be an arrow field, since it is handed off by reference.
    private selectColumn = (nodeId: string, column: string): void => {
        const data = this.view.getData();

        if (data === null) {
            return;
        }

        const emphasis = columnEmphasis(data, nodeId, column);

        this.view.setEdgeEmphasis(emphasis.edgeIds);
        // emphasis.columns is keyed by exactly the cards the click touches —
        // the clicked card plus the far end of every attached edge — so it
        // doubles as the node-emphasis set with no separate derivation.
        this.view.setNodeEmphasis([...emphasis.columns.keys()]);

        for (const [id, card] of this.cards) {
            card.setEmphasisedColumns(emphasis.columns.get(id) ?? []);
        }
    };

    private rebuildLegend = (): void => {
        this.legend.disposeAllComponents();

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

const RelationDiagramPanelCallable = callable(RelationDiagramPanel);
type RelationDiagramPanelCallable = RelationDiagramPanel;
export { RelationDiagramPanelCallable as RelationDiagramPanel };
