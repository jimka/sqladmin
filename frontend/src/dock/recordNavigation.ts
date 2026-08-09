// The record-view stepper's pure arithmetic, split out so it can be
// unit-tested without pulling in the library's DOM-backed component classes
// (TableWorkPanel.ts's top-level imports touch `document` at module-load
// time, which the project's node-environment test runner has no stand-in for
// — see vitest.config.ts). Mirrors tableWriteRules.ts, which exists for the
// same reason.

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
