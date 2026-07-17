// A Dock work panel for arbitrary SQL: a multi-line editor over a tabbed result
// pane. The editor runs on the Run toolbar button or Ctrl/Cmd+Enter. Until a
// query is executed, the editor fills the panel and no result pane is shown. A
// result adds a resizable pane below the editor (a draggable Split gutter),
// seeded so the editor starts ~150px tall; the pane is a TabPanel holding up to
// three independently-refreshed tabs:
//
//   * Data    — the read-only results grid (a query result has no PK and is
//               never written back). Driven by Run; present for every rows result.
//   * Chart   — a bar/line chart of the current Data rows over a config strip;
//               opened/refreshed on demand by the Chart toolbar button (enabled
//               only for a chartable result — >=1 row, >=1 numeric column) and
//               closeable. See QueryResultGrid / QueryResultChart in
//               QueryResultView.
//   * Explain — a read-only, SQL-highlighted CodeEditor holding an EXPLAIN or
//               EXPLAIN ANALYZE plan; closeable.
//
// Each tab is owned by its own toolbar action and they persist independently:
// Run refreshes only Data, the Chart button only Chart, Explain only Explain —
// EXPLAIN no longer destroys the data view, and a re-run does not disturb an open
// Chart/Explain tab. The pane appears with the first tab and vanishes with the
// last (the Tab "empty" event). A non-row statement (INSERT/UPDATE/DDL) reports
// its command tag and drops only the Data tab, leaving any Chart/Explain tab.
// Errors funnel to onError.
//
// Two toolbar buttons run EXPLAIN and EXPLAIN ANALYZE on the editor's statement.
// One Explain tab serves both — analyze only adds real timings — and its content
// is replaced per run. Explain Analyze executes the statement (the backend rolls
// it back), so the frontend blocks it for a statement that does not look
// read-only — plain Explain is always safe.
//
// Built as a class-first composition wrapper (the instance owns `content` and
// `dispose`, rather than `extends`-ing a library base — see
// COMPONENT_CONVENTIONS.md's composition fallback). The panel's Component
// subtree is dropped when the dock tab closes, but the live tab views (each
// Data grid store, a Chart's chart instance, the Explain plan CodeEditor) and
// the main editor are not torn down by that alone — the framework has no
// cascading dispose. The instance exposes `dispose` alongside its `content`
// precisely so the controller can release each live tab view's and the main
// editor's CodeMirror views / chart / ThemeManager subscriptions explicitly;
// see SqlAdminController's `_panelDisposers`.

import { Component, Container, Event } from "@jimka/typescript-ui/core";
import { Placement }                     from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Split } from "@jimka/typescript-ui/layout";
import { ToolBar }                       from "@jimka/typescript-ui/component/menubar";
import { Spacer, TabPanel }              from "@jimka/typescript-ui/component/container";
import { glyphButton, glyphMenuButton }  from "./glyphButton";
import { CodeEditor }                    from "@jimka/typescript-ui/component/editor";
import { Glyph }                         from "@jimka/typescript-ui/component/display";
import { play }                          from "@jimka/typescript-ui/glyphs/solid/play";
import { eraser }                        from "@jimka/typescript-ui/glyphs/solid/eraser";
import { floppy_disk }                   from "@jimka/typescript-ui/glyphs/solid/floppy_disk";
import { angle_up }                      from "@jimka/typescript-ui/glyphs/solid/angle_up";
import { angle_down }                    from "@jimka/typescript-ui/glyphs/solid/angle_down";
import { file_export }                   from "@jimka/typescript-ui/glyphs/solid/file_export";
import { file_csv }                      from "@jimka/typescript-ui/glyphs/solid/file_csv";
import { file_code }                     from "@jimka/typescript-ui/glyphs/solid/file_code";
import { file_lines }                    from "@jimka/typescript-ui/glyphs/solid/file_lines";
import { diagram_project }               from "@jimka/typescript-ui/glyphs/solid/diagram_project";
import { flask }                         from "@jimka/typescript-ui/glyphs/solid/flask";
import { sitemap }                       from "@jimka/typescript-ui/glyphs/solid/sitemap";
import { wand_magic_sparkles }           from "@jimka/typescript-ui/glyphs/solid/wand_magic_sparkles";
import { table }                         from "@jimka/typescript-ui/glyphs/solid/table";
import { chart_simple }                  from "@jimka/typescript-ui/glyphs/solid/chart_simple";
import { QueryResultGrid, QueryResultChart } from "./QueryResultView";
import { isChartable }                   from "../data/chartConfig";
import { HistoryCursor }                 from "../data/historyCursor";
import { isReadOnlyStatement }           from "../data/explain";
import { parseExplainPlan, parseExplainSummary } from "../data/parseExplainPlan";
import type { ExplainPlanNode, ExplainSummary }  from "../data/parseExplainPlan";
import { ExplainDiagramPanel }           from "./ExplainDiagramPanel";
import { buildQueryExportItems }         from "./menuItems";
import type { ActiveExport, RunExplain } from "../data/explain";
import type { HistoryEntry }             from "../data/queryStore";
import type { SplitLayoutBinding, AccordionLayoutBinding } from "../data/layoutStore";
import {
    isExplainChord, isExplainAnalyzeChord,
    RUN_SHORTCUT, SAVE_SHORTCUT, CLEAR_SHORTCUT, EXPLAIN_SHORTCUT, EXPLAIN_ANALYZE_SHORTCUT,
    OLDER_QUERY_SHORTCUT, NEWER_QUERY_SHORTCUT,
} from "../shell/queryShortcuts";
import type { QueryExplainResult, QueryResult, QueryRowsResult } from "../contract";
import { PRIMARY_COLOR, CONSTRUCTIVE_COLOR, CAUTION_COLOR, HISTORY_COLOR, NEUTRAL_COLOR } from "../theme";

