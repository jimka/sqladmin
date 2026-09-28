// The reusable optional structured form + editable-SQL-preview +
// Cancel/Execute dialog. Flow: generateSql() fills an editable SQL preview ->
// the user optionally edits it (including line breaks — the editor is a real
// multi-line CodeEditor, not a single-line field) -> Execute runs the
// (possibly edited) SQL, never a spec re-compiled at confirm time — the
// previewed text is authoritative at execute (see
// plans/implemented/ddl-infrastructure.md's "editable preview is
// authoritative" decision) -> onSuccess learns whether that text differs
// from the most recently generated SQL, since the form's values then no
// longer describe what ran (plans/implemented/navigator-targeted-refresh.md).
// The form is optional: a tab-hosted creation flow (see DdlFormPanel) keeps its
// form in its own dock tab and omits it here, so the dialog is the SQL
// review alone.
//
// A form that can change while the modal is open (a drop's CASCADE box, a
// rename's name field, the index and constraint forms) exposes
// `onFieldChange`, and the preview then follows it
// (plans/implemented/ddl-preview-follows-form.md, building the
// preview-refresh design ddl-infrastructure.md specified): while the editor
// text still equals the last generated SQL, each form change regenerates it
// after a short debounce (SqlPreviewSync owns those rules). A hand-edited
// preview is never overwritten automatically; the "Regenerate SQL" button,
// enabled only while the editor does not follow the form, discards the edit
// on request. Execute first settles any pending regeneration, so a name typed
// just before clicking it is in the SQL that runs. A failed generation shows
// in the banner and clears an editor that follows the form (so stale SQL is
// never shown or executed), leaving a hand-edited one as typed; Execute is
// vetoed while the last generation failed and the editor still follows. A
// summary panel or a form-less review has no `onFieldChange`, so it gets no
// Regenerate button and is generated once, on open.
//
// Execute is a chrome button, validated on click via `DialogButtonConfig.
// onClick` (mirroring ImportRowsDialog.ts's Import button): it returns
// `false` on a failed execute, vetoing the close and keeping this SAME Dialog
// instance open with the form and SQL intact, or `true` once `options.
// execute` actually succeeds. No retry loop, no RetainedContentDialog: the
// dialog never closes on a failed execute in the first place, so there's
// nothing to rebuild.
//
// Every failure — the generation on open, a Regenerate SQL click, and a
// failed execute — calls the caller's `onError` (or the default Notification),
// preserving StatusBar/Notification-history side effects, and ALSO shows an
// in-content banner. A failure from a form change shows in the banner only:
// those are expected while the form is half filled in (no column ticked yet),
// and reporting each would add a history entry per pause in typing. The
// banner (ErrorBanner) mirrors QueryPanel.ts's durable error banner, since a
// Notification's z-index (LayerManager.Band.Notification, 10500) sits below
// the Dialog band (LayerManager.Band.Dialog, 11000), so a toast fired while
// this dialog is open would render invisibly behind the modal backdrop.
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
import type { DialogButtonConfig } from "@jimka/typescript-ui/overlay";
import type { DialogConfig }       from "@jimka/typescript-ui/overlay";
import type { DialogResult }       from "@jimka/typescript-ui/overlay";
import { ErrorBanner }             from "./ErrorBanner";
import { CONTENT_SPACING }         from "./panelMetrics";
import { SqlPreviewSync }          from "./sqlPreviewSync";
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

/** A dialog-hosted form. `onFieldChange`, when present, makes the preview follow the form. */
export interface SqlPreviewForm extends Component {
    /**
     * Register a listener run on every field change. Present only on a form
     * the user can change while the dialog is open.
     */
    onFieldChange?(listener: () => void): unknown;
}

/** Options for {@link openSqlPreviewDialog}. */
export interface SqlPreviewDialogOptions {
    /** Dialog title, e.g. "Create table". */
    title: string;

