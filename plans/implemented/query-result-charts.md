---
depends-on: ["codeeditor-sql-adoption"]
touches-shared: ["frontend/src/dock/QueryPanel.ts"]
---

# Query-result charts — Implementation Plan

## Overview

Add a **chart view** of a rows query result to the sqladmin QueryPanel, alongside the existing results grid. A rows result gains a small config strip (grid/chart toggle, x-field combo, y-field combo, bar/line toggle) and renders the same result data as a `BarChart` or `LineChart` from `@jimka/typescript-ui/component/chart`. Non-rows results (status/EXPLAIN), empty results, and results with no numeric column keep the current grid/plan behaviour untouched.

The work lands in **three files**: a new pure helper [frontend/src/data/chartConfig.ts](frontend/src/data/chartConfig.ts) (column classification, defaults, and row→`ChartSeries` mapping — fully unit-testable), a new live view [frontend/src/dock/QueryResultView.ts](frontend/src/dock/QueryResultView.ts) (the grid+chart+config component, `{ content, dispose }`), and edits to [frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts) to route a rows result through the new view and dispose its live chart.

**This plan assumes [`codeeditor-sql-adoption`](codeeditor-sql-adoption.md) has landed first.** That plan converts QueryPanel's editors to `CodeEditor`, makes the factory return `{ content: Container; dispose: () => void }`, and introduces controller-driven disposal via a `planView: CodeEditor | null` local plus a `disposePlanView()` helper called at the top of `showResultPane`/`hideResultPane` and from the panel's `dispose()`. **This plan generalizes that single-purpose plan-editor disposer into one live-result disposer** that also tears down the rows view's chart — see [Architecture Decisions](#generalize-disposeplanview-into-a-single-live-result-disposer). All QueryPanel line numbers below refer to the file's **current** state; where the codeeditor plan renames a seam, the target seam is named explicitly.

Verified library facts (against the shipped types in `frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/chart/`): `LineChart`/`BarChart` are callable Panels (`LineChart({…})` ≡ `new LineChart({…})`), default 400×300, fill their layout host; they take in-memory `series: ChartSeries[]` **or** a `store` + `xField`/`yField`/`seriesField`; both expose `setSeries`, `setStore`, `on("selection", fn)`, and `dispose()` (unbinds store + removes theme/interaction listeners). `ChartPoint` is `{ x: number; y: number }` — **both axes are numeric** (see the store-coercion finding below).

---

## Architecture Decisions

### Build in-memory `ChartSeries[]`, not store binding

The task suggested binding the chart to the same `MemoryStore` the results `Table` uses. **Rejected** for three verified reasons, all in `chart.es.js`'s `seriesFromStore`:

1. **Store binding coerces via `Number(record.get(field))`** for *both* x and y. A datetime column (`wireType: "isoString"`, e.g. `"2026-07-08T12:00:00Z"`) becomes `NaN`, so a **time-axis chart is impossible** through store binding. In-memory series lets us parse the ISO string to epoch millis ourselves for `xScaleType: "time"`.
2. **Store binding supports exactly one `yField`** (plus an optional `seriesField` that splits by a *record* value). It cannot map an *ordinal row index* to x, which is the only sensible x when the result has a single numeric column.
3. The result set is **static** — a re-run builds a fresh store + `Table` (QueryPanel.ts:395-403), never mutating in place — so the store's rebuild-on-`load` advantage buys nothing here.

So `buildChartSeries(columns, rows, config)` (pure, in `chartConfig.ts`) owns coercion and returns `ChartSeries[]`. The chart is fed via `series:` at construction; a config change rebuilds it.

### Both chart axes are numeric — pick x accordingly (numeric / datetime / row-index)

`ChartPoint.x` is typed `number`, and `BarChart.categories()` does `new Set(points.x)` → `.sort((a,b)=>a-b)` → `.map(String)`: even bar categories are numeric x values rendered through `String(...)`. A string/boolean/json column is **not** a usable x (it would coerce to `NaN`). Therefore:

