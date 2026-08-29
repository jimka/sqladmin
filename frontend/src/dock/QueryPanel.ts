// A Dock work panel for arbitrary SQL: a multi-line editor over a tabbed result
// pane. The editor runs on the Run toolbar button or Ctrl/Cmd+Enter. Until a
// query is executed, the editor fills the panel and no result pane is shown. A
// result adds a resizable pane below the editor (a draggable Split gutter),
// seeded so the editor starts ~150px tall; the pane is a TabPanel holding up to
// three independently-refreshed tabs:
//
//   * Data    — the read-only results grid (a query result has no PK and is
//               never written back). Driven by Run; present for every rows result.
//               First run: registered as a lazy tab (TabPanel.addTab's factory
//               form) bound to Run's in-flight fetch, so the tab and the
//               library's own spinner appear immediately, covering both the
//               network round trip and the grid construction. Re-run (a Data
//               tab already exists): the existing tab is overlaid with a
//               ProgressSpinner in place instead — reusing the lazy-tab path
//               here would show two "Data" tabs for the whole fetch, since the
//               old one can't safely be removed until the new one is confirmed
//               to hold rows. See refreshDataTab / refreshExistingDataTab.
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
// its command tag and drops only the Data tab, leaving any Chart/Explain tab. A
// re-run's fetch error or non-rows result never discards an already-loaded Data
// tab — the old tab is only removed once the new fetch is confirmed to hold
// rows, so a failed re-run always leaves the last good grid in place (just not
// necessarily the active tab). Errors funnel to onError, a 3-second toast, and
// a durable in-panel error banner (below the editor/result pane) that stays
// until dismissed, a new run starts, or Clear is pressed.
//
// Two toolbar buttons run EXPLAIN and EXPLAIN ANALYZE on the editor's statement.
// One Explain tab serves both — analyze only adds real timings — and its content
// is replaced per run. Explain Analyze executes the statement (the backend rolls
// it back), so the frontend blocks it for a statement that does not look
// read-only — plain Explain is always safe.
//
// Built as a class-first composition wrapper (the instance owns `content`
// rather than `extends`-ing a library base — see COMPONENT_CONVENTIONS.md's
// composition fallback). The Dock destroys `content` and every registered
// child beneath it — each live tab view's CodeMirror view / chart / theme
// subscription, and the main editor — when the tab closes, so this class
// needs no `dispose` of its own. The two exceptions are the result pane and
// the error banner: each is deliberately kept alive and detached from its
// parent while hidden (see hideResultPane / ErrorBanner.hide), so nothing in
// the tab's subtree reaches either one in that state. `content` is a
// `QueryPanelContent`, a small `Container` subclass whose `destructor()`
// override disposes both either way.

import { Component, Container, Event }          from "@jimka/typescript-ui/core";
import { Placement }                            from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Split }        from "@jimka/typescript-ui/layout";
import { ToolBar }                              from "@jimka/typescript-ui/component/menubar";
import { Spacer, TabPanel }                     from "@jimka/typescript-ui/component/container";
import { glyphButton, glyphMenuButton }         from "./glyphButton";
import { CodeEditor }                           from "@jimka/typescript-ui/component/editor";
import { Glyph, ProgressSpinner }               from "@jimka/typescript-ui/component/display";
import { play }                                 from "@jimka/typescript-ui/glyphs/solid/play";
import { eraser }                               from "@jimka/typescript-ui/glyphs/solid/eraser";
import { floppy_disk }                          from "@jimka/typescript-ui/glyphs/solid/floppy_disk";
import { angle_up }                             from "@jimka/typescript-ui/glyphs/solid/angle_up";
import { angle_down }                           from "@jimka/typescript-ui/glyphs/solid/angle_down";
import { file_export }                          from "@jimka/typescript-ui/glyphs/solid/file_export";
import { file_csv }                             from "@jimka/typescript-ui/glyphs/solid/file_csv";
import { file_code }                            from "@jimka/typescript-ui/glyphs/solid/file_code";
import { file_lines }                           from "@jimka/typescript-ui/glyphs/solid/file_lines";
import { diagram_project }                      from "@jimka/typescript-ui/glyphs/solid/diagram_project";
import { flask }                                from "@jimka/typescript-ui/glyphs/solid/flask";
import { sitemap }                              from "@jimka/typescript-ui/glyphs/solid/sitemap";
import { wand_magic_sparkles }                  from "@jimka/typescript-ui/glyphs/solid/wand_magic_sparkles";
import { table }                                from "@jimka/typescript-ui/glyphs/solid/table";
import { chart_simple }                         from "@jimka/typescript-ui/glyphs/solid/chart_simple";
import { QueryResultGrid, QueryResultChart } from "./QueryResultView";
import { ErrorBanner }                   from "./ErrorBanner";
import { isChartable }                   from "../data/chartConfig";
import { HistoryCursor }                 from "../data/historyCursor";
import { isReadOnlyStatement }           from "../data/explain";
import { parseExplainPlan, parseExplainSummary } from "../data/parseExplainPlan";
import type { ExplainPlanNode, ExplainSummary }  from "../data/parseExplainPlan";
import { resolveIndexSuggestions }       from "../data/suggestIndexes";
import type { LoadTableStructure }       from "../data/suggestIndexes";
import { ExplainDiagramPanel }           from "./ExplainDiagramPanel";
import type { ExplainAdvisorInput }      from "./ExplainDiagramPanel";
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

