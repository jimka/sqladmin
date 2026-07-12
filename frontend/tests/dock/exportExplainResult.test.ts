import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DOM-bound download so the export logic is testable in node vitest.
vi.mock("../../src/data/download", () => ({ download: vi.fn() }));

import { exportExplainPlan } from "../../src/dock/exportExplainResult";
import { download }          from "../../src/data/download";
import type { PlanSource }   from "../../src/data/explain";
import type { QueryExplainResult } from "../../src/contract";

const downloadMock = vi.mocked(download);

/** A text-plan PlanSource whose runExplain returns `jsonResult` for the JSON fetch. */
function planSource(jsonResult: QueryExplainResult | Error, analyze = false): PlanSource {
    return {
        result    : { kind: "explain", format: "text", analyze, plan: "Seq Scan on t" },
        sql       : "SELECT * FROM t",
        runExplain: vi.fn(() => jsonResult instanceof Error ? Promise.reject(jsonResult) : Promise.resolve(jsonResult)),
    };
}

const jsonPlan: QueryExplainResult = { kind: "explain", format: "json", analyze: false, plan: "", planJson: [{ Plan: { NodeType: "Seq Scan" } }] };

beforeEach(() => downloadMock.mockClear());

describe("exportExplainPlan", () => {
    it("exports the held text plan as .txt without any re-fetch", async () => {
        const plan = planSource(jsonPlan);
        const notify = vi.fn();

        await exportExplainPlan(plan, "txt", notify);

        expect(downloadMock).toHaveBeenCalledWith("Seq Scan on t", "explain-plan.txt", "text/plain");
        expect(plan.runExplain).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("text"));
    });

    it("re-requests FORMAT JSON and exports the plan tree as .json", async () => {
        const plan = planSource(jsonPlan, true);
        const notify = vi.fn();

        await exportExplainPlan(plan, "json", notify);

        expect(plan.runExplain).toHaveBeenCalledWith("SELECT * FROM t", { analyze: true, format: "json" });
        expect(downloadMock).toHaveBeenCalledWith(JSON.stringify(jsonPlan.planJson, null, 2), "explain-plan.json", "application/json");
    });

    it("downloads nothing and reports when the JSON re-run returns no tree", async () => {
        const plan = planSource({ kind: "explain", format: "json", analyze: false, plan: "" });
        const notify = vi.fn();

        await exportExplainPlan(plan, "json", notify);

        expect(downloadMock).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("no JSON plan tree"));
    });

    it("downloads nothing and reports the error when the JSON re-run fails", async () => {
        const plan = planSource(new Error("boom"));
        const notify = vi.fn();

        await exportExplainPlan(plan, "json", notify);

        expect(downloadMock).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });
});
