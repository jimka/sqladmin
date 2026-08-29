import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DOM-bound download so the export logic is testable in node vitest.
vi.mock("../../src/data/download", () => ({ download: vi.fn() }));

import { exportRoleGrants } from "../../src/dock/exportRoleGrants";
import { download }         from "../../src/data/download";
import type { RolePrivilege } from "../../src/contract";

const downloadMock = vi.mocked(download);

const fixturePrivileges: RolePrivilege[] = [
    { schema: "public", table: "t", privilege: "SELECT", grantable: false },
];

beforeEach(() => downloadMock.mockClear());

describe("exportRoleGrants", () => {
    it("writes the fixed four-column CSV header and renders grantable as true/false", () => {
        exportRoleGrants("app_ro", fixturePrivileges, "csv");

        expect(downloadMock).toHaveBeenCalledWith(
            "schema,table,privilege,grantable\r\npublic,t,SELECT,false\r\n",
            "app_ro.grants.csv", "text/csv",
        );
    });

    it("names the download after the role plus .grants.<format>", () => {
        exportRoleGrants("app_ro", fixturePrivileges, "json");

        expect(downloadMock).toHaveBeenCalledWith(
            JSON.stringify([{ schema: "public", table: "t", privilege: "SELECT", grantable: false }], null, 2),
            "app_ro.grants.json", "application/json",
        );
    });

    it("still downloads a header-only CSV for a role with no grants", () => {
        exportRoleGrants("app_ro", [], "csv");

        expect(downloadMock).toHaveBeenCalledWith(
            "schema,table,privilege,grantable\r\n", "app_ro.grants.csv", "text/csv",
        );
    });
});
