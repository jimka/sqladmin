// The sidebar accordion's "fill" hint. The Accordion has no per-section fill
// weight (see LIBRARY_NOTES.md), so a section that should absorb the leftover
// height is given a preferred height large enough to always overflow: the
// accordion's proportional shrink then hands it every pixel the fixed-height
// sections leave. Used by the tree explorers and the Queries lists.

/** Outsized preferred height that makes a sidebar section claim the leftover space. */
export const SIDEBAR_FILL_HINT = 10000;