    /**
     * The phase's structured form, hosted above the SQL preview editor. Omitted by
     * a tab-hosted flow, whose form stays in its own dock tab (see DdlFormPanel):
     * the dialog is then the SQL preview alone. A form with `onFieldChange`
     * has the preview follow its edits.
     */
    form?: SqlPreviewForm;

    /**
     * Generate the SQL for the form's current state (the phase's preview
     * call). Rejections surface in the dialog; a rejection clears an editor
     * that follows the form and leaves a hand-edited one as is.
     */
    generateSql: () => Promise<string>;

    /** Execute the (possibly edited) SQL from the editor. Resolves the status. */
    execute: (sql: string) => Promise<QueryStatusResult>;

    /**
     * Called after a successful execute so the caller can refresh + report.
     * `sqlEdited` is true when the executed SQL differs from the SQL
     * `generateSql` most recently produced — the form's values then no longer
     * describe what ran.
     */
    onSuccess: (result: QueryStatusResult, sqlEdited: boolean) => void;

    /** Report an execute/preview error. Defaults to a Notification if omitted. */
    onError?: (message: string) => void;

    /** Dialog panel width in pixels. Defaults to {@link DEFAULT_DIALOG_WIDTH}. */
    width?: number;
}

/**
 * The preview modal: a plain `Dialog` that also reports the moment a close
 * starts. `show()` only resolves once the exit animation has finished, so a
 * debounced preview regeneration could otherwise fire while the dialog fades
 * out; every dismiss path (Execute, Cancel, Escape, backdrop, title-bar close)
 * goes through `hide()`, which makes it the one place to stop it.
 */
class SqlPreviewModal extends Dialog {
    private readonly _onCloseStart: () => void;

    /**
     * @param config - the Dialog's own configuration.
     * @param onCloseStart - called each time `hide()` begins, before the exit
     *   animation.
     */
    constructor(config: DialogConfig, onCloseStart: () => void) {
        super(config);

        this._onCloseStart = onCloseStart;
    }

    /**
     * Report the close to the owner, then run the Dialog's own hide.
     *
     * @param result - the result `show()` resolves with.
     * @returns this dialog.
     */
    override hide(result: DialogResult): this {
        this._onCloseStart();

        return super.hide(result);
    }
}

/** Cancel has no onClick guard — every dismiss gesture should always work. */
const CANCEL_BUTTON: DialogButtonConfig = { text: "Cancel", result: "close" };

/**
 * Open the shared DDL preview/confirm dialog: fill the SQL editor from
 * `generateSql()`, then show it until the user cancels or an execute
 * succeeds.
 *
 * @param options - the phase's form, SQL generator, and execute/callbacks.
 */
export function openSqlPreviewDialog(options: SqlPreviewDialogOptions): void {
    void runSqlPreviewDialog(options);
}

/**
 * Build the dialog, generate the preview, and show it. Kept separate from
 * {@link openSqlPreviewDialog} so the public entry point stays synchronous
 * (void) — this app's open/run dialog split.
 *
 * @param options - the phase's form, SQL generator, and execute/callbacks.
 */
