// The two base ELK layout-options objects the diagram builders share: a
// left-to-right layered layout for dependency-style graphs (FK graphs, role
// grants, role membership) and a top-down layered layout for hierarchy-style
// graphs (EXPLAIN plans, inheritance). Shared by reference and passed straight
// through by relationDiagram.ts and groupBySchema.ts, so no consumer may
// mutate either object — a caller needing extra options spreads one of these
// into a new object instead.

/** Left-to-right layered ELK layout: dependency/reference flows. */
export const LAYERED_RIGHT: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
};

/** Top-down layered ELK layout: hierarchy/parent-child flows. */
export const LAYERED_DOWN: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
};
