// A Dock work panel for arbitrary SQL: a multi-line editor over a result grid.
// The editor runs on the Run toolbar button or Ctrl/Cmd+Enter. Until a query is
// executed, the editor fills the panel and no result grid is shown. A rows
// result adds a resizable result pane below the editor (a draggable Split
// gutter), seeded so the editor starts ~150px tall; the result is read-only (a
// query result has no PK and is never written back). A non-row statement
// (INSERT/UPDATE/DDL) reports its command tag on the status line and removes the
// result pane (editor back to full height). Errors funnel to onError.
//
// Two more toolbar buttons run EXPLAIN and EXPLAIN ANALYZE on the editor's
// statement: the plan comes back through the same result pane as a read-only
// monospace text block. Explain Analyze executes the statement (the backend
// rolls it back), so the frontend blocks it for a statement that does not look
// read-only — plain Explain is always safe.
//
// Built as a callable factory mirroring TableWorkPanel/StructurePanel. The panel
// is self-contained: the controller holds no reference back to it, so closing
// the dock tab disposes the subtree and the MemoryStore is collected.

import { Component, Container, Panel }              from "@jimka/typescript-ui/core";
import { Placement }                     from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit, Split } from "@jimka/typescript-ui/layout";
import { ToolBar }                       from "@jimka/typescript-ui/component/menubar";
import { Spacer }                        from "@jimka/typescript-ui/component/container";
import { glyphButton }                   from "./glyphButton";
import { Table }                         from "@jimka/typescript-ui/component/table";
import { TextArea }                      from "@jimka/typescript-ui/component/input";
import { MemoryStore }                   from "@jimka/typescript-ui/data";
import { Menu }                          from "@jimka/typescript-ui/overlay";
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
import { buildQueryModel }               from "../data/buildModel";
import { HistoryCursor }                 from "../data/historyCursor";
import { isReadOnlyStatement }           from "../data/explain";
import { exportQueryResult }             from "./exportQueryResult";
import { exportExplainPlan }             from "./exportExplainResult";
import type { ActiveExport, RunExplain } from "../data/explain";
import type { HistoryEntry }             from "../data/queryStore";
import { isExplainChord, isExplainAnalyzeChord } from "../shell/queryShortcuts";
import type { QueryExplainResult, QueryResult } from "../contract";
import { PRIMARY_COLOR, CONSTRUCTIVE_COLOR, CAUTION_COLOR, HISTORY_COLOR, NEUTRAL_COLOR } from "../theme";

Glyph.register(play, eraser, floppy_disk, angle_up, angle_down, file_export, file_csv, file_code, file_lines, diagram_project, flask);

// Inline style for the read-only plan view: a monospace face with preserved
// whitespace so EXPLAIN's indented tree lines up and long lines scroll rather
// than wrap. Applied via the suffix-"" style rule (targets the element itself).
const PLAN_STYLE: Record<string, string> = { "font-family": "monospace", "white-space": "pre" };

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
}

