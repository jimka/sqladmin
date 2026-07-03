// A Dock work panel for arbitrary SQL: a multi-line editor over a result grid.
// The editor runs on the Run toolbar button or Ctrl/Cmd+Enter. Until a query is
// executed, the editor fills the panel and no result grid is shown. A rows
// result adds a resizable result pane below the editor (a draggable Split
// gutter), seeded so the editor starts ~150px tall; the result is read-only (a
// query result has no PK and is never written back). A non-row statement
// (INSERT/UPDATE/DDL) reports its command tag on the status line and removes the
// result pane (editor back to full height). Errors funnel to onError.
//
// Built as a callable factory mirroring TableWorkPanel/StructurePanel. The panel
// is self-contained: the controller holds no reference back to it, so closing
// the dock tab disposes the subtree and the MemoryStore is collected.

import { Component, Panel }              from "@jimka/typescript-ui/core";
import { Placement }                     from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit, Split } from "@jimka/typescript-ui/layout";
import { ToolBar }                       from "@jimka/typescript-ui/component/menubar";
import { Spacer }                        from "@jimka/typescript-ui/component/container";
import { Button }                        from "@jimka/typescript-ui/component/button";
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
import { buildQueryModel }               from "../data/buildModel";
import { HistoryCursor }                 from "../data/historyCursor";
import { capRows, MAX_RESULT_ROWS }      from "./capRows";
import { exportQueryResult }             from "./exportQueryResult";
import type { HistoryEntry }             from "../data/queryStore";
import type { QueryResult, QueryRowsResult } from "../contract";

Glyph.register(play, eraser, floppy_disk, angle_up, angle_down, file_export);

// Green for the affirmative Run action, matching TableWorkPanel's add-action color.
const RUN_COLOR = "rgb(46, 125, 50)";

// Blue for the neutral Save action — distinct from the green Run and amber
// Clear, reading as "persist this query" rather than "execute" or "discard".
const SAVE_COLOR = "rgb(21, 101, 192)";

// Amber for the Clear (reset) action — distinct from the green Run, signalling
// "discards your input" without the finality of a delete-red.
const CLEAR_COLOR = "rgb(204, 102, 0)";

// Neutral grey for the history-recall arrows — secondary navigation, kept
// visually quieter than the colored Run/Save/Clear actions.
const HISTORY_COLOR = "rgb(90, 90, 90)";

// Blue for the Export action — a neutral "read out" action, distinct from the
// green Run and amber Clear.
const EXPORT_COLOR = "rgb(21, 101, 192)";

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
    /** Reports row count / command tag / hint to the status bar. */
    notify: Notify;
    /** Surfaces a failed run (the controller's notifyError). */
    onError: (error: unknown) => void;
    /** Prefill the editor (the "Open as query" path seeds a generated SELECT). */
    initialSql?: string;
    /** Run the seeded SQL immediately on open (true for "Open as query"). */
    autoRun?: boolean;
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
     * Called whenever the displayed result changes: the rows result on a
     * successful SELECT/RETURNING, or null on a clear or a status-only result.
     * Lets the controller route the Query-menu "Export results…" item to this
     * (the active) panel without holding a reference back to it.
     */
    onResult?: (result: QueryRowsResult | null) => void;
}

