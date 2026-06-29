// A Dock work panel for arbitrary SQL: a multi-line editor over a result grid.
// The editor runs on the Run toolbar button or Ctrl/Cmd+Enter. A rows result
// renders in a fresh MemoryStore-backed Table (read-only — a query result has
// no PK and is never written back); a non-row statement (INSERT/UPDATE/DDL)
// reports its command tag on the status line. Errors funnel to the injected
// onError sink (the controller's notifyError).
//
// Built as a callable factory mirroring TableWorkPanel/StructurePanel. The
// panel is intentionally self-contained: the controller holds no reference back
// to it, so closing the dock tab disposes the component subtree and the
// MemoryStore is collected — no controller-side disposal is needed.

import { Component, Panel }                   from "@jimka/typescript-ui/core";
import { Placement }                          from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Fit, Split } from "@jimka/typescript-ui/layout";
import { ToolBar }                            from "@jimka/typescript-ui/component/menubar";
import { Button }                             from "@jimka/typescript-ui/component/button";
import { Table }                              from "@jimka/typescript-ui/component/table";
import { TextArea }                           from "@jimka/typescript-ui/component/input";
import { MemoryStore }                        from "@jimka/typescript-ui/data";
import { Glyph }                              from "@jimka/typescript-ui/component/display";
import { play }                               from "@jimka/typescript-ui/glyphs/solid/play";
import { buildQueryModel }                    from "../data/buildModel";
import type { QueryResult }                   from "../contract";

Glyph.register(play);

// Green for the affirmative Run action, matching TableWorkPanel's add-action color.
const RUN_COLOR = "rgb(46, 125, 50)";

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

    const editor     = new TextArea(initialSql);
    const resultHost = Panel({ layoutManager: new Fit() });
    const runButton  = glyphButton("play", RUN_COLOR, "Run (Ctrl+Enter)", () => void run());

    // The CENTER body stacks the editor over the result host on a vertical split.
    const body = new Component();
    body.setLayoutManager(new Split({ orientation: "vertical" }));
    body.addComponent(editor);
    body.addComponent(resultHost);

    const panel = Panel({ layoutManager: new BorderLayout() });
    panel.addComponent(new ToolBar({ components: [runButton] }), { placement: Placement.NORTH });
    panel.addComponent(body, { placement: Placement.CENTER });

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
        // Rebuild the grid per run (fresh store + columns) so columns never
        // bleed across runs; a status result clears it.
        resultHost.removeAllComponents();

        if (result.kind === "rows") {
            const store = new MemoryStore({
                model   : buildQueryModel(result.columns),
                data    : result.rows,
                autoLoad: true,
            });

            // Read-only: editing a query result is a Non-Goal (no PK, no write-back).
            resultHost.addComponent(Table(store, { columns: [], rowReadOnly: () => true }));
            notify(`${result.rowCount} row(s)`);
        } else {
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
