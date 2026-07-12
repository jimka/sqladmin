// Pure, DOM-free flattening of a parsed EXPLAIN plan forest into one flat row
// per node for the "Plan steps" table: a depth-first (plan-order) list carrying
// the node's action plus its *raw* numeric metrics, so the table sorts them
// numerically (not lexically) and can reveal any column. The property names are
// the table's column headers verbatim (the library Table shows a field by its
// name), so a row object doubles as a MemoryStore record. Imports only the
// parsed model — no DOM, no UI-bundle code — so the app's node-only vitest can
// red-green it (mirrors buildExplainDiagram's purity note).

import type { ExplainPlanNode } from "./parseExplainPlan";

/**
 * One flat plan-steps row. Keys are the column headers the table renders; the
 * numeric metrics stay raw (not formatted) so sorting compares magnitudes. Every
 * metric is optional — absent when the node does not report it (e.g. no analyze
 * timings on a plain EXPLAIN).
 */
export interface PlanStepRow {
    /** The node's one-line heading, e.g. "Seq Scan on users". */
    "Action": string;
    /** "Total Cost" — the cumulative estimated cost. */
    "Cost"?: number;
    /** "Plan Rows" — the planner's estimated per-loop output rows. */
    "Expected Rows"?: number;
    /** "Actual Rows" — the measured per-loop output rows (analyze only). */
    "Actual Rows"?: number;
    /** "Plan Width" — the estimated average output row width, in bytes. */
    "Width"?: number;
    /** "Actual Total Time" (ms, per loop) — analyze only. */
    "Time"?: number;
    /** "Hash Batches" — batches a hash node spilled into (1 = fully in memory). */
    "Batches"?: number;
    /** "Group Key" expressions, comma-joined. */
    "Group"?: string;
    /** "Peak Memory Usage" (kB). */
    "Memory"?: number;
}

/**
 * Flatten a parsed plan forest into one {@link PlanStepRow} per node, in
 * depth-first order — the same order the text plan reads (parent before its
 * children), which the steps table uses as its default (unsorted) order.
 *
 * @param roots - The parsed plan roots (from `parseExplainPlan`).
 *
 * @returns One row per node, in plan order; `[]` for an empty forest.
 */
export function buildPlanStepsRows(roots: ExplainPlanNode[]): PlanStepRow[] {
    const rows: PlanStepRow[] = [];

    const walk = (node: ExplainPlanNode): void => {
        rows.push(toRow(node));

        for (const child of node.children) {
            walk(child);
        }
    };

    for (const root of roots) {
        walk(root);
    }

    return rows;
}

/**
 * Build one flat row from a plan node: its action label plus each metric the
 * node reports. A metric absent from the node is left off the row (so it renders
 * blank and sorts to the end) rather than coerced to zero.
 *
 * @param node - The plan node.
 *
 * @returns The flat row for this node.
 */
function toRow(node: ExplainPlanNode): PlanStepRow {
    const row: PlanStepRow = { "Action": node.label };

    if (node.totalCost !== undefined) {
        row["Cost"] = node.totalCost;
    }

    if (node.planRows !== undefined) {
        row["Expected Rows"] = node.planRows;
    }

    if (node.actualRows !== undefined) {
        row["Actual Rows"] = node.actualRows;
    }

    if (node.planWidth !== undefined) {
        row["Width"] = node.planWidth;
    }

    if (node.actualTotalTime !== undefined) {
        row["Time"] = node.actualTotalTime;
    }

    if (node.hashBatches !== undefined) {
        row["Batches"] = node.hashBatches;
    }

    if (node.groupKey && node.groupKey.length > 0) {
        row["Group"] = node.groupKey.join(", ");
    }

    if (node.peakMemoryUsage !== undefined) {
        row["Memory"] = node.peakMemoryUsage;
    }

    return row;
}
