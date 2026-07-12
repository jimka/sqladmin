// The database-wide entity-relationship diagram, opened as its own Dock tab
// from the navigator's database-node right-click "Open database diagram". A
// database-scale table graph is an unreadable hairball on its own, so this
// panel offers two modes: Overview (default) — one node per schema, edges
// labelled with the cross-schema FK count, the legible entry point — and
// Tables — the full cross-schema table graph, narrowed by the same
// rooted/direction/depth/prune traversal RelationDiagramPanel uses, then
// grouped into one compound container box per schema via groupBySchema.
// Double-clicking a schema node in Overview drills into Tables mode filtered
// to that schema; double-clicking a leaf in Tables mode opens that table
// (using *that leaf's own* schema, read off its node data, since it varies
// across the diagram); double-clicking a container is a no-op.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends Panel directly,
// following RelationDiagramPanel's pattern. Every former factory-closure `let`
// becomes a private instance field; the closure helpers (`applyFilter`,
// `rebuildLegend`, `rebuildBase`, `focusSchema`, `isHiddenLeaf`) become
// arrow-function fields (consistency with the set — `applyFilter` is passed by
// reference to `schemaLegendRow`, so it must be one). `modeControl`,
// `rootControl`, `tablesControls`, and `legend` are fields (not just locals)
// because `focusSchema` and the mode listener mutate them after construction.

import { Component, Panel }         from "@jimka/typescript-ui/core";
import { Border, HBox, VBox }       from "@jimka/typescript-ui/layout";
import { Placement }                from "@jimka/typescript-ui/primitive";
import { Checkbox, ComboBox, Text } from "@jimka/typescript-ui/component/input";
import { DiagramView }              from "@jimka/typescript-ui/component/diagram";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { buildDatabaseDiagram }     from "../data/buildDatabaseDiagram";
import type { SchemaTables, TableNodeData } from "../data/buildDatabaseDiagram";
import { groupBySchema }            from "../data/groupBySchema";
import { buildSchemaOverviewDiagram } from "../data/schemaOverviewDiagram";
import { rootedDiagram, applyHide, subgraph } from "../data/relationDiagram";
import type { TraversalDirection }  from "../data/relationDiagram";

// One hop keeps the first rooted cut readable, mirroring RelationDiagramPanel.
const DEFAULT_DEPTH = 1;

// Depth choices offered in the control; capped low for the same reason
// RelationDiagramPanel caps it — deeper walks quickly pull in most of the
// database and defeat the point of a rooted view.
const DEPTH_CHOICES = ["1", "2", "3"];

// Fixed width of the WEST side panel, matching RelationDiagramPanel's legend.
const LEGEND_WIDTH = 220;

// The root ComboBox's sentinel item: no root selected, so Tables mode shows
// the full (grouped) graph rather than a rooted neighbourhood.
const ROOT_NONE = "(none)";

type DiagramMode = "overview" | "tables";

/**
 * The database diagram panel: a Border layout with a WEST mode toggle +
 * (Tables-mode-only) root/direction/depth/prune controls + per-schema legend,
 * and a CENTER DiagramView.
 */
export class DatabaseDiagramPanel extends Panel {
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
    private rootId: string | null = null;
    private direction: TraversalDirection = "both";
    private depth = DEFAULT_DEPTH;
    private prune = false;
    private readonly hiddenSchemas = new Set<string>();
    private base!: DiagramData;

    private readonly view:           DiagramView;
    private readonly modeControl:    ComboBox;
    private readonly rootControl:    ComboBox;
    private readonly tablesControls: Panel;
    private readonly legend:         Panel;