- **y candidates** = columns with `wireType === "number"`.
- **x candidates** = numeric columns + datetime columns (`wireType === "isoString"`, plotted on a time axis) + a synthetic **"Row #"** ordinal (always available, so a single-numeric-column result is still chartable).

This **contradicts the task's suggested default** of "first non-numeric column as x" — that is wrong for this chart family (a non-numeric x yields `NaN`). The correct defaults are below.

### Default config, chart type, and x-scale

`defaultChartConfig(columns)` (pure):

- **xField**: first datetime column if any (natural time-series x); else the first numeric column when ≥2 numeric columns exist; else the synthetic Row-# ordinal.
- **yField**: first numeric column that isn't the chosen xField.
- **chartType**: `"line"` when xField is a datetime column (time series), else `"bar"`.
- **xScaleType** (LineChart only): `"time"` when xField is datetime, else `"linear"`.

A `BarChart` has no time scale; a datetime x on a bar chart renders epoch-millis categories (ugly but not broken), which is why datetime defaults to line.

### Extract the live view to `QueryResultView.ts`; QueryPanel is the integration seam

The rows-result view is a cohesive stateful component (a store-backed `Table`, a lazily-built chart, three config controls, and a grid/chart swap). Inlining ~120 lines into the already-dense `QueryPanel` factory would violate the global *decompose-large-functions* convention, so it lives in a new `frontend/src/dock/QueryResultView.ts` returning `{ content: Component; dispose: () => void }`. QueryPanel.ts remains the integration point (its `showResult` rows branch builds the view and registers its `dispose`), so the chart still renders in the results region below the editor as required. `touches-shared` lists QueryPanel.ts for the `/implement` ordering.

### Generalize `disposePlanView()` into a single live-result disposer

After `codeeditor-sql-adoption` lands, the result pane can host a live component needing teardown: the EXPLAIN plan `CodeEditor`. This plan adds a **second** such host — the rows view's chart. Rather than track two slots, **rename that plan's `planView: CodeEditor | null` / `disposePlanView()` to `liveResult: { dispose(): void } | null` / `disposeLiveResult()`**. Both a plan `CodeEditor` and a `QueryResultView` expose `dispose()`, so either registers into the single slot. `disposeLiveResult()` is called at the top of `showResultPane`/`hideResultPane` (as the codeeditor plan already established for `disposePlanView`) and from the panel's `dispose()` before `editor.dispose()`. This keeps disposal to one code path and prevents a chart leak when a rows result is replaced, cleared, or its tab is closed.

### d3 needs no new frontend dependency

Unlike `elkjs` (a lazy runtime `import()` the diagram plan had to add to `frontend/package.json`), the chart bundle `dist/lib/component/chart.es.js` has **d3 fully inlined at build time** — verified: it contains `scaleLinear` etc. and has zero bare `d3-*`/`internmap` imports (its only imports are relative typescript-ui chunks). So **do not** add `d3-scale`/`d3-shape`/`d3-array` to `frontend/package.json`; they are not resolved at the consumer boundary. The existing `esbuild: { keepNames: true }` in `vite.config.ts` (LIBRARY_NOTES) already covers the chart classes' `constructor.name` CSS-class derivation, exactly as it does for `CodeEditor`.

### Single y series; no selection drill-down

The config strip uses one `ComboBox` per axis. A `ComboBox` is single-select, so the chart plots **one y column** as a single series. Simultaneous multi-y series and the chart's `on("selection")` drill-down are Non-Goals (below) — they need a multi-select control / a click contract this feature doesn't define.

---

## Public API

No library API changes. One new app-internal factory and one new pure module:

```ts
// frontend/src/dock/QueryResultView.ts
export function QueryResultView(result: QueryRowsResult): { content: Component; dispose: () => void };
```

