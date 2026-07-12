// Pure, DOM-free parser turning a Postgres `EXPLAIN (FORMAT JSON)` payload into
// a plan-node forest for the diagram + tree. Kept beside explain.ts so the app's
// node-only vitest can red-green it without a backend or a DOM; it imports no
// UI-bundle code (the diagram builder and node renderer that consume it read
// these plain fields) so importing it never triggers a component module's
// DOM-touching side effects under the node test environment.

/** A parsed EXPLAIN plan node; the tree and diagram share these ids. */
export interface ExplainPlanNode {
    /** Stable path id: root "0", child k of P → `${P}/${k}`. */
    id: string;
    /** The node's "Node Type", e.g. "Seq Scan". */
    nodeType: string;
    /** One-line display heading, e.g. "Seq Scan on users". */
    label: string;
    /** The node's "Relation Name" when the source carries one. */
    relationName?: string;

    /** "Startup Cost" — the estimated cost before the first row is returned. */
    startupCost?: number;
    /** "Total Cost" — the estimated cost to return all rows (cumulative). */
    totalCost?: number;
    /** "Plan Rows" — the estimated output row count. */
    planRows?: number;
    /** "Plan Width" — the estimated average output row width, in bytes. */
    planWidth?: number;

    /** "Actual Startup Time" (ms) — analyze only. */
    actualStartupTime?: number;
    /** "Actual Total Time" (ms, per loop) — analyze only. */
    actualTotalTime?: number;
    /** "Actual Rows" (per loop) — analyze only. */
    actualRows?: number;
    /** "Actual Loops" — how many times the node ran; analyze only. */
    actualLoops?: number;

    /** "Group Key" — the grouping expressions of an aggregate/group node. */
    groupKey?: string[];
    /** "Hash Batches" — batches a hash node spilled into (1 = fully in memory). */
    hashBatches?: number;
    /** "Peak Memory Usage" (kB) — peak working memory of a hash/sort node. */
    peakMemoryUsage?: number;

    /** Child plan nodes (from the source "Plans" array). */
    children: ExplainPlanNode[];
}

/** The top-level EXPLAIN timing summary (ms), sitting beside "Plan" — not in it. */
export interface ExplainSummary {
    /** "Planning Time" (ms) — the time spent planning the query. */
    planningTime?: number;
    /** "Execution Time" (ms) — the total run time; present only with ANALYZE. */
    executionTime?: number;
}

/**
 * Parse the top-level "Planning Time" / "Execution Time" (ms) that sit beside
 * "Plan" on the first statement entry of a Postgres `EXPLAIN (FORMAT JSON)`
 * payload — the summary times, not the per-node fields inside the plan tree.
 * Tolerant of shape: returns an empty summary for anything that is not an array
 * whose first element is an object, and drops a non-finite time.
 *
 * @param planJson - The raw `QueryExplainResult.planJson` (typed unknown).
 *
 * @returns The planning/execution times, each `undefined` when absent.
 */
export function parseExplainSummary(planJson: unknown): ExplainSummary {
    const entry = Array.isArray(planJson) && isObject(planJson[0]) ? planJson[0] : undefined;

    if (!entry) {
        return {};
    }

    return {
        planningTime : num(entry, "Planning Time"),
        executionTime: num(entry, "Execution Time"),
    };
}

/**
 * Parse a Postgres `EXPLAIN (FORMAT JSON)` payload into a plan-node forest.
 * Tolerant of shape: returns `[]` for anything that is not an array of objects
 * each carrying a "Plan" object.
 *
 * @param planJson - The raw `QueryExplainResult.planJson` (typed unknown).
 *
 * @returns The root plan nodes (usually one), or `[]` when malformed/empty.
 */
export function parseExplainPlan(planJson: unknown): ExplainPlanNode[] {
    if (!Array.isArray(planJson)) {
        return [];
    }

    const roots: ExplainPlanNode[] = [];

    for (const entry of planJson) {
        const plan = isObject(entry) ? entry["Plan"] : undefined;

        if (isObject(plan)) {
            roots.push(parseNode(plan, String(roots.length)));
        }
    }

    return roots;
}

/**
 * Parse one raw Plan object (and its "Plans" subtree) into an ExplainPlanNode.
 *
 * @param plan - The raw Plan object.
 * @param id - The stable path id to assign this node.
 *
 * @returns The parsed node with its children.
 */
function parseNode(plan: Record<string, unknown>, id: string): ExplainPlanNode {
    const nodeType     = typeof plan["Node Type"] === "string" ? plan["Node Type"] as string : "";
    const relationName = typeof plan["Relation Name"] === "string" ? plan["Relation Name"] as string : undefined;
    const rawChildren  = plan["Plans"];

    const children = Array.isArray(rawChildren)
        ? rawChildren
            .filter(isObject)
            .map((child, k) => parseNode(child, `${id}/${k}`))
        : [];

    return {
        id,
        nodeType,
        label: nodeLabel(nodeType, relationName, plan["Alias"]),
        relationName,

        startupCost: num(plan, "Startup Cost"),
        totalCost  : num(plan, "Total Cost"),
        planRows   : num(plan, "Plan Rows"),
        planWidth  : num(plan, "Plan Width"),

        actualStartupTime: num(plan, "Actual Startup Time"),
        actualTotalTime  : num(plan, "Actual Total Time"),
        actualRows       : num(plan, "Actual Rows"),
        actualLoops      : num(plan, "Actual Loops"),

        groupKey       : stringArray(plan, "Group Key"),
        hashBatches    : num(plan, "Hash Batches"),
        peakMemoryUsage: num(plan, "Peak Memory Usage"),

        children,
    };
}

/**
 * Build a node's one-line display heading: node type, "on" the relation when
 * present, with the alias in parentheses only when it differs from the relation
 * name (an aliased self-join, or a subquery/CTE scan whose alias is the only name).
 *
 * @param nodeType - The node's "Node Type".
 * @param relationName - The node's "Relation Name", if any.
 * @param alias - The node's raw "Alias" value (unknown until narrowed).
 *
 * @returns The single-line heading.
 */
function nodeLabel(nodeType: string, relationName: string | undefined, alias: unknown): string {
    const base = relationName ? `${nodeType} on ${relationName}` : nodeType;

    if (typeof alias === "string" && alias !== "" && alias !== relationName) {
        return `${base} (${alias})`;
    }

    return base;
}

/**
 * Read a finite numeric field, or `undefined` when it is absent or not a finite
 * number (so a missing/non-finite source value is dropped, never surfaced as NaN).
 *
 * @param plan - The raw Plan object.
 * @param field - The source field name.
 *
 * @returns The finite number, or `undefined`.
 */
function num(plan: Record<string, unknown>, field: string): number | undefined {
    const value = plan[field];

    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a field that is an array of strings (e.g. "Group Key"), or `undefined`
 * when it is absent or not such an array.
 *
 * @param plan - The raw Plan object.
 * @param field - The source field name.
 *
 * @returns The string array, or `undefined`.
 */
function stringArray(plan: Record<string, unknown>, field: string): string[] | undefined {
    const value = plan[field];

    if (Array.isArray(value) && value.every(v => typeof v === "string")) {
        return value as string[];
    }

    return undefined;
}

/**
 * Narrow an unknown to a plain object (non-null, non-array) so its string-keyed
 * fields can be read.
 *
 * @param value - The value to test.
 *
 * @returns True when `value` is a non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
