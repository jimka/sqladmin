// The reusable DDL form + editable-SQL-preview + Cancel/Execute dialog every
// DDL phase embeds its structured form into. Flow: form -> generateSql()
// seeds an editable SQL preview -> the user optionally edits it -> Execute
// runs the (possibly edited) SQL, never a spec re-compiled at confirm time —
// the previewed text is authoritative at execute (see
// plans/implemented/ddl-infrastructure.md's "editable preview is
// authoritative" decision). A "Regenerate SQL" button re-runs generateSql(),
// discarding any manual edit; infra otherwise only seeds once, on open.
//
// Execute is a show/retry loop, not a one-shot resolve: a failed execute must
// leave the dialog open with the SQL intact for a retry/edit, the same shape
// showLoginDialog uses to re-prompt after a failed login (see
// shell/LoginDialog.ts). Dialog now owns its content's recursive teardown the
// same way Dock owns a tab's (see
// plans/implemented/adopt-dock-owned-teardown.md): hide() destructs the
// Dialog instance before show()'s promise resolves, so a retry cannot re-show
// the same instance. RetainedContentDialog rescues the persistent content
// (the phase's form + the editor) from that teardown by detaching it one step
// earlier, in its own destructor() override, mirroring QueryPanelContent's
// destructor() override in dock/QueryPanel.ts; the rescued content is then
// re-wrapped in a fresh Dialog for the retry, so the form's and the editor's
// own state (and the Component objects themselves) survive. showExecuteRetryLoop's
// caller disposes content itself, once, when the loop concludes.
//
// The Dialog exposes only three result codes ("confirm" | "cancel" | "close"),
// and every dismiss gesture (Escape, backdrop, the always-present title-bar
// close) resolves to "close". So: Execute = "confirm" (primary), Cancel =
// "close" (shares the dismiss code, so dismissing == Cancel == do nothing).

import { Panel }                   from "@jimka/typescript-ui/core";
import type { Component }          from "@jimka/typescript-ui/core";
import { VBox }                    from "@jimka/typescript-ui/layout";
import { Button }                  from "@jimka/typescript-ui/component/button";
import { CodeEditor }              from "@jimka/typescript-ui/component/editor";
import { Dialog, Notification }    from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig, DialogConfig } from "@jimka/typescript-ui/overlay";
import type { QueryStatusResult }  from "../contract";

// A comfortable modal width for a structured DDL form plus the SQL preview
// editor beneath it — a bit wider than this app's narrower dialogs (~500px)
// to give the SQL editor room to breathe.
const DEFAULT_DIALOG_WIDTH = 560;

// The editor's placeholder height for the one layout pass before it has
// mounted and measured its own content (see plans/align-with-library-post-0.4.1.md's
// "autoHeightMaxRows takes over from preferredSize" decision). Cleared via
// clearPreferredSize() on the editor's first "heightchange", after which the
// editor's own live height drives its preferred size instead — keeping this
// as a permanent preferredSize would fight autoHeightMaxRows on every later
// relayout, snapping the editor back to this fixed number.
const EDITOR_SEED_HEIGHT = 180;

// Row cap CodeEditor's autoHeightMaxRows grows the preview to before its own
// scrollbar takes over. Sized to this app's own "wide table" DDL shape: a
// generated CREATE TABLE is one line per column plus an opening/closing paren
// line (backend/app/sql/ddl.py's create_table), and wide.cols_20 (this app's
// standard many-column fixture, see LIBRARY_NOTES.md) is 22 such lines; 24
// leaves headroom for a trailing clause without immediately scrolling.
const SQL_PREVIEW_MAX_ROWS = 24;

// Vertical gap between the form, the "Regenerate SQL" row, and the editor —
// the same order of magnitude as this app's other dialog content spacing,
// for a consistent dialog rhythm.
const CONTENT_SPACING = 8;

/** Options for {@link openSqlPreviewDialog}. */
export interface SqlPreviewDialogOptions {
    /** Dialog title, e.g. "Create table". */
    title: string;

