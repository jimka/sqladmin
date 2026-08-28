// Pure preview-grid row-building logic for ImportRowsDialog.ts, split out so
// it can be unit-tested under this project's node vitest environment.
// ImportRowsDialog.ts imports DOM-touching library components (Dialog,
// FileDropZone, Table, ...) at module scope, which have no stand-in in a
// node environment — the same constraint tableWriteRules.ts documents for
// TableWorkPanel.ts, and the reason its own pure logic lives apart from it.

import type { ImportRowResult } from "../contract";

/**
 * Project one preview result into the preview grid's row shape: a
 * successful row's coerced values plus an empty `error` cell, or a failed
 * row's `error` message alone (its other cells render blank — it never had
 * coerced values to show).
 */
function previewRowRecord(row: ImportRowResult): Record<string, unknown> {
    return row.ok ? { ...row.values, error: "" } : { error: row.error };
}

/**
 * Build the preview grid's row data from a full preview result: at most
 * `pageSize` rows (regardless of how many the file parsed to — see the
 * table-data-import plan's "Preview grid shows a bounded sample" Architecture
 * Decision), each projected via {@link previewRowRecord}.
 *
 * @param rows - Every previewed row's result, in file order.
 * @param pageSize - The grid's display cap.
 * @returns The (possibly truncated) rows to load into the preview grid's store.
 */
export function buildPreviewGridRows(rows: ImportRowResult[], pageSize: number): Record<string, unknown>[] {
    return rows.slice(0, pageSize).map(previewRowRecord);
}
