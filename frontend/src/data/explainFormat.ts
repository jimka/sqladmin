// Pure, DOM-free number/range formatting for the EXPLAIN plan node cards. Kept
// out of ExplainNode.ts (a DOM-bound module) so the app's node-only vitest can
// red-green it directly — the range-collapse rule in particular.

// The en dash shown for an absent value.
const ABSENT = "–";

// Decimal places a fractional metric is rounded to for display.
const DECIMALS = 2;

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