    /** The phase's structured form, hosted above the SQL preview editor. */
    form: Component;

    /**
     * Generate the SQL for the form's current state (the phase's preview
     * call). Rejections surface in the dialog; the editor is left as-is.
     */
    generateSql: () => Promise<string>;

    /** Execute the (possibly edited) SQL from the editor. Resolves the status. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /** Called after a successful execute so the caller can refresh + report. */
    onSuccess: (result: QueryStatusResult) => void;

    /** Report an execute/preview error. Defaults to a Notification if omitted. */
    onError?: (message: string) => void;

    /** Dialog panel width in pixels. Defaults to {@link DEFAULT_DIALOG_WIDTH}. */
    width?: number;
}

// Execute takes "confirm" (primary); Cancel shares "close" with every dismiss
// gesture, so dismissing behaves exactly like Cancel — no third result code
// is needed.
const EXECUTE_BUTTON: DialogButtonConfig = { text: "Execute", result: "confirm", primary: true };

/** Cancel button — shares "close" with every dismiss gesture. */
const CANCEL_BUTTON: DialogButtonConfig = { text: "Cancel", result: "close" };

/**
 * Open the shared DDL preview/confirm dialog: seed the SQL editor from
 * `generateSql()`, then run the show/execute/retry loop until the user
 * cancels or an execute succeeds.
 *
 * @param options - the phase's form, SQL generator, and execute/callbacks.
 */
export function openSqlPreviewDialog(options: SqlPreviewDialogOptions): void {
    void runSqlPreviewDialog(options);
}

/**
 * Build the dialog's content, seed the preview, and run the loop. Kept
 * separate from {@link openSqlPreviewDialog} so the public entry point stays
 * synchronous (void) — this app's open/run dialog split.
 *
 * @param options - the phase's form, SQL generator, and execute/callbacks.
 */
async function runSqlPreviewDialog(options: SqlPreviewDialogOptions): Promise<void> {
    // Re-fit hook for the current Dialog. Wired to a real dialog only once
    // showExecuteRetryLoop builds one — needed because the editor (and its
    // "heightchange" listener) is built before any Dialog exists, and
    // showExecuteRetryLoop rebuilds `dialog` again on every failed-execute retry.
    const resizer = { fit: () => {} };

    const editor = new CodeEditor("", {
        language:          "sql",
        autoHeightMaxRows: SQL_PREVIEW_MAX_ROWS,
        preferredSize:     { width: 0, height: EDITOR_SEED_HEIGHT },
    });

    // Once the editor has real measured content — first mount, and every
    // "Regenerate SQL"/manual edit that changes its row count after — drop the
    // seed preferredSize constraint (see EDITOR_SEED_HEIGHT's comment above)
    // and re-fit the current dialog to the new height (Dialog does not do
    // this on its own past its one-time post-open resizeToContent()).
    editor.on("heightchange", () => {
        editor.clearPreferredSize();
        resizer.fit();
    });

    const regenerateButton = Button({ text: "Regenerate SQL", compact: true });
    regenerateButton.on("action", () => void refreshPreview(editor, options));

    const content = Panel({
        layoutManager: VBox({ itemAlign: "stretch", spacing: CONTENT_SPACING }),
        components:    [options.form, regenerateButton, editor],
    });

    try {
        await refreshPreview(editor, options);
        await showExecuteRetryLoop(content, editor, options, resizer);
    } finally {
        // RetainedContentDialog detaches `content` from every dialog it
        // wraps instead of letting the base class's owned teardown dispose
        // it (see showExecuteRetryLoop's doc comment), so this is the one
        // place that disposes it — exactly once, on every exit path.
        // Cascades to editor, the "Regenerate SQL" button, and
        // options.form, since all three are still its registered children.
        content.dispose();
    }
}

/**
 * Regenerate the preview SQL from the form's current state and load it into
 * the editor. A rejection is reported (via `onError`/Notification) and leaves
 * the editor's current text untouched.
 *
 * @param editor - the preview editor to load the generated SQL into.
 * @param options - carries `generateSql` and the error reporter.
 */
