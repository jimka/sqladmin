// The database-wide entity-relationship diagram, opened as its own Dock tab
// from the navigator's database-node right-click "Open database diagram". A
// database-scale table graph is an unreadable hairball on its own, so this
// panel offers two modes: Overview (default) — one node per schema, edges
// labelled with the cross-schema FK count, the legible entry point — and
// Tables — the full cross-schema table graph, narrowed by the shell's
// selectable-root/direction/depth/prune traversal, then grouped into one
// compound container box per schema via groupBySchema. Double-clicking a
// schema node in Overview drills into Tables mode filtered to that schema;
// double-clicking a leaf in Tables mode opens that table (using *that leaf's
// own* schema, read off its node data, since it varies across the diagram);
// double-clicking a container is a no-op.
//
// Overview mode is not modelled as "root = null": in Overview the drawn graph
// is the schema overview, not the rooted table graph at all, so this panel
// calls the shell's setRootingDisplayed(false) to hide the `Root table` row,
// the traversal block, and the legend together, independently of the root
// value the shell still tracks for when Tables mode returns.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends DiagramShell (see
// ./diagramShell.ts) with a selectable root for its WEST Mode + `Root table` +
// (Tables-mode-only) direction/depth/prune controls + per-schema legend,
// following RelationDiagramPanel's pattern. Every former factory-closure `let`
// becomes a private instance field; the closure helpers (`applyFilter`,
// `rebuildLegend`, `rebuildBase`, `focusSchema`, `isHiddenLeaf`) become
// arrow-function fields (consistency with the set — `applyFilter` is passed by
// reference to `schemaLegendRow`, so it must be one). `modeControl` is a field
// (not just a local) because `focusSchema` and the mode listener mutate it
// after construction; the root selector itself is the shell's.

import { Component, Util, callable } from "@jimka/typescript-ui/core";
import { HBox }                     from "@jimka/typescript-ui/layout";
import { Checkbox, ComboBox, Text } from "@jimka/typescript-ui/component/input";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { buildDatabaseDiagram }     from "../data/buildDatabaseDiagram";
import type { SchemaTables, TableNodeData } from "../data/buildDatabaseDiagram";
import { groupBySchema }            from "../data/groupBySchema";
import { buildSchemaOverviewDiagram } from "../data/schemaOverviewDiagram";
import { applyHide, subgraph, rootedBase } from "../data/relationDiagram";
import { attachFkEdgeTooltip }      from "./edgeTooltip";
import { DiagramShell, labelledRow } from "./diagramShell";
import type { DiagramShellConfig } from "./diagramShell";
import { JunctionDiagramView }      from "./JunctionDiagramView";

type DiagramMode = "overview" | "tables";

/**
 * The database diagram panel: the shell's WEST Mode toggle + `Root table` +
 * (Tables-mode-only) direction/depth/prune controls + per-schema legend, over
 * a CENTER DiagramView.
 */
class DatabaseDiagramPanel extends DiagramShell {
    // Assembled once from the fetched schemas; both modes derive from these
    // without re-fetching. `full` is the flat, ungrouped table graph the
    // rooted/prune traversal runs on (grouping happens last, only for display).
    private readonly full:          DiagramData;
    private readonly overviewGraph: DiagramData;
    private readonly schemaNames:   string[];

    // View state, re-derived on each control / legend change — the same
    // pattern RelationDiagramPanel uses. `base` is the direction+depth-rooted
    // graph (or the whole `full` graph when no root is chosen); the filtered
    // (per-schema hide, optionally pruned) view over it is what Tables mode
    // actually shows, after grouping by schema. `base` is seeded post-`super()`.
    private mode: DiagramMode = "overview";
    private readonly hiddenSchemas = new Set<string>();
    private base!: DiagramData;

    private readonly modeControl: ComboBox;