    /**
     * @param schemas - Every schema's tables + structures (from buildDatabaseGraphData).
     * @param onSelectTable - Invoked with the activated leaf's schema + table.
     */
    constructor(schemas: SchemaTables[], onSelectTable: (schema: string, table: string) => void) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns).
        const full          = buildDatabaseDiagram(schemas);
        const overviewGraph = buildSchemaOverviewDiagram(schemas);
        const schemaNames   = schemas.map(s => s.schema);

        const view = DiagramView({ data: overviewGraph });

        const rootControl = ComboBox({ items: [ROOT_NONE, ...full.nodes.map(n => n.id)], value: ROOT_NONE });

        const directionControl = ComboBox({
            items: [
                { key: "downstream", label: "Downstream" },
                { key: "upstream",   label: "Upstream" },
                { key: "both",       label: "Both" },
            ],
            value: "both",
        });

        const depthControl = ComboBox({ items: DEPTH_CHOICES, value: String(DEFAULT_DEPTH) });
        const pruneControl = Checkbox({ value: false });

        const tablesControls = Panel({
            layoutManager: new VBox({ spacing: 4 }),
            components: [
                labelledRow("Root table", rootControl),
                labelledRow("Direction", directionControl),
                labelledRow("Depth", depthControl),
                new Component({ layoutManager: new HBox({ spacing: 4 }), components: [pruneControl, new Text("Hide with prune")] }),
            ],
        });

        const modeControl = ComboBox({
            items: [
                { key: "overview", label: "Overview" },
                { key: "tables",   label: "Tables" },
            ],
            value: "overview",
        });

        const legend = Panel({ layoutManager: new VBox({ spacing: 2 }), autoScroll: "auto" });

        // Overview is the default mode: the Tables-only controls + legend start
        // hidden until the user switches (or drills in via focusSchema).
        tablesControls.setDisplayed(false);
        legend.setDisplayed(false);

        const controls = Panel({
            layoutManager: new VBox({ spacing: 4 }),
            components: [labelledRow("Mode", modeControl), tablesControls],
        });

        const west = Panel({
            layoutManager: new Border(),
            preferredSize: { width: LEGEND_WIDTH, height: 0 },
            minSize      : { width: LEGEND_WIDTH, height: 0 },
            components: [
                { component: controls, constraints: { placement: Placement.NORTH } },
                { component: legend,   constraints: { placement: Placement.CENTER } },
            ],
        });

        super({
            layoutManager: new Border(),
            components: [
                { component: west, constraints: { placement: Placement.WEST } },
                { component: view, constraints: { placement: Placement.CENTER } },
            ],
        });

        this.full          = full;
        this.overviewGraph = overviewGraph;
        this.schemaNames   = schemaNames;
        this.base           = full;
        this.view           = view;
        this.modeControl    = modeControl;
        this.rootControl    = rootControl;
        this.tablesControls = tablesControls;
        this.legend         = legend;

        // Wire listeners after super() (this now available). Moved from the
        // construction-time `listeners:` bag to post-super() `.on()` calls so
        // `this` is initialized when a change fires.
        view.on("activate", (node: DiagramNodeData) => {
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

        rootControl.on("change", (v: string) => { this.rootId = v === ROOT_NONE ? null : v; this.rebuildBase(); });
        directionControl.on("change", (v: string) => { this.direction = v as TraversalDirection; this.rebuildBase(); });
        depthControl.on("change", (v: string) => { this.depth = Number(v); this.rebuildBase(); });
        pruneControl.on("change", (v: boolean) => { this.prune = v; this.applyFilter(); });
        modeControl.on("change", (v: string) => {
            this.mode = v as DiagramMode;

            if (this.mode === "overview") {
                this.tablesControls.setDisplayed(false);
                this.legend.setDisplayed(false);
                this.view.setData(this.overviewGraph);
            } else {
                this.tablesControls.setDisplayed(true);
                this.legend.setDisplayed(true);
                this.rebuildBase();
                this.rebuildLegend();
            }
        });
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

        const filtered = this.rootId !== null
            ? applyHide(this.base, this.rootId, new Set(this.base.nodes.filter(this.isHiddenLeaf).map(n => n.id)), this.prune, this.direction)
            : subgraph(this.base, new Set(this.base.nodes.filter(n => !this.isHiddenLeaf(n)).map(n => n.id)));

        this.view.setData(groupBySchema(filtered));
    };

    // Rebuild the per-schema legend rows from the full schema set.
    private rebuildLegend = (): void => {
        this.legend.removeAllComponents();

        for (const schema of this.schemaNames) {
            this.legend.addComponent(schemaLegendRow(schema, this.hiddenSchemas, this.applyFilter));
        }
    };

    // Re-root (or un-root) on a root/direction/depth change: fresh base.
    private rebuildBase = (): void => {
        if (this.rootId === null) {
            this.base = this.full;
        } else {
            const rootNode = this.full.nodes.find(n => n.id === this.rootId);
            this.base = rootNode ? rootedDiagram(this.full, rootNode, this.direction, this.depth) : this.full;
        }

        this.applyFilter();
    };

    // Switch to Tables mode, hiding every schema except `schema` (Overview
    // drill-down). Called from the view's "activate" handler — needs no
    // by-reference registration itself, but kept an arrow field for
    // consistency with the rest of this helper set.
    private focusSchema = (schema: string): void => {
        this.mode = "tables";
        this.rootId = null;
        this.hiddenSchemas.clear();

        for (const s of this.schemaNames) {
            if (s !== schema) {
                this.hiddenSchemas.add(s);
            }
        }

        this.modeControl.setValue("tables");
        this.rootControl.setValue(ROOT_NONE);
        this.tablesControls.setDisplayed(true);
        this.legend.setDisplayed(true);
        this.rebuildBase();
        this.rebuildLegend();
    };
}

/**
 * A caption stacked above its control, matching RelationDiagramPanel's layout.
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
