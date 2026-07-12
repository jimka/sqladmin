// Render a rows query result as two independent tab bodies, hosted by
// QueryPanel's result TabPanel:
//
//   * QueryResultGrid — the read-only results grid. Built for every rows
//     result. Its MemoryStore needs no teardown, so dispose is a no-op.
//   * QueryResultChart — a bar/line chart of the same rows over a config strip
//     (x/y column combos + a line/bar type toggle). Built only for a chartable
//     result (>=1 row, >=1 numeric column); the caller (QueryPanel) guards on
//     isChartable before calling. dispose releases the live chart instance.
//
// The chart is built in-memory from `buildChartSeries` (see chartConfig.ts)
// rather than store-bound: a re-run always rebuilds the whole view (the result
// set is static), and store binding cannot express a datetime x-axis or an
// ordinal row-index x (see chartConfig's Architecture Decisions). The grid and
// chart are separate tabs, not a toggled single view, so the user can keep the
// grid while charting; the tab strip owns the grid<->chart switch.

import { Component, Container, Panel }           from "@jimka/typescript-ui/core";
import { Placement }                             from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit, HBox }     from "@jimka/typescript-ui/layout";
import { ToolBar }                               from "@jimka/typescript-ui/component/menubar";
import { Spacer }                                from "@jimka/typescript-ui/component/container";
import { Text, ComboBox }                        from "@jimka/typescript-ui/component/input";
import { ToggleButton }                          from "@jimka/typescript-ui/component/button";
import { Table }                                 from "@jimka/typescript-ui/component/table";
import { MemoryStore }                           from "@jimka/typescript-ui/data";
import { Glyph }                                 from "@jimka/typescript-ui/component/display";
import { LineChart, BarChart }                   from "@jimka/typescript-ui/component/chart";
import { chart_line }                            from "@jimka/typescript-ui/glyphs/solid/chart_line";
import { chart_column }                          from "@jimka/typescript-ui/glyphs/solid/chart_column";
import { buildQueryModel }                       from "../data/buildModel";
import {
    defaultChartConfig, xCandidates, numericColumns, isTimeX, buildChartSeries,
} from "../data/chartConfig";
import type { ChartConfig } from "../data/chartConfig";
import type { QueryRowsResult } from "../contract";

// The line/bar type toggles inside the chart strip. The grid/chart glyphs that
// label the Data/Chart tabs are registered by QueryPanel, which owns the tabs.
Glyph.register(chart_line, chart_column);

// Horizontal gap (px) separating the x-axis pair from the y-axis pair in the
// chart config strip, so "x: [..]" and "y: [..]" read as two distinct groups.
const AXIS_GROUP_GAP = 12;

/**
 * The results grid for a rows result. A class-first composition wrapper: the
 * instance owns `content` (the grid) and `dispose` (a no-op — the MemoryStore
 * needs no teardown).
 */
export class QueryResultGrid {
    readonly content: Component;
    readonly dispose: () => void;

    /**
     * @param result - The rows result to render (read-only: a query result
     *     has no PK and is never written back).
     */
    constructor(result: QueryRowsResult) {
        // A fresh store + columns per run means columns never bleed across runs.
        const store = new MemoryStore({ model: buildQueryModel(result.columns), data: result.rows, autoLoad: true });
        const grid  = Table(store, { columns: [], rowReadOnly: () => true });

        this.content = grid;
        this.dispose = () => {};
    }
}

/**
 * The chart tab for a CHARTABLE rows result: a config strip (x/y column
 * combos over a line/bar type toggle) above the chart. A class-first
 * composition wrapper: the instance owns `content` (the strip-over-chart
 * subtree) and `dispose` (releasing the live chart instance). The caller must
 * guarantee `isChartable(result)`.
 */
export class QueryResultChart {
    readonly content: Component;
    readonly dispose: () => void;

    /** @param result - The chartable rows result to chart. */
    constructor(result: QueryRowsResult) {
        const { columns, rows } = result;

        let config: ChartConfig = defaultChartConfig(columns);

        const viewHost = Panel({ layoutManager: new Fit() });

        // Build the chart eagerly — the chart is the tab's only view (there is
        // no grid toggle here), so it is always the visible component.
        let chart: LineChart | BarChart = buildChart();

        viewHost.addComponent(chart);

        const content = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
        content.addComponent(buildStrip(), { placement: Placement.NORTH });
        content.addComponent(viewHost, { placement: Placement.CENTER });

        /** Build the config strip: x/y column combos and the line/bar type toggle. */
        function buildStrip(): ToolBar {
            const xCombo = new ComboBox({
                items: xCandidates(columns).map(c => ({ key: c.field, label: c.label })),
                value: config.xField,
                listeners: { change: value => { config = { ...config, xField: value }; rebuildChart(); } },
            });
            const yCombo = new ComboBox({
                items: numericColumns(columns).map(c => c.name),
                value: config.yField,
                listeners: { change: value => { config = { ...config, yField: value }; rebuildChart(); } },
            });

            const lineToggle = new ToggleButton("", { selected: config.kind === "line", glyph: "chart-line" });
            const barToggle  = new ToggleButton("", { selected: config.kind === "bar", glyph: "chart-column" });

            lineToggle.on("action", () => selectType("line"));
            barToggle.on("action", () => selectType("bar"));

            /** Flip the line/bar toggle pair and rebuild the chart. */
            function selectType(kind: ChartConfig["kind"]): void {
                lineToggle.setSelected(kind === "line");
                barToggle.setSelected(kind === "bar");
                config = { ...config, kind };
                rebuildChart();
            }

            const toolbar = new ToolBar({
                components: [
                    new Text("x:"), xCombo,
                    new Spacer(AXIS_GROUP_GAP), new Text("y:"), yCombo,
                    Spacer.flex(), // push the type selector to the far right
                    lineToggle, barToggle,
                ],
            });

            // ToolBar stretches its children to the full bar height, which disables
            // HBox baseline alignment; turn it off so the "x:"/"y:" labels sit on the
            // same text baseline as the combo boxes (the icon toggles stay centered).
            (toolbar.getLayoutManager() as HBox).setStretching(false);

            return toolbar;
        }

        /**
         * Rebuild the chart from the current config (a config change always needs
         * a fresh instance: line vs. bar are different classes) and swap it into
         * the view host. The chart is the tab's only view, so it is always visible.
         */
        function rebuildChart(): void {
            chart.dispose();
            chart = buildChart();
            viewHost.removeAllComponents();
            viewHost.addComponent(chart);
            viewHost.doLayout();
        }

        /** Build a fresh chart instance (line or bar, per `config`) from the result rows. */
        function buildChart(): LineChart | BarChart {
            const series = buildChartSeries(columns, rows, config);

            return config.kind === "line"
                ? new LineChart({ series, xScaleType: isTimeX(columns, config.xField) ? "time" : "linear" })
                : new BarChart({ series });
        }

        this.content = content;
        this.dispose = () => { chart.dispose(); };
    }
}
