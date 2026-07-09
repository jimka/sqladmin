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
 * Build the database diagram panel: a Border layout with a WEST mode toggle +
 * (Tables-mode-only) root/direction/depth/prune controls + per-schema legend,
 * and a CENTER DiagramView.
 *
 * @param schemas - Every schema's tables + structures (from buildDatabaseGraphData).
 * @param onSelectTable - Invoked with the activated leaf's schema + table.
 * @returns A Component to host as the tab content.
 */
export function DatabaseDiagramPanel(
    schemas: SchemaTables[],
    onSelectTable: (schema: string, table: string) => void,
): Component {
    // Assembled once from the fetched schemas; both modes derive from these
    // without re-fetching. `full` is the flat, ungrouped table graph the
    // rooted/prune traversal runs on (grouping happens last, only for display).
    const full          = buildDatabaseDiagram(schemas);
    const overviewGraph = buildSchemaOverviewDiagram(schemas);
    const schemaNames   = schemas.map(s => s.schema);

    // View state, held in the factory closure and re-derived on each control /
    // legend change — the same pattern RelationDiagramPanel uses. `base` is the
    // direction+depth-rooted graph (or the whole `full` graph when no root is
    // chosen); the filtered (per-schema hide, optionally pruned) view over it
    // is what Tables mode actually shows, after grouping by schema.
    let mode: DiagramMode = "overview";
    let rootId: string | null = null;
    let direction: TraversalDirection = "both";
    let depth = DEFAULT_DEPTH;
    let prune = false;
    const hiddenSchemas = new Set<string>();
    let base: DiagramData = full;

    const view = DiagramView({ data: overviewGraph });

    view.on("activate", (node: DiagramNodeData) => {
        if (mode === "overview") {
            focusSchema(node.id); // the overview node's id is the bare schema name
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

    /** True when `n`'s schema (read off its leaf data) is currently hidden. */
    const isHiddenLeaf = (n: DiagramNodeData): boolean =>
        hiddenSchemas.has((n.data as TableNodeData).schema);

    /** Push the current base + per-schema hide/prune state into the view (Tables mode only). */
    const applyFilter = (): void => {
        if (mode !== "tables") {
            return;
        }

        const filtered = rootId !== null
            ? applyHide(base, rootId, new Set(base.nodes.filter(isHiddenLeaf).map(n => n.id)), prune, direction)
            : subgraph(base, new Set(base.nodes.filter(n => !isHiddenLeaf(n)).map(n => n.id)));

        view.setData(groupBySchema(filtered));
    };

    /** Rebuild the per-schema legend rows from the full schema set. */
    const rebuildLegend = (): void => {
        legend.removeAllComponents();

        for (const schema of schemaNames) {
            legend.addComponent(schemaLegendRow(schema, hiddenSchemas, applyFilter));
        }
    };

    /** Re-root (or un-root) on a root/direction/depth change: fresh base. */
    const rebuildBase = (): void => {
        if (rootId === null) {
            base = full;
        } else {
            const rootNode = full.nodes.find(n => n.id === rootId);
            base = rootNode ? rootedDiagram(full, rootNode, direction, depth) : full;
        }

        applyFilter();
    };

    /** Switch to Tables mode, hiding every schema except `schema` (Overview drill-down). */
    const focusSchema = (schema: string): void => {
        mode = "tables";
        rootId = null;
        hiddenSchemas.clear();

        for (const s of schemaNames) {
            if (s !== schema) {
                hiddenSchemas.add(s);
            }
        }

        modeControl.setValue("tables");
        rootControl.setValue(ROOT_NONE);
        tablesControls.setDisplayed(true);
        legend.setDisplayed(true);
        rebuildBase();
        rebuildLegend();
    };

    const rootControl = ComboBox({
        items: [ROOT_NONE, ...full.nodes.map(n => n.id)],
        value: ROOT_NONE,
        listeners: {
            change: (v: string) => {
                rootId = v === ROOT_NONE ? null : v;
                rebuildBase();
            },
        },
    });

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
        listeners: {
            change: (v: string) => {
                mode = v as DiagramMode;

                if (mode === "overview") {
                    tablesControls.setDisplayed(false);
                    legend.setDisplayed(false);
                    view.setData(overviewGraph);
                } else {
                    tablesControls.setDisplayed(true);
                    legend.setDisplayed(true);
                    rebuildBase();
                    rebuildLegend();
                }
            },
        },
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

    return Panel({
        layoutManager: new Border(),
        components: [
            { component: west, constraints: { placement: Placement.WEST } },
            { component: view, constraints: { placement: Placement.CENTER } },
        ],
    });
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