// Matches the library's own TablePanel auto-overlay spinner size (see
// ProgressSpinner's "which loading affordance" docs) — refreshDataTab's
// in-place overlay is the same "component exists, data pending" case.
const DATA_TAB_OVERLAY_SPINNER_SIZE = 24;

/** Surface a short status message (row count / command tag / hint) to the user. */
export type Notify = (message: string) => void;

/** Runs one SQL statement and resolves its result. */
export type RunQuery = (sql: string) => Promise<QueryResult>;

/** What the panel needs to compute index suggestions and act on one. */
export interface IndexAdvisorHooks {
    loadTableStructure: LoadTableStructure;
    onCreateIndex: (schema: string, relation: string, columns: string[]) => void;
}

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
    /** The saved Explain-diagram info-column Accordion open state and section sizes plus its save hooks (`controller.layout.bindAccordion("explainDiagram")`). */
    explainDiagramLayout: AccordionLayoutBinding;
    /** Enables the index advisor. Omitted when the controller has no database name,
     *  in which case no suggestions are computed and no strip is shown. */
    indexAdvisor?: IndexAdvisorHooks;
}

/**
 * The query panel's mountable root. Exists as a class rather than a bare
 * `Container` so it can override `destructor()`: the Dock destroys this
 * component when its tab closes, and neither the result pane nor the error
 * banner is always among its children.
 */
class QueryPanelContent extends Container {
    private readonly _resultHost : TabPanel;
    private readonly _errorBanner: ErrorBanner;

    /**
     * @param resultHost - The result pane, which the panel detaches while hidden.
     * @param onErrorBannerChange - Run after the banner is shown or hidden,
     *   in addition to this component's own relayout.
     */
    constructor(resultHost: TabPanel, onErrorBannerChange: () => void) {
        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this._resultHost  = resultHost;
        this._errorBanner = new ErrorBanner({
            host:        this,
            constraints: { placement: Placement.SOUTH },
            onChange:    () => {
                this.doLayout();
                onErrorBannerChange();
            },
        });
    }

    /** The panel's durable error banner. */
    getErrorBanner(): ErrorBanner {
        return this._errorBanner;
    }

    /**
     * `hideResultPane`/`ErrorBanner.hide` remove the result pane / error banner
     * from this component while hidden, so the child recursion in
     * `super.destructor()` cannot reach either then. Disposing both here covers
     * every state — `dispose()` is idempotent, so a still-shown pane/banner is
     * just a harmless second pass.
     */
    protected destructor(): void {
        this._resultHost.dispose();
        this._errorBanner.dispose();

        super.destructor();
    }
}

/**
 * A query panel: a SQL editor over a (resizable) result grid. A class-first
 * composition wrapper: the instance owns `content` (a {@link QueryPanelContent},
 * whose own `destructor()` covers the one part of the subtree the Dock's
 * teardown cannot always reach).
 */
export class QueryPanel {
    readonly content: QueryPanelContent;

