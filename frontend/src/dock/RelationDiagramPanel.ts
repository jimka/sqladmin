// The relation-rooted entity-relationship diagram, opened as its own Dock tab
// from the navigator's right-click "Show relations" on a table/view/matview.
// Extends FilteredDiagramShell (see ./filteredDiagramShell.ts) with a fixed
// root for its WEST direction/depth+legend column; this class supplies the
// CENTER DiagramView (ELK-laid-out, pan/zoom) over the whole schema graph
// buildSchemaDiagram assembled, and everything specific to the FK diagram:
// card-mode nodes, column-emphasis wiring, and the coverage-highlight
// checkbox. Double-clicking a node reports its table name back to the
// controller via onSelectTable — the same open path the schema diagram and an
// FK link in StructurePanel use. This tab's title names its root (`invoices
// (relations)`), so the root never changes and no `Root …` selector is built.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends
// FilteredDiagramShell directly, which owns the derive/legend/filter
// lifecycle; this class overrides `applyFilter()` (a plain protected method,
// per FilteredDiagramShell's own header on why an overridable member must
// stay a method, not an arrow field) to clear `cards` and fold in the
// coverage style before delegating to the base `filteredGraph()`. Every
// former factory-closure `let` becomes a private instance field, assigned
// after `super()`. `selectColumn` is still an arrow field: it is handed by
// reference to the nodeRenderer, not overridden by any subclass. The child
// controls and the `JunctionDiagramView` are built as locals before `super()`
// (they are `super()`'s children), assigned to fields after, and their
// `change` listeners are wired after `super()` via `.on("change", …)` rather
// than the construction-time `listeners:` bag, so `this` is available.

import { Component, callable } from "@jimka/typescript-ui/core";
import { HBox }                     from "@jimka/typescript-ui/layout";
import { Checkbox, Text }           from "@jimka/typescript-ui/component/input";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { fixedRootBase }            from "../data/relationDiagram";
import { applyCoverageStyle }       from "../data/fkCardinality";
import { columnEmphasis }           from "../data/columnEmphasis";
import { TableCardNode }            from "./TableCardNode";
import { attachFkEdgeTooltip }      from "./edgeTooltip";
import { FilteredDiagramShell }     from "./filteredDiagramShell";
import type { FilteredDiagramConfig } from "./filteredDiagramShell";
import { depthChoice, depthFromChoice } from "./depthChoices";
import { JunctionDiagramView }      from "./JunctionDiagramView";

/**
 * The relation-rooted diagram panel: the shell's WEST direction / depth +
 * legend column plus a CENTER DiagramView. The root node is emphasized;
 * double-clicking any node invokes `onSelectTable` with its id.
 */
class RelationDiagramPanel extends FilteredDiagramShell {
    private showCoverage = false;

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
     *   the originating event; omitted callers get no context menu.
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
        const base  = fixedRootBase(full, root, "both", depthFromChoice(depth));
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

        const config: FilteredDiagramConfig = {
            view,
            full,
            fixedRoot: true,
            rootNode: root,
            extraControls: [
                new Component({
                    layoutManager: new HBox({ spacing: 4 }),
                    components   : [coverageControl, new Text("Highlight FKs without a covering index")],
                }),
            ],
            initialDepth: depth,
        };

        super(config);

        this.cards = cards;
        selectColumn = this.selectColumn;

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

    protected applyFilter(): void {
        // The nodeRenderer repopulates `cards` as setData rebuilds every node
        // below — cleared first so a card this filter change removes cannot
        // linger as a stale entry.
        this.cards.clear();

        this.view.setData(applyCoverageStyle(this.filteredGraph(), this.showCoverage));
    }

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
}

const RelationDiagramPanelCallable = callable(RelationDiagramPanel);
type RelationDiagramPanelCallable = RelationDiagramPanel;
export { RelationDiagramPanelCallable as RelationDiagramPanel };