```ts
// frontend/src/data/chartConfig.ts
export type ChartKind = "bar" | "line";

/** Sentinel xField meaning "use the 0-based row ordinal as x". */
export const ROW_INDEX_FIELD = "__rowIndex__";

export interface ChartConfig {
    kind: ChartKind;
    xField: string;   // a column name, or ROW_INDEX_FIELD
    yField: string;   // a numeric column name
}

/** Columns valid as a y series (wireType === "number"). */
export function numericColumns(columns: QueryColumnMeta[]): QueryColumnMeta[];

/** x-axis candidates as { field, label }: numeric + datetime columns + the Row-# ordinal. */
export function xCandidates(columns: QueryColumnMeta[]): { field: string; label: string }[];

/** True when the result can be charted: ≥1 row and ≥1 numeric column. */
export function isChartable(result: QueryRowsResult): boolean;

/** Default config: datetime-or-numeric x, first other numeric y, line for time else bar. */
export function defaultChartConfig(columns: QueryColumnMeta[]): ChartConfig;

/** True when xField is a datetime column (⇒ LineChart xScaleType "time"). */
export function isTimeX(columns: QueryColumnMeta[], xField: string): boolean;

/** Map rows to a single ChartSeries per config, dropping points whose x or y is non-finite. */
export function buildChartSeries(
    columns: QueryColumnMeta[],
    rows: Record<string, unknown>[],
    config: ChartConfig,
): ChartSeries[];
```

Chart surface used (verified in `LineChart.d.ts` / `BarChart.d.ts` / `AbstractChart.d.ts`):

```ts
LineChart({ series, curved?, xScaleType?: "linear" | "time", showLegend? }): LineChart
BarChart({ series, showLegend? }): BarChart
// inherited: dispose(): void
```

---

## Internal Structure

### `chartConfig.ts` coercion (the load-bearing detail)

`buildChartSeries` resolves one x-extractor and one y-extractor, then maps rows to points, dropping any point whose x or y is not finite:

```ts
const xCol = columns.find(c => c.name === config.xField);   // undefined ⇒ ROW_INDEX_FIELD
const toX = (row, i) =>
    config.xField === ROW_INDEX_FIELD ? i
    : xCol?.wireType === "isoString"  ? Date.parse(String(row[config.xField]))  // epoch ms for time axis
    :                                    Number(row[config.xField]);
const toY = row => Number(row[config.yField]);

const data = rows
    .map((row, i) => ({ x: toX(row, i), y: toY(row) }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));

return [{ name: config.yField, data }];
```

`WireType` and `QueryColumnMeta` come from `../contract`; `ChartSeries` from `@jimka/typescript-ui/component/chart`. No magic numbers.

### `QueryResultView.ts` shape

Border layout: NORTH = a flat `ToolBar` config strip, CENTER = a `Panel({ layoutManager: new Fit() })` `viewHost` that swaps between the `Table` and the chart.

