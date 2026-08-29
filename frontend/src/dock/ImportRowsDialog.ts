// The "Import data" flow's dialog: drop/pick a CSV or JSON file, preview its
// parsed rows (with per-row validation errors) against the target table, and
// commit. A new dialog, not a subclass of SqlPreviewDialog — its content (a
// file drop zone + a data preview grid) differs enough from a form + SQL
// editor that sharing the base would buy nothing (see the plan's Critical
// Files note).
//
// Import is a chrome button, always enabled, mirroring SqlPreviewDialog's
// Cancel/Execute pair — but unlike SqlPreviewDialog (whose Execute always
// succeeds at closing and retries by rebuilding a fresh Dialog on a failed
// execute), Import's own click is validated in place via `DialogButtonConfig.
// onClick`: it returns `false` to veto the close (blocked — no valid preview
// yet; or failed — the commit rejected), keeping this SAME Dialog instance
// open, or `true` once `executeImportRows` actually succeeds. No retry loop,
// no RetainedContentDialog: the dialog never closes on a blocked/failed
// attempt in the first place, so there's nothing to rebuild.
//
// Errors surface in an in-content banner (ensureErrorBanner/showErrorBanner/
// hideErrorBanner, mirroring QueryPanel.ts's durable error banner) rather
// than a Notification: a Notification's z-index (10002) sits below the
// Dialog band (11000, see LayerManager's Z_BAND_DIALOG) so a toast fired while
// this dialog is open — every error case here — would render invisibly behind
// the modal backdrop.

import { Panel, Container }         from "@jimka/typescript-ui/core";
import { VBox, HBox }               from "@jimka/typescript-ui/layout";
import { Text, FileDropZone }       from "@jimka/typescript-ui/component/input";
import { Table }                    from "@jimka/typescript-ui/component/table";
import { Glyph }                    from "@jimka/typescript-ui/component/display";
import { circle_exclamation }       from "@jimka/typescript-ui/glyphs/solid/circle_exclamation";
import { xmark }                    from "@jimka/typescript-ui/glyphs/solid/xmark";
import { MemoryStore, Model }       from "@jimka/typescript-ui/data";
import { Dialog }                   from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig }  from "@jimka/typescript-ui/overlay";
import { glyphButton }              from "./glyphButton";
import { DESTRUCTIVE_COLOR, NEUTRAL_COLOR } from "../theme";
import type { ColumnMeta, DbObjectRef, ImportRowResult } from "../contract";
import { previewImportRows, executeImportRows } from "../data/api";
import { parseImportFile }          from "../data/parseImport";
import { toFields }                 from "../data/buildModel";
import { PAGE_SIZE }                from "../data/stores";
import { buildPreviewGridRows }     from "./importPreviewRows";

Glyph.register(circle_exclamation, xmark);

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

const CONTENT_SPACING = 8;

// The preview grid's own preferred height, in rows' worth of screen space.
// Table reports no preferred size of its own (it's a virtual-scrolling body
// that otherwise just fills whatever space it's given, see Table's class
// doc), so without this the dialog's Border VBox sums the drop zone, summary
// and footer to a total that leaves the grid barely any room. Left uncapped
// as content grows: Table's own internal scrollbar (already expected for
// PAGE_SIZE-capped preview rows) takes over past this height, exactly as
// intended for a data grid — unlike SqlPreviewDialog's SQL editor, this never
// needs to grow further with content.
const PREVIEW_GRID_HEIGHT = 320;

// The error banner's background — same token/fallback as QueryPanel.ts's own
// (private) ERROR_BANNER_BG; duplicated rather than shared since neither file
// exports it and it's a single CSS-var literal.
const ERROR_BANNER_BG = "var(--ts-ui-notification-error-bg, rgba(244, 214, 214, 0.75))";