/** Build a query panel: a SQL editor over a (resizable) result grid. */
export function QueryPanel(options: QueryPanelOptions): Panel {
    const { runQuery, notify, onError, initialSql = "", autoRun = false, onRun, getHistory, onSave, onResult } = options;

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

    const runButton    = glyphButton("play", RUN_COLOR, "Run (Ctrl+Enter)", () => void run());
    const saveButton   = glyphButton("floppy-disk", SAVE_COLOR, "Save query (Ctrl+S)", () => save());
    const clearButton  = glyphButton("eraser", CLEAR_COLOR, "Clear (Alt+C)", () => clear());
    const exportButton = glyphButton("file-export", EXPORT_COLOR, "Export results (CSV / JSON)", (e: MouseEvent) => openExportMenu(e));

    // The CSV/JSON chooser shown under the Export button; reused across clicks.
    const exportMenu = Menu();

    // History recall as toolbar buttons, mirroring the editor's Ctrl+↑/↓: Older
    // walks back, Newer forward. Pushed to the far right by a flexible Spacer,
    // set apart from the left-aligned Run/Save/Clear/Export actions. Each recall
    // refocuses the editor so keyboard recall / typing continues seamlessly.
    const olderButton = glyphButton("angle-up", HISTORY_COLOR, "Older query (Ctrl+↑)", () => recallInEditor(true));
    const newerButton = glyphButton("angle-down", HISTORY_COLOR, "Newer query (Ctrl+↓)", () => recallInEditor(false));

    const panel = Panel({ layoutManager: new BorderLayout() });
    panel.addComponent(new ToolBar({
        components: [runButton, saveButton, clearButton, exportButton, Spacer.flex(), olderButton, newerButton],
    }), { placement: Placement.NORTH });
    panel.addComponent(body, { placement: Placement.CENTER });

    let resultShown = false;

    // The panel's latest rows result, exposed to the controller via onResult and
    // serialized by the Export button. Null for an empty panel or a status-only
    // result; the Export button is enabled iff this is non-null.
    let currentResult: QueryRowsResult | null = null;

    /** Record the displayed result, mirror it to the controller, and sync Export. */
    function setCurrentResult(result: QueryRowsResult | null): void {
        currentResult = result;
        onResult?.(result);
        exportButton.setEnabled(result !== null);
    }

    /**
     * Open the CSV/JSON export chooser at the click point, exporting the panel's
     * held result. A no-op when there is no rows result (the button is disabled
     * then, so this is defensive).
     *
     * @param event - The Export button's click, for the menu's placement.
     */
    function openExportMenu(event: MouseEvent): void {
        if (!currentResult) {
            return;
        }

        const result = currentResult;
        exportMenu.show(event.clientX, event.clientY, [
            { text: "Export CSV",  action: () => exportQueryResult(result, "csv", notify) },
            { text: "Export JSON", action: () => exportQueryResult(result, "json", notify) },
        ]);
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
        setCurrentResult(null);
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
    // _propsSeq). The Run button is disabled for the in-flight run.
    let runSeq = 0;

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
        runButton.setEnabled(false);
        notify("Running…");

        try {
            const result = await runQuery(sql);

            if (seq === runSeq) {
                showResult(result);
                onRun?.({ sql, timestamp: Date.now(), ok: true, rowCount: result.rowCount });
            }
        } catch (error) {
            if (seq === runSeq) {
                onError(error);
                onRun?.({ sql, timestamp: Date.now(), ok: false, rowCount: 0 });
            }
        } finally {
            if (seq === runSeq) {
                runButton.setEnabled(true);
            }
        }
    }

    function showResult(result: QueryResult): void {
        if (result.kind === "rows") {
            // Defensive render cap: a large MemoryStore renders zero rows in the
            // library's Table (a known open bug — LIBRARY_NOTES.md), so a big query
            // would show an empty grid. Cap below that threshold and tell the user
            // the grid is partial (full pagination is a Non-Goal).
            const rows      = capRows(result.rows, MAX_RESULT_ROWS);
            const truncated = rows.length < result.rows.length;

            const store = new MemoryStore({
                model   : buildQueryModel(result.columns),
                data    : rows,
                autoLoad: true,
            });

            // Read-only: editing a query result is a Non-Goal (no PK, no write-back).
            // A fresh store + columns per run means columns never bleed across runs.
            showResultPane(Table(store, { columns: [], rowReadOnly: () => true }));
            setCurrentResult(result);
            notify(truncated
                ? `showing first ${rows.length} of ${result.rows.length} — results truncated`
                : `${result.rowCount} row(s)`);
        } else {
            // No result set (INSERT/UPDATE/DDL): drop the grid, editor fills again.
            hideResultPane();
            setCurrentResult(null);
            notify(result.command || "OK");
        }
    }

    // Editor accelerators, all wired through the editor's own typed keydown
    // surface: Ctrl/Cmd+Enter runs, Ctrl/Cmd+S saves, Alt+C clears, Ctrl/Cmd+↑/↓
    // recalls history (bash-style). Plain arrows (no modifier) are untouched, so
    // normal caret movement still works — and Clear is Alt+C, not Ctrl+C, so the
    // editor's Copy is left intact.
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

    if (autoRun && initialSql.trim()) {
        void run();
    }

    return panel;
}

/**
 * A glyph-only toolbar button: colored icon, hover tooltip + accessible name,
 * click handler. The handler receives the click's `MouseEvent` so an action that
 * opens a menu can position it at the click point (a `() => void` still binds,
 * ignoring the argument).
 */
function glyphButton(glyph: string, color: string, label: string, handler: (event: MouseEvent) => void): Button {
    // showText:false keeps the face glyph-only while the label drives both the
    // hover tooltip and the aria-label (accessible name) — no manual setLabel.
    const button = Button({ glyph, text: label, showText: false, foregroundColor: color, compact: true });

    button.on("action", handler);

    return button;
}
