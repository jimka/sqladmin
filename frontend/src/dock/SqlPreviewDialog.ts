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
// shell/LoginDialog.ts). Dialog.hide() destructs the Dialog instance on every
// dismissal, so a retry cannot re-show the same instance — it detaches the
// persistent content (the phase's form + the editor) from the spent dialog's
// content container and re-wraps it in a fresh Dialog instead, so the form's
// and the editor's own state (and the Component objects themselves) survive
// across retries.
//
// The Dialog exposes only three result codes ("confirm" | "cancel" | "close"),
// and every dismiss gesture (Escape, backdrop, the always-present title-bar
// close) resolves to "close". So: Execute = "confirm" (primary), Cancel =
// "close" (shares the dismiss code, so dismissing == Cancel == do nothing) —
// the same split FilterDialog uses.

import { Panel }                   from "@jimka/typescript-ui/core";
import type { Component }          from "@jimka/typescript-ui/core";
import { VBox }                    from "@jimka/typescript-ui/layout";
import { Button }                  from "@jimka/typescript-ui/component/button";
import { CodeEditor }              from "@jimka/typescript-ui/component/editor";
import { Dialog, Notification }    from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig } from "@jimka/typescript-ui/overlay";
import type { QueryStatusResult }  from "../contract";

// A comfortable modal width for a structured DDL form plus the SQL preview
// editor beneath it — the same order of magnitude as FilterDialog's
// DIALOG_WIDTH (500), a bit wider to give the SQL editor room to breathe.
const DEFAULT_DIALOG_WIDTH = 560;

// The editor's initial height. CodeEditor fills whatever box it is given
// (see CodeEditor.ts's class doc — it needs "a sized host"), and the dialog
// has no Split/resizer here, so a fixed preferred height keeps a few lines of
// generated SQL visible without the dialog growing unboundedly; the dialog's
// own content container scrolls past that if a preview is longer.
const EDITOR_HEIGHT = 180;

// Vertical gap between the form, the "Regenerate SQL" row, and the editor —
// matches FilterDialog's ROW_SPACING order of magnitude for a consistent
// dialog rhythm.
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
 * synchronous (void), matching FilterDialog's open/run split.
 *
 * @param options - the phase's form, SQL generator, and execute/callbacks.
 */
async function runSqlPreviewDialog(options: SqlPreviewDialogOptions): Promise<void> {
    const editor = new CodeEditor("", {
        language:      "sql",
        preferredSize: { width: 0, height: EDITOR_HEIGHT },
    });

    const regenerateButton = Button({ text: "Regenerate SQL", compact: true });
    regenerateButton.on("action", () => void refreshPreview(editor, options));

    const content = Panel({
        layoutManager: VBox({ stretching: true, spacing: CONTENT_SPACING }),
        components:    [options.form, regenerateButton, editor],
    });

    try {
        await refreshPreview(editor, options);
        await showExecuteRetryLoop(content, editor, options);
    } finally {
        editor.dispose();
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
 * Show the dialog and, on Execute, run it; a failed execute reports the error
 * and re-shows a fresh dialog (Dialog.hide() destructs on every dismissal, so
 * the same instance can't be re-shown) wrapping the same, still-live content
 * — so the form and the SQL text survive the retry. Returns once the user
 * cancels/dismisses or an execute succeeds.
 *
 * @param content - the persistent form + editor content, reused across retries.
 * @param editor - the preview editor executed SQL is read from.
 * @param options - carries `execute`, `onSuccess`, and the error reporter.
 */
async function showExecuteRetryLoop(
    content: Component,
    editor: CodeEditor,
    options: SqlPreviewDialogOptions,
): Promise<void> {
    let dialog = buildDialog(content, options);

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

            // The dialog just shown is now destructed; detach the persistent
            // content from its (spent) content container before re-wrapping
            // it in a fresh dialog for the retry.
            dialog.getContentComponent().removeComponent(content);
            dialog = buildDialog(content, options);
        }
    }
}

/**
 * Build the Cancel/Execute dialog wrapping `content`.
 *
 * @param content - the form + editor content to host.
 * @param options - carries the title and width.
 */
function buildDialog(content: Component, options: SqlPreviewDialogOptions): Dialog {
    return new Dialog({
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
