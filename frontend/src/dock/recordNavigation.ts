// The record-view stepper's pure logic, split out so it can be unit-tested
// without pulling in the library's DOM-backed component classes
// (TableWorkPanel.ts's top-level imports touch `document` at module-load
// time, which the project's node-environment test runner has no stand-in for
// — see vitest.config.ts). Mirrors tableWriteRules.ts, which exists for the
// same reason.
//
// `visibleRecords` and `stepIndex` are deliberately separate: `stepIndex` is
// pure arithmetic over an index and a count, with no notion of quick search;
// `visibleRecords` narrows the record list quick search would apply, so
// TableWorkPanel.ts's `stepRecord`/`syncStepEnabled` compose the two
// (`stepIndex(visibleRecords(records, query).indexOf(current), delta,
// ...)`) to make Previous/Next skip records the current quick-search query
// doesn't match — see quickSearchModel.ts's `matchesQuickSearch`, which
// `visibleRecords` filters through.

import { matchesQuickSearch } from "./quickSearchModel";
import type { RecordLike }    from "./quickSearchModel";

/**
 * The loaded records that currently match `query`, in their original order —
 * the subset Previous/Next should step through. A blank/whitespace-only
 * query matches every record (see `matchesQuickSearch`), so passing one
 * through unconditionally is safe and returns `records` filtered to itself.
 * Generic (rather than typed directly to `ModelRecord`) so the duck-typed
 * stand-in `quickSearchModel.test.ts`'s own tests use also satisfies it.
 *
 * @param records - the loaded records (unfiltered).
 * @param query - the raw quick-search text (not yet trimmed/lower-cased).
 * @returns the records matching `query`.
 */
export function visibleRecords<T extends RecordLike>(records: T[], query: string): T[] {
    return records.filter(r => matchesQuickSearch(r, query));
}

/**
 * The index to step to, or null when there is nowhere to go.
 *
 * The result is `currentIndex + delta` clamped into `[0, count - 1]`, and
 * null when that clamp lands back on `currentIndex` (already at an end) or
 * the store holds no records at all.
 *
 * @param currentIndex - Index of the displayed record, or -1 when none is displayed.
 * @param delta        - -1 for the previous record, 1 for the next.
 * @param count        - Number of records currently loaded.
 *
 * @returns The target index, or null when the step would not move.
 */
export function stepIndex(currentIndex: number, delta: number, count: number): number | null {
    if (count === 0) {
        return null;
    }

    const target = Math.min(Math.max(currentIndex + delta, 0), count - 1);

    return target === currentIndex ? null : target;
}