/** Build a query panel: a SQL editor over a (resizable) result grid. */
export function QueryPanel(options: QueryPanelOptions): Container {
    const { runQuery, runExplain, notify, onError, initialSql = "", autoRun = false, autoExplain, onRun, getHistory, onSave, onResult } = options;

    const editor = new TextArea(initialSql);

    const resultHost = Panel({ layoutManager: new Fit() });

    // The body is a vertical Split: the editor alone (filling) until a query
    // runs, then editor over the result pane with a draggable gutter between.
    const split = new Split({ orientation: "vertical" });
    const body  = new Component();
    body.setLayoutManager(split);
    // weight 0 pins the editor's height on a vertical viewport/panel resize — the
    // result grid below absorbs the change instead. A gutter-drag still resizes
    // the editor. (While the editor is the only pane it fills regardless: with no
    // positive-weight sibling the split falls back to filling the container.)
    body.addComponent(editor, { weight: 0 });

    const runButton     = glyphButton("play", CONSTRUCTIVE_COLOR, "Run (Ctrl+Enter)", () => void run());
    const saveButton    = glyphButton("floppy-disk", PRIMARY_COLOR, "Save query (Ctrl+S)", () => save());
    const clearButton   = glyphButton("eraser", CAUTION_COLOR, "Clear (Alt+C)", () => clear());
    // The glyph registers under its hyphenated name ("diagram-project"), even
    // though the ESM export identifier uses an underscore.
    const explainButton = glyphButton("diagram-project", NEUTRAL_COLOR, "Explain (Ctrl+E)",
                                      () => void runExplainRun(false));
    const analyzeButton = glyphButton("flask", CAUTION_COLOR, "Explain Analyze (Ctrl+Shift+E)\n\nexecutes the statement",
                                      () => void runExplainRun(true));
    const exportButton  = glyphButton("file-export", PRIMARY_COLOR, "Export results (CSV / JSON)", (e: MouseEvent) => openExportMenu(e));

    // The CSV/JSON chooser shown under the Export button; reused across clicks.
    const exportMenu = Menu();

    // History recall as toolbar buttons, mirroring the editor's Ctrl+↑/↓: Older
    // walks back, Newer forward. Pushed to the far right by a flexible Spacer,
    // set apart from the left-aligned Run/Save/Clear/Explain/Export actions. Each
    // recall refocuses the editor so keyboard recall / typing continues seamlessly.
    const olderButton = glyphButton("angle-up", HISTORY_COLOR, "Older query (Ctrl+↑)", () => recallInEditor(true));
    const newerButton = glyphButton("angle-down", HISTORY_COLOR, "Newer query (Ctrl+↓)", () => recallInEditor(false));

    const panel = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
    panel.addComponent(new ToolBar({
        components: [runButton, saveButton, clearButton, explainButton, analyzeButton, exportButton, Spacer.flex(), olderButton, newerButton],
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

    /**
     * Open the export chooser at the click point, serializing whatever the panel
     * currently shows: a rows grid as CSV / JSON, or an EXPLAIN plan as text /
     * JSON. A no-op when there is nothing to export (the button is disabled then,
     * so this is defensive).
     *
     * @param event - The Export button's click, for the menu's placement.
     */
    function openExportMenu(event: MouseEvent): void {
        if (!activeExport) {
            return;
        }

        const active = activeExport;
        const items = active.kind === "rows"
            ? [
                { text: "Export CSV (.csv)",   glyph: "file-csv",  action: () => exportQueryResult(active.result, "csv", notify) },
                { text: "Export JSON (.json)", glyph: "file-code", action: () => exportQueryResult(active.result, "json", notify) },
            ]
            : [
                { text: "Export text (.txt)",  glyph: "file-lines", action: () => void exportExplainPlan(active.plan, "txt", notify) },
                { text: "Export JSON (.json)", glyph: "file-code",  action: () => void exportExplainPlan(active.plan, "json", notify) },
            ];

        exportMenu.show(event.clientX, event.clientY, items);
    }

    /** Swap in the result grid, adding (and sizing) the result pane on first use. */
    function showResultPane(table: Component): void {
        resultHost.removeAllComponents();
        resultHost.addComponent(table);

        if (!resultShown) {
            body.addComponent(resultHost);
            resultShown = true;
            seedEditorHeight(0);
        }

        body.doLayout();
        syncToolbarButtons();
    }

    // Split the body so the editor starts at EDITOR_HEIGHT and the grid gets the
    // rest; the gutter then lets the user resize (and subsequent runs keep that
    // position — the pane is reused, only its table content swaps). setPaneSize
    // takes px, so we need the body's inner height. On the "Open as query"
    // auto-run that height isn't known yet (the panel runs before its first
    // rAF-scheduled layout), so retry on the next frame until the body is laid
    // out, capped so a panel closed mid-wait can't loop forever.
    function seedEditorHeight(attempt: number): void {
        const full = body.getInnerSize()?.height ?? 0;

        if (full > EDITOR_HEIGHT) {
            split.setPaneSize(editor, EDITOR_HEIGHT);
            split.setPaneSize(resultHost, full - EDITOR_HEIGHT);
            body.doLayout();
        } else if (attempt < 30 && body.getElement()) {
            requestAnimationFrame(() => seedEditorHeight(attempt + 1));
        }
    }

    /** Drop the result pane so the editor fills the panel again. */
    function hideResultPane(): void {
        if (resultShown) {
            body.removeComponent(resultHost);
            resultShown = false;
            body.doLayout();
        }

        syncToolbarButtons();
    }

    /** Reset the panel to its initial state: empty editor, no result pane. */
    function clear(): void {
        editor.setValue("");
        hideResultPane();
        setActiveExport(null);
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

    // Keep the input-dependent toolbar buttons in step with the editor's state.
    // Clear is meaningful when there is something to reset (text or a result on
    // screen); Save is meaningful only with SQL to save. (setValue/setText don't
    // fire "change", so mutators re-sync through here.)
    function syncToolbarButtons(): void {
        const hasSql = editor.getValue().trim() !== "";

        clearButton.setEnabled(hasSql || resultShown);
        saveButton.setEnabled(onSave !== undefined && hasSql);
    }

    // Monotonic guard: a slow run whose result arrives after a newer run started
    // is discarded so it can't clobber the newer one (mirrors showProperties's
    // _propsSeq). Run and Explain share the counter so a slow explain can't clobber
    // a newer run (or vice versa), and all action buttons disable while one is
    // in flight.
    let runSeq = 0;

    /** Disable (or re-enable) the run/explain action buttons around an in-flight run. */
    function setBusy(busy: boolean): void {
        runButton.setEnabled(!busy);
        explainButton.setEnabled(!busy);
        analyzeButton.setEnabled(!busy);
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
            // The library's Table virtual-scrolls its rows, so the full result set
            // renders regardless of size — no display cap. (The backend fetch is
            // itself unbounded; a LIMIT belongs there, not here.)
            const store = new MemoryStore({
                model   : buildQueryModel(result.columns),
                data    : result.rows,
                autoLoad: true,
            });

            // Read-only: editing a query result is a Non-Goal (no PK, no write-back).
            // A fresh store + columns per run means columns never bleed across runs.
            showResultPane(Table(store, { columns: [], rowReadOnly: () => true }));
            setActiveExport({ kind: "rows", result });
            notify(`${result.rowCount} row(s)`);

            return;
        }

        // No result set (INSERT/UPDATE/DDL): drop the grid, editor fills again.
        // (An explain result never reaches here — runExplainRun routes it to
        // showPlan directly, which needs the source SQL this path lacks.)
        hideResultPane();
        setActiveExport(null);
        notify(result.kind === "status" ? result.command || "OK" : "OK");
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
        // Reuse the same result pane/gutter as a rows Table — just different
        // content: a read-only TextArea seeded with the joined plan text. Read-only
        // (not disabled) keeps the plan selectable and copyable while blocking edits.
        const view = new TextArea(result.plan, { styleRules: [{ suffix: "", styles: PLAN_STYLE }] });

        view.setReadOnly(true);
        showResultPane(view);
        setActiveExport({ kind: "plan", plan: { result, sql, runExplain } });
        notify(result.analyze ? "EXPLAIN ANALYZE plan (side-effects rolled back)" : "EXPLAIN plan");
    }

    // Editor accelerators, all wired through the editor's own typed keydown
    // surface: Ctrl/Cmd+Enter runs, Ctrl/Cmd+S saves, Ctrl/Cmd+E explains
    // (Ctrl/Cmd+Shift+E explain-analyzes), Alt+C clears, Ctrl/Cmd+↑/↓ recalls
    // history (bash-style). Editor-scoped so Explain acts on this query view and
    // does not clash with the list/editor select-all elsewhere. Plain arrows (no
    // modifier) are untouched, so normal caret movement still works — and Clear is
    // Alt+C, not Ctrl+C, so the editor's Copy is left intact.
    editor.on("keydown", (e: KeyboardEvent) => {
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
    // types. Use "action" (the input-event shorthand), registered after the
    // editor's own onInput, so getValue() already reflects the new text — the
    // "change" bridge fires before onInput and would read the stale value.
    editor.on("action", () => syncToolbarButtons());

    /** Focus the editor once it has mounted, retrying across frames until then. */
    function focusEditorWhenReady(attempt: number): void {
        if (editor.getElement()) {
            editor.focus();
        } else if (attempt < 30) {
            requestAnimationFrame(() => focusEditorWhenReady(attempt + 1));
        }
    }

    // Initial state: Run/Save/Clear disabled for an empty panel (enabled when
    // seeded); Export disabled until a rows result is shown.
    syncToolbarButtons();
    exportButton.setEnabled(false);

    // Focus the editor so the user can type on a fresh tab straight away. The
    // panel content is built before the Dock mounts it, so the element may not
    // exist yet — retry on the next frame until it does (capped so a tab closed
    // mid-wait can't loop forever).
    focusEditorWhenReady(0);

    if (autoExplain && initialSql.trim()) {
        void runExplainRun(autoExplain === "analyze");
    } else if (autoRun && initialSql.trim()) {
        void run();
    }

    return panel;
}

