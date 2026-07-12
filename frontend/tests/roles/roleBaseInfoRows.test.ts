import { describe, it, expect } from "vitest";
import { roleBaseInfoRows } from "./roleBaseInfoRows";
import type { RoleDetail, RoleSummary } from "../contract";

function summary(overrides: Partial<RoleSummary> = {}): RoleSummary {
    return {
        name: "app",
        canLogin: true,
        isSuperuser: false,
        inherit: true,
        createRole: false,
        createDb: false,
        replication: false,
        connectionLimit: -1,
        validUntil: null,
        ...overrides,
    };
}

function detail(overrides: Partial<RoleDetail> = {}): RoleDetail {
    return { role: summary(), memberOf: [], privileges: [], ...overrides };
}

describe("roleBaseInfoRows", () => {
    it("maps the nine attributes in order with yes/no and sentinels", () => {
        const rows = roleBaseInfoRows(detail());

        expect(rows).toEqual([
            { property: "Name", value: "app" },
            { property: "Can login", value: "Yes" },
            { property: "Superuser", value: "No" },
            { property: "Inherit", value: "Yes" },
            { property: "Create role", value: "No" },
            { property: "Create DB", value: "No" },
            { property: "Replication", value: "No" },
            { property: "Connection limit", value: "No limit" },
            { property: "Valid until", value: "—" },
        ]);
    });

    it("renders a positive connection limit as its number", () => {
        const rows = roleBaseInfoRows(detail({ role: summary({ connectionLimit: 5 }) }));

        expect(rows.find(r => r.property === "Connection limit")!.value).toBe("5");
    });

    it("renders a set validUntil as its ISO string", () => {
        const iso = "2030-01-02T03:04:05";
        const rows = roleBaseInfoRows(detail({ role: summary({ validUntil: iso }) }));

        expect(rows.find(r => r.property === "Valid until")!.value).toBe(iso);
    });

    it("appends one 'Member of' row per membership, flagging admin", () => {
        const rows = roleBaseInfoRows(
            detail({ memberOf: [{ roleName: "app_rw", admin: true }, { roleName: "app_ro", admin: false }] }),
        );

        const members = rows.filter(r => r.property === "Member of").map(r => r.value);
        expect(members).toEqual(["app_rw (admin)", "app_ro"]);
    });

    it("excludes grant rows — grants live in the Dock grants table, not the sidebar", () => {
        const rows = roleBaseInfoRows(
            detail({ privileges: [{ schema: "public", table: "t", privilege: "SELECT", grantable: true }] }),
        );

        expect(rows.some(r => r.property === "Grant")).toBe(false);
    });

    it("shows only the attribute rows when there are no memberships", () => {
        const rows = roleBaseInfoRows(detail());

        expect(rows).toHaveLength(9);
    });
});
