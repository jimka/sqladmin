// The "Import data" flow's dialog: drop/pick a CSV or JSON file, preview its
// parsed rows (with per-row validation errors) against the target table, and
// commit. A new dialog, not a subclass of SqlPreviewDialog — its content (a
// file drop zone + a data preview grid) differs enough from a form + SQL
// editor that sharing the base would buy nothing (see the plan's Critical
// Files note).
//
// Unlike SqlPreviewDialog's chrome-driven Cancel/Execute buttons, this
// dialog's own Dialog library exposes no way to enable/disable a chrome
// button after construction (DialogButtonRow builds its Button instances
// internally and never hands them back) — so the primary "Import" action is
// a content-embedded Button instead, which supports the ordinary
// `setEnabled()` every other button in this app already uses. The chrome
// carries only Cancel, and this dialog never rebuilds itself on a failed
// import the way SqlPreviewDialog rebuilds on a failed execute: since the
// content button decides for itself whether to call `dialog.hide()`, a
// failed import simply leaves the same Dialog instance open (with the same
// parsed rows) for a one-click retry, with no RetainedContentDialog
// machinery needed.

import { Panel }                    from "@jimka/typescript-ui/core";
import { VBox, HBox }               from "@jimka/typescript-ui/layout";
import { Button }                   from "@jimka/typescript-ui/component/button";
import { Spacer }                   from "@jimka/typescript-ui/component/container";
import { Text, FileDropZone }       from "@jimka/typescript-ui/component/input";
import { Table }                    from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model }       from "@jimka/typescript-ui/data";
import { Dialog, Notification }     from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig }  from "@jimka/typescript-ui/overlay";
import type { ColumnMeta, DbObjectRef, ImportRowResult } from "../contract";
import { previewImportRows, executeImportRows } from "../data/api";
import { parseImportFile }          from "../data/parseImport";
import { toFields }                 from "../data/buildModel";
import { PAGE_SIZE }                from "../data/stores";
import { CONSTRUCTIVE_COLOR }       from "../theme";
import { buildPreviewGridRows }     from "./importPreviewRows";

/** Options for {@link openImportRowsDialog}. */
export interface ImportRowsDialogOptions {
    /** The target table. */
    ref: DbObjectRef;
    /** The target table's introspected columns (drives the preview grid). */
    columns: ColumnMeta[];
    /** Called after a successful commit with the number of rows inserted. */
    onImported: (insertedCount: number) => void;
}

// A comfortable modal width for a data preview grid — wider than
// SqlPreviewDialog's 560 (a form + SQL editor), since a grid needs more
// horizontal room to show more than one or two columns unscrolled.
const DIALOG_WIDTH = 640;
const DIALOG_HEIGHT = 520;

const CONTENT_SPACING = 8;

/** Cancel is the chrome's only button — see the module doc comment. */
const CANCEL_BUTTON: DialogButtonConfig = { text: "Cancel", result: "close" };

/**
 * Open the import dialog for `options.ref`. Fire-and-forget, like every
 * other `openXDialog` in this app (`openSqlPreviewDialog`, `openViewDialog`).
 *
 * @param options - the target table, its columns, and the post-commit callback.
 */
export function openImportRowsDialog(options: ImportRowsDialogOptions): void {
    void runImportRowsDialog(options);
}

/**
 * Build the dialog's content, wire the file-drop -> preview -> commit flow,
 * and show it. Kept separate from {@link openImportRowsDialog} so the public
 * entry point stays synchronous (void) — the same open/run split
 * SqlPreviewDialog uses.
 */
