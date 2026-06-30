// A Dock work panel for arbitrary SQL: a multi-line editor over a result grid.
// The editor runs on the Run toolbar button or Ctrl/Cmd+Enter. Until a query is
// executed, the editor fills the panel and no result grid is shown. A rows
// result renders in a fresh MemoryStore-backed Table below a 150px editor (the
// editor shrinks to its preferred height so the grid gets the rest); the result
// is read-only (a query result has no PK and is never written back). A non-row
// statement (INSERT/UPDATE/DDL) reports its command tag on the status line and
// clears any prior grid. Errors funnel to the injected onError sink.
//
// Built as a callable factory mirroring TableWorkPanel/StructurePanel. The panel
// is self-contained: the controller holds no reference back to it, so closing
// the dock tab disposes the subtree and the MemoryStore is collected.

import { Component, Panel }              from "@jimka/typescript-ui/core";
import { Placement }                     from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit }   from "@jimka/typescript-ui/layout";
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

// The editor's height once a result grid is shown below it (it fills the panel
// until then). Border's NORTH region takes the child's preferred height.
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

/** Build a query panel: a SQL editor over a swappable result grid. */
export function QueryPanel(options: QueryPanelOptions): Panel {
    const { runQuery, notify, onError, initialSql = "", autoRun = false } = options;

    const editor = new TextArea();

    // Set the seed via the setter, NOT the positional constructor text: the
    // constructor text lands in _defaultOptions, which getValue()/render() don't
    // consult, so it would be silently dropped. setValue writes _options.text.
    if (initialSql) {
        editor.setValue(initialSql);
    }

    // Width is ignored for a Border NORTH child (it fills the region); only the
    // preferred height matters, and only once the editor sits above a result.
    editor.setPreferredSize(0, EDITOR_HEIGHT);

    const runButton = glyphButton("play", RUN_COLOR, "Run (Ctrl+Enter)", () => void run());

    // The CENTER body: editor alone (filling) until a rows result, then editor
    // (NORTH, 150px) over the result grid (CENTER).
    const body = new Component();

    showEditorOnly();

    const panel = Panel({ layoutManager: new BorderLayout() });
    panel.addComponent(new ToolBar({ components: [runButton] }), { placement: Placement.NORTH });
    panel.addComponent(body, { placement: Placement.CENTER });

    /** Editor fills the whole body; no result grid shown (the pre-execution state). */
    function showEditorOnly(): void {
        body.removeAllComponents();
        body.setLayoutManager(new Fit());
        body.addComponent(editor);
        body.doLayout();
    }

    /** Editor shrinks to its preferred height (NORTH); the grid fills the rest. */
    function showEditorWithResult(table: Component): void {
        body.removeAllComponents();
        body.setLayoutManager(new BorderLayout());
        body.addComponent(editor, { placement: Placement.NORTH });
        body.addComponent(table, { placement: Placement.CENTER });
        body.doLayout();
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
            showEditorWithResult(Table(store, { columns: [], rowReadOnly: () => true }));
            notify(`${result.rowCount} row(s)`);
        } else {
            // No result set (INSERT/UPDATE/DDL): clear any prior grid, editor fills.
            showEditorOnly();
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
