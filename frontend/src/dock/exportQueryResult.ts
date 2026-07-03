// The shared client-side query-result export: cap the rows to what the panel
// shows, serialize them via the pure serializer, and trigger a Blob download.
// Used by both the QueryPanel toolbar button and the controller's Query-menu
// entry point, so the truncation wording and filename stay in one place.
//
// This is DOM-bound (it calls download()) and so manual-verify; its serialization
// core (serialize.ts) is unit-tested. It lives in dock/ beside capRows so the
// render-cap dependency stays within one layer.

import { toCSV, toJSON }           from "../data/serialize";
import type { ExportColumn }       from "../data/serialize";
import { download }                from "../data/download";
import { capRows, MAX_RESULT_ROWS } from "./capRows";
import type { QueryRowsResult }    from "../contract";

// The MIME types the two export formats download as.
const CSV_MIME  = "text/csv";
const JSON_MIME = "application/json";

/**
 * Export a query panel's loaded rows as CSV or JSON, downloading the file and
 * reporting the outcome. Only the shown (render-capped) rows are exported — a
 * larger result was capped for display, and silently re-running the SQL is a
 * Non-Goal — so a truncated result exports the shown rows and points at the
 * navigator's full-table export for the rest.
 *
 * @param result - The panel's held rows result (columns + rows).
 * @param format - The export format, "csv" or "json".
 * @param notify - Reports the outcome (row count, or the truncation caveat).
 */
export function exportQueryResult(
    result: QueryRowsResult,
    format: "csv" | "json",
    notify: (message: string) => void,
): void {
    const rows      = capRows(result.rows, MAX_RESULT_ROWS);
    const truncated = rows.length < result.rows.length;

    // QueryColumnMeta is exactly { name, wireType } — the ExportColumn shape.
    const columns: ExportColumn[] = result.columns;

    const content = format === "csv" ? toCSV(columns, rows) : toJSON(columns, rows);
    const mime    = format === "csv" ? CSV_MIME : JSON_MIME;

    download(content, `query-result.${format}`, mime);

    notify(truncated
        ? `exported the first ${rows.length} of ${result.rows.length} shown rows — `
          + `result was truncated; use the table's Export for the full data`
        : `exported ${rows.length} row(s) as ${format.toUpperCase()}`);
}