async function refreshPreview(editor: CodeEditor, options: SqlPreviewDialogOptions): Promise<void> {
    try {
        editor.setValue(await options.generateSql());
    } catch (err) {
        reportError(err, options.onError);
    }
}

/**
 * Show the dialog and, on Execute, run it; a failed execute reports the
 * error and re-shows a fresh dialog wrapping the same, still-live content
 * — so the form and the SQL text survive the retry. Every dialog built
 * here is a RetainedContentDialog, which detaches `content` from itself
 * before its own teardown can reach it, so `content` is never disposed as
 * a side effect of hide() — the caller disposes it once this resolves.
 * Returns once the user cancels/dismisses or an execute succeeds.
 *
 * @param content - the persistent form + editor content, reused across
 *     retries and disposed by the caller once this resolves.
 * @param editor - the preview editor executed SQL is read from.
 * @param options - carries `execute`, `onSuccess`, and the error reporter.
 * @param resizer - rewired to the current Dialog on every build, so the
 *     editor's "heightchange" listener always re-fits the live dialog even
 *     after a failed-execute retry rebuilds it.
 */
async function showExecuteRetryLoop(
    content: Component,
    editor: CodeEditor,
    options: SqlPreviewDialogOptions,
    resizer: { fit: () => void },
): Promise<void> {
    let dialog = buildDialog(content, options);
    resizer.fit = () => dialog.resizeToContent();

    for (;;) {
        const result = await dialog.show();

        if (result !== "confirm") {
            return; // Cancel, or any dismiss gesture — do nothing.
        }

        try {
            const status = await options.execute(editor.getValue());

            options.onSuccess(status);

            return;
        } catch (err) {
            reportError(err, options.onError);

            // RetainedContentDialog already detached `content` from the spent
            // dialog during its own teardown (see its class doc) — content
            // survived and is ready to re-wrap in a fresh dialog for the retry.
            dialog = buildDialog(content, options);
            resizer.fit = () => dialog.resizeToContent();
        }
    }
}

/**
 * A Dialog that keeps `content` alive across the base class's owned-teardown
 * recursion, by detaching it in `destructor()` before `super.destructor()`
 * runs. Every dialog `buildDialog` constructs is one of these, so
 * `showExecuteRetryLoop` can pull `content` out of a spent dialog and
 * re-wrap it in a fresh one on a failed-execute retry, and the form's and
 * editor's own state survive. `content` is never disposed here — the loop
 * that owns it disposes it exactly once, when it actually concludes.
 */
class RetainedContentDialog extends Dialog {
    private readonly _content: Component;

    /**
     * @param content - The persistent form + editor content this dialog
     *     wraps; detached, not disposed, on teardown. Must be the same
     *     component passed as `config.contentComponent`.
     * @param config - The Dialog configuration.
     */
    constructor(content: Component, config: DialogConfig) {
        super(config);

        this._content = content;
    }

    protected destructor(): void {
        this.getContentComponent().removeComponent(this._content);

        super.destructor();
    }
}

/**
 * Build the Cancel/Execute dialog wrapping `content`.
 *
 * @param content - the form + editor content to host.
 * @param options - carries the title and width.
 */
function buildDialog(content: Component, options: SqlPreviewDialogOptions): Dialog {
    return new RetainedContentDialog(content, {
        title:            options.title,
        contentComponent: content,
        buttons:          [CANCEL_BUTTON, EXECUTE_BUTTON],
        width:            options.width ?? DEFAULT_DIALOG_WIDTH,
    });
}

/**
 * Report an error through the caller's `onError`, or a Notification when none
 * was given.
 *
 * @param err - the caught error (an `Error`, or an arbitrary thrown value).
 * @param onError - the caller's reporter, or undefined for the default.
 */
function reportError(err: unknown, onError: ((message: string) => void) | undefined): void {
    const message = err instanceof Error ? err.message : String(err);

    if (onError) {
        onError(message);

        return;
    }

    Notification.show(message, "error");
}
