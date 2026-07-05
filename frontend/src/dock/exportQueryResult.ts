// The shared client-side query-result export: serialize the panel's rows via the
// pure serializer and trigger a Blob download. Used by both the QueryPanel toolbar
// button and the controller's Query-menu entry point, so the filename stays in one
// place.
//
// This is DOM-bound (it calls download()) and so manual-verify; its serialization
// core (serialize.ts) is unit-tested.

import { toCSV, toJSON }           from "../data/serialize";
import type { ExportColumn }       from "../data/serialize";
import { download }                from "../data/download";
import { CSV_MIME, JSON_MIME }     from "../data/mime";
import type { QueryRowsResult }    from "../contract";

/**
 * Export a query panel's full loaded rows as CSV or JSON, downloading the file
 * and reporting the outcome.
 *
 * @param result - The panel's held rows result (columns + rows).
 * @param format - The export format, "csv" or "json".
 * @param notify - Reports the outcome (row count).
 */
export function exportQueryResult(
    result: QueryRowsResult,
    format: "csv" | "json",
    notify: (message: string) => void,
): void {
    const rows = result.rows;

    // QueryColumnMeta is exactly { name, wireType } — the ExportColumn shape.
    const columns: ExportColumn[] = result.columns;

    const content = format === "csv" ? toCSV(columns, rows) : toJSON(columns, rows);
    const mime    = format === "csv" ? CSV_MIME : JSON_MIME;

    download(content, `query-result.${format}`, mime);

    notify(`exported ${rows.length} row(s) as ${format.toUpperCase()}`);
}
