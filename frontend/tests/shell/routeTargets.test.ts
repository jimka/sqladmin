import { describe, it, expect } from "vitest";
import {
    RELATION_KINDS, ROLE_BUCKETS, relationView, schemaView, roleView, routeFlag,
    ROLE_BUCKET_SECTIONS, objectPath, rolePath, databaseDiagramPath, notesPath, queryHistoryPath, resolveAddressBarRoute,
} from "../../src/shell/routeTargets";
import type { PanelRoute } from "../../src/shell/routeTargets";
import type { DbObjectRef } from "../../src/contract";
import type { HistoryEntry } from "../../src/data/queryStore";

/** Build a HistoryEntry with sensible defaults for the field under test. */
function entry(timestamp: number, sql: string = "select 1"): HistoryEntry {
    return { sql, timestamp, ok: true, rowCount: 0 };
}

describe("RELATION_KINDS", () => {
    it("has exactly three entries, one per relation kind", () => {
        expect(RELATION_KINDS).toHaveLength(3);
    });

    it("maps each URL segment to its DbObjectKind", () => {
        expect(RELATION_KINDS).toContainEqual({ segment: "table", kind: "table" });
        expect(RELATION_KINDS).toContainEqual({ segment: "view", kind: "view" });
        expect(RELATION_KINDS).toContainEqual({ segment: "matview", kind: "materializedView" });
    });
});

describe("ROLE_BUCKETS", () => {
    it("has exactly three entries, in RolesTree's Users/Groups/Predefined order", () => {
        expect(ROLE_BUCKETS).toEqual(["user", "group", "predefined"]);
    });
});

describe("relationView", () => {
    it("allows structure for every relation kind", () => {
        expect(relationView("table", "structure")).toBe("structure");
        expect(relationView("view", "structure")).toBe("structure");
        expect(relationView("materializedView", "structure")).toBe("structure");
    });

    it("rejects definition for a table", () => {
        expect(relationView("table", "definition")).toBeNull();
    });

    it("allows definition for a view or materialized view", () => {
        expect(relationView("view", "definition")).toBe("definition");
        expect(relationView("materializedView", "definition")).toBe("definition");
    });

    it("allows inheritance only for a table", () => {
        expect(relationView("table", "inheritance")).toBe("inheritance");
        expect(relationView("view", "inheritance")).toBeNull();
    });

    it("allows diagram for every relation kind", () => {
        expect(relationView("materializedView", "diagram")).toBe("diagram");
    });

    it("rejects a segment naming no known view, and a bare empty segment", () => {
        expect(relationView("table", "bogus")).toBeNull();
        expect(relationView("table", "")).toBeNull();
    });
});

describe("schemaView", () => {
    it("recognizes every schema view segment", () => {
        expect(schemaView("diagram")).toBe("diagram");
        expect(schemaView("dependencies")).toBe("dependencies");
        expect(schemaView("inheritance")).toBe("inheritance");
    });

    it("rejects a segment naming no known schema view, and a bare empty segment", () => {
        expect(schemaView("structure")).toBeNull();
        expect(schemaView("")).toBeNull();
    });
});

describe("roleView", () => {
    it("recognizes every role view segment", () => {
        expect(roleView("membership")).toBe("membership");
        expect(roleView("grants-diagram")).toBe("grants-diagram");
    });

    it("rejects \"grants\" — the bare /role/{user,group,predefined}/:role route is the grants tab", () => {
        expect(roleView("grants")).toBeNull();
    });
});

describe("routeFlag", () => {
    it("is false for an absent parameter", () => {
        expect(routeFlag(undefined)).toBe(false);
    });

    it("is true for a bare, present-but-empty value", () => {
        expect(routeFlag("")).toBe(true);
    });

    it("is true for \"true\", case-insensitively", () => {
        expect(routeFlag("true")).toBe(true);
        expect(routeFlag("TRUE")).toBe(true);
        expect(routeFlag("True")).toBe(true);
    });

    it("is true for \"1\"", () => {
        expect(routeFlag("1")).toBe(true);
    });

    it("is false for any other value", () => {
        expect(routeFlag("false")).toBe(false);
        expect(routeFlag("0")).toBe(false);
        expect(routeFlag("yes")).toBe(false);
    });
});

describe("ROLE_BUCKET_SECTIONS", () => {
    it("maps each bucket to RolesTree's section label", () => {
        expect(ROLE_BUCKET_SECTIONS).toEqual({ user: "Users", group: "Groups", predefined: "Predefined" });
    });
});

