// Pure, DOM-free number/range formatting for the EXPLAIN plan node cards. Kept
// out of ExplainNode.ts (a DOM-bound module) so the app's node-only vitest can
// red-green it directly — the range-collapse rule in particular.

// The en dash shown for an absent value.
const ABSENT = "–";

// Decimal places a fractional metric is rounded to for display.
const DECIMALS = 2;

// Compact row-count thresholds: divide by the factor and append the suffix once a
// count reaches it, so an edge label reads "1.2k" / "3.4M" instead of a long
// digit run. Ordered largest-first so the first match wins.
const ROW_UNITS: readonly [number, string][] = [
    [1_000_000_000, "B"],
    [1_000_000,     "M"],
    [1_000,         "k"],
];

// Above this scaled value a compacted count drops its decimal (e.g. 123.4k → 123k)
// to keep the label short.
const COMPACT_WHOLE_AT = 100;

/**
 * Format a number compactly: integers as-is, fractions rounded to two decimals
 * with trailing zeros trimmed; `undefined` renders as an en dash.
 *
 * @param n - The number to format.
 *
 * @returns The formatted string.
 */
export function formatMetric(n: number | undefined): string {
    if (n === undefined) {
        return ABSENT;
    }

    if (Number.isInteger(n)) {
        return String(n);
    }

    return parseFloat(n.toFixed(DECIMALS)).toString();
}

/**
 * Format a `min … max` range, collapsing to a single value when only one end is
 * present or when both ends format identically (so two values that differ only
 * below the displayed precision read as one number, not a `12.5 … 12.5` range).
 *
 * @param min - The low end (e.g. startup cost / time).
 * @param max - The high end (e.g. total cost / time).
 *
 * @returns The formatted range.
 */
export function formatRange(min: number | undefined, max: number | undefined): string {
    if (min !== undefined && max !== undefined) {
        const low  = formatMetric(min);
        const high = formatMetric(max);

        return low === high ? low : `${low} … ${high}`;
    }

    return formatMetric(min ?? max);
}

/**
 * Format a row count compactly for an edge label: counts below 1000 verbatim,
 * larger ones divided down to a `k` / `M` / `B` suffix with one decimal (dropped
 * once the scaled value reaches {@link COMPACT_WHOLE_AT}).
 *
 * @param n - The row count (assumed a non-negative integer).
 *
 * @returns The compact string, e.g. "999", "1.2k", "3.4M".
 */
export function formatRowCount(n: number): string {
    for (const [factor, suffix] of ROW_UNITS) {
        if (n >= factor) {
            const scaled = n / factor;
            const value  = scaled >= COMPACT_WHOLE_AT ? Math.round(scaled) : parseFloat(scaled.toFixed(1));

            return `${value}${suffix}`;
        }
    }

    return String(n);
}
