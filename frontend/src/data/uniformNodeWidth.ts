// One width for every node in a flat (non-card) diagram, so a layer's nodes
// share a left and right edge. No DOM — the width is estimated from label
// length rather than measured, which is what keeps this pure and lets the
// builders that use it stay node-vitest-testable (see buildSchemaDiagram.ts's
// header note on never importing UI-bundle runtime code).

/**
 * Rendered width per label character, in pixels.
 *
 * Empirical: a least-squares fit of node width against label length over all
 * 154 nodes of the `mesh` schema diagram gave `width = 6.766 * characters +
 * 45.46`, with a maximum residual of 14.2px. Rounded up slightly, since
 * under-estimating clips a label while over-estimating only adds whitespace.
 * Re-derive this if the diagram node's font or padding changes.
 */
const LABEL_CHAR_WIDTH = 6.8;

/**
 * Fixed width a node spends on everything that is not label text: the glyph,
 * the gap after it, and the node's own padding and border. The intercept of the
 * same fit, rounded up.
 */
const NODE_CHROME_WIDTH = 46;

/**
 * Slack added on top of the fit, in pixels.
 *
 * The font is proportional, so a label of all-wide characters ("WWWW") renders
 * past what a per-character average predicts — the fit's residual reached
 * 14.2px on real table names. This covers that without reaching the ~50px a
 * whole extra character band would cost.
 */
const LABEL_WIDTH_MARGIN = 16;

/**
 * Narrowest node worth drawing, in pixels. A graph of one- or two-character
 * labels would otherwise produce nodes too small to read as tables or to click
 * comfortably, and it also gives an empty graph a sane answer.
 */
const MIN_NODE_WIDTH = 96;

/**
 * The single width every node of a flat diagram should be given, wide enough
 * for the longest label in the graph.
 *
 * Flat-mode nodes are otherwise sized to their own label, so widths vary (72px
 * to 182px on the `mesh` schema) and ELK staggers a layer's nodes by up to 85px
 * — the columns stop reading as columns. Feeding one width for all of them via
 * `DiagramNodeData.width` restores the alignment that card mode gets for free
 * from its fixed `CARD_WIDTH`.
 *
 * @param labels - Every node label in the graph; entries may be empty.
 * @returns The width to set on every node, a whole number of pixels.
 */
export function uniformNodeWidth(labels: string[]): number {
    const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
    const fitted = longest * LABEL_CHAR_WIDTH + NODE_CHROME_WIDTH + LABEL_WIDTH_MARGIN;

    return Math.max(MIN_NODE_WIDTH, Math.ceil(fitted));
}