Glyph.register(play, eraser, floppy_disk, angle_up, angle_down, file_export, file_csv, file_code, file_lines, diagram_project, flask, sitemap, wand_magic_sparkles, table, chart_simple);

// The editor's starting height once the result pane is shown below it; the Split
// gutter lets the user resize from there.
const EDITOR_HEIGHT = 150;

/** Surface a short status message (row count / command tag / hint) to the user. */
export type Notify = (message: string) => void;

/** Runs one SQL statement and resolves its result. */
export type RunQuery = (sql: string) => Promise<QueryResult>;

/** Construction inputs for {@link QueryPanel}. */
export interface QueryPanelOptions {
    /** Executes the SQL (bound to the connection by the controller). */
    runQuery: RunQuery;
    /** Runs EXPLAIN / EXPLAIN ANALYZE (bound to the connection by the controller). */
    runExplain: RunExplain;
    /** Reports row count / command tag / hint to the status bar. */
    notify: Notify;
    /** Surfaces a failed run (the controller's notifyError). */
    onError: (error: unknown) => void;
    /** Prefill the editor (the "Open as query" path seeds a generated SELECT). */
    initialSql?: string;
    /** Run the seeded SQL immediately on open (true for "Open as query"). */
    autoRun?: boolean;
    /**
     * EXPLAIN the seeded SQL immediately on open instead of running it — `"plain"`
     * for EXPLAIN, `"analyze"` for EXPLAIN ANALYZE. Takes precedence over
     * {@link autoRun}; used by the view panel's Explain actions, which open a
     * query tab seeded with the view's SELECT and show its plan here.
     */
    autoExplain?: "plain" | "analyze";
    /** Record a completed run in history (the controller binds this to the store). */
    onRun?: (entry: HistoryEntry) => void;
    /** Newest-first SQL snapshot for the Ctrl+↑/↓ history recall (from the store). */
    getHistory?: () => string[];
    /**
     * Save the current editor SQL (the toolbar Save button). The controller
     * binds this to the naming modal + saved-query store; the panel stays a pure
     * view, handing over the trimmed SQL and leaving the naming/persist to it.
     */
    onSave?: (sql: string) => void;
    /**
     * Called whenever the exportable result changes: a rows result on a
     * successful SELECT/RETURNING, an EXPLAIN plan after an Explain run, or null
     * on a clear or a status-only result. Lets the controller route the menubar
     * "Export results…" item to this (the active) panel without holding a
     * reference back to it.
     */
    onResult?: (active: ActiveExport | null) => void;
    /** The saved editor/result Split geometry plus its save hooks (`controller.layout.bindSplit("query")`). */
    splitLayout: SplitLayoutBinding;
    /** The saved Explain-diagram info-column Accordion open state plus its save hooks (`controller.layout.bindAccordion("explainDiagram")`). */
    explainDiagramLayout: AccordionLayoutBinding;
}

/**
 * A query panel: a SQL editor over a (resizable) result grid. A class-first
 * composition wrapper: the instance owns `content` (the panel subtree) and
 * `dispose` (releasing the main editor's — and, if shown, the plan editor's —
 * view and theme subscription).
 */
export class QueryPanel {
    readonly content: Container;
    readonly dispose: () => void;

