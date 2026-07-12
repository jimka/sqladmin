import { describe, it, expect } from "vitest";
import {
    numericColumns, xCandidates, isChartable, defaultChartConfig, isTimeX, buildChartSeries,
    ROW_INDEX_FIELD,
} from "../../src/data/chartConfig";
import type { QueryColumnMeta, QueryRowsResult } from "../../src/contract";

const NUMERIC_COL: QueryColumnMeta  = { name: "amount", wireType: "number" };
const NUMERIC_COL2: QueryColumnMeta = { name: "quantity", wireType: "number" };
const STRING_COL: QueryColumnMeta   = { name: "label", wireType: "string" };
const BOOL_COL: QueryColumnMeta     = { name: "active", wireType: "boolean" };
const DATE_COL: QueryColumnMeta     = { name: "createdAt", wireType: "isoString" };
const JSON_COL: QueryColumnMeta     = { name: "meta", wireType: "json" };
const BASE64_COL: QueryColumnMeta   = { name: "blob", wireType: "base64" };
const JSON_ARRAY_COL: QueryColumnMeta = { name: "tags", wireType: "jsonArray" };

describe("numericColumns", () => {
    it("returns only wireType === \"number\" columns, in order", () => {
        const columns = [STRING_COL, NUMERIC_COL, DATE_COL, NUMERIC_COL2];

        expect(numericColumns(columns)).toEqual([NUMERIC_COL, NUMERIC_COL2]);
    });
});

describe("xCandidates", () => {
    it("is numeric + isoString columns then a trailing Row # ordinal, excluding other wire types", () => {
        const columns = [
            STRING_COL, NUMERIC_COL, BOOL_COL, DATE_COL, JSON_COL, BASE64_COL, JSON_ARRAY_COL, NUMERIC_COL2,
        ];

        expect(xCandidates(columns)).toEqual([
            { field: "amount",    label: "amount" },
            { field: "quantity",  label: "quantity" },
            { field: "createdAt", label: "createdAt" },
            { field: ROW_INDEX_FIELD, label: "Row #" },
        ]);
    });

    it("still appends the Row # ordinal when there are no numeric/datetime columns", () => {
        expect(xCandidates([STRING_COL, BOOL_COL])).toEqual([{ field: ROW_INDEX_FIELD, label: "Row #" }]);
    });
});

describe("isChartable", () => {
    const rowsResult = (columns: QueryColumnMeta[], rows: Record<string, unknown>[]): QueryRowsResult => (
        { kind: "rows", columns, rows, rowCount: rows.length, truncated: false }
    );

    it("is false for zero rows", () => {
        expect(isChartable(rowsResult([NUMERIC_COL], []))).toBe(false);
    });

    it("is false when there is no numeric column", () => {
        expect(isChartable(rowsResult([STRING_COL], [{ label: "a" }]))).toBe(false);
    });

    it("is true when there is at least one row and one numeric column", () => {
        expect(isChartable(rowsResult([NUMERIC_COL], [{ amount: 1 }]))).toBe(true);
    });
});

describe("defaultChartConfig", () => {
    it("picks the datetime column as x and \"line\" when a datetime column exists", () => {
        const columns = [NUMERIC_COL, DATE_COL, NUMERIC_COL2];

        expect(defaultChartConfig(columns)).toEqual({ kind: "line", xField: "createdAt", yField: "amount" });
    });

    it("picks the first numeric as x, second numeric as y, and \"bar\" with >=2 numeric and no datetime", () => {
        const columns = [NUMERIC_COL, NUMERIC_COL2, STRING_COL];

        expect(defaultChartConfig(columns)).toEqual({ kind: "bar", xField: "amount", yField: "quantity" });
    });

    it("falls back to the Row # ordinal as x and \"bar\" with exactly one numeric and no datetime", () => {
        const columns = [STRING_COL, NUMERIC_COL];

        expect(defaultChartConfig(columns)).toEqual({ kind: "bar", xField: ROW_INDEX_FIELD, yField: "amount" });
    });
});

describe("isTimeX", () => {
    const columns = [NUMERIC_COL, DATE_COL];

    it("is true when xField names a datetime column", () => {
        expect(isTimeX(columns, "createdAt")).toBe(true);
    });

    it("is false for a numeric xField or the Row # ordinal", () => {
        expect(isTimeX(columns, "amount")).toBe(false);
        expect(isTimeX(columns, ROW_INDEX_FIELD)).toBe(false);
    });
});

describe("buildChartSeries", () => {
    it("maps a numeric x/y to one series named after yField", () => {
        const columns = [NUMERIC_COL, NUMERIC_COL2];
        const rows = [{ amount: 1, quantity: 10 }, { amount: 2, quantity: 20 }];

        expect(buildChartSeries(columns, rows, { kind: "bar", xField: "amount", yField: "quantity" })).toEqual([
            { name: "quantity", data: [{ x: 1, y: 10 }, { x: 2, y: 20 }] },
        ]);
    });

    it("parses a datetime xField to epoch milliseconds via Date.parse", () => {
        const columns = [DATE_COL, NUMERIC_COL];
        const rows = [{ createdAt: "2026-07-08T12:00:00Z", amount: 5 }];
        const expectedX = Date.parse("2026-07-08T12:00:00Z");

        expect(buildChartSeries(columns, rows, { kind: "line", xField: "createdAt", yField: "amount" })).toEqual([
            { name: "amount", data: [{ x: expectedX, y: 5 }] },
        ]);
    });

    it("uses the 0-based row ordinal as x for ROW_INDEX_FIELD", () => {
        const columns = [NUMERIC_COL];
        const rows = [{ amount: 7 }, { amount: 8 }, { amount: 9 }];

        expect(buildChartSeries(columns, rows, { kind: "bar", xField: ROW_INDEX_FIELD, yField: "amount" })).toEqual([
            { name: "amount", data: [{ x: 0, y: 7 }, { x: 1, y: 8 }, { x: 2, y: 9 }] },
        ]);
    });

    it("drops rows whose x or y is non-finite (null/undefined/non-numeric string/unparseable date)", () => {
        const columns = [NUMERIC_COL, NUMERIC_COL2];
        const rows = [
            { amount: 1, quantity: 10 },
            { amount: null, quantity: 20 },
            { amount: 3, quantity: undefined },
            { amount: "not-a-number", quantity: 40 },
        ];

        expect(buildChartSeries(columns, rows, { kind: "bar", xField: "amount", yField: "quantity" })).toEqual([
            { name: "quantity", data: [{ x: 1, y: 10 }] },
        ]);
    });

    it("yields an empty data array when every row is junk", () => {
        const columns = [DATE_COL, NUMERIC_COL];
        const rows = [{ createdAt: "not-a-date", amount: 1 }, { createdAt: null, amount: 2 }];

        expect(buildChartSeries(columns, rows, { kind: "line", xField: "createdAt", yField: "amount" })).toEqual([
            { name: "amount", data: [] },
        ]);
    });
});
