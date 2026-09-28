// TableWorkPanel's quick-search pure logic, split out so node vitest can
// unit-test it: TableWorkPanel constructs library components, which need
// a DOM, and this logic needs none (tableWriteRules.ts is the same split).
//
// The matching itself is no longer reimplemented here: recordViewControls.ts
// delegates row-hiding to the library's own `Table.setQuickSearch`, which
// matches against each cell's displayed text (via `Table.getCellText`)
// rather than the record's raw stored values — so a date/time/datetime
// column matches the same way it renders, which a raw-value substring test
// never could. Only the status-line formatting stays here.

/**
 * Format the quick-search status line: how many of the currently loaded rows
 * matched, and — when the server holds more rows than are loaded — a note
 * that those weren't searched.
 *
 * @param matchedCount - how many loaded records matched the current query.
 * @param loadedCount - how many records are currently loaded in the store.
 * @param totalCount - the server's total row count, or undefined if unknown.
 * @returns the status line text.
 */
export function quickSearchStatus(matchedCount: number, loadedCount: number, totalCount: number | undefined): string {
    const noun = loadedCount === 1 ? "row" : "rows";
    const remainder = totalCount !== undefined && totalCount > loadedCount
        ? ` (${totalCount - loadedCount} more on the server not searched)`
        : "";

    return `${matchedCount} of ${loadedCount} loaded ${noun}${remainder}`;
}
