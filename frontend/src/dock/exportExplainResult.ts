// Export a displayed EXPLAIN plan as a file: the FORMAT TEXT plan verbatim as a
// `.txt`, or the structured FORMAT JSON plan tree as a `.json`. The text plan is
// already on screen so its export is synchronous; the JSON tree is fetched on
// demand (a second EXPLAIN — an ANALYZE re-executes, rolled back on the backend)
// so a user who only ever wants the text view never pays for it.
//
// DOM-bound (it calls download()) and so manual-verify, mirroring
// exportQueryResult; the read-only classifier and SQL builder it leans on are
// unit-tested in their own pure modules.

import { download }          from "../data/download";
import type { PlanSource }    from "../data/explain";

// The MIME types the two plan exports download as.
const TEXT_MIME = "text/plain";
const JSON_MIME = "application/json";

// Pretty-print indent for the exported JSON plan tree (readable, not minified).
const JSON_INDENT = 2;

/**
 * Export a work panel's displayed EXPLAIN plan, downloading the file and
 * reporting the outcome.
 *
 * `"txt"` writes the plan text already held in `plan.result` — no round-trip.
 * `"json"` re-runs the same statement as EXPLAIN (FORMAT JSON) via
 * `plan.runExplain` to obtain the structured tree, then writes it; a failed
 * re-run (or a plan with no JSON tree) reports through `notify` and downloads
 * nothing.
 *
 * @param plan - The displayed plan plus the SQL/runner needed to re-fetch JSON.
 * @param format - The export format, "txt" (plan text) or "json" (plan tree).
 * @param notify - Reports the outcome (or the failure) to the status line.
 */
export async function exportExplainPlan(
    plan: PlanSource,
    format: "txt" | "json",
    notify: (message: string) => void,
): Promise<void> {
    if (format === "txt") {
        download(plan.result.plan, "explain-plan.txt", TEXT_MIME);
        notify("exported the EXPLAIN plan as text");

        return;
    }

    // JSON: re-request the same statement as a FORMAT JSON plan tree. The text
    // view holds no tree, so this is the one place a plan export does I/O.
    try {
        const json = await plan.runExplain(plan.sql, { analyze: plan.result.analyze, format: "json" });

        if (json.planJson === undefined || json.planJson === null) {
            notify("no JSON plan tree was returned");

            return;
        }

        download(JSON.stringify(json.planJson, null, JSON_INDENT), "explain-plan.json", JSON_MIME);
        notify("exported the EXPLAIN plan as JSON");
    } catch (error) {
        notify(`could not export the JSON plan: ${error instanceof Error ? error.message : String(error)}`);
    }
}
