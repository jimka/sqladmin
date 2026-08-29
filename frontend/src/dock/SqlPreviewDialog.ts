// The reusable DDL form + editable-SQL-preview + Cancel/Execute dialog every
// DDL phase embeds its structured form into. Flow: form -> generateSql()
// seeds an editable SQL preview -> the user optionally edits it -> Execute
// runs the (possibly edited) SQL, never a spec re-compiled at confirm time —
// the previewed text is authoritative at execute (see
// plans/implemented/ddl-infrastructure.md's "editable preview is
// authoritative" decision). A "Regenerate SQL" button re-runs generateSql(),
// discarding any manual edit; infra otherwise only seeds once, on open.
//
// Execute is a chrome button, validated on click via `DialogButtonConfig.
// onClick` (mirroring ImportRowsDialog.ts's Import button): it returns
// `false` on a failed execute, vetoing the close and keeping this SAME Dialog
// instance open with the form and SQL intact, or `true` once `options.
// execute` actually succeeds. No retry loop, no RetainedContentDialog: the
// dialog never closes on a failed execute in the first place, so there's
// nothing to rebuild.
//
// Every failure — a failed generateSql (initial seed or "Regenerate SQL") and
// a failed execute — still calls the caller's `onError` (or the default
// Notification) exactly as before, preserving StatusBar/Notification-history
// side effects, but ALSO shows an in-content banner (ensureErrorBanner/
// showError/hideErrorBanner, mirroring QueryPanel.ts's durable error banner
// and ImportRowsDialog.ts's identical copy of it): a Notification's z-index
// (10002) sits below the Dialog band (11000, see LayerManager's
// Z_BAND_DIALOG), so a toast fired while this dialog is open — every failure
// here except the very first seed, before the dialog exists — would render
// invisibly behind the modal backdrop.
//
// The Dialog exposes only three result codes ("confirm" | "cancel" | "close"),
// and every dismiss gesture (Escape, backdrop, the always-present title-bar
// close) resolves to "close". So: Execute = "confirm" (primary), Cancel =
// "close" (shares the dismiss code, so dismissing == Cancel == do nothing).

import { Panel, Container }        from "@jimka/typescript-ui/core";
import type { Component }          from "@jimka/typescript-ui/core";
import { VBox, HBox }              from "@jimka/typescript-ui/layout";
import { Button }                  from "@jimka/typescript-ui/component/button";
import { CodeEditor }              from "@jimka/typescript-ui/component/editor";
import { Text }                    from "@jimka/typescript-ui/component/input";
import { Glyph }                   from "@jimka/typescript-ui/component/display";
import { circle_exclamation }      from "@jimka/typescript-ui/glyphs/solid/circle_exclamation";
import { xmark }                   from "@jimka/typescript-ui/glyphs/solid/xmark";
import { Dialog, Notification }    from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig } from "@jimka/typescript-ui/overlay";
import { glyphButton }             from "./glyphButton";
import { DESTRUCTIVE_COLOR, NEUTRAL_COLOR } from "../theme";
import type { QueryStatusResult }  from "../contract";

Glyph.register(circle_exclamation, xmark);

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

