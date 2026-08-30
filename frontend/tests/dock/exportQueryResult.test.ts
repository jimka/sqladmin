import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DOM-bound download so the export logic is testable in node vitest.
vi.mock("../../src/data/download", () => ({ download: vi.fn() }));

import { exportQueryResult } from "../../src/dock/exportQueryResult";
import { download }          from "../../src/data/download";
import type { QueryRowsResult } from "../../src/contract";

const downloadMock = vi.mocked(download);

/** A rows result over the fixture columns, with `rows`/`rowCount` overridable per case. */
function rowsResult(rows: Record<string, unknown>[], rowCount: number): QueryRowsResult {
    return {
        kind: "rows",
        columns: [
            { name: "id", wireType: "number" },
            { name: "name", wireType: "string" },
        ],
        rows,
        rowCount,
        truncated: false,
    };
}

const fixtureRows = [{ id: 1, name: "ada" }, { id: 2, name: "b, c" }];

beforeEach(() => downloadMock.mockClear());

describe("exportQueryResult", () => {
    it("downloads a CRLF-terminated CSV and reports the row count", () => {
        const notify = vi.fn();

        exportQueryResult(rowsResult(fixtureRows, 2), "csv", notify);

        expect(downloadMock).toHaveBeenCalledWith(
            "id,name\r\n1,ada\r\n2,\"b, c\"\r\n", "query-result.csv", "text/csv",
        );
        expect(notify).toHaveBeenCalledWith("exported 2 row(s) as CSV");
    });

    it("downloads a 2-space-indented JSON array and reports the row count", () => {
        const notify = vi.fn();

        exportQueryResult(rowsResult(fixtureRows, 2), "json", notify);

        expect(downloadMock).toHaveBeenCalledWith(
            JSON.stringify([{ id: 1, name: "ada" }, { id: 2, name: "b, c" }], null, 2),
            "query-result.json", "application/json",
        );
        expect(notify).toHaveBeenCalledWith("exported 2 row(s) as JSON");
    });

    it("still downloads a header-only CSV for an empty result and reports 0 rows", () => {
        const notify = vi.fn();

        exportQueryResult(rowsResult([], 0), "csv", notify);

        expect(downloadMock).toHaveBeenCalledWith("id,name\r\n", "query-result.csv", "text/csv");
        expect(notify).toHaveBeenCalledWith("exported 0 row(s) as CSV");
    });
});