    constructor(options: QueryPanelOptions) {
        const { runQuery, runExplain, notify, onError, initialSql = "", autoRun = false, autoExplain, onRun, getHistory, onSave, onResult, splitLayout, explainDiagramLayout } = options;

        const editor = new CodeEditor(initialSql, { language: "sql" });

        // The result pane is a TabPanel with up to three independently-driven tabs,
        // each owned by its own toolbar action: Data (the grid, from Run), Chart (a
        // chartable result's chart, from the Chart button), and Explain (a read-only
        // plan editor, from Explain / Explain Analyze). Each slot holds its
        // currently-mounted tab's content, the disposer that releases that content's
        // CodeMirror view / chart (the framework has no cascading dispose), and the
        // result the tab exports — so switching tabs re-derives the export from the
        // active slot without a shared stash. A slot is null when its tab is absent.
        // Run refreshes only Data, the Chart button only Chart, Explain only Explain;
        // none disturbs another's tab.
        let dataSlot:    { content: Component; dispose(): void; result: QueryRowsResult } | null = null;
        let chartSlot:   { content: Component; dispose(): void; result: QueryRowsResult } | null = null;
        let explainSlot: { editor: CodeEditor; result: QueryExplainResult; sql: string } | null = null;
        // The plan tree + diagram tab, built from the shown Explain plan re-fetched
        // as FORMAT JSON. Closeable; a fresh build replaces it. Diagram/Tree hold no
        // CodeMirror/chart, so its disposer is a no-op (the DOM subtree is enough).
        let diagramSlot: { content: Component; dispose(): void } | null = null;

        // Raised around a programmatic closeTab so its "tabclose" emit is ignored by
        // the onTabClose handler (the caller disposes the removed view itself),
        // keeping disposal single-owner and preventing double-dispose.
        let suppressCloseHandler = false;

        // Raised around a tab refresh (add the replacement tab(s), then remove the old
        // ones). A newly-added tab only lands in the Tab manager's content list on the
        // next scheduled layout, so the interim removal can momentarily drain the strip
        // to zero and fire "empty" even though a replacement is already queued — the
        // guard keeps that transient empty from hiding the pane. A refresh always adds
        // at least one tab, so the pane legitimately stays shown throughout.
        let refreshingTabs = false;

        const resultHost = TabPanel({});
        const tab        = resultHost.getTab();

        // The body is a vertical Split: the editor alone (filling) until a query
        // runs, then editor over the result pane with a draggable gutter between.
        // No paneSizes/collapsedPanes here (deliberately absent): the split has one
        // child (the editor) at first layout, and the library's once-only drain
        // fires then — a 2-entry saved array fails its length check and is never
        // retried once the result pane is later added. restoreOrSeedPanes (below)
        // applies the saved geometry imperatively once both panes exist instead.
        const split = new Split({
            orientation: "vertical",
            listeners  : { paneresize: splitLayout.onSizes, panecollapse: splitLayout.onCollapse },
        });
        const body  = new Component();
        body.setLayoutManager(split);
        // weight 0 pins the editor's height on a vertical viewport/panel resize — the
        // result grid below absorbs the change instead. A gutter-drag still resizes
        // the editor. (While the editor is the only pane it fills regardless: with no
        // positive-weight sibling the split falls back to filling the container.)
        body.addComponent(editor, { weight: 0 });

        const runButton     = glyphButton("play", CONSTRUCTIVE_COLOR, `Run (${RUN_SHORTCUT})`, () => void run());
        const saveButton    = glyphButton("floppy-disk", PRIMARY_COLOR, `Save query (${SAVE_SHORTCUT})`, () => save());
        const clearButton   = glyphButton("eraser", CAUTION_COLOR, `Clear (${CLEAR_SHORTCUT})`, () => clear());
        const formatButton  = glyphButton("wand-magic-sparkles", NEUTRAL_COLOR, "Format SQL", () => void formatSql());
        // Chart the current Data result on demand (opens/refreshes the closeable
        // Chart tab). Enabled only while the Data tab holds a chartable result.
        const chartButton   = glyphButton("chart-simple", PRIMARY_COLOR, "Chart the results", () => showChart());
        // The glyph registers under its hyphenated name ("diagram-project"), even
        // though the ESM export identifier uses an underscore.
        const explainButton = glyphButton("diagram-project", NEUTRAL_COLOR, `Explain (${EXPLAIN_SHORTCUT})`,
                                          () => void runExplainRun(false));
        const analyzeButton = glyphButton("flask", CAUTION_COLOR, `Explain Analyze (${EXPLAIN_ANALYZE_SHORTCUT})\n\nexecutes the statement`,
                                          () => void runExplainRun(true));
        // Opens the shown Explain plan as a tree + diagram tab in the result pane.
        // Enabled only while an Explain plan is on screen (showDiagram re-requests it
        // as a FORMAT JSON plan tree).
        const diagramButton = glyphButton("sitemap", NEUTRAL_COLOR, "Explain diagram\n\ntree + diagram of the current plan",
                                          () => void showDiagram());
        const exportButton  = glyphMenuButton("file-export", PRIMARY_COLOR, "Export results (CSV / JSON)",
                                              () => buildQueryExportItems(activeExport, notify));

        // History recall as toolbar buttons, mirroring the editor's Ctrl+↑/↓: Older
        // walks back, Newer forward. Pushed to the far right by a flexible Spacer,
        // set apart from the left-aligned Run/Save/Clear/Explain/Export actions. Each
        // recall refocuses the editor so keyboard recall / typing continues seamlessly.
        const olderButton = glyphButton("angle-up", HISTORY_COLOR, `Older query (${OLDER_QUERY_SHORTCUT})`, () => recallInEditor(true));
        const newerButton = glyphButton("angle-down", HISTORY_COLOR, `Newer query (${NEWER_QUERY_SHORTCUT})`, () => recallInEditor(false));

        const panel = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
        panel.addComponent(new ToolBar({
            components: [runButton, saveButton, clearButton, formatButton, chartButton, explainButton, analyzeButton, diagramButton, exportButton, Spacer.flex(), olderButton, newerButton],
        }), { placement: Placement.NORTH });
        panel.addComponent(body, { placement: Placement.CENTER });

        let resultShown = false;

        // The panel's latest exportable result — a rows grid or an EXPLAIN plan —
        // exposed to the controller via onResult and serialized by the Export button.
        // Null for an empty panel or a status-only result; the Export button is
        // enabled iff this is non-null, and its menu adapts to the kind.
        let activeExport: ActiveExport | null = null;

        /** Record the exportable result, mirror it to the controller, and sync Export. */
        function setActiveExport(active: ActiveExport | null): void {
            activeExport = active;
            onResult?.(active);
            exportButton.setEnabled(active !== null);
        }

        /** Add the pane to the Split and restore/seed the editor height once per hidden→shown transition. */
        function ensureResultPaneShown(): void {
            if (!resultShown) {
                body.addComponent(resultHost);
                resultShown = true;
                restoreOrSeedPanes();
            }

            body.doLayout();
            syncToolbarButtons();
        }

        /** Remove a tab programmatically (no onTabClose side-effects); the caller disposes the removed view. */
        function removeTabSilently(content: Component): void {
            suppressCloseHandler = true;

            try {
                tab.closeTab(content);
            } finally {
                suppressCloseHandler = false;
            }
        }

        /** Remove and dispose the Data tab (if present). */
        function removeDataTab(): void {
            if (dataSlot) {
                removeTabSilently(dataSlot.content);
                dataSlot.dispose();
                dataSlot = null;
            }
        }

        /** Remove and dispose the Chart tab (if present). */
        function removeChartTab(): void {
            if (chartSlot) {
                removeTabSilently(chartSlot.content);
                chartSlot.dispose();
                chartSlot = null;
            }
        }

        /** Remove and dispose the Explain tab (if present). */
        function removeExplainTab(): void {
            if (explainSlot) {
                removeTabSilently(explainSlot.editor);
                explainSlot.editor.dispose();
                explainSlot = null;
                syncDiagramButton();
            }
        }

        /** Remove and dispose the Diagram tab (if present). */
        function removeDiagramTab(): void {
            if (diagramSlot) {
                removeTabSilently(diagramSlot.content);
                diagramSlot.dispose();
                diagramSlot = null;
            }
        }

        // Split the body so the editor starts at EDITOR_HEIGHT and the grid gets the
        // rest; the gutter then lets the user resize (and subsequent runs keep that
        // position — the pane is reused, only its table content swaps). setPaneSize
        // takes px, so we need the body's inner height. On the "Open as query"
        // auto-run that height isn't known yet (the panel runs before its first
        // layout), so defer the seed to the body's first laid-out frame; when the
        // body is already sized (the common case) it applies straight away.
        function seedEditorHeight(): void {
            const apply = (): void => {
                const full = body.getInnerSize()?.height ?? 0;

                if (full > EDITOR_HEIGHT) {
                    split.setPaneSize(editor, EDITOR_HEIGHT);
                    split.setPaneSize(resultHost, full - EDITOR_HEIGHT);
                    body.doLayout();
                } else {
                    // The body has laid out but isn't at its real height yet — it can
                    // be momentarily 0/tiny mid start-page→dock deck switch, when
                    // getInnerSize() is already truthy. Seeding here would no-op and,
                    // with nothing rescheduling it, leave the editor (weight 0) filling
                    // the panel and the result pane unseeded (blank south) until a Clear
                    // + re-run. Retry on the next layout so the seed lands once the body
                    // reaches full height.
                    body.onFirstLayout(apply);
                }
            };

            apply();
        }

        /**
         * Restore the saved editor/result split, else fall back to the EDITOR_HEIGHT
         * seed. Called once per hidden->shown transition, when both panes exist —
         * the Split's own `paneSizes`/`collapsedPanes` options cannot serve here
         * (see the constructor's comment). `applyPaneSizes` needs no laid-out
         * container (it falls back to a unit base and the first real layout hands
         * the whole delta to the flexible result host), so this needs none of
         * `seedEditorHeight`'s onFirstLayout retry. It is also strict: a stale array
         * is discarded by the library and the panes fall to normal first-layout
         * sizing rather than the seed — narrow, and it self-heals on the next drag.
         */
        function restoreOrSeedPanes(): void {
            const sizes = splitLayout.loadSizes();

            if (sizes === null) {
                seedEditorHeight();

                return;
            }

            split.applyPaneSizes(sizes);

            for (const index of splitLayout.loadCollapsed()) {
                split.setPaneCollapsedImmediate(index, true);
            }
        }

        /** Drop the result pane so the editor fills the panel again. Wired to the Tab "empty" event. */
        function hideResultPane(): void {
            if (resultShown) {
                body.removeComponent(resultHost);
                resultShown = false;
                body.doLayout();
            }

            syncToolbarButtons();
        }

        /** Recompute the exportable result from whichever tab is active now (from its own slot). */
        function syncExportToActiveTab(): void {
            const active = tab.getActiveContent();

            if (explainSlot && active === explainSlot.editor) {
                setActiveExport({ kind: "plan", plan: { result: explainSlot.result, sql: explainSlot.sql, runExplain } });
            } else if (dataSlot && active === dataSlot.content) {
                setActiveExport({ kind: "rows", result: dataSlot.result });
            } else if (chartSlot && active === chartSlot.content) {
                setActiveExport({ kind: "rows", result: chartSlot.result });
            } else {
                setActiveExport(null);
            }
        }

        // Export follows the active tab on user switches and on the programmatic
        // setActiveContent each refresh performs. (A fresh tab add auto-selects
        // visually without emitting "activate", so the explicit setActiveContent
        // drives this.)
        tab.on("activate", () => syncExportToActiveTab());

        // The user closed a closeable tab (Chart, Explain, or Diagram — Data is not
        // closeable): dispose its view. "activate" does NOT fire on the silent
        // post-close reselection, and getActiveContent() is momentarily stale inside
        // "tabclose" (emitted before the reselection), so defer the export recompute
        // to a microtask, by when the surviving tab is selected.
        tab.on("tabclose", (content: Component) => {
            if (suppressCloseHandler) {
                return;
            }

            if (chartSlot && content === chartSlot.content) {
                chartSlot.dispose();
                chartSlot = null;
            } else if (explainSlot && content === explainSlot.editor) {
                explainSlot.editor.dispose();
                explainSlot = null;
                syncDiagramButton();
            } else if (diagramSlot && content === diagramSlot.content) {
                diagramSlot.dispose();
                diagramSlot = null;
            }

            queueMicrotask(syncExportToActiveTab);
        });

        // Last tab gone (by user close or programmatic removal): drop the pane —
        // unless a refresh is mid-flight, where the emptied strip is transient (a
        // replacement tab is already queued for the next layout).
        tab.on("empty", () => {
            if (!refreshingTabs) {
                hideResultPane();
            }
        });

        /** Reset the panel to its initial state: empty editor, no tabs, no result pane. */
        function clear(): void {
            editor.setValue("");
            removeDataTab();
            removeChartTab();
            removeDiagramTab();
            removeExplainTab(); // the last removal empties the strip → "empty" → hideResultPane
            setActiveExport(null);
            syncChartButton();
        }

        /**
         * Save the current query: hand the trimmed editor SQL to the injected saver
         * (which prompts for a name and persists it). A no-op on an empty editor.
         */
        function save(): void {
            const sql = editor.getValue().trim();

            if (!sql) {
                notify("Enter a SQL statement to save");

                return;
            }

            onSave?.(sql);
        }

        /** Format the editor SQL; on invalid SQL format() rejects and leaves text untouched. */
        async function formatSql(): Promise<void> {
            try {
                await editor.format();
            } catch {
                notify("Cannot format — the statement is not valid SQL");
            }
        }

        // Keep the input-dependent toolbar buttons in step with the editor's state.
        // Clear is meaningful when there is something to reset (text or a result on
        // screen); Save is meaningful only with SQL to save. (setValue/setText don't
        // fire "change", so mutators re-sync through here.)
        function syncToolbarButtons(): void {
            const hasSql = editor.getValue().trim() !== "";

            clearButton.setEnabled(hasSql || resultShown);
            saveButton.setEnabled(onSave !== undefined && hasSql);
        }

        /** Enable the Chart button only while the Data tab holds a chartable result. */
        function syncChartButton(): void {
            chartButton.setEnabled(dataSlot !== null && isChartable(dataSlot.result));
        }

        /** Enable the Explain-diagram button only while an Explain plan is on screen. */
        function syncDiagramButton(): void {
            diagramButton.setEnabled(explainSlot !== null);
        }

        /**
         * Re-request the shown Explain plan as a FORMAT JSON plan tree, parse it, and
         * open (or refresh) the Diagram tab in the result pane. Uses the shown plan's
         * statement and analyze flag, so it needs no read-only re-check (the text
         * Explain already ran). Shares the runSeq guard / busy-button behaviour with
         * the other actions. A no-op when no plan is shown (the button is disabled
         * then, so defensive); a malformed/empty plan notifies and opens nothing.
         */
        async function showDiagram(): Promise<void> {
            if (!explainSlot) {
                return;
            }

            const { sql }  = explainSlot;
            const analyze  = explainSlot.result.analyze;
            const seq      = ++runSeq;

            historyCursor = null;
            setBusy(true);
            notify("Building the plan diagram…");

            try {
                const json = await runExplain(sql, { analyze, format: "json" });

                if (seq !== runSeq) {
                    return;
                }

                const roots = parseExplainPlan(json.planJson);

                if (roots.length === 0) {
                    notify("no JSON plan tree to diagram");

                    return;
                }

                showDiagramTab(roots, parseExplainSummary(json.planJson));
                notify(`plan diagram (${roots.length} plan root(s))`);
            } catch (error) {
                if (seq === runSeq) {
                    onError(error);
                }
            } finally {
                if (seq === runSeq) {
                    setBusy(false);
                }
            }
        }

        /**
         * Mount the plan tree + diagram as the (closeable) Diagram tab, replacing any
         * prior one. Mirrors showChart's add-then-remove-under-refreshingTabs dance so
         * the interim strip-drain can't hide the pane before the replacement lands.
         *
         * @param roots - The parsed plan roots to diagram.
         * @param summary - The plan's top-level planning/execution times.
         */
        function showDiagramTab(roots: ExplainPlanNode[], summary: ExplainSummary): void {
            const nextDiagram = new ExplainDiagramPanel(roots, summary, explainDiagramLayout);

            ensureResultPaneShown();

            refreshingTabs = true;

            try {
                resultHost.addTab(nextDiagram, "Diagram", { closeable: true, glyph: "sitemap" });
                removeDiagramTab();
            } finally {
                refreshingTabs = false;
            }

            diagramSlot = { content: nextDiagram, dispose: () => {} };

            tab.setActiveContent(nextDiagram);
        }

        // Monotonic guard: a slow run whose result arrives after a newer run started
        // is discarded so it can't clobber the newer one (mirrors showProperties's
        // _propsSeq). Run and Explain share the counter so a slow explain can't clobber
        // a newer run (or vice versa), and all action buttons disable while one is
        // in flight.
        let runSeq = 0;

        /** Disable (or re-enable) the run/explain/chart action buttons around an in-flight run. */
        function setBusy(busy: boolean): void {
            runButton.setEnabled(!busy);
            explainButton.setEnabled(!busy);
            analyzeButton.setEnabled(!busy);

            // Chart builds client-side from the current Data result, and the Explain
            // diagram opens from the current plan; keep both off during a run and
            // restore them from the (possibly refreshed) result / plan slot after.
            if (busy) {
                chartButton.setEnabled(false);
                diagramButton.setEnabled(false);
            } else {
                syncChartButton();
                syncDiagramButton();
            }
        }

        // The per-panel history-navigation cursor for Ctrl+↑/↓. Built lazily from a
        // fresh history snapshot when the user starts a browse, and reset to null on
        // a run (running ends the browse), so each browse recalls the latest history.
        let historyCursor: HistoryCursor | null = null;

        async function run(): Promise<void> {
            const sql = editor.getValue().trim();

            if (!sql) {
                notify("Enter a SQL statement");

                return;
            }

            const seq = ++runSeq;

            // Running ends any in-progress Ctrl+↑/↓ browse; the next Ctrl+arrow rebuilds
            // the cursor from the now-updated history snapshot.
            historyCursor = null;
            setBusy(true);
            notify("Running…");

            try {
                const result = await runQuery(sql);

                if (seq === runSeq) {
                    showResult(result);
                    onRun?.({ sql, timestamp: Date.now(), ok: true, rowCount: resultRowCount(result) });
                }
            } catch (error) {
                if (seq === runSeq) {
                    onError(error);
                    onRun?.({ sql, timestamp: Date.now(), ok: false, rowCount: 0 });
                }
            } finally {
                if (seq === runSeq) {
                    setBusy(false);
                }
            }
        }

        /**
         * Run EXPLAIN / EXPLAIN ANALYZE on the editor's statement and show its plan.
         * Shares the runSeq guard and busy-button behaviour with {@link run}. Plain
         * Explain never executes the statement; Explain Analyze does (rolled back on
         * the backend), so it is blocked here when the statement is not plainly a read.
         *
         * @param analyze - True for EXPLAIN ANALYZE, false for plain EXPLAIN.
         */
        async function runExplainRun(analyze: boolean): Promise<void> {
            const sql = editor.getValue().trim();

            if (!sql) {
                notify("Enter a SQL statement");

                return;
            }

            if (analyze && !isReadOnlyStatement(sql)) {
                // Frontend guard: don't round-trip an ANALYZE that would execute a
                // write. The backend rolls it back regardless, but plain Explain is
                // the safe path to a plan without running the statement at all.
                notify("EXPLAIN ANALYZE will EXECUTE this statement (changes are rolled back). "
                     + "It does not look read-only — use Explain to see the plan without running it.");

                return;
            }

            const seq = ++runSeq;

            historyCursor = null;
            setBusy(true);
            notify(analyze ? "Explaining (analyze)…" : "Explaining…");

            try {
                const result = await runExplain(sql, { analyze, format: "text" });

                if (seq === runSeq) {
                    showPlan(result, sql);
                }
            } catch (error) {
                if (seq === runSeq) {
                    onError(error);
                }
            } finally {
                if (seq === runSeq) {
                    setBusy(false);
                }
            }
        }

        function showResult(result: QueryResult): void {
            if (result.kind === "rows") {
                showRowsResult(result);
                notify(result.truncated
                    ? `showing first ${result.rowCount} rows — result truncated`
                    : `${result.rowCount} row(s)`);

                return;
            }

            // No result set (INSERT/UPDATE/DDL): drop only the Data tab, LEAVE any
            // Chart/Explain tab (each owned by its own action). If a tab survives it
            // becomes the export source; if nothing is left the "empty" event has
            // hidden the pane and export becomes null. (An explain result never reaches
            // here — runExplainRun routes it to showPlan directly, which needs the
            // source SQL this path lacks.)
            removeDataTab();
            syncExportToActiveTab();
            syncChartButton(); // no Data result to chart now (also re-synced by setBusy)
            notify(result.kind === "status" ? result.command || "OK" : "OK");
        }

        /**
         * Show a rows result in the Data tab. The library's Table virtual-scrolls its
         * rows, so the whole result set renders regardless of size — no client display
         * cap; the backend bounds the fetch and flags truncation (surfaced by the
         * caller's status message). Run refreshes only the Data tab and leaves any
         * Chart/Explain tab untouched; the Chart button (re)builds the Chart tab
         * separately from the current Data result.
         *
         * @param result - The rows result to render.
         */
        function showRowsResult(result: QueryRowsResult): void {
            const nextData = new QueryResultGrid(result);

            ensureResultPaneShown();

            // Add the replacement, then remove the old tab, under refreshingTabs so the
            // interim strip-drain (the new tab only enters the content list on the next
            // layout) can't hide the pane. This keeps the pane in the Split and
            // preserves the gutter position across a refresh.
            refreshingTabs = true;

            try {
                resultHost.addTab(nextData.content, "Data", { glyph: "table" });
                removeDataTab();
            } finally {
                refreshingTabs = false;
            }

            dataSlot = { content: nextData.content, dispose: nextData.dispose, result };

            tab.setActiveContent(nextData.content);
            setActiveExport({ kind: "rows", result });
        }

        /**
         * Build (or refresh) the Chart tab from the current Data result and select it.
         * Driven only by the Chart toolbar button — the button is enabled only while
         * the Data tab holds a chartable result, so this charts exactly what the Data
         * tab currently shows. Closeable; leaves the Data/Explain tabs untouched.
         */
        function showChart(): void {
            if (!dataSlot || !isChartable(dataSlot.result)) {
                return; // defensive — the button is disabled otherwise
            }

            const result = dataSlot.result;
            const nextChart = new QueryResultChart(result);

            ensureResultPaneShown();

            refreshingTabs = true;

            try {
                resultHost.addTab(nextChart.content, "Chart", { closeable: true, glyph: "chart-simple" });
                removeChartTab();
            } finally {
                refreshingTabs = false;
            }

            chartSlot = { content: nextChart.content, dispose: nextChart.dispose, result };

            tab.setActiveContent(nextChart.content);
            setActiveExport({ kind: "rows", result });
        }

        /**
         * Row count to record in history for a run. A rows/status result carries one;
         * an explain result (which never reaches here from {@link run}) has none, so 0.
         */
        function resultRowCount(result: QueryResult): number {
            return result.kind === "explain" ? 0 : result.rowCount;
        }

        /**
         * Render an EXPLAIN plan in the result pane as a read-only monospace block and
         * mark it the panel's exportable result (text / JSON via the Export button).
         *
         * @param result - The FORMAT TEXT plan to display.
         * @param sql - The exact statement explained, kept so a JSON export can
         *     re-request it as a FORMAT JSON plan tree.
         */
        function showPlan(result: QueryExplainResult, sql: string): void {
            // A read-only, SQL-highlighted CodeEditor seeded with the joined plan text.
            // Read-only (not disabled) keeps the plan selectable and copyable while
            // blocking edits (CodeEditor flashes its own overlay). One Explain tab is
            // reused for both EXPLAIN and EXPLAIN ANALYZE — each run replaces its
            // content; the analyze-vs-plain distinction lives in the status text only.
            const editor = new CodeEditor(result.plan, { language: "sql", readOnly: true });

            ensureResultPaneShown();

            // Add the new plan tab, then remove the old one, under refreshingTabs so
            // the interim strip-drain (when Explain was the only tab) can't hide the
            // pane before the replacement lands on the next layout.
            refreshingTabs = true;

            try {
                resultHost.addTab(editor, "Explain", { closeable: true, glyph: "diagram-project" });
                removeExplainTab();
            } finally {
                refreshingTabs = false;
            }

            explainSlot = { editor, result, sql };

            tab.setActiveContent(editor);
            setActiveExport({ kind: "plan", plan: { result, sql, runExplain } });
            syncDiagramButton();
            notify(result.analyze ? "EXPLAIN ANALYZE plan (side-effects rolled back)" : "EXPLAIN plan");
        }

        // Editor accelerators: Ctrl/Cmd+Enter runs, Ctrl/Cmd+S saves, Ctrl/Cmd+E
        // explains (Ctrl/Cmd+Shift+E explain-analyzes), Alt+C clears, Ctrl/Cmd+↑/↓
        // recalls history (bash-style). CodeEditor has no "keydown" event, so this
        // is wired through Event.addSubtreeListener — a window capture-phase
        // dispatcher firing before CodeMirror's own key handling, so preventDefault()
        // here still suppresses any CodeMirror default. It MUST be addSubtreeListener,
        // not addListener: a keydown inside the editor originates at CodeMirror's
        // inner contentDOM (a descendant of the CodeEditor element), and addListener
        // only matches when the event's exact target IS the component element — so it
        // never fires for CodeMirror keystrokes (the old TextArea was itself the
        // target, which is why addListener worked before the swap). Editor-scoped so
        // Explain acts on this query view and does not clash with the list/editor
        // select-all elsewhere. Plain arrows (no modifier) are untouched, so normal
        // caret movement still works — and Clear is Alt+C, not Ctrl+C, so the
        // editor's Copy is left intact.
        Event.addSubtreeListener(editor, "keydown", (e: KeyboardEvent) => {
            const chord = e.ctrlKey || e.metaKey;

            if (chord && e.key === "Enter") {
                e.preventDefault();
                void run();

                return;
            }

            if (chord && (e.key === "s" || e.key === "S")) {
                e.preventDefault();
                save();

                return;
            }

            // Ctrl/Cmd+E explains; adding Shift explain-analyzes. Shared with the view
            // panel's Explain chords (queryShortcuts) so the two surfaces stay in sync.
            if (isExplainChord(e)) {
                e.preventDefault();
                void runExplainRun(false);

                return;
            }

            if (isExplainAnalyzeChord(e)) {
                e.preventDefault();
                void runExplainRun(true);

                return;
            }

            if (e.altKey && !chord && (e.key === "c" || e.key === "C")) {
                e.preventDefault();
                clear();

                return;
            }

            if (chord && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                e.preventDefault();
                recallHistory(e.key === "ArrowUp");
            }
        });

        /**
         * Recall a history entry into the editor. On the first Ctrl+arrow of a browse
         * the cursor is built from a fresh history snapshot and seeded with the live
         * draft, so arrowing down past the newest entry restores the in-progress text.
         *
         * @param older - `true` for Ctrl+↑ (walk toward older), `false` for Ctrl+↓.
         */
        function recallHistory(older: boolean): void {
            if (!historyCursor) {
                historyCursor = new HistoryCursor(getHistory?.() ?? []);
                historyCursor.begin(editor.getValue());
            }

            editor.setValue(older ? historyCursor.older() : historyCursor.newer());
            syncToolbarButtons();
        }

        /**
         * Recall from the toolbar arrows: same as {@link recallHistory}, then return
         * focus to the editor (the click moved it to the button) so keyboard recall
         * and typing continue seamlessly.
         *
         * @param older - `true` for the Older arrow, `false` for the Newer arrow.
         */
        function recallInEditor(older: boolean): void {
            recallHistory(older);
            editor.focus();
        }

        // Keep the toolbar buttons in step with the editor's content as the user
        // types. CodeEditor's "change" fires from CodeMirror's updateListener after
        // the document transaction commits, so getValue() already reflects the new
        // text by the time this runs.
        editor.on("change", () => syncToolbarButtons());

        // Initial state: Run/Save/Clear disabled for an empty panel (enabled when
        // seeded); Chart/Export disabled until a rows result is shown.
        syncToolbarButtons();
        chartButton.setEnabled(false);
        diagramButton.setEnabled(false);
        exportButton.setEnabled(false);

        // Focus the editor so the user can type on a fresh tab straight away. The
        // panel content is built before the Dock mounts it, so the element may not
        // exist yet — onFirstLayout runs once the editor has been mounted and laid
        // out, when it can take focus (and never fires for a tab closed before it
        // mounts).
        editor.onFirstLayout(() => editor.focus());

        // Defer an auto-run/-explain (Open-as-query "Execute", the view panel's
        // Explain) to the editor's first layout. The FIRST query tab is created while
        // the work-dock deck page is still hidden (the start page is showing); firing
        // the run synchronously here would populate the result pane against an
        // unmounted, unsized panel and race the deck switch — intermittently leaving
        // the southern region unseeded (blank) until a Clear + re-run. Waiting for
        // first layout guarantees a mounted, laid-out panel, matching a second tab
        // opened into the already-visible dock. onFirstLayout fires once, so this
        // runs exactly once.
        if ((autoExplain || autoRun) && initialSql.trim()) {
            editor.onFirstLayout(() => {
                if (autoExplain) {
                    void runExplainRun(autoExplain === "analyze");
                } else {
                    void run();
                }
            });
        }

        this.content = panel;
        // Dispose the live tab views directly — no tab churn on a dying panel.
        this.dispose = () => {
            dataSlot?.dispose();
            chartSlot?.dispose();
            explainSlot?.editor.dispose();
            diagramSlot?.dispose();
            editor.dispose();
        };
    }
}