// The error banner's background — same token/fallback as QueryPanel.ts's own
// (private) ERROR_BANNER_BG and ImportRowsDialog.ts's copy of it; duplicated
// rather than shared since none of the three export it and it's a single
// CSS-var literal.
const ERROR_BANNER_BG = "var(--ts-ui-notification-error-bg, rgba(244, 214, 214, 0.75))";

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
        preferredSize:     { width: 0, height: EDITOR_SEED_HEIGHT },
    });

    // Once the editor has real measured content — first mount, and every
    // "Regenerate SQL"/manual edit that changes its row count after — drop the
    // seed preferredSize constraint (see EDITOR_SEED_HEIGHT's comment above)
    // and re-fit the dialog to the new height (Dialog does not do this on its
    // own past its one-time post-open resizeToContent()). `dialog` is defined
    // further down, but this closure only ever runs once the editor has
    // mounted — i.e. after `dialog` is assigned below.
    editor.on("heightchange", () => {
        editor.clearPreferredSize();
        dialog.resizeToContent();
    });

    const regenerateButton = Button({ text: "Regenerate SQL", compact: true });
    regenerateButton.on("action", () => void refreshPreview());

    const content = Panel({
        layoutManager: VBox({ itemAlign: "stretch", spacing: CONTENT_SPACING }),
        components:    [options.form, regenerateButton, editor],
    });

    let errorBanner: Container | null = null;
    let errorBannerText: Text | null = null;
    let errorBannerShown = false;

    /** Build the banner row on first use: warning glyph, wrapping message text, dismiss button. */
    function ensureErrorBanner(): Container {
        if (!errorBanner) {
            const icon    = new Glyph("circle-exclamation", { foregroundColor: DESTRUCTIVE_COLOR });
            const dismiss = glyphButton("xmark", NEUTRAL_COLOR, "Dismiss", () => hideErrorBanner());
            const banner  = Container({ layoutManager: new HBox({ spacing: 8, itemAlign: "stretch" }) });

            errorBannerText = new Text("", { whiteSpace: "normal", truncate: false });

            banner.addComponent(icon);
            banner.addComponent(errorBannerText, { weight: 1 });
            banner.addComponent(dismiss);
            banner.setBackgroundColor(ERROR_BANNER_BG);

            errorBanner = banner;
        }

        return errorBanner;
    }

    /**
     * Report `err` through the caller's `onError`/Notification (unchanged
     * side effect — StatusBar text, Notification history) and additionally
     * show it in the in-content banner, refreshing the text if already shown.
     */
    function showError(err: unknown): void {
        reportError(err, options.onError);

        const banner = ensureErrorBanner();

        errorBannerText!.setText(err instanceof Error ? err.message : String(err));

        if (!errorBannerShown) {
            content.addComponent(banner);
            errorBannerShown = true;
        }

        dialog.resizeToContent();
    }

    /** Hide the error banner (Dismiss, or a new generate/execute attempt starting). A no-op when not showing. */
    function hideErrorBanner(): void {
        if (errorBannerShown) {
            content.removeComponent(errorBanner!);
            errorBannerShown = false;
            dialog.resizeToContent();
        }
    }

    /**
     * Dispose the error banner if it exists but isn't currently attached to
     * `content` — Dialog's own teardown only cascades into content's
     * CURRENTLY attached children, so a dismissed (detached) banner would
     * otherwise leak (same reasoning as QueryPanel.ts's own errorBanner
     * teardown). A separate function, not inlined at the call site: see
     * ImportRowsDialog.ts's identical helper for why (a `never`-narrowing
     * quirk in TypeScript's control-flow analysis inside `try/finally`).
     */
    function disposeDetachedErrorBanner(): void {
        if (!errorBannerShown && errorBanner) {
            errorBanner.dispose();
        }
    }

    /**
     * Regenerate the preview SQL from the form's current state and load it
     * into the editor. A rejection is reported and shown in the banner,
     * leaving the editor's current text untouched.
     */
    async function refreshPreview(): Promise<void> {
        hideErrorBanner();

        try {
            editor.setValue(await options.generateSql());
        } catch (err) {
            showError(err);
        }
    }

    /**
     * Execute's `onClick` guard: runs the (possibly edited) SQL and reports
     * success, returning `true` only when the commit actually succeeds, so
     * the Dialog library closes on success and stays open (with the failure
     * shown) otherwise.
     */
    async function tryExecute(): Promise<boolean> {
        hideErrorBanner();

        try {
            const status = await options.execute(editor.getValue());

            options.onSuccess(status);

            return true;
        } catch (err) {
            showError(err);

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
        await refreshPreview();
        await dialog.show();
    } finally {
        disposeDetachedErrorBanner();
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