/** Cancel has no onClick guard — every dismiss gesture should always work. */
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
 * Build the dialog, wire the file-drop -> preview -> commit flow, and show
 * it. Kept separate from {@link openImportRowsDialog} so the public entry
 * point stays synchronous (void) — the same open/run split SqlPreviewDialog
 * uses.
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
    previewGrid.setPreferredSize({ width: 0, height: PREVIEW_GRID_HEIGHT });

    // The last parsed file's ORIGINAL (uncoerced) rows, and their preview
    // results, kept aligned by array index (both come from the same
    // parseImportFile() call, in the same order, and PreviewImportRowsQuery
    // never reorders). Import resends parsedRows — never previewedRows'
    // already-coerced `values` — because from_import_scalar's JSON/JSON_ARRAY
    // branch is not idempotent (its own value, re-coerced, is not always its
    // own input); sending the original raw cells lets each phase coerce them
    // exactly once.
    let parsedRows: Record<string, unknown>[] = [];
    let previewedRows: ImportRowResult[] = [];

    const content = new Panel({
        layoutManager: VBox({ itemAlign: "stretch", spacing: CONTENT_SPACING }),
        components:    [dropZone, summary],
    });
    content.addComponent(previewGrid, { weight: 1 });

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

    /** Show (or refresh) the error banner with `error`'s message. */
    function showError(error: unknown): void {
        const banner = ensureErrorBanner();

        errorBannerText!.setText(error instanceof Error ? error.message : String(error));

        if (!errorBannerShown) {
            content.addComponent(banner);
            errorBannerShown = true;
        }

        dialog.resizeToContent();
    }

    /** Hide the error banner (Dismiss, or a new file being dropped/picked). A no-op when not showing. */
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
     * teardown). A separate function, not inlined at the call site: TypeScript
     * narrows `errorBanner` to `never` at that position when checked inline in
     * a `try/finally` (a quirk of its control-flow analysis there, not a real
     * impossibility) — calling a fresh function sidesteps it.
     */
    function disposeDetachedErrorBanner(): void {
        if (!errorBannerShown && errorBanner) {
            errorBanner.dispose();
        }
    }

    dropZone.on("change", (files: File[]) => void handleFile(files));

    /** Reset the preview state to "nothing previewed yet" (also the initial state). */
    function resetPreview(): void {
        parsedRows = [];
        previewedRows = [];
        previewStore.loadData([]);
        summary.setText("");
    }

    /** Parse the dropped/picked file, then preview it against the target table. */
    async function handleFile(files: File[]): Promise<void> {
        const file = files[0];

        if (!file) {
            return;
        }

        hideErrorBanner();

        let parsed;

        try {
            parsed = parseImportFile(file.name, await file.text());
        } catch (err) {
            resetPreview();
            showError(err);

            return;
        }

        let preview;

        try {
            preview = await previewImportRows(options.ref, parsed.rows);
        } catch (err) {
            resetPreview();
            showError(err);

            return;
        }

        parsedRows = parsed.rows;
        previewedRows = preview.rows;
        summary.setText(`${preview.totalRows} row(s) parsed, ${preview.errorRows} with errors`);
        previewStore.loadData(buildPreviewGridRows(preview.rows, PAGE_SIZE));
    }

    /** Whether the currently previewed file can be imported: parsed, non-empty, and error-free. */
    function canImport(): boolean {
        return previewedRows.length > 0 && previewedRows.every((r) => r.ok);
    }

    /** Why Import is blocked right now — only meaningful when {@link canImport} is false. */
    function blockedReason(): string {
        return previewedRows.length === 0
            ? "Choose a file to import first."
            : "Fix the file's errors before importing.";
    }

    /**
     * Import's `onClick` guard: blocks (showing why) when nothing importable
     * is previewed, otherwise commits and reports the result — returning
     * `true` only when the commit actually succeeds, so the Dialog library
     * closes on success and stays open (with the failure shown) otherwise.
     */
    async function tryImport(): Promise<boolean> {
        if (!canImport()) {
            showError(blockedReason());

            return false;
        }

        // The original raw rows, not previewedRows' coerced `values` — see
        // the parsedRows/previewedRows field comment above.
        const rows = parsedRows.filter((_, i) => previewedRows[i]?.ok === true);

        try {
            const importResult = await executeImportRows(options.ref, rows);

            options.onImported(importResult.insertedCount);

            return true;
        } catch (err) {
            showError(err);

            return false;
        }
    }

    const importButton: DialogButtonConfig = {
        text:    "Import",
        result:  "confirm",
        primary: true,
        onClick: tryImport,
    };

    const dialog = new Dialog({
        title:            `Import into "${options.ref.name ?? ""}"`,
        contentComponent: content,
        buttons:          [CANCEL_BUTTON, importButton],
        width:            DIALOG_WIDTH,
    });

    // `content` itself is never disposed here: Dialog owns that as part of
    // its own teardown (see LoginDialog.ts's identical plain-Dialog pattern).
    try {
        await dialog.show();
    } finally {
        disposeDetachedErrorBanner();
    }
}
