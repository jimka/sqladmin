# Result Pane Tabs — Implementation Plan

## Overview

Today the Run-SQL panel's south result pane is a single-slot `Fit` `Panel`
([QueryPanel.ts:144](frontend/src/dock/QueryPanel.ts#L144)) whose one child is
swapped between a rows `QueryResultView` and a read-only plan `CodeEditor`. Every
EXPLAIN / EXPLAIN ANALYZE run therefore *destroys* the data/chart view — the only
way back is to re-run the query.

This plan converts that pane into a real tabbed layout backed by the library's
[`TabPanel`](frontend/node_modules/@jimka/typescript-ui/src/typescript/lib/component/container/TabPanel.ts)
+ [`Tab`](frontend/node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts).
A rows result yields a **Data** tab (always) and, when chartable, a **Chart** tab;
an EXPLAIN run yields a single closeable **Explain** tab. The three tab families
persist independently: running a query refreshes Data/Chart and leaves Explain;
running explain refreshes/adds Explain and leaves Data/Chart. The old in-view
grid/chart toggle inside `QueryResultView`
([QueryResultView.ts:68-130](frontend/src/dock/QueryResultView.ts#L68)) is retired
— the grid and the chart become separate tabs.

The change is contained to two files: `QueryPanel.ts` (the pane orchestration) and
`QueryResultView.ts` (split into a grid builder and a chart builder). The pure
`chartConfig.ts` logic and its `chartConfig.test.ts` are untouched. The controller
seam is unchanged: `QueryPanel(...)` still returns `{ content, dispose }` and still
calls `onResult(active)`
([SqlAdminController.ts:624-646](frontend/src/SqlAdminController.ts#L624)).

---

## Architecture Decisions

### Data and Chart are separate tabs, not an in-view toggle

The **Data** tab hosts the results grid and is present for every rows result. The
**Chart** tab hosts the chart *plus* its x/y-combo + line/bar-toggle config strip,
present only for a chartable result (`isChartable` — ≥1 row, ≥1 numeric column).
Rationale: separate tabs let the user keep the grid while charting, and let the
`TabPanel` own the grid↔chart switch instead of the hand-rolled `viewHost` swap.
The retired grid/chart `ToggleButton` pair and `setChartControlsEnabled(false)`
initial-disable go away — chart controls are always enabled inside the Chart tab.

### A single closeable Explain tab, replaced in place

EXPLAIN and EXPLAIN ANALYZE produce the same artifact (a text plan); analyze only
adds real timings. So there is **one** Explain tab, not two. Each explain run
replaces its content: the old plan `CodeEditor` is disposed and a fresh one built.
The label stays `"Explain"`; the analyze-vs-plain distinction lives only in the
status-line/notify text. The tab is `closeable: true`; closing it disposes its
editor and (via the slot-based export recompute, and the `"empty"` event when it
was the last tab) updates export / hides the pane.

### Tabs persist independently; the pane appears with the first tab and vanishes with the last

Running a query refreshes Data/Chart and leaves Explain; running explain
refreshes/adds Explain and leaves Data/Chart; `clear()` wipes all tabs. The Split
pane (the `TabPanel` itself) is added to `body` and the editor is seeded to
`EDITOR_HEIGHT` when the **first** tab is added, and the pane is removed from
`body` when the **last** tab leaves — driven off the `Tab` `"empty"` event.

### Seed-once semantics: re-seed on every hidden→shown transition

The editor is re-seeded to `EDITOR_HEIGHT` **each time the pane transitions from
hidden to shown** (guarded by a `resultShown` boolean that flips to `false` on
hide). Within a shown session the pane instance stays in the Split, so tab churn
(refreshing Data/Chart, adding/replacing Explain) preserves the user's gutter
position. Rationale: this is exactly today's behaviour
([QueryPanel.ts:233-237,269-279](frontend/src/dock/QueryPanel.ts#L233)) — a
freshly re-shown pane has no meaningful prior size to restore, and `EDITOR_HEIGHT`
is the sensible default. Closing all tabs then re-running intentionally resets the
gutter to 150px.

### Export/onResult follows the active tab

Data or Chart active ⇒ `activeExport = { kind: "rows", result }`; Explain active ⇒
`activeExport = { kind: "plan", plan: { result, sql, runExplain } }`. This replaces
the swap-on-show export model. Two sync paths cover the two ways the active tab can
change:

- **User tab switch / programmatic select** — the `Tab` `"activate"` event fires
  with the now-active content; the handler reads its identity and sets export.
- **Silent post-close reselection** — when the user closes the active Explain tab,
  `Tab` re-selects a surviving sibling via `setActiveVisual`, which by design does
  **not** emit `"activate"` (see the `TabEvent` doc at
  [Tab.ts:37-38](frontend/node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts#L37)).
  The `onTabClose` handler therefore recomputes export **from the panel's own
  slots** (rows if any Data/Chart slot survives, else null) rather than reading
  `getActiveContent()`. This is also timing-safe: `Tab` emits `"tabclose"` *before*
  `selectNextContent` runs
  ([Tab.ts:1031-1035](frontend/node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts#L1031)),
  so `getActiveContent()` is momentarily stale inside `onTabClose`.

### Programmatic tab removal is distinguished from user close by a guard flag

The only user-closeable tab is Explain. Data/Chart are `closeable: false`, so the
user can never close them — they are only ever removed programmatically (on
refresh/clear). All programmatic removal uses `Tab.closeTab(content)` (the only
full-teardown API: it removes the bar cell, splices `_contents`, detaches the
child, and emits `"empty"` when drained). Because `closeTab` also emits
`"tabclose"`, a `suppressCloseHandler` boolean is raised around every programmatic
`closeTab` so the `onTabClose` user-close logic is skipped; the calling code
disposes the removed component's live view itself. This keeps disposal
single-owner and prevents double-dispose.

### Refresh adds the replacement tab(s) before removing the old ones

When a query re-run refreshes Data/Chart, the new tabs are added **before** the old
ones are closed, so the strip's content count never hits zero mid-refresh, the
`"empty"` event never fires, the `TabPanel` stays in the Split, and the gutter
position is preserved. (A status result, which adds nothing, does let the strip
empty when no Explain tab survives — correctly hiding the pane.)

---

## Public API

`QueryPanel`'s exported factory signature is **unchanged** —
`QueryPanel(options): { content: Container; dispose: () => void }` — so
`SqlAdminController` needs no edit.

`QueryResultView.ts` replaces its single export with two builders (same file):

```typescript
/** Build the results grid for a rows result. Dispose is a no-op (the grid's store needs no teardown). */
export function QueryResultGrid(result: QueryRowsResult): { content: Component; dispose: () => void };

/**
 * Build the chart tab for a CHARTABLE rows result: a BorderLayout of the config
 * strip (x/y ComboBoxes + line/bar ToggleButtons) over the chart. Caller must
 * guarantee isChartable(result). Dispose releases the current chart instance.
 */
export function QueryResultChart(result: QueryRowsResult): { content: Component; dispose: () => void };
```

The old `export function QueryResultView(...)` is removed.

---

## Internal Structure

### QueryPanel — pane state (replaces `liveResult`)

Replace the single `liveResult` disposable
([QueryPanel.ts:136-142](frontend/src/dock/QueryPanel.ts#L136)) with three named
slots plus the last-result stash needed to recompute export on tab activation:

```typescript
// Each slot holds a currently-mounted tab's content + its disposer. Null when the
// tab is absent. The three families are refreshed independently.
let dataSlot:    { content: Component; dispose(): void } | null = null;
let chartSlot:   { content: Component; dispose(): void } | null = null;
let explainSlot: { editor: CodeEditor } | null = null;

// Stashed so the "activate" handler can rebuild the ActiveExport for whichever
// tab the user switches to, without re-running the query/explain.
let lastRowsResult:    QueryRowsResult | null = null;
let lastExplainResult: QueryExplainResult | null = null;
let lastExplainSql:    string | null = null;

// Guard: raised around a programmatic closeTab so its "tabclose" emit is ignored
// by onTabClose (the caller disposes the removed view itself).
let suppressCloseHandler = false;
```

`resultShown: boolean` stays (drives the seed-once show/hide).

### QueryPanel — the pane component

Replace `const resultHost = Panel({ layoutManager: new Fit() });`
([QueryPanel.ts:144](frontend/src/dock/QueryPanel.ts#L144)) with a `TabPanel`, and
capture its `Tab` manager:

```typescript
const resultHost = TabPanel({});
const tab        = resultHost.getTab();
```

Import `TabPanel` from `@jimka/typescript-ui/component/container` (the same barrel
that already provides `Spacer`).

### QueryPanel — helper functions (replace showResultPane/hideResultPane/showResult/showPlan)

```typescript
/** Add the pane to the Split and seed the editor height on the first tab (once per hidden→shown). */
function ensureResultPaneShown(): void {
    if (!resultShown) {
        body.addComponent(resultHost);
        resultShown = true;
        seedEditorHeight();
    }

    body.doLayout();
    syncToolbarButtons();
}

/** Remove the pane so the editor fills the panel again. Wired to the Tab "empty" event. */
function hideResultPane(): void {
    if (resultShown) {
        body.removeComponent(resultHost);
        resultShown = false;
        body.doLayout();
    }

    syncToolbarButtons();
}

/** Remove a tab programmatically (no onTabClose side-effects); caller disposes the view. */
function removeTabSilently(content: Component): void {
    suppressCloseHandler = true;
    tab.closeTab(content);
    suppressCloseHandler = false;
}

/** Remove + dispose the Data and Chart tabs (if present). */
function removeDataChartTabs(): void {
    if (dataSlot) {
        removeTabSilently(dataSlot.content);
        dataSlot.dispose();
        dataSlot = null;
    }

    if (chartSlot) {
        removeTabSilently(chartSlot.content);
        chartSlot.dispose();
        chartSlot = null;
    }
}

/** Remove + dispose the Explain tab (if present). */
function removeExplainTab(): void {
    if (explainSlot) {
        removeTabSilently(explainSlot.editor);
        explainSlot.editor.dispose();
        explainSlot = null;
    }
}
```

`seedEditorHeight` ([QueryPanel.ts:250-266](frontend/src/dock/QueryPanel.ts#L250))
is unchanged — it still sizes `editor` and `resultHost` in the Split; `resultHost`
is now a `TabPanel`, which `setPaneSize` accepts identically (it is a `Component`).

### QueryPanel — rows result (replace the `kind === "rows"` branch of showResult)

```typescript
function showRowsResult(result: QueryRowsResult): void {
    const nextData  = QueryResultGrid(result);
    const nextChart = isChartable(result) ? QueryResultChart(result) : null;

    ensureResultPaneShown();

    // Add the replacements BEFORE removing the old tabs so the strip never empties
    // (keeps the pane in the Split and preserves the gutter position).
    resultHost.addTab(nextData.content, "Data", { glyph: "table" });

    if (nextChart) {
        resultHost.addTab(nextChart.content, "Chart", { glyph: "chart-simple" });
    }

    removeDataChartTabs();
    dataSlot  = nextData;
    chartSlot = nextChart;
    lastRowsResult = result;

    tab.setActiveContent(nextData.content);
    setActiveExport({ kind: "rows", result });
}
```

The status branch of `showResult`
([QueryPanel.ts:449-454](frontend/src/dock/QueryPanel.ts#L449)) becomes:

```typescript
// INSERT/UPDATE/DDL — no result set: drop Data/Chart, LEAVE any Explain tab.
removeDataChartTabs();
syncExportToActiveTab();
notify(result.kind === "status" ? result.command || "OK" : "OK");
```

`syncExportToActiveTab` here re-derives export from the surviving tabs: Explain
still present ⇒ plan export; nothing left ⇒ the `"empty"` event has hidden the pane
and export becomes null.

### QueryPanel — explain result (replace showPlan)

```typescript
function showPlan(result: QueryExplainResult, sql: string): void {
    const editor = new CodeEditor(result.plan, { language: "sql", readOnly: true });

    ensureResultPaneShown();

    // Add-before-remove: keeps the strip non-empty if Explain was the only tab.
    resultHost.addTab(editor, "Explain", { closeable: true, glyph: "diagram-project" });
    removeExplainTab();
    explainSlot       = { editor };
    lastExplainResult = result;
    lastExplainSql    = sql;

    tab.setActiveContent(editor);
    setActiveExport({ kind: "plan", plan: { result, sql, runExplain } });
    notify(result.analyze ? "EXPLAIN ANALYZE plan (side-effects rolled back)" : "EXPLAIN plan");
}
```

### QueryPanel — export sync

```typescript
/** Recompute export from whichever tab is active now (used by the activate event). */
function syncExportToActiveTab(): void {
    const active = tab.getActiveContent();

    if (explainSlot && active === explainSlot.editor) {
        setActiveExport({ kind: "plan", plan: { result: lastExplainResult!, sql: lastExplainSql!, runExplain } });
    } else if ((dataSlot && active === dataSlot.content) || (chartSlot && active === chartSlot.content)) {
        setActiveExport({ kind: "rows", result: lastRowsResult! });
    } else {
        setActiveExport(null);
    }
}
```

### QueryPanel — Tab event wiring (once, near the pane construction)

```typescript
// Export follows the active tab on user switches and programmatic selection.
tab.on("activate", (content: Component) => {
    if (explainSlot && content === explainSlot.editor) {
        setActiveExport({ kind: "plan", plan: { result: lastExplainResult!, sql: lastExplainSql!, runExplain } });
    } else {
        setActiveExport({ kind: "rows", result: lastRowsResult! });
    }
});

// User closed the (only closeable) Explain tab: dispose its editor and recompute
// export from the surviving slots — "activate" does NOT fire on the silent
// post-close reselection, and getActiveContent() is stale here.
tab.on("tabclose", (content: Component) => {
    if (suppressCloseHandler) {
        return;
    }

    if (explainSlot && content === explainSlot.editor) {
        explainSlot.editor.dispose();
        explainSlot = null;
    }

    if (dataSlot || chartSlot) {
        setActiveExport({ kind: "rows", result: lastRowsResult! });
    } else {
        setActiveExport(null);
    }
});

// Last tab gone (by user close or programmatic removal): drop the pane.
tab.on("empty", () => hideResultPane());
```

### QueryPanel — clear() and dispose()

`clear()` ([QueryPanel.ts:281-286](frontend/src/dock/QueryPanel.ts#L281)):

```typescript
function clear(): void {
    editor.setValue("");
    removeDataChartTabs();
    removeExplainTab(); // last removal empties the strip → "empty" → hideResultPane
    setActiveExport(null);
}
```

`dispose()` ([QueryPanel.ts:601-608](frontend/src/dock/QueryPanel.ts#L601)) —
dispose the live views directly (no tab churn on a dying panel):

```typescript
dispose: () => {
    dataSlot?.dispose();
    chartSlot?.dispose();
    explainSlot?.editor.dispose();
    editor.dispose();
},
```

### QueryResultView.ts — the two builders

`QueryResultGrid` is the current non-chartable path
([QueryResultView.ts:45-49](frontend/src/dock/QueryResultView.ts#L45)): build the
`MemoryStore` + `Table` grid, return `{ content: grid, dispose: () => {} }`.

`QueryResultChart` is the current chartable path with the grid/chart toggle
**removed**: build the config strip (x `ComboBox`, y `ComboBox`, line/bar
`ToggleButton`s — reuse [QueryResultView.ts:79-127](frontend/src/dock/QueryResultView.ts#L79)),
mount the chart eagerly in a `Fit` `viewHost` (no lazy grid↔chart swap), and rebuild
the chart on any config change (reuse `rebuildChart`/`buildChart`
[QueryResultView.ts:156-174](frontend/src/dock/QueryResultView.ts#L156)). Drop
`gridToggle`, `chartToggle`, `selectView`, `showGrid`, `showChart`, `showingChart`,
and the `setChartControlsEnabled(false)` initial-disable — the chart is always the
visible view in its own tab, so its controls are always enabled. Return
`{ content, dispose: () => chart?.dispose() }`.

---

## Ordered Implementation Steps

1. **`QueryResultView.ts` — split into two builders.**
   - Rename `QueryResultView` → `QueryResultGrid`; keep only the grid build
     (`store` + `grid`) and `return { content: grid, dispose: () => {} }`.
   - Add `QueryResultChart(result)`: copy the config-strip build but delete
     `gridToggle`, `chartToggle`, their `.on("action", ...)`, `selectView`,
     `showGrid`, `showChart`, and `showingChart`; the `ToolBar` `components` array
     becomes `[new Text("x:"), xCombo, new Text("y:"), yCombo, lineToggle,
     barToggle]`. Build the chart eagerly (`chart = buildChart()`) and add it to
     the `viewHost` before returning. `rebuildChart` always swaps (no
     `showingChart` guard). `return { content, dispose: () => chart?.dispose() }`.
   - Update the `Glyph.register` at [QueryResultView.ts:33](frontend/src/dock/QueryResultView.ts#L33)
     to drop `table` and `chart_simple` (the retired toggles) and their imports;
     keep `chart_line`, `chart_column`.
   - Rewrite the file header comment to describe the two builders (no toggle).
   - Checkpoint: `grep -n "gridToggle\|chartToggle\|showingChart\|QueryResultView"
     frontend/src/dock/QueryResultView.ts` — expect zero matches.

2. **`QueryPanel.ts` — imports & glyphs.**
   - Add `TabPanel` to the `@jimka/typescript-ui/component/container` import
     ([QueryPanel.ts:33](frontend/src/dock/QueryPanel.ts#L33)).
   - Replace `import { QueryResultView } from "./QueryResultView";`
     ([QueryPanel.ts:50](frontend/src/dock/QueryPanel.ts#L50)) with
     `import { QueryResultGrid, QueryResultChart } from "./QueryResultView";`.
   - Add `import { isChartable } from "../data/chartConfig";` and
     `import type { QueryRowsResult } from "../contract";` (QueryPanel now decides
     chartability and stashes the rows result). Import glyphs `table` and
     `chart_simple` and add them to the `Glyph.register(...)` call
     ([QueryPanel.ts:65](frontend/src/dock/QueryPanel.ts#L65)) — `Remove Fit` is
     **not** needed (the editor/split still use nothing from `Fit`; `Fit` was only
     used by `resultHost` — remove `Fit` from the layout import if unused after the
     `TabPanel` swap).
   - Checkpoint: re-grep confirms no `QueryResultView` import remains.

3. **`QueryPanel.ts` — pane state.** Replace `liveResult` + `disposeLiveResult`
   ([QueryPanel.ts:130-142](frontend/src/dock/QueryPanel.ts#L130)) with the three
   slots, the `lastRowsResult` / `lastExplainResult` / `lastExplainSql` stash, and
   `suppressCloseHandler`, per *Internal Structure*.

4. **`QueryPanel.ts` — pane component.** Replace `resultHost = Panel({ Fit })`
   ([QueryPanel.ts:144](frontend/src/dock/QueryPanel.ts#L144)) with
   `resultHost = TabPanel({})` and `const tab = resultHost.getTab();`.

5. **`QueryPanel.ts` — helpers.** Replace `showResultPane` / `hideResultPane`
   ([QueryPanel.ts:227-279](frontend/src/dock/QueryPanel.ts#L227)) with
   `ensureResultPaneShown`, `hideResultPane`, `removeTabSilently`,
   `removeDataChartTabs`, `removeExplainTab` per *Internal Structure*.
   `seedEditorHeight` is unchanged.

6. **`QueryPanel.ts` — showResult / showPlan.** Replace the `rows` branch of
   `showResult` ([QueryPanel.ts:429-447](frontend/src/dock/QueryPanel.ts#L429))
   with a call to `showRowsResult(result)`; update the status branch
   ([QueryPanel.ts:449-454](frontend/src/dock/QueryPanel.ts#L449)) to
   `removeDataChartTabs(); syncExportToActiveTab(); notify(...)`. Replace `showPlan`
   ([QueryPanel.ts:473-485](frontend/src/dock/QueryPanel.ts#L473)) per *Internal
   Structure*. Add `showRowsResult` and `syncExportToActiveTab`.

7. **`QueryPanel.ts` — Tab event wiring.** After `const tab = ...`, wire
   `tab.on("activate", ...)`, `tab.on("tabclose", ...)`, `tab.on("empty", ...)` per
   *Internal Structure*.

8. **`QueryPanel.ts` — clear / dispose.** Update `clear()`
   ([QueryPanel.ts:281-286](frontend/src/dock/QueryPanel.ts#L281)) and the returned
   `dispose` ([QueryPanel.ts:601-608](frontend/src/dock/QueryPanel.ts#L601)) per
   *Internal Structure*.

9. **`QueryPanel.ts` — header comment.** Rewrite the file-header doc
   ([QueryPanel.ts:1-27](frontend/src/dock/QueryPanel.ts#L1)) to describe the tabbed
   pane (Data / Chart / Explain), the independent-persistence rule, and the
   per-tab disposal the returned `dispose` performs.

10. **Typecheck & test.** `cd frontend && npm run typecheck && npm run test`.
    Checkpoint: `grep -rn "liveResult\|disposeLiveResult\|showResultPane"
    frontend/src/dock/QueryPanel.ts` — expect zero matches.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | frontend/src/dock/QueryPanel.ts |
| Modify | frontend/src/dock/QueryResultView.ts |

No files created or deleted. `chartConfig.ts` and `chartConfig.test.ts` untouched.
`SqlAdminController.ts` untouched (factory contract unchanged).

---

## Expected Behaviour

All cases below are DOM/event-coupled (tabs, CodeMirror, charts, Split geometry),
so they are **manual-verify** in the running app — the node vitest harness cannot
exercise `TabPanel`/`CodeEditor`/chart. The one purely-logical surface (column
classification / chart series) already lives in `chartConfig.ts` and stays covered
by `chartConfig.test.ts`; no new unit tests are added.

**Empty / initial state**
- Fresh query tab: editor fills the panel; no result pane; Export disabled.
  *(manual)*

**Run a rows query (chartable)**
- Data tab appears (grid) and Chart tab appears; Data is selected; pane seeded to
  ~150px editor; status shows row count; Export enabled → CSV/JSON. *(manual)*
- Switching to Chart tab: Export stays CSV/JSON (same rows result). *(manual)*

**Run a rows query (non-chartable — no numeric column or zero rows)**
- Only the Data tab appears (no Chart tab); Data selected; Export CSV/JSON.
  *(manual)*

**Run a status statement (INSERT/UPDATE/DDL)**
- Data/Chart tabs removed. If an Explain tab exists it survives and becomes the
  export source (text/JSON); if none, the pane disappears and Export disables.
  Status line shows the command tag. *(manual)*

**Run EXPLAIN, then EXPLAIN ANALYZE (with Data/Chart already shown)**
- First explain: an Explain tab appears (closeable), selected; Data/Chart remain.
  Export → text/JSON; status "EXPLAIN plan". *(manual)*
- Second (analyze): the SAME Explain tab's content is replaced (old plan editor
  disposed); label stays "Explain"; status "EXPLAIN ANALYZE plan (side-effects
  rolled back)". *(manual)*

**Independent persistence**
- With Data + Chart + Explain all present, re-running the query refreshes Data/Chart
  (new rows) and leaves Explain intact; the gutter position is preserved (pane
  never emptied). *(manual)*
- Re-running explain refreshes Explain and leaves Data/Chart intact. *(manual)*

**Close the Explain tab (user ✕)**
- Its editor is disposed; the surviving Data (or Chart) tab is auto-selected and
  Export switches back to CSV/JSON. If Explain was the only tab, the pane
  disappears and Export disables. *(manual)*

**EXPLAIN ANALYZE guard (unchanged)**
- Analyze on a non-read-only statement is blocked with the warning notify; no tab
  is created. *(manual — the classifier itself is covered by `explain.test.ts`.)*

**Clear**
- Editor emptied; all tabs removed and their views disposed; pane disappears;
  Export disabled. *(manual)*

**Auto-open paths**
- `autoExplain` ("plain"/"analyze") on open: creates and selects the Explain tab.
  *(manual)*
- `autoRun` on open: runs the query and selects the Data tab (Chart also added if
  chartable). *(manual)*

**Keyboard shortcuts (unchanged wiring)**
- Ctrl/Cmd+Enter → run → Data selected; Ctrl/Cmd+E → explain → Explain selected;
  Ctrl/Cmd+Shift+E → explain-analyze → Explain selected; Alt+C → clear. *(manual)*

**Disposal / no leaks**
- Closing the dock tab (controller `dispose`) disposes the grid store, chart, plan
  editor, and main editor with no double-dispose. *(manual — inspect via no console
  errors and, if desired, a heap check.)*

---

## Verification

1. `cd frontend && npm run typecheck` — clean.
2. `cd frontend && npm run test` — `chartConfig.test.ts`, `explain.test.ts`, and
   all existing suites still pass (no test files changed).
3. `cd frontend && npm run build` — `tsc --noEmit && vite build` succeeds.
4. Grep invariants (run from repo root):
   - `grep -rn "liveResult\|disposeLiveResult\|showResultPane" frontend/src/dock/QueryPanel.ts` → 0.
   - `grep -rn "QueryResultView\b" frontend/src/` → 0 (only the two new builders remain).
   - `grep -rn "gridToggle\|chartToggle\|showingChart" frontend/src/dock/` → 0.
5. Manual smoke in the running app (Run-SQL panel — open a query tab): walk the
   *Expected Behaviour* cases, focusing on (a) EXPLAIN no longer destroying the
   Data/Chart tabs, (b) closing the Explain tab restoring the rows export, and
   (c) the gutter position surviving a re-run.

---

## Potential Challenges

- **`onTabClose` timing.** `getActiveContent()` is stale inside `"tabclose"`
  (emitted before `selectNextContent`). Mitigation: the handler computes export
  from the panel's own slots, never from `getActiveContent()`.
- **Refresh emptying the strip.** Removing Data/Chart before adding replacements
  would fire `"empty"`, hide the pane, and lose the gutter. Mitigation: strict
  add-before-remove ordering in `showRowsResult` / `showPlan`.
- **Double-dispose.** `closeTab` emits `"tabclose"`, which could re-dispose a view
  the caller already disposed. Mitigation: `suppressCloseHandler` around every
  programmatic `closeTab`; `onTabClose` returns early while it is raised.
- **Glyph registration site moved.** The `table` / `chart-simple` glyphs now label
  tabs (created in `QueryPanel`), not toggles (removed from `QueryResultView`).
  Mitigation: move their `Glyph.register` from `QueryResultView.ts` to
  `QueryPanel.ts`; an unregistered glyph renders blank, caught in manual smoke.

---

## Critical Files

- [frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts) — the pane
  orchestration being rebuilt (state, helpers, showResult/showPlan, clear/dispose,
  event wiring).
- [frontend/src/dock/QueryResultView.ts](frontend/src/dock/QueryResultView.ts) —
  split into `QueryResultGrid` + `QueryResultChart`.
- [TabPanel.ts](frontend/node_modules/@jimka/typescript-ui/src/typescript/lib/component/container/TabPanel.ts)
  — `addTab(component, label, { closeable, glyph })`, `getTab()`.
- [Tab.ts](frontend/node_modules/@jimka/typescript-ui/src/typescript/lib/layout/Tab.ts)
  — `closeTab`, `setActiveContent`, `getActiveContent`, `indexOfContent`, and the
  `TabEvent` semantics (`"activate"` NOT firing on silent post-close reselection;
  `"tabclose"` emitted before reselection; `"empty"` on last-tab removal).
- [frontend/src/data/explain.ts](frontend/src/data/explain.ts) — `ActiveExport`,
  `PlanSource`, `RunExplain` (export shapes consumed unchanged).
- [frontend/src/data/chartConfig.ts](frontend/src/data/chartConfig.ts) —
  `isChartable` (now called from `QueryPanel`) and the pure chart logic (untouched).

---

## Non-Goals

- **Reordering / tearing off / docking result tabs.** `TabPanel` supports it, but
  it is out of scope; leave `reorderable` at its default (off) and do not wire
  detach handling here.
- **Persisting which tab was active across a dock-tab reopen.** No layout-restore
  work; a fresh panel starts empty as today.
- **A separate Explain Analyze tab.** Explicitly rejected — one Explain tab,
  replaced in place (see Architecture Decisions).
- **Refactoring `chartConfig.ts` or its tests.** The pure logic and coverage stay
  as-is; no behaviour change to column classification or series building.
- **Changing the controller/export plumbing.** `onResult` / `_activeQueryResult` /
  the menubar export path are unchanged.
