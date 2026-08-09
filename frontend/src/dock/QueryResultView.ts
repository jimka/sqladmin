// Render a rows query result as two independent tab bodies, hosted by
// QueryPanel's result TabPanel:
//
//   * QueryResultGrid — the read-only results grid. Built for every rows
//     result. Needs no disposal of its own: the grid is `content`, so the
//     Dock's teardown on tab close reaches it directly.
//   * QueryResultChart — a bar/line chart of the same rows over a config strip
//     (x/y column combos + a line/bar type toggle). Built only for a chartable
//     result (>=1 row, >=1 numeric column); the caller (QueryPanel) guards on
//     isChartable before calling. The live chart is a registered child of
//     `content`, so a tab close reaches it too; `rebuildChart` still disposes
//     the outgoing instance explicitly, since a config change swaps it for a
//     fresh one inside a live tab, which no teardown recursion runs for.
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
import { table_list }                            from "@jimka/typescript-ui/glyphs/solid/table_list";
import { angle_left }                            from "@jimka/typescript-ui/glyphs/solid/angle_left";
import { angle_right }                           from "@jimka/typescript-ui/glyphs/solid/angle_right";
import { buildQueryModel }                       from "../data/buildModel";
import {
    defaultChartConfig, xCandidates, numericColumns, isTimeX, buildChartSeries,
} from "../data/chartConfig";
import type { ChartConfig } from "../data/chartConfig";
import type { QueryRowsResult } from "../contract";
import { glyphButton, glyphToggleButton } from "./glyphButton";
import { stepIndex } from "./recordNavigation";
import { PRIMARY_COLOR } from "../theme";

// The line/bar type toggles inside the chart strip, plus the record-view toggle
// and its Previous/Next steppers on the Data tab. The grid/chart glyphs that
// label the Data/Chart tabs are registered by QueryPanel, which owns the tabs.
Glyph.register(chart_line, chart_column, table_list, angle_left, angle_right);

// Horizontal gap (px) separating the x-axis pair from the y-axis pair in the
// chart config strip, so "x: [..]" and "y: [..]" read as two distinct groups.
const AXIS_GROUP_GAP = 12;

/**
 * The results grid for a rows result: a toolbar (record-view toggle plus its
 * Previous/Next steppers) over the read-only grid. A class-first composition
 * wrapper: the instance owns `content` (the toolbar-over-grid subtree) alone —
 * the Dock destroys it, and the MemoryStore beneath it needs no teardown of
 * its own. `toggleRecordView`, `stepRecord`, and `syncStepEnabled` are plain
 * functions closing over the constructor's own locals, not arrow-function
 * fields — see COMPONENT_CONVENTIONS.md (f): a composition wrapper has no
 * `this` for an arrow field to bind.
 */
export class QueryResultGrid {
    readonly content: Component;

    /**
     * @param result - The rows result to render (read-only: a query result
     *     has no PK and is never written back).
     */
    constructor(result: QueryRowsResult) {
        // A fresh store + columns per run means columns never bleed across runs.
        const store = new MemoryStore({ model: buildQueryModel(result.columns), data: result.rows, autoLoad: true });
        // A result set's shape is unknown until it arrives, so its columns are
        // sized from the returned rows; a free-text column is capped by the
        // library at 400px.
        const grid  = Table(store, { columns: [], autoSizeColumns: true, rowReadOnly: () => true });

        const recordToggle = glyphToggleButton("table-list", PRIMARY_COLOR, "Record view (one record as field/value rows)", false);
        const prevButton   = glyphButton("angle-left",  PRIMARY_COLOR, "Previous record", () => stepRecord(-1));
        const nextButton   = glyphButton("angle-right", PRIMARY_COLOR, "Next record",     () => stepRecord(1));

        const toolbar = new ToolBar({ components: [recordToggle, prevButton, nextButton] });

        const content = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
        content.addComponent(toolbar, { placement: Placement.NORTH });
        content.addComponent(grid,    { placement: Placement.CENTER });

        recordToggle.on("action", toggleRecordView);
        grid.on("selection", syncStepEnabled);
        syncStepEnabled();

        /** Flip the grid's display mode and re-seed/re-sync the steppers. */
        function toggleRecordView(): void {
            const record = grid.getSelectedRecord();

            if (recordToggle.isSelected()) {
                grid.setDisplayMode("rotated");
            } else {
                grid.setDisplayMode("normal");
                // setDisplayMode re-selects the displayed record but does not reveal
                // it; selectRecord's normal-mode path scrolls the row back into view.
                grid.selectRecord(record);
            }

            syncStepEnabled();
        }

        /** Step the displayed record by `delta`, clamped to the loaded rows. */
        function stepRecord(delta: number): void {
            const records = store.getRecords();
            const current = grid.getSelectedRecord();
            const target  = stepIndex(current ? records.indexOf(current) : -1, delta, records.length);

            if (target !== null) {
                grid.selectRecord(records[target]);
            }
        }

        /** Enable Previous/Next only in record view, and only where a neighbour exists. */
        function syncStepEnabled(): void {
            const rotated = grid.getDisplayMode() === "rotated";
            const records = store.getRecords();
            const current = grid.getSelectedRecord();
            const index   = current ? records.indexOf(current) : -1;

            prevButton.setEnabled(rotated && stepIndex(index, -1, records.length) !== null);
            nextButton.setEnabled(rotated && stepIndex(index,  1, records.length) !== null);
        }

        this.content = content;
    }
}

/**
 * The chart tab for a CHARTABLE rows result: a config strip (x/y column
 * combos over a line/bar type toggle) above the chart. A class-first
 * composition wrapper: the instance owns `content` (the strip-over-chart
 * subtree) alone — the Dock destroys `content` and the live chart registered
 * beneath it on tab close. The caller must guarantee `isChartable(result)`.
 */
export class QueryResultChart {
    readonly content: Component;

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
    }
}