    constructor(options: QueryPanelOptions) {
        const { runQuery, runExplain, notify, onError, initialSql = "", autoRun = false, autoExplain, onRun, getHistory, onSave, onResult, splitLayout, explainDiagramLayout, indexAdvisor } = options;

        const editor = new CodeEditor(initialSql, { language: "sql" });

        // The result pane is a TabPanel with up to three independently-driven tabs,
        // each owned by its own toolbar action: Data (the grid, from Run), Chart (a
        // chartable result's chart, from the Chart button), and Explain (a read-only
        // plan editor, from Explain / Explain Analyze). Each slot holds its
        // currently-mounted tab's content and the result the tab exports — so
        // switching tabs re-derives the export from the active slot without a shared
        // stash. A slot is null when its tab is absent. Run refreshes only Data, the
        // Chart button only Chart, Explain only Explain; none disturbs another's tab.
        let dataSlot:    { content: Component; result: QueryRowsResult } | null = null;
        let chartSlot:   { content: Component; result: QueryRowsResult } | null = null;
        let explainSlot: { editor: CodeEditor; result: QueryExplainResult; sql: string } | null = null;
        // The plan tree + diagram tab, built from the shown Explain plan re-fetched
        // as FORMAT JSON. Closeable; a fresh build replaces it. Disposing the
        // panel's DiagramView — and with it the ELK Web Worker its ElkLayoutEngine
        // holds — is the Dock's job on tab close (and on this slot's own removal,
        // since ExplainDiagramPanel is a registered child of the result TabPanel
        // either way).
        let diagramSlot: { content: Component } | null = null;

        // How many Data-tab lazy factories are currently in the strip awaiting their
        // fetch — always 0 or 1 under a single run, but Ctrl/Cmd+Enter can fire a
        // second run before the first's fetch resolves (the Run button disables
        // mid-run, but the shortcut doesn't check it), so more than one can be
        // in flight at once. See liveTabCount's doc comment for why this exists
        // alongside it, and refreshDataTab for where it's incremented/decremented.
        let pendingDataTabs = 0;

        // Raised around a programmatic closeTab so its "tabclose" emit is ignored by
        // the onTabClose handler — it exists purely to stop that handler's slot
        // nulling from running over a replacement slot the caller is about to set;
        // it has nothing to do with disposal, which tab.closeTab already handles.
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

        const panel = new QueryPanelContent(resultHost, () => syncToolbarButtons());

        // The durable error banner for a failed run, built once by QueryPanelContent
        // and reused (message replaced) on every later failure. Lives at the bottom
        // of the whole panel (Placement.SOUTH, see QueryPanelContent's constructor),
        // independent of resultHost's own shown/hidden state, so it works the same
        // whether a Data tab exists or not.
        const errorBanner = panel.getErrorBanner();

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

        /** Remove a tab programmatically (no onTabClose side-effects); tab.closeTab disposes the removed view. */
        function removeTabSilently(content: Component): void {
            suppressCloseHandler = true;

            try {
                tab.closeTab(content);
            } finally {
                suppressCloseHandler = false;
            }
        }

        /**
         * Mount `content` as the result pane's `title` tab, replacing the tab of the
         * same kind.
         *
         * The replacement is added BEFORE the outgoing tab is removed, and both run
         * under `refreshingTabs`. A newly added tab only lands in the Tab manager's
         * content list on the next scheduled layout, so removing the old one first —
         * or removing it outside the guard — can momentarily drain the strip to zero
         * and fire "empty", which would hide the very pane the replacement is about to
         * land in. Adding first also means a re-run never shows two tabs of the same
         * kind, not even for one frame.
         *
         * The caller must already have shown the result pane: `ensureResultPaneShown()`
         * for a tab built from scratch, or, on the Data-refresh path, the
         * `refreshDataTab` call that started the run.
         *
         * @param content - The freshly built tab content to mount.
         * @param title - The tab strip's label.
         * @param options - Tab options, passed straight to `TabPanel.addTab`.
         * @param removeOutgoing - Removes the outgoing tab of this kind and clears its
         *   slot (one of the four `remove*Tab` functions). A no-op when none is open.
         */
        function swapTab(
            content: Component,
            title: string,
            options: { closeable?: boolean; glyph?: string },
            removeOutgoing: () => void,
        ): void {
            refreshingTabs = true;

            try {
                resultHost.addTab(content, title, options);
                removeOutgoing();
            } finally {
                refreshingTabs = false;
            }
        }

        /**
         * Remove one result tab and clear its slot, if that tab is present.
         * `removeTabSilently`'s `tab.closeTab` disposes the removed content.
         *
         * @param content - The slot's mounted content, or undefined when the slot is empty.
         * @param clearSlot - Nulls the slot, plus any re-sync that hangs off it.
         */
        function removeTab(content: Component | undefined, clearSlot: () => void): void {
            if (!content) {
                return;
            }

            removeTabSilently(content);
            clearSlot();
        }

        /** Remove the Data tab (if present). */
        function removeDataTab(): void {
            removeTab(dataSlot?.content, () => { dataSlot = null; });
        }

        /** Remove the Chart tab (if present). */
        function removeChartTab(): void {
            removeTab(chartSlot?.content, () => { chartSlot = null; });
        }

        /** Remove the Explain tab (if present). */
        function removeExplainTab(): void {
            removeTab(explainSlot?.editor, () => {
                explainSlot = null;
                syncDiagramButton();
            });
        }

        /** Remove the Diagram tab (if present). */
        function removeDiagramTab(): void {
            removeTab(diagramSlot?.content, () => { diagramSlot = null; });
        }

        /**
         * How many tabs are currently live in the result pane, across all four slots.
         * Chart/Explain/Diagram are always added as already-built content, so their
         * slot is populated the instant they're added — this count alone is their
         * index. The Data tab is different: refreshDataTab's lazy factory occupies a
         * strip position from the moment it's added, but doesn't populate `dataSlot`
         * until (if ever) it resolves to rows — so a Data tab still awaiting its
         * fetch is invisible to this count. `pendingDataTabs` (tracked alongside)
         * covers exactly that gap; refreshDataTab adds it in, not this function,
         * since only Data ever has one.
         */
        function liveTabCount(): number {
            return [dataSlot, chartSlot, explainSlot, diagramSlot].filter(slot => slot !== null).length;
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
        // closeable): the library disposes its content as part of the close, so this
        // only nulls the slot. "activate" does NOT fire on the silent post-close
        // reselection, and getActiveContent() is momentarily stale inside "tabclose"
        // (emitted before the reselection), so defer the export recompute to a
        // microtask, by when the surviving tab is selected.
        tab.on("tabclose", (content: Component) => {
            if (suppressCloseHandler) {
                return;
            }

            if (chartSlot && content === chartSlot.content) {
                chartSlot = null;
            } else if (explainSlot && content === explainSlot.editor) {
                explainSlot = null;
                syncDiagramButton();
            } else if (diagramSlot && content === diagramSlot.content) {
                diagramSlot = null;
            }

            queueMicrotask(syncExportToActiveTab);
        });

        // A lazy Data-tab factory rejected (stale run, non-rows result, or a
        // genuine fetch error — refreshDataTab's three throw sites) and the
        // library has torn down its spinner tab and reselected a neighbor.
        // Unlike "tabclose" above, closeEntry's reselection runs BEFORE
        // failEntry emits "exception", so getActiveContent() is already
        // current here — no microtask defer needed. Re-deriving from
        // whichever tab ends up active is also correct (a no-op) for the
        // stale-run case, since it only reads state.
        tab.on("exception", () => syncExportToActiveTab());

        // Last tab gone (by user close or programmatic removal): drop the pane —
        // unless a refresh is mid-flight, where the emptied strip is transient (a
        // replacement tab is already queued for the next layout).
        tab.on("empty", () => {
            if (!refreshingTabs) {
                hideResultPane();
            }
        });

        /**
         * Reset the panel to its initial state: empty editor, no tabs, no result pane.
         *
         * A run's Data tab is added optimistically, before its fetch resolves, so a
         * Clear pressed mid-run can leave a still-building lazy entry behind that none
         * of the four slots track — the library exposes no way to close an unbuilt
         * entry directly (no closeTab-by-index/id, and cancelling the fetch itself is
         * out of scope, see the plan's Non-Goals), so removeDataTab() alone cannot
         * reach it. hideResultPane() is therefore called directly rather than left to
         * the tab-count-driven "empty" event, so the pane disappears immediately
         * regardless of that orphan entry. The entry itself stays inert until its
         * promise settles, at which point ++runSeq below makes its own staleness check
         * discard it via the library's normal lazy-tab failure teardown — reusing the
         * same detached-but-alive resultHost this file already relies on between runs
         * (see the header comment).
         */
        function clear(): void {
            ++runSeq; // invalidate any in-flight run — see the clear()/runSeq decision above

            editor.setValue("");
            removeDataTab();
            removeChartTab();
            removeDiagramTab();
            removeExplainTab();
            hideResultPane(); // covers an orphaned in-flight Data tab too — see doc comment
            errorBanner.hide();
            setActiveExport(null);
            setBusy(false); // re-enable run/explain/chart/diagram buttons in case a run was in flight
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

            clearButton.setEnabled(hasSql || resultShown || errorBanner.isShown());
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
         * Re-request the shown Explain plan as a FORMAT JSON plan tree (with
         * VERBOSE, so the heuristic index advisor can attribute predicates to a
         * schema-qualified relation), parse it, and open (or refresh) the Diagram
         * tab in the result pane. Uses the shown plan's statement and analyze
         * flag, so it needs no read-only re-check (the text Explain already ran).
         * Shares the runSeq guard / busy-button behaviour with the other
         * actions. A no-op when no plan is shown (the button is disabled then,
         * so defensive); a malformed/empty plan notifies and opens nothing.
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
                const json = await runExplain(sql, { analyze, format: "json", verbose: true });

                if (seq !== runSeq) {
                    return;
                }

                const roots = parseExplainPlan(json.planJson);

                if (roots.length === 0) {
                    notify("no JSON plan tree to diagram");

                    return;
                }

                // Compute the advisor's suggestions (a further await, on top of the
                // /structure fetches inside resolveIndexSuggestions) only when the
                // controller wired it in (it needs a database name — see
                // IndexAdvisorHooks's doc comment). Re-check runSeq after this
                // second await too, so a newer run started meanwhile still wins.
                let advisor: ExplainAdvisorInput | undefined;

                if (indexAdvisor) {
                    const suggestions = await resolveIndexSuggestions(roots, indexAdvisor.loadTableStructure);

                    if (seq !== runSeq) {
                        return;
                    }

                    advisor = {
                        suggestions,
                        onCreateIndex: suggestion =>
                            indexAdvisor.onCreateIndex(suggestion.schema, suggestion.relation, suggestion.columns),
                    };
                }

                showDiagramTab(roots, parseExplainSummary(json.planJson), advisor);

                const advisorSuffix = advisor === undefined
                    ? ""
                    : advisor.suggestions.length > 0
                        ? `, ${advisor.suggestions.length} index suggestion(s)`
                        : ", no index suggestions";

                notify(`plan diagram (${roots.length} plan root(s))${advisorSuffix}`);
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
         * prior one.
         *
         * @param roots - The parsed plan roots to diagram.
         * @param summary - The plan's top-level planning/execution times.
         * @param advisor - The index advisor's suggestions + Create hook, if enabled.
         */
        function showDiagramTab(roots: ExplainPlanNode[], summary: ExplainSummary, advisor?: ExplainAdvisorInput): void {
            const nextDiagram = new ExplainDiagramPanel(roots, summary, explainDiagramLayout, advisor);

            ensureResultPaneShown();
            swapTab(nextDiagram, "Diagram", { closeable: true, glyph: "sitemap" }, removeDiagramTab);

            diagramSlot = { content: nextDiagram };

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
            errorBanner.hide();

            const resultPromise = runQuery(sql);

            refreshDataTab(resultPromise, seq);

            try {
                const result = await resultPromise;

                if (seq === runSeq) {
                    notify(resultStatusMessage(result));
                    onRun?.({ sql, timestamp: Date.now(), ok: true, rowCount: resultRowCount(result) });
                }
            } catch (error) {
                if (seq === runSeq) {
                    onError(error);
                    errorBanner.show(error);
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

        /**
         * Registers `run()`'s in-flight fetch as the Data tab's content source.
         *
         * No Data tab exists yet: adds a new lazy tab bound to `resultPromise` and
         * selects it immediately, so the tab and its spinner appear before the fetch
         * resolves — both the query and the grid construction happen behind that
         * spinner. This is the "component does not exist yet" case in
         * `ProgressSpinner`'s loading-affordance docs.
         *
         * A Data tab already exists: refreshing it through the same lazy-tab path
         * would add a *second* "Data" tab and only remove the old one once the fetch
         * resolves — two Data tabs on screen for the whole round trip, not just a
         * frame. Since the component already exists here, this is instead the
         * "data is pending" case in the same docs, and is delegated to
         * `refreshExistingDataTab`, which overlays a spinner on the existing tab
         * in place with no tab-list change at all.
         *
         * Either way, the prior Data tab's content (if any) is left completely alone
         * until the new fetch is confirmed to hold rows: neither a fetch error nor a
         * non-rows result on a re-run ever destroys a Data tab that already held good
         * rows. The factory/overlay awaits the SAME promise `run()` itself is
         * awaiting, so this is one network round trip, not two.
         *
         * Ctrl/Cmd+Enter can fire this a second time before the first call's fetch
         * has settled (the Run button disables mid-run, but the shortcut doesn't
         * check it) — see `liveTabCount`'s doc comment for how the no-existing-tab
         * path stays correct under that race, and `refreshExistingDataTab`'s for how
         * the existing-tab path does.
         *
         * @param resultPromise - The in-flight `runQuery(sql)` call this run started.
         * @param seq - This run's `runSeq` snapshot, re-checked once the fetch resolves.
         */
        function refreshDataTab(resultPromise: Promise<QueryResult>, seq: number): void {
            ensureResultPaneShown();

            if (dataSlot) {
                refreshExistingDataTab(dataSlot.content, resultPromise, seq);

                return;
            }

            const insertIndex = liveTabCount() + pendingDataTabs;

            pendingDataTabs++;

            resultHost.addTab(async () => {
                try {
                    const result = await resultPromise;

                    if (seq !== runSeq) {
                        // Superseded by a newer run before this one resolved. Touch
                        // nothing — a newer run may already have installed its own
                        // dataSlot, and this attempt's own tab is about to be torn
                        // down by the library's normal lazy-tab failure path.
                        throw new Error("superseded by a newer run");
                    }

                    if (result.kind !== "rows") {
                        // Matches the file's existing rule (see the header comment): a
                        // command-tag/DDL result drops the Data tab, leaving any Chart/
                        // Explain tab. This attempt's own (still-spinning) tab is torn
                        // down too, by the throw below.
                        syncChartButton();
                        throw new Error("statement returned no rows");
                    }

                    const grid = new QueryResultGrid(result);

                    // No prior Data tab existed — that's why this branch ran instead
                    // of refreshExistingDataTab — so there is nothing else to remove
                    // and no selection to reconcile here.
                    dataSlot = { content: grid.content, result };
                    syncChartButton();

                    return grid.content;
                } finally {
                    // Settled (built or torn down) either way — no longer pending.
                    pendingDataTabs--;
                }
            }, "Data", { glyph: "table" });

            tab.setActiveTabIndex(insertIndex);

            // Selecting a tab moves DOM focus to its strip button (the roving tab
            // index); reclaim it for the editor once the freshly-added tab's cell
            // exists (next layout), so the "run, tweak, re-run" loop keeps working
            // without waiting for the fetch. Runs on every call, including one later
            // found stale — the keystroke that triggered it is real either way.
            Component.afterNextLayout(() => editor.focus());
        }

        /**
         * Refresh an already-existing Data tab in place. See `refreshDataTab`'s doc
         * comment for why this exists as a separate path: the lazy-tab path used when
         * no Data tab exists yet would show two "Data" tabs for the whole fetch if
         * reused here, since the old one can't safely be removed until the new fetch
         * is confirmed to hold rows.
         *
         * The tab is selected immediately, matching a first run's "jump to Data on
         * Run" behaviour, and DOM focus is reclaimed for the editor the same way.
         * The overlay is torn down and the swap performed synchronously the instant
         * the shared fetch settles, so a re-run never shows two Data tabs — not even
         * for a single frame.
         *
         * Ctrl/Cmd+Enter firing this a second time before the first call's fetch has
         * settled shows two overlays stacked on the same tab briefly (harmless — the
         * second is just a visual no-op on top of the first). Only the run that is
         * still current (`seq === runSeq`) when its fetch resolves performs the swap;
         * a superseded one just clears its own overlay and leaves the tab alone,
         * exactly as a superseded no-existing-tab run discards itself via the same
         * check.
         *
         * @param oldContent - The existing Data tab's content component to overlay.
         * @param resultPromise - The in-flight `runQuery(sql)` call this run started.
         * @param seq - This run's `runSeq` snapshot, re-checked once the fetch resolves.
         */
        function refreshExistingDataTab(oldContent: Component, resultPromise: Promise<QueryResult>, seq: number): void {
            tab.setActiveContent(oldContent);
            Component.afterNextLayout(() => editor.focus());

            const overlay = new ProgressSpinner(DATA_TAB_OVERLAY_SPINNER_SIZE);
            overlay.showOverlay(oldContent);

            void resultPromise.then(
                result => {
                    overlay.hideOverlay();

                    if (seq !== runSeq) {
                        // Superseded by a newer run before this one resolved — that
                        // run owns the tab now (its own overlay, or its own swap,
                        // already in flight or done). Touch nothing.
                        return;
                    }

                    if (result.kind !== "rows") {
                        // Matches the file's existing rule (see the header comment): a
                        // command-tag/DDL result drops the Data tab, leaving any
                        // Chart/Explain tab.
                        removeDataTab();
                        syncChartButton();

                        return;
                    }

                    const grid = new QueryResultGrid(result);

                    // Capture this BEFORE removeDataTab() below, which is the only
                    // thing here that can move tab selection: if the user clicked
                    // away from the Data tab while this fetch was in flight (nothing
                    // disables the tab strip mid-run, only the toolbar buttons),
                    // removing it moves selection to its left neighbor via the
                    // library's own reselection (Tab.selectNextContent) — a
                    // *different* tab is active, and the export must follow it, not
                    // stay pinned to the rows that tab is about to lose.
                    const oldDataTabWasActive = tab.getActiveContent() === oldContent;

                    swapTab(grid.content, "Data", { glyph: "table" }, removeDataTab);

                    dataSlot = { content: grid.content, result };
                    syncChartButton();

                    if (oldDataTabWasActive) {
                        // setActiveContent moves DOM focus to the new tab's strip
                        // button (roving focus), same as the synchronous select at
                        // this function's top — reclaim it for the editor the same
                        // way once the swapped-in tab's cell exists (next layout).
                        tab.setActiveContent(grid.content);
                        Component.afterNextLayout(() => editor.focus());
                    }
                },
                () => {
                    // run()'s own catch handles the error banner/toast; just clear
                    // the overlay and leave the last good grid in place — a failed
                    // re-run never destroys a Data tab that already held good rows.
                    overlay.hideOverlay();
                },
            );
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
            swapTab(nextChart.content, "Chart", { closeable: true, glyph: "chart-simple" }, removeChartTab);

            chartSlot = { content: nextChart.content, result };

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
         * The status-bar line for a completed run: row count (or a truncation note)
         * for a rows result, else the command tag (or "OK" when the backend gives none).
         */
        function resultStatusMessage(result: QueryResult): string {
            if (result.kind === "rows") {
                return result.truncated
                    ? `showing first ${result.rowCount} rows — result truncated`
                    : `${result.rowCount} row(s)`;
            }

            return result.kind === "status" ? result.command || "OK" : "OK";
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
            swapTab(editor, "Explain", { closeable: true, glyph: "diagram-project" }, removeExplainTab);

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

        // Focus the editor so the user can type on a fresh tab straight away, with
        // the caret at the end of the text — so a panel opened over an existing
        // query (the "Open query" path seeds it) lands ready to continue typing
        // rather than at the top. The panel content is built before the Dock mounts
        // it, so the element may not exist yet — onFirstLayout runs once the editor
        // has been mounted and laid out, when it can take focus and place the caret
        // (and never fires for a tab closed before it mounts).
        editor.onFirstLayout(() => {
            editor.focus();
            editor.moveCursorToEnd();
        });

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
    }
}

