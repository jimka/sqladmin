// A defensive render cap for query result sets. The library has a known open bug
// (LIBRARY_NOTES.md) where a large MemoryStore.loadData (~1500+ rows) renders
// ZERO rows in a Table, so a big query would silently show an empty grid. The
// QueryPanel caps its result at MAX_RESULT_ROWS before building the store and
// tells the user the grid is partial. This is a pure slice so it is unit-testable
// offline, apart from the DOM-bound QueryPanel that consumes it.

// The render cap, set safely below the library's ~1500-row zero-render threshold
// so the grid always renders. This is a rendering limit only — the backend still
// returns the whole result; full pagination is a Non-Goal (backlog).
export const MAX_RESULT_ROWS = 1000;

/**
 * Cap a result-row array to at most `max` rows, returning the original array
 * unchanged when it already fits (so no needless copy is made).
 *
 * @param rows - The full result rows.
 * @param max - The maximum number of rows to keep.
 *
 * @returns The original array when `rows.length <= max`, else its first `max` rows.
 */
export function capRows<T>(rows: T[], max: number): T[] {
    return rows.length > max ? rows.slice(0, max) : rows;
}