async function runImportRowsDialog(options: ImportRowsDialogOptions): Promise<void> {
    const dropZone = new FileDropZone({ accept: ".csv,.json" });
    const summary  = new Text("");

    const fields = [
        ...toFields(options.columns),
        { name: "error", type: "string" as const, order: options.columns.length, description: "Error" },
    ];
    const previewStore = new MemoryStore(new Model({ fields }));
    const previewGrid  = Table(previewStore, { columns: [], autoSizeColumns: true, rowReadOnly: () => true });

    const importButton = Button({ text: "Import", foregroundColor: CONSTRUCTIVE_COLOR });
    importButton.setEnabled(false);

    // The last parsed file's ORIGINAL (uncoerced) rows, and their preview
    // results, kept aligned by array index (both come from the same
    // parseImportFile() call, in the same order, and PreviewImportRowsQuery
    // never reorders). Import resends parsedRows — never previewedRows'
    // already-coerced `values` — because from_import_scalar's JSON/JSON_ARRAY
    // branch is not idempotent (its own value, re-coerced, is not always its
    // own input); sending the original raw cells lets each phase coerce them
    // exactly once. Kept so a click on Import can send exactly what was
    // previewed (never a stale or re-parsed file) and so a failed import can
    // be retried with no re-preview round trip.
    let parsedRows: Record<string, unknown>[] = [];
    let previewedRows: ImportRowResult[] = [];

    const importRow = new Panel({
        layoutManager: HBox({ spacing: 8 }),
        components:    [Spacer.flex(), importButton],
    });

    const content = new Panel({
        layoutManager: VBox({ itemAlign: "stretch", spacing: CONTENT_SPACING }),
        components:    [dropZone, summary],
    });
    content.addComponent(previewGrid, { weight: 1 });
    content.addComponent(importRow);

    const dialog = new Dialog({
        title:            `Import into "${options.ref.name ?? ""}"`,
        contentComponent: content,
        buttons:          [CANCEL_BUTTON],
        width:            DIALOG_WIDTH,
        height:           DIALOG_HEIGHT,
    });

    dropZone.on("change", (files: File[]) => void handleFile(files));
    importButton.on("action", () => void handleImport());

    /** Reset the preview state to "nothing previewed yet" (also the initial state). */
    function resetPreview(): void {
        parsedRows = [];
        previewedRows = [];
        previewStore.loadData([]);
        summary.setText("");
        importButton.setEnabled(false);
    }

    /** Parse the dropped/picked file, then preview it against the target table. */
    async function handleFile(files: File[]): Promise<void> {
        const file = files[0];

        if (!file) {
            return;
        }

        let parsed;

        try {
            parsed = parseImportFile(file.name, await file.text());
        } catch (err) {
            resetPreview();
            reportError(err);

            return;
        }

        let preview;

        try {
            preview = await previewImportRows(options.ref, parsed.rows);
        } catch (err) {
            resetPreview();
            reportError(err);

            return;
        }

        parsedRows = parsed.rows;
        previewedRows = preview.rows;
        summary.setText(`${preview.totalRows} row(s) parsed, ${preview.errorRows} with errors`);
        previewStore.loadData(buildPreviewGridRows(preview.rows, PAGE_SIZE));
        importButton.setEnabled(preview.errorRows === 0 && preview.totalRows > 0);
    }

    /**
     * Commit the last previewed rows. On success, reports the inserted count
     * to the caller and closes the dialog. On failure, reports the error and
     * leaves the dialog open — the same previewed rows can be retried with
     * one more click (see the module doc comment). Disabled for the duration
     * of the request so a second click can't fire a concurrent import; a
     * failure re-enables it (success leaves it disabled — the dialog is
     * closing anyway).
     */
    async function handleImport(): Promise<void> {
        // The original raw rows, not previewedRows' coerced `values` — see
        // the parsedRows/previewedRows field comment above.
        const rows = parsedRows.filter((_, i) => previewedRows[i]?.ok === true);

        importButton.setEnabled(false);

        try {
            const result = await executeImportRows(options.ref, rows);

            options.onImported(result.insertedCount);
            dialog.hide("confirm");
        } catch (err) {
            importButton.setEnabled(true);
            reportError(err);
        }
    }

    await dialog.show();
}

/**
 * Report a preview/commit error via a Notification — mirrors
 * SqlPreviewDialog.ts's `reportError`.
 *
 * @param err - the caught error (an `Error`, or an arbitrary thrown value).
 */
function reportError(err: unknown): void {
    Notification.show(err instanceof Error ? err.message : String(err), "error");
}
