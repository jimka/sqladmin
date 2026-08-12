// TableWorkPanel's quick-search pure logic, split out so it can be
// unit-tested without pulling in the library's DOM-backed component classes
// (TableWorkPanel.ts's top-level imports touch `document` at module-load
// time, which the project's node-environment test runner has no stand-in for
// — see vitest.config.ts, and tableWriteRules.ts for the same split).

/** The subset of a ModelRecord's API this module (and recordNavigation.ts) reads. */
export interface RecordLike {
    getData(): Record<string, unknown>;
}

/**
 * Whether `record` matches a quick-search query: case-insensitive substring,
 * across every primitive (string/number/boolean) field. An empty or
 * whitespace-only query matches every record.
 *
 * @param record - the loaded record to test.
 * @param query - the raw quick-search text (not yet trimmed/lower-cased).
 * @returns whether any primitive field of `record` contains `query`.
 */
export function matchesQuickSearch(record: RecordLike, query: string): boolean {
    const needle = query.trim().toLowerCase();

    if (needle === "") {
        return true;
    }

    return Object.values(record.getData()).some(value => fieldMatches(value, needle));
}

/**
 * Whether one field's value contains the (already trimmed, lower-cased)
 * needle. Only string/number/boolean values participate — `null`/`undefined`
 * are skipped, and so is any value that is a JS object, which after
 * `Field.convertValue`'s ingestion-time coercion means `Date` values
 * (date/datetime/time fields) and parsed JSON objects/arrays (json/jsonArray
 * fields): stringifying either produces text the user never typed.
 */
function fieldMatches(value: unknown, needle: string): boolean {
    if (value === null || value === undefined || typeof value === "object") {
        return false;
    }

    return String(value).toLowerCase().includes(needle);
}

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
