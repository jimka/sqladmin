// The app's toolbar-action color palette. Every glyph-tinted toolbar and dialog
// button picks its tint from here, so the same semantic action reads the same
// color across every panel. These are app-level semantics the library theme does
// not model (run = green, delete = red, …); centralizing them keeps one source of
// truth and prevents the per-file drift this module replaced (two near-identical
// blues, two reds, two muted greys had crept in across the panels).

/** Informational / primary actions — refresh, open, save, export. */
export const PRIMARY_COLOR = "rgb(30, 100, 200)";

/** Constructive actions — run a query, add a row, add a filter condition. */
export const CONSTRUCTIVE_COLOR = "rgb(46, 125, 50)";

/** Destructive actions — delete a row, remove a condition or a saved query. */
export const DESTRUCTIVE_COLOR = "rgb(198, 40, 40)";

/**
 * Caution — an action that discards input or executes with side effects: Clear,
 * Explain Analyze. Distinct from the green constructive actions, but without the
 * finality of destructive red.
 */
export const CAUTION_COLOR = "rgb(204, 102, 0)";

/**
 * Neutral, no-warning action — plain Explain: it neither mutates input nor
 * executes the statement, so it carries no warning color.
 */
export const NEUTRAL_COLOR = "rgb(66, 66, 66)";

/** Secondary navigation kept visually quieter than the colored actions — query history. */
export const HISTORY_COLOR = "rgb(90, 90, 90)";

/** Active-filter indicator tint (the filter button while a filter is applied). */
export const FILTER_ACTIVE_COLOR = "rgb(230, 145, 30)";

/** Secondary / hint text — start-page lines, dialog captions, empty-state hints. */
export const MUTED_TEXT_COLOR = "rgb(140, 140, 140)";
