// Pure, DOM-free parser turning a Postgres `EXPLAIN (FORMAT JSON)` payload into
// a plan-node forest for the diagram + tree. Kept beside explain.ts so the app's
// node-only vitest can red-green it without a backend or a DOM; it imports no
// UI-bundle code (the diagram builder that consumes it does the same, see
// buildExplainDiagram.ts) so importing it never triggers a component module's
// DOM-touching side effects under the node test environment.

/** One key metric shown for a plan node (numeric so tests can assert it). */
export interface ExplainMetric {
    /** Display label, e.g. "cost", "rows", "actual time (ms)". */
    label: string;
    /** The finite numeric value read from the source plan field. */
    value: number;
}

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
    /** cost/rows/width (+ actual-* when analyze), in fixed order, finite only. */
    metrics: ExplainMetric[];
    /** Child plan nodes (from the source "Plans" array). */
    children: ExplainPlanNode[];
}

/** One metric's display label paired with the source field it reads from. */
interface MetricSpec {
    label: string;
    field: string;
}

// The plan metrics every EXPLAIN carries (cost/rows/width), then the analyze-only
// timing metrics — pushed in this order so a node's metric list reads plan-first,
// actuals-second, matching the text plan's own left-to-right ordering.
const METRIC_SPECS: readonly MetricSpec[] = [
    { label: "cost",             field: "Total Cost" },
    { label: "rows",             field: "Plan Rows" },
    { label: "width",            field: "Plan Width" },
    { label: "actual time (ms)", field: "Actual Total Time" },
    { label: "actual rows",      field: "Actual Rows" },
    { label: "loops",            field: "Actual Loops" },
];

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
        metrics: collectMetrics(plan),
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
 * Collect a node's metrics in {@link METRIC_SPECS} order, pushing each only when
 * its source field is a finite number (so a plain plan omits the actual-* four
 * and a missing optional field is skipped rather than emitted as NaN).
 *
 * @param plan - The raw Plan object.
 *
 * @returns The finite metrics, in fixed order.
 */
function collectMetrics(plan: Record<string, unknown>): ExplainMetric[] {
    const metrics: ExplainMetric[] = [];

    for (const spec of METRIC_SPECS) {
        const value = plan[spec.field];

        if (typeof value === "number" && Number.isFinite(value)) {
            metrics.push({ label: spec.label, value });
        }
    }

    return metrics;
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
