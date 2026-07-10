// Classify a query result's columns for the chart config strip and map its rows
// to chart series. Both chart axes are numeric (see chart.es.js's
// seriesFromStore / ChartPoint), so a usable x is a numeric column, a datetime
// column (plotted on a time axis), or the synthetic Row-# ordinal — never a
// string/boolean/json column, which would coerce to NaN. Pure and
// fully unit-testable; consumed by QueryPanel (isChartable, to decide whether to
// add a Chart tab) and QueryResultChart (the rest, to build the chart).

import type { ChartSeries }                     from "@jimka/typescript-ui/component/chart";
import type { QueryColumnMeta, QueryRowsResult } from "../contract";

export type ChartKind = "bar" | "line";

/** Sentinel xField meaning "use the 0-based row ordinal as x". */
export const ROW_INDEX_FIELD = "__rowIndex__";

/** The chart's current axis/type selection, driven by the config strip. */
export interface ChartConfig {
    kind: ChartKind;
    xField: string; // a column name, or ROW_INDEX_FIELD
    yField: string; // a numeric column name
}

/** Columns valid as a y series: only `wireType === "number"` coerces cleanly. */
export function numericColumns(columns: QueryColumnMeta[]): QueryColumnMeta[] {
    return columns.filter(c => c.wireType === "number");
}

/**
 * x-axis candidates: numeric columns, then datetime columns (plotted on a time
 * axis), then the synthetic Row-# ordinal — always last, always present, so a
 * single-numeric-column result is still chartable. Excludes string/boolean/
 * json/base64/jsonArray columns, which coerce to NaN on this chart family.
 */
export function xCandidates(columns: QueryColumnMeta[]): { field: string; label: string }[] {
    const numeric  = numericColumns(columns).map(c => ({ field: c.name, label: c.name }));
    const datetime = columns.filter(c => c.wireType === "isoString").map(c => ({ field: c.name, label: c.name }));

    return [...numeric, ...datetime, { field: ROW_INDEX_FIELD, label: "Row #" }];
}

/** True when the result can be charted: at least one row and one numeric column. */
export function isChartable(result: QueryRowsResult): boolean {
    return result.rows.length > 0 && numericColumns(result.columns).length > 0;
}

/**
 * Default config: a datetime column (if any) becomes x on a line chart (the
 * natural time-series read); otherwise the first numeric column is x (when a
 * second numeric column exists to be y) or the Row-# ordinal (when there is
 * only one numeric column), on a bar chart.
 */
export function defaultChartConfig(columns: QueryColumnMeta[]): ChartConfig {
    const numeric  = numericColumns(columns);
    const datetime = columns.find(c => c.wireType === "isoString");

    if (datetime) {
        return { kind: "line", xField: datetime.name, yField: numeric[0].name };
    }

    if (numeric.length >= 2) {
        return { kind: "bar", xField: numeric[0].name, yField: numeric[1].name };
    }

    return { kind: "bar", xField: ROW_INDEX_FIELD, yField: numeric[0].name };
}

/** True when xField names a datetime column (⇒ LineChart xScaleType "time"). */
export function isTimeX(columns: QueryColumnMeta[], xField: string): boolean {
    return columns.some(c => c.name === xField && c.wireType === "isoString");
}

/**
 * Map rows to a single {@link ChartSeries} per config, dropping any point whose
 * x or y is not finite (a null/undefined/non-numeric value, or an unparseable
 * date). Only bar/line's Row-#-or-numeric-or-datetime x candidates ever reach
 * here (see {@link xCandidates}), so the coercion below is total.
 */
export function buildChartSeries(
    columns: QueryColumnMeta[],
    rows: Record<string, unknown>[],
    config: ChartConfig,
): ChartSeries[] {
    const xCol = columns.find(c => c.name === config.xField);

    // A SQL NULL surfaces as JS null/undefined; Number(null) is 0 (not NaN), which
    // would silently plot a missing value as zero, so treat both as missing (NaN)
    // before the general numeric/date coercion below.
    const toFinite = (value: unknown): number => (value === null || value === undefined ? NaN : Number(value));

    const toX = (row: Record<string, unknown>, index: number): number => {
        if (config.xField === ROW_INDEX_FIELD) {
            return index;
        }

        return xCol?.wireType === "isoString" ? Date.parse(String(row[config.xField])) : toFinite(row[config.xField]);
    };
    const toY = (row: Record<string, unknown>): number => toFinite(row[config.yField]);

    const data = rows
        .map((row, index) => ({ x: toX(row, index), y: toY(row) }))
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));

    return [{ name: config.yField, data }];
}