    /**
     * @param schemas - Every schema's tables + structures (from buildDatabaseGraphData).
     * @param onSelectTable - Invoked with the activated leaf's schema + table.
     * @param onContextMenu - Invoked with a right-clicked Tables-mode leaf's
     *   schema + table and the originating event. An Overview schema node or a
     *   Tables-mode container box never forwards (mirrors the activate branch).
     */
    constructor(schemas: SchemaTables[], onSelectTable: (schema: string, table: string) => void,
                onContextMenu?: (schema: string, table: string, event: MouseEvent) => void) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns).
        const full          = buildDatabaseDiagram(schemas, Util.measureTextWidths);
        const overviewGraph = buildSchemaOverviewDiagram(schemas);
        const schemaNames   = schemas.map(s => s.schema);

        const view = JunctionDiagramView({ data: overviewGraph });

        const modeControl = ComboBox({
            items: [
                { key: "overview", label: "Overview" },
                { key: "tables",   label: "Tables" },
            ],
            value: "overview",
        });

        const config: DiagramShellConfig = {
            view,
            full,
            rootCaption   : "Root table",
            headerControls: [labelledRow("Mode", modeControl)],
        };

        super(config);

        this.full          = full;
        this.overviewGraph = overviewGraph;
        this.schemaNames   = schemaNames;
        this.base           = full;
        this.modeControl    = modeControl;

        // Overview is the default mode: this panel is not showing a rooted
        // graph at all, so the selector row, the traversal block, and the
        // legend all go.
        this.setRootingDisplayed(false);

        // Wire listeners after super() (this now available). Moved from the
        // construction-time `listeners:` bag to post-super() `.on()` calls so
        // `this` is initialized when a change fires.
        attachFkEdgeTooltip(this.view);

        this.view.on("activate", (node: DiagramNodeData) => {
            if (this.mode === "overview") {
                this.focusSchema(node.id); // the overview node's id is the bare schema name
                return;
            }

            if ((node.children?.length ?? 0) > 0) {
                return; // a container (schema box): activation is a no-op
            }

            const data = node.data as TableNodeData | undefined;

            if (data) {
                onSelectTable(data.schema, data.table);
            }
        });

        this.view.on("contextmenu", (node: DiagramNodeData, event: MouseEvent) => {
            if (this.mode === "overview" || (node.children?.length ?? 0) > 0) {
                return;
            }

            const data = node.data as TableNodeData | undefined;

            if (data) {
                onContextMenu?.(data.schema, data.table, event);
            }
        });

        modeControl.on("change", (v: string) => {
            this.mode = v as DiagramMode;

            if (this.mode === "overview") {
                this.setRootingDisplayed(false);
                this.view.setData(this.overviewGraph);
            } else {
                this.setRootingDisplayed(true);
                this.rebuildBase();
                this.rebuildLegend();
            }

            this.settleViewport();
        });
    }

    protected rootingChanged(): void {
        this.rebuildBase();
    }

    protected pruneChanged(): void {
        this.applyFilter();
    }

    // True when `n`'s schema (read off its leaf data) is currently hidden.
    // Passed by reference to Array#filter within applyFilter — kept an
    // arrow-function field for consistency with the rest of this helper set.
    private isHiddenLeaf = (n: DiagramNodeData): boolean =>
        this.hiddenSchemas.has((n.data as TableNodeData).schema);

    // Push the current base + per-schema hide/prune state into the view
    // (Tables mode only). Passed by reference to schemaLegendRow — MUST be an
    // arrow field, or it would lose `this` when invoked as a callback.
    private applyFilter = (): void => {
        if (this.mode !== "tables") {
            return;
        }

        const root = this.getRoot();

        const filtered = root !== null
            ? applyHide(this.base, root, new Set(this.base.nodes.filter(this.isHiddenLeaf).map(n => n.id)), this.isPrune(), this.getDirection())
            : subgraph(this.base, new Set(this.base.nodes.filter(n => !this.isHiddenLeaf(n)).map(n => n.id)));

        this.view.setData(groupBySchema(filtered));
    };

    // Rebuild the per-schema legend rows from the full schema set.
    private rebuildLegend = (): void => {
        this.legend.disposeAllComponents();

        for (const schema of this.schemaNames) {
            this.legend.addComponent(schemaLegendRow(schema, this.hiddenSchemas, this.applyFilter));
        }
    };

    // Re-root (or un-root) on a root/direction/depth change: fresh base.
    private rebuildBase = (): void => {
        this.base = rootedBase(this.full, this.getRoot(), this.getDirection(), this.getDepth());

        this.applyFilter();
    };

    // Switch to Tables mode, hiding every schema except `schema` (Overview
    // drill-down). Called from the view's "activate" handler — needs no
    // by-reference registration itself, but kept an arrow field for
    // consistency with the rest of this helper set.
    private focusSchema = (schema: string): void => {
        this.mode = "tables";
        this.hiddenSchemas.clear();

        for (const s of this.schemaNames) {
            if (s !== schema) {
                this.hiddenSchemas.add(s);
            }
        }

        this.modeControl.setValue("tables");
        this.setRootingDisplayed(true);
        this.rebuildLegend();

        // Last: setRoot resets the selector to (none) and re-derives through
        // rootingChanged, so mode and hiddenSchemas must already be set.
        this.setRoot(null);
        this.settleViewport();
    };
}

/**
 * One per-schema legend row: a checkbox (checked = shown) beside the schema
 * name. Toggling it off hides every table in that schema; on shows them again.
 *
 * @param schema - The schema this row represents.
 * @param hiddenSchemas - The shared hidden-schema set this row mutates.
 * @param applyFilter - Re-filters the view after a toggle.
 * @returns The row component.
 */
function schemaLegendRow(
    schema: string,
    hiddenSchemas: Set<string>,
    applyFilter: () => void,
): Component {
    const checkbox = Checkbox({
        value: !hiddenSchemas.has(schema),
        listeners: {
            change: (v: boolean) => {
                if (v) {
                    hiddenSchemas.delete(schema);
                } else {
                    hiddenSchemas.add(schema);
                }

                applyFilter();
            },
        },
    });

    return new Component({
        layoutManager: new HBox({ spacing: 4 }),
        components   : [checkbox, new Text(schema)],
    });
}

const DatabaseDiagramPanelCallable = callable(DatabaseDiagramPanel);
type DatabaseDiagramPanelCallable = DatabaseDiagramPanel;
export { DatabaseDiagramPanelCallable as DatabaseDiagramPanel };
