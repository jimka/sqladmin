// The reusable optional structured form + editable-SQL-preview +
// Cancel/Execute dialog. Flow: generateSql() seeds an editable SQL preview ->
// the user optionally edits it (including line breaks — the editor is a real
// multi-line CodeEditor, not a single-line field) -> Execute runs the
// (possibly edited) SQL, never a spec re-compiled at confirm time — the
// previewed text is authoritative at execute (see
// plans/implemented/ddl-infrastructure.md's "editable preview is
// authoritative" decision). generateSql() only ever seeds once, on open —
// there is no "Regenerate SQL" action: the form (when present) is a static
// summary, not an interactive input the user could change while this modal
// is open, so regenerating from it would only ever reproduce the same seed.
// The form is optional: a tab-hosted creation flow (see DdlFormPanel) keeps its
// form in its own dock tab and omits it here, so the dialog is the SQL
// review alone.
//
// Execute is a chrome button, validated on click via `DialogButtonConfig.
// onClick` (mirroring ImportRowsDialog.ts's Import button): it returns
// `false` on a failed execute, vetoing the close and keeping this SAME Dialog
// instance open with the form and SQL intact, or `true` once `options.
// execute` actually succeeds. No retry loop, no RetainedContentDialog: the
// dialog never closes on a failed execute in the first place, so there's
// nothing to rebuild.
//
// Every failure — the initial generateSql seed and a failed execute — still
// calls the caller's `onError` (or the default Notification) exactly as
// before, preserving StatusBar/Notification-history side effects, but ALSO
// shows an in-content banner (ErrorBanner, mirroring QueryPanel.ts's durable
// error banner): a Notification's z-index (10002) sits below the Dialog band
// (11000, see LayerManager's Z_BAND_DIALOG), so a toast fired while this
// dialog is open — an execute failure, since the seed's own failure happens
// before the dialog exists — would render invisibly behind the modal backdrop.
//
// The Dialog exposes only three result codes ("confirm" | "cancel" | "close"),
// and every dismiss gesture (Escape, backdrop, the always-present title-bar
// close) resolves to "close". So: Execute = "confirm" (primary), Cancel =
// "close" (shares the dismiss code, so dismissing == Cancel == do nothing).

import { Panel }                   from "@jimka/typescript-ui/core";
import type { Component }          from "@jimka/typescript-ui/core";
import { VBox }                    from "@jimka/typescript-ui/layout";
import { CodeEditor }              from "@jimka/typescript-ui/component/editor";
import { Dialog, Notification }    from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig } from "@jimka/typescript-ui/overlay";
import { ErrorBanner }             from "./ErrorBanner";
import { CONTENT_SPACING }         from "./panelMetrics";
import type { QueryStatusResult }  from "../contract";

// A comfortable modal width for a structured DDL form plus the SQL preview
// editor beneath it — a bit wider than this app's narrower dialogs (~500px)
// to give the SQL editor room to breathe.
const DEFAULT_DIALOG_WIDTH = 560;

// Row cap CodeEditor's autoHeightMaxRows grows the preview to before its own
// scrollbar takes over. Sized to this app's own "wide table" DDL shape: a
// generated CREATE TABLE is one line per column plus an opening/closing paren
// line (backend/app/sql/ddl.py's create_table), and wide.cols_20 (this app's
// standard many-column fixture, see LIBRARY_NOTES.md) is 22 such lines; 24
// leaves headroom for a trailing clause without immediately scrolling.
const SQL_PREVIEW_MAX_ROWS = 24;

// Row floor CodeEditor's autoHeightMinRows never shrinks the preview below,
// even for a one-line ALTER/DROP statement — a comfortable minimum footprint
// rather than a box that hugs a single line. A row count is right-sized for
// whatever the live font metrics turn out to be, unlike a fixed pixel guess.
const SQL_PREVIEW_MIN_ROWS = 3;

/** Options for {@link openSqlPreviewDialog}. */
export interface SqlPreviewDialogOptions {
    /** Dialog title, e.g. "Create table". */
    title: string;

    /**
     * The phase's structured form, hosted above the SQL preview editor. Omitted by
     * a tab-hosted flow, whose form stays in its own dock tab (see DdlFormPanel):
     * the dialog is then the SQL preview alone.
     */
    form?: Component;

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

/** Cancel has no onClick guard — every dismiss gesture should always work. */
const CANCEL_BUTTON: DialogButtonConfig = { text: "Cancel", result: "close" };

/**
 * Open the shared DDL preview/confirm dialog: seed the SQL editor from
 * `generateSql()`, then show it until the user cancels or an execute
 * succeeds.
 *
 * @param options - the phase's form, SQL generator, and execute/callbacks.
 */
export function openSqlPreviewDialog(options: SqlPreviewDialogOptions): void {
    void runSqlPreviewDialog(options);
}

/**
 * Build the dialog, seed the preview, and show it. Kept separate from
 * {@link openSqlPreviewDialog} so the public entry point stays synchronous
 * (void) — this app's open/run dialog split.
 *
 * @param options - the phase's form, SQL generator, and execute/callbacks.
 */
async function runSqlPreviewDialog(options: SqlPreviewDialogOptions): Promise<void> {
    const editor = new CodeEditor("", {
        language:          "sql",
        autoHeightMaxRows: SQL_PREVIEW_MAX_ROWS,
        autoHeightMinRows: SQL_PREVIEW_MIN_ROWS,
    });

    // The editor's own height settles asynchronously (first mount, and any
    // later edit that changes its row count) — re-fit the dialog to it each
    // time (Dialog does not do this on its own past its one-time post-open
    // resizeToContent()). `dialog` is defined further down, but this closure
    // only ever runs once the editor has mounted — i.e. after `dialog` is
    // assigned below.
    editor.on("heightchange", () => dialog.resizeToContent());

    const content = Panel({
        layoutManager: VBox({ itemAlign: "stretch", spacing: CONTENT_SPACING }),
        components:    options.form ? [options.form, editor] : [editor],
    });

    const errorBanner = new ErrorBanner({ host: content, onChange: () => dialog.resizeToContent() });

    /**
     * Seed the preview SQL from the form's current state and load it into
     * the editor. A rejection is reported and shown in the banner, leaving
     * the editor's current text untouched.
     */
    async function seedPreview(): Promise<void> {
        errorBanner.hide();

        try {
            editor.setValue(await options.generateSql());
        } catch (err) {
            reportError(err, options.onError);
            errorBanner.show(err);
        }
    }

    /**
     * Execute's `onClick` guard: runs the (possibly edited) SQL and reports
     * success, returning `true` only when the commit actually succeeds, so
     * the Dialog library closes on success and stays open (with the failure
     * shown) otherwise.
     */
    async function tryExecute(): Promise<boolean> {
        errorBanner.hide();

        try {
            const status = await options.execute(editor.getValue());

            options.onSuccess(status);

            return true;
        } catch (err) {
            reportError(err, options.onError);
            errorBanner.show(err);

            return false;
        }
    }

    const executeButton: DialogButtonConfig = {
        text:    "Execute",
        result:  "confirm",
        primary: true,
        onClick: tryExecute,
    };

    const dialog = new Dialog({
        title:            options.title,
        contentComponent: content,
        buttons:          [CANCEL_BUTTON, executeButton],
        width:            options.width ?? DEFAULT_DIALOG_WIDTH,
    });

    // `content` itself is never disposed here: Dialog owns that as part of
    // its own teardown (see LoginDialog.ts's identical plain-Dialog pattern).
    try {
        await seedPreview();
        await dialog.show();
    } finally {
        errorBanner.dispose();
    }
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