- `table`: the store-backed read-only `Table`, built once (moved verbatim from QueryPanel's current rows branch — `MemoryStore` + `buildQueryModel` + `Table(store, { columns: [], rowReadOnly: () => true })`).
- `chart: LineChart | BarChart | null`: built lazily on first switch to chart view; rebuilt on any config change.
- Config strip controls (built only when `isChartable(result)`; otherwise the view is just the `Table` and `dispose` is a no-op):
  - View toggle: two `ToggleButton`s — grid (`table` glyph) and chart (`chart-simple` glyph) — mutually exclusive via a manual two-line loop (mirrors `shell/ActivityBar.ts`; `ToggleButton` has no built-in radio).
  - x `ComboBox`: `items` = `xCandidates(columns)` mapped to `{ key: field, label }`, `value` = default xField.
  - y `ComboBox`: `items` = `numericColumns(columns).map(c => c.name)` (plain strings — round-trip the name, see LIBRARY_NOTES ComboBox note), `value` = default yField.
  - Chart-type toggle: two `ToggleButton`s — line (`chart-line`) and bar (`chart-column`), manual radio, seeded from `defaultChartConfig`.
- The x/y combos and the type toggle are **disabled in grid view**, enabled in chart view.
- `rebuildChart()`: `chart?.dispose(); chart = <Line|Bar>Chart({ series: buildChartSeries(...), ... }); viewHost` swaps to it, `viewHost.doLayout()`. LineChart passes `xScaleType: isTimeX(columns, xField) ? "time" : "linear"`.
- `dispose()`: `chart?.dispose()` (the `Table`/store are GC'd with the subtree).

---

## Ordered Implementation Steps

### 1 — `frontend/src/data/chartConfig.ts` (new, pure)

1. Create the module implementing the [Public API](#public-api) above. Import `ChartSeries` type from `@jimka/typescript-ui/component/chart` and `QueryColumnMeta` / `QueryRowsResult` from `../contract`. Follow the `buildModel.ts` doc/style idiom (aligned imports, full JSDoc, explicit return types).
2. `numericColumns` = `columns.filter(c => c.wireType === "number")`.
3. `xCandidates` = numeric columns (`{ field: c.name, label: c.name }`) + datetime columns (`wireType === "isoString"`, same shape) + `{ field: ROW_INDEX_FIELD, label: "Row #" }` appended last.
4. `isChartable(result)` = `result.rows.length > 0 && numericColumns(result.columns).length > 0`.
5. `defaultChartConfig` and `isTimeX` per [Default config](#default-config-chart-type-and-x-scale).
6. `buildChartSeries` per [Internal Structure](#chartconfigts-coercion-the-load-bearing-detail).

### 2 — `frontend/src/data/chartConfig.test.ts` (new)

7. Cover the pure API (Vitest, mirroring `buildModel.test.ts`): see [Expected Behaviour](#expected-behaviour) cases 1-6.

### 3 — `frontend/src/dock/QueryResultView.ts` (new, live)

8. Create the factory per [`QueryResultView.ts` shape](#queryresultviewts-shape). Imports: `Component`, `Container` from `@jimka/typescript-ui/core`; `Border as BorderLayout`, `Fit` from `@jimka/typescript-ui/layout`; `Placement` from `@jimka/typescript-ui/primitive`; `ToolBar` from `@jimka/typescript-ui/component/menubar`; `Text`, `ComboBox` from `@jimka/typescript-ui/component/input`; `ToggleButton` from `@jimka/typescript-ui/component/button`; `Table` from `@jimka/typescript-ui/component/table`; `MemoryStore` from `@jimka/typescript-ui/data`; `Glyph` from `@jimka/typescript-ui/component/display`; `LineChart`, `BarChart` from `@jimka/typescript-ui/component/chart`; the four glyph modules `table`, `chart_simple`, `chart_line`, `chart_column` from `@jimka/typescript-ui/glyphs/solid/<name>`; `buildQueryModel` from `../data/buildModel`; the `chartConfig` API; `QueryColumnMeta`/`QueryRowsResult` from `../contract`; theme colors as needed.
9. `Glyph.register(table, chart_simple, chart_line, chart_column);` at module scope (mirrors QueryPanel.ts:53).
10. **Not-chartable branch**: if `!isChartable(result)`, build only the `Table` and return `{ content: table, dispose: () => {} }` — identical to today's grid.
11. **Chartable branch**: build the `Table`, the `viewHost` Fit panel (start showing the `Table`), the config strip ToolBar, and the Border container. Wire the toggles/combos to update a `config: ChartConfig` local and call `rebuildChart()`; wire the grid/chart view toggle to swap `viewHost` and enable/disable the chart controls. Return `{ content, dispose }`.
12. Keep the factory body decomposed (`buildStrip`, `showGrid`, `showChart`, `rebuildChart`) per the decompose convention.

### 4 — `frontend/src/dock/QueryPanel.ts` (modify — post-codeeditor state)

13. **Import** the new view: `import { QueryResultView } from "./QueryResultView";`. The inline `MemoryStore`/`buildQueryModel`/`Table` rows rendering moves into `QueryResultView`; **remove** the now-unused `Table`, `MemoryStore`, and `buildQueryModel` imports from QueryPanel **iff** no other QueryPanel code uses them (grep to confirm — the plan view uses `CodeEditor`, so after the move these three are rows-only).
14. **Generalize the disposer** the codeeditor plan introduced: rename `planView` → `liveResult` (typed `{ dispose(): void } | null`) and `disposePlanView()` → `disposeLiveResult()`. Update its two call sites (top of `showResultPane` and `hideResultPane`) and the panel `dispose()` (`disposeLiveResult(); editor.dispose();`). In `showPlan`, set `liveResult = view` where it currently sets `planView = view` (a plan `CodeEditor` satisfies `{ dispose(): void }`).
15. **Rows branch of `showResult`** (currently QueryPanel.ts:390-409): replace the inline store/Table construction + `showResultPane(Table(...))` with:
    ```ts
    const view = QueryResultView(result);

    showResultPane(view.content);
    liveResult = view;                       // set AFTER showResultPane (which disposeLiveResult()s the prior)
    setActiveExport({ kind: "rows", result });
    notify(result.truncated
        ? `showing first ${result.rowCount} rows — result truncated`
        : `${result.rowCount} row(s)`);

    return;
    ```
    The `notify`, `setActiveExport`, and non-rows (status) tail of `showResult` are unchanged.

### Checkpoints

- `grep -n 'planView\|disposePlanView' src/dock/QueryPanel.ts` → zero (fully renamed).
- `grep -n 'MemoryStore\|buildQueryModel' src/dock/QueryPanel.ts` → zero (moved to QueryResultView).
- `grep -rn "d3-" frontend/package.json` → zero (no new d3 dep).
- `npx tsc --noEmit` in `frontend/` → clean.
- `npm test` in `frontend/` → green (existing suite unchanged; new `chartConfig.test.ts` passes).

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `frontend/src/data/chartConfig.ts` |
| Create | `frontend/src/data/chartConfig.test.ts` |
| Create | `frontend/src/dock/QueryResultView.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |

---

## Expected Behaviour

Cases 1-6 are **unit-testable** (pure `chartConfig`); 7-13 are **manual-verify** (charts render via the framework DOM sink, which is a no-op under the offline test seam — same live-only constraint as `CodeEditor`).

1. **`numericColumns`** returns only `wireType === "number"` columns, in order.
2. **`xCandidates`** = numeric + isoString columns (as `{field:name,label:name}`) then a trailing `{field: ROW_INDEX_FIELD, label: "Row #"}`; excludes string/boolean/json/base64/jsonArray columns.
3. **`isChartable`** — false for zero rows; false when no numeric column; true otherwise.
4. **`defaultChartConfig`** — with a datetime col ⇒ x = that datetime, kind = "line"; with ≥2 numeric and no datetime ⇒ x = first numeric, y = second numeric, kind = "bar"; with exactly one numeric and no datetime ⇒ x = ROW_INDEX_FIELD, y = that numeric, kind = "bar".
5. **`buildChartSeries`** — numeric x ⇒ `Number()` points; datetime x ⇒ x is `Date.parse` epoch ms; ROW_INDEX_FIELD ⇒ x is the 0-based row ordinal; y is `Number(row[yField])`; one series named `yField`.
6. **`buildChartSeries` drops junk** — rows where x or y is `null`/`undefined`/non-numeric string (⇒ `NaN`) or an unparseable date are omitted; an all-junk column yields an empty `data` array.
7. **Grid stays default** — running a SELECT shows the results grid first, exactly as today; the config strip appears above it only for a chartable result.
8. **Toggle to chart** — clicking the chart view button swaps the grid for a chart drawn from the default config; toggling back restores the grid; the x/y/type controls are disabled in grid view, enabled in chart view.
9. **x/y/type controls** — changing the x combo, y combo, or bar/line toggle rebuilds the chart from the same result rows (no re-query); a datetime x on a line chart uses a time axis.
10. **Non-chartable result** — a result with no numeric column (all text) shows only the grid with **no** config strip; a status/DDL result and an EXPLAIN plan are unchanged (no strip, no chart).
11. **Empty result** — a rows result with zero rows shows the empty grid only (no strip; `isChartable` false).
12. **Truncated result** — the chart plots the same first-N rows the grid shows; the status line still reports "showing first N rows — result truncated" (no separate chart caveat).
13. **No leak on teardown** — replacing a rows result with another result, clearing, or closing the tab disposes the current chart (via `disposeLiveResult` / the view's `dispose`); a re-run does not accumulate `EditorView`/chart SVG state across ~10 open→replace cycles (heap snapshot).

---

## Verification

- `npx tsc --noEmit` in `frontend/` — clean (the new factory return type must satisfy `showResultPane` and the `liveResult` slot at its QueryPanel call site).
- `npm test` in `frontend/` — existing suite green; `chartConfig.test.ts` covers Expected Behaviour 1-6.
- The grep checkpoints above.
- Manual smoke test per Expected Behaviour 7-13 in the live app (`npm run dev`, open a connection, run a SELECT with a numeric column). Screen: a New Query dock tab's result area.
- Optional: `npm run build && npm run preview` — confirms the chart renders under the production minifier (the existing `esbuild.keepNames` covers the chart classes' `constructor.name`, per LIBRARY_NOTES).

---

## Potential Challenges

- **String/boolean x looks tempting but is `NaN`.** Only numeric + datetime columns (and the Row-# ordinal) are x candidates; do not offer string columns as x — the chart family has no categorical string axis (bar categories are numeric). Enforced by `xCandidates`.
- **Forgetting to dispose the chart.** The chart is a live component holding a theme listener; it must register into `liveResult` and be disposed on every result swap and on teardown — the whole reason for generalizing `disposePlanView` → `disposeLiveResult`. Missing it leaks one chart per re-run.
- **Rebuild vs. mutate.** On a config change, dispose-and-recreate the chart (line vs bar are different classes; type change needs a new instance anyway). Recreate-always is simpler and correct provided the old chart is disposed first.
- **Live-only means no automated chart coverage.** Do not assert rendered SVG in offline tests — the sink is a no-op there. Only `chartConfig` is unit-tested; the view is manual-verify, matching the codeeditor plan's stance.
- **Coordinate the disposer rename with the sibling plan.** If `codeeditor-sql-adoption` is still using `planView`/`disposePlanView` when this lands, rename in place (step 14); do not add a parallel second slot.

---

## Critical Files

- [frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts) — integration seam; `showResult` rows branch (currently L390-409), the `disposePlanView`/`planView` disposer introduced by the codeeditor plan, `showResultPane`/`hideResultPane`, and the factory `dispose()`.
- [frontend/src/data/buildModel.ts](frontend/src/data/buildModel.ts) — `buildQueryModel`; the model the results store/Table (now the view) uses; the doc/style idiom to mirror in `chartConfig.ts`.
- [frontend/src/contract.ts](frontend/src/contract.ts) — `QueryRowsResult`, `QueryColumnMeta`, `WireType` (`"number"` = y; `"isoString"` = datetime x).
- [frontend/src/dock/glyphButton.ts](frontend/src/dock/glyphButton.ts) / [frontend/src/dock/FilterDialog.ts](frontend/src/dock/FilterDialog.ts) — the toolbar-button and `ComboBox` idioms to mirror (plain-string combo items round-trip the name).
- [frontend/src/shell/ActivityBar.ts](frontend/src/shell/ActivityBar.ts) — the manual mutual-exclusion `ToggleButton` radio loop the view/type toggles mirror.
- `frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/chart/{LineChart,BarChart,AbstractChart,types}.d.ts` — the exact chart option/method surface.
- `/home/jika/typescript/typescript-ui/docs/components/{LineChart,BarChart}.md` — chart behaviour reference.
- [plans/codeeditor-sql-adoption.md](codeeditor-sql-adoption.md) — the prerequisite plan; its disposal pattern this one extends.

---

## Non-Goals

- **Store-bound charts** — rejected for coercion/single-y/static-data reasons above; in-memory series is the chosen path.
- **Multiple simultaneous y series** — the y `ComboBox` is single-select; multi-series needs a multi-select control. One series per chart.
- **Chart point/bar selection drill-down** (`on("selection")`) — no interaction contract is defined for a read-only result view.
- **Adding d3 to `frontend/package.json`** — d3 is inlined in `chart.es.js`; no consumer-boundary dependency exists.
- **New chart types** (pie/area/scatter) — only bar and line, per the task.
- **Re-planning the CodeEditor swap** — owned by `codeeditor-sql-adoption`; this plan only extends its disposer.
- **Charting status/EXPLAIN results** — non-rows results have no tabular series; they keep their existing rendering.
