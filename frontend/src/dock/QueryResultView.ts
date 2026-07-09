// Render a rows query result: a read-only results grid, plus — for a
// chartable result (>=1 row, >=1 numeric column) — a config strip toggling
// between the grid and a bar/line chart built from the same rows. A
// non-chartable result (no numeric column, or zero rows) renders just the
// grid, identical to today's behaviour, with no strip and a no-op dispose.
//
// The chart is built in-memory from `buildChartSeries` (see chartConfig.ts)
// rather than store-bound: a re-run always rebuilds this whole view (the
// result set is static), and store binding cannot express a datetime x-axis
// or an ordinal row-index x (see the plan's Architecture Decisions).

import { Component, Container, Panel }           from "@jimka/typescript-ui/core";
import { Placement }                             from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit }           from "@jimka/typescript-ui/layout";
import { ToolBar }                               from "@jimka/typescript-ui/component/menubar";
import { Text, ComboBox }                        from "@jimka/typescript-ui/component/input";
import { ToggleButton }                          from "@jimka/typescript-ui/component/button";
import { Table }                                 from "@jimka/typescript-ui/component/table";
import { MemoryStore }                           from "@jimka/typescript-ui/data";
import { Glyph }                                 from "@jimka/typescript-ui/component/display";
import { LineChart, BarChart }                   from "@jimka/typescript-ui/component/chart";
import { table }                                 from "@jimka/typescript-ui/glyphs/solid/table";
import { chart_simple }                          from "@jimka/typescript-ui/glyphs/solid/chart_simple";
import { chart_line }                            from "@jimka/typescript-ui/glyphs/solid/chart_line";
import { chart_column }                          from "@jimka/typescript-ui/glyphs/solid/chart_column";
import { buildQueryModel }                       from "../data/buildModel";
import {
    isChartable, defaultChartConfig, xCandidates, numericColumns, isTimeX, buildChartSeries,
} from "../data/chartConfig";
import type { ChartConfig } from "../data/chartConfig";
import type { QueryRowsResult } from "../contract";

Glyph.register(table, chart_simple, chart_line, chart_column);

/**
 * Build the rows-result view.
 *
 * @param result - The rows result to render (read-only: a query result has no
 *     PK and is never written back).
 * @returns The view content plus a disposer that releases the chart (if one
 *     was built). A no-op for a non-chartable result, which never builds one.
 */
export function QueryResultView(result: QueryRowsResult): { content: Component; dispose: () => void } {
    // A fresh store + columns per run means columns never bleed across runs.
    const store = new MemoryStore({ model: buildQueryModel(result.columns), data: result.rows, autoLoad: true });
    const grid  = Table(store, { columns: [], rowReadOnly: () => true });

    if (!isChartable(result)) {
        return { content: grid, dispose: () => {} };
    }

    const { columns, rows } = result;

    let config: ChartConfig = defaultChartConfig(columns);
    let chart: LineChart | BarChart | null = null;
    let showingChart = false;

    const viewHost = Panel({ layoutManager: new Fit() });

    viewHost.addComponent(grid);

    const strip = buildStrip();

    const content = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
    content.addComponent(strip.toolbar, { placement: Placement.NORTH });
    content.addComponent(viewHost, { placement: Placement.CENTER });

    /** Build the config strip: view toggle, x/y combos, and chart-type toggle. */
    function buildStrip(): {
        toolbar: ToolBar;
        setChartControlsEnabled: (enabled: boolean) => void;
    } {
        const gridToggle  = new ToggleButton("", { selected: true, glyph: "table" });
        const chartToggle = new ToggleButton("", { selected: false, glyph: "chart-simple" });

        gridToggle.on("action", () => selectView(false));
        chartToggle.on("action", () => selectView(true));

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

        const setChartControlsEnabled = (enabled: boolean): void => {
            xCombo.setEnabled(enabled);
            yCombo.setEnabled(enabled);
            lineToggle.setEnabled(enabled);
            barToggle.setEnabled(enabled);
        };

        setChartControlsEnabled(false);

        const toolbar = new ToolBar({
            components: [
                gridToggle, chartToggle,
                new Text("x:"), xCombo, new Text("y:"), yCombo,
                lineToggle, barToggle,
            ],
        });

        /** Flip the grid/chart toggle pair and swap the visible view. */
        function selectView(toChart: boolean): void {
            gridToggle.setSelected(!toChart);
            chartToggle.setSelected(toChart);
            setChartControlsEnabled(toChart);
            toChart ? showChart() : showGrid();
        }

        /** Flip the line/bar toggle pair and rebuild the (currently visible) chart. */
        function selectType(kind: ChartConfig["kind"]): void {
            lineToggle.setSelected(kind === "line");
            barToggle.setSelected(kind === "bar");
            config = { ...config, kind };
            rebuildChart();
        }

        return { toolbar, setChartControlsEnabled };
    }

    /** Swap the view host to the grid. The chart (if built) is left alive, not disposed. */
    function showGrid(): void {
        showingChart = false;
        viewHost.removeAllComponents();
        viewHost.addComponent(grid);
        viewHost.doLayout();
    }

    /** Swap the view host to the chart, building it lazily on first use. */
    function showChart(): void {
        showingChart = true;
        chart ??= buildChart();
        viewHost.removeAllComponents();
        viewHost.addComponent(chart);
        viewHost.doLayout();
    }

    /**
     * Rebuild the chart from the current config (a config change always needs a
     * fresh instance: line vs. bar are different classes). Swaps the view host
     * only when the chart is the currently visible view — the combos/toggles
     * that call this are disabled in grid view, so that is always the case in
     * practice, but the guard keeps this safe regardless.
     */
    function rebuildChart(): void {
        chart?.dispose();
        chart = buildChart();

        if (showingChart) {
            viewHost.removeAllComponents();
            viewHost.addComponent(chart);
            viewHost.doLayout();
        }
    }

    /** Build a fresh chart instance (line or bar, per `config`) from the result rows. */
    function buildChart(): LineChart | BarChart {
        const series = buildChartSeries(columns, rows, config);

        return config.kind === "line"
            ? new LineChart({ series, xScaleType: isTimeX(columns, config.xField) ? "time" : "linear" })
            : new BarChart({ series });
    }

    return {
        content,
        dispose: () => { chart?.dispose(); },
    };
}
