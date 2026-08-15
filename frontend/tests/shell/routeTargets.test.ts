import { describe, it, expect } from "vitest";
import { RELATION_KINDS, ROLE_BUCKETS, relationView, schemaView, roleView, routeFlag } from "../../src/shell/routeTargets";

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