describe("objectPath", () => {
    it("builds a bare relation path with no view", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "invoices", kind: "table" };

        expect(objectPath(ref)).toEqual({ path: "/schema/sales/table/invoices" });
    });

    it("appends a valid view segment", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "invoices", kind: "table" };

        expect(objectPath(ref, "structure")).toEqual({ path: "/schema/sales/table/invoices/structure" });
    });

    it("ignores an invalid view for the kind, returning the bare path", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "invoices", kind: "table" };

        expect(objectPath(ref, "definition")).toEqual({ path: "/schema/sales/table/invoices" });
    });

    it("builds a view's definition path", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "v_orders", kind: "view" };

        expect(objectPath(ref, "definition")).toEqual({ path: "/schema/sales/view/v_orders/definition" });
    });

    it("builds a materialized view's diagram path", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "mv", kind: "materializedView" };

        expect(objectPath(ref, "diagram")).toEqual({ path: "/schema/sales/matview/mv/diagram" });
    });

    it("ignores a view segment for a sequence, which has no view", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "seq1", kind: "sequence" };

        expect(objectPath(ref, "diagram")).toEqual({ path: "/schema/sales/sequence/seq1" });
    });

    it("builds an index path", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "idx1", kind: "index" };

        expect(objectPath(ref)).toEqual({ path: "/schema/sales/index/idx1" });
    });

    it("builds a function path with its signature as a query param", () => {
        const ref: DbObjectRef = {
            connectionId: "default", database: "app", schema: "sales", name: "fn", kind: "function", signature: "p_x integer",
        };

        expect(objectPath(ref)).toEqual({ path: "/schema/sales/function/fn", query: { signature: "p_x integer" } });
    });

    it("omits the query entirely for an empty signature, not ?signature=", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "fn", kind: "function", signature: "" };

        expect(objectPath(ref)).toEqual({ path: "/schema/sales/function/fn" });
    });

    it("builds a bare schema path", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", kind: "schema" };

        expect(objectPath(ref)).toEqual({ path: "/schema/sales" });
    });

    it("appends a valid schema view segment", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", kind: "schema" };

        expect(objectPath(ref, "diagram")).toEqual({ path: "/schema/sales/diagram" });
    });

    it("ignores an invalid schema view segment", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", kind: "schema" };

        expect(objectPath(ref, "bogus")).toEqual({ path: "/schema/sales" });
    });

    it("returns null for a database ref — use databaseDiagramPath", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", kind: "database" };

        expect(objectPath(ref)).toBeNull();
    });

    it("returns null for a type ref — no route", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", schema: "sales", name: "t1", kind: "type" };

        expect(objectPath(ref)).toBeNull();
    });

    it("returns null for a relation ref missing schema", () => {
        const ref: DbObjectRef = { connectionId: "default", database: "app", name: "x", kind: "table" };

        expect(objectPath(ref)).toBeNull();
    });
});

describe("rolePath", () => {
    it("builds the bare grants path, always under the user bucket", () => {
        expect(rolePath("analyst")).toEqual({ path: "/role/user/analyst" });
    });

    it("appends the membership view", () => {
        expect(rolePath("analyst", "membership")).toEqual({ path: "/role/user/analyst/membership" });
    });

    it("appends the grants-diagram view", () => {
        expect(rolePath("analyst", "grants-diagram")).toEqual({ path: "/role/user/analyst/grants-diagram" });
    });
});

describe("databaseDiagramPath / notesPath / queryHistoryPath", () => {
    it("databaseDiagramPath is the fixed whole-database diagram URL", () => {
        expect(databaseDiagramPath()).toEqual({ path: "/database/diagram" });
    });

    it("notesPath is the fixed notes/documentation URL", () => {
        expect(notesPath()).toEqual({ path: "/notes" });
    });

    it("queryHistoryPath embeds the run's timestamp", () => {
        expect(queryHistoryPath(1699999999999)).toEqual({ path: "/query/history/1699999999999" });
    });
});

describe("resolveAddressBarRoute", () => {
    it("falls back to / when no panel is focused", () => {
        expect(resolveAddressBarRoute(null, new Map(), new Map(), [])).toEqual({ path: "/" });
    });

    it("returns the panel's own recorded route when one was captured at open time", () => {
        const panelRoutes = new Map<string, PanelRoute>([["p1", { path: "/schema/sales/table/x" }]]);

        expect(resolveAddressBarRoute("p1", panelRoutes, new Map(), [])).toEqual({ path: "/schema/sales/table/x" });
    });

    it("falls back to a query panel's latest recorded run when it still exists in history", () => {
        const queryPanelRuns = new Map([["q1", 100]]);
        const history = [entry(100)];

        expect(resolveAddressBarRoute("q1", new Map(), queryPanelRuns, history)).toEqual({ path: "/query/history/100" });
    });

    it("falls back to / when the recorded run's timestamp has since been evicted", () => {
        const queryPanelRuns = new Map([["q1", 999]]);
        const history = [entry(100)];

        expect(resolveAddressBarRoute("q1", new Map(), queryPanelRuns, history)).toEqual({ path: "/" });
    });

    it("falls back to / for a query panel that has never run", () => {
        expect(resolveAddressBarRoute("q2", new Map(), new Map(), [])).toEqual({ path: "/" });
    });

    it("falls back to / for an id with no recorded route or run", () => {
        expect(resolveAddressBarRoute("unknown", new Map(), new Map(), [])).toEqual({ path: "/" });
    });
});
