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
import { Button }                        from "@jimka/typescript-ui/component/button";
import { Table }                         from "@jimka/typescript-ui/component/table";
import { TextArea }                      from "@jimka/typescript-ui/component/input";
import { MemoryStore }                   from "@jimka/typescript-ui/data";
import { Glyph }                         from "@jimka/typescript-ui/component/display";
import { play }                          from "@jimka/typescript-ui/glyphs/solid/play";
import { buildQueryModel }               from "../data/buildModel";
import type { QueryResult }              from "../contract";

Glyph.register(play);

// Green for the affirmative Run action, matching TableWorkPanel's add-action color.
const RUN_COLOR = "rgb(46, 125, 50)";

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
}

/** Build a query panel: a SQL editor over a (resizable) result grid. */
export function QueryPanel(options: QueryPanelOptions): Panel {
    const { runQuery, notify, onError, initialSql = "", autoRun = false } = options;

    const editor = new TextArea();

    // Seed via the setter, NOT the positional constructor text: that lands in
    // _defaultOptions (class defaults), which getValue()/render() never consult,
    // so it would be dropped. setValue writes the instance's _options.text.
    if (initialSql) {
        editor.setValue(initialSql);
    }

    const resultHost = Panel({ layoutManager: new Fit() });

    // The body is a vertical Split: the editor alone (filling) until a query
    // runs, then editor over the result pane with a draggable gutter between.
    const split = new Split({ orientation: "vertical" });
    const body  = new Component();
    body.setLayoutManager(split);
    body.addComponent(editor);

    const runButton = glyphButton("play", RUN_COLOR, "Run (Ctrl+Enter)", () => void run());

    const panel = Panel({ layoutManager: new BorderLayout() });
    panel.addComponent(new ToolBar({ components: [runButton] }), { placement: Placement.NORTH });
    panel.addComponent(body, { placement: Placement.CENTER });

    let resultShown = false;

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
    }

    // Monotonic guard: a slow run whose result arrives after a newer run started
    // is discarded so it can't clobber the newer one (mirrors showProperties's
    // _propsSeq). The Run button is disabled for the in-flight run.
    let runSeq = 0;

    async function run(): Promise<void> {
        const sql = editor.getValue().trim();

        if (!sql) {
            notify("Enter a SQL statement");

            return;
        }

        const seq = ++runSeq;
        runButton.setEnabled(false);
        notify("Running…");

        try {
            const result = await runQuery(sql);

            if (seq === runSeq) {
                showResult(result);
            }
        } catch (error) {
            if (seq === runSeq) {
                onError(error);
            }
        } finally {
            if (seq === runSeq) {
                runButton.setEnabled(true);
            }
        }
    }

    function showResult(result: QueryResult): void {
        if (result.kind === "rows") {
            const store = new MemoryStore({
                model   : buildQueryModel(result.columns),
                data    : result.rows,
                autoLoad: true,
            });

            // Read-only: editing a query result is a Non-Goal (no PK, no write-back).
            // A fresh store + columns per run means columns never bleed across runs.
            showResultPane(Table(store, { columns: [], rowReadOnly: () => true }));
            notify(`${result.rowCount} row(s)`);
        } else {
            // No result set (INSERT/UPDATE/DDL): drop the grid, editor fills again.
            hideResultPane();
            notify(result.command || "OK");
        }
    }

    // Ctrl/Cmd+Enter runs, wired through the editor's own typed keydown surface.
    editor.on("keydown", (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void run();
        }
    });

    if (autoRun && initialSql.trim()) {
        void run();
    }

    return panel;
}

/** A glyph-only toolbar button: colored icon, accessible label, click handler. */
function glyphButton(glyph: string, color: string, label: string, handler: () => void): Button {
    const button = Button({ glyph, foregroundColor: color, compact: true });

    button.getAria().setLabel(label);
    button.on("action", handler);

    return button;
}
