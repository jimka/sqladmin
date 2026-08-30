// The table work panel's pure record-lookup logic, split out so it can be
// unit-tested without pulling in the library's DOM-backed component classes
// (TableWorkPanel.ts's top-level imports touch `document` at module-load
// time, which the project's node-environment test runner has no stand-in for
// — see vitest.config.ts). Mirrors tableWriteRules.ts, which exists for the
// same reason. Not only the record-view stepper's logic any more: also holds
// findRecordByKey, which resolves a route's `?record=` request to a loaded
// record by primary-key value.
//
// `visibleRecords` and `stepIndex` are deliberately separate: `stepIndex` is
// pure arithmetic over an index and a count, with no notion of quick search;
// `visibleRecords` narrows the record list to whatever a caller-supplied
// predicate accepts, so recordViewControls.ts's `stepRecord`/`syncStepEnabled`
// compose the two (`stepIndex(visibleRecords(records, matches).indexOf(current),
// delta, ...)`) to make Previous/Next skip records the current quick-search
// query doesn't match. The predicate itself is gridQuickSearch.ts's
// `matchesQuery`, which recordViewControls.ts supplies, built against the
// grid's own `Table.getCellText` — matching what the library's
// `Table.setQuickSearch` hides/shows — rather than here, since testing it
// needs no DOM-backed `Table` at all.

/**
 * The loaded records for which `matches` returns true, in their original
 * order — the subset Previous/Next should step through. Generic so the
 * duck-typed stand-ins `recordNavigation.test.ts` uses also satisfy it.
 *
 * @param records - the loaded records (unfiltered).
 * @param matches - the current quick-search predicate; a caller with no
 *   active search passes a predicate that always returns `true`.
 * @returns the records `matches` accepts.
 */
export function visibleRecords<T>(records: T[], matches: (record: T) => boolean): T[] {
    return records.filter(matches);
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

/** The minimum a record must expose to be addressed by its primary-key value. */
export interface KeyedRecord {
    getId(): unknown;
}

/**
 * The first record whose primary-key value stringifies to `key`, or undefined
 * when none does. A record with no primary key (`getId()` undefined or null)
 * never matches.
 *
 * @param records - The loaded records to search, in their original order.
 * @param key - The primary-key value from the route's `record` parameter.
 * @returns The matching record, or undefined.
 */
export function findRecordByKey<T extends KeyedRecord>(records: T[], key: string): T | undefined {
    return records.find(record => {
        const id = record.getId();

        return id !== undefined && id !== null && String(id) === key;
    });
}