async function runSqlPreviewDialog(options: SqlPreviewDialogOptions): Promise<void> {
    const editor = buildPreviewEditor();

    // The editor's own height settles asynchronously (first mount, and any
    // later edit that changes its row count) — re-fit the dialog to it each
    // time (Dialog does not do this on its own past its one-time post-open
    // resizeToContent()). `dialog` is defined further down, but this closure
    // only ever runs once the editor has mounted — i.e. after `dialog` is
    // assigned below.
    editor.on("heightchange", () => dialog.resizeToContent());

    const sync = new SqlPreviewSync({
        generateSql: options.generateSql,
        readEditor:  () => editor.getValue(),
        writeEditor: sql => editor.setValue(sql),
        onGenerated: () => {
            errorBanner.hide();
            syncRegenerateEnabled();
        },
        onFailed: (err, trigger) => {
            if (trigger !== "formChange") {
                reportError(err, options.onError);
            }

            errorBanner.show(err);
            syncRegenerateEnabled();
        },
    });

    // Only a form that can change gets the button (and the editor "change" hook).
    const regenerateButton = options.form?.onFieldChange ? buildRegenerateButton(sync) : null;

    /** Enable Regenerate SQL only while the editor does not follow the form. */
    function syncRegenerateEnabled(): void {
        regenerateButton?.setEnabled(!sync.followsForm());
    }

    if (regenerateButton) {
        editor.on("change", syncRegenerateEnabled);
    }

    const content = Panel({
        layoutManager: VBox({ itemAlign: "stretch", spacing: CONTENT_SPACING }),
        components:    previewComponents(options.form, regenerateButton, editor),
    });

    const errorBanner = new ErrorBanner({ host: content, onChange: () => dialog.resizeToContent() });

    /**
     * Execute's `onClick` guard: settles any pending regeneration, then runs
     * the (possibly edited) SQL and reports success, returning `true` only
     * when the commit actually succeeds, so the Dialog library closes on
     * success and stays open (with the failure shown) otherwise.
     */
    async function tryExecute(): Promise<boolean> {
        const ready = await sync.settle();

        // Either the banner already shows the generation error that vetoes
        // this, or the user closed the dialog while settle was waiting.
        if (!ready) {
            return false;
        }

        errorBanner.hide();

        try {
            const sql       = editor.getValue();
            const sqlEdited = !sync.followsForm();
            const status    = await options.execute(sql);

            options.onSuccess(status, sqlEdited);

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

    // The sync is disposed as soon as a close starts, so no debounced
    // regeneration fires during the exit animation; the `finally` below
    // disposes it again (idempotently) on every other way out.
    const dialog = new SqlPreviewModal({
        title:            options.title,
        contentComponent: content,
        buttons:          [CANCEL_BUTTON, executeButton],
        width:            options.width ?? DEFAULT_DIALOG_WIDTH,
    }, () => sync.dispose());

    options.form?.onFieldChange?.(sync.formChanged);

    // `content` itself is never disposed here: Dialog owns that as part of
    // its own teardown (see LoginDialog.ts's identical plain-Dialog pattern).
    try {
        await sync.regenerate("open");
        syncRegenerateEnabled();
        await dialog.show();
    } finally {
        sync.dispose();
        errorBanner.dispose();
    }
}

/**
 * Build the SQL preview editor: a multi-line SQL CodeEditor that grows between
 * the preview's row floor and cap.
 *
 * @returns the empty preview editor.
 */
function buildPreviewEditor(): CodeEditor {
    return new CodeEditor("", {
        language:          "sql",
        autoHeightMaxRows: SQL_PREVIEW_MAX_ROWS,
        autoHeightMinRows: SQL_PREVIEW_MIN_ROWS,
    });
}

/**
 * Build the "Regenerate SQL" button, which replaces a hand-edited preview with
 * SQL freshly generated from the form.
 *
 * @param sync - the preview's sync, regenerated on click.
 * @returns the compact button.
 */
function buildRegenerateButton(sync: SqlPreviewSync): Button {
    const button = Button({ text: "Regenerate SQL", compact: true });

    button.on("action", () => void sync.regenerate("button"));

    return button;
}

/**
 * The dialog content's children, top to bottom, leaving out whichever of the
 * form and the Regenerate button is absent.
 *
 * @param form - the hosted form, if any.
 * @param regenerateButton - the Regenerate SQL button, if the form can change.
 * @param editor - the SQL preview editor.
 * @returns the components to host.
 */
function previewComponents(
    form: SqlPreviewForm | undefined,
    regenerateButton: Button | null,
    editor: CodeEditor,
): Component[] {
    const components: Component[] = [];

    if (form) {
        components.push(form);
    }

    if (regenerateButton) {
        components.push(regenerateButton);
    }

    components.push(editor);

    return components;
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
